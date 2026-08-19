// =============================================================================
// THE ATLAS, INSIDE THE APP
// -----------------------------------------------------------------------------
// The engine's own guarantees are pinned in pathway-atlas.test.ts. What this
// file pins is the join: that the atlas reads the app's live map (signs and
// all), that it opens over the map from a box rather than somewhere else, that
// the right-hand panel becomes its inspector rather than a second one, and that
// it never outlives the map it is a picture of.
// =============================================================================
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import { EDGES, NODES, nodeById, state } from "../assets/js/03-state";
import { selectNode } from "../assets/js/09-graph-selection";
import { renderDetailPanel } from "../assets/js/15-detail-panel";
import { setUiMode } from "../assets/js/17-events";
import { atlasIsOpen, closeAtlas, openAtlas } from "../assets/js/21-atlas-view";

const here = dirname(fileURLToPath(import.meta.url));
const sampleCsv = readFileSync(resolve(here, "../assets/data/sample.csv"), "utf-8");
const advancedCsv = readFileSync(resolve(here, "../assets/data/advanced_sample.csv"), "utf-8");

const panel = (): HTMLElement => document.getElementById("detail-content") as HTMLElement;
const firstInput = (): string => {
  const withOut = NODES.find(n => EDGES.some(e => e.from === n.id));
  return withOut!.id;
};

beforeEach(() => {
  closeAtlas();
  setUiMode("read");
});

describe("the way in", () => {
  it("is offered on a box that has something downstream", () => {
    loadDataFromCsv(sampleCsv);
    selectNode(firstInput());
    renderDetailPanel();
    expect(panel().querySelector("[data-action='open-atlas']")).not.toBeNull();
  });

  it("is not offered on a box that ends the story", () => {
    loadDataFromCsv(sampleCsv);
    const leaf = NODES.find(n => !EDGES.some(e => e.from === n.id));
    expect(leaf).toBeDefined();
    selectNode(leaf!.id);
    renderDetailPanel();
    expect(panel().querySelector("[data-action='open-atlas']")).toBeNull();
  });
});

describe("opening it", () => {
  it("draws one circle per element, over the map", () => {
    loadDataFromCsv(sampleCsv);
    openAtlas(firstInput());
    expect(atlasIsOpen()).toBe(true);
    expect(document.body.classList.contains("atlas-open")).toBe(true);

    const stage = document.getElementById("atlas-stage")!;
    expect(stage.hidden).toBe(false);
    expect(stage.querySelectorAll("svg.atlas .bub").length).toBeGreaterThan(1);
    // The map is still there underneath — going back is not a reload.
    expect(document.querySelectorAll("#viz-svg .node-group").length).toBe(NODES.length);
  });

  it("reads the whole map, filters and all", () => {
    loadDataFromCsv(sampleCsv);
    const start = firstInput();
    openAtlas(start);
    const before = document.querySelectorAll("#atlas-stage .bub").length;

    // Hide a row: what's on the map changes, what's true does not.
    closeAtlas();
    state.hiddenStreams = new Set([NODES[0].stream]);
    openAtlas(start);
    expect(document.querySelectorAll("#atlas-stage .bub").length).toBe(before);
    state.hiddenStreams = new Set();
  });

  it("refuses a box that isn't in the map", () => {
    loadDataFromCsv(sampleCsv);
    openAtlas("no_such_box");
    expect(atlasIsOpen()).toBe(false);
  });
});

describe("the panel is its inspector", () => {
  it("says what the picture is, and what the percentages are of", () => {
    loadDataFromCsv(sampleCsv);
    const start = firstInput();
    openAtlas(start);
    renderDetailPanel();

    const text = panel().textContent || "";
    expect(text).toContain("Everything downstream of " + nodeById[start].label);
    expect(text).toContain("readings");
    // One inspector, not two: the atlas doesn't ship its own panel element.
    expect(document.querySelectorAll("#atlas-stage .ins").length).toBe(0);
  });

  it("goes back to the box panel when the atlas closes", () => {
    loadDataFromCsv(sampleCsv);
    const start = firstInput();
    selectNode(start);
    openAtlas(start);
    renderDetailPanel();
    expect(panel().textContent).toContain("Everything downstream");

    closeAtlas();
    renderDetailPanel();
    expect(panel().textContent).toContain(nodeById[start].label);
    expect(panel().textContent).not.toContain("Everything downstream of");
  });
});

describe("it never outlives its map", () => {
  it("closes when a different map is loaded", () => {
    loadDataFromCsv(sampleCsv);
    openAtlas(firstInput());
    expect(atlasIsOpen()).toBe(true);

    loadDataFromCsv(advancedCsv);
    expect(atlasIsOpen()).toBe(false);
    expect(document.body.classList.contains("atlas-open")).toBe(false);
    expect((document.getElementById("atlas-stage") as HTMLElement).hidden).toBe(true);
  });
});

describe("feedback", () => {
  it("draws a knot of feedback as a wheel you can go into", () => {
    // The parcel-delivery sample has a real loop in it.
    loadDataFromCsv(advancedCsv);
    const start = NODES.find(n => n.label === "Website visits") || NODES[0];
    openAtlas(start.id);

    const tangles = document.querySelectorAll("#atlas-stage g.n[data-loop]");
    expect(tangles.length).toBeGreaterThan(0);
    // A wheel is drawn where the tangle stands: rim boxes and chords, not a
    // link to another view.
    expect(tangles[0].querySelectorAll(".nd").length).toBeGreaterThan(2);
    expect(tangles[0].querySelectorAll(".ch").length).toBeGreaterThan(0);
  });
});
