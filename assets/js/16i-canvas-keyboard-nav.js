// =============================================================================
// CANVAS KEYBOARD NAVIGATION — arrows / Tab / Enter / Shift+E
// -----------------------------------------------------------------------------
// Keyboard-driven node selection and creation on the canvas:
//
//   • Arrow keys   — move a cursor slot-by-slot. Each stream has as many
//                    navigable slots as its busiest cell (min 1). Slots that
//                    don't correspond to a real node are empty placeholders;
//                    typing there creates a node.
//
//   • Tab          — move to the next stage (same stream, same slot). Creates
//                    a node in the destination slot if one doesn't exist.
//   • Shift-Tab    — symmetric for the previous stage.
//
//   • Enter (no    — create a new node stacked at the bottom of the current
//      rename       cell. Commits any pending inline rename first so the
//      active)      rename and the create each get their own undo step.
//
//   • Shift+E      — open a floating typeable dropdown listing every other
//                    node. Typing filters; Enter picks the top match and
//                    creates an "increases" edge from the selected node.
//
// Position model — three coordinates, NOT two:
//
//   { streamId, stageId, slotIndex }
//
// Streams have a `streamRowCount` equal to their busiest cell (across all
// stages). Inside a stream every column has that many slots, even if its own
// cell has fewer nodes — the empty slots are navigable so the cursor never
// "skips" rows when moving up/down within a multi-node stream.
//
// The cursor is whichever is set, priority order:
//   1. state.selectedNodeId — slotIndex derived from the node's position in
//                             its (stream, stage) cell.
//   2. state.canvasEdit.cursorCell { streamId, stageId, slotIndex } — a slot
//                             with no node behind it; rendered as a "Type to
//                             create a node" placeholder.
//   3. nothing — first arrow press lands on (firstStream, firstStage, 0).
// =============================================================================

// How many navigable slots does a stream have? The max number of nodes in any
// of its cells, or 1 when every cell is empty (so an empty stream still has
// one row the cursor can land on).
function streamRowCount(streamId) {
  let max = 0;
  for (const stage of STAGES) {
    let count = 0;
    for (const n of NODES) {
      if (n.stream === streamId && n.stage === stage.id) count++;
    }
    if (count > max) max = count;
  }
  return Math.max(1, max);
}

// The slot index of `node` within its (stream, stage) cell, or 0 if unknown.
function slotIndexOfNode(node) {
  let idx = 0;
  for (const n of NODES) {
    if (n.stream !== node.stream || n.stage !== node.stage) continue;
    if (n.id === node.id) return idx;
    idx++;
  }
  return 0;
}

// Resolve the user's current "position" on the grid.
//   { streamId, stageId, slotIndex, nodeId? } | null
function getCanvasCursorPosition() {
  if (state.selectedNodeId) {
    const n = nodeById[state.selectedNodeId];
    if (n) return { streamId: n.stream, stageId: n.stage, slotIndex: slotIndexOfNode(n), nodeId: n.id };
  }
  if (state.canvasEdit && state.canvasEdit.cursorCell) {
    const c = state.canvasEdit.cursorCell;
    return {
      streamId: c.streamId,
      stageId:  c.stageId,
      slotIndex: c.slotIndex || 0,
      nodeId:   null,
    };
  }
  return null;
}

// Move the cursor onto (streamId, stageId, slotIndex). If the slot is filled
// by a real node, select it; otherwise park an empty-cell placeholder there.
// Clamps slotIndex to [0, streamRowCount-1].
function moveCursorToSlot(streamId, stageId, slotIndex) {
  if (!streamById[streamId] || !stageById[stageId]) return;
  const rowCount = streamRowCount(streamId);
  const slot = Math.max(0, Math.min(rowCount - 1, slotIndex | 0));
  const cellNodes = NODES.filter(n => n.stream === streamId && n.stage === stageId);
  if (slot < cellNodes.length) {
    if (state.canvasEdit) state.canvasEdit.cursorCell = null;
    selectNode(cellNodes[slot].id);
    if (typeof scrollNodeIntoView === "function") scrollNodeIntoView(cellNodes[slot].id);
  } else {
    // Empty slot — clear any node selection (commits any pending rename via
    // the deselectAll → commitInlineRename hook), then park the cursor at
    // exactly this slot so the placeholder renders in the right vertical
    // position within the cell.
    if (state.selectedNodeId) deselectAll();
    state.canvasEdit.cursorCell = { streamId: streamId, stageId: stageId, slotIndex: slot };
    render();
    scrollCellIntoView(streamId, stageId, slot);
  }
}

// Backwards-compatible alias — callers that don't care about the slot can
// still ask for "the first slot of this cell".
function moveCursorToCell(streamId, stageId) {
  moveCursorToSlot(streamId, stageId, 0);
}

// Bring an empty cursor slot into view. The placeholder has no permanent DOM
// node we can scrollIntoView, so we compute its rect from the layout and
// nudge the scroll container if it's off-screen.
function scrollCellIntoView(streamId, stageId, slotIndex) {
  const scrollEl = document.getElementById("viz-scroll");
  if (!scrollEl || !layout.colX || !layout.rowY) return;
  const x = layout.colX[stageId];
  const y = layout.rowY[streamId];
  if (x === undefined || y === undefined) return;
  const slot = slotIndex || 0;
  const zoom = (state.zoomLevel && !isNaN(state.zoomLevel)) ? state.zoomLevel : 1.0;
  const slotTop    = (y + ROW_PADDING + slot * (NODE_HEIGHT + NODE_GAP_Y)) * zoom;
  const slotBottom = slotTop + NODE_HEIGHT * zoom;
  const cellLeft   = x * zoom;
  const cellRight  = cellLeft + NODE_WIDTH  * zoom;
  const viewLeft   = scrollEl.scrollLeft;
  const viewTop    = scrollEl.scrollTop;
  const viewRight  = viewLeft + scrollEl.clientWidth;
  const viewBottom = viewTop  + scrollEl.clientHeight;
  const margin = 40;
  if (cellLeft  < viewLeft  + margin) scrollEl.scrollLeft = Math.max(0, cellLeft - margin);
  if (cellRight > viewRight - margin) scrollEl.scrollLeft = cellRight  - scrollEl.clientWidth + margin;
  if (slotTop    < viewTop    + margin) scrollEl.scrollTop = Math.max(0, slotTop - margin);
  if (slotBottom > viewBottom - margin) scrollEl.scrollTop = slotBottom - scrollEl.clientHeight + margin;
}

function streamIndexFor(streamId) { return STREAMS.findIndex(s => s.id === streamId); }
function stageIndexFor (stageId)  { return STAGES.findIndex (s => s.id === stageId);  }

// Move the cursor by (dStream, dStage). Internally walks slot-by-slot so
// stacked nodes within a stream are visited in order before crossing into
// the next stream. dStream != 0 → slot increments wrap into stream changes;
// dStage != 0 → stay in the same stream, change stage, keep the slot.
function moveCanvasCursor(dStream, dStage) {
  if (STREAMS.length === 0 || STAGES.length === 0) return false;
  const pos = getCanvasCursorPosition();
  if (!pos) {
    moveCursorToSlot(STREAMS[0].id, STAGES[0].id, 0);
    return true;
  }
  const sIdx = streamIndexFor(pos.streamId);
  const cIdx = stageIndexFor(pos.stageId);
  if (sIdx < 0 || cIdx < 0) return false;

  if (dStage !== 0) {
    const newCIdx = Math.max(0, Math.min(STAGES.length - 1, cIdx + dStage));
    if (newCIdx === cIdx) return false;
    moveCursorToSlot(pos.streamId, STAGES[newCIdx].id, pos.slotIndex);
    return true;
  }

  if (dStream !== 0) {
    let streamIdx = sIdx;
    let slotIdx   = pos.slotIndex;
    const rowCount = streamRowCount(STREAMS[streamIdx].id);
    if (dStream > 0) {
      // Down: walk one slot. If we'd fall off the bottom of this stream,
      // jump to slot 0 of the next stream.
      if (slotIdx + 1 < rowCount) {
        slotIdx += 1;
      } else {
        if (streamIdx + 1 >= STREAMS.length) return false;       // bottom-right of grid
        streamIdx += 1;
        slotIdx = 0;
      }
    } else {
      // Up: walk one slot backwards. If we'd fall off the top, jump to the
      // bottom slot of the previous stream.
      if (slotIdx - 1 >= 0) {
        slotIdx -= 1;
      } else {
        if (streamIdx - 1 < 0) return false;
        streamIdx -= 1;
        slotIdx = streamRowCount(STREAMS[streamIdx].id) - 1;
      }
    }
    moveCursorToSlot(STREAMS[streamIdx].id, pos.stageId, slotIdx);
    return true;
  }
  return false;
}

// Printable key on an empty cursor cell — create a node there and seed the
// inline rename with the typed character. createNodeInCell pre-arms a fresh
// rename via startInlineRename, so we just feed the char in.
function createNodeAtCursorWithChar(firstChar) {
  const pos = getCanvasCursorPosition();
  if (!pos || pos.nodeId) return false;
  if (typeof createNodeInCell !== "function") return false;
  if (state.canvasEdit) state.canvasEdit.cursorCell = null;
  createNodeInCell(pos.streamId, pos.stageId);
  if (firstChar && typeof inlineRenameAppend === "function") {
    inlineRenameAppend(firstChar);
  }
  return true;
}

// Tab / Shift-Tab — horizontal step, slot preserved. If the destination
// slot has a node, select it; otherwise create a new node in the cell. The
// new node is appended to NODES and therefore lands at the bottom of its
// cell — createNodeInCell selects it, so the cursor follows the node.
function handleCanvasTab(direction) {
  const pos = getCanvasCursorPosition();
  if (!pos) return false;
  const cIdx = stageIndexFor(pos.stageId);
  if (cIdx < 0) return false;
  const targetCIdx = direction === "next" ? cIdx + 1 : cIdx - 1;
  if (targetCIdx < 0 || targetCIdx >= STAGES.length) return false;
  const targetStage = STAGES[targetCIdx];
  const cellNodes = NODES.filter(n => n.stream === pos.streamId && n.stage === targetStage.id);
  if (typeof commitInlineRename === "function") commitInlineRename();
  if (pos.slotIndex < cellNodes.length) {
    selectNode(cellNodes[pos.slotIndex].id);
    if (typeof scrollNodeIntoView === "function") scrollNodeIntoView(cellNodes[pos.slotIndex].id);
  } else {
    if (state.canvasEdit) state.canvasEdit.cursorCell = null;
    createNodeInCell(pos.streamId, targetStage.id);
  }
  return true;
}

// Enter (no inline rename active) — create a node below the selected one,
// stacked in the same (stream, stage) cell. For an empty cursor cell, just
// create a node in that cell.
function handleCanvasEnterCreate() {
  const pos = getCanvasCursorPosition();
  if (!pos) return false;
  if (typeof commitInlineRename === "function") commitInlineRename();
  if (state.canvasEdit) state.canvasEdit.cursorCell = null;
  createNodeInCell(pos.streamId, pos.stageId);
  return true;
}

// =============================================================================
// SHIFT+E — Add outgoing edge picker
// =============================================================================
//
// Floating overlay anchored to the source node's right edge. Re-uses the
// typeable dropdown widget (04b) by injecting a real <select> populated with
// every other node and calling upgradeSelectsIn(). The picker dispatches a
// `change` event on that select when the user picks; we listen, create the
// edge, and tear down.

function openCanvasEdgePicker(fromNodeId) {
  if (!nodeById[fromNodeId]) return;
  closeCanvasEdgePicker();

  // Exclude nodes the source already has an outgoing edge to — the workflow
  // for changing an existing edge's effect is the arrow-key cycle, not adding
  // a second parallel edge.
  const connectedTargetIds = new Set((outgoingEdges[fromNodeId] || []).map(e => e.to));
  const candidates = NODES.filter(n => n.id !== fromNodeId && !connectedTargetIds.has(n.id));
  // If no other nodes exist at all (single-node map) — silent close, matches
  // the original behaviour. If other nodes exist but every one is already
  // connected we still open the overlay with an explanatory message and
  // dismiss handlers, so the user gets feedback instead of a no-op keystroke.
  const hasAnyOtherNode = NODES.some(n => n.id !== fromNodeId);
  if (candidates.length === 0 && !hasAnyOtherNode) return;

  const overlay = document.createElement("div");
  overlay.className = "canvas-edge-picker";
  if (candidates.length === 0) {
    overlay.innerHTML =
      '<div class="canvas-edge-picker-label">All other nodes are already connected.</div>';
  } else {
    overlay.innerHTML =
      '<div class="canvas-edge-picker-label">Add outgoing edge to…</div>' +
      '<select aria-label="Choose target node">' +
        candidates.map(n =>
          '<option value="' + escapeHtml(n.id) + '">' + escapeHtml(n.label) + '</option>'
        ).join("") +
      '</select>';
  }

  // Position to the right of the source node's right edge — same anchor the
  // mouse-driven effect picker uses. Falls back to viewport-centre if the
  // node group isn't rendered yet.
  document.body.appendChild(overlay);
  positionEdgePicker(overlay, fromNodeId);

  // Upgrade the freshly-injected <select> into a typeable dropdown.
  if (typeof upgradeSelectsIn === "function") upgradeSelectsIn(overlay);

  const nativeSelect = overlay.querySelector("select");
  const typableInput = overlay.querySelector(".typeable-dropdown-input");
  // Force the select to a sentinel value so picking ANY real option fires
  // a `change` event — the typeable widget's commitItem short-circuits when
  // the chosen value already matches the select's current value, which
  // would otherwise leave us never notified of the first pick.
  if (nativeSelect) {
    nativeSelect.value = "__canvas_edge_picker_unset__";
    if (typableInput) typableInput.value = "";
  }

  const onChange = () => {
    const toId = nativeSelect.value;
    if (toId && nodeById[toId] && typeof commitNewEdge === "function") {
      const effect = (state.canvasEdit && state.canvasEdit.lastUsedEdgeEffect) || "enables";
      const newEdge = commitNewEdge(fromNodeId, toId, effect);
      closeCanvasEdgePicker();
      // Auto-select so arrow keys (16e keydown handler) cycle the effect.
      if (newEdge && newEdge.id && typeof selectEdge === "function") selectEdge(newEdge.id);
      return;
    }
    closeCanvasEdgePicker();
  };
  if (nativeSelect) nativeSelect.addEventListener("change", onChange);

  // Esc → cancel without creating an edge. Capture phase so we run BEFORE
  // the typeable widget's own Escape handler (which only closes its popup
  // and stops propagation — without this we'd need two Escs to dismiss the
  // picker entirely).
  const onDocKey = (event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    event.preventDefault();
    closeCanvasEdgePicker();
  };
  document.addEventListener("keydown", onDocKey, true);

  const onOutsideMouseDown = (event) => {
    if (overlay.contains(event.target)) return;
    // The typeable dropdown's popup is a child of the wrapper (which is
    // inside the overlay), so it's already covered by the contains() check.
    closeCanvasEdgePicker();
  };
  // Microtask so the click that opened us doesn't immediately close it.
  queueMicrotask(() => document.addEventListener("mousedown", onOutsideMouseDown, true));

  state.canvasEdit.edgePicker = {
    overlay: overlay,
    fromNodeId: fromNodeId,
    closeOutsideHandler: onOutsideMouseDown,
    closeKeyHandler: onDocKey,
  };

  // Focus the typable input — its own focus handler opens the option popup.
  // requestAnimationFrame so the layout has settled and the typeable widget's
  // popup positions correctly.
  requestAnimationFrame(() => {
    if (typableInput) typableInput.focus();
  });
}

function positionEdgePicker(overlay, fromNodeId) {
  const nodeGroup = document.querySelector('.node-group[data-node-id="' + cssEscapeForCanvas(fromNodeId) + '"]');
  if (!nodeGroup) {
    overlay.style.left = "50%";
    overlay.style.top  = "50%";
    overlay.style.transform = "translate(-50%, -50%)";
    return;
  }
  const r = nodeGroup.getBoundingClientRect();
  const margin = 12;
  // Default: anchor to the right edge, vertically aligned with the node.
  let left = r.right + margin;
  let top  = r.top;
  // If we'd run off the right edge of the viewport, drop the overlay below
  // the node instead.
  const overlayWidth  = 280;
  const overlayHeight = 80;          // approx for the off-screen check
  if (left + overlayWidth > window.innerWidth - 8) {
    left = Math.max(8, r.left);
    top  = r.bottom + margin;
  }
  if (top + overlayHeight > window.innerHeight - 8) {
    top = Math.max(8, window.innerHeight - overlayHeight - 8);
  }
  overlay.style.left = left + "px";
  overlay.style.top  = top  + "px";
}

function closeCanvasEdgePicker() {
  if (!state.canvasEdit || !state.canvasEdit.edgePicker) return;
  const picker = state.canvasEdit.edgePicker;
  state.canvasEdit.edgePicker = null;
  if (picker.closeOutsideHandler) {
    document.removeEventListener("mousedown", picker.closeOutsideHandler, true);
  }
  if (picker.closeKeyHandler) {
    document.removeEventListener("keydown", picker.closeKeyHandler, true);
  }
  if (picker.overlay && picker.overlay.parentNode) {
    picker.overlay.parentNode.removeChild(picker.overlay);
  }
}

// Minimal CSS.escape shim — old Safari and some test environments lack it.
function cssEscapeForCanvas(s) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(s);
  return String(s).replace(/[^a-zA-Z0-9_-]/g, ch => "\\" + ch);
}
