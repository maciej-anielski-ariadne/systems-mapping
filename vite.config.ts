import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const inlineCsvImportWorkerFactoryPath = fileURLToPath(
  new URL("./assets/js/05d-csv-import-worker-factory-inline.ts", import.meta.url),
);

// The app ships as ONE self-contained, offline-capable HTML file (emailable,
// USB-stick-able, double-click-openable) — exactly like the old build-dist.py
// output. `vite-plugin-singlefile` inlines every script, stylesheet and font
// (as base64 data: URIs) into a single index.html, which the build script then
// renames to dist/systems-map.html for backwards compatibility.
export default defineConfig({
  // Project root is the repo root (index.html lives here).
  root: ".",
  base: "./",
  plugins: [viteSingleFile()],
  resolve: {
    // A normal worker chunk cannot travel with the downloadable one-file app.
    // Keep source code on the hosted/default factory and substitute only this
    // exact import with Vite's Blob-backed inline worker constructor here.
    alias: [{
      find: /^\.\/05d-csv-import-worker-factory$/,
      replacement: inlineCsvImportWorkerFactoryPath,
    }],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Inline everything: fonts + any other asset become data: URIs so the
    // result is a single file with no external requests.
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    // viteSingleFile already forces a single chunk; keep sourcemaps out of the
    // shipped artifact. Do not also set inlineDynamicImports: the plugin owns
    // that setting and Vite warns when both mechanisms try to force it.
    sourcemap: false,
  },
});
