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

import type { Edge } from "./types";
import { NODES, EDGES, nodeById, outgoingEdges, state } from "./03-state";
import { isNodeVisible } from "./10-filters";
import { resolveEdgeElasticity } from "./07-simulation-engine";

export interface RealRenderEdge {
  synthetic: false;
  edge: Edge;
  from: string;
  to: string;
  effect: Edge["effect"];
}

export interface SyntheticRenderEdge {
  synthetic: true;
  id: string;
  from: string;
  to: string;
  effect: "increases" | "decreases" | "neutral";
  netSign: -1 | 0 | 1;
  dashed: boolean;
}

export type RenderEdge = RealRenderEdge | SyntheticRenderEdge;

export interface SynthAccum {
  from: string;
  to: string;
  signs: Set<-1 | 0 | 1>;
  dashed: boolean;
}

// Sign bitmask helpers for the hidden-subgraph expansion below: a hidden node
// is reached with a SET of signs (a positive chain and a negative chain can
// both land on it), tracked as 3 bits so "have I already expanded this node
// with this sign?" is one integer test.
const SIGN_POS = 1, SIGN_NEG = 2, SIGN_ZERO = 4;
const signBit = (product: number): number => product > 0 ? SIGN_POS : product < 0 ? SIGN_NEG : SIGN_ZERO;
const signOfBit = (bit: number): 1 | -1 | 0 => bit === SIGN_POS ? 1 : bit === SIGN_NEG ? -1 : 0;

export function computeRenderEdges(): RenderEdge[] {
  // ───── Fast path: nothing is hidden ──────────────────────────────────────
  // With no hidden streams / stages / categories every node is visible, so
  // every edge is a real visible→visible edge and there are no synthetic
  // re-routes to derive. That is the overwhelmingly common case, and the
  // general path below still pays for a full visibility sweep plus an outgoing
  // walk per node to discover there is nothing to re-route. Same output, same
  // order (real edges are emitted in EDGES order either way).
  if (state.hiddenStreams.size === 0 && state.hiddenStages.size === 0 && state.hiddenCategories.size === 0) {
    const out: RenderEdge[] = [];
    for (const edge of EDGES) {
      // Same endpoint guard the general path gets for free from its
      // visible-id set: an edge naming a node that isn't in NODES is dropped.
      if (!nodeById[edge.from] || !nodeById[edge.to]) continue;
      out.push({ synthetic: false, edge, from: edge.from, to: edge.to, effect: edge.effect });
    }
    return out;
  }

  const renderEdges: RenderEdge[] = [];
  const realPairKey = new Set<string>();   // pairKey() of emitted real visible→visible edges
  const synthAccum  = new Map<string, SynthAccum>();   // pairKey() → { from, to, signs:Set<-1|0|1> }

  // Resolve visibility once per node so the DFS hot path below is a single Set
  // lookup instead of three (stream/category/stage) checks per visit. Unknown
  // ids simply aren't in the set, so this also subsumes the missing-node guard.
  const visibleNodeIds = new Set<string>();
  for (const n of NODES) if (isNodeVisible(n)) visibleNodeIds.add(n.id);
  const isVisibleId = (id: string): boolean => visibleNodeIds.has(id);
  // Length-prefix both halves rather than relying on an identifier delimiter.
  // Canonical imported ids currently exclude "->", but synthetic-edge identity
  // must remain collision-free even for programmatically-constructed models or
  // a future grammar extension.
  const pairKey = (from: string, to: string): string =>
    from.length + ":" + from + to.length + ":" + to;

  // ───── (a) Real edges: both endpoints visible ────────────────────────────
  for (const edge of EDGES) {
    if (isVisibleId(edge.from) && isVisibleId(edge.to)) {
      renderEdges.push({ synthetic: false, edge, from: edge.from, to: edge.to, effect: edge.effect });
      realPairKey.add(pairKey(edge.from, edge.to));
    }
  }

  // ───── (b) Synthetic edges: visible → (hidden…) → visible ─────────────────
  function recordSynth(from: string, to: string, product: number, dashed: boolean): void {
    if (from === to) return;                       // drop degenerate self-loops
    const key = pairKey(from, to);
    if (realPairKey.has(key)) return;              // a real edge already shows this pair
    let acc = synthAccum.get(key);
    if (!acc) { acc = { from, to, signs: new Set<-1 | 0 | 1>(), dashed: false }; synthAccum.set(key, acc); }
    acc.signs.add(product > 0 ? 1 : product < 0 ? -1 : 0);
    // The synthetic edge inherits a dashed look if ANY re-routed chain reaching
    // this pair contains a dashed link.
    if (dashed) acc.dashed = true;
  }

  // Walk forward through the hidden subgraph from one visible source, carrying
  // the SIGN of the product of signed elasticities (and whether any link along
  // the way was dashed).
  //
  // The original version enumerated every simple path, which is exponential in
  // the size of the hidden region — collapsing one dense column could hang the
  // tab for minutes. What actually reaches the far side, though, is only the
  // SET of signs (+ / − / 0) that can arrive at each hidden node: two chains
  // with the same sign produce the same synthetic edge, so re-walking the
  // second one is pure waste. So each (source, hidden node) pair is expanded at
  // most once per sign — three times worst case — which bounds the walk at
  // O(3 · hidden edges) per source instead of O(paths).
  //
  // Where two chains reach one hidden node with CONFLICTING signs, both signs
  // propagate onward and recordSynth sees both, so the pair resolves to the
  // same `neutral` connector the exhaustive walk produced ("a pathway exists,
  // net direction unclear"). Dashedness is a plain OR — any chain reaching a
  // hidden node continues to everything downstream of it — so it stays exact.
  //
  // `seen` maps hidden node id → bitmask of signs already expanded from it;
  // `dashedSeen` marks the ones already expanded with a dashed chain (a dashed
  // arrival has to re-expand so the dash reaches the far side).
  function walkHidden(srcVisibleId: string, firstEdges: readonly Edge[]): void {
    const seen = new Map<string, number>();
    const dashedSeen = new Set<string>();
    // Frontier entries: [hidden node id, sign bit, dashed so far]
    const stack: Array<[string, number, boolean]> = firstEdges.map(firstEdge => [
      firstEdge.to,
      signBit(resolveEdgeElasticity(firstEdge)),
      firstEdge.style === "dashed",
    ]);
    while (stack.length) {
      const [mid, bit, dashed] = stack.pop()!;
      const mask = seen.get(mid) || 0;
      const newSign = (mask & bit) === 0;
      const newDash = dashed && !dashedSeen.has(mid);
      if (!newSign && !newDash) continue;           // nothing new to propagate
      seen.set(mid, mask | bit);
      if (dashed) dashedSeen.add(mid);

      const sign = signOfBit(bit);
      for (const next of outgoingEdges[mid] || []) {
        const p = sign * resolveEdgeElasticity(next);
        const d = dashed || next.style === "dashed";
        if (isVisibleId(next.to)) {
          recordSynth(srcVisibleId, next.to, p, d);  // reached the far visible side
        } else {
          stack.push([next.to, signBit(p), d]);
        }
      }
    }
  }

  for (const a of NODES) {
    if (!visibleNodeIds.has(a.id)) continue;
    const hiddenEntryEdges = (outgoingEdges[a.id] || [])
      .filter(edge => !isVisibleId(edge.to));       // direct visible→visible handled in (a)
    if (hiddenEntryEdges.length) walkHidden(a.id, hiddenEntryEdges);
  }

  for (const acc of synthAccum.values()) {
    const pos = acc.signs.has(1);
    const neg = acc.signs.has(-1);
    let effect: "increases" | "decreases" | "neutral", netSign: -1 | 0 | 1;
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
      dashed: acc.dashed,
    });
  }

  return renderEdges;
}
