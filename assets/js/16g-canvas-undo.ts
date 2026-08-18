// =============================================================================
// CANVAS UNDO — multi-level undo/redo via full-CSV snapshots + soft delete toast
// -----------------------------------------------------------------------------
// Two layers, one storage:
//
//   • Multi-level undo/redo. Before each edit we take a "snapshot" — a complete
//     copy of the whole map saved as CSV text (see "undo snapshot" in
//     docs/GLOSSARY.md). Every call to applyCanvasMutation (16f) pushes the prior
//     state's snapshot onto state.history.past; Undo restores by feeding the most
//     recent snapshot back through loadDataFromCsv. Keeping a stack of snapshots
//     is what allows undoing many steps in a row. Triggered by Ctrl/Cmd+Z and
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

import { cloneEdgeForUndo, cloneNodeForUndo } from "./04-utils";
import { loadDataFromCsv } from "./06-data-loader";
import { serializeLiveStateToCsv } from "./05a-csv-serializer";
import { scrollNodeIntoView, selectNode } from "./09-graph-selection";
import { render } from "./11-rendering";
import { renderDetailPanel } from "./15-detail-panel";
import { applyZoom } from "./17-events";
import { EDGES, NODES, layout, nodeById, edgeById, state } from "./03-state";

export const UNDO_TOAST_DURATION_MS = 6000;
export const HISTORY_CAP = 50;
// Total UTF-16 units allowed across past + future COMBINED. A snapshot is the
// whole map serialized to CSV, so on a 5000-box map each one runs to megabytes
// and a plain 50-deep stack (plus 50 redo entries) would retain hundreds of
// megabytes for the lifetime of the tab. The budget caps retained characters
// rather than entries: a small map still gets the full 50 steps, a huge one
// gets however many fit. Both limits apply — the effective depth is whichever
// bites first.
export const HISTORY_CHAR_BUDGET = 24_000_000;
// Above this many live elements the "what changed?" diff behind the undo flash
// is skipped entirely — see _shouldDiffUndo().
export const UNDO_DIFF_MAX_ELEMENTS = 2000;
// How long the pulse on undone/redone elements stays up before auto-clearing.
// Matches the edge-click flash (06-detail-panel.css) so the two feel of a piece.
export const UNDO_FLASH_DURATION_MS = 1400;

// Flag set while restoring so the auto-capture in applyCanvasMutation doesn't
// fire and double-snapshot the round-trip.
export let _suspendUndoCapture = false;
export function isUndoCaptureSuspended(): boolean { return _suspendUndoCapture; }

// ───── Multi-level history ────────────────────────────────────────────────
export function clearHistory(): void {
  state.history.past.length = 0;
  state.history.future.length = 0;
}

// Total characters currently retained by both stacks.
export function historyCharCount(): number {
  let total = 0;
  for (const csv of state.history.past)   total += csv.length;
  for (const csv of state.history.future) total += csv.length;
  return total;
}

// Trim both stacks back inside HISTORY_CAP and HISTORY_CHAR_BUDGET. Oldest
// past entries go first — the deepest undo steps are the least likely to be
// reached — then oldest future ones. Each stack always keeps its newest entry,
// so a single snapshot larger than the whole budget still leaves one undo (and
// one redo) working rather than silently disabling the feature.
//
// Called after every push, from the one push helper below and from
// historyUndo / historyRedo. Nothing else should touch state.history directly.
export function _enforceHistoryLimits(): void {
  const past   = state.history.past;
  const future = state.history.future;
  while (past.length   > HISTORY_CAP) past.shift();
  while (future.length > HISTORY_CAP) future.shift();
  let total = historyCharCount();
  while (total > HISTORY_CHAR_BUDGET && past.length   > 1) total -= past.shift()!.length;
  while (total > HISTORY_CHAR_BUDGET && future.length > 1) total -= future.shift()!.length;
}

// The single "an edit is about to happen" push site: stack the PREVIOUS state's
// CSV as the thing Undo returns to, and drop the redo branch (a fresh edit
// invalidates it). applyCanvasMutation (16f) calls this instead of inlining the
// stack bookkeeping, so the size budget is enforced everywhere by construction.
export function pushHistorySnapshot(csv: string | null | undefined): void {
  if (!csv) return;
  state.history.past.push(csv);
  state.history.future.length = 0;
  _enforceHistoryLimits();
}

export function historyUndo(): boolean {
  if (state.history.past.length === 0) return false;
  const beforeCsv = state.history.past.pop();
  const currentCsv = (typeof serializeLiveStateToCsv === "function") ? serializeLiveStateToCsv(null, { compact: true }) : state.lastCsvSnapshot;
  if (currentCsv) state.history.future.push(currentCsv);
  _enforceHistoryLimits();
  return _restoreSnapshot(beforeCsv!);
}

export function historyRedo(): boolean {
  if (state.history.future.length === 0) return false;
  const afterCsv = state.history.future.pop();
  const currentCsv = (typeof serializeLiveStateToCsv === "function") ? serializeLiveStateToCsv(null, { compact: true }) : state.lastCsvSnapshot;
  if (currentCsv) state.history.past.push(currentCsv);
  _enforceHistoryLimits();
  return _restoreSnapshot(afterCsv!);
}

// ───── "What changed?" highlight on undo/redo ─────────────────────────────
// History entries are full-state snapshots with no per-element command data, so
// we figure out which elements an undo/redo touched by diffing the live state
// captured just before the restore against the restored state. The diff drives
// a brief pulse on the affected nodes/edges and a recenter when they're off
// screen, so the user can see exactly what the operation changed.

export interface SnapshotSignatures {
  nodes: Record<string, string>;
  edges: Record<string, string>;
  edgeEndpoints: Record<string, { from: string; to: string }>;
}

export interface UndoFocus {
  flashNodeIds: Set<string>;
  flashEdgeIds: Set<string>;
  focusNodeIds: string[];
}

// Is the map small enough to be worth diffing? _snapshotSignatures runs a
// JSON.stringify per node and per edge, and _restoreSnapshot calls it twice —
// so on a 5000-box / 20000-link map an undo pays ~50k stringifies purely to
// decide which elements pulse for 1.4 seconds. Above the threshold we skip the
// diff outright: no flash, no recenter scan. The map visibly changing under the
// user IS the feedback at that size, and the restore itself stays responsive.
// At or below it, behaviour is byte-for-byte what it has always been.
export function _shouldDiffUndo(): boolean {
  return NODES.length + EDGES.length <= UNDO_DIFF_MAX_ELEMENTS;
}

// Per-element content signatures of the LIVE state, keyed by id. Reuses the
// existing clone helpers (04-utils.js) so the signature tracks the same fields
// the undo machinery already considers meaningful. edgeEndpoints lets us find a
// (possibly deleted) node's neighbours without re-parsing the JSON.
export function _snapshotSignatures(): SnapshotSignatures {
  const nodes: Record<string, string> = {};
  for (const n of NODES) nodes[n.id] = JSON.stringify(cloneNodeForUndo(n));
  const edges: Record<string, string> = {};
  const edgeEndpoints: Record<string, { from: string; to: string }> = {};
  for (const e of EDGES) {
    edges[e.id!] = JSON.stringify(cloneEdgeForUndo(e));
    edgeEndpoints[e.id!] = { from: e.from, to: e.to };
  }
  return { nodes, edges, edgeEndpoints };
}

// Diff before/after signatures into the sets we flash and the ordered list of
// candidate nodes to recenter on. Only elements that still exist after the
// restore can be flashed; a removed node instead lights up its surviving
// neighbours so the user sees the region it used to occupy.
export function _computeUndoFocus(before: SnapshotSignatures, after: SnapshotSignatures): UndoFocus {
  const flashNodeIds = new Set<string>();
  const flashEdgeIds = new Set<string>();
  const removedNodeIds: string[] = [];

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
  if (removedNodeIds.length) {
    const removed = new Set(removedNodeIds);
    for (const eid of Object.keys(before.edgeEndpoints)) {
      const ends = before.edgeEndpoints[eid];
      const fromRemoved = removed.has(ends.from);
      if (fromRemoved === removed.has(ends.to)) continue; // both or neither removed
      const other = fromRemoved ? ends.to : ends.from;
      if (after.nodes[other] !== undefined) flashNodeIds.add(other);
    }
  }

  return { flashNodeIds, flashEdgeIds, focusNodeIds: [...flashNodeIds] };
}

// Is the node's box currently within the visible area of the scroll container?
// Rendered pixels = layout coords × zoom (applyZoom keeps the viewBox unscaled
// and scales the SVG's width/height), and scroll offsets are in rendered px.
export function _isNodeInViewport(nodeId: string): boolean {
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
export let _undoFlashTimer: ReturnType<typeof setTimeout> | null = null;
export function _flashUndoChange(nodeIds: Set<string> | null, edgeIds: Set<string> | null): void {
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
export function _restoreSnapshot(csv: string): boolean {
  // Signatures of the state we're leaving — diffed against the restored state
  // below to discover which elements the undo/redo actually changed. Skipped
  // wholesale on a big map (see _shouldDiffUndo).
  const before = _shouldDiffUndo() ? _snapshotSignatures() : null;
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
  if (saved.selectedEdgeId && edgeById[saved.selectedEdgeId]) {
    state.selectedEdgeId = saved.selectedEdgeId;
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
  // `before` is null — and the restored map is re-checked — when either side of
  // the round-trip is too big to diff cheaply; then the restore stands on its
  // own with no flash and no recenter scan.
  if (before && _shouldDiffUndo()) {
    const focus = _computeUndoFocus(before, _snapshotSignatures());
    if (focus.focusNodeIds.length &&
        !focus.focusNodeIds.some(_isNodeInViewport) &&
        typeof scrollNodeIntoView === "function") {
      scrollNodeIntoView(focus.focusNodeIds[0]);
    }
    _flashUndoChange(focus.flashNodeIds, focus.flashEdgeIds);
  }
  return true;
}

// ───── Back-compat shims (existing delete call sites still call these) ────
// The actual snapshot now happens inside applyCanvasMutation, so pushUndo is
// a no-op. restoreFromUndo redirects to the new history machinery.
export function pushUndo(_entry?: unknown): void {
  // No-op — applyCanvasMutation auto-captures the pre-mutation snapshot.
}
export function restoreFromUndo(_entry?: unknown): void {
  historyUndo();
}

// ───── Toast UI ───────────────────────────────────────────────────────────
export function ensureUndoToastEl(): void {
  if (document.getElementById("canvas-undo-toast")) return;
  const el = document.createElement("div");
  el.id = "canvas-undo-toast";
  el.className = "undo-toast";
  el.style.display = "none";
  el.innerHTML = '<span class="undo-toast-msg"></span><button class="undo-link">Undo</button>';
  document.body.appendChild(el);
}

export function showUndoToast(message: string, undoFn?: () => void): void {
  ensureUndoToastEl();
  const el = document.getElementById("canvas-undo-toast");
  if (!el) return;
  el.querySelector(".undo-toast-msg")!.textContent = message;
  el.style.display = "flex";

  const undoBtn = el.querySelector(".undo-link") as HTMLButtonElement;
  // Clone-and-replace to drop any previous click handler.
  const freshBtn = undoBtn.cloneNode(true) as HTMLButtonElement;
  undoBtn.parentNode!.replaceChild(freshBtn, undoBtn);
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
  const timerId = setTimeout(dismissUndoToast, UNDO_TOAST_DURATION_MS) as unknown as number;
  state.canvasEdit.toast = { message: message, undoFn: undoFn, timerId: timerId };
}

export function dismissUndoToast(): void {
  const el = document.getElementById("canvas-undo-toast");
  if (el) el.style.display = "none";
  if (state.canvasEdit.toast && state.canvasEdit.toast.timerId) {
    clearTimeout(state.canvasEdit.toast.timerId);
  }
  state.canvasEdit.toast = null;
}
