// =============================================================================
// MAIN ENTRY POINT
// -----------------------------------------------------------------------------
// This is the app's single ES-module entry (index.html loads only this file).
//
// The block of side-effect imports below pulls in every module in the original
// numeric load order. That guarantees each module's top-level wiring (event
// listeners, control hookup, etc.) runs in exactly the same order the old
// ordered <script> tags produced — the import graph then dedupes so nothing is
// evaluated twice. After all modules are live it:
//   1. Wires the canvas direct-edit listeners (initCanvasEdit).
//   2. Restores any previously-persisted state from localStorage — the loaded
//      CSV, the UI state (filters, selection, simulation sliders), and any
//      in-progress wizard work — so a page refresh doesn't lose work.
//   3. When there is no saved CSV, boots into an empty 3×3 starter grid via
//      bootEmptyStateGrid(); the user clicks a cell to add their first node.
// =============================================================================

// ───── Side-effect imports (original load order) ────────────────────────────
import "./01-sample-data";
import "./02-config";
import "./03-state";
import "./04-utils";
import "./04a-storage";
import "./04b-typeable-dropdown";
import "./05-csv-parser";
import "./05a-csv-serializer";
import "./06-data-loader";
import "./07-simulation-engine";
import "./08-layout";
import "./09-graph-selection";
import "./10-filters";
import "./10a-collapsed-edges";
import "./11-rendering";
import "./12-tooltip";
import "./13-sidebar";
import "./14-simulation-panel";
import "./15-detail-panel";
import "./16-file-io";
import "./16a-builder-state";
import "./16b-builder-render";
import "./16c-builder-editor";
import "./16d-builder-events";
import "./16e-canvas-edit";
import "./16f-canvas-mutations";
import "./16g-canvas-undo";
import "./16h-canvas-inline-rename";
import "./16i-canvas-keyboard-nav";
import "./16j-multi-select-bar";
import "./17-events";
import "./17a-search";
import "./19-export";

// ───── Named imports for the boot sequence ──────────────────────────────────
import { state } from "./03-state";
import {
  loadCsvFromStorage,
  clearCsvFromStorage,
  loadUiStateFromStorage,
  applyRestoredUiState,
  loadBuilderFromStorage,
} from "./04a-storage";
import { loadDataFromCsv } from "./06-data-loader";
import { renderBuilder } from "./16b-builder-render";
import { initCanvasEdit, bootEmptyStateGrid } from "./16e-canvas-edit";

console.log("Ariadne Maps — canvas-edit ready");
console.log(
  "Click any cell to add a node. Drag from a node's right edge to draw an edge. Press Delete to remove (with undo).",
);

// Tooltips on every element with a data-tooltip attribute (header buttons,
// sidebar rows, SVG row/column labels, …) are handled by a single delegated
// document listener set up in 12-tooltip.ts — no startup wiring needed.

// One-shot wiring for the canvas direct-edit module: mousemove for ghost
// cell tracking, document keydown for Delete / Esc, undo toast element.
initCanvasEdit();

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
  else clearCsvFromStorage();
}
if (!restored) {
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
