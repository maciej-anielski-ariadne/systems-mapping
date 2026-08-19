// =============================================================================
// PATHWAY ATLAS ENGINE
// -----------------------------------------------------------------------------
// tools/pathway-atlas.html is a standalone page, not part of the app, but the
// engine inside it makes two claims strong enough to be worth pinning:
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
// The engine is read out of the HTML rather than duplicated, so there is only
// ever one copy of it to be wrong.
// =============================================================================
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(resolve(root, "tools/pathway-atlas.html"), "utf8");

const block = /\/\/ ATLAS-ENGINE-START[^\n]*\n([\s\S]*?)\/\/ ATLAS-ENGINE-END/.exec(html);
if (!block) throw new Error("tools/pathway-atlas.html no longer has an ATLAS-ENGINE-START block");

const engine = new Function(
  block[1] + "\nreturn { buildGraph, buildAtlas, detectLanes, END, familyLabel };",
)() as {
  buildGraph: (map: any) => any;
  buildAtlas: (g: any, start: string, opts?: any) => any;
  detectLanes: (nodes: any[], edges: any[], opts?: any) => any;
  END: string;
  familyLabel: (key: string) => string;
};

const E = (from: string, to: string, elasticity = 0.3) => ({
  from, to, effect: elasticity < 0 ? "decreases" : "increases", elasticity,
});
const N = (id: string, label: string) => ({ id, label, stream: "", category: "", controllable: false, direction: "" });

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
function readings(atlas: any): string[] {
  const out: string[] = [], path: string[] = [];
  const walk = (n: string) => {
    if (n === engine.END) { out.push(path.join(">")); return; }
    path.push(n);
    for (const s of atlas.succ.get(n)) walk(s);
    path.pop();
  };
  walk(atlas.start);
  return out.sort();
}

// The same thing read off the on-screen tree, following a "joins here" into
// the stretch it points at. These two agreeing is what "complete" means.
function fromTree(atlas: any): string[] {
  const expand = (seq: any[], depth = 0): string[][] => {
    if (depth > 60) throw new Error("expansion too deep");
    let acc: string[][] = [[]];
    for (const item of seq) {
      if (item.kind === "box") { acc = acc.map((p) => p.concat(item.id)); continue; }
      const subs = item.kind === "join"
        ? expand(atlas.tails.get(item.id), depth + 1)
        : item.alts.flatMap((a: any) => expand(a.seq, depth + 1));
      const next: string[][] = [];
      for (const p of acc) for (const s of subs) next.push(p.concat(s));
      acc = next;
    }
    return acc;
  };
  return expand(atlas.tree).map((p) => p.join(">")).sort();
}

function boxesShown(atlas: any): Set<string> {
  const seen = new Set<string>();
  const walk = (seq: any[]) => {
    for (const it of seq) {
      if (it.kind === "choice") { for (const a of it.alts) walk(a.seq); continue; }
      for (const b of atlas.nodes.get(it.id).boxes) seen.add(b);
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
    const seizure = lanes.families.find((f: any) => f.key.endsWith("Seizure"));
    expect(seizure?.members).toHaveLength(4);
    expect(seizure.members.map((m: any) => m.token)).toEqual(
      expect.arrayContaining(["Cannabis", "Class A Drug"]),
    );
  });

  it("needs at least three members, and the threshold moves", () => {
    expect(lanes.families.every((f: any) => f.members.length >= 3)).toBe(true);
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
