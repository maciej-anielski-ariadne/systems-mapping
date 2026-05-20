// =============================================================================
// MAIN ENTRY POINT
// -----------------------------------------------------------------------------
// All other JS modules have been loaded by the time this file runs (it is the
// last <script> tag in index.html). It:
//   1. Wires the canvas direct-edit listeners (initCanvasEdit).
//   2. Restores any previously-persisted state from localStorage — the loaded
//      CSV, the UI state (filters, selection, simulation sliders), and any
//      in-progress wizard work — so a page refresh doesn't lose work.
//   3. When there is no saved CSV, boots into an empty 3×3 starter grid via
//      bootEmptyStateGrid(); the user clicks a cell to add their first node.
// =============================================================================

console.log("Systems Map — canvas-edit ready");
console.log("Click any cell to add a node. Drag from a node's right edge to draw an edge. Press Delete to remove (with undo).");

// Wire tooltips on every element with a data-tooltip attribute (header
// buttons, etc.). Dynamic re-renders that add new tooltipped elements
// (renderSidebar, the SVG render path) call attachTooltip / wireDataTooltips
// themselves, so this only needs to run once at startup.
if (typeof wireDataTooltips === "function") wireDataTooltips();

// One-shot wiring for the canvas direct-edit module: mousemove for ghost
// cell tracking, document keydown for Delete / Esc, undo toast element.
if (typeof initCanvasEdit === "function") initCanvasEdit();

// ───── Restore previous session ──────────────────────────────────────────
// loadDataFromCsv handles its own validation + full re-render. If the saved
// CSV is no longer valid (e.g. someone edited it in DevTools), it returns
// false and we wipe the stored copy so the next refresh doesn't keep retrying.
// When no saved CSV exists, we boot into the empty 3×3 starter grid instead
// of showing the drop-zone overlay — clicking a cell immediately adds a node.
const savedCsv = loadCsvFromStorage();
let restored = false;
if (savedCsv) {
  const ok = loadDataFromCsv(savedCsv);
  if (ok) restored = true;
  else    clearCsvFromStorage();
}
if (!restored && typeof bootEmptyStateGrid === "function") {
  bootEmptyStateGrid();
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
