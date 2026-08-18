// =============================================================================
// BUILDER PANEL — render functions
// -----------------------------------------------------------------------------
// HTML output for the wizard overlay: top dispatch (`renderBuilder`), the
// header / footer / step indicator, one renderer per step, and tiny helpers
// (`reviewTile`, `optionList`, `refreshBuilderFooter`).
//
// Reads state from `state.builder` (set up in 16a-builder-state.js) and
// validation results from `validateBuilder()`. After painting the overlay
// it calls `attachBuilderEvents()` from 16d-builder-events.js to wire up
// click / drag / typing handlers.
//
// Pattern: each step's HTML is a single string with the `BUILDER_SPLIT`
// marker dividing the always-visible top section (heading, blurb, action
// bar) from the scrollable bottom section (the row table). The split lets
// long row lists scroll while the heading stays anchored.
// =============================================================================

import { COMBINE_OPTIONS, DIRECTION_OPTIONS, EFFECT_OPTIONS } from "./02-config";
import { state } from "./03-state";
import { escapeHtml } from "./04-utils";
import { saveBuilderToStorage } from "./04a-storage";
import { setLazySelectPreparer, upgradeSelectsIn, upgradeSelectsLazilyIn } from "./04b-typeable-dropdown";
import {
  BUILDER_LAST_STEP,
  BUILDER_SPLIT,
  BUILDER_STEPS,
  invalidateBuilderCaches,
  rowActionsHtml,
  rowDragHandleHtml,
  sortableTh,
  sortedBuilderIndices,
  tableEmptyRow,
  validateBuilder,
  withBuilderValidationMemo,
} from "./16a-builder-state";
import { clearDismissedTrigger, hideCellEditor } from "./16c-builder-editor";
import {
  attachBuilderEvents,
  syncBuilderSelectAllState,
  wireBuilderFooterButtons,
} from "./16d-builder-events";
import type { BuilderSection } from "./types";

// ───── Row virtualization ─────────────────────────────────────────────────
// A step's table used to put every row in the DOM. That is fine at the sizes
// the wizard was designed for and ruinous past them: the Boxes step emits 17
// inputs per row, and the Links step emits TWO <select>s per row, each one
// carrying an <option> for every box in the map — O(links × boxes) elements,
// which hangs the tab outright on a real map.
//
// Above BUILDER_VIRTUAL_MIN_ROWS we materialize only a window of rows around
// the scroll position and stand two zero-content spacer rows in for everything
// above and below it, so the scrollbar still measures the full table. Below the
// threshold nothing changes at all — same markup, no spacers, no scroll
// listener — because that is the size at which today's output is the contract.
//
// What virtualization must NOT change, and doesn't:
//   • data-index is the DATA index, never a position in the window.
//   • Sorting still decides display order; the window slices the sorted order.
//   • Select-all and bulk delete work off state.builder, not the DOM.
//   • Add / duplicate / delete / drag-reorder are index-based already.
//   • Tab / Enter navigate the data model (16d) and materialize their target
//     row through ensureBuilderRowVisible() before focusing it.
export const BUILDER_VIRTUAL_MIN_ROWS = 150;
// Rows kept in the DOM at once. Comfortably more than fills a tall window, so
// a scroll of a screen or two lands inside the already-rendered slice.
export const BUILDER_VIRTUAL_WINDOW = 80;
// Rows rendered above the first visible one, so a small upward scroll doesn't
// expose a spacer before the rAF repaint lands.
export const BUILDER_VIRTUAL_OVERSCAN = 20;
// Assumed row height in px, used to size the spacers and to map scrollTop onto
// a row position. Matches --pad-cell + the cell input's height in 11-builder.css;
// refined from a real measurement once one row has been laid out (jsdom and the
// first paint report 0, hence the fallback).
export const BUILDER_ROW_HEIGHT_PX = 37;

interface VirtualTable {
  section: BuilderSection;
  /** DATA indices, in display (sorted) order. */
  order: number[];
  colSpan: number;
  renderRow: (dataIndex: number) => string;
  /** First materialized position within `order`. */
  start: number;
  rowHeight: number;
}

// The virtualized table of the CURRENTLY rendered step, or null when the step
// renders every row (small table, empty table, or the Review step).
let _virtualTable: VirtualTable | null = null;
let _virtualScrollFrame: number | null = null;

/** Test/introspection hook: the live virtual-window state, or null. */
export function builderVirtualState(): { section: string; start: number; total: number; window: number } | null {
  if (!_virtualTable) return null;
  return {
    section: _virtualTable.section,
    start: _virtualTable.start,
    total: _virtualTable.order.length,
    window: BUILDER_VIRTUAL_WINDOW,
  };
}

// Rows for one step's <tbody>. Either every row (small table — byte-identical
// to what the step renderers used to emit inline) or a spacer / window / spacer
// sandwich. Called by each step renderer; the LAST caller in a render wins,
// which is correct because renderBuilder paints exactly one step.
export function renderBuilderRows(
  section: BuilderSection,
  order: number[],
  colSpan: number,
  renderRow: (dataIndex: number) => string,
): string {
  if (order.length < BUILDER_VIRTUAL_MIN_ROWS) {
    _virtualTable = null;
    return order.map(renderRow).join("");
  }
  // Keep the window where the user left it when re-rendering the same section
  // (delete / bulk edit / checkbox toggle all re-render in place, and
  // renderBuilder restores the scroll position to match).
  const carried = _virtualTable && _virtualTable.section === section ? _virtualTable.start : 0;
  const rowHeight = _virtualTable ? _virtualTable.rowHeight : BUILDER_ROW_HEIGHT_PX;
  _virtualTable = {
    section, order, colSpan, renderRow, rowHeight,
    start: clampWindowStart(carried, order.length),
  };
  return virtualWindowHtml(_virtualTable);
}

// Display order for the three drag-reorderable sections, which have no
// sortable headers: the array order IS the display order.
function identityOrder(rows: unknown[]): number[] {
  return rows.map((_, i) => i);
}

function clampWindowStart(start: number, total: number): number {
  const maxStart = Math.max(0, total - BUILDER_VIRTUAL_WINDOW);
  return Math.max(0, Math.min(start, maxStart));
}

function windowStartFromScroll(scrollTop: number, total: number, rowHeight: number): number {
  const firstVisible = Math.floor(Math.max(0, scrollTop) / Math.max(1, rowHeight));
  return clampWindowStart(firstVisible - BUILDER_VIRTUAL_OVERSCAN, total);
}

// A spacer stands in for `count` un-rendered rows. aria-hidden + no content, so
// screen readers and every `tr[data-index]` query skip straight past it.
function spacerRow(count: number, rowHeight: number, colSpan: number): string {
  if (count <= 0) return "";
  const h = count * rowHeight;
  return '<tr class="builder-virtual-spacer" aria-hidden="true" style="height:' + h + 'px">' +
           '<td colspan="' + colSpan + '" style="height:' + h + 'px"></td>' +
         '</tr>';
}

function virtualWindowHtml(vt: VirtualTable): string {
  const total = vt.order.length;
  const end = Math.min(total, vt.start + BUILDER_VIRTUAL_WINDOW);
  let html = spacerRow(vt.start, vt.rowHeight, vt.colSpan);
  for (let pos = vt.start; pos < end; pos++) html += vt.renderRow(vt.order[pos]);
  html += spacerRow(total - end, vt.rowHeight, vt.colSpan);
  return html;
}

function virtualScrollEl(): HTMLElement | null {
  const overlay = document.getElementById("builder-overlay");
  return overlay ? (overlay.querySelector(".builder-step-scroll") as HTMLElement | null) : null;
}

// Repaint the window into the live <tbody>, preserving the caret when the
// focused cell's row survives the repaint. A row scrolled out of the window is
// destroyed by design — that is what makes this cheap.
function paintVirtualWindow(vt: VirtualTable, tbody: Element): void {
  const active = document.activeElement as HTMLElement | null;
  let keep: { section: string; field: string; index: string } | null = null;
  if (active && tbody.contains(active)) {
    // A focused typeable dropdown is an <input> with no data-* of its own; the
    // hidden native <select> beside it carries them.
    const cell = active.matches("[data-section][data-field]")
      ? active
      : (active.closest(".typeable-dropdown")?.querySelector("[data-section][data-field]") as HTMLElement | null);
    const section = cell && cell.getAttribute("data-section");
    const field   = cell && cell.getAttribute("data-field");
    const index   = cell && cell.getAttribute("data-index");
    if (section && field && index) keep = { section, field, index };
    // The floating cell editor anchors to a DOM node we're about to discard.
    hideCellEditor({ skipAnimation: true });
  }

  tbody.innerHTML = virtualWindowHtml(vt);

  if (keep) {
    const el = tbody.querySelector(
      '[data-section="' + keep.section + '"][data-field="' + keep.field + '"][data-index="' + keep.index + '"]',
    ) as HTMLElement | null;
    if (el && typeof el.focus === "function") el.focus();
  }
  if (typeof syncBuilderSelectAllState === "function") syncBuilderSelectAllState();
}

// rAF-throttled scroll handler. The listener is attached to the freshly built
// .builder-step-scroll each render, so there is nothing to detach — the old
// element (and its listener) is discarded with the old DOM.
function onBuilderVirtualScroll(): void {
  if (_virtualScrollFrame !== null) return;
  _virtualScrollFrame = requestAnimationFrame(() => {
    _virtualScrollFrame = null;
    repaintBuilderVirtualRows();
  });
}

export function repaintBuilderVirtualRows(): void {
  const vt = _virtualTable;
  if (!vt) return;
  const scroll = virtualScrollEl();
  const tbody = scroll && scroll.querySelector("table.builder-table tbody");
  if (!scroll || !tbody) return;
  const start = windowStartFromScroll(scroll.scrollTop, vt.order.length, vt.rowHeight);
  if (start === vt.start) return;
  vt.start = start;
  paintVirtualWindow(vt, tbody);
}

// Wire the scroll listener and refine the assumed row height from a real
// measurement, now that one window of rows has been laid out.
export function attachBuilderVirtualScroll(): void {
  const vt = _virtualTable;
  if (!vt) return;
  const scroll = virtualScrollEl();
  if (!scroll) return;
  const firstRow = scroll.querySelector("table.builder-table tbody tr:not(.builder-virtual-spacer)") as HTMLElement | null;
  const measured = firstRow ? firstRow.offsetHeight : 0;
  if (measured > 0) vt.rowHeight = measured;
  scroll.addEventListener("scroll", onBuilderVirtualScroll);
}

// Make sure the row holding DATA index `index` is materialized, sliding the
// window onto it if it isn't. This is what lets Tab / Enter step into a row
// that virtualization has scrolled out of the DOM. Returns true if the window
// moved. No-op when the step isn't virtualized, so callers can call it blindly.
export function ensureBuilderRowVisible(section: BuilderSection, index: number): boolean {
  const vt = _virtualTable;
  if (!vt || vt.section !== section) return false;
  const pos = vt.order.indexOf(index);
  if (pos < 0) return false;
  if (pos >= vt.start && pos < vt.start + BUILDER_VIRTUAL_WINDOW) return false;

  const scroll = virtualScrollEl();
  const tbody = scroll && scroll.querySelector("table.builder-table tbody");
  if (!scroll || !tbody) return false;

  // Scroll FIRST, then derive the window from where the container actually
  // landed. Doing it in this order means the scroll event this triggers
  // recomputes the same start and its repaint is a no-op — otherwise it would
  // immediately tear down the row we just materialized to focus.
  scroll.scrollTop = Math.max(0, (pos - BUILDER_VIRTUAL_OVERSCAN) * vt.rowHeight);
  let start = windowStartFromScroll(scroll.scrollTop, vt.order.length, vt.rowHeight);
  // Environments without layout (jsdom, and any container that can't scroll)
  // swallow the assignment — centre the window on the row by hand instead.
  if (pos < start || pos >= start + BUILDER_VIRTUAL_WINDOW) {
    start = clampWindowStart(pos - BUILDER_VIRTUAL_OVERSCAN, vt.order.length);
  }
  vt.start = start;
  paintVirtualWindow(vt, tbody);
  return true;
}

// ───── Main render dispatch ───────────────────────────────────────────────
export function renderBuilder(): void {
  const overlay = document.getElementById("builder-overlay");
  if (!overlay) return;

  // The floating cell editor references DOM nodes inside the overlay. A
  // full re-render destroys those nodes, so close the editor first to
  // avoid a stale trigger reference. Skip the close animation — letting
  // the editor visibly shrink while the new step paints would look broken.
  // The dismissed-trigger ref also points at a soon-to-be-removed input,
  // so clear it too.
  hideCellEditor({ skipAnimation: true });
  clearDismissedTrigger();

  if (!state.builder.open) {
    overlay.classList.remove("open");
    overlay.innerHTML = "";
    _virtualTable = null;   // its rows, and its scroll listener, are gone
    return;
  }

  // Preserve the table's scroll position across re-renders. A full innerHTML
  // replace below destroys the old .builder-step-scroll (scrollTop → 0). We
  // only restore it for an IN-STEP re-render (delete / add / bulk edit /
  // checkbox toggle); a genuine step change should land at the top.
  const prevScroll = overlay.querySelector(".builder-step-scroll");
  const savedScrollTop = prevScroll ? prevScroll.scrollTop : 0;
  const sameStep = state.builder._lastRenderedStep === state.builder.step;
  state.builder._lastRenderedStep = state.builder.step;

  // Retire any cached sort order before painting. The step renderer below is
  // the one caller guaranteed to see current data, so making it the cache's
  // generation boundary means a mutation that forgot to invalidate can cost a
  // stale keyboard hop at worst, never a stale table. (16a explains the rest.)
  invalidateBuilderCaches();
  // Any window from the previously rendered step is meaningless now; the step
  // renderer re-establishes it (or leaves it null for a small / table-less step).
  _virtualTable = null;

  // One validation scan for the whole pass — the step renderer, the footer and
  // the Review step all ask for it and all see the same state (16a).
  const body = withBuilderValidationMemo(() => {
    switch (state.builder.step) {
      case 1: return renderBuilderStreamsStep();
      case 2: return renderBuilderStagesStep();
      case 3: return renderBuilderCategoriesStep();
      case 4: return renderBuilderNodesStep();
      case 5: return renderBuilderEdgesStep();
      case 6: return renderBuilderParamsStep();
      case 7: return renderBuilderReviewStep();
      default: return "";
    }
  });

  const splitIdx = body.indexOf(BUILDER_SPLIT);
  const above  = splitIdx === -1 ? body : body.slice(0, splitIdx);
  const scroll = splitIdx === -1 ? ""   : body.slice(splitIdx + BUILDER_SPLIT.length);

  overlay.innerHTML =
    '<div class="builder-card">' +
      renderBuilderHeader() +
      '<div class="builder-body">' +
        '<div class="builder-step-static">' + above + '</div>' +
        '<div class="builder-step-scroll">' + scroll + '</div>' +
      '</div>' +
      withBuilderValidationMemo(renderBuilderFooter) +
    '</div>';
  overlay.classList.add("open");

  // Typable filterable dropdowns, in two tiers.
  //
  // The bulk bar holds a handful of <select>s and is always on screen, so it is
  // upgraded eagerly exactly as the whole overlay used to be.
  //
  // Table cells are upgraded LAZILY, on first focus. Upgrading eagerly cost
  // three extra elements and ~8 listeners per <select>, and a Boxes step with
  // 5000 rows carries 25000 of them — seconds of work for controls the user
  // will touch a few of. `.builder-table select` is styled to match the
  // upgraded input exactly (11-builder.css), so a cell looks the same before
  // and after it is upgraded.
  const staticEl = overlay.querySelector(".builder-step-static");
  if (staticEl && typeof upgradeSelectsIn === "function") upgradeSelectsIn(staticEl);
  if (typeof setLazySelectPreparer === "function") setLazySelectPreparer(fillDeferredSelectOptions);
  if (typeof upgradeSelectsLazilyIn === "function") upgradeSelectsLazilyIn(overlay);

  attachBuilderEvents();
  attachBuilderVirtualScroll();
  saveBuilderToStorage();
  applyFocusAfterRender();

  // Restore scroll after layout settles (same rAF timing as focus restore).
  if (sameStep) {
    requestAnimationFrame(() => {
      const nextScroll = overlay.querySelector(".builder-step-scroll");
      if (nextScroll) nextScroll.scrollTop = savedScrollTop;
    });
  }
}

// After a full re-render, restore focus to a specific cell so keyboard-driven
// row creation (Enter on last row, Tab past last cell, +Add, Duplicate) lands
// inside the new row without requiring a mouse click. Runs in rAF so the
// floating editor's overflow measurements (scrollWidth/clientWidth) see a
// settled layout.
export function applyFocusAfterRender(): void {
  const target = state.builder.focusAfterRender;
  if (!target) return;
  state.builder.focusAfterRender = null;

  const overlay = document.getElementById("builder-overlay");
  if (!overlay) return;

  requestAnimationFrame(() => {
    let el: HTMLElement | null = null;
    if (target.field) {
      const sel = '[data-section="' + target.section + '"]' +
                  '[data-field="'   + target.field   + '"]' +
                  '[data-index="'   + target.index   + '"]';
      el = overlay.querySelector(sel) as HTMLElement | null;
    } else {
      const rowSel = 'tr[data-section="' + target.section + '"][data-index="' + target.index + '"]';
      let tr: HTMLElement | null = overlay.querySelector(rowSel) as HTMLElement | null;
      if (!tr) {
        // Edges and nodes rows don't carry data-section on the <tr> (only the
        // inputs do). Fall back to the first input we can find for that index.
        const first = overlay.querySelector('[data-section="' + target.section + '"][data-index="' + target.index + '"]');
        tr = first ? (first.closest("tr") as HTMLElement | null) : null;
      }
      el = tr ? (tr.querySelector('[data-section][data-field]') as HTMLElement | null) : null;
    }
    if (!el) return;
    // If the matched element is a hidden native <select> (upgraded into a
    // typable dropdown), redirect focus to the visible input that sits next
    // to it inside the wrapper.
    if (el.classList && el.classList.contains("typeable-dropdown-native")) {
      const wrap = el.closest(".typeable-dropdown");
      const input = wrap && wrap.querySelector(".typeable-dropdown-input");
      if (input) el = input as HTMLElement;
    }
    el.focus();
    const elInput = el as HTMLInputElement;
    if (typeof elInput.select === "function" && (elInput.type === "text" || elInput.type === "number")) {
      try { elInput.select(); } catch (_) {}
    }
    if (typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  });
}

export function renderBuilderHeader(): string {
  let dots = "";
  for (const step of BUILDER_STEPS) {
    const active = step.num === state.builder.step ? " active" : "";
    dots += '<button class="builder-step-dot' + active + '" data-step="' + step.num + '">' +
            step.num + ' · ' + escapeHtml(step.label) +
            '</button>';
  }
  return '<div class="builder-header">' +
           '<div class="builder-title">Build / Edit Map</div>' +
           '<div class="builder-step-indicator">' + dots + '</div>' +
           '<button class="builder-close" id="builder-close-button" data-tooltip="Close (Esc)">×</button>' +
         '</div>';
}

export function renderBuilderFooter(): string {
  const v = validateBuilder();
  const hasErrors = v.errors.length > 0;
  const step = state.builder.step;

  let status = "";
  if (hasErrors) {
    status = '<span class="builder-footer-status warn">' + v.errors.length + ' issue' + (v.errors.length === 1 ? '' : 's') + ' to resolve</span>';
  } else if (state.builder.nodes.length > 0) {
    status = '<span class="builder-footer-status">' + state.builder.nodes.length + ' boxes · ' + state.builder.edges.length + ' links · ready</span>';
  }

  const backDisabled  = step === 1 ? ' disabled' : '';
  const nextDisabled  = step === BUILDER_LAST_STEP ? ' disabled' : '';
  // Apply is intentionally NOT gated on validation — the user can apply a
  // partially-built map and the canvas will render blanks for missing data.
  // The issue-count warning above stays as informational feedback.

  return '<div class="builder-footer">' +
           '<button class="builder-action" id="builder-back-button"' + backDisabled + '>← Back</button>' +
           '<button class="builder-action" id="builder-next-button"' + nextDisabled + '>Next →</button>' +
           '<div class="builder-footer-spacer"></div>' +
           status +
           '<button class="builder-action" id="builder-download-button">Download CSV</button>' +
           '<button class="builder-action primary" id="builder-apply-button">Apply to map</button>' +
         '</div>';
}

// Inline footer refresh — used after every keystroke in a cell so the
// validation count and Apply button enabled-state stay current, without
// re-rendering the whole panel (which would wipe focus from the cell).
export function refreshBuilderFooter(): void {
  const oldFooter = document.querySelector("#builder-overlay .builder-footer");
  if (!oldFooter) return;
  const wrapper = document.createElement("div");
  wrapper.innerHTML = withBuilderValidationMemo(renderBuilderFooter);
  oldFooter.parentNode!.replaceChild(wrapper.firstElementChild!, oldFooter);
  wireBuilderFooterButtons();
}

// ───── Bulk multi-select helpers ──────────────────────────────────────────
// Each list step's table gets a leading checkbox column (a per-row checkbox +
// a "select all" header checkbox) and, when 1+ rows are ticked, a bulk action
// bar in the always-visible top section. Selection lives in
// state.builder.selected (a Set of row indices, scoped to the current step) —
// see 03-state.js and the routing in 16d-builder-events.js.

// Header cell with the "select all" checkbox. `indeterminate` (some-but-not-all
// selected) can't be expressed in HTML, so it's set post-render by
// syncBuilderSelectAllState() in 16d.
export function selectAllTh(section: string): string {
  return '<th class="builder-select-col">' +
           '<input type="checkbox" data-selectall="' + section + '" data-tooltip="Select all" />' +
         '</th>';
}

// Per-row checkbox cell.
export function rowSelectTd(section: string, i: number): string {
  const checked = state.builder.selected.has(i) ? " checked" : "";
  return '<td class="builder-select-col">' +
           '<input type="checkbox" data-rowselect="' + section + '" data-index="' + i + '"' + checked + ' />' +
         '</td>';
}

// `selected` class for a <tr> so selected rows get a highlight.
export function rowSelectedClass(i: number): string {
  return state.builder.selected.has(i) ? " selected" : "";
}

// One labelled <select> for the bulk bar. First option is a non-committal
// placeholder (mirrors multiSelectFieldMarkup in 16j). Tagged with
// data-bulksection / data-bulkfield so 16d can route the change.
export function builderBulkFieldMarkup(
  section: string,
  field: string,
  placeholder: string,
  options: Array<{ value: string; label: string }>,
): string {
  let html = '<select class="builder-bulk-select" data-bulksection="' + section + '" data-bulkfield="' + field + '">';
  html += '<option value="">' + escapeHtml(placeholder) + '</option>';
  for (const opt of options) {
    html += '<option value="' + escapeHtml(opt.value) + '">' + escapeHtml(opt.label) + '</option>';
  }
  html += '</select>';
  return html;
}

// The bulk action bar HTML for `section`. Returns "" when nothing is selected
// (so the bar is hidden). Inserted into each list step's static top area.
export function renderBuilderBulkBar(section: string): string {
  const n = state.builder.selected.size;
  if (n < 1) return "";

  let fields = "";
  if (section === "nodes") {
    const streamOpts = state.builder.streams.filter(s => s.id).map(s => ({ value: s.id, label: s.label || s.id }));
    const stageOpts  = state.builder.stages.filter(s => s.id).map(s => ({ value: s.id, label: s.label || s.id }));
    const catOpts    = state.builder.categories.filter(c => c.id).map(c => ({ value: c.id, label: c.label || c.id }));
    const dirOpts    = DIRECTION_OPTIONS.filter(o => o !== "").map(o => ({ value: o, label: o }));
    fields += builderBulkFieldMarkup(section, "stream",       "Set row…",   streamOpts);
    fields += builderBulkFieldMarkup(section, "stage",        "Set column…",    stageOpts);
    fields += builderBulkFieldMarkup(section, "category",     "Set category…", catOpts);
    const combineOpts = COMBINE_OPTIONS.filter(o => o !== "").map(o => ({ value: o, label: o }));
    fields += builderBulkFieldMarkup(section, "direction",    "Set direction…", dirOpts);
    fields += builderBulkFieldMarkup(section, "controllable", "Set slider…",
                [{ value: "true", label: "On" }, { value: "false", label: "Off" }]);
    // Same shape as the direction setter: the placeholder is "no change", so
    // bulk-setting can pick a rule but never clear one back to the default.
    fields += builderBulkFieldMarkup(section, "combine",      "Set combine…", combineOpts);
  } else if (section === "edges") {
    const effectOpts = EFFECT_OPTIONS.map(o => ({ value: o, label: o }));
    fields += builderBulkFieldMarkup(section, "effect", "Set effect…", effectOpts);
    fields += '<span class="builder-bulk-elasticity">' +
                '<input type="number" step="any" class="builder-bulk-input" data-bulkinput="elasticity" placeholder="Strength" />' +
                '<button class="builder-action" data-bulkapply="elasticity" data-bulksection="edges">Apply</button>' +
              '</span>';
  }

  return '<div class="builder-bulk-bar">' +
           '<span class="builder-bulk-count">' + n + ' selected</span>' +
           fields +
           '<div class="builder-bulk-spacer"></div>' +
           '<button class="builder-action danger" data-bulkdelete="' + section + '">Delete selected</button>' +
           '<button class="builder-action" data-bulkclear="1">Clear</button>' +
         '</div>';
}

// Rebuild just the bulk bar in place (cheap path for a single checkbox toggle —
// avoids tearing down the table / open cell editor). Mirrors
// refreshBuilderFooter. Re-runs upgradeSelectsIn so the new bar's <select>s
// become typeable dropdowns like the rest of the wizard.
export function refreshBuilderBulkBar(): void {
  const overlay = document.getElementById("builder-overlay");
  if (!overlay) return;
  const section = BUILDER_STEPS[state.builder.step - 1] && BUILDER_STEPS[state.builder.step - 1].key;
  if (!section) return;
  const existing = overlay.querySelector(".builder-bulk-bar");
  const html = renderBuilderBulkBar(section);
  if (existing) {
    if (html) {
      const wrapper = document.createElement("div");
      wrapper.innerHTML = html;
      const fresh = wrapper.firstElementChild!;
      existing.parentNode!.replaceChild(fresh, existing);
      if (typeof upgradeSelectsIn === "function") upgradeSelectsIn(fresh);
    } else {
      existing.remove();
    }
  } else if (html) {
    // No bar yet (first selection) — append to the end of the static top
    // section. (The "+ Add" action bar now lives at the BOTTOM of the table,
    // so we can no longer anchor to it; the bulk bar stays pinned up top.)
    const staticEl = overlay.querySelector(".builder-step-static");
    if (staticEl) {
      const wrapper = document.createElement("div");
      wrapper.innerHTML = html;
      const fresh = wrapper.firstElementChild!;
      staticEl.appendChild(fresh);
      if (typeof upgradeSelectsIn === "function") upgradeSelectsIn(fresh);
    }
  }
  if (typeof syncBuilderSelectAllState === "function") syncBuilderSelectAllState();
}

// ───── Step 1: Streams ────────────────────────────────────────────────────
export function renderBuilderStreamsStep(): string {
  const v = validateBuilder();
  let html = "";
  html += '<h2 class="builder-step-heading">Rows of the map</h2>';
  html += '<p class="builder-step-blurb">Rows are the functional flows or domains running across your map. ' +
          'Examples: <i>Operations, Sales, Support</i>, or any grouping that makes sense for your system.</p>';
  html += '<div class="builder-step-help">' +
          '<b>id</b> — short, lowercase, no spaces (e.g. <code>ops</code>). Auto-filled from the label. ' +
          '<b>label</b> — what users see in the sidebar. ' +
          '<b>short</b> — ~6-char uppercase tag on the row header. ' +
          '<b>color</b> — left bar colour on every box in this row. ' +
          'Drag a row by its <code>⋮⋮</code> handle to reorder.' +
          '</div>';

  html += renderBuilderBulkBar("streams");

  html += BUILDER_SPLIT;
  html += '<table class="builder-table">';
  html +=   '<thead><tr>' +
              selectAllTh("streams") +
              '<th style="width:28px"></th>' +     /* drag handle */
              '<th style="width:120px">ID</th>' +
              '<th>Label</th>' +
              '<th style="width:100px">Short</th>' +
              '<th style="width:80px">Color</th>' +
              '<th style="width:90px"></th>' +
            '</tr></thead><tbody>';

  if (state.builder.streams.length === 0) {
    html += tableEmptyRow(7, 'No rows yet. Click "+ Add row" to create one.');
  } else {
    html += renderBuilderRows("streams", identityOrder(state.builder.streams), 7, (i) => {
      const s = state.builder.streams[i];
      const invalidId = v.dupStreams.has(s.id) || !s.id ? ' invalid' : '';
      let row = '<tr draggable="true" class="' + rowSelectedClass(i).trim() + '" data-section="streams" data-index="' + i + '">';
      row +=   rowSelectTd("streams", i);
      row +=   rowDragHandleHtml();
      row +=   '<td><input type="text" data-section="streams" data-field="id" data-index="' + i + '" value="' + escapeHtml(s.id) + '" class="' + invalidId + '" placeholder="ops" /></td>';
      row +=   '<td><input type="text" data-section="streams" data-field="label" data-index="' + i + '" value="' + escapeHtml(s.label) + '" placeholder="Operations" /></td>';
      row +=   '<td><input type="text" data-section="streams" data-field="short" data-index="' + i + '" value="' + escapeHtml(s.short) + '" placeholder="OPS" /></td>';
      row +=   '<td><input type="color" data-section="streams" data-field="color" data-index="' + i + '" value="' + escapeHtml(s.color || "#94a3b8") + '" /></td>';
      row +=   rowActionsHtml("streams", i);
      row += '</tr>';
      return row;
    });
  }

  html += '</tbody></table>';
  html += '<div class="builder-action-bar">';
  html +=   '<button class="builder-action" data-add="streams">+ Add row</button>';
  if (state.builder.streams.length === 0) {
    html += '<button class="builder-action" id="builder-start-from-sample">Start from sample</button>';
  }
  html += '</div>';
  return html;
}

// ───── Step 2: Stages ─────────────────────────────────────────────────────
export function renderBuilderStagesStep(): string {
  const v = validateBuilder();
  let html = "";
  html += '<h2 class="builder-step-heading">Columns of the map</h2>';
  html += '<p class="builder-step-blurb">Columns represent the lifecycle from inputs to outcomes, left-to-right. ' +
          'Examples: <i>Resources, Inputs, Processes, Outcomes</i>. The order you list them is the order ' +
          'they render.</p>';
  html += '<div class="builder-step-help">' +
          '<b>id</b> — lowercase, no spaces (e.g. <code>inputs</code>). Auto-filled. ' +
          '<b>label</b> — column header text on the map. ' +
          'Drag a row by its <code>⋮⋮</code> handle to reorder.' +
          '</div>';

  html += renderBuilderBulkBar("stages");

  html += BUILDER_SPLIT;
  html += '<table class="builder-table">';
  html +=   '<thead><tr>' +
              selectAllTh("stages") +
              '<th style="width:28px"></th>' +     /* drag handle */
              '<th style="width:200px">ID</th>' +
              '<th>Label</th>' +
              '<th style="width:90px"></th>' +
            '</tr></thead><tbody>';

  if (state.builder.stages.length === 0) {
    html += tableEmptyRow(5, 'No columns yet. Click "+ Add column" to create one.');
  } else {
    html += renderBuilderRows("stages", identityOrder(state.builder.stages), 5, (i) => {
      const s = state.builder.stages[i];
      const invalidId = v.dupStages.has(s.id) || !s.id ? ' invalid' : '';
      let row = '<tr draggable="true" class="' + rowSelectedClass(i).trim() + '" data-section="stages" data-index="' + i + '">';
      row +=   rowSelectTd("stages", i);
      row +=   rowDragHandleHtml();
      row +=   '<td><input type="text" data-section="stages" data-field="id" data-index="' + i + '" value="' + escapeHtml(s.id) + '" class="' + invalidId + '" placeholder="inputs" /></td>';
      row +=   '<td><input type="text" data-section="stages" data-field="label" data-index="' + i + '" value="' + escapeHtml(s.label) + '" placeholder="Inputs" /></td>';
      row +=   rowActionsHtml("stages", i);
      row += '</tr>';
      return row;
    });
  }
  html += '</tbody></table>';
  html += '<div class="builder-action-bar"><button class="builder-action" data-add="stages">+ Add column</button></div>';
  return html;
}

// ───── Step 3: Categories ─────────────────────────────────────────────────
export function renderBuilderCategoriesStep(): string {
  const v = validateBuilder();
  let html = "";
  html += '<h2 class="builder-step-heading">Categories — types of box</h2>';
  html += '<p class="builder-step-blurb">Categories visually distinguish what each box represents. ' +
          'Examples: <i>Resource, Process, Metric, Outcome</i>. Each category has its own colour.</p>';
  html += '<div class="builder-step-help">' +
          '<b>id</b> — lowercase, no spaces. Auto-filled. ' +
          '<b>label</b> — sidebar legend label. ' +
          '<b>color</b> — box fill. ' +
          '<b>text colour</b> — box label colour, pick a high-contrast value vs. the fill. ' +
          'Drag a row by its <code>⋮⋮</code> handle to reorder.' +
          '</div>';

  html += renderBuilderBulkBar("categories");

  html += BUILDER_SPLIT;
  html += '<table class="builder-table">';
  html +=   '<thead><tr>' +
              selectAllTh("categories") +
              '<th style="width:28px"></th>' +     /* drag handle */
              '<th style="width:140px">ID</th>' +
              '<th>Label</th>' +
              '<th style="width:80px">Fill</th>' +
              '<th style="width:80px">Text</th>' +
              '<th style="width:130px">Class</th>' +
              '<th style="width:90px"></th>' +
            '</tr></thead><tbody>';

  if (state.builder.categories.length === 0) {
    html += tableEmptyRow(8, 'No categories yet. Click "+ Add category" to create one.');
  } else {
    html += renderBuilderRows("categories", identityOrder(state.builder.categories), 8, (i) => {
      const c = state.builder.categories[i];
      const invalidId = v.dupCategories.has(c.id) || !c.id ? ' invalid' : '';
      let row = '<tr draggable="true" class="' + rowSelectedClass(i).trim() + '" data-section="categories" data-index="' + i + '">';
      row +=   rowSelectTd("categories", i);
      row +=   rowDragHandleHtml();
      row +=   '<td><input type="text" data-section="categories" data-field="id" data-index="' + i + '" value="' + escapeHtml(c.id) + '" class="' + invalidId + '" placeholder="resource" /></td>';
      row +=   '<td><input type="text" data-section="categories" data-field="label" data-index="' + i + '" value="' + escapeHtml(c.label) + '" placeholder="Resource" /></td>';
      row +=   '<td><input type="color" data-section="categories" data-field="color" data-index="' + i + '" value="' + escapeHtml(c.color || "#a3a3a3") + '" /></td>';
      row +=   '<td><input type="color" data-section="categories" data-field="textColor" data-index="' + i + '" value="' + escapeHtml(c.textColor || "#1c1917") + '" /></td>';
      row +=   '<td><select data-section="categories" data-field="class" data-index="' + i + '">' +
                 '<option value="primary"'   + ((c.class || "primary") !== "secondary" ? " selected" : "") + '>Fill tag</option>' +
                 '<option value="secondary"' + ((c.class || "primary") === "secondary" ? " selected" : "") + '>Corner tag</option>' +
               '</select></td>';
      row +=   rowActionsHtml("categories", i);
      row += '</tr>';
      return row;
    });
  }
  html += '</tbody></table>';
  html += '<div class="builder-action-bar"><button class="builder-action" data-add="categories">+ Add category</button></div>';
  return html;
}

// ───── Step 4: Nodes ──────────────────────────────────────────────────────
export function renderBuilderNodesStep(): string {
  const v = validateBuilder();
  const streamOptions   = optionList(state.builder.streams.map(s => s.id));
  const stageOptions    = optionList(state.builder.stages.map(s => s.id));
  const categoryOptions = optionList(state.builder.categories.map(c => c.id));

  let html = "";
  html += '<h2 class="builder-step-heading">Boxes on the map</h2>';
  html += '<p class="builder-step-blurb">Each box sits at the intersection of one row and one column, ' +
          'and has one category (colour). The optional fields on the right enable the live Simulation feature.</p>';
  html += '<div class="builder-step-help">' +
          '<b>Required:</b> id, label, row, column, category. ' +
          '<b>For simulation</b> add a <b>starting value</b> (e.g. 100) and <b>unit</b> (e.g. <i>units</i>, <i>%</i>, <i>£</i>, or whatever fits). ' +
          'Tick <b>adjustable</b> to expose a slider in Simulation mode. ' +
          '<b>direction</b> sets outcome colouring on metric boxes (higher_better / lower_better).' +
          '</div>';
  // The four calculation columns at the far right of the table are the opt-in
  // half of the model — a map that leaves them blank behaves exactly as it did
  // before they existed, so they get their own note rather than crowding the
  // one above. Everything here is checked properly on "Apply to map"; the
  // wizard only states the rules.
  html += '<div class="builder-step-help">' +
          '<b>Optional calculation rules</b> (last four columns, scroll right). ' +
          '<b>combine</b> — how the links pointing INTO this box add up: ' +
          '<i>multiplicative</i> (the default: effects compound), <i>additive</i> (effects add, so related ' +
          'inputs don\'t overstate the result), or <i>min</i> (the weakest input gates the outcome). ' +
          '<b>formula</b> — an expression in the boxes\' own units, e.g. <code>min(demand, capacity)</code>, ' +
          'using box ids, constant ids from Step 6, <code>+ − * / ( )</code> and ' +
          '<code>min / max / clamp / delay</code>. A formula <b>wins over combine</b>, and a box with an ' +
          'adjustable slider ignores both. Every box a formula names must also have a link drawn from it. ' +
          '<b>min / max</b> — hard limits in the box\'s own units (not multipliers), applied after the rule runs.' +
          '</div>';

  if (state.builder.streams.length === 0 || state.builder.stages.length === 0 || state.builder.categories.length === 0) {
    html += '<div class="builder-validation errors">' +
              '<div class="builder-validation-title">Setup needed</div>' +
              '<ul>' +
                (state.builder.streams.length    === 0 ? '<li>Go back to Step 1 and add at least one row.</li>' : '') +
                (state.builder.stages.length     === 0 ? '<li>Go back to Step 2 and add at least one column.</li>' : '') +
                (state.builder.categories.length === 0 ? '<li>Go back to Step 3 and add at least one category.</li>' : '') +
              '</ul>' +
            '</div>';
  }

  html += renderBuilderBulkBar("nodes");

  html += BUILDER_SPLIT;
  // `builder-table-wide`: 17 columns don't fit a narrow window, so this table
  // keeps a minimum width and the step area scrolls sideways rather than
  // crushing every cell (see 11-builder.css).
  html += '<table class="builder-table builder-table-wide">';
  html +=   '<thead><tr>' +
              selectAllTh("nodes") +
              sortableTh("nodes", "id",           "ID",         ' style="width:160px"') +
              sortableTh("nodes", "label",        "Label",      ' style="width:180px"') +
              sortableTh("nodes", "description",  "Description", "") +
              sortableTh("nodes", "stream",       "Row",        ' style="width:110px"') +
              sortableTh("nodes", "stage",        "Column",     ' style="width:110px"') +
              sortableTh("nodes", "category",     "Category",   ' style="width:110px"') +
              sortableTh("nodes", "baseline",     "Starting value", ' style="width:90px"') +
              sortableTh("nodes", "unit",         "Unit",       ' style="width:90px"') +
              sortableTh("nodes", "controllable", "Slider",     ' style="width:50px"') +
              sortableTh("nodes", "direction",    "Direction",  ' style="width:120px"') +
              sortableTh("nodes", "sliderMax",    "Slider max", ' style="width:80px"') +
              // The four calculation-rule columns. `sortableTh`'s last argument
              // is raw attribute text, so the per-column hint rides along with
              // the width here — see the shared data-tooltip handling in
              // 12-tooltip.js.
              sortableTh("nodes", "combine",  "Combine", ' style="width:130px"' +
                ' data-tooltip="How the links INTO this box combine: multiplicative (default) / additive / min.' +
                ' Ignored when the box has a formula."') +
              sortableTh("nodes", "formula",  "Formula", ' style="width:200px"' +
                ' data-tooltip="Expression in the boxes\' own units, e.g. min(demand, capacity). Beats combine,' +
                ' and is ignored on a slider box. Every box id it names also needs a link drawn from that box."') +
              sortableTh("nodes", "minValue", "Min",     ' style="width:80px"' +
                ' data-tooltip="Hard lower limit in this box\'s own units (not a multiplier), applied after the rule runs."') +
              sortableTh("nodes", "maxValue", "Max",     ' style="width:80px"' +
                ' data-tooltip="Hard upper limit in this box\'s own units (not a multiplier), applied after the rule runs."') +
              '<th style="width:90px"></th>' +
            '</tr></thead><tbody>';

  if (state.builder.nodes.length === 0) {
    html += tableEmptyRow(17, 'No boxes yet. Click "+ Add box" to create one.');
  } else {
    html += renderBuilderRows("nodes", sortedBuilderIndices("nodes"), 17, (i) => {
      const n = state.builder.nodes[i];
      const idInvalid       = !n.id || v.dupNodes.has(n.id)   ? ' invalid' : '';
      const streamInvalid   = !v.streamIds.has(n.stream)      ? ' invalid' : '';
      const stageInvalid    = !v.stageIds.has(n.stage)        ? ' invalid' : '';
      const categoryInvalid = !v.categoryIds.has(n.category as string)  ? ' invalid' : '';

      let row = '<tr class="' + rowSelectedClass(i).trim() + '" data-index="' + i + '">';
      row +=   rowSelectTd("nodes", i);
      row +=   '<td><input type="text" data-section="nodes" data-field="id" data-index="' + i + '" value="' + escapeHtml(n.id) + '" class="' + idInvalid + '" placeholder="team_size" /></td>';
      row +=   '<td><input type="text" data-section="nodes" data-field="label" data-index="' + i + '" value="' + escapeHtml(n.label) + '" placeholder="Team size" /></td>';
      row +=   '<td><input type="text" data-section="nodes" data-field="description" data-index="' + i + '" value="' + escapeHtml(n.description) + '" placeholder="What this box represents" /></td>';
      row +=   '<td><select data-section="nodes" data-field="stream" data-index="' + i + '" class="' + streamInvalid + '"><option value=""></option>' + streamOptions(n.stream) + '</select></td>';
      row +=   '<td><select data-section="nodes" data-field="stage" data-index="' + i + '" class="' + stageInvalid + '"><option value=""></option>' + stageOptions(n.stage) + '</select></td>';
      row +=   '<td><select data-section="nodes" data-field="category" data-index="' + i + '" class="' + categoryInvalid + '"><option value=""></option>' + categoryOptions(n.category) + '</select></td>';
      row +=   '<td><input type="number" step="any" data-section="nodes" data-field="baseline" data-index="' + i + '" value="' + escapeHtml(n.baseline === undefined ? "" : n.baseline) + '" placeholder="100" /></td>';
      row +=   '<td><input type="text" data-section="nodes" data-field="unit" data-index="' + i + '" value="' + escapeHtml(n.unit) + '" placeholder="units" /></td>';
      row +=   '<td style="text-align:center"><input type="checkbox" data-section="nodes" data-field="controllable" data-index="' + i + '"' + (n.controllable ? " checked" : "") + ' /></td>';
      row +=   '<td><select data-section="nodes" data-field="direction" data-index="' + i + '">' +
                  DIRECTION_OPTIONS.map(opt =>
                    '<option value="' + opt + '"' + (opt === (n.direction || "") ? " selected" : "") + '>' + (opt || "—") + '</option>'
                  ).join("") +
                '</select></td>';
      row +=   '<td><input type="number" step="any" data-section="nodes" data-field="sliderMax" data-index="' + i + '" value="' + escapeHtml(n.sliderMax === undefined ? "" : n.sliderMax) + '" placeholder="2.0" /></td>';
      // Calculation rules. `combine` is an enum cell exactly like `direction`
      // (blank first entry = the default rule); `formula` is free text; min /
      // max are plain numbers in the box's own units.
      row +=   '<td><select data-section="nodes" data-field="combine" data-index="' + i + '">' +
                  COMBINE_OPTIONS.map(opt =>
                    '<option value="' + opt + '"' + (opt === (n.combine || "") ? " selected" : "") + '>' + (opt || "—") + '</option>'
                  ).join("") +
                '</select></td>';
      row +=   '<td><input type="text" data-section="nodes" data-field="formula" data-index="' + i + '" value="' + escapeHtml(n.formula) + '" placeholder="min(demand, capacity)" /></td>';
      row +=   '<td><input type="number" step="any" data-section="nodes" data-field="minValue" data-index="' + i + '" value="' + escapeHtml(n.minValue === undefined ? "" : n.minValue) + '" placeholder="no limit" /></td>';
      row +=   '<td><input type="number" step="any" data-section="nodes" data-field="maxValue" data-index="' + i + '" value="' + escapeHtml(n.maxValue === undefined ? "" : n.maxValue) + '" placeholder="no limit" /></td>';
      row +=   rowActionsHtml("nodes", i);
      row += '</tr>';
      return row;
    });
  }
  html += '</tbody></table>';
  html += '<div class="builder-action-bar"><button class="builder-action" data-add="nodes">+ Add box</button></div>';
  return html;
}

// ───── Step 5: Edges ──────────────────────────────────────────────────────
export function renderBuilderEdgesStep(): string {
  const v = validateBuilder();
  // Deferred, not the full optionList: see selectedOnlyNodeOption.
  const nodeOptions = selectedOnlyNodeOption();

  let html = "";
  html += '<h2 class="builder-step-heading">Links between boxes</h2>';
  html += '<p class="builder-step-blurb">Each link goes <b>from</b> a cause <b>to</b> an effect. ' +
          'Pick the effect type — <i>enables</i> (prerequisite), <i>increases</i> (push up), or <i>decreases</i> (push down) — ' +
          'and (optionally) override the strength for simulation.</p>';
  // Help text + the default-elasticity inputs sit side-by-side on a wide card
  // (and stack on a narrow one) so the table gets more vertical room — see
  // .builder-edges-config in 11-builder.css.
  html += '<div class="builder-edges-config">';
  html +=   '<div class="builder-step-help">' +
              '<b>Defaults below</b> — used when the strength column is left blank. ' +
              'Strength = % change in target value per % change in source value. ' +
              'For <i>decreases</i> effects the default is negative.' +
            '</div>';
  html +=   '<div class="builder-defaults">' +
              '<label>elasticity_enables<input type="number" step="any" data-default="enables"   value="' + state.builder.defaults.enables   + '" /></label>' +
              '<label>elasticity_increases<input type="number" step="any" data-default="increases" value="' + state.builder.defaults.increases + '" /></label>' +
              '<label>elasticity_decreases<input type="number" step="any" data-default="decreases" value="' + state.builder.defaults.decreases + '" /></label>' +
            '</div>';
  html += '</div>';

  if (state.builder.nodes.length === 0) {
    html += '<div class="builder-validation errors">' +
              '<div class="builder-validation-title">Setup needed</div>' +
              '<ul><li>Go back to Step 4 and add at least one box before defining links.</li></ul>' +
            '</div>';
  }

  html += renderBuilderBulkBar("edges");

  html += BUILDER_SPLIT;
  html += '<table class="builder-table">';
  html +=   '<thead><tr>' +
              selectAllTh("edges") +
              sortableTh("edges", "from",        "From",        ' style="width:200px"') +
              sortableTh("edges", "to",          "To",          ' style="width:200px"') +
              sortableTh("edges", "effect",      "Effect",      ' style="width:130px"') +
              sortableTh("edges", "elasticity",  "Strength",  ' style="width:110px"') +
              '<th style="width:96px">Style</th>' +
              sortableTh("edges", "description", "Description", "") +
              '<th style="width:90px"></th>' +
            '</tr></thead><tbody>';

  if (state.builder.edges.length === 0) {
    html += tableEmptyRow(8, 'No links yet. Click "+ Add link".');
  } else {
    html += renderBuilderRows("edges", sortedBuilderIndices("edges"), 8, (i) => {
      const e = state.builder.edges[i];
      const fromInvalid = !v.nodeIds.has(e.from) ? ' invalid' : '';
      const toInvalid   = !v.nodeIds.has(e.to)   ? ' invalid' : '';

      let row = '<tr class="' + rowSelectedClass(i).trim() + '" data-index="' + i + '">';
      row +=   rowSelectTd("edges", i);
      row +=   '<td><select data-options="nodes" data-section="edges" data-field="from" data-index="' + i + '" class="' + fromInvalid + '"><option value=""></option>' + nodeOptions(e.from) + '</select></td>';
      row +=   '<td><select data-options="nodes" data-section="edges" data-field="to"   data-index="' + i + '" class="' + toInvalid   + '"><option value=""></option>' + nodeOptions(e.to)   + '</select></td>';
      row +=   '<td><select data-section="edges" data-field="effect" data-index="' + i + '">' +
                  EFFECT_OPTIONS.map(opt =>
                    '<option value="' + opt + '"' + (opt === e.effect ? " selected" : "") + '>' + opt + '</option>'
                  ).join("") +
                '</select></td>';
      row +=   '<td><input type="number" step="any" data-section="edges" data-field="elasticity" data-index="' + i + '" value="' + escapeHtml(e.elasticity === undefined ? "" : e.elasticity) + '" placeholder="(default)" /></td>';
      row +=   '<td><select data-section="edges" data-field="style" data-index="' + i + '">' +
                  '<option value="solid"'  + (e.style === "dashed" ? "" : " selected") + '>Solid</option>' +
                  '<option value="dashed"' + (e.style === "dashed" ? " selected" : "") + '>Dashed</option>' +
                '</select></td>';
      row +=   '<td><input type="text" data-section="edges" data-field="description" data-index="' + i + '" value="' + escapeHtml(e.description) + '" placeholder="Why this link exists" /></td>';
      row +=   rowActionsHtml("edges", i);
      row += '</tr>';
      return row;
    });
  }
  html += '</tbody></table>';
  html += '<div class="builder-action-bar"><button class="builder-action" data-add="edges">+ Add link</button></div>';
  return html;
}

// ───── Step 6: Params (hidden calculation constants) ──────────────────────
// Named scalars that belong to the calculation model but never draw as boxes:
// route shares, detection rates, unit conversions. Keeping them off the map is
// the point — a box formula can reach them by id, and the picture stays
// readable. (See docs/CALCULATION-ENGINE-DESIGN.md §3.3.)
export function renderBuilderParamsStep(): string {
  const v = validateBuilder();
  const params = state.builder.params || [];

  let html = "";
  html += '<h2 class="builder-step-heading">Constants for the calculation</h2>';
  html += '<p class="builder-step-blurb">Optional. Constants are named numbers a box <b>formula</b> can use — ' +
          'shares, rates and conversion factors that matter to the maths but would clutter the map as boxes. ' +
          'They never render; nothing here changes a map that uses no formulas.</p>';
  html += '<div class="builder-step-help">' +
          '<b>id</b> — the name a formula refers to, lowercase, no spaces (e.g. <code>share_air</code>). ' +
          'It must not be the same as a box id — a formula has to know which one you meant. ' +
          '<b>value</b> — a plain number. ' +
          '<b>description</b> — what the constant means and where the number came from, for the next reader. ' +
          'Example: <code>share_air, 0.35, Share of traffic routed by air</code>, used from a box formula as ' +
          '<code>attempted_importation * share_air</code>.' +
          '</div>';

  html += renderBuilderBulkBar("params");

  html += BUILDER_SPLIT;
  html += '<table class="builder-table">';
  html +=   '<thead><tr>' +
              selectAllTh("params") +
              sortableTh("params", "id",          "ID",    ' style="width:220px"') +
              sortableTh("params", "value",       "Value", ' style="width:140px"') +
              sortableTh("params", "description", "Description", "") +
              '<th style="width:90px"></th>' +
            '</tr></thead><tbody>';

  if (params.length === 0) {
    html += tableEmptyRow(5, 'No constants — that is fine. Click "+ Add constant" if a box formula needs one.');
  } else {
    html += renderBuilderRows("params", sortedBuilderIndices("params"), 5, (i) => {
      const p = params[i];
      // Two cheap hints, mirroring the loader's own checks: an id a box has
      // already taken, and a value that isn't a number. Everything else waits
      // for "Apply to map".
      const idInvalid    = (!p.id || v.dupParams.has(p.id) || v.clashParams.has(p.id)) ? ' invalid' : '';
      const valueInvalid = v.badParamValueRows.has(i) ? ' invalid' : '';
      const idHint = v.clashParams.has(p.id)
        ? ' data-tooltip="A box already uses this id — a formula could mean either, so this constant would be dropped."'
        : '';

      let row = '<tr class="' + rowSelectedClass(i).trim() + '" data-index="' + i + '">';
      row +=   rowSelectTd("params", i);
      row +=   '<td' + idHint + '><input type="text" data-section="params" data-field="id" data-index="' + i + '" value="' + escapeHtml(p.id) + '" class="' + idInvalid + '" placeholder="share_air" /></td>';
      row +=   '<td><input type="number" step="any" data-section="params" data-field="value" data-index="' + i + '" value="' + escapeHtml(p.value === undefined || p.value === null ? "" : p.value) + '" class="' + valueInvalid + '" placeholder="0.35" /></td>';
      row +=   '<td><input type="text" data-section="params" data-field="description" data-index="' + i + '" value="' + escapeHtml(p.description) + '" placeholder="What this number is, and where it came from" /></td>';
      row +=   rowActionsHtml("params", i);
      row += '</tr>';
      return row;
    });
  }
  html += '</tbody></table>';
  html += '<div class="builder-action-bar"><button class="builder-action" data-add="params">+ Add constant</button></div>';
  return html;
}

// ───── Step 7: Review ─────────────────────────────────────────────────────
export function renderBuilderReviewStep(): string {
  const v = validateBuilder();
  const b = state.builder;

  let html = "";
  html += '<h2 class="builder-step-heading">Review & finish</h2>';
  html += '<p class="builder-step-blurb">Counts and validation are below. ' +
          '<b>Apply to map</b> loads the data straight into the live app. ' +
          '<b>Download CSV</b> saves a .csv you can drag back in later or share with colleagues.</p>';

  html += BUILDER_SPLIT;
  html += '<div class="builder-review-grid">' +
            reviewTile("Rows",       b.streams.length) +
            reviewTile("Columns",    b.stages.length) +
            reviewTile("Categories", b.categories.length) +
            reviewTile("Boxes",      b.nodes.length) +
            reviewTile("Links",      b.edges.length) +
            reviewTile("Constants",  (b.params || []).length) +
          '</div>';

  if (v.errors.length === 0) {
    html += '<div class="builder-validation ok">' +
              '<div class="builder-validation-title">All checks passed</div>' +
              '<ul><li>Ready to apply or download.</li></ul>' +
            '</div>';
  } else {
    html += '<div class="builder-validation errors">' +
              '<div class="builder-validation-title">' + v.errors.length + ' issue' + (v.errors.length === 1 ? '' : 's') + ' to resolve</div>' +
              '<ul>' + v.errors.map(err => '<li>' + escapeHtml(err) + '</li>').join("") + '</ul>' +
            '</div>';
  }

  return html;
}

export function reviewTile(label: string, value: number | string): string {
  return '<div class="builder-review-tile">' +
           '<div class="builder-review-tile-label">' + escapeHtml(label) + '</div>' +
           '<div class="builder-review-tile-value">' + value + '</div>' +
         '</div>';
}

// ───── Deferred option lists ──────────────────────────────────────────────
// The Links table's `from` / `to` cells are the wizard's worst DOM offender:
// two <select>s per row, each historically carrying an <option> for every box
// in the map. Virtualization caps the rows, but 80 rows × 2 selects × 2000
// boxes is still 320,000 <option> elements — most of a minute of parsing for a
// list the user will open at most one of.
//
// Since a <select> displays only its SELECTED option at rest, the markup only
// needs that one. The full list is built by fillDeferredSelectOptions the
// instant the control is entered, just before 04b upgrades it into a typable
// dropdown — so the resting cell is pixel-identical and the opened one is
// complete. `data-options` marks a select as needing that treatment.

// <option> markup for a Links cell: the blank placeholder plus, when the value
// names a real box, that one entry — with exactly the display text optionList
// would have produced for it, so nothing shifts once the list is filled in.
export function selectedOnlyNodeOption(): (currentValue: string | undefined) => string {
  const labelById: Record<string, string | undefined> = {};
  for (const n of state.builder.nodes) labelById[n.id] = n.label;
  return function (currentValue: string | undefined): string {
    if (!currentValue || !(currentValue in labelById)) return "";
    const label = labelById[currentValue];
    const display = label ? currentValue + " — " + label : currentValue;
    return '<option value="' + escapeHtml(currentValue) + '" selected>' + escapeHtml(display) + "</option>";
  };
}

// Registered with 04b as the lazy-upgrade preparer. Expands a deferred select
// into its real option list, preserving the current value, then clears the
// marker so the work happens once per control.
export function fillDeferredSelectOptions(select: HTMLSelectElement): void {
  if (!select || select.getAttribute("data-options") !== "nodes") return;
  select.removeAttribute("data-options");
  const current = select.value;
  const build = optionList(state.builder.nodes.map(n => n.id), state.builder.nodes);
  select.innerHTML = '<option value=""></option>' + build(current);
  select.value = current;
}

// Helper: build a closure that returns <option> markup for a list of ids,
// pre-selecting `currentValue`. Optionally accepts a parallel `objects`
// array so options can show the label after the id ("team_size — Team size").
export function optionList(
  ids: string[],
  objects?: Array<{ label?: string }>,
): (currentValue: string | undefined) => string {
  return function (currentValue: string | undefined): string {
    return ids.map((id, idx) => {
      const display = objects && objects[idx] && objects[idx].label
        ? id + " — " + objects[idx].label
        : id;
      return '<option value="' + escapeHtml(id) + '"' + (id === currentValue ? " selected" : "") + '>' +
             escapeHtml(display) +
             '</option>';
    }).join("");
  };
}
