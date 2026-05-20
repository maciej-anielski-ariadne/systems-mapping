// =============================================================================
// LEFT SIDEBAR RENDERING
// -----------------------------------------------------------------------------
// Builds the HTML for the stream filters, category filters, and (when
// simulation mode is on) delegates to the simulation panel renderer.
// Called whenever filters / selection / data changes.
// =============================================================================

function renderSidebar() {
  const sidebarEl = document.getElementById("sidebar");
  if (sidebarEl) {
    sidebarEl.style.visibility = state.dataLoaded ? "visible" : "hidden";
  }
  if (!state.dataLoaded) return;

  // The simulation panel is its own concern — see 14-simulation-panel.js.
  renderSimulationPanel();

  // ───── Stream filter rows ─────────────────────────────────────────────
  // streamNodeCount / categoryNodeCount are pre-computed in rebuildIndexes
  // (06-data-loader.js) so this renders in O(streams + categories) instead
  // of O(streams × NODES) — important for large maps.
  const streamContainer = document.getElementById("stream-filters");
  let streamHtml = "";
  for (const stream of STREAMS) {
    const isHidden = state.hiddenStreams.has(stream.id);
    const count = streamNodeCount[stream.id] || 0;
    const tip = (isHidden ? "Click to show " : "Click to hide ") + stream.label + " — " + count + " node" + (count === 1 ? "" : "s") + " on the map.";
    streamHtml += '<div class="filter-row ' + (isHidden ? "disabled" : "") + '" data-stream-id="' + stream.id + '" data-tooltip="' + escapeHtml(tip) + '">';
    streamHtml +=   '<div class="filter-swatch" style="background: ' + stream.color + ';"></div>';
    streamHtml +=   '<div class="filter-label">' + stream.label + '</div>';
    streamHtml +=   '<div class="filter-count">' + count + '</div>';
    streamHtml += '</div>';
  }
  streamContainer.innerHTML = streamHtml;
  streamContainer.querySelectorAll(".filter-row").forEach(row => {
    row.addEventListener("click", () => {
      toggleStream(row.getAttribute("data-stream-id"));
    });
  });

  const visibleCount = STREAMS.length - state.hiddenStreams.size;
  document.getElementById("visible-streams-count").textContent = visibleCount + " / " + STREAMS.length;

  // ───── Category filter rows ───────────────────────────────────────────
  const categoryContainer = document.getElementById("category-filters");
  let categoryHtml = "";
  for (const [catId, cat] of Object.entries(CATEGORIES)) {
    const isHidden = state.hiddenCategories.has(catId);
    const count = categoryNodeCount[catId] || 0;
    if (count === 0) continue;     // skip empty categories
    const tip = (isHidden ? "Click to show " : "Click to hide ") + cat.label + " nodes — " + count + " on the map.";
    categoryHtml += '<div class="filter-row ' + (isHidden ? "disabled" : "") + '" data-cat-id="' + catId + '" data-tooltip="' + escapeHtml(tip) + '">';
    categoryHtml +=   '<div class="filter-swatch" style="background: ' + cat.color + ';"></div>';
    categoryHtml +=   '<div class="filter-label">' + cat.label + '</div>';
    categoryHtml +=   '<div class="filter-count">' + count + '</div>';
    categoryHtml += '</div>';
  }
  categoryContainer.innerHTML = categoryHtml;
  categoryContainer.querySelectorAll(".filter-row").forEach(row => {
    row.addEventListener("click", () => {
      toggleCategory(row.getAttribute("data-cat-id"));
    });
  });

  // ───── Nodes list ─────────────────────────────────────────────────────
  // Lists every node in the map, grouped by its stream, with the node label
  // as the row text. Clicking a row selects the node + scrolls the map. The
  // currently-selected node is highlighted. Lets users find a node by name
  // without searching the canvas — and surfaces placeholder labels like
  // "New node" so they can be renamed.
  renderNodesList();

  // Newly-rendered rows have data-tooltip; wire them up to the tooltip system.
  if (typeof wireDataTooltips === "function") wireDataTooltips(sidebarEl);
}

// Render the Nodes section. Called by renderSidebar() and also after any
// canvas mutation that changes node labels / counts.
function renderNodesList() {
  const container = document.getElementById("nodes-list");
  const countEl   = document.getElementById("nodes-list-count");
  if (!container) return;

  if (NODES.length === 0) {
    container.innerHTML = '<div class="sidebar-empty">No nodes yet. Click any cell on the canvas to add one.</div>';
    if (countEl) countEl.textContent = "0";
    return;
  }

  // Group nodes by stream so the list is structured. Streams render in their
  // canonical order; nodes inside a stream render in (stage order, then label).
  const stageIndex = {};
  for (let i = 0; i < STAGES.length; i++) stageIndex[STAGES[i].id] = i;

  const nodesByStream = {};
  for (const stream of STREAMS) nodesByStream[stream.id] = [];
  for (const node of NODES) {
    if (!nodesByStream[node.stream]) nodesByStream[node.stream] = [];
    nodesByStream[node.stream].push(node);
  }
  for (const streamId in nodesByStream) {
    nodesByStream[streamId].sort((a, b) => {
      const ai = stageIndex[a.stage] !== undefined ? stageIndex[a.stage] : 999;
      const bi = stageIndex[b.stage] !== undefined ? stageIndex[b.stage] : 999;
      if (ai !== bi) return ai - bi;
      return (a.label || "").localeCompare(b.label || "");
    });
  }

  let html = "";
  for (const stream of STREAMS) {
    const streamNodes = nodesByStream[stream.id];
    if (!streamNodes || streamNodes.length === 0) continue;
    html += '<div class="node-list-group">';
    html +=   '<div class="node-list-group-header" style="--stream-color: ' + stream.color + ';">' + escapeHtml(stream.label) + '</div>';
    for (const node of streamNodes) {
      const isSelected = node.id === state.selectedNodeId;
      const category = CATEGORIES[node.category];
      const swatchColor = category ? category.color : "#a3a3a3";
      const isPlaceholder = node.label === "New node" || !node.label;
      html += '<div class="node-list-row' + (isSelected ? " selected" : "") + (isPlaceholder ? " placeholder" : "") + '" data-node-id="' + escapeHtml(node.id) + '">';
      html +=   '<div class="node-list-swatch" style="background:' + swatchColor + ';"></div>';
      html +=   '<div class="node-list-label">' + escapeHtml(node.label || "(unnamed)") + '</div>';
      html += '</div>';
    }
    html += '</div>';
  }

  container.innerHTML = html;
  if (countEl) countEl.textContent = String(NODES.length);

  container.querySelectorAll(".node-list-row").forEach(row => {
    row.addEventListener("click", () => {
      const id = row.getAttribute("data-node-id");
      if (!nodeById[id]) return;
      selectNode(id);
      if (typeof scrollNodeIntoView === "function") scrollNodeIntoView(id);
    });
  });
}
