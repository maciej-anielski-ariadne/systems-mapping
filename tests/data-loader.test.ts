import { describe, it, expect, beforeEach } from "vitest";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import {
  NODES,
  EDGES,
  nodeById,
  outgoingEdges,
  incomingEdges,
  streamNodeCount,
  topologicalOrder,
  cycleInfo,
  state,
} from "../assets/js/03-state";
import { LINEAR_CSV, FEEDBACK_CSV, MULTICAT_CSV, INVALID_CSV } from "./fixtures/graphs";

describe("loadDataFromCsv — happy path (linear chain)", () => {
  beforeEach(() => {
    expect(loadDataFromCsv(LINEAR_CSV)).toBe(true);
  });

  it("populates the node/edge arrays and stable edge ids", () => {
    expect(NODES.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(EDGES).toHaveLength(2);
    expect(EDGES.map((e) => e.id)).toEqual(["edge_0", "edge_1"]);
  });

  it("builds lookup indexes", () => {
    expect(nodeById.a.baseline).toBe(100);
    expect(outgoingEdges.a).toHaveLength(1);
    expect(incomingEdges.c).toHaveLength(1);
    expect(streamNodeCount.ops).toBe(3);
  });

  it("produces a valid topological order (causes before effects) and no cycles", () => {
    expect(topologicalOrder).toEqual(["a", "b", "c"]);
    expect(cycleInfo.loopCount).toBe(0);
  });
});

describe("loadDataFromCsv — feedback loop detection", () => {
  it("flags the back-edge and keeps every node in the order", () => {
    expect(loadDataFromCsv(FEEDBACK_CSV)).toBe(true);
    expect(cycleInfo.loopCount).toBe(1);
    expect(new Set(topologicalOrder)).toEqual(new Set(["a", "b", "c"]));
    expect(state.solverStatus.converged).toBe(true);
  });
});

describe("loadDataFromCsv — multi-category split", () => {
  it("separates primary from secondary categories", () => {
    expect(loadDataFromCsv(MULTICAT_CSV)).toBe(true);
    const n = nodeById.n;
    expect(n.category).toBe("prim");
    expect(n.categoryIds).toEqual(["prim", "sec"]);
    expect(n.primaryCategories).toEqual(["prim"]);
    expect(n.secondaryCategories).toEqual(["sec"]);
  });
});

describe("loadDataFromCsv — validation", () => {
  beforeEach(() => {
    expect(loadDataFromCsv(INVALID_CSV)).toBe(true); // still loads the valid rows
  });

  it("drops bad-reference + duplicate nodes but keeps valid ones", () => {
    expect(NODES.map((n) => n.id).sort()).toEqual(["good", "zero"]);
    expect(nodeById.badref).toBeUndefined();
  });

  it("ignores a zero baseline (keeps the node, drops the baseline)", () => {
    expect(nodeById.good.baseline).toBe(10);
    expect(nodeById.zero.baseline).toBeUndefined();
  });

  it("drops edges to non-existent nodes", () => {
    expect(EDGES).toHaveLength(0);
  });

  it("records human-readable warnings", () => {
    const joined = state.loadErrors.join(" | ");
    expect(joined).toMatch(/Duplicate box id: good/);
    expect(joined).toMatch(/badref/);
    expect(joined).toMatch(/zero/);
    expect(joined).toMatch(/ghost/);
  });
});

describe("loadDataFromCsv — fatal errors", () => {
  it("returns false when a required section is missing", () => {
    expect(loadDataFromCsv("# SECTION: streams\nid\nops")).toBe(false);
    expect(state.loadErrors.length).toBeGreaterThan(0);
  });
});
