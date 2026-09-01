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
import { LINEAR_CSV } from "./fixtures/graphs";
import { renderSidebar } from "../assets/js/13-sidebar";
import { renderDetailPanel } from "../assets/js/15-detail-panel";
import { NODES, state } from "../assets/js/03-state";
import { deselectAll, refreshTraceForSelection, selectNode } from "../assets/js/09-graph-selection";
import { initCanvasEdit, setShiftHeld } from "../assets/js/16e-canvas-edit";
import { toggleSimulationMode } from "../assets/js/14-simulation-panel";
import { applyRestoredUiState, saveUiStateToStorage, loadUiStateFromStorage } from "../assets/js/04a-storage";
import {
  FIT_MIN_ZOOM,
  applySelectionClass,
  applyUiMode,
  fitMapToFrame,
  fitZoomLevel,
  setFileMenuOpen,
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

describe("the file menu", () => {
  it("keeps document actions in File and closes on the next click", () => {
    loadDataFromCsv(sampleCsv);
    const menu = document.getElementById("file-menu") as HTMLElement;
    expect(menu.querySelectorAll(".menu-item").length).toBe(5);
    for (const trigger of [
      ".import-data-trigger",        // Import
      ".save-data-trigger",          // Spreadsheet
      ".export-review-log-trigger",  // Review log
      ".export-image-trigger",       // Image
      ".publish-html-trigger",       // Web page
    ]) {
      expect(menu.querySelector(trigger), trigger + " should live in the File menu").not.toBeNull();
    }

    setFileMenuOpen(true);
    expect(menu.hidden).toBe(false);
    document.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(menu.hidden).toBe(true);
  });

  it("surfaces map-wide authoring actions in the Edit toolbar", () => {
    const menu = document.getElementById("file-menu") as HTMLElement;
    const editActions = document.getElementById("toolbar-edit-actions") as HTMLElement;
    expect(menu.querySelector(".create-map-trigger")).toBeNull();
    expect(menu.querySelector(".edit-data-trigger")).toBeNull();
    expect(editActions.querySelector(".create-map-trigger")?.textContent).toBe("New map");
    expect(editActions.querySelector(".edit-data-trigger")?.textContent).toBe("Bulk edit");
  });

  it("has nothing to offer before a map is loaded", () => {
    state.dataLoaded = false;
    setFileMenuOpen(true);
    expect((document.getElementById("file-menu") as HTMLElement).hidden).toBe(true);
    state.dataLoaded = true;
  });
});

describe("the header is grouped, not evenly spaced", () => {
  it("puts every action inside a group and keeps no dividers", () => {
    const header = document.querySelector(".app-header") as HTMLElement;
    expect(header.querySelectorAll(".header-divider").length).toBe(0);
    // Brand, search, and then only groups — nothing loose in the row.
    const loose = [...header.children].filter(
      (el) => !el.classList.contains("header-group") &&
              !el.classList.contains("app-brand") &&
              !el.classList.contains("search-wrap"),
    );
    expect(loose).toEqual([]);
  });

  it("hides the whole Filters group while editing, not just its button", () => {
    // The group carries the id because a group holding one hidden button still
    // takes its share of the row's gap.
    expect(document.getElementById("filters-group")).not.toBeNull();
    expect(document.getElementById("filters-button")!.closest(".header-group")!.id)
      .toBe("filters-group");
  });
});

describe("contextual modes", () => {
  it("never leaves Edit and Simulate active together", () => {
    loadDataFromCsv(sampleCsv);
    setUiMode("edit");
    expect(state.uiMode).toBe("edit");

    toggleSimulationMode();
    expect(state.simulationMode).toBe(true);
    expect(state.uiMode).toBe("read");

    setUiMode("edit");
    expect(state.uiMode).toBe("edit");
    expect(state.simulationMode).toBe(false);
  });

  it("puts simulation's exit in the stable right-hand action group", () => {
    loadDataFromCsv(sampleCsv);
    if (!state.simulationMode) toggleSimulationMode();
    (document.getElementById("simulation-exit-button") as HTMLButtonElement).click();
    expect(state.simulationMode).toBe(false);
  });
});

describe("who is reviewing survives a refresh", () => {
  it("goes into the UI slot and comes back out of it", () => {
    // Not with the map: it is a fact about whoever is at this keyboard, and the
    // same person whichever file they open. Without it, a refresh mid-pass
    // emptied the name field — and a pass will not restart until a full name is
    // back in it, so the reviewer had to type theirs again to carry on.
    state.reviewer = "Ann Lee";
    saveUiStateToStorage();
    expect(loadUiStateFromStorage().reviewer).toBe("Ann Lee");

    state.reviewer = "";
    applyRestoredUiState(loadUiStateFromStorage());
    expect(state.reviewer).toBe("Ann Lee");
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

  it("answers the question first: what drives it, and what it drives, above the numbers", () => {
    loadDataFromCsv(sampleCsv);
    selectNode(NODES[0].id);
    renderDetailPanel();

    const titles = [...panel().querySelectorAll(".detail-list-title")].map(el => el.textContent || "");
    // "Driven by" / "Drives", not "Causes" / "Effects": read as verbs the old
    // pair described what the box does TO others, which is the opposite of what
    // the first list holds.
    expect(titles[0]).toContain("Driven by");
    expect(titles[1]).toContain("Drives");

    const html = panel().innerHTML;
    const quant = html.indexOf("detail-quant-block");
    expect(quant).toBeGreaterThan(html.indexOf("Drives"));
  });

  it("offers no way to edit the box until you are editing", () => {
    loadDataFromCsv(sampleCsv);
    selectNode(NODES[0].id);
    renderDetailPanel();
    expect(panel().querySelector(".detail-edit-input")).toBeNull();

    // ...and once you are, the fields are simply there. There is no second,
    // per-box "Edit box" switch to find first — being in edit mode IS the
    // answer, and it used to have to be given again for every box selected.
    setUiMode("edit");
    renderDetailPanel();
    expect(panel().querySelector(".detail-edit-input")).not.toBeNull();
    expect(panel().querySelector("[data-action='toggle-edit-mode']")).toBeNull();
  });
});

describe("the drawer", () => {
  it("shows the link and highlight filters, unfolded", () => {
    // They were behind a disclosure most readers never opened. As chips each
    // group costs a single line, which is less than the disclosure asking about
    // them did.
    expect(document.querySelector("#sidebar details.sidebar-fold")).toBeNull();
    for (const id of ["#edge-type-filters", "#edge-style-filters", "#trace-filters"]) {
      expect(document.querySelector("#sidebar " + id)).not.toBeNull();
    }
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

describe("editing controls belong to editing", () => {
  it("closes the per-box form when you say you are done", () => {
    loadDataFromCsv(sampleCsv);
    setUiMode("edit");
    selectNode(NODES[0].id);
    state.canvasEdit.editMode = true;
    renderDetailPanel();
    expect(document.querySelectorAll("#detail-content input").length).toBeGreaterThan(0);

    setUiMode("read");
    expect(state.canvasEdit.editMode).toBe(false);
    expect(document.querySelectorAll("#detail-content input").length).toBe(0);
  });

  it("never arms Shift while reading — it is the editing key", () => {
    setUiMode("read");
    setShiftHeld(true);
    expect(state.canvasEdit.shiftHeld).toBe(false);

    setUiMode("edit");
    setShiftHeld(true);
    expect(state.canvasEdit.shiftHeld).toBe(true);
    setShiftHeld(false);
    setUiMode("read");
  });

  it("keeps the colour dot while reading — it is the key, not just a picker", () => {
    const css = readFileSync(resolve(here, "../assets/css/03-app-shell.css"), "utf8");
    const hidden = css.slice(css.indexOf("body.reading .edit-only,"));
    const rule = hidden.slice(0, hidden.indexOf("}"));
    expect(rule, "the dot is what says which colour a row paints — hiding it loses the key").not.toContain("sidebar-dot");
    expect(css).toMatch(/body\.reading \.sidebar-dot\s*\{[^}]*pointer-events:\s*none/);
  });
});

describe("simulation brings its own panel out", () => {
  it("docks the left panel instead of leaving it in a drawer", () => {
    loadDataFromCsv(sampleCsv);
    setUiMode("read");
    setFiltersOpen(true);

    toggleSimulationMode();
    expect(document.body.classList.contains("sim-mode")).toBe(true);
    // The docking is CSS keyed off body.sim-mode; what matters here is that no
    // half-open drawer is left sitting over the map.
    expect(state.filtersOpen).toBe(false);
    expect(document.getElementById("simulation-panel")!.style.display).toBe("block");

    toggleSimulationMode();
    expect(document.body.classList.contains("sim-mode")).toBe(false);
  });
});

// =============================================================================
// A LINK IS ONE LINE
// -----------------------------------------------------------------------------
// It used to be three — name and strength, the effect word beneath them, then
// the link's own sentence — so a box with six links spent eighteen lines saying
// what six rows say. The sentence and the word move to the tooltip; the row
// keeps what the maths uses, in the column every other number lands in.
// =============================================================================
describe("a link row in the box panel", () => {
  const rows = () => [...document.querySelectorAll("#detail-content .drow")] as HTMLElement[];

  it("is one row per link, with the strength in the number column", () => {
    loadDataFromCsv(LINEAR_CSV);
    selectNode("b");
    renderDetailPanel();

    expect(rows().length).toBeGreaterThan(0);
    for (const row of rows()) {
      expect(row.querySelector(".drow-name")).not.toBeNull();
      expect(row.querySelector(".drow-num")!.textContent).toMatch(/^[+−]?\d+\.\d\d$/);
      // Nothing left of the three-line shape.
      expect(row.querySelector(".detail-edge-desc")).toBeNull();
      expect(row.querySelector(".detail-edge-effect")).toBeNull();
    }
  });

  it("carries the kind and the sentence on hover, not on the row", () => {
    loadDataFromCsv(LINEAR_CSV);
    selectNode("b");
    renderDetailPanel();
    const tip = rows()[0].getAttribute("data-tooltip") || "";
    expect(tip).toMatch(/increases|decreases|enables/);
    expect(rows()[0].textContent).not.toMatch(/increases|decreases|enables/);
  });

  it("stays a button that jumps to the box it names", () => {
    loadDataFromCsv(LINEAR_CSV);
    selectNode("b");
    renderDetailPanel();
    const row = rows()[0];
    expect(row.tagName.toLowerCase()).toBe("button");
    expect(row.getAttribute("data-target-node")).toBeTruthy();
    expect(row.getAttribute("aria-label")).toContain("Jump to it");
  });
});

// =============================================================================
// THE TAGS ARE A KEY, NOT A LIST
// -----------------------------------------------------------------------------
// Reading the map, the tag sections say which colour means what and how many
// boxes carry it — that is a legend, and a legend is a wrap of chips. Editing
// it, the same tags are rows, because renaming, recolouring, reordering and
// deleting each need somewhere to put a control.
// =============================================================================
describe("tag filters, by mode", () => {
  const chips = () => document.querySelectorAll("#category-filters .filter-chip");
  const rows  = () => document.querySelectorAll("#category-filters .sidebar-edit-row");

  beforeEach(() => {
    loadDataFromCsv(LINEAR_CSV);
    renderSidebar();
  });
  afterEach(() => setUiMode("read"));

  it("draws them as chips while reading", () => {
    setUiMode("read");
    expect(chips().length).toBeGreaterThan(0);
    expect(rows()).toHaveLength(0);
    // A chip carries its colour, its name and its count.
    const chip = chips()[0];
    expect(chip.querySelector("i")).not.toBeNull();
    expect(chip.querySelector(".filter-chip-label")!.textContent).toBeTruthy();
  });

  it("draws them as editable rows while editing", () => {
    setUiMode("edit");
    expect(rows().length).toBeGreaterThan(0);
    expect(chips()).toHaveLength(0);
    // The controls a chip has nowhere to put.
    expect(rows()[0].querySelector("[data-action='delete']")).not.toBeNull();
  });

  it("gives no section a shown/total count", () => {
    setUiMode("read");
    for (const title of document.querySelectorAll("#sidebar .sidebar-section-title")) {
      expect(title.querySelector(".count")).toBeNull();
      expect(title.textContent).not.toMatch(/\d+\s*\/\s*\d+/);
    }
  });
});

describe("how much of the map is lit decides how the rest is treated", () => {
  // Dimming to 0.18 is right for one box and its direct links, and stops working
  // once the trace is most of the map. The switch is on breadth, not on mode —
  // and the highlight-depth control already reaches it, so this is not a case
  // that only a future feature could produce.
  const lit = () => document.body.classList.contains("focus-wide");

  beforeEach(() => {
    loadDataFromCsv(sampleCsv);
    state.highlightDepth = 1;
  });

  it("leaves the ordinary case alone — one box and its neighbours stays a fade", () => {
    selectNode(NODES[0].id);
    expect(lit()).toBe(false);
  });

  it("switches once the trace passes a quarter of the map", () => {
    // Reach far enough that the trace covers most of a 12-box sample.
    state.highlightDepth = 8;
    const widest = NODES
      .map((n) => {
        refreshTraceForSelection();
        selectNode(n.id);
        return { id: n.id, lit: lit() };
      })
      .filter((r) => r.lit);
    expect(widest.length).toBeGreaterThan(0);
  });

  it("clears when the selection goes away", () => {
    state.highlightDepth = 8;
    for (const n of NODES) { selectNode(n.id); if (lit()) break; }
    deselectAll();
    expect(lit()).toBe(false);
  });
});
