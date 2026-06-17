// =============================================================================
// SHARED STATE — global variables every other module reads/writes
// -----------------------------------------------------------------------------
// All other JS files refer to these variables by name (e.g. `NODES`, `state`,
// `nodeById`). They live here in one place so it's easy to see what state the
// whole app is tracking.
//
// IMPORTANT FOR EDITORS: anything declared with `let` (rather than `const`)
// gets re-assigned when a new CSV is loaded — see 06-data-loader.js.
// =============================================================================

// ───── Transient UI state ─────────────────────────────────────────────────
// What's selected / hovered / hidden, plus the cached set of upstream
// ("ancestor") and downstream ("descendant") nodes for the current selection.
const state = {
  selectedNodeId: null,
  // Multi-selection. selectedNodeId is the "primary" (last-clicked) member —
  // it drives the detail panel and ancestor/descendant highlighting; this Set
  // is the full membership. Invariant: when the Set is non-empty, selectedNodeId
  // is one of its members; when empty, selectedNodeId is null. A normal
  // single-select is just a Set of size 1. Built by the shift+drag marquee and
  // shift+click toggle (16e / 09). Not persisted — transient working mode.
  selectedNodeIds: new Set(),
  selectedEdgeId: null,     // mutually exclusive with selectedNodeId — set by
                            // selectEdge (09-graph-selection.js); cleared by
                            // selectNode / deselectAll. Drives the Delete-key
                            // dispatch in 16e and the .edge-path.selected CSS.
  hoveredNodeId: null,
  hiddenStreams: new Set(),
  hiddenCategories: new Set(),
  ancestorSet: new Set(),
  descendantSet: new Set(),
  highlightedEdgeIds: new Set(),
  simulationMode: false,
  userOverrides: {},      // nodeId → multiplier (1.0 = baseline)
  computedValues: {},     // nodeId → current value (recomputed on slider change)
  // Status of the most recent iterative solver run (07-simulation-engine.js).
  // converged=false means a positive feedback loop ran away (gain ≥ 1) and its
  // values were clamped; feedbackLoopCount mirrors cycleInfo.loopCount.
  solverStatus: { converged: true, iterations: 0, feedbackLoopCount: 0 },
  dataLoaded: false,      // false until a CSV has been loaded
  loadErrors: [],         // validation errors from the most recent load
  sidebarPinned: true,         // when false, left sidebar shows as a narrow strip and expands on hover
  detailPanelPinned: true,     // when false, right detail panel shows as a narrow strip and expands on hover
  sidebarWidth: 280,           // pinned left sidebar width in px (drag the divider to change; double-click resets)
  detailPanelWidth: 340,       // pinned right detail panel width in px (same UX as sidebarWidth)
  zoomLevel: 1.0,              // map zoom multiplier (0.25 .. 3.0). Applied to the SVG width/height.
  // Search — populated by 17a-search.js as the user types. searchMatches is
  // an array of { node, score, bestField, bestPositions } objects sorted by
  // descending score. searchFocusIndex points at the currently-selected row
  // in the dropdown (also auto-selected on the map).
  searchQuery: "",
  searchMatches: [],
  searchFocusIndex: 0,

  // Canvas direct-edit state. All transient — none of this is persisted.
  // See 16e-canvas-edit.js. The single source of truth for the map is still
  // NODES/EDGES/STREAMS/STAGES/CATEGORIES; this namespace just tracks what
  // the user is currently doing on-canvas (which empty cell is hovered, which
  // edge is being dragged, etc.).
  canvasEdit: {
    editMode: false,             // when false, detail panel is view-only — edit fields are hidden
                                 // behind the "Edit Node" toggle button. Persists across selections.
    shiftHeld: false,            // mirrors whether Shift is currently held down. Direct-manipulation
                                 // gestures on the canvas (ghost-cell click, edge-handle drag, node
                                 // drag-to-move) are gated on this so the map is read-only by default.
                                 // Maintained by initCanvasEdit's keydown/keyup/blur listeners.
    hoverCell: null,             // { streamId, stageId } | null — empty cell under cursor
    draggingNode: null,          // { nodeId, startClientX, startClientY, currentX, currentY,
                                 //   dropCell: { streamId, stageId, insertIndex } | null,
                                 //   active: false } — set on .node-group mousedown,
                                 //   promoted to active once cursor moves past NODE_DRAG_THRESHOLD.
    draftEdge: null,             // { fromNodeId, currentX, currentY } during edge drag
    marquee: null,               // { startX, startY, currentX, currentY } in LAYOUT
                                 // coords while a shift+drag-on-empty marquee is in
                                 // progress; null otherwise. See 16e-canvas-edit.js.
    flashedEdgeId: null,         // edge to flash-highlight in the outgoing list (after canvas click)
    addingEdgeFromNodeId: null,  // when truthy, edit panel shows the "Add outgoing edge" form
    editingSidebarItem: null,    // { kind: "stream"|"stage"|"category", id } when a sidebar row is pencil-expanded
    toast: null,                 // { message, undoFn, timerId } | null
    // While the user is type-renaming the selected node directly on the
    // canvas (no text-box overlay), this holds { nodeId, originalLabel,
    // started } so Esc can revert and applyCanvasMutation knows to fold the
    // whole edit into a single undo step. Cleared on commit / revert.
    // See 16h-canvas-inline-rename.js.
    inlineRename: null,
    // Arrow-key cursor for slot-level navigation when no node is selected.
    // { streamId, stageId, slotIndex } | null. slotIndex picks a specific
    // row within the stream (streams have as many slots as their busiest
    // cell). When set, the canvas renders a "Type to create" placeholder
    // at that exact slot, and a printable key creates a node there. See
    // 16i-canvas-keyboard-nav.js.
    cursorCell: null,
    // Active "Add outgoing edge" overlay launched from a node's edge handle.
    // { overlay: HTMLElement, fromNodeId, closeOutsideHandler } | null.
    edgePicker: null,
    // Last effect the user picked or cycled to. Seeds new edges (drag-drop
    // and the typeable target picker) so the common case is one keystroke /
    // one click. Session-only — not persisted. See 16e-canvas-edit.js.
    lastUsedEdgeEffect: "enables",
    // Active arrow-key cycle session on a selected edge. Coalesces a burst
    // of effect cycles into a single undo step. When non-null, mutations
    // skip applyCanvasMutation's history push; the saved snapshot is pushed
    // once when the session ends (deselect / select-other / blur / debounce).
    // { edgeId, startSnapshot, debounceTimer } | null.
    edgeCycleSession: null,
  },
  // Multi-level undo/redo. Each stack entry is the CSV string of a prior state.
  // applyCanvasMutation captures the pre-mutation snapshot from state.lastCsvSnapshot.
  // historyUndo / historyRedo (16g-canvas-undo.js) round-trip through loadDataFromCsv.
  history: {
    past:   [],   // CSV strings older → newer; current state is NOT included
    future: [],   // cleared on every fresh mutation
  },
  // Last CSV serialisation produced by applyCanvasMutation. This is the "pre" image
  // that the NEXT mutation will push onto history.past. Seeded by loadDataFromCsv
  // and bootEmptyStateGrid.
  lastCsvSnapshot: null,

  // Working copy used by the Build / Edit wizard (16a-builder-panel.js).
  // While the wizard is open the user mutates THIS rather than the live
  // STREAMS/STAGES/CATEGORIES/NODES/EDGES, so cancelling discards changes.
  // When the user clicks "Apply to map", the builder is serialised to CSV
  // and fed back through loadDataFromCsv().
  builder: {
    open: false,
    step: 1,                // 1..6 (streams, stages, categories, nodes, edges, review)
    streams: [],            // [{ id, label, short, color }]
    stages: [],             // [{ id, label }]
    categories: [],         // [{ id, label, color, textColor }] — array, not the runtime map
    defaults: { enables: 0.30, increases: 0.25, decreases: -0.25 },
    nodes: [],              // [{ id, label, description, stream, stage, category, baseline, unit, controllable, direction, sliderMax }]
    edges: [],              // [{ from, to, effect, elasticity, description }]
    // After a full re-render of the wizard, restore focus to this cell.
    // { section, index, field } — field=null means "first editable input in
    // that row". Consumed (and cleared) by renderBuilder().
    focusAfterRender: null,
  },
};

// ───── Data loaded from CSV (empty at startup) ────────────────────────────
let STREAMS = [];
let STAGES = [];
let CATEGORIES = {};
let NODES = [];
let EDGES = [];

// Used when an edge has no explicit elasticity. Overridden by the
// `defaults` section of the CSV.
let DEFAULT_ELASTICITY_BY_EFFECT = {
  enables: 0.30,
  increases: 0.25,
  decreases: -0.25,
};

// ───── Pre-computed indexes (rebuilt whenever data is reloaded) ───────────
let nodeById       = {};   // id → node
let outgoingEdges  = {};   // node id → array of edges leaving the node
let incomingEdges  = {};   // node id → array of edges entering the node
let streamById     = {};   // id → stream
let stageById      = {};   // id → stage (with extra `index` property)
let topologicalOrder = []; // node ids sorted so causes come before effects
                           // (feedback-loop nodes appended at the end)
// Feedback-loop membership, rebuilt by detectCycles() in 06-data-loader.js.
// backEdgeIds drives distinct edge rendering; inCycleNodeIds marks loop nodes;
// loopCount feeds state.solverStatus.feedbackLoopCount.
let cycleInfo = { inCycleNodeIds: new Set(), backEdgeIds: new Set(), loopCount: 0 };
let streamNodeCount   = {}; // stream id → count of nodes in that stream
let categoryNodeCount = {}; // category id → count of nodes in that category

// Layout result (set by 08-layout.js → computeLayout).
let layout = {
  positions: {},
  rowY: {},
  rowHeights: {},
  colX: {},
  totalWidth: 0,
  totalHeight: 0,
};
