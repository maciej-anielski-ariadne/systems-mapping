import { parseStrictFiniteNumber } from "./05b-input-validation";
import type { EvidenceStatus } from "./types";

// =============================================================================
// CSV PARSER — multi-section format with `# SECTION: <name>` delimiters
// -----------------------------------------------------------------------------
// The CSV format used by this app is not a plain table — it's a single .csv
// file that contains SIX tables (streams, stages, categories, defaults,
// nodes, edges) glued together with section markers like:
//
//     # SECTION: streams
//     id,label,short,color
//     air,Air Passenger,AIR,#60a5fa
//     ...
//
//     # SECTION: nodes
//     id,label,description,stream,stage,...
//     ...
//
// Rules:
//   • Lines starting with `#` are comments (ignored unless they're a SECTION
//     marker).
//   • Empty rows are ignored.
//   • The first non-comment row after a SECTION marker is the column header.
//   • Standard CSV quoting (double-quotes, doubled "" for an embedded quote)
//     is supported so descriptions can contain commas.
// =============================================================================

export interface CsvLineParseOptions {
  preserveCellWhitespace?: boolean;
}

// Split one CSV line into its cell values, honouring quoted strings. The public
// one-line helper keeps its historical trimmed default; the document parser
// opts into authored whitespace so identity validation can reject (rather than
// silently repair) padded ids and free-text fields can round-trip exactly.
export function parseCsvLine(line: string, options?: CsvLineParseOptions): string[] {
  const preserveCellWhitespace = options?.preserveCellWhitespace === true;
  // Fast path: a line with no double-quote needs no state machine at all —
  // split on commas and trim. The character-by-character loop below builds
  // every cell one string-append at a time, which is ~4× slower and allocates
  // millions of transient strings on a large file; the overwhelming majority
  // of real rows are quote-free. Quoted rows fall through to the untouched
  // state machine, so round-trip semantics are bit-identical.
  if (line.indexOf('"') === -1) {
    const parts = line.split(",");
    if (preserveCellWhitespace) return parts;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.length && (part.charCodeAt(0) <= 32 || part.charCodeAt(part.length - 1) <= 32)) {
        parts[i] = part.trim();
      }
    }
    return parts;
  }

  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const character = line[i];

    if (inQuotes) {
      if (character === '"') {
        // Two double-quotes in a row → a literal " inside the value.
        if (line[i + 1] === '"') { current += '"'; i++; }
        else inQuotes = false;
      } else {
        current += character;
      }
    } else {
      if (character === ",") {
        cells.push(current);
        current = "";
      } else if (character === '"') {
        inQuotes = true;
      } else {
        current += character;
      }
    }
  }
  cells.push(current);
  return preserveCellWhitespace ? cells : cells.map(cell => cell.trim());
}

// Split a complete CSV document into logical records. A quoted field may span
// several physical lines, so splitting the source text on every newline would
// turn one valid row into several malformed rows. Keep quote state across line
// endings and preserve line endings that are part of a quoted field.
function splitCsvRecords(csvText: string): string[] {
  const records: string[] = [];
  let currentRecord = "";
  let insideQuotedField = false;

  for (let characterIndex = 0; characterIndex < csvText.length; characterIndex++) {
    const character = csvText[characterIndex];

    if (character === '"') {
      currentRecord += character;

      // A doubled quote inside a quoted field is an escaped literal quote, not
      // the end of that field. Preserve both characters for parseCsvLine().
      if (insideQuotedField && csvText[characterIndex + 1] === '"') {
        currentRecord += '"';
        characterIndex++;
      } else {
        insideQuotedField = !insideQuotedField;
      }
      continue;
    }

    if (!insideQuotedField && (character === "\n" || character === "\r")) {
      // Treat CRLF as one record boundary. Lone CR and LF line endings remain
      // supported, while CRLF inside a quoted field is preserved above.
      if (character === "\r" && csvText[characterIndex + 1] === "\n") {
        characterIndex++;
      }
      records.push(currentRecord);
      currentRecord = "";
      continue;
    }

    currentRecord += character;
  }

  // Match String.split() behaviour closely enough for the document parser:
  // the final empty record is harmless because blank records are ignored.
  records.push(currentRecord);
  return records;
}

// Parse the whole multi-section CSV. Returns an object keyed by section name,
// where each value is an array of row objects ({ columnName: cellValue }).
export function parseCsvDocument(csvText: string): Record<string, Array<Record<string, string>>> {
  const records = splitCsvRecords(csvText);
  const sections: Record<string, Array<Record<string, string>>> = {};
  let currentSectionName: string | null = null;
  let currentHeader: string[] | null = null;
  let currentRows: Array<Record<string, string>> | null = null;

  for (const rawRecord of records) {
    const trimmedRecord = rawRecord.trim();

    // Detect "# SECTION: foo" markers.
    const sectionMatch = trimmedRecord.match(/^#\s*SECTION:\s*([A-Za-z_][A-Za-z0-9_]*)/i);
    if (sectionMatch) {
      currentSectionName = sectionMatch[1].toLowerCase();
      currentHeader = null;
      currentRows = [];
      sections[currentSectionName] = currentRows;
      continue;
    }

    if (!trimmedRecord) continue;                  // skip blank records
    if (trimmedRecord.startsWith("#")) continue;   // skip comments
    if (currentSectionName === null) continue;   // skip lines before first section

    const cells = parseCsvLine(rawRecord, { preserveCellWhitespace: true });

    // First data row of a section = the header (column names).
    if (currentHeader === null) {
      currentHeader = cells.map(cell => cell.toLowerCase().trim().replace(/\s+/g, "_"));
      continue;
    }

    // Skip rows that are entirely empty.
    if (cells.every(cell => cell.trim() === "")) continue;

    // Build a row object using the header names as keys.
    const row: Record<string, string> = {};
    for (let columnIndex = 0; columnIndex < currentHeader.length; columnIndex++) {
      row[currentHeader[columnIndex]] = cells[columnIndex] !== undefined ? cells[columnIndex] : "";
    }
    currentRows!.push(row);
  }

  return sections;
}

// Interpret a CSV cell as a boolean. Accepts "true", "yes", "1", "y".
export function parseBooleanCell(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false;
  const value = String(raw).trim().toLowerCase();
  return value === "true" || value === "yes" || value === "1" || value === "y";
}

// Interpret a CSV cell as a number. Returns `undefined` if empty / not a number.
export function parseNumericCell(raw: unknown): number | undefined {
  return parseStrictFiniteNumber(raw);
}

// Evidence status is deliberately informational: an absent or unrecognised
// value cannot affect loading or simulation. Normalise recognised spelling to
// the canonical stored form and make every legacy blank explicitly
// "unspecified" in the runtime model.
const EVIDENCE_STATUS_BY_LOWERCASE: Record<string, EvidenceStatus> = {
  unspecified: "unspecified",
  hypothesis: "hypothesis",
  supported: "supported",
  calibrated: "calibrated",
  validated: "validated",
};

export function parseEvidenceStatusCell(raw: unknown): EvidenceStatus {
  if (raw === undefined || raw === null) return "unspecified";
  return EVIDENCE_STATUS_BY_LOWERCASE[String(raw).trim().toLowerCase()] || "unspecified";
}
