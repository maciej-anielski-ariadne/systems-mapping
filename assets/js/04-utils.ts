// =============================================================================
// UTILITY HELPERS — small functions used in many places
// -----------------------------------------------------------------------------
// Small helpers:
//   • wrapLabel       – split a node label across two lines if it's too long
//   • escapeHtml      – make user text safe to inject into HTML/SVG strings
//   • formatScalar    – format a number for display ("9,000", "1.25", etc.)
//   • getMapTextScale – font-scale multiplier for the map when zoomed out
// =============================================================================

import { TEXT_SCALE_MAX, TEXT_SCALE_RATIO, FAN_SPACING, FAN_MARGIN } from "./02-config";
import { CATEGORIES } from "./03-state";
import type { GraphNode, Edge, CategoryMap, NodePosition } from "./types";

// Split `text` into up to 2 lines, each no more than `maxCharsPerLine` chars.
// Words are kept whole; if a third line would be needed, the second line is
// truncated with an ellipsis.
export function wrapLabel(text: string, maxCharsPerLine: number): string[] {
  if (text.length <= maxCharsPerLine) return [text];

  const words = text.split(" ");
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    if ((currentLine + " " + word).trim().length <= maxCharsPerLine) {
      currentLine = (currentLine + " " + word).trim();
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);

  // Limit to 2 lines, adding an ellipsis on the second if there was more.
  // If line 2 is already at the character limit, drop its last char first so
  // the ellipsis doesn't push it past `maxCharsPerLine`.
  if (lines.length > 2) {
    if (lines[1].length >= maxCharsPerLine) {
      lines[1] = lines[1].slice(0, maxCharsPerLine - 1);
    }
    lines[1] = lines[1] + "…";
    return lines.slice(0, 2);
  }
  return lines;
}

// Wrap a node label to fill a pixel width, measuring real text width at the
// node-label font (Arial 12px / weight 500) rather than guessing by character
// count. Returns an array of lines (words kept whole; a single word wider than
// the line is left to overflow, same as before). No line cap — the box "grows
// to fit", so the caller derives the node height from the line count. Cached by
// `width|text` since computeLayout may re-run often (drag, hover) and labels
// rarely change. The font must match .node-label in 05-visualization.css.
export const _labelLineCache = new Map<string, string[]>();
// Cap the cache so a long editing/renaming session on a big map (every label
// edit mints fresh keys) can't grow it without bound. When the limit is hit we
// drop the oldest ~25% of entries (Map preserves insertion order) — cheap, and
// the working set of currently-visible labels is re-measured on the next render.
// The cap grows (doubling, up to a hard ceiling) each time it's hit: a map with
// more labels than the cap would otherwise thrash — every layout pass evicting
// a quarter of the LIVE working set and re-measuring 1000+ labels per keystroke.
export const LABEL_CACHE_MAX = 5000;
const LABEL_CACHE_HARD_MAX = 50_000;
let _labelCacheCap = LABEL_CACHE_MAX;
export let _labelMeasureCtx: CanvasRenderingContext2D | null = null;
export function measureLabelLines(text: unknown, maxWidthPx: number): string[] {
  text = String(text == null ? "" : text);
  if (!text) return [""];
  const key = maxWidthPx + "|" + text;
  const cached = _labelLineCache.get(key);
  if (cached) return cached;

  if (!_labelMeasureCtx) {
    _labelMeasureCtx = document.createElement("canvas").getContext("2d");
  }
  _labelMeasureCtx!.font = "500 12px Arial, Helvetica, sans-serif";

  const words = (text as string).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const trial = current ? current + " " + word : word;
    // Start a new line once adding the word would exceed the width — but never
    // on an empty line (a lone over-wide word stays whole and overflows).
    if (current && _labelMeasureCtx!.measureText(trial).width > maxWidthPx) {
      lines.push(current);
      current = word;
    } else {
      current = trial;
    }
  }
  if (current) lines.push(current);
  const result = lines.length ? lines : [""];
  if (_labelLineCache.size >= _labelCacheCap) {
    if (_labelCacheCap < LABEL_CACHE_HARD_MAX) {
      // Working set outgrew the cap — give it headroom instead of thrashing.
      _labelCacheCap = Math.min(LABEL_CACHE_HARD_MAX, _labelCacheCap * 2);
    } else {
      const drop = Math.ceil(_labelCacheCap / 4);
      const it = _labelLineCache.keys();
      for (let i = 0; i < drop; i++) {
        const k = it.next().value;
        if (k === undefined) break;
        _labelLineCache.delete(k);
      }
    }
  }
  _labelLineCache.set(key, result);
  return result;
}

// Replace the five HTML-unsafe characters with their entity equivalents so the
// resulting text is safe to inject into innerHTML / SVG markup strings.
export function escapeHtml(text: unknown): string {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Format a number for display. The decimal precision depends on magnitude:
//   • Above 1 billion: e.g. "1.25" (with implied "bn" elsewhere)
//   • 10,000 and up:   thousands-separated integer ("9,000")
//   • 100 to 9,999:    integer ("250")
//   • 10 to 99:        one decimal ("12.5")
//   • 1 to 9:          two decimals ("3.14")
//   • Below 1:         three decimals ("0.125")
// Cached formatter for the thousands-separated branch below — a fresh
// toLocaleString() call resolves the locale on every invocation and is one of
// the slowest formatting primitives in JS; the cached formatter produces the
// identical string. Lazy so module load never pays for it.
let _thousandsFormat: Intl.NumberFormat | null = null;

export function formatScalar(value: number): string {
  const absValue = Math.abs(value);
  if (absValue >= 1e9)    return (value / 1e9).toFixed(2);
  if (absValue >= 10000) {
    if (!_thousandsFormat) _thousandsFormat = new Intl.NumberFormat();
    return _thousandsFormat.format(Math.round(value));
  }
  if (absValue >= 100)    return Math.round(value).toString();
  if (absValue >= 10)     return value.toFixed(1);
  if (absValue >= 1)      return value.toFixed(2);
  return value.toFixed(3);
}

// The same number, for an <input type="number">. `formatScalar` groups
// thousands ("10,080") and folds billions down to a unit count ("1.50" for
// 1.5e9) — both are display flourishes, and both are POISON in a number field:
// the browser refuses any value that is not a bare floating-point literal, so a
// grouped number renders as an EMPTY BOX, and a folded one silently reads back
// as 1.5. That is why the Border Force FTE field went blank the moment its
// slider pushed the headcount past 10,000.
//
// So the precision ladder is kept — the field shows the same rounding the map
// does — and only the grouping and the folding are dropped.
export function formatScalarInput(value: number): string {
  if (!Number.isFinite(value)) return "";
  const absValue = Math.abs(value);
  if (absValue >= 100) return String(Math.round(value));
  if (absValue >= 10)  return value.toFixed(1);
  if (absValue >= 1)   return value.toFixed(2);
  return value.toFixed(3);
}

// ───── Category / edge helpers (shared by loader, renderer, export, editors) ─
// A node's full ordered category-id list, with the legacy single-id fallback.
export function nodeCategoryIds(node: GraphNode): string[] {
  return (node.categoryIds && node.categoryIds.length) ? node.categoryIds : (node.category ? [node.category] : []);
}

// Split a list of category ids into { primary, secondary } by each category's
// class. `cats` defaults to the live CATEGORIES map; the loader passes its
// not-yet-committed parsedCategories instead.
export function splitCategoriesByClass(
  ids: string[],
  cats?: CategoryMap
): { primary: string[]; secondary: string[] } {
  cats = cats || CATEGORIES;
  const primary: string[] = [], secondary: string[] = [];
  for (const id of ids) {
    const c = cats[id];
    if (!c) continue;
    ((c.class || "primary") === "secondary" ? secondary : primary).push(id);
  }
  return { primary: primary, secondary: secondary };
}

// Slack (px) before an edge whose target is barely to the right of its source
// still counts as "backward". Shared by isBackwardEdge so the path builder and
// any caller asking "is this a feedback edge?" can never drift apart.
const BACK_MARGIN = 24;

// Does this edge run BACKWARD — i.e. its target sits left of, or only
// marginally right of, the source? The single source of truth for "is this a
// feedback edge". A FORWARD edge connects the source's right face to the
// target's left face; a BACKWARD edge connects the source's LEFT face to the
// target's RIGHT face (see edgeBezierPath).
export function isBackwardEdge(fromPos: NodePosition, toPos: NodePosition): boolean {
  return toPos.x < fromPos.x + fromPos.width + BACK_MARGIN;
}

// The smooth S-shaped curve for an edge (arrow) from one node box to another.
// It's written as an SVG path string ("M x,y C …" = move to the start point,
// then draw one cubic-bezier curve). A cubic bezier is a curve shaped by two
// invisible "control points" that pull it into form; here the control points
// are pushed straight out horizontally from each box face, which makes the
// curve leave and arrive flat (its "tangent" — the direction it's heading — is
// horizontal). See "cubic bezier" / "tangent" in docs/GLOSSARY.md. The curve is
// drawn the same way whether the edge runs forward or backward — only the
// faces it connects flip:
//   • FORWARD  (target to the right): source RIGHT face → target LEFT face, so
//     the curve flows left→right and the arrowhead points right into the left
//     face.
//   • BACKWARD / feedback (target left of, or level with, the source): source
//     LEFT face → target RIGHT face, so the curve flows right→left and the
//     arrowhead points left into the right face.
// Both use horizontal tangents (control points pushed straight out from each
// face), so the arrow enters its target face cleanly. The arrow marker is
// orient="auto-start-reverse" (see 11-rendering.ts) so the arrowhead follows
// the end tangent in either direction for free — do NOT touch the marker.
// Shared by the live renderer and the export so the curve math lives in one
// place.
export function edgeBezierPath(
  fromPos: NodePosition,
  toPos: NodePosition,
  fromYOffset = 0,
  toYOffset = 0,
): string {
  // fromYOffset / toYOffset fan the anchors up/down the node face so several
  // edges into (or out of) one node don't all land on the same point — see
  // computeEdgeAnchorOffsets. They default to 0, so callers that don't fan out
  // (and the export's center-anchored modes) are unaffected.
  const startY = fromPos.y + fromPos.height / 2 + fromYOffset;
  const endY   = toPos.y + toPos.height / 2 + toYOffset;

  // Backward edges exit the LEFT face and enter the RIGHT face (tangents point
  // outward, i.e. left from the source and right of the target); forward edges
  // exit the RIGHT face and enter the LEFT face. `dir` is the outward direction
  // of each tangent so the same control-point math serves both.
  const backward = isBackwardEdge(fromPos, toPos);
  const startX = backward ? fromPos.x : fromPos.x + fromPos.width;   // source face
  const endX   = backward ? toPos.x + toPos.width : toPos.x;          // target face
  const dir = backward ? -1 : 1;

  const ctrlOffset = Math.max(40, Math.abs(endX - startX) * 0.5);
  return "M " + startX + "," + startY +
         " C " + (startX + dir * ctrlOffset) + "," + startY +
         " " + (endX - dir * ctrlOffset) + "," + endY +
         " " + endX + "," + endY;
}

// Per-edge vertical anchor offsets, used to fan the edges that share a node
// face. Parallel by index to the edge array passed in.
export interface AnchorOffset { fromYOffset: number; toYOffset: number; }

// Fixed bucket order so the fan is deterministic across re-renders (it must not
// depend on edge insertion order). Effects rank first, then solid before dashed.
const EFFECT_FAN_ORDER: Record<string, number> = {
  increases: 0, decreases: 1, enables: 2, neutral: 3, default: 4,
};

// Decide where each edge should attach to its source/target node face so that
// differently-coloured arrows stop piling onto the single vertical-centre point.
//
// In plain terms: if five arrows all touch the right side of one box, we don't
// want them stacked on the exact same spot. So we sort them into groups (called
// "buckets" below) and spread — "fan out" — their attachment points evenly up
// and down that side of the box. (See "edge anchor / fan-out" in
// docs/GLOSSARY.md.) The result is one small up/down offset per edge.
//
// Edges sharing a node face are bucketed by (effect, line-style): every edge in
// a bucket shares one anchor (same colour merging is fine and expected), while
// distinct buckets fan out to their own landing points. So a node shows at most
// a handful of anchors (≤ effects × styles), never one-per-edge — no cramping.
// A face with a single bucket keeps the centred anchor (offset 0), so simple
// maps look exactly as before. Spacing clamps inside the face (FAN_MARGIN top
// and bottom) so an anchor never escapes the box.
//
// Returns an array of {fromYOffset, toYOffset} parallel by index to `edges`, so
// the same call works for any edge-like list (real, synthetic, export model)
// via the accessor callbacks. Shared by the live renderer (11) and export (19).
export function computeEdgeAnchorOffsets<T>(
  edges: T[],
  positions: Record<string, NodePosition>,
  getFrom: (e: T) => string,
  getTo: (e: T) => string,
  getEffect: (e: T) => string,
  getStyle: (e: T) => string,           // "solid" | "dashed"
): AnchorOffset[] {
  const result: AnchorOffset[] = edges.map(() => ({ fromYOffset: 0, toYOffset: 0 }));

  const bucketKey  = (e: T): string => getEffect(e) + "|" + getStyle(e);
  const bucketRank = (key: string): number => {
    const sep   = key.indexOf("|");
    const eff   = key.slice(0, sep);
    const style = key.slice(sep + 1);
    return (EFFECT_FAN_ORDER[eff] ?? 99) * 2 + (style === "dashed" ? 1 : 0);
  };

  // Fan one node face: spread the distinct buckets present across the face and
  // write the chosen offset back onto every edge in each bucket.
  const fanFace = (nodeId: string, idxs: number[], field: "fromYOffset" | "toYOffset"): void => {
    const pos = positions[nodeId];
    if (!pos) return;
    const buckets = Array.from(new Set(idxs.map((i) => bucketKey(edges[i]))))
      .sort((a, b) => bucketRank(a) - bucketRank(b));
    const m = buckets.length;
    if (m <= 1) return;                 // single bucket → centred (offset 0)
    const span = Math.max(0, pos.height - 2 * FAN_MARGIN);
    const step = Math.min(FAN_SPACING, span / (m - 1));
    const offsetOf: Record<string, number> = {};
    buckets.forEach((key, j) => { offsetOf[key] = (j - (m - 1) / 2) * step; });
    for (const i of idxs) result[i][field] = offsetOf[bucketKey(edges[i])];
  };

  const incoming: Record<string, number[]> = {};
  const outgoing: Record<string, number[]> = {};
  edges.forEach((e, i) => {
    (outgoing[getFrom(e)] ||= []).push(i);
    (incoming[getTo(e)]   ||= []).push(i);
  });
  for (const n in outgoing) fanFace(n, outgoing[n], "fromYOffset");
  for (const n in incoming) fanFace(n, incoming[n], "toYOffset");

  return result;
}

// effect → arrow-marker name. The four edge effects map to their own markers
// ("increases" / "decreases" / "enables"); anything else falls back to
// "default". Shared by the live renderer (11-rendering.ts) and the export
// (19-export.ts) so the two agree on marker ids. The stroke *colour* differs
// between them (live uses CSS vars, export resolves to literal hex), so only
// the marker mapping is shared.
export function effectMarkerName(effect: string): string {
  return (effect === "increases" || effect === "decreases" || effect === "enables") ? effect : "default";
}

// How many arrow-hops away the furthest-reachable box is, starting from any of
// the given boxes and following `neighbors(id) => id[]`. In plain terms: explore
// outward in rings — everything one hop away, then two hops, and so on (this
// ring-by-ring walk is "breadth-first search" / BFS; see docs/GLOSSARY.md) — and
// report the deepest ring reached. Used as the dynamic cap for the highlight-
// depth control: past this number, turning the depth up reveals nothing further.
// Shared by the live map (09-graph-selection.ts, over the whole graph) and the
// published export viewer's cap (19-export.ts, over the published subset).
// `visited` stops us counting a box twice; `frontier` is the current ring.
// Always >= 1.
export function maxReachableDepth(starts: Iterable<string>, neighbors: (id: string) => string[]): number {
  let max = 1;
  for (const start of starts) {
    const visited = new Set([start]);
    let frontier = [start];
    let level = 0;
    while (frontier.length) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const nb of neighbors(id)) {
          if (!visited.has(nb)) { visited.add(nb); next.push(nb); }
        }
      }
      if (next.length) level++;
      frontier = next;
    }
    if (level > max) max = level;
  }
  return max;
}

// Colour for a node's value-delta given its direction-of-merit and % change.
// Green = "good" move, red = "bad" move, blue/orange when no direction is set.
export function deltaColorFor(node: GraphNode, deltaInfo: { pct: number }): string {
  if (node.direction === "higher_better") return deltaInfo.pct > 0 ? "#065f46" : "#7f1d1d";
  if (node.direction === "lower_better")  return deltaInfo.pct < 0 ? "#065f46" : "#7f1d1d";
  return deltaInfo.pct > 0 ? "#1e3a8a" : "#7c2d12";
}

// Map text-scale multiplier given the current zoom level. As the user zooms
// out below TEXT_SCALE_RATIO, SVG font-sizes grow inversely with zoom so
// on-screen text stays roughly readable, capped at TEXT_SCALE_MAX so labels
// don't spill out of node-rects. At zoom >= TEXT_SCALE_RATIO this returns
// 1.0 (no scaling). Set as the --map-text-scale CSS variable on #viz-svg
// by both render() and applyZoom().
export function getMapTextScale(zoomLevel: number): number {
  if (!zoomLevel || isNaN(zoomLevel) || zoomLevel <= 0) return 1;
  return Math.min(TEXT_SCALE_MAX, Math.max(1, TEXT_SCALE_RATIO / zoomLevel));
}

// Pick the label colour — pure white or near-black — that maximises contrast
// against a given background fill, so category labels stay readable whatever
// fill the user picks. The decision is based on how bright the fill really
// looks to the human eye: we compute its "relative luminance" (a standard
// brightness measure from the WCAG accessibility guidelines — it weights green
// most and blue least, because that's how our eyes work) and switch to dark
// text once the fill is brighter than the standard crossover point (~0.179).
// See "WCAG relative luminance" in docs/GLOSSARY.md. Accepts #rgb / #rrggbb;
// falls back to white for anything unparseable.
export function pickTextColor(bgHex: string): string {
  const hex = String(bgHex || "").trim().replace(/^#/, "");
  let r: number, g: number, b: number;
  if (hex.length === 3) {
    r = parseInt(hex[0] + hex[0], 16);
    g = parseInt(hex[1] + hex[1], 16);
    b = parseInt(hex[2] + hex[2], 16);
  } else if (hex.length === 6) {
    r = parseInt(hex.slice(0, 2), 16);
    g = parseInt(hex.slice(2, 4), 16);
    b = parseInt(hex.slice(4, 6), 16);
  } else {
    return "#ffffff";
  }
  if ([r, g, b].some(v => isNaN(v))) return "#ffffff";
  // Relative luminance (sRGB → linear). Channels normalised to 0..1.
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return luminance > 0.179 ? "#1c1917" : "#ffffff";
}

// Shallow clone of an edge object — used wherever we snapshot edges into an
// undo entry. Centralised so adding a new edge field doesn't require hunting
// through every undo path.
export function cloneEdgeForUndo(edge: Edge): Pick<Edge, "from" | "to" | "effect" | "elasticity" | "description"> {
  return {
    from: edge.from,
    to: edge.to,
    effect: edge.effect,
    elasticity: edge.elasticity,
    description: edge.description,
  };
}

// Shallow clone of a node object — same role as cloneEdgeForUndo, for nodes.
export function cloneNodeForUndo(node: GraphNode): GraphNode {
  return Object.assign({}, node);
}

// ───── Simulation effect fills ────────────────────────────────────────────
// In simulation mode a box's body stops saying what KIND of box it is and says
// what the run did to it: the hue is whether the map calls the move good, bad,
// or simply a move it has no view on; the distance from grey is how big the
// move was against the biggest one on the map (07-simulation-engine's
// nodeEffect works that out). Grey is a box that has not moved.
//
// Literal hex, not theme variables — for the same reason the category fills are
// literal. A box body is a light chip carrying dark text in BOTH themes, so a
// fill that followed the theme would flip to a dark chip in light mode and take
// the label's contrast with it. (Deltas, borders and the atlas circles are
// chrome rather than chips, and those do follow the theme.)
export const SIM_FLAT_FILL = "#8b8e98";   // hasn't moved
export const SIM_INK = "#1c1917";         // label colour on any fill below

// Each merit runs from a pastel (a small move) to a deeper version of itself (a
// big one). Green / red match the good / bad language used everywhere else;
// amber is "it moved, and the map has no view on whether that is good" — a box
// with no direction of merit set.
const SIM_HUES: Record<string, [string, string]> = {
  good: ["#9ed1b4", "#4fc493"],
  bad:  ["#e3a3a8", "#e0727e"],
  none: ["#e6c79c", "#dfa147"],
};
// Where the pastel sits on the ramp: below this the colour is a blend of grey
// and the pastel, above it the pastel deepens. Two stops rather than one
// because a single grey→deep blend spent most of its length in muddy middles.
const SIM_PASTEL_AT = 0.6;

function hexToRgb(hex: string): [number, number, number] {
  const h = String(hex).trim().replace(/^#/, "");
  const full = h.length === 3 ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2] : h;
  return [
    parseInt(full.slice(0, 2), 16) || 0,
    parseInt(full.slice(2, 4), 16) || 0,
    parseInt(full.slice(4, 6), 16) || 0,
  ];
}

/** Blend two hex colours; t = 0 is `a`, t = 1 is `b`. Returns #rrggbb. */
export function mixHex(a: string, b: string, t: number): string {
  const A = hexToRgb(a), B = hexToRgb(b);
  const f = Math.max(0, Math.min(1, t));
  const ch = (i: number) => {
    const v = Math.round(A[i] + (B[i] - A[i]) * f);
    return (v < 16 ? "0" : "") + v.toString(16);
  };
  return "#" + ch(0) + ch(1) + ch(2);
}

/** The fill for a box that HAS moved. `strength` is nodeEffect's 0..1. */
export function simEffectFill(merit: string, strength: number): string {
  const [pastel, deep] = SIM_HUES[merit] || SIM_HUES.none;
  const s = Math.max(0, Math.min(1, strength));
  return s <= SIM_PASTEL_AT
    ? mixHex(SIM_FLAT_FILL, pastel, 0.18 + (s / SIM_PASTEL_AT) * 0.82)
    : mixHex(pastel, deep, (s - SIM_PASTEL_AT) / (1 - SIM_PASTEL_AT));
}
