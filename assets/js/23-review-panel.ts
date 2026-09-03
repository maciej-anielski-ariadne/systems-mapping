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

import { state, EDGES, NODES, nodeById } from "./03-state";
import { escapeHtml, formatScalar } from "./04-utils";
import { upgradeSelectionOnlySelectsIn } from "./04b-typeable-dropdown";
import {
  EVIDENCE_STATUSES,
  evidenceBadgeHtml,
  evidenceMetadataOrDefault,
  evidenceStatusLabel,
  normaliseEvidenceStatus,
} from "./07c-evidence";
import { focusNode, scrollNodeIntoView } from "./09-graph-selection";
import { setUiMode } from "./17-events";
import {
  groupFindings,
  currentSweep,
  sweepExceptions,
  sweepIsPossible,
} from "./22-review";
import { solverGeneration } from "./07-simulation-engine";
import {
  coverage, startReviewPass, endReviewPass, reviewAction, reviewerNamed, needsResponse,
  reviewLog, openItems, markAddressed, reopenVerdict, scheduleReviewSave,
  onReviewRecordChanged,
} from "./24-review-record";
import { downloadReviewLog } from "./25-review-rail";
import type { LogRow } from "./24-review-record";
import type { FindingGroup, ReviewSummary, Sweep, SweepException, SweepRow } from "./22-review";
import type { EvidenceMetadata, EvidenceStatus, Finding, FindingSeverity } from "./types";
import type { ReviewFixOperation, ReviewProposal, ReviewProposalPreview } from "./types";
import {
  captureReviewModelSnapshot,
  previewReviewProposal,
  reviewFindingCanHaveProposal,
  reviewProposalsForFinding,
} from "./22a-review-model";
import { applyConfirmedReviewProposal } from "./22b-review-apply";

// Above this many adjustable boxes the sweep is one solve per box of a map
// big enough for that to be felt, so it waits to be asked for. Below it, the
// answer is on screen before the panel has finished opening. (Thirty-three
// boxes on a ninety-box map came in under a tenth of a second.)
const SWEEP_AUTORUN_LIMIT = 60;
const EVIDENCE_PREVIEW_LIMIT = 100;

// "The user asked for the sweep on a map this big" — stamped with the map it was
// asked about, not a bare flag. A flag would carry the permission across a map
// load, so the NEXT big map would sweep on open without being asked, which is
// the one thing the limit exists to prevent.
let sweepRequestedFor = -1;
let fullListOpen = false;
let logOpen = false;
let evidenceSectionOpen = true;
let listenersWired = false;
let expandedIssueKey: string | null = null;
let pinnedIssueKey: string | null = null;
let pinnedIssueFallback: Finding | null = null;
let pinnedIssueExpanded = false;
let resolvedIssueLabel: string | null = null;
let evidenceStatusFilter: EvidenceStatus | "all" = "all";
let evidenceVisibleLimit = EVIDENCE_PREVIEW_LIMIT;
const selectedProposalIdentifierByIssueKey = new Map<string, string>();
const editedProposalByIssueKey = new Map<string, ReviewProposal>();

// ───── The element, and the open/closed state ─────────────────────────────
function stageEl(): HTMLElement | null {
  return document.getElementById("review-stage");
}

function issueBannerElement(): HTMLElement | null {
  return document.getElementById("review-issue-banner");
}

function findingByIdentity(issueKey: string): Finding | undefined {
  return state.loadErrors.find(finding => findingIdentity(finding) === issueKey);
}

function renderPinnedIssueBanner(): void {
  const banner = issueBannerElement();
  if (!banner) return;
  if (!pinnedIssueKey || reviewIsOpen()) {
    banner.hidden = true;
    banner.innerHTML = "";
    return;
  }

  const liveFinding = findingByIdentity(pinnedIssueKey);
  const finding = liveFinding || pinnedIssueFallback;
  if (!finding) {
    banner.hidden = true;
    return;
  }
  const resolved = !liveFinding;
  const node = finding.boxId ? nodeById[finding.boxId] : undefined;
  banner.hidden = false;
  banner.classList.toggle("is-expanded", pinnedIssueExpanded);
  banner.classList.toggle("is-resolved", resolved);
  let html = '<button type="button" class="review-banner-main" id="review-banner-toggle" aria-expanded="' +
    (pinnedIssueExpanded ? "true" : "false") + '">';
  html += '<span class="review-sev sev-' + (resolved ? "mismatch" : finding.severity) + '" aria-hidden="true"></span>';
  html += '<span class="review-banner-copy"><b>' + (resolved ? "Issue resolved" : escapeHtml(node?.label || finding.boxId || "Review issue")) + '</b>';
  html += '<span>' + escapeHtml(resolved ? "The latest check no longer finds this issue." : finding.message) + '</span></span>';
  html += '<span class="review-disclosure">' + (pinnedIssueExpanded ? "−" : "+") + '</span></button>';
  html += '<button type="button" class="review-banner-dismiss" id="review-banner-dismiss" aria-label="Hide issue banner">×</button>';
  if (pinnedIssueExpanded) {
    html += '<div class="review-banner-details">';
    if (!resolved && finding.fix) html += '<div>' + markCode(finding.fix) + '</div>';
    html += '<div class="review-banner-actions">';
    html += '<button type="button" class="review-secondary" id="review-banner-back">Back to Review</button>';
    if (resolved) html += '<button type="button" class="review-apply" id="review-banner-next">Next issue</button>';
    html += '</div></div>';
  }
  banner.innerHTML = html;
}

export function reviewIsOpen(): boolean {
  const stage = stageEl();
  return !!stage && !stage.hidden;
}

export function openReview(): void {
  const stage = stageEl();
  if (!stage) return;
  // Opening is a fresh presentation. closeReview() already clears the expanded
  // card, but not every route out of the panel goes through it — replacing the
  // map, restoring a tutorial session or resetting state all leave the panel
  // hidden with a card still marked open, and it would come back expanded.
  // Only on a real open: the banner and the guided lessons both call this again
  // while the panel is already up, where it means "refresh", and the banner's
  // own Back and Next set the card they want immediately afterwards.
  if (!reviewIsOpen()) expandedIssueKey = null;
  stage.hidden = false;
  document.body.classList.add("review-open");
  renderReview();
  renderPinnedIssueBanner();
  syncReviewButton();
}

export function closeReview(): void {
  const stage = stageEl();
  if (!stage) return;
  stage.hidden = true;
  stage.innerHTML = "";
  document.body.classList.remove("review-open");
  fullListOpen = false;
  expandedIssueKey = null;
  evidenceSectionOpen = true;
  renderPinnedIssueBanner();
  syncReviewButton();
}

export function setSensitivityListOpen(open: boolean): void {
  fullListOpen = open;
  if (reviewIsOpen()) renderReview();
}

export function toggleReview(): void {
  if (reviewIsOpen()) closeReview();
  else openReview();
}

// ───── The map-health signal ──────────────────────────────────────────────
// The count is the point. A panel you have to remember to open is a panel
// nobody opens, and the six-second toast this replaces proved it — so the
// number rides on the map, where it is visible without being asked for.
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
interface ReviewScrollPosition {
  bodyScrollTop: number;
  columnScrollTops: number[];
}

function captureReviewScrollPosition(stage: HTMLElement): ReviewScrollPosition {
  const reviewBody = stage.querySelector<HTMLElement>(".review-body");
  return {
    bodyScrollTop: reviewBody?.scrollTop || 0,
    columnScrollTops: Array.from(stage.querySelectorAll<HTMLElement>(".review-column"))
      .map(reviewColumn => reviewColumn.scrollTop),
  };
}

function restoreReviewScrollPosition(
  stage: HTMLElement,
  scrollPosition: ReviewScrollPosition,
): void {
  const reviewBody = stage.querySelector<HTMLElement>(".review-body");
  if (reviewBody) reviewBody.scrollTop = scrollPosition.bodyScrollTop;
  const reviewColumns = stage.querySelectorAll<HTMLElement>(".review-column");
  scrollPosition.columnScrollTops.forEach((scrollTop, columnIndex) => {
    const reviewColumn = reviewColumns[columnIndex];
    if (reviewColumn) reviewColumn.scrollTop = scrollTop;
  });
}

export function renderReview(): void {
  const stage = stageEl();
  if (!stage || stage.hidden) return;
  const scrollPosition = captureReviewScrollPosition(stage);

  const summary = groupFindings(state.loadErrors);

  let html = "";
  html += '<div class="review-head">';
  html +=   '<div class="review-title">Review</div>';
  html +=   '<div class="review-sub">' + escapeHtml(reviewSubtitle(summary)) + '</div>';
  html +=   '<button class="review-close" id="review-close" aria-label="Close review">Done</button>';
  html += '</div>';

  html += '<div class="review-body">';
  html +=   '<div class="review-column">' + renderIssuesSection(summary) +
            renderFlaggedSection() + renderEvidenceSection() + '</div>';
  html +=   '<div class="review-column">' + renderInputsSection() +
            renderCoverageSection() + '</div>';
  html += '</div>';

  stage.innerHTML = html;
  upgradeSelectionOnlySelectsIn(stage);
  restoreReviewScrollPosition(stage, scrollPosition);
}

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

export function renderEvidenceSection(): string {
  const allItems = reviewEvidenceItems();
  if (!allItems.length) return "";
  const matchingItems = evidenceStatusFilter === "all"
    ? allItems
    : allItems.filter(item => normaliseEvidenceStatus(item.metadata.status) === evidenceStatusFilter);
  const visibleItems = matchingItems.slice(0, evidenceVisibleLimit);

  let html = '<button type="button" class="review-section-head review-section-toggle review-evidence-head" ' +
    'id="review-evidence-toggle" aria-expanded="' + String(evidenceSectionOpen) + '" ' +
    'aria-controls="review-evidence-content">';
  html += '<span class="review-section-disclosure" aria-hidden="true">' +
    (evidenceSectionOpen ? "▾" : "▸") + '</span>';
  html += '<span class="review-section-title">Evidence provenance</span>';
  html += '<span class="review-section-count">' + allItems.length + '</span></button>';
  if (!evidenceSectionOpen) return html;
  html += '<div id="review-evidence-content">';
  html += '<div class="review-hint">The status of each causal link and formula. These are informational records: they do not change the model\'s calculations.</div>';
  html += '<label class="review-evidence-filter"><span>Show</span><select class="review-evidence-select" id="review-evidence-filter" aria-label="Show evidence status">';
  html += '<option value="all"' + (evidenceStatusFilter === "all" ? " selected" : "") + '>All statuses</option>';
  for (const status of EVIDENCE_STATUSES) {
    html += '<option value="' + status + '"' + (evidenceStatusFilter === status ? " selected" : "") + '>' +
      escapeHtml(evidenceStatusLabel(status)) + '</option>';
  }
  html += '</select></label>';

  if (!matchingItems.length) {
    html += '<div class="review-empty"><b>No matching evidence records.</b> Choose another status to see the rest.</div></div>';
    return html;
  }
  html += '<div class="review-evidence-list">';
  for (const item of visibleItems) {
    html += '<div class="review-evidence-item" data-review-box="' + escapeHtml(item.boxId) + '"' +
      (item.edgeId ? ' data-review-evidence-edge="' + escapeHtml(item.edgeId) + '"' : "") + '>';
    html += '<div class="review-evidence-item-head"><span class="review-evidence-kind">' +
      (item.kind === "formula" ? "Formula" : "Causal link") + '</span>' +
      evidenceBadgeHtml(item.metadata) + '</div>';
    html += '<div class="review-evidence-label">' + escapeHtml(item.label) + '</div>';
    html += '<code class="review-evidence-detail">' + escapeHtml(item.detail) + '</code>';
    if (item.metadata.rationale) {
      html += '<div class="review-evidence-meta"><b>Rationale</b><span>' + escapeHtml(item.metadata.rationale) + '</span></div>';
    }
    if (item.metadata.source) {
      html += '<div class="review-evidence-meta"><b>Source</b><span>' + escapeHtml(item.metadata.source) + '</span></div>';
    }
    if (item.metadata.lastReviewed) {
      html += '<div class="review-evidence-meta"><b>Last reviewed</b><span>' + escapeHtml(item.metadata.lastReviewed) + '</span></div>';
    }
    html += '</div>';
  }
  html += '</div>';
  if (visibleItems.length < matchingItems.length) {
    const remainingItemCount = matchingItems.length - visibleItems.length;
    const nextBatchCount = Math.min(EVIDENCE_PREVIEW_LIMIT, remainingItemCount);
    html += '<button class="review-fold-toggle" id="review-evidence-more">Show ' +
      nextBatchCount + ' more · ' + remainingItemCount + ' remaining</button>';
  }
  return html + '</div>';
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

  if (resolvedIssueLabel) {
    html += '<div class="review-resolved">' +
      '<span><b>Fixed:</b> ' + escapeHtml(resolvedIssueLabel) + '</span>' +
      '<span class="review-resolved-actions">' +
        '<button type="button" class="review-apply" id="review-next-issue">Next issue</button>' +
        '<button type="button" class="review-secondary" id="review-stay-here">Stay here</button>' +
      '</span>' +
    '</div>';
  }

  if (summary.consequenceCount > 0) {
    html += '<div class="review-hint">' + summary.consequenceCount + ' further finding' +
            (summary.consequenceCount === 1 ? " is" : "s are") + ' folded into the cards below — ' +
            'boxes whose numbers are only wrong because something upstream of them is. ' +
            'Fix the cause and they clear themselves.</div>';
  }

  const snapshot = captureReviewModelSnapshot();
  const preparedGroups = summary.groups.map(group => {
    const fixableFinding = fixableFindingInGroup(group, snapshot);
    return { group, fixableFinding };
  });
  preparedGroups.sort((left, right) => Number(!!right.fixableFinding) - Number(!!left.fixableFinding));
  for (const preparedGroup of preparedGroups) {
    html += renderCauseCard(preparedGroup.group, snapshot, preparedGroup.fixableFinding);
  }
  return html;
}

function renderCauseCard(
  group: FindingGroup,
  snapshot = captureReviewModelSnapshot(),
  fixableFinding = fixableFindingInGroup(group, snapshot),
): string {
  const primaryFinding = fixableFinding || group.causes[0];
  const issueKey = findingIdentity(primaryFinding);
  const isExpanded = expandedIssueKey === issueKey;
  // Proposal generation ranks alternatives by detached before/after solves.
  // Collapsed cards need only the cheap capability answer; the one expanded
  // card pays for its proposals and preview.
  const proposals = isExpanded && fixableFinding
    ? reviewProposalsForFinding(fixableFinding, snapshot)
    : [];
  let html = '<div class="review-card review-issue-card' + (isExpanded ? " is-expanded" : "") + '">';
  html +=   '<button type="button" class="review-card-head review-card-toggle" data-review-issue="' +
            escapeHtml(issueKey) + '" aria-expanded="' + (isExpanded ? "true" : "false") + '">';
  html +=     '<span class="review-sev sev-' + group.severity + '" aria-hidden="true"></span>';
  html +=     '<span class="review-card-label">' + escapeHtml(group.label) + '</span>';
  if (group.boxId) html += '<span class="review-card-id">' + escapeHtml(group.boxId) + '</span>';
  if (fixableFinding) html += '<span class="review-direct-tag">Fix here</span>';
  html +=     '<span class="review-disclosure" aria-hidden="true">' + (isExpanded ? "−" : "+") + '</span>';
  html +=   '</button>';

  if (isExpanded) {
    html += '<div class="review-card-content">';
    for (const finding of group.causes) {
      html += '<div class="review-what">' + markCode(finding.message) + '</div>';
      if (finding.fix) html += '<div class="review-fix">' + markCode(finding.fix) + '</div>';
    }

    if (group.consequences.length) {
      html += '<div class="review-fold">';
      html +=   '<b>' + group.consequences.length + ' box' + (group.consequences.length === 1 ? "" : "es") +
                ' downstream also read wrong</b> — ' +
                group.consequences.slice(0, 5).map(consequence => escapeHtml(labelOf(consequence))).join(", ") +
                (group.consequences.length > 5 ? " and " + (group.consequences.length - 5) + " more" : "") + ".";
      html += '</div>';
    }

    if (fixableFinding && proposals.length) {
      html += renderProposalChoices(fixableFinding, proposals, snapshot);
    } else if (group.boxId) {
      html += '<button type="button" class="review-open-map" data-open-review-issue="' +
              escapeHtml(issueKey) + '">Open on map</button>';
    }
    html += '</div>';
  }

  html += '</div>';
  return html;
}

function findingIdentity(finding: Finding | undefined): string {
  if (!finding) return "missing-finding";
  return finding.issueKey || [finding.kind, finding.boxId || "map", finding.message].join(":");
}

function fixableFindingInGroup(
  group: FindingGroup,
  snapshot = captureReviewModelSnapshot(),
): Finding | undefined {
  return group.causes.find(finding => reviewFindingCanHaveProposal(finding, snapshot));
}

function proposalForDisplay(issueKey: string, proposals: ReviewProposal[]): ReviewProposal {
  const selectedIdentifier = selectedProposalIdentifierByIssueKey.get(issueKey);
  const selectedProposal = proposals.find(proposal => proposal.id === selectedIdentifier) || proposals[0];
  selectedProposalIdentifierByIssueKey.set(issueKey, selectedProposal.id);
  const editedProposal = editedProposalByIssueKey.get(issueKey);
  return editedProposal && editedProposal.id === selectedProposal.id ? editedProposal : selectedProposal;
}

function renderProposalChoices(
  finding: Finding,
  proposals: ReviewProposal[],
  snapshot: ReturnType<typeof captureReviewModelSnapshot>,
): string {
  const issueKey = findingIdentity(finding);
  const selectedProposal = proposalForDisplay(issueKey, proposals);
  const preview = previewReviewProposal(snapshot, selectedProposal);
  let html = '<div class="review-proposals" data-proposal-region="' + escapeHtml(issueKey) + '">';
  html += '<div class="review-proposal-label">Proposed fix</div>';
  for (const proposal of proposals) {
    const selected = proposal.id === selectedProposal.id;
    html += '<label class="review-proposal-option' + (selected ? " is-selected" : "") + '">';
    html += '<input type="radio" name="proposal-' + escapeHtml(issueKey) + '" data-review-proposal="' +
            escapeHtml(proposal.id) + '" data-review-issue-key="' + escapeHtml(issueKey) + '"' +
            (selected ? " checked" : "") + ' />';
    html += '<span><b>' + escapeHtml(proposal.label) + '</b><small>' + escapeHtml(proposal.explanation) + '</small></span>';
    html += '</label>';
  }
  html += renderOperationEditors(issueKey, selectedProposal.operations);
  html += '<div class="review-preview" data-review-preview="' + escapeHtml(issueKey) + '">' +
          renderProposalPreview(preview) + '</div>';
  html += '<button type="button" class="review-apply" data-confirm-review-fix="' +
          escapeHtml(issueKey) + '">Confirm fix</button>';
  html += '<button type="button" class="review-open-map" data-open-review-issue="' +
          escapeHtml(issueKey) + '">Open on map instead</button>';
  html += '</div>';
  return html;
}

function renderOperationEditors(issueKey: string, operations: ReviewFixOperation[]): string {
  let html = '<div class="review-editors">';
  operations.forEach((operation, operationIndex) => {
    if (operation.kind === "set-node-field") {
      const inputType = typeof operation.value === "number" ? "number" : "text";
      if (typeof operation.value === "boolean") return;
      html += '<label><span>' + escapeHtml(operation.field) + '</span><input type="' + inputType +
              '" data-review-operation="' + operationIndex + '" data-review-issue-key="' + escapeHtml(issueKey) +
              '" value="' + escapeHtml(String(operation.value ?? "")) + '" /></label>';
    } else if (operation.kind === "add-connection" || operation.kind === "update-connection") {
      html += '<label><span>Connection type</span><select class="review-editor-select" aria-label="Connection type" data-review-operation="' + operationIndex +
              '" data-review-issue-key="' + escapeHtml(issueKey) + '">';
      for (const effect of ["enables", "increases", "decreases"]) {
        html += '<option value="' + effect + '"' + (operation.effect === effect ? " selected" : "") + '>' + effect + '</option>';
      }
      html += '</select></label>';
    }
  });
  html += '</div>';
  return html;
}

function renderProposalPreview(preview: ReviewProposalPreview): string {
  let html = '<div class="review-preview-summary"><b>' + preview.issuesCleared + ' issue' +
    (preview.issuesCleared === 1 ? "" : "s") + ' cleared</b>';
  if (preview.issuesIntroduced) html += ' · <span class="is-warning">' + preview.issuesIntroduced + ' introduced</span>';
  html += ' · ' + preview.valueChanges.length + ' value' + (preview.valueChanges.length === 1 ? "" : "s") + ' change</div>';
  if (preview.valueChanges.length) {
    html += '<details><summary>Preview downstream values</summary><div class="review-value-changes">';
    for (const change of preview.valueChanges.slice(0, 12)) {
      html += '<div><span>' + escapeHtml(change.label) + '</span><code>' +
        escapeHtml(formatScalar(change.before)) + ' → ' + escapeHtml(formatScalar(change.after)) +
        (change.percentChange === null ? "" : ' (' + (change.percentChange > 0 ? "+" : "") + change.percentChange.toFixed(1) + '%)') +
        '</code></div>';
    }
    html += '</div></details>';
  }
  return html;
}

function openNextReviewIssue(): void {
  const summary = groupFindings(state.loadErrors);
  const snapshot = captureReviewModelSnapshot();
  const orderedGroups = [...summary.groups].sort((left, right) => {
    const leftFixable = fixableFindingInGroup(left, snapshot) ? 1 : 0;
    const rightFixable = fixableFindingInGroup(right, snapshot) ? 1 : 0;
    return rightFixable - leftFixable;
  });
  const nextGroup = orderedGroups[0];
  if (!nextGroup) {
    expandedIssueKey = null;
  } else {
    expandedIssueKey = findingIdentity(fixableFindingInGroup(nextGroup, snapshot) || nextGroup.causes[0]);
  }
  renderReview();
}

function currentReviewFinding(): Finding | undefined {
  if (expandedIssueKey) {
    const expandedFinding = findingByIdentity(expandedIssueKey);
    if (expandedFinding) return expandedFinding;
  }
  const summary = groupFindings(state.loadErrors);
  const snapshot = captureReviewModelSnapshot();
  const firstGroup = [...summary.groups].sort((left, right) =>
    Number(!!fixableFindingInGroup(right, snapshot)) - Number(!!fixableFindingInGroup(left, snapshot)),
  )[0];
  return firstGroup ? fixableFindingInGroup(firstGroup, snapshot) || firstGroup.causes[0] : undefined;
}

function openFindingOnMap(finding: Finding): void {
  const issueKey = findingIdentity(finding);
  pinnedIssueKey = issueKey;
  pinnedIssueFallback = { ...finding };
  pinnedIssueExpanded = false;
  closeReview();
  setUiMode("edit");
  if (finding.boxId && nodeById[finding.boxId]) {
    focusNode(finding.boxId);
    scrollNodeIntoView(finding.boxId);
  }
  renderPinnedIssueBanner();
}

function updateEditedProposalFromControl(
  issueKey: string,
  operationIndex: number,
  control: HTMLInputElement | HTMLSelectElement,
): void {
  const finding = findingByIdentity(issueKey);
  if (!finding) return;
  const snapshot = captureReviewModelSnapshot();
  const proposals = reviewProposalsForFinding(finding, snapshot);
  if (!proposals.length) return;
  const currentProposal = proposalForDisplay(issueKey, proposals);
  const editedProposal: ReviewProposal = {
    ...currentProposal,
    operations: currentProposal.operations.map(operation => ({ ...operation })),
  };
  const operation = editedProposal.operations[operationIndex];
  if (!operation) return;

  if (operation.kind === "set-node-field") {
    const originalValue = operation.value;
    operation.value = typeof originalValue === "number"
      ? (control.value === "" ? undefined : Number(control.value))
      : control.value;
  } else if (operation.kind === "add-connection" || operation.kind === "update-connection") {
    if (control.value === "enables" || control.value === "increases" || control.value === "decreases") {
      operation.effect = control.value;
    }
  }
  editedProposalByIssueKey.set(issueKey, editedProposal);

  const previewElement = document.querySelector('[data-review-preview="' + CSS.escape(issueKey) + '"]');
  if (previewElement) previewElement.innerHTML = renderProposalPreview(previewReviewProposal(snapshot, editedProposal));
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
  // Amber for a concern somebody raised; grey for a sign-off that merely went
  // stale, where nobody has objected to anything and the box has only changed
  // since it was checked. This was `stale ? "wrong" : "wrong"` — a conditional
  // that read as a distinction and made none.
  html +=     '<span class="review-sev sev-' + (stale ? "mismatch" : "wrong") + '" aria-hidden="true"></span>';
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
              'data-tooltip="Put this box back in the queue. The comment and who raised ' +
              'it are kept.">Reopen</button>';
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
  const sourceBoxCount = Math.max(0, NODES.length - done.total);
  const scopeExplanation = NODES.length === 0
    ? "There are no boxes on this map."
    : sourceBoxCount
      ? sourceBoxCount + " source box" + (sourceBoxCount === 1 ? " has" : "es have") +
        " no incoming links, so there is nothing feeding " + (sourceBoxCount === 1 ? "it" : "them") +
        " to judge. " + (sourceBoxCount === 1 ? "It is" : "They are") + " excluded from the pass."
      : "Every box has at least one incoming link, so every box is included.";
  if (done.total === 0) {
    return '<div class="review-section-head">' +
      '<span class="review-section-title">What nobody has checked yet</span></div>' +
      '<div class="review-empty"><b>Nothing to check.</b> A review pass asks, box by box, ' +
      'whether the links feeding it are right and complete. ' + escapeHtml(scopeExplanation) + '</div>';
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

  html += '<div class="review-scope-note"><b>Why ' + done.total + ' of ' + NODES.length + '?</b> ' +
          escapeHtml(scopeExplanation) + '</div>';

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
  // reports on, as well as in Export — a log you can only read on the
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
  // Guarded on its own flag rather than on the element checks below: those are
  // about the DOM, and this listener outlives any element. Registering it twice
  // would repaint the panel twice per verdict, for good.
  if (!listenersWired) {
    listenersWired = true;
    onReviewRecordChanged(refreshReview);
    document.addEventListener("review-findings-changed", () => {
      refreshReview();
      renderPinnedIssueBanner();
    });
  }

  const button = document.getElementById("review-button");
  if (button && !button.dataset.wired) {
    button.dataset.wired = "1";
    button.addEventListener("click", toggleReview);
  }

  const issueBanner = issueBannerElement();
  if (issueBanner && !issueBanner.dataset.wired) {
    issueBanner.dataset.wired = "1";
    issueBanner.addEventListener("click", event => {
      const target = event.target as HTMLElement;
      if (target.closest("#review-banner-dismiss")) {
        pinnedIssueKey = null;
        pinnedIssueFallback = null;
        renderPinnedIssueBanner();
        return;
      }
      if (target.closest("#review-banner-back")) {
        openReview();
        if (pinnedIssueKey && findingByIdentity(pinnedIssueKey)) expandedIssueKey = pinnedIssueKey;
        renderReview();
        return;
      }
      if (target.closest("#review-banner-next")) {
        pinnedIssueKey = null;
        pinnedIssueFallback = null;
        openReview();
        openNextReviewIssue();
        return;
      }
      if (target.closest("#review-banner-toggle")) {
        pinnedIssueExpanded = !pinnedIssueExpanded;
        renderPinnedIssueBanner();
      }
    });
  }

  const stage = stageEl();
  if (!stage || stage.dataset.wired) return;
  stage.dataset.wired = "1";

  stage.addEventListener("click", event => {
    const target = event.target as HTMLElement;

    if (target.closest("#review-close")) { closeReview(); return; }

    if (target.closest("#review-next-issue")) {
      resolvedIssueLabel = null;
      openNextReviewIssue();
      return;
    }

    if (target.closest("#review-stay-here")) {
      resolvedIssueLabel = null;
      renderReview();
      return;
    }

    const issueToggle = target.closest("[data-review-issue]") as HTMLElement | null;
    if (issueToggle) {
      const issueKey = issueToggle.getAttribute("data-review-issue")!;
      expandedIssueKey = expandedIssueKey === issueKey ? null : issueKey;
      resolvedIssueLabel = null;
      renderReview();
      return;
    }

    const proposalChoice = target.closest("[data-review-proposal]") as HTMLInputElement | null;
    if (proposalChoice) {
      const issueKey = proposalChoice.getAttribute("data-review-issue-key")!;
      selectedProposalIdentifierByIssueKey.set(issueKey, proposalChoice.getAttribute("data-review-proposal")!);
      editedProposalByIssueKey.delete(issueKey);
      renderReview();
      return;
    }

    const confirmFix = target.closest("[data-confirm-review-fix]") as HTMLElement | null;
    if (confirmFix) {
      const issueKey = confirmFix.getAttribute("data-confirm-review-fix")!;
      const finding = findingByIdentity(issueKey);
      if (!finding) { renderReview(); return; }
      const proposals = reviewProposalsForFinding(finding, captureReviewModelSnapshot());
      if (!proposals.length) { renderReview(); return; }
      const proposal = proposalForDisplay(issueKey, proposals);
      const node = finding.boxId ? nodeById[finding.boxId] : undefined;
      resolvedIssueLabel = node?.label || finding.boxId || "Review issue";
      expandedIssueKey = null;
      selectedProposalIdentifierByIssueKey.delete(issueKey);
      editedProposalByIssueKey.delete(issueKey);
      applyConfirmedReviewProposal(proposal);
      renderReview();
      return;
    }

    const openOnMap = target.closest("[data-open-review-issue]") as HTMLElement | null;
    if (openOnMap) {
      const issueKey = openOnMap.getAttribute("data-open-review-issue")!;
      const finding = findingByIdentity(issueKey);
      if (!finding) return;
      openFindingOnMap(finding);
      return;
    }

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

    if (target.closest("#review-evidence-toggle")) {
      evidenceSectionOpen = !evidenceSectionOpen;
      renderReview();
      document.getElementById("review-evidence-toggle")
        ?.scrollIntoView({ block: "nearest" });
      return;
    }

    if (target.closest("#review-evidence-more")) {
      evidenceVisibleLimit += EVIDENCE_PREVIEW_LIMIT;
      renderReview();
      return;
    }

    const evidenceLink = target.closest("[data-review-evidence-edge]") as HTMLElement | null;
    if (evidenceLink) {
      const edgeId = evidenceLink.getAttribute("data-review-evidence-edge")!;
      const sourceBoxId = evidenceLink.getAttribute("data-review-box")!;
      closeReview();
      setUiMode("edit");
      state.canvasEdit.openEdgeId = edgeId;
      if (nodeById[sourceBoxId]) {
        focusNode(sourceBoxId);
        scrollNodeIntoView(sourceBoxId);
      }
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
        // Reopen, not erase. The note, and the fact that somebody raised a
        // concern here, are the parts of a review that took effort to produce
        // and are the whole reason the log exists — dropping the verdict must
        // not drop them with it.
        reopenVerdict(boxId);
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

    const operationIndexText = target.getAttribute && target.getAttribute("data-review-operation");
    const proposalIssueKey = target.getAttribute && target.getAttribute("data-review-issue-key");
    if (operationIndexText !== null && proposalIssueKey) {
      updateEditedProposalFromControl(proposalIssueKey, Number(operationIndexText), target as HTMLInputElement | HTMLSelectElement);
      return;
    }

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

  stage.addEventListener("change", event => {
    const target = event.target as HTMLElement;
    if (target.id === "review-evidence-filter") {
      const filterValue = (target as HTMLSelectElement).value;
      evidenceStatusFilter = filterValue === "all"
        ? "all"
        : normaliseEvidenceStatus(filterValue);
      evidenceVisibleLimit = EVIDENCE_PREVIEW_LIMIT;
      renderReview();
      return;
    }
    const operationIndexText = target.getAttribute && target.getAttribute("data-review-operation");
    const proposalIssueKey = target.getAttribute && target.getAttribute("data-review-issue-key");
    if (operationIndexText !== null && proposalIssueKey) {
      updateEditedProposalFromControl(proposalIssueKey, Number(operationIndexText), target as HTMLInputElement | HTMLSelectElement);
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
