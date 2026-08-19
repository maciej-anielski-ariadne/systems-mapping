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
  CombineMode,
  GraphNode,
  Edge,
  ElasticityDefaults,
  Param,
} from "./types";
import { nodeCategoryIds, splitCategoriesByClass } from "./04-utils";
import { ELASTICITY_KEYS, EFFECT_OPTIONS, COMBINE_OPTIONS } from "./02-config";
import {
  parseCsvDocument,
  parseNumericCell,
  parseBooleanCell,
} from "./05-csv-parser";
import {
  state,
  NODES,
  EDGES,
  PARAMS,
  STREAMS,
  STAGES,
  nodeById,
  paramById,
  edgeById,
  streamNodeCount,
  categoryNodeCount,
  stageNodeCount,
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
  setParams,
  setDefaultElasticityByEffect,
  setNodeById,
  setParamById,
  setEdgeById,
  setOutgoingEdges,
  setIncomingEdges,
  setStreamById,
  setStageById,
  setTopologicalOrder,
  setCycleInfo,
  setStreamNodeCount,
  setCategoryNodeCount,
  setStageNodeCount,
  setMaxHighlightDepth,
  setLayout,
} from "./03-state";
import { computeMaxHighlightDepth } from "./09-graph-selection";
import { applyHighlightDepth, fitMapToFrame } from "./17-events";
import { closeAtlas } from "./21-atlas-view";
import { computeLayout } from "./08-layout";
import {
  recomputeValues,
  rebuildFormulaCache,
  rebuildSolverIndexes,
  getParsedFormula,
  getFormulaParseFailures,
  usesFormula,
} from "./07-simulation-engine";
import { renderSidebar } from "./13-sidebar";
import { render } from "./11-rendering";
import { renderDetailPanel } from "./15-detail-panel";
import { showLoadFeedback, hideDropZone } from "./16-file-io";
import { saveCsvToStorage } from "./04a-storage";
import { isUndoCaptureSuspended, clearHistory } from "./16g-canvas-undo";

// The three ways a box can aggregate the arrows pointing into it. Blank in the
// CSV means "multiplicative", which is exactly what the app did before the
// column existed. Derived from the shared dropdown list (COMBINE_OPTIONS in
// 02-config.js) with its blank "(default)" entry dropped, so the wizard's
// dropdown and this validation can never drift apart. (See CombineMode in
// types.ts and docs/CALCULATION-ENGINE-DESIGN.md §3.2.)
const COMBINE_MODES = COMBINE_OPTIONS.filter(Boolean) as CombineMode[];

// Session-wide counter for minting edge ids in rebuildIndexes(). Monotonic and
// never reset, so an id handed out once is never handed out again — which keeps
// ids stable across rebuilds and collision-free with edges an undo restores.
let _edgeIdSeq = 0;

// Build all the lookup maps from the freshly-loaded NODES/EDGES/STREAMS/STAGES.
// Also produces a topological order: a list of node ids where every node
// comes after all the nodes that feed into it (i.e. every cause is listed
// before its effects). The Cobb-Douglas calculation in 07-simulation-engine.js
// — the formula that turns each box's inputs into its value — needs this order
// to propagate values correctly.
// (Plain-language definitions of "topological order" and "Cobb-Douglas":
//  see docs/GLOSSARY.md.)
// ───── Derived-index revision ───────────────────────────────────────────────
// Bumped by every rebuildIndexes(). Consumers that cache something derived from
// the node/stream/stage data — the search corpus in 17a-search, which folds each
// node's searchable text down to one pre-lowercased list — key their cache on it
// and rebuild only when the underlying data really changed. NODES array identity
// isn't enough on its own: a label edit mutates the node object in place, and
// renaming a stream changes the text a node matches on without touching NODES.
// Every such edit routes through rebuildIndexes, so one counter covers them all.
let _dataRevision = 0;
export function dataRevision(): number {
  return _dataRevision;
}

export function rebuildIndexes(): void {
  _dataRevision++;
  setNodeById({});
  setStreamNodeCount({});
  setCategoryNodeCount({});
  setStageNodeCount({});
  for (const node of NODES) {
    nodeById[node.id] = node;
    // Counts cached here (rather than recomputed per render) so the sidebar
    // and any other code that wants "how many nodes in this stream" is an
    // O(1) lookup. Matters once the map grows past a few hundred nodes.
    streamNodeCount[node.stream]     = (streamNodeCount[node.stream]     || 0) + 1;
    stageNodeCount[node.stage]       = (stageNodeCount[node.stage]       || 0) + 1;
    // Count every category a node carries (a node can now hold several).
    for (const cid of nodeCategoryIds(node)) categoryNodeCount[cid] = (categoryNodeCount[cid] || 0) + 1;
  }

  // Params are hidden constants, not boxes, so they get their own index. Built
  // here (rather than only at load time) so a canvas mutation that rebuilds the
  // indexes leaves paramById in step with PARAMS.
  setParamById({});
  for (const param of PARAMS) paramById[param.id] = param;

  setOutgoingEdges({});
  setIncomingEdges({});
  setEdgeById({});
  for (const node of NODES) {
    outgoingEdges[node.id] = [];
    incomingEdges[node.id] = [];
  }
  for (let edgeIndex = 0; edgeIndex < EDGES.length; edgeIndex++) {
    const edge = EDGES[edgeIndex];
    // Mint an id only for edges that don't have one yet. Ids must survive a
    // rebuild unchanged: selection, highlight sets and the undo flash all hold
    // edge ids across mutations, and renumbering by array index made them all
    // point at different edges after any splice. The counter is monotonic for
    // the whole session so a freshly-minted id can never collide with one an
    // undo snapshot brings back.
    if (!edge.id) edge.id = "edge_" + _edgeIdSeq++;
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

  // A box's parsed formula is a derived index too — text in, calculation tree
  // out — so it is rebuilt here with the rest. Rebuilding it in ONE place means
  // every path that changes the map (a fresh CSV, an undo, a canvas edit) leaves
  // the engine's cache in step with NODES, and the tree is parsed once per load
  // rather than once per solver sweep. See 07-simulation-engine.ts.
  rebuildFormulaCache();

  // ───── Topological sort (Kahn's algorithm) ─────────────────────────────
  // Sort nodes so every node comes after the nodes whose arrows point INTO it.
  // In plain terms: repeatedly take any box that has no remaining un-placed
  // causes, place it next, and "remove" its outgoing arrows so its effects can
  // become ready in turn. (Kahn's algorithm is the standard recipe for this;
  // see "topological sort" in docs/GLOSSARY.md.) "In-degree" below = how many
  // arrows still point into a box.
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

  // Any node Kahn couldn't place lies on a feedback loop (a chain of arrows
  // that leads back to itself — see "cycle" in docs/GLOSSARY.md). Feedback
  // loops are a supported feature (the iterative solver in
  // 07-simulation-engine.js handles them), so we don't drop these nodes — we
  // append them so every node is still swept, and the loop-free prefix keeps
  // giving the solver a good starting order to refine from (the "Gauss-Seidel"
  // / repeat-until-it-settles order; see docs/GLOSSARY.md).
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

  // Everything the solver would otherwise re-derive on every slider tick: each
  // box's incoming links flattened with their resolved elasticities, the set of
  // boxes a second sweep could still move (loop members, delay() readers and
  // their downstreams), and the forward dependency graph behind "what does THIS
  // slider actually change?". Depends on the topological order and cycleInfo
  // above, and on the parsed formulas from rebuildFormulaCache(), so it runs
  // last. See 07-simulation-engine.ts.
  rebuildSolverIndexes();

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
//
// In plain terms: walk the arrows depth-first (follow one chain as far as it
// goes, then back up and try the next — see "DFS" in docs/GLOSSARY.md). Mark
// each box white = not visited yet, gray = on the chain we're currently
// walking, black = finished. If we follow an arrow and land on a gray box, we
// just looped back onto our own path — that arrow is a "back-edge" closing a
// cycle. We do this with an explicit stack (not by calling the function
// recursively) so a few hundred deeply-linked nodes can't overflow the JS call
// stack. Results go into the module-level `cycleInfo` (declared in
// 03-state.js). Relies on edge.id already being assigned earlier in
// rebuildIndexes().
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

// =============================================================================
// CALCULATION-RULE VALIDATION (formulas, and how they square with the arrows)
// -----------------------------------------------------------------------------
// A formula is the one part of a box that can't be checked row-by-row: it names
// other boxes and params, and it has to agree with the arrows drawn into the
// box. So this runs once, after every section is loaded and the indexes (and the
// engine's parsed-formula cache) are built.
//
// Everything here is a WARNING, never fatal — the map still loads and still
// computes. The point is that the user is TOLD, in the same list as every other
// load warning, rather than quietly getting a number that doesn't mean what they
// think. The guiding rule: the arrows on the map must stay an honest picture of
// what feeds what, even when the arithmetic moved into a formula.
// (See docs/CALCULATION-ENGINE-DESIGN.md §5.)
// =============================================================================
function validateCalculationRules(errors: string[]): void {
  // 1. Formulas whose TEXT couldn't be read. The box falls back to its arrows
  //    (i.e. behaves as if it had no formula), so we say so.
  const failedToParse = new Set<string>();
  for (const failure of getFormulaParseFailures()) {
    failedToParse.add(failure.nodeId);
    errors.push(
      "Box `" + failure.nodeId + "` has a formula that can't be read: " + failure.message +
      ". The formula is ignored.",
    );
  }

  for (const node of NODES) {
    if (!node.formula || failedToParse.has(node.id)) continue;

    // 2. A slider always wins: a controllable box is pinned, never recomputed,
    //    so its formula is dead text. Nothing further to check about it.
    if (node.controllable) {
      errors.push(
        "Box `" + node.id + "` is a slider input and also has a formula. " +
        "The slider pins the box, so the formula is ignored.",
      );
      continue;
    }

    // 3. `combine` describes how ARROWS aggregate; a formula replaces them.
    if (node.combine) {
      errors.push(
        "Box `" + node.id + "` has both a combine rule (`" + node.combine + "`) and a formula. " +
        "The formula wins; the combine rule is ignored.",
      );
    }

    const parsed = getParsedFormula(node.id);
    if (!parsed) continue;

    // Which boxes actually point into this one, for the cross-checks below.
    const linkedSources = new Set<string>();
    for (const edge of incomingEdges[node.id] || []) linkedSources.add(edge.from);

    // 4. Every name the formula mentions — read directly or through delay() —
    //    must be a real box or a real param.
    const referenced = new Set<string>();
    for (const id of parsed.references.concat(parsed.delayReferences)) {
      if (referenced.has(id)) continue;
      referenced.add(id);

      if (paramById[id]) continue;              // a hidden constant — nothing to draw
      if (!nodeById[id]) {
        errors.push(
          "Box `" + node.id + "` has a formula that mentions `" + id +
          "`, which is not a box or a parameter. It will be read as 0.",
        );
        continue;
      }

      // 5. Referencing a BOX means there is a causal link, so the map has to
      //    show one. This is the rule that keeps the picture honest.
      if (!linkedSources.has(id)) {
        errors.push(
          "Box `" + node.id + "` has a formula that uses `" + id +
          "`, but no arrow joins them — the map's arrows must show every causal input — " +
          "add a link from `" + id + "` to `" + node.id + "` or remove it from the formula.",
        );
      }

      // 6. A box with no starting value has no number to give.
      if (nodeById[id].baseline === undefined || nodeById[id].baseline === null) {
        errors.push(
          "Box `" + node.id + "` has a formula that uses `" + id +
          "`, which has no starting value — it will be read as missing (0).",
        );
      }
    }

    // 7. The reverse check: an arrow the formula never reads still draws on the
    //    map but changes nothing. Worth saying out loud.
    for (const sourceId of linkedSources) {
      if (referenced.has(sourceId)) continue;
      errors.push(
        "Box `" + node.id + "` has an arrow from `" + sourceId +
        "` that its formula never uses — that link is descriptive only and does not " +
        "change the number.",
      );
    }
  }

  reportFormulaCyclesWithoutDelay(errors);
}

// The SAME-SWEEP dependencies of one box: what its value needs to already know
// this pass. For a formula box that's the boxes it reads directly — a delay()
// read deliberately does NOT count, because it takes the previous sweep's number
// and so can't depend on this sweep. Every other box depends on the boxes its
// incoming arrows come from, exactly as it always has.
function sameSweepDependencies(node: GraphNode): string[] {
  const parsed = getParsedFormula(node.id);
  if (parsed && usesFormula(node)) {
    return parsed.references.filter((id) => nodeById[id] !== undefined);
  }
  return (incomingEdges[node.id] || []).map((edge) => edge.from);
}

// A loop in that same-sweep graph passing through a formula box is a box whose
// value depends on itself WITHIN one sweep — there is no order that computes it
// correctly, so the answer would depend on which box happens to be declared
// first. `delay()` breaks the knot (the standard "unit delay": read the previous
// sweep's number). We warn rather than refuse: the solver still iterates and may
// well settle, but the user should know the model isn't well-defined.
//
// Loops made only of classic arrow-based boxes are NOT reported — those have
// always been solved by iterating and are reported through the feedback-loop
// status instead.
//
// The walk is the same depth-first colouring as detectCycles() above (white =
// unvisited, gray = on the path we're walking, black = done), with an explicit
// stack so a deep map can't overflow the JS call stack.
function reportFormulaCyclesWithoutDelay(errors: string[]): void {
  // Only a loop passing through a formula box is ever reported, so a map with
  // no formulas at all can skip the whole-graph DFS (and its per-node
  // dependency arrays) — on large formula-free maps this was a third full
  // traversal per load for a guaranteed-empty result.
  if (!NODES.some((node) => usesFormula(node))) return;
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color: Record<string, number> = {};
  const dependencies: Record<string, string[]> = {};
  for (const node of NODES) {
    color[node.id] = WHITE;
    dependencies[node.id] = sameSweepDependencies(node);
  }

  const reported = new Set<string>();

  for (const startNode of NODES) {
    if (color[startNode.id] !== WHITE) continue;

    const stack: { id: string; depIndex: number }[] = [{ id: startNode.id, depIndex: 0 }];
    color[startNode.id] = GRAY;

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const deps = dependencies[frame.id] || [];

      if (frame.depIndex < deps.length) {
        const dep = deps[frame.depIndex++];
        if (color[dep] === GRAY) {
          // We've walked back onto our own path: everything on the stack from
          // `dep` upward is one loop. The stack reads "needs" — stack[i] needs
          // stack[i+1] — so reversing it gives the causal direction people read.
          const needsChain: string[] = [];
          for (let i = stack.length - 1; i >= 0; i--) {
            needsChain.unshift(stack[i].id);
            if (stack[i].id === dep) break;
          }
          const throughFormula = needsChain.some((id) => usesFormula(nodeById[id]));
          const key = needsChain.slice().sort().join(">");
          if (throughFormula && !reported.has(key)) {
            reported.add(key);
            const causalChain = needsChain.slice().reverse();
            const drawn = causalChain.concat([causalChain[0]]).map((id) => "`" + id + "`").join(" → ");
            errors.push(
              "Boxes " + drawn + " form a calculation loop through a formula with no delay(), " +
              "so each one needs the others' value before it exists. Wrap one of the inputs " +
              "in delay(...) to make the loop well-defined.",
            );
          }
        } else if (color[dep] === WHITE) {
          color[dep] = GRAY;
          stack.push({ id: dep, depIndex: 0 });
        }
        // BLACK dependencies are fully explored — nothing to do.
      } else {
        color[frame.id] = BLACK;
        stack.pop();
      }
    }
  }
}

// Main entry point. Returns true on success, false on fatal validation errors.
export function loadDataFromCsv(csvText: string): boolean {
  // A full load replaces every edge object, so restart the id counter — ids
  // are then deterministic per load (edge_0… in file order), which tests and
  // the export model rely on. In-session mutations never reset it, so live
  // edge ids stay stable across rebuilds.
  _edgeIdSeq = 0;
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

    // ── Optional per-box calculation rules (all blank in an older CSV) ──────
    // `combine` picks how the arrows pointing INTO this box are aggregated.
    // Blank keeps today's behaviour (multiplicative); anything outside the
    // enum is a typo we name and ignore rather than silently mis-calculating.
    const combineValue = (row.combine || "").trim().toLowerCase();
    if (combineValue !== "") {
      if (COMBINE_MODES.includes(combineValue as CombineMode)) {
        node.combine = combineValue as CombineMode;
      } else {
        errors.push("Box `" + row.id + "` has an unknown combine rule `" + row.combine + "` (expected " + COMBINE_MODES.join(" / ") + "). Ignored.");
      }
    }

    // `formula` is kept as raw text here — the expression is only meaningful
    // once the whole map is known (it can name any box or param, and has to
    // agree with the arrows drawn into this box), so both parsing and checking
    // happen after every section is in: see validateCalculationRules() below.
    const formulaValue = (row.formula || "").trim();
    if (formulaValue !== "") node.formula = formulaValue;

    // Hard bounds, in the box's own units (not ratios). Applied after whichever
    // rule produced the value. An inverted pair is a data error, not a silently
    // impossible box, so we name it and drop both bounds.
    const minValue = parseNumericCell(row.min);
    const maxValue = parseNumericCell(row.max);
    if (minValue !== undefined && maxValue !== undefined && minValue > maxValue) {
      errors.push("Box `" + row.id + "` has min " + minValue + " greater than max " + maxValue + ". Both limits ignored.");
    } else {
      if (minValue !== undefined) node.minValue = minValue;
      if (maxValue !== undefined) node.maxValue = maxValue;
    }

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

  // ───── Params (optional hidden constants) ───────────────────────────────
  // Named scalars that belong to the calculation model but never render as
  // boxes — route shares, detection rates, unit conversions. Parsed AFTER the
  // nodes so we can reject an id that clashes with a box: formulas name boxes
  // and params in the same breath, so one id can only ever mean one thing.
  // A CSV with no `params` section simply leaves the list empty.
  const parsedParams: Param[] = [];
  const seenParamIds = new Set<string>();

  if (sections.params) {
    for (const row of sections.params) {
      if (!row.id) continue;
      if (seenParamIds.has(row.id)) {
        errors.push("Duplicate parameter id: " + row.id);
        continue;
      }
      seenParamIds.add(row.id);
      if (nodeIdSet.has(row.id)) {
        errors.push("Parameter `" + row.id + "` has the same id as a box. Skipped.");
        continue;
      }
      const paramValue = parseNumericCell(row.value);
      if (paramValue === undefined) {
        errors.push("Parameter `" + row.id + "` has a value that is not a number: `" + (row.value || "") + "`. Skipped.");
        continue;
      }
      parsedParams.push({
        id: row.id,
        value: paramValue,
        description: row.description || "",
      });
    }
  }

  // ───── Commit to global state ───────────────────────────────────────────
  setStreams(parsedStreams);
  setStages(parsedStages);
  setCategories(parsedCategories);
  setNodes(parsedNodes);
  setEdges(parsedEdges);
  setParams(parsedParams);
  setDefaultElasticityByEffect(parsedDefaults);

  // Reset transient interaction state. Must happen BEFORE computeLayout()
  // because layout now reads state.hiddenStreams to collapse hidden rows.
  // selectedNodeIds / selectedEdgeId must be cleared with selectedNodeId —
  // 03-state documents the invariant that they move together, and a stale
  // multi-select Set surviving a load points at nodes that no longer exist.
  state.selectedNodeId = null;
  state.selectedNodeIds = new Set();
  state.selectedEdgeId = null;
  state.hoveredNodeId = null;
  state.hiddenStreams = new Set();
  state.hiddenCategories = new Set();
  state.hiddenStages = new Set();
  state.ancestorSet = new Set();
  state.descendantSet = new Set();
  state.highlightedEdgeIds = new Set();
  state.userOverrides = {};
  state.dataLoaded = true;
  // Same array object that validateCalculationRules() pushes into below, so the
  // formula warnings it adds after the indexes are built land here too.
  state.loadErrors = errors;

  // An atlas is everything downstream of one box in THIS map; a different map
  // makes it a picture of something that is no longer there.
  if (typeof closeAtlas === "function") closeAtlas();

  rebuildIndexes();
  // Formula checks need the whole map (indexes, params, and the parsed formulas
  // rebuildIndexes() just cached), so they run here rather than row-by-row.
  validateCalculationRules(errors);
  setLayout(computeLayout());

  recomputeValues();
  hideDropZone();
  renderSidebar();
  render();
  renderDetailPanel();

  // A map that doesn't fit the frame opens zoomed out far enough to see, down
  // to a floor (FIT_MIN_ZOOM) past which "all of it at once" would be
  // unreadable — beyond that it opens cropped at a size you can actually read.
  // A map that already fits is left at its own size. Undo / redo route through
  // this same function, and a zoom that jumped under an undo would be its own
  // small betrayal — so the fit is skipped while restoring, as is the history
  // clear below.
  if (typeof isUndoCaptureSuspended === "function" && !isUndoCaptureSuspended()) {
    if (typeof fitMapToFrame === "function") fitMapToFrame({ floor: true });
  }

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
