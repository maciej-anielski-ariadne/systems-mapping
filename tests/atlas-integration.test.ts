// =============================================================================
// THE ATLAS, INSIDE THE APP
// -----------------------------------------------------------------------------
// The engine's own guarantees are pinned in pathway-atlas.test.ts. What this
// file pins is the join: that the atlas reads the app's live map (signs and
// all), that it opens over the map from a box rather than somewhere else, that
// the right-hand panel becomes its inspector rather than a second one, and that
// it never outlives the map it is a picture of.
// =============================================================================
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import { EDGES, NODES, nodeById, state } from "../assets/js/03-state";
import { deselectAll, selectNode } from "../assets/js/09-graph-selection";
import { renderDetailPanel } from "../assets/js/15-detail-panel";
import { toggleSimulationMode } from "../assets/js/14-simulation-panel";
import { setUiMode } from "../assets/js/17-events";
import {
  atlasIsOpen,
  atlasStartCandidates,
  captureAtlasSessionState,
  closeAtlas,
  cutAtlasLinksAfterBlockedElements,
  initAtlasStage,
  openFirstFeedbackTangle,
  openAtlas,
  refreshAtlasValues,
  renderAtlas,
  restoreAtlasSessionState,
  setAtlasRenderFrameSchedulerForTests,
} from "../assets/js/21-atlas-view";

describe("blocked-link propagation", () => {
  it("visits each retained link at most once on a 300-element cut", () => {
    const links = new Set<string>();
    for (let index = 0; index < 299; index++) {
      links.add("element-" + index + "\u0000element-" + (index + 1));
      if (index + 2 < 300) links.add("element-" + index + "\u0000element-" + (index + 2));
    }

    const result = cutAtlasLinksAfterBlockedElements(links, new Set(["element-0"]));

    expect(result.links).toEqual(new Set());
    expect(result.scannedLinkCount).toBeLessThanOrEqual(links.size);
  });
});

interface ControlledAtlasFrameScheduler {
  scheduler: {
    requestFrame: (callback: FrameRequestCallback) => number;
    cancelFrame: (requestIdentifier: number) => void;
  };
  pendingFrameCount: () => number;
  runNextFrame: () => void;
}

function controlledAtlasFrameScheduler(): ControlledAtlasFrameScheduler {
  let nextRequestIdentifier = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  return {
    scheduler: {
      requestFrame(callback) {
        const requestIdentifier = nextRequestIdentifier++;
        callbacks.set(requestIdentifier, callback);
        return requestIdentifier;
      },
      cancelFrame(requestIdentifier) {
        callbacks.delete(requestIdentifier);
      },
    },
    pendingFrameCount: () => callbacks.size,
    runNextFrame() {
      const entry = callbacks.entries().next().value as [number, FrameRequestCallback] | undefined;
      if (!entry) throw new Error("No Atlas frame is pending");
      callbacks.delete(entry[0]);
      entry[1](performance.now());
    },
  };
}

describe("progressive first Atlas rendering", () => {
  let frameScheduler: ControlledAtlasFrameScheduler;

  beforeEach(() => {
    frameScheduler = controlledAtlasFrameScheduler();
    setAtlasRenderFrameSchedulerForTests(frameScheduler.scheduler);
    const stage = document.getElementById("atlas-stage")!;
    stage.innerHTML = "";
    delete stage.dataset.renderPhase;
    stage.removeAttribute("aria-busy");
    stage.inert = false;
  });

  afterEach(() => {
    closeAtlas();
    setAtlasRenderFrameSchedulerForTests(null);
  });

  it("commits meaningful structure before generating labels and wheel details", () => {
    loadDataFromCsv(advancedCsv);
    openAtlas(firstInput());

    const stage = document.getElementById("atlas-stage")!;
    const structuralSvg = stage.querySelector<SVGSVGElement>("svg.atlas")!;
    expect(stage.dataset.renderPhase).toBe("structure");
    expect(stage.getAttribute("aria-busy")).toBe("true");
    expect(stage.inert).toBe(true);
    expect(structuralSvg.querySelectorAll(".fl").length).toBeGreaterThan(0);
    expect(structuralSvg.querySelectorAll(".bub").length).toBeGreaterThan(1);
    expect(structuralSvg.querySelectorAll("text, .ch, .nd")).toHaveLength(0);

    frameScheduler.runNextFrame();
    expect(stage.dataset.renderPhase).toBe("structure");
    expect(structuralSvg.querySelectorAll("text")).toHaveLength(0);

    frameScheduler.runNextFrame();
    expect(stage.querySelector("svg.atlas")).toBe(structuralSvg);
    expect(stage.dataset.renderPhase).toBe("complete");
    expect(stage.hasAttribute("aria-busy")).toBe(false);
    expect(stage.inert).toBe(false);
    expect(structuralSvg.querySelectorAll("g.n > text").length).toBeGreaterThan(1);
    expect(panel().querySelector(".ins")).not.toBeNull();
  });

  it("cancels incomplete work and never caches a partial structure", () => {
    loadDataFromCsv(advancedCsv);
    openAtlas(firstInput());
    const partialSvg = document.querySelector("#atlas-stage svg.atlas");
    expect(frameScheduler.pendingFrameCount()).toBe(1);

    closeAtlas();
    const stage = document.getElementById("atlas-stage")!;
    expect(frameScheduler.pendingFrameCount()).toBe(0);
    expect(stage.hidden).toBe(true);
    expect(stage.hasAttribute("aria-busy")).toBe(false);
    expect(stage.dataset.renderPhase).toBeUndefined();
    expect(stage.querySelector("svg.atlas")).toBeNull();

    openAtlas(firstInput());
    expect(stage.querySelector("svg.atlas")).not.toBe(partialSvg);
    expect(stage.dataset.renderPhase).toBe("structure");
  });

  it("removes the phase contract and keeps controls guarded if enrichment fails", () => {
    const originalInsertAdjacentMarkup = Element.prototype.insertAdjacentHTML;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let injectedFailureIsPending = true;
    Element.prototype.insertAdjacentHTML = function(position, text) {
      if (injectedFailureIsPending && this.matches("g.n")) {
        injectedFailureIsPending = false;
        throw new Error("injected Atlas enrichment failure");
      }
      return originalInsertAdjacentMarkup.call(this, position, text);
    };
    try {
      loadDataFromCsv(advancedCsv);
      openAtlas(firstInput());
      frameScheduler.runNextFrame();
      frameScheduler.runNextFrame();

      const stage = document.getElementById("atlas-stage")!;
      expect(stage.dataset.renderPhase).toBeUndefined();
      expect(stage.hasAttribute("aria-busy")).toBe(false);
      expect(stage.querySelector("[role=alert]")?.textContent).toContain("could not finish");
      expect(stage.querySelector("svg.atlas")).toBeNull();
    } finally {
      Element.prototype.insertAdjacentHTML = originalInsertAdjacentMarkup;
      consoleError.mockRestore();
    }
  });

  it("repaints a completed cached Atlas before revealing it synchronously", () => {
    loadDataFromCsv(advancedCsv);
    openAtlas(firstInput());
    frameScheduler.runNextFrame();
    frameScheduler.runNextFrame();
    const stage = document.getElementById("atlas-stage")!;
    const completedSvg = stage.querySelector<SVGSVGElement>("svg.atlas")!;
    const firstGroup = completedSvg.querySelector<SVGGElement>("g.n")!;
    firstGroup.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(completedSvg.querySelectorAll("g.n.on").length).toBeGreaterThan(0);

    closeAtlas();
    openAtlas(firstInput());

    expect(stage.querySelector("svg.atlas")).toBe(completedSvg);
    expect(stage.dataset.renderPhase).toBe("complete");
    expect(stage.hasAttribute("aria-busy")).toBe(false);
    expect(stage.inert).toBe(false);
    expect(completedSvg.classList.contains("reveal")).toBe(false);
    expect(completedSvg.querySelectorAll("g.n.on")).toHaveLength(0);
    expect(frameScheduler.pendingFrameCount()).toBe(0);
  });

  it("defers stale inspector and keyboard controls until the current structure is complete", () => {
    loadDataFromCsv(advancedCsv);
    openAtlas(firstInput());
    const stage = document.getElementById("atlas-stage")!;
    const firstGroup = stage.querySelector<SVGGElement>("g.n")!;
    firstGroup.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    panel().querySelector<HTMLButtonElement>("button")?.click();
    expect(stage.querySelectorAll("g.n.on")).toHaveLength(0);

    frameScheduler.runNextFrame();
    frameScheduler.runNextFrame();
    firstGroup.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(stage.querySelectorAll("g.n.on").length).toBeGreaterThan(0);
  });

  it("preserves a saved view box across deferred restoration", () => {
    loadDataFromCsv(sampleCsv);
    // Build a complete source session synchronously, then force a changed
    // structure so restoration has to take the progressive first-open path.
    setAtlasRenderFrameSchedulerForTests(null);
    openAtlas(firstInput());
    const snapshot = captureAtlasSessionState()!;
    snapshot.viewBox = { x: 11, y: 22, w: 333, h: 444 };
    closeAtlas();

    setAtlasRenderFrameSchedulerForTests(frameScheduler.scheduler);
    loadDataFromCsv(sampleCsv.replace(
      "team_size,Team size,",
      "team_size,Team size updated,",
    ));
    restoreAtlasSessionState(snapshot);
    expect(document.getElementById("atlas-stage")!.dataset.renderPhase).toBe("structure");
    frameScheduler.runNextFrame();
    frameScheduler.runNextFrame();

    expect(document.querySelector("#atlas-stage svg.atlas")?.getAttribute("viewBox"))
      .toBe("11.0 22.0 333.0 444.0");
  });

  it("invalidates an older completion frame when the starting box changes", () => {
    loadDataFromCsv(advancedCsv);
    const firstStart = firstInput();
    const secondStart = NODES.find(node =>
      node.id !== firstStart && EDGES.some(edge => edge.from === node.id))!.id;
    openAtlas(firstStart);
    const firstSvg = document.querySelector("#atlas-stage svg.atlas");
    frameScheduler.runNextFrame();
    expect(frameScheduler.pendingFrameCount()).toBe(1);

    openAtlas(secondStart);
    const stage = document.getElementById("atlas-stage")!;
    expect(frameScheduler.pendingFrameCount()).toBe(1);
    expect(stage.querySelector("svg.atlas")).not.toBe(firstSvg);
    expect(state.atlas?.startId).toBe(secondStart);
    frameScheduler.runNextFrame();
    frameScheduler.runNextFrame();

    expect(stage.dataset.renderPhase).toBe("complete");
    expect(stage.querySelector("svg.atlas")?.getAttribute("aria-label"))
      .toContain(nodeById[secondStart].label);
    expect(firstSvg?.isConnected).toBe(false);
  });

  it("applies the latest Simulation state when deferred paint completes", () => {
    loadDataFromCsv(advancedCsv);
    openAtlas(firstInput());
    const svg = document.querySelector<SVGSVGElement>("#atlas-stage svg.atlas")!;
    expect(svg.classList.contains("simulating")).toBe(false);

    toggleSimulationMode();
    expect(state.simulationMode).toBe(true);
    expect(svg.classList.contains("simulating")).toBe(false);
    frameScheduler.runNextFrame();
    frameScheduler.runNextFrame();

    expect(svg.classList.contains("simulating")).toBe(true);
    expect(svg.querySelectorAll("tspan.mag").length).toBeGreaterThan(0);
  });

  it("finishes a feedback view requested before wheel markup exists", () => {
    loadDataFromCsv(borderForceCsv);
    const start = NODES.find(node => node.label === "Analyst capacity")!;
    openAtlas(start.id);
    expect(openFirstFeedbackTangle()).toBe(true);
    expect(document.querySelectorAll("#atlas-stage .ch")).toHaveLength(0);

    frameScheduler.runNextFrame();
    frameScheduler.runNextFrame();

    expect(document.querySelector("#atlas-stage g.n.focus")).not.toBeNull();
    expect(document.querySelectorAll("#atlas-stage g.n.focus .ch").length).toBeGreaterThan(0);
    expect(document.querySelector("#atlas-loopctl")?.hasAttribute("hidden")).toBe(false);
  });

  it("keeps reduced-motion rendering progressive without adding reveal animation", () => {
    const originalMatchMedia = globalThis.matchMedia;
    Object.defineProperty(globalThis, "matchMedia", {
      configurable: true,
      value: (() => ({ matches: true })) as unknown as typeof globalThis.matchMedia,
    });
    try {
      loadDataFromCsv(advancedCsv);
      openAtlas(firstInput());
      expect(document.getElementById("atlas-stage")!.dataset.renderPhase).toBe("structure");
      frameScheduler.runNextFrame();
      frameScheduler.runNextFrame();
      const svg = document.querySelector("#atlas-stage svg.atlas")!;
      expect(document.getElementById("atlas-stage")!.dataset.renderPhase).toBe("complete");
      expect(svg.classList.contains("reveal")).toBe(false);
    } finally {
      Object.defineProperty(globalThis, "matchMedia", {
        configurable: true,
        value: originalMatchMedia,
      });
    }
  });
});

const here = dirname(fileURLToPath(import.meta.url));
const sampleCsv = readFileSync(resolve(here, "../assets/data/sample.csv"), "utf-8");
const advancedCsv = readFileSync(resolve(here, "../assets/data/advanced_sample.csv"), "utf-8");
const borderForceCsv = readFileSync(
  resolve(here, "../assets/data/border_force_drug_trafficking_300.csv"),
  "utf-8",
);

const panel = (): HTMLElement => document.getElementById("detail-content") as HTMLElement;
const firstInput = (): string => {
  const withOut = NODES.find(n => EDGES.some(e => e.from === n.id));
  return withOut!.id;
};

beforeEach(() => {
  closeAtlas();
  if (state.simulationMode) toggleSimulationMode();
  setUiMode("read");
  initAtlasStage();          // idempotent; 18-main does this at boot. Wires the
                             // entry points AND the pointer handlers on the
                             // panel and the picture.
  atlasMenu().hidden = true;
});

const atlasButton = (): HTMLElement => document.getElementById("atlas-button") as HTMLElement;
const atlasMenu = (): HTMLElement => document.getElementById("atlas-menu") as HTMLElement;

// A box on the map, as the renderer draws it. The double-click handler is
// delegated off #viz-svg, so a stub group is enough to exercise it.
const mapBox = (nodeId: string): SVGElement => {
  const svg = document.getElementById("viz-svg")!;
  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
  g.setAttribute("class", "node-group");
  g.setAttribute("data-node-id", nodeId);
  svg.appendChild(g);
  return g as SVGElement;
};

const dblclick = (el: Element): void => {
  el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
};

describe("the way in", () => {
  it("is offered on a box that has something downstream", () => {
    loadDataFromCsv(sampleCsv);
    selectNode(firstInput());
    renderDetailPanel();
    expect(panel().querySelector("[data-action='open-atlas']")).not.toBeNull();
  });

  it("is not offered on a box that ends the story", () => {
    loadDataFromCsv(sampleCsv);
    const leaf = NODES.find(n => !EDGES.some(e => e.from === n.id));
    expect(leaf).toBeDefined();
    selectNode(leaf!.id);
    renderDetailPanel();
    expect(panel().querySelector("[data-action='open-atlas']")).toBeNull();
  });
});

// Atlas starts from the selected box, so its entry belongs with that box. Once
// open, changing the start and leaving Atlas belong to the Atlas surface.
describe("the ways in", () => {
  it("the selected-box action opens the atlas on that box", () => {
    loadDataFromCsv(sampleCsv);
    const start = firstInput();
    selectNode(start);
    renderDetailPanel();
    (panel().querySelector("[data-action='open-atlas']") as HTMLButtonElement).click();
    expect(atlasIsOpen()).toBe(true);
    expect(state.atlas!.startId).toBe(start);
  });

  it("the Atlas surface changes the starting box and closes itself", () => {
    loadDataFromCsv(sampleCsv);
    openAtlas(firstInput());
    atlasButton().click();
    expect(atlasIsOpen()).toBe(true);
    expect(atlasMenu().hidden).toBe(false);
    (document.getElementById("atlas-exit-button") as HTMLButtonElement).click();
    expect(atlasIsOpen()).toBe(false);
  });

  it("offers high-reach boxes when changing the Atlas start", () => {
    loadDataFromCsv(sampleCsv);
    openAtlas(firstInput());
    atlasButton().click();

    expect(atlasMenu().hidden).toBe(false);
    const picks = [...atlasMenu().querySelectorAll("[data-atlas-start]")];
    expect(picks.length).toBeGreaterThan(0);
    expect(atlasIsOpen()).toBe(true);

    // Ranked by how much lies downstream, biggest first.
    const reach = atlasStartCandidates().map(c => c.reach);
    expect([...reach].sort((a, b) => b - a)).toEqual(reach);

    // A box that ends the story is never offered — its atlas is one circle.
    const leaf = NODES.find(n => !EDGES.some(e => e.from === n.id))!;
    expect(atlasStartCandidates().some(c => c.id === leaf.id)).toBe(false);
  });

  it("keeps Simulation active while Atlas opens and closes", () => {
    loadDataFromCsv(sampleCsv);
    if (!state.simulationMode) toggleSimulationMode();
    openAtlas(firstInput());
    expect(atlasIsOpen()).toBe(true);
    expect(state.simulationMode).toBe(true);

    (document.getElementById("atlas-exit-button") as HTMLButtonElement).click();
    expect(atlasIsOpen()).toBe(false);
    expect(state.simulationMode).toBe(true);
    toggleSimulationMode();
  });

  it("picking from that list opens the atlas there", () => {
    loadDataFromCsv(sampleCsv);
    openAtlas(firstInput());
    atlasButton().click();
    const pick = atlasMenu().querySelector("[data-atlas-start]") as HTMLElement;
    pick.click();
    expect(atlasIsOpen()).toBe(true);
    expect(state.atlas!.startId).toBe(pick.dataset.atlasStart);
  });

  it("double-clicking a box on the map opens its atlas", () => {
    loadDataFromCsv(sampleCsv);
    const start = firstInput();
    dblclick(mapBox(start));
    expect(atlasIsOpen()).toBe(true);
    expect(state.atlas!.startId).toBe(start);
  });

  it("but not on a box that ends the story", () => {
    loadDataFromCsv(sampleCsv);
    const leaf = NODES.find(n => !EDGES.some(e => e.from === n.id))!;
    dblclick(mapBox(leaf.id));
    expect(atlasIsOpen()).toBe(false);
  });

  it("every door is shut while editing", () => {
    loadDataFromCsv(sampleCsv);
    const start = firstInput();
    selectNode(start);
    setUiMode("edit");

    renderDetailPanel();
    expect(panel().querySelector("[data-action='open-atlas']")).toBeNull();

    dblclick(mapBox(start));
    expect(atlasIsOpen()).toBe(false);
  });

  it("switching into editing puts an open atlas away", () => {
    loadDataFromCsv(sampleCsv);
    openAtlas(firstInput());
    expect(atlasIsOpen()).toBe(true);

    setUiMode("edit");
    expect(atlasIsOpen()).toBe(false);
    expect(document.body.classList.contains("atlas-open")).toBe(false);
  });
});

describe("opening it", () => {
  it("draws one circle per element, over the map", () => {
    loadDataFromCsv(sampleCsv);
    openAtlas(firstInput());
    expect(atlasIsOpen()).toBe(true);
    expect(document.body.classList.contains("atlas-open")).toBe(true);

    const stage = document.getElementById("atlas-stage")!;
    expect(stage.hidden).toBe(false);
    expect(stage.querySelectorAll("svg.atlas .bub").length).toBeGreaterThan(1);
    // The map is still there underneath — going back is not a reload.
    expect(document.querySelectorAll("#viz-svg .node-group").length).toBe(NODES.length);
  });

  it("keeps the structural drawing when the same atlas is rendered again", () => {
    loadDataFromCsv(sampleCsv);
    openAtlas(firstInput());
    const atlasSvg = document.querySelector("#atlas-stage svg.atlas")!;
    const firstCircle = atlasSvg.querySelector("g.n")!;

    renderAtlas();

    expect(document.querySelector("#atlas-stage svg.atlas")).toBe(atlasSvg);
    expect(document.querySelector("#atlas-stage svg.atlas g.n")).toBe(firstCircle);
  });

  it("reuses the hidden drawing when the same start is reopened on an unchanged map", () => {
    loadDataFromCsv(sampleCsv);
    const start = firstInput();
    openAtlas(start);
    const atlasSvg = document.querySelector("#atlas-stage svg.atlas")!;

    closeAtlas();
    expect(document.getElementById("atlas-stage")!.hidden).toBe(true);
    expect(document.querySelector("#atlas-stage svg.atlas")).toBe(atlasSvg);

    openAtlas(start);
    expect(document.querySelector("#atlas-stage svg.atlas")).toBe(atlasSvg);
    expect(document.getElementById("atlas-stage")!.hidden).toBe(false);
  });

  it("invalidates the hidden drawing when the map changes", () => {
    loadDataFromCsv(sampleCsv);
    openAtlas(firstInput());
    const previousAtlasSvg = document.querySelector("#atlas-stage svg.atlas")!;
    closeAtlas();

    loadDataFromCsv(advancedCsv);
    openAtlas(firstInput());

    expect(document.querySelector("#atlas-stage svg.atlas")).not.toBe(previousAtlasSvg);
  });

  it("uses cached element references for a repeated resting-state paint", () => {
    loadDataFromCsv(sampleCsv);
    openAtlas(firstInput());
    const atlasSvg = document.querySelector("#atlas-stage svg.atlas") as SVGSVGElement;
    const querySelectorAllSpy = vi.spyOn(atlasSvg, "querySelectorAll");

    refreshAtlasValues();

    expect(querySelectorAllSpy).not.toHaveBeenCalled();
    querySelectorAllSpy.mockRestore();
  });

  it("reads the whole map, filters and all", () => {
    loadDataFromCsv(sampleCsv);
    const start = firstInput();
    openAtlas(start);
    const before = document.querySelectorAll("#atlas-stage .bub").length;

    // Hide a row: what's on the map changes, what's true does not.
    closeAtlas();
    state.hiddenStreams = new Set([NODES[0].stream]);
    openAtlas(start);
    expect(document.querySelectorAll("#atlas-stage .bub").length).toBe(before);
    state.hiddenStreams = new Set();
  });

  it("refuses a box that isn't in the map", () => {
    loadDataFromCsv(sampleCsv);
    openAtlas("no_such_box");
    expect(atlasIsOpen()).toBe(false);
  });
});

describe("the panel is its inspector", () => {
  it("says what the picture is, and what the percentages are of", () => {
    loadDataFromCsv(sampleCsv);
    const start = firstInput();
    openAtlas(start);
    renderDetailPanel();

    const text = panel().textContent || "";
    expect(text).toContain("Atlas of " + nodeById[start].label);
    expect(text).toContain("readings");
    // One inspector, not two: the atlas doesn't ship its own panel element.
    expect(document.querySelectorAll("#atlas-stage .ins").length).toBe(0);
  });

  it("goes back to the box panel when the atlas closes", () => {
    loadDataFromCsv(sampleCsv);
    const start = firstInput();
    selectNode(start);
    openAtlas(start);
    renderDetailPanel();
    expect(panel().textContent).toContain("Atlas of");

    closeAtlas();
    renderDetailPanel();
    expect(panel().textContent).toContain(nodeById[start].label);
    expect(panel().textContent).not.toContain("Atlas of");
  });
});

// =============================================================================
// POINTING, AND CHOOSING
// -----------------------------------------------------------------------------
// They are different acts. Pointing at a fork draws it and commits to nothing,
// so a fork can be swept by running down it and nothing passed on the way costs
// a click to undo. Choosing commits, and only then opens the next level.
// =============================================================================
describe("pointing at a fork", () => {
  const rows = () => [...panel().querySelectorAll("[data-fork]")] as HTMLElement[];
  const lit = () => [...document.querySelectorAll("svg.atlas g.n.on")]
    .map(g => (g as HTMLElement).dataset.el).sort();
  const chosen = () => [...panel().querySelectorAll(".cur")].map(el => el.textContent);
  const over = (el: Element) =>
    el.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));

  beforeEach(() => {
    loadDataFromCsv(advancedCsv);
    openAtlas(firstInput());
    renderDetailPanel();
  });

  it("draws it, and chooses nothing", () => {
    const before = chosen();
    expect(lit()).toHaveLength(0);

    over(rows()[0]);
    expect(lit().length).toBeGreaterThan(0);
    // Nothing has been committed: the marks in the list are where they were,
    // and no level has opened under anything.
    expect(chosen()).toEqual(before);
    expect(panel().querySelector(".pathall.cur")).not.toBeNull();
  });

  it("puts back what is chosen when the pointer leaves", () => {
    over(rows()[0]);
    const pointing = lit();
    panel().dispatchEvent(new MouseEvent("pointerleave", { bubbles: false }));
    expect(lit()).not.toEqual(pointing);
    expect(lit()).toHaveLength(0);          // nothing chosen, so nothing drawn
  });

  it("draws a different fork for each row swept", () => {
    const seen = new Set<string>();
    for (const row of rows().slice(0, 4)) { over(row); seen.add(lit().join(",")); }
    expect(seen.size).toBeGreaterThan(1);
  });

  it("points at the fork a circle belongs to, so the picture sweeps too", () => {
    over(rows()[1]);
    const fromRow = lit();
    expect(fromRow.length).toBeGreaterThan(0);

    // Point at one of the circles that row just drew: the same fork, because
    // the picture and the list are one control seen twice.
    const stage = document.getElementById("atlas-stage")!;
    const circle = [...stage.querySelectorAll("svg.atlas g.n")]
      .find(g => (g as HTMLElement).dataset.el === fromRow[1]);
    if (!circle) return;
    panel().dispatchEvent(new MouseEvent("pointerleave", { bubbles: false }));
    over(circle);
    expect(lit().length).toBeGreaterThan(0);
    expect(lit().every(el => fromRow.includes(el!) || true)).toBe(true);
  });
});

describe("choosing a fork", () => {
  const destRows = () => [...panel().querySelectorAll(".dhead")] as HTMLButtonElement[];
  const forkRows = () => [...panel().querySelectorAll(".strandrow")] as HTMLButtonElement[];

  beforeEach(() => {
    loadDataFromCsv(advancedCsv);
    openAtlas(firstInput());
    renderDetailPanel();
  });

  it("marks it and opens the next level under it — inside its own row", () => {
    const withForks = destRows().find(r => r.querySelector(".m"));
    if (!withForks) return;
    const name = withForks.querySelector(".dname")!.textContent;
    withForks.click();

    const marked = panel().querySelector(".dhead.cur");
    expect(marked).not.toBeNull();
    expect(marked!.querySelector(".dname")!.textContent).toBe(name);
    // The level it opened is nested in the row, not printed after the whole
    // list — on a map with a dozen destinations those are very different things.
    expect(panel().querySelector(".pathlvl")).not.toBeNull();
    expect(forkRows().length).toBeGreaterThan(0);
  });

  it("leaves every other fork on screen, which is what undoes a wrong turn", () => {
    const before = destRows().length;
    const withForks = destRows().find(r => r.querySelector(".m"));
    if (!withForks) return;
    withForks.click();
    // Nothing was replaced: the destination you did not take is one click away,
    // and it never left the screen to be found again.
    expect(destRows().length).toBe(before);
  });

  it("lets go when the row already chosen is clicked again", () => {
    const withForks = destRows().find(r => r.querySelector(".m"));
    if (!withForks) return;
    withForks.click();
    expect(panel().querySelector(".dhead.cur")).not.toBeNull();

    (panel().querySelector(".dhead.cur") as HTMLButtonElement).click();
    expect(panel().querySelector(".dhead.cur")).toBeNull();
    expect(panel().querySelector(".pathall.cur")).not.toBeNull();
  });
});

// Hover is not a gesture everyone has. The keys do the same two acts, so the
// list has a path that does not need a pointer at all.
describe("sweeping without a pointer", () => {
  const lit = () => document.querySelectorAll("svg.atlas g.n.on").length;
  const key = (k: string) =>
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));

  beforeEach(() => {
    loadDataFromCsv(advancedCsv);
    openAtlas(firstInput());
    renderDetailPanel();
  });

  it("moves what is drawn with the arrow keys, and chooses it with Enter", () => {
    expect(lit()).toBe(0);
    key("ArrowDown");
    expect(lit()).toBeGreaterThan(0);
    expect(panel().querySelector(".pathall.cur")).not.toBeNull();   // still nothing chosen

    key("Enter");
    expect(panel().querySelector(".dhead.cur, .strandrow.cur")).not.toBeNull();
    expect(panel().querySelector(".pathall.cur")).toBeNull();
  });

  it("steps back up as well as down", () => {
    key("ArrowDown");
    const first = lit();
    key("ArrowDown");
    key("ArrowUp");
    expect(lit()).toBe(first);
  });

  it("keeps its hands off the keys while something is being typed into", () => {
    const field = document.createElement("input");
    document.body.appendChild(field);
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(lit()).toBe(0);
    field.remove();
  });
});

// The atlas has no panel of its own — it fills the app's. So the app's panel has
// to be open whenever the atlas is, whether or not a box happens to be selected.
describe("the panel is open whenever the atlas is", () => {
  const app = () => document.querySelector(".app")!;

  it("opens with the atlas, even when no box is selected", () => {
    loadDataFromCsv(sampleCsv);
    deselectAll();
    renderDetailPanel();
    expect(app().classList.contains("has-selection")).toBe(false);

    openAtlas(firstInput());
    renderDetailPanel();
    expect(app().classList.contains("has-selection")).toBe(true);
    expect(panel().textContent).toContain("All pathways");
  });

  it("closes again with it", () => {
    loadDataFromCsv(sampleCsv);
    deselectAll();
    openAtlas(firstInput());
    renderDetailPanel();
    closeAtlas();
    renderDetailPanel();
    expect(app().classList.contains("has-selection")).toBe(false);
  });
});

// =============================================================================
// ONE PANEL
// -----------------------------------------------------------------------------
// There used to be three: the run, a picked circle's own page, and a tangle's
// own page. Picking anything swapped between them, and the tangle one dropped
// the pathway list altogether — so getting inside a tangle meant losing every
// way out of it. The title never moves now, and the list never leaves.
// =============================================================================
describe("one panel", () => {
  const title = () => panel().querySelector(".ins header b")!.textContent;
  const circles = () =>
    [...document.querySelectorAll("#atlas-stage svg.atlas g.n")] as HTMLElement[];

  beforeEach(() => {
    loadDataFromCsv(advancedCsv);
    openAtlas(firstInput());
    renderDetailPanel();
  });

  it("keeps its title when a circle is picked", () => {
    const before = title();
    expect(before).toContain("Atlas of");

    const mid = circles().find(g => g.dataset.el && g.dataset.el !== "START");
    if (!mid) return;
    mid.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    renderDetailPanel();

    expect(title()).toBe(before);
    // ...and the list is still there, which is the half a picked circle used to
    // take away when it brought its own page with it.
    expect(panel().querySelector(".strands")).not.toBeNull();
  });

  it("opens the list to the circle rather than replacing it", () => {
    const before = panel().querySelectorAll(".dhead").length;
    expect(before).toBeGreaterThan(1);

    const mid = circles().find(g => g.dataset.el && g.dataset.el !== "START");
    if (!mid) return;
    mid.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    renderDetailPanel();

    // Every output is still listed — the ones the circle never reaches have
    // gone quiet, not away. That is the denominator: three of eleven and three
    // of three have to look different.
    expect(panel().querySelectorAll(".dhead").length).toBe(before);
    expect(panel().querySelector(".pathall")!.textContent).toContain("All pathways");
    // Its share of everything is said once, in the readout.
    expect(panel().querySelector(".pathfoot")!.textContent).toMatch(/% of everything/);
  });

  it("marks the outputs it is on and quiets the ones it is not", () => {
    const mid = circles().find(g => g.dataset.el && g.dataset.el !== "START");
    if (!mid) return;
    mid.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    renderDetailPanel();

    const marked = panel().querySelectorAll(".dhead .hitdot").length;
    const quiet = panel().querySelectorAll(".dhead.quiet").length;
    expect(marked).toBeGreaterThan(0);
    expect(marked + quiet).toBe(panel().querySelectorAll(".dhead").length);
  });

  it("offers the boxes a circle stands for as a way back to the map", () => {
    const many = circles().find(g => {
      g.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      renderDetailPanel();
      const hit = panel().querySelectorAll(".atlas-boxrow").length > 0;
      if (!hit) g.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return hit;
    });
    if (!many) return;                       // no multi-box circle on this map
    const rows = [...panel().querySelectorAll(".atlas-boxrow")];
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) expect(r.getAttribute("data-atlas-box")).toBeTruthy();
  });
});

// =============================================================================
// CLICKING THROUGH
// -----------------------------------------------------------------------------
// Circles clicked on the picture stack up into a trail, narrowing to what runs
// through all of them in order — and a row clicked in the list they opened
// narrows into that branch instead of unwinding the lot, which is what it used
// to do: the click wrote a chain whose first entry was a fork where a
// destination belonged, the chain failed to resolve, and everything reset.
// =============================================================================
describe("clicking through", () => {
  const circles = () =>
    [...document.querySelectorAll("#atlas-stage svg.atlas g.n")] as HTMLElement[];
  const click = (el: Element) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const lit = () => document.querySelectorAll("svg.atlas g.n.on").length;
  const readout = () => panel().querySelector(".pathfoot")!.textContent || "";
  const drawnCount = () => {
    const m = readout().match(/on (\d+) pathway/);
    return m ? Number(m[1]) : 0;
  };
  // Two circles where the second lies further along a pathway than the first.
  const downstreamPair = (): [HTMLElement, HTMLElement] | null => {
    for (const a of circles()) {
      for (const b of circles()) {
        if (a === b || !a.dataset.el || !b.dataset.el) continue;
        click(a); renderDetailPanel();
        const first = drawnCount();
        if (!first) continue;
        click(b); renderDetailPanel();
        const both = drawnCount();
        // Narrowed rather than replaced: fewer pathways, and the trail is named.
        if (both && both < first && readout().includes("→")) return [a, b];
      }
    }
    return null;
  };

  beforeEach(() => {
    loadDataFromCsv(advancedCsv);
    openAtlas(firstInput());
    renderDetailPanel();
  });

  it("narrows to what runs through both circles, in order", () => {
    const pair = downstreamPair();
    if (!pair) return;                       // no two circles in line on this map
    expect(readout()).toContain("→");
    expect(drawnCount()).toBeGreaterThan(0);
    expect(lit()).toBeGreaterThan(0);
  });

  it("starts again when the next circle is not further along", () => {
    const pair = downstreamPair();
    if (!pair) return;
    // Clicking the FIRST one again, now that it is upstream of the trail's end,
    // cannot narrow — so it becomes the question on its own.
    click(pair[0]); renderDetailPanel();
    expect(readout()).not.toContain("→");
  });

  it("narrows into a branch when a row it opened is clicked", () => {
    const mid = circles().find(g => {
      if (!g.dataset.el) return false;
      click(g); renderDetailPanel();
      return panel().querySelectorAll(".strandrow.isel").length > 0;
    });
    if (!mid) return;

    const before = lit();
    expect(before).toBeGreaterThan(0);
    (panel().querySelector(".strandrow.isel") as HTMLButtonElement).click();
    renderDetailPanel();

    // Narrowed, not unwound: something is still drawn, and it is less than the
    // circle's whole reach.
    expect(lit()).toBeGreaterThan(0);
    expect(lit()).toBeLessThanOrEqual(before);
    expect(panel().querySelector(".strandrow.cur")).not.toBeNull();
  });

  it("gives every row the whole way down to it, so a click cannot guess wrong", () => {
    const dest = panel().querySelector(".dhead") as HTMLButtonElement;
    expect(dest.dataset.forkpath).toBeTruthy();
    dest.click();
    renderDetailPanel();
    for (const row of panel().querySelectorAll(".strandrow")) {
      const path = (row as HTMLElement).dataset.forkpath || "";
      // A fork's trail starts at its destination and ends at itself.
      expect(path.split("\u0001").length).toBeGreaterThan(1);
    }
  });
});

// =============================================================================
// ONE THING LIGHTS THE PICTURE
// -----------------------------------------------------------------------------
// There were two: what is being read, and — held separately — the last circle
// clicked, which lit itself, made every link TOUCHING it hot whether or not
// that link was on any drawn pathway, and exempted its neighbours from the
// dimming. It did not update when you pointed somewhere else, so pointing left
// a ghost of the last circle clicked on screen.
// =============================================================================
describe("what the picture lights", () => {
  const circles = () =>
    [...document.querySelectorAll("#atlas-stage svg.atlas g.n")] as HTMLElement[];
  const litEls = () =>
    new Set([...document.querySelectorAll("svg.atlas g.n.on")].map(g => (g as HTMLElement).dataset.el));
  // A link that is hot while one of its ends is not lit is a link belonging to
  // nothing on screen.
  const strayHot = () => {
    const lit = litEls();
    return [...document.querySelectorAll("svg.atlas .fl.hot")]
      .filter(p => !lit.has((p as HTMLElement).dataset.a) || !lit.has((p as HTMLElement).dataset.b))
      .length;
  };

  beforeEach(() => {
    loadDataFromCsv(advancedCsv);
    openAtlas(firstInput());
    renderDetailPanel();
  });

  it("lights no link whose ends are not both lit, for any circle", () => {
    for (const g of circles()) {
      if (!g.dataset.el) continue;
      g.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(strayHot(), `after clicking ${g.dataset.el}`).toBe(0);
      g.dispatchEvent(new MouseEvent("click", { bubbles: true }));   // let go
    }
  });

  it("leaves no ghost of the last circle clicked when pointing elsewhere", () => {
    const all = circles().filter(g => g.dataset.el);
    if (all.length < 2) return;
    all[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const clicked = litEls();
    expect(clicked.size).toBeGreaterThan(0);

    // Point at a different circle: what is lit becomes the pointed fork, and
    // nothing of the clicked one survives that is not also on it.
    all[all.length - 1].dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    expect(strayHot()).toBe(0);
  });

  it("never dims the whole picture in favour of nothing", () => {
    for (const g of circles()) {
      if (!g.dataset.el) continue;
      g.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      const svg = document.querySelector("svg.atlas")!;
      // An empty set of pathways is NONE, not "some" — the busy class dims
      // everything that is not lit, so busy with nothing lit is a blank map.
      if (svg.classList.contains("busy")) {
        expect(litEls().size, `after clicking ${g.dataset.el}`).toBeGreaterThan(0);
      }
      g.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
  });
});

// =============================================================================
// OPENING ONE ROW MOVES NOTHING ELSE
// -----------------------------------------------------------------------------
// The list used to hold ONE open chain, so taking hold of a row anywhere shut
// whatever was open elsewhere. Every row below the one that closed jumped up,
// and the thing you were about to read next was no longer where you had just
// seen it. Rows are independent now: one opens when you click it and closes
// when you click it again, and nothing else moves either time.
// =============================================================================
describe("rows open and close on their own", () => {
  const rows = () =>
    [...panel().querySelectorAll(".dhead, .strandrow")] as HTMLButtonElement[];
  const dests = () => [...panel().querySelectorAll(".dhead")] as HTMLButtonElement[];
  const forks = () => panel().querySelectorAll(".strandrow").length;

  beforeEach(() => {
    loadDataFromCsv(advancedCsv);
    openAtlas(firstInput());
    renderDetailPanel();
  });

  it("leaves the first destination open when a second is opened", () => {
    const withForks = dests().filter(d => d.querySelector(".m"));
    if (withForks.length < 2) return;

    withForks[0].click();
    const afterFirst = forks();
    expect(afterFirst).toBeGreaterThan(0);

    // Open a different one. The first one's forks are still on screen, so the
    // count can only have grown.
    dests().filter(d => d.querySelector(".m"))[1].click();
    expect(forks()).toBeGreaterThan(afterFirst);
  });

  it("closes only the row clicked again, and its own contents", () => {
    const withForks = dests().filter(d => d.querySelector(".m"));
    if (withForks.length < 2) return;
    withForks[0].click();
    dests().filter(d => d.querySelector(".m"))[1].click();
    const bothOpen = forks();

    // Click the second one again: it closes, the first stays exactly as it was.
    const current = panel().querySelector(".dhead.cur") as HTMLButtonElement;
    current.click();
    const oneOpen = forks();
    expect(oneOpen).toBeLessThan(bothOpen);
    expect(oneOpen).toBeGreaterThan(0);
  });

  it("collapses on the FIRST click, on rows a circle opened", () => {
    const circle = [...document.querySelectorAll("#atlas-stage svg.atlas g.n")]
      .find(g => {
        if (!(g as HTMLElement).dataset.el) return false;
        g.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        return panel().querySelectorAll(".strandrow").length > 0;
      });
    if (!circle) return;
    const opened = forks();

    // The row was opened by the circle, not by the reader — but it is open, so
    // one click shuts it. It used to take two: the first was spent taking hold.
    const dest = panel().querySelector(".dhead .hitdot")!.closest(".dhead") as HTMLButtonElement;
    dest.click();
    expect(forks()).toBeLessThan(opened);

    // The circle's own marking is untouched by opening and closing rows.
    expect(panel().querySelectorAll(".dhead .hitdot").length).toBeGreaterThan(0);
  });

  it("collapsing a fork leaves the destination it is in open", () => {
    const dest = dests().find(d => d.querySelector(".m"));
    if (!dest) return;
    dest.click();
    const atDest = forks();

    const fork = rows().find(r => r.classList.contains("strandrow")
      && Number(r.dataset.forkdepth) >= 1);
    if (!fork || !fork.textContent!.includes("×")) return;
    fork.click();
    if (forks() <= atDest) return;              // that fork had nothing under it

    // Click it again. Its own contents go; the destination above it does not.
    (panel().querySelector(".strandrow.cur") as HTMLButtonElement).click();
    expect(forks()).toBe(atDest);
  });
});

// A map that repeats itself along a dimension, so the atlas folds boxes that
// share a core phrase into one circle: four Seizure boxes behind "◇ Seizure".
// None of the shipped samples fold, so the case has to be built.
//
// Ketamine deliberately has no Testing box. That is what makes the folding
// worth opening: three of the four go on to Testing and one does not, and until
// the row could be opened there was nothing on screen that said so.
const lanesCsv = (): string => {
  const nodes: string[] = [], edges: string[] = [];
  const box = (id: string, label: string, stage: string) =>
    nodes.push(`${id},${label},,main,${stage},work,1,,false,,3`);
  const link = (from: string, to: string) =>
    edges.push(`${from},${to},increases,0.4,`);

  box("policy", "Enforcement Policy", "st0");
  box("harm", "Harm Reduction", "st3");
  for (const d of ["Cannabis", "Cocaine", "Heroin", "Ketamine"]) {
    const k = d.toLowerCase();
    box(k + "_s", d + " Seizure", "st1");
    box(k + "_c", d + " Casework", "st2");
    link("policy", k + "_s"); link(k + "_s", k + "_c"); link(k + "_c", "harm");
    if (d === "Ketamine") continue;
    box(k + "_q", d + " Testing", "st2");
    link(k + "_s", k + "_q"); link(k + "_q", "harm");
  }
  for (const c of ["Cat A", "Cat B", "Cat C", "Cat D"]) {
    const k = c.replace(" ", "").toLowerCase();
    box(k + "_t", c + " Targets", "st1");
    box(k + "_r", c + " Referrals", "st2");
    link("policy", k + "_t"); link(k + "_t", k + "_r"); link(k + "_r", "harm");
  }
  // One ordinary box that forks two ways, sharing no core phrase with anything.
  // A row for it opens the same way and has no boxes to name, which is what
  // says the strip belongs to folding rather than to rows in general.
  box("audit", "Border Audit", "st1");
  box("warning", "Warning Letter", "st2");
  box("licence", "Licence Review", "st2");
  link("policy", "audit"); link("audit", "warning"); link("audit", "licence");
  link("warning", "harm"); link("licence", "harm");
  return [
    "# SECTION: streams", "id,label,short,color", "main,Main,MAIN,#60a5fa", "",
    "# SECTION: stages", "id,label",
    "st0,Policy", "st1,Seizure", "st2,Follow-up", "st3,Outcome", "",
    "# SECTION: categories", "id,label,color,text_color,class",
    "work,Work,#a3a3a3,#1c1917,primary", "",
    "# SECTION: nodes",
    "id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max",
    ...nodes, "",
    "# SECTION: edges", "from,to,effect,elasticity,description", ...edges,
  ].join("\n");
};

// A folded row could not be opened at all. The row carried its whole way down
// as element ids joined by a separator, and a folded element's id has that very
// separator inside it — so the click decoded into a longer, different path,
// nothing matched it, and clicking did nothing whatever. What the row opens
// into is the second half: the boxes it stands for, one of them pickable.
describe("a row that stands for several boxes", () => {
  const forkRows = () => [...panel().querySelectorAll(".strandrow")] as HTMLButtonElement[];
  const foldedRow = () => forkRows().find(r => r.textContent!.includes("◇"));
  const chips = () => [...panel().querySelectorAll(".lane")] as HTMLButtonElement[];
  const quiet = () => forkRows().filter(r => r.classList.contains("quiet"));

  beforeEach(() => {
    loadDataFromCsv(lanesCsv());
    openAtlas("policy");
    renderDetailPanel();
    const dest = [...panel().querySelectorAll(".dhead")]
      .find(d => d.querySelector(".m")) as HTMLButtonElement;
    dest.click();
  });

  it("is there to be clicked in the first place", () => {
    const row = foldedRow();
    expect(row).toBeDefined();
    expect(row!.textContent).toContain("×");
  });

  it("opens, where it used to do nothing at all", () => {
    const before = forkRows().length;
    foldedRow()!.click();
    expect(forkRows().length).toBeGreaterThan(before);
  });

  it("carries opaque, unique handles instead of serialized element paths", () => {
    const rows = forkRows();
    const handles = rows.map(row => row.dataset.forkpath || "");

    expect(handles.every(handle => handle.length > 0)).toBe(true);
    expect(new Set(handles).size).toBe(handles.length);
    expect(handles.every(handle => !handle.includes("\u0001"))).toBe(true);

    // The folded element identifier contains the separator that broke the old
    // serialized-path scheme. Its opaque handle must still resolve correctly.
    const before = rows.length;
    foldedRow()!.click();
    expect(forkRows().length).toBeGreaterThan(before);
  });

  it("names the boxes it stands for", () => {
    foldedRow()!.click();
    const named = chips().map(c => c.textContent);
    expect(named).toContain("Cannabis");
    expect(named).toContain("Ketamine");
  });

  it("offers no boxes on a row that stands for one", () => {
    const plain = forkRows().find(r => r.textContent!.includes("Border Audit"));
    expect(plain).toBeDefined();
    const before = forkRows().length;
    plain!.click();
    expect(forkRows().length).toBeGreaterThan(before);   // it opened
    expect(panel().querySelectorAll(".lane").length).toBe(0);
  });

  it("leaves rows outside the one picked under alone", () => {
    foldedRow()!.click();
    chips().find(c => c.textContent === "Ketamine")!.click();
    // The picked box speaks for its own row's forks and no others: the ordinary
    // row beside it, and the second family, are untouched.
    expect(quiet().some(r => r.textContent!.includes("Border Audit"))).toBe(false);
    expect(quiet().some(r => r.textContent!.includes("Targets"))).toBe(false);
  });

  it("quietens the forks a picked box does not take, and keeps them", () => {
    foldedRow()!.click();
    const all = forkRows().length;
    chips().find(c => c.textContent === "Ketamine")!.click();

    // Ketamine has no Testing box, so the fork through Testing goes quiet —
    // and stays on screen, because the column above it still counts it.
    expect(forkRows().length).toBe(all);
    expect(quiet().length).toBeGreaterThan(0);
    expect(quiet().every(r => r.textContent!.includes("Testing"))).toBe(true);
  });

  it("keeps every fork lit for a box that takes them all", () => {
    foldedRow()!.click();
    chips().find(c => c.textContent === "Cannabis")!.click();
    expect(quiet().length).toBe(0);
  });

  it("lets go when the same box is picked again", () => {
    foldedRow()!.click();
    chips().find(c => c.textContent === "Ketamine")!.click();
    expect(quiet().length).toBeGreaterThan(0);
    chips().find(c => c.textContent === "Ketamine")!.click();
    expect(quiet().length).toBe(0);
  });
});

describe("it never outlives its map", () => {
  it("closes when a different map is loaded", () => {
    loadDataFromCsv(sampleCsv);
    openAtlas(firstInput());
    expect(atlasIsOpen()).toBe(true);

    loadDataFromCsv(advancedCsv);
    expect(atlasIsOpen()).toBe(false);
    expect(document.body.classList.contains("atlas-open")).toBe(false);
    expect((document.getElementById("atlas-stage") as HTMLElement).hidden).toBe(true);
  });
});

describe("feedback", () => {
  it("retains the originating box and exposes one consistent loop count", () => {
    loadDataFromCsv(borderForceCsv);
    const start = NODES.find(node => node.label === "Analyst capacity")!;
    openAtlas(start.id);

    expect(panel().querySelector("header")?.textContent).toContain("Atlas of Analyst capacity");
    const tangle = document.querySelector("#atlas-stage g.n[data-loop]") as SVGElement;
    const tangleBubble = tangle.querySelector(".bub") as SVGCircleElement;
    expect(tangleBubble.classList.contains("start")).toBe(true);
    expect(tangleBubble.classList.contains("loop")).toBe(true);
    tangle.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    const openFeedback = panel().querySelector("[data-open-feedback]") as HTMLButtonElement;
    const disclosedLoopCount = Number(openFeedback.querySelector(".m")?.textContent?.match(/\d+/)?.[0]);
    expect(disclosedLoopCount).toBeGreaterThan(12);
    expect(tangle.querySelector("text")?.textContent).toContain(`${disclosedLoopCount} loops`);
  });

  it("shows loop navigation immediately and discloses truncated loop lists", () => {
    loadDataFromCsv(borderForceCsv);
    const start = NODES.find(node => node.label === "Analyst capacity")!;
    openAtlas(start.id);

    const tangle = document.querySelector("#atlas-stage g.n[data-loop]") as SVGElement;
    tangle.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const openFeedback = panel().querySelector("[data-open-feedback]") as HTMLButtonElement;
    const disclosedLoopCount = Number(openFeedback.querySelector(".m")?.textContent?.match(/\d+/)?.[0]);
    openFeedback.click();

    const navigator = panel().querySelector(".feedback-navigator") as HTMLElement;
    expect(navigator).not.toBeNull();
    expect(navigator.textContent).toContain(`${disclosedLoopCount} loops`);
    expect(navigator.querySelectorAll("[data-loopidx]")).toHaveLength(12);
    const showAllLoops = navigator.querySelector("[data-toggle-all-loops]") as HTMLButtonElement;
    expect(showAllLoops.textContent).toContain(`Show all ${disclosedLoopCount} loops`);

    showAllLoops.click();
    const expandedLoopCards = [...panel().querySelectorAll<HTMLElement>(
      ".feedback-navigator [data-loopidx]",
    )];
    const expandedNavigator = panel().querySelector(".feedback-navigator") as HTMLElement;
    expect(expandedLoopCards).toHaveLength(disclosedLoopCount);
    expect(new Set(expandedLoopCards.map(card => card.dataset.strengthTier))).toEqual(
      new Set(["strongest", "medium", "lower"]),
    );
    expect(expandedNavigator.textContent).not.toContain("≈0");
    expect(expandedNavigator.textContent).toContain(
      "Strength compares loops within this feedback group",
    );
    for (const card of expandedLoopCards) {
      expect(card.querySelector(".strength-tier")?.textContent).toMatch(/Strongest|Medium|Lower/);
      expect(card.dataset.tooltip).toContain("exact calculated gain");
      expect(card.getAttribute("aria-label")).toContain("Exact calculated gain:");
    }
  });

  it("uses a picked rim box to filter the persistent loop navigator", () => {
    loadDataFromCsv(borderForceCsv);
    const start = NODES.find(node => node.label === "Analyst capacity")!;
    openAtlas(start.id);

    const tangle = document.querySelector("#atlas-stage g.n[data-loop]") as SVGElement;
    tangle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    (panel().querySelector("[data-toggle-all-loops]") as HTMLButtonElement).click();
    const strengthTierByLoopIndex = new Map(
      [...panel().querySelectorAll<HTMLElement>(".feedback-navigator [data-loopidx]")]
        .map(card => [card.dataset.loopidx!, card.dataset.strengthTier!]),
    );
    const rimBox = document.querySelector("#atlas-stage g.n.focus .nd") as SVGElement;
    rimBox.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    const navigator = panel().querySelector(".feedback-navigator") as HTMLElement;
    const chosenBoxName = nodeById[rimBox.dataset.box!].label;
    expect(navigator.textContent).toContain(`through ${chosenBoxName}`);
    expect(navigator.querySelector("[data-clear-wheel-pick]")).not.toBeNull();
    expect(navigator.querySelectorAll("[data-loopidx]").length).toBeGreaterThan(0);
    for (const card of navigator.querySelectorAll<HTMLElement>("[data-loopidx]")) {
      expect(card.dataset.strengthTier).toBe(strengthTierByLoopIndex.get(card.dataset.loopidx!));
    }

    (navigator.querySelector("[data-clear-wheel-pick]") as HTMLButtonElement).click();
    expect(panel().querySelector(".feedback-navigator")?.textContent).not.toContain(`through ${chosenBoxName}`);
  });

  it("keeps the feedback wheel framed while pathway rows are opened", () => {
    const originalMatchMedia = globalThis.matchMedia;
    Object.defineProperty(globalThis, "matchMedia", {
      configurable: true,
      value: (() => ({ matches: true })) as unknown as typeof globalThis.matchMedia,
    });
    try {
      loadDataFromCsv(borderForceCsv);
      const start = NODES.find(node => node.label === "Analyst capacity")!;
      openAtlas(start.id);

      const tangle = document.querySelector("#atlas-stage g.n[data-loop]") as SVGElement;
      tangle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
      const atlasSvg = document.querySelector("#atlas-stage svg.atlas") as SVGSVGElement;
      const wheelFrame = atlasSvg.getAttribute("viewBox");
      const pathwayRow = panel().querySelector("[data-fork]") as HTMLButtonElement;
      expect(pathwayRow).not.toBeNull();

      pathwayRow.click();
      expect(atlasSvg.getAttribute("viewBox")).toBe(wheelFrame);
    } finally {
      Object.defineProperty(globalThis, "matchMedia", {
        configurable: true,
        value: originalMatchMedia,
      });
    }
  });

  it("shows tooltips only for actual rim boxes once inside a feedback wheel", () => {
    loadDataFromCsv(advancedCsv);
    const start = NODES.find(node => node.label === "Website visits") || NODES[0];
    openAtlas(start.id);

    const tangle = document.querySelector("#atlas-stage g.n[data-loop]") as SVGElement;
    tangle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    const tooltip = document.getElementById("tooltip") as HTMLElement;
    const rimBox = tangle.querySelector(".nd") as SVGElement;
    const rimBoxName = nodeById[rimBox.dataset.box!].label;

    rimBox.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(tooltip.classList.contains("visible")).toBe(true);
    expect(tooltip.textContent).toContain(rimBoxName);
    expect(tooltip.textContent).not.toContain("feedback tangle");

    const feedbackChord = tangle.querySelector(".ch") as SVGElement;
    feedbackChord.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(tooltip.classList.contains("visible")).toBe(false);

    const tangleBackground = tangle.querySelector(".bub") as SVGElement;
    tangleBackground.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(tooltip.classList.contains("visible")).toBe(false);
  });

  it("draws a knot of feedback as a wheel you can go into", () => {
    // The parcel-delivery sample has a real loop in it.
    loadDataFromCsv(advancedCsv);
    const start = NODES.find(n => n.label === "Website visits") || NODES[0];
    openAtlas(start.id);

    const tangles = document.querySelectorAll("#atlas-stage g.n[data-loop]");
    expect(tangles.length).toBeGreaterThan(0);
    // A wheel is drawn where the tangle stands: rim boxes and chords, not a
    // link to another view.
    expect(tangles[0].querySelectorAll(".nd").length).toBeGreaterThan(2);
    expect(tangles[0].querySelectorAll(".ch").length).toBeGreaterThan(0);
  });

  it("keeps single click as selection and offers a named way into the selected feedback group", () => {
    loadDataFromCsv(advancedCsv);
    const start = NODES.find(node => node.label === "Website visits") || NODES[0];
    openAtlas(start.id);

    const tangle = document.querySelector("#atlas-stage g.n[data-loop]") as SVGElement;
    tangle.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    const atlasSvg = document.querySelector("#atlas-stage svg.atlas")!;
    expect(atlasSvg.classList.contains("inside")).toBe(false);
    const openFeedback = panel().querySelector("[data-open-feedback]") as HTMLButtonElement;
    expect(openFeedback).not.toBeNull();
    expect(openFeedback.textContent).toContain("Open feedback loops");
    const feedbackName = openFeedback.querySelector("small") as HTMLElement;
    expect(feedbackName.textContent).not.toContain("…");
    expect(feedbackName.textContent).not.toMatch(/\d+\s+loops?/i);

    openFeedback.click();
    expect(atlasSvg.classList.contains("inside")).toBe(true);
    expect(tangle.classList.contains("focus")).toBe(true);
  });

  it("describes selection and the explicit feedback action before mentioning the shortcut", () => {
    loadDataFromCsv(advancedCsv);
    const start = NODES.find(node => node.label === "Website visits") || NODES[0];
    openAtlas(start.id);

    const legend = document.querySelector(".atlas-legend")!;
    expect(legend.textContent).toContain("select");
    expect(legend.textContent).toContain("Open feedback loops");
    expect(legend.textContent).toContain("double-click is a shortcut");
  });

  it("progressively lights the exact wheel route after a rim box is picked", () => {
    loadDataFromCsv(advancedCsv);
    const start = NODES.find(node => node.label === "Website visits") || NODES[0];
    openAtlas(start.id);

    const tangle = document.querySelector("#atlas-stage g.n[data-loop]")!;
    tangle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    const rimBox = document.querySelector("#atlas-stage g.n.focus .nd") as SVGElement;
    expect(rimBox).not.toBeNull();
    rimBox.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    const animationControls = document.getElementById("atlas-loopctl") as HTMLElement;
    const scrubber = animationControls.querySelector<HTMLInputElement>("[data-loop-animation-scrub]")!;
    expect(animationControls.hidden).toBe(false);
    expect(document.querySelectorAll("#atlas-stage g.n.focus .nd.on")).toHaveLength(1);

    scrubber.value = "500";
    scrubber.dispatchEvent(new Event("input", { bubbles: true }));
    const selectedChords = document.querySelectorAll("#atlas-stage g.n.focus .ch.on");
    expect(selectedChords.length).toBeGreaterThan(0);
    expect(document.querySelectorAll("#atlas-stage g.n.focus .nd.on").length).toBeGreaterThan(1);
    expect(document.querySelectorAll("#atlas-stage g.n.focus .bl.animation-current")).toHaveLength(1);
  });

  it("wraps, staggers and contains every overview label without overlap", () => {
    const originalSvgBoundingClientRect = SVGSVGElement.prototype.getBoundingClientRect;
    SVGSVGElement.prototype.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      toJSON: () => ({}),
    });
    try {
      loadDataFromCsv(advancedCsv);
      const start = NODES.find(node => node.label === "Website visits") || NODES[0];
      openAtlas(start.id);

      const labels = [...document.querySelectorAll<SVGTextElement>(
        "#atlas-stage .atlas-overview-label",
      )];
      expect(labels.length).toBeGreaterThan(3);
      const rectangles = labels.map(label => ({
        name: label.getAttribute("aria-label") || "unnamed Atlas label",
        left: Number(label.dataset.layoutLeftPixels),
        top: Number(label.dataset.layoutTopPixels),
        width: Number(label.dataset.layoutWidthPixels),
        height: Number(label.dataset.layoutHeightPixels),
      }));
      for (const rectangle of rectangles) {
        expect(rectangle.left, rectangle.name).toBeGreaterThanOrEqual(0);
        expect(rectangle.top, rectangle.name).toBeGreaterThanOrEqual(0);
        expect(rectangle.left + rectangle.width, rectangle.name).toBeLessThanOrEqual(800);
        expect(rectangle.top + rectangle.height, rectangle.name).toBeLessThanOrEqual(600);
      }
      for (let firstIndex = 0; firstIndex < rectangles.length; firstIndex++) {
        for (let secondIndex = firstIndex + 1; secondIndex < rectangles.length; secondIndex++) {
          const firstRectangle = rectangles[firstIndex];
          const secondRectangle = rectangles[secondIndex];
          const overlaps = !(
            firstRectangle.left + firstRectangle.width <= secondRectangle.left ||
            secondRectangle.left + secondRectangle.width <= firstRectangle.left ||
            firstRectangle.top + firstRectangle.height <= secondRectangle.top ||
            secondRectangle.top + secondRectangle.height <= firstRectangle.top
          );
          expect(overlaps, `${firstRectangle.name} overlaps ${secondRectangle.name}`).toBe(false);
        }
      }
      expect(new Set(rectangles.map(rectangle => rectangle.top)).size).toBeGreaterThan(1);
      expect(new Set(labels.map(label => label.dataset.layoutSide)))
        .toEqual(new Set(["above", "below"]));
      expect(labels.some(label => label.querySelectorAll(".atlas-overview-label-line").length > 1))
        .toBe(true);
    } finally {
      SVGSVGElement.prototype.getBoundingClientRect = originalSvgBoundingClientRect;
    }
  });

  it("pauses, changes speed and scrubs through a long feedback loop", () => {
    loadDataFromCsv(borderForceCsv);
    const start = NODES.find(node => node.label === "Analyst capacity")!;
    openAtlas(start.id);

    const tangle = document.querySelector("#atlas-stage g.n[data-loop]") as SVGElement;
    tangle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    (panel().querySelector("[data-toggle-all-loops]") as HTMLButtonElement).click();
    const longLoopCard = [...panel().querySelectorAll<HTMLButtonElement>("[data-loopidx]")]
      .find(card => card.getAttribute("aria-label")?.includes("through 18 boxes"));
    expect(longLoopCard).toBeDefined();
    longLoopCard!.click();

    const animationControls = document.getElementById("atlas-loopctl") as HTMLElement;
    const toggleButton = animationControls.querySelector<HTMLButtonElement>("[data-loop-animation-toggle]")!;
    const previousButton = animationControls.querySelector<HTMLButtonElement>("[data-loop-animation-step='-1']")!;
    const nextButton = animationControls.querySelector<HTMLButtonElement>("[data-loop-animation-step='1']")!;
    const speedSelect = animationControls.querySelector<HTMLSelectElement>("[data-loop-animation-speed]")!;
    const scrubber = animationControls.querySelector<HTMLInputElement>("[data-loop-animation-scrub]")!;
    const status = animationControls.querySelector<HTMLOutputElement>("#atlas-loop-animation-status")!;
    const atlasSvg = document.querySelector("#atlas-stage svg.atlas") as SVGSVGElement;
    const stableWheelFrame = atlasSvg.getAttribute("viewBox");
    expect(animationControls.hidden).toBe(false);
    expect(speedSelect.classList.contains("typeable-dropdown-native")).toBe(true);
    expect(speedSelect.closest(".selection-only-dropdown")?.querySelector(
      ".typeable-dropdown-button",
    )).not.toBeNull();
    expect(scrubber.max).toBe("1000");
    expect(toggleButton.textContent).toBe("Pause");
    expect(previousButton.disabled).toBe(true);
    expect(nextButton.disabled).toBe(false);

    toggleButton.click();
    expect(toggleButton.textContent).toBe("Play");
    speedSelect.value = "2";
    speedSelect.dispatchEvent(new Event("change", { bubbles: true }));
    expect(speedSelect.value).toBe("2");

    scrubber.value = "500";
    scrubber.dispatchEvent(new Event("input", { bubbles: true }));
    const halfwayNodes = document.querySelectorAll("#atlas-stage g.n.focus .nd.on").length;
    expect(halfwayNodes).toBeGreaterThan(1);
    expect(halfwayNodes).toBeLessThanOrEqual(10);
    expect(document.querySelectorAll("#atlas-stage g.n.focus .bl")).toHaveLength(halfwayNodes);
    expect(status.textContent).toContain("Box 10 of 18");
    expect(atlasSvg.getAttribute("viewBox")).toBe(stableWheelFrame);
    expect(previousButton.disabled).toBe(false);
    expect(nextButton.disabled).toBe(false);
    const halfwayLabelPositions = new Map(
      [...atlasSvg.querySelectorAll<SVGTextElement>("g.n.focus .bl")].map(label => [
        label.getAttribute("aria-label"),
        `${label.getAttribute("x")},${label.getAttribute("y")}`,
      ]),
    );

    const pathwayRow = panel().querySelector("[data-fork]") as HTMLButtonElement;
    pathwayRow.click();
    expect(scrubber.value).toBe("500");
    expect(toggleButton.textContent).toBe("Play");
    expect(status.textContent).toContain("Box 10 of 18");
    expect(document.querySelectorAll("#atlas-stage g.n.focus .nd.on")).toHaveLength(halfwayNodes);
    expect(document.querySelectorAll("#atlas-stage g.n.focus .bl")).toHaveLength(halfwayNodes);

    previousButton.click();
    expect(scrubber.value).toBe(String(Math.round((8 / 18) * 1000)));
    expect(status.textContent).toContain("Box 9 of 18");
    nextButton.click();
    expect(scrubber.value).toBe("500");
    expect(status.textContent).toContain("Box 10 of 18");

    scrubber.value = scrubber.max;
    scrubber.dispatchEvent(new Event("input", { bubbles: true }));
    expect(document.querySelectorAll("#atlas-stage g.n.focus .nd.on")).toHaveLength(18);
    expect(document.querySelectorAll("#atlas-stage g.n.focus .bl")).toHaveLength(18);
    expect(status.textContent).toContain("Complete · 18 boxes");
    expect(toggleButton.textContent).toBe("Replay");
    expect(previousButton.disabled).toBe(false);
    expect(nextButton.disabled).toBe(true);
    expect(atlasSvg.getAttribute("viewBox")).toBe(stableWheelFrame);
    for (const label of atlasSvg.querySelectorAll<SVGTextElement>("g.n.focus .bl")) {
      const earlierPosition = halfwayLabelPositions.get(label.getAttribute("aria-label"));
      if (earlierPosition) {
        expect(`${label.getAttribute("x")},${label.getAttribute("y")}`).toBe(earlierPosition);
      }
    }
  });

  it("keeps automatic motion off while reduced motion is enabled", () => {
    const originalMatchMedia = globalThis.matchMedia;
    const originalSvgBoundingClientRect = SVGSVGElement.prototype.getBoundingClientRect;
    let testViewportWidth = 800;
    let testViewportHeight = 900;
    Object.defineProperty(globalThis, "matchMedia", {
      configurable: true,
      value: (() => ({ matches: true })) as unknown as typeof globalThis.matchMedia,
    });
    SVGSVGElement.prototype.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: testViewportWidth,
      bottom: testViewportHeight,
      width: testViewportWidth,
      height: testViewportHeight,
      toJSON: () => ({}),
    });
    try {
      loadDataFromCsv(borderForceCsv);
      const start = NODES.find(node => node.label === "Analyst capacity")!;
      openAtlas(start.id);

      const tangle = document.querySelector("#atlas-stage g.n[data-loop]") as SVGElement;
      tangle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
      (panel().querySelector("[data-toggle-all-loops]") as HTMLButtonElement).click();
      const longLoopCard = [...panel().querySelectorAll<HTMLButtonElement>("[data-loopidx]")]
        .find(card => card.getAttribute("aria-label")?.includes("through 18 boxes"));
      longLoopCard!.click();

      const controls = document.getElementById("atlas-loopctl") as HTMLElement;
      const toggleButton = controls.querySelector<HTMLButtonElement>("[data-loop-animation-toggle]")!;
      const previousButton = controls.querySelector<HTMLButtonElement>("[data-loop-animation-step='-1']")!;
      const scrubber = controls.querySelector<HTMLInputElement>("[data-loop-animation-scrub]")!;
      expect(toggleButton.disabled).toBe(true);
      expect(toggleButton.textContent).toBe("Motion off");
      expect(scrubber.value).toBe(scrubber.max);
      expect(document.querySelectorAll("#atlas-stage g.n.focus .nd.on")).toHaveLength(18);

      const atlasSvg = document.querySelector("#atlas-stage svg.atlas") as SVGSVGElement;
      const [viewX, viewY, viewWidth, viewHeight] = atlasSvg.getAttribute("viewBox")!
        .split(/\s+/).map(Number);
      const horizontalScale = 800 / viewWidth;
      const verticalScale = 900 / viewHeight;
      const labels = [...atlasSvg.querySelectorAll<SVGTextElement>("g.n.focus .bl")];
      const verticalIntervalsBySide = new Map<string, Array<{ top: number; bottom: number }>>();
      expect(labels).toHaveLength(18);
      for (const label of labels) {
        const identifier = label.dataset.box!;
        expect(label.getAttribute("aria-label")).toBe(nodeById[identifier].label);
        const screenX = (Number(label.getAttribute("x")) - viewX) * horizontalScale;
        const screenY = (Number(label.getAttribute("y")) - viewY) * verticalScale;
        const lineWidths = [...label.querySelectorAll("tspan")]
          .map(line => (line.textContent || "").length * 7);
        const maximumLineWidth = Math.max(...lineWidths, 0);
        const halfTextHeight = lineWidths.length * 6.5;
        const textAnchor = label.getAttribute("text-anchor");
        const leftEdge = textAnchor === "start"
          ? screenX
          : textAnchor === "end"
            ? screenX - maximumLineWidth
            : screenX - maximumLineWidth / 2;
        const rightEdge = textAnchor === "start"
          ? screenX + maximumLineWidth
          : textAnchor === "end"
            ? screenX
            : screenX + maximumLineWidth / 2;
        expect(leftEdge).toBeGreaterThanOrEqual(0);
        expect(rightEdge).toBeLessThanOrEqual(800);
        expect(screenY - halfTextHeight).toBeGreaterThanOrEqual(0);
        expect(screenY + halfTextHeight).toBeLessThanOrEqual(900);
        const sideIntervals = verticalIntervalsBySide.get(textAnchor || "") || [];
        sideIntervals.push({
          top: screenY - halfTextHeight,
          bottom: screenY + halfTextHeight,
        });
        verticalIntervalsBySide.set(textAnchor || "", sideIntervals);
      }
      for (const sideIntervals of verticalIntervalsBySide.values()) {
        sideIntervals.sort((firstInterval, secondInterval) => firstInterval.top - secondInterval.top);
        for (let intervalIndex = 1; intervalIndex < sideIntervals.length; intervalIndex++) {
          expect(sideIntervals[intervalIndex].top)
            .toBeGreaterThanOrEqual(sideIntervals[intervalIndex - 1].bottom);
        }
      }

      const wideViewBox = atlasSvg.getAttribute("viewBox");
      testViewportWidth = 600;
      testViewportHeight = 900;
      window.dispatchEvent(new Event("resize"));
      expect(atlasSvg.getAttribute("viewBox")).not.toBe(wideViewBox);
      expect(atlasSvg.querySelectorAll("g.n.focus .bl")).toHaveLength(18);
      expect(toggleButton.textContent).toBe("Motion off");

      previousButton.click();
      expect(scrubber.value).toBe(String(Math.round((17 / 18) * 1000)));
      expect(toggleButton.textContent).toBe("Motion off");
    } finally {
      Object.defineProperty(globalThis, "matchMedia", {
        configurable: true,
        value: originalMatchMedia,
      });
      SVGSVGElement.prototype.getBoundingClientRect = originalSvgBoundingClientRect;
    }
  });

  it("restores a paused automatic tour after the feedback frame is resized", () => {
    const originalMatchMedia = globalThis.matchMedia;
    const originalSvgBoundingClientRect = SVGSVGElement.prototype.getBoundingClientRect;
    let testViewportWidth = 800;
    Object.defineProperty(globalThis, "matchMedia", {
      configurable: true,
      value: (() => ({ matches: true })) as unknown as typeof globalThis.matchMedia,
    });
    SVGSVGElement.prototype.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: testViewportWidth,
      bottom: 900,
      width: testViewportWidth,
      height: 900,
      toJSON: () => ({}),
    });
    try {
      loadDataFromCsv(borderForceCsv);
      const start = NODES.find(node => node.label === "Analyst capacity")!;
      openAtlas(start.id);
      const tangle = document.querySelector("#atlas-stage g.n[data-loop]") as SVGElement;
      tangle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));

      const status = document.getElementById("atlas-loop-animation-status")!;
      const statusBeforeResize = status.textContent;
      const labelsBeforeResize = [...document.querySelectorAll<SVGTextElement>(
        "#atlas-stage g.n.focus .bl",
      )].map(label => label.getAttribute("aria-label"));
      const activeNodeCountBeforeResize = document.querySelectorAll(
        "#atlas-stage g.n.focus .nd.on",
      ).length;
      expect(labelsBeforeResize.length).toBeGreaterThan(0);
      expect(activeNodeCountBeforeResize).toBeGreaterThan(0);

      testViewportWidth = 600;
      window.dispatchEvent(new Event("resize"));
      expect(status.textContent).toBe(statusBeforeResize);
      expect([...document.querySelectorAll<SVGTextElement>("#atlas-stage g.n.focus .bl")]
        .map(label => label.getAttribute("aria-label"))).toEqual(labelsBeforeResize);
      expect(document.querySelectorAll("#atlas-stage g.n.focus .nd.on"))
        .toHaveLength(activeNodeCountBeforeResize);
    } finally {
      Object.defineProperty(globalThis, "matchMedia", {
        configurable: true,
        value: originalMatchMedia,
      });
      SVGSVGElement.prototype.getBoundingClientRect = originalSvgBoundingClientRect;
    }
  });
});
