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
import { focusNode, selectEdge, setSelection } from "../assets/js/09-graph-selection";
import { render } from "../assets/js/11-rendering";
import { openBuilder } from "../assets/js/16a-builder-state";
import {
  bootEmptyStateGrid,
  commitNewEdge,
  createNodeInCell,
  deleteSelection,
} from "../assets/js/16e-canvas-edit";
import { inlineRenameAppend, startInlineRename } from "../assets/js/16h-canvas-inline-rename";
import { applyCanvasMutation } from "../assets/js/16f-canvas-mutations";
import { historyRedo, historyUndo } from "../assets/js/16g-canvas-undo";
import {
  atlasIsOpen,
  captureAtlasSessionState,
  closeAtlas,
  initAtlasStage,
  openAtlas,
  openFirstFeedbackTangle,
  setAtlasRenderFrameSchedulerForTests,
} from "../assets/js/21-atlas-view";
import { closeReview, openReview, reviewIsOpen } from "../assets/js/23-review-panel";
import { endReviewPass, startReviewPass } from "../assets/js/24-review-record";
import {
  LEARN_GROUPS,
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

// Eight lessons across four goal groups. Step indices are written out rather
// than searched for, so a lesson that silently gains or loses a step fails
// loudly here instead of quietly re-pointing a test at different teaching.
const FIRST_LOOK_STEP_COUNT = 5;
const READ_A_MAP_STEP_COUNT = 11;

function tutorialLayer(): HTMLElement {
  return document.getElementById("tutorial-layer")!;
}

function tutorialNextButton(): HTMLButtonElement {
  return tutorialLayer().querySelector<HTMLButtonElement>('[data-tutorial-action="next"]')!;
}

function tutorialSkipButton(): HTMLButtonElement {
  return tutorialLayer().querySelector<HTMLButtonElement>('[data-tutorial-action="skip-step"]')!;
}

async function finishTutorialCheckpointEvaluation(settleDelayMilliseconds = 0): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, settleDelayMilliseconds));
}

// The runner only ever highlights a candidate the reader can actually see, so
// a target parked inside a closed menu resolves to nothing at all.
function firstVisibleMatch(selector: string): Element | null {
  return Array.from(document.querySelectorAll(selector)).find(candidate => {
    if (candidate.closest("[hidden]")) return false;
    const style = getComputedStyle(candidate);
    return style.display !== "none" && style.visibility !== "hidden";
  }) || null;
}

function learnLesson(lessonIdentifier: string) {
  return LEARN_LESSONS.find(lesson => lesson.id === lessonIdentifier)!;
}

afterEach(() => {
  exitTutorial({ markDismissed: false });
});

describe("first-open tutorial welcome", () => {
  it("appears only without a saved map or a completion decision", () => {
    expect(showFirstOpenTutorialWelcome(false)).toBe(true);
    expect(tutorialLayer().hidden).toBe(false);
    expect(tutorialLayer().textContent).toContain("First look · 3 min");

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
    expect(TUTORIAL_STEPS).toHaveLength(FIRST_LOOK_STEP_COUNT);
    expect(tutorialLayer().textContent).toContain("Step 1 of " + TUTORIAL_STEPS.length);
  });

  it("offers the whole library as the second route out of the welcome", () => {
    bootEmptyStateGrid();
    expect(showFirstOpenTutorialWelcome(false)).toBe(true);
    expect(storageWritesAreSuspended()).toBe(true);

    tutorialLayer().querySelector<HTMLElement>('[data-tutorial-action="learn"]')!.click();

    expect(tutorialIsActive()).toBe(false);
    expect(storageWritesAreSuspended()).toBe(false);
    expect(tutorialLayer().textContent).toContain("Learn Ariadne Maps.");
    expect(tutorialLayer().querySelector('[data-lesson-card="first-look"]')).not.toBeNull();
  });

  it("can be entered again from the first lesson in Learn", () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    (document.getElementById("learn-button") as HTMLButtonElement).click();
    const lessonAction = tutorialLayer().querySelector<HTMLElement>(
      '[data-lesson-id="first-look"][data-tutorial-action="lesson"]',
    )!;

    lessonAction.click();

    expect(tutorialIsActive()).toBe(true);
    expect(nodeById.workshop_readiness).toBeDefined();
  });
});

describe("Learn library", () => {
  it("exposes a stable eight-lesson curriculum grouped by goal", () => {
    const lessonIdentifiers = LEARN_LESSONS.map(lesson => lesson.id);
    expect(lessonIdentifiers).toHaveLength(8);
    expect(new Set(lessonIdentifiers).size).toBe(lessonIdentifiers.length);
    expect(lessonIdentifiers[0]).toBe("first-look");
    expect(LEARN_GROUPS.map(group => group.id)).toEqual(["start", "read", "build", "trust"]);
    expect(LEARN_LESSONS.every(lesson => lesson.steps.length > 0)).toBe(true);

    const groupIdentifiers = new Set(LEARN_GROUPS.map(group => group.id));
    for (const lesson of LEARN_LESSONS) {
      expect(groupIdentifiers.has(lesson.groupId), lesson.id + " group").toBe(true);
    }
    // "start" holds only the on-ramp; every other goal must lead somewhere.
    for (const group of LEARN_GROUPS) {
      const lessonsInGroup = LEARN_LESSONS.filter(lesson => lesson.groupId === group.id);
      expect(lessonsInGroup.length, group.id + " lesson count").toBeGreaterThan(0);
      if (group.id !== "start") {
        expect(group.title.trim().length, group.id + " heading").toBeGreaterThan(0);
      }
    }
    expect(LEARN_LESSONS.filter(lesson => lesson.groupId === "start")).toHaveLength(1);
  });

  it("renders the hero card, the goal headings and the reference shelf from a top-level action", () => {
    const learnButton = document.getElementById("learn-button") as HTMLButtonElement;
    expect(learnButton).toBeTruthy();
    learnButton.click();

    expect(tutorialLayer().textContent).toContain("Learn Ariadne Maps.");
    expect(tutorialLayer().textContent).toContain("0 of 8 lessons complete");

    const heroCard = tutorialLayer().querySelector<HTMLElement>(".learn-hero-card")!;
    expect(heroCard.getAttribute("data-lesson-card")).toBe("first-look");
    expect(heroCard.textContent).toContain("New here?");
    expect(heroCard.querySelector('[data-tutorial-action="lesson"]')?.textContent).toBe("Start here");

    const goalGroups = LEARN_GROUPS.filter(group => group.id !== "start");
    const groupHeadings = Array.from(tutorialLayer().querySelectorAll(".learn-group-heading"))
      .map(heading => heading.textContent);
    for (const group of goalGroups) {
      expect(groupHeadings, group.id + " heading rendered").toContain(group.title);
    }
    // One section per goal group, plus the reference shelf.
    expect(tutorialLayer().querySelectorAll("section.learn-group")).toHaveLength(goalGroups.length + 1);

    // The hero card sits outside the groups, so only the other seven lessons
    // are drawn as numbered lesson cards.
    expect(tutorialLayer().querySelectorAll(".learn-group-lessons .learn-lesson-card")).toHaveLength(7);
    expect(tutorialLayer().querySelectorAll("[data-lesson-card]")).toHaveLength(LEARN_LESSONS.length);
    expect(tutorialLayer().querySelector(".learn-reference-card")).not.toBeNull();
    expect(tutorialLayer().querySelector('[data-tutorial-action="open-reference"]')).not.toBeNull();
    expect(tutorialLayer().querySelector(".learn-journey-list")).toBeNull();
    expect(tutorialLayer().querySelector(".learn-curriculum-rail")).toBeNull();
  });

  it("states each lesson's real step count in its duration line", () => {
    for (const lesson of LEARN_LESSONS) {
      expect(lesson.duration, lesson.id + " duration").toContain(lesson.steps.length + " steps");
      expect(lesson.duration, lesson.id + " duration").toContain("minutes");
      expect(["small", "full"], lesson.id + " map size").toContain(lesson.mapSize);
    }
    expect(LEARN_LESSONS.map(lesson => lesson.steps.length))
      .toEqual([5, 11, 6, 11, 13, 8, 9, 7]);
    expect(LEARN_LESSONS.map(lesson => lesson.mapSize))
      .toEqual(["small", "full", "full", "full", "full", "full", "full", "full"]);
    expect(LEARN_LESSONS.reduce((total, lesson) => total + lesson.steps.length, 0)).toBe(70);
  });

  it("ends every lesson with a recap and a prompt to transfer the skill", () => {
    for (const lesson of LEARN_LESSONS) {
      expect(lesson.recap.length, lesson.id + " recap").toBeGreaterThan(0);
      expect(lesson.recap.every(item => item.trim().length > 0), lesson.id + " recap text").toBe(true);
      expect(lesson.tryOnYourOwnMap.trim().length, lesson.id + " transfer prompt").toBeGreaterThan(0);
    }
  });

  it("keeps checkpoint identifiers unique inside a lesson", () => {
    for (const lesson of LEARN_LESSONS) {
      const checkpointIdentifiers = lesson.steps.flatMap(step =>
        step.task ? step.task.checkpoints.map(checkpoint => checkpoint.identifier) : []);
      expect(new Set(checkpointIdentifiers).size, lesson.id + " checkpoint identifiers")
        .toBe(checkpointIdentifiers.length);
      expect(checkpointIdentifiers.every(identifier => identifier.trim().length > 0)).toBe(true);
    }
  });

  it("gives every step of the on-ramp lesson something to do", () => {
    const firstLesson = learnLesson("first-look");
    expect(firstLesson.groupId).toBe("start");
    expect(firstLesson.mapSize).toBe("small");
    for (const [stepIndex, step] of firstLesson.steps.entries()) {
      expect(step.task, "first-look step " + (stepIndex + 1) + " task").toBeDefined();
      expect(step.task!.checkpoints.length).toBeGreaterThan(0);
    }
  });

  it("teaches every calculation rule by doing rather than by reading", () => {
    const calculationLesson = learnLesson("make-it-calculate");
    expect(calculationLesson.steps).toHaveLength(8);
    for (const [stepIndex, step] of calculationLesson.steps.entries()) {
      expect(step.task, "make-it-calculate step " + (stepIndex + 1) + " task").toBeDefined();
    }
    const checkpointIdentifiers = calculationLesson.steps.flatMap(step =>
      step.task!.checkpoints.map(checkpoint => checkpoint.identifier));
    expect(checkpointIdentifiers).toEqual(expect.arrayContaining([
      "calc-combine-additive",
      "calc-combine-min",
      "calc-combine-standard",
      "calc-edit-formula",
      "calc-set-bound",
    ]));
  });

  it("offers one restart action for a completed lesson and can reset all Learn progress", () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    const originalNodeIdentifiers = NODES.map(node => node.id);
    localStorage.setItem(LEARN_PROGRESS_KEY, JSON.stringify({
      curriculumVersion: 6,
      completedLessonIds: ["read-a-map"],
      lastLessonId: "read-a-map",
      lastStepIndex: 0,
      completedCheckpointIdentifiersByLesson: {},
    }));

    expect(openLearnHub()).toBe(true);
    const completedLessonCard = tutorialLayer().querySelector<HTMLElement>(
      '[data-lesson-card="read-a-map"]',
    )!;
    const completedLessonActions = completedLessonCard.querySelector<HTMLElement>(".learn-lesson-actions")!;
    expect(completedLessonActions.querySelectorAll("button")).toHaveLength(1);
    expect(completedLessonActions.querySelector('[data-tutorial-action="lesson"]')).toBeNull();
    expect(completedLessonActions.querySelector('[data-tutorial-action="restart-lesson"]')?.textContent).toBe("Restart lesson");

    const confirmation = vi.spyOn(window, "confirm").mockReturnValue(true);
    tutorialLayer().querySelector<HTMLButtonElement>('[data-tutorial-action="reset-all-progress"]')!.click();

    expect(confirmation).toHaveBeenCalledWith("Reset all lesson progress? Your map will not be changed.");
    expect(localStorage.getItem(LEARN_PROGRESS_KEY)).toBeNull();
    expect(tutorialLayer().textContent).toContain("0 of 8 lessons complete");
    expect(tutorialLayer().querySelector<HTMLButtonElement>('[data-tutorial-action="reset-all-progress"]')!.disabled).toBe(true);
    expect(tutorialLayer().querySelector('[data-tutorial-action="restart-lesson"]')).toBeNull();
    expect(NODES.map(node => node.id)).toEqual(originalNodeIdentifiers);
    confirmation.mockRestore();
  });

  it("restarts a completed lesson from its first step", () => {
    localStorage.setItem(LEARN_PROGRESS_KEY, JSON.stringify({
      curriculumVersion: 6,
      completedLessonIds: ["read-a-map"],
      lastLessonId: "read-a-map",
      lastStepIndex: 4,
      completedCheckpointIdentifiersByLesson: {
        "read-a-map": { "4": ["fit-map"] },
      },
    }));

    expect(openLearnHub()).toBe(true);
    tutorialLayer().querySelector<HTMLButtonElement>(
      '[data-lesson-card="read-a-map"] [data-tutorial-action="restart-lesson"]',
    )!.click();

    expect(tutorialIsActive()).toBe(true);
    expect(tutorialLayer().textContent).toContain("Read a map · Step 1 of " + READ_A_MAP_STEP_COUNT);
    expect(loadLearnProgress().lastStepIndex).toBe(0);
    expect(loadLearnProgress().completedCheckpointIdentifiersByLesson["read-a-map"]).toBeUndefined();
  });

  it("starts fresh when progress was saved under a superseded curriculum", () => {
    // Lessons were split, merged and renamed, so a step index saved against an
    // older curriculum no longer points at the same teaching.
    localStorage.setItem(LEARN_PROGRESS_KEY, JSON.stringify({
      curriculumVersion: 5,
      completedLessonIds: ["move-around-map", "simulate-change", "edit-map", "review-evidence"],
      lastLessonId: "edit-map",
      lastStepIndex: 12,
      completedCheckpointIdentifiersByLesson: {
        "edit-map": { "3": ["edit-box-field"] },
      },
    }));

    expect(loadLearnProgress()).toEqual({
      curriculumVersion: 6,
      completedLessonIds: [],
      lastLessonId: null,
      lastStepIndex: 0,
      completedCheckpointIdentifiersByLesson: {},
    });

    expect(openLearnHub()).toBe(true);
    expect(tutorialLayer().textContent).toContain("0 of 8 lessons complete");
    expect(tutorialLayer().querySelector('[data-tutorial-action="restart-lesson"]')).toBeNull();
  });

  it("keeps progress saved under the current curriculum and drops unknown entries", () => {
    localStorage.setItem(LEARN_PROGRESS_KEY, JSON.stringify({
      curriculumVersion: 6,
      completedLessonIds: ["first-look", "move-around-map"],
      lastLessonId: "read-a-map",
      lastStepIndex: 4,
      completedCheckpointIdentifiersByLesson: {
        "read-a-map": { "4": ["fit-map", "not-a-checkpoint"] },
        "move-around-map": { "0": ["change-zoom"] },
      },
    }));

    const progress = loadLearnProgress();
    expect(progress.completedLessonIds).toEqual(["first-look"]);
    expect(progress.lastLessonId).toBe("read-a-map");
    expect(progress.lastStepIndex).toBe(4);
    expect(progress.completedCheckpointIdentifiersByLesson).toEqual({
      "read-a-map": { "4": ["fit-map"] },
    });
  });

  it("defines valid acyclic prerequisites and a complete recommended path", () => {
    const lessonIdentifiers = new Set(LEARN_LESSONS.map(lesson => lesson.id));
    for (const lesson of LEARN_LESSONS) {
      expect(
        lesson.prerequisiteLessonIds.every(identifier => lessonIdentifiers.has(identifier)),
        lesson.id + " prerequisites",
      ).toBe(true);
      if (lesson.recommendedNextLessonId) {
        expect(lessonIdentifiers.has(lesson.recommendedNextLessonId), lesson.id + " next").toBe(true);
      }
    }

    // No lesson may reach itself by following prerequisites.
    for (const lesson of LEARN_LESSONS) {
      const visitedIdentifiers = new Set<string>();
      const pendingIdentifiers = [...lesson.prerequisiteLessonIds];
      while (pendingIdentifiers.length) {
        const identifier = pendingIdentifiers.pop()!;
        expect(identifier, lesson.id + " prerequisite cycle").not.toBe(lesson.id);
        if (visitedIdentifiers.has(identifier)) continue;
        visitedIdentifiers.add(identifier);
        pendingIdentifiers.push(...learnLesson(identifier).prerequisiteLessonIds);
      }
    }

    const recommendedPath: string[] = [];
    let lesson = LEARN_LESSONS[0];
    while (lesson) {
      expect(recommendedPath).not.toContain(lesson.id);
      recommendedPath.push(lesson.id);
      lesson = LEARN_LESSONS.find(candidate => candidate.id === lesson.recommendedNextLessonId)!;
    }
    expect(recommendedPath).toEqual(LEARN_LESSONS.map(candidate => candidate.id));
  });

  it("recommends the on-ramp first and explains soft prerequisites without locking lessons", () => {
    expect(openLearnHub()).toBe(true);
    const heroCard = tutorialLayer().querySelector<HTMLElement>('[data-lesson-card="first-look"]')!;
    const buildLessonCard = tutorialLayer().querySelector<HTMLElement>('[data-lesson-card="build-a-map"]')!;
    const calculateLessonCard = tutorialLayer().querySelector<HTMLElement>('[data-lesson-card="make-it-calculate"]')!;

    expect(heroCard.classList.contains("learn-hero-card")).toBe(true);
    expect(buildLessonCard.textContent).toContain("Best after: Read a map");
    expect(calculateLessonCard.textContent).toContain("Best after: Build a map");
    expect(buildLessonCard.querySelector<HTMLButtonElement>('[data-tutorial-action="lesson"]')!.disabled).toBe(false);
    // Sharing has no prerequisite: somebody handed a map can start there.
    expect(tutorialLayer().querySelector<HTMLElement>('[data-lesson-card="share-and-keep"]')!.textContent)
      .not.toContain("Best after:");
  });

  it("does not ship duplicate lesson sequences", () => {
    const lessonFingerprints = LEARN_LESSONS.map(lesson => JSON.stringify(
      lesson.steps.map(step => ({ title: step.title, body: step.body })),
    ));
    expect(new Set(lessonFingerprints).size).toBe(lessonFingerprints.length);
  });

  it("completes the filter gate after the first filter is hidden", async () => {
    expect(startLearnLesson("read-a-map")).toBe(true);
    goToTutorialStep(9);
    const categoryFilter = document.querySelector<HTMLButtonElement>(
      '#sidebar [data-kind="category"][data-id]',
    )!;
    const categoryIdentifier = categoryFilter.dataset.id!;

    categoryFilter.click();
    await finishTutorialCheckpointEvaluation();

    expect(state.hiddenCategories.has(categoryIdentifier)).toBe(true);
    expect(tutorialNextButton().disabled).toBe(false);
    expect(tutorialLayer().querySelector('[data-tutorial-checkpoint="hide-filter"]')?.classList.contains("is-complete")).toBe(true);
  });

  it("executes every lesson step with a real target on the entered surface", () => {
    // Steps that point at a surface which never renders for them go here. The
    // list is empty, and the assertion below fails the moment an entry starts
    // resolving, so it can only ever shrink.
    const stepsWithUnresolvedTargets = new Set<string>();
    const unresolvedStepsSeen = new Set<string>();

    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    for (const lesson of LEARN_LESSONS) {
      expect(startLearnLesson(lesson.id), lesson.id).toBe(true);
      for (let stepIndex = 0; stepIndex < lesson.steps.length; stepIndex++) {
        if (lesson.id === "check-a-map" && stepIndex === 8) {
          state.reviewer = "Test Reviewer";
          const firstReviewTargetIdentifier = startReviewPass();
          expect(firstReviewTargetIdentifier).toBeTruthy();
          focusNode(firstReviewTargetIdentifier!);
        }
        goToTutorialStep(stepIndex);
        const step = lesson.steps[stepIndex];
        const stepName = lesson.id + " step " + (stepIndex + 1);
        const expectedTargetSelector = step.task && step.task.checkpoints.length > 1
          ? step.task.checkpoints[0].selector
          : step.targetSelector;
        expect(
          tutorialLayer().querySelector('[data-tutorial-action="skip-step"]'),
          stepName + " skip button",
        ).not.toBeNull();
        if (stepsWithUnresolvedTargets.has(stepName)) {
          unresolvedStepsSeen.add(stepName);
          expect(
            document.querySelector(step.targetSelector),
            stepName + " now resolves " + step.targetSelector + " — drop it from the known-gap list",
          ).toBeNull();
          continue;
        }
        expect(
          document.querySelector(step.targetSelector),
          stepName + " target " + step.targetSelector,
        ).not.toBeNull();
        expect(
          document.querySelector(".tutorial-target"),
          stepName + " highlighted target " + expectedTargetSelector,
        ).toBe(firstVisibleMatch(expectedTargetSelector));
        if (step.targetSelector === ".calc-breakdown") {
          expect(state.simulationMode, stepName + " must enter Simulation").toBe(true);
        }
        // A checkpoint only fires for an event whose target sits inside something
        // matching its own selector, so a selector that matches nothing makes the
        // step impossible to finish except with Skip — silently, because nothing
        // errors. `.builder-nav button, [data-builder-step]` sat in the bulk-edit
        // step that way; neither name has ever existed in the app.
        //
        // Only the FIRST checkpoint is checked. Later ones deliberately watch
        // surfaces their predecessor unlocks — follow-pathways' [data-open-feedback]
        // button is only drawn once a feedback group has been selected.
        const firstCheckpoint = step.task?.checkpoints[0];
        if (firstCheckpoint) {
          expect(
            document.querySelector(firstCheckpoint.selector),
            stepName + " checkpoint '" + firstCheckpoint.identifier + "' watches " + firstCheckpoint.selector,
          ).not.toBeNull();
        }
      }
      exitTutorial({ markDismissed: false });
    }
    expect(Array.from(unresolvedStepsSeen).sort())
      .toEqual(Array.from(stepsWithUnresolvedTargets).sort());
  }, 30_000);

  it("gates hands-on steps until the observed interaction and keeps Skip available", async () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    expect(startLearnLesson("read-a-map")).toBe(true);
    goToTutorialStep(7);
    const nextButton = tutorialLayer().querySelector<HTMLButtonElement>('[data-tutorial-action="next"]')!;
    expect(nextButton.disabled).toBe(true);
    expect(tutorialLayer().textContent).toContain("Complete all actions to unlock Next");
    nextButton.click();
    expect(tutorialLayer().textContent).not.toContain("Lesson complete");

    document.getElementById("viz-depth-up")!.click();
    await finishTutorialCheckpointEvaluation();
    expect(nextButton.disabled).toBe(true);
    const relatedEdge = EDGES.find(edge =>
      edge.from === "workshop_readiness" || edge.to === "workshop_readiness")!;
    const relatedIdentifier = relatedEdge.from === "workshop_readiness"
      ? relatedEdge.to : relatedEdge.from;
    document.querySelector<HTMLElement>('.node-group[data-node-id="' + relatedIdentifier + '"]')!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await finishTutorialCheckpointEvaluation();
    expect(nextButton.disabled).toBe(false);
    expect(tutorialLayer().textContent).toContain("All actions complete");
    nextButton.click();
    expect(tutorialLayer().textContent).toContain("Read a map · Step 9 of " + READ_A_MAP_STEP_COUNT);
    expect(loadLearnProgress().completedLessonIds).not.toContain("read-a-map");

    goToTutorialStep(READ_A_MAP_STEP_COUNT - 1);
    tutorialSkipButton().click();
    expect(tutorialLayer().textContent).toContain("Lesson complete");
    expect(loadLearnProgress().completedLessonIds).toContain("read-a-map");
  });

  it("skips one gated step without recording its actions as complete", () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    expect(startLearnLesson("first-look")).toBe(true);
    const skippedStepTitle = tutorialLayer().querySelector("h2")!.textContent;
    expect(tutorialNextButton().disabled).toBe(true);

    tutorialSkipButton().click();
    expect(tutorialLayer().querySelector("h2")!.textContent).not.toBe(skippedStepTitle);

    tutorialLayer().querySelector<HTMLButtonElement>('[data-tutorial-action="back"]')!.click();
    expect(tutorialLayer().querySelector("h2")!.textContent).toBe(skippedStepTitle);
    expect(tutorialNextButton().disabled).toBe(true);
    expect(tutorialLayer().querySelectorAll(".tutorial-task-checkpoint.is-complete")).toHaveLength(0);
  });

  it("starts the Atlas lesson on the map and waits for the user to open Atlas", async () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    initAtlasStage();
    expect(startLearnLesson("follow-pathways")).toBe(true);
    goToTutorialStep(0);

    expect(state.selectedNodeId).toBe("community_confidence");
    expect(atlasIsOpen()).toBe(false);
    expect(tutorialLayer().textContent).toContain("Open Atlas from a starting box");
    expect(tutorialNextButton().disabled).toBe(true);

    const openAtlasButton = document.querySelector<HTMLButtonElement>('[data-action="open-atlas"]');
    expect(openAtlasButton).not.toBeNull();
    openAtlasButton!.click();
    await finishTutorialCheckpointEvaluation();

    expect(atlasIsOpen()).toBe(true);
    expect(tutorialNextButton().disabled).toBe(false);
    expect(
      tutorialLayer()
        .querySelector('[data-tutorial-checkpoint="open-atlas"]')
        ?.classList.contains("is-complete"),
    ).toBe(true);

    tutorialNextButton().click();
    expect(tutorialLayer().textContent).toContain("Explore the Atlas picture");
    expect(tutorialNextButton().disabled).toBe(true);
    const ordinaryAtlasCircle = document.querySelector<SVGGElement>(
      ".atlas g.n[data-el]:not([data-loop])",
    );
    expect(ordinaryAtlasCircle).not.toBeNull();
    ordinaryAtlasCircle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await finishTutorialCheckpointEvaluation();
    expect(
      tutorialLayer()
        .querySelector('[data-tutorial-checkpoint="select-atlas-element"]')
        ?.classList.contains("is-complete"),
    ).toBe(true);
    expect(tutorialNextButton().disabled).toBe(false);

    tutorialNextButton().click();
    expect(tutorialLayer().textContent).toContain("Read a grouped circle carefully");
    expect(tutorialNextButton().disabled).toBe(false);

    tutorialNextButton().click();
    expect(tutorialLayer().textContent).toContain("Frame the Atlas view");
    expect(tutorialNextButton().disabled).toBe(true);
    document.querySelector<HTMLButtonElement>("#atlas-zoom-readout")!.click();
    await finishTutorialCheckpointEvaluation();
    expect(tutorialNextButton().disabled).toBe(false);

    // Reading the picture comes first; asking the question about a different
    // box now closes that half, after the pathway and feedback steps.
    goToTutorialStep(7);
    expect(tutorialLayer().textContent).toContain("Change the starting question");
    expect(tutorialNextButton().disabled).toBe(true);
    document.querySelector<HTMLButtonElement>("#atlas-button")!.click();
    await finishTutorialCheckpointEvaluation();
    const newStartingBox = document.querySelector<HTMLButtonElement>("[data-atlas-start]");
    expect(newStartingBox).not.toBeNull();
    newStartingBox!.click();
    await finishTutorialCheckpointEvaluation();
    expect(tutorialNextButton().disabled).toBe(false);

    // The simulating half follows, and only then.
    goToTutorialStep(8);
    expect(tutorialLayer().textContent).toContain("Ask the same picture a what-if question");
    expect(tutorialNextButton().disabled).toBe(true);
    document.getElementById("atlas-sim-toggle-button")!.click();
    await finishTutorialCheckpointEvaluation();
    expect(state.simulationMode).toBe(true);
    expect(atlasIsOpen()).toBe(true);
    expect(tutorialNextButton().disabled).toBe(false);
  });

  // The payoff of the simulating half: a change that reaches a box and stops,
  // with the thing holding it named. It is also the example map answering its
  // own question — more facilitators cannot serve more residents while venues
  // are the scarce arm of the capacity gate.
  it("shows a change stopping at the capacity gate, and names what held it", async () => {
    const pendingAtlasFrames = new Map<number, FrameRequestCallback>();
    let nextAtlasFrameId = 1;
    setAtlasRenderFrameSchedulerForTests({
      requestFrame(callback) {
        const identifier = nextAtlasFrameId++;
        pendingAtlasFrames.set(identifier, callback);
        return identifier;
      },
      cancelFrame(identifier) { pendingAtlasFrames.delete(identifier); },
    });
    const drainAtlasFrames = (): void => {
      for (let guard = 0; guard < 12 && pendingAtlasFrames.size; guard++) {
        const [identifier, callback] = pendingAtlasFrames.entries().next().value as
          [number, FrameRequestCallback];
        pendingAtlasFrames.delete(identifier);
        callback(0);
      }
    };

    try {
      initAtlasStage();
      expect(startLearnLesson("follow-pathways")).toBe(true);
      goToTutorialStep(10);
      drainAtlasFrames();

      expect(tutorialLayer().textContent).toContain("Find where the change stopped");
      expect(atlasIsOpen()).toBe(true);
      expect(state.simulationMode).toBe(true);
      // Nothing has moved yet, so nothing is held yet.
      expect(document.querySelectorAll(".atlas g.n.held")).toHaveLength(0);
      expect(tutorialNextButton().disabled).toBe(true);

      // Drive the real control, the way the step asks a learner to: the
      // checkpoint listens for an event on the slider, so setting the value
      // through the engine would never reach it.
      const facilitatorInput = document.querySelector<HTMLInputElement>(
        '.sim-slider-row[data-node-id="facilitator_slots"] .sim-pct-input',
      )!;
      facilitatorInput.value = "150";
      facilitatorInput.dispatchEvent(new Event("input", { bubbles: true }));
      facilitatorInput.dispatchEvent(new Event("change", { bubbles: true }));
      drainAtlasFrames();
      await finishTutorialCheckpointEvaluation();
      expect(
        tutorialLayer().querySelector('[data-tutorial-checkpoint="atlas-raise-facilitators"]')
          ?.classList.contains("is-complete"),
      ).toBe(true);

      const heldCircles = document.querySelectorAll<SVGGElement>(".atlas g.n.held");
      expect(heldCircles).toHaveLength(1);
      expect(heldCircles[0].querySelector(".mag")?.textContent)
        .toContain("held by Venue availability");

      heldCircles[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await finishTutorialCheckpointEvaluation();
      expect(tutorialNextButton().disabled).toBe(false);
    } finally {
      setAtlasRenderFrameSchedulerForTests(null);
    }
  });

  it("requires meaningful travel to the end and back before movement is complete", async () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    expect(startLearnLesson("read-a-map")).toBe(true);
    goToTutorialStep(3);
    const scrollArea = document.getElementById("viz-scroll")!;
    Object.defineProperty(scrollArea, "clientWidth", { configurable: true, value: 500 });
    Object.defineProperty(scrollArea, "scrollWidth", { configurable: true, value: 1000 });

    scrollArea.scrollLeft = 50;
    scrollArea.dispatchEvent(new Event("scroll", { bubbles: true }));
    await finishTutorialCheckpointEvaluation();
    expect(tutorialLayer().querySelectorAll(".tutorial-task-checkpoint.is-complete")).toHaveLength(0);
    expect(tutorialNextButton().disabled).toBe(true);

    scrollArea.scrollLeft = 400;
    scrollArea.dispatchEvent(new Event("scroll", { bubbles: true }));
    await finishTutorialCheckpointEvaluation();
    expect(tutorialLayer().querySelectorAll(".tutorial-task-checkpoint.is-complete")).toHaveLength(1);
    expect(tutorialNextButton().disabled).toBe(true);

    scrollArea.scrollLeft = 50;
    scrollArea.dispatchEvent(new Event("scroll", { bubbles: true }));
    await finishTutorialCheckpointEvaluation();
    expect(tutorialLayer().querySelectorAll(".tutorial-task-checkpoint.is-complete")).toHaveLength(2);
    expect(tutorialNextButton().disabled).toBe(false);
  });

  it("does not count a fit click as the required zoom change", async () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    expect(startLearnLesson("read-a-map")).toBe(true);
    goToTutorialStep(2);

    document.getElementById("viz-zoom-readout")!.click();
    await finishTutorialCheckpointEvaluation();
    expect(tutorialLayer().querySelectorAll(".tutorial-task-checkpoint.is-complete")).toHaveLength(0);

    document.getElementById("viz-zoom-in")!.click();
    await finishTutorialCheckpointEvaluation(360);
    expect(tutorialNextButton().disabled).toBe(false);
  });

  it("rejects a matching slider event while the value remains at baseline", async () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    expect(startLearnLesson("ask-what-if")).toBe(true);
    const percentageInput = document.querySelector<HTMLInputElement>(
      '.sim-slider-row[data-node-id="volunteer_hours"] .sim-pct-input',
    )!;

    percentageInput.value = "100";
    percentageInput.dispatchEvent(new Event("input", { bubbles: true }));
    percentageInput.dispatchEvent(new Event("change", { bubbles: true }));
    await finishTutorialCheckpointEvaluation();
    expect(tutorialNextButton().disabled).toBe(true);

    percentageInput.value = "125";
    percentageInput.dispatchEvent(new Event("input", { bubbles: true }));
    percentageInput.dispatchEvent(new Event("change", { bubbles: true }));
    await finishTutorialCheckpointEvaluation();
    expect(tutorialNextButton().disabled).toBe(false);
  });

  it("completes the simulation gate when Volunteer time is scrubbed by dragging", async () => {
    expect(startLearnLesson("ask-what-if")).toBe(true);
    const percentageInput = document.querySelector<HTMLInputElement>(
      '.sim-slider-row[data-node-id="volunteer_hours"] .sim-pct-input',
    )!;

    percentageInput.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 100 }));
    percentageInput.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 125 }));
    percentageInput.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 125 }));
    await finishTutorialCheckpointEvaluation();

    expect(state.userOverrides.volunteer_hours).toBeCloseTo(1.25);
    expect(tutorialNextButton().disabled).toBe(false);
    expect(tutorialLayer().querySelector('[data-tutorial-checkpoint="change-volunteer-time"]')?.classList.contains("is-complete")).toBe(true);
  });

  it("teaches formula hover values, Driven by highlighting and global variables", async () => {
    expect(startLearnLesson("ask-what-if")).toBe(true);
    goToTutorialStep(1);

    expect(tutorialLayer().textContent).toContain("Hover a box variable");
    expect(tutorialLayer().textContent).toContain("marked global");
    expect(tutorialNextButton().disabled).toBe(true);

    const boxVariable = document.querySelector<HTMLElement>(
      '.calc-formula .fx-box[data-formula-node-id="outreach_effort"]',
    )!;
    boxVariable.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    boxVariable.dispatchEvent(new MouseEvent("mouseenter"));
    await finishTutorialCheckpointEvaluation();

    expect(tutorialLayer().querySelector(
      '[data-tutorial-checkpoint="hover-formula-box"]',
    )?.classList.contains("is-complete")).toBe(true);
    expect(tutorialNextButton().disabled).toBe(true);

    document.querySelector<HTMLElement>(
      '.calc-formula [data-formula-param-id="people_reached_per_hour"]',
    )!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    await finishTutorialCheckpointEvaluation();

    expect(tutorialLayer().querySelector(
      '[data-tutorial-checkpoint="hover-formula-global"]',
    )?.classList.contains("is-complete")).toBe(true);
    expect(tutorialNextButton().disabled).toBe(false);
  });

  it("holds the zero-input calculation step until the input actually reaches zero", async () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    expect(startLearnLesson("ask-what-if")).toBe(true);
    goToTutorialStep(4);
    const percentageInput = document.querySelector<HTMLInputElement>(
      '.sim-slider-row[data-node-id="outreach_effort"] .sim-pct-input',
    )!;

    percentageInput.value = "50";
    percentageInput.dispatchEvent(new Event("input", { bubbles: true }));
    percentageInput.dispatchEvent(new Event("change", { bubbles: true }));
    await finishTutorialCheckpointEvaluation();
    expect(tutorialNextButton().disabled).toBe(true);

    percentageInput.value = "0";
    percentageInput.dispatchEvent(new Event("input", { bubbles: true }));
    percentageInput.dispatchEvent(new Event("change", { bubbles: true }));
    await finishTutorialCheckpointEvaluation();
    expect(state.computedValues.outreach_reach).toBe(0);
    expect(tutorialNextButton().disabled).toBe(false);

    tutorialNextButton().click();
    expect(tutorialLayer().textContent).toContain("Read what the map says went wrong");
  });

  it("unlocks link creation only after the edge model actually changes", async () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    expect(startLearnLesson("build-a-map")).toBe(true);
    goToTutorialStep(5);
    const edgeHandle = document.querySelector<HTMLElement>('[data-node-id="workshop_readiness"] .edge-handle')!;

    edgeHandle.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await finishTutorialCheckpointEvaluation();
    expect(tutorialNextButton().disabled).toBe(true);

    const destinationIdentifier = NODES.find(node => node.id !== "workshop_readiness" &&
      !EDGES.some(edge => edge.from === "workshop_readiness" && edge.to === node.id))!.id;
    expect(commitNewEdge("workshop_readiness", destinationIdentifier, "increases")).not.toBeNull();
    document.querySelector<HTMLElement>('.node-group[data-node-id="' + destinationIdentifier + '"]')!
      .dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await finishTutorialCheckpointEvaluation();
    expect(tutorialNextButton().disabled).toBe(false);
  });

  it("points the relationship editing step at the outgoing links block", () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    expect(startLearnLesson("build-a-map")).toBe(true);
    goToTutorialStep(6);

    const outgoingLinksBlock = document.querySelector("#detail-panel .outgoing-edges-block");
    expect(outgoingLinksBlock).not.toBeNull();
    const highlightedTarget = document.querySelector(".tutorial-target");
    expect(highlightedTarget?.matches(".outgoing-edges-block .drow")).toBe(true);
    expect(outgoingLinksBlock?.contains(highlightedTarget)).toBe(true);
  });

  it("preserves completed checkpoints on the current step when resuming", async () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    expect(startLearnLesson("read-a-map")).toBe(true);
    goToTutorialStep(7);
    document.getElementById("viz-depth-up")!.click();
    await finishTutorialCheckpointEvaluation();
    expect(tutorialNextButton().disabled).toBe(true);

    exitTutorial({ markDismissed: false });
    expect(startLearnLesson("read-a-map", { resume: true })).toBe(true);
    expect(tutorialLayer().textContent).toContain("Step 8 of " + READ_A_MAP_STEP_COUNT);
    expect(tutorialLayer().querySelectorAll(".tutorial-task-checkpoint.is-complete")).toHaveLength(1);
    expect(tutorialNextButton().disabled).toBe(true);
  });

  it("shows saved step-zero checkpoint work as resumable in Learn", async () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    expect(startLearnLesson("ask-what-if")).toBe(true);
    const percentageInput = document.querySelector<HTMLInputElement>(
      '.sim-slider-row[data-node-id="volunteer_hours"] .sim-pct-input',
    )!;
    percentageInput.value = "125";
    percentageInput.dispatchEvent(new Event("input", { bubbles: true }));
    percentageInput.dispatchEvent(new Event("change", { bubbles: true }));
    await finishTutorialCheckpointEvaluation();
    exitTutorial({ markDismissed: false });

    expect(openLearnHub()).toBe(true);
    const lessonCard = tutorialLayer().querySelector<HTMLElement>('[data-lesson-card="ask-what-if"]')!;
    expect(lessonCard.textContent).toContain("In progress");
    expect(lessonCard.textContent).toContain("Resume");
  });

  it("gates creating and naming a box as two ordered actions", async () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    expect(startLearnLesson("build-a-map")).toBe(true);
    goToTutorialStep(3);

    document.getElementById("viz-scroll")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await finishTutorialCheckpointEvaluation();
    expect(tutorialLayer().querySelectorAll(".tutorial-task-checkpoint.is-complete")).toHaveLength(0);

    createNodeInCell(STREAMS[0].id, STAGES[0].id);
    const createdNode = NODES.find(node => node.id.startsWith("new_node"))!;
    document.querySelector<HTMLElement>('.node-group[data-node-id="' + createdNode.id + '"]')!
      .dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await finishTutorialCheckpointEvaluation();
    expect(tutorialLayer().querySelectorAll(".tutorial-task-checkpoint.is-complete")).toHaveLength(1);
    expect(tutorialNextButton().disabled).toBe(true);

    startInlineRename(createdNode.id);
    inlineRenameAppend("T");
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "T", bubbles: true }));
    expect(state.canvasEdit.inlineRename?.started).toBe(true);
    await finishTutorialCheckpointEvaluation();
    expect(tutorialNextButton().disabled).toBe(false);
  });

  it("requires deleting the selected box before undo can complete the recovery task", async () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    expect(startLearnLesson("build-a-map")).toBe(true);
    goToTutorialStep(3);
    createNodeInCell(STREAMS[0].id, STAGES[0].id);
    const createdNode = NODES.find(node => node.id.startsWith("new_node"))!;
    focusNode(createdNode.id);
    goToTutorialStep(4);
    expect(state.uiMode).toBe("edit");
    expect(state.selectedNodeId).toBe(createdNode.id);

    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true }));
    await finishTutorialCheckpointEvaluation();
    expect(tutorialLayer().querySelectorAll(".tutorial-task-checkpoint.is-complete")).toHaveLength(0);

    expect(deleteSelection()).toBe(true);
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    await finishTutorialCheckpointEvaluation();
    expect(nodeById[createdNode.id]).toBeUndefined();
    expect(tutorialLayer().querySelectorAll(".tutorial-task-checkpoint.is-complete")).toHaveLength(1);

    expect(historyUndo()).toBe(true);
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true }));
    await finishTutorialCheckpointEvaluation();
    expect(nodeById[createdNode.id]).toBeDefined();
    expect(tutorialNextButton().disabled).toBe(false);
  });

  it("exposes the checklist as live status and describes the gated Next button", () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    expect(startLearnLesson("first-look")).toBe(true);
    const taskStatus = tutorialLayer().querySelector<HTMLElement>("#tutorial-task-requirements")!;

    expect(taskStatus.getAttribute("role")).toBe("status");
    expect(taskStatus.getAttribute("aria-live")).toBe("polite");
    expect(taskStatus.textContent).toContain("Complete all actions to unlock Next");
    expect(taskStatus.querySelectorAll(".tutorial-task-checkpoint")).toHaveLength(1);
    expect(tutorialNextButton().getAttribute("aria-describedby")).toBe("tutorial-task-requirements");
  });

  it("gates the Review finding step until a finding is opened on the map", async () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    expect(startLearnLesson("check-a-map")).toBe(true);
    goToTutorialStep(4);

    // Review draws its behavioural finding cards from whatever the example map
    // happens to show, so stand one in rather than depending on today's map.
    const findingCard = document.createElement("div");
    findingCard.className = "review-card is-clickable";
    findingCard.setAttribute("data-review-box", "workshop_readiness");
    findingCard.textContent = "Workshop readiness moves nothing";
    document.getElementById("review-stage")!.appendChild(findingCard);

    expect(tutorialNextButton().disabled).toBe(true);

    findingCard.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    focusNode("workshop_readiness");
    closeReview();
    await finishTutorialCheckpointEvaluation();
    expect(
      tutorialLayer().querySelector('[data-tutorial-checkpoint="open-review-finding-on-map"]')
        ?.classList.contains("is-complete"),
    ).toBe(true);
    expect(tutorialNextButton().disabled).toBe(false);

    tutorialNextButton().click();
    expect(tutorialLayer().textContent).toContain("Check a map you trust · Step 6 of 9");
  });

  it("gates the signed review pass and one review action in sequence", async () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    expect(startLearnLesson("check-a-map")).toBe(true);
    goToTutorialStep(7);
    const reviewerInput = document.getElementById("review-reviewer") as HTMLInputElement;
    expect(document.querySelector(".tutorial-target")).toBe(reviewerInput);

    reviewerInput.value = "A";
    reviewerInput.dispatchEvent(new Event("input", { bubbles: true }));
    await finishTutorialCheckpointEvaluation();
    expect(tutorialLayer().querySelectorAll(".tutorial-task-checkpoint.is-complete")).toHaveLength(0);

    reviewerInput.value = "Test Reviewer";
    state.reviewer = "Test Reviewer";
    reviewerInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(state.reviewer).toBe("Test Reviewer");
    await finishTutorialCheckpointEvaluation();
    expect(tutorialLayer().querySelectorAll(".tutorial-task-checkpoint.is-complete")).toHaveLength(1);
    expect(tutorialNextButton().disabled).toBe(true);

    const firstReviewTarget = startReviewPass();
    expect(firstReviewTarget).toBeTruthy();
    focusNode(firstReviewTarget!);
    const startPassButton = document.getElementById("review-start-pass") as HTMLButtonElement;
    startPassButton.disabled = false;
    startPassButton.click();
    await finishTutorialCheckpointEvaluation();
    expect(tutorialNextButton().disabled).toBe(false);
    tutorialNextButton().click();

    const skipButton = document.querySelector<HTMLButtonElement>('#detail-panel [data-review="skip"]')!;
    expect(skipButton).toBeTruthy();
    expect(document.querySelector(".tutorial-target")).toBe(
      document.querySelector("#detail-panel .rv-verdicts"),
    );
    expect(tutorialNextButton().disabled).toBe(true);
    skipButton.click();
    await finishTutorialCheckpointEvaluation();
    expect(tutorialNextButton().disabled).toBe(false);
  });

  it("starts a named lesson on the temporary map and offers Reset and Exit", () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    const originalNodeIdentifiers = NODES.map(node => node.id);

    expect(startLearnLesson("make-it-calculate")).toBe(true);
    expect(tutorialIsActive()).toBe(true);
    expect(nodeById.completed_follow_ups).toBeDefined();
    expect(tutorialLayer().textContent).toContain("Make it calculate");
    expect(tutorialLayer().textContent).toContain("Reset lesson");
    expect(tutorialLayer().textContent).toContain("Exit lesson");

    tutorialLayer().querySelector<HTMLElement>('[data-tutorial-action="exit-lesson"]')!.click();
    expect(tutorialIsActive()).toBe(false);
    expect(NODES.map(node => node.id)).toEqual(originalNodeIdentifiers);
    expect(tutorialLayer().textContent).toContain("Learn Ariadne Maps.");
  });

  it("loads the small example for the early lessons and the full one later", () => {
    expect(startLearnLesson("first-look")).toBe(true);
    expect(nodeById.workshop_readiness).toBeDefined();
    // The small map is deliberately cut down: no delivery-capacity chain.
    expect(nodeById.delivery_capacity).toBeUndefined();
    const smallMapNodeCount = NODES.length;
    exitTutorial({ markDismissed: false });

    expect(startLearnLesson("build-a-map")).toBe(true);
    expect(nodeById.delivery_capacity).toBeDefined();
    expect(NODES.length).toBeGreaterThan(smallMapNodeCount);
  });

  it("connects the tutorial card to its borderless target with the learning thread", () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    expect(startLearnLesson("first-look")).toBe(true);

    expect(tutorialLayer().querySelectorAll("[data-tutorial-highlight-style]")).toHaveLength(0);
    expect(tutorialLayer().querySelector(".tutorial-target-thread")).not.toBeNull();
    expect(tutorialLayer().querySelector(".tutorial-target-thread-path")).not.toBeNull();
    expect(document.querySelector(".tutorial-target")).not.toBeNull();

    exitTutorial({ markDismissed: false });
  });

  it("anchors instructional threads to the specific element being discussed", () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    const targetCases = [
      { lessonIdentifier: "first-look", stepIndex: 0, selector: '[data-node-id="workshop_readiness"]' },
      { lessonIdentifier: "first-look", stepIndex: 4, selector: "#sim-reset-button" },
      { lessonIdentifier: "read-a-map", stepIndex: 0, selector: ".viz-sticky-row, .row-label-group" },
      { lessonIdentifier: "read-a-map", stepIndex: 1, selector: '[data-node-id="workshop_readiness"]' },
      { lessonIdentifier: "read-a-map", stepIndex: 6, selector: '#detail-panel [data-detail-quantity="outcome"]' },
      { lessonIdentifier: "read-a-map", stepIndex: 7, selector: "#viz-depth-up" },
      { lessonIdentifier: "read-a-map", stepIndex: 9, selector: "#sidebar [data-kind][data-id], #sidebar [data-legend-kind][data-legend-id]" },
      { lessonIdentifier: "follow-pathways", stepIndex: 1, selector: ".atlas g.n[data-el] > circle.bub" },
      { lessonIdentifier: "build-a-map", stepIndex: 2, selector: '#detail-panel [data-field="description"]' },
      { lessonIdentifier: "build-a-map", stepIndex: 5, selector: '.edge-handle[data-node-id="workshop_readiness"]' },
      { lessonIdentifier: "make-it-calculate", stepIndex: 1, selector: '#detail-panel [data-field="combine"]' },
      { lessonIdentifier: "check-a-map", stepIndex: 0, selector: "#review-stage" },
      { lessonIdentifier: "check-a-map", stepIndex: 6, selector: ".review-rows" },
      { lessonIdentifier: "check-a-map", stepIndex: 7, selector: "#review-reviewer" },
    ];

    for (const targetCase of targetCases) {
      expect(startLearnLesson(targetCase.lessonIdentifier)).toBe(true);
      goToTutorialStep(targetCase.stepIndex);
      expect(
        document.querySelector(".tutorial-target")?.matches(targetCase.selector),
        targetCase.lessonIdentifier + " step " + (targetCase.stepIndex + 1),
      ).toBe(true);
      exitTutorial({ markDismissed: false });
    }
  }, 15_000);

  it("rebinds after mutation, settles on the final geometry, then holds until an event marks it dirty", async () => {
    let restoreElementRect = (): void => {};
    try {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    expect(startLearnLesson("first-look")).toBe(true);

    const originalTarget = document.querySelector<SVGGElement>(
      '[data-node-id="workshop_readiness"]',
    )!;
    render();
    const replacementTarget = document.querySelector<SVGGElement>(
      '[data-node-id="workshop_readiness"]',
    )!;
    expect(replacementTarget).not.toBe(originalTarget);

    let targetLeft = 120;
    // The tracker re-resolves its target BY SELECTOR every time it repaints, so
    // any render during the test hands it an element this test has never seen.
    // Stubbing instances — even every instance present right now — still lost
    // to the next render and made this flaky about one run in three. Stub at
    // the prototype instead, keyed on the box, so a replacement element answers
    // the same way its predecessor did.
    const realGetBoundingClientRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      if (this.closest?.('[data-node-id="workshop_readiness"]')) {
        return {
          left: targetLeft, right: targetLeft + 80, top: 90, bottom: 130,
          width: 80, height: 40, x: targetLeft, y: 90, toJSON: () => ({}),
        } as DOMRect;
      }
      return realGetBoundingClientRect.call(this);
    };
    restoreElementRect = () => { Element.prototype.getBoundingClientRect = realGetBoundingClientRect; };
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

    // The thread redraws while its geometry is still moving and stops once two
    // consecutive frames agree, so a fixed frame count races that settle loop —
    // which is what made this test flaky at about one run in two. Poll for the
    // state being waited on instead. A wait that cannot tell "not started yet"
    // from "finished" is the same bug in a different place, so these two are
    // kept apart: poll until something is TRUE, and only ever use a fixed number
    // of frames to assert something stays FALSE.
    const nextFrame = (): Promise<void> =>
      new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const markerElement = (): SVGCircleElement =>
      tutorialLayer().querySelector<SVGCircleElement>(".tutorial-target-thread-marker")!;
    const waitUntil = async (isReady: () => boolean): Promise<void> => {
      for (let frame = 0; frame < 30 && !isReady(); frame++) await nextFrame();
    };

    const boundTarget = (): Element | null => document.querySelector(".tutorial-target");
    await waitUntil(() => {
      const current = boundTarget();
      return current !== null && current !== originalTarget;
    });
    await waitUntil(() => markerElement().getAttribute("cx") === "160");

    // Assert on whichever element is live, not on the one this test captured.
    // The tracker re-resolves BY SELECTOR on every repaint, so a later render can
    // hand it a third element and detach `replacementTarget` — which is exactly
    // what happened here, roughly one full-suite run in six: the thread was bound
    // correctly and drawn at the right place, while the test interrogated an
    // element no longer in the document.
    const currentTarget = boundTarget()!;
    expect(currentTarget).not.toBe(originalTarget);
    expect(currentTarget.matches('[data-node-id="workshop_readiness"]')).toBe(true);
    expect(document.contains(currentTarget)).toBe(true);
    expect(originalTarget.classList.contains("tutorial-target")).toBe(false);
    expect(markerElement().getAttribute("cx")).toBe("160");

    // Let the settle loop run out first. The thread deliberately keeps redrawing
    // for a few frames after any change so it converges on the surface's final
    // geometry — without that it strands itself on whatever the first frame
    // measured, which is how a thread ends up pointing at a box that has since
    // moved under the detail panel. The property this asserts is the other half:
    // once settled it stops, and does not poll on forever.
    for (let frame = 0; frame < 20; frame++) await nextFrame();

    // Nothing marks the thread dirty here, so it must NOT pick the move up. This
    // is the one assertion about absence, so it takes a fixed number of frames —
    // polling for something that should never happen would only ever time out.
    targetLeft = 300;
    for (let frame = 0; frame < 6; frame++) await nextFrame();
    expect(markerElement().getAttribute("cx")).toBe("160");

    document.dispatchEvent(new Event("scroll"));
    await waitUntil(() => markerElement().getAttribute("cx") === "340");
    expect(markerElement().getAttribute("cx")).toBe("340");
    } finally {
      restoreElementRect();
    }
  });

  it("fades over the target and returns when the pointer moves away", () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    expect(startLearnLesson("first-look")).toBe(true);

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
    expect(startLearnLesson("first-look")).toBe(true);

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
    expect(startLearnLesson("read-a-map")).toBe(true);
    goToTutorialStep(2);
    expect(loadLearnProgress()).toMatchObject({
      lastLessonId: "read-a-map",
      lastStepIndex: 2,
    });

    tutorialLayer().querySelector<HTMLElement>('[data-tutorial-action="exit-lesson"]')!.click();
    const resumeButton = tutorialLayer().querySelector<HTMLElement>(
      '[data-lesson-id="read-a-map"][data-tutorial-action="lesson"]',
    )!;
    expect(resumeButton.textContent).toBe("Resume");
    resumeButton.click();

    expect(tutorialLayer().textContent).toContain("Step 3 of " + READ_A_MAP_STEP_COUNT);
  });

  it("marks a finished lesson and shows it as completed in the library", () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    const lesson = learnLesson("share-and-keep");
    expect(startLearnLesson(lesson.id)).toBe(true);
    goToTutorialStep(lesson.steps.length - 1);
    tutorialNextButton().click();
    expect(loadLearnProgress().completedLessonIds).toContain("share-and-keep");

    tutorialLayer().querySelector<HTMLElement>('[data-tutorial-action="learn"]')!.click();
    const lessonCard = tutorialLayer().querySelector<HTMLElement>('[data-lesson-card="share-and-keep"]')!;
    expect(lessonCard.classList.contains("is-complete")).toBe(true);
    expect(lessonCard.textContent).toContain("Completed");
    expect(tutorialLayer().textContent).toContain("1 of 8 lessons complete");
    expect(localStorage.getItem(LEARN_PROGRESS_KEY)).toBeTruthy();
  });

  it("closes a lesson with a recap of what the learner can now do", () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    const lesson = learnLesson("first-look");
    expect(startLearnLesson(lesson.id)).toBe(true);
    goToTutorialStep(lesson.steps.length - 1);
    tutorialSkipButton().click();

    const recap = tutorialLayer().querySelector<HTMLElement>(".tutorial-recap")!;
    expect(recap).not.toBeNull();
    expect(recap.querySelectorAll("li")).toHaveLength(lesson.recap.length);
    for (const recapItem of lesson.recap) expect(recap.textContent).toContain(recapItem);

    const transfer = tutorialLayer().querySelector<HTMLElement>(".tutorial-transfer")!;
    expect(transfer.textContent).toContain("Try it on your own map.");
    expect(transfer.textContent).toContain(lesson.tryOnYourOwnMap);
    expect(tutorialLayer().textContent).toContain("Keep example");
  });

  it("offers Keep example on the last lesson, since no lesson damages the map", () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    const lesson = learnLesson("share-and-keep");
    expect(lesson.recommendedNextLessonId).toBeUndefined();
    expect(startLearnLesson(lesson.id)).toBe(true);
    goToTutorialStep(lesson.steps.length - 1);
    tutorialNextButton().click();

    expect(tutorialLayer().querySelector(".tutorial-recap")).not.toBeNull();
    expect(tutorialLayer().querySelector(".tutorial-transfer")).not.toBeNull();
    expect(tutorialLayer().querySelector('[data-tutorial-action="keep"]')).not.toBeNull();
    expect(tutorialLayer().querySelector('[data-tutorial-action="next-lesson"]')).toBeNull();
    expect(tutorialLayer().querySelector('[data-tutorial-action="restore"]')).not.toBeNull();
  });

  it("completes the edit lesson immediately from any editable field", async () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    expect(startLearnLesson("build-a-map")).toBe(true);
    goToTutorialStep(2);
    const nameInput = document.querySelector<HTMLInputElement>("#detail-panel .detail-name-input")!;
    nameInput.value = "Workshop readiness updated";
    nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    await finishTutorialCheckpointEvaluation();

    expect(nodeById.workshop_readiness.label).toBe("Workshop readiness updated");
    expect(tutorialNextButton().disabled).toBe(false);
    expect(
      tutorialLayer().querySelector('[data-tutorial-checkpoint="edit-box-field"]')?.classList.contains("is-complete"),
    ).toBe(true);
  });

  it("continues directly from a completed lesson to its recommended next lesson", () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    const originalNodeIdentifiers = NODES.map(node => node.id);
    expect(startLearnLesson("first-look")).toBe(true);
    goToTutorialStep(FIRST_LOOK_STEP_COUNT - 1);
    tutorialSkipButton().click();

    const nextLessonButton = tutorialLayer().querySelector<HTMLButtonElement>(
      '[data-tutorial-action="next-lesson"]',
    )!;
    expect(nextLessonButton.textContent).toBe("Next lesson: Read a map");
    nextLessonButton.click();

    expect(tutorialIsActive()).toBe(true);
    expect(tutorialLayer().textContent).toContain("Read a map · Step 1 of " + READ_A_MAP_STEP_COUNT);
    expect(NODES.map(node => node.id)).not.toEqual(originalNodeIdentifiers);
    expect(loadLearnProgress()).toMatchObject({
      completedLessonIds: expect.arrayContaining(["first-look"]),
      lastLessonId: "read-a-map",
      lastStepIndex: 0,
    });
  });

  it("keeps the Review lesson's example map inside the reversible lesson session", () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    const originalFormula = nodeById.team_size.formula;

    expect(startLearnLesson("check-a-map")).toBe(true);
    // The example map carries its own evidence gaps, so nothing is damaged at
    // runtime to give Review something to find.
    expect(nodeById.registration_share).toBeDefined();
    expect(nodeById.registration_share.formula).not.toContain("missing_tutorial_input");
    expect(document.getElementById("review-stage")!.hidden).toBe(false);

    tutorialLayer().querySelector<HTMLElement>('[data-tutorial-action="exit-lesson"]')!.click();
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

    expect(startLearnLesson("build-a-map")).toBe(true);
    goToTutorialStep(7);
    expect(state.builder.open).toBe(true);
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

    expect(startLearnLesson("ask-what-if")).toBe(true);
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

    expect(startLearnLesson("make-it-calculate")).toBe(true);
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

    expect(startLearnLesson("read-a-map")).toBe(true);
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

    expect(startLearnLesson("build-a-map")).toBe(true);
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
  it("opens the first lesson on the map in View mode with nothing selected", () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    expect(startTutorial()).toBe(true);
    expect(state.selectedNodeId).toBeNull();
    expect(state.simulationMode).toBe(false);
    expect(state.uiMode).toBe("read");
    expect(document.querySelector(".tutorial-target")).toBe(
      document.querySelector('.node-group[data-node-id="workshop_readiness"]'),
    );

    document.getElementById("tooltip")!.classList.add("visible");
    goToTutorialStep(1);
    expect(state.selectedNodeId).toBe("workshop_readiness");
    // The step asks the reader to select a box this one connects to, and only a
    // click on a .node-group completes it — so the thread has to land on one of
    // those, not on the depth stepper it used to point at.
    const connectedTarget = document.querySelector(".tutorial-target");
    expect(connectedTarget).not.toBeNull();
    expect(connectedTarget!.classList.contains("node-group")).toBe(true);
    expect(
      connectedTarget!.classList.contains("ancestor") || connectedTarget!.classList.contains("descendant"),
    ).toBe(true);
    expect(document.getElementById("tooltip")!.classList.contains("visible")).toBe(false);

    goToTutorialStep(2);
    expect(state.simulationMode).toBe(true);
    expect(document.querySelector(".tutorial-target")).toBe(
      document.querySelector('.sim-slider-row[data-node-id="volunteer_hours"]'),
    );
  });

  it("finishes with an explicit keep-or-return decision", async () => {
    expect(loadDataFromCsv(SAMPLE_CSV)).toBe(true);
    expect(startTutorial()).toBe(true);
    goToTutorialStep(TUTORIAL_STEPS.length - 1);
    document.getElementById("sim-reset-button")!.click();
    await finishTutorialCheckpointEvaluation();
    expect(tutorialNextButton().disabled).toBe(false);

    tutorialNextButton().click();

    expect(tutorialLayer().textContent).toContain("Keep example");
    expect(tutorialLayer().textContent).toContain("Return to my map");
    expect(tutorialLayer().querySelector(".tutorial-recap")).not.toBeNull();
    expect(tutorialLayer().querySelector(".tutorial-transfer")).not.toBeNull();
  });
});
