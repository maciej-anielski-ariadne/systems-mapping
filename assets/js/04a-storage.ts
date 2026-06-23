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

import { state, nodeById, setLayout } from "./03-state";
import { applyPanelPinnedClasses, applyPanelWidths, applyZoom, applyHighlightDepth } from "./17-events";
import { computeLayout } from "./08-layout";
import { toggleSimulationMode } from "./14-simulation-panel";
import { recomputeValues } from "./07-simulation-engine";
import { renderSidebar } from "./13-sidebar";
import { render } from "./11-rendering";
import { selectNode } from "./09-graph-selection";

export const STORAGE_KEY_CSV     = "systems-map.csv";
export const STORAGE_KEY_UI      = "systems-map.ui";
export const STORAGE_KEY_BUILDER = "systems-map.builder";

// ───── CSV slot ───────────────────────────────────────────────────────────
export function saveCsvToStorage(csv: string | null | undefined): void {
  try { localStorage.setItem(STORAGE_KEY_CSV, csv || ""); } catch (_) {}
}

export function loadCsvFromStorage(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_CSV);
    return raw || null;
  } catch (_) { return null; }
}

export function clearCsvFromStorage(): void {
  try { localStorage.removeItem(STORAGE_KEY_CSV); } catch (_) {}
}

// ───── UI state slot ──────────────────────────────────────────────────────
// Captures only stuff that's meaningful to restore. Things like ancestorSet
// are derived from selectedNodeId via selectNode(), so we don't store them.
export function saveUiStateToStorage(): void {
  try {
    const payload = {
      hiddenStreams:        Array.from(state.hiddenStreams),
      hiddenCategories:     Array.from(state.hiddenCategories),
      hiddenStages:         Array.from(state.hiddenStages),
      hiddenEffects:        Array.from(state.hiddenEffects),
      hiddenStyles:         Array.from(state.hiddenStyles),
      hiddenTrace:          Array.from(state.hiddenTrace),
      simulationMode:       !!state.simulationMode,
      userOverrides:        state.userOverrides || {},
      selectedNodeId:       state.selectedNodeId || null,
      sidebarPinned:        !!state.sidebarPinned,
      detailPanelPinned:    !!state.detailPanelPinned,
      sidebarWidth:         typeof state.sidebarWidth      === "number" ? state.sidebarWidth      : 280,
      detailPanelWidth:     typeof state.detailPanelWidth  === "number" ? state.detailPanelWidth  : 340,
      zoomLevel:            typeof state.zoomLevel === "number" ? state.zoomLevel : 1.0,
      highlightDepth:       typeof state.highlightDepth === "number" ? state.highlightDepth : 1,
    };
    localStorage.setItem(STORAGE_KEY_UI, JSON.stringify(payload));
  } catch (_) {}
}

// Coalesced UI-state save. saveUiStateToStorage does a synchronous
// JSON.stringify of the whole UI payload (including the userOverrides map) plus
// a localStorage write, so firing it on every event of a rapid burst — typing
// in search auto-selects a node per keystroke, wheel/pinch zoom, panel drags —
// is wasteful. These bits of state aren't critical to persist instantly, so we
// "debounce" — wait until the activity goes quiet, then write once (here, after
// 250 ms of no further changes). See "debounce" in docs/GLOSSARY.md. Used by the
// zoom and selection paths.
let _uiSaveTimer: ReturnType<typeof setTimeout> | null = null;
export function scheduleUiStateSave(): void {
  if (_uiSaveTimer) clearTimeout(_uiSaveTimer);
  _uiSaveTimer = setTimeout(() => { _uiSaveTimer = null; saveUiStateToStorage(); }, 250);
}

export function loadUiStateFromStorage(): any {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_UI);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) { return null; }
}

// Apply a restored UI state on top of an already-loaded CSV. Each setter
// triggers its own re-render, so we don't need a separate redraw call.
export function applyRestoredUiState(ui: any): void {
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

  if (typeof ui.sidebarWidth     === "number" && !isNaN(ui.sidebarWidth))     state.sidebarWidth     = ui.sidebarWidth;
  if (typeof ui.detailPanelWidth === "number" && !isNaN(ui.detailPanelWidth)) state.detailPanelWidth = ui.detailPanelWidth;
  if (typeof applyPanelWidths === "function") applyPanelWidths();

  if (typeof ui.zoomLevel === "number" && !isNaN(ui.zoomLevel)) {
    state.zoomLevel = ui.zoomLevel;
    if (typeof applyZoom === "function") applyZoom();
  }

  if (typeof ui.highlightDepth === "number" && !isNaN(ui.highlightDepth)) {
    // Value was already clamped when written (setHighlightDepth), same trust
    // model as zoomLevel above — just restore and reflect it in the readout.
    state.highlightDepth = ui.highlightDepth;
    if (typeof applyHighlightDepth === "function") applyHighlightDepth();
  }

  if (!state.dataLoaded) return;

  state.hiddenStreams    = new Set(Array.isArray(ui.hiddenStreams)    ? ui.hiddenStreams    : []);
  state.hiddenCategories = new Set(Array.isArray(ui.hiddenCategories) ? ui.hiddenCategories : []);
  state.hiddenStages     = new Set(Array.isArray(ui.hiddenStages)     ? ui.hiddenStages     : []);
  state.hiddenEffects    = new Set(Array.isArray(ui.hiddenEffects)    ? ui.hiddenEffects    : []);
  state.hiddenStyles     = new Set(Array.isArray(ui.hiddenStyles)     ? ui.hiddenStyles     : []);
  state.hiddenTrace      = new Set(Array.isArray(ui.hiddenTrace)      ? ui.hiddenTrace      : []);
  state.userOverrides    = (ui.userOverrides && typeof ui.userOverrides === "object") ? ui.userOverrides : {};

  // Hidden streams change row heights and hidden stages change column widths —
  // recompute layout so the map renders with collapsed rows/columns.
  if (state.hiddenStreams.size > 0 || state.hiddenStages.size > 0) setLayout(computeLayout());

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
export function saveBuilderToStorage(): void {
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

export function loadBuilderFromStorage(): any {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_BUILDER);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) { return null; }
}

export function clearBuilderFromStorage(): void {
  try { localStorage.removeItem(STORAGE_KEY_BUILDER); } catch (_) {}
}
