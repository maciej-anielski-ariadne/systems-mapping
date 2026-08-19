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

// ───── How a box combines the arrows pointing into it ───────────────────────
// The simulation works in RATIOS (each input's "how far from its starting
// value" figure), so these three rules all compose with the existing links and
// strengths — see docs/CALCULATION-ENGINE-DESIGN.md §3.2.
//   • "multiplicative" — today's default: independent percentage effects that
//     compound (the Cobb-Douglas rule; see docs/GLOSSARY.md).
//   • "additive"       — effects add up instead of compounding, so two related
//     inputs don't overstate the result.
//   • "min"            — the weakest input gates the outcome ("you need ALL of
//     these"), rather than any one input carrying it on its own.
export type CombineMode = "multiplicative" | "additive" | "min";

// ───── A param = a named constant that never renders as a box ───────────────
// Technical constants (route shares, detection rates, conversion factors) that
// belong to the calculation model but would make the visual map unreadable if
// drawn. Loaded from the optional `# SECTION: params` CSV block and referenced
// by id from node formulas.
export interface Param {
  id: string;
  value: number;
  description: string;
}

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

  // Optional per-box calculation rules (all blank in an existing CSV, which is
  // why old maps compute exactly as before). See
  // docs/CALCULATION-ENGINE-DESIGN.md §3.
  /** How incoming link effects aggregate. Absent = "multiplicative". */
  combine?: CombineMode;
  /** Raw expression text, e.g. "min(demand, capacity)". Stored verbatim from
   *  the CSV; parsing/validation happens in the calculation engine. */
  formula?: string;
  /** Hard lower bound applied after the rule runs (absolute value, not a ratio). */
  minValue?: number;
  /** Hard upper bound applied after the rule runs (absolute value, not a ratio). */
  maxValue?: number;
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

// nodeId → current computed value. Run diagnostics travel alongside via
// getSolverDiagnostics() in 07-simulation-engine (the old non-enumerable
// `__meta` side-channel is gone).
export type ComputedValues = Record<string, number>;
export interface SolverMeta {
  converged: boolean;
  iterations: number;
}

// ───── Traceability: "how was this number calculated?" ──────────────────────
// The engine records one explanation per box so the detail panel can show the
// working — which rule ran, what fed into it, and whether a bound bit. Every
// figure on the map is therefore auditable back to its inputs.
// (See docs/CALCULATION-ENGINE-DESIGN.md §4.)

// Which rule produced a box's value.
//   • "pinned"   — the user is holding this box at a value with a slider.
//   • "baseline" — nothing feeds in (or nothing to compute), so it sits at its
//     starting value.
//   • "multiplicative" / "additive" / "min" — the box's `combine` rule ran over
//     its incoming links.
//   • "formula"  — the box's `formula` expression produced the value.
export type CalcRule = "pinned" | "baseline" | "multiplicative" | "additive" | "min" | "formula";

// One thing that fed into a box's value: either another box or a param.
// For the link-based rules (multiplicative / additive / min):
//   • `ratio`        = the source's value ÷ its starting value (how far it moved);
//   • `elasticity`   = the strength of that link;
//   • `contribution` = that single link's term in the rule.
// For formulas only `value` (and `delayed`) are meaningful — a formula reads
// absolute values, not ratios. ("Elasticity"/"ratio": see docs/GLOSSARY.md.)
export interface TraceInput {
  id: string;
  kind: "node" | "param";
  value: number;
  /** True when the value came from the PREVIOUS solver sweep — i.e. read via
   *  delay(), the trick that makes feedback loops well-defined. */
  delayed?: boolean;
  elasticity?: number;
  ratio?: number;
  contribution?: number;
}

// The full working for one box's value.
export interface NodeExplanation {
  rule: CalcRule;
  inputs: TraceInput[];
  /** The raw expression text, when rule === "formula". */
  formula?: string;
  /** Present ONLY when a min/max bound actually changed the number; `from` is
   *  the pre-clamp value. Absent means no bound bit. */
  clamp?: { from: number; min?: number; max?: number };
  /** A division by zero was guarded at runtime (result treated as 0). */
  dividedByZero?: boolean;
  /** Ids the rule expected but couldn't resolve to a value. */
  missingInputs?: string[];
  /** The final value, after any clamp — matches state.computedValues[id]. */
  value: number;
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
  // Per-box calculation rules, edited on the wizard's Boxes step (step 4) in
  // the columns after the simulation fields, and round-tripped back out on
  // "Apply to map" / "Download CSV".
  combine?: string;
  formula?: string;
  minValue?: number | string;
  maxValue?: number | string;
}
export interface BuilderEdge {
  from: string;
  to: string;
  effect: EffectKind | string;
  elasticity?: number | string;
  style?: "dashed" | string;
  description?: string;
}

export type BuilderSection = "streams" | "stages" | "categories" | "nodes" | "edges" | "params";

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
  // Hidden calculation constants, edited on the wizard's Constants step (step 6)
  // and written back out on apply. Still optional: undefined means "the wizard
  // never saw them" (e.g. a builder object saved before the step existed), which
  // the serializer reads as "keep the live map's params".
  params?: Param[];
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
// ───── Pathway mode ────────────────────────────────────────────────────────
// A "strand" is one ordered chain of boxes from a cause to an effect. Note the
// shape: every other traversal result in this app is a Set (ancestorSet,
// descendantSet, highlightedEdgeIds) because neighbourhood highlighting has no
// order. A route DOES — that ordering is the whole point, so it is a list.
export interface PathwayRoute {
  /** Boxes in causal order, start first. Always at least two long. */
  nodeIds: string[];
  /** The links between them: edgeIds[i] joins nodeIds[i] → nodeIds[i + 1]. */
  edgeIds: string[];
  /** Product of |elasticity| along the chain — how much cause actually
   *  survives the trip. Bigger is stronger; always > 0. */
  strength: number;
  /** Product of the elasticity SIGNS. +1 = raising the start raises the end;
   *  -1 = it lowers it. Two `decreases` links make a net increase, which is
   *  the single most commonly botched inference on a causal map. */
  sign: 1 | -1;
}

export interface PathwayState {
  /** Which box the strand starts / ends at. Null when pathway mode is off. */
  fromId: string | null;
  toId: string | null;
  /** The strongest few routes, strongest first. Empty = pathway mode is off. */
  routes: PathwayRoute[];
  /** Which of `routes` is on screen. Always a valid index when routes is
   *  non-empty. */
  routeIndex: number;
  /** How many routes actually exist between the two ends — including the ones
   *  `routes` dropped. Reported to the user verbatim: a map that hides what it
   *  truncated stops being trustworthy. */
  totalRoutes: number;
  /** True when the search hit its budget before enumerating everything, so
   *  totalRoutes is a floor rather than an exact count (shown as "47+"). */
  truncated: boolean;
  /** "map" = isolate the strand in place; "ribbon" = straighten it into a line. */
  view: "map" | "ribbon";
}

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
  /** nodeId → the working behind that node's computed value (see
   *  NodeExplanation). Rebuilt with computedValues; `{}` before the first run. */
  explanations: Record<string, NodeExplanation>;
  solverStatus: SolverStatus;
  dataLoaded: boolean;
  loadErrors: string[];
  /** "read" (default) = the map with the chrome out of the way; "edit" = the
   *  docked panels and the authoring controls. Persisted with the UI state. */
  uiMode: "read" | "edit";
  /** Reading mode only: the left panel is open as an overlay drawer. */
  filtersOpen: boolean;
  sidebarPinned: boolean;
  detailPanelPinned: boolean;
  sidebarWidth: number;
  detailPanelWidth: number;
  zoomLevel: number;
  highlightDepth: number;
  searchQuery: string;
  searchMatches: SearchMatch[];
  searchFocusIndex: number;
  /** Pathway mode — one strand traced from start to finish. Transient:
   *  never persisted, so a refresh drops you back on the whole map. */
  pathway: PathwayState;
  /** The pathway atlas — everything downstream of one box, open over the map.
   *  null when it is closed. Transient, like a strand: it is a way of reading
   *  the map, not a property of it. */
  atlas: { startId: string } | null;
  canvasEdit: CanvasEditState;
  history: History;
  lastCsvSnapshot: string | null;
  builder: BuilderState;
}
