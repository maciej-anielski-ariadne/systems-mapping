// =============================================================================
// THE SHELL — reading mode, the filters drawer, and the export menu
// -----------------------------------------------------------------------------
// The app opens on the map with the chrome out of the way: no docked left
// panel, no right panel until something is selected, and only the reading
// actions in the header. Editing is a mode you switch into. These tests pin
// that down at the level the CSS keys off — the classes on <body> and .app —
// plus the two behaviours that have no CSS to fall back on: reading mode
// refusing to create or delete, and the mode surviving a refresh.
// =============================================================================
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import { renderDetailPanel } from "../assets/js/15-detail-panel";
import { NODES, state } from "../assets/js/03-state";
import { selectNode, deselectAll } from "../assets/js/09-graph-selection";
import { initCanvasEdit } from "../assets/js/16e-canvas-edit";
import { saveUiStateToStorage, loadUiStateFromStorage } from "../assets/js/04a-storage";
import {
  FIT_MIN_ZOOM,
  applySelectionClass,
  applyUiMode,
  fitMapToFrame,
  fitZoomLevel,
  setExportMenuOpen,
  setFiltersOpen,
  setUiMode,
} from "../assets/js/17-events";

const here = dirname(fileURLToPath(import.meta.url));
const sampleCsv = readFileSync(resolve(here, "../assets/data/sample.csv"), "utf-8");

const app = (): HTMLElement => document.querySelector(".app") as HTMLElement;

beforeEach(() => {
  state.uiMode = "read";
  state.filtersOpen = false;
  applyUiMode();
});

describe("the app opens on the map", () => {
  it("starts in reading mode", () => {
    expect(document.body.classList.contains("reading")).toBe(true);
    expect(document.body.classList.contains("editing")).toBe(false);
  });

  it("offers the way in to editing, and the way back out", () => {
    const button = document.getElementById("mode-toggle-button")!;
    expect(button.textContent).toBe("Edit");
    setUiMode("edit");
    expect(document.body.classList.contains("editing")).toBe(true);
    expect(button.textContent).toBe("Done");
    setUiMode("read");
    expect(button.textContent).toBe("Edit");
  });

  it("keeps the pin classes for editing, where the panels are docked", () => {
    state.sidebarPinned = false;
    applyUiMode();
    // Reading lays the panels out itself, so an old pin choice can't leave a
    // stray strip over the map.
    expect(app().classList.contains("sidebar-unpinned")).toBe(false);
    setUiMode("edit");
    expect(app().classList.contains("sidebar-unpinned")).toBe(true);
    state.sidebarPinned = true;
  });

  it("comes back in the mode you left in", () => {
    setUiMode("edit");
    saveUiStateToStorage();
    expect(loadUiStateFromStorage().uiMode).toBe("edit");
  });
});

describe("the right panel opens on a selection", () => {
  it("is closed with nothing selected and open with something", () => {
    loadDataFromCsv(sampleCsv);
    deselectAll();
    applySelectionClass();
    expect(app().classList.contains("has-selection")).toBe(false);

    selectNode(NODES[0].id);
    expect(app().classList.contains("has-selection")).toBe(true);

    deselectAll();
    applySelectionClass();
    expect(app().classList.contains("has-selection")).toBe(false);
  });
});

describe("the filters drawer", () => {
  it("opens, and Escape sends it back", () => {
    setFiltersOpen(true);
    expect(app().classList.contains("filters-open")).toBe(true);
    expect(document.getElementById("filters-button")!.getAttribute("aria-expanded")).toBe("true");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(app().classList.contains("filters-open")).toBe(false);
  });

  it("stays shut while editing — that panel is docked", () => {
    setUiMode("edit");
    setFiltersOpen(true);
    expect(state.filtersOpen).toBe(false);
    expect(app().classList.contains("filters-open")).toBe(false);
  });
});

describe("the export menu", () => {
  it("holds the three exports and closes on the next click", () => {
    loadDataFromCsv(sampleCsv);
    const menu = document.getElementById("export-menu") as HTMLElement;
    expect(menu.querySelectorAll(".menu-item").length).toBe(3);
    expect(menu.querySelector(".save-data-trigger")).not.toBeNull();
    expect(menu.querySelector(".export-image-trigger")).not.toBeNull();
    expect(menu.querySelector(".publish-html-trigger")).not.toBeNull();

    setExportMenuOpen(true);
    expect(menu.hidden).toBe(false);
    document.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(menu.hidden).toBe(true);
  });

  it("has nothing to offer before a map is loaded", () => {
    state.dataLoaded = false;
    setExportMenuOpen(true);
    expect((document.getElementById("export-menu") as HTMLElement).hidden).toBe(true);
    state.dataLoaded = true;
  });
});

describe("reading never changes the map", () => {
  it("ignores the keys that create and delete boxes, and obeys them while editing", () => {
    // The canvas keyboard model lives on a document listener wired at boot.
    initCanvasEdit();
    loadDataFromCsv(sampleCsv);
    const before = NODES.length;
    const first = NODES[0];
    selectNode(first.id);

    // Delete removes the selected box — editing, so in reading mode, nothing.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    expect(NODES.length).toBe(before);

    // Same box, same key, one class on <body> apart.
    setUiMode("edit");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    expect(NODES.length).toBe(before - 1);
  });
});

describe("what a reader gets when they select a box", () => {
  const panel = (): HTMLElement => document.getElementById("detail-content") as HTMLElement;

  it("answers the question first: causes and effects above the numbers", () => {
    loadDataFromCsv(sampleCsv);
    selectNode(NODES[0].id);
    renderDetailPanel();

    const titles = [...panel().querySelectorAll(".detail-list-title")].map(el => el.textContent || "");
    expect(titles[0]).toContain("Causes");
    expect(titles[1]).toContain("Effects");

    const html = panel().innerHTML;
    const quant = html.indexOf("detail-quant-block");
    expect(quant).toBeGreaterThan(html.indexOf("Effects"));
  });

  it("folds the strand list away behind its own count", () => {
    loadDataFromCsv(sampleCsv);
    selectNode(NODES[0].id);
    renderDetailPanel();

    const fold = panel().querySelector("details.detail-fold");
    expect(fold).not.toBeNull();
    expect((fold as HTMLDetailsElement).open).toBe(false);
    expect(fold!.querySelector("summary")!.textContent).toContain("Strands through this box");
    // Folded, not dropped — the routes are there the moment it opens.
    expect(fold!.querySelectorAll(".pathway-route").length).toBeGreaterThan(0);
  });

  it("offers no way to edit the box until you are editing", () => {
    loadDataFromCsv(sampleCsv);
    selectNode(NODES[0].id);
    renderDetailPanel();
    expect(panel().querySelector("[data-action='toggle-edit-mode']")).toBeNull();

    setUiMode("edit");
    renderDetailPanel();
    expect(panel().querySelector("[data-action='toggle-edit-mode']")).not.toBeNull();
  });
});

describe("the drawer", () => {
  it("keeps the link and highlight filters, folded", () => {
    const fold = document.querySelector("#sidebar details.sidebar-fold") as HTMLDetailsElement;
    expect(fold).not.toBeNull();
    expect(fold.open).toBe(false);
    expect(fold.querySelector("#edge-type-filters")).not.toBeNull();
    expect(fold.querySelector("#edge-style-filters")).not.toBeNull();
    expect(fold.querySelector("#trace-filters")).not.toBeNull();
  });
});

// jsdom lays nothing out, so the frame has to be told how big it is.
function frameOf(width: number, height: number): void {
  const scroll = document.getElementById("viz-scroll")!;
  Object.defineProperty(scroll, "clientWidth",  { value: width,  configurable: true });
  Object.defineProperty(scroll, "clientHeight", { value: height, configurable: true });
}

describe("opening zoom", () => {
  it("leaves a map that already fits at its own size", () => {
    loadDataFromCsv(sampleCsv);
    frameOf(4000, 3000);
    expect(fitZoomLevel()).toBe(1);
  });

  it("zooms out for a map that doesn't fit", () => {
    loadDataFromCsv(sampleCsv);
    frameOf(600, 400);
    const fit = fitZoomLevel()!;
    expect(fit).toBeLessThan(1);
    expect(fit).toBeGreaterThan(0);
  });

  it("stops shrinking at the floor on load — cropped beats unreadable", () => {
    loadDataFromCsv(sampleCsv);
    frameOf(120, 90);                       // absurdly small: the true fit is tiny
    expect(fitZoomLevel()!).toBeLessThan(FIT_MIN_ZOOM);

    fitMapToFrame({ floor: true });
    expect(state.zoomLevel).toBe(FIT_MIN_ZOOM);
  });

  it("ignores the floor when the fit was asked for by hand", () => {
    loadDataFromCsv(sampleCsv);
    frameOf(120, 90);
    fitMapToFrame();                        // the zoom readout: show me all of it
    expect(state.zoomLevel).toBeLessThan(FIT_MIN_ZOOM);
  });

  it("does nothing when the frame hasn't been laid out yet", () => {
    loadDataFromCsv(sampleCsv);
    frameOf(0, 0);
    expect(fitZoomLevel()).toBeNull();
  });
});

describe("the map scrolls at every zoom", () => {
  // A previous version centred the SVG with flex + `margin: auto`, which makes
  // an overflowing item unreachable at its leading edge: zooming in produced a
  // bigger map you could not scroll to. CSS can't be measured in jsdom, so this
  // guards the rule itself.
  it("does not centre the map by auto margins", () => {
    const css = readFileSync(resolve(here, "../assets/css/05-visualization.css"), "utf8");
    const scrollRule = css.slice(css.indexOf(".viz-scroll {"), css.indexOf("}", css.indexOf(".viz-scroll {")));
    expect(scrollRule, ".viz-scroll must not be a flex container — it breaks scrolling when zoomed").not.toMatch(/display:\s*flex/);
    const svgRule = css.slice(css.indexOf(".viz-svg {"), css.indexOf("}", css.indexOf(".viz-svg {")));
    expect(svgRule, ".viz-svg must not use auto margins — the map is anchored top-left").not.toMatch(/margin:\s*auto/);
  });
});
