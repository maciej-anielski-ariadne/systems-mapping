// =============================================================================
// REVIEW — cause attribution, and the sensitivity sweep
// -----------------------------------------------------------------------------
// The two pieces of logic behind the Review panel, tested against maps small
// enough to reason about by hand. Both were designed against a ninety-box map;
// these fixtures reproduce the same shapes in six boxes.
// =============================================================================
import { describe, it, expect, beforeEach } from "vitest";
import { loadDataFromCsv, rebuildIndexes } from "../assets/js/06-data-loader";
import { state, NODES, nodeById, setEdges, setNodes } from "../assets/js/03-state";
import {
  attributeFindings,
  classifyUnreached,
  groupFindings,
  runSweep,
  sweepExceptions,
  sweepIsPossible,
  invalidateSweep,
  currentSweep,
  REST_DRIFT,
  finding,
} from "../assets/js/22-review";
import { reviewQueue } from "../assets/js/22c-review-queue";
import { recordVerdict } from "../assets/js/24-review-record";
import { solverGeneration } from "../assets/js/07-simulation-engine";
import { FORMULA_GATE_CSV } from "./fixtures/graphs";
import { causes, consequences, kinds } from "./helpers/findings";

const HEAD = `# SECTION: streams
id,label,short,color
main,Main,MAIN,#888

# SECTION: stages
id,label
s1,One
s2,Two
s3,Three

# SECTION: categories
id,label,color,text_color
c,Thing,#444,#fff

`;

// a → b → c, with b's formula broken by a missing comma. b falls back to its
// links; c reads b, so c drifts only because b does.
const CASCADE_CSV = HEAD + `# SECTION: params
id,value,description
half,0.5,A share

# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max,combine,formula,min,max
a,A,,main,s1,c,100,units,true,,2,,,,
b,B,,main,s2,c,50,units,,,,,"a * half * 3",,
c,C,,main,s3,c,50,units,,,,,"b",,

# SECTION: edges
from,to,effect,elasticity,description
a,b,increases,,
b,c,increases,,
`;

// a and d both feed b; only d has a limit that excludes its own starting value.
const LIMIT_CSV = HEAD + `# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max,combine,formula,min,max
a,A,,main,s1,c,100,units,true,,2,,,,
d,D,,main,s2,c,100,units,,,,,,,60
e,E,,main,s3,c,100,units,,,,,"d",,

# SECTION: edges
from,to,effect,elasticity,description
a,d,increases,,
d,e,increases,,
`;

// A gate: g is min(scarce, plenty). `plenty` can never move it.
const GATE_CSV = HEAD + `# SECTION: params
id,value,description
per_unit,2,Units each

# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max,combine,formula,min,max
scarce,Scarce,,main,s1,c,10,units,true,,3,,,,
plenty,Plenty,,main,s1,c,100,units,true,,3,,,,
g,Gated,,main,s2,c,20,units,,,,,"min(scarce * per_unit, plenty * per_unit)",,
tail,Tail,,main,s3,c,20,units,,,,,,,

# SECTION: edges
from,to,effect,elasticity,description
scarce,g,enables,,
plenty,g,enables,,
g,tail,increases,,
`;

describe("cause attribution", () => {
  it("blames the box whose own formula drifted, not the box downstream of it", () => {
    expect(loadDataFromCsv(CASCADE_CSV)).toBe(true);

    // b's formula works out to 150 against a declared 50; c reads b.
    const drift = state.loadErrors.filter((f) => f.kind === REST_DRIFT);
    expect(drift.map((f) => f.boxId).sort()).toEqual(["b", "c"]);

    const bDrift = drift.find((f) => f.boxId === "b")!;
    const cDrift = drift.find((f) => f.boxId === "c")!;
    expect(bDrift.causedBy).toBeUndefined();   // its own doing
    expect(cDrift.causedBy).toBe("b");         // somebody else's, arriving
  });

  it("groups the consequence under its cause rather than giving it a card", () => {
    loadDataFromCsv(CASCADE_CSV);
    const summary = groupFindings(state.loadErrors);

    expect(summary.groups.map((g) => g.boxId)).toEqual(["b"]);
    expect(summary.groups[0].consequences.map((f) => f.boxId)).toEqual(["c"]);
    expect(summary.total).toBe(2);
    expect(summary.consequenceCount).toBe(1);
  });

  it("blames a limit that excludes the box's own starting value", () => {
    expect(loadDataFromCsv(LIMIT_CSV)).toBe(true);
    expect(causes().map((f) => f.boxId)).toContain("d");
    expect(consequences().map((f) => f.boxId)).toEqual(["e"]);
  });

  it("orders causes before consequences", () => {
    loadDataFromCsv(CASCADE_CSV);
    const firstConsequence = state.loadErrors.findIndex((f) => !!f.causedBy);
    const lastCause = state.loadErrors.map((f) => !f.causedBy).lastIndexOf(true);
    expect(lastCause).toBeLessThan(firstConsequence);
  });

  it("leaves a drifting ring with no way out standing on its own", () => {
    // Every box in a ring has a drifting input, so none is a cause by the local
    // test. Rather than pick one arbitrarily, they stay unattributed.
    const findings = [
      finding(REST_DRIFT, "wrong", "x drifts", { boxId: "x" }),
      finding(REST_DRIFT, "wrong", "y drifts", { boxId: "y" }),
    ];
    // No map is loaded for these ids, so readsFrom() sees no inputs and both
    // read as causes — the safe direction: never silently swallow a finding.
    attributeFindings(findings);
    expect(findings.every((f) => !f.causedBy)).toBe(true);
  });

  it("says nothing about a healthy map", () => {
    const clean = HEAD + `# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max,combine,formula,min,max
a,A,,main,s1,c,100,units,true,,2,,,,
b,B,,main,s2,c,100,units,,,,,,,

# SECTION: edges
from,to,effect,elasticity,description
a,b,increases,,
`;
    expect(loadDataFromCsv(clean)).toBe(true);
    expect(state.loadErrors).toEqual([]);
    expect(groupFindings(state.loadErrors).groups).toEqual([]);
  });

  it("attributes a long cascade without walking the chain once per finding", () => {
    const nodeCount = 8_000;
    setNodes(Array.from({ length: nodeCount }, (_, nodeIndex) => ({
      id: "cascade_" + nodeIndex,
      label: "Cascade " + nodeIndex,
      description: "",
      stream: "main",
      stage: "s1",
      category: "c",
      categoryIds: ["c"],
      primaryCategories: ["c"],
      secondaryCategories: [],
    })) as never);
    setEdges(Array.from({ length: nodeCount - 1 }, (_, edgeIndex) => ({
      id: "cascade_edge_" + edgeIndex,
      from: "cascade_" + edgeIndex,
      to: "cascade_" + (edgeIndex + 1),
      effect: "increases",
      style: "solid",
    })) as never);
    rebuildIndexes();
    const findings = Array.from({ length: nodeCount }, (_, nodeIndex) =>
      finding(REST_DRIFT, "wrong", "drift", { boxId: "cascade_" + nodeIndex }));

    const startedAt = performance.now();
    attributeFindings(findings);
    const elapsedMilliseconds = performance.now() - startedAt;

    expect(findings.find(candidate => candidate.boxId === "cascade_7999")?.causedBy)
      .toBe("cascade_0");
    expect(elapsedMilliseconds).toBeLessThan(1_000);
  });
});

describe("the sensitivity sweep", () => {
  beforeEach(() => {
    expect(loadDataFromCsv(GATE_CSV)).toBe(true);
    invalidateSweep();
  });

  it("reports one row per adjustable input, furthest reach first", () => {
    const sweep = runSweep();
    expect(sweep.rows.map((r) => r.id)).toEqual(["scarce", "plenty"]);
    expect(sweep.rows[0].reach).toBeGreaterThan(sweep.rows[1].reach);
  });

  it("finds the input that moves nothing, and names what is short", () => {
    const exceptions = sweepExceptions(runSweep());
    const dead = exceptions.find((e) => e.kind === "moves-nothing" && e.boxId === "plenty");
    expect(dead).toBeDefined();
    expect(dead!.gate).toBeDefined();
    expect(dead!.gate!.boxId).toBe("g");

    // Two arms; the smaller one binds, and it is the one `plenty` is NOT on.
    const arms = dead!.gate!.arms;
    expect(arms).toHaveLength(2);
    const binding = arms.filter((a) => a.binding);
    expect(binding).toHaveLength(1);
    expect(binding[0].value).toBe(20);          // scarce 10 × 2
    expect(binding[0].text).toMatch(/Scarce/);
  });

  it("leaves the live sliders and the live values exactly as it found them", () => {
    state.userOverrides = { scarce: 1.5 };
    // recomputeValues via the loader path already ran; take a copy to compare.
    const before = { ...state.userOverrides };
    runSweep();
    expect(state.userOverrides).toEqual(before);
  });

  it("measures against where the map rests, not against the declared value", () => {
    // b is declared at 50 and rests at 150 — a standing drift of +200% that
    // would swamp every row if the sweep subtracted the declared value.
    expect(loadDataFromCsv(CASCADE_CSV)).toBe(true);
    invalidateSweep();
    const sweep = runSweep();
    const row = sweep.rows.find((r) => r.id === "a")!;
    for (const move of row.moves) {
      // A 10% nudge on `a` through a strength of 0.25 moves things by a couple
      // of percent. Anything near +200% would be the drift leaking in.
      expect(Math.abs(move.pct)).toBeLessThan(20);
    }
  });

  it("caches until the map changes", () => {
    const first = currentSweep();
    expect(currentSweep()).toBe(first);        // same object, no re-solve
    loadDataFromCsv(GATE_CSV);                  // a new map invalidates it
    expect(currentSweep()).not.toBe(first);
  });

  it("knows when there is nothing to sweep", () => {
    const noInputs = HEAD + `# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max,combine,formula,min,max
a,A,,main,s1,c,100,units,,,,,,,
b,B,,main,s2,c,100,units,,,,,,,

# SECTION: edges
from,to,effect,elasticity,description
a,b,increases,,
`;
    expect(loadDataFromCsv(noInputs)).toBe(true);
    expect(sweepIsPossible()).toBe(false);
  });

  it("counts a box no input can reach", () => {
    const stranded = HEAD + `# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max,combine,formula,min,max
a,A,,main,s1,c,100,units,true,,2,,,,
b,B,,main,s2,c,100,units,,,,,,,
lonely,Lonely,,main,s3,c,100,units,,,,,,,

# SECTION: edges
from,to,effect,elasticity,description
a,b,increases,,
`;
    expect(loadDataFromCsv(stranded)).toBe(true);
    invalidateSweep();
    const sweep = runSweep();
    expect(sweep.unreached.map((u) => u.id)).toEqual(["lonely"]);
    expect(sweepExceptions(sweep).some((e) => e.title.match(/no input can reach/))).toBe(true);
  });
});

// Two claims that look like one: "nothing moved this box" is measured, and
// "no input can reach this box" is structural. Everything below is a box the
// first is true of and the second is not.
describe("a box nothing moves", () => {
  const strandedPair = HEAD + `# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max,combine,formula,min,max
a,A,,main,s1,c,100,units,true,,2,,,,
b,B,,main,s2,c,100,units,,,,,,,
lonely,Lonely,,main,s3,c,100,units,,,,,,,
adrift,Adrift,,main,s3,c,100,units,,,,,,,

# SECTION: edges
from,to,effect,elasticity,description
a,b,increases,,
`;

  it("gets a card of its own rather than a tally", () => {
    expect(loadDataFromCsv(strandedPair)).toBe(true);
    invalidateSweep();
    const unreachable = sweepExceptions(runSweep()).filter((e) => e.kind === "unreachable");

    // One per box, each naming its own box — so each can be opened, answered
    // and settled on its own.
    expect(unreachable.map((e) => e.boxId).sort()).toEqual(["adrift", "lonely"]);
    for (const exception of unreachable) {
      expect(exception.title).toMatch(/no input can reach it/);
      expect(exception.title).toContain(nodeById[exception.boxId].label);
    }
  });

  it("reaches the queue as one item per box, with ids that do not collide", () => {
    expect(loadDataFromCsv(strandedPair)).toBe(true);
    invalidateSweep();
    const rows = reviewQueue(solverGeneration())
      .filter((item) => item.id.startsWith("input:unreachable:"));
    expect(rows.map((item) => item.boxId).sort()).toEqual(["adrift", "lonely"]);
    expect(new Set(rows.map((item) => item.id)).size).toBe(2);
  });

  it("closes when the box carries a verdict, and reopens when the box changes", () => {
    expect(loadDataFromCsv(strandedPair)).toBe(true);
    state.reviews = {};
    invalidateSweep();
    const unreachableRows = () => reviewQueue(solverGeneration())
      .filter((item) => item.id.startsWith("input:unreachable:"));

    expect(unreachableRows().map((item) => item.settled)).toEqual([false, false]);

    // The ordinary verdict, on the box itself — nothing bespoke to this list.
    recordVerdict("lonely", "agreed", { reviewer: "Ann Lee", date: "2026-09-03" });
    const settledRow = unreachableRows().find((item) => item.boxId === "lonely")!;
    expect(settledRow.settled).toBe(true);
    expect(settledRow.why).toBe("Agreed");
    // The other box is a separate decision and is untouched by this one.
    expect(unreachableRows().find((item) => item.boxId === "adrift")!.settled).toBe(false);

    // And the sign-off expires with the thing it signed off: the fingerprint
    // covers the box's own rule and limits as well as what feeds it.
    nodeById.lonely.maxValue = 5;
    expect(unreachableRows().find((item) => item.boxId === "lonely")!.settled).toBe(false);
  });

  it("is not flagged when a gate is what holds it back", () => {
    // hold = min(short × 0.5, pump × 0.5), both arms level. Neither input can
    // move it, and `far` sits downstream of it — both are reached, and neither
    // is missing a link.
    expect(loadDataFromCsv(FORMULA_GATE_CSV)).toBe(true);
    invalidateSweep();
    const sweep = runSweep();
    expect(sweep.unreached.map((u) => u.id).sort()).toEqual(["far", "hold"]);

    const verdicts = classifyUnreached(sweep);
    expect(verdicts.get("hold")).toMatchObject({ kind: "held", why: "gate", boxId: "hold" });
    expect(verdicts.get("far")).toMatchObject({ kind: "held", why: "gate", boxId: "hold" });
    expect(sweepExceptions(sweep).filter((e) => e.kind === "unreachable")).toEqual([]);
    expect(sweepExceptions(sweep).filter((e) => e.kind === "inert")).toEqual([]);
  });

  it("is not flagged when a limit is already binding", () => {
    // d is declared at 100 with a ceiling of 60, so it rests on the ceiling and
    // a nudge cannot show up in it — nor in e, which reads it.
    expect(loadDataFromCsv(LIMIT_CSV)).toBe(true);
    invalidateSweep();
    const sweep = runSweep();
    expect(sweep.unreached.map((u) => u.id).sort()).toEqual(["d", "e"]);

    const verdicts = classifyUnreached(sweep);
    expect(verdicts.get("d")).toMatchObject({ kind: "held", why: "limit", boxId: "d" });
    expect(verdicts.get("e")).toMatchObject({ kind: "held", why: "limit", boxId: "d" });
    expect(sweepExceptions(sweep).some((e) => e.kind === "unreachable")).toBe(false);
  });

  it("is not flagged when it moves by less than the map draws", () => {
    // A link so weak that a 10% nudge lands as a hundredth of a percent: real
    // movement, below the threshold the map draws at. Reached is reached.
    const faint = HEAD + `# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max,combine,formula,min,max
a,A,,main,s1,c,100,units,true,,2,,,,
whisper,Whisper,,main,s2,c,100,units,,,,,,,

# SECTION: edges
from,to,effect,elasticity,description
a,whisper,increases,0.001,
`;
    expect(loadDataFromCsv(faint)).toBe(true);
    invalidateSweep();
    const sweep = runSweep();
    expect(sweep.unreached.map((u) => u.id)).toEqual(["whisper"]);
    expect(sweep.faint).toEqual(["whisper"]);
    expect(classifyUnreached(sweep).get("whisper")).toEqual({ kind: "held", why: "faint" });
    expect(sweepExceptions(sweep).some((e) => e.boxId === "whisper")).toBe(false);
  });

  it("gives the finding to the box a change stopped at, not to the ones behind it", () => {
    // Four weak links in a row. The change fades out somewhere along the chain;
    // whichever box it dies at, the boxes downstream of that one are bystanders
    // and none of them may collect a card of its own.
    const chain = HEAD + `# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max,combine,formula,min,max
a,A,,main,s1,c,100,units,true,,2,,,,
w,W,,main,s2,c,100,units,,,,,,,
x,X,,main,s2,c,100,units,,,,,,,
y,Y,,main,s3,c,100,units,,,,,,,
tail,Tail,,main,s3,c,100,units,,,,,,,

# SECTION: edges
from,to,effect,elasticity,description
a,w,increases,0.01,
w,x,increases,0.01,
x,y,increases,0.01,
y,tail,increases,0.01,
`;
    expect(loadDataFromCsv(chain)).toBe(true);
    invalidateSweep();
    const sweep = runSweep();
    expect(sweep.unreached.map((u) => u.id)).toContain("tail");
    expect(classifyUnreached(sweep).get("tail")).toMatchObject({ kind: "held" });
    expect(sweepExceptions(sweep).some((e) => e.boxId === "tail")).toBe(false);
  });

  it("still says so when a route exists and nothing at all explains the silence", () => {
    // A link with no strength: `dead` is reached on paper and moves by nothing.
    // Not "no input can reach it" — a different sentence, and its own card.
    const noStrength = HEAD + `# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max,combine,formula,min,max
a,A,,main,s1,c,100,units,true,,2,,,,
dead,Dead,,main,s2,c,100,units,,,,,,,

# SECTION: edges
from,to,effect,elasticity,description
a,dead,increases,0,
`;
    expect(loadDataFromCsv(noStrength)).toBe(true);
    invalidateSweep();
    const sweep = runSweep();
    const inert = sweepExceptions(sweep).filter((e) => e.kind === "inert");
    expect(inert.map((e) => e.boxId)).toEqual(["dead"]);
    expect(inert[0].title).not.toMatch(/reach/);
    expect(inert[0].detail).toContain("A");
  });
});

describe("findings carry enough to act on", () => {
  it("names the box on every finding that is about one", () => {
    loadDataFromCsv(CASCADE_CSV);
    const aboutABox = state.loadErrors.filter((f) => f.kind === REST_DRIFT);
    expect(aboutABox.length).toBeGreaterThan(0);
    for (const f of aboutABox) {
      expect(f.boxId).toBeTruthy();
      expect(NODES.some((n) => n.id === f.boxId)).toBe(true);
    }
  });

  it("keeps a fatal missing section as a finding, not a bare string", () => {
    expect(loadDataFromCsv("# SECTION: streams\nid,label,short,color\nmain,Main,M,#888")).toBe(false);
    expect(kinds()).toContain("section-missing");
    expect(state.loadErrors[0].severity).toBe("ignored");
  });
});
