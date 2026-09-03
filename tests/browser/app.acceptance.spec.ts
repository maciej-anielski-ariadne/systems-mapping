import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { COMBINE_CSV, FORMULA_CSV, FORMULA_INVALID_CSV } from "../fixtures/graphs";

const sampleCsvPath = resolve(process.cwd(), "assets/data/sample.csv");

async function dismissFirstOpenTutorial(page: Page): Promise<void> {
  const welcomeDialog = page.getByRole("dialog", { name: "Welcome to Ariadne Maps" });
  await expect(welcomeDialog).toBeVisible();
  await welcomeDialog.getByRole("button", { name: "Start blank" }).click();
  await expect(welcomeDialog).toBeHidden();
}

async function openCleanBuiltApp(page: Page): Promise<void> {
  await page.goto("/systems-map.html");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await dismissFirstOpenTutorial(page);
  await expect(page.locator("#viz-svg")).toBeVisible();
}

async function openConsolidatedLessonAtStep(
  page: Page,
  lessonIdentifier: string,
  stepIndex: number,
): Promise<void> {
  await page.evaluate(({ selectedLessonIdentifier, selectedStepIndex }) => {
    localStorage.setItem("systems-map.learn.progress.v1", JSON.stringify({
      curriculumVersion: 5,
      completedLessonIds: [],
      lastLessonId: selectedLessonIdentifier,
      lastStepIndex: selectedStepIndex,
      completedCheckpointIdentifiersByLesson: {},
    }));
  }, { selectedLessonIdentifier: lessonIdentifier, selectedStepIndex: stepIndex });
  const closeLearnButton = page.locator('[data-tutorial-action="close-learn"]');
  if (await closeLearnButton.isVisible()) await closeLearnButton.click();
  await page.getByRole("button", { name: "Learn", exact: true }).click();
  await page.locator(
    '[data-lesson-card="' + lessonIdentifier + '"] [data-tutorial-action="lesson"]',
  ).click();
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

async function expectVisibleControlsNotToOverlap(
  page: Page,
  selectors: string[],
): Promise<void> {
  const visibleBounds = [];
  for (const selector of selectors) {
    const locator = page.locator(selector);
    if (!(await locator.isVisible())) continue;
    const bounds = await locator.boundingBox();
    if (bounds) visibleBounds.push({ selector, bounds });
  }

  for (let leftIndex = 0; leftIndex < visibleBounds.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < visibleBounds.length; rightIndex++) {
      const left = visibleBounds[leftIndex];
      const right = visibleBounds[rightIndex];
      const overlaps = !(
        left.bounds.x + left.bounds.width <= right.bounds.x ||
        right.bounds.x + right.bounds.width <= left.bounds.x ||
        left.bounds.y + left.bounds.height <= right.bounds.y ||
        right.bounds.y + right.bounds.height <= left.bounds.y
      );
      expect(overlaps, `${left.selector} should not overlap ${right.selector}`).toBe(false);
    }
  }
}

async function expectSingleRowBottomToolbars(page: Page): Promise<void> {
  const dockPresentation = await page.locator(".map-bottom-dock").evaluate((dock) => {
    const dockStyles = getComputedStyle(dock);
    const floatingToolbarSelectors = [
      ".map-primary-controls",
      ".viz-controls-cluster",
    ];
    const visibleToolbars = floatingToolbarSelectors
      .map(selector => dock.querySelector<HTMLElement>(selector))
      .filter((toolbar): toolbar is HTMLElement => (
        !!toolbar && getComputedStyle(toolbar).display !== "none"
      ));
    const toolbarBottomEdges = visibleToolbars.map(
      toolbar => toolbar.getBoundingClientRect().bottom,
    );
    const navigationControlStyles = visibleToolbars.slice(-1).map(toolbar => ({
      flexDirection: getComputedStyle(toolbar).flexDirection,
      visibleSharedControls: Array.from(toolbar.querySelectorAll<HTMLElement>(".viz-shared-control"))
        .filter(control => getComputedStyle(control).display !== "none").length,
    }));
    return {
      display: dockStyles.display,
      flexDirection: dockStyles.flexDirection,
      flexWrap: dockStyles.flexWrap,
      scrollbarWidth: dockStyles.scrollbarWidth,
      toolbarBottomEdges,
      navigationControlStyles,
    };
  });

  expect(dockPresentation.display).toBe("flex");
  expect(dockPresentation.flexDirection).toBe("row");
  expect(dockPresentation.flexWrap).toBe("nowrap");
  expect(dockPresentation.scrollbarWidth).toBe("none");
  expect(
    Math.max(...dockPresentation.toolbarBottomEdges) - Math.min(...dockPresentation.toolbarBottomEdges),
  ).toBeLessThanOrEqual(1);
  expect(dockPresentation.navigationControlStyles).toEqual([
    { flexDirection: "row", visibleSharedControls: 3 },
  ]);
}

test("built artifact boots, restores, imports, exports, searches and changes modes", async ({
  page,
}) => {
  // This is a broad end-to-end contract rather than a latency gate. Its many
  // independent browser interactions can cumulatively exceed Playwright's
  // default timeout on a busy host even when every individual wait is healthy.
  test.slow();
  await openCleanBuiltApp(page);
  await expect(page.locator(".node-group")).toHaveCount(0);

  const sampleCsv = await readFile(sampleCsvPath, "utf8");
  await importCsv(page, sampleCsv, "sample.csv");
  await expect(page.locator(".node-group")).toHaveCount(12);

  const firstBox = page.locator(".node-group").first();
  await firstBox.focus();
  await page.keyboard.press("Enter");
  await expect(firstBox).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => firstBox.locator(".node-rect").evaluate(
    rectangle => getComputedStyle(rectangle).filter,
  )).toContain("drop-shadow(rgb(255, 255, 255)");
  expect(await firstBox.evaluate(nodeGroup => getComputedStyle(nodeGroup).outlineStyle))
    .toBe("none");
  const selectedBoxRectangleAppearance = await firstBox.locator(".node-rect").evaluate(rectangle => ({
    filter: getComputedStyle(rectangle).filter,
    stroke: getComputedStyle(rectangle).stroke,
    strokeAttribute: rectangle.getAttribute("stroke"),
    strokeWidthAttribute: rectangle.getAttribute("stroke-width"),
  }));
  expect(selectedBoxRectangleAppearance).toEqual({
    filter: "drop-shadow(rgb(255, 255, 255) 0px 0px 2px) " +
      "drop-shadow(rgba(255, 255, 255, 0.9) 0px 0px 8px) " +
      "drop-shadow(rgba(255, 255, 255, 0.55) 0px 0px 18px)",
    stroke: "rgba(0, 0, 0, 0)",
    strokeAttribute: "#ffffff",
    strokeWidthAttribute: "2.5",
  });

  const selectedBoxActions = page.locator(".detail-scope-actions");
  await expect(selectedBoxActions).toBeVisible();
  await expect(selectedBoxActions.locator(".detail-scope-button")).toHaveCount(3);
  const selectedBoxActionLayout = await selectedBoxActions.evaluate((actionList) => {
    const buttons = Array.from(
      actionList.querySelectorAll<HTMLElement>(".detail-scope-button"),
    );
    return {
      flexDirection: getComputedStyle(actionList).flexDirection,
      buttonBounds: buttons.map(button => button.getBoundingClientRect().toJSON()),
      buttonBackgrounds: buttons.map(button => getComputedStyle(button).backgroundColor),
    };
  });
  expect(selectedBoxActionLayout.flexDirection).toBe("column");
  expect(selectedBoxActionLayout.buttonBounds.every(bounds => bounds.height <= 32)).toBe(true);
  expect(selectedBoxActionLayout.buttonBounds.every((bounds, index, allBounds) => (
    index === 0 || bounds.top >= allBounds[index - 1].bottom
  ))).toBe(true);
  expect(new Set(selectedBoxActionLayout.buttonBounds.map(bounds => bounds.width)).size).toBe(1);
  expect(selectedBoxActionLayout.buttonBackgrounds.every(background => (
    background === "rgba(0, 0, 0, 0)"
  ))).toBe(true);

  await page.locator("#search-input").fill("resolution");
  await expect(page.locator("#search-results")).toBeVisible();
  await expect(page.locator(".search-result").first()).toContainText(/resolution/i);

  await page.locator("#mode-toggle-button").click();
  await expect(page.locator("body")).toHaveClass(/editing/);
  await page.locator("#mode-toggle-button").click();
  await expect(page.locator("body")).toHaveClass(/reading/);
  await page.locator("#sim-toggle-button").click();
  await expect(page.locator("body")).toHaveClass(/sim-mode/);
  await page.locator("#sim-toggle-button").click();
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
  await page.locator("#export-button").click();
  const downloadPromise = page.waitForEvent("download");
  await page.locator(".save-data-trigger").click();
  const download = await downloadPromise;
  const downloadedPath = await download.path();
  expect(downloadedPath).not.toBeNull();
  const exportedCsv = await readFile(downloadedPath!, "utf8");
  expect(exportedCsv).toContain("# SECTION: nodes");

  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await dismissFirstOpenTutorial(page);
  await importCsv(page, exportedCsv, "round-trip.csv");
  await expect(page.locator(".node-group")).toHaveCount(12);

  await page.locator("#learn-button").click();
  await page.locator(
    '[data-tutorial-action="lesson"][data-lesson-id="move-around-map"]',
  ).click();
  await expect(page.locator('[data-tutorial-action="highlight-style"]')).toHaveCount(0);
  await expect.poll(() => page.locator(".tutorial-target").evaluate(
    target => getComputedStyle(target).outlineStyle,
  )).toBe("none");
  const tutorialThreadGeometry = await page.locator(".tutorial-target-thread").evaluate(thread => {
    const path = thread.querySelector("path");
    const marker = thread.querySelector("circle");
    return {
      path: path?.getAttribute("d"),
      markerX: marker?.getAttribute("cx"),
      markerY: marker?.getAttribute("cy"),
    };
  });
  expect(tutorialThreadGeometry.path).toMatch(/^M /);
  expect(tutorialThreadGeometry.markerX).not.toBeNull();
  expect(tutorialThreadGeometry.markerY).not.toBeNull();
  const tutorialMarkerOffset = async (): Promise<number> => page.evaluate(() => {
    const target = document.querySelector(".tutorial-target");
    const marker = document.querySelector(".tutorial-target-thread-marker");
    if (!target || !marker) return Number.POSITIVE_INFINITY;
    const targetBounds = target.getBoundingClientRect();
    const markerX = Number(marker.getAttribute("cx"));
    const markerY = Number(marker.getAttribute("cy"));
    return Math.max(
      Math.abs(markerX - (targetBounds.left + targetBounds.width / 2)),
      Math.abs(markerY - (targetBounds.top + targetBounds.height / 2)),
    );
  });
  await expect.poll(tutorialMarkerOffset).toBeLessThan(1);

  await page.locator("#viz-navigation-mode-zoom").click();
  await page.locator("#viz-zoom-in").click();
  await expect.poll(tutorialMarkerOffset).toBeLessThan(1);
  const threadFadedOverTarget = await page.evaluate(() => {
    const target = document.querySelector(".tutorial-target");
    const thread = document.querySelector(".tutorial-target-thread");
    target?.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
    return thread?.classList.contains("is-faded-over-target") || false;
  });
  expect(threadFadedOverTarget).toBe(true);
  await page.evaluate(() => {
    document.body.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
  });
  await expect(page.locator(".tutorial-target-thread")).toHaveCSS("opacity", "1");

  const tutorialCard = page.locator(".tutorial-card");
  const tutorialCardDragHandle = page.locator("[data-tutorial-card-drag-handle]");
  const tutorialCardBoundsBeforeDrag = await tutorialCard.boundingBox();
  const tutorialCardDragHandleBounds = await tutorialCardDragHandle.boundingBox();
  const tutorialThreadPathBeforeDrag = await page.locator(".tutorial-target-thread-path").getAttribute("d");
  expect(tutorialCardBoundsBeforeDrag).not.toBeNull();
  expect(tutorialCardDragHandleBounds).not.toBeNull();
  await page.mouse.move(
    tutorialCardDragHandleBounds!.x + tutorialCardDragHandleBounds!.width / 2,
    tutorialCardDragHandleBounds!.y + tutorialCardDragHandleBounds!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    tutorialCardDragHandleBounds!.x + tutorialCardDragHandleBounds!.width / 2 - 90,
    tutorialCardDragHandleBounds!.y + tutorialCardDragHandleBounds!.height / 2 - 70,
    { steps: 6 },
  );
  await page.mouse.up();
  const tutorialCardBoundsAfterDrag = await tutorialCard.boundingBox();
  expect(tutorialCardBoundsAfterDrag).not.toBeNull();
  expect(tutorialCardBoundsAfterDrag!.x).toBeLessThan(tutorialCardBoundsBeforeDrag!.x - 60);
  expect(tutorialCardBoundsAfterDrag!.y).toBeLessThan(tutorialCardBoundsBeforeDrag!.y - 40);
  await expect.poll(() => page.locator(".tutorial-target-thread-path").getAttribute("d"))
    .not.toBe(tutorialThreadPathBeforeDrag);
  await expect.poll(tutorialMarkerOffset).toBeLessThan(1);
  await page.locator('[data-tutorial-action="exit-lesson"]').click();
  await page.locator('[data-tutorial-action="close-learn"]').click();
});

test("Learn Next waits for every ordered action in a step", async ({ page }) => {
  await openCleanBuiltApp(page);

  await page.locator("#learn-button").click();
  await page.locator(
    '[data-tutorial-action="lesson"][data-lesson-id="move-around-map"]',
  ).click();

  const nextButton = page.locator('[data-tutorial-action="next"]');
  const zoomCheckpoint = page.locator('[data-tutorial-checkpoint="change-zoom"]');

  await expect(nextButton).toBeDisabled();
  await expect(nextButton).toHaveAttribute("aria-describedby", "tutorial-task-requirements");
  await expect(page.locator("#tutorial-task-requirements")).toContainText(
    "Complete all actions to unlock Next",
  );

  await page.locator("#viz-zoom-readout").click();
  await expect(zoomCheckpoint).not.toHaveClass(/is-complete/);
  await expect(nextButton).toBeDisabled();

  await page.locator("#viz-zoom-in").click();
  await expect(zoomCheckpoint).toHaveClass(/is-complete/);
  await expect(page.locator("#tutorial-task-requirements")).toContainText(
    "All actions complete",
  );
  await expect(nextButton).toBeEnabled();

  await nextButton.click();
  await expect(page.getByRole("heading", { name: "Move from the beginning to the end" })).toBeVisible();
  const availableHorizontalTravel = await page.locator("#viz-scroll").evaluate(
    element => element.scrollWidth - element.clientWidth,
  );
  expect(availableHorizontalTravel).toBeGreaterThanOrEqual(160);
  await page.locator("#viz-scroll").evaluate(element => {
    element.scrollLeft = element.scrollWidth - element.clientWidth;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(page.locator('[data-tutorial-checkpoint="pan-to-learning-end"]')).toHaveClass(/is-complete/);
  await expect(page.locator('[data-tutorial-checkpoint="pan-back-to-inputs"]')).not.toHaveClass(/is-complete/);
  await expect(nextButton).toBeDisabled();
  await page.locator("#viz-scroll").evaluate(element => {
    element.scrollLeft = 0;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(page.locator('[data-tutorial-checkpoint="pan-back-to-inputs"]')).toHaveClass(/is-complete/);
  await expect(nextButton).toBeEnabled();

  await nextButton.click();
  await expect(page.getByRole("heading", { name: "Frame the whole map again" })).toBeVisible();
  await expect(nextButton).toBeDisabled();
  await page.locator("#viz-zoom-readout").click();
  await expect(page.locator('[data-tutorial-checkpoint="fit-map"]')).toHaveClass(/is-complete/);
  await expect(nextButton).toBeEnabled();
  await nextButton.click();

  await expect(page.getByRole("heading", { name: "Read rows as parts of the system" })).toBeVisible();
  await expect(page.locator(".node-group.selected")).toHaveCount(0);
  await expect(page.locator('[data-tutorial-action="exit-lesson"]')).toHaveText("Exit lesson");

  await page.locator('[data-tutorial-action="exit-lesson"]').click();
  const unfinishedLessonActions = page.locator('[data-lesson-card="move-around-map"] .learn-lesson-actions');
  await expect(unfinishedLessonActions.locator("button")).toHaveCount(1);
  await expect(unfinishedLessonActions.locator('[data-tutorial-action="lesson"]')).toHaveText("Resume");

  page.once("dialog", dialog => dialog.accept());
  await page.locator('[data-tutorial-action="reset-all-progress"]').click();
  await expect(page.locator(".learn-progress-summary")).toContainText("0 of 5 journeys complete");
  await expect(page.locator('[data-tutorial-action="reset-all-progress"]')).toBeDisabled();
  await expect(page.locator('[data-tutorial-action="restart-lesson"]')).toHaveCount(0);

  await page.locator(
    '[data-tutorial-action="lesson"][data-lesson-id="edit-map"]',
  ).click();
  const detailPanel = page.locator("#detail-panel");
  const columnDropdown = detailPanel.locator('select[data-field="stage"]');
  await detailPanel.evaluate(panel => { panel.scrollTop = 0; });
  await expect(columnDropdown).toBeHidden();
  await expect(detailPanel.locator(".typeable-dropdown-input")).toHaveCount(0);
  for (const fieldName of ["stream", "stage", "controllable", "direction", "combine"]) {
    const selectionOnlyDropdown = detailPanel.locator(
      '.selection-only-dropdown:has(select[data-field="' + fieldName + '"])',
    );
    await expect(selectionOnlyDropdown.locator(".typeable-dropdown-button")).toBeVisible();
    await expect(selectionOnlyDropdown.locator(".typeable-dropdown-input")).toHaveCount(0);
  }
  const rowDropdown = detailPanel.locator(
    '.selection-only-dropdown:has(select[data-field="stream"])',
  );
  const rowDropdownButton = rowDropdown.locator(".typeable-dropdown-button");
  const rowDropdownPopupIdentifier = await rowDropdownButton.getAttribute("aria-controls");
  expect(rowDropdownPopupIdentifier).toBeTruthy();
  const rowDropdownPopup = page.locator("#" + rowDropdownPopupIdentifier);
  await rowDropdownButton.click();
  await expect(rowDropdownPopup).toBeVisible();
  await expect(rowDropdownPopup).toContainText("Partnerships");
  const rowDropdownPopupBounds = await rowDropdownPopup.boundingBox();
  expect(rowDropdownPopupBounds).not.toBeNull();
  expect(rowDropdownPopupBounds!.x).toBeGreaterThanOrEqual(0);
  expect(rowDropdownPopupBounds!.y).toBeGreaterThanOrEqual(0);
  expect(rowDropdownPopupBounds!.x + rowDropdownPopupBounds!.width).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  expect(rowDropdownPopupBounds!.y + rowDropdownPopupBounds!.height).toBeLessThanOrEqual(
    page.viewportSize()!.height,
  );
  await rowDropdownPopup.locator('.typeable-dropdown-item:has-text("Partnerships")').click();
  await expect(
    page.locator('.node-group[data-node-id="workshop_readiness"]'),
  ).toHaveAttribute("aria-label", /row Partnerships/);
  await expect(detailPanel.locator(".detail-name-input")).toBeVisible();

  const materialsBudgetBox = page.locator(
    '.node-group[data-node-id="materials_budget"]',
  );
  await materialsBudgetBox.dblclick();
  await expect(materialsBudgetBox).toHaveClass(/selected/);
  await expect(detailPanel.locator(".detail-name-input")).toHaveValue("Materials budget");
  await expect(detailPanel.locator(".detail-name-input")).toBeFocused();
  await expect.poll(() => detailPanel.evaluate(panel => panel.scrollTop)).toBe(0);

  const descriptionInput = page.locator("#detail-panel .detail-desc-input");
  await descriptionInput.fill("The first edit must complete the task");
  await expect(page.locator('[data-tutorial-action="next"]')).toBeEnabled();
  await expect(page.locator('[data-tutorial-checkpoint="edit-box-field"]')).toHaveClass(/is-complete/);

  await page.locator('[data-tutorial-action="exit-lesson"]').click();
  await openConsolidatedLessonAtStep(page, "move-around-map", 8);
  const searchInput = page.locator("#search-input");
  await searchInput.fill("workshop");
  await searchInput.press("Enter");
  await expect(page.locator('[data-tutorial-action="next"]')).toBeEnabled();
  await page.locator('[data-tutorial-action="next"]').click();
  const categoryFilter = page.locator('#sidebar [data-kind="category"][data-id]').first();
  await categoryFilter.click();
  await expect(page.locator('[data-tutorial-action="next"]')).toBeEnabled();
  await expect(page.locator('[data-tutorial-checkpoint="hide-filter"]')).toHaveClass(/is-complete/);
});

test("Foundations points desirability at the Outcome field", async ({ page }) => {
  await openCleanBuiltApp(page);
  await openConsolidatedLessonAtStep(page, "move-around-map", 6);

  const outcomeField = page.locator('#detail-panel [data-detail-quantity="outcome"]');
  await expect(page.getByRole("heading", { name: "Distinguish link direction from desirability" }))
    .toBeVisible();
  await expect(outcomeField).toBeVisible();
  await expect(outcomeField).toHaveClass(/tutorial-target/);
  await expect(outcomeField).toContainText("Outcome");
  await expect(outcomeField).toContainText("higher is better");
});

test("Shift-click adds a box to the tutorial multi-selection", async ({ page }) => {
  await openCleanBuiltApp(page);
  await openConsolidatedLessonAtStep(page, "edit-map", 25);

  await expect(page.locator(".node-group.selected")).toHaveCount(3);
  await expect(page.locator("#multi-select-bar .selection-only-dropdown")).toHaveCount(3);
  await expect(page.locator("#multi-select-bar .typeable-dropdown-input")).toHaveCount(0);
  const moveToRowDropdown = page.getByRole("combobox", { name: "Move to row" });
  await moveToRowDropdown.click();
  await expect(page.locator("body > .typeable-dropdown-popup:not([hidden])")).toBeVisible();
  await page.keyboard.press("Escape");
  await expectVisibleControlsNotToOverlap(page, [".tutorial-card", "#multi-select-bar"]);
  const additionalBox = page.locator('.node-group[data-node-id="materials_budget"]');
  await additionalBox.click({ modifiers: ["Shift"] });

  await expect(page.locator(".node-group.selected")).toHaveCount(4);
  await expect(additionalBox).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-tutorial-action="next"]')).toBeEnabled();
  await page.locator('[data-tutorial-action="next"]').click();
  await expect(page.getByRole("heading", { name: "Change the group in one undo step" })).toBeVisible();
  await expectVisibleControlsNotToOverlap(page, [".tutorial-card", "#multi-select-bar"]);
});

test("custom multi-select dropdowns fit a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCleanBuiltApp(page);
  await openConsolidatedLessonAtStep(page, "edit-map", 25);

  const selectionBarBounds = await page.locator("#multi-select-bar").boundingBox();
  expect(selectionBarBounds).not.toBeNull();
  expect(selectionBarBounds!.x).toBeGreaterThanOrEqual(8);
  expect(selectionBarBounds!.x + selectionBarBounds!.width).toBeLessThanOrEqual(382);
  await expectVisibleControlsNotToOverlap(page, [".tutorial-card", "#multi-select-bar"]);

  await page.getByRole("combobox", { name: "Move to row" }).click();
  const popupBounds = await page.locator(
    "body > .typeable-dropdown-popup:not([hidden])",
  ).boundingBox();
  expect(popupBounds).not.toBeNull();
  expect(popupBounds!.x).toBeGreaterThanOrEqual(0);
  expect(popupBounds!.x + popupBounds!.width).toBeLessThanOrEqual(390);
  const dropdownLayerOrder = await page.evaluate(() => ({
    dropdown: Number(getComputedStyle(document.querySelector(
      "body > .typeable-dropdown-popup:not([hidden])",
    )!).zIndex),
    tutorial: Number(getComputedStyle(document.querySelector("#tutorial-layer")!).zIndex),
  }));
  expect(dropdownLayerOrder.dropdown).toBeGreaterThan(dropdownLayerOrder.tutorial);

  await page.keyboard.press("Escape");
  await page.locator("#export-button").click();
  await expect(page.locator("#export-menu")).toBeVisible();
  const headerMenuLayerOrder = await page.evaluate(() => ({
    header: Number(getComputedStyle(document.querySelector(".app-header")!).zIndex),
    menu: Number(getComputedStyle(document.querySelector("#export-menu")!).zIndex),
    tutorial: Number(getComputedStyle(document.querySelector("#tutorial-layer")!).zIndex),
  }));
  expect(headerMenuLayerOrder.header).toBeGreaterThan(headerMenuLayerOrder.tutorial);
  expect(headerMenuLayerOrder.menu).toBe(headerMenuLayerOrder.header);
});

test("Command-Z and Control-Z undo while a box field retains focus", async ({ page }) => {
  await openCleanBuiltApp(page);
  await page.getByRole("button", { name: "Learn", exact: true }).click();
  await page.locator(
    '[data-lesson-card="edit-map"] [data-tutorial-action="lesson"]',
  ).click();

  const boxNameInput = page.getByRole("textbox", { name: "Box name" });
  await expect(boxNameInput).toHaveValue("Workshop readiness");
  await boxNameInput.fill("Temporary Command label");
  await boxNameInput.press("Meta+z");
  await expect(boxNameInput).toHaveValue("Workshop readiness");

  await boxNameInput.fill("Temporary Control label");
  await boxNameInput.press("Control+z");
  await expect(boxNameInput).toHaveValue("Workshop readiness");
});

test("Review uses the shared dropdown without clicking through its panel", async ({ page }) => {
  await openCleanBuiltApp(page);
  await page.getByRole("button", { name: "Learn", exact: true }).click();
  await page.locator(
    '[data-lesson-card="review-evidence"] [data-tutorial-action="lesson"]',
  ).click();

  await page.locator('[data-tutorial-action="next"]').click();
  await expect(page.getByRole("heading", { name: "Compare formula and link evidence" }))
    .toBeVisible();

  const evidenceStatusDropdown = page.getByRole("combobox", {
    name: "Show evidence status",
  });
  await expect(evidenceStatusDropdown.locator("xpath=..")).toHaveClass(/selection-only-dropdown/);
  await expect(evidenceStatusDropdown).toHaveClass(/tutorial-target/);
  await expect(evidenceStatusDropdown).toBeVisible();
  await evidenceStatusDropdown.click();
  await page.locator(
    'body > .typeable-dropdown-popup:not([hidden]) .typeable-dropdown-item[data-item-index="3"]',
  ).click();

  await expect(page.locator("#review-stage")).toBeVisible();
  await expect(evidenceStatusDropdown).toHaveText("Supported");
  await expect(page.locator("#review-stage select:not(.typeable-dropdown-native)")).toHaveCount(0);
});

test("Review folding keeps the reader in place and Evidence provenance can collapse", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 480 });
  await openCleanBuiltApp(page);
  await importCsv(page, FORMULA_INVALID_CSV, "review-folding.csv");
  await page.locator("#review-button").click();

  const leftReviewColumn = page.locator("#review-stage .review-column").first();
  const lastIssueToggle = page.locator("[data-review-issue]").last();
  await lastIssueToggle.scrollIntoViewIfNeeded();
  const scrollTopBeforeExpansion = await leftReviewColumn.evaluate(
    reviewColumn => reviewColumn.scrollTop,
  );
  expect(scrollTopBeforeExpansion).toBeGreaterThan(0);

  await lastIssueToggle.click();
  await expect(lastIssueToggle).toHaveAttribute("aria-expanded", "true");
  await expect.poll(() => leftReviewColumn.evaluate(reviewColumn => reviewColumn.scrollTop))
    .toBe(scrollTopBeforeExpansion);

  const evidenceToggle = page.locator("#review-evidence-toggle");
  await evidenceToggle.scrollIntoViewIfNeeded();
  await evidenceToggle.click();
  await expect(evidenceToggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#review-evidence-content")).toHaveCount(0);
  await expect(evidenceToggle).toBeInViewport();

  await evidenceToggle.click();
  await expect(evidenceToggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#review-evidence-content")).toBeVisible();
});

test("Share lesson keeps each export target open and connected", async ({ page }) => {
  await openCleanBuiltApp(page);
  await page.getByRole("button", { name: "Learn", exact: true }).click();
  await page.locator(
    '[data-lesson-card="image-view-only"] [data-tutorial-action="lesson"]',
  ).click();

  const expectedExportTargets = [
    ".save-data-trigger",
    ".export-image-trigger",
    ".publish-html-trigger",
    ".export-review-log-trigger",
  ];
  for (let stepIndex = 0; stepIndex < expectedExportTargets.length; stepIndex++) {
    const exportTarget = page.locator(expectedExportTargets[stepIndex]);
    await expect(page.locator("#export-menu")).toBeVisible();
    await expect(exportTarget).toBeVisible();
    await expect(exportTarget).toHaveClass(/tutorial-target/);
    if (stepIndex < expectedExportTargets.length - 1) {
      await page.locator('[data-tutorial-action="next"]').click();
    }
  }
});

test("Learn Skip step bypasses one gate and leaves it unfinished", async ({ page }) => {
  await openCleanBuiltApp(page);
  await page.locator("#learn-button").click();
  await page.locator(
    '[data-tutorial-action="lesson"][data-lesson-id="move-around-map"]',
  ).click();

  const firstStepTitle = await page.locator(".tutorial-card h2").textContent();
  await expect(page.locator('[data-tutorial-action="next"]')).toBeDisabled();
  await expect(page.locator('[data-tutorial-action="skip-step"]')).toBeEnabled();
  await page.locator('[data-tutorial-action="skip-step"]').click();
  await expect(page.locator(".tutorial-step-number")).toContainText("Step 2 of 16");
  await expect(page.locator(".tutorial-card h2")).not.toHaveText(firstStepTitle || "");

  await page.locator('[data-tutorial-action="back"]').click();
  await expect(page.locator(".tutorial-card h2")).toHaveText(firstStepTitle || "");
  await expect(page.locator('[data-tutorial-action="next"]')).toBeDisabled();
  await expect(page.locator(".tutorial-task-checkpoint.is-complete")).toHaveCount(0);
});

test("Sensitivity interpretation points at the opened result rows", async ({ page }) => {
  await openCleanBuiltApp(page);
  await openConsolidatedLessonAtStep(page, "review-evidence", 5);

  await page.locator("#review-fold-toggle").click();
  await expect(page.locator('[data-tutorial-action="next"]')).toBeEnabled();
  await page.locator('[data-tutorial-action="next"]').click();

  await expect(page.getByRole("heading", { name: "Use sensitivity as a diagnostic, not proof" }))
    .toBeVisible();
  await expect(page.locator(".review-rows.tutorial-target")).toBeVisible();
  await expect(page.locator("#review-fold-toggle")).toHaveAttribute("aria-expanded", "true");
});

test("Atlas lesson teaches the user to open Atlas before showing pathways", async ({ page }) => {
  await openCleanBuiltApp(page);
  await openConsolidatedLessonAtStep(page, "simulate-change", 6);

  const nextButton = page.locator('[data-tutorial-action="next"]');
  const openAtlasButton = page.locator('[data-action="open-atlas"]');
  const volunteerTimeSlider = page.locator(
    '.sim-slider-row[data-node-id="volunteer_hours"] .sim-value-input',
  );
  await expect(page.getByRole("heading", { name: "Open Atlas while simulating" })).toBeVisible();
  await expect(page.locator("body")).not.toHaveClass(/atlas-open/);
  await expect(volunteerTimeSlider).toHaveClass(/tutorial-target/);
  await expect(nextButton).toBeDisabled();
  await volunteerTimeSlider.fill("120");
  await volunteerTimeSlider.press("Tab");
  await expect(page.locator('[data-tutorial-checkpoint="change-input-before-atlas"]'))
    .toHaveClass(/is-complete/);
  await expect(openAtlasButton).toHaveClass(/tutorial-target/);
  await openAtlasButton.click();
  await expect(page.locator('[data-tutorial-checkpoint="open-atlas-while-simulating"]'))
    .toHaveClass(/is-complete/);
  await expect(page.locator("body")).toHaveClass(/atlas-open/);
  await expect(nextButton).toBeEnabled();

  await nextButton.click();
  await expect(page.getByRole("heading", { name: "Open Atlas from a starting box" })).toBeVisible();
  await expect(page.locator("body")).not.toHaveClass(/atlas-open/);
  await expect(page.locator('.node-group[data-node-id="community_confidence"]')).toHaveClass(/selected/);
  await expect(openAtlasButton).toBeVisible();
  await expect(nextButton).toBeDisabled();

  await openAtlasButton.click();

  await expect(page.locator("body")).toHaveClass(/atlas-open/);
  await expect(page.locator('[data-tutorial-checkpoint="open-atlas"]')).toHaveClass(/is-complete/);
  await expect(nextButton).toBeEnabled();

  await nextButton.click();
  await expect(page.getByRole("heading", { name: "Explore the Atlas picture" })).toBeVisible();
  await expect(nextButton).toBeDisabled();
  await page.locator(".atlas g.n[data-el]:not([data-loop]) > circle.bub").first().click();
  await expect(page.locator('[data-tutorial-checkpoint="select-atlas-element"]'))
    .toHaveClass(/is-complete/);
  await expect(nextButton).toBeEnabled();

  await nextButton.click();
  await expect(page.getByRole("heading", { name: "Read a grouped circle carefully" })).toBeVisible();
  await expect(page.locator(".atlas-group-legend")).toHaveClass(/tutorial-target/);
  await expect(nextButton).toBeEnabled();

  await nextButton.click();
  await expect(page.getByRole("heading", { name: "Frame the Atlas view" })).toBeVisible();
  await expect(nextButton).toBeDisabled();
  await page.locator("#atlas-zoom-readout").click();
  await expect(page.locator('[data-tutorial-checkpoint="fit-atlas-picture"]'))
    .toHaveClass(/is-complete/);
  await expect(nextButton).toBeEnabled();

  await nextButton.click();
  await expect(page.getByRole("heading", { name: "Change the starting question" })).toBeVisible();
  await expect(page.locator("#atlas-button")).toHaveClass(/tutorial-target/);
  await expect(nextButton).toBeDisabled();
  await page.locator("#atlas-button").click();
  await expect(page.locator('[data-tutorial-checkpoint="open-atlas-start-menu"]'))
    .toHaveClass(/is-complete/);
  await expect(page.locator("[data-atlas-start]").first()).toHaveClass(/tutorial-target/);
  await page.locator("[data-atlas-start]").first().click();
  await expect(page.locator('[data-tutorial-checkpoint="change-atlas-start"]'))
    .toHaveClass(/is-complete/);
  await expect(nextButton).toBeEnabled();

  await nextButton.click();
  await expect(page.getByRole("heading", { name: "Isolate one pathway in the sidebar" }))
    .toBeVisible();
  await expect(nextButton).toBeDisabled();
  await expect(page.locator("#detail-content [data-fork]").first()).toHaveClass(/tutorial-target/);
  await page.getByRole("button", { name: "Registration share", exact: true }).click();
  await expect(page.locator('[data-tutorial-checkpoint="isolate-atlas-pathway"]'))
    .toHaveClass(/is-complete/);
  await expect(nextButton).toBeEnabled();

  await nextButton.click();
  await expect(page.getByRole("heading", { name: "Open a feedback loop" })).toBeVisible();
  await expect(page.locator(".atlas g.n[data-loop]").first()).toHaveClass(/tutorial-target/);
  await expect(nextButton).toBeDisabled();
  await page.locator(".atlas g.n[data-loop]").first().click();
  await expect(page.locator('[data-tutorial-checkpoint="select-feedback-group"]'))
    .toHaveClass(/is-complete/);
  await expect(page.locator("[data-open-feedback]")).toHaveClass(/tutorial-target/);
  await page.locator("[data-open-feedback]").click();
  await expect(page.locator('[data-tutorial-checkpoint="open-feedback-loops"]'))
    .toHaveClass(/is-complete/);
  await expect(nextButton).toBeEnabled();

  await nextButton.click();
  await expect(page.getByRole("heading", { name: "Play and scrub a feedback route" }))
    .toBeVisible();
  const positionScrubber = page.getByRole("slider", {
    name: "Feedback loop animation position",
  });
  const playbackSpeedDropdown = page.getByRole("combobox", {
    name: "Feedback loop animation speed",
  });
  await expect(positionScrubber).toBeVisible();
  await expect(page.locator("#atlas-loopctl")).toHaveClass(/tutorial-target/);
  await expect(playbackSpeedDropdown.locator("xpath=..")).toHaveClass(/selection-only-dropdown/);
  await expect(positionScrubber).toHaveAttribute("max", "1000");
  const playbackCheckpoint = page.locator(
    '[data-tutorial-checkpoint="control-feedback-route"]',
  );
  await expect(playbackCheckpoint).not.toHaveClass(/is-complete/);
  await expect(nextButton).toBeDisabled();
  await playbackSpeedDropdown.click();
  await page.locator(
    'body > .typeable-dropdown-popup:not([hidden]) .typeable-dropdown-item[data-item-index="2"]',
  ).click();
  await expect(playbackSpeedDropdown).toHaveText("2×");
  const scrubberBounds = await positionScrubber.boundingBox();
  expect(scrubberBounds).not.toBeNull();
  const scrubberVerticalCentre = scrubberBounds!.y + scrubberBounds!.height / 2;
  await page.mouse.click(scrubberBounds!.x + 3, scrubberVerticalCentre);
  await page.mouse.move(scrubberBounds!.x + 3, scrubberVerticalCentre);
  await page.mouse.down();
  await page.mouse.move(
    scrubberBounds!.x + scrubberBounds!.width * 0.7,
    scrubberVerticalCentre,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect.poll(async () => Number(await positionScrubber.inputValue()))
    .toBeGreaterThan(600);
  await expect.poll(async () => Number(await positionScrubber.inputValue()))
    .toBeLessThan(800);
  await expect(page.getByRole("button", { name: "Play feedback loop animation" }))
    .toBeVisible();
  await expect(playbackCheckpoint).toHaveClass(/is-complete/);
  await expect(nextButton).toBeEnabled();

  const animationPreviousButton = page.getByRole("button", { name: "Previous", exact: true });
  const animationNextButton = page.getByRole("button", { name: "Next", exact: true });
  for (
    let stepIndex = 0;
    stepIndex < 20 && !(await animationPreviousButton.isDisabled());
    stepIndex++
  ) {
    await animationPreviousButton.click();
  }
  await expect(positionScrubber).toHaveValue("0");
  await expect(animationPreviousButton).toBeDisabled();
  await expect(animationNextButton).toBeEnabled();

  await animationNextButton.click();
  const firstBoxStepPosition = Number(await positionScrubber.inputValue());
  expect(firstBoxStepPosition).toBeGreaterThan(0);
  expect(firstBoxStepPosition).toBeLessThan(1000);
  await expect(page.locator("#atlas-loop-animation-status")).toContainText("Box 2 of");
  await expect(animationPreviousButton).toBeEnabled();
  await expect(animationNextButton).toBeEnabled();

  await animationNextButton.click();
  expect(Number(await positionScrubber.inputValue())).toBeGreaterThan(firstBoxStepPosition);
  await expect(page.locator("#atlas-loop-animation-status")).toContainText("Box 3 of");
  await animationPreviousButton.click();
  await expect(positionScrubber).toHaveValue(String(firstBoxStepPosition));
  await expect(page.locator("#atlas-loop-animation-status")).toContainText("Box 2 of");

  const toggleButton = page.locator("[data-loop-animation-toggle]");
  const scrubberPositionBeforeEndDrag = await positionScrubber.boundingBox();
  expect(scrubberPositionBeforeEndDrag).not.toBeNull();
  const scrubberCentreY = scrubberPositionBeforeEndDrag!.y +
    scrubberPositionBeforeEndDrag!.height / 2;
  await page.mouse.move(
    scrubberPositionBeforeEndDrag!.x + scrubberPositionBeforeEndDrag!.width * 0.97,
    scrubberCentreY,
  );
  await page.mouse.down();
  await page.mouse.move(
    scrubberPositionBeforeEndDrag!.x + scrubberPositionBeforeEndDrag!.width - 1,
    scrubberCentreY,
    { steps: 4 },
  );
  await expect(toggleButton).toHaveText("Play");
  await page.mouse.move(
    scrubberPositionBeforeEndDrag!.x + scrubberPositionBeforeEndDrag!.width * 0.97,
    scrubberCentreY,
    { steps: 4 },
  );
  await page.mouse.move(
    scrubberPositionBeforeEndDrag!.x + scrubberPositionBeforeEndDrag!.width - 1,
    scrubberCentreY,
    { steps: 4 },
  );
  await expect(toggleButton).toHaveText("Play");
  const scrubberPositionDuringEndDrag = await positionScrubber.boundingBox();
  expect(scrubberPositionDuringEndDrag!.x).toBeCloseTo(scrubberPositionBeforeEndDrag!.x, 0);
  await page.mouse.up();
  await expect(positionScrubber).toHaveValue("1000");
  await expect(toggleButton).toHaveText("Replay");
});

test("Atlas overview labels remain readable around a selected pathway", async ({ page }) => {
  await openCleanBuiltApp(page);
  await openConsolidatedLessonAtStep(page, "simulate-change", 7);
  const nextButton = page.locator('[data-tutorial-action="next"]');
  await page.locator('[data-action="open-atlas"]').click();
  await expect(nextButton).toBeEnabled();
  await nextButton.click();
  await expect(page.getByRole("heading", { name: "Explore the Atlas picture" })).toBeVisible();

  await page.getByRole("button", { name: "Improvement backlog ×4", exact: true }).click();
  await expect(page.locator(".atlas g.n.on > .atlas-overview-label")).toHaveCount(10);
  await expect.poll(() => page.evaluate(() => {
    const atlas = document.querySelector<SVGSVGElement>("svg.atlas");
    return atlas?.dataset.overviewLabelLayoutViewBox === atlas?.getAttribute("viewBox");
  })).toBe(true);
  const overviewLabelLayout = await page.evaluate(() => {
    const atlasBounds = document.querySelector("svg.atlas")!.getBoundingClientRect();
    const labels = [...document.querySelectorAll<SVGTextElement>(
      ".atlas g.n.on > .atlas-overview-label",
    )].map(label => {
      const bounds = label.getBoundingClientRect();
      return {
        name: label.getAttribute("aria-label") || "unnamed Atlas label",
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        bottom: bounds.bottom,
        side: label.dataset.layoutSide,
      };
    });
    return {
      atlas: {
        left: atlasBounds.left,
        right: atlasBounds.right,
        top: atlasBounds.top,
        bottom: atlasBounds.bottom,
      },
      labels,
    };
  });
  for (const label of overviewLabelLayout.labels) {
    expect(label.left, `${label.name} left edge`).toBeGreaterThanOrEqual(
      overviewLabelLayout.atlas.left - 1,
    );
    expect(label.right, `${label.name} right edge`).toBeLessThanOrEqual(
      overviewLabelLayout.atlas.right + 1,
    );
    expect(label.top, `${label.name} top edge`).toBeGreaterThanOrEqual(
      overviewLabelLayout.atlas.top - 1,
    );
    expect(label.bottom, `${label.name} bottom edge`).toBeLessThanOrEqual(
      overviewLabelLayout.atlas.bottom + 1,
    );
  }
  for (let firstIndex = 0; firstIndex < overviewLabelLayout.labels.length; firstIndex++) {
    for (let secondIndex = firstIndex + 1; secondIndex < overviewLabelLayout.labels.length; secondIndex++) {
      const firstLabel = overviewLabelLayout.labels[firstIndex];
      const secondLabel = overviewLabelLayout.labels[secondIndex];
      const overlaps = !(
        firstLabel.right <= secondLabel.left ||
        secondLabel.right <= firstLabel.left ||
        firstLabel.bottom <= secondLabel.top ||
        secondLabel.bottom <= firstLabel.top
      );
      expect(overlaps, `${firstLabel.name} overlaps ${secondLabel.name}`).toBe(false);
    }
  }
  expect(new Set(
    overviewLabelLayout.labels.map(label => Math.round(label.top)),
  ).size).toBeGreaterThan(2);
  expect(new Set(overviewLabelLayout.labels.map(label => label.side)))
    .toEqual(new Set(["above", "below"]));
  expect(overviewLabelLayout.labels.map(label => label.name)).toContain("Improvement backlog");
});

test("simulation lesson accepts dragging a numerical input", async ({ page }) => {
  await openCleanBuiltApp(page);
  await page.locator("#learn-button").click();
  await page.locator(
    '[data-lesson-card="simulate-change"] .learn-lesson-actions button',
  ).click();

  const percentageInput = page.locator(
    '.sim-slider-row[data-node-id="volunteer_hours"] .sim-pct-input',
  );
  await percentageInput.dispatchEvent("pointerdown", {
    bubbles: true,
    clientX: 100,
    pointerId: 1,
  });
  await percentageInput.dispatchEvent("pointermove", {
    bubbles: true,
    clientX: 125,
    pointerId: 1,
  });
  await percentageInput.dispatchEvent("pointerup", {
    bubbles: true,
    clientX: 125,
    pointerId: 1,
  });

  await expect(percentageInput).not.toHaveValue("100");
  await expect(page.locator('[data-tutorial-checkpoint="change-volunteer-time"]')).toHaveClass(/is-complete/);
  await expect(page.locator('[data-tutorial-action="next"]')).toBeEnabled();

  await page.locator('[data-tutorial-action="next"]').click();
  const outreachEffortVariable = page.locator(
    '.calc-formula .fx-box[data-formula-node-id="outreach_effort"]',
  );
  const outreachEffortDrivenByRow = page.locator(
    '.drow[data-edge-direction="from"][data-target-node="outreach_effort"]',
  );
  await expect(page.locator('[data-tutorial-action="next"]')).toBeDisabled();
  await expect(outreachEffortVariable).toHaveAttribute("data-tooltip", /current value: 80 hours\/month/);
  await outreachEffortVariable.hover();
  await expect(outreachEffortDrivenByRow).toHaveClass(/is-formula-variable-highlight/);
  await expect(page.locator('[data-tutorial-checkpoint="hover-formula-box"]')).toHaveClass(/is-complete/);
  await page.locator(".calc-rule").hover();
  await expect(outreachEffortDrivenByRow).not.toHaveClass(/is-formula-variable-highlight/);

  const globalVariable = page.locator(
    '.calc-formula [data-formula-param-id="people_reached_per_hour"]',
  );
  await expect(globalVariable).toHaveAttribute("data-formula-kind", "global-variable");
  await expect(globalVariable).toHaveAttribute("data-tooltip", /Global variable — value: 5/);
  await expect(globalVariable).toHaveCSS("cursor", "help");
  expect(await globalVariable.evaluate(element =>
    getComputedStyle(element, "::after").content,
  )).toBe('"global"');
  await globalVariable.hover();
  await expect(page.locator('[data-tutorial-checkpoint="hover-formula-global"]')).toHaveClass(/is-complete/);
  await expect(page.locator('[data-tutorial-action="next"]')).toBeEnabled();
  await expect(page.locator(".calc-breakdown .calc-input")).toHaveCount(0);
  const formulaCurrentResult = await page.locator(".calc-result-value").textContent();
  const formulaEquationResult = await page.locator(
    '.calc-equation--formula .calc-equation-output',
  ).textContent();
  expect(formulaCurrentResult).toContain("people/month");
  expect(formulaCurrentResult).toContain(formulaEquationResult!.replace(/^=\s*/, ""));
  await expect(page.locator(".calc-equation-summary")).toHaveText(
    "The formula sets the result directly.",
  );

  const deliveryCapacityBox = page.locator('.node-group[data-node-id="delivery_capacity"]');
  await deliveryCapacityBox.focus();
  await page.keyboard.press("Enter");
  const minimumCalculation = page.locator('.calc-breakdown[data-calc-rule="min"]');
  await expect(minimumCalculation).toBeVisible();
  await expect(minimumCalculation.locator(".calc-equation-term")).toHaveText(
    "8.00 × min(",
  );
  await expect(minimumCalculation.locator(".calc-equation-output")).toHaveText(
    "= 8.00",
  );
  await expect(minimumCalculation.locator(".calc-input--winner")).toHaveCount(2);
  await expect(minimumCalculation.locator(".calc-input-detail")).toHaveText([
    "1.00",
    "1.00",
  ]);
  const facilitatorCapacityInput = minimumCalculation.locator(
    '.calc-input[data-calculation-node-id="facilitator_slots"]',
  );
  const facilitatorCapacityDrivenByRow = page.locator(
    '.drow[data-edge-direction="from"][data-target-node="facilitator_slots"]',
  );
  await expect(facilitatorCapacityInput).toHaveCSS("box-shadow", "none");
  await expect(facilitatorCapacityInput).toHaveAttribute(
    "data-tooltip",
    /Facilitator capacity — current value: 10 sessions\/month · proportional factor: 1.00×/,
  );
  await facilitatorCapacityInput.hover();
  await expect(facilitatorCapacityDrivenByRow).toHaveClass(/is-formula-variable-highlight/);
  await minimumCalculation.locator(".calc-equation-start").hover();
  await expect(facilitatorCapacityDrivenByRow).not.toHaveClass(/is-formula-variable-highlight/);
  await expect(minimumCalculation.locator(".calc-equation-summary")).toHaveText(
    "Facilitator capacity and Venue availability are tied at 1.00×. " +
      "The first one to fall becomes the gate.",
  );

  await page.locator('.sim-slider-name[data-node-id="follow_up_readiness"]').click();
  await expect(page.locator('.calc-breakdown[data-calc-rule="pinned"]')).toBeVisible();
  await expect(page.locator(".calc-result-value")).toHaveText("0.900 share");
});

test("worked-equation styling covers every calculation rule", async ({ page }) => {
  await openCleanBuiltApp(page);
  await importCsv(page, COMBINE_CSV, "calculation-rules.csv");
  await page.locator("#sim-toggle-button").click();

  const ruleExamples = [
    { nodeIdentifier: "lone", rule: "baseline", interpretation: "Starting value sets the result." },
    { nodeIdentifier: "a", rule: "pinned", interpretation: "Your slider sets the result." },
    { nodeIdentifier: "mult", rule: "multiplicative", interpretation: "Every input factor shapes the result." },
    { nodeIdentifier: "add", rule: "additive", interpretation: "The input changes combine without compounding." },
    { nodeIdentifier: "gate", rule: "min", interpretation: "Input A and Input B are tied at 1.00×." },
  ];

  for (const ruleExample of ruleExamples) {
    const mapBox = page.locator(`.node-group[data-node-id="${ruleExample.nodeIdentifier}"]`);
    await mapBox.focus();
    await page.keyboard.press("Enter");
    const calculationBreakdown = page.locator(
      `.calc-breakdown[data-calc-rule="${ruleExample.rule}"]`,
    );
    await expect(calculationBreakdown.locator(".calc-equation")).toBeVisible();
    await expect(calculationBreakdown.locator(".calc-equation-output")).toBeVisible();
    await expect(calculationBreakdown.locator(".calc-equation-summary")).toContainText(
      ruleExample.interpretation,
    );
  }

  await importCsv(page, FORMULA_CSV, "formula-calculation.csv");
  const formulaBox = page.locator('.node-group[data-node-id="seizures"]');
  await expect(formulaBox).toBeVisible();
  const simulationIsActive = await page.locator("body").evaluate(
    bodyElement => bodyElement.classList.contains("sim-mode"),
  );
  if (!simulationIsActive) await page.locator("#sim-toggle-button").click();
  await formulaBox.focus();
  await page.keyboard.press("Enter");
  const formulaCalculation = page.locator('.calc-breakdown[data-calc-rule="formula"]');
  await expect(formulaCalculation.locator(".calc-equation")).toBeVisible();
  await expect(formulaCalculation.locator(".calc-formula")).toContainText(
    "traffic * exam_coverage * detection_rate",
  );
  await expect(formulaCalculation.locator(".calc-equation-output")).toHaveText("= 120");
  await expect(formulaCalculation.locator(".calc-equation-summary")).toHaveText(
    "The formula sets the result directly.",
  );
});

test("390 by 844 keeps the page pinned and fits the global header", async ({ page }) => {
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
  expect(dimensions.headerScrollWidth).toBeLessThanOrEqual(dimensions.headerClientWidth);
  await expect(page.locator("#theme-toggle-button")).toBeInViewport();

  await page.locator("#export-button").click();
  await expect(page.locator("#export-menu")).toBeVisible();
  const exportMenuBounds = await page.locator("#export-menu").boundingBox();
  expect(exportMenuBounds).not.toBeNull();
  expect(exportMenuBounds!.x).toBeGreaterThanOrEqual(0);
  expect(exportMenuBounds!.x + exportMenuBounds!.width).toBeLessThanOrEqual(dimensions.viewportWidth);
  await page.keyboard.press("Escape");

  const sampleCsv = await readFile(sampleCsvPath, "utf8");
  await importCsv(page, sampleCsv, "mobile-layout.csv");
  await expectSingleRowBottomToolbars(page);
  await expectVisibleControlsNotToOverlap(page, [
    ".map-review-status",
    "#map-scope-bar",
    ".viz-controls-cluster",
  ]);

  await page.evaluate(() => {
    localStorage.setItem("systems-map.learn.progress.v1", JSON.stringify({
      curriculumVersion: 4,
      completedLessonIds: ["move-around-map"],
      lastLessonId: "move-around-map",
      lastStepIndex: 0,
      completedCheckpointIdentifiersByLesson: {},
    }));
  });
  await page.locator("#learn-button").click();
  const mobileCompletedLessonActions = page.locator('[data-lesson-card="move-around-map"] .learn-lesson-actions');
  await expect(mobileCompletedLessonActions.locator("button")).toHaveCount(1);
  await expect(mobileCompletedLessonActions.locator('[data-tutorial-action="restart-lesson"]')).toHaveText("Restart lesson");
  await expect(mobileCompletedLessonActions.locator('[data-tutorial-action="lesson"]')).toHaveCount(0);
  await expect(page.locator('[data-tutorial-action="reset-all-progress"]')).toBeInViewport();
  await page.locator(
    '[data-tutorial-action="lesson"][data-lesson-id="edit-map"]',
  ).click();
  await expect(page.locator("#detail-panel")).toBeVisible();
  const tutorialMapWidth = await page.locator("#viz-scroll").evaluate(element => element.clientWidth);
  expect(tutorialMapWidth).toBeGreaterThanOrEqual(300);
});

test("the floating Review handoff sits borderless at the top of the map", async ({ page }) => {
  await openCleanBuiltApp(page);
  await importCsv(page, FORMULA_INVALID_CSV, "review-handoff.csv");
  await page.locator("#review-button").click();
  await page.locator("[data-review-issue]").first().click();
  await page.locator("[data-open-review-issue]").first().click();

  const issueBanner = page.locator("#review-issue-banner");
  await expect(issueBanner).toBeVisible();
  const darkThemeAppearance = await issueBanner.evaluate(element => {
    const styles = getComputedStyle(element);
    const elementBounds = element.getBoundingClientRect();
    const visualizationBounds = document.getElementById("viz-container")!.getBoundingClientRect();
    const summaryBounds = element.querySelector<HTMLElement>(".review-banner-main")!.getBoundingClientRect();
    const dismissBounds = element.querySelector<HTMLElement>(".review-banner-dismiss")!.getBoundingClientRect();
    return {
      backgroundColor: styles.backgroundColor,
      borderTopWidth: styles.borderTopWidth,
      relativeTop: elementBounds.top - visualizationBounds.top,
      summaryCenter: summaryBounds.top + summaryBounds.height / 2,
      dismissCenter: dismissBounds.top + dismissBounds.height / 2,
    };
  });
  expect(darkThemeAppearance.borderTopWidth).toBe("0px");
  expect(darkThemeAppearance.relativeTop).toBeGreaterThanOrEqual(56);
  expect(darkThemeAppearance.relativeTop).toBeLessThanOrEqual(64);
  expect(Math.abs(darkThemeAppearance.summaryCenter - darkThemeAppearance.dismissCenter))
    .toBeLessThanOrEqual(1);

  await page.locator("#review-banner-toggle").click();
  const expandedActions = await issueBanner.locator(".review-banner-actions").evaluate(element => {
    const styles = getComputedStyle(element);
    const buttonBounds = Array.from(element.querySelectorAll("button"), button => {
      const bounds = button.getBoundingClientRect();
      return { top: bounds.top, height: bounds.height };
    });
    return {
      alignItems: styles.alignItems,
      display: styles.display,
      buttonBounds,
    };
  });
  expect(expandedActions.display).toBe("flex");
  expect(expandedActions.alignItems).toBe("center");
  expect(expandedActions.buttonBounds.every(bounds => bounds.height >= 32)).toBe(true);

  await page.locator("#theme-toggle-button").click();
  const lightThemeAppearance = await issueBanner.evaluate(element => ({
    backgroundColor: getComputedStyle(element).backgroundColor,
    borderTopWidth: getComputedStyle(element).borderTopWidth,
  }));
  expect(lightThemeAppearance.backgroundColor).not.toBe(darkThemeAppearance.backgroundColor);
  expect(lightThemeAppearance.borderTopWidth).toBe("0px");

  await page.setViewportSize({ width: 390, height: 844 });
  const narrowAppearance = await issueBanner.evaluate(element => {
    const elementBounds = element.getBoundingClientRect();
    const visualizationBounds = document.getElementById("viz-container")!.getBoundingClientRect();
    return {
      relativeTop: elementBounds.top - visualizationBounds.top,
      left: elementBounds.left,
      right: elementBounds.right,
    };
  });
  expect(narrowAppearance.relativeTop).toBeGreaterThanOrEqual(52);
  expect(narrowAppearance.relativeTop).toBeLessThanOrEqual(60);
  expect(narrowAppearance.left).toBeGreaterThanOrEqual(0);
  expect(narrowAppearance.right).toBeLessThanOrEqual(390);
});

test("floating controls clear content and scrolling never shows browser chrome", async ({ page }) => {
  await openCleanBuiltApp(page);
  const sampleCsv = await readFile(sampleCsvPath, "utf8");
  await importCsv(page, sampleCsv, "collision-audit.csv");
  await expectSingleRowBottomToolbars(page);

  const zoomBeforeUnmodifiedFlick = await page.locator("#viz-zoom-readout").textContent();
  await page.locator("#viz-scroll").dispatchEvent("wheel", {
    bubbles: true,
    cancelable: true,
    deltaMode: 0,
    deltaX: 0,
    deltaY: -120,
  });
  await page.waitForTimeout(50);
  await expect(page.locator("#viz-zoom-readout")).toHaveText(zoomBeforeUnmodifiedFlick ?? "");

  await page.locator("#viz-scroll").dispatchEvent("wheel", {
    bubbles: true,
    cancelable: true,
    ctrlKey: true,
    deltaMode: 0,
    deltaX: 0,
    deltaY: -20,
  });
  await expect(page.locator("#viz-zoom-readout")).not.toHaveText(zoomBeforeUnmodifiedFlick ?? "");
  await page.waitForTimeout(300);

  const floatingControlSelectors = [
    ".map-review-status",
    "#map-scope-bar",
    ".viz-controls-cluster",
  ];
  await expectVisibleControlsNotToOverlap(page, floatingControlSelectors);

  await page.locator("#viz-navigation-mode-depth").click();
  await expect(page.locator("#viz-navigation-mode-depth")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#viz-depth-down")).toBeVisible();
  await expect(page.locator("#viz-depth-up")).toBeVisible();
  await expect(page.locator("#viz-zoom-out")).toBeHidden();
  const highlightDepthBeforeInteraction = await page.locator("#viz-depth-readout").textContent();
  await page.locator("#viz-depth-up").click();
  await expect(page.locator("#viz-depth-readout")).not.toHaveText(highlightDepthBeforeInteraction ?? "");
  await page.locator("#viz-navigation-mode-zoom").click();
  await expect(page.locator("#viz-navigation-mode-zoom")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#viz-zoom-out")).toBeVisible();
  await expect(page.locator("#viz-depth-up")).toBeHidden();

  await page.locator("#viz-zoom-out").click();
  await page.locator("#viz-zoom-out").click();
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const zoomReadout = document.getElementById("viz-zoom-readout")!;
    const scrollContainer = document.getElementById("viz-scroll")!;
    zoomReadout.dataset.fitNext = "width";
    scrollContainer.scrollLeft = scrollContainer.scrollWidth;
    scrollContainer.scrollTop = scrollContainer.scrollHeight;
  });
  const fitTransitionStart = await page.locator("#viz-zoom-readout").textContent();
  await page.locator("#viz-zoom-readout").click();
  await page.waitForTimeout(80);
  const fitTransitionDuringMotion = await page.evaluate(() => ({
    readout: document.getElementById("viz-zoom-readout")!.textContent,
    transform: (document.getElementById("viz-svg") as HTMLElement).style.transform,
  }));
  expect(fitTransitionDuringMotion.readout).not.toBe(fitTransitionStart);
  expect(fitTransitionDuringMotion.transform).not.toBe("");
  await page.waitForTimeout(225);
  const mapBoundsNearDestination = await page.locator("#viz-svg").boundingBox();
  await page.waitForTimeout(135);
  const mapBoundsAfterSettling = await page.locator("#viz-svg").boundingBox();
  expect(mapBoundsNearDestination).not.toBeNull();
  expect(mapBoundsAfterSettling).not.toBeNull();
  for (const coordinate of ["x", "y", "width", "height"] as const) {
    expect(Math.abs(mapBoundsAfterSettling![coordinate] - mapBoundsNearDestination![coordinate]))
      .toBeLessThan(12);
  }
  await expect.poll(async () => page.locator("#viz-svg").evaluate(element => element.style.transform))
    .toBe("");

  const zoomContinuityMeasurement = await page.evaluate(async () => {
    const scrollContainer = document.getElementById("viz-scroll")!;
    const scrollBounds = scrollContainer.getBoundingClientRect();
    const viewportCenterX = scrollBounds.left + scrollBounds.width / 2;
    const viewportCenterY = scrollBounds.top + scrollBounds.height / 2;
    const nearestVisibleNode = Array.from(
      document.querySelectorAll<SVGGElement>(".node-group[data-node-id]"),
    )
      .map(nodeGroup => ({ nodeGroup, bounds: nodeGroup.getBoundingClientRect() }))
      .filter(({ bounds }) =>
        bounds.right >= scrollBounds.left && bounds.left <= scrollBounds.right &&
        bounds.bottom >= scrollBounds.top && bounds.top <= scrollBounds.bottom,
      )
      .sort((left, right) =>
        Math.hypot(
          left.bounds.left + left.bounds.width / 2 - viewportCenterX,
          left.bounds.top + left.bounds.height / 2 - viewportCenterY,
        ) - Math.hypot(
          right.bounds.left + right.bounds.width / 2 - viewportCenterX,
          right.bounds.top + right.bounds.height / 2 - viewportCenterY,
        ),
      )[0];
    const anchorNodeId = nearestVisibleNode?.nodeGroup.getAttribute("data-node-id");
    if (!anchorNodeId) throw new Error("Expected a visible node to measure zoom continuity");

    const samples: Array<{
      centerX: number;
      centerY: number;
      compositorTransformActive: boolean;
      elapsedMilliseconds: number;
    }> = [];
    const startedAt = performance.now();
    document.getElementById("viz-zoom-out")!.click();

    return new Promise<{
      handoffMovement: number;
      maximumMovementAfterHandoff: number;
    }>((resolve, reject) => {
      const sampleFrame = (): void => {
        const nodeGroup = Array.from(
          document.querySelectorAll<SVGGElement>(".node-group[data-node-id]"),
        ).find(candidateNodeGroup =>
          candidateNodeGroup.getAttribute("data-node-id") === anchorNodeId,
        );
        if (nodeGroup) {
          const bounds = nodeGroup.getBoundingClientRect();
          samples.push({
            centerX: bounds.left + bounds.width / 2,
            centerY: bounds.top + bounds.height / 2,
            compositorTransformActive:
              (document.getElementById("viz-svg") as HTMLElement).style.transform !== "",
            elapsedMilliseconds: performance.now() - startedAt,
          });
        }

        if (performance.now() - startedAt < 700) {
          requestAnimationFrame(sampleFrame);
          return;
        }

        const handoffSampleIndex = samples.findIndex((sample, sampleIndex) =>
          sampleIndex > 0 &&
          samples[sampleIndex - 1].compositorTransformActive &&
          !sample.compositorTransformActive,
        );
        if (handoffSampleIndex < 1) {
          reject(new Error("Expected the zoom compositor transform to commit"));
          return;
        }
        const frameMovement = (sampleIndex: number): number => Math.hypot(
          samples[sampleIndex].centerX - samples[sampleIndex - 1].centerX,
          samples[sampleIndex].centerY - samples[sampleIndex - 1].centerY,
        );
        resolve({
          handoffMovement: frameMovement(handoffSampleIndex),
          maximumMovementAfterHandoff: Math.max(
            0,
            ...samples.slice(handoffSampleIndex + 1).map((_sample, relativeIndex) =>
              frameMovement(handoffSampleIndex + relativeIndex + 1),
            ),
          ),
        });
      };
      requestAnimationFrame(sampleFrame);
    });
  });
  expect(zoomContinuityMeasurement.handoffMovement).toBeLessThan(8);
  expect(zoomContinuityMeasurement.maximumMovementAfterHandoff).toBeLessThan(8);

  await page.locator("#mode-toggle-button").click();
  await expect(page.locator("body")).toHaveClass(/editing/);
  await page.waitForTimeout(350);
  await expectSingleRowBottomToolbars(page);
  await expectVisibleControlsNotToOverlap(page, floatingControlSelectors);

  await page.locator("#mode-toggle-button").click();
  await page.locator("#sim-toggle-button").click();
  await expect(page.locator("body")).toHaveClass(/sim-mode/);
  await page.waitForTimeout(350);
  await expectSingleRowBottomToolbars(page);
  await expectVisibleControlsNotToOverlap(page, floatingControlSelectors);
  await page.locator("#sim-toggle-button").click();

  for (let zoomStep = 0; zoomStep < 8; zoomStep++) {
    await page.locator("#viz-zoom-out").click();
  }
  await page.waitForTimeout(400);
  await expect(page.locator("#viz-sticky-columns")).toBeVisible();
  await expect(page.locator("#viz-sticky-rows")).toBeVisible();
  const overviewHeadingPresentation = await page.evaluate(() => {
    const columns = Array.from(document.querySelectorAll<HTMLElement>(".viz-sticky-column"));
    const rows = Array.from(document.querySelectorAll<HTMLElement>(".viz-sticky-row"));
    const nodeLabels = Array.from(document.querySelectorAll<SVGTextElement>(".node-label"));
    const nodeLabelScreenHeights = nodeLabels
      .map(label => label.getBoundingClientRect().height)
      .sort((leftHeight, rightHeight) => leftHeight - rightHeight);
    return {
      columnsOverview: document.getElementById("viz-sticky-columns")!.classList.contains("overview"),
      rowsOverview: document.getElementById("viz-sticky-rows")!.classList.contains("overview"),
      columnFontSizes: columns.map(column => parseFloat(getComputedStyle(column).fontSize)),
      rowFontSizes: rows.map(row => parseFloat(getComputedStyle(row).fontSize)),
      columnsFit: columns.every(column =>
        column.scrollWidth <= column.clientWidth + 1 &&
        column.scrollHeight <= column.clientHeight + 1
      ),
      minimumColumnScreenWidth: Math.min(
        ...Array.from(document.querySelectorAll<SVGRectElement>(".col-header-hit"))
          .map(columnRectangle => columnRectangle.getBoundingClientRect().width),
      ),
      rowsFit: rows
        .filter(row => row.clientHeight > 0)
        .every(row => row.scrollHeight <= row.clientHeight + 1),
      nodeLabelsFit: nodeLabels.every(label => {
        const labelBounds = label.getBoundingClientRect();
        const nodeBounds = label.closest(".node-group")
          ?.querySelector<SVGRectElement>(".node-rect")
          ?.getBoundingClientRect();
        return !!nodeBounds &&
          labelBounds.left >= nodeBounds.left - 1 &&
          labelBounds.right <= nodeBounds.right + 1 &&
          labelBounds.top >= nodeBounds.top - 1 &&
          labelBounds.bottom <= nodeBounds.bottom + 1;
      }),
      typicalNodeLabelScreenHeight: nodeLabelScreenHeights[
        Math.floor(nodeLabelScreenHeights.length / 2)
      ],
      originalColumnsHidden: Array.from(document.querySelectorAll<HTMLElement>(".col-header-group"))
        .every(column => getComputedStyle(column).visibility === "hidden"),
      originalRowsHidden: Array.from(document.querySelectorAll<HTMLElement>(".row-label-group"))
        .every(row => getComputedStyle(row).visibility === "hidden"),
      floatingColumnZIndex: Number(getComputedStyle(document.getElementById("viz-sticky-columns")!).zIndex),
      floatingRowZIndex: Number(getComputedStyle(document.getElementById("viz-sticky-rows")!).zIndex),
      columnBandCoversRowRail: (() => {
        const columnBandBounds = document.getElementById("viz-sticky-columns")!.getBoundingClientRect();
        const rowRailBounds = document.getElementById("viz-sticky-rows")!.getBoundingClientRect();
        return columnBandBounds.left <= rowRailBounds.left &&
          columnBandBounds.bottom <= rowRailBounds.top;
      })(),
    };
  });
  expect(overviewHeadingPresentation.columnsOverview).toBe(true);
  expect(overviewHeadingPresentation.rowsOverview).toBe(true);
  expect(overviewHeadingPresentation.columnFontSizes.every(size => size >= 10)).toBe(true);
  expect(overviewHeadingPresentation.rowFontSizes.every(size => size >= 10)).toBe(true);
  expect(overviewHeadingPresentation.columnsFit).toBe(true);
  expect(overviewHeadingPresentation.minimumColumnScreenWidth).toBeGreaterThanOrEqual(100);
  expect(overviewHeadingPresentation.rowsFit).toBe(true);
  expect(overviewHeadingPresentation.nodeLabelsFit).toBe(true);
  expect(overviewHeadingPresentation.typicalNodeLabelScreenHeight).toBeLessThan(7);
  expect(overviewHeadingPresentation.originalColumnsHidden).toBe(true);
  expect(overviewHeadingPresentation.originalRowsHidden).toBe(true);
  expect(overviewHeadingPresentation.floatingColumnZIndex)
    .toBeGreaterThan(overviewHeadingPresentation.floatingRowZIndex);
  expect(overviewHeadingPresentation.columnBandCoversRowRail).toBe(true);
  await page.keyboard.press("Control+0");
  await page.waitForTimeout(250);
  await expect(page.locator("#viz-sticky-columns")).toBeHidden();
  await expect(page.locator("#viz-sticky-rows")).toBeHidden();
  await expect(page.locator(".col-header-group").first()).toHaveCSS("visibility", "visible");
  await expect(page.locator(".row-label-group").first()).toHaveCSS("visibility", "visible");

  const bottomBox = page.locator(".node-group").last();
  await bottomBox.hover();
  await expect(page.locator("#tooltip")).toHaveClass(/visible/);
  const tooltipBounds = await page.locator("#tooltip").boundingBox();
  const dockBounds = await page.locator(".map-bottom-dock").boundingBox();
  expect(tooltipBounds).not.toBeNull();
  expect(dockBounds).not.toBeNull();
  expect(tooltipBounds!.y + tooltipBounds!.height).toBeLessThanOrEqual(dockBounds!.y);

  const scrollbarWidths = await page.evaluate(() => {
    const selectors = [
      ".app-header",
      "#viz-scroll",
      "#sidebar",
      "#detail-panel",
      ".builder-step-scroll",
      ".rail-list",
    ];
    return selectors
      .map(selector => document.querySelector<HTMLElement>(selector))
      .filter((element): element is HTMLElement => !!element)
      .map(element => getComputedStyle(element).scrollbarWidth);
  });
  expect(scrollbarWidths.every(width => width === "none")).toBe(true);

  await page.locator("#learn-button").click();
  await expect(page.getByRole("dialog", { name: "Learn Ariadne Maps" })).toBeVisible();
  const learnSurfaceStyles = await page.evaluate(() => {
    const library = document.querySelector<HTMLElement>(".learn-library")!;
    const scrollSurfaces = [
      document.querySelector<HTMLElement>(".learn-library-body"),
      document.querySelector<HTMLElement>(".learn-journey-list"),
    ].filter((element): element is HTMLElement => !!element);
    return {
      borderTopWidth: getComputedStyle(library).borderTopWidth,
      scrollbarWidths: scrollSurfaces.map(element => getComputedStyle(element).scrollbarWidth),
    };
  });
  expect(learnSurfaceStyles.borderTopWidth).toBe("0px");
  expect(learnSurfaceStyles.scrollbarWidths.every(width => width === "none")).toBe(true);
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
  await page.locator("#sim-toggle-button").click();
  await expect(page.locator("body")).not.toHaveClass(/sim-mode/);

  const readToEditModeMilliseconds = await measureBrowserInteraction(
    page,
    async () => page.locator("#mode-toggle-button").click(),
    async () => {
      await expect(page.locator("body")).toHaveClass(/editing/);
      await expect(page.locator("#mode-toggle-button")).toHaveText("View map");
    },
  );
  const editToReadModeMilliseconds = await measureBrowserInteraction(
    page,
    async () => page.locator("#mode-toggle-button").click(),
    async () => {
      await expect(page.locator("body")).toHaveClass(/reading/);
      await expect(page.locator("#mode-toggle-button")).toHaveText("Edit map");
    },
  );

  const atlasStartBox = page.locator('.node-group[data-node-id="box_0"]');
  await atlasStartBox.evaluate((element) =>
    element.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
  await expect(atlasStartBox).toHaveAttribute("aria-pressed", "true");
  const atlasOpenMilliseconds = await measureBrowserInteraction(
    page,
    async () => page.locator('[data-action="open-atlas"]').click(),
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
