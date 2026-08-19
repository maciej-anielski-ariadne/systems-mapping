// =============================================================================
// EVENT WIRING — connect HTML controls to the right functions
// -----------------------------------------------------------------------------
// One file that grabs every interactive control on the page and attaches its
// click / input / keydown listener. Putting it all in one place makes the
// "how do I make button X do Y?" question easy to answer.
// =============================================================================

import { serializeLiveStateToCsv } from "./05a-csv-serializer";
import { getMapTextScale } from "./04-utils";
import { clearCsvFromStorage, saveUiStateToStorage, scheduleUiStateSave } from "./04a-storage";
import { refreshNeighborHighlight } from "./09-graph-selection";
import { computeLayout } from "./08-layout";
import {
  beginZoomGesture,
  committedZoomLevel,
  endZoomGesture,
  flushScheduledRender,
  maybeRenderForViewport,
  renderSelectionChange,
  scheduleLayoutRender,
  setMapTextScaleVar,
} from "./11-rendering";
import { hideTooltip } from "./12-tooltip";
import { toggleSimulationMode } from "./14-simulation-panel";
import { renderSidebar } from "./13-sidebar";
import { renderDetailPanel } from "./15-detail-panel";
import { downloadCsvBlob, readCsvFile } from "./16-file-io";
import { closeBuilder, openBuilder } from "./16a-builder-state";
import { bootEmptyStateGrid } from "./16e-canvas-edit";
import { addCategory, addStage, addStream } from "./16f-canvas-mutations";
import { exportCanvasImage, getExportSelection, publishCanvasHtml } from "./19-export";
import {
  EDGES,
  NODES,
  layout,
  maxHighlightDepth,
  setLayout,
  state,
} from "./03-state";

// ───── Search box ────────────────────────────────────────────────────────
// The search input is wired up in 17a-search.js (fuzzy + dropdown + map
// highlights). We only keep a reference here for the other handlers in
// this file that check focus / event targets against it.
export const searchInput = document.getElementById("search-input");

// ───── "Simulation" toggle button ────────────────────────────────────────
export const simToggleButton = document.getElementById("sim-toggle-button");
if (simToggleButton) {
  simToggleButton.addEventListener("click", () => {
    if (!state.dataLoaded) return;
    toggleSimulationMode();
  });
}

// ───── File picker (hidden <input type="file">) ──────────────────────────
export const hiddenFileInput = document.getElementById("hidden-file-input") as HTMLInputElement | null;
if (hiddenFileInput) {
  hiddenFileInput.addEventListener("change", event => {
    const file = (event.target as HTMLInputElement).files && (event.target as HTMLInputElement).files![0];
    if (file) readCsvFile(file);
    (event.target as HTMLInputElement).value = "";       // reset so picking the same file twice works
  });
}

// "Import Data" — opens the file picker.
document.querySelectorAll(".import-data-trigger").forEach(button => {
  button.addEventListener("click", () => {
    if (hiddenFileInput) hiddenFileInput.click();
  });
});

// "CSV" — downloads the map as a CSV. With a box selected, its highlighted
// boxes and links; otherwise the whole map (matching the PNG / HTML exports).
// getExportSelection (19-export.js) decides the subset.
document.querySelectorAll(".save-data-trigger").forEach(button => {
  button.addEventListener("click", () => {
    if (!state.dataLoaded) return;
    if (typeof serializeLiveStateToCsv !== "function" || typeof downloadCsvBlob !== "function") return;
    const sel = getExportSelection(true); // allEdges=true: every real edge among the chosen boxes
    const subset = sel.selectionActive
      ? { nodeIds: sel.nodeIds, edgeIds: new Set(sel.edges.map(e => e.id).filter((id): id is string => !!id)) }
      : undefined;
    downloadCsvBlob(serializeLiveStateToCsv(subset), "systems_map.csv");
  });
});

// "Export" — downloads the framed canvas as an image (PNG + SVG). See
// 19-export.js for what gets framed (visible viewport, or the highlighted
// subset when a node is selected) and the compaction.
document.querySelectorAll(".export-image-trigger").forEach(button => {
  button.addEventListener("click", () => {
    if (!state.dataLoaded) return;
    if (typeof exportCanvasImage === "function") exportCanvasImage();
  });
});

// "Publish" — downloads a self-contained, view-only HTML page of the same
// framed canvas (pan / zoom / hover, no editing).
document.querySelectorAll(".publish-html-trigger").forEach(button => {
  button.addEventListener("click", () => {
    if (!state.dataLoaded) return;
    if (typeof publishCanvasHtml === "function") publishCanvasHtml();
  });
});

// "Create Map" — clears the canvas and resets to the empty 3×3 starter grid.
// The user can then build directly on the canvas; for bulk editing they can
// click "Edit Data" afterwards to open the wizard pre-populated with what
// they've drawn. Confirms first when there's existing data to avoid wiping
// work by accident.
document.querySelectorAll(".create-map-trigger").forEach(button => {
  button.addEventListener("click", () => {
    const hasData = state.dataLoaded && (NODES.length > 0 || EDGES.length > 0);
    if (hasData && !confirm("Clear the current map and start with an empty grid? This can't be undone.")) return;
    if (typeof clearCsvFromStorage === "function") clearCsvFromStorage();
    if (typeof bootEmptyStateGrid === "function") bootEmptyStateGrid();
  });
});

// "Edit Data" — opens the form-based wizard pre-populated with the current
// map (live STREAMS / STAGES / CATEGORIES / NODES / EDGES). Useful for bulk
// table-style edits; canvas direct-edit is still available without leaving
// this screen.
document.querySelectorAll(".edit-data-trigger").forEach(button => {
  button.addEventListener("click", () => {
    if (!state.dataLoaded) return;
    openBuilder({ fromLoadedData: true });
  });
});

// Sidebar "+ Add stream / + Add stage / + Add category" buttons. The buttons
// live statically in index.html, so this wires them ONCE at startup. (Wiring
// them inside renderSidebar would stack a fresh listener every render — a
// single click would then add multiple rows.)
document.querySelectorAll(".sidebar-add-btn").forEach(button => {
  button.addEventListener("click", () => {
    const kind = button.getAttribute("data-add");
    if (kind === "stream"   && typeof addStream   === "function") addStream();
    if (kind === "stage"    && typeof addStage    === "function") addStage();
    if (kind === "category" && typeof addCategory === "function") addCategory();
  });
});

// Escape closes the wizard (only when it's open and the user isn't typing
// into the search box — the search input has its own Escape handler above).
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && state.builder && state.builder.open) {
    if (document.activeElement === searchInput) return;
    closeBuilder();
  }
});

// ───── Reading vs editing ────────────────────────────────────────────────
// The app opens in reading mode: no docked left panel, the right panel closed
// until a box is selected, and a header holding only the reading actions. The
// authoring controls — New map, Bulk edit, the sidebar's "+ Add" buttons, the
// keyboard shortcuts that create and delete boxes — appear when you switch to
// editing. Direct canvas editing is already Shift-gated (16e-canvas-edit.ts),
// so reading mode mostly takes chrome away rather than powers.
//
// Everything here is one class on <body> plus one on .app; CSS owns the rest.
export function applyUiMode(): void {
  const reading = state.uiMode !== "edit";
  document.body.classList.toggle("reading", reading);
  document.body.classList.toggle("editing", !reading);

  const app = document.querySelector(".app");
  if (app && reading) app.classList.remove("filters-open");
  if (reading) state.filtersOpen = false;

  const button = document.getElementById("mode-toggle-button");
  if (button) {
    button.textContent = reading ? "Edit" : "Done";
    button.setAttribute(
      "data-tooltip",
      reading ? "Add and change boxes, rows, columns and links." : "Finish editing and go back to reading the map.",
    );
  }

  // Leaving editing closes the per-box edit form with it. Without this the
  // right panel keeps showing a form full of inputs to someone who has just
  // said they are done editing — and keeps showing it until something else
  // happens to re-render.
  if (reading && state.canvasEdit && state.canvasEdit.editMode) {
    state.canvasEdit.editMode = false;
  }

  applyPanelPinnedClasses();
  applySelectionClass();

  // Both panels render mode-dependent controls, so they are redrawn on the
  // switch rather than waiting for the next unrelated render.
  if (state.dataLoaded) {
    if (typeof renderSidebar === "function") renderSidebar();
    if (typeof renderDetailPanel === "function") renderDetailPanel();
  }
}

export function setUiMode(mode: string): void {
  state.uiMode = mode === "edit" ? "edit" : "read";
  applyUiMode();
  saveUiStateToStorage();
}

const modeToggleButton = document.getElementById("mode-toggle-button");
if (modeToggleButton) {
  modeToggleButton.addEventListener("click", () => {
    setUiMode(state.uiMode === "edit" ? "read" : "edit");
  });
}

// ───── The right panel opens on a selection ──────────────────────────────
// In reading mode an empty detail panel is 340px of nothing, so the panel is
// closed until there is something to say. Called from renderDetailPanel.
export function applySelectionClass(): void {
  const app = document.querySelector(".app");
  if (!app) return;
  app.classList.toggle("has-selection", !!state.selectedNodeId);
}

// ───── Filters drawer ────────────────────────────────────────────────────
// In reading mode the left panel is not part of the layout — it slides over the
// map when asked for, and goes away again on Esc, on a click outside it, or on
// a second press of the button. In edit mode it is docked and the button is
// hidden, because that panel is where rows / columns / tags are edited.
export function setFiltersOpen(open: boolean): void {
  const app = document.querySelector(".app");
  if (!app) return;
  state.filtersOpen = !!open && state.uiMode !== "edit";
  app.classList.toggle("filters-open", state.filtersOpen);
  const button = document.getElementById("filters-button");
  if (button) {
    button.classList.toggle("active", state.filtersOpen);
    button.setAttribute("aria-expanded", state.filtersOpen ? "true" : "false");
  }
}

const filtersButton = document.getElementById("filters-button");
if (filtersButton) {
  filtersButton.addEventListener("click", event => {
    event.stopPropagation();
    setFiltersOpen(!state.filtersOpen);
  });
}

// Click anywhere outside the drawer closes it — including on the map, so
// getting back to the picture never needs aim.
document.addEventListener("mousedown", event => {
  if (!state.filtersOpen) return;
  const target = event.target as HTMLElement | null;
  if (!target || !target.closest) return;
  if (target.closest("#sidebar") || target.closest("#filters-button")) return;
  setFiltersOpen(false);
});

// ───── Export menu ───────────────────────────────────────────────────────
// The three exports differ only in the file they hand back, so they sit behind
// one control. Each item keeps its original trigger class, so the handlers
// above bind to them unchanged.
export function setExportMenuOpen(open: boolean): void {
  const menu = document.getElementById("export-menu");
  const button = document.getElementById("export-button");
  if (!menu || !button) return;
  const show = !!open && state.dataLoaded;
  // The button's own hover tooltip would sit on top of the menu it just
  // opened, so it gets out of the way.
  if (show && typeof hideTooltip === "function") hideTooltip();
  menu.hidden = !show;
  button.classList.toggle("active", show);
  button.setAttribute("aria-expanded", show ? "true" : "false");
}

const exportButton = document.getElementById("export-button");
if (exportButton) {
  exportButton.addEventListener("click", event => {
    event.stopPropagation();
    const menu = document.getElementById("export-menu");
    setExportMenuOpen(!menu || menu.hidden);
  });
}

// Any click elsewhere — including on one of the items, which has done its job
// by then — closes the menu.
document.addEventListener("click", event => {
  const menu = document.getElementById("export-menu");
  if (!menu || menu.hidden) return;
  const target = event.target as HTMLElement | null;
  if (target && target.closest && target.closest("#export-button")) return;
  setExportMenuOpen(false);
});

document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  const menu = document.getElementById("export-menu");
  if (menu && !menu.hidden) { setExportMenuOpen(false); return; }
  if (state.filtersOpen) setFiltersOpen(false);
});

// ───── Sidebar / detail-panel pin toggles ───────────────────────────────
// Pinned (default) = panel stays expanded. Unpinned = panel collapses to a
// narrow strip, expands on hover via CSS. Flipping the class on .app is all
// the JS does; CSS owns the visual transitions. State is persisted so the
// pin choice survives a refresh.
export function applyPanelPinnedClasses(): void {
  const app = document.querySelector(".app");
  if (!app) return;
  // Reading mode lays the panels out itself (drawer on the left, open-on-
  // selection on the right), so the pin classes only apply while editing.
  const editing = state.uiMode === "edit";
  app.classList.toggle("sidebar-unpinned", editing && !state.sidebarPinned);
  app.classList.toggle("detail-unpinned",  editing && !state.detailPanelPinned);

  const updatePin = (button: HTMLElement | null, pinned: boolean, kind: string): void => {
    if (!button) return;
    // pinned === true → panel is expanded, so the action is "Collapse".
    const label = button.querySelector(".panel-pin-label");
    const verb  = pinned ? "Collapse" : "Expand";
    if (label) label.textContent = verb;
    button.removeAttribute("title");                 // styled UI only, no native tooltip
    button.setAttribute("aria-label", verb + " " + kind);
  };
  updatePin(document.getElementById("sidebar-pin"), state.sidebarPinned,     "sidebar");
  updatePin(document.getElementById("detail-pin"),  state.detailPanelPinned, "details");
}

export const sidebarPinButton = document.getElementById("sidebar-pin");
if (sidebarPinButton) {
  sidebarPinButton.addEventListener("click", event => {
    event.stopPropagation();
    state.sidebarPinned = !state.sidebarPinned;
    applyPanelPinnedClasses();
    saveUiStateToStorage();
  });
}

export const detailPinButton = document.getElementById("detail-pin");
if (detailPinButton) {
  detailPinButton.addEventListener("click", event => {
    event.stopPropagation();
    state.detailPanelPinned = !state.detailPanelPinned;
    applyPanelPinnedClasses();
    saveUiStateToStorage();
  });
}

// ───── Sidebar / detail-panel resizing ──────────────────────────────────
// Slim drag-handles between each side panel and the central viz let the
// user resize them. The CSS custom properties --sidebar-w-full /
// --detail-w-full on .app drive both the grid track width (pinned mode)
// and the hover-expanded width (unpinned mode); we update them live as
// the user drags. Sizes are persisted via saveUiStateToStorage.
//
// Defaults match the values declared in 03-app-shell.css's .app rule;
// they're duplicated here so a double-click reset has a number to apply
// even if the user has already overridden the CSS value.
export const SIDEBAR_WIDTH_DEFAULT = 280;
export const DETAIL_WIDTH_DEFAULT  = 340;
export const PANEL_WIDTH_MIN       = 180;
export const PANEL_WIDTH_MAX       = 720;

export function clampPanelWidth(w: number): number {
  return Math.max(PANEL_WIDTH_MIN, Math.min(PANEL_WIDTH_MAX, w));
}

export function applyPanelWidths(): void {
  const app = document.querySelector(".app") as HTMLElement | null;
  if (!app) return;
  const sw = (typeof state.sidebarWidth     === "number" && !isNaN(state.sidebarWidth))     ? state.sidebarWidth     : SIDEBAR_WIDTH_DEFAULT;
  const dw = (typeof state.detailPanelWidth === "number" && !isNaN(state.detailPanelWidth)) ? state.detailPanelWidth : DETAIL_WIDTH_DEFAULT;
  app.style.setProperty("--sidebar-w-full", sw + "px");
  app.style.setProperty("--detail-w-full",  dw + "px");
}

export function wirePanelResizer(handle: HTMLElement | null, which: string): void {
  if (!handle) return;
  const defaultWidth = which === "sidebar" ? SIDEBAR_WIDTH_DEFAULT : DETAIL_WIDTH_DEFAULT;
  let dragStart: { x: number; startWidth: number } | null = null;   // { x, startWidth }

  handle.addEventListener("mousedown", event => {
    if (event.button !== 0) return;
    event.preventDefault();
    const currentWidth = which === "sidebar"
      ? (typeof state.sidebarWidth     === "number" ? state.sidebarWidth     : defaultWidth)
      : (typeof state.detailPanelWidth === "number" ? state.detailPanelWidth : defaultWidth);
    dragStart = { x: event.clientX, startWidth: currentWidth };
    handle.classList.add("dragging");
    document.body.classList.add("panel-resizing");
  });

  // Bind move/up on window so the gesture survives the cursor leaving the
  // 6px-wide handle (which it does very quickly during a drag).
  window.addEventListener("mousemove", event => {
    if (!dragStart) return;
    const dx = event.clientX - dragStart.x;
    // Left handle: drag right grows the sidebar. Right handle: drag right
    // SHRINKS the detail panel — invert the delta.
    const signedDx = which === "sidebar" ? dx : -dx;
    const newWidth = clampPanelWidth(dragStart.startWidth + signedDx);
    if (which === "sidebar") state.sidebarWidth     = newWidth;
    else                     state.detailPanelWidth = newWidth;
    applyPanelWidths();
  });

  window.addEventListener("mouseup", () => {
    if (!dragStart) return;
    dragStart = null;
    handle.classList.remove("dragging");
    document.body.classList.remove("panel-resizing");
    saveUiStateToStorage();
  });

  handle.addEventListener("dblclick", () => {
    if (which === "sidebar") state.sidebarWidth     = defaultWidth;
    else                     state.detailPanelWidth = defaultWidth;
    applyPanelWidths();
    saveUiStateToStorage();
  });
}

wirePanelResizer(document.getElementById("sidebar-resize-handle"), "sidebar");
wirePanelResizer(document.getElementById("detail-resize-handle"),  "detail");
applyPanelWidths();

// ───── Map zoom controls ────────────────────────────────────────────────
// Zoom is purely visual: we keep the SVG's viewBox at the original layout
// dimensions and scale the rendered width/height by state.zoomLevel. The
// container's overflow:auto handles the resulting scrollbars naturally.
//
// Two input paths:
//   • Discrete (buttons + keyboard): fixed ZOOM_STEP per click. Uses setZoom().
//   • Continuous (trackpad pinch / wheel): exponential factor proportional to
//     event.deltaY, anchored to the cursor position so the point under the
//     cursor stays put as the user pinches. Uses zoomBy().
//
// localStorage writes are debounced so a one-second pinch (~30 events) only
// saves once at the end instead of 30 times.
export const ZOOM_MIN  = 0.25;
export const ZOOM_MAX  = 3.0;
export const ZOOM_STEP = 0.1;

export const _vizSvgEl   = document.getElementById("viz-svg") as SVGSVGElement | null;
export const _zoomReadEl = document.getElementById("viz-zoom-readout");

export function clampZoom(level: number): number {
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level));
}

// Last text-scale we re-laid-out for, so we only re-wrap labels when the scale
// actually changes (zooming within the ≥ TEXT_SCALE_RATIO band leaves it at 1).
let _lastTextScale = getMapTextScale(state.zoomLevel);

// Write the CURRENT state.zoomLevel into the DOM for real: the SVG's scaled
// width/height, the text-scale custom property, and the readout. This is the
// expensive half of a zoom — the size change forces Chromium to re-rasterize the
// whole vector tree — so during a gesture it runs ONCE, at commit.
function writeZoomToSvg(): void {
  const svgEl   = _vizSvgEl   || document.getElementById("viz-svg");
  const readout = _zoomReadEl || document.getElementById("viz-zoom-readout");
  if (svgEl && layout && layout.totalWidth) {
    svgEl.setAttribute("width",  String(layout.totalWidth  * state.zoomLevel));
    svgEl.setAttribute("height", String(layout.totalHeight * state.zoomLevel));
    // Guarded write (skipped while the value is unchanged) — an unconditional
    // custom-property write here invalidated every text element per wheel event.
    setMapTextScaleVar(svgEl as SVGSVGElement, getMapTextScale(state.zoomLevel));
  }
  updateZoomReadout(readout);
}

function updateZoomReadout(readout?: HTMLElement | null): void {
  const el = readout || _zoomReadEl || document.getElementById("viz-zoom-readout");
  if (el) el.textContent = Math.round(state.zoomLevel * 100) + "%";
}

// The two follow-ups a settled zoom owes: re-wrap labels if the text-scale band
// changed, otherwise refresh the drawn slice if the visible layout area moved.
function afterZoomSettled(): void {
  const textScale = getMapTextScale(state.zoomLevel);
  if (textScale !== _lastTextScale) {
    _lastTextScale = textScale;
    // Both the re-layout (every label re-wrapped at the new scale) and the
    // redraw are deferred to the next animation frame instead of running inside
    // the wheel handler — a wheel burst crosses a band once but fires dozens of
    // events, and a synchronous computeLayout + render on the input path is what
    // made zooming across a band stutter. scheduleLayoutRender owns the
    // recompute, so the render can never draw a stale layout.
    scheduleLayoutRender();
  } else {
    // Zoom that didn't cross a text-scale band still changes which layout-area
    // is visible. On a virtualized map that means the drawn slice may no longer
    // cover the viewport (e.g. zooming out reveals area beyond it), so refresh
    // it on demand. No-op on small maps.
    maybeRenderForViewport();
  }
}

export function applyZoom(): void {
  // A caller outside the gesture machinery (undo restore, UI-state restore) is
  // setting the zoom itself — fold any in-flight gesture back in first so it
  // can't overwrite the size this call is about to write.
  if (committedZoomLevel() !== null) { commitZoomGesture(); return; }
  writeZoomToSvg();
  afterZoomSettled();
}

// Zoom changes fire in rapid bursts (wheel / pinch), so coalesce their persist
// through the shared debounced saver rather than writing on every step.
export function scheduleZoomSave(): void {
  scheduleUiStateSave();
}

// ───── Composite-only zoom gesture ───────────────────────────────────────
// Every step of a zoom used to write the SVG's width/height. That is a layout +
// full re-rasterization of the vector tree, and on a virtualized map it also
// moved the viewport in LAYOUT coordinates — so zooming OUT grew the visible
// layout area past the drawn slice and triggered a full rebuild mid-gesture
// (which is why zooming out stuttered while zooming in, staying inside the
// slice, was smooth). Crossing a text-scale band added a relayout on top.
//
// While the user is still zooming we therefore leave the DOM completely alone
// and carry the whole change on a CSS transform on the SVG: the compositor
// rescales the bitmap it already has, at no raster cost. `state.zoomLevel` is
// the live (pending) zoom and drives the readout; the SVG stays at the
// COMMITTED zoom, which 11-rendering reads via renderZoomLevel().
//
// ~ZOOM_GESTURE_IDLE_MS after the last zoom input — or immediately, if the user
// clicks — the gesture COMMITS: transform off, real width/height on, scroll
// restored so the anchor point hasn't moved, band relayout / slice render if
// needed. At rest the DOM is byte-for-byte what it would have been without any
// of this. During the gesture the map is a scaled bitmap and may look slightly
// soft, exactly as a map app does mid-pinch.

// How long after the last zoom input the gesture settles and commits. Long
// enough that a burst of +/− button clicks (which arrive ~200ms apart) is one
// gesture with one commit rather than one commit per click; short enough that a
// single deliberate step snaps back to crisp vectors almost immediately.
export const ZOOM_GESTURE_IDLE_MS = 220;

// The transform currently on the SVG: screenX = contentX * scale + tx − scrollLeft,
// where contentX is a device pixel of the SVG at the COMMITTED zoom.
let _gestureScale = 1;
let _gestureTx = 0;
let _gestureTy = 0;
let _gestureEndTimer: ReturnType<typeof setTimeout> | 0 = 0;

// The gesture needs a real compositor and a laid-out scroller. jsdom (and any
// environment without them) has neither, so it takes the original synchronous
// path and behaves exactly as before — same guard style as the virtualization.
function zoomGestureCapable(): boolean {
  if (typeof requestAnimationFrame !== "function") return false;
  const svgEl = _vizSvgEl || document.getElementById("viz-svg");
  const sc = document.getElementById("viz-scroll");
  return !!(svgEl && sc && sc.clientWidth > 0 && sc.clientHeight > 0 && layout && layout.totalWidth);
}

function writeGestureTransform(svgEl: HTMLElement | SVGElement): void {
  (svgEl as HTMLElement).style.transform =
    "translate(" + _gestureTx + "px," + _gestureTy + "px) scale(" + _gestureScale + ")";
}

// Fold the gesture back into the DOM: real size, no transform, anchored scroll.
//
// `flushRender` runs any render the commit schedules synchronously, so the
// resize and the redraw share one paint. A commit triggered by a POINTER PRESS
// must NOT do that: a synchronous render replaces every element in the SVG, and
// the click still travelling up from the element under the cursor would then be
// bubbling through a detached tree and select nothing. Those commits leave the
// render on its animation frame, which is a frame later but keeps the DOM the
// press is happening in alive.
export function commitZoomGesture(flushRender = true): void {
  if (committedZoomLevel() === null) return;
  if (_gestureEndTimer) { clearTimeout(_gestureEndTimer); _gestureEndTimer = 0; }

  const svgEl = (_vizSvgEl || document.getElementById("viz-svg")) as HTMLElement | null;
  const sc = document.getElementById("viz-scroll");
  const tx = _gestureTx, ty = _gestureTy;
  // Read the scroll offsets the transform was computed against BEFORE resizing
  // the SVG (a resize can clamp them).
  const scrollLeft = sc ? sc.scrollLeft : 0;
  const scrollTop  = sc ? sc.scrollTop  : 0;

  _gestureScale = 1; _gestureTx = 0; _gestureTy = 0;
  endZoomGesture();          // committed zoom is state.zoomLevel again
  writeZoomToSvg();          // the one real resize of the whole gesture
  if (svgEl) {
    svgEl.style.transform = "";
    svgEl.style.transformOrigin = "";
  }
  // A content pixel sat at (x * scale + tx − scrollLeft) on screen; at the new
  // size the same layout point sits at (x * scale − scrollLeftNew). Equate.
  if (sc) {
    sc.scrollLeft = scrollLeft - tx;
    sc.scrollTop  = scrollTop  - ty;
  }
  afterZoomSettled();
  // The size write above and whatever afterZoomSettled queued (a band relayout,
  // or a fresh slice for the area the new zoom reveals) both repaint the map.
  // Run the render here so they share ONE paint instead of hitching twice.
  if (flushRender) flushScheduledRender();
  scheduleZoomSave();
}

// The single entry point for "the user wants this zoom level", anchored to a
// client-space point (the cursor for wheel/pinch; omitted → the viewport centre,
// which is what the +/− buttons, the keyboard shortcuts and the readout reset
// want). `level` is applied through clampZoom.
function zoomToLevel(level: number, anchorClientX?: number, anchorClientY?: number): void {
  const target = clampZoom(level);
  if (target === state.zoomLevel) return;

  if (!zoomGestureCapable()) {
    // Original synchronous path, unchanged: resize now, re-anchor the scroll.
    const sc = document.getElementById("viz-scroll");
    if (sc && typeof anchorClientX === "number" && typeof anchorClientY === "number") {
      const rect = sc.getBoundingClientRect();
      const cursorX = anchorClientX - rect.left;
      const cursorY = anchorClientY - rect.top;
      const oldZoom = state.zoomLevel;
      const layoutX = (cursorX + sc.scrollLeft) / oldZoom;
      const layoutY = (cursorY + sc.scrollTop ) / oldZoom;
      state.zoomLevel = target;
      applyZoom();
      sc.scrollLeft = layoutX * target - cursorX;
      sc.scrollTop  = layoutY * target - cursorY;
    } else {
      state.zoomLevel = target;
      applyZoom();
    }
    scheduleZoomSave();
    return;
  }

  const sc = document.getElementById("viz-scroll")!;
  const svgEl = (_vizSvgEl || document.getElementById("viz-svg")) as HTMLElement;
  const rect = sc.getBoundingClientRect();
  const anchorX = typeof anchorClientX === "number" ? anchorClientX - rect.left : sc.clientWidth  / 2;
  const anchorY = typeof anchorClientY === "number" ? anchorClientY - rect.top  : sc.clientHeight / 2;

  if (committedZoomLevel() === null) {
    // 11-rendering force-commits through this handle on any press on the map.
    beginZoomGesture(state.zoomLevel, () => commitZoomGesture(false));
    _gestureScale = 1; _gestureTx = 0; _gestureTy = 0;
    svgEl.style.transformOrigin = "0 0";
    // NOTE deliberately no `will-change: transform`. It sounds right — promote
    // the SVG so the compositor rescales a texture — but measured on an
    // 800-box map it makes things WORSE: promoting a map-sized layer is one
    // large raster, demoting it at commit is another, and a burst of +/- clicks
    // pays that pair on every gesture. Without the hint each step is a plain
    // transform write and the whole burst costs one long task.
  }

  state.zoomLevel = target;
  updateZoomReadout();

  const scale = target / committedZoomLevel()!;
  const scrollLeft = sc.scrollLeft, scrollTop = sc.scrollTop;
  // The content point currently under the anchor, in committed-zoom device px.
  const contentX = (anchorX + scrollLeft - _gestureTx) / _gestureScale;
  const contentY = (anchorY + scrollTop  - _gestureTy) / _gestureScale;
  _gestureScale = scale;
  _gestureTx = anchorX + scrollLeft - contentX * scale;
  _gestureTy = anchorY + scrollTop  - contentY * scale;
  writeGestureTransform(svgEl);

  // A transform shrinks (or grows) the scroller's scrollable overflow, so the
  // browser may have clamped scrollLeft/scrollTop under us. Read them back — the
  // read forces the layout that applies the clamp — and absorb any change into
  // the translation, which is unbounded, so the anchor still doesn't move.
  const clampedLeft = sc.scrollLeft, clampedTop = sc.scrollTop;
  if (clampedLeft !== scrollLeft || clampedTop !== scrollTop) {
    _gestureTx = anchorX + clampedLeft - contentX * scale;
    _gestureTy = anchorY + clampedTop  - contentY * scale;
    writeGestureTransform(svgEl);
  }

  if (_gestureEndTimer) clearTimeout(_gestureEndTimer);
  _gestureEndTimer = setTimeout(() => { _gestureEndTimer = 0; commitZoomGesture(); }, ZOOM_GESTURE_IDLE_MS);
  scheduleZoomSave();
}

export function setZoom(level: number): void {
  // A discrete zoom supersedes any wheel/pinch factor still waiting for its
  // frame — otherwise that factor would land on top of the level just set.
  cancelPendingZoom();
  zoomToLevel(level);
}

// Multiply the current zoom by `factor`, optionally anchored to a viewport
// pixel coordinate so that pinching keeps the point under the cursor still.
//
// A trackpad pinch or a wheel spin delivers many events per frame. Each one used
// to resize the SVG and re-anchor the scroll immediately, so all but the last
// were overwritten before the screen ever showed them. The factors are
// multiplied together instead and applied ONCE per frame, anchored to the most
// recent cursor position — the net zoom is identical (zoom composes by
// multiplication) for a fraction of the work. Discrete callers (the +/− buttons,
// keyboard, restore-from-storage) go through setZoom, which stays immediate.
let _pendingZoomFactor = 1;
let _pendingZoomAnchor: { x: number; y: number } | undefined;
let _zoomRAF = 0;
const _zoomRaf: (cb: FrameRequestCallback) => number =
  typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb => setTimeout(() => cb(0), 16) as unknown as number);

function cancelPendingZoom(): void {
  if (_zoomRAF && typeof cancelAnimationFrame === "function") cancelAnimationFrame(_zoomRAF);
  else if (_zoomRAF) clearTimeout(_zoomRAF);
  _zoomRAF = 0;
  _pendingZoomFactor = 1;
  _pendingZoomAnchor = undefined;
}

export function zoomBy(factor: number, anchorClientX?: number, anchorClientY?: number): void {
  _pendingZoomFactor *= factor;
  if (typeof anchorClientX === "number" && typeof anchorClientY === "number") {
    _pendingZoomAnchor = { x: anchorClientX, y: anchorClientY };
  }
  if (_zoomRAF) return;
  _zoomRAF = _zoomRaf(() => {
    _zoomRAF = 0;
    const f = _pendingZoomFactor;
    const anchor = _pendingZoomAnchor;
    _pendingZoomFactor = 1;
    _pendingZoomAnchor = undefined;
    applyZoomBy(f, anchor && anchor.x, anchor && anchor.y);
  });
}

export function applyZoomBy(factor: number, anchorClientX?: number, anchorClientY?: number): void {
  zoomToLevel(state.zoomLevel * factor, anchorClientX, anchorClientY);
}

// ───── Fit the map to the frame ──────────────────────────────────────────
// Fitting shows the whole map at once. It only ever zooms OUT — a twelve-box
// map blown up to fill a widescreen would be a different kind of wrong — so a
// map that already fits is left alone at its own size.
export const FIT_PADDING = 32;
// How far a fit is allowed to shrink the map. Past this, "the whole thing on
// screen" stops being a picture and becomes confetti: a 300-box map fitted to
// a laptop would be 8% and unreadable. On load we stop here and let the map be
// cropped, which at least stays legible. Asking for a fit by hand overrides it
// — you asked for the whole map, so you get the whole map.
export const FIT_MIN_ZOOM = 0.4;

export function fitZoomLevel(): number | null {
  const scroll = document.getElementById("viz-scroll");
  if (!scroll || !layout) return null;
  const mapW = layout.totalWidth, mapH = layout.totalHeight;
  const frameW = scroll.clientWidth, frameH = scroll.clientHeight;
  if (!mapW || !mapH || !frameW || !frameH) return null;
  const fit = Math.min((frameW - FIT_PADDING) / mapW, (frameH - FIT_PADDING) / mapH, 1);
  return clampZoom(fit);
}

export function fitMapToFrame(options: { floor?: boolean } = {}): void {
  const level = fitZoomLevel();
  if (level === null) return;
  setZoom(options.floor ? Math.max(level, FIT_MIN_ZOOM) : level);
}

export const zoomInButton  = document.getElementById("viz-zoom-in");
export const zoomOutButton = document.getElementById("viz-zoom-out");
export const zoomReadout   = document.getElementById("viz-zoom-readout");
if (zoomInButton)  zoomInButton.addEventListener("click",  () => setZoom(state.zoomLevel + ZOOM_STEP));
if (zoomOutButton) zoomOutButton.addEventListener("click", () => setZoom(state.zoomLevel - ZOOM_STEP));
if (zoomReadout)   zoomReadout.addEventListener("click",   () => fitMapToFrame());

// ───── Highlight-depth control ────────────────────────────────────────────
// How many connected levels light up when a node is selected (1 = direct
// neighbours only). The upper bound isn't a fixed constant — it's
// `maxHighlightDepth`, the deepest hop the current map can actually reach
// (cached by rebuildIndexes). Bumping past that lights up nothing new.
export const HIGHLIGHT_DEPTH_MIN = 1;

// Control elements, cached once (also wired for the +/- clicks below).
export const depthReadout    = document.getElementById("viz-depth-readout");
export const depthDownButton = document.getElementById("viz-depth-down") as HTMLButtonElement | null;
export const depthUpButton   = document.getElementById("viz-depth-up") as HTMLButtonElement | null;

// Reflect state.highlightDepth into the on-screen readout, re-clamping to the
// current map's reachable depth and disabling the −/+ buttons at the ends.
// maxHighlightDepth is always >= 1 (initialised to 1, computeMaxHighlightDepth
// never returns less), so it serves as the upper clamp directly.
export function applyHighlightDepth(): void {
  // The map may have shrunk since the depth was last set — pull it back in.
  if (state.highlightDepth > maxHighlightDepth) state.highlightDepth = maxHighlightDepth;
  if (depthReadout)    depthReadout.textContent = String(state.highlightDepth);
  if (depthUpButton)   depthUpButton.disabled   = state.highlightDepth >= maxHighlightDepth;
  if (depthDownButton) depthDownButton.disabled = state.highlightDepth <= HIGHLIGHT_DEPTH_MIN;
}

// Clamp + apply a new highlight depth, re-highlighting the current selection
// live and persisting the choice.
export function setHighlightDepth(level: number): void {
  const clamped = Math.max(HIGHLIGHT_DEPTH_MIN, Math.min(maxHighlightDepth, Math.round(level)));
  if (clamped === state.highlightDepth) return;
  state.highlightDepth = clamped;
  applyHighlightDepth();
  if (state.selectedNodeId) {
    // Depth only changes which nodes/edges are in the trace sets — a selection
    // repaint, not a structural one.
    refreshNeighborHighlight();
    renderSelectionChange();
  }
  saveUiStateToStorage();
}

if (depthDownButton) depthDownButton.addEventListener("click", () => setHighlightDepth(state.highlightDepth - 1));
if (depthUpButton)   depthUpButton.addEventListener("click",   () => setHighlightDepth(state.highlightDepth + 1));
applyHighlightDepth();

// Wheel-to-zoom over the map. Three input paths feed the same handler:
//   • Ctrl/Cmd + wheel (any device)              → zoom
//   • macOS trackpad pinch (synth ctrlKey wheel) → zoom
//   • Plain mouse-wheel (no modifier)            → zoom
// Plain trackpad two-finger scroll stays as panning (the container's default
// scroll behaviour). We distinguish mouse-wheel from trackpad scroll with a
// heuristic on the wheel event: mice emit infrequent, large, integer deltaY
// with no horizontal component (or use deltaMode=LINE/PAGE), while trackpads
// emit frequent small/fractional deltas, often with a deltaX component too.
//
// The zoom factor is exp(-deltaY * sensitivity), which makes zoom
// multiplicative (every unit of input multiplies by the same ratio). For
// mouse wheels we use a smaller sensitivity so a single click of the wheel
// (~100px) is a comfortable step rather than a big jump.
export const ZOOM_WHEEL_SENSITIVITY       = 0.0035;
export const ZOOM_MOUSE_WHEEL_SENSITIVITY = 0.0015;

export function looksLikeMouseWheel(event: WheelEvent): boolean {
  // LINE/PAGE delta modes are typical of mouse wheels in some browsers.
  if (event.deltaMode !== 0) return true;
  // Any horizontal component → trackpad (or horizontal mouse wheel, rare).
  if (event.deltaX !== 0) return false;
  // Pixel mode: mice produce large integer deltas per tick; trackpads
  // produce small or fractional deltas.
  const absY = Math.abs(event.deltaY);
  return absY >= 50 && absY === Math.round(absY);
}

export const vizScroll = document.getElementById("viz-scroll");
if (vizScroll) {
  vizScroll.addEventListener("wheel", event => {
    const modified = event.ctrlKey || event.metaKey;
    const mouseWheel = !modified && looksLikeMouseWheel(event);
    if (!modified && !mouseWheel) return;            // trackpad scroll → pan
    event.preventDefault();
    // event.deltaMode 1 = lines (some mice); convert to a pseudo-pixel
    // delta so the sensitivity constant stays meaningful.
    const deltaY = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    const sensitivity = mouseWheel ? ZOOM_MOUSE_WHEEL_SENSITIVITY : ZOOM_WHEEL_SENSITIVITY;
    const factor = Math.exp(-deltaY * sensitivity);
    zoomBy(factor, event.clientX, event.clientY);
  }, { passive: false });

  // Viewport virtualization: on a large (culled) map, redraw a fresh slice only
  // once the user has scrolled/panned close to the edge of the slice already
  // drawn — NOT on every scroll frame. Between those redraws the browser scrolls
  // the existing (viewport + margin) SVG natively, which is what keeps panning
  // snappy. On small maps maybeRenderForViewport is a no-op (scrolling stays
  // entirely free).
  // `true` = pan-triggered: the rebuild is scheduled into idle time rather than
  // onto the next animation frame (see schedulePanRender in 11-rendering), so it
  // lands between frames instead of stealing one from the pan.
  vizScroll.addEventListener("scroll", () => {
    maybeRenderForViewport(true);
  }, { passive: true });
}

// Keyboard shortcuts: Ctrl/Cmd + =/- to zoom, Ctrl/Cmd + 0 to reset.
document.addEventListener("keydown", event => {
  if (!(event.ctrlKey || event.metaKey)) return;
  if (event.target === searchInput) return;
  // Cell editor / wizard inputs — leave their own behaviour alone.
  if (event.target && (event.target as HTMLElement).matches && (event.target as HTMLElement).matches("input, textarea, select")) return;
  if (event.key === "=" || event.key === "+") { event.preventDefault(); setZoom(state.zoomLevel + ZOOM_STEP); }
  else if (event.key === "-" || event.key === "_") { event.preventDefault(); setZoom(state.zoomLevel - ZOOM_STEP); }
  else if (event.key === "0")                      { event.preventDefault(); setZoom(1.0); }
});

// ───── Map drag-to-pan ──────────────────────────────────────────────────
// Click-and-drag on empty SVG background pans the map by adjusting the
// scrollLeft / scrollTop of #viz-scroll. Two key UX details:
//
//   • A small drag threshold means a still-mouse click still counts as a
//     click — only past the threshold do we lock in "panning" mode and
//     swallow the trailing click (so a pan that happens to end on a node
//     does not also select it).
//   • mousedown directly over a .node-group is ignored — node clicks must
//     still select. The user pans by grabbing empty SVG space (the grid,
//     column dividers, row labels) OR by dragging from an edge (so that
//     dense edge-laden areas don't trap the user). A still-click on an
//     edge still selects it — only a drag past the threshold pans, and the
//     trailing click is swallowed so the pan-end doesn't also select.
//
// mousemove + mouseup are bound to window so the gesture survives the
// cursor leaving the SVG (and even leaving the browser viewport).
export const PAN_DRAG_THRESHOLD = 4;
export const vizScrollEl = document.getElementById("viz-scroll");

if (_vizSvgEl && vizScrollEl) {
  let panStart: { clientX: number; clientY: number; scrollLeft: number; scrollTop: number; dragging: boolean } | null = null;  // { clientX, clientY, scrollLeft, scrollTop, dragging }

  _vizSvgEl.addEventListener("mousedown", event => {
    if (event.button !== 0) return;                            // left button only
    if (event.shiftKey) return;                                // shift+drag = marquee select (16e), not pan
    if ((event.target as Element).closest && (event.target as Element).closest(".node-group, .row-label-group, .ghost-cell, .edge-handle")) return;
    panStart = {
      clientX:    event.clientX,
      clientY:    event.clientY,
      scrollLeft: vizScrollEl.scrollLeft,
      scrollTop:  vizScrollEl.scrollTop,
      dragging:   false,
    };
  });

  window.addEventListener("mousemove", event => {
    if (!panStart) return;
    const dx = event.clientX - panStart.clientX;
    const dy = event.clientY - panStart.clientY;
    if (!panStart.dragging) {
      if (Math.abs(dx) < PAN_DRAG_THRESHOLD && Math.abs(dy) < PAN_DRAG_THRESHOLD) return;
      panStart.dragging = true;
      document.body.classList.add("panning");
    }
    vizScrollEl.scrollLeft = panStart.scrollLeft - dx;
    vizScrollEl.scrollTop  = panStart.scrollTop  - dy;
  });

  window.addEventListener("mouseup", () => {
    if (!panStart) return;
    const wasDragging = panStart.dragging;
    panStart = null;
    if (wasDragging) {
      document.body.classList.remove("panning");
      // Swallow the click that follows this mouseup so a pan that ends on
      // a node does not also select / deselect.
      const swallow = (e: Event): void => { e.stopPropagation(); e.preventDefault(); };
      window.addEventListener("click", swallow, { capture: true, once: true });
      // …but only THAT click. A pan doesn't always produce one — the pointer
      // can end up outside the map, or over an element the browser won't fire a
      // click on — and an armed one-shot swallower then waits, eating whatever
      // the user clicks next: a header button that inexplicably needs pressing
      // twice. The gesture's own click is dispatched before any timeout runs,
      // so disarming on the next task keeps the guard and drops the trap.
      setTimeout(() => window.removeEventListener("click", swallow, true), 0);
    }
  });
}

// ───── Drag-and-drop a CSV onto the whole window ─────────────────────────
window.addEventListener("dragover", event => {
  if (event.dataTransfer && Array.from(event.dataTransfer.types).includes("Files")) {
    event.preventDefault();
    document.body.classList.add("drag-active");
  }
});

window.addEventListener("dragleave", event => {
  // Only remove the highlight when the cursor actually leaves the window.
  if (event.target === document.body || event.target === document.documentElement || !event.relatedTarget) {
    document.body.classList.remove("drag-active");
  }
});

window.addEventListener("drop", event => {
  event.preventDefault();
  document.body.classList.remove("drag-active");
  const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
  if (file) readCsvFile(file);
});

// ───── Sidebar "Map appearance" accordion ────────────────────────────────
// Collapses the advanced edge-type / line-style / trace filters into one group.
(() => {
  const acc    = document.getElementById("map-appearance");
  const toggle = document.getElementById("map-appearance-toggle");
  if (!acc || !toggle) return;
  toggle.addEventListener("click", () => {
    const collapsed = acc.classList.toggle("collapsed");
    toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  });
})();
