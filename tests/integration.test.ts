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
});
