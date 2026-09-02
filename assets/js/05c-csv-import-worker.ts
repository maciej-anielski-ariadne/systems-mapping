// =============================================================================
// DEDICATED CSV IMPORT WORKER
// -----------------------------------------------------------------------------
// Receives ownership of a file's bytes, parses and preflights them off the UI
// thread, then returns both the parsed sections and the original bytes. The
// browser thread decides whether to integrate the prepared transaction.
// =============================================================================

import {
  prepareCsvImportFromBytes,
  type CsvImportFailedMessage,
  type CsvImportProgressMessage,
  type CsvImportReadyMessage,
  type PrepareCsvImportMessage,
} from "./05b-csv-import-protocol";

interface CsvImportWorkerScope {
  onmessage: ((event: MessageEvent<PrepareCsvImportMessage>) => void) | null;
  postMessage(
    message: CsvImportProgressMessage | CsvImportReadyMessage | CsvImportFailedMessage,
    transfer?: Transferable[],
  ): void;
}

const csvImportWorkerScope = globalThis as unknown as CsvImportWorkerScope;

csvImportWorkerScope.onmessage = event => {
  const message = event.data;
  if (!message || message.type !== "prepare-csv-import") return;

  try {
    const readyMessage = prepareCsvImportFromBytes(
      message,
      progressMessage => csvImportWorkerScope.postMessage(progressMessage),
    );
    csvImportWorkerScope.postMessage(readyMessage, [readyMessage.csvBytes]);
  } catch (error) {
    csvImportWorkerScope.postMessage({
      type: "csv-import-failed",
      requestIdentifier: message.requestIdentifier,
      message: error instanceof Error ? error.message : "Unknown CSV import error",
    });
  }
};
