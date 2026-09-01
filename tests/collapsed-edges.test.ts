import { describe, it, expect, beforeEach } from "vitest";
import { loadDataFromCsv, rebuildIndexes } from "../assets/js/06-data-loader";
import { computeRenderEdges } from "../assets/js/10a-collapsed-edges";
import { setEdges, setNodes, state } from "../assets/js/03-state";
import type { GraphNode } from "../assets/js/types";
import { REROUTE_CSV } from "./fixtures/graphs";

// Build a CSV whose middle stage (s2) is a dense hidden region: `mid` nodes,
// every one of them linked to every other (a complete digraph), fed by `a` and
// draining into `z`. The exhaustive path walk this file used to do enumerates
// every simple path through that region — factorial in `mid` — so a single
// collapse of the middle column could hang the tab. `negativeBranch` optionally
// makes two of the routes disagree in sign.
function densehiddenCsv(mid: number, negativeBranch: boolean): string {
  let nodeRows = "a,Node A,,ops,s1,cat,,,,,\nz,Node Z,,ops,s3,cat,,,,,\n";
  for (let i = 0; i < mid; i++) nodeRows += `m${i},Mid ${i},,ops,s2,cat,,,,,\n`;
  let edgeRows = "";
  for (let i = 0; i < mid; i++) {
    edgeRows += `a,m${i},increases,0.5,,\n`;
    edgeRows += (negativeBranch && i === 1)
      ? `m${i},z,decreases,-0.5,,\n`
      : `m${i},z,increases,0.5,,\n`;
    for (let j = 0; j < mid; j++) if (i !== j) edgeRows += `m${i},m${j},increases,0.5,,\n`;
  }
  return `# SECTION: streams
id,label,short,color
ops,Operations,OPS,#60a5fa

# SECTION: stages
id,label
s1,Start
s2,Middle
s3,End

# SECTION: categories
id,label,color,text_color,class
cat,General,#a3a3a3,#111111,primary

# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max
${nodeRows}
# SECTION: edges
from,to,effect,elasticity,style,description
${edgeRows}`;
}

describe("computeRenderEdges — re-routing through a hidden region", () => {
  it("resolves a sign conflict through hidden nodes as a neutral connector", () => {
    // a → m0 → z is positive; a → m1 → z is negative. Two hidden routes, two
    // directions, so the pathway is drawn but its net direction is unclear.
    loadDataFromCsv(densehiddenCsv(2, true));
    state.hiddenStages = new Set(["s2"]);
    const synthetic = computeRenderEdges().filter((e) => e.synthetic);
    expect(synthetic).toHaveLength(1);
    expect(synthetic[0]).toMatchObject({ from: "a", to: "z", effect: "neutral", netSign: 0 });
    state.hiddenStages = new Set();
  });

  it("keeps one direction when every hidden route agrees", () => {
    loadDataFromCsv(densehiddenCsv(3, false));
    state.hiddenStages = new Set(["s2"]);
    const synthetic = computeRenderEdges().filter((e) => e.synthetic);
    expect(synthetic).toHaveLength(1);
    expect(synthetic[0]).toMatchObject({ from: "a", to: "z", effect: "increases" });
    state.hiddenStages = new Set();
  });

  it("completes promptly on a dense hidden region instead of enumerating every path", () => {
    // 9 fully-interconnected hidden nodes ⇒ ~100k+ simple paths for the old
    // exhaustive walk; the bounded expansion visits each node a fixed number of
    // times, so this is milliseconds.
    loadDataFromCsv(densehiddenCsv(9, false));
    state.hiddenStages = new Set(["s2"]);
    const started = Date.now();
    const edges = computeRenderEdges();
    const elapsed = Date.now() - started;
    expect(edges.filter((e) => e.synthetic)).toHaveLength(1);
    expect(elapsed).toBeLessThan(1000);
    state.hiddenStages = new Set();
  });
});

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

describe("computeRenderEdges — collision-free endpoint identity", () => {
  it("keeps distinct synthetic pairs even when programmatic ids contain the old delimiter", () => {
    const node = (id: string, stage: string): GraphNode => ({
      id, label: id, description: "", stream: "ops", stage, category: "cat",
      categoryIds: ["cat"], primaryCategories: ["cat"], secondaryCategories: [],
    });
    setNodes([
      node("a->b", "s1"), node("c", "s3"), node("a", "s1"), node("b->c", "s3"),
      node("hidden_one", "s2"), node("hidden_two", "s2"),
    ]);
    setEdges([
      { from: "a->b", to: "hidden_one", effect: "increases", description: "" },
      { from: "hidden_one", to: "c", effect: "increases", description: "" },
      { from: "a", to: "hidden_two", effect: "increases", description: "" },
      { from: "hidden_two", to: "b->c", effect: "increases", description: "" },
    ]);
    rebuildIndexes();
    state.hiddenStages = new Set(["s2"]);

    const syntheticPairs = computeRenderEdges()
      .filter(edge => edge.synthetic)
      .map(edge => [edge.from, edge.to]);
    expect(syntheticPairs).toEqual(expect.arrayContaining([
      ["a->b", "c"],
      ["a", "b->c"],
    ]));
    expect(syntheticPairs).toHaveLength(2);
    state.hiddenStages = new Set();
  });
});
