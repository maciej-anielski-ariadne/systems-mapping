// =============================================================================
// CANVAS DIRECT EDIT — the primary editing path
// -----------------------------------------------------------------------------
// Users edit the map directly on the canvas: hover an empty cell to ghost-add
// a node, click to create, double-click a label to rename, drag from a node's
// right edge to draw an edge, press Delete to remove with a 6-second undo.
//
// Every mutation funnels through applyCanvasMutation() — the single chokepoint
// that re-runs the existing pipeline (rebuildIndexes → computeLayout → render →
// renderDetailPanel) and persists the new state to localStorage via the live
// state CSV serializer.
//
// The full Build / Edit wizard (16a-16d) still works in parallel for bulk
// imports / structural edits; both write to the same NODES/EDGES/etc.
// =============================================================================

// ───── Constants ──────────────────────────────────────────────────────────
// Small palette used when seeding a new stream so adjacent streams visually
// differ. Cycles by index.
const STREAM_COLOR_PALETTE = [
  "#60a5fa",  // blue
  "#a78bfa",  // purple
  "#34d399",  // emerald
  "#f59e0b",  // amber
  "#f472b6",  // pink
  "#22d3ee",  // cyan
  "#fb7185",  // rose
  "#84cc16",  // lime
];

const UNDO_TOAST_DURATION_MS = 6000;
const EFFECT_OPTIONS_FOR_PICKER = ["enables", "increases", "decreases"];
const EDGE_HANDLE_PIXEL_HITBOX = 10;   // generous mousedown target

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
      if (state.canvasEdit && state.canvasEdit.pendingEdgeDrop) {
        dismissEffectPicker();
        event.preventDefault();
        return;
      }
      if (state.selectedNodeId) {
        deselectAll();
        event.preventDefault();
        return;
      }
    }
    if ((event.key === "Delete" || event.key === "Backspace") && state.dataLoaded) {
      if (deleteSelection()) event.preventDefault();
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
}

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

  // Only show ghost on EMPTY cells — if there's already a node here, the
  // user should drag-to-edge or click the node itself.
  for (const node of NODES) {
    if (node.stream === foundStream.id && node.stage === foundStage.id) return null;
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
    EFFECT_OPTIONS_FOR_PICKER.map(eff =>
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

// ───── Delete + undo ──────────────────────────────────────────────────────
// Keyboard Delete only deletes the currently-selected NODE (with its incident
// edges). Individual edges are deleted via the per-row × button inside the
// node's edit panel; that path calls deleteEdgeById() directly.
function deleteSelection() {
  if (state.selectedNodeId) {
    const node = nodeById[state.selectedNodeId];
    if (!node) return false;
    const incidentEdges = EDGES.filter(e => e.from === node.id || e.to === node.id).map(e => ({
      from: e.from, to: e.to, effect: e.effect, elasticity: e.elasticity, description: e.description,
    }));
    const snapshot = {
      kind: "node",
      node: Object.assign({}, node),
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
    edge: { from: edge.from, to: edge.to, effect: edge.effect, elasticity: edge.elasticity, description: edge.description },
  };
  EDGES = EDGES.filter(e => e.id !== edgeId);
  pushUndo(snapshot);
  applyCanvasMutation();
  showUndoToast("Edge deleted", () => restoreFromUndo(snapshot));
}

function pushUndo(entry) {
  state.undoStack = [entry];   // single-level cap
}

function restoreFromUndo(entry) {
  if (!entry) return;
  if (entry.kind === "node") {
    NODES.push(entry.node);
    for (const e of entry.incidentEdges) {
      // Only re-add edges whose other endpoint still exists. If the user
      // deleted-then-deleted again on a connected node, that incident edge
      // is gone.
      EDGES.push({ from: e.from, to: e.to, effect: e.effect, elasticity: e.elasticity, description: e.description });
    }
    applyCanvasMutation();
    selectNode(entry.node.id);
  } else if (entry.kind === "edge") {
    EDGES.push(entry.edge);
    applyCanvasMutation();
  } else if (entry.kind === "stream") {
    const idx = Math.min(Math.max(entry.streamIndex, 0), STREAMS.length);
    STREAMS.splice(idx, 0, Object.assign({}, entry.stream));
    for (const n of entry.nodes) NODES.push(Object.assign({}, n));
    for (const e of entry.edges) EDGES.push({ from: e.from, to: e.to, effect: e.effect, elasticity: e.elasticity, description: e.description });
    applyCanvasMutation();
  } else if (entry.kind === "stage") {
    const idx = Math.min(Math.max(entry.stageIndex, 0), STAGES.length);
    STAGES.splice(idx, 0, { id: entry.stage.id, label: entry.stage.label });
    for (const n of entry.nodes) NODES.push(Object.assign({}, n));
    for (const e of entry.edges) EDGES.push({ from: e.from, to: e.to, effect: e.effect, elasticity: e.elasticity, description: e.description });
    applyCanvasMutation();
  }
  state.undoStack = [];
}

// ───── Undo toast ─────────────────────────────────────────────────────────
function ensureUndoToastEl() {
  if (document.getElementById("canvas-undo-toast")) return;
  const el = document.createElement("div");
  el.id = "canvas-undo-toast";
  el.className = "undo-toast";
  el.style.display = "none";
  el.innerHTML = '<span class="undo-toast-msg"></span><button class="undo-link">Undo</button>';
  document.body.appendChild(el);
}

function showUndoToast(message, undoFn) {
  ensureUndoToastEl();
  const el = document.getElementById("canvas-undo-toast");
  if (!el) return;
  el.querySelector(".undo-toast-msg").textContent = message;
  el.style.display = "flex";

  const undoBtn = el.querySelector(".undo-link");
  // Clone-and-replace to drop any previous click handler.
  const freshBtn = undoBtn.cloneNode(true);
  undoBtn.parentNode.replaceChild(freshBtn, undoBtn);
  freshBtn.addEventListener("click", () => {
    dismissUndoToast();
    undoFn();
  });

  // Clear any pre-existing timer.
  if (state.canvasEdit.toast && state.canvasEdit.toast.timerId) {
    clearTimeout(state.canvasEdit.toast.timerId);
  }
  const timerId = setTimeout(dismissUndoToast, UNDO_TOAST_DURATION_MS);
  state.canvasEdit.toast = { message: message, undoFn: undoFn, timerId: timerId };
}

function dismissUndoToast() {
  const el = document.getElementById("canvas-undo-toast");
  if (el) el.style.display = "none";
  if (state.canvasEdit.toast && state.canvasEdit.toast.timerId) {
    clearTimeout(state.canvasEdit.toast.timerId);
  }
  state.canvasEdit.toast = null;
}

// ───── Add stream / stage ─────────────────────────────────────────────────
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

// Sidebar — confirm + cascade delete a stream. Pulls every node in that
// stream + every incident edge into a single undo snapshot.
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
    nodes: nodesToDelete.map(n => Object.assign({}, n)),
    edges: edgesToDelete.map(e => ({ from: e.from, to: e.to, effect: e.effect, elasticity: e.elasticity, description: e.description })),
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
    nodes: nodesToDelete.map(n => Object.assign({}, n)),
    edges: edgesToDelete.map(e => ({ from: e.from, to: e.to, effect: e.effect, elasticity: e.elasticity, description: e.description })),
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

// Sidebar — reorder STREAMS / STAGES by moving the item at fromIndex to
// targetIndex (insertion before that position). Called by the sidebar's
// drag-and-drop wiring.
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

// After renderSidebar repaints, focus the freshly-opened label input.
function focusSidebarEditLabel(kind, id) {
  setTimeout(() => {
    const input = document.querySelector(".sidebar-edit-row.expanded[data-kind='" + kind + "'][data-id='" + id + "'] [data-field='label']");
    if (input && typeof input.focus === "function") {
      input.focus();
      if (typeof input.select === "function") input.select();
    }
  }, 0);
}
