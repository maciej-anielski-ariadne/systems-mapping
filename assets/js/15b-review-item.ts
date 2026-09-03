// =============================================================================
// THE REVIEW ITEM BLOCK — the current question, at the top of the box panel
// -----------------------------------------------------------------------------
// The sidebar down the left says WHERE YOU ARE in a review. This is WHAT YOU ARE
// DOING: the item it is standing on, with the controls that actually answer it,
// sitting above the box's own panel — which stays exactly as it was and stays
// fully editable underneath.
//
// One block, five bodies, because the five kinds of review item are answered in
// five genuinely different ways:
//
//   ISSUE      what the loader noticed. A proposed fix with a before/after
//              preview when one can be computed, and the explanation when not.
//   EVIDENCE   a gap in provenance. The link's or formula's OWN evidence fields,
//              so answering the item and recording the evidence are one action
//              rather than two things to keep in step.
//   FLAG       a concern somebody raised. What was said, and the two ways to
//              settle it: an account of what was done, or back on the queue.
//   UNCHECKED  a box nobody has judged. The verdict buttons already live further
//              down this panel during a pass, so this says where you are in the
//              queue and — when no pass is running — offers to start one.
//   INPUT      what a nudge on an adjustable box does. The gate that explains a
//              box moving nothing is the whole reason this is worth a card.
//
// WHY THE CONTROLS ARE HERE AND NOT IN THE LIST. Two places to answer the same
// question is two things to keep correct, and the box panel is already the one
// that has to be: the box's real numbers, its links and its fields are all here.
// =============================================================================

import type { EvidenceMetadata, Finding } from "./types";
import { edgeById, incomingEdges, nodeById, state } from "./03-state";
import { escapeHtml, formatScalar } from "./04-utils";
import {
  evidenceStatusOptionsHtml, evidenceStatusLabel, normaliseEvidenceStatus,
  updateEvidenceMetadata,
} from "./07c-evidence";
import { renderDetailPanel } from "./15-detail-panel";
import { applyCanvasMutation } from "./16f-canvas-mutations";
import {
  captureReviewModelSnapshot, previewReviewProposal, reviewProposalsForFinding,
} from "./22a-review-model";
import { applyConfirmedReviewProposal } from "./22b-review-apply";
import type { ReviewFixOperation, ReviewProposal, ReviewProposalPreview } from "./types";
import { findingIdentity } from "./22c-review-queue";
import type { ReviewItem } from "./22c-review-queue";
import {
  markAddressed, needsResponse, queuePosition, queueOrder, reopenVerdict,
  reviewStateOf, reviewerNamed, scheduleReviewSave, startReviewPass,
} from "./24-review-record";
import {
  clearReviewItem, currentReviewItem, goToNextReviewItem, selectReviewItem,
  syncReviewSidebar,
} from "./25-review-sidebar";

// Which alternative fix is showing, and any edit made to its fields. Keyed by
// the issue rather than held as one value: stepping away to another item and
// back should not silently discard the number somebody typed.
const selectedProposalByIssue = new Map<string, string>();
const editedProposalByIssue = new Map<string, ReviewProposal>();

const KIND_EYEBROW: Record<ReviewItem["kind"], string> = {
  issue:     "What the loader noticed",
  evidence:  "Evidence",
  flag:      "Flagged",
  unchecked: "Not checked",
  input:     "Adjustable box",
};

// ═════════════════════════════════════════════════════════════════════════════
// RENDER
// ═════════════════════════════════════════════════════════════════════════════

/** The block, or "" when no review item is current. */
export function reviewItemBlockHtml(): string {
  const item = currentReviewItem();
  if (!item) return "";

  let html = '<section class="review-item" data-review-item-block aria-label="Review item">';
  html +=   '<div class="review-item-head">';
  html +=     '<span class="review-item-kind">' + escapeHtml(KIND_EYEBROW[item.kind]) + '</span>';
  html +=     '<button type="button" class="review-item-close" data-review-item-action="dismiss" ' +
              'aria-label="Close this review item">×</button>';
  html +=   '</div>';
  html +=   '<div class="review-item-title">' + escapeHtml(item.name) + '</div>';

  switch (item.kind) {
    case "issue":     html += issueBody(item);     break;
    case "evidence":  html += evidenceBody(item);  break;
    case "flag":      html += flagBody(item);      break;
    case "unchecked": html += uncheckedBody(item); break;
    case "input":     html += inputBody(item);     break;
  }

  html += '<div class="review-item-foot">';
  html +=   '<button type="button" class="review-item-secondary" data-review-item-action="next">' +
            'Next item</button>';
  html += '</div>';
  html += '</section>';
  return html;
}

// ───── Issue ──────────────────────────────────────────────────────────────
function issueBody(item: ReviewItem): string {
  let html = "";
  for (const cause of item.causes || []) {
    html += '<div class="review-item-why">' + markCode(cause.message) + '</div>';
    if (cause.fix) html += '<div class="review-item-fix">' + markCode(cause.fix) + '</div>';
  }

  const consequences = item.consequenceLabels || [];
  if (consequences.length) {
    html += '<div class="review-item-fold"><b>' + consequences.length + ' box' +
            (consequences.length === 1 ? "" : "es") + ' downstream also read wrong</b> — ' +
            consequences.slice(0, 5).map(escapeHtml).join(", ") +
            (consequences.length > 5 ? " and " + (consequences.length - 5) + " more" : "") +
            '. Fix the cause and they clear themselves.</div>';
  }

  if (!item.finding) return html;
  const snapshot = captureReviewModelSnapshot();
  const proposals = reviewProposalsForFinding(item.finding, snapshot);
  if (!proposals.length) {
    html += '<div class="review-item-note">No fix can be proposed for this one — the box is ' +
            'open below, and the change has to be judged rather than applied.</div>';
    return html;
  }

  const issueKey = findingIdentity(item.finding);
  const proposal = proposalForDisplay(issueKey, proposals);
  html += '<div class="review-proposals" data-proposal-region="' + escapeHtml(issueKey) + '">';
  html += '<div class="review-proposal-label">Proposed fix</div>';
  for (const candidate of proposals) {
    const selected = candidate.id === proposal.id;
    html += '<label class="review-proposal-option' + (selected ? " is-selected" : "") + '">';
    html += '<input type="radio" name="proposal-' + escapeHtml(issueKey) + '" ' +
            'data-review-proposal="' + escapeHtml(candidate.id) + '" ' +
            'data-review-issue-key="' + escapeHtml(issueKey) + '"' +
            (selected ? " checked" : "") + ' />';
    html += '<span><b>' + escapeHtml(candidate.label) + '</b><small>' +
            escapeHtml(candidate.explanation) + '</small></span></label>';
  }
  html += operationEditors(issueKey, proposal.operations);
  html += '<div class="review-preview" data-review-preview="' + escapeHtml(issueKey) + '">' +
          proposalPreview(previewReviewProposal(snapshot, proposal)) + '</div>';
  html += '<button type="button" class="review-item-primary" ' +
          'data-review-item-action="confirm-fix" data-review-issue-key="' +
          escapeHtml(issueKey) + '">Confirm fix</button>';
  html += '</div>';
  return html;
}

function operationEditors(issueKey: string, operations: ReviewFixOperation[]): string {
  let html = '<div class="review-editors">';
  operations.forEach((operation, operationIndex) => {
    if (operation.kind === "set-node-field") {
      if (typeof operation.value === "boolean") return;
      const inputType = typeof operation.value === "number" ? "number" : "text";
      html += '<label><span>' + escapeHtml(operation.field) + '</span><input type="' + inputType +
              '" data-review-operation="' + operationIndex + '" data-review-issue-key="' +
              escapeHtml(issueKey) + '" value="' + escapeHtml(String(operation.value ?? "")) + '" /></label>';
    } else if (operation.kind === "add-connection" || operation.kind === "update-connection") {
      html += '<label><span>Link type</span><select class="review-editor-select" ' +
              'aria-label="Link type" data-review-operation="' + operationIndex +
              '" data-review-issue-key="' + escapeHtml(issueKey) + '">';
      for (const effect of ["enables", "increases", "decreases"]) {
        html += '<option value="' + effect + '"' +
                (operation.effect === effect ? " selected" : "") + '>' + effect + '</option>';
      }
      html += '</select></label>';
    }
  });
  return html + '</div>';
}

function proposalPreview(preview: ReviewProposalPreview): string {
  let html = '<div class="review-preview-summary"><b>' + preview.issuesCleared + ' issue' +
    (preview.issuesCleared === 1 ? "" : "s") + ' cleared</b>';
  if (preview.issuesIntroduced) {
    html += ' · <span class="is-warning">' + preview.issuesIntroduced + ' introduced</span>';
  }
  html += ' · ' + preview.valueChanges.length + ' value' +
          (preview.valueChanges.length === 1 ? "" : "s") + ' change</div>';
  if (preview.valueChanges.length) {
    html += '<details><summary>Preview downstream values</summary><div class="review-value-changes">';
    for (const change of preview.valueChanges.slice(0, 12)) {
      html += '<div><span>' + escapeHtml(change.label) + '</span><code>' +
        escapeHtml(formatScalar(change.before)) + ' → ' + escapeHtml(formatScalar(change.after)) +
        (change.percentChange === null
          ? ""
          : ' (' + (change.percentChange > 0 ? "+" : "") + change.percentChange.toFixed(1) + '%)') +
        '</code></div>';
    }
    html += '</div></details>';
  }
  return html;
}

function proposalForDisplay(issueKey: string, proposals: ReviewProposal[]): ReviewProposal {
  const chosenId = selectedProposalByIssue.get(issueKey);
  const chosen = proposals.find(proposal => proposal.id === chosenId) || proposals[0];
  selectedProposalByIssue.set(issueKey, chosen.id);
  const edited = editedProposalByIssue.get(issueKey);
  return edited && edited.id === chosen.id ? edited : chosen;
}

// ───── Evidence ───────────────────────────────────────────────────────────
// The fields ARE the answer. Recording why a link is believed and where the
// belief came from is the whole of what this item asks for, so it asks for it
// here rather than sending the reader somewhere else to type it.
function evidenceBody(item: ReviewItem): string {
  const record = item.evidence;
  if (!record) return "";
  const metadata = record.metadata;
  const edge = item.edgeId ? edgeById[item.edgeId] : undefined;

  let html = '<div class="review-item-why">' + escapeHtml(item.why) + '</div>';

  html += '<div class="review-item-facts">';
  if (edge) {
    if (typeof edge.elasticity === "number" && isFinite(edge.elasticity)) {
      html += '<span><b>' + edge.elasticity.toFixed(2) + '</b> strength</span>';
    }
    html += '<span><b>' + escapeHtml(edge.effect) + '</b></span>';
  } else if (record.kind === "formula") {
    html += '<code class="review-item-code">' + escapeHtml(record.detail) + '</code>';
  }
  html += '</div>';

  html += '<div class="review-item-note">This records provenance only; it never changes the ' +
          'calculation.</div>';

  html += '<div class="review-evidence-fields">';
  html += '<label><span>Status</span><select data-review-evidence-field="status" ' +
          'aria-label="Evidence status">' + evidenceStatusOptionsHtml(metadata.status) +
          '</select></label>';
  html += '<label><span>Why we believe it</span><textarea rows="2" ' +
          'data-review-evidence-field="rationale" placeholder="Why this status is appropriate">' +
          escapeHtml(metadata.rationale || "") + '</textarea></label>';
  html += '<label><span>Where it came from</span><input type="text" ' +
          'data-review-evidence-field="source" placeholder="Document, dataset, URL, or reference" ' +
          'value="' + escapeHtml(metadata.source || "") + '" /></label>';
  html += '<label><span>Last reviewed</span><input type="text" ' +
          'data-review-evidence-field="lastReviewed" placeholder="YYYY-MM-DD" value="' +
          escapeHtml(metadata.lastReviewed || "") + '" /></label>';
  html += '</div>';

  html += '<button type="button" class="review-item-primary" ' +
          'data-review-item-action="evidence-done">Save and next</button>';
  return html;
}

// ───── Flag ───────────────────────────────────────────────────────────────
function flagBody(item: ReviewItem): string {
  const row = item.logRow;
  if (!row) return "";
  const stale = row.now === "stale";

  let html = "";
  if (stale) {
    html += '<div class="review-item-why">Signed off by ' +
            escapeHtml(row.entry.reviewer || "someone") + ' on ' + escapeHtml(row.entry.date) +
            ', and what drives it has changed since. The sign-off no longer applies.</div>';
  } else if (row.entry.note) {
    html += '<div class="review-item-quote">' + escapeHtml(row.entry.note) + '</div>';
  } else {
    html += '<div class="review-item-why">Flagged with no note.</div>';
  }

  if (row.flaggedLabels.length) {
    html += '<div class="review-item-fold"><b>' + row.flaggedLabels.length + ' link' +
            (row.flaggedLabels.length === 1 ? "" : "s") + ' flagged</b> — ' +
            escapeHtml(row.flaggedLabels.join(", ")) + '.</div>';
  }
  html += '<div class="review-item-by">' + escapeHtml(row.entry.reviewer || "unsigned") +
          ' · ' + escapeHtml(row.entry.date) + '</div>';

  // Closing a concern needs an account of what was DONE about it — the note
  // above says what was wrong, which is a different thing. Re-confirming a
  // sign-off that merely went stale is not closing a concern, so nothing is
  // asked for there; needsResponse draws that line.
  const closingAFlag = needsResponse(row.entry.boxId);
  if (closingAFlag) {
    html += '<textarea class="review-item-close-note" rows="2" data-review-close-note ' +
            'placeholder="What was done about it? — needed to close">' +
            escapeHtml(row.entry.addressedNote) + '</textarea>';
  }
  html += '<div class="review-item-actions">';
  html +=   '<button type="button" class="review-item-primary" ' +
            'data-review-item-action="log-addressed"' +
            (closingAFlag && !row.entry.addressedNote.trim() ? " disabled" : "") + '>' +
            (stale && !closingAFlag ? "Still fine" : "Addressed") + '</button>';
  html +=   '<button type="button" class="review-item-secondary" ' +
            'data-review-item-action="log-reopen" ' +
            'data-tooltip="Put this box back in the queue. The comment and who raised it are ' +
            'kept.">Reopen</button>';
  html += '</div>';
  return html;
}

// ───── Not checked ────────────────────────────────────────────────────────
function uncheckedBody(item: ReviewItem): string {
  const position = item.boxId ? queuePosition(item.boxId) : 0;
  const total = queueOrder().length;

  // The same question the card below asks, and it splits the same way: a box
  // nothing drives is asked whether anything should. Two headings disagreeing
  // about what is being asked, one above the other, is worse than either.
  const drivers = item.boxId ? (incomingEdges[item.boxId] || []).length : 0;
  let html = '<div class="review-item-why">' + (drivers === 0
    ? "Should anything drive this box? Nothing does — every number it carries comes from the " +
      "value typed on it."
    : "Is this everything that drives this box? The list of what drives it is below, with a " +
      "mark against each link.") + '</div>';
  if (position && total) {
    html += '<div class="review-item-facts"><span><b>' + position + '</b> of ' + total +
            ' in the pass</span></div>';
  }

  if (!state.reviewPass) {
    html += '<div class="review-item-note">A verdict is signed with your name and travels with ' +
            'the map, so it is recorded during a pass rather than one box at a time.</div>';
    html += '<button type="button" class="review-item-primary" ' +
            'data-review-item-action="start-pass"' + (reviewerNamed() ? "" : " disabled") + '>' +
            (reviewerNamed() ? "Start a pass" : "Your name first — in the list on the left") +
            '</button>';
  }
  return html;
}

// ───── Adjustable box ─────────────────────────────────────────────────────
function inputBody(item: ReviewItem): string {
  const exception = item.exception;
  if (!exception) return "";
  let html = '<div class="review-item-why">' + escapeHtml(exception.detail) + '</div>';

  // The arms of the gate, when there are any. "It moves nothing" is the symptom;
  // this is the answer, and it is the whole reason this is worth a card.
  if (exception.gate) {
    html += '<div class="review-arms">';
    for (const arm of exception.gate.arms) {
      html += '<div class="review-arm' + (arm.binding ? " is-binding" : "") + '">';
      html +=   '<span class="review-arm-text">' + escapeHtml(arm.text) + '</span>';
      html +=   '<span class="review-arm-value">' + escapeHtml(formatScalar(arm.value)) + '</span>';
      html +=   '<span class="review-arm-tag">' + (arm.binding ? "binding" : "spare") + '</span>';
      html += '</div>';
    }
    html += '</div>';
  }

  html += '<div class="review-item-fix">' + escapeHtml(exception.fix) + '</div>';
  html += '<div class="review-item-note">Nothing here is invalid. It computes correctly and would ' +
          'pass every check — it is only not what was intended.</div>';

  // Two of the five ask something a verdict on this box answers: whether the
  // map is meant to start here. The verdict buttons are further down this same
  // panel during a pass — the queue does not grow a second set of them, for the
  // reason at the top of this file — so this says where they are, and offers
  // the pass when none is running.
  if (exception.kind === "unreachable" || exception.kind === "inert") {
    const now = item.boxId ? reviewStateOf(item.boxId) : "unreviewed";
    if (now === "agreed" || now === "flagged") {
      html += '<div class="review-item-facts"><span>' +
              (now === "agreed" ? "<b>Agreed</b> — recorded against this box" : "<b>Flagged</b>") +
              ', and it travels with the map. Reopen it on the card below.</span></div>';
    } else if (state.reviewPass) {
      html += '<div class="review-item-note">Agreeing on this box below records that it is meant ' +
              'to be this way — signed with your name, kept in the map, and back in the queue if ' +
              'what drives this box ever changes.</div>';
    } else {
      html += '<div class="review-item-note">A verdict is signed with your name and travels with ' +
              'the map, so it is recorded during a pass rather than one box at a time.</div>';
      html += '<button type="button" class="review-item-primary" ' +
              'data-review-item-action="start-pass-here"' + (reviewerNamed() ? "" : " disabled") + '>' +
              (reviewerNamed() ? "Start a pass" : "Your name first — in the list on the left") +
              '</button>';
    }
  }
  return html;
}

// Loader messages carry `backticked ids`. Rendering them as code is the
// difference between a sentence about a box and a sentence you can pick an id
// out of. Escaped first, so nothing in the spreadsheet can inject markup.
function markCode(text: string): string {
  return escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>");
}

// ═════════════════════════════════════════════════════════════════════════════
// WIRING
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Wire the block inside a freshly rendered box panel. Called once per render
 * from renderDetailPanel, alongside the panel's own handlers.
 */
export function wireReviewItemBlock(container: HTMLElement): void {
  const block = container.querySelector<HTMLElement>("[data-review-item-block]");
  if (!block) return;

  block.addEventListener("click", event => {
    const button = (event.target as HTMLElement).closest("[data-review-item-action]");
    if (!button) return;
    // The panel behind this is not a click-through, but the map underneath is:
    // a stray bubble here must not move the selection.
    event.stopPropagation();
    switch (button.getAttribute("data-review-item-action")) {
      case "dismiss":        clearReviewItem(); return;
      case "next":           goToNextReviewItem(); return;
      case "evidence-done":  goToNextReviewItem(); return;
      case "confirm-fix":    confirmFix(button.getAttribute("data-review-issue-key") || ""); return;
      case "log-addressed":  closeFlag(block); return;
      case "log-reopen":     reopenFlag(); return;
      case "start-pass": {
        const goTo = startReviewPass();
        if (goTo) selectReviewItem("unchecked:" + goTo);
        return;
      }
      // The same pass, started from an item that is NOT a coverage row: the
      // reviewer is working the odd-input list and the first unchecked box is
      // not where they were going. Start it and stay put — the verdict buttons
      // appear on the panel underneath.
      case "start-pass-here": {
        startReviewPass();
        renderDetailPanel();
        syncReviewSidebar();
        return;
      }
    }
  });

  block.addEventListener("change", event => {
    const target = event.target as HTMLElement;
    if (handleProposalControl(target, block)) return;
    if (target.hasAttribute("data-review-evidence-field")) writeEvidence(target);
  });

  block.addEventListener("input", event => {
    const target = event.target as HTMLElement;
    if (handleProposalControl(target, block)) return;
    // Free text commits while typing, as it does in the box panel's own evidence
    // editor: a rationale lost because somebody navigated away without blurring
    // is exactly the sort of thing this queue exists to stop happening.
    const field = target.getAttribute("data-review-evidence-field");
    if (field === "rationale" || field === "source") { writeEvidence(target, true); return; }
    if (target.hasAttribute("data-review-close-note")) {
      const addressed = block.querySelector<HTMLButtonElement>('[data-review-item-action="log-addressed"]');
      if (addressed) addressed.disabled = !(target as HTMLTextAreaElement).value.trim();
    }
  });
}

function handleProposalControl(target: HTMLElement, block: HTMLElement): boolean {
  const issueKey = target.getAttribute("data-review-issue-key");
  if (!issueKey) return false;

  const proposalId = target.getAttribute("data-review-proposal");
  if (proposalId) {
    selectedProposalByIssue.set(issueKey, proposalId);
    editedProposalByIssue.delete(issueKey);
    // The radio changed which fix is showing, so the editors and the preview
    // under it belong to a different proposal. Re-rendering the panel is the
    // only honest way to swap them.
    renderDetailPanel();
    return true;
  }

  const operationIndex = target.getAttribute("data-review-operation");
  if (operationIndex === null) return false;
  updateEditedProposal(issueKey, Number(operationIndex), target as HTMLInputElement, block);
  return true;
}

function updateEditedProposal(
  issueKey: string,
  operationIndex: number,
  control: HTMLInputElement | HTMLSelectElement,
  block: HTMLElement,
): void {
  const item = currentReviewItem();
  const finding: Finding | undefined = item?.finding;
  if (!finding) return;
  const snapshot = captureReviewModelSnapshot();
  const proposals = reviewProposalsForFinding(finding, snapshot);
  if (!proposals.length) return;

  const current = proposalForDisplay(issueKey, proposals);
  const edited: ReviewProposal = {
    ...current,
    operations: current.operations.map(operation => ({ ...operation })),
  };
  const operation = edited.operations[operationIndex];
  if (!operation) return;

  if (operation.kind === "set-node-field") {
    operation.value = typeof operation.value === "number"
      ? (control.value === "" ? undefined : Number(control.value))
      : control.value;
  } else if (operation.kind === "add-connection" || operation.kind === "update-connection") {
    if (control.value === "enables" || control.value === "increases" || control.value === "decreases") {
      operation.effect = control.value;
    }
  }
  editedProposalByIssue.set(issueKey, edited);

  // Only the preview is redrawn. Re-rendering the panel would take the focus
  // out of the field being typed in.
  const preview = block.querySelector('[data-review-preview]');
  if (preview) preview.innerHTML = proposalPreview(previewReviewProposal(snapshot, edited));
}

function confirmFix(issueKey: string): void {
  const item = currentReviewItem();
  if (!item?.finding) return;
  const proposals = reviewProposalsForFinding(item.finding, captureReviewModelSnapshot());
  if (!proposals.length) return;
  const proposal = proposalForDisplay(issueKey, proposals);
  selectedProposalByIssue.delete(issueKey);
  editedProposalByIssue.delete(issueKey);
  applyConfirmedReviewProposal(proposal);
  // The finding this item was about no longer exists, so the queue drops it and
  // the block goes with it. Move on rather than leaving the panel on a question
  // that has been answered.
  goToNextReviewItem();
}

function closeFlag(block: HTMLElement): void {
  const item = currentReviewItem();
  const boxId = item?.logRow?.entry.boxId;
  if (!boxId) return;
  const field = block.querySelector<HTMLTextAreaElement>("[data-review-close-note]");
  // Refused when there is nothing to record. The button is disabled until there
  // is, so this is the belt to that braces — markAddressed is what decides, and
  // it says no by writing nothing.
  if (!markAddressed(boxId, field ? field.value : "")) return;
  scheduleReviewSave();
  goToNextReviewItem();
}

function reopenFlag(): void {
  const boxId = currentReviewItem()?.logRow?.entry.boxId;
  if (!boxId) return;
  // Reopen, not erase. The note, and the fact that somebody raised a concern
  // here, are the parts of a review that took effort to produce.
  reopenVerdict(boxId);
  scheduleReviewSave();
}

function writeEvidence(target: HTMLElement, skipHistoryCapture = false): void {
  const item = currentReviewItem();
  const record = item?.evidence;
  if (!record) return;
  const field = target.getAttribute("data-review-evidence-field") as keyof EvidenceMetadata | null;
  if (!field) return;
  const value = (target as HTMLInputElement).value;

  if (record.edgeId) {
    const edge = edgeById[record.edgeId];
    if (!edge) return;
    edge.evidence = updateEvidenceMetadata(edge.evidence, field, value);
  } else {
    const node = nodeById[record.boxId];
    if (!node) return;
    node.formulaEvidence = updateEvidenceMetadata(node.formulaEvidence, field, value);
  }

  applyCanvasMutation({ skipDetailRender: true, impact: "presentation", skipHistoryCapture });
  // The row's reason for being in the queue may have just stopped being true.
  syncReviewSidebar();

  if (field === "status") {
    const status = normaliseEvidenceStatus(value);
    const badge = target.closest(".review-item")?.querySelector<HTMLElement>(".evidence-badge");
    if (badge) {
      badge.className = "evidence-badge evidence-" + status;
      badge.textContent = evidenceStatusLabel(status);
    }
  }
}
