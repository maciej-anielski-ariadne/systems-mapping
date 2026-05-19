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

// A node is visible only if both its stream and its category are visible.
function isNodeVisible(node) {
  if (state.hiddenStreams.has(node.stream)) return false;
  if (state.hiddenCategories.has(node.category)) return false;
  return true;
}
