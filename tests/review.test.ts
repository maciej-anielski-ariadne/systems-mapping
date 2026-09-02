// =============================================================================
// REVIEW — cause attribution, and the sensitivity sweep
// -----------------------------------------------------------------------------
// The two pieces of logic behind the Review panel, tested against maps small
// enough to reason about by hand. Both were designed against a ninety-box map;
// these fixtures reproduce the same shapes in six boxes.
// =============================================================================
import { describe, it, expect, beforeEach } from "vitest";
import { loadDataFromCsv, rebuildIndexes } from "../assets/js/06-data-loader";
import { state, NODES, setEdges, setNodes } from "../assets/js/03-state";
import {
  attributeFindings,
  groupFindings,
  runSweep,
  sweepExceptions,
  sweepIsPossible,
  invalidateSweep,
  currentSweep,
  REST_DRIFT,
  finding,
} from "../assets/js/22-review";
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
