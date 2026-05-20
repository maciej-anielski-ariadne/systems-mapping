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

// Reload a snapshot via the trusted data-loader path. Preserves selection,
// edit mode, zoom, and scroll position across the round-trip so undo doesn't
// jump the user away from what they were doing.
function _restoreSnapshot(csv) {
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
