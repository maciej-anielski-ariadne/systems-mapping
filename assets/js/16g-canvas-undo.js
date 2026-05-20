// =============================================================================
// CANVAS UNDO — single-level snapshot stack + dismissable toast
// -----------------------------------------------------------------------------
// When the user deletes a node, edge, stream, stage, or category, we save a
// snapshot here and surface a small toast at the bottom of the screen with an
// "Undo" link. Clicking it restores the snapshot; ignoring it lets the toast
// auto-dismiss after a few seconds.
//
//   pushUndo(entry)      — store a snapshot (single-level cap: each push
//                          replaces any previous entry).
//   restoreFromUndo(e)   — re-insert the snapshot's rows into the live
//                          STREAMS / STAGES / CATEGORIES / NODES / EDGES.
//   showUndoToast(msg, fn) — show the toast with Undo wired to `fn`.
//   dismissUndoToast()   — hide the toast (called on timeout or undo click).
//
// All the actual delete entry points (deleteSelection / deleteEdgeById in
// 16e-canvas-edit.js; deleteStreamWithCascade / Stage / Category in
// 16f-canvas-mutations.js) build their own snapshot, call pushUndo + the
// mutation, then call showUndoToast with `() => restoreFromUndo(snapshot)`.
// =============================================================================

const UNDO_TOAST_DURATION_MS = 6000;

// ───── Snapshot stack (single level) ──────────────────────────────────────
function pushUndo(entry) {
  state.undoStack = [entry];   // single-level cap
}

// Restore a snapshot. Dispatches on entry.kind to handle each shape:
//   "node"     → re-add the node + its incident edges
//   "edge"     → re-add just the edge
//   "stream"   → splice the stream back in + its nodes + incident edges
//   "stage"    → same shape as stream
//   "category" → re-insert into CATEGORIES at its original position + nodes + edges
function restoreFromUndo(entry) {
  if (!entry) return;
  if (entry.kind === "node") {
    NODES.push(entry.node);
    for (const e of entry.incidentEdges) {
      // Only re-add edges whose other endpoint still exists. If the user
      // deleted-then-deleted again on a connected node, that incident edge
      // is gone.
      EDGES.push(cloneEdgeForUndo(e));
    }
    applyCanvasMutation();
    selectNode(entry.node.id);
  } else if (entry.kind === "edge") {
    EDGES.push(entry.edge);
    applyCanvasMutation();
  } else if (entry.kind === "stream") {
    const idx = Math.min(Math.max(entry.streamIndex, 0), STREAMS.length);
    STREAMS.splice(idx, 0, Object.assign({}, entry.stream));
    for (const n of entry.nodes) NODES.push(cloneNodeForUndo(n));
    for (const e of entry.edges) EDGES.push(cloneEdgeForUndo(e));
    applyCanvasMutation();
  } else if (entry.kind === "stage") {
    const idx = Math.min(Math.max(entry.stageIndex, 0), STAGES.length);
    STAGES.splice(idx, 0, { id: entry.stage.id, label: entry.stage.label });
    for (const n of entry.nodes) NODES.push(cloneNodeForUndo(n));
    for (const e of entry.edges) EDGES.push(cloneEdgeForUndo(e));
    applyCanvasMutation();
  } else if (entry.kind === "category") {
    // Re-insert the deleted category at its original index by rebuilding
    // CATEGORIES in the right order. Insertion order is the only "index"
    // categories have.
    const ids = Object.keys(CATEGORIES);
    const idx = Math.min(Math.max(entry.catIndex, 0), ids.length);
    ids.splice(idx, 0, entry.catId);
    const rebuilt = {};
    for (const id of ids) {
      rebuilt[id] = (id === entry.catId) ? Object.assign({}, entry.cat) : CATEGORIES[id];
    }
    CATEGORIES = rebuilt;
    for (const n of entry.nodes) NODES.push(cloneNodeForUndo(n));
    for (const e of entry.edges) EDGES.push(cloneEdgeForUndo(e));
    applyCanvasMutation();
  }
  state.undoStack = [];
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
