// =============================================================================
// LAYOUT — decide where every node sits on the canvas
// -----------------------------------------------------------------------------
// `computeLayout` runs after a CSV is loaded and again whenever the canvas
// geometry changes (a stream/stage is toggled, a node is added/moved, a drag or
// hover opens a slot). It works out:
//   • each node's GROWN height — tall enough for its wrapped label (grow-to-fit)
//   • the height of each stream row (tall enough to fit its tallest cell stack)
//   • the X position of each column (based on stage order)
//   • the X/Y position of every node (cumulative stacking within its cell)
//   • the overall SVG width/height
//
// Nodes in a cell stack by CUMULATIVE height (not a fixed slot pitch), so boxes
// of different heights sit flush. positions[id] carries { x, y, width, height,
// labelLines } and is the single source of truth the renderer, edge anchoring,
// hit-testing, export, and scroll-into-view all read.
//
// The result is stored in the global `layout` object (see 03-state.js).
// =============================================================================

import type { GraphNode, Layout } from "./types";
import {
  COLLAPSED_COL_WIDTH,
  COLLAPSED_ROW_HEIGHT,
  COL_GAP,
  COL_HEADER_HEIGHT,
  LABEL_INSET,
  LABEL_INSET_RIGHT,
  NODE_GAP_Y,
  NODE_HEIGHT,
  NODE_LINE_STEP,
  NODE_WIDTH,
  nodeWidthForZoom,
  ROW_HEADER_WIDTH,
  ROW_PADDING,
  SVG_PADDING_BOTTOM,
  SVG_PADDING_LEFT,
  SVG_PADDING_RIGHT,
  SVG_PADDING_TOP,
} from "./02-config";
import { getMapTextScale, measureLabelLines } from "./04-utils";
import { NODES, STAGES, STREAMS, layout, state } from "./03-state";

// Node height for a label that wraps to `lineCount` lines. The label block is
// anchored to the box top (first line centred at +16, matching the renderer)
// and each extra line adds NODE_LINE_STEP; a value-bearing node reserves a
// bottom row for its value/delta. Floored at NODE_HEIGHT (the minimum box).
//
// `textScale` (1 at zoom ≥ TEXT_SCALE_RATIO, up to TEXT_SCALE_MAX when zoomed
// out) grows the rendered label/value font via --map-text-scale, so the vertical
// metrics scale with it too — otherwise tall zoomed-out text overruns the box.
export function nodeBoxHeight(lineCount: number, hasValue: boolean, textScale = 1): number {
  const lines = Math.max(1, lineCount);
  const labelBottom = (23 + (lines - 1) * NODE_LINE_STEP) * textScale;   // ~bottom of last label line
  const height = labelBottom + (hasValue ? 35 : 14) * textScale;         // value row, or just bottom padding
  return Math.max(NODE_HEIGHT, height);
}

// Wrap a node's label to the node's inner width and return { lines, height }.
// Value-bearing nodes (those with a baseline) reserve room for the value row.
// The wrap width is divided by the active zoom text-scale so labels break sooner
// by exactly the factor the rendered font is enlarged — then the scaled-up text
// still fits inside the (fixed-width) node box instead of spilling off its edge.
export function measureNode(node: GraphNode): { lines: string[]; height: number } {
  const textScale = getMapTextScale(state.zoomLevel);
  const innerWidth = (NODE_WIDTH - LABEL_INSET - LABEL_INSET_RIGHT) / textScale;
  const lines = measureLabelLines(node.label || node.id || "", innerWidth);
  const hasValue = node.baseline !== undefined;
  return { lines: lines, height: nodeBoxHeight(lines.length, hasValue, textScale) };
}

// Top Y (layout coords) of slot `slotIndex` within a (stream, stage) cell,
// summing the real heights of the nodes above it (NODE_HEIGHT for any empty
// slot beyond the existing nodes). Reads the live `layout`, so it reflects the
// current per-node heights. Used by the renderer (cursor / ghost placeholders)
// and keyboard scroll-into-view to convert an ordinal slot to a pixel offset.
export function slotTopY(streamId: string, stageId: string, slotIndex: number): number | null {
  if (!layout || !layout.rowY || layout.rowY[streamId] === undefined) return null;
  const cellNodes = (layout.cells && layout.cells[streamId + ":" + stageId]) || [];
  let y = layout.rowY[streamId] + ROW_PADDING;
  const slot = Math.max(0, slotIndex | 0);
  for (let i = 0; i < slot; i++) {
    const n = cellNodes[i];
    const h = (n && layout.positions[n.id]) ? layout.positions[n.id].height : NODE_HEIGHT;
    y += h + NODE_GAP_Y;
  }
  return y;
}

// ───── Shared grid-packing geometry ─────────────────────────────────────────
// The cumulative row/column packing and stack summation below is identical for
// the live canvas (computeLayout) and the export's reflowed copy
// (computeExportLayout in 19-export.ts), so it lives here as small primitives
// both call — the SVG padding offsets, the COL_GAP end-correction, and the
// ROW_PADDING floor are then defined in exactly one place and can't drift.

// Summed height of a vertical stack of boxes: the heights plus the NODE_GAP_Y
// gaps between them. Empty stack → 0.
export function stackHeight(heights: number[]): number {
  if (heights.length === 0) return 0;
  let sum = 0;
  for (const h of heights) sum += h;
  return sum + (heights.length - 1) * NODE_GAP_Y;
}

// A stream row's height from its tallest cell's stack: floored so an empty row
// still fits one default box, then padded ROW_PADDING on top and bottom.
export function rowHeightFor(maxCellStack: number): number {
  return (maxCellStack || NODE_HEIGHT) + ROW_PADDING * 2;
}

// Pack columns left→right: ordered stage ids + a width for each → the x of each
// column, each column's width, and the overall SVG width.
export function packColumns(
  stageIds: string[],
  widthOf: (id: string) => number
): { colX: Record<string, number>; colWidths: Record<string, number>; totalWidth: number } {
  const colX: Record<string, number> = {};
  const colWidths: Record<string, number> = {};
  let cursorX = SVG_PADDING_LEFT + ROW_HEADER_WIDTH;
  for (const id of stageIds) {
    const w = widthOf(id);
    colWidths[id] = w;
    colX[id] = cursorX;
    cursorX += w + COL_GAP;
  }
  return { colX, colWidths, totalWidth: cursorX - COL_GAP + SVG_PADDING_RIGHT };
}

// Pack rows top→bottom: ordered stream ids + each row's height → the y of each
// row and the overall SVG height.
export function packRows(
  streamIds: string[],
  rowHeights: Record<string, number>
): { rowY: Record<string, number>; totalHeight: number } {
  const rowY: Record<string, number> = {};
  let cursorY = SVG_PADDING_TOP + COL_HEADER_HEIGHT;
  for (const id of streamIds) { rowY[id] = cursorY; cursorY += rowHeights[id]; }
  return { rowY, totalHeight: cursorY + SVG_PADDING_BOTTOM };
}

// ───── Geometry revision ────────────────────────────────────────────────────
// Consumers that cache geometry-derived work (the renderer's edge re-routing +
// anchor fan) used to key their cache on the layout OBJECT identity. But
// computeLayout() returns a fresh object on every call — and the hot paths call
// it constantly (a node drag recomputes it per mousemove, an inline rename per
// keystroke) while producing byte-identical geometry. Keying on identity meant
// a guaranteed cache miss per frame.
//
// So computeLayout also maintains a REVISION counter that only advances when the
// geometry actually changed: any node's x / y / width / height, the set of
// positioned nodes, or the row/column maps. Callers key their caches on
// layoutGeometryRevision() instead of the object, and a drag that doesn't move
// anything reuses the previous result.
let _geometryRevision = 0;
let _lastGeometry: Layout | null = null;

export function layoutGeometryRevision(): number {
  return _geometryRevision;
}

// Force the next geometry comparison to count as a change. For callers that
// patch `layout.positions` in place (see 16h's per-keystroke rename fast path)
// in a way that DOES move geometry.
export function bumpLayoutGeometryRevision(): void {
  _geometryRevision++;
  _lastGeometry = null;
}

// Shallow numeric-map comparison — same keys, same values.
function sameNumberMap(a: Record<string, number>, b: Record<string, number>): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const k of aKeys) if (a[k] !== b[k]) return false;
  return true;
}

// Does `next` place every node exactly where `prev` did, with the same rows and
// columns? Only geometry is compared — labelLines are presentation, and the
// renderer re-reads them from the live layout every time.
function sameGeometry(prev: Layout, next: Layout): boolean {
  const prevPos = prev.positions, nextPos = next.positions;
  const prevIds = Object.keys(prevPos);
  if (prevIds.length !== Object.keys(nextPos).length) return false;
  for (const id of prevIds) {
    const p = prevPos[id], n = nextPos[id];
    if (!n) return false;
    if (p.x !== n.x || p.y !== n.y || p.width !== n.width || p.height !== n.height) return false;
  }
  return prev.totalWidth === next.totalWidth &&
         prev.totalHeight === next.totalHeight &&
         sameNumberMap(prev.rowY, next.rowY) &&
         sameNumberMap(prev.rowHeights, next.rowHeights) &&
         sameNumberMap(prev.colX, next.colX) &&
         sameNumberMap(prev.colWidths, next.colWidths);
}

export function computeLayout(): Layout {
  const result = computeLayoutGeometry();
  // Advance the revision only when the geometry really moved (see above).
  if (!_lastGeometry || !sameGeometry(_lastGeometry, result)) _geometryRevision++;
  _lastGeometry = result;
  return result;
}

function computeLayoutGeometry(): Layout {
  // ───── Group nodes into (stream, stage) cells ─────────────────────────
  const cells: Record<string, GraphNode[]> = {};
  for (const node of NODES) {
    const key = node.stream + ":" + node.stage;
    if (!cells[key]) cells[key] = [];
    cells[key].push(node);
  }

  // ───── Measure every node once (wrapped label + grown height) ─────────
  // measureLabelLines (04-utils) caches by text, so re-running computeLayout
  // during a drag/hover is cheap.
  const expandedColumnWidth = nodeWidthForZoom(state.zoomLevel);
  const measured: Record<string, { lines: string[]; height: number }> = {};
  for (const node of NODES) measured[node.id] = measureNode(node);
  const heightOf = (id: string): number => (measured[id] ? measured[id].height : NODE_HEIGHT);

  // Transient interaction state that reshapes the layout.
  const hoverCell      = (state.canvasEdit && state.canvasEdit.hoverCell) || null;
  const cursorCell     = (state.canvasEdit && state.canvasEdit.cursorCell) || null;
  const draggingNode   = (state.canvasEdit && state.canvasEdit.draggingNode) || null;
  const dragDropCell   = (draggingNode && draggingNode.dropCell) || null;
  const draggedNodeId  = (draggingNode && draggingNode.nodeId) || null;
  const draggedIdSet: Set<string> | null = draggingNode
    ? new Set((draggingNode.groupIds && draggingNode.groupIds.length) ? draggingNode.groupIds : [draggingNode.nodeId])
    : null;

  // Summed height of a cell's nodes (each node's grown height + the gaps).
  const stackOf = (nodes: GraphNode[]): number => stackHeight(nodes.map(n => heightOf(n.id)));

  // ───── Height of each stream row = its tallest cell's summed stack ────
  // (A cell with two tall multi-line nodes can exceed a cell with more short
  // ones, so we sum heights rather than counting nodes.) Hidden streams get a
  // compact stub. While hovering to add, or dragging a node in, we reserve the
  // extra slot's height so the ghost / drop target has somewhere to land.
  const rowHeights: Record<string, number> = {};
  for (const stream of STREAMS) {
    if (state.hiddenStreams.has(stream.id)) { rowHeights[stream.id] = COLLAPSED_ROW_HEIGHT; continue; }
    let maxContent = 0;
    for (const stage of STAGES) {
      if (state.hiddenStages.has(stage.id)) continue;   // hidden column isn't drawn
      const cellNodes = cells[stream.id + ":" + stage.id] || [];
      const baseStack = stackOf(cellNodes);
      let content = baseStack;

      // A placeholder (the "+ add node" hover ghost OR the keyboard cursor's
      // "type to create" slot) lands a default-height box just below the cell's
      // own stack — reserve room for it so the row grows to contain it rather
      // than letting it overflow into the row below.
      const reserveAfterStack = (cellNodes.length ? baseStack + NODE_GAP_Y : 0) + NODE_HEIGHT;
      if (hoverCell && hoverCell.streamId === stream.id && hoverCell.stageId === stage.id) {
        content = Math.max(content, reserveAfterStack);
      }
      if (cursorCell && cursorCell.streamId === stream.id && cursorCell.stageId === stage.id) {
        content = Math.max(content, reserveAfterStack);
      }
      if (dragDropCell && dragDropCell.streamId === stream.id && dragDropCell.stageId === stage.id) {
        // Reserve the dragged node's own height alongside the kept siblings.
        const kept = cellNodes.filter(n => !(draggedIdSet && draggedIdSet.has(n.id)));
        content = Math.max(content, (kept.length ? stackOf(kept) + NODE_GAP_Y : 0) + heightOf(draggedNodeId!));
      }
      if (content > maxContent) maxContent = content;
    }
    rowHeights[stream.id] = rowHeightFor(maxContent);   // floored so an empty row still fits one box
  }

  // ───── Cumulative Y position for each row ─────────────────────────────
  const { rowY, totalHeight } = packRows(STREAMS.map(s => s.id), rowHeights);

  // ───── X position + width for each column ─────────────────────────────
  const { colX, colWidths, totalWidth } = packColumns(
    STAGES.map(s => s.id),
    id => state.hiddenStages.has(id) ? COLLAPSED_COL_WIDTH : expandedColumnWidth
  );

  // ───── Position every node by cumulative offset within its cell ───────
  const positions: Layout["positions"] = {};
  const setPos = (n: GraphNode, x: number, y: number): void => {
    positions[n.id] = {
      x,
      y,
      width: NODE_WIDTH,
      height: heightOf(n.id),
      labelLines: measured[n.id].lines,
    };
  };

  for (const stream of STREAMS) {
    for (const stage of STAGES) {
      if (state.hiddenStages.has(stage.id)) continue;   // hidden column: no node positions
      const cellNodes = cells[stream.id + ":" + stage.id] || [];
      const cellTopY = rowY[stream.id] + ROW_PADDING;
      const x = colX[stage.id] + Math.max(0, (colWidths[stage.id] - NODE_WIDTH) / 2);

      // Drag target cell: part the kept siblings to open a gap at insertIndex.
      // For a same-cell reorder the dragged ghost(s) rest in the gap; for a
      // cross-cell move the gap is empty space the drop-slot marker fills.
      const isDragTarget = dragDropCell && dragDropCell.streamId === stream.id &&
                           dragDropCell.stageId === stage.id && dragDropCell.insertIndex != null;
      if (isDragTarget) {
        const insertIdx = dragDropCell.insertIndex;
        const kept: GraphNode[] = [], dragged: GraphNode[] = [];
        for (const n of cellNodes) (draggedIdSet && draggedIdSet.has(n.id) ? dragged : kept).push(n);
        const gapHeight = heightOf(draggedNodeId!);
        let y = cellTopY;
        for (let i = 0; i <= kept.length; i++) {
          if (i === insertIdx) {
            if (dragged.length) {
              for (const d of dragged) { setPos(d, x, y); y += heightOf(d.id) + NODE_GAP_Y; }
            } else {
              y += gapHeight + NODE_GAP_Y;     // empty landing gap (cross-cell drag)
            }
          }
          if (i < kept.length) { setPos(kept[i], x, y); y += heightOf(kept[i].id) + NODE_GAP_Y; }
        }
        continue;
      }

      // Normal path, optionally parting the stack for the hover "+ add" ghost:
      // every node at/after the insert slot drops by one default-height slot so
      // the ghost (rendered separately) has an open gap to sit in.
      const gapAt = (hoverCell && hoverCell.streamId === stream.id &&
                     hoverCell.stageId === stage.id && hoverCell.insertIndex != null)
                  ? hoverCell.insertIndex : null;
      let y = cellTopY;
      for (let idx = 0; idx < cellNodes.length; idx++) {
        if (gapAt !== null && idx === gapAt) y += NODE_HEIGHT + NODE_GAP_Y;   // open the ghost gap
        setPos(cellNodes[idx], x, y);
        y += heightOf(cellNodes[idx].id) + NODE_GAP_Y;
      }
    }
  }

  return {
    positions,
    totalWidth,
    totalHeight,
    rowY,
    rowHeights,
    colX,
    colWidths,
    cells,
  };
}
