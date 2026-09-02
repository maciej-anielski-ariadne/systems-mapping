import { describe, expect, it } from "vitest";
import {
  prepareCsvImportFromBytes,
  type CsvImportProgressMessage,
  type PrepareCsvImportMessage,
} from "../assets/js/05b-csv-import-protocol";
import {
  loadDataFromCsv,
  loadDataFromParsedCsv,
} from "../assets/js/06-data-loader";
import { EDGES, NODES, state } from "../assets/js/03-state";
import { LINEAR_CSV } from "./fixtures/graphs";

const REPLACEMENT_CSV = `# SECTION: streams
id,label,short,color
replacement,Replacement,R,#334455

# SECTION: stages
id,label
first,First

# SECTION: categories
id,label,color,text_color
general,General,#a3a3a3,#111111

# SECTION: nodes
id,label,description,stream,stage,category
replacement_node,Replacement node,,replacement,first,general

# SECTION: edges
from,to,effect
`;

function preparationMessage(csvText: string): PrepareCsvImportMessage {
  const encodedBytes = new TextEncoder().encode(csvText);
  return {
    type: "prepare-csv-import",
    requestIdentifier: "request-1",
    fileName: "map.csv",
    csvBytes: encodedBytes.buffer as ArrayBuffer,
  };
}

describe("background CSV preparation", () => {
  it("decodes, parses, validates, and counts a valid file without a size gate", () => {
    const progressMessages: CsvImportProgressMessage[] = [];
    const message = preparationMessage(REPLACEMENT_CSV);
    const ready = prepareCsvImportFromBytes(message, progress => progressMessages.push(progress));

    expect(ready.type).toBe("csv-import-ready");
    expect(ready.csvBytes).toBe(message.csvBytes);
    expect(ready.sections.nodes).toHaveLength(1);
    expect(ready.summary).toMatchObject({
      nodeCount: 1,
      edgeCount: 0,
      streamCount: 1,
      stageCount: 1,
      categoryCount: 1,
      canIntegrate: true,
      fatalMessages: [],
    });
    expect(new Set(progressMessages.map(progress => progress.phase)))
      .toEqual(new Set(["decoding", "parsing", "validating"]));
    for (const phase of ["decoding", "parsing", "validating"] as const) {
      const messagesForPhase = progressMessages.filter(progress => progress.phase === phase);
      expect(messagesForPhase.at(-1)?.completed).toBe(messagesForPhase.at(-1)?.total);
    }
  });

  it("returns fatal preflight findings instead of mutating a live map", () => {
    expect(loadDataFromCsv(LINEAR_CSV)).toBe(true);
    const originalNodeIdentifiers = NODES.map(node => node.id);
    const originalEdgeIdentifiers = EDGES.map(edge => edge.id);
    const originalFindings = state.loadErrors;

    const ready = prepareCsvImportFromBytes(
      preparationMessage("# SECTION: nodes\nid,label\nlonely,Lonely"),
      () => undefined,
    );

    expect(ready.summary.canIntegrate).toBe(false);
    expect(ready.summary.fatalMessages).toEqual(expect.arrayContaining([
      expect.stringContaining("streams"),
      expect.stringContaining("stages"),
      expect.stringContaining("categories"),
    ]));
    expect(NODES.map(node => node.id)).toEqual(originalNodeIdentifiers);
    expect(EDGES.map(edge => edge.id)).toEqual(originalEdgeIdentifiers);
    expect(state.loadErrors).toBe(originalFindings);
  });

  it("matches loader duplicate semantics when an earlier box row is unusable", () => {
    const duplicateAfterInvalidReference = REPLACEMENT_CSV.replace(
      "replacement_node,Replacement node,,replacement,first,general",
      "replacement_node,Invalid first row,,missing,first,general\n" +
        "replacement_node,Duplicate valid row,,replacement,first,general",
    );

    const ready = prepareCsvImportFromBytes(
      preparationMessage(duplicateAfterInvalidReference),
      () => undefined,
    );

    expect(ready.summary.nodeCount).toBe(0);
    expect(ready.summary.ignoredNodeCount).toBe(2);
    expect(ready.summary.canIntegrate).toBe(false);
    expect(loadDataFromCsv(duplicateAfterInvalidReference)).toBe(false);
  });

  it("holds a valid preparation apart until explicit integration", () => {
    expect(loadDataFromCsv(LINEAR_CSV)).toBe(true);
    const originalNodeIdentifiers = NODES.map(node => node.id);
    const ready = prepareCsvImportFromBytes(preparationMessage(REPLACEMENT_CSV), () => undefined);

    expect(NODES.map(node => node.id)).toEqual(originalNodeIdentifiers);

    const csvText = new TextDecoder().decode(ready.csvBytes);
    expect(loadDataFromParsedCsv(csvText, ready.sections)).toBe(true);
    expect(NODES.map(node => node.id)).toEqual(["replacement_node"]);
  });

  it("preserves the current map if prepared-section integration unexpectedly fails", () => {
    expect(loadDataFromCsv(LINEAR_CSV)).toBe(true);
    const originalNodeIdentifiers = NODES.map(node => node.id);
    const originalFindings = state.loadErrors;

    expect(loadDataFromParsedCsv("invalid", {})).toBe(false);

    expect(NODES.map(node => node.id)).toEqual(originalNodeIdentifiers);
    expect(state.loadErrors).toBe(originalFindings);
  });
});
