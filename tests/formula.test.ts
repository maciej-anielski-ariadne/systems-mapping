import { describe, it, expect } from "vitest";
import {
  parseFormula,
  evaluateFormula,
  FormulaError,
  type FormulaEvalContext,
} from "../assets/js/07a-formula";

// A context backed by two plain objects: "now" is this sweep's values, "before"
// is the previous sweep's (what delay() reads). Anything missing from either
// comes back undefined, which is how the engine reports an unknown id.
function makeContext(
  now: Record<string, number>,
  before: Record<string, number> = {},
): FormulaEvalContext {
  return {
    lookup: (id) => now[id],
    lookupDelayed: (id) => before[id],
  };
}

// Parse + evaluate in one step — most tests only care about the number.
function run(
  source: string,
  now: Record<string, number> = {},
  before: Record<string, number> = {},
) {
  return evaluateFormula(parseFormula(source), makeContext(now, before));
}

describe("parseFormula — numbers and identifiers", () => {
  it("parses a bare integer", () => {
    expect(parseFormula("12").ast).toEqual({ kind: "number", value: 12 });
  });

  it("parses decimals with and without a leading digit", () => {
    expect(parseFormula("3.5").ast).toEqual({ kind: "number", value: 3.5 });
    expect(parseFormula(".5").ast).toEqual({ kind: "number", value: 0.5 });
  });

  it("parses an identifier and keeps the source text", () => {
    const parsed = parseFormula(" share_air ");
    expect(parsed.ast).toEqual({ kind: "identifier", id: "share_air" });
    expect(parsed.source).toBe(" share_air ");
  });

  it("ignores whitespace entirely", () => {
    expect(run("  1   +\t2  ").value).toBe(3);
  });

  it("rejects empty or blank source", () => {
    expect(() => parseFormula("")).toThrow(/Formula is empty/);
    expect(() => parseFormula("   \n ")).toThrow(/Formula is empty/);
  });
});

describe("parseFormula — precedence and associativity", () => {
  it("multiplies before adding", () => {
    expect(run("1 + 2 * 3").value).toBe(7);
    expect(run("2 * 3 + 1").value).toBe(7);
  });

  it("divides before subtracting", () => {
    expect(run("10 - 6 / 2").value).toBe(7);
  });

  it("is left-associative for - and /", () => {
    expect(run("10 - 3 - 2").value).toBe(5); // (10-3)-2, not 10-(3-2)
    expect(run("100 / 5 / 2").value).toBe(10); // (100/5)/2, not 100/(5/2)
  });

  it("builds a left-leaning tree for equal precedence", () => {
    expect(parseFormula("1 - 2 - 3").ast).toEqual({
      kind: "binary",
      op: "-",
      left: {
        kind: "binary",
        op: "-",
        left: { kind: "number", value: 1 },
        right: { kind: "number", value: 2 },
      },
      right: { kind: "number", value: 3 },
    });
  });

  it("lets parentheses override precedence", () => {
    expect(run("(1 + 2) * 3").value).toBe(9);
    expect(run("100 / (5 / 2)").value).toBe(40);
  });

  it("handles nested parentheses", () => {
    expect(run("((2 + 3) * (4 - 1)) / 5").value).toBe(3);
  });
});

describe("parseFormula — unary minus", () => {
  it("negates a value", () => {
    expect(run("-4").value).toBe(-4);
    expect(run("-x", { x: 7 }).value).toBe(-7);
  });

  it("produces a negate node rather than a negative literal", () => {
    expect(parseFormula("-4").ast).toEqual({
      kind: "negate",
      operand: { kind: "number", value: 4 },
    });
  });

  it("binds tighter than * so -a * b is (-a) * b", () => {
    expect(run("-2 * 3").value).toBe(-6);
  });

  it("is allowed on the right of an operator (2 * -3)", () => {
    expect(run("2 * -3").value).toBe(-6);
    expect(run("2 - -3").value).toBe(5);
    expect(run("2 / -4").value).toBe(-0.5);
  });

  it("can be repeated", () => {
    expect(run("--5").value).toBe(5);
  });

  it("negates a whole parenthesised expression", () => {
    expect(run("-(1 + 2) * 2").value).toBe(-6);
  });

  it("rejects a leading + (there is no unary plus)", () => {
    expect(() => parseFormula("+3")).toThrow(/Unexpected '\+' at position 0/);
  });
});

describe("parseFormula — syntax errors name the token and position", () => {
  it("reports an unexpected closing bracket with its position", () => {
    let caught: FormulaError | undefined;
    try {
      parseFormula("min(1, 2) * )");
    } catch (error) {
      caught = error as FormulaError;
    }
    expect(caught).toBeInstanceOf(FormulaError);
    expect(caught!.message).toBe("Unexpected ')' at position 12");
    expect(caught!.position).toBe(12);
  });

  it("reports a missing closing bracket", () => {
    expect(() => parseFormula("(1 + 2")).toThrow(/Expected '\)' at position 6/);
  });

  it("reports trailing junk after a complete expression", () => {
    expect(() => parseFormula("1 2")).toThrow(/Unexpected '2' at position 2/);
    expect(() => parseFormula("(1))")).toThrow(/Unexpected '\)' at position 3/);
  });

  it("reports a dangling operator as an unexpected end of formula", () => {
    const error = (() => {
      try {
        parseFormula("1 +");
        return undefined;
      } catch (caught) {
        return caught as FormulaError;
      }
    })();
    expect(error!.message).toBe("Unexpected end of formula at position 3");
    expect(error!.position).toBe(3);
  });

  it("reports characters the language has no use for", () => {
    expect(() => parseFormula("a % b")).toThrow(/Unexpected character '%' at position 2/);
    expect(() => parseFormula("a ^ b")).toThrow(/Unexpected character '\^' at position 2/);
  });

  it("throws a FormulaError (not a plain Error) with a 0-based position", () => {
    try {
      parseFormula("a + ?");
      expect.unreachable?.();
    } catch (error) {
      expect(error).toBeInstanceOf(FormulaError);
      expect((error as FormulaError).position).toBe(4);
      expect((error as FormulaError).name).toBe("FormulaError");
    }
  });
});

describe("parseFormula — min / max", () => {
  it("parses a two-argument call into a call node", () => {
    expect(parseFormula("min(a, 2)").ast).toEqual({
      kind: "call",
      fn: "min",
      args: [
        { kind: "identifier", id: "a" },
        { kind: "number", value: 2 },
      ],
    });
  });

  it("accepts more than two arguments", () => {
    expect(run("min(5, 2, 9)").value).toBe(2);
    expect(run("max(5, 2, 9, 11)").value).toBe(11);
  });

  it("accepts full expressions as arguments", () => {
    expect(run("max(1 + 1, 3 * 0)").value).toBe(2);
  });

  it("rejects fewer than two arguments", () => {
    expect(() => parseFormula("min(1)")).toThrow("min() needs at least 2 arguments");
    expect(() => parseFormula("max(1)")).toThrow("max() needs at least 2 arguments");
    expect(() => parseFormula("min()")).toThrow("min() needs at least 2 arguments");
  });

  it("rejects a missing comma between arguments", () => {
    expect(() => parseFormula("min(1 2)")).toThrow(/Expected ',' or '\)' in min\(\)/);
  });
});

describe("parseFormula — clamp", () => {
  it("needs exactly three arguments", () => {
    expect(() => parseFormula("clamp(1, 2)")).toThrow("clamp() needs exactly 3 arguments");
    expect(() => parseFormula("clamp(1, 2, 3, 4)")).toThrow("clamp() needs exactly 3 arguments");
    expect(() => parseFormula("clamp()")).toThrow("clamp() needs exactly 3 arguments");
    expect(parseFormula("clamp(1, 2, 3)").ast.kind).toBe("call");
  });

  it("holds a value inside the range", () => {
    expect(run("clamp(0.5, 0, 1)").value).toBe(0.5);
    expect(run("clamp(-2, 0, 1)").value).toBe(0);
    expect(run("clamp(9, 0, 1)").value).toBe(1);
  });

  it("means min(max(x, lo), hi)", () => {
    expect(run("clamp(x, 10, 20)", { x: 4 }).value).toBe(
      run("min(max(x, 10), 20)", { x: 4 }).value,
    );
    expect(run("clamp(x, 10, 20)", { x: 99 }).value).toBe(
      run("min(max(x, 10), 20)", { x: 99 }).value,
    );
  });
});

describe("parseFormula — delay", () => {
  it("parses a bare identifier argument into a delay node", () => {
    expect(parseFormula("delay(seizure_rate)").ast).toEqual({
      kind: "delay",
      id: "seizure_rate",
    });
  });

  it("rejects an expression as its argument", () => {
    expect(() => parseFormula("delay(a + b)")).toThrow(/delay\(\) needs a plain node or param id/);
    expect(() => parseFormula("delay(2)")).toThrow(/delay\(\) needs a plain node or param id/);
    expect(() => parseFormula("delay(min(a, b))")).toThrow(
      /delay\(\) needs a plain node or param id/,
    );
    expect(() => parseFormula("delay((a))")).toThrow(/delay\(\) needs a plain node or param id/);
  });

  it("rejects the wrong number of arguments", () => {
    expect(() => parseFormula("delay(a, b)")).toThrow("delay() needs exactly 1 argument");
    expect(() => parseFormula("delay()")).toThrow("delay() needs exactly 1 argument");
  });
});

describe("parseFormula — reserved function names", () => {
  it.each(["min", "max", "clamp", "delay"])("rejects %s used as a bare identifier", (name) => {
    expect(() => parseFormula(name + " * 2")).toThrow(
      new RegExp("Function '" + name + "' must be called with arguments"),
    );
  });

  it("names the position of the misused reserved word", () => {
    try {
      parseFormula("2 * clamp");
      expect.unreachable?.();
    } catch (error) {
      expect((error as FormulaError).position).toBe(4);
    }
  });

  it("rejects an unknown function name", () => {
    expect(() => parseFormula("sqrt(4)")).toThrow(/Unknown function 'sqrt' at position 0/);
  });

  it("is case-sensitive — MIN is not min", () => {
    expect(() => parseFormula("MIN(1, 2)")).toThrow(/Unknown function 'MIN'/);
    // ...but MIN as a plain name is a perfectly ordinary identifier.
    expect(parseFormula("MIN").references).toEqual(["MIN"]);
  });
});

describe("parseFormula — reference extraction", () => {
  it("lists direct references in first-appearance order, deduplicated", () => {
    const parsed = parseFormula("b * a + b / c - a");
    expect(parsed.references).toEqual(["b", "a", "c"]);
    expect(parsed.delayReferences).toEqual([]);
  });

  it("keeps delay() references in a separate list", () => {
    const parsed = parseFormula("base * (1 + k * delay(seizures)) - delay(price)");
    expect(parsed.references).toEqual(["base", "k"]);
    expect(parsed.delayReferences).toEqual(["seizures", "price"]);
  });

  it("deduplicates delay references too", () => {
    expect(parseFormula("delay(x) + delay(x) * 2").delayReferences).toEqual(["x"]);
  });

  it("lists an id read both ways in both lists", () => {
    const parsed = parseFormula("x - delay(x)");
    expect(parsed.references).toEqual(["x"]);
    expect(parsed.delayReferences).toEqual(["x"]);
  });

  it("does not treat function names as references", () => {
    const parsed = parseFormula("clamp(min(a, b), 0, max(c, 1))");
    expect(parsed.references).toEqual(["a", "b", "c"]);
  });
});

describe("evaluateFormula — inputs and missing values", () => {
  it("returns each input it read, once per (id, delayed) pair, in first-use order", () => {
    const result = run("b + a * b + delay(a)", { a: 2, b: 3 }, { a: 10 });
    expect(result.value).toBe(19); // 3 + 6 + 10
    expect(result.inputs).toEqual([
      { id: "b", value: 3, delayed: false },
      { id: "a", value: 2, delayed: false },
      { id: "a", value: 10, delayed: true },
    ]);
  });

  it("treats an unknown id as 0, lists it, and still records the input", () => {
    const result = run("a + b", { a: 5 });
    expect(result.value).toBe(5);
    expect(result.missingInputs).toEqual(["b"]);
    expect(result.inputs).toEqual([
      { id: "a", value: 5, delayed: false },
      { id: "b", value: 0, delayed: false },
    ]);
  });

  it("lists a missing id only once however often it is read", () => {
    expect(run("gone + gone * 2").missingInputs).toEqual(["gone"]);
  });

  it("reports a missing delayed value (no previous sweep yet)", () => {
    const result = run("delay(x)", { x: 4 });
    expect(result.value).toBe(0);
    expect(result.missingInputs).toEqual(["x"]);
    expect(result.inputs).toEqual([{ id: "x", value: 0, delayed: true }]);
  });

  it("has empty inputs and no flags for a formula of pure numbers", () => {
    const result = run("2 * (3 + 4)");
    expect(result).toEqual({
      value: 14,
      inputs: [],
      dividedByZero: false,
      nonFinite: false,
      missingInputs: [],
    });
  });
});

describe("evaluateFormula — delay routing", () => {
  it("reads delay() from the previous sweep and plain ids from this one", () => {
    const result = run("x - delay(x)", { x: 10 }, { x: 4 });
    expect(result.value).toBe(6);
    expect(result.inputs).toEqual([
      { id: "x", value: 10, delayed: false },
      { id: "x", value: 4, delayed: true },
    ]);
  });

  it("never asks lookup() for a delayed id (and vice versa)", () => {
    const asked: string[] = [];
    const askedDelayed: string[] = [];
    const parsed = parseFormula("a * delay(b)");
    evaluateFormula(parsed, {
      lookup: (id) => {
        asked.push(id);
        return 2;
      },
      lookupDelayed: (id) => {
        askedDelayed.push(id);
        return 3;
      },
    });
    expect(asked).toEqual(["a"]);
    expect(askedDelayed).toEqual(["b"]);
  });
});

describe("evaluateFormula — divide by zero", () => {
  it("yields 0 for the division and raises the flag", () => {
    const result = run("examinations / traffic", { examinations: 50, traffic: 0 });
    expect(result.value).toBe(0);
    expect(result.dividedByZero).toBe(true);
    expect(result.nonFinite).toBe(false);
  });

  it("keeps evaluating the rest of the formula", () => {
    const result = run("1 / 0 + 7", {});
    expect(result.value).toBe(7);
    expect(result.dividedByZero).toBe(true);
  });

  it("counts a missing denominator as a division by zero", () => {
    const result = run("a / b", { a: 9 });
    expect(result.value).toBe(0);
    expect(result.dividedByZero).toBe(true);
    expect(result.missingInputs).toEqual(["b"]);
  });

  it("leaves the flag down when every divisor is fine", () => {
    expect(run("9 / 3").dividedByZero).toBe(false);
  });
});

describe("evaluateFormula — non-finite results", () => {
  it("returns 0 and flags a result that overflows to Infinity", () => {
    const huge = Number.MAX_VALUE;
    const result = run("a * b", { a: huge, b: huge });
    expect(result.value).toBe(0);
    expect(result.nonFinite).toBe(true);
  });

  it("returns 0 and flags a NaN result", () => {
    const result = run("a - b", { a: Infinity, b: Infinity });
    expect(result.value).toBe(0);
    expect(result.nonFinite).toBe(true);
  });

  it("leaves the flag down for an ordinary finite result", () => {
    expect(run("2 * 3").nonFinite).toBe(false);
  });
});

describe("realistic formulas from the design doc", () => {
  it("computes a ratio held inside 0..1 — clamp(examinations / traffic, 0, 1)", () => {
    const formula = parseFormula("clamp(examinations / traffic, 0, 1)");
    expect(formula.references).toEqual(["examinations", "traffic"]);

    expect(evaluateFormula(formula, makeContext({ examinations: 250, traffic: 1000 })).value).toBe(
      0.25,
    );
    // More examinations than traffic can't mean 140% coverage.
    expect(evaluateFormula(formula, makeContext({ examinations: 1400, traffic: 1000 })).value).toBe(
      1,
    );
    // No traffic at all: the division is guarded, and the flag explains the 0.
    const noTraffic = evaluateFormula(formula, makeContext({ examinations: 250, traffic: 0 }));
    expect(noTraffic.value).toBe(0);
    expect(noTraffic.dividedByZero).toBe(true);
  });

  it("computes a capacity constraint — min(treatment_demand, treatment_capacity)", () => {
    const formula = parseFormula("min(treatment_demand, treatment_capacity)");
    expect(
      evaluateFormula(formula, makeContext({ treatment_demand: 900, treatment_capacity: 600 }))
        .value,
    ).toBe(600);
    expect(
      evaluateFormula(formula, makeContext({ treatment_demand: 400, treatment_capacity: 600 }))
        .value,
    ).toBe(400);
  });

  it("computes a flow split by a param share — attempted_importation * share_air", () => {
    const result = run("attempted_importation * share_air", {
      attempted_importation: 1000,
      share_air: 0.35,
    });
    expect(result.value).toBe(350);
    expect(result.inputs).toEqual([
      { id: "attempted_importation", value: 1000, delayed: false },
      { id: "share_air", value: 0.35, delayed: false },
    ]);
  });

  it("computes a joint requirement (gate) — every factor must hold up", () => {
    const source =
      "attempted_importation * exam_coverage * selection_quality * detection_rate_xray";
    const full = run(source, {
      attempted_importation: 1000,
      exam_coverage: 0.5,
      selection_quality: 0.4,
      detection_rate_xray: 0.6,
    });
    expect(full.value).toBeCloseTo(120, 10);

    // One factor at zero collapses the whole product — that's the point of a gate.
    const gated = run(source, {
      attempted_importation: 1000,
      exam_coverage: 0,
      selection_quality: 0.4,
      detection_rate_xray: 0.6,
    });
    expect(gated.value).toBe(0);
  });

  it("computes a flow balance — undetected_flow = attempted_importation - seizures", () => {
    expect(
      run("attempted_importation - seizures", { attempted_importation: 1000, seizures: 120 }).value,
    ).toBe(880);
  });

  it("computes delayed feedback — base_price * (1 + price_elasticity * delay(seizure_rate))", () => {
    const formula = parseFormula("base_price * (1 + price_elasticity * delay(seizure_rate))");
    expect(formula.references).toEqual(["base_price", "price_elasticity"]);
    expect(formula.delayReferences).toEqual(["seizure_rate"]);

    const result = evaluateFormula(
      formula,
      makeContext({ base_price: 100, price_elasticity: 0.5 }, { seizure_rate: 0.2 }),
    );
    expect(result.value).toBeCloseTo(110, 10);
    expect(result.inputs).toEqual([
      { id: "base_price", value: 100, delayed: false },
      { id: "price_elasticity", value: 0.5, delayed: false },
      { id: "seizure_rate", value: 0.2, delayed: true },
    ]);
  });
});

describe("parseFormula — safety limits", () => {
  it("refuses absurdly deep nesting rather than blowing the stack", () => {
    const deep = "(".repeat(500) + "1" + ")".repeat(500);
    expect(() => parseFormula(deep)).toThrow(/nested too deeply/);
  });

  it("still accepts sensibly nested formulas", () => {
    expect(run("((((1 + 2))))").value).toBe(3);
  });
});
