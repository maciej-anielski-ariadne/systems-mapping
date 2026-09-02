import InlineCsvImportWorker from "./05c-csv-import-worker?worker&inline";

/** Create the Blob-backed worker embedded inside the downloadable offline file. */
export function createCsvImportWorker(): Worker {
  return new InlineCsvImportWorker({ name: "csv-import-worker" });
}
