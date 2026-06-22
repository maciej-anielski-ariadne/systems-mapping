// Post-build: rename Vite's dist/index.html to the historical artifact name
// dist/systems-map.html so existing links / docs keep working. The file is a
// single, self-contained, offline-capable HTML (all JS/CSS/fonts inlined).
import { rename, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const from = resolve(root, "dist/index.html");
const to = resolve(root, "dist/systems-map.html");

await rename(from, to);
const { size } = await stat(to);
console.log(`Wrote dist/systems-map.html  (${(size / 1024).toFixed(0)} KB)`);
