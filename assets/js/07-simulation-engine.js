// =============================================================================
// SIMULATION ENGINE — Cobb-Douglas propagation
// -----------------------------------------------------------------------------
// In "Simulation" mode the user can drag a slider on any controllable input
// node. The slider sets a multiplier (e.g. 1.20 = 20% above baseline). This
// file is responsible for propagating that change through every downstream
// node and producing a new "current value" for each one.
//
// The maths is a multiplicative Cobb-Douglas model:
//
//     value(N) = baseline(N) × ∏ over incoming edges (e):
//                    (value(source) / baseline(source))^elasticity(e)
//
// In words: for each input edge, take the ratio of the source's current value
// to its baseline, raise it to the edge's "elasticity" exponent, then multiply
// all those terms together. Elasticity = "what percent change in this node
// does a 1% change in the source produce?"
//
// We compute values by sweeping nodes in topological order (set up in
// 06-data-loader.js) and iterating to a fixed point. On an acyclic map a single
// sweep resolves every node (each node's inputs come before it), so the result
// is exact. On a map WITH feedback loops there is no perfect order, so we keep
// sweeping — each pass feeds the loop's latest values back into itself — until
// the values stop moving (convergence) or we hit a safety cap (divergence).
// =============================================================================

// How hard the iterative solver tries before giving up. Acyclic maps converge
// in a single sweep; stable feedback loops in a handful; only a runaway
// (positive loop gain ≥ 1) ever reaches the cap.
const SOLVER_MAX_ITERATIONS = 100;
// A sweep counts as "converged" once the largest relative change to any node
// falls below this. Small enough that converged values match the exact
// single-pass result to many significant figures.
const SOLVER_EPSILON = 1e-9;
// Source ratios are floored here before log() so a near-zero source can never
// blow up to -Infinity (matches the original single-pass behaviour).
const SOLVER_LOG_RATIO_FLOOR = 1e-6;

// Look up the elasticity to use for one edge. The CSV's per-edge value wins;
// otherwise we fall back to the default for the edge's effect type.
function resolveEdgeElasticity(edge) {
  if (edge.elasticity !== undefined && edge.elasticity !== null && !isNaN(edge.elasticity)) {
    return edge.elasticity;
  }
  return DEFAULT_ELASTICITY_BY_EFFECT[edge.effect] || 0;
}

// Iterative Cobb-Douglas solver. Produces { nodeId → currentValue } plus a
// non-enumerable `__meta` with { converged, iterations } describing the run.
function computeNodeValues() {
  const values = {};

  // ───── 1. Initialise ──────────────────────────────────────────────────
  // Controllable inputs are pinned to baseline × user multiplier. Every other
  // quantified node is seeded at its baseline (i.e. "no perturbation yet") so
  // loop members have a starting value to feed back on the first sweep. Nodes
  // without a usable baseline are left undefined and skipped throughout.
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
  // Each sweep recomputes every non-controllable node from its incoming edges,
  // writing results in place so later nodes in the sweep see the freshest
  // values. Sweeping in topological order means an acyclic map is fully
  // resolved on the first pass (the second pass then finds zero change and we
  // stop), so DAG results are identical to the original single-pass engine.
  let iterations = 0;
  let converged = false;
  for (; iterations < SOLVER_MAX_ITERATIONS; iterations++) {
    let maxRelDelta = 0;

    for (const nodeId of topologicalOrder) {
      const node = nodeById[nodeId];
      if (!node || node.baseline === undefined || node.baseline === null) continue;
      if (node.controllable) continue;   // pinned by the slider — never recomputed
      const baseline = node.baseline;

      // Cobb-Douglas propagation in log-space (a product of ratios^elasticity,
      // computed additively to avoid floating-point drift).
      let logSum = 0;
      for (const edge of incomingEdges[nodeId]) {
        const sourceNode = nodeById[edge.from];
        // Skip a source with no/zero baseline (would divide-by-zero) or one
        // not yet seeded.
        if (!sourceNode || !sourceNode.baseline || values[edge.from] === undefined) continue;
        const sourceRatio = values[edge.from] / sourceNode.baseline;
        logSum += resolveEdgeElasticity(edge) * Math.log(Math.max(sourceRatio, SOLVER_LOG_RATIO_FLOOR));
      }
      const next = baseline * Math.exp(logSum);

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

    if (maxRelDelta < SOLVER_EPSILON) { converged = true; iterations++; break; }
  }

  // ───── 3. Defensive clamp ─────────────────────────────────────────────
  // The log-ratio floor should keep everything finite, but a runaway positive
  // loop could in principle overflow to Infinity. Fall back to baseline rather
  // than letting NaN/Infinity leak into the UI.
  for (const id in values) {
    if (!Number.isFinite(values[id])) values[id] = nodeById[id].baseline;
  }

  // Stash run status where recomputeValues() can lift it off without it ever
  // being read as a node value (every consumer keys by real node ids).
  Object.defineProperty(values, "__meta", {
    value: { converged: converged, iterations: iterations },
    enumerable: false,
  });
  return values;
}

// Convenience wrapper — recomputes, stores the clean { id → value } map into
// state.computedValues, and records solver status (convergence + loop count)
// into state.solverStatus for the UI to surface.
function recomputeValues() {
  const values = computeNodeValues();
  const meta = values.__meta || { converged: true, iterations: 0 };
  state.computedValues = values;
  state.solverStatus = {
    converged: meta.converged,
    iterations: meta.iterations,
    feedbackLoopCount: (typeof cycleInfo !== "undefined" && cycleInfo) ? cycleInfo.loopCount : 0,
  };
}

// ───── Display helpers (formatting node values for the UI) ────────────────

// "9,000 FTE" or "" if the node has no baseline / current value.
function formatNodeValue(nodeId) {
  const node = nodeById[nodeId];
  if (!node || node.baseline === undefined) return "";
  const value = state.computedValues[nodeId];
  if (value === undefined) return "";
  return formatScalar(value) + " " + (node.unit || "");
}

// "+12.5%" relative to baseline, or "—" if change is negligible.
function formatNodeDelta(nodeId) {
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
function getOutcomeBorderColor(nodeId) {
  const node = nodeById[nodeId];
  if (!node || !node.direction || node.direction === "neutral") return null;
  const delta = formatNodeDelta(nodeId);
  if (Math.abs(delta.pct) < 0.5) return null;

  const isGoodChange = (delta.pct > 0 && node.direction === "higher_better") ||
                       (delta.pct < 0 && node.direction === "lower_better");
  return isGoodChange ? "var(--status-good)" : "var(--status-bad)";
}
