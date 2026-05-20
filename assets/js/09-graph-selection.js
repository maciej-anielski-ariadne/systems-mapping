// =============================================================================
// GRAPH TRAVERSAL + SELECTION
// -----------------------------------------------------------------------------
// When the user clicks a node we need to know:
//   • Every node UPSTREAM   (an "ancestor"   — feeds into the selected node)
//   • Every node DOWNSTREAM (a "descendant" — is affected by the selected node)
//   • Every edge that connects nodes within the ancestor or descendant set
//
// This file contains the BFS traversal helpers plus the small selectNode /
// deselectNode functions that update state and trigger a re-render.
// =============================================================================

// NOTE: `incomingEdges[id]` and `outgoingEdges[id]` are guaranteed to be
// initialized to [] for every node by rebuildIndexes (06-data-loader.js),
// so we don't need defensive `|| []` fallbacks when reading them.

// Breadth-first walk backwards along incoming edges, collecting every
// reachable node into a Set.
function getAncestors(nodeId) {
  const visited = new Set();
  const queue = [nodeId];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const edge of incomingEdges[current]) {
      if (!visited.has(edge.from)) {
        visited.add(edge.from);
        queue.push(edge.from);
      }
    }
  }
  return visited;
}

// Breadth-first walk forwards along outgoing edges.
function getDescendants(nodeId) {
  const visited = new Set();
  const queue = [nodeId];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const edge of outgoingEdges[current]) {
      if (!visited.has(edge.to)) {
        visited.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  return visited;
}

// Decide which edges should be highlighted given a selected node. An edge is
// highlighted if BOTH its endpoints are in the upstream chain OR both are in
// the downstream chain (including the selected node itself).
function computeHighlightedEdges(nodeId) {
  const edges = new Set();
  const ancestors   = state.ancestorSet;
  const descendants = state.descendantSet;

  for (const edge of EDGES) {
    const fromInAncestors = ancestors.has(edge.from) || edge.from === nodeId;
    const toInAncestors   = ancestors.has(edge.to)   || edge.to   === nodeId;
    if (fromInAncestors && toInAncestors) edges.add(edge.id);

    const fromInDescendants = descendants.has(edge.from) || edge.from === nodeId;
    const toInDescendants   = descendants.has(edge.to)   || edge.to   === nodeId;
    if (fromInDescendants && toInDescendants) edges.add(edge.id);
  }
  return edges;
}

// ───── Select / deselect ──────────────────────────────────────────────────

// Toggle behaviour: clicking the already-selected node deselects it.
function selectNode(nodeId) {
  if (state.selectedNodeId === nodeId) {
    deselectNode();
    return;
  }
  // Selecting a node clears any edge selection — the two are mutually exclusive.
  if (state.canvasEdit) state.canvasEdit.selectedEdgeId = null;
  state.selectedNodeId = nodeId;
  state.ancestorSet = getAncestors(nodeId);
  state.descendantSet = getDescendants(nodeId);
  state.highlightedEdgeIds = computeHighlightedEdges(nodeId);
  render();
  renderDetailPanel();
  saveUiStateToStorage();
}

function deselectNode() {
  state.selectedNodeId = null;
  state.ancestorSet = new Set();
  state.descendantSet = new Set();
  state.highlightedEdgeIds = new Set();
  render();
  renderDetailPanel();
  saveUiStateToStorage();
}

// Select an edge (mutually exclusive with selectedNodeId). Used by the
// canvas direct-edit path so the detail panel can show / edit edge fields.
function selectEdge(edgeId) {
  if (!state.canvasEdit) return;
  if (state.canvasEdit.selectedEdgeId === edgeId) {
    deselectAll();
    return;
  }
  state.selectedNodeId = null;
  state.ancestorSet = new Set();
  state.descendantSet = new Set();
  state.highlightedEdgeIds = new Set();
  state.canvasEdit.selectedEdgeId = edgeId;
  render();
  renderDetailPanel();
}

// Clears both node and edge selection. The empty-SVG click handler calls this.
function deselectAll() {
  state.selectedNodeId = null;
  state.ancestorSet = new Set();
  state.descendantSet = new Set();
  state.highlightedEdgeIds = new Set();
  if (state.canvasEdit) state.canvasEdit.selectedEdgeId = null;
  render();
  renderDetailPanel();
  saveUiStateToStorage();
}

// Smoothly scroll the visualization so the given node is centred on screen.
function scrollNodeIntoView(nodeId) {
  const pos = layout.positions[nodeId];
  if (!pos) return;
  const container = document.getElementById("viz-scroll");
  if (!container) return;
  const targetX = pos.x + pos.width / 2 - container.clientWidth / 2;
  const targetY = pos.y + pos.height / 2 - container.clientHeight / 2;
  container.scrollTo({ left: targetX, top: targetY, behavior: "smooth" });
}
