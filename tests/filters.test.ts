import { describe, it, expect, beforeEach } from "vitest";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import { isNodeVisible, isEdgeVisible } from "../assets/js/10-filters";
import { nodeById, EDGES, state } from "../assets/js/03-state";
import { nodePrimaryFill, nodeSecondaryChips } from "../assets/js/11-rendering";
import { CAT_FILTER_CSV, LINEAR_CSV } from "./fixtures/graphs";

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
  it("hides when the node's only category is hidden", () => {
    state.hiddenCategories = new Set(["cat"]);
    expect(isNodeVisible(nodeById.a)).toBe(false);
  });
});

// Hiding a fill / corner tag is a COLOUR filter, not a box filter: the colour
// comes off every box carrying it, and the box only leaves the map once it has
// no visible tag left at all.
describe("isNodeVisible — category filters strip colours, not boxes", () => {
  beforeEach(() => {
    loadDataFromCsv(CAT_FILTER_CSV);
    state.hiddenCategories = new Set();
  });

  it("keeps a box that still has another fill tag", () => {
    state.hiddenCategories = new Set(["p1"]);
    expect(isNodeVisible(nodeById.twofills)).toBe(true);
  });
  it("keeps a box whose only fill tag is hidden but which still has a corner tag", () => {
    state.hiddenCategories = new Set(["p1"]);
    expect(isNodeVisible(nodeById.mix)).toBe(true);
  });
  it("keeps a box whose only corner tag is hidden but which still has a fill tag", () => {
    state.hiddenCategories = new Set(["s1"]);
    expect(isNodeVisible(nodeById.mix)).toBe(true);
  });
  it("keeps a box that still has another corner tag", () => {
    state.hiddenCategories = new Set(["s1"]);
    expect(isNodeVisible(nodeById.cornersonly)).toBe(true);
  });
  it("hides a box once every tag it carries is hidden", () => {
    state.hiddenCategories = new Set(["p1", "s1"]);
    expect(isNodeVisible(nodeById.mix)).toBe(false);
    expect(isNodeVisible(nodeById.cornersonly)).toBe(true); // s2 still shown
    state.hiddenCategories = new Set(["s1", "s2"]);
    expect(isNodeVisible(nodeById.cornersonly)).toBe(false);
    expect(isNodeVisible(nodeById.both)).toBe(true); // p1 / p2 still shown
  });
});

describe("category filters — node fills and corner chips", () => {
  const pos = { x: 0, y: 0, width: 100, height: 40, labelLines: ["Both"] };
  beforeEach(() => {
    loadDataFromCsv(CAT_FILTER_CSV);
    state.hiddenCategories = new Set();
  });

  it("blends both fill tags when neither is hidden", () => {
    const fill = nodePrimaryFill(nodeById.twofills, "g1");
    expect(fill.fill).toBe("url(#g1)");
    expect(fill.defs).toContain("#60a5fa");
    expect(fill.defs).toContain("#34d399");
  });
  it("drops a hidden fill tag from the blend, leaving the survivor solid", () => {
    state.hiddenCategories = new Set(["p1"]);
    const fill = nodePrimaryFill(nodeById.twofills, "g1");
    expect(fill.defs).toBe("");
    expect(fill.fill).toBe("#34d399");
  });
  it("falls back to the gray fill when every fill tag is hidden", () => {
    state.hiddenCategories = new Set(["p1", "p2"]);
    expect(nodePrimaryFill(nodeById.both, "g1").fill).toBe("#a3a3a3");
  });
  it("drops a hidden corner tag's chip and keeps the rest", () => {
    state.hiddenCategories = new Set(["s1"]);
    const chips = nodeSecondaryChips(nodeById.both, pos);
    expect(chips.svg).not.toContain("#f59e0b");
    expect(chips.svg).toContain("#ef4444");
  });
  it("draws no chips when every corner tag is hidden", () => {
    state.hiddenCategories = new Set(["s1", "s2"]);
    const chips = nodeSecondaryChips(nodeById.both, pos);
    expect(chips.svg).toBe("");
    expect(chips.leftEdge).toBe(pos.x + pos.width);
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
