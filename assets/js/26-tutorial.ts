// =============================================================================
// FIRST-OPEN GUIDED TOUR
// -----------------------------------------------------------------------------
// The tutorial temporarily swaps in a neutral example map and walks through
// the app's main reading, simulation, assurance and editing surfaces. Storage
// writes are suspended for the whole session: leaving restores the exact live
// map that was present before the tour, while "Keep example" is the only action
// that deliberately persists the tutorial map.
// =============================================================================

import { appName, brandedTitle } from "./00-brand";
// The brand comes from .env rather than from a person, but a name carrying an
// ampersand or a quote would still break the markup it lands in.
import { escapeHtml } from "./04-utils";
import { TUTORIAL_MAP_CSV, TUTORIAL_MAP_SMALL_CSV } from "./01a-tutorial-map-data";
import { openLearnReference } from "./26a-learn-reference";
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
import { deselectAll, focusNode, selectEdge, setSelection } from "./09-graph-selection";
import { hideTooltip } from "./12-tooltip";
import { render } from "./11-rendering";
import { renderDetailPanel } from "./15-detail-panel";
import { applySimMultiplier, resetSimulation, toggleSimulationMode } from "./14-simulation-panel";
import { confirmAction } from "./04c-confirm";
import {
  cloneBuilderState,
  closeBuilder,
  invalidateBuilderCaches,
  openBuilder,
} from "./16a-builder-state";
import { renderBuilder } from "./16b-builder-render";
import { bootEmptyStateGrid } from "./16e-canvas-edit";
import type { EmptyMapGridSnapshot } from "./16e-canvas-edit";
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
  atlasSelectedPathwayCount,
  captureAtlasSessionState,
  closeAtlas,
  openAtlas,
  openFirstFeedbackTangle,
  restoreAtlasSessionState,
} from "./21-atlas-view";
import type { AtlasSessionState } from "./21-atlas-view";
import {
  closeReview,
  openReview,
  reviewIsOpen,
} from "./23-review-panel";
import { reviewItemIsCurrent, setReviewFilter, setReviewRecord } from "./25-review-sidebar";
import { endReviewPass, reviewerNamed, startReviewPass } from "./24-review-record";
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
  requestedLessonStepOffset: number;
  completedCheckpointIdentifiersByStep: Map<number, Set<string>>;
  checkpointSnapshotsByStep: Map<number, Map<string, unknown>>;
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

type TutorialTaskEvent = "click" | "input" | "change" | "scroll" | "keydown" | "mouseup" | "pointerup" | "mouseover";

export interface TutorialTask {
  checkpoints: TutorialTaskCheckpoint[];
}

export interface TutorialTaskCheckpoint {
  identifier: string;
  instruction: string;
  selector: string;
  events: TutorialTaskEvent[];
  capture?: () => unknown;
  verify: (event: Event, snapshot: unknown) => boolean;
  settleDelayMilliseconds?: number;
}

export interface TutorialStep {
  title: string;
  body: string;
  targetSelector: string;
  enter: () => void;
  task?: TutorialTask;
}

// The reasons somebody opens the app, and the headings the Learn hub groups by.
export type LearnGroupId = "start" | "read" | "build" | "trust";

export const LEARN_GROUPS: Array<{ id: LearnGroupId; title: string }> = [
  { id: "start", title: "" },
  { id: "read", title: "Read someone else's map" },
  { id: "build", title: "Build your own" },
  { id: "trust", title: "Trust it and pass it on" },
];

export interface LearnLesson {
  id: string;
  groupId: LearnGroupId;
  title: string;
  summary: string;
  duration: string;
  steps: TutorialStep[];
  prerequisiteLessonIds: string[];
  recommendedNextLessonId?: string;
  // Which example map the lesson loads. First look uses a small one so a
  // newcomer's very first screen is readable at a glance; every lesson after it
  // needs the full map, which is the only one wide enough to pan across and
  // deep enough to carry every stage, formula shape and feedback loop they go
  // on to teach.
  mapSize: "small" | "full";
  // Shown on the finish card, so a lesson ends by naming what the learner can
  // now do rather than only offering somewhere else to go.
  recap: string[];
  tryOnYourOwnMap: string;
}

interface LearnProgress {
  curriculumVersion: number;
  completedLessonIds: string[];
  lastLessonId: string | null;
  lastStepIndex: number;
  completedCheckpointIdentifiersByLesson: Record<string, Record<string, string[]>>;
}

const LEARN_CURRICULUM_VERSION = 6;
const FIRST_LESSON_ID = "first-look";

let tutorialSession: TutorialSession | null = null;
let highlightedTutorialTarget: Element | null = null;
let highlightedTutorialTargetSelector: string | null = null;
let tutorialTargetUpdateAnimationFrame: number | null = null;
let tutorialTargetThreadIsDirty = false;
// Geometry the thread was last drawn against, and how many frames in a row it
// has kept changing. See flushTutorialTargetThreadUpdate for why.
let lastDrawnThreadGeometry = "";
let consecutiveThreadSettleFrames = 0;
const MAXIMUM_THREAD_SETTLE_FRAMES = 12;
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
  if (tutorialTargetUpdateAnimationFrame !== null && typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(tutorialTargetUpdateAnimationFrame);
  }
  tutorialTargetUpdateAnimationFrame = null;
  tutorialTargetThreadIsDirty = false;
  lastDrawnThreadGeometry = "";
  consecutiveThreadSettleFrames = 0;
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
  scheduleTutorialTargetThreadUpdate();
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
  scheduleTutorialTargetThreadUpdate();
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
  if (highlightedTutorialTarget) {
    highlightedTutorialTarget.classList.add("tutorial-target");
    // A rebind means the element the thread was pointing at has been replaced by
    // a re-render, and the fresh one may sit outside its scroll container.
    // highlightTutorialTarget() scrolls only once, as the step opens, so without
    // this the thread can end up aimed at a box hidden under the detail panel —
    // visible on the thread, impossible to click. Identity only changes on a
    // re-render, never on a scroll, so this cannot chase its own scroll events.
    highlightedTutorialTarget.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
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

function positionTutorialCardAwayFromTarget(
  tutorialCard: HTMLElement,
  tutorialTarget: Element,
): void {
  if (tutorialSession?.tutorialCardPosition) return;

  // A previous automatic placement must not become a stale fixed position
  // after a resize or after the highlighted control moves. Restore the CSS
  // default first, then choose a fresh alternative only when it is needed.
  tutorialCard.style.removeProperty("left");
  tutorialCard.style.removeProperty("top");
  tutorialCard.style.removeProperty("right");
  tutorialCard.style.removeProperty("bottom");
  tutorialCard.style.removeProperty("transform");

  const cardBounds = tutorialCard.getBoundingClientRect();
  const targetBounds = tutorialTargetBounds(tutorialTarget);
  if (
    cardBounds.width <= 0 || cardBounds.height <= 0 ||
    targetBounds.width <= 0 || targetBounds.height <= 0
  ) return;

  const targetClearance = 12;
  const overlapsTarget = !(
    cardBounds.right + targetClearance <= targetBounds.left ||
    targetBounds.right + targetClearance <= cardBounds.left ||
    cardBounds.bottom + targetClearance <= targetBounds.top ||
    targetBounds.bottom + targetClearance <= cardBounds.top
  );
  if (!overlapsTarget) return;

  const viewportMargin = 12;
  const maximumLeft = Math.max(
    viewportMargin,
    window.innerWidth - cardBounds.width - viewportMargin,
  );
  const maximumTop = Math.max(
    viewportMargin,
    window.innerHeight - cardBounds.height - viewportMargin,
  );
  const defaultLeft = Math.max(viewportMargin, Math.min(maximumLeft, cardBounds.left));
  const defaultTop = Math.max(viewportMargin, Math.min(maximumTop, cardBounds.top));
  const candidatePositions = [
    { left: defaultLeft, top: targetBounds.top - cardBounds.height - targetClearance },
    { left: defaultLeft, top: targetBounds.bottom + targetClearance },
    { left: targetBounds.left - cardBounds.width - targetClearance, top: defaultTop },
    { left: targetBounds.right + targetClearance, top: defaultTop },
  ].filter(position => (
    position.left >= viewportMargin && position.left <= maximumLeft &&
    position.top >= viewportMargin && position.top <= maximumTop
  ));
  if (candidatePositions.length === 0) return;

  candidatePositions.sort((leftPosition, rightPosition) => {
    const leftDistance = Math.hypot(
      leftPosition.left - cardBounds.left,
      leftPosition.top - cardBounds.top,
    );
    const rightDistance = Math.hypot(
      rightPosition.left - cardBounds.left,
      rightPosition.top - cardBounds.top,
    );
    return leftDistance - rightDistance;
  });
  const chosenPosition = candidatePositions[0];
  tutorialCard.style.left = chosenPosition.left + "px";
  tutorialCard.style.top = chosenPosition.top + "px";
  tutorialCard.style.right = "auto";
  tutorialCard.style.bottom = "auto";
  tutorialCard.style.transform = "none";
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

  positionTutorialCardAwayFromTarget(tutorialCard, currentTarget);
  const targetBounds = tutorialTargetBounds(currentTarget);
  const cardBounds = tutorialCard.getBoundingClientRect();
  // Anchor on the part of the target the reader can actually see. A target
  // bigger than the window — Bulk edit's boxes table is around 2000px tall —
  // has its geometric centre outside the viewport, so the thread would trail
  // off the edge pointing at nothing. scrollIntoView({block: "nearest"}) does
  // not rescue it either: an element larger than the viewport already counts as
  // "nearest", so nothing scrolls. When the target is fully visible the visible
  // box IS the target box and this changes nothing; when it is entirely off
  // screen there is no visible part to prefer, so fall back to its own centre.
  const visibleLeft = Math.max(targetBounds.left, 0);
  const visibleTop = Math.max(targetBounds.top, 0);
  const visibleRight = Math.min(targetBounds.right, window.innerWidth);
  const visibleBottom = Math.min(targetBounds.bottom, window.innerHeight);
  const targetCenterX = visibleRight > visibleLeft
    ? (visibleLeft + visibleRight) / 2
    : targetBounds.left + targetBounds.width / 2;
  const targetCenterY = visibleBottom > visibleTop
    ? (visibleTop + visibleBottom) / 2
    : targetBounds.top + targetBounds.height / 2;
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
  lastDrawnThreadGeometry = Math.round(targetCenterX) + ":" + Math.round(targetCenterY) +
    ":" + Math.round(cardConnectionX) + ":" + Math.round(cardConnectionY);
}

function flushTutorialTargetThreadUpdate(): void {
  tutorialTargetUpdateAnimationFrame = null;
  if (!tutorialTargetThreadIsDirty) return;
  tutorialTargetThreadIsDirty = false;
  const layer = tutorialLayer();
  if (!highlightedTutorialTargetSelector || !layer || layer.hidden) return;
  const geometryBeforeDraw = lastDrawnThreadGeometry;
  updateTutorialTargetThread();
  // A dirty batch is serviced on the next animation frame, and that frame often
  // lands while the surface is still settling — the map re-rendering, a panel
  // opening, a scroll not yet applied. Nothing marks the thread dirty a second
  // time, so whatever that one frame measured is what the reader keeps: a thread
  // ending a long way from the box it names, until an unrelated resize happens
  // to repaint it. Keep redrawing while the geometry is still moving, and stop
  // as soon as two consecutive frames agree. The cap bounds a target that
  // animates forever; it is not the normal exit.
  if (lastDrawnThreadGeometry !== geometryBeforeDraw &&
      consecutiveThreadSettleFrames < MAXIMUM_THREAD_SETTLE_FRAMES) {
    consecutiveThreadSettleFrames += 1;
    scheduleTutorialTargetThreadUpdate();
    return;
  }
  consecutiveThreadSettleFrames = 0;
}

function scheduleTutorialTargetThreadUpdate(): void {
  const layer = tutorialLayer();
  if (!highlightedTutorialTargetSelector || !layer || layer.hidden) return;
  tutorialTargetThreadIsDirty = true;
  if (tutorialTargetUpdateAnimationFrame !== null) return;
  if (typeof requestAnimationFrame !== "function") {
    flushTutorialTargetThreadUpdate();
    return;
  }
  tutorialTargetUpdateAnimationFrame = requestAnimationFrame(flushTutorialTargetThreadUpdate);
}

function highlightTutorialTarget(selector: string): void {
  clearTutorialTarget();
  highlightedTutorialTargetSelector = selector;
  const target = synchroniseTutorialTarget();
  if (target) target.scrollIntoView({ block: "nearest", inline: "nearest" });
  // Draw once synchronously for the newly rendered step. Subsequent geometry
  // changes are coalesced by the dirty scheduler rather than polling forever.
  updateTutorialTargetThread();
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

function openExportMenuForTutorialStep(): void {
  const lessonIdentifier = tutorialSession?.currentLessonId;
  const stepIndex = tutorialSession?.currentStepIndex;
  setExportMenuOpen(true);
  // Starting or advancing a lesson happens inside a click. The app-wide click
  // handler closes an open Export menu after that same click bubbles, so open
  // it again once the launch event has finished. Keep the callback scoped to
  // the step that requested it so a quick exit cannot reopen a stale menu.
  window.setTimeout(() => {
    if (
      tutorialSession?.currentLessonId !== lessonIdentifier ||
      tutorialSession?.currentStepIndex !== stepIndex
    ) return;
    setExportMenuOpen(true);
    updateTutorialTargetThread();
  }, 0);
}

function enterUnselectedReadingSurface(): void {
  enterReadingSurface();
  deselectAll();
}

function focusTutorialNode(identifier: string): void {
  if (nodeById[identifier]) focusNode(identifier);
  else if (NODES[0]) focusNode(NODES[0].id);
}

function tutorialCheckpoint(
  identifier: string,
  instruction: string,
  selector: string,
  events: TutorialTaskEvent[],
  verify: TutorialTaskCheckpoint["verify"],
  capture?: TutorialTaskCheckpoint["capture"],
  settleDelayMilliseconds?: number,
): TutorialTaskCheckpoint {
  return { identifier, instruction, selector, events, verify, capture, settleDelayMilliseconds };
}

function eventTargetClosest(event: Event, selector: string): Element | null {
  const eventTarget = event.target;
  return eventTarget instanceof Element ? eventTarget.closest(selector) : null;
}

function captureMapModel(): string {
  return serializeLiveStateToCsv(null, { compact: true });
}

function captureEdgeModel(): string {
  return JSON.stringify(EDGES);
}

function captureFeedbackPlaybackControls(): string {
  const controls = document.getElementById("atlas-loopctl");
  const toggleButton = controls?.querySelector<HTMLButtonElement>("[data-loop-animation-toggle]");
  const speedSelect = controls?.querySelector<HTMLSelectElement>("[data-loop-animation-speed]");
  const scrubber = controls?.querySelector<HTMLInputElement>("[data-loop-animation-scrub]");
  return JSON.stringify({
    toggleLabel: toggleButton?.textContent?.trim() || "",
    speed: speedSelect?.value || "",
    position: scrubber?.value || "",
  });
}

function simulationInputIsAwayFromBaseline(nodeIdentifier: string): boolean {
  const multiplier = state.userOverrides[nodeIdentifier] ?? 1;
  return Math.abs(multiplier - 1) > 0.0005;
}

function simulationInputIsZero(nodeIdentifier: string): boolean {
  const node = nodeById[nodeIdentifier];
  if (!node || typeof node.baseline !== "number") return false;
  const multiplier = state.userOverrides[nodeIdentifier] ?? 1;
  return Math.abs(node.baseline * multiplier) < 0.0005;
}

interface TutorialHiddenFilterSnapshot {
  streamIdentifiers: string[];
  stageIdentifiers: string[];
  categoryIdentifiers: string[];
  effectIdentifiers: string[];
  styleIdentifiers: string[];
  traceIdentifiers: string[];
}

function captureHiddenFilterSnapshot(): TutorialHiddenFilterSnapshot {
  return {
    streamIdentifiers: Array.from(state.hiddenStreams),
    stageIdentifiers: Array.from(state.hiddenStages),
    categoryIdentifiers: Array.from(state.hiddenCategories),
    effectIdentifiers: Array.from(state.hiddenEffects),
    styleIdentifiers: Array.from(state.hiddenStyles),
    traceIdentifiers: Array.from(state.hiddenTrace),
  };
}

function hiddenFilterWasAdded(snapshot: unknown): boolean {
  const previousSnapshot = snapshot as TutorialHiddenFilterSnapshot | undefined;
  if (!previousSnapshot) return false;
  const filterGroups: Array<{ currentIdentifiers: Set<string>; previousIdentifiers: string[] }> = [
    { currentIdentifiers: state.hiddenStreams, previousIdentifiers: previousSnapshot.streamIdentifiers },
    { currentIdentifiers: state.hiddenStages, previousIdentifiers: previousSnapshot.stageIdentifiers },
    { currentIdentifiers: state.hiddenCategories, previousIdentifiers: previousSnapshot.categoryIdentifiers },
    { currentIdentifiers: state.hiddenEffects, previousIdentifiers: previousSnapshot.effectIdentifiers },
    { currentIdentifiers: state.hiddenStyles, previousIdentifiers: previousSnapshot.styleIdentifiers },
    { currentIdentifiers: state.hiddenTrace, previousIdentifiers: previousSnapshot.traceIdentifiers },
  ];
  return filterGroups.some(filterGroup => {
    const previousIdentifiers = new Set(filterGroup.previousIdentifiers);
    return Array.from(filterGroup.currentIdentifiers).some(identifier => !previousIdentifiers.has(identifier));
  });
}

function clickedDimensionEndsFolded(event: Event): boolean {
  const rowHeading = eventTargetClosest(event, "[data-stream-id]") as HTMLElement | null;
  if (rowHeading?.dataset.streamId) return state.hiddenStreams.has(rowHeading.dataset.streamId);
  const columnHeading = eventTargetClosest(event, "[data-stage-id]") as HTMLElement | null;
  return !!columnHeading?.dataset.stageId && state.hiddenStages.has(columnHeading.dataset.stageId);
}

function selectedNodeIsRelatedToWorkshopReadiness(): boolean {
  const selectedNodeIdentifier = state.selectedNodeId;
  if (!selectedNodeIdentifier || selectedNodeIdentifier === WORKSHOP_READINESS_IDENTIFIER) return false;
  return EDGES.some(edge =>
    (edge.from === WORKSHOP_READINESS_IDENTIFIER && edge.to === selectedNodeIdentifier) ||
    (edge.to === WORKSHOP_READINESS_IDENTIFIER && edge.from === selectedNodeIdentifier));
}

function createdNodeIdentifiers(snapshot: unknown): string[] {
  const identifiersBefore = new Set(Array.isArray(snapshot) ? snapshot.map(String) : []);
  return NODES.filter(node => !identifiersBefore.has(node.id)).map(node => node.id);
}

function selectedNodeIdentifiersSignature(): string {
  return Array.from(state.selectedNodeIds).sort().join("|");
}

function captureSelectedNodesPlacement(): string {
  return JSON.stringify(Array.from(state.selectedNodeIds).sort().map(identifier => {
    const node = nodeById[identifier];
    return [identifier, node?.stream || "", node?.stage || ""];
  }));
}

function captureSelectedReviewState(): string {
  return JSON.stringify({ selectedNodeId: state.selectedNodeId, reviews: state.reviews });
}

const MAP_STRUCTURE_STEPS: TutorialStep[] = [
  {
    title: "Read rows as parts of the system",
    body: "Each horizontal row is a domain that owns or experiences part of the programme. The short labels stay fixed while you move, so you always know which part of the system you are reading.",
    targetSelector: "#viz-sticky-rows:not([hidden]) .viz-sticky-row, .row-label-group",
    enter: () => enterUnselectedReadingSurface(),
  },
  {
    title: "Read stages, boxes, links and tags",
    body: "Columns move from inputs through delivery to learning and adaptation. Boxes are system factors, links show influence, fill colours show primary categories and corner tags add secondary meaning. You can understand this grammar before opening any box.",
    targetSelector: '[data-node-id="' + WORKSHOP_READINESS_IDENTIFIER + '"]',
    enter: () => enterUnselectedReadingSurface(),
  },
];

// Simulation running, nothing selected: the calculation breakdown only renders
// while simulating, but the reader has to open the box to see it.
function enterUnselectedSimulationSurface(): void {
  closeTutorialSurfaces();
  setUiMode("read");
  if (!state.simulationMode) toggleSimulationMode();
  deselectAll();
  render();
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

function enterSimulationAtlasExample(identifier: string): void {
  enterSimulationExample(identifier);
  resetSimulation();
}

// Atlas already open AND simulating, with every input back at its starting
// value so the lesson's own change is the only thing moving.
function enterSimulatingAtlasExample(identifier: string): void {
  closeTutorialSurfaces();
  setUiMode("read");
  if (!state.simulationMode) toggleSimulationMode();
  resetSimulation();
  if (!nodeById[identifier]) return;
  focusTutorialNode(identifier);
  openAtlas(identifier);
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

const MOVE_AROUND_MAP_STEPS: TutorialStep[] = [
  {
    title: "Zoom to a readable scale",
    body: "Before selecting anything, use − and + to choose how much detail you can read. The map stays anchored at its beginning while its boxes and spacing change scale.",
    targetSelector: "#viz-navigation-controls",
    enter: () => {
      enterUnselectedReadingSurface();
      setNavigationControlMode("zoom");
    },
    task: { checkpoints: [tutorialCheckpoint(
      "change-zoom", "Use + or − once.", "#viz-zoom-out, #viz-zoom-in", ["click"],
      (_event, snapshot) => state.zoomLevel !== Number(snapshot),
      () => state.zoomLevel,
      350,
    )] },
  },
  {
    title: "Move from the beginning to the end",
    body: "Drag the canvas or use a trackpad or mouse wheel to move through the system. Travel from Inputs to Learning and adaptation, then return to the beginning so both directions become familiar.",
    targetSelector: "#viz-scroll",
    enter: () => {
      enterUnselectedReadingSurface();
      const scrollArea = document.getElementById("viz-scroll");
      if (scrollArea) {
        scrollArea.scrollLeft = 0;
        scrollArea.scrollTop = 0;
      }
    },
    task: { checkpoints: [
      tutorialCheckpoint(
        "pan-to-learning-end", "Pan far enough to reveal the final Learning and adaptation stage.",
        "#viz-scroll", ["scroll"],
        () => {
          const scrollArea = document.getElementById("viz-scroll");
          if (!scrollArea) return false;
          const availableTravel = scrollArea.scrollWidth - scrollArea.clientWidth;
          return availableTravel >= 160 && scrollArea.scrollLeft >= availableTravel * 0.75;
        },
      ),
      tutorialCheckpoint(
        "pan-back-to-inputs", "Then pan back to the Inputs end.", "#viz-scroll", ["scroll"],
        () => {
          const scrollArea = document.getElementById("viz-scroll");
          if (!scrollArea) return false;
          const availableTravel = scrollArea.scrollWidth - scrollArea.clientWidth;
          return availableTravel >= 160 && scrollArea.scrollLeft <= availableTravel * 0.2;
        },
      ),
    ] },
  },
  {
    title: "Frame the whole map again",
    body: "The percentage button alternates between fitting height and width. Use it when you want to recover the whole frame after zooming and moving, then choose a readable scale again for close work.",
    targetSelector: "#viz-zoom-readout",
    enter: () => {
      enterUnselectedReadingSurface();
      setNavigationControlMode("zoom");
    },
    task: { checkpoints: [tutorialCheckpoint(
      "fit-map", "Use the percentage button to fit the map.", "#viz-zoom-readout", ["click"],
      (_event, snapshot) => document.getElementById("viz-zoom-readout")?.getAttribute("data-fit-next") !== snapshot,
      () => document.getElementById("viz-zoom-readout")?.getAttribute("data-fit-next") || "height",
      350,
    )] },
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
    task: { checkpoints: [
      tutorialCheckpoint(
        "replace-search", "Replace confidence with a different search term.", "#search-input", ["input"],
        (event, snapshot) => {
          const searchInput = eventTargetClosest(event, "#search-input") as HTMLInputElement | null;
          return !!searchInput && searchInput.value.trim().length > 0 && searchInput.value !== snapshot;
        },
        () => (document.getElementById("search-input") as HTMLInputElement | null)?.value || "",
      ),
      tutorialCheckpoint(
        "open-search-result", "Then press Enter to centre the highlighted result.", "#search-input", ["keydown"],
        (event, snapshot) => (event as KeyboardEvent).key === "Enter" && state.selectedNodeId !== snapshot,
        () => state.selectedNodeId,
      ),
    ] },
  },
  {
    title: "Reduce visual noise without deleting anything",
    body: "Filters hide rows, columns, tags, link effects and line styles. They only change the current view: the model and its calculations stay intact.",
    targetSelector: "#sidebar [data-kind][data-id], #sidebar [data-legend-kind][data-legend-id]",
    enter: () => {
      enterReadingSurface();
      setFiltersOpen(true);
    },
    task: { checkpoints: [tutorialCheckpoint(
      "hide-filter", "Turn one row, tag, effect or line-style filter off.",
      "#sidebar [data-kind][data-id], #sidebar [data-legend-kind][data-legend-id]", ["click"],
      (_event, snapshot) => hiddenFilterWasAdded(snapshot),
      captureHiddenFilterSnapshot,
    )] },
  },
  {
    title: "Fold a row or column to keep its connections",
    body: "In View mode, click a row or column heading to fold it. " + appName() + " keeps a compact connector showing that hidden boxes still carry a causal route; click the heading again to expand it.",
    targetSelector: ".viz-container.floating-rows .viz-sticky-row, .viz-container:not(.floating-rows) .row-label-group",
    enter: () => enterReadingSurface(),
    task: { checkpoints: [tutorialCheckpoint(
      "fold-dimension", "Fold one row or column by selecting its heading.",
      ".viz-container.floating-rows .viz-sticky-row, .viz-container:not(.floating-rows) .row-label-group, .viz-container.floating-columns .viz-sticky-column, .viz-container:not(.floating-columns) .col-header-group",
      ["click"], event => clickedDimensionEndsFolded(event),
    )] },
  },
];

const MODE_SAFETY_STEPS: TutorialStep[] = [
  {
    title: "Switch from viewing to editing",
    body: "View keeps authoring controls out of the way. Select Edit when you intend to change the model; filtering, selecting and simulation do not rewrite its structure.",
    targetSelector: "#mode-toggle-button",
    enter: () => enterReadingSurface(),
    task: { checkpoints: [tutorialCheckpoint(
      "enter-edit-mode", "Select Edit.", "#mode-toggle-button", ["click"],
      () => state.uiMode === "edit",
    )] },
  },
  {
    title: "Return to View when the edit is done",
    body: "The same control changes to View while authoring is active. Returning to View removes editing handles while keeping the saved model change.",
    targetSelector: "#mode-toggle-button",
    enter: () => enterEditExample(WORKSHOP_READINESS_IDENTIFIER),
    task: { checkpoints: [tutorialCheckpoint(
      "return-to-view-mode", "Select View.", "#mode-toggle-button", ["click"],
      () => state.uiMode === "read",
    )] },
  },
];

const CAUSE_EFFECT_STEPS: TutorialStep[] = [
  {
    title: "Select your first box",
    body: "Now that you can move around the map, select Workshop readiness. Selecting a box dims everything except what it touches directly, and opens its details on the right.",
    targetSelector: '[data-node-id="' + WORKSHOP_READINESS_IDENTIFIER + '"]',
    enter: () => {
      enterUnselectedReadingSurface();
      setNavigationControlMode("depth");
    },
    task: { checkpoints: [tutorialCheckpoint(
      "select-first-box", "Select Workshop readiness.",
      '[data-node-id="' + WORKSHOP_READINESS_IDENTIFIER + '"]', ["click"],
      () => state.selectedNodeId === WORKSHOP_READINESS_IDENTIFIER,
    )] },
  },
  {
    title: "Distinguish link direction from desirability",
    body: "The details list what drives the selected box on the left and what it drives on the right. Increases and decreases describe the target's response; higher-is-better and lower-is-better belong to the box, so a decreasing link is not automatically harmful.",
    targetSelector: '#detail-panel [data-detail-quantity="outcome"]',
    enter: () => {
      enterReadingSurface();
      focusTutorialNode(WORKSHOP_READINESS_IDENTIFIER);
    },
  },
  {
    title: "Follow the highlighted thread",
    body: "Depth 1 answers ‘what touches this box directly?’ Each step further out adds another link in the chain, so you can see where an effect eventually reaches. Increase the depth, then select one of the boxes it reveals.",
    targetSelector: "#viz-depth-up",
    enter: () => {
      enterReadingSurface();
      setNavigationControlMode("depth");
      focusTutorialNode(WORKSHOP_READINESS_IDENTIFIER);
    },
    task: { checkpoints: [
      tutorialCheckpoint(
        "increase-depth", "Increase the highlight depth.", "#viz-depth-up", ["click"],
        (_event, snapshot) => state.highlightDepth > Number(snapshot),
        () => state.highlightDepth,
      ),
      tutorialCheckpoint(
        "select-related-box", "Then select a directly related box.", ".node-group", ["click"],
        () => selectedNodeIsRelatedToWorkshopReadiness(),
      ),
    ] },
  },
];

const SIMULATION_STEPS: TutorialStep[] = [
  {
    title: "Start with an adjustable input",
    body: "Simulate adds a slider for every adjustable starting box. Volunteer time is measured against its baseline, so 150 hours means a 1.5× input rather than an unexplained absolute replacement.",
    targetSelector: '.sim-slider-row[data-node-id="' + ADJUSTABLE_INPUT_IDENTIFIER + '"]',
    enter: () => enterSimulationExample(ADJUSTABLE_INPUT_IDENTIFIER),
    task: { checkpoints: [tutorialCheckpoint(
      "change-volunteer-time", "Change Volunteer time from its 100% baseline.",
      '.sim-slider-row[data-node-id="' + ADJUSTABLE_INPUT_IDENTIFIER + '"] input', ["input", "change", "pointerup"],
      () => simulationInputIsAwayFromBaseline(ADJUSTABLE_INPUT_IDENTIFIER),
    )] },
  },
  {
    title: "Trace the formula by hovering",
    body: "The formula shows exactly how this downstream value is calculated. Hover a box variable to see its current value and highlight the same box under Driven by. A variable marked global is shared map-wide rather than drawn as a box; hover it to see its value and definition.",
    targetSelector: ".calc-breakdown",
    enter: () => enterSimulationExample(FORMULA_IDENTIFIER),
    task: { checkpoints: [
      tutorialCheckpoint(
        "hover-formula-box", "Hover outreach_effort and watch Outreach effort highlight under Driven by.",
        '.calc-formula .fx-box[data-formula-node-id="outreach_effort"]', ["mouseover"],
        () => !!document.querySelector(
          '.drow[data-edge-direction="from"][data-target-node="outreach_effort"].is-formula-variable-highlight',
        ),
      ),
      tutorialCheckpoint(
        "hover-formula-global", "Then hover people_reached_per_hour to see its global value and definition.",
        '.calc-formula [data-formula-param-id="people_reached_per_hour"]', ["mouseover"],
        event => eventTargetClosest(event, '[data-formula-kind="global-variable"]') !== null,
      ),
    ] },
  },
  {
    title: "Reset before asking the next question",
    body: "Reset sliders returns every input to its baseline in one action. Use it between scenarios so one earlier experiment does not quietly affect the next.",
    targetSelector: "#sim-reset-button",
    enter: () => enterSimulationExample(ADJUSTABLE_INPUT_IDENTIFIER),
    task: { checkpoints: [tutorialCheckpoint(
      "reset-scenario", "Reset every scenario input to its starting value.", "#sim-reset-button", ["click"],
      () => Object.keys(state.userOverrides).length === 0,
    )] },
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
    title: "Make something impossible to divide",
    body: "Registration share divides registrations by the people reached. Dividing by zero has no answer, so set Outreach effort to zero and see what the map does about it.",
    targetSelector: '.sim-slider-row[data-node-id="outreach_effort"]',
    enter: () => enterSimulationExample("outreach_effort"),
    task: { checkpoints: [tutorialCheckpoint(
      "set-outreach-to-zero", "Set Outreach effort to 0 or 0%.",
      '.sim-slider-row[data-node-id="outreach_effort"] input', ["input", "change", "pointerup"],
      () => simulationInputIsZero("outreach_effort"),
    )] },
  },
  {
    title: "Read what the map says went wrong",
    body: "There is nobody to divide by, so " + appName() + " shows 0 and explains why, rather than letting an impossible number spread through the rest of the map. The 0–1 range still applies. Decide for yourself whether 0 is a sensible answer here before you trust it.",
    targetSelector: ".calc-breakdown",
    enter: () => enterSimulationExample("registration_share"),
  },
];

function boxRestsAtStartingValue(identifier: string): boolean {
  const node = nodeById[identifier];
  const computed = state.computedValues[identifier];
  if (!node || typeof computed !== "number" || typeof node.baseline !== "number") return false;
  return Math.abs(computed - node.baseline) <= Math.max(1e-6, Math.abs(node.baseline) * 1e-6);
}

function selectedBoxHasMovedFromStart(): boolean {
  const identifier = state.selectedNodeId;
  if (!identifier) return false;
  // The box the learner dragged themselves does not count — the point of the
  // step is to find somewhere the change ARRIVED, not where it started.
  if (Object.prototype.hasOwnProperty.call(state.userOverrides, identifier)) return false;
  const node = nodeById[identifier];
  const computed = state.computedValues[identifier];
  if (!node || typeof computed !== "number" || typeof node.baseline !== "number") return false;
  return Math.abs(computed - node.baseline) > Math.max(1e-6, Math.abs(node.baseline) * 1e-6);
}

function nodeCombineRuleIs(identifier: string, rule: "" | "additive" | "min"): boolean {
  const node = nodeById[identifier];
  if (!node) return false;
  const current = node.combine && node.combine !== "multiplicative" ? node.combine : "";
  return current === rule;
}

// ───── First look ────────────────────────────────────────────────────
// The only lesson a newcomer is asked to commit to before they know what the
// app is. It has to answer "why would I want this?" in about three minutes, so
// every step ends in something the learner did, and it runs on the small map.
const FIRST_LOOK_STEPS: TutorialStep[] = [
  {
    title: "A map built to answer one question",
    body: "This is a small community workshop programme. It runs sessions for local residents, and it wants to know one thing: can it reach more people without booking more venues? A systems map lays out what affects what, so a question like that can be answered rather than argued about. Start by selecting Workshop readiness.",
    targetSelector: '[data-node-id="' + WORKSHOP_READINESS_IDENTIFIER + '"]',
    enter: () => enterUnselectedReadingSurface(),
    task: { checkpoints: [tutorialCheckpoint(
      "first-look-select", "Select the Workshop readiness box.",
      '[data-node-id="' + WORKSHOP_READINESS_IDENTIFIER + '"]', ["click"],
      () => state.selectedNodeId === WORKSHOP_READINESS_IDENTIFIER,
    )] },
  },
  {
    title: "Every box is something that can go up or down",
    body: "A box is not a task or a stage of work. It is something you could have more or less of: volunteer time, people reached, barriers to getting through the door. The panel on the right names what drives this box and what it drives in turn. Follow one of those arrows now.",
    // The task is "select a box this one connects to", and only a click landing on
    // a .node-group completes it. `.ancestor` / `.descendant` are exactly the boxes
    // joined to the focused one, so the thread lands on a box that both illustrates
    // the point and satisfies the checkpoint when selected. (It used to point at
    // the depth stepper, which neither the body nor the task mentions.)
    targetSelector: ".node-group.ancestor, .node-group.descendant",
    enter: () => {
      enterReadingSurface();
      setNavigationControlMode("depth");
      focusTutorialNode(WORKSHOP_READINESS_IDENTIFIER);
    },
    task: { checkpoints: [tutorialCheckpoint(
      "first-look-follow", "Select a box that this one connects to.", ".node-group", ["click"],
      () => selectedNodeIsRelatedToWorkshopReadiness(),
    )] },
  },
  {
    title: "Now change something",
    body: "Simulate turns every starting box into a slider. Nothing on the map has moved yet, so everything is resting at its normal value. Push Volunteer time above its starting point and the map will work out what follows.",
    targetSelector: '.sim-slider-row[data-node-id="' + ADJUSTABLE_INPUT_IDENTIFIER + '"]',
    enter: () => enterSimulationExample(ADJUSTABLE_INPUT_IDENTIFIER),
    task: { checkpoints: [tutorialCheckpoint(
      "first-look-change", "Move the Volunteer time slider away from 100%.",
      '.sim-slider-row[data-node-id="' + ADJUSTABLE_INPUT_IDENTIFIER + '"] input',
      ["input", "change", "pointerup"],
      () => simulationInputIsAwayFromBaseline(ADJUSTABLE_INPUT_IDENTIFIER),
    )] },
  },
  {
    title: "See how far that change travelled",
    body: "One change does not stop where you made it. Boxes that moved are no longer grey, and the further you look from the slider you touched, the more the programme has quietly rearranged itself. Find a box that moved and open it.",
    // A box that moved, not the map area — centring the thread on #viz-scroll aimed
    // it at whatever happened to sit in the middle. `sim-fill` marks a simulated
    // box and `sim-flat` the ones that did not move. The adjustable input is
    // excluded because selectedBoxHasMovedFromStart() rejects boxes the reader
    // overrode themselves, so pointing there would fail the check it invites.
    targetSelector: ".node-group.sim-fill:not(.sim-flat):not([data-node-id=\"" +
      ADJUSTABLE_INPUT_IDENTIFIER + "\"])",
    enter: () => {
      if (!state.simulationMode) toggleSimulationMode();
      setUiMode("read");
      deselectAll();
      // The step is "look at what your change did", so something has to have
      // moved. A reader who arrives without touching the previous step's slider
      // — Back from the next step, or Skip — would otherwise face an all-grey
      // map with no box to find and a thread pointing at nothing. Nudge the same
      // input the previous step asks for.
      if (!simulationInputIsAwayFromBaseline(ADJUSTABLE_INPUT_IDENTIFIER)) {
        applySimMultiplier(ADJUSTABLE_INPUT_IDENTIFIER, 1.5, null);
      }
      render();
    },
    task: { checkpoints: [tutorialCheckpoint(
      "first-look-consequence", "Select a box further along that moved because of your change.",
      ".node-group", ["click"],
      () => selectedBoxHasMovedFromStart(),
    )] },
  },
  {
    title: "That is the whole idea",
    body: "You read a map, changed one thing and followed the consequences. Everything else this app does is a longer version of those three moves: building the map, saying how each box is worked out, checking that it is trustworthy and sharing it. Put the slider back and decide where to go next.",
    targetSelector: "#sim-reset-button",
    enter: () => enterSimulationExample(ADJUSTABLE_INPUT_IDENTIFIER),
    task: { checkpoints: [tutorialCheckpoint(
      "first-look-reset", "Put every slider back to its starting value.", "#sim-reset-button", ["click"],
      () => Object.keys(state.userOverrides).length === 0,
    )] },
  },
];

// ───── Make it calculate ─────────────────────────────────────────────
// Replaces sixteen read-only cards that explained the calculation rules in
// prose. Each rule is now demonstrated by changing it and watching the number
// move; the prose itself lives in the Learn reference shelf, reachable from the
// "?" beside the formula editor at the moment the question actually comes up.
const MAKE_IT_CALCULATE_STEPS: TutorialStep[] = [
  {
    title: "Two ways a box gets its number",
    body: "Some boxes are worked out from a sum you can write down. People reached is hours of outreach multiplied by people per hour. Others have no sum — Workshop readiness is a judgement about several influences, so it is estimated from how much each incoming link moves it. Open one of each.",
    // The reader opens People reached themselves, so the thread points at the box
    // rather than at the breakdown that only exists once it has been opened.
    targetSelector: '[data-node-id="' + FORMULA_IDENTIFIER + '"]',
    // Deliberately nothing selected. Pre-selecting People reached made the first
    // checkpoint ask for something the lesson had already done — the panel was
    // open, the instruction still read "Still to do", and the only way to satisfy
    // it was to click a box that focusNode had pushed under the detail panel.
    enter: () => enterUnselectedSimulationSurface(),
    task: { checkpoints: [
      tutorialCheckpoint(
        "calc-open-formula-box", "Open People reached and read how it is worked out.",
        '[data-node-id="' + FORMULA_IDENTIFIER + '"]', ["click"],
        () => state.selectedNodeId === FORMULA_IDENTIFIER,
      ),
      tutorialCheckpoint(
        "calc-open-strength-box", "Then open Workshop readiness, which has no sum behind it.",
        '[data-node-id="' + WORKSHOP_READINESS_IDENTIFIER + '"]', ["click"],
        () => state.selectedNodeId === WORKSHOP_READINESS_IDENTIFIER,
      ),
    ] },
  },
  {
    title: "Try all three ways of adding links up",
    body: "When a box has no sum, Combine decides how its incoming links add up. Standard compounds them, so separate influences reinforce each other. Additive stops overlapping influences double-counting. Weakest link lets the smallest input hold everything else back. Switch between all three on Workshop readiness and watch its number change each time.",
    targetSelector: '#detail-panel [data-field="combine"]',
    enter: () => enterEditExample(WORKSHOP_READINESS_IDENTIFIER),
    task: { checkpoints: [
      tutorialCheckpoint(
        "calc-combine-additive", "Set Combine to Additive.",
        '#detail-panel [data-field="combine"]', ["change"],
        () => nodeCombineRuleIs(WORKSHOP_READINESS_IDENTIFIER, "additive"),
      ),
      tutorialCheckpoint(
        "calc-combine-min", "Then set it to Weakest link.",
        '#detail-panel [data-field="combine"]', ["change"],
        () => nodeCombineRuleIs(WORKSHOP_READINESS_IDENTIFIER, "min"),
      ),
      tutorialCheckpoint(
        "calc-combine-standard", "Then put it back to Standard.",
        '#detail-panel [data-field="combine"]', ["change"],
        () => nodeCombineRuleIs(WORKSHOP_READINESS_IDENTIFIER, ""),
      ),
    ] },
  },
  {
    title: "A sum takes over from the links",
    body: "Give a box a formula and its incoming links stop doing the arithmetic — they become a record of what the sum depends on. Every box named in a formula must still have a link into this box. Change the sum for People reached and watch the result follow.",
    targetSelector: '#detail-panel [data-field="formula"]',
    enter: () => enterEditExample(FORMULA_IDENTIFIER),
    task: { checkpoints: [tutorialCheckpoint(
      "calc-edit-formula", "Change the formula for People reached.",
      '#detail-panel [data-field="formula"]', ["change", "input"],
      (_event, snapshot) => (nodeById[FORMULA_IDENTIFIER]?.formula || "") !== String(snapshot),
      () => nodeById[FORMULA_IDENTIFIER]?.formula || "",
      400,
    )] },
  },
  {
    title: "A good sum reproduces the starting value",
    body: "The first test of any rule: with every input left alone, does the box come out at the value it is supposed to rest at? If it does not, the sum and the starting value disagree, and one of them is wrong. Put the original formula back and check that it settles.",
    targetSelector: '#detail-panel [data-field="formula"]',
    enter: () => enterEditExample(FORMULA_IDENTIFIER),
    task: { checkpoints: [tutorialCheckpoint(
      "calc-restore-formula", "Restore the formula until People reached rests at its starting value again.",
      '#detail-panel [data-field="formula"]', ["change", "input"],
      () => boxRestsAtStartingValue(FORMULA_IDENTIFIER),
      undefined,
      400,
    )] },
  },
  {
    title: "A cap that is already biting",
    body: "Workshops delivered wraps demand in min() with the sessions there is room and cover for. On this map the cap is already reached: 160 registrations exactly fill 8 sessions of 20 places. So more demand changes nothing at all \u2014 and that is the programme\u2019s own question answered. Push outreach up and watch nothing happen, then raise the capacity instead.",
    targetSelector: ".calc-breakdown",
    enter: () => enterSimulationExample("workshops_delivered"),
    task: { checkpoints: [
      tutorialCheckpoint(
        "calc-demand-hits-cap", "Raise Outreach effort. People reached climbs; Workshops delivered does not move.",
        '.sim-slider-row[data-node-id="outreach_effort"] input', ["input", "change", "pointerup"],
        () => simulationInputIsAwayFromBaseline("outreach_effort") &&
          boxRestsAtStartingValue("workshops_delivered"),
      ),
      tutorialCheckpoint(
        "calc-raise-the-cap", "Now raise Venue availability and Facilitator capacity until Workshops delivered finally moves.",
        '.sim-slider-row[data-node-id="venue_slots"] input, .sim-slider-row[data-node-id="facilitator_slots"] input',
        ["input", "change", "pointerup"],
        () => !boxRestsAtStartingValue("workshops_delivered"),
      ),
    ] },
  },
  {
    title: "Guardrails are a last resort, not a repair",
    body: "Lowest and highest allowed clamp a result into a range that its units make unavoidable — a share cannot pass 1, a count cannot go below 0. They are guardrails on an already-correct rule. If a bound is doing the work of fixing a wrong answer, fix the rule instead. Put a ceiling on a box and watch it hold.",
    targetSelector: '#detail-panel [data-field="maxValue"]',
    enter: () => enterEditExample("registration_share"),
    task: { checkpoints: [tutorialCheckpoint(
      "calc-set-bound", "Change the highest allowed value for Registration share.",
      '#detail-panel [data-field="maxValue"]', ["change", "input"],
      (_event, snapshot) => String(nodeById.registration_share?.maxValue ?? "") !== String(snapshot),
      () => String(nodeById.registration_share?.maxValue ?? ""),
      400,
    )] },
  },
  {
    title: "Feedback that does not arrive instantly",
    body: "Confidence feedback closes a loop: today's community confidence changes how many people tomorrow's outreach reaches, which eventually changes confidence again. delay() is what stops that happening in the same instant and spiralling. Change confidence and watch the loop take time to settle.",
    targetSelector: ".calc-breakdown",
    enter: () => enterSimulationExample("feedback_uplift"),
    task: { checkpoints: [tutorialCheckpoint(
      "calc-move-feedback", "Move any slider that feeds Community confidence, then open Confidence feedback.",
      ".node-group, .sim-slider-row input", ["click", "input", "change", "pointerup"],
      () => Object.keys(state.userOverrides).length > 0,
    )] },
  },
  {
    title: "Try to disprove the rule before you trust it",
    body: "A rule that has only ever been checked at its resting value has not been checked. Push an input to an extreme and ask whether the answer is still one you would defend. Then write down where the rule came from, so the next reader does not have to guess.",
    targetSelector: ".evidence-editor--formula",
    enter: () => enterEditExample(FORMULA_IDENTIFIER),
    task: { checkpoints: [tutorialCheckpoint(
      "calc-record-evidence", "Record where this formula came from in its evidence fields.",
      ".evidence-editor--formula input, .evidence-editor--formula select, .evidence-editor--formula textarea",
      ["change", "input"],
      (_event, snapshot) => JSON.stringify(nodeById[FORMULA_IDENTIFIER]?.formulaEvidence || {}) !== String(snapshot),
      () => JSON.stringify(nodeById[FORMULA_IDENTIFIER]?.formulaEvidence || {}),
      400,
    )] },
  },
];

const EDITING_STEPS: TutorialStep[] = [
  {
    title: "Switch from reading to editing",
    body: "Edit mode changes the map itself. Select a box to change its name, description, placement, tags, values, formula, evidence and outgoing links in the detail panel.",
    targetSelector: '#detail-panel [data-field="description"]',
    enter: () => enterEditExample(WORKSHOP_READINESS_IDENTIFIER),
    task: { checkpoints: [tutorialCheckpoint(
      "edit-box-field", "Change the box description or another editable field.",
      "#detail-panel [data-field]", ["input", "change"],
      (_event, snapshot) => captureMapModel() !== snapshot,
      captureMapModel,
    )] },
  },
];

const CANVAS_EDIT_STEPS: TutorialStep[] = [
  {
    title: "Create a box in an empty cell",
    body: "In Edit mode, click an empty map cell and name the new box. Its row and column come from that cell; use the detail panel to add meaning, values and tags.",
    targetSelector: "#viz-scroll",
    enter: () => enterEditExample(WORKSHOP_READINESS_IDENTIFIER),
    task: { checkpoints: [
      tutorialCheckpoint(
        "create-box", "Click an empty cell to create a temporary box.", "#viz-scroll", ["mouseup"],
        (_event, snapshot) => createdNodeIdentifiers(snapshot).length > 0,
        () => NODES.map(node => node.id),
      ),
      tutorialCheckpoint(
        "name-created-box", "Then type a name for the temporary box.", "body", ["keydown"],
        event => {
          const keyboardEvent = event as KeyboardEvent;
          return keyboardEvent.key.length === 1 && !keyboardEvent.metaKey && !keyboardEvent.ctrlKey && !keyboardEvent.altKey &&
            !!state.canvasEdit.inlineRename?.started &&
            (nodeById[state.canvasEdit.inlineRename.nodeId]?.label.trim() || "") !== "New box";
        },
      ),
    ] },
  },
  {
    title: "Delete the new box and undo",
    body: "Delete removes the selected box and its connected links in one change. Undo restores the whole change, so experimenting on the canvas remains recoverable.",
    targetSelector: '.node-group[aria-pressed="true"]',
    enter: () => {
      closeTutorialSurfaces();
      if (state.simulationMode) toggleSimulationMode();
      setUiMode("edit");
      render();
    },
    task: { checkpoints: [
      tutorialCheckpoint(
        "delete-created-box", "Press Delete to remove the selected box.", "body", ["keydown"],
        (event, snapshot) => {
          const keyboardEvent = event as KeyboardEvent;
          const deletionSnapshot = snapshot as { selectedNodeIdentifier: string; mapModel: string };
          return (keyboardEvent.key === "Delete" || keyboardEvent.key === "Backspace") &&
            !!deletionSnapshot.selectedNodeIdentifier && !nodeById[deletionSnapshot.selectedNodeIdentifier] &&
            captureMapModel() !== deletionSnapshot.mapModel;
        },
        () => ({
          selectedNodeIdentifier: state.selectedNodeId || "",
          mapModel: captureMapModel(),
        }),
      ),
      tutorialCheckpoint(
        "undo-delete", "Then press Command/Ctrl+Z to restore it.", "body", ["keydown"],
        (event, snapshot) => {
          const keyboardEvent = event as KeyboardEvent;
          return keyboardEvent.key.toLowerCase() === "z" && (keyboardEvent.metaKey || keyboardEvent.ctrlKey) &&
            captureMapModel() !== snapshot;
        },
        captureMapModel,
      ),
    ] },
  },
];

const LINK_EDIT_STEPS: TutorialStep[] = [
  {
    title: "Draw a link from cause to effect",
    body: "Drag from the handle on a box's right edge to the box it affects. The new link opens on the right straight away, so you can say what it means while you still remember why you drew it.",
    targetSelector: '.edge-handle[data-node-id="' + WORKSHOP_READINESS_IDENTIFIER + '"]',
    enter: () => enterEditExample(WORKSHOP_READINESS_IDENTIFIER),
    task: { checkpoints: [tutorialCheckpoint(
      "create-link", "Drag from the handle on the selected box's right edge to another box.", "#viz-scroll", ["mouseup"],
      (_event, snapshot) => captureEdgeModel() !== snapshot,
      captureEdgeModel,
    )] },
  },
  {
    title: "Edit the relationship, not just the line",
    body: "Expand an outgoing link to choose increases, decreases or enables; set Strength, solid or dashed style, a description and causal evidence. Delete removes only that relationship.",
    targetSelector: "#detail-panel .outgoing-edges-block",
    enter: () => enterEditExample(WORKSHOP_READINESS_IDENTIFIER),
    task: { checkpoints: [
      tutorialCheckpoint(
        "expand-outgoing-link", "Expand one outgoing link.", "#detail-panel [data-edge-open]", ["click"],
        () => !!state.canvasEdit.openEdgeId,
      ),
      tutorialCheckpoint(
        "edit-outgoing-link", "Then change its line style or description.",
        '#detail-panel [data-edge-field="style"], #detail-panel [data-edge-field="description"]', ["input", "change"],
        (_event, snapshot) => captureEdgeModel() !== snapshot,
        captureEdgeModel,
      ),
    ] },
  },
];

const STRUCTURE_WITH_BULK_EDIT_STEPS: TutorialStep[] = [
  {
    title: "Make rows and columns tell the story",
    body: "Rows group boxes by who owns or feels that part of the programme; columns describe how the work progresses. Bulk edit walks through them in order, because everything else refers back to them.",
    // The task is to advance Bulk edit, and that button is at the far bottom of the
    // dialog — the step heading sits ~950px away at the top.
    targetSelector: "#builder-next-button",
    enter: () => enterBulkEditExample(1),
    task: { checkpoints: [tutorialCheckpoint(
      "bulk-advance-step", "Click Next \u2192 at the bottom of Bulk edit.",
      // The footer holds Back/Next; the numbered tabs are .builder-step-dot[data-step].
      // This previously read ".builder-nav button, [data-builder-step]" — neither
      // selector exists in the app, so the checkpoint matched nothing and the step
      // could only be got past with Skip.
      ".builder-footer button, .builder-step-dot", ["click"],
      (_event, snapshot) => state.builder.step !== Number(snapshot),
      () => state.builder.step,
      300,
    )] },
  },
  {
    title: "Use categories for meaning, not decoration",
    body: "Primary categories set a box's fill; secondary categories add tags. Keep the set small and name the distinction readers need to make, such as resource, activity, outcome or access consideration.",
    targetSelector: ".builder-step-heading",
    enter: () => enterBulkEditExample(3),
  },
  {
    title: "Edit repeated fields as a table",
    body: "Boxes and links become a table you can sort and change in bulk, which is far quicker than opening them one at a time on the canvas. Constants get their own step because formulas refer to them by name. Sort or change something here.",
    // A sortable column header: it is literally what "sort a column" means, it sits
    // at the top of the table where it can be seen, and a click on it satisfies the
    // checkpoint's `.builder-table th`.
    //
    // NOT `.builder-table` itself. The thread is drawn to its target's centre, and
    // the boxes table is taller than the window, so the centre of the table lands
    // below the bottom edge and the thread trails off-screen pointing at nothing.
    // `scrollIntoView({block: "nearest"})` cannot rescue that — an element larger
    // than the viewport already counts as "nearest", so nothing scrolls.
    targetSelector: ".builder-th-sort",
    enter: () => enterBulkEditExample(4),
    task: { checkpoints: [tutorialCheckpoint(
      "bulk-table-interaction", "Sort a column or change a value in the table.",
      ".builder-table th, .builder-table input, .builder-table select", ["click", "change", "input"],
      (_event, snapshot) => JSON.stringify(cloneBuilderState(state.builder)) !== String(snapshot),
      () => JSON.stringify(cloneBuilderState(state.builder)),
      350,
    )] },
  },
  {
    title: "Finish only when validation is clear",
    body: "The final step summarises the model and blocks invalid references. Moving backwards keeps the working copy and closing Bulk edit preserves its unfinished draft.",
    targetSelector: ".builder-step-heading",
    enter: () => enterBulkEditExample(7),
  },
];

const MULTI_SELECT_STEPS: TutorialStep[] = [
  {
    title: "Select several boxes",
    body: "Shift-click boxes one at a time, or hold Shift and drag across empty space to sweep up everything inside the rectangle. Dragging any one of them then moves the whole group.",
    targetSelector: "#multi-select-bar",
    enter: () => {
      enterEditExample(WORKSHOP_READINESS_IDENTIFIER);
      setSelection([WORKSHOP_READINESS_IDENTIFIER, "delivery_capacity", "outreach_reach"], WORKSHOP_READINESS_IDENTIFIER);
      renderMultiSelectBar();
    },
    task: { checkpoints: [tutorialCheckpoint(
      "change-multi-selection", "Shift-click another box, or hold Shift and drag across empty space.",
      ".node-group, #viz-scroll", ["click", "mouseup"],
      (event, snapshot) => (event as MouseEvent).shiftKey && state.selectedNodeIds.size >= 2 &&
        selectedNodeIdentifiersSignature() !== snapshot,
      selectedNodeIdentifiersSignature,
    )] },
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
    task: { checkpoints: [tutorialCheckpoint(
      "move-selected-group", "Use the selection bar to move the group to a different row or column.",
      '#multi-select-bar [data-msb="stream"], #multi-select-bar [data-msb="stage"]', ["change"],
      (_event, snapshot) => state.selectedNodeIds.size >= 2 && captureSelectedNodesPlacement() !== snapshot,
      captureSelectedNodesPlacement,
    )] },
  },
];

// ───── Atlas while simulating ────────────────────────────────────────
// The same picture, answering a different question. Normally Atlas says where
// an effect COULD go; with the sliders out it says where a particular change
// DID go, where it stopped, and what stopped it. These run after the reading
// half, because none of it makes sense before you can read the picture at all.
const SIMULATION_ATLAS_STEPS: TutorialStep[] = [
  {
    title: "Ask the same picture a what-if question",
    body: "Everything so far shows where an effect <em>could</em> travel. Select <b>Simulate</b> in the Atlas bar and the picture starts answering a different question: where a particular change <em>did</em> travel. Atlas stays open and the legend gains three new lines. (You can also go the other way \u2014 change an input first, then open Atlas from any box\u2019s Actions.)",
    targetSelector: "#atlas-sim-toggle-button",
    enter: () => enterAtlasExample(FEEDBACK_START_IDENTIFIER),
    task: { checkpoints: [tutorialCheckpoint(
      "atlas-enter-simulation", "Select Simulate without leaving Atlas.",
      "#atlas-sim-toggle-button", ["click"],
      () => atlasIsOpen() && state.simulationMode,
    )] },
  },
  {
    title: "Read what the colours and numbers now say",
    body: "Nothing has moved yet, so every circle is grey. Change an input and each circle prints how far it moved \u2014 green better, red worse, amber moved either way, grey not at all. Size still means the same thing: how much runs through. Only the links the effect actually travelled stay drawn, so the picture thins to the routes that carried the change.",
    targetSelector: ".atlas-legend .sim-only",
    enter: () => enterSimulatingAtlasExample(FEEDBACK_START_IDENTIFIER),
    task: { checkpoints: [tutorialCheckpoint(
      "atlas-move-an-input", "Change any input and watch the circles take on numbers.",
      ".sim-slider-row input", ["input", "change", "pointerup"],
      () => Object.keys(state.userOverrides).length > 0,
    )] },
  },
  {
    title: "Find where the change stopped",
    body: "A bar drawn across a circle means the change <b>reached it and stopped</b> \u2014 nothing beyond it is drawn. Instead of a number, that circle names what is holding it. Add 50% more Facilitator capacity here and the change gets exactly one step: <b>Delivery capacity</b> stalls, labelled <em>held by Venue availability</em>, because sessions need a room as well as a facilitator. That is this programme\u2019s own question answered in one picture \u2014 more facilitators will not serve more residents while venues are what is short.",
    // Nothing is held until the reader moves something, so the thread starts on
    // the slider they have to move. Once that checkpoint is done the runner
    // moves it to the circles, where the held one is.
    targetSelector: '.sim-slider-row[data-node-id="facilitator_slots"]',
    enter: () => enterSimulatingAtlasExample("facilitator_slots"),
    task: { checkpoints: [
      tutorialCheckpoint(
        "atlas-raise-facilitators", "Raise Facilitator capacity above its starting value.",
        '.sim-slider-row[data-node-id="facilitator_slots"] input', ["input", "change", "pointerup"],
        () => simulationInputIsAwayFromBaseline("facilitator_slots"),
      ),
      tutorialCheckpoint(
        "atlas-select-held-circle", "Select the circle that says what is holding it.",
        ".atlas g.n[data-el]", ["click"],
        event => eventTargetClosest(event, ".atlas g.n.held") !== null,
      ),
    ] },
  },
];

const ATLAS_STEPS: TutorialStep[] = [
  {
    title: "Open Atlas from a starting box",
    body: "Atlas shows every route that an effect can take from one starting box. Community confidence is selected for you. Under Actions for this box, select Atlas — Follow every pathway out. On your own map, start with the box that best represents the question you want to explore.",
    targetSelector: '[data-action="open-atlas"]',
    enter: () => {
      enterReadingSurface();
      focusTutorialNode(FEEDBACK_START_IDENTIFIER);
    },
    task: { checkpoints: [tutorialCheckpoint(
      "open-atlas", "Select Atlas under Actions for this box.",
      '[data-action="open-atlas"]', ["click"],
      () => atlasIsOpen(),
    )] },
  },
  {
    title: "Explore the Atlas picture",
    body: "Each circle is a box, or a group of boxes in a feedback loop, that the starting box can reach. A circle\u2019s area is the share of all the routes that run through it, so the big ones are where most of the effect passes. Select any circle to highlight every route through it; the sidebar narrows to match. This says where the circle sits, not which single route to read.",
    targetSelector: ".atlas g.n[data-el] > circle.bub",
    enter: () => enterAtlasExample(FEEDBACK_START_IDENTIFIER),
    task: { checkpoints: [tutorialCheckpoint(
      "select-atlas-element", "Select any circle in the Atlas picture.",
      ".atlas g.n[data-el]", ["click"],
      () => (captureAtlasSessionState()?.reading.roots.length || 0) > 0,
    )] },
  },
  {
    title: "Read a grouped circle carefully",
    body: "Atlas may put similarly named boxes into one circle, marked with ◇ and a count such as ×3. This only saves space: Atlas does not combine their calculations. Boxes are grouped only when their routes continue in the same way. Open the group in the sidebar and choose a named box when you need its exact route.",
    targetSelector: ".atlas-group-legend",
    enter: () => enterAtlasExample(FEEDBACK_START_IDENTIFIER),
  },
  {
    title: "Frame the Atlas view",
    body: "Drag empty space to pan. Use − and + to inspect a crowded area, then select the percentage readout to fit the whole picture again. These controls change the view only; they do not change the model or the pathway you have selected.",
    targetSelector: "#atlas-zoom-readout",
    enter: () => enterAtlasExample(FEEDBACK_START_IDENTIFIER),
    task: { checkpoints: [tutorialCheckpoint(
      "fit-atlas-picture", "Select the percentage readout to fit the complete Atlas picture.",
      '#atlas-zoom-readout[data-atlas-zoom="fit"]', ["click"],
      event => eventTargetClosest(event, '#atlas-zoom-readout[data-atlas-zoom="fit"]') !== null,
    )] },
  },
  {
    title: "Isolate one pathway in the sidebar",
    body: "The sidebar groups routes first by destination: the box where a route ends. Select a destination, then select each ‘via’ row that the route passes through until the footer says 1 pathway drawn. Hover over a row to preview it; select the row to keep that choice.",
    targetSelector: "#detail-content [data-fork]",
    enter: () => {
      if (captureAtlasSessionState()?.startId !== FEEDBACK_START_IDENTIFIER) {
        enterAtlasExample(FEEDBACK_START_IDENTIFIER);
      }
    },
    task: { checkpoints: [tutorialCheckpoint(
      "isolate-atlas-pathway", "Use the sidebar rows until exactly one pathway is drawn.",
      "#detail-content [data-fork]", ["click"],
      () => atlasSelectedPathwayCount() === 1,
    )] },
  },
  {
    title: "Open a feedback loop",
    body: "A circular ↻ group is a feedback loop: a later result eventually changes an earlier cause. Select the feedback group, then choose Open feedback loops. Atlas separates the routes inside the group so you can inspect one reinforcing loop, which adds to change, or one balancing loop, which limits change.",
    targetSelector: ".atlas g.n[data-loop]",
    enter: () => enterAtlasExample(FEEDBACK_START_IDENTIFIER),
    task: { checkpoints: [
      tutorialCheckpoint(
        "select-feedback-group", "Select the circular feedback group in the Atlas picture.",
        '.atlas g.n[data-loop]', ["click"],
        () => !!document.querySelector("[data-open-feedback]"),
      ),
      tutorialCheckpoint(
        "open-feedback-loops", "Choose Open feedback loops to enter the feedback navigator.",
        "[data-open-feedback]", ["click"],
        () => !!captureAtlasSessionState()?.reading.inside,
      ),
    ] },
  },
  {
    title: "Play and scrub a feedback route",
    body: "Select Play to reveal the feedback route one box and link at a time. Use Previous and Next to move one box at a time. You can also change the speed, pause, or drag the position control to inspect a long loop at your own pace.",
    targetSelector: "#atlas-loopctl",
    enter: () => enterAtlasExample(FEEDBACK_START_IDENTIFIER, true),
    task: { checkpoints: [tutorialCheckpoint(
      "control-feedback-route", "Pause, step, change speed or scrub the feedback route.",
      "#atlas-loopctl button, #atlas-loopctl select, #atlas-loopctl input", ["click", "input", "change"],
      (_event, snapshot) => captureFeedbackPlaybackControls() !== snapshot,
      captureFeedbackPlaybackControls,
    )] },
  },
  {
    title: "Change the starting question",
    body: "Atlas answers: ‘Where could an effect from this box travel?’ Select Change starting box in the header to ask that question about another box. The menu suggests boxes with useful routes. You can also return to the map, select any box and open Atlas from its Actions.",
    targetSelector: "#atlas-button",
    enter: () => enterAtlasExample(FEEDBACK_START_IDENTIFIER),
    task: { checkpoints: [
      tutorialCheckpoint(
        "open-atlas-start-menu", "Open Change starting box in the header.",
        "#atlas-button", ["click"],
        () => !document.getElementById("atlas-menu")?.hidden,
      ),
      tutorialCheckpoint(
        "change-atlas-start", "Choose another starting box from the menu.",
        "[data-atlas-start]", ["click"],
        () => captureAtlasSessionState()?.startId !== FEEDBACK_START_IDENTIFIER,
      ),
    ] },
  },
];

const REVIEW_EVIDENCE_STEPS: TutorialStep[] = [
  {
    title: "Separate model warnings from assurance",
    body: "Review is one list down the left of everything the map still owes you: what the loader noticed, what somebody flagged, boxes nobody has checked, claims with no source recorded, and what a nudge on each adjustable input actually does. The chips narrow it to one kind. A warning means look at this. Hypothesis and Unspecified mean nobody has recorded a source yet — that is a gap in the evidence, not a mistake in the maths.",
    targetSelector: "#review-sidebar",
    enter: () => {
      enterReadingSurface();
      openReview();
      setReviewFilter("all");
    },
  },
  {
    title: "Compare formula and link evidence",
    body: "Formula evidence supports the mathematical form or parameters. Link evidence supports the causal claim. The queue lists the gaps; switch the picker to a status to read the whole inventory and find assumptions that need research, calibration or validation.",
    targetSelector: ".review-evidence-filter .typeable-dropdown-button",
    enter: () => {
      enterReadingSurface();
      openReview();
      setReviewFilter("evidence");
    },
    task: { checkpoints: [tutorialCheckpoint(
      "filter-evidence", "Filter the evidence inventory to one assurance status.", "#review-evidence-filter", ["change"],
      (event, snapshot) => (eventTargetClosest(event, "#review-evidence-filter") as HTMLSelectElement | null)?.value !== snapshot,
      () => (document.getElementById("review-evidence-filter") as HTMLSelectElement | null)?.value || "",
    )] },
  },
  {
    title: "Record where each claim came from",
    body: "In Edit mode, each formula and link can carry a status, rationale, source and last-reviewed date. Those fields travel with the spreadsheet and remain visible to reviewers without cluttering the map itself.",
    targetSelector: ".evidence-editor--formula",
    enter: () => enterEditExample(FORMULA_IDENTIFIER),
  },
];

const SENSITIVITY_SWEEP_STEPS: TutorialStep[] = [
  {
    title: "Nudge one adjustable input at a time",
    body: "Review's sensitivity sweep raises each adjustable input by the same percentage while every other input stays at baseline. The Odd inputs chip opens on the handful that behave strangely; the picker above the list swaps that for every adjustable box ranked by how far a nudge on it carries, with its biggest movers beside it.",
    targetSelector: ".review-evidence-filter .typeable-dropdown-button",
    enter: () => {
      enterReadingSurface();
      openReview();
      setReviewFilter("input");
      setReviewRecord("odd");
    },
    task: { checkpoints: [tutorialCheckpoint(
      "open-sensitivity-list", "Switch the picker to every adjustable box, by reach.",
      "#review-evidence-filter", ["change"],
      () => (document.getElementById("review-evidence-filter") as HTMLSelectElement | null)
        ?.value === "reach",
    )] },
  },
  {
    title: "A sweep is a clue, not a proof",
    body: "An input that changes nothing might be held back by a cap, might not be connected to anything, or might genuinely not matter. An input that swamps everything else might be right, or its Strength might simply be set too high. The sweep tells you how the model behaves. It cannot tell you whether the model is true.",
    targetSelector: "#review-list",
    enter: () => {
      enterReadingSurface();
      openReview();
      setReviewFilter("input");
      setReviewRecord("reach");
    },
  },
];

function enterAutomaticReviewExample(): void {
  // The example map carries its own imperfections — links whose evidence was
  // never recorded, a review date years out of date — so Review finds something
  // real here rather than a fault the lesson planted a moment earlier.
  enterReadingSurface();
  openReview();
  // Every step establishes its own surface rather than inheriting the last
  // one's. Without this, arriving here from the sensitivity steps left the list
  // showing the ranked sweep — whose rows are navigation, not questions — and
  // this step is about picking a question.
  setReviewFilter("all");
}

const AUTOMATIC_REVIEW_STEPS: TutorialStep[] = [
  {
    title: "Let Review find the problems for you",
    body: "Review reads the whole map and reports what does not hold up: rules it cannot follow, boxes that no longer rest where they say they do, bounds quietly changing an answer, and claims nobody ever recorded a source for. This map has real gaps in it — Review will show you where.",
    targetSelector: ".review-row[data-review-item]",
    enter: () => enterAutomaticReviewExample(),
  },
  {
    title: "Inspect a finding before you act on it",
    body: "Each finding names a box and says what was noticed \u2014 an input that changes nothing, a box no input can reach, a claim with no source recorded. None of that means the model is wrong. Pick one: the map goes to its box, the question moves to the box panel on the right, and the list stays where it is.",
    targetSelector: ".review-row[data-review-item]",
    enter: () => enterAutomaticReviewExample(),
    task: { checkpoints: [tutorialCheckpoint(
      "open-review-finding-on-map", "Pick an item to open it on the map.",
      ".review-row[data-review-item]", ["click"],
      () => reviewItemIsCurrent(),
    )] },
  },
];

const HUMAN_REVIEW_STEPS: TutorialStep[] = [
  {
    title: "Start a signed box-by-box pass",
    body: "Enter your full name, then start the pass. " + appName() + " asks whether each box has the right and complete set of causes, moving through the model in a consistent order.",
    targetSelector: "#review-reviewer",
    enter: () => {
      enterReadingSurface();
      openReview();
    },
    task: { checkpoints: [
      tutorialCheckpoint(
        "enter-reviewer-name", "Enter your full name.", "#review-reviewer", ["input"],
        () => reviewerNamed(),
      ),
      tutorialCheckpoint(
        "start-review-pass", "Then start the review pass.",
        '[data-review-action="start"]', ["click"],
        () => !!state.reviewPass,
      ),
    ] },
  },
  {
    title: "Agree, flag or skip with a note",
    body: "Agree records that you are satisfied, Flag keeps the box on the list to come back to, and Skip moves on without deciding. Your name, the date, your notes and how a flag was settled all travel with the map. If somebody later changes a box you agreed to, it comes back for review.",
    targetSelector: "#detail-panel .rv-verdicts",
    enter: () => {
      enterReadingSurface();
      renderDetailPanel();
    },
    task: { checkpoints: [tutorialCheckpoint(
      "record-review-action", "Choose Agreed, Flag or Skip for this box.",
      '#detail-panel [data-review="agree"], #detail-panel [data-review="flag"], #detail-panel [data-review="skip"]', ["click"],
      (event, snapshot) => {
        const action = eventTargetClosest(event, "[data-review]")?.getAttribute("data-review") || "";
        if (action === "skip") {
          return state.selectedNodeId !== (JSON.parse(String(snapshot)) as { selectedNodeId: string | null }).selectedNodeId;
        }
        return captureSelectedReviewState() !== snapshot;
      },
      captureSelectedReviewState,
    )] },
  },
];

const PROTECT_EDITABLE_SOURCE_STEPS: TutorialStep[] = [
  {
    title: "Know what the browser remembers",
    body: "" + appName() + " autosaves the current map, view choices and unfinished Bulk edit draft in this browser. Autosave is convenient recovery, not a substitute for downloading the Spreadsheet source before important work or moving devices.",
    targetSelector: ".header-document-actions",
    enter: () => {
      enterReadingSurface();
      setExportMenuOpen(false);
    },
  },
  {
    title: "Use the Spreadsheet as the editable source",
    body: "The spreadsheet holds a sheet for each part of the map: rows, columns, categories, defaults, constants, boxes, links and review records. Evidence gets its own columns, and the choices a column allows are dropdowns, so nothing is lost or mistyped when the file goes out and comes back.",
    targetSelector: ".save-data-trigger",
    enter: () => {
      enterReadingSurface();
      openExportMenuForTutorialStep();
    },
  },
  {
    title: "Import deliberately",
    body: "Importing a file, or dropping one onto the window, checks it and then replaces whatever is open. There is no merge. If what is open now is the copy you need, download it first.",
    targetSelector: ".import-data-trigger",
    enter: () => {
      enterReadingSurface();
      setExportMenuOpen(false);
    },
  },
];

const SHARE_FOR_AUDIENCE_STEPS: TutorialStep[] = [
  {
    title: "Share the editable Spreadsheet",
    body: "Send the Spreadsheet when someone needs to keep building the map or check it properly. It carries the formulas, links, evidence and review records — everything an image or a web page leaves behind. Open the menu these choices live in.",
    targetSelector: "#export-button",
    enter: () => {
      enterReadingSurface();
      setExportMenuOpen(false);
    },
    task: { checkpoints: [tutorialCheckpoint(
      "share-open-export-menu", "Open the export menu.", "#export-button", ["click"],
      () => !document.getElementById("export-menu")?.hasAttribute("hidden"),
      undefined,
      300,
    )] },
  },
  {
    title: "Frame the view before you export an image",
    body: "An image captures the map exactly as it looks right now — the same zoom, the same position, the same filters. That makes framing part of the export, not something to fix afterwards. Fit the map first, so the picture starts from the whole story.",
    targetSelector: "#viz-zoom-readout",
    enter: () => {
      enterReadingSurface();
      setExportMenuOpen(false);
      setNavigationControlMode("zoom");
    },
    task: { checkpoints: [tutorialCheckpoint(
      "share-frame-view", "Use the percentage button to fit the map.", "#viz-zoom-readout", ["click"],
      (_event, snapshot) => document.getElementById("viz-zoom-readout")?.getAttribute("data-fit-next") !== snapshot,
      () => document.getElementById("viz-zoom-readout")?.getAttribute("data-fit-next") || "height",
      350,
    )] },
  },
  {
    title: "Export a view-only interactive web page",
    body: "Web page creates one self-contained HTML file. Recipients can pan, zoom and hover without editing or needing " + appName() + " installed; send the Spreadsheet too if they must continue the model.",
    targetSelector: ".publish-html-trigger",
    enter: () => {
      enterReadingSurface();
      openExportMenuForTutorialStep();
    },
  },
  {
    title: "Export the assurance record",
    body: "Review log creates a CSV of every box, its verdict, reviewer, date, comments and whether a flag was addressed. It is for governance and follow-up; it does not replace the model Spreadsheet.",
    targetSelector: ".export-review-log-trigger",
    enter: () => {
      enterReadingSurface();
      openExportMenuForTutorialStep();
    },
  },
];

// ───── Lesson composition ────────────────────────────────────────────
// Order inside each lesson is deliberate: what you are looking at comes before
// how to move around it, and every lesson ends on something the learner did.

// Meaning first, then movement. Reading the rows, columns, boxes and links is
// what makes zooming and panning worth doing, so the grammar steps lead.
const READ_A_MAP_STEPS: TutorialStep[] = [
  ...MAP_STRUCTURE_STEPS,
  ...MOVE_AROUND_MAP_STEPS,
  ...CAUSE_EFFECT_STEPS,
  ...SEARCH_FILTER_STEPS,
];

const ASK_WHAT_IF_STEPS: TutorialStep[] = [
  ...SIMULATION_STEPS,
  ...CALCULATION_TRACE_STEPS,
];

// Reading the picture comes first. The lesson used to open on the simulating
// variant, which asked the reader to combine two surfaces before they had seen
// either one on its own.
const FOLLOW_PATHWAYS_STEPS: TutorialStep[] = [
  ...ATLAS_STEPS,
  ...SIMULATION_ATLAS_STEPS,
];

// Switching to Edit belongs here rather than in the first lesson, where there
// was nothing yet to edit and the drill had no point.
const BUILD_A_MAP_STEPS: TutorialStep[] = [
  ...MODE_SAFETY_STEPS,
  ...EDITING_STEPS,
  ...CANVAS_EDIT_STEPS,
  ...LINK_EDIT_STEPS,
  ...STRUCTURE_WITH_BULK_EDIT_STEPS,
  ...MULTI_SELECT_STEPS,
];

const CHECK_A_MAP_STEPS: TutorialStep[] = [
  ...REVIEW_EVIDENCE_STEPS,
  ...AUTOMATIC_REVIEW_STEPS,
  ...SENSITIVITY_SWEEP_STEPS,
  ...HUMAN_REVIEW_STEPS,
];

// Keeping your own copy safe is the same subject as handing one to somebody
// else, so both live here instead of being split across the curriculum.
const SHARE_AND_KEEP_STEPS: TutorialStep[] = [
  ...SHARE_FOR_AUDIENCE_STEPS,
  ...PROTECT_EDITABLE_SOURCE_STEPS,
];

export const LEARN_LESSONS: LearnLesson[] = [
  {
    id: FIRST_LESSON_ID, groupId: "start", mapSize: "small",
    title: "First look",
    summary: "See what a systems map answers: read one, change one thing, follow what happens.",
    duration: "5 steps · about 3 minutes",
    steps: FIRST_LOOK_STEPS, prerequisiteLessonIds: [],
    recommendedNextLessonId: "read-a-map",
    recap: [
      "Read a map as boxes that can go up or down, joined by what affects what",
      "Change a starting value and watch the consequences spread",
      "Put everything back to where it started",
    ],
    tryOnYourOwnMap: "Open your own map and pick the one box you most want to move. Everything else follows from that.",
  },
  {
    id: "read-a-map", groupId: "read", mapSize: "full",
    title: "Read a map",
    summary: "What the rows, columns, boxes and links mean, how to move around, and how to find and hide things.",
    duration: "11 steps · about 12 minutes",
    steps: READ_A_MAP_STEPS, prerequisiteLessonIds: [],
    recommendedNextLessonId: "ask-what-if",
    recap: [
      "Tell rows, columns, boxes, links and tags apart at a glance",
      "Zoom, move around and frame the whole map again",
      "Follow what drives a box and what it drives in turn",
      "Search for a box, and hide what you are not reading without deleting it",
    ],
    tryOnYourOwnMap: "Open a map somebody sent you and fold away every row except the one you own.",
  },
  {
    id: "ask-what-if", groupId: "read", mapSize: "full",
    title: "Ask what-if",
    summary: "Change a starting value, follow the consequences, and read how each number was worked out.",
    duration: "6 steps · about 8 minutes",
    steps: ASK_WHAT_IF_STEPS, prerequisiteLessonIds: ["read-a-map"],
    recommendedNextLessonId: "follow-pathways",
    recap: [
      "Move a starting value and see what it changes downstream",
      "Read the full working behind any calculated box",
      "Reset between questions so one experiment does not affect the next",
    ],
    tryOnYourOwnMap: "Take the change your team is actually arguing about and put it through the sliders.",
  },
  {
    id: "follow-pathways", groupId: "read", mapSize: "full",
    title: "Follow every pathway",
    summary: "Read every route an effect can take, follow the loops that feed back, then simulate over the same picture.",
    duration: "11 steps · about 15 minutes",
    steps: FOLLOW_PATHWAYS_STEPS, prerequisiteLessonIds: ["ask-what-if"],
    recommendedNextLessonId: "build-a-map",
    recap: [
      "See every route an effect can take out of one box, and how much runs through each",
      "Narrow a crowded picture down to a single pathway",
      "Open a feedback loop and step through it one box at a time",
      "Simulate over the same picture, and find where a change stopped and what held it",
    ],
    tryOnYourOwnMap: "Start Atlas from the box that represents your goal and see how many ways there actually are to reach it.",
  },
  {
    id: "build-a-map", groupId: "build", mapSize: "full",
    title: "Build a map",
    summary: "Create boxes, draw links, say what each relationship means, and shape the rows and columns.",
    duration: "13 steps · about 16 minutes",
    steps: BUILD_A_MAP_STEPS, prerequisiteLessonIds: ["read-a-map"],
    recommendedNextLessonId: "make-it-calculate",
    recap: [
      "Switch between View and Edit, and know which one changes the map",
      "Create a box, delete it, and undo the whole change",
      "Draw a link and say whether it increases, decreases or enables",
      "Change many boxes at once, on the canvas or as a table",
    ],
    tryOnYourOwnMap: "Sketch the five boxes you would need to explain your work to somebody new. Add links last.",
  },
  {
    id: "make-it-calculate", groupId: "build", mapSize: "full",
    title: "Make it calculate",
    summary: "Choose how each box works out its number: combine rules, formulas, caps, guardrails and delays.",
    duration: "8 steps · about 12 minutes",
    steps: MAKE_IT_CALCULATE_STEPS, prerequisiteLessonIds: ["build-a-map"],
    recommendedNextLessonId: "check-a-map",
    recap: [
      "Tell a box that is worked out from a sum apart from one that is estimated",
      "Choose between Standard, Additive and Weakest link, and see the difference",
      "Cap a result, put guardrails on it, and delay a feedback loop",
      "Check a rule reproduces its starting value before trusting it",
    ],
    tryOnYourOwnMap: "Find the box in your map you would least like to defend, and write down where its number comes from.",
  },
  {
    id: "check-a-map", groupId: "trust", mapSize: "full",
    title: "Check a map you trust",
    summary: "Read the evidence behind each claim, let Review find the gaps, test how the model behaves, and sign a pass.",
    duration: "9 steps · about 15 minutes",
    steps: CHECK_A_MAP_STEPS, prerequisiteLessonIds: ["make-it-calculate"],
    recommendedNextLessonId: "share-and-keep",
    recap: [
      "Tell a warning about the model apart from a gap in its evidence",
      "Let Review find real problems, and check them before acting",
      "Nudge every input in turn to see which ones actually matter",
      "Record a signed, dated judgement that travels with the map",
    ],
    tryOnYourOwnMap: "Run Review on your own map before the next time you show it to anybody.",
  },
  {
    id: "share-and-keep", groupId: "trust", mapSize: "full",
    title: "Share and keep your work",
    summary: "Hand the map to somebody else as a spreadsheet, image, web page or review log — and keep your own copy safe.",
    duration: "7 steps · about 8 minutes",
    steps: SHARE_AND_KEEP_STEPS, prerequisiteLessonIds: [],
    recap: [
      "Choose the right thing to send: spreadsheet, image, web page or review log",
      "Frame the view before exporting a picture of it",
      "Know what this browser remembers, and what it does not",
      "Download your own copy before importing over it",
    ],
    tryOnYourOwnMap: "Download your map now. Autosave is recovery, not a backup.",
  },
];

// The first lesson's steps, kept exported for tests that walk a lesson end to end.
export const TUTORIAL_STEPS = FIRST_LOOK_STEPS;

// First look teaches on a small map, so a newcomer's first screen is readable
// whole. Everything after it needs the larger map's scale, stages, formula
// variety and feedback loops.
function tutorialMapCsvFor(lesson: LearnLesson): string {
  return lesson.mapSize === "small" ? TUTORIAL_MAP_SMALL_CSV : TUTORIAL_MAP_CSV;
}

function loadTutorialMapForLesson(lesson: LearnLesson): boolean {
  return loadDataFromCsv(tutorialMapCsvFor(lesson), { persist: false });
}

function currentLesson(): LearnLesson {
  const lessonIdentifier = tutorialSession?.currentLessonId || FIRST_LESSON_ID;
  return LEARN_LESSONS.find(lesson => lesson.id === lessonIdentifier) || LEARN_LESSONS[0];
}

function emptyLearnProgress(): LearnProgress {
  return {
    curriculumVersion: LEARN_CURRICULUM_VERSION,
    completedLessonIds: [],
    lastLessonId: null,
    lastStepIndex: 0,
    completedCheckpointIdentifiersByLesson: {},
  };
}

export function loadLearnProgress(): LearnProgress {
  try {
    const storedProgress = localStorage.getItem(LEARN_PROGRESS_KEY);
    if (!storedProgress) return emptyLearnProgress();
    const parsedProgress = JSON.parse(storedProgress) as Partial<LearnProgress>;
    // Lessons were split, merged and renamed for this curriculum, so a step index
    // saved against an older one no longer points at the same teaching. Progress
    // from a superseded curriculum starts fresh rather than resuming somewhere
    // arbitrary.
    if (parsedProgress.curriculumVersion !== LEARN_CURRICULUM_VERSION) return emptyLearnProgress();
    const knownLessonIdentifiers = new Set(LEARN_LESSONS.map(lesson => lesson.id));
    const storedCompletedLessonIdentifiers = Array.isArray(parsedProgress.completedLessonIds)
      ? parsedProgress.completedLessonIds.filter(identifier =>
          typeof identifier === "string" && knownLessonIdentifiers.has(identifier))
      : [];
    const storedLastLessonIdentifier = typeof parsedProgress.lastLessonId === "string" &&
      knownLessonIdentifiers.has(parsedProgress.lastLessonId)
      ? parsedProgress.lastLessonId : null;
    const lastLesson = storedLastLessonIdentifier
      ? LEARN_LESSONS.find(lesson => lesson.id === storedLastLessonIdentifier) : undefined;
    const storedLastStepIndex = Number.isInteger(parsedProgress.lastStepIndex)
      ? Math.max(0, parsedProgress.lastStepIndex as number) : 0;
    const lastStepIndex = lastLesson
      ? Math.min(storedLastStepIndex, lastLesson.steps.length - 1)
      : 0;
    const completedCheckpointIdentifiersByLesson: Record<string, Record<string, string[]>> = {};
    const storedCheckpointProgress = parsedProgress.completedCheckpointIdentifiersByLesson;
    if (storedCheckpointProgress && typeof storedCheckpointProgress === "object") {
      for (const [lessonIdentifier, storedLessonProgress] of Object.entries(storedCheckpointProgress)) {
        if (!storedLessonProgress || typeof storedLessonProgress !== "object") continue;
        const lesson = LEARN_LESSONS.find(candidate => candidate.id === lessonIdentifier);
        if (!lesson) continue;
        const validStepProgress: Record<string, string[]> = {};
        for (const [storedStepIndexText, storedIdentifiers] of Object.entries(storedLessonProgress)) {
          if (!Array.isArray(storedIdentifiers)) continue;
          const stepIndex = Number(storedStepIndexText);
          if (!Number.isInteger(stepIndex)) continue;
          const step = lesson.steps[stepIndex];
          if (!step?.task) continue;
          const validIdentifiers = new Set(step.task.checkpoints.map(checkpoint => checkpoint.identifier));
          validStepProgress[String(stepIndex)] = storedIdentifiers.filter(identifier =>
            typeof identifier === "string" && validIdentifiers.has(identifier));
        }
        completedCheckpointIdentifiersByLesson[lesson.id] = validStepProgress;
      }
    }
    return {
      curriculumVersion: LEARN_CURRICULUM_VERSION,
      completedLessonIds: storedCompletedLessonIdentifiers,
      lastLessonId: storedLastLessonIdentifier,
      lastStepIndex,
      completedCheckpointIdentifiersByLesson,
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

function rememberCheckpointCompletion(lessonIdentifier: string, stepIndex: number, checkpointIdentifier: string): void {
  const progress = loadLearnProgress();
  const lessonProgress = progress.completedCheckpointIdentifiersByLesson[lessonIdentifier] || {};
  const stepKey = String(stepIndex);
  const completedIdentifiers = lessonProgress[stepKey] || [];
  if (!completedIdentifiers.includes(checkpointIdentifier)) completedIdentifiers.push(checkpointIdentifier);
  lessonProgress[stepKey] = completedIdentifiers;
  progress.completedCheckpointIdentifiersByLesson[lessonIdentifier] = lessonProgress;
  saveLearnProgress(progress);
}

function clearRememberedCheckpoints(lessonIdentifier: string): void {
  const progress = loadLearnProgress();
  delete progress.completedCheckpointIdentifiersByLesson[lessonIdentifier];
  saveLearnProgress(progress);
}

function lessonTitle(lessonIdentifier: string): string {
  return LEARN_LESSONS.find(lesson => lesson.id === lessonIdentifier)?.title || lessonIdentifier;
}

function missingPrerequisiteLessonIds(lesson: LearnLesson, progress: LearnProgress): string[] {
  const completedLessonIdentifiers = new Set(progress.completedLessonIds);
  return lesson.prerequisiteLessonIds.filter(identifier => !completedLessonIdentifiers.has(identifier));
}

function recommendedLessonId(progress: LearnProgress): string | null {
  if (progress.lastLessonId && !progress.completedLessonIds.includes(progress.lastLessonId)) {
    return progress.lastLessonId;
  }
  const lastCompletedLesson = progress.lastLessonId
    ? LEARN_LESSONS.find(lesson => lesson.id === progress.lastLessonId) : null;
  const recommendedNextLessonIdentifier = lastCompletedLesson?.recommendedNextLessonId;
  if (recommendedNextLessonIdentifier && !progress.completedLessonIds.includes(recommendedNextLessonIdentifier)) {
    return recommendedNextLessonIdentifier;
  }
  return LEARN_LESSONS.find(lesson =>
    !progress.completedLessonIds.includes(lesson.id) &&
    missingPrerequisiteLessonIds(lesson, progress).length === 0,
  )?.id || null;
}

function lessonCardMarkup(
  lesson: LearnLesson,
  lessonIndex: number,
  progress: LearnProgress,
  recommendedIdentifier: string | null,
): string {
  const completed = progress.completedLessonIds.includes(lesson.id);
  const rememberedLessonCheckpoints = progress.completedCheckpointIdentifiersByLesson[lesson.id] || {};
  const hasRememberedCheckpoint = Object.values(rememberedLessonCheckpoints).some(identifiers => identifiers.length > 0);
  const resumable = progress.lastLessonId === lesson.id && !completed &&
    (progress.lastStepIndex > 0 || hasRememberedCheckpoint);
  const recommended = !completed && lesson.id === recommendedIdentifier;
  const progressLabel = completed ? "Completed" : resumable ? "In progress" : recommended ? "Recommended next" : "Not started";
  const actionLabel = completed ? "Restart lesson" : resumable ? "Resume" : "Start lesson";
  const tutorialAction = completed ? "restart-lesson" : "lesson";
  const missingPrerequisiteIdentifiers = missingPrerequisiteLessonIds(lesson, progress);
  const guidance = !completed && missingPrerequisiteIdentifiers.length
    ? '<div class="learn-lesson-guidance">Best after: ' + missingPrerequisiteIdentifiers.map(lessonTitle).join(", ") + "</div>"
    : "";
  const stateClasses = (completed ? " is-complete" : "") + (recommended ? " is-recommended" : "");
  return '<article class="learn-lesson-card' + stateClasses + '" data-lesson-card="' + lesson.id + '">' +
    '<div class="learn-lesson-sequence" aria-hidden="true"><span>' + (lessonIndex + 1) + "</span></div>" +
    '<div class="learn-lesson-copy"><div class="learn-lesson-status">' + progressLabel + "</div>" +
    "<h2>" + lesson.title + "</h2><p>" + lesson.summary + "</p>" + guidance + "</div>" +
    '<div class="learn-lesson-details"><div class="learn-lesson-meta">' + lesson.duration + "</div>" +
    '<div class="learn-lesson-actions"><button class="tutorial-button' + (resumable || recommended ? " tutorial-button--primary" : "") + '" data-tutorial-action="' + tutorialAction + '" data-lesson-id="' + lesson.id + '">' + actionLabel + "</button></div>" +
    "</div></article>";
}

function heroLessonCardMarkup(lesson: LearnLesson, progress: LearnProgress): string {
  const completed = progress.completedLessonIds.includes(lesson.id);
  const actionLabel = completed ? "Take it again" : "Start here";
  const tutorialAction = completed ? "restart-lesson" : "lesson";
  return '<article class="learn-hero-card' + (completed ? " is-complete" : "") + '" data-lesson-card="' + lesson.id + '">' +
    '<div class="learn-hero-copy"><div class="learn-lesson-status">' +
    (completed ? "Completed" : "New here?") + "</div>" +
    "<h2>" + lesson.title + "</h2><p>" + lesson.summary + "</p></div>" +
    '<div class="learn-hero-details"><div class="learn-lesson-meta">' + lesson.duration + "</div>" +
    '<button class="tutorial-button tutorial-button--primary" data-tutorial-action="' + tutorialAction +
    '" data-lesson-id="' + lesson.id + '">' + actionLabel + "</button></div></article>";
}

export function openLearnHub(): boolean {
  if (tutorialSession) exitTutorial({ markDismissed: false });
  setExportMenuOpen(false);
  const layer = tutorialLayer();
  if (!layer) return false;
  const progress = loadLearnProgress();
  const completedCount = progress.completedLessonIds.length;
  const hasProgress = completedCount > 0 || !!progress.lastLessonId ||
    Object.keys(progress.completedCheckpointIdentifiersByLesson).length > 0;
  const recommendedIdentifier = recommendedLessonId(progress);
  const heroLesson = LEARN_LESSONS.find(lesson => lesson.groupId === "start");
  const heroMarkup = heroLesson ? heroLessonCardMarkup(heroLesson, progress) : "";

  // Grouped by the reason somebody opened the app rather than as one long
  // chain, so a reader who only ever needs to read a map is not told to spend
  // an hour first.
  let lessonNumber = 0;
  const groupsMarkup = LEARN_GROUPS
    .filter(group => group.id !== "start")
    .map(group => {
      const lessons = LEARN_LESSONS.filter(lesson => lesson.groupId === group.id);
      if (!lessons.length) return "";
      const cards = lessons.map(lesson =>
        lessonCardMarkup(lesson, lessonNumber++, progress, recommendedIdentifier),
      ).join("");
      return '<section class="learn-group"><h2 class="learn-group-heading">' + group.title + "</h2>" +
        '<div class="learn-group-lessons">' + cards + "</div></section>";
    }).join("");

  const referenceMarkup = '<section class="learn-group"><h2 class="learn-group-heading">Look up when you need it</h2>' +
    '<article class="learn-reference-card">' +
    '<div class="learn-lesson-copy"><h3>Choosing how a box calculates</h3>' +
    "<p>Every combine rule, formula pattern, cap and delay, with when to use each and how to check it. " +
    "Also opens from the <b>?</b> beside any box's calculation.</p></div>" +
    '<div class="learn-lesson-actions"><button class="tutorial-button" data-tutorial-action="open-reference">Browse</button></div>' +
    "</article></section>";

  const countedLessons = LEARN_LESSONS.length;
  const learnHeading = brandedTitle("Learn {name}.", "Learn this app.");
  const learnLabel = brandedTitle("Learn {name}", "Learn this app");
  layer.hidden = false;
  layer.innerHTML = '<div class="learn-backdrop"><section class="learn-library" role="dialog" aria-modal="true" aria-label="' + escapeHtml(learnLabel) + '">' +
    '<header class="learn-library-header"><div><h1>' + escapeHtml(learnHeading) + '</h1>' +
    "<p>Start with a three-minute first look, or go straight to whatever you came here to do. " +
    "Every lesson uses an example map and gives yours back when you leave.</p></div>" +
    '<button class="learn-close" data-tutorial-action="close-learn" aria-label="Close Learn">×</button></header>' +
    '<div class="learn-library-progress"><div class="learn-progress-summary"><span><strong>' + completedCount + "</strong> of " + countedLessons + " lessons complete</span>" +
    '<button class="learn-reset-progress" data-tutorial-action="reset-all-progress"' + (hasProgress ? "" : " disabled") + '>Reset all progress</button></div>' +
    '<progress class="learn-progress-bar" max="' + countedLessons + '" value="' + completedCount + '" aria-label="Learning progress"></progress></div>' +
    '<div class="learn-library-body">' + heroMarkup + groupsMarkup + referenceMarkup + "</div></section></div>";
  return true;
}

async function resetAllLearnProgress(): Promise<void> {
  if (!await confirmAction({
    eyebrow: "Learn",
    title: "Reset all lesson progress?",
    detail: [
      "Every lesson goes back to not started, and finished steps are forgotten.",
      "Your map is not touched.",
    ],
    confirmLabel: "Reset progress",
    danger: true,
  })) return;
  try { localStorage.removeItem(LEARN_PROGRESS_KEY); }
  catch (_) {}
  openLearnHub();
}

function activeLessonSteps(): TutorialStep[] {
  return currentLesson().steps;
}

function currentTaskIsComplete(step: TutorialStep): boolean {
  if (!step.task || !tutorialSession) return true;
  const completedIdentifiers = tutorialSession.completedCheckpointIdentifiersByStep
    .get(tutorialSession.currentStepIndex) || new Set<string>();
  return step.task.checkpoints.every(checkpoint => completedIdentifiers.has(checkpoint.identifier));
}

function tutorialTargetSelectorForStep(step: TutorialStep): string {
  if (!step.task || step.task.checkpoints.length <= 1 || !tutorialSession) {
    return step.targetSelector;
  }
  const completedIdentifiers = tutorialSession.completedCheckpointIdentifiersByStep
    .get(tutorialSession.currentStepIndex) || new Set<string>();
  return step.task.checkpoints.find(checkpoint =>
    !completedIdentifiers.has(checkpoint.identifier))?.selector || step.targetSelector;
}

function tutorialTaskMarkup(step: TutorialStep): string {
  if (!step.task) return "";
  const completedIdentifiers = tutorialSession?.completedCheckpointIdentifiersByStep
    .get(tutorialSession.currentStepIndex) || new Set<string>();
  const completed = currentTaskIsComplete(step);
  const checklist = step.task.checkpoints.map(checkpoint => {
    const checkpointComplete = completedIdentifiers.has(checkpoint.identifier);
    return '<li class="tutorial-task-checkpoint' + (checkpointComplete ? " is-complete" : "") + '" data-tutorial-checkpoint="' + checkpoint.identifier + '">' +
      '<span class="tutorial-task-checkmark" aria-hidden="true">' + (checkpointComplete ? "✓" : "○") + "</span>" +
      '<span><span class="sr-only">' + (checkpointComplete ? "Done: " : "Still to do: ") + "</span>" + checkpoint.instruction + "</span></li>";
  }).join("");
  return '<div class="tutorial-task' + (completed ? " is-complete" : "") + '" id="tutorial-task-requirements" ' +
    'data-tutorial-task-status role="status" aria-live="polite" aria-atomic="true">' +
    '<b>' + (completed ? "All actions complete" : "Complete all actions to unlock Next") + "</b>" +
    '<ol class="tutorial-task-checklist">' + checklist + "</ol></div>";
}

function refreshTutorialTaskState(): void {
  if (!tutorialSession) return;
  const step = activeLessonSteps()[tutorialSession.currentStepIndex];
  if (!step?.task) return;
  const taskStatus = tutorialLayer()?.querySelector<HTMLElement>("[data-tutorial-task-status]");
  if (taskStatus) taskStatus.outerHTML = tutorialTaskMarkup(step);
  const nextButton = tutorialLayer()?.querySelector<HTMLButtonElement>('[data-tutorial-action="next"]');
  if (nextButton) nextButton.disabled = !currentTaskIsComplete(step);
  highlightTutorialTarget(tutorialTargetSelectorForStep(step));
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

function prepareTutorialTaskCheckpoints(step: TutorialStep): void {
  if (!tutorialSession || !step.task) return;
  const checkpointSnapshots = new Map<string, unknown>();
  for (const checkpoint of step.task.checkpoints) {
    checkpointSnapshots.set(checkpoint.identifier, checkpoint.capture ? checkpoint.capture() : undefined);
  }
  tutorialSession.checkpointSnapshotsByStep.set(tutorialSession.currentStepIndex, checkpointSnapshots);
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
    '<button class="tutorial-button tutorial-button--primary" data-tutorial-action="next"' +
      (step.task ? ' aria-describedby="tutorial-task-requirements"' : "") + (taskComplete ? "" : " disabled") + ">" +
      (stepNumber === steps.length ? "Finish" : "Next") + "</button>" +
    '<button class="tutorial-button" data-tutorial-action="skip-step" ' +
      'aria-label="Skip this step without completing its actions">Skip step</button>' +
    '<button class="learn-runner-link" data-tutorial-action="reset-lesson">Reset lesson</button>' +
    '<button class="tutorial-button tutorial-button--quiet" data-tutorial-action="exit-lesson">Exit lesson</button>' +
    "</div></section>";
  applyTutorialCardPosition();
  step.enter();
  prepareTutorialTaskCheckpoints(step);
  highlightTutorialTarget(tutorialTargetSelectorForStep(step));
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
  const recommendedLesson = lesson.recommendedNextLessonId
    ? LEARN_LESSONS.find(candidate => candidate.id === lesson.recommendedNextLessonId)
    : null;
  tutorialSession.finishing = true;
  markLessonCompleted(lesson.id);
  clearTutorialTarget();
  closeTutorialSurfaces();
  setUiMode("read");
  const returnLabel = tutorialSession.originalMapHadContent ? "Return to my map" : "Start blank";
  const replacementNote = tutorialSession.originalMapHadContent
    ? "Your map is still parked safely. Continue learning, return to it, or explicitly replace it with the example."
    : "Continue learning, keep exploring the example, or return to a blank canvas.";
  const recapMarkup = lesson.recap.length
    ? '<div class="tutorial-recap"><b>You can now:</b><ul>' +
      lesson.recap.map(item => "<li>" + item + "</li>").join("") + "</ul></div>"
    : "";
  const transferMarkup = '<p class="tutorial-transfer"><b>Try it on your own map.</b> ' +
    lesson.tryOnYourOwnMap + "</p>";
  layer.innerHTML = '<section class="tutorial-card tutorial-finish" role="dialog" aria-label="Tour complete">' +
    threadMarkup(lesson.steps.length - 1, true) +
    '<div class="tutorial-step-number">Lesson complete</div>' +
    '<h2>' + lesson.title + " is complete.</h2>" + recapMarkup + transferMarkup +
    "<p>" + replacementNote + "</p>" +
    '<div class="tutorial-finish-actions">' +
    '<button class="tutorial-button" data-tutorial-action="back">Back</button>' +
    (recommendedLesson
      ? '<button class="tutorial-button tutorial-button--primary" data-tutorial-action="next-lesson">Next lesson: ' + recommendedLesson.title + "</button>"
      : "") +
    '<button class="tutorial-button' + (recommendedLesson ? "" : " tutorial-button--primary") + '" data-tutorial-action="learn">Back to Learn</button>' +
    '<button class="tutorial-button" data-tutorial-action="restore">' + returnLabel + "</button>" +
    '<button class="tutorial-button tutorial-button--quiet" data-tutorial-action="keep">Keep example</button>' +
    "</div></section>";
}

function continueToRecommendedLesson(): void {
  if (!tutorialSession) return;
  const recommendedLessonIdentifier = currentLesson().recommendedNextLessonId;
  const recommendedLesson = recommendedLessonIdentifier
    ? LEARN_LESSONS.find(candidate => candidate.id === recommendedLessonIdentifier)
    : null;
  if (!recommendedLesson) {
    exitTutorial({ markDismissed: false });
    openLearnHub();
    return;
  }

  closeTutorialSurfaces();
  if (state.simulationMode) toggleSimulationMode();
  setUiMode("read");
  if (!loadTutorialMapForLesson(recommendedLesson)) {
    exitTutorial({ markDismissed: false });
    openLearnHub();
    return;
  }

  tutorialSession.currentLessonId = recommendedLesson.id;
  tutorialSession.currentStepIndex = 0;
  tutorialSession.requestedLessonStepOffset = 0;
  tutorialSession.completedCheckpointIdentifiersByStep.clear();
  tutorialSession.checkpointSnapshotsByStep.clear();
  tutorialSession.finishing = false;
  tutorialSession.tutorialCardPosition = null;
  clearRememberedCheckpoints(recommendedLesson.id);
  renderTutorialStep();
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
  if (!loadTutorialMapForLesson(currentLesson())) return;
  tutorialSession.currentStepIndex = 0;
  tutorialSession.requestedLessonStepOffset = 0;
  tutorialSession.completedCheckpointIdentifiersByStep.clear();
  tutorialSession.checkpointSnapshotsByStep.clear();
  clearRememberedCheckpoints(tutorialSession.currentLessonId);
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
  const requestedLessonStepOffset = 0;
  const resumedStepIndex = options?.resume && progress.lastLessonId === lesson.id
    ? Math.min(progress.lastStepIndex, lesson.steps.length - 1)
    : 0;
  const completedCheckpointIdentifiersByStep = new Map<number, Set<string>>();
  if (options?.resume && progress.lastLessonId === lesson.id) {
    const rememberedLessonProgress = progress.completedCheckpointIdentifiersByLesson[lesson.id] || {};
    lesson.steps.forEach((step, stepIndex) => {
      if (!step.task) return;
      const rememberedIdentifiers = rememberedLessonProgress[String(stepIndex)] || [];
      const completedIdentifiers = new Set(rememberedIdentifiers);
      if (stepIndex < resumedStepIndex) {
        for (const checkpoint of step.task.checkpoints) completedIdentifiers.add(checkpoint.identifier);
      }
      if (completedIdentifiers.size) completedCheckpointIdentifiersByStep.set(stepIndex, completedIdentifiers);
    });
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
    requestedLessonStepOffset,
    completedCheckpointIdentifiersByStep,
    checkpointSnapshotsByStep: new Map<number, Map<string, unknown>>(),
    finishing: false,
    tutorialCardPosition: null,
  };
  setExportMenuOpen(false);
  setStorageWritesSuspended(true);
  closeTutorialSurfaces();
  if (state.simulationMode) toggleSimulationMode();
  setUiMode("read");
  if (!loadTutorialMapForLesson(lesson)) {
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

function goToAbsoluteTutorialStep(stepIndex: number): void {
  if (!tutorialSession) return;
  tutorialSession.finishing = false;
  tutorialSession.currentStepIndex = Math.max(0, Math.min(activeLessonSteps().length - 1, stepIndex));
  renderTutorialStep();
}

export function goToTutorialStep(stepIndex: number): void {
  if (!tutorialSession) return;
  goToAbsoluteTutorialStep(stepIndex + tutorialSession.requestedLessonStepOffset);
}

export function startLearnLesson(lessonIdentifier: string, options?: { resume?: boolean }): boolean {
  hideTutorialLayer();
  if (!options?.resume) clearRememberedCheckpoints(lessonIdentifier);
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
  layer.innerHTML = '<div class="tutorial-welcome-backdrop"><section class="tutorial-welcome" role="dialog" aria-label="' +
    escapeHtml(brandedTitle("Welcome to {name}", "Welcome")) + '">' +
    '<svg class="tutorial-welcome-mark" viewBox="0 0 48 28" fill="none" aria-hidden="true"><path d="M3 22C12 22 13 6 24 6s12 16 21 16" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><circle cx="3" cy="22" r="3" fill="currentColor"/><circle cx="24" cy="6" r="3" fill="currentColor"/><circle cx="45" cy="22" r="3" fill="currentColor"/></svg>' +
    '<div class="tutorial-kicker">' +
    escapeHtml(brandedTitle("Welcome to {name}", "Welcome")) + '</div>' +
    '<h1>Find out what a systems map is for, in three minutes.</h1>' +
    '<p>A systems map lays out what affects what, so a question like &ldquo;can we reach more people without booking more venues?&rdquo; can be answered rather than argued about. First look walks you through reading one, changing it, and following what happens. Your own map is never written over.</p>' +
    '<div class="tutorial-welcome-actions">' +
    '<button class="tutorial-button tutorial-button--primary" data-tutorial-action="start">First look · 3 min</button>' +
    '<button class="tutorial-button" data-tutorial-action="learn">Browse all lessons</button>' +
    '<button class="tutorial-button tutorial-button--quiet" data-tutorial-action="blank">Start blank</button>' +
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
  if (action === "reset-all-progress") { void resetAllLearnProgress(); return; }
  if (action === "lesson" || action === "restart-lesson") return;
  if (action === "learn") {
    if (tutorialSession) exitTutorial({ markDismissed: false });
    else setStorageWritesSuspended(false);
    openLearnHub();
    return;
  }
  if (action === "open-reference") { openLearnReference(); return; }
  if (!tutorialSession) return;
  if (action === "back") {
    if (tutorialSession.finishing) {
      tutorialSession.finishing = false;
      renderTutorialStep();
    } else {
      goToAbsoluteTutorialStep(tutorialSession.currentStepIndex - 1);
    }
    return;
  }
  if (action === "next") {
    const step = activeLessonSteps()[tutorialSession.currentStepIndex];
    if (!currentTaskIsComplete(step)) return;
    if (tutorialSession.currentStepIndex >= activeLessonSteps().length - 1) renderTutorialFinish();
    else goToAbsoluteTutorialStep(tutorialSession.currentStepIndex + 1);
    return;
  }
  if (action === "skip-step") {
    if (tutorialSession.currentStepIndex >= activeLessonSteps().length - 1) renderTutorialFinish();
    else goToAbsoluteTutorialStep(tutorialSession.currentStepIndex + 1);
    return;
  }
  if (action === "next-lesson") { continueToRecommendedLesson(); return; }
  if (action === "reset-lesson") { resetCurrentLesson(); return; }
  if (action === "exit-lesson" || action === "exit") {
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
document.addEventListener("scroll", scheduleTutorialTargetThreadUpdate, { capture: true, passive: true });
document.addEventListener("pointermove", updateTutorialThreadPointerFade, { passive: true });
document.addEventListener("pointerleave", revealTutorialThreadAfterPointerLeaves, { passive: true });
document.addEventListener("pointermove", moveTutorialCard, { passive: true });
document.addEventListener("pointerup", finishTutorialCardDrag, { passive: true });
document.addEventListener("pointercancel", finishTutorialCardDrag, { passive: true });

// Tutorial targets are frequently replaced by normal surface renders. Observe
// those structural/visibility changes while a lesson is active and schedule one
// geometry refresh. Ignore the thread's own path/marker writes so the observer
// cannot turn the one-shot scheduler back into a perpetual animation loop.
if (typeof MutationObserver === "function" && document.body) {
  const tutorialTargetMutationObserver = new MutationObserver(mutationRecords => {
    if (!highlightedTutorialTargetSelector) return;
    const targetThread = tutorialLayer()?.querySelector(".tutorial-target-thread");
    const externalMutationExists = mutationRecords.some(mutationRecord =>
      !(targetThread && targetThread.contains(mutationRecord.target)),
    );
    if (externalMutationExists) scheduleTutorialTargetThreadUpdate();
  });
  tutorialTargetMutationObserver.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "aria-expanded"],
  });
}

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
  if (!task) return;
  const completedIdentifiers = tutorialSession.completedCheckpointIdentifiersByStep
    .get(tutorialSession.currentStepIndex) || new Set<string>();
  const checkpoint = task.checkpoints.find(candidate => !completedIdentifiers.has(candidate.identifier));
  if (!checkpoint || !checkpoint.events.includes(event.type as TutorialTaskEvent)) return;
  const eventTarget = event.target;
  if (!(eventTarget instanceof Element) || !eventTarget.closest(checkpoint.selector)) return;
  const lessonIdentifier = tutorialSession.currentLessonId;
  const stepIndex = tutorialSession.currentStepIndex;
  const snapshot = tutorialSession.checkpointSnapshotsByStep.get(stepIndex)?.get(checkpoint.identifier);
  const markComplete = (): void => {
    if (!tutorialSession || tutorialSession.currentLessonId !== lessonIdentifier || tutorialSession.currentStepIndex !== stepIndex) return;
    if (!checkpoint.verify(event, snapshot)) return;
    const currentCompletedIdentifiers = tutorialSession.completedCheckpointIdentifiersByStep.get(stepIndex) || new Set<string>();
    currentCompletedIdentifiers.add(checkpoint.identifier);
    tutorialSession.completedCheckpointIdentifiersByStep.set(stepIndex, currentCompletedIdentifiers);
    rememberCheckpointCompletion(lessonIdentifier, stepIndex, checkpoint.identifier);
    const nextCheckpoint = task.checkpoints.find(candidate => !currentCompletedIdentifiers.has(candidate.identifier));
    if (nextCheckpoint) {
      const checkpointSnapshots = tutorialSession.checkpointSnapshotsByStep.get(stepIndex) || new Map<string, unknown>();
      checkpointSnapshots.set(nextCheckpoint.identifier, nextCheckpoint.capture ? nextCheckpoint.capture() : undefined);
      tutorialSession.checkpointSnapshotsByStep.set(stepIndex, checkpointSnapshots);
    }
    refreshTutorialTaskState();
  };
  // This observer runs during capture so it can also see non-bubbling scroll
  // events. A microtask can run before the target's own handler, which made a
  // first edit look unchanged and forced the user to repeat it. A timer runs
  // after the complete event dispatch, including document-level canvas
  // handlers registered later during boot.
  setTimeout(markComplete, checkpoint.settleDelayMilliseconds || 0);
}

for (const eventName of ["click", "input", "change", "scroll", "keydown", "mouseup", "pointerup", "mouseover"] as TutorialTaskEvent[]) {
  // Scroll does not bubble, so every event uses capture consistently.
  document.addEventListener(eventName, observeTutorialTaskEvent, true);
}
