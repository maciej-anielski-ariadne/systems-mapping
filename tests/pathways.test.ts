import { describe, it, expect, beforeEach } from "vitest";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import { state, edgeById } from "../assets/js/03-state";
import { resolveEdgeElasticity } from "../assets/js/07-simulation-engine";
import {
  PATHWAY_ROUTE_LIMIT,
  canReachSet,
  clearPathway,
  currentRoute,
  findRoutes,
  hopNumber,
  isStrandEnd,
  isStrandStart,
  pathwayActive,
  pathwayEdgeSet,
  pathwayNodeSet,
  reachableFromSet,
  revalidatePathway,
  selectRoute,
  showRoute,
  signFlipCount,
  startPathway,
  stepRoute,
  streamsCrossed,
  suggestStrandsThrough,
} from "../assets/js/09a-pathways";
import { LINEAR_CSV } from "./fixtures/graphs";

// ─────────────────────────────────────────────────────────────────────────
// A map with a genuine choice of routes, a sign flip, and a feedback loop —
// the three things a strand has to survive.
//
//   in ──┬─→ fast ────────────────────┬─→ out
//        └─→ slow_a → slow_b ─────────┘
//   in ────→ drag ──(decreases)──────→ out
//   out ───→ loop_back ──────────────→ in        (feedback: in is revisited)
//   out ───→ tail                                (a true dead end)
//
// Routes in → out: [fast], [slow_a, slow_b], [drag]. The loop means a naive
// walker would never stop; simple paths make it terminate — and because the
// loop puts every other box in one cycle, `tail` is the only place from which
// nothing is reachable, which is what makes the "no route" case testable.
// ─────────────────────────────────────────────────────────────────────────
const BRANCHY_CSV = `# SECTION: streams
id,label,short,color
one,Row One,ONE,#60a5fa
two,Row Two,TWO,#34d399

# SECTION: stages
id,label
s1,Start
s2,Middle
s3,End

# SECTION: categories
id,label,color,text_color,class
cat,General,#a3a3a3,#111111,primary

# SECTION: defaults
key,value
elasticity_enables,0.30
elasticity_increases,0.25
elasticity_decreases,-0.25

# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max
in,The Input,,one,s1,cat,100,units,true,,400
fast,Fast Path,,one,s2,cat,50,units,,,
slow_a,Slow One,,two,s2,cat,50,units,,,
slow_b,Slow Two,,two,s2,cat,50,units,,,
drag,The Drag,,two,s2,cat,50,units,,,
out,The Output,,one,s3,cat,20,units,,higher_better,
loop_back,Loop Back,,one,s3,cat,10,units,,,
tail,Dead End,,two,s3,cat,5,units,,,

# SECTION: edges
from,to,effect,elasticity,style,description
in,fast,increases,0.8,,Straight through
fast,out,increases,0.9,,Straight through
in,slow_a,increases,0.5,,The long way
slow_a,slow_b,increases,0.5,,The long way
slow_b,out,increases,0.5,,The long way
in,drag,increases,0.4,,Into the drag
drag,out,decreases,-0.4,,The drag pulls the other way
out,loop_back,increases,0.3,,Closes the loop
loop_back,in,increases,0.3,,Closes the loop
out,tail,increases,0.6,,Nothing leads out of here
`;

// Two `decreases` links in a row: the net effect is an INCREASE. This is the
// inference the straightened view exists to make checkable.
const DOUBLE_NEGATIVE_CSV = `# SECTION: streams
id,label,short,color
one,Row One,ONE,#60a5fa

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
a,Box A,,one,s1,cat,100,units,true,,400
b,Box B,,one,s2,cat,50,units,,,
c,Box C,,one,s3,cat,20,units,,higher_better,

# SECTION: edges
from,to,effect,elasticity,style,description
a,b,decreases,-0.5,,Down
b,c,decreases,-0.5,,Down again — so A ends up RAISING C
`;

const ids = (route: { nodeIds: string[] } | null): string[] => (route ? route.nodeIds : []);

beforeEach(() => {
  clearPathway();
});

describe("findRoutes — every simple downstream route, strongest first", () => {
  beforeEach(() => loadDataFromCsv(BRANCHY_CSV));

  it("finds all three routes and ranks them by strength", () => {
    const result = findRoutes("in", "out");
    expect(result.total).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.routes.map(r => r.nodeIds)).toEqual([
      ["in", "fast", "out"],                 // 0.8 × 0.9  = 0.72
      ["in", "drag", "out"],                 // 0.4 × 0.4  = 0.16
      ["in", "slow_a", "slow_b", "out"],     // 0.5³       = 0.125
    ]);
    expect(result.routes[0].strength).toBeCloseTo(0.72, 10);
    expect(result.routes[1].strength).toBeCloseTo(0.16, 10);
    expect(result.routes[2].strength).toBeCloseTo(0.125, 10);
  });

  it("carries the edge ids in step with the boxes", () => {
    const route = findRoutes("in", "out").routes[0];
    expect(route.edgeIds).toHaveLength(route.nodeIds.length - 1);
    route.edgeIds.forEach((edgeId, i) => {
      const edge = edgeById[edgeId];
      expect(edge.from).toBe(route.nodeIds[i]);
      expect(edge.to).toBe(route.nodeIds[i + 1]);
    });
  });

  it("terminates on a map with a feedback loop, never revisiting a box", () => {
    // out → loop_back → in closes a cycle. Without the no-revisits rule this
    // search would not halt.
    for (const route of findRoutes("in", "out").routes) {
      expect(new Set(route.nodeIds).size).toBe(route.nodeIds.length);
    }
    // And the loop itself is walkable as a strand in its own right.
    expect(findRoutes("out", "in").routes.map(r => r.nodeIds)).toEqual([
      ["out", "loop_back", "in"],
    ]);
  });

  it("follows arrows strictly downstream — no route is not an error", () => {
    // Nothing leads out of `tail`, so there is no way back to the input…
    expect(findRoutes("tail", "in").routes).toHaveLength(0);
    expect(findRoutes("tail", "in").total).toBe(0);
    // …while the same two boxes are connected the other way round.
    expect(findRoutes("in", "tail").routes.length).toBeGreaterThan(0);
  });

  it("refuses degenerate ends", () => {
    expect(findRoutes("in", "in").routes).toHaveLength(0);
    expect(findRoutes("in", "nope").routes).toHaveLength(0);
    expect(findRoutes("nope", "out").routes).toHaveLength(0);
  });

  it("computes the net sign as the product of the link signs", () => {
    const viaDrag = findRoutes("in", "out").routes.find(r => r.nodeIds.includes("drag"))!;
    expect(viaDrag.sign).toBe(-1);          // one `decreases` link
    const viaFast = findRoutes("in", "out").routes.find(r => r.nodeIds.includes("fast"))!;
    expect(viaFast.sign).toBe(1);
  });

  it("honours the requested limit while still counting every route", () => {
    const capped = findRoutes("in", "out", 2);
    expect(capped.routes).toHaveLength(2);
    expect(capped.total).toBe(3);           // the count is of what EXISTS, not what was kept
    expect(capped.routes[0].nodeIds).toEqual(["in", "fast", "out"]);
  });

  it("defaults to the ten-route cap", () => {
    expect(PATHWAY_ROUTE_LIMIT).toBe(10);
    expect(findRoutes("in", "out").routes.length).toBeLessThanOrEqual(PATHWAY_ROUTE_LIMIT);
  });
});

describe("net sign — two decreases make an increase", () => {
  beforeEach(() => loadDataFromCsv(DOUBLE_NEGATIVE_CSV));

  it("reports a net increase across two negative links", () => {
    const route = findRoutes("a", "c").routes[0];
    expect(route.nodeIds).toEqual(["a", "b", "c"]);
    expect(route.sign).toBe(1);             // (−) × (−) = +
    expect(signFlipCount(route)).toBe(2);
    // Strength uses the magnitudes, so a negative link still propagates.
    expect(route.strength).toBeCloseTo(0.25, 10);
  });
});

describe("strength ranking uses each link's resolved elasticity", () => {
  beforeEach(() => loadDataFromCsv(LINEAR_CSV));

  it("multiplies the same values the simulation engine resolves", () => {
    const route = findRoutes("a", "c").routes[0];
    const expected = route.edgeIds.reduce(
      (acc, id) => acc * Math.abs(resolveEdgeElasticity(edgeById[id])), 1);
    expect(route.strength).toBeCloseTo(expected, 12);
    expect(route.strength).toBeCloseTo(0.5 * 1.0, 12);
  });
});

describe("reachability helpers", () => {
  beforeEach(() => loadDataFromCsv(BRANCHY_CSV));

  it("canReachSet walks backwards, reachableFromSet forwards", () => {
    expect(canReachSet("out").has("slow_a")).toBe(true);
    expect(canReachSet("out").has("out")).toBe(true);     // includes the target itself
    expect(reachableFromSet("drag").has("out")).toBe(true);
    expect(reachableFromSet("fast").has("slow_a")).toBe(true);  // via the loop
  });
});

describe("strand ends", () => {
  beforeEach(() => loadDataFromCsv(BRANCHY_CSV));

  it("counts an adjustable input as a start and a direction-of-merit box as an end", () => {
    // `in` has an incoming arrow (from loop_back) so the no-incoming rule alone
    // would miss it — being controllable is what makes it a place to start.
    expect(isStrandStart("in")).toBe(true);
    expect(isStrandStart("fast")).toBe(false);
    // `out` has an outgoing arrow (to loop_back); its direction makes it an end.
    expect(isStrandEnd("out")).toBe(true);
    expect(isStrandEnd("fast")).toBe(false);
    // …and a box with no outgoing arrows at all is an end on the plain rule.
    expect(isStrandEnd("tail")).toBe(true);
  });
});

describe("suggestStrandsThrough", () => {
  beforeEach(() => loadDataFromCsv(BRANCHY_CSV));

  it("returns complete start-to-finish strands that pass through the box", () => {
    const strands = suggestStrandsThrough("slow_b");
    expect(strands.length).toBeGreaterThan(0);
    for (const strand of strands) {
      expect(strand.nodeIds).toContain("slow_b");
      expect(isStrandStart(strand.nodeIds[0])).toBe(true);
      expect(isStrandEnd(strand.nodeIds[strand.nodeIds.length - 1])).toBe(true);
      expect(new Set(strand.nodeIds).size).toBe(strand.nodeIds.length);
    }
  });

  it("ranks them strongest first and never repeats a chain", () => {
    const strands = suggestStrandsThrough("out");
    const keys = strands.map(s => s.nodeIds.join(">"));
    expect(new Set(keys).size).toBe(keys.length);
    for (let i = 1; i < strands.length; i++) {
      expect(strands[i - 1].strength).toBeGreaterThanOrEqual(strands[i].strength);
    }
  });

  it("still works when the box is itself an end of the strand", () => {
    const strands = suggestStrandsThrough("in");     // `in` is a start
    expect(strands.length).toBeGreaterThan(0);
    expect(strands.every(s => s.nodeIds[0] === "in")).toBe(true);
  });

  it("respects the requested limit", () => {
    expect(suggestStrandsThrough("out", 2).length).toBeLessThanOrEqual(2);
  });
});

describe("pathway state transitions", () => {
  beforeEach(() => loadDataFromCsv(BRANCHY_CSV));

  it("startPathway loads the routes and reports what it found", () => {
    const result = startPathway("in", "out");
    expect(pathwayActive()).toBe(true);
    expect(result.total).toBe(3);
    expect(state.pathway.fromId).toBe("in");
    expect(state.pathway.toId).toBe("out");
    expect(state.pathway.totalRoutes).toBe(3);
    expect(state.pathway.routeIndex).toBe(0);
    expect(ids(currentRoute())).toEqual(["in", "fast", "out"]);
  });

  it("leaves the mode off when nothing connects the two ends", () => {
    startPathway("tail", "in");
    expect(pathwayActive()).toBe(false);
    expect(currentRoute()).toBeNull();
  });

  it("keeps the node / edge sets and hop numbers in step with the route", () => {
    startPathway("in", "out");
    expect([...pathwayNodeSet()].sort()).toEqual(["fast", "in", "out"]);
    expect(pathwayEdgeSet().size).toBe(2);
    expect(hopNumber("in")).toBe(1);
    expect(hopNumber("fast")).toBe(2);
    expect(hopNumber("out")).toBe(3);
    expect(hopNumber("slow_a")).toBe(0);      // not on this strand

    stepRoute(1);
    expect([...pathwayNodeSet()].sort()).toEqual(["drag", "in", "out"]);
    expect(hopNumber("fast")).toBe(0);
    expect(hopNumber("drag")).toBe(2);
  });

  it("cycles through the alternatives and wraps at both ends", () => {
    startPathway("in", "out");
    stepRoute(1);
    expect(state.pathway.routeIndex).toBe(1);
    stepRoute(1);
    stepRoute(1);
    expect(state.pathway.routeIndex).toBe(0);       // wrapped forwards
    stepRoute(-1);
    expect(state.pathway.routeIndex).toBe(2);       // and backwards
  });

  it("ignores an out-of-range route selection", () => {
    startPathway("in", "out");
    selectRoute(99);
    expect(state.pathway.routeIndex).toBe(0);
    selectRoute(-1);
    expect(state.pathway.routeIndex).toBe(0);
    selectRoute(2);
    expect(state.pathway.routeIndex).toBe(2);
  });

  it("clearPathway resets everything", () => {
    startPathway("in", "out");
    clearPathway();
    expect(pathwayActive()).toBe(false);
    expect(currentRoute()).toBeNull();
    expect(pathwayNodeSet().size).toBe(0);
    expect(pathwayEdgeSet().size).toBe(0);
    expect(state.pathway.fromId).toBeNull();
    expect(state.pathway.view).toBe("map");
  });

  it("showRoute lands on the chosen chain, not merely the strongest one", () => {
    const weakest = findRoutes("in", "out").routes[2];   // the slow_a / slow_b way
    showRoute(weakest);
    expect(ids(currentRoute())).toEqual(weakest.nodeIds);
    // …and the other routes between the same two ends are still there to cycle.
    expect(state.pathway.routes.length).toBe(3);
  });

  it("counts the rows a strand crosses", () => {
    startPathway("in", "out");
    expect(streamsCrossed(currentRoute()!)).toBe(1);      // in / fast / out are all row one
    selectRoute(2);
    expect(streamsCrossed(currentRoute()!)).toBe(2);      // slow_a / slow_b are row two
  });
});

describe("revalidatePathway — surviving an edit", () => {
  beforeEach(() => loadDataFromCsv(BRANCHY_CSV));

  it("keeps the strand when the map is untouched", () => {
    startPathway("in", "out");
    const before = ids(currentRoute());
    revalidatePathway();
    expect(ids(currentRoute())).toEqual(before);
  });

  it("drops routes whose links no longer exist, keeping the survivors", () => {
    startPathway("in", "out");
    expect(state.pathway.routes).toHaveLength(3);
    // Delete the strand's own link, as a canvas edit would.
    const doomed = state.pathway.routes[0].edgeIds[0];
    delete edgeById[doomed];
    revalidatePathway();
    expect(state.pathway.routes.every(r => !r.edgeIds.includes(doomed))).toBe(true);
    expect(state.pathway.routes.length).toBeGreaterThan(0);
    expect(state.pathway.routeIndex).toBeLessThan(state.pathway.routes.length);
  });

  it("re-traces from the same two ends when every stored route breaks", () => {
    startPathway("in", "out");
    const remembered = state.pathway.routes;
    // Every route object is stale (as after a reload), but the graph still
    // connects the two ends — so the strand should come back, not vanish.
    state.pathway.routes = remembered.map(r => ({ ...r, edgeIds: ["gone"] }));
    revalidatePathway();
    expect(pathwayActive()).toBe(true);
    expect(state.pathway.routes[0].nodeIds).toEqual(["in", "fast", "out"]);
  });

  it("clears the strand when its boxes are gone entirely", () => {
    startPathway("in", "out");
    loadDataFromCsv(LINEAR_CSV);      // a different map — rebuildIndexes revalidates
    expect(pathwayActive()).toBe(false);
  });
});
