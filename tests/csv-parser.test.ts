import { describe, it, expect } from "vitest";
import {
  parseCsvLine,
  parseCsvDocument,
  parseBooleanCell,
  parseNumericCell,
  parseEvidenceStatusCell,
} from "../assets/js/05-csv-parser";

describe("parseCsvLine", () => {
  it("splits plain comma-separated values and trims them", () => {
    expect(parseCsvLine("a, b ,c")).toEqual(["a", "b", "c"]);
  });

  it("keeps commas inside quoted fields", () => {
    expect(parseCsvLine('"a,b",c')).toEqual(["a,b", "c"]);
  });

  it("unescapes doubled double-quotes inside a quoted field", () => {
    expect(parseCsvLine('"she said ""hi""",x')).toEqual(['she said "hi"', "x"]);
  });

  it("returns a single empty cell for an empty line", () => {
    expect(parseCsvLine("")).toEqual([""]);
  });
});

describe("parseCsvDocument", () => {
  const doc = `# a leading comment, ignored
# SECTION: streams
id,label,short,color
ops,Operations,OPS,#60a5fa

# SECTION: nodes
id,Label,stream
a,Node A,ops
b,Node B,ops
`;

  it("keys sections by lowercased name", () => {
    const sections = parseCsvDocument(doc);
    expect(Object.keys(sections).sort()).toEqual(["nodes", "streams"]);
  });

  it("turns rows into objects keyed by lowercased, underscored headers", () => {
    const sections = parseCsvDocument(doc);
    expect(sections.streams).toEqual([{ id: "ops", label: "Operations", short: "OPS", color: "#60a5fa" }]);
    expect(sections.nodes).toEqual([
      { id: "a", label: "Node A", stream: "ops" },
      { id: "b", label: "Node B", stream: "ops" },
    ]);
  });

  it("ignores comments, blank lines, and content before the first section", () => {
    const sections = parseCsvDocument(doc);
    expect(sections.nodes).toHaveLength(2);
  });

  it("keeps LF and CRLF line endings inside quoted fields", () => {
    const multilineDocument = [
      "# SECTION: nodes",
      "id,label,description",
      'a,Alpha,"First line\nSecond line"',
      'b,Beta,"Windows first\r\nWindows second"',
    ].join("\r\n");

    const sections = parseCsvDocument(multilineDocument);

    expect(sections.nodes).toEqual([
      { id: "a", label: "Alpha", description: "First line\nSecond line" },
      { id: "b", label: "Beta", description: "Windows first\r\nWindows second" },
    ]);
  });

  it("does not treat section markers or comments inside a quoted field as records", () => {
    const multilineDocument = `# SECTION: reviews
box,note,verdict
c,"First thought
# SECTION: nodes
# this remains part of the note
Final thought",flagged
`;

    expect(parseCsvDocument(multilineDocument).reviews).toEqual([
      {
        box: "c",
        note: "First thought\n# SECTION: nodes\n# this remains part of the note\nFinal thought",
        verdict: "flagged",
      },
    ]);
  });

  it("preserves authored identity and free-text whitespace for boundary validation and round-trips", () => {
    const sections = parseCsvDocument(`# SECTION: nodes
id,label,description
" box ","  Display label  ","  First line
Second line  "
`);

    expect(sections.nodes).toEqual([{
      id: " box ",
      label: "  Display label  ",
      description: "  First line\nSecond line  ",
    }]);
  });

  it("parses a large document in one pass within a bounded time", () => {
    const rowCount = 100_000;
    const rows = Array.from(
      { length: rowCount },
      (_, rowIndex) => "node_" + rowIndex + ",Node " + rowIndex + ",Description " + rowIndex,
    ).join("\n");
    const document = "# SECTION: nodes\nid,label,description\n" + rows;

    const startedAt = performance.now();
    const sections = parseCsvDocument(document);
    const elapsedMilliseconds = performance.now() - startedAt;

    expect(sections.nodes).toHaveLength(rowCount);
    expect(sections.nodes[rowCount - 1].id).toBe("node_99999");
    expect(elapsedMilliseconds).toBeLessThan(1_000);
  });

  it("reports monotonic parsing progress through the complete document", () => {
    const document = "# SECTION: nodes\nid,label\na,Alpha\nb,Beta\nc,Gamma";
    const processedCharacterCounts: number[] = [];

    parseCsvDocument(document, {
      progressCharacterInterval: 8,
      onProgress(progress) {
        expect(progress.totalCharacters).toBe(document.length);
        processedCharacterCounts.push(progress.processedCharacters);
      },
    });

    expect(processedCharacterCounts[0]).toBe(0);
    expect(processedCharacterCounts.at(-1)).toBe(document.length);
    expect(processedCharacterCounts.length).toBeGreaterThan(2);
    expect(processedCharacterCounts).toEqual(
      [...processedCharacterCounts].sort((firstCount, secondCount) => firstCount - secondCount),
    );
  });
});

describe("parseBooleanCell", () => {
  it.each(["true", "TRUE", "yes", "1", "y", " Y "])("treats %s as true", (v) => {
    expect(parseBooleanCell(v)).toBe(true);
  });
  it.each(["false", "no", "0", "", "nope"])("treats %s as false", (v) => {
    expect(parseBooleanCell(v)).toBe(false);
  });
  it("treats undefined/null as false", () => {
    expect(parseBooleanCell(undefined)).toBe(false);
    expect(parseBooleanCell(null)).toBe(false);
  });
});

describe("parseNumericCell", () => {
  it("parses numbers including zero", () => {
    expect(parseNumericCell("3.5")).toBe(3.5);
    expect(parseNumericCell("0")).toBe(0);
    expect(parseNumericCell(" -2 ")).toBe(-2);
  });
  it("returns undefined for blank / non-numeric / nullish", () => {
    expect(parseNumericCell("")).toBeUndefined();
    expect(parseNumericCell("abc")).toBeUndefined();
    expect(parseNumericCell(undefined)).toBeUndefined();
    expect(parseNumericCell(null)).toBeUndefined();
  });
  it("rejects numeric prefixes and non-finite values", () => {
    expect(parseNumericCell("12xyz")).toBeUndefined();
    expect(parseNumericCell("Infinity")).toBeUndefined();
    expect(parseNumericCell("0x10")).toBeUndefined();
  });
});

describe("parseEvidenceStatusCell", () => {
  it.each([
    ["unspecified", "unspecified"],
    [" HYPOTHESIS ", "hypothesis"],
    ["Supported", "supported"],
    ["calibrated", "calibrated"],
    ["VALIDATED", "validated"],
  ] as const)("normalises %s to the canonical status", (rawStatus, expectedStatus) => {
    expect(parseEvidenceStatusCell(rawStatus)).toBe(expectedStatus);
  });

  it.each([undefined, null, "", "unrecognised"])(
    "uses unspecified for missing or unrecognised informational evidence status %s",
    (rawStatus) => {
      expect(parseEvidenceStatusCell(rawStatus)).toBe("unspecified");
    },
  );
});
