// =============================================================================
// VISIBILITY FILTERS — hide / show streams and categories
// -----------------------------------------------------------------------------
// Two Sets in `state` track what the user has hidden:
//   • state.hiddenStreams    — stream ids the user has toggled off
//   • state.hiddenCategories — category ids the user has toggled off
//
// When a node belongs to either a hidden stream OR a hidden category, it is
// not drawn on the map (and any edges touching it are also skipped).
// =============================================================================

function toggleStream(streamId) {
  if (state.hiddenStreams.has(streamId)) state.hiddenStreams.delete(streamId);
  else state.hiddenStreams.add(streamId);

  // If the currently-selected node belonged to a stream we just hid, clear
  // the selection so the detail panel doesn't show an invisible node.
  if (
    state.selectedNodeId &&
    nodeById[state.selectedNodeId].stream === streamId &&
    state.hiddenStreams.has(streamId)
  ) {
    state.selectedNodeId = null;
    state.ancestorSet = new Set();
    state.descendantSet = new Set();
    state.highlightedEdgeIds = new Set();
    renderDetailPanel();
  }
  // Layout depends on stream visibility (hidden streams collapse to a
  // compact row), so recompute before re-rendering.
  layout = computeLayout();
  render();
  renderSidebar();
  saveUiStateToStorage();
}

function toggleCategory(categoryId) {
  if (state.hiddenCategories.has(categoryId)) state.hiddenCategories.delete(categoryId);
  else state.hiddenCategories.add(categoryId);
  render();
  renderSidebar();
  saveUiStateToStorage();
}

// Collapse / expand a whole stage (column). Like toggleStream, but stages are
// columns: hiding one shrinks its column to a thin clickable stub and drops its
// nodes from the map. Causal effects that ran THROUGH the hidden nodes are still
// shown as synthetic "through" edges between the visible stages either side —
// see computeRenderEdges in 10a-collapsed-edges.js.
function toggleStage(stageId) {
  if (state.hiddenStages.has(stageId)) state.hiddenStages.delete(stageId);
  else state.hiddenStages.add(stageId);

  // If the selected node lived in a stage we just hid, clear the selection so
  // the detail panel doesn't point at an invisible node.
  if (
    state.selectedNodeId &&
    nodeById[state.selectedNodeId] &&
    nodeById[state.selectedNodeId].stage === stageId &&
    state.hiddenStages.has(stageId)
  ) {
    state.selectedNodeId = null;
    state.ancestorSet = new Set();
    state.descendantSet = new Set();
    state.highlightedEdgeIds = new Set();
    renderDetailPanel();
  }
  // Don't leave the keyboard "type to create" cursor parked inside a column
  // that's now collapsed.
  if (state.canvasEdit && state.canvasEdit.cursorCell &&
      state.canvasEdit.cursorCell.stageId === stageId &&
      state.hiddenStages.has(stageId)) {
    state.canvasEdit.cursorCell = null;
  }
  // Hidden stages collapse their column to a narrow stub, so recompute layout
  // (column widths change) before re-rendering.
  layout = computeLayout();
  render();
  renderSidebar();
  saveUiStateToStorage();
}

// A node is visible only if its stream, its category, AND its stage are all
// visible.
function isNodeVisible(node) {
  if (state.hiddenStreams.has(node.stream)) return false;
  if (state.hiddenCategories.has(node.category)) return false;
  if (state.hiddenStages.has(node.stage)) return false;
  return true;
}
