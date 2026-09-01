// =============================================================================
// LEFT SIDEBAR RENDERING
// -----------------------------------------------------------------------------
// Builds the HTML for the Stages list, the Stream filter rows, and the Category
// filter rows (and — in simulation mode — delegates to the simulation panel).
//
// Every row edits fully inline: double-click a name (or a stream's short-label
// chip) to rename it, click the swatch to recolour, and the trash icon to
// delete. Stream/category rows also toggle their map filter on a single click.
// Rows are drag-reorderable. Every mutation funnels through applyCanvasMutation.
// =============================================================================

import {
  CATEGORIES,
  EDGES,
  NODES,
  STAGES,
  STREAMS,
  categoryNodeCount,
  stageById,
  state,
  streamById,
  streamNodeCount,
  stageNodeCount,
} from "./03-state";
import { renderSimulationPanel } from "./14-simulation-panel";
import {
  escapeHtml,
  nodeCategoryIds,
  pickTextColor,
  splitCategoriesByClass,
} from "./04-utils";
import { deriveShortLabel } from "./16e-canvas-edit";
import {
  addCategory,
  applyCanvasMutation,
  deleteCategoryWithCascade,
  deleteStageWithCascade,
  deleteStreamWithCascade,
  reorderCategories,
  reorderStages,
  reorderStreams,
} from "./16f-canvas-mutations";
import {
  toggleCategory,
  toggleEffect,
  toggleStage,
  toggleStream,
  toggleStyle,
  toggleTrace,
} from "./10-filters";

export function renderSidebar(): void {
  const sidebarEl = document.getElementById("sidebar");
  if (sidebarEl) {
    sidebarEl.style.visibility = state.dataLoaded ? "visible" : "hidden";
  }
  if (!state.dataLoaded) return;

  // The simulation panel is its own concern — see 14-simulation-panel.js.
  renderSimulationPanel();


  renderStagesList();
  renderStreamsList();
  renderCategoriesList();
  renderLegendFilters();

  // Newly-rendered rows carry data-tooltip attributes; the delegated handler in
  // 12-tooltip.ts picks them up automatically — no per-render wiring needed.

  // NOTE: the "+ Add stream / + Add stage" buttons live in index.html (they
  // persist across renders), so they're wired ONCE from 17-events.js at
  // startup. The two category add buttons are rendered per-call inside
  // renderCategoriesList and wired there on the fresh DOM (one listener each).
}

// ───── Stages ──────────────────────────────────────────────────────────
export function renderStagesList(): void {
  const container = document.getElementById("stages-list");
  if (!container) return;

  if (STAGES.length === 0) {
    container.innerHTML = '<div class="sidebar-empty">No columns yet. Click "+ Add column" to create one.</div>';
    return;
  }

  let html = "";
  for (let i = 0; i < STAGES.length; i++) {
    const stage = STAGES[i];
    const count = stageNodeCount[stage.id] || 0;
    const isHidden = state.hiddenStages.has(stage.id);
    const editingGuidance = state.uiMode === "edit" ? " Click the name to rename." : "";
    const tip = (isHidden ? "Click to show " : "Click to hide ") + stage.label + " — " + count + " box" + (count === 1 ? "" : "es") + " on the map." + editingGuidance;
    // No colour on a column, so no dot and no slot held open for one: these
    // names sit flush on the same left edge as the eyebrow above them.
    html += editRowHtml({
      kind: "stage", id: stage.id, index: i, label: stage.label, tip: tip,
      count: count, disabled: isHidden, deleteTitle: "Delete column",
    });
  }
  html += '<div class="sidebar-drop-end" data-kind="stage" data-target-index="' + STAGES.length + '"></div>';
  container.innerHTML = html;

  wireRowHandlers(container, "stage");
}

// ───── Streams ─────────────────────────────────────────────────────────
export function renderStreamsList(): void {
  const container = document.getElementById("stream-filters");
  if (!container) return;

  if (STREAMS.length === 0) {
    container.innerHTML = '<div class="sidebar-empty">No rows yet. Click "+ Add row" to create one.</div>';
    return;
  }

  let html = "";
  for (let i = 0; i < STREAMS.length; i++) {
    const stream = STREAMS[i];
    const isHidden = state.hiddenStreams.has(stream.id);
    const count = streamNodeCount[stream.id] || 0;
    const short = stream.short || (typeof deriveShortLabel === "function" ? deriveShortLabel(stream.label) : "");

    const editingGuidance = state.uiMode === "edit" ? " Click the name to rename." : "";
    const tip = (isHidden ? "Click to show " : "Click to hide ") + stream.label + " — " + count + " box" + (count === 1 ? "" : "es") + " on the map." + editingGuidance;
    html += editRowHtml({
      kind: "stream", id: stream.id, index: i, label: stream.label, tip: tip,
      color: stream.color, short: short, count: count,
      disabled: isHidden, deleteTitle: "Delete row",
    });
  }
  html += '<div class="sidebar-drop-end" data-kind="stream" data-target-index="' + STREAMS.length + '"></div>';
  container.innerHTML = html;
  wireRowHandlers(container, "stream");
}

// ───── Categories ──────────────────────────────────────────────────────
// Rendered as two class-grouped sections — Primary (fill) and Secondary
// (chips) — each with its own heading, count and "+ Add" button. Categories
// are stored in an insertion-order-preserving object; reorderCategories
// rebuilds it to commit a new order, so each row's data-index stays its
// position in that global order (drag-reorder operates on it regardless of
// which group the row is shown in).
export function renderCategoriesList(): void {
  const container = document.getElementById("category-filters");
  if (!container) return;
  const allIds = Object.keys(CATEGORIES);

  // Per-id global index (the order reorderCategories works against).
  const indexOf: Record<string, number> = {};
  allIds.forEach((id, i) => { indexOf[id] = i; });

  const catRow = (catId: string): string => {
    const cat = CATEGORIES[catId];
    const isHidden = state.hiddenCategories.has(catId);
    const count = categoryNodeCount[catId] || 0;
    const isSecondary = (cat.class || "primary") === "secondary";
    // The button used to spell out "→ corner tag" in the row. Two problems: it
    // repeated what the section heading directly above it already said, and at
    // ~72px it held that width open even at opacity 0 — which is why tag names
    // truncated to "Economic Out…" in a 280px drawer. One glyph in a fixed
    // slot, with the whole sentence in the tooltip.
    const reclassTitle = isSecondary
      ? "Move to Fill tag — fills the box; several blend into a gradient"
      : "Move to Corner tag — a small mark in the box's corner";
    // Category filters hide the COLOUR, not the box (see isNodeVisible in
    // 10-filters.js) — say so, or the count reads as "boxes this removes".
    const boxes = count + " box" + (count === 1 ? "" : "es");
    const kind = isSecondary ? "corner tag" : "fill tag";
    const tip = isHidden
      ? "Click to show " + cat.label + " again on the " + boxes + " carrying it. Click the name to rename."
      : "Click to take the " + cat.label + " colour off the " + boxes + " carrying it — a box leaves the map only if it has no other " + kind + " left. Click the name to rename.";
    return editRowHtml({
      kind: "category", id: catId, index: indexOf[catId], label: cat.label, tip: tip,
      color: cat.color, count: count, disabled: isHidden, deleteTitle: "Delete category",
      extra: '<button class="sidebar-cat-reclass" data-action="reclass" data-tooltip="' +
        escapeHtml(reclassTitle) + '" aria-label="' + escapeHtml(reclassTitle) + '">⇄</button>',
    });
  };

  // Reading the map, a tag is a chip in its own colour — the key to what the
  // boxes are painted with. Editing it, the same tag is a row, because renaming,
  // recolouring, reordering and deleting all need somewhere to put a control.
  const catChip = (catId: string): string => {
    const cat = CATEGORIES[catId];
    const isHidden = state.hiddenCategories.has(catId);
    const count = categoryNodeCount[catId] || 0;
    const boxes = count + " box" + (count === 1 ? "" : "es");
    const kind = (cat.class || "primary") === "secondary" ? "corner tag" : "fill tag";
    const tip = isHidden
      ? "Click to show " + cat.label + " again on the " + boxes + " carrying it."
      : "Click to take the " + cat.label + " colour off the " + boxes + " carrying it — a box leaves the map only if it has no other " + kind + " left.";
    return filterChipHtml('data-kind="category" data-id="' + escapeHtml(catId) + '"',
      cat.label, cat.color, count, isHidden, tip);
  };

  const editing = state.uiMode === "edit";

  const group = (title: string, classKey: string, ids: string[], addLabel: string): string => {
    // The "+" rides on the eyebrow, like the Columns and Rows sections. Its
    // aria-label still spells the action out — the glyph alone is only legible
    // because the label it sits on says which list it adds to.
    const add = editing
      ? '<button class="sidebar-add-btn sidebar-cat-add" data-cat-class="' + classKey + '"' +
        ' data-tooltip="' + escapeHtml(addLabel.replace(/^\+ /, "")) + '"' +
        ' aria-label="' + escapeHtml(addLabel.replace(/^\+ /, "")) + '">+</button>'
      : "";
    let h = sectionTitleHtml(title, add);
    const emptyText = 'No ' + title.toLowerCase() + ' categories yet. Use "+" to create one.';
    if (!ids.length) {
      h += '<div class="sidebar-empty">' + emptyText + '</div>';
    } else if (editing) {
      h += ids.map(catRow).join("");
    } else {
      h += '<div class="filter-chips">' + ids.map(catChip).join("") + '</div>';
    }
    return h;
  };

  const split = splitCategoriesByClass(allIds);
  let html = "";
  html += group("Fill tag",  "primary",   split.primary,   "+ Add fill tag");
  html += '<div class="sidebar-cat-group-gap"></div>';
  html += group("Corner tag",   "secondary", split.secondary, "+ Add corner tag");
  html += '<div class="sidebar-drop-end" data-kind="category" data-target-index="' + allIds.length + '"></div>';
  container.innerHTML = html;

  wireRowHandlers(container, "category");
  // The chips carry no drag handle or delete, so they want the toggle alone.
  container.querySelectorAll('.filter-chip[data-kind="category"]').forEach(chip => {
    chip.addEventListener("click", () => toggleCategory(chip.getAttribute("data-id")!));
  });
  // The "+ Add" buttons are re-rendered each call, so wiring them here (on the
  // fresh DOM) attaches exactly one listener — no stacking. (The static stream/
  // stage add buttons are still wired once in 17-events.js.)
  container.querySelectorAll("[data-cat-class]").forEach(btn => {
    btn.addEventListener("click", () => {
      if (typeof addCategory === "function") addCategory(btn.getAttribute("data-cat-class"));
    });
  });
}

// ───── Edge-type / line-style / trace filters ───────────────────────────
// Three click-to-toggle filter groups using the same toggle+dim model as the
// Stream / Category filters: click a row to hide that edge effect or line
// style on the map (or to suppress a direction of the causal trace), click
// again to restore it. Each renders into its own container in index.html.
// The colour each link effect paints on the map, so the legend can show it as a
// dot in the same slot the row / tag lists put their colour well.
export const EDGE_TYPE_FILTERS = [
  { id: "enables",   label: "Enables / supports", color: "var(--edge-enables)"   },
  { id: "increases", label: "Increases",          color: "var(--edge-increases)" },
  { id: "decreases", label: "Decreases",          color: "var(--edge-decreases)" },
];
export const TRACE_FILTERS = [
  { id: "ancestors",   label: "Driven by", varName: "--edge-ancestor"   },
  { id: "descendants", label: "Drives",    varName: "--edge-descendant" },
];
export const LINE_STYLE_FILTERS = [
  { id: "solid",  label: "Solid",  swatchClass: "legend-line-solid"  },
  { id: "dashed", label: "Dashed", swatchClass: "legend-line-dashed" },
];

// One descriptor per filter group: where it renders, its items, the hidden-set
// it reads, how to draw each item's swatch, and how to count its edges (null =
// no count, for the trace group). renderLegendFilters loops over these so the
// three groups share one render path.
export const LEGEND_FILTER_GROUPS: LegendFilterGroup[] = [
  { kind: "effect", containerId: "edge-type-filters",  title: "Link types", ctx: "links on the map",
    items: EDGE_TYPE_FILTERS,  hiddenSet: () => state.hiddenEffects,
    swatch: f => '<span class="sidebar-dot sidebar-dot--static" style="background:' + f.color + '"></span>',
    chipColor: f => f.color || "",
    count:  (f, counts) => counts.effects[f.id] || 0 },
  { kind: "style", containerId: "edge-style-filters", title: "Line style", ctx: "links on the map",
    items: LINE_STYLE_FILTERS, hiddenSet: () => state.hiddenStyles,
    swatch: f => '<span class="legend-line ' + f.swatchClass + '"></span>',
    count:  () => null },
  { kind: "trace", containerId: "trace-filters", title: "Highlighting", ctx: "when a box is selected",
    items: TRACE_FILTERS, hiddenSet: () => state.hiddenTrace,
    swatch: f => '<span class="sidebar-dot sidebar-dot--static" style="background:var(' + f.varName + ')"></span>',
    chipColor: f => 'var(' + f.varName + ')',
    count:  () => null },
];

interface FilterItem {
  id: string;
  label: string;
  color?: string;
  varName?: string;
  swatchClass?: string;
}

interface EdgeFilterCounts {
  effects: Record<string, number>;
  styles: { solid: number; dashed: number };
}

interface LegendFilterGroup {
  kind: string;
  containerId: string;
  title: string;
  ctx: string;
  items: FilterItem[];
  hiddenSet: () => Set<string>;
  swatch: (f: FilterItem, count?: number | null) => string;
  chipColor?: (f: FilterItem) => string;
  count: (f: FilterItem, counts: EdgeFilterCounts) => number | null;
}

// Every edge count the filters need, in one pass over EDGES (instead of a
// separate scan per row).
export function edgeFilterCounts(): EdgeFilterCounts {
  const effects: Record<string, number> = {}, styles = { solid: 0, dashed: 0 };
  for (const e of EDGES) {
    effects[e.effect] = (effects[e.effect] || 0) + 1;
    styles[(e.style || "solid") === "dashed" ? "dashed" : "solid"]++;
  }
  return { effects, styles };
}

// One filter row. `count` is omitted (null) for trace rows, which aren't counts.
// A legend row in edit mode. Same shape as an editable row minus the parts a
// legend has no use for: these three groups are fixed lists, so there is nothing
// to add, reorder or delete. `mark` is the group's own leading glyph — a colour
// dot for link types, a line sample for line style, a ring for highlighting —
// and it sits where the colour dot sits on the lists above, so all four groups
// share one left edge for their names.
export function legendFilterRow(kind: string, id: string, mark: string, label: string, count: number | null, isOff: boolean, tip: string): string {
  return '<div class="legend-filter-row filter-row ' + (isOff ? "disabled" : "") + '" data-legend-kind="' + kind + '" data-legend-id="' + escapeHtml(id) + '" data-tooltip="' + escapeHtml(tip) + '">' +
    mark +
    '<div class="filter-label">' + escapeHtml(label) + '</div>' +
    (count != null ? '<span class="sidebar-count">' + count + '</span>' : '') +
    '</div>';
}

// An eyebrow, and only that. It used to carry a "shown / total" count, which is
// a number about the FILTER rather than about the map — and every row under it
// already carries the count that matters, of boxes or links. Two counts a
// centimetre apart, meaning different things, is worse than one.
export function sectionTitleHtml(label: string, addHtml?: string): string {
  return '<div class="sidebar-section-title"><span>' + label + '</span>' + (addHtml || "") + '</div>';
}

// One filter, as a chip: the colour it paints on the map, its name, and how
// many things carry it. A wrap of these IS the map's key, which is what this
// part of the drawer has always been — a column of rows only ever spelled it
// out one item per line.
export function filterChipHtml(
  attrs: string, label: string, color: string | null, count: number | null,
  isOff: boolean, tip: string,
): string {
  return '<button type="button" class="filter-chip' + (isOff ? " off" : "") + '" ' + attrs +
    ' data-tooltip="' + escapeHtml(tip) + '" aria-pressed="' + (!isOff) + '">' +
    (color ? '<i style="background:' + escapeHtml(color) + '"></i>' : '<i class="plain"></i>') +
    '<span class="filter-chip-label">' + escapeHtml(label) + '</span>' +
    (count != null ? '<b>' + count + '</b>' : '') +
    '</button>';
}

// Render all three filter groups (edge types / line style / trace) from
// LEGEND_FILTER_GROUPS — one render path, counts computed once.
export function renderLegendFilters(): void {
  const counts = edgeFilterCounts();
  for (const g of LEGEND_FILTER_GROUPS) {
    const c = document.getElementById(g.containerId);
    if (!c) continue;
    // Each group's hidden-set is a state Set initialised in 03-state.js. Fall
    // back to an empty Set so a render can never throw on `.has(...)` if one is
    // ever missing (e.g. a state-restore race or a partially-loaded state) —
    // the row simply renders as "not hidden" rather than crashing the sidebar.
    const hidden = g.hiddenSet() || new Set<string>();
    let html = sectionTitleHtml(g.title);
    // Reading the map, these are a legend: a wrap of chips. Editing it, they
    // stay rows, because a row is what carries a drag handle and a delete.
    const asChips = state.uiMode !== "edit";
    if (asChips) html += '<div class="filter-chips">';
    for (const f of g.items) {
      const isOff = hidden.has(f.id);
      const cnt = g.count(f, counts);
      const tip = "Click to " + (isOff ? "show " : "hide ") + f.label.toLowerCase() + " " + g.ctx + ".";
      if (asChips) {
        html += filterChipHtml(
          'data-legend-kind="' + g.kind + '" data-legend-id="' + escapeHtml(f.id) + '"',
          f.label, g.chipColor ? g.chipColor(f) : null, cnt, isOff, tip);
      } else {
        html += legendFilterRow(g.kind, f.id, g.swatch(f), f.label, cnt, isOff, tip);
      }
    }
    if (asChips) html += '</div>';
    c.innerHTML = html;
    wireLegendFilters(c);
  }
}

// Wire each filter row to its toggle. Re-rendered each call on fresh DOM, so
// exactly one listener per row (no stacking).
export function wireLegendFilters(container: HTMLElement): void {
  // Rows in edit mode, chips in reading mode — the handler keys on the data
  // attribute both carry rather than on either one's class.
  container.querySelectorAll("[data-legend-id]").forEach(row => {
    row.addEventListener("click", () => {
      const kind = row.getAttribute("data-legend-kind");
      const id   = row.getAttribute("data-legend-id")!;
      if      (kind === "effect" && typeof toggleEffect === "function") toggleEffect(id);
      else if (kind === "style"  && typeof toggleStyle  === "function") toggleStyle(id);
      else if (kind === "trace"  && typeof toggleTrace  === "function") toggleTrace(id);
    });
  });
}

// One editable row, in one shape: an optional colour dot, the name, whatever
// small marks that list carries, the count, and the delete.
//
// Three things about it are deliberate.
//
// 1. The colour and the count are SEPARATE. They used to be one 30x18 pill:
//    the count printed on top of the colour input. That badge answered "how
//    many?" in a colour that changed as you recoloured it, and nothing about it
//    said "click me to recolour". A 9px dot is the well; the count is mono
//    beside it. Same split the reading-mode chips already use.
//
// 2. A list with no colour gets NO dot slot — its names sit flush against the
//    same left edge as the eyebrow above them. An empty ring in the slot reads
//    as an unchecked checkbox (the trap .sidebar-stage-mark was written for),
//    and an invisible spacer just pushes the names off the edge everything else
//    lines up on.
//
// 3. There is no drag grip. The whole row has always been the drag target; the
//    grip was only ever a hint, and it was competing for the slot the delete
//    needs. The delete is always on show — at a 24px row pitch, hunting for a
//    control that only appears under the pointer is worse than the small amount
//    of furniture it costs.
export function editRowHtml(opts: {
  kind: string; id: string; index: number; label: string; tip: string;
  color?: string | null; count?: number | null; short?: string | null;
  extra?: string; disabled?: boolean; deleteTitle?: string | null;
}): string {
  const filterActionTooltip = (opts.disabled ? "Click to show " : "Click to hide ") + opts.label;
  const labelTooltip = state.uiMode === "edit" ? "Click to rename" : filterActionTooltip;
  const shortLabelTooltip = state.uiMode === "edit" ? "Click to edit the short label" : filterActionTooltip;
  let h = '<div class="sidebar-edit-row filter-row' + (opts.disabled ? " disabled" : "") + '"' +
    ' data-kind="' + escapeHtml(opts.kind) + '" data-id="' + escapeHtml(opts.id) + '"' +
    ' data-index="' + opts.index + '" data-tooltip="' + escapeHtml(opts.tip) + '" draggable="true">';
  if (opts.color) {
    h += '<input type="color" class="sidebar-dot" data-field="color" value="' + escapeHtml(opts.color) +
      '" data-tooltip="Colour" aria-label="Colour">';
  }
  h += '<span class="filter-label sidebar-inline-edit" data-field="label"' +
    ' data-tooltip="' + escapeHtml(labelTooltip) + '">' + escapeHtml(opts.label) + '</span>';
  if (opts.short != null) {
    h += '<span class="sidebar-short-chip sidebar-inline-edit" data-field="short"' +
      ' data-tooltip="' + escapeHtml(shortLabelTooltip) + '">' + escapeHtml(opts.short) + '</span>';
  }
  h += opts.extra || "";
  if (opts.count != null) h += '<span class="sidebar-count">' + opts.count + '</span>';
  if (opts.deleteTitle) h += deleteIconButton(opts.deleteTitle);
  h += '</div>';
  return h;
}

// Small inline trash-icon delete button shared by every sidebar row.
// data-action="delete" hooks into the cascade-delete wiring in wireRowHandlers.
export function deleteIconButton(title: string): string {
  return '<button class="sidebar-row-delete" data-action="delete" data-tooltip="' + escapeHtml(title) + '" aria-label="' + escapeHtml(title) + '">' +
    '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">' +
    '<path fill="currentColor" d="M6.5 1.5h3a1 1 0 0 1 1 1V3h2.5a.5.5 0 0 1 0 1h-.54l-.7 9.06A1.5 1.5 0 0 1 10.27 14.5H5.73a1.5 1.5 0 0 1-1.49-1.44L3.54 4H3a.5.5 0 0 1 0-1h2.5v-.5a1 1 0 0 1 1-1Zm-1.95 2.5.69 8.98a.5.5 0 0 0 .49.52h4.54a.5.5 0 0 0 .49-.52L11.45 4H4.55ZM6.5 3h3v-.5h-3V3Zm.25 2.75a.5.5 0 0 1 .5.5v5a.5.5 0 0 1-1 0v-5a.5.5 0 0 1 .5-.5Zm2.5 0a.5.5 0 0 1 .5.5v5a.5.5 0 0 1-1 0v-5a.5.5 0 0 1 .5-.5Z"/>' +
    '</svg></button>';
}

// Turn an inline-editable element into a text editor: make it contenteditable,
// select its text, and commit on Enter / blur (Escape cancels). The `field`
// ("label" or "short") routes the committed value through applySidebarFieldEdit.
// We disable the row's drag while editing so the cursor can be placed with the
// mouse, then renderSidebar() rebuilds a clean row on commit.
// Let the user rename a sidebar row by typing directly on its text. We turn the
// label into an editable element ("contenteditable" — a browser feature that
// makes any element typeable in place; see docs/GLOSSARY.md), then commit or
// discard the change on blur / Enter / Escape. The `finished` flag below is a
// guard: blur and keydown can both try to end the edit, and without it we'd run
// the save-and-rebuild twice — `finished` makes sure `finish()` only runs once.
export function beginInlineEdit(el: HTMLElement | null, row: HTMLElement | null, kind: string, id: string, field: string): void {
  // Reading mode never renames. Editing mode needs no modifier: a plain click
  // on the name edits it, and the name carries a visible field affordance at
  // rest so it reads as one. Shift used to be required here, which meant the
  // drawer's central action was invisible unless you already knew about it.
  if (state.uiMode !== "edit") return;
  if (!el || el.getAttribute("contenteditable") === "true") return;
  const original = el.textContent;
  el.setAttribute("contenteditable", "true");
  el.classList.add("editing");
  if (row) row.setAttribute("draggable", "false");
  el.focus();

  // Select the whole text so typing replaces it.
  const sel = window.getSelection();
  if (sel) {
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  let finished = false;
  const finish = (save: boolean): void => {
    if (finished) return;
    finished = true;
    el.removeAttribute("contenteditable");
    el.classList.remove("editing");
    const newText = (el.textContent || "").trim();
    if (save && newText && newText !== original) {
      applySidebarFieldEdit(kind, id, field, { value: newText });
    }
    renderSidebar(); // rebuild the row in its clean, non-editing state
  };

  el.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      el.textContent = original;
      finish(false);
    }
  });
  el.addEventListener("blur", () => finish(true));
}

// Begin inline rename on a freshly-added row (e.g. just after "+ Add stream"),
// once renderSidebar has painted it.
export function focusSidebarInlineLabel(kind: string, id: string): void {
  setTimeout(() => {
    const row = document.querySelector(".sidebar-edit-row[data-kind='" + kind + "'][data-id='" + CSS.escape(id) + "']");
    const labelEl = row && row.querySelector(".sidebar-inline-edit[data-field='label']");
    if (labelEl) beginInlineEdit(labelEl as HTMLElement, row as HTMLElement, kind, id, "label");
  }, 0);
}

// ───── Per-row wiring (inline edit / colour / delete / filter / drag) ─────
export function wireRowHandlers(container: HTMLElement, kind: string): void {
  const isFilter = (kind === "stream" || kind === "category" || kind === "stage");

  container.querySelectorAll(".sidebar-edit-row").forEach(row => {
    const id = row.getAttribute("data-id")!;

    const toggle = (): void => {
      if (kind === "stream")   toggleStream(id);
      if (kind === "category") toggleCategory(id);
      if (kind === "stage")    toggleStage(id);
    };

    // Inline colour swatch commits on change.
    row.querySelectorAll("input[data-field]").forEach(input => {
      input.addEventListener("change", () => {
        applySidebarFieldEdit(kind, id, (input as HTMLElement).getAttribute("data-field")!, input as HTMLInputElement);
      });
    });

    // Delete (cascade with confirm + undo for all three kinds).
    const delBtn = row.querySelector("[data-action='delete']");
    if (delBtn) {
      delBtn.addEventListener("click", event => {
        event.stopPropagation();
        if (kind === "stream"   && typeof deleteStreamWithCascade   === "function") deleteStreamWithCascade(id);
        if (kind === "stage"    && typeof deleteStageWithCascade    === "function") deleteStageWithCascade(id);
        if (kind === "category" && typeof deleteCategoryWithCascade === "function") deleteCategoryWithCascade(id);
      });
    }

    // Reclassify (categories only): flip Primary ↔ Secondary, then re-render
    // the sidebar so the row jumps to the other group. Re-splitting every
    // node's categories happens inside applySidebarFieldEdit.
    const reclassBtn = row.querySelector("[data-action='reclass']");
    if (reclassBtn && kind === "category") {
      reclassBtn.addEventListener("click", event => {
        event.stopPropagation();
        reclassifyCategory(id);
      });
    }

    // Filter toggle — clicking the row body (anything that isn't an interactive
    // control) hides/shows that stream / category on the map. Stages don't
    // filter.
    if (isFilter) {
      row.addEventListener("click", event => {
        // The controls that live INSIDE a row do their own thing; a click on one
        // of them must not also flip the row's filter. (.sidebar-dot is the
        // colour well — it replaced .sidebar-edit-color, and the drag grip it
        // used to sit beside is gone: the row itself is the drag target.)
        if ((event.target as HTMLElement).closest(".sidebar-dot, .sidebar-row-delete, .sidebar-cat-reclass")) return;
        // Editing: the name is a field, so a click there types rather than
        // filters. Reading: it is just part of the row and toggles like the rest.
        if (state.uiMode === "edit" && (event.target as HTMLElement).closest(".sidebar-inline-edit")) return;
        toggle();
      });
    }

    // Inline text editing. While editing the map, clicking a name edits it —
    // no modifier. The name is the one part of the row that is NOT the filter
    // toggle (see the guard above), which is the trade: in edit mode the row's
    // main click target is renaming, and the filter is still a click away on
    // the dot, the count or the space between them.
    //
    // While reading, these clicks fall through to the toggle as before —
    // beginInlineEdit returns immediately outside edit mode.
    row.querySelectorAll(".sidebar-inline-edit").forEach(el => {
      const field = el.getAttribute("data-field")!;
      el.addEventListener("click", event => {
        if (state.uiMode !== "edit") return;   // reading: bubble → toggle
        event.preventDefault();
        event.stopPropagation();
        beginInlineEdit(el as HTMLElement, row as HTMLElement, kind, id, field);
      });
    });
  });

  // Drag-to-reorder, using the browser's built-in drag-and-drop. Each row can be
  // picked up and dropped onto another row to change the order. One wrinkle:
  // dropping a row *onto* another row means "insert before this one", so there's
  // no row that means "put it last". We solve that with a "sentinel" — an
  // invisible placeholder element (`.sidebar-drop-end`) parked after the final
  // row purely as a drop target for "move to the end" — a "sentinel" is just a
  // dummy marker that exists only to be detected. Visual feedback via
  // .drop-target.
  let draggedIndex: number | null = null;
  container.querySelectorAll(".sidebar-edit-row[draggable='true']").forEach(row => {
    row.addEventListener("dragstart", event => {
      draggedIndex = parseInt(row.getAttribute("data-index")!, 10);
      row.classList.add("dragging");
      // Force the drag image to be the row itself (Firefox is picky).
      if ((event as DragEvent).dataTransfer) {
        (event as DragEvent).dataTransfer!.effectAllowed = "move";
        (event as DragEvent).dataTransfer!.setData("text/plain", row.getAttribute("data-id") || "");
      }
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      container.querySelectorAll(".drop-target").forEach(el => el.classList.remove("drop-target"));
      draggedIndex = null;
    });
  });

  // Each row + the sentinel can accept a drop. Computing the insertion
  // index from the targeted element keeps this simple.
  const targets = container.querySelectorAll(".sidebar-edit-row, .sidebar-drop-end");
  targets.forEach(target => {
    target.addEventListener("dragover", event => {
      if (draggedIndex === null) return;
      event.preventDefault();
      targets.forEach(el => el.classList.remove("drop-target"));
      target.classList.add("drop-target");
    });
    target.addEventListener("dragleave", () => {
      target.classList.remove("drop-target");
    });
    target.addEventListener("drop", event => {
      event.preventDefault();
      target.classList.remove("drop-target");
      if (draggedIndex === null) return;
      let targetIndex: number;
      if (target.classList.contains("sidebar-drop-end")) {
        targetIndex = parseInt(target.getAttribute("data-target-index")!, 10);
      } else {
        targetIndex = parseInt(target.getAttribute("data-index")!, 10);
      }
      if (kind === "stream"   && typeof reorderStreams    === "function") reorderStreams(draggedIndex, targetIndex);
      if (kind === "stage"    && typeof reorderStages     === "function") reorderStages(draggedIndex, targetIndex);
      if (kind === "category" && typeof reorderCategories === "function") reorderCategories(draggedIndex, targetIndex);
    });
  });
}

// ───── Field writes ────────────────────────────────────────────────────
export function applySidebarFieldEdit(kind: string, id: string, field: string, input: { value: string }): void {
  if (kind === "stream") {
    const stream = streamById[id];
    if (!stream) return;
    if (field === "label") {
      const newLabel = String(input.value || "").trim() || stream.label;
      stream.label = newLabel;
      // Auto-derive a short label only when the previous one matches the
      // auto-derived form (i.e. user hasn't customised it). Otherwise the
      // separate short-label chip wins.
      if (typeof deriveShortLabel === "function") {
        const auto = deriveShortLabel(stream.label);
        if (!stream.short || stream.short === auto) stream.short = auto;
      }
    } else if (field === "short") {
      stream.short = String(input.value || "").trim().slice(0, 6) || (typeof deriveShortLabel === "function" ? deriveShortLabel(stream.label) : stream.label.slice(0, 6));
    } else if (field === "color") {
      stream.color = input.value;
    }
  } else if (kind === "stage") {
    const stage = stageById[id];
    if (!stage) return;
    if (field === "label") {
      const newLabel = String(input.value || "").trim() || stage.label;
      stage.label = newLabel;
      const inArray = STAGES.find(s => s.id === id);
      if (inArray) inArray.label = newLabel;
    }
  } else if (kind === "category") {
    const cat = CATEGORIES[id];
    if (!cat) return;
    if (field === "label") {
      const newLabel = String(input.value || "").trim() || cat.label;
      cat.label = newLabel;
    } else if (field === "color") {
      cat.color = input.value;
      // Label colour is no longer hand-picked — derive black/white for max
      // contrast against the new fill so node labels stay readable.
      if (typeof pickTextColor === "function") cat.textColor = pickTextColor(cat.color);
    }
  }
  // Editing inline keeps the row in place; skip the sidebar re-render so an
  // in-progress edit isn't torn down (callers that need a rebuild — e.g. the
  // inline-edit commit — call renderSidebar themselves afterwards).
  if (typeof applyCanvasMutation === "function") applyCanvasMutation({ skipDetailRender: true, skipSidebarRender: true });
}

// Flip a category between Primary (fill) and Secondary (chip), then re-split
// every node's category membership by the new classes. A structural mutation
// (not a field edit), invoked by the sidebar reclassify button — re-renders the
// sidebar so the row jumps to the other group.
export function reclassifyCategory(catId: string): void {
  const cat = CATEGORIES[catId];
  if (!cat) return;
  cat.class = (cat.class || "primary") === "secondary" ? "primary" : "secondary";
  for (const n of NODES) {
    const ids = nodeCategoryIds(n).filter(cid => CATEGORIES[cid]);
    const split = splitCategoriesByClass(ids);
    n.categoryIds = ids;
    n.primaryCategories = split.primary;
    n.secondaryCategories = split.secondary;
    n.category = n.primaryCategories[0] || ids[0] || n.category;
  }
  if (typeof applyCanvasMutation === "function") applyCanvasMutation({ skipDetailRender: true, skipSidebarRender: true });
  renderSidebar();
}
