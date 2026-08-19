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
  const countEl   = document.getElementById("stages-count");
  if (!container) return;
  if (countEl) countEl.textContent = STAGES.filter(s => !state.hiddenStages.has(s.id)).length + " / " + STAGES.length;

  if (STAGES.length === 0) {
    container.innerHTML = '<div class="sidebar-empty">No columns yet. Click "+ Add column" to create one.</div>';
    return;
  }

  let html = "";
  for (let i = 0; i < STAGES.length; i++) {
    const stage = STAGES[i];
    const count = stageNodeCount[stage.id] || 0;
    const isHidden = state.hiddenStages.has(stage.id);
    const tip = (isHidden ? "Click to show " : "Click to hide ") + stage.label + " — " + count + " box" + (count === 1 ? "" : "es") + " on the map. Shift-click the name to rename.";
    html += '<div class="sidebar-edit-row filter-row ' + (isHidden ? "disabled" : "") + '" data-kind="stage" data-id="' + escapeHtml(stage.id) + '" data-index="' + i + '" data-tooltip="' + escapeHtml(tip) + '" draggable="true">';
    html +=   '<span class="sidebar-edit-label sidebar-inline-edit" data-field="label" data-tooltip="Shift-click to rename">' + escapeHtml(stage.label) + '</span>';
    html +=   '<span class="count-swatch count-swatch--plain">' + count + '</span>';
    html +=   dragHandleButton("Drag to reorder");
    html +=   deleteIconButton("Delete column");
    html += '</div>';
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
    const visEl = document.getElementById("visible-streams-count");
    if (visEl) visEl.textContent = "0 / 0";
    return;
  }

  let html = "";
  for (let i = 0; i < STREAMS.length; i++) {
    const stream = STREAMS[i];
    const isHidden = state.hiddenStreams.has(stream.id);
    const count = streamNodeCount[stream.id] || 0;
    const short = stream.short || (typeof deriveShortLabel === "function" ? deriveShortLabel(stream.label) : "");

    const tip = (isHidden ? "Click to show " : "Click to hide ") + stream.label + " — " + count + " box" + (count === 1 ? "" : "es") + " on the map. Shift-click the name to rename.";
    html += '<div class="sidebar-edit-row filter-row ' + (isHidden ? "disabled" : "") + '" data-kind="stream" data-id="' + escapeHtml(stream.id) + '" data-index="' + i + '" data-tooltip="' + escapeHtml(tip) + '" draggable="true">';
    html +=   '<div class="filter-label sidebar-inline-edit" data-field="label" data-tooltip="Shift-click to rename">' + escapeHtml(stream.label) + '</div>';
    html +=   '<span class="sidebar-short-chip sidebar-inline-edit" data-field="short" data-tooltip="Shift-click to edit the short label">' + escapeHtml(short) + '</span>';
    html +=   countSwatch(stream.color, count);
    html +=   dragHandleButton("Drag to reorder");
    html +=   deleteIconButton("Delete row");
    html += '</div>';
  }
  html += '<div class="sidebar-drop-end" data-kind="stream" data-target-index="' + STREAMS.length + '"></div>';
  container.innerHTML = html;

  const visEl = document.getElementById("visible-streams-count");
  if (visEl) visEl.textContent = (STREAMS.length - state.hiddenStreams.size) + " / " + STREAMS.length;

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
    const reclassLabel = isSecondary ? "→ fill tag" : "→ corner tag";
    const reclassTitle = isSecondary
      ? "Make this a Fill tag category (fills the box; several blend into a gradient)"
      : "Make this a Corner tag category (a corner tag)";
    // Category filters hide the COLOUR, not the box (see isNodeVisible in
    // 10-filters.js) — say so, or the count reads as "boxes this removes".
    const boxes = count + " box" + (count === 1 ? "" : "es");
    const kind = isSecondary ? "corner tag" : "fill tag";
    const tip = isHidden
      ? "Click to show " + cat.label + " again on the " + boxes + " carrying it. Shift-click the name to rename."
      : "Click to take the " + cat.label + " colour off the " + boxes + " carrying it — a box leaves the map only if it has no other " + kind + " left. Shift-click the name to rename.";
    let h = '<div class="sidebar-edit-row filter-row ' + (isHidden ? "disabled" : "") + '" data-kind="category" data-id="' + escapeHtml(catId) + '" data-index="' + indexOf[catId] + '" data-tooltip="' + escapeHtml(tip) + '" draggable="true">';
    h +=   '<div class="filter-label sidebar-inline-edit" data-field="label" data-tooltip="Shift-click to rename">' + escapeHtml(cat.label) + '</div>';
    h +=   '<button class="sidebar-cat-reclass" data-action="reclass" data-tooltip="' + escapeHtml(reclassTitle) + '">' + reclassLabel + '</button>';
    h +=   countSwatch(cat.color, count);
    h +=   dragHandleButton("Drag to reorder");
    h +=   deleteIconButton("Delete category");
    h += '</div>';
    return h;
  };

  const group = (title: string, classKey: string, ids: string[], addLabel: string): string => {
    const shown = ids.filter(id => !state.hiddenCategories.has(id)).length;
    let h = '<div class="sidebar-section-title"><span>' + title + '</span><span class="count">' + shown + ' / ' + ids.length + '</span></div>';
    const emptyText = 'No ' + title.toLowerCase() + ' categories yet. Click "' + addLabel + '" to create one.';
    h += ids.length ? ids.map(catRow).join("") : '<div class="sidebar-empty">' + emptyText + '</div>';
    h += '<button class="sidebar-add-btn sidebar-cat-add" data-cat-class="' + classKey + '">' + addLabel + '</button>';
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
export const EDGE_TYPE_FILTERS = [
  { id: "enables",   label: "Enables / supports" },
  { id: "increases", label: "Increases" },
  { id: "decreases", label: "Decreases" },
];
export const TRACE_FILTERS = [
  { id: "ancestors",   label: "Causes",  varName: "--edge-ancestor"   },
  { id: "descendants", label: "Effects", varName: "--edge-descendant" },
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
    swatch: (f, count) => edgeCountBadge(count),
    count:  (f, counts) => counts.effects[f.id] || 0,
    countInSwatch: true },
  { kind: "style", containerId: "edge-style-filters", title: "Line style", ctx: "links on the map",
    items: LINE_STYLE_FILTERS, hiddenSet: () => state.hiddenStyles,
    swatch: f => '<div class="legend-line ' + f.swatchClass + '"></div>',
    count:  () => null },
  { kind: "trace", containerId: "trace-filters", title: "Highlighting", ctx: "when a box is selected",
    items: TRACE_FILTERS, hiddenSet: () => state.hiddenTrace,
    swatch: f => '<div class="legend-swatch" style="box-shadow: inset 0 0 0 2px var(' + f.varName + '), 0 0 4px var(' + f.varName + ');"></div>',
    count:  () => null },
];

interface FilterItem {
  id: string;
  label: string;
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
  count: (f: FilterItem, counts: EdgeFilterCounts) => number | null;
  countInSwatch?: boolean;
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
export function legendFilterRow(kind: string, id: string, swatch: string, label: string, count: number | null, isOff: boolean, tip: string): string {
  return '<div class="legend-filter-row filter-row ' + (isOff ? "disabled" : "") + '" data-legend-kind="' + kind + '" data-legend-id="' + escapeHtml(id) + '" data-tooltip="' + escapeHtml(tip) + '">' +
    '<div class="filter-label">' + escapeHtml(label) + '</div>' +
    (count != null ? '<div class="filter-count">' + count + '</div>' : '') +
    swatch +
    '</div>';
}

export function sectionTitleHtml(label: string, shown: number, total: number): string {
  return '<div class="sidebar-section-title"><span>' + label + '</span><span class="count">' + shown + ' / ' + total + '</span></div>';
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
    const shown = g.items.filter(f => !hidden.has(f.id)).length;
    let html = sectionTitleHtml(g.title, shown, g.items.length);
    for (const f of g.items) {
      const isOff = hidden.has(f.id);
      const cnt = g.count(f, counts);
      const sw  = g.countInSwatch ? g.swatch(f, cnt) : g.swatch(f);
      html += legendFilterRow(g.kind, f.id, sw, f.label, g.countInSwatch ? null : cnt, isOff,
        "Click to " + (isOff ? "show " : "hide ") + f.label.toLowerCase() + " " + g.ctx + ".");
    }
    c.innerHTML = html;
    wireLegendFilters(c);
  }
}

// Wire each filter row to its toggle. Re-rendered each call on fresh DOM, so
// exactly one listener per row (no stacking).
export function wireLegendFilters(container: HTMLElement): void {
  container.querySelectorAll(".legend-filter-row").forEach(row => {
    row.addEventListener("click", () => {
      const kind = row.getAttribute("data-legend-kind");
      const id   = row.getAttribute("data-legend-id")!;
      if      (kind === "effect" && typeof toggleEffect === "function") toggleEffect(id);
      else if (kind === "style"  && typeof toggleStyle  === "function") toggleStyle(id);
      else if (kind === "trace"  && typeof toggleTrace  === "function") toggleTrace(id);
    });
  });
}

// Right-side colour box that doubles as the node-count badge: the colour input
// fills it (click to recolour), with the count on top in an auto-contrasting
// colour so it stays legible on any user-chosen fill.
export function countSwatch(color: string, count: number): string {
  const c = color || "#94a3b8";
  const tc = (typeof pickTextColor === "function") ? pickTextColor(c) : "#0a0e1a";
  return '<span class="count-swatch">' +
    '<input type="color" class="sidebar-edit-color" data-field="color" value="' + escapeHtml(c) + '" data-tooltip="Colour" aria-label="Colour">' +
    '<span class="count-num" style="color:' + tc + '">' + count + '</span>' +
    '</span>';
}

// Neutral count badge for the edge-type legend rows. The box is not an editable
// colour picker, so it matches the sidebar background like the other non-picker
// boxes — only the editable Category / Stream swatches carry colour.
export function edgeCountBadge(count: number | null | undefined): string {
  return '<span class="count-swatch count-swatch--plain">' + count + '</span>';
}

// Small inline trash-icon delete button shared by every sidebar row.
// data-action="delete" hooks into the cascade-delete wiring in wireRowHandlers.
export function deleteIconButton(title: string): string {
  return '<button class="sidebar-row-delete" data-action="delete" data-tooltip="' + escapeHtml(title) + '" aria-label="' + escapeHtml(title) + '">' +
    '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">' +
    '<path fill="currentColor" d="M6.5 1.5h3a1 1 0 0 1 1 1V3h2.5a.5.5 0 0 1 0 1h-.54l-.7 9.06A1.5 1.5 0 0 1 10.27 14.5H5.73a1.5 1.5 0 0 1-1.49-1.44L3.54 4H3a.5.5 0 0 1 0-1h2.5v-.5a1 1 0 0 1 1-1Zm-1.95 2.5.69 8.98a.5.5 0 0 0 .49.52h4.54a.5.5 0 0 0 .49-.52L11.45 4H4.55ZM6.5 3h3v-.5h-3V3Zm.25 2.75a.5.5 0 0 1 .5.5v5a.5.5 0 0 1-1 0v-5a.5.5 0 0 1 .5-.5Zm2.5 0a.5.5 0 0 1 .5.5v5a.5.5 0 0 1-1 0v-5a.5.5 0 0 1 .5-.5Z"/>' +
    '</svg></button>';
}

// Trailing drag grip — the default reorder affordance. The whole row is
// draggable, so this is a visual hint (not a separate drag trigger). It shares
// the trailing slot with the delete button; CSS shows the grip by default and
// swaps to the delete button while Shift is held.
export function dragHandleButton(title: string): string {
  return '<span class="sidebar-row-drag" data-tooltip="' + escapeHtml(title) + '" aria-hidden="true">' +
    '<svg viewBox="0 0 16 16" width="13" height="13" focusable="false">' +
    '<path fill="currentColor" d="M6 3.25a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm6.5 0a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0ZM6 8a1.25 1.25 0 1 1-2.5 0A1.25 1.25 0 0 1 6 8Zm6.5 0a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0ZM6 12.75a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm6.5 0a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Z"/>' +
    '</svg></span>';
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
  // Reading mode never renames. (Editing mode still asks for Shift, so the
  // panel stays click-to-filter in both.)
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
        if ((event as MouseEvent).shiftKey) return; // Shift is the edit key — never toggle while held
        if ((event.target as HTMLElement).closest(".sidebar-row-drag, .sidebar-edit-color, .sidebar-row-delete, .sidebar-cat-reclass")) return;
        toggle();
      });
    }

    // Inline text editing — Shift-click any editable element (the name, or a
    // stream's short-label chip) to edit it, mirroring the canvas where Shift is
    // the app-wide edit key. A plain click bubbles through to the filter toggle
    // (or is a no-op on stage rows, which don't filter), so no disambiguation
    // timer is needed.
    row.querySelectorAll(".sidebar-inline-edit").forEach(el => {
      const field = el.getAttribute("data-field")!;
      el.addEventListener("click", event => {
        if (!(event as MouseEvent).shiftKey) return; // plain click bubbles → toggle
        event.preventDefault();
        event.stopPropagation();     // don't also toggle the filter
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
