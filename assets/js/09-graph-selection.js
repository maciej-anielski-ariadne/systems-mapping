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
  state.selectedNodeId = nodeId;
  state.selectedEdgeId = null;   // node and edge selection are mutually exclusive
  state.ancestorSet = getAncestors(nodeId);
  state.descendantSet = getDescendants(nodeId);
  state.highlightedEdgeIds = computeHighlightedEdges(nodeId);
  render();
  renderDetailPanel();
  saveUiStateToStorage();
}

function deselectNode() {
  state.selectedNodeId = null;
  state.selectedEdgeId = null;
  state.ancestorSet = new Set();
  state.descendantSet = new Set();
  state.highlightedEdgeIds = new Set();
  render();
  renderDetailPanel();
  saveUiStateToStorage();
}

// Clicking an edge on the canvas selects the edge's source node and opens
// the detail panel in edit mode, scrolling the corresponding row in the
// outgoing-edges list into view and briefly flashing it so the user sees
// which edge they clicked. Edges no longer have their own detail panel —
// they're always edited from their from-node.
function selectEdge(edgeId) {
  if (!state.canvasEdit) return;
  const edge = EDGES.find(e => e.id === edgeId);
  if (!edge) return;
  state.canvasEdit.editMode = true;
  state.canvasEdit.flashedEdgeId = edgeId;
  // Promote to a real selection so Delete-key dispatch (16e:deleteSelection)
  // and the .edge-path.selected CSS (05-visualization.css:260) both fire.
  state.selectedEdgeId = edgeId;

  if (state.selectedNodeId === edge.from) {
    render();
    renderDetailPanel();
  } else {
    // selectNode toggles when called with the current id; we already handled
    // that above so it's safe to set directly here.
    state.selectedNodeId = edge.from;
    state.ancestorSet = getAncestors(edge.from);
    state.descendantSet = getDescendants(edge.from);
    state.highlightedEdgeIds = computeHighlightedEdges(edge.from);
    render();
    renderDetailPanel();
    saveUiStateToStorage();
  }

  // After the panel renders, scroll the flashed row into view + auto-clear
  // the flash flag once the CSS animation has run.
  setTimeout(() => {
    const row = document.querySelector('[data-edge-row-id="' + CSS.escape(edgeId) + '"]');
    if (row && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, 30);
  setTimeout(() => {
    if (state.canvasEdit && state.canvasEdit.flashedEdgeId === edgeId) {
      state.canvasEdit.flashedEdgeId = null;
    }
  }, 1800);
}

// Clears node selection. The empty-SVG click handler calls this. (Edges
// don't get their own selection any more — clicking an edge goes through
// selectEdge above, which is just a navigation helper.)
function deselectAll() {
  state.selectedNodeId = null;
  state.selectedEdgeId = null;
  state.ancestorSet = new Set();
  state.descendantSet = new Set();
  state.highlightedEdgeIds = new Set();
  if (state.canvasEdit) state.canvasEdit.flashedEdgeId = null;
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
