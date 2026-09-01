import { describe, expect, it } from "vitest";
import {
  createIdentifierRecord,
  isCanonicalIdentifier,
  isSafeHexColour,
  parseStrictFiniteNumber,
} from "../assets/js/05b-input-validation";
import { applyNodeFieldEdit } from "../assets/js/15-detail-panel";
import type { GraphNode } from "../assets/js/types";

describe("canonical identifiers", () => {
  it.each(["a", "_private", "box_12", "ABC"])('accepts "%s"', identifier => {
    expect(isCanonicalIdentifier(identifier)).toBe(true);
  });

  it.each([
    "", " leading", "trailing ", "two words", "1box", "box-name", "a->b",
    "__proto__", "constructor", "toString", 'box" onload="alert(1)', "<script>",
  ])('rejects "%s" without rewriting it', identifier => {
    expect(isCanonicalIdentifier(identifier)).toBe(false);
  });

  it("creates dictionaries with no inherited prototype keys", () => {
    const index = createIdentifierRecord<unknown>();
    Reflect.set(index, "constructor", 1);
    Reflect.set(index, "__proto__", 2);
    expect(Object.getPrototypeOf(index)).toBeNull();
    expect(Reflect.get(index, "constructor")).toBe(1);
    expect(Reflect.get(index, "__proto__")).toBe(2);
  });
});

describe("strict finite numbers", () => {
  it.each([
    ["3.5", 3.5], [" -2 ", -2], [".25", 0.25], ["1e3", 1000], ["+4", 4],
  ])("parses %s", (input, expected) => {
    expect(parseStrictFiniteNumber(input)).toBe(expected);
  });

  it.each(["", "12xyz", "Infinity", "-Infinity", "NaN", "0x10", "1,000"])(
    'rejects "%s"', input => {
      expect(parseStrictFiniteNumber(input)).toBeUndefined();
    },
  );
});

describe("safe imported colours", () => {
  it.each(["#abc", "#abcd", "#A1b2C3", "#A1b2C3d4"])("accepts %s", colour => {
    expect(isSafeHexColour(colour)).toBe(true);
  });

  it.each([
    "red", "rgb(1, 2, 3)", "var(--ink)", "url(javascript:alert(1))",
    '#fff" onload="alert(1)', "#12", "#12345",
  ])("rejects %s", colour => {
    expect(isSafeHexColour(colour)).toBe(false);
  });
});

describe("direct-edit numeric boundary", () => {
  const editableNode = (): GraphNode => ({
    id: "box", label: "Box", description: "", stream: "row", stage: "column",
    category: "category", categoryIds: ["category"], primaryCategories: ["category"],
    secondaryCategories: [], baseline: 100, sliderMax: 2, minValue: 0, maxValue: 200,
  });

  const numericInput = (value: string): HTMLInputElement => {
    const input = document.createElement("input");
    input.type = "number";
    input.value = value;
    return input;
  };

  it("rejects a non-positive baseline without mutating the box", () => {
    const node = editableNode();
    const input = numericInput("-5");
    applyNodeFieldEdit(node, "baseline", input);
    expect(node.baseline).toBe(100);
    expect(input.validationMessage).toMatch(/positive/i);
  });

  it("rejects crossed bounds without creating a transient invalid model", () => {
    const node = editableNode();
    const minimumInput = numericInput("250");
    applyNodeFieldEdit(node, "minValue", minimumInput);
    expect(node.minValue).toBe(0);
    expect(minimumInput.validationMessage).toMatch(/above/i);
  });
});
