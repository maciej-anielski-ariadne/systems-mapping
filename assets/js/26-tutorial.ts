// =============================================================================
// FIRST-OPEN GUIDED TOUR
// -----------------------------------------------------------------------------
// The tutorial temporarily swaps in a neutral example map and walks through
// the app's main reading, simulation, assurance and editing surfaces. Storage
// writes are suspended for the whole session: leaving restores the exact live
// map that was present before the tour, while "Keep example" is the only action
// that deliberately persists the tutorial map.
// =============================================================================

import { TUTORIAL_MAP_CSV } from "./01a-tutorial-map-data";
import {
  CATEGORIES,
  DEFAULT_ELASTICITY_BY_EFFECT,
  EDGES,
  NODES,
  PARAMS,
  STAGES,
  STREAMS,
  nodeById,
  state,
} from "./03-state";
import {
  applyRestoredUiState,
  clearBuilderFromStorage,
  flushPendingSaves,
  saveCsvToStorage,
  saveUiStateToStorage,
  setStorageWritesSuspended,
} from "./04a-storage";
import { serializeLiveStateToCsv } from "./05a-csv-serializer";
import { loadDataFromCsv } from "./06-data-loader";
import { focusNode, selectEdge, setSelection } from "./09-graph-selection";
import { hideTooltip } from "./12-tooltip";
import { render } from "./11-rendering";
import { renderDetailPanel } from "./15-detail-panel";
import { toggleSimulationMode } from "./14-simulation-panel";
import {
  cloneBuilderState,
  closeBuilder,
  invalidateBuilderCaches,
  openBuilder,
} from "./16a-builder-state";
import { renderBuilder } from "./16b-builder-render";
import { bootEmptyStateGrid } from "./16e-canvas-edit";
import type { EmptyMapGridSnapshot } from "./16e-canvas-edit";
import { applyCanvasMutation } from "./16f-canvas-mutations";
import { renderMultiSelectBar } from "./16j-multi-select-bar";
import {
  getNavigationControlMode,
  setExportMenuOpen,
  setFiltersOpen,
  setNavigationControlMode,
  setUiMode,
  type NavigationControlMode,
} from "./17-events";
import { clearSearch, handleSearchInput } from "./17a-search";
import {
  atlasIsOpen,
  captureAtlasSessionState,
  closeAtlas,
  openAtlas,
  openFirstFeedbackTangle,
  restoreAtlasSessionState,
} from "./21-atlas-view";
import type { AtlasSessionState } from "./21-atlas-view";
import { closeReview, openReview, reviewIsOpen } from "./23-review-panel";
import { endReviewPass, startReviewPass } from "./24-review-record";
import type { BuilderState, History } from "./types";

export const TUTORIAL_COMPLETION_KEY = "systems-map.tutorial.v1";
export const LEARN_PROGRESS_KEY = "systems-map.learn.progress.v1";

const WORKSHOP_READINESS_IDENTIFIER = "workshop_readiness";
const ADJUSTABLE_INPUT_IDENTIFIER = "volunteer_hours";
const FORMULA_IDENTIFIER = "outreach_reach";
const FEEDBACK_START_IDENTIFIER = "community_confidence";

interface TutorialUserInterfaceSnapshot {
  hiddenStreams: string[];
  hiddenCategories: string[];
  hiddenStages: string[];
  hiddenEffects: string[];
  hiddenStyles: string[];
  hiddenTrace: string[];
  simulationMode: boolean;
  userOverrides: Record<string, number>;
  selectedNodeId: string | null;
  selectedNodeIds: string[];
  selectedEdgeId: string | null;
  uiMode: "read" | "edit";
  sidebarPinned: boolean;
  detailPanelPinned: boolean;
  sidebarWidth: number;
  detailPanelWidth: number;
  zoomLevel: number;
  highlightDepth: number;
  navigationControlMode: NavigationControlMode;
  reviewer: string;
  filtersOpen: boolean;
  searchQuery: string;
  reviewPass: boolean;
  reviewWasOpen: boolean;
  atlasSession: AtlasSessionState | null;
  canvasEditMode: boolean;
  canvasOpenEdgeId: string | null;
  canvasScrollLeft: number;
  canvasScrollTop: number;
}

interface TutorialSession {
  originalMapCsv: string | null;
  originalEmptyMap: EmptyMapGridSnapshot | null;
  originalMapHadContent: boolean;
  originalUserInterface: TutorialUserInterfaceSnapshot;
  originalHistory: History;
  originalBuilder: BuilderState | null;
  currentLessonId: string;
  currentStepIndex: number;
  completedTaskStepIndexes: Set<number>;
  finishing: boolean;
  tutorialCardPosition: { left: number; top: number } | null;
}

interface TutorialCardDragState {
  pointerIdentifier: number;
  pointerStartX: number;
  pointerStartY: number;
  cardStartLeft: number;
  cardStartTop: number;
}

type TutorialTaskEvent = "click" | "input" | "change" | "scroll" | "keydown" | "mouseup";

export interface TutorialTask {
  instruction: string;
  selector: string;
  events: TutorialTaskEvent[];
  verify?: () => boolean;
}

export interface TutorialStep {
  title: string;
  body: string;
  targetSelector: string;
  enter: () => void;
  task?: TutorialTask;
}

export type LearnGroupId =
  | "read-navigate"
  | "simulate-atlas"
  | "maths"
  | "build-edit"
  | "review"
  | "files";

export interface LearnLesson {
  id: string;
  groupId: LearnGroupId;
  title: string;
  summary: string;
  duration: string;
  steps: TutorialStep[];
}

interface LearnProgress {
  completedLessonIds: string[];
  lastLessonId: string | null;
  lastStepIndex: number;
}

const FIRST_LESSON_ID = "map-essentials";

let tutorialSession: TutorialSession | null = null;
let highlightedTutorialTarget: Element | null = null;
let highlightedTutorialTargetSelector: string | null = null;
let tutorialTargetTrackingAnimationFrame: number | null = null;
let tutorialCardDragState: TutorialCardDragState | null = null;

function tutorialLayer(): HTMLElement | null {
  return document.getElementById("tutorial-layer");
}

function captureUserInterface(): TutorialUserInterfaceSnapshot {
  return {
    hiddenStreams: Array.from(state.hiddenStreams),
    hiddenCategories: Array.from(state.hiddenCategories),
    hiddenStages: Array.from(state.hiddenStages),
    hiddenEffects: Array.from(state.hiddenEffects),
    hiddenStyles: Array.from(state.hiddenStyles),
    hiddenTrace: Array.from(state.hiddenTrace),
    simulationMode: !!state.simulationMode,
    userOverrides: { ...state.userOverrides },
    selectedNodeId: state.selectedNodeId,
    selectedNodeIds: Array.from(state.selectedNodeIds),
    selectedEdgeId: state.selectedEdgeId,
    uiMode: state.uiMode === "edit" ? "edit" : "read",
    sidebarPinned: !!state.sidebarPinned,
    detailPanelPinned: !!state.detailPanelPinned,
    sidebarWidth: state.sidebarWidth,
    detailPanelWidth: state.detailPanelWidth,
    zoomLevel: state.zoomLevel,
    highlightDepth: state.highlightDepth,
    navigationControlMode: getNavigationControlMode(),
    reviewer: state.reviewer,
    filtersOpen: !!state.filtersOpen,
    searchQuery: state.searchQuery,
    reviewPass: !!state.reviewPass,
    reviewWasOpen: reviewIsOpen(),
    atlasSession: captureAtlasSessionState(),
    canvasEditMode: !!state.canvasEdit.editMode,
    canvasOpenEdgeId: state.canvasEdit.openEdgeId || null,
    canvasScrollLeft: document.getElementById("viz-scroll")?.scrollLeft || 0,
    canvasScrollTop: document.getElementById("viz-scroll")?.scrollTop || 0,
  };
}

function captureEmptyMap(): EmptyMapGridSnapshot {
  const categories: EmptyMapGridSnapshot["categories"] = {};
  for (const [identifier, category] of Object.entries(CATEGORIES)) {
    categories[identifier] = { ...category };
  }
  return {
    streams: STREAMS.map(stream => ({ ...stream })),
    stages: STAGES.map(stage => ({ ...stage })),
    categories,
    params: PARAMS.map(parameter => ({ ...parameter })),
    defaultElasticityByEffect: { ...DEFAULT_ELASTICITY_BY_EFFECT },
  };
}

function restoreHistory(history: History, currentMapCsv: string | null): void {
  state.history.past.length = 0;
  state.history.past.push(...history.past);
  state.history.future.length = 0;
  state.history.future.push(...history.future);
  // The next real mutation must push the restored map, not the tutorial map.
  state.lastCsvSnapshot = currentMapCsv;
}

function restoreBuilder(builder: BuilderState | null): void {
  if (!builder) return;
  const restoredBuilder = cloneBuilderState(builder);
  // The old overlay was destroyed and then used by the tutorial, so this must
  // be treated as a fresh render even when the restored step number matches.
  restoredBuilder._lastRenderedStep = null;
  restoredBuilder.focusAfterRender = null;
  Object.assign(state.builder, restoredBuilder);
  invalidateBuilderCaches();
  renderBuilder();
}

function restoreUserInterface(snapshot: TutorialUserInterfaceSnapshot): void {
  applyRestoredUiState(snapshot);
  setNavigationControlMode(snapshot.navigationControlMode);
  setFiltersOpen(snapshot.filtersOpen);
  const searchInput = document.getElementById("search-input") as HTMLInputElement | null;
  if (searchInput) searchInput.value = snapshot.searchQuery;
  if (snapshot.searchQuery) handleSearchInput();
  else clearSearch();
  if (snapshot.reviewPass) startReviewPass();
  else endReviewPass();
  if (snapshot.selectedNodeIds.length > 1) {
    setSelection(snapshot.selectedNodeIds.filter(identifier => !!nodeById[identifier]), snapshot.selectedNodeId);
    render();
    renderDetailPanel();
    renderMultiSelectBar();
  } else if (snapshot.selectedEdgeId) {
    selectEdge(snapshot.selectedEdgeId);
  } else if (snapshot.selectedNodeId && nodeById[snapshot.selectedNodeId]) {
    focusNode(snapshot.selectedNodeId);
  }
  state.canvasEdit.editMode = snapshot.canvasEditMode;
  state.canvasEdit.openEdgeId = snapshot.canvasOpenEdgeId;
  if (snapshot.atlasSession) restoreAtlasSessionState(snapshot.atlasSession);
  if (snapshot.reviewWasOpen) openReview();
  const canvasScroll = document.getElementById("viz-scroll");
  if (canvasScroll) {
    canvasScroll.scrollLeft = snapshot.canvasScrollLeft;
    canvasScroll.scrollTop = snapshot.canvasScrollTop;
  }
}

function tutorialCompletionState(): string | null {
  try { return localStorage.getItem(TUTORIAL_COMPLETION_KEY); }
  catch (_) { return null; }
}

function markTutorialState(value: "completed" | "dismissed"): void {
  try {
    const existingValue = localStorage.getItem(TUTORIAL_COMPLETION_KEY);
    if (existingValue === "completed" && value === "dismissed") return;
    localStorage.setItem(TUTORIAL_COMPLETION_KEY, value);
  } catch (_) {}
}

function clearTutorialTarget(): void {
  if (tutorialTargetTrackingAnimationFrame !== null && typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(tutorialTargetTrackingAnimationFrame);
  }
  tutorialTargetTrackingAnimationFrame = null;
  tutorialCardDragState = null;
  if (highlightedTutorialTarget) highlightedTutorialTarget.classList.remove("tutorial-target");
  highlightedTutorialTarget = null;
  highlightedTutorialTargetSelector = null;
}

function updateTutorialThreadPointerFade(event: PointerEvent): void {
  const thread = tutorialLayer()?.querySelector<SVGSVGElement>(".tutorial-target-thread");
  if (!thread) return;
  const pointerTarget = event.target;
  const pointerIsOverTutorialTarget = pointerTarget instanceof Node &&
    Boolean(highlightedTutorialTarget?.contains(pointerTarget));
  thread.classList.toggle("is-faded-over-target", pointerIsOverTutorialTarget);
}

function revealTutorialThreadAfterPointerLeaves(): void {
  tutorialLayer()?.querySelector(".tutorial-target-thread")
    ?.classList.remove("is-faded-over-target");
}

function applyTutorialCardPosition(): void {
  if (!tutorialSession?.tutorialCardPosition) return;
  const tutorialCard = tutorialLayer()?.querySelector<HTMLElement>(".tutorial-card");
  if (!tutorialCard) return;
  const cardBounds = tutorialCard.getBoundingClientRect();
  const viewportMargin = 12;
  const maximumLeft = Math.max(viewportMargin, window.innerWidth - cardBounds.width - viewportMargin);
  const maximumTop = Math.max(viewportMargin, window.innerHeight - cardBounds.height - viewportMargin);
  tutorialSession.tutorialCardPosition = {
    left: Math.max(viewportMargin, Math.min(maximumLeft, tutorialSession.tutorialCardPosition.left)),
    top: Math.max(viewportMargin, Math.min(maximumTop, tutorialSession.tutorialCardPosition.top)),
  };
  tutorialCard.style.left = tutorialSession.tutorialCardPosition.left + "px";
  tutorialCard.style.top = tutorialSession.tutorialCardPosition.top + "px";
  tutorialCard.style.right = "auto";
  tutorialCard.style.bottom = "auto";
  tutorialCard.style.transform = "none";
}

function beginTutorialCardDrag(event: PointerEvent): void {
  const eventTarget = event.target;
  if (!(eventTarget instanceof Element) || !eventTarget.closest("[data-tutorial-card-drag-handle]")) return;
  const tutorialCard = eventTarget.closest<HTMLElement>(".tutorial-card");
  if (!tutorialCard || !tutorialSession) return;
  event.preventDefault();
  const cardBounds = tutorialCard.getBoundingClientRect();
  tutorialCardDragState = {
    pointerIdentifier: typeof event.pointerId === "number" ? event.pointerId : 0,
    pointerStartX: event.clientX,
    pointerStartY: event.clientY,
    cardStartLeft: cardBounds.left,
    cardStartTop: cardBounds.top,
  };
  tutorialCard.classList.add("is-dragging");
}

function moveTutorialCard(event: PointerEvent): void {
  if (!tutorialCardDragState || !tutorialSession) return;
  const pointerIdentifier = typeof event.pointerId === "number" ? event.pointerId : 0;
  if (pointerIdentifier !== tutorialCardDragState.pointerIdentifier) return;
  tutorialSession.tutorialCardPosition = {
    left: tutorialCardDragState.cardStartLeft + event.clientX - tutorialCardDragState.pointerStartX,
    top: tutorialCardDragState.cardStartTop + event.clientY - tutorialCardDragState.pointerStartY,
  };
  applyTutorialCardPosition();
  updateTutorialTargetThread();
}

function finishTutorialCardDrag(event: PointerEvent): void {
  if (!tutorialCardDragState) return;
  const pointerIdentifier = typeof event.pointerId === "number" ? event.pointerId : 0;
  if (pointerIdentifier !== tutorialCardDragState.pointerIdentifier) return;
  tutorialCardDragState = null;
  tutorialLayer()?.querySelector(".tutorial-card")?.classList.remove("is-dragging");
}

function handleTutorialViewportResize(): void {
  applyTutorialCardPosition();
  updateTutorialTargetThread();
}

function tutorialTargetCandidateIsVisible(candidate: Element): boolean {
  if (candidate.closest("[hidden]")) return false;
  const style = getComputedStyle(candidate);
  return style.display !== "none" && style.visibility !== "hidden";
}

function synchroniseTutorialTarget(): Element | null {
  const nextTarget = highlightedTutorialTargetSelector
    ? Array.from(document.querySelectorAll(highlightedTutorialTargetSelector))
      .find(tutorialTargetCandidateIsVisible) || null
    : null;
  if (nextTarget === highlightedTutorialTarget) return nextTarget;
  if (highlightedTutorialTarget) highlightedTutorialTarget.classList.remove("tutorial-target");
  highlightedTutorialTarget = nextTarget;
  if (highlightedTutorialTarget) highlightedTutorialTarget.classList.add("tutorial-target");
  return highlightedTutorialTarget;
}

function tutorialTargetBounds(target: Element): DOMRect {
  const elementBounds = target.getBoundingClientRect();
  if (!(target instanceof HTMLElement) || target.childElementCount > 0 || !target.textContent?.trim()) {
    return elementBounds;
  }
  const textRange = document.createRange();
  textRange.selectNodeContents(target);
  const rangeWithBounds = textRange as Range & { getBoundingClientRect?: () => DOMRect };
  if (!rangeWithBounds.getBoundingClientRect) return elementBounds;
  const textBounds = rangeWithBounds.getBoundingClientRect();
  return textBounds.width > 0 && textBounds.height > 0 ? textBounds : elementBounds;
}

function updateTutorialTargetThread(): void {
  const layer = tutorialLayer();
  const threadPath = layer?.querySelector<SVGPathElement>(".tutorial-target-thread-path");
  const targetMarker = layer?.querySelector<SVGCircleElement>(".tutorial-target-thread-marker");
  const tutorialCard = layer?.querySelector<HTMLElement>(".tutorial-card");
  if (!threadPath || !targetMarker || !tutorialCard) return;
  const currentTarget = synchroniseTutorialTarget();
  if (!currentTarget) {
    threadPath.removeAttribute("d");
    targetMarker.removeAttribute("cx");
    targetMarker.removeAttribute("cy");
    return;
  }

  const targetBounds = tutorialTargetBounds(currentTarget);
  const cardBounds = tutorialCard.getBoundingClientRect();
  const targetCenterX = targetBounds.left + targetBounds.width / 2;
  const targetCenterY = targetBounds.top + targetBounds.height / 2;
  let cardConnectionX = Math.max(cardBounds.left + 24, Math.min(cardBounds.right - 24, targetCenterX));
  let cardConnectionY = cardBounds.top;

  if (targetCenterY > cardBounds.bottom) {
    cardConnectionY = cardBounds.bottom;
  } else if (targetCenterY >= cardBounds.top) {
    cardConnectionY = Math.max(cardBounds.top + 24, Math.min(cardBounds.bottom - 24, targetCenterY));
    if (targetCenterX < cardBounds.left) cardConnectionX = cardBounds.left;
    else if (targetCenterX > cardBounds.right) cardConnectionX = cardBounds.right;
  }

  const middleY = targetCenterY + (cardConnectionY - targetCenterY) / 2;
  threadPath.setAttribute(
    "d",
    "M " + targetCenterX + " " + targetCenterY +
    " C " + targetCenterX + " " + middleY +
    ", " + cardConnectionX + " " + middleY +
    ", " + cardConnectionX + " " + cardConnectionY,
  );
  targetMarker.setAttribute("cx", String(targetCenterX));
  targetMarker.setAttribute("cy", String(targetCenterY));
}

function trackTutorialTarget(): void {
  tutorialTargetTrackingAnimationFrame = null;
  const layer = tutorialLayer();
  if (!highlightedTutorialTargetSelector || !layer || layer.hidden) return;
  updateTutorialTargetThread();
  tutorialTargetTrackingAnimationFrame = requestAnimationFrame(trackTutorialTarget);
}

function startTutorialTargetTracking(): void {
  updateTutorialTargetThread();
  if (typeof requestAnimationFrame !== "function") return;
  tutorialTargetTrackingAnimationFrame = requestAnimationFrame(trackTutorialTarget);
}

function highlightTutorialTarget(selector: string): void {
  clearTutorialTarget();
  highlightedTutorialTargetSelector = selector;
  const target = synchroniseTutorialTarget();
  if (target) target.scrollIntoView({ block: "nearest", inline: "nearest" });
  startTutorialTargetTracking();
}

function closeTutorialSurfaces(): void {
  if (state.builder.open) closeBuilder();
  if (reviewIsOpen()) closeReview();
  if (atlasIsOpen()) closeAtlas();
  setFiltersOpen(false);
  clearSearch();
}

function enterReadingSurface(): void {
  if (state.builder.open) closeBuilder();
  if (reviewIsOpen()) closeReview();
  if (atlasIsOpen()) closeAtlas();
  if (state.simulationMode) toggleSimulationMode();
  setFiltersOpen(false);
  clearSearch();
  setUiMode("read");
}

function focusTutorialNode(identifier: string): void {
  if (nodeById[identifier]) focusNode(identifier);
  else if (NODES[0]) focusNode(NODES[0].id);
}

const ESSENTIALS_STEPS: TutorialStep[] = [
  {
    title: "Read a cause-and-effect chain",
    body: "The selected box brings its direct causes and effects into focus. Use the depth control to follow more of the thread, then click any related box to continue the story.",
    targetSelector: '[data-node-id="' + WORKSHOP_READINESS_IDENTIFIER + '"]',
    task: { instruction: "Increase the highlight depth, then select one related box.", selector: "#viz-depth-up, .node-group", events: ["click"] },
    enter: () => {
      enterReadingSurface();
      setNavigationControlMode("depth");
      focusTutorialNode(WORKSHOP_READINESS_IDENTIFIER);
    },
  },
  {
    title: "Ask a what-if question",
    body: "Simulation pins adjustable inputs to values you choose. Move Volunteer hours and watch readiness and satisfaction recalculate; Reset sliders always returns to the starting case.",
    targetSelector: '.sim-slider-row[data-node-id="' + ADJUSTABLE_INPUT_IDENTIFIER + '"]',
    enter: () => {
      closeTutorialSurfaces();
      setUiMode("read");
      if (!state.simulationMode) toggleSimulationMode();
      focusTutorialNode(ADJUSTABLE_INPUT_IDENTIFIER);
    },
    task: { instruction: "Change Volunteer time from its starting value.", selector: '.sim-slider-row[data-node-id="' + ADJUSTABLE_INPUT_IDENTIFIER + '"] input', events: ["input", "change"] },
  },
  {
    title: "Inspect how a formula works",
    body: "People reached converts effort into an absolute result and includes delayed feedback. The calculation panel names the formula, every input and any bound, so the result can be traced rather than taken on trust.",
    targetSelector: ".calc-breakdown",
    enter: () => {
      if (state.builder.open) closeBuilder();
      if (reviewIsOpen()) closeReview();
      if (atlasIsOpen()) closeAtlas();
      setUiMode("read");
      if (!state.simulationMode) toggleSimulationMode();
      focusTutorialNode(FORMULA_IDENTIFIER);
    },
  },
  {
    title: "Open the feedback loop",
    body: "Atlas condenses everything downstream of Community confidence. Its feedback tangle can be opened and played around the circle, so a long loop becomes a route you can follow.",
    targetSelector: ".feedback-navigator",
    enter: () => {
      enterReadingSurface();
      if (nodeById[FEEDBACK_START_IDENTIFIER]) {
        openAtlas(FEEDBACK_START_IDENTIFIER);
        openFirstFeedbackTangle();
      }
    },
    task: { instruction: "Pause or step the feedback animation once.", selector: "#atlas-loopctl button", events: ["click"] },
  },
  {
    title: "Find and filter the map",
    body: "Search looks across names, descriptions, rows, columns and tags. Filters can then hide rows, columns, tags or link styles without changing the underlying model.",
    targetSelector: "#search-input",
    enter: () => {
      enterReadingSurface();
      setFiltersOpen(true);
      const searchInput = document.getElementById("search-input") as HTMLInputElement | null;
      if (searchInput) {
        searchInput.value = "confidence";
        handleSearchInput();
      }
    },
    task: { instruction: "Replace the search phrase or switch one visible filter.", selector: "#search-input, .filter-chip, .sidebar-filter-toggle", events: ["input", "click"] },
  },
  {
    title: "Review the evidence",
    body: "People reached has a Calibrated formula, but Outreach effort → People reached remains a Hypothesis causal link. Review keeps those claims separate: fitting the maths does not prove the cause. Evidence labels report assurance but never alter the result.",
    targetSelector: ".review-evidence-head",
    enter: () => {
      enterReadingSurface();
      openReview();
    },
  },
  {
    title: "See how the map is built",
    body: "Edit exposes direct authoring tools. Bulk edit opens the same model as tables for changing rows, columns, tags, boxes, links, constants and evidence at scale.",
    targetSelector: ".builder-evidence-cell .evidence-editor",
    enter: () => {
      closeTutorialSurfaces();
      if (state.simulationMode) toggleSimulationMode();
      setUiMode("edit");
      openBuilder({ fromLoadedData: true });
      state.builder.step = 4;
      renderBuilder();
    },
  },
];

function enterFormulaExample(identifier: string): void {
  enterSimulationExample(identifier);
}

function enterSimulationExample(identifier: string): void {
  closeTutorialSurfaces();
  setUiMode("read");
  if (!state.simulationMode) toggleSimulationMode();
  focusTutorialNode(identifier);
}

function enterAtlasExample(identifier: string, openFeedbackLoop = false): void {
  enterReadingSurface();
  if (!nodeById[identifier]) return;
  openAtlas(identifier);
  if (openFeedbackLoop) openFirstFeedbackTangle();
}

function enterEditExample(identifier: string): void {
  closeTutorialSurfaces();
  if (state.simulationMode) toggleSimulationMode();
  setUiMode("edit");
  focusTutorialNode(identifier);
}

function enterBulkEditExample(stepNumber: number): void {
  closeTutorialSurfaces();
  if (state.simulationMode) toggleSimulationMode();
  setUiMode("edit");
  openBuilder({ fromLoadedData: true });
  state.builder.step = stepNumber;
  renderBuilder();
}

const NAVIGATION_STEPS: TutorialStep[] = [
  {
    title: "Frame the map for the question",
    body: "Use − and + for precise zoom. The percentage button alternates between fitting the map's height and width, so a tall pathway and a wide system are both one click away.",
    targetSelector: "#viz-navigation-controls",
    enter: () => {
      enterReadingSurface();
      setNavigationControlMode("zoom");
    },
    task: { instruction: "Use + or − once, then fit the other axis with the percentage button.", selector: "#viz-zoom-out, #viz-zoom-readout, #viz-zoom-in", events: ["click"] },
  },
  {
    title: "Pan without losing your place",
    body: "Drag the canvas to move through the map. In View mode you can begin that drag on a box too; a short click still selects it. Trackpads and mouse wheels scroll the same framed view.",
    targetSelector: "#viz-scroll",
    enter: () => enterReadingSurface(),
    task: { instruction: "Pan the map by dragging from the middle of any visible box.", selector: "#viz-scroll", events: ["scroll"] },
  },
  {
    title: "Follow the highlighted thread",
    body: "Select Workshop readiness, then change the depth above the detail panel. One step answers 'what directly touches this?'; deeper levels reveal the longer causal neighbourhood.",
    targetSelector: '[data-node-id="' + WORKSHOP_READINESS_IDENTIFIER + '"]',
    enter: () => {
      enterReadingSurface();
      setNavigationControlMode("depth");
      focusTutorialNode(WORKSHOP_READINESS_IDENTIFIER);
    },
    task: { instruction: "Increase the highlight depth once.", selector: "#viz-depth-up", events: ["click"] },
  },
];

const SEARCH_FILTER_STEPS: TutorialStep[] = [
  {
    title: "Jump to a named idea",
    body: "Search matches box names, descriptions, rows, columns and tags. Type a phrase, use the arrow keys to move through matches, then press Enter to centre the selected result.",
    targetSelector: "#search-input",
    enter: () => {
      enterReadingSurface();
      const searchInput = document.getElementById("search-input") as HTMLInputElement | null;
      if (searchInput) {
        searchInput.value = "confidence";
        handleSearchInput();
      }
    },
    task: { instruction: "Replace confidence with a different search term.", selector: "#search-input", events: ["input"] },
  },
  {
    title: "Reduce visual noise without deleting anything",
    body: "Filters hide rows, columns, tags, link effects and line styles. They only change the current view: the model and its calculations stay intact.",
    targetSelector: "#sidebar",
    enter: () => {
      enterReadingSurface();
      setFiltersOpen(true);
    },
    task: { instruction: "Turn one row, tag, effect or line-style filter off.", selector: ".filter-chip, .sidebar-filter-toggle", events: ["click"] },
  },
  {
    title: "Fold a row or column to keep its connections",
    body: "In View mode, click a row or column heading to fold it. Ariadne keeps a compact connector showing that hidden boxes still carry a causal route; click the heading again to expand it.",
    targetSelector: ".viz-container.floating-rows .viz-sticky-row, .viz-container:not(.floating-rows) .row-label-group",
    enter: () => enterReadingSurface(),
    task: {
      instruction: "Fold one row or column by selecting its heading.",
      selector: ".viz-container.floating-rows .viz-sticky-row, .viz-container:not(.floating-rows) .row-label-group, .viz-container.floating-columns .viz-sticky-column, .viz-container:not(.floating-columns) .col-header-group",
      events: ["click"],
    },
  },
];

const MODES_PANELS_THEME_STEPS: TutorialStep[] = [
  {
    title: "Use View mode to explore",
    body: "View mode keeps authoring controls out of the way. Click boxes to inspect causes and effects, drag to pan, and use Simulate, Review or Atlas without changing the model.",
    targetSelector: "#mode-toggle-button",
    enter: () => enterReadingSurface(),
  },
  {
    title: "Use Edit mode to change the model",
    body: "The Edit button changes to View while authoring is active. Edits affect the map and are autosaved; viewing, filtering, selecting and simulation do not rewrite its structure.",
    targetSelector: "#mode-toggle-button",
    enter: () => enterEditExample(WORKSHOP_READINESS_IDENTIFIER),
  },
  {
    title: "Make room without losing context",
    body: "The chevrons collapse the rows-and-tags panel or the details panel. Theme changes the display only and is remembered separately from the map file.",
    targetSelector: "#detail-pin",
    enter: () => enterReadingSurface(),
  },
];

const CAUSE_EFFECT_STEPS: TutorialStep[] = [
  {
    title: "Read left as causes and right as effects",
    body: "Selecting Workshop readiness highlights what drives it and what it drives. The detail panel repeats those incoming and outgoing relationships as readable lists, including effect type and strength.",
    targetSelector: "#detail-panel",
    enter: () => {
      enterReadingSurface();
      focusTutorialNode(WORKSHOP_READINESS_IDENTIFIER);
    },
  },
  {
    title: "Distinguish link direction from desirability",
    body: "Increases and decreases describe what happens to the target when the source rises. Higher-is-better and lower-is-better belong to the box, so a decreasing link is not automatically harmful.",
    targetSelector: '[data-node-id="' + WORKSHOP_READINESS_IDENTIFIER + '"]',
    enter: () => {
      enterReadingSurface();
      focusTutorialNode(WORKSHOP_READINESS_IDENTIFIER);
    },
  },
];

const SIMULATION_STEPS: TutorialStep[] = [
  {
    title: "Start with an adjustable input",
    body: "Simulate adds a slider for every adjustable starting box. Volunteer time is measured against its baseline, so 150 hours means a 1.5× input rather than an unexplained absolute replacement.",
    targetSelector: '.sim-slider-row[data-node-id="' + ADJUSTABLE_INPUT_IDENTIFIER + '"]',
    enter: () => enterSimulationExample(ADJUSTABLE_INPUT_IDENTIFIER),
    task: { instruction: "Change Volunteer time from its 100% baseline.", selector: '.sim-slider-row[data-node-id="' + ADJUSTABLE_INPUT_IDENTIFIER + '"] input', events: ["input", "change"] },
  },
  {
    title: "Read the change, not just the new number",
    body: "Select a downstream box to see its current value, change from baseline and calculation breakdown together. This makes it possible to trace why the scenario moved.",
    targetSelector: ".calc-breakdown",
    enter: () => enterSimulationExample(FORMULA_IDENTIFIER),
  },
  {
    title: "Reset before asking the next question",
    body: "Reset sliders returns every input to its baseline in one action. Use it between scenarios so one earlier experiment does not quietly affect the next.",
    targetSelector: "#sim-reset-button",
    enter: () => enterSimulationExample(ADJUSTABLE_INPUT_IDENTIFIER),
    task: { instruction: "Reset every scenario input to its starting value.", selector: "#sim-reset-button", events: ["click"] },
  },
];

const CALCULATION_TRACE_STEPS: TutorialStep[] = [
  {
    title: "Trace every input into the result",
    body: "The calculation breakdown names the rule, current inputs, constants and final value. In Simulation it also shows which min() input gates a bottleneck and whether a bound changed the raw result.",
    targetSelector: ".calc-breakdown",
    enter: () => enterSimulationExample("delivery_capacity"),
  },
  {
    title: "Treat division by zero as a model decision",
    body: "A ratio needs a meaningful denominator. Ariadne falls back to 0 for division by zero and shows a diagnostic in Simulation, rather than letting a non-finite value spread through the map. Decide whether 0 is meaningful for this scenario before trusting it.",
    targetSelector: ".calc-breakdown",
    enter: () => enterFormulaExample("registration_share"),
  },
  {
    title: "Read a bound as part of the rule",
    body: "The raw value and final bounded value are both shown. Bounds are appropriate for genuine limits such as a 0–1 share; repeated clipping during normal scenarios is a prompt to inspect the formula.",
    targetSelector: ".calc-breakdown",
    enter: () => enterSimulationExample("registration_share"),
  },
];

const MULTIPLIER_FORMULA_STEPS: TutorialStep[] = [
  {
    title: "Know which calculation path wins",
    body: "An explicit formula takes precedence over link Strength and Combine. Without a formula, Ariadne combines incoming link effects; a box with no incoming calculation stays at its baseline or adjustable scenario value.",
    targetSelector: ".calc-breakdown",
    enter: () => enterFormulaExample(FORMULA_IDENTIFIER),
  },
  {
    title: "Use a multiplier for proportional influence",
    body: "Workshop readiness combines several influences proportionally. A 10% change in an input contributes a strength-weighted percentage change, which is useful when direction and relative sensitivity are known but an absolute equation is not.",
    targetSelector: ".calc-breakdown",
    enter: () => enterFormulaExample(WORKSHOP_READINESS_IDENTIFIER),
  },
  {
    title: "Choose a formula for defined units",
    body: "People reached uses outreach_effort × people_reached_per_hour × feedback_uplift. Use an explicit formula when inputs have meaningful units, known rates, thresholds or arithmetic that a generic multiplier would hide.",
    targetSelector: ".calc-breakdown",
    enter: () => enterFormulaExample(FORMULA_IDENTIFIER),
  },
  {
    title: "Multiply shares when every condition must hold",
    body: "Completed follow-ups multiplies people served by the completion share and follow-up readiness share. A joint product fits a sequence where every condition is required; adding the shares would count people who did not pass through the whole sequence.",
    targetSelector: ".calc-breakdown",
    enter: () => enterFormulaExample("completed_follow_ups"),
  },
  {
    title: "Keep mathematical fit separate from causal evidence",
    body: "The People reached formula is Calibrated, while the link from Outreach effort remains a Hypothesis. A formula can reproduce observations without proving that changing the input will cause the predicted outcome.",
    targetSelector: ".evidence-editor--formula",
    enter: () => enterEditExample(FORMULA_IDENTIFIER),
  },
];

const STRENGTH_COMBINE_STEPS: TutorialStep[] = [
  {
    title: "Set Strength as relative sensitivity",
    body: "A Strength of 0.35 means a 10% source change contributes roughly a 3.5% target change before other influences combine. It is dimensionless sensitivity, not a direct conversion rate.",
    targetSelector: "#detail-panel",
    enter: () => enterEditExample(WORKSHOP_READINESS_IDENTIFIER),
  },
  {
    title: "Use multiplicative for reinforcing percentages",
    body: "Workshop readiness combines proportional factors multiplicatively. It suits independent percentage effects and preserves a neutral 1× baseline for each incoming influence.",
    targetSelector: ".calc-breakdown",
    enter: () => enterFormulaExample(WORKSHOP_READINESS_IDENTIFIER),
  },
  {
    title: "Use additive for separate contributions",
    body: "Community confidence adds the strength-weighted relative deviations of satisfaction, participation and access barriers from their baselines. Use Additive when those relative contributions accumulate rather than scaling one another.",
    targetSelector: ".calc-breakdown",
    enter: () => enterFormulaExample(FEEDBACK_START_IDENTIFIER),
  },
  {
    title: "Use Combine = Minimum for prerequisite gating",
    body: "Delivery capacity has no explicit min() formula: its Combine setting is Minimum, so it follows the weakest incoming proportional factor. Use this when every prerequisite is necessary and the scarcest one sets the ceiling.",
    targetSelector: ".calc-breakdown",
    enter: () => enterFormulaExample("delivery_capacity"),
  },
];

const EMPIRICAL_CAUSAL_STEPS: TutorialStep[] = [
  {
    title: "Use empirical formulas before causality is settled",
    body: "A fitted equation can be useful for estimation and scenario comparison even when its causal links are still hypotheses. Label that distinction instead of discarding the empirical relationship or overstating what it proves.",
    targetSelector: ".calc-breakdown",
    enter: () => enterFormulaExample(FORMULA_IDENTIFIER),
  },
  {
    title: "Record two different kinds of evidence",
    body: "Formula status answers whether the mathematical form and parameters are supported. Link status answers whether changing the source is believed to cause the target to change. Neither status changes the calculation.",
    targetSelector: ".review-evidence-head",
    enter: () => {
      enterReadingSurface();
      openReview();
    },
  },
];

const CAPACITY_FORMULA_STEPS: TutorialStep[] = [
  {
    title: "Use Combine = Minimum when an influence gates the result",
    body: "Delivery capacity cannot exceed either facilitator capacity or venue availability. Its Minimum combine rule makes the active proportional bottleneck explicit; averaging those inputs would invent capacity that does not exist.",
    targetSelector: ".calc-breakdown",
    enter: () => enterFormulaExample("delivery_capacity"),
  },
  {
    title: "Cap demand with available capacity",
    body: "Registrations uses min(reach × registration rate, capacity × seats). This is the right shape when demand and supply are independently estimated but the realised result cannot exceed either side.",
    targetSelector: ".calc-breakdown",
    enter: () => enterFormulaExample("registrations"),
  },
  {
    title: "Use max() for a non-negative remainder",
    body: "Unserved interest subtracts people served from registered and walk-in interest, then uses max(balance, 0). This represents a real remainder that cannot become negative without hiding which terms create the balance.",
    targetSelector: ".calc-breakdown",
    enter: () => enterFormulaExample("unserved_interest"),
  },
];

const RATIO_BOUND_FORMULA_STEPS: TutorialStep[] = [
  {
    title: "Use a ratio for a share or rate",
    body: "Registration share divides registrations by people reached. Ratios answer 'what fraction?' and must use compatible quantities; a multiplier cannot express the changing denominator.",
    targetSelector: ".calc-breakdown",
    enter: () => enterFormulaExample("registration_share"),
  },
  {
    title: "Use clamp() for a real boundary",
    body: "A share cannot be below 0 or above 1, so clamp(ratio, 0, 1) protects the semantic range. Bounds should represent the world or the measurement, not conceal a formula that behaves badly.",
    targetSelector: ".calc-breakdown",
    enter: () => enterFormulaExample("registration_share"),
  },
];

const DELAY_FEEDBACK_FORMULA_STEPS: TutorialStep[] = [
  {
    title: "Use delay() when an effect arrives later",
    body: "Confidence feedback reads the previous solver pass of Community confidence. delay() breaks the instant circular dependency, but a solver pass is not an elapsed-time period.",
    targetSelector: ".calc-breakdown",
    enter: () => enterFormulaExample("feedback_uplift"),
  },
  {
    title: "Inspect the whole cycle in Atlas",
    body: "Open the feedback tangle to see how confidence, outreach, participation and experience return to confidence. Play the route slowly or pause and step through it so the loop is read as a sequence.",
    targetSelector: ".feedback-navigator",
    enter: () => enterAtlasExample(FEEDBACK_START_IDENTIFIER, true),
    task: { instruction: "Pause the route, then move one step forward or back.", selector: "#atlas-loopctl button", events: ["click"] },
  },
  {
    title: "Treat feedback as a dynamic hypothesis",
    body: "Delays and feedback strengths need a defensible time period and sensitivity checks. Test several plausible settings; convergence only means the maths settled, not that the causal story is true.",
    targetSelector: "#atlas-loopctl",
    enter: () => enterAtlasExample(FEEDBACK_START_IDENTIFIER, true),
    task: { instruction: "Change the speed or scrub to another animation position.", selector: "#atlas-loopctl select, #atlas-loopctl input", events: ["input", "change"] },
  },
];

const EDITING_STEPS: TutorialStep[] = [
  {
    title: "Switch from reading to editing",
    body: "Edit mode changes the map itself. Select a box to change its name, description, placement, tags, values, formula, evidence and outgoing links in the detail panel.",
    targetSelector: "#detail-panel",
    enter: () => enterEditExample(WORKSHOP_READINESS_IDENTIFIER),
    task: { instruction: "Change the box description or another editable field.", selector: "#detail-panel .detail-edit-input", events: ["input", "change"] },
  },
  {
    title: "Add and connect boxes on the canvas",
    body: "Click an empty cell to add a box. Drag from the right edge of a box to another box to add a link; select boxes or links before deleting, and use undo if the structure is not what you intended.",
    targetSelector: "#viz-scroll",
    enter: () => enterEditExample(WORKSHOP_READINESS_IDENTIFIER),
    task: { instruction: "Click an empty cell and give the temporary box a name.", selector: "#viz-scroll", events: ["click", "keydown"] },
  },
  {
    title: "Use Bulk edit for map-wide work",
    body: "Bulk edit exposes rows, columns, tags, constants, boxes and links as structured tables. It is faster for repeated changes and lets you validate the whole model before returning to the canvas.",
    targetSelector: ".builder-step-heading",
    enter: () => enterBulkEditExample(4),
  },
];

const CANVAS_EDIT_STEPS: TutorialStep[] = [
  {
    title: "Create a box in an empty cell",
    body: "In Edit mode, click an empty map cell and name the new box. Its row and column come from that cell; use the detail panel to add meaning, values and tags.",
    targetSelector: "#viz-scroll",
    enter: () => enterEditExample(WORKSHOP_READINESS_IDENTIFIER),
  },
  {
    title: "Move, rename and remove with the keyboard",
    body: "Drag a selected box to move it. Start typing to replace its name; Enter commits any rename and creates another box below. Delete removes a selected box with connected links. Command/Ctrl+Z and Command/Ctrl+Shift+Z undo and redo.",
    targetSelector: '[data-node-id="' + WORKSHOP_READINESS_IDENTIFIER + '"]',
    enter: () => enterEditExample(WORKSHOP_READINESS_IDENTIFIER),
    task: { instruction: "Start typing a temporary new name, then press Escape to cancel it.", selector: "body", events: ["keydown"] },
  },
];

const LINK_EDIT_STEPS: TutorialStep[] = [
  {
    title: "Draw a link from cause to effect",
    body: "Drag from a box's right-edge handle to its effect. Ariadne opens the new outgoing link in the detail panel so you can immediately confirm direction and meaning.",
    targetSelector: '[data-node-id="' + WORKSHOP_READINESS_IDENTIFIER + '"]',
    enter: () => enterEditExample(WORKSHOP_READINESS_IDENTIFIER),
    task: { instruction: "Drag from the selected box's right-edge handle to another box.", selector: ".edge-handle", events: ["mouseup"] },
  },
  {
    title: "Edit the relationship, not just the line",
    body: "Expand an outgoing link to choose increases, decreases or enables; set Strength, solid or dashed style, a description and causal evidence. Delete removes only that relationship.",
    targetSelector: "#detail-panel",
    enter: () => enterEditExample(WORKSHOP_READINESS_IDENTIFIER),
    task: { instruction: "Expand one outgoing link and change its line style or description.", selector: "#detail-panel .drow, #detail-panel [data-edge-field]", events: ["click", "input", "change"] },
  },
];

const DIMENSION_CATEGORY_STEPS: TutorialStep[] = [
  {
    title: "Make rows describe domains or flows",
    body: "Rows organise boxes by responsibility, workstream or system domain. Bulk edit lets you rename, recolour, reorder, add and remove them while showing which boxes each change affects.",
    targetSelector: ".builder-step-heading",
    enter: () => enterBulkEditExample(1),
  },
  {
    title: "Make columns describe progression",
    body: "Columns usually move from inputs through activities to outcomes. Use them for a sequence readers can recognise, then place each box at the intersection of its domain and stage.",
    targetSelector: ".builder-step-heading",
    enter: () => enterBulkEditExample(2),
  },
  {
    title: "Use categories for meaning, not decoration",
    body: "Primary categories set a box's fill; secondary categories add tags. Keep the set small and name the distinction readers need to make, such as resource, activity, outcome or access consideration.",
    targetSelector: ".builder-step-heading",
    enter: () => enterBulkEditExample(3),
  },
];

const MULTI_SELECT_STEPS: TutorialStep[] = [
  {
    title: "Select several boxes",
    body: "Shift-click boxes to build a selection, or Shift-drag on empty canvas to draw a marquee. Dragging any selected box then moves the whole group together.",
    targetSelector: "#multi-select-bar",
    enter: () => {
      enterEditExample(WORKSHOP_READINESS_IDENTIFIER);
      setSelection([WORKSHOP_READINESS_IDENTIFIER, "delivery_capacity", "outreach_reach"], WORKSHOP_READINESS_IDENTIFIER);
      renderMultiSelectBar();
    },
    task: { instruction: "Shift-click another box or draw a Shift-drag marquee.", selector: ".node-group, #viz-scroll", events: ["click", "mouseup"] },
  },
  {
    title: "Change the group in one undo step",
    body: "The selection bar can set one category, row or column for every selected box, or delete the group with its links. One undo restores the entire batch.",
    targetSelector: "#multi-select-bar",
    enter: () => {
      enterEditExample(WORKSHOP_READINESS_IDENTIFIER);
      setSelection([WORKSHOP_READINESS_IDENTIFIER, "delivery_capacity", "outreach_reach"], WORKSHOP_READINESS_IDENTIFIER);
      renderMultiSelectBar();
    },
    task: { instruction: "Use the selection bar to move the group to a different row or column.", selector: "#multi-select-bar select", events: ["change"] },
  },
];

const BULK_EDIT_STEPS: TutorialStep[] = [
  {
    title: "Edit repeated fields as a table",
    body: "Bulk edit is best for many rows at once: sort, select and update boxes or links without opening each detail panel. Constants have their own step because formulas refer to them by stable identifier.",
    targetSelector: ".builder-step-heading",
    enter: () => enterBulkEditExample(4),
  },
  {
    title: "Finish only when validation is clear",
    body: "The final step summarises the model and blocks invalid references. You can move back through the steps without losing the working copy; closing Bulk edit preserves the draft for later.",
    targetSelector: ".builder-step-heading",
    enter: () => enterBulkEditExample(7),
  },
];

const ATLAS_STEPS: TutorialStep[] = [
  {
    title: "Choose the question's starting box",
    body: "Atlas shows every pathway downstream from one starting box. Start from Community confidence here; on your own map, select a box first or choose a suggested starting point from the Atlas menu.",
    targetSelector: "#atlas-stage",
    enter: () => enterAtlasExample(FEEDBACK_START_IDENTIFIER),
  },
  {
    title: "Move from overview to one pathway",
    body: "The Atlas overview groups downstream routes. Select a pathway or feedback tangle to focus it, then use the navigator to move through boxes without losing the larger structure.",
    targetSelector: ".atlaswrap",
    enter: () => enterAtlasExample(FEEDBACK_START_IDENTIFIER),
    task: { instruction: "Select a pathway or feedback tangle in the Atlas picture.", selector: ".atlas [data-box], .atlas [data-loop], .atlas [data-group]", events: ["click"] },
  },
  {
    title: "Play and scrub a feedback route",
    body: "In a feedback tangle, Play progressively reveals each box and link. Change the speed, pause, or scrub the position to inspect a long loop at your own pace.",
    targetSelector: ".feedback-navigator",
    enter: () => enterAtlasExample(FEEDBACK_START_IDENTIFIER, true),
    task: { instruction: "Pause, step, change speed or scrub the feedback route.", selector: "#atlas-loopctl button, #atlas-loopctl select, #atlas-loopctl input", events: ["click", "input", "change"] },
  },
];

const REVIEW_EVIDENCE_STEPS: TutorialStep[] = [
  {
    title: "Separate model warnings from assurance",
    body: "Review brings loader findings, behavioural checks and evidence provenance together. Warnings indicate something to inspect; Hypothesis and Unspecified evidence are information, not calculation errors.",
    targetSelector: "#review-stage",
    enter: () => {
      enterReadingSurface();
      openReview();
    },
  },
  {
    title: "Compare formula and link evidence",
    body: "Formula evidence supports the mathematical form or parameters. Link evidence supports the causal claim. Filter the evidence inventory to find assumptions that need research, calibration or validation.",
    targetSelector: ".review-evidence-head",
    enter: () => {
      enterReadingSurface();
      openReview();
    },
    task: { instruction: "Filter the evidence inventory to one assurance status.", selector: "#review-evidence-filter", events: ["change"] },
  },
  {
    title: "Record provenance where it belongs",
    body: "In Edit mode, each formula and link can carry a status, rationale, source and last-reviewed date. Those fields travel with the CSV and remain visible to reviewers without cluttering the map itself.",
    targetSelector: ".evidence-editor--formula",
    enter: () => enterEditExample(FORMULA_IDENTIFIER),
  },
];

const SENSITIVITY_SWEEP_STEPS: TutorialStep[] = [
  {
    title: "Nudge one adjustable input at a time",
    body: "Review's sensitivity sweep raises each adjustable input by the same percentage while every other input stays at baseline. It reports what moved, how far the input reached, and where a gate stopped the change.",
    targetSelector: "#review-fold-toggle",
    enter: () => {
      enterReadingSurface();
      openReview();
    },
    task: { instruction: "Open the full sensitivity list and compare the reach of two inputs.", selector: "#review-fold-toggle", events: ["click"] },
  },
  {
    title: "Use sensitivity as a diagnostic, not proof",
    body: "An input that moves nothing may be gated, disconnected or intentionally dormant. An input that dominates may be correct or may have excessive Strength. The sweep tests model behaviour, not causal truth.",
    targetSelector: "#review-fold-toggle",
    enter: () => {
      enterReadingSurface();
      openReview();
    },
  },
];

function enterAutomaticReviewExample(): void {
  enterReadingSurface();
  const ratioNode = nodeById.registration_share;
  if (ratioNode && ratioNode.formula !== "missing_tutorial_input + 1") {
    ratioNode.formula = "missing_tutorial_input + 1";
    applyCanvasMutation({ impact: "calculation", searchableDataChanged: true });
  }
  openReview();
}

const AUTOMATIC_REVIEW_STEPS: TutorialStep[] = [
  {
    title: "Let Review find mechanical problems",
    body: "This lesson temporarily gives Registration share a broken reference. Review catches malformed or deactivated rules, baseline drift, bounds that change the resting value, formula-arrow mismatches and other consistency problems.",
    targetSelector: "#review-stage",
    enter: () => enterAutomaticReviewExample(),
  },
  {
    title: "Inspect consequences before applying a proposal",
    body: "A finding explains what was detected and can show repair choices. Open the affected box on the map to inspect its context; automatic checks are leads, not permission to change the model blindly.",
    targetSelector: ".review-card",
    enter: () => enterAutomaticReviewExample(),
  },
];

const HUMAN_REVIEW_STEPS: TutorialStep[] = [
  {
    title: "Start a signed box-by-box pass",
    body: "Enter your full name, then start the pass. Ariadne asks whether each box has the right and complete set of causes, moving through the model in a consistent order.",
    targetSelector: "#review-start-pass",
    enter: () => {
      enterReadingSurface();
      openReview();
    },
    task: { instruction: "Enter your full name and start the review pass.", selector: "#review-reviewer, #review-start-pass", events: ["input", "click"], verify: () => !!state.reviewPass },
  },
  {
    title: "Agree, flag or skip with a note",
    body: "Agree records confidence, Flag keeps the box in the work queue, and Skip moves on without a verdict. Notes, reviewer, date and later resolution travel with the map; changed boxes become stale and return to review.",
    targetSelector: "#review-stage",
    enter: () => {
      enterReadingSurface();
      openReview();
    },
  },
];

const IMPORT_EXPORT_STEPS: TutorialStep[] = [
  {
    title: "Bring in a complete map spreadsheet",
    body: "Import opens an Ariadne CSV, and dragging the file onto the window does the same thing. Export a Spreadsheet first when you need a schema example to edit in Excel or Sheets.",
    targetSelector: ".header-document-actions",
    enter: () => {
      enterReadingSurface();
      setExportMenuOpen(false);
    },
  },
  {
    title: "Choose an export for its audience",
    body: "Spreadsheet is the editable source, Review log records assurance work, Image captures the framed view, and Web page creates a self-contained view-only map with pan, zoom and hover.",
    targetSelector: "#export-menu",
    enter: () => {
      enterReadingSurface();
      setExportMenuOpen(true);
    },
  },
];

const AUTOSAVE_IMPORT_STEPS: TutorialStep[] = [
  {
    title: "Know what the browser remembers",
    body: "Ariadne autosaves the current map, view choices and unfinished Bulk edit draft in this browser. Autosave is convenient recovery, not a substitute for downloading the Spreadsheet source before important work or moving devices.",
    targetSelector: ".header-document-actions",
    enter: () => {
      enterReadingSurface();
      setExportMenuOpen(false);
    },
  },
  {
    title: "Import deliberately",
    body: "Import or drag-and-drop replaces the current in-memory map after validation. Download the current Spreadsheet first when it is the copy you need to keep.",
    targetSelector: ".import-data-trigger",
    enter: () => {
      enterReadingSurface();
      setExportMenuOpen(false);
    },
  },
];

const CSV_FORMAT_STEPS: TutorialStep[] = [
  {
    title: "Use the Spreadsheet as the editable source",
    body: "The CSV contains named sections for rows, columns, categories, defaults, constants, boxes, links and review records. Formula and link evidence round-trip in their own columns.",
    targetSelector: ".save-data-trigger",
    enter: () => {
      enterReadingSurface();
      setExportMenuOpen(true);
    },
  },
  {
    title: "Import a useful subset when building gradually",
    body: "Sections are independently readable where their references remain valid. Start with dimensions and boxes, add links and constants later, and use Review to surface unresolved identifiers or calculation rules.",
    targetSelector: ".save-data-trigger",
    enter: () => {
      enterReadingSurface();
      setExportMenuOpen(true);
    },
  },
];

const SHARE_FORMAT_STEPS: TutorialStep[] = [
  {
    title: "Export an image of the framed view",
    body: "Image captures the map as currently zoomed, panned and filtered. Clipboard image copy needs a secure browser context such as HTTPS or localhost and may fail from a downloaded file:// copy; frame the story before exporting.",
    targetSelector: ".export-image-trigger",
    enter: () => {
      enterReadingSurface();
      setExportMenuOpen(true);
    },
  },
  {
    title: "Export a view-only interactive web page",
    body: "Web page creates one self-contained HTML file. Recipients can pan, zoom and hover without editing or needing Ariadne installed; send the Spreadsheet too if they must continue the model.",
    targetSelector: ".publish-html-trigger",
    enter: () => {
      enterReadingSurface();
      setExportMenuOpen(true);
    },
  },
];

const REVIEW_LOG_STEPS: TutorialStep[] = [
  {
    title: "Export the assurance record",
    body: "Review log creates a CSV of every box, its verdict, reviewer, date, comments and whether a flag was addressed. It is for governance and follow-up; it does not replace the model Spreadsheet.",
    targetSelector: ".export-review-log-trigger",
    enter: () => {
      enterReadingSurface();
      setExportMenuOpen(true);
    },
  },
];

export const LEARN_LESSONS: LearnLesson[] = [
  { id: FIRST_LESSON_ID, groupId: "read-navigate", title: "Quick start: follow the whole thread", summary: "A short route through reading, simulation, formulas, feedback, evidence and editing.", duration: "7 steps · about 6 minutes", steps: ESSENTIALS_STEPS },
  { id: "modes-panels-theme", groupId: "read-navigate", title: "Modes, panels and theme", summary: "Know what changes the model and shape the workspace around your task.", duration: "3 steps · about 3 minutes", steps: MODES_PANELS_THEME_STEPS },
  { id: "cause-and-effect", groupId: "read-navigate", title: "Read cause and effect", summary: "Follow direction, effect type and desirability without confusing them.", duration: "2 steps · about 3 minutes", steps: CAUSE_EFFECT_STEPS },
  { id: "navigate-and-frame", groupId: "read-navigate", title: "Navigate and frame the map", summary: "Zoom, fit, pan from the canvas or a box, and follow a neighbourhood.", duration: "3 steps · about 3 minutes", steps: NAVIGATION_STEPS },
  { id: "search-and-filter", groupId: "read-navigate", title: "Search, filter and fold", summary: "Find concepts and simplify the view without changing the model.", duration: "3 steps · about 3 minutes", steps: SEARCH_FILTER_STEPS },

  { id: "simulate-change", groupId: "simulate-atlas", title: "Simulate a change", summary: "Set inputs, trace downstream movement and reset between scenarios.", duration: "3 steps · about 4 minutes", steps: SIMULATION_STEPS },
  { id: "calculation-trace", groupId: "simulate-atlas", title: "Trace calculations", summary: "Read inputs, gates, bounds and invalid arithmetic in context.", duration: "3 steps · about 4 minutes", steps: CALCULATION_TRACE_STEPS },
  { id: "atlas-pathways", groupId: "simulate-atlas", title: "Explore pathways in Atlas", summary: "Move from a downstream overview into one pathway or tangle.", duration: "3 steps · about 4 minutes", steps: ATLAS_STEPS },
  { id: "feedback-playback", groupId: "simulate-atlas", title: "Play a feedback route", summary: "Reveal, pause, change speed and scrub through a long loop.", duration: "3 steps · about 4 minutes", steps: DELAY_FEEDBACK_FORMULA_STEPS },

  { id: "formula-or-multiplier", groupId: "maths", title: "Choose the calculation path", summary: "Understand precedence and choose proportional influence or a formula.", duration: "5 steps · about 6 minutes", steps: MULTIPLIER_FORMULA_STEPS },
  { id: "strength-and-combine", groupId: "maths", title: "Strength and Combine", summary: "Use relative sensitivity, additive contributions, scaling or gating.", duration: "4 steps · about 5 minutes", steps: STRENGTH_COMBINE_STEPS },
  { id: "formula-capacity-limits", groupId: "maths", title: "Capacity, balances and limits", summary: "Use Minimum combine or min() for bottlenecks, and max() for a non-negative remainder.", duration: "3 steps · about 4 minutes", steps: CAPACITY_FORMULA_STEPS },
  { id: "formula-ratios-bounds", groupId: "maths", title: "Ratios and real bounds", summary: "Model shares and use clamp() for meaningful ranges.", duration: "2 steps · about 3 minutes", steps: RATIO_BOUND_FORMULA_STEPS },
  { id: "formula-delays-feedback", groupId: "maths", title: "Delays and dynamic feedback", summary: "Represent later effects and test the loop they create.", duration: "3 steps · about 4 minutes", steps: DELAY_FEEDBACK_FORMULA_STEPS },
  { id: "empirical-and-causal", groupId: "maths", title: "Empirical fit and causal evidence", summary: "Use fitted maths without overstating an untested causal claim.", duration: "2 steps · about 3 minutes", steps: EMPIRICAL_CAUSAL_STEPS },

  { id: "edit-map", groupId: "build-edit", title: "Edit a box", summary: "Change placement, meaning, values, formula, evidence and outgoing links.", duration: "3 steps · about 5 minutes", steps: EDITING_STEPS },
  { id: "canvas-create-move-delete", groupId: "build-edit", title: "Create, move and delete", summary: "Author directly on the canvas with keyboard shortcuts and undo.", duration: "2 steps · about 4 minutes", steps: CANVAS_EDIT_STEPS },
  { id: "create-edit-links", groupId: "build-edit", title: "Create and edit links", summary: "Draw a cause-to-effect link and document its behaviour.", duration: "2 steps · about 3 minutes", steps: LINK_EDIT_STEPS },
  { id: "dimensions-categories", groupId: "build-edit", title: "Rows, columns and categories", summary: "Give the map a structure readers can recognise.", duration: "3 steps · about 4 minutes", steps: DIMENSION_CATEGORY_STEPS },
  { id: "multi-select", groupId: "build-edit", title: "Select and change a group", summary: "Marquee or Shift-select boxes, then move or update them together.", duration: "2 steps · about 3 minutes", steps: MULTI_SELECT_STEPS },
  { id: "bulk-edit", groupId: "build-edit", title: "Use Bulk edit", summary: "Make repeated changes, manage constants and validate the whole map.", duration: "2 steps · about 4 minutes", steps: BULK_EDIT_STEPS },

  { id: "automatic-review", groupId: "review", title: "Investigate automatic findings", summary: "Use a temporary broken rule to learn how Review detects and explains problems.", duration: "2 steps · about 4 minutes", steps: AUTOMATIC_REVIEW_STEPS },
  { id: "sensitivity-sweep", groupId: "review", title: "Run a sensitivity sweep", summary: "Nudge each adjustable input equally and inspect reach, gates and dominance.", duration: "2 steps · about 3 minutes", steps: SENSITIVITY_SWEEP_STEPS },
  { id: "review-evidence", groupId: "review", title: "Review evidence", summary: "Separate warnings from mathematical or causal assurance records.", duration: "3 steps · about 4 minutes", steps: REVIEW_EVIDENCE_STEPS },
  { id: "human-review-pass", groupId: "review", title: "Run a human review pass", summary: "Sign, assess and record whether each box has the right causes.", duration: "2 steps · about 4 minutes", steps: HUMAN_REVIEW_STEPS },

  { id: "autosave-import", groupId: "files", title: "Autosave and import safely", summary: "Know what the browser remembers and preserve work before replacement.", duration: "2 steps · about 3 minutes", steps: AUTOSAVE_IMPORT_STEPS },
  { id: "csv-source", groupId: "files", title: "Work with the CSV source", summary: "Understand sections, references, evidence fields and gradual imports.", duration: "2 steps · about 3 minutes", steps: CSV_FORMAT_STEPS },
  { id: "image-view-only", groupId: "files", title: "Share an image or web page", summary: "Choose a framed picture or an interactive view-only HTML file.", duration: "2 steps · about 3 minutes", steps: SHARE_FORMAT_STEPS },
  { id: "review-log", groupId: "files", title: "Export the review log", summary: "Take the signed assurance record out separately from the model.", duration: "1 step · about 2 minutes", steps: REVIEW_LOG_STEPS },
];

export const TUTORIAL_STEPS = ESSENTIALS_STEPS;

const LEARN_GROUPS: Array<{ id: LearnGroupId; title: string; description: string }> = [
  { id: "read-navigate", title: "Read and navigate", description: "Understand the map, move through it and control what is visible." },
  { id: "simulate-atlas", title: "Simulate and explore", description: "Ask what-if questions, trace calculations and follow pathways." },
  { id: "maths", title: "Choose the maths", description: "Match proportional links and formula shapes to the scenario." },
  { id: "build-edit", title: "Build and edit", description: "Create, connect and restructure the model safely." },
  { id: "review", title: "Review and assure", description: "Find mechanical problems and record human or empirical assurance." },
  { id: "files", title: "Save and share", description: "Preserve the editable source and choose an export for its audience." },
];

function currentLesson(): LearnLesson {
  const lessonIdentifier = tutorialSession?.currentLessonId || FIRST_LESSON_ID;
  return LEARN_LESSONS.find(lesson => lesson.id === lessonIdentifier) || LEARN_LESSONS[0];
}

function emptyLearnProgress(): LearnProgress {
  return { completedLessonIds: [], lastLessonId: null, lastStepIndex: 0 };
}

export function loadLearnProgress(): LearnProgress {
  try {
    const storedProgress = localStorage.getItem(LEARN_PROGRESS_KEY);
    if (!storedProgress) return emptyLearnProgress();
    const parsedProgress = JSON.parse(storedProgress) as Partial<LearnProgress>;
    const knownLessonIdentifiers = new Set(LEARN_LESSONS.map(lesson => lesson.id));
    return {
      completedLessonIds: Array.isArray(parsedProgress.completedLessonIds)
        ? parsedProgress.completedLessonIds.filter(identifier => knownLessonIdentifiers.has(identifier))
        : [],
      lastLessonId: typeof parsedProgress.lastLessonId === "string" && knownLessonIdentifiers.has(parsedProgress.lastLessonId)
        ? parsedProgress.lastLessonId : null,
      lastStepIndex: Number.isInteger(parsedProgress.lastStepIndex)
        ? Math.max(0, parsedProgress.lastStepIndex as number) : 0,
    };
  } catch (_) {
    return emptyLearnProgress();
  }
}

function saveLearnProgress(progress: LearnProgress): void {
  try { localStorage.setItem(LEARN_PROGRESS_KEY, JSON.stringify(progress)); }
  catch (_) {}
}

function rememberLessonPosition(lessonIdentifier: string, stepIndex: number): void {
  const progress = loadLearnProgress();
  progress.lastLessonId = lessonIdentifier;
  progress.lastStepIndex = stepIndex;
  saveLearnProgress(progress);
}

function markLessonCompleted(lessonIdentifier: string): void {
  const progress = loadLearnProgress();
  if (!progress.completedLessonIds.includes(lessonIdentifier)) {
    progress.completedLessonIds.push(lessonIdentifier);
  }
  progress.lastLessonId = lessonIdentifier;
  progress.lastStepIndex = 0;
  saveLearnProgress(progress);
}

function lessonCardMarkup(lesson: LearnLesson, progress: LearnProgress): string {
  const completed = progress.completedLessonIds.includes(lesson.id);
  const resumable = progress.lastLessonId === lesson.id && !completed && progress.lastStepIndex > 0;
  const progressLabel = completed ? "Completed" : resumable ? "In progress" : "Not started";
  const actionLabel = completed ? "Review lesson" : resumable ? "Resume" : "Start lesson";
  return '<article class="learn-lesson-card' + (completed ? " is-complete" : "") + '" data-lesson-card="' + lesson.id + '">' +
    '<div class="learn-lesson-status"><span class="learn-lesson-knot" aria-hidden="true"></span>' + progressLabel + "</div>" +
    "<h3>" + lesson.title + "</h3><p>" + lesson.summary + "</p>" +
    '<div class="learn-lesson-meta">' + lesson.duration + "</div>" +
    '<button class="tutorial-button' + (resumable ? " tutorial-button--primary" : "") + '" data-tutorial-action="lesson" data-lesson-id="' + lesson.id + '">' + actionLabel + "</button>" +
    (completed ? '<button class="learn-restart-link" data-tutorial-action="restart-lesson" data-lesson-id="' + lesson.id + '">Restart</button>' : "") +
    "</article>";
}

function learnThreadMarkup(progress: LearnProgress): string {
  return '<div class="learn-library-thread" style="--learn-lesson-count:' + LEARN_LESSONS.length + '" aria-hidden="true">' + LEARN_LESSONS.map(lesson => {
    const completed = progress.completedLessonIds.includes(lesson.id);
    return '<span class="learn-library-knot' + (completed ? " is-complete" : "") + '"></span>';
  }).join("") + "</div>";
}

export function openLearnHub(): boolean {
  if (tutorialSession) exitTutorial({ markDismissed: false });
  setExportMenuOpen(false);
  const layer = tutorialLayer();
  if (!layer) return false;
  const progress = loadLearnProgress();
  const completedCount = progress.completedLessonIds.length;
  const groupsMarkup = LEARN_GROUPS.map(group => {
    const lessons = LEARN_LESSONS.filter(lesson => lesson.groupId === group.id);
    return '<section class="learn-group" id="learn-group-' + group.id + '" data-learn-group="' + group.id + '">' +
      '<div class="learn-group-heading"><h2>' + group.title + "</h2><p>" + group.description + "</p></div>" +
      '<div class="learn-lesson-list">' + lessons.map(lesson => lessonCardMarkup(lesson, progress)).join("") + "</div></section>";
  }).join("");
  const curriculumRailMarkup = '<nav class="learn-curriculum-rail" aria-label="Learning sections"><div class="learn-rail-label">Curriculum</div>' +
    LEARN_GROUPS.map(group => {
      const lessonCount = LEARN_LESSONS.filter(lesson => lesson.groupId === group.id).length;
      const completedInGroup = LEARN_LESSONS.filter(lesson => lesson.groupId === group.id && progress.completedLessonIds.includes(lesson.id)).length;
      return '<a href="#learn-group-' + group.id + '"><span>' + group.title + '</span><small>' + completedInGroup + " / " + lessonCount + "</small></a>";
    }).join("") +
    '<p>Lessons borrow the example map only while they are open. Exiting restores your exact map and view.</p></nav>';
  layer.hidden = false;
  layer.innerHTML = '<div class="learn-backdrop"><section class="learn-library" role="dialog" aria-modal="true" aria-label="Learn Ariadne Maps">' +
    '<header class="learn-library-header"><div><div class="tutorial-kicker">Learn Ariadne Maps</div>' +
    '<h1>Choose a thread to follow.</h1><p>Every lesson uses a temporary community-programme map. Your map returns exactly as you left it.</p></div>' +
    '<button class="learn-close" data-tutorial-action="close-learn" aria-label="Close Learn">×</button></header>' +
    '<div class="learn-library-progress"><span>' + completedCount + " of " + LEARN_LESSONS.length + " lessons complete</span>" +
    learnThreadMarkup(progress) + "</div>" +
    '<div class="learn-library-body">' + curriculumRailMarkup +
    '<main class="learn-library-groups">' + groupsMarkup + "</main></div></section></div>";
  return true;
}

function activeLessonSteps(): TutorialStep[] {
  return currentLesson().steps;
}

function currentTaskIsComplete(step: TutorialStep): boolean {
  if (!step.task || !tutorialSession) return true;
  return tutorialSession.completedTaskStepIndexes.has(tutorialSession.currentStepIndex);
}

function tutorialTaskMarkup(step: TutorialStep): string {
  if (!step.task) return "";
  const completed = currentTaskIsComplete(step);
  return '<div class="tutorial-task' + (completed ? " is-complete" : "") + '" data-tutorial-task-status>' +
    '<b>' + (completed ? "Done" : "Try this") + '</b><span>' + step.task.instruction + "</span></div>";
}

function refreshTutorialTaskState(): void {
  if (!tutorialSession) return;
  const step = activeLessonSteps()[tutorialSession.currentStepIndex];
  if (!step?.task) return;
  const taskStatus = tutorialLayer()?.querySelector<HTMLElement>("[data-tutorial-task-status]");
  if (taskStatus) {
    taskStatus.classList.add("is-complete");
    taskStatus.innerHTML = "<b>Done</b><span>" + step.task.instruction + "</span>";
  }
  const nextButton = tutorialLayer()?.querySelector<HTMLButtonElement>('[data-tutorial-action="next"]');
  if (nextButton) nextButton.disabled = false;
}

function threadMarkup(currentStepIndex: number, finishing: boolean): string {
  const steps = activeLessonSteps();
  const displayedStepIndex = finishing ? steps.length - 1 : currentStepIndex;
  const progressPercentage = steps.length > 1
    ? (displayedStepIndex / (steps.length - 1)) * 92
    : 0;
  const knots = steps.map((_step, index) => {
    const className = index < displayedStepIndex ? " is-complete"
      : index === displayedStepIndex ? " is-current" : "";
    return '<span class="tutorial-thread-knot' + className + '"></span>';
  }).join("");
  return '<div class="tutorial-thread" style="--tutorial-step-count:' + steps.length +
    ";--tutorial-progress:" + progressPercentage + '%"><span class="tutorial-thread-progress"></span>' +
    knots + "</div>";
}

function renderTutorialStep(): void {
  const layer = tutorialLayer();
  if (!layer || !tutorialSession) return;
  layer.hidden = false;
  const lesson = currentLesson();
  const steps = lesson.steps;
  const step = steps[tutorialSession.currentStepIndex];
  const stepNumber = tutorialSession.currentStepIndex + 1;
  const taskComplete = currentTaskIsComplete(step);
  layer.innerHTML = '<svg class="tutorial-target-thread" aria-hidden="true"><path class="tutorial-target-thread-path"></path>' +
    '<circle class="tutorial-target-thread-marker" r="4"></circle></svg>' +
    '<section class="tutorial-card" role="dialog" aria-label="Guided tour">' +
    threadMarkup(tutorialSession.currentStepIndex, false) +
    '<div class="tutorial-step-meta"><div class="tutorial-step-number"><span>' + lesson.title + "</span> · Step " + stepNumber + " of " + steps.length + "</div>" +
    '<button type="button" class="tutorial-card-drag-handle" data-tutorial-card-drag-handle aria-label="Move lesson box">' +
    '<span aria-hidden="true">⠿</span> Move</button></div>' +
    "<h2>" + step.title + "</h2><p>" + step.body + "</p>" + tutorialTaskMarkup(step) +
    '<div class="tutorial-card-actions">' +
    '<button class="tutorial-button" data-tutorial-action="back"' + (stepNumber === 1 ? " disabled" : "") + '>Back</button>' +
    '<button class="tutorial-button tutorial-button--primary" data-tutorial-action="next"' + (taskComplete ? "" : " disabled") + ">" +
      (stepNumber === steps.length ? "Finish" : "Next") + "</button>" +
    '<button class="learn-runner-link" data-tutorial-action="reset-lesson">Reset lesson</button>' +
    '<button class="tutorial-button tutorial-button--quiet" data-tutorial-action="skip-lesson">Skip lesson</button>' +
    "</div></section>";
  applyTutorialCardPosition();
  step.enter();
  highlightTutorialTarget(step.targetSelector);
  rememberLessonPosition(lesson.id, tutorialSession.currentStepIndex);
  // Replacing the welcome/card can put a newly rendered map box underneath
  // the stationary pointer and provoke a hover tooltip without any deliberate
  // hover. Keep the guided step as the only floating explanation until the
  // user moves the pointer again.
  hideTooltip();
}

function renderTutorialFinish(): void {
  const layer = tutorialLayer();
  if (!layer || !tutorialSession) return;
  const lesson = currentLesson();
  tutorialSession.finishing = true;
  markLessonCompleted(lesson.id);
  clearTutorialTarget();
  closeTutorialSurfaces();
  setUiMode("read");
  const returnLabel = tutorialSession.originalMapHadContent ? "Return to my map" : "Start blank";
  const replacementNote = tutorialSession.originalMapHadContent
    ? "Your map is still parked safely. Continue learning, return to it, or explicitly replace it with the example."
    : "Continue learning, keep exploring the example, or return to a blank canvas.";
  layer.innerHTML = '<section class="tutorial-card tutorial-finish" role="dialog" aria-label="Tour complete">' +
    threadMarkup(lesson.steps.length - 1, true) +
    '<div class="tutorial-step-number">Lesson complete</div>' +
    '<h2>' + lesson.title + " is complete.</h2><p>" + replacementNote + "</p>" +
    '<div class="tutorial-finish-actions">' +
    '<button class="tutorial-button" data-tutorial-action="back">Back</button>' +
    '<button class="tutorial-button tutorial-button--primary" data-tutorial-action="learn">Back to Learn</button>' +
    '<button class="tutorial-button" data-tutorial-action="restore">' + returnLabel + "</button>" +
    (lesson.id === "automatic-review" ? "" : '<button class="tutorial-button tutorial-button--quiet" data-tutorial-action="keep">Keep example</button>') +
    "</div></section>";
}

function hideTutorialLayer(): void {
  clearTutorialTarget();
  const layer = tutorialLayer();
  if (!layer) return;
  layer.hidden = true;
  layer.innerHTML = "";
}

function resetCurrentLesson(): void {
  if (!tutorialSession) return;
  closeTutorialSurfaces();
  if (state.simulationMode) toggleSimulationMode();
  setUiMode("read");
  if (!loadDataFromCsv(TUTORIAL_MAP_CSV, { persist: false })) return;
  tutorialSession.currentStepIndex = 0;
  tutorialSession.completedTaskStepIndexes.clear();
  tutorialSession.finishing = false;
  renderTutorialStep();
}

function restoreOriginalMap(): void {
  if (!tutorialSession) return;
  closeTutorialSurfaces();
  if (state.simulationMode) toggleSimulationMode();
  if (tutorialSession.originalMapCsv) {
    loadDataFromCsv(tutorialSession.originalMapCsv, { persist: false });
  } else {
    bootEmptyStateGrid(tutorialSession.originalEmptyMap || undefined);
  }
  restoreUserInterface(tutorialSession.originalUserInterface);
  const restoredMapCsv = tutorialSession.originalMapCsv ||
    serializeLiveStateToCsv(null, { compact: true });
  restoreHistory(tutorialSession.originalHistory, restoredMapCsv);
  restoreBuilder(tutorialSession.originalBuilder);
}

export function tutorialIsActive(): boolean {
  return tutorialSession !== null;
}

export function startTutorial(lessonIdentifier = FIRST_LESSON_ID, options?: { resume?: boolean }): boolean {
  if (tutorialSession) return false;
  const lesson = LEARN_LESSONS.find(candidate => candidate.id === lessonIdentifier);
  if (!lesson) return false;
  const progress = loadLearnProgress();
  const resumedStepIndex = options?.resume && progress.lastLessonId === lesson.id
    ? Math.min(progress.lastStepIndex, lesson.steps.length - 1)
    : 0;
  const completedTaskStepIndexes = new Set<number>();
  for (let stepIndex = 0; stepIndex < resumedStepIndex; stepIndex++) {
    if (lesson.steps[stepIndex].task) completedTaskStepIndexes.add(stepIndex);
  }
  const originalMapHadContent = state.dataLoaded && (NODES.length > 0 || EDGES.length > 0);
  const originalMapCsv = originalMapHadContent
    ? serializeLiveStateToCsv(null, { compact: true })
    : null;
  const originalBuilder = state.builder.open ? cloneBuilderState(state.builder) : null;
  // Persist every pending map, UI and builder write before the tutorial starts
  // cancelling writers. This closes the debounce window in which entering the
  // tour could otherwise leave localStorage one edit behind indefinitely.
  flushPendingSaves();
  tutorialSession = {
    // A grid with no boxes is not a loadable CSV document yet, even when the
    // user has already customized its rows, columns, categories or constants.
    // Restore it through its own structural snapshot and boot path.
    originalMapCsv,
    originalEmptyMap: state.dataLoaded && !originalMapHadContent ? captureEmptyMap() : null,
    originalMapHadContent: originalMapHadContent,
    originalUserInterface: captureUserInterface(),
    originalHistory: {
      past: state.history.past.slice(),
      future: state.history.future.slice(),
    },
    originalBuilder,
    currentLessonId: lesson.id,
    currentStepIndex: resumedStepIndex,
    completedTaskStepIndexes,
    finishing: false,
    tutorialCardPosition: null,
  };
  setExportMenuOpen(false);
  setStorageWritesSuspended(true);
  closeTutorialSurfaces();
  if (state.simulationMode) toggleSimulationMode();
  setUiMode("read");
  if (!loadDataFromCsv(TUTORIAL_MAP_CSV, { persist: false })) {
    // The bundled tutorial is validated by tests, but a failed temporary load
    // must still honour the lifecycle boundary and put every parked layer back.
    restoreOriginalMap();
    setStorageWritesSuspended(false);
    tutorialSession = null;
    return false;
  }
  renderTutorialStep();
  return true;
}

export function goToTutorialStep(stepIndex: number): void {
  if (!tutorialSession) return;
  tutorialSession.finishing = false;
  tutorialSession.currentStepIndex = Math.max(0, Math.min(activeLessonSteps().length - 1, stepIndex));
  renderTutorialStep();
}

export function startLearnLesson(lessonIdentifier: string, options?: { resume?: boolean }): boolean {
  hideTutorialLayer();
  return startTutorial(lessonIdentifier, options);
}

export function exitTutorial(options?: { markDismissed?: boolean }): void {
  if (!tutorialSession) {
    setStorageWritesSuspended(false);
    hideTutorialLayer();
    return;
  }
  restoreOriginalMap();
  setStorageWritesSuspended(false);
  if (options?.markDismissed !== false) markTutorialState("dismissed");
  tutorialSession = null;
  hideTutorialLayer();
}

export function completeTutorialAndRestore(): void {
  if (!tutorialSession) return;
  restoreOriginalMap();
  setStorageWritesSuspended(false);
  markTutorialState("completed");
  tutorialSession = null;
  hideTutorialLayer();
}

export function completeTutorialAndKeepExample(): void {
  if (!tutorialSession) return;
  // Automatic Review deliberately damages one formula to demonstrate a loader
  // finding. That lesson variant is never a map the user can persist, even if
  // this function is called directly rather than through the hidden button.
  if (currentLesson().id === "automatic-review") return;
  closeTutorialSurfaces();
  if (state.simulationMode) toggleSimulationMode();
  setUiMode("read");
  setStorageWritesSuspended(false);
  // Keeping the example is the explicit replacement path. Do not let a builder
  // recovery draft from the replaced map reopen over it on the next refresh.
  clearBuilderFromStorage();
  const tutorialMapCsv = serializeLiveStateToCsv(null, { compact: true });
  saveCsvToStorage(tutorialMapCsv);
  saveUiStateToStorage();
  state.lastCsvSnapshot = tutorialMapCsv;
  markTutorialState("completed");
  tutorialSession = null;
  hideTutorialLayer();
}

export function showFirstOpenTutorialWelcome(hasSavedCsv: boolean): boolean {
  if (hasSavedCsv || tutorialCompletionState() || tutorialSession) return false;
  const layer = tutorialLayer();
  if (!layer) return false;
  // bootEmptyStateGrid() runs immediately before this on a genuine first open.
  // Freeze and cancel persistence now so a queued empty-grid save cannot turn
  // "no decision yet" into a saved map that suppresses the welcome on refresh.
  setStorageWritesSuspended(true);
  layer.hidden = false;
  layer.innerHTML = '<div class="tutorial-welcome-backdrop"><section class="tutorial-welcome" role="dialog" aria-label="Welcome to Ariadne Maps">' +
    '<svg class="tutorial-welcome-mark" viewBox="0 0 48 28" fill="none" aria-hidden="true"><path d="M3 22C12 22 13 6 24 6s12 16 21 16" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><circle cx="3" cy="22" r="3" fill="currentColor"/><circle cx="24" cy="6" r="3" fill="currentColor"/><circle cx="45" cy="22" r="3" fill="currentColor"/></svg>' +
    '<div class="tutorial-kicker">Welcome to Ariadne Maps</div>' +
    '<h1>Follow one thread through the whole app.</h1>' +
    '<p>A short guided tour loads a neutral community-programme example and introduces reading, simulation, formulas, feedback, evidence and editing. Your own map is never saved over.</p>' +
    '<div class="tutorial-welcome-actions">' +
    '<button class="tutorial-button tutorial-button--primary" data-tutorial-action="start">Start guided tour</button>' +
    '<button class="tutorial-button" data-tutorial-action="blank">Start blank</button>' +
    "</div></section></div>";
  return true;
}

function handleTutorialAction(action: string): void {
  if (action === "start") { startTutorial(); return; }
  if (action === "blank") {
    setStorageWritesSuspended(false);
    if (state.dataLoaded) {
      const blankMapCsv = serializeLiveStateToCsv(null, { compact: true });
      saveCsvToStorage(blankMapCsv);
      saveUiStateToStorage();
      state.lastCsvSnapshot = blankMapCsv;
    }
    markTutorialState("dismissed");
    hideTutorialLayer();
    return;
  }
  if (action === "close-learn") { hideTutorialLayer(); return; }
  if (action === "lesson" || action === "restart-lesson") return;
  if (!tutorialSession) return;
  if (action === "back") {
    if (tutorialSession.finishing) {
      tutorialSession.finishing = false;
      renderTutorialStep();
    } else {
      goToTutorialStep(tutorialSession.currentStepIndex - 1);
    }
    return;
  }
  if (action === "next") {
    const step = activeLessonSteps()[tutorialSession.currentStepIndex];
    if (!currentTaskIsComplete(step)) return;
    if (tutorialSession.currentStepIndex >= activeLessonSteps().length - 1) renderTutorialFinish();
    else goToTutorialStep(tutorialSession.currentStepIndex + 1);
    return;
  }
  if (action === "learn") {
    exitTutorial({ markDismissed: false });
    openLearnHub();
    return;
  }
  if (action === "reset-lesson") { resetCurrentLesson(); return; }
  if (action === "skip-lesson" || action === "exit") {
    exitTutorial({ markDismissed: false });
    openLearnHub();
    return;
  }
  if (action === "keep") { completeTutorialAndKeepExample(); return; }
  if (action === "restore") { completeTutorialAndRestore(); }
}

const layer = tutorialLayer();
if (layer) {
  layer.addEventListener("pointerdown", beginTutorialCardDrag);
  layer.addEventListener("click", event => {
    const button = (event.target as HTMLElement).closest("[data-tutorial-action]") as HTMLElement | null;
    if (!button) return;
    const action = button.getAttribute("data-tutorial-action") || "";
    if (action === "lesson" || action === "restart-lesson") {
      const lessonIdentifier = button.getAttribute("data-lesson-id") || "";
      startLearnLesson(lessonIdentifier, { resume: action === "lesson" });
      return;
    }
    handleTutorialAction(action);
  });
}

window.addEventListener("resize", handleTutorialViewportResize, { passive: true });
document.addEventListener("scroll", updateTutorialTargetThread, { capture: true, passive: true });
document.addEventListener("pointermove", updateTutorialThreadPointerFade, { passive: true });
document.addEventListener("pointerleave", revealTutorialThreadAfterPointerLeaves, { passive: true });
document.addEventListener("pointermove", moveTutorialCard, { passive: true });
document.addEventListener("pointerup", finishTutorialCardDrag, { passive: true });
document.addEventListener("pointercancel", finishTutorialCardDrag, { passive: true });

document.querySelectorAll(".tutorial-trigger").forEach(button => {
  button.addEventListener("click", () => startTutorial());
});

document.querySelectorAll(".learn-trigger").forEach(button => {
  button.addEventListener("click", () => openLearnHub());
});

function observeTutorialTaskEvent(event: Event): void {
  if (!tutorialSession) return;
  const step = activeLessonSteps()[tutorialSession.currentStepIndex];
  const task = step?.task;
  if (!task || !task.events.includes(event.type as TutorialTaskEvent)) return;
  const eventTarget = event.target;
  if (!(eventTarget instanceof Element) || !eventTarget.closest(task.selector)) return;
  const lessonIdentifier = tutorialSession.currentLessonId;
  const stepIndex = tutorialSession.currentStepIndex;
  const markComplete = (): void => {
    if (!tutorialSession || tutorialSession.currentLessonId !== lessonIdentifier || tutorialSession.currentStepIndex !== stepIndex) return;
    if (task.verify && !task.verify()) return;
    tutorialSession.completedTaskStepIndexes.add(stepIndex);
    refreshTutorialTaskState();
  };
  // Verification reads the state produced by the control's own handler, which
  // runs later in this event dispatch than this capture listener.
  if (task.verify) queueMicrotask(markComplete);
  else markComplete();
}

for (const eventName of ["click", "input", "change", "scroll", "keydown", "mouseup"] as TutorialTaskEvent[]) {
  // Scroll does not bubble, so every event uses capture consistently.
  document.addEventListener(eventName, observeTutorialTaskEvent, true);
}
