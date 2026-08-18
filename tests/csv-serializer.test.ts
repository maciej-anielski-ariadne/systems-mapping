import { describe, it, expect } from "vitest";
import {
  csvEscape,
  csvRow,
  serializeBuilderToCsv,
  serializeLiveStateToCsv,
} from "../assets/js/05a-csv-serializer";
import { parseCsvDocument } from "../assets/js/05-csv-parser";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import { NODES, PARAMS, nodeById, paramById, state } from "../assets/js/03-state";
import { SAMPLE_CSV } from "../assets/js/01-sample-data";
import { LINEAR_CSV, PARAMS_CSV } from "./fixtures/graphs";
import type { BuilderState } from "../assets/js/types";

describe("csvEscape", () => {
  it("leaves plain values untouched", () => {
    expect(csvEscape("hello")).toBe("hello");
  });
  it("quotes values with commas, quotes, or newlines and doubles internal quotes", () => {
    expect(csvEscape("a,b")).toBe('"a,b"');
    expect(csvEscape('he said "hi"')).toBe('"he said ""hi"""');
    expect(csvEscape("line\nbreak")).toBe('"line\nbreak"');
  });
  it("renders nullish / empty as an empty string", () => {
    expect(csvEscape(undefined)).toBe("");
    expect(csvEscape(null)).toBe("");
    expect(csvEscape("")).toBe("");
  });
});

describe("csvRow", () => {
  it("joins escaped cells with commas", () => {
    expect(csvRow(["a", "b,c", "d"])).toBe('a,"b,c",d');
  });
});

describe("serializeBuilderToCsv", () => {
  const builder: Partial<BuilderState> = {
    streams: [{ id: "ops", label: "Operations", short: "OPS", color: "#60a5fa" }],
    stages: [{ id: "s1", label: "One" }],
    categories: [{ id: "cat", label: "General", color: "#a3a3a3", textColor: "#111111", class: "primary" }],
    defaults: { enables: 0.3, increases: 0.25, decreases: -0.25 },
    nodes: [
      { id: "a", label: "A", stream: "ops", stage: "s1", category: "cat", baseline: 100, controllable: true },
    ],
    edges: [{ from: "a", to: "a", effect: "increases", description: "self" }],
  };

  it("emits every section in a form the parser round-trips", () => {
    const csv = serializeBuilderToCsv(builder as BuilderState);
    const sections = parseCsvDocument(csv);
    expect(Object.keys(sections).sort()).toEqual(["categories", "defaults", "edges", "nodes", "stages", "streams"]);
    expect(sections.streams[0]).toMatchObject({ id: "ops", label: "Operations" });
    expect(sections.nodes[0]).toMatchObject({ id: "a", stream: "ops", stage: "s1", category: "cat", baseline: "100", controllable: "true" });
    expect(sections.edges[0]).toMatchObject({ from: "a", to: "a", effect: "increases" });
  });

  it("adds readable from_label/to_label companion columns to edges (ignored on load)", () => {
    const b = {
      ...builder,
      nodes: [
        { id: "a", label: "Alpha", stream: "ops", stage: "s1", category: "cat" },
        { id: "b", label: "Beta", stream: "ops", stage: "s1", category: "cat" },
      ],
      edges: [{ from: "a", to: "b", effect: "increases", description: "link" }],
    };
    const sections = parseCsvDocument(serializeBuilderToCsv(b as BuilderState));
    // Titles sit beside the ids for human readers...
    expect(sections.edges[0]).toMatchObject({ from: "a", to: "b", from_label: "Alpha", to_label: "Beta" });
    // ...while the ids the app maps links by are still intact.
    expect(sections.edges[0].from).toBe("a");
    expect(sections.edges[0].to).toBe("b");
  });

  it("writes pipe-joined categoryIds when present", () => {
    const b = { ...builder, nodes: [{ id: "a", label: "A", stream: "ops", stage: "s1", categoryIds: ["cat", "sec"] }] };
    const csv = serializeBuilderToCsv(b as BuilderState);
    const sections = parseCsvDocument(csv);
    expect(sections.nodes[0].category).toBe("cat|sec");
  });

  it("always writes the calculation columns, blank when unset", () => {
    const csv = serializeBuilderToCsv({ ...builder, params: [] } as BuilderState);
    expect(csv).toContain("slider_max,combine,formula,min,max");
    const sections = parseCsvDocument(csv);
    expect(sections.nodes[0]).toMatchObject({ combine: "", formula: "", min: "", max: "" });
  });

  it("quotes a formula containing commas and quotes so it survives re-parsing", () => {
    const formula = 'clamp(min(a, b), 0, 1) /* the "safe" share */';
    const b = {
      ...builder,
      params: [],
      nodes: [
        {
          id: "a", label: "A", stream: "ops", stage: "s1", category: "cat",
          combine: "min", formula: formula, minValue: 0, maxValue: 250,
        },
      ],
    };
    const csv = serializeBuilderToCsv(b as BuilderState);
    // The raw line is quoted, with internal quotes doubled...
    expect(csv).toContain('"clamp(min(a, b), 0, 1) /* the ""safe"" share */"');
    // ...and the parser hands the identical string back.
    const sections = parseCsvDocument(csv);
    expect(sections.nodes[0]).toMatchObject({
      combine: "min", formula: formula, min: "0", max: "250",
    });
  });
});

describe("serializeBuilderToCsv — params", () => {
  const builder: Partial<BuilderState> = {
    streams: [{ id: "ops", label: "Operations", short: "OPS", color: "#60a5fa" }],
    stages: [{ id: "s1", label: "One" }],
    categories: [{ id: "cat", label: "General", color: "#a3a3a3", textColor: "#111111", class: "primary" }],
    defaults: { enables: 0.3, increases: 0.25, decreases: -0.25 },
    nodes: [{ id: "a", label: "A", stream: "ops", stage: "s1", category: "cat" }],
    edges: [],
  };

  it("emits the section between defaults and nodes, and skips it when empty", () => {
    const withParams = serializeBuilderToCsv({
      ...builder,
      params: [{ id: "share_air", value: 0.35, description: "Share routed by air" }],
    } as BuilderState);
    expect(withParams.indexOf("# SECTION: defaults")).toBeLessThan(withParams.indexOf("# SECTION: params"));
    expect(withParams.indexOf("# SECTION: params")).toBeLessThan(withParams.indexOf("# SECTION: nodes"));
    expect(parseCsvDocument(withParams).params[0]).toMatchObject({
      id: "share_air", value: "0.35", description: "Share routed by air",
    });

    const withoutParams = serializeBuilderToCsv({ ...builder, params: [] } as BuilderState);
    expect(withoutParams).not.toContain("# SECTION: params");
  });

  // The wizard has no params step yet, so an "Apply to map" must not silently
  // delete constants the user never saw. A builder object with no params key at
  // all falls back to the live map's params.
  it("falls back to the live map's params when the builder carries none", () => {
    expect(loadDataFromCsv(PARAMS_CSV)).toBe(true);
    const csv = serializeBuilderToCsv(builder as BuilderState);
    expect(parseCsvDocument(csv).params.map((p) => p.id)).toEqual(["share_air", "detection_rate"]);
  });
});

describe("serializeLiveStateToCsv — round-trip of params and calculation columns", () => {
  it("survives load → serialize → load unchanged", () => {
    expect(loadDataFromCsv(PARAMS_CSV)).toBe(true);
    const csv = serializeLiveStateToCsv();
    expect(loadDataFromCsv(csv)).toBe(true);

    expect(state.loadErrors).toEqual([]);
    expect(PARAMS).toEqual([
      { id: "share_air", value: 0.35, description: "Share of the flow routed by air" },
      {
        id: "detection_rate",
        value: 0.6,
        description: "Probability an examined item is detected, per inspection",
      },
    ]);
    expect(paramById.share_air.value).toBe(0.35);
    expect(nodeById.served.formula).toBe("clamp(min(demand, capacity), 0, 200)");
    expect(nodeById.total.combine).toBe("additive");
    expect(nodeById.capacity.minValue).toBe(0);
    expect(nodeById.capacity.maxValue).toBe(200);
    expect(nodeById.demand.combine).toBeUndefined();
  });

  it("round-trips a legacy map (no params, no calculation columns) with zero errors", () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    const nodeCount = NODES.length;
    const csv = serializeLiveStateToCsv();
    expect(csv).not.toContain("# SECTION: params");

    expect(loadDataFromCsv(csv)).toBe(true);
    expect(state.loadErrors).toEqual([]);
    expect(NODES).toHaveLength(nodeCount);
    expect(PARAMS).toEqual([]);
    expect(NODES.every((n) => n.combine === undefined && n.formula === undefined)).toBe(true);
  });

  it("leaves a params-free map params-free after a later load", () => {
    expect(loadDataFromCsv(PARAMS_CSV)).toBe(true);
    expect(loadDataFromCsv(LINEAR_CSV)).toBe(true);
    expect(serializeLiveStateToCsv()).not.toContain("# SECTION: params");
  });
});
