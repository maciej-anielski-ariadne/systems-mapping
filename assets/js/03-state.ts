// =============================================================================
// SHARED STATE — global variables every other module reads/writes
// -----------------------------------------------------------------------------
// All other modules import these by name (e.g. `NODES`, `state`, `nodeById`).
// They live here in one place so it's easy to see what state the whole app is
// tracking.
//
// ESM note: the arrays/maps below are declared with `let` and get RE-ASSIGNED
// when a new CSV loads (see 06-data-loader.ts). Because ES module imports are
// *live bindings*, every module that imports e.g. `NODES` automatically sees the
// latest value after a reload — but only this module may reassign them. Other
// modules therefore call the exported `setX()` helpers instead of assigning.
// =============================================================================

import type {
  AppState,
  Category,
  CategoryMap,
  CycleInfo,
  Edge,
  ElasticityDefaults,
  GraphNode,
  Layout,
  Stage,
  StageWithIndex,
  Stream,
} from "./types";

// ───── Transient UI state ─────────────────────────────────────────────────
// What's selected / hovered / hidden, plus the cached set of upstream
// ("ancestor") and downstream ("descendant") nodes for the current selection.
export const state: AppState = {
  selectedNodeId: null,
  // Multi-selection. selectedNodeId is the "primary" (last-clicked) member —
  // it drives the detail panel and ancestor/descendant highlighting; this Set
  // is the full membership. Invariant: when the Set is non-empty, selectedNodeId
  // is one of its members; when empty, selectedNodeId is null. A normal
  // single-select is just a Set of size 1. Built by the shift+drag marquee and
  // shift+click toggle (16e / 09). Not persisted — transient working mode.
  selectedNodeIds: new Set(),
  selectedEdgeId: null, // mutually exclusive with selectedNodeId — set by
  // selectEdge (09-graph-selection.ts); cleared by
  // selectNode / deselectAll. Drives the Delete-key
  // dispatch in 16e and the .edge-path.selected CSS.
  hoveredNodeId: null,
  hiddenStreams: new Set(),
  hiddenCategories: new Set(),
  hiddenStages: new Set(),
  hiddenEffects: new Set(), // edge effects hidden via the "Edge types" filter
  hiddenStyles: new Set(), // edge line styles ("solid"/"dashed") hidden via "Line style"
  hiddenTrace: new Set(), // "ancestors"/"descendants" suppressed in the causal trace
  ancestorSet: new Set(),
  descendantSet: new Set(),
  highlightedEdgeIds: new Set(),
  simulationMode: false,
  userOverrides: {}, // nodeId → multiplier (1.0 = baseline)
  computedValues: {}, // nodeId → current value (recomputed on slider change)
  // Status of the most recent iterative solver run (07-simulation-engine.ts).
  // converged=false means a positive feedback loop ran away (gain ≥ 1) and its
  // values were clamped; feedbackLoopCount mirrors cycleInfo.loopCount.
  solverStatus: { converged: true, iterations: 0, feedbackLoopCount: 0 },
  dataLoaded: false, // false until a CSV has been loaded
  loadErrors: [], // validation errors from the most recent load
  sidebarPinned: true, // when false, left sidebar shows as a narrow strip and expands on hover
  detailPanelPinned: true, // when false, right detail panel shows as a narrow strip and expands on hover
  sidebarWidth: 280, // pinned left sidebar width in px (drag the divider to change; double-click resets)
  detailPanelWidth: 340, // pinned right detail panel width in px (same UX as sidebarWidth)
  zoomLevel: 1.0, // map zoom multiplier (0.25 .. 3.0). Applied to the SVG width/height.
  highlightDepth: 1, // how many connection levels to highlight on node select. 1 = direct neighbours only; capped at `maxHighlightDepth` (the deepest hop the current map can actually reach).
  // Search — populated by 17a-search.ts as the user types. searchMatches is
  // an array of { node, score, bestField, bestPositions } objects sorted by
  // descending score. searchFocusIndex points at the currently-selected row
  // in the dropdown (also auto-selected on the map).
  searchQuery: "",
  searchMatches: [],
  searchFocusIndex: 0,

  // Canvas direct-edit state. All transient — none of this is persisted.
  // See 16e-canvas-edit.ts. The single source of truth for the map is still
  // NODES/EDGES/STREAMS/STAGES/CATEGORIES; this namespace just tracks what
  // the user is currently doing on-canvas (which empty cell is hovered, which
  // edge is being dragged, etc.).
  canvasEdit: {
    editMode: false, // when false, detail panel is view-only — edit fields are hidden
    // behind the "Edit Node" toggle button. Persists across selections.
    shiftHeld: false, // mirrors whether Shift is currently held down. Direct-manipulation
    // gestures on the canvas (ghost-cell click, edge-handle drag, node
    // drag-to-move) are gated on this so the map is read-only by default.
    // Maintained by initCanvasEdit's keydown/keyup/blur listeners.
    hoverCell: null, // { streamId, stageId, insertIndex } | null — placeholder cell under
    // cursor while Shift is held. insertIndex (0..siblingCount) is the
    // slot the new note would land in; siblings at/after it displace down.
    draggingNode: null, // { nodeId, startClientX, startClientY, currentX, currentY,
    //   dropCell: { streamId, stageId, insertIndex } | null,
    //   active: false } — set on .node-group mousedown,
    //   promoted to active once cursor moves past NODE_DRAG_THRESHOLD.
    draftEdge: null, // { fromNodeId, currentX, currentY } during edge drag
    marquee: null, // { startX, startY, currentX, currentY } in LAYOUT
    // coords while a shift+drag-on-empty marquee is in
    // progress; null otherwise. See 16e-canvas-edit.ts.
    flashedEdgeId: null, // edge to flash-highlight in the outgoing list (after canvas click)
    flashedNodeIds: null, // Set<nodeId> to pulse after an undo/redo (transient; null when idle)
    flashedEdgeIds: null, // Set<edgeId> to pulse after an undo/redo (transient; null when idle)
    addingEdgeFromNodeId: null, // when truthy, edit panel shows the "Add outgoing edge" form
    toast: null, // { message, undoFn, timerId } | null
    // While the user is type-renaming the selected node directly on the
    // canvas (no text-box overlay), this holds { nodeId, originalLabel,
    // started } so Esc can revert and applyCanvasMutation knows to fold the
    // whole edit into a single undo step. Cleared on commit / revert.
    // See 16h-canvas-inline-rename.ts.
    inlineRename: null,
    // Arrow-key cursor for slot-level navigation when no node is selected.
    // { streamId, stageId, slotIndex } | null. slotIndex picks a specific
    // row within the stream (streams have as many slots as their busiest
    // cell). When set, the canvas renders a "Type to create" placeholder
    // at that exact slot, and a printable key creates a node there. See
    // 16i-canvas-keyboard-nav.ts.
    cursorCell: null,
    // Active "Add outgoing edge" overlay launched from a node's edge handle.
    // { overlay: HTMLElement, fromNodeId, closeOutsideHandler } | null.
    edgePicker: null,
    // Last effect the user picked or cycled to. Seeds new edges (drag-drop
    // and the typeable target picker) so the common case is one keystroke /
    // one click. Session-only — not persisted. See 16e-canvas-edit.ts.
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
  // historyUndo / historyRedo (16g-canvas-undo.ts) round-trip through loadDataFromCsv.
  history: {
    past: [], // CSV strings older → newer; current state is NOT included
    future: [], // cleared on every fresh mutation
  },
  // Last CSV serialisation produced by applyCanvasMutation. This is the "pre" image
  // that the NEXT mutation will push onto history.past. Seeded by loadDataFromCsv
  // and bootEmptyStateGrid.
  lastCsvSnapshot: null,

  // Working copy used by the Build / Edit wizard (16a-builder-state.ts).
  // While the wizard is open the user mutates THIS rather than the live
  // STREAMS/STAGES/CATEGORIES/NODES/EDGES, so cancelling discards changes.
  // When the user clicks "Apply to map", the builder is serialised to CSV
  // and fed back through loadDataFromCsv().
  builder: {
    open: false,
    step: 1, // 1..6 (streams, stages, categories, nodes, edges, review)
    streams: [], // [{ id, label, short, color }]
    stages: [], // [{ id, label }]
    categories: [], // [{ id, label, color, textColor }] — array, not the runtime map
    defaults: { enables: 0.3, increases: 0.25, decreases: -0.25 },
    nodes: [], // [{ id, label, description, stream, stage, category, baseline, unit, controllable, direction, sliderMax }]
    edges: [], // [{ from, to, effect, elasticity, description }]
    // Bulk-select state for the wizard tables — a Set of ROW INDICES in the
    // currently-visible step's section. Index-based and reset on any change
    // that shifts indices (delete/duplicate/reorder) and on step change, so a
    // stale index can never edit/delete the wrong row. See 16b/16d.
    selected: new Set(),
    // The step renderBuilder last painted — lets it tell a step change (reset
    // scroll to top) from an in-step re-render (preserve scrollTop).
    _lastRenderedStep: null,
    // After a full re-render of the wizard, restore focus to this cell.
    // { section, index, field } — field=null means "first editable input in
    // that row". Consumed (and cleared) by renderBuilder().
    focusAfterRender: null,
    // View-only column sort for the big tables — { nodes:{key,dir}, edges:{key,dir} }.
    // Reorders the DISPLAY only (rows keep their original array data-index), so it
    // never mutates the row arrays or the saved/exported CSV order. Not persisted.
    sort: {},
  },
};

// ───── Data loaded from CSV (empty at startup) ────────────────────────────
// Reassignable via the setters below. Importers read the live binding directly.
export let STREAMS: Stream[] = [];
export let STAGES: Stage[] = [];
export let CATEGORIES: CategoryMap = {};
export let NODES: GraphNode[] = [];
export let EDGES: Edge[] = [];

// Used when an edge has no explicit elasticity. Overridden by the
// `defaults` section of the CSV.
export let DEFAULT_ELASTICITY_BY_EFFECT: ElasticityDefaults = {
  enables: 0.3,
  increases: 0.25,
  decreases: -0.25,
};

// ───── Pre-computed indexes (rebuilt whenever data is reloaded) ───────────
export let nodeById: Record<string, GraphNode> = {}; // id → node
export let edgeById: Record<string, Edge> = {}; // edge id → edge (rebuilt with the edge ids in rebuildIndexes)
export let outgoingEdges: Record<string, Edge[]> = {}; // node id → edges leaving the node
export let incomingEdges: Record<string, Edge[]> = {}; // node id → edges entering the node
export let streamById: Record<string, Stream> = {}; // id → stream
export let stageById: Record<string, StageWithIndex> = {}; // id → stage (with extra `index`)
export let topologicalOrder: string[] = []; // node ids sorted so causes come before effects
// (feedback-loop nodes appended at the end)
// Feedback-loop membership, rebuilt by detectCycles() in 06-data-loader.ts.
// backEdgeIds drives distinct edge rendering; inCycleNodeIds marks loop nodes;
// loopCount feeds state.solverStatus.feedbackLoopCount.
export let cycleInfo: CycleInfo = {
  inCycleNodeIds: new Set(),
  backEdgeIds: new Set(),
  loopCount: 0,
};
export let streamNodeCount: Record<string, number> = {}; // stream id → count of nodes
export let categoryNodeCount: Record<string, number> = {}; // category id → count of nodes
export let maxHighlightDepth = 1; // deepest highlight hop the current map can reach (longest shortest-path distance, up- or downstream). Recomputed by rebuildIndexes; the depth control uses it as a dynamic cap instead of a fixed ceiling.

// Layout result (set by 08-layout.ts → computeLayout).
export let layout: Layout = {
  positions: {},
  rowY: {},
  rowHeights: {},
  colX: {},
  colWidths: {},
  totalWidth: 0,
  totalHeight: 0,
};

// ───── Setters — the only sanctioned way to reassign the bindings above ─────
// (Other modules import these instead of assigning, because an imported binding
// is read-only from the consumer's side.)
export function setStreams(value: Stream[]): void {
  STREAMS = value;
}
export function setStages(value: Stage[]): void {
  STAGES = value;
}
export function setCategories(value: CategoryMap): void {
  CATEGORIES = value;
}
export function setNodes(value: GraphNode[]): void {
  NODES = value;
}
export function setEdges(value: Edge[]): void {
  EDGES = value;
}
export function setDefaultElasticityByEffect(value: ElasticityDefaults): void {
  DEFAULT_ELASTICITY_BY_EFFECT = value;
}
export function setNodeById(value: Record<string, GraphNode>): void {
  nodeById = value;
}
export function setEdgeById(value: Record<string, Edge>): void {
  edgeById = value;
}
export function setOutgoingEdges(value: Record<string, Edge[]>): void {
  outgoingEdges = value;
}
export function setIncomingEdges(value: Record<string, Edge[]>): void {
  incomingEdges = value;
}
export function setStreamById(value: Record<string, Stream>): void {
  streamById = value;
}
export function setStageById(value: Record<string, StageWithIndex>): void {
  stageById = value;
}
export function setTopologicalOrder(value: string[]): void {
  topologicalOrder = value;
}
export function setCycleInfo(value: CycleInfo): void {
  cycleInfo = value;
}
export function setStreamNodeCount(value: Record<string, number>): void {
  streamNodeCount = value;
}
export function setCategoryNodeCount(value: Record<string, number>): void {
  categoryNodeCount = value;
}
export function setMaxHighlightDepth(value: number): void {
  maxHighlightDepth = value;
}
export function setLayout(value: Layout): void {
  layout = value;
}
