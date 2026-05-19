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

  // Newly-rendered rows have data-tooltip; wire them up to the tooltip system.
  if (typeof wireDataTooltips === "function") wireDataTooltips(sidebarEl);
}
