// The shipped advanced_sample.csv is the worked example for every per-box
// calculation rule, so it has to keep WORKING, not just parsing: no load
// warnings, every box resting at its starting value, and each rule doing the
// thing its comment block promises. These tests read the file from disk (not the
// embedded copy) so the sample a user drags onto the app is the one under test.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import { recomputeValues } from "../assets/js/07-simulation-engine";
import { NODES, PARAMS, nodeById, paramById, state } from "../assets/js/03-state";

const here = dirname(fileURLToPath(import.meta.url));
const advancedCsv = readFileSync(resolve(here, "../assets/data/advanced_sample.csv"), "utf-8");

// Move one or more sliders (multipliers on the box's starting value) and re-solve.
function simulate(overrides: Record<string, number>): void {
  state.userOverrides = overrides;
  recomputeValues();
}

describe("advanced_sample.csv — loads clean", () => {
  beforeEach(() => {
    expect(loadDataFromCsv(advancedCsv)).toBe(true);
  });

  it("reports no warnings at all", () => {
    expect(state.loadErrors).toEqual([]);
  });

  it("brings in the boxes, the hidden constants and the feedback loop", () => {
    expect(NODES).toHaveLength(16);
    expect(PARAMS.map((p) => p.id)).toEqual([
      "orders_per_visit",
      "share_standard",
      "share_express",
      "repeat_sensitivity",
      "service_score_norm",
    ]);
    expect(paramById.share_standard.value + paramById.share_express.value).toBeCloseTo(1, 12);
    expect(state.solverStatus.feedbackLoopCount).toBe(1);
  });

  it("settles, and every box rests exactly at its starting value", () => {
    expect(state.solverStatus.converged).toBe(true);
    for (const node of NODES) {
      if (node.baseline === undefined) continue;
      expect(state.computedValues[node.id]).toBeCloseTo(node.baseline, 6);
    }
  });
});

describe("advanced_sample.csv — the rules do what the file says", () => {
  beforeEach(() => {
    expect(loadDataFromCsv(advancedCsv)).toBe(true);
  });

  it("caps the capacity box at the smaller of its two inputs", () => {
    // At rest demand (2000) is the binding side of min(demand, capacity).
    expect(state.computedValues.parcels_delivered).toBeCloseTo(
      Math.min(nodeById.orders_placed.baseline!, nodeById.fleet_capacity.baseline!),
      6,
    );

    // Push demand past capacity and the capacity side binds instead.
    simulate({ site_visits: 2 });
    expect(state.computedValues.orders_placed).toBeGreaterThan(3900);
    expect(state.computedValues.parcels_delivered).toBeCloseTo(2500, 6);
    // …and the clamped ratio tops out at 1 rather than sailing past it.
    expect(state.computedValues.fleet_utilisation).toBeCloseTo(1, 6);
  });

  it("moves a downstream box in the expected direction when a slider moves", () => {
    simulate({ site_visits: 1.2 });
    expect(state.computedValues.orders_placed).toBeGreaterThan(2000);
    expect(state.computedValues.parcels_delivered).toBeGreaterThan(2000);
    expect(state.computedValues.on_time_parcels).toBeGreaterThan(1710);
    expect(state.computedValues.service_score).toBeGreaterThan(80);
    // The share split follows the flow and still sums back to it.
    expect(
      state.computedValues.standard_parcels + state.computedValues.express_parcels,
    ).toBeCloseTo(state.computedValues.parcels_delivered, 6);
  });

  it("gates fleet capacity on the scarcer of vans and drivers (combine = min)", () => {
    simulate({ van_fleet: 0.5, drivers_on_shift: 1.5 });
    expect(state.computedValues.fleet_capacity).toBeCloseTo(1250, 6);
    // Capacity is now the binding side of min(demand, capacity).
    expect(state.computedValues.parcels_delivered).toBeCloseTo(1250, 6);
  });

  it("holds depot readiness inside its 0-1 bounds however hard the slider pushes", () => {
    simulate({ depot_staff: 3 });
    expect(state.computedValues.depot_readiness).toBeCloseTo(1, 6);
    expect(state.explanations.depot_readiness.clamp).toBeDefined();
    expect(state.explanations.depot_readiness.clamp!.max).toBe(1);
  });

  it("adds the two service effects instead of compounding them (combine = additive)", () => {
    simulate({ support_agents: 1.5 });
    const explanation = state.explanations.service_score;
    expect(explanation.rule).toBe("additive");

    // Each input's share is elasticity × (ratio − 1) — half again as many agents
    // at strength 0.2 is +10% — and the shares ADD onto the starting value
    // rather than compounding into it.
    const support = explanation.inputs.find((input) => input.id === "support_agents")!;
    expect(support.contribution).toBeCloseTo(0.2 * 0.5, 6);
    const totalShare = explanation.inputs.reduce((sum, input) => sum + input.contribution!, 0);
    expect(state.computedValues.service_score).toBeCloseTo(80 * (1 + totalShare), 6);
  });

  it("closes the service → demand loop through delay() and still converges", () => {
    simulate({ support_agents: 1.5 });
    expect(state.solverStatus.converged).toBe(true);
    // Better service ⇒ repeat demand above 1 ⇒ more orders than the slider alone
    // would explain (site_visits never moved).
    expect(state.computedValues.repeat_uplift).toBeGreaterThan(1);
    expect(state.computedValues.orders_placed).toBeGreaterThan(2000);
    // The delayed read is the fixed point, so it is visible in the trace.
    const inputs = state.explanations.repeat_uplift.inputs;
    expect(inputs.some((input) => input.id === "service_score" && input.delayed)).toBe(true);
  });
});
