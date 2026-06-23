// =============================================================================
// EVENT WIRING — connect HTML controls to the right functions
// -----------------------------------------------------------------------------
// One file that grabs every interactive control on the page and attaches its
// click / input / keydown listener. Putting it all in one place makes the
// "how do I make button X do Y?" question easy to answer.
// =============================================================================

import { serializeLiveStateToCsv } from "./05a-csv-serializer";
import { getMapTextScale } from "./04-utils";
import { clearCsvFromStorage, saveUiStateToStorage } from "./04a-storage";
import { refreshNeighborHighlight } from "./09-graph-selection";
import { computeLayout } from "./08-layout";
import { render } from "./11-rendering";
import { toggleSimulationMode } from "./14-simulation-panel";
import { downloadCsvBlob, readCsvFile } from "./16-file-io";
import { closeBuilder, openBuilder } from "./16a-builder-state";
import { bootEmptyStateGrid } from "./16e-canvas-edit";
import { addCategory, addStage, addStream } from "./16f-canvas-mutations";
import { exportCanvasImage, publishCanvasHtml } from "./19-export";
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

// "Save" — downloads the current live state as a CSV.
document.querySelectorAll(".save-data-trigger").forEach(button => {
  button.addEventListener("click", () => {
    if (!state.dataLoaded) return;
    if (typeof serializeLiveStateToCsv !== "function" || typeof downloadCsvBlob !== "function") return;
    downloadCsvBlob(serializeLiveStateToCsv(), "systems_map.csv");
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

// ───── Sidebar / detail-panel pin toggles ───────────────────────────────
// Pinned (default) = panel stays expanded. Unpinned = panel collapses to a
// narrow strip, expands on hover via CSS. Flipping the class on .app is all
// the JS does; CSS owns the visual transitions. State is persisted so the
// pin choice survives a refresh.
export function applyPanelPinnedClasses(): void {
  const app = document.querySelector(".app");
  if (!app) return;
  app.classList.toggle("sidebar-unpinned", !state.sidebarPinned);
  app.classList.toggle("detail-unpinned",  !state.detailPanelPinned);

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
export let _zoomSaveTimer: ReturnType<typeof setTimeout> | null = null;

export function clampZoom(level: number): number {
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level));
}

// Last text-scale we re-laid-out for, so we only re-wrap labels when the scale
// actually changes (zooming within the ≥ TEXT_SCALE_RATIO band leaves it at 1).
let _lastTextScale = getMapTextScale(state.zoomLevel);

export function applyZoom(): void {
  const svgEl    = _vizSvgEl   || document.getElementById("viz-svg");
  const readout  = _zoomReadEl || document.getElementById("viz-zoom-readout");
  const textScale = getMapTextScale(state.zoomLevel);
  if (svgEl && layout && layout.totalWidth) {
    svgEl.setAttribute("width",  String(layout.totalWidth  * state.zoomLevel));
    svgEl.setAttribute("height", String(layout.totalHeight * state.zoomLevel));
    (svgEl as SVGSVGElement).style.setProperty("--map-text-scale", String(textScale));
  }
  if (readout) readout.textContent = Math.round(state.zoomLevel * 100) + "%";

  // When the zoom text-scale changes, labels are wrapped/sized for the old scale,
  // so re-run layout (which re-wraps at the new scale) and redraw — otherwise the
  // enlarged font spills out of the boxes. Skipped while the scale stays put
  // (the common ≥ TEXT_SCALE_RATIO range) so ordinary zooming stays cheap.
  // render() re-applies the zoom-scaled SVG width/height + --map-text-scale itself.
  if (textScale !== _lastTextScale) {
    _lastTextScale = textScale;
    setLayout(computeLayout());
    render();
  }
}

export function scheduleZoomSave(): void {
  if (_zoomSaveTimer) clearTimeout(_zoomSaveTimer);
  _zoomSaveTimer = setTimeout(() => { _zoomSaveTimer = null; saveUiStateToStorage(); }, 250);
}

export function setZoom(level: number): void {
  state.zoomLevel = clampZoom(level);
  applyZoom();
  scheduleZoomSave();
}

// Multiply the current zoom by `factor`, optionally anchored to a viewport
// pixel coordinate so that pinching keeps the point under the cursor still.
export function zoomBy(factor: number, anchorClientX?: number, anchorClientY?: number): void {
  const oldZoom = state.zoomLevel;
  const newZoom = clampZoom(oldZoom * factor);
  if (newZoom === oldZoom) return;

  const vizScrollEl = document.getElementById("viz-scroll");
  if (vizScrollEl && typeof anchorClientX === "number" && typeof anchorClientY === "number") {
    const rect = vizScrollEl.getBoundingClientRect();
    const cursorX = anchorClientX - rect.left;
    const cursorY = anchorClientY - rect.top;
    // Layout-coordinate point under the cursor BEFORE zoom changes.
    const layoutX = (cursorX + vizScrollEl.scrollLeft) / oldZoom;
    const layoutY = (cursorY + vizScrollEl.scrollTop ) / oldZoom;

    state.zoomLevel = newZoom;
    applyZoom();

    // Restore the same layout point under the cursor at the new zoom.
    vizScrollEl.scrollLeft = layoutX * newZoom - cursorX;
    vizScrollEl.scrollTop  = layoutY * newZoom - cursorY;
  } else {
    state.zoomLevel = newZoom;
    applyZoom();
  }
  scheduleZoomSave();
}

export const zoomInButton  = document.getElementById("viz-zoom-in");
export const zoomOutButton = document.getElementById("viz-zoom-out");
export const zoomReadout   = document.getElementById("viz-zoom-readout");
if (zoomInButton)  zoomInButton.addEventListener("click",  () => setZoom(state.zoomLevel + ZOOM_STEP));
if (zoomOutButton) zoomOutButton.addEventListener("click", () => setZoom(state.zoomLevel - ZOOM_STEP));
if (zoomReadout)   zoomReadout.addEventListener("click",   () => setZoom(1.0));

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
    refreshNeighborHighlight();
    render();
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
//     column dividers, row labels).
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
    if ((event.target as Element).closest && (event.target as Element).closest(".node-group, .row-label-group, .ghost-cell, .edge-handle, .edge-hit, .edge-path")) return;
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

// ───── Export ▾ header menu ──────────────────────────────────────────────
// Groups Save / Export / Publish under one trigger. The menu items keep their
// *-trigger classes, so their action handlers (wired above by class) still
// fire; this block only toggles the dropdown open/closed.
(() => {
  const menu    = document.getElementById("export-menu");
  const trigger = menu && menu.querySelector(".header-menu-trigger");
  const list    = document.getElementById("export-menu-list");
  if (!menu || !trigger || !list) return;

  const close = (): void => { list.hidden = true;  trigger.setAttribute("aria-expanded", "false"); };
  const open  = (): void => { list.hidden = false; trigger.setAttribute("aria-expanded", "true");  };

  trigger.addEventListener("click", event => {
    event.stopPropagation();
    list.hidden ? open() : close();
  });
  // Picking an item runs its own action handler and then closes the menu.
  list.querySelectorAll(".header-menu-item").forEach(item =>
    item.addEventListener("click", close)
  );
  // Click outside or press Escape to dismiss.
  document.addEventListener("click", event => { if (!menu.contains(event.target as Node)) close(); });
  document.addEventListener("keydown", event => { if (event.key === "Escape") close(); });
})();

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
