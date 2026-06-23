// =============================================================================
// BUILDER PANEL — render functions
// -----------------------------------------------------------------------------
// HTML output for the wizard overlay: top dispatch (`renderBuilder`), the
// header / footer / step indicator, six step renderers, and tiny helpers
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

import { DIRECTION_OPTIONS, EFFECT_OPTIONS } from "./02-config";
import { state } from "./03-state";
import { escapeHtml } from "./04-utils";
import { saveBuilderToStorage } from "./04a-storage";
import { upgradeSelectsIn } from "./04b-typeable-dropdown";
import {
  BUILDER_SPLIT,
  BUILDER_STEPS,
  rowActionsHtml,
  rowDragHandleHtml,
  sortableTh,
  sortedBuilderIndices,
  tableEmptyRow,
  validateBuilder,
} from "./16a-builder-state";
import { clearDismissedTrigger, hideCellEditor } from "./16c-builder-editor";
import {
  attachBuilderEvents,
  syncBuilderSelectAllState,
  wireBuilderFooterButtons,
} from "./16d-builder-events";

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

  let body = "";
  switch (state.builder.step) {
    case 1: body = renderBuilderStreamsStep();    break;
    case 2: body = renderBuilderStagesStep();     break;
    case 3: body = renderBuilderCategoriesStep(); break;
    case 4: body = renderBuilderNodesStep();      break;
    case 5: body = renderBuilderEdgesStep();      break;
    case 6: body = renderBuilderReviewStep();     break;
  }

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
      renderBuilderFooter() +
    '</div>';
  overlay.classList.add("open");

  // Upgrade every <select> in the freshly-rendered overlay (stream / stage /
  // category / direction / from / to / effect) into a typable filterable
  // dropdown. Must run before Tab/Enter navigation queries see the cell —
  // 16d's BUILDER_EDITABLE_SELECTOR matches the typeable input by class.
  if (typeof upgradeSelectsIn === "function") upgradeSelectsIn(overlay);

  attachBuilderEvents();
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
  const nextDisabled  = step === 6 ? ' disabled' : '';
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
  wrapper.innerHTML = renderBuilderFooter();
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
    fields += builderBulkFieldMarkup(section, "direction",    "Set direction…", dirOpts);
    fields += builderBulkFieldMarkup(section, "controllable", "Set slider…",
                [{ value: "true", label: "On" }, { value: "false", label: "Off" }]);
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
          'Each row becomes a horizontal row. Examples: <i>Operations, Sales, Support</i>, or any grouping that makes sense for your system.</p>';
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
    html += tableEmptyRow(7, 'No rows yet. Click "+ Add row" to start.');
  } else {
    state.builder.streams.forEach((s, i) => {
      const invalidId = v.dupStreams.has(s.id) || !s.id ? ' invalid' : '';
      html += '<tr draggable="true" class="' + rowSelectedClass(i).trim() + '" data-section="streams" data-index="' + i + '">';
      html +=   rowSelectTd("streams", i);
      html +=   rowDragHandleHtml();
      html +=   '<td><input type="text" data-section="streams" data-field="id" data-index="' + i + '" value="' + escapeHtml(s.id) + '" class="' + invalidId + '" placeholder="ops" /></td>';
      html +=   '<td><input type="text" data-section="streams" data-field="label" data-index="' + i + '" value="' + escapeHtml(s.label) + '" placeholder="Operations" /></td>';
      html +=   '<td><input type="text" data-section="streams" data-field="short" data-index="' + i + '" value="' + escapeHtml(s.short) + '" placeholder="OPS" /></td>';
      html +=   '<td><input type="color" data-section="streams" data-field="color" data-index="' + i + '" value="' + escapeHtml(s.color || "#94a3b8") + '" /></td>';
      html +=   rowActionsHtml("streams", i);
      html += '</tr>';
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
    html += tableEmptyRow(5, 'No columns yet. Click "+ Add column".');
  } else {
    state.builder.stages.forEach((s, i) => {
      const invalidId = v.dupStages.has(s.id) || !s.id ? ' invalid' : '';
      html += '<tr draggable="true" class="' + rowSelectedClass(i).trim() + '" data-section="stages" data-index="' + i + '">';
      html +=   rowSelectTd("stages", i);
      html +=   rowDragHandleHtml();
      html +=   '<td><input type="text" data-section="stages" data-field="id" data-index="' + i + '" value="' + escapeHtml(s.id) + '" class="' + invalidId + '" placeholder="inputs" /></td>';
      html +=   '<td><input type="text" data-section="stages" data-field="label" data-index="' + i + '" value="' + escapeHtml(s.label) + '" placeholder="Inputs" /></td>';
      html +=   rowActionsHtml("stages", i);
      html += '</tr>';
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
    html += tableEmptyRow(8, 'No categories yet. Click "+ Add category".');
  } else {
    state.builder.categories.forEach((c, i) => {
      const invalidId = v.dupCategories.has(c.id) || !c.id ? ' invalid' : '';
      html += '<tr draggable="true" class="' + rowSelectedClass(i).trim() + '" data-section="categories" data-index="' + i + '">';
      html +=   rowSelectTd("categories", i);
      html +=   rowDragHandleHtml();
      html +=   '<td><input type="text" data-section="categories" data-field="id" data-index="' + i + '" value="' + escapeHtml(c.id) + '" class="' + invalidId + '" placeholder="resource" /></td>';
      html +=   '<td><input type="text" data-section="categories" data-field="label" data-index="' + i + '" value="' + escapeHtml(c.label) + '" placeholder="Resource" /></td>';
      html +=   '<td><input type="color" data-section="categories" data-field="color" data-index="' + i + '" value="' + escapeHtml(c.color || "#a3a3a3") + '" /></td>';
      html +=   '<td><input type="color" data-section="categories" data-field="textColor" data-index="' + i + '" value="' + escapeHtml(c.textColor || "#1c1917") + '" /></td>';
      html +=   '<td><select data-section="categories" data-field="class" data-index="' + i + '">' +
                  '<option value="primary"'   + ((c.class || "primary") !== "secondary" ? " selected" : "") + '>Primary · fill</option>' +
                  '<option value="secondary"' + ((c.class || "primary") === "secondary" ? " selected" : "") + '>Secondary · chip</option>' +
                '</select></td>';
      html +=   rowActionsHtml("categories", i);
      html += '</tr>';
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
  html += '<table class="builder-table">';
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
              '<th style="width:90px"></th>' +
            '</tr></thead><tbody>';

  if (state.builder.nodes.length === 0) {
    html += tableEmptyRow(13, 'No boxes yet. Click "+ Add box".');
  } else {
    sortedBuilderIndices("nodes").forEach((i) => {
      const n = state.builder.nodes[i];
      const idInvalid       = !n.id || v.dupNodes.has(n.id)   ? ' invalid' : '';
      const streamInvalid   = !v.streamIds.has(n.stream)      ? ' invalid' : '';
      const stageInvalid    = !v.stageIds.has(n.stage)        ? ' invalid' : '';
      const categoryInvalid = !v.categoryIds.has(n.category as string)  ? ' invalid' : '';

      html += '<tr class="' + rowSelectedClass(i).trim() + '" data-index="' + i + '">';
      html +=   rowSelectTd("nodes", i);
      html +=   '<td><input type="text" data-section="nodes" data-field="id" data-index="' + i + '" value="' + escapeHtml(n.id) + '" class="' + idInvalid + '" placeholder="team_size" /></td>';
      html +=   '<td><input type="text" data-section="nodes" data-field="label" data-index="' + i + '" value="' + escapeHtml(n.label) + '" placeholder="Team size" /></td>';
      html +=   '<td><input type="text" data-section="nodes" data-field="description" data-index="' + i + '" value="' + escapeHtml(n.description) + '" placeholder="What this box represents" /></td>';
      html +=   '<td><select data-section="nodes" data-field="stream" data-index="' + i + '" class="' + streamInvalid + '"><option value=""></option>' + streamOptions(n.stream) + '</select></td>';
      html +=   '<td><select data-section="nodes" data-field="stage" data-index="' + i + '" class="' + stageInvalid + '"><option value=""></option>' + stageOptions(n.stage) + '</select></td>';
      html +=   '<td><select data-section="nodes" data-field="category" data-index="' + i + '" class="' + categoryInvalid + '"><option value=""></option>' + categoryOptions(n.category) + '</select></td>';
      html +=   '<td><input type="number" step="any" data-section="nodes" data-field="baseline" data-index="' + i + '" value="' + escapeHtml(n.baseline === undefined ? "" : n.baseline) + '" placeholder="100" /></td>';
      html +=   '<td><input type="text" data-section="nodes" data-field="unit" data-index="' + i + '" value="' + escapeHtml(n.unit) + '" placeholder="units" /></td>';
      html +=   '<td style="text-align:center"><input type="checkbox" data-section="nodes" data-field="controllable" data-index="' + i + '"' + (n.controllable ? " checked" : "") + ' /></td>';
      html +=   '<td><select data-section="nodes" data-field="direction" data-index="' + i + '">' +
                  DIRECTION_OPTIONS.map(opt =>
                    '<option value="' + opt + '"' + (opt === (n.direction || "") ? " selected" : "") + '>' + (opt || "—") + '</option>'
                  ).join("") +
                '</select></td>';
      html +=   '<td><input type="number" step="any" data-section="nodes" data-field="sliderMax" data-index="' + i + '" value="' + escapeHtml(n.sliderMax === undefined ? "" : n.sliderMax) + '" placeholder="2.0" /></td>';
      html +=   rowActionsHtml("nodes", i);
      html += '</tr>';
    });
  }
  html += '</tbody></table>';
  html += '<div class="builder-action-bar"><button class="builder-action" data-add="nodes">+ Add box</button></div>';
  return html;
}

// ───── Step 5: Edges ──────────────────────────────────────────────────────
export function renderBuilderEdgesStep(): string {
  const v = validateBuilder();
  const nodeOptions = optionList(state.builder.nodes.map(n => n.id), state.builder.nodes);

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
    sortedBuilderIndices("edges").forEach((i) => {
      const e = state.builder.edges[i];
      const fromInvalid = !v.nodeIds.has(e.from) ? ' invalid' : '';
      const toInvalid   = !v.nodeIds.has(e.to)   ? ' invalid' : '';

      html += '<tr class="' + rowSelectedClass(i).trim() + '" data-index="' + i + '">';
      html +=   rowSelectTd("edges", i);
      html +=   '<td><select data-section="edges" data-field="from" data-index="' + i + '" class="' + fromInvalid + '"><option value=""></option>' + nodeOptions(e.from) + '</select></td>';
      html +=   '<td><select data-section="edges" data-field="to"   data-index="' + i + '" class="' + toInvalid   + '"><option value=""></option>' + nodeOptions(e.to)   + '</select></td>';
      html +=   '<td><select data-section="edges" data-field="effect" data-index="' + i + '">' +
                  EFFECT_OPTIONS.map(opt =>
                    '<option value="' + opt + '"' + (opt === e.effect ? " selected" : "") + '>' + opt + '</option>'
                  ).join("") +
                '</select></td>';
      html +=   '<td><input type="number" step="any" data-section="edges" data-field="elasticity" data-index="' + i + '" value="' + escapeHtml(e.elasticity === undefined ? "" : e.elasticity) + '" placeholder="(default)" /></td>';
      html +=   '<td><select data-section="edges" data-field="style" data-index="' + i + '">' +
                  '<option value="solid"'  + (e.style === "dashed" ? "" : " selected") + '>Solid</option>' +
                  '<option value="dashed"' + (e.style === "dashed" ? " selected" : "") + '>Dashed</option>' +
                '</select></td>';
      html +=   '<td><input type="text" data-section="edges" data-field="description" data-index="' + i + '" value="' + escapeHtml(e.description) + '" placeholder="Why this link exists" /></td>';
      html +=   rowActionsHtml("edges", i);
      html += '</tr>';
    });
  }
  html += '</tbody></table>';
  html += '<div class="builder-action-bar"><button class="builder-action" data-add="edges">+ Add link</button></div>';
  return html;
}

// ───── Step 6: Review ─────────────────────────────────────────────────────
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
