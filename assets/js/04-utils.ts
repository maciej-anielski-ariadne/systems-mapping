// =============================================================================
// UTILITY HELPERS — small functions used in many places
// -----------------------------------------------------------------------------
// Small helpers:
//   • wrapLabel       – split a node label across two lines if it's too long
//   • escapeHtml      – make user text safe to inject into HTML/SVG strings
//   • formatScalar    – format a number for display ("9,000", "1.25", etc.)
//   • getMapTextScale – font-scale multiplier for the map when zoomed out
// =============================================================================

import {
  TEXT_SCALE_MAX,
  TEXT_SCALE_RATIO,
  FAN_SPACING,
  FAN_MARGIN,
  BACK_STUB,
  BACK_CORNER_R,
  BACK_LANE_GAP,
  BACK_CHANNEL_INSET,
} from "./02-config";
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
export function formatScalar(value: number): string {
  const absValue = Math.abs(value);
  if (absValue >= 1e9)    return (value / 1e9).toFixed(2);
  if (absValue >= 10000)  return Math.round(value).toLocaleString();
  if (absValue >= 100)    return Math.round(value).toString();
  if (absValue >= 10)     return value.toFixed(1);
  if (absValue >= 1)      return value.toFixed(2);
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
// still counts as "backward". Shared by isBackwardEdge so the path builder, the
// lane assignment, and the renderer's class tagging can never drift apart.
const BACK_MARGIN = 24;

// Does this edge run BACKWARD — i.e. its target sits left of, or only
// marginally right of, the source, so a straight forward curve would double
// back over the flow? The single source of truth for "is this a feedback edge".
export function isBackwardEdge(fromPos: NodePosition, toPos: NodePosition): boolean {
  return toPos.x < fromPos.x + fromPos.width + BACK_MARGIN;
}

// Direction + base Y for a backward edge's routing channel, derived purely from
// the node boxes (no layout lookup needed). Bow UP — into the gap above the
// higher node — by default; bow DOWN below the lower node when the target sits
// clearly below the source, so the return opens away from the descending flow
// (and same-column pairs don't collide). SVG y grows downward, so dir −1 is up.
interface FeedbackBand { dir: -1 | 1; base: number; }
function feedbackBand(fromPos: NodePosition, toPos: NodePosition): FeedbackBand {
  const fromMidY = fromPos.y + fromPos.height / 2;
  const toMidY   = toPos.y + toPos.height / 2;
  const down = toMidY - fromMidY > Math.max(fromPos.height, toPos.height) * 0.5;
  if (down) {
    const bottom = Math.max(fromPos.y + fromPos.height, toPos.y + toPos.height);
    return { dir: 1, base: bottom + BACK_CHANNEL_INSET };
  }
  const top = Math.min(fromPos.y, toPos.y);
  return { dir: -1, base: top - BACK_CHANNEL_INSET };
}

// The channel Y for lane `laneOffset` (1 = closest to the nodes) within a band.
function feedbackChannelY(band: FeedbackBand, base: number, laneOffset: number): number {
  return base + band.dir * laneOffset * BACK_LANE_GAP;
}

// Build a single orthogonal path through `pts` with rounded corners. Each
// interior vertex is softened with a quadratic bevel (`Q`) whose control point
// is the sharp corner and whose end point is `radius` along the outgoing
// segment — pure string math (no arc sweep flags), so it renders identically in
// the live SVG and the export. The first and last segments stay straight, so a
// caller that makes them horizontal keeps clean horizontal end tangents.
function roundedOrthogonalPath(pts: { x: number; y: number }[], radius: number): string {
  // Drop consecutive duplicates so a zero-length segment can't break the corner
  // math (happens when a stub collapses on a near-coincident pair).
  const p: { x: number; y: number }[] = [];
  for (const q of pts) {
    const last = p[p.length - 1];
    if (!last || last.x !== q.x || last.y !== q.y) p.push(q);
  }
  const r2 = (n: number): number => Math.round(n * 100) / 100;
  if (p.length === 1) return "M " + p[0].x + "," + p[0].y;

  let d = "M " + p[0].x + "," + p[0].y;
  for (let i = 1; i < p.length - 1; i++) {
    const a = p[i - 1], b = p[i], c = p[i + 1];
    const lenIn  = Math.hypot(b.x - a.x, b.y - a.y);
    const lenOut = Math.hypot(c.x - b.x, c.y - b.y);
    const r = Math.min(radius, lenIn / 2, lenOut / 2);
    const pre  = { x: b.x - (b.x - a.x) / lenIn * r,  y: b.y - (b.y - a.y) / lenIn * r };
    const post = { x: b.x + (c.x - b.x) / lenOut * r, y: b.y + (c.y - b.y) / lenOut * r };
    d += " L " + r2(pre.x) + "," + r2(pre.y) +
         " Q " + r2(b.x) + "," + r2(b.y) + " " + r2(post.x) + "," + r2(post.y);
  }
  const last = p[p.length - 1];
  return d + " L " + last.x + "," + last.y;
}

// Orthogonal "return" path for a BACKWARD / feedback edge: a short horizontal
// stub out of the source's right face, up (or down) into the routing channel at
// `channelY`, across, then down (or up) into the target's left face — with
// rounded corners. EVERY edge still exits the source's right and enters the
// target's left, both via horizontal stubs, so the arrowhead (marker
// orient="auto-start-reverse") still points rightward into the left face — do
// NOT touch the marker. Layout-free: the lane-specific `channelY` is resolved by
// computeBackEdgeLanes and passed in. Shared by the live renderer and export.
export function edgeFeedbackPath(
  fromPos: NodePosition,
  toPos: NodePosition,
  channelY: number,
  fromYOffset = 0,
  toYOffset = 0,
): string {
  const sy = fromPos.y + fromPos.height / 2 + fromYOffset;   // source mid (fanned)
  const ey = toPos.y + toPos.height / 2 + toYOffset;         // target mid (fanned)
  const sx = fromPos.x + fromPos.width;                      // source right face
  const ex = toPos.x;                                        // target left face

  const x1 = sx + BACK_STUB;   // end of the source exit stub (points right)
  const x2 = ex - BACK_STUB;   // start of the target entry stub (points right)
  return roundedOrthogonalPath([
    { x: sx, y: sy },
    { x: x1, y: sy },
    { x: x1, y: channelY },
    { x: x2, y: channelY },
    { x: x2, y: ey },
    { x: ex, y: ey },
  ], BACK_CORNER_R);
}

// The cubic-bezier "M…C…" path for an edge from one node box to another.
// EVERY edge leaves the source's right side and enters the target's left side —
// one consistent invariant, so arrowheads always point rightward into the left
// face. FORWARD edges (target clearly to the right) connect with horizontal
// tangents directly. BACKWARD / feedback edges route AROUND via edgeFeedbackPath
// (see there). The arrow marker is orient="auto-start-reverse" (see
// 11-rendering.ts) so the arrowhead follows the horizontal end tangent for free
// — do NOT touch the marker. Shared by the live renderer and the export so the
// curve math lives in one place.
//
// When called for a backward edge WITHOUT an explicit channel (the lone-edge
// path: tests and any caller that hasn't run computeBackEdgeLanes), it derives a
// default single-lane channel from the node extents so the edge still routes
// neatly; callers that fan parallel returns pass the lane's channelY to
// edgeFeedbackPath directly.
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
  if (isBackwardEdge(fromPos, toPos)) {
    const band = feedbackBand(fromPos, toPos);
    return edgeFeedbackPath(fromPos, toPos, feedbackChannelY(band, band.base, 1), fromYOffset, toYOffset);
  }

  // ── Forward: right side → left side, horizontal tangents ──
  const startX = fromPos.x + fromPos.width;
  const startY = fromPos.y + fromPos.height / 2 + fromYOffset;
  const endX   = toPos.x;
  const endY   = toPos.y + toPos.height / 2 + toYOffset;
  const ctrlOffset = Math.max(40, Math.abs(endX - startX) * 0.5);
  return "M " + startX + "," + startY +
         " C " + (startX + ctrlOffset) + "," + startY +
         " " + (endX - ctrlOffset) + "," + endY +
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

// Per-edge feedback-routing decision, parallel by index to the edge array:
// whether the edge is backward, and (if so) the Y of the channel its "return"
// path should run along. Computed once per render — like computeEdgeAnchorOffsets
// — because the renderer iterates edges twice and recomputing per-edge would be
// wasteful and could disagree between passes. Shared by the live renderer (11)
// and the export (19) via the accessor callbacks.
export interface BackEdgeLane { isBackward: boolean; channelY: number; }

// Assign backward edges to stacked LANES so several feedback returns sharing a
// region read as neat parallel lines instead of overlapping balloons. Backward
// edges are grouped into channel bands (by bow direction + a coarse base Y);
// within a band they share one base line and fan into lanes. The widest loop
// takes the OUTERMOST lane (furthest from the nodes) so nested loops nest like
// contour lines and never cross. Forward edges get { isBackward:false } and are
// left untouched. Deterministic — independent of edge insertion order.
export function computeBackEdgeLanes<T>(
  edges: T[],
  positions: Record<string, NodePosition>,
  getFrom: (e: T) => string,
  getTo: (e: T) => string,
): BackEdgeLane[] {
  const result: BackEdgeLane[] = edges.map(() => ({ isBackward: false, channelY: 0 }));

  interface Item { i: number; band: FeedbackBand; span: number; sy: number; ey: number; }
  const groups: Record<string, Item[]> = {};
  edges.forEach((e, i) => {
    const fromPos = positions[getFrom(e)];
    const toPos   = positions[getTo(e)];
    if (!fromPos || !toPos || !isBackwardEdge(fromPos, toPos)) return;
    const band = feedbackBand(fromPos, toPos);
    const item: Item = {
      i, band,
      span: Math.abs((fromPos.x + fromPos.width) - toPos.x),
      sy: fromPos.y + fromPos.height / 2,
      ey: toPos.y + toPos.height / 2,
    };
    // Coarse band key: same bow direction and a base within ~2 lanes group
    // together, so nearby returns stack while far-apart ones route locally.
    const key = band.dir + ":" + Math.round(band.base / (BACK_LANE_GAP * 2));
    (groups[key] ||= []).push(item);
  });

  for (const key in groups) {
    const g = groups[key];
    const dir = g[0].band.dir;
    // One shared base line for the whole band: the most-outward member's base,
    // so every lane references the same channel and they can't overlap.
    const sharedBase = dir < 0
      ? Math.min(...g.map(it => it.band.base))
      : Math.max(...g.map(it => it.band.base));
    // Widest span first → outermost lane (largest offset, furthest from nodes).
    g.sort((a, b) => b.span - a.span || a.sy - b.sy || a.ey - b.ey || a.i - b.i);
    const m = g.length;
    g.forEach((it, rank) => {
      const laneOffset = m - rank;   // rank 0 (widest) → m (furthest)
      result[it.i] = { isBackward: true, channelY: feedbackChannelY(it.band, sharedBase, laneOffset) };
    });
  }

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

// Longest shortest-path distance (in hops) reachable downstream from any start
// node, following `neighbors(id) => id[]`. This is the graph's effective
// "diameter" in the downstream direction and serves as the dynamic cap for the
// highlight-depth control — past it, raising the depth reveals nothing further.
// Shared by the live map (09-graph-selection.ts, over the whole graph) and the
// published export viewer's cap (19-export.ts, over the published subset).
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
// fill the user picks. Uses the WCAG relative-luminance crossover (~0.179):
// light fills get dark text, dark fills get white. Accepts #rgb / #rrggbb;
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
