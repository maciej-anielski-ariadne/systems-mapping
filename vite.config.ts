import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

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
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Inline everything: fonts + any other asset become data: URIs so the
    // result is a single file with no external requests.
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    // viteSingleFile already forces a single chunk; keep sourcemaps out of the
    // shipped artifact.
    sourcemap: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
