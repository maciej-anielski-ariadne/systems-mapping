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
import { focusNode, scrollNodeIntoView } from "./09-graph-selection";
import {
  groupFindings,
  currentSweep,
  sweepExceptions,
  sweepIsPossible,
} from "./22-review";
import { solverGeneration } from "./07-simulation-engine";
import {
  coverage, startReviewPass, endReviewPass, reviewAction, reviewerNamed, needsResponse,
  reviewLog, openItems, markAddressed, clearVerdict, scheduleReviewSave,
  onReviewRecordChanged,
} from "./24-review-record";
import { downloadReviewLog } from "./25-review-rail";
import type { LogRow } from "./24-review-record";
import type { FindingGroup, ReviewSummary, Sweep, SweepException, SweepRow } from "./22-review";
import type { Finding, FindingSeverity } from "./types";

// Above this many adjustable boxes the sweep is one solve per box of a map
// big enough for that to be felt, so it waits to be asked for. Below it, the
// answer is on screen before the panel has finished opening. (Thirty-three
// boxes on a ninety-box map came in under a tenth of a second.)
const SWEEP_AUTORUN_LIMIT = 60;

// "The user asked for the sweep on a map this big" — stamped with the map it was
// asked about, not a bare flag. A flag would carry the permission across a map
// load, so the NEXT big map would sweep on open without being asked, which is
// the one thing the limit exists to prevent.
let sweepRequestedFor = -1;
let fullListOpen = false;
let logOpen = false;

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
  // Two kinds of unfinished business, and the badge counts both: what the app
  // noticed, and what a person flagged and nobody has closed out. A flag that
  // only shows up once you remember to look is the six-second toast again.
  const causes = summary.groups.length;
  const open = openItems().length;
  const total = causes + open;
  const worst = worstSeverity(summary.groups);

  button.textContent = "Review";
  button.classList.toggle("is-open", reviewIsOpen());
  button.setAttribute("aria-expanded", reviewIsOpen() ? "true" : "false");

  const existing = button.querySelector(".review-badge");
  if (existing) existing.remove();
  if (total > 0) {
    const badge = document.createElement("span");
    // A person's flag is amber, not red: the map still computes, and somebody
    // has already looked at it. Only the loader's "the engine threw away what
    // you typed" earns the red.
    badge.className = "review-badge sev-" + (causes > 0 ? worst : "wrong");
    badge.textContent = String(total);
    button.appendChild(badge);
  }

  const parts: string[] = [];
  if (causes) parts.push(causes + " thing" + (causes === 1 ? "" : "s") + " the loader flagged");
  if (open)   parts.push(open + " open from a review");
  button.setAttribute(
    "data-tooltip",
    parts.length
      ? parts.join(", ") + " — plus what each adjustable box does."
      : "Check the map: nothing flagged, what each adjustable box does, and what nobody has checked yet.",
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
  html +=   '<div class="review-column">' + renderIssuesSection(summary) +
            renderFlaggedSection() + '</div>';
  html +=   '<div class="review-column">' + renderInputsSection() +
            renderCoverageSection() + '</div>';
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

// ───── Section 2: what each adjustable box does ───────────────────────────
function renderInputsSection(): string {
  let html = '<div class="review-section-head">';
  html +=     '<span class="review-section-title">What each adjustable box does</span>';
  html +=   '</div>';

  if (!sweepIsPossible()) {
    html += '<div class="review-empty">' +
              '<b>Nothing to sweep.</b> This check nudges each adjustable box in turn and reports ' +
              'what moved, so it needs at least one adjustable box with a starting value, and at ' +
              'least one box that is not itself adjustable.' +
            '</div>';
    return html;
  }

  const inputCount = NODES.filter(n => n.controllable && n.baseline).length;
  if (inputCount > SWEEP_AUTORUN_LIMIT && sweepRequestedFor !== solverGeneration()) {
    html += '<div class="review-empty">' +
              '<b>' + inputCount + ' adjustable boxes.</b> The check solves the map once per box — ' +
              'quick, but not instant at this size, so it waits to be asked.' +
              '<button class="review-run" id="review-run-sweep">Run the check</button>' +
            '</div>';
    return html;
  }

  const sweep = currentSweep();
  const exceptions = sweepExceptions(sweep);

  html += '<div class="review-hint">Each adjustable box nudged up ' + Math.round(sweep.step * 100) +
          '% on its own, every other slider at 100%, measured against where the map sits when ' +
          'nothing has been asked of it. Everything below computes correctly and would pass every ' +
          'check on the left — it is only not what was intended.</div>';

  if (exceptions.length === 0) {
    html += '<div class="review-empty"><b>Nothing odd.</b> Every adjustable box moves something, ' +
            'no box is out of reach, and no single input dominates the map.</div>';
  }

  for (const ex of exceptions) html += renderExceptionCard(ex);

  // The full list, folded. Nothing is hidden by the exceptions above — this is
  // the same sweep, ordered by how far each input carries.
  html += '<button class="review-fold-toggle" id="review-fold-toggle" aria-expanded="' +
          (fullListOpen ? "true" : "false") + '">' +
          (fullListOpen ? "▾" : "▸") + " All " + sweep.rows.length + " adjustable boxes, by reach</button>";
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

// ───── What people flagged ────────────────────────────────────────────────
// The loader's findings sit above this, and these read the same way on purpose:
// both are things to fix, one noticed by the app and one by a person. This is
// the half of a review that makes the other half worth doing — a flag that
// cannot be found again is a note to nobody.
function renderFlaggedSection(): string {
  const open = openItems();
  const log = reviewLog();
  if (log.length === 0) return "";

  let html = '<div class="review-section-head">';
  html +=     '<span class="review-section-title">What people flagged</span>';
  html +=     '<span class="review-section-count' + (open.length ? "" : " ok") + '">' +
                (open.length ? open.length + " open" : "all closed") + '</span>';
  html +=   '</div>';

  if (open.length === 0) {
    html += '<div class="review-empty"><b>Nothing outstanding.</b> ' + log.length +
            ' box' + (log.length === 1 ? " has" : "es have") + ' been reviewed and none is ' +
            'flagged or waiting on a re-check.</div>';
  }

  for (const row of open) html += renderLogCard(row, true);

  // The whole record, folded. "Review log" in the literal sense: who said what
  // about which box, including the agreements — an audit trail is not only its
  // exceptions.
  html += '<button class="review-fold-toggle" id="review-log-toggle" aria-expanded="' +
          (logOpen ? "true" : "false") + '">' + (logOpen ? "▾" : "▸") +
          " The whole log — " + log.length + " box" + (log.length === 1 ? "" : "es") +
          " reviewed</button>";
  if (logOpen) {
    html += '<div class="review-rows">';
    for (const row of log) html += renderLogRow(row);
    html += '</div>';
  }
  return html;
}

function renderLogCard(row: LogRow, actionable: boolean): string {
  const stale = row.now === "stale";
  let html = '<div class="review-card is-clickable" data-review-box="' + escapeHtml(row.entry.boxId) + '">';
  html +=   '<div class="review-card-head">';
  html +=     '<span class="review-sev sev-' + (stale ? "wrong" : "wrong") + '" aria-hidden="true"></span>';
  html +=     '<span class="review-card-label">' + escapeHtml(row.label) + '</span>';
  html +=     '<span class="review-card-id">' + escapeHtml(row.entry.boxId) + '</span>';
  html +=   '</div>';

  if (stale) {
    html += '<div class="review-what">Signed off by ' +
      escapeHtml(row.entry.reviewer || "someone") + ' on ' + escapeHtml(row.entry.date) +
      ', and what drives it has changed since. The sign-off no longer applies.</div>';
  }
  if (row.entry.note) {
    html += '<div class="review-note">' + escapeHtml(row.entry.note) + '</div>';
  } else if (!stale) {
    html += '<div class="review-what review-note-none">Flagged with no note.</div>';
  }
  if (row.flaggedLabels.length) {
    html += '<div class="review-fold"><b>' + row.flaggedLabels.length + ' link' +
      (row.flaggedLabels.length === 1 ? "" : "s") + ' flagged</b> — ' +
      escapeHtml(row.flaggedLabels.join(", ")) + '.</div>';
  }
  html += '<div class="review-log-by">' + escapeHtml(row.entry.reviewer || "unsigned") +
          ' · ' + escapeHtml(row.entry.date) + '</div>';

  if (actionable) {
    // Closing a concern needs an account of what was DONE about it — the note
    // above says what was wrong, which is a different thing. Without one the log
    // turns into a list of concerns somebody decided to stop having.
    //
    // Re-confirming a sign-off that went stale is not closing a concern: nothing
    // was ever raised, so nothing is asked for. needsResponse draws that line.
    const closingAFlag = needsResponse(row.entry.boxId);
    if (closingAFlag) {
      html += '<textarea class="review-close-note" rows="2" data-close-note="' +
              escapeHtml(row.entry.boxId) + '" placeholder="What was done about it? — needed to close">' +
              escapeHtml(row.entry.addressedNote) + '</textarea>';
    }

    // The buttons stop the card's own click-through, so "go to the box" and
    // "close this out" are not the same gesture.
    html += '<div class="review-log-actions">';
    html +=   '<button type="button" class="rv-v" data-log-action="addressed" ' +
              'data-log-box="' + escapeHtml(row.entry.boxId) + '"' +
              (closingAFlag && !row.entry.addressedNote.trim() ? " disabled" : "") + '>' +
              (stale && !closingAFlag ? "Still fine" : "Addressed") + '</button>';
    html +=   '<button type="button" class="rv-v" data-log-action="clear" ' +
              'data-log-box="' + escapeHtml(row.entry.boxId) + '" ' +
              'data-tooltip="Drop the verdict entirely — the box goes back to unreviewed.">Reopen</button>';
    html += '</div>';
  }
  html += '</div>';
  return html;
}

function renderLogRow(row: LogRow): string {
  return '<div class="review-row" data-review-box="' + escapeHtml(row.entry.boxId) + '">' +
    '<span class="review-row-body">' +
      '<span class="review-row-name">' + escapeHtml(row.label) + '</span>' +
      '<span class="review-row-top">' +
        escapeHtml(row.entry.reviewer || "unsigned") + " · " + escapeHtml(row.entry.date) +
        (row.entry.note ? " · " + escapeHtml(row.entry.note) : "") +
      '</span>' +
    '</span>' +
    '<span class="review-log-state rv-' + row.now + '">' + row.now + '</span>' +
  '</div>';
}

// ───── Section 3: what nobody has checked yet ─────────────────────────────
// The other two sections are things the app worked out. This one is the only
// thing on the panel it cannot: whether a person has actually looked at each
// box and said the links feeding it are right. All the app can do is keep the
// score and hand you the next one.
function renderCoverageSection(): string {
  const done = coverage();
  if (done.total === 0) {
    return '<div class="review-section-head">' +
      '<span class="review-section-title">What nobody has checked yet</span></div>' +
      '<div class="review-empty"><b>Nothing to check.</b> A review pass asks, box by box, ' +
      'whether the links feeding it are right and complete — so it needs a map with links ' +
      'on it.</div>';
  }

  const settled = done.agreed + done.flagged;
  const pct = Math.round(settled / done.total * 100);
  const running = state.reviewPass;

  let html = '<div class="review-section-head">';
  html +=     '<span class="review-section-title">What nobody has checked yet</span>';
  html +=     '<span class="review-section-count' + (done.unreviewed + done.stale === 0 ? " ok" : "") + '">' +
                settled + " of " + done.total + '</span>';
  html +=   '</div>';

  html += '<div class="review-hint">One box at a time, causes before effects: <i>is this ' +
          'everything that drives this box?</i> The verdict, who gave it and why are kept in the ' +
          'map\'s own spreadsheet, so a pass survives a refresh and travels with the file.</div>';

  html += '<div class="review-cov">';
  html +=   '<div class="review-cov-bar">';
  if (done.agreed)  html += '<i class="cov-agreed" style="width:' + (done.agreed / done.total * 100) + '%"></i>';
  if (done.flagged) html += '<i class="cov-flagged" style="width:' + (done.flagged / done.total * 100) + '%"></i>';
  if (done.stale)   html += '<i class="cov-stale" style="width:' + (done.stale / done.total * 100) + '%"></i>';
  html +=   '</div>';
  html +=   '<div class="review-cov-key">' +
              '<span><i class="cov-agreed"></i>' + done.agreed + ' agreed</span>' +
              '<span><i class="cov-flagged"></i>' + done.flagged + ' flagged</span>' +
              (done.stale ? '<span><i class="cov-stale"></i>' + done.stale + ' changed since</span>' : "") +
              '<span><i class="cov-none"></i>' + done.unreviewed + ' not looked at</span>' +
            '</div>';
  html += '</div>';

  // The name goes on every verdict, so it is asked for before the pass rather
  // than after — a record of who said what is the point, and "unsigned" is a
  // poor answer to give a month later. A FULL name, not initials: this record
  // outlives the session, and the pass will not start without one.
  const named = reviewerNamed();
  html += '<div class="review-who' + (named ? "" : " is-wanted") + '">';
  html +=   '<label for="review-reviewer">Your full name</label>';
  html +=   '<input id="review-reviewer" class="review-who-input" type="text" maxlength="60" ' +
            'value="' + escapeHtml(state.reviewer) + '" placeholder="Ann Lee" ' +
            'autocomplete="name" aria-describedby="review-who-why" />';
  html += '</div>';
  html += '<div class="review-who-why" id="review-who-why">' +
          (named
            ? "Every verdict is signed with this, and it goes in the exported log."
            : "<b>A full name, not initials.</b> Every verdict is signed with it and it goes in " +
              "the exported log, which somebody else may be reading a year from now.") +
          '</div>';

  html += '<button class="review-run" id="review-start-pass"' + (named ? "" : " disabled") + '>' +
          (!named ? "Your name first"
                  : running ? "Go to the next box"
                  : settled ? "Carry on — " + (done.total - settled) + " to go"
                            : "Start a pass — " + done.total + " boxes") +
          '</button>';
  if (running) {
    html += '<button class="review-fold-toggle" id="review-end-pass">Stop the pass</button>';
  }

  // Taking the record out of the app. Offered here, beside the coverage it
  // reports on, as well as in File ▸ Export — a log you can only read on the
  // screen it was made on is not much of a record, and this is the point in the
  // panel where somebody is already thinking about how far the review has got.
  html += '<button class="review-fold-toggle" id="review-export-log" ' +
          'data-tooltip="A .csv of every box: checked or not, by whom, when, the comments, ' +
          'and whether they have been dealt with.">Export the log — ' + done.total +
          ' box' + (done.total === 1 ? "" : "es") + ', reviewed or not</button>';
  if (done.stale) {
    html += '<div class="review-hint" style="margin-top:var(--space-2)"><b>' + done.stale +
            '</b> box' + (done.stale === 1 ? " has" : "es have") + ' changed since being signed off, ' +
            'so the sign-off no longer applies and they are back in the queue.</div>';
  }
  return html;
}

// ═════════════════════════════════════════════════════════════════════════════
// WIRING
// ═════════════════════════════════════════════════════════════════════════════
// One delegated listener on the stage handles every card, row and control, for
// every rebuild — the stage element is stable, its contents are not.
export function initReviewStage(): void {
  // Whenever a verdict changes — from the panel here, or from the review card in
  // the box panel — the badge and this panel are re-read from the record.
  onReviewRecordChanged(refreshReview);

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

    if (target.closest("#review-log-toggle")) {
      logOpen = !logOpen;
      renderReview();
      return;
    }

    const logButton = target.closest("[data-log-action]") as HTMLElement | null;
    if (logButton) {
      // Acting on a flag must not also navigate away from the list you are
      // working through — the card behind this is a click-through to the box.
      event.stopPropagation();
      const boxId = logButton.getAttribute("data-log-box")!;
      if (logButton.getAttribute("data-log-action") === "addressed") {
        const field = stage.querySelector('[data-close-note="' + CSS.escape(boxId) + '"]') as
                      HTMLTextAreaElement | null;
        // Refused when there is nothing to record. The button is disabled until
        // there is, so this is the belt to that braces — but markAddressed is
        // the thing that decides, and it says no by writing nothing.
        if (!markAddressed(boxId, field ? field.value : "")) return;
      } else {
        clearVerdict(boxId);
      }
      scheduleReviewSave();   // notifies, which repaints this panel and the badge
      return;
    }

    if (target.closest("#review-start-pass")) {
      const goTo = startReviewPass();   // sets the body class with the flag
      closeReview();
      if (goTo) { focusNode(goTo); scrollNodeIntoView(goTo); }
      return;
    }

    if (target.closest("#review-end-pass")) {
      endReviewPass();                  // clears the body class with the flag
      renderReview();
      return;
    }

    if (target.closest("#review-export-log")) {
      downloadReviewLog();
      return;
    }

    // Anything carrying a box id takes you to that box. Closing on the way is
    // the point: the panel has said its piece, and what you want now is the map.
    const holder = target.closest("[data-review-box]") as HTMLElement | null;
    if (holder) {
      const boxId = holder.getAttribute("data-review-box")!;
      if (nodeById[boxId]) {
        closeReview();
        focusNode(boxId);
        scrollNodeIntoView(boxId);
      }
    }
  });

  // The name and the closing notes, kept as you type. NOT re-rendered on input:
  // the field would lose focus after the first character. So the one control
  // whose state depends on the text — the button next to it — is updated by
  // hand instead.
  stage.addEventListener("input", event => {
    const target = event.target as HTMLElement;

    if (target && target.id === "review-reviewer") {
      state.reviewer = (target as HTMLInputElement).value.trim();
      const named = reviewerNamed();
      const start = document.getElementById("review-start-pass") as HTMLButtonElement | null;
      if (start) {
        start.disabled = !named;
        if (!named) start.textContent = "Your name first";
        else if (start.textContent === "Your name first") {
          const done = coverage();
          const settled = done.agreed + done.flagged;
          start.textContent = state.reviewPass ? "Go to the next box"
            : settled ? "Carry on — " + (done.total - settled) + " to go"
                      : "Start a pass — " + done.total + " boxes";
        }
      }
      const why = document.getElementById("review-who-why");
      if (why) why.closest(".review-column")?.querySelector(".review-who")
        ?.classList.toggle("is-wanted", !named);
      return;
    }

    const closeBox = target && target.getAttribute && target.getAttribute("data-close-note");
    if (closeBox) {
      const button = stage.querySelector(
        '[data-log-action="addressed"][data-log-box="' + CSS.escape(closeBox) + '"]',
      ) as HTMLButtonElement | null;
      if (button) button.disabled = !(target as HTMLTextAreaElement).value.trim();
    }
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && reviewIsOpen()) {
      event.stopPropagation();
      closeReview();
      return;
    }

    // [ and ] step the pass. Chosen because nothing else in the app binds them
    // and neither is reachable by accident while typing a note — and the note
    // field, like every other input, is excluded outright.
    if (!state.reviewPass || event.metaKey || event.ctrlKey || event.altKey) return;
    const el = document.activeElement as HTMLElement | null;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
    if (event.key !== "[" && event.key !== "]") return;
    if (!state.selectedNodeId) return;
    event.preventDefault();
    const result = reviewAction(state.selectedNodeId, event.key === "]" ? "next" : "prev");
    if (result.goTo) { focusNode(result.goTo); scrollNodeIntoView(result.goTo); }
  });
}
