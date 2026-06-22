// =============================================================================
// CANVAS MUTATIONS — add / delete / reorder for streams, stages, categories
// -----------------------------------------------------------------------------
// Every change to STREAMS / STAGES / CATEGORIES that originates from the
// sidebar UI lives here:
//
//   • applyCanvasMutation() — the single chokepoint every mutation funnels
//                             through. Rebuilds indexes / layout / values,
//                             re-renders, and persists the new state.
//   • addStream / addStage / addCategory — push a freshly-shaped row.
//   • deleteStreamWithCascade / Stage / Category — confirm dialog, snapshot
//                             for undo, splice out, show the undo toast.
//   • reorderStreams / Stages / Categories — drag-to-reorder hooked up from
//                             the sidebar's HTML5 DnD wiring (13-sidebar.js).
//
// Edge / node mutations (createNodeInCell, commitNewEdge, deleteSelection,
// deleteEdgeById) live in 16e-canvas-edit.js because they belong with the
// canvas gestures that drive them.
//
// Undo bookkeeping (pushUndo, restoreFromUndo, showUndoToast) lives in
// 16g-canvas-undo.js so the snapshot-rehydration logic doesn't compete for
// space with the mutation entry points.
// =============================================================================

import type { GraphNode, Edge, Stream, CategoryMap } from "./types";
import {
  state,
  STREAMS,
  STAGES,
  CATEGORIES,
  NODES,
  EDGES,
  streamById,
  stageById,
  setStreams,
  setStages,
  setCategories,
  setNodes,
  setEdges,
  setLayout,
} from "./03-state";
import { HISTORY_CAP, isUndoCaptureSuspended, pushUndo, restoreFromUndo, showUndoToast } from "./16g-canvas-undo";
import { rebuildIndexes } from "./06-data-loader";
import { computeLayout } from "./08-layout";
import { recomputeValues } from "./07-simulation-engine";
import { renderSidebar, focusSidebarInlineLabel } from "./13-sidebar";
import { render } from "./11-rendering";
import { renderDetailPanel } from "./15-detail-panel";
import { renderMultiSelectBar } from "./16j-multi-select-bar";
import { serializeLiveStateToCsv } from "./05a-csv-serializer";
import { saveCsvToStorage } from "./04a-storage";
import { STREAM_COLOR_PALETTE } from "./02-config";
import { deriveShortLabel } from "./16e-canvas-edit";
import { pickTextColor, cloneNodeForUndo, cloneEdgeForUndo } from "./04-utils";

// ───── Mutation chokepoint ────────────────────────────────────────────────
// Every canvas edit ends here. Re-runs the pipeline that data-loader.js runs
// after parsing a CSV, then persists the new live state to localStorage.
//
// `options.skipDetailRender` — true when the mutation came from a text /
// number input in the detail panel. Re-rendering the panel would destroy
// the input element and break focus / tabbing.
// `options.skipSidebarRender` — same idea for the sidebar (preserves an
// in-progress inline edit / colour pick instead of tearing down the row).
export function applyCanvasMutation(options?: { skipDetailRender?: boolean; skipSidebarRender?: boolean }): void {
  // Push the PREVIOUS state's CSV onto undo history before mutating. The
  // "previous" snapshot is whatever applyCanvasMutation produced last time
  // (or what loadDataFromCsv seeded). This makes every mutation undoable
  // without each call-site having to opt in.
  if (state.dataLoaded && !isUndoCaptureSuspended() && state.lastCsvSnapshot) {
    state.history.past.push(state.lastCsvSnapshot);
    if (state.history.past.length > HISTORY_CAP) state.history.past.shift();
    state.history.future.length = 0;
  }

  rebuildIndexes();
  setLayout(computeLayout());
  recomputeValues();
  if (!options || !options.skipSidebarRender) renderSidebar();
  render();
  if (!options || !options.skipDetailRender) renderDetailPanel();
  // Keep the multi-select action bar's count / dropdowns in sync after any
  // mutation (batch edit/move/delete and undo round-trips), and hide it when a
  // batch delete empties the selection.
  if (typeof renderMultiSelectBar === "function") renderMultiSelectBar();
  try {
    const afterCsv = serializeLiveStateToCsv();
    state.lastCsvSnapshot = afterCsv;
    saveCsvToStorage(afterCsv);
  } catch (err) {
    console.warn("Persisting canvas mutation failed:", err);
  }
}

// ───── Add stream / stage / category ──────────────────────────────────────
export function addStream(): void {
  const counter = STREAMS.length + 1;
  let id = "row_" + counter;
  // Avoid id collision if user renamed previous ones to numbers.
  let n = counter;
  while (streamById[id]) { n++; id = "row_" + n; }
  const color = STREAM_COLOR_PALETTE[STREAMS.length % STREAM_COLOR_PALETTE.length];
  const label = "Row " + counter;
  STREAMS.push({ id: id, label: label, short: deriveShortLabel(label), color: color });
  applyCanvasMutation();
  // Drop straight into renaming the new row inline.
  if (typeof focusSidebarInlineLabel === "function") focusSidebarInlineLabel("stream", id);
}

export function addStage(): void {
  const counter = STAGES.length + 1;
  let id = "stage_" + counter;
  let n = counter;
  while (stageById[id]) { n++; id = "stage_" + n; }
  STAGES.push({ id: id, label: "Column " + counter });
  applyCanvasMutation();
  if (typeof focusSidebarInlineLabel === "function") focusSidebarInlineLabel("stage", id);
}

// Categories are stored in a plain object — Object.keys() preserves insertion
// order, so reordering means rebuilding the object in the new order.
export function addCategory(catClass?: string | null): void {
  const counter = Object.keys(CATEGORIES).length + 1;
  let id = "category_" + counter;
  let n = counter;
  while (CATEGORIES[id]) { n++; id = "category_" + n; }
  const color = STREAM_COLOR_PALETTE[Object.keys(CATEGORIES).length % STREAM_COLOR_PALETTE.length];
  CATEGORIES[id] = {
    label: "Category " + counter,
    color: color,
    // Label colour auto-contrasts against the fill — see pickTextColor (04-utils.js).
    textColor: typeof pickTextColor === "function" ? pickTextColor(color) : "#ffffff",
    class: catClass === "secondary" ? "secondary" : "primary",
  };
  applyCanvasMutation();
  // Categories edit fully inline now — drop straight into renaming the new row.
  if (typeof focusSidebarInlineLabel === "function") focusSidebarInlineLabel("category", id);
}

// ───── Delete with cascade + undo ─────────────────────────────────────────
// All three follow the same shape: warn the user, snapshot the affected rows
// + nodes + edges into an undo entry, splice them out, then surface a 6-second
// "Undo" toast.
export function deleteStreamWithCascade(streamId: string): void {
  const stream = streamById[streamId];
  if (!stream) return;
  const nodesToDelete = NODES.filter((n: GraphNode) => n.stream === streamId);
  const nodeIdSet = new Set(nodesToDelete.map((n: GraphNode) => n.id));
  const edgesToDelete = EDGES.filter((e: Edge) => nodeIdSet.has(e.from) || nodeIdSet.has(e.to));
  const msg = nodesToDelete.length === 0
    ? 'Delete row "' + stream.label + '"?'
    : 'Delete row "' + stream.label + '"?\n\n' + nodesToDelete.length + ' box(es) and ' + edgesToDelete.length + ' link(s) will also be removed.';
  if (!confirm(msg)) return;

  const snapshot = {
    kind: "stream",
    stream: Object.assign({}, stream),
    streamIndex: STREAMS.findIndex((s: Stream) => s.id === streamId),
    nodes: nodesToDelete.map(cloneNodeForUndo),
    edges: edgesToDelete.map(cloneEdgeForUndo),
  };
  setStreams(STREAMS.filter((s: Stream) => s.id !== streamId));
  setNodes(NODES.filter((n: GraphNode) => !nodeIdSet.has(n.id)));
  setEdges(EDGES.filter((e: Edge) => !nodeIdSet.has(e.from) && !nodeIdSet.has(e.to)));
  if (state.selectedNodeId && nodeIdSet.has(state.selectedNodeId)) {
    state.selectedNodeId = null;
    state.ancestorSet = new Set();
    state.descendantSet = new Set();
    state.highlightedEdgeIds = new Set();
  }
  pushUndo(snapshot);
  applyCanvasMutation();
  showUndoToast("Row deleted", () => restoreFromUndo(snapshot));
}

export function deleteStageWithCascade(stageId: string): void {
  const stage = stageById[stageId];
  if (!stage) return;
  const nodesToDelete = NODES.filter((n: GraphNode) => n.stage === stageId);
  const nodeIdSet = new Set(nodesToDelete.map((n: GraphNode) => n.id));
  const edgesToDelete = EDGES.filter((e: Edge) => nodeIdSet.has(e.from) || nodeIdSet.has(e.to));
  const msg = nodesToDelete.length === 0
    ? 'Delete column "' + stage.label + '"?'
    : 'Delete column "' + stage.label + '"?\n\n' + nodesToDelete.length + ' box(es) and ' + edgesToDelete.length + ' link(s) will also be removed.';
  if (!confirm(msg)) return;

  const snapshot = {
    kind: "stage",
    stage: { id: stage.id, label: stage.label },
    stageIndex: STAGES.findIndex((s) => s.id === stageId),
    nodes: nodesToDelete.map(cloneNodeForUndo),
    edges: edgesToDelete.map(cloneEdgeForUndo),
  };
  setStages(STAGES.filter((s) => s.id !== stageId));
  state.hiddenStages.delete(stageId);   // don't leave a stale hidden-stage entry
  setNodes(NODES.filter((n: GraphNode) => !nodeIdSet.has(n.id)));
  setEdges(EDGES.filter((e: Edge) => !nodeIdSet.has(e.from) && !nodeIdSet.has(e.to)));
  if (state.selectedNodeId && nodeIdSet.has(state.selectedNodeId)) {
    state.selectedNodeId = null;
    state.ancestorSet = new Set();
    state.descendantSet = new Set();
    state.highlightedEdgeIds = new Set();
  }
  pushUndo(snapshot);
  applyCanvasMutation();
  showUndoToast("Column deleted", () => restoreFromUndo(snapshot));
}

export function deleteCategoryWithCascade(catId: string): void {
  const cat = CATEGORIES[catId];
  if (!cat) return;
  const catsOf = (n: GraphNode): string[] => (n.categoryIds && n.categoryIds.length) ? n.categoryIds : [n.category];
  const usingNodes = NODES.filter((n: GraphNode) => catsOf(n).indexOf(catId) >= 0);
  // A node is removed only if this is its ONLY category; multi-category nodes
  // are just untagged (the category stripped from their lists).
  const soleNodes = usingNodes.filter((n: GraphNode) => catsOf(n).length <= 1);
  const untagCount = usingNodes.length - soleNodes.length;
  const nodeIdSet = new Set(soleNodes.map((n: GraphNode) => n.id));
  const edgesToDelete = EDGES.filter((e: Edge) => nodeIdSet.has(e.from) || nodeIdSet.has(e.to));

  let msg = 'Delete category "' + cat.label + '"?';
  const parts: string[] = [];
  if (soleNodes.length)  parts.push(soleNodes.length + ' box(es) using only this category (and ' + edgesToDelete.length + ' link(s)) will be removed');
  if (untagCount)        parts.push(untagCount + ' box(es) will be untagged');
  if (parts.length)      msg += '\n\n' + parts.join(';\n') + '.';
  if (!confirm(msg)) return;

  // Untag from the multi-category survivors.
  for (const n of usingNodes) {
    if (nodeIdSet.has(n.id)) continue;
    if (n.categoryIds)         n.categoryIds         = n.categoryIds.filter((id) => id !== catId);
    if (n.primaryCategories)   n.primaryCategories   = n.primaryCategories.filter((id) => id !== catId);
    if (n.secondaryCategories) n.secondaryCategories = n.secondaryCategories.filter((id) => id !== catId);
    n.category = (n.primaryCategories && n.primaryCategories[0]) || (n.categoryIds && n.categoryIds[0]) || n.category;
  }
  delete CATEGORIES[catId];
  setNodes(NODES.filter((n: GraphNode) => !nodeIdSet.has(n.id)));
  setEdges(EDGES.filter((e: Edge) => !nodeIdSet.has(e.from) && !nodeIdSet.has(e.to)));
  state.hiddenCategories.delete(catId);
  if (state.selectedNodeId && nodeIdSet.has(state.selectedNodeId)) {
    state.selectedNodeId = null;
    state.ancestorSet = new Set();
    state.descendantSet = new Set();
    state.highlightedEdgeIds = new Set();
  }
  applyCanvasMutation();
  showUndoToast("Category deleted", () => restoreFromUndo(null));
}

// ───── Reorder (drag-to-reorder from the sidebar) ─────────────────────────
// Move STREAMS[fromIndex] (or STAGES, or CATEGORIES key order) to a position
// inserted before targetIndex. Called by the sidebar's HTML5 DnD wiring.
export function reorderStreams(fromIndex: number, targetIndex: number): void {
  if (fromIndex === targetIndex || fromIndex === targetIndex - 1) return;
  const item = STREAMS[fromIndex];
  if (!item) return;
  STREAMS.splice(fromIndex, 1);
  const insertAt = targetIndex > fromIndex ? targetIndex - 1 : targetIndex;
  STREAMS.splice(insertAt, 0, item);
  applyCanvasMutation();
}

export function reorderStages(fromIndex: number, targetIndex: number): void {
  if (fromIndex === targetIndex || fromIndex === targetIndex - 1) return;
  const item = STAGES[fromIndex];
  if (!item) return;
  STAGES.splice(fromIndex, 1);
  const insertAt = targetIndex > fromIndex ? targetIndex - 1 : targetIndex;
  STAGES.splice(insertAt, 0, item);
  applyCanvasMutation();
}

export function reorderCategories(fromIndex: number, targetIndex: number): void {
  if (fromIndex === targetIndex || fromIndex === targetIndex - 1) return;
  const ids = Object.keys(CATEGORIES);
  if (fromIndex < 0 || fromIndex >= ids.length) return;
  const movedId = ids[fromIndex];
  ids.splice(fromIndex, 1);
  const insertAt = targetIndex > fromIndex ? targetIndex - 1 : targetIndex;
  ids.splice(insertAt, 0, movedId);
  const reordered: CategoryMap = {};
  for (const id of ids) reordered[id] = CATEGORIES[id];
  setCategories(reordered);
  applyCanvasMutation();
}
