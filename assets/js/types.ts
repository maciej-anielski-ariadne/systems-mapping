// =============================================================================
// DOMAIN TYPES — the shared vocabulary every module imports
// -----------------------------------------------------------------------------
// These describe the data model loaded from the CSV (streams/rows, stages/
// columns, categories, boxes/nodes, links/edges) plus the derived indexes,
// layout result, simulation output and transient UI state. Keeping them in one
// place means the parser, loader, simulation engine, layout, renderer and tests
// all agree on the exact shape of the data.
// =============================================================================

// ───── The three causal-link kinds an edge can carry ────────────────────────
export type EffectKind = "enables" | "increases" | "decreases";

// Outcome direction-of-merit. "" is the "(no preference)" option.
export type Direction = "" | "higher_better" | "lower_better" | "neutral";

// A category renders either as a box fill ("primary"; several blend into a
// gradient) or as a small corner chip ("secondary").
export type CategoryClass = "primary" | "secondary";

// ───── A stream = one horizontal ROW on the map ─────────────────────────────
export interface Stream {
  id: string;
  label: string;
  short: string;
  color: string;
}

// ───── A stage = one vertical COLUMN on the map ─────────────────────────────
export interface Stage {
  id: string;
  label: string;
}

// stageById entries carry the column's left-to-right position.
export interface StageWithIndex extends Stage {
  index: number;
}

// ───── A category (CATEGORIES is keyed by id) ───────────────────────────────
export interface Category {
  label: string;
  color: string;
  textColor: string;
  class: CategoryClass;
}

export type CategoryMap = Record<string, Category>;

// ───── A node = one BOX on the map ──────────────────────────────────────────
// Named GraphNode (not Node) to avoid clashing with the DOM `Node` interface.
export interface GraphNode {
  id: string;
  label: string;
  description: string;
  stream: string;
  stage: string;
  /** Primary anchor category id (the many features that key off ONE category). */
  category: string;
  /** Full multi-select: primaries first, then secondaries (round-trip stable). */
  categoryIds: string[];
  primaryCategories: string[];
  secondaryCategories: string[];

  // Optional quantification fields (enable simulation).
  baseline?: number;
  unit?: string;
  controllable?: boolean;
  direction?: Direction;
  sliderMax?: number;
}

// ───── A directed link = one ARROW between boxes ────────────────────────────
export interface Edge {
  /** Stable id "edge_N" assigned by rebuildIndexes(). */
  id?: string;
  from: string;
  to: string;
  effect: EffectKind;
  description: string;
  /** Per-link strength override; falls back to the effect's default. */
  elasticity?: number;
  /** Only stored when "dashed"; absence means a solid line. */
  style?: "dashed";
}

// ───── Default elasticities by effect (the `defaults` CSV section) ──────────
export interface ElasticityDefaults {
  enables: number;
  increases: number;
  decreases: number;
}

// ───── Derived feedback-loop info (rebuilt by detectCycles) ─────────────────
export interface CycleInfo {
  inCycleNodeIds: Set<string>;
  backEdgeIds: Set<string>;
  loopCount: number;
}

// ───── Layout result (produced by computeLayout) ────────────────────────────
export interface NodePosition {
  x: number;
  y: number;
  width: number;
  height: number;
  labelLines: string[];
}

export interface Layout {
  positions: Record<string, NodePosition>;
  rowY: Record<string, number>;
  rowHeights: Record<string, number>;
  colX: Record<string, number>;
  colWidths: Record<string, number>;
  totalWidth: number;
  totalHeight: number;
  /** (stream:stage) → nodes in that cell. Absent on the empty initial layout. */
  cells?: Record<string, GraphNode[]>;
}

// ───── Simulation solver status ─────────────────────────────────────────────
export interface SolverStatus {
  converged: boolean;
  iterations: number;
  feedbackLoopCount: number;
}

// nodeId → current computed value. computeNodeValues attaches a non-enumerable
// `__meta` describing the run; recomputeValues lifts it off.
export type ComputedValues = Record<string, number>;
export interface SolverMeta {
  converged: boolean;
  iterations: number;
}

// ───── Search (populated by 17a-search.js) ──────────────────────────────────
export interface SearchMatch {
  node: GraphNode;
  score: number;
  bestField?: string;
  bestPositions?: number[];
  [extra: string]: unknown;
}

// ───── Builder (working copy used by the Build / Edit wizard) ───────────────
// The wizard mutates these freely cell-by-cell, so rows are intentionally
// permissive (string ids, optional everything) until "Apply to map" serialises
// them back through the CSV pipeline.
export interface BuilderStream {
  id: string;
  label: string;
  short: string;
  color: string;
}
export interface BuilderStage {
  id: string;
  label: string;
}
export interface BuilderCategory {
  id: string;
  label: string;
  color: string;
  textColor: string;
  // Working copy — kept as a plain string so cell edits never fight the type
  // (validated/normalised back to "primary" | "secondary" on apply).
  class?: string;
}
export interface BuilderNode {
  id: string;
  label: string;
  description?: string;
  stream: string;
  stage: string;
  category?: string;
  categoryIds?: string[];
  baseline?: number | string;
  unit?: string;
  controllable?: boolean;
  direction?: string;
  sliderMax?: number | string;
}
export interface BuilderEdge {
  from: string;
  to: string;
  effect: EffectKind | string;
  elasticity?: number | string;
  style?: "dashed" | string;
  description?: string;
}

export type BuilderSection = "streams" | "stages" | "categories" | "nodes" | "edges";

export interface BuilderSort {
  key: string;
  dir: "asc" | "desc";
}

export interface BuilderState {
  open: boolean;
  step: number;
  streams: BuilderStream[];
  stages: BuilderStage[];
  categories: BuilderCategory[];
  defaults: ElasticityDefaults;
  nodes: BuilderNode[];
  edges: BuilderEdge[];
  selected: Set<number>;
  _lastRenderedStep: number | null;
  focusAfterRender: { section: BuilderSection; index: number; field: string | null } | null;
  // null = explicitly cleared (the table writes null to drop a column sort).
  sort: Partial<Record<BuilderSection, BuilderSort | null>>;
}

// ───── Canvas direct-edit transient state ───────────────────────────────────
// Highly transient working structures internal to the canvas-edit modules
// (16e/16f/16g/16h/16i). Typed loosely on purpose: these are interaction
// scratch state, not the persisted domain model.
export interface CellRef {
  streamId: string;
  stageId: string;
  insertIndex?: number;
}

export interface CanvasEditState {
  editMode: boolean;
  shiftHeld: boolean;
  hoverCell: CellRef | null;
  draggingNode: any | null;
  draftEdge: any | null;
  marquee: any | null;
  flashedEdgeId: string | null;
  flashedNodeIds: Set<string> | null;
  flashedEdgeIds: Set<string> | null;
  addingEdgeFromNodeId: string | null;
  toast: { message: string; undoFn?: () => void; timerId?: number } | null;
  inlineRename: { nodeId: string; originalLabel: string; started: boolean } | null;
  cursorCell: { streamId: string; stageId: string; slotIndex: number } | null;
  edgePicker: any | null;
  lastUsedEdgeEffect: EffectKind;
  edgeCycleSession: any | null;
  /** Transient guard set by the detail panel when it unlocks edit mode, so the
   *  same click that unlocked doesn't immediately re-lock. */
  _justUnlocked?: boolean;
}

export interface History {
  past: string[];
  future: string[];
}

// ───── Top-level application state (the `state` singleton) ───────────────────
export interface AppState {
  selectedNodeId: string | null;
  selectedNodeIds: Set<string>;
  selectedEdgeId: string | null;
  hoveredNodeId: string | null;
  hiddenStreams: Set<string>;
  hiddenCategories: Set<string>;
  hiddenStages: Set<string>;
  hiddenEffects: Set<string>;
  hiddenStyles: Set<string>;
  hiddenTrace: Set<string>;
  ancestorSet: Set<string>;
  descendantSet: Set<string>;
  highlightedEdgeIds: Set<string>;
  simulationMode: boolean;
  userOverrides: Record<string, number>;
  computedValues: ComputedValues;
  solverStatus: SolverStatus;
  dataLoaded: boolean;
  loadErrors: string[];
  sidebarPinned: boolean;
  detailPanelPinned: boolean;
  sidebarWidth: number;
  detailPanelWidth: number;
  zoomLevel: number;
  highlightDepth: number;
  searchQuery: string;
  searchMatches: SearchMatch[];
  searchFocusIndex: number;
  canvasEdit: CanvasEditState;
  history: History;
  lastCsvSnapshot: string | null;
  builder: BuilderState;
}
