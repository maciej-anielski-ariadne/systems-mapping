// =============================================================================
// EXPORT — canvas → clipboard image and view-only HTML
// -----------------------------------------------------------------------------
// Two public entry points, wired to the header buttons in 17-events.js:
//   • exportCanvasImage()  → copies the canvas to the clipboard as a PNG image
//   • publishCanvasHtml()  → downloads a self-contained, view-only .html viewer
//
// Both share buildExportModel(), which decides WHAT to draw and reflows it:
//
//   What:  • If a single node is selected → only the highlighted nodes + edges
//            (selected + ancestors/descendants out to state.highlightDepth).
//          • Otherwise → every node currently visible inside the scroll
//            viewport (so the user frames the export by zooming / panning),
//            falling back to the whole filtered map when the viewport can't
//            be measured or already contains the whole map.
//
//   How:   the selection only chooses WHAT to include — never HOW it looks.
//          Everything renders in the map's normal, un-highlighted style (no
//          selection-trace borders, no bold/effect-coloured edges).
//
//   Reflow (always): empty stage columns and stream rows are dropped, and the
//   surviving stream rows are reordered so heavily-connected streams sit
//   adjacent — bringing far-apart but connected nodes closer together. Stage
//   columns keep their left→right order; the grid meaning is preserved.
//
// The rendered SVG is fully self-contained: every colour is resolved from the
// CSS custom properties to a literal value, and the only fonts used are the
// system stack (Arial/Helvetica/sans-serif) the map already uses — so the
// output needs no external CSS, fonts, or scripts.
// =============================================================================

import type { GraphNode, Edge, Stream, StageWithIndex, NodePosition } from "./types";
import {
  COL_GAP,
  COL_HEADER_HEIGHT,
  LABEL_INSET,
  NODE_GAP_Y,
  NODE_HEIGHT,
  NODE_WIDTH,
  ROW_HEADER_WIDTH,
  ROW_PADDING,
  SVG_PADDING_BOTTOM,
  SVG_PADDING_LEFT,
  SVG_PADDING_RIGHT,
  SVG_PADDING_TOP,
} from "./02-config";
import {
  CATEGORIES,
  EDGES,
  NODES,
  STAGES,
  STREAMS,
  layout,
  nodeById,
  stageById,
  state,
  streamById,
} from "./03-state";
import {
  computeEdgeAnchorOffsets,
  deltaColorFor,
  edgeBezierPath,
  effectMarkerName,
  escapeHtml,
  maxReachableDepth,
  measureLabelLines,
  nodeCategoryIds,
} from "./04-utils";
import {
  formatNodeDelta,
  formatNodeValue,
  getOutcomeBorderColor,
} from "./07-simulation-engine";
import { measureNode, packColumns, packRows, rowHeightFor, stackHeight } from "./08-layout";
import { isEdgeVisible, isNodeVisible } from "./10-filters";
import { currentRoute } from "./09a-pathways";
import { computeRenderEdges } from "./10a-collapsed-edges";
import { nodePrimaryFill, nodeSecondaryChips } from "./11-rendering";
import { showLoadFeedback } from "./16-file-io";

// ───── Resolved theme palette (literal colour values) ──────────────────────
interface ExportPalette {
  bgDeep: string;
  bgDeepest: string;
  bgLight: string;
  borderSubtle: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  edgeDefault: string;
  edgeIncreases: string;
  edgeDecreases: string;
  edgeEnables: string;
  statusGood: string;
  statusBad: string;
  // Highlight colours used by the interactive published viewer (resolved to
  // literals so the self-contained file needs no CSS custom properties).
  edgeAncestor: string;
  edgeDescendant: string;
}

// ───── Packed export layout ─────────────────────────────────────────────────
interface ExportLayout {
  positions: Record<string, NodePosition>;
  totalWidth: number;
  totalHeight: number;
  rowY: Record<string, number>;
  rowHeights: Record<string, number>;
  colX: Record<string, number>;
}

// A drawable edge in an export — the common shape of a REAL edge and a SYNTHETIC
// "through" connector (visible → hidden… → visible, see 10a-collapsed-edges.ts).
// The export draws and re-traces both, so collapsing a stage produces the same
// rerouted arrows the live map shows instead of dropping the link entirely.
export interface ExportEdge {
  id: string;
  from: string;
  to: string;
  effect: string;
  style?: "solid" | "dashed";
  synthetic: boolean;
}

// ───── Assembled export model ───────────────────────────────────────────────
interface ExportModel {
  nodeIds: Set<string>;
  edges: ExportEdge[];
  selectionActive: boolean;
  stageIds: string[];
  streamOrder: string[];
  layout: ExportLayout;
}

// The id the published viewer's JS uses to reach its <svg>. renderExportSvg can
// stamp it at build time (see its `svgId` option), which is why it lives next to
// the other export-wide constants rather than inside buildPublishHtml.
export const PUBLISH_SVG_ID = "mv-svg";

// A literal closing-script tag would break this file once build-dist.py
// inlines it into a single HTML page, so assemble the closing tag from pieces
// (its bytes never contain the contiguous closing sequence).
export const EXPORT_CLOSE_SCRIPT = "<" + "/script>";

// Monotonic counter for unique per-node gradient ids in the export SVG.
export let _xnodeGradSeq = 0;

// ───── Resolve the live theme's colours to literal values ──────────────────
export function exportPalette(): ExportPalette {
  const root = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string): string => {
    const raw = (root.getPropertyValue(name) || "").trim();
    return raw || fallback;
  };
  return {
    bgDeep:        v("--bg-deep",        "#111827"),
    bgDeepest:     v("--bg-deepest",     "#0a0e1a"),
    bgLight:       v("--bg-light",       "#232a3d"),
    borderSubtle:  v("--border-subtle",  "#2a3346"),
    textPrimary:   v("--text-primary",   "#e7ecf3"),
    textSecondary: v("--text-secondary", "#a1adc4"),
    textTertiary:  v("--text-tertiary",  "#6b7691"),
    edgeDefault:   v("--edge-default",   "#3a455e"),
    edgeIncreases: v("--edge-increases", "#9ed1b4"),
    edgeDecreases: v("--edge-decreases", "#e3a3a8"),
    edgeEnables:   v("--edge-enables",   "#bfaede"),
    statusGood:    v("--status-good",    "#10b981"),
    statusBad:     v("--status-bad",     "#f87171"),
    edgeAncestor:  v("--edge-ancestor",  "#8fb6d9"),
    edgeDescendant:v("--edge-descendant","#4d6783"),
  };
}

// A real Edge as an ExportEdge.
function realExportEdge(e: Edge): ExportEdge {
  return { id: e.id!, from: e.from, to: e.to, effect: e.effect || "", style: e.style, synthetic: false };
}

// ───── Which nodes/edges to include ────────────────────────────────────────
// Returns { nodeIds:Set, edges:[ExportEdge], selectionActive:bool }.
// `allEdges` (used by the interactive published HTML) includes every edge among
// the chosen nodes rather than only the ones highlighted by the current depth —
// so the published viewer can re-trace connections itself as the user clicks.
export function getExportSelection(allEdges = false): { nodeIds: Set<string>; edges: ExportEdge[]; selectionActive: boolean } {
  // A strand beats every other scoping rule. Pathway mode says "this chain is
  // the thing I care about", and exporting it is how that chain outlives the
  // session — it is the only form of persistence the feature has, since the
  // pathway itself is deliberately never saved (see 09a-pathways.ts).
  //
  // `allEdges` is ignored here on purpose. Everywhere else it means "include
  // every link among the exported boxes", which for a strand would draw the
  // shortcuts the user just spent a trace narrowing away — the export would no
  // longer be the strand. What comes out is exactly the chain: its boxes, its
  // links, in order.
  const route = currentRoute();
  if (route) {
    const ids = new Set<string>(route.nodeIds);
    const onRoute = new Set<string>(route.edgeIds);
    const edges = EDGES
      .filter(e => onRoute.has(e.id!))
      .map(realExportEdge);
    return { nodeIds: ids, edges, selectionActive: true };
  }

  const singleSelected = state.selectedNodeId &&
    (!state.selectedNodeIds || state.selectedNodeIds.size <= 1);

  if (singleSelected) {
    const ids = new Set<string>([state.selectedNodeId!]);
    if (state.ancestorSet)   state.ancestorSet.forEach(id => ids.add(id));
    if (state.descendantSet) state.descendantSet.forEach(id => ids.add(id));
    // Every edge among the chosen nodes (interactive), or only the edges
    // highlighted by the current highlight depth (static image / default).
    // The trace already spans collapsed stages (it walks the full graph), so
    // every node here gets a real box — no synthetic rerouting needed.
    const edges = EDGES
      .filter(e =>
        ids.has(e.from) && ids.has(e.to) && isEdgeVisible(e) &&
        (allEdges || (state.highlightedEdgeIds && state.highlightedEdgeIds.has(e.id!))))
      .map(realExportEdge);
    return { nodeIds: ids, edges, selectionActive: true };
  }

  // No single selection → frame the export on what the user can actually see:
  // every box passing the sidebar visibility filters whose layout rect overlaps
  // the scroll viewport, so zooming / panning chooses the crop.
  //
  // Fall back to the WHOLE filtered map whenever framing would be meaningless
  // or misleading:
  //   • no scroll container, or it reports a zero-size / non-finite viewport
  //     (headless DOM, hidden panel, a browser mid-layout) — cropping to an
  //     unknown rectangle would silently export nothing;
  //   • the whole map already fits inside the viewport — nothing to crop.
  const frame = exportViewportFrame();
  const ids = new Set<string>();
  for (const node of NODES) {
    if (!isNodeVisible(node)) continue;
    const pos = layout.positions[node.id];
    if (!pos) continue;                       // nodes in collapsed stages have no position
    if (frame && !rectsOverlap(frame, pos)) continue;
    ids.add(node.id);
  }
  // Draw exactly what the live map draws: real edges between visible nodes PLUS
  // the synthetic "through" arrows that reroute a chain across a collapsed
  // stage (computeRenderEdges, shared with 11-rendering). Honour the same
  // sidebar edge filters the renderer applies, then keep only edges whose
  // endpoints are BOTH inside the framed viewport (an arrow with one end off
  // the crop has nothing to point at, so it is dropped rather than left
  // dangling — the same rule the selection branch above uses).
  const edges: ExportEdge[] = [];
  for (const re of computeRenderEdges()) {
    if (!ids.has(re.from) || !ids.has(re.to)) continue;
    if (re.synthetic) {
      if (state.hiddenEffects.has(re.effect)) continue;
      if (state.hiddenStyles.has(re.dashed ? "dashed" : "solid")) continue;
      edges.push({ id: re.id, from: re.from, to: re.to, effect: re.effect, style: re.dashed ? "dashed" : "solid", synthetic: true });
    } else {
      if (!isEdgeVisible(re.edge)) continue;
      edges.push(realExportEdge(re.edge));
    }
  }
  return { nodeIds: ids, edges, selectionActive: false };
}

// The currently-visible region of the map, in unscaled layout coordinates
// (the scroll container scrolls the zoom-scaled SVG, so divide by zoom).
export function visibleLayoutRect(): { x: number; y: number; width: number; height: number } | null {
  const scrollEl = document.getElementById("viz-scroll");
  if (!scrollEl) return null;
  const zoom = (state.zoomLevel && !isNaN(state.zoomLevel)) ? state.zoomLevel : 1.0;
  return {
    x:      scrollEl.scrollLeft  / zoom,
    y:      scrollEl.scrollTop   / zoom,
    width:  scrollEl.clientWidth / zoom,
    height: scrollEl.clientHeight/ zoom,
  };
}
export function rectsOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
): boolean {
  return a.x < b.x + b.width  && a.x + a.width  > b.x &&
         a.y < b.y + b.height && a.y + a.height > b.y;
}

// The rectangle an unselected export should crop to, or null for "don't crop"
// (export the whole filtered map). Null whenever the viewport can't be trusted
// — no scroll container, a zero / non-finite size (headless DOM, hidden panel) —
// or when the entire map already fits on screen, in which case cropping would
// be a no-op anyway. Keeping the fallback in one place means every caller
// degrades to the same, safe whole-map behaviour.
export function exportViewportFrame(): { x: number; y: number; width: number; height: number } | null {
  const vp = visibleLayoutRect();
  if (!vp) return null;
  if (!isFinite(vp.width) || !isFinite(vp.height) || vp.width <= 0 || vp.height <= 0) return null;
  if (!isFinite(vp.x) || !isFinite(vp.y)) return null;
  // Whole map on screen → nothing to frame.
  if (vp.width >= layout.totalWidth && vp.height >= layout.totalHeight) return null;
  return vp;
}

// ───── Reorder stream rows to minimise edge length ─────────────────────────
// In plain terms: when exporting, we re-stack the rows so that rows with lots of
// arrows between them sit next to each other — that makes the arrows shorter and
// the picture tidier. We don't search every possible ordering (too many); we use
// a quick "good enough" rule, called a greedy approach: always grab the strongest
// remaining connection next.
//
// How: count the arrows between each pair of rows (their "tie" strength). Start a
// chain from the most-connected pair, then keep extending it at either end by
// adding whichever leftover row is most strongly tied to an end. When the chain
// can't grow, start a fresh chain from the next strongest pair — so every cluster
// of related rows gets grouped, not just the first. Clusters come out strongest-
// first; rows with no cross-row arrows keep their original order at the end. The
// result is the same every time (ties broken by original position).
export function orderExportStreams(streamIds: string[], edges: ExportEdge[]): string[] {
  const present = streamIds.slice();
  const n = present.length;
  if (n <= 2) return present;

  const idx = new Map<string, number>(present.map((s, i) => [s, i]));
  const W = present.map(() => new Array<number>(n).fill(0));
  for (const e of edges) {
    const a = nodeById[e.from] && nodeById[e.from].stream;
    const b = nodeById[e.to]   && nodeById[e.to].stream;
    if (a == null || b == null || a === b) continue;
    if (!idx.has(a) || !idx.has(b)) continue;
    const i = idx.get(a)!, j = idx.get(b)!;
    W[i][j] += 1; W[j][i] += 1;
  }

  const placed = new Array<boolean>(n).fill(false);
  const order: number[] = [];

  // Strongest-weighted unplaced neighbour of `node` (ties → lowest index).
  const strongestUnplaced = (node: number): { k: number; w: number } => {
    let bestK = -1, bestW = 0;
    for (let k = 0; k < n; k++) {
      if (placed[k]) continue;
      if (W[node][k] > bestW || (W[node][k] === bestW && bestW > 0 && (bestK === -1 || k < bestK))) {
        bestW = W[node][k]; bestK = k;
      }
    }
    return { k: bestK, w: bestW };
  };

  while (order.length < n) {
    // Seed: heaviest edge among the still-unplaced streams.
    let bi = -1, bj = -1, bw = 0;
    for (let i = 0; i < n; i++) {
      if (placed[i]) continue;
      for (let j = i + 1; j < n; j++) {
        if (placed[j]) continue;
        if (W[i][j] > bw) { bw = W[i][j]; bi = i; bj = j; }
      }
    }
    if (bw <= 0) {                       // no edges left among unplaced streams
      for (let k = 0; k < n; k++) if (!placed[k]) order.push(k);
      break;
    }
    // Grow this cluster's chain on both ends until it can't extend.
    const chain = [bi, bj];
    placed[bi] = placed[bj] = true;
    for (;;) {
      const atHead = strongestUnplaced(chain[0]);
      const atTail = strongestUnplaced(chain[chain.length - 1]);
      if (atTail.w >= atHead.w && atTail.w > 0)      { placed[atTail.k] = true; chain.push(atTail.k); }
      else if (atHead.w > 0)                         { placed[atHead.k] = true; chain.unshift(atHead.k); }
      else break;
    }
    for (const c of chain) order.push(c);
  }
  return order.map(i => present[i]);
}

// ───── Packed layout over the included subset ──────────────────────────────
export function computeExportLayout(nodeIds: Set<string>, streamOrder: string[], stageIds: string[]): ExportLayout {
  // Group included nodes into cells, preserving each cell's current vertical
  // stacking order (so the reflow doesn't shuffle nodes within a cell).
  const cells: Record<string, GraphNode[]> = {};
  for (const node of NODES) {
    if (!nodeIds.has(node.id)) continue;
    const key = node.stream + ":" + node.stage;
    (cells[key] || (cells[key] = [])).push(node);
  }
  for (const key in cells) {
    cells[key].sort((a, b) => {
      const ya = layout.positions[a.id] ? layout.positions[a.id].y : 0;
      const yb = layout.positions[b.id] ? layout.positions[b.id].y : 0;
      return ya - yb;
    });
  }

  // Columns: packed left→right over the included stages only (always full
  // NODE_WIDTH — the export never draws collapsed-column stubs). Shares the
  // packing geometry with the live layout (08-layout).
  const { colX, totalWidth } = packColumns(stageIds, () => NODE_WIDTH);

  // Per-node grown height: reuse the live layout's measurement, falling back to
  // a fresh measure for any node without a live position (e.g. one in a stage
  // that's collapsed on the canvas but pulled into a selection export).
  const exHeight = (id: string): number => {
    const p = layout.positions[id];
    if (p && p.height) return p.height;
    const n = nodeById[id];
    return n ? measureNode(n).height : NODE_HEIGHT;
  };

  // Rows: each row's height is its tallest cell's summed stack (nodes grow to
  // fit their labels); then pack top→bottom over the reordered streams — both
  // via the shared 08-layout primitives, so export and canvas stay in lockstep.
  const rowHeights: Record<string, number> = {};
  for (const streamId of streamOrder) {
    let maxContent = 0;
    for (const stageId of stageIds) {
      const c = cells[streamId + ":" + stageId];
      if (!c || !c.length) continue;
      const sum = stackHeight(c.map(n => exHeight(n.id)));
      if (sum > maxContent) maxContent = sum;
    }
    rowHeights[streamId] = rowHeightFor(maxContent);
  }
  const { rowY, totalHeight } = packRows(streamOrder, rowHeights);

  const positions: Record<string, NodePosition> = {};
  for (const streamId of streamOrder) {
    for (const stageId of stageIds) {
      const c = cells[streamId + ":" + stageId];
      if (!c) continue;
      let y = rowY[streamId] + ROW_PADDING;
      for (let i = 0; i < c.length; i++) {
        const h = exHeight(c[i].id);
        const live = layout.positions[c[i].id];
        const lines = (live && live.labelLines) || measureLabelLines(c[i].label || c[i].id || "", NODE_WIDTH - LABEL_INSET * 2);
        positions[c[i].id] = { x: colX[stageId], y: y, width: NODE_WIDTH, height: h, labelLines: lines };
        y += h + NODE_GAP_Y;
      }
    }
  }
  return { positions, totalWidth, totalHeight, rowY, rowHeights, colX };
}

// ───── Assemble the export model ───────────────────────────────────────────
export function buildExportModel(opts?: { allEdges?: boolean }): ExportModel | null {
  if (!state.dataLoaded || !layout) return null;
  const sel = getExportSelection(opts && opts.allEdges);
  if (sel.nodeIds.size === 0) return null;

  const streamsPresent = new Set<string>(), stagesPresent = new Set<string>();
  for (const id of sel.nodeIds) {
    const nd = nodeById[id];
    if (!nd) continue;
    streamsPresent.add(nd.stream);
    stagesPresent.add(nd.stage);
  }
  const stageIds        = STAGES.filter(s => stagesPresent.has(s.id)).map(s => s.id);
  const includedStreams = STREAMS.filter(s => streamsPresent.has(s.id)).map(s => s.id);
  const streamOrder     = orderExportStreams(includedStreams, sel.edges);
  const exLayout        = computeExportLayout(sel.nodeIds, streamOrder, stageIds);

  return {
    nodeIds: sel.nodeIds,
    edges: sel.edges,
    selectionActive: sel.selectionActive,
    stageIds,
    streamOrder,
    layout: exLayout,
  };
}


// Outcome-status border colour (good/bad vs baseline) → literal palette value,
// or null. This is part of the map's normal resting appearance, not a
// selection highlight.
export function exportOutcomeBorder(nodeId: string, pal: ExportPalette): string | null {
  const c = getOutcomeBorderColor(nodeId);
  if (!c) return null;
  return c.indexOf("good") >= 0 ? pal.statusGood : pal.statusBad;
}

// Node border for an export. The selection only decides WHAT to export, never
// HOW it looks, so nodes always render in their normal, un-highlighted state:
// the default border, plus the good/bad outcome border the live map shows when
// nothing is selected — never the white / blue / amber selection-trace borders.
export function exportNodeStroke(nodeId: string, pal: ExportPalette): { color: string; width: number } {
  const outcome = exportOutcomeBorder(nodeId, pal);
  if (outcome) return { color: outcome, width: 2 };
  return { color: "rgba(0,0,0,0.4)", width: 1 };
}

// ───── Emitted-coordinate rounding ─────────────────────────────────────────
// Float arithmetic (fan offsets of span/(n-1), half-heights, bezier control
// points) produces coordinates like 2116.3333333333335 — 17 characters of
// noise per number, repeated twice per edge (casing + stroke) and several times
// per box. Rounding to 0.1px is invisible at any realistic zoom (a tenth of a
// CSS pixel, and the PNG raster is at most 3× density) but keeps the exported
// string honest and smaller.
//
// This deliberately lives here, on the strings/numbers the EXPORT emits: the
// shared geometry in 04-utils feeds the live renderer too and must not be
// perturbed.
const EXPORT_COORD_DECIMALS = 1;
const COORD_ROUND = Math.pow(10, EXPORT_COORD_DECIMALS);

// One emitted number, rounded. Integers (the common case) come back untouched.
function n1(v: number): number {
  return Math.round(v * COORD_ROUND) / COORD_ROUND;
}

// Round every over-precise number inside an already-built path string (the
// bezier `d` from 04-utils). Numbers with 0 or 1 decimals are left alone, so a
// path that is already clean is returned as-is.
function roundPathCoords(d: string): string {
  return d.replace(/-?\d+\.\d\d+/g, m => String(Math.round(Number(m) * COORD_ROUND) / COORD_ROUND));
}

// The export SVG's opening tag. `drawW/drawH` are the declared (CSS-pixel) size
// and `viewW/viewH` the internal coordinate system — the PNG rasterizer grows
// the former while keeping the latter, so both it and renderExportSvg build the
// tag from here rather than rewriting an existing header with .replace.
export function exportSvgOpenTag(
  viewW: number, viewH: number, drawW: number, drawH: number, id?: string
): string {
  return '<svg' + (id ? ' id="' + id + '"' : "") +
         ' xmlns="http://www.w3.org/2000/svg" width="' + drawW + '" height="' + drawH +
         '" viewBox="0 0 ' + viewW + ' ' + viewH + '">';
}

// ───── Render the model to a self-contained SVG string ─────────────────────
// Returns { svg, width, height, nodeInfo } where nodeInfo maps node id →
// metadata used by the published HTML viewer's hover tooltips.
export function renderExportSvg(
  model: ExportModel,
  opts?: { pal?: ExportPalette; transparent?: boolean; svgId?: string }
): { svg: string; width: number; height: number; nodeInfo: Record<string, Record<string, string>> } {
  _xnodeGradSeq = 0;   // restart per export
  opts = opts || {};
  const pal = opts.pal || exportPalette();
  // Clean, slide-ready variant: transparent background, no structural chrome
  // (stripes / dividers / band fills), edges in full-opacity effect colour with
  // arrowheads. Used by the PNG copy; the HTML viewer leaves this off.
  const transparent = !!opts.transparent;
  // effect → stroke colour + arrow-marker name (mirrors the live map's
  // effectStroke / effectMarker in 11-rendering.ts).
  const effectEdge = (effect: string): string =>
    effect === "increases" ? pal.edgeIncreases :
    effect === "decreases" ? pal.edgeDecreases :
    effect === "enables"   ? pal.edgeEnables   :
                             pal.edgeDefault;
  const effectMarker = effectMarkerName;
  const lay = model.layout;
  const W = n1(lay.totalWidth), H = n1(lay.totalHeight);
  const nodeInfo: Record<string, Record<string, string>> = {};

  // The id (used by the published viewer) is emitted here rather than patched
  // in afterwards with a whole-string .replace.
  let s = "";
  s += exportSvgOpenTag(W, H, W, H, opts.svgId);

  // Fonts + text sizing baked in (values mirror 05-visualization.css).
  s += '<style>'
     +   'text{font-family:Arial,Helvetica,sans-serif;}'
     +   '.xn-label{font-size:12px;font-weight:500;}'
     +   '.xn-value{font-size:10.5px;font-weight:500;}'
     +   '.xn-delta{font-size:10.5px;font-weight:600;}'
     +   '.xr-label{font-size:11px;font-weight:600;letter-spacing:0.1em;}'
     +   '.xc-header{font-size:11px;font-weight:600;letter-spacing:0.12em;}'
     + '</style>';

  // Arrowhead markers (one per effect colour) so edges can read direction,
  // mirroring the live map's highlighted style (11-rendering.js). Used by both
  // the transparent slide image and the interactive published HTML's highlight;
  // emitted once, and inert for any path that doesn't reference them.
  const markers: Array<[string, string]> = [
    ["default",   pal.edgeDefault],
    ["ancestor",  pal.edgeAncestor],
    ["increases", pal.edgeIncreases],
    ["decreases", pal.edgeDecreases],
    ["enables",   pal.edgeEnables],
  ];
  s += '<defs>';
  for (const [name, color] of markers) {
    s += '<marker id="xarrow_' + name + '" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">'
       +   '<path d="M 0 0 L 10 5 L 0 10 z" fill="' + color + '"></path>'
       + '</marker>';
  }
  s += '</defs>';

  // Background. The clean export is transparent (drops straight onto a slide),
  // so the solid backdrop and structural chrome below are skipped entirely.
  if (!transparent) {
    s += '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="' + pal.bgDeep + '"></rect>';

    // Per-stream background stripe + top divider.
    for (const streamId of model.streamOrder) {
      const stream = streamById[streamId] || ({ color: "#94a3b8" } as Stream);
      const y = n1(lay.rowY[streamId]), h = n1(lay.rowHeights[streamId]);
      s += '<rect x="0" y="' + y + '" width="' + W + '" height="' + h + '" fill="' + stream.color + '" opacity="0.04"></rect>';
      s += '<line x1="0" y1="' + y + '" x2="' + W + '" y2="' + y + '" stroke="' + pal.borderSubtle + '" stroke-width="1"></line>';
    }
  }

  // Column-header band + stage labels + vertical dividers. The clean export
  // keeps the stage labels but drops the band fill and dashed dividers.
  const headerBandBottom = SVG_PADDING_TOP + COL_HEADER_HEIGHT;
  if (!transparent) {
    s += '<rect x="0" y="0" width="' + W + '" height="' + headerBandBottom + '" fill="' + pal.bgDeep + '"></rect>';
  }
  for (let i = 0; i < model.stageIds.length; i++) {
    const stageId = model.stageIds[i];
    const stage = stageById[stageId] || ({ label: stageId } as StageWithIndex);
    const cx = n1(lay.colX[stageId] + NODE_WIDTH / 2);
    s += '<text class="xc-header" x="' + cx + '" y="' + (SVG_PADDING_TOP + 24) +
         '" text-anchor="middle" fill="' + pal.textSecondary + '">' + escapeHtml(stage.label) + '</text>';
    if (!transparent && i < model.stageIds.length - 1) {
      const dividerX = n1(lay.colX[stageId] + NODE_WIDTH + COL_GAP / 2);
      s += '<line x1="' + dividerX + '" y1="' + headerBandBottom + '" x2="' + dividerX + '" y2="' + H +
           '" stroke="' + pal.borderSubtle + '" stroke-width="1" stroke-dasharray="2 4" opacity="0.6"></line>';
    }
  }

  // Row-label strip (stream short codes).
  for (const streamId of model.streamOrder) {
    const stream = streamById[streamId] || ({ short: streamId, color: "#94a3b8" } as Stream);
    const y = n1(lay.rowY[streamId]), h = n1(lay.rowHeights[streamId]);
    if (!transparent) {
      s += '<rect x="0" y="' + y + '" width="' + ROW_HEADER_WIDTH + '" height="' + h + '" fill="' + pal.bgDeepest + '"></rect>';
    }
    s += '<rect x="' + (ROW_HEADER_WIDTH - 4) + '" y="' + y + '" width="4" height="' + h + '" fill="' + stream.color + '" opacity="0.7"></rect>';
    s += '<text class="xr-label" x="' + (ROW_HEADER_WIDTH / 2) + '" y="' + n1(y + h / 2) +
         '" text-anchor="middle" dominant-baseline="middle" fill="' + stream.color + '">' + escapeHtml(stream.short) + '</text>';
  }

  // Edges (drawn before nodes). Rendered in the map's normal, un-highlighted
  // style — gray, thin, semi-transparent, no arrowhead (exactly how the live
  // map draws an edge when nothing is selected). Effect colours and arrowheads
  // are the app's *highlight* state, so they are deliberately not used here.
  // Fan the anchors so several edges into/out of one node don't all land on the
  // same point — one anchor per (effect, style) bucket, matching the live map
  // (computeEdgeAnchorOffsets in 04-utils.js). Parallel by index to model.edges.
  const edgeOffsets = computeEdgeAnchorOffsets(
    model.edges,
    lay.positions,
    (e) => e.from,
    (e) => e.to,
    (e) => e.effect || "default",
    (e) => (e.style === "dashed" ? "dashed" : "solid"),
  );
  // Two buffers so every casing sits under every colour stroke (the transit-map
  // knockout gap at crossings / under-runs). The transparent slide has no
  // background to knock out against, so it gets fan-out only — a solid casing
  // would show as opaque halos on the transparent PNG; the published viewer
  // (drawn over pal.bgDeepest) gets both.
  let edgeCasings = "";
  let edgeStrokes = "";
  for (let i = 0; i < model.edges.length; i++) {
    const edge = model.edges[i];
    // Visibility / sidebar-filter culling already happened in getExportSelection
    // (which also added the synthetic through-edges for collapsed stages).
    const fromPos = lay.positions[edge.from], toPos = lay.positions[edge.to];
    if (!fromPos || !toPos) continue;
    const off = edgeOffsets[i];
    const pathD = roundPathCoords(edgeBezierPath(fromPos, toPos, off.fromYOffset, off.toYOffset));
    const dashAttr = edge.style === "dashed" ? ' stroke-dasharray="6 5"' : '';
    if (transparent) {
      // Full-colour, full-opacity edges with a directional arrowhead — the live
      // map's highlighted style, so the slide image reads effect and direction.
      edgeStrokes += '<path d="' + pathD + '" fill="none" stroke="' + effectEdge(edge.effect) +
           '" stroke-width="1.5" stroke-opacity="1" marker-end="url(#xarrow_' + effectMarker(edge.effect) + ')"' + dashAttr + '></path>';
    } else {
      // Background-coloured casing under the resting stroke (knockout gap).
      edgeCasings += '<path fill="none" stroke="' + pal.bgDeepest + '" stroke-width="3" d="' + pathD + '"></path>';
      // Neutral resting style + data-* attributes that drive the interactive
      // published viewer's re-tracing (inert for the static PNG export).
      edgeStrokes += '<path class="xedge" data-edge-id="' + escapeHtml(edge.id!) + '" data-from="' + escapeHtml(edge.from) +
           '" data-to="' + escapeHtml(edge.to) + '" data-effect="' + escapeHtml(edge.effect || "") +
           '" d="' + pathD + '" fill="none" stroke="' + pal.edgeDefault +
           '" stroke-width="1" stroke-opacity="0.45"' + dashAttr + '></path>';
    }
  }
  // Casings first (under every colour stroke), then the colours.
  s += edgeCasings + edgeStrokes;

  // Nodes.
  for (const node of NODES) {
    if (!model.nodeIds.has(node.id)) continue;
    const pos = lay.positions[node.id];
    if (!pos) continue;
    const stream   = streamById[node.stream]   || ({ color: "#94a3b8" } as Stream);
    const fillInfo = nodePrimaryFill(node, "xgrad_" + (_xnodeGradSeq++));
    const stroke   = exportNodeStroke(node.id, pal);
    // Round the box once, up front, and derive every emitted coordinate (and
    // the chips, which are placed off this rect) from the rounded values — so
    // the whole box stays internally consistent to the tenth of a pixel.
    const xpos = { x: n1(pos.x), y: n1(pos.y), width: n1(pos.width), height: n1(pos.height), labelLines: pos.labelLines };
    const chips    = nodeSecondaryChips(node, xpos);

    s += '<g class="xnode" data-node-id="' + escapeHtml(node.id) + '">';
    s += fillInfo.defs;   // per-node gradient (empty unless multi-primary)

    // Background rect (xn-bg lets the interactive viewer paint selection glows).
    s += '<rect class="xn-bg" x="' + xpos.x + '" y="' + xpos.y + '" width="' + xpos.width + '" height="' + xpos.height +
         '" rx="5" fill="' + fillInfo.fill + '" stroke="' + stroke.color + '" stroke-width="' + stroke.width + '"></rect>';

    // Left stream-colour stripe (rounded only on the left corners).
    const barRadius = 5, barLeft = xpos.x, barRight = n1(xpos.x + 6), barTop = xpos.y, barBottom = n1(xpos.y + xpos.height);
    const barInner = n1(barLeft + barRadius);
    s += '<path d="M ' + barInner + ',' + barTop +
         ' L ' + barRight + ',' + barTop +
         ' L ' + barRight + ',' + barBottom +
         ' L ' + barInner + ',' + barBottom +
         ' A ' + barRadius + ',' + barRadius + ' 0 0 1 ' + barLeft + ',' + n1(barBottom - barRadius) +
         ' L ' + barLeft + ',' + n1(barTop + barRadius) +
         ' A ' + barRadius + ',' + barRadius + ' 0 0 1 ' + barInner + ',' + barTop +
         ' Z" fill="' + stream.color + '"></path>';

    // Wrapped label — reuse the same grow-to-fit lines the layout sized the box
    // from, so the export matches the live map. Anchored at the symmetric inset.
    const labelLines = pos.labelLines || measureLabelLines(node.label || node.id || "", NODE_WIDTH - LABEL_INSET * 2);
    const lx = n1(xpos.x + LABEL_INSET);
    s += '<text class="xn-label" x="' + lx + '" y="' + n1(xpos.y + 16) +
         '" fill="' + fillInfo.textColor + '" dominant-baseline="middle">';
    for (let i = 0; i < labelLines.length; i++) {
      s += '<tspan x="' + lx + '" dy="' + (i === 0 ? "0" : "1.083em") + '">' + escapeHtml(labelLines[i]) + '</tspan>';
    }
    s += '</text>';

    // Value + delta (only for quantified nodes).
    const valueText = formatNodeValue(node.id);
    if (valueText) {
      const valueY = n1(xpos.y + xpos.height - 12);
      s += '<text class="xn-value" x="' + lx + '" y="' + valueY +
           '" fill="' + fillInfo.textColor + '" dominant-baseline="middle"' + (transparent ? '' : ' opacity="0.75"') + '>' + escapeHtml(valueText) + '</text>';
      const deltaInfo = formatNodeDelta(node.id);
      if (deltaInfo.text && deltaInfo.text !== "—") {
        const deltaColor = deltaColorFor(node, deltaInfo);
        const deltaX = n1(chips.svg ? chips.leftEdge - 6 : xpos.x + xpos.width - LABEL_INSET);
        s += '<text class="xn-delta" x="' + deltaX + '" y="' + valueY +
             '" fill="' + deltaColor + '" text-anchor="end" dominant-baseline="middle">' + escapeHtml(deltaInfo.text) + '</text>';
      }
    }

    // Secondary category chips (bottom-right).
    s += chips.svg;

    s += '</g>';

    // Tooltip metadata for the published viewer.
    nodeInfo[node.id] = {
      label:       node.label || node.id,
      description: node.description || "",
      value:       valueText || "",
      stream:      stream.label || node.stream || "",
      stage:       (stageById[node.stage] && stageById[node.stage].label) || node.stage || "",
      category:    nodeCategoryIds(node).map(id => (CATEGORIES[id] && CATEGORIES[id].label) || id).filter(Boolean).join(", "),
    };
  }

  s += '</svg>';
  return { svg: s, width: W, height: H, nodeInfo };
}

// ───── Download helper (generic text/binary-ish blob) ──────────────────────
export function downloadTextBlob(content: string, filename: string, mime?: string): void {
  const blob = new Blob([content], { type: mime || "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Target raster density. We render at this multiple of the map's natural size
// so the PNG stays crisp when displayed or printed much larger than 1:1.
export const EXPORT_PNG_SCALE = 3;
// Conservative canvas ceilings. A single side is capped at 16384px (Chrome's
// limit), and the TOTAL area at 64 megapixels — deliberately far below the
// per-side square (16384² = 268Mpx, ~1GB of RGBA backing store, which Safari
// simply refuses to allocate; iOS gives up around 16.7Mpx). 64Mpx is ~256MB
// peak and still covers an A0 sheet at 300dpi. Exceeding either ceiling yields
// a blank or failed canvas, so we back the density off instead.
export const EXPORT_MAX_CANVAS_DIM  = 16384;
export const EXPORT_MAX_CANVAS_AREA = 64_000_000;

// The raster density actually used for a map of this size: the target density,
// backed off to fit both ceilings. It can land BELOW 1 for a very large map —
// the export still happens (the biggest image that works beats no image at
// all), but the caller then warns the user rather than quietly handing them
// something blurrier than a screenshot. Exported so the caller can report
// exactly the number the rasterizer used, from one formula.
export function exportRasterScale(width: number, height: number): number {
  const scale = Math.min(
    EXPORT_PNG_SCALE,
    EXPORT_MAX_CANVAS_DIM / width,
    EXPORT_MAX_CANVAS_DIM / height,
    Math.sqrt(EXPORT_MAX_CANVAS_AREA / (width * height))
  );
  return (isFinite(scale) && scale > 0) ? scale : 1;
}

// Turn the map (drawn as crisp SVG vector shapes) into a PNG image file —
// "rasterize" means convert those shapes into a grid of pixels. Returns a
// Promise<Blob> (a Blob is just an in-memory file) so it can be handed straight
// to ClipboardItem (which keeps the originating user-gesture alive while the
// image loads).
//
// The trick for a sharp image: before converting, we tell the SVG to draw itself
// BIGGER (we grow its declared width/height, but keep the viewBox — its internal
// coordinate system — the same). Because SVG is resolution-independent, the
// browser then re-draws the shapes crisply at the large size, instead of taking
// a small picture and blowing it up blurry. The size multiplier ("scale" /
// density) is capped so the pixel grid never exceeds what browsers allow; for a
// very large map it drops below the target (even below 1×) to produce the
// biggest image that still works, rather than failing outright.
export function renderExportPngBlob(svg: string, width: number, height: number, pal: ExportPalette, transparent?: boolean): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const scale = exportRasterScale(width, height);
    const cw = Math.max(1, Math.round(width  * scale));
    const ch = Math.max(1, Math.round(height * scale));

    // Grow the SVG's intrinsic size to the raster size (viewBox unchanged) so
    // it rasterizes vector-sharp at full resolution. The opening tag is REBUILT
    // and the body passed to the Blob as a second part, so a multi-megabyte
    // string is never copied wholesale just to change two attributes (Blob
    // takes an array of parts, and .slice() of a long string is a view).
    const bodyStart = svg.indexOf(">") + 1;   // end of the opening <svg …> tag
    const blobUrl = URL.createObjectURL(new Blob(
      [exportSvgOpenTag(width, height, cw, ch), svg.slice(bodyStart)],
      { type: "image/svg+xml;charset=utf-8" }
    ));

    const img = new Image();
    img.onload = () => {
      // Allocating and painting a canvas this big is the step that actually
      // fails on memory-constrained browsers — and it fails in three different
      // ways: by throwing, by handing back a null 2D context, or by silently
      // clamping the dimensions to something smaller. Catch all three and
      // reject with a message the caller can show, rather than resolving with
      // a blank or truncated image.
      try {
        const canvas = document.createElement("canvas");
        canvas.width  = cw;
        canvas.height = ch;
        if (canvas.width !== cw || canvas.height !== ch) {
          throw new Error("the browser refused a " + cw + "×" + ch + " canvas");
        }
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("no 2D canvas context available");
        // Clean export keeps the canvas alpha so the PNG is transparent; the
        // standard export paints the solid backdrop first.
        if (!transparent) {
          ctx.fillStyle = pal.bgDeep || "#111827";
          ctx.fillRect(0, 0, cw, ch);
        }
        ctx.drawImage(img, 0, 0, cw, ch);   // 1:1 — image already at full res
        URL.revokeObjectURL(blobUrl);
        if (!canvas.toBlob) { reject(new Error("Canvas.toBlob unsupported")); return; }
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("PNG encoding failed")), "image/png");
      } catch (e) {
        URL.revokeObjectURL(blobUrl);
        const why = (e instanceof Error && e.message) ? e.message : "out of memory";
        reject(new Error("this map is too big to turn into an image (" + why + ")"));
      }
    };
    img.onerror = () => { URL.revokeObjectURL(blobUrl); reject(new Error("SVG image failed to load")); };
    img.src = blobUrl;
  });
}

// ───── PUBLIC: copy the canvas to the clipboard as a PNG image ─────────────
export function exportCanvasImage(): void {
  const model = buildExportModel();
  if (!model) { showLoadFeedback("Nothing to export — load a map or zoom to some boxes.", true); return; }

  if (!navigator.clipboard || typeof ClipboardItem === "undefined" || !navigator.clipboard.write) {
    showLoadFeedback("Clipboard image copy isn't available in this browser. Try opening the app over http/localhost.", true);
    return;
  }

  const pal = exportPalette();
  // Slide-ready PNG: transparent background, no chrome, full-colour edges. The
  // current theme (Twilight/Linen) decides the ink, so the image reads on a
  // matching dark or light slide.
  const { svg, width, height } = renderExportSvg(model, { pal, transparent: true });

  // How dense the raster will actually be. Above 1× there is nothing to say;
  // at or below 1× the PNG is no sharper than a screenshot, and the user has a
  // way out (select a box → only that trace is exported, at full density), so
  // say so plainly instead of handing back a soft image with a cheery
  // "copied!". Computed here, and reported only once the copy succeeds, so the
  // message isn't immediately overwritten by the success toast.
  const scale = exportRasterScale(width, height);
  const degraded = scale < 1;

  // Hand ClipboardItem a Promise<Blob> so the write stays tied to the click
  // gesture even though rasterization is asynchronous. Rasterization failures
  // get their own toast — some browsers swallow the rejected image promise
  // rather than failing the clipboard write, which would look like nothing
  // happened at all.
  let rasterFailed = false;
  const blobPromise = renderExportPngBlob(svg, width, height, pal, true).catch(err => {
    rasterFailed = true;
    console.error("Map rasterization failed:", err);
    showLoadFeedback("Couldn't create the map image — " +
      (err && err.message ? err.message : "the canvas could not be created") +
      ". Try selecting a box to export a smaller slice.", true);
    throw err;
  });
  navigator.clipboard.write([new ClipboardItem({ "image/png": blobPromise })])
    .then(() => showLoadFeedback(
      degraded
        ? "Map image copied — but this map is too large to raster at full size, so it went out at " +
          Math.round(scale * 100) + "% scale (softer than a screenshot). Select a box first to export " +
          "just that part at full quality."
        : "Map image copied to clipboard.",
      degraded))
    .catch(err => {
      if (rasterFailed) return;              // already reported, don't double-toast
      console.error("Clipboard copy failed:", err);
      showLoadFeedback("Couldn't copy to clipboard: " + (err && err.message ? err.message : "permission denied"), true);
    });
}

// ───── PUBLIC: publish as a view-only HTML page ────────────────────────────
export function publishCanvasHtml(): void {
  const model = buildExportModel({ allEdges: true });
  if (!model) { showLoadFeedback("Nothing to publish — load a map or zoom to some boxes.", true); return; }
  const pal = exportPalette();
  // svgId: the viewer drives the <svg> by id, emitted at build time so the
  // whole (possibly multi-megabyte) string isn't rewritten to add one attribute.
  const { svg, width, height, nodeInfo } = renderExportSvg(model, { pal, svgId: PUBLISH_SVG_ID });
  const html = buildPublishHtml(svg, width, height, nodeInfo, pal, model.edges);
  downloadTextBlob(html, "systems-map.html", "text/html;charset=utf-8");
  showLoadFeedback("Published systems-map.html (interactive)", false);
}

// Deepest reachable hop over a set of edges — caps the published viewer's
// highlight-depth control. Builds a downstream adjacency from the published
// subset of edges and defers to the shared maxReachableDepth (04-utils), the
// same primitive the live map uses via computeMaxHighlightDepth. Always >= 1.
export function exportMaxHighlightDepth(edges: ExportEdge[]): number {
  const out: Record<string, string[]> = {};
  for (const e of edges) (out[e.from] || (out[e.from] = [])).push(e.to);
  return maxReachableDepth(Object.keys(out), id => out[id] || []);
}

// The viewer needs its <svg> to carry id="mv-svg". renderExportSvg stamps it at
// build time when asked (the publish path does), so this is a cheap prefix check
// that patches only an SVG built without it — no whole-string rewrite of the
// megabytes of markup on the normal path.
function withSvgId(svg: string): string {
  const stamped = '<svg id="' + PUBLISH_SVG_ID + '"';
  return svg.lastIndexOf(stamped, 0) === 0 ? svg : svg.replace("<svg ", stamped + " ");
}

// Wrap the SVG in a self-contained, interactive pan / zoom / highlight viewer:
// click a box to trace its up/downstream connections, a highlight-depth control
// to widen/narrow the trace, scroll-wheel + button zoom, drag-to-pan, and hover
// tooltips. The whole thing stays a single file (graph data + viewer JS inline).
export function buildPublishHtml(
  svg: string,
  width: number,
  height: number,
  nodeInfo: Record<string, Record<string, string>>,
  pal: ExportPalette,
  edges: ExportEdge[]
): string {
  // Guard the embedded JSON against closing-tag breakouts by escaping "<".
  const esc = (o: unknown): string => JSON.stringify(o).replace(/</g, "\\u003c");
  const infoJson  = esc(nodeInfo);
  const edgesJson = esc(edges.map(e => ({ id: e.id, from: e.from, to: e.to, effect: e.effect || "" })));
  const maxDepth  = exportMaxHighlightDepth(edges);

  const viewerJs =
    '(function(){' +
    'var W=' + width + ',H=' + height + ',MAXD=' + maxDepth + ';' +
    'var INFO=' + infoJson + ';' +
    'var EDGES=' + edgesJson + ';' +
    'var scroll=document.getElementById("mv-scroll");' +
    'var svg=document.getElementById("' + PUBLISH_SVG_ID + '");' +
    'var tip=document.getElementById("mv-tip");' +
    'var readout=document.getElementById("mv-zoom");' +
    'var z=1;' +
    // ── adjacency for tracing (built once) ──
    'var outAdj={},inAdj={};' +
    'EDGES.forEach(function(e){(outAdj[e.from]||(outAdj[e.from]=[])).push(e);(inAdj[e.to]||(inAdj[e.to]=[])).push(e);});' +
    'var sel=null,depth=1;' +
    // ── zoom / pan ──
    'function clamp(v){return Math.max(0.2,Math.min(4,v));}' +
    'function apply(){svg.style.width=(W*z)+"px";svg.style.height=(H*z)+"px";readout.textContent=Math.round(z*100)+"%";}' +
    'function zoomTo(nz,cx,cy){var oz=z;nz=clamp(nz);if(nz===oz)return;' +
      'var r=scroll.getBoundingClientRect();var px=(cx==null?r.width/2:cx-r.left);var py=(cy==null?r.height/2:cy-r.top);' +
      'var lx=(px+scroll.scrollLeft)/oz, ly=(py+scroll.scrollTop)/oz;' +
      'z=nz;apply();scroll.scrollLeft=lx*z-px;scroll.scrollTop=ly*z-py;}' +
    'function fit(){var r=scroll.getBoundingClientRect();z=clamp(Math.min(r.width/W,r.height/H,1));apply();}' +
    'document.getElementById("mv-in").onclick=function(){zoomTo(z+0.1);};' +
    'document.getElementById("mv-out").onclick=function(){zoomTo(z-0.1);};' +
    'document.getElementById("mv-fit").onclick=function(){fit();};' +
    'readout.onclick=function(){zoomTo(1);};' +
    // Wheel zoom: Ctrl/Cmd or a mouse-wheel-like event zooms; a plain trackpad
    // two-finger scroll keeps panning (mirrors the live app's 17-events.js).
    'function looksLikeMouseWheel(e){if(e.deltaMode!==0)return true;if(e.deltaX!==0)return false;var a=Math.abs(e.deltaY);return a>=50&&a===Math.round(a);}' +
    'scroll.addEventListener("wheel",function(e){var mod=e.ctrlKey||e.metaKey;var mw=!mod&&looksLikeMouseWheel(e);if(!mod&&!mw)return;' +
      'e.preventDefault();var dy=e.deltaMode===1?e.deltaY*16:e.deltaY;var s=mw?0.0015:0.0035;zoomTo(z*Math.exp(-dy*s),e.clientX,e.clientY);},{passive:false});' +
    'var pan=null,moved=false;' +
    'scroll.addEventListener("mousedown",function(e){if(e.button!==0)return;moved=false;if(e.target.closest&&e.target.closest(".xnode"))return;pan={x:e.clientX,y:e.clientY,l:scroll.scrollLeft,t:scroll.scrollTop};document.body.style.cursor="grabbing";});' +
    'window.addEventListener("mousemove",function(e){if(pan){if(Math.abs(e.clientX-pan.x)+Math.abs(e.clientY-pan.y)>3)moved=true;scroll.scrollLeft=pan.l-(e.clientX-pan.x);scroll.scrollTop=pan.t-(e.clientY-pan.y);}});' +
    'window.addEventListener("mouseup",function(){pan=null;document.body.style.cursor="";});' +
    // ── trace (BFS up/down to `depth` hops) ──
    'function bfs(start,d,adj,key){var seen={},res={};var fr=[start];seen[start]=1;' +
      'for(var l=0;l<d&&fr.length;l++){var nx=[];for(var i=0;i<fr.length;i++){var a=adj[fr[i]]||[];' +
        'for(var j=0;j<a.length;j++){var nb=a[j][key];if(nb!==start&&!res[nb]){res[nb]=1;seen[nb]=1;nx.push(nb);}}}fr=nx;}return res;}' +
    'function edgesUpDown(start,d){var ids={};[[inAdj,"from"],[outAdj,"to"]].forEach(function(p){var adj=p[0],key=p[1];' +
      'var seen={};seen[start]=1;var fr=[start];for(var l=0;l<d&&fr.length;l++){var nx=[];for(var i=0;i<fr.length;i++){var a=adj[fr[i]]||[];' +
        'for(var j=0;j<a.length;j++){ids[a[j].id]=1;var nb=a[j][key];if(!seen[nb]){seen[nb]=1;nx.push(nb);}}}fr=nx;}});return ids;}' +
    // ── element caches (queried ONCE, at startup) ──
    // The old applyHighlight re-ran two querySelectorAll sweeps and then reset
    // + re-set a class on every box and every arrow, on every click and every
    // depth step — tens of thousands of classList writes per interaction on a
    // big map. The lists and an id→element map are built once here instead.
    'var NODES=svg.querySelectorAll(".xnode"),EDGES_EL=svg.querySelectorAll(".xedge");' +
    'var NODE_EL={},EDGE_EL={},q;' +
    'for(q=0;q<NODES.length;q++)NODE_EL[NODES[q].getAttribute("data-node-id")]=NODES[q];' +
    'for(q=0;q<EDGES_EL.length;q++)EDGE_EL[EDGES_EL[q].getAttribute("data-edge-id")]=EDGES_EL[q];' +
    // ── apply highlight classes (no re-render) ──
    // `hiNode` / `hiEdge` remember what is currently highlighted, so an update
    // only touches the symmetric difference — the boxes and arrows that
    // actually change state. `traced` says whether the map is in the traced
    // state at all (every non-highlighted box carries "dim"); the only full
    // sweeps left are entering it and leaving it.
    'var hiNode={},hiEdge={},traced=false;' +
    'function swap(el,from,to){if(!el)return;if(from)el.classList.remove(from);el.classList.add(to);}' +
    'function applyHighlight(){var i,id,g;' +
      'if(!sel){if(traced){' +
        'for(i=0;i<NODES.length;i++)NODES[i].classList.remove("sel","anc","desc","dim");' +
        'for(i=0;i<EDGES_EL.length;i++)EDGES_EL[i].classList.remove("ehi","edim");' +
        'traced=false;hiNode={};hiEdge={};}return;}' +
      'var anc=bfs(sel,depth,inAdj,"from"),desc=bfs(sel,depth,outAdj,"to"),eh=edgesUpDown(sel,depth);' +
      // Wanted class per highlighted box — ancestors win over descendants, and
      // the selected box wins over both (the old if/else-if order).
      'var want={};for(id in desc)want[id]="desc";for(id in anc)want[id]="anc";want[sel]="sel";' +
      'if(!traced){' +
        'for(i=0;i<NODES.length;i++){g=NODES[i];g.classList.add(want[g.getAttribute("data-node-id")]||"dim");}' +
        'for(i=0;i<EDGES_EL.length;i++){g=EDGES_EL[i];g.classList.add(eh[g.getAttribute("data-edge-id")]?"ehi":"edim");}' +
        'traced=true;}' +
      'else{' +
        'for(id in want)if(hiNode[id]!==want[id])swap(NODE_EL[id],hiNode[id]||"dim",want[id]);' +
        'for(id in hiNode)if(!want[id])swap(NODE_EL[id],hiNode[id],"dim");' +
        'for(id in eh)if(!hiEdge[id])swap(EDGE_EL[id],"edim","ehi");' +
        'for(id in hiEdge)if(!eh[id])swap(EDGE_EL[id],"ehi","edim");}' +
      'hiNode=want;hiEdge=eh;}' +
    'function select(id){sel=(sel===id?null:id);applyHighlight();}' +
    // ── highlight-depth control ──
    'var dReadout=document.getElementById("mv-depth"),dDown=document.getElementById("mv-depth-down"),dUp=document.getElementById("mv-depth-up");' +
    'function applyDepth(){dReadout.textContent=String(depth);dDown.disabled=depth<=1;dUp.disabled=depth>=MAXD;}' +
    'function setDepth(n){var c=Math.max(1,Math.min(MAXD,Math.round(n)));if(c===depth)return;depth=c;applyDepth();if(sel)applyHighlight();}' +
    'dDown.onclick=function(){setDepth(depth-1);};dUp.onclick=function(){setDepth(depth+1);};applyDepth();' +
    // ── selection clicks ──
    'svg.addEventListener("click",function(e){if(moved)return;var g=e.target.closest&&e.target.closest(".xnode");if(g){e.stopPropagation();select(g.getAttribute("data-node-id"));}else if(sel){sel=null;applyHighlight();}});' +
    // ── tooltips ──
    'function showTip(id,e){var d=INFO[id];if(!d)return;' +
      'var h="<div class=\\"t-title\\">"+esct(d.label)+"</div>";' +
      'var meta=[d.stream,d.stage,d.category].filter(Boolean).join(" \\u00b7 ");' +
      'if(meta)h+="<div class=\\"t-meta\\">"+esct(meta)+"</div>";' +
      'if(d.value)h+="<div class=\\"t-val\\">"+esct(d.value)+"</div>";' +
      'if(d.description)h+="<div class=\\"t-desc\\">"+esct(d.description)+"</div>";' +
      'tip.innerHTML=h;tip.style.display="block";moveTip(e);}' +
    'function moveTip(e){var pad=14;var w=tip.offsetWidth,ht=tip.offsetHeight;' +
      'var x=e.clientX+pad,y=e.clientY+pad;' +
      'if(x+w>window.innerWidth)x=e.clientX-w-pad;if(y+ht>window.innerHeight)y=e.clientY-ht-pad;' +
      'tip.style.left=x+"px";tip.style.top=y+"px";}' +
    'function esct(t){return String(t).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}' +
    'svg.addEventListener("mouseover",function(e){var g=e.target.closest&&e.target.closest(".xnode");if(g)showTip(g.getAttribute("data-node-id"),e);});' +
    'svg.addEventListener("mousemove",function(e){if(tip.style.display==="block")moveTip(e);});' +
    'svg.addEventListener("mouseout",function(e){var g=e.target.closest&&e.target.closest(".xnode");if(g)tip.style.display="none";});' +
    'apply();fit();' +
    '})();';

  return '<!DOCTYPE html>' +
    '<html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Ariadne Maps</title>' +
    '<style>' +
      '*{box-sizing:border-box;}' +
      'html,body{margin:0;height:100%;background:' + pal.bgDeepest + ';' +
        'font-family:Arial,Helvetica,sans-serif;color:' + pal.textPrimary + ';overflow:hidden;}' +
      '#mv-scroll{position:absolute;inset:0;overflow:auto;cursor:grab;}' +
      '#mv-inner{padding:0;}' +
      '#mv-svg{display:block;}' +
      '.xnode{cursor:pointer;}' +
      // Highlight states (mirror 05-visualization.css): selected = white glow,
      // ancestor = blue, descendant = dimmer blue, everything else dimmed.
      '.xnode.dim{opacity:0.18;}' +
      '.xnode.sel .xn-bg{filter:drop-shadow(0 0 2px rgba(255,255,255,1)) drop-shadow(0 0 8px rgba(255,255,255,0.9)) drop-shadow(0 0 18px rgba(255,255,255,0.55));}' +
      '.xnode.anc .xn-bg{filter:drop-shadow(0 0 2px ' + pal.edgeAncestor + ') drop-shadow(0 0 7px ' + pal.edgeAncestor + ') drop-shadow(0 0 14px ' + pal.edgeAncestor + ');}' +
      '.xnode.desc .xn-bg{filter:drop-shadow(0 0 2px ' + pal.edgeDescendant + ') drop-shadow(0 0 7px ' + pal.edgeDescendant + ') drop-shadow(0 0 14px ' + pal.edgeAncestor + ');}' +
      // Highlighted edges take their effect colour + arrowhead; others fade out.
      '.xedge.edim{opacity:0.05;}' +
      '.xedge.ehi{stroke-width:2;stroke-opacity:0.9;}' +
      '.xedge.ehi[data-effect="enables"]{stroke:' + pal.edgeEnables + ';marker-end:url(#xarrow_enables);}' +
      '.xedge.ehi[data-effect="increases"]{stroke:' + pal.edgeIncreases + ';marker-end:url(#xarrow_increases);}' +
      '.xedge.ehi[data-effect="decreases"]{stroke:' + pal.edgeDecreases + ';marker-end:url(#xarrow_decreases);}' +
      '.xedge.ehi:not([data-effect="enables"]):not([data-effect="increases"]):not([data-effect="decreases"]){stroke:' + pal.edgeAncestor + ';marker-end:url(#xarrow_ancestor);}' +
      // Control cards — match the main app's .viz-*-controls glass-card styling.
      '#mv-tools{position:fixed;top:12px;right:12px;z-index:10;display:flex;flex-direction:column;gap:8px;}' +
      '.mv-card{display:flex;flex-direction:column;gap:3px;width:120px;padding:5px 6px;border-radius:6px;' +
        'background:' + pal.bgDeep + 'd9;backdrop-filter:blur(8px);font-family:Arial,Helvetica,sans-serif;}' +
      '.mv-title{color:' + pal.textTertiary + ';font-size:9px;text-transform:uppercase;letter-spacing:0.08em;text-align:center;white-space:nowrap;}' +
      '.mv-row{display:flex;align-items:center;justify-content:space-between;gap:2px;}' +
      '.mv-card button{background:transparent;border:none;color:' + pal.textSecondary + ';border-radius:4px;height:26px;' +
        'line-height:1;display:flex;align-items:center;justify-content:center;padding:0;font-family:inherit;cursor:pointer;' +
        'transition:background 0.15s,color 0.15s;}' +
      '.mv-card button:disabled{opacity:0.3;cursor:default;}' +
      '.mv-step{width:26px;font-size:16px;}' +
      '#mv-zoom{flex:1;font-size:11px;letter-spacing:0.04em;}' +
      '#mv-depth{flex:1;text-align:center;font-size:12px;color:' + pal.textPrimary + ';}' +
      '#mv-fit{width:100%;font-size:10px;text-transform:uppercase;letter-spacing:0.08em;}' +
      '.mv-card button:not(:disabled):hover{color:' + pal.textPrimary + ';background:' + pal.bgLight + ';}' +
      '#mv-tip{position:fixed;display:none;max-width:300px;background:' + pal.bgDeep + ';border:1px solid ' + pal.borderSubtle + ';' +
        'border-radius:6px;padding:8px 10px;font-size:12px;pointer-events:none;z-index:20;box-shadow:0 8px 24px rgba(0,0,0,0.5);}' +
      '#mv-tip .t-title{font-weight:600;font-size:13px;margin-bottom:2px;}' +
      '#mv-tip .t-meta{color:' + pal.textTertiary + ';font-size:10.5px;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px;}' +
      '#mv-tip .t-val{color:' + pal.textSecondary + ';margin-bottom:4px;}' +
      '#mv-tip .t-desc{color:' + pal.textSecondary + ';line-height:1.4;}' +
      '#mv-hint{position:fixed;bottom:12px;left:12px;font-size:11px;color:' + pal.textTertiary + ';z-index:10;}' +
    '</style></head><body>' +
    '<div id="mv-scroll"><div id="mv-inner">' + withSvgId(svg) + '</div></div>' +
    '<div id="mv-tip"></div>' +
    '<div id="mv-tools">' +
      '<div class="mv-card">' +
        '<span class="mv-title">Highlight depth</span>' +
        '<div class="mv-row">' +
          '<button class="mv-step" id="mv-depth-down" title="Trace fewer levels" aria-label="Decrease highlight depth">−</button>' +
          '<span id="mv-depth">1</span>' +
          '<button class="mv-step" id="mv-depth-up" title="Trace more levels" aria-label="Increase highlight depth">+</button>' +
        '</div>' +
      '</div>' +
      '<div class="mv-card">' +
        '<span class="mv-title">Zoom</span>' +
        '<div class="mv-row">' +
          '<button class="mv-step" id="mv-out" title="Zoom out" aria-label="Zoom out">−</button>' +
          '<button id="mv-zoom" title="Reset zoom (click)">100%</button>' +
          '<button class="mv-step" id="mv-in" title="Zoom in" aria-label="Zoom in">+</button>' +
        '</div>' +
        '<button id="mv-fit" title="Fit to screen">Fit</button>' +
      '</div>' +
    '</div>' +
    '<div id="mv-hint">Click a box to trace its connections · drag to pan · scroll or Ctrl/⌘ + scroll to zoom · hover for details</div>' +
    '<script>' + viewerJs + EXPORT_CLOSE_SCRIPT +
    '</body></html>';
}
