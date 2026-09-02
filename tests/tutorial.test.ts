import { afterEach, describe, expect, it, vi } from "vitest";
import { SAMPLE_CSV } from "../assets/js/01-sample-data";
import { TUTORIAL_MAP_CSV } from "../assets/js/01a-tutorial-map-data";
import {
  CATEGORIES,
  DEFAULT_ELASTICITY_BY_EFFECT,
  EDGES,
  NODES,
  PARAMS,
  STAGES,
  STREAMS,
  nodeById,
  setCategories,
  setDefaultElasticityByEffect,
  setParams,
  setStages,
  setStreams,
  state,
} from "../assets/js/03-state";
import {
  STORAGE_KEY_BUILDER,
  STORAGE_KEY_CSV,
  loadCsvFromStorage,
  saveBuilderToStorage,
  storageWritesAreSuspended,
} from "../assets/js/04a-storage";
import { parseCsvDocument } from "../assets/js/05-csv-parser";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import { selectEdge, setSelection } from "../assets/js/09-graph-selection";
import { render } from "../assets/js/11-rendering";
import { openBuilder } from "../assets/js/16a-builder-state";
import { bootEmptyStateGrid } from "../assets/js/16e-canvas-edit";
import { applyCanvasMutation } from "../assets/js/16f-canvas-mutations";
import { historyRedo, historyUndo } from "../assets/js/16g-canvas-undo";
import {
  captureAtlasSessionState,
  closeAtlas,
  openAtlas,
  openFirstFeedbackTangle,
} from "../assets/js/21-atlas-view";
import { closeReview, openReview, reviewIsOpen } from "../assets/js/23-review-panel";
import { endReviewPass, startReviewPass } from "../assets/js/24-review-record";
import {
  LEARN_LESSONS,
  LEARN_PROGRESS_KEY,
  TUTORIAL_COMPLETION_KEY,
  TUTORIAL_STEPS,
  completeTutorialAndKeepExample,
  completeTutorialAndRestore,
  exitTutorial,
  goToTutorialStep,
  loadLearnProgress,
  openLearnHub,
  showFirstOpenTutorialWelcome,
  startLearnLesson,
  startTutorial,
  tutorialIsActive,
} from "../assets/js/26-tutorial";

function tutorialLayer(): HTMLElement {
  return document.getElementById("tutorial-layer")!;
}

afterEach(() => {
  exitTutorial({ markDismissed: false });
});

describe("first-open tutorial welcome", () => {
  it("appears only without a saved map or a completion decision", () => {
    expect(showFirstOpenTutorialWelcome(false)).toBe(true);
    expect(tutorialLayer().hidden).toBe(false);
    expect(tutorialLayer().textContent).toContain("Start guided tour");

    tutorialLayer().querySelector<HTMLElement>('[data-tutorial-action="blank"]')!.click();
    expect(localStorage.getItem(TUTORIAL_COMPLETION_KEY)).toBe("dismissed");
    expect(tutorialLayer().hidden).toBe(true);
    expect(showFirstOpenTutorialWelcome(false)).toBe(false);
  });

  it("does not appear when a saved map exists", () => {
    expect(showFirstOpenTutorialWelcome(true)).toBe(false);
    expect(tutorialLayer().hidden).toBe(true);
  });

  it("blocks the first-open persistence race until Start blank is chosen", () => {
    bootEmptyStateGrid();
    expect(loadCsvFromStorage()).toBeNull();
    expect(showFirstOpenTutorialWelcome(false)).toBe(true);
    expect(storageWritesAreSuspended()).toBe(true);

    // Any writer that arrives while the welcome is undecided is ignored.
    localStorage.removeItem(STORAGE_KEY_CSV);
    expect(loadCsvFromStorage()).toBeNull();

    tutorialLayer().querySelector<HTMLElement>('[data-tutorial-action="blank"]')!.click();
    expect(storageWritesAreSuspended()).toBe(false);
    expect(loadCsvFromStorage()).toBeTruthy();
    expect(localStorage.getItem(TUTORIAL_COMPLETION_KEY)).toBe("dismissed");
  });

  it("starts the guided route from the prominent welcome action", () => {
    expect(showFirstOpenTutorialWelcome(false)).toBe(true);
    tutorialLayer().querySelector<HTMLElement>('[data-tutorial-action="start"]')!.click();

    expect(tutorialIsActive()).toBe(true);
    expect(nodeById.workshop_readiness).toBeDefined();
    expect(tutorialLayer().textContent).toContain("Step 1 of " + TUTORIAL_STEPS.length);
  });

  it("can be entered again from the first lesson in Learn", () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    (document.getElementById("learn-button") as HTMLButtonElement).click();
    const lessonAction = tutorialLayer().querySelector<HTMLElement>(
      '[data-lesson-id="modes-panels-theme"][data-tutorial-action="lesson"]',
    )!;

    lessonAction.click();

    expect(tutorialIsActive()).toBe(true);
    expect(nodeById.workshop_readiness).toBeDefined();
  });
});

describe("Learn library", () => {
  it("exposes a stable six-course curriculum from a top-level action", () => {
    const lessonIdentifiers = LEARN_LESSONS.map(lesson => lesson.id);
    expect(lessonIdentifiers).toHaveLength(29);
    expect(new Set(lessonIdentifiers).size).toBe(lessonIdentifiers.length);
    expect(new Set(LEARN_LESSONS.map(lesson => lesson.groupId))).toEqual(new Set([
      "read-navigate",
      "simulate-atlas",
      "maths",
      "build-edit",
      "review",
      "files",
    ]));
    expect(LEARN_LESSONS.every(lesson => lesson.steps.length > 0)).toBe(true);

    const learnButton = document.getElementById("learn-button") as HTMLButtonElement;
    expect(learnButton).toBeTruthy();
    learnButton.click();

    expect(tutorialLayer().textContent).toContain("Choose a thread to follow");
    expect(tutorialLayer().textContent).toContain("Read and navigate");
    expect(tutorialLayer().textContent).toContain("Choose the maths");
    expect(tutorialLayer().querySelectorAll("[data-lesson-card]")).toHaveLength(LEARN_LESSONS.length);
  });

  it("executes every lesson step with a real target on the entered surface", () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    for (const lesson of LEARN_LESSONS) {
      expect(startLearnLesson(lesson.id), lesson.id).toBe(true);
      for (let stepIndex = 0; stepIndex < lesson.steps.length; stepIndex++) {
        goToTutorialStep(stepIndex);
        const step = lesson.steps[stepIndex];
        expect(
          document.querySelector(step.targetSelector),
          lesson.id + " step " + (stepIndex + 1) + " target " + step.targetSelector,
        ).not.toBeNull();
        expect(
          document.querySelector(".tutorial-target"),
          lesson.id + " step " + (stepIndex + 1) + " highlighted target " + step.targetSelector,
        ).toBe(document.querySelector(step.targetSelector));
        if (step.task) {
          expect(
            document.querySelector(step.task.selector),
            lesson.id + " step " + (stepIndex + 1) + " task target " + step.task.selector,
          ).not.toBeNull();
        }
        if (step.targetSelector === ".calc-breakdown") {
          expect(state.simulationMode, lesson.id + " formula step must enter Simulation").toBe(true);
        }
      }
      exitTutorial({ markDismissed: false });
    }
  }, 10_000);

  it("gates hands-on steps until the observed interaction and keeps Skip available", () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    expect(startLearnLesson("navigate-and-frame")).toBe(true);
    goToTutorialStep(2);
    const nextButton = tutorialLayer().querySelector<HTMLButtonElement>('[data-tutorial-action="next"]')!;
    expect(nextButton.disabled).toBe(true);
    expect(tutorialLayer().textContent).toContain("Try this");
    nextButton.click();
    expect(tutorialLayer().textContent).not.toContain("Lesson complete");

    document.getElementById("viz-depth-up")!.click();
    expect(nextButton.disabled).toBe(false);
    expect(tutorialLayer().textContent).toContain("Done");
    nextButton.click();
    expect(tutorialLayer().textContent).toContain("Lesson complete");
    expect(loadLearnProgress().completedLessonIds).toContain("navigate-and-frame");
  });

  it("never offers or persists the deliberately broken automatic Review map", () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    const savedMap = loadCsvFromStorage();
    expect(startLearnLesson("automatic-review")).toBe(true);
    goToTutorialStep(1);
    tutorialLayer().querySelector<HTMLElement>('[data-tutorial-action="next"]')!.click();

    expect(tutorialLayer().textContent).toContain("Lesson complete");
    expect(tutorialLayer().textContent).not.toContain("Keep example");
    completeTutorialAndKeepExample();
    expect(tutorialIsActive()).toBe(true);
    expect(loadCsvFromStorage()).toBe(savedMap);
  });

  it("starts a named lesson on the temporary map and offers Reset and Skip", () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    const originalNodeIdentifiers = NODES.map(node => node.id);

    expect(startLearnLesson("formula-or-multiplier")).toBe(true);
    expect(tutorialIsActive()).toBe(true);
    expect(nodeById.completed_follow_ups).toBeDefined();
    expect(tutorialLayer().textContent).toContain("Choose the calculation path");
    expect(tutorialLayer().textContent).toContain("Reset lesson");
    expect(tutorialLayer().textContent).toContain("Skip lesson");

    tutorialLayer().querySelector<HTMLElement>('[data-tutorial-action="skip-lesson"]')!.click();
    expect(tutorialIsActive()).toBe(false);
    expect(NODES.map(node => node.id)).toEqual(originalNodeIdentifiers);
    expect(tutorialLayer().textContent).toContain("Choose a thread to follow");
  });

  it("connects the tutorial card to its borderless target with the learning thread", () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    expect(startLearnLesson("map-essentials")).toBe(true);

    expect(tutorialLayer().querySelectorAll("[data-tutorial-highlight-style]")).toHaveLength(0);
    expect(tutorialLayer().querySelector(".tutorial-target-thread")).not.toBeNull();
    expect(tutorialLayer().querySelector(".tutorial-target-thread-path")).not.toBeNull();
    expect(document.querySelector(".tutorial-target")).not.toBeNull();

    exitTutorial({ markDismissed: false });
  });

  it("rebinds after mutation and only follows later geometry when an event marks it dirty", async () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    expect(startLearnLesson("map-essentials")).toBe(true);

    const originalTarget = document.querySelector<SVGGElement>(
      '[data-node-id="workshop_readiness"]',
    )!;
    render();
    const replacementTarget = document.querySelector<SVGGElement>(
      '[data-node-id="workshop_readiness"]',
    )!;
    expect(replacementTarget).not.toBe(originalTarget);

    let targetLeft = 120;
    replacementTarget.getBoundingClientRect = () => ({
      left: targetLeft,
      right: targetLeft + 80,
      top: 90,
      bottom: 130,
      width: 80,
      height: 40,
      x: targetLeft,
      y: 90,
      toJSON: () => ({}),
    });
    tutorialLayer().querySelector<HTMLElement>(".tutorial-card")!.getBoundingClientRect = () => ({
      left: 240,
      right: 640,
      top: 500,
      bottom: 680,
      width: 400,
      height: 180,
      x: 240,
      y: 500,
      toJSON: () => ({}),
    });

    const waitForTrackingFrame = async (): Promise<void> => {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    };
    await waitForTrackingFrame();

    expect(replacementTarget.classList.contains("tutorial-target")).toBe(true);
    expect(originalTarget.classList.contains("tutorial-target")).toBe(false);
    const marker = tutorialLayer().querySelector<SVGCircleElement>(".tutorial-target-thread-marker")!;
    expect(marker.getAttribute("cx")).toBe("160");

    targetLeft = 300;
    await waitForTrackingFrame();
    expect(marker.getAttribute("cx")).toBe("160");

    document.dispatchEvent(new Event("scroll"));
    await waitForTrackingFrame();
    expect(marker.getAttribute("cx")).toBe("340");
  });

  it("fades over the target and returns when the pointer moves away", () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    expect(startLearnLesson("map-essentials")).toBe(true);

    document.querySelector(".tutorial-target")!.dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true }),
    );

    expect(
      tutorialLayer().querySelector(".tutorial-target-thread")?.classList
        .contains("is-faded-over-target"),
    ).toBe(true);

    document.body.dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
    expect(
      tutorialLayer().querySelector(".tutorial-target-thread")?.classList
        .contains("is-faded-over-target"),
    ).toBe(false);
  });

  it("lets the user drag the lesson card and keeps its position between steps", () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    expect(startLearnLesson("map-essentials")).toBe(true);

    const tutorialCard = tutorialLayer().querySelector<HTMLElement>(".tutorial-card")!;
    tutorialCard.getBoundingClientRect = () => ({
      left: 300,
      right: 700,
      top: 500,
      bottom: 680,
      width: 400,
      height: 180,
      x: 300,
      y: 500,
      toJSON: () => ({}),
    });
    tutorialLayer().querySelector<HTMLElement>("[data-tutorial-card-drag-handle]")!.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, clientX: 350, clientY: 520 }),
    );
    document.dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, clientX: 450, clientY: 320 }),
    );
    document.dispatchEvent(
      new MouseEvent("pointerup", { bubbles: true, clientX: 450, clientY: 320 }),
    );

    expect(tutorialCard.style.left).toBe("400px");
    expect(tutorialCard.style.top).toBe("300px");
    expect(tutorialCard.style.transform).toBe("none");
    expect(tutorialCard.classList.contains("is-dragging")).toBe(false);

    goToTutorialStep(1);
    const nextTutorialCard = tutorialLayer().querySelector<HTMLElement>(".tutorial-card")!;
    expect(nextTutorialCard.style.left).toBe("400px");
    expect(nextTutorialCard.style.top).toBe("300px");
  });

  it("remembers an unfinished position and resumes it from the library", () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    expect(startLearnLesson("navigate-and-frame")).toBe(true);
    goToTutorialStep(2);
    expect(loadLearnProgress()).toMatchObject({
      lastLessonId: "navigate-and-frame",
      lastStepIndex: 2,
    });

    tutorialLayer().querySelector<HTMLElement>('[data-tutorial-action="skip-lesson"]')!.click();
    const resumeButton = tutorialLayer().querySelector<HTMLElement>(
      '[data-lesson-id="navigate-and-frame"][data-tutorial-action="lesson"]',
    )!;
    expect(resumeButton.textContent).toBe("Resume");
    resumeButton.click();

    expect(tutorialLayer().textContent).toContain("Step 3 of 3");
  });

  it("marks a finished lesson and shows it as completed in the library", () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    expect(startLearnLesson("review-log")).toBe(true);
    tutorialLayer().querySelector<HTMLElement>('[data-tutorial-action="next"]')!.click();
    expect(loadLearnProgress().completedLessonIds).toContain("review-log");

    tutorialLayer().querySelector<HTMLElement>('[data-tutorial-action="learn"]')!.click();
    const lessonCard = tutorialLayer().querySelector<HTMLElement>('[data-lesson-card="review-log"]')!;
    expect(lessonCard.classList.contains("is-complete")).toBe(true);
    expect(lessonCard.textContent).toContain("Completed");
    expect(localStorage.getItem(LEARN_PROGRESS_KEY)).toBeTruthy();
  });

  it("keeps an automatic Review defect inside the reversible lesson session", () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    const originalFormula = nodeById.team_size.formula;

    expect(startLearnLesson("automatic-review")).toBe(true);
    expect(nodeById.registration_share.formula).toBe("missing_tutorial_input + 1");
    expect(document.getElementById("review-stage")!.hidden).toBe(false);

    tutorialLayer().querySelector<HTMLElement>('[data-tutorial-action="skip-lesson"]')!.click();
    expect(nodeById.team_size.formula).toBe(originalFormula);
    expect(nodeById.registration_share).toBeUndefined();
  });

  it("opens the library directly without borrowing or replacing the current map", () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    const savedMap = loadCsvFromStorage();

    expect(openLearnHub()).toBe(true);

    expect(tutorialIsActive()).toBe(false);
    expect(nodeById.team_size).toBeDefined();
    expect(loadCsvFromStorage()).toBe(savedMap);
    expect(storageWritesAreSuspended()).toBe(false);
  });
});

describe("temporary map lifecycle", () => {
  it("supports a non-persisting load without changing the saved CSV", () => {
    localStorage.setItem(STORAGE_KEY_CSV, SAMPLE_CSV);
    expect(loadDataFromCsv(TUTORIAL_MAP_CSV, { persist: false })).toBe(true);
    expect(loadCsvFromStorage()).toBe(SAMPLE_CSV);
    expect(nodeById.outreach_effort).toBeDefined();
  });

  it("suspends writes and restores the exact prior live map on exit", () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    const savedMapBeforeTour = loadCsvFromStorage();
    const nodeIdentifiersBeforeTour = NODES.map(node => node.id);

    expect(startTutorial()).toBe(true);
    expect(storageWritesAreSuspended()).toBe(true);
    expect(nodeById.outreach_effort).toBeDefined();
    expect(loadCsvFromStorage()).toBe(savedMapBeforeTour);

    exitTutorial({ markDismissed: false });
    expect(storageWritesAreSuspended()).toBe(false);
    expect(NODES.map(node => node.id)).toEqual(nodeIdentifiersBeforeTour);
    expect(loadCsvFromStorage()).toBe(savedMapBeforeTour);
  });

  it("flushes a queued evidence edit before suspending tutorial writes", () => {
    vi.useFakeTimers();
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    const editedNode = nodeById.team_size;
    editedNode.formulaEvidence = {
      status: "supported",
      source: "Queued evidence source",
    };
    applyCanvasMutation({ impact: "presentation" });
    expect(loadCsvFromStorage()).not.toContain("Queued evidence source");

    expect(startTutorial()).toBe(true);
    expect(loadCsvFromStorage()).toContain("Queued evidence source");
    exitTutorial({ markDismissed: false });

    expect(loadCsvFromStorage()).toContain("Queued evidence source");
    expect(nodeById.team_size.formulaEvidence?.source).toBe("Queued evidence source");
  });

  it("restores both undo and redo stacks after the temporary map loads", () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    nodeById.team_size.description = "First history edit";
    applyCanvasMutation({ impact: "presentation" });
    nodeById.team_size.label = "Second history edit";
    applyCanvasMutation({ impact: "presentation", searchableDataChanged: true });
    expect(historyUndo()).toBe(true);
    const pastBeforeTour = state.history.past.slice();
    const futureBeforeTour = state.history.future.slice();
    expect(pastBeforeTour.length).toBeGreaterThan(0);
    expect(futureBeforeTour.length).toBeGreaterThan(0);

    expect(startTutorial()).toBe(true);
    exitTutorial({ markDismissed: false });

    expect(state.history.past).toEqual(pastBeforeTour);
    expect(state.history.future).toEqual(futureBeforeTour);
    expect(historyRedo()).toBe(true);
    expect(nodeById.team_size.label).toBe("Second history edit");
  });

  it("restores an open Bulk edit draft after the tutorial borrows the overlay", () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    openBuilder({ fromLoadedData: true });
    state.builder.step = 4;
    state.builder.nodes[0].label = "Unsaved Bulk edit label";
    state.builder.selected = new Set([0]);
    state.builder.sort = { nodes: { key: "label", dir: "desc" } };
    saveBuilderToStorage();

    expect(startTutorial()).toBe(true);
    goToTutorialStep(TUTORIAL_STEPS.length - 1);
    expect(state.builder.nodes.some(node => node.label === "Unsaved Bulk edit label")).toBe(false);

    exitTutorial({ markDismissed: false });

    expect(state.builder.open).toBe(true);
    expect(state.builder.step).toBe(4);
    expect(state.builder.nodes[0].label).toBe("Unsaved Bulk edit label");
    expect(Array.from(state.builder.selected)).toEqual([0]);
    expect(state.builder.sort.nodes).toEqual({ key: "label", dir: "desc" });
    expect(localStorage.getItem(STORAGE_KEY_BUILDER)).toContain("Unsaved Bulk edit label");
  });

  it("restores an active review pass, its body class, and the open Review surface", () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    state.reviewer = "Test Reviewer";
    startReviewPass();
    openReview();
    expect(reviewIsOpen()).toBe(true);
    expect(document.body.classList.contains("review-pass")).toBe(true);

    expect(startLearnLesson("simulate-change")).toBe(true);
    exitTutorial({ markDismissed: false });

    expect(state.reviewPass).toBe(true);
    expect(document.body.classList.contains("review-pass")).toBe(true);
    expect(reviewIsOpen()).toBe(true);
    closeReview();
    endReviewPass();
  });

  it("restores multi-selection, canvas edit state, and canvas scroll position", () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    const selectedIdentifiers = NODES.slice(0, 3).map(node => node.id);
    setSelection(selectedIdentifiers, selectedIdentifiers[1]);
    state.canvasEdit.editMode = true;
    state.canvasEdit.openEdgeId = null;
    const canvasScroll = document.getElementById("viz-scroll")!;
    canvasScroll.scrollLeft = 137;
    canvasScroll.scrollTop = 89;

    expect(startLearnLesson("formula-ratios-bounds")).toBe(true);
    exitTutorial({ markDismissed: false });

    expect(Array.from(state.selectedNodeIds)).toEqual(selectedIdentifiers);
    expect(state.selectedNodeId).toBe(selectedIdentifiers[1]);
    expect(state.canvasEdit.editMode).toBe(true);
    expect(canvasScroll.scrollLeft).toBe(137);
    expect(canvasScroll.scrollTop).toBe(89);
  });

  it("restores the selected edge and its open outgoing-link editor", () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    const edgeIdentifier = EDGES[0].id!;
    selectEdge(edgeIdentifier);
    expect(state.selectedEdgeId).toBe(edgeIdentifier);

    expect(startLearnLesson("search-and-filter")).toBe(true);
    exitTutorial({ markDismissed: false });

    expect(state.selectedEdgeId).toBe(edgeIdentifier);
    expect(state.canvasEdit.openEdgeId).toBe(edgeIdentifier);
    expect(state.canvasEdit.editMode).toBe(true);
  });

  it("restores the exact Atlas reading, wheel selection and frame", () => {
    expect(loadDataFromCsv(TUTORIAL_MAP_CSV)).toBe(true);
    openAtlas("community_confidence");
    expect(openFirstFeedbackTangle()).toBe(true);
    const atlasBeforeLesson = captureAtlasSessionState();
    expect(atlasBeforeLesson?.reading.inside).toBeTruthy();

    expect(startLearnLesson("edit-map")).toBe(true);
    exitTutorial({ markDismissed: false });

    expect(captureAtlasSessionState()).toEqual(atlasBeforeLesson);
    closeAtlas();
  });

  it("returns a first-open tour to the empty starter grid", () => {
    bootEmptyStateGrid();
    expect(startTutorial()).toBe(true);
    expect(nodeById.outreach_effort).toBeDefined();

    exitTutorial({ markDismissed: false });

    expect(NODES).toHaveLength(0);
    expect(state.dataLoaded).toBe(true);
    expect(nodeById.outreach_effort).toBeUndefined();
  });

  it("preserves customized dimensions and constants in an empty map", () => {
    bootEmptyStateGrid();
    setStreams([{ id: "custom_row", label: "Custom row", short: "CR", color: "#123456" }]);
    setStages([{ id: "custom_column", label: "Custom column" }]);
    setCategories({
      custom_category: {
        label: "Custom category",
        color: "#abcdef",
        textColor: "#123456",
        class: "secondary",
      },
    });
    setParams([{ id: "custom_constant", value: 7, description: "Custom constant" }]);
    setDefaultElasticityByEffect({ enables: 0.4, increases: 0.35, decreases: -0.2 });

    expect(startTutorial()).toBe(true);
    exitTutorial({ markDismissed: false });

    expect(STREAMS).toEqual([{ id: "custom_row", label: "Custom row", short: "CR", color: "#123456" }]);
    expect(STAGES).toEqual([{ id: "custom_column", label: "Custom column" }]);
    expect(CATEGORIES.custom_category).toMatchObject({
      label: "Custom category",
      class: "secondary",
    });
    expect(PARAMS).toEqual([{ id: "custom_constant", value: 7, description: "Custom constant" }]);
    expect(DEFAULT_ELASTICITY_BY_EFFECT).toEqual({ enables: 0.4, increases: 0.35, decreases: -0.2 });
  });

  it("keeps the example only after the explicit finish choice", () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    expect(startTutorial()).toBe(true);

    completeTutorialAndKeepExample();

    expect(tutorialIsActive()).toBe(false);
    expect(storageWritesAreSuspended()).toBe(false);
    expect(localStorage.getItem(TUTORIAL_COMPLETION_KEY)).toBe("completed");
    const savedTutorialSections = parseCsvDocument(loadCsvFromStorage()!);
    expect(savedTutorialSections.nodes.some(row => row.id === "outreach_effort")).toBe(true);
    expect(savedTutorialSections.nodes.some(row => row.id === "team_size")).toBe(false);
  });

  it("drops a replaced map's recovery draft when Keep example is explicit", () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    openBuilder({ fromLoadedData: true });
    state.builder.nodes[0].label = "Draft belonging to replaced map";
    saveBuilderToStorage();
    expect(localStorage.getItem(STORAGE_KEY_BUILDER)).toContain("Draft belonging to replaced map");

    expect(startTutorial()).toBe(true);
    completeTutorialAndKeepExample();

    expect(localStorage.getItem(STORAGE_KEY_BUILDER)).toBeNull();
    expect(nodeById.outreach_effort).toBeDefined();
  });

  it("marks a completed tour while returning to the prior map", () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    expect(startTutorial()).toBe(true);

    completeTutorialAndRestore();

    expect(localStorage.getItem(TUTORIAL_COMPLETION_KEY)).toBe("completed");
    expect(nodeById.team_size).toBeDefined();
    expect(nodeById.outreach_effort).toBeUndefined();
  });
});

describe("guided route actions", () => {
  it("opens each major feature on the surface it explains", () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    expect(startTutorial()).toBe(true);

    document.getElementById("tooltip")!.classList.add("visible");
    goToTutorialStep(1);
    expect(state.simulationMode).toBe(true);
    expect(state.selectedNodeId).toBe("volunteer_hours");
    expect(document.querySelector('.sim-slider-row[data-node-id="volunteer_hours"]')).toBeTruthy();
    expect(document.getElementById("tooltip")!.classList.contains("visible")).toBe(false);

    goToTutorialStep(2);
    expect(state.selectedNodeId).toBe("outreach_reach");
    expect(document.querySelector(".calc-breakdown")).toBeTruthy();

    goToTutorialStep(3);
    expect(state.simulationMode).toBe(false);
    expect(state.atlas?.startId).toBe("community_confidence");
    expect(document.getElementById("atlas-stage")!.hidden).toBe(false);
    expect(document.querySelector(".feedback-navigator")).toBeTruthy();
    expect(document.getElementById("atlas-loopctl")!.hidden).toBe(false);

    goToTutorialStep(4);
    expect(state.filtersOpen).toBe(true);
    expect((document.getElementById("search-input") as HTMLInputElement).value).toBe("confidence");
    expect(state.searchQuery).toBe("confidence");

    goToTutorialStep(5);
    expect(document.getElementById("review-stage")!.hidden).toBe(false);
    expect(document.querySelector(".review-evidence-head")).toBeTruthy();

    goToTutorialStep(6);
    expect(state.uiMode).toBe("edit");
    expect(state.builder.open).toBe(true);
    expect(state.builder.step).toBe(4);
    expect(document.getElementById("builder-overlay")!.classList.contains("open")).toBe(true);
  });

  it("finishes with an explicit keep-or-return decision", () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    expect(startTutorial()).toBe(true);
    goToTutorialStep(TUTORIAL_STEPS.length - 1);

    tutorialLayer().querySelector<HTMLElement>('[data-tutorial-action="next"]')!.click();

    expect(tutorialLayer().textContent).toContain("Keep example");
    expect(tutorialLayer().textContent).toContain("Return to my map");
  });
});
