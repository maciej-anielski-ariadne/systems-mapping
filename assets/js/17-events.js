// =============================================================================
// EVENT WIRING — connect HTML controls to the right functions
// -----------------------------------------------------------------------------
// One file that grabs every interactive control on the page and attaches its
// click / input / keydown listener. Putting it all in one place makes the
// "how do I make button X do Y?" question easy to answer.
// =============================================================================

// ───── Search box ────────────────────────────────────────────────────────
// The search input is wired up in 17a-search.js (fuzzy + dropdown + map
// highlights). We only keep a reference here for the other handlers in
// this file that need to reset the box (e.g. the Reset View button below).
const searchInput = document.getElementById("search-input");

// ───── "Reset" button in the header ──────────────────────────────────────
// Clears filters, simulation overrides, selection, and any search state.
document.getElementById("reset-button").addEventListener("click", () => {
  if (!state.dataLoaded) return;
  state.hiddenStreams.clear();
  state.hiddenCategories.clear();
  state.userOverrides = {};
  if (typeof clearSearch === "function") clearSearch();
  deselectNode();
  recomputeValues();
  renderSidebar();
  render();
  saveUiStateToStorage();
});

// ───── "Simulation" toggle button ────────────────────────────────────────
const simToggleButton = document.getElementById("sim-toggle-button");
if (simToggleButton) {
  simToggleButton.addEventListener("click", () => {
    if (!state.dataLoaded) return;
    toggleSimulationMode();
  });
}

// ───── File picker (hidden <input type="file">) ──────────────────────────
const hiddenFileInput = document.getElementById("hidden-file-input");
if (hiddenFileInput) {
  hiddenFileInput.addEventListener("change", event => {
    const file = event.target.files && event.target.files[0];
    if (file) readCsvFile(file);
    event.target.value = "";       // reset so picking the same file twice works
  });
}

// Any button with class "load-csv-trigger" opens the file picker.
document.querySelectorAll(".load-csv-trigger").forEach(button => {
  button.addEventListener("click", () => {
    if (hiddenFileInput) hiddenFileInput.click();
  });
});

// Any button with class "load-sample-trigger" loads the embedded sample CSV.
document.querySelectorAll(".load-sample-trigger").forEach(button => {
  button.addEventListener("click", loadEmbeddedSample);
});

// Any button with class "download-sample-trigger" downloads the sample CSV.
document.querySelectorAll(".download-sample-trigger").forEach(button => {
  button.addEventListener("click", downloadSampleCsv);
});

// "Build map" opens the wizard with a blank slate — applying a build
// replaces whatever is currently loaded.
document.querySelectorAll(".build-map-trigger").forEach(button => {
  button.addEventListener("click", () => openBuilder({ fromLoadedData: false }));
});

// "Edit map" opens the wizard pre-populated with the live map. No-op (with
// the disabled visual styling from CSS) when no map has been loaded yet.
document.querySelectorAll(".edit-map-trigger").forEach(button => {
  button.addEventListener("click", () => {
    if (!state.dataLoaded) return;
    openBuilder({ fromLoadedData: true });
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
function applyPanelPinnedClasses() {
  const app = document.querySelector(".app");
  if (!app) return;
  app.classList.toggle("sidebar-unpinned", !state.sidebarPinned);
  app.classList.toggle("detail-unpinned",  !state.detailPanelPinned);

  const updatePin = (button, pinned, kind) => {
    if (!button) return;
    const label = button.querySelector(".panel-pin-label");
    const text  = pinned ? "Click here to unpin" : "Click here to pin";
    if (label) label.textContent = text;
    button.title = text + " " + kind;
    button.setAttribute("aria-label", text + " " + kind);
  };
  updatePin(document.getElementById("sidebar-pin"), state.sidebarPinned,     "sidebar");
  updatePin(document.getElementById("detail-pin"),  state.detailPanelPinned, "details");
}

const sidebarPinButton = document.getElementById("sidebar-pin");
if (sidebarPinButton) {
  sidebarPinButton.addEventListener("click", event => {
    event.stopPropagation();
    state.sidebarPinned = !state.sidebarPinned;
    applyPanelPinnedClasses();
    saveUiStateToStorage();
  });
}

const detailPinButton = document.getElementById("detail-pin");
if (detailPinButton) {
  detailPinButton.addEventListener("click", event => {
    event.stopPropagation();
    state.detailPanelPinned = !state.detailPanelPinned;
    applyPanelPinnedClasses();
    saveUiStateToStorage();
  });
}

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
const ZOOM_MIN  = 0.25;
const ZOOM_MAX  = 3.0;
const ZOOM_STEP = 0.1;

const _vizSvgEl   = document.getElementById("viz-svg");
const _zoomReadEl = document.getElementById("viz-zoom-readout");
let _zoomSaveTimer = null;

function clampZoom(level) {
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level));
}

function applyZoom() {
  const svgEl    = _vizSvgEl   || document.getElementById("viz-svg");
  const readout  = _zoomReadEl || document.getElementById("viz-zoom-readout");
  if (svgEl && layout && layout.totalWidth) {
    svgEl.setAttribute("width",  layout.totalWidth  * state.zoomLevel);
    svgEl.setAttribute("height", layout.totalHeight * state.zoomLevel);
    svgEl.style.setProperty("--map-text-scale", getMapTextScale(state.zoomLevel));
  }
  if (readout) readout.textContent = Math.round(state.zoomLevel * 100) + "%";
}

function scheduleZoomSave() {
  if (_zoomSaveTimer) clearTimeout(_zoomSaveTimer);
  _zoomSaveTimer = setTimeout(() => { _zoomSaveTimer = null; saveUiStateToStorage(); }, 250);
}

function setZoom(level) {
  state.zoomLevel = clampZoom(level);
  applyZoom();
  scheduleZoomSave();
}

// Multiply the current zoom by `factor`, optionally anchored to a viewport
// pixel coordinate so that pinching keeps the point under the cursor still.
function zoomBy(factor, anchorClientX, anchorClientY) {
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

const zoomInButton  = document.getElementById("viz-zoom-in");
const zoomOutButton = document.getElementById("viz-zoom-out");
const zoomReadout   = document.getElementById("viz-zoom-readout");
if (zoomInButton)  zoomInButton.addEventListener("click",  () => setZoom(state.zoomLevel + ZOOM_STEP));
if (zoomOutButton) zoomOutButton.addEventListener("click", () => setZoom(state.zoomLevel - ZOOM_STEP));
if (zoomReadout)   zoomReadout.addEventListener("click",   () => setZoom(1.0));

// Ctrl/Cmd + wheel zooms over the map. (Plain wheel keeps the default
// behaviour: panning the viz-scroll container.) macOS trackpad pinch is
// already delivered as a wheel event with ctrlKey synthesised by the
// browser, so the same path handles both pinch and mouse-wheel zoom.
//
// The factor is exp(-deltaY * sensitivity), which makes zoom multiplicative
// (every unit of input multiplies by the same ratio). Trackpads send many
// small-deltaY events per gesture, mice send fewer large-deltaY events;
// the exponential mapping keeps both feeling smooth and proportional.
const ZOOM_WHEEL_SENSITIVITY = 0.0035;
const vizScroll = document.getElementById("viz-scroll");
if (vizScroll) {
  vizScroll.addEventListener("wheel", event => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    // event.deltaMode 1 = lines (some mice); convert to a pseudo-pixel
    // delta so the sensitivity constant stays meaningful.
    const deltaY = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    const factor = Math.exp(-deltaY * ZOOM_WHEEL_SENSITIVITY);
    zoomBy(factor, event.clientX, event.clientY);
  }, { passive: false });
}

// Keyboard shortcuts: Ctrl/Cmd + =/- to zoom, Ctrl/Cmd + 0 to reset.
document.addEventListener("keydown", event => {
  if (!(event.ctrlKey || event.metaKey)) return;
  if (event.target === searchInput) return;
  // Cell editor / wizard inputs — leave their own behaviour alone.
  if (event.target && event.target.matches && event.target.matches("input, textarea, select")) return;
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
const PAN_DRAG_THRESHOLD = 4;
const vizScrollEl = document.getElementById("viz-scroll");

if (_vizSvgEl && vizScrollEl) {
  let panStart = null;  // { clientX, clientY, scrollLeft, scrollTop, dragging }

  _vizSvgEl.addEventListener("mousedown", event => {
    if (event.button !== 0) return;                            // left button only
    if (event.target.closest && event.target.closest(".node-group")) return;
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
      const swallow = e => { e.stopPropagation(); e.preventDefault(); };
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
