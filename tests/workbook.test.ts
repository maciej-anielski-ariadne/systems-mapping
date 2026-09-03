import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

import {
  csvToTables,
  csvToWorkbookBlob,
  readWorkbookSheets,
  tablesToCsv,
  workbookBufferToCsv,
  workbookIsSupported,
  columnLetters,
} from "../assets/js/05c-workbook";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import { serializeLiveStateToCsv } from "../assets/js/05a-csv-serializer";
import { NODES, EDGES, STREAMS, STAGES, PARAMS } from "../assets/js/03-state";
import { COMBINE_OPTIONS, DIRECTION_OPTIONS, EFFECT_OPTIONS } from "../assets/js/02-config";
import { EVIDENCE_STATUSES } from "../assets/js/07c-evidence";

const TUTORIAL_MAP = readFileSync("assets/data/tutorial_map.csv", "utf8");

/** The sheet XML for one named sheet, straight out of the zip. */
async function sheetXmlFor(blob: Blob, sheetName: string): Promise<string> {
  const parts = await rawZipEntries(await blob.arrayBuffer());
  const workbook = parts.get("xl/workbook.xml")!;
  const order = Array.from(workbook.matchAll(/<sheet name="([^"]*)"/g)).map(match => match[1]);
  const index = order.indexOf(sheetName);
  expect(index, "sheet " + sheetName + " exists").toBeGreaterThanOrEqual(0);
  return parts.get("xl/worksheets/sheet" + (index + 1) + ".xml")!;
}

/**
 * A deliberately separate zip reader for the tests. Reading the module's output
 * with the module's own reader proves only that it is self-consistent.
 */
async function rawZipEntries(buffer: ArrayBuffer): Promise<Map<string, string>> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let end = buffer.byteLength - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  const count = view.getUint16(end + 10, true);
  let pointer = view.getUint32(end + 16, true);
  const parts = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    const packedSize = view.getUint32(pointer + 20, true);
    const nameLength = view.getUint16(pointer + 28, true);
    const extraLength = view.getUint16(pointer + 30, true);
    const commentLength = view.getUint16(pointer + 32, true);
    const localOffset = view.getUint32(pointer + 42, true);
    const path = new TextDecoder().decode(bytes.subarray(pointer + 46, pointer + 46 + nameLength));
    const start = localOffset + 30 + view.getUint16(localOffset + 26, true) +
      view.getUint16(localOffset + 28, true);
    const packed = bytes.subarray(start, start + packedSize);
    const source = new ReadableStream<BufferSource>({
      start(controller) { controller.enqueue(packed); controller.close(); },
    });
    const inflated = source.pipeThrough(new DecompressionStream("deflate-raw"));
    const chunks: Uint8Array[] = [];
    const reader = inflated.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const joined = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const chunk of chunks) { joined.set(chunk, at); at += chunk.length; }
    parts.set(path, new TextDecoder().decode(joined));
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return parts;
}

/**
 * Build a workbook the way EXCEL does rather than the way this app does: text in
 * a shared-strings table, trailing empty cells omitted entirely, and no styles
 * part. Reading this is the case that actually matters — the file coming back is
 * one a spreadsheet re-saved.
 */
async function foreignWorkbook(sheets: { name: string; rows: (string | number)[][] }[]): Promise<ArrayBuffer> {
  const shared: string[] = [];
  const indexOfString = (text: string): number => {
    const at = shared.indexOf(text);
    if (at >= 0) return at;
    shared.push(text);
    return shared.length - 1;
  };
  const escape = (text: string): string =>
    text.replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] as string));

  const sheetParts = sheets.map(sheet => {
    const rows = sheet.rows.map((cells, r) => {
      const body = cells.map((value, c) => {
        if (value === "") return "";                       // Excel omits empties
        const reference = columnLetters(c) + (r + 1);
        return typeof value === "number"
          ? `<c r="${reference}"><v>${value}</v></c>`
          : `<c r="${reference}" t="s"><v>${indexOfString(String(value))}</v></c>`;
      }).join("");
      return `<row r="${r + 1}">${body}</row>`;
    }).join("");
    return `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  });

  const files = [
    {
      path: "[Content_Types].xml",
      text: `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`,
    },
    {
      path: "xl/workbook.xml",
      text: `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
        sheets.map((s, i) => `<sheet name="${escape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
        `</sheets></workbook>`,
    },
    {
      path: "xl/_rels/workbook.xml.rels",
      text: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        sheets.map((_s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
        `</Relationships>`,
    },
    {
      path: "xl/sharedStrings.xml",
      text: `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">` +
        shared.map(text => `<si><t>${escape(text)}</t></si>`).join("") + `</sst>`,
    },
    ...sheetParts.map((text, i) => ({ path: `xl/worksheets/sheet${i + 1}.xml`, text })),
  ];

  // Stored (uncompressed) entries — a second thing the reader has to cope with.
  const locals: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const raw = new TextEncoder().encode(file.text);
    const name = new TextEncoder().encode(file.path);
    const local = new Uint8Array(30 + name.length + raw.length);
    const head = new DataView(local.buffer, 0, 30);
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(8, 0, true);                            // stored
    head.setUint32(18, raw.length, true);
    head.setUint32(22, raw.length, true);
    head.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(raw, 30 + name.length);
    locals.push(local);

    const entry = new Uint8Array(46 + name.length);
    const dir = new DataView(entry.buffer, 0, 46);
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(10, 0, true);
    dir.setUint32(20, raw.length, true);
    dir.setUint32(24, raw.length, true);
    dir.setUint16(28, name.length, true);
    dir.setUint32(42, offset, true);
    entry.set(name, 46);
    directory.push(entry);
    offset += local.length;
  }
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, directory.reduce((n, e) => n + e.length, 0), true);
  endView.setUint32(16, offset, true);
  return await new Blob([...locals, ...directory, end] as BlobPart[]).arrayBuffer();
}

describe("workbook", () => {
  beforeEach(() => {
    expect(loadDataFromCsv(TUTORIAL_MAP)).toBe(true);
  });

  it("is supported in this environment", () => {
    expect(workbookIsSupported()).toBe(true);
  });

  it("splits a generated CSV into one table per section, keeping header order", () => {
    const { tables, preamble } = csvToTables(serializeLiveStateToCsv());
    expect(tables.map(table => table.section)).toEqual([
      "streams", "stages", "categories", "defaults", "params", "nodes", "edges",
    ]);
    expect(preamble.length).toBeGreaterThan(0);
    const boxes = tables.find(table => table.section === "nodes")!;
    // Order matters: a row is positional once it is a spreadsheet row.
    expect(boxes.header.slice(0, 6)).toEqual(
      ["id", "label", "description", "stream", "stage", "category"]);
    expect(boxes.rows.length).toBe(NODES.length);
    expect(boxes.notes.length).toBeGreaterThan(0);
  });

  it("round-trips a real map through a workbook without losing anything", async () => {
    const before = serializeLiveStateToCsv();
    const boxCount = NODES.length;
    const linkCount = EDGES.length;
    const streamCount = STREAMS.length;
    const stageCount = STAGES.length;
    const paramCount = PARAMS.length;
    const sampleBox = NODES.find(node => node.formula)!;
    const sampleFormula = sampleBox.formula;

    const workbook = await csvToWorkbookBlob(before);
    const csvBack = await workbookBufferToCsv(await workbook.arrayBuffer());

    expect(loadDataFromCsv(csvBack)).toBe(true);
    expect(NODES.length).toBe(boxCount);
    expect(EDGES.length).toBe(linkCount);
    expect(STREAMS.length).toBe(streamCount);
    expect(STAGES.length).toBe(stageCount);
    expect(PARAMS.length).toBe(paramCount);
    expect(NODES.find(node => node.id === sampleBox.id)!.formula).toBe(sampleFormula);

    // The strongest form: serializing the reloaded map reproduces the same
    // sections, row for row, as the map the workbook was built from.
    const beforeTables = csvToTables(before).tables;
    const afterTables = csvToTables(serializeLiveStateToCsv()).tables;
    expect(afterTables.map(t => t.section)).toEqual(beforeTables.map(t => t.section));
    for (let i = 0; i < beforeTables.length; i++) {
      expect(afterTables[i].header, beforeTables[i].section + " header").toEqual(beforeTables[i].header);
      expect(afterTables[i].rows, beforeTables[i].section + " rows").toEqual(beforeTables[i].rows);
    }
  });

  it("names the sheets in the app's own words and leads with a Read me", async () => {
    const workbook = await csvToWorkbookBlob(serializeLiveStateToCsv());
    const sheets = await readWorkbookSheets(await workbook.arrayBuffer());
    expect([...sheets.keys()]).toEqual([
      "Read me", "Rows", "Columns", "Categories", "Defaults", "Constants", "Boxes", "Links",
    ]);
    // The comment lines that clutter the CSV are carried, not thrown away.
    const readMe = sheets.get("Read me")!.flat().join("\n");
    expect(readMe).toContain("Ariadne Maps");
    expect(readMe).toContain("Boxes sheet");
  });

  it("carries the reviews section as its own sheet when a map has one", async () => {
    const withReview = TUTORIAL_MAP +
      "\n# SECTION: reviews\n" +
      "box,label,verdict,reviewer,date,note,flagged,fingerprint,flagged_on,flagged_by," +
      "addressed_on,addressed_by,addressed_note,removed_on\n" +
      "workshop_readiness,Workshop readiness,agreed,A Reviewer,2026-09-01,Checked.,,,,,,,,\n";
    expect(loadDataFromCsv(withReview)).toBe(true);

    const workbook = await csvToWorkbookBlob(serializeLiveStateToCsv());
    const sheets = await readWorkbookSheets(await workbook.arrayBuffer());
    expect([...sheets.keys()]).toContain("Reviews");
    const reviews = sheets.get("Reviews")!;
    expect(reviews[0][0]).toBe("box");
    expect(reviews[1][0]).toBe("workshop_readiness");
    expect(reviews[1][3]).toBe("A Reviewer");
  });

  it("writes numbers as numbers but never guesses at a text column", async () => {
    const csv = [
      "# SECTION: streams", "id,label,short,color", "007,Leading zeros,ZERO,#60a5fa", "",
      "# SECTION: stages", "id,label", "inputs,Inputs", "",
      "# SECTION: nodes",
      "id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max,combine,formula,min,max",
      "a,A box,,007,inputs,resource,2000,units,true,,2.5,,,,",
      "",
    ].join("\n");

    const workbook = await csvToWorkbookBlob(csv);
    const boxesXml = await sheetXmlFor(workbook, "Boxes");
    // baseline is a declared numeric column → a bare <v>, no inlineStr.
    expect(boxesXml).toContain("<v>2000</v>");
    // The row id is text, even though 007 looks numeric. Guessing would hand
    // back 7 and there would be no way to know it had happened.
    expect(boxesXml).toContain(">007<");

    const back = await workbookBufferToCsv(await workbook.arrayBuffer());
    expect(back).toContain("007,Leading zeros,ZERO,#60a5fa");
    expect(back).toMatch(/a,A box,,007,inputs,resource,2000,units,true,,2\.5/);
  });

  it("gives enumerated columns dropdowns that match what the loader accepts", async () => {
    const workbook = await csvToWorkbookBlob(serializeLiveStateToCsv());

    const linksXml = await sheetXmlFor(workbook, "Links");
    expect(linksXml).toContain("dataValidation");
    expect(linksXml).toContain(EFFECT_OPTIONS.join(","));
    expect(linksXml).toContain(EVIDENCE_STATUSES.join(","));

    const boxesXml = await sheetXmlFor(workbook, "Boxes");
    expect(boxesXml).toContain(COMBINE_OPTIONS.filter(Boolean).join(","));
    expect(boxesXml).toContain(DIRECTION_OPTIONS.filter(Boolean).join(","));
  });

  it("pads short rows so a column can never shift left", async () => {
    // Excel omits trailing empty cells. A reader that trusts cell ORDER rather
    // than the cell's own reference silently moves every later value one column
    // to the left, which is the quietest possible corruption.
    const buffer = await foreignWorkbook([
      { name: "Rows", rows: [["id", "label", "short", "color"], ["planning", "Planning", "", ""]] },
      { name: "Columns", rows: [["id", "label"], ["inputs", "Inputs"]] },
      {
        name: "Links",
        rows: [
          ["from", "to", "effect", "elasticity", "style", "description"],
          ["a", "b", "increases", 0.35, "", ""],
          ["b", "c", "enables", "", "", "trailing cells dropped"],
        ],
      },
    ]);

    const csv = await workbookBufferToCsv(buffer);
    const links = csvToTables(csv).tables.find(table => table.section === "edges")!;
    expect(links.header).toEqual(["from", "to", "effect", "elasticity", "style", "description"]);
    expect(links.rows[0]).toEqual(["a", "b", "increases", "0.35", "", ""]);
    expect(links.rows[1]).toEqual(["b", "c", "enables", "", "", "trailing cells dropped"]);
  });

  it("reads a workbook written the way Excel writes one", async () => {
    // Shared strings, stored (undeflated) entries, no styles part.
    const buffer = await foreignWorkbook([
      { name: "Rows", rows: [["id", "label", "short", "color"], ["planning", "Planning", "PLAN", "#60a5fa"]] },
      { name: "Columns", rows: [["id", "label"], ["inputs", "Inputs"], ["outcomes", "Outcomes"]] },
      {
        name: "Categories",
        rows: [["id", "label", "color", "text_color", "class"],
          ["resource", "Resource", "#cbb99a", "#1a1a1a", "primary"]],
      },
      {
        name: "Boxes",
        rows: [
          ["id", "label", "description", "stream", "stage", "category", "baseline", "unit"],
          ["a", "Repeated label", "", "planning", "inputs", "resource", 10, "each"],
          ["b", "Repeated label", "", "planning", "outcomes", "resource", 20, "each"],
        ],
      },
      { name: "Links", rows: [["from", "to", "effect"], ["a", "b", "increases"]] },
    ]);

    const csv = await workbookBufferToCsv(buffer);
    expect(loadDataFromCsv(csv)).toBe(true);
    expect(NODES.map(node => node.id).sort()).toEqual(["a", "b"]);
    // A shared string used twice must come back twice, not once.
    expect(NODES.filter(node => node.label === "Repeated label").length).toBe(2);
    expect(EDGES.length).toBe(1);
  });

  it("turns a date somebody retyped in Excel back into a date", async () => {
    // Excel converts a typed date to a serial counted from 1899-12-30.
    const buffer = await foreignWorkbook([
      { name: "Rows", rows: [["id", "label"], ["planning", "Planning"]] },
      { name: "Columns", rows: [["id", "label"], ["inputs", "Inputs"]] },
      {
        name: "Reviews",
        rows: [
          ["box", "label", "verdict", "reviewer", "date", "note"],
          ["a", "A box", "agreed", "A Reviewer", 46266, "typed over"],
        ],
      },
    ]);
    const csv = await workbookBufferToCsv(buffer);
    expect(csv).toContain("2026-09-01");
    expect(csv).not.toContain("46266");
  });

  it("ignores sheets it does not recognise rather than refusing the file", async () => {
    const buffer = await foreignWorkbook([
      { name: "Read me", rows: [["About this workbook"], ["notes"]] },
      { name: "Rows", rows: [["id", "label"], ["planning", "Planning"]] },
      { name: "Columns", rows: [["id", "label"], ["inputs", "Inputs"]] },
      { name: "My working notes", rows: [["anything", "at all"], ["a", "b"]] },
      {
        name: "Categories",
        rows: [["id", "label", "color", "text_color", "class"],
          ["resource", "Resource", "#cbb99a", "#1a1a1a", "primary"]],
      },
      {
        name: "Boxes",
        rows: [["id", "label", "stream", "stage", "category"], ["a", "A box", "planning", "inputs", "resource"]],
      },
    ]);
    const csv = await workbookBufferToCsv(buffer);
    expect(loadDataFromCsv(csv)).toBe(true);
    expect(NODES.length).toBe(1);
    expect(csv).not.toContain("My working notes");
  });

  it("refuses a workbook with nothing it recognises, and a file that is not one", async () => {
    const buffer = await foreignWorkbook([
      { name: "Sheet1", rows: [["something", "else"], ["a", "b"]] },
    ]);
    await expect(workbookBufferToCsv(buffer)).rejects.toThrow("no-recognised-sheets");

    const notAZip = await new Blob(["id,label\na,b\n"]).arrayBuffer();
    await expect(workbookBufferToCsv(notAZip)).rejects.toThrow();
  });

  it("accepts raw section names as sheet names too", async () => {
    const buffer = await foreignWorkbook([
      { name: "streams", rows: [["id", "label"], ["planning", "Planning"]] },
      { name: "stages", rows: [["id", "label"], ["inputs", "Inputs"]] },
      {
        name: "categories",
        rows: [["id", "label", "color", "text_color", "class"],
          ["resource", "Resource", "#cbb99a", "#1a1a1a", "primary"]],
      },
      {
        name: "nodes",
        rows: [["id", "label", "stream", "stage", "category"], ["a", "A box", "planning", "inputs", "resource"]],
      },
    ]);
    const csv = await workbookBufferToCsv(buffer);
    expect(loadDataFromCsv(csv)).toBe(true);
    expect(NODES.length).toBe(1);
  });

  it("still loads every .csv the repository ships, including pre-evidence ones", () => {
    // sample.csv, advanced_sample.csv, empty_template.csv, sample_uk_border.csv and
    // the 300-box border-force map were all written before evidence columns existed
    // and none of them has a reviews section. They are the closest thing to a
    // corpus of "what people already have on disk", and the workbook must not have
    // cost them anything.
    const files = readdirSync("assets/data").filter(name => name.endsWith(".csv"));
    expect(files.length).toBeGreaterThanOrEqual(5);

    for (const name of files) {
      const csv = readFileSync("assets/data/" + name, "utf8");
      if (name === "empty_template.csv") {
        // A blank form: section headers, no box rows. The loader has always
        // refused a map with no boxes, so the thing to check is that the FORMAT
        // is still understood — every section header still parses.
        const sections = csvToTables(csv).tables;
        expect(sections.map(table => table.section)).toContain("nodes");
        expect(sections.find(table => table.section === "nodes")!.rows.length).toBe(0);
        expect(loadDataFromCsv(csv), name + " is still an empty form").toBe(false);
        continue;
      }
      expect(loadDataFromCsv(csv), name + " loads").toBe(true);
      expect(NODES.length, name + " has boxes").toBeGreaterThan(0);
    }
  });

  it("carries a pre-evidence .csv through a workbook and back unchanged", async () => {
    // The older files have neither the evidence columns nor a reviews section, so
    // this is the round trip that would expose an exporter assuming either exists.
    for (const name of ["sample.csv", "advanced_sample.csv", "sample_uk_border.csv"]) {
      const csv = readFileSync("assets/data/" + name, "utf8");
      expect(loadDataFromCsv(csv), name).toBe(true);
      const boxes = NODES.length;
      const links = EDGES.length;
      const labels = NODES.map(node => node.label).join("|");

      const workbook = await csvToWorkbookBlob(serializeLiveStateToCsv());
      const back = await workbookBufferToCsv(await workbook.arrayBuffer());

      expect(loadDataFromCsv(back), name + " reloads from a workbook").toBe(true);
      expect(NODES.length, name + " box count").toBe(boxes);
      expect(EDGES.length, name + " link count").toBe(links);
      expect(NODES.map(node => node.label).join("|"), name + " labels").toBe(labels);
    }
  });

  it("accepts a minimal old-shape .csv with only the required sections", () => {
    // No defaults, no params, no reviews, no evidence, no optional box columns —
    // the smallest thing the loader has ever called a map.
    const csv = [
      "# SECTION: streams", "id,label", "ops,Operations", "",
      "# SECTION: stages", "id,label", "inputs,Inputs", "outputs,Outputs", "",
      "# SECTION: categories", "id,label,color", "resource,Resource,#cbb99a", "",
      "# SECTION: nodes", "id,label,stream,stage,category",
      "a,First,ops,inputs,resource", "b,Second,ops,outputs,resource", "",
      "# SECTION: edges", "from,to,effect", "a,b,increases", "",
    ].join("\n");
    expect(loadDataFromCsv(csv)).toBe(true);
    expect(NODES.map(node => node.id)).toEqual(["a", "b"]);
    expect(EDGES.length).toBe(1);
  });

  it("names spreadsheet columns beyond Z correctly", () => {
    expect(columnLetters(0)).toBe("A");
    expect(columnLetters(25)).toBe("Z");
    expect(columnLetters(26)).toBe("AA");
    expect(columnLetters(51)).toBe("AZ");
    expect(columnLetters(701)).toBe("ZZ");
  });

  it("escapes text that would otherwise break the XML", async () => {
    const csv = [
      "# SECTION: streams", "id,label,short,color", "planning,Planning,PLAN,#60a5fa", "",
      "# SECTION: stages", "id,label", "inputs,Inputs", "",
      "# SECTION: nodes",
      "id,label,description,stream,stage,category",
      'a,"A <box> & ""friends""",,planning,inputs,resource',
      "",
    ].join("\n");
    const workbook = await csvToWorkbookBlob(csv);
    const back = await workbookBufferToCsv(await workbook.arrayBuffer());
    const boxes = csvToTables(back).tables.find(table => table.section === "nodes")!;
    expect(boxes.rows[0][1]).toBe('A <box> & "friends"');
  });

  it("writes a CSV the section parser can read straight back", () => {
    const csv = tablesToCsv([
      { section: "streams", header: ["id", "label"], rows: [["planning", "Planning, with a comma"]], notes: [] },
    ]);
    const tables = csvToTables(csv).tables;
    expect(tables.length).toBe(1);
    expect(tables[0].rows[0]).toEqual(["planning", "Planning, with a comma"]);
  });
});
