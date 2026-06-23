import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import { NODES, EDGES, state } from "../assets/js/03-state";

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
});
