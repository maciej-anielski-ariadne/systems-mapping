// =============================================================================
// MAIN ENTRY POINT
// -----------------------------------------------------------------------------
// All other JS modules have been loaded by the time this file runs (it is the
// last <script> tag in index.html). It:
//   1. Shows the drop-zone overlay (it will be hidden again by loadDataFromCsv
//      if we have a saved CSV to restore).
//   2. Restores any previously-persisted state from localStorage — the loaded
//      CSV, the UI state (filters, selection, simulation sliders), and any
//      in-progress wizard work — so a page refresh doesn't lose work.
// =============================================================================

showDropZone();
console.log("Systems Map — awaiting CSV input");
console.log("Drag a CSV onto the window, click 'Load sample' for the bundled example, or click 'Build map' to start from scratch.");

// Wire tooltips on every element with a data-tooltip attribute (header
// buttons, etc.). Dynamic re-renders that add new tooltipped elements
// (renderSidebar, the SVG render path) call attachTooltip / wireDataTooltips
// themselves, so this only needs to run once at startup.
if (typeof wireDataTooltips === "function") wireDataTooltips();

// ───── Restore previous session ──────────────────────────────────────────
// loadDataFromCsv handles its own validation + full re-render. If the saved
// CSV is no longer valid (e.g. someone edited it in DevTools), it returns
// false and we wipe the stored copy so the next refresh doesn't keep retrying.
const savedCsv = loadCsvFromStorage();
if (savedCsv) {
  const ok = loadDataFromCsv(savedCsv);
  if (!ok) clearCsvFromStorage();
}

// UI state — panel collapse is independent of the CSV; everything else is
// applied only if a map is actually loaded (applyRestoredUiState handles
// the data-dependent vs. independent split internally).
const ui = loadUiStateFromStorage();
if (ui) applyRestoredUiState(ui);

// The wizard's working copy is independent of the CSV. If the user was
// mid-build when they refreshed, re-open the wizard at the same step with
// the same rows.
const savedBuilder = loadBuilderFromStorage();
if (savedBuilder) {
  Object.assign(state.builder, savedBuilder, { open: true });
  renderBuilder();
}
