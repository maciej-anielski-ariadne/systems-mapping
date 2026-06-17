// =============================================================================
// BUILDER PANEL — event wiring (clicks, typing, focus, drag-to-reorder)
// -----------------------------------------------------------------------------
// All input handling for the wizard lives here. Most of it is event
// delegation — we attach ONE listener per event type to the persistent
// #builder-overlay element and route to the right handler based on the
// `data-*` attribute of the target.
//
//   handleBuilderClick    — buttons inside the overlay (step dots, +Add,
//                           duplicate, delete row).
//   handleBuilderCellChange — every input/change in an editable cell or
//                             a default-elasticity field.
//   handleBuilderFocus    — defined in 16c-builder-editor.js, opens the
//                           floating cell editor on focus.
//   handleBuilderDrag*    — drag-to-reorder for streams / stages /
//                           categories rows.
//   handleBuilderInput    — the "data-section / data-field" field update,
//                           with id and short auto-fill.
//
// Plus per-render rebinding for the once-only buttons in the header /
// footer (close, back, next, apply, download, start-from-sample).
// =============================================================================

// ───── Footer button rebind ──────────────────────────────────────────────
// Two flavours of event wiring: full-render binding (attachBuilderEvents)
// re-binds everything after a full innerHTML replace; footer-only binding
// (wireBuilderFooterButtons) is also reused after the inline footer refresh
// triggered by every keystroke. Keeping them in one place avoids drift.
function wireBuilderFooterButtons() {
  const back = document.getElementById("builder-back-button");
  if (back) back.addEventListener("click", () => {
    if (state.builder.step > 1) { state.builder.step -= 1; renderBuilder(); }
  });
  const next = document.getElementById("builder-next-button");
  if (next) next.addEventListener("click", () => {
    if (state.builder.step < 6) { state.builder.step += 1; renderBuilder(); }
  });
  const apply = document.getElementById("builder-apply-button");
  if (apply) apply.addEventListener("click", applyBuilderToMap);
  const download = document.getElementById("builder-download-button");
  if (download) download.addEventListener("click", downloadBuilderCsv);
}

// ───── Delegated click handler ───────────────────────────────────────────
// Looks at the closest data-* attribute on the click target and dispatches.
function handleBuilderClick(event) {
  const overlay = document.getElementById("builder-overlay");
  const target = event.target.closest(
    "[data-step], [data-add], [data-duplicate], [data-delete], " +
    "[data-bulkdelete], [data-bulkclear], [data-bulkapply]"
  );
  if (!target || !overlay || !overlay.contains(target)) return;

  if (target.hasAttribute("data-step")) {
    const step = parseInt(target.getAttribute("data-step"), 10);
    if (!isNaN(step)) {
      clearBuilderSelection();   // indices don't carry across steps
      state.builder.step = step;
      renderBuilder();
    }
    return;
  }
  if (target.hasAttribute("data-add")) {
    const section = target.getAttribute("data-add");
    clearBuilderSelection();
    const newIdx = addBuilderRow(section);
    if (newIdx >= 0) {
      state.builder.focusAfterRender = { section, index: newIdx, field: null };
    }
    renderBuilder();
    return;
  }

  // ───── Bulk actions (wizard multi-select) ─────
  if (target.hasAttribute("data-bulkdelete")) {
    if (typeof deleteBuilderSelectedRows === "function") {
      deleteBuilderSelectedRows(target.getAttribute("data-bulkdelete"));
    }
    renderBuilder();
    return;
  }
  if (target.hasAttribute("data-bulkclear")) {
    clearBuilderSelection();
    renderBuilder();
    return;
  }
  if (target.hasAttribute("data-bulkapply")) {
    const field   = target.getAttribute("data-bulkapply");
    const section = target.getAttribute("data-bulksection") || "edges";
    const input   = overlay.querySelector('[data-bulkinput="' + field + '"]');
    const value   = input ? input.value : "";
    if (typeof applyBuilderBulkField === "function") {
      const changed = applyBuilderBulkField(section, field, value);
      saveBuilderToStorage();
      if (changed) renderBuilder(); else refreshBuilderBulkBar();
    }
    return;
  }

  const index = parseInt(target.getAttribute("data-index"), 10);
  if (isNaN(index)) return;
  if (target.hasAttribute("data-duplicate")) {
    const section = target.getAttribute("data-duplicate");
    clearBuilderSelection();   // duplicate shifts indices after `index`
    const newIdx = duplicateBuilderRow(section, index);
    if (newIdx >= 0) {
      state.builder.focusAfterRender = { section, index: newIdx, field: null };
    }
    renderBuilder();
  } else if (target.hasAttribute("data-delete")) {
    state.builder[target.getAttribute("data-delete")].splice(index, 1);
    clearBuilderSelection();   // a removed row shifts later indices
    renderBuilder();
  }
}

// Routes input + change events to the appropriate field updater based on
// which data-* attribute the target carries.
function handleBuilderCellChange(event) {
  const t = event.target;
  if      (t.matches("[data-rowselect]")) { handleBuilderRowSelect(event); return; }
  else if (t.matches("[data-selectall]")) { handleBuilderSelectAll(event); return; }
  else if (t.matches("[data-bulkfield]")) { handleBuilderBulkField(event); return; }
  if      (t.matches("[data-section][data-field]")) handleBuilderInput(event);
  else if (t.matches("[data-default]"))             handleBuilderDefault(event);
}

// ───── Bulk multi-select handlers ────────────────────────────────────────
// Tick / untick one row. Updates the selection set + the row highlight, then
// refreshes just the bulk bar (no full re-render — keeps any open editor and
// the scroll position untouched). Index stays valid: selection is cleared on
// any mutation that shifts rows (see handleBuilderClick / handleBuilderDrop).
function handleBuilderRowSelect(event) {
  const i = parseInt(event.target.getAttribute("data-index"), 10);
  if (isNaN(i)) return;
  if (event.target.checked) state.builder.selected.add(i);
  else                      state.builder.selected.delete(i);
  const tr = event.target.closest("tr");
  if (tr) tr.classList.toggle("selected", event.target.checked);
  if (typeof refreshBuilderBulkBar === "function") refreshBuilderBulkBar();
}

// "Select all" header checkbox — select every row in the current section or
// clear. Full re-render so each row checkbox + highlight repaints (scroll is
// preserved by renderBuilder's same-step restore).
function handleBuilderSelectAll(event) {
  const section = event.target.getAttribute("data-selectall");
  const arr = state.builder[section];
  if (!arr) return;
  if (event.target.checked) state.builder.selected = new Set(arr.map((_, i) => i));
  else clearBuilderSelection();
  renderBuilder();
}

// A bulk-field dropdown changed — apply the picked value to every selected
// row. Re-render so the row cells reflect the change (selection indices are
// unchanged, so the same rows stay selected). Empty placeholder → no-op, but
// still refresh the bar so the dropdown resets to its placeholder.
function handleBuilderBulkField(event) {
  const section = event.target.getAttribute("data-bulksection");
  const field   = event.target.getAttribute("data-bulkfield");
  const value   = event.target.value;
  if (!section || !field) return;
  if (value === "") { if (typeof refreshBuilderBulkBar === "function") refreshBuilderBulkBar(); return; }
  if (typeof applyBuilderBulkField !== "function") return;
  const changed = applyBuilderBulkField(section, field, value);
  saveBuilderToStorage();
  if (changed) renderBuilder();
  else if (typeof refreshBuilderBulkBar === "function") refreshBuilderBulkBar();
}

// After a render, reflect the selection on the "select all" box: checked when
// every row is selected, indeterminate when only some are. (indeterminate
// can't be set via an HTML attribute, hence this post-render sync.)
function syncBuilderSelectAllState() {
  const overlay = document.getElementById("builder-overlay");
  if (!overlay) return;
  const box = overlay.querySelector("[data-selectall]");
  if (!box) return;
  const section = box.getAttribute("data-selectall");
  const total = (state.builder[section] || []).length;
  const sel = state.builder.selected.size;
  box.checked = total > 0 && sel === total;
  box.indeterminate = sel > 0 && sel < total;
}

// Spreadsheet-style keyboard navigation across editable table cells.
//   • Tab / Shift-Tab → next / previous editable cell (skips drag handles
//     and row action buttons). Tab past the last cell appends a new row.
//   • Enter (text/number only) → same column, row below. Enter on the last
//     row of a section appends a new row.
//   • Selects, checkboxes, color inputs keep native Enter / Space behaviour.
//
// Native <select> elements are upgraded to typable filterable inputs by
// 04b-typeable-dropdown.js — the visible focus target is the
// `.typeable-dropdown-input`, while the original <select> (which still
// carries the data-* attrs) is hidden via `.typeable-dropdown-native`.
// The selector excludes the hidden select and includes the typable input,
// so Tab/Enter land on the visible cell.
const BUILDER_EDITABLE_SELECTOR =
  "[data-section][data-field]:not(:disabled):not(.typeable-dropdown-native), " +
  ".typeable-dropdown-input";

function builderEditableCells(fromEl) {
  const scope = (fromEl && fromEl.closest("table.builder-table")) ||
                document.getElementById("builder-overlay");
  if (!scope) return [];
  return Array.from(scope.querySelectorAll(BUILDER_EDITABLE_SELECTOR));
}

// Move focus to the next / previous editable cell in DOM order. Returns the
// element focused, or null if we ran off the end. Caller is responsible for
// appending a new row if it wants to handle the off-end case.
//
// Caret is placed at the end of the value (not select-all). select() would
// have two unwanted effects: (a) visually highlights all text, which the
// user doesn't want when navigating; (b) in some browsers, calling .select()
// re-focuses the input, which steals focus from the cell editor that
// handleBuilderFocus just opened — the editor's blur handler then closes
// it before the expand animation runs. setSelectionRange has no such
// side effects.
function navigateEditableCell(fromEl, direction) {
  const cells = builderEditableCells(fromEl);
  const idx = cells.indexOf(fromEl);
  if (idx === -1) return null;
  const targetIdx = direction === "prev" ? idx - 1 : idx + 1;
  if (targetIdx < 0 || targetIdx >= cells.length) return null;
  const next = cells[targetIdx];
  next.focus();
  if (next.type === "text" && typeof next.setSelectionRange === "function") {
    // Typable dropdown inputs already select-all on focus (handled inside
    // 04b-typeable-dropdown.js) — leaving the selection alone here lets
    // the user start typing to filter the option list immediately. For
    // plain text/number cells, place the caret at the end of the value
    // (see the wider explanation in the surrounding comment block).
    if (!(next.classList && next.classList.contains("typeable-dropdown-input"))) {
      try { next.setSelectionRange(next.value.length, next.value.length); } catch (_) {}
    }
  }
  return next;
}

// Shared Tab-navigation policy used by both the no-editor Tab path (this
// file's handleBuilderKeydown) and the editor's keydown handler in 16c.
// Returns an object describing what happened so the caller can decide
// whether to preventDefault, refocus the trigger, etc.
//
//   { moved: HTMLElement } — focus is now on the next/prev cell.
//   { addedRow: true }     — appended a row + re-rendered; focus will
//                            land via applyFocusAfterRender's rAF.
//   { atStart: true }      — Shift+Tab from the very first cell; no prev.
//   { atEnd: true }        — Tab from the last cell, can't add a row.
function builderTabNavigate(fromCell, direction) {
  const moved = navigateEditableCell(fromCell, direction);
  if (moved) return { moved };
  if (direction === "next") {
    const section = fromCell.getAttribute("data-section");
    if (section && typeof addBuilderRow === "function") {
      const newIdx = addBuilderRow(section);
      if (newIdx >= 0) {
        state.builder.focusAfterRender = { section, index: newIdx, field: null };
        renderBuilder();
        return { addedRow: true };
      }
    }
    return { atEnd: true };
  }
  return { atStart: true };
}

function handleBuilderKeydown(event) {
  const t = event.target;
  if (!t || !t.matches) return;
  // The floating editor's textarea handles its own keys (Esc, Tab,
  // Cmd-Enter); don't double-handle here.
  if (t.tagName === "TEXTAREA") return;
  if (!t.matches(BUILDER_EDITABLE_SELECTOR)) return;

  if (event.key === "Tab") {
    const direction = event.shiftKey ? "prev" : "next";
    const result = builderTabNavigate(t, direction);
    // preventDefault only when we actually handled the navigation. On
    // atStart / atEnd we leave the browser's native Tab to take focus to
    // whatever's before/after the table (e.g. the close button or step dots).
    if (result.moved || result.addedRow) event.preventDefault();
    return;
  }

  if (event.key === "Enter") {
    // Spreadsheet metaphor: move down in the same column. Limit to plain
    // text/number inputs — selects, color pickers, and checkboxes have
    // native Enter behaviour we want to preserve.
    if (t.tagName !== "INPUT") return;
    if (t.type !== "text" && t.type !== "number") return;

    const section = t.getAttribute("data-section");
    const field   = t.getAttribute("data-field");
    const index   = parseInt(t.getAttribute("data-index"), 10);
    if (!section || !field || isNaN(index)) return;

    event.preventDefault();
    const overlay = document.getElementById("builder-overlay");
    const sameColNext = overlay && overlay.querySelector(
      '[data-section="' + section + '"]' +
      '[data-field="'   + field   + '"]' +
      '[data-index="'   + (index + 1) + '"]'
    );
    if (sameColNext) {
      sameColNext.focus();
      // Caret at end (not select-all) — see navigateEditableCell comment.
      if (sameColNext.type === "text" && typeof sameColNext.setSelectionRange === "function") {
        try { sameColNext.setSelectionRange(sameColNext.value.length, sameColNext.value.length); } catch (_) {}
      }
      return;
    }
    // At the last row → append and land in the same column of the new row.
    if (typeof addBuilderRow === "function") {
      const newIdx = addBuilderRow(section);
      if (newIdx >= 0) {
        state.builder.focusAfterRender = { section, index: newIdx, field };
        renderBuilder();
      }
    }
  }
}

// ───── Drag-to-reorder for streams / stages / categories rows ───────────
// HTML5 drag-and-drop: the source row stashes its section+index on
// dragstart; the target row computes "drop above / below" from the cursor's
// vertical position. On drop, splice the array, re-render.
let _builderDragSource = null;

function handleBuilderDragStart(event) {
  const row = event.target.closest("tr[draggable='true']");
  if (!row) return;
  // Close any open cell editor so it doesn't anchor to a row that's about
  // to move.
  if (typeof hideCellEditor === "function") hideCellEditor();
  _builderDragSource = {
    section: row.getAttribute("data-section"),
    index:   parseInt(row.getAttribute("data-index"), 10),
  };
  row.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
  // Firefox requires some data on the transfer or dragstart fires but no
  // subsequent dragover events arrive.
  try { event.dataTransfer.setData("text/plain", row.getAttribute("data-index")); } catch (_) {}
}

function handleBuilderDragOver(event) {
  if (!_builderDragSource) return;
  const row = event.target.closest("tr[draggable='true']");
  if (!row) return;
  if (row.getAttribute("data-section") !== _builderDragSource.section) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  const rect = row.getBoundingClientRect();
  const above = event.clientY < rect.top + rect.height / 2;
  document.querySelectorAll(".builder-table tr.drop-target-above, .builder-table tr.drop-target-below").forEach(el => {
    el.classList.remove("drop-target-above", "drop-target-below");
  });
  row.classList.add(above ? "drop-target-above" : "drop-target-below");
}

function handleBuilderDrop(event) {
  if (!_builderDragSource) return;
  const row = event.target.closest("tr[draggable='true']");
  if (!row) { handleBuilderDragEnd(); return; }
  if (row.getAttribute("data-section") !== _builderDragSource.section) {
    handleBuilderDragEnd();
    return;
  }
  event.preventDefault();
  const targetIndex = parseInt(row.getAttribute("data-index"), 10);
  const rect = row.getBoundingClientRect();
  const above = event.clientY < rect.top + rect.height / 2;
  const arr = state.builder[_builderDragSource.section];
  const fromIndex = _builderDragSource.index;
  let toIndex = above ? targetIndex : targetIndex + 1;
  if (fromIndex < toIndex) toIndex -= 1;   // splice() shifts elements after the removed one
  if (fromIndex !== toIndex) {
    const [moved] = arr.splice(fromIndex, 1);
    arr.splice(toIndex, 0, moved);
  }
  handleBuilderDragEnd();
  clearBuilderSelection();   // reorder shifts indices
  renderBuilder();
  saveBuilderToStorage();
}

function handleBuilderDragEnd() {
  _builderDragSource = null;
  document.querySelectorAll(".builder-table tr.dragging, .builder-table tr.drop-target-above, .builder-table tr.drop-target-below").forEach(el => {
    el.classList.remove("dragging", "drop-target-above", "drop-target-below");
  });
}

// ───── Top-level event attachment ────────────────────────────────────────
function attachBuilderEvents() {
  const overlay = document.getElementById("builder-overlay");
  if (!overlay) return;

  // Buttons that exist exactly once in the rendered overlay — wire by id.
  // These get fresh DOM each render, so they need to be re-bound every time.
  const close = document.getElementById("builder-close-button");
  if (close) close.addEventListener("click", closeBuilder);
  const startFromSample = document.getElementById("builder-start-from-sample");
  if (startFromSample) startFromSample.addEventListener("click", () => {
    seedBuilderFromSample();
    renderBuilder();
  });
  wireBuilderFooterButtons();
  syncBuilderSelectAllState();

  // Delegated listeners live on the overlay element itself (which persists
  // across renders), so we attach them exactly once. The data-attribute
  // flag below makes this idempotent.
  if (overlay.dataset.builderDelegated !== "true") {
    overlay.addEventListener("click",     handleBuilderClick);
    overlay.addEventListener("input",     handleBuilderCellChange);
    overlay.addEventListener("change",    handleBuilderCellChange);
    overlay.addEventListener("focusin",   handleBuilderFocus);
    overlay.addEventListener("focusout",  handleBuilderFocusOut);
    overlay.addEventListener("keydown",   handleBuilderKeydown);
    overlay.addEventListener("dragstart", handleBuilderDragStart);
    overlay.addEventListener("dragover",  handleBuilderDragOver);
    overlay.addEventListener("drop",      handleBuilderDrop);
    overlay.addEventListener("dragend",   handleBuilderDragEnd);
    overlay.dataset.builderDelegated = "true";
  }
}

// ───── Footer-refresh debounce ───────────────────────────────────────────
// Per-keystroke refreshBuilderFooter() replaces the entire footer DOM and
// re-runs validateBuilder() (which scans all builder arrays). On a complex
// step this is the most expensive thing in the typing loop, so coalesce
// rapid keystrokes into a single trailing-edge refresh.
let _footerRefreshTimer = null;
function scheduleBuilderFooterRefresh() {
  if (_footerRefreshTimer) clearTimeout(_footerRefreshTimer);
  _footerRefreshTimer = setTimeout(() => {
    _footerRefreshTimer = null;
    refreshBuilderFooter();
  }, 150);
}

// ───── Field updaters ────────────────────────────────────────────────────
function handleBuilderDefault(event) {
  const key = event.target.getAttribute("data-default");
  const raw = event.target.value;
  if (raw === "") return;
  const val = parseFloat(raw);
  if (!isNaN(val)) {
    state.builder.defaults[key] = val;
    saveBuilderToStorage();
  }
}

function handleBuilderInput(event) {
  const el      = event.target;
  const section = el.getAttribute("data-section");
  const field   = el.getAttribute("data-field");
  const index   = parseInt(el.getAttribute("data-index"), 10);
  if (!section || !field || isNaN(index)) return;
  const row = state.builder[section][index];
  if (!row) return;

  let newValue;
  if (el.type === "checkbox") {
    newValue = el.checked;
  } else if (el.type === "number") {
    newValue = el.value === "" ? "" : parseFloat(el.value);
    if (typeof newValue === "number" && isNaN(newValue)) newValue = "";
  } else {
    newValue = el.value;
  }

  row[field] = newValue;

  // Auto-fill id from the label, and short label for streams — but only the
  // first time, so the user can override either freely afterwards.
  if (field === "label" && !row.id) {
    const slug = slugify(newValue);
    if (slug) {
      row.id = slug;
      const idInput = el.closest("tr").querySelector('[data-field="id"]');
      if (idInput && !idInput.value) idInput.value = slug;
    }
  }
  if (section === "streams" && field === "label" && !row.short) {
    const short = String(newValue || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    if (short) {
      row.short = short;
      const shortInput = el.closest("tr").querySelector('[data-field="short"]');
      if (shortInput && !shortInput.value) shortInput.value = short;
    }
  }

  // Update the footer (validation count + button enabled state) without
  // doing a full re-render — otherwise we'd wipe focus from the input the
  // user is currently typing in. Debounced (trailing 150ms) so fast typing
  // doesn't trigger a footer-DOM rebuild on every keystroke — that was the
  // single largest per-keystroke cost in the wizard.
  scheduleBuilderFooterRefresh();
  saveBuilderToStorage();

  // If the value just started overflowing, drop the "expanded" textarea
  // below the cell so the user can keep reading what they're typing.
  handleBuilderInputForOverflow(event);
}
