// =============================================================================
// CANVAS UNDO — multi-level undo/redo via full-CSV snapshots + soft delete toast
// -----------------------------------------------------------------------------
// Two layers, one storage:
//
//   • Multi-level undo/redo. Every call to applyCanvasMutation (16f) pushes
//     the prior state's CSV onto state.history.past. Undo restores by feeding
//     a snapshot back through loadDataFromCsv. Triggered by Ctrl/Cmd+Z and
//     Ctrl/Cmd+Shift+Z (16e keydown handler).
//
//   • Soft delete toast. Deletes additionally surface a 6-second toast with
//     an "Undo" link, so non-keyboard users have a discoverable recovery
//     path. The link just calls historyUndo() — same machinery.
//
// Public API:
//   historyUndo()       — pop past, push current to future, reload past top.
//   historyRedo()       — pop future, push current to past, reload future top.
//   clearHistory()      — wipe both stacks (called by data-loader on fresh CSV).
//   showUndoToast(msg)  — show the bottom-of-screen toast for a delete.
//   dismissUndoToast()  — hide it.
//
// Back-compat shims (kept so existing delete call sites don't need rewrites):
//   pushUndo()       — no-op; capture now happens inside applyCanvasMutation.
//   restoreFromUndo() — thin wrapper around historyUndo().
// =============================================================================

const UNDO_TOAST_DURATION_MS = 6000;
const HISTORY_CAP = 50;
// How long the pulse on undone/redone elements stays up before auto-clearing.
// Matches the edge-click flash (06-detail-panel.css) so the two feel of a piece.
const UNDO_FLASH_DURATION_MS = 1400;

// Flag set while restoring so the auto-capture in applyCanvasMutation doesn't
// fire and double-snapshot the round-trip.
let _suspendUndoCapture = false;
function isUndoCaptureSuspended() { return _suspendUndoCapture; }

// ───── Multi-level history ────────────────────────────────────────────────
function clearHistory() {
  state.history.past.length = 0;
  state.history.future.length = 0;
}

function historyUndo() {
  if (state.history.past.length === 0) return false;
  const beforeCsv = state.history.past.pop();
  const currentCsv = (typeof serializeLiveStateToCsv === "function") ? serializeLiveStateToCsv() : state.lastCsvSnapshot;
  if (currentCsv) state.history.future.push(currentCsv);
  if (state.history.future.length > HISTORY_CAP) state.history.future.shift();
  return _restoreSnapshot(beforeCsv);
}

function historyRedo() {
  if (state.history.future.length === 0) return false;
  const afterCsv = state.history.future.pop();
  const currentCsv = (typeof serializeLiveStateToCsv === "function") ? serializeLiveStateToCsv() : state.lastCsvSnapshot;
  if (currentCsv) state.history.past.push(currentCsv);
  if (state.history.past.length > HISTORY_CAP) state.history.past.shift();
  return _restoreSnapshot(afterCsv);
}

// ───── "What changed?" highlight on undo/redo ─────────────────────────────
// History entries are full-state snapshots with no per-element command data, so
// we figure out which elements an undo/redo touched by diffing the live state
// captured just before the restore against the restored state. The diff drives
// a brief pulse on the affected nodes/edges and a recenter when they're off
// screen, so the user can see exactly what the operation changed.

// Per-element content signatures of the LIVE state, keyed by id. Reuses the
// existing clone helpers (04-utils.js) so the signature tracks the same fields
// the undo machinery already considers meaningful. edgeEndpoints lets us find a
// (possibly deleted) node's neighbours without re-parsing the JSON.
function _snapshotSignatures() {
  const nodes = {};
  for (const n of NODES) nodes[n.id] = JSON.stringify(cloneNodeForUndo(n));
  const edges = {};
  const edgeEndpoints = {};
  for (const e of EDGES) {
    edges[e.id] = JSON.stringify(cloneEdgeForUndo(e));
    edgeEndpoints[e.id] = { from: e.from, to: e.to };
  }
  return { nodes, edges, edgeEndpoints };
}

// Diff before/after signatures into the sets we flash and the ordered list of
// candidate nodes to recenter on. Only elements that still exist after the
// restore can be flashed; a removed node instead lights up its surviving
// neighbours so the user sees the region it used to occupy.
function _computeUndoFocus(before, after) {
  const flashNodeIds = new Set();
  const flashEdgeIds = new Set();
  const removedNodeIds = [];

  // Changed nodes — added / modified flash directly; removed defer to neighbours.
  for (const id of new Set([...Object.keys(before.nodes), ...Object.keys(after.nodes)])) {
    if (before.nodes[id] === after.nodes[id]) continue;
    if (after.nodes[id] !== undefined) flashNodeIds.add(id);
    else removedNodeIds.push(id);
  }

  // Changed edges — flash the edge when it survives, and pull in its present
  // endpoints so the nodes either side of the change light up too.
  for (const id of new Set([...Object.keys(before.edges), ...Object.keys(after.edges)])) {
    if (before.edges[id] === after.edges[id]) continue;
    const present = after.edges[id] !== undefined;
    if (present) flashEdgeIds.add(id);
    const ends = present ? after.edgeEndpoints[id] : before.edgeEndpoints[id];
    if (ends) {
      if (after.nodes[ends.from] !== undefined) flashNodeIds.add(ends.from);
      if (after.nodes[ends.to]   !== undefined) flashNodeIds.add(ends.to);
    }
  }

  // Surviving neighbours of removed nodes, found via the before-state edges.
  for (const removedId of removedNodeIds) {
    for (const eid of Object.keys(before.edgeEndpoints)) {
      const ends = before.edgeEndpoints[eid];
      const other = ends.from === removedId ? ends.to
                  : ends.to   === removedId ? ends.from
                  : null;
      if (other && after.nodes[other] !== undefined) flashNodeIds.add(other);
    }
  }

  return { flashNodeIds, flashEdgeIds, focusNodeIds: [...flashNodeIds] };
}

// Is the node's box currently within the visible area of the scroll container?
// Rendered pixels = layout coords × zoom (applyZoom keeps the viewBox unscaled
// and scales the SVG's width/height), and scroll offsets are in rendered px.
function _isNodeInViewport(nodeId) {
  const pos = layout.positions[nodeId];
  if (!pos) return false;
  const container = document.getElementById("viz-scroll");
  if (!container) return false;
  const zoom = state.zoomLevel || 1;
  const left = pos.x * zoom, top = pos.y * zoom;
  const right = (pos.x + pos.width) * zoom, bottom = (pos.y + pos.height) * zoom;
  const viewLeft = container.scrollLeft, viewTop = container.scrollTop;
  const viewRight = viewLeft + container.clientWidth;
  const viewBottom = viewTop + container.clientHeight;
  return right > viewLeft && left < viewRight && bottom > viewTop && top < viewBottom;
}

// Pulse the given elements, then auto-clear after the animation. A fresh undo
// resets the timer so rapid Ctrl+Z presses each get the full pulse.
let _undoFlashTimer = null;
function _flashUndoChange(nodeIds, edgeIds) {
  if (!state.canvasEdit) return;
  const hasNodes = nodeIds && nodeIds.size;
  const hasEdges = edgeIds && edgeIds.size;
  if (!hasNodes && !hasEdges) return;
  state.canvasEdit.flashedNodeIds = hasNodes ? nodeIds : null;
  state.canvasEdit.flashedEdgeIds = hasEdges ? edgeIds : null;
  if (typeof render === "function") render();
  if (_undoFlashTimer) clearTimeout(_undoFlashTimer);
  _undoFlashTimer = setTimeout(() => {
    _undoFlashTimer = null;
    if (state.canvasEdit) {
      state.canvasEdit.flashedNodeIds = null;
      state.canvasEdit.flashedEdgeIds = null;
    }
    if (typeof render === "function") render();
  }, UNDO_FLASH_DURATION_MS);
}

// Reload a snapshot via the trusted data-loader path. Preserves selection,
// edit mode, zoom, and scroll position across the round-trip so undo doesn't
// jump the user away from what they were doing.
function _restoreSnapshot(csv) {
  // Signatures of the state we're leaving — diffed against the restored state
  // below to discover which elements the undo/redo actually changed.
  const before = _snapshotSignatures();
  const saved = {
    selectedNodeId: state.selectedNodeId,
    selectedEdgeId: state.selectedEdgeId || null,
    editMode:       state.canvasEdit && state.canvasEdit.editMode,
    zoomLevel:      state.zoomLevel,
    scrollTop:      0,
    scrollLeft:     0,
  };
  const vizScrollEl = document.getElementById("viz-scroll");
  if (vizScrollEl) {
    saved.scrollTop  = vizScrollEl.scrollTop;
    saved.scrollLeft = vizScrollEl.scrollLeft;
  }

  _suspendUndoCapture = true;
  let ok = false;
  try {
    ok = loadDataFromCsv(csv);
    // loadDataFromCsv resets state.lastCsvSnapshot via the save path; keep it
    // aligned to the snapshot we just restored.
    state.lastCsvSnapshot = csv;
  } finally {
    _suspendUndoCapture = false;
  }
  if (!ok) return false;

  // Re-apply transient UI state.
  if (saved.zoomLevel && typeof applyZoom === "function") {
    state.zoomLevel = saved.zoomLevel;
    applyZoom();
  }
  if (state.canvasEdit) state.canvasEdit.editMode = !!saved.editMode;
  if (saved.selectedNodeId && nodeById[saved.selectedNodeId] && typeof selectNode === "function") {
    selectNode(saved.selectedNodeId);
  }
  if (saved.selectedEdgeId) {
    const edgeStillExists = EDGES.some(e => e.id === saved.selectedEdgeId);
    if (edgeStillExists) state.selectedEdgeId = saved.selectedEdgeId;
  }
  if (typeof renderDetailPanel === "function") renderDetailPanel();
  if (typeof render === "function") render();
  if (vizScrollEl) {
    vizScrollEl.scrollTop  = saved.scrollTop;
    vizScrollEl.scrollLeft = saved.scrollLeft;
  }

  // Highlight what this undo/redo changed: diff against the pre-restore state,
  // pulse the affected elements, and recenter only if none are already on
  // screen (scroll position was just restored above, so the check is accurate).
  const focus = _computeUndoFocus(before, _snapshotSignatures());
  if (focus.focusNodeIds.length &&
      !focus.focusNodeIds.some(_isNodeInViewport) &&
      typeof scrollNodeIntoView === "function") {
    scrollNodeIntoView(focus.focusNodeIds[0]);
  }
  _flashUndoChange(focus.flashNodeIds, focus.flashEdgeIds);
  return true;
}

// ───── Back-compat shims (existing delete call sites still call these) ────
// The actual snapshot now happens inside applyCanvasMutation, so pushUndo is
// a no-op. restoreFromUndo redirects to the new history machinery.
function pushUndo(_entry) {
  // No-op — applyCanvasMutation auto-captures the pre-mutation snapshot.
}
function restoreFromUndo(_entry) {
  historyUndo();
}

// ───── Toast UI ───────────────────────────────────────────────────────────
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
    // Prefer the explicit closure (legacy) if provided; otherwise pop history.
    if (typeof undoFn === "function") undoFn();
    else historyUndo();
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
