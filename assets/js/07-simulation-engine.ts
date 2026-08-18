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
} from "./types";
import {
  DEFAULT_ELASTICITY_BY_EFFECT,
  NODES,
  state,
  topologicalOrder,
  nodeById,
  paramById,
  incomingEdges,
  cycleInfo,
} from "./03-state";
import { formatScalar } from "./04-utils";
import { parseFormula, evaluateFormula } from "./07a-formula";
import type { ParsedFormula, FormulaEvalContext } from "./07a-formula";

// How hard the iterative solver tries before giving up. Acyclic maps converge
// in a single sweep; stable feedback loops in a handful; only a runaway
// (positive loop gain ≥ 1) ever reaches the cap.
export const SOLVER_MAX_ITERATIONS = 100;
// A sweep counts as "converged" once the largest relative change to any node
// falls below this. Small enough that converged values match the exact
// single-pass result to many significant figures.
export const SOLVER_EPSILON = 1e-9;
// Source ratios are floored here before log() so a near-zero source can never
// blow up to -Infinity (matches the original single-pass behaviour).
export const SOLVER_LOG_RATIO_FLOOR = 1e-6;

// Look up the elasticity to use for one edge. The CSV's per-edge value wins;
// otherwise we fall back to the default for the edge's effect type.
export function resolveEdgeElasticity(edge: Edge): number {
  if (edge.elasticity !== undefined && edge.elasticity !== null && !isNaN(edge.elasticity)) {
    return edge.elasticity;
  }
  return DEFAULT_ELASTICITY_BY_EFFECT[edge.effect] || 0;
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
// THE RULES — one function per layer, each usable with or without tracing
// ═════════════════════════════════════════════════════════════════════════════

// What a formula is allowed to read. `lookup` is this sweep's numbers;
// `lookupDelayed` is the snapshot taken at the START of this sweep — that's the
// unit delay. Params are constants, so both resolve them identically.
function makeEvalContext(values: ComputedValues, previous: ComputedValues): FormulaEvalContext {
  return {
    lookup(id: string): number | undefined {
      const param = paramById[id];
      return param ? param.value : values[id];
    },
    lookupDelayed(id: string): number | undefined {
      const param = paramById[id];
      return param ? param.value : previous[id];
    },
  };
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

  for (const edge of incomingEdges[node.id]) {
    const sourceNode = nodeById[edge.from];
    // Skip a source with no/zero baseline (would divide-by-zero) or one
    // not yet seeded.
    if (!sourceNode || !sourceNode.baseline || values[edge.from] === undefined) continue;
    const sourceValue = values[edge.from];
    const sourceRatio = sourceValue / sourceNode.baseline;
    const elasticity = resolveEdgeElasticity(edge);
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
        id: edge.from,
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
// ═════════════════════════════════════════════════════════════════════════════

// Iterative solver. Produces { nodeId → currentValue } plus two non-enumerable
// side-channels: `__meta` ({ converged, iterations }) describing the run, and
// `__explanations` (nodeId → NodeExplanation) with the working behind every
// number. Both are lifted off by recomputeValues(); every other consumer keys
// by real node ids and never sees them.
export function computeNodeValues(): ComputedValues {
  const values: ComputedValues = {};

  // ───── 1. Initialise ──────────────────────────────────────────────────
  // Controllable inputs are pinned to baseline × user multiplier. Every other
  // quantified node is seeded at its baseline (i.e. "no perturbation yet") so
  // loop members have a starting value to feed back on the first sweep. Nodes
  // without a usable baseline are left undefined and skipped throughout.
  // Formula boxes are seeded the same way — they need a baseline both as a
  // starting point and so the map can show them as a % change.
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

  // ───── 2. Iterate to a fixed point (Gauss-Seidel) ─────────────────────
  // "Fixed point" = keep recomputing until the numbers stop moving. "Gauss-
  // Seidel" is just the name for the repeat-until-it-settles style used here
  // (see docs/GLOSSARY.md). Each sweep recomputes every non-controllable node
  // from its rule, writing results in place so later nodes in the sweep see the
  // freshest values. Sweeping in topological order (causes before effects)
  // means a loop-free map is fully resolved on the first pass (the second pass
  // then finds zero change and we stop), so its results are identical to the
  // original single-pass engine. Maps with loops take a few more passes to
  // settle.
  const usesDelay = anyLiveFormulaUsesDelay;
  let iterations = 0;
  let converged = false;
  for (; iterations < SOLVER_MAX_ITERATIONS; iterations++) {
    let maxRelDelta = 0;

    // delay(x) must read the value x had BEFORE this sweep started. The solver
    // writes in place (that's the Gauss-Seidel part), so a plain read would see
    // values this very sweep has already updated — we take a snapshot instead.
    // On the first sweep that snapshot is the seed values, exactly as intended.
    // No delay on the map → no copy, and nothing ever reads it.
    const previousValues: ComputedValues = usesDelay ? { ...values } : values;
    const context = makeEvalContext(values, previousValues);

    for (const nodeId of topologicalOrder) {
      const node = nodeById[nodeId];
      if (!node || node.baseline === undefined || node.baseline === null) continue;
      if (node.controllable) continue;   // pinned by the slider — never recomputed
      const parsed = parsedFormulaByNodeId[nodeId];

      // A formula box is computed from its formula ALONE, in absolute values.
      // Everything else aggregates its incoming arrows in ratio space.
      const raw = parsed
        ? evaluateFormula(parsed, context).value
        : combineIncomingEdges(node, values);
      const next = applyBounds(node, raw).value;

      const prev = values[nodeId];
      values[nodeId] = next;

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

    // A sweep with nothing moving means we've reached the fixed point. An
    // acyclic map is fully resolved by its very first topological sweep, so we
    // stop after one rather than re-sweeping just to confirm — as long as it
    // stayed finite (a non-finite sweep means a value blew up, so we keep
    // going to clamp + flag it). That shortcut is OFF when any formula reads
    // through delay(): a delayed read is one sweep behind by construction, so
    // even a loop-free map needs sweeps to settle, exactly like a cycle.
    const singleSweepIsExact = cycleInfo.loopCount === 0 && !usesDelay;
    if (maxRelDelta < SOLVER_EPSILON ||
        (singleSweepIsExact && Number.isFinite(maxRelDelta))) {
      converged = true; iterations++; break;
    }
  }

  // ───── 3. Defensive clamp ─────────────────────────────────────────────
  // The log-ratio floor should keep everything finite, but a runaway positive
  // loop could in principle overflow to Infinity. Fall back to the nearest
  // bound (or, unbounded, to baseline) rather than letting NaN/Infinity leak
  // into the UI.
  for (const id in values) {
    if (!Number.isFinite(values[id])) values[id] = nonFiniteFallback(nodeById[id], values[id]);
  }

  // ───── 4. Explain the final numbers ───────────────────────────────────
  const explanations = explainValues(values);

  // Stash run status where recomputeValues() can lift it off without it ever
  // being read as a node value (every consumer keys by real node ids).
  Object.defineProperty(values, "__meta", {
    value: { converged: converged, iterations: iterations },
    enumerable: false,
  });
  Object.defineProperty(values, "__explanations", {
    value: explanations,
    enumerable: false,
  });
  return values;
}

// ═════════════════════════════════════════════════════════════════════════════
// TRACEABILITY — "how was this number calculated?"
// -----------------------------------------------------------------------------
// One extra pass over the FINAL values, re-running each box's rule purely to
// record its working. Doing it after the solver settles (rather than during the
// sweeps) means every input shown is the number the map is actually displaying,
// with no half-updated intermediate values from a mid-solve sweep.
//
// delay() reads resolve to the final values here too. That is not a shortcut: at
// a fixed point "the value from the previous sweep" and "the value now" are the
// same number — that is what a fixed point IS. If a run failed to converge, the
// trace shows the last sweep's numbers, which is exactly what the map shows.
// ═════════════════════════════════════════════════════════════════════════════
function explainValues(values: ComputedValues): Record<string, NodeExplanation> {
  const explanations: Record<string, NodeExplanation> = {};
  const context = makeEvalContext(values, values);

  for (const node of NODES) {
    const value = values[node.id];
    if (value === undefined) continue;

    // The user is holding this box at a value. No rule ran; the slider IS the
    // answer, which is also why bounds never apply to it.
    if (node.controllable) {
      explanations[node.id] = { rule: "pinned", inputs: [], value: value };
      continue;
    }

    const parsed = parsedFormulaByNodeId[node.id];
    const inputs: TraceInput[] = [];
    let rule: CalcRule;
    let raw: number;
    const explanation: NodeExplanation = { rule: "baseline", inputs: inputs, value: value };

    if (parsed) {
      const evaluation = evaluateFormula(parsed, context);
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

    explanations[node.id] = explanation;
  }

  return explanations;
}

// Convenience wrapper — recomputes, stores the clean { id → value } map into
// state.computedValues, the per-box working into state.explanations (replaced
// wholesale each run, so a stale box can never linger), and records solver
// status (convergence + loop count) into state.solverStatus for the UI.
export function recomputeValues(): void {
  const values = computeNodeValues();
  const sideChannels = values as ComputedValues & {
    __meta?: SolverMeta;
    __explanations?: Record<string, NodeExplanation>;
  };
  const meta: SolverMeta = sideChannels.__meta || { converged: true, iterations: 0 };
  state.computedValues = values;
  state.explanations = sideChannels.__explanations || {};
  state.solverStatus = {
    converged: meta.converged,
    iterations: meta.iterations,
    feedbackLoopCount: cycleInfo.loopCount,
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

// "+12.5%" relative to baseline, or "—" if change is negligible.
export function formatNodeDelta(nodeId: string): { text: string; pct: number } {
  const node = nodeById[nodeId];
  if (!node || node.baseline === undefined) return { text: "", pct: 0 };
  const value = state.computedValues[nodeId];
  if (value === undefined) return { text: "", pct: 0 };

  const pct = ((value - node.baseline) / node.baseline) * 100;
  if (Math.abs(pct) < 0.05) return { text: "—", pct: 0 };

  const text = (pct > 0 ? "+" : "") + pct.toFixed(1) + "%";
  return { text: text, pct: pct };
}

// Returns a colour for the node border on outcome metrics:
//   • green if the change moves in the "good" direction
//   • red   if the change moves in the "bad"  direction
//   • null  for neutral metrics or for changes too small to colour
export function getOutcomeBorderColor(nodeId: string): string | null {
  const node = nodeById[nodeId];
  if (!node || !node.direction || node.direction === "neutral") return null;
  const delta = formatNodeDelta(nodeId);
  if (Math.abs(delta.pct) < 0.5) return null;

  const isGoodChange = (delta.pct > 0 && node.direction === "higher_better") ||
                       (delta.pct < 0 && node.direction === "lower_better");
  return isGoodChange ? "var(--status-good)" : "var(--status-bad)";
}
