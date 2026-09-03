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

import { BRAND_NAME } from "./00-brand";
import { ELASTICITY_KEYS } from "./02-config";
import {
  STREAMS,
  STAGES,
  CATEGORIES,
  DEFAULT_ELASTICITY_BY_EFFECT,
  NODES,
  EDGES,
  PARAMS,
  state,
} from "./03-state";
import type {
  BuilderState,
  BuilderStream,
  BuilderStage,
  BuilderCategory,
  BuilderNode,
  BuilderEdge,
  Param,
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
//                    baseline, unit, controllable, direction, sliderMax,
//                    combine, formula, minValue, maxValue }],
//     edges:      [{ from, to, effect, elasticity, description }],
//     params:     [{ id, value, description }],   // optional — see below
//   }
//
// Params note: a builder object may not carry params at all — an older saved
// snapshot from before the wizard's Constants step, say. `undefined` therefore
// means "this builder never saw the map's params" and we fall back to the LIVE
// ones, so an "Apply to map" can never silently delete constants the user was
// never shown. An explicit `[]` (what seedBuilderEmpty writes for a
// from-scratch build, and what the Constants step leaves behind when the user
// deletes every row) means "no params".
export function serializeBuilderToCsv(builder: Partial<BuilderState> | null | undefined): string {
  const data = builder || {};
  return _serializeShape(data.params === undefined ? { ...data, params: PARAMS } : data);
}

// Serialize the LIVE runtime state (NODES/EDGES/STREAMS/STAGES/CATEGORIES) to
// the same CSV format. Used by the canvas direct-edit path (16e-canvas-edit.js)
// to persist every change without round-tripping through the builder.
//
// Pass `subset` to limit the saved boxes/links to a selection (the "CSV" export
// with a box selected — only its highlighted boxes and links). Streams, stages,
// categories and defaults are always written in full so the file stays a valid,
// reloadable map. With no `subset`, the whole map is serialized.
// `options.compact` drops the from_label / to_label companion columns from the
// edges section. Those columns exist purely for humans reading the file — the
// loader keys links on `from`/`to` and ignores them — and on a link-heavy map
// they are ~35% of the serialized bytes. The auto-save / undo-snapshot paths
// pass compact:true; user-facing downloads keep the readable columns.
export function serializeLiveStateToCsv(
  subset?: { nodeIds: Set<string>; edgeIds: Set<string> } | null,
  options?: { compact?: boolean },
): string {
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
    // Params are map-wide constants, not boxes, so they are written in full
    // even for a subset export — a formula in the exported slice may need them.
    params: PARAMS.map((p): Param => ({ id: p.id, value: p.value, description: p.description })),
  }, options);
}

// Shared serialization core used by both the builder and the live-state paths.
export function _serializeShape(data: Partial<BuilderState>, options?: { compact?: boolean }): string {
  const builder = data;
  const compact = !!(options && options.compact);
  const lines: string[] = [];

  // id → title lookups, so sections that reference a node/stream/stage/category
  // by id can also carry the human-readable title beside it. These companion
  // columns are for the reader only — the loader keys links by the id columns
  // (`from`/`to`), so the titles can drift or be blank without breaking a map.
  // Skipped entirely in compact mode (auto-save / undo snapshots).
  const nodeLabelById: Record<string, string> = {};
  if (!compact) {
    for (const node of builder.nodes || []) {
      if (node.id) nodeLabelById[node.id] = node.label || node.id;
    }
  }

  // ───── File-level header ─────────────────────────────────────────────────
  // Provenance, not decoration: whoever opens this file in a year has no other
  // way of telling what wrote it. Follows the brand, so a client build stamps
  // the client's name. The parser skips every "#" line, so an unnamed build
  // simply says less rather than breaking the round-trip.
  lines.push(BRAND_NAME
    ? "# " + BRAND_NAME + " — generated by the in-app Build / Edit wizard"
    : "# Generated by the in-app Build / Edit wizard");
  lines.push("# Drag this file back onto the app to reload it, or edit in Excel / Sheets.");
  lines.push("#");
  lines.push("# Sections (in order): streams (rows), stages (columns), categories, defaults,");
  lines.push("# params (optional calculation constants), nodes (boxes), edges (links).");
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

  // ───── params (only when the map actually has some) ─────────────────────
  // Hidden constants used by box formulas. Omitted entirely for a map that
  // doesn't use them, so a simple map's CSV stays as short as it was before
  // the feature existed.
  const params = builder.params || [];
  if (params.length > 0) {
    lines.push("# SECTION: params");
    lines.push("# Named constants for the calculation model. They never appear as boxes on the");
    lines.push("# map — use them for shares, rates and conversion factors a box formula needs.");
    lines.push("# id          - unique name, referenced from a box's `formula` cell.");
    lines.push("#               Must not clash with a box id.");
    lines.push("# value       - a number.");
    lines.push("# description - what the constant means and where the number came from.");
    lines.push("id,value,description");
    for (const param of params) {
      lines.push(csvRow([param.id, param.value, param.description || ""]));
    }
    lines.push("");
  }

  // ───── reviews (only when someone has actually reviewed something) ──────
  // The review record travels WITH the map, so a pass survives a refresh, goes
  // to a colleague in the same file, and can be picked up tomorrow. Written from
  // live state rather than from the builder: a verdict is about the map, and the
  // wizard never edits one. Omitted entirely for a map nobody has reviewed, so
  // an untouched CSV is byte-for-byte what it was before the feature existed.
  const reviewIds = Object.keys(state.reviews || {}).sort();
  if (reviewIds.length > 0) {
    lines.push("# SECTION: reviews");
    lines.push("# Who checked what feeds each box, and whether it still holds.");
    lines.push("# box         - the box whose incoming links were reviewed.");
    lines.push("# label       - its name when this was last written. Display only — a rename");
    lines.push("#               does not retire a verdict — but it is what still NAMES the box");
    lines.push("#               in the log after somebody deletes it.");
    lines.push("# removed_on  - set when the box was deleted from the map, cleared if it comes");
    lines.push("#               back. A row carrying one is kept on load even though the box is");
    lines.push("#               gone; a row about a box this map never had is still dropped.");
    lines.push("# verdict     - agreed / flagged / none. \"none\" is a comment somebody left");
    lines.push("#               before deciding — the box still counts as unchecked.");
    lines.push("# reviewer    - the full name of whoever gave the latest verdict.");
    lines.push("# date        - yyyy-mm-dd.");
    lines.push("# note        - why. Free text.");
    lines.push("# flagged     - pipe-separated source box ids flagged individually.");
    lines.push("# fingerprint - what the box looked like when it was judged. Change any of");
    lines.push("#               its links, strengths, rule or limits and the verdict reads");
    lines.push("#               as STALE and the box comes back round. Do not hand-edit.");
    lines.push("# flagged_on / flagged_by - when the concern was raised, and by whom. Kept");
    lines.push("#               after it is closed out, when reviewer/date name whoever");
    lines.push("#               closed it. addressed_on / addressed_by are when that happened");
    lines.push("#               and who did it, and are blank while a flag is open. Only the");
    lines.push("#               latest round is kept.");
    lines.push("# addressed_note - what was actually DONE about the flag. Required before one");
    lines.push("#               can be closed; `note` says what was wrong, this says what");
    lines.push("#               happened about it.");
    lines.push("box,label,verdict,reviewer,date,note,flagged,fingerprint,flagged_on,flagged_by,addressed_on,addressed_by,addressed_note,removed_on");
    for (const id of reviewIds) {
      const entry = state.reviews[id];
      lines.push(csvRow([
        entry.boxId,
        entry.label || entry.boxId,
        entry.verdict,
        entry.reviewer || "",
        entry.date || "",
        entry.note || "",
        (entry.flaggedSources || []).join("|"),
        entry.fingerprint || "",
        entry.flaggedOn || "",
        entry.flaggedBy || "",
        entry.addressedOn || "",
        entry.addressedBy || "",
        entry.addressedNote || "",
        entry.removedOn || "",
      ]));
    }
    lines.push("");
  }

  // ───── nodes ────────────────────────────────────────────────────────────
  lines.push("# SECTION: nodes");
  lines.push("# Required: id, label, stream, stage, category.");
  lines.push("# category: one or more category ids, pipe-separated (e.g. resource|risk). Each id's");
  lines.push("#           class decides whether it's a fill (primary) or a corner chip (secondary).");
  lines.push("# Optional (enables simulation): baseline, unit, controllable, direction, slider_max.");
  lines.push("# controllable: 'true' to show as a slider. direction: higher_better / lower_better / neutral.");
  lines.push("# Optional calculation rules: combine, formula, min, max. Blank = today's behaviour.");
  lines.push("# combine: multiplicative (default) / additive / min — how the links into the box combine.");
  lines.push("# formula: an expression using box ids, param ids and + - * / ( ), e.g. min(demand, capacity).");
  lines.push("# min / max: hard limits on the box's value, in the box's own units.");
  lines.push("# formula_evidence_*: informational support for the formula; status is unspecified / hypothesis / supported / calibrated / validated.");
  // The calculation and evidence columns are ALWAYS written (blank when unset,
  // except for the explicit unspecified status) so a
  // load → save round-trip produces a header of stable shape.
  lines.push("id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max,combine,formula,min,max,formula_evidence_status,formula_evidence_rationale,formula_evidence_source,formula_evidence_last_reviewed");
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
      node.combine || "",
      node.formula || "",
      node.minValue === undefined || node.minValue === null || node.minValue === "" ? "" : node.minValue,
      node.maxValue === undefined || node.maxValue === null || node.maxValue === "" ? "" : node.maxValue,
      node.formulaEvidence?.status || "unspecified",
      node.formulaEvidence?.rationale || "",
      node.formulaEvidence?.source || "",
      node.formulaEvidence?.lastReviewed || "",
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
  lines.push("# evidence_*   - informational status, rationale, source/citation and last-reviewed date for this causal link.");
  // Compact mode drops the two *_label companion columns — the header row is
  // what the parser keys on, so both shapes round-trip identically.
  lines.push(compact
    ? "from,to,effect,elasticity,style,description,evidence_status,evidence_rationale,evidence_source,evidence_last_reviewed"
    : "from,from_label,to,to_label,effect,elasticity,style,description,evidence_status,evidence_rationale,evidence_source,evidence_last_reviewed");
  for (const edge of builder.edges || []) {
    const elasticityCell = edge.elasticity === undefined || edge.elasticity === null || edge.elasticity === "" ? "" : edge.elasticity;
    const styleCell = edge.style === "dashed" ? "dashed" : "";
    lines.push(csvRow(compact
      ? [
          edge.from,
          edge.to,
          edge.effect,
          elasticityCell,
          styleCell,
          edge.description || "",
          edge.evidence?.status || "unspecified",
          edge.evidence?.rationale || "",
          edge.evidence?.source || "",
          edge.evidence?.lastReviewed || "",
        ]
      : [
          edge.from,
          nodeLabelById[edge.from] || "",
          edge.to,
          nodeLabelById[edge.to] || "",
          edge.effect,
          elasticityCell,
          styleCell,
          edge.description || "",
          edge.evidence?.status || "unspecified",
          edge.evidence?.rationale || "",
          edge.evidence?.source || "",
          edge.evidence?.lastReviewed || "",
        ]));
  }
  lines.push("");

  return lines.join("\n");
}
