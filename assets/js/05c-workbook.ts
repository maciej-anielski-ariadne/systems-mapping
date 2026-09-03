/* =============================================================================
 * WORKBOOK (.xlsx) — one sheet per CSV section
 * -----------------------------------------------------------------------------
 * The workbook is a TRANSCODER AROUND THE CSV, never a second model of a map.
 *
 *   live state → serializeLiveStateToCsv() → csv text → csvToWorkbookBlob() → .xlsx
 *   .xlsx → workbookBufferToCsv() → csv text → loadDataFromCsv()
 *
 * Everything therefore goes through the one serializer, the one loader and the
 * one validator. A workbook cannot drift from the CSV format because it is
 * generated from it, and an imported workbook gets exactly the error messages a
 * .csv gets, from the same code.
 *
 * An .xlsx is a zip of XML. The browser deflates natively via CompressionStream,
 * so there is no compression library here — only the zip container, the few
 * OOXML parts a spreadsheet needs, and the mapping between sheets and sections.
 *
 * What the workbook adds over the .csv, and why it is worth the bytes:
 *   • the `#` comment lines get a Read me sheet instead of being interleaved
 *     with data, which is what makes the .csv awkward to open in Excel;
 *   • enumerated columns get real dropdowns, so `incrases` cannot be typed;
 *   • numeric columns stay numeric, and text columns stay text — ids with
 *     leading zeros survive, which they would not if everything were guessed.
 * ========================================================================== */

import { BRAND_NAME } from "./00-brand";
import { parseCsvLine } from "./05-csv-parser";
import { csvRow } from "./05a-csv-serializer";
import { COMBINE_OPTIONS, DIRECTION_OPTIONS, EFFECT_OPTIONS } from "./02-config";
import { EVIDENCE_STATUSES } from "./07c-evidence";

export const WORKBOOK_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** A section lifted out of the CSV, or a sheet on its way back in. */
export interface WorkbookTable {
  /** The CSV section name: streams, stages, nodes, edges … */
  section: string;
  header: string[];
  rows: string[][];
  /** The `#` lines that introduced the section, for the Read me sheet. */
  notes: string[];
}

// ═════════════════════════════════════════════════════════════════════════════
// SHEET NAMES
// ═════════════════════════════════════════════════════════════════════════════
// Sheet tabs are read by people, so they use the words the rest of the app uses
// — rows and columns, not streams and stages. The CSV section names stay as they
// are: renaming those would break every file anyone has already saved.
const SHEET_NAME_BY_SECTION: Record<string, string> = {
  streams: "Rows",
  stages: "Columns",
  categories: "Categories",
  defaults: "Defaults",
  params: "Constants",
  reviews: "Reviews",
  nodes: "Boxes",
  edges: "Links",
};

const READ_ME_SHEET = "Read me";

function sectionForSheetName(sheetName: string): string | null {
  const wanted = sheetName.trim().toLowerCase();
  for (const section of Object.keys(SHEET_NAME_BY_SECTION)) {
    // Accept the raw section name too, so a workbook somebody built by hand with
    // a "nodes" tab loads as readily as one this app wrote with a "Boxes" tab.
    if (wanted === SHEET_NAME_BY_SECTION[section].toLowerCase() || wanted === section) return section;
  }
  return null;
}

// ═════════════════════════════════════════════════════════════════════════════
// COLUMN TYPES
// ═════════════════════════════════════════════════════════════════════════════
// Only columns named here are written as numbers. Guessing instead — "it looks
// like a number, make it one" — would turn an id of `007` into 7 on the way out
// and never give it back.
const NUMERIC_COLUMNS: Record<string, string[]> = {
  defaults: ["value"],
  params: ["value"],
  nodes: ["baseline", "slider_max", "min", "max"],
  edges: ["elasticity"],
};

// Written as text so Excel shows them as typed. Somebody who retypes one may
// still hand back a date serial, which is what readCell below undoes.
const DATE_COLUMNS: Record<string, string[]> = {
  nodes: ["formula_evidence_last_reviewed"],
  edges: ["evidence_last_reviewed"],
  reviews: ["date", "flagged_on", "addressed_on", "removed_on"],
};

// Dropdown lists, taken from the same constants the app's own dropdowns use so
// the two can never disagree about what the loader will accept.
const CHOICES: Record<string, Record<string, string[]>> = {
  nodes: {
    combine: COMBINE_OPTIONS.filter(Boolean),
    direction: DIRECTION_OPTIONS.filter(Boolean),
    controllable: ["true", "false"],
    formula_evidence_status: EVIDENCE_STATUSES.slice(),
  },
  edges: {
    effect: EFFECT_OPTIONS.slice(),
    style: ["dashed"],
    evidence_status: EVIDENCE_STATUSES.slice(),
  },
  categories: { class: ["primary", "secondary"] },
  reviews: { verdict: ["agreed", "flagged", "none"] },
};

// ═════════════════════════════════════════════════════════════════════════════
// CSV ⇄ TABLES
// ═════════════════════════════════════════════════════════════════════════════
/**
 * Split a generated CSV into its sections. Deliberately mirrors
 * parseCsvDocument's rules — `# SECTION:` marker, first data row is the header —
 * but keeps raw cells and the header's ORDER, which the row-object form loses.
 */
export function csvToTables(csvText: string): { tables: WorkbookTable[]; preamble: string[] } {
  const tables: WorkbookTable[] = [];
  const preamble: string[] = [];
  let current: WorkbookTable | null = null;

  for (const rawLine of csvText.split(/\r?\n/)) {
    const line = rawLine.trim();

    const marker = line.match(/^#\s*SECTION:\s*([A-Za-z_][A-Za-z0-9_]*)/i);
    if (marker) {
      current = { section: marker[1].toLowerCase(), header: [], rows: [], notes: [] };
      tables.push(current);
      continue;
    }
    if (line.startsWith("#")) {
      const note = line.replace(/^#\s?/, "");
      if (current) current.notes.push(note);
      else preamble.push(note);
      continue;
    }
    if (!line) continue;
    if (!current) continue;

    const cells = parseCsvLine(rawLine, { preserveCellWhitespace: true });
    if (!current.header.length) current.header = cells;
    else if (cells.some(cell => cell.trim() !== "")) current.rows.push(cells);
  }

  return { tables, preamble };
}

/** Tables back to a CSV the existing loader can read. */
export function tablesToCsv(tables: WorkbookTable[]): string {
  const lines: string[] = [
    BRAND_NAME
      ? "# " + BRAND_NAME + " — converted from a workbook (.xlsx)"
      : "# Converted from a workbook (.xlsx)",
    "# Drag this file back onto the app to reload it, or edit in Excel / Sheets.",
    "",
  ];
  for (const table of tables) {
    if (!table.header.length) continue;
    lines.push("# SECTION: " + table.section);
    lines.push(csvRow(table.header));
    for (const row of table.rows) lines.push(csvRow(row));
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

// ═════════════════════════════════════════════════════════════════════════════
// ZIP
// ═════════════════════════════════════════════════════════════════════════════
let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Whether this browser can deflate. Everything here needs it. */
export function workbookIsSupported(): boolean {
  return typeof CompressionStream === "function" && typeof DecompressionStream === "function";
}

/**
 * Fed from a ReadableStream rather than a Blob: `Blob.stream()` is missing in
 * some environments this code is tested in, and building a Blob only to stream
 * it straight back out is an allocation for nothing.
 */
function streamOf(bytes: Uint8Array<ArrayBuffer>): ReadableStream<BufferSource> {
  // BufferSource, not Uint8Array: that is what CompressionStream's writable side
  // is typed to accept, and a narrower source will not pipe into it.
  return new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}

async function deflateRaw(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  return collect(streamOf(bytes).pipeThrough(new CompressionStream("deflate-raw")));
}

async function inflateRaw(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  return collect(streamOf(bytes).pipeThrough(new DecompressionStream("deflate-raw")));
}

const encodeUtf8 = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);

async function zipFiles(files: { path: string; text: string }[]): Promise<Blob> {
  const locals: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const raw = encodeUtf8(file.text);
    const packed = await deflateRaw(raw);
    const name = encodeUtf8(file.path);
    const checksum = crc32(raw);

    const localHeader = new DataView(new ArrayBuffer(30));
    localHeader.setUint32(0, 0x04034b50, true);
    localHeader.setUint16(4, 20, true);
    localHeader.setUint16(8, 8, true);                     // deflate
    localHeader.setUint32(14, checksum, true);
    localHeader.setUint32(18, packed.length, true);
    localHeader.setUint32(22, raw.length, true);
    localHeader.setUint16(26, name.length, true);
    const local = new Uint8Array(30 + name.length + packed.length);
    local.set(new Uint8Array(localHeader.buffer), 0);
    local.set(name, 30);
    local.set(packed, 30 + name.length);
    locals.push(local);

    const centralHeader = new DataView(new ArrayBuffer(46));
    centralHeader.setUint32(0, 0x02014b50, true);
    centralHeader.setUint16(4, 20, true);
    centralHeader.setUint16(6, 20, true);
    centralHeader.setUint16(10, 8, true);
    centralHeader.setUint32(16, checksum, true);
    centralHeader.setUint32(20, packed.length, true);
    centralHeader.setUint32(24, raw.length, true);
    centralHeader.setUint16(28, name.length, true);
    centralHeader.setUint32(42, offset, true);
    const entry = new Uint8Array(46 + name.length);
    entry.set(new Uint8Array(centralHeader.buffer), 0);
    entry.set(name, 46);
    directory.push(entry);

    offset += local.length;
  }

  const directoryBytes = directory.reduce((total, entry) => total + entry.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, directoryBytes, true);
  end.setUint32(16, offset, true);

  return new Blob([...locals, ...directory, new Uint8Array(end.buffer)] as BlobPart[],
    { type: WORKBOOK_MIME });
}

async function unzipFiles(buffer: ArrayBuffer): Promise<Map<string, string>> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // The end-of-central-directory record is last, after a comment of unknown
  // length, so it is found by scanning backwards for its signature.
  let end = buffer.byteLength - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error("not-a-zip");

  const count = view.getUint16(end + 10, true);
  let pointer = view.getUint32(end + 16, true);
  const parts = new Map<string, string>();
  const decoder = new TextDecoder();

  for (let i = 0; i < count; i++) {
    if (pointer + 46 > buffer.byteLength) throw new Error("truncated-zip");
    const method = view.getUint16(pointer + 10, true);
    const packedSize = view.getUint32(pointer + 20, true);
    const nameLength = view.getUint16(pointer + 28, true);
    const extraLength = view.getUint16(pointer + 30, true);
    const commentLength = view.getUint16(pointer + 32, true);
    const localOffset = view.getUint32(pointer + 42, true);
    const path = decoder.decode(bytes.subarray(pointer + 46, pointer + 46 + nameLength));

    // The local header repeats the name and extra fields, and its extra field
    // length can differ from the central one — so the data offset has to be read
    // from the local header, not computed from the central directory.
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const packed = bytes.subarray(dataStart, dataStart + packedSize);
    parts.set(path, decoder.decode(method === 8 ? await inflateRaw(packed) : packed));

    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return parts;
}

// ═════════════════════════════════════════════════════════════════════════════
// XLSX WRITE
// ═════════════════════════════════════════════════════════════════════════════
type SheetCell = string | number;
interface SheetPlan {
  name: string;
  rows: SheetCell[][];
  choices?: { columnIndex: number; values: string[] }[];
}

const escapeXml = (text: string): string =>
  text.replace(/[<>&"']/g, character =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[character] as string));

/**
 * Strip the control characters XML 1.0 forbids outright. One of these in a cell
 * makes the whole file unopenable, and a map's description field is free text
 * that has been pasted from somewhere. Tab, newline and carriage return are
 * legal and deliberately kept.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;
const stripControlCharacters = (text: string): string => text.replace(CONTROL_CHARACTERS, "");

export function columnLetters(index: number): string {
  let letters = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  }
  return letters;
}

function sheetXml(sheet: SheetPlan): string {
  const rows = sheet.rows.map((cells, rowIndex) => {
    const body = cells.map((value, columnIndex) => {
      if (value === "" || value === null || value === undefined) return "";
      const reference = columnLetters(columnIndex) + (rowIndex + 1);
      const style = rowIndex === 0 ? ' s="1"' : "";
      if (typeof value === "number" && Number.isFinite(value)) {
        return `<c r="${reference}"${style}><v>${value}</v></c>`;
      }
      const text = escapeXml(stripControlCharacters(String(value)));
      return `<c r="${reference}"${style} t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
    }).join("");
    return `<row r="${rowIndex + 1}">${body}</row>`;
  }).join("");

  const lastRow = Math.max(sheet.rows.length, 2);
  const validations = (sheet.choices || []).map(choice => {
    const letters = columnLetters(choice.columnIndex);
    return `<dataValidation type="list" allowBlank="1" showInputMessage="0" showErrorMessage="1" ` +
      `sqref="${letters}2:${letters}${lastRow + 200}">` +
      `<formula1>&quot;${escapeXml(choice.values.join(","))}&quot;</formula1></dataValidation>`;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetViews><sheetView workbookViewId="0">` +
    `<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>` +
    `</sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>` +
    `<sheetData>${rows}</sheetData>` +
    (validations ? `<dataValidations count="${sheet.choices!.length}">${validations}</dataValidations>` : "") +
    `</worksheet>`;
}

const STYLES_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>` +
  `<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
  `<fills count="2"><fill><patternFill patternType="none"/></fill>` +
  `<fill><patternFill patternType="gray125"/></fill></fills>` +
  `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>` +
  // Excel refuses a styles part with no cellStyles entry; openpyxl only warns.
  `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
  `</styleSheet>`;

async function writeWorkbook(sheets: SheetPlan[]): Promise<Blob> {
  const files = [
    {
      path: "[Content_Types].xml",
      text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="${WORKBOOK_MIME}.main+xml"/>` +
        `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
        sheets.map((_sheet, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
        `</Types>`,
    },
    {
      path: "_rels/.rels",
      text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
        `</Relationships>`,
    },
    {
      path: "xl/workbook.xml",
      text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
        `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
        sheets.map((sheet, i) =>
          `<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
        `</sheets></workbook>`,
    },
    {
      path: "xl/_rels/workbook.xml.rels",
      text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        sheets.map((_sheet, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
        `<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        `</Relationships>`,
    },
    { path: "xl/styles.xml", text: STYLES_XML },
    ...sheets.map((sheet, i) => ({ path: `xl/worksheets/sheet${i + 1}.xml`, text: sheetXml(sheet) })),
  ];
  return zipFiles(files);
}

// ═════════════════════════════════════════════════════════════════════════════
// XLSX READ
// ═════════════════════════════════════════════════════════════════════════════
function parseXml(text: string): Document {
  const document = new DOMParser().parseFromString(text, "application/xml");
  if (document.getElementsByTagName("parsererror").length) throw new Error("bad-xml");
  return document;
}

function columnIndexOf(reference: string): number {
  let index = 0;
  for (const character of reference.replace(/[^A-Za-z]/g, "")) {
    index = index * 26 + (character.toUpperCase().charCodeAt(0) - 64);
  }
  return index - 1;
}

/**
 * Excel counts days from 1899-12-30 — the offset that absorbs its belief that
 * 1900 was a leap year. A date column that comes back as a bare number means
 * somebody retyped the cell and Excel converted it; give it back as text.
 */
function serialToIsoDate(serial: number): string {
  const milliseconds = Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000;
  return new Date(milliseconds).toISOString().slice(0, 10);
}

/** Read every sheet as a grid of strings, keyed by sheet name. */
export async function readWorkbookSheets(buffer: ArrayBuffer): Promise<Map<string, string[][]>> {
  const parts = await unzipFiles(buffer);

  // Excel writes text into a shared table and references it by index; this app's
  // own writer uses inline strings. Both have to be understood, because the file
  // coming back is usually one Excel has re-saved.
  const shared: string[] = [];
  const sharedText = parts.get("xl/sharedStrings.xml");
  if (sharedText) {
    for (const item of Array.from(parseXml(sharedText).getElementsByTagName("si"))) {
      // Runs (<r><t>…) have to be joined, or styled text loses everything after
      // its first change of formatting.
      shared.push(Array.from(item.getElementsByTagName("t"))
        .map(node => node.textContent || "").join(""));
    }
  }

  const targetByRelationshipId = new Map<string, string>();
  const relationships = parts.get("xl/_rels/workbook.xml.rels");
  if (relationships) {
    for (const relationship of Array.from(parseXml(relationships).getElementsByTagName("Relationship"))) {
      targetByRelationshipId.set(
        relationship.getAttribute("Id") || "",
        relationship.getAttribute("Target") || "",
      );
    }
  }

  const workbookText = parts.get("xl/workbook.xml");
  if (!workbookText) throw new Error("not-a-workbook");

  const sheets = new Map<string, string[][]>();
  for (const node of Array.from(parseXml(workbookText).getElementsByTagName("sheet"))) {
    const name = node.getAttribute("name") || "";
    const relationshipId = node.getAttribute("r:id") || node.getAttributeNS(
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") || "";
    let target = targetByRelationshipId.get(relationshipId) || "";
    if (!target) continue;
    target = target.replace(/^\/xl\//, "").replace(/^\/+/, "");
    const sheetText = parts.get(target.startsWith("xl/") ? target : "xl/" + target);
    if (!sheetText) continue;

    const grid: string[][] = [];
    for (const rowNode of Array.from(parseXml(sheetText).getElementsByTagName("row"))) {
      const row: string[] = [];
      for (const cellNode of Array.from(rowNode.getElementsByTagName("c"))) {
        const at = columnIndexOf(cellNode.getAttribute("r") || "A");
        const type = cellNode.getAttribute("t");
        let value: string;
        if (type === "inlineStr") {
          value = Array.from(cellNode.getElementsByTagName("t"))
            .map(node => node.textContent || "").join("");
        } else if (type === "s") {
          const index = Number(cellNode.getElementsByTagName("v")[0]?.textContent || "");
          value = shared[index] ?? "";
        } else {
          // Numbers, and formula cells, whose <v> holds the value Excel last
          // computed. Reading <f> instead would hand the loader "=B2*2".
          value = cellNode.getElementsByTagName("v")[0]?.textContent || "";
        }
        while (row.length < at) row.push("");
        row[at] = value;
      }
      grid.push(row);
    }
    sheets.set(name, grid);
  }
  return sheets;
}

// ═════════════════════════════════════════════════════════════════════════════
// PUBLIC
// ═════════════════════════════════════════════════════════════════════════════
/** A generated map CSV as a workbook, one sheet per section plus a Read me. */
export async function csvToWorkbookBlob(csvText: string): Promise<Blob> {
  const { tables, preamble } = csvToTables(csvText);

  const readMe: SheetCell[][] = [["About this workbook"]];
  for (const line of preamble) readMe.push([line]);
  for (const table of tables) {
    readMe.push([""]);
    readMe.push([(SHEET_NAME_BY_SECTION[table.section] || table.section) + " sheet"]);
    for (const note of table.notes) readMe.push([note]);
  }

  const sheets: SheetPlan[] = [{ name: READ_ME_SHEET, rows: readMe }];

  for (const table of tables) {
    if (!table.header.length) continue;
    const numeric = new Set(NUMERIC_COLUMNS[table.section] || []);
    const rows: SheetCell[][] = [table.header.slice()];

    for (const row of table.rows) {
      // Pad to the header width. A short row would otherwise leave later columns
      // shifted left when something reads the grid back positionally.
      const cells: SheetCell[] = [];
      for (let i = 0; i < table.header.length; i++) {
        const raw = row[i] === undefined ? "" : row[i];
        if (raw !== "" && numeric.has(table.header[i])) {
          const asNumber = Number(raw);
          cells.push(Number.isFinite(asNumber) ? asNumber : raw);
        } else {
          cells.push(raw);
        }
      }
      rows.push(cells);
    }

    const choicesForSection = CHOICES[table.section] || {};
    const choices = Object.keys(choicesForSection)
      .map(column => ({
        columnIndex: table.header.indexOf(column),
        values: choicesForSection[column],
      }))
      .filter(choice => choice.columnIndex >= 0 && choice.values.length > 0);

    sheets.push({ name: SHEET_NAME_BY_SECTION[table.section] || table.section, rows, choices });
  }

  return writeWorkbook(sheets);
}

/**
 * A workbook back to CSV text. Unknown sheets — Read me, and anything a reader
 * added of their own — are ignored rather than rejected: the point of handing
 * somebody a spreadsheet is that they can annotate it.
 */
export async function workbookBufferToCsv(buffer: ArrayBuffer): Promise<string> {
  const sheets = await readWorkbookSheets(buffer);
  const tables: WorkbookTable[] = [];

  for (const [sheetName, grid] of sheets) {
    const section = sectionForSheetName(sheetName);
    if (!section || !grid.length) continue;

    const header = (grid[0] || []).map(cell => cell.trim().toLowerCase().replace(/\s+/g, "_"));
    while (header.length && header[header.length - 1] === "") header.pop();
    if (!header.length) continue;

    const dateColumns = new Set(DATE_COLUMNS[section] || []);
    const rows: string[][] = [];

    for (const raw of grid.slice(1)) {
      const cells: string[] = [];
      for (let i = 0; i < header.length; i++) {
        let value = raw[i] === undefined ? "" : String(raw[i]).trim();
        if (value && dateColumns.has(header[i]) && /^\d+(\.\d+)?$/.test(value)) {
          const serial = Number(value);
          // Anything in this band is a date somebody's spreadsheet converted:
          // roughly 1954 to 2149. A real number in a date column would be wrong
          // whichever way it were read.
          if (serial > 20000 && serial < 91000) value = serialToIsoDate(serial);
        }
        cells.push(value);
      }
      if (cells.some(cell => cell !== "")) rows.push(cells);
    }

    tables.push({ section, header, rows, notes: [] });
  }

  if (!tables.length) throw new Error("no-recognised-sheets");
  return tablesToCsv(tables);
}
