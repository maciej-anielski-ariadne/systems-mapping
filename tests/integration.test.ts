import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import { toggleCategory } from "../assets/js/10-filters";
import { NODES, EDGES, nodeById, state } from "../assets/js/03-state";

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

    // Pick a category that actually has nodes, then count how many nodes carry it.
    const someNode = NODES.find((n) => n.category)!;
    const catId = someNode.category!;
    const inCat = NODES.filter((n) => (n.categoryIds || [n.category]).includes(catId)).length;
    expect(inCat).toBeGreaterThan(0);

    // toggleCategory hides the category and re-renders. Category hiding does NOT
    // call setLayout, so this is exactly the path the cache keys on its hidden
    // sets to catch — a stale cache would keep drawing the hidden nodes.
    toggleCategory(catId);
    expect(svg.querySelectorAll(".node-group").length).toBe(before - inCat);

    // Toggling it back restores them (cache invalidates the other direction too).
    toggleCategory(catId);
    expect(svg.querySelectorAll(".node-group").length).toBe(before);
  });
});
