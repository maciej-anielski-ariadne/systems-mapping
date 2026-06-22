import { describe, it, expect, beforeEach } from "vitest";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import { isNodeVisible, isEdgeVisible } from "../assets/js/10-filters";
import { nodeById, EDGES, state } from "../assets/js/03-state";
import { LINEAR_CSV } from "./fixtures/graphs";

describe("isNodeVisible", () => {
  beforeEach(() => loadDataFromCsv(LINEAR_CSV));

  it("is visible when stream, stage and categories are all shown", () => {
    expect(isNodeVisible(nodeById.a)).toBe(true);
  });
  it("hides when the node's stream is hidden", () => {
    state.hiddenStreams = new Set(["ops"]);
    expect(isNodeVisible(nodeById.a)).toBe(false);
  });
  it("hides when the node's stage is hidden", () => {
    state.hiddenStages = new Set(["s1"]);
    expect(isNodeVisible(nodeById.a)).toBe(false);
    expect(isNodeVisible(nodeById.b)).toBe(true);
  });
  it("hides when a carried category is hidden", () => {
    state.hiddenCategories = new Set(["cat"]);
    expect(isNodeVisible(nodeById.a)).toBe(false);
  });
});

describe("isEdgeVisible", () => {
  beforeEach(() => loadDataFromCsv(LINEAR_CSV));

  it("is visible by default", () => {
    expect(isEdgeVisible(EDGES[0])).toBe(true);
  });
  it("hides when the edge's effect is filtered out", () => {
    state.hiddenEffects = new Set(["increases"]);
    expect(isEdgeVisible(EDGES[0])).toBe(false);
  });
  it("hides when the edge's line style is filtered out", () => {
    state.hiddenStyles = new Set(["solid"]);
    expect(isEdgeVisible(EDGES[0])).toBe(false); // fixture edges are solid
  });
});
