// =============================================================================
// THE REVIEW QUEUE — five kinds of thing to decide, in one list
// -----------------------------------------------------------------------------
// A review used to be five separate lists in three separate places: the loader's
// findings and the sweep's oddities in an overlay, the coverage queue in a rail
// down the left, and a flag only on the box it was raised about. Each had its
// own shape, its own count and its own idea of what "done" meant, so there was
// no answer to the one question a reviewer actually has — how much is left?
//
// This module answers it. Every kind of thing a review can ask about becomes a
// ReviewItem: a name, a one-line reason, the box (and sometimes the link) it is
// about, and whether it has been settled. What differs between the kinds is the
// PAYLOAD each carries, which is what the box panel needs in order to show the
// controls that answer it — a proposed fix for a finding, the evidence fields
// for a link, the verdict buttons for an unchecked box.
//
// Nothing here touches the DOM and nothing here mutates the map. It is one
// function of the current state, so the sidebar and the box panel cannot
// disagree about what is in the queue or which item is current.
// =============================================================================

import type { Finding, FindingSeverity, EvidenceMetadata } from "./types";
import { EDGES, NODES, nodeById } from "./03-state";
import { evidenceMetadataOrDefault, normaliseEvidenceStatus } from "./07c-evidence";
import { state } from "./03-state";
import { groupFindings, currentSweep, sweepExceptions, sweepIsPossible } from "./22-review";
import type { SweepException } from "./22-review";
import { coverage, queueOrder, reviewStateOf, commentOn, openItems, reviewLog } from "./24-review-record";
import type { LogRow, ReviewState } from "./24-review-record";

// ═════════════════════════════════════════════════════════════════════════════
// THE EVIDENCE INVENTORY, AND THE GAPS IN IT
// ═════════════════════════════════════════════════════════════════════════════

export interface ReviewEvidenceItem {
  id: string;
  kind: "link" | "formula";
  label: string;
  detail: string;
  boxId: string;
  edgeId?: string;
  metadata: EvidenceMetadata;
}

/** Evidence is inventory, not an error list: no status contributes to the
 * Review badge or changes a calculation. */
export function reviewEvidenceItems(): ReviewEvidenceItem[] {
  const items: ReviewEvidenceItem[] = [];
  for (const edge of EDGES) {
    const source = nodeById[edge.from];
    const target = nodeById[edge.to];
    items.push({
      id: "link:" + edge.from + ":" + edge.to + ":" + (edge.id || ""),
      kind: "link",
      label: (source?.label || edge.from) + " → " + (target?.label || edge.to),
      detail: "Evidence for this causal relationship",
      // Link provenance is authored from the source box's outgoing-link list,
      // so Review must return the reader there rather than to the target.
      boxId: edge.from,
      edgeId: edge.id,
      metadata: evidenceMetadataOrDefault(edge.evidence),
    });
  }
  for (const node of NODES) {
    const formulaEvidence = evidenceMetadataOrDefault(node.formulaEvidence);
    const hasRecordedFormulaEvidence = formulaEvidence.status !== "unspecified" ||
      !!formulaEvidence.rationale || !!formulaEvidence.source || !!formulaEvidence.lastReviewed;
    // Let authors record the provenance decision before the expression is
    // ready. Truly empty Unspecified metadata remains out of the inventory;
    // anything somebody deliberately recorded must remain findable.
    if (!node.formula && !hasRecordedFormulaEvidence) continue;
    items.push({
      id: "formula:" + node.id,
      kind: "formula",
      label: node.label,
      detail: node.formula || "Formula not set",
      boxId: node.id,
      metadata: formulaEvidence,
    });
  }
  return items;
}

// A queue cannot open on the whole inventory. On a ninety-box map that is some
// three hundred rows, every one of them a link somebody has already recorded a
// judgement about, and burying eleven real gaps in it is the same as not
// listing them. So the queue carries the GAPS, and the full inventory stays
// where it was — reachable from any one of them, in the box panel.
//
// Three ways a record is a gap, in the order they are reported:
const STRONG_ENOUGH_TO_NEED_MORE_THAN_A_GUESS = 0.4;
const MONTHS_BEFORE_A_RECORD_GOES_STALE = 18;

/** The reason this record is in the queue, or "" if it is not a gap. */
export function evidenceGapReason(item: ReviewEvidenceItem, today = new Date()): string {
  const metadata = item.metadata;
  const status = normaliseEvidenceStatus(metadata.status);
  const recordedSomething = !!metadata.rationale || !!metadata.source;

  // 1. Nothing at all. The commonest gap and the cheapest to close.
  if (status === "unspecified" && !recordedSomething) {
    return item.kind === "formula"
      ? "Nothing recorded for this formula"
      : "Nothing recorded";
  }

  // 2. A strong link that nobody has done more than assume. A weak hypothesis
  //    is an honest note about something that barely moves the map; a strong
  //    one is carrying weight it has not earned.
  const strength = item.edgeId ? strengthOfLink(item.edgeId) : null;
  if (status === "hypothesis" && strength !== null &&
      Math.abs(strength) >= STRONG_ENOUGH_TO_NEED_MORE_THAN_A_GUESS) {
    return "A strong link resting on a guess · strength " + strength.toFixed(2);
  }

  // 3. Somebody did the work, a long time ago. Not wrong — just old enough that
  //    nobody should be relying on it without looking again.
  const monthsOld = monthsSince(metadata.lastReviewed, today);
  if (monthsOld !== null && monthsOld >= MONTHS_BEFORE_A_RECORD_GOES_STALE) {
    return "Last looked at " + describeMonth(metadata.lastReviewed!);
  }

  return "";
}

function strengthOfLink(edgeId: string): number | null {
  const edge = EDGES.find(candidate => candidate.id === edgeId);
  if (!edge || typeof edge.elasticity !== "number" || !isFinite(edge.elasticity)) return null;
  return edge.elasticity;
}

/** Whole months between an ISO-ish date and today, or null if unparseable. */
function monthsSince(dateText: string | undefined, today: Date): number | null {
  if (!dateText) return null;
  const parsed = new Date(dateText);
  if (isNaN(parsed.getTime())) return null;
  const months = (today.getFullYear() - parsed.getFullYear()) * 12 +
                 (today.getMonth() - parsed.getMonth());
  return months - (today.getDate() < parsed.getDate() ? 1 : 0);
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
                     "July", "August", "September", "October", "November", "December"];

function describeMonth(dateText: string): string {
  const parsed = new Date(dateText);
  if (isNaN(parsed.getTime())) return dateText;
  return MONTH_NAMES[parsed.getMonth()] + " " + parsed.getFullYear();
}

// ═════════════════════════════════════════════════════════════════════════════
// THE ITEM
// ═════════════════════════════════════════════════════════════════════════════

export type ReviewItemKind = "issue" | "evidence" | "flag" | "unchecked" | "input";

export interface ReviewItem {
  /** Stable across renders, and the only thing the sidebar and the box panel
   *  pass between them. Prefixed by kind so two kinds can never collide. */
  id: string;
  kind: ReviewItemKind;
  /** The row's title, and the box panel's heading. */
  name: string;
  /** One line saying why this is in the queue. */
  why: string;
  /** The box to select on the map, when there is one. */
  boxId?: string;
  /** The link this item is about, when it is about a link. */
  edgeId?: string;
  /** Issues and odd inputs only — the dot's colour. */
  severity?: FindingSeverity;
  /** Whether the item still wants an answer. */
  settled: boolean;
  /** What the row says to a screen reader. */
  spoken: string;
  /** Kind-specific payload, for whatever renders the controls that answer it. */
  finding?: Finding;
  /** Issues only: every finding this box is itself responsible for. Usually one,
   *  but a box can be wrong in two ways at once and still be one job. */
  causes?: Finding[];
  /** Issues only: the boxes that only read wrong because of this one. */
  consequenceLabels?: string[];
  exception?: SweepException;
  logRow?: LogRow;
  evidence?: ReviewEvidenceItem;
  coverageState?: ReviewState;
}

export type ReviewFilter = "all" | ReviewItemKind;

/** The chips, in the order the groups appear under them. */
export const REVIEW_FILTERS: ReviewFilter[] =
  ["all", "issue", "flag", "evidence", "input", "unchecked"];

/** The words a filter chip and a group heading use. Plain language: nothing
 *  here says node, edge, stage or elasticity. */
export const KIND_LABEL: Record<ReviewItemKind, string> = {
  issue:     "What the loader noticed",
  evidence:  "Evidence",
  flag:      "What people flagged",
  unchecked: "Not checked",
  input:     "What each adjustable box does",
};

export const KIND_CHIP: Record<ReviewItemKind, string> = {
  issue:     "To fix",
  evidence:  "Evidence",
  flag:      "Flagged",
  unchecked: "Not checked",
  input:     "Odd inputs",
};

/**
 * The order the groups appear in: the sharp work first, the bulk work last.
 *
 * What the loader noticed and what somebody flagged are specific and few. The
 * coverage queue is every box on the map, so it goes at the bottom — with it
 * third, a map that loads clean opened on thirty-six "not checked" rows and
 * buried the six evidence gaps and three odd inputs that were the only things
 * anybody could actually act on.
 */
const KIND_ORDER: ReviewItemKind[] = ["issue", "flag", "evidence", "input", "unchecked"];

const COVERAGE_MARK: Record<ReviewState, string> = {
  agreed: "✓", flagged: "!", stale: "~", unreviewed: "○",
};
const COVERAGE_WORD: Record<ReviewState, string> = {
  agreed: "agreed", flagged: "flagged", stale: "changed since it was checked",
  unreviewed: "not checked yet",
};

/** The glyph in a row's left column. Every kind has one, and the word beside it
 *  in `spoken` carries the same fact for anything not looking at the screen. */
export function markFor(item: ReviewItem): string {
  if (item.kind === "unchecked") return COVERAGE_MARK[item.coverageState || "unreviewed"];
  if (item.settled) return "✓";
  return "○";
}

// ═════════════════════════════════════════════════════════════════════════════
// BUILDING THE QUEUE
// ═════════════════════════════════════════════════════════════════════════════

// The sweep solves the map once per adjustable box. Below this many it is over
// before the sidebar has finished opening; above it, the odd-input group says
// so and waits to be asked rather than stalling every other kind behind it.
export const SWEEP_AUTORUN_LIMIT = 60;

let sweepRequestedFor = -1;

/** "Yes, run the sweep on a map this big." Stamped with the map it was asked
 *  about, so the permission does not survive a map load. */
export function requestSweep(generation: number): void {
  sweepRequestedFor = generation;
}

export function sweepIsAwaitingRequest(generation: number): boolean {
  if (!sweepIsPossible()) return false;
  const inputCount = NODES.filter(node => node.controllable && node.baseline).length;
  return inputCount > SWEEP_AUTORUN_LIMIT && sweepRequestedFor !== generation;
}

// What a row says once the thing it was asking about has stopped being true.
// The item stays in the list rather than vanishing under the cursor: answering
// an evidence gap by typing a rationale takes it out of the queue on the FIRST
// keystroke, and a row that disappears mid-word — taking its own fields with it
// — is not an answer, it is a lost sentence.
const SETTLED_WHY: Record<ReviewItemKind, string> = {
  issue:     "Fixed",
  evidence:  "Recorded",
  flag:      "Closed",
  unchecked: "Checked",
  input:     "No longer flagged",
};

/**
 * Every item a review has to get through, grouped by kind in KIND_ORDER and in
 * a stable order within each group.
 *
 * `retain` is the item somebody is standing on. If answering it has taken it out
 * of the queue, it comes back marked settled rather than disappearing — see
 * SETTLED_WHY.
 */
export function reviewQueue(solverGenerationNow: number, retain?: ReviewItem): ReviewItem[] {
  const items: ReviewItem[] = [];

  // ── 1. What the loader noticed ─────────────────────────────────────────
  // One item per CAUSE, not per finding: a box can be wrong in two ways at once
  // and still be one job, and the boxes that only read wrong because of it are
  // folded into the card rather than listed as work of their own.
  for (const group of groupFindings(state.loadErrors).groups) {
    const primary = group.causes[0];
    const identity = findingIdentity(primary);
    items.push({
      id: "issue:" + identity,
      kind: "issue",
      name: group.label,
      why: primary ? stripCodeTicks(primary.message) : "",
      boxId: group.boxId,
      severity: group.severity,
      settled: false,
      spoken: group.label + " — " + (primary ? stripCodeTicks(primary.message) : "a finding") +
              (group.consequences.length
                ? ", and " + group.consequences.length + " box" +
                  (group.consequences.length === 1 ? "" : "es") + " downstream read wrong because of it"
                : ""),
      finding: primary,
      causes: group.causes,
      consequenceLabels: group.consequences.map(consequence => {
        const node = consequence.boxId ? nodeById[consequence.boxId] : undefined;
        return (node && node.label) || consequence.boxId || "";
      }),
    });
  }

  // ── 2. What people flagged ─────────────────────────────────────────────
  // The open ones are work; the closed ones are the record. Only the open ones
  // are in the queue, and the whole log stays one button away.
  for (const row of openItems()) {
    items.push({
      id: "flag:" + row.entry.boxId,
      kind: "flag",
      name: row.label,
      why: row.now === "stale"
        ? "Signed off by " + (row.entry.reviewer || "someone") + ", and has changed since"
        : (row.entry.note || "Flagged with no note"),
      boxId: row.entry.boxId,
      severity: row.now === "stale" ? "mismatch" : "wrong",
      settled: false,
      spoken: row.label + " — flagged by " + (row.entry.reviewer || "someone") +
              (row.entry.note ? ": " + row.entry.note : ", with no note"),
      logRow: row,
    });
  }

  // ── 3. What nobody has checked yet ─────────────────────────────────────
  // Every box with something driving it, in the order the pass walks them —
  // causes before effects. Settled ones stay in the list so the queue is the
  // progress report as well as the work.
  for (const boxId of queueOrder()) {
    const node = nodeById[boxId];
    if (!node) continue;
    const now = reviewStateOf(boxId);
    const comment = commentOn(boxId);
    items.push({
      id: "unchecked:" + boxId,
      kind: "unchecked",
      name: node.label || boxId,
      why: now === "agreed" ? "Agreed" : now === "stale" ? "Changed since sign-off" : "",
      boxId: boxId,
      settled: now === "agreed" || now === "flagged",
      spoken: (node.label || boxId) + " — " + COVERAGE_WORD[now] +
              (comment ? ", has a comment" : ""),
      coverageState: now,
    });
  }

  // ── 4. Evidence gaps ───────────────────────────────────────────────────
  for (const record of reviewEvidenceItems()) {
    const reason = evidenceGapReason(record);
    if (reason) items.push(evidenceItem(record, reason));
  }

  // ── 5. What each adjustable box does ───────────────────────────────────
  // Nothing here is invalid. It is the check validation cannot do: an input
  // that moves nothing, one that reaches a single box, one that only pushes
  // down. Skipped entirely while the sweep is waiting to be asked for.
  if (sweepIsPossible() && !sweepIsAwaitingRequest(solverGenerationNow)) {
    for (const exception of sweepExceptions(currentSweep())) {
      items.push({
        id: "input:" + exception.kind + ":" + exception.boxId,
        kind: "input",
        name: exception.title,
        why: exception.detail,
        boxId: exception.boxId,
        severity: exception.severity,
        settled: false,
        spoken: exception.title + " — " + exception.detail,
        exception: exception,
      });
    }
  }

  if (retain && !items.some(item => item.id === retain.id)) {
    items.push({ ...retain, settled: true, why: SETTLED_WHY[retain.kind] });
  }
  return sortByKind(items);
}

function evidenceItem(record: ReviewEvidenceItem, reason: string): ReviewItem {
  return {
    id: "evidence:" + record.id,
    kind: "evidence",
    name: record.label,
    why: reason || SETTLED_WHY.evidence,
    boxId: record.boxId,
    edgeId: record.edgeId,
    settled: !reason,
    spoken: record.label + " — " + (reason || SETTLED_WHY.evidence),
    evidence: record,
  };
}

/**
 * An item for any record in the evidence inventory, gap or not. The queue holds
 * only the gaps, but the whole inventory is browsable behind the status picker,
 * and a row you can see is a row you must be able to open.
 */
export function evidenceItemById(itemId: string): ReviewItem | undefined {
  if (!itemId.startsWith("evidence:")) return undefined;
  const recordId = itemId.slice("evidence:".length);
  const record = reviewEvidenceItems().find(candidate => candidate.id === recordId);
  return record ? evidenceItem(record, evidenceGapReason(record)) : undefined;
}

function sortByKind(items: ReviewItem[]): ReviewItem[] {
  return items.slice().sort((left, right) =>
    KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind));
}

export function findingIdentity(finding: Finding | undefined): string {
  if (!finding) return "missing-finding";
  return finding.issueKey || [finding.kind, finding.boxId || "map", finding.message].join(":");
}

// Loader messages carry `backticked ids`. A row is one line of 11px text, so
// the ticks come off rather than becoming <code> — the box id is already the
// row's own subject.
function stripCodeTicks(text: string): string {
  return text.replace(/`/g, "");
}

// ═════════════════════════════════════════════════════════════════════════════
// COUNTS
// ═════════════════════════════════════════════════════════════════════════════

export interface ReviewCounts {
  /** Every item, settled or not. */
  total: number;
  /** Items still wanting an answer. */
  open: number;
  settled: number;
  /** Open items per kind — what the chips show. */
  openByKind: Record<ReviewItemKind, number>;
  totalByKind: Record<ReviewItemKind, number>;
}

export function reviewCounts(items: ReviewItem[]): ReviewCounts {
  const openByKind = { issue: 0, evidence: 0, flag: 0, unchecked: 0, input: 0 };
  const totalByKind = { issue: 0, evidence: 0, flag: 0, unchecked: 0, input: 0 };
  let settled = 0;
  for (const item of items) {
    totalByKind[item.kind]++;
    if (item.settled) settled++;
    else openByKind[item.kind]++;
  }
  return {
    total: items.length,
    open: items.length - settled,
    settled: settled,
    openByKind: openByKind,
    totalByKind: totalByKind,
  };
}

/** The pass's own progress, which is about boxes rather than about items —
 *  the coverage bar keeps meaning what it has always meant. */
export function coverageShare(): { agreed: number; flagged: number; stale: number; total: number } {
  const done = coverage();
  return { agreed: done.agreed, flagged: done.flagged, stale: done.stale, total: done.total };
}

/** Whether anything at all is worth opening the sidebar for. */
export function reviewHasAnything(): boolean {
  return state.loadErrors.length > 0 || reviewLog().length > 0 ||
         queueOrder().length > 0 || NODES.length > 0;
}
