import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const sampleCsvPath = resolve(process.cwd(), "assets/data/sample.csv");

async function openCleanBuiltApp(page: Page): Promise<void> {
  await page.goto("/systems-map.html");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator("#viz-svg")).toBeVisible();
}

async function importCsv(page: Page, csv: string, name = "map.csv"): Promise<void> {
  await page.locator("#hidden-file-input").setInputFiles({
    name,
    mimeType: "text/csv",
    buffer: Buffer.from(csv),
  });
  await expect(page.locator(".node-group").first()).toBeVisible();
}

async function measureBrowserInteraction(
  page: Page,
  performInteraction: () => Promise<void>,
  waitForSettledState: () => Promise<void>,
): Promise<number> {
  const interactionStartedAt = await page.evaluate(() => performance.now());
  await performInteraction();
  await waitForSettledState();
  return page.evaluate((startedAt) => performance.now() - startedAt, interactionStartedAt);
}

test("built artifact boots, restores, imports, exports, searches and changes modes", async ({
  page,
}) => {
  await openCleanBuiltApp(page);
  await expect(page.locator(".node-group")).toHaveCount(0);

  const sampleCsv = await readFile(sampleCsvPath, "utf8");
  await importCsv(page, sampleCsv, "sample.csv");
  await expect(page.locator(".node-group")).toHaveCount(12);

  const firstBox = page.locator(".node-group").first();
  await firstBox.focus();
  await page.keyboard.press("Enter");
  await expect(firstBox).toHaveAttribute("aria-pressed", "true");

  await page.locator("#search-input").fill("resolution");
  await expect(page.locator("#search-results")).toBeVisible();
  await expect(page.locator(".search-result").first()).toContainText(/resolution/i);

  await page.locator("#mode-toggle-button").click();
  await expect(page.locator("body")).toHaveClass(/editing/);
  await page.locator("#mode-toggle-button").click();
  await expect(page.locator("body")).toHaveClass(/reading/);
  await page.locator("#sim-toggle-button").click();
  await expect(page.locator("body")).toHaveClass(/sim-mode/);
  await page.locator("#simulation-exit-button").click();
  await expect(page.locator("body")).not.toHaveClass(/sim-mode/);

  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("systems-map.csv")?.length ?? 0))
    .toBeGreaterThan(100);
  await page.reload();
  await expect(page.locator(".node-group")).toHaveCount(12);

  // Spreadsheet export follows the visible selection when one exists. Clear it
  // here so this round-trip proves the whole-map document path.
  await page.locator("#viz-svg").evaluate((element) => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.locator("#file-button").click();
  const downloadPromise = page.waitForEvent("download");
  await page.locator(".save-data-trigger").click();
  const download = await downloadPromise;
  const downloadedPath = await download.path();
  expect(downloadedPath).not.toBeNull();
  const exportedCsv = await readFile(downloadedPath!, "utf8");
  expect(exportedCsv).toContain("# SECTION: nodes");

  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await importCsv(page, exportedCsv, "round-trip.csv");
  await expect(page.locator(".node-group")).toHaveCount(12);
});

test("390 by 844 keeps the page pinned and makes header actions scrollable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCleanBuiltApp(page);
  const dimensions = await page.evaluate(() => {
    const header = document.querySelector<HTMLElement>(".app-header")!;
    return {
      bodyWidth: document.body.scrollWidth,
      viewportWidth: window.innerWidth,
      headerClientWidth: header.clientWidth,
      headerScrollWidth: header.scrollWidth,
    };
  });
  expect(dimensions.bodyWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
  expect(dimensions.headerScrollWidth).toBeGreaterThan(dimensions.headerClientWidth);
  await page.locator("#theme-toggle-button").evaluate((element) => element.scrollIntoView());
  await expect(page.locator("#theme-toggle-button")).toBeInViewport();
});

test("300-box browser interaction budget", async ({ page }) => {
  test.slow();
  await openCleanBuiltApp(page);
  const streamRows = Array.from(
    { length: 20 },
    (_, index) => `row_${index},Row ${index},R${index},#64748b`,
  ).join("\n");
  const stageRows = Array.from(
    { length: 15 },
    (_, index) => `column_${index},Column ${index}`,
  ).join("\n");
  const mapBoxRows = Array.from({ length: 300 }, (_, index) => {
    const rowIndex = Math.floor(index / 15);
    const columnIndex = index % 15;
    return `box_${index},Box ${index},Scale fixture,row_${rowIndex},column_${columnIndex},general,100,units,${index < 20 ? "true" : ""},,200,,,,`;
  }).join("\n");
  const mapLinkRows = Array.from(
    { length: 299 },
    (_, index) => `box_${index},box_${index + 1},increases,0.1,`,
  ).join("\n");
  const largeCsv = `# SECTION: streams\nid,label,short,color\n${streamRows}\n\n# SECTION: stages\nid,label\n${stageRows}\n\n# SECTION: categories\nid,label,color,text_color\ngeneral,General,#94a3b8,#111827\n\n# SECTION: nodes\nid,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max,combine,formula,min,max\n${mapBoxRows}\n\n# SECTION: edges\nfrom,to,effect,elasticity,description\n${mapLinkRows}\n`;

  const importMilliseconds = await measureBrowserInteraction(
    page,
    async () => importCsv(page, largeCsv, "scale-300.csv"),
    async () => expect(page.locator(".node-group")).toHaveCount(300),
  );

  const panScrollPositionBeforeInteraction = await page
    .locator("#viz-scroll")
    .evaluate((element) => {
      element.scrollLeft = 0;
      return element.scrollLeft;
    });
  const panMilliseconds = await measureBrowserInteraction(
    page,
    async () => {
      await page.locator("#viz-svg").evaluate((element) => {
        element.dispatchEvent(
          new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 500, clientY: 300 }),
        );
        window.dispatchEvent(
          new MouseEvent("mousemove", { bubbles: true, button: 0, clientX: 380, clientY: 300 }),
        );
        window.dispatchEvent(
          new MouseEvent("mouseup", { bubbles: true, button: 0, clientX: 380, clientY: 300 }),
        );
      });
    },
    async () => {
      await expect
        .poll(() => page.locator("#viz-scroll").evaluate((element) => element.scrollLeft))
        .toBeGreaterThan(panScrollPositionBeforeInteraction);
      await expect(page.locator("body")).not.toHaveClass(/panning/);
    },
  );

  const viewModePanBox = page.locator('.node-group[data-node-id="box_0"]');
  const boxPanScrollPositionBeforeInteraction = await page
    .locator("#viz-scroll")
    .evaluate((element) => {
      element.scrollLeft = 0;
      return element.scrollLeft;
    });
  await viewModePanBox.evaluate((element) => {
    element.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 500, clientY: 300 }),
    );
    window.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, button: 0, clientX: 380, clientY: 300 }),
    );
    window.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, button: 0, clientX: 380, clientY: 300 }),
    );
    element.dispatchEvent(
      new MouseEvent("click", { bubbles: true, button: 0, clientX: 380, clientY: 300 }),
    );
  });
  await expect
    .poll(() => page.locator("#viz-scroll").evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(boxPanScrollPositionBeforeInteraction);
  await expect(viewModePanBox).toHaveAttribute("aria-pressed", "false");

  await viewModePanBox.evaluate((element) => {
    element.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 500, clientY: 300 }),
    );
    window.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, button: 0, clientX: 500, clientY: 300 }),
    );
    element.dispatchEvent(
      new MouseEvent("click", { bubbles: true, button: 0, clientX: 500, clientY: 300 }),
    );
  });
  await expect(viewModePanBox).toHaveAttribute("aria-pressed", "true");

  const zoomReadoutBeforeInteraction = await page.locator("#viz-zoom-readout").textContent();
  const zoomMilliseconds = await measureBrowserInteraction(
    page,
    async () => page.locator("#viz-zoom-in").click(),
    async () => {
      await expect(page.locator("#viz-zoom-readout")).not.toHaveText(
        zoomReadoutBeforeInteraction ?? "",
      );
      await expect
        .poll(() =>
          page.locator("#viz-svg").evaluate((element) => (element as HTMLElement).style.transform),
        )
        .toBe("");
    },
  );

  const selectionDurations: number[] = [];
  for (const boxIndex of [0, 40, 120, 200, 299]) {
    const duration = await page.evaluate(async (index) => {
      const box = document.querySelector<SVGGElement>(`.node-group[data-node-id="box_${index}"]`)!;
      const startedAt = performance.now();
      box.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise<void>((resolveAnimation) =>
        requestAnimationFrame(() => resolveAnimation()),
      );
      return performance.now() - startedAt;
    }, boxIndex);
    selectionDurations.push(duration);
  }
  selectionDurations.sort((left, right) => left - right);
  const selectionNinetyFifthPercentileMilliseconds =
    selectionDurations[Math.ceil(selectionDurations.length * 0.95) - 1];

  await page.locator("#sim-toggle-button").click();
  await expect(page.locator("body")).toHaveClass(/sim-mode/);
  const simulationPercentageInput = page.locator('.sim-pct-input[data-node-id="box_0"]');
  await expect(simulationPercentageInput).toHaveValue("100");
  const simulationSliderScrubMilliseconds = await measureBrowserInteraction(
    page,
    async () => {
      await simulationPercentageInput.dispatchEvent("pointerdown", {
        bubbles: true,
        clientX: 100,
        pointerId: 1,
      });
      await simulationPercentageInput.dispatchEvent("pointermove", {
        bubbles: true,
        clientX: 140,
        pointerId: 1,
      });
      await simulationPercentageInput.dispatchEvent("pointerup", {
        bubbles: true,
        clientX: 140,
        pointerId: 1,
      });
    },
    async () => expect(simulationPercentageInput).toHaveValue("140"),
  );
  await page.locator("#simulation-exit-button").click();
  await expect(page.locator("body")).not.toHaveClass(/sim-mode/);

  const readToEditModeMilliseconds = await measureBrowserInteraction(
    page,
    async () => page.locator("#mode-toggle-button").click(),
    async () => {
      await expect(page.locator("body")).toHaveClass(/editing/);
      await expect(page.locator("#mode-toggle-button")).toHaveText("Done");
    },
  );
  const editToReadModeMilliseconds = await measureBrowserInteraction(
    page,
    async () => page.locator("#mode-toggle-button").click(),
    async () => {
      await expect(page.locator("body")).toHaveClass(/reading/);
      await expect(page.locator("#mode-toggle-button")).toHaveText("Edit");
    },
  );

  const atlasStartBox = page.locator('.node-group[data-node-id="box_0"]');
  await atlasStartBox.evaluate((element) =>
    element.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
  await expect(atlasStartBox).toHaveAttribute("aria-pressed", "true");
  const atlasOpenMilliseconds = await measureBrowserInteraction(
    page,
    async () => page.locator("#atlas-button").click(),
    async () => {
      await expect(page.locator("body")).toHaveClass(/atlas-open/);
      await expect(page.locator("#atlas-stage svg.atlas")).toBeVisible();
    },
  );
  await page.locator("#atlas-exit-button").click();
  await expect(page.locator("body")).not.toHaveClass(/atlas-open/);

  await page.locator("#mode-toggle-button").click();
  await expect(page.locator("body")).toHaveClass(/editing/);
  const bulkEditOpenMilliseconds = await measureBrowserInteraction(
    page,
    async () => page.locator(".toolbar-edit-actions .edit-data-trigger").click(),
    async () => expect(page.locator("#builder-overlay.open .builder-card")).toBeVisible(),
  );

  const performanceMeasurementsMilliseconds = {
    import: importMilliseconds,
    pan: panMilliseconds,
    zoom: zoomMilliseconds,
    selectionNinetyFifthPercentile: selectionNinetyFifthPercentileMilliseconds,
    simulationSliderScrub: simulationSliderScrubMilliseconds,
    readToEditMode: readToEditModeMilliseconds,
    editToReadMode: editToReadModeMilliseconds,
    atlasOpen: atlasOpenMilliseconds,
    bulkEditOpen: bulkEditOpenMilliseconds,
  };
  const performanceBudgetsMilliseconds: Record<
    keyof typeof performanceMeasurementsMilliseconds,
    number
  > = {
    import: 5_000,
    pan: 750,
    zoom: 1_500,
    selectionNinetyFifthPercentile: 500,
    simulationSliderScrub: 1_500,
    readToEditMode: 1_500,
    editToReadMode: 1_500,
    atlasOpen: 5_000,
    bulkEditOpen: 3_000,
  };

  console.log(
    JSON.stringify({ performanceMeasurementsMilliseconds, performanceBudgetsMilliseconds }),
  );
  for (const interactionName of Object.keys(performanceBudgetsMilliseconds) as Array<
    keyof typeof performanceBudgetsMilliseconds
  >) {
    expect(
      performanceMeasurementsMilliseconds[interactionName],
      `${interactionName} exceeded its browser interaction budget`,
    ).toBeLessThan(performanceBudgetsMilliseconds[interactionName]);
  }
});
