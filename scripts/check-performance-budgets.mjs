import { readFile, readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { gzipSync } from "node:zlib";

const OFFLINE_ARTIFACT_PATH = "dist/systems-map.html";
const HOSTED_OUTPUT_DIRECTORY = "dist-hosted";

// Raised 2026-09-03 for the Learn restructure: the calculation reference moved
// out of the guided tour into a browsable shelf (26a-learn-reference.ts), and a
// second, smaller example map joined the bundle. The prose compresses well, so
// the cost users actually pay is +8.2KB on cold transfer, about 2.9%.
//
// Raised again 2026-09-03 for the workbook format (05c-workbook.ts), which
// replaced the .csv as the map's editable export and import. It is +12.3KB of
// JavaScript raw, +4.2KB gzipped, about 1.4% on cold transfer. There is no zip
// or spreadsheet library in that figure — the browser deflates natively through
// CompressionStream, so the only code here is the zip container, the OOXML
// parts and the mapping between sheets and CSV sections.
//
// Raised again 2026-09-03 for the in-app confirm dialog (04c-confirm.ts).
// window.confirm() is suppressed in embedded browsers and silenced for the
// session once someone ticks the browser's "block additional dialogs" box, and
// a suppressed confirm returns false — so five destructive actions silently did
// nothing. About 2KB raw for a dialog the app controls and can test.
//
// Nudged 2026-09-03 for the formula field, which became a wrapping textarea on
// a row of its own: the 143px value slot showed 21 characters of a 120-character
// formula. Under a kilobyte of JavaScript for the auto-size and newline guard.
const performanceBudgets = {
  offlineRawBytes: 931_000,
  offlineGzipBytes: 306_000,
  hostedMainJavaScriptRawBytes: 636_000,
  hostedWorkerJavaScriptRawBytes: 6_000,
  hostedTotalJavaScriptRawBytes: 641_000,
  hostedCssRawBytes: 166_000,
  hostedColdTransferBytes: 302_000,
  offlineEmbeddedFontPayloads: 4,
};

async function collectFiles(directoryPath) {
  const directoryEntries = await readdir(directoryPath, { withFileTypes: true });
  const nestedFiles = await Promise.all(directoryEntries.map(async directoryEntry => {
    const entryPath = join(directoryPath, directoryEntry.name);
    return directoryEntry.isDirectory() ? collectFiles(entryPath) : [entryPath];
  }));
  return nestedFiles.flat();
}

function compressedTransferBytes(filePath, fileContents) {
  // WOFF2 is already compressed; serving gzip around it generally adds bytes.
  if (extname(filePath) === ".woff2") return fileContents.length;
  return gzipSync(fileContents, { level: 9 }).length;
}

function assertWithinBudget(measurementName, measuredValue, budgetValue) {
  if (measuredValue <= budgetValue) return;
  throw new Error(
    `${measurementName} is ${measuredValue.toLocaleString()} bytes; budget is ${budgetValue.toLocaleString()} bytes`,
  );
}

const offlineArtifact = await readFile(OFFLINE_ARTIFACT_PATH);
const offlineHtml = offlineArtifact.toString("utf8");
if (!offlineHtml.includes("text/javascript;charset=utf-8") ||
    !offlineHtml.includes("prepare-csv-import")) {
  throw new Error("offline bundle must contain its Blob-backed CSV import worker");
}
const embeddedFontPayloads = Array.from(
  offlineHtml.matchAll(/data:font\/woff2;base64,([A-Za-z0-9+/=]+)/g),
  match => match[1],
);
const uniqueEmbeddedFontPayloads = new Set(embeddedFontPayloads);

if (embeddedFontPayloads.length !== performanceBudgets.offlineEmbeddedFontPayloads) {
  throw new Error(
    `offline bundle embeds ${embeddedFontPayloads.length} font payloads; expected ${performanceBudgets.offlineEmbeddedFontPayloads}`,
  );
}
if (uniqueEmbeddedFontPayloads.size !== embeddedFontPayloads.length) {
  throw new Error("offline bundle contains duplicate embedded font payloads");
}

const hostedFilePaths = await collectFiles(HOSTED_OUTPUT_DIRECTORY);
const hostedFiles = await Promise.all(hostedFilePaths.map(async filePath => ({
  filePath,
  fileContents: await readFile(filePath),
})));
const hostedJavaScriptFiles = hostedFiles.filter(({ filePath }) => extname(filePath) === ".js");
const hostedCssFiles = hostedFiles.filter(({ filePath }) => extname(filePath) === ".css");
const hostedWorkerJavaScriptFiles = hostedJavaScriptFiles.filter(({ filePath }) =>
  /^05c-csv-import-worker-[A-Za-z0-9_-]+\.js$/.test(basename(filePath)),
);
const hostedMainJavaScriptFiles = hostedJavaScriptFiles.filter(hostedFile =>
  !hostedWorkerJavaScriptFiles.includes(hostedFile),
);

if (hostedJavaScriptFiles.length === 0 || hostedCssFiles.length === 0) {
  throw new Error("hosted build must contain hashed JavaScript and CSS assets");
}
if (hostedWorkerJavaScriptFiles.length !== 1 || hostedMainJavaScriptFiles.length !== 1) {
  throw new Error("hosted build must contain one main JavaScript chunk and one hashed CSV worker");
}
const hostedWorkerFileName = basename(hostedWorkerJavaScriptFiles[0].filePath);
if (!hostedMainJavaScriptFiles[0].fileContents.toString("utf8").includes(hostedWorkerFileName) ||
    !hostedWorkerJavaScriptFiles[0].fileContents.toString("utf8").includes("prepare-csv-import")) {
  throw new Error("hosted main chunk must start the separately emitted CSV import worker");
}

const measurements = {
  offlineRawBytes: offlineArtifact.length,
  offlineGzipBytes: gzipSync(offlineArtifact, { level: 9 }).length,
  hostedMainJavaScriptRawBytes: hostedMainJavaScriptFiles.reduce(
    (totalBytes, hostedFile) => totalBytes + hostedFile.fileContents.length,
    0,
  ),
  hostedWorkerJavaScriptRawBytes: hostedWorkerJavaScriptFiles.reduce(
    (totalBytes, hostedFile) => totalBytes + hostedFile.fileContents.length,
    0,
  ),
  hostedTotalJavaScriptRawBytes: hostedJavaScriptFiles.reduce(
    (totalBytes, hostedFile) => totalBytes + hostedFile.fileContents.length,
    0,
  ),
  hostedCssRawBytes: hostedCssFiles.reduce(
    (totalBytes, hostedFile) => totalBytes + hostedFile.fileContents.length,
    0,
  ),
  hostedColdTransferBytes: hostedFiles.reduce(
    (totalBytes, hostedFile) => totalBytes + compressedTransferBytes(hostedFile.filePath, hostedFile.fileContents),
    0,
  ),
  offlineEmbeddedFontPayloads: embeddedFontPayloads.length,
};

for (const measurementName of [
  "offlineRawBytes",
  "offlineGzipBytes",
  "hostedMainJavaScriptRawBytes",
  "hostedWorkerJavaScriptRawBytes",
  "hostedTotalJavaScriptRawBytes",
  "hostedCssRawBytes",
  "hostedColdTransferBytes",
]) {
  assertWithinBudget(
    measurementName,
    measurements[measurementName],
    performanceBudgets[measurementName],
  );
}

console.log(JSON.stringify({ measurements, performanceBudgets }, null, 2));
