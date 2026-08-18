// Per-box calculation rules: combine modes, formulas, bounds, the delay()
// unit-delay, the traceability records, and every load-time warning the rules
// can raise. The classic Cobb-Douglas behaviour lives in simulation-engine.test.ts.
import { describe, it, expect, beforeEach } from "vitest";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import { recomputeValues } from "../assets/js/07-simulation-engine";
import { state } from "../assets/js/03-state";
import {
  LINEAR_CSV,
  COMBINE_CSV,
  FORMULA_CSV,
  BOUNDS_CSV,
  DELAY_LOOP_CSV,
  DELAY_LOOP_REORDERED_CSV,
  DELAY_ACYCLIC_CSV,
  FORMULA_INVALID_CSV,
} from "./fixtures/graphs";

// Run the solver with a set of slider positions (multipliers on baseline).
function simulate(overrides: Record<string, number>): void {
  state.userOverrides = overrides;
  recomputeValues();
}

describe("combine modes", () => {
  beforeEach(() => {
    expect(loadDataFromCsv(COMBINE_CSV)).toBe(true);
    expect(state.loadErrors).toEqual([]);
  });

  it("rests every rule at baseline when nothing is moved", () => {
    for (const id of ["mult", "add", "gate", "lone"]) {
      expect(state.computedValues[id]).toBeCloseTo(100, 6);
    }
  });

  it("additive adds where multiplicative compounds", () => {
    simulate({ a: 1.2, b: 1.2 });
    expect(state.computedValues.mult).toBeCloseTo(144, 6); // 1.2 × 1.2
    expect(state.computedValues.add).toBeCloseTo(140, 6); // 1 + 0.2 + 0.2
  });

  it("min gates on the weakest input while the others carry it", () => {
    simulate({ a: 1.5, b: 1.0 });
    expect(state.computedValues.mult).toBeCloseTo(150, 6);
    expect(state.computedValues.add).toBeCloseTo(150, 6);
    expect(state.computedValues.gate).toBeCloseTo(100, 6); // held down by b
  });

  it("min still moves when EVERY input moves", () => {
    simulate({ a: 1.5, b: 1.2 });
    expect(state.computedValues.gate).toBeCloseTo(120, 6); // min(1.5, 1.2)
  });

  it("min falls back to baseline when no link is usable", () => {
    simulate({ a: 1.5, b: 1.5 });
    expect(state.computedValues.lone).toBeCloseTo(100, 6);
  });
});

describe("formula boxes", () => {
  beforeEach(() => {
    expect(loadDataFromCsv(FORMULA_CSV)).toBe(true);
    expect(state.loadErrors).toEqual([]);
  });

  it("reproduces its own starting values when nothing is moved", () => {
    expect(state.computedValues.exam_coverage).toBeCloseTo(0.2, 9);
    expect(state.computedValues.seizures).toBeCloseTo(120, 6);
    expect(state.computedValues.provision).toBeCloseTo(80, 6);
    expect(state.computedValues.air_flow).toBeCloseTo(350, 6);
  });

  it("computes a ratio and gates the outcome on the joint product", () => {
    simulate({ examinations: 2 }); // 400 exams over 1000 traffic
    expect(state.computedValues.exam_coverage).toBeCloseTo(0.4, 9);
    expect(state.computedValues.seizures).toBeCloseTo(240, 6); // 1000 × 0.4 × 0.6
  });

  it("ignores the incoming links entirely — only the formula counts", () => {
    // traffic → seizures has elasticity 1.0, but traffic also divides the
    // coverage ratio, so the formula's answer is flat, not doubled.
    simulate({ traffic: 2, examinations: 2 });
    expect(state.computedValues.exam_coverage).toBeCloseTo(0.2, 9);
    expect(state.computedValues.seizures).toBeCloseTo(240, 6); // 2000 × 0.2 × 0.6
  });

  it("holds a ratio inside clamp()'s range", () => {
    simulate({ examinations: 10 }); // 2000 exams over 1000 traffic = 2.0
    expect(state.computedValues.exam_coverage).toBeCloseTo(1, 9);
    expect(state.computedValues.seizures).toBeCloseTo(600, 6);
  });

  it("caps provision at the smaller of demand and capacity", () => {
    simulate({ capacity: 1.5 });
    expect(state.computedValues.provision).toBeCloseTo(100, 6); // min(100, 120)
    simulate({ demand: 0.5 });
    expect(state.computedValues.provision).toBeCloseTo(50, 6); // min(50, 80)
  });

  it("allocates a flow by a hidden param share", () => {
    simulate({ traffic: 2 });
    expect(state.computedValues.air_flow).toBeCloseTo(700, 6); // 2000 × 0.35
  });

  it("flags a division by zero in the trace instead of blowing up", () => {
    simulate({ traffic: 0 });
    expect(state.computedValues.exam_coverage).toBe(0);
    expect(state.explanations.exam_coverage.dividedByZero).toBe(true);
    expect(state.computedValues.seizures).toBe(0);
    expect(state.explanations.seizures.dividedByZero).toBeUndefined();
  });
});

describe("hard bounds", () => {
  beforeEach(() => {
    expect(loadDataFromCsv(BOUNDS_CSV)).toBe(true);
    expect(state.loadErrors).toEqual([]);
  });

  it("clamps at the upper bound and records it in the trace", () => {
    simulate({ a: 2 });
    expect(state.computedValues.capped).toBeCloseTo(120, 6);
    expect(state.explanations.capped.clamp).toEqual({ from: 200, max: 120 });
    expect(state.explanations.both.clamp).toEqual({ from: 200, min: 90, max: 120 });
    // Untouched by its lower bound, so nothing is recorded.
    expect(state.computedValues.floored).toBeCloseTo(200, 6);
    expect(state.explanations.floored.clamp).toBeUndefined();
  });

  it("clamps at the lower bound and records it in the trace", () => {
    simulate({ a: 0.5 });
    expect(state.computedValues.floored).toBeCloseTo(90, 6);
    expect(state.explanations.floored.clamp).toEqual({ from: 50, min: 90 });
    expect(state.computedValues.capped).toBeCloseTo(50, 6);
    expect(state.explanations.capped.clamp).toBeUndefined();
  });

  it("records no clamp when no bound bites", () => {
    simulate({ a: 1.1 });
    expect(state.explanations.capped.clamp).toBeUndefined();
    expect(state.explanations.both.clamp).toBeUndefined();
  });

  it("never clamps a box the user is holding with a slider", () => {
    simulate({ a: 4 }); // `a` carries max 150 and is controllable
    expect(state.computedValues.a).toBeCloseTo(400, 6);
    expect(state.explanations.a).toEqual({ rule: "pinned", inputs: [], value: 400 });
  });
});

describe("delay() feedback", () => {
  it("settles a loop and reports it as converged", () => {
    expect(loadDataFromCsv(DELAY_LOOP_CSV)).toBe(true);
    expect(state.loadErrors).toEqual([]);
    // The fixed point at a = 100 is exactly the starting values.
    expect(state.computedValues.p).toBeCloseTo(100, 6);
    expect(state.computedValues.q).toBeCloseTo(100, 6);

    simulate({ a: 1.2 });
    expect(state.solverStatus.converged).toBe(true);
    expect(state.computedValues.p).toBeCloseTo(92 / 0.9, 6); // 102.2222…
    expect(state.computedValues.q).toBeCloseTo(60 + 0.5 * (92 / 0.9), 6); // 111.1111…
  });

  it("lands on the same answer whichever box is declared first", () => {
    expect(loadDataFromCsv(DELAY_LOOP_CSV)).toBe(true);
    simulate({ a: 1.2 });
    const inOrder = { p: state.computedValues.p, q: state.computedValues.q };

    expect(loadDataFromCsv(DELAY_LOOP_REORDERED_CSV)).toBe(true);
    simulate({ a: 1.2 });
    // Equal to well within the solver's convergence tolerance. The two
    // declaration orders take different routes to the same fixed point and each
    // stops as soon as a sweep moves nothing by more than SOLVER_EPSILON (1e-7
    // RELATIVE), so on a ~100-unit value they agree to ~1e-5 absolute — eight
    // significant figures, and four orders of magnitude finer than the ±0.1%
    // the map ever displays.
    expect(state.computedValues.p).toBeCloseTo(inOrder.p, 4);
    expect(state.computedValues.q).toBeCloseTo(inOrder.q, 4);
  });

  it("keeps sweeping on a loop-free map when a formula reads through delay()", () => {
    expect(loadDataFromCsv(DELAY_ACYCLIC_CSV)).toBe(true);
    expect(state.loadErrors).toEqual([]);
    expect(state.solverStatus.feedbackLoopCount).toBe(0);
    expect(state.computedValues.y).toBeCloseTo(100, 6);

    simulate({ x: 1.2 });
    expect(state.computedValues.y).toBeCloseTo(110, 6); // 50 + 0.5 × 120
    // A delayed read is one sweep behind by construction, so the acyclic
    // single-sweep shortcut must NOT be taken: the solver sweeps again to
    // confirm the fixed point instead of stopping after the first pass.
    expect(state.solverStatus.iterations).toBe(2);
    expect(state.solverStatus.converged).toBe(true);
  });

  it("still takes the single-sweep shortcut when no formula delays", () => {
    expect(loadDataFromCsv(LINEAR_CSV)).toBe(true);
    simulate({ a: 4 }); // b and c both move, yet one sweep is the exact answer
    expect(state.solverStatus.iterations).toBe(1);
  });
});

describe("traceability — one explanation per box", () => {
  it("records the pinned, multiplicative and baseline rules", () => {
    expect(loadDataFromCsv(COMBINE_CSV)).toBe(true);
    simulate({ a: 1.2, b: 1.2 });

    expect(state.explanations.a).toEqual({ rule: "pinned", inputs: [], value: 120 });
    expect(state.explanations.lone).toEqual({ rule: "baseline", inputs: [], value: 100 });

    const mult = state.explanations.mult;
    expect(mult.rule).toBe("multiplicative");
    expect(mult.value).toBeCloseTo(144, 6);
    expect(mult.inputs).toHaveLength(2);
    expect(mult.inputs[0].id).toBe("a");
    expect(mult.inputs[0].kind).toBe("node");
    expect(mult.inputs[0].value).toBeCloseTo(120, 6);
    expect(mult.inputs[0].ratio).toBeCloseTo(1.2, 9);
    expect(mult.inputs[0].elasticity).toBe(1);
    expect(mult.inputs[0].contribution).toBeCloseTo(1.2, 9); // rᵢ^eᵢ
  });

  it("records additive contributions as eᵢ·(rᵢ − 1)", () => {
    expect(loadDataFromCsv(COMBINE_CSV)).toBe(true);
    simulate({ a: 1.2, b: 1.2 });
    const add = state.explanations.add;
    expect(add.rule).toBe("additive");
    expect(add.inputs.map((input) => input.contribution)).toEqual([
      expect.closeTo(0.2, 9),
      expect.closeTo(0.2, 9),
    ]);
  });

  it("records min contributions as rᵢ^eᵢ, weakest included", () => {
    expect(loadDataFromCsv(COMBINE_CSV)).toBe(true);
    simulate({ a: 1.5, b: 1.0 });
    const gate = state.explanations.gate;
    expect(gate.rule).toBe("min");
    expect(gate.inputs.map((input) => input.contribution)).toEqual([
      expect.closeTo(1.5, 9),
      expect.closeTo(1.0, 9),
    ]);
    expect(gate.value).toBeCloseTo(100, 6);
  });

  it("records a formula's source, its boxes and its params", () => {
    expect(loadDataFromCsv(FORMULA_CSV)).toBe(true);
    simulate({ examinations: 2 });

    const seizures = state.explanations.seizures;
    expect(seizures.rule).toBe("formula");
    expect(seizures.formula).toBe("traffic * exam_coverage * detection_rate");
    expect(seizures.value).toBeCloseTo(240, 6);
    expect(seizures.inputs).toEqual([
      { id: "traffic", kind: "node", value: 1000 },
      { id: "exam_coverage", kind: "node", value: expect.closeTo(0.4, 9) },
      { id: "detection_rate", kind: "param", value: 0.6 },
    ]);
    // Ratio-space fields are meaningless for a formula and stay absent.
    expect(seizures.inputs[0].ratio).toBeUndefined();
    expect(seizures.inputs[0].elasticity).toBeUndefined();
  });

  it("marks an input read through delay()", () => {
    expect(loadDataFromCsv(DELAY_LOOP_CSV)).toBe(true);
    simulate({ a: 1.2 });
    const p = state.explanations.p;
    expect(p.rule).toBe("formula");
    expect(p.inputs).toEqual([
      { id: "q", kind: "node", delayed: true, value: expect.closeTo(60 + 0.5 * (92 / 0.9), 6) },
    ]);
    // A same-sweep read carries no flag at all.
    expect(state.explanations.q.inputs.every((input) => input.delayed === undefined)).toBe(true);
  });

  it("lists inputs the formula could not resolve", () => {
    expect(loadDataFromCsv(FORMULA_INVALID_CSV)).toBe(true);
    expect(state.explanations.unknown_ref.missingInputs).toEqual(["mystery"]);
    expect(state.explanations.reads_nb.missingInputs).toEqual(["nb"]);
    expect(state.explanations.seizures).toBeUndefined(); // not this map
  });

  it("explains every box that has a value, and only those", () => {
    expect(loadDataFromCsv(FORMULA_CSV)).toBe(true);
    expect(Object.keys(state.explanations).sort()).toEqual(
      Object.keys(state.computedValues).sort(),
    );
  });

  it("replaces the whole set on each run rather than accumulating", () => {
    expect(loadDataFromCsv(FORMULA_CSV)).toBe(true);
    const first = state.explanations;
    simulate({ traffic: 2 });
    expect(state.explanations).not.toBe(first);
    expect(Object.keys(state.explanations).sort()).toEqual(Object.keys(first).sort());
  });
});

describe("formula validation warnings", () => {
  beforeEach(() => {
    expect(loadDataFromCsv(FORMULA_INVALID_CSV)).toBe(true); // warnings, never fatal
  });

  const joined = (): string => state.loadErrors.join(" | ");

  it("names a formula whose text can't be read, and falls back to the links", () => {
    expect(joined()).toMatch(/Box `oops` has a formula that can't be read: Unexpected '\)'/);
    // Fallen back to the classic rule over a → oops.
    expect(state.explanations.oops.rule).toBe("multiplicative");
  });

  it("names an identifier that is neither a box nor a param", () => {
    expect(joined()).toMatch(/Box `unknown_ref` has a formula that mentions `mystery`/);
  });

  it("insists the map draws an arrow for every box a formula reads", () => {
    expect(joined()).toMatch(/Box `no_edge` has a formula that uses `a`, but no arrow joins them/);
    expect(joined()).toMatch(/add a link from `a` to `no_edge` or remove it from the formula/);
  });

  it("points out an incoming arrow the formula never reads", () => {
    expect(joined()).toMatch(/Box `extra_edge` has an arrow from `b` that its formula never uses/);
    expect(joined()).not.toMatch(/Box `extra_edge` has an arrow from `a`/);
  });

  it("warns about a referenced box with no starting value", () => {
    expect(joined()).toMatch(
      /Box `reads_nb` has a formula that uses `nb`, which has no starting value/,
    );
  });

  it("says the formula beats a combine rule, and a slider beats the formula", () => {
    expect(joined()).toMatch(
      /Box `both_rules` has both a combine rule \(`additive`\) and a formula/,
    );
    expect(state.explanations.both_rules.rule).toBe("formula");
    expect(joined()).toMatch(/Box `pinned_formula` is a slider input and also has a formula/);
    expect(state.explanations.pinned_formula.rule).toBe("pinned");
  });

  it("names a same-sweep loop through a formula and asks for a delay()", () => {
    expect(joined()).toMatch(/form a calculation loop through a formula with no delay\(\)/);
    expect(joined()).toMatch(/`c1`/);
    expect(joined()).toMatch(/`c2`/);
    // Reported once, not once per box on the loop.
    expect(state.loadErrors.filter((line) => line.includes("calculation loop"))).toHaveLength(1);
  });

  it("stays silent about loops that are properly delayed or purely link-based", () => {
    expect(loadDataFromCsv(DELAY_LOOP_CSV)).toBe(true);
    expect(state.loadErrors).toEqual([]);
    expect(loadDataFromCsv(LINEAR_CSV)).toBe(true);
    expect(state.loadErrors).toEqual([]);
  });
});
