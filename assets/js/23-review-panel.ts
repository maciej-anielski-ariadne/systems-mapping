// =============================================================================
// REVIEW — the map-health signal, and the way in
// -----------------------------------------------------------------------------
// This used to be a 1,300-line overlay across the whole map: five sections in
// two columns, all of them lists of boxes you had to close the panel to look at.
// It is now a docked sidebar (25-review-sidebar) whose rows hand each item to
// the box panel (15b-review-item), so the list, the map and the controls that
// answer a question are on screen together.
//
// What is left here is the part that was never about the overlay: the Review
// button on the map, and the count riding on it.
//
// WHY THE COUNT IS ON THE MAP. A panel you have to remember to open is a panel
// nobody opens, and the six-second toast this replaced proved it. Counted in
// CAUSES, not findings: seventeen would be a lie about how much work there is.
// =============================================================================

import { state } from "./03-state";
import { groupFindings } from "./22-review";
import { onReviewRecordChanged, openItems, reviewAction } from "./24-review-record";
import { focusNode, scrollNodeIntoView } from "./09-graph-selection";
import {
  closeReviewSidebar, initReviewSidebar, openReviewSidebar, reviewSidebarIsOpen,
  syncReviewSidebar, toggleReviewSidebar,
} from "./25-review-sidebar";
import type { FindingGroup } from "./22-review";
import type { FindingSeverity } from "./types";

// ───── The way in and out ─────────────────────────────────────────────────
// Named as they always were, so the guided lessons, the loader and the canvas
// editor keep calling one thing rather than learning where it moved to.
export function reviewIsOpen(): boolean { return reviewSidebarIsOpen(); }
export function openReview(): void  { openReviewSidebar();  syncReviewButton(); }
export function closeReview(): void { closeReviewSidebar(); syncReviewButton(); }
export function toggleReview(): void { toggleReviewSidebar(); syncReviewButton(); }

// ───── The map-health signal ──────────────────────────────────────────────
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

  // The badge counts the sharp work; the tooltip says what else is in the list,
  // because four of the five kinds never reach the badge and a reader who has
  // only ever seen the number would not know they were there.
  const parts: string[] = [];
  if (causes) parts.push(causes + " thing" + (causes === 1 ? "" : "s") + " the loader flagged");
  if (open)   parts.push(open + " open from a review");
  button.setAttribute(
    "data-tooltip",
    parts.length
      ? parts.join(", ") + " — plus what nobody has checked, claims with no source, " +
        "and what each adjustable input does."
      : "Nothing flagged. The list still holds what nobody has checked, claims with no " +
        "source recorded, and what each adjustable input actually does.",
  );
}

function worstSeverity(groups: FindingGroup[]): FindingSeverity {
  const rank: Record<FindingSeverity, number> = { ignored: 0, wrong: 1, mismatch: 2 };
  let worst: FindingSeverity = "mismatch";
  for (const group of groups) if (rank[group.severity] < rank[worst]) worst = group.severity;
  return worst;
}

/**
 * The one call every other module makes: keep the badge honest, and if the
 * sidebar happens to be open, repaint it. Safe to call at any point — before
 * the DOM exists, before a map is loaded, with the sidebar shut.
 */
export function refreshReview(): void {
  syncReviewButton();
  if (reviewIsOpen()) syncReviewSidebar();
}

// ───── Wiring ─────────────────────────────────────────────────────────────
export function initReviewStage(): void {
  initReviewSidebar();

  const button = document.getElementById("review-button");
  if (button && !button.dataset.wired) {
    button.dataset.wired = "1";
    button.addEventListener("click", toggleReview);
  }

  if (document.body.dataset.reviewWired) return;
  document.body.dataset.reviewWired = "1";

  // Every verdict, and every start or stop of a pass, arrives through the
  // record's own notifier — which is what keeps the badge's open-flag count
  // honest without anything having to remember to repaint it.
  onReviewRecordChanged(syncReviewButton);

  // The loader rebuilds the findings on every load and every edit that could
  // change them. One event, so nothing has to remember to repaint.
  document.addEventListener("review-findings-changed", refreshReview);

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
    const focused = document.activeElement as HTMLElement | null;
    if (focused && (focused.tagName === "INPUT" || focused.tagName === "TEXTAREA" ||
                    focused.isContentEditable)) return;
    if (event.key !== "[" && event.key !== "]") return;
    if (!state.selectedNodeId) return;
    event.preventDefault();
    const result = reviewAction(state.selectedNodeId, event.key === "]" ? "next" : "prev");
    if (result.goTo) { focusNode(result.goTo); scrollNodeIntoView(result.goTo); }
  });
}
