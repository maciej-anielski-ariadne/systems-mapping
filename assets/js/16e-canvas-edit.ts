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

import type {
  CategoryMap,
  Edge,
  EffectKind,
  ElasticityDefaults,
  GraphNode,
  Param,
  Stage,
  Stream,
} from "./types";
import {
  state,
  STREAMS,
  STAGES,
  CATEGORIES,
  NODES,
  EDGES,
  layout,
  nodeById,
  edgeById,
  outgoingEdges,
  streamById,
  stageById,
  setStreams,
  setStages,
  setCategories,
  setNodes,
  setEdges,
  setParams,
  setDefaultElasticityByEffect,
  setLayout,
  markEdgeGeometryChanged,
} from "./03-state";
import {
  COL_HEADER_HEIGHT,
  EFFECT_OPTIONS,
  NODE_GAP_Y,
  NODE_WIDTH,
  ROW_HEADER_WIDTH,
  ROW_PADDING,
  STREAM_COLOR_PALETTE,
  SVG_PADDING_TOP,
} from "./02-config";
import { cloneEdgeForUndo } from "./04-utils";
import { saveUiStateToStorage } from "./04a-storage";
import { serializeLiveStateToCsv } from "./05a-csv-serializer";
import { rebuildIndexes } from "./06-data-loader";
import { computeLayout, measureNode } from "./08-layout";
import {
  deselectAll,
  focusNode,
  selectEdge,
  selectNode,
  setSelection,
  toggleNodeInSelection,
} from "./09-graph-selection";
import { isNodeVisible } from "./10-filters";
import { render, scheduleRender, scheduleOverlayRender, scheduleSelectionStyling } from "./11-rendering";
import { renderSidebar } from "./13-sidebar";
import { renderDetailPanel } from "./15-detail-panel";
import { hideDropZone } from "./16-file-io";
import { slugify } from "./16a-builder-state";
import { applyCanvasMutation } from "./16f-canvas-mutations";
import {
  clearHistory,
  ensureUndoToastEl,
  historyRedo,
  historyUndo,
  pushUndo,
  restoreFromUndo,
  showUndoToast,
} from "./16g-canvas-undo";
import {
  commitInlineRename,
  initCanvasInlineRename,
  inlineRenameAppend,
  inlineRenameBackspace,
  isInlineRenameActive,
  isPrintableTypingKey,
  revertInlineRename,
  startInlineRename,
} from "./16h-canvas-inline-rename";
import {
  closeCanvasEdgePicker,
  createNodeAtCursorWithChar,
  handleCanvasEnterCreate,
  handleCanvasTab,
  moveCanvasCursor,
  openCanvasEdgePicker,
} from "./16i-canvas-keyboard-nav";
import { renderMultiSelectBar } from "./16j-multi-select-bar";
import { invalidateSweep } from "./22-review";
import { refreshReview } from "./23-review-panel";

// ───── Bootstrapping ──────────────────────────────────────────────────────

// Called once from 18-main.js after the script loads. Wires window-level
// listeners (mousemove for hover cell, keydown for Delete/Esc) and appends
// the undo-toast element to <body>.
export function initCanvasEdit(): void {
  ensureUndoToastEl();

  const vizSvg = document.getElementById("viz-svg");
  if (vizSvg) {
    vizSvg.addEventListener("mousemove", handleSvgMouseMove as EventListener);
    vizSvg.addEventListener("mouseleave", () => {
      if (state.canvasEdit && state.canvasEdit.hoverCell) {
        state.canvasEdit.hoverCell = null;
        setLayout(computeLayout());
        render();
      }
    });

    // A double-click fires two complete click cycles before `dblclick`. In Edit
    // mode those two cycles can select and then deselect an initially unselected
    // box, leaving the detail panel empty even though the user's intent was to
    // edit that box. Make the final event authoritative: keep the box selected,
    // return the detail panel to its identity fields, and put the name in focus.
    vizSvg.addEventListener("dblclick", (event: MouseEvent) => {
      if (state.uiMode !== "edit") return;
      const eventTarget = event.target instanceof Element ? event.target : null;
      const nodeGroup = eventTarget?.closest<SVGGElement>(".node-group[data-node-id]");
      const nodeIdentifier = nodeGroup?.dataset.nodeId;
      if (!nodeIdentifier) return;
      event.preventDefault();
      event.stopPropagation();
      focusNode(nodeIdentifier);
      const detailPanel = document.getElementById("detail-panel");
      if (detailPanel) detailPanel.scrollTop = 0;
      const nameInput = document.querySelector<HTMLInputElement>(
        '#detail-panel .detail-name-input[data-field="label"]',
      );
      if (nameInput) {
        nameInput.focus({ preventScroll: true });
        nameInput.select();
      }
    });
    // Shift+mousedown on blank grid arms a marquee candidate: a drag past the
    // threshold becomes a marquee multi-select. Shift stays here because this is
    // a SELECTION gesture, the same convention as Shift+click, and because the
    // plain drag belongs to panning in both modes — one gesture, one meaning,
    // whichever mode you are in. Node / edge affordances arm their own gestures
    // and are excluded.
    vizSvg.addEventListener("mousedown", (event: MouseEvent) => {
      if (event.button !== 0) return;
      if (!event.shiftKey) return;
      if (state.uiMode !== "edit") return;
      const target = event.target as HTMLElement;
      if (target.closest &&
          target.closest(".node-group, .row-label-group, .edge-handle, .edge-hit, .edge-path")) return;
      beginMarqueeCandidate(event.clientX, event.clientY);
    });

    // Plain mousedown on blank grid, editing: a candidate "create here". The
    // plain drag belongs to panning, so this only fires when the pointer did
    // NOT travel — press and release on the previewed cell and a box appears.
    //
    // Creating a box used to need Shift+click, which rode in on the marquee
    // candidate above. Now Shift means marquee and a plain click means create,
    // which is what the ghost cell has been previewing the whole time.
    vizSvg.addEventListener("mousedown", (event: MouseEvent) => {
      if (event.button !== 0 || event.shiftKey) return;
      if (state.uiMode !== "edit") return;
      const target = event.target as HTMLElement;
      if (target.closest &&
          target.closest(".node-group, .row-label-group, .edge-handle, .edge-hit, .edge-path")) return;
      if (!state.canvasEdit.hoverCell) return;
      const startX = event.clientX, startY = event.clientY;
      const onUp = (up: MouseEvent): void => {
        window.removeEventListener("mouseup", onUp);
        // Travelled: that was a pan, not a click. Leave it alone.
        if (Math.abs(up.clientX - startX) >= MARQUEE_DRAG_THRESHOLD ||
            Math.abs(up.clientY - startY) >= MARQUEE_DRAG_THRESHOLD) return;
        if (!state.canvasEdit.hoverCell) return;
        // Swallow the trailing click so the background-deselect handler does
        // not immediately undo the new box's selection.
        if (createNodeAtPlaceholder()) swallowNextClick();
      };
      window.addEventListener("mouseup", onUp);
    });
  }

  // Global Shift tracker — gates the three canvas direct-manipulation gestures
  // (ghost-cell click, edge-handle drag, node drag-to-move). With Shift up the
  // canvas reads as view-only: no ghost cells, no edge handles, no drag. With
  // Shift down those affordances appear and the gestures arm. The flag is
  // mirrored as a body class so CSS can hide the affordances without any
  // per-render JS.
  setShiftHeld(false);
  window.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Shift" && !state.canvasEdit.shiftHeld) {
      setShiftHeld(true);
      // No need to re-render the SVG — the affordance reveal is pure CSS, and
      // the hoverCell will pick up on the next mousemove.
    }
  });
  window.addEventListener("keyup", (event: KeyboardEvent) => {
    if (event.key === "Shift" && state.canvasEdit.shiftHeld) {
      setShiftHeld(false);
      // Suppressed hoverCell needs explicit clearing so the row layout
      // stops reserving the "+ add node" slot.
      if (state.canvasEdit.hoverCell) {
        state.canvasEdit.hoverCell = null;
        setLayout(computeLayout());
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
        setLayout(computeLayout());
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
          setLayout(computeLayout());
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
  document.addEventListener("keydown", (event: KeyboardEvent) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    // Builder wizard owns its own keyboard handling.
    if (state.builder && state.builder.open) return;

    // Model fields in the box panel write through Ariadne's history as they
    // change, so Command/Ctrl-Z must reach that history even while the field
    // retains focus. Other text surfaces (search, Review, sidebar renaming and
    // filterable dropdown typing) keep the browser's local text undo instead.
    const commandOrControlIsPressed = event.metaKey || event.ctrlKey;
    const targetIsInsideDetailPanel = !!target?.closest("#detail-panel");
    const targetIsFormField = !!target?.matches(
      "input, textarea, select, [contenteditable]",
    );
    const targetIsTextEditingControl = target instanceof HTMLTextAreaElement ||
      !!target?.closest("[contenteditable]") ||
      (target instanceof HTMLInputElement && [
        "text", "search", "email", "url", "tel", "password",
      ].includes(target.type));
    const targetUsesLocalTextUndo = !!target?.closest(
      "#search-input, #builder-overlay, #review-sidebar, .typeable-dropdown-input, " +
      ".sidebar input, .sidebar textarea, .sidebar [contenteditable]",
    ) || (targetIsTextEditingControl && !targetIsInsideDetailPanel);
    if (commandOrControlIsPressed && (event.key === "z" || event.key === "Z")) {
      if (targetUsesLocalTextUndo || (targetIsFormField && !targetIsInsideDetailPanel)) return;
      if (typeof commitInlineRename === "function") commitInlineRename();
      if (event.shiftKey) {
        if (typeof historyRedo === "function" && historyRedo()) event.preventDefault();
      } else if (typeof historyUndo === "function" && historyUndo()) {
        event.preventDefault();
      }
      return;
    }
    if (commandOrControlIsPressed && (event.key === "y" || event.key === "Y")) {
      if (targetUsesLocalTextUndo || (targetIsFormField && !targetIsInsideDetailPanel)) return;
      if (typeof commitInlineRename === "function") commitInlineRename();
      if (typeof historyRedo === "function" && historyRedo()) event.preventDefault();
      return;
    }

    // Bail for non-history keys when the user is typing in a real form field —
    // Backspace must not remove a box while they edit a label or filter.
    if (targetIsFormField) return;

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

    // Arrow keys on a selected edge → cycle its effect. Up/Left = previous
    // effect in EFFECT_OPTIONS, Down/Right = next. The first arrow press of
    // a session pushes the pre-cycle snapshot to history; subsequent presses
    // mutate live without growing history (coalesced undo). Session ends on
    // 1.5s debounce, blur, or selecting a different edge.
    if (!commandOrControlIsPressed && !event.altKey && state.dataLoaded && state.uiMode === "edit" &&
        !state.simulationMode && state.selectedEdgeId &&
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
    if (!commandOrControlIsPressed && !event.altKey && state.dataLoaded &&
        (event.key === "ArrowUp" || event.key === "ArrowDown" ||
         event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      if (typeof commitInlineRename === "function") commitInlineRename();
      const dStream = event.key === "ArrowUp"   ? -1 : event.key === "ArrowDown"  ? 1 : 0;
      const dStage  = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
      if (typeof moveCanvasCursor === "function") moveCanvasCursor(dStream, dStage);
      return;
    }

    // Reading mode never creates, renames or deletes. Every branch from here
    // down changes the map, and while reading, the map is a picture — the
    // shortcuts come back the moment you switch to editing.
    if (state.uiMode !== "edit") return;

    const hasCanvasPosition =
      (state.selectedNodeId && nodeById[state.selectedNodeId]) ||
      (state.canvasEdit && state.canvasEdit.cursorCell);

    // Tab / Shift-Tab — horizontal step, creating a node if the destination
    // cell is empty. Routes through commitInlineRename for the same
    // history-keeping reason as Arrow.
    if (event.key === "Tab" && hasCanvasPosition && state.dataLoaded && !commandOrControlIsPressed) {
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
    if (event.key === "Enter" && hasCanvasPosition && state.dataLoaded && !commandOrControlIsPressed && !event.shiftKey) {
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
export interface EmptyMapGridSnapshot {
  streams: Stream[];
  stages: Stage[];
  categories: CategoryMap;
  params: Param[];
  defaultElasticityByEffect: ElasticityDefaults;
}

export function bootEmptyStateGrid(snapshot?: EmptyMapGridSnapshot): void {
  const streams = snapshot?.streams || [
    { id: "row_1", label: "Row 1", short: "R1", color: STREAM_COLOR_PALETTE[0] },
    { id: "row_2", label: "Row 2", short: "R2", color: STREAM_COLOR_PALETTE[1] },
    { id: "row_3", label: "Row 3", short: "R3", color: STREAM_COLOR_PALETTE[2] },
  ];
  const stages = snapshot?.stages || [
    { id: "stage_1", label: "Column 1" },
    { id: "stage_2", label: "Column 2" },
    { id: "stage_3", label: "Column 3" },
  ];
  const categories: CategoryMap = {};
  for (const [identifier, category] of Object.entries(snapshot?.categories || {})) {
    categories[identifier] = { ...category };
  }
  setStreams(streams.map(stream => ({ ...stream })));
  setStages(stages.map(stage => ({ ...stage })));
  setCategories(categories);
  setNodes([]);
  setEdges([]);
  setParams((snapshot?.params || []).map(parameter => ({ ...parameter })));
  setDefaultElasticityByEffect(snapshot
    ? { ...snapshot.defaultElasticityByEffect }
    : { enables: 0.30, increases: 0.25, decreases: -0.25 });

  state.dataLoaded = true;
  // A new map has nothing wrong with it yet, and nothing to sweep. Both the
  // findings and the cached sweep belong to the map that just went away.
  state.loadErrors = [];
  invalidateSweep();
  state.selectedNodeId = null;
  state.selectedNodeIds = new Set();
  state.selectedEdgeId = null;
  state.hoveredNodeId = null;
  state.hiddenStreams = new Set();
  state.hiddenCategories = new Set();
  state.hiddenStages = new Set();
  state.hiddenEffects = new Set();
  state.hiddenStyles = new Set();
  state.hiddenTrace = new Set();
  state.ancestorSet = new Set();
  state.descendantSet = new Set();
  state.highlightedEdgeIds = new Set();
  state.userOverrides = {};
  state.computedValues = {};
  state.explanations = {};
  state.reviews = {};
  state.reviewPass = false;
  state.searchQuery = "";
  state.searchMatches = [];
  state.searchFocusIndex = 0;
  state.atlas = null;
  state.simulationMode = false;
  saveUiStateToStorage();
  if (state.canvasEdit) {
    state.canvasEdit.hoverCell = null;
    state.canvasEdit.draftEdge = null;
    state.canvasEdit.flashedEdgeId = null;
    state.canvasEdit.flashedNodeIds = null;
    state.canvasEdit.flashedEdgeIds = null;
    state.canvasEdit.addingEdgeFromNodeId = null;
    state.canvasEdit.cursorCell = null;
    state.canvasEdit.inlineRename = null;
  }

  rebuildIndexes();
  setLayout(computeLayout());
  hideDropZone();
  renderSidebar();
  render();
  renderDetailPanel();
  // Drop the previous map's count off the header button.
  refreshReview();
  // Seed the undo "previous snapshot" so the first mutation after boot has
  // something to push onto history.past, and start with an empty stack.
  try {
    state.lastCsvSnapshot = serializeLiveStateToCsv(null, { compact: true });
  } catch (err) { /* serializer unavailable yet — first applyCanvasMutation will set it */ }
  if (typeof clearHistory === "function") clearHistory();
}

// Mirror the Shift state into the canvasEdit flag and a body class.
//
// Shift no longer reveals or arms anything — edit mode does that. What is left
// is a selection modifier, and the flag survives only so the marquee code can
// ask whether it is held. The body class is kept for the same reason: nothing
// in the stylesheet gates an affordance on it any more.
export function setShiftHeld(held: boolean): void {
  if (held && state.uiMode !== "edit") held = false;
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
// gated on EDIT MODE, so the canvas is read-only while reading. Edge click →
// select stays ungated because it's navigation, not a mutation.
let _canvasEditDelegationBound = false;
export function attachCanvasEditHandlers(): void {
  // Delegated, so bound ONCE — not per render. innerHTML rebuilds replace every
  // node / edge element each render(), so the old per-element binding meant
  // O(nodes + edges) addEventListener calls every frame. Delegating to the
  // stable #viz-svg element means render() never re-touches these listeners.
  if (_canvasEditDelegationBound) return;
  const vizSvg = document.getElementById("viz-svg");
  if (!vizSvg) return;
  _canvasEditDelegationBound = true;

  // Note creation is no longer wired to the ghost-cell element. The placeholder
  // is pointer-transparent and tracks the cursor everywhere; a shift+click on a
  // cell creates a note at the previewed slot via the marquee-candidate path
  // (initCanvasEdit mousedown → cleanupPendingMarquee), while a shift+drag in
  // the same space draws a marquee.

  // Mousedown → either an edge-draw candidate (from a box's edge handle) or a
  // box drag-to-move candidate. EDIT MODE is the gate, and the only gate.
  //
  // These used to need Shift held as well, which made editing a mode inside a
  // mode: you were in edit mode, and then you had to say so again, with a key,
  // every time you wanted to move a box or draw a link. Being in edit mode IS
  // the statement. Reading mode arms neither, so the canvas stays read-only
  // there exactly as before.
  //
  // A plain click still selects: both gestures are only CANDIDATES until the
  // pointer travels past its threshold, so a click can never become an
  // accidental move or a stray link.
  vizSvg.addEventListener("mousedown", (event: Event) => {
    const e = event as MouseEvent;
    if (e.button !== 0) return;
    if (state.uiMode !== "edit") return;
    // Shift keeps its SELECTION meanings — held here it means "add to the
    // selection" / "marquee", so it must not also start a drag.
    if (e.shiftKey) return;
    const t = e.target as Element | null;
    if (!t || typeof t.closest !== "function") return;

    // Edge handle wins over the node body it sits on. Drag past threshold
    // promotes to beginEdgeDrag; a tap opens the typeable target picker.
    const handle = t.closest(".edge-handle");
    if (handle) {
      e.stopPropagation();
      e.preventDefault();
      beginEdgeHandleCandidate(handle.getAttribute("data-node-id")!, e.clientX, e.clientY);
      return;
    }
    // Node mousedown → candidate drag-to-move (promoted in maybePromoteNodeDrag
    // once the cursor moves past NODE_DRAG_THRESHOLD).
    const group = t.closest(".node-group");
    if (group) {
      beginNodeDragCandidate(group.getAttribute("data-node-id")!, e.clientX, e.clientY);
    }
  });

  // Edge click (wide hit-path) → select the from-node + open edit mode.
  vizSvg.addEventListener("click", (event: Event) => {
    const t = event.target as Element | null;
    const path = (t && typeof t.closest === "function") ? t.closest(".edge-hit") : null;
    if (!path) return;
    event.stopPropagation();
    if (typeof selectEdge === "function") selectEdge(path.getAttribute("data-edge-id")!);
  });
}

// ───── Hover cell tracking ────────────────────────────────────────────────
// Translates SVG mouse coordinates to layout coordinates, figures out which
// (stream, stage) cell the cursor is in, and (when that cell is empty)
// updates state.canvasEdit.hoverCell so render() draws the ghost.
export function handleSvgMouseMove(event: MouseEvent): void {
  if (!state.dataLoaded) return;
  if (state.canvasEdit && state.canvasEdit.draftEdge) return;  // dragging an edge — separate render loop owns hoverCell
  if (state.canvasEdit && state.canvasEdit.marquee) return;    // marqueeing — its own move loop owns the render
  if (state.canvasEdit && state.canvasEdit.draggingNode) return; // node drag owns the layout (its own dropCell)
  // Reading mode has no ghost cell: the canvas is read-only there and an
  // insertion preview is not a thing you can act on. Editing shows it wherever
  // the cursor is over a gap. (It used to require Shift held as well, which is
  // the modal-inside-a-mode this removes.) The cursor-cell keyboard path
  // (state.canvasEdit.cursorCell, set by 16i) is independent.
  if (state.uiMode !== "edit") {
    if (state.canvasEdit.hoverCell) {
      state.canvasEdit.hoverCell = null;
      setLayout(computeLayout());
      scheduleRender();
    }
    return;
  }
  const layoutPoint = clientPointToLayout(event.clientX, event.clientY);
  if (!layoutPoint) return;
  // The placeholder only previews insertion when the cursor is in a GAP — the
  // space between two notes, above the first note, or below the last (an empty
  // cell is one big gap). Hovering directly over a note returns null, so the
  // ghost no longer pops up while the user is drawing an edge from a note or
  // shift-clicking notes to multi-select. See insertionGapCell.
  const cell = insertionGapCell(layoutPoint.x, layoutPoint.y);
  const prev = state.canvasEdit && state.canvasEdit.hoverCell;
  const same = (prev && cell && prev.streamId === cell.streamId &&
                prev.stageId === cell.stageId && prev.insertIndex === cell.insertIndex) ||
               (!prev && !cell);
  if (same) return;
  state.canvasEdit.hoverCell = cell;
  // Recompute layout — moving to a new cell or insert slot parts the stack to
  // open the gap (and may add a reserved slot of row height). Cheap:
  // computeLayout is O(NODES × STAGES) and only runs on slot crossings.
  setLayout(computeLayout());
  scheduleRender();
}

// Convert a mouse position into a position on the map. A mouse event gives
// "client" coordinates — pixels from the corner of the visible window. The map
// has its own "layout" coordinates — fixed positions on the full drawing,
// before zoom and scroll. To translate, we subtract where the map area sits on
// screen, add how far it's been scrolled, then divide out the zoom. (See
// "client vs. layout coordinates" in docs/GLOSSARY.md.)
export function clientPointToLayout(clientX: number, clientY: number): { x: number; y: number } | null {
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
export function createNodeInCell(streamId: string, stageId: string, insertIndex?: number | null): void {
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
  // A new node starts with one primary (fill) category, no secondaries.
  const primaryIds = Object.keys(CATEGORIES).filter(id => (CATEGORIES[id].class || "primary") !== "secondary");
  const categoryId = primaryIds[0] || Object.keys(CATEGORIES)[0];

  const newNode: GraphNode = {
    id: generateUniqueNodeId("new_node"),
    label: "New box",
    description: "",
    stream: streamId,
    stage: stageId,
    category: categoryId,
    categoryIds: [categoryId],
    primaryCategories: [categoryId],
    secondaryCategories: [],
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
export function createNodeAtPlaceholder(): boolean {
  const hov = state.canvasEdit && state.canvasEdit.hoverCell;
  if (!hov) return false;
  createNodeInCell(hov.streamId, hov.stageId, hov.insertIndex);
  return true;
}

// Build a node id from a label that doesn't collide with any existing one.
export function generateUniqueNodeId(seed: string): string {
  const base = (typeof slugify === "function" ? slugify(seed) : String(seed).toLowerCase().replace(/[^a-z0-9]+/g, "_")) || "node";
  if (!nodeById[base]) return base;
  let counter = 2;
  while (nodeById[base + "_" + counter]) counter++;
  return base + "_" + counter;
}

// Auto-create a "Default" category if no categories exist yet. Used on the
// first add-node action when the user has started from an empty grid.
export function ensureDefaultCategory(): void {
  if (Object.keys(CATEGORIES).length > 0) return;
  CATEGORIES["default"] = {
    label: "Default",
    color: "#a3a3a3",
    textColor: "#1c1917",
    class: "primary",
  };
}

// Derive a short label (uppercase, ~6 chars) for a stream. First two letters
// of each word, capped at 6 chars total.
export function deriveShortLabel(label: string): string {
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
export const EDGE_HANDLE_DRAG_THRESHOLD = 4;
export let _pendingEdgeHandleClick: { fromNodeId: string; startClientX: number; startClientY: number } | null = null;
export let _edgeHandleMoveBound: ((e: MouseEvent) => void) | null = null;
export let _edgeHandleUpBound: ((e: MouseEvent) => void) | null = null;

export function beginEdgeHandleCandidate(fromNodeId: string, clientX: number, clientY: number): void {
  _pendingEdgeHandleClick = { fromNodeId: fromNodeId, startClientX: clientX, startClientY: clientY };
  _edgeHandleMoveBound = (e) => maybePromoteEdgeHandleDrag(e);
  _edgeHandleUpBound   = (e) => handleEdgeHandleClickOrCancel(e);
  window.addEventListener("mousemove", _edgeHandleMoveBound);
  window.addEventListener("mouseup",   _edgeHandleUpBound);
}

export function maybePromoteEdgeHandleDrag(event: MouseEvent): void {
  if (!_pendingEdgeHandleClick) return;
  const dx = event.clientX - _pendingEdgeHandleClick.startClientX;
  const dy = event.clientY - _pendingEdgeHandleClick.startClientY;
  if (Math.abs(dx) < EDGE_HANDLE_DRAG_THRESHOLD && Math.abs(dy) < EDGE_HANDLE_DRAG_THRESHOLD) return;
  const fromNodeId = _pendingEdgeHandleClick.fromNodeId;
  // Tear down candidate listeners — beginEdgeDrag rebinds its own pair.
  window.removeEventListener("mousemove", _edgeHandleMoveBound!);
  window.removeEventListener("mouseup",   _edgeHandleUpBound!);
  _pendingEdgeHandleClick = null;
  _edgeHandleMoveBound = null;
  _edgeHandleUpBound = null;
  beginEdgeDrag(fromNodeId, event.clientX, event.clientY);
}

export function handleEdgeHandleClickOrCancel(_event?: MouseEvent): void {
  if (!_pendingEdgeHandleClick) return;
  const fromNodeId = _pendingEdgeHandleClick.fromNodeId;
  window.removeEventListener("mousemove", _edgeHandleMoveBound!);
  window.removeEventListener("mouseup",   _edgeHandleUpBound!);
  _pendingEdgeHandleClick = null;
  _edgeHandleMoveBound = null;
  _edgeHandleUpBound = null;
  // No drag was promoted → treat as a click on the edge handle.
  if (typeof openCanvasEdgePicker === "function") openCanvasEdgePicker(fromNodeId);
}

// ───── Edge-of-screen auto-pan ──────────────────────────────────────────────
// While dragging a node or drawing an edge, scroll the #viz-scroll viewport when
// the cursor nears a screen edge so the user can reach nodes/cells that are
// currently off-screen. mousemove alone can't do this (it stops firing once the
// cursor is parked against the edge), so we run a RAF loop for the duration of
// the drag: each frame nudges the scroll position and replays the drag update at
// the cursor's last known client position so the dragged note / draft edge keep
// tracking the pointer as the canvas slides underneath it.
export const AUTO_PAN_MARGIN = 56;      // px from a viewport edge where auto-pan kicks in
export const AUTO_PAN_MAX_SPEED = 22;   // px/frame at the very edge (ramps up from 0)
export let _autoPanRAF: number | null        = null;
export let _autoPanLastClient: { x: number; y: number } | null = null;   // { x, y } latest cursor position in client coords
export let _autoPanUpdate: ((e: { clientX: number; clientY: number }) => void) | null = null;   // the drag's update fn (updateNodeDrag / updateEdgeDrag)

// Ramp the pan speed from 0 at the margin's inner edge to AUTO_PAN_MAX_SPEED at
// (or past) the viewport edge. Returns a signed delta: negative = scroll toward
// the start of the axis, positive = toward the end.
export function autoPanAxisDelta(pos: number, min: number, max: number): number {
  if (pos < min + AUTO_PAN_MARGIN) {
    const depth = Math.min(AUTO_PAN_MARGIN, (min + AUTO_PAN_MARGIN) - pos);
    return -AUTO_PAN_MAX_SPEED * (depth / AUTO_PAN_MARGIN);
  }
  if (pos > max - AUTO_PAN_MARGIN) {
    const depth = Math.min(AUTO_PAN_MARGIN, pos - (max - AUTO_PAN_MARGIN));
    return AUTO_PAN_MAX_SPEED * (depth / AUTO_PAN_MARGIN);
  }
  return 0;
}

export function startAutoPan(updateFn: (e: { clientX: number; clientY: number }) => void): void {
  _autoPanUpdate = updateFn;
  if (_autoPanRAF == null) _autoPanRAF = requestAnimationFrame(autoPanTick);
}

export function stopAutoPan(): void {
  if (_autoPanRAF != null) cancelAnimationFrame(_autoPanRAF);
  _autoPanRAF = null;
  _autoPanUpdate = null;
  _autoPanLastClient = null;
}

export function autoPanTick(): void {
  _autoPanRAF = null;
  // Bail if the drag ended (state cleared) between frames.
  const dragging = state.canvasEdit &&
    (state.canvasEdit.draggingNode || state.canvasEdit.draftEdge);
  if (!dragging || !_autoPanUpdate || !_autoPanLastClient) return;

  const vizScrollEl = document.getElementById("viz-scroll");
  if (!vizScrollEl) return;
  const rect = vizScrollEl.getBoundingClientRect();

  let dx = autoPanAxisDelta(_autoPanLastClient.x, rect.left, rect.right);
  let dy = autoPanAxisDelta(_autoPanLastClient.y, rect.top,  rect.bottom);

  if (dx || dy) {
    const maxLeft = vizScrollEl.scrollWidth  - vizScrollEl.clientWidth;
    const maxTop  = vizScrollEl.scrollHeight - vizScrollEl.clientHeight;
    const newLeft = Math.max(0, Math.min(maxLeft, vizScrollEl.scrollLeft + dx));
    const newTop  = Math.max(0, Math.min(maxTop,  vizScrollEl.scrollTop  + dy));
    if (newLeft !== vizScrollEl.scrollLeft || newTop !== vizScrollEl.scrollTop) {
      vizScrollEl.scrollLeft = newLeft;
      vizScrollEl.scrollTop  = newTop;
      // Replay the drag at the parked cursor: the layout point now maps to a
      // different spot because the canvas scrolled, so the dragged note / draft
      // edge follows along and drop targets recompute.
      _autoPanUpdate({ clientX: _autoPanLastClient.x, clientY: _autoPanLastClient.y });
    }
  }
  _autoPanRAF = requestAnimationFrame(autoPanTick);
}

// ───── Edge drag ──────────────────────────────────────────────────────────
// Drawing a new link is a three-step gesture, one function per step:
//   begin  (mouse pressed on a box's edge-handle) — start a "draft edge" that
//           follows the cursor, and listen for mouse move / release.
//   update (mouse moves) — move the draft edge's loose end to the cursor and
//           note which box, if any, it's hovering over as a drop target.
//   end    (mouse released) — if it was dropped on another box, create the real
//           link; otherwise throw the draft away. Always unhook the listeners.
// The in-progress edge lives in state.canvasEdit.draftEdge so the renderer can
// draw it; it's just a preview until `end` commits it.
export let _draftEdgeMoveBound: ((e: MouseEvent) => void) | null = null;
export let _draftEdgeUpBound: ((e: MouseEvent) => void) | null   = null;

export function beginEdgeDrag(fromNodeId: string, clientX: number, clientY: number): void {
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

  _autoPanLastClient = { x: clientX, y: clientY };
  startAutoPan(updateEdgeDrag);
  _draftEdgeMoveBound = (event) => updateEdgeDrag(event);
  _draftEdgeUpBound   = (event) => endEdgeDrag(event);
  window.addEventListener("mousemove", _draftEdgeMoveBound);
  window.addEventListener("mouseup",   _draftEdgeUpBound);
}

export function updateEdgeDrag(event: { clientX: number; clientY: number }): void {
  const draft = state.canvasEdit && state.canvasEdit.draftEdge;
  if (!draft) return;
  _autoPanLastClient = { x: event.clientX, y: event.clientY };
  const point = clientPointToLayout(event.clientX, event.clientY);
  if (!point) return;
  draft.currentX = point.x;
  draft.currentY = point.y;
  // Detect which node (if any) is under the cursor so we can highlight it.
  draft.dropTargetId = nodeAtLayoutPoint(point.x, point.y);
  // Only the draft-edge preview moves — the static node/edge DOM is unchanged,
  // so rewrite just the overlay layer.
  scheduleOverlayRender();
}

export function endEdgeDrag(event: MouseEvent): void {
  const draft = state.canvasEdit && state.canvasEdit.draftEdge;
  window.removeEventListener("mousemove", _draftEdgeMoveBound!);
  window.removeEventListener("mouseup",   _draftEdgeUpBound!);
  _draftEdgeMoveBound = null;
  _draftEdgeUpBound = null;
  stopAutoPan();
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
  const effect = (state.canvasEdit.lastUsedEdgeEffect || EFFECT_OPTIONS[0]) as EffectKind;
  const newEdge = commitNewEdge(draft.fromNodeId, targetId, effect);
  if (newEdge && newEdge.id && typeof selectEdge === "function") {
    selectEdge(newEdge.id);
  } else {
    render();
  }
}

export function cancelDraftEdge(): boolean {
  if (!state.canvasEdit || !state.canvasEdit.draftEdge) return false;
  state.canvasEdit.draftEdge = null;
  stopAutoPan();
  if (_draftEdgeMoveBound) {
    window.removeEventListener("mousemove", _draftEdgeMoveBound);
    window.removeEventListener("mouseup",   _draftEdgeUpBound!);
    _draftEdgeMoveBound = null;
    _draftEdgeUpBound = null;
  }
  render();
  return true;
}

// Find the visible node whose bounding rect contains (x, y) in layout coords.
// Resolves the (stream, stage) cell first and then tests only that cell's
// stack: a point can only be inside a box that lives in the cell containing it,
// so scanning every node in the map (per mousemove, on the edge-drag path) was
// buying nothing. Falls back to the full scan when the layout has no cell index
// yet (first paint).
export function nodeAtLayoutPoint(x: number, y: number): string | null {
  const cellNodes = nodesInCellAt(x, y);
  if (!cellNodes) return null;
  for (const node of cellNodes) {
    if (!isNodeVisible(node)) continue;
    const pos = layout.positions[node.id];
    if (!pos) continue;
    if (x >= pos.x && x < pos.x + pos.width && y >= pos.y && y < pos.y + pos.height) {
      return node.id;
    }
  }
  return null;
}

// The nodes stacked in the cell under a layout point, or null when the point
// isn't over a cell at all. `undefined` cells (no nodes there) come back as an
// empty list. When the layout predates the cell index, the whole NODES array is
// returned so callers behave exactly as they did before.
function nodesInCellAt(x: number, y: number): GraphNode[] | null {
  if (!layout.cells) return NODES;
  const found = cellAtLayoutPoint(x, y);
  if (!found) return null;
  return layout.cells[found.stream.id + ":" + found.stage.id] || [];
}

// The nodes in one (stream, stage) cell, in NODES order — straight from the
// layout's cell index, with a scan as the fallback. Shared by the drag / hover
// hit-tests below, which all used to walk the whole NODES array per mousemove.
function cellNodesFor(streamId: string, stageId: string): GraphNode[] {
  if (layout.cells) return layout.cells[streamId + ":" + stageId] || [];
  return NODES.filter(n => n.stream === streamId && n.stage === stageId);
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
// How far (in pixels) the cursor must move with the button held before we treat
// it as a drag rather than a click — small wobbles while clicking shouldn't pick
// the box up and move it.
export const NODE_DRAG_THRESHOLD = 4;
export let _pendingNodeDrag: { nodeId: string; startClientX: number; startClientY: number } | null = null;
export let _nodeDragMoveBound: ((e: MouseEvent) => void) | null  = null;
export let _nodeDragUpBound: ((e: MouseEvent) => void) | null    = null;
export let _nodeDragSwallowClickBound: ((e: MouseEvent) => void) | null = null;

export function beginNodeDragCandidate(nodeId: string, clientX: number, clientY: number): void {
  _pendingNodeDrag = { nodeId: nodeId, startClientX: clientX, startClientY: clientY };
  _nodeDragMoveBound = (e) => maybePromoteNodeDrag(e);
  _nodeDragUpBound   = (e) => cleanupPendingNodeDrag(e);
  window.addEventListener("mousemove", _nodeDragMoveBound);
  window.addEventListener("mouseup",   _nodeDragUpBound);
}

export function maybePromoteNodeDrag(event: MouseEvent): void {
  if (!_pendingNodeDrag) return;
  const dx = event.clientX - _pendingNodeDrag.startClientX;
  const dy = event.clientY - _pendingNodeDrag.startClientY;
  if (Math.abs(dx) < NODE_DRAG_THRESHOLD && Math.abs(dy) < NODE_DRAG_THRESHOLD) return;
  const nodeId = _pendingNodeDrag.nodeId;
  // Tear down candidate listeners — startNodeDrag re-binds with the real handlers.
  window.removeEventListener("mousemove", _nodeDragMoveBound!);
  window.removeEventListener("mouseup",   _nodeDragUpBound!);
  _pendingNodeDrag = null;
  _nodeDragMoveBound = null;
  _nodeDragUpBound   = null;
  startNodeDrag(nodeId, event);
}

export function cleanupPendingNodeDrag(_event?: MouseEvent): void {
  if (!_pendingNodeDrag) return;
  const nodeId = _pendingNodeDrag.nodeId;
  window.removeEventListener("mousemove", _nodeDragMoveBound!);
  window.removeEventListener("mouseup",   _nodeDragUpBound!);
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

// The ids moving together in the current drag. Built ONCE at drag start (the
// membership can't change mid-gesture) instead of allocating a fresh Set inside
// every dropCellForDrag call — i.e. on every mousemove.
let _dragGroupSet: Set<string> | null = null;

function dragGroupSet(draggedNodeId: string): Set<string> {
  if (_dragGroupSet && _dragGroupSet.has(draggedNodeId)) return _dragGroupSet;
  const drag = state.canvasEdit && state.canvasEdit.draggingNode;
  return new Set((drag && drag.groupIds && drag.groupIds.length) ? drag.groupIds : [draggedNodeId]);
}

export function startNodeDrag(nodeId: string, event: MouseEvent): void {
  const point = clientPointToLayout(event.clientX, event.clientY);
  if (!point) return;
  _dragGroupSet = new Set(
    (state.selectedNodeIds.size > 1 && state.selectedNodeIds.has(nodeId))
      ? [...state.selectedNodeIds]
      : [nodeId],
  );
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
  _autoPanLastClient = { x: event.clientX, y: event.clientY };
  startAutoPan(updateNodeDrag);
  _nodeDragMoveBound = (e) => updateNodeDrag(e);
  _nodeDragUpBound   = (e) => endNodeDrag(e);
  window.addEventListener("mousemove", _nodeDragMoveBound);
  window.addEventListener("mouseup",   _nodeDragUpBound);
  setLayout(computeLayout());
  render();
}

export function updateNodeDrag(event: { clientX: number; clientY: number }): void {
  const drag = state.canvasEdit && state.canvasEdit.draggingNode;
  if (!drag) return;
  _autoPanLastClient = { x: event.clientX, y: event.clientY };
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
  if (!samePrev) {
    // Crossing into a new slot re-parts the static node stack → full render.
    setLayout(computeLayout());
    scheduleRender();
  } else {
    // Same slot: only the floating preview + drop-slot moved. Rewrite just the
    // overlay layer and leave the (potentially huge) node/edge DOM untouched.
    scheduleOverlayRender();
  }
}

export function endNodeDrag(event: MouseEvent): void {
  const drag = state.canvasEdit && state.canvasEdit.draggingNode;
  window.removeEventListener("mousemove", _nodeDragMoveBound!);
  window.removeEventListener("mouseup",   _nodeDragUpBound!);
  _nodeDragMoveBound = null;
  _nodeDragUpBound   = null;
  stopAutoPan();
  document.body.classList.remove("node-dragging");
  if (!drag) return;

  const point = clientPointToLayout(event.clientX, event.clientY);
  const target = point ? dropCellForDrag(point.x, point.y, drag.nodeId) : null;
  const node = nodeById[drag.nodeId];
  state.canvasEdit.draggingNode = null;
  _dragGroupSet = null;

  if (!node || !target) {
    setLayout(computeLayout());
    render();
    swallowNextClick();
    return;
  }

  if (drag.groupIds && drag.groupIds.length > 1) {
    if (!moveNodesToCell(drag.groupIds, target.streamId, target.stageId, target.insertIndex)) {
      setLayout(computeLayout());
      render();
    }
  } else if (!moveNodeToCell(node, target.streamId, target.stageId, target.insertIndex)) {
    // No-op (same cell, same slot). Still swallow the trailing click so the
    // node doesn't toggle selection just because we dragged it ~1 pixel.
    setLayout(computeLayout());
    render();
  }
  swallowNextClick();
}

export function cancelDraftNodeDrag(): boolean {
  if (!state.canvasEdit || !state.canvasEdit.draggingNode) return false;
  state.canvasEdit.draggingNode = null;
  _dragGroupSet = null;
  stopAutoPan();
  if (_nodeDragMoveBound) {
    window.removeEventListener("mousemove", _nodeDragMoveBound);
    window.removeEventListener("mouseup",   _nodeDragUpBound!);
    _nodeDragMoveBound = null;
    _nodeDragUpBound   = null;
  }
  document.body.classList.remove("node-dragging");
  setLayout(computeLayout());
  render();
  return true;
}

// Swallow the click event that fires after the drop. Without this, a drop on
// the dragged node's original cell would also trigger the node-group click
// handler (selectNode) and toggle selection. Mirrors the pan-end pattern in
// 17-events.js:422-425.
export function swallowNextClick(): void {
  if (_nodeDragSwallowClickBound) return;
  _nodeDragSwallowClickBound = (e) => {
    e.stopPropagation();
    e.preventDefault();
    window.removeEventListener("click", _nodeDragSwallowClickBound as EventListener, true);
    _nodeDragSwallowClickBound = null;
  };
  window.addEventListener("click", _nodeDragSwallowClickBound as EventListener, { capture: true, once: true });
  // Disarm on the next task if no click ever arrives — see the same note on the
  // pan-end swallow in 17-events.ts. Left armed, it eats the user's next click
  // anywhere in the app.
  const armed = _nodeDragSwallowClickBound;
  setTimeout(() => {
    if (_nodeDragSwallowClickBound !== armed) return;
    window.removeEventListener("click", armed as EventListener, true);
    _nodeDragSwallowClickBound = null;
  }, 0);
}

// ───── Marquee multi-select (shift+drag on empty canvas) ──────────────────
// A "marquee" is the dashed rectangle you drag across the canvas to select
// every box inside it — like rubber-banding files on a desktop (see
// docs/GLOSSARY.md). Mirrors the node-drag candidate→active pattern: a
// shift+mousedown on blank grid arms a candidate; crossing MARQUEE_DRAG_THRESHOLD
// promotes to a live marquee that updates the selection on every move; mouseup
// commits. A
// no-threshold mouseup is a shift+click: over a cell it creates a note at the
// placeholder slot, on bare canvas it's a no-op.
export const MARQUEE_DRAG_THRESHOLD = 4;
export let _pendingMarquee: { startClientX: number; startClientY: number } | null   = null;
export let _marqueeMoveBound: ((e: MouseEvent) => void) | null = null;
export let _marqueeUpBound: ((e: MouseEvent) => void) | null   = null;

export function beginMarqueeCandidate(clientX: number, clientY: number): void {
  _pendingMarquee = { startClientX: clientX, startClientY: clientY };
  _marqueeMoveBound = (e) => maybePromoteMarquee(e);
  _marqueeUpBound   = (e) => cleanupPendingMarquee(e);
  window.addEventListener("mousemove", _marqueeMoveBound);
  window.addEventListener("mouseup",   _marqueeUpBound);
}

export function maybePromoteMarquee(event: MouseEvent): void {
  if (!_pendingMarquee) return;
  const dx = event.clientX - _pendingMarquee.startClientX;
  const dy = event.clientY - _pendingMarquee.startClientY;
  if (Math.abs(dx) < MARQUEE_DRAG_THRESHOLD && Math.abs(dy) < MARQUEE_DRAG_THRESHOLD) return;
  const start = clientPointToLayout(_pendingMarquee.startClientX, _pendingMarquee.startClientY);
  window.removeEventListener("mousemove", _marqueeMoveBound!);
  window.removeEventListener("mouseup",   _marqueeUpBound!);
  _pendingMarquee = null;
  if (start) startMarquee(start, event);
}

export function cleanupPendingMarquee(_event?: MouseEvent): void {
  if (!_pendingMarquee) return;
  window.removeEventListener("mousemove", _marqueeMoveBound!);
  window.removeEventListener("mouseup",   _marqueeUpBound!);
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

// ───── Marquee hit-testing buckets ────────────────────────────────────────
// Neither the map's geometry nor node visibility can change while the user is
// dragging a selection box, so both are resolved ONCE at gesture start: one
// bucket per (stream, stage) cell, holding the visible nodes' rects and their
// NODES-order index. A move then tests only the cells the box actually touches,
// instead of re-walking every node (and re-running isNodeVisible on each) per
// mousemove. Hits are re-sorted into NODES order so the primary selection —
// the last hit — is exactly the one the old full scan picked.
interface MarqueeBucket {
  x1: number; y1: number; x2: number; y2: number;
  nodes: { id: string; idx: number; x: number; y: number; w: number; h: number }[];
}
let _marqueeBuckets: MarqueeBucket[] | null = null;

function buildMarqueeBuckets(): MarqueeBucket[] | null {
  if (!layout.cells) return null;
  const orderOf = new Map<string, number>();
  for (let i = 0; i < NODES.length; i++) orderOf.set(NODES[i].id, i);
  const buckets: MarqueeBucket[] = [];
  for (const key of Object.keys(layout.cells)) {
    const cellNodes = layout.cells[key];
    if (!cellNodes || !cellNodes.length) continue;
    const nodes: MarqueeBucket["nodes"] = [];
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const node of cellNodes) {
      if (!isNodeVisible(node)) continue;
      const p = layout.positions[node.id];
      if (!p) continue;
      nodes.push({ id: node.id, idx: orderOf.get(node.id) ?? 0, x: p.x, y: p.y, w: p.width, h: p.height });
      if (p.x < x1) x1 = p.x;
      if (p.y < y1) y1 = p.y;
      if (p.x + p.width  > x2) x2 = p.x + p.width;
      if (p.y + p.height > y2) y2 = p.y + p.height;
    }
    if (nodes.length) buckets.push({ x1, y1, x2, y2, nodes });
  }
  return buckets;
}

export function startMarquee(startPt: { x: number; y: number }, event: MouseEvent): void {
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
  _marqueeBuckets = buildMarqueeBuckets();
  updateMarqueeSelection();
  render();
}

export function updateMarquee(event: MouseEvent): void {
  const m = state.canvasEdit && state.canvasEdit.marquee;
  if (!m) return;
  const pt = clientPointToLayout(event.clientX, event.clientY);
  if (!pt) return;
  m.currentX = pt.x;
  m.currentY = pt.y;
  updateMarqueeSelection();
  // Nothing structural moves while the box is dragged: the rubber-band rect
  // lives in the overlay layer, and the covered set only changes node classes /
  // edge highlighting. Repaint those two, not the whole map.
  scheduleOverlayRender();
  scheduleSelectionStyling();
}

// Recompute the selection from the current marquee rect: any VISIBLE node whose
// position rect intersects the box is selected. Uses setSelection (no render) —
// the caller repaints once.
export function updateMarqueeSelection(): void {
  const m = state.canvasEdit && state.canvasEdit.marquee;
  if (!m) return;
  const x1 = Math.min(m.startX, m.currentX), x2 = Math.max(m.startX, m.currentX);
  const y1 = Math.min(m.startY, m.currentY), y2 = Math.max(m.startY, m.currentY);
  const hits: string[] = [];
  if (_marqueeBuckets) {
    const found: { id: string; idx: number }[] = [];
    for (const bucket of _marqueeBuckets) {
      if (bucket.x1 >= x2 || bucket.x2 <= x1 || bucket.y1 >= y2 || bucket.y2 <= y1) continue;
      for (const n of bucket.nodes) {
        if (n.x < x2 && n.x + n.w > x1 && n.y < y2 && n.y + n.h > y1) found.push(n);
      }
    }
    found.sort((a, b) => a.idx - b.idx);
    for (const n of found) hits.push(n.id);
  } else {
    for (const node of NODES) {
      if (!isNodeVisible(node)) continue;
      const p = layout.positions[node.id];
      if (!p) continue;
      if (p.x < x2 && p.x + p.width > x1 && p.y < y2 && p.y + p.height > y1) hits.push(node.id);
    }
  }
  setSelection(hits, hits.length ? hits[hits.length - 1] : null);
}

export function endMarquee(_event?: MouseEvent): void {
  window.removeEventListener("mousemove", _marqueeMoveBound!);
  window.removeEventListener("mouseup",   _marqueeUpBound!);
  _marqueeMoveBound = null;
  _marqueeUpBound   = null;
  document.body.classList.remove("marquee-selecting");
  state.canvasEdit.marquee = null;
  _marqueeBuckets = null;
  render();
  renderDetailPanel();
  if (typeof renderMultiSelectBar === "function") renderMultiSelectBar();
  saveUiStateToStorage();
  // Swallow the trailing click so it doesn't deselect everything we just boxed.
  swallowNextClick();
}

// Esc while a marquee is live: tear it down without disturbing the selection it
// produced so far. Returns true if it handled an active marquee.
export function cancelMarquee(): boolean {
  if (!state.canvasEdit || !state.canvasEdit.marquee) return false;
  state.canvasEdit.marquee = null;
  _marqueeBuckets = null;
  if (_marqueeMoveBound) {
    window.removeEventListener("mousemove", _marqueeMoveBound);
    window.removeEventListener("mouseup",   _marqueeUpBound!);
    _marqueeMoveBound = null;
    _marqueeUpBound   = null;
  }
  document.body.classList.remove("marquee-selecting");
  render();
  if (typeof renderMultiSelectBar === "function") renderMultiSelectBar();
  return true;
}

// Locate the (stream, stage) cell at a layout point, or null if the point is
// outside the grid, in a hidden row, or past the columns. Shared by the drag
// drop hit-test and the creation-placeholder hit-test below.
export function cellAtLayoutPoint(x: number, y: number): { stream: { id: string }; stage: { id: string } } | null {
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
    if (state.hiddenStages.has(stage.id)) continue;   // collapsed column isn't a target
    const left = layout.colX[stage.id];
    if (left === undefined) continue;
    const w = (layout.colWidths && layout.colWidths[stage.id]) || NODE_WIDTH;
    if (x >= left && x < left + w) { foundStage = stage; break; }
  }
  if (!foundStage) return null;

  return { stream: foundStream, stage: foundStage };
}

// Given a layout point, return the cell the cursor is over PLUS the insertion
// index inside that cell (0..siblingCount). The dragged node is excluded from
// sibling enumeration so its current slot isn't counted.
export function dropCellForDrag(x: number, y: number, draggedNodeId: string): { streamId: string; stageId: string; insertIndex: number } | null {
  const found = cellAtLayoutPoint(x, y);
  if (!found) return null;
  const { stream: foundStream, stage: foundStage } = found;

  // Exclude the ENTIRE drag group (not just the grabbed node) so insertIndex
  // is counted in the same group-excluded slot space the renderer drop-slot,
  // computeLayout's parted stack, and moveNodesToCell all use — otherwise a
  // group member sitting above the cursor in the target cell throws the index
  // (and the live gap / final order) off by one.
  const groupSet = dragGroupSet(draggedNodeId);
  const siblings: GraphNode[] = [];
  for (const n of cellNodesFor(foundStream.id, foundStage.id)) {
    if (!groupSet.has(n.id)) siblings.push(n);
  }

  // Insertion index = position before the first sibling whose vertical mid is
  // below the cursor. If past all of them, append. Walk the siblings' real
  // (variable) heights cumulatively rather than a fixed slot pitch — read each
  // height from layout (parting-independent), falling back to a fresh measure.
  const cellTopY = layout.rowY[foundStream.id] + ROW_PADDING;
  let offsetY = cellTopY;
  let insertIndex = siblings.length;
  for (let i = 0; i < siblings.length; i++) {
    const sp = layout.positions[siblings[i].id];
    const h = (sp && sp.height) || measureNode(siblings[i]).height;
    if (y < offsetY + h / 2) { insertIndex = i; break; }
    offsetY += h + NODE_GAP_Y;
  }
  return { streamId: foundStream.id, stageId: foundStage.id, insertIndex: insertIndex };
}

// Like dropCellForDrag, but for the shift-hover creation placeholder: it only
// returns a cell when the cursor sits in a GAP — between two notes, above the
// first note, or below the last (an empty cell is one big gap). Hovering over a
// note body returns null so the ghost doesn't appear while drawing an edge or
// shift-clicking notes to multi-select. The insert slot is the number of notes
// sitting entirely above the cursor. Uses the live layout positions, so it
// stays consistent whether or not the stack is already parted for a placeholder.
export function insertionGapCell(x: number, y: number): { streamId: string; stageId: string; insertIndex: number } | null {
  const found = cellAtLayoutPoint(x, y);
  if (!found) return null;
  const { stream: foundStream, stage: foundStage } = found;

  const siblings = cellNodesFor(foundStream.id, foundStage.id);

  // Empty cell — the whole cell is a gap.
  if (siblings.length === 0) {
    return { streamId: foundStream.id, stageId: foundStage.id, insertIndex: 0 };
  }

  // Over a note body → no placeholder. Otherwise the cursor is in a gap and the
  // insert slot is the count of notes sitting entirely above it.
  let insertIndex = 0;
  for (const n of siblings) {
    const pos = layout.positions[n.id];
    if (!pos) continue;
    if (y >= pos.y && y < pos.y + pos.height) return null; // over a note body
    if (pos.y + pos.height <= y) insertIndex++;             // note is above the cursor
  }
  return { streamId: foundStream.id, stageId: foundStage.id, insertIndex: insertIndex };
}

// Apply the move: mutate node.stream/stage and splice the global NODES array
// so the dragged node ends up at the right cell-relative slot. NODES order is
// what layout uses (siblings are stacked top-to-bottom by NODES array order),
// so a splice is all we need — no schema change, round-trips through CSV.
// Returns true if a real mutation happened, false on no-op.
export function moveNodeToCell(node: GraphNode, targetStreamId: string, targetStageId: string, cellInsertIdx: number): boolean {
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
export function moveNodesToCell(nodeIds: string[], targetStreamId: string, targetStageId: string, cellInsertIdx: number): boolean {
  if (!streamById[targetStreamId] || !stageById[targetStageId]) return false;
  if (typeof commitInlineRename === "function") commitInlineRename();
  const idSet = new Set(nodeIds);
  // Preserve the group's relative order as it sits in NODES today.
  const moving = NODES.filter(n => idSet.has(n.id));
  if (!moving.length) return false;

  // Pull the whole group out, then translate the cell-relative insert index to
  // a global index against the post-removal array (count only target-cell
  // siblings until we've passed cellInsertIdx of them).
  setNodes(NODES.filter(n => !idSet.has(n.id)));
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

export function commitNewEdge(fromNodeId: string, toNodeId: string, effect: EffectKind): Edge | null {
  if (!nodeById[fromNodeId] || !nodeById[toNodeId]) return null;
  if (fromNodeId === toNodeId) return null;
  // Skip duplicates — an edge with the same (from, to, effect) already exists.
  // Scan just the source node's outgoing edges (usually a handful) rather than
  // the whole EDGES array.
  for (const e of outgoingEdges[fromNodeId] || []) {
    if (e.to === toNodeId && e.effect === effect) return null;
  }
  const newEdge: Edge = {
    from: fromNodeId,
    to: toNodeId,
    effect: effect,
    description: "",
  };
  EDGES.push(newEdge);
  markEdgeGeometryChanged();
  state.canvasEdit.lastUsedEdgeEffect = effect;
  applyCanvasMutation();
  // rebuildIndexes() inside applyCanvasMutation mints an id for the new edge,
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

export const EDGE_CYCLE_SESSION_DEBOUNCE_MS = 1500;

export function cycleSelectedEdgeEffect(direction: number): boolean {
  if (state.uiMode !== "edit" || state.simulationMode) return false;
  const edgeId = state.selectedEdgeId;
  if (!edgeId) return false;
  const edge = edgeById[edgeId];
  if (!edge) return false;
  const currentIdx = EFFECT_OPTIONS.indexOf(edge.effect);
  if (currentIdx < 0) return false;
  const step = (direction < 0) ? -1 : 1;
  const nextIdx = (currentIdx + step + EFFECT_OPTIONS.length) % EFFECT_OPTIONS.length;
  const nextEffect = EFFECT_OPTIONS[nextIdx] as EffectKind;
  if (nextEffect === edge.effect) return false;

  // If a session is open for a DIFFERENT edge, close it before starting a new one.
  const existing = state.canvasEdit.edgeCycleSession;
  if (existing && existing.edgeId !== edgeId) {
    endEdgeCycleSession();
  }

  edge.effect = nextEffect;
  markEdgeGeometryChanged();
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
export function applyEdgeCycleSubsequent(): void {
  // Effect changes do not alter topology or layout, but they do alter solver,
  // Review, and sweep results. Reuse the shared mutation transaction so later
  // key presses cannot leave those surfaces stale; history remains coalesced.
  applyCanvasMutation({ impact: "calculation", skipHistoryCapture: true });
}

export function endEdgeCycleSession(): void {
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
export function deleteSelection(): boolean {
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
    setNodes(NODES.filter(n => !idSet.has(n.id)));
    setEdges(EDGES.filter(e => !idSet.has(e.from) && !idSet.has(e.to)));
    state.selectedNodeId = null;
    state.selectedNodeIds = new Set();
    state.ancestorSet = new Set();
    state.descendantSet = new Set();
    state.highlightedEdgeIds = new Set();
    applyCanvasMutation();   // auto-captures the pre-mutation snapshot → one undo step
    showUndoToast(idSet.size === 1 ? "Box deleted" : idSet.size + " boxes deleted", () => historyUndo());
    return true;
  }
  return false;
}

// Delete a single edge by id, push an undo snapshot, show the toast. Called
// from the edit panel's per-row × buttons.
export function deleteEdgeById(edgeId: string): void {
  const edge = edgeById[edgeId];
  if (!edge) return;
  const snapshot = {
    kind: "edge",
    edge: cloneEdgeForUndo(edge),
  };
  setEdges(EDGES.filter(e => e.id !== edgeId));
  pushUndo(snapshot);
  applyCanvasMutation();
  showUndoToast("Link deleted", () => restoreFromUndo(snapshot));
}
