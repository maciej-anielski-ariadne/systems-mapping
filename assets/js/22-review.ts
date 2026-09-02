// =============================================================================
// REVIEW — the two questions you cannot answer by reading a large map
// -----------------------------------------------------------------------------
// A map of a dozen boxes is verified by looking at it. A map of ninety is not:
// the same box appears in one column of a seventeen-column table, its formula
// in a two-hundred-pixel text field, and its behaviour only when you happen to
// drag the right slider. This module computes the two things that scale.
//
//   1. WHAT THE LOADER NOTICED, grouped by cause (findings, below).
//      The loader already checks a great deal — every formula parses, every name
//      resolves, every box rests where it says it does — and every check reports
//      into one list. The problem was never the checking; it was that a flat
//      list gives a mistake and its ten downstream shadows the same weight.
//      attributeFindings() separates the two, so the panel can show seven things
//      to fix rather than seventeen things to read.
//
//   2. WHAT EACH ADJUSTABLE BOX ACTUALLY DOES (runSweep, below).
//      Nudge one box, solve, see what moved; repeat for every one. Nothing
//      here is invalid — every finding it turns up computes perfectly and would
//      pass every check in (1). It is just not what anyone intended: an input
//      that moves nothing at all, one that reaches a single box and stops, one
//      that only ever pushes down. Validation cannot see any of it, because
//      none of it is a mistake in the file. It is a mistake in the model.
//
// Everything here is READ-ONLY with respect to the live map. The sweep saves the
// sliders, solves off to the side, and puts them back — see runSweep.
// =============================================================================

import type { Finding, FindingSeverity, GraphNode } from "./types";
import { NODES, state, nodeById, incomingEdges, outgoingEdges } from "./03-state";
import {
  computeNodeValues,
  recomputeValues,
  explainNode,
  getParsedFormula,
  solverGeneration,
  formulaArms,
  DELTA_DISPLAY_THRESHOLD_PCT,
} from "./07-simulation-engine";

// ═════════════════════════════════════════════════════════════════════════════
// PART 1 — FINDINGS
// ═════════════════════════════════════════════════════════════════════════════

// The loader builds findings through this rather than pushing strings, so every
// finding arrives knowing its box and its severity. Positional-free on purpose:
// at twenty-eight call sites, a bare `finding(a, b, c, d)` would be unreadable.
export function finding(
  kind: string,
  severity: FindingSeverity,
  message: string,
  extra?: { boxId?: string; fix?: string },
): Finding {
  const f: Finding = { kind: kind, severity: severity, message: message };
  if (extra && extra.boxId) f.boxId = extra.boxId;
  if (extra && extra.fix)   f.fix = extra.fix;
  return f;
}

// The kind the rest-state check reports under. Named once here because the
// cause/consequence split below turns entirely on telling these apart from
// every other kind of finding.
export const REST_DRIFT = "rest-drift";

// ───── Cause, or consequence? ─────────────────────────────────────────────
// A box that does not rest at its starting value is either the origin of the
// problem or someone else's problem arriving. The test is local and exact:
//
//   does this box READ another box that is also drifting?
//
// If it does, its own number is off because its input's number is off, and
// fixing the input fixes it. If it does not — every box feeding it is sitting
// exactly where it says it does — then whatever is wrong started here, in this
// box's own formula or limits.
//
// Worth being precise about what this is NOT: it is not "does this box have a
// formula". On the map that produced this design, one broken formula and one
// perfectly healthy formula both drifted; the healthy one was drifting only
// because it read the broken one. The rule above tells them apart and "has a
// formula" does not.
//
// LOOPS are handled by the walk rather than by a special case. Every box inside
// a drifting feedback loop has a drifting input (that is what a loop means), so
// none of them is a cause; the walk out of the loop finds the box that fed the
// error in. A loop with no way out stays unattributed and is shown as a cause,
// which is the honest answer — nobody can say which box in a ring started it.
function readsFrom(node: GraphNode): string[] {
  // What a box reads is not always what points at it. A formula box is computed
  // from its formula ALONE, so an incoming link it never names feeds it nothing
  // — attributing its drift to that link would send the reader to a box that
  // has no bearing on the number.
  const parsed = node.formula ? getParsedFormula(node.id) : undefined;
  if (parsed) return parsed.references.concat(parsed.delayReferences);
  return (incomingEdges[node.id] || []).map(edge => edge.from);
}

/**
 * Mark every finding that is only the downstream shadow of another box's
 * mistake, and order the list causes-first. Returns the same array, mutated —
 * it is the loader's own `errors` array and other code already holds it.
 */
export function attributeFindings(findings: Finding[]): Finding[] {
  const drifting = new Set<string>();
  for (const f of findings) if (f.kind === REST_DRIFT && f.boxId) drifting.add(f.boxId);

  // Build the drifting subgraph once. The previous implementation walked the
  // same upstream chain independently for every finding, making a simple chain
  // quadratic. Distances from all causes give every box its nearest healthy
  // upstream boundary in O(nodes + links); resolving through the first source
  // at each distance preserves the old breadth-first tie order.
  const driftingSources = new Map<string, string[]>();
  const driftingDependants = new Map<string, string[]>();
  for (const identifier of drifting) {
    const node = nodeById[identifier];
    const sources = node
      ? readsFrom(node).filter(sourceIdentifier => drifting.has(sourceIdentifier))
      : [];
    driftingSources.set(identifier, sources);
    for (const sourceIdentifier of sources) {
      const dependants = driftingDependants.get(sourceIdentifier);
      if (dependants) dependants.push(identifier);
      else driftingDependants.set(sourceIdentifier, [identifier]);
    }
  }

  const distanceFromCause = new Map<string, number>();
  const queue: string[] = [];
  for (const identifier of drifting) {
    if ((driftingSources.get(identifier) || []).length === 0) {
      distanceFromCause.set(identifier, 0);
      queue.push(identifier);
    }
  }
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex++) {
    const sourceIdentifier = queue[queueIndex];
    const nextDistance = distanceFromCause.get(sourceIdentifier)! + 1;
    for (const dependantIdentifier of driftingDependants.get(sourceIdentifier) || []) {
      if (distanceFromCause.has(dependantIdentifier)) continue;
      distanceFromCause.set(dependantIdentifier, nextDistance);
      queue.push(dependantIdentifier);
    }
  }

  const rootCauseByIdentifier = new Map<string, string>();
  for (const identifier of queue) {
    const distance = distanceFromCause.get(identifier);
    if (distance === undefined) continue;
    if (distance === 0) {
      rootCauseByIdentifier.set(identifier, identifier);
      continue;
    }
    const precedingSource = (driftingSources.get(identifier) || [])
      .find(sourceIdentifier => distanceFromCause.get(sourceIdentifier) === distance - 1);
    if (!precedingSource) continue;
    const rootCause = rootCauseByIdentifier.get(precedingSource);
    if (rootCause) rootCauseByIdentifier.set(identifier, rootCause);
  }

  for (const f of findings) {
    if (f.kind !== REST_DRIFT || !f.boxId) continue;
    if (distanceFromCause.get(f.boxId) === 0) continue;
    const rootCause = rootCauseByIdentifier.get(f.boxId);
    if (rootCause && rootCause !== f.boxId) f.causedBy = rootCause;
  }

  // Causes first, then consequences; within each, worst severity first. A
  // stable sort keeps the loader's own order inside a tie, which is the order
  // the sections of the spreadsheet were read in — a sensible tiebreak.
  const rank: Record<FindingSeverity, number> = { ignored: 0, wrong: 1, mismatch: 2 };
  findings.sort((a, b) => {
    const consequence = (a.causedBy ? 1 : 0) - (b.causedBy ? 1 : 0);
    if (consequence !== 0) return consequence;
    return rank[a.severity] - rank[b.severity];
  });
  return findings;
}

// ───── One card per thing to fix ──────────────────────────────────────────
export interface FindingGroup {
  /** The box the card is about, when there is one. */
  boxId?: string;
  label: string;
  /** The findings that are this box's own doing. Usually one. */
  causes: Finding[];
  /** Findings elsewhere that this box is responsible for. */
  consequences: Finding[];
  /** Worst severity among the causes — what the card's dot shows. */
  severity: FindingSeverity;
}

export interface ReviewSummary {
  groups: FindingGroup[];
  /** Total findings, causes and consequences together. */
  total: number;
  /** How many are somebody else's fault arriving. */
  consequenceCount: number;
}

export function groupFindings(findings: Finding[]): ReviewSummary {
  const rank: Record<FindingSeverity, number> = { ignored: 0, wrong: 1, mismatch: 2 };
  const byBox = new Map<string, FindingGroup>();
  const order: string[] = [];
  let consequenceCount = 0;

  const groupFor = (key: string, boxId: string | undefined, label: string): FindingGroup => {
    let group = byBox.get(key);
    if (!group) {
      group = { boxId: boxId, label: label, causes: [], consequences: [], severity: "mismatch" };
      byBox.set(key, group);
      order.push(key);
    }
    return group;
  };

  // Causes first so a consequence always finds its cause's card already made —
  // attributeFindings() has ordered the list exactly that way.
  for (const f of findings) {
    if (f.causedBy) {
      consequenceCount++;
      const node = nodeById[f.causedBy];
      groupFor(f.causedBy, f.causedBy, (node && node.label) || f.causedBy).consequences.push(f);
      continue;
    }
    // A finding with no box (a missing section, a link between boxes that do not
    // exist) still needs somewhere to go: it gets its own card, keyed by kind so
    // several of the same shape sit together.
    const key = f.boxId || ("kind:" + f.kind);
    const node = f.boxId ? nodeById[f.boxId] : undefined;
    const group = groupFor(key, f.boxId, (node && node.label) || f.boxId || "The spreadsheet");
    group.causes.push(f);
    if (rank[f.severity] < rank[group.severity]) group.severity = f.severity;
  }

  // A box can pick up consequences without having a cause of its own — it drifts
  // because of an upstream box, and something further down drifts because of it.
  // Those cards would be headed by nothing, so fold them into the real cause.
  const groups = order.map(key => byBox.get(key)!).filter(g => g.causes.length > 0);

  return {
    groups: groups,
    total: findings.length,
    consequenceCount: consequenceCount,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// PART 2 — THE SENSITIVITY SWEEP
// ═════════════════════════════════════════════════════════════════════════════
// Every adjustable box, one at a time, nudged up by one step with everything
// else left at its starting value. What moves, and by how much.
//
// This is cheap in a way that is worth stating, because it looks expensive:
// computeNodeValues() builds and returns a FRESH values object and never writes
// state.computedValues, so the whole sweep runs beside the live map rather than
// through it. On the ninety-box map this design was built against, all
// thirty-three solves plus the diffing came in under a tenth of a second.
//
// The one cost: the loop leaves the engine's incremental-solve cache pointing at
// a solve nobody kept, so the first slider drag afterwards takes the cold path.
// recomputeValues() at the end puts the live numbers back; the next drag is
// simply a fraction slower than it would otherwise have been.

/** How far each adjustable box is nudged. A tenth is enough to move anything that moves,
 *  and small enough that a box near a limit does not simply slam into it. */
export const SWEEP_STEP = 0.10;

export interface SweepMove {
  id: string;
  label: string;
  /** Signed % against where this box sits when nothing has been asked of the
   *  map — NOT against its declared starting value. See runSweep. */
  pct: number;
}

export interface SweepRow {
  id: string;
  label: string;
  /** How many boxes this input moves at all. */
  reach: number;
  /** Everything it moves, biggest first. */
  moves: SweepMove[];
}

export interface Sweep {
  step: number;
  /** One row per adjustable box, furthest reach first. */
  rows: SweepRow[];
  /** Quantified boxes no adjustable box reaches at all. */
  unreached: SweepMove[];
  /** How many boxes the sweep could move at all — the denominator on a row. */
  reachableCount: number;
}

/**
 * Solve the map once per adjustable box. Read-only: the live sliders and the
 * live values are exactly as they were when this returns.
 */
export function runSweep(step: number = SWEEP_STEP): Sweep {
  const inputs = NODES.filter(n => n.controllable && n.baseline);
  const targets = NODES.filter(n => n.baseline && !n.controllable);

  const saved = { ...state.userOverrides };

  // THE MAP AT REST, measured rather than assumed. Every figure below is a
  // change against THIS, not against the boxes' declared starting values, and
  // the difference is the whole correctness of the sweep.
  //
  // On a healthy map the two are the same thing: with every slider at 100% each
  // box sits exactly on the value it declares, so subtracting either gives the
  // same answer. On a map where they have come apart — a formula that disagrees
  // with the starting value typed beside it, a limit that excludes it, both of
  // which the findings on the other half of this panel are about — measuring
  // against the declared value adds that standing drift to every row. The drift
  // is the same for every input and is often enormous (one box on the map this
  // was found on stood at +661%), so it swamps the effect entirely and every
  // input reports the same three "biggest movers": the drift, not the slider.
  //
  // Which is worth stating plainly: the sweep would have been at its most
  // useless on exactly the maps that most need it.
  state.userOverrides = {};
  const rest = computeNodeValues();

  const rows: SweepRow[] = [];
  const everMoved = new Set<string>();

  // try/finally, because the restore below is a PROMISE this function makes to
  // the rest of the app: the live sliders are exactly as they were when it
  // returns. Without it, a solve that threw anywhere in the loop left the map
  // holding the last nudge — one box silently pinned 10% above its starting
  // value, and every number downstream of it read against that.
  try {
    for (const input of inputs) {
      // One input held above its starting value, every other slider at 100% —
      // NOT wherever the user happens to have left it. The question the sweep
      // answers is about the map, so it has to be asked from the map's own
      // resting state or two runs of it would not be comparable.
      state.userOverrides = { [input.id]: 1 + step };
      const values = computeNodeValues();

      const moves: SweepMove[] = [];
      for (const target of targets) {
        const from = rest[target.id];
        const value = values[target.id];
        if (value === undefined || from === undefined || from === 0) continue;
        const pct = ((value - from) / from) * 100;
        // The map's own "is this worth drawing?" threshold, so the sweep counts a
        // box as moved if and only if the map would show it moving.
        if (!Number.isFinite(pct) || Math.abs(pct) < DELTA_DISPLAY_THRESHOLD_PCT) continue;
        moves.push({ id: target.id, label: target.label, pct: pct });
        everMoved.add(target.id);
      }
      moves.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
      rows.push({ id: input.id, label: input.label, reach: moves.length, moves: moves });
    }
  } finally {
    state.userOverrides = saved;
    recomputeValues();
  }

  rows.sort((a, b) => b.reach - a.reach || a.label.localeCompare(b.label));
  return {
    step: step,
    rows: rows,
    unreached: targets.filter(t => !everMoved.has(t.id))
                      .map(t => ({ id: t.id, label: t.label, pct: 0 })),
    reachableCount: targets.length,
  };
}

// ───── The handful worth looking at ───────────────────────────────────────
// Four classes, and deliberately only four. A fifth — "this input moves a box
// the wrong way for its own direction" — was built, measured, and left out: on
// the healthy ninety-box map it fired fifty-nine times, nearly all of them
// trade-offs the author meant (more inspection, longer queues; more arrivals,
// a thinner coverage share). A flag that is wrong fifty-five times out of
// fifty-nine does not survive contact with a real map, and it would have buried
// the four below. It becomes worth shipping when it can tell a sign error from
// a modelled cost — a move against direction along a route with no negative
// strength anywhere on it — or when a finding can be acknowledged once and
// stop asking. Neither is built yet, so it is not offered.

export interface SweepException {
  kind: "moves-nothing" | "single-effect" | "one-way" | "dominant";
  severity: FindingSeverity;
  boxId: string;
  title: string;
  detail: string;
  fix: string;
  /** For "moves-nothing": the gate that explains it, when there is one. */
  gate?: { boxId: string; label: string; arms: { text: string; value: number; binding: boolean }[] };
}

export function sweepExceptions(sweep: Sweep): SweepException[] {
  const out: SweepException[] = [];
  if (sweep.rows.length === 0) return out;

  const stepPct = Math.round(sweep.step * 100);

  for (const row of sweep.rows) {
    if (row.reach !== 0) continue;
    // "It moves nothing" is a symptom. The answer is nearly always that the box
    // it feeds is a gate and this input is not the arm that binds — so go and
    // ask, rather than leaving the reader to click through and find out.
    const gate = gateBehind(row.id);
    out.push({
      kind: "moves-nothing",
      severity: "wrong",
      boxId: row.id,
      title: row.label + " moves nothing",
      detail: gate
        ? "Up " + stepPct + "% and not one box on the map changes. It feeds " + gate.label +
          ", whose value is whichever of these is smallest — and this input is not that one."
        : "Up " + stepPct + "% and not one box on the map changes. Nothing downstream of it is quantified, " +
          "or every route out of it ends at a box with no starting value.",
      fix: gate
        ? "Either this is not the constraint anyone thinks it is, or the binding arm is set too low."
        : "Give the boxes it feeds a starting value, or draw the link that is missing.",
      gate: gate || undefined,
    });
  }

  const single = sweep.rows.filter(r => r.reach === 1);
  if (single.length) {
    out.push({
      kind: "single-effect",
      severity: "wrong",
      boxId: single[0].id,
      title: single.length === 1
        ? single[0].label + " reaches exactly one box"
        : single.length + " adjustable boxes reach exactly one box",
      detail: single.map(r => r.label + " → " + r.moves[0].label +
        " (" + signed(r.moves[0].pct) + ")").join(" · ") +
        ". Each moves one box and stops: nothing downstream of that box is quantified.",
      fix: "Fine if deliberate — worth confirming once per box.",
    });
  }

  for (const row of sweep.rows) {
    if (row.reach < 1) continue;
    if (row.moves.some(m => m.pct > 0)) continue;
    out.push({
      kind: "one-way",
      severity: "mismatch",
      boxId: row.id,
      title: row.label + " only ever pushes down",
      detail: "Every box it reaches goes down. Arithmetically that can be right — a share with a " +
        "bigger denominator does exactly this — but it means the map has no route by which this " +
        "input does anything else at all.",
      fix: "A missing link, or a box downstream that was never given a starting value.",
    });
  }

  // The single point the map is most sensitive to. Only worth saying when one
  // input really does stand out — a map whose top two are neck and neck has no
  // such point, and saying so anyway would be noise.
  const top = sweep.rows[0];
  const second = sweep.rows[1];
  if (top && top.reach > 0 && (!second || top.reach >= second.reach * 1.4)) {
    out.push({
      kind: "dominant",
      severity: "mismatch",
      boxId: top.id,
      title: top.label + " is the map's single point of leverage",
      detail: "It reaches " + top.reach + " of " + sweep.reachableCount + " boxes" +
        (second ? ", against " + second.reach + " for the next one" : "") + ".",
      fix: "Not a fault — but it is what a result read off this map depends on most.",
    });
  }

  if (sweep.unreached.length) {
    out.push({
      kind: "moves-nothing",
      severity: "wrong",
      boxId: sweep.unreached[0].id,
      title: sweep.unreached.length + " box" + (sweep.unreached.length === 1 ? "" : "es") +
        " no input can reach",
      detail: sweep.unreached.slice(0, 6).map(u => u.label).join(" · ") +
        (sweep.unreached.length > 6 ? " and " + (sweep.unreached.length - 6) + " more" : "") +
        ". Nothing the reader can move changes any of them.",
      fix: "Either they are inputs in their own right, or the link that would drive them is missing.",
    });
  }

  const rank: Record<FindingSeverity, number> = { ignored: 0, wrong: 1, mismatch: 2 };
  out.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return out;
}

// The gate that explains a dead input: walk its links out, and take the first
// target whose value is a min() of arms — the shape that lets an input be
// connected, quantified, and still change nothing.
function gateBehind(inputId: string): SweepException["gate"] | undefined {
  for (const edge of outgoingEdges[inputId] || []) {
    const arms = formulaArms(edge.to);
    if (!arms || arms.length < 2) continue;
    // Only interesting if THIS input is on a slack arm. On the binding arm it
    // would move the box, and we would not be here.
    const onBinding = arms.some(a => a.binding && a.boxIds.indexOf(inputId) !== -1);
    if (onBinding) continue;
    const target = nodeById[edge.to];
    return { boxId: edge.to, label: (target && target.label) || edge.to, arms: arms };
  }
  return undefined;
}

function signed(pct: number): string {
  return (pct > 0 ? "+" : "") + pct.toFixed(1) + "%";
}

// ───── Cached across solves, recomputed when the map changes ──────────────
// A sweep is a property of the map's shape, so it survives every slider drag and
// dies with the next edit. solverGeneration() is exactly that clock.
let cachedSweep: Sweep | null = null;
let cachedGeneration = -1;

export function currentSweep(): Sweep {
  const generation = solverGeneration();
  if (cachedSweep && cachedGeneration === generation) return cachedSweep;
  cachedSweep = runSweep();
  cachedGeneration = generation;
  return cachedSweep;
}

export function invalidateSweep(): void {
  cachedSweep = null;
  cachedGeneration = -1;
}

// Whether a sweep would say anything at all. Asked before the panel offers the
// section, so a map with no adjustable boxes gets an explanation rather than an
// empty list.
export function sweepIsPossible(): boolean {
  return NODES.some(n => n.controllable && n.baseline) &&
         NODES.some(n => n.baseline && !n.controllable);
}

// Re-exported so the panel has one import for everything review-shaped.
export { explainNode };
