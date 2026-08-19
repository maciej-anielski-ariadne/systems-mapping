import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import { toggleCategory } from "../assets/js/10-filters";
import { renderOverlay } from "../assets/js/11-rendering";
import { NODES, EDGES, PARAMS, nodeById, state } from "../assets/js/03-state";
import { loadBuilderFromStorage, flushPendingSaves } from "../assets/js/04a-storage";
import { serializeBuilderToCsv } from "../assets/js/05a-csv-serializer";
import {
  BUILDER_LAST_STEP,
  BUILDER_STEPS,
  closeBuilder,
  openBuilder,
  validateBuilder,
} from "../assets/js/16a-builder-state";
import { renderBuilder } from "../assets/js/16b-builder-render";
import { PARAMS_CSV } from "./fixtures/graphs";

const here = dirname(fileURLToPath(import.meta.url));
const sampleCsv = readFileSync(resolve(here, "../assets/data/sample.csv"), "utf-8");

describe("end-to-end: load the shipped sample.csv and render", () => {
  it("loads without fatal errors", () => {
    expect(loadDataFromCsv(sampleCsv)).toBe(true);
    expect(NODES.length).toBeGreaterThan(0);
    expect(EDGES.length).toBeGreaterThan(0);
    expect(state.dataLoaded).toBe(true);
  });

  it("draws one .node-group per node into the SVG", () => {
    loadDataFromCsv(sampleCsv);
    const groups = document.querySelectorAll(".node-group");
    expect(groups.length).toBe(NODES.length);
  });

  it("populates the sidebar row/column lists", () => {
    loadDataFromCsv(sampleCsv);
    expect(document.querySelector("#stages-list")?.children.length).toBeGreaterThan(0);
    expect(document.querySelector("#stream-filters")?.children.length).toBeGreaterThan(0);
  });

  it("computes simulation values for every quantified node", () => {
    loadDataFromCsv(sampleCsv);
    const quantified = NODES.filter((n) => n.baseline !== undefined);
    for (const n of quantified) {
      expect(Number.isFinite(state.computedValues[n.id])).toBe(true);
    }
  });

  it("selects a node via the delegated SVG click handler", () => {
    loadDataFromCsv(sampleCsv);
    const svg = document.getElementById("viz-svg")!;
    const group = svg.querySelector(".node-group") as Element;
    const nodeId = group.getAttribute("data-node-id")!;

    // Click bubbles up to the single delegated listener on #viz-svg.
    group.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(state.selectedNodeId).toBe(nodeId);
    // render() ran synchronously inside selectNode → the re-drawn group carries
    // the selection class.
    expect(
      svg.querySelector('.node-group[data-node-id="' + nodeId + '"]')!.classList.contains("selected"),
    ).toBe(true);

    // Clicking the empty background deselects.
    svg.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(state.selectedNodeId).toBe(null);
  });

  it("invalidates the edge-geometry cache when a category is toggled", () => {
    loadDataFromCsv(sampleCsv);
    const svg = document.getElementById("viz-svg")!;
    const before = svg.querySelectorAll(".node-group").length;

    // Pick a category that actually has nodes, then count how many boxes it
    // takes OFF the map: hiding a tag only strips its colour, so a box goes
    // only when that tag was its last visible one (see isNodeVisible).
    const someNode = NODES.find((n) => n.category)!;
    const catId = someNode.category!;
    const dropped = NODES.filter((n) => {
      const ids = n.categoryIds && n.categoryIds.length ? n.categoryIds : n.category ? [n.category] : [];
      return ids.length > 0 && ids.every((id) => id === catId);
    }).length;
    expect(dropped).toBeGreaterThan(0);

    // toggleCategory hides the category and re-renders. Category hiding does NOT
    // call setLayout, so this is exactly the path the cache keys on its hidden
    // sets to catch — a stale cache would keep drawing the hidden nodes.
    toggleCategory(catId);
    expect(svg.querySelectorAll(".node-group").length).toBe(before - dropped);

    // Toggling it back restores them (cache invalidates the other direction too).
    toggleCategory(catId);
    expect(svg.querySelectorAll(".node-group").length).toBe(before);
  });

  it("renders static + overlay layers and updates the overlay in isolation", () => {
    loadDataFromCsv(sampleCsv);
    const svg = document.getElementById("viz-svg")!;
    const staticLayer = svg.querySelector(".ml-static-layer")!;
    const overlayLayer = svg.querySelector(".ml-overlay-layer")!;
    expect(staticLayer).toBeTruthy();
    expect(overlayLayer).toBeTruthy();

    // Nodes live in the static layer; the overlay is empty with no transient state.
    expect(staticLayer.querySelectorAll(".node-group").length).toBe(NODES.length);
    expect(overlayLayer.querySelector(".ghost-cell")).toBe(null);

    // Grab a stable reference to a node element so we can prove the overlay-only
    // update never re-parses the static DOM.
    const someNode = NODES[0];
    const nodeEl = staticLayer.querySelector(
      '.node-group[data-node-id="' + someNode.id + '"]',
    )!;

    // Park a hover "+ add box" ghost in a real cell, then update ONLY the overlay.
    state.canvasEdit.hoverCell = { streamId: someNode.stream, stageId: someNode.stage, insertIndex: 0 };
    renderOverlay();

    // The ghost now exists in the overlay…
    expect(overlayLayer.querySelector(".ghost-cell")).toBeTruthy();
    // …and the static node element is the very same DOM node (not rebuilt).
    expect(
      staticLayer.querySelector('.node-group[data-node-id="' + someNode.id + '"]'),
    ).toBe(nodeEl);

    state.canvasEdit.hoverCell = null;
  });
});

// =============================================================================
// BUILD / EDIT WIZARD — the Constants step and the per-box calculation columns
// -----------------------------------------------------------------------------
// The wizard is the only way to reach the calculation model without hand-editing
// a CSV, so these tests drive it the way a user does: render a step, poke the
// real inputs, and follow the data all the way out through
// serializeBuilderToCsv → loadDataFromCsv into the live map. PARAMS_CSV is the
// fixture that exercises every new column at once (two constants, a formula box,
// a min/max box and an `additive` box).
// =============================================================================
describe("build/edit wizard — constants step and calculation columns", () => {
  const overlay = () => document.getElementById("builder-overlay")!;

  // One editable cell, by the data-* triple every wizard input carries.
  const cell = (section: string, field: string, index: number) =>
    overlay().querySelector(
      '[data-section="' + section + '"][data-field="' + field + '"][data-index="' + index + '"]',
    ) as HTMLInputElement;

  // Type into a cell the way the browser does — the wizard listens for both
  // events on the overlay (input for text/number, change for dropdowns).
  function type(el: HTMLInputElement | HTMLSelectElement, value: string): void {
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  const click = (el: Element | null) => (el as HTMLElement).click();
  const nextButton = () => document.getElementById("builder-next-button") as HTMLButtonElement;

  // Open the wizard on the live map, then jump straight to `step`.
  function openAt(step: number): void {
    openBuilder({ fromLoadedData: true });
    state.builder.step = step;
    renderBuilder();
  }

  beforeEach(() => {
    expect(loadDataFromCsv(PARAMS_CSV)).toBe(true);
  });

  afterEach(() => {
    closeBuilder();
  });

  it("has seven steps, with Constants sitting between Links and Review", () => {
    expect(BUILDER_STEPS.map((s) => s.key)).toEqual([
      "streams", "stages", "categories", "nodes", "edges", "params", "review",
    ]);
    expect(BUILDER_LAST_STEP).toBe(7);

    openAt(1);
    expect(overlay().querySelectorAll(".builder-step-dot").length).toBe(7);
  });

  it("walks Links → Constants → Review and stops at the last step", () => {
    openAt(5);
    click(nextButton());
    expect(state.builder.step).toBe(6);
    expect(overlay().querySelector(".builder-step-heading")!.textContent).toMatch(/Constants/);

    click(nextButton());
    expect(state.builder.step).toBe(7);
    expect(nextButton().disabled).toBe(true);
    // The Review summary counts the constants alongside everything else.
    expect(overlay().querySelector(".builder-review-grid")!.textContent).toMatch(/Constants/);
    const tiles = Array.from(overlay().querySelectorAll(".builder-review-tile"));
    const constants = tiles.find((t) => t.textContent!.includes("Constants"))!;
    expect(constants.querySelector(".builder-review-tile-value")!.textContent).toBe("2");
  });

  it("renders one row per constant and writes cell edits back into the builder", () => {
    openAt(6);
    const ids = overlay().querySelectorAll('input[data-section="params"][data-field="id"]');
    expect(ids.length).toBe(2);
    expect((ids[0] as HTMLInputElement).value).toBe("share_air");
    expect(cell("params", "description", 1).value).toMatch(/Probability an examined item/);

    type(cell("params", "value", 0), "0.5");
    expect(state.builder.params![0].value).toBe(0.5);

    type(cell("params", "description", 1), "Revised detection rate");
    expect(state.builder.params![1].description).toBe("Revised detection rate");

    // Typing schedules a debounced write of the wizard's localStorage
    // snapshot (per-keystroke synchronous writes stalled large maps); the
    // pending write is flushed on tab hide / close, which flushPendingSaves
    // simulates here — after it, a refresh mid-build restores this edit.
    flushPendingSaves();
    expect(loadBuilderFromStorage().params[0].value).toBe(0.5);
  });

  it("adds, duplicates and deletes constant rows like every other step", () => {
    openAt(6);
    click(overlay().querySelector('[data-add="params"]'));
    expect(state.builder.params!.length).toBe(3);
    expect(state.builder.params![2]).toEqual({ id: "", value: "", description: "" });

    // Duplicate clones the row with its id wiped (ids must stay unique).
    click(overlay().querySelector('[data-duplicate="params"][data-index="0"]'));
    expect(state.builder.params!.length).toBe(4);
    expect(state.builder.params![1].id).toBe("");
    expect(state.builder.params![1].value).toBe(0.35);

    click(overlay().querySelector('[data-delete="params"][data-index="1"]'));
    click(overlay().querySelector('[data-delete="params"][data-index="2"]'));
    expect(state.builder.params!.map((p) => p.id)).toEqual(["share_air", "detection_rate"]);
  });

  it("bulk-selects constant rows and deletes them together", () => {
    openAt(6);
    click(overlay().querySelector('[data-selectall="params"]'));
    expect(state.builder.selected.size).toBe(2);
    click(overlay().querySelector('[data-bulkdelete="params"]'));
    expect(state.builder.params).toEqual([]);
    expect(state.builder.selected.size).toBe(0);
  });

  it("hints when a constant id collides with a box id, or its value isn't a number", () => {
    openAt(6);
    // `demand` is a box in this map — a formula naming it could then mean
    // either thing, so the loader would drop the constant on apply.
    type(cell("params", "id", 0), "demand");
    type(cell("params", "value", 1), "");
    renderBuilder();

    const v = validateBuilder();
    expect(v.clashParams.has("demand")).toBe(true);
    expect(v.badParamValueRows.has(1)).toBe(true);
    expect(v.errors.join(" | ")).toMatch(/same id as a box/);
    expect(v.errors.join(" | ")).toMatch(/needs a numeric value/);

    expect(cell("params", "id", 0).classList.contains("invalid")).toBe(true);
    expect(cell("params", "value", 1).classList.contains("invalid")).toBe(true);
  });

  it("edits combine / formula / min / max on the Boxes table and round-trips them", () => {
    openAt(4);
    const idx = (nodeId: string) => state.builder.nodes.findIndex((n) => n.id === nodeId);

    // `combine` is a dropdown like `direction`. upgradeSelectsIn() wraps it in
    // the typeable widget but keeps the native <select> (and its data-* attrs)
    // in the DOM, which is what every read/write path still uses.
    const combine = cell("nodes", "combine", idx("total")) as unknown as HTMLSelectElement;
    expect(combine.tagName).toBe("SELECT");
    expect(combine.value).toBe("additive");
    type(combine, "min");

    type(cell("nodes", "formula", idx("served")), "min(demand, capacity)");
    type(cell("nodes", "minValue", idx("capacity")), "5");
    type(cell("nodes", "maxValue", idx("capacity")), "150");

    expect(state.builder.nodes[idx("total")].combine).toBe("min");
    expect(state.builder.nodes[idx("capacity")].minValue).toBe(5);

    // Out through the CSV and back into the live map's GraphNode fields.
    expect(loadDataFromCsv(serializeBuilderToCsv(state.builder))).toBe(true);
    expect(nodeById.total.combine).toBe("min");
    expect(nodeById.served.formula).toBe("min(demand, capacity)");
    expect(nodeById.capacity.minValue).toBe(5);
    expect(nodeById.capacity.maxValue).toBe(150);
  });

  it("sorts the Boxes table by a calculation column without touching row order", () => {
    openAt(4);
    const header = overlay().querySelector('[data-sort="nodes"][data-sortkey="combine"]')!;
    click(header);
    expect(state.builder.sort.nodes).toEqual({ key: "combine", dir: "asc" });
    // View-only: the underlying array (and therefore the exported CSV) is
    // untouched — only the on-screen order changes.
    expect(state.builder.nodes.map((n) => n.id)).toEqual(["demand", "capacity", "served", "total"]);
    // The one box with a combine rule sorts to the top; blanks always last.
    const shownIds = Array.from(
      overlay().querySelectorAll('input[data-section="nodes"][data-field="id"]'),
    ).map((el) => (el as HTMLInputElement).value);
    expect(shownIds[0]).toBe("total");
  });

  it("bulk-sets a combine rule on the selected boxes", () => {
    openAt(4);
    click(overlay().querySelector('[data-selectall="nodes"]'));
    const bulk = overlay().querySelector(
      'select[data-bulksection="nodes"][data-bulkfield="combine"]',
    ) as HTMLSelectElement;
    type(bulk, "additive");
    expect(state.builder.nodes.every((n) => n.combine === "additive")).toBe(true);
  });

  it("applies constants + a formula onto the live map and the engine honours them", () => {
    openAt(6);
    click(overlay().querySelector('[data-add="params"]'));
    type(cell("params", "id", 2), "uplift");
    type(cell("params", "value", 2), "1.5");
    type(cell("params", "description", 2), "Planned uplift factor");

    // `served` already has links from demand and capacity, so a formula naming
    // demand is consistent with the arrows on the map.
    state.builder.step = 4;
    renderBuilder();
    const served = state.builder.nodes.findIndex((n) => n.id === "served");
    type(cell("nodes", "formula", served), "demand * uplift");

    click(document.getElementById("builder-apply-button"));

    expect(state.builder.open).toBe(false);
    expect(PARAMS.map((p) => p.id)).toEqual(["share_air", "detection_rate", "uplift"]);
    expect(nodeById.served.formula).toBe("demand * uplift");
    // demand sits at its starting value of 100, so served = 100 × 1.5.
    expect(state.computedValues.served).toBe(150);
    expect(state.explanations.served.rule).toBe("formula");
    expect(state.explanations.served.inputs.map((i) => i.id)).toContain("uplift");
  });

  it("keeps the map's constants when the wizard never visits the Constants step", () => {
    openBuilder({ fromLoadedData: true });
    state.builder.step = 4;
    renderBuilder();
    type(cell("nodes", "label", 0), "Demand renamed");

    expect(loadDataFromCsv(serializeBuilderToCsv(state.builder))).toBe(true);
    expect(nodeById.demand.label).toBe("Demand renamed");
    expect(PARAMS.map((p) => p.id)).toEqual(["share_air", "detection_rate"]);
  });

  it("falls back to the live constants for a snapshot saved before the step existed", () => {
    openBuilder({ fromLoadedData: true });
    // An older localStorage snapshot carries no `params` key at all — the
    // serializer reads that as "this builder never saw them, keep the live ones".
    delete state.builder.params;

    expect(loadDataFromCsv(serializeBuilderToCsv(state.builder))).toBe(true);
    expect(PARAMS.map((p) => p.id)).toEqual(["share_air", "detection_rate"]);
  });

  it("starts a from-scratch build with no constants at all", () => {
    openBuilder();
    expect(state.builder.params).toEqual([]);
    expect(serializeBuilderToCsv(state.builder)).not.toContain("# SECTION: params");
  });
});
