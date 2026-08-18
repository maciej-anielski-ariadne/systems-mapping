import { describe, it, expect, beforeEach } from "vitest";
import { loadDataFromCsv, rebuildIndexes } from "../assets/js/06-data-loader";
import {
  resolveEdgeElasticity,
  recomputeValues,
  formatNodeValue,
  formatNodeDelta,
  getOutcomeBorderColor,
  getSolverDiagnostics,
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

// While a slider is dragged the engine keeps the previous solve's numbers and
// re-evaluates only what that slider can reach. On a loop-free map that is not
// an approximation — the untouched boxes would have been recomputed from
// identical inputs — so the incremental answer must equal a cold, from-scratch
// solve exactly, and it must stay equal over a whole drag.
describe("incremental solving matches a cold solve", () => {
  function solveCold(overrides: Record<string, number>): Record<string, number> {
    loadDataFromCsv(SAMPLE_CSV);
    state.userOverrides = { ...overrides };
    // Any rebuild of the map's indexes invalidates the incremental bookkeeping,
    // so this next solve is a full, from-scratch one.
    rebuildIndexes();
    recomputeValues();
    expect(getSolverDiagnostics().mode).toBe("cold");
    return { ...state.computedValues };
  }

  it("lands on identical values after a drag, box for box", () => {
    // A drag: one slider moving through a sequence of positions, each solve
    // building on the last.
    loadDataFromCsv(SAMPLE_CSV);
    for (const value of [1.1, 1.2, 1.3, 1.25]) {
      state.userOverrides = { team_size: value };
      recomputeValues();
      expect(getSolverDiagnostics().mode).toBe("incremental");
    }
    const dragged = { ...state.computedValues };

    const cold = solveCold({ team_size: 1.25 });
    expect(Object.keys(dragged).sort()).toEqual(Object.keys(cold).sort());
    for (const id of Object.keys(cold)) {
      expect(dragged[id]).toBeCloseTo(cold[id], 12);
    }
  });

  it("only re-evaluates what the moved slider can reach", () => {
    loadDataFromCsv(SAMPLE_CSV);
    const coldSweep = getSolverDiagnostics().sweptNodes;
    state.userOverrides = { team_size: 1.4 };
    recomputeValues();
    const incrementalSweep = getSolverDiagnostics().sweptNodes;
    expect(incrementalSweep).toBeGreaterThan(0);
    expect(incrementalSweep).toBeLessThan(coldSweep);
  });

  it("falls back to a cold solve when more than one slider moved", () => {
    loadDataFromCsv(SAMPLE_CSV);
    state.userOverrides = { team_size: 1.5, marketing_spend: 0.5 };
    recomputeValues();
    expect(getSolverDiagnostics().mode).toBe("cold");

    const incremental = { ...state.computedValues };
    const cold = solveCold({ team_size: 1.5, marketing_spend: 0.5 });
    for (const id of Object.keys(cold)) {
      expect(incremental[id]).toBeCloseTo(cold[id], 12);
    }
  });

  it("re-seeds a slider that was reset back to its baseline", () => {
    loadDataFromCsv(SAMPLE_CSV);
    const atRest = { ...state.computedValues };

    state.userOverrides = { team_size: 1.6 };
    recomputeValues();
    state.userOverrides = {}; // the override removed, not just changed
    recomputeValues();

    for (const id of Object.keys(atRest)) {
      expect(state.computedValues[id]).toBeCloseTo(atRest[id], 12);
    }
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
