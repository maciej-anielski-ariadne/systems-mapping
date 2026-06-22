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
import { loadDataFromCsv } from "./06-data-loader";

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
export function readCsvFile(file: File): void {
  if (!file) return;
  if (!/\.csv$/i.test(file.name)) {
    showLoadFeedback("Expected a .csv file. Got: " + file.name, true);
    return;
  }

  const reader = new FileReader();
  reader.onload = event => {
    try {
      loadDataFromCsv((event.target as FileReader).result as string);
    } catch (err) {
      console.error(err);
      showLoadFeedback("Parse error: " + (err as Error).message, true);
    }
  };
  reader.onerror = () => showLoadFeedback("Failed to read file.", true);
  reader.readAsText(file);
}

// ───── Trigger a download of a CSV string in the browser ────────────────
export function downloadCsvBlob(csvString: string, fileName: string): void {
  const blob = new Blob([csvString], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
