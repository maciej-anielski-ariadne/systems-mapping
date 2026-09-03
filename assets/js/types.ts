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

// ───── Evidence carried by a causal claim ─────────────────────────────────────
// Evidence is descriptive provenance, not a simulation input. A link records
// the support for that causal relationship; a formula records the support for
// the rule itself. The loader materialises "unspecified" for legacy files, but
// these properties remain optional at the type boundary so older programmatic
// GraphNode / Edge object literals remain source-compatible.
export type EvidenceStatus =
  | "unspecified"
  | "hypothesis"
  | "supported"
  | "calibrated"
  | "validated";

export interface EvidenceMetadata {
  status: EvidenceStatus;
  rationale?: string;
  source?: string;
  lastReviewed?: string;
}

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
  /** Informational provenance for the authored formula; never changes maths. */
  formulaEvidence?: EvidenceMetadata;
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
  /** Informational provenance for this causal link; never changes maths. */
  evidence?: EvidenceMetadata;
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

// ───── Load findings (what the loader noticed, structured) ──────────────────
// Every check the loader runs reports through here. These used to be plain
// strings, which was fine while the only reader was console.warn — but a string
// cannot be grouped, sorted, counted by severity, or clicked through to the box
// it is about, and on a map of any size those are the four things the reader
// needs. The message text is unchanged; what is new is that the finding still
// knows which box it came from and what the engine did about it.
//
// SEVERITY is about consequence, not about how cross to be:
//   "ignored"  — the engine threw away something you typed (a formula it could
//                not read, a slider max that made no sense). What is on the map
//                is not what is in the file.
//   "wrong"    — the number is not the one you declared (a box that does not
//                rest at its starting value, a limit that bit). It computes,
//                but every % change on it is read against the wrong anchor.
//   "mismatch" — the picture and the maths disagree while the number is fine
//                (a link the formula never reads). Often deliberate.
export type FindingSeverity = "ignored" | "wrong" | "mismatch";

export interface Finding {
  /** Short machine name for the check that produced this, e.g. "formula-unreadable".
   *  Groups identical findings and keys the "acknowledged" set. */
  kind: string;
  severity: FindingSeverity;
  /** The box this is about, when there is one. Makes the finding clickable. */
  boxId?: string;
  /** What is wrong, in plain language. The full sentence, as before. */
  message: string;
  /** What the reader should do about it. Optional — some findings are FYI. */
  fix?: string;
  /** Set by attributeFindings() (22-review.ts) when this finding is only the
   *  downstream shadow of another box's mistake: the id of the box actually at
   *  fault. A finding with this set is a consequence, not a job. */
  causedBy?: string;
  /** Stable identity for an exact problem. Messages are presentation text and
   *  can change; Review uses this key to compare a proposed fix with the same
   *  detached model after the patch has been applied. */
  issueKey?: string;
  /** Machine-readable evidence for checks that can name the exact field or
   *  connection involved. Findings without a target remain navigation-only. */
  target?: ReviewFindingTarget;
}

export type ReviewNodeField =
  | "baseline"
  | "controllable"
  | "combine"
  | "formula"
  | "minValue"
  | "maxValue";

export type ReviewFindingTarget =
  | { kind: "node-field"; nodeId: string; field: ReviewNodeField }
  | { kind: "formula-reference"; nodeId: string; referencedId: string }
  | { kind: "connection"; sourceId: string; targetId: string };

export type ReviewFixOperation =
  | { kind: "set-node-field"; nodeId: string; field: ReviewNodeField; value: string | number | boolean | undefined }
  | { kind: "add-connection"; sourceId: string; targetId: string; effect: EffectKind; elasticity?: number }
  | { kind: "remove-connection"; sourceId: string; targetId: string }
  | { kind: "update-connection"; sourceId: string; targetId: string; effect: EffectKind; elasticity?: number };

export interface ReviewProposal {
  id: string;
  label: string;
  explanation: string;
  operations: ReviewFixOperation[];
}

export interface ReviewValueChange {
  nodeId: string;
  label: string;
  before: number;
  after: number;
  percentChange: number | null;
}

export interface ReviewProposalPreview {
  issuesCleared: number;
  issuesIntroduced: number;
  remainingIssueCount: number;
  valueChanges: ReviewValueChange[];
}

// ───── The review record (24-review-record.ts) ──────────────────────────────
// One verdict per box, about the set of links feeding it. `fingerprint` is what
// makes it an audit record rather than theatre: it captures what was actually
// reviewed, so editing any of it retires the verdict instead of leaving a stale
// sign-off standing.
/**
 * "none" is a record with no judgement in it — a comment somebody left, or a
 * link they marked, before deciding. It exists so that writing something down
 * is never the same act as flagging the box, and so that taking a flag back
 * does not take the reason for it with them.
 */
export type Verdict = "agreed" | "flagged" | "none";

export interface ReviewEntry {
  boxId: string;
  verdict: Verdict;
  reviewer: string;
  /** ISO date, yyyy-mm-dd. */
  date: string;
  note: string;
  fingerprint: string;
  /** Source box ids flagged individually — "this one input is wrong", which is
   *  actionable where "something in this list is wrong" is not. */
  flaggedSources: string[];
  /** When the concern was RAISED, and by whom — kept even after it is closed
   *  out, because `reviewer` / `date` then name whoever closed it. Empty on a
   *  box nobody has ever flagged. Only the latest cycle is kept: flag it, close
   *  it, flag it again and the first pair is overwritten. */
  flaggedOn: string;
  flaggedBy: string;
  /** When a flag was closed out, and by whom. Empty while one is open, and
   *  cleared again if the box is re-flagged, so "addressed" never describes an
   *  open concern. Kept apart from `reviewer` because that names whoever gave
   *  the LATEST verdict — one more edit and it no longer names the closer. */
  addressedOn: string;
  addressedBy: string;
  /** What was DONE about it — required to close a flag, and kept alongside the
   *  original note rather than replacing it: `note` says what was wrong,
   *  this says what happened. Empty on a box that was never flagged. */
  addressedNote: string;
  /** The box's name as it stood when this was last written. Display only — the
   *  fingerprint deliberately ignores the label — but it is what lets the log
   *  still NAME a box that has since been deleted. */
  label: string;
  /** When the box this is about was deleted. Empty while it exists, and cleared
   *  again if it comes back (an undo, a re-import). A row carrying this is a
   *  tombstone: the log keeps it and the loader keeps it, where a row naming a
   *  box this map simply never had is still dropped. */
  removedOn: string;
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
  formulaEvidence?: EvidenceMetadata;
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
  evidence?: EvidenceMetadata;
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
  /** Edit mode: is the tag strip showing every tag, or only the ones set? */
  tagPickerOpen?: boolean;
  /** Edit mode: which outgoing link row is unfolded for editing. */
  openEdgeId?: string | null;
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
}

export interface History {
  past: string[];
  future: string[];
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
  /** What the most recent load noticed, structured (see Finding above). Read by
   *  the Review panel (23-review-panel.ts); ordered causes-first by
   *  attributeFindings(). */
  loadErrors: Finding[];
  /** The review record, boxId → verdict. Round-trips through the CSV's optional
   *  `# SECTION: reviews` block, so a pass survives a refresh, travels to a
   *  colleague, and can be picked up tomorrow. See 24-review-record.ts. */
  reviews: Record<string, ReviewEntry>;
  /** Who is reviewing right now — a full name, set once per session and stamped
   *  on every verdict. Not initials: the log outlives the session it was made
   *  in, and "MA" means nothing to whoever reads it next year. Persisted with
   *  the UI state, not with the map. */
  reviewer: string;
  /** True while a review pass is running: the box panel becomes a review card
   *  and the map marks coverage. Transient — a pass is a way of working, not a
   *  property of the map, so it is not persisted with either. */
  reviewPass: boolean;
  /** "read" (default) = the map with the chrome out of the way; "edit" = the
   *  docked panels and the authoring controls. Persisted with the UI state. */
  uiMode: "read" | "edit";
  /** Reading mode only: the left panel is open as an overlay drawer. */
  filtersOpen: boolean;
  sidebarWidth: number;
  detailPanelWidth: number;
  zoomLevel: number;
  highlightDepth: number;
  searchQuery: string;
  searchMatches: SearchMatch[];
  searchFocusIndex: number;
  /** The pathway atlas — everything downstream of one box, open over the map.
   *  null when it is closed. Transient, like a strand: it is a way of reading
   *  the map, not a property of it. */
  atlas: { startId: string } | null;
  canvasEdit: CanvasEditState;
  history: History;
  lastCsvSnapshot: string | null;
  builder: BuilderState;
}
