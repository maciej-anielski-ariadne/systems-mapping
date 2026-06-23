// =============================================================================
// UTILITY HELPERS — small functions used in many places
// -----------------------------------------------------------------------------
// Small helpers:
//   • wrapLabel       – split a node label across two lines if it's too long
//   • escapeHtml      – make user text safe to inject into HTML/SVG strings
//   • formatScalar    – format a number for display ("9,000", "1.25", etc.)
//   • getMapTextScale – font-scale multiplier for the map when zoomed out
// =============================================================================

import { TEXT_SCALE_MAX, TEXT_SCALE_RATIO } from "./02-config";
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

// The cubic-bezier "M…C…" path for an edge from one node box to another.
// FORWARD edges (target clearly to the right) leave the source's right side and
// enter the target's left side with horizontal tangents — unchanged. BACKWARD /
// feedback edges (target left of, or vertically level with, the source) would
// double back over the forward edges and read as identical, so they re-route as
// a wide separated arc: both ends anchor on the same horizontal face (top or
// bottom) and the curve bows away from the grid to clear the nodes between them.
// The arrow marker is orient="auto-start-reverse" (see 11-rendering.ts) so the
// arrowhead follows the new end tangent for free — do NOT touch the marker.
// Shared by the live renderer and the export so the curve math lives in one place.
export function edgeBezierPath(fromPos: NodePosition, toPos: NodePosition): string {
  const fromMidX = fromPos.x + fromPos.width / 2;
  const fromMidY = fromPos.y + fromPos.height / 2;
  const toMidX   = toPos.x + toPos.width / 2;
  const toMidY   = toPos.y + toPos.height / 2;

  const startXfwd = fromPos.x + fromPos.width;   // source right side (forward anchor)
  const endXfwd   = toPos.x;                      // target left side (forward anchor)
  const BACK_MARGIN = 24;                         // hair of slack before flipping
  const isBackward = endXfwd < startXfwd + BACK_MARGIN;

  if (!isBackward) {
    // ── Forward: right side → left side, horizontal tangents (unchanged) ──
    const startX = startXfwd;
    const startY = fromMidY;
    const endX   = endXfwd;
    const endY   = toMidY;
    const ctrlOffset = Math.max(40, Math.abs(endX - startX) * 0.5);
    return "M " + startX + "," + startY +
           " C " + (startX + ctrlOffset) + "," + startY +
           " " + (endX - ctrlOffset) + "," + endY +
           " " + endX + "," + endY;
  }

  // ── Backward / feedback: bow off one horizontal face so the arc separates
  // from the left-to-right forward edges. Bow UP by default; bow DOWN when the
  // target sits clearly below the source so the arc opens away from the
  // descending flow (and same-column pairs don't collide). SVG y grows down.
  const dy = toMidY - fromMidY;
  const bowUp = dy <= 0;                          // tie (same row) bows up

  const startX = fromMidX;
  const startY = bowUp ? fromPos.y : fromPos.y + fromPos.height;
  const endX   = toMidX;
  const endY   = bowUp ? toPos.y : toPos.y + toPos.height;

  const spanX = Math.abs(endX - startX);
  const spanY = Math.abs(endY - startY);
  // Bow height: clears a node row at minimum, grows with the longer span, capped
  // so a cross-map feedback doesn't fly off the canvas.
  const bow = Math.min(260, Math.max(60, spanX * 0.28 + spanY * 0.6));
  const dir = bowUp ? -1 : 1;                     // -1 = up (smaller y), +1 = down
  const ctrlSplay = Math.max(30, spanX * 0.1);    // keep the arc rounded, not pinched

  const c1x = startX - ctrlSplay;
  const c1y = startY + dir * bow;
  const c2x = endX + ctrlSplay;
  const c2y = endY + dir * bow;

  return "M " + startX + "," + startY +
         " C " + c1x + "," + c1y +
         " " + c2x + "," + c2y +
         " " + endX + "," + endY;
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
