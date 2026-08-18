import { describe, it, expect, beforeEach } from "vitest";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import {
  NODES,
  EDGES,
  PARAMS,
  nodeById,
  paramById,
  outgoingEdges,
  incomingEdges,
  streamNodeCount,
  topologicalOrder,
  cycleInfo,
  state,
} from "../assets/js/03-state";
import { SAMPLE_CSV } from "../assets/js/01-sample-data";
import {
  LINEAR_CSV,
  FEEDBACK_CSV,
  MULTICAT_CSV,
  INVALID_CSV,
  PARAMS_CSV,
  PARAMS_INVALID_CSV,
} from "./fixtures/graphs";

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

describe("loadDataFromCsv — params section", () => {
  beforeEach(() => {
    expect(loadDataFromCsv(PARAMS_CSV)).toBe(true);
  });

  it("loads every param and indexes it by id", () => {
    expect(state.loadErrors).toEqual([]);
    expect(PARAMS.map((p) => p.id)).toEqual(["share_air", "detection_rate"]);
    expect(paramById.share_air.value).toBe(0.35);
    expect(paramById.detection_rate.description).toBe(
      "Probability an examined item is detected, per inspection",
    );
  });

  it("keeps params out of the map's boxes", () => {
    expect(NODES.map((n) => n.id)).toEqual(["demand", "capacity", "served", "total"]);
    expect(nodeById.share_air).toBeUndefined();
  });

  it("resets to no params when a CSV without the section loads", () => {
    expect(loadDataFromCsv(LINEAR_CSV)).toBe(true);
    expect(PARAMS).toEqual([]);
    expect(paramById).toEqual({});
  });
});

describe("loadDataFromCsv — per-box calculation columns", () => {
  beforeEach(() => {
    expect(loadDataFromCsv(PARAMS_CSV)).toBe(true);
  });

  it("reads the combine rule and leaves it undefined when blank", () => {
    expect(nodeById.total.combine).toBe("additive");
    expect(nodeById.demand.combine).toBeUndefined();
  });

  it("stores the formula as raw text, commas and all", () => {
    expect(nodeById.served.formula).toBe("clamp(min(demand, capacity), 0, 200)");
    expect(nodeById.total.formula).toBeUndefined();
  });

  it("reads min/max into minValue/maxValue", () => {
    expect(nodeById.capacity.minValue).toBe(0);
    expect(nodeById.capacity.maxValue).toBe(200);
    expect(nodeById.demand.minValue).toBeUndefined();
    expect(nodeById.demand.maxValue).toBeUndefined();
  });

  it("feeds the columns straight into the engine (formula wins, trace recorded)", () => {
    // served = clamp(min(demand, capacity), 0, 200) = min(100, 80) = 80.
    expect(state.computedValues.served).toBe(80);
    expect(state.explanations.served.rule).toBe("formula");
    expect(state.explanations.total.rule).toBe("additive");
  });
});

describe("loadDataFromCsv — params / calculation-column validation", () => {
  beforeEach(() => {
    expect(loadDataFromCsv(PARAMS_INVALID_CSV)).toBe(true); // still loads the valid rows
  });

  it("keeps only the valid param", () => {
    expect(PARAMS.map((p) => p.id)).toEqual(["good"]);
    expect(paramById.good.value).toBe(0.5);
  });

  it("names the duplicate, non-numeric and box-colliding params", () => {
    const joined = state.loadErrors.join(" | ");
    expect(joined).toMatch(/Duplicate parameter id: good/);
    expect(joined).toMatch(/Parameter `notnum` has a value that is not a number/);
    expect(joined).toMatch(/Parameter `n1` has the same id as a box/);
  });

  it("rejects a combine value outside the enum but keeps the box", () => {
    expect(nodeById.n1).toBeDefined();
    expect(nodeById.n1.combine).toBeUndefined();
    expect(state.loadErrors.join(" | ")).toMatch(/Box `n1` has an unknown combine rule `sideways`/);
  });

  it("rejects min > max and drops both limits", () => {
    expect(nodeById.n2).toBeDefined();
    expect(nodeById.n2.minValue).toBeUndefined();
    expect(nodeById.n2.maxValue).toBeUndefined();
    expect(state.loadErrors.join(" | ")).toMatch(/Box `n2` has min 10 greater than max 5/);
  });
});

describe("loadDataFromCsv — legacy CSV regression", () => {
  it("loads the bundled sample (no params, no calculation columns) with zero errors", () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    expect(state.loadErrors).toEqual([]);
    expect(PARAMS).toEqual([]);
    expect(NODES.every((n) => n.combine === undefined && n.formula === undefined)).toBe(true);
    expect(NODES.every((n) => n.minValue === undefined && n.maxValue === undefined)).toBe(true);
  });
});

describe("loadDataFromCsv — fatal errors", () => {
  it("returns false when a required section is missing", () => {
    expect(loadDataFromCsv("# SECTION: streams\nid\nops")).toBe(false);
    expect(state.loadErrors.length).toBeGreaterThan(0);
  });
});
