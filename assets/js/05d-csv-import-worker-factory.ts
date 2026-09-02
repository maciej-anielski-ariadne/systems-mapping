import CsvImportWorker from "./05c-csv-import-worker?worker";

/** Create the separately cached, hashed worker used by development and hosted builds. */
export function createCsvImportWorker(): Worker {
  return new CsvImportWorker({ name: "csv-import-worker" });
}
