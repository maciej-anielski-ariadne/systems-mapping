// =============================================================================
// CANVAS DIRECT EDIT — the gestures that drive the map
// -----------------------------------------------------------------------------
// Users edit the map directly on the canvas: hover an empty cell to ghost-add
// a node, click to create, drag from a node's right edge to draw an edge,
// press Delete to remove with a 6-second undo.
//
// This file owns the *gestures*:
//   • bootEmptyStateGrid()  — seed an empty 3×3 starter grid on first load.
//   • initCanvasEdit()      — one-shot wiring of mousemove / keydown listeners.
//   • attachCanvasEditHandlers() — re-wires per-render listeners on the SVG
//                                  (ghost-cell click, edge-handle mousedown,
//                                  edge-hit click). Called by 11-rendering.js
//                                  after every render.
//   • handleSvgMouseMove + cellAtLayoutPoint — translate cursor coords to the
//                                              empty (stream, stage) cell.
//   • createNodeInCell      — turn a ghost-cell click into a real node.
//   • beginEdgeDrag / update / end + cancelDraftEdge + nodeAtLayoutPoint —
//                              edge drag-out from a node's right edge.
//   • showEffectPicker / commitNewEdge — pick enables / increases / decreases
//                                        after the edge is dropped.
//   • deleteSelection / deleteEdgeById — Delete-key removes the selected
//                                        node (with incident edges) or a
//                                        specific edge via the edit panel's
//                                        per-row × button.
//
// Sidebar-driven mutations (add/delete/reorder stream / stage / category)
// live in 16f-canvas-mutations.js. Undo bookkeeping + the toast UI live in
// 16g-canvas-undo.js. The single mutation chokepoint applyCanvasMutation()
// is in 16f.
//
// Shared option lists (EFFECT_OPTIONS, STREAM_COLOR_PALETTE) live in 02-config.js.
// Edge / node clone helpers (cloneEdgeForUndo, cloneNodeForUndo) live in 04-utils.js.
// =============================================================================

// ───── Bootstrapping ──────────────────────────────────────────────────────

// Called once from 18-main.js after the script loads. Wires window-level
// listeners (mousemove for hover cell, keydown for Delete/Esc) and appends
// the undo-toast element to <body>.
function initCanvasEdit() {
  ensureUndoToastEl();

  const vizSvg = document.getElementById("viz-svg");
  if (vizSvg) {
    vizSvg.addEventListener("mousemove", handleSvgMouseMove);
    vizSvg.addEventListener("mouseleave", () => {
      if (state.canvasEdit && state.canvasEdit.hoverCell) {
        state.canvasEdit.hoverCell = null;
        layout = computeLayout();
        render();
      }
    });
  }

  // Delete / Backspace removes the selected node or edge. Esc cancels
  // active label edit / edge drag / clears selection.
  document.addEventListener("keydown", event => {
    // Bail when the user is typing — Backspace must not nuke a node while
    // editing its label.
    const target = event.target;
    if (target && target.matches && target.matches("input, textarea, select, [contenteditable]")) return;
    // Builder wizard owns its own keyboard handling.
    if (state.builder && state.builder.open) return;

    if (event.key === "Escape") {
      if (cancelDraftEdge())        { event.preventDefault(); return; }
      if (cancelDraftNodeDrag())    { event.preventDefault(); return; }
      if (state.canvasEdit && state.canvasEdit.pendingEdgeDrop) {
        dismissEffectPicker();
        event.preventDefault();
        return;
      }
      if (state.selectedNodeId || state.selectedEdgeId) {
        deselectAll();
        event.preventDefault();
        return;
      }
    }
    if ((event.key === "Delete" || event.key === "Backspace") && state.dataLoaded) {
      if (deleteSelection()) event.preventDefault();
    }

    // Multi-level undo / redo. Native browser-level undo wins inside text
    // inputs thanks to the input-target guard above.
    const cmdOrCtrl = event.metaKey || event.ctrlKey;
    if (cmdOrCtrl && (event.key === "z" || event.key === "Z")) {
      if (event.shiftKey) { if (typeof historyRedo === "function" && historyRedo()) event.preventDefault(); }
      else                { if (typeof historyUndo === "function" && historyUndo()) event.preventDefault(); }
      return;
    }
    if (cmdOrCtrl && (event.key === "y" || event.key === "Y")) {
      if (typeof historyRedo === "function" && historyRedo()) event.preventDefault();
      return;
    }
  });
}

// Boot the app with an empty 3×3 starter grid. Called from 18-main.js when
// there is no saved CSV to restore. The user can immediately start clicking
// cells to add nodes — no drop-zone overlay, no wizard needed.
function bootEmptyStateGrid() {
  STREAMS = [
    { id: "row_1", label: "Stream 1", short: "S1", color: STREAM_COLOR_PALETTE[0] },
    { id: "row_2", label: "Stream 2", short: "S2", color: STREAM_COLOR_PALETTE[1] },
    { id: "row_3", label: "Stream 3", short: "S3", color: STREAM_COLOR_PALETTE[2] },
  ];
  STAGES = [
    { id: "stage_1", label: "Stage 1" },
    { id: "stage_2", label: "Stage 2" },
    { id: "stage_3", label: "Stage 3" },
  ];
  CATEGORIES = {};
  NODES = [];
  EDGES = [];
  DEFAULT_ELASTICITY_BY_EFFECT = { enables: 0.30, increases: 0.25, decreases: -0.25 };

  state.dataLoaded = true;
  state.loadErrors = [];
  state.selectedNodeId = null;
  state.hoveredNodeId = null;
  state.hiddenStreams = new Set();
  state.hiddenCategories = new Set();
  state.ancestorSet = new Set();
  state.descendantSet = new Set();
  state.highlightedEdgeIds = new Set();
  state.userOverrides = {};
  state.computedValues = {};
  if (state.canvasEdit) {
    state.canvasEdit.hoverCell = null;
    state.canvasEdit.draftEdge = null;
    state.canvasEdit.pendingEdgeDrop = null;
    state.canvasEdit.flashedEdgeId = null;
    state.canvasEdit.addingEdgeFromNodeId = null;
    state.canvasEdit.editingSidebarItem = null;
  }

  rebuildIndexes();
  layout = computeLayout();
  hideDropZone();
  renderSidebar();
  render();
  renderDetailPanel();
  // Seed the undo "previous snapshot" so the first mutation after boot has
  // something to push onto history.past, and start with an empty stack.
  try {
    state.lastCsvSnapshot = serializeLiveStateToCsv();
  } catch (err) { /* serializer unavailable yet — first applyCanvasMutation will set it */ }
  if (typeof clearHistory === "function") clearHistory();
}

// ───── Per-render event binding ───────────────────────────────────────────
// Called by attachSvgEventHandlers() in 11-rendering.js after every render.
// The canvas hosts only spatial gestures: ghost-cell click to add, drag
// from a node's right edge to draw an edge, edge click to navigate. All
// rename / re-colour / reorder / add-stream / add-stage flows live in
// the sidebar and the right detail panel.
function attachCanvasEditHandlers() {
  const vizSvg = document.getElementById("viz-svg");
  if (!vizSvg) return;

  // Ghost cell click → create a new node in that cell.
  vizSvg.querySelectorAll(".ghost-cell").forEach(group => {
    group.addEventListener("click", event => {
      event.stopPropagation();
      const streamId = group.getAttribute("data-stream-id");
      const stageId  = group.getAttribute("data-stage-id");
      createNodeInCell(streamId, stageId);
    });
  });

  // Edge handle mousedown → start an edge drag.
  vizSvg.querySelectorAll(".edge-handle").forEach(handle => {
    handle.addEventListener("mousedown", event => {
      if (event.button !== 0) return;
      event.stopPropagation();
      event.preventDefault();
      const nodeId = handle.getAttribute("data-node-id");
      beginEdgeDrag(nodeId, event.clientX, event.clientY);
    });
  });

  // Edge click (wide hit-path) → select the from-node + open edit mode.
  vizSvg.querySelectorAll(".edge-hit").forEach(path => {
    path.addEventListener("click", event => {
      event.stopPropagation();
      const edgeId = path.getAttribute("data-edge-id");
      if (typeof selectEdge === "function") selectEdge(edgeId);
    });
  });

  // Node mousedown → candidate drag-to-move. We don't preventDefault or
  // stopPropagation here so the existing click → selectNode (in
  // attachSvgEventHandlers, 11-rendering.js) still fires when the gesture
  // turns out to be a click. Promotion to a real drag happens in
  // maybePromoteNodeDrag once the cursor moves past NODE_DRAG_THRESHOLD.
  vizSvg.querySelectorAll(".node-group").forEach(group => {
    group.addEventListener("mousedown", event => {
      if (event.button !== 0) return;
      if (event.target && event.target.closest && event.target.closest(".edge-handle")) return;
      const nodeId = group.getAttribute("data-node-id");
      beginNodeDragCandidate(nodeId, event.clientX, event.clientY);
    });
  });
}

// ───── Hover cell tracking ────────────────────────────────────────────────
// Translates SVG mouse coordinates to layout coordinates, figures out which
// (stream, stage) cell the cursor is in, and (when that cell is empty)
// updates state.canvasEdit.hoverCell so render() draws the ghost.
function handleSvgMouseMove(event) {
  if (!state.dataLoaded) return;
  if (state.canvasEdit && state.canvasEdit.draftEdge) return;  // dragging an edge — separate render loop owns hoverCell
  const layoutPoint = clientPointToLayout(event.clientX, event.clientY);
  if (!layoutPoint) return;
  const cell = cellAtLayoutPoint(layoutPoint.x, layoutPoint.y);
  const prev = state.canvasEdit && state.canvasEdit.hoverCell;
  const same = (prev && cell && prev.streamId === cell.streamId && prev.stageId === cell.stageId) ||
               (!prev && !cell);
  if (same) return;
  state.canvasEdit.hoverCell = cell;
  // Recompute layout — entering or leaving a partially-filled cell may add
  // or remove a reserved "+ add another" slot in the row's height. Cheap:
  // computeLayout is O(NODES × STAGES) and only runs on cell-boundary
  // crossings.
  layout = computeLayout();
  render();
}

// Convert a clientX / clientY (mouse event) to layout coordinates, accounting
// for both the #viz-scroll scroll offset and the current zoom level.
function clientPointToLayout(clientX, clientY) {
  const vizScrollEl = document.getElementById("viz-scroll");
  const vizSvg = document.getElementById("viz-svg");
  if (!vizScrollEl || !vizSvg) return null;
  const rect = vizScrollEl.getBoundingClientRect();
  const zoom = (state.zoomLevel && !isNaN(state.zoomLevel)) ? state.zoomLevel : 1.0;
  return {
    x: (clientX - rect.left + vizScrollEl.scrollLeft) / zoom,
    y: (clientY - rect.top  + vizScrollEl.scrollTop)  / zoom,
  };
}

// Return { streamId, stageId } for the (empty) cell containing layout point,
// or null if the point is outside the grid, on a non-empty cell, or on the
// row-label / column-header strip.
function cellAtLayoutPoint(x, y) {
  if (x < ROW_HEADER_WIDTH) return null;
  if (y < SVG_PADDING_TOP + COL_HEADER_HEIGHT) return null;

  // Find row by Y.
  let foundStream = null;
  for (const stream of STREAMS) {
    if (state.hiddenStreams.has(stream.id)) continue;
    const top = layout.rowY[stream.id];
    const bot = top + layout.rowHeights[stream.id];
    if (y >= top && y < bot) { foundStream = stream; break; }
  }
  if (!foundStream) return null;

  // Find column by X.
  let foundStage = null;
  for (const stage of STAGES) {
    const left = layout.colX[stage.id];
    if (left === undefined) continue;
    const right = left + NODE_WIDTH;
    if (x >= left && x < right) { foundStage = stage; break; }
  }
  if (!foundStage) return null;

  // If the cursor is over one of the cell's existing nodes, let that node's
  // own click handler win (select / drag-edge). Otherwise the cell is a
  // valid drop target — either empty (new node) or partially-filled (stack
  // another node below the existing ones).
  for (const node of NODES) {
    if (node.stream !== foundStream.id || node.stage !== foundStage.id) continue;
    const pos = layout.positions[node.id];
    if (pos && x >= pos.x && x < pos.x + pos.width && y >= pos.y && y < pos.y + pos.height) {
      return null;
    }
  }
  return { streamId: foundStream.id, stageId: foundStage.id };
}

// ───── Create node ────────────────────────────────────────────────────────
function createNodeInCell(streamId, stageId) {
  if (!streamId || !stageId) return;
  if (!streamById[streamId] || !stageById[stageId]) return;

  // Guarantee a category exists before we reference it from the new node;
  // otherwise the round-trip through loadDataFromCsv on reload would reject
  // the node (unknown category).
  ensureDefaultCategory();
  const categoryId = Object.keys(CATEGORIES)[0];

  const newNode = {
    id: generateUniqueNodeId("new_node"),
    label: "New node",
    description: "",
    stream: streamId,
    stage: stageId,
    category: categoryId,
  };
  NODES.push(newNode);
  state.canvasEdit.hoverCell = null;
  // Open the detail panel in edit mode so the user lands in the rename
  // flow immediately. selectNode triggers the panel render; we then focus
  // the Label input on the next tick once the DOM exists.
  state.canvasEdit.editMode = true;
  applyCanvasMutation();
  selectNode(newNode.id);
  setTimeout(() => {
    const labelInput = document.querySelector("#detail-content [data-field='label']");
    if (labelInput && typeof labelInput.focus === "function") {
      labelInput.focus();
      if (typeof labelInput.select === "function") labelInput.select();
    }
  }, 0);
}

// Build a node id from a label that doesn't collide with any existing one.
function generateUniqueNodeId(seed) {
  const base = (typeof slugify === "function" ? slugify(seed) : String(seed).toLowerCase().replace(/[^a-z0-9]+/g, "_")) || "node";
  if (!nodeById[base]) return base;
  let counter = 2;
  while (nodeById[base + "_" + counter]) counter++;
  return base + "_" + counter;
}

// Auto-create a "Default" category if no categories exist yet. Used on the
// first add-node action when the user has started from an empty grid.
function ensureDefaultCategory() {
  if (Object.keys(CATEGORIES).length > 0) return;
  CATEGORIES["default"] = {
    label: "Default",
    color: "#a3a3a3",
    textColor: "#1c1917",
  };
}

// Derive a short label (uppercase, ~6 chars) for a stream. First two letters
// of each word, capped at 6 chars total.
function deriveShortLabel(label) {
  const words = String(label || "").trim().split(/\s+/);
  let short = "";
  for (const word of words) {
    if (!word) continue;
    short += word.slice(0, 2);
    if (short.length >= 6) break;
  }
  return (short || "X").toUpperCase().slice(0, 6);
}

// ───── Edge drag ──────────────────────────────────────────────────────────
let _draftEdgeMoveBound = null;
let _draftEdgeUpBound   = null;

function beginEdgeDrag(fromNodeId, clientX, clientY) {
  const point = clientPointToLayout(clientX, clientY);
  if (!point) return;
  state.canvasEdit.draftEdge = {
    fromNodeId: fromNodeId,
    currentX: point.x,
    currentY: point.y,
    dropTargetId: null,
  };
  // Suspend ghost-cell tracking while dragging.
  state.canvasEdit.hoverCell = null;
  render();

  _draftEdgeMoveBound = (event) => updateEdgeDrag(event);
  _draftEdgeUpBound   = (event) => endEdgeDrag(event);
  window.addEventListener("mousemove", _draftEdgeMoveBound);
  window.addEventListener("mouseup",   _draftEdgeUpBound);
}

function updateEdgeDrag(event) {
  const draft = state.canvasEdit && state.canvasEdit.draftEdge;
  if (!draft) return;
  const point = clientPointToLayout(event.clientX, event.clientY);
  if (!point) return;
  draft.currentX = point.x;
  draft.currentY = point.y;
  // Detect which node (if any) is under the cursor so we can highlight it.
  draft.dropTargetId = nodeAtLayoutPoint(point.x, point.y);
  render();
}

function endEdgeDrag(event) {
  const draft = state.canvasEdit && state.canvasEdit.draftEdge;
  window.removeEventListener("mousemove", _draftEdgeMoveBound);
  window.removeEventListener("mouseup",   _draftEdgeUpBound);
  _draftEdgeMoveBound = null;
  _draftEdgeUpBound = null;
  if (!draft) return;

  const point = clientPointToLayout(event.clientX, event.clientY);
  const targetId = point ? nodeAtLayoutPoint(point.x, point.y) : null;
  state.canvasEdit.draftEdge = null;

  if (!targetId || targetId === draft.fromNodeId) {
    render();
    return;
  }

  // Show the inline effect picker at the drop point. The picker creates the
  // edge once the user clicks one of its buttons.
  state.canvasEdit.pendingEdgeDrop = {
    fromNodeId: draft.fromNodeId,
    toNodeId:   targetId,
    clientX:    event.clientX,
    clientY:    event.clientY,
  };
  render();
  showEffectPicker(draft.fromNodeId, targetId, event.clientX, event.clientY);
}

function cancelDraftEdge() {
  if (!state.canvasEdit || !state.canvasEdit.draftEdge) return false;
  state.canvasEdit.draftEdge = null;
  if (_draftEdgeMoveBound) {
    window.removeEventListener("mousemove", _draftEdgeMoveBound);
    window.removeEventListener("mouseup",   _draftEdgeUpBound);
    _draftEdgeMoveBound = null;
    _draftEdgeUpBound = null;
  }
  render();
  return true;
}

// Find the visible node whose bounding rect contains (x, y) in layout coords.
function nodeAtLayoutPoint(x, y) {
  for (const node of NODES) {
    if (!isNodeVisible(node)) continue;
    const pos = layout.positions[node.id];
    if (!pos) continue;
    if (x >= pos.x && x < pos.x + pos.width && y >= pos.y && y < pos.y + pos.height) {
      return node.id;
    }
  }
  return null;
}

// ───── Node drag (move between cells + reorder within a cell) ────────────
// Two phases:
//   1. Candidate phase. Mousedown registers _pendingNodeDrag and binds window
//      mousemove/up so we can either promote to a real drag (cursor crosses
//      NODE_DRAG_THRESHOLD) or fall through to a normal click.
//   2. Active phase. Once promoted, state.canvasEdit.draggingNode is set and
//      render() draws the dragged node ghosted in place + a preview at the
//      cursor + a drop-target outline + an insertion line. On mouseup we
//      either splice the node into its new cell position or no-op.
const NODE_DRAG_THRESHOLD = 4;
let _pendingNodeDrag    = null;
let _nodeDragMoveBound  = null;
let _nodeDragUpBound    = null;
let _nodeDragSwallowClickBound = null;

function beginNodeDragCandidate(nodeId, clientX, clientY) {
  _pendingNodeDrag = { nodeId: nodeId, startClientX: clientX, startClientY: clientY };
  _nodeDragMoveBound = (e) => maybePromoteNodeDrag(e);
  _nodeDragUpBound   = (e) => cleanupPendingNodeDrag(e);
  window.addEventListener("mousemove", _nodeDragMoveBound);
  window.addEventListener("mouseup",   _nodeDragUpBound);
}

function maybePromoteNodeDrag(event) {
  if (!_pendingNodeDrag) return;
  const dx = event.clientX - _pendingNodeDrag.startClientX;
  const dy = event.clientY - _pendingNodeDrag.startClientY;
  if (Math.abs(dx) < NODE_DRAG_THRESHOLD && Math.abs(dy) < NODE_DRAG_THRESHOLD) return;
  const nodeId = _pendingNodeDrag.nodeId;
  // Tear down candidate listeners — startNodeDrag re-binds with the real handlers.
  window.removeEventListener("mousemove", _nodeDragMoveBound);
  window.removeEventListener("mouseup",   _nodeDragUpBound);
  _pendingNodeDrag = null;
  _nodeDragMoveBound = null;
  _nodeDragUpBound   = null;
  startNodeDrag(nodeId, event);
}

function cleanupPendingNodeDrag() {
  if (!_pendingNodeDrag) return;
  window.removeEventListener("mousemove", _nodeDragMoveBound);
  window.removeEventListener("mouseup",   _nodeDragUpBound);
  _pendingNodeDrag = null;
  _nodeDragMoveBound = null;
  _nodeDragUpBound   = null;
}

function startNodeDrag(nodeId, event) {
  const point = clientPointToLayout(event.clientX, event.clientY);
  if (!point) return;
  // Suspend hover-cell tracking so the ghost preview doesn't compete.
  state.canvasEdit.hoverCell = null;
  state.canvasEdit.draggingNode = {
    nodeId: nodeId,
    currentX: point.x,
    currentY: point.y,
    dropCell: dropCellForDrag(point.x, point.y, nodeId),
    active: true,
  };
  document.body.classList.add("node-dragging");
  _nodeDragMoveBound = (e) => updateNodeDrag(e);
  _nodeDragUpBound   = (e) => endNodeDrag(e);
  window.addEventListener("mousemove", _nodeDragMoveBound);
  window.addEventListener("mouseup",   _nodeDragUpBound);
  layout = computeLayout();
  render();
}

function updateNodeDrag(event) {
  const drag = state.canvasEdit && state.canvasEdit.draggingNode;
  if (!drag) return;
  const point = clientPointToLayout(event.clientX, event.clientY);
  if (!point) return;
  drag.currentX = point.x;
  drag.currentY = point.y;
  const next = dropCellForDrag(point.x, point.y, drag.nodeId);
  const prev = drag.dropCell;
  drag.dropCell = next;
  // Recompute layout when the dragged cell changes — entering a non-empty
  // cell expands its row to make room for the inserted slot.
  const samePrev = prev && next && prev.streamId === next.streamId && prev.stageId === next.stageId && prev.insertIndex === next.insertIndex;
  if (!samePrev) layout = computeLayout();
  render();
}

function endNodeDrag(event) {
  const drag = state.canvasEdit && state.canvasEdit.draggingNode;
  window.removeEventListener("mousemove", _nodeDragMoveBound);
  window.removeEventListener("mouseup",   _nodeDragUpBound);
  _nodeDragMoveBound = null;
  _nodeDragUpBound   = null;
  document.body.classList.remove("node-dragging");
  if (!drag) return;

  const point = clientPointToLayout(event.clientX, event.clientY);
  const target = point ? dropCellForDrag(point.x, point.y, drag.nodeId) : null;
  const node = nodeById[drag.nodeId];
  state.canvasEdit.draggingNode = null;

  if (!node || !target) {
    layout = computeLayout();
    render();
    swallowNextClick();
    return;
  }

  if (!moveNodeToCell(node, target.streamId, target.stageId, target.insertIndex)) {
    // No-op (same cell, same slot). Still swallow the trailing click so the
    // node doesn't toggle selection just because we dragged it ~1 pixel.
    layout = computeLayout();
    render();
  }
  swallowNextClick();
}

function cancelDraftNodeDrag() {
  if (!state.canvasEdit || !state.canvasEdit.draggingNode) return false;
  state.canvasEdit.draggingNode = null;
  if (_nodeDragMoveBound) {
    window.removeEventListener("mousemove", _nodeDragMoveBound);
    window.removeEventListener("mouseup",   _nodeDragUpBound);
    _nodeDragMoveBound = null;
    _nodeDragUpBound   = null;
  }
  document.body.classList.remove("node-dragging");
  layout = computeLayout();
  render();
  return true;
}

// Swallow the click event that fires after the drop. Without this, a drop on
// the dragged node's original cell would also trigger the node-group click
// handler (selectNode) and toggle selection. Mirrors the pan-end pattern in
// 17-events.js:422-425.
function swallowNextClick() {
  if (_nodeDragSwallowClickBound) return;
  _nodeDragSwallowClickBound = (e) => {
    e.stopPropagation();
    e.preventDefault();
    window.removeEventListener("click", _nodeDragSwallowClickBound, true);
    _nodeDragSwallowClickBound = null;
  };
  window.addEventListener("click", _nodeDragSwallowClickBound, { capture: true, once: true });
}

// Given a layout point, return the cell the cursor is over PLUS the insertion
// index inside that cell (0..siblingCount). The dragged node is excluded from
// sibling enumeration so its current slot isn't counted. Hidden streams are
// skipped — dragging into a collapsed row is a no-op.
function dropCellForDrag(x, y, draggedNodeId) {
  if (x < ROW_HEADER_WIDTH) return null;
  if (y < SVG_PADDING_TOP + COL_HEADER_HEIGHT) return null;

  let foundStream = null;
  for (const stream of STREAMS) {
    if (state.hiddenStreams.has(stream.id)) continue;
    const top = layout.rowY[stream.id];
    const bot = top + layout.rowHeights[stream.id];
    if (y >= top && y < bot) { foundStream = stream; break; }
  }
  if (!foundStream) return null;

  let foundStage = null;
  for (const stage of STAGES) {
    const left = layout.colX[stage.id];
    if (left === undefined) continue;
    const right = left + NODE_WIDTH;
    if (x >= left && x < right) { foundStage = stage; break; }
  }
  if (!foundStage) return null;

  const siblings = [];
  for (const n of NODES) {
    if (n.id === draggedNodeId) continue;
    if (n.stream === foundStream.id && n.stage === foundStage.id) siblings.push(n);
  }

  // Insertion index = position before the first sibling whose vertical mid is
  // below the cursor. If past all of them, append.
  const cellTopY = layout.rowY[foundStream.id] + ROW_PADDING;
  let insertIndex = siblings.length;
  for (let i = 0; i < siblings.length; i++) {
    const slotMidY = cellTopY + i * (NODE_HEIGHT + NODE_GAP_Y) + NODE_HEIGHT / 2;
    if (y < slotMidY) { insertIndex = i; break; }
  }
  return { streamId: foundStream.id, stageId: foundStage.id, insertIndex: insertIndex };
}

// Apply the move: mutate node.stream/stage and splice the global NODES array
// so the dragged node ends up at the right cell-relative slot. NODES order is
// what layout uses (siblings are stacked top-to-bottom by NODES array order),
// so a splice is all we need — no schema change, round-trips through CSV.
// Returns true if a real mutation happened, false on no-op.
function moveNodeToCell(node, targetStreamId, targetStageId, cellInsertIdx) {
  // Compute current cell-relative index (so we can detect same-slot no-ops).
  const sameCell = (node.stream === targetStreamId && node.stage === targetStageId);
  let currentCellIdx = -1;
  if (sameCell) {
    let count = 0;
    for (const n of NODES) {
      if (n === node) { currentCellIdx = count; break; }
      if (n.stream === targetStreamId && n.stage === targetStageId) count++;
    }
    // Dropping in the same slot OR the slot immediately after — both are no-ops
    // (since the splice would put the node back where it started).
    if (cellInsertIdx === currentCellIdx || cellInsertIdx === currentCellIdx + 1) return false;
  }

  // Remove from NODES, then translate cellInsertIdx → global index in the
  // post-splice array. Walk NODES counting siblings until we've passed
  // cellInsertIdx of them.
  const oldGlobalIdx = NODES.indexOf(node);
  if (oldGlobalIdx < 0) return false;
  NODES.splice(oldGlobalIdx, 1);

  let count = 0;
  let globalInsertIdx = NODES.length;
  for (let i = 0; i < NODES.length; i++) {
    if (NODES[i].stream === targetStreamId && NODES[i].stage === targetStageId) {
      if (count === cellInsertIdx) { globalInsertIdx = i; break; }
      count++;
    }
  }
  node.stream = targetStreamId;
  node.stage  = targetStageId;
  NODES.splice(globalInsertIdx, 0, node);

  applyCanvasMutation();
  return true;
}

// ───── Effect picker (after edge drop) ────────────────────────────────────
let _effectPickerEl = null;

function showEffectPicker(fromNodeId, toNodeId, clientX, clientY) {
  dismissEffectPicker();
  const picker = document.createElement("div");
  picker.className = "edge-effect-picker";
  picker.style.left = clientX + "px";
  picker.style.top  = clientY + "px";
  picker.innerHTML =
    '<div class="edge-effect-picker-title">New edge effect</div>' +
    EFFECT_OPTIONS.map(eff =>
      '<button class="edge-effect-picker-btn ' + eff + '" data-effect="' + eff + '">' + eff + '</button>'
    ).join("") +
    '<button class="edge-effect-picker-btn cancel" data-effect="">Cancel</button>';
  document.body.appendChild(picker);
  _effectPickerEl = picker;

  picker.querySelectorAll(".edge-effect-picker-btn").forEach(btn => {
    btn.addEventListener("click", event => {
      event.stopPropagation();
      const effect = btn.getAttribute("data-effect");
      dismissEffectPicker();
      if (effect) commitNewEdge(fromNodeId, toNodeId, effect);
    });
  });

  // Click outside the picker dismisses it.
  setTimeout(() => {
    document.addEventListener("mousedown", _effectPickerOutsideHandler, true);
  }, 0);
}

function _effectPickerOutsideHandler(event) {
  if (!_effectPickerEl) return;
  if (_effectPickerEl.contains(event.target)) return;
  dismissEffectPicker();
}

function dismissEffectPicker() {
  if (_effectPickerEl) {
    _effectPickerEl.remove();
    _effectPickerEl = null;
  }
  document.removeEventListener("mousedown", _effectPickerOutsideHandler, true);
  if (state.canvasEdit) state.canvasEdit.pendingEdgeDrop = null;
}

function commitNewEdge(fromNodeId, toNodeId, effect) {
  if (!nodeById[fromNodeId] || !nodeById[toNodeId]) return;
  if (fromNodeId === toNodeId) return;
  // Skip duplicates — an edge with the same (from, to, effect) already exists.
  for (const e of EDGES) {
    if (e.from === fromNodeId && e.to === toNodeId && e.effect === effect) return;
  }
  EDGES.push({
    from: fromNodeId,
    to: toNodeId,
    effect: effect,
    description: "",
  });
  applyCanvasMutation();
}

// ───── Delete + undo (node and edge) ──────────────────────────────────────
// Keyboard Delete only deletes the currently-selected NODE (with its incident
// edges). Individual edges are deleted via the per-row × button inside the
// node's edit panel; that path calls deleteEdgeById() directly.
//
// Stream / stage / category deletion (which also cascades to nodes + edges)
// lives in 16f-canvas-mutations.js. Undo bookkeeping is in 16g-canvas-undo.js.
function deleteSelection() {
  // Edge selection wins when both are set — selectEdge sets selectedEdgeId
  // additively without clearing selectedNodeId. Without this dispatch the
  // node would be deleted instead of the edge the user just clicked.
  if (state.selectedEdgeId) {
    const edgeId = state.selectedEdgeId;
    state.selectedEdgeId = null;
    deleteEdgeById(edgeId);
    return true;
  }
  if (state.selectedNodeId) {
    const node = nodeById[state.selectedNodeId];
    if (!node) return false;
    const incidentEdges = EDGES.filter(e => e.from === node.id || e.to === node.id).map(cloneEdgeForUndo);
    const snapshot = {
      kind: "node",
      node: cloneNodeForUndo(node),
      incidentEdges: incidentEdges,
    };
    NODES = NODES.filter(n => n.id !== node.id);
    EDGES = EDGES.filter(e => e.from !== node.id && e.to !== node.id);
    state.selectedNodeId = null;
    state.ancestorSet = new Set();
    state.descendantSet = new Set();
    state.highlightedEdgeIds = new Set();
    pushUndo(snapshot);
    applyCanvasMutation();
    showUndoToast("Node deleted", () => restoreFromUndo(snapshot));
    return true;
  }
  return false;
}

// Delete a single edge by id, push an undo snapshot, show the toast. Called
// from the edit panel's per-row × buttons.
function deleteEdgeById(edgeId) {
  const edge = EDGES.find(e => e.id === edgeId);
  if (!edge) return;
  const snapshot = {
    kind: "edge",
    edge: cloneEdgeForUndo(edge),
  };
  EDGES = EDGES.filter(e => e.id !== edgeId);
  pushUndo(snapshot);
  applyCanvasMutation();
  showUndoToast("Edge deleted", () => restoreFromUndo(snapshot));
}
