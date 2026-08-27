// =============================================================================
// REVIEW PANEL — the two review surfaces, over the map
// -----------------------------------------------------------------------------
// One overlay, two sections, both of them lists of things to DECIDE rather than
// things to read:
//
//   ISSUES            what the loader noticed, one card per thing to fix, with
//                     the boxes that only drift because of it folded underneath.
//   ADJUSTABLE INPUTS what a nudge on each input actually does, opening on the
//                     handful that behave oddly rather than on all of them.
//
// WHY AN OVERLAY AND NOT A DRAWER. Both sections are lists of boxes, and the
// thing you want the instant you read one is that box on the map. A drawer over
// the left third would put the panel and the box it names in a fight for the
// same screen; the overlay takes the whole frame, and clicking a box closes it
// and selects the box, which is the shortest route from "something is wrong" to
// "I can see it". Same pattern as the atlas, for the same reason.
//
// WHY NOT IN THE BULK-EDIT WIZARD. Half of what is on this panel needs live
// computed values — the drift figures, every number in the sweep — and the
// wizard works on a detached copy that has never been solved. The wizard's own
// Review step is a different job (are the fields filled in), and it stays.
// =============================================================================

import { state, NODES, nodeById } from "./03-state";
import { escapeHtml, formatScalar } from "./04-utils";
import { selectNode, scrollNodeIntoView } from "./09-graph-selection";
import {
  groupFindings,
  currentSweep,
  sweepExceptions,
  sweepIsPossible,
} from "./22-review";
import { solverGeneration } from "./07-simulation-engine";
import type { FindingGroup, ReviewSummary, Sweep, SweepException, SweepRow } from "./22-review";
import type { Finding, FindingSeverity } from "./types";

// Above this many adjustable inputs the sweep is one solve per input of a map
// big enough for that to be felt, so it waits to be asked for. Below it, the
// answer is on screen before the panel has finished opening. (Thirty-three
// inputs on a ninety-box map came in under a tenth of a second.)
const SWEEP_AUTORUN_LIMIT = 60;

// "The user asked for the sweep on a map this big" — stamped with the map it was
// asked about, not a bare flag. A flag would carry the permission across a map
// load, so the NEXT big map would sweep on open without being asked, which is
// the one thing the limit exists to prevent.
let sweepRequestedFor = -1;
let fullListOpen = false;

// ───── The element, and the open/closed state ─────────────────────────────
function stageEl(): HTMLElement | null {
  return document.getElementById("review-stage");
}

export function reviewIsOpen(): boolean {
  const stage = stageEl();
  return !!stage && !stage.hidden;
}

export function openReview(): void {
  const stage = stageEl();
  if (!stage) return;
  stage.hidden = false;
  document.body.classList.add("review-open");
  renderReview();
  syncReviewButton();
}

export function closeReview(): void {
  const stage = stageEl();
  if (!stage) return;
  stage.hidden = true;
  stage.innerHTML = "";
  document.body.classList.remove("review-open");
  fullListOpen = false;
  syncReviewButton();
}

export function toggleReview(): void {
  if (reviewIsOpen()) closeReview();
  else openReview();
}

// ───── The header button ──────────────────────────────────────────────────
// The count is the point. A panel you have to remember to open is a panel
// nobody opens, and the six-second toast this replaces proved it — so the
// number rides in the header, where it is visible without being asked for.
// Counted in CAUSES, not findings: seventeen would be a lie about how much
// work there is.
export function syncReviewButton(): void {
  const button = document.getElementById("review-button");
  if (!button) return;

  if (!state.dataLoaded) {
    button.hidden = true;
    return;
  }
  button.hidden = false;

  const summary = groupFindings(state.loadErrors);
  const causes = summary.groups.length;
  const worst = worstSeverity(summary.groups);

  button.textContent = "Review";
  button.classList.toggle("is-open", reviewIsOpen());
  button.setAttribute("aria-expanded", reviewIsOpen() ? "true" : "false");

  const existing = button.querySelector(".review-badge");
  if (existing) existing.remove();
  if (causes > 0) {
    const badge = document.createElement("span");
    badge.className = "review-badge sev-" + worst;
    badge.textContent = String(causes);
    button.appendChild(badge);
  }

  button.setAttribute(
    "data-tooltip",
    causes === 0
      ? "Check the map: nothing the loader flagged, plus what each adjustable input actually does."
      : causes + " thing" + (causes === 1 ? "" : "s") + " to fix, plus what each adjustable input does.",
  );
}

function worstSeverity(groups: FindingGroup[]): FindingSeverity {
  const rank: Record<FindingSeverity, number> = { ignored: 0, wrong: 1, mismatch: 2 };
  let worst: FindingSeverity = "mismatch";
  for (const g of groups) if (rank[g.severity] < rank[worst]) worst = g.severity;
  return worst;
}

/**
 * The one call every other module makes: keep the badge honest, and if the panel
 * happens to be open, repaint it. Safe to call at any point — before the DOM
 * exists, before a map is loaded, with the panel shut.
 */
export function refreshReview(): void {
  syncReviewButton();
  if (reviewIsOpen()) renderReview();
}

// ═════════════════════════════════════════════════════════════════════════════
// RENDER
// ═════════════════════════════════════════════════════════════════════════════
export function renderReview(): void {
  const stage = stageEl();
  if (!stage || stage.hidden) return;

  const summary = groupFindings(state.loadErrors);

  let html = "";
  html += '<div class="review-head">';
  html +=   '<div class="review-title">Review</div>';
  html +=   '<div class="review-sub">' + escapeHtml(reviewSubtitle(summary)) + '</div>';
  html +=   '<button class="review-close" id="review-close" aria-label="Close review">Done</button>';
  html += '</div>';

  html += '<div class="review-body">';
  html +=   '<div class="review-column">' + renderIssuesSection(summary) + '</div>';
  html +=   '<div class="review-column">' + renderInputsSection() + '</div>';
  html += '</div>';

  stage.innerHTML = html;
}

// Counted in CARDS and in CONSEQUENCES, never in findings. One box can be wrong
// in two ways at once and still be one job, so "things to fix" is the number of
// cards; and the knock-on figure is the findings actually attributed to another
// box, not "everything that is not a card" — those two differ by exactly the
// second finding on a doubled-up card.
function reviewSubtitle(summary: ReviewSummary): string {
  const causes = summary.groups.length;
  if (summary.total === 0) {
    return "Nothing flagged on load. The right-hand column is the check that validation cannot do.";
  }
  const knockOn = summary.consequenceCount;
  if (knockOn <= 0) return causes + " thing" + (causes === 1 ? "" : "s") + " to fix.";
  return causes + " thing" + (causes === 1 ? "" : "s") + " to fix, and " + knockOn +
         " box" + (knockOn === 1 ? "" : "es") + " that only read wrong because of them.";
}

// ───── Section 1: issues, grouped by cause ────────────────────────────────
function renderIssuesSection(summary: ReviewSummary): string {
  let html = '<div class="review-section-head">';
  html +=     '<span class="review-section-title">What the loader noticed</span>';
  html +=     '<span class="review-section-count' + (summary.groups.length ? "" : " ok") + '">' +
                (summary.groups.length ? summary.groups.length + " to fix" : "all clear") + '</span>';
  html +=   '</div>';

  if (summary.groups.length === 0) {
    html += '<div class="review-empty">' +
              '<b>Every check passed.</b> Every formula parses, every name resolves, and every box ' +
              'opens on the starting value it declares.' +
            '</div>';
    return html;
  }

  if (summary.consequenceCount > 0) {
    html += '<div class="review-hint">' + summary.consequenceCount + ' further finding' +
            (summary.consequenceCount === 1 ? " is" : "s are") + ' folded into the cards below — ' +
            'boxes whose numbers are only wrong because something upstream of them is. ' +
            'Fix the cause and they clear themselves.</div>';
  }

  for (const group of summary.groups) html += renderCauseCard(group);
  return html;
}

function renderCauseCard(group: FindingGroup): string {
  const clickable = group.boxId ? ' data-review-box="' + escapeHtml(group.boxId) + '"' : "";
  let html = '<div class="review-card' + (group.boxId ? " is-clickable" : "") + '"' + clickable + '>';
  html +=   '<div class="review-card-head">';
  html +=     '<span class="review-sev sev-' + group.severity + '" aria-hidden="true"></span>';
  html +=     '<span class="review-card-label">' + escapeHtml(group.label) + '</span>';
  if (group.boxId) html += '<span class="review-card-id">' + escapeHtml(group.boxId) + '</span>';
  html +=   '</div>';

  for (const f of group.causes) {
    html += '<div class="review-what">' + markCode(f.message) + '</div>';
    if (f.fix) html += '<div class="review-fix">' + markCode(f.fix) + '</div>';
  }

  if (group.consequences.length) {
    html += '<div class="review-fold">';
    html +=   '<b>' + group.consequences.length + ' box' + (group.consequences.length === 1 ? "" : "es") +
              ' downstream also read wrong</b> — ' +
              group.consequences.slice(0, 5).map(c => escapeHtml(labelOf(c))).join(", ") +
              (group.consequences.length > 5 ? " and " + (group.consequences.length - 5) + " more" : "") + ".";
    html += '</div>';
  }

  html += '</div>';
  return html;
}

function labelOf(f: Finding): string {
  const node = f.boxId ? nodeById[f.boxId] : undefined;
  return (node && node.label) || f.boxId || "";
}

// Messages carry `backticked ids` from the loader. Rendering them as code is the
// difference between a sentence about a box and a sentence you can pick an id
// out of. Escaped first, so nothing in the CSV can inject markup.
function markCode(text: string): string {
  return escapeHtml(text).replace(/`([^`]+)`/g, '<code>$1</code>');
}

// ───── Section 2: what each adjustable input does ─────────────────────────
function renderInputsSection(): string {
  let html = '<div class="review-section-head">';
  html +=     '<span class="review-section-title">What each adjustable input does</span>';
  html +=   '</div>';

  if (!sweepIsPossible()) {
    html += '<div class="review-empty">' +
              '<b>Nothing to sweep.</b> This check nudges each adjustable input in turn and reports ' +
              'what moved, so it needs at least one adjustable input with a starting value, and at ' +
              'least one box that is not itself an input.' +
            '</div>';
    return html;
  }

  const inputCount = NODES.filter(n => n.controllable && n.baseline).length;
  if (inputCount > SWEEP_AUTORUN_LIMIT && sweepRequestedFor !== solverGeneration()) {
    html += '<div class="review-empty">' +
              '<b>' + inputCount + ' adjustable inputs.</b> The check solves the map once per input — ' +
              'quick, but not instant at this size, so it waits to be asked.' +
              '<button class="review-run" id="review-run-sweep">Run the check</button>' +
            '</div>';
    return html;
  }

  const sweep = currentSweep();
  const exceptions = sweepExceptions(sweep);

  html += '<div class="review-hint">Each input nudged up ' + Math.round(sweep.step * 100) +
          '% on its own, every other slider at 100%, measured against where the map sits when ' +
          'nothing has been asked of it. Everything below computes correctly and would pass every ' +
          'check on the left — it is only not what was intended.</div>';

  if (exceptions.length === 0) {
    html += '<div class="review-empty"><b>Nothing odd.</b> Every adjustable input moves something, ' +
            'no box is out of reach, and no single input dominates the map.</div>';
  }

  for (const ex of exceptions) html += renderExceptionCard(ex);

  // The full list, folded. Nothing is hidden by the exceptions above — this is
  // the same sweep, ordered by how far each input carries.
  html += '<button class="review-fold-toggle" id="review-fold-toggle" aria-expanded="' +
          (fullListOpen ? "true" : "false") + '">' +
          (fullListOpen ? "▾" : "▸") + " All " + sweep.rows.length + " inputs, by reach</button>";
  if (fullListOpen) {
    html += '<div class="review-rows">';
    for (const row of sweep.rows) html += renderSweepRow(row, sweep);
    html += '</div>';
  }
  return html;
}

function renderExceptionCard(ex: SweepException): string {
  let html = '<div class="review-card is-clickable" data-review-box="' + escapeHtml(ex.boxId) + '">';
  html +=   '<div class="review-card-head">';
  html +=     '<span class="review-sev sev-' + ex.severity + '" aria-hidden="true"></span>';
  html +=     '<span class="review-card-label">' + escapeHtml(ex.title) + '</span>';
  html +=   '</div>';
  html +=   '<div class="review-what">' + escapeHtml(ex.detail) + '</div>';

  // The arms of the gate, when there are any. "It moves nothing" is the symptom;
  // this is the answer, and it is the whole reason the card is worth more than
  // a row in a list.
  if (ex.gate) {
    html += '<div class="review-arms">';
    for (const arm of ex.gate.arms) {
      html += '<div class="review-arm' + (arm.binding ? " is-binding" : "") + '">';
      html +=   '<span class="review-arm-text">' + escapeHtml(arm.text) + '</span>';
      html +=   '<span class="review-arm-value">' + escapeHtml(formatScalar(arm.value)) + '</span>';
      html +=   '<span class="review-arm-tag">' + (arm.binding ? "binding" : "spare") + '</span>';
      html += '</div>';
    }
    html += '</div>';
  }

  html += '<div class="review-fix">' + escapeHtml(ex.fix) + '</div>';
  html += '</div>';
  return html;
}

function renderSweepRow(row: SweepRow, sweep: Sweep): string {
  const widest = sweep.rows[0] ? sweep.rows[0].reach : 1;
  const width = Math.max(3, widest ? (row.reach / widest) * 100 : 3);
  const top = row.moves.slice(0, 3).map(m =>
    '<b>' + escapeHtml(m.label) + '</b> <span class="' + (m.pct > 0 ? "up" : "dn") + '">' +
    (m.pct > 0 ? "+" : "") + m.pct.toFixed(1) + '%</span>').join(" · ");

  let html = '<div class="review-row' + (row.reach === 0 ? " is-dead" : "") +
             '" data-review-box="' + escapeHtml(row.id) + '">';
  html +=   '<span class="review-row-body">';
  html +=     '<span class="review-row-name">' + escapeHtml(row.label) + '</span>';
  html +=     '<span class="review-row-top">' + (row.reach ? top : "moves nothing") + '</span>';
  html +=   '</span>';
  html +=   '<span class="review-row-bar"><i style="width:' + width.toFixed(1) + '%"></i></span>';
  html +=   '<span class="review-row-count">' + row.reach + '</span>';
  html += '</div>';
  return html;
}

// ═════════════════════════════════════════════════════════════════════════════
// WIRING
// ═════════════════════════════════════════════════════════════════════════════
// One delegated listener on the stage handles every card, row and control, for
// every rebuild — the stage element is stable, its contents are not.
export function initReviewStage(): void {
  const button = document.getElementById("review-button");
  if (button && !button.dataset.wired) {
    button.dataset.wired = "1";
    button.addEventListener("click", toggleReview);
  }

  const stage = stageEl();
  if (!stage || stage.dataset.wired) return;
  stage.dataset.wired = "1";

  stage.addEventListener("click", event => {
    const target = event.target as HTMLElement;

    if (target.closest("#review-close")) { closeReview(); return; }

    if (target.closest("#review-run-sweep")) {
      sweepRequestedFor = solverGeneration();
      renderReview();
      return;
    }

    if (target.closest("#review-fold-toggle")) {
      fullListOpen = !fullListOpen;
      renderReview();
      return;
    }

    // Anything carrying a box id takes you to that box. Closing on the way is
    // the point: the panel has said its piece, and what you want now is the map.
    const holder = target.closest("[data-review-box]") as HTMLElement | null;
    if (holder) {
      const boxId = holder.getAttribute("data-review-box")!;
      if (nodeById[boxId]) {
        closeReview();
        selectNode(boxId);
        scrollNodeIntoView(boxId);
      }
    }
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && reviewIsOpen()) {
      event.stopPropagation();
      closeReview();
    }
  });
}
