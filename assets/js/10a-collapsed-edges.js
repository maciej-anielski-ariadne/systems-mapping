// =============================================================================
// COLLAPSED-EDGE REROUTING — keep causal effects legible across hidden stages
// -----------------------------------------------------------------------------
// When the user hides a stage (or a stream / category), its nodes drop off the
// map. Naively that would also drop every edge that touched them — and a causal
// chain like  A → (hidden) → B  would vanish, even though both A and B are still
// on screen. That defeats the point of collapsing an *intermediate* stage.
//
// `computeRenderEdges()` produces the list the renderer actually draws:
//   • REAL edges      — both endpoints visible → drawn as-is, fully interactive.
//   • SYNTHETIC edges — a directed path from a visible node A, through one or
//                       more HIDDEN nodes, to another visible node B. We draw a
//                       single dashed "through" arrow A → B so the pathway stays
//                       visible. These are presentation-only: not selectable,
//                       not editable, not part of the data model.
//
// Net direction: the effect of a synthetic edge is derived from the SIGN of the
// product of signed elasticities along the path (resolveEdgeElasticity, which is
// negative for `decreases`). A net-positive product reads as `increases`, a
// net-negative one as `decreases`. There is no synthetic `enables`: once effects
// compose, only the sign carries meaning. When several hidden paths join the
// same A → B pair with conflicting signs (or the product is exactly zero), we
// fall back to a `neutral` connector — "a pathway exists, net direction unclear".
//
// Hiding is purely a view concern: the simulation engine (07) still runs over
// the full NODES/EDGES, so the math is unchanged — we only re-route what's drawn.
// =============================================================================

function computeRenderEdges() {
  const renderEdges = [];
  const SEP = "";
  const realPairKey = new Set();   // "fromto" of emitted real visible→visible edges
  const synthAccum  = new Map();   // "fromto" → { from, to, signs:Set<-1|0|1> }

  const isVisibleId = id => {
    const n = nodeById[id];
    return !!(n && isNodeVisible(n));
  };

  // ───── (a) Real edges: both endpoints visible ────────────────────────────
  for (const edge of EDGES) {
    if (!nodeById[edge.from] || !nodeById[edge.to]) continue;
    if (isVisibleId(edge.from) && isVisibleId(edge.to)) {
      renderEdges.push({ synthetic: false, edge, from: edge.from, to: edge.to, effect: edge.effect });
      realPairKey.add(edge.from + SEP + edge.to);
    }
  }

  // ───── (b) Synthetic edges: visible → (hidden…) → visible ─────────────────
  function recordSynth(from, to, product) {
    if (from === to) return;                       // drop degenerate self-loops
    const key = from + SEP + to;
    if (realPairKey.has(key)) return;              // a real edge already shows this pair
    let acc = synthAccum.get(key);
    if (!acc) { acc = { from, to, signs: new Set() }; synthAccum.set(key, acc); }
    acc.signs.add(product > 0 ? 1 : product < 0 ? -1 : 0);
  }

  // Walk forward from a hidden node, multiplying signed elasticities. `pathHidden`
  // is the set of hidden node ids on the CURRENT path; backtracking on return
  // lets two distinct branches each pass through a shared hidden node (diamonds)
  // while still preventing infinite recursion around hidden cycles.
  function dfsThroughHidden(srcVisibleId, hiddenEdge, product, pathHidden) {
    const mid = hiddenEdge.to;                      // hidden by construction
    for (const next of outgoingEdges[mid]) {
      const p = product * resolveEdgeElasticity(next);
      if (isVisibleId(next.to)) {
        recordSynth(srcVisibleId, next.to, p);       // reached the far visible side
      } else if (!pathHidden.has(next.to)) {
        pathHidden.add(next.to);
        dfsThroughHidden(srcVisibleId, next, p, pathHidden);
        pathHidden.delete(next.to);
      }
    }
  }

  for (const a of NODES) {
    if (!isNodeVisible(a)) continue;
    for (const e0 of outgoingEdges[a.id]) {
      if (isVisibleId(e0.to)) continue;            // direct visible→visible handled in (a)
      dfsThroughHidden(a.id, e0, resolveEdgeElasticity(e0), new Set([e0.to]));
    }
  }

  for (const acc of synthAccum.values()) {
    const pos = acc.signs.has(1);
    const neg = acc.signs.has(-1);
    let effect, netSign;
    if (pos && !neg)      { effect = "increases"; netSign = 1; }
    else if (neg && !pos) { effect = "decreases"; netSign = -1; }
    else                  { effect = "neutral";   netSign = 0; }   // conflicting or zero
    renderEdges.push({
      synthetic: true,
      id: "syn:" + acc.from + "->" + acc.to,
      from: acc.from,
      to: acc.to,
      effect,
      netSign,
    });
  }

  return renderEdges;
}
