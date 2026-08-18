// =============================================================================
// BUILDER PANEL — state, validation, and small helpers
// -----------------------------------------------------------------------------
// One of four files that together implement the in-app Build / Edit wizard:
//
//   16a-builder-state.js   — this file: state seeding, validation, small
//                            helpers (row buttons, drag handle, table-empty,
//                            slugify), and apply/download.
//   16b-builder-render.js  — HTML output for the wizard overlay (header,
//                            footer, six step renderers).
//   16c-builder-editor.js  — the floating "expand this cell" editor that
//                            pops up when the user focuses a text/number
//                            field inside the wizard.
//   16d-builder-events.js  — event wiring: clicks, typing, focus, drag-drop.
//
// The wizard mutates `state.builder` (declared in 03-state.js), NOT the
// live STREAMS / STAGES / CATEGORIES / NODES / EDGES. Cancel discards.
// Apply serialises the builder state to CSV and feeds it through the same
// loadDataFromCsv() path drag-drop uses, so validation runs uniformly.
// =============================================================================

import type {
  BuilderSection,
  BuilderNode,
} from "./types";
import {
  state,
  STREAMS,
  STAGES,
  CATEGORIES,
  NODES,
  EDGES,
  PARAMS,
  DEFAULT_ELASTICITY_BY_EFFECT,
} from "./03-state";
import { SAMPLE_CSV } from "./01-sample-data";
import { EFFECT_OPTIONS, ELASTICITY_KEYS } from "./02-config";
import { escapeHtml, splitCategoriesByClass } from "./04-utils";
import { clearBuilderFromStorage } from "./04a-storage";
import { parseCsvDocument, parseNumericCell } from "./05-csv-parser";
import { serializeBuilderToCsv } from "./05a-csv-serializer";
import { loadDataFromCsv } from "./06-data-loader";
import { downloadCsvBlob, showLoadFeedback } from "./16-file-io";
import { renderBuilder } from "./16b-builder-render";
import { hideCellEditor } from "./16c-builder-editor";

// ───── Constants ──────────────────────────────────────────────────────────
export const BUILDER_STEPS: { num: number; key: string; label: string }[] = [
  { num: 1, key: "streams",    label: "Rows" },
  { num: 2, key: "stages",     label: "Columns" },
  { num: 3, key: "categories", label: "Categories" },
  { num: 4, key: "nodes",      label: "Boxes" },
  { num: 5, key: "edges",      label: "Links" },
  { num: 6, key: "review",     label: "Review" },
];

// EFFECT_OPTIONS, DIRECTION_OPTIONS, and STREAM_COLOR_PALETTE all live in
// 02-config.js so the wizard, the detail panel, the canvas edit module, and
// the CSV loader all share one source of truth.

// Sentinel string used to split each step's HTML output into a sticky-top
// section (heading + blurb + action bar) and a scroll-below section (the
// row table). See renderBuilder() in 16b-builder-render.js.
export const BUILDER_SPLIT = "<!--builder-split-->";

// ───── Open / close ───────────────────────────────────────────────────────
export function openBuilder(options?: { fromLoadedData?: boolean }): void {
  const fromLoadedData = options && options.fromLoadedData;

  if (fromLoadedData && state.dataLoaded) {
    seedBuilderFromLiveData();
  } else {
    seedBuilderEmpty();
  }
  state.builder.open = true;
  state.builder.step = 1;
  renderBuilder();
}

export function closeBuilder(): void {
  state.builder.open = false;
  clearBuilderSelection();
  hideCellEditor();
  clearBuilderFromStorage();
  const overlay = document.getElementById("builder-overlay");
  if (overlay) {
    overlay.classList.remove("open");
    overlay.innerHTML = "";
  }
}

// ───── Seed helpers ───────────────────────────────────────────────────────
export function seedBuilderEmpty(): void {
  state.builder.streams    = [];
  state.builder.stages     = [];
  state.builder.categories = [];
  state.builder.defaults   = { enables: 0.30, increases: 0.25, decreases: -0.25 };
  state.builder.nodes      = [];
  state.builder.edges      = [];
  // Explicitly empty (not undefined): a from-scratch build really does mean
  // "no calculation constants", whereas undefined tells the serializer to keep
  // the live map's params — see serializeBuilderToCsv in 05a-csv-serializer.js.
  state.builder.params     = [];
  state.builder.focusAfterRender = null;
  state.builder.sort = {};
  clearBuilderSelection();
}

export function seedBuilderFromLiveData(): void {
  // Deep-clone live state into the builder shape. CATEGORIES is a runtime
  // map keyed by id; convert it back to an array.
  state.builder.streams = STREAMS.map(s => ({
    id: s.id, label: s.label, short: s.short, color: s.color,
  }));
  state.builder.stages = STAGES.map(s => ({ id: s.id, label: s.label }));
  state.builder.categories = Object.keys(CATEGORIES).map(id => ({
    id: id,
    label: CATEGORIES[id].label,
    color: CATEGORIES[id].color,
    textColor: CATEGORIES[id].textColor,
    class: CATEGORIES[id].class || "primary",
  }));
  state.builder.defaults = {
    enables:   DEFAULT_ELASTICITY_BY_EFFECT.enables,
    increases: DEFAULT_ELASTICITY_BY_EFFECT.increases,
    decreases: DEFAULT_ELASTICITY_BY_EFFECT.decreases,
  };
  state.builder.nodes = NODES.map(n => ({
    id: n.id, label: n.label, description: n.description || "",
    stream: n.stream, stage: n.stage, category: n.category,
    // Preserve the full multi-category list so a wizard round-trip doesn't drop
    // extra primaries / secondary chips (the node table edits the primary
    // anchor; the detail panel does the full multi-select).
    categoryIds: (n.categoryIds && n.categoryIds.length) ? n.categoryIds.slice() : [n.category],
    baseline: n.baseline !== undefined ? n.baseline : "",
    unit: n.unit || "",
    controllable: !!n.controllable,
    direction: n.direction || "",
    sliderMax: n.sliderMax !== undefined ? n.sliderMax : "",
    // Carried through untouched — the wizard has no editor for the calculation
    // rules yet, and an apply must not quietly strip them off the map.
    combine: n.combine || "",
    formula: n.formula || "",
    minValue: n.minValue !== undefined ? n.minValue : "",
    maxValue: n.maxValue !== undefined ? n.maxValue : "",
  }));
  state.builder.edges = EDGES.map(e => ({
    from: e.from, to: e.to, effect: e.effect,
    elasticity: e.elasticity !== undefined ? e.elasticity : "",
    style: e.style === "dashed" ? "dashed" : "",
    description: e.description || "",
  }));
  // Same idea as the node calculation columns: no params step in the wizard
  // yet, so the live constants ride along and get written back out on apply.
  state.builder.params = PARAMS.map(p => ({ id: p.id, value: p.value, description: p.description }));
  state.builder.focusAfterRender = null;
  state.builder.sort = {};
  clearBuilderSelection();
}

// "Start from sample" button on step 1 — pre-fills streams/stages/categories
// (and the elasticity defaults) from the embedded sample CSV, so the user
// has a taxonomy to work with. Existing rows are replaced.
export function seedBuilderFromSample(): void {
  if (typeof SAMPLE_CSV === "undefined" || !SAMPLE_CSV) {
    showLoadFeedback("Sample CSV not available in this build.", true);
    return;
  }
  const sections = parseCsvDocument(SAMPLE_CSV);
  state.builder.sort = {};
  clearBuilderSelection();

  state.builder.streams = (sections.streams || []).map(row => ({
    id: row.id || "", label: row.label || "", short: row.short || "", color: row.color || "#94a3b8",
  })).filter(s => s.id);

  state.builder.stages = (sections.stages || []).map(row => ({
    id: row.id || "", label: row.label || "",
  })).filter(s => s.id);

  state.builder.categories = (sections.categories || []).map(row => ({
    id: row.id || "", label: row.label || "",
    color: row.color || "#a3a3a3", textColor: row.text_color || "#1c1917",
    class: (row.class || "").trim().toLowerCase() === "secondary" ? "secondary" : "primary",
  })).filter(c => c.id);

  // Pull defaults too if present.
  if (sections.defaults) {
    for (const row of sections.defaults) {
      const v = parseNumericCell(row.value);
      if (v === undefined) continue;
      if (row.key === ELASTICITY_KEYS.enables)   state.builder.defaults.enables   = v;
      if (row.key === ELASTICITY_KEYS.increases) state.builder.defaults.increases = v;
      if (row.key === ELASTICITY_KEYS.decreases) state.builder.defaults.decreases = v;
    }
  }
}

// ───── Small helpers ──────────────────────────────────────────────────────
export function slugify(text: string): string {
  return String(text || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// Build duplicate-id sets so the renderer can flag offending inputs.
export function findDuplicateIds(rows: { id?: string }[]): Set<string> {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const row of rows) {
    if (!row.id) continue;
    if (seen.has(row.id)) dupes.add(row.id);
    seen.add(row.id);
  }
  return dupes;
}

// The duplicate-and-delete buttons that appear at the end of every editable
// row, factored out because every step's table uses them identically.
export function rowActionsHtml(section: BuilderSection, i: number): string {
  return '<td><div class="builder-row-actions">' +
           '<button class="builder-row-action" data-duplicate="' + section + '" data-index="' + i + '" data-tooltip="Duplicate">⎘</button>' +
           '<button class="builder-row-action danger" data-delete="' + section + '" data-index="' + i + '" data-tooltip="Delete">×</button>' +
         '</div></td>';
}

// Drag handle shown at the START of a row in the ordered sections (streams,
// stages, categories). Dragging the row reorders the underlying
// state.builder array — see drag handlers in 16d-builder-events.js.
export function rowDragHandleHtml(): string {
  return '<td class="builder-row-drag" data-tooltip="Drag to reorder">⋮⋮</td>';
}

export function tableEmptyRow(colSpan: number, message: string): string {
  return '<tr class="builder-empty-row"><td colspan="' + colSpan + '">' + escapeHtml(message) + '</td></tr>';
}

// ───── View-only column sort (nodes / edges tables) ────────────────────────
// The big tables let you click a column header to group similar rows together.
// This only changes the DISPLAY order: rows keep their original array index as
// their data-index, so every index-based handler (input / delete / duplicate /
// selection / focus) stays correct, and the saved/exported CSV order is the
// untouched array order. Sort state lives in state.builder.sort and is reset on
// every (re)seed — see the seed helpers above.

// Compare two field values. Numbers compare numerically, everything else by
// locale string order. Blank/undefined handling is done by the caller so blanks
// can always sort last regardless of direction.
export function builderSortCompare(x: unknown, y: unknown): number {
  const nx = Number(x), ny = Number(y);
  if (x !== "" && y !== "" && !isNaN(nx) && !isNaN(ny)) return nx - ny;
  return String(x).localeCompare(String(y));
}

// Returns an array of ORIGINAL row indices in the order they should be shown.
// Identity order when no sort is active for the section. Blank/undefined values
// always sort to the bottom (applied before the direction multiply so they
// don't flip to the top under descending sort).
export function sortedBuilderIndices(section: BuilderSection): number[] {
  const arr = (state.builder[section] || []) as unknown as Record<string, unknown>[];
  const order = arr.map((_, i) => i);
  const s = state.builder.sort && state.builder.sort[section];
  if (!s || !s.key || !s.dir) return order;
  const dir = s.dir === "desc" ? -1 : 1;
  const isBlank = (v: unknown) => v === undefined || v === null || v === "";
  order.sort((a, b) => {
    const va = arr[a][s.key], vb = arr[b][s.key];
    const ba = isBlank(va), bb = isBlank(vb);
    if (ba && bb) return 0;
    if (ba) return 1;    // blanks last, not multiplied by dir
    if (bb) return -1;
    return dir * builderSortCompare(va, vb);
  });
  return order;
}

// The array index of the row shown directly below `index` in the current
// (possibly sorted) display order, or -1 if `index` is the last visible row.
// Lets Enter "move down a column" follow the on-screen order rather than the
// raw array order. With no sort active this is just index + 1.
export function nextBuilderDisplayIndex(section: BuilderSection, index: number): number {
  const order = sortedBuilderIndices(section);
  const pos = order.indexOf(index);
  if (pos === -1 || pos + 1 >= order.length) return -1;
  return order[pos + 1];
}

// The ▲ / ▼ glyph (or empty string) for a column header, reflecting the active
// sort on that section/key.
export function builderSortIndicator(section: BuilderSection, key: string): string {
  const s = state.builder.sort && state.builder.sort[section];
  if (!s || s.key !== key || !s.dir) return "";
  return s.dir === "desc" ? " ▼" : " ▲";
}

// A clickable, sortable column header. `widthStyle` is the optional inline
// style string (e.g. ' style="width:200px"') copied from the existing headers.
export function sortableTh(section: BuilderSection, key: string, label: string, widthStyle?: string): string {
  return '<th class="builder-th-sort"' + (widthStyle || "") +
         ' data-sort="' + section + '" data-sortkey="' + key + '">' +
         escapeHtml(label) +
         '<span class="builder-sort-ind">' + builderSortIndicator(section, key) + '</span>' +
         '</th>';
}

// Reset the wizard's bulk row-selection. The selection is a Set of row
// INDICES, so anything that shifts indices (add / delete / duplicate /
// reorder), a step change, or a seed/close must clear it — calling this in one
// named place keeps that invariant from drifting across call sites.
export function clearBuilderSelection(): void {
  state.builder.selected = new Set();
}

// ───── Validation ────────────────────────────────────────────────────────
// Returns { errors: [...], dup*: Set, *Ids: Set } used by the renderer to
// mark invalid inputs and by the footer to show the issue count.
export function validateBuilder(): {
  errors: string[];
  dupStreams: Set<string>;
  dupStages: Set<string>;
  dupCategories: Set<string>;
  dupNodes: Set<string>;
  streamIds: Set<string>;
  stageIds: Set<string>;
  categoryIds: Set<string>;
  nodeIds: Set<string>;
} {
  const b = state.builder;
  const errors: string[] = [];

  if (b.streams.length === 0)    errors.push("Add at least one row (Step 1).");
  if (b.stages.length === 0)     errors.push("Add at least one column (Step 2).");
  if (b.categories.length === 0) errors.push("Add at least one category (Step 3).");
  if (b.nodes.length === 0)      errors.push("Add at least one box (Step 4).");

  const dupStreams    = findDuplicateIds(b.streams);
  const dupStages     = findDuplicateIds(b.stages);
  const dupCategories = findDuplicateIds(b.categories);
  const dupNodes      = findDuplicateIds(b.nodes);

  dupStreams.forEach(id    => errors.push("Duplicate row id: " + id));
  dupStages.forEach(id     => errors.push("Duplicate column id: " + id));
  dupCategories.forEach(id => errors.push("Duplicate category id: " + id));
  dupNodes.forEach(id      => errors.push("Duplicate box id: " + id));

  // Coalesced "missing required fields" messages: blank rows just produce
  // one "row N needs id and label" instead of two separate errors, so a
  // freshly-added row doesn't bury everything else under noise.
  const checkRequiredIdAndLabel = (rows: { id?: string; label?: string }[], kind: string) => {
    rows.forEach((row, i) => {
      if (!row.id && !row.label) errors.push(kind + " row " + (i + 1) + " needs an id and label.");
      else if (!row.id)          errors.push(kind + " `" + row.label + "` is missing an id.");
      else if (!row.label)       errors.push(kind + " `" + row.id + "` is missing a label.");
    });
  };
  checkRequiredIdAndLabel(b.streams,    "Row");
  checkRequiredIdAndLabel(b.stages,     "Column");
  checkRequiredIdAndLabel(b.categories, "Category");

  const streamIds   = new Set(b.streams.map(s => s.id).filter(Boolean));
  const stageIds    = new Set(b.stages.map(s => s.id).filter(Boolean));
  const categoryIds = new Set(b.categories.map(c => c.id).filter(Boolean));

  b.nodes.forEach((n, i) => {
    if (!n.id && !n.label) {
      errors.push("Box row " + (i + 1) + " needs an id and label.");
    } else {
      if (!n.id)    errors.push("Box `" + n.label + "` is missing an id.");
      if (!n.label) errors.push("Box `" + n.id + "` is missing a label.");
    }
    const ref = (kind: string, value: string | undefined, knownSet: Set<string>) => {
      if (!value)               errors.push("Box `" + (n.id || n.label || ("row " + (i + 1))) + "` has no " + kind + ".");
      else if (!knownSet.has(value)) errors.push("Box `" + (n.id || n.label) + "` references unknown " + kind + " `" + value + "`.");
    };
    ref("row",      n.stream,   streamIds);
    ref("column",   n.stage,    stageIds);
    ref("category", n.category, categoryIds);
    // baseline must be either blank or > 0 (simulation divides by it).
    if (n.baseline !== "" && n.baseline !== undefined && Number(n.baseline) === 0) {
      errors.push("Box `" + (n.id || n.label || ("row " + (i + 1))) + "` has starting value 0 — must be positive or blank.");
    }
  });

  const nodeIds = new Set(b.nodes.map(n => n.id).filter(Boolean));
  b.edges.forEach((e, i) => {
    const tag = "Link row " + (i + 1);
    if (!e.from)                  errors.push(tag + " has no source box.");
    else if (!nodeIds.has(e.from)) errors.push(tag + " references unknown source box `" + e.from + "`.");
    if (!e.to)                    errors.push(tag + " has no target box.");
    else if (!nodeIds.has(e.to))   errors.push(tag + " references unknown target box `" + e.to + "`.");
    if (!EFFECT_OPTIONS.includes(e.effect)) errors.push(tag + " has invalid effect `" + e.effect + "`.");
  });

  return { errors, dupStreams, dupStages, dupCategories, dupNodes, streamIds, stageIds, categoryIds, nodeIds };
}

// ───── Apply / Download ───────────────────────────────────────────────────
export function applyBuilderToMap(): void {
  const csv = serializeBuilderToCsv(state.builder);
  const ok = loadDataFromCsv(csv);
  if (ok) closeBuilder();
}

export function downloadBuilderCsv(): void {
  const csv = serializeBuilderToCsv(state.builder);
  downloadCsvBlob(csv, "systems_map.csv");
}

// ───── Row data mutations ─────────────────────────────────────────────────
// "Add row" creates a default-shaped object for each section. "Duplicate
// row" clones the row with its id wiped (so the duplicate doesn't fail
// duplicate-id validation immediately).
// Both return the index of the newly-inserted row so callers (e.g. the
// keyboard navigation in 16d) can set state.builder.focusAfterRender.
export function addBuilderRow(section: BuilderSection): number {
  if (section === "streams") {
    state.builder.streams.push({ id: "", label: "", short: "", color: "#94a3b8" });
  } else if (section === "stages") {
    state.builder.stages.push({ id: "", label: "" });
  } else if (section === "categories") {
    state.builder.categories.push({ id: "", label: "", color: "#a3a3a3", textColor: "#1c1917", class: "primary" });
  } else if (section === "nodes") {
    const firstPrimary = (state.builder.categories.find(c => (c.class || "primary") !== "secondary") || state.builder.categories[0] || {}).id || "";
    state.builder.nodes.push({
      id: "", label: "", description: "",
      stream: state.builder.streams[0] ? state.builder.streams[0].id : "",
      stage:  state.builder.stages[0]  ? state.builder.stages[0].id  : "",
      category: firstPrimary,
      categoryIds: firstPrimary ? [firstPrimary] : [],
      baseline: "", unit: "", controllable: false, direction: "", sliderMax: "",
    });
  } else if (section === "edges") {
    state.builder.edges.push({
      from: state.builder.nodes[0] ? state.builder.nodes[0].id : "",
      to:   state.builder.nodes[0] ? state.builder.nodes[0].id : "",
      effect: "increases", elasticity: "", description: "",
    });
  } else {
    return -1;
  }
  return state.builder[section].length - 1;
}

export function duplicateBuilderRow(section: BuilderSection, index: number): number {
  const original = state.builder[section][index];
  if (!original) return -1;
  const copy = Object.assign({}, original) as unknown as Record<string, unknown>;
  // Wipe the id of the duplicated row — duplicates would fail validation.
  if (copy.id !== undefined) copy.id = "";
  (state.builder[section] as unknown as Record<string, unknown>[]).splice(index + 1, 0, copy);
  return index + 1;
}

// ───── Bulk row mutations (wizard multi-select) ───────────────────────────
// Delete every row whose index is in `state.builder.selected`. Splice from the
// highest index down so earlier indices stay valid as we remove. Clears the
// selection (the indices it held no longer mean anything). Returns the count
// removed.
export function deleteBuilderSelectedRows(section: BuilderSection): number {
  const arr = state.builder[section];
  if (!arr) return 0;
  const indices = [...state.builder.selected].filter(i => i >= 0 && i < arr.length);
  indices.sort((a, b) => b - a);
  for (const i of indices) arr.splice(i, 1);
  clearBuilderSelection();
  return indices.length;
}

// A builder node row's `category` cell edits the single primary anchor; this
// keeps its full `categoryIds` list in sync (new primary + the secondary chips
// it already had). Shared by the bulk setter and the per-row input handler.
export function reconcileBuilderNodeCategories(row: BuilderNode, newPrimaryId: string): void {
  const secs = splitCategoriesByClass(row.categoryIds || []).secondary;
  row.categoryIds = (newPrimaryId ? [newPrimaryId] : []).concat(secs);
}

// Set one field on every selected row in `section`. Coercion mirrors
// handleBuilderInput: number for numeric fields, boolean for controllable.
// Selection indices are left intact (a field write doesn't shift rows), so the
// same rows stay selected after the re-render. Returns the count changed.
export function applyBuilderBulkField(section: BuilderSection, field: string, value: unknown): number {
  const arr = state.builder[section] as unknown as Record<string, unknown>[];
  if (!arr) return 0;
  let changed = 0;
  for (const i of state.builder.selected) {
    const row = arr[i];
    if (!row) continue;
    let v: unknown = value;
    if (field === "controllable")   v = (value === "true" || value === true);
    else if (field === "elasticity") v = (value === "" ? "" : parseFloat(value as string));
    if (typeof v === "number" && isNaN(v)) continue;
    if (row[field] === v) continue;
    row[field] = v;
    // Keep the full category list in sync when bulk-setting the primary anchor.
    if (section === "nodes" && field === "category") reconcileBuilderNodeCategories(row as unknown as BuilderNode, v as string);
    changed++;
  }
  return changed;
}
