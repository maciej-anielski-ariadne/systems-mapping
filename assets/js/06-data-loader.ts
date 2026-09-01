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
  Finding,
} from "./types";
import { nodeCategoryIds, splitCategoriesByClass, formatScalar } from "./04-utils";
import { ELASTICITY_KEYS, EFFECT_OPTIONS, COMBINE_OPTIONS } from "./02-config";
import {
  parseCsvDocument,
  parseNumericCell,
  parseBooleanCell,
} from "./05-csv-parser";
import {
  canonicalIdentifierGuidance,
  createIdentifierRecord,
  isBlankInput,
  isCanonicalIdentifier,
  isSafeHexColour,
} from "./05b-input-validation";
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
  getParsedFormulaCandidate,
  getFormulaParseFailures,
  usesFormula,
  explainNode,
  DELTA_DISPLAY_THRESHOLD_PCT,
} from "./07-simulation-engine";
import { renderSidebar } from "./13-sidebar";
import { render } from "./11-rendering";
import { renderDetailPanel } from "./15-detail-panel";
import { showLoadFeedback, hideDropZone } from "./16-file-io";
import { saveCsvToStorage, saveUiStateToStorage } from "./04a-storage";
import { isUndoCaptureSuspended, clearHistory } from "./16g-canvas-undo";
// Findings are built here and read by the Review panel. `finding()` keeps the
// twenty-eight call sites below to one line each; attributeFindings() is what
// separates a mistake from its downstream shadows (see 22-review.ts).
import { finding, attributeFindings, groupFindings, REST_DRIFT, invalidateSweep } from "./22-review";
import { refreshReview } from "./23-review-panel";
import { refreshLiveReviewFindings } from "./22a-review-model";
import { endReviewPass, reconcileReviews } from "./24-review-record";

// The three ways a box can aggregate the arrows pointing into it. Blank in the
// CSV means "multiplicative", which is exactly what the app did before the
// column existed. Derived from the shared dropdown list (COMBINE_OPTIONS in
// 02-config.js) with its blank "(default)" entry dropped, so the wizard's
// dropdown and this validation can never drift apart. (See CombineMode in
// types.ts and docs/CALCULATION-ENGINE-DESIGN.md §3.2.)
const COMBINE_MODES = COMBINE_OPTIONS.filter(Boolean) as CombineMode[];

// Counter for minting edge ids in rebuildIndexes(). A successful full load
// restarts it so file-order ids remain deterministic; between successful loads
// it is monotonic, and rejected loads never touch it or the retained graph.
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

// Searchable text can change without changing topology or layout (currently a
// box description or unit edited in the detail panel). Give the search corpus
// the same revision clock without paying for a full index/layout rebuild.
export function markSearchableDataChanged(): void {
  _dataRevision++;
}

export function rebuildIndexes(): void {
  _dataRevision++;
  setNodeById(createIdentifierRecord());
  setStreamNodeCount(createIdentifierRecord());
  setCategoryNodeCount(createIdentifierRecord());
  setStageNodeCount(createIdentifierRecord());
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
  setParamById(createIdentifierRecord());
  for (const param of PARAMS) paramById[param.id] = param;

  setOutgoingEdges(createIdentifierRecord());
  setIncomingEdges(createIdentifierRecord());
  setEdgeById(createIdentifierRecord());
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

  setStreamById(createIdentifierRecord());
  for (const stream of STREAMS) streamById[stream.id] = stream;

  setStageById(createIdentifierRecord());
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
  const remainingInDegree = createIdentifierRecord<number>();
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

  // Boxes come and go through five different delete paths and an undo; this is
  // the one funnel all of them pass through, so it is where a review learns that
  // the box it is about has gone (or has come back). Wiring it to the delete
  // sites instead would mean a reconciler that runs on four of the five.
  reconcileReviews();
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
  const color = createIdentifierRecord<number>();
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
function validateCalculationRules(errors: Finding[]): void {
  // 1. Formulas whose TEXT couldn't be read. The box falls back to its arrows
  //    (i.e. behaves as if it had no formula), so we say so.
  const failedToParse = new Set<string>();
  for (const failure of getFormulaParseFailures()) {
    failedToParse.add(failure.nodeId);
    errors.push(finding("formula-unreadable", "ignored",
      "Its formula can't be read: " + failure.message + ". The formula is ignored, so the box " +
      "falls back to its links.",
      { boxId: failure.nodeId, fix: "Fix the expression, or clear the formula cell." }));
  }

  for (const node of NODES) {
    if (!node.formula || failedToParse.has(node.id)) continue;

    // 2. A slider always wins: a controllable box is pinned, never recomputed,
    //    so its formula is dead text. Nothing further to check about it.
    if (node.controllable) {
      errors.push(finding("slider-beats-formula", "ignored",
        "It is ticked adjustable and also has a formula. The slider pins the box, so the " +
        "formula is dead text.",
        { boxId: node.id, fix: "Untick adjustable, or delete the formula." }));
      continue;
    }

    // 3. `combine` describes how ARROWS aggregate; a formula replaces them.
    if (node.combine && usesFormula(node)) {
      errors.push(finding("combine-beats-formula", "ignored",
        "It has both a combine rule (`" + node.combine + "`) and a formula. The combine rule " +
        "describes how links add up; the formula replaces them, so the combine rule is ignored.",
        { boxId: node.id, fix: "Clear the combine cell." }));
    }

    const parsed = getParsedFormulaCandidate(node.id);
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
        errors.push(finding("name-unknown", "wrong",
          "Its formula mentions `" + id + "`, which is neither a box nor a constant. " +
          "It will be read as 0.",
          { boxId: node.id, fix: "Check the spelling, or add the constant." }));
        continue;
      }

      // 5. Referencing a BOX means there is a causal link, so the map has to
      //    show one. This is the rule that keeps the picture honest.
      if (!linkedSources.has(id)) {
        errors.push(finding("name-has-no-link", "mismatch",
          "Its formula uses `" + id + "`, but no link joins the two — the map's links must " +
          "show every causal input. The formula is ignored until the link is drawn, so the " +
          "box falls back to its incoming links.",
          { boxId: node.id, fix: "Draw the link from `" + id + "`, or drop the term." }));
      }

      // 6. A box with no starting value has no number to give.
      if (nodeById[id].baseline === undefined || nodeById[id].baseline === null) {
        errors.push(finding("name-has-no-value", "wrong",
          "Its formula uses `" + id + "`, which has no starting value — it will be read as 0.",
          { boxId: node.id, fix: "Give `" + id + "` a starting value, or drop the term." }));
      }
    }

    // 7. The reverse check: an arrow the formula never reads still draws on the
    //    map but changes nothing. Worth saying out loud.
    for (const sourceId of linkedSources) {
      if (!usesFormula(node)) break;
      if (referenced.has(sourceId)) continue;
      errors.push(finding("link-unused", "mismatch",
        "A link from `" + sourceId + "` points at it that its formula never reads — that link " +
        "draws on the map but changes nothing.",
        { boxId: node.id, fix: "Deliberate? Leave it. Otherwise read it, or remove it." }));
    }
  }

  reportFormulaCyclesWithoutDelay(errors);
}

// ═════════════════════════════════════════════════════════════════════════════
// DOES THE MAP AGREE WITH ITSELF AT REST?
// -----------------------------------------------------------------------------
// With every slider at 100% nothing has been asked of the map yet, so every box
// should be sitting on exactly the starting value it declares. When one isn't,
// the map opens already showing a change against a number nobody moved — and
// since the % change on every box is measured against that same starting value,
// every figure downstream is being read against the wrong anchor.
//
// The arrows can never cause this: at rest every source sits on its own starting
// value, so every ratio is 1 and all three combine rules return the starting
// value untouched. What can:
//
//   • A FORMULA that disagrees with the starting value typed beside it. A
//     formula box ignores its arrows and computes in absolute terms, so its
//     starting value is only a seed and a denominator — nothing forced the two
//     to agree. (A formula naming a box with no starting value reads it as 0,
//     which is the usual way this happens.)
//   • A MIN/MAX that excludes the starting value. The limits are applied after
//     every rule, so a box declared at 50 with a max of 40 opens at 40.
//
// Rather than a rule per cause, this asks the question the reader actually cares
// about — "is this box where it says it is?" — which catches both, and catches
// whatever the next rule to land here does too. The threshold is the map's OWN
// display threshold (formatNodeDelta), so it warns if and only if the map would
// visibly show a change at rest: a difference too small to draw is too small to
// mention. Named, not corrected — which of the two numbers is wrong is the
// author's call, and both are things they typed.
// ═════════════════════════════════════════════════════════════════════════════
function validateRestState(errors: Finding[]): void {
  for (const node of NODES) {
    const baseline = node.baseline;
    if (baseline === undefined || baseline === null) continue;
    const value = state.computedValues[node.id];
    if (value === undefined) continue;
    const pct = ((value - baseline) / baseline) * 100;
    if (Math.abs(pct) < DELTA_DISPLAY_THRESHOLD_PCT) continue;

    // explainNode() has already worked out which rule produced the number and
    // whether a limit moved it, so the reason costs nothing to add.
    const explanation = explainNode(node.id);
    let because = "";
    if (explanation && explanation.clamp) {
      const limit = explanation.clamp.max !== undefined && !(explanation.clamp.from < explanation.clamp.max)
        ? "max " + explanation.clamp.max
        : "min " + explanation.clamp.min;
      because = " Its " + limit + " excludes its starting value.";
    } else if (explanation && explanation.rule === "formula") {
      because = " Its formula (`" + (node.formula || "") + "`) works out to " +
        formatScalar(value) + " when every box is at its starting value.";
    }

    errors.push(finding(REST_DRIFT, "wrong",
      "It does not rest at its starting value: it says " + formatScalar(baseline) +
      " but opens at " + formatScalar(value) + " (" + (pct > 0 ? "+" : "") + pct.toFixed(1) +
      "%) with every slider at 100%." + because + " Every % change on this box is measured " +
      "against " + formatScalar(baseline) + ".",
      { boxId: node.id, fix: "One of the two numbers is wrong — decide which." }));
  }
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
function reportFormulaCyclesWithoutDelay(errors: Finding[]): void {
  // Only a loop passing through a formula box is ever reported, so a map with
  // no formulas at all can skip the whole-graph DFS (and its per-node
  // dependency arrays) — on large formula-free maps this was a third full
  // traversal per load for a guaranteed-empty result.
  if (!NODES.some((node) => usesFormula(node))) return;
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = createIdentifierRecord<number>();
  const dependencies = createIdentifierRecord<string[]>();
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
            errors.push(finding("loop-without-delay", "wrong",
              "Boxes " + drawn + " form a calculation loop through a formula with no delay(), " +
              "so each one needs the others' value before it exists.",
              { boxId: causalChain[0],
                fix: "Wrap one of the inputs in delay(...) to make the loop well-defined." }));
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
  const sections = parseCsvDocument(csvText);
  const errors: Finding[] = [];

  const failLoad = (): false => {
    state.loadErrors = errors;
    showLoadFeedback("Load failed: " + errors.map(error => error.message).join(" "), true);
    return false;
  };

  // ───── Fatal-error checks (we can't proceed without these) ─────────────
  const missingSection = (name: string) => finding("section-missing", "ignored",
    "The spreadsheet has no `" + name + "` section, or it is empty. Nothing can load without it.",
    { fix: "Add a `# SECTION: " + name + "` block with at least one row." });
  if (!sections.streams    || sections.streams.length === 0)    errors.push(missingSection("streams"));
  if (!sections.stages     || sections.stages.length === 0)     errors.push(missingSection("stages"));
  if (!sections.categories || sections.categories.length === 0) errors.push(missingSection("categories"));
  if (!sections.nodes      || sections.nodes.length === 0)      errors.push(missingSection("nodes"));

  if (errors.length > 0) return failLoad();

  // Rows, columns, and categories define the coordinate system for every box.
  // Dropping or renaming one would silently change the identity of all its
  // references, so any blank, duplicate, or non-canonical id rejects the load
  // transaction before live state (including edge allocation) is touched.
  const validateDimensionIdentifiers = (
    rows: Array<Record<string, string>>,
    dimensionName: string,
  ): void => {
    const seenIdentifiers = new Set<string>();
    rows.forEach((row, rowIndex) => {
      const identifier = row.id;
      if (!identifier) {
        errors.push(finding("identifier-missing", "ignored",
          "The " + dimensionName + " at row " + (rowIndex + 1) +
          " has no id. The map is not loaded because references cannot be rewritten safely.",
          { fix: canonicalIdentifierGuidance() }));
        return;
      }
      if (!isCanonicalIdentifier(identifier)) {
        errors.push(finding("identifier-invalid", "ignored",
          "The " + dimensionName + " id `" + identifier +
          "` is not a canonical identifier. The map is not loaded and the id is not rewritten.",
          { fix: canonicalIdentifierGuidance() }));
        return;
      }
      if (seenIdentifiers.has(identifier)) {
        errors.push(finding("identifier-duplicate", "ignored",
          "The " + dimensionName + " id `" + identifier +
          "` appears more than once. The map is not loaded because those identities are ambiguous.",
          { fix: "Give each " + dimensionName + " a unique id." }));
        return;
      }
      seenIdentifiers.add(identifier);
    });
  };

  validateDimensionIdentifiers(sections.streams!, "row");
  validateDimensionIdentifiers(sections.stages!, "column");
  validateDimensionIdentifiers(sections.categories!, "category");
  if (errors.length > 0) return failLoad();

  const validatedColour = (
    rawColour: string | undefined,
    fallbackColour: string,
    ownerDescription: string,
  ): string => {
    if (isBlankInput(rawColour)) return fallbackColour;
    const colour = String(rawColour).trim();
    if (isSafeHexColour(colour)) return colour;
    errors.push(finding("colour-invalid", "ignored",
      ownerDescription + " has colour `" + rawColour +
      "`, which is not a literal hexadecimal colour. The safe default " + fallbackColour + " is used.",
      { fix: "Use #RGB, #RGBA, #RRGGBB, or #RRGGBBAA." }));
    return fallbackColour;
  };

  // ───── Streams ──────────────────────────────────────────────────────────
  const parsedStreams: Stream[] = sections.streams!.map((row): Stream => ({
    id: row.id,
    label: row.label || row.id,
    short: row.short || (row.id || "").toUpperCase(),
    color: validatedColour(row.color, "#94a3b8", "Row `" + row.id + "`"),
  }));

  // ───── Stages ───────────────────────────────────────────────────────────
  const parsedStages: Stage[] = sections.stages!.map((row): Stage => ({
    id: row.id,
    label: row.label || row.id,
  }));

  // ───── Categories ───────────────────────────────────────────────────────
  const parsedCategories: CategoryMap = createIdentifierRecord();
  for (const row of sections.categories!) {
    parsedCategories[row.id] = {
      label: row.label || row.id,
      color: validatedColour(row.color, "#a3a3a3", "Category `" + row.id + "`"),
      textColor: validatedColour(row.text_color, "#1c1917", "Category `" + row.id + "` text"),
      // "primary" = fill (default; several primaries blend into a gradient);
      // "secondary" = a small chip in the node's bottom-right corner.
      class: (row.class || "").trim().toLowerCase() === "secondary" ? "secondary" : "primary",
    };
  }

  // ───── Defaults (elasticities) ──────────────────────────────────────────
  const parsedDefaults: ElasticityDefaults = { enables: 0.30, increases: 0.25, decreases: -0.25 };
  if (sections.defaults) {
    for (const row of sections.defaults) {
      const key = (row.key || "").trim();
      if (!key) continue;
      const numericValue = parseNumericCell(row.value);
      if (numericValue === undefined) {
        if (!isBlankInput(row.value)) {
          errors.push(finding("default-not-a-number", "ignored",
            "The default `" + row.key + "` has value `" + row.value +
            "`, which is not a finite decimal number. The built-in default is retained.",
            { fix: "Use a plain finite decimal number." }));
        }
        continue;
      }
      if (key === ELASTICITY_KEYS.enables)   parsedDefaults.enables   = numericValue;
      if (key === ELASTICITY_KEYS.increases) parsedDefaults.increases = numericValue;
      if (key === ELASTICITY_KEYS.decreases) parsedDefaults.decreases = numericValue;
    }
  }

  // ───── Nodes (with foreign-key validation) ──────────────────────────────
  const streamIdSet   = new Set(parsedStreams.map(s => s.id));
  const stageIdSet    = new Set(parsedStages.map(s => s.id));
  const categoryIdSet = new Set(Object.keys(parsedCategories));
  const seenNodeIds   = new Set<string>();
  const parsedNodes: GraphNode[] = [];

  for (const row of sections.nodes!) {
    if (!row.id) {
      errors.push(finding("identifier-missing", "ignored",
        "A box has no id and is dropped; its identity cannot be rewritten safely.",
        { fix: canonicalIdentifierGuidance() }));
      continue;
    }
    if (!isCanonicalIdentifier(row.id)) {
      errors.push(finding("identifier-invalid", "ignored",
        "The box id `" + row.id + "` is not canonical. The box is dropped and its id is not rewritten.",
        { fix: canonicalIdentifierGuidance() }));
      continue;
    }
    if (seenNodeIds.has(row.id)) {
      errors.push(finding("duplicate-id", "ignored",
        "A second box also has the id `" + row.id + "`. The later one is dropped.",
        { boxId: row.id, fix: "Give one of them a different id." }));
      continue;
    }
    seenNodeIds.add(row.id);

    // Drop nodes that reference unknown stream/stage/category — keeping
    // them would crash the renderer when it dereferences streamById[…]
    // or CATEGORIES[…]. We still log a warning so the user can fix the CSV.
    let hasInvalidRefs = false;
    if (!streamIdSet.has(row.stream)) {
      errors.push(finding("unknown-row", "ignored",
        "It sits in row `" + row.stream + "`, which does not exist. The box is dropped.",
        { boxId: row.id, fix: "Point it at a row from the `streams` section." }));
      hasInvalidRefs = true;
    }
    if (!stageIdSet.has(row.stage)) {
      errors.push(finding("unknown-column", "ignored",
        "It sits in column `" + row.stage + "`, which does not exist. The box is dropped.",
        { boxId: row.id, fix: "Point it at a column from the `stages` section." }));
      hasInvalidRefs = true;
    }

    // `category` is a pipe-separated list of category ids. Each id's class
    // (primary/secondary) decides how it renders. Unknown ids are dropped with
    // a warning; a node with no valid category at all is skipped.
    // Category references are identities too. Keep each authored token exact:
    // trimming here would turn ` cat` into a different, apparently valid id.
    const rawCatIds = String(row.category == null ? "" : row.category).split("|").filter(Boolean);
    const seenCat = new Set<string>();
    const validCatIds = rawCatIds.filter(id => categoryIdSet.has(id) && !seenCat.has(id) && seenCat.add(id));
    for (const u of new Set(rawCatIds.filter(id => !categoryIdSet.has(id)))) {
      errors.push(finding("unknown-category", "ignored",
        "It carries the tag `" + u + "`, which does not exist. That tag is ignored.",
        { boxId: row.id, fix: "Add the tag to the `categories` section, or fix the spelling." }));
    }
    if (validCatIds.length === 0) {
      errors.push(finding("no-category", "ignored",
        "It has no tag that exists, so the box is dropped.",
        { boxId: row.id, fix: "Give it a tag from the `categories` section." }));
      hasInvalidRefs = true;
    }
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
        errors.push(finding("baseline-zero", "ignored",
          "Its starting value is 0. The what-if maths divides by the starting value, so it " +
          "must be positive or blank. The starting value is ignored.",
          { boxId: row.id, fix: "Use a positive number, or leave it blank." }));
      } else if (baselineValue < 0) {
        errors.push(finding("baseline-negative", "ignored",
          "Its starting value is " + baselineValue + ". The what-if maths requires a positive " +
          "starting value, so it is ignored.",
          { boxId: row.id, fix: "Use a positive number, or leave it blank." }));
      } else {
        node.baseline = baselineValue;
      }
    } else if (!isBlankInput(row.baseline)) {
      errors.push(finding("baseline-not-a-number", "ignored",
        "Its starting value `" + row.baseline + "` is not a finite decimal number and is ignored.",
        { boxId: row.id, fix: "Use a plain finite decimal number, or leave it blank." }));
    }
    if (row.unit && row.unit !== "")  node.unit = row.unit;
    if (parseBooleanCell(row.controllable)) node.controllable = true;
    const directionValue = (row.direction || "").trim();
    if (directionValue !== "") node.direction = directionValue as GraphNode["direction"];
    // `slider_max` is a MULTIPLE of the starting value (2 = "up to twice it"),
    // unlike `min`/`max` beside it, which are absolute. Below 1 it would be a
    // ceiling under the box's own starting value — the slider could then never
    // be put back to 100%, so touching it once stuck the box (and everything
    // downstream) below where it started with no way back but Reset. Named and
    // ignored rather than silently trapping the box.
    const sliderMaxValue = parseNumericCell(row.slider_max);
    if (sliderMaxValue !== undefined) {
      if (sliderMaxValue < 1) {
        errors.push(finding("slider-max-below-one", "ignored",
          "Its slider max is " + sliderMaxValue + ". That figure is a MULTIPLE of the starting " +
          "value, so below 1 the box could never be put back to where it started. It is ignored.",
          { boxId: row.id, fix: "2 means \"up to twice the starting value\"." }));
      } else {
        node.sliderMax = sliderMaxValue;
      }
    } else if (!isBlankInput(row.slider_max)) {
      errors.push(finding("slider-max-not-a-number", "ignored",
        "Its slider max `" + row.slider_max + "` is not a finite decimal number and is ignored.",
        { boxId: row.id, fix: "Use a finite decimal number of at least 1, or leave it blank." }));
    }

    // ── Optional per-box calculation rules (all blank in an older CSV) ──────
    // `combine` picks how the arrows pointing INTO this box are aggregated.
    // Blank keeps today's behaviour (multiplicative); anything outside the
    // enum is a typo we name and ignore rather than silently mis-calculating.
    const combineValue = (row.combine || "").trim().toLowerCase();
    if (combineValue !== "") {
      if (COMBINE_MODES.includes(combineValue as CombineMode)) {
        node.combine = combineValue as CombineMode;
      } else {
        errors.push(finding("unknown-combine", "ignored",
          "Its combine rule `" + row.combine + "` is not one the engine knows. It is ignored, " +
          "so the box uses the default rule.",
          { boxId: row.id, fix: "Use one of " + COMBINE_MODES.join(" / ") + "." }));
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
    if (minValue === undefined && !isBlankInput(row.min)) {
      errors.push(finding("minimum-not-a-number", "ignored",
        "Its minimum `" + row.min + "` is not a finite decimal number and is ignored.",
        { boxId: row.id, fix: "Use a plain finite decimal number, or leave it blank." }));
    }
    if (maxValue === undefined && !isBlankInput(row.max)) {
      errors.push(finding("maximum-not-a-number", "ignored",
        "Its maximum `" + row.max + "` is not a finite decimal number and is ignored.",
        { boxId: row.id, fix: "Use a plain finite decimal number, or leave it blank." }));
    }
    if (minValue !== undefined && maxValue !== undefined && minValue > maxValue) {
      errors.push(finding("limits-crossed", "ignored",
        "Its lowest allowed value (" + minValue + ") is above its highest (" + maxValue +
        "), which no number can satisfy. Both limits are ignored.",
        { boxId: row.id, fix: "Swap them, or clear one." }));
    } else {
      if (minValue !== undefined) node.minValue = minValue;
      if (maxValue !== undefined) node.maxValue = maxValue;
    }

    parsedNodes.push(node);
  }

  if (parsedNodes.length === 0) {
    errors.push(finding("nodes-empty-after-validation", "ignored",
      "No box has a usable canonical id and valid row, column, and category references. The map is not loaded.",
      { fix: "Correct at least one box and its references before loading." }));
    return failLoad();
  }

  // ───── Edges (with foreign-key + effect validation) ─────────────────────
  const nodeIdSet = new Set(parsedNodes.map(n => n.id));
  const parsedEdges: Edge[] = [];

  if (sections.edges) {
    for (const row of sections.edges) {
      if (!row.from || !row.to) continue;
      if (!isCanonicalIdentifier(row.from) || !isCanonicalIdentifier(row.to)) {
        errors.push(finding("identifier-invalid", "ignored",
          "A link has a source or target id with invalid characters or boundary whitespace. " +
          "The link is dropped and neither identity is rewritten.",
          { fix: canonicalIdentifierGuidance() }));
        continue;
      }
      if (!nodeIdSet.has(row.from)) {
        errors.push(finding("link-dangling", "ignored",
          "A link starts at `" + row.from + "`, which is not a box on this map. The link is dropped.",
          { fix: "Fix the id, or add the box." }));
        continue;
      }
      if (!nodeIdSet.has(row.to)) {
        errors.push(finding("link-dangling", "ignored",
          "A link ends at `" + row.to + "`, which is not a box on this map. The link is dropped.",
          { fix: "Fix the id, or add the box." }));
        continue;
      }

      const effect = (row.effect || "enables").trim().toLowerCase();
      if (!EFFECT_OPTIONS.includes(effect)) {
        errors.push(finding("link-bad-effect", "ignored",
          "The link " + row.from + " → " + row.to + " has effect `" + row.effect +
          "`, which the engine does not know. The link is dropped.",
          { boxId: row.to, fix: "Use enables / increases / decreases." }));
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
      else if (!isBlankInput(row.elasticity)) {
        errors.push(finding("elasticity-not-a-number", "ignored",
          "The link " + row.from + " → " + row.to + " has strength `" + row.elasticity +
          "`, which is not a finite decimal number. Its effect default is used.",
          { boxId: row.to, fix: "Use a plain finite decimal number, or leave it blank." }));
      }
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
      if (!row.id) {
        errors.push(finding("identifier-missing", "ignored",
          "A constant has no id and is dropped; its identity cannot be rewritten safely.",
          { fix: canonicalIdentifierGuidance() }));
        continue;
      }
      if (!isCanonicalIdentifier(row.id)) {
        errors.push(finding("identifier-invalid", "ignored",
          "The constant id `" + row.id + "` is not canonical. The constant is dropped and its id is not rewritten.",
          { fix: canonicalIdentifierGuidance() }));
        continue;
      }
      if (seenParamIds.has(row.id)) {
        errors.push(finding("duplicate-constant", "ignored",
          "A second constant also has the id `" + row.id + "`. The later one is dropped.",
          { fix: "Give one of them a different id." }));
        continue;
      }
      seenParamIds.add(row.id);
      if (nodeIdSet.has(row.id)) {
        errors.push(finding("constant-clashes-with-box", "ignored",
          "The constant `" + row.id + "` has the same id as a box, so a formula naming it could " +
          "mean either. The constant is dropped.",
          { boxId: row.id, fix: "Rename the constant." }));
        continue;
      }
      const paramValue = parseNumericCell(row.value);
      if (paramValue === undefined) {
        errors.push(finding("constant-not-a-number", "ignored",
          "The constant `" + row.id + "` has the value `" + (row.value || "") + "`, which is not " +
          "a number. It is dropped.",
          { fix: "Give it a plain number." }));
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
  // Only a successful transaction may restart deterministic edge allocation.
  // Rejected loads retain both the previous graph and its next unused id.
  _edgeIdSeq = 0;
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
  // Search results retain node object references. A successful replacement
  // invalidates every one of them, so clear the query and focus before any
  // keyboard or pointer event can activate a box from the previous map.
  state.searchQuery = "";
  state.searchMatches = [];
  state.searchFocusIndex = 0;
  state.hiddenStreams = new Set();
  state.hiddenCategories = new Set();
  state.hiddenStages = new Set();
  state.ancestorSet = new Set();
  state.descendantSet = new Set();
  state.highlightedEdgeIds = new Set();
  // A multiplier belongs to the map it was set on, so a new map starts at 100%
  // everywhere. Cleared in memory AND in storage: leaving the old map's sliders
  // in the UI slot meant a refresh restored them onto whichever map was loaded
  // next, silently showing a change against every starting value the user had
  // not touched. (18-main reads the UI slot before this runs, so the write here
  // can't clobber the restore that follows it.)
  state.userOverrides = createIdentifierRecord();
  saveUiStateToStorage();
  // A pass belongs to the map it was started on: the queue, the marks and the
  // rail are all about boxes that may not exist in the file just opened. Ending
  // it here is the same reasoning as closing the atlas below.
  endReviewPass();
  // ── The review record, read back from the map's own spreadsheet ──────────
  // Replaced wholesale, never merged: a verdict belongs to the map it was given
  // on, and carrying one across a load would attach somebody's sign-off to a
  // box in a file they never saw. Rows naming a box that is not on this map are
  // dropped for the same reason.
  state.reviews = createIdentifierRecord();
  if (sections.reviews) {
    for (const row of sections.reviews as any[]) {
      if (!row.box) continue;
      if (!isCanonicalIdentifier(row.box)) {
        errors.push(finding("identifier-invalid", "ignored",
          "The review box id `" + row.box + "` is not canonical. The review is dropped and its id is not rewritten.",
          { fix: canonicalIdentifierGuidance() }));
        continue;
      }
      // A row about a box this file does not have is kept ONLY when it carries a
      // removal date — that is a tombstone, a box this map had and somebody
      // deleted, and losing it would lose the review with it. Without one, the
      // row is about a box this map never had: dropped, as before, so opening a
      // different file can never attach somebody's verdict to a box they never
      // saw. From the row alone those two cases are indistinguishable, and the
      // tombstone is what tells them apart.
      if (!nodeIdSet.has(row.box) && !row.removed_on) continue;
      // Anything that is not one of the two judgements reads as NO judgement —
      // never as an agreement. A row this build does not understand must not
      // become somebody's sign-off, which is the one mistake the whole record
      // exists to prevent.
      const verdictValue = (row.verdict || "").trim().toLowerCase();
      const verdict = verdictValue === "agreed" ? "agreed"
                    : verdictValue === "flagged" ? "flagged" : "none";
      const flaggedSources: string[] = [];
      for (const flaggedSource of String(row.flagged || "").split("|").filter(Boolean)) {
        if (!isCanonicalIdentifier(flaggedSource)) {
          errors.push(finding("identifier-invalid", "ignored",
            "The review for `" + row.box + "` contains an invalid flagged source id `" +
            flaggedSource + "`. That source is dropped and its identity is not rewritten.",
            { boxId: row.box, fix: canonicalIdentifierGuidance() }));
          continue;
        }
        flaggedSources.push(flaggedSource);
      }
      state.reviews[row.box] = {
        boxId: row.box,
        verdict: verdict,
        reviewer: row.reviewer || "",
        date: row.date || "",
        note: row.note || "",
        fingerprint: row.fingerprint || "",
        flaggedSources: flaggedSources,
        // Absent from files written before these columns existed. A flag with no
        // raised-on date reads as raised on the day of the verdict, which is the
        // only honest guess available and is right for every file this build
        // wrote; anything else would invent a date.
        flaggedOn: row.flagged_on || (verdict === "flagged" ? (row.date || "") : ""),
        flaggedBy: row.flagged_by || (verdict === "flagged" ? (row.reviewer || "") : ""),
        addressedOn: row.addressed_on || "",
        addressedBy: row.addressed_by || "",
        addressedNote: row.addressed_note || "",
        label: row.label || row.box,
        removedOn: row.removed_on || "",
      };
    }
  }
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
  // Every slider is at 100% on a fresh load, so every box should be sitting on
  // its own starting value. Any that isn't gets named here — see the function.
  validateRestState(errors);
  // Which of those findings are causes and which are the same mistake arriving
  // from upstream. Runs last because it needs every finding in hand, and the
  // rest-state check above is the one that produces the shadows.
  attributeFindings(errors);
  // Replace reproducible text-only findings with their structured equivalents.
  // Import-row findings stay intact; structured targets are what lets Review
  // offer a safe direct patch only when the exact field or connection is known.
  refreshLiveReviewFindings();
  attributeFindings(state.loadErrors);
  // A sweep is a fact about the shape of the map, and this is a different map.
  invalidateSweep();
  hideDropZone();
  renderSidebar();
  render();
  renderDetailPanel();
  // The count badge is part of the map's own presentation: a map with problems
  // must never LOOK clean. Repaints the panel too, if it happens to be open —
  // undo / redo route back through here.
  refreshReview();

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
    // The toast is now a POINTER, not the report. It says how many and where to
    // look; the Review panel holds the findings themselves, grouped by cause and
    // still there in ten minutes when the reader gets to them. The console line
    // stays for anyone debugging with devtools already open.
    const causes = groupFindings(errors).groups.length;
    showLoadFeedback(
      "Loaded with " + errors.length + " finding" + (errors.length === 1 ? "" : "s") +
      (causes < errors.length ? " (" + causes + " to fix)" : "") + ". " + summary + "." +
      loopNote + " Open Review to see them.",
      false,
    );
    console.warn("Load findings:", errors);
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
