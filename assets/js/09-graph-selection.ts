// =============================================================================
// GRAPH TRAVERSAL + SELECTION
// -----------------------------------------------------------------------------
// When the user clicks a node we highlight only its DIRECT connections:
//   • Its direct inputs  (nodes with an edge pointing straight into it)
//   • Its direct outputs (nodes it has an edge pointing straight to)
//   • The edges between the selected node and those direct neighbours
//
// (We deliberately stop at one hop rather than walking the whole upstream /
// downstream tree — the immediate connections are what the user is usually
// reasoning about, and lighting up the full transitive closure swamps that.)
//
// This file contains the neighbour helpers plus the small selectNode /
// deselectNode functions that update state and trigger a re-render.
// =============================================================================

import type { Edge } from "./types";
import { maxReachableDepth } from "./04-utils";
import {
  state,
  incomingEdges,
  outgoingEdges,
  NODES,
  EDGES,
  edgeById,
  layout,
  topologicalOrder,
  cycleInfo,
} from "./03-state";
import { commitInlineRename } from "./16h-canvas-inline-rename";
import { endEdgeCycleSession } from "./16e-canvas-edit";
// Selection changes are a class/attribute patch on the slice already drawn —
// renderSelectionChange falls back to a full render() when it can't be.
import { renderSelectionChange } from "./11-rendering";
import { renderDetailPanel } from "./15-detail-panel";
import { renderMultiSelectBar } from "./16j-multi-select-bar";
import { scheduleUiStateSave } from "./04a-storage";

// NOTE: `incomingEdges[id]` and `outgoingEdges[id]` are guaranteed to be
// initialized to [] for every node by rebuildIndexes (06-data-loader.js),
// so we don't need defensive `|| []` fallbacks when reading them.

// Walk outward up to `depth` hops from nodeId, ring by ring — everything one
// arrow away, then everything two arrows away, and so on (this is "breadth-
// first search" / BFS; see docs/GLOSSARY.md). Follows `adjacency`
// (incomingEdges or outgoingEdges) and reads the far end of each edge via
// `endpoint` ("from" or "to"). Returns the set of reached node ids; the start
// node itself is never included. (`frontier` = the ring we're expanding now.)
export function bfsNeighbors(
  nodeId: string,
  depth: number,
  adjacency: Record<string, Edge[]>,
  endpoint: "from" | "to"
): Set<string> {
  const result = new Set<string>();
  let frontier = [nodeId];
  for (let level = 0; level < depth && frontier.length; level++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const edge of adjacency[id]) {
        const neighbour = edge[endpoint];
        if (neighbour !== nodeId && !result.has(neighbour)) {
          result.add(neighbour);
          next.push(neighbour);
        }
      }
    }
    frontier = next;
  }
  return result;
}

// Upstream neighbours up to `depth` hops away (depth 1 = direct inputs only, the
// historical behaviour); downstream is the mirror following outgoing edges.
export function getAncestors(nodeId: string, depth: number = state.highlightDepth): Set<string> {
  return bfsNeighbors(nodeId, depth, incomingEdges, "from");
}

export function getDescendants(nodeId: string, depth: number = state.highlightDepth): Set<string> {
  return bfsNeighbors(nodeId, depth, outgoingEdges, "to");
}

// Edges crossed while walking up- and downstream within `depth` hops of the
// selected node — i.e. every edge along the highlighted ancestor/descendant
// chains. BFS by node, collecting edge ids as we step outward.
export function computeHighlightedEdges(
  nodeId: string,
  depth: number = state.highlightDepth,
  showUp = true,
  showDown = true
): Set<string> {
  const edges = new Set<string>();
  const directions: Array<[Record<string, Edge[]>, "from" | "to"]> = [];
  if (showUp)   directions.push([incomingEdges, "from"]);   // upstream chain
  if (showDown) directions.push([outgoingEdges, "to"]);     // downstream chain
  for (const [adjacency, endpointKey] of directions) {
    const visited = new Set([nodeId]);
    let frontier = [nodeId];
    for (let level = 0; level < depth && frontier.length; level++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const edge of adjacency[id]) {
          edges.add(edge.id!);
          const neighbour = edge[endpointKey];
          if (!visited.has(neighbour)) {
            visited.add(neighbour);
            next.push(neighbour);
          }
        }
      }
      frontier = next;
    }
  }
  return edges;
}

// The deepest highlight that still reveals new nodes: the longest shortest-path
// distance (in hops) between any two connected nodes. Walking downstream from
// every node is enough to find it — the longest shortest path, measured
// downstream from its start, is the same path measured upstream from its end,
// so we don't need a second upstream sweep. Past this depth, raising the
// highlight lights up nothing further, so the depth control (17-events.js) uses
// it as a dynamic cap instead of a fixed ceiling. Cached into the global
// `maxHighlightDepth` by rebuildIndexes. Falls back to 1 for an edge-less map.
// Defers to the shared maxReachableDepth primitive (04-utils), which the export
// viewer's cap also uses, so the two stay in lockstep.
// Above this budget (≈ nodes × (nodes + edges)) the exact all-pairs BFS is too
// slow to run inside rebuildIndexes — it froze large maps for 100+ ms on every
// single edit — so big maps switch to a cheap O(N+E) upper bound instead.
const EXACT_DEPTH_BUDGET = 2_000_000;

export function computeMaxHighlightDepth(): number {
  const n = NODES.length;
  const e = EDGES.length;
  if (n === 0) return 1;

  if (n * (n + e) <= EXACT_DEPTH_BUDGET) {
    // Small map: exact answer, same as always. Pre-resolve each node's
    // neighbour ids ONCE — the callback used to allocate a fresh array on
    // every BFS visit, i.e. O(N·E) throwaway arrays across the sweep.
    const neighborIds: Record<string, string[]> = {};
    for (const node of NODES) {
      neighborIds[node.id] = outgoingEdges[node.id].map((edge) => edge.to);
    }
    return maxReachableDepth(NODES.map(node => node.id), id => neighborIds[id]);
  }

  // Large map: an upper bound is enough — the value only caps the depth
  // spinner, and a too-high cap merely lets the user step past the point
  // where nothing new lights up. Never under-estimate (that would truncate
  // the control).
  if (cycleInfo.inCycleNodeIds.size === 0) {
    // Acyclic: longest path in hops via one pass over the topological order.
    // Always ≥ the longest shortest-path (the exact answer), so it's a safe cap.
    const depthByNode: Record<string, number> = {};
    let max = 1;
    for (const id of topologicalOrder) {
      const d = depthByNode[id] || 0;
      for (const edge of outgoingEdges[id]) {
        const next = d + 1;
        if (next > (depthByNode[edge.to] || 0)) {
          depthByNode[edge.to] = next;
          if (next > max) max = next;
        }
      }
    }
    return max;
  }
  // Cyclic large map: no cheap tight bound exists; N−1 bounds any BFS depth.
  return Math.max(1, n - 1);
}

// ───── Select / deselect ──────────────────────────────────────────────────

// Recompute the ancestor / descendant / highlighted-edge sets for the current
// selection. Neighbour highlighting only makes sense for a single selected node
// — when more than one node is selected we clear it so the canvas isn't a wall
// of blue/amber borders. Called by selectNode / toggle / marquee / setSelection.
export function refreshNeighborHighlight(): void {
  if (state.selectedNodeIds.size === 1 && state.selectedNodeId) {
    Object.assign(state, computeTraceFor(state.selectedNodeId));
  } else {
    state.ancestorSet        = new Set();
    state.descendantSet      = new Set();
    state.highlightedEdgeIds = new Set();
  }
}

// The ancestor / descendant / highlighted-edge sets for a node's causal trace,
// honouring the sidebar "Trace" filter (state.hiddenTrace can suppress the
// upstream and/or downstream side). Shared by node selection and edge selection.
export function computeTraceFor(nodeId: string): {
  ancestorSet: Set<string>;
  descendantSet: Set<string>;
  highlightedEdgeIds: Set<string>;
} {
  const showUp   = !state.hiddenTrace.has("ancestors");
  const showDown = !state.hiddenTrace.has("descendants");
  return {
    ancestorSet:        showUp   ? getAncestors(nodeId)   : new Set(),
    descendantSet:      showDown ? getDescendants(nodeId) : new Set(),
    highlightedEdgeIds: computeHighlightedEdges(nodeId, state.highlightDepth, showUp, showDown),
  };
}

// Recompute the current selection's trace in place (used when the trace filter
// toggles). Works for a selected node or a selected edge (both set selectedNodeId).
export function refreshTraceForSelection(): void {
  if (state.selectedNodeId) Object.assign(state, computeTraceFor(state.selectedNodeId));
}

// Toggle behaviour: clicking the already-selected node deselects it. A plain
// click always collapses to a single-node selection (clearing any multi-set).
export function selectNode(nodeId: string): void {
  // Any selection change ends an in-flight inline rename — fold the typed
  // characters into a single history snapshot before moving on. Safe to call
  // when no rename is active (no-op). See 16h-canvas-inline-rename.js.
  if (state.selectedNodeId !== nodeId && typeof commitInlineRename === "function") {
    commitInlineRename();
  }
  // Selecting a node clears any selected-edge cycle session — the burst of
  // arrow presses on the previously-selected edge is now finalised in history.
  if (typeof endEdgeCycleSession === "function") endEdgeCycleSession();
  // Empty-cell keyboard cursor (16i) is mutually exclusive with a selected
  // node — picking a node retires the placeholder.
  if (state.canvasEdit) state.canvasEdit.cursorCell = null;
  // Toggle off only when this is the lone current selection — clicking one of
  // several multi-selected nodes collapses to just that node instead.
  if (state.selectedNodeId === nodeId && state.selectedNodeIds.size <= 1) {
    deselectNode();
    return;
  }
  state.selectedNodeId = nodeId;
  state.selectedNodeIds = new Set([nodeId]);
  state.selectedEdgeId = null;   // node and edge selection are mutually exclusive
  refreshNeighborHighlight();
  renderSelectionChange();
  renderDetailPanel();
  if (typeof renderMultiSelectBar === "function") renderMultiSelectBar();
  scheduleUiStateSave();
}

// Shift+click a node: add it to / remove it from the multi-selection without
// disturbing the rest. The newest-added node becomes the primary; removing the
// primary re-picks another member (or clears selection entirely).
export function toggleNodeInSelection(nodeId: string): void {
  if (typeof commitInlineRename === "function") commitInlineRename();
  if (typeof endEdgeCycleSession === "function") endEdgeCycleSession();
  if (state.canvasEdit) state.canvasEdit.cursorCell = null;
  state.selectedEdgeId = null;
  if (state.selectedNodeIds.has(nodeId)) {
    state.selectedNodeIds.delete(nodeId);
    if (state.selectedNodeId === nodeId) {
      const remaining = [...state.selectedNodeIds];
      state.selectedNodeId = remaining.length ? remaining[remaining.length - 1] : null;
    }
  } else {
    state.selectedNodeIds.add(nodeId);
    state.selectedNodeId = nodeId;   // newest becomes primary
  }
  refreshNeighborHighlight();
  renderSelectionChange();
  renderDetailPanel();
  if (typeof renderMultiSelectBar === "function") renderMultiSelectBar();
  scheduleUiStateSave();
}

// Replace the whole selection with the given ids, picking primaryId as primary
// when it's a member (else the first id). Deliberately does NOT render — the
// caller (e.g. the marquee move loop) renders once after calling this.
export function setSelection(ids: Iterable<string>, primaryId?: string | null): void {
  if (typeof endEdgeCycleSession === "function") endEdgeCycleSession();
  state.selectedNodeIds = new Set(ids);
  state.selectedEdgeId = null;
  if (state.selectedNodeIds.size) {
    state.selectedNodeId = (primaryId && state.selectedNodeIds.has(primaryId))
      ? primaryId
      : [...state.selectedNodeIds][0];
  } else {
    state.selectedNodeId = null;
  }
  refreshNeighborHighlight();
}

export function deselectNode(): void {
  if (typeof commitInlineRename === "function") commitInlineRename();
  if (typeof endEdgeCycleSession === "function") endEdgeCycleSession();
  state.selectedNodeId = null;
  state.selectedNodeIds = new Set();
  state.selectedEdgeId = null;
  state.ancestorSet = new Set();
  state.descendantSet = new Set();
  state.highlightedEdgeIds = new Set();
  renderSelectionChange();
  renderDetailPanel();
  if (typeof renderMultiSelectBar === "function") renderMultiSelectBar();
  scheduleUiStateSave();
}

// Clicking an edge on the canvas selects the edge's source node and opens
// the detail panel in edit mode, scrolling the corresponding row in the
// outgoing-edges list into view and briefly flashing it so the user sees
// which edge they clicked. Edges no longer have their own detail panel —
// they're always edited from their from-node.
export function selectEdge(edgeId: string): void {
  if (!state.canvasEdit) return;
  const edge = edgeById[edgeId];
  if (!edge) return;
  // Selecting a different edge ends the previous edge's cycle session — its
  // pre-cycle snapshot is already in history, so undo still rewinds it.
  if (state.canvasEdit.edgeCycleSession &&
      state.canvasEdit.edgeCycleSession.edgeId !== edgeId &&
      typeof endEdgeCycleSession === "function") {
    endEdgeCycleSession();
  }
  state.canvasEdit.editMode = true;
  state.canvasEdit.flashedEdgeId = edgeId;
  // Promote to a real selection so Delete-key dispatch (16e:deleteSelection)
  // and the .edge-path.selected CSS (05-visualization.css:260) both fire.
  state.selectedEdgeId = edgeId;
  // Edge selection is its own mode — drop any multi-node selection so the
  // batch action bar hides and Delete targets the edge.
  state.selectedNodeIds = new Set();
  if (typeof renderMultiSelectBar === "function") renderMultiSelectBar();

  if (state.selectedNodeId === edge.from) {
    renderSelectionChange();
    renderDetailPanel();
  } else {
    // selectNode toggles when called with the current id; we already handled
    // that above so it's safe to set directly here.
    state.selectedNodeId = edge.from;
    Object.assign(state, computeTraceFor(edge.from));
    renderSelectionChange();
    renderDetailPanel();
    scheduleUiStateSave();
  }

  // After the panel renders, scroll the flashed row into view + auto-clear
  // the flash flag once the CSS animation has run.
  setTimeout(() => {
    const row = document.querySelector('[data-edge-row-id="' + CSS.escape(edgeId) + '"]');
    if (row && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, 30);
  setTimeout(() => {
    if (state.canvasEdit && state.canvasEdit.flashedEdgeId === edgeId) {
      state.canvasEdit.flashedEdgeId = null;
    }
  }, 1800);
}

// Clears node selection. The empty-SVG click handler calls this. (Edges
// don't get their own selection any more — clicking an edge goes through
// selectEdge above, which is just a navigation helper.)
export function deselectAll(): void {
  if (typeof commitInlineRename === "function") commitInlineRename();
  if (state.canvasEdit) state.canvasEdit.cursorCell = null;
  state.selectedNodeId = null;
  state.selectedNodeIds = new Set();
  state.selectedEdgeId = null;
  state.ancestorSet = new Set();
  state.descendantSet = new Set();
  state.highlightedEdgeIds = new Set();
  if (state.canvasEdit) state.canvasEdit.flashedEdgeId = null;
  renderSelectionChange();
  renderDetailPanel();
  if (typeof renderMultiSelectBar === "function") renderMultiSelectBar();
  scheduleUiStateSave();
}

// Scroll the visualization so the given node is centred on screen. Smooth by
// default; callers that fire faster than an animation can finish (search
// select-as-you-type) pass "auto" so each keystroke lands the map on its target
// instead of restarting a glide toward the previous one.
export function scrollNodeIntoView(nodeId: string, behavior: ScrollBehavior = "smooth"): void {
  const pos = layout.positions[nodeId];
  if (!pos) return;
  const container = document.getElementById("viz-scroll");
  if (!container) return;
  const targetX = pos.x + pos.width / 2 - container.clientWidth / 2;
  const targetY = pos.y + pos.height / 2 - container.clientHeight / 2;
  container.scrollTo({ left: targetX, top: targetY, behavior });
}
