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
//            viewport (so the user frames the export by zooming / panning).
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
  deltaColorFor,
  edgeBezierPath,
  escapeHtml,
  measureLabelLines,
  nodeCategoryIds,
} from "./04-utils";
import {
  formatNodeDelta,
  formatNodeValue,
  getOutcomeBorderColor,
} from "./07-simulation-engine";
import { measureNode } from "./08-layout";
import { isEdgeVisible, isNodeVisible } from "./10-filters";
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
  statusGood: string;
  statusBad: string;
  // Highlight colours used by the interactive published viewer (resolved to
  // literals so the self-contained file needs no CSS custom properties).
  edgeAncestor: string;
  edgeDescendant: string;
  edgeEnables: string;
  edgeIncreases: string;
  edgeDecreases: string;
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

// ───── Assembled export model ───────────────────────────────────────────────
interface ExportModel {
  nodeIds: Set<string>;
  edges: Edge[];
  selectionActive: boolean;
  stageIds: string[];
  streamOrder: string[];
  layout: ExportLayout;
}

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
    statusGood:    v("--status-good",    "#10b981"),
    statusBad:     v("--status-bad",     "#f87171"),
    edgeAncestor:  v("--edge-ancestor",  "#8fb6d9"),
    edgeDescendant:v("--edge-descendant","#4d6783"),
    edgeEnables:   v("--edge-enables",   "#bfaede"),
    edgeIncreases: v("--edge-increases", "#9ed1b4"),
    edgeDecreases: v("--edge-decreases", "#e3a3a8"),
  };
}

// ───── Which nodes/edges to include ────────────────────────────────────────
// Returns { nodeIds:Set, edges:[edge], selectionActive:bool }.
// `allEdges` (used by the interactive published HTML) includes every edge among
// the chosen nodes rather than only the ones highlighted by the current depth —
// so the published viewer can re-trace connections itself as the user clicks.
export function getExportSelection(allEdges = false): { nodeIds: Set<string>; edges: Edge[]; selectionActive: boolean } {
  const singleSelected = state.selectedNodeId &&
    (!state.selectedNodeIds || state.selectedNodeIds.size <= 1);

  if (singleSelected) {
    const ids = new Set<string>([state.selectedNodeId!]);
    if (state.ancestorSet)   state.ancestorSet.forEach(id => ids.add(id));
    if (state.descendantSet) state.descendantSet.forEach(id => ids.add(id));
    // Every edge among the chosen nodes (interactive), or only the edges
    // highlighted by the current highlight depth (static image / default).
    const edges = EDGES.filter(e =>
      ids.has(e.from) && ids.has(e.to) &&
      (allEdges || (state.highlightedEdgeIds && state.highlightedEdgeIds.has(e.id!))));
    return { nodeIds: ids, edges, selectionActive: true };
  }

  // No single selection → everything visible within the scroll viewport.
  const rect = visibleLayoutRect();
  const ids = new Set<string>();
  for (const node of NODES) {
    if (!isNodeVisible(node)) continue;
    const pos = layout.positions[node.id];
    if (!pos) continue;                       // nodes in collapsed stages have no position
    if (rect && !rectsOverlap(pos, rect)) continue;
    ids.add(node.id);
  }
  const edges = EDGES.filter(e => ids.has(e.from) && ids.has(e.to));
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

// ───── Reorder stream rows to minimise edge length ─────────────────────────
// Greedy chains, one per connected cluster of streams. Seed each chain with the
// heaviest remaining pair of streams, then grow it on both ends by repeatedly
// attaching the unplaced stream with the strongest tie to either end. When a
// chain can no longer grow we start a NEW chain from the next-heaviest pair, so
// every cluster gets packed together (not just the first). Clusters are emitted
// heaviest-first; streams with no cross-stream edges keep their original order
// at the end. Deterministic (ties broken by original index).
export function orderExportStreams(streamIds: string[], edges: Edge[]): string[] {
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

  // Columns: packed left→right over the included stages only.
  const colX: Record<string, number> = {};
  let cursorX = SVG_PADDING_LEFT + ROW_HEADER_WIDTH;
  for (const stageId of stageIds) {
    colX[stageId] = cursorX;
    cursorX += NODE_WIDTH + COL_GAP;
  }
  const totalWidth = cursorX - COL_GAP + SVG_PADDING_RIGHT;

  // Rows: packed top→bottom over the (reordered) included streams. Row height
  // is the tallest cell's SUMMED stack height (nodes grow to fit their labels),
  // reusing each node's grown height from the live layout.
  // Per-node grown height: reuse the live layout's measurement, falling back to
  // a fresh measure for any node without a live position (e.g. one in a stage
  // that's collapsed on the canvas but pulled into a selection export).
  const exHeight = (id: string): number => {
    const p = layout.positions[id];
    if (p && p.height) return p.height;
    const n = nodeById[id];
    return n ? measureNode(n).height : NODE_HEIGHT;
  };
  const rowHeights: Record<string, number> = {}, rowY: Record<string, number> = {};
  for (const streamId of streamOrder) {
    let maxContent = 0;
    for (const stageId of stageIds) {
      const c = cells[streamId + ":" + stageId];
      if (!c || !c.length) continue;
      let sum = 0;
      for (const n of c) sum += exHeight(n.id);
      sum += (c.length - 1) * NODE_GAP_Y;
      if (sum > maxContent) maxContent = sum;
    }
    rowHeights[streamId] = (maxContent || NODE_HEIGHT) + ROW_PADDING * 2;   // floor empty rows only (matches live)
  }
  let cursorY = SVG_PADDING_TOP + COL_HEADER_HEIGHT;
  for (const streamId of streamOrder) {
    rowY[streamId] = cursorY;
    cursorY += rowHeights[streamId];
  }
  const totalHeight = cursorY + SVG_PADDING_BOTTOM;

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

// ───── Render the model to a self-contained SVG string ─────────────────────
// Returns { svg, width, height, nodeInfo } where nodeInfo maps node id →
// metadata used by the published HTML viewer's hover tooltips.
export function renderExportSvg(
  model: ExportModel,
  opts?: { pal?: ExportPalette }
): { svg: string; width: number; height: number; nodeInfo: Record<string, Record<string, string>> } {
  _xnodeGradSeq = 0;   // restart per export
  opts = opts || {};
  const pal = opts.pal || exportPalette();
  const lay = model.layout;
  const W = lay.totalWidth, H = lay.totalHeight;
  const nodeInfo: Record<string, Record<string, string>> = {};

  let s = "";
  s += '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H +
       '" viewBox="0 0 ' + W + ' ' + H + '">';

  // Fonts + text sizing baked in (values mirror 05-visualization.css).
  s += '<style>'
     +   'text{font-family:Arial,Helvetica,sans-serif;}'
     +   '.xn-label{font-size:12px;font-weight:500;}'
     +   '.xn-value{font-size:10.5px;font-weight:500;}'
     +   '.xn-delta{font-size:10.5px;font-weight:600;}'
     +   '.xr-label{font-size:11px;font-weight:600;letter-spacing:0.1em;}'
     +   '.xc-header{font-size:11px;font-weight:600;letter-spacing:0.12em;}'
     + '</style>';

  // Arrowhead markers (one per effect colour) so the interactive viewer can show
  // direction on highlighted edges, mirroring the live map (11-rendering.js).
  // Inert for the static PNG export — nothing references them there.
  const arrowColors: Record<string, string> = {
    ancestor:  pal.edgeAncestor,
    enables:   pal.edgeEnables,
    increases: pal.edgeIncreases,
    decreases: pal.edgeDecreases,
  };
  s += '<defs>';
  for (const name in arrowColors) {
    s += '<marker id="xarrow_' + name + '" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">'
       +   '<path d="M 0 0 L 10 5 L 0 10 z" fill="' + arrowColors[name] + '"></path>'
       + '</marker>';
  }
  s += '</defs>';

  // Background.
  s += '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="' + pal.bgDeep + '"></rect>';

  // Per-stream background stripe + top divider.
  for (const streamId of model.streamOrder) {
    const stream = streamById[streamId] || ({ color: "#94a3b8" } as Stream);
    const y = lay.rowY[streamId], h = lay.rowHeights[streamId];
    s += '<rect x="0" y="' + y + '" width="' + W + '" height="' + h + '" fill="' + stream.color + '" opacity="0.04"></rect>';
    s += '<line x1="0" y1="' + y + '" x2="' + W + '" y2="' + y + '" stroke="' + pal.borderSubtle + '" stroke-width="1"></line>';
  }

  // Column-header band + stage labels + vertical dividers.
  const headerBandBottom = SVG_PADDING_TOP + COL_HEADER_HEIGHT;
  s += '<rect x="0" y="0" width="' + W + '" height="' + headerBandBottom + '" fill="' + pal.bgDeep + '"></rect>';
  for (let i = 0; i < model.stageIds.length; i++) {
    const stageId = model.stageIds[i];
    const stage = stageById[stageId] || ({ label: stageId } as StageWithIndex);
    const cx = lay.colX[stageId] + NODE_WIDTH / 2;
    s += '<text class="xc-header" x="' + cx + '" y="' + (SVG_PADDING_TOP + 24) +
         '" text-anchor="middle" fill="' + pal.textSecondary + '">' + escapeHtml(stage.label) + '</text>';
    if (i < model.stageIds.length - 1) {
      const dividerX = lay.colX[stageId] + NODE_WIDTH + COL_GAP / 2;
      s += '<line x1="' + dividerX + '" y1="' + headerBandBottom + '" x2="' + dividerX + '" y2="' + H +
           '" stroke="' + pal.borderSubtle + '" stroke-width="1" stroke-dasharray="2 4" opacity="0.6"></line>';
    }
  }

  // Row-label strip (stream short codes).
  for (const streamId of model.streamOrder) {
    const stream = streamById[streamId] || ({ short: streamId, color: "#94a3b8" } as Stream);
    const y = lay.rowY[streamId], h = lay.rowHeights[streamId];
    s += '<rect x="0" y="' + y + '" width="' + ROW_HEADER_WIDTH + '" height="' + h + '" fill="' + pal.bgDeepest + '"></rect>';
    s += '<rect x="' + (ROW_HEADER_WIDTH - 4) + '" y="' + y + '" width="4" height="' + h + '" fill="' + stream.color + '" opacity="0.7"></rect>';
    s += '<text class="xr-label" x="' + (ROW_HEADER_WIDTH / 2) + '" y="' + (y + h / 2) +
         '" text-anchor="middle" dominant-baseline="middle" fill="' + stream.color + '">' + escapeHtml(stream.short) + '</text>';
  }

  // Edges (drawn before nodes). Rendered in the map's normal, un-highlighted
  // style — gray, thin, semi-transparent, no arrowhead (exactly how the live
  // map draws an edge when nothing is selected). Effect colours and arrowheads
  // are the app's *highlight* state, so they are deliberately not used here.
  for (const edge of model.edges) {
    if (typeof isEdgeVisible === "function" && !isEdgeVisible(edge)) continue;   // honour the sidebar edge filters
    const fromPos = lay.positions[edge.from], toPos = lay.positions[edge.to];
    if (!fromPos || !toPos) continue;
    const dashAttr = edge.style === "dashed" ? ' stroke-dasharray="6 5"' : '';
    // data-* attributes drive the interactive viewer's re-tracing (inert for PNG).
    s += '<path class="xedge" data-edge-id="' + escapeHtml(edge.id!) + '" data-from="' + escapeHtml(edge.from) +
         '" data-to="' + escapeHtml(edge.to) + '" data-effect="' + escapeHtml(edge.effect || "") +
         '" d="' + edgeBezierPath(fromPos, toPos) + '" fill="none" stroke="' + pal.edgeDefault +
         '" stroke-width="1" stroke-opacity="0.45"' + dashAttr + '></path>';
  }

  // Nodes.
  for (const node of NODES) {
    if (!model.nodeIds.has(node.id)) continue;
    const pos = lay.positions[node.id];
    if (!pos) continue;
    const stream   = streamById[node.stream]   || ({ color: "#94a3b8" } as Stream);
    const fillInfo = nodePrimaryFill(node, "xgrad_" + (_xnodeGradSeq++));
    const chips    = nodeSecondaryChips(node, pos);
    const stroke   = exportNodeStroke(node.id, pal);

    s += '<g class="xnode" data-node-id="' + escapeHtml(node.id) + '">';
    s += fillInfo.defs;   // per-node gradient (empty unless multi-primary)

    // Background rect (xn-bg lets the interactive viewer paint selection glows).
    s += '<rect class="xn-bg" x="' + pos.x + '" y="' + pos.y + '" width="' + pos.width + '" height="' + pos.height +
         '" rx="5" fill="' + fillInfo.fill + '" stroke="' + stroke.color + '" stroke-width="' + stroke.width + '"></rect>';

    // Left stream-colour stripe (rounded only on the left corners).
    const barRadius = 5, barLeft = pos.x, barRight = pos.x + 6, barTop = pos.y, barBottom = pos.y + pos.height;
    s += '<path d="M ' + (barLeft + barRadius) + ',' + barTop +
         ' L ' + barRight + ',' + barTop +
         ' L ' + barRight + ',' + barBottom +
         ' L ' + (barLeft + barRadius) + ',' + barBottom +
         ' A ' + barRadius + ',' + barRadius + ' 0 0 1 ' + barLeft + ',' + (barBottom - barRadius) +
         ' L ' + barLeft + ',' + (barTop + barRadius) +
         ' A ' + barRadius + ',' + barRadius + ' 0 0 1 ' + (barLeft + barRadius) + ',' + barTop +
         ' Z" fill="' + stream.color + '"></path>';

    // Wrapped label — reuse the same grow-to-fit lines the layout sized the box
    // from, so the export matches the live map. Anchored at the symmetric inset.
    const labelLines = pos.labelLines || measureLabelLines(node.label || node.id || "", NODE_WIDTH - LABEL_INSET * 2);
    const lx = pos.x + LABEL_INSET;
    s += '<text class="xn-label" x="' + lx + '" y="' + (pos.y + 16) +
         '" fill="' + fillInfo.textColor + '" dominant-baseline="middle">';
    for (let i = 0; i < labelLines.length; i++) {
      s += '<tspan x="' + lx + '" dy="' + (i === 0 ? "0" : "1.083em") + '">' + escapeHtml(labelLines[i]) + '</tspan>';
    }
    s += '</text>';

    // Value + delta (only for quantified nodes).
    const valueText = formatNodeValue(node.id);
    if (valueText) {
      const valueY = pos.y + pos.height - 12;
      s += '<text class="xn-value" x="' + (pos.x + LABEL_INSET) + '" y="' + valueY +
           '" fill="' + fillInfo.textColor + '" dominant-baseline="middle" opacity="0.75">' + escapeHtml(valueText) + '</text>';
      const deltaInfo = formatNodeDelta(node.id);
      if (deltaInfo.text && deltaInfo.text !== "—") {
        const deltaColor = deltaColorFor(node, deltaInfo);
        const deltaX = chips.svg ? chips.leftEdge - 6 : pos.x + pos.width - LABEL_INSET;
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
// Conservative canvas ceilings (Chrome caps a side at 16384px and the total
// area well below 2^31). Exceeding either yields a blank/failed canvas, so we
// back the density off for very large maps rather than fail.
export const EXPORT_MAX_CANVAS_DIM  = 16384;
export const EXPORT_MAX_CANVAS_AREA = 16384 * 16384;

// Rasterize the export SVG to a PNG Blob. Returns a Promise<Blob> so it can be
// handed straight to ClipboardItem (which keeps the originating user-gesture
// alive while the image loads).
//
// Crucially, the SVG is rendered at the *scaled* size (its width/height grow
// while the viewBox stays in layout coordinates), so the browser rasterizes
// the vectors at full target resolution — genuinely sharp at any size — rather
// than upscaling a low-resolution bitmap. The density is clamped so the canvas
// never exceeds the browser's limits; for very large maps it drops below the
// target (even below 1×) to produce the largest valid image instead of failing.
export function renderExportPngBlob(svg: string, width: number, height: number, pal: ExportPalette): Promise<Blob> {
  return new Promise((resolve, reject) => {
    let scale = Math.min(
      EXPORT_PNG_SCALE,
      EXPORT_MAX_CANVAS_DIM / width,
      EXPORT_MAX_CANVAS_DIM / height,
      Math.sqrt(EXPORT_MAX_CANVAS_AREA / (width * height))
    );
    if (!isFinite(scale) || scale <= 0) scale = 1;

    const cw = Math.max(1, Math.round(width  * scale));
    const ch = Math.max(1, Math.round(height * scale));

    // Grow the SVG's intrinsic size to the raster size (viewBox unchanged) so
    // it rasterizes vector-sharp at full resolution.
    const scaledSvg = svg.replace(
      /^(<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg") width="[^"]*" height="[^"]*"/,
      '$1 width="' + cw + '" height="' + ch + '"'
    );
    // Blob URL (not a data: URI) so very large maps aren't capped by data-URI
    // length limits. Self-contained, same-origin → does not taint the canvas.
    const blobUrl = URL.createObjectURL(new Blob([scaledSvg], { type: "image/svg+xml;charset=utf-8" }));

    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width  = cw;
        canvas.height = ch;
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = pal.bgDeep || "#111827";
        ctx.fillRect(0, 0, cw, ch);
        ctx.drawImage(img, 0, 0, cw, ch);   // 1:1 — image already at full res
        URL.revokeObjectURL(blobUrl);
        if (!canvas.toBlob) { reject(new Error("Canvas.toBlob unsupported")); return; }
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("PNG encoding failed")), "image/png");
      } catch (e) { URL.revokeObjectURL(blobUrl); reject(e); }
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
  const { svg, width, height } = renderExportSvg(model, { pal });

  // Hand ClipboardItem a Promise<Blob> so the write stays tied to the click
  // gesture even though rasterization is asynchronous.
  const blobPromise = renderExportPngBlob(svg, width, height, pal);
  navigator.clipboard.write([new ClipboardItem({ "image/png": blobPromise })])
    .then(() => showLoadFeedback("Map image copied to clipboard.", false))
    .catch(err => {
      console.error("Clipboard copy failed:", err);
      showLoadFeedback("Couldn't copy to clipboard: " + (err && err.message ? err.message : "permission denied"), true);
    });
}

// ───── PUBLIC: publish as a view-only HTML page ────────────────────────────
export function publishCanvasHtml(): void {
  const model = buildExportModel({ allEdges: true });
  if (!model) { showLoadFeedback("Nothing to publish — load a map or zoom to some boxes.", true); return; }
  const pal = exportPalette();
  const { svg, width, height, nodeInfo } = renderExportSvg(model, { pal });
  const html = buildPublishHtml(svg, width, height, nodeInfo, pal, model.edges);
  downloadTextBlob(html, "systems-map.html", "text/html;charset=utf-8");
  showLoadFeedback("Published systems-map.html (interactive)", false);
}

// Deepest reachable hop over a set of edges — the longest shortest path measured
// downstream from any node (mirrors computeMaxHighlightDepth in 09-graph-
// selection.js). Caps the published viewer's highlight-depth control. Always >= 1.
export function exportMaxHighlightDepth(edges: Edge[]): number {
  const out: Record<string, string[]> = {};
  for (const e of edges) (out[e.from] || (out[e.from] = [])).push(e.to);
  let max = 1;
  for (const start in out) {
    const visited = new Set([start]);
    let frontier = [start], level = 0;
    while (frontier.length) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const to of (out[id] || [])) {
          if (!visited.has(to)) { visited.add(to); next.push(to); }
        }
      }
      if (next.length) level++;
      frontier = next;
    }
    if (level > max) max = level;
  }
  return max;
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
  edges: Edge[]
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
    'var svg=document.getElementById("mv-svg");' +
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
    // ── apply highlight classes (no re-render) ──
    'function applyHighlight(){var anc={},desc={},eh={};' +
      'if(sel){anc=bfs(sel,depth,inAdj,"from");desc=bfs(sel,depth,outAdj,"to");eh=edgesUpDown(sel,depth);}' +
      'var nodes=svg.querySelectorAll(".xnode");for(var i=0;i<nodes.length;i++){var g=nodes[i];var id=g.getAttribute("data-node-id");' +
        'g.classList.remove("sel","anc","desc","dim");if(!sel)continue;' +
        'if(id===sel)g.classList.add("sel");else if(anc[id])g.classList.add("anc");else if(desc[id])g.classList.add("desc");else g.classList.add("dim");}' +
      'var eds=svg.querySelectorAll(".xedge");for(var k=0;k<eds.length;k++){var p=eds[k];p.classList.remove("ehi","edim");if(!sel)continue;' +
        'if(eh[p.getAttribute("data-edge-id")])p.classList.add("ehi");else p.classList.add("edim");}}' +
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
    '<title>Systems Map</title>' +
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
    '<div id="mv-scroll"><div id="mv-inner">' + svg.replace('<svg ', '<svg id="mv-svg" ') + '</div></div>' +
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
