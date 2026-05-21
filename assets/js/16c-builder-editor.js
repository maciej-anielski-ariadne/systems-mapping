// =============================================================================
// BUILDER PANEL — "cell grew" overlay editor
// -----------------------------------------------------------------------------
// When a text or number cell holds more content than fits in its visible
// width, a textarea is overlaid directly on top of the input at the input's
// exact position and dimensions, then sized to fit the text content. The
// editor grows horizontally as the user types, up to a readable max width,
// at which point further text wraps and the editor grows vertically. The
// effect is that the cell appears to expand in place — there's no separate
// box dropping below it.
//
// The original <input> remains the source of truth: the textarea mirrors
// its value and dispatches a normal "input" event on change, so
// handleBuilderInput in 16d-builder-events.js picks the new value up
// unchanged.
//
// Triggers:
//   • focusin — open if the focused cell's value already overflows
//               (input.scrollWidth > input.clientWidth)
//   • input   — open mid-typing the moment the value starts to overflow
//
// Dismissal:
//   • Esc, click outside, Tab/Shift-Tab from inside the textarea
//   • Sets `_dismissedTrigger` to the input so we don't immediately re-open
//     while focus is still on the same cell. Cleared when focus leaves the
//     cell, or when renderBuilder() replaces the DOM.
//
// Geometry:
//   • position: fixed, anchored to the input's top-left corner (overlay).
//   • Initial size = input's exact bounding rect (pixel-for-pixel cover).
//   • Width grows with text content, capped at CELL_EDITOR_MAX_WIDTH.
//   • Height stays at input.height until either the value wraps at max width
//     or contains hard newlines; then grows to fit, capped at MAX_HEIGHT.
//   • A hidden mirror <div> is used to measure the rendered text size, which
//     drives the textarea's dimensions on every keystroke.
// =============================================================================

// Typable dropdown inputs (.typeable-dropdown-input) are excluded — they have
// their own filter popup, and re-using the cell-overflow editor on top of
// that would stack two competing UIs on the same cell.
const CELL_EDITOR_TYPES_SELECTOR =
  '.builder-table input[type="text"]:not(.typeable-dropdown-input), ' +
  '.builder-table input[type="number"]';
let cellEditorState = null;
let _dismissedTrigger = null;   // remembered until focus leaves this element

function cellOverflows(input) {
  if (!input || typeof input.scrollWidth !== "number") return false;
  // +1 absorbs sub-pixel rounding on hi-DPI screens.
  return input.scrollWidth > input.clientWidth + 1;
}

// Public — let other modules clear the dismissed-trigger ref. renderBuilder()
// calls this because the entire DOM is replaced on a re-render, so any stale
// element reference is meaningless.
function clearDismissedTrigger() { _dismissedTrigger = null; }

const CELL_EDITOR_MAX_WIDTH  = 560;   // ~60 chars at mono 12px — comfortable read width
const CELL_EDITOR_MAX_HEIGHT = 360;   // hard cap; user scrolls inside beyond this
const CELL_EDITOR_SAFETY_MS  = 220;   // > CSS transition duration, for transitionend miss cleanup

// Hidden text-measurement element. Same font/padding/border-box as the
// editor, lives off-screen, never paints. Recreated on demand; cleaned up
// when the editor closes (see hideCellEditor) so it doesn't outlive the
// feature. `overflow-y:auto` + `scrollbar-gutter:stable` reserves the same
// vertical scrollbar gutter the editor does, so the mirror's content area
// matches the editor's even when content exceeds CELL_EDITOR_MAX_HEIGHT
// and the editor's scrollbar appears.
let _cellEditorMirror = null;
function getCellEditorMirror() {
  if (_cellEditorMirror && _cellEditorMirror.isConnected) return _cellEditorMirror;
  const m = document.createElement("div");
  m.setAttribute("aria-hidden", "true");
  m.style.cssText = [
    "position:fixed",
    "left:-9999px",
    "top:-9999px",
    "visibility:hidden",
    "pointer-events:none",
    "font-family:var(--font-mono)",
    "font-size:12px",
    "line-height:1.5",
    "padding:6px 8px",
    "border:1px solid transparent",
    "box-sizing:border-box",
    "overflow-y:auto",
    "scrollbar-gutter:stable",
    "overflow-wrap:anywhere",
  ].join(";");
  document.body.appendChild(m);
  _cellEditorMirror = m;
  return m;
}

function removeCellEditorMirror() {
  if (_cellEditorMirror && _cellEditorMirror.parentNode) {
    _cellEditorMirror.parentNode.removeChild(_cellEditorMirror);
  }
  _cellEditorMirror = null;
}

// Build an accessibility label from the trigger's column header + row index
// so screen readers announce "Edit Description, row 4" rather than just
// "edit text".
function ariaLabelForTrigger(trigger) {
  const td = trigger.closest && trigger.closest("td");
  if (!td) return "Edit cell";
  const tr = td.parentElement;
  const colIndex = tr ? Array.prototype.indexOf.call(tr.children, td) : -1;
  const table = trigger.closest && trigger.closest("table");
  const ths = table ? table.querySelectorAll("thead th") : [];
  const colName = (colIndex >= 0 && ths[colIndex] && ths[colIndex].textContent.trim()) || "cell";
  const rowIdx = parseInt(trigger.getAttribute("data-index"), 10);
  const rowName = isNaN(rowIdx) ? "" : ", row " + (rowIdx + 1);
  return "Edit " + colName + rowName;
}

// Anchor only — used on scroll. Doesn't touch size, so it doesn't fight
// the size transition.
function setCellEditorAnchor(editor, trigger) {
  const r = trigger.getBoundingClientRect();
  editor.style.left = r.left + "px";
  editor.style.top  = r.top  + "px";
}

// Size the editor to fit its current text content. Grows horizontally first
// (single-line behaviour: white-space pre, no soft wrap); once the natural
// width would exceed the readable cap, switches to wrapping at the cap and
// grows vertically. Hard newlines (Enter) always force vertical growth.
//
// The width cap is the smaller of CELL_EDITOR_MAX_WIDTH and the available
// viewport width to the right of the input — that way the editor never
// extends past the viewport edge even when the cell sits far to the right.
function fitEditorToText(editor, trigger, startWidth, startHeight) {
  const triggerRect = trigger.getBoundingClientRect();
  const maxByViewport = Math.max(50, window.innerWidth - 40 - triggerRect.left);
  const widthCap = Math.min(CELL_EDITOR_MAX_WIDTH, maxByViewport);

  const mirror = getCellEditorMirror();
  // Trailing zero-width space guarantees trailing whitespace and final
  // newlines contribute to the measured size — otherwise the mirror trims
  // them and the editor lags behind the user's typing by one character.
  mirror.textContent = (editor.value || "") + "​";

  // First pass: measure the unwrapped width of the longest line. Use
  // getBoundingClientRect + Math.ceil to avoid sub-pixel under-measurement
  // (offsetWidth rounds down, which clips the last fractional glyph).
  mirror.style.whiteSpace = "pre";
  mirror.style.width = "auto";
  const mr1 = mirror.getBoundingClientRect();
  const unwrappedW = Math.ceil(mr1.width);
  const unwrappedH = Math.ceil(mr1.height);

  if (unwrappedW <= widthCap) {
    // Single-line (or hard-newline-only) growth: no wrap, fit-to-content.
    editor.style.whiteSpace = "pre";
    editor.style.width  = Math.max(startWidth, unwrappedW) + "px";
    editor.style.height = Math.min(CELL_EDITOR_MAX_HEIGHT, Math.max(startHeight, unwrappedH)) + "px";
  } else {
    // Past the readable single-line max: wrap at the cap, grow vertically.
    mirror.style.whiteSpace = "pre-wrap";
    mirror.style.width = widthCap + "px";
    const wrappedH = Math.ceil(mirror.getBoundingClientRect().height);
    editor.style.whiteSpace = "pre-wrap";
    editor.style.width  = widthCap + "px";
    editor.style.height = Math.min(CELL_EDITOR_MAX_HEIGHT, Math.max(startHeight, wrappedH)) + "px";
  }
}

function openCellEditor(trigger) {
  // If we're already editing the same cell, nothing to do.
  if (cellEditorState && cellEditorState.trigger === trigger) return;
  hideCellEditor({ skipAnimation: true });

  // Backdrop dims everything except the editor. Appended first so it's
  // under the editor in DOM/paint order. Fades in on the next frame.
  // aria-hidden so screen readers don't announce the dim as content.
  const backdrop = document.createElement("div");
  backdrop.className = "builder-cell-editor-backdrop";
  backdrop.setAttribute("aria-hidden", "true");
  document.body.appendChild(backdrop);

  // Measure the input once at open. The editor's "minimum" size — what it
  // shrinks back to on close, and what the start frame of the open animation
  // looks like — is the input's bounding rect at this moment.
  const start = trigger.getBoundingClientRect();
  const startWidth  = start.width;
  const startHeight = start.height;

  const editor = document.createElement("textarea");
  editor.className = "builder-cell-editor transitioning";  // enable the open transition
  editor.spellcheck = true;
  editor.value = trigger.value;
  editor.setAttribute("aria-label", ariaLabelForTrigger(trigger));
  // Position and size the editor to overlay the input pixel-for-pixel
  // BEFORE appending — that way the first paint shows it perfectly covering
  // the cell, with no flicker.
  editor.style.left   = start.left + "px";
  editor.style.top    = start.top  + "px";
  editor.style.width  = startWidth  + "px";
  editor.style.height = startHeight + "px";
  document.body.appendChild(editor);

  // Commit the start size so the upcoming fit-to-text triggers a transition.
  editor.offsetHeight;  // eslint-disable-line no-unused-expressions
  backdrop.offsetHeight;  // eslint-disable-line no-unused-expressions

  // B8: Show the backdrop synchronously now that the initial-state reflow
  // committed. The CSS `transition: opacity 120ms` still runs because we're
  // changing opacity (0 → 1) after the initial style was already settled.
  backdrop.classList.add("visible");

  // Apply the fit-to-text size on the SECOND animation frame, not the first.
  // Why: rAF callbacks queued from inside an event handler fire in the SAME
  // frame as the JS that queued them, before the browser paints. If we
  // resize the editor in that same rAF, the browser collapses "append at
  // start-size" and "resize to fit-size" into one paint cycle — only the
  // final state is rendered, and the CSS transition has no "from" state
  // to interpolate from. The result is the editor pops in at full size
  // with no expansion animation (the user sees this as "just highlights").
  //
  // The nested rAF defers the resize one frame: frame N paints the editor
  // at start-size (matching the cell), frame N+1 changes the size, and the
  // transition interpolates between the two painted states.
  requestAnimationFrame(() => {
    if (!cellEditorState || cellEditorState.editor !== editor) return;
    requestAnimationFrame(() => {
      if (!cellEditorState || cellEditorState.editor !== editor) return;
      fitEditorToText(editor, trigger, cellEditorState.startWidth, cellEditorState.startHeight);
      // B7: place the caret at end AFTER the editor has grown to its target
      // size — otherwise the caret sits at value.length while the editor is
      // still at cell-size, off-screen, causing a flash of horizontal scroll.
      try { editor.setSelectionRange(editor.value.length, editor.value.length); } catch (_) {}
    });
  });

  // Drop the transitioning class once the open animation finishes — keeps
  // per-keystroke resize during typing INSTANT (no transitions = no jitter).
  const finishOpen = () => {
    editor.classList.remove("transitioning");
    if (cellEditorState && cellEditorState.openSafetyTimeout) {
      clearTimeout(cellEditorState.openSafetyTimeout);
      cellEditorState.openSafetyTimeout = null;
    }
  };
  const onOpenTransitionEnd = event => {
    if (event.target !== editor) return;
    if (event.propertyName !== "width" && event.propertyName !== "height") return;
    editor.removeEventListener("transitionend", onOpenTransitionEnd);
    finishOpen();
  };
  editor.addEventListener("transitionend", onOpenTransitionEnd);

  // Take focus synchronously so keystrokes go to the textarea, not the
  // input we're covering. preventScroll guards against the browser scrolling
  // the viewport on focus — the editor is already in view since the input
  // was. setSelectionRange is deferred to the rAF above (see B7).
  try { editor.focus({ preventScroll: true }); } catch (_) {
    try { editor.focus(); } catch (_) {}
  }

  const onScroll = () => setCellEditorAnchor(editor, trigger);
  // B2 + B6: window resize updates BOTH position (re-anchor to cell) AND
  // size (re-fit to text). startWidth/startHeight are refreshed from the
  // cell's current rect so the editor's "minimum" tracks responsive layout.
  const onResize = () => {
    setCellEditorAnchor(editor, trigger);
    const r = trigger.getBoundingClientRect();
    if (cellEditorState && cellEditorState.editor === editor) {
      cellEditorState.startWidth  = r.width;
      cellEditorState.startHeight = r.height;
    }
    fitEditorToText(editor, trigger, r.width, r.height);
  };
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onResize);

  // Sync textarea → trigger → state.builder, and re-fit to the new text.
  // Force-clear the transitioning class so the resize is instant even if
  // the open animation hasn't finished yet — typing should never feel like
  // it's "fighting" an in-flight animation. Reads start dims from state so
  // they stay in sync with any resize-driven updates.
  const sync = () => {
    trigger.value = editor.value;
    trigger.dispatchEvent(new Event("input",  { bubbles: true }));
    trigger.dispatchEvent(new Event("change", { bubbles: true }));
    if (editor.classList.contains("transitioning")) finishOpen();
    const sw = (cellEditorState && cellEditorState.startWidth)  || startWidth;
    const sh = (cellEditorState && cellEditorState.startHeight) || startHeight;
    fitEditorToText(editor, trigger, sw, sh);
  };
  editor.addEventListener("input", sync);

  // Keyboard: Esc + Cmd/Ctrl+Enter close. Tab / Shift-Tab close AND
  // navigate to the next/previous editable cell. Plain Enter normally keeps
  // native newline behaviour inside the textarea — EXCEPT for number-type
  // triggers, where a newline would corrupt the input (assigning "1\n2" to
  // a number input nulls or truncates it). For those, treat Enter as commit.
  editor.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      event.stopPropagation();
      event.preventDefault();
      hideCellEditor({ userDismissed: true, refocusTrigger: true });
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.stopPropagation();
      hideCellEditor({ userDismissed: true, refocusTrigger: true });
      return;
    }
    // B3: plain Enter on a number cell closes (no newline insertion).
    if (event.key === "Enter" && !event.shiftKey && trigger.type === "number") {
      event.preventDefault();
      event.stopPropagation();
      hideCellEditor({ userDismissed: true, refocusTrigger: true });
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      const triggerEl = trigger;
      const direction = event.shiftKey ? "prev" : "next";
      // Snap-close the editor — Tab navigates immediately, so a shrinking
      // editor lingering over the next cell would look wrong. The NEW
      // editor (if the destination cell overflows) opens with its own
      // expansion animation so the user can see the cell has more content.
      hideCellEditor({ userDismissed: true, refocusTrigger: false, skipAnimation: true });
      const result = (typeof builderTabNavigate === "function")
        ? builderTabNavigate(triggerEl, direction)
        : { atEnd: true };
      // S5 fix + parallel for atEnd: Shift+Tab off the FIRST cell (or Tab
      // off the LAST cell when row-append fails) used to dump focus to
      // <body> because the editor was removed and there was no next/prev
      // cell to land on. Refocus the trigger so the user stays inside the
      // wizard; they can press Tab/Shift+Tab again from the trigger and
      // 16d's handler will release control to the browser's native Tab.
      if ((result.atStart || result.atEnd) && triggerEl && typeof triggerEl.focus === "function") {
        try { triggerEl.focus(); } catch (_) {}
      }
    }
  });

  const onMouseDownOutside = event => {
    if (editor.contains(event.target)) return;
    if (event.target === trigger)       return;
    hideCellEditor({ userDismissed: true, refocusTrigger: false });
  };
  // Defer via microtask so the click/focus that opened us doesn't
  // immediately dismiss it. Microtask is much tighter than setTimeout(0):
  // the listener attaches at the end of the current task, before any
  // subsequent click reaches the document.
  queueMicrotask(() => document.addEventListener("mousedown", onMouseDownOutside));

  // Safety net: any path that moves focus away from the editor closes it.
  // Catches programmatic focus changes, Cmd+Tab to another app, and the
  // edge cases mousedownOutside misses. Deferred via setTimeout so the
  // synchronous close paths (Esc, Tab, mousedown-outside) get to run first
  // — by the time this fires, cellEditorState is already null and we no-op.
  const onEditorBlur = () => {
    setTimeout(() => {
      if (!cellEditorState || cellEditorState.editor !== editor) return;
      if (document.activeElement === editor) return;
      hideCellEditor({ skipAnimation: true });
    }, 0);
  };
  editor.addEventListener("blur", onEditorBlur);

  // Safety net: if transitionend never fires (prefers-reduced-motion, browser
  // quirks), still drop the transitioning class after the expected duration.
  const openSafetyTimeout = setTimeout(finishOpen, CELL_EDITOR_SAFETY_MS);

  cellEditorState = {
    editor,
    trigger,
    textarea: editor,
    backdrop,
    onScroll,
    onResize,
    onMouseDownOutside,
    openSafetyTimeout,
    startWidth,
    startHeight,
  };
}

// Close is always instant — no shrink-back animation. Reliability beats
// smoothness for close: a lingering shrinking editor while focus has moved
// elsewhere reads as "the box won't go away". The open animation provides
// the visual feel; close is just teardown.
function hideCellEditor(options) {
  if (!cellEditorState) return;
  const { editor, trigger, backdrop, onScroll, onResize, onMouseDownOutside, openSafetyTimeout } = cellEditorState;
  cellEditorState = null;

  window.removeEventListener("scroll", onScroll, true);
  window.removeEventListener("resize", onResize);
  document.removeEventListener("mousedown", onMouseDownOutside);
  if (openSafetyTimeout) clearTimeout(openSafetyTimeout);

  if (options && options.userDismissed && trigger) {
    _dismissedTrigger = trigger;
  }
  if (options && options.refocusTrigger && trigger && typeof trigger.focus === "function") {
    try { trigger.focus(); } catch (_) {}
  }

  if (backdrop && backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
  if (editor && editor.parentNode) editor.parentNode.removeChild(editor);
  // B11: clean up the off-screen mirror so it doesn't outlive the feature.
  // Recreated cheaply on next open.
  removeCellEditorMirror();
}

// Delegated focusin handler — wired by attachBuilderEvents() in
// 16d-builder-events.js. Opens the editor only when the focused cell's
// value already overflows. Skips short fields naturally because their
// content won't exceed their width.
function handleBuilderFocus(event) {
  if (!event.target.matches(CELL_EDITOR_TYPES_SELECTOR)) return;
  // Strict single-active-editor rule: if an editor is open for a DIFFERENT
  // cell than the one now being focused, close it. The blur handler on the
  // editor would catch this too, but doing it here makes the close happen
  // synchronously with the focus change instead of one tick later.
  if (cellEditorState && cellEditorState.trigger !== event.target) {
    hideCellEditor({ skipAnimation: true });
  }
  // B14: drop a stale dismissed-trigger ref if its element has been removed
  // from the DOM (e.g., row-delete destroyed the input). Without this, the
  // ref would stick around until the next render() clears it explicitly.
  if (_dismissedTrigger && !_dismissedTrigger.isConnected) {
    _dismissedTrigger = null;
  }
  // Different element gained focus — any stale dismissed-trigger ref is now
  // obsolete.
  if (_dismissedTrigger && _dismissedTrigger !== event.target) {
    _dismissedTrigger = null;
  }
  if (_dismissedTrigger === event.target) return;
  if (cellOverflows(event.target)) openCellEditor(event.target);
}

// Delegated focusout — once focus leaves the dismissed trigger, the
// "I dismissed it for this session" flag can be cleared so re-entering the
// cell starts fresh.
function handleBuilderFocusOut(event) {
  if (_dismissedTrigger && event.target === _dismissedTrigger) {
    _dismissedTrigger = null;
  }
}

// Wired into the delegated `input` listener in 16d. Pops the editor open the
// moment a typing-in-progress value starts to overflow its cell. We don't
// fight the user mid-keystroke: if they've explicitly dismissed for this
// cell, we leave them alone until they refocus.
function handleBuilderInputForOverflow(event) {
  const t = event.target;
  if (!t || !t.matches || !t.matches(CELL_EDITOR_TYPES_SELECTOR)) return;
  if (cellEditorState && cellEditorState.trigger === t) return;
  if (_dismissedTrigger === t) return;
  if (cellOverflows(t)) openCellEditor(t);
}
