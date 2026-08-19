// =============================================================================
// PATHWAY MODE — following ONE strand from start to finish
// -----------------------------------------------------------------------------
// The problem this solves: a map with a few hundred links is honest but
// unreadable. Selecting a box (09-graph-selection.ts) lights up its
// neighbourhood, which grows in every direction at once — at highlight depth 3
// you are back to looking at the whole tangle.
//
// A pathway is the opposite move. Pick two boxes; get ONE ordered chain of
// cause and effect between them, with everything else out of the way. Note the
// data shape: every other traversal result in this app is a Set, because a
// neighbourhood has no order. A route is a LIST — the order is the point, and
// it is what lets a strand be read as a sentence.
//
// Three things make this work at map scale:
//
//   1. SIMPLE paths only (no box visited twice). Causal maps have feedback
//      loops; without this rule "every route from A to B" is infinite. It also
//      matches how people read a strand — going round the loop twice is not a
//      different story.
//
//   2. RANK BY STRENGTH, then cap. Between two well-connected boxes there can
//      be hundreds of routes, and "route 1 of 340" is the overwhelm you were
//      escaping, just relocated. Strength is the product of the links'
//      elasticities: how much of a nudge at the start actually survives the
//      trip. We keep the strongest ten and always report the true total, so the
//      user knows what was dropped.
//
//   3. PRUNE BEFORE WALKING. Only boxes that can still reach the destination
//      are worth stepping into (canReachSet below). Without that the search
//      spends nearly all its time in dead ends.
//
// The other half of the feature is the NET SIGN — the product of the links'
// signs. Two `decreases` links in a row make a net increase, which is the
// single most commonly botched inference on a causal map, and on a straightened
// strand it reads off in one line.
//
// UI for all of this lives in 09b-pathway-ui.ts; this file is pure graph work
// plus the small state transitions.
// =============================================================================

import type { PathwayRoute } from "./types";
import { NODES, edgeById, incomingEdges, nodeById, outgoingEdges, state } from "./03-state";
import { nodeCategoryIds } from "./04-utils";
import { resolveEdgeElasticity } from "./07-simulation-engine";

// How many alternatives the user can cycle through. Ten is about the point
// where "flip through the options" stops being a reading aid and starts being a
// second map to get lost in.
export const PATHWAY_ROUTE_LIMIT = 10;

// Hard stop on the depth-first search. A dense map can hold combinatorially
// many simple paths; without a budget a single Trace click could hang the tab.
// Hitting it means the reported total is a floor ("47+"), never a silent lie.
export const PATHWAY_SEARCH_BUDGET = 400_000;

// ───── Reachability caches ────────────────────────────────────────────────
// Both directions, memoised per node id and dropped whenever the graph changes
// (resetPathwayCaches, called from rebuildIndexes in 06-data-loader.ts).
const _reachTo   = new Map<string, Set<string>>();   // can reach X
const _reachFrom = new Map<string, Set<string>>();   // reachable from X

export function resetPathwayCaches(): void {
  _reachTo.clear();
  _reachFrom.clear();
}

// Every box that can reach `targetId` by following arrows forwards (the target
// included). Walked backwards from the target, which is the cheap direction.
export function canReachSet(targetId: string): Set<string> {
  const cached = _reachTo.get(targetId);
  if (cached) return cached;
  const seen = new Set<string>([targetId]);
  const stack = [targetId];
  while (stack.length) {
    const id = stack.pop()!;
    for (const edge of incomingEdges[id] || []) {
      if (!seen.has(edge.from)) { seen.add(edge.from); stack.push(edge.from); }
    }
  }
  _reachTo.set(targetId, seen);
  return seen;
}

// Every box `sourceId` can reach downstream (the source included).
export function reachableFromSet(sourceId: string): Set<string> {
  const cached = _reachFrom.get(sourceId);
  if (cached) return cached;
  const seen = new Set<string>([sourceId]);
  const stack = [sourceId];
  while (stack.length) {
    const id = stack.pop()!;
    for (const edge of outgoingEdges[id] || []) {
      if (!seen.has(edge.to)) { seen.add(edge.to); stack.push(edge.to); }
    }
  }
  _reachFrom.set(sourceId, seen);
  return seen;
}

// ───── Route enumeration ──────────────────────────────────────────────────

export interface RouteSearchResult {
  /** The strongest routes, strongest first. At most `limit` of them. */
  routes: PathwayRoute[];
  /** How many routes exist in total (a floor when `truncated`). */
  total: number;
  /** True when the search budget ran out before the graph did. */
  truncated: boolean;
}

const EMPTY_RESULT: RouteSearchResult = { routes: [], total: 0, truncated: false };

// Keep `list` sorted strongest-first and no longer than `limit`. Insertion sort
// is the right tool: the list is tiny (10) and we touch it once per route
// found, so a heap would cost more than it saves.
function insertRanked(list: PathwayRoute[], route: PathwayRoute, limit: number): void {
  let i = list.length;
  while (i > 0 && list[i - 1].strength < route.strength) i--;
  if (i >= limit) return;                 // weaker than everything we're keeping
  list.splice(i, 0, route);
  if (list.length > limit) list.pop();
}

// Every simple downstream route from `fromId` to `toId`, strongest first.
//
// "Downstream" is strict: arrows are followed in their own direction only, so
// whatever comes back can be read aloud as a causal claim. If nothing connects
// them that way the result is empty — which is itself worth knowing, and the UI
// offers to look the other way round rather than silently walking arrows
// backwards.
export function findRoutes(
  fromId: string,
  toId: string,
  limit: number = PATHWAY_ROUTE_LIMIT,
): RouteSearchResult {
  if (!fromId || !toId || fromId === toId) return EMPTY_RESULT;
  if (!nodeById[fromId] || !nodeById[toId]) return EMPTY_RESULT;

  // Only boxes that can still reach the destination are worth stepping into.
  const useful = canReachSet(toId);
  if (!useful.has(fromId)) return EMPTY_RESULT;

  const kept: PathwayRoute[] = [];
  let total = 0;
  let steps = 0;
  let truncated = false;

  const nodePath = [fromId];
  const edgePath: string[] = [];
  const onPath = new Set<string>([fromId]);

  // Depth-first walk. `strength` and `sign` are carried down the recursion so a
  // finished route needs no second pass to score it.
  const walk = (id: string, strength: number, sign: number): void => {
    if (truncated) return;
    if (++steps > PATHWAY_SEARCH_BUDGET) { truncated = true; return; }

    for (const edge of outgoingEdges[id] || []) {
      const next = edge.to;
      if (onPath.has(next)) continue;     // simple paths only — no revisits
      if (!useful.has(next)) continue;    // dead end: can't reach the target

      const elasticity = resolveEdgeElasticity(edge);
      const nextStrength = strength * Math.abs(elasticity);
      const nextSign = sign * (elasticity < 0 ? -1 : 1);

      nodePath.push(next);
      edgePath.push(edge.id!);
      onPath.add(next);

      if (next === toId) {
        total++;
        insertRanked(kept, {
          nodeIds: nodePath.slice(),
          edgeIds: edgePath.slice(),
          strength: nextStrength,
          sign: nextSign > 0 ? 1 : -1,
        }, limit);
      } else {
        walk(next, nextStrength, nextSign);
      }

      nodePath.pop();
      edgePath.pop();
      onPath.delete(next);
      if (truncated) return;
    }
  };

  walk(fromId, 1, 1);
  return { routes: kept, total, truncated };
}

// ───── Suggested strands ──────────────────────────────────────────────────
// Given a box, what complete start-to-finish stories is it part of? This is the
// one-click entry point: you are looking at a box and want to know where it
// sits in the bigger picture, without having to already know both ends.
//
// "Start" and "finish" need definitions, and the obvious ones (no incoming
// arrows / no outgoing arrows) degenerate on a map with feedback loops, where
// almost nothing is a true sink. So each rule has a second half that uses what
// the spreadsheet already says: an adjustable input is a place a story can
// start, and a box carrying a direction-of-merit is a place one can end.
export const isStrandStart = (nodeId: string): boolean => {
  const node = nodeById[nodeId];
  if (!node) return false;
  return (incomingEdges[nodeId] || []).length === 0 || node.controllable === true;
};

export const isStrandEnd = (nodeId: string): boolean => {
  const node = nodeById[nodeId];
  if (!node) return false;
  return (outgoingEdges[nodeId] || []).length === 0 || !!node.direction;
};

// How many candidate ends to walk from / to, and how many segments to keep from
// each. Both deliberately small: this runs on every selection change, and the
// user is choosing from a short list, not auditing the graph.
const SUGGEST_SEGMENTS_PER_END = 3;
const SUGGEST_LIMIT = 6;

export function suggestStrandsThrough(nodeId: string, limit: number = SUGGEST_LIMIT): PathwayRoute[] {
  if (!nodeById[nodeId]) return [];

  const pivot: PathwayRoute = { nodeIds: [nodeId], edgeIds: [], strength: 1, sign: 1 };
  const upstream = canReachSet(nodeId);
  const downstream = reachableFromSet(nodeId);

  // Segments running INTO the box, and segments running OUT of it. When the box
  // is itself an end of the strand, that side is just the box.
  const heads = isStrandStart(nodeId)
    ? [pivot]
    : NODES
        .filter(n => n.id !== nodeId && isStrandStart(n.id) && upstream.has(n.id))
        .flatMap(n => findRoutes(n.id, nodeId, SUGGEST_SEGMENTS_PER_END).routes);

  const tails = isStrandEnd(nodeId)
    ? [pivot]
    : NODES
        .filter(n => n.id !== nodeId && isStrandEnd(n.id) && downstream.has(n.id))
        .flatMap(n => findRoutes(nodeId, n.id, SUGGEST_SEGMENTS_PER_END).routes);

  // Fall back to the box itself if one side turned up nothing, so an orphaned
  // box still yields whatever half-strand does exist.
  const ins  = heads.length ? heads : [pivot];
  const outs = tails.length ? tails : [pivot];

  const combined: PathwayRoute[] = [];
  for (const head of ins) {
    for (const tail of outs) {
      // Both sides trivial → the "strand" is a single box. Not a strand.
      if (head.nodeIds.length === 1 && tail.nodeIds.length === 1) continue;
      // Joining two halves can re-enter a box the other half already used;
      // that would break the no-revisits rule the whole feature rests on.
      const revisits = tail.nodeIds.slice(1).some(id => head.nodeIds.includes(id));
      if (revisits) continue;
      combined.push({
        nodeIds: head.nodeIds.concat(tail.nodeIds.slice(1)),
        edgeIds: head.edgeIds.concat(tail.edgeIds),
        strength: head.strength * tail.strength,
        sign: (head.sign * tail.sign) > 0 ? 1 : -1,
      });
    }
  }

  combined.sort((a, b) => b.strength - a.strength);
  const seen = new Set<string>();
  const unique: PathwayRoute[] = [];
  for (const route of combined) {
    const key = route.nodeIds.join(">");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(route);
    if (unique.length >= limit) break;
  }
  return unique;
}

// ───── Reading the current pathway ────────────────────────────────────────
// `routes.length > 0` IS the mode flag — there is no separate boolean to keep
// in step with it.

export const pathwayActive = (): boolean => state.pathway.routes.length > 0;

export function currentRoute(): PathwayRoute | null {
  const p = state.pathway;
  return p.routes[p.routeIndex] || null;
}

// The current strand's boxes and links, as sets for O(1) membership.
//
// These are CACHED, not rebuilt per call. The renderer asks "is this box on the
// strand?" once per drawn box per frame, and allocating a fresh Set each time
// would put a garbage-collection cost right in the middle of the hot render
// path this app has already been tuned to keep clear. Every state transition
// below ends with syncActiveSets(), so the cache cannot drift.
//
// Treat the returned sets as read-only — callers that need to keep or extend
// one (the export selection, say) must copy it first.
let _activeNodeIds = new Set<string>();
let _activeEdgeIds = new Set<string>();
let _activeHopIndex = new Map<string, number>();

function syncActiveSets(): void {
  const route = currentRoute();
  _activeNodeIds = new Set(route ? route.nodeIds : []);
  _activeEdgeIds = new Set(route ? route.edgeIds : []);
  _activeHopIndex = new Map();
  if (route) route.nodeIds.forEach((id, i) => _activeHopIndex.set(id, i + 1));
}

export function pathwayNodeSet(): Set<string> { return _activeNodeIds; }
export function pathwayEdgeSet(): Set<string> { return _activeEdgeIds; }

// 1-based hop number for a box on the current strand, or 0 when it isn't on it.
// Drawn as the little numbered badge on each box, so the map and the
// straightened view number the same box the same way.
export function hopNumber(nodeId: string): number {
  return _activeHopIndex.get(nodeId) || 0;
}

// How many links along the strand run against the grain. The count is what
// makes the net sign checkable rather than something to take on faith.
export function signFlipCount(route: PathwayRoute): number {
  let flips = 0;
  for (const edgeId of route.edgeIds) {
    const edge = edgeById[edgeId];
    if (edge && resolveEdgeElasticity(edge) < 0) flips++;
  }
  return flips;
}

// The rows a strand passes through. Crossing rows is usually the interesting
// part of a strand — it is where a story stops being one team's business.
export function streamsCrossed(route: PathwayRoute): number {
  return new Set(route.nodeIds.map(id => nodeById[id] && nodeById[id].stream)).size;
}

// ───── Filters: showing a strand that runs through a hidden slice ─────────
// Pathway mode searches the WHOLE map on purpose. Refusing to route through a
// row the user has collapsed would read as "these two aren't connected", which
// is a lie. But a box in a collapsed row has no position to draw at, so a
// strand that crosses one has to reopen it.
//
// We do that by actually clearing those filters — a visible change the user can
// see happen in the sidebar, not a hidden override — and remembering exactly
// which ids we cleared so leaving pathway mode puts them back. Filters the user
// touches themselves while a strand is up are untouched by the restore.
let _filtersOpenedForPathway: { streams: string[]; stages: string[]; categories: string[] } | null = null;

function openFiltersForRoute(route: PathwayRoute | null): void {
  if (!route) return;
  const streams: string[] = [], stages: string[] = [], categories: string[] = [];
  for (const id of route.nodeIds) {
    const node = nodeById[id];
    if (!node) continue;
    if (state.hiddenStreams.has(node.stream) && !streams.includes(node.stream)) streams.push(node.stream);
    if (state.hiddenStages.has(node.stage) && !stages.includes(node.stage)) stages.push(node.stage);
    // A category filter only removes a box when EVERY category it carries is
    // hidden, so we reopen just enough to bring the box back — not every tag.
    const cats = nodeCategoryIds(node);
    if (cats.length && cats.every(c => state.hiddenCategories.has(c))) {
      if (!categories.includes(cats[0])) categories.push(cats[0]);
    }
  }
  if (!streams.length && !stages.length && !categories.length) return;

  for (const id of streams)    state.hiddenStreams.delete(id);
  for (const id of stages)     state.hiddenStages.delete(id);
  for (const id of categories) state.hiddenCategories.delete(id);

  const prior = _filtersOpenedForPathway || { streams: [], stages: [], categories: [] };
  _filtersOpenedForPathway = {
    streams:    prior.streams.concat(streams.filter(id => !prior.streams.includes(id))),
    stages:     prior.stages.concat(stages.filter(id => !prior.stages.includes(id))),
    categories: prior.categories.concat(categories.filter(id => !prior.categories.includes(id))),
  };
}

function restoreFiltersAfterPathway(): void {
  const opened = _filtersOpenedForPathway;
  _filtersOpenedForPathway = null;
  if (!opened) return;
  for (const id of opened.streams)    state.hiddenStreams.add(id);
  for (const id of opened.stages)     state.hiddenStages.add(id);
  for (const id of opened.categories) state.hiddenCategories.add(id);
}

/** Did showing this strand have to reopen a filtered-away row / column / tag?
 *  The panel says so rather than letting the sidebar change under the user. */
export function pathwayReopenedFilters(): boolean {
  return !!_filtersOpenedForPathway;
}

// ───── State transitions ──────────────────────────────────────────────────

// Trace a strand. Returns the search result so the caller can tell "no route"
// apart from "no route this way round" and offer the swap.
export function startPathway(fromId: string, toId: string): RouteSearchResult {
  const result = findRoutes(fromId, toId);
  const p = state.pathway;
  p.fromId = fromId;
  p.toId = toId;
  p.routes = result.routes;
  p.routeIndex = 0;
  p.totalRoutes = result.total;
  p.truncated = result.truncated;
  if (!result.routes.length) p.view = "map";
  syncActiveSets();
  openFiltersForRoute(currentRoute());
  return result;
}

// Put an already-computed strand on screen — used by the suggestion list, where
// the user picked a specific chain. We still run the A→B search so the ‹ ›
// control has the other routes between the same two ends to cycle through, and
// land on the one they actually clicked.
export function showRoute(route: PathwayRoute): void {
  const fromId = route.nodeIds[0];
  const toId = route.nodeIds[route.nodeIds.length - 1];
  const result = startPathway(fromId, toId);
  const key = route.nodeIds.join(">");
  const at = result.routes.findIndex(r => r.nodeIds.join(">") === key);
  if (at >= 0) {
    state.pathway.routeIndex = at;
  } else {
    // The clicked strand was outside the top ten (it can be: suggestions rank
    // whole start-to-finish stories, the ‹ › list ranks routes between these
    // two ends). Show it anyway rather than quietly swapping in a different
    // chain — the user asked for this one.
    state.pathway.routes = [route, ...result.routes].slice(0, PATHWAY_ROUTE_LIMIT);
    state.pathway.routeIndex = 0;
  }
  syncActiveSets();
  openFiltersForRoute(currentRoute());
}

export function clearPathway(): void {
  const p = state.pathway;
  p.fromId = null;
  p.toId = null;
  p.routes = [];
  p.routeIndex = 0;
  p.totalRoutes = 0;
  p.truncated = false;
  p.view = "map";
  syncActiveSets();
  restoreFiltersAfterPathway();
}

// Cycle through the alternatives, wrapping at both ends.
export function stepRoute(delta: number): void {
  const p = state.pathway;
  if (p.routes.length < 2) return;
  p.routeIndex = (p.routeIndex + delta + p.routes.length) % p.routes.length;
  syncActiveSets();
  openFiltersForRoute(currentRoute());
}

export function selectRoute(index: number): void {
  const p = state.pathway;
  if (index < 0 || index >= p.routes.length) return;
  p.routeIndex = index;
  syncActiveSets();
  openFiltersForRoute(currentRoute());
}

export function setPathwayView(view: "map" | "ribbon"): void {
  state.pathway.view = pathwayActive() ? view : "map";
}

// ───── Keeping the strand honest when the map changes ─────────────────────
// A strand names boxes and links by id. An edit can delete either out from
// under it, and half a strand is worse than none — so re-resolve it against the
// current graph and drop it if it no longer holds. Called after any mutation
// that rebuilds the indexes (06-data-loader.ts).
export function revalidatePathway(): void {
  const p = state.pathway;
  if (!p.routes.length) return;

  const stillThere = (route: PathwayRoute): boolean =>
    route.nodeIds.every(id => !!nodeById[id]) &&
    route.edgeIds.every(id => !!edgeById[id]);

  const survivors = p.routes.filter(stillThere);
  if (!survivors.length) {
    // Both ends still exist → the strand was broken by an edit rather than
    // deleted; re-trace so the user keeps the pathway they were reading.
    if (p.fromId && p.toId && nodeById[p.fromId] && nodeById[p.toId]) {
      const again = findRoutes(p.fromId, p.toId);
      if (again.routes.length) {
        p.routes = again.routes;
        p.routeIndex = 0;
        p.totalRoutes = again.total;
        p.truncated = again.truncated;
        syncActiveSets();
        return;
      }
    }
    clearPathway();
    return;
  }
  const wasShowing = p.routes[p.routeIndex];
  p.routes = survivors;
  const at = wasShowing ? survivors.indexOf(wasShowing) : -1;
  p.routeIndex = at >= 0 ? at : 0;
  syncActiveSets();
}
