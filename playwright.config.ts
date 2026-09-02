import { defineConfig, devices } from "@playwright/test";

const offlinePreviewPort = Number(process.env.PLAYWRIGHT_OFFLINE_PREVIEW_PORT ?? "4173");
const hostedPreviewPort = Number(process.env.PLAYWRIGHT_HOSTED_PREVIEW_PORT ?? "4174");

export default defineConfig({
  testDir: "tests/browser",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://127.0.0.1:${offlinePreviewPort}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: `npm run preview -- --host 127.0.0.1 --port ${offlinePreviewPort} --strictPort`,
      url: `http://127.0.0.1:${offlinePreviewPort}/systems-map.html`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `npm run preview -- --config vite.hosted.config.ts --host 127.0.0.1 --port ${hostedPreviewPort} --strictPort`,
      url: `http://127.0.0.1:${hostedPreviewPort}/index.html`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
