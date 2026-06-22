import { describe, it, expect, beforeEach } from "vitest";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import { computeRenderEdges } from "../assets/js/10a-collapsed-edges";
import { state } from "../assets/js/03-state";
import { REROUTE_CSV } from "./fixtures/graphs";

describe("computeRenderEdges — A(s1) → B(s2) → C(s3)", () => {
  beforeEach(() => loadDataFromCsv(REROUTE_CSV));

  it("draws both real edges when nothing is hidden", () => {
    const edges = computeRenderEdges();
    expect(edges.every((e) => e.synthetic === false)).toBe(true);
    expect(edges).toHaveLength(2);
  });

  it("reroutes A → C as a synthetic 'increases' edge when the middle stage is hidden", () => {
    state.hiddenStages = new Set(["s2"]);
    const edges = computeRenderEdges();
    const synthetic = edges.filter((e) => e.synthetic);
    // B is hidden, so no real edge touches it; the pathway survives as one synthetic A→C.
    expect(edges.every((e) => e.from !== "b" && e.to !== "b")).toBe(true);
    expect(synthetic).toHaveLength(1);
    expect(synthetic[0]).toMatchObject({ from: "a", to: "c", effect: "increases" });
  });
});
