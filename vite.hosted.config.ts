import { defineConfig } from "vite";

// The hosted app is deliberately separate from the downloadable offline file.
// Normal Vite output lets the browser paint the small document and stylesheet
// while JavaScript downloads, reuses identical font URLs, and gives long-lived
// assets content hashes for safe caching.
export default defineConfig({
  root: ".",
  base: "./",
  build: {
    outDir: "dist-hosted",
    emptyOutDir: true,
    sourcemap: false,
  },
});
