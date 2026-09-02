import {
  expect,
  test,
  type BrowserContext,
  type Page,
  type Worker as PlaywrightWorker,
} from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const sampleCsvPath = resolve(process.cwd(), "assets/data/sample.csv");
const offlineArtifactUrl = pathToFileURL(
  resolve(process.cwd(), "dist/systems-map.html"),
).href;
const hostedPreviewPort = Number(process.env.PLAYWRIGHT_HOSTED_PREVIEW_PORT ?? "4174");
const hostedArtifactUrl = `http://127.0.0.1:${hostedPreviewPort}/index.html`;

function largeMapCsv(): string {
  const nodeRows = Array.from(
    { length: 1_000 },
    (_, nodeIndex) => `box_${nodeIndex},Box ${nodeIndex},,row,column,general,100,units,,,,,,,`,
  ).join("\n");
  return `# SECTION: streams
id,label,short,color
row,Row,R,#64748b

# SECTION: stages
id,label
column,Column

# SECTION: categories
id,label,color,text_color
general,General,#94a3b8,#111827

# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max,combine,formula,min,max
${nodeRows}

# SECTION: edges
from,to,effect,elasticity,description
`;
}

async function resetBuiltApplication(page: Page, artifactUrl: string): Promise<void> {
  await page.goto(artifactUrl);
  await page.evaluate(() => {
    try {
      localStorage.clear();
    } catch {
      // Some browsers expose file documents as opaque origins. Importing must
      // still work even when persistence is unavailable.
    }
  });
  await page.reload();
  const welcomeDialog = page.getByRole("dialog", { name: "Welcome to Ariadne Maps" });
  if (await welcomeDialog.isVisible()) {
    await welcomeDialog.getByRole("button", { name: "Start blank" }).click();
  }
  await expect(page.locator("#viz-svg")).toBeVisible();
}

async function importSampleThroughWorker(page: Page): Promise<PlaywrightWorker> {
  const sampleCsv = await readFile(sampleCsvPath);
  const workerStarted = page.waitForEvent("worker");
  await page.locator("#hidden-file-input").setInputFiles({
    name: "worker-sample.csv",
    mimeType: "text/csv",
    buffer: sampleCsv,
  });
  const importWorker = await workerStarted;
  await expect(page.locator(".node-group")).toHaveCount(12);
  return importWorker;
}

test("downloadable file starts its embedded CSV worker from a Blob URL", async ({ page }) => {
  await resetBuiltApplication(page, offlineArtifactUrl);
  const importWorker = await importSampleThroughWorker(page);

  expect(importWorker.url()).toMatch(/^blob:/);
});

test("hosted build reveals progress while starting its separately emitted worker", async ({
  page,
  context,
}) => {
  await delayHostedWorkerResponse(context);
  await resetBuiltApplication(page, hostedArtifactUrl);
  const sampleCsv = await readFile(sampleCsvPath);
  const workerStarted = page.waitForEvent("worker");
  await page.locator("#hidden-file-input").setInputFiles({
    name: "hosted-worker-sample.csv",
    mimeType: "text/csv",
    buffer: sampleCsv,
  });
  await expect(page.locator('#csv-import-layer[data-state="progress"]')).toBeVisible();
  const importWorker = await workerStarted;
  await expect(page.locator(".node-group")).toHaveCount(12);

  expect(importWorker.url()).toMatch(new RegExp(
    `^http://127\\.0\\.0\\.1:${hostedPreviewPort}/assets/` +
    "05c-csv-import-worker-[A-Za-z0-9_-]+\\.js$",
  ));
});

async function delayHostedWorkerResponse(context: BrowserContext): Promise<void> {
  await context.route(/\/assets\/05c-csv-import-worker-[A-Za-z0-9_-]+\.js$/, async route => {
    await new Promise(resolveDelay => setTimeout(resolveDelay, 350));
    await route.continue();
  });
}

test("large-map confirmation preserves the current map when cancelled and opens on consent", async ({
  page,
}) => {
  await resetBuiltApplication(page, hostedArtifactUrl);
  await importSampleThroughWorker(page);
  const largeCsvBuffer = Buffer.from(largeMapCsv());

  await page.locator("#hidden-file-input").setInputFiles({
    name: "large-map.csv",
    mimeType: "text/csv",
    buffer: largeCsvBuffer,
  });
  const warningLayer = page.locator('#csv-import-layer[data-state="warning"]');
  await expect(warningLayer).toBeVisible();
  await expect(warningLayer.locator("[data-csv-import-open]")).toBeVisible();
  await expect(page.locator(".node-group")).toHaveCount(12);
  await warningLayer.locator("[data-csv-import-cancel]").click();
  await expect(warningLayer).toBeHidden();
  await expect(page.locator(".node-group")).toHaveCount(12);

  await page.locator("#hidden-file-input").setInputFiles({
    name: "large-map.csv",
    mimeType: "text/csv",
    buffer: largeCsvBuffer,
  });
  await expect(warningLayer).toBeVisible();
  await warningLayer.locator("[data-csv-import-open]").click();
  await expect(warningLayer).toBeHidden();
  // The map virtualizes off-screen SVG groups, so the sidebar's model count is
  // the stable proof that all boxes were integrated rather than just painted.
  await expect(page.locator("#stream-filters .sidebar-count")).toHaveText("1000");
  await expect(page.locator("#load-feedback")).toContainText("Found 1000 boxes");
});
