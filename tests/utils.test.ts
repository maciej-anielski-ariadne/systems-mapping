import { describe, it, expect } from "vitest";
import {
  wrapLabel,
  measureLabelLines,
  escapeHtml,
  formatScalar,
  nodeCategoryIds,
  splitCategoriesByClass,
  edgeBezierPath,
  isBackwardEdge,
  computeEdgeAnchorOffsets,
  deltaColorFor,
  getMapTextScale,
  pickTextColor,
  cloneEdgeForUndo,
  cloneNodeForUndo,
} from "../assets/js/04-utils";
import { TEXT_SCALE_MAX } from "../assets/js/02-config";
import type { CategoryMap, Edge, GraphNode, NodePosition } from "../assets/js/types";

describe("escapeHtml", () => {
  it("escapes the HTML-unsafe characters", () => {
    expect(escapeHtml('<a href="x">&y')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;y");
  });
});

describe("formatScalar", () => {
  it("formats by magnitude band", () => {
    expect(formatScalar(2.5e9)).toBe("2.50");
    expect(formatScalar(12000)).toBe("12,000");
    expect(formatScalar(250)).toBe("250");
    expect(formatScalar(12.5)).toBe("12.5");
    expect(formatScalar(3.14159)).toBe("3.14");
    expect(formatScalar(0.125)).toBe("0.125");
  });
});

describe("wrapLabel", () => {
  it("keeps short text on one line", () => {
    expect(wrapLabel("short", 20)).toEqual(["short"]);
  });
  it("wraps to at most two lines, ellipsising overflow", () => {
    const lines = wrapLabel("one two three four five six", 10);
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith("…")).toBe(true);
  });
});

describe("measureLabelLines (canvas-stub: 7px/char)", () => {
  it("returns a single line when it fits the width", () => {
    // 8 chars * 7px = 56px < 100px
    expect(measureLabelLines("eight ch", 100)).toEqual(["eight ch"]);
  });
  it("wraps when words exceed the pixel width", () => {
    // each word ~5 chars; width 40px fits one ~5-char word per line
    const lines = measureLabelLines("alpha bravo charlie", 40);
    expect(lines.length).toBeGreaterThan(1);
  });
  it("never splits a single over-wide word", () => {
    expect(measureLabelLines("supercalifragilistic", 10)).toEqual(["supercalifragilistic"]);
  });
});

describe("nodeCategoryIds / splitCategoriesByClass", () => {
  const cats: CategoryMap = {
    p1: { label: "P1", color: "#fff", textColor: "#000", class: "primary" },
    s1: { label: "S1", color: "#fff", textColor: "#000", class: "secondary" },
  };
  it("prefers categoryIds, falling back to the single category", () => {
    expect(nodeCategoryIds({ categoryIds: ["a", "b"], category: "a" } as GraphNode)).toEqual(["a", "b"]);
    expect(nodeCategoryIds({ categoryIds: [], category: "solo" } as unknown as GraphNode)).toEqual(["solo"]);
  });
  it("splits ids by their class", () => {
    expect(splitCategoriesByClass(["p1", "s1"], cats)).toEqual({ primary: ["p1"], secondary: ["s1"] });
  });
  it("drops unknown ids", () => {
    expect(splitCategoriesByClass(["p1", "ghost"], cats)).toEqual({ primary: ["p1"], secondary: [] });
  });
});

describe("edgeBezierPath", () => {
  it("starts at the source's right edge and ends at the target's left edge", () => {
    const from: NodePosition = { x: 0, y: 0, width: 100, height: 40, labelLines: [] };
    const to: NodePosition = { x: 300, y: 80, width: 100, height: 40, labelLines: [] };
    const path = edgeBezierPath(from, to);
    expect(path.startsWith("M 100,20")).toBe(true);
    expect(path).toContain("300,100"); // endX,endY
  });

  it("draws a backward edge from the source's LEFT face to the target's RIGHT face", () => {
    // target directly LEFT, same row → a normal-style cubic curve, but mirrored:
    // it exits the source's left and enters the target's right (arrow points left).
    const from: NodePosition = { x: 400, y: 100, width: 160, height: 48, labelLines: [] };
    const to: NodePosition = { x: 100, y: 100, width: 160, height: 48, labelLines: [] };
    const path = edgeBezierPath(from, to);
    expect(path.startsWith("M 400,124")).toBe(true); // source LEFT side, mid height
    expect(path.endsWith("260,124")).toBe(true); // target RIGHT side, mid height
    // Same smooth cubic style as a forward edge — no orthogonal routing.
    expect(path).toContain("C");
    expect(path).not.toContain("L");
    expect(path).not.toContain("Q");
  });

  it("shifts the anchors by the fan-out offsets", () => {
    const from: NodePosition = { x: 0, y: 0, width: 100, height: 40, labelLines: [] };
    const to: NodePosition = { x: 300, y: 80, width: 100, height: 40, labelLines: [] };
    const path = edgeBezierPath(from, to, -6, 4);
    expect(path.startsWith("M 100,14")).toBe(true); // 20 + (-6)
    expect(path).toContain("300,104"); // endY 100 + 4
  });
});

describe("isBackwardEdge", () => {
  const from: NodePosition = { x: 0, y: 0, width: 100, height: 40, labelLines: [] };
  it("is false when the target is clearly to the right (forward)", () => {
    // BACK_MARGIN is 24; right face is at x=100, so target.x must be >= 124.
    expect(isBackwardEdge(from, { x: 124, y: 0, width: 100, height: 40, labelLines: [] })).toBe(false);
  });
  it("is true at and inside the backward margin boundary", () => {
    expect(isBackwardEdge(from, { x: 123, y: 0, width: 100, height: 40, labelLines: [] })).toBe(true);
    expect(isBackwardEdge(from, { x: -50, y: 0, width: 100, height: 40, labelLines: [] })).toBe(true);
  });
});

describe("computeEdgeAnchorOffsets", () => {
  const positions: Record<string, NodePosition> = {
    a: { x: 0, y: 0, width: 100, height: 40, labelLines: [] },
    b: { x: 0, y: 100, width: 100, height: 40, labelLines: [] },
    t: { x: 300, y: 0, width: 100, height: 40, labelLines: [] },
  };
  const acc = {
    from: (e: { from: string }) => e.from,
    to: (e: { to: string }) => e.to,
    effect: (e: { effect: string }) => e.effect,
    style: (e: { style: string }) => e.style,
  };

  it("leaves a single (effect, style) bucket centred (offset 0)", () => {
    const edges = [
      { from: "a", to: "t", effect: "increases", style: "solid" },
      { from: "b", to: "t", effect: "increases", style: "solid" },
    ];
    const off = computeEdgeAnchorOffsets(edges, positions, acc.from, acc.to, acc.effect, acc.style);
    expect(off.map((o) => o.toYOffset)).toEqual([0, 0]);
  });

  it("fans distinct effect buckets into symmetric offsets on the shared face", () => {
    const edges = [
      { from: "a", to: "t", effect: "increases", style: "solid" },
      { from: "b", to: "t", effect: "decreases", style: "solid" },
    ];
    const off = computeEdgeAnchorOffsets(edges, positions, acc.from, acc.to, acc.effect, acc.style);
    // increases ranks before decreases → negative (up) then positive (down), symmetric
    expect(off[0].toYOffset).toBeLessThan(0);
    expect(off[1].toYOffset).toBeGreaterThan(0);
    expect(off[0].toYOffset).toBeCloseTo(-off[1].toYOffset);
  });

  it("merges same-effect-same-style edges into one shared anchor", () => {
    const edges = [
      { from: "a", to: "t", effect: "increases", style: "solid" },
      { from: "b", to: "t", effect: "increases", style: "solid" },
      { from: "a", to: "t", effect: "decreases", style: "solid" },
    ];
    const off = computeEdgeAnchorOffsets(edges, positions, acc.from, acc.to, acc.effect, acc.style);
    expect(off[0].toYOffset).toBe(off[1].toYOffset); // both increases → same anchor
    expect(off[2].toYOffset).not.toBe(off[0].toYOffset); // decreases → its own anchor
  });

  it("clamps anchors inside the node face for many buckets", () => {
    const edges = [
      { from: "a", to: "t", effect: "increases", style: "solid" },
      { from: "a", to: "t", effect: "decreases", style: "solid" },
      { from: "a", to: "t", effect: "enables", style: "solid" },
      { from: "a", to: "t", effect: "increases", style: "dashed" },
    ];
    const off = computeEdgeAnchorOffsets(edges, positions, acc.from, acc.to, acc.effect, acc.style);
    const half = positions.t.height / 2;
    for (const o of off) expect(Math.abs(o.toYOffset)).toBeLessThanOrEqual(half);
  });
});

describe("deltaColorFor", () => {
  it("greens a beneficial move and reds a harmful one", () => {
    expect(deltaColorFor({ direction: "higher_better" } as GraphNode, { pct: 5 })).toBe("#065f46");
    expect(deltaColorFor({ direction: "higher_better" } as GraphNode, { pct: -5 })).toBe("#7f1d1d");
    expect(deltaColorFor({ direction: "lower_better" } as GraphNode, { pct: -5 })).toBe("#065f46");
  });
});

describe("getMapTextScale", () => {
  it("is 1 at normal zoom and grows (capped) when zoomed out", () => {
    expect(getMapTextScale(1)).toBe(1);
    expect(getMapTextScale(0.1)).toBe(TEXT_SCALE_MAX);
    expect(getMapTextScale(0)).toBe(1);
  });
});

describe("pickTextColor", () => {
  it("returns dark text on light fills and white on dark fills", () => {
    expect(pickTextColor("#ffffff")).toBe("#1c1917");
    expect(pickTextColor("#000000")).toBe("#ffffff");
    expect(pickTextColor("#fff")).toBe("#1c1917"); // 3-digit form
  });
  it("falls back to white for unparseable input", () => {
    expect(pickTextColor("not-a-color")).toBe("#ffffff");
  });
});

describe("clone*ForUndo", () => {
  it("clones the documented edge fields", () => {
    const edge: Edge = { from: "a", to: "b", effect: "increases", elasticity: 0.4, description: "d", id: "edge_0" };
    expect(cloneEdgeForUndo(edge)).toEqual({ from: "a", to: "b", effect: "increases", elasticity: 0.4, description: "d" });
  });
  it("shallow-clones a node", () => {
    const node = { id: "n", label: "N" } as GraphNode;
    const clone = cloneNodeForUndo(node);
    expect(clone).toEqual(node);
    expect(clone).not.toBe(node);
  });
});
