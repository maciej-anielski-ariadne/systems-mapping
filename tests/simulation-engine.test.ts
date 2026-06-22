import { describe, it, expect, beforeEach } from "vitest";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import {
  resolveEdgeElasticity,
  recomputeValues,
  formatNodeValue,
  formatNodeDelta,
  getOutcomeBorderColor,
} from "../assets/js/07-simulation-engine";
import { state } from "../assets/js/03-state";
import { LINEAR_CSV, RUNAWAY_CSV } from "./fixtures/graphs";
import type { Edge } from "../assets/js/types";

describe("resolveEdgeElasticity", () => {
  beforeEach(() => loadDataFromCsv(LINEAR_CSV));

  it("uses the per-edge value when present", () => {
    expect(resolveEdgeElasticity({ effect: "increases", elasticity: 0.5 } as Edge)).toBe(0.5);
  });
  it("falls back to the effect default", () => {
    expect(resolveEdgeElasticity({ effect: "increases" } as Edge)).toBe(0.25);
    expect(resolveEdgeElasticity({ effect: "decreases" } as Edge)).toBe(-0.25);
  });
});

describe("Cobb-Douglas propagation on the linear chain", () => {
  beforeEach(() => loadDataFromCsv(LINEAR_CSV));

  it("rests at baseline with no override", () => {
    expect(state.computedValues.a).toBeCloseTo(100, 6);
    expect(state.computedValues.b).toBeCloseTo(50, 6);
    expect(state.computedValues.c).toBeCloseTo(20, 6);
  });

  it("propagates a ×4 override through the elasticities (sqrt curve)", () => {
    state.userOverrides = { a: 4 };
    recomputeValues();
    expect(state.computedValues.a).toBeCloseTo(400, 6); // 100 × 4
    expect(state.computedValues.b).toBeCloseTo(100, 6); // 50 × 4^0.5
    expect(state.computedValues.c).toBeCloseTo(40, 6); //  20 × 4^0.5
  });

  it("formats values, deltas and outcome colour", () => {
    state.userOverrides = { a: 4 };
    recomputeValues();
    expect(formatNodeValue("a")).toBe("400 units");
    expect(formatNodeDelta("c")).toEqual({ text: "+100.0%", pct: 100 });
    expect(getOutcomeBorderColor("c")).toBe("var(--status-good)"); // higher_better + positive
  });
});

describe("runaway feedback loop", () => {
  it("fails to converge and clamps to finite values", () => {
    loadDataFromCsv(RUNAWAY_CSV);
    state.userOverrides = { a: 2 };
    recomputeValues();
    expect(state.solverStatus.converged).toBe(false);
    for (const id of Object.keys(state.computedValues)) {
      expect(Number.isFinite(state.computedValues[id])).toBe(true);
    }
  });
});
