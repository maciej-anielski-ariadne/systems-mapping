// =============================================================================
// CANVAS INLINE RENAME — type-on-node to rename, no text box
// -----------------------------------------------------------------------------
// When a node is selected on the canvas and the user starts typing (without
// any input focused), keystrokes flow directly into the node's label. The
// node visibly updates on the canvas (and the detail panel) on every key.
// There is no edit-overlay textbox — the canvas itself is the input.
//
// Lifecycle (held in `state.canvasEdit.inlineRename`):
//
//   { nodeId, originalLabel, started } | null
//
//     null     — not renaming. A printable key on the selected node starts a
//                rename, or createNodeInCell() pre-arms one for a fresh node.
//     started  — `node.label` is being mutated in place. `originalLabel` is
//                the pre-rename value so Esc can revert.
//                `started` flips on the first character; gates first-keystroke
//                "replace" behaviour (matches Finder/Explorer where the
//                existing name is implicitly pre-selected).
//
// Commit triggers (each is its own entry point — see below):
//   • Enter                                    — handled in 16e keydown
//   • selectNode / deselectNode / deselectAll  — hook in 09-graph-selection.js
//   • focus moves into a real <input>/etc.    — focusin listener registered here
//   • the start of createNodeInCell           — call sites that mutate before
//                                                applyCanvasMutation need to
//                                                flush so the rename gets its
//                                                own history entry
//
// Revert: Escape (also handled in 16e keydown).
//
// History semantics:
//   The rename does NOT call applyCanvasMutation on each keystroke — that
//   would push one snapshot per character. Instead it mutates node.label in
//   place and re-renders. On commit a single applyCanvasMutation runs;
//   `state.lastCsvSnapshot` is still the pre-rename CSV (nothing else has
//   chokepointed in between), so the snapshot pushed onto history.past is
//   the pre-rename state. One undo rewinds the whole rename.
// =============================================================================

import { state, nodeById, setLayout } from "./03-state";
import { applyCanvasMutation } from "./16f-canvas-mutations";
import { computeLayout } from "./08-layout";
import { render } from "./11-rendering";
import { renderDetailPanel } from "./15-detail-panel";

// True if Backspace / Delete on the canvas should edit the label instead of
// deleting the node. Used by 16e's keydown handler.
export function isInlineRenameActive(): boolean {
  return !!(state.canvasEdit && state.canvasEdit.inlineRename);
}

// Lazy-start the rename on the first printable keystroke (or pre-arm from
// createNodeInCell). Captures the current label so Escape can put it back.
export function startInlineRename(nodeId: string): void {
  if (!state.canvasEdit) return;
  const node = nodeById[nodeId];
  if (!node) return;
  state.canvasEdit.inlineRename = {
    nodeId: nodeId,
    originalLabel: node.label || "",
    started: false,
  };
}

// Append a single typed character to the label. The first character
// REPLACES the existing label (Finder/Explorer convention — feels like the
// existing name was pre-selected). Subsequent characters extend.
export function inlineRenameAppend(char: string): void {
  if (!state.canvasEdit || !state.canvasEdit.inlineRename) return;
  const ir = state.canvasEdit.inlineRename;
  const node = nodeById[ir.nodeId];
  if (!node) {
    state.canvasEdit.inlineRename = null;
    return;
  }
  if (!ir.started) {
    node.label = char;
    ir.started = true;
  } else {
    node.label = (node.label || "") + char;
  }
  refreshAfterInlineRenameKey();
}

// Backspace: pop one character. The first Backspace on an unstarted rename
// wipes the original label (same mental model as the first printable char).
// While the rename is active, this path is reached from 16e's keydown
// instead of the node-delete path — so the user can edit without nuking
// the node.
export function inlineRenameBackspace(): void {
  if (!state.canvasEdit || !state.canvasEdit.inlineRename) return;
  const ir = state.canvasEdit.inlineRename;
  const node = nodeById[ir.nodeId];
  if (!node) {
    state.canvasEdit.inlineRename = null;
    return;
  }
  if (!ir.started) {
    node.label = "";
    ir.started = true;
  } else {
    node.label = (node.label || "").slice(0, -1);
  }
  refreshAfterInlineRenameKey();
}

// Commit: normalise the label (trim, fall back to "Untitled" when empty —
// mirrors applyNodeFieldEdit in 15-detail-panel.js), then route through
// applyCanvasMutation so the pre-rename snapshot lands on history exactly
// once.
//
// `options` is forwarded to applyCanvasMutation — pass `{ skipDetailRender:
// true }` from paths where re-rendering the detail panel would yank focus
// from a freshly-clicked input (see the focusin listener below).
export function commitInlineRename(options?: { skipDetailRender?: boolean }): boolean {
  if (!state.canvasEdit || !state.canvasEdit.inlineRename) return false;
  const ir = state.canvasEdit.inlineRename;
  state.canvasEdit.inlineRename = null;       // cleared FIRST so a re-entrant
                                              // applyCanvasMutation doesn't loop
  const node = nodeById[ir.nodeId];
  if (!node) return false;
  // No characters were ever typed — treat as a no-op so "select then click
  // away" doesn't pollute history with a snapshot that didn't change anything.
  if (!ir.started) return false;
  const trimmed = String(node.label || "").trim();
  node.label = trimmed || "Untitled";
  if (typeof applyCanvasMutation === "function") {
    applyCanvasMutation(options || {});
  }
  return true;
}

// Revert: put the original label back, clear state, re-render. Does NOT
// push a history entry — from the outside nothing changed.
export function revertInlineRename(): boolean {
  if (!state.canvasEdit || !state.canvasEdit.inlineRename) return false;
  const ir = state.canvasEdit.inlineRename;
  state.canvasEdit.inlineRename = null;
  const node = nodeById[ir.nodeId];
  if (node) node.label = ir.originalLabel;
  refreshAfterInlineRenameKey();
  return true;
}

// Internal — repaint the canvas + detail panel so the live label change shows
// up. We recompute layout first: under grow-to-fit the wrapped lines and box
// height are baked into layout.positions by computeLayout, so without this the
// canvas would keep drawing the stale label (and stale height) until commit.
// Cheap per-keystroke — measureLabelLines is cached by text, so only the one
// renamed node re-measures; every other node is a cache hit.
export function refreshAfterInlineRenameKey(): void {
  if (typeof computeLayout === "function") setLayout(computeLayout());
  if (typeof render === "function") render();
  if (typeof renderDetailPanel === "function") renderDetailPanel();
}

// Decide whether a keydown is a printable character we should route into the
// rename. Filters Ctrl/Cmd/Alt so shortcuts still work; Shift is fine (it's
// just capitalisation).
export function isPrintableTypingKey(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  if (typeof event.key !== "string") return false;
  if (event.key.length !== 1) return false;       // filters Enter, Tab, F-keys, arrows, etc.
  return true;
}

// Wired from initCanvasEdit(). Adds the focusin listener that flushes the
// rename when the user clicks into a real form field — without that, the
// rename would still be "live" while they typed into the detail panel and
// pressing Esc later would revert their input. We pass skipDetailRender so
// the field they just clicked into isn't destroyed by the panel re-render.
export function initCanvasInlineRename(): void {
  document.addEventListener("focusin", event => {
    if (!isInlineRenameActive()) return;
    const t = event.target as HTMLElement | null;
    if (!t || !t.matches) return;
    if (!t.matches("input, textarea, select, [contenteditable]")) return;
    commitInlineRename({ skipDetailRender: true });
  });
}
