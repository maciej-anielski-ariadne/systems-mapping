// =============================================================================
// SELECTION REPAINT — the incremental path must equal a full render
// -----------------------------------------------------------------------------
// Selecting a node changes nothing structural, so 11-rendering patches the
// classes and stroke attributes of the slice already on screen instead of
// rebuilding the SVG string (renderSelectionChange → refreshSelectionStyling).
// These tests pin the two properties that makes safe:
//   1. the live elements are patched, not replaced; and
//   2. the result is indistinguishable from what a full render() would have
//      produced — same classes, same stroke/width/opacity/marker on every link,
//      same border on every box.
// =============================================================================
import { describe, it, expect, beforeEach } from "vitest";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import { render, refreshSelectionStyling } from "../assets/js/11-rendering";
import { deselectAll, selectNode, toggleNodeInSelection } from "../assets/js/09-graph-selection";
import { computeLayout } from "../assets/js/08-layout";
import { NODES, setLayout, state } from "../assets/js/03-state";

// A small map with a branch, a feedback link, and a collapsible middle stage so
// both real and synthetic links are exercised.
const CSV = `# SECTION: streams
id,label,short,color
ops,Operations,OPS,#60a5fa
sup,Support,SUP,#f59e0b

# SECTION: stages
id,label
s1,Start
s2,Middle
s3,End

# SECTION: categories
id,label,color,text_color,class
cat,General,#a3a3a3,#111111,primary
sec,Extra,#22d3ee,#111111,secondary

# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max
a,Alpha,first,ops,s1,cat,100,units,true,,400
b,Bravo,second,ops,s2,cat,50,units,,higher_better,
c,Charlie,third,ops,s3,cat,20,units,,,
d,Delta,fourth,sup,s2,cat|sec,,,,,
e,Echo,fifth,sup,s3,cat,,,,,

# SECTION: edges
from,to,effect,elasticity,style,description
a,b,increases,0.5,,
b,c,increases,1.0,,
a,d,enables,,dashed,
d,e,decreases,,,
c,a,increases,,,
`;

// What the map looks like, reduced to exactly the things a selection changes.
interface Snapshot {
  nodes: Record<string, string[]>;
  edges: string[][];
  casings: string[][];
}

function snapshot(): Snapshot {
  const layer = document.querySelector(".ml-static-layer")!;
  const nodes: Record<string, string[]> = {};
  layer.querySelectorAll(".node-group").forEach((group) => {
    const rect = group.querySelector(".node-rect")!;
    const stripe = group.querySelector(".node-stripe")!;
    nodes[group.getAttribute("data-node-id")!] = [
      group.getAttribute("class")!,
      rect.getAttribute("stroke")!,
      rect.getAttribute("stroke-width")!,
      rect.getAttribute("fill")!,
      stripe.getAttribute("fill")!,
    ];
  });
  const edges = Array.from(layer.querySelectorAll(".edge-path")).map((p) => [
    p.getAttribute("class")!,
    p.getAttribute("data-edge-id") || "",
    p.getAttribute("stroke")!,
    p.getAttribute("stroke-width")!,
    p.getAttribute("stroke-opacity")!,
    p.getAttribute("marker-end") || "",
    p.getAttribute("stroke-dasharray") || "",
    p.getAttribute("d")!,
  ]);
  const casings = Array.from(layer.querySelectorAll(".edge-casing")).map((p) => [
    p.getAttribute("class")!,
    p.getAttribute("stroke-width")!,
    p.getAttribute("d")!,
  ]);
  return { nodes, edges, casings };
}

// Apply a selection change through the incremental path, then compare against
// the same state drawn from scratch.
function expectMatchesFullRender(): void {
  const patched = snapshot();
  render();
  expect(snapshot()).toEqual(patched);
}

describe("incremental selection repaint", () => {
  beforeEach(() => {
    loadDataFromCsv(CSV);
    render();
  });

  it("patches the existing elements instead of replacing them", () => {
    const groupBefore = document.querySelector('.node-group[data-node-id="b"]')!;
    const rectBefore = groupBefore.querySelector(".node-rect")!;
    const edgeBefore = document.querySelector(".ml-static-layer .edge-path")!;

    selectNode("b");

    expect(document.querySelector('.node-group[data-node-id="b"]')).toBe(groupBefore);
    expect(groupBefore.querySelector(".node-rect")).toBe(rectBefore);
    expect(document.querySelector(".ml-static-layer .edge-path")).toBe(edgeBefore);
    expect(groupBefore.classList.contains("selected")).toBe(true);
  });

  it("produces exactly what a full render would for a single selection", () => {
    selectNode("b");
    expectMatchesFullRender();
  });

  it("…for a multi-selection", () => {
    selectNode("b");
    toggleNodeInSelection("d");
    expectMatchesFullRender();
  });

  it("…for a deselect (outcome borders come back)", () => {
    selectNode("b");
    deselectAll();
    expectMatchesFullRender();
  });

  it("…with a collapsed stage, so synthetic links are patched too", () => {
    state.hiddenStages = new Set(["s2"]);
    setLayout(computeLayout());
    render();
    expect(document.querySelectorAll(".edge-path.synthetic").length).toBeGreaterThan(0);
    selectNode("a");
    expectMatchesFullRender();
    state.hiddenStages = new Set();
    setLayout(computeLayout());
    render();
  });

  it("restores every element to its unselected state after a select/deselect round trip", () => {
    const before = snapshot();
    selectNode("c");
    deselectAll();
    expect(snapshot()).toEqual(before);
  });

  it("refuses to patch a slice the layout has moved underneath", () => {
    selectNode("b");
    // Move a box into another cell: the drawn slice's geometry is now stale, so
    // the patch must decline and let the caller do a full render.
    NODES.find((n) => n.id === "b")!.stage = "s3";
    setLayout(computeLayout());
    expect(refreshSelectionStyling()).toBe(false);
    NODES.find((n) => n.id === "b")!.stage = "s2";
    setLayout(computeLayout());
    render();
  });
});
