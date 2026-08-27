// =============================================================================
// THE REVIEW RAIL — the queue, beside the map, for the length of a pass
// -----------------------------------------------------------------------------
// Before this, the two halves of a review never shared a screen: opening the
// Review panel hid the map, and starting a pass closed the panel. Once you were
// walking the queue the only trace of it was the words "box 23 of 55" — no sense
// of what was done, what was left, or any way to jump to a particular box. The
// only route back to the list was to leave the pass.
//
// So the list docks. For the length of the pass it takes the left column — the
// one reading mode gives to the map — and holds every box in the queue, grouped
// by the map's own columns, each with a mark for where it stands. Clicking a row
// goes there. That makes one list both the progress report and the navigation,
// which is the whole point: there is no second copy to keep in step.
//
// WHY THE VERDICT IS NOT IN HERE. The question and the buttons stay in the box
// panel, where they already live and where the box's real numbers are. A second
// place to answer would be a second thing to keep correct, and the panel is
// already the one that has to be.
//
// NARROW WINDOWS. Below 1100px, 260 + map + 340 stops being a sensible split, so
// the same markup re-lays-out as a dock along the bottom with the list in a tray.
// Same rows, same state, same handlers — a media query rather than a second
// component. The app fills the viewport, so window width IS the app's width here;
// this is the one place a viewport query answers the right question.
// =============================================================================

import { state, nodeById, stageById, incomingEdges, STAGES } from "./03-state";
import { escapeHtml } from "./04-utils";
import { focusNode, scrollNodeIntoView, onSelectionChanged } from "./09-graph-selection";
import { downloadTextBlob } from "./19-export";
import {
  coverage, queueOrder, reviewStateOf, nextOutstanding, endReviewPass,
  onReviewRecordChanged, reviewReportCsv, reviewReportFilename, commentOn,
} from "./24-review-record";
import type { ReviewState } from "./24-review-record";

/** Which rows the rail is showing. "open" is the default working set. */
type RailFilter = "all" | "open" | "flagged" | "stale";

let filter: RailFilter = "all";
let trayOpen = false;
let listenersWired = false;

// One glyph per state, and a word for anything that reads it aloud. The colour
// is a repeat of the mark, never the only carrier: severity is data here, the
// same exception the review panel's dots make to the affordance language.
const MARK: Record<ReviewState, string> = {
  agreed: "✓", flagged: "!", stale: "~", unreviewed: "○",
};
const WORD: Record<ReviewState, string> = {
  agreed: "agreed", flagged: "flagged", stale: "changed since it was checked",
  unreviewed: "not checked yet",
};

function railEl(): HTMLElement | null {
  return document.getElementById("review-rail");
}

// ═════════════════════════════════════════════════════════════════════════════
// RENDER
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Show, hide and repaint the rail. Called from the one place a verdict can
 * change (the record's notifier, which also fires when a pass starts or stops)
 * and from the one place a selection can change (11-rendering's funnel), so
 * there is no path that leaves it stale.
 */
export function syncReviewRail(): void {
  const rail = railEl();
  if (!rail) return;

  // A pass turns the box panel into a review card only while reading, so the
  // rail follows the same rule rather than inventing a second one.
  const showing = state.dataLoaded && state.reviewPass &&
                  state.uiMode === "read" && !state.simulationMode;
  rail.hidden = !showing;
  document.body.classList.toggle("review-rail-open", showing);
  if (!showing) {
    rail.innerHTML = "";
    trayOpen = false;
    // A filter belongs to the sitting, not to the map. Left set, the next pass
    // opened showing only the boxes somebody had chipped down to yesterday —
    // a queue of three, looking exactly like a queue of three.
    filter = "all";
    return;
  }

  // The rebuild below throws away every element in the rail, INCLUDING the one
  // the keyboard is standing on: press "Next unchecked" and the button that was
  // just activated stops existing, focus falls back to the body, and pressing it
  // again does nothing until you have tabbed the length of the list. So note
  // what had focus, by the attribute that identifies it rather than by the
  // element, and put it back on whatever now plays that part.
  const returnTo = focusedControl(rail);

  rail.classList.toggle("tray-open", trayOpen);
  rail.innerHTML = railHtml();

  if (returnTo) {
    const again = rail.querySelector(returnTo) as HTMLElement | null;
    // preventScroll: the scroll this function wants is the current row's, below.
    if (again) again.focus({ preventScroll: true });
  }

  // Keep the box you are standing on in view. `nearest` rather than `center`:
  // stepping down the queue should scroll the list by a row, not jump it.
  const current = rail.querySelector(".rail-row.is-current");
  if (current) current.scrollIntoView({ block: "nearest" });
}

/**
 * A selector for whichever rail control has focus, or null.
 *
 * By attribute rather than by index: the list is re-ordered and re-filtered
 * between renders, so "the third button" names a different thing afterwards
 * where `[data-rail="next"]` names the same one.
 */
function focusedControl(rail: HTMLElement): string | null {
  const active = document.activeElement as HTMLElement | null;
  if (!active || !rail.contains(active)) return null;
  for (const attribute of ["data-rail", "data-rail-filter", "data-rail-box"]) {
    const value = active.getAttribute(attribute);
    if (value !== null) return "[" + attribute + '="' + quoteForSelector(value) + '"]';
  }
  return null;
}

// Box ids come from a spreadsheet, so they are not guaranteed to be safe inside
// a selector. Within a QUOTED attribute value those are the only two characters
// that need it, which is the whole of the job here — and doing it by hand rather
// than through CSS.escape keeps this working in the test environment, where the
// function cannot be called off the object it belongs to.
function quoteForSelector(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

function railHtml(): string {
  const done = coverage();
  const settled = done.agreed + done.flagged;
  const left = done.unreviewed + done.stale;
  const pc = (n: number) => (done.total ? (n / done.total) * 100 : 0).toFixed(2) + "%";

  let html = '<div class="rail-head">';
  html +=   '<div class="rail-eyebrow">Review pass</div>';
  html +=   '<div class="rail-count">' + settled + " of " + done.total +
            " <span>checked</span></div>";
  html +=   '<div class="rail-bar" role="progressbar" aria-valuenow="' + settled +
            '" aria-valuemin="0" aria-valuemax="' + done.total + '">';
  if (done.agreed)  html += '<i class="cov-agreed" style="width:' + pc(done.agreed) + '"></i>';
  if (done.flagged) html += '<i class="cov-flagged" style="width:' + pc(done.flagged) + '"></i>';
  if (done.stale)   html += '<i class="cov-stale" style="width:' + pc(done.stale) + '"></i>';
  html +=   "</div>";
  html += "</div>";

  html += '<div class="rail-tray">';
  html +=   '<div class="rail-chips">';
  html +=     chip("all", "All " + done.total);
  html +=     chip("open", "Not checked " + left);
  html +=     chip("flagged", "Flagged " + done.flagged);
  if (done.stale) html += chip("stale", "Changed " + done.stale);
  html +=   "</div>";
  html +=   '<div class="rail-list">' + rowsHtml() + "</div>";
  html += "</div>";

  html += '<div class="rail-foot">';
  html +=   '<button type="button" class="rail-next" data-rail="next"' +
            (left ? "" : " disabled") + '>' +
            (left ? "Next unchecked — " + left + " to go" : "Every box has been checked") +
            "</button>";
  html +=   '<div class="rail-foot-row">';
  html +=     '<button type="button" class="rail-btn rail-tray-toggle" data-rail="tray" ' +
              'aria-expanded="' + (trayOpen ? "true" : "false") + '">' +
              (trayOpen ? "▾ Hide the list" : "▸ The list — " + done.total) + "</button>";
  html +=     '<button type="button" class="rail-btn" data-rail="export" ' +
              'data-tooltip="A .csv of every box: checked or not, by whom, when, the ' +
              'comments, and whether they have been dealt with.">Export the log</button>';
  html +=     '<button type="button" class="rail-btn" data-rail="stop" ' +
              'data-tooltip="Leave the pass. Everything said so far is kept.">Stop</button>';
  html +=   "</div>";
  html += "</div>";
  return html;
}

function chip(key: RailFilter, label: string): string {
  return '<button type="button" class="rail-chip' + (filter === key ? " on" : "") +
    '" data-rail-filter="' + key + '" aria-pressed="' + (filter === key ? "true" : "false") +
    '">' + escapeHtml(label) + "</button>";
}

function passes(now: ReviewState): boolean {
  if (filter === "all") return true;
  if (filter === "open") return now === "unreviewed" || now === "stale";
  return now === filter;
}

// Grouped by the map's own columns, in queue order within each. Grouping by
// something the reader can already see on the map is what makes a list of
// fifty-five names navigable — "I am somewhere in Border Processing" is a
// position, where "box 23" is only a number.
//
// BUCKETED, not run-length segmented over the queue. Causes-before-effects walks
// in and out of the same column several times: on the border map the segmented
// version produced eleven headings for six columns, naming "Border Processing"
// three separate times. The same column named over and over is not a grouping,
// it is a list with interruptions.
//
// The pass still STEPS in queue order — Next unchecked and the [ ] keys are
// unaffected. This is the order you READ the list in, and since the map's own
// columns already run cause to effect left to right, the two barely differ.
function rowsHtml(): string {
  const queue = queueOrder();

  // Every box's state, and every column's tally, in ONE pass over the queue.
  // Both used to be worked out where they were needed — the state per row and
  // again inside a per-column `queue.filter(...)` — which asked reviewStateOf,
  // and so re-hashed a fingerprint over the box's whole set of incoming links,
  // (2 + columns) times per box. This render runs on every keystroke in the note
  // field, so on the map this was built against that was some four hundred
  // hashes per character typed.
  const stateOf = new Map<string, ReviewState>();
  const columnOf = new Map<string, string>();
  const tally = new Map<string, { agreed: number; total: number }>();
  for (const id of queue) {
    const now = reviewStateOf(id);
    const columnId = (nodeById[id] && nodeById[id].stage) || "";
    stateOf.set(id, now);
    columnOf.set(id, columnId);
    const count = tally.get(columnId) || { agreed: 0, total: 0 };
    count.total++;
    if (now === "agreed") count.agreed++;
    tally.set(columnId, count);
  }

  const shown = queue.filter(id => passes(stateOf.get(id)!));
  if (!shown.length) {
    return '<div class="rail-empty">Nothing matches that filter.</div>';
  }

  const buckets = new Map<string, string[]>();
  for (const id of shown) {
    const columnId = columnOf.get(id)!;
    const list = buckets.get(columnId) || [];
    list.push(id);
    buckets.set(columnId, list);
  }
  // The map's own left-to-right column order, then anything sitting in a column
  // the map does not list — dropping those silently would lose boxes.
  const columnOrder = STAGES.map(s => s.id).filter(id => buckets.has(id));
  for (const columnId of buckets.keys()) {
    if (columnOrder.indexOf(columnId) === -1) columnOrder.push(columnId);
  }

  let html = "";
  for (const columnId of columnOrder) {
    // Counted over the whole queue, not over what the filter is showing: "3/14
    // checked" is about the column, and would be a different and much less
    // useful number if it moved every time a chip was pressed.
    const all = tally.get(columnId) || { agreed: 0, total: 0 };
    const label = (stageById[columnId] && stageById[columnId].label) || columnId || "Elsewhere";
    html += '<div class="rail-group">' + escapeHtml(label) +
            " <b>" + all.agreed + "/" + all.total + "</b></div>";

    for (const id of buckets.get(columnId)!) {
    const node = nodeById[id];
    if (!node) continue;
    const now = stateOf.get(id)!;
    const links = (incomingEdges[id] || []).length;
    // A comment on a box nobody has judged yet would otherwise be invisible
    // here: the box reads as "not checked" like any other, and the note only
    // shows on the box itself. That is the same write-only failure the log was
    // built to fix, one state down.
    const comment = commentOn(id);
    // The glyph and the count are decoration for anything not looking at the
    // screen; the label carries the same facts in words.
    const spoken = (node.label || id) + " — " + WORD[now] + ", " +
                   links + " link" + (links === 1 ? "" : "s") +
                   (comment ? ", has a comment" : "");
    html += '<button type="button" class="rail-row rv-' + now +
      (id === state.selectedNodeId ? " is-current" : "") +
      '" data-rail-box="' + escapeHtml(id) + '" aria-label="' + escapeHtml(spoken) + '"' +
      (comment ? ' data-tooltip="' + escapeHtml(comment) + '"' : "") + ">" +
      '<span class="rail-mark" aria-hidden="true">' + MARK[now] + "</span>" +
      '<span class="rail-name">' + escapeHtml(node.label || id) + "</span>" +
      (comment ? '<span class="rail-note-dot" aria-hidden="true"></span>' : "") +
      '<span class="rail-links" aria-hidden="true">' + links + "</span>" +
      "</button>";
    }
  }
  return html;
}

// ═════════════════════════════════════════════════════════════════════════════
// THE EXPORT
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The review log as a spreadsheet. Exported from here rather than folded into
 * the map's own .csv because it answers a different question: the map file is
 * for loading back, this is for showing somebody what has been checked and what
 * is still open.
 */
export function downloadReviewLog(): void {
  downloadTextBlob(reviewReportCsv(), reviewReportFilename(), "text/csv;charset=utf-8");
}

// ═════════════════════════════════════════════════════════════════════════════
// WIRING
// ═════════════════════════════════════════════════════════════════════════════
// One delegated listener on the rail, which is stable; its contents are not.
export function initReviewRail(): void {
  // Both notifiers are single funnels: every verdict, and starting or stopping a
  // pass, goes through the record's listeners, and every selection change goes
  // through 11-rendering's. Wiring to the funnels rather than to the call sites
  // is deliberate — a rail that updates on three paths out of four is worse than
  // no rail, because it is wrong rather than absent.
  // Registered once, and guarded here rather than by the element check below:
  // that one is about the DOM, and these listeners outlive any element. A second
  // call used to append them again — the listener arrays have no removal — so
  // every verdict after it rendered the rail twice, and the count grew with each
  // init.
  if (!listenersWired) {
    listenersWired = true;
    onReviewRecordChanged(syncReviewRail);
    onSelectionChanged(syncReviewRail);
  }

  const rail = railEl();
  if (!rail || rail.dataset.wired) return;
  rail.dataset.wired = "1";

  rail.addEventListener("click", event => {
    const target = event.target as HTMLElement;

    const chipEl = target.closest("[data-rail-filter]") as HTMLElement | null;
    if (chipEl) {
      filter = chipEl.getAttribute("data-rail-filter") as RailFilter;
      syncReviewRail();
      return;
    }

    const action = target.closest("[data-rail]") as HTMLElement | null;
    if (action) {
      switch (action.getAttribute("data-rail")) {
        case "next": {
          const go = nextOutstanding(state.selectedNodeId || null);
          if (go) { focusNode(go); scrollNodeIntoView(go); }
          return;
        }
        case "tray":   trayOpen = !trayOpen; syncReviewRail(); return;
        case "export": downloadReviewLog(); return;
        case "stop":   endReviewPass(); return;   // notifies, which hides the rail
      }
      return;
    }

    const row = target.closest("[data-rail-box]") as HTMLElement | null;
    if (row) {
      const boxId = row.getAttribute("data-rail-box")!;
      if (nodeById[boxId]) {
        focusNode(boxId);
        scrollNodeIntoView(boxId);
        // On a narrow window the list is a tray over the map, and the thing you
        // asked to look at is underneath it.
        if (trayOpen) { trayOpen = false; syncReviewRail(); }
      }
    }
  });
}
