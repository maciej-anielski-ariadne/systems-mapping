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

// Build all the lookup maps from the freshly-loaded NODES/EDGES/STREAMS/STAGES.
// Also produces a topological order: a list of node ids where every node
// comes after all the nodes that feed into it. The Cobb-Douglas calculation
// in 07-simulation-engine.js needs this order to propagate values correctly.
function rebuildIndexes() {
  nodeById = {};
  streamNodeCount = {};
  categoryNodeCount = {};
  for (const node of NODES) {
    nodeById[node.id] = node;
    // Counts cached here (rather than recomputed per render) so the sidebar
    // and any other code that wants "how many nodes in this stream" is an
    // O(1) lookup. Matters once the map grows past a few hundred nodes.
    streamNodeCount[node.stream]     = (streamNodeCount[node.stream]     || 0) + 1;
    categoryNodeCount[node.category] = (categoryNodeCount[node.category] || 0) + 1;
  }

  outgoingEdges = {};
  incomingEdges = {};
  for (const node of NODES) {
    outgoingEdges[node.id] = [];
    incomingEdges[node.id] = [];
  }
  for (let edgeIndex = 0; edgeIndex < EDGES.length; edgeIndex++) {
    const edge = EDGES[edgeIndex];
    edge.id = "edge_" + edgeIndex;       // give every edge a stable id
    if (outgoingEdges[edge.from]) outgoingEdges[edge.from].push(edge);
    if (incomingEdges[edge.to])   incomingEdges[edge.to].push(edge);
  }

  streamById = {};
  for (const stream of STREAMS) streamById[stream.id] = stream;

  stageById = {};
  for (let stageIdx = 0; stageIdx < STAGES.length; stageIdx++) {
    stageById[STAGES[stageIdx].id] = { ...STAGES[stageIdx], index: stageIdx };
  }

  // ───── Topological sort (Kahn's algorithm) ─────────────────────────────
  // Sort nodes so every node comes after the nodes whose arrows point INTO it.
  const remainingInDegree = {};
  for (const node of NODES) remainingInDegree[node.id] = 0;
  for (const edge of EDGES) {
    if (remainingInDegree[edge.to] !== undefined) remainingInDegree[edge.to]++;
  }

  const ready = [];
  for (const node of NODES) {
    if (remainingInDegree[node.id] === 0) ready.push(node.id);
  }

  const sorted = [];
  while (ready.length > 0) {
    const id = ready.shift();
    sorted.push(id);
    for (const edge of outgoingEdges[id]) {
      remainingInDegree[edge.to]--;
      if (remainingInDegree[edge.to] === 0) ready.push(edge.to);
    }
  }

  if (sorted.length !== NODES.length) {
    const unsorted = NODES.length - sorted.length;
    console.warn(
      "Topological sort incomplete — possible cycle. Sorted:",
      sorted.length, "of", NODES.length,
    );
    // Surface to the user too — without this, simulation silently degrades
    // (the unsorted nodes won't get computed values) and there's no
    // in-app signal of the problem.
    if (typeof showLoadFeedback === "function") {
      showLoadFeedback(
        "Cycle detected — " + unsorted + " of " + NODES.length + " node(s) skipped in simulation. Remove the loop to fix.",
        true,
      );
    }
  }
  topologicalOrder = sorted;
}

// Main entry point. Returns true on success, false on fatal validation errors.
function loadDataFromCsv(csvText) {
  const sections = parseCsvDocument(csvText);
  const errors = [];

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
  const parsedStreams = sections.streams.map(row => ({
    id: row.id,
    label: row.label || row.id,
    short: row.short || (row.id || "").toUpperCase(),
    color: row.color || "#94a3b8",
  })).filter(stream => stream.id);

  // ───── Stages ───────────────────────────────────────────────────────────
  const parsedStages = sections.stages.map(row => ({
    id: row.id,
    label: row.label || row.id,
  })).filter(stage => stage.id);

  // ───── Categories ───────────────────────────────────────────────────────
  const parsedCategories = {};
  for (const row of sections.categories) {
    if (!row.id) continue;
    parsedCategories[row.id] = {
      label: row.label || row.id,
      color: row.color || "#a3a3a3",
      textColor: row.text_color || "#1c1917",
    };
  }

  // ───── Defaults (elasticities) ──────────────────────────────────────────
  const parsedDefaults = { enables: 0.30, increases: 0.25, decreases: -0.25 };
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
  const seenNodeIds   = new Set();
  const parsedNodes   = [];

  for (const row of sections.nodes) {
    if (!row.id) continue;
    if (seenNodeIds.has(row.id)) {
      errors.push("Duplicate node id: " + row.id);
      continue;
    }
    seenNodeIds.add(row.id);

    // Drop nodes that reference unknown stream/stage/category — keeping
    // them would crash the renderer when it dereferences streamById[…]
    // or CATEGORIES[…]. We still log a warning so the user can fix the CSV.
    let hasInvalidRefs = false;
    if (!streamIdSet.has(row.stream))     { errors.push("Node `" + row.id + "` references unknown stream `"   + row.stream   + "`. Skipped."); hasInvalidRefs = true; }
    if (!stageIdSet.has(row.stage))       { errors.push("Node `" + row.id + "` references unknown stage `"    + row.stage    + "`. Skipped."); hasInvalidRefs = true; }
    if (!categoryIdSet.has(row.category)) { errors.push("Node `" + row.id + "` references unknown category `" + row.category + "`. Skipped."); hasInvalidRefs = true; }
    if (hasInvalidRefs) continue;

    const node = {
      id: row.id,
      label: row.label || row.id,
      description: row.description || "",
      stream: row.stream,
      stage: row.stage,
      category: row.category,
    };

    // Optional quantification fields.
    // baseline must be > 0 — simulation divides by baseline when propagating
    // value ratios, so 0 produces Infinity (or NaN) downstream. Reject 0
    // explicitly with a warning rather than silently breaking simulation.
    const baselineValue = parseNumericCell(row.baseline);
    if (baselineValue !== undefined) {
      if (baselineValue === 0) {
        errors.push("Node `" + row.id + "` has baseline 0 — must be positive (simulation divides by baseline). Baseline ignored.");
      } else {
        node.baseline = baselineValue;
      }
    }
    if (row.unit && row.unit !== "")  node.unit = row.unit;
    if (parseBooleanCell(row.controllable)) node.controllable = true;
    if (row.direction && row.direction !== "") node.direction = row.direction;
    const sliderMaxValue = parseNumericCell(row.slider_max);
    if (sliderMaxValue !== undefined) node.sliderMax = sliderMaxValue;

    parsedNodes.push(node);
  }

  // ───── Edges (with foreign-key + effect validation) ─────────────────────
  const nodeIdSet = new Set(parsedNodes.map(n => n.id));
  const parsedEdges = [];

  if (sections.edges) {
    for (const row of sections.edges) {
      if (!row.from || !row.to) continue;
      if (!nodeIdSet.has(row.from)) { errors.push("Edge from unknown node: " + row.from); continue; }
      if (!nodeIdSet.has(row.to))   { errors.push("Edge to unknown node: "   + row.to);   continue; }

      const effect = (row.effect || "enables").toLowerCase();
      if (!EFFECT_OPTIONS.includes(effect)) {
        errors.push("Edge " + row.from + "→" + row.to + " has invalid effect `" + row.effect + "`.");
        continue;
      }

      const edge = {
        from: row.from,
        to: row.to,
        effect: effect,
        description: row.description || "",
      };
      const elasticityValue = parseNumericCell(row.elasticity);
      if (elasticityValue !== undefined) edge.elasticity = elasticityValue;

      parsedEdges.push(edge);
    }
  }

  // ───── Commit to global state ───────────────────────────────────────────
  STREAMS = parsedStreams;
  STAGES = parsedStages;
  CATEGORIES = parsedCategories;
  NODES = parsedNodes;
  EDGES = parsedEdges;
  DEFAULT_ELASTICITY_BY_EFFECT = parsedDefaults;

  // Reset transient interaction state. Must happen BEFORE computeLayout()
  // because layout now reads state.hiddenStreams to collapse hidden rows.
  state.selectedNodeId = null;
  state.hoveredNodeId = null;
  state.hiddenStreams = new Set();
  state.hiddenCategories = new Set();
  state.ancestorSet = new Set();
  state.descendantSet = new Set();
  state.highlightedEdgeIds = new Set();
  state.userOverrides = {};
  state.dataLoaded = true;
  state.loadErrors = errors;

  rebuildIndexes();
  layout = computeLayout();

  recomputeValues();
  hideDropZone();
  renderSidebar();
  render();
  renderDetailPanel();

  // Only surface a toast when something went wrong. Successful loads are
  // visually obvious (the map renders); the count is also visible in the
  // sidebar filter counts, so we don't need an extra notification.
  if (errors.length > 0) {
    const summary = NODES.length + " nodes, " + EDGES.length + " edges, " + STREAMS.length + " streams";
    showLoadFeedback("Loaded with " + errors.length + " warning(s). " + summary + ". See console for details.", false);
    console.warn("Load warnings:", errors);
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
