import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  saveCsvToStorage,
  scheduleCsvSave,
  loadCsvFromStorage,
  clearCsvFromStorage,
  saveUiStateToStorage,
  loadUiStateFromStorage,
  saveBuilderToStorage,
  loadBuilderFromStorage,
  clearBuilderFromStorage,
} from "../assets/js/04a-storage";
import { state } from "../assets/js/03-state";
import { bootEmptyStateGrid } from "../assets/js/16e-canvas-edit";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import { LINEAR_CSV } from "./fixtures/graphs";

describe("CSV slot", () => {
  afterEach(() => vi.useRealTimers());

  it("round-trips and clears", () => {
    expect(loadCsvFromStorage()).toBeNull();
    saveCsvToStorage("# SECTION: streams\nid\nops");
    expect(loadCsvFromStorage()).toBe("# SECTION: streams\nid\nops");
    clearCsvFromStorage();
    expect(loadCsvFromStorage()).toBeNull();
  });

  it("cancels a queued save when the current map is cleared", () => {
    vi.useFakeTimers();
    scheduleCsvSave("old map");

    clearCsvFromStorage();
    vi.advanceTimersByTime(1000);

    expect(loadCsvFromStorage()).toBeNull();
  });

  it("does not let empty-map boot overwrite an immediate import", () => {
    vi.useFakeTimers();
    clearCsvFromStorage();
    bootEmptyStateGrid();

    expect(loadDataFromCsv(LINEAR_CSV)).toBe(true);
    vi.advanceTimersByTime(1000);

    expect(loadCsvFromStorage()).toBe(LINEAR_CSV);
  });
});

describe("UI-state slot", () => {
  beforeEach(() => {
    state.hiddenStreams = new Set(["ops"]);
    state.hiddenCategories = new Set();
    state.hiddenStages = new Set();
    state.hiddenEffects = new Set(["enables"]);
    state.hiddenStyles = new Set();
    state.hiddenTrace = new Set();
    state.simulationMode = true;
    state.userOverrides = { a: 1.5 };
    state.selectedNodeId = "a";
    state.zoomLevel = 1.25;
    state.highlightDepth = 2;
  });

  it("captures the persisted-relevant fields as JSON arrays/values", () => {
    saveUiStateToStorage();
    const ui = loadUiStateFromStorage();
    expect(ui.hiddenStreams).toEqual(["ops"]);
    expect(ui.hiddenEffects).toEqual(["enables"]);
    expect(ui.simulationMode).toBe(true);
    expect(ui.userOverrides).toEqual({ a: 1.5 });
    expect(ui.selectedNodeId).toBe("a");
    expect(ui.zoomLevel).toBe(1.25);
    expect(ui.highlightDepth).toBe(2);
  });
});

describe("Builder slot", () => {
  it("persists only while open and clears on demand", () => {
    state.builder.open = false;
    saveBuilderToStorage();
    expect(loadBuilderFromStorage()).toBeNull();

    state.builder.open = true;
    state.builder.step = 3;
    state.builder.streams = [{ id: "ops", label: "Ops", short: "OPS", color: "#60a5fa" }];
    saveBuilderToStorage();

    const restored = loadBuilderFromStorage();
    expect(restored.step).toBe(3);
    expect(restored.streams).toEqual([{ id: "ops", label: "Ops", short: "OPS", color: "#60a5fa" }]);

    clearBuilderFromStorage();
    expect(loadBuilderFromStorage()).toBeNull();
  });
});
