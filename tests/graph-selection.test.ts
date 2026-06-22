import { describe, it, expect, beforeEach } from "vitest";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import {
  bfsNeighbors,
  getAncestors,
  getDescendants,
  computeHighlightedEdges,
  computeMaxHighlightDepth,
} from "../assets/js/09-graph-selection";
import { outgoingEdges } from "../assets/js/03-state";
import { LINEAR_CSV } from "./fixtures/graphs";

describe("graph traversal on A → B → C", () => {
  beforeEach(() => loadDataFromCsv(LINEAR_CSV));

  it("walks descendants by depth", () => {
    expect(getDescendants("a", 1)).toEqual(new Set(["b"]));
    expect(getDescendants("a", 2)).toEqual(new Set(["b", "c"]));
  });

  it("walks ancestors by depth", () => {
    expect(getAncestors("c", 1)).toEqual(new Set(["b"]));
    expect(getAncestors("c", 2)).toEqual(new Set(["a", "b"]));
  });

  it("bfsNeighbors follows the requested adjacency/endpoint", () => {
    expect(bfsNeighbors("b", 1, outgoingEdges, "to")).toEqual(new Set(["c"]));
  });

  it("computeMaxHighlightDepth = longest shortest path (2 hops here)", () => {
    expect(computeMaxHighlightDepth()).toBe(2);
  });

  it("collects every edge id along the highlighted chains", () => {
    const edges = computeHighlightedEdges("a", 2, true, true);
    expect(edges).toEqual(new Set(["edge_0", "edge_1"]));
  });

  it("respects direction flags", () => {
    expect(computeHighlightedEdges("b", 1, false, true)).toEqual(new Set(["edge_1"]));
    expect(computeHighlightedEdges("b", 1, true, false)).toEqual(new Set(["edge_0"]));
  });
});
