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
//   • handleSvgMouseMove    — translate cursor coords to the (stream, stage)
//                              cell + insert slot the placeholder previews.
//   • createNodeInCell      — turn a shift+click into a real node at a slot.
//   • beginEdgeDrag / update / end + cancelDraftEdge + nodeAtLayoutPoint —
//                              edge drag-out from a node's right edge. Drop on
//                              a target commits with the last-used effect; the
//                              new edge is auto-selected so arrow keys cycle
//                              the effect (cycleSelectedEdgeEffect below).
//   • commitNewEdge          — push a new edge and update lastUsedEdgeEffect.
//   • cycleSelectedEdgeEffect / endEdgeCycleSession — arrow-key effect cycling
//                              on the currently-selected edge, with coalesced
//                              undo (one history entry per cycling burst).
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
    // Shift+mousedown on blank grid (incl. over the pointer-transparent
    // placeholder) arms a candidate: a drag past threshold becomes a marquee
    // multi-select, a no-drag release becomes a shift+click that creates a note
    // at the placeholder's slot (see cleanupPendingMarquee). Node / edge
    // affordances arm their own gestures and are excluded here. Plain (no-shift)
    // drag still pans (17-events.js, which bails when Shift is held).
    vizSvg.addEventListener("mousedown", event => {
      if (event.button !== 0) return;
      if (!event.shiftKey) return;
      if (event.target.closest &&
          event.target.closest(".node-group, .row-label-group, .edge-handle, .edge-hit, .edge-path")) return;
      beginMarqueeCandidate(event.clientX, event.clientY);
    });
  }

  // Global Shift tracker — gates the three canvas direct-manipulation gestures
  // (ghost-cell click, edge-handle drag, node drag-to-move). With Shift up the
  // canvas reads as view-only: no ghost cells, no edge handles, no drag. With
  // Shift down those affordances appear and the gestures arm. The flag is
  // mirrored as a body class so CSS can hide the affordances without any
  // per-render JS.
  setShiftHeld(false);
  window.addEventListener("keydown", event => {
    if (event.key === "Shift" && !state.canvasEdit.shiftHeld) {
      setShiftHeld(true);
      // No need to re-render the SVG — the affordance reveal is pure CSS, and
      // the hoverCell will pick up on the next mousemove.
    }
  });
  window.addEventListener("keyup", event => {
    if (event.key === "Shift" && state.canvasEdit.shiftHeld) {
      setShiftHeld(false);
      // Suppressed hoverCell needs explicit clearing so the row layout
      // stops reserving the "+ add another" slot.
      if (state.canvasEdit.hoverCell) {
        state.canvasEdit.hoverCell = null;
        layout = computeLayout();
        render();
      }
    }
  });
  // Defensively clear Shift state when the window loses focus or visibility —
  // a keyup we never see (alt-tab while Shift is held) would otherwise leave
  // the canvas "armed" silently.
  window.addEventListener("blur", () => {
    if (state.canvasEdit.shiftHeld) {
      setShiftHeld(false);
      if (state.canvasEdit.hoverCell) {
        state.canvasEdit.hoverCell = null;
        layout = computeLayout();
        render();
      }
    }
    if (typeof endEdgeCycleSession === "function") endEdgeCycleSession();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (state.canvasEdit.shiftHeld) {
        setShiftHeld(false);
        if (state.canvasEdit.hoverCell) {
          state.canvasEdit.hoverCell = null;
          layout = computeLayout();
          render();
        }
      }
      if (typeof endEdgeCycleSession === "function") endEdgeCycleSession();
    }
  });

  // Canvas keyboard model (most-specific handlers first):
  //   • Esc            — revert rename / cancel draft / dismiss picker / deselect
  //   • Cmd/Ctrl-Z/Y   — undo / redo (commits any pending rename first)
  //   • Arrows         — cell-by-cell navigation, even across empty cells
  //   • Tab / S-Tab    — navigate horizontally, creating a node when the
  //                       destination cell is empty
  //   • Enter          — commit any pending rename AND create a new node
  //                       stacked below (spreadsheet-style chained entry)
  //   • Backspace      — pop a rename char when renaming; otherwise delete node
  //   • printable key  — append to the rename in progress; start a fresh
  //                       rename on the selected node; or create a node in
  //                       the empty cursor cell seeded with the typed char
  document.addEventListener("keydown", event => {
    // Bail when the user is typing in a real form field — Backspace must not
    // nuke a node while they're editing a label or filter.
    const target = event.target;
    if (target && target.matches && target.matches("input, textarea, select, [contenteditable]")) return;
    // Builder wizard owns its own keyboard handling.
    if (state.builder && state.builder.open) return;

    if (event.key === "Escape") {
      // Edge picker first — it's overlaid on the canvas and the most-recent
      // user-opened thing wins for Esc.
      if (state.canvasEdit && state.canvasEdit.edgePicker) {
        if (typeof closeCanvasEdgePicker === "function") closeCanvasEdgePicker();
        event.preventDefault();
        return;
      }
      if (typeof revertInlineRename === "function" && revertInlineRename()) {
        event.preventDefault();
        return;
      }
      if (cancelDraftEdge())        { event.preventDefault(); return; }
      if (cancelDraftNodeDrag())    { event.preventDefault(); return; }
      if (cancelMarquee())          { event.preventDefault(); return; }
      // Clear the empty-cell cursor before falling through to deselectAll —
      // the cursor isn't part of selection state, so deselectAll wouldn't
      // touch it on its own.
      if (state.canvasEdit && state.canvasEdit.cursorCell) {
        state.canvasEdit.cursorCell = null;
        render();
        event.preventDefault();
        return;
      }
      if (state.selectedNodeId || state.selectedEdgeId ||
          (state.selectedNodeIds && state.selectedNodeIds.size)) {
        deselectAll();
        event.preventDefault();
        return;
      }
    }

    // Multi-level undo / redo (caught BEFORE the printable-key handlers
    // below so Cmd-Z doesn't route into the rename as a stray character).
    const cmdOrCtrl = event.metaKey || event.ctrlKey;
    if (cmdOrCtrl && (event.key === "z" || event.key === "Z")) {
      if (typeof commitInlineRename === "function") commitInlineRename();
      if (event.shiftKey) { if (typeof historyRedo === "function" && historyRedo()) event.preventDefault(); }
      else                { if (typeof historyUndo === "function" && historyUndo()) event.preventDefault(); }
      return;
    }
    if (cmdOrCtrl && (event.key === "y" || event.key === "Y")) {
      if (typeof commitInlineRename === "function") commitInlineRename();
      if (typeof historyRedo === "function" && historyRedo()) event.preventDefault();
      return;
    }

    // Arrow keys on a selected edge → cycle its effect. Up/Left = previous
    // effect in EFFECT_OPTIONS, Down/Right = next. The first arrow press of
    // a session pushes the pre-cycle snapshot to history; subsequent presses
    // mutate live without growing history (coalesced undo). Session ends on
    // 1.5s debounce, blur, or selecting a different edge.
    if (!cmdOrCtrl && !event.altKey && state.dataLoaded && state.selectedEdgeId &&
        (event.key === "ArrowUp" || event.key === "ArrowDown" ||
         event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      const direction = (event.key === "ArrowUp" || event.key === "ArrowLeft") ? -1 : 1;
      if (cycleSelectedEdgeEffect(direction)) {
        event.preventDefault();
        return;
      }
    }

    // Arrow keys — cell-by-cell navigation. Commits any in-flight rename
    // first so it lands as its own undo step and the new cell starts clean.
    // preventDefault is unconditional once we've decided this is "our" key —
    // the browser would otherwise scroll the viewport on ArrowDown/Up at
    // the grid edges, which feels broken next to a contained navigation.
    if (!cmdOrCtrl && !event.altKey && state.dataLoaded &&
        (event.key === "ArrowUp" || event.key === "ArrowDown" ||
         event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      if (typeof commitInlineRename === "function") commitInlineRename();
      const dStream = event.key === "ArrowUp"   ? -1 : event.key === "ArrowDown"  ? 1 : 0;
      const dStage  = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
      if (typeof moveCanvasCursor === "function") moveCanvasCursor(dStream, dStage);
      return;
    }

    const hasCanvasPosition =
      (state.selectedNodeId && nodeById[state.selectedNodeId]) ||
      (state.canvasEdit && state.canvasEdit.cursorCell);

    // Tab / Shift-Tab — horizontal step, creating a node if the destination
    // cell is empty. Routes through commitInlineRename for the same
    // history-keeping reason as Arrow.
    if (event.key === "Tab" && hasCanvasPosition && state.dataLoaded && !cmdOrCtrl) {
      if (typeof commitInlineRename === "function") commitInlineRename();
      const direction = event.shiftKey ? "prev" : "next";
      if (typeof handleCanvasTab === "function" && handleCanvasTab(direction)) {
        event.preventDefault();
        return;
      }
    }

    // Enter — commit any pending rename, then create a new node below
    // (stacked in the same cell). Same logic regardless of whether a rename
    // was in flight — chains naturally for spreadsheet-style data entry.
    if (event.key === "Enter" && hasCanvasPosition && state.dataLoaded && !cmdOrCtrl && !event.shiftKey) {
      if (typeof commitInlineRename === "function") commitInlineRename();
      if (typeof handleCanvasEnterCreate === "function" && handleCanvasEnterCreate()) {
        event.preventDefault();
        return;
      }
    }

    // Inline rename — Backspace edits chars when active; otherwise falls
    // through to the existing "delete the node" path at the bottom.
    if (event.key === "Backspace" && typeof isInlineRenameActive === "function" && isInlineRenameActive()) {
      if (typeof inlineRenameBackspace === "function") inlineRenameBackspace();
      event.preventDefault();
      return;
    }

    // Printable key — three branches:
    //   • cursorCell on empty cell  → create a node seeded with this char.
    //   • selectedNodeId, no rename → start a fresh rename (first-key
    //     replaces the existing label).
    //   • rename already active     → append the char.
    if (typeof isPrintableTypingKey === "function" && isPrintableTypingKey(event) && state.dataLoaded) {
      if (typeof isInlineRenameActive === "function" && isInlineRenameActive()) {
        inlineRenameAppend(event.key);
        event.preventDefault();
        return;
      }
      if (state.canvasEdit && state.canvasEdit.cursorCell) {
        if (typeof createNodeAtCursorWithChar === "function" &&
            createNodeAtCursorWithChar(event.key)) {
          event.preventDefault();
          return;
        }
      }
      // Inline rename only makes sense for a single selected node — typing
      // with a multi-selection would silently rename just the primary.
      if (state.selectedNodeId && nodeById[state.selectedNodeId] && state.selectedNodeIds.size <= 1) {
        if (typeof startInlineRename === "function") startInlineRename(state.selectedNodeId);
        if (typeof inlineRenameAppend === "function") inlineRenameAppend(event.key);
        event.preventDefault();
        return;
      }
    }

    if ((event.key === "Delete" || event.key === "Backspace") && state.dataLoaded) {
      if (deleteSelection()) event.preventDefault();
    }
  });

  if (typeof initCanvasInlineRename === "function") initCanvasInlineRename();
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
    state.canvasEdit.flashedEdgeId = null;
    state.canvasEdit.addingEdgeFromNodeId = null;
    state.canvasEdit.editingSidebarItem = null;
    state.canvasEdit.cursorCell = null;
    state.canvasEdit.inlineRename = null;
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

// Mirror the Shift state into both the canvasEdit flag and a body class so
// CSS can hide the edit affordances without any per-render bookkeeping.
function setShiftHeld(held) {
  state.canvasEdit.shiftHeld = !!held;
  if (document.body) {
    document.body.classList.toggle("canvas-shift-edit", !!held);
  }
}

// ───── Per-render event binding ───────────────────────────────────────────
// Called by attachSvgEventHandlers() in 11-rendering.js after every render.
// The canvas hosts only spatial gestures: shift+click a cell to add a note
// (wired in initCanvasEdit, not here), drag from a node's right edge to draw
// an edge, edge click to navigate. All rename / re-colour / reorder /
// add-stream / add-stage flows live in the sidebar and the right detail panel.
//
// The mutating gestures (edge-handle mousedown, node mousedown for drag) are
// gated on event.shiftKey so the canvas is read-only by default. Edge click →
// select stays ungated because it's navigation, not a mutation.
function attachCanvasEditHandlers() {
  const vizSvg = document.getElementById("viz-svg");
  if (!vizSvg) return;

  // Note creation is no longer wired to the ghost-cell element. The placeholder
  // is pointer-transparent and tracks the cursor everywhere; a shift+click on a
  // cell creates a note at the previewed slot via the marquee-candidate path
  // (initCanvasEdit mousedown → cleanupPendingMarquee), while a shift+drag in
  // the same space draws a marquee.

  // Edge handle mousedown → candidate phase. Drag past threshold promotes to
  // beginEdgeDrag (in-place edge creation). Mouseup without crossing the
  // threshold is treated as a click and opens the typeable target picker
  // (the typeable target picker). Shift-gated.
  vizSvg.querySelectorAll(".edge-handle").forEach(handle => {
    handle.addEventListener("mousedown", event => {
      if (event.button !== 0) return;
      if (!event.shiftKey) return;
      event.stopPropagation();
      event.preventDefault();
      const nodeId = handle.getAttribute("data-node-id");
      beginEdgeHandleCandidate(nodeId, event.clientX, event.clientY);
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

  // Node mousedown → candidate drag-to-move. Shift-gated: without Shift we
  // don't arm the drag candidate at all, so the existing click → selectNode
  // (in attachSvgEventHandlers, 11-rendering.js) still fires normally.
  // Promotion to a real drag happens in maybePromoteNodeDrag once the cursor
  // moves past NODE_DRAG_THRESHOLD.
  vizSvg.querySelectorAll(".node-group").forEach(group => {
    group.addEventListener("mousedown", event => {
      if (event.button !== 0) return;
      if (!event.shiftKey) return;
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
  if (state.canvasEdit && state.canvasEdit.marquee) return;    // marqueeing — its own move loop owns the render
  if (state.canvasEdit && state.canvasEdit.draggingNode) return; // node drag owns the layout (its own dropCell)
  // Suppress ghost-cell hover when Shift isn't held — without Shift the canvas
  // is read-only and the ghost cell isn't a valid affordance. The cursor-cell
  // keyboard path (state.canvasEdit.cursorCell, set by 16i) is independent.
  if (!state.canvasEdit.shiftHeld) {
    if (state.canvasEdit.hoverCell) {
      state.canvasEdit.hoverCell = null;
      layout = computeLayout();
      render();
    }
    return;
  }
  const layoutPoint = clientPointToLayout(event.clientX, event.clientY);
  if (!layoutPoint) return;
  // The placeholder tracks the cursor EVERYWHERE inside a cell — including over
  // existing notes — and reports the slot the new note would land in. Reuse the
  // drag's hit-test with no excluded node so it counts every sibling. Notes
  // render above the (pointer-transparent) placeholder, so a click still lands
  // on a note when the cursor is over one; the gap just previews insertion.
  const cell = dropCellForDrag(layoutPoint.x, layoutPoint.y);
  const prev = state.canvasEdit && state.canvasEdit.hoverCell;
  const same = (prev && cell && prev.streamId === cell.streamId &&
                prev.stageId === cell.stageId && prev.insertIndex === cell.insertIndex) ||
               (!prev && !cell);
  if (same) return;
  state.canvasEdit.hoverCell = cell;
  // Recompute layout — moving to a new cell or insert slot parts the stack to
  // open the gap (and may add a reserved slot of row height). Cheap:
  // computeLayout is O(NODES × STAGES) and only runs on slot crossings.
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

// ───── Create node ────────────────────────────────────────────────────────
// insertIndex (0..siblingCount) is the cell-relative slot to drop the new note
// into; omitted/undefined appends to the end of the cell.
function createNodeInCell(streamId, stageId, insertIndex) {
  if (!streamId || !stageId) return;
  if (!streamById[streamId] || !stageById[stageId]) return;

  // Flush any pending inline-rename FIRST so it lands as its own history
  // entry — otherwise it gets bundled with the create below and one undo
  // would rewind both.
  if (typeof commitInlineRename === "function") commitInlineRename();

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
  // Translate the cell-relative insert slot into a global NODES index (count
  // target-cell siblings until we've passed insertIndex of them). Layout stacks
  // siblings by NODES order, so the splice position dictates the visual slot.
  if (insertIndex != null) {
    let count = 0;
    let globalInsertIdx = NODES.length;
    for (let i = 0; i < NODES.length; i++) {
      if (NODES[i].stream === streamId && NODES[i].stage === stageId) {
        if (count === insertIndex) { globalInsertIdx = i; break; }
        count++;
      }
    }
    NODES.splice(globalInsertIdx, 0, newNode);
  } else {
    NODES.push(newNode);
  }
  state.canvasEdit.hoverCell = null;
  // Open the detail panel in edit mode so the user can fill in the rest of
  // the fields without an extra click. The label itself is renamed by
  // typing directly onto the node — no text-box focus needed.
  state.canvasEdit.editMode = true;
  applyCanvasMutation();
  selectNode(newNode.id);
  // Pre-arm the inline rename for the new node so the next keystroke types
  // straight onto the canvas (no input focus, no overlay text box). See
  // 16h-canvas-inline-rename.js.
  if (typeof startInlineRename === "function") startInlineRename(newNode.id);
}

// Drop a new note into the slot the placeholder is previewing. Invoked from the
// shift+click path (cleanupPendingMarquee) when the cursor is over a cell.
function createNodeAtPlaceholder() {
  const hov = state.canvasEdit && state.canvasEdit.hoverCell;
  if (!hov) return false;
  createNodeInCell(hov.streamId, hov.stageId, hov.insertIndex);
  return true;
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

// ───── Edge-handle click vs drag ─────────────────────────────────────────
// Mousedown on an edge handle enters a candidate phase. If the cursor moves
// past EDGE_HANDLE_DRAG_THRESHOLD we promote to a real edge drag (gray
// preview line follows the cursor → drop on target node = create edge with
// last-used effect). Mouseup without crossing the threshold is a click —
// we open the typeable target picker so the user can pick a destination by
// name.
const EDGE_HANDLE_DRAG_THRESHOLD = 4;
let _pendingEdgeHandleClick = null;
let _edgeHandleMoveBound    = null;
let _edgeHandleUpBound      = null;

function beginEdgeHandleCandidate(fromNodeId, clientX, clientY) {
  _pendingEdgeHandleClick = { fromNodeId: fromNodeId, startClientX: clientX, startClientY: clientY };
  _edgeHandleMoveBound = (e) => maybePromoteEdgeHandleDrag(e);
  _edgeHandleUpBound   = (e) => handleEdgeHandleClickOrCancel(e);
  window.addEventListener("mousemove", _edgeHandleMoveBound);
  window.addEventListener("mouseup",   _edgeHandleUpBound);
}

function maybePromoteEdgeHandleDrag(event) {
  if (!_pendingEdgeHandleClick) return;
  const dx = event.clientX - _pendingEdgeHandleClick.startClientX;
  const dy = event.clientY - _pendingEdgeHandleClick.startClientY;
  if (Math.abs(dx) < EDGE_HANDLE_DRAG_THRESHOLD && Math.abs(dy) < EDGE_HANDLE_DRAG_THRESHOLD) return;
  const fromNodeId = _pendingEdgeHandleClick.fromNodeId;
  // Tear down candidate listeners — beginEdgeDrag rebinds its own pair.
  window.removeEventListener("mousemove", _edgeHandleMoveBound);
  window.removeEventListener("mouseup",   _edgeHandleUpBound);
  _pendingEdgeHandleClick = null;
  _edgeHandleMoveBound = null;
  _edgeHandleUpBound = null;
  beginEdgeDrag(fromNodeId, event.clientX, event.clientY);
}

function handleEdgeHandleClickOrCancel() {
  if (!_pendingEdgeHandleClick) return;
  const fromNodeId = _pendingEdgeHandleClick.fromNodeId;
  window.removeEventListener("mousemove", _edgeHandleMoveBound);
  window.removeEventListener("mouseup",   _edgeHandleUpBound);
  _pendingEdgeHandleClick = null;
  _edgeHandleMoveBound = null;
  _edgeHandleUpBound = null;
  // No drag was promoted → treat as a click on the edge handle.
  if (typeof openCanvasEdgePicker === "function") openCanvasEdgePicker(fromNodeId);
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

  // Drop on a valid target → commit immediately with the last-used effect.
  // The new edge is auto-selected so arrow keys (handled in this file's
  // keydown listener) cycle its effect without further clicks.
  const effect = state.canvasEdit.lastUsedEdgeEffect || EFFECT_OPTIONS[0];
  const newEdge = commitNewEdge(draft.fromNodeId, targetId, effect);
  if (newEdge && newEdge.id && typeof selectEdge === "function") {
    selectEdge(newEdge.id);
  } else {
    render();
  }
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
  const nodeId = _pendingNodeDrag.nodeId;
  window.removeEventListener("mousemove", _nodeDragMoveBound);
  window.removeEventListener("mouseup",   _nodeDragUpBound);
  _pendingNodeDrag = null;
  _nodeDragMoveBound = null;
  _nodeDragUpBound   = null;
  // Mouseup without crossing the drag threshold = a shift+click (the candidate
  // only arms when Shift is held). Treat it as a multi-select toggle and
  // swallow the trailing click so the node-group click → selectNode (which
  // would collapse to a single selection) doesn't clobber it.
  if (typeof toggleNodeInSelection === "function") {
    toggleNodeInSelection(nodeId);
    swallowNextClick();
  }
}

function startNodeDrag(nodeId, event) {
  const point = clientPointToLayout(event.clientX, event.clientY);
  if (!point) return;
  // Suspend hover-cell tracking so the ghost preview doesn't compete.
  state.canvasEdit.hoverCell = null;
  // When the grabbed node is part of a multi-selection, drag the whole group;
  // otherwise it's a plain single-node move (and the multi-selection, if any,
  // is left untouched).
  const isGroup = state.selectedNodeIds.size > 1 && state.selectedNodeIds.has(nodeId);
  state.canvasEdit.draggingNode = {
    nodeId: nodeId,
    currentX: point.x,
    currentY: point.y,
    dropCell: dropCellForDrag(point.x, point.y, nodeId),
    active: true,
    groupIds: isGroup ? [...state.selectedNodeIds] : null,
  };
  // Drop the hover placeholder so its gap doesn't compound with the drag's own
  // reserved drop slot (the drag uses dropCell, not hoverCell).
  state.canvasEdit.hoverCell = null;
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

  if (drag.groupIds && drag.groupIds.length > 1) {
    if (!moveNodesToCell(drag.groupIds, target.streamId, target.stageId, target.insertIndex)) {
      layout = computeLayout();
      render();
    }
  } else if (!moveNodeToCell(node, target.streamId, target.stageId, target.insertIndex)) {
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

// ───── Marquee multi-select (shift+drag on empty canvas) ──────────────────
// Mirrors the node-drag candidate→active pattern: a shift+mousedown on blank
// grid arms a candidate; crossing MARQUEE_DRAG_THRESHOLD promotes to a live
// marquee that updates the selection on every move; mouseup commits. A
// no-threshold mouseup is a shift+click: over a cell it creates a note at the
// placeholder slot, on bare canvas it's a no-op.
const MARQUEE_DRAG_THRESHOLD = 4;
let _pendingMarquee   = null;
let _marqueeMoveBound = null;
let _marqueeUpBound   = null;

function beginMarqueeCandidate(clientX, clientY) {
  _pendingMarquee = { startClientX: clientX, startClientY: clientY };
  _marqueeMoveBound = (e) => maybePromoteMarquee(e);
  _marqueeUpBound   = (e) => cleanupPendingMarquee(e);
  window.addEventListener("mousemove", _marqueeMoveBound);
  window.addEventListener("mouseup",   _marqueeUpBound);
}

function maybePromoteMarquee(event) {
  if (!_pendingMarquee) return;
  const dx = event.clientX - _pendingMarquee.startClientX;
  const dy = event.clientY - _pendingMarquee.startClientY;
  if (Math.abs(dx) < MARQUEE_DRAG_THRESHOLD && Math.abs(dy) < MARQUEE_DRAG_THRESHOLD) return;
  const start = clientPointToLayout(_pendingMarquee.startClientX, _pendingMarquee.startClientY);
  window.removeEventListener("mousemove", _marqueeMoveBound);
  window.removeEventListener("mouseup",   _marqueeUpBound);
  _pendingMarquee = null;
  if (start) startMarquee(start, event);
}

function cleanupPendingMarquee() {
  if (!_pendingMarquee) return;
  window.removeEventListener("mousemove", _marqueeMoveBound);
  window.removeEventListener("mouseup",   _marqueeUpBound);
  _pendingMarquee = null;
  _marqueeMoveBound = null;
  _marqueeUpBound   = null;
  // A shift+mousedown that never crossed the marquee threshold is a shift+click.
  // If a placeholder is previewing a cell, that click creates a note there;
  // swallow the trailing click so the background-deselect doesn't undo the new
  // note's selection. Clicks on bare canvas (no placeholder) fall through and
  // deselect as before.
  if (state.canvasEdit && state.canvasEdit.hoverCell) {
    if (createNodeAtPlaceholder()) swallowNextClick();
  }
}

function startMarquee(startPt, event) {
  // A marquee is its own gesture — drop any hover ghost so it doesn't render
  // underneath the selection box.
  state.canvasEdit.hoverCell = null;
  const cur = clientPointToLayout(event.clientX, event.clientY) || startPt;
  state.canvasEdit.marquee = { startX: startPt.x, startY: startPt.y, currentX: cur.x, currentY: cur.y };
  document.body.classList.add("marquee-selecting");
  _marqueeMoveBound = (e) => updateMarquee(e);
  _marqueeUpBound   = (e) => endMarquee(e);
  window.addEventListener("mousemove", _marqueeMoveBound);
  window.addEventListener("mouseup",   _marqueeUpBound);
  updateMarqueeSelection();
  render();
}

function updateMarquee(event) {
  const m = state.canvasEdit && state.canvasEdit.marquee;
  if (!m) return;
  const pt = clientPointToLayout(event.clientX, event.clientY);
  if (!pt) return;
  m.currentX = pt.x;
  m.currentY = pt.y;
  updateMarqueeSelection();
  render();
}

// Recompute the selection from the current marquee rect: any VISIBLE node whose
// position rect intersects the box is selected. Uses setSelection (no render) —
// the caller renders once.
function updateMarqueeSelection() {
  const m = state.canvasEdit && state.canvasEdit.marquee;
  if (!m) return;
  const x1 = Math.min(m.startX, m.currentX), x2 = Math.max(m.startX, m.currentX);
  const y1 = Math.min(m.startY, m.currentY), y2 = Math.max(m.startY, m.currentY);
  const hits = [];
  for (const node of NODES) {
    if (!isNodeVisible(node)) continue;
    const p = layout.positions[node.id];
    if (!p) continue;
    if (p.x < x2 && p.x + p.width > x1 && p.y < y2 && p.y + p.height > y1) hits.push(node.id);
  }
  setSelection(hits, hits.length ? hits[hits.length - 1] : null);
}

function endMarquee() {
  window.removeEventListener("mousemove", _marqueeMoveBound);
  window.removeEventListener("mouseup",   _marqueeUpBound);
  _marqueeMoveBound = null;
  _marqueeUpBound   = null;
  document.body.classList.remove("marquee-selecting");
  state.canvasEdit.marquee = null;
  render();
  renderDetailPanel();
  if (typeof renderMultiSelectBar === "function") renderMultiSelectBar();
  saveUiStateToStorage();
  // Swallow the trailing click so it doesn't deselect everything we just boxed.
  swallowNextClick();
}

// Esc while a marquee is live: tear it down without disturbing the selection it
// produced so far. Returns true if it handled an active marquee.
function cancelMarquee() {
  if (!state.canvasEdit || !state.canvasEdit.marquee) return false;
  state.canvasEdit.marquee = null;
  if (_marqueeMoveBound) {
    window.removeEventListener("mousemove", _marqueeMoveBound);
    window.removeEventListener("mouseup",   _marqueeUpBound);
    _marqueeMoveBound = null;
    _marqueeUpBound   = null;
  }
  document.body.classList.remove("marquee-selecting");
  render();
  if (typeof renderMultiSelectBar === "function") renderMultiSelectBar();
  return true;
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

// Batch move: re-home several nodes into the target cell at once, keeping their
// relative NODES order and inserting them contiguously. One undo step. Mirrors
// moveNodeToCell but for the multi-selection group-drag path (endNodeDrag).
function moveNodesToCell(nodeIds, targetStreamId, targetStageId, cellInsertIdx) {
  if (!streamById[targetStreamId] || !stageById[targetStageId]) return false;
  if (typeof commitInlineRename === "function") commitInlineRename();
  const idSet = new Set(nodeIds);
  // Preserve the group's relative order as it sits in NODES today.
  const moving = NODES.filter(n => idSet.has(n.id));
  if (!moving.length) return false;

  // Pull the whole group out, then translate the cell-relative insert index to
  // a global index against the post-removal array (count only target-cell
  // siblings until we've passed cellInsertIdx of them).
  NODES = NODES.filter(n => !idSet.has(n.id));
  let count = 0;
  let globalInsertIdx = NODES.length;
  for (let i = 0; i < NODES.length; i++) {
    if (NODES[i].stream === targetStreamId && NODES[i].stage === targetStageId) {
      if (count === cellInsertIdx) { globalInsertIdx = i; break; }
      count++;
    }
  }
  moving.forEach(n => { n.stream = targetStreamId; n.stage = targetStageId; });
  NODES.splice(globalInsertIdx, 0, ...moving);

  applyCanvasMutation();
  return true;
}

function commitNewEdge(fromNodeId, toNodeId, effect) {
  if (!nodeById[fromNodeId] || !nodeById[toNodeId]) return null;
  if (fromNodeId === toNodeId) return null;
  // Skip duplicates — an edge with the same (from, to, effect) already exists.
  for (const e of EDGES) {
    if (e.from === fromNodeId && e.to === toNodeId && e.effect === effect) return null;
  }
  const newEdge = {
    from: fromNodeId,
    to: toNodeId,
    effect: effect,
    description: "",
  };
  EDGES.push(newEdge);
  state.canvasEdit.lastUsedEdgeEffect = effect;
  applyCanvasMutation();
  // rebuildIndexes() inside applyCanvasMutation assigns edge.id by index,
  // so by this point newEdge.id is populated and selectable.
  return newEdge;
}

// ───── Selected-edge effect cycling ───────────────────────────────────────
// While an edge is selected, arrow keys cycle its effect through EFFECT_OPTIONS.
// The first cycle of a session pushes the pre-cycle snapshot to history (via
// applyCanvasMutation). Subsequent cycles within the same session mutate the
// live state but bypass history, so a burst of arrow presses collapses into
// one undo step. A 1.5s debounce / blur / different-edge selection ends the
// session; the snapshot already in history.past stays as the undo target.

const EDGE_CYCLE_SESSION_DEBOUNCE_MS = 1500;

function cycleSelectedEdgeEffect(direction) {
  const edgeId = state.selectedEdgeId;
  if (!edgeId) return false;
  const edge = EDGES.find(e => e.id === edgeId);
  if (!edge) return false;
  const currentIdx = EFFECT_OPTIONS.indexOf(edge.effect);
  if (currentIdx < 0) return false;
  const step = (direction < 0) ? -1 : 1;
  const nextIdx = (currentIdx + step + EFFECT_OPTIONS.length) % EFFECT_OPTIONS.length;
  const nextEffect = EFFECT_OPTIONS[nextIdx];
  if (nextEffect === edge.effect) return false;

  // If a session is open for a DIFFERENT edge, close it before starting a new one.
  const existing = state.canvasEdit.edgeCycleSession;
  if (existing && existing.edgeId !== edgeId) {
    endEdgeCycleSession();
  }

  edge.effect = nextEffect;
  state.canvasEdit.lastUsedEdgeEffect = nextEffect;

  if (!state.canvasEdit.edgeCycleSession) {
    // First cycle of a fresh session — go through the normal mutation
    // chokepoint so the pre-cycle snapshot lands in history.past once.
    applyCanvasMutation();
    state.canvasEdit.edgeCycleSession = { edgeId: edgeId, debounceTimer: null };
  } else {
    // Continuing a session — skip the history push, just refresh derived state.
    applyEdgeCycleSubsequent();
  }

  // Restart the inactivity timer that closes the session.
  const session = state.canvasEdit.edgeCycleSession;
  if (session.debounceTimer) clearTimeout(session.debounceTimer);
  session.debounceTimer = setTimeout(endEdgeCycleSession, EDGE_CYCLE_SESSION_DEBOUNCE_MS);
  return true;
}

// Run the post-mutation half of applyCanvasMutation without pushing a new
// undo entry. Used for the 2nd…Nth arrow press in a cycle session so the
// whole burst collapses to one undo step.
function applyEdgeCycleSubsequent() {
  rebuildIndexes();
  if (typeof recomputeValues === "function") recomputeValues();
  render();
  if (typeof renderDetailPanel === "function") renderDetailPanel();
  try {
    if (typeof serializeLiveStateToCsv === "function") {
      state.lastCsvSnapshot = serializeLiveStateToCsv();
      if (typeof saveCsvToStorage === "function") saveCsvToStorage(state.lastCsvSnapshot);
    }
  } catch (err) {
    console.warn("Persisting edge-cycle mutation failed:", err);
  }
}

function endEdgeCycleSession() {
  const session = state.canvasEdit.edgeCycleSession;
  if (!session) return;
  if (session.debounceTimer) clearTimeout(session.debounceTimer);
  state.canvasEdit.edgeCycleSession = null;
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
  // Node deletion — covers both single-select and the shift-drag/shift-click
  // multi-selection. Fall back to the scalar primary if the Set is somehow
  // empty (defensive). All removed nodes + their incident edges go in one
  // applyCanvasMutation, so undo (toast or Cmd-Z) reverts the whole batch.
  const ids = (state.selectedNodeIds && state.selectedNodeIds.size)
    ? [...state.selectedNodeIds]
    : (state.selectedNodeId ? [state.selectedNodeId] : []);
  if (ids.length) {
    const idSet = new Set(ids.filter(id => nodeById[id]));
    if (!idSet.size) return false;
    NODES = NODES.filter(n => !idSet.has(n.id));
    EDGES = EDGES.filter(e => !idSet.has(e.from) && !idSet.has(e.to));
    state.selectedNodeId = null;
    state.selectedNodeIds = new Set();
    state.ancestorSet = new Set();
    state.descendantSet = new Set();
    state.highlightedEdgeIds = new Set();
    applyCanvasMutation();   // auto-captures the pre-mutation snapshot → one undo step
    showUndoToast(idSet.size === 1 ? "Node deleted" : idSet.size + " nodes deleted", () => historyUndo());
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
