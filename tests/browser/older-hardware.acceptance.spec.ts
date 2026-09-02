import { expect, test, type Page } from "@playwright/test";

interface StartupPerformanceAudit {
  cumulativeLayoutShift: number;
  layoutShifts: Array<{
    value: number;
    sources: Array<{
      nodeDescription: string;
      previousRectangle: string;
      currentRectangle: string;
    }>;
  }>;
  longTaskDurationsMilliseconds: number[];
  transitionRunsWhileBooting: number;
}

declare global {
  interface Window {
    startupPerformanceAudit: StartupPerformanceAudit;
  }
}

function ordinaryThreeHundredBoxCsv(): string {
  const streamRows = Array.from(
    { length: 20 },
    (_, streamIndex) => `row_${streamIndex},Row ${streamIndex},R${streamIndex},#64748b`,
  ).join("\n");
  const stageRows = Array.from(
    { length: 15 },
    (_, stageIndex) => `column_${stageIndex},Column ${stageIndex}`,
  ).join("\n");
  const nodeRows = Array.from({ length: 300 }, (_, nodeIndex) => {
    const streamIndex = Math.floor(nodeIndex / 15);
    const stageIndex = nodeIndex % 15;
    return `box_${nodeIndex},Box ${nodeIndex},Cold restore fixture,row_${streamIndex},column_${stageIndex},general,100,units,${nodeIndex < 20 ? "true" : ""},,200,,,,`;
  }).join("\n");
  const edgeRows = Array.from(
    { length: 299 },
    (_, edgeIndex) => `box_${edgeIndex},box_${edgeIndex + 1},increases,0.1,`,
  ).join("\n");

  return `# SECTION: streams\nid,label,short,color\n${streamRows}\n\n# SECTION: stages\nid,label\n${stageRows}\n\n# SECTION: categories\nid,label,color,text_color\ngeneral,General,#94a3b8,#111827\n\n# SECTION: nodes\nid,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max,combine,formula,min,max\n${nodeRows}\n\n# SECTION: edges\nfrom,to,effect,elasticity,description\n${edgeRows}\n`;
}

function percentileMeasurement(measurements: number[], percentile: number): number {
  const sortedMeasurements = [...measurements].sort((left, right) => left - right);
  const percentileIndex = Math.ceil(sortedMeasurements.length * percentile) - 1;
  return sortedMeasurements[Math.max(0, percentileIndex)];
}

interface ProgressiveAtlasOpenMeasurement {
  structureCommitMilliseconds: number;
  structurePaintMilliseconds: number;
  settledReadyPaintMilliseconds: number;
}

async function measureProgressiveAtlasOpen(page: Page): Promise<ProgressiveAtlasOpenMeasurement> {
  return page.evaluate(async () => {
    const atlasStage = document.getElementById("atlas-stage")!;
    const openAtlasButton = document.querySelector<HTMLElement>('[data-action="open-atlas"]')!;
    const waitForRenderPhase = (phase: "structure" | "complete"): Promise<void> =>
      new Promise(resolvePhase => {
        if (atlasStage.dataset.renderPhase === phase) {
          resolvePhase();
          return;
        }
        const phaseObserver = new MutationObserver(() => {
          if (atlasStage.dataset.renderPhase !== phase) return;
          phaseObserver.disconnect();
          resolvePhase();
        });
        phaseObserver.observe(atlasStage, {
          attributes: true,
          attributeFilter: ["data-render-phase"],
        });
      });
    const waitForPaint = (): Promise<void> => new Promise(resolvePaint =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolvePaint())),
    );
    const structureCommitted = waitForRenderPhase("structure");
    const renderCompleted = waitForRenderPhase("complete");
    const startedAt = performance.now();
    openAtlasButton.click();
    await structureCommitted;
    const structureCommitMilliseconds = performance.now() - startedAt;
    if (atlasStage.getAttribute("aria-busy") !== "true" ||
        !atlasStage.querySelector("svg.atlas .fl") ||
        !atlasStage.querySelector("svg.atlas g.n")) {
      throw new Error("Atlas structure phase must expose meaningful flows and elements while busy");
    }
    await waitForPaint();
    const structurePaintMilliseconds = performance.now() - startedAt;
    await renderCompleted;
    await waitForPaint();
    if (atlasStage.hasAttribute("aria-busy")) {
      throw new Error("Completed Atlas must clear its busy state");
    }
    return {
      structureCommitMilliseconds,
      structurePaintMilliseconds,
      settledReadyPaintMilliseconds: performance.now() - startedAt,
    };
  });
}

async function measureCompletedAtlasReopen(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const atlasStage = document.getElementById("atlas-stage")!;
    const openAtlasButton = document.querySelector<HTMLElement>('[data-action="open-atlas"]')!;
    const startedAt = performance.now();
    openAtlasButton.click();
    if (atlasStage.dataset.renderPhase !== "complete") {
      await new Promise<void>(resolveComplete => {
        const phaseObserver = new MutationObserver(() => {
          if (atlasStage.dataset.renderPhase !== "complete") return;
          phaseObserver.disconnect();
          resolveComplete();
        });
        phaseObserver.observe(atlasStage, {
          attributes: true,
          attributeFilter: ["data-render-phase"],
        });
      });
    }
    await new Promise<void>(resolvePaint => requestAnimationFrame(() =>
      requestAnimationFrame(() => resolvePaint()),
    ));
    return performance.now() - startedAt;
  });
}

test("six-times-slower CPU restores and operates an ordinary 300-box map within budget", async ({
  page,
  context,
}) => {
  test.slow();
  const developerToolsSession = await context.newCDPSession(page);
  await developerToolsSession.send("Emulation.setCPUThrottlingRate", { rate: 6 });
  await developerToolsSession.send("Network.enable");
  await developerToolsSession.send("Network.setCacheDisabled", { cacheDisabled: true });

  await page.addInitScript(({ storedCsv, storedUserInterface }) => {
    window.startupPerformanceAudit = {
      cumulativeLayoutShift: 0,
      layoutShifts: [],
      longTaskDurationsMilliseconds: [],
      transitionRunsWhileBooting: 0,
    };
    document.addEventListener("transitionrun", () => {
      if (document.documentElement.classList.contains("app-booting")) {
        window.startupPerformanceAudit.transitionRunsWhileBooting += 1;
      }
    });
    new PerformanceObserver(entryList => {
      for (const entry of entryList.getEntries()) {
        const layoutShiftEntry = entry as PerformanceEntry & {
          value: number;
          hadRecentInput: boolean;
          sources?: Array<{
            node?: Node;
            previousRect: DOMRectReadOnly;
            currentRect: DOMRectReadOnly;
          }>;
        };
        if (!layoutShiftEntry.hadRecentInput) {
          window.startupPerformanceAudit.cumulativeLayoutShift += layoutShiftEntry.value;
          window.startupPerformanceAudit.layoutShifts.push({
            value: layoutShiftEntry.value,
            sources: (layoutShiftEntry.sources ?? []).map(source => ({
              nodeDescription: source.node instanceof Element
                ? `${source.node.tagName.toLowerCase()}#${source.node.id}.${Array.from(source.node.classList).join(".")}`
                : source.node?.nodeName ?? "unknown",
              previousRectangle: JSON.stringify(source.previousRect.toJSON()),
              currentRectangle: JSON.stringify(source.currentRect.toJSON()),
            })),
          });
        }
      }
    }).observe({ type: "layout-shift", buffered: true });
    new PerformanceObserver(entryList => {
      for (const entry of entryList.getEntries()) {
        window.startupPerformanceAudit.longTaskDurationsMilliseconds.push(entry.duration);
      }
    }).observe({ type: "longtask", buffered: true });
    localStorage.setItem("systems-map.csv", storedCsv);
    localStorage.setItem("systems-map.ui", JSON.stringify(storedUserInterface));
  }, {
    storedCsv: ordinaryThreeHundredBoxCsv(),
    storedUserInterface: {
      uiMode: "edit",
      sidebarPinned: false,
      detailPanelPinned: false,
      sidebarWidth: 420,
      detailPanelWidth: 460,
      zoomLevel: 0.8,
      highlightDepth: 2,
      selectedNodeId: "box_150",
      hiddenStreams: [],
      hiddenCategories: [],
      hiddenStages: [],
      hiddenEffects: [],
      hiddenStyles: [],
      hiddenTrace: [],
      userOverrides: {},
    },
  });

  const repeatedMeasurements: Array<{
    loadMilliseconds: number;
    firstContentfulPaintMilliseconds: number;
    cumulativeLayoutShift: number;
    layoutShifts: StartupPerformanceAudit["layoutShifts"];
    transitionRunsWhileBooting: number;
    shellTransitionDuration: string;
    longTaskCount: number;
    longestTaskMilliseconds: number;
  }> = [];
  for (let repetitionIndex = 0; repetitionIndex < 4; repetitionIndex += 1) {
    if (repetitionIndex === 0) {
      await page.goto("/systems-map.html", { waitUntil: "load" });
    } else {
      await page.reload({ waitUntil: "load" });
    }
    await expect(page.locator("html")).not.toHaveClass(/app-booting/);
    await expect(page.locator("body")).toHaveClass(/editing/);
    await expect(page.locator(".node-group")).toHaveCount(300);
    await expect(page.locator(".node-simulation-value")).toHaveCount(0);
    await expect(page.locator('.node-group[data-node-id="box_150"]')).toHaveAttribute("aria-pressed", "true");

    repeatedMeasurements.push(await page.evaluate(() => {
      const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
      const firstContentfulPaint = performance.getEntriesByName("first-contentful-paint")[0];
      return {
        loadMilliseconds: navigation.loadEventEnd,
        firstContentfulPaintMilliseconds: firstContentfulPaint?.startTime ?? Number.POSITIVE_INFINITY,
        cumulativeLayoutShift: window.startupPerformanceAudit.cumulativeLayoutShift,
        layoutShifts: window.startupPerformanceAudit.layoutShifts,
        transitionRunsWhileBooting: window.startupPerformanceAudit.transitionRunsWhileBooting,
        shellTransitionDuration: getComputedStyle(document.querySelector(".app")!).transitionDuration,
        longTaskCount: window.startupPerformanceAudit.longTaskDurationsMilliseconds.length,
        longestTaskMilliseconds: Math.max(
          0,
          ...window.startupPerformanceAudit.longTaskDurationsMilliseconds,
        ),
      };
    }));
  }

  console.log(JSON.stringify({
    cpuThrottlingRate: 6,
    repetitions: repeatedMeasurements,
    p75FirstContentfulPaintMilliseconds: percentileMeasurement(
      repeatedMeasurements.map(measurement => measurement.firstContentfulPaintMilliseconds),
      0.75,
    ),
    p75LoadMilliseconds: percentileMeasurement(
      repeatedMeasurements.map(measurement => measurement.loadMilliseconds),
      0.75,
    ),
    p75LongestTaskMilliseconds: percentileMeasurement(
      repeatedMeasurements.map(measurement => measurement.longestTaskMilliseconds),
      0.75,
    ),
    p75LongTaskCount: percentileMeasurement(
      repeatedMeasurements.map(measurement => measurement.longTaskCount),
      0.75,
    ),
  }));
  expect(repeatedMeasurements.every(measurement => measurement.transitionRunsWhileBooting === 0)).toBe(true);
  expect(repeatedMeasurements.every(measurement => measurement.cumulativeLayoutShift < 0.01)).toBe(true);
  expect(repeatedMeasurements.every(measurement => measurement.shellTransitionDuration !== "0s")).toBe(true);
  expect(percentileMeasurement(
    repeatedMeasurements.map(measurement => measurement.firstContentfulPaintMilliseconds),
    0.75,
  )).toBeLessThan(1_000);
  expect(percentileMeasurement(
    repeatedMeasurements.map(measurement => measurement.loadMilliseconds),
    0.75,
  )).toBeLessThan(1_200);
  expect(percentileMeasurement(
    repeatedMeasurements.map(measurement => measurement.longestTaskMilliseconds),
    0.75,
  )).toBeLessThan(800);
  expect(percentileMeasurement(
    repeatedMeasurements.map(measurement => measurement.longTaskCount),
    0.75,
  )).toBeLessThan(6);

  const sansFontResult = await page.evaluate(async () => {
    const loadCounts = await Promise.all([400, 500, 600].map(async fontWeight =>
      (await document.fonts.load(`${fontWeight} 16px "IBM Plex Sans"`)).length,
    ));
    const fontFaces = Array.from(document.fonts)
      .filter(fontFace => fontFace.family.includes("IBM Plex Sans"))
      .map(fontFace => ({ status: fontFace.status, weight: fontFace.weight }));
    return { loadCounts, fontFaces };
  });
  expect(sansFontResult.loadCounts.every(loadCount => loadCount > 0)).toBe(true);
  expect(sansFontResult.fontFaces.every(fontFace => fontFace.status === "loaded")).toBe(true);
  // Chromium usually exposes the single ranged face as `400 600`, but after
  // earlier documents in the same browser process have requested individual
  // weights it may enumerate three synthesized weight entries. The build gate
  // independently proves that all three resolve to one physical font payload.
  expect([
    "400 600",
    "400,500,600",
  ]).toContain(sansFontResult.fontFaces.map(fontFace => fontFace.weight).sort().join(","));

  const longTaskCountBeforeInteractions = await page.evaluate(
    () => window.startupPerformanceAudit.longTaskDurationsMilliseconds.length,
  );
  const selectionDurationsMilliseconds: number[] = [];
  for (const nodeIndex of [10, 80, 160, 240]) {
    selectionDurationsMilliseconds.push(await page.evaluate(async selectedNodeIndex => {
      const node = document.querySelector<SVGGElement>(
        `.node-group[data-node-id="box_${selectedNodeIndex}"]`,
      )!;
      const startedAt = performance.now();
      node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise<void>(resolvePaint => requestAnimationFrame(() =>
        requestAnimationFrame(() => resolvePaint()),
      ));
      return performance.now() - startedAt;
    }, nodeIndex));
    await expect(page.locator(`.node-group[data-node-id="box_${nodeIndex}"]`))
      .toHaveAttribute("aria-pressed", "true");
  }

  const simulationEntryDurationsMilliseconds: number[] = [];
  const simulationExitDurationsMilliseconds: number[] = [];
  for (let simulationRepetitionIndex = 0; simulationRepetitionIndex < 4; simulationRepetitionIndex += 1) {
    simulationEntryDurationsMilliseconds.push(await page.evaluate(async () => {
      const simulationToggleButton = document.getElementById("sim-toggle-button")!;
      const startedAt = performance.now();
      simulationToggleButton.click();
      await new Promise<void>(resolvePaint => requestAnimationFrame(() =>
        requestAnimationFrame(() => resolvePaint()),
      ));
      return performance.now() - startedAt;
    }));
    await expect(page.locator("body")).toHaveClass(/sim-mode/);
    await expect(page.locator(".node-simulation-value")).toHaveCount(900);
    simulationExitDurationsMilliseconds.push(await page.evaluate(async () => {
      const simulationToggleButton = document.getElementById("sim-toggle-button")!;
      const startedAt = performance.now();
      simulationToggleButton.click();
      await new Promise<void>(resolvePaint => requestAnimationFrame(() =>
        requestAnimationFrame(() => resolvePaint()),
      ));
      return performance.now() - startedAt;
    }));
    await expect(page.locator("body")).not.toHaveClass(/sim-mode/);
  }

  await page.locator("#sim-toggle-button").evaluate(element => (element as HTMLElement).click());
  await expect(page.locator("body")).toHaveClass(/sim-mode/);
  const simulationDurationsMilliseconds: number[] = [];
  for (const simulationPercentage of [110, 120, 130, 140]) {
    simulationDurationsMilliseconds.push(await page.evaluate(async percentage => {
      const simulationInput = document.querySelector<HTMLInputElement>(
        '.sim-pct-input[data-node-id="box_0"]',
      )!;
      const startedAt = performance.now();
      simulationInput.value = String(percentage);
      simulationInput.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise<void>(resolvePaint => requestAnimationFrame(() =>
        requestAnimationFrame(() => resolvePaint()),
      ));
      return performance.now() - startedAt;
    }, simulationPercentage));
    await expect(page.locator('.sim-pct-input[data-node-id="box_0"]'))
      .toHaveValue(String(simulationPercentage));
  }
  await page.locator("#sim-toggle-button").evaluate(element => (element as HTMLElement).click());
  await expect(page.locator("body")).not.toHaveClass(/sim-mode/);

  const atlasStartNode = page.locator('.node-group[data-node-id="box_0"]');
  await atlasStartNode.evaluate(element =>
    element.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
  await expect(atlasStartNode).toHaveAttribute("aria-pressed", "true");
  const firstAtlasOpenMeasurement = await measureProgressiveAtlasOpen(page);
  await expect(page.locator("body")).toHaveClass(/atlas-open/);
  await expect(page.locator('#atlas-stage[data-render-phase="complete"]'))
    .not.toHaveAttribute("aria-busy");
  await page.locator("#atlas-exit-button").evaluate(element => (element as HTMLElement).click());
  await expect(page.locator("body")).not.toHaveClass(/atlas-open/);
  await expect(page.locator("#atlas-stage")).not.toHaveAttribute("data-render-phase");
  await expect(page.locator("#atlas-stage")).not.toHaveAttribute("aria-busy");

  const atlasReopenDurationsMilliseconds: number[] = [];
  for (let atlasRepetitionIndex = 0; atlasRepetitionIndex < 3; atlasRepetitionIndex += 1) {
    atlasReopenDurationsMilliseconds.push(await measureCompletedAtlasReopen(page));
    await expect(page.locator("body")).toHaveClass(/atlas-open/);
    await expect(page.locator('#atlas-stage[data-render-phase="complete"]'))
      .not.toHaveAttribute("aria-busy");
    await expect(page.locator("#atlas-stage:not([hidden]) svg.atlas g.n").first()).toBeVisible();
    await page.locator("#atlas-exit-button").evaluate(element => (element as HTMLElement).click());
    await expect(page.locator("body")).not.toHaveClass(/atlas-open/);
    await expect(page.locator("#atlas-stage")).not.toHaveAttribute("data-render-phase");
    await expect(page.locator("#atlas-stage")).not.toHaveAttribute("aria-busy");
  }

  await page.waitForTimeout(100);
  const interactionLongTaskDurationsMilliseconds = await page.evaluate(startIndex =>
    window.startupPerformanceAudit.longTaskDurationsMilliseconds.slice(startIndex),
  longTaskCountBeforeInteractions);
  const interactionMeasurements = {
    p75SelectionMilliseconds: percentileMeasurement(selectionDurationsMilliseconds, 0.75),
    p75SimulationEntryMilliseconds: percentileMeasurement(
      simulationEntryDurationsMilliseconds,
      0.75,
    ),
    p75SimulationExitMilliseconds: percentileMeasurement(
      simulationExitDurationsMilliseconds,
      0.75,
    ),
    p75SimulationMilliseconds: percentileMeasurement(simulationDurationsMilliseconds, 0.75),
    firstAtlasStructurePaintMilliseconds: firstAtlasOpenMeasurement.structurePaintMilliseconds,
    firstAtlasSettledReadyPaintMilliseconds: firstAtlasOpenMeasurement.settledReadyPaintMilliseconds,
    p75AtlasReopenMilliseconds: percentileMeasurement(
      atlasReopenDurationsMilliseconds,
      0.75,
    ),
    longTaskCount: interactionLongTaskDurationsMilliseconds.length,
    longestTaskMilliseconds: Math.max(0, ...interactionLongTaskDurationsMilliseconds),
  };
  console.log(JSON.stringify({
    cpuThrottlingRate: 6,
    selectionDurationsMilliseconds,
    simulationEntryDurationsMilliseconds,
    simulationExitDurationsMilliseconds,
    simulationDurationsMilliseconds,
    firstAtlasOpenMeasurement,
    atlasReopenDurationsMilliseconds,
    interactionMeasurements,
  }));
  expect(interactionMeasurements.p75SelectionMilliseconds).toBeLessThan(100);
  expect(interactionMeasurements.p75SimulationEntryMilliseconds).toBeLessThan(250);
  expect(interactionMeasurements.p75SimulationExitMilliseconds).toBeLessThan(250);
  expect(interactionMeasurements.p75SimulationMilliseconds).toBeLessThan(100);
  expect(interactionMeasurements.firstAtlasStructurePaintMilliseconds).toBeLessThan(225);
  expect(interactionMeasurements.firstAtlasSettledReadyPaintMilliseconds).toBeLessThan(350);
  expect(interactionMeasurements.p75AtlasReopenMilliseconds).toBeLessThan(100);
  expect(interactionMeasurements.longTaskCount).toBeLessThan(16);
  expect(interactionMeasurements.longestTaskMilliseconds).toBeLessThan(400);

  // A close during the structure phase must invalidate its deferred work. The
  // next open for that start box must build progressively again rather than
  // treating the cancelled, incomplete SVG as a reusable completed picture.
  const lifecycleAtlasStartNode = page.locator('.node-group[data-node-id="box_1"]');
  await lifecycleAtlasStartNode.evaluate(element =>
    element.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
  await expect(lifecycleAtlasStartNode).toHaveAttribute("aria-pressed", "true");
  await page.evaluate(async () => {
    const atlasStage = document.getElementById("atlas-stage")!;
    const structureReached = new Promise<void>(resolveStructure => {
      const phaseObserver = new MutationObserver(() => {
        if (atlasStage.dataset.renderPhase !== "structure") return;
        phaseObserver.disconnect();
        document.getElementById("atlas-exit-button")!.click();
        resolveStructure();
      });
      phaseObserver.observe(atlasStage, {
        attributes: true,
        attributeFilter: ["data-render-phase"],
      });
    });
    document.querySelector<HTMLElement>('[data-action="open-atlas"]')!.click();
    await structureReached;
  });
  await expect(page.locator("body")).not.toHaveClass(/atlas-open/);
  await expect(page.locator("#atlas-stage")).not.toHaveAttribute("data-render-phase");
  await expect(page.locator("#atlas-stage")).not.toHaveAttribute("aria-busy");
  await page.waitForTimeout(100);
  await expect(page.locator("#atlas-stage")).not.toHaveAttribute("data-render-phase");

  const restartedAtlasOpenMeasurement = await measureProgressiveAtlasOpen(page);
  expect(restartedAtlasOpenMeasurement.structureCommitMilliseconds)
    .toBeLessThan(restartedAtlasOpenMeasurement.settledReadyPaintMilliseconds);
  await expect(page.locator('#atlas-stage[data-render-phase="complete"]'))
    .not.toHaveAttribute("aria-busy");
  await page.locator("#atlas-exit-button").evaluate(element => (element as HTMLElement).click());
  await expect(page.locator("body")).not.toHaveClass(/atlas-open/);

  // Removing the boot guard must not remove the deliberate mode transition.
  await page.locator("#mode-toggle-button").evaluate(element => (element as HTMLElement).click());
  await expect(page.locator("body")).toHaveClass(/editing/);
});
