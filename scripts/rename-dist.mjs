// Post-build: rename Vite's dist/index.html to the historical artifact name
// dist/systems-map.html so existing links / docs keep working. The file is a
// single, self-contained, offline-capable HTML (all JS/CSS/fonts inlined).
import { rename, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Which build's output to rename. Defaults to dist/; the white-label build
// passes its own directory so it never touches the tracked artifact.
const outputDirectory = process.argv[2] || "dist";
const from = resolve(root, outputDirectory + "/index.html");
const to = resolve(root, outputDirectory + "/systems-map.html");

await rename(from, to);
const { size } = await stat(to);
console.log(`Wrote ${outputDirectory}/systems-map.html  (${(size / 1024).toFixed(0)} KB)`);
