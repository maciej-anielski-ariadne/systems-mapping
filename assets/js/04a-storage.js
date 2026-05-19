// =============================================================================
// STORAGE — persist app state across page refresh
// -----------------------------------------------------------------------------
// Three independent slots in localStorage so we can read / clear them
// individually:
//
//   systems-map.csv      → the last successfully-loaded CSV string
//   systems-map.ui       → hidden filters, simulation mode + slider values,
//                          currently selected node id
//   systems-map.builder  → the wizard's working copy (only while open)
//
// Every save / load is wrapped in try/catch so private-mode browsers, disabled
// storage, and quota errors all fail silently — the app keeps working, just
// without persistence.
// =============================================================================

const STORAGE_KEY_CSV     = "systems-map.csv";
const STORAGE_KEY_UI      = "systems-map.ui";
const STORAGE_KEY_BUILDER = "systems-map.builder";

// ───── CSV slot ───────────────────────────────────────────────────────────
function saveCsvToStorage(csv) {
  try { localStorage.setItem(STORAGE_KEY_CSV, csv || ""); } catch (_) {}
}

function loadCsvFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_CSV);
    return raw || null;
  } catch (_) { return null; }
}

function clearCsvFromStorage() {
  try { localStorage.removeItem(STORAGE_KEY_CSV); } catch (_) {}
}

// ───── UI state slot ──────────────────────────────────────────────────────
// Captures only stuff that's meaningful to restore. Things like ancestorSet
// are derived from selectedNodeId via selectNode(), so we don't store them.
function saveUiStateToStorage() {
  try {
    const payload = {
      hiddenStreams:        Array.from(state.hiddenStreams),
      hiddenCategories:     Array.from(state.hiddenCategories),
      simulationMode:       !!state.simulationMode,
      userOverrides:        state.userOverrides || {},
      selectedNodeId:       state.selectedNodeId || null,
      sidebarPinned:        !!state.sidebarPinned,
      detailPanelPinned:    !!state.detailPanelPinned,
      zoomLevel:            typeof state.zoomLevel === "number" ? state.zoomLevel : 1.0,
    };
    localStorage.setItem(STORAGE_KEY_UI, JSON.stringify(payload));
  } catch (_) {}
}

function loadUiStateFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_UI);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) { return null; }
}

// Apply a restored UI state on top of an already-loaded CSV. Each setter
// triggers its own re-render, so we don't need a separate redraw call.
function applyRestoredUiState(ui) {
  if (!ui) return;

  // Panel pin states + zoom level are independent of the loaded CSV, so
  // apply them even if no data is loaded yet. Defaults to pinned; we also
  // accept the previous `*Collapsed` keys from older sessions and invert.
  if (typeof ui.sidebarPinned === "boolean") {
    state.sidebarPinned = ui.sidebarPinned;
  } else if (typeof ui.sidebarCollapsed === "boolean") {
    state.sidebarPinned = !ui.sidebarCollapsed;
  }
  if (typeof ui.detailPanelPinned === "boolean") {
    state.detailPanelPinned = ui.detailPanelPinned;
  } else if (typeof ui.detailPanelCollapsed === "boolean") {
    state.detailPanelPinned = !ui.detailPanelCollapsed;
  }
  if (typeof applyPanelPinnedClasses === "function") applyPanelPinnedClasses();

  if (typeof ui.zoomLevel === "number" && !isNaN(ui.zoomLevel)) {
    state.zoomLevel = ui.zoomLevel;
    if (typeof applyZoom === "function") applyZoom();
  }

  if (!state.dataLoaded) return;

  state.hiddenStreams    = new Set(Array.isArray(ui.hiddenStreams)    ? ui.hiddenStreams    : []);
  state.hiddenCategories = new Set(Array.isArray(ui.hiddenCategories) ? ui.hiddenCategories : []);
  state.userOverrides    = (ui.userOverrides && typeof ui.userOverrides === "object") ? ui.userOverrides : {};

  // Hidden streams change the row heights — recompute layout so the map
  // renders with collapsed rows where appropriate.
  if (state.hiddenStreams.size > 0) layout = computeLayout();

  // Simulation mode toggle redraws everything that depends on it.
  if (ui.simulationMode && !state.simulationMode) {
    toggleSimulationMode();
  } else {
    // Even without entering sim mode, we may have overrides — recompute so
    // values match the restored sliders, then refresh the sidebar + map.
    recomputeValues();
    renderSidebar();
    render();
  }

  // Selection — only if the saved node still exists in the new CSV.
  if (ui.selectedNodeId && nodeById[ui.selectedNodeId]) {
    selectNode(ui.selectedNodeId);
  }
}

// ───── Builder slot ───────────────────────────────────────────────────────
// Stored only while the wizard is open. On close we remove the key so the
// wizard doesn't auto-reopen on the next refresh.
function saveBuilderToStorage() {
  try {
    if (!state.builder || !state.builder.open) return;
    const b = state.builder;
    localStorage.setItem(STORAGE_KEY_BUILDER, JSON.stringify({
      step:       b.step,
      streams:    b.streams,
      stages:     b.stages,
      categories: b.categories,
      defaults:   b.defaults,
      nodes:      b.nodes,
      edges:      b.edges,
    }));
  } catch (_) {}
}

function loadBuilderFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_BUILDER);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) { return null; }
}

function clearBuilderFromStorage() {
  try { localStorage.removeItem(STORAGE_KEY_BUILDER); } catch (_) {}
}
