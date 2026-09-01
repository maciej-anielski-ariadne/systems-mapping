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
// This engine powers the in-app Atlas and is exercised directly by
// tests/pathway-atlas.test.ts.
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
//   refine     split every group whose members do not behave alike
//   decompose  cut the result into single-entry / single-exit regions
//   count      exact totals by dynamic programming (BigInt)
//
// No stage samples, caps, budgets or truncates the graph, so "every
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

export type AtlasIdentifier = string;
export type AtlasGroupIdentifier = string;
export type AtlasClassIdentifier = string;
export type AtlasRoleIdentifier = string;
export type AtlasLaneValue = string;

export interface AtlasGraphNode {
  id: AtlasIdentifier;
  label?: string;
  direction?: string;
}

export interface AtlasLink {
  from: AtlasIdentifier;
  to: AtlasIdentifier;
}

export interface AtlasGraphEdge extends AtlasLink {
  elasticity: number;
  effect?: string;
}

export interface AtlasGraphInput<NodeType extends AtlasGraphNode = AtlasGraphNode, EdgeType extends AtlasLink = AtlasGraphEdge> {
  nodes: NodeType[];
  edges: EdgeType[];
  name?: string;
}

export interface AtlasGraph<NodeType extends AtlasGraphNode = AtlasGraphNode, EdgeType extends AtlasLink = AtlasGraphEdge> {
  nodes: NodeType[];
  edges: EdgeType[];
  byId: Map<AtlasIdentifier, NodeType>;
  out: Map<AtlasIdentifier, EdgeType[]>;
  inc: Map<AtlasIdentifier, EdgeType[]>;
  name: string;
}

export interface LaneMember {
  id: AtlasIdentifier;
  token: AtlasLaneValue;
}

export interface LaneFamily {
  key: string;
  pre: string;
  suf: string;
  members: LaneMember[];
  anchor: number;
  overlap: number;
}

type LaneFamilyCandidate = Omit<LaneFamily, "overlap">;

export interface RejectedLaneFamily {
  key: string;
  why: string;
}

export interface LaneDetectionOptions {
  minMembers?: number;
  minTokenFamilies?: number;
  maxSpan?: number;
  neighbourOverlap?: number;
}

interface ResolvedLaneDetectionOptions {
  minMembers: number;
  minTokenFamilies: number;
  maxSpan: number;
  neighbourOverlap: number;
}

export interface LaneDetection {
  roleOf: Map<AtlasIdentifier, AtlasRoleIdentifier>;
  laneOf: Map<AtlasIdentifier, AtlasLaneValue>;
  families: LaneFamily[];
  laneValues: Set<AtlasLaneValue>;
  rejected: RejectedLaneFamily[];
  foldedBoxes: number;
  roleCount: number;
}

// ---------------------------------------------------------------------------
// 0. GRAPH
// ---------------------------------------------------------------------------
export function buildGraph<NodeType extends AtlasGraphNode, EdgeType extends AtlasLink>(
  map: AtlasGraphInput<NodeType, EdgeType>,
): AtlasGraph<NodeType, EdgeType> {
  const byId = new Map<AtlasIdentifier, NodeType>();
  const out = new Map<AtlasIdentifier, EdgeType[]>();
  const inc = new Map<AtlasIdentifier, EdgeType[]>();
  for (const node of map.nodes) {
    byId.set(node.id, node);
    out.set(node.id, []);
    inc.set(node.id, []);
  }
  const edges: EdgeType[] = [];
  for (const edge of map.edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    edges.push(edge);
    out.get(edge.from)!.push(edge);
    inc.get(edge.to)!.push(edge);
  }
  return { nodes: map.nodes, edges, byId, out, inc, name: map.name || "map" };
}

export function reachableFrom<NodeType extends AtlasGraphNode, EdgeType extends AtlasLink>(
  graph: AtlasGraph<NodeType, EdgeType>,
  startIdentifier: AtlasIdentifier,
  stopAt: ReadonlySet<AtlasIdentifier> | null,
): Set<AtlasIdentifier> {
  const seen = new Set<AtlasIdentifier>([startIdentifier]);
  const stack: AtlasIdentifier[] = [startIdentifier];
  while (stack.length) {
    const identifier = stack.pop()!;
    if (stopAt && identifier !== startIdentifier && stopAt.has(identifier)) continue;
    for (const edge of graph.out.get(identifier) || []) {
      if (!seen.has(edge.to)) { seen.add(edge.to); stack.push(edge.to); }
    }
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

export const words = (source: string): string[] => source.split(/\s+/).filter(Boolean);

export function candidateFamilies(
  nodes: readonly AtlasGraphNode[],
  maxSpan: number,
): Map<string, Map<AtlasIdentifier, AtlasLaneValue>> {
  const byKey = new Map<string, Map<AtlasIdentifier, AtlasLaneValue>>();
  for (const node of nodes) {
    const labelWords = words(node.label || node.id);
    for (let startIndex = 0; startIndex < labelWords.length; startIndex++) {
      for (
        let endIndex = startIndex + 1;
        endIndex <= Math.min(labelWords.length, startIndex + maxSpan);
        endIndex++
      ) {
        const prefixWords = labelWords.slice(0, startIndex);
        const suffixWords = labelWords.slice(endIndex);
        if (prefixWords.length + suffixWords.length === 0) continue; // need something to anchor on
        const key = prefixWords.join(" ") + SEP + suffixWords.join(" ");
        let membersByIdentifier = byKey.get(key);
        if (!membersByIdentifier) {
          membersByIdentifier = new Map<AtlasIdentifier, AtlasLaneValue>();
          byKey.set(key, membersByIdentifier);
        }
        if (!membersByIdentifier.has(node.id)) {
          membersByIdentifier.set(node.id, labelWords.slice(startIndex, endIndex).join(" "));
        }
      }
    }
  }
  return byKey;
}

export function detectLanes(
  nodes: readonly AtlasGraphNode[],
  edges: readonly AtlasLink[],
  options: LaneDetectionOptions = {},
): LaneDetection {
  const resolvedOptions: ResolvedLaneDetectionOptions = { ...LANE_DEFAULTS, ...options };
  if (!resolvedOptions.minMembers) return {
    roleOf: new Map(nodes.map(node => [node.id, "N:" + node.id])),
    laneOf: new Map<AtlasIdentifier, AtlasLaneValue>(),
    families: [], laneValues: new Set<AtlasLaneValue>(), rejected: [], foldedBoxes: 0, roleCount: nodes.length,
  };

  const linked = new Set<string>();
  for (const edge of edges) {
    linked.add(edge.from + SEP + edge.to);
    linked.add(edge.to + SEP + edge.from);
  }

  const rejected: RejectedLaneFamily[] = [];
  const pool: LaneFamilyCandidate[] = [];
  for (const [key, membersByIdentifier] of candidateFamilies(nodes, resolvedOptions.maxSpan)) {
    if (membersByIdentifier.size < resolvedOptions.minMembers) continue;
    const members = [...membersByIdentifier].map(([identifier, token]) => ({ id: identifier, token }));
    if (new Set(members.map(member => member.token)).size !== members.length) continue;

    let adjacent = false;
    for (let firstIndex = 0; firstIndex < members.length && !adjacent; firstIndex++)
      for (let secondIndex = firstIndex + 1; secondIndex < members.length && !adjacent; secondIndex++)
        if (linked.has(members[firstIndex].id + SEP + members[secondIndex].id)) adjacent = true;
    if (adjacent) { rejected.push({ key, why: "members are linked to each other, so this is a sequence not a set of alternatives" }); continue; }

    const [prefix, suffix] = key.split(SEP);
    pool.push({
      key,
      pre: prefix,
      suf: suffix,
      members,
      anchor: words(prefix).length + words(suffix).length,
    });
  }

  // Lane values and families define each other, so settle them together.
  let kept = pool;
  for (let round = 0; round < 6; round++) {
    const tokenFamilies = new Map<AtlasLaneValue, number>();
    for (const family of kept)
      for (const token of new Set(family.members.map(member => member.token)))
        tokenFamilies.set(token, (tokenFamilies.get(token) || 0) + 1);
    const values = new Set<AtlasLaneValue>([...tokenFamilies]
      .filter(([token, count]) => count >= resolvedOptions.minTokenFamilies && !/^[0-9]+$/.test(token) && token.length > 1)
      .map(([token]) => token));
    const nextFamilies = pool
      .map(family => ({ ...family, members: family.members.filter(member => values.has(member.token)) }))
      .filter(family => family.members.length >= resolvedOptions.minMembers);
    const settled = nextFamilies.length === kept.length &&
      nextFamilies.every((family, index) =>
        family.key === kept[index].key && family.members.length === kept[index].members.length);
    kept = nextFamilies;
    if (settled) break;
  }

  // Bigger family wins a contested box; more anchor words breaks the tie.
  const assign = (families: readonly LaneFamilyCandidate[]) => {
    const roleOf = new Map<AtlasIdentifier, AtlasRoleIdentifier>();
    const laneOf = new Map<AtlasIdentifier, AtlasLaneValue>();
    const claimed = new Set<AtlasIdentifier>();
    for (const family of [...families].sort((firstFamily, secondFamily) =>
      secondFamily.members.length - firstFamily.members.length ||
      secondFamily.anchor - firstFamily.anchor ||
      (firstFamily.key < secondFamily.key ? -1 : 1)))
      for (const member of family.members) {
        if (claimed.has(member.id)) continue;
        claimed.add(member.id);
        roleOf.set(member.id, "L:" + family.key);
        laneOf.set(member.id, member.token);
      }
    return { roleOf, laneOf };
  };

  // "Pick rate" and "Damage rate" share a word and nothing else; real lane
  // siblings sit in the same place in the map, so what flows into and out of
  // them plays the same parts.
  const tentative = assign(kept);
  const around = new Map<AtlasIdentifier, Set<AtlasRoleIdentifier>>();
  for (const edge of edges) {
    if (!around.has(edge.from)) around.set(edge.from, new Set<AtlasRoleIdentifier>());
    if (!around.has(edge.to)) around.set(edge.to, new Set<AtlasRoleIdentifier>());
    around.get(edge.from)!.add(tentative.roleOf.get(edge.to) || "N:" + edge.to);
    around.get(edge.to)!.add(tentative.roleOf.get(edge.from) || "N:" + edge.from);
  }
  const survivors: LaneFamily[] = [];
  for (const family of kept) {
    const mine = family.members.filter(member => tentative.roleOf.get(member.id) === "L:" + family.key);
    if (mine.length < resolvedOptions.minMembers) continue;
    const surroundingRoleSets = mine.map(member =>
      around.get(member.id) || new Set<AtlasRoleIdentifier>());
    let pairCount = 0, totalOverlap = 0;
    for (let firstIndex = 0; firstIndex < surroundingRoleSets.length; firstIndex++)
      for (let secondIndex = firstIndex + 1; secondIndex < surroundingRoleSets.length; secondIndex++) {
        let intersectionSize = 0;
        for (const role of surroundingRoleSets[firstIndex]) {
          if (surroundingRoleSets[secondIndex].has(role)) intersectionSize++;
        }
        const unionSize = surroundingRoleSets[firstIndex].size +
          surroundingRoleSets[secondIndex].size - intersectionSize;
        totalOverlap += unionSize ? intersectionSize / unionSize : 0;
        pairCount++;
      }
    const overlap = pairCount ? totalOverlap / pairCount : 1;
    if (overlap < resolvedOptions.neighbourOverlap) {
      rejected.push({ key: family.key, why: `members sit in different parts of the map (${(overlap * 100).toFixed(0)}% shared surroundings)` });
      continue;
    }
    survivors.push({ ...family, members: mine, overlap });
  }

  const { roleOf, laneOf } = assign(survivors);
  for (const node of nodes) if (!roleOf.has(node.id)) roleOf.set(node.id, "N:" + node.id);

  const size = new Map<AtlasRoleIdentifier, number>();
  for (const role of roleOf.values()) size.set(role, (size.get(role) || 0) + 1);

  return {
    roleOf, laneOf, rejected,
    families: survivors
      .map(family => ({
        ...family,
        members: family.members.filter(member => roleOf.get(member.id) === "L:" + family.key),
      }))
      .filter(family => family.members.length >= resolvedOptions.minMembers)
      .sort((firstFamily, secondFamily) => secondFamily.members.length - firstFamily.members.length),
    laneValues: new Set(laneOf.values()),
    foldedBoxes: [...size.values()]
      .filter(memberCount => memberCount > 1)
      .reduce((total, memberCount) => total + memberCount, 0),
    roleCount: size.size,
  };
}

export const familyLabel = (key: string): string => {
  const [pre, suf] = key.split(SEP);
  return (pre ? pre + " " : "") + SLOT + (suf ? " " + suf : "");
};

export function roleLabel(role: AtlasRoleIdentifier, byId: ReadonlyMap<AtlasIdentifier, AtlasGraphNode>): string {
  if (!role.startsWith("L:")) {
    const node = byId.get(role.slice(2));
    return node ? (node.label || node.id) : role.slice(2);
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
export function stronglyConnected<Identifier>(
  identifiers: readonly Identifier[],
  successors: ReadonlyMap<Identifier, ReadonlySet<Identifier>>,
): Identifier[][] {
  const index = new Map<Identifier, number>();
  const low = new Map<Identifier, number>();
  const onStack = new Set<Identifier>();
  const stack: Identifier[] = [];
  const components: Identifier[][] = [];
  let counter = 0;
  for (const root of identifiers) {
    if (index.has(root)) continue;
    const work: Array<{ value: Identifier; children: Identifier[] | null; childIndex: number }> = [
      { value: root, children: null, childIndex: 0 },
    ];
    while (work.length) {
      const frame = work[work.length - 1];
      if (frame.children === null) {
        index.set(frame.value, counter); low.set(frame.value, counter); counter++;
        stack.push(frame.value); onStack.add(frame.value);
        frame.children = [...(successors.get(frame.value) || [])];
      }
      if (frame.childIndex < frame.children.length) {
        const child = frame.children[frame.childIndex++];
        if (!index.has(child)) work.push({ value: child, children: null, childIndex: 0 });
        else if (onStack.has(child)) {
          low.set(frame.value, Math.min(low.get(frame.value)!, index.get(child)!));
        }
        continue;
      }
      if (low.get(frame.value) === index.get(frame.value)) {
        const component: Identifier[] = [];
        for (;;) {
          const member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
          if (member === frame.value) break;
        }
        components.push(component);
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1].value;
        low.set(parent, Math.min(low.get(parent)!, low.get(frame.value)!));
      }
    }
  }
  return components;
}

export interface AtlasLoopGroup {
  id: AtlasGroupIdentifier;
  loop: boolean;
  boxes: AtlasIdentifier[];
}

export interface CollapsedAtlasLoops {
  groups: Map<AtlasGroupIdentifier, AtlasLoopGroup>;
  groupOf: Map<AtlasIdentifier, AtlasGroupIdentifier>;
  succ: Map<AtlasGroupIdentifier, Set<AtlasGroupIdentifier>>;
  pred: Map<AtlasGroupIdentifier, Set<AtlasGroupIdentifier>>;
}

export function collapseLoops(
  scope: ReadonlySet<AtlasIdentifier>,
  edges: readonly AtlasLink[],
): CollapsedAtlasLoops {
  const successorsByIdentifier = new Map<AtlasIdentifier, Set<AtlasIdentifier>>();
  for (const identifier of scope) successorsByIdentifier.set(identifier, new Set<AtlasIdentifier>());
  for (const edge of edges) {
    if (scope.has(edge.from) && scope.has(edge.to)) successorsByIdentifier.get(edge.from)!.add(edge.to);
  }

  const groupOf = new Map<AtlasIdentifier, AtlasGroupIdentifier>();
  const groups = new Map<AtlasGroupIdentifier, AtlasLoopGroup>();
  let groupNumber = 0;
  for (const component of stronglyConnected([...scope], successorsByIdentifier)) {
    const loop = component.length > 1 || successorsByIdentifier.get(component[0])!.has(component[0]);
    const groupIdentifier = "g" + (groupNumber++);
    for (const boxIdentifier of component) groupOf.set(boxIdentifier, groupIdentifier);
    groups.set(groupIdentifier, { id: groupIdentifier, loop, boxes: component });
  }
  const groupSuccessors = new Map<AtlasGroupIdentifier, Set<AtlasGroupIdentifier>>();
  const groupPredecessors = new Map<AtlasGroupIdentifier, Set<AtlasGroupIdentifier>>();
  for (const identifier of groups.keys()) {
    groupSuccessors.set(identifier, new Set<AtlasGroupIdentifier>());
    groupPredecessors.set(identifier, new Set<AtlasGroupIdentifier>());
  }
  for (const [sourceIdentifier, outgoingIdentifiers] of successorsByIdentifier)
    for (const targetIdentifier of outgoingIdentifiers) {
      const sourceGroup = groupOf.get(sourceIdentifier)!;
      const targetGroup = groupOf.get(targetIdentifier)!;
      if (sourceGroup === targetGroup) continue;
      groupSuccessors.get(sourceGroup)!.add(targetGroup);
      groupPredecessors.get(targetGroup)!.add(sourceGroup);
    }
  return { groups, groupOf, succ: groupSuccessors, pred: groupPredecessors };
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
export function shortestCycleThrough(
  boxIdentifier: AtlasIdentifier,
  adjacency: ReadonlyMap<AtlasIdentifier, readonly AtlasLink[]>,
): AtlasIdentifier[] | null {
  if ((adjacency.get(boxIdentifier) || []).some(edge => edge.to === boxIdentifier)) return [boxIdentifier];
  const previousByIdentifier = new Map<AtlasIdentifier, AtlasIdentifier>();
  const queue: AtlasIdentifier[] = [];
  for (const edge of adjacency.get(boxIdentifier) || [])
    if (!previousByIdentifier.has(edge.to)) {
      previousByIdentifier.set(edge.to, boxIdentifier);
      queue.push(edge.to);
    }
  for (let head = 0; head < queue.length; head++) {
    const identifier = queue[head];
    for (const edge of adjacency.get(identifier) || []) {
      if (edge.to === boxIdentifier) {
        const path = [identifier];
        for (
          let previousIdentifier = previousByIdentifier.get(identifier)!;
          previousIdentifier !== boxIdentifier;
          previousIdentifier = previousByIdentifier.get(previousIdentifier)!
        ) path.push(previousIdentifier);
        path.push(boxIdentifier);
        return path.reverse();
      }
      if (!previousByIdentifier.has(edge.to)) {
        previousByIdentifier.set(edge.to, identifier);
        queue.push(edge.to);
      }
    }
  }
  return null;
}

// Rotations of one loop are the same loop, so name each by the rotation that
// starts at its first box alphabetically.
export function canonicalCycle(cycle: readonly AtlasIdentifier[]): string {
  let firstIndex = 0;
  for (let index = 1; index < cycle.length; index++) {
    if (cycle[index] < cycle[firstIndex]) firstIndex = index;
  }
  return cycle.slice(firstIndex).concat(cycle.slice(0, firstIndex)).join(">");
}

export interface AtlasTangleLoop<EdgeType extends AtlasGraphEdge = AtlasGraphEdge> {
  key: string;
  cycle: AtlasIdentifier[];
  links: EdgeType[];
  sign: number;
  gain: number;
  reinforcing: boolean;
}

export interface AtlasTangle<EdgeType extends AtlasGraphEdge = AtlasGraphEdge> {
  boxes: AtlasIdentifier[];
  loops: AtlasTangleLoop<EdgeType>[];
  links: EdgeType[];
  linkCount: number;
  parallel: number;
  contradictory: number;
  independent: number;
  waysIn: AtlasIdentifier[];
  waysOut: AtlasIdentifier[];
  reinforcing: number;
  balancing: number;
}

export function analyseTangle<EdgeType extends AtlasGraphEdge>(
  boxes: readonly AtlasIdentifier[],
  edges: readonly EdgeType[],
  outsideIn: ReadonlySet<AtlasIdentifier>,
  outsideOut: ReadonlySet<AtlasIdentifier>,
): AtlasTangle<EdgeType> {
  const boxIdentifiers = [...boxes];
  const boxSet = new Set(boxIdentifiers);
  const inner = edges.filter(edge => boxSet.has(edge.from) && boxSet.has(edge.to));

  // Two boxes can be joined twice, and the two links can disagree about sign —
  // in which case the polarity of every loop through them depends on which one
  // you take. Taking whichever happened to be listed first would make the
  // answer silently arbitrary, so the stronger link wins and the count of
  // disagreements is reported rather than swallowed.
  const strongest = new Map<string, EdgeType>();
  let parallel = 0, contradictory = 0;
  for (const edge of inner) {
    const key = edge.from + "\u0001" + edge.to;
    const had = strongest.get(key);
    if (!had) { strongest.set(key, edge); continue; }
    parallel++;
    if ((had.elasticity < 0) !== (edge.elasticity < 0)) contradictory++;
    if (Math.abs(edge.elasticity) > Math.abs(had.elasticity)) strongest.set(key, edge);
  }
  const adjacency = new Map<AtlasIdentifier, EdgeType[]>(boxIdentifiers.map(identifier => [identifier, []]));
  for (const edge of strongest.values()) adjacency.get(edge.from)!.push(edge);

  const loops: AtlasTangleLoop<EdgeType>[] = [];
  const seen = new Set<string>();
  for (const boxIdentifier of boxIdentifiers) {
    const cycle = shortestCycleThrough(boxIdentifier, adjacency);
    if (!cycle) continue;
    const key = canonicalCycle(cycle);
    if (seen.has(key)) continue;
    seen.add(key);
    let sign = 1, gain = 1;
    const links: EdgeType[] = [];
    for (let cycleIndex = 0; cycleIndex < cycle.length; cycleIndex++) {
      const sourceIdentifier = cycle[cycleIndex];
      const targetIdentifier = cycle[(cycleIndex + 1) % cycle.length];
      const edge = adjacency.get(sourceIdentifier)!.find(
        candidateEdge => candidateEdge.to === targetIdentifier,
      );
      if (!edge) { sign = 0; break; }
      links.push(edge);
      sign *= edge.elasticity < 0 ? -1 : 1;
      gain *= Math.abs(edge.elasticity);
    }
    if (!sign) continue;
    loops.push({ key, cycle, links, sign, gain, reinforcing: sign > 0 });
  }
  loops.sort((firstLoop, secondLoop) =>
    secondLoop.gain - firstLoop.gain || firstLoop.cycle.length - secondLoop.cycle.length);

  return {
    boxes: boxIdentifiers, loops,
    links: [...strongest.values()],
    linkCount: inner.length,
    parallel, contradictory,
    // How many loops it would take to generate every loop in here. The plain
    // count of loops can run to thousands; this one is small and exact.
    independent: inner.length - boxIdentifiers.length + 1,
    waysIn: [...outsideIn], waysOut: [...outsideOut],
    reinforcing: loops.filter(loop => loop.reinforcing).length,
    balancing: loops.filter(loop => !loop.reinforcing).length,
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
export function orderTangle(
  boxes: readonly AtlasIdentifier[],
  links: readonly AtlasLink[],
): AtlasIdentifier[] {
  const outgoingDegree = new Map<AtlasIdentifier, number>();
  const incomingDegree = new Map<AtlasIdentifier, number>();
  const outgoingIdentifiers = new Map<AtlasIdentifier, AtlasIdentifier[]>();
  const incomingIdentifiers = new Map<AtlasIdentifier, AtlasIdentifier[]>();
  for (const boxIdentifier of boxes) {
    outgoingDegree.set(boxIdentifier, 0);
    incomingDegree.set(boxIdentifier, 0);
    outgoingIdentifiers.set(boxIdentifier, []);
    incomingIdentifiers.set(boxIdentifier, []);
  }
  for (const link of links) {
    if (!outgoingDegree.has(link.from) || !incomingDegree.has(link.to)) continue;
    outgoingDegree.set(link.from, outgoingDegree.get(link.from)! + 1);
    incomingDegree.set(link.to, incomingDegree.get(link.to)! + 1);
    outgoingIdentifiers.get(link.from)!.push(link.to);
    incomingIdentifiers.get(link.to)!.push(link.from);
  }
  const left: AtlasIdentifier[] = [];
  const right: AtlasIdentifier[] = [];
  const gone = new Set<AtlasIdentifier>();
  const drop = (identifier: AtlasIdentifier) => {
    gone.add(identifier);
    for (const outgoingIdentifier of outgoingIdentifiers.get(identifier)!) {
      if (!gone.has(outgoingIdentifier)) {
        incomingDegree.set(outgoingIdentifier, incomingDegree.get(outgoingIdentifier)! - 1);
      }
    }
    for (const incomingIdentifier of incomingIdentifiers.get(identifier)!) {
      if (!gone.has(incomingIdentifier)) {
        outgoingDegree.set(incomingIdentifier, outgoingDegree.get(incomingIdentifier)! - 1);
      }
    }
  };
  while (gone.size < boxes.length) {
    let moved = true;
    while (moved) {
      moved = false;
      for (const identifier of boxes) if (!gone.has(identifier) && outgoingDegree.get(identifier) === 0) {
        right.unshift(identifier); drop(identifier); moved = true;
      }
      for (const identifier of boxes) if (!gone.has(identifier) && incomingDegree.get(identifier) === 0 && outgoingDegree.get(identifier)! > 0) {
        left.push(identifier); drop(identifier); moved = true;
      }
    }
    if (gone.size >= boxes.length) break;
    let best: AtlasIdentifier | null = null;
    let score = -Infinity;
    for (const identifier of boxes) {
      if (gone.has(identifier)) continue;
      const candidateScore = outgoingDegree.get(identifier)! - incomingDegree.get(identifier)!;
      if (candidateScore > score) { score = candidateScore; best = identifier; }
    }
    if (best === null) throw new Error("Tangle ordering could not select a remaining box.");
    left.push(best); drop(best);
  }
  return left.concat(right);
}

// Everything the wheel is drawn from. Computed when a tangle is opened rather
// than when the atlas is built, so a map full of feedback still builds in the
// time it takes to draw one frame.
export type AtlasWheelEdge = AtlasGraphEdge;

export interface AtlasWheelLoop {
  back: AtlasWheelEdge;
  links: AtlasWheelEdge[];
  cycle: string[];
  reinforcing: boolean;
  gain: number;
}

export interface AtlasWheel {
  order: string[];
  pos: Map<string, number>;
  forward: AtlasWheelEdge[];
  back: AtlasWheelEdge[];
  loops: AtlasWheelLoop[];
  share: Map<string, number>;
  touching: Map<string, AtlasWheelEdge[]>;
  links: AtlasWheelEdge[];
}

export interface AtlasWheelTangle {
  boxes: readonly string[];
  links: readonly AtlasWheelEdge[];
}

export function wheelOf(tangle: AtlasWheelTangle): AtlasWheel {
  const boxIdentifiers = [...tangle.boxes];
  const boxIdentifierSet = new Set(boxIdentifiers);
  const links = tangle.links.filter(edge =>
    boxIdentifierSet.has(edge.from) && boxIdentifierSet.has(edge.to));
  const order = orderTangle(boxIdentifiers, links);
  const positionByBoxIdentifier = new Map<string, number>(
    order.map((boxIdentifier, index) => [boxIdentifier, index]),
  );
  const forward: AtlasWheelEdge[] = [], back: AtlasWheelEdge[] = [];
  for (const edge of links) {
    ((positionByBoxIdentifier.get(edge.to) || 0) > (positionByBoxIdentifier.get(edge.from) || 0)
      ? forward
      : back).push(edge);
  }

  // The forward links alone are acyclic, so the way home from a back link is a
  // shortest path in a DAG — no search, just relax in order. A few back links
  // cannot get home that way, because their return needs another back link;
  // those fall back to a plain search, so every back link gets its loop.
  const forwardEdgesBySourceIdentifier = new Map<string, AtlasWheelEdge[]>(
    boxIdentifiers.map(boxIdentifier => [boxIdentifier, []]),
  );
  for (const edge of forward) forwardEdgesBySourceIdentifier.get(edge.from)!.push(edge);
  const allEdgesBySourceIdentifier = new Map<string, AtlasWheelEdge[]>(
    boxIdentifiers.map(boxIdentifier => [boxIdentifier, []]),
  );
  for (const edge of links) allEdgesBySourceIdentifier.get(edge.from)!.push(edge);

  const loops: AtlasWheelLoop[] = [];
  for (const backEdge of back) {
    const distanceByBoxIdentifier = new Map<string, number>([[backEdge.to, 0]]);
    const previousEdgeByBoxIdentifier = new Map<string, AtlasWheelEdge>();
    for (const boxIdentifier of order) {
      if (!distanceByBoxIdentifier.has(boxIdentifier)) continue;
      for (const forwardEdge of forwardEdgesBySourceIdentifier.get(boxIdentifier)!) {
        const nextDistance = distanceByBoxIdentifier.get(boxIdentifier)! + 1;
        if (!distanceByBoxIdentifier.has(forwardEdge.to) ||
            distanceByBoxIdentifier.get(forwardEdge.to)! > nextDistance) {
          distanceByBoxIdentifier.set(forwardEdge.to, nextDistance);
          previousEdgeByBoxIdentifier.set(forwardEdge.to, forwardEdge);
        }
      }
    }
    const chain: AtlasWheelEdge[] = [];
    if (distanceByBoxIdentifier.has(backEdge.from)) {
      for (let currentIdentifier = backEdge.from; currentIdentifier !== backEdge.to; ) {
        const previousEdge = previousEdgeByBoxIdentifier.get(currentIdentifier)!;
        chain.unshift(previousEdge);
        currentIdentifier = previousEdge.from;
      }
    } else {
      const seenEdgeByBoxIdentifier = new Map<string, AtlasWheelEdge>();
      const queue = [backEdge.to];
      for (let queueIndex = 0; queueIndex < queue.length; queueIndex++) {
        for (const candidateEdge of allEdgesBySourceIdentifier.get(queue[queueIndex]) || []) {
          if (seenEdgeByBoxIdentifier.has(candidateEdge.to) || candidateEdge.to === backEdge.to) continue;
          seenEdgeByBoxIdentifier.set(candidateEdge.to, candidateEdge);
          queue.push(candidateEdge.to);
        }
      }
      if (!seenEdgeByBoxIdentifier.has(backEdge.from)) continue;
      for (let currentIdentifier = backEdge.from; currentIdentifier !== backEdge.to; ) {
        const previousEdge = seenEdgeByBoxIdentifier.get(currentIdentifier)!;
        chain.unshift(previousEdge);
        currentIdentifier = previousEdge.from;
      }
    }
    const links = chain.concat([backEdge]);
    let sign = 1, gain = 1;
    for (const link of links) {
      if (link.elasticity < 0) sign = -sign;
      gain *= Math.abs(link.elasticity);
    }
    loops.push({
      back: backEdge,
      links,
      cycle: links.map(link => link.from),
      reinforcing: sign > 0,
      gain,
    });
  }

  const share = new Map<string, number>(boxIdentifiers.map(boxIdentifier => [boxIdentifier, 0]));
  for (const loop of loops) {
    for (const boxIdentifier of loop.cycle) {
      share.set(boxIdentifier, (share.get(boxIdentifier) || 0) + 1);
    }
  }
  const touching = new Map<string, AtlasWheelEdge[]>(boxIdentifiers.map(boxIdentifier => [boxIdentifier, []]));
  for (const edge of links) {
    touching.get(edge.from)!.push(edge);
    touching.get(edge.to)!.push(edge);
  }

  return {
    order,
    pos: positionByBoxIdentifier,
    forward,
    back,
    loops,
    share,
    touching,
    links,
  };
}

// ---------------------------------------------------------------------------
// 3. REFINE THE GROUPING UNTIL IT IS TRUE
// ---------------------------------------------------------------------------
// Start from what the names propose, then repeatedly split each group whose
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
export function quotientHasCycle<Identifier>(
  identifiers: readonly Identifier[],
  successors: ReadonlyMap<Identifier, ReadonlySet<Identifier>>,
  classByIdentifier: ReadonlyMap<Identifier, string>,
): boolean {
  const classSuccessors = new Map<string, Set<string>>();
  for (const identifier of identifiers) {
    const classIdentifier = classByIdentifier.get(identifier);
    if (classIdentifier === undefined) {
      throw new Error("Every identifier must have a quotient class.");
    }
    if (!classSuccessors.has(classIdentifier)) classSuccessors.set(classIdentifier, new Set<string>());
  }
  for (const identifier of identifiers) {
    const classIdentifier = classByIdentifier.get(identifier)!;
    for (const successor of successors.get(identifier) || []) {
      const successorClass = classByIdentifier.get(successor);
      if (successorClass === undefined) {
        throw new Error("Every successor must have a quotient class.");
      }
      if (successorClass === classIdentifier) return true;
      classSuccessors.get(classIdentifier)!.add(successorClass);
    }
  }
  return stronglyConnected([...classSuccessors.keys()], classSuccessors).some(component => component.length > 1);
}

export interface AtlasRefinement<Identifier> {
  cls: Map<Identifier, AtlasClassIdentifier>;
  rounds: number;
  settled: boolean;
}

export function refineForward<Identifier>(
  identifiers: readonly Identifier[],
  successors: ReadonlyMap<Identifier, ReadonlySet<Identifier>>,
  initial: ReadonlyMap<Identifier, string>,
  strict: boolean,
): AtlasRefinement<Identifier> {
  let classByIdentifier = new Map<Identifier, AtlasClassIdentifier>();
  for (const identifier of identifiers) {
    const initialClass = initial.get(identifier);
    if (initialClass === undefined) {
      throw new Error("Every identifier must have an initial refinement class.");
    }
    classByIdentifier.set(identifier, initialClass);
  }
  let classCount = new Set(classByIdentifier.values()).size;
  for (let round = 0; round <= identifiers.length + 1; round++) {
    if (!strict && !quotientHasCycle(identifiers, successors, classByIdentifier)) {
      return { cls: classByIdentifier, rounds: round, settled: false };
    }
    const signatureByIdentifier = new Map<Identifier, string>();
    const renamedClassBySignature = new Map<string, AtlasClassIdentifier>();
    for (const identifier of identifiers) {
      const outgoingClasses = [...new Set(
        [...(successors.get(identifier) || [])].map(successor => {
          const successorClass = classByIdentifier.get(successor);
          if (successorClass === undefined) {
            throw new Error("Every successor must be included in forward refinement.");
          }
          return successorClass;
        }),
      )].sort().join(",");
      signatureByIdentifier.set(identifier, classByIdentifier.get(identifier)! + SEP + outgoingClasses);
    }
    for (const identifier of identifiers) {
      const signature = signatureByIdentifier.get(identifier)!;
      if (!renamedClassBySignature.has(signature)) {
        renamedClassBySignature.set(signature, "c" + renamedClassBySignature.size);
      }
    }
    if (renamedClassBySignature.size === classCount) {
      return { cls: classByIdentifier, rounds: round, settled: true };
    }
    classByIdentifier = new Map(
      identifiers.map(identifier => [identifier, renamedClassBySignature.get(signatureByIdentifier.get(identifier)!)!]),
    );
    classCount = renamedClassBySignature.size;
  }
  return { cls: classByIdentifier, rounds: identifiers.length, settled: true };
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
export type AtlasAdjacencyReader<Identifier> = (identifier: Identifier) => readonly Identifier[];

export function reversePostorder<Identifier>(
  root: Identifier,
  successorsOf: AtlasAdjacencyReader<Identifier>,
): Identifier[] {
  const seen = new Set<Identifier>([root]);
  const postorder: Identifier[] = [];
  const stack: Array<{ identifier: Identifier; children: readonly Identifier[] | null; childIndex: number }> = [
    { identifier: root, children: null, childIndex: 0 },
  ];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.children === null) frame.children = successorsOf(frame.identifier);
    if (frame.childIndex < frame.children.length) {
      const successor = frame.children[frame.childIndex++];
      if (!seen.has(successor)) {
        seen.add(successor);
        stack.push({ identifier: successor, children: null, childIndex: 0 });
      }
      continue;
    }
    postorder.push(frame.identifier); stack.pop();
  }
  return postorder.reverse();
}

export function immediateDominators<Identifier>(
  root: Identifier,
  successorsOf: AtlasAdjacencyReader<Identifier>,
  predecessorsOf: AtlasAdjacencyReader<Identifier>,
): Map<Identifier, Identifier> {
  const reversePostorderIdentifiers = reversePostorder(root, successorsOf);
  const orderByIdentifier = new Map(reversePostorderIdentifiers.map((identifier, index) => [identifier, index]));
  const immediateDominatorByIdentifier = new Map<Identifier, Identifier>([[root, root]]);
  const intersect = (firstIdentifier: Identifier, secondIdentifier: Identifier): Identifier => {
    while (firstIdentifier !== secondIdentifier) {
      while (orderByIdentifier.get(firstIdentifier)! > orderByIdentifier.get(secondIdentifier)!) {
        firstIdentifier = immediateDominatorByIdentifier.get(firstIdentifier)!;
      }
      while (orderByIdentifier.get(secondIdentifier)! > orderByIdentifier.get(firstIdentifier)!) {
        secondIdentifier = immediateDominatorByIdentifier.get(secondIdentifier)!;
      }
    }
    return firstIdentifier;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const identifier of reversePostorderIdentifiers) {
      if (identifier === root) continue;
      let candidate: Identifier | null = null;
      for (const predecessor of predecessorsOf(identifier)) {
        if (!orderByIdentifier.has(predecessor) || !immediateDominatorByIdentifier.has(predecessor)) continue;
        candidate = candidate === null ? predecessor : intersect(predecessor, candidate);
      }
      if (candidate !== null && immediateDominatorByIdentifier.get(identifier) !== candidate) {
        immediateDominatorByIdentifier.set(identifier, candidate); changed = true;
      }
    }
  }
  return immediateDominatorByIdentifier;
}

// Exact totals: paths(n) is how many pathways run from n to the finish, summed
// over successors in reverse topological order. BigInt, because on a real map
// this number is genuinely astronomical.
export function countPaths(
  start: AtlasClassIdentifier,
  successorsOf: AtlasAdjacencyReader<AtlasClassIdentifier>,
): Map<AtlasClassIdentifier, bigint> {
  const topologicalOrder = reversePostorder(start, successorsOf);
  const paths = new Map<AtlasClassIdentifier, bigint>([[END, 1n]]);
  for (let index = topologicalOrder.length - 1; index >= 0; index--) {
    const identifier = topologicalOrder[index];
    if (identifier === END) continue;
    let total = 0n;
    for (const successor of successorsOf(identifier)) total += paths.get(successor) || 0n;
    paths.set(identifier, total);
  }
  return paths;
}

export function addFinish(
  successors: Map<AtlasClassIdentifier, Set<AtlasClassIdentifier>>,
  predecessors: Map<AtlasClassIdentifier, Set<AtlasClassIdentifier>> | null,
): AtlasClassIdentifier[] {
  successors.set(END, new Set<AtlasClassIdentifier>());
  if (predecessors) predecessors.set(END, new Set<AtlasClassIdentifier>());
  const finishes: AtlasClassIdentifier[] = [];
  for (const [id, outs] of successors) {
    if (id === END || outs.size) continue;
    finishes.push(id);
    outs.add(END);
    if (predecessors) predecessors.get(END)!.add(id);
  }
  return finishes;
}

// ---------------------------------------------------------------------------
// 5. THE ATLAS
// ---------------------------------------------------------------------------
export interface AtlasBuildOptions {
  stopAtOutcomes?: boolean;
  lanes?: LaneDetectionOptions;
  grouping?: "strict" | "loose";
}

export interface AtlasElement<EdgeType extends AtlasGraphEdge = AtlasGraphEdge> {
  id: AtlasClassIdentifier;
  label: string;
  loop: boolean;
  boxes: AtlasIdentifier[];
  lanes: Set<AtlasLaneValue>;
  copies: number;
  roles: Set<AtlasRoleIdentifier>;
  tangles: AtlasTangle<EdgeType>[];
  end?: boolean;
}

export interface AtlasBoxSequenceItem {
  kind: "box";
  id: AtlasClassIdentifier;
}

export interface AtlasJoinSequenceItem {
  kind: "join";
  id: AtlasClassIdentifier;
}

export interface AtlasAlternative {
  first: AtlasClassIdentifier;
  shapes: bigint;
  seq: AtlasSequence;
}

export interface AtlasChoiceSequenceItem {
  kind: "choice";
  at: AtlasClassIdentifier;
  rejoin: AtlasClassIdentifier | null;
  alts: AtlasAlternative[];
}

export type AtlasSequenceItem = AtlasBoxSequenceItem | AtlasJoinSequenceItem | AtlasChoiceSequenceItem;
export type AtlasSequence = AtlasSequenceItem[];

export interface AtlasFeedbackLoop<EdgeType extends AtlasGraphEdge = AtlasGraphEdge>
  extends AtlasTangleLoop<EdgeType> {
  element: AtlasClassIdentifier;
  elementLabel: string;
  copies: number;
  lanes: Set<AtlasLaneValue>;
  tangleSize: number;
  independent: number;
}

export interface AtlasSplitFamily {
  key: string;
  into: number;
}

export interface AtlasResult<EdgeType extends AtlasGraphEdge = AtlasGraphEdge> {
  startId: AtlasIdentifier;
  start: AtlasClassIdentifier;
  tree: AtlasSequence;
  nodes: Map<AtlasClassIdentifier, AtlasElement<EdgeType>>;
  succ: Map<AtlasClassIdentifier, Set<AtlasClassIdentifier>>;
  pred: Map<AtlasClassIdentifier, Set<AtlasClassIdentifier>>;
  ipdom: Map<AtlasClassIdentifier, AtlasClassIdentifier>;
  paths: Map<AtlasClassIdentifier, bigint>;
  lanes: LaneDetection;
  scope: Set<AtlasIdentifier>;
  finishes: AtlasClassIdentifier[];
  tails: Map<AtlasClassIdentifier, AtlasSequence>;
  stepLanes: Map<string, Set<AtlasLaneValue>>;
  stepTakenBy: Map<string, Set<AtlasGroupIdentifier>>;
  grouping: "strict" | "loose";
  everyStepShared: boolean;
  partialSteps: number;
  totalSteps: number;
  loops: AtlasElement<EdgeType>[];
  feedback: AtlasFeedbackLoop<EdgeType>[];
  shapes: bigint;
  pathways: bigint;
  boxesInScope: number;
  elements: number;
  elementsUngrouped: number;
  splitFamilies: AtlasSplitFamily[];
  refineRounds: number;
  ms: number;
}

export interface AtlasSequenceBuildContext<EdgeType extends AtlasGraphEdge = AtlasGraphEdge> {
  nodes: Map<AtlasClassIdentifier, AtlasElement<EdgeType>>;
  ipdom: Map<AtlasClassIdentifier, AtlasClassIdentifier>;
  paths: Map<AtlasClassIdentifier, bigint>;
  succ: AtlasAdjacencyReader<AtlasClassIdentifier>;
  END: typeof END;
  limit: number;
  emitted: Set<AtlasClassIdentifier>;
  tails: Map<AtlasClassIdentifier, AtlasSequence>;
}

export function buildAtlas<NodeType extends AtlasGraphNode, EdgeType extends AtlasGraphEdge>(
  graph: AtlasGraph<NodeType, EdgeType>,
  startId: AtlasIdentifier,
  options: AtlasBuildOptions = {},
): AtlasResult<EdgeType> {
  const t0 = Date.now();
  const stopAt = options.stopAtOutcomes
    ? new Set<AtlasIdentifier>(graph.nodes.filter(node => node.direction).map(node => node.id))
    : null;

  const scope = reachableFrom(graph, startId, stopAt);
  const scopedNodes = graph.nodes.filter(node => scope.has(node.id));
  const scopedEdges = graph.edges.filter(edge =>
    scope.has(edge.from) && scope.has(edge.to) &&
    !(stopAt && stopAt.has(edge.from) && edge.from !== startId));

  const lanes = detectLanes(scopedNodes, scopedEdges, options.lanes || {});
  const collapsedLoops = collapseLoops(scope, scopedEdges);
  const startGroup = collapsedLoops.groupOf.get(startId);
  if (!startGroup || !graph.byId.has(startId)) {
    throw new Error(`Cannot build an Atlas from unknown start box "${startId}".`);
  }

  // What the names propose. Identical loops in different lanes get the same
  // proposal, so four copies of one feedback loop become one element.
  const initial = new Map<AtlasGroupIdentifier, string>();
  for (const [groupIdentifier, group] of collapsedLoops.groups) {
    if (groupIdentifier === startGroup) { initial.set(groupIdentifier, "START"); continue; }
    const roles = [...new Set(group.boxes.map(boxIdentifier => lanes.roleOf.get(boxIdentifier)!))].sort();
    initial.set(groupIdentifier, group.loop ? "LOOP:" + roles.join("+") : roles[0]);
  }

  // Unpack every tangle once, before anything is folded, so polarity and gain
  // are read off the real links rather than off the grouped ones.
  const tangles = new Map<AtlasGroupIdentifier, AtlasTangle<EdgeType>>();
  for (const [groupIdentifier, group] of collapsedLoops.groups) {
    if (!group.loop) continue;
    const boxIdentifierSet = new Set<AtlasIdentifier>(group.boxes);
    const outsideEntryIdentifiers = new Set<AtlasIdentifier>();
    const outsideExitIdentifiers = new Set<AtlasIdentifier>();
    for (const edge of scopedEdges) {
      if (!boxIdentifierSet.has(edge.from) && boxIdentifierSet.has(edge.to)) {
        outsideEntryIdentifiers.add(edge.to);
      }
      if (boxIdentifierSet.has(edge.from) && !boxIdentifierSet.has(edge.to)) {
        outsideExitIdentifiers.add(edge.from);
      }
    }
    tangles.set(groupIdentifier, analyseTangle(
      group.boxes,
      scopedEdges,
      outsideEntryIdentifiers,
      outsideExitIdentifiers,
    ));
  }

  const groupIdentifiers = [...collapsedLoops.groups.keys()];
  const refined = refineForward(
    groupIdentifiers,
    collapsedLoops.succ,
    initial,
    options.grouping === "strict",
  );
  const classOf = refined.cls;

  // The quotient: one element per settled class.
  const nodes = new Map<AtlasClassIdentifier, AtlasElement<EdgeType>>();
  const successors = new Map<AtlasClassIdentifier, Set<AtlasClassIdentifier>>();
  const predecessors = new Map<AtlasClassIdentifier, Set<AtlasClassIdentifier>>();
  for (const groupIdentifier of groupIdentifiers) {
    const classIdentifier = classOf.get(groupIdentifier)!;
    let node = nodes.get(classIdentifier);
    if (!node) {
      nodes.set(classIdentifier, node = {
        id: classIdentifier, label: "", loop: false, boxes: [], lanes: new Set<AtlasLaneValue>(),
        copies: 0, roles: new Set<AtlasRoleIdentifier>(), tangles: [],
      });
      successors.set(classIdentifier, new Set<AtlasClassIdentifier>());
      predecessors.set(classIdentifier, new Set<AtlasClassIdentifier>());
    }
    const group = collapsedLoops.groups.get(groupIdentifier)!;
    node.copies++;
    node.loop = node.loop || group.loop;
    if (group.loop && tangles.has(groupIdentifier)) node.tangles.push(tangles.get(groupIdentifier)!);
    for (const boxIdentifier of group.boxes) {
      node.boxes.push(boxIdentifier);
      node.roles.add(lanes.roleOf.get(boxIdentifier)!);
      const lane = lanes.laneOf.get(boxIdentifier);
      if (lane) node.lanes.add(lane);
    }
  }
  // Which lanes actually take each step, and which do not. On the looser
  // setting this is the whole story of where the strands differ, so it is
  // recorded rather than inferred.
  const stepLanes = new Map<string, Set<AtlasLaneValue>>();
  const stepTakenBy = new Map<string, Set<AtlasGroupIdentifier>>();
  for (const [sourceGroupIdentifier, outgoingGroupIdentifiers] of collapsedLoops.succ)
    for (const targetGroupIdentifier of outgoingGroupIdentifiers) {
      const sourceClassIdentifier = classOf.get(sourceGroupIdentifier)!;
      const targetClassIdentifier = classOf.get(targetGroupIdentifier)!;
      if (sourceClassIdentifier === targetClassIdentifier) continue;
      successors.get(sourceClassIdentifier)!.add(targetClassIdentifier);
      predecessors.get(targetClassIdentifier)!.add(sourceClassIdentifier);
      const key = sourceClassIdentifier + ">" + targetClassIdentifier;
      if (!stepLanes.has(key)) {
        stepLanes.set(key, new Set<AtlasLaneValue>());
        stepTakenBy.set(key, new Set<AtlasGroupIdentifier>());
      }
      stepTakenBy.get(key)!.add(sourceGroupIdentifier);
      for (const box of collapsedLoops.groups.get(sourceGroupIdentifier)!.boxes) {
        const lane = lanes.laneOf.get(box);
        if (lane) stepLanes.get(key)!.add(lane);
      }
    }

  // How many steps on the page are taken by only some members of their group.
  // Zero on the strict setting by construction; on the looser one this is the
  // honest measure of what the condensation is glossing over.
  let partialSteps = 0;
  const membersOf = new Map<AtlasClassIdentifier, number>();
  for (const groupIdentifier of groupIdentifiers) {
    const classIdentifier = classOf.get(groupIdentifier)!;
    membersOf.set(classIdentifier, (membersOf.get(classIdentifier) || 0) + 1);
  }
  for (const [key, takers] of stepTakenBy)
    if (takers.size < membersOf.get(key.split(">")[0])!) partialSteps++;
  for (const node of nodes.values()) {
    const roles = [...node.roles];
    node.label = node.loop
      ? loopLabel(node, graph)
      : roles.length === 1 && node.boxes.length > 1
        ? roleLabel(roles[0], graph.byId)
        : graph.byId.get(node.boxes[0])?.label || node.boxes[0];
  }

  const start = classOf.get(startGroup)!;
  nodes.set(END, {
    id: END, label: "end", loop: false, boxes: [], lanes: new Set<AtlasLaneValue>(),
    copies: 0, roles: new Set<AtlasRoleIdentifier>(), tangles: [], end: true,
  });
  const finishes = addFinish(successors, predecessors);
  const successorsOf = (identifier: AtlasClassIdentifier) => [...(successors.get(identifier) || [])];
  const predecessorsOf = (identifier: AtlasClassIdentifier) => [...(predecessors.get(identifier) || [])];
  const immediatePostDominators = immediateDominators(END, predecessorsOf, successorsOf);
  const paths = countPaths(start, successorsOf);

  // The same structure with no grouping at all, so the condensation is
  // measured rather than asserted and the true pathway total is to hand.
  const ungroupedSuccessors = new Map<AtlasGroupIdentifier, Set<AtlasGroupIdentifier>>();
  for (const groupIdentifier of groupIdentifiers) {
    ungroupedSuccessors.set(groupIdentifier, new Set(collapsedLoops.succ.get(groupIdentifier)));
  }
  addFinish(ungroupedSuccessors, null);
  const rawPaths = countPaths(
    startGroup,
    identifier => [...(ungroupedSuccessors.get(identifier) || [])],
  );

  const sequenceBuildContext: AtlasSequenceBuildContext<EdgeType> = {
    nodes, ipdom: immediatePostDominators, paths, succ: successorsOf, END,
    limit: nodes.size + 8,
    emitted: new Set<AtlasClassIdentifier>(),
    tails: new Map<AtlasClassIdentifier, AtlasSequence>(),
  };
  const tree = buildSequence(start, END, sequenceBuildContext);

  // Where a proposed family had to be split because its members stopped
  // behaving alike. Not a failure — this is the divergence, named.
  const splits = new Map<AtlasRoleIdentifier, Set<AtlasClassIdentifier>>();
  for (const [groupIdentifier, classIdentifier] of classOf) {
    const proposal = initial.get(groupIdentifier)!;
    if (!proposal.startsWith("L:")) continue;
    if (!splits.has(proposal)) splits.set(proposal, new Set<AtlasClassIdentifier>());
    splits.get(proposal)!.add(classIdentifier);
  }

  return {
    startId, start, tree, nodes,
    succ: successors,
    pred: predecessors,
    ipdom: immediatePostDominators,
    paths, lanes, scope, finishes,
    tails: sequenceBuildContext.tails, stepLanes, stepTakenBy,
    grouping: options.grouping === "strict" ? "strict" : "loose",
    everyStepShared: partialSteps === 0,
    partialSteps, totalSteps: stepTakenBy.size,
    loops: [...nodes.values()].filter(node => node.loop),
    feedback: gatherFeedback(nodes),
    shapes: paths.get(start) || 0n,
    pathways: rawPaths.get(startGroup) || 0n,
    boxesInScope: scope.size,
    elements: nodes.size - 1,
    elementsUngrouped: groupIdentifiers.length,
    splitFamilies: [...splits]
      .filter(([, classIdentifiers]) => classIdentifiers.size > 1)
      .map(([role, classIdentifiers]) => ({ key: role.slice(2), into: classIdentifiers.size }))
      .sort((firstSplit, secondSplit) => secondSplit.into - firstSplit.into),
    refineRounds: refined.rounds,
    ms: Date.now() - t0,
  };
}

// A loop is named after its strongest loop when that is short enough to read,
// and by its size when it is not. Reciting 108 member names, which is what this
// used to do, is the opposite of a name.
export function loopLabel<EdgeType extends AtlasGraphEdge, NodeType extends AtlasGraphNode>(
  node: AtlasElement<EdgeType>,
  graph: Pick<AtlasGraph<NodeType, EdgeType>, "byId">,
): string {
  const t = node.tangles[0];
  if (!t || !t.loops.length) return `feedback loop of ${node.boxes.length} boxes`;
  // One loop can be named after itself. A tangle of many cannot — naming it
  // after the strongest implies the others are variations on it, and they are
  // not, so it is named by what it is instead.
  if (t.loops.length === 1)
    return t.loops[0].cycle.map(boxIdentifier => graph.byId.get(boxIdentifier)?.label || boxIdentifier).join(" ⇄ ");
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
export function buildSequence<EdgeType extends AtlasGraphEdge>(
  entry: AtlasClassIdentifier,
  stop: AtlasClassIdentifier,
  context: AtlasSequenceBuildContext<EdgeType>,
): AtlasSequence {
  const items: AtlasSequence = [];
  let currentIdentifier = entry;
  let iterationCount = 0;
  while (currentIdentifier !== stop && currentIdentifier !== context.END) {
    if (iterationCount++ > context.limit) {
      throw new Error("region walk failed to terminate at " + currentIdentifier);
    }
    if (context.emitted.has(currentIdentifier)) {
      items.push({ kind: "join", id: currentIdentifier });
      break;
    }
    context.emitted.add(currentIdentifier);
    items.push({ kind: "box", id: currentIdentifier });
    const outgoingIdentifiers = context.succ(currentIdentifier);
    if (outgoingIdentifiers.length === 0) break;
    if (outgoingIdentifiers.length === 1) {
      currentIdentifier = outgoingIdentifiers[0];
      continue;
    }
    const rejoin = context.ipdom.get(currentIdentifier);
    if (rejoin === undefined) {
      throw new Error(`No post-dominator exists for Atlas split "${currentIdentifier}".`);
    }
    const whole = context.paths.get(rejoin) || 1n;
    const alternatives: AtlasAlternative[] = outgoingIdentifiers.map(successor => ({
      first: successor,
      shapes: (context.paths.get(successor) || 0n) / whole,
      seq: successor === rejoin ? [] : buildSequence(successor, rejoin, context),
    })).sort((first, second) => (first.shapes > second.shapes ? -1 : first.shapes < second.shapes ? 1 : 0));
    items.push({
      kind: "choice",
      at: currentIdentifier,
      rejoin: rejoin === context.END ? null : rejoin,
      alts: alternatives,
    });
    currentIdentifier = rejoin;
  }
  // What follows each element, so a "joins here" reads as the stretch it
  // points at rather than as a dead end.
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (item.kind === "box") context.tails.set(item.id, items.slice(index));
  }
  return items;
}

// ---------------------------------------------------------------------------
// 6. READING AIDS
// ---------------------------------------------------------------------------
// Which lanes reach a stretch. One only some lanes can reach is a real
// divergence — the pocket where those lanes behave unlike the rest.
export function lanesIn(
  sequence: readonly AtlasSequenceItem[],
  nodes: ReadonlyMap<AtlasClassIdentifier, Pick<AtlasElement, "lanes">>,
  into = new Set<AtlasLaneValue>(),
): Set<AtlasLaneValue> {
  for (const item of sequence) {
    if (item.kind === "choice") for (const alternative of item.alts) lanesIn(alternative.seq, nodes, into);
    else for (const lane of nodes.get(item.id)?.lanes || []) into.add(lane);
  }
  return into;
}

export function boxesIn(
  sequence: readonly AtlasSequenceItem[],
  nodes: ReadonlyMap<AtlasClassIdentifier, Pick<AtlasElement, "boxes">>,
  into = new Set<AtlasIdentifier>(),
): Set<AtlasIdentifier> {
  for (const item of sequence) {
    if (item.kind === "choice") for (const alternative of item.alts) boxesIn(alternative.seq, nodes, into);
    else for (const boxIdentifier of nodes.get(item.id)?.boxes || []) into.add(boxIdentifier);
  }
  return into;
}

export interface AtlasItemCount {
  boxes: number;
  choices: number;
  joins: number;
  depth: number;
}

export function countItems(
  sequence: readonly AtlasSequenceItem[],
  accumulator: AtlasItemCount = { boxes: 0, choices: 0, joins: 0, depth: 0 },
  depth = 0,
): AtlasItemCount {
  accumulator.depth = Math.max(accumulator.depth, depth);
  for (const item of sequence) {
    if (item.kind === "box") accumulator.boxes++;
    else if (item.kind === "join") accumulator.joins++;
    else {
      accumulator.choices++;
      for (const alternative of item.alts) countItems(alternative.seq, accumulator, depth + 1);
    }
  }
  return accumulator;
}

export function formatCount(value: bigint | number | string): string {
  const numericValue = typeof value === "bigint" ? value : BigInt(value);
  if (numericValue < 1000000000000000n) return Number(numericValue).toLocaleString("en-GB");
  const s = numericValue.toString();
  return s[0] + "." + s.slice(1, 3) + " × 10^" + (s.length - 1);
}

// Every loop on the map in one list, strongest first, each knowing which
// element it lives in and how many places that element stands for.
export function gatherFeedback<EdgeType extends AtlasGraphEdge>(
  nodes: ReadonlyMap<AtlasClassIdentifier, AtlasElement<EdgeType>>,
): AtlasFeedbackLoop<EdgeType>[] {
  const out: AtlasFeedbackLoop<EdgeType>[] = [];
  for (const node of nodes.values()) {
    if (!node.loop || !node.tangles.length) continue;
    const t = node.tangles[0];
    for (const loop of t.loops)
      out.push({ ...loop, element: node.id, elementLabel: node.label,
                 copies: node.tangles.length, lanes: node.lanes,
                 tangleSize: t.boxes.length, independent: t.independent });
  }
  return out.sort((firstLoop, secondLoop) =>
    secondLoop.gain - firstLoop.gain || firstLoop.cycle.length - secondLoop.cycle.length);
}

// ---------------------------------------------------------------------------
// MEASUREMENTS THE VIEWS SHARE
// ---------------------------------------------------------------------------
// paths(n) is how many readings run from n to the finish. Going the other way
// gives how many run from the start into n, and multiplying the two gives the
// weight of n: how much of everything passes through it. That single number is
// what makes a flow diagram, a proportional block and a bar all say the same
// thing rather than three different things.
export interface AtlasMeasurement {
  order: AtlasClassIdentifier[];
  into: Map<AtlasClassIdentifier, bigint>;
  depth: Map<AtlasClassIdentifier, number>;
  total: bigint;
  weight: (identifier: AtlasClassIdentifier) => number;
  linkWeight: (sourceIdentifier: AtlasClassIdentifier, targetIdentifier: AtlasClassIdentifier) => number;
}

export function measure(atlas: Pick<AtlasResult, "succ" | "start" | "paths">): AtlasMeasurement {
  const successorsOf = (identifier: AtlasClassIdentifier) => [...(atlas.succ.get(identifier) || [])];
  const order = reversePostorder(atlas.start, successorsOf);
  const into = new Map<AtlasClassIdentifier, bigint>([[atlas.start, 1n]]);
  const depth = new Map<AtlasClassIdentifier, number>([[atlas.start, 0]]);
  for (const identifier of order) {
    const readingsIntoIdentifier = into.get(identifier) || 0n;
    const identifierDepth = depth.get(identifier) || 0;
    for (const successor of successorsOf(identifier)) {
      into.set(successor, (into.get(successor) || 0n) + readingsIntoIdentifier);
      if ((depth.get(successor) || 0) < identifierDepth + 1) depth.set(successor, identifierDepth + 1);
    }
  }
  const total = atlas.paths.get(atlas.start) || 1n;
  const share = (value: bigint) => (total > 0n ? Number((value * 1000000n) / total) / 1000000 : 0);
  return {
    order, into, depth, total,
    weight: identifier => share((into.get(identifier) || 0n) * (atlas.paths.get(identifier) || 0n)),
    linkWeight: (sourceIdentifier, targetIdentifier) =>
      share((into.get(sourceIdentifier) || 0n) * (atlas.paths.get(targetIdentifier) || 0n)),
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
export interface AtlasStrandOptions {
  limit?: number;
  through?: AtlasClassIdentifier | null;
}

export interface AtlasStrandResult {
  list: AtlasClassIdentifier[][];
  truncated: boolean;
  reachable: boolean;
}

export function strands(
  atlas: Pick<AtlasResult, "start" | "succ">,
  options: AtlasStrandOptions = {},
): AtlasStrandResult {
  const limit = Math.max(1, options.limit || 200);
  const through = options.through || null;
  const FRONTIER = Math.max(2000, limit * 50);   // a hairball must not eat memory

  // Filtering by an element: before the walk reaches it, step only into
  // elements that can still get there. Everything after it is unconstrained.
  let gate: Set<AtlasClassIdentifier> | null = null;
  if (through) {
    const predecessorsByIdentifier = new Map<AtlasClassIdentifier, AtlasClassIdentifier[]>();
    for (const [identifier, successors] of atlas.succ) {
      for (const successor of successors) {
        if (!predecessorsByIdentifier.has(successor)) predecessorsByIdentifier.set(successor, []);
        predecessorsByIdentifier.get(successor)!.push(identifier);
      }
    }
    gate = new Set<AtlasClassIdentifier>([through]);
    const stack: AtlasClassIdentifier[] = [through];
    while (stack.length) {
      const identifier = stack.pop()!;
      for (const predecessor of predecessorsByIdentifier.get(identifier) || []) {
        if (!gate.has(predecessor)) { gate.add(predecessor); stack.push(predecessor); }
      }
    }
    if (!gate.has(atlas.start)) return { list: [], truncated: false, reachable: false };
  }

  const out: AtlasClassIdentifier[][] = [];
  let level: AtlasClassIdentifier[][] = [[atlas.start]];
  let truncated = false;

  while (level.length && out.length < limit) {
    const next: AtlasClassIdentifier[][] = [];
    for (const path of level) {
      if (out.length >= limit) break;
      const tail = path[path.length - 1];
      const passed = !through || path.indexOf(through) >= 0;
      for (const successor of atlas.succ.get(tail) || []) {
        if (successor === END) { if (passed) out.push(path); continue; }
        if (path.indexOf(successor) >= 0) continue;         // acyclic already, but cheap
        if (gate && !passed && !gate.has(successor)) continue;
        if (next.length >= FRONTIER) { truncated = true; break; }
        next.push(path.concat([successor]));
      }
    }
    level = next;
  }
  return { list: out.slice(0, limit), truncated: truncated || out.length >= limit, reachable: true };
}
