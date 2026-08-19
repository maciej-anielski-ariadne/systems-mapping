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
import { applyPanelWidths, applyUiMode, applyZoom, applyHighlightDepth } from "./17-events";
import { computeLayout } from "./08-layout";
import { toggleSimulationMode } from "./14-simulation-panel";
import { recomputeValues } from "./07-simulation-engine";
import { renderSidebar } from "./13-sidebar";
import { render } from "./11-rendering";
import { selectNode } from "./09-graph-selection";

export const STORAGE_KEY_CSV     = "systems-map.csv";
export const STORAGE_KEY_UI      = "systems-map.ui";
export const STORAGE_KEY_BUILDER = "systems-map.builder";

// ───── Quota-failure surfacing ────────────────────────────────────────────
// localStorage tops out around 5 MB per origin; a very large map (or the
// wizard's working copy of one) can exceed that, and swallowing the
// QuotaExceededError silently meant the user's map just stopped surviving a
// refresh with no warning. Surface it once per session — the toast helper
// lives in 16-file-io, which sits above this module in the import graph, so
// it's called through a lazy guard.
let _quotaWarned = false;
function warnStorageQuota(): void {
  if (_quotaWarned) return;
  _quotaWarned = true;
  import("./16-file-io")
    .then((io) => {
      if (typeof io.showLoadFeedback === "function") {
        io.showLoadFeedback(
          "This map is too large for the browser's auto-save — download the CSV to keep your work.",
          true,
        );
      }
    })
    .catch(() => {});
  console.warn("localStorage write failed (likely quota) — auto-save disabled for this map.");
}

// ───── CSV slot ───────────────────────────────────────────────────────────
export function saveCsvToStorage(csv: string | null | undefined): boolean {
  try {
    localStorage.setItem(STORAGE_KEY_CSV, csv || "");
    return true;
  } catch (_) {
    warnStorageQuota();
    return false;
  }
}

// Coalesced CSV save. Every canvas edit funnels through applyCanvasMutation,
// which used to serialize + write the WHOLE map synchronously per edit —
// a multi-megabyte localStorage write per keystroke-scale interaction on a
// large map. The write is best-effort persistence (the live state and the
// undo snapshot stay exact), so it's safe to wait for a quiet moment; the
// pending write is flushed on tab hide / close below so a normal navigation
// away never loses it.
const CSV_SAVE_DEBOUNCE_MS = 600;
let _csvSaveTimer: ReturnType<typeof setTimeout> | null = null;
let _pendingCsv: string | null = null;
export function scheduleCsvSave(csv: string): void {
  _pendingCsv = csv;
  if (_csvSaveTimer) clearTimeout(_csvSaveTimer);
  _csvSaveTimer = setTimeout(() => {
    _csvSaveTimer = null;
    if (_pendingCsv !== null) { saveCsvToStorage(_pendingCsv); _pendingCsv = null; }
  }, CSV_SAVE_DEBOUNCE_MS);
}

// Write any debounced state out immediately (tab hidden / closing, or a code
// path that must observe the write, e.g. right before clearing a slot).
export function flushPendingSaves(): void {
  if (_csvSaveTimer) { clearTimeout(_csvSaveTimer); _csvSaveTimer = null; }
  if (_pendingCsv !== null) { saveCsvToStorage(_pendingCsv); _pendingCsv = null; }
  if (_builderSaveTimer) { clearTimeout(_builderSaveTimer); _builderSaveTimer = null; saveBuilderToStorage(); }
  if (_uiSaveTimer) { clearTimeout(_uiSaveTimer); _uiSaveTimer = null; saveUiStateToStorage(); }
}

// `pagehide` covers normal closes/navigations; `visibilitychange → hidden`
// additionally covers mobile tab switches where pagehide may never fire.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushPendingSaves);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPendingSaves();
  });
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
      uiMode:               state.uiMode === "edit" ? "edit" : "read",
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
  // Reading vs editing comes back first — the pin classes below are applied
  // through it.
  if (ui.uiMode === "edit" || ui.uiMode === "read") state.uiMode = ui.uiMode;

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
  if (typeof applyUiMode === "function") applyUiMode();

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
// Coalesced builder save. The wizard used to JSON.stringify its ENTIRE
// working copy (all seven sections) and write it synchronously on every
// keystroke — on a large map that's a 100 ms+ stall per character. The slot
// is a crash-recovery convenience, so a trailing debounce loses at most the
// last moments of typing; flushPendingSaves() above writes it out on tab hide.
const BUILDER_SAVE_DEBOUNCE_MS = 600;
let _builderSaveTimer: ReturnType<typeof setTimeout> | null = null;
export function scheduleBuilderSave(): void {
  if (_builderSaveTimer) clearTimeout(_builderSaveTimer);
  _builderSaveTimer = setTimeout(() => {
    _builderSaveTimer = null;
    saveBuilderToStorage();
  }, BUILDER_SAVE_DEBOUNCE_MS);
}

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
      // The map's hidden calculation constants (the wizard's Constants step).
      // Saved so a refresh mid-build doesn't change what an apply would do —
      // and note that an OLDER saved snapshot has no `params` key at all,
      // which the serializer reads as "keep the live map's constants".
      params:     b.params,
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
  // Cancel any debounced write first — a save landing AFTER the clear would
  // resurrect the wizard slot and make it auto-reopen on the next refresh.
  if (_builderSaveTimer) { clearTimeout(_builderSaveTimer); _builderSaveTimer = null; }
  try { localStorage.removeItem(STORAGE_KEY_BUILDER); } catch (_) {}
}
