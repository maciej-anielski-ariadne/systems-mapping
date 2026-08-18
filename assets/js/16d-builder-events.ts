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

import { state } from "./03-state";
import { scheduleBuilderSave } from "./04a-storage";
import {
  addBuilderRow,
  applyBuilderBulkField,
  applyBuilderToMap,
  BUILDER_LAST_STEP,
  BUILDER_ROW_FIELDS,
  clearBuilderSelection,
  closeBuilder,
  deleteBuilderSelectedRows,
  downloadBuilderCsv,
  duplicateBuilderRow,
  invalidateBuilderCaches,
  nextBuilderDisplayIndex,
  prevBuilderDisplayIndex,
  reconcileBuilderNodeCategories,
  seedBuilderFromSample,
  slugify,
} from "./16a-builder-state";
import {
  ensureBuilderRowVisible,
  refreshBuilderBulkBar,
  refreshBuilderFooter,
  renderBuilder,
} from "./16b-builder-render";
import {
  handleBuilderFocus,
  handleBuilderFocusOut,
  handleBuilderInputForOverflow,
  hideCellEditor,
} from "./16c-builder-editor";
import type { BuilderNode, BuilderSection } from "./types";

// ───── Footer button rebind ──────────────────────────────────────────────
// Two flavours of event wiring: full-render binding (attachBuilderEvents)
// re-binds everything after a full innerHTML replace; footer-only binding
// (wireBuilderFooterButtons) is also reused after the inline footer refresh
// triggered by every keystroke. Keeping them in one place avoids drift.
export function wireBuilderFooterButtons(): void {
  const back = document.getElementById("builder-back-button");
  if (back) back.addEventListener("click", () => {
    if (state.builder.step > 1) { state.builder.step -= 1; renderBuilder(); }
  });
  const next = document.getElementById("builder-next-button");
  if (next) next.addEventListener("click", () => {
    if (state.builder.step < BUILDER_LAST_STEP) { state.builder.step += 1; renderBuilder(); }
  });
  const apply = document.getElementById("builder-apply-button");
  if (apply) apply.addEventListener("click", applyBuilderToMap);
  const download = document.getElementById("builder-download-button");
  if (download) download.addEventListener("click", downloadBuilderCsv);
}

// ───── Delegated click handler ───────────────────────────────────────────
// Looks at the closest data-* attribute on the click target and dispatches.
export function handleBuilderClick(event: MouseEvent): void {
  const overlay = document.getElementById("builder-overlay");
  const target = (event.target as HTMLElement).closest(
    "[data-step], [data-add], [data-duplicate], [data-delete], " +
    "[data-bulkdelete], [data-bulkclear], [data-bulkapply], [data-sort]"
  ) as HTMLElement | null;
  if (!target || !overlay || !overlay.contains(target)) return;

  if (target.hasAttribute("data-sort")) {
    // Clickable column header on the nodes/edges tables. Cycle the sort on that
    // column: ascending → descending → none. View-only (see sortedBuilderIndices
    // in 16a) so it never touches the row order in state or the exported CSV.
    const section = target.getAttribute("data-sort")! as BuilderSection;
    const key     = target.getAttribute("data-sortkey")!;
    const cur     = state.builder.sort[section];
    const dir = (!cur || cur.key !== key) ? "asc"
              : (cur.dir === "asc")       ? "desc"
              :                             null;
    state.builder.sort[section] = dir ? { key, dir } : null;
    invalidateBuilderCaches();
    renderBuilder();
    return;
  }

  if (target.hasAttribute("data-step")) {
    const step = parseInt(target.getAttribute("data-step")!, 10);
    if (!isNaN(step)) {
      clearBuilderSelection();   // indices don't carry across steps
      state.builder.step = step;
      renderBuilder();
    }
    return;
  }
  if (target.hasAttribute("data-add")) {
    const section = target.getAttribute("data-add") as BuilderSection;
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
      deleteBuilderSelectedRows(target.getAttribute("data-bulkdelete") as BuilderSection);
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
    const field   = target.getAttribute("data-bulkapply")!;
    const section  = (target.getAttribute("data-bulksection") || "edges") as BuilderSection;
    const input   = overlay.querySelector('[data-bulkinput="' + field + '"]') as HTMLInputElement | null;
    const value   = input ? input.value : "";
    if (typeof applyBuilderBulkField === "function") {
      const changed = applyBuilderBulkField(section, field, value);
      scheduleBuilderSave();
      if (changed) renderBuilder(); else refreshBuilderBulkBar();
    }
    return;
  }

  const index = parseInt(target.getAttribute("data-index")!, 10);
  if (isNaN(index)) return;
  if (target.hasAttribute("data-duplicate")) {
    const section = target.getAttribute("data-duplicate") as BuilderSection;
    clearBuilderSelection();   // duplicate shifts indices after `index`
    const newIdx = duplicateBuilderRow(section, index);
    if (newIdx >= 0) {
      state.builder.focusAfterRender = { section, index: newIdx, field: null };
    }
    renderBuilder();
  } else if (target.hasAttribute("data-delete")) {
    // `params` is optional on BuilderState, so index defensively — every other
    // section is always an array.
    const rows = state.builder[target.getAttribute("data-delete")! as BuilderSection];
    if (rows) rows.splice(index, 1);
    invalidateBuilderCaches();
    clearBuilderSelection();   // a removed row shifts later indices
    renderBuilder();
  }
}

// Routes input + change events to the appropriate field updater based on
// which data-* attribute the target carries.
export function handleBuilderCellChange(event: Event): void {
  const t = event.target as HTMLElement;
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
export function handleBuilderRowSelect(event: Event): void {
  const checkbox = event.target as HTMLInputElement;
  const i = parseInt(checkbox.getAttribute("data-index")!, 10);
  if (isNaN(i)) return;
  if (checkbox.checked) state.builder.selected.add(i);
  else                      state.builder.selected.delete(i);
  const tr = checkbox.closest("tr");
  if (tr) tr.classList.toggle("selected", checkbox.checked);
  if (typeof refreshBuilderBulkBar === "function") refreshBuilderBulkBar();
}

// "Select all" header checkbox — select every row in the current section or
// clear. Full re-render so each row checkbox + highlight repaints (scroll is
// preserved by renderBuilder's same-step restore).
export function handleBuilderSelectAll(event: Event): void {
  const checkbox = event.target as HTMLInputElement;
  const section = checkbox.getAttribute("data-selectall")! as BuilderSection;
  const arr = state.builder[section];
  if (!arr) return;
  if (checkbox.checked) state.builder.selected = new Set(arr.map((_: unknown, i: number) => i));
  else clearBuilderSelection();
  renderBuilder();
}

// A bulk-field dropdown changed — apply the picked value to every selected
// row. Re-render so the row cells reflect the change (selection indices are
// unchanged, so the same rows stay selected). Empty placeholder → no-op, but
// still refresh the bar so the dropdown resets to its placeholder.
export function handleBuilderBulkField(event: Event): void {
  const el = event.target as HTMLInputElement;
  const section = el.getAttribute("data-bulksection") as BuilderSection | null;
  const field   = el.getAttribute("data-bulkfield");
  const value   = el.value;
  if (!section || !field) return;
  if (value === "") { if (typeof refreshBuilderBulkBar === "function") refreshBuilderBulkBar(); return; }
  if (typeof applyBuilderBulkField !== "function") return;
  const changed = applyBuilderBulkField(section, field, value);
  scheduleBuilderSave();
  if (changed) renderBuilder();
  else if (typeof refreshBuilderBulkBar === "function") refreshBuilderBulkBar();
}

// After a render, reflect the selection on the "select all" box: checked when
// every row is selected, indeterminate when only some are. (indeterminate
// can't be set via an HTML attribute, hence this post-render sync.)
export function syncBuilderSelectAllState(): void {
  const overlay = document.getElementById("builder-overlay");
  if (!overlay) return;
  const box = overlay.querySelector("[data-selectall]") as HTMLInputElement | null;
  if (!box) return;
  const section = box.getAttribute("data-selectall")! as BuilderSection;
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
export const BUILDER_EDITABLE_SELECTOR =
  "[data-section][data-field]:not(:disabled):not(.typeable-dropdown-native), " +
  ".typeable-dropdown-input";

export function builderEditableCells(fromEl: HTMLElement | null): HTMLElement[] {
  const scope = (fromEl && fromEl.closest("table.builder-table")) ||
                document.getElementById("builder-overlay");
  if (!scope) return [];
  return Array.from(scope.querySelectorAll(BUILDER_EDITABLE_SELECTOR)) as HTMLElement[];
}

// ───── Data-model cell addressing ────────────────────────────────────────
// Navigation used to walk the live DOM in document order. That only works when
// every row is in the DOM, and above ~150 rows a step renders a window of them
// (see 16b). So the model, not the DOM, decides where the next cell is:
// BUILDER_ROW_FIELDS (16a) gives the column order within a row, and
// next/prevBuilderDisplayIndex give the row above/below in the CURRENT display
// order — sorted or not. Only once we know the destination do we touch the DOM,
// materializing its row first if virtualization has it scrolled out.

/** Which (section, field, row) a focused element edits, or null if it isn't a
 *  table cell — e.g. a bulk-bar control, which still uses the DOM walk. */
export function builderCellCoords(
  el: HTMLElement | null,
): { section: BuilderSection; field: string; index: number } | null {
  if (!el) return null;
  // A typable dropdown's visible input carries no data-*; its hidden native
  // <select> sibling does.
  const cell = el.matches("[data-section][data-field]")
    ? el
    : (el.closest(".typeable-dropdown")?.querySelector("[data-section][data-field]") as HTMLElement | null);
  if (!cell || !cell.closest("table.builder-table")) return null;
  const section = cell.getAttribute("data-section") as BuilderSection | null;
  const field   = cell.getAttribute("data-field");
  const index   = parseInt(cell.getAttribute("data-index")!, 10);
  if (!section || !field || isNaN(index)) return null;
  return { section, field, index };
}

/** The focusable element for one cell, materializing nothing. Redirects to the
 *  visible input when the cell's <select> has already been upgraded. */
export function builderCellElement(
  section: BuilderSection,
  field: string,
  index: number,
): HTMLElement | null {
  const overlay = document.getElementById("builder-overlay");
  if (!overlay) return null;
  const el = overlay.querySelector(
    '[data-section="' + section + '"][data-field="' + field + '"][data-index="' + index + '"]',
  ) as HTMLElement | null;
  if (!el) return null;
  if (el.classList && el.classList.contains("typeable-dropdown-native")) {
    const input = el.closest(".typeable-dropdown")?.querySelector(".typeable-dropdown-input");
    if (input) return input as HTMLElement;
  }
  return el;
}

// Focus a cell, bringing its row into the DOM and into view first. Returns the
// element that took focus, or null when the cell doesn't exist.
//
// Caret is placed at the end of the value (not select-all). select() would
// have two unwanted effects: (a) visually highlights all text, which the
// user doesn't want when navigating; (b) in some browsers, calling .select()
// re-focuses the input, which steals focus from the cell editor that
// handleBuilderFocus just opened — the editor's blur handler then closes
// it before the expand animation runs. setSelectionRange has no such
// side effects.
export function focusBuilderCell(
  section: BuilderSection,
  field: string,
  index: number,
): HTMLElement | null {
  if (typeof ensureBuilderRowVisible === "function") ensureBuilderRowVisible(section, index);
  const next = builderCellElement(section, field, index) as HTMLInputElement | null;
  if (!next) return null;
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
  if (typeof next.scrollIntoView === "function") next.scrollIntoView({ block: "nearest" });
  return next;
}

// Move focus to the next / previous editable cell in DISPLAY order. Returns the
// element focused, or null if we ran off the end. Caller is responsible for
// appending a new row if it wants to handle the off-end case.
export function navigateEditableCell(fromEl: HTMLElement, direction: string): HTMLElement | null {
  const coords = builderCellCoords(fromEl);
  // Not a table cell (bulk bar, defaults row, …) — nothing in the data model to
  // walk, so fall back to the DOM order those controls have always used.
  if (!coords) return navigateEditableCellByDom(fromEl, direction);

  const fields = BUILDER_ROW_FIELDS[coords.section];
  if (!fields) return null;
  const fieldPos = fields.indexOf(coords.field);
  if (fieldPos === -1) return null;

  let targetField: string;
  let targetIndex: number;
  if (direction === "prev") {
    if (fieldPos > 0) {
      targetField = fields[fieldPos - 1];
      targetIndex = coords.index;
    } else {
      targetIndex = prevBuilderDisplayIndex(coords.section, coords.index);
      if (targetIndex < 0) return null;      // first cell of the first row
      targetField = fields[fields.length - 1];
    }
  } else {
    if (fieldPos < fields.length - 1) {
      targetField = fields[fieldPos + 1];
      targetIndex = coords.index;
    } else {
      targetIndex = nextBuilderDisplayIndex(coords.section, coords.index);
      if (targetIndex < 0) return null;      // last cell of the last row
      targetField = fields[0];
    }
  }
  return focusBuilderCell(coords.section, targetField, targetIndex);
}

// The original DOM-order walk, kept for the editable controls that live outside
// a row table and therefore have no (section, field, index) address.
function navigateEditableCellByDom(fromEl: HTMLElement, direction: string): HTMLElement | null {
  const cells = builderEditableCells(fromEl);
  const idx = cells.indexOf(fromEl);
  if (idx === -1) return null;
  const targetIdx = direction === "prev" ? idx - 1 : idx + 1;
  if (targetIdx < 0 || targetIdx >= cells.length) return null;
  const next = cells[targetIdx] as HTMLInputElement;
  next.focus();
  if (next.type === "text" && typeof next.setSelectionRange === "function") {
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
export function builderTabNavigate(
  fromCell: HTMLElement,
  direction: string
): { moved: HTMLElement } | { addedRow: true } | { atStart: true } | { atEnd: true } {
  const moved = navigateEditableCell(fromCell, direction);
  if (moved) return { moved };
  if (direction === "next") {
    // Read the section from the data model, not the attribute — an upgraded
    // dropdown's visible input carries no data-section of its own.
    const coords = builderCellCoords(fromCell);
    const section = coords ? coords.section
                           : (fromCell.getAttribute("data-section") as BuilderSection | null);
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

export function handleBuilderKeydown(event: KeyboardEvent): void {
  const t = event.target as HTMLInputElement;
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
    if (("moved" in result && result.moved) || ("addedRow" in result && result.addedRow)) event.preventDefault();
    return;
  }

  if (event.key === "Enter") {
    // Spreadsheet metaphor: move down in the same column. Limit to plain
    // text/number inputs — selects, color pickers, and checkboxes have
    // native Enter behaviour we want to preserve.
    if (t.tagName !== "INPUT") return;
    if (t.type !== "text" && t.type !== "number") return;

    const coords = builderCellCoords(t);
    if (!coords) return;
    const { section, field, index } = coords;

    event.preventDefault();
    // Follow the on-screen (possibly sorted) order, not the raw array order —
    // nextBuilderDisplayIndex returns index+1 when no sort is active.
    // focusBuilderCell materializes the destination row first, so this still
    // works when the row below is outside the rendered window.
    const nextIndex = (typeof nextBuilderDisplayIndex === "function")
      ? nextBuilderDisplayIndex(section, index)
      : index + 1;
    if (nextIndex >= 0 && focusBuilderCell(section, field, nextIndex)) return;

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
export let _builderDragSource: { section: string; index: number } | null = null;

export function handleBuilderDragStart(event: DragEvent): void {
  const row = (event.target as HTMLElement).closest("tr[draggable='true']") as HTMLElement | null;
  if (!row) return;
  // Close any open cell editor so it doesn't anchor to a row that's about
  // to move.
  if (typeof hideCellEditor === "function") hideCellEditor();
  _builderDragSource = {
    section: row.getAttribute("data-section")!,
    index:   parseInt(row.getAttribute("data-index")!, 10),
  };
  row.classList.add("dragging");
  event.dataTransfer!.effectAllowed = "move";
  // Firefox requires some data on the transfer or dragstart fires but no
  // subsequent dragover events arrive.
  try { event.dataTransfer!.setData("text/plain", row.getAttribute("data-index")!); } catch (_) {}
}

export function handleBuilderDragOver(event: DragEvent): void {
  if (!_builderDragSource) return;
  const row = (event.target as HTMLElement).closest("tr[draggable='true']") as HTMLElement | null;
  if (!row) return;
  if (row.getAttribute("data-section") !== _builderDragSource.section) return;
  event.preventDefault();
  event.dataTransfer!.dropEffect = "move";
  const rect = row.getBoundingClientRect();
  const above = event.clientY < rect.top + rect.height / 2;
  document.querySelectorAll(".builder-table tr.drop-target-above, .builder-table tr.drop-target-below").forEach(el => {
    el.classList.remove("drop-target-above", "drop-target-below");
  });
  row.classList.add(above ? "drop-target-above" : "drop-target-below");
}

export function handleBuilderDrop(event: DragEvent): void {
  if (!_builderDragSource) return;
  const row = (event.target as HTMLElement).closest("tr[draggable='true']") as HTMLElement | null;
  if (!row) { handleBuilderDragEnd(); return; }
  if (row.getAttribute("data-section") !== _builderDragSource.section) {
    handleBuilderDragEnd();
    return;
  }
  event.preventDefault();
  const targetIndex = parseInt(row.getAttribute("data-index")!, 10);
  const rect = row.getBoundingClientRect();
  const above = event.clientY < rect.top + rect.height / 2;
  const arr = state.builder[_builderDragSource.section as BuilderSection] as unknown as Record<
    string,
    unknown
  >[];
  const fromIndex = _builderDragSource.index;
  let toIndex = above ? targetIndex : targetIndex + 1;
  if (fromIndex < toIndex) toIndex -= 1;   // splice() shifts elements after the removed one
  if (fromIndex !== toIndex) {
    const [moved] = arr.splice(fromIndex, 1);
    arr.splice(toIndex, 0, moved);
    invalidateBuilderCaches();
  }
  handleBuilderDragEnd();
  clearBuilderSelection();   // reorder shifts indices
  renderBuilder();
  scheduleBuilderSave();
}

export function handleBuilderDragEnd(): void {
  _builderDragSource = null;
  document.querySelectorAll(".builder-table tr.dragging, .builder-table tr.drop-target-above, .builder-table tr.drop-target-below").forEach(el => {
    el.classList.remove("dragging", "drop-target-above", "drop-target-below");
  });
}

// ───── Top-level event attachment ────────────────────────────────────────
export function attachBuilderEvents(): void {
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
    overlay.addEventListener("click",     handleBuilderClick as EventListener);
    overlay.addEventListener("input",     handleBuilderCellChange);
    overlay.addEventListener("change",    handleBuilderCellChange);
    overlay.addEventListener("focusin",   handleBuilderFocus);
    overlay.addEventListener("focusout",  handleBuilderFocusOut);
    overlay.addEventListener("keydown",   handleBuilderKeydown as EventListener);
    overlay.addEventListener("dragstart", handleBuilderDragStart as EventListener);
    overlay.addEventListener("dragover",  handleBuilderDragOver as EventListener);
    overlay.addEventListener("drop",      handleBuilderDrop as EventListener);
    overlay.addEventListener("dragend",   handleBuilderDragEnd);
    overlay.dataset.builderDelegated = "true";
  }
}

// ───── Footer-refresh debounce ───────────────────────────────────────────
// Per-keystroke refreshBuilderFooter() replaces the entire footer DOM and
// re-runs validateBuilder() (which scans all builder arrays). On a complex
// step this is the most expensive thing in the typing loop, so coalesce
// rapid keystrokes into a single trailing-edge refresh.
export let _footerRefreshTimer: ReturnType<typeof setTimeout> | null = null;
export function scheduleBuilderFooterRefresh(): void {
  if (_footerRefreshTimer) clearTimeout(_footerRefreshTimer);
  _footerRefreshTimer = setTimeout(() => {
    _footerRefreshTimer = null;
    refreshBuilderFooter();
  }, 150);
}

// ───── Field updaters ────────────────────────────────────────────────────
export function handleBuilderDefault(event: Event): void {
  const el = event.target as HTMLInputElement;
  const key = el.getAttribute("data-default")!;
  const raw = el.value;
  if (raw === "") return;
  const val = parseFloat(raw);
  if (!isNaN(val)) {
    (state.builder.defaults as unknown as Record<string, number>)[key] = val;
    scheduleBuilderSave();
  }
}

export function handleBuilderInput(event: Event): void {
  const el      = event.target as HTMLInputElement;
  const section = el.getAttribute("data-section") as BuilderSection | null;
  const field   = el.getAttribute("data-field");
  const index   = parseInt(el.getAttribute("data-index")!, 10);
  if (!section || !field || isNaN(index)) return;
  const rows = state.builder[section];
  const row = rows && (rows[index] as BuilderNode);
  if (!row) return;

  let newValue: string | number | boolean;
  if (el.type === "checkbox") {
    newValue = el.checked;
  } else if (el.type === "number") {
    newValue = el.value === "" ? "" : parseFloat(el.value);
    if (typeof newValue === "number" && isNaN(newValue)) newValue = "";
  } else {
    newValue = el.value;
  }

  (row as unknown as Record<string, unknown>)[field] = newValue;
  // A field write can change a sorted table's display order, which is what the
  // Enter key follows — retire the cached order (16a).
  invalidateBuilderCaches();

  // The node table edits the single primary anchor; keep the node's full
  // category list in sync (full multi-primary editing lives in the detail panel).
  if (section === "nodes" && field === "category") reconcileBuilderNodeCategories(row, newValue as string);

  // Auto-fill id from the label, and short label for streams — but only the
  // first time, so the user can override either freely afterwards.
  if (field === "label" && !row.id) {
    const slug = slugify(newValue as string);
    if (slug) {
      row.id = slug;
      const idInput = el.closest("tr")!.querySelector('[data-field="id"]') as HTMLInputElement | null;
      if (idInput && !idInput.value) idInput.value = slug;
    }
  }
  if (section === "streams" && field === "label" && !(row as unknown as Record<string, unknown>).short) {
    const short = String(newValue || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    if (short) {
      (row as unknown as Record<string, unknown>).short = short;
      const shortInput = el.closest("tr")!.querySelector('[data-field="short"]') as HTMLInputElement | null;
      if (shortInput && !shortInput.value) shortInput.value = short;
    }
  }

  // Update the footer (validation count + button enabled state) without
  // doing a full re-render — otherwise we'd wipe focus from the input the
  // user is currently typing in. Debounced (trailing 150ms) so fast typing
  // doesn't trigger a footer-DOM rebuild on every keystroke — that was the
  // single largest per-keystroke cost in the wizard.
  scheduleBuilderFooterRefresh();
  scheduleBuilderSave();

  // If the value just started overflowing, drop the "expanded" textarea
  // below the cell so the user can keep reading what they're typing.
  handleBuilderInputForOverflow(event);
}
