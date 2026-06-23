import { describe, it, expect } from "vitest";
import { csvEscape, csvRow, serializeBuilderToCsv } from "../assets/js/05a-csv-serializer";
import { parseCsvDocument } from "../assets/js/05-csv-parser";
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
});
