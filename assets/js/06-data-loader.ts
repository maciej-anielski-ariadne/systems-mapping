// =============================================================================
// DATA LOADER — take a CSV string, validate it, populate global state
// -----------------------------------------------------------------------------
// This is the bridge between the parser (05-csv-parser.js) and everything
// else. `loadDataFromCsv` is the one function called whenever new CSV content
// arrives (from a drag-drop, file picker, or the in-page "Load Sample" button).
//
// What it does:
//   1. Parses the CSV into sections.
//   2. Validates every reference (e.g. "does this node's stream actually exist?").
//   3. Copies the parsed values into the global arrays declared in 03-state.js.
//   4. Calls `rebuildIndexes()` to refresh the lookup maps (nodeById etc.).
//   5. Recomputes layout and node values.
//   6. Triggers a full re-render of every panel.
// =============================================================================

import type {
  Stream,
  Stage,
  CategoryMap,
  GraphNode,
  Edge,
  ElasticityDefaults,
} from "./types";
import { nodeCategoryIds, splitCategoriesByClass } from "./04-utils";
import { ELASTICITY_KEYS, EFFECT_OPTIONS } from "./02-config";
import {
  parseCsvDocument,
  parseNumericCell,
  parseBooleanCell,
} from "./05-csv-parser";
import {
  state,
  NODES,
  EDGES,
  STREAMS,
  STAGES,
  nodeById,
  edgeById,
  streamNodeCount,
  categoryNodeCount,
  outgoingEdges,
  incomingEdges,
  streamById,
  stageById,
  cycleInfo,
  setStreams,
  setStages,
  setCategories,
  setNodes,
  setEdges,
  setDefaultElasticityByEffect,
  setNodeById,
  setEdgeById,
  setOutgoingEdges,
  setIncomingEdges,
  setStreamById,
  setStageById,
  setTopologicalOrder,
  setCycleInfo,
  setStreamNodeCount,
  setCategoryNodeCount,
  setMaxHighlightDepth,
  setLayout,
} from "./03-state";
import { computeMaxHighlightDepth } from "./09-graph-selection";
import { applyHighlightDepth } from "./17-events";
import { computeLayout } from "./08-layout";
import { recomputeValues } from "./07-simulation-engine";
import { renderSidebar } from "./13-sidebar";
import { render } from "./11-rendering";
import { renderDetailPanel } from "./15-detail-panel";
import { showLoadFeedback, hideDropZone } from "./16-file-io";
import { saveCsvToStorage } from "./04a-storage";
import { isUndoCaptureSuspended, clearHistory } from "./16g-canvas-undo";

// Build all the lookup maps from the freshly-loaded NODES/EDGES/STREAMS/STAGES.
// Also produces a topological order: a list of node ids where every node
// comes after all the nodes that feed into it. The Cobb-Douglas calculation
// in 07-simulation-engine.js needs this order to propagate values correctly.
export function rebuildIndexes(): void {
  setNodeById({});
  setStreamNodeCount({});
  setCategoryNodeCount({});
  for (const node of NODES) {
    nodeById[node.id] = node;
    // Counts cached here (rather than recomputed per render) so the sidebar
    // and any other code that wants "how many nodes in this stream" is an
    // O(1) lookup. Matters once the map grows past a few hundred nodes.
    streamNodeCount[node.stream]     = (streamNodeCount[node.stream]     || 0) + 1;
    // Count every category a node carries (a node can now hold several).
    for (const cid of nodeCategoryIds(node)) categoryNodeCount[cid] = (categoryNodeCount[cid] || 0) + 1;
  }

  setOutgoingEdges({});
  setIncomingEdges({});
  setEdgeById({});
  for (const node of NODES) {
    outgoingEdges[node.id] = [];
    incomingEdges[node.id] = [];
  }
  for (let edgeIndex = 0; edgeIndex < EDGES.length; edgeIndex++) {
    const edge = EDGES[edgeIndex];
    edge.id = "edge_" + edgeIndex;       // give every edge a stable id
    edgeById[edge.id] = edge;            // O(1) lookup by id (select / cycle / delete)
    if (outgoingEdges[edge.from]) outgoingEdges[edge.from].push(edge);
    if (incomingEdges[edge.to])   incomingEdges[edge.to].push(edge);
  }

  setStreamById({});
  for (const stream of STREAMS) streamById[stream.id] = stream;

  setStageById({});
  for (let stageIdx = 0; stageIdx < STAGES.length; stageIdx++) {
    stageById[STAGES[stageIdx].id] = { ...STAGES[stageIdx], index: stageIdx };
  }

  // ───── Topological sort (Kahn's algorithm) ─────────────────────────────
  // Sort nodes so every node comes after the nodes whose arrows point INTO it.
  const remainingInDegree: Record<string, number> = {};
  for (const node of NODES) remainingInDegree[node.id] = 0;
  for (const edge of EDGES) {
    if (remainingInDegree[edge.to] !== undefined) remainingInDegree[edge.to]++;
  }

  const ready: string[] = [];
  for (const node of NODES) {
    if (remainingInDegree[node.id] === 0) ready.push(node.id);
  }

  const sorted: string[] = [];
  // Drive the queue with a head index rather than Array.shift() — shift() is
  // O(N) per call (it re-indexes the whole array), making the sort O(N^2) on
  // large maps. `ready` only ever grows; we advance `head` through it.
  let head = 0;
  while (head < ready.length) {
    const id = ready[head++];
    sorted.push(id);
    for (const edge of outgoingEdges[id]) {
      remainingInDegree[edge.to]--;
      if (remainingInDegree[edge.to] === 0) ready.push(edge.to);
    }
  }

  // Any node Kahn couldn't place lies on a feedback loop. Feedback loops are a
  // supported feature (the iterative solver in 07-simulation-engine.js handles
  // them), so we don't drop these nodes — we append them so every node is still
  // swept, and the acyclic prefix keeps providing a good Gauss-Seidel order.
  const hasCycle = sorted.length !== NODES.length;
  if (hasCycle) {
    const sortedSet = new Set(sorted);
    for (const node of NODES) {
      if (!sortedSet.has(node.id)) sorted.push(node.id);
    }
  }
  setTopologicalOrder(sorted);

  // Identify which edges/nodes close a loop (for distinct rendering + status).
  // Only cyclic maps have back-edges, so we skip the DFS entirely for an
  // acyclic map — Kahn placing every node already proves there are none — and
  // just clear any cycleInfo left over from a previous load.
  if (hasCycle) {
    detectCycles();
  } else {
    setCycleInfo({ inCycleNodeIds: new Set(), backEdgeIds: new Set(), loopCount: 0 });
  }

  // Cache the deepest reachable highlight hop so the depth control can cap
  // itself to the current map (no fixed ceiling). Defined in 09-graph-selection;
  // guarded since rebuildIndexes can run before that file loads.
  if (typeof computeMaxHighlightDepth === "function") {
    setMaxHighlightDepth(computeMaxHighlightDepth());
  }
  // Keep the on-screen depth readout / button states in sync with the new map.
  if (typeof applyHighlightDepth === "function") applyHighlightDepth();
}

// Find the edges that close feedback loops and the nodes that lie on them.
// Runs an iterative depth-first search over outgoingEdges with the classic
// white/gray/black colouring: an edge into a node currently on the DFS stack
// (gray) is a "back-edge" that closes a cycle. Iterative (not recursive) so a
// few hundred deeply-linked nodes can't overflow the JS call stack. Results go
// into the module-level `cycleInfo` (declared in 03-state.js). Relies on
// edge.id already being assigned earlier in rebuildIndexes().
export function detectCycles(): void {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color: Record<string, number> = {};
  for (const node of NODES) color[node.id] = WHITE;

  const backEdgeIds = new Set<string>();
  const inCycleNodeIds = new Set<string>();

  for (const startNode of NODES) {
    if (color[startNode.id] !== WHITE) continue;

    // Each frame tracks a node and how far through its outgoing edges we are.
    const stack: { id: string; edgeIndex: number }[] = [{ id: startNode.id, edgeIndex: 0 }];
    color[startNode.id] = GRAY;

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const edges = outgoingEdges[frame.id] || [];

      if (frame.edgeIndex < edges.length) {
        const edge = edges[frame.edgeIndex++];
        const toColor = color[edge.to];
        if (toColor === GRAY) {
          // edge.to is an ancestor on the current path → this edge closes a loop.
          backEdgeIds.add(edge.id!);
          // Every node currently on the stack from edge.to upward is in the loop.
          for (let i = stack.length - 1; i >= 0; i--) {
            inCycleNodeIds.add(stack[i].id);
            if (stack[i].id === edge.to) break;
          }
        } else if (toColor === WHITE) {
          color[edge.to] = GRAY;
          stack.push({ id: edge.to, edgeIndex: 0 });
        }
        // BLACK targets are fully explored — nothing to do.
      } else {
        color[frame.id] = BLACK;
        stack.pop();
      }
    }
  }

  setCycleInfo({
    inCycleNodeIds: inCycleNodeIds,
    backEdgeIds: backEdgeIds,
    loopCount: backEdgeIds.size,
  });
  if (backEdgeIds.size > 0) {
    console.info(cycleInfo.loopCount + " feedback loop(s) detected — solved iteratively.");
  }
}

// Main entry point. Returns true on success, false on fatal validation errors.
export function loadDataFromCsv(csvText: string): boolean {
  const sections = parseCsvDocument(csvText);
  const errors: string[] = [];

  // ───── Fatal-error checks (we can't proceed without these) ─────────────
  if (!sections.streams    || sections.streams.length === 0)    errors.push("Missing or empty `streams` section.");
  if (!sections.stages     || sections.stages.length === 0)     errors.push("Missing or empty `stages` section.");
  if (!sections.categories || sections.categories.length === 0) errors.push("Missing or empty `categories` section.");
  if (!sections.nodes      || sections.nodes.length === 0)      errors.push("Missing or empty `nodes` section.");

  if (errors.length > 0) {
    state.loadErrors = errors;
    showLoadFeedback("Load failed: " + errors.join(" "), true);
    return false;
  }

  // ───── Streams ──────────────────────────────────────────────────────────
  const parsedStreams: Stream[] = sections.streams!.map((row): Stream => ({
    id: row.id,
    label: row.label || row.id,
    short: row.short || (row.id || "").toUpperCase(),
    color: row.color || "#94a3b8",
  })).filter(stream => stream.id);

  // ───── Stages ───────────────────────────────────────────────────────────
  const parsedStages: Stage[] = sections.stages!.map((row): Stage => ({
    id: row.id,
    label: row.label || row.id,
  })).filter(stage => stage.id);

  // ───── Categories ───────────────────────────────────────────────────────
  const parsedCategories: CategoryMap = {};
  for (const row of sections.categories!) {
    if (!row.id) continue;
    parsedCategories[row.id] = {
      label: row.label || row.id,
      color: row.color || "#a3a3a3",
      textColor: row.text_color || "#1c1917",
      // "primary" = fill (default; several primaries blend into a gradient);
      // "secondary" = a small chip in the node's bottom-right corner.
      class: (row.class || "").trim().toLowerCase() === "secondary" ? "secondary" : "primary",
    };
  }

  // ───── Defaults (elasticities) ──────────────────────────────────────────
  const parsedDefaults: ElasticityDefaults = { enables: 0.30, increases: 0.25, decreases: -0.25 };
  if (sections.defaults) {
    for (const row of sections.defaults) {
      if (!row.key) continue;
      const numericValue = parseNumericCell(row.value);
      if (numericValue === undefined) continue;
      if (row.key === ELASTICITY_KEYS.enables)   parsedDefaults.enables   = numericValue;
      if (row.key === ELASTICITY_KEYS.increases) parsedDefaults.increases = numericValue;
      if (row.key === ELASTICITY_KEYS.decreases) parsedDefaults.decreases = numericValue;
    }
  }

  // ───── Nodes (with foreign-key validation) ──────────────────────────────
  const streamIdSet   = new Set(parsedStreams.map(s => s.id));
  const stageIdSet    = new Set(parsedStages.map(s => s.id));
  const categoryIdSet = new Set(Object.keys(parsedCategories));
  const seenNodeIds   = new Set<string>();
  const parsedNodes: GraphNode[] = [];

  for (const row of sections.nodes!) {
    if (!row.id) continue;
    if (seenNodeIds.has(row.id)) {
      errors.push("Duplicate box id: " + row.id);
      continue;
    }
    seenNodeIds.add(row.id);

    // Drop nodes that reference unknown stream/stage/category — keeping
    // them would crash the renderer when it dereferences streamById[…]
    // or CATEGORIES[…]. We still log a warning so the user can fix the CSV.
    let hasInvalidRefs = false;
    if (!streamIdSet.has(row.stream))     { errors.push("Box `" + row.id + "` refers to a row that does not exist: `"   + row.stream   + "`. Skipped."); hasInvalidRefs = true; }
    if (!stageIdSet.has(row.stage))       { errors.push("Box `" + row.id + "` refers to a column that does not exist: `"    + row.stage    + "`. Skipped."); hasInvalidRefs = true; }

    // `category` is a pipe-separated list of category ids. Each id's class
    // (primary/secondary) decides how it renders. Unknown ids are dropped with
    // a warning; a node with no valid category at all is skipped.
    const rawCatIds = String(row.category == null ? "" : row.category).split("|").map(s => s.trim()).filter(Boolean);
    const seenCat = new Set<string>();
    const validCatIds = rawCatIds.filter(id => categoryIdSet.has(id) && !seenCat.has(id) && seenCat.add(id));
    for (const u of new Set(rawCatIds.filter(id => !categoryIdSet.has(id)))) errors.push("Box `" + row.id + "` refers to a category that does not exist: `" + u + "` (ignored).");
    if (validCatIds.length === 0) { errors.push("Box `" + row.id + "` has no valid category. Skipped."); hasInvalidRefs = true; }
    if (hasInvalidRefs) continue;

    const catSplit = splitCategoriesByClass(validCatIds, parsedCategories);
    const primaryCategories = catSplit.primary, secondaryCategories = catSplit.secondary;

    const node: GraphNode = {
      id: row.id,
      label: row.label || row.id,
      description: row.description || "",
      stream: row.stream,
      stage: row.stage,
      // `category` stays a single id (the primary anchor) for the many features
      // that key off one category (filters, search, detail edit, mutations);
      // the full multi-select lives in the arrays below.
      category: primaryCategories[0] || validCatIds[0],
      // Stored primaries-then-secondaries to match the editors, so a
      // serialize → reload round-trip is order-stable.
      categoryIds: primaryCategories.concat(secondaryCategories),
      primaryCategories: primaryCategories,
      secondaryCategories: secondaryCategories,
    };

    // Optional quantification fields.
    // baseline must be > 0 — simulation divides by baseline when propagating
    // value ratios, so 0 produces Infinity (or NaN) downstream. Reject 0
    // explicitly with a warning rather than silently breaking simulation.
    const baselineValue = parseNumericCell(row.baseline);
    if (baselineValue !== undefined) {
      if (baselineValue === 0) {
        errors.push("Box `" + row.id + "` has starting value 0 — must be positive (the what-if maths divides by the starting value). Starting value ignored.");
      } else {
        node.baseline = baselineValue;
      }
    }
    if (row.unit && row.unit !== "")  node.unit = row.unit;
    if (parseBooleanCell(row.controllable)) node.controllable = true;
    if (row.direction && row.direction !== "") node.direction = row.direction as GraphNode["direction"];
    const sliderMaxValue = parseNumericCell(row.slider_max);
    if (sliderMaxValue !== undefined) node.sliderMax = sliderMaxValue;

    parsedNodes.push(node);
  }

  // ───── Edges (with foreign-key + effect validation) ─────────────────────
  const nodeIdSet = new Set(parsedNodes.map(n => n.id));
  const parsedEdges: Edge[] = [];

  if (sections.edges) {
    for (const row of sections.edges) {
      if (!row.from || !row.to) continue;
      if (!nodeIdSet.has(row.from)) { errors.push("Link from a box that does not exist: " + row.from); continue; }
      if (!nodeIdSet.has(row.to))   { errors.push("Link to a box that does not exist: "   + row.to);   continue; }

      const effect = (row.effect || "enables").toLowerCase();
      if (!EFFECT_OPTIONS.includes(effect)) {
        errors.push("Link " + row.from + "→" + row.to + " has invalid effect `" + row.effect + "`.");
        continue;
      }

      const edge: Edge = {
        from: row.from,
        to: row.to,
        effect: effect as Edge["effect"],
        description: row.description || "",
      };
      const elasticityValue = parseNumericCell(row.elasticity);
      if (elasticityValue !== undefined) edge.elasticity = elasticityValue;
      // Line style: "dashed" or (default) solid. Only stored when dashed, so an
      // old CSV with no `style` column loads as solid.
      if ((row.style || "").trim().toLowerCase() === "dashed") edge.style = "dashed";

      parsedEdges.push(edge);
    }
  }

  // ───── Commit to global state ───────────────────────────────────────────
  setStreams(parsedStreams);
  setStages(parsedStages);
  setCategories(parsedCategories);
  setNodes(parsedNodes);
  setEdges(parsedEdges);
  setDefaultElasticityByEffect(parsedDefaults);

  // Reset transient interaction state. Must happen BEFORE computeLayout()
  // because layout now reads state.hiddenStreams to collapse hidden rows.
  state.selectedNodeId = null;
  state.hoveredNodeId = null;
  state.hiddenStreams = new Set();
  state.hiddenCategories = new Set();
  state.hiddenStages = new Set();
  state.ancestorSet = new Set();
  state.descendantSet = new Set();
  state.highlightedEdgeIds = new Set();
  state.userOverrides = {};
  state.dataLoaded = true;
  state.loadErrors = errors;

  rebuildIndexes();
  setLayout(computeLayout());

  recomputeValues();
  hideDropZone();
  renderSidebar();
  render();
  renderDetailPanel();

  // Only surface a toast when something went wrong. Successful loads are
  // visually obvious (the map renders); the count is also visible in the
  // sidebar filter counts, so we don't need an extra notification.
  if (errors.length > 0) {
    const summary = NODES.length + " boxes, " + EDGES.length + " links, " + STREAMS.length + " rows";
    const loopNote = state.solverStatus.feedbackLoopCount > 0
      ? " " + state.solverStatus.feedbackLoopCount + " feedback loop(s)."
      : "";
    showLoadFeedback("Loaded with " + errors.length + " warning(s). " + summary + "." + loopNote + " See console for details.", false);
    console.warn("Load warnings:", errors);
  }

  // A feedback loop that fails to settle means runaway positive feedback
  // (loop gain ≥ 1). The values are clamped to something finite, but warn the
  // user that the loop needs taming rather than letting them trust the numbers.
  if (!state.solverStatus.converged) {
    showLoadFeedback(
      "Feedback loop didn't stabilise (gain ≥ 1) — values clamped. Reduce the strength values on the highlighted loop.",
      true,
    );
  }

  // Persist the CSV so the map survives a page refresh. Helper is a no-op
  // when localStorage is unavailable.
  saveCsvToStorage(csvText);
  // Seed the undo "previous snapshot" with the CSV we just loaded — without
  // this, the very first mutation after a load has nothing to push onto
  // history.past. Also clear history unless we're mid-restore (undo/redo
  // call loadDataFromCsv internally and don't want to wipe the stacks).
  state.lastCsvSnapshot = csvText;
  if (typeof isUndoCaptureSuspended === "function" && !isUndoCaptureSuspended()) {
    if (typeof clearHistory === "function") clearHistory();
  }
  return true;
}
