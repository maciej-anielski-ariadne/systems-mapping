import { describe, it, expect, beforeEach } from "vitest";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import {
  resolveEdgeElasticity,
  recomputeValues,
  formatNodeValue,
  formatNodeDelta,
  getOutcomeBorderColor,
} from "../assets/js/07-simulation-engine";
import { state, NODES, nodeById, incomingEdges, topologicalOrder } from "../assets/js/03-state";
import { SAMPLE_CSV } from "../assets/js/01-sample-data";
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

// A CSV with no combine / formula / min / max columns must compute EXACTLY as
// it did before those rules existed. The reference below is the original
// single-pass engine, written out longhand: value = baseline × ∏ rᵢ^eᵢ, swept
// once in topological order.
function classicSinglePass(overrides: Record<string, number>): Record<string, number> {
  const values: Record<string, number> = {};
  for (const node of NODES) {
    if (node.baseline === undefined) continue;
    values[node.id] = node.controllable ? node.baseline * (overrides[node.id] ?? 1) : node.baseline;
  }
  for (const nodeId of topologicalOrder) {
    const node = nodeById[nodeId];
    if (!node || node.baseline === undefined || node.controllable) continue;
    let logSum = 0;
    for (const edge of incomingEdges[nodeId]) {
      const source = nodeById[edge.from];
      if (!source || !source.baseline || values[edge.from] === undefined) continue;
      logSum +=
        resolveEdgeElasticity(edge) * Math.log(Math.max(values[edge.from] / source.baseline, 1e-6));
    }
    values[nodeId] = node.baseline * Math.exp(logSum);
  }
  return values;
}

describe("legacy regression — the bundled sample map", () => {
  beforeEach(() => loadDataFromCsv(SAMPLE_CSV));

  it("computes identical values to the original single-pass engine", () => {
    const runs: Record<string, number>[] = [
      {},
      { team_size: 1.5 },
      { marketing_spend: 0.4, support_staff: 2 },
    ];
    for (const overrides of runs) {
      state.userOverrides = { ...overrides };
      recomputeValues();
      const expected = classicSinglePass(overrides);
      expect(Object.keys(state.computedValues).sort()).toEqual(Object.keys(expected).sort());
      for (const id of Object.keys(expected)) {
        expect(state.computedValues[id]).toBeCloseTo(expected[id], 9);
      }
    }
  });

  it("explains every box with the classic rules only", () => {
    const rules = new Set(Object.values(state.explanations).map((e) => e.rule));
    for (const rule of rules) expect(["pinned", "baseline", "multiplicative"]).toContain(rule);
    expect(Object.values(state.explanations).every((e) => e.clamp === undefined)).toBe(true);
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
