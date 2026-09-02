import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import { parseCsvDocument } from "../assets/js/05-csv-parser";
import type {
  CsvImportReadyMessage,
  CsvImportSummary,
  CsvImportWorkerResponse,
  PrepareCsvImportMessage,
} from "../assets/js/05b-csv-import-protocol";
import {
  CSV_IMPORT_PROGRESS_REVEAL_DELAY_MILLISECONDS,
  LARGE_MAP_BOX_WARNING_THRESHOLD,
  LARGE_MAP_FILE_WARNING_THRESHOLD_BYTES,
  LARGE_MAP_LINK_WARNING_THRESHOLD,
  cancelCsvImport,
  confirmPreparedCsvImport,
  formattedFileSize,
  largeMapAdvisoryReasons,
  readCsvFile,
  resetCsvImportWorkerFactory,
  setCsvImportWorkerFactory,
  type CsvImportWorkerPort,
} from "../assets/js/16-file-io";
import { NODES } from "../assets/js/03-state";
import { LINEAR_CSV, MULTICAT_CSV } from "./fixtures/graphs";

class ControlledCsvImportWorker implements CsvImportWorkerPort {
  onmessage: ((event: MessageEvent<CsvImportWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postedMessage: PrepareCsvImportMessage | null = null;
  terminated = false;

  postMessage(message: PrepareCsvImportMessage): void {
    this.postedMessage = message;
  }

  terminate(): void {
    this.terminated = true;
  }

  respond(message: CsvImportWorkerResponse): void {
    this.onmessage?.(new MessageEvent("message", { data: message }));
  }
}

function summaryFor(csvText: string, overrides: Partial<CsvImportSummary> = {}): CsvImportSummary {
  const sections = parseCsvDocument(csvText);
  const bytes = new TextEncoder().encode(csvText);
  return {
    fileByteCount: bytes.byteLength,
    sectionRowCounts: Object.fromEntries(
      Object.entries(sections).map(([sectionName, rows]) => [sectionName, rows.length]),
    ),
    totalRowCount: Object.values(sections).reduce((total, rows) => total + rows.length, 0),
    streamCount: sections.streams?.length || 0,
    stageCount: sections.stages?.length || 0,
    categoryCount: sections.categories?.length || 0,
    nodeCount: sections.nodes?.length || 0,
    edgeCount: sections.edges?.length || 0,
    parameterCount: sections.params?.length || 0,
    ignoredNodeCount: 0,
    ignoredEdgeCount: 0,
    fatalMessages: [],
    canIntegrate: true,
    ...overrides,
  };
}

function readyMessage(
  worker: ControlledCsvImportWorker,
  csvText: string,
  overrides: Partial<CsvImportSummary> = {},
): CsvImportReadyMessage {
  const requestIdentifier = worker.postedMessage!.requestIdentifier;
  return {
    type: "csv-import-ready",
    requestIdentifier,
    fileName: worker.postedMessage!.fileName,
    csvBytes: new TextEncoder().encode(csvText).buffer,
    sections: parseCsvDocument(csvText),
    summary: summaryFor(csvText, overrides),
  };
}

async function waitForWorker(workers: ControlledCsvImportWorker[]): Promise<ControlledCsvImportWorker> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const worker = workers[workers.length - 1];
    if (worker?.postedMessage) return worker;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error("CSV import worker did not receive a request");
}

describe("background CSV import flow", () => {
  const workers: ControlledCsvImportWorker[] = [];

  beforeEach(() => {
    cancelCsvImport();
    workers.length = 0;
    setCsvImportWorkerFactory(() => {
      const worker = new ControlledCsvImportWorker();
      workers.push(worker);
      return worker;
    });
    loadDataFromCsv(LINEAR_CSV);
    const layer = document.getElementById("csv-import-layer")!;
    layer.hidden = true;
  });

  afterEach(() => {
    cancelCsvImport();
    resetCsvImportWorkerFactory();
  });

  it("opens a quick small import without flashing the progress dialog", async () => {
    const outcomePromise = readCsvFile(new File([MULTICAT_CSV], "small.csv", { type: "text/csv" }));
    const worker = await waitForWorker(workers);

    worker.respond(readyMessage(worker, MULTICAT_CSV));

    await expect(outcomePromise).resolves.toBe("opened");
    expect(document.getElementById("csv-import-layer")!.hidden).toBe(true);
    expect(NODES.map(node => node.id)).toEqual(["n"]);
    expect(document.getElementById("load-feedback")!.textContent).toContain("Found 1 box and 0 links");
  });

  it("shows accessible progress only after the delayed reveal and can cancel safely", async () => {
    const originalNodeIdentifiers = NODES.map(node => node.id);
    const outcomePromise = readCsvFile(new File([MULTICAT_CSV], "slow.csv", { type: "text/csv" }));
    const worker = await waitForWorker(workers);
    const layer = document.getElementById("csv-import-layer")!;
    expect(layer.hidden).toBe(true);

    await new Promise(resolve => setTimeout(
      resolve,
      CSV_IMPORT_PROGRESS_REVEAL_DELAY_MILLISECONDS + 30,
    ));
    worker.respond({
      type: "csv-import-progress",
      requestIdentifier: worker.postedMessage!.requestIdentifier,
      phase: "validating",
      completed: 3,
      total: 4,
    });

    expect(layer.hidden).toBe(false);
    expect(document.getElementById("csv-import-status")!.getAttribute("role")).toBe("status");
    expect(document.getElementById("csv-import-status")!.getAttribute("aria-live")).toBe("polite");
    expect(document.getElementById("csv-import-status")!.textContent).toContain("Checking boxes and links");
    (document.querySelector("[data-csv-import-cancel]") as HTMLButtonElement).click();

    await expect(outcomePromise).resolves.toBe("cancelled");
    expect(worker.terminated).toBe(true);
    expect(NODES.map(node => node.id)).toEqual(originalNodeIdentifiers);
  });

  it("shows exact counts and size before an unusual valid map can replace the current map", async () => {
    const originalNodeIdentifiers = NODES.map(node => node.id);
    const outcomePromise = readCsvFile(new File([MULTICAT_CSV], "large.csv", { type: "text/csv" }));
    const worker = await waitForWorker(workers);
    worker.respond(readyMessage(worker, MULTICAT_CSV, {
      fileByteCount: LARGE_MAP_FILE_WARNING_THRESHOLD_BYTES,
      nodeCount: LARGE_MAP_BOX_WARNING_THRESHOLD,
      edgeCount: LARGE_MAP_LINK_WARNING_THRESHOLD,
    }));

    const layer = document.getElementById("csv-import-layer")!;
    expect(layer.hidden).toBe(false);
    expect(layer.dataset.state).toBe("warning");
    expect(document.getElementById("csv-import-status")!.textContent).toBe(
      "Found 1000 boxes and 2000 links in 5.0 MiB.",
    );
    expect(NODES.map(node => node.id)).toEqual(originalNodeIdentifiers);
    expect((document.querySelector("[data-csv-import-open]") as HTMLButtonElement).hidden).toBe(false);

    confirmPreparedCsvImport();
    await expect(outcomePromise).resolves.toBe("opened");
    expect(NODES.map(node => node.id)).toEqual(["n"]);
  });

  it("keeps the current map when the large-map confirmation is cancelled", async () => {
    const originalNodeIdentifiers = NODES.map(node => node.id);
    const outcomePromise = readCsvFile(new File([MULTICAT_CSV], "large.csv", { type: "text/csv" }));
    const worker = await waitForWorker(workers);
    worker.respond(readyMessage(worker, MULTICAT_CSV, {
      nodeCount: LARGE_MAP_BOX_WARNING_THRESHOLD,
    }));

    cancelCsvImport();

    await expect(outcomePromise).resolves.toBe("cancelled");
    expect(NODES.map(node => node.id)).toEqual(originalNodeIdentifiers);
  });

  it("treats every large-map threshold as an advisory reason, never invalidity", () => {
    const ordinarySummary = summaryFor(LINEAR_CSV);
    expect(largeMapAdvisoryReasons(ordinarySummary)).toEqual([]);
    expect(largeMapAdvisoryReasons({
      ...ordinarySummary,
      fileByteCount: LARGE_MAP_FILE_WARNING_THRESHOLD_BYTES,
    })).toContain("large file size");
    expect(largeMapAdvisoryReasons({
      ...ordinarySummary,
      nodeCount: LARGE_MAP_BOX_WARNING_THRESHOLD,
    })).toContain("many boxes");
    expect(largeMapAdvisoryReasons({
      ...ordinarySummary,
      edgeCount: LARGE_MAP_LINK_WARNING_THRESHOLD,
    })).toContain("many links");
    expect(ordinarySummary.canIntegrate).toBe(true);
    expect(formattedFileSize(5 * 1024 * 1024)).toBe("5.0 MiB");
  });
});
