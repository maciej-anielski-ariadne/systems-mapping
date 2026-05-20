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
// We compute values in topological order (set up in 06-data-loader.js) so each
// node's inputs are already resolved by the time we get to it.
// =============================================================================

// Look up the elasticity to use for one edge. The CSV's per-edge value wins;
// otherwise we fall back to the default for the edge's effect type.
function resolveEdgeElasticity(edge) {
  if (edge.elasticity !== undefined && edge.elasticity !== null && !isNaN(edge.elasticity)) {
    return edge.elasticity;
  }
  return DEFAULT_ELASTICITY_BY_EFFECT[edge.effect] || 0;
}

// Walk nodes in topological order, producing { nodeId → currentValue }.
function computeNodeValues() {
  const values = {};

  for (const nodeId of topologicalOrder) {
    const node = nodeById[nodeId];
    if (!node || node.baseline === undefined || node.baseline === null) continue;
    const baseline = node.baseline;

    // For controllable (exogenous) inputs: value = baseline × user multiplier.
    if (node.controllable) {
      const userMultiplier = state.userOverrides[nodeId] !== undefined ? state.userOverrides[nodeId] : 1.0;
      values[nodeId] = baseline * userMultiplier;
      continue;
    }

    // For everything else: Cobb-Douglas propagation from incoming edges.
    // We compute in log-space then exp(...) at the end — equivalent to a
    // product of ratios^elasticity, but avoids floating-point drift.
    let logSum = 0;
    for (const edge of incomingEdges[nodeId]) {
      const sourceNode = nodeById[edge.from];
      // Skip if the source has no baseline, a zero baseline (would divide-by-zero
      // and propagate Infinity/NaN downstream), or hasn't been computed yet.
      if (!sourceNode || !sourceNode.baseline || values[edge.from] === undefined) continue;
      const sourceRatio = values[edge.from] / sourceNode.baseline;
      const elasticity = resolveEdgeElasticity(edge);
      // Floor at a tiny positive number so log() never blows up.
      logSum += elasticity * Math.log(Math.max(sourceRatio, 1e-6));
    }
    values[nodeId] = baseline * Math.exp(logSum);
  }
  return values;
}

// Convenience wrapper — recomputes and stores into state.computedValues.
function recomputeValues() {
  state.computedValues = computeNodeValues();
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
