import { describe, it, expect, beforeEach } from "vitest";
import { loadDataFromCsv, rebuildIndexes } from "../assets/js/06-data-loader";
import {
  NODES,
  EDGES,
  PARAMS,
  STREAMS,
  CATEGORIES,
  nodeById,
  paramById,
  outgoingEdges,
  incomingEdges,
  streamNodeCount,
  topologicalOrder,
  cycleInfo,
  state,
  setEdges,
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
import { findings, kinds, text } from "./helpers/findings";

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

  it("records a finding per problem, each naming its box", () => {
    expect(kinds()).toContain("duplicate-id");
    expect(findings("good").map((f) => f.kind)).toContain("duplicate-id");
    const joined = text();
    expect(joined).toMatch(/badref/);
    expect(joined).toMatch(/zero/);
    expect(joined).toMatch(/ghost/);
  });

  it("gives every finding a severity, a message and a fix", () => {
    expect(state.loadErrors.length).toBeGreaterThan(0);
    for (const f of state.loadErrors) {
      expect(["ignored", "wrong", "mismatch"]).toContain(f.severity);
      expect(f.message.length).toBeGreaterThan(0);
      expect(f.fix).toBeTruthy();
    }
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

  it("names the duplicate, non-numeric and box-colliding constants", () => {
    expect(kinds()).toEqual(
      expect.arrayContaining([
        "duplicate-constant",
        "constant-not-a-number",
        "constant-clashes-with-box",
      ]),
    );
    const joined = text();
    expect(joined).toMatch(/`good`/);
    expect(joined).toMatch(/`notnum`/);
    expect(joined).toMatch(/`n1`/);
  });

  it("rejects a combine value outside the enum but keeps the box", () => {
    expect(nodeById.n1).toBeDefined();
    expect(nodeById.n1.combine).toBeUndefined();
    expect(kinds("n1")).toContain("unknown-combine");
    expect(text()).toMatch(/`sideways`/);
  });

  it("rejects min > max and drops both limits", () => {
    expect(nodeById.n2).toBeDefined();
    expect(nodeById.n2.minValue).toBeUndefined();
    expect(nodeById.n2.maxValue).toBeUndefined();
    expect(kinds("n2")).toContain("limits-crossed");
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

const INPUT_BOUNDARY_CSV = `# SECTION: streams
id,label,short,color
ops,Operations,OPS,#60a5fa

# SECTION: stages
id,label
first,First

# SECTION: categories
id,label,color,text_color
general,General,#a3a3a3,#111111

# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max,combine,formula,min,max
a,A,,ops,first,general,100,units,true,,2,,,,
b,B,,ops,first,general,100,units,false,,2,,,,

# SECTION: edges
from,to,effect,elasticity,description
a,b,increases,0.5,
`;

describe("canonical input boundary", () => {
  it("does not reset edge allocation when a load is rejected", () => {
    expect(loadDataFromCsv(INPUT_BOUNDARY_CSV)).toBe(true);
    expect(EDGES[0].id).toBe("edge_0");

    expect(loadDataFromCsv("# SECTION: streams\nid,label\nops,Operations")).toBe(false);
    setEdges(EDGES.concat([{ from: "b", to: "a", effect: "decreases", description: "" }]));
    rebuildIndexes();

    expect(EDGES.map(edge => edge.id)).toEqual(["edge_0", "edge_1"]);
  });

  it.each([
    ["row", "ops,Operations,OPS,#60a5fa\nops,Duplicate,OPS,#60a5fa", "identifier-duplicate"],
    ["row", 'bad-id,Operations,OPS,#60a5fa', "identifier-invalid"],
    ["row", "constructor,Operations,OPS,#60a5fa", "identifier-invalid"],
    ["row", '" ops",Operations,OPS,#60a5fa', "identifier-invalid"],
    ["row", '"ops ",Operations,OPS,#60a5fa', "identifier-invalid"],
  ])("rejects an unusable %s identity without replacing the current map", (_kind, streamRows, findingKind) => {
    expect(loadDataFromCsv(INPUT_BOUNDARY_CSV)).toBe(true);
    const invalidCsv = INPUT_BOUNDARY_CSV.replace("ops,Operations,OPS,#60a5fa", streamRows);
    expect(loadDataFromCsv(invalidCsv)).toBe(false);
    expect(NODES.map(node => node.id)).toEqual(["a", "b"]);
    expect(kinds()).toContain(findingKind);
  });

  it("drops padded link identities instead of silently trimming them", () => {
    const paddedLinkCsv = INPUT_BOUNDARY_CSV.replace(
      "a,b,increases,0.5,",
      '" a",b,increases,0.5,',
    );

    expect(loadDataFromCsv(paddedLinkCsv)).toBe(true);
    expect(EDGES).toEqual([]);
    expect(kinds()).toContain("identifier-invalid");
  });

  it("preserves boundary whitespace and line endings in free-text descriptions", () => {
    const description = "  First line\nSecond line  ";
    const freeTextCsv = INPUT_BOUNDARY_CSV.replace(
      "a,A,,ops,first",
      'a,A,"' + description + '",ops,first',
    );

    expect(loadDataFromCsv(freeTextCsv)).toBe(true);
    expect(nodeById.a.description).toBe(description);
  });

  it("uses safe colour fallbacks and reports every rejected colour", () => {
    const hostileCsv = INPUT_BOUNDARY_CSV
      .replace("#60a5fa", 'url(javascript:alert(1))')
      .replace("#a3a3a3,#111111", "red,expression(alert(1))");
    expect(loadDataFromCsv(hostileCsv)).toBe(true);

    expect(STREAMS[0].color).toBe("#94a3b8");
    expect(CATEGORIES.general.color).toBe("#a3a3a3");
    expect(CATEGORIES.general.textColor).toBe("#1c1917");
    expect(kinds().filter(kind => kind === "colour-invalid")).toHaveLength(3);
  });

  it("rejects prototype-key box identifiers without throwing or polluting indexes", () => {
    const prototypeKeyCsv = INPUT_BOUNDARY_CSV
      .replace("a,A,", "__proto__,A,")
      .replace("a,b,increases", "__proto__,b,increases");
    expect(() => loadDataFromCsv(prototypeKeyCsv)).not.toThrow();
    expect(loadDataFromCsv(prototypeKeyCsv)).toBe(true);
    expect(nodeById.__proto__).toBeUndefined();
    expect(Object.getPrototypeOf(nodeById)).toBeNull();
    expect(kinds()).toContain("identifier-invalid");
  });

  it("reports and ignores malformed, non-finite, and domain-invalid numbers", () => {
    const invalidNumbersCsv = INPUT_BOUNDARY_CSV.replace(
      "a,A,,ops,first,general,100,units,true,,2,,,,",
      "a,A,,ops,first,general,-100,units,true,,Infinity,,,12xyz,bad",
    );
    expect(loadDataFromCsv(invalidNumbersCsv)).toBe(true);

    expect(nodeById.a.baseline).toBeUndefined();
    expect(nodeById.a.sliderMax).toBeUndefined();
    expect(nodeById.a.minValue).toBeUndefined();
    expect(nodeById.a.maxValue).toBeUndefined();
    expect(kinds("a")).toEqual(expect.arrayContaining([
      "baseline-negative",
      "slider-max-not-a-number",
      "minimum-not-a-number",
    ]));
  });

  it("clears stale search objects on successful replacement", () => {
    expect(loadDataFromCsv(INPUT_BOUNDARY_CSV)).toBe(true);
    state.searchQuery = "B";
    state.searchMatches = [{ node: nodeById.b, score: 1, bestField: "label", bestPositions: [] }];
    state.searchFocusIndex = 0;

    expect(loadDataFromCsv(INPUT_BOUNDARY_CSV.replace("b,B,", "c,C,"))).toBe(true);
    expect(state.searchQuery).toBe("");
    expect(state.searchMatches).toEqual([]);
    expect(state.searchFocusIndex).toBe(0);
  });
});
