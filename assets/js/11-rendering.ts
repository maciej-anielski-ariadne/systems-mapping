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
import { CATEGORIES, EDGES, NODES, STAGES, STREAMS, layout, nodeById, setLayout, stageById, state, streamById } from "./03-state";
import { deselectAll, selectNode, notifySelectionChanged } from "./09-graph-selection";
import { computeEdgeAnchorOffsets, deltaColorFor, edgeBezierPath, effectMarkerName, escapeHtml, getMapTextScale, isBackwardEdge, simEffectFill, wrapLabel, SIM_FLAT_FILL, SIM_INK, type AnchorOffset } from "./04-utils";
import { COL_GAP, COL_HEADER_HEIGHT, LABEL_INSET, NODE_GAP_Y, NODE_HEIGHT, NODE_WIDTH, ROW_HEADER_WIDTH, ROW_PADDING, SVG_PADDING_TOP } from "./02-config";
import { computeLayout, layoutGeometryRevision, slotTopY } from "./08-layout";
import { computeRenderEdges, type RenderEdge } from "./10a-collapsed-edges";
import { isCategoryVisible, isEdgeVisible, isNodeVisible, toggleStage, toggleStream } from "./10-filters";
import { formatNodeDelta, formatNodeValue, getOutcomeBorderColor, nodeEffect,
  gatedBy,
} from "./07-simulation-engine";
import { hideTooltip, moveTooltip, showTooltip } from "./12-tooltip";
import { reviewStateOf } from "./24-review-record";
import { attachCanvasEditHandlers } from "./16e-canvas-edit";

// Single grabbed reference to the SVG element we draw into.
export const svg = document.getElementById("viz-svg") as unknown as SVGSVGElement;

// ───── Delegated SVG interaction — bound ONCE, never per render ────────────
// This uses "event delegation" (see docs/GLOSSARY.md): instead of giving every
// single box and label its own click-handler, we put ONE set of handlers on the
// container and, when a click happens, look at what was actually clicked.
// Why it matters here: render() rebuilds the whole drawing each time, so
// per-element listeners would have to be re-attached to every node / row label /
// column header after each render — one addEventListener call per box, every
// frame, which is the dominant interaction cost on large maps. Instead we bind a
// single listener set on the stable svg element here at module load and dispatch
// by the innermost matching ancestor of the event target. render() never touches
// listeners again.

// Click: node select / row-stream toggle / column-stage toggle / background
// deselect. Canvas-edit affordances (edge select, handles, ghost cells) are
// handled by their own delegated listeners in 16e — skip them here.
// Any pointer press on the map ends a zoom gesture first: hit-testing, drag
// maths and the drawn slice all assume the SVG is at its true size, which is
// only so once the gesture's compositor transform has been folded back in.
// Capture phase, so it runs before 16e's drag / marquee handlers.
svg.addEventListener("mousedown", () => flushZoomGesture(), true);

svg.addEventListener("click", event => {
  flushZoomGesture();
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
// Fill-tag categories hidden in the sidebar are left out of the blend — a node
// whose every fill tag is hidden falls back to the gray fill (it only leaves
// the map when its corner tags are all hidden too — see isNodeVisible).
export function nodePrimaryFill(node: GraphNode, gradId: string): { defs: string; fill: string; textColor: string } {
  const ids = ((node.primaryCategories && node.primaryCategories.length)
    ? node.primaryCategories
    : (node.category ? [node.category] : [])).filter(isCategoryVisible);
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
// can be right-aligned just to its left and never overlap. Corner tags hidden
// in the sidebar get no chip.
export function nodeSecondaryChips(node: GraphNode, pos: NodePosition): { svg: string; leftEdge: number } {
  const sec = (node.secondaryCategories || []).filter(isCategoryVisible)
    .map(id => CATEGORIES[id]).filter((c): c is Category => Boolean(c));
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
//   • the layout GEOMETRY REVISION (08-layout) — bumped only when some node
//     actually moved / resized or a row/column changed. Keying on the layout
//     object identity instead (as this cache first did) meant a guaranteed miss
//     on every setLayout, and the hot paths call computeLayout() per frame — a
//     node drag, an inline-rename keystroke, a hover-cell crossing — while
//     producing byte-identical geometry. The revision turns those into hits.
//   • the node-visibility hidden sets — hiddenCategories toggles change
//     isNodeVisible WITHOUT a setLayout, so they're keyed explicitly.
// Selection/hover/sim renders don't touch any of these, so they hit the cache.
interface EdgeGeometry { renderEdges: RenderEdge[]; anchorOffsets: AnchorOffset[]; }
let _edgeGeomCache: (EdgeGeometry & {
  nodes: typeof NODES; edges: typeof EDGES; geometryRevision: number; hiddenKey: string;
}) | null = null;

const _edgeStyleOf = (re: RenderEdge): string =>
  re.synthetic ? (re.dashed ? "dashed" : "solid")
               : (re.edge.style === "dashed" ? "dashed" : "solid");

function edgeGeometry(): EdgeGeometry {
  const hiddenKey =
    [...state.hiddenStreams].sort().join(",") + "|" +
    [...state.hiddenStages].sort().join(",") + "|" +
    [...state.hiddenCategories].sort().join(",");
  const geometryRevision = layoutGeometryRevision();
  const c = _edgeGeomCache;
  if (c && c.nodes === NODES && c.edges === EDGES && c.geometryRevision === geometryRevision && c.hiddenKey === hiddenKey) {
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
  _edgeGeomCache = { renderEdges, anchorOffsets, nodes: NODES, edges: EDGES, geometryRevision, hiddenKey };
  return _edgeGeomCache;
}

// ───── Viewport virtualization ────────────────────────────────────────────
// "Virtualization" = only build the part of the map that's actually on screen
// (see docs/GLOSSARY.md). On very large maps most nodes/edges are scrolled out
// of view, yet render() would still serialize + parse every one. When the map is
// big AND the viewport dimensions are known, cull ("cull" = leave out) the
// elements far from the visible scroll rect (keeping a margin) and re-render on
// scroll (17-events wires the scroll listener). The
// background frame, headers, and row labels are always drawn in full — only the
// O(N) nodes and O(E) edges are culled.
//
// Two guards keep this strictly additive: it's skipped below a node-count
// threshold, and skipped whenever the container has no laid-out size (e.g.
// jsdom in tests). In both cases everything is drawn, exactly as before — so
// small maps and the test suite are unaffected.
export const VIRTUALIZE_MIN_NODES = 400;   // below this node count…
export const VIRTUALIZE_MIN_EDGES = 2000;  // …AND below this edge count, never cull
export const CULL_MARGIN = 600;            // layout px drawn beyond each viewport edge
// How close (layout px) the viewport may come to the edge of the already-drawn
// region before we redraw a fresh, re-centred slice. Must be < CULL_MARGIN so
// there is always drawn content between the trigger line and the drawn edge.
// Effect: a fresh slice is drawn roughly every (CULL_MARGIN − RERENDER_BUFFER)
// px of scroll; in between, the browser scrolls the existing SVG natively (no
// rebuild) — which is what keeps panning a large map smooth.
//
// Raised from 250: at 250 the rebuild started with barely a screenful of runway
// and regularly RACED the pan, so it had to be finished this frame and landed
// inside one. Starting it earlier gives schedulePanRender() room to wait for an
// idle gap, and — because the SLICE size is unchanged — each rebuild costs the
// same as before; there are simply more of them, each cheaper to hide. (Growing
// the margin instead, so rebuilds are rarer, measures worse: the slice grows
// with it and a 300-box rebuild can't be hidden in any gap.)
export const RERENDER_BUFFER = 400;

// The margin scales with the viewport: on a large display a fixed 600px band is
// only a fraction of a screen, so a fast pan crosses it (and rebuilds a slice)
// several times a second. Drawing 0.75 of a viewport beyond each edge keeps the
// rebuild cadence roughly constant whatever the window size. Never below the
// historical 600 — small viewports (and every test) keep exactly today's
// numbers. RERENDER_BUFFER scales by the same ratio so the "how close to the
// drawn edge before we redraw" line stays proportionally where it was.
const CULL_MARGIN_VIEWPORT_FRACTION = 0.75;
export function cullMarginFor(viewportSpan: number): number {
  return Math.max(CULL_MARGIN, CULL_MARGIN_VIEWPORT_FRACTION * viewportSpan);
}
function rerenderBufferFor(margin: number): number {
  return margin * (RERENDER_BUFFER / CULL_MARGIN);
}

export interface CullRect { minX: number; minY: number; maxX: number; maxY: number; }

// ───── Zoom-gesture state (owned here, driven by 17-events) ───────────────
// While the user is actively zooming, the SVG keeps the size it was last drawn
// at and 17-events carries the difference on a compositor-only CSS transform —
// no width/height write, no re-raster of the vector tree, no slice rebuild. So
// during a gesture `state.zoomLevel` (what the user has asked for) runs AHEAD of
// the zoom the DOM actually reflects. Everything in this module that converts
// between layout and device pixels — render()'s width/height + text scale, and
// the viewport rect the culling reads — must use the COMMITTED zoom, or the
// drawn slice and the transform would disagree.
//
// null = no gesture in flight; committed zoom is simply state.zoomLevel.
let _committedZoom: number | null = null;
let _zoomGestureCommitter: (() => void) | null = null;

// The zoom the SVG's width / height / viewBox currently reflect.
export function renderZoomLevel(): number {
  if (_committedZoom !== null) return _committedZoom;
  return (state.zoomLevel && !isNaN(state.zoomLevel)) ? state.zoomLevel : 1.0;
}

export function committedZoomLevel(): number | null { return _committedZoom; }

// `commit` is the "fold the transform back into a real render" routine, handed
// over by 17-events with each gesture rather than imported — importing it would
// close a module cycle (11 → 16e → … → 17 → 11) and 17-events is not
// necessarily evaluated by the time this module's body runs.
export function beginZoomGesture(committedZoom: number, commit: () => void): void {
  if (_committedZoom !== null) return;
  _committedZoom = committedZoom;
  _zoomGestureCommitter = commit;
}

export function endZoomGesture(): void {
  _committedZoom = null;
  _zoomGestureCommitter = null;
}

// Force any in-flight zoom gesture to commit NOW. Called before anything that
// needs the DOM to be at its true size and position: a click / mousedown on the
// map, or a caller that is about to write the zoom itself.
export function flushZoomGesture(): void {
  if (_committedZoom !== null && _zoomGestureCommitter) _zoomGestureCommitter();
}

// The visible viewport in layout coordinates, or null when virtualization is
// inactive (small map, or a container with no laid-out size — e.g. jsdom).
function computeViewportRect(): CullRect | null {
  // Gate on edges as well as nodes: a 300-box map with 20 000 links is edge-
  // dominated, and the links are where the DOM bytes are.
  if (NODES.length < VIRTUALIZE_MIN_NODES && EDGES.length < VIRTUALIZE_MIN_EDGES) return null;
  const scroller = document.getElementById("viz-scroll");
  if (!scroller) return null;
  const vw = scroller.clientWidth, vh = scroller.clientHeight;
  if (!vw || !vh) return null;   // not laid out (jsdom) → draw everything
  // The COMMITTED zoom: scrollLeft/scrollTop are in the SVG's current device
  // pixels, which mid-gesture still reflect the last committed zoom.
  const zoom = renderZoomLevel();
  return {
    minX: scroller.scrollLeft / zoom,
    minY: scroller.scrollTop  / zoom,
    maxX: (scroller.scrollLeft + vw) / zoom,
    maxY: (scroller.scrollTop  + vh) / zoom,
  };
}

// The layout-coordinate rectangle to draw (viewport + margin), or null to draw
// everything.
export function computeCullRect(): CullRect | null {
  const vp = computeViewportRect();
  return vp ? cullFromViewport(vp) : null;
}

function cullFromViewport(vp: CullRect): CullRect {
  const marginX = cullMarginFor(vp.maxX - vp.minX);
  const marginY = cullMarginFor(vp.maxY - vp.minY);
  return {
    minX: vp.minX - marginX,
    minY: vp.minY - marginY,
    maxX: vp.maxX + marginX,
    maxY: vp.maxY + marginY,
  };
}

// The cull rect of the most recent render (null when nothing was culled). Used
// by maybeRenderForViewport to decide whether a scroll/zoom has moved far enough
// to need a fresh slice.
let _renderedCull: CullRect | null = null;

// Called on scroll / pan / zoom. Only schedules a render when virtualization is
// active AND the viewport has scrolled within RERENDER_BUFFER of the edge of the
// slice we last drew. Otherwise it's a no-op: the browser scrolls the existing
// (viewport + margin) SVG content on its own, with no rebuild and no jank. On
// small maps computeViewportRect() is null, so scrolling stays entirely free.
//
// `fromPan` marks the scroll-driven caller. A pan rebuild is never urgent —
// there is a whole RERENDER_BUFFER of already-drawn map between the viewport and
// the blank area — so it is scheduled into idle time instead of onto the next
// animation frame, and lands between frames rather than inside one. A
// structural trigger (zoom commit, first paint) still takes the frame.
export function maybeRenderForViewport(fromPan = false): void {
  // A zoom gesture deliberately leaves the drawn slice alone until it commits:
  // the SVG is still at the committed size and the difference rides on a
  // compositor transform, so a rebuild now would draw the wrong slice AND cost
  // exactly the raster we are avoiding.
  if (_committedZoom !== null) return;
  const vp = computeViewportRect();
  if (!vp) return;                       // virtualization inactive → native scroll only
  const schedule = fromPan ? schedulePanRender : scheduleRender;
  if (!_renderedCull) { schedule(); return; }
  const c = _renderedCull;
  const bufferX = rerenderBufferFor(cullMarginFor(vp.maxX - vp.minX));
  const bufferY = rerenderBufferFor(cullMarginFor(vp.maxY - vp.minY));
  if (vp.minX < c.minX + bufferX ||
      vp.minY < c.minY + bufferY ||
      vp.maxX > c.maxX - bufferX ||
      vp.maxY > c.maxY - bufferY) {
    schedule();
  }
}

// AABB overlap test: does the box [x1,y1]–[x2,y2] intersect the cull rect?
function boxInCull(x1: number, y1: number, x2: number, y2: number, c: CullRect): boolean {
  return x1 <= c.maxX && x2 >= c.minX && y1 <= c.maxY && y2 >= c.minY;
}

// ───── Does a link's CURVE reach the viewport? ────────────────────────────
// The old test asked whether the box around an edge's two END NODES overlapped
// the cull rect. On a hairball map that keeps every long link alive everywhere:
// a link from the top-left of the map to the bottom-right has a bounding box
// covering the whole map, so it was drawn into every slice — 51% of the links
// survived culling while only 6% of the boxes did, and the links are where the
// DOM bytes are. Bounding the four bezier control points instead doesn't help:
// edgeBezierPath gives both control points the y of their own endpoint, so
// their box IS the endpoint box.
//
// What does help is asking about the curve itself. A cubic bezier lies inside
// the convex hull of its control points, and de Casteljau splits it into two
// sub-curves with their own (much tighter) hulls. So: test the whole hull first
// — that rejects most links outright, cheaply — and for the survivors, split
// down a few levels and test the pieces. A link is drawn if ANY piece's hull
// still overlaps, which can only ever over-approximate: a curve that really does
// enter the rect is never dropped.
//
// The rect is padded so a stroke (≤3px wide) and its arrowhead can't peek in
// from a curve that passes just outside. The pad is tiny next to the cull margin
// (≥600px), and the viewport is always ≥ RERENDER_BUFFER inside the drawn rect,
// so this can't produce a visible gap.
const CURVE_PAD = 24;
const CURVE_SUBDIVISION_DEPTH = 3;   // up to 8 leaf pieces per curve

// Scratch control points, reused across edges — this runs per edge per render
// and allocating a fresh object each time is pure garbage.
const _cp = { x0: 0, y0: 0, x1: 0, y1: 0, x2: 0, y2: 0, x3: 0, y3: 0 };

// The four control points edgeBezierPath (04-utils) derives from the same
// inputs, anchor fan offsets included, so the two can't disagree about where a
// link goes.
function edgeControlPoints(
  fromPos: NodePosition,
  toPos: NodePosition,
  fromYOffset: number,
  toYOffset: number,
): typeof _cp {
  const startY = fromPos.y + fromPos.height / 2 + fromYOffset;
  const endY   = toPos.y + toPos.height / 2 + toYOffset;
  const backward = isBackwardEdge(fromPos, toPos);
  const startX = backward ? fromPos.x : fromPos.x + fromPos.width;
  const endX   = backward ? toPos.x + toPos.width : toPos.x;
  const dir = backward ? -1 : 1;
  const ctrlOffset = Math.max(40, Math.abs(endX - startX) * 0.5);
  _cp.x0 = startX; _cp.y0 = startY;
  _cp.x1 = startX + dir * ctrlOffset; _cp.y1 = startY;
  _cp.x2 = endX - dir * ctrlOffset;   _cp.y2 = endY;
  _cp.x3 = endX; _cp.y3 = endY;
  return _cp;
}

function cubicIntersectsRect(
  x0: number, y0: number, x1: number, y1: number,
  x2: number, y2: number, x3: number, y3: number,
  c: CullRect, depth: number,
): boolean {
  const minX = Math.min(x0, x1, x2, x3), maxX = Math.max(x0, x1, x2, x3);
  const minY = Math.min(y0, y1, y2, y3), maxY = Math.max(y0, y1, y2, y3);
  if (minX > c.maxX + CURVE_PAD || maxX < c.minX - CURVE_PAD ||
      minY > c.maxY + CURVE_PAD || maxY < c.minY - CURVE_PAD) return false;
  if (depth <= 0) return true;
  // de Casteljau split at t = 0.5 → two halves with the same shape.
  const x01 = (x0 + x1) / 2, y01 = (y0 + y1) / 2;
  const x12 = (x1 + x2) / 2, y12 = (y1 + y2) / 2;
  const x23 = (x2 + x3) / 2, y23 = (y2 + y3) / 2;
  const xa = (x01 + x12) / 2, ya = (y01 + y12) / 2;
  const xb = (x12 + x23) / 2, yb = (y12 + y23) / 2;
  const xm = (xa + xb) / 2, ym = (ya + yb) / 2;
  return cubicIntersectsRect(x0, y0, x01, y01, xa, ya, xm, ym, c, depth - 1) ||
         cubicIntersectsRect(xm, ym, xb, yb, x23, y23, x3, y3, c, depth - 1);
}

// Public for the tests: does the link drawn between these two boxes come near
// `rect` at all?
export function edgeCurveIntersectsRect(
  fromPos: NodePosition,
  toPos: NodePosition,
  rect: CullRect,
  fromYOffset = 0,
  toYOffset = 0,
): boolean {
  const p = edgeControlPoints(fromPos, toPos, fromYOffset, toYOffset);
  return cubicIntersectsRect(p.x0, p.y0, p.x1, p.y1, p.x2, p.y2, p.x3, p.y3, rect, CURVE_SUBDIVISION_DEPTH);
}

// ───── Coalesced render scheduling ────────────────────────────────────────
// Pointer-move and slider-input handlers can fire many times per frame (often
// faster than the display refresh). Each render() is a full SVG rebuild, so
// running it synchronously per event throws away work the browser never paints.
// scheduleRender() collapses any number of requests within a frame into a
// single render() on the next animation frame. "Animation frame" = the moment
// just before the browser next repaints the screen (~60 times a second), via
// requestAnimationFrame; batching redraws onto it means ten rapid changes cause
// one redraw, not ten (see "requestAnimationFrame / coalescing" in
// docs/GLOSSARY.md). A synchronous render() (e.g. after a discrete select /
// load) supersedes a pending one so the DOM is always current immediately when a
// caller needs it.
let _renderQueued = false;
let _cancelQueuedRender: (() => void) | null = null;
const _raf: (cb: FrameRequestCallback) => number =
  typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb => setTimeout(() => cb(0), 16) as unknown as number);
const _cancelRaf: (h: number) => void =
  typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : (h => clearTimeout(h));

// Queue exactly one render, deferred by `schedule` (which returns its own
// canceller). Any number of requests within the same window collapse into one.
function queueRender(schedule: (cb: () => void) => () => void): void {
  if (_renderQueued) return;
  _renderQueued = true;
  _cancelQueuedRender = schedule(() => {
    _renderQueued = false;
    _cancelQueuedRender = null;
    render();
  });
}

export function scheduleRender(): void {
  queueRender(cb => { const h = _raf(cb); return () => _cancelRaf(h); });
}

// How long a pan-triggered slice rebuild may wait for an idle gap before the
// browser runs it anyway. Comfortably shorter than the time it takes a pan to
// eat through RERENDER_BUFFER worth of already-drawn map, so the deferral can
// never expose blank margin.
export const PAN_RENDER_IDLE_TIMEOUT_MS = 100;

// scheduleRender()'s patient twin, for slice rebuilds triggered by panning.
// requestIdleCallback runs the rebuild in whatever gap is left after the
// browser has painted, so the (still substantial) string build + innerHTML
// parse lands BETWEEN frames instead of inside one — the pan keeps its frame
// budget. The `timeout` bounds the wait, and environments without
// requestIdleCallback (jsdom, older Safari) fall back to the animation frame,
// i.e. exactly today's behaviour.
export function schedulePanRender(): void {
  queueRender(cb => {
    if (typeof requestIdleCallback === "function") {
      const h = requestIdleCallback(cb, { timeout: PAN_RENDER_IDLE_TIMEOUT_MS });
      return () => { if (typeof cancelIdleCallback === "function") cancelIdleCallback(h); };
    }
    const h = _raf(cb);
    return () => _cancelRaf(h);
  });
}

// Run a just-scheduled render NOW, in the caller's own task, instead of letting
// it wait for its frame. Used by the zoom commit: it has already written the
// SVG's new size, so letting the render land a frame later would paint the map
// twice — once at the new size with the old slice, once with the new slice.
export function flushScheduledRender(): void {
  if (_renderQueued) render();
}

// Like scheduleRender(), but the layout is recomputed inside the animation
// frame too. Callers that change something the layout depends on (the zoom
// text-scale band, an inline rename that re-wraps a label) used to run
// computeLayout() + render() synchronously inside a wheel / keydown handler —
// the single most expensive thing you can do on the input path. The dirty flag
// is honoured by render() itself, so a synchronous render() that supersedes the
// frame still picks the recompute up rather than drawing a stale layout.
let _layoutDirty = false;
export function scheduleLayoutRender(): void {
  _layoutDirty = true;
  scheduleRender();
}

// Single owner of the `--map-text-scale` CSS variable. Writing a custom
// property on the SVG root invalidates style for EVERY text element that
// reads it (thousands on a big map), so both writers — render() and
// applyZoom() (17-events) — go through here and the write is skipped while
// the value is unchanged, which it is for all zooming within one text-scale
// band. Tracking lives in one module so the two writers can't desync.
let _lastTextScaleVar = "";
export function setMapTextScaleVar(svgEl: SVGSVGElement | HTMLElement, scale: number): void {
  const value = String(scale);
  if (value === _lastTextScaleVar) return;
  _lastTextScaleVar = value;
  (svgEl as SVGSVGElement).style.setProperty("--map-text-scale", value);
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

// ───── Shared node / edge presentation ────────────────────────────────────
// Everything selection-dependent about a drawn element is decided in ONE place
// so the full render() and the incremental selection patch
// (refreshSelectionStyling) can never drift: they call the same functions and
// therefore always produce the same classes and attributes for a given state.

// The per-render selection context, gathered once (these are the same reads the
// node / edge loops used to do inline, hoisted so the patch path can share them).
interface StyleContext {
  searchMatchIds: Set<string> | null;
  undoFlashNodeIds: Set<string> | null | undefined;
  undoFlashEdgeIds: Set<string> | null | undefined;
  flashedEdgeId: string | null | undefined;
  dragNodeId: string | null;
  showOutcomeBorders: boolean;
  singleSelection: boolean;      // exactly one node selected → highlight / dim edges
}

function styleContext(): StyleContext {
  const ce = state.canvasEdit;
  const drag = (ce && ce.draggingNode) || null;
  return {
    searchMatchIds: (state.searchMatches && state.searchMatches.length > 0)
      ? new Set(state.searchMatches.map(m => m.node.id))
      : null,
    undoFlashNodeIds: ce && ce.flashedNodeIds,
    undoFlashEdgeIds: ce && ce.flashedEdgeIds,
    flashedEdgeId: ce && ce.flashedEdgeId,
    dragNodeId: drag ? drag.nodeId : null,
    showOutcomeBorders: !state.selectedNodeId && !state.selectedNodeIds.size,
    singleSelection: !!state.selectedNodeId && state.selectedNodeIds.size <= 1,
  };
}

// Class list for a node's <g> wrapper — see 05-visualization.css (state glows)
// + 13-search.css (search halo).
function nodeGroupClasses(nodeId: string, ctx: StyleContext): string {
  let classes = "node-group";
  if (state.selectedNodeIds.has(nodeId)) {
    classes += " selected";
  } else if (ctx.singleSelection) {
    if      (state.ancestorSet.has(nodeId))    classes += " ancestor";
    else if (state.descendantSet.has(nodeId))  classes += " descendant";
    else                                       classes += " dimmed";
  }
  // Coverage, while a pass is running: where have we not been yet. Added
  // alongside the selection classes rather than instead of them — a box can be
  // both the one you are reviewing and one you agreed ten minutes ago.
  if (state.reviewPass) classes += " rv-" + reviewStateOf(nodeId);
  if (state.hoveredNodeId === nodeId) classes += " hovered";
  if (ctx.searchMatchIds && ctx.searchMatchIds.has(nodeId)) classes += " search-match";
  if (ctx.undoFlashNodeIds && ctx.undoFlashNodeIds.has(nodeId)) classes += " undo-flash";
  if (ctx.dragNodeId === nodeId) classes += " dragging-source";
  return classes;
}

// The node rect's border. NOTE the flat look: `.node-rect { stroke: transparent }`
// in 05-visualization.css wins over this presentation attribute, so the value is
// invisible on the live map — the selection / trace states read as the drop-shadow
// glows keyed off the group classes above. It is still emitted (and patched)
// verbatim because the export and the in-place simulation patch both read it,
// and because moving it into CSS would make these borders visible for the first
// time — a pixel change, which is exactly what we must not do.
function nodeRectStroke(nodeId: string, ctx: StyleContext): { stroke: string; width: string } {
  if (state.selectedNodeIds.has(nodeId))  return { stroke: "#ffffff", width: "2.5" };
  if (state.ancestorSet.has(nodeId))      return { stroke: "var(--edge-ancestor)", width: "2" };
  if (state.descendantSet.has(nodeId))    return { stroke: "var(--edge-descendant)", width: "2" };
  if (ctx.showOutcomeBorders) {
    // Show good/bad colour around outcome nodes when nothing is selected. Only
    // computed on this branch — getOutcomeBorderColor runs the delta formatting
    // internally, and calling it for every box whenever a selection is active
    // was pure waste.
    const outcome = getOutcomeBorderColor(nodeId);
    if (outcome) return { stroke: outcome, width: "2" };
  }
  return { stroke: "rgba(0,0,0,0.4)", width: "1" };
}

// Does this node carry a CSS rule that REPLACES the resting
// `filter: saturate(0.32)` on its rect / stripe? Those nodes must keep their
// literal colours (H5 only pre-desaturates the plain resting ones).
function hasNonRestingFilter(nodeId: string, ctx: StyleContext): boolean {
  return state.selectedNodeIds.has(nodeId) ||
         state.ancestorSet.has(nodeId) ||
         state.descendantSet.has(nodeId) ||
         state.hoveredNodeId === nodeId ||
         !!(ctx.searchMatchIds && ctx.searchMatchIds.has(nodeId)) ||
         !!(ctx.undoFlashNodeIds && ctx.undoFlashNodeIds.has(nodeId));
}

// Effect → stroke colour, shared by the render and the patch.
const effectStroke = (effect: string): string =>
  effect === "increases" ? "var(--edge-increases)" :
  effect === "decreases" ? "var(--edge-decreases)" :
  effect === "enables"   ? "var(--edge-enables)"   :
                           "var(--edge-default)";

// Everything selection-dependent about one drawn edge.
interface EdgeStyle {
  classes: string;        // full class attribute value for the coloured stroke
  casingClasses: string;  // …and for its casing
  stroke: string;
  strokeWidth: number;
  strokeOpacity: number;
  marker: string;         // "" when no arrowhead, else the marker name
}

function edgeStyleFor(re: RenderEdge, ctx: StyleContext): EdgeStyle {
  if (re.synthetic) {
    // Synthetic "through" edge — presentation only: not selectable/editable.
    // Drawn THINNER than a real edge so it reads as derived. Bold + coloured
    // when incident to the selected node (highlightedEdgeIds only holds real
    // edge ids, so we check incidence directly); dimmed when some OTHER node
    // is the sole selection.
    let strokeWidth = 1, strokeOpacity = 0.6, dimmed = false;
    let stroke = "var(--edge-default)", marker = "default";
    if (ctx.singleSelection) {
      if (state.selectedNodeId === re.from || state.selectedNodeId === re.to) {
        strokeWidth = 1.5; strokeOpacity = 0.95;   // still thinner than a real highlighted edge (2)
        stroke = effectStroke(re.effect);
        marker = effectMarkerName(re.effect);
      } else {
        dimmed = true;
      }
    }
    return {
      classes: "edge-path synthetic effect-" + re.effect + (dimmed ? " dimmed" : ""),
      casingClasses: "edge-casing" + (dimmed ? " dimmed" : ""),
      stroke, strokeWidth, strokeOpacity, marker,
    };
  }

  const edge = re.edge;
  let stroke = "var(--edge-default)";
  let strokeWidth = 1;
  let strokeOpacity = 0.45;
  let marker = "";
  let dimmed = false;
  const isEdgeFlashed = edge.id === ctx.flashedEdgeId;

  if (ctx.singleSelection) {
    if (state.highlightedEdgeIds.has(edge.id!)) {
      stroke = effectStroke(edge.effect);
      strokeWidth = 2;
      strokeOpacity = 0.9;
      marker = edge.effect;
    } else {
      dimmed = true;
    }
  }
  if (isEdgeFlashed) {
    // Edge was just clicked — paint it boldly until the flash flag clears.
    stroke = effectStroke(edge.effect);
    strokeWidth = 2.5;
    strokeOpacity = 1;
    marker = edge.effect;
    dimmed = false;
  }
  // The currently-selected edge always renders in its effect colour, bold and
  // undimmed — so creation (auto-select) and arrow-key effect cycling both show
  // an unambiguous colour change whether or not its from-node is selected too.
  const isEdgeSelected = edge.id === state.selectedEdgeId;
  if (isEdgeSelected) {
    stroke = effectStroke(edge.effect);
    strokeWidth = 3;
    strokeOpacity = 1;
    marker = edge.effect;
    dimmed = false;
  }

  const effectClass = edge.effect ? " effect-" + edge.effect : "";
  const isEdgeUndoFlashed = !!(ctx.undoFlashEdgeIds && ctx.undoFlashEdgeIds.has(edge.id!));

  return {
    classes: "edge-path" + effectClass + (dimmed ? " dimmed" : "") + (isEdgeFlashed ? " flashed" : "") +
             (isEdgeUndoFlashed ? " undo-flash" : "") + (isEdgeSelected ? " selected" : ""),
    casingClasses: "edge-casing" + (dimmed ? " dimmed" : ""),
    stroke, strokeWidth, strokeOpacity, marker,
  };
}

// ───── Pre-desaturated fills: no per-element filter at rest, ever ─────────
// `.node-rect` / `.node-stripe` each carry `filter: saturate(0.32)`
// (05-visualization.css). That is one rasterization pass PER ELEMENT, and — the
// expensive part — Chromium must REDO every one of those passes whenever a
// class changes anywhere in the tree that could affect them. Selecting a box
// toggles `dimmed` / `ancestor` / `descendant` on every drawn box, so a single
// click re-rasterized every filtered rect and stripe on screen: the "click lags
// and flashes the whole map" report.
//
// So we never emit a resting filter. The same sRGB saturate(0.32) transform is
// baked into the emitted fill colours and the group is tagged `.pre-desat`,
// which switches the CSS filter off (the class rules live next to the originals
// in 05-visualization.css). The matrix is exact (pinned by
// tests/large-map-fills.test.ts), so the resting pixels are identical — only
// WHERE the desaturation happens changes.
//
// This used to be gated on a drawn-box count (PRE_DESATURATE_MIN_BOXES = 800),
// which virtualization made unreachable: culling keeps the drawn slice around a
// hundred boxes however big the map is, so the optimization never engaged on the
// maps it was written for. The gate is gone — the baked path is the only path.
//
// Only plain resting boxes qualify: a node whose CSS filter is something else
// (selected / trace / hovered / search-match / undo-flash) and any node with a
// GRADIENT fill keep their literal colours and the CSS filter, so their look is
// untouched. Those are a handful of elements at a time — a filter on one hovered
// or selected box costs nothing. A theme switch re-renders the map, which
// re-derives these colours.
const SATURATE_AMOUNT = 0.32;
const _desaturatedColorCache = new Map<string, string>();

// The sRGB saturate() matrix the CSS filter applies, evaluated once per colour.
// Non-hex inputs (CSS variables, rgba(), gradients) are returned untouched —
// callers only pass literal category / stream colours.
export function desaturateColor(color: string, amount = SATURATE_AMOUNT): string {
  const cached = _desaturatedColorCache.get(color);
  if (cached !== undefined) return cached;
  let out = color;
  const hex = color.trim().replace(/^#/, "");
  let r = NaN, g = NaN, b = NaN;
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    r = parseInt(hex[0] + hex[0], 16); g = parseInt(hex[1] + hex[1], 16); b = parseInt(hex[2] + hex[2], 16);
  } else if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    r = parseInt(hex.slice(0, 2), 16); g = parseInt(hex.slice(2, 4), 16); b = parseInt(hex.slice(4, 6), 16);
  }
  if (!isNaN(r) && !isNaN(g) && !isNaN(b)) {
    const s = amount;
    const clamp = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
    const nr = clamp((0.213 + 0.787 * s) * r + (0.715 - 0.715 * s) * g + (0.072 - 0.072 * s) * b);
    const ng = clamp((0.213 - 0.213 * s) * r + (0.715 + 0.285 * s) * g + (0.072 - 0.072 * s) * b);
    const nb = clamp((0.213 - 0.213 * s) * r + (0.715 - 0.715 * s) * g + (0.072 + 0.928 * s) * b);
    const hx = (v: number): string => v.toString(16).padStart(2, "0");
    out = "#" + hx(nr) + hx(ng) + hx(nb);
  }
  _desaturatedColorCache.set(color, out);
  return out;
}

export function render(): void {
  // A synchronous render makes any queued full OR overlay render redundant.
  if (_cancelQueuedRender) { _cancelQueuedRender(); _cancelQueuedRender = null; }
  if (_overlayRAF) { _cancelRaf(_overlayRAF); _overlayRAF = 0; }
  _renderQueued = false;
  _overlayQueued = false;
  // A caller deferred a layout recompute onto this frame (scheduleLayoutRender).
  if (_layoutDirty) { _layoutDirty = false; setLayout(computeLayout()); }
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

  // Read the viewport cull rect BEFORE any attribute writes below — reading
  // scroller.clientWidth/scrollLeft after writing the SVG's size forces a
  // synchronous layout of the whole document mid-render (write→read thrash).
  // Remember it so maybeRenderForViewport knows how far the user can scroll
  // on the already-drawn slice before a fresh one is needed.
  const viewport = computeViewportRect();
  const cull = viewport ? cullFromViewport(viewport) : null;
  _renderedCull = cull;

  // Size the SVG canvas to fit the layout, scaled by the current zoom level
  // (state.zoomLevel defaults to 1.0). The viewBox stays in unscaled layout
  // coordinates so the SVG natively rescales every element by the same factor.
  // renderZoomLevel() is state.zoomLevel except mid-zoom-gesture, when the SVG
  // must stay at the size the compositor transform was computed against.
  const zoom = renderZoomLevel();
  svg.setAttribute("width",  String(layout.totalWidth  * zoom));
  svg.setAttribute("height", String(layout.totalHeight * zoom));
  svg.setAttribute("viewBox", "0 0 " + layout.totalWidth + " " + layout.totalHeight);
  // Grow SVG text-size when zoomed out (capped) so labels stay readable.
  // Picked up by `font-size: calc(<base> * var(--map-text-scale, 1))` in
  // assets/css/05-visualization.css. Guarded write — see setMapTextScaleVar.
  setMapTextScaleVar(svg, getMapTextScale(zoom));

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
  // still needs a static "dragging-source" class in the node loop below, which
  // styleContext() picks up from the live drag.)

  // Which boxes this render will draw. On a culled render we don't scan NODES at
  // all: layout.cells already groups the nodes by (stream, stage), and a cell's
  // rect is known from the row/column maps — so only the cells the cull rect
  // touches are visited. The candidates come back in NODES order so the DOM
  // order (and with it the paint order of any overlapping glow) is exactly what
  // the plain scan produced.
  const drawList = cull ? culledNodeCandidates(cull) : NODES;

  // Everything selection-dependent, resolved once and shared by the edge loop,
  // the node loop, and (later, on a selection change) refreshSelectionStyling.
  const ctx = styleContext();

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
  // The edge re-routing + anchor fan are cached (edgeGeometry) — they depend only
  // on topology / visibility / positions, so selection / hover / sim renders reuse
  // the previous result instead of recomputing. anchorOffsets stays parallel by
  // index to renderEdges (both come from the same cache entry together).
  const { renderEdges, anchorOffsets } = edgeGeometry();

  // (Viewport cull rect was computed at the top of render(), before any
  // attribute writes, to avoid a forced synchronous layout.)

  // Two output buffers. Every edge is drawn twice: first a slightly fatter line
  // in the page's background colour (its "casing"), then the real coloured line
  // on top. Emitting ALL casings first, then all colours, means wherever two
  // arrows cross, the lower one's coloured line is interrupted by the upper
  // one's background-coloured casing — the little gap you see on transit maps
  // (the "knockout"), which keeps the top line legible. See "casing / knockout
  // gap" in docs/GLOSSARY.md. The casing inherits the edge's `dimmed` class so
  // it fades with its edge.
  const CASING_EXTRA = 2;   // casing is this many px wider than the colour stroke
  let edgeCasings = "";
  let edgeStrokes = "";
  // The drawn slice's edges, in emission order, so the incremental selection
  // patch can walk the DOM and the model side by side (see
  // refreshSelectionStyling). Rebuilt from scratch by every render.
  const drawnEdges: RenderEdge[] = [];

  for (let i = 0; i < renderEdges.length; i++) {
    const re = renderEdges[i];
    const fromPos = layout.positions[re.from];
    const toPos   = layout.positions[re.to];
    if (!fromPos || !toPos) continue;   // defensive — endpoints should be visible

    const off = anchorOffsets[i];

    // Virtualization: skip links whose CURVE never comes near the viewport —
    // see edgeCurveIntersectsRect. Links that do reach it are drawn exactly as
    // before, down to the byte.
    if (cull && !edgeCurveIntersectsRect(fromPos, toPos, cull, off.fromYOffset, off.toYOffset)) continue;

    // Smooth cubic bezier between the two node faces — forward edges connect
    // right→left, backward / feedback edges connect left→right (same style,
    // mirrored faces; see edgeBezierPath). Fanned by the per-edge anchor offsets
    // so co-incident arrows separate (shared with the export — see 04-utils.js).
    const pathD = edgeBezierPath(fromPos, toPos, off.fromYOffset, off.toYOffset);

    if (re.synthetic) {
      // Honour the sidebar edge filters (re.dashed marks a re-routed chain that
      // contains a dashed link).
      if (state.hiddenEffects.has(re.effect)) continue;
      if (state.hiddenStyles.has(re.dashed ? "dashed" : "solid")) continue;
      const style = edgeStyleFor(re, ctx);
      const synthDash = re.dashed ? ' stroke-dasharray="5 4"' : '';
      edgeCasings += '<path class="' + style.casingClasses + '" d="' + pathD +
        '" stroke-width="' + (style.strokeWidth + CASING_EXTRA) + '"></path>';
      edgeStrokes += '<path class="' + style.classes +
        '" d="' + pathD + '" stroke="' + style.stroke +
        '" stroke-width="' + style.strokeWidth + '" stroke-opacity="' + style.strokeOpacity +
        '"' + synthDash + ' marker-end="url(#arrow_' + (style.marker || "default") + ')"></path>';
      drawnEdges.push(re);
      continue;
    }

    const edge = re.edge;
    if (!isEdgeVisible(edge)) continue;   // hidden via the sidebar edge filters
    const style = edgeStyleFor(re, ctx);

    // Casing under the colour stroke (knockout gap at crossings / under-runs).
    edgeCasings += '<path class="' + style.casingClasses + '" d="' + pathD +
      '" stroke-width="' + (style.strokeWidth + CASING_EXTRA) + '"></path>';

    // Wide invisible hit-path drawn UNDER the visible edge for easier clicking
    // (uses the same fanned path so the hit region tracks the drawn edge).
    // pointer-events:stroke (set in CSS) limits hits to the stroked area.
    // It paints nothing, so it is only worth emitting where the pointer can
    // actually reach it: inside the real viewport, not out in the cull margin.
    if (!viewport || edgeCurveIntersectsRect(fromPos, toPos, viewport, off.fromYOffset, off.toYOffset)) {
      edgeStrokes += '<path class="edge-hit" data-edge-id="' + edge.id + '" d="' + pathD + '"></path>';
    }

    // Dashed line style (inline, so it persists through every selection state).
    const dashAttr = edge.style === "dashed" ? ' stroke-dasharray="6 5"' : '';
    const markerEnd = style.marker ? ' marker-end="url(#arrow_' + style.marker + ')"' : '';
    edgeStrokes += '<path class="' + style.classes + '" data-edge-id="' + edge.id + '" d="' + pathD +
      '" stroke="' + style.stroke + '" stroke-width="' + style.strokeWidth +
      '" stroke-opacity="' + style.strokeOpacity + '"' + dashAttr + markerEnd + '></path>';
    drawnEdges.push(re);
  }

  // Casings first (so they sit under every colour stroke), then the colours.
  content += edgeCasings + edgeStrokes;

  // ───── Nodes ──────────────────────────────────────────────────────────
  for (const node of drawList) {
    if (!isNodeVisible(node)) continue;
    const pos = layout.positions[node.id];
    if (!pos) continue;
    // Virtualization: skip nodes whose box is outside the viewport cull rect.
    if (cull && !boxInCull(pos.x, pos.y, pos.x + pos.width, pos.y + pos.height, cull)) continue;
    const stream   = streamById[node.stream];
    // While the sliders are out the body says what the run DID to this box
    // rather than what kind of box it is — one meaning at a time. See
    // simEffectFill (04-utils) and nodeEffect (07-simulation-engine).
    const effect   = state.simulationMode ? nodeEffect(node.id) : null;
    const fillInfo = effect
      ? { defs: "", fill: effect.moved ? simEffectFill(effect.merit, effect.strength) : SIM_FLAT_FILL, textColor: SIM_INK }
      : nodePrimaryFill(node, "ngrad_" + (_nodeGradSeq++));
    const textColor = fillInfo.textColor;
    // The corner tags are dropped while the sliders are out. They sit in the
    // bottom-right corner, which is the same corner the run's number wants, and
    // two things in one corner is one thing too many — the tags say what KIND of
    // box this is, which is not the question anyone is asking mid-run.
    const chips    = state.simulationMode
      ? { svg: "", leftEdge: pos.x + pos.width }
      : nodeSecondaryChips(node, pos);

    // Class flags applied to the <g> wrapper — see 05-visualization.css
    // (state glows) + 13-search.css (search halo).
    // Every member of the multi-selection gets the "selected" glow. The
    // ancestor/descendant/dimmed neighbour treatment only applies in
    // single-select (refreshNeighborHighlight empties those sets when >1 is
    // selected, so multi-select renders un-selected nodes plainly — no noise).
    let nodeClasses = nodeGroupClasses(node.id, ctx);

    // Bake the resting desaturation into the colours instead of paying for a
    // per-element CSS filter pass. Only plain solid-filled resting boxes qualify.
    // An effect fill is already exactly the colour it should be, so it takes
    // the same "no filter, please" tag the baked resting fills use — but not
    // their desaturation, which would drain the very thing it is saying.
    const preDesat = !effect && !fillInfo.defs && !hasNonRestingFilter(node.id, ctx);
    if (preDesat) nodeClasses += " pre-desat";
    if (effect) nodeClasses += " sim-fill" + (effect.moved ? "" : " sim-flat");
    // Held back rather than unreached: this box's rule is "weakest input wins"
    // and the weakest one is not something that moved. Without this the box is
    // the same dead grey as one the run never touched, which is the single
    // biggest reason a simulated map reads as broken.
    const gate = effect && !effect.moved ? gatedBy(node.id) : null;
    if (gate) nodeClasses += " sim-held";
    const rectFill   = preDesat ? desaturateColor(fillInfo.fill)  : fillInfo.fill;
    const stripeFill = (preDesat || effect) ? desaturateColor(stream.color) : stream.color;

    content += '<g class="' + nodeClasses + '" data-node-id="' + node.id + '">';
    content += fillInfo.defs;   // per-node gradient def (empty unless multi-primary)

    // ── Background rect with conditional border ──
    const border = nodeRectStroke(node.id, ctx);

    content += '<rect class="node-rect" x="' + pos.x + '" y="' + pos.y + '" width="' + pos.width + '" height="' + pos.height + '" rx="5" fill="' + rectFill + '" stroke="' + border.stroke + '" stroke-width="' + border.width + '"></rect>';


    // ── Coloured stripe down the left edge (the stream colour) ──
    // We draw it as a path so only the left corners are rounded — the right
    // side is flush against the rectangle.
    const barWidth  = 6;
    const barRadius = 5;
    const barLeft   = pos.x;
    const barRight  = pos.x + barWidth;
    const barTop    = pos.y;
    const barBottom = pos.y + pos.height;
    // Build the coloured left stripe as an SVG path. SVG path letters are drawing
    // pen-commands: M = move the pen to a point, L = draw a straight line to a
    // point, A = draw an arc (a rounded corner here), Z = close the shape. The
    // "A radius,radius 0 0 1 x,y" numbers are the arc's radii, then flags that
    // pick which way it curves; we only round the two left corners.
    const barPath =
      "M " + (barLeft + barRadius) + "," + barTop +
      " L " + barRight + "," + barTop +
      " L " + barRight + "," + barBottom +
      " L " + (barLeft + barRadius) + "," + barBottom +
      " A " + barRadius + "," + barRadius + " 0 0 1 " + barLeft + "," + (barBottom - barRadius) +
      " L " + barLeft + "," + (barTop + barRadius) +
      " A " + barRadius + "," + barRadius + " 0 0 1 " + (barLeft + barRadius) + "," + barTop +
      " Z";
    content += '<path class="node-stripe" d="' + barPath + '" fill="' + stripeFill + '"></path>';

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

    // ── Value + delta (simulating only, and only for nodes with a baseline) ──
    // At rest a number on the box is decoration: it is the same number it was
    // the last time you looked, and it is repeated on every box on the map. It
    // starts meaning something the moment it can CHANGE, which is what the
    // sliders being out means — so that is when it is drawn.
    const valueText = state.simulationMode ? formatNodeValue(node.id) : "";
    if (valueText) {
      const deltaInfo = formatNodeDelta(node.id);
      const valueY = pos.y + pos.height - 12;
      content += '<text class="node-value" x="' + (pos.x + LABEL_INSET) + '" y="' + valueY + '" fill="' + textColor + '" dominant-baseline="middle" opacity="0.75">' + escapeHtml(valueText) + '</text>';

      // Where a mover prints how far it moved, a held box prints that it is
      // held. What is holding it is named in the panel and on hover — there is
      // no room for "held by Detection & Seizure Rate" on a box this size, and
      // a truncated name is worse than none.
      if (gate) {
        const heldX = chips.svg ? chips.leftEdge - 6 : pos.x + pos.width - LABEL_INSET;
        content += '<text class="node-held" x="' + heldX + '" y="' + valueY +
          '" text-anchor="end" dominant-baseline="middle">held</text>';
      }

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

  // Remember what this render drew so a later selection change can patch the
  // live elements instead of rebuilding the whole string (see
  // refreshSelectionStyling). Anything that invalidates these — a data
  // mutation, a filter, a layout move — forces the patch back to a full render.
  _drawnEdges = drawnEdges;
  _drawnNodesIdentity = NODES;
  _drawnEdgesIdentity = EDGES;
  _drawnNodesLength = NODES.length;
  _drawnEdgesLength = EDGES.length;
  _drawnGeometryRevision = layoutGeometryRevision();
}

// ───── Incremental selection repaint ──────────────────────────────────────
// Selecting a node changes NOTHING structural: the same boxes and links are
// drawn in the same places. Only class names, the node-rect border, and each
// link's stroke / width / opacity / arrowhead differ. Rebuilding the entire SVG
// string for that — on every click, every arrow key, every search keystroke —
// is what made selection feel heavy on a big map.
//
// refreshSelectionStyling() walks the slice that is already on screen ONCE and
// patches those attributes in place. Because it derives every value from the
// same helpers render() uses (nodeGroupClasses / nodeRectStroke / edgeStyleFor),
// the result is by construction identical to what a full render would have
// produced. It returns false when the drawn slice can no longer be trusted
// (nothing rendered yet, the data or layout moved underneath it, the element
// counts don't line up) — callers then fall back to render().
let _drawnEdges: RenderEdge[] = [];
let _drawnNodesIdentity: typeof NODES | null = null;
let _drawnEdgesIdentity: typeof EDGES | null = null;
let _drawnGeometryRevision = -1;
// Lengths as well as identities: a mutation that pushes into the LIVE arrays
// (commitNewEdge, a splice-based reorder) leaves the identity alone.
let _drawnNodesLength = -1;
let _drawnEdgesLength = -1;

export function refreshSelectionStyling(): boolean {
  if (!state.dataLoaded) return false;
  // A full render is already owed (something structural changed and deferred its
  // repaint onto the next frame) — the drawn slice is known-stale, so patching
  // it would leave the map showing the pre-change markup. Let the caller render.
  if (_renderQueued || _layoutDirty) return false;
  const staticLayer = svg.querySelector("." + STATIC_LAYER_CLASS);
  if (!staticLayer) return false;
  // Stale slice → the caller must do a full render.
  if (_drawnNodesIdentity !== NODES || _drawnEdgesIdentity !== EDGES) return false;
  if (_drawnNodesLength !== NODES.length || _drawnEdgesLength !== EDGES.length) return false;
  if (_drawnGeometryRevision !== layoutGeometryRevision()) return false;

  const casings = staticLayer.querySelectorAll(".edge-casing");
  const paths   = staticLayer.querySelectorAll(".edge-path");
  if (casings.length !== _drawnEdges.length || paths.length !== _drawnEdges.length) return false;

  const ctx = styleContext();

  for (let i = 0; i < _drawnEdges.length; i++) {
    const style = edgeStyleFor(_drawnEdges[i], ctx);
    const path = paths[i];
    setIfChanged(path, "class", style.classes);
    setIfChanged(path, "stroke", style.stroke);
    setIfChanged(path, "stroke-width", String(style.strokeWidth));
    setIfChanged(path, "stroke-opacity", String(style.strokeOpacity));
    if (style.marker) setIfChanged(path, "marker-end", "url(#arrow_" + style.marker + ")");
    else if (path.hasAttribute("marker-end")) path.removeAttribute("marker-end");
    const casing = casings[i];
    setIfChanged(casing, "class", style.casingClasses);
    setIfChanged(casing, "stroke-width", String(style.strokeWidth + 2));
  }

  const groups = staticLayer.querySelectorAll(".node-group");
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    const id = group.getAttribute("data-node-id");
    if (!id) continue;
    const node = nodeById[id];
    if (!node) return false;                 // slice describes nodes we no longer have
    let classes = nodeGroupClasses(id, ctx);
    // A box that gains a selection / trace / halo state needs its literal
    // colours back (its CSS filter is no longer the resting saturate()), and one
    // that loses them goes back to the baked-in desaturated pair.
    const rect = group.querySelector(".node-rect");
    const stripe = group.querySelector(".node-stripe");
    // A gradient (multi-primary) box paints through a per-render <defs> id and
    // is never pre-desaturated, so its fills are left exactly as rendered.
    const gradientFilled = !!rect && (rect.getAttribute("fill") || "").startsWith("url(");
    if (rect && !gradientFilled) {
      // Same three-way decision the full render makes (see the node loop): an
      // effect fill while simulating, otherwise the baked resting pair or the
      // literal colours. This has to agree with render() exactly — a selection
      // patch that fell back to the category fill repainted the whole map in
      // its resting colours the first time anything was clicked mid-simulation.
      const stream = streamById[node.stream];
      const effect = state.simulationMode ? nodeEffect(id) : null;
      if (effect) {
        classes += " sim-fill" + (effect.moved ? "" : " sim-flat");
        setIfChanged(rect, "fill",
          effect.moved ? simEffectFill(effect.merit, effect.strength) : SIM_FLAT_FILL);
        if (stripe && stream) setIfChanged(stripe, "fill", desaturateColor(stream.color));
      } else {
        const preDesat = !hasNonRestingFilter(id, ctx);
        if (preDesat) classes += " pre-desat";
        const solidFill = nodePrimaryFill(node, "").fill;
        setIfChanged(rect, "fill", preDesat ? desaturateColor(solidFill) : solidFill);
        if (stripe && stream) {
          setIfChanged(stripe, "fill", preDesat ? desaturateColor(stream.color) : stream.color);
        }
      }
    }
    setIfChanged(group, "class", classes);
    if (rect) {
      const border = nodeRectStroke(id, ctx);
      setIfChanged(rect, "stroke", border.stroke);
      setIfChanged(rect, "stroke-width", border.width);
    }
  }
  return true;
}

function setIfChanged(el: Element, name: string, value: string): void {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

// rAF-coalesced form, for callers that fire faster than the screen refreshes
// (search keystrokes, marquee drags). A full render already pending supersedes
// it — render() repaints the selection styling anyway.
let _selectionStyleQueued = false;
let _selectionStyleRAF = 0;
export function scheduleSelectionStyling(): void {
  if (_renderQueued || _selectionStyleQueued) return;
  _selectionStyleQueued = true;
  _selectionStyleRAF = _raf(() => {
    _selectionStyleQueued = false;
    _selectionStyleRAF = 0;
    if (!refreshSelectionStyling()) render();
  });
}

// Repaint the current selection state as cheaply as the drawn slice allows:
// a class/attribute patch when it's still valid, a full render otherwise. This
// is what the selection entry points in 09-graph-selection call instead of
// render().
export function renderSelectionChange(): void {
  if (_selectionStyleRAF) { _cancelRaf(_selectionStyleRAF); _selectionStyleRAF = 0; _selectionStyleQueued = false; }
  if (!refreshSelectionStyling()) render();
  // Every path that changes the selection — in this module, in
  // 09-graph-selection, in the canvas handlers — comes through here, which makes
  // it the one place worth telling anything that follows the selection but is
  // not part of drawing it (09-graph-selection's own doc explains why).
  notifySelectionChanged();
}

// The nodes that could fall inside `cull`, in NODES order. Walks the (stream,
// stage) cells rather than every node: a cell's bounds come straight from the
// row/column maps, so whole columns and rows are rejected at once.
function culledNodeCandidates(cull: CullRect): GraphNode[] {
  const cells = layout.cells;
  if (!cells) return NODES;
  const order = nodeOrderIndex();
  const out: GraphNode[] = [];
  for (const stream of STREAMS) {
    if (state.hiddenStreams.has(stream.id)) continue;
    const top = layout.rowY[stream.id];
    if (top === undefined) continue;
    const bottom = top + (layout.rowHeights[stream.id] || 0);
    if (top > cull.maxY || bottom < cull.minY) continue;
    for (const stage of STAGES) {
      if (state.hiddenStages.has(stage.id)) continue;
      const left = layout.colX[stage.id];
      if (left === undefined) continue;
      const right = left + ((layout.colWidths && layout.colWidths[stage.id]) || NODE_WIDTH);
      if (left > cull.maxX || right < cull.minX) continue;
      const cellNodes = cells[stream.id + ":" + stage.id];
      if (cellNodes) for (const n of cellNodes) out.push(n);
    }
  }
  out.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return out;
}

// id → position in NODES, cached per NODES identity (it is reassigned by every
// mutation) so the culled path doesn't pay an O(N) index rebuild per render.
let _nodeOrderIndex: Map<string, number> | null = null;
let _nodeOrderIndexFor: typeof NODES | null = null;
function nodeOrderIndex(): Map<string, number> {
  if (_nodeOrderIndex && _nodeOrderIndexFor === NODES) return _nodeOrderIndex;
  const map = new Map<string, number>();
  for (let i = 0; i < NODES.length; i++) map.set(NODES[i].id, i);
  _nodeOrderIndex = map;
  _nodeOrderIndexFor = NODES;
  return map;
}

// Patch only the value / delta / border of quantified nodes in place, skipping a
// full SVG rebuild. A simulation slider scrub recomputes downstream values every
// frame but changes nothing structural — same nodes, same edges, same positions,
// and (during a drag) the same selection — so on a large map a full render() is
// mostly wasted work.
//
// Returns true if it fully handled the update; false (→ caller falls back to a
// full render) when a delta label needs to appear or disappear, because that is
// a markup change and the structure has to be rebuilt.
//
// A SELECTION no longer forces the fallback. The selected / ancestor / descendant
// borders take precedence over the outcome colour, but those three sets don't
// change while a slider moves, so the same precedence the full render applies
// (11-rendering's node loop) is applied here per node instead.
export function updateSimulationValuesInPlace(): boolean {
  if (!state.dataLoaded) return false;
  const staticLayer = svg.querySelector("." + STATIC_LAYER_CLASS);
  if (!staticLayer) return false;

  // One DOM sweep → id-keyed map (only visible nodes have a group element), and
  // one cached lookup of each group's three patchable children. The WeakMap is
  // keyed by the group element, so a later full render (which replaces every
  // group) drops the stale entries by itself.
  const groups = staticLayer.querySelectorAll(".node-group");
  const patches: NodePatch[] = [];

  // Pass 1: gather each node's freshly-formatted delta ONCE, and bail to a full
  // render if any delta label must appear or disappear.
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    const id = group.getAttribute("data-node-id");
    if (!id) continue;
    const node = nodeById[id];
    if (!node || node.baseline === undefined || node.baseline === null) continue;

    const refs = nodePatchRefs(group);
    const delta = formatNodeDelta(id);
    const needsDelta = !!(delta.text && delta.text !== "—");
    if (needsDelta !== !!refs.delta) return false;
    // A box can be freed or caught by any drag — the gate is only as fixed as
    // the value of whatever is gating it. Its mark is markup, not an attribute,
    // so a change there is handed to the full render exactly as a delta
    // appearing or disappearing is.
    const held = !!(state.simulationMode && !nodeEffect(id, delta).moved && gatedBy(id));
    if (held !== group.classList.contains("sim-held")) return false;
    patches.push({ node: node, group: group, refs: refs, delta: delta });
  }

  // Pass 2: patch value text, delta text + colour, and the border.
  const showOutcomeBorders = !state.selectedNodeId && !state.selectedNodeIds.size;
  for (let i = 0; i < patches.length; i++) {
    const { node, group, refs, delta } = patches[i];

    if (refs.value) refs.value.textContent = formatNodeValue(node.id);

    // The effect fill has to be repainted every frame, not just when this box
    // moved: the ramp is measured against the biggest mover on the map, so one
    // box running away restates the colour of every other one.
    if (state.simulationMode && refs.rect) {
      const effect = nodeEffect(node.id, delta);
      refs.rect.setAttribute("fill",
        effect.moved ? simEffectFill(effect.merit, effect.strength) : SIM_FLAT_FILL);
      group.classList.toggle("sim-flat", !effect.moved);
    }

    if (refs.delta && delta.text && delta.text !== "—") {
      refs.delta.textContent = delta.text;
      refs.delta.setAttribute("fill", deltaColorFor(node, delta));
    }

    if (!refs.rect) continue;
    // Same precedence as the full render: the selection glow wins, then the
    // ancestor / descendant trace, then the good/bad outcome colour (which only
    // shows when nothing at all is selected), then the plain border.
    let strokeColor = "rgba(0,0,0,0.4)";
    let strokeWidth = "1";
    if (state.selectedNodeIds.has(node.id)) {
      strokeColor = "#ffffff";
      strokeWidth = "2.5";
    } else if (state.ancestorSet.has(node.id)) {
      strokeColor = "var(--edge-ancestor)";
      strokeWidth = "2";
    } else if (state.descendantSet.has(node.id)) {
      strokeColor = "var(--edge-descendant)";
      strokeWidth = "2";
    } else if (showOutcomeBorders) {
      // The delta is already computed for this node — hand it over rather than
      // having getOutcomeBorderColor format it a second time.
      const outcome = getOutcomeBorderColor(node.id, delta);
      if (outcome) {
        strokeColor = outcome;
        strokeWidth = "2";
      }
    }
    refs.rect.setAttribute("stroke", strokeColor);
    refs.rect.setAttribute("stroke-width", strokeWidth);
  }
  return true;
}

// The three elements a value patch writes to, resolved once per group element
// instead of on every frame. (querySelector is the expensive part of the patch:
// four of them per node per frame was the bulk of a scrub's DOM cost.)
interface NodePatchRefs {
  value: Element | null;
  delta: Element | null;
  rect: Element | null;
}

interface NodePatch {
  node: GraphNode;
  /** The <g> wrapper — the effect-fill patch toggles `.sim-flat` on it. */
  group: Element;
  refs: NodePatchRefs;
  delta: { text: string; pct: number };
}

const nodePatchRefsByGroup = new WeakMap<Element, NodePatchRefs>();

function nodePatchRefs(group: Element): NodePatchRefs {
  const cached = nodePatchRefsByGroup.get(group);
  if (cached) return cached;
  const refs: NodePatchRefs = {
    value: group.querySelector(".node-value"),
    delta: group.querySelector(".node-delta"),
    rect: group.querySelector(".node-rect"),
  };
  nodePatchRefsByGroup.set(group, refs);
  return refs;
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
