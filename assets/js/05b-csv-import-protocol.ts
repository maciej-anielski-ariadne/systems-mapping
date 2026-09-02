// =============================================================================
// BACKGROUND CSV IMPORT PROTOCOL
// -----------------------------------------------------------------------------
// Serializable messages shared by the browser thread and the dedicated CSV
// worker. This module deliberately contains no DOM or live-map state.
// =============================================================================

import { EFFECT_OPTIONS } from "./02-config";
import {
  parseCsvDocument,
  parseNumericCell,
  type ParsedCsvDocument,
} from "./05-csv-parser";
import { isCanonicalIdentifier } from "./05b-input-validation";

export type CsvImportProgressPhase = "decoding" | "parsing" | "validating";

export interface CsvImportProgressMessage {
  type: "csv-import-progress";
  requestIdentifier: string;
  phase: CsvImportProgressPhase;
  completed: number;
  total: number;
}

export interface CsvImportSummary {
  fileByteCount: number;
  sectionRowCounts: Record<string, number>;
  totalRowCount: number;
  streamCount: number;
  stageCount: number;
  categoryCount: number;
  nodeCount: number;
  edgeCount: number;
  parameterCount: number;
  ignoredNodeCount: number;
  ignoredEdgeCount: number;
  fatalMessages: string[];
  canIntegrate: boolean;
}

export interface PrepareCsvImportMessage {
  type: "prepare-csv-import";
  requestIdentifier: string;
  fileName: string;
  csvBytes: ArrayBuffer;
}

export interface CsvImportReadyMessage {
  type: "csv-import-ready";
  requestIdentifier: string;
  fileName: string;
  csvBytes: ArrayBuffer;
  sections: ParsedCsvDocument;
  summary: CsvImportSummary;
}

export interface CsvImportFailedMessage {
  type: "csv-import-failed";
  requestIdentifier: string;
  message: string;
}

export type CsvImportWorkerResponse =
  | CsvImportProgressMessage
  | CsvImportReadyMessage
  | CsvImportFailedMessage;

export interface CsvImportAnalysisProgress {
  completed: number;
  total: number;
}

function countRows(sections: ParsedCsvDocument): Record<string, number> {
  const sectionRowCounts: Record<string, number> = Object.create(null);
  for (const [sectionName, rows] of Object.entries(sections)) {
    sectionRowCounts[sectionName] = rows.length;
  }
  return sectionRowCounts;
}

function dimensionHasFatalIdentifierProblem(
  rows: Array<Record<string, string>>,
  dimensionName: string,
  fatalMessages: string[],
): boolean {
  const seenIdentifiers = new Set<string>();
  let hasFatalIdentifierProblem = false;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const identifier = rows[rowIndex].id;
    if (!identifier) {
      fatalMessages.push(
        "The " + dimensionName + " at row " + (rowIndex + 1) + " has no id.",
      );
      hasFatalIdentifierProblem = true;
    } else if (!isCanonicalIdentifier(identifier)) {
      fatalMessages.push("The " + dimensionName + " id `" + identifier + "` is not canonical.");
      hasFatalIdentifierProblem = true;
    } else if (seenIdentifiers.has(identifier)) {
      fatalMessages.push("The " + dimensionName + " id `" + identifier + "` appears more than once.");
      hasFatalIdentifierProblem = true;
    }
    if (identifier) seenIdentifiers.add(identifier);
  }
  return hasFatalIdentifierProblem;
}

/**
 * Perform the transaction-gating checks and useful accepted-row counts that do
 * not depend on DOM state, formula caches, simulation, or layout. The loader
 * remains the authority and repeats these safety checks when the user accepts;
 * keeping this result advisory ensures a worker result can never mutate state.
 */
export function analyseParsedCsvDocument(
  sections: ParsedCsvDocument,
  fileByteCount: number,
  onProgress?: (progress: CsvImportAnalysisProgress) => void,
): CsvImportSummary {
  const sectionRowCounts = countRows(sections);
  const totalRowCount = Object.values(sectionRowCounts)
    .reduce((sum, rowCount) => sum + rowCount, 0);
  const fatalMessages: string[] = [];
  const requiredSections = ["streams", "stages", "categories", "nodes"] as const;
  for (const sectionName of requiredSections) {
    if (!sections[sectionName]?.length) {
      fatalMessages.push("The spreadsheet has no non-empty `" + sectionName + "` section.");
    }
  }

  let completedRows = 0;
  const reportRows = (rowCount: number): void => {
    completedRows += rowCount;
    onProgress?.({ completed: completedRows, total: Math.max(1, totalRowCount) });
  };
  onProgress?.({ completed: 0, total: Math.max(1, totalRowCount) });

  const streamRows = sections.streams || [];
  const stageRows = sections.stages || [];
  const categoryRows = sections.categories || [];
  const streamIdentifiersAreFatal = dimensionHasFatalIdentifierProblem(
    streamRows,
    "row",
    fatalMessages,
  );
  const stageIdentifiersAreFatal = dimensionHasFatalIdentifierProblem(
    stageRows,
    "column",
    fatalMessages,
  );
  const categoryIdentifiersAreFatal = dimensionHasFatalIdentifierProblem(
    categoryRows,
    "category",
    fatalMessages,
  );
  const dimensionIdentifiersAreFatal = streamIdentifiersAreFatal ||
    stageIdentifiersAreFatal || categoryIdentifiersAreFatal;
  reportRows(streamRows.length + stageRows.length + categoryRows.length);

  const streamIdentifiers = new Set(streamRows.map(row => row.id));
  const stageIdentifiers = new Set(stageRows.map(row => row.id));
  const categoryIdentifiers = new Set(categoryRows.map(row => row.id));
  const seenNodeIdentifiers = new Set<string>();
  const acceptedNodeIdentifiers = new Set<string>();
  let ignoredNodeCount = 0;
  for (const row of sections.nodes || []) {
    const nodeIdentifierIsUsable = !!row.id && isCanonicalIdentifier(row.id);
    const nodeIdentifierIsUnique = nodeIdentifierIsUsable && !seenNodeIdentifiers.has(row.id);
    if (nodeIdentifierIsUnique) seenNodeIdentifiers.add(row.id);
    const categoryIdentifiersForNode = String(row.category == null ? "" : row.category)
      .split("|")
      .filter(Boolean);
    const nodeCanLoad = nodeIdentifierIsUnique &&
      streamIdentifiers.has(row.stream) &&
      stageIdentifiers.has(row.stage) &&
      categoryIdentifiersForNode.some(identifier => categoryIdentifiers.has(identifier));
    if (nodeCanLoad) acceptedNodeIdentifiers.add(row.id);
    else ignoredNodeCount++;
  }
  reportRows((sections.nodes || []).length);

  if (!dimensionIdentifiersAreFatal && sections.nodes?.length && acceptedNodeIdentifiers.size === 0) {
    fatalMessages.push("No box has a usable id and valid row, column, and category references.");
  }

  let edgeCount = 0;
  let ignoredEdgeCount = 0;
  for (const row of sections.edges || []) {
    if (!row.from || !row.to) {
      // The loader silently skips blank/incomplete link rows, so do not count
      // them as ignored findings in the preview either.
      continue;
    }
    const effect = (row.effect || "enables").trim().toLowerCase();
    const edgeCanLoad = isCanonicalIdentifier(row.from) &&
      isCanonicalIdentifier(row.to) &&
      acceptedNodeIdentifiers.has(row.from) &&
      acceptedNodeIdentifiers.has(row.to) &&
      EFFECT_OPTIONS.includes(effect);
    if (edgeCanLoad) edgeCount++;
    else ignoredEdgeCount++;
  }
  reportRows((sections.edges || []).length);

  const seenParameterIdentifiers = new Set<string>();
  let parameterCount = 0;
  for (const row of sections.params || []) {
    const parameterIdentifierIsUsable = !!row.id && isCanonicalIdentifier(row.id);
    const parameterIdentifierIsUnique = parameterIdentifierIsUsable &&
      !seenParameterIdentifiers.has(row.id);
    if (parameterIdentifierIsUnique) seenParameterIdentifiers.add(row.id);
    const parameterCanLoad = parameterIdentifierIsUnique &&
      !acceptedNodeIdentifiers.has(row.id) &&
      parseNumericCell(row.value) !== undefined;
    if (!parameterCanLoad) continue;
    parameterCount++;
  }
  reportRows((sections.params || []).length);

  // Account for optional sections that need no preflight work so progress ends
  // at the advertised total even for maps carrying defaults or review records.
  completedRows = totalRowCount;
  onProgress?.({ completed: totalRowCount, total: Math.max(1, totalRowCount) });

  return {
    fileByteCount,
    sectionRowCounts,
    totalRowCount,
    streamCount: streamRows.length,
    stageCount: stageRows.length,
    categoryCount: categoryRows.length,
    nodeCount: acceptedNodeIdentifiers.size,
    edgeCount,
    parameterCount,
    ignoredNodeCount,
    ignoredEdgeCount,
    fatalMessages,
    canIntegrate: fatalMessages.length === 0,
  };
}

function decodeAndParseCsvImport(
  message: PrepareCsvImportMessage,
  reportProgress: (message: CsvImportProgressMessage) => void,
): ParsedCsvDocument {
  reportProgress({
    type: "csv-import-progress",
    requestIdentifier: message.requestIdentifier,
    phase: "decoding",
    completed: 0,
    total: Math.max(1, message.csvBytes.byteLength),
  });
  const csvText = new TextDecoder().decode(message.csvBytes);
  reportProgress({
    type: "csv-import-progress",
    requestIdentifier: message.requestIdentifier,
    phase: "decoding",
    completed: message.csvBytes.byteLength,
    total: Math.max(1, message.csvBytes.byteLength),
  });

  return parseCsvDocument(csvText, {
    onProgress(progress) {
      reportProgress({
        type: "csv-import-progress",
        requestIdentifier: message.requestIdentifier,
        phase: "parsing",
        completed: progress.processedCharacters,
        total: Math.max(1, progress.totalCharacters),
      });
    },
  });
}

/** Decode, parse, and preflight transferred file bytes without touching live state. */
export function prepareCsvImportFromBytes(
  message: PrepareCsvImportMessage,
  reportProgress: (message: CsvImportProgressMessage) => void,
): CsvImportReadyMessage {
  // decodeAndParseCsvImport owns the decoded whole-file string so it becomes
  // collectible before the prepared result is structured-cloned to the UI.
  const sections = decodeAndParseCsvImport(message, reportProgress);
  const summary = analyseParsedCsvDocument(
    sections,
    message.csvBytes.byteLength,
    progress => reportProgress({
      type: "csv-import-progress",
      requestIdentifier: message.requestIdentifier,
      phase: "validating",
      completed: progress.completed,
      total: progress.total,
    }),
  );

  return {
    type: "csv-import-ready",
    requestIdentifier: message.requestIdentifier,
    fileName: message.fileName,
    csvBytes: message.csvBytes,
    sections,
    summary,
  };
}
