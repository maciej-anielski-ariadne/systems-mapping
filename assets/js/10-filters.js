// =============================================================================
// VISIBILITY FILTERS — hide / show streams, categories, and stages
// -----------------------------------------------------------------------------
// Three Sets in `state` track what the user has hidden:
//   • state.hiddenStreams    — stream ids the user has toggled off (collapse row)
//   • state.hiddenCategories — category ids the user has toggled off
//   • state.hiddenStages     — stage ids the user has toggled off (collapse col)
//
// When a node belongs to any hidden stream, category, OR stage it is not drawn
// (isNodeVisible). Edges touching a hidden node are re-routed as synthetic
// "through" edges by computeRenderEdges (10a-collapsed-edges.js) rather than
// simply dropped, so causal effects stay legible across collapsed slices.
// =============================================================================

// Hide / show a layout-affecting "dimension" — streams collapse their row,
// stages collapse their column. Flips the id's membership in `hiddenSet`, clears
// the selection when the selected node ends up in the now-hidden slice (so the
// detail panel doesn't point at an invisible node), then recomputes the layout
// and re-renders. `nodeField` is the node property to match the id against
// ("stream" or "stage").
function setDimensionVisibility(hiddenSet, id, nodeField) {
  if (hiddenSet.has(id)) hiddenSet.delete(id);
  else hiddenSet.add(id);

  const selected = state.selectedNodeId && nodeById[state.selectedNodeId];
  if (selected && selected[nodeField] === id && hiddenSet.has(id)) {
    state.selectedNodeId = null;
    state.ancestorSet = new Set();
    state.descendantSet = new Set();
    state.highlightedEdgeIds = new Set();
    renderDetailPanel();
  }
  // Hidden rows/columns change the layout, so recompute before re-rendering.
  layout = computeLayout();
  render();
  renderSidebar();
  saveUiStateToStorage();
}

function toggleStream(streamId) {
  setDimensionVisibility(state.hiddenStreams, streamId, "stream");
}

// Collapse / expand a whole stage (column). Hiding one shrinks its column to a
// thin clickable stub and drops its nodes from the map; causal effects that ran
// THROUGH the hidden nodes are still shown as synthetic "through" edges between
// the visible stages either side — see computeRenderEdges in 10a-collapsed-edges.js.
function toggleStage(stageId) {
  // Don't leave the keyboard "type to create" cursor parked in a column that's
  // about to collapse (it's still visible now, so this toggle will hide it).
  if (state.canvasEdit && state.canvasEdit.cursorCell &&
      state.canvasEdit.cursorCell.stageId === stageId &&
      !state.hiddenStages.has(stageId)) {
    state.canvasEdit.cursorCell = null;
  }
  setDimensionVisibility(state.hiddenStages, stageId, "stage");
}

// Categories don't affect layout and don't clear the selection, so they keep
// their own minimal toggle.
function toggleCategory(categoryId) {
  if (state.hiddenCategories.has(categoryId)) state.hiddenCategories.delete(categoryId);
  else state.hiddenCategories.add(categoryId);
  render();
  renderSidebar();
  saveUiStateToStorage();
}

// A node is visible only if its stream, its category, AND its stage are all
// visible.
function isNodeVisible(node) {
  if (state.hiddenStreams.has(node.stream)) return false;
  if (state.hiddenStages.has(node.stage)) return false;
  // Hidden if ANY category the node carries (primary or secondary) is hidden.
  const cats = (node.categoryIds && node.categoryIds.length) ? node.categoryIds : [node.category];
  for (const c of cats) if (state.hiddenCategories.has(c)) return false;
  return true;
}
