import { defineConfig } from "vitest/config";

// The logic cores (CSV parse/serialize, data-loader, simulation engine, layout,
// graph selection, filters) are pure and DOM-free, but several touch
// `document` / `localStorage`, so we run the whole suite under jsdom.
export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["assets/js/**/*.ts"],
      // DOM-heavy interaction modules are exercised by the live app, not units.
      exclude: [
        "assets/js/18-main.ts",
        "assets/js/types.ts",
        "assets/js/01-sample-data.ts",
      ],
    },
  },
});
