// =============================================================================
// GRAPH TRAVERSAL + SELECTION
// -----------------------------------------------------------------------------
// When the user clicks a node we highlight only its DIRECT connections:
//   • Its direct inputs  (nodes with an edge pointing straight into it)
//   • Its direct outputs (nodes it has an edge pointing straight to)
//   • The edges between the selected node and those direct neighbours
//
// (We deliberately stop at one hop rather than walking the whole upstream /
// downstream tree — the immediate connections are what the user is usually
// reasoning about, and lighting up the full transitive closure swamps that.)
//
// This file contains the neighbour helpers plus the small selectNode /
// deselectNode functions that update state and trigger a re-render.
// =============================================================================

// NOTE: `incomingEdges[id]` and `outgoingEdges[id]` are guaranteed to be
// initialized to [] for every node by rebuildIndexes (06-data-loader.js),
// so we don't need defensive `|| []` fallbacks when reading them.

// Direct upstream neighbours: nodes with an edge pointing straight into nodeId.
function getAncestors(nodeId) {
  const direct = new Set();
  for (const edge of incomingEdges[nodeId]) direct.add(edge.from);
  return direct;
}

// Direct downstream neighbours: nodes nodeId has an edge pointing straight to.
function getDescendants(nodeId) {
  const direct = new Set();
  for (const edge of outgoingEdges[nodeId]) direct.add(edge.to);
  return direct;
}

// Edges directly connecting the selected node to its neighbours — that is, its
// own incoming and outgoing edges.
function computeHighlightedEdges(nodeId) {
  const edges = new Set();
  for (const edge of incomingEdges[nodeId]) edges.add(edge.id);
  for (const edge of outgoingEdges[nodeId]) edges.add(edge.id);
  return edges;
}

// ───── Select / deselect ──────────────────────────────────────────────────

// Toggle behaviour: clicking the already-selected node deselects it.
function selectNode(nodeId) {
  // Any selection change ends an in-flight inline rename — fold the typed
  // characters into a single history snapshot before moving on. Safe to call
  // when no rename is active (no-op). See 16h-canvas-inline-rename.js.
  if (state.selectedNodeId !== nodeId && typeof commitInlineRename === "function") {
    commitInlineRename();
  }
  // Selecting a node clears any selected-edge cycle session — the burst of
  // arrow presses on the previously-selected edge is now finalised in history.
  if (typeof endEdgeCycleSession === "function") endEdgeCycleSession();
  // Empty-cell keyboard cursor (16i) is mutually exclusive with a selected
  // node — picking a node retires the placeholder.
  if (state.canvasEdit) state.canvasEdit.cursorCell = null;
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
  if (typeof commitInlineRename === "function") commitInlineRename();
  if (typeof endEdgeCycleSession === "function") endEdgeCycleSession();
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
  // Selecting a different edge ends the previous edge's cycle session — its
  // pre-cycle snapshot is already in history, so undo still rewinds it.
  if (state.canvasEdit.edgeCycleSession &&
      state.canvasEdit.edgeCycleSession.edgeId !== edgeId &&
      typeof endEdgeCycleSession === "function") {
    endEdgeCycleSession();
  }
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
  if (typeof commitInlineRename === "function") commitInlineRename();
  if (state.canvasEdit) state.canvasEdit.cursorCell = null;
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
