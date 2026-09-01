// =============================================================================
// VITEST SETUP — jsdom shims + DOM mount (runs before every test file's imports)
// -----------------------------------------------------------------------------
// Two jobs:
//   1. Fill jsdom's gaps: a deterministic <canvas> 2D context (the layout/label
//      code measures text widths through it) and no-op scroll helpers.
//   2. Mount the real index.html <body> BEFORE any app module is imported. Some
//      modules (e.g. 17-events) capture elements via getElementById at module
//      top level, so the DOM has to exist the moment they evaluate.
// =============================================================================
import { beforeEach, vi } from "vitest";
import { mountAppDom } from "./helpers/dom";
import {
  setCategories,
  setCategoryNodeCount,
  setCycleInfo,
  setDefaultElasticityByEffect,
  setEdgeById,
  setEdges,
  setIncomingEdges,
  setLayout,
  setMaxHighlightDepth,
  setNodeById,
  setNodes,
  setOutgoingEdges,
  setParamById,
  setParams,
  setStageById,
  setStageNodeCount,
  setStages,
  setStreamById,
  setStreamNodeCount,
  setStreams,
  setTopologicalOrder,
  state,
} from "../assets/js/03-state";

// ── Canvas 2D context (jsdom returns null) ──────────────────────────────────
function makeContextStub(): Partial<CanvasRenderingContext2D> {
  return {
    font: "",
    measureText(text: string): TextMetrics {
      // ~7px per character — a deterministic proxy for 12px Arial. Tests assert
      // on line counts derived from this, so it must stay stable.
      return { width: String(text).length * 7 } as TextMetrics;
    },
    fillRect: () => {},
    clearRect: () => {},
    drawImage: () => {},
    fillText: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    fill: () => {},
    save: () => {},
    restore: () => {},
    translate: () => {},
    scale: () => {},
  } as Partial<CanvasRenderingContext2D>;
}

HTMLCanvasElement.prototype.getContext = vi.fn(() =>
  makeContextStub(),
) as unknown as HTMLCanvasElement["getContext"];

// ── Scrolling (jsdom doesn't implement these) ───────────────────────────────
Element.prototype.scrollIntoView = function () {};
Element.prototype.scrollTo = function () {} as Element["scrollTo"];
window.scrollTo = function () {} as typeof window.scrollTo;

// ── localStorage ────────────────────────────────────────────────────────────
// The global `localStorage` in this runtime (Node 25 ships an experimental Web
// Storage global) isn't a usable Storage, so install a clean in-memory one. The
// app only ever calls setItem/getItem/removeItem, all wrapped in try/catch.
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(String(key), String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
}
const memoryStorage = new MemoryStorage();
Object.defineProperty(globalThis, "localStorage", {
  value: memoryStorage,
  configurable: true,
  writable: true,
});
if (typeof window !== "undefined") {
  Object.defineProperty(window, "localStorage", {
    value: memoryStorage,
    configurable: true,
    writable: true,
  });
}

// ── Mount the app DOM ONCE, before any module imports ───────────────────────
// Modules like 11-rendering capture `const svg = getElementById("viz-svg")` at
// import time, so the #viz-svg they draw into must be the live one for the whole
// file. Re-mounting per test would detach those captured references. Renders
// overwrite their containers' innerHTML each call, so this stays clean enough;
// localStorage is what we reset between tests.
mountAppDom();

// Timer-owning modules sit above state in the application import graph and some
// attach DOM handlers when evaluated, so load them lazily after mountAppDom().
// The promises are cached by the module loader; subsequent test resets only call
// the small cancellation functions.
async function cancelPendingApplicationWorkWithoutFlushing(): Promise<void> {
  const [storageModule, reviewRecordModule, searchModule] = await Promise.all([
    import("../assets/js/04a-storage"),
    import("../assets/js/24-review-record"),
    import("../assets/js/17a-search"),
  ]);
  storageModule.cancelPendingStorageSavesWithoutFlushing();
  reviewRecordModule.cancelPendingReviewSaveWithoutFlushing();
  searchModule.cancelPendingSearchWorkWithoutFlushing();
}

// ── Per-test isolation ──────────────────────────────────────────────────────
// Tests import the same live state object as the app. Resetting localStorage was
// not enough: filters, modes, reviewer identity, builder drafts and timers all
// leaked into whichever test Vitest happened to run next. Keep this reset in
// one place so a shuffled suite exercises the same starting contract as the
// normal declaration order.
function resetApplicationState(): void {
  if (state.canvasEdit.toast?.timerId) clearTimeout(state.canvasEdit.toast.timerId);
  if (state.canvasEdit.edgeCycleSession?.debounceTimer) {
    clearTimeout(state.canvasEdit.edgeCycleSession.debounceTimer);
  }

  Object.assign(state, {
    selectedNodeId: null,
    selectedNodeIds: new Set<string>(),
    selectedEdgeId: null,
    hoveredNodeId: null,
    hiddenStreams: new Set<string>(),
    hiddenCategories: new Set<string>(),
    hiddenStages: new Set<string>(),
    hiddenEffects: new Set<string>(),
    hiddenStyles: new Set<string>(),
    hiddenTrace: new Set<string>(),
    ancestorSet: new Set<string>(),
    descendantSet: new Set<string>(),
    highlightedEdgeIds: new Set<string>(),
    simulationMode: false,
    userOverrides: {},
    computedValues: {},
    explanations: {},
    solverStatus: { converged: true, iterations: 0, feedbackLoopCount: 0 },
    dataLoaded: false,
    loadErrors: [],
    reviews: {},
    reviewer: "",
    reviewPass: false,
    uiMode: "read",
    filtersOpen: false,
    sidebarPinned: true,
    detailPanelPinned: true,
    sidebarWidth: 280,
    detailPanelWidth: 340,
    zoomLevel: 1,
    highlightDepth: 1,
    searchQuery: "",
    searchMatches: [],
    searchFocusIndex: 0,
    atlas: null,
    canvasEdit: {
      editMode: false,
      shiftHeld: false,
      hoverCell: null,
      draggingNode: null,
      draftEdge: null,
      marquee: null,
      flashedEdgeId: null,
      flashedNodeIds: null,
      flashedEdgeIds: null,
      addingEdgeFromNodeId: null,
      toast: null,
      inlineRename: null,
      cursorCell: null,
      edgePicker: null,
      lastUsedEdgeEffect: "enables",
      edgeCycleSession: null,
    },
    history: { past: [], future: [] },
    lastCsvSnapshot: null,
    builder: {
      open: false,
      step: 1,
      streams: [],
      stages: [],
      categories: [],
      defaults: { enables: 0.3, increases: 0.25, decreases: -0.25 },
      params: [],
      nodes: [],
      edges: [],
      selected: new Set<number>(),
      _lastRenderedStep: null,
      focusAfterRender: null,
      sort: {},
    },
  });

  setStreams([]);
  setStages([]);
  setCategories({});
  setNodes([]);
  setEdges([]);
  setParams([]);
  setDefaultElasticityByEffect({ enables: 0.3, increases: 0.25, decreases: -0.25 });
  setNodeById({});
  setParamById({});
  setEdgeById({});
  setOutgoingEdges({});
  setIncomingEdges({});
  setStreamById({});
  setStageById({});
  setTopologicalOrder([]);
  setCycleInfo({ inCycleNodeIds: new Set(), backEdgeIds: new Set(), loopCount: 0 });
  setStreamNodeCount({});
  setCategoryNodeCount({});
  setStageNodeCount({});
  setMaxHighlightDepth(1);
  setLayout({
    positions: {}, rowY: {}, rowHeights: {}, colX: {}, colWidths: {},
    totalWidth: 0, totalHeight: 0,
  });

  document.body.className = "";
  document.documentElement.removeAttribute("data-theme");
  for (const overlayIdentifier of ["builder-overlay", "review-stage", "atlas-stage"]) {
    const overlay = document.getElementById(overlayIdentifier);
    if (overlay) overlay.hidden = true;
  }
}

beforeEach(async () => {
  // Cancel first, while Vitest is still using the same timer implementation as
  // the preceding test. Switching fake timers back to real timers before this
  // point can orphan the handles that need clearing.
  await cancelPendingApplicationWorkWithoutFlushing();
  vi.useRealTimers();
  vi.clearAllMocks();
  memoryStorage.clear();
  resetApplicationState();
});
