// =============================================================================
// MAIN SVG RENDERER
// -----------------------------------------------------------------------------
// One function — `render()` — produces the entire SVG content for the central
// visualization. It is called whenever anything visual changes: a node is
// selected, a filter is toggled, a slider is moved, a new CSV is loaded.
//
// The render is "stringly typed" — we build a single string of SVG markup and
// assign it to svg.innerHTML in one go. This is simpler and surprisingly fast
// for graphs of this size (a few hundred nodes / edges).
//
// Once the string is committed, `attachSvgEventHandlers()` wires up click,
// hover, and mousemove listeners on the freshly-inserted DOM nodes.
// =============================================================================

import type { Category, GraphNode, NodePosition } from "./types";
import { CATEGORIES, EDGES, NODES, STAGES, STREAMS, layout, nodeById, stageById, state, streamById } from "./03-state";
import { deselectAll, selectNode } from "./09-graph-selection";
import { computeEdgeAnchorOffsets, deltaColorFor, edgeBezierPath, effectMarkerName, escapeHtml, getMapTextScale, wrapLabel, type AnchorOffset } from "./04-utils";
import { COL_GAP, COL_HEADER_HEIGHT, LABEL_INSET, NODE_GAP_Y, NODE_HEIGHT, NODE_WIDTH, ROW_HEADER_WIDTH, ROW_PADDING, SVG_PADDING_TOP } from "./02-config";
import { slotTopY } from "./08-layout";
import { computeRenderEdges, type RenderEdge } from "./10a-collapsed-edges";
import { isEdgeVisible, isNodeVisible, toggleStage, toggleStream } from "./10-filters";
import { formatNodeDelta, formatNodeValue, getOutcomeBorderColor } from "./07-simulation-engine";
import { hideTooltip, moveTooltip, showTooltip } from "./12-tooltip";
import { attachCanvasEditHandlers } from "./16e-canvas-edit";

// Single grabbed reference to the SVG element we draw into.
export const svg = document.getElementById("viz-svg") as unknown as SVGSVGElement;

// ───── Delegated SVG interaction — bound ONCE, never per render ────────────
// render() replaces svg.innerHTML wholesale, so per-element listeners had to be
// re-attached to every node / row label / column header after each render —
// O(nodes) addEventListener calls per frame, the dominant interaction cost on
// large maps. Instead we bind a single listener set on the stable svg element
// here at module load and dispatch by the innermost matching ancestor of the
// event target. render() never touches listeners again.

// Click: node select / row-stream toggle / column-stage toggle / background
// deselect. Canvas-edit affordances (edge select, handles, ghost cells) are
// handled by their own delegated listeners in 16e — skip them here.
svg.addEventListener("click", event => {
  const t = event.target as Element;
  if (!t || typeof t.closest !== "function") return;
  if (t.closest(".edge-handle, .ghost-cell, .edge-hit, .edge-path")) return;

  const nodeGroup = t.closest(".node-group");
  if (nodeGroup) {
    event.stopPropagation();
    selectNode(nodeGroup.getAttribute("data-node-id")!);
    return;
  }
  const rowLabel = t.closest(".row-label-group");
  if (rowLabel) {
    event.stopPropagation();
    toggleStream(rowLabel.getAttribute("data-stream-id")!);
    return;
  }
  const colHeader = t.closest(".col-header-group");
  if (colHeader) {
    event.stopPropagation();
    toggleStage(colHeader.getAttribute("data-stage-id")!);
    return;
  }
  // Empty background → deselect whatever is selected (node OR edge).
  if (state.selectedNodeId || (state.selectedNodeIds && state.selectedNodeIds.size)) {
    deselectAll();
  }
});

// Node rich-tooltip, delegated via mouseover / mouseout / mousemove (these
// bubble to svg, unlike mouseenter / mouseleave). _hoverGroup is the node-group
// currently showing a tooltip, so show/hide fire only on real enter/leave.
let _hoverGroup: Element | null = null;
svg.addEventListener("mouseover", event => {
  const g = (event.target as Element)?.closest?.(".node-group");
  if (g && g !== _hoverGroup) {
    _hoverGroup = g;
    showTooltip(nodeById[g.getAttribute("data-node-id")!], event as MouseEvent);
  }
});
svg.addEventListener("mousemove", event => {
  if (_hoverGroup) moveTooltip(event as MouseEvent);
});
svg.addEventListener("mouseout", event => {
  if (!_hoverGroup) return;
  const related = (event as MouseEvent).relatedTarget as Node | null;
  if (!related || !_hoverGroup.contains(related)) {
    _hoverGroup = null;
    hideTooltip();
  }
});

// ───── Category rendering helpers (shared with the export in 19-export.js) ──
// How many secondary chips to draw before collapsing the rest into a "+N" pill.
export const SECONDARY_CHIP_MAX = 4;

// Monotonic counter for unique gradient ids. Using the node id risked
// collisions (two ids differing only in punctuation sanitize to the same
// string); a counter is collision-proof and the SVG is rebuilt every render.
export let _nodeGradSeq = 0;

// Primary fill for a node. One primary → solid; several → a smooth diagonal
// gradient (↘) blending their colours. Returns { defs, fill, textColor }: defs
// is an SVG <defs> string (empty unless a gradient is needed) and must be
// emitted inside the SVG; fill is a colour or url(#gradId). gradId must be
// unique per node. Colours come straight from CATEGORIES (literal hex), so this
// is identical between the live map and the self-contained export.
export function nodePrimaryFill(node: GraphNode, gradId: string): { defs: string; fill: string; textColor: string } {
  const ids = (node.primaryCategories && node.primaryCategories.length)
    ? node.primaryCategories
    : (node.category ? [node.category] : []);
  // Only PRIMARY-class categories fill the body. (node.category can be a
  // secondary anchor when a node has no primary — such nodes get the gray
  // fallback fill, never a secondary colour painted as both body and chip.)
  const prim = ids.map(id => CATEGORIES[id]).filter((c): c is Category => !!c && (c.class || "primary") !== "secondary");
  if (prim.length === 0) return { defs: "", fill: "#a3a3a3", textColor: "#1c1917" };
  if (prim.length === 1) return { defs: "", fill: prim[0].color, textColor: prim[0].textColor };
  const stops = prim.map((c, i) =>
    '<stop offset="' + Math.round(i / (prim.length - 1) * 100) + '%" stop-color="' + c.color + '"></stop>'
  ).join("");
  const defs = '<defs><linearGradient id="' + gradId + '" x1="0" y1="0" x2="1" y2="1">' + stops + '</linearGradient></defs>';
  return { defs: defs, fill: "url(#" + gradId + ")", textColor: prim[0].textColor };
}

// Secondary category chips: small squares in the node's bottom-right, growing
// leftward, capped at SECONDARY_CHIP_MAX with a "+N" pill. Returns { svg,
// leftEdge } — leftEdge is the x of the left-most chip/pill so the value-delta
// can be right-aligned just to its left and never overlap.
export function nodeSecondaryChips(node: GraphNode, pos: NodePosition): { svg: string; leftEdge: number } {
  const sec = (node.secondaryCategories || []).map(id => CATEGORIES[id]).filter((c): c is Category => Boolean(c));
  const rightEdge = pos.x + pos.width;
  if (sec.length === 0) return { svg: "", leftEdge: rightEdge };
  const bs = 12, gap = 3, inset = 8;
  const shown = sec.slice(0, SECONDARY_CHIP_MAX);
  const overflow = sec.length - shown.length;
  const y = pos.y + pos.height - inset - bs;
  let svg = "", minX = rightEdge;
  shown.forEach((c, i) => {
    const x = rightEdge - inset - bs - i * (bs + gap);
    minX = Math.min(minX, x);
    svg += '<rect x="' + x + '" y="' + y + '" width="' + bs + '" height="' + bs + '" rx="2" fill="' + c.color + '" stroke="rgba(0,0,0,0.4)" stroke-width="1"></rect>';
  });
  if (overflow > 0) {
    const pillW = 22, pillX = minX - gap - pillW;
    minX = pillX;
    svg += '<rect x="' + pillX + '" y="' + y + '" width="' + pillW + '" height="' + bs + '" rx="3" fill="rgba(0,0,0,0.3)" stroke="rgba(0,0,0,0.4)" stroke-width="1"></rect>';
    svg += '<text x="' + (pillX + pillW / 2) + '" y="' + (y + bs / 2) + '" text-anchor="middle" dominant-baseline="central" font-family="Arial,Helvetica,sans-serif" font-size="9" font-weight="700" fill="#ffffff">+' + overflow + '</text>';
  }
  return { svg: svg, leftEdge: minX };
}

// ───── Edge geometry cache ────────────────────────────────────────────────
// computeRenderEdges() (synthetic re-routing DFS) and computeEdgeAnchorOffsets()
// (per-face fan bucketing + sort) depend ONLY on topology, node-visibility, and
// node positions — never on what's selected / hovered / simulated. Selection and
// simulation renders re-run them for nothing, which is wasteful on dense maps
// (E ≫ N). Cache the geometry and reuse it until one of its real inputs changes:
//   • NODES / EDGES array identity — reassigned on every data load / mutation.
//   • layout identity — reassigned by setLayout (geometry + stream/stage hide).
//   • the node-visibility hidden sets — hiddenCategories toggles change
//     isNodeVisible WITHOUT a setLayout, so they're keyed explicitly.
// Selection/hover/sim renders don't touch any of these, so they hit the cache.
interface EdgeGeometry { renderEdges: RenderEdge[]; anchorOffsets: AnchorOffset[]; }
let _edgeGeomCache: (EdgeGeometry & {
  nodes: typeof NODES; edges: typeof EDGES; layout: typeof layout; hiddenKey: string;
}) | null = null;

const _edgeStyleOf = (re: RenderEdge): string =>
  re.synthetic ? (re.dashed ? "dashed" : "solid")
               : (re.edge.style === "dashed" ? "dashed" : "solid");

function edgeGeometry(): EdgeGeometry {
  const hiddenKey =
    [...state.hiddenStreams].sort().join(",") + "|" +
    [...state.hiddenStages].sort().join(",") + "|" +
    [...state.hiddenCategories].sort().join(",");
  const c = _edgeGeomCache;
  if (c && c.nodes === NODES && c.edges === EDGES && c.layout === layout && c.hiddenKey === hiddenKey) {
    return c;
  }
  const renderEdges = computeRenderEdges();
  const anchorOffsets = computeEdgeAnchorOffsets(
    renderEdges,
    layout.positions,
    (re) => re.from,
    (re) => re.to,
    (re) => re.effect,
    _edgeStyleOf,
  );
  _edgeGeomCache = { renderEdges, anchorOffsets, nodes: NODES, edges: EDGES, layout, hiddenKey };
  return _edgeGeomCache;
}

// ───── Viewport virtualization ────────────────────────────────────────────
// On very large maps most nodes/edges are scrolled out of view, yet render()
// would still serialize + parse every one. When the map is big AND the viewport
// dimensions are known, cull to the elements near the visible scroll rect (plus
// a margin) and re-render on scroll (17-events wires the scroll listener). The
// background frame, headers, and row labels are always drawn in full — only the
// O(N) nodes and O(E) edges are culled.
//
// Two guards keep this strictly additive: it's skipped below a node-count
// threshold, and skipped whenever the container has no laid-out size (e.g.
// jsdom in tests). In both cases everything is drawn, exactly as before — so
// small maps and the test suite are unaffected.
export const VIRTUALIZE_MIN_NODES = 400;   // below this, never cull
export const CULL_MARGIN = 600;            // layout px drawn beyond each viewport edge

export interface CullRect { minX: number; minY: number; maxX: number; maxY: number; }

// The layout-coordinate rectangle to draw, or null to draw everything.
export function computeCullRect(): CullRect | null {
  if (NODES.length < VIRTUALIZE_MIN_NODES) return null;
  const scroller = document.getElementById("viz-scroll");
  if (!scroller) return null;
  const vw = scroller.clientWidth, vh = scroller.clientHeight;
  if (!vw || !vh) return null;   // not laid out (jsdom) → draw everything
  const zoom = (state.zoomLevel && !isNaN(state.zoomLevel)) ? state.zoomLevel : 1.0;
  return {
    minX: scroller.scrollLeft / zoom - CULL_MARGIN,
    minY: scroller.scrollTop  / zoom - CULL_MARGIN,
    maxX: (scroller.scrollLeft + vw) / zoom + CULL_MARGIN,
    maxY: (scroller.scrollTop  + vh) / zoom + CULL_MARGIN,
  };
}

// AABB overlap test: does the box [x1,y1]–[x2,y2] intersect the cull rect?
function boxInCull(x1: number, y1: number, x2: number, y2: number, c: CullRect): boolean {
  return x1 <= c.maxX && x2 >= c.minX && y1 <= c.maxY && y2 >= c.minY;
}

// ───── Coalesced render scheduling ────────────────────────────────────────
// Pointer-move and slider-input handlers can fire many times per frame (often
// faster than the display refresh). Each render() is a full SVG rebuild, so
// running it synchronously per event throws away work the browser never paints.
// scheduleRender() collapses any number of requests within a frame into a
// single render() on the next animation frame. A synchronous render() (e.g.
// after a discrete select / load) supersedes a pending one so the DOM is always
// current immediately when a caller needs it.
let _renderQueued = false;
let _renderRAF = 0;
const _raf: (cb: FrameRequestCallback) => number =
  typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb => setTimeout(() => cb(0), 16) as unknown as number);
const _cancelRaf: (h: number) => void =
  typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : (h => clearTimeout(h));

export function scheduleRender(): void {
  if (_renderQueued) return;
  _renderQueued = true;
  _renderRAF = _raf(() => { _renderQueued = false; _renderRAF = 0; render(); });
}

// ───── Transient overlay layer ────────────────────────────────────────────
// The SVG is split into two sibling <g> groups: a STATIC layer (backgrounds,
// headers, edges, nodes — the bulk of the markup) and an OVERLAY layer holding
// only the transient interaction affordances (keyboard cursor slot, hover "+
// add" ghost, drag drop-slot, draft edge, floating drag preview, marquee box).
//
// A node drag that stays within its slot, and an edge-draw drag, change ONLY
// these transient affordances — not a single node or edge. renderOverlay()
// rewrites just the overlay group's innerHTML, leaving the (potentially huge)
// static node/edge DOM completely untouched. That is what keeps dragging smooth
// on large maps: per-frame work drops from "rebuild the whole graph" to "rebuild
// a handful of preview shapes". Anything that changes the static layer (a slot
// crossing that re-parts the stack, a selection change, a filter) still goes
// through the full render().
export const STATIC_LAYER_CLASS  = "ml-static-layer";
export const OVERLAY_LAYER_CLASS = "ml-overlay-layer";

// Build only the transient overlay markup. Reads the live canvasEdit state, so
// it always reflects the current cursor / hover / drag / marquee.
export function buildOverlayContent(): string {
  let content = "";
  const ce = state.canvasEdit;
  if (!state.dataLoaded || !ce) return content;

  // ───── Keyboard cursor slot (arrow-key navigation on an empty slot) ───
  const cursorCell = ce.cursorCell;
  if (cursorCell && layout.rowY[cursorCell.streamId] !== undefined && layout.colX[cursorCell.stageId] !== undefined) {
    const hov = ce.hoverCell;
    const sameAsHover = hov && hov.streamId === cursorCell.streamId && hov.stageId === cursorCell.stageId;
    if (!sameAsHover) {
      const cursorCellNodes = (layout.cells && layout.cells[cursorCell.streamId + ":" + cursorCell.stageId]) || [];
      const slot = Math.max(0, Math.min(cursorCellNodes.length, cursorCell.slotIndex || 0));
      const x = layout.colX[cursorCell.stageId];
      const y = slotTopY(cursorCell.streamId, cursorCell.stageId, slot);
      content += '<g class="cursor-cell">';
      content +=   '<rect x="' + x + '" y="' + y + '" width="' + NODE_WIDTH + '" height="' + NODE_HEIGHT + '" rx="5"></rect>';
      content +=   '<text x="' + (x + NODE_WIDTH / 2) + '" y="' + (y! + NODE_HEIGHT / 2) + '" text-anchor="middle" dominant-baseline="central">Type to create a box</text>';
      content += '</g>';
    }
  }

  // ───── Ghost cell (hover preview for adding a new node) ───────────────
  const hoverCell = ce.hoverCell;
  if (hoverCell && layout.rowY[hoverCell.streamId] !== undefined && layout.colX[hoverCell.stageId] !== undefined) {
    const existingInCell = NODES.reduce((acc, n) => (n.stream === hoverCell.streamId && n.stage === hoverCell.stageId) ? acc + 1 : acc, 0);
    const insertSlot = hoverCell.insertIndex != null ? hoverCell.insertIndex : existingInCell;
    const ghostX = layout.colX[hoverCell.stageId];
    const ghostY = slotTopY(hoverCell.streamId, hoverCell.stageId, insertSlot);
    const ghostLabel = "+ add box";
    content += '<g class="ghost-cell" data-stream-id="' + escapeHtml(hoverCell.streamId) + '" data-stage-id="' + escapeHtml(hoverCell.stageId) + '" data-insert-index="' + insertSlot + '">';
    content +=   '<rect x="' + ghostX + '" y="' + ghostY + '" width="' + NODE_WIDTH + '" height="' + NODE_HEIGHT + '" rx="5"></rect>';
    content +=   '<text x="' + (ghostX + NODE_WIDTH / 2) + '" y="' + (ghostY! + NODE_HEIGHT / 2) + '" text-anchor="middle" dominant-baseline="central">' + ghostLabel + '</text>';
    content += '</g>';
  }

  // ───── Drag landing slot (during node drag) ───────────────────────────
  const drag = ce.draggingNode;
  if (drag && drag.dropCell && drag.dropCell.insertIndex != null && layout.rowY[drag.dropCell.streamId] !== undefined && layout.colX[drag.dropCell.stageId] !== undefined) {
    const dc = drag.dropCell;
    const cellLeft = layout.colX[dc.stageId];
    const groupSet = new Set((drag.groupIds && drag.groupIds.length) ? drag.groupIds : [drag.nodeId]);
    const kept = (layout.cells![dc.streamId + ":" + dc.stageId] || []).filter(n => !groupSet.has(n.id));
    let slotY = layout.rowY[dc.streamId] + ROW_PADDING;
    for (let i = 0; i < dc.insertIndex! && i < kept.length; i++) {
      const kp = layout.positions[kept[i].id];
      slotY += ((kp && kp.height) || NODE_HEIGHT) + NODE_GAP_Y;
    }
    const dpos = layout.positions[drag.nodeId];
    const dropH = (dpos && dpos.height) || NODE_HEIGHT;
    content += '<rect class="drop-slot" x="' + cellLeft + '" y="' + slotY + '" width="' + NODE_WIDTH + '" height="' + dropH + '" rx="5"></rect>';
  }

  // ───── Draft edge preview (while user drags from a node's edge handle) ───
  const draft = ce.draftEdge;
  if (draft) {
    const fromPos = layout.positions[draft.fromNodeId];
    if (fromPos) {
      const sx = fromPos.x + fromPos.width;
      const sy = fromPos.y + fromPos.height / 2;
      const ex = draft.currentX;
      const ey = draft.currentY;
      const dx = ex - sx;
      const ctrl = Math.max(40, Math.abs(dx) * 0.5);
      const draftD =
        "M " + sx + "," + sy +
        " C " + (sx + ctrl) + "," + sy +
        " " + (ex - ctrl) + "," + ey +
        " " + ex + "," + ey;
      content += '<path class="draft-edge" d="' + draftD + '"></path>';
    }
  }

  // ───── Drag preview (a translucent copy of the dragged node at cursor) ──
  if (drag && drag.active && nodeById[drag.nodeId]) {
    const node = nodeById[drag.nodeId];
    const fillInfo = nodePrimaryFill(node, "ndragprev");
    const stream   = streamById[node.stream] || { color: "#94a3b8" };
    const dpos = layout.positions[drag.nodeId];
    const previewH = (dpos && dpos.height) || NODE_HEIGHT;
    const previewLines = (dpos && dpos.labelLines) || wrapLabel(node.label, 24);
    const px = drag.currentX - NODE_WIDTH / 2;
    const py = drag.currentY - previewH / 2;
    content += '<g class="node-drag-preview">';
    content += fillInfo.defs;
    content += '<rect x="' + px + '" y="' + py + '" width="' + NODE_WIDTH + '" height="' + previewH + '" rx="5" fill="' + fillInfo.fill + '" stroke="rgba(0,0,0,0.4)" stroke-width="1"></rect>';
    content += '<rect x="' + px + '" y="' + py + '" width="6" height="' + previewH + '" rx="2" fill="' + stream.color + '"></rect>';
    content += '<text class="node-label" x="' + (px + LABEL_INSET) + '" y="' + (py + 16) + '" fill="' + fillInfo.textColor + '" dominant-baseline="middle">';
    for (let i = 0; i < previewLines.length; i++) {
      const dy = i === 0 ? "0" : "1.083em";
      content += '<tspan x="' + (px + LABEL_INSET) + '" dy="' + dy + '">' + escapeHtml(previewLines[i]) + '</tspan>';
    }
    content += '</text>';
    if (drag.groupIds && drag.groupIds.length > 1) {
      const bx = px + NODE_WIDTH;
      const by = py;
      content += '<circle class="drag-count-badge" cx="' + bx + '" cy="' + by + '" r="11" fill="#1e293b" stroke="#ffffff" stroke-width="1.5"></circle>';
      content += '<text x="' + bx + '" y="' + by + '" text-anchor="middle" dominant-baseline="central" fill="#ffffff" font-size="11" font-weight="600">' + drag.groupIds.length + '</text>';
    }
    content += '</g>';
  }

  // ───── Marquee selection box (shift+drag on empty canvas) ─────────────
  const marquee = ce.marquee;
  if (marquee) {
    const mx = Math.min(marquee.startX, marquee.currentX);
    const my = Math.min(marquee.startY, marquee.currentY);
    const mw = Math.abs(marquee.currentX - marquee.startX);
    const mh = Math.abs(marquee.currentY - marquee.startY);
    content += '<rect class="marquee-box" x="' + mx + '" y="' + my + '" width="' + mw + '" height="' + mh + '" rx="2"></rect>';
  }

  return content;
}

// Rewrite ONLY the overlay group. Used by the node-drag (within-slot) and
// edge-draw hot loops so a per-mousemove frame doesn't rebuild the static
// node/edge DOM. Falls back to a full render() if the overlay group isn't there
// yet (first paint, or the static layer hasn't been built).
let _overlayQueued = false;
let _overlayRAF = 0;
export function renderOverlay(): void {
  if (_overlayRAF) { _cancelRaf(_overlayRAF); _overlayRAF = 0; }
  _overlayQueued = false;
  const overlay = svg.querySelector("." + OVERLAY_LAYER_CLASS);
  if (!overlay) { render(); return; }
  overlay.innerHTML = buildOverlayContent();
}

export function scheduleOverlayRender(): void {
  // A full render already pending will redraw the overlay too — don't double up.
  if (_renderQueued || _overlayQueued) return;
  _overlayQueued = true;
  _overlayRAF = _raf(() => { _overlayQueued = false; _overlayRAF = 0; renderOverlay(); });
}

export function render(): void {
  // A synchronous render makes any queued full OR overlay render redundant.
  if (_renderRAF)  { _cancelRaf(_renderRAF);  _renderRAF = 0; }
  if (_overlayRAF) { _cancelRaf(_overlayRAF); _overlayRAF = 0; }
  _renderQueued = false;
  _overlayQueued = false;
  _nodeGradSeq = 0;   // restart per render — the SVG is rebuilt wholesale
  // When no CSV is loaded at all, blank the SVG. The empty-state grid path
  // boots via bootEmptyStateGrid() which sets state.dataLoaded = true and
  // seeds 3 streams x 3 stages with no nodes — so an empty NODES array is
  // a valid render state and we proceed below.
  if (!state.dataLoaded) {
    svg.setAttribute("width", String(0));
    svg.setAttribute("height", String(0));
    svg.innerHTML = "";
    return;
  }

  // Size the SVG canvas to fit the layout, scaled by the current zoom level
  // (state.zoomLevel defaults to 1.0). The viewBox stays in unscaled layout
  // coordinates so the SVG natively rescales every element by the same factor.
  const zoom = (state.zoomLevel && !isNaN(state.zoomLevel)) ? state.zoomLevel : 1.0;
  svg.setAttribute("width",  String(layout.totalWidth  * zoom));
  svg.setAttribute("height", String(layout.totalHeight * zoom));
  svg.setAttribute("viewBox", "0 0 " + layout.totalWidth + " " + layout.totalHeight);
  // Grow SVG text-size when zoomed out (capped) so labels stay readable.
  // Picked up by `font-size: calc(<base> * var(--map-text-scale, 1))` in
  // assets/css/05-visualization.css.
  svg.style.setProperty("--map-text-scale", String(getMapTextScale(zoom)));

  let content = "";

  // ───── <defs>: arrowhead markers for the different edge types ─────────
  content += '<defs>';
  const arrowColors: Record<string, string> = {
    default:    "var(--edge-default)",
    enables:    "var(--edge-enables)",
    increases:  "var(--edge-increases)",
    decreases:  "var(--edge-decreases)",
    ancestor:   "var(--edge-ancestor)",
    descendant: "var(--edge-descendant)",
  };
  for (const [name, color] of Object.entries(arrowColors)) {
    content += '<marker id="arrow_' + name + '" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">';
    content += '<path d="M 0 0 L 10 5 L 0 10 z" fill="' + color + '"></path>';
    content += '</marker>';
  }
  content += '</defs>';

  // ───── Background stripes (one per stream row) ────────────────────────
  for (const stream of STREAMS) {
    if (state.hiddenStreams.has(stream.id)) continue;
    const rowYPos    = layout.rowY[stream.id];
    const rowHeight  = layout.rowHeights[stream.id];

    // Very faint coloured stripe behind the row
    content += '<rect x="0" y="' + rowYPos + '" width="' + layout.totalWidth + '" height="' + rowHeight + '" fill="' + stream.color + '" opacity="0.025"></rect>';
    // Horizontal divider line just above each row
    content += '<line x1="0" y1="' + rowYPos + '" x2="' + layout.totalWidth + '" y2="' + rowYPos + '" stroke="var(--border-subtle)" stroke-width="1"></line>';
  }

  // ───── Top band where column headers sit ──────────────────────────────
  content += '<rect x="0" y="0" width="' + layout.totalWidth + '" height="' + (SVG_PADDING_TOP + COL_HEADER_HEIGHT) + '" fill="var(--bg-deep)"></rect>';

  // ───── Column headers + vertical dividers ─────────────────────────────
  // Each header is a clickable group (toggles its stage's visibility, mirroring
  // the stream row labels). A hidden stage collapses to a narrow stub: the
  // header shows a "+" and the label runs vertically down a faint full-height
  // band, all of which is clickable to expand again.
  const headerBandBottom = SVG_PADDING_TOP + COL_HEADER_HEIGHT;
  for (const stage of STAGES) {
    const colW = (layout.colWidths && layout.colWidths[stage.id]) || NODE_WIDTH;
    const colLeft = layout.colX[stage.id];
    const isStageCollapsed = state.hiddenStages.has(stage.id);

    const cx = colLeft + colW / 2;
    const stageTip = (isStageCollapsed ? "Click to expand " : "Click to collapse ") + stage.label + " on the map.";
    content += '<g class="col-header-group' + (isStageCollapsed ? ' collapsed' : '') + '" data-stage-id="' + escapeHtml(stage.id) + '" data-tooltip="' + escapeHtml(stageTip) + '">';
    // Transparent hit area over the header band captures the toggle click (the
    // label text has pointer-events:none).
    content += '<rect class="col-header-hit" x="' + colLeft + '" y="0" width="' + colW + '" height="' + headerBandBottom + '"></rect>';
    if (isStageCollapsed) {
      // Faint full-height band so the thin column reads as a strip and can be
      // clicked anywhere down its length; a "+" invites expansion and the label
      // runs vertically down the band.
      content += '<rect class="collapsed-col-band" x="' + colLeft + '" y="' + headerBandBottom + '" width="' + colW + '" height="' + (layout.totalHeight - headerBandBottom) + '"></rect>';
      content += '<text class="col-header-text col-header-plus" x="' + cx + '" y="' + (SVG_PADDING_TOP + 24) + '" text-anchor="middle">+</text>';
      const labelY = headerBandBottom + (layout.totalHeight - headerBandBottom) / 2;
      content += '<text class="col-header-text col-header-stub" x="' + cx + '" y="' + labelY + '" text-anchor="middle" transform="rotate(-90 ' + cx + ' ' + labelY + ')">' + escapeHtml(stage.label) + '</text>';
    } else {
      content += '<text class="col-header-text" x="' + cx + '" y="' + (SVG_PADDING_TOP + 24) + '" text-anchor="middle">' + escapeHtml(stage.label) + '</text>';
    }
    content += '</g>';

    // Dotted divider between columns (skip after the last one)
    if (stage.id !== STAGES[STAGES.length - 1].id) {
      const dividerX = colLeft + colW + COL_GAP / 2;
      content += '<line class="col-divider" x1="' + dividerX + '" y1="' + headerBandBottom + '" x2="' + dividerX + '" y2="' + layout.totalHeight + '"></line>';
    }
  }

  // (The transient interaction affordances that used to be emitted here — the
  // keyboard cursor slot, the hover "+ add box" ghost, and the drag drop-slot —
  // now live in the overlay layer; see buildOverlayContent(). The dragged node
  // still needs a static "dragging-source" class in the node loop below, so we
  // keep a reference to the current drag.)
  const drag = state.canvasEdit && state.canvasEdit.draggingNode;

  // ───── Row label strip on the left (per stream) ───────────────────────
  // Hidden streams keep their label so the user can click to expand again;
  // they're rendered with a .collapsed class for a dimmer visual treatment.
  // Renaming / re-colouring streams happens in the sidebar — the canvas
  // row label is click-to-toggle-only.
  for (const stream of STREAMS) {
    const isCollapsed = state.hiddenStreams.has(stream.id);
    const rowYPos = layout.rowY[stream.id];
    const rowHeight = layout.rowHeights[stream.id];
    const labelText = isCollapsed ? "+ " + stream.short : stream.short;

    const streamTip = (isCollapsed ? "Click to expand " : "Click to collapse ") + stream.label + " on the map.";
    content += '<g class="row-label-group' + (isCollapsed ? ' collapsed' : '') + '" data-stream-id="' + stream.id + '" data-tooltip="' + escapeHtml(streamTip) + '">';
    content += '<rect class="row-label-bg" x="0" y="' + rowYPos + '" width="' + ROW_HEADER_WIDTH + '" height="' + rowHeight + '"></rect>';
    // Thin coloured stripe on the right edge of the strip
    content += '<rect x="' + (ROW_HEADER_WIDTH - 4) + '" y="' + rowYPos + '" width="4" height="' + rowHeight + '" fill="' + stream.color + '" opacity="' + (isCollapsed ? 0.4 : 0.7) + '"></rect>';
    content += '<text class="row-label-text" fill="' + stream.color + '" x="' + (ROW_HEADER_WIDTH / 2) + '" y="' + (rowYPos + rowHeight / 2) + '" text-anchor="middle" dominant-baseline="middle">' + escapeHtml(labelText) + '</text>';
    content += '</g>';
  }

  // ───── Edges (drawn BEFORE nodes so nodes sit on top) ─────────────────
  // computeRenderEdges (10a) returns both the REAL visible→visible edges and
  // the SYNTHETIC "through" edges that re-route causal effects across hidden
  // stages/streams/categories. Both endpoints of every returned edge are
  // guaranteed visible, so their layout positions always exist.
  const flashedEdgeId = state.canvasEdit && state.canvasEdit.flashedEdgeId;
  // Edges changed by the most recent undo/redo — pulsed briefly so the user
  // sees what the operation touched. Cleared on a timer (16g-canvas-undo.js).
  const undoFlashEdgeIds = state.canvasEdit && state.canvasEdit.flashedEdgeIds;
  // Helper: effect → stroke colour + arrow marker name.
  const effectStroke = (effect: string): string =>
    effect === "increases" ? "var(--edge-increases)" :
    effect === "decreases" ? "var(--edge-decreases)" :
    effect === "enables"   ? "var(--edge-enables)"   :
                             "var(--edge-default)";
  const effectMarker = effectMarkerName;

  // The edge re-routing + anchor fan are cached (edgeGeometry) — they depend only
  // on topology / visibility / positions, so selection / hover / sim renders reuse
  // the previous result instead of recomputing. anchorOffsets stays parallel by
  // index to renderEdges (both come from the same cache entry together).
  const { renderEdges, anchorOffsets } = edgeGeometry();

  // Viewport cull rect (null on small maps / unlaid-out containers → draw all).
  const cull = computeCullRect();

  // Two output buffers. Every edge's CASING (a wide background-coloured stroke)
  // is emitted first, then every coloured stroke + arrowhead. Drawing all
  // casings beneath all colours is what produces the transit-map "knockout" gap
  // where one edge crosses or runs under another, keeping the top edge legible.
  // The casing inherits the edge's `dimmed` class so it fades with its edge.
  const CASING_EXTRA = 2;   // casing is this many px wider than the colour stroke
  let edgeCasings = "";
  let edgeStrokes = "";
  const casingPath = (pathD: string, strokeWidth: number, dimmed: boolean): string =>
    '<path class="edge-casing' + (dimmed ? ' dimmed' : '') + '" d="' + pathD +
    '" stroke-width="' + (strokeWidth + CASING_EXTRA) + '"></path>';

  for (let i = 0; i < renderEdges.length; i++) {
    const re = renderEdges[i];
    const fromPos = layout.positions[re.from];
    const toPos   = layout.positions[re.to];
    if (!fromPos || !toPos) continue;   // defensive — endpoints should be visible

    // Virtualization: skip edges whose endpoint bounding box is well outside the
    // viewport. Uses both endpoints, so an edge spanning across the viewport
    // between two off-screen nodes is still drawn (its bbox overlaps the rect).
    if (cull) {
      const ex1 = Math.min(fromPos.x, toPos.x);
      const ey1 = Math.min(fromPos.y, toPos.y);
      const ex2 = Math.max(fromPos.x + fromPos.width, toPos.x + toPos.width);
      const ey2 = Math.max(fromPos.y + fromPos.height, toPos.y + toPos.height);
      if (!boxInCull(ex1, ey1, ex2, ey2, cull)) continue;
    }

    // Smooth cubic bezier between the two node faces — forward edges connect
    // right→left, backward / feedback edges connect left→right (same style,
    // mirrored faces; see edgeBezierPath). Fanned by the per-edge anchor offsets
    // so co-incident arrows separate (shared with the export — see 04-utils.js).
    const off = anchorOffsets[i];
    const pathD = edgeBezierPath(fromPos, toPos, off.fromYOffset, off.toYOffset);

    if (re.synthetic) {
      // Honour the sidebar edge filters (re.dashed marks a re-routed chain that
      // contains a dashed link).
      if (state.hiddenEffects.has(re.effect)) continue;
      if (state.hiddenStyles.has(re.dashed ? "dashed" : "solid")) continue;
      // Synthetic "through" edge — presentation only: not selectable/editable.
      // Drawn THINNER than a real edge so it reads as derived, and dashed only
      // when it re-routes a dashed link (re.dashed, set in 10a). Bold + coloured
      // when incident to the selected node (highlightedEdgeIds only holds real
      // edge ids, so we check incidence directly); dimmed when some OTHER node
      // is the sole selection.
      const incident = state.selectedNodeId === re.from || state.selectedNodeId === re.to;
      let strokeWidth   = 1;
      let strokeOpacity = 0.6;
      let dimmed        = false;
      let strokeColor   = "var(--edge-default)";
      let markerName    = "default";
      if (state.selectedNodeId && state.selectedNodeIds.size <= 1) {
        if (incident) {
          strokeWidth = 1.5; strokeOpacity = 0.95;   // still thinner than a real highlighted edge (2)
          strokeColor = effectStroke(re.effect);
          markerName  = effectMarker(re.effect);
        } else {
          dimmed = true;
        }
      }
      const synthDash = re.dashed ? ' stroke-dasharray="5 4"' : '';
      const effectClass = ' effect-' + re.effect;   // increases / decreases / neutral
      edgeCasings += casingPath(pathD, strokeWidth, dimmed);
      edgeStrokes += '<path class="edge-path synthetic' + effectClass + (dimmed ? ' dimmed' : '') +
        '" d="' + pathD + '" stroke="' + strokeColor +
        '" stroke-width="' + strokeWidth + '" stroke-opacity="' + strokeOpacity +
        '"' + synthDash + ' marker-end="url(#arrow_' + markerName + ')"></path>';
      continue;
    }

    const edge = re.edge;
    if (!isEdgeVisible(edge)) continue;   // hidden via the sidebar edge filters
    // Default styling — overridden if the edge is highlighted by a selection.
    let strokeColor   = "var(--edge-default)";
    let strokeWidth   = 1;
    let strokeOpacity = 0.45;
    let markerEnd     = "";
    let dimmed        = false;
    const isEdgeFlashed = edge.id === flashedEdgeId;

    // Only a single-node selection highlights/dims edges — a multi-selection
    // suppresses neighbour highlighting (highlightedEdgeIds is empty), so leave
    // every edge at its default styling rather than dimming them all.
    if (state.selectedNodeId && state.selectedNodeIds.size <= 1) {
      const isHighlighted = state.highlightedEdgeIds.has(edge.id!);
      if (isHighlighted) {
        strokeColor = effectStroke(edge.effect);
        strokeWidth = 2;
        strokeOpacity = 0.9;
        markerEnd = ' marker-end="url(#arrow_' + edge.effect + ')"';
      } else {
        dimmed = true;
      }
    }
    if (isEdgeFlashed) {
      // Edge was just clicked — paint it boldly until the flash flag clears.
      strokeColor = effectStroke(edge.effect);
      strokeWidth = 2.5;
      strokeOpacity = 1;
      markerEnd = ' marker-end="url(#arrow_' + edge.effect + ')"';
      dimmed = false;
    }
    const isEdgeSelected = edge.id === state.selectedEdgeId;
    // The currently-selected edge always renders in its effect colour, bold
    // and undimmed — so creation (auto-select) and arrow-key effect cycling
    // both show an unambiguous colour change without depending on whether
    // the from-node is also selected.
    if (isEdgeSelected) {
      strokeColor = effectStroke(edge.effect);
      strokeWidth = 3;
      strokeOpacity = 1;
      markerEnd = ' marker-end="url(#arrow_' + edge.effect + ')"';
      dimmed = false;
    }

    // Casing under the colour stroke (knockout gap at crossings / under-runs).
    edgeCasings += casingPath(pathD, strokeWidth, dimmed);

    // Wide invisible hit-path drawn UNDER the visible edge for easier clicking
    // (uses the same fanned path so the hit region tracks the drawn edge).
    // pointer-events:stroke (set in CSS) limits hits to the stroked area.
    edgeStrokes += '<path class="edge-hit" data-edge-id="' + edge.id + '" d="' + pathD + '"></path>';

    // Effect class lets CSS bind colour-based styles (selected-edge halo, etc)
    // without having to parse the inline stroke value.
    const effectClass = edge.effect ? ' effect-' + edge.effect : '';
    const isEdgeUndoFlashed = undoFlashEdgeIds && undoFlashEdgeIds.has(edge.id!);
    const classAttr = ' class="edge-path' + effectClass + (dimmed ? ' dimmed' : '') + (isEdgeFlashed ? ' flashed' : '') + (isEdgeUndoFlashed ? ' undo-flash' : '') + (isEdgeSelected ? ' selected' : '') + '"';
    // Dashed line style (inline, so it persists through every selection state).
    const dashAttr = edge.style === "dashed" ? ' stroke-dasharray="6 5"' : '';
    edgeStrokes += '<path' + classAttr + ' data-edge-id="' + edge.id + '" d="' + pathD + '" stroke="' + strokeColor + '" stroke-width="' + strokeWidth + '" stroke-opacity="' + strokeOpacity + '"' + dashAttr + markerEnd + '></path>';
  }

  // Casings first (so they sit under every colour stroke), then the colours.
  content += edgeCasings + edgeStrokes;

  // Pre-compute the set of search-match ids once so the per-node check
  // below is O(1) instead of O(matches). Tiny optimisation for 73 nodes,
  // but it also makes the inner loop easier to read.
  const searchMatchIds = (state.searchMatches && state.searchMatches.length > 0)
    ? new Set(state.searchMatches.map(m => m.node.id))
    : null;

  // Nodes changed by the most recent undo/redo — pulsed briefly (and forced
  // un-dimmed by CSS) so the user sees what the operation touched.
  const undoFlashNodeIds = state.canvasEdit && state.canvasEdit.flashedNodeIds;

  // ───── Nodes ──────────────────────────────────────────────────────────
  for (const node of NODES) {
    if (!isNodeVisible(node)) continue;
    const pos = layout.positions[node.id];
    if (!pos) continue;
    // Virtualization: skip nodes whose box is outside the viewport cull rect.
    if (cull && !boxInCull(pos.x, pos.y, pos.x + pos.width, pos.y + pos.height, cull)) continue;
    const stream   = streamById[node.stream];
    const fillInfo = nodePrimaryFill(node, "ngrad_" + (_nodeGradSeq++));
    const textColor = fillInfo.textColor;
    const chips    = nodeSecondaryChips(node, pos);

    // Class flags applied to the <g> wrapper — see 05-visualization.css
    // (state glows) + 13-search.css (search halo).
    // Every member of the multi-selection gets the "selected" glow. The
    // ancestor/descendant/dimmed neighbour treatment only applies in
    // single-select (refreshNeighborHighlight empties those sets when >1 is
    // selected, so multi-select renders un-selected nodes plainly — no noise).
    let nodeClasses = "node-group";
    if (state.selectedNodeIds.has(node.id)) {
      nodeClasses += " selected";
    } else if (state.selectedNodeId && state.selectedNodeIds.size <= 1) {
      if      (state.ancestorSet.has(node.id))    nodeClasses += " ancestor";
      else if (state.descendantSet.has(node.id))  nodeClasses += " descendant";
      else                                        nodeClasses += " dimmed";
    }
    if (state.hoveredNodeId === node.id) nodeClasses += " hovered";
    if (searchMatchIds && searchMatchIds.has(node.id)) nodeClasses += " search-match";
    if (undoFlashNodeIds && undoFlashNodeIds.has(node.id)) nodeClasses += " undo-flash";
    // Ghost the source node while it's being dragged — the live preview
    // (rendered below the node loop) follows the cursor.
    if (drag && drag.nodeId === node.id) nodeClasses += " dragging-source";

    content += '<g class="' + nodeClasses + '" data-node-id="' + node.id + '">';
    content += fillInfo.defs;   // per-node gradient def (empty unless multi-primary)

    // ── Background rect with conditional border ──
    let strokeColor = "rgba(0,0,0,0.4)";
    let strokeWidth = 1;
    const outcomeStatusColor = getOutcomeBorderColor(node.id);

    if (state.selectedNodeIds.has(node.id)) {
      strokeColor = "#ffffff";
      strokeWidth = 2.5;
    } else if (state.ancestorSet.has(node.id)) {
      strokeColor = "var(--edge-ancestor)";
      strokeWidth = 2;
    } else if (state.descendantSet.has(node.id)) {
      strokeColor = "var(--edge-descendant)";
      strokeWidth = 2;
    } else if (outcomeStatusColor && !state.selectedNodeId && !state.selectedNodeIds.size) {
      // Show good/bad colour around outcome nodes when nothing is selected.
      strokeColor = outcomeStatusColor;
      strokeWidth = 2;
    }

    content += '<rect class="node-rect" x="' + pos.x + '" y="' + pos.y + '" width="' + pos.width + '" height="' + pos.height + '" rx="5" fill="' + fillInfo.fill + '" stroke="' + strokeColor + '" stroke-width="' + strokeWidth + '"></rect>';

    // ── Coloured stripe down the left edge (the stream colour) ──
    // We draw it as a path so only the left corners are rounded — the right
    // side is flush against the rectangle.
    const barWidth  = 6;
    const barRadius = 5;
    const barLeft   = pos.x;
    const barRight  = pos.x + barWidth;
    const barTop    = pos.y;
    const barBottom = pos.y + pos.height;
    const barPath =
      "M " + (barLeft + barRadius) + "," + barTop +
      " L " + barRight + "," + barTop +
      " L " + barRight + "," + barBottom +
      " L " + (barLeft + barRadius) + "," + barBottom +
      " A " + barRadius + "," + barRadius + " 0 0 1 " + barLeft + "," + (barBottom - barRadius) +
      " L " + barLeft + "," + (barTop + barRadius) +
      " A " + barRadius + "," + barRadius + " 0 0 1 " + (barLeft + barRadius) + "," + barTop +
      " Z";
    content += '<path class="node-stripe" d="' + barPath + '" fill="' + stream.color + '"></path>';

    // ── Label (wrapped to up to 2 lines) ──
    // One <text> with one or two <tspan> children. Using `dy="1.083em"` (the
    // 13/12 ratio of the previous hard-coded line-height) means the gap
    // between lines scales with the font-size, so labels stay legible when
    // --map-text-scale grows on zoom-out without lines overlapping.
    // Lines were wrapped to the node's inner width by computeLayout (which used
    // them to grow the box height); consume them so box height and rendered
    // line count always agree. Anchored to the box top, x at the symmetric inset.
    const labelLines = pos.labelLines || wrapLabel(node.label, 24);
    const labelX = pos.x + LABEL_INSET;
    const labelBlockTopY = pos.y + 16;
    content += '<text class="node-label" x="' + labelX + '" y="' + labelBlockTopY + '" fill="' + textColor + '" dominant-baseline="middle">';
    for (let lineIdx = 0; lineIdx < labelLines.length; lineIdx++) {
      const dy = lineIdx === 0 ? "0" : "1.083em";
      content += '<tspan x="' + labelX + '" dy="' + dy + '">' + escapeHtml(labelLines[lineIdx]) + '</tspan>';
    }
    content += '</text>';

    // ── Value + delta (only for nodes with a baseline) ──
    const valueText = formatNodeValue(node.id);
    if (valueText) {
      const deltaInfo = formatNodeDelta(node.id);
      const valueY = pos.y + pos.height - 12;
      content += '<text class="node-value" x="' + (pos.x + LABEL_INSET) + '" y="' + valueY + '" fill="' + textColor + '" dominant-baseline="middle" opacity="0.75">' + escapeHtml(valueText) + '</text>';

      if (deltaInfo.text && deltaInfo.text !== "—") {
        const deltaColor = deltaColorFor(node, deltaInfo);
        // Sit the delta just left of any secondary chips so they keep the corner.
        const deltaX = chips.svg ? chips.leftEdge - 6 : pos.x + pos.width - LABEL_INSET;
        content += '<text class="node-delta" x="' + deltaX + '" y="' + valueY + '" fill="' + deltaColor + '" text-anchor="end" dominant-baseline="middle" font-weight="600">' + escapeHtml(deltaInfo.text) + '</text>';
      }
    }

    // ── Secondary category chips (bottom-right) ──
    content += chips.svg;

    // Edge-drag handle on the right edge of every node. Visible only on hover
    // via CSS. Mousedown starts an edge-drag (see 16e-canvas-edit.js).
    content += '<circle class="edge-handle" data-node-id="' + escapeHtml(node.id) + '" cx="' + (pos.x + pos.width) + '" cy="' + (pos.y + pos.height / 2) + '" r="6"></circle>';

    content += '</g>';
  }

  // (The draft-edge preview, floating drag preview, and marquee box are drawn
  // into the overlay layer — see buildOverlayContent() — so a drag that doesn't
  // re-part the static stack only rewrites the overlay group.)

  // ───── Empty-state hint when no nodes exist ───────────────────────────
  if (NODES.length === 0) {
    const cx = (ROW_HEADER_WIDTH + layout.totalWidth) / 2;
    const cy = (SVG_PADDING_TOP + COL_HEADER_HEIGHT + layout.totalHeight) / 2;
    content += '<text class="empty-state-hint" x="' + cx + '" y="' + cy + '" text-anchor="middle" dominant-baseline="middle">';
    content +=   '<tspan x="' + cx + '" dy="0">Click any cell to add your first box.</tspan>';
    content +=   '<tspan x="' + cx + '" dy="1.5em" class="empty-state-hint-sub">Drag from a box\'s right edge to draw a link. Press Delete to remove. Need bulk import? Use Build map.</tspan>';
    content += '</text>';
  }

  // Commit in two sibling groups: the bulk static content, then the transient
  // overlay. One innerHTML write, so a full render costs the same as before —
  // but the overlay group can now be rewritten on its own (renderOverlay) for
  // the per-frame drag/draw loops. Then wire up the (delegated) event listeners.
  svg.innerHTML =
    '<g class="' + STATIC_LAYER_CLASS + '">' + content + '</g>' +
    '<g class="' + OVERLAY_LAYER_CLASS + '">' + buildOverlayContent() + '</g>';
  attachSvgEventHandlers();
}

// Patch only the value / delta / outcome-border of quantified nodes in place,
// skipping a full SVG rebuild. A simulation slider scrub recomputes downstream
// values every frame but changes nothing structural — same nodes, same edges,
// same positions — so on a large map a full render() is mostly wasted work.
// Returns true if it fully handled the update; false (→ caller falls back to a
// full render) when:
//   • something is selected — selection/ancestor borders interact with the
//     outcome border and aren't worth patching in place (rare during a scrub), or
//   • a delta label needs to appear or disappear — that's a markup change, so
//     the structure must be rebuilt.
export function updateSimulationValuesInPlace(): boolean {
  if (!state.dataLoaded) return false;
  if (state.selectedNodeId || state.selectedNodeIds.size) return false;
  const staticLayer = svg.querySelector("." + STATIC_LAYER_CLASS);
  if (!staticLayer) return false;

  // One DOM sweep → id-keyed map (only visible nodes have a group element).
  const groupById = new Map<string, Element>();
  staticLayer.querySelectorAll(".node-group").forEach(g => {
    const id = g.getAttribute("data-node-id");
    if (id) groupById.set(id, g);
  });

  // Pass 1: bail to a full render if any delta label must appear/disappear.
  for (const node of NODES) {
    if (node.baseline === undefined || node.baseline === null) continue;
    const group = groupById.get(node.id);
    if (!group) continue;
    const d = formatNodeDelta(node.id);
    const needs = !!(d.text && d.text !== "—");
    const has = !!group.querySelector(".node-delta");
    if (needs !== has) return false;
  }

  // Pass 2: patch value text, delta text + colour, and the outcome border.
  for (const node of NODES) {
    if (node.baseline === undefined || node.baseline === null) continue;
    const group = groupById.get(node.id);
    if (!group) continue;

    const valueEl = group.querySelector(".node-value");
    if (valueEl) valueEl.textContent = formatNodeValue(node.id);

    const d = formatNodeDelta(node.id);
    const deltaEl = group.querySelector(".node-delta");
    if (deltaEl && d.text && d.text !== "—") {
      deltaEl.textContent = d.text;
      deltaEl.setAttribute("fill", deltaColorFor(node, d));
    }

    const rectEl = group.querySelector(".node-rect");
    if (rectEl) {
      const outcome = getOutcomeBorderColor(node.id);
      rectEl.setAttribute("stroke", outcome || "rgba(0,0,0,0.4)");
      rectEl.setAttribute("stroke-width", outcome ? "2" : "1");
    }
  }
  return true;
}

// Ensure the delegated event listeners are wired. All node / row-label /
// column-header / tooltip handling is delegated to the stable svg element at
// module load (see the top of this file), and the canvas direct-edit gestures
// (edge select, edge handles, node drag) are delegated once here. Called after
// every render() but binds at most once — render() does NOT re-attach
// per-element listeners (that was the old O(nodes) per-frame cost).
export function attachSvgEventHandlers(): void {
  if (typeof attachCanvasEditHandlers === "function") attachCanvasEditHandlers();
}
