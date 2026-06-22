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

// Split one CSV line into its cell values, honouring quoted strings.
// Returns an array of trimmed cell strings.
export function parseCsvLine(line: string): string[] {
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
  return cells.map(cell => cell.trim());
}

// Parse the whole multi-section CSV. Returns an object keyed by section name,
// where each value is an array of row objects ({ columnName: cellValue }).
export function parseCsvDocument(csvText: string): Record<string, Array<Record<string, string>>> {
  const lines = csvText.split(/\r?\n/);
  const sections: Record<string, Array<Record<string, string>>> = {};
  let currentSectionName: string | null = null;
  let currentHeader: string[] | null = null;
  let currentRows: Array<Record<string, string>> | null = null;

  for (const rawLine of lines) {
    const trimmedLine = rawLine.trim();

    // Detect "# SECTION: foo" markers.
    const sectionMatch = trimmedLine.match(/^#\s*SECTION:\s*([A-Za-z_][A-Za-z0-9_]*)/i);
    if (sectionMatch) {
      currentSectionName = sectionMatch[1].toLowerCase();
      currentHeader = null;
      currentRows = [];
      sections[currentSectionName] = currentRows;
      continue;
    }

    if (!trimmedLine) continue;                  // skip blank lines
    if (trimmedLine.startsWith("#")) continue;   // skip comments
    if (currentSectionName === null) continue;   // skip lines before first section

    const cells = parseCsvLine(rawLine);

    // First data row of a section = the header (column names).
    if (currentHeader === null) {
      currentHeader = cells.map(cell => cell.toLowerCase().trim().replace(/\s+/g, "_"));
      continue;
    }

    // Skip rows that are entirely empty.
    if (cells.every(cell => cell === "")) continue;

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
  if (raw === undefined || raw === null) return undefined;
  const stringValue = String(raw).trim();
  if (stringValue === "") return undefined;
  const parsed = parseFloat(stringValue);
  return isNaN(parsed) ? undefined : parsed;
}
