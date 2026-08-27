// =============================================================================
// SIMULATION ENGINE — per-box calculation rules, solved to a fixed point
// -----------------------------------------------------------------------------
// In "Simulation" mode the user can drag a slider on any controllable input
// node. The slider sets a multiplier (e.g. 1.20 = 20% above baseline). This
// file is responsible for propagating that change through every downstream
// node and producing a new "current value" for each one.
//
// THE DEFAULT RULE is the multiplicative Cobb-Douglas model this engine has
// always used:
//
//     value(N) = baseline(N) × ∏ over incoming edges (e):
//                    (value(source) / baseline(source))^elasticity(e)
//
// In words: for each input edge, take the ratio of the source's current value
// to its baseline, raise it to the edge's "elasticity" exponent, then multiply
// all those terms together. Elasticity = "what percent change in this node
// does a 1% change in the source produce?"
//
// A box can now OPT IN to a different rule (all of this is blank in an older
// CSV, which is why old maps compute exactly as they did before — see
// docs/CALCULATION-ENGINE-DESIGN.md §3):
//
//   • `combine` — how the arrows pointing INTO the box aggregate, still in
//     ratio space (rᵢ = source value ÷ source baseline, eᵢ = link strength):
//         multiplicative  ∏ rᵢ^eᵢ            (the default above)
//         additive        1 + Σ eᵢ·(rᵢ − 1)   effects add instead of compounding
//         min             min(rᵢ^eᵢ)          the weakest input gates the result
//   • `formula` — an explicit expression (07a-formula.ts) computed from
//     ABSOLUTE values, not ratios. A box with a formula is computed from the
//     formula ALONE; its incoming arrows become descriptive (they still have
//     to be there — the loader checks that the picture matches the maths).
//   • `min` / `max` — hard bounds in the box's own units, applied after
//     whichever rule ran. A box the user is holding with a slider is never
//     bounded or recomputed: the slider is the answer.
//
// We compute values by sweeping nodes in topological order (set up in
// 06-data-loader.ts) and iterating to a fixed point. On an acyclic map a single
// sweep resolves every node (each node's inputs come before it), so the result
// is exact. On a map WITH feedback loops there is no perfect order, so we keep
// sweeping — each pass feeds the loop's latest values back into itself — until
// the values stop moving (convergence) or we hit a safety cap (divergence).
//
// TWO JARGON WORDS (see docs/GLOSSARY.md for the fuller versions):
//   • "fixed point" — the state where another sweep changes nothing. That's the
//     answer we're hunting for.
//   • "delay()"     — a formula can read an input's value from the PREVIOUS
//     sweep instead of this one ("unit delay"). That is what makes a feedback
//     loop well-defined: this sweep's answer never depends on itself.
//
// TRACEABILITY: every value also gets an explanation (which rule ran, what fed
// in, what each input contributed, whether a bound bit) so the detail panel can
// show the working. See NodeExplanation in types.ts.
// =============================================================================

import type {
  Edge,
  ComputedValues,
  SolverMeta,
  GraphNode,
  CombineMode,
  CalcRule,
  TraceInput,
  NodeExplanation,
  Param,
} from "./types";
import {
  DEFAULT_ELASTICITY_BY_EFFECT,
  NODES,
  state,
  topologicalOrder,
  nodeById,
  paramById,
  incomingEdges,
  outgoingEdges,
  cycleInfo,
} from "./03-state";
import { formatScalar } from "./04-utils";
import { parseFormula, evaluateFormula, evaluateFormulaValue } from "./07a-formula";
import type { FormulaAst, ParsedFormula, FormulaEvalContext } from "./07a-formula";

// `values` / `nodeById` and friends are plain objects, so a key like
// "constructor" would otherwise resolve to something off Object.prototype. Every
// lookup driven by an OUTSIDE key (a property read on state.explanations, say)
// goes through this.
function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

// How hard the iterative solver tries before giving up. Acyclic maps converge
// in a single sweep; stable feedback loops in tens of sweeps; only a runaway
// (positive loop gain ≥ 1) ever reaches the cap. 250 covers loop gains up to
// ~0.95 at the 1e-7 epsilon below — affordable because sweeps 2..k touch only
// the loop core, not the whole map, so even a capped run costs well under a
// millisecond. A cap hit therefore genuinely means "this loop amplifies
// itself", which is exactly what the panel's warning claims.
export const SOLVER_MAX_ITERATIONS = 250;
// A sweep counts as "converged" once the largest relative change to any node
// falls below this. 1e-7 is a hundred-thousandth of a percent — three or four
// orders of magnitude finer than anything the UI shows (values print to three
// significant figures, deltas to one decimal place), so a converged run is
// exact as far as the map is concerned. The old 1e-9 bought no visible accuracy
// and cost ~44 extra sweeps on a stable loop, which pushed slow-but-perfectly-
// well-behaved loops past the iteration cap and made the panel warn that they
// "did not settle" when they had.
export const SOLVER_EPSILON = 1e-7;
// Source ratios are floored here before log() so a near-zero source can never
// blow up to -Infinity (matches the original single-pass behaviour).
export const SOLVER_LOG_RATIO_FLOOR = 1e-6;

// Which way a link pushes is the WORD; how hard is the number.
//
// A link carries both — "increases" and 0.55 — and nothing was keeping them in
// step, so a minus sign typed into the strength column silently reversed the
// link while the word beside it went on saying the opposite. The border map had
// two: PCP inspection was declared to INCREASE passenger wait times at −0.55,
// which made more inspection shorten the queues, and document checks were
// declared to increase lorry waits at −0.50. Both read as plausible results
// rather than as data errors, because nothing on screen contradicted them.
//
// So the number contributes its MAGNITUDE and the word decides the sign. A word
// this app does not know is left exactly as it was typed — normalising against
// a rule that has not been written would be a worse guess than the data.
const SIGN_BY_EFFECT: Record<string, number> = {
  increases: 1,
  enables:   1,
  decreases: -1,
};

// The CSV's per-edge value wins; otherwise the default for the effect type.
export function resolveEdgeElasticity(edge: Edge): number {
  const raw = (edge.elasticity !== undefined && edge.elasticity !== null && !isNaN(edge.elasticity))
    ? edge.elasticity
    : (DEFAULT_ELASTICITY_BY_EFFECT[edge.effect] || 0);
  const sign = SIGN_BY_EFFECT[edge.effect];
  if (sign === undefined) return raw;
  const out = sign * Math.abs(raw);
  // −1 × 0 is −0, which prints as "−0.00" in a row that means nothing of the sort.
  return out === 0 ? 0 : out;
}

// ═════════════════════════════════════════════════════════════════════════════
// PARSED-FORMULA CACHE
// -----------------------------------------------------------------------------
// Turning formula TEXT into a tree is the expensive part; evaluating the tree is
// cheap. So every formula is parsed ONCE per load and kept here, keyed by node
// id — the solver then just evaluates, dozens of times per second if the user is
// dragging a slider. rebuildIndexes() in 06-data-loader.ts refreshes this cache
// whenever the map changes (a fresh CSV, an undo, a canvas edit), so it can
// never drift out of step with NODES.
//
// A formula whose TEXT is broken simply isn't cached: the box then behaves as if
// it had no formula at all, and the loader reports the parse error as a load
// warning. Nothing here throws.
// ═════════════════════════════════════════════════════════════════════════════

export interface FormulaParseFailure {
  nodeId: string;
  /** The FormulaError message, e.g. "Unexpected ')' at position 12". */
  message: string;
  /** 0-based character offset into the formula text. */
  position: number;
}

let parsedFormulaByNodeId: Record<string, ParsedFormula> = {};
let formulaParseFailures: FormulaParseFailure[] = [];
let anyLiveFormulaUsesDelay = false;

// Re-parse every box formula on the current map. Called by rebuildIndexes().
export function rebuildFormulaCache(): void {
  parsedFormulaByNodeId = {};
  formulaParseFailures = [];
  anyLiveFormulaUsesDelay = false;

  for (const node of NODES) {
    if (!node.formula) continue;
    try {
      const parsed = parseFormula(node.formula);
      parsedFormulaByNodeId[node.id] = parsed;
      // A controllable box is pinned by its slider, so its formula never runs —
      // it can't be the reason the solver needs extra sweeps.
      if (!node.controllable && parsed.delayReferences.length > 0) anyLiveFormulaUsesDelay = true;
    } catch (error) {
      const failure = error as { message?: string; position?: number };
      formulaParseFailures.push({
        nodeId: node.id,
        message: failure.message || String(error),
        position: failure.position || 0,
      });
    }
  }
}

// The parsed tree for one box, or undefined when the box has no formula (or one
// that didn't parse).
export function getParsedFormula(nodeId: string): ParsedFormula | undefined {
  return parsedFormulaByNodeId[nodeId];
}

// Formulas whose text couldn't be read, for the loader's warning list.
export function getFormulaParseFailures(): FormulaParseFailure[] {
  return formulaParseFailures;
}

// True when some box that actually computes reads an input through delay().
// The solver uses this to keep sweeping on a map that has no feedback loops in
// its arrows but still has a one-sweep-behind read to settle.
export function formulaCacheUsesDelay(): boolean {
  return anyLiveFormulaUsesDelay;
}

// The rule a box will actually use — a formula only counts when it parsed AND
// the box isn't pinned by a slider. Shared with the loader's validation so the
// warnings describe exactly what the engine does.
export function usesFormula(node: GraphNode): boolean {
  return !node.controllable && parsedFormulaByNodeId[node.id] !== undefined;
}

// ═════════════════════════════════════════════════════════════════════════════
// SOLVER INDEXES — everything the sweep would otherwise re-derive per tick
// -----------------------------------------------------------------------------
// Rebuilt by rebuildSolverIndexes(), which rebuildIndexes() (06-data-loader.ts)
// calls once per map change — the same chokepoint that refreshes nodeById, the
// topological order and the parsed-formula cache. Between two rebuilds the map's
// SHAPE is fixed; only slider positions move. So everything that depends on the
// shape alone is worked out here, once:
//
//   • per box, its incoming links flattened into parallel arrays (source id,
//     source baseline, resolved elasticity) — no per-sweep nodeById lookups and
//     no per-sweep elasticity fallback logic;
//   • the ITERATIVE SET: the boxes whose values a second sweep could still
//     change (loop members, anything downstream of them, anything reading
//     through delay(), and anything downstream of THOSE). Everything else is
//     exact after one topological sweep, by construction. That set is split in
//     two, because the two halves need very different amounts of work:
//       – the CORE: the loop members / delay() readers themselves plus anything
//         on a path BETWEEN them. These feed back into each other, so they are
//         the only boxes that have to be swept over and over;
//       – the TAIL: everything else downstream. It can't feed back (if it could,
//         it would be on a loop), so one sweep once the core has settled gives
//         it the same numbers a hundred interleaved sweeps would have;
//   • the forward dependency graph, used to answer "what does moving this
//     slider actually change?" for the incremental solve.
// ═════════════════════════════════════════════════════════════════════════════

// One box's incoming links, flattened. Index i of all three arrays describes the
// same link. A source that can never contribute (missing, or with no usable
// baseline to divide by) is marked with baseline 0 and skipped by the sweep,
// exactly as the original per-edge guard did.
interface IncomingRow {
  sourceIds: string[];
  sourceBaselines: Float64Array;
  elasticities: Float64Array;
}

const EMPTY_ROW: IncomingRow = {
  sourceIds: [],
  sourceBaselines: new Float64Array(0),
  elasticities: new Float64Array(0),
};

let incomingRowByNodeId: Record<string, IncomingRow> = {};
// Bumped on every rebuild. Any cached per-solve bookkeeping stamped with an
// older generation is stale and simply ignored.
let solveGeneration = 0;
// nodeId → the boxes that read it (arrows out PLUS any formula that names it,
// even one the map forgot to draw an arrow for — the loader warns about that
// but still computes it, so the solver must still propagate through it).
let dependentsByNodeId: Record<string, string[]> = {};
// The same graph the other way round (nodeId → the boxes it reads), used to work
// out which boxes sit on a path back INTO the feedback core.
let dependenciesByNodeId: Record<string, string[]> = {};
let topoRankById: Record<string, number> = {};
// The boxes a second sweep can still move (see above), split into the part that
// has to be re-swept until it settles and the part that only needs one final
// pass. Both are slices of the topological order.
let iterativeCoreIdSet: Set<string> = new Set();
let iterativeCoreOrder: string[] = [];
let iterativeTailOrder: string[] = [];
// Every id any live formula reads through delay(), so a sweep can snapshot just
// those instead of cloning the whole values object.
let delayedIds: string[] = [];
// controllable id → the boxes its value can reach, in topological order, split
// the same way. Built on first use, dropped on rebuild.
interface AffectedSlice {
  all: string[];
  core: string[];
  tail: string[];
}
const descendantCache = new Map<string, AffectedSlice>();

// The current rebuild generation. Anything cached ACROSS solves — the review
// panel's sensitivity sweep is the one such consumer — stamps itself with this
// and recomputes when it changes. A sweep is a fact about the map's shape, not
// about where the sliders happen to sit, so this is exactly the right clock for
// it: it ticks when the map changes and not when a slider moves.
export function solverGeneration(): number {
  return solveGeneration;
}

// Rebuild everything above from the current NODES / EDGES / topological order /
// cycleInfo / parsed formulas. Called at the end of rebuildIndexes().
export function rebuildSolverIndexes(): void {
  solveGeneration++;
  descendantCache.clear();
  lastSolve = null;

  // ── Incoming links, flattened per box ───────────────────────────────
  incomingRowByNodeId = {};
  for (const node of NODES) {
    const edges = incomingEdges[node.id] || [];
    const count = edges.length;
    const row: IncomingRow = {
      sourceIds: new Array<string>(count),
      sourceBaselines: new Float64Array(count),
      elasticities: new Float64Array(count),
    };
    for (let i = 0; i < count; i++) {
      const edge = edges[i];
      const source = nodeById[edge.from];
      row.sourceIds[i] = edge.from;
      // 0 doubles as "unusable": a missing source, or one with no baseline (we
      // would be dividing by it), contributes nothing.
      row.sourceBaselines[i] = source && source.baseline ? source.baseline : 0;
      row.elasticities[i] = resolveEdgeElasticity(edge);
    }
    incomingRowByNodeId[node.id] = row;
  }

  // ── Forward dependencies + topological rank ─────────────────────────
  dependentsByNodeId = {};
  dependenciesByNodeId = {};
  topoRankById = {};
  for (let i = 0; i < topologicalOrder.length; i++) topoRankById[topologicalOrder[i]] = i;
  const addDependent = (fromId: string, toId: string): void => {
    const forward = dependentsByNodeId[fromId];
    if (!forward) dependentsByNodeId[fromId] = [toId];
    else if (!forward.includes(toId)) forward.push(toId);
    const back = dependenciesByNodeId[toId];
    if (!back) dependenciesByNodeId[toId] = [fromId];
    else if (!back.includes(fromId)) back.push(fromId);
  };
  for (const node of NODES) {
    for (const edge of outgoingEdges[node.id] || []) addDependent(node.id, edge.to);
    const parsed = parsedFormulaByNodeId[node.id];
    if (!parsed) continue;
    // A formula reads its inputs directly, so those ids feed this box whether or
    // not an arrow was drawn. delay() reads count too: they are one sweep
    // behind, which is precisely why the box needs re-sweeping.
    for (const id of parsed.references) addDependent(id, node.id);
    for (const id of parsed.delayReferences) addDependent(id, node.id);
  }

  // ── The iterative set ───────────────────────────────────────────────
  const seeds: string[] = [];
  for (const id of cycleInfo.inCycleNodeIds) seeds.push(id);
  delayedIds = [];
  const seenDelayed = new Set<string>();
  for (const node of NODES) {
    const parsed = parsedFormulaByNodeId[node.id];
    if (!parsed || parsed.delayReferences.length === 0) continue;
    for (const id of parsed.delayReferences) {
      if (!seenDelayed.has(id)) { seenDelayed.add(id); delayedIds.push(id); }
    }
    // A box the user is holding with a slider never runs its formula, so its
    // delayed read can't be the reason the map needs another sweep.
    if (!node.controllable) seeds.push(node.id);
  }
  // Downstream of a seed = "could still move on a later sweep". Upstream of a
  // seed = "could feed one of those later sweeps". A box in BOTH sits inside the
  // feedback core and has to be re-swept every time round; a box only downstream
  // is tail work, done once at the end.
  const downstream = reachableFrom(seeds, dependentsByNodeId);
  const upstream = reachableFrom(seeds, dependenciesByNodeId);
  iterativeCoreIdSet = new Set<string>();
  iterativeCoreOrder = [];
  iterativeTailOrder = [];
  if (downstream.size > 0) {
    for (const id of downstream) {
      if (upstream.has(id)) iterativeCoreIdSet.add(id);
    }
    for (const id of topologicalOrder) {
      if (!downstream.has(id)) continue;
      if (iterativeCoreIdSet.has(id)) iterativeCoreOrder.push(id);
      else iterativeTailOrder.push(id);
    }
  }
}

// Every box reachable from `seeds` through `adjacency` (the dependency graph in
// one direction or the other), seeds included. Plain breadth-first walk with an
// explicit queue.
function reachableFrom(seeds: string[], adjacency: Record<string, string[]>): Set<string> {
  const reached = new Set<string>();
  const queue: string[] = [];
  for (const id of seeds) {
    if (!reached.has(id)) { reached.add(id); queue.push(id); }
  }
  for (let head = 0; head < queue.length; head++) {
    for (const next of adjacency[queue[head]] || []) {
      if (reached.has(next)) continue;
      reached.add(next);
      queue.push(next);
    }
  }
  return reached;
}

// The boxes one slider can reach, in topological order, plus the iterative
// subset of them. Computed on first use (a map has many controllable inputs and
// a session usually drags two or three of them) and dropped on any rebuild.
function descendantsOf(nodeId: string): AffectedSlice {
  const cached = descendantCache.get(nodeId);
  if (cached) return cached;

  const reached = reachableFrom([nodeId], dependentsByNodeId);
  reached.delete(nodeId);   // the slider box itself is pinned, never recomputed
  const all: string[] = [];
  for (const id of reached) all.push(id);
  all.sort((a, b) => (topoRankById[a] ?? 0) - (topoRankById[b] ?? 0));

  const core: string[] = [];
  const tail: string[] = [];
  if (iterativeCoreOrder.length > 0) for (const id of iterativeCoreOrder) if (reached.has(id)) core.push(id);
  if (iterativeTailOrder.length > 0) for (const id of iterativeTailOrder) if (reached.has(id)) tail.push(id);

  const entry: AffectedSlice = { all: all, core: core, tail: tail };
  descendantCache.set(nodeId, entry);
  return entry;
}

// ═════════════════════════════════════════════════════════════════════════════
// THE RULES — one function per layer, each usable with or without tracing
// ═════════════════════════════════════════════════════════════════════════════

// What a formula is allowed to read. `lookup` is this sweep's numbers;
// `lookupDelayed` is the snapshot taken at the START of this sweep — that's the
// unit delay. Params are constants, so both resolve them identically.
//
// `delayedSnapshot` holds ONLY the ids some formula actually reads through
// delay() (usually one or two on a whole map), not a copy of every value. Any
// other id falls through to the live number, which is what it would have found
// in a full clone anyway: nothing reads a delayed value it didn't ask for.
function makeEvalContext(
  values: ComputedValues,
  delayedSnapshot: ComputedValues | null,
): FormulaEvalContext {
  return {
    lookup(id: string): number | undefined {
      const param = paramById[id];
      return param ? param.value : values[id];
    },
    lookupDelayed(id: string): number | undefined {
      const param = paramById[id];
      if (param) return param.value;
      if (delayedSnapshot) {
        const snapshot = delayedSnapshot[id];
        if (snapshot !== undefined) return snapshot;
      }
      return values[id];
    },
  };
}

// The pre-sweep values of just the delayed ids — the whole of F5's "unit delay"
// bookkeeping. null when no live formula delays anything at all.
function snapshotDelayed(values: ComputedValues): ComputedValues | null {
  if (delayedIds.length === 0) return null;
  const snapshot: ComputedValues = {};
  for (const id of delayedIds) {
    const value = values[id];
    if (value !== undefined) snapshot[id] = value;
  }
  return snapshot;
}

// Aggregate the arrows pointing into one box, in ratio space, per its `combine`
// rule. Pass `inputsOut` to also collect the per-link working for the trace;
// leave it undefined on the solver's hot path and no trace objects are built.
//
// The skip rules are the originals: a source with no baseline (or a zero one —
// we'd be dividing by it) or one not yet seeded contributes nothing at all.
// With no usable links the factor is 1, i.e. the box sits at its baseline.
function combineIncomingEdges(
  node: GraphNode,
  values: ComputedValues,
  inputsOut?: TraceInput[],
): number {
  const baseline = node.baseline as number;
  const mode: CombineMode = node.combine || "multiplicative";

  let logSum = 0;            // multiplicative: Σ eᵢ·ln(rᵢ), added in log-space
  let additiveSum = 0;       // additive:       Σ eᵢ·(rᵢ − 1)
  let smallestFactor = 1;    // min:            smallest rᵢ^eᵢ seen so far
  let usableEdges = 0;

  // Source ids, their baselines and the resolved elasticities were flattened
  // into parallel arrays by rebuildSolverIndexes(); the sweep just walks them.
  const row = incomingRowByNodeId[node.id] || EMPTY_ROW;
  const linkCount = row.sourceIds.length;

  for (let i = 0; i < linkCount; i++) {
    const sourceBaseline = row.sourceBaselines[i];
    // Skip a source with no/zero baseline (would divide-by-zero) or one
    // not yet seeded.
    if (sourceBaseline === 0) continue;
    const sourceId = row.sourceIds[i];
    const sourceValue = values[sourceId];
    if (sourceValue === undefined) continue;
    const sourceRatio = sourceValue / sourceBaseline;
    const elasticity = row.elasticities[i];
    let contribution: number;

    if (mode === "additive") {
      // Effects ADD instead of compounding: two related inputs each 10% up give
      // +20%, not +21%. Nothing here can blow up, so no ratio floor is needed.
      contribution = elasticity * (sourceRatio - 1);
      additiveSum += contribution;
    } else {
      // Both remaining modes work with the same per-link term rᵢ^eᵢ, computed
      // through log/exp with the ratio floor so a near-zero source can't send a
      // negative exponent to Infinity.
      const logTerm = elasticity * Math.log(Math.max(sourceRatio, SOLVER_LOG_RATIO_FLOOR));
      if (mode === "min") {
        // The WEAKEST link gates the outcome ("you need all of these").
        contribution = Math.exp(logTerm);
        if (usableEdges === 0 || contribution < smallestFactor) smallestFactor = contribution;
      } else {
        logSum += logTerm;
        // exp() only when someone is actually reading the trace.
        contribution = inputsOut ? Math.exp(logTerm) : 0;
      }
    }
    usableEdges++;

    if (inputsOut) {
      inputsOut.push({
        id: sourceId,
        kind: "node",
        value: sourceValue,
        ratio: sourceRatio,
        elasticity: elasticity,
        contribution: contribution,
      });
    }
  }

  if (mode === "additive") return baseline * (1 + additiveSum);
  if (mode === "min") return baseline * (usableEdges > 0 ? smallestFactor : 1);
  return baseline * Math.exp(logSum);
}

// A box's hard bounds, applied after whichever rule produced the number.
// Comparisons (rather than Math.min/Math.max) so an Infinity from a runaway
// loop lands on the bound — that's the "explainable clamp" the design asks for —
// while a NaN falls through untouched to the defensive pass at the end.
interface BoundedValue {
  value: number;
  /** Set ONLY when a bound actually moved the number. */
  clamp?: { from: number; min?: number; max?: number };
}

// The bounded number on its own, with no BoundedValue object to allocate. The
// sweep calls this once per box per sweep and never looks at the clamp record;
// applyBounds() below is the same logic for the one box the trace explains.
function applyBoundsValue(node: GraphNode, value: number): number {
  let bounded = value;
  if (node.minValue !== undefined && bounded < node.minValue) bounded = node.minValue;
  if (node.maxValue !== undefined && bounded > node.maxValue) bounded = node.maxValue;
  return bounded;
}

function applyBounds(node: GraphNode, value: number): BoundedValue {
  let bounded = value;
  let changed = false;
  if (node.minValue !== undefined && bounded < node.minValue) {
    bounded = node.minValue;
    changed = true;
  }
  if (node.maxValue !== undefined && bounded > node.maxValue) {
    bounded = node.maxValue;
    changed = true;
  }
  if (!changed) return { value: bounded };

  const clamp: { from: number; min?: number; max?: number } = { from: value };
  if (node.minValue !== undefined) clamp.min = node.minValue;
  if (node.maxValue !== undefined) clamp.max = node.maxValue;
  return { value: bounded, clamp: clamp };
}

// Last-resort value for a box whose number came out Infinity or NaN. A bounded
// box falls back to the bound it ran past (much more explainable than "we gave
// up and used the starting value"); an unbounded one falls back to baseline.
function nonFiniteFallback(node: GraphNode, value: number): number {
  if (value === Infinity && node.maxValue !== undefined) return node.maxValue;
  if (value === -Infinity && node.minValue !== undefined) return node.minValue;
  return applyBounds(node, node.baseline as number).value;
}

// ═════════════════════════════════════════════════════════════════════════════
// THE SOLVER
// -----------------------------------------------------------------------------
// Two things make a slider tick cheap:
//
//   THE ITERATIVE SET. Sweeping in topological order resolves every loop-free
//   box exactly, on the first pass — its inputs are all computed before it. Only
//   boxes on a feedback loop, boxes reading through delay(), and whatever sits
//   DOWNSTREAM of those can still move on a second pass. So sweep 1 covers the
//   whole map and sweeps 2..k cover only that iterative set (precomputed in
//   rebuildSolverIndexes), and convergence is measured over exactly the boxes
//   the sweep actually recomputed.
//
//   THE INCREMENTAL SOLVE. While a slider is being dragged, the map's shape and
//   every other slider are unchanged: the only boxes whose answers can differ
//   are the ones DOWNSTREAM of the slider being moved. So we keep the previous
//   solve's numbers, re-seed the sliders, and re-evaluate that downstream slice
//   alone. On a loop-free map this is not an approximation — the untouched boxes
//   are recomputed from identical inputs, so they land on identical bits, which
//   the "incremental matches a cold solve" test pins. On a map with loops the
//   previous values also make an excellent warm start: the fixed point is the
//   same one, and starting next to it gets there in a handful of sweeps.
//
// Anything that can't be proved safe falls back to the cold path (a full seed +
// full sweep), which is where every load, every map edit, every Reset and every
// multi-slider change goes. Correctness first; the cold path is fast anyway.
// ═════════════════════════════════════════════════════════════════════════════

// Controllable inputs are pinned to baseline × user multiplier. Every other
// quantified node is seeded at its baseline (i.e. "no perturbation yet") so
// loop members have a starting value to feed back on the first sweep. Nodes
// without a usable baseline are left undefined and skipped throughout.
// Formula boxes are seeded the same way — they need a baseline both as a
// starting point and so the map can show them as a % change.
function seedValues(values: ComputedValues): void {
  for (const node of NODES) {
    const baseline = node.baseline;
    if (baseline === undefined || baseline === null) continue;
    if (node.controllable) {
      const userMultiplier = state.userOverrides[node.id] !== undefined ? state.userOverrides[node.id] : 1.0;
      values[node.id] = baseline * userMultiplier;
    } else {
      values[node.id] = baseline;
    }
  }
}

// The slider-pinned boxes only. Used by the incremental path, which keeps every
// other box's number from the previous solve.
function seedControllables(values: ComputedValues): void {
  for (const node of NODES) {
    const baseline = node.baseline;
    if (baseline === undefined || baseline === null || !node.controllable) continue;
    const userMultiplier = state.userOverrides[node.id] !== undefined ? state.userOverrides[node.id] : 1.0;
    values[node.id] = baseline * userMultiplier;
  }
}

// How many box evaluations the last solve ran, for the diagnostics below.
let lastSweptCount = 0;

// One pass over `order`, writing results in place (that's the Gauss-Seidel part:
// later boxes in the pass see the freshest numbers). Returns the largest
// relative move any box made, which is what convergence is tested against.
function sweepOnce(values: ComputedValues, order: string[]): number {
  const context = makeEvalContext(values, snapshotDelayed(values));
  let maxRelDelta = 0;

  for (let i = 0; i < order.length; i++) {
    const nodeId = order[i];
    const node = nodeById[nodeId];
    if (!node || node.baseline === undefined || node.baseline === null) continue;
    if (node.controllable) continue;   // pinned by the slider — never recomputed
    const parsed = parsedFormulaByNodeId[nodeId];

    // A formula box is computed from its formula ALONE, in absolute values.
    // Everything else aggregates its incoming arrows in ratio space.
    const raw = parsed
      ? evaluateFormulaValue(parsed, context)
      : combineIncomingEdges(node, values);
    const next = applyBoundsValue(node, raw);

    const prev = values[nodeId];
    values[nodeId] = next;
    lastSweptCount++;

    // Track the largest relative move this sweep to test for convergence. A
    // non-finite update means a runaway positive loop overflowed — force a
    // non-converging signal so we run to the cap (and clamp) rather than
    // mistaking Infinity−Infinity = NaN for "nothing changed".
    if (!Number.isFinite(next)) {
      maxRelDelta = Infinity;
    } else {
      const denom = Math.abs(prev) > 1e-300 ? Math.abs(prev) : 1;
      const relDelta = Math.abs(next - prev) / denom;
      if (relDelta > maxRelDelta) maxRelDelta = relDelta;
    }
  }

  return maxRelDelta;
}

// Sweep `firstOrder` once, then the feedback CORE until the numbers stop moving
// (or the safety cap bites), then the TAIL once so everything downstream of the
// settled loop is refreshed from the numbers it finished on.
//
// An EMPTY core means nothing can move again: every box was loop-free and read
// no delayed value, so the first topological sweep is the exact answer and we
// stop right there rather than re-sweeping to confirm. That is the shortcut that
// keeps loop-free maps identical, to the last bit, to the original single-pass
// engine.
function iterate(
  values: ComputedValues,
  firstOrder: string[],
  coreOrder: string[],
  tailOrder: string[],
): SolverMeta {
  let iterations = 1;
  let maxRelDelta = sweepOnce(values, firstOrder);

  // Nothing left that a further sweep could change. (A non-finite value can only
  // come from a runaway loop, which would have put boxes in the core — so this
  // only ever reports "converged" for a clean run.)
  if (coreOrder.length === 0) {
    return { converged: Number.isFinite(maxRelDelta), iterations: iterations };
  }
  // The first sweep already settled everything, tail included.
  if (maxRelDelta < SOLVER_EPSILON) return { converged: true, iterations: iterations };

  let converged = false;
  while (iterations < SOLVER_MAX_ITERATIONS) {
    maxRelDelta = sweepOnce(values, coreOrder);
    iterations++;
    if (maxRelDelta < SOLVER_EPSILON) { converged = true; break; }
  }

  // One pass over the tail, in topological order, from the settled core. The
  // tail can't feed back into the core (anything that did would be on the loop
  // and hence part of the core), so this lands on exactly the numbers repeated
  // whole-set sweeps would have produced — for a fraction of the work.
  if (tailOrder.length > 0) {
    const tailDelta = sweepOnce(values, tailOrder);
    iterations++;
    if (!Number.isFinite(tailDelta)) converged = false;
  }

  return { converged: converged, iterations: iterations };
}

// The log-ratio floor should keep everything finite, but a runaway positive loop
// could in principle overflow to Infinity. Fall back to the nearest bound (or,
// unbounded, to baseline) rather than letting NaN/Infinity leak into the UI.
function clampNonFinite(values: ComputedValues, ids: string[] | null): void {
  if (ids) {
    for (const id of ids) {
      const value = values[id];
      if (value !== undefined && !Number.isFinite(value)) values[id] = nonFiniteFallback(nodeById[id], value);
    }
    return;
  }
  for (const id in values) {
    if (!Number.isFinite(values[id])) values[id] = nonFiniteFallback(nodeById[id], values[id]);
  }
}

// A full, from-scratch solve: seed every box, sweep the whole map, then iterate
// the iterative set to its fixed point. Produces a clean { nodeId → value } map
// — the run's status is read back with getSolverDiagnostics(), and the working
// behind each number is computed on demand by explainNode().
export function computeNodeValues(): ComputedValues {
  const values: ComputedValues = {};
  lastSweptCount = 0;
  seedValues(values);
  lastMeta = iterate(values, topologicalOrder, iterativeCoreOrder, iterativeTailOrder);
  clampNonFinite(values, null);
  lastSolveMode = "cold";
  return values;
}

// ───── Incremental solving (only override values changed) ─────────────────

interface LastSolve {
  /** The rebuildSolverIndexes() generation these numbers were computed under. */
  generation: number;
  /** Identity-checked against state.computedValues, so a caller that swapped the
   *  values object out from under us falls back to the cold path. */
  values: ComputedValues;
  /** Effective multiplier per controllable box (1.0 when there's no override). */
  multipliers: Record<string, number>;
  converged: boolean;
}

let lastSolve: LastSolve | null = null;
let lastMeta: SolverMeta = { converged: true, iterations: 0 };
let lastSolveMode: "cold" | "incremental" = "cold";

function currentMultipliers(): Record<string, number> {
  const multipliers: Record<string, number> = {};
  for (const node of NODES) {
    if (!node.controllable || node.baseline === undefined || node.baseline === null) continue;
    multipliers[node.id] = state.userOverrides[node.id] !== undefined ? state.userOverrides[node.id] : 1.0;
  }
  return multipliers;
}

// The one slider that moved since the last solve, "" when none did, or null when
// the incremental path can't be used at all (a different map, a solve someone
// else's code has since replaced, a previous run that didn't settle, or more
// than one slider changed — Reset, an undo, a restored session).
function movedSliderId(multipliers: Record<string, number>): string | null {
  if (!lastSolve || !state.dataLoaded) return null;
  if (lastSolve.generation !== solveGeneration) return null;
  if (lastSolve.values !== state.computedValues) return null;
  // Previous numbers we'd be building on were clamped, not solved.
  if (!lastSolve.converged) return null;

  const previous = lastSolve.multipliers;
  const previousKeys = Object.keys(previous);
  const currentKeys = Object.keys(multipliers);
  if (previousKeys.length !== currentKeys.length) return null;   // the map's sliders changed

  let moved = "";
  for (const id of currentKeys) {
    if (!hasOwn(previous, id)) return null;
    if (previous[id] === multipliers[id]) continue;
    if (moved !== "") return null;   // two sliders at once — take the cold path
    moved = id;
  }
  return moved;
}

// Re-solve only what the moved slider can reach, keeping every other box's
// number from the previous solve.
function solveIncremental(movedId: string): ComputedValues {
  const values = lastSolve!.values;
  lastSweptCount = 0;
  seedControllables(values);

  if (movedId === "") {
    // Nothing actually moved (the same numbers arrived in a fresh overrides
    // object). The previous solve is still the answer.
    lastMeta = { converged: true, iterations: 0 };
    lastSolveMode = "incremental";
    return values;
  }

  const affected = descendantsOf(movedId);
  lastMeta = iterate(values, affected.all, affected.core, affected.tail);
  clampNonFinite(values, affected.all);
  lastSolveMode = "incremental";
  return values;
}

// What the most recent solve did. Exported for tests and perf work; the app
// itself reads state.solverStatus.
export function getSolverDiagnostics(): {
  mode: "cold" | "incremental";
  sweptNodes: number;
  iterations: number;
  converged: boolean;
} {
  return {
    mode: lastSolveMode,
    sweptNodes: lastSweptCount,
    iterations: lastMeta.iterations,
    converged: lastMeta.converged,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// TRACEABILITY — "how was this number calculated?"
// -----------------------------------------------------------------------------
// Re-run ONE box's rule over the FINAL values, purely to record its working.
// Doing it after the solver settles (rather than during the sweeps) means every
// input shown is the number the map is actually displaying, with no half-updated
// intermediate values from a mid-solve sweep.
//
// Doing it ONE BOX AT A TIME matters just as much: the detail panel shows the
// working for exactly one box, the selected one, so explaining all of them after
// every solve meant re-running every rule with tracing on — tens of thousands of
// throwaway objects per slider tick — to read a single entry. Explanations are
// therefore computed on demand and memoised until the next solve replaces them.
//
// delay() reads resolve to the final values here. That is not a shortcut: at a
// fixed point "the value from the previous sweep" and "the value now" are the
// same number — that is what a fixed point IS. If a run failed to converge, the
// trace shows the last sweep's numbers, which is exactly what the map shows.
// ═════════════════════════════════════════════════════════════════════════════

let explanationCache = new Map<string, NodeExplanation>();
let explainedValues: ComputedValues = {};

// The working behind one box's current number, or undefined for a box with no
// value (no baseline, or not on this map). Memoised per solve.
export function explainNode(nodeId: string): NodeExplanation | undefined {
  const cached = explanationCache.get(nodeId);
  if (cached) return cached;

  const values = explainedValues;
  if (!hasOwn(values, nodeId)) return undefined;
  const value = values[nodeId];
  if (value === undefined) return undefined;
  const node = hasOwn(nodeById, nodeId) ? nodeById[nodeId] : undefined;
  if (!node) return undefined;

  let explanation: NodeExplanation;

  // The user is holding this box at a value. No rule ran; the slider IS the
  // answer, which is also why bounds never apply to it.
  if (node.controllable) {
    explanation = { rule: "pinned", inputs: [], value: value };
  } else {
    const parsed = parsedFormulaByNodeId[nodeId];
    const inputs: TraceInput[] = [];
    let rule: CalcRule;
    let raw: number;
    explanation = { rule: "baseline", inputs: inputs, value: value };

    if (parsed) {
      const evaluation = evaluateFormula(parsed, makeEvalContext(values, null));
      rule = "formula";
      raw = evaluation.value;
      for (const input of evaluation.inputs) {
        const traced: TraceInput = {
          id: input.id,
          kind: paramById[input.id] ? "param" : "node",
          value: input.value,
        };
        // Only flagged when true — a plain read needs no annotation.
        if (input.delayed) traced.delayed = true;
        inputs.push(traced);
      }
      explanation.formula = parsed.source;
      if (evaluation.dividedByZero) explanation.dividedByZero = true;
      if (evaluation.missingInputs.length > 0) {
        explanation.missingInputs = evaluation.missingInputs.slice();
      }
    } else {
      raw = combineIncomingEdges(node, values, inputs);
      // Nothing usable fed in → the box simply sits at its starting value, and
      // saying "multiplicative over zero links" would be noise.
      rule = inputs.length === 0 ? "baseline" : node.combine || "multiplicative";
    }

    explanation.rule = rule;
    // Recorded ONLY when a bound actually moved the number.
    const bounded = applyBounds(node, raw);
    if (bounded.clamp) explanation.clamp = bounded.clamp;
  }

  explanationCache.set(nodeId, explanation);
  return explanation;
}

// state.explanations, as every consumer has always used it: a { nodeId →
// explanation } map, one entry per box that has a value. It just fills itself in
// as it is read — property access, `in`, Object.keys and Object.values all work,
// and none of them cost anything until something actually asks.
function makeExplanationView(values: ComputedValues): Record<string, NodeExplanation> {
  const isNodeKey = (key: string | symbol): key is string =>
    typeof key === "string" && hasOwn(values, key) && values[key] !== undefined;

  return new Proxy({} as Record<string, NodeExplanation>, {
    get(_target, key) {
      return isNodeKey(key) ? explainNode(key) : undefined;
    },
    has(_target, key) {
      return isNodeKey(key);
    },
    ownKeys() {
      return Object.keys(values);
    },
    getOwnPropertyDescriptor(_target, key) {
      if (!isNodeKey(key)) return undefined;
      return { configurable: true, enumerable: true, writable: false, value: explainNode(key) };
    },
    set() {
      return false;
    },
    deleteProperty() {
      return false;
    },
  });
}

// Convenience wrapper — recomputes, stores the clean { id → value } map into
// state.computedValues, a freshly-emptied lazy view onto the per-box working
// into state.explanations (so a stale box can never linger), and records solver
// status (convergence + loop count) into state.solverStatus for the UI.
// Bumped by every recomputeValues(). The one thing that reliably changes on a
// solve — see maxEffectPct for why the values object itself is not.
let valuesStamp = 0;

export function recomputeValues(): void {
  valuesStamp++;
  const multipliers = currentMultipliers();
  const moved = movedSliderId(multipliers);
  const values = moved === null ? computeNodeValues() : solveIncremental(moved);

  state.computedValues = values;
  explanationCache = new Map();
  explainedValues = values;
  state.explanations = makeExplanationView(values);
  state.solverStatus = {
    converged: lastMeta.converged,
    iterations: lastMeta.iterations,
    feedbackLoopCount: cycleInfo.loopCount,
  };
  lastSolve = {
    generation: solveGeneration,
    values: values,
    multipliers: multipliers,
    converged: lastMeta.converged,
  };
}

// ───── Display helpers (formatting node values for the UI) ────────────────

// "9,000 FTE" or "" if the node has no baseline / current value.
export function formatNodeValue(nodeId: string): string {
  const node = nodeById[nodeId];
  if (!node || node.baseline === undefined) return "";
  const value = state.computedValues[nodeId];
  if (value === undefined) return "";
  return formatScalar(value) + " " + (node.unit || "");
}

// Below this, a box reads as "—" rather than as a number: half of the first
// decimal place the label would print, so nothing is shown that would round to
// +0.0%. Exported because the load-time rest-state check (06-data-loader) asks
// exactly this question — "would the map draw a change here?" — and the two
// must not drift apart.
export const DELTA_DISPLAY_THRESHOLD_PCT = 0.05;

// "+12.5%" relative to baseline, or "—" if change is negligible.
export function formatNodeDelta(nodeId: string): { text: string; pct: number } {
  const node = nodeById[nodeId];
  if (!node || node.baseline === undefined) return { text: "", pct: 0 };
  const value = state.computedValues[nodeId];
  if (value === undefined) return { text: "", pct: 0 };

  const pct = ((value - node.baseline) / node.baseline) * 100;
  if (Math.abs(pct) < DELTA_DISPLAY_THRESHOLD_PCT) return { text: "—", pct: 0 };

  const text = (pct > 0 ? "+" : "") + pct.toFixed(1) + "%";
  return { text: text, pct: pct };
}

// Returns a colour for the node border on outcome metrics:
//   • green if the change moves in the "good" direction
//   • red   if the change moves in the "bad"  direction
//   • null  for neutral metrics or for changes too small to colour
//
// `precomputedDelta` lets a caller that has already formatted this node's delta
// (the in-place scrub patch does, for every node, every frame) pass it in rather
// than have it computed a second time.
export function getOutcomeBorderColor(
  nodeId: string,
  precomputedDelta?: { text: string; pct: number },
): string | null {
  const node = nodeById[nodeId];
  if (!node || !node.direction || node.direction === "neutral") return null;
  const delta = precomputedDelta || formatNodeDelta(nodeId);
  if (Math.abs(delta.pct) < 0.5) return null;

  const isGoodChange = (delta.pct > 0 && node.direction === "higher_better") ||
                       (delta.pct < 0 && node.direction === "lower_better");
  return isGoodChange ? "var(--status-good)" : "var(--status-bad)";
}

// ═════════════════════════════════════════════════════════════════════════════
// WHAT THE SIMULATION IS DOING TO EACH BOX
// -----------------------------------------------------------------------------
// While the sliders are out, the map and the atlas both paint a box by what the
// run did to it. They need the same three answers about one box — has it really
// moved, does the map call that move good or bad, and how big is it against the
// biggest move anywhere — so the answers are worked out once, here, next to the
// numbers they come from. The COLOURS live in 04-utils (simEffectFill).
// ═════════════════════════════════════════════════════════════════════════════

// Under half a percent, nothing has really moved. The solver's own convergence
// noise sits orders of magnitude below this (SOLVER_EPSILON is 1e-7), so a box
// that drifted a rounding error reads as untouched rather than as a faint
// colour that means nothing.
export const EFFECT_FLOOR_PCT = 0.5;

/** Whether the map itself calls a move good, bad, or has no view. */
export type EffectMerit = "good" | "bad" | "none";

export interface NodeEffect {
  /** Signed % change against the box's starting value. */
  pct: number;
  /** False below EFFECT_FLOOR_PCT, and for a box with no number at all. */
  moved: boolean;
  /** 0..1 — this move measured against the biggest move on the map. */
  strength: number;
  merit: EffectMerit;
}

// The biggest move anywhere on the map: the top of the colour ramp. Worked out
// once per solve rather than once per box — a slider drag asks for it for every
// box, every frame.
//
// Keyed on valuesStamp, NOT on the identity of state.computedValues: an
// incremental solve MUTATES the previous values object and hands the same one
// back (solveIncremental), so an identity check answers "unchanged" for every
// solve after the first, and the ramp would be pinned to whatever the first run
// happened to produce.
let _maxEffectStamp = -1;
let _maxEffectPct = 0;

export function maxEffectPct(): number {
  if (_maxEffectStamp === valuesStamp) return _maxEffectPct;
  let biggest = 0;
  for (const node of NODES) {
    const pct = formatNodeDelta(node.id).pct;
    if (Number.isFinite(pct) && Math.abs(pct) > biggest) biggest = Math.abs(pct);
  }
  _maxEffectStamp = valuesStamp;
  _maxEffectPct = biggest;
  return biggest;
}

// The biggest mover itself, for the sentence that names the top of the scale.
export function biggestMover(): { node: GraphNode; pct: number } | null {
  let best: { node: GraphNode; pct: number } | null = null;
  for (const node of NODES) {
    const pct = formatNodeDelta(node.id).pct;
    if (!Number.isFinite(pct) || Math.abs(pct) < EFFECT_FLOOR_PCT) continue;
    if (!best || Math.abs(pct) > Math.abs(best.pct)) best = { node: node, pct: pct };
  }
  return best;
}

// `precomputedDelta` lets a caller that already formatted this box's delta (the
// scrub patch does, for every box, every frame) hand it over instead of paying
// for it twice.
export function nodeEffect(
  nodeId: string,
  precomputedDelta?: { text: string; pct: number },
): NodeEffect {
  const node = nodeById[nodeId];
  const delta = precomputedDelta || formatNodeDelta(nodeId);
  const pct = Number.isFinite(delta.pct) ? delta.pct : 0;
  const moved = Math.abs(pct) >= EFFECT_FLOOR_PCT;
  const top = maxEffectPct();
  // The ramp is RELATIVE: the biggest mover is always full strength, so the
  // shape of a run is visible whether it moved things by 3% or 300%. The price
  // is that a colour means a different number from run to run, which is why the
  // sliders panel names the box currently sitting at the top of the scale.
  // The 0.6 power lifts the middle — on a linear ramp one runaway box left
  // everything else indistinguishably pale.
  const strength = moved && top > 0 ? Math.pow(Math.min(1, Math.abs(pct) / top), 0.6) : 0;
  let merit: EffectMerit = "none";
  if (moved && node) {
    if      (node.direction === "higher_better") merit = pct > 0 ? "good" : "bad";
    else if (node.direction === "lower_better")  merit = pct < 0 ? "good" : "bad";
  }
  return { pct: pct, moved: moved, strength: strength, merit: merit };
}

// ───── Held back by something else ────────────────────────────────────────
// A box that sits still while the map moves around it is not necessarily a box
// the run failed to reach. Some are HELD: their `combine` rule is `min`, which
// says "you need all of these", and the weakest of the things they need is not
// one that moved. Counter-Terrorism Effectiveness on the border map is exactly
// this — pour as much as you like into the inspection side of it and the number
// does not shift, because intelligence coverage is what is short.
//
// Told apart from "nothing reached it" this is the most useful thing the
// picture can say: it names what to move instead. Undistinguished, it is the
// single biggest reason a simulated map reads as broken.
//
// Three conditions, all of them necessary:
//   the box's rule is `min`         — something gates it at all
//   the box did not move            — the gate is actually biting
//   something else feeding it DID   — otherwise it is simply not on the run,
//                                     and "held" would be an odd way to say so
export interface GatedBy { id: string; label: string }


// A formula gates too. `min(a, b)` written inside a formula is the same
// statement as the `min` combine rule — "you need both of these" — and on a map
// of any size it is the commoner of the two: the border map has one box using
// the column and eighteen using formulas, several of them exactly this shape.
//
//   vehicle_physical_search =
//     min(vehicle_xray_scan * search_followup_rate,
//         border_force_fte   * searches_per_fte_yr)
//
// Double the officers and this does not move, because scanning is what is
// short. Read only through the combine column, that box looked like one the run
// never reached.
//
// Only a min() at the TOP of the formula is read. Buried inside arithmetic the
// arms are no longer the whole answer, and half an explanation on a picture is
// worse than none.
function armIdentifiers(ast: FormulaAst, out: string[]): string[] {
  switch (ast.kind) {
    case "identifier":
    case "delay":   out.push(ast.id); break;
    case "negate":  armIdentifiers(ast.operand, out); break;
    case "binary":  armIdentifiers(ast.left, out); armIdentifiers(ast.right, out); break;
    case "call":    for (const arg of ast.args) armIdentifiers(arg, out); break;
  }
  return out;
}

function formulaGate(nodeId: string): GatedBy | null {
  const parsed = parsedFormulaByNodeId[nodeId];
  if (!parsed || parsed.ast.kind !== "call" || parsed.ast.fn !== "min") return null;
  if (parsed.ast.args.length < 2) return null;

  const ctx = makeEvalContext(explainedValues, null);
  let binding = parsed.ast.args[0];
  let smallest = Infinity;
  for (const arm of parsed.ast.args) {
    const armValue = evaluateFormulaValue({ ...parsed, ast: arm }, ctx);
    if (armValue < smallest) { smallest = armValue; binding = arm; }
  }

  // Something the reader can act on, in the arm that is deciding. A param is a
  // constant — naming one would answer "what is holding this?" with a number
  // nobody can move.
  const inBinding = armIdentifiers(binding, []);
  const held = inBinding.find(id => !paramById[id] && nodeById[id] && !nodeEffect(id).moved);
  if (!held) return null;

  // And the other arm has to have moved, or this is simply a box the run never
  // reached and "held" would be an odd way to say so.
  const movedElsewhere = parsed.ast.args.some(arm => arm !== binding &&
    armIdentifiers(arm, []).some(id => !paramById[id] && nodeById[id] && nodeEffect(id).moved));
  if (!movedElsewhere) return null;

  return { id: held, label: nodeById[held].label || held };
}

// ───── The arms of a gate, spelled out ────────────────────────────────────
// `gatedBy()` above answers "what is holding this box?" with one name, which is
// what the map has room for. The review report has room for the whole sum, and
// needs it: told that an input moves nothing, the next question is always "then
// what IS short, and by how much?" — and that is the list of arms with their
// values, one of them binding.
//
// Works for both spellings of the same statement: the `min` combine rule over
// the incoming links, and a top-level `min()` in a formula. Anything else
// returns null, because only a `min` has arms in this sense.
export interface GateArm {
  /** The arm as written, with box ids swapped for their labels. */
  text: string;
  value: number;
  /** The smallest arm — the one the box's value was actually taken from. */
  binding: boolean;
  /** Boxes named in this arm, so the caller can say what to move. Params are
   *  left out: naming one answers "what is short?" with a number nobody can
   *  move. */
  boxIds: string[];
}

// The expression, back as text, with every box id replaced by its label. Used
// only for display — parentheses are added wherever precedence could be read
// two ways rather than tracked exactly, which is the safe direction to err in.
// formatScalar is a DISPLAY formatter — it rounds 0.0004 to "0.000", which is
// fine on a value rail and wrong inside a rule, where the number IS the thing
// being checked. So: the pretty form only when it is still the same number.
function formulaNumber(value: number): string {
  const trimmed = formatScalar(value).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return Number(trimmed.replace(/,/g, "")) === value ? trimmed : String(value);
}

function printAst(ast: FormulaAst): string {
  switch (ast.kind) {
    case "number":     return formulaNumber(ast.value);
    // A constant reads as its value. Printing `teu_exams_per_fte_yr` in a line
    // whose whole job is to be readable puts back the id this line exists to
    // resolve — and the constants are listed by name underneath it anyway.
    case "identifier": return paramById[ast.id]
      ? formulaNumber(paramById[ast.id].value)
      : (nodeById[ast.id] && nodeById[ast.id].label) || ast.id;
    case "delay":      return "previous " + ((nodeById[ast.id] && nodeById[ast.id].label) || ast.id);
    // The brackets are not decoration. `-(a + b)` without them prints as
    // "−a + b", which is a DIFFERENT expression — and this line is the one a
    // reviewer reads to check the rule, so a rendering that quietly restates it
    // is worse than no rendering at all.
    case "negate":     return ast.operand.kind === "binary"
      ? "−(" + printAst(ast.operand) + ")"
      : "−" + printAst(ast.operand);
    case "call":       return ast.fn + "(" + ast.args.map(printAst).join(", ") + ")";
    case "binary": {
      const symbol = ast.op === "*" ? " × " : ast.op === "/" ? " ÷ " : " " + ast.op + " ";
      const left  = ast.left.kind  === "binary" && (ast.op === "*" || ast.op === "/")
        ? "(" + printAst(ast.left) + ")"  : printAst(ast.left);
      const right = ast.right.kind === "binary" ? "(" + printAst(ast.right) + ")" : printAst(ast.right);
      return left + symbol + right;
    }
  }
}

// ───── Reading a formula, for a reviewer ──────────────────────────────────
// A box with a formula is computed from that expression ALONE — its arrows go
// descriptive and their strengths are ignored. So a reviewer asked "is this
// everything that drives this box?" is being asked about the expression, and
// these three are what it takes to put it in front of them: the rule in the
// map's own words, the constants it leans on (which are on no map anywhere),
// and which of the drawn arrows it actually reads.

/** The expression with every box id swapped for its label. Display only. */
export function formulaInLabels(nodeId: string): string | null {
  const parsed = parsedFormulaByNodeId[nodeId];
  return parsed ? printAst(parsed.ast) : null;
}

/**
 * The constants a formula names, with their values.
 *
 * Params never render as boxes — that is the point of them — so on a formula
 * box they are the one part of the rule a reader cannot reach from the map at
 * all. Thirteen of the eighteen formula boxes on the map this was built against
 * lean on at least one.
 */
export function formulaConstants(nodeId: string): Param[] {
  const parsed = parsedFormulaByNodeId[nodeId];
  if (!parsed) return [];
  const seen = new Set<string>();
  const out: Param[] = [];
  for (const id of armIdentifiers(parsed.ast, [])) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (paramById[id]) out.push(paramById[id]);
  }
  return out;
}

/**
 * The box ids the expression actually reads.
 *
 * The loader already refuses a formula that names a box with no arrow into
 * this one. The reverse is not an error and is not checked: an arrow the
 * expression never mentions is drawn on the map and read by nothing, which is
 * exactly the sort of thing a review is for.
 */
export function formulaReads(nodeId: string): Set<string> {
  const parsed = parsedFormulaByNodeId[nodeId];
  if (!parsed) return new Set();
  return new Set(armIdentifiers(parsed.ast, []).filter(id => nodeById[id]));
}

export function formulaInLabelsFailed(nodeId: string): boolean {
  const node = nodeById[nodeId];
  return !!node && !!node.formula && !parsedFormulaByNodeId[nodeId];
}

export function formulaArms(nodeId: string): GateArm[] | null {
  const node = nodeById[nodeId];
  if (!node) return null;

  // Spelling one: a formula whose whole answer is a min() of two or more arms.
  const parsed = parsedFormulaByNodeId[nodeId];
  if (parsed && parsed.ast.kind === "call" && parsed.ast.fn === "min" && parsed.ast.args.length >= 2) {
    const ctx = makeEvalContext(explainedValues, null);
    const arms = parsed.ast.args.map(arm => ({
      text: printAst(arm),
      value: evaluateFormulaValue({ ...parsed, ast: arm }, ctx),
      binding: false,
      boxIds: armIdentifiers(arm, []).filter(id => !paramById[id] && nodeById[id]),
    }));
    return markBinding(arms);
  }

  // Spelling two: the `min` combine rule over the incoming links. Here an "arm"
  // is one link, and its value is that link's factor — the same number the
  // detail panel prints as "×1.20".
  const explanation = explainNode(nodeId);
  if (!explanation || explanation.rule !== "min" || explanation.inputs.length < 2) return null;
  const arms = explanation.inputs.map(input => ({
    text: (nodeById[input.id] && nodeById[input.id].label) || input.id,
    value: input.contribution === undefined ? Infinity : input.contribution,
    binding: false,
    boxIds: input.kind === "node" && nodeById[input.id] ? [input.id] : [],
  }));
  return markBinding(arms);
}

function markBinding(arms: GateArm[]): GateArm[] {
  let smallest = Infinity;
  for (const arm of arms) if (arm.value < smallest) smallest = arm.value;
  for (const arm of arms) arm.binding = arm.value === smallest;
  return arms;
}

export function gatedBy(nodeId: string): GatedBy | null {
  const explanation = explainNode(nodeId);
  if (!explanation) return null;
  if (nodeEffect(nodeId).moved) return null;
  if (explanation.rule === "formula") return formulaGate(nodeId);
  if (explanation.rule !== "min" || !explanation.inputs.length) return null;

  // The weakest link IS the answer under `min` — it is the one the box's value
  // was taken from.
  let binding = explanation.inputs[0];
  for (const input of explanation.inputs) {
    if ((input.contribution ?? Infinity) < (binding.contribution ?? Infinity)) binding = input;
  }
  const movedElsewhere = explanation.inputs.some(
    input => input.id !== binding.id && input.kind === "node" && nodeEffect(input.id).moved);
  if (!movedElsewhere) return null;

  const node = nodeById[binding.id];
  return { id: binding.id, label: (node && node.label) || binding.id };
}
