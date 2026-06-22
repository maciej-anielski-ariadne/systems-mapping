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
import { NODES, EDGES, outgoingEdges } from "./03-state";
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

export function computeRenderEdges(): RenderEdge[] {
  const renderEdges: RenderEdge[] = [];
  const realPairKey = new Set<string>();   // pairKey() of emitted real visible→visible edges
  const synthAccum  = new Map<string, SynthAccum>();   // pairKey() → { from, to, signs:Set<-1|0|1> }

  // Resolve visibility once per node so the DFS hot path below is a single Set
  // lookup instead of three (stream/category/stage) checks per visit. Unknown
  // ids simply aren't in the set, so this also subsumes the missing-node guard.
  const visibleNodeIds = new Set<string>();
  for (const n of NODES) if (isNodeVisible(n)) visibleNodeIds.add(n.id);
  const isVisibleId = (id: string): boolean => visibleNodeIds.has(id);
  // node ids are slugs without "->", so "a"+"bc" and "ab"+"c" stay distinct.
  const pairKey = (from: string, to: string): string => from + "->" + to;

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

  // Walk forward from a hidden node, multiplying signed elasticities. `pathHidden`
  // is the set of hidden node ids on the CURRENT path; backtracking on return
  // lets two distinct branches each pass through a shared hidden node (diamonds)
  // while still preventing infinite recursion around hidden cycles.
  function dfsThroughHidden(srcVisibleId: string, hiddenEdge: Edge, product: number, pathHidden: Set<string>, pathDashed: boolean): void {
    const mid = hiddenEdge.to;                      // hidden by construction
    for (const next of outgoingEdges[mid]) {
      const p = product * resolveEdgeElasticity(next);
      const d = pathDashed || next.style === "dashed";
      if (isVisibleId(next.to)) {
        recordSynth(srcVisibleId, next.to, p, d);    // reached the far visible side
      } else if (!pathHidden.has(next.to)) {
        pathHidden.add(next.to);
        dfsThroughHidden(srcVisibleId, next, p, pathHidden, d);
        pathHidden.delete(next.to);
      }
    }
  }

  for (const a of NODES) {
    if (!visibleNodeIds.has(a.id)) continue;
    for (const e0 of outgoingEdges[a.id]) {
      if (isVisibleId(e0.to)) continue;            // direct visible→visible handled in (a)
      dfsThroughHidden(a.id, e0, resolveEdgeElasticity(e0), new Set([e0.to]), e0.style === "dashed");
    }
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
