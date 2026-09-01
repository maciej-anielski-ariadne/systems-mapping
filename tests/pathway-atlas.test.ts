// =============================================================================
// PATHWAY ATLAS ENGINE
// -----------------------------------------------------------------------------
// The engine behind "everything downstream of this box" makes two claims strong
// enough to be worth pinning:
//
//   complete  every pathway in the map is one of the readings it shows, so an
//             impact cannot be missed however far it meanders
//   sound     with grouping set to strict, every step it shows is a step the
//             map actually contains
//
// Both are checked here against brute force on maps small enough to enumerate,
// and the awkward cases are deliberate: lane values several words long, lane
// values of differing length in one family, decoy families that must not be
// grouped, and feedback loops.
//
// These run against assets/js/20-atlas-engine.ts, the engine the app itself
// uses.
// =============================================================================
import { describe, expect, expectTypeOf, it } from "vitest";
import { buildGraph, buildAtlas, detectLanes, END, familyLabel, strands } from "../assets/js/20-atlas-engine";
import type {
  AtlasGraphEdge,
  AtlasGraphNode,
  AtlasResult,
  AtlasSequence,
  AtlasStrandResult,
} from "../assets/js/20-atlas-engine";

const engine = { buildGraph, buildAtlas, detectLanes, END, familyLabel, strands };

const E = (from: string, to: string, elasticity = 0.3) => ({
  from, to, effect: elasticity < 0 ? "decreases" : "increases", elasticity,
});
const N = (id: string, label: string) => ({ id, label, stream: "", category: "", controllable: false, direction: "" });

describe("public Atlas type contract", () => {
  interface AtlasContractNode extends AtlasGraphNode {
    label: string;
    sourceReference: string;
  }

  interface AtlasContractEdge extends AtlasGraphEdge {
    evidenceReference: string;
  }

  it("preserves application-specific graph fields through the engine boundary", () => {
    const contractNodes: AtlasContractNode[] = [
      { id: "origin", label: "Origin", sourceReference: "source-a" },
      { id: "outcome", label: "Outcome", sourceReference: "source-b" },
    ];
    const contractEdges: AtlasContractEdge[] = [
      {
        from: "origin",
        to: "outcome",
        elasticity: 0.5,
        evidenceReference: "evidence-a",
      },
    ];

    const graph = buildGraph({ nodes: contractNodes, edges: contractEdges, name: "contract" });
    const atlas = buildAtlas(graph, "origin");
    const strandResult = strands(atlas);

    expectTypeOf(graph.byId.get("origin")).toEqualTypeOf<AtlasContractNode | undefined>();
    expectTypeOf(graph.out.get("origin")).toEqualTypeOf<AtlasContractEdge[] | undefined>();
    expectTypeOf(atlas).toEqualTypeOf<AtlasResult<AtlasContractEdge>>();
    expectTypeOf(atlas.tree).toEqualTypeOf<AtlasSequence>();
    expectTypeOf(strandResult).toEqualTypeOf<AtlasStrandResult>();

    expect(graph.out.get("origin")?.[0].evidenceReference).toBe("evidence-a");
    expect(atlas.pathways).toBe(1n);
    expect(strandResult.list).toHaveLength(1);
    expect(() => buildAtlas(graph, "missing-start")).toThrow(
      'Cannot build an Atlas from unknown start box "missing-start".',
    );
  });
});

// Multi-word lane values ("Cat A" / "Cat B"), one family whose members' varying
// parts are one and three words long ("Cannabis" / "Class A Drug"), and two
// decoys: a sequence that looks like a family, and a coincidental noun pair.
function lanesMap() {
  const nodes = [N("policy", "Enforcement Policy"), N("funding", "Operational Funding"), N("outcome", "Harm Reduction")];
  const edges: ReturnType<typeof E>[] = [];
  for (const c of ["Cat A", "Cat B", "Cat C", "Cat D"]) {
    nodes.push(N(c + "|t", c + " Targets"), N(c + "|r", c + " Referrals"), N(c + "|o", c + " Offenders Charged"));
    edges.push(E("policy", c + "|t"), E("funding", c + "|t"), E(c + "|t", c + "|r"),
               E(c + "|r", c + "|o"), E(c + "|o", "outcome"));
  }
  for (const d of ["Cannabis", "Cocaine", "Class A Drug", "Heroin"]) {
    nodes.push(N(d + "|s", d + " Seizure"), N(d + "|q", d + " Testing"));
    edges.push(E("policy", d + "|s"), E(d + "|s", d + "|q"), E(d + "|q", "outcome"));
  }
  nodes.push(N("pick", "Pick rate"), N("damage", "Damage rate"));
  edges.push(E("funding", "pick"), E("pick", "outcome"), E("policy", "damage"), E("damage", "outcome"));
  nodes.push(N("s1", "Import Stage"), N("s2", "Seizure Stage"), N("s3", "Testing Stage"));
  edges.push(E("policy", "s1"), E("s1", "s2"), E("s2", "s3"), E("s3", "outcome"));
  return { nodes, edges, name: "lanes" };
}

function cyclicMap() {
  return {
    nodes: [N("a", "Enforcement"), N("b", "Displacement"), N("c", "Street Price"),
            N("d", "Demand"), N("e", "Harm")],
    edges: [E("a", "b"), E("b", "c"), E("c", "a"), E("b", "d"), E("d", "c"), E("c", "e")],
    name: "cyclic",
  };
}

// Enough cross-lane wiring that grouping by name alone would fold a perfectly
// ordinary forward path into a feedback loop nobody drew.
function crossLinkedMap() {
  const nodes = [N("start", "Budget"), N("end", "Harm")];
  const edges: ReturnType<typeof E>[] = [];
  const lanes = ["Cannabis", "Cocaine", "Heroin", "Cat A"];
  const roles = ["Import", "Seizure", "Testing", "Charging"];
  for (const lane of lanes) for (const role of roles) nodes.push(N(lane + "|" + role, lane + " " + role));
  for (const lane of lanes) {
    for (let i = 0; i + 1 < roles.length; i++) edges.push(E(lane + "|" + roles[i], lane + "|" + roles[i + 1]));
    edges.push(E("start", lane + "|" + roles[0]), E(lane + "|" + roles[3], "end"));
  }
  // Late in one lane, back to the beginning of the NEXT one — and stopping
  // short of wrapping round, so the map itself stays acyclic. Fold the four
  // Testings into one "◇ Testing" and the four Imports into one "◇ Import",
  // though, and this reads as a feedback loop nobody drew.
  for (let i = 0; i + 1 < lanes.length; i++) {
    nodes.push(N("sh" + i, "Shared Factor " + (i + 1)));
    edges.push(E(lanes[i] + "|Testing", "sh" + i), E("sh" + i, lanes[i + 1] + "|Import"));
  }
  return { nodes, edges, name: "cross-linked" };
}

// Every reading the atlas stands for, by walking the condensed structure.
function readings(atlas: Pick<AtlasResult, "start" | "succ">): string[] {
  const out: string[] = [], path: string[] = [];
  const walk = (n: string) => {
    if (n === engine.END) { out.push(path.join(">")); return; }
    path.push(n);
    const successors = atlas.succ.get(n);
    if (!successors) throw new Error("Reading reached an element without successor data: " + n);
    for (const s of successors) walk(s);
    path.pop();
  };
  walk(atlas.start);
  return out.sort();
}

// The same thing read off the on-screen tree, following a "joins here" into
// the stretch it points at. These two agreeing is what "complete" means.
function fromTree(atlas: Pick<AtlasResult, "tails" | "tree">): string[] {
  const expand = (seq: AtlasSequence, depth = 0): string[][] => {
    if (depth > 60) throw new Error("expansion too deep");
    let acc: string[][] = [[]];
    for (const item of seq) {
      if (item.kind === "box") { acc = acc.map((p) => p.concat(item.id)); continue; }
      const subs = item.kind === "join"
        ? expand(atlas.tails.get(item.id) || [], depth + 1)
        : item.alts.flatMap(alternative => expand(alternative.seq, depth + 1));
      const next: string[][] = [];
      for (const p of acc) for (const s of subs) next.push(p.concat(s));
      acc = next;
    }
    return acc;
  };
  return expand(atlas.tree).map((p) => p.join(">")).sort();
}

function boxesShown(atlas: Pick<AtlasResult, "nodes" | "tree">): Set<string> {
  const seen = new Set<string>();
  const walk = (seq: AtlasSequence) => {
    for (const it of seq) {
      if (it.kind === "choice") { for (const a of it.alts) walk(a.seq); continue; }
      const node = atlas.nodes.get(it.id);
      if (!node) throw new Error("Atlas tree references an unknown element: " + it.id);
      for (const b of node.boxes) seen.add(b);
    }
  };
  walk(atlas.tree);
  return seen;
}

describe("name grouping", () => {
  const map = lanesMap();
  const lanes = engine.detectLanes(map.nodes, map.edges);

  it("groups on a varying part several words long", () => {
    expect([...lanes.laneValues]).toEqual(expect.arrayContaining(["Cat A", "Cat B", "Cat C"]));
  });

  it("keeps one family together when the varying parts differ in length", () => {
    const seizure = lanes.families.find(family => family.key.endsWith("Seizure"));
    expect(seizure?.members).toHaveLength(4);
    if (!seizure) throw new Error("Expected the Seizure lane family");
    expect(seizure.members.map(member => member.token)).toEqual(
      expect.arrayContaining(["Cannabis", "Class A Drug"]),
    );
  });

  it("needs at least three members, and the threshold moves", () => {
    expect(lanes.families.every(family => family.members.length >= 3)).toBe(true);
    const strict = engine.detectLanes(map.nodes, map.edges, { minMembers: 5 });
    expect(strict.families.length).toBeLessThan(lanes.families.length);
  });

  it("rejects a sequence dressed up as a family", () => {
    // Import Stage → Seizure Stage → Testing Stage are linked to each other,
    // so they are steps in a chain, not alternatives to one another.
    expect(lanes.roleOf.get("s1")).toBe("N:s1");
    expect(lanes.roleOf.get("s2")).toBe("N:s2");
  });

  it("rejects a coincidental pair of names", () => {
    expect(lanes.roleOf.get("pick")).toBe("N:pick");
    expect(lanes.roleOf.get("damage")).toBe("N:damage");
  });

  it("can be turned off", () => {
    expect(engine.detectLanes(map.nodes, map.edges, { minMembers: 0 }).families).toHaveLength(0);
  });
});

describe("complete: nothing is missed", () => {
  for (const [name, map, start] of [
    ["lane map", lanesMap(), "policy"],
    ["cyclic map", cyclicMap(), "a"],
    ["cross-linked map", crossLinkedMap(), "start"],
  ] as const) {
    for (const grouping of ["loose", "strict"] as const) {
      it(`${name}, ${grouping}: the tree holds exactly the readings the structure does`, () => {
        const G = engine.buildGraph(map);
        const atlas = engine.buildAtlas(G, start, { grouping });
        expect(fromTree(atlas)).toEqual(readings(atlas));
        expect(atlas.shapes).toBe(BigInt(readings(atlas).length));
      });

      it(`${name}, ${grouping}: every reachable box appears`, () => {
        const G = engine.buildGraph(map);
        const atlas = engine.buildAtlas(G, start, { grouping });
        const shown = boxesShown(atlas);
        expect([...atlas.scope].filter((id: string) => !shown.has(id))).toEqual([]);
      });
    }
  }
});

describe("sound: strict grouping shows only steps the map contains", () => {
  for (const [name, map, start] of [
    ["lane map", lanesMap(), "policy"],
    ["cross-linked map", crossLinkedMap(), "start"],
  ] as const) {
    it(`${name}: every member of a group takes every step shown from it`, () => {
      const atlas = engine.buildAtlas(engine.buildGraph(map), start, { grouping: "strict" });
      expect(atlas.partialSteps).toBe(0);
      expect(atlas.shapes).toBeLessThanOrEqual(atlas.pathways);
    });
  }
});

describe("feedback loops", () => {
  it("collapses a loop to one element instead of an infinite family", () => {
    const atlas = engine.buildAtlas(engine.buildGraph(cyclicMap()), "a");
    expect(atlas.loops).toHaveLength(1);
    expect(atlas.loops[0].boxes.sort()).toEqual(["a", "b", "c", "d"]);
    expect(atlas.shapes).toBe(1n);
  });

  it("never invents a loop the map does not contain", () => {
    // Grouping by name alone turns this map into one giant false loop.
    const map = crossLinkedMap();
    const atlas = engine.buildAtlas(engine.buildGraph(map), "start");
    expect(atlas.loops).toHaveLength(0);
    expect(atlas.shapes).toBeGreaterThan(0n);
  });
});

describe("what is inside a feedback loop", () => {
  // Enforcement raises Displacement raises Street Price raises Enforcement —
  // three positive links, so a nudge comes back amplified. Street Price also
  // lowers User Demand, which raises Street Price back: one negative link, so
  // that one settles instead.
  function twoLoops() {
    const nodes = [N("a", "Enforcement"), N("b", "Displacement"), N("c", "Street Price"),
                   N("d", "User Demand"), N("e", "Harm")];
    const edges = [E("a", "b"), E("b", "c"), E("c", "a"),
                   E("c", "d", -0.5), E("d", "c", 0.4), E("c", "e")];
    return { nodes, edges, name: "two loops" };
  }

  const atlas = engine.buildAtlas(engine.buildGraph(twoLoops()), "a");
  const tangle = atlas.loops[0].tangles[0];

  it("finds both loops in one tangle", () => {
    expect(atlas.loops).toHaveLength(1);
    expect(tangle.loops).toHaveLength(2);
    expect(tangle.independent).toBe(2);
  });

  it("reads polarity off the link signs", () => {
    const byLen = Object.fromEntries(tangle.loops.map(loop => [loop.cycle.length, loop]));
    expect(byLen[2].reinforcing).toBe(false);   // one negative link — balancing
    expect(byLen[3].reinforcing).toBe(true);    // none — reinforcing
  });

  it("reads gain off the link magnitudes", () => {
    const byLen = Object.fromEntries(tangle.loops.map(loop => [loop.cycle.length, loop]));
    expect(byLen[2].gain).toBeCloseTo(0.5 * 0.4, 10);
    expect(byLen[3].gain).toBeCloseTo(0.3 ** 3, 10);
  });

  it("orders them strongest first", () => {
    expect(tangle.loops[0].gain).toBeGreaterThanOrEqual(tangle.loops[1].gain);
    expect(atlas.feedback[0].gain).toBeGreaterThanOrEqual(atlas.feedback[1].gain);
  });

  it("leaves no box in the tangle without a loop", () => {
    const covered = new Set(tangle.loops.flatMap(loop => loop.cycle));
    expect([...tangle.boxes].filter((b: string) => !covered.has(b))).toEqual([]);
  });

  it("counts the ways in and out rather than hiding them", () => {
    expect(tangle.waysOut).toContain("c");      // Street Price is what reaches Harm
    expect(tangle.boxes).toHaveLength(4);
  });

  it("names the tangle without reciting its members", () => {
    expect(atlas.loops[0].label).not.toContain("Displacement");
    expect(atlas.loops[0].label).toMatch(/tangle|⇄/);
  });

  it("takes the stronger link when two links join the same pair, and says so", () => {
    // Two links from a to b that disagree about sign: whichever is listed first
    // would otherwise decide the polarity of every loop through them.
    const nodes = [N("a", "One"), N("b", "Two")];
    const edges = [E("a", "b", 0.2), E("a", "b", -0.9), E("b", "a", 0.5)];
    const t = engine.buildAtlas(engine.buildGraph({ nodes, edges, name: "dup" }), "a")
      .loops[0].tangles[0];
    expect(t.parallel).toBe(1);
    expect(t.contradictory).toBe(1);
    expect(t.loops[0].gain).toBeCloseTo(0.9 * 0.5, 10);   // the stronger one
    expect(t.loops[0].reinforcing).toBe(false);           // and its sign
  });

  it("handles a box that feeds itself", () => {
    const nodes = [N("a", "One"), N("b", "Two")];
    const edges = [E("a", "a", -0.4), E("a", "b")];
    const t = engine.buildAtlas(engine.buildGraph({ nodes, edges, name: "self" }), "a")
      .loops[0].tangles[0];
    expect(t.loops).toHaveLength(1);
    expect(t.loops[0].cycle).toEqual(["a"]);
    expect(t.loops[0].reinforcing).toBe(false);
  });

  it("says nothing about feedback on a map that has none", () => {
    const flat = engine.buildAtlas(engine.buildGraph(lanesMap()), "policy");
    expect(flat.loops).toHaveLength(0);
    expect(flat.feedback).toEqual([]);
  });
});

describe("counting", () => {
  it("counts pathways exactly, without walking any of them", () => {
    const map = lanesMap();
    const atlas = engine.buildAtlas(engine.buildGraph(map), "policy");
    // policy reaches: 4 Cat chains, 4 drug chains, the Stage chain, Damage rate.
    expect(atlas.pathways).toBe(10n);
    expect(atlas.shapes).toBe(4n);   // two families of four, plus two singletons
  });

  it("reports arbitrarily large totals without overflowing", () => {
    // 30 boxes in a row, each of which may be taken or skipped: 2^29 pathways.
    const nodes = Array.from({ length: 30 }, (_, i) => N("n" + i, "Step " + i));
    const edges: ReturnType<typeof E>[] = [];
    for (let i = 0; i + 1 < 30; i++) edges.push(E("n" + i, "n" + (i + 1)));
    for (let i = 0; i + 2 < 30; i++) edges.push(E("n" + i, "n" + (i + 2)));
    const atlas = engine.buildAtlas(engine.buildGraph({ nodes, edges, name: "chain" }), "n0");
    expect(atlas.pathways).toBeGreaterThan(100000n);
    expect(atlas.ms).toBeLessThan(2000);
  });
});

// A strand is one reading made concrete — start element to finish. The claim is
// that pulling them out one at a time agrees exactly with walking the whole
// tree, that they arrive shortest first, and that filtering by an element gives
// precisely the strands that pass through it.
describe("strands: one reading at a time", () => {
  const maps = [
    ["lane map", lanesMap(), "policy"],
    ["cyclic map", cyclicMap(), "a"],
    ["cross-linked map", crossLinkedMap(), "start"],
  ] as const;

  for (const [name, map, start] of maps) {
    const atlasOf = () => engine.buildAtlas(engine.buildGraph(map), start, { grouping: "strict" });

    it(`${name}: given room, it finds exactly the readings and no others`, () => {
      const atlas = atlasOf();
      const got = engine.strands(atlas, { limit: 100000 });
      expect(got.list.map((p: string[]) => p.join(">")).sort()).toEqual(readings(atlas));
      expect(BigInt(got.list.length)).toBe(atlas.shapes);
    });

    it(`${name}: they come out shortest first`, () => {
      const lens = engine.strands(atlasOf(), { limit: 100000 }).list.map((p: string[]) => p.length);
      expect(lens).toEqual([...lens].sort((a, b) => a - b));
    });

    it(`${name}: filtering by an element gives exactly the strands through it`, () => {
      const atlas = atlasOf();
      const all = engine.strands(atlas, { limit: 100000 }).list;
      for (const el of [...atlas.nodes.keys()].filter((k: string) => k !== engine.END)) {
        const want = all.filter((p: string[]) => p.includes(el)).map((p: string[]) => p.join(">")).sort();
        const got = engine.strands(atlas, { limit: 100000, through: el }).list
          .map((p: string[]) => p.join(">")).sort();
        expect(got).toEqual(want);
      }
    });
  }

  it("stops at the limit rather than walking a map it cannot hold, and says so", () => {
    const atlas = engine.buildAtlas(engine.buildGraph(crossLinkedMap()), "start", { grouping: "strict" });
    const got = engine.strands(atlas, { limit: 2 });
    expect(got.list.length).toBe(2);
    expect(got.truncated).toBe(true);
  });
});
