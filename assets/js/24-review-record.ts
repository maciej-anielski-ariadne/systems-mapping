// =============================================================================
// THE REVIEW RECORD — who checked what, when, and whether it still holds
// -----------------------------------------------------------------------------
// A review pass over a large map is worth nothing if it cannot be picked up
// tomorrow, handed to a colleague, or trusted a month later. So the verdicts
// live in the SPREADSHEET, in an optional `# SECTION: reviews` block that the
// parser carries through untouched and older builds ignore — the same graceful
// degradation the `params` section was designed around.
//
// THE UNIT OF REVIEW IS A BOX'S INPUTS, NOT A LINK.
// Reviewing links one at a time cannot find a link that is MISSING, because a
// missing link is not an item in any queue. Reviewing "here is everything that
// feeds this box — is this right, and is it complete?" catches all four things
// that go wrong on a large map at once: a link that should not be there, a
// wrong direction or strength, a box that is itself wrong, and — because the
// question is about completeness — the one that is not there at all.
//
// It also gives a clean queue: 88 boxes rather than 141 links on the map this
// was built against, with every link reviewed exactly once, as part of its
// target's set.
//
// THE FINGERPRINT IS WHAT MAKES IT AN AUDIT RECORD RATHER THAN THEATRE.
// A sign-off has to expire when the thing it signed off changes. Each verdict
// stores a fingerprint of what was actually reviewed — the incoming links, their
// sources, effects and strengths, plus the box's own rule. Edit any of it and
// the verdict reads as STALE rather than agreed, and the box returns to the
// queue. Without that, "reviewed" decays into "was reviewed once, before who
// knows what edits", which is worse than no record at all because people trust
// it.
// =============================================================================

import type { GraphNode, ReviewEntry, Verdict } from "./types";
import { NODES, state, nodeById, incomingEdges, topologicalOrder, stageById } from "./03-state";
import { resolveEdgeElasticity } from "./07-simulation-engine";
import { serializeLiveStateToCsv, csvRow } from "./05a-csv-serializer";
import { saveCsvToStorage } from "./04a-storage";

export type { ReviewEntry, Verdict };

export type ReviewState = "unreviewed" | "agreed" | "flagged" | "stale";

// ───── The fingerprint ────────────────────────────────────────────────────
// Everything a reviewer was actually looking at when they judged the box, and
// nothing else. Deliberately NOT the box's label or description: renaming a box
// does not invalidate a judgement about what feeds it, and treating it as if it
// did would retire verdicts for spelling fixes and teach people to ignore the
// stale mark.
//
// Sources are sorted, so reordering the spreadsheet's rows is not a change.
export function fingerprintOf(node: GraphNode): string {
  const parts = (incomingEdges[node.id] || [])
    .map(edge => edge.from + ">" + edge.effect + ">" + resolveEdgeElasticity(edge).toFixed(4))
    .sort();
  // The box's own rule belongs in here too: switching from the default rule to
  // `min`, or adding a formula, changes what its inputs MEAN even when the
  // links themselves are untouched.
  parts.push("rule:" + (node.formula || node.combine || "default"));
  parts.push("limits:" + (node.minValue ?? "") + ".." + (node.maxValue ?? ""));

  // A short non-cryptographic digest — this guards against drift, not tampering,
  // and it has to survive a round trip through a spreadsheet cell.
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  const text = parts.join("|");
  for (let i = 0; i < text.length; i++) {
    h1 = ((h1 ^ text.charCodeAt(i)) * 16777619) >>> 0;
    h2 = ((h2 + text.charCodeAt(i) * (i + 1)) * 2654435761) >>> 0;
  }
  return (h1.toString(36) + h2.toString(36)).slice(0, 10);
}

// ───── Reading the record ─────────────────────────────────────────────────
export function entryFor(boxId: string): ReviewEntry | undefined {
  return state.reviews[boxId];
}

export function reviewStateOf(boxId: string): ReviewState {
  const entry = state.reviews[boxId];
  if (!entry) return "unreviewed";
  const node = nodeById[boxId];
  if (!node) return "unreviewed";
  // A record with no verdict in it is a comment somebody left while deciding,
  // not a judgement — so the box is still unreviewed, and there is nothing for
  // an edit to expire. Checked before the fingerprint for exactly that reason.
  if (entry.verdict === "none") return "unreviewed";
  if (entry.fingerprint !== fingerprintOf(node)) return "stale";
  return entry.verdict;
}

/** Whether anybody has written anything about this box, verdict or not. */
export function commentOn(boxId: string): string {
  const entry = state.reviews[boxId];
  return entry ? entry.note : "";
}

/** Boxes still wanting a verdict — never reviewed, or reviewed and since changed. */
export function outstanding(): string[] {
  return queueOrder().filter(id => {
    const s = reviewStateOf(id);
    return s === "unreviewed" || s === "stale";
  });
}

export interface Coverage {
  total: number;
  agreed: number;
  flagged: number;
  stale: number;
  unreviewed: number;
}

export function coverage(): Coverage {
  const out: Coverage = { total: 0, agreed: 0, flagged: 0, stale: 0, unreviewed: 0 };
  for (const id of queueOrder()) {
    out.total++;
    out[reviewStateOf(id)]++;
  }
  return out;
}

// ───── The queue ──────────────────────────────────────────────────────────
// Causes before effects. Reviewing a box after the boxes that feed it means
// every judgement stands on ones already made, and it is how a room works
// through a causal story out loud. topologicalOrder is already maintained by
// the loader, so this is an ordering rather than a computation.
//
// EVERY box, starting boxes included. They were left out on the reasoning that
// "is this everything that drives this box?" has no useful answer for a box
// nothing drives — which mistook a different question for no question. The
// question a starting box asks is "should anything drive this?", and it is one
// of the few a map gets badly wrong: the sweep's own check for a box no input
// can reach is exactly this question asked arithmetically, and on the 300-box
// example map it comes back fifty times. Leaving them out also meant those
// fifty boxes had nowhere to record an answer — no queue position, so no
// verdict card, so no way to say "yes, that is meant to be a driver box" and
// have it stick. A starting box is where a causal story begins; it is the first
// thing to agree, not the one thing nobody may judge.
export function queueOrder(): string[] {
  const ordered = topologicalOrder.slice();
  // A box in a feedback loop may be missing from the topological order; nothing
  // should be unreviewable because of where it sits, so any stragglers go last.
  const seen = new Set(ordered);
  for (const node of NODES) if (!seen.has(node.id)) ordered.push(node.id);
  return ordered;
}

/** Position of a box in the queue, 1-based. 0 when it is not in the queue. */
export function queuePosition(boxId: string): number {
  return queueOrder().indexOf(boxId) + 1;
}

/** The next box wanting a verdict after this one, wrapping to the start. */
export function nextOutstanding(afterBoxId: string | null): string | null {
  const queue = queueOrder();
  const start = afterBoxId ? queue.indexOf(afterBoxId) + 1 : 0;
  for (let i = 0; i < queue.length; i++) {
    const id = queue[(start + i) % queue.length];
    const s = reviewStateOf(id);
    if (s === "unreviewed" || s === "stale") return id;
  }
  return null;
}

/** The box before / after this one in the queue, reviewed or not. */
export function stepQueue(fromBoxId: string, delta: number): string | null {
  const queue = queueOrder();
  const at = queue.indexOf(fromBoxId);
  if (at === -1) return queue.length ? queue[0] : null;
  const next = at + delta;
  if (next < 0 || next >= queue.length) return null;
  return queue[next];
}

// ───── Writing the record ─────────────────────────────────────────────────
// ───── Who is signing ─────────────────────────────────────────────────────
/**
 * A reviewer's NAME, not their initials.
 *
 * A review record outlives the session it was made in — that is the whole point
 * of keeping it in the spreadsheet — and "MA" means nothing to whoever opens the
 * file next year, or to the person the log is shown to. So the pass will not
 * start, and a flag will not close, until there is a name to put on it.
 *
 * The test: at least two words, at least four letters between them, and at least
 * one word of two letters or more. That rejects "MA", "M A" and "M.A." while
 * accepting "Jo Ng" and "J. Smith". It does mean a mononym has to be written
 * with something after it, which is the cost of drawing the line anywhere.
 */
export function isFullName(name: string): boolean {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return false;
  const letters = parts.map(p => p.replace(/[^\p{L}]/gu, ""));
  return letters.join("").length >= 4 && letters.some(l => l.length >= 2);
}

/** Whether whoever is at the keyboard has given a name worth recording. */
export function reviewerNamed(): boolean {
  return isFullName(state.reviewer);
}

export function recordVerdict(
  boxId: string,
  verdict: Verdict,
  options?: {
    note?: string; flaggedSources?: string[]; reviewer?: string; date?: string;
    addressedNote?: string;
  },
): void {
  const node = nodeById[boxId];
  if (!node) return;
  const previous = state.reviews[boxId];
  const when = (options && options.date) || today();
  const who = (options && options.reviewer) || state.reviewer || "";
  // Worked out before the dates are, because whether a concern still stands
  // turns on whether its reason is still written down — see raisedAndClosed.
  const note = options && options.note !== undefined ? options.note
             : (previous ? previous.note : "");
  const raised = raisedAndClosed(previous, verdict, when, who, note);
  state.reviews[boxId] = {
    boxId: boxId,
    verdict: verdict,
    reviewer: who,
    date: when,
    note: note,
    fingerprint: fingerprintOf(node),
    flaggedSources: (options && options.flaggedSources) ||
                    (previous ? previous.flaggedSources.slice() : []),
    flaggedOn: raised.flaggedOn,
    flaggedBy: raised.flaggedBy,
    addressedOn: raised.addressedOn,
    addressedBy: raised.addressedBy,
    // Only an agreement can carry an account of what was done. A new concern has
    // not been dealt with, and a withdrawn one was never dealt with either — in
    // both cases last time's account must not survive into it.
    addressedNote: verdict !== "agreed" ? ""
      : options && options.addressedNote !== undefined ? options.addressedNote
      : (previous ? previous.addressedNote : ""),
    // Kept for display only, and kept fresh: it is what lets the log still name
    // this box after somebody deletes it.
    label: node.label || boxId,
    // Writing a verdict on a box means the box is here.
    removedOn: "",
  };
}

/**
 * The two dates a flag has: when it was raised, and when it was closed out.
 *
 * `reviewer` / `date` on the entry always name the LATEST verdict, which after
 * a flag is closed is whoever closed it. Without these, an exported log could
 * only ever say "agreed by B on the 27th" for a box A had flagged a week
 * earlier — the concern, and the fact that anybody ever had one, would be
 * invisible in the record. That is precisely the thing the log exists to show.
 */
function raisedAndClosed(
  previous: ReviewEntry | undefined,
  verdict: Verdict,
  when: string,
  who: string,
  note: string,
): { flaggedOn: string; flaggedBy: string; addressedOn: string; addressedBy: string } {
  // AN UNANSWERED CONCERN IS A FLAG *OR* A NOTE — the same two things
  // needsResponse counts, and for the same reason: writing down what is wrong
  // with a box is saying something is wrong with it. Reading only the flag here
  // meant a concern raised in the note field, or one whose flag had been taken
  // back with the words left standing, closed with an account of what was done
  // and NOBODY'S NAME OR DATE against it — "addressed on" and "addressed by"
  // blank in the exported log, and the panel's "raised by … closed by …" line
  // missing altogether, on exactly the concern the log exists to trace.
  const wasOpen = !!previous && previous.verdict !== "agreed" &&
                  (previous.verdict === "flagged" || !!previous.note.trim());
  let flaggedOn   = previous ? previous.flaggedOn   : "";
  let flaggedBy   = previous ? previous.flaggedBy   : "";
  let addressedOn = previous ? previous.addressedOn : "";
  let addressedBy = previous ? previous.addressedBy : "";

  if (verdict === "flagged") {
    // Raising a NEW concern starts a new cycle. Pressing Flag on a box that is
    // already carrying an unanswered one is not a new concern, and must not move
    // the date. The second test is for a row written before these columns
    // existed: the concern is open and has no date on it, so this is the first
    // chance to give it one.
    if (!wasOpen || !flaggedOn) { flaggedOn = when; flaggedBy = who; }
    // An open concern has not been addressed, whatever happened last time round.
    addressedOn = "";
    addressedBy = "";
  } else if (verdict === "none") {
    // The judgement was taken back. If the REASON is still written down the
    // concern still stands — needsResponse says so — so the raise stands with
    // it, and clearing it here would have the log carry a closure with nothing
    // to close. With nothing written, nothing was raised and nothing was
    // closed, and neither date may stand.
    if (!note.trim()) { flaggedOn = ""; flaggedBy = ""; }
    addressedOn = "";
    addressedBy = "";
  } else if (verdict === "agreed" && wasOpen) {
    addressedOn = when;
    addressedBy = who;
  }
  return {
    flaggedOn: flaggedOn, flaggedBy: flaggedBy,
    addressedOn: addressedOn, addressedBy: addressedBy,
  };
}

export function clearVerdict(boxId: string): void {
  delete state.reviews[boxId];
}

/**
 * Put a box back in the queue without taking the record of it away.
 *
 * The difference from clearVerdict() is the whole point. Reopening says "this
 * is not settled after all" — it does not say "nobody ever looked at this",
 * and it certainly does not say "throw away what they wrote". Deleting the
 * entry did all three: press Reopen on a box somebody had flagged with two
 * paragraphs of objection and the objection, the name against it and the date
 * were gone, from memory and from the next save, with verdicts deliberately
 * kept off the undo stack so there was no way back.
 *
 * So: the judgement comes off and the record stays. The note stands, and so
 * does the fact that a concern was raised and by whom — that is history, and
 * reopening does not un-happen it. The CLOSE goes, because a box being reopened
 * is by definition not closed out any more.
 */
export function reopenVerdict(boxId: string): void {
  const entry = state.reviews[boxId];
  if (!entry) return;
  entry.verdict = "none";
  entry.addressedOn = "";
  entry.addressedBy = "";
  entry.addressedNote = "";
  entry.reviewer = state.reviewer || entry.reviewer;
  entry.date = today();
}

/** Toggle the flag on one input of a box, without giving the box a verdict. */
export function toggleSourceFlag(boxId: string, sourceId: string): void {
  const node = nodeById[boxId];
  if (!node) return;
  const entry = state.reviews[boxId];
  if (!entry) {
    // Flagging one link is itself a judgement about the box, so it creates the
    // record rather than needing a verdict first.
    recordVerdict(boxId, "flagged", { flaggedSources: [sourceId] });
    return;
  }
  const at = entry.flaggedSources.indexOf(sourceId);
  if (at === -1) entry.flaggedSources.push(sourceId);
  else entry.flaggedSources.splice(at, 1);
  // Re-stamp: the reader has said something new about this box.
  entry.fingerprint = fingerprintOf(node);
  entry.date = today();
  entry.reviewer = state.reviewer || entry.reviewer;
  if (entry.flaggedSources.length && entry.verdict === "agreed") {
    // Flagging one link turns an agreement into a concern, and a concern needs
    // the date it was raised on like any other — this path does not go through
    // recordVerdict, so it does its own stamping.
    entry.verdict = "flagged";
    entry.flaggedOn = entry.date;
    entry.flaggedBy = entry.reviewer;
    entry.addressedOn = "";
  }
}

export function isSourceFlagged(boxId: string, sourceId: string): boolean {
  const entry = state.reviews[boxId];
  return !!entry && entry.flaggedSources.indexOf(sourceId) !== -1;
}

// `new Date()` with no argument is fine here — this is a user action in a live
// browser, not something a test or a resumed run has to reproduce.
function today(): string {
  const d = new Date();
  const pad = (n: number) => (n < 10 ? "0" + n : String(n));
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

// ───── Families: the prompt that finds a MISSING link ─────────────────────
// Everything above helps a reader judge what IS there. This is the one piece
// aimed at what is not.
//
// When several of a box's inputs are the same shape — labels sharing a prefix
// and suffix with one varying span, "Lorry exam coverage" / "Container exam
// coverage" / "Parcel screen coverage" — that is a pattern the author built
// deliberately, and a pattern with a member missing is the commonest way a big
// map goes wrong. The app can see the pattern; the reader, looking at seven
// rows, usually cannot.
//
// Kept deliberately simpler than the atlas's lane detection (20-atlas-engine's
// detectLanes, which also tests adjacency, reuse and role): here the members are
// already known to share a role — they all feed the same box — so the label
// pattern alone is enough, and the four extra tests would only reject families
// that are obviously real.
export interface InputFamily {
  /** The shared text either side of the varying part, for the sentence. */
  prefix: string;
  suffix: string;
  /** Source box ids in the family, and the word that varies in each. */
  members: { id: string; varies: string }[];
}

const MIN_FAMILY = 3;

export function inputFamily(boxId: string): InputFamily | null {
  const sources = (incomingEdges[boxId] || [])
    .map(edge => nodeById[edge.from])
    .filter(Boolean) as GraphNode[];
  if (sources.length < MIN_FAMILY) return null;

  // key = "prefixsuffix" → the members that match it
  const byKey = new Map<string, { id: string; varies: string }[]>();
  for (const source of sources) {
    const words = String(source.label || source.id).split(/\s+/).filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      // The varying span runs to three words, the same ceiling the atlas uses.
      for (let j = i + 1; j <= Math.min(words.length, i + 3); j++) {
        const prefix = words.slice(0, i).join(" ");
        const suffix = words.slice(j).join(" ");
        if (!prefix && !suffix) continue;      // nothing shared to anchor on
        const key = prefix + "" + suffix;
        const list = byKey.get(key) || [];
        if (!list.some(m => m.id === source.id)) list.push({ id: source.id, varies: words.slice(i, j).join(" ") });
        byKey.set(key, list);
      }
    }
  }

  // The biggest family wins, and ties break towards the one with more shared
  // text — "X exam coverage" is a stronger pattern than "X".
  let best: InputFamily | null = null;
  for (const [key, members] of byKey) {
    if (members.length < MIN_FAMILY) continue;
    const [prefix, suffix] = key.split("");
    const shared = prefix.length + suffix.length;
    const bestShared = best ? best.prefix.length + best.suffix.length : -1;
    if (!best || members.length > best.members.length ||
        (members.length === best.members.length && shared > bestShared)) {
      best = { prefix: prefix, suffix: suffix, members: members };
    }
  }
  return best;
}

// ═════════════════════════════════════════════════════════════════════════════
// RUNNING A PASS
// -----------------------------------------------------------------------------
// The pass is not a mode in the app's sense — it does not dock panels or change
// what the map lets you do. It turns the box panel into a review card and gives
// the keyboard two extra keys. Everything else works exactly as it does while
// reading, which is the point: reviewing a map is reading it with a question in
// mind, and the surfaces should be the same ones.
// ═════════════════════════════════════════════════════════════════════════════

/** Start (or resume) a pass, landing on the first box still wanting a verdict. */
export function startReviewPass(): string | null {
  setReviewPass(true);
  return nextOutstanding(null) || (queueOrder()[0] || null);
}

export function endReviewPass(): void {
  setReviewPass(false);
}

// The flag and the body class it drives are set HERE, together, and nowhere
// else. Setting them at the two call sites instead left the class behind when
// the pass was ended from the card's own Done button rather than from the Review
// panel — the marks cleared (both render paths read state.reviewPass) but the
// class stayed on, so anything later keyed on it would have been quietly wrong.
function setReviewPass(on: boolean): void {
  state.reviewPass = on;
  if (typeof document !== "undefined" && document.body) {
    document.body.classList.toggle("review-pass", on);
  }
  // Starting and stopping a pass is not a change to the record, but everything
  // that watches the record also has to move when it happens — the rail appears
  // and disappears with the pass, and the panel's own button changes what it
  // says. Same funnel, so there is still exactly one thing to remember.
  notifyRecordChanged();
}

/** What a click on the card's controls means. Returns the box to move to, if any. */
export function reviewAction(
  boxId: string,
  what: string,
  options?: { addressedNote?: string },
): { goTo?: string; ended?: boolean; refused?: string } {
  const entry = state.reviews[boxId];
  switch (what) {
    case "agree":
      // Agreeing on a box with an unanswered concern on it IS closing that
      // concern, so it is held to the same account of what was done. A flag and
      // a note both count: see needsResponse.
      if (needsResponse(boxId)) {
        if (!markAddressed(boxId, options && options.addressedNote)) {
          return { refused: "Say what was done about it before agreeing." };
        }
        return { goTo: nextOutstanding(boxId) || undefined };
      }
      recordVerdict(boxId, "agreed", { addressedNote: options && options.addressedNote });
      return { goTo: nextOutstanding(boxId) || undefined };
    case "flag":
      // Flag is a toggle, so a mis-click is one press to undo instead of a trip
      // to the spreadsheet. Taking it back withdraws the JUDGEMENT and keeps
      // everything the reviewer put in — the note, and any links they marked.
      // Deleting the record was the old behaviour and it threw away the one
      // part that took effort to produce: you would write two sentences about
      // why a box looked wrong, press Flag, and lose them.
      //
      // Read off the stored verdict rather than the current state, so a flagged
      // box whose links have been edited since (which reads as "stale") still
      // toggles instead of being flagged a second time.
      if (entry && entry.verdict === "flagged") recordVerdict(boxId, "none");
      else recordVerdict(boxId, "flagged");
      return {};
    case "skip":   return { goTo: stepQueue(boxId, 1) || undefined };
    case "next":   return { goTo: nextOutstanding(boxId) || undefined };
    case "prev":   return { goTo: stepQueue(boxId, -1) || undefined };
    case "end":    endReviewPass(); return { ended: true };
  }
  return {};
}

// ───── Persistence ────────────────────────────────────────────────────────
// A verdict belongs to the map, so it is saved the way a map edit is: the live
// state is re-serialised (the `reviews` section comes with it) and the CSV goes
// to storage. Debounced, because the note field saves on every keystroke.
//
// Deliberately NOT pushed onto the undo stack. Undo is for changes to the map,
// and a reviewer pressing Ctrl-Z after agreeing three boxes means "put my last
// map edit back", not "un-say what I just said about this box". A verdict is
// cleared by pressing Flag again or by giving a different one.
let reviewSaveTimer: ReturnType<typeof setTimeout> | null = null;

// Review saves normally complete or flush through the app lifecycle. Tests
// discard the whole in-memory map between cases, so they need a cancellation
// boundary that cannot serialize the previous case into the next one's slot.
export function cancelPendingReviewSaveWithoutFlushing(): void {
  if (!reviewSaveTimer) return;
  clearTimeout(reviewSaveTimer);
  reviewSaveTimer = null;
}

// Anything that shows a count off the record — the header badge, the panel —
// has to move when the record does. Every mutation site already calls
// scheduleReviewSave(), so that is the one place worth notifying from: a fourth
// caller that forgets is a stale badge, and the badge going stale is the whole
// failure the panel exists to prevent.
//
// A callback rather than a direct import because the panel imports THIS module;
// calling back the other way would be a cycle. 23-review-panel registers at
// startup.
type RecordListener = () => void;
let recordListeners: RecordListener[] = [];

export function onReviewRecordChanged(fn: RecordListener): void {
  recordListeners.push(fn);
}

function notifyRecordChanged(): void {
  for (const fn of recordListeners) fn();
}

export function scheduleReviewSave(): void {
  // Immediate, not debounced: the save can wait 400ms, the count on screen
  // cannot.
  notifyRecordChanged();
  if (reviewSaveTimer) clearTimeout(reviewSaveTimer);
  reviewSaveTimer = setTimeout(() => {
    reviewSaveTimer = null;
    saveReviewsNow();
  }, 400);
}

export function saveReviewsNow(): void {
  if (!state.dataLoaded) return;
  try {
    const csv = serializeLiveStateToCsv(null, { compact: true });
    state.lastCsvSnapshot = csv;
    saveCsvToStorage(csv);
  } catch (err) {
    // Storage being unavailable must never cost the reviewer their place in the
    // pass — the verdicts are still in memory and still in the next export.
    console.warn("Could not save the review record:", err);
  }
}

// ───── Reading the record back ────────────────────────────────────────────
// Capturing a verdict is half a review. The other half is finding the ones that
// said "no" again afterwards and working through them — which is what a flag IS
// FOR. Without this the flags were write-only: a count in a bar, a note visible
// only on the box you happened to be standing on.

export interface LogRow {
  entry: ReviewEntry;
  label: string;
  /** Current state, which may differ from entry.verdict if the box has changed. */
  now: ReviewState;
  /** Labels of the individually flagged inputs, for reading rather than ids. */
  flaggedLabels: string[];
}

function toRow(entry: ReviewEntry): LogRow {
  const node = nodeById[entry.boxId];
  return {
    entry: entry,
    label: (node && node.label) || entry.label || entry.boxId,
    now: reviewStateOf(entry.boxId),
    // A source that has itself been deleted is named as such rather than as a
    // bare id: "1 link flagged — a." tells a reader nothing.
    flaggedLabels: entry.flaggedSources
      .map(id => nodeById[id] ? (nodeById[id].label || id) : id + " (deleted)"),
  };
}

/**
 * Everything anyone has said about the boxes ON THIS MAP, in queue order.
 *
 * Reviews of deleted boxes are deliberately NOT here: there is nothing left to
 * act on, and a panel listing boxes that are not on the map is a panel people
 * stop reading. They are not lost — they are kept in the record, written to the
 * spreadsheet, and carried into the exported log, which is where a QA trail
 * belongs. See reviewReport().
 */
export function reviewLog(): LogRow[] {
  const order = queueOrder();
  const rank = new Map(order.map((id, i) => [id, i]));
  return Object.keys(state.reviews)
    .filter(id => nodeById[id])
    .sort((a, b) => (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9))
    .map(id => toRow(state.reviews[id]));
}

/** The rows still wanting somebody to do something: flagged, or gone stale. */
export function openItems(): LogRow[] {
  return reviewLog().filter(row => row.now === "flagged" || row.now === "stale");
}

/**
 * Is there an unanswered concern on this box?
 *
 * A concern is raised two ways and they mean the same thing: pressing Flag, and
 * writing in the note field — because writing down what is wrong with a box IS
 * saying something is wrong with it. Either way it stands until somebody says
 * what was done about it, and until then the box cannot be agreed.
 *
 * An agreed box is settled by definition, so its note is not an open question —
 * that is what lets a sign-off which merely went stale be re-confirmed without
 * anybody having to answer for anything.
 */
export function needsResponse(boxId: string): boolean {
  const entry = state.reviews[boxId];
  if (!entry) return false;
  if (entry.verdict === "agreed") return false;
  return (entry.verdict === "flagged" || !!entry.note.trim()) && !entry.addressedNote.trim();
}

/**
 * Close a flag out: the concern was dealt with, so the box is agreed as it now
 * stands. Re-stamps the fingerprint, which is the point — "addressed" has to
 * mean "I looked at the CURRENT version", not "I dismissed the old note".
 * The note is kept: why it was flagged is worth more than a tidy list.
 *
 * CLOSING A FLAG NEEDS AN ACCOUNT OF WHAT WAS DONE. Without one the log becomes
 * a list of things somebody decided to stop worrying about, and the reader a
 * year later cannot tell a fix from a shrug. The original note is not a
 * substitute — it says what was wrong, not what happened about it.
 *
 * Re-confirming a sign-off that went stale is a different act: nothing was ever
 * flagged, so there is nothing to account for, and no note is asked of it.
 *
 * @returns false when the close was refused for want of a note — nothing is
 *          written in that case, so the caller can say so rather than pretending.
 */
export function markAddressed(boxId: string, closingNote?: string): boolean {
  const entry = state.reviews[boxId];
  if (!entry) return false;
  const wanted = needsResponse(boxId);
  const note = String(closingNote || "").trim();
  if (wanted && !note) return false;
  recordVerdict(boxId, "agreed", {
    note: entry.note,
    flaggedSources: [],
    addressedNote: note || entry.addressedNote,
  });
  return true;
}

// ───── Boxes that have gone ───────────────────────────────────────────────
/**
 * Mark reviews whose box has been deleted, and unmark ones whose box is back.
 *
 * A review that vanishes when its box does is the worst kind of audit hole,
 * because it is silent: before this, deleting a flagged box removed the concern
 * from every surface — the log, the badge, the exported report — with nothing
 * left to say it had ever been raised. And the case where that matters most is
 * the one where deleting the box WAS the answer to the flag.
 *
 * Called from rebuildIndexes(), which every mutation and every load already goes
 * through, rather than from the delete paths — there are five of those, and a
 * reconciler wired to four of them is worse than none.
 *
 * Symmetric on purpose: an undo brings the box back and clears the mark, so a
 * mis-click costs nothing. The entry itself is never touched, so the verdict,
 * the note and the fingerprint all come back exactly as they were.
 */
export function reconcileReviews(): void {
  for (const boxId of Object.keys(state.reviews)) {
    const entry = state.reviews[boxId];
    const node = nodeById[boxId];
    if (node) {
      entry.label = node.label || boxId;      // keep the tombstone name current
      if (entry.removedOn) entry.removedOn = "";
    } else if (!entry.removedOn) {
      entry.removedOn = today();
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// THE EXPORTED LOG
// -----------------------------------------------------------------------------
// A review that only exists inside the app is a review you cannot show anybody.
// This is the whole record as a flat table: every box on the map, whether it has
// been checked, by whom and when, what they said, which links they flagged,
// whether the concern has since been closed out — and, for a sign-off given
// before an edit, that it no longer applies.
//
// EVERY BOX, not only the reviewed ones. "What has been checked" is only half an
// answer; a log that lists nothing but the boxes somebody looked at reads as a
// clean bill of health for a map nobody has touched. The 33 starting boxes on
// the map this was built against are listed too, marked as outside the queue,
// so the table accounts for the map rather than for the reviewing.
// ═════════════════════════════════════════════════════════════════════════════

export interface ReportRow {
  /** Position in the review queue, 1-based. 0 for a box outside it. */
  order: number;
  boxId: string;
  label: string;
  /** The map column the box sits in, by its label. */
  column: string;
  linksIn: number;
  /** Plain-language state, the same words the panel uses. */
  state: string;
  reviewer: string;
  date: string;
  note: string;
  flaggedLabels: string[];
  flaggedOn: string;
  flaggedBy: string;
  addressedOn: string;
  /** Who closed it. Not always the person who gave the latest verdict. */
  addressedBy: string;
  /** Set when the box this review is about has been deleted from the map. */
  removedOn: string;
  /** What was done about the flag — required before one can be closed. */
  addressedNote: string;
  /** False when the box has changed since it was judged. */
  stillCurrent: boolean;
}

const STATE_WORDS: Record<ReviewState, string> = {
  unreviewed: "not checked",
  agreed:     "agreed",
  flagged:    "flagged",
  stale:      "changed since it was checked",
};

export function reviewReport(): ReportRow[] {
  const order = queueOrder();
  const position = new Map(order.map((id, i) => [id, i + 1]));
  const rows: ReportRow[] = [];

  // Queue order — causes before effects, the order a pass runs in. Every box is
  // in it; `rest` is the belt to that braces, for a box the order somehow missed.
  const inQueue = order.map(id => nodeById[id]).filter(Boolean) as GraphNode[];
  const rest = NODES.filter(n => !position.has(n.id));

  for (const node of inQueue.concat(rest)) {
    const at = position.get(node.id) || 0;
    const entry = state.reviews[node.id];
    const now = reviewStateOf(node.id);
    rows.push({
      order: at,
      boxId: node.id,
      label: node.label || node.id,
      column: (stageById[node.stage] && stageById[node.stage].label) || node.stage || "",
      linksIn: (incomingEdges[node.id] || []).length,
      state: STATE_WORDS[now],
      reviewer: entry ? entry.reviewer : "",
      date: entry ? entry.date : "",
      note: entry ? entry.note : "",
      flaggedLabels: entry
        ? entry.flaggedSources.map(id => (nodeById[id] && nodeById[id].label) || id)
        : [],
      flaggedOn: entry ? entry.flaggedOn : "",
      flaggedBy: entry ? entry.flaggedBy : "",
      addressedOn: entry ? entry.addressedOn : "",
      addressedBy: entry ? entry.addressedBy : "",
      removedOn: "",
      addressedNote: entry ? entry.addressedNote : "",
      stillCurrent: !entry || now !== "stale",
    });
  }

  // Reviews of boxes that have been deleted, last. They are not on the map, so
  // nothing above can carry them — and leaving them out would mean the exported
  // log quietly forgot every concern anybody ever raised about a box somebody
  // later removed.
  for (const boxId of Object.keys(state.reviews)) {
    if (nodeById[boxId]) continue;
    const entry = state.reviews[boxId];
    rows.push({
      order: 0,
      boxId: boxId,
      label: entry.label || boxId,
      column: "",
      linksIn: 0,
      state: "box deleted on " + (entry.removedOn || "an unrecorded date") +
             " — last verdict: " + (entry.verdict === "none" ? "none" : entry.verdict),
      reviewer: entry.reviewer,
      date: entry.date,
      note: entry.note,
      flaggedLabels: entry.flaggedSources
        .map(id => (nodeById[id] && nodeById[id].label) || id),
      flaggedOn: entry.flaggedOn,
      flaggedBy: entry.flaggedBy,
      addressedOn: entry.addressedOn,
      addressedBy: entry.addressedBy,
      addressedNote: entry.addressedNote,
      removedOn: entry.removedOn,
      // Nothing to be current about: the thing it judged is gone.
      stillCurrent: false,
    });
  }
  return rows;
}

/** The report as a spreadsheet: one header row, one row per box, no comments. */
export function reviewReportCsv(): string {
  const lines = [csvRow([
    "order", "box", "id", "column", "links in", "state",
    "reviewer", "date", "comment", "flagged links",
    "flagged on", "flagged by", "addressed on", "addressed by", "what was done",
    "deleted on", "still current",
  ])];
  for (const row of reviewReport()) {
    lines.push(csvRow([
      row.order || "",
      row.label,
      row.boxId,
      row.column,
      row.linksIn,
      row.state,
      row.reviewer,
      row.date,
      row.note,
      row.flaggedLabels.join(" | "),
      row.flaggedOn,
      row.flaggedBy,
      row.addressedOn,
      row.addressedBy,
      row.addressedNote,
      row.removedOn,
      row.removedOn ? "" : (row.stillCurrent ? "yes" : "no"),
    ]));
  }
  return lines.join("\n") + "\n";
}

export function reviewReportFilename(): string {
  return "review-log-" + today() + ".csv";
}
