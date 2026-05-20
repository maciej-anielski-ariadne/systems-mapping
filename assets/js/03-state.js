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
  hoveredNodeId: null,
  hiddenStreams: new Set(),
  hiddenCategories: new Set(),
  ancestorSet: new Set(),
  descendantSet: new Set(),
  highlightedEdgeIds: new Set(),
  simulationMode: false,
  userOverrides: {},      // nodeId → multiplier (1.0 = baseline)
  computedValues: {},     // nodeId → current value (recomputed on slider change)
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
