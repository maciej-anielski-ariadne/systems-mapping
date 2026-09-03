import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import type { Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const inlineCsvImportWorkerFactoryPath = fileURLToPath(
  new URL("./assets/js/05d-csv-import-worker-factory-inline.ts", import.meta.url),
);

/**
 * Drop the marked brand blocks from index.html when the build carries no mark.
 *
 * Vite already substitutes %VITE_BRAND_NAME% and friends in HTML, which handles
 * every place the brand is TEXT. It cannot remove an element, and three of them
 * are not text: the favicon, the header mark and the empty state's wordmark are
 * shapes. Hiding them with CSS would still ship the mark inside the file, where
 * anyone who opened it in an editor would find it — so an unbranded build takes
 * the markup out instead.
 *
 * Marked with comments rather than a template syntax so index.html stays a file
 * a browser can open directly, which is how the dev server serves it.
 */
function brandBlocks(brandName: string, markVisible: boolean): Plugin {
  return {
    name: "ariadne-brand-blocks",
    // `pre` so the blocks are gone before Vite inlines and minifies.
    enforce: "pre",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        // An empty <title> is not "no branding", it is a browser tab labelled
        // with the filename. A build with no name still needs to say what the
        // document IS, so it gets a description rather than a name.
        const withTitle = brandName
          ? html
          : html.replace("<title>%VITE_BRAND_NAME%</title>", "<title>Systems map</title>");
        return markVisible
          ? withTitle.replace(/<!--\/?brand-->/g, "")
          : withTitle.replace(/<!--brand-->[\s\S]*?<!--\/brand-->/g, "");
      },
    },
  };
}

// The app ships as ONE self-contained, offline-capable HTML file (emailable,
// USB-stick-able, double-click-openable) — exactly like the old build-dist.py
// output. `vite-plugin-singlefile` inlines every script, stylesheet and font
// (as base64 data: URIs) into a single index.html, which the build script then
// renames to dist/systems-map.html for backwards compatibility.
export default defineConfig(({ mode }) => {
  // Only the VITE_ prefix, which is the set Vite exposes to client code anyway.
  const env = loadEnv(mode, process.cwd(), "VITE_");
  return {
  // Project root is the repo root (index.html lives here).
  root: ".",
  base: "./",
  plugins: [
    brandBlocks(
      (env.VITE_BRAND_NAME || "").trim(),
      (env.VITE_BRAND_MARK || "on").trim() !== "off",
    ),
    viteSingleFile(),
  ],
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
    // A white-label build writes somewhere else. dist/systems-map.html is
    // tracked and is what the acceptance suite and the docs point at; an
    // unbranded file landing there is a silent swap of the shipped artifact.
    outDir: mode === "whitelabel" ? "dist-white-label" : "dist",
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
  };
});
