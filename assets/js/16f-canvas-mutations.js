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
//   • focusSidebarEditLabel — small helper that focuses the freshly-opened
//                             label input after renderSidebar repaints.
//
// Edge / node mutations (createNodeInCell, commitNewEdge, deleteSelection,
// deleteEdgeById) live in 16e-canvas-edit.js because they belong with the
// canvas gestures that drive them.
//
// Undo bookkeeping (pushUndo, restoreFromUndo, showUndoToast) lives in
// 16g-canvas-undo.js so the snapshot-rehydration logic doesn't compete for
// space with the mutation entry points.
// =============================================================================

// ───── Mutation chokepoint ────────────────────────────────────────────────
// Every canvas edit ends here. Re-runs the pipeline that data-loader.js runs
// after parsing a CSV, then persists the new live state to localStorage.
//
// `options.skipDetailRender` — true when the mutation came from a text /
// number input in the detail panel. Re-rendering the panel would destroy
// the input element and break focus / tabbing.
// `options.skipSidebarRender` — same idea for the sidebar (preserves focus
// while the user is typing in the expanded stream / stage edit row).
function applyCanvasMutation(options) {
  rebuildIndexes();
  layout = computeLayout();
  recomputeValues();
  if (!options || !options.skipSidebarRender) renderSidebar();
  render();
  if (!options || !options.skipDetailRender) renderDetailPanel();
  try {
    saveCsvToStorage(serializeLiveStateToCsv());
  } catch (err) {
    console.warn("Persisting canvas mutation failed:", err);
  }
}

// ───── Add stream / stage / category ──────────────────────────────────────
function addStream() {
  const counter = STREAMS.length + 1;
  let id = "row_" + counter;
  // Avoid id collision if user renamed previous ones to numbers.
  let n = counter;
  while (streamById[id]) { n++; id = "row_" + n; }
  const color = STREAM_COLOR_PALETTE[STREAMS.length % STREAM_COLOR_PALETTE.length];
  const label = "Stream " + counter;
  STREAMS.push({ id: id, label: label, short: deriveShortLabel(label), color: color });
  // Open the new row's pencil-expanded edit view in the sidebar so the user
  // can immediately rename / re-colour it.
  state.canvasEdit.editingSidebarItem = { kind: "stream", id: id };
  applyCanvasMutation();
  focusSidebarEditLabel("stream", id);
}

function addStage() {
  const counter = STAGES.length + 1;
  let id = "stage_" + counter;
  let n = counter;
  while (stageById[id]) { n++; id = "stage_" + n; }
  STAGES.push({ id: id, label: "Stage " + counter });
  state.canvasEdit.editingSidebarItem = { kind: "stage", id: id };
  applyCanvasMutation();
  focusSidebarEditLabel("stage", id);
}

// Categories are stored in a plain object — Object.keys() preserves insertion
// order, so reordering means rebuilding the object in the new order.
function addCategory() {
  const counter = Object.keys(CATEGORIES).length + 1;
  let id = "category_" + counter;
  let n = counter;
  while (CATEGORIES[id]) { n++; id = "category_" + n; }
  const color = STREAM_COLOR_PALETTE[Object.keys(CATEGORIES).length % STREAM_COLOR_PALETTE.length];
  CATEGORIES[id] = {
    label: "Category " + counter,
    color: color,
    textColor: "#ffffff",
  };
  state.canvasEdit.editingSidebarItem = { kind: "category", id: id };
  applyCanvasMutation();
  focusSidebarEditLabel("category", id);
}

// ───── Delete with cascade + undo ─────────────────────────────────────────
// All three follow the same shape: warn the user, snapshot the affected rows
// + nodes + edges into an undo entry, splice them out, then surface a 6-second
// "Undo" toast.
function deleteStreamWithCascade(streamId) {
  const stream = streamById[streamId];
  if (!stream) return;
  const nodesToDelete = NODES.filter(n => n.stream === streamId);
  const nodeIdSet = new Set(nodesToDelete.map(n => n.id));
  const edgesToDelete = EDGES.filter(e => nodeIdSet.has(e.from) || nodeIdSet.has(e.to));
  const msg = nodesToDelete.length === 0
    ? 'Delete stream "' + stream.label + '"?'
    : 'Delete stream "' + stream.label + '"?\n\n' + nodesToDelete.length + ' node(s) and ' + edgesToDelete.length + ' edge(s) will also be removed.';
  if (!confirm(msg)) return;

  const snapshot = {
    kind: "stream",
    stream: Object.assign({}, stream),
    streamIndex: STREAMS.findIndex(s => s.id === streamId),
    nodes: nodesToDelete.map(cloneNodeForUndo),
    edges: edgesToDelete.map(cloneEdgeForUndo),
  };
  STREAMS = STREAMS.filter(s => s.id !== streamId);
  NODES = NODES.filter(n => !nodeIdSet.has(n.id));
  EDGES = EDGES.filter(e => !nodeIdSet.has(e.from) && !nodeIdSet.has(e.to));
  if (state.selectedNodeId && nodeIdSet.has(state.selectedNodeId)) {
    state.selectedNodeId = null;
    state.ancestorSet = new Set();
    state.descendantSet = new Set();
    state.highlightedEdgeIds = new Set();
  }
  state.canvasEdit.editingSidebarItem = null;
  pushUndo(snapshot);
  applyCanvasMutation();
  showUndoToast("Stream deleted", () => restoreFromUndo(snapshot));
}

function deleteStageWithCascade(stageId) {
  const stage = stageById[stageId];
  if (!stage) return;
  const nodesToDelete = NODES.filter(n => n.stage === stageId);
  const nodeIdSet = new Set(nodesToDelete.map(n => n.id));
  const edgesToDelete = EDGES.filter(e => nodeIdSet.has(e.from) || nodeIdSet.has(e.to));
  const msg = nodesToDelete.length === 0
    ? 'Delete stage "' + stage.label + '"?'
    : 'Delete stage "' + stage.label + '"?\n\n' + nodesToDelete.length + ' node(s) and ' + edgesToDelete.length + ' edge(s) will also be removed.';
  if (!confirm(msg)) return;

  const snapshot = {
    kind: "stage",
    stage: { id: stage.id, label: stage.label },
    stageIndex: STAGES.findIndex(s => s.id === stageId),
    nodes: nodesToDelete.map(cloneNodeForUndo),
    edges: edgesToDelete.map(cloneEdgeForUndo),
  };
  STAGES = STAGES.filter(s => s.id !== stageId);
  NODES = NODES.filter(n => !nodeIdSet.has(n.id));
  EDGES = EDGES.filter(e => !nodeIdSet.has(e.from) && !nodeIdSet.has(e.to));
  if (state.selectedNodeId && nodeIdSet.has(state.selectedNodeId)) {
    state.selectedNodeId = null;
    state.ancestorSet = new Set();
    state.descendantSet = new Set();
    state.highlightedEdgeIds = new Set();
  }
  state.canvasEdit.editingSidebarItem = null;
  pushUndo(snapshot);
  applyCanvasMutation();
  showUndoToast("Stage deleted", () => restoreFromUndo(snapshot));
}

function deleteCategoryWithCascade(catId) {
  const cat = CATEGORIES[catId];
  if (!cat) return;
  const nodesToDelete = NODES.filter(n => n.category === catId);
  const nodeIdSet = new Set(nodesToDelete.map(n => n.id));
  const edgesToDelete = EDGES.filter(e => nodeIdSet.has(e.from) || nodeIdSet.has(e.to));
  const msg = nodesToDelete.length === 0
    ? 'Delete category "' + cat.label + '"?'
    : 'Delete category "' + cat.label + '"?\n\n' + nodesToDelete.length + ' node(s) and ' + edgesToDelete.length + ' edge(s) will also be removed.';
  if (!confirm(msg)) return;

  const ids = Object.keys(CATEGORIES);
  const snapshot = {
    kind: "category",
    catId: catId,
    cat: Object.assign({}, cat),
    catIndex: ids.indexOf(catId),
    nodes: nodesToDelete.map(cloneNodeForUndo),
    edges: edgesToDelete.map(cloneEdgeForUndo),
  };
  delete CATEGORIES[catId];
  NODES = NODES.filter(n => !nodeIdSet.has(n.id));
  EDGES = EDGES.filter(e => !nodeIdSet.has(e.from) && !nodeIdSet.has(e.to));
  state.hiddenCategories.delete(catId);
  if (state.selectedNodeId && nodeIdSet.has(state.selectedNodeId)) {
    state.selectedNodeId = null;
    state.ancestorSet = new Set();
    state.descendantSet = new Set();
    state.highlightedEdgeIds = new Set();
  }
  state.canvasEdit.editingSidebarItem = null;
  pushUndo(snapshot);
  applyCanvasMutation();
  showUndoToast("Category deleted", () => restoreFromUndo(snapshot));
}

// ───── Reorder (drag-to-reorder from the sidebar) ─────────────────────────
// Move STREAMS[fromIndex] (or STAGES, or CATEGORIES key order) to a position
// inserted before targetIndex. Called by the sidebar's HTML5 DnD wiring.
function reorderStreams(fromIndex, targetIndex) {
  if (fromIndex === targetIndex || fromIndex === targetIndex - 1) return;
  const item = STREAMS[fromIndex];
  if (!item) return;
  STREAMS.splice(fromIndex, 1);
  const insertAt = targetIndex > fromIndex ? targetIndex - 1 : targetIndex;
  STREAMS.splice(insertAt, 0, item);
  applyCanvasMutation();
}

function reorderStages(fromIndex, targetIndex) {
  if (fromIndex === targetIndex || fromIndex === targetIndex - 1) return;
  const item = STAGES[fromIndex];
  if (!item) return;
  STAGES.splice(fromIndex, 1);
  const insertAt = targetIndex > fromIndex ? targetIndex - 1 : targetIndex;
  STAGES.splice(insertAt, 0, item);
  applyCanvasMutation();
}

function reorderCategories(fromIndex, targetIndex) {
  if (fromIndex === targetIndex || fromIndex === targetIndex - 1) return;
  const ids = Object.keys(CATEGORIES);
  if (fromIndex < 0 || fromIndex >= ids.length) return;
  const movedId = ids[fromIndex];
  ids.splice(fromIndex, 1);
  const insertAt = targetIndex > fromIndex ? targetIndex - 1 : targetIndex;
  ids.splice(insertAt, 0, movedId);
  const reordered = {};
  for (const id of ids) reordered[id] = CATEGORIES[id];
  CATEGORIES = reordered;
  applyCanvasMutation();
}

// After renderSidebar repaints, focus the freshly-opened label input so the
// user can start typing the new stream / stage / category name immediately.
function focusSidebarEditLabel(kind, id) {
  setTimeout(() => {
    const input = document.querySelector(".sidebar-edit-row.expanded[data-kind='" + kind + "'][data-id='" + id + "'] [data-field='label']");
    if (input && typeof input.focus === "function") {
      input.focus();
      if (typeof input.select === "function") input.select();
    }
  }, 0);
}
