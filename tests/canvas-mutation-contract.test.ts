import { beforeEach, describe, expect, it } from "vitest";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import { EDGES, NODES, PARAMS, setParams, state } from "../assets/js/03-state";
import {
  bootEmptyStateGrid,
  commitNewEdge,
  cycleSelectedEdgeEffect,
  endEdgeCycleSession,
} from "../assets/js/16e-canvas-edit";
import { applyCanvasMutation } from "../assets/js/16f-canvas-mutations";
import {
  _computeUndoFocus,
  _snapshotSignatures,
  historyUndo,
} from "../assets/js/16g-canvas-undo";
import { recordVerdict, saveReviewsNow } from "../assets/js/24-review-record";
import { recomputeValues, solverGeneration } from "../assets/js/07-simulation-engine";
import { applyEdgeFieldEdit, applyNodeFieldEdit } from "../assets/js/15-detail-panel";
import { loadUiStateFromStorage, saveUiStateToStorage } from "../assets/js/04a-storage";
import { render } from "../assets/js/11-rendering";
import { LINEAR_CSV, REROUTE_CSV } from "./fixtures/graphs";

describe("edge geometry cache invalidation", () => {
  it("draws an edge appended after the geometry cache is warm", () => {
    expect(loadDataFromCsv(LINEAR_CSV)).toBe(true);
    render();

    const newEdge = commitNewEdge("a", "c", "decreases");

    expect(newEdge?.id).toBeTruthy();
    expect(document.querySelector('.edge-path[data-edge-id="' + newEdge!.id + '"]')).not.toBeNull();
  });

  it("refreshes a cached collapsed connector after style and effect edits", () => {
    expect(loadDataFromCsv(REROUTE_CSV)).toBe(true);
    state.hiddenStages = new Set(["s2"]);
    render();
    expect(document.querySelector(".edge-path.synthetic")?.getAttribute("stroke-dasharray")).toBeNull();

    const styleInput = document.createElement("input");
    styleInput.value = "dashed";
    applyEdgeFieldEdit(EDGES[0].id!, "style", styleInput);

    expect(document.querySelector(".edge-path.synthetic")?.getAttribute("stroke-dasharray")).toBe("5 4");

    const effectInput = document.createElement("input");
    effectInput.value = "decreases";
    applyEdgeFieldEdit(EDGES[0].id!, "effect", effectInput);

    expect(document.querySelector(".edge-path.synthetic")?.classList.contains("effect-decreases")).toBe(true);
  });
});

describe("mode-aware edge mutation", () => {
  beforeEach(() => {
    loadDataFromCsv(LINEAR_CSV);
    state.selectedEdgeId = EDGES[0].id!;
    state.uiMode = "read";
    state.simulationMode = false;
  });

  it("does not cycle an edge while reading", () => {
    const originalEffect = EDGES[0].effect;

    expect(cycleSelectedEdgeEffect(1)).toBe(false);
    expect(EDGES[0].effect).toBe(originalEffect);
  });

  it("does not cycle an edge during simulation, even if Edit was retained", () => {
    const originalEffect = EDGES[0].effect;
    state.uiMode = "edit";
    state.simulationMode = true;

    expect(cycleSelectedEdgeEffect(1)).toBe(false);
    expect(EDGES[0].effect).toBe(originalEffect);
  });

  it("cycles an edge while editing outside simulation", () => {
    const originalEffect = EDGES[0].effect;
    state.uiMode = "edit";

    expect(cycleSelectedEdgeEffect(1)).toBe(true);
    expect(EDGES[0].effect).not.toBe(originalEffect);
    endEdgeCycleSession();
  });
});

describe("model history keeps the Review audit log", () => {
  beforeEach(() => {
    loadDataFromCsv(LINEAR_CSV);
    state.uiMode = "edit";
    state.reviewer = "Ada Lovelace";
  });

  it("retains a verdict when undo restores a model snapshot from before it", () => {
    NODES[1].label = "Changed label";
    applyCanvasMutation();
    recordVerdict("b", "agreed", { date: "2026-09-01" });
    saveReviewsNow();

    expect(historyUndo()).toBe(true);

    expect(NODES[1].label).toBe("Middle B");
    expect(state.reviews.b).toMatchObject({
      boxId: "b",
      verdict: "agreed",
      reviewer: "Ada Lovelace",
    });
  });
});

describe("undo change signatures", () => {
  it("marks style and evidence-only edge edits for flash and recenter", () => {
    expect(loadDataFromCsv(LINEAR_CSV)).toBe(true);
    const edgeId = EDGES[0].id!;
    const before = _snapshotSignatures();

    EDGES[0].style = "dashed";
    EDGES[0].evidence = {
      status: "supported",
      rationale: "Observed repeatedly",
    };
    const focus = _computeUndoFocus(before, _snapshotSignatures());

    expect(focus.flashEdgeIds).toEqual(new Set([edgeId]));
    expect(focus.flashNodeIds).toEqual(new Set([EDGES[0].from, EDGES[0].to]));
    expect(focus.focusNodeIds).toEqual(expect.arrayContaining([EDGES[0].from, EDGES[0].to]));
  });
});

describe("mutation impact contracts", () => {
  beforeEach(() => loadDataFromCsv(LINEAR_CSV));

  it("does not rebuild the solver for presentation-only descriptions", () => {
    const nodeDescriptionInput = document.createElement("input");
    nodeDescriptionInput.value = "A clearer explanation";
    const generationBeforeNodeDescription = solverGeneration();

    applyNodeFieldEdit(NODES[0], "description", nodeDescriptionInput);

    expect(solverGeneration()).toBe(generationBeforeNodeDescription);

    const edgeDescriptionInput = document.createElement("input");
    edgeDescriptionInput.value = "A clearer causal account";
    const generationBeforeEdgeDescription = solverGeneration();

    applyEdgeFieldEdit(EDGES[0].id!, "description", edgeDescriptionInput);

    expect(solverGeneration()).toBe(generationBeforeEdgeDescription);
  });

  it("does refresh calculation state for elasticity edits", () => {
    const elasticityInput = document.createElement("input");
    elasticityInput.value = "0.75";
    state.userOverrides = { a: 2 };
    recomputeValues();
    const middleValueBeforeElasticity = state.computedValues.b;

    applyEdgeFieldEdit(EDGES[0].id!, "elasticity", elasticityInput);

    expect(state.computedValues.b).not.toBe(middleValueBeforeElasticity);
  });
});

describe("New map lifecycle", () => {
  it("clears every map-scoped collection and transient surface", () => {
    loadDataFromCsv(LINEAR_CSV);
    setParams([{ id: "legacy_constant", value: 42, description: "old map" }]);
    state.selectedNodeId = "a";
    state.selectedNodeIds = new Set(["a"]);
    state.selectedEdgeId = EDGES[0].id!;
    state.userOverrides = { a: 1.5 };
    state.reviews.a = {
      boxId: "a",
      verdict: "flagged",
      reviewer: "Ada Lovelace",
      date: "2026-09-01",
      note: "old map",
      fingerprint: "old",
      flaggedSources: [],
      flaggedOn: "2026-09-01",
      flaggedBy: "Ada Lovelace",
      addressedOn: "",
      addressedBy: "",
      addressedNote: "",
      label: "Input A",
      removedOn: "",
    };
    state.searchQuery = "Input";
    state.searchMatches = [{
      node: NODES[0], score: 1, bestField: "label", bestPositions: [0], fieldMatches: {},
    }];
    state.searchFocusIndex = 1;
    state.atlas = { startId: "a" };
    state.reviewPass = true;
    saveUiStateToStorage();

    bootEmptyStateGrid();

    expect(PARAMS).toEqual([]);
    expect(state.selectedNodeId).toBeNull();
    expect(state.selectedNodeIds.size).toBe(0);
    expect(state.selectedEdgeId).toBeNull();
    expect(state.userOverrides).toEqual({});
    expect(state.reviews).toEqual({});
    expect(state.searchQuery).toBe("");
    expect(state.searchMatches).toEqual([]);
    expect(state.searchFocusIndex).toBe(0);
    expect(state.atlas).toBeNull();
    expect(state.reviewPass).toBe(false);
    expect(loadUiStateFromStorage()).toMatchObject({
      userOverrides: {},
      selectedNodeId: null,
      simulationMode: false,
    });
  });
});
