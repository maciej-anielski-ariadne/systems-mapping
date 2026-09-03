// =============================================================================
// FILE INPUT / OUTPUT
// -----------------------------------------------------------------------------
// Everything to do with getting CSV data IN (reading dropped/picked files,
// loading the embedded sample) and OUT (saving the sample / template as a
// .csv file via the browser download mechanism).
//
// Also: showLoadFeedback() — the small toast that appears top-right after
// a load attempt, and the show/hide helpers for the drop-zone overlay.
// =============================================================================

import { SAMPLE_CSV } from "./01-sample-data";
import { state } from "./03-state";
import { loadDataFromCsv, loadDataFromParsedCsv } from "./06-data-loader";
import { csvToWorkbookBlob, workbookBufferToCsv, workbookIsSupported } from "./05c-workbook";
import type { ParsedCsvDocument } from "./05-csv-parser";
import type {
  CsvImportProgressMessage,
  CsvImportReadyMessage,
  CsvImportSummary,
  CsvImportWorkerResponse,
  PrepareCsvImportMessage,
} from "./05b-csv-import-protocol";
import { createCsvImportWorker } from "./05d-csv-import-worker-factory";

// Advisory only: every valid file remains openable. The ordinary 300-box,
// roughly one-link-per-box benchmark stays below these limits. The thresholds
// are intentionally generous and warn before a valid file replaces the current
// map; they are never parser limits or rejection rules.
export const LARGE_MAP_FILE_WARNING_THRESHOLD_BYTES = 5 * 1024 * 1024;
export const LARGE_MAP_BOX_WARNING_THRESHOLD = 1000;
export const LARGE_MAP_LINK_WARNING_THRESHOLD = 2000;
export const CSV_IMPORT_PROGRESS_REVEAL_DELAY_MILLISECONDS = 180;

export interface CsvImportWorkerPort {
  onmessage: ((event: MessageEvent<CsvImportWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: PrepareCsvImportMessage, transfer: Transferable[]): void;
  terminate(): void;
}

export type CsvImportOutcome = "opened" | "cancelled" | "failed" | "invalid-file";

interface PreparedCsvImport {
  csvText: string;
  sections: ParsedCsvDocument;
  summary: CsvImportSummary;
}

interface ActiveCsvImport {
  requestIdentifier: string;
  fileName: string;
  reader: FileReader | null;
  worker: CsvImportWorkerPort | null;
  prepared: PreparedCsvImport | null;
  revealTimer: ReturnType<typeof setTimeout> | null;
  integrationAnimationFrame: number;
  previouslyFocusedElement: HTMLElement | null;
  resolve: (outcome: CsvImportOutcome) => void;
}

let csvImportRequestSequence = 0;
let activeCsvImport: ActiveCsvImport | null = null;
let csvImportWorkerFactory: () => CsvImportWorkerPort = createCsvImportWorker;

/** Dependency seam used by unit tests and alternate worker packaging. */
export function setCsvImportWorkerFactory(factory: () => CsvImportWorkerPort): void {
  csvImportWorkerFactory = factory;
}

export function resetCsvImportWorkerFactory(): void {
  csvImportWorkerFactory = createCsvImportWorker;
}

function importLayer(): HTMLElement | null {
  return document.getElementById("csv-import-layer");
}

function importStatus(): HTMLElement | null {
  return document.getElementById("csv-import-status");
}

function importProgress(): HTMLProgressElement | null {
  return document.getElementById("csv-import-progress") as HTMLProgressElement | null;
}

function importAdvice(): HTMLElement | null {
  return document.getElementById("csv-import-advice");
}

function importOpenButton(): HTMLButtonElement | null {
  return document.querySelector("[data-csv-import-open]");
}

function importCancelButton(): HTMLButtonElement | null {
  return document.querySelector("[data-csv-import-cancel]");
}

function showImportLayer(): void {
  const layer = importLayer();
  if (!layer || !activeCsvImport) return;
  layer.hidden = false;
  importCancelButton()?.focus();
}

function hideImportLayer(): void {
  const layer = importLayer();
  if (layer) layer.hidden = true;
}

function updateImportProgress(message: string, completed?: number, total?: number): void {
  const status = importStatus();
  if (status) status.textContent = message;
  const progress = importProgress();
  if (!progress) return;
  if (typeof completed === "number" && typeof total === "number" && total > 0) {
    progress.value = Math.max(0, Math.min(100, (completed / total) * 100));
  } else {
    progress.removeAttribute("value");
  }
}

function prepareProgressLayer(fileName: string): void {
  const layer = importLayer();
  if (layer) layer.dataset.state = "progress";
  const title = document.getElementById("csv-import-title");
  if (title) title.textContent = "Preparing your map";
  const advice = importAdvice();
  if (advice) advice.textContent = "Your current map stays open until the new map is ready.";
  const openButton = importOpenButton();
  if (openButton) openButton.hidden = true;
  const cancelButton = importCancelButton();
  if (cancelButton) cancelButton.textContent = "Cancel";
  updateImportProgress("Reading " + fileName + "…");
}

function detectedCountMessage(summary: CsvImportSummary): string {
  return "Found " + summary.nodeCount + " " + (summary.nodeCount === 1 ? "box" : "boxes") +
    " and " + summary.edgeCount + " " + (summary.edgeCount === 1 ? "link" : "links") +
    " in " + formattedFileSize(summary.fileByteCount) + ".";
}

export function formattedFileSize(fileByteCount: number): string {
  if (fileByteCount < 1024) return fileByteCount + " B";
  if (fileByteCount < 1024 * 1024) return (fileByteCount / 1024).toFixed(1) + " KiB";
  return (fileByteCount / (1024 * 1024)).toFixed(1) + " MiB";
}

export function largeMapAdvisoryReasons(summary: CsvImportSummary): string[] {
  const reasons: string[] = [];
  if (summary.fileByteCount >= LARGE_MAP_FILE_WARNING_THRESHOLD_BYTES) reasons.push("large file size");
  if (summary.nodeCount >= LARGE_MAP_BOX_WARNING_THRESHOLD) reasons.push("many boxes");
  if (summary.edgeCount >= LARGE_MAP_LINK_WARNING_THRESHOLD) reasons.push("many links");
  return reasons;
}

function finishCsvImport(outcome: CsvImportOutcome): void {
  const activeImport = activeCsvImport;
  if (!activeImport) return;
  if (activeImport.revealTimer !== null) clearTimeout(activeImport.revealTimer);
  if (activeImport.integrationAnimationFrame && typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(activeImport.integrationAnimationFrame);
  }
  activeImport.worker?.terminate();
  hideImportLayer();
  activeCsvImport = null;
  if (activeImport.previouslyFocusedElement?.isConnected) {
    activeImport.previouslyFocusedElement.focus();
  }
  activeImport.resolve(outcome);
}

export function cancelCsvImport(): void {
  const activeImport = activeCsvImport;
  if (!activeImport) return;
  if (activeImport.reader?.readyState === FileReader.LOADING) activeImport.reader.abort();
  finishCsvImport("cancelled");
}

function failCsvImport(message: string): void {
  showLoadFeedback(message, true);
  finishCsvImport("failed");
}

function integratePreparedCsvImport(): void {
  const activeImport = activeCsvImport;
  const prepared = activeImport?.prepared;
  if (!activeImport || !prepared) return;
  updateImportProgress(detectedCountMessage(prepared.summary) + " Opening map…", 100, 100);
  let loaded: boolean;
  try {
    loaded = loadDataFromParsedCsv(prepared.csvText, prepared.sections);
  } catch (error) {
    console.error(error);
    failCsvImport("Import failed: " + (error as Error).message);
    return;
  }
  if (!loaded) {
    finishCsvImport("failed");
    return;
  }
  if (!state.loadErrors.length) {
    showLoadFeedback("Opened " + activeImport.fileName + ". " + detectedCountMessage(prepared.summary), false);
  }
  finishCsvImport("opened");
}

export function confirmPreparedCsvImport(): void {
  if (!activeCsvImport?.prepared) return;
  integratePreparedCsvImport();
}

function showLargeMapWarning(prepared: PreparedCsvImport): void {
  const layer = importLayer();
  if (layer) {
    layer.dataset.state = "warning";
    layer.hidden = false;
  }
  const title = document.getElementById("csv-import-title");
  if (title) title.textContent = "This is an unusually large map";
  updateImportProgress(detectedCountMessage(prepared.summary), 100, 100);
  const advice = importAdvice();
  if (advice) {
    advice.textContent = "This valid file can still be opened, but drawing it may take longer and interactions may feel slower on older hardware.";
  }
  const openButton = importOpenButton();
  if (openButton) {
    openButton.hidden = false;
    openButton.focus();
  }
}

function handleWorkerProgress(message: CsvImportProgressMessage): void {
  const phaseLabels: Record<CsvImportProgressMessage["phase"], string> = {
    decoding: "Reading spreadsheet text…",
    parsing: "Finding spreadsheet sections…",
    validating: "Checking boxes and links…",
  };
  const phaseOffsets: Record<CsvImportProgressMessage["phase"], [number, number]> = {
    decoding: [25, 40],
    parsing: [40, 70],
    validating: [70, 98],
  };
  const [start, end] = phaseOffsets[message.phase];
  const phaseProgress = message.total > 0 ? message.completed / message.total : 0;
  updateImportProgress(phaseLabels[message.phase], start + phaseProgress * (end - start), 100);
}

function handlePreparedImport(message: CsvImportReadyMessage): void {
  const activeImport = activeCsvImport;
  if (!activeImport || message.requestIdentifier !== activeImport.requestIdentifier) return;
  activeImport.worker?.terminate();
  activeImport.worker = null;
  if (!message.summary.canIntegrate) {
    failCsvImport("Import failed: " + (message.summary.fatalMessages.join(" ") || "The spreadsheet is incomplete."));
    return;
  }
  activeImport.prepared = {
    csvText: new TextDecoder().decode(message.csvBytes),
    sections: message.sections,
    summary: message.summary,
  };
  if (largeMapAdvisoryReasons(message.summary).length) {
    if (activeImport.revealTimer !== null) clearTimeout(activeImport.revealTimer);
    activeImport.revealTimer = null;
    showLargeMapWarning(activeImport.prepared);
    return;
  }

  const layerAlreadyVisible = !importLayer()?.hidden;
  updateImportProgress(detectedCountMessage(message.summary) + " Opening map…", 100, 100);
  if (layerAlreadyVisible && typeof requestAnimationFrame === "function") {
    activeImport.integrationAnimationFrame = requestAnimationFrame(() => {
      if (activeCsvImport === activeImport) integratePreparedCsvImport();
    });
  } else {
    integratePreparedCsvImport();
  }
}

function startBackgroundCsvPreparation(activeImport: ActiveCsvImport, csvBytes: ArrayBuffer): void {
  if (activeCsvImport !== activeImport) return;
  let worker: CsvImportWorkerPort;
  try {
    worker = csvImportWorkerFactory();
  } catch (error) {
    failCsvImport("Import failed: " + (error as Error).message);
    return;
  }
  activeImport.worker = worker;
  worker.onmessage = event => {
    const message = event.data;
    if (message.requestIdentifier !== activeImport.requestIdentifier || activeCsvImport !== activeImport) return;
    if (message.type === "csv-import-progress") handleWorkerProgress(message);
    else if (message.type === "csv-import-ready") handlePreparedImport(message);
    else failCsvImport("Import failed: " + message.message);
  };
  worker.onerror = event => {
    if (activeCsvImport !== activeImport) return;
    failCsvImport("Import failed: " + (event.message || "The background worker stopped."));
  };
  const message: PrepareCsvImportMessage = {
    type: "prepare-csv-import",
    requestIdentifier: activeImport.requestIdentifier,
    fileName: activeImport.fileName,
    csvBytes,
  };
  try {
    worker.postMessage(message, [csvBytes]);
  } catch (error) {
    failCsvImport("Import failed: " + (error as Error).message);
  }
}

// ───── Toast feedback (top-right corner) ──────────────────────────────────
export function showLoadFeedback(message: string, isError: boolean): void {
  const feedback = document.getElementById("load-feedback");
  if (!feedback) return;
  feedback.textContent = message;
  feedback.className = "load-feedback" + (isError ? " error" : "");
  feedback.style.display = "block";
  setTimeout(() => { feedback.style.display = "none"; }, 6000);
}

// ───── Drop-zone overlay visibility ───────────────────────────────────────
export function hideDropZone(): void {
  const dropZone = document.getElementById("drop-zone");
  if (dropZone) dropZone.style.display = "none";
  document.body.classList.remove("no-data");
}

export function showDropZone(): void {
  const dropZone = document.getElementById("drop-zone");
  if (dropZone) dropZone.style.display = "flex";
  document.body.classList.add("no-data");
}

// ───── Read a File object (from picker or drop) and load it ──────────────
/**
 * The single entry point for opening a map. A workbook is transcoded to CSV and
 * then handed to exactly the same reader, worker, validator and error messages a
 * .csv gets — there is one importer here, not two.
 *
 * .csv is still accepted. It is the format this app wrote for its whole life,
 * and refusing it would strand every map anyone has already saved.
 */
export async function readMapFile(file: File): Promise<CsvImportOutcome> {
  if (/\.xlsx$/i.test(file.name)) {
    if (!workbookIsSupported()) {
      showLoadFeedback("This browser cannot open .xlsx files. Try a .csv.", true);
      return "invalid-file";
    }
    let csvText: string;
    try {
      csvText = await workbookBufferToCsv(await file.arrayBuffer());
    } catch (error) {
      const reason = error instanceof Error && error.message === "no-recognised-sheets"
        ? "None of its sheets are ones this app writes — expected Boxes, Links, Rows and Columns."
        : "It could not be read as a workbook.";
      showLoadFeedback("Could not open " + file.name + ". " + reason, true);
      return "invalid-file";
    }
    return readCsvFile(new File([csvText], file.name.replace(/\.xlsx$/i, ".csv"), {
      type: "text/csv",
    }));
  }
  return readCsvFile(file);
}

export function readCsvFile(file: File): Promise<CsvImportOutcome> {
  if (!/\.csv$/i.test(file.name)) {
    showLoadFeedback("Expected a spreadsheet (.xlsx) or .csv file. Got: " + file.name, true);
    return Promise.resolve("invalid-file");
  }
  if (activeCsvImport) cancelCsvImport();

  return new Promise<CsvImportOutcome>(resolve => {
    const activeImport: ActiveCsvImport = {
      requestIdentifier: "csv-import-" + Date.now() + "-" + (++csvImportRequestSequence),
      fileName: file.name,
      reader: null,
      worker: null,
      prepared: null,
      revealTimer: null,
      integrationAnimationFrame: 0,
      previouslyFocusedElement: document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null,
      resolve,
    };
    activeCsvImport = activeImport;
    prepareProgressLayer(file.name);
    activeImport.revealTimer = setTimeout(() => {
      activeImport.revealTimer = null;
      if (activeCsvImport === activeImport) showImportLayer();
    }, CSV_IMPORT_PROGRESS_REVEAL_DELAY_MILLISECONDS);

    const reader = new FileReader();
    activeImport.reader = reader;
    reader.onprogress = event => {
      if (activeCsvImport !== activeImport) return;
      updateImportProgress(
        "Reading " + file.name + "…",
        event.lengthComputable ? event.loaded : undefined,
        event.lengthComputable ? event.total : undefined,
      );
    };
    reader.onload = event => {
      if (activeCsvImport !== activeImport) return;
      activeImport.reader = null;
      const csvBytes = event.target?.result;
      if (!(csvBytes instanceof ArrayBuffer)) {
        failCsvImport("Failed to read file.");
        return;
      }
      startBackgroundCsvPreparation(activeImport, csvBytes);
    };
    reader.onerror = () => {
      if (activeCsvImport === activeImport) failCsvImport("Failed to read file.");
    };
    reader.onabort = () => {
      if (activeCsvImport === activeImport) finishCsvImport("cancelled");
    };
    reader.readAsArrayBuffer(file);
  });
}

importCancelButton()?.addEventListener("click", cancelCsvImport);
importOpenButton()?.addEventListener("click", confirmPreparedCsvImport);
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && activeCsvImport && !importLayer()?.hidden) {
    event.preventDefault();
    cancelCsvImport();
  }
});

// ───── Trigger a download of a blob in the browser ──────────────────────
function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadCsvBlob(csvString: string, fileName: string): void {
  downloadBlob(new Blob([csvString], { type: "text/csv;charset=utf-8" }), fileName);
}

/**
 * The map as a workbook — the one editable format the app hands out. The CSV
 * still exists underneath as the transcoder's input, and is used verbatim if a
 * browser cannot deflate, so nobody is ever left unable to save their map.
 */
export async function downloadWorkbook(csvString: string, baseName: string): Promise<void> {
  if (!workbookIsSupported()) {
    downloadCsvBlob(csvString, baseName + ".csv");
    return;
  }
  try {
    downloadBlob(await csvToWorkbookBlob(csvString), baseName + ".xlsx");
  } catch {
    showLoadFeedback("Could not build the workbook. Saved as a .csv instead.", true);
    downloadCsvBlob(csvString, baseName + ".csv");
  }
}

export function downloadSampleCsv(): void {
  if (typeof SAMPLE_CSV === "undefined" || !SAMPLE_CSV) {
    showLoadFeedback("Sample CSV not embedded in this build.", true);
    return;
  }
  downloadCsvBlob(SAMPLE_CSV, "systems_map_sample.csv");
}

export function loadEmbeddedSample(): void {
  if (typeof SAMPLE_CSV === "undefined" || !SAMPLE_CSV) {
    showLoadFeedback("Sample CSV not embedded in this build.", true);
    return;
  }
  loadDataFromCsv(SAMPLE_CSV);
}
