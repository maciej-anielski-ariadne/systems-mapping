// =============================================================================
// BUILDER PANEL — "cell grew downward" editor
// -----------------------------------------------------------------------------
// When a text or number cell holds more content than fits in its visible
// width, we drop a wider textarea flush below the cell (no gap, same width,
// shared border) so the user can read and edit the full value. The original
// <input> remains the source of truth — the textarea mirrors its value and
// dispatches a normal "input" event on change, so handleBuilderInput in
// 16d-builder-events.js picks the new value up unchanged.
//
// Triggers:
//   • focusin   — open if the focused cell's value already overflows
//                 (input.scrollWidth > input.clientWidth)
//   • input     — open mid-typing the moment the value starts to overflow
//
// Dismissal:
//   • Esc, click outside, Tab/Shift-Tab from inside the textarea
//   • Sets `_dismissedTrigger` to the input so we don't immediately re-open
//     while focus is still on the same cell. Cleared when focus leaves the
//     cell, or when renderBuilder() replaces the DOM.
//
// Geometry:
//   • position: fixed, anchored to the <td>'s bounding rect.
//   • top = rect.bottom − 1 (1-pixel overlap to merge the top border with
//          the cell's bottom border).
//   • left = rect.left, width = td.offsetWidth → the editor visually IS the
//     same column, just taller.
// =============================================================================

const CELL_EDITOR_TYPES_SELECTOR = '.builder-table input[type="text"], .builder-table input[type="number"]';
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

// Look up the column heading for a cell so the editor's title can say
// "Description · Row 4" instead of just "Edit cell".
function columnHeaderForCell(cell) {
  const td = cell.closest("td");
  if (!td) return "";
  const tr = td.parentElement;
  const colIndex = Array.prototype.indexOf.call(tr.children, td);
  const table = cell.closest("table");
  const ths = table ? table.querySelectorAll("thead th") : [];
  return (ths[colIndex] && ths[colIndex].textContent.trim()) || "";
}

function openCellEditor(trigger) {
  // If we're already editing the same cell, nothing to do.
  if (cellEditorState && cellEditorState.trigger === trigger) return;
  hideCellEditor();

  const columnLabel = columnHeaderForCell(trigger) || "Edit";
  const rowIndex = parseInt(trigger.getAttribute("data-index"), 10);
  const rowDescriptor = isNaN(rowIndex) ? "" : ("Row " + (rowIndex + 1));

  const editor = document.createElement("div");
  editor.className = "builder-cell-editor";
  editor.innerHTML =
    '<div class="builder-cell-editor-title">' +
      escapeHtml(columnLabel) +
      (rowDescriptor ? ' · ' + escapeHtml(rowDescriptor) : '') +
    '</div>' +
    '<textarea class="builder-cell-editor-textarea" spellcheck="true"></textarea>';
  document.body.appendChild(editor);

  const textarea = editor.querySelector("textarea");
  textarea.value = trigger.value;

  // Mark the trigger so CSS can drop its bottom border and bottom corner
  // radii — visually fusing it with the editor below.
  trigger.classList.add("editor-open");

  positionCellEditor(editor, trigger);

  const onScroll = () => positionCellEditor(editor, trigger);
  window.addEventListener("scroll", onScroll, true);

  // Sync textarea → trigger input → state.builder (the overlay's delegated
  // input listener in 16d handles the field-update side).
  const sync = () => {
    trigger.value = textarea.value;
    trigger.dispatchEvent(new Event("input",  { bubbles: true }));
    trigger.dispatchEvent(new Event("change", { bubbles: true }));
  };
  textarea.addEventListener("input", sync);

  // Keyboard: Esc + Cmd/Ctrl+Enter close. Tab / Shift-Tab close AND
  // navigate to the next/previous editable cell. Plain Enter keeps native
  // newline behaviour inside the textarea.
  textarea.addEventListener("keydown", event => {
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
    if (event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      const triggerEl = trigger;
      const direction = event.shiftKey ? "prev" : "next";
      hideCellEditor({ userDismissed: true, refocusTrigger: false });
      const moved = (typeof navigateEditableCell === "function") &&
                    navigateEditableCell(triggerEl, direction);
      if (!moved && direction === "next") {
        // Off the end of the table — append a new row, focus its first input.
        const section = triggerEl.getAttribute("data-section");
        if (section && typeof addBuilderRow === "function") {
          const newIdx = addBuilderRow(section);
          if (newIdx >= 0) {
            state.builder.focusAfterRender = { section, index: newIdx, field: null };
            renderBuilder();
          }
        }
      }
    }
  });

  // Click outside the editor or its trigger closes it.
  const onMouseDownOutside = event => {
    if (editor.contains(event.target)) return;
    if (event.target === trigger)       return;
    hideCellEditor({ userDismissed: true, refocusTrigger: false });
  };
  // Defer to next tick so the current click that opened us doesn't count.
  setTimeout(() => document.addEventListener("mousedown", onMouseDownOutside), 0);

  cellEditorState = { editor, trigger, textarea, onScroll, onMouseDownOutside };
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

function positionCellEditor(editor, trigger) {
  const td = trigger.closest("td") || trigger;
  const rect = td.getBoundingClientRect();
  editor.style.width = rect.width + "px";
  editor.style.left  = rect.left + "px";
  // -1px so the editor's top border overlaps the cell's bottom border,
  // creating one shared edge instead of a double line.
  editor.style.top   = (rect.bottom - 1) + "px";
}

function hideCellEditor(options) {
  if (!cellEditorState) return;
  const { editor, trigger, onScroll, onMouseDownOutside } = cellEditorState;
  window.removeEventListener("scroll", onScroll, true);
  document.removeEventListener("mousedown", onMouseDownOutside);
  if (editor && editor.parentNode) editor.parentNode.removeChild(editor);
  if (trigger && trigger.classList) trigger.classList.remove("editor-open");
  cellEditorState = null;

  if (options && options.userDismissed && trigger) {
    _dismissedTrigger = trigger;
  }
  if (options && options.refocusTrigger && trigger && typeof trigger.focus === "function") {
    try { trigger.focus(); } catch (_) {}
  }
}

// Delegated focusin handler — wired by attachBuilderEvents() in
// 16d-builder-events.js. Opens the editor only when the focused cell's
// value already overflows. Skips short fields naturally because their
// content won't exceed their width.
function handleBuilderFocus(event) {
  if (!event.target.matches(CELL_EDITOR_TYPES_SELECTOR)) return;
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
