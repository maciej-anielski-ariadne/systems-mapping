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

// Upstream neighbours up to `depth` hops away: BFS outward following incoming
// edges. depth 1 = direct inputs only (the historical behaviour); higher depths
// walk further up the chain. The selected node itself is never included.
function getAncestors(nodeId, depth = state.highlightDepth) {
  const result = new Set();
  let frontier = [nodeId];
  for (let level = 0; level < depth && frontier.length; level++) {
    const next = [];
    for (const id of frontier) {
      for (const edge of incomingEdges[id]) {
        if (edge.from !== nodeId && !result.has(edge.from)) {
          result.add(edge.from);
          next.push(edge.from);
        }
      }
    }
    frontier = next;
  }
  return result;
}

// Downstream neighbours up to `depth` hops away: same BFS following outgoing edges.
function getDescendants(nodeId, depth = state.highlightDepth) {
  const result = new Set();
  let frontier = [nodeId];
  for (let level = 0; level < depth && frontier.length; level++) {
    const next = [];
    for (const id of frontier) {
      for (const edge of outgoingEdges[id]) {
        if (edge.to !== nodeId && !result.has(edge.to)) {
          result.add(edge.to);
          next.push(edge.to);
        }
      }
    }
    frontier = next;
  }
  return result;
}

// Edges crossed while walking up- and downstream within `depth` hops of the
// selected node — i.e. every edge along the highlighted ancestor/descendant
// chains. BFS by node, collecting edge ids as we step outward.
function computeHighlightedEdges(nodeId, depth = state.highlightDepth) {
  const edges = new Set();
  for (const [adjacency, endpointKey] of [[incomingEdges, "from"], [outgoingEdges, "to"]]) {
    const visited = new Set([nodeId]);
    let frontier = [nodeId];
    for (let level = 0; level < depth && frontier.length; level++) {
      const next = [];
      for (const id of frontier) {
        for (const edge of adjacency[id]) {
          edges.add(edge.id);
          const neighbour = edge[endpointKey];
          if (!visited.has(neighbour)) {
            visited.add(neighbour);
            next.push(neighbour);
          }
        }
      }
      frontier = next;
    }
  }
  return edges;
}

// ───── Select / deselect ──────────────────────────────────────────────────

// Recompute the ancestor / descendant / highlighted-edge sets for the current
// selection. Neighbour highlighting only makes sense for a single selected node
// — when more than one node is selected we clear it so the canvas isn't a wall
// of blue/amber borders. Called by selectNode / toggle / marquee / setSelection.
function refreshNeighborHighlight() {
  if (state.selectedNodeIds.size === 1 && state.selectedNodeId) {
    state.ancestorSet        = getAncestors(state.selectedNodeId);
    state.descendantSet      = getDescendants(state.selectedNodeId);
    state.highlightedEdgeIds = computeHighlightedEdges(state.selectedNodeId);
  } else {
    state.ancestorSet        = new Set();
    state.descendantSet      = new Set();
    state.highlightedEdgeIds = new Set();
  }
}

// Toggle behaviour: clicking the already-selected node deselects it. A plain
// click always collapses to a single-node selection (clearing any multi-set).
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
  // Toggle off only when this is the lone current selection — clicking one of
  // several multi-selected nodes collapses to just that node instead.
  if (state.selectedNodeId === nodeId && state.selectedNodeIds.size <= 1) {
    deselectNode();
    return;
  }
  state.selectedNodeId = nodeId;
  state.selectedNodeIds = new Set([nodeId]);
  state.selectedEdgeId = null;   // node and edge selection are mutually exclusive
  refreshNeighborHighlight();
  render();
  renderDetailPanel();
  if (typeof renderMultiSelectBar === "function") renderMultiSelectBar();
  saveUiStateToStorage();
}

// Shift+click a node: add it to / remove it from the multi-selection without
// disturbing the rest. The newest-added node becomes the primary; removing the
// primary re-picks another member (or clears selection entirely).
function toggleNodeInSelection(nodeId) {
  if (typeof commitInlineRename === "function") commitInlineRename();
  if (typeof endEdgeCycleSession === "function") endEdgeCycleSession();
  if (state.canvasEdit) state.canvasEdit.cursorCell = null;
  state.selectedEdgeId = null;
  if (state.selectedNodeIds.has(nodeId)) {
    state.selectedNodeIds.delete(nodeId);
    if (state.selectedNodeId === nodeId) {
      const remaining = [...state.selectedNodeIds];
      state.selectedNodeId = remaining.length ? remaining[remaining.length - 1] : null;
    }
  } else {
    state.selectedNodeIds.add(nodeId);
    state.selectedNodeId = nodeId;   // newest becomes primary
  }
  refreshNeighborHighlight();
  render();
  renderDetailPanel();
  if (typeof renderMultiSelectBar === "function") renderMultiSelectBar();
  saveUiStateToStorage();
}

// Replace the whole selection with the given ids, picking primaryId as primary
// when it's a member (else the first id). Deliberately does NOT render — the
// caller (e.g. the marquee move loop) renders once after calling this.
function setSelection(ids, primaryId) {
  if (typeof endEdgeCycleSession === "function") endEdgeCycleSession();
  state.selectedNodeIds = new Set(ids);
  state.selectedEdgeId = null;
  if (state.selectedNodeIds.size) {
    state.selectedNodeId = (primaryId && state.selectedNodeIds.has(primaryId))
      ? primaryId
      : [...state.selectedNodeIds][0];
  } else {
    state.selectedNodeId = null;
  }
  refreshNeighborHighlight();
}

function deselectNode() {
  if (typeof commitInlineRename === "function") commitInlineRename();
  if (typeof endEdgeCycleSession === "function") endEdgeCycleSession();
  state.selectedNodeId = null;
  state.selectedNodeIds = new Set();
  state.selectedEdgeId = null;
  state.ancestorSet = new Set();
  state.descendantSet = new Set();
  state.highlightedEdgeIds = new Set();
  render();
  renderDetailPanel();
  if (typeof renderMultiSelectBar === "function") renderMultiSelectBar();
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
  // Edge selection is its own mode — drop any multi-node selection so the
  // batch action bar hides and Delete targets the edge.
  state.selectedNodeIds = new Set();
  if (typeof renderMultiSelectBar === "function") renderMultiSelectBar();

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
  state.selectedNodeIds = new Set();
  state.selectedEdgeId = null;
  state.ancestorSet = new Set();
  state.descendantSet = new Set();
  state.highlightedEdgeIds = new Set();
  if (state.canvasEdit) state.canvasEdit.flashedEdgeId = null;
  render();
  renderDetailPanel();
  if (typeof renderMultiSelectBar === "function") renderMultiSelectBar();
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
