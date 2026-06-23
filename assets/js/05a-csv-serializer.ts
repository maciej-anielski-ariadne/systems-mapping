// =============================================================================
// CSV SERIALIZER — the inverse of 05-csv-parser.js
// -----------------------------------------------------------------------------
// Takes a `builder` object (the working-copy data shape used by the Build /
// Edit wizard in 16a-builder-panel.js) and produces the multi-section CSV
// string that the rest of the app already knows how to load.
//
// The output mirrors the format of `assets/data/empty_template.csv`:
//   • `# SECTION: <name>` markers between blocks
//   • column header on the first non-comment row of each section
//   • inline help comments above each section so a user opening the file in
//     a text editor / spreadsheet still sees the guidance the template has
//
// Round-trip guarantee: a CSV produced here, then fed back through
// `parseCsvDocument()` and `loadDataFromCsv()`, yields the same data shape.
// =============================================================================

import { ELASTICITY_KEYS } from "./02-config";
import {
  STREAMS,
  STAGES,
  CATEGORIES,
  DEFAULT_ELASTICITY_BY_EFFECT,
  NODES,
  EDGES,
} from "./03-state";
import type {
  BuilderState,
  BuilderStream,
  BuilderStage,
  BuilderCategory,
  BuilderNode,
  BuilderEdge,
} from "./types";

// Quote a single CSV cell when needed.
//   • If the value contains a comma, double-quote, or newline, wrap in "...".
//   • Internal double-quotes are doubled ("").
//   • Empty/undefined → empty string (no quotes).
export function csvEscape(value: unknown): string {
  if (value === undefined || value === null) return "";
  const stringValue = String(value);
  if (stringValue === "") return "";
  if (/[",\r\n]/.test(stringValue)) {
    return '"' + stringValue.replace(/"/g, '""') + '"';
  }
  return stringValue;
}

// Join an array of cell values into one CSV row line.
export function csvRow(cells: unknown[]): string {
  return cells.map(csvEscape).join(",");
}

// Serialize a builder object to the multi-section CSV string.
//
// `builder` shape (see 03-state.js → state.builder for the full type):
//   {
//     streams:    [{ id, label, short, color }],
//     stages:     [{ id, label }],
//     categories: [{ id, label, color, textColor }],
//     defaults:   { enables, increases, decreases },   // numbers
//     nodes:      [{ id, label, description, stream, stage, category,
//                    baseline, unit, controllable, direction, sliderMax }],
//     edges:      [{ from, to, effect, elasticity, description }],
//   }
export function serializeBuilderToCsv(builder: Partial<BuilderState> | null | undefined): string {
  return _serializeShape(builder || {});
}

// Serialize the LIVE runtime state (NODES/EDGES/STREAMS/STAGES/CATEGORIES) to
// the same CSV format. Used by the canvas direct-edit path (16e-canvas-edit.js)
// to persist every change without round-tripping through the builder.
//
// Pass `subset` to limit the saved boxes/links to a selection (the "CSV" export
// with a box selected — only its highlighted boxes and links). Streams, stages,
// categories and defaults are always written in full so the file stays a valid,
// reloadable map. With no `subset`, the whole map is serialized.
export function serializeLiveStateToCsv(subset?: { nodeIds: Set<string>; edgeIds: Set<string> }): string {
  const nodes = subset ? NODES.filter((n) => subset.nodeIds.has(n.id)) : NODES;
  const edges = subset ? EDGES.filter((e) => e.id != null && subset.edgeIds.has(e.id)) : EDGES;
  return _serializeShape({
    streams: STREAMS as unknown as BuilderStream[],
    stages: STAGES as unknown as BuilderStage[],
    categories: Object.keys(CATEGORIES).map((id) => ({
      id: id,
      label: CATEGORIES[id].label,
      color: CATEGORIES[id].color,
      textColor: CATEGORIES[id].textColor,
      class: CATEGORIES[id].class || "primary",
    })) as unknown as BuilderCategory[],
    defaults: {
      enables:   DEFAULT_ELASTICITY_BY_EFFECT.enables,
      increases: DEFAULT_ELASTICITY_BY_EFFECT.increases,
      decreases: DEFAULT_ELASTICITY_BY_EFFECT.decreases,
    },
    nodes: nodes as unknown as BuilderNode[],
    edges: edges as unknown as BuilderEdge[],
  });
}

// Shared serialization core used by both the builder and the live-state paths.
export function _serializeShape(data: Partial<BuilderState>): string {
  const builder = data;
  const lines: string[] = [];

  // id → title lookups, so sections that reference a node/stream/stage/category
  // by id can also carry the human-readable title beside it. These companion
  // columns are for the reader only — the loader keys links by the id columns
  // (`from`/`to`), so the titles can drift or be blank without breaking a map.
  const nodeLabelById: Record<string, string> = {};
  for (const node of builder.nodes || []) {
    if (node.id) nodeLabelById[node.id] = node.label || node.id;
  }

  // ───── File-level header ─────────────────────────────────────────────────
  lines.push("# Ariadne Maps — generated by the in-app Build / Edit wizard");
  lines.push("# Drag this file back onto the app to reload it, or edit in Excel / Sheets.");
  lines.push("#");
  lines.push("# Sections (in order): streams (rows), stages (columns), categories, defaults, nodes (boxes), edges (links).");
  lines.push("# Lines starting with # are comments. The first non-comment row of each");
  lines.push("# section is the column header — do NOT change the column names.");
  lines.push("");

  // ───── streams ──────────────────────────────────────────────────────────
  lines.push("# SECTION: streams");
  lines.push("# id    - unique row identifier (used by the boxes below)");
  lines.push("# label - display name");
  lines.push("# short - short label on the row header (uppercase, ~6 chars)");
  lines.push("# color - hex colour for the row's left bar (e.g. #60a5fa)");
  lines.push("id,label,short,color");
  for (const stream of builder.streams || []) {
    lines.push(csvRow([stream.id, stream.label, stream.short, stream.color]));
  }
  lines.push("");

  // ───── stages ───────────────────────────────────────────────────────────
  lines.push("# SECTION: stages");
  lines.push("# id    - column identifier (used by the boxes below)");
  lines.push("# label - column header text on the map. Columns show left-to-right in CSV order.");
  lines.push("id,label");
  for (const stage of builder.stages || []) {
    lines.push(csvRow([stage.id, stage.label]));
  }
  lines.push("");

  // ───── categories ───────────────────────────────────────────────────────
  lines.push("# SECTION: categories");
  lines.push("# id         - category identifier (used by the boxes below)");
  lines.push("# label      - display name shown in the sidebar legend");
  lines.push("# color      - fill colour for boxes of this category (hex)");
  lines.push("# text_color - label text colour (hex). Pick a high-contrast value.");
  lines.push("# class      - 'primary' (fill; several blend into a gradient) or");
  lines.push("#             'secondary' (a small chip in the box's bottom-right). Default primary.");
  lines.push("id,label,color,text_color,class");
  for (const category of builder.categories || []) {
    lines.push(csvRow([category.id, category.label, category.color, category.textColor, category.class || "primary"]));
  }
  lines.push("");

  // ───── defaults ─────────────────────────────────────────────────────────
  lines.push("# SECTION: defaults");
  lines.push("# Default strengths used when a link's `elasticity` cell is blank.");
  lines.push("# Strength = percent change in the target's value per percent change in the source's value.");
  lines.push("key,value");
  const defaults = builder.defaults || { enables: 0.30, increases: 0.25, decreases: -0.25 };
  lines.push(csvRow([ELASTICITY_KEYS.enables,   defaults.enables]));
  lines.push(csvRow([ELASTICITY_KEYS.increases, defaults.increases]));
  lines.push(csvRow([ELASTICITY_KEYS.decreases, defaults.decreases]));
  lines.push("");

  // ───── nodes ────────────────────────────────────────────────────────────
  lines.push("# SECTION: nodes");
  lines.push("# Required: id, label, stream, stage, category.");
  lines.push("# category: one or more category ids, pipe-separated (e.g. resource|risk). Each id's");
  lines.push("#           class decides whether it's a fill (primary) or a corner chip (secondary).");
  lines.push("# Optional (enables simulation): baseline, unit, controllable, direction, slider_max.");
  lines.push("# controllable: 'true' to show as a slider. direction: higher_better / lower_better / neutral.");
  lines.push("id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max");
  for (const node of builder.nodes || []) {
    lines.push(csvRow([
      node.id,
      node.label,
      node.description || "",
      node.stream,
      node.stage,
      (node.categoryIds && node.categoryIds.length) ? node.categoryIds.join("|") : node.category,
      node.baseline === undefined || node.baseline === null || node.baseline === "" ? "" : node.baseline,
      node.unit || "",
      node.controllable ? "true" : "",
      node.direction || "",
      node.sliderMax === undefined || node.sliderMax === null || node.sliderMax === "" ? "" : node.sliderMax,
    ]));
  }
  lines.push("");

  // ───── edges ────────────────────────────────────────────────────────────
  lines.push("# SECTION: edges");
  lines.push("# from / to                - source and target box ids (the app maps each link by these).");
  lines.push("# from_label / to_label    - the box titles for those ids, shown for readability only.");
  lines.push("#                            The app ignores them on load; edit `from`/`to` to re-point a link.");
  lines.push("# effect       - enables / increases / decreases");
  lines.push("# elasticity   - OPTIONAL per-link override (strength). Blank = use the default for the effect.");
  lines.push("# style        - OPTIONAL line style: 'dashed', or blank for solid (default).");
  lines.push("# description  - explanation shown in the detail panel");
  lines.push("from,from_label,to,to_label,effect,elasticity,style,description");
  for (const edge of builder.edges || []) {
    lines.push(csvRow([
      edge.from,
      nodeLabelById[edge.from] || "",
      edge.to,
      nodeLabelById[edge.to] || "",
      edge.effect,
      edge.elasticity === undefined || edge.elasticity === null || edge.elasticity === "" ? "" : edge.elasticity,
      edge.style === "dashed" ? "dashed" : "",
      edge.description || "",
    ]));
  }
  lines.push("");

  return lines.join("\n");
}
