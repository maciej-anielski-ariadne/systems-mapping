// =============================================================================
// PATHWAY ATLAS — THE ENGINE
// -----------------------------------------------------------------------------
// Everything downstream of one box, as a structure small enough to look at.
//
// The move it is built on: never enumerate pathways. The complete set of
// pathways from a box is already written down in the graph — it IS the subgraph
// that box can reach. Enumerating it turns a linear amount of information into
// an exponential amount of paper, so we never do. Each step rewrites that
// subgraph into a smaller one standing for the same pathways, and the counts
// come from arithmetic over the structure rather than from tallying things on
// the way past.
//
// Nothing here touches the DOM, the app's state, or the map's filters: it takes
// a graph and a start box and returns an atlas. 21-atlas-view.ts draws it.
//
// This is the engine prototyped in tools/pathway-atlas.html. That file stays as
// the standalone version (drop a CSV in, no app needed); THIS is the one the
// app runs, and the one tests/pathway-atlas.test.ts reads.
// =============================================================================

// ===========================================================================
// PATHWAY ATLAS ENGINE
// ---------------------------------------------------------------------------
// The move this is built on: never enumerate pathways.
//
// The complete set of pathways from a box is already written down in the graph
// itself — it is the subgraph of everything that box can reach. Enumerating it
// turns a linear amount of information into an exponential amount of paper. So
// we never do. Each step below rewrites that subgraph into a smaller one that
// stands for the same pathways, and the counts come from arithmetic over the
// structure rather than from tallying things as we walk past them.
//
//   scope      keep only what the start box can reach
//   loops      contract each feedback loop to a single element
//   name       propose a grouping from the box names
//   refine     split any group whose members do not behave alike
//   decompose  cut the result into single-entry / single-exit regions
//   count      exact totals by dynamic programming (BigInt)
//
// Nothing is sampled, capped, budgeted or truncated at any point, so "every
// pathway is represented" is a property of the construction rather than a hope.
//
// TWO GUARANTEES, and the refine step is what buys the second one:
//
//   complete  every pathway in the map is one of the readings on screen, so an
//             impact cannot be missed however far it meanders
//   sound     every reading on screen is a pathway that really exists
//
// Grouping by name alone gives the first and quietly breaks the second. Fold
// "Cannabis Seizure" and "Cocaine Seizure" into one "◇ Seizure" and the page
// starts offering "Cannabis Import → ◇ Seizure → Cocaine Testing" — a sentence
// no route in the map actually says. So a proposed group is kept only while
// its members agree on which groups they lead to; where they disagree it is
// split, and that split is worth reading, because it is the map saying this is
// where the lanes stop behaving alike.
// ===========================================================================

export const SLOT = "◇";        // stands in for whatever varies between lanes
export const END = "\u0000END";      // virtual finish, so every pathway has one
export const SEP = "\u0001";                // never appears in a label

// ---------------------------------------------------------------------------
// 0. GRAPH
// ---------------------------------------------------------------------------
export function buildGraph(map: any) {
  const byId = new Map<any, any>(), out = new Map<any, any>(), inc = new Map<any, any>();
  for (const n of map.nodes) { byId.set(n.id, n); out.set(n.id, []); inc.set(n.id, []); }
  const edges: any[] = [];
  for (const e of map.edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    edges.push(e);
    out.get(e.from).push(e);
    inc.get(e.to).push(e);
  }
  return { nodes: map.nodes, edges, byId, out, inc, name: map.name || "map" };
}

export function reachableFrom(G: any, startId: any, stopAt: any) {
  const seen = new Set<any>([startId]), stack = [startId];
  while (stack.length) {
    const id = stack.pop();
    if (stopAt && id !== startId && stopAt.has(id)) continue;
    for (const e of G.out.get(id) || []) if (!seen.has(e.to)) { seen.add(e.to); stack.push(e.to); }
  }
  return seen;
}

// ---------------------------------------------------------------------------
// 1. NAME GROUPING
// ---------------------------------------------------------------------------
// A LANE is one value of a dimension the map repeats itself along — Cannabis,
// Cocaine, Cat A, Cat B. A ROLE is what a box does once its lane is stripped
// off: "Cat ◇ Targets".
//
// The family key is a PREFIX and a SUFFIX rather than one word position, so
// the varying part can run to several words and can differ in length between
// members: "Class A Drug Seizure" and "Cannabis Seizure" share the key
// (prefix "", suffix "Seizure").
//
// Four tests, because label similarity on its own invents families:
//   size       a family needs enough members to be a pattern, not a coincidence
//   adjacency  lane members are ALTERNATIVES, so none is linked to another —
//              a sequence (Import → Seizure → Testing) fails this
//   reuse      a lane value must play its part in more than one role, so a
//              single coincidental pair cannot mint a lane
//   role       members must sit in the same part of the map: what flows into
//              and out of them has to play overlapping parts
//
// Everything here is only a PROPOSAL. Step 3 checks it against behaviour.
// ---------------------------------------------------------------------------
export const LANE_DEFAULTS = {
  minMembers: 3,          // how many boxes make a family
  minTokenFamilies: 2,    // a lane value must appear in this many roles
  maxSpan: 3,             // how many words the varying part may run to
  neighbourOverlap: 0.25, // how alike members' surroundings must be
};

export const words = (s: any) => String(s).split(/\s+/).filter(Boolean);

export function candidateFamilies(nodes: any, maxSpan: any) {
  const byKey = new Map<any, any>();
  for (const n of nodes) {
    const w = words(n.label || n.id);
    for (let i = 0; i < w.length; i++) {
      for (let j = i + 1; j <= Math.min(w.length, i + maxSpan); j++) {
        const pre = w.slice(0, i), suf = w.slice(j);
        if (pre.length + suf.length === 0) continue;   // need something to anchor on
        const key = pre.join(" ") + SEP + suf.join(" ");
        let m = byKey.get(key);
        if (!m) byKey.set(key, m = new Map<any, any>());
        if (!m.has(n.id)) m.set(n.id, w.slice(i, j).join(" "));
      }
    }
  }
  return byKey;
}

export function detectLanes(nodes: any, edges: any, opts: any = {}) {
  const o = { ...LANE_DEFAULTS, ...opts };
  if (!o.minMembers) return {
    roleOf: new Map<any, any>(nodes.map((n: any) => [n.id, "N:" + n.id])), laneOf: new Map<any, any>(),
    families: [], laneValues: new Set<any>(), rejected: [], foldedBoxes: 0, roleCount: nodes.length,
  };

  const linked = new Set<any>();
  for (const e of edges) { linked.add(e.from + SEP + e.to); linked.add(e.to + SEP + e.from); }

  const rejected: any[] = [], pool: any[] = [];
  for (const [key, m] of candidateFamilies(nodes, o.maxSpan)) {
    if (m.size < o.minMembers) continue;
    const members = [...m].map(([id, token]) => ({ id, token }));
    if (new Set<any>(members.map(x => x.token)).size !== members.length) continue;

    let adjacent = false;
    for (let i = 0; i < members.length && !adjacent; i++)
      for (let j = i + 1; j < members.length && !adjacent; j++)
        if (linked.has(members[i].id + SEP + members[j].id)) adjacent = true;
    if (adjacent) { rejected.push({ key, why: "members are linked to each other, so this is a sequence not a set of alternatives" }); continue; }

    const [pre, suf] = key.split(SEP);
    pool.push({ key, pre, suf, members, anchor: words(pre).length + words(suf).length });
  }

  // Lane values and families define each other, so settle them together.
  let kept = pool;
  for (let round = 0; round < 6; round++) {
    const tokenFamilies = new Map<any, any>();
    for (const f of kept)
      for (const t of new Set<any>(f.members.map((m: any) => m.token)))
        tokenFamilies.set(t, (tokenFamilies.get(t) || 0) + 1);
    const values = new Set<any>([...tokenFamilies]
      .filter(([t, c]) => c >= o.minTokenFamilies && !/^[0-9]+$/.test(t) && t.length > 1)
      .map(([t]) => t));
    const next = pool
      .map(f => ({ ...f, members: f.members.filter((m: any) => values.has(m.token)) }))
      .filter(f => f.members.length >= o.minMembers);
    const settled = next.length === kept.length &&
      next.every((f, i) => f.key === kept[i].key && f.members.length === kept[i].members.length);
    kept = next;
    if (settled) break;
  }

  // Bigger family wins a contested box; more anchor words breaks the tie.
  const assign = (list: any) => {
    const roleOf = new Map<any, any>(), laneOf = new Map<any, any>(), claimed = new Set<any>();
    for (const f of [...list].sort((a, b) =>
      b.members.length - a.members.length || b.anchor - a.anchor || (a.key < b.key ? -1 : 1)))
      for (const m of f.members) {
        if (claimed.has(m.id)) continue;
        claimed.add(m.id);
        roleOf.set(m.id, "L:" + f.key);
        laneOf.set(m.id, m.token);
      }
    return { roleOf, laneOf };
  };

  // "Pick rate" and "Damage rate" share a word and nothing else; real lane
  // siblings sit in the same place in the map, so what flows into and out of
  // them plays the same parts.
  const tentative = assign(kept);
  const around = new Map<any, any>();
  for (const e of edges) {
    if (!around.has(e.from)) around.set(e.from, new Set<any>());
    if (!around.has(e.to)) around.set(e.to, new Set<any>());
    around.get(e.from).add(tentative.roleOf.get(e.to) || "N:" + e.to);
    around.get(e.to).add(tentative.roleOf.get(e.from) || "N:" + e.from);
  }
  const survivors: any[] = [];
  for (const f of kept) {
    const mine = f.members.filter((m: any) => tentative.roleOf.get(m.id) === "L:" + f.key);
    if (mine.length < o.minMembers) continue;
    const sets = mine.map((m: any) => around.get(m.id) || new Set<any>());
    let pairs = 0, total = 0;
    for (let i = 0; i < sets.length; i++)
      for (let j = i + 1; j < sets.length; j++) {
        let inter = 0;
        for (const r of sets[i]) if (sets[j].has(r)) inter++;
        const union = sets[i].size + sets[j].size - inter;
        total += union ? inter / union : 0;
        pairs++;
      }
    const overlap = pairs ? total / pairs : 1;
    if (overlap < o.neighbourOverlap) {
      rejected.push({ key: f.key, why: `members sit in different parts of the map (${(overlap * 100).toFixed(0)}% shared surroundings)` });
      continue;
    }
    survivors.push({ ...f, members: mine, overlap });
  }

  const { roleOf, laneOf } = assign(survivors);
  for (const n of nodes) if (!roleOf.has(n.id)) roleOf.set(n.id, "N:" + n.id);

  const size = new Map<any, any>();
  for (const role of roleOf.values()) size.set(role, (size.get(role) || 0) + 1);

  return {
    roleOf, laneOf, rejected,
    families: survivors
      .map(f => ({ ...f, members: f.members.filter((m: any) => roleOf.get(m.id) === "L:" + f.key) }))
      .filter(f => f.members.length >= o.minMembers)
      .sort((a, b) => b.members.length - a.members.length),
    laneValues: new Set<any>(laneOf.values()),
    foldedBoxes: [...size.values()].filter(c => c > 1).reduce((a, c) => a + c, 0),
    roleCount: size.size,
  };
}

export const familyLabel = (key: any) => {
  const [pre, suf] = key.split(SEP);
  return (pre ? pre + " " : "") + SLOT + (suf ? " " + suf : "");
};

export function roleLabel(role: any, byId: any) {
  if (!role.startsWith("L:")) {
    const n = byId.get(role.slice(2));
    return n ? (n.label || n.id) : role.slice(2);
  }
  return familyLabel(role.slice(2));
}

// ---------------------------------------------------------------------------
// 2. FEEDBACK LOOPS
// ---------------------------------------------------------------------------
// Every mutually-reachable group of boxes becomes one element. A pathway can
// enter a loop and leave it, but never go round it — which is how people read
// a strand, and what leaves the rest of the pipeline working on something
// guaranteed to be acyclic.
// ---------------------------------------------------------------------------
export function stronglyConnected(ids: any, succ: any) {
  const index = new Map<any, any>(), low = new Map<any, any>(), onStack = new Set<any>(), stack: any[] = [], comps: any[] = [];
  let counter = 0;
  for (const root of ids) {
    if (index.has(root)) continue;
    const work = [{ v: root, kids: null as any, i: 0 }];
    while (work.length) {
      const f = work[work.length - 1];
      if (f.kids === null) {
        index.set(f.v, counter); low.set(f.v, counter); counter++;
        stack.push(f.v); onStack.add(f.v);
        f.kids = [...(succ.get(f.v) || [])];
      }
      if (f.i < f.kids.length) {
        const w = f.kids[f.i++];
        if (!index.has(w)) work.push({ v: w, kids: null as any, i: 0 });
        else if (onStack.has(w)) low.set(f.v, Math.min(low.get(f.v), index.get(w)));
        continue;
      }
      if (low.get(f.v) === index.get(f.v)) {
        const comp: any[] = [];
        for (;;) { const w = stack.pop(); onStack.delete(w); comp.push(w); if (w === f.v) break; }
        comps.push(comp);
      }
      work.pop();
      if (work.length) {
        const p = work[work.length - 1].v;
        low.set(p, Math.min(low.get(p), low.get(f.v)));
      }
    }
  }
  return comps;
}

export function collapseLoops(scope: any, edges: any) {
  const succ = new Map<any, any>();
  for (const id of scope) succ.set(id, new Set<any>());
  for (const e of edges) if (scope.has(e.from) && scope.has(e.to)) succ.get(e.from).add(e.to);

  const groupOf = new Map<any, any>(), groups = new Map<any, any>();
  let n = 0;
  for (const comp of stronglyConnected([...scope], succ)) {
    const loop = comp.length > 1 || succ.get(comp[0]).has(comp[0]);
    const id = "g" + (n++);
    for (const b of comp) groupOf.set(b, id);
    groups.set(id, { id, loop, boxes: comp });
  }
  const gsucc = new Map<any, any>(), gpred = new Map<any, any>();
  for (const id of groups.keys()) { gsucc.set(id, new Set<any>()); gpred.set(id, new Set<any>()); }
  for (const [a, outs] of succ)
    for (const b of outs) {
      const x = groupOf.get(a), y = groupOf.get(b);
      if (x === y) continue;
      gsucc.get(x).add(y); gpred.get(y).add(x);
    }
  return { groups, groupOf, succ: gsucc, pred: gpred };
}

// ---------------------------------------------------------------------------
// 2b. WHAT IS ACTUALLY INSIDE A FEEDBACK LOOP
// ---------------------------------------------------------------------------
// Contracting a tangle to one element keeps the counting honest, but on its own
// it turns the most interesting part of a map into a black box. One tangle on a
// map this size held 108 boxes and 79 independent loops, and the only thing the
// page said about it was 108 names joined by arrows.
//
// A tangle is not one loop. It is many loops sharing edges, and the unit people
// actually think in is the single loop with its POLARITY:
//
//   reinforcing  an even number of negative links — a nudge comes back amplified
//   balancing    an odd number — a nudge comes back opposed, and it settles
//
// Both fall straight out of the elasticities already in the CSV: multiply the
// signs for polarity, multiply the magnitudes for gain. Neither was being used.
//
// Which loops to show is the real question, because a tangle can hold more
// loops than anyone will read. Taking the SHORTEST loop through each box, then
// ranking by gain, gives a set with two properties worth having: no box in the
// tangle is left without a story, and the ones that actually move the system
// come first.
// ---------------------------------------------------------------------------
export function shortestCycleThrough(box: any, adj: any) {
  if ((adj.get(box) || []).some((e: any) => e.to === box)) return [box];
  const prev = new Map<any, any>(), queue: any[] = [];
  for (const e of adj.get(box) || [])
    if (!prev.has(e.to)) { prev.set(e.to, box); queue.push(e.to); }
  for (let head = 0; head < queue.length; head++) {
    const n = queue[head];
    for (const e of adj.get(n) || []) {
      if (e.to === box) {
        const path = [n];
        for (let x = prev.get(n); x !== box; x = prev.get(x)) path.push(x);
        path.push(box);
        return path.reverse();
      }
      if (!prev.has(e.to)) { prev.set(e.to, n); queue.push(e.to); }
    }
  }
  return null;
}

// Rotations of one loop are the same loop, so name each by the rotation that
// starts at its first box alphabetically.
export function canonicalCycle(cycle: any) {
  let k = 0;
  for (let i = 1; i < cycle.length; i++) if (cycle[i] < cycle[k]) k = i;
  return cycle.slice(k).concat(cycle.slice(0, k)).join(">");
}

export function analyseTangle(boxes: any, edges: any, outsideIn: any, outsideOut: any) {
  const set = new Set<any>(boxes);
  const inner = edges.filter((e: any) => set.has(e.from) && set.has(e.to));

  // Two boxes can be joined twice, and the two links can disagree about sign —
  // in which case the polarity of every loop through them depends on which one
  // you take. Taking whichever happened to be listed first would make the
  // answer silently arbitrary, so the stronger link wins and the count of
  // disagreements is reported rather than swallowed.
  const strongest = new Map<any, any>();
  let parallel = 0, contradictory = 0;
  for (const e of inner) {
    const key = e.from + "\u0001" + e.to;
    const had = strongest.get(key);
    if (!had) { strongest.set(key, e); continue; }
    parallel++;
    if ((had.elasticity < 0) !== (e.elasticity < 0)) contradictory++;
    if (Math.abs(e.elasticity) > Math.abs(had.elasticity)) strongest.set(key, e);
  }
  const adj = new Map<any, any>(boxes.map((b: any) => [b, []]));
  for (const e of strongest.values()) adj.get(e.from).push(e);

  const loops: any[] = [], seen = new Set<any>();
  for (const box of boxes) {
    const cycle = shortestCycleThrough(box, adj);
    if (!cycle) continue;
    const key = canonicalCycle(cycle);
    if (seen.has(key)) continue;
    seen.add(key);
    let sign = 1, gain = 1;
    const links: any[] = [];
    for (let i = 0; i < cycle.length; i++) {
      const from = cycle[i], to = cycle[(i + 1) % cycle.length];
      const e = adj.get(from).find((x: any) => x.to === to);
      if (!e) { sign = 0; break; }
      links.push(e);
      sign *= e.elasticity < 0 ? -1 : 1;
      gain *= Math.abs(e.elasticity);
    }
    if (!sign) continue;
    loops.push({ key, cycle, links, sign, gain, reinforcing: sign > 0 });
  }
  loops.sort((a, b) => b.gain - a.gain || a.cycle.length - b.cycle.length);

  return {
    boxes, loops,
    links: [...strongest.values()],
    linkCount: inner.length,
    parallel, contradictory,
    // How many loops it would take to generate every loop in here. The plain
    // count of loops can run to thousands; this one is small and exact.
    independent: inner.length - boxes.length + 1,
    waysIn: [...outsideIn], waysOut: [...outsideOut],
    reinforcing: loops.filter(l => l.reinforcing).length,
    balancing: loops.filter(l => !l.reinforcing).length,
  };
}

// ---------------------------------------------------------------------------
// 2b. THE WHEEL — an order that makes a tangle drawable
// ---------------------------------------------------------------------------
// A tangle is not a random knot. Order its boxes well and MOST of its links run
// forwards; only a few run back, and those few are the feedback — cut them and
// what is left is an ordinary sequence. That is what makes the tangle drawable
// as one picture: the back links are few enough to see.
//
// Worth keeping two numbers apart. The loops of a tangle span a space of
// E − V + 1 independent ones, which on a real tangle runs to dozens and is why
// listing them fails. The links that must be cut to make it acyclic are far
// fewer. The second number is the one you can draw.
//
// The ordering is the greedy feedback-arc-set of Eades, Lin and Smyth: peel
// sinks off the back and sources off the front, and when neither exists take
// the box with the biggest out-minus-in. Linear, and in practice within a hair
// of the smallest possible set of back links.
// ---------------------------------------------------------------------------
export function orderTangle(boxes: any, links: any) {
  const outD = new Map<any, any>(), inD = new Map<any, any>(), outs = new Map<any, any>(), ins = new Map<any, any>();
  for (const b of boxes) { outD.set(b, 0); inD.set(b, 0); outs.set(b, []); ins.set(b, []); }
  for (const e of links) {
    if (!outD.has(e.from) || !inD.has(e.to)) continue;
    outD.set(e.from, outD.get(e.from) + 1); inD.set(e.to, inD.get(e.to) + 1);
    outs.get(e.from).push(e.to); ins.get(e.to).push(e.from);
  }
  const left: any[] = [], right: any[] = [], gone = new Set<any>();
  const drop = (v: any) => {
    gone.add(v);
    for (const w of outs.get(v)) if (!gone.has(w)) inD.set(w, inD.get(w) - 1);
    for (const w of ins.get(v)) if (!gone.has(w)) outD.set(w, outD.get(w) - 1);
  };
  while (gone.size < boxes.length) {
    let moved = true;
    while (moved) {
      moved = false;
      for (const v of boxes) if (!gone.has(v) && outD.get(v) === 0) { right.unshift(v); drop(v); moved = true; }
      for (const v of boxes) if (!gone.has(v) && inD.get(v) === 0 && outD.get(v) > 0) { left.push(v); drop(v); moved = true; }
    }
    if (gone.size >= boxes.length) break;
    let best = null, score = -Infinity;
    for (const v of boxes) {
      if (gone.has(v)) continue;
      const s = outD.get(v) - inD.get(v);
      if (s > score) { score = s; best = v; }
    }
    left.push(best); drop(best);
  }
  return left.concat(right);
}

// Everything the wheel is drawn from. Computed when a tangle is opened rather
// than when the atlas is built, so a map full of feedback still builds in the
// time it takes to draw one frame.
export function wheelOf(t: any) {
  const order = orderTangle(t.boxes, t.links);
  const pos = new Map<any, any>(order.map((b, i) => [b, i]));
  const forward: any[] = [], back: any[] = [];
  for (const e of t.links) (pos.get(e.to) > pos.get(e.from) ? forward : back).push(e);

  // The forward links alone are acyclic, so the way home from a back link is a
  // shortest path in a DAG — no search, just relax in order. A few back links
  // cannot get home that way, because their return needs another back link;
  // those fall back to a plain search, so every back link gets its loop.
  const fwdOut = new Map<any, any>(t.boxes.map((b: any) => [b, []]));
  for (const e of forward) fwdOut.get(e.from).push(e);
  const allOut = new Map<any, any>(t.boxes.map((b: any) => [b, []]));
  for (const e of t.links) allOut.get(e.from).push(e);

  const loops: any[] = [];
  for (const e of back) {
    const dist = new Map<any, any>([[e.to, 0]]), prev = new Map<any, any>();
    for (const b of order) {
      if (!dist.has(b)) continue;
      for (const f of fwdOut.get(b))
        if (!dist.has(f.to) || dist.get(f.to) > dist.get(b) + 1) {
          dist.set(f.to, dist.get(b) + 1); prev.set(f.to, f);
        }
    }
    let chain: any[] = [];
    if (dist.has(e.from)) {
      for (let at = e.from; at !== e.to; ) { const f = prev.get(at); chain.unshift(f); at = f.from; }
    } else {
      const seen = new Map<any, any>(), q = [e.to];
      for (let i = 0; i < q.length; i++)
        for (const f of allOut.get(q[i]) || []) {
          if (seen.has(f.to) || f.to === e.to) continue;
          seen.set(f.to, f); q.push(f.to);
        }
      if (!seen.has(e.from)) continue;
      for (let at = e.from; at !== e.to; ) { const f = seen.get(at); chain.unshift(f); at = f.from; }
    }
    const links = chain.concat([e]);
    let sign = 1, gain = 1;
    for (const l of links) { if (l.elasticity < 0) sign = -sign; gain *= Math.abs(l.elasticity); }
    loops.push({ back: e, links, cycle: links.map(l => l.from), reinforcing: sign > 0, gain });
  }

  const share = new Map<any, any>(t.boxes.map((b: any) => [b, 0]));
  for (const l of loops) for (const b of l.cycle) share.set(b, share.get(b) + 1);
  const touching = new Map<any, any>(t.boxes.map((b: any) => [b, []]));
  for (const e of t.links) { touching.get(e.from).push(e); touching.get(e.to).push(e); }

  return { order, pos, forward, back, loops, share, touching, links: t.links };
}

// ---------------------------------------------------------------------------
// 3. REFINE THE GROUPING UNTIL IT IS TRUE
// ---------------------------------------------------------------------------
// Start from what the names propose, then repeatedly split any group whose
// members disagree about which groups they lead to. What settles out is the
// coarsest grouping in which members really are interchangeable going forward.
//
// Two things follow, and both matter:
//   * every stretch on the page is walkable in the real map, because each
//     member of a group has a successor in every one of that group's
//     successors;
//   * the result cannot hold a loop the map does not, because a loop among
//     groups would force an endless forward chain through an acyclic graph.
//     Grouping by name alone offers no such assurance — it will happily turn
//     "Cannabis Seizure → Shared Factor → Cocaine Import" into feedback that
//     nobody drew.
// ---------------------------------------------------------------------------
// Both settings run the same refinement; they differ only in when to stop.
//
//   as far as possible  stop the moment the grouping is loop-safe. This is the
//                       most condensed honest answer: no invented feedback, but
//                       a group may hold members that go on to differ, and the
//                       lane badges on each branch are what tell you so.
//   where behaviour matches  run to the fixpoint. Every step on the page is
//                       then one that every member of its group really takes.
//                       Strictly truer, and on a map whose lanes are wired
//                       even slightly differently it condenses far less.
//
// Neither can miss a pathway. The difference is only how much is claimed about
// the members of a group, which is why the tool reports both numbers.
export function quotientHasCycle(ids: any, succ: any, cls: any) {
  const csucc = new Map<any, any>();
  for (const id of ids) {
    const c = cls.get(id);
    if (!csucc.has(c)) csucc.set(c, new Set<any>());
  }
  for (const id of ids) {
    const c = cls.get(id);
    for (const s of succ.get(id)) {
      const d = cls.get(s);
      if (d === c) return true;
      csucc.get(c).add(d);
    }
  }
  return stronglyConnected([...csucc.keys()], csucc).some(comp => comp.length > 1);
}

export function refineForward(ids: any, succ: any, initial: any, strict: any) {
  let cls = new Map<any, any>(ids.map((id: any) => [id, String(initial.get(id))]));
  let count = new Set<any>(cls.values()).size;
  for (let round = 0; round <= ids.length + 1; round++) {
    if (!strict && !quotientHasCycle(ids, succ, cls)) return { cls, rounds: round, settled: false };
    const sig = new Map<any, any>(), rename = new Map<any, any>();
    for (const id of ids) {
      const outs = [...new Set<any>([...succ.get(id)].map(x => cls.get(x)))].sort().join(",");
      sig.set(id, cls.get(id) + SEP + outs);
    }
    for (const id of ids) if (!rename.has(sig.get(id))) rename.set(sig.get(id), "c" + rename.size);
    if (rename.size === count) return { cls, rounds: round, settled: true };
    cls = new Map<any, any>(ids.map((id: any) => [id, rename.get(sig.get(id))]));
    count = rename.size;
  }
  return { cls, rounds: ids.length, settled: true };
}

// ---------------------------------------------------------------------------
// 4. POST-DOMINATORS → single-entry / single-exit regions
// ---------------------------------------------------------------------------
// Where the pathways split, the question worth answering is where they come
// back together. That element is the immediate POST-DOMINATOR of the split:
// the first one every route from the split must reach. Everything between the
// two is a self-contained choice — exactly the unit worth putting on screen
// behind one open/close triangle.
// ---------------------------------------------------------------------------
export function reversePostorder(root: any, succOf: any) {
  const seen = new Set<any>([root]), post: any[] = [], stack = [{ n: root, kids: null as any, i: 0 }];
  while (stack.length) {
    const f = stack[stack.length - 1];
    if (f.kids === null) f.kids = succOf(f.n);
    if (f.i < f.kids.length) {
      const s = f.kids[f.i++];
      if (!seen.has(s)) { seen.add(s); stack.push({ n: s, kids: null as any, i: 0 }); }
      continue;
    }
    post.push(f.n); stack.pop();
  }
  return post.reverse();
}

export function immediateDominators(root: any, succOf: any, predOf: any) {
  const rpo = reversePostorder(root, succOf);
  const num = new Map<any, any>(rpo.map((n, i) => [n, i]));
  const idom = new Map<any, any>([[root, root]]);
  const intersect = (a: any, b: any) => {
    while (a !== b) {
      while (num.get(a) > num.get(b)) a = idom.get(a);
      while (num.get(b) > num.get(a)) b = idom.get(b);
    }
    return a;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const n of rpo) {
      if (n === root) continue;
      let cand = null;
      for (const p of predOf(n)) {
        if (!num.has(p) || !idom.has(p)) continue;
        cand = cand === null ? p : intersect(p, cand);
      }
      if (cand !== null && idom.get(n) !== cand) { idom.set(n, cand); changed = true; }
    }
  }
  return idom;
}

// Exact totals: paths(n) is how many pathways run from n to the finish, summed
// over successors in reverse topological order. BigInt, because on a real map
// this number is genuinely astronomical.
export function countPaths(start: any, succOf: any) {
  const topo = reversePostorder(start, succOf);
  const paths = new Map<any, any>([[END, 1n]]);
  for (let i = topo.length - 1; i >= 0; i--) {
    const n = topo[i];
    if (n === END) continue;
    let total = 0n;
    for (const s of succOf(n)) total += paths.get(s) || 0n;
    paths.set(n, total);
  }
  return paths;
}

export function addFinish(succ: any, pred: any) {
  succ.set(END, new Set<any>());
  if (pred) pred.set(END, new Set<any>());
  const finishes: any[] = [];
  for (const [id, outs] of succ) {
    if (id === END || outs.size) continue;
    finishes.push(id);
    outs.add(END);
    if (pred) pred.get(END).add(id);
  }
  return finishes;
}

// ---------------------------------------------------------------------------
// 5. THE ATLAS
// ---------------------------------------------------------------------------
export function buildAtlas(G: any, startId: any, opts: any = {}) {
  const t0 = Date.now();
  const stopAt = opts.stopAtOutcomes
    ? new Set<any>(G.nodes.filter((n: any) => n.direction).map((n: any) => n.id))
    : null;

  const scope = reachableFrom(G, startId, stopAt);
  const scopedNodes = G.nodes.filter((n: any) => scope.has(n.id));
  const scopedEdges = G.edges.filter((e: any) =>
    scope.has(e.from) && scope.has(e.to) &&
    !(stopAt && stopAt.has(e.from) && e.from !== startId));

  const lanes = detectLanes(scopedNodes, scopedEdges, opts.lanes || {});
  const L = collapseLoops(scope, scopedEdges);
  const startGroup = L.groupOf.get(startId);

  // What the names propose. Identical loops in different lanes get the same
  // proposal, so four copies of one feedback loop become one element.
  const initial = new Map<any, any>();
  for (const [gid, g] of L.groups) {
    if (gid === startGroup) { initial.set(gid, "START"); continue; }
    const roles = [...new Set<any>(g.boxes.map((b: any) => lanes.roleOf.get(b)))].sort();
    initial.set(gid, g.loop ? "LOOP:" + roles.join("+") : roles[0]);
  }

  // Unpack every tangle once, before anything is folded, so polarity and gain
  // are read off the real links rather than off the grouped ones.
  const tangles = new Map<any, any>();
  for (const [gid, g] of L.groups) {
    if (!g.loop) continue;
    const set = new Set<any>(g.boxes);
    const inSide = new Set<any>(), outSide = new Set<any>();
    for (const e of scopedEdges) {
      if (!set.has(e.from) && set.has(e.to)) inSide.add(e.to);
      if (set.has(e.from) && !set.has(e.to)) outSide.add(e.from);
    }
    tangles.set(gid, analyseTangle(g.boxes, scopedEdges, inSide, outSide));
  }

  const gids = [...L.groups.keys()];
  const refined = refineForward(gids, L.succ, initial, opts.grouping === "strict");
  const classOf = refined.cls;

  // The quotient: one element per settled class.
  const nodes = new Map<any, any>(), succ = new Map<any, any>(), pred = new Map<any, any>();
  for (const gid of gids) {
    const cid = classOf.get(gid);
    let node = nodes.get(cid);
    if (!node) {
      nodes.set(cid, node = { id: cid, loop: false, boxes: [], lanes: new Set<any>(), copies: 0, roles: new Set<any>(), tangles: [] });
      succ.set(cid, new Set<any>()); pred.set(cid, new Set<any>());
    }
    const g = L.groups.get(gid);
    node.copies++;
    node.loop = node.loop || g.loop;
    if (g.loop && tangles.has(gid)) node.tangles.push(tangles.get(gid));
    for (const b of g.boxes) {
      node.boxes.push(b);
      node.roles.add(lanes.roleOf.get(b));
      const lane = lanes.laneOf.get(b);
      if (lane) node.lanes.add(lane);
    }
  }
  // Which lanes actually take each step, and which do not. On the looser
  // setting this is the whole story of where the strands differ, so it is
  // recorded rather than inferred.
  const stepLanes = new Map<any, any>(), stepTakenBy = new Map<any, any>();
  for (const [a, outs] of L.succ)
    for (const b of outs) {
      const x = classOf.get(a), y = classOf.get(b);
      if (x === y) continue;
      succ.get(x).add(y); pred.get(y).add(x);
      const key = x + ">" + y;
      if (!stepLanes.has(key)) { stepLanes.set(key, new Set<any>()); stepTakenBy.set(key, new Set<any>()); }
      stepTakenBy.get(key).add(a);
      for (const box of L.groups.get(a).boxes) {
        const lane = lanes.laneOf.get(box);
        if (lane) stepLanes.get(key).add(lane);
      }
    }

  // How many steps on the page are taken by only some members of their group.
  // Zero on the strict setting by construction; on the looser one this is the
  // honest measure of what the condensation is glossing over.
  let partialSteps = 0;
  const membersOf = new Map<any, any>();
  for (const gid of gids) {
    const c = classOf.get(gid);
    membersOf.set(c, (membersOf.get(c) || 0) + 1);
  }
  for (const [key, takers] of stepTakenBy)
    if (takers.size < membersOf.get(key.split(">")[0])) partialSteps++;
  for (const node of nodes.values()) {
    const roles = [...node.roles];
    node.label = node.loop
      ? loopLabel(node, G)
      : roles.length === 1 && node.boxes.length > 1
        ? roleLabel(roles[0], G.byId)
        : (G.byId.get(node.boxes[0]) || {}).label || node.boxes[0];
  }

  const start = classOf.get(startGroup);
  nodes.set(END, { id: END, label: "end", loop: false, boxes: [], lanes: new Set<any>(), copies: 0, roles: new Set<any>(), end: true });
  const finishes = addFinish(succ, pred);
  const succOf = (n: any) => [...succ.get(n)];
  const predOf = (n: any) => [...pred.get(n)];
  const ipdom = immediateDominators(END, predOf, succOf);
  const paths = countPaths(start, succOf);

  // The same structure with no grouping at all, so the condensation is
  // measured rather than asserted and the true pathway total is to hand.
  const rawSucc = new Map<any, any>();
  for (const gid of gids) rawSucc.set(gid, new Set<any>(L.succ.get(gid)));
  addFinish(rawSucc, null);
  const rawPaths = countPaths(startGroup, (n: any) => [...rawSucc.get(n)]);

  const ctx = { nodes, ipdom, paths, succ: succOf, END,
                limit: nodes.size + 8, emitted: new Set<any>(), tails: new Map<any, any>() };
  const tree = buildSequence(start, END, ctx);

  // Where a proposed family had to be split because its members stopped
  // behaving alike. Not a failure — this is the divergence, named.
  const splits = new Map<any, any>();
  for (const [gid, cid] of classOf) {
    const proposal = initial.get(gid);
    if (!proposal.startsWith("L:")) continue;
    if (!splits.has(proposal)) splits.set(proposal, new Set<any>());
    splits.get(proposal).add(cid);
  }

  return {
    startId, start, tree, nodes, succ, pred, ipdom, paths, lanes, scope, finishes,
    tails: ctx.tails, stepLanes, stepTakenBy,
    grouping: opts.grouping === "strict" ? "strict" : "loose",
    everyStepShared: partialSteps === 0,
    partialSteps, totalSteps: stepTakenBy.size,
    loops: [...nodes.values()].filter(n => n.loop),
    feedback: gatherFeedback(nodes),
    shapes: paths.get(start) || 0n,
    pathways: rawPaths.get(startGroup) || 0n,
    boxesInScope: scope.size,
    elements: nodes.size - 1,
    elementsUngrouped: gids.length,
    splitFamilies: [...splits]
      .filter(([, s]) => s.size > 1)
      .map(([role, s]) => ({ key: role.slice(2), into: s.size }))
      .sort((a, b) => b.into - a.into),
    refineRounds: refined.rounds,
    ms: Date.now() - t0,
  };
}

// A loop is named after its strongest loop when that is short enough to read,
// and by its size when it is not. Reciting 108 member names, which is what this
// used to do, is the opposite of a name.
export function loopLabel(node: any, G: any) {
  const t = node.tangles[0];
  if (!t || !t.loops.length) return `feedback loop of ${node.boxes.length} boxes`;
  // One loop can be named after itself. A tangle of many cannot — naming it
  // after the strongest implies the others are variations on it, and they are
  // not, so it is named by what it is instead.
  if (t.loops.length === 1)
    return t.loops[0].cycle.map((b: any) => (G.byId.get(b) || {}).label || b).join(" ⇄ ");
  return `feedback tangle · ${t.loops.length} loops`;
}

// Walk the spine from `entry` to `stop`, opening a nested choice wherever the
// pathways split. Progress is guaranteed: a split's rejoin is always strictly
// later in the order than the split itself.
//
// Two alternatives out of one split can pass through the same element without
// ALL of them doing so — n→a→m→x, n→a→q→x, n→b→m→x. Writing m out under both
// would duplicate the stretch, and on a dense map that duplication compounds
// until the page is larger than the graph it came from. So an element is
// expanded once and later meetings point at it. Nothing is lost: the two
// readings continue identically from there.
export function buildSequence(entry: any, stop: any, ctx: any) {
  const items: any[] = [];
  let n = entry, guard = 0;
  while (n !== stop && n !== ctx.END) {
    if (guard++ > ctx.limit) throw new Error("region walk failed to terminate at " + n);
    if (ctx.emitted.has(n)) { items.push({ kind: "join", id: n }); break; }
    ctx.emitted.add(n);
    items.push({ kind: "box", id: n });
    const outs = ctx.succ(n);
    if (outs.length === 0) break;
    if (outs.length === 1) { n = outs[0]; continue; }
    const rejoin = ctx.ipdom.get(n);
    const whole = ctx.paths.get(rejoin) || 1n;
    const alts = outs.map((s: any) => ({
      first: s,
      shapes: (ctx.paths.get(s) || 0n) / whole,
      seq: s === rejoin ? [] : buildSequence(s, rejoin, ctx),
    })).sort((a: any, b: any) => (a.shapes > b.shapes ? -1 : a.shapes < b.shapes ? 1 : 0));
    items.push({ kind: "choice", at: n, rejoin: rejoin === ctx.END ? null : rejoin, alts });
    n = rejoin;
  }
  // What follows each element, so a "joins here" reads as the stretch it
  // points at rather than as a dead end.
  for (let i = 0; i < items.length; i++)
    if (items[i].kind === "box") ctx.tails.set(items[i].id, items.slice(i));
  return items;
}

// ---------------------------------------------------------------------------
// 6. READING AIDS
// ---------------------------------------------------------------------------
// Which lanes reach a stretch. One only some lanes can reach is a real
// divergence — the pocket where those lanes behave unlike the rest.
export function lanesIn(seq: any, nodes: any, into = new Set<any>()) {
  for (const item of seq) {
    if (item.kind === "choice") for (const a of item.alts) lanesIn(a.seq, nodes, into);
    else for (const l of nodes.get(item.id).lanes || []) into.add(l);
  }
  return into;
}

export function boxesIn(seq: any, nodes: any, into = new Set<any>()) {
  for (const item of seq) {
    if (item.kind === "choice") for (const a of item.alts) boxesIn(a.seq, nodes, into);
    else for (const b of nodes.get(item.id).boxes || []) into.add(b);
  }
  return into;
}

export function countItems(seq: any, acc = { boxes: 0, choices: 0, joins: 0, depth: 0 }, depth = 0) {
  acc.depth = Math.max(acc.depth, depth);
  for (const item of seq) {
    if (item.kind === "box") acc.boxes++;
    else if (item.kind === "join") acc.joins++;
    else { acc.choices++; for (const a of item.alts) countItems(a.seq, acc, depth + 1); }
  }
  return acc;
}

export function formatCount(n: any) {
  if (typeof n !== "bigint") n = BigInt(n);
  if (n < 1000000000000000n) return Number(n).toLocaleString("en-GB");
  const s = n.toString();
  return s[0] + "." + s.slice(1, 3) + " × 10^" + (s.length - 1);
}

// Every loop on the map in one list, strongest first, each knowing which
// element it lives in and how many places that element stands for.
export function gatherFeedback(nodes: any) {
  const out: any[] = [];
  for (const node of nodes.values()) {
    if (!node.loop || !node.tangles.length) continue;
    const t = node.tangles[0];
    for (const loop of t.loops)
      out.push({ ...loop, element: node.id, elementLabel: node.label,
                 copies: node.tangles.length, lanes: node.lanes,
                 tangleSize: t.boxes.length, independent: t.independent });
  }
  return out.sort((a, b) => b.gain - a.gain || a.cycle.length - b.cycle.length);
}

// ---------------------------------------------------------------------------
// MEASUREMENTS THE VIEWS SHARE
// ---------------------------------------------------------------------------
// paths(n) is how many readings run from n to the finish. Going the other way
// gives how many run from the start into n, and multiplying the two gives the
// weight of n: how much of everything passes through it. That single number is
// what makes a flow diagram, a proportional block and a bar all say the same
// thing rather than three different things.
export function measure(A: any) {
  const succOf = (n: any) => [...A.succ.get(n)];
  const order = reversePostorder(A.start, succOf);
  const into = new Map<any, any>([[A.start, 1n]]);
  const depth = new Map<any, any>([[A.start, 0]]);
  for (const n of order) {
    const i = into.get(n) || 0n, d = depth.get(n) || 0;
    for (const s of succOf(n)) {
      into.set(s, (into.get(s) || 0n) + i);
      if ((depth.get(s) || 0) < d + 1) depth.set(s, d + 1);
    }
  }
  const total = A.paths.get(A.start) || 1n;
  const share = (v: any) => (total > 0n ? Number((v * 1000000n) / total) / 1000000 : 0);
  return {
    order, into, depth, total,
    weight: (n: any) => share((into.get(n) || 0n) * (A.paths.get(n) || 0n)),
    linkWeight: (a: any, b: any) => share((into.get(a) || 0n) * (A.paths.get(b) || 0n)),
  };
}

// ---------------------------------------------------------------------------
// STRANDS -- one complete reading, left edge to right edge
// ---------------------------------------------------------------------------
// A strand is a single pathway from the start element to the finish: the thing
// every percentage on the atlas is a share OF, made concrete enough to read and
// point at.
//
// The atlas refuses to enumerate pathways, and it is right to — a real map has
// more of them than can be held. This does not enumerate them either. It walks
// the frontier one step at a time and stops as soon as it has the `limit`
// shortest, so the work is bounded by what is asked for rather than by how
// tangled the map is. Because tangles are already contracted to one element
// each, no strand can multiply through feedback, and every strand is finite.
//
// Breadth-first over partial paths, so strands come out shortest first with no
// sorting: every link counts one, and a level of the search is a length.
export function strands(A: any, opts: any = {}) {
  const limit = Math.max(1, opts.limit || 200);
  const through = opts.through || null;
  const FRONTIER = Math.max(2000, limit * 50);   // a hairball must not eat memory

  // Filtering by an element: before the walk reaches it, step only into
  // elements that can still get there. Everything after it is unconstrained.
  let gate: Set<any> | null = null;
  if (through) {
    const back = new Map<any, any[]>();
    for (const [n, outs] of A.succ) {
      for (const s of outs) { if (!back.has(s)) back.set(s, []); back.get(s)!.push(n); }
    }
    gate = new Set<any>([through]);
    const stack = [through];
    while (stack.length) {
      const n = stack.pop();
      for (const p of back.get(n) || []) if (!gate.has(p)) { gate.add(p); stack.push(p); }
    }
    if (!gate.has(A.start)) return { list: [], truncated: false, reachable: false };
  }

  const out: any[][] = [];
  let level: any[][] = [[A.start]];
  let truncated = false;

  while (level.length && out.length < limit) {
    const next: any[][] = [];
    for (const path of level) {
      if (out.length >= limit) break;
      const tail = path[path.length - 1];
      const passed = !through || path.indexOf(through) >= 0;
      for (const s of A.succ.get(tail) || []) {
        if (s === END) { if (passed) out.push(path); continue; }
        if (path.indexOf(s) >= 0) continue;                 // acyclic already, but cheap
        if (gate && !passed && !gate.has(s)) continue;
        if (next.length >= FRONTIER) { truncated = true; break; }
        next.push(path.concat([s]));
      }
    }
    level = next;
  }
  return { list: out.slice(0, limit), truncated: truncated || out.length >= limit, reachable: true };
}
