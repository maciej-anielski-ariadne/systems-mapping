// =============================================================================
// THE REVIEW SIDEBAR — the queue, docked in the left column
// -----------------------------------------------------------------------------
// Review used to be an overlay across the whole map. Both halves of a review are
// lists of boxes, and the thing you want the instant you read one is that box on
// the map — so every route out of the panel closed it, and the panel had grown a
// floating banner whose only job was to carry ONE issue back to a map the list
// had just been taken off. That banner is gone; this is what replaced it.
//
// THE DIVISION OF LABOUR. Three columns, three jobs:
//
//   LEFT   this sidebar. WHERE YOU ARE. Rows only — nothing here expands, and
//          every row is a destination.
//   MIDDLE the map. WHAT YOU ARE LOOKING AT.
//   RIGHT  the box panel. WHAT YOU ARE DOING. The item's own controls sit at the
//          top of it, above the box itself, which stays fully editable.
//
// That rule is not new. The pass rail this file replaces already followed it,
// and said why: the question and the buttons stay in the box panel, where they
// already live and where the box's real numbers are — a second place to answer
// would be a second thing to keep correct. All that has changed is that the rule
// now covers every kind of review item rather than only the coverage pass.
//
// WHAT IT DOES NOT DO. It does not switch modes. Opening an issue used to call
// setUiMode("edit") whether or not you intended to change anything, because the
// overlay was closing and edit was the only place a fix could happen. Nothing
// closes now, so nothing has to be assumed.
//
// SIMULATION. The left column in simulation mode IS the sliders — they are the
// point of the mode and you work them against the map. So the sidebar stands
// down while simulating and comes back when it ends, which is the same rule the
// rail followed.
//
// NARROW WINDOWS. Below 1100px, 300 + map + 340 stops being a sensible split, so
// the same markup re-lays-out as a dock along the bottom with the list in a
// tray. Same rows, same state, same handlers — a media query rather than a
// second component.
// =============================================================================

import { NODES, state, nodeById } from "./03-state";
import { escapeHtml } from "./04-utils";
import { upgradeSelectionOnlySelectsIn } from "./04b-typeable-dropdown";
import { EVIDENCE_STATUSES, evidenceStatusLabel, normaliseEvidenceStatus } from "./07c-evidence";
import { focusNode, scrollNodeIntoView, onSelectionChanged } from "./09-graph-selection";
import { downloadTextBlob } from "./19-export";
import { solverGeneration } from "./07-simulation-engine";
import { currentSweep, invalidateSweep, sweepIsPossible } from "./22-review";
import type { Sweep, SweepRow } from "./22-review";
import {
  KIND_CHIP, KIND_LABEL, REVIEW_FILTERS, markFor, requestSweep, reviewCounts,
  reviewQueue, sweepIsAwaitingRequest, coverageShare, reviewEvidenceItems,
  evidenceGapReason, evidenceItemById,
} from "./22c-review-queue";
import type { ReviewFilter, ReviewItem, ReviewItemKind } from "./22c-review-queue";
import {
  endReviewPass, onReviewRecordChanged, reviewReportCsv, reviewReportFilename,
  reviewerNamed, startReviewPass, commentOn, reviewLog,
} from "./24-review-record";

// ═════════════════════════════════════════════════════════════════════════════
// STATE
// ═════════════════════════════════════════════════════════════════════════════

let sidebarOpen = false;
let filter: ReviewFilter = "all";
let trayOpen = false;
let listenersWired = false;
let currentItemId: string | null = null;

// THE QUEUE, AND THE RECORD BEHIND IT.
//
// Three of the five kinds have more to say than the queue carries, and all
// three are things somebody genuinely comes looking for:
//
//   evidence   the queue holds the GAPS; the whole inventory is what is backed
//              up by what, for every link and formula on the map.
//   input      the queue holds the ODD ones; the whole sweep is every adjustable
//              box ranked by how far a nudge on it carries.
//   flag       the queue holds what is still OPEN; the whole log is who said
//              what about which box, agreements included — an audit trail is
//              not only its exceptions.
//
// So each of those chips carries a picker, and the first option is always the
// queue. One pattern, three places, rather than three folds nobody finds.
let recordChoice: Record<string, string> = { evidence: "gaps", input: "odd", flag: "open" };

// The inventory is not the queue: on a big map it is several hundred rows of
// records somebody has already judged. Shown a batch at a time, because a list
// that long costs more to build than anybody reads.
const INVENTORY_BATCH = 100;
let inventoryVisibleLimit = INVENTORY_BATCH;

/** The item cache for one render, so a row and the box panel cannot disagree. */
let lastQueue: ReviewItem[] = [];

/** What the last painted markup was a picture of. See syncReviewSidebar. */
let lastPaintedSignature = "";

function sidebarEl(): HTMLElement | null {
  return document.getElementById("review-sidebar");
}

// ═════════════════════════════════════════════════════════════════════════════
// OPEN, CLOSE, AND WHICH ITEM IS CURRENT
// ═════════════════════════════════════════════════════════════════════════════

export function reviewSidebarIsOpen(): boolean {
  return sidebarOpen;
}

export function openReviewSidebar(): void {
  sidebarOpen = true;
  syncReviewSidebar();
}

export function closeReviewSidebar(): void {
  sidebarOpen = false;
  // The current item is the sidebar's, not the map's. Leaving it set would keep
  // an item block at the top of the box panel with no list behind it — which is
  // exactly the floating banner this replaced.
  currentItemId = null;
  trayOpen = false;
  syncReviewSidebar();
}

export function toggleReviewSidebar(): void {
  if (sidebarOpen) closeReviewSidebar();
  else openReviewSidebar();
}

/** The item whose controls the box panel is showing, if any. */
export function currentReviewItem(): ReviewItem | undefined {
  if (!sidebarOpen || !currentItemId) return undefined;
  const queue = lastQueue.length ? lastQueue : buildQueue();
  return queue.find(item => item.id === currentItemId);
}

/**
 * The queue, with the item somebody is standing on kept in it even once it has
 * been answered out of existence. Every path that rebuilds the list goes through
 * here, so a row can never disappear from under the cursor.
 */
function buildQueue(): ReviewItem[] {
  const standingOn = currentItemId
    ? lastQueue.find(item => item.id === currentItemId)
    : undefined;
  return reviewQueue(solverGeneration(), standingOn);
}

/** True while an item is current — the right panel must be open for it even if
 *  the item names no box. */
export function reviewItemIsCurrent(): boolean {
  return sidebarOpen && !!currentItemId;
}

/**
 * Make an item current: take the map to it, and let the box panel show what it
 * asks. Deliberately does NOT change mode — see the header.
 */
export function selectReviewItem(itemId: string): void {
  const queue = buildQueue();
  let item = queue.find(candidate => candidate.id === itemId);
  // A row from the browsable inventory is not in the queue — the queue holds
  // the gaps. It is still a row somebody clicked, so it opens like any other and
  // is carried alongside the queue until they move on.
  if (!item) {
    item = evidenceItemById(itemId);
    if (item) queue.push(item);
  }
  lastQueue = queue;
  if (!item) return;
  currentItemId = itemId;

  // A link's evidence is authored from the box the link starts at, so opening
  // that box's outgoing list is what puts the reader in front of the fields the
  // item is asking about.
  if (item.edgeId) state.canvasEdit.openEdgeId = item.edgeId;

  if (item.boxId && nodeById[item.boxId]) {
    focusNode(item.boxId);
    scrollNodeIntoView(item.boxId);
  } else {
    // A map-level finding names no box. Repaint anyway so the panel picks it up.
    syncReviewSidebar();
  }
  // On a narrow window the list is a tray over the map, and the thing you asked
  // to look at is underneath it.
  if (trayOpen) { trayOpen = false; syncReviewSidebar(); }
}

/**
 * Forget which item was current, and everything cached about the queue it came
 * from. Called when a different map is opened: the item somebody was standing on
 * is about boxes and links that may not exist in the file just loaded, and a
 * retained one would otherwise survive the load looking answered.
 */
export function resetReviewSidebar(): void {
  currentItemId = null;
  lastQueue = [];
  filter = "all";
  recordChoice = { evidence: "gaps", input: "odd", flag: "open" };
  inventoryVisibleLimit = INVENTORY_BATCH;
  lastPaintedSignature = "";
}

/** Put the box panel back to being only the box. The list stays where it is. */
export function clearReviewItem(): void {
  currentItemId = null;
  syncReviewSidebar();
}

/** Step to the next item still wanting an answer, wrapping at the end. */
export function goToNextReviewItem(): void {
  // Deliberately NOT buildQueue: stepping on is the moment a settled item stops
  // being worth a row, and keeping it would make Next land back on itself.
  const queue = reviewQueue(solverGeneration());
  lastQueue = queue;
  const open = queue.filter(item => !item.settled && passesFilter(item));
  if (!open.length) return;
  const at = currentItemId ? open.findIndex(item => item.id === currentItemId) : -1;
  const next = open[(at + 1) % open.length];
  selectReviewItem(next.id);
}

/** Used by the guided lessons to put the list on one kind. */
export function setReviewFilter(next: ReviewFilter): void {
  filter = next;
  syncReviewSidebar();
}

/**
 * Used by the guided lessons to open the full record behind the current chip —
 * the ranked sweep, the whole log, the evidence inventory. Ignored when the
 * chip has no record behind it.
 */
export function setReviewRecord(value: string): void {
  if (!recordOptions().some(option => option.value === value)) return;
  recordChoice = { ...recordChoice, [filter]: value };
  syncReviewSidebar();
}

function passesFilter(item: ReviewItem): boolean {
  return filter === "all" || item.kind === filter;
}

// ═════════════════════════════════════════════════════════════════════════════
// RENDER
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Show, hide and repaint the sidebar. Called from the record's notifier (every
 * verdict, and every start or stop of a pass), from the selection funnel, and
 * whenever the findings are rebuilt — so there is no path that leaves it stale.
 */
export function syncReviewSidebar(): void {
  const sidebar = sidebarEl();
  if (!sidebar) return;

  const showing = sidebarOpen && state.dataLoaded && !state.simulationMode;
  // Written only when it actually changes. This runs on every selection change,
  // and an attribute write is a DOM mutation whether or not the value moved —
  // which anything watching the document for structural change has to react to.
  // (The guided tour's thread does, and re-measuring its geometry because a
  // hidden panel was re-hidden is how a thread ends up pointing somewhere new
  // for no reason at all.)
  if (sidebar.hidden !== !showing) sidebar.hidden = !showing;
  document.body.classList.toggle("review-open", showing);
  if (!showing) {
    if (sidebar.innerHTML !== "") sidebar.innerHTML = "";
    lastQueue = [];
    lastPaintedSignature = "";
    document.querySelector<HTMLElement>(".app")?.style.removeProperty("--dock-h");
    return;
  }

  // The rebuild throws away every element in the sidebar, INCLUDING the one the
  // keyboard is standing on. Note what had focus by the attribute that
  // identifies it rather than by the element, and put it back on whatever now
  // plays that part.
  const returnTo = focusedControl(sidebar);

  lastQueue = buildQueue();
  // An item nothing can bring back — one whose box was deleted, say — must not
  // stay current: its block would sit at the top of the box panel asking about
  // something that is not there.
  if (currentItemId && !lastQueue.some(item => item.id === currentItemId)) currentItemId = null;

  // Nothing to do if the markup would come out the same. This is called from
  // three funnels — every verdict, every selection change, every rebuild of the
  // findings — and most of those do not change a single row. Rewriting the list
  // anyway would cost a full rebuild per keystroke AND, because replacing
  // markup is a structural DOM change, would make anything watching the
  // document for one react to a picture that had not moved.
  const signature = paintSignature();
  if (signature === lastPaintedSignature && sidebar.firstChild) return;
  lastPaintedSignature = signature;

  // Replacing the markup throws away where the list was scrolled to, and this
  // repaints on every keystroke in a note field — so picking something forty
  // rows down threw you back to the top on the first character typed.
  const listScrollTop = sidebar.querySelector<HTMLElement>(".review-list")?.scrollTop || 0;

  sidebar.classList.toggle("tray-open", trayOpen);
  sidebar.innerHTML = sidebarHtml(lastQueue);
  const list = sidebar.querySelector<HTMLElement>(".review-list");
  if (list) list.scrollTop = listScrollTop;
  // The evidence status picker is a finite list, so it is a selection-only
  // dropdown like every other short enumeration in the app.
  upgradeSelectionOnlySelectsIn(sidebar);

  if (returnTo) {
    const again = sidebar.querySelector(returnTo) as HTMLElement | null;
    // preventScroll: the scroll this function wants is the current row's, below.
    if (again) again.focus({ preventScroll: true });
  }

  // Keep the row you are standing on in view. `nearest` rather than `center`:
  // stepping down the queue should scroll the list by a row, not jump it.
  sidebar.querySelector(".review-row.is-current")?.scrollIntoView({ block: "nearest" });

  publishDockHeight(sidebar);
}

// Below 1100px this is a bar along the bottom, and the map's own control dock has
// to sit above it. Its height depends on how the foot wraps at that width, which
// no stylesheet can know — so it is measured once per paint and handed to the one
// rule that needs it. Above 1100px the override is dropped rather than left
// behind at a stale value.
function publishDockHeight(sidebar: HTMLElement): void {
  const app = document.querySelector<HTMLElement>(".app");
  if (!app) return;
  const docked = typeof window !== "undefined" && typeof window.matchMedia === "function" &&
                 window.matchMedia("(max-width: 1100px)").matches;
  if (!docked) { app.style.removeProperty("--dock-h"); return; }
  const height = sidebar.getBoundingClientRect().height;
  if (height > 0) app.style.setProperty("--dock-h", Math.round(height) + "px");
}

// Everything the markup is a function of, in one string. Cheap to build — the
// queue has already been computed by the time this runs — and it is the only
// thing standing between "the record changed" and a full rebuild of the list.
function paintSignature(): string {
  const parts: string[] = [
    filter, chosenRecord(), String(inventoryVisibleLimit),
    String(currentItemId), String(state.selectedNodeId), String(state.reviewPass),
    String(reviewerNamed()), String(trayOpen), String(state.reviewer),
  ];
  for (const item of lastQueue) {
    parts.push(item.id + "|" + item.why + "|" + (item.settled ? "1" : "0") +
               "|" + markFor(item) + "|" + (item.boxId ? commentOn(item.boxId) : ""));
  }
  return parts.join("\u0001");
}

function focusedControl(sidebar: HTMLElement): string | null {
  const active = document.activeElement as HTMLElement | null;
  if (!active || !sidebar.contains(active)) return null;
  for (const attribute of ["data-review-action", "data-review-filter", "data-review-item"]) {
    const value = active.getAttribute(attribute);
    if (value !== null) return "[" + attribute + '="' + quoteForSelector(value) + '"]';
  }
  if (active.id) return "#" + active.id;
  return null;
}

// Ids come from a spreadsheet, so they are not guaranteed to be safe inside a
// selector. Within a QUOTED attribute value those are the only two characters
// that need it — and doing it by hand rather than through CSS.escape keeps this
// working in the test environment, where the function cannot be called off the
// object it belongs to.
function quoteForSelector(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

function sidebarHtml(queue: ReviewItem[]): string {
  const counts = reviewCounts(queue);
  const done = coverageShare();
  const percentage = (n: number) => (done.total ? (n / done.total) * 100 : 0).toFixed(2) + "%";

  let html = '<div class="review-head">';
  html +=   '<div class="review-headrow">';
  html +=     '<span class="review-eyebrow">Review</span>';
  html +=     '<button type="button" class="review-close" id="review-close" ' +
              'data-review-action="close">Close</button>';
  html +=   '</div>';
  html +=   '<div class="review-progress">' + counts.settled + " of " + counts.total +
            ' <span>settled</span></div>';
  html +=   '<div class="review-bar" role="progressbar" aria-valuenow="' + counts.settled +
            '" aria-valuemin="0" aria-valuemax="' + counts.total + '" ' +
            'aria-label="Review progress">';
  if (done.agreed)  html += '<i class="cov-agreed" style="width:' + percentage(done.agreed) + '"></i>';
  if (done.flagged) html += '<i class="cov-flagged" style="width:' + percentage(done.flagged) + '"></i>';
  if (done.stale)   html += '<i class="cov-stale" style="width:' + percentage(done.stale) + '"></i>';
  html +=   '</div>';
  html += '</div>';

  html += '<div class="review-chips">';
  for (const key of REVIEW_FILTERS) {
    const label = key === "all"
      ? "All " + counts.total
      : KIND_CHIP[key as ReviewItemKind] + " " + counts.openByKind[key as ReviewItemKind];
    // A kind with nothing in it at all is not a filter worth offering.
    if (key !== "all" && counts.totalByKind[key as ReviewItemKind] === 0) continue;
    html += '<button type="button" class="review-chip' + (filter === key ? " on" : "") +
            '" data-review-filter="' + key + '" aria-pressed="' +
            (filter === key ? "true" : "false") + '">' + escapeHtml(label) + '</button>';
  }
  html += '</div>';

  html += recordPickerHtml();
  if (filter === "unchecked") {
    html += scopeNoteHtml(counts.totalByKind.unchecked);
    html += coverageKeyHtml(done, counts.totalByKind.unchecked);
  }
  if (filter === "input") html += sweepHintHtml();

  html += '<div class="review-list" id="review-list">' + listHtml(queue) + '</div>';
  html += footHtml(counts.open);
  return html;
}

/** The options behind the current chip, queue first, or none. */
function recordOptions(): { value: string; label: string }[] {
  if (filter === "evidence") {
    return [
      { value: "gaps", label: "Gaps only" },
      { value: "all", label: "All statuses" },
      ...EVIDENCE_STATUSES.map(status => ({
        value: status, label: evidenceStatusLabel(status),
      })),
    ];
  }
  if (filter === "input") {
    return [
      { value: "odd", label: "Odd ones only" },
      { value: "reach", label: "Every adjustable box, by reach" },
    ];
  }
  if (filter === "flag") {
    return [
      { value: "open", label: "Still open" },
      { value: "all", label: "The whole log" },
    ];
  }
  return [];
}

function chosenRecord(): string {
  return recordChoice[filter] || recordOptions()[0]?.value || "";
}

function recordPickerHtml(): string {
  const options = recordOptions();
  if (!options.length) return "";
  const chosen = chosenRecord();
  // The id is unchanged from when this was the evidence-only picker: it is what
  // the guided lesson on evidence points its thread at.
  let html = '<label class="review-evidence-filter"><span>Show</span>' +
             '<select class="review-evidence-select" id="review-evidence-filter" ' +
             'aria-label="' + (filter === "evidence" ? "Show evidence status" : "Show") + '">';
  for (const option of options) {
    html += '<option value="' + escapeHtml(option.value) + '"' +
            (chosen === option.value ? " selected" : "") + '>' +
            escapeHtml(option.label) + '</option>';
  }
  return html + '</select></label>';
}

// The key under the coverage bar. Four states, and the bar alone cannot say
// which colour is which — nor that "not looked at" is the one with no mark.
function coverageKeyHtml(
  done: { agreed: number; flagged: number; stale: number; total: number },
  inQueue: number,
): string {
  const notLookedAt = Math.max(0, inQueue - done.agreed - done.flagged - done.stale);
  let html = '<div class="review-cov-key">';
  html += '<span><i class="cov-agreed"></i>' + done.agreed + ' agreed</span>';
  html += '<span><i class="cov-flagged"></i>' + done.flagged + ' flagged</span>';
  if (done.stale) html += '<span><i class="cov-stale"></i>' + done.stale + ' changed since</span>';
  html += '<span><i class="cov-none"></i>' + notLookedAt + ' not looked at</span>';
  return html + '</div>';
}

// What the sweep actually did, in one sentence. Without it the numbers below
// are a ranking of nothing in particular.
function sweepHintHtml(): string {
  if (!sweepIsPossible() || sweepIsAwaitingRequest(solverGeneration())) return "";
  const sweep = currentSweep();
  return '<div class="review-hint">Each adjustable box nudged up ' +
    Math.round(sweep.step * 100) + '% on its own, every other slider at 100%, measured against ' +
    'where the map sits when nothing has been asked of it. Everything here computes correctly ' +
    'and would pass every other check — it is only not what was intended.</div>';
}

// Why the pass counts fewer boxes than the map has. A box with nothing feeding
// it has nothing to judge — there is no "is this everything that drives this?"
// to answer — so it is outside the denominator, and a denominator nobody can
// account for is one people stop trusting.
function scopeNoteHtml(inQueue: number): string {
  const boxCount = NODES.length;
  const sourceBoxCount = Math.max(0, boxCount - inQueue);
  if (!boxCount) return '<div class="review-scope-note">There are no boxes on this map.</div>';
  const explanation = sourceBoxCount
    ? sourceBoxCount + " source box" + (sourceBoxCount === 1 ? " has" : "es have") +
      " no incoming links, so there is nothing feeding " +
      (sourceBoxCount === 1 ? "it" : "them") + " to judge. " +
      (sourceBoxCount === 1 ? "It is" : "They are") + " excluded from the pass."
    : "Every box has at least one incoming link, so every box is included.";
  return '<div class="review-scope-note"><b>Why ' + inQueue + " of " + boxCount + '?</b> ' +
         escapeHtml(explanation) + '</div>';
}

function listHtml(queue: ReviewItem[]): string {
  // A record asked for by the picker is not the queue — it is everything of
  // that kind on the map, and each one gets its own rows.
  const record = chosenRecord();
  if (filter === "evidence" && record !== "gaps") return inventoryHtml();
  if (filter === "input" && record === "reach") return sweepReachHtml();
  if (filter === "flag" && record === "all") return wholeLogHtml();

  const shown = queue.filter(passesFilter);
  const waiting = sweepIsAwaitingRequest(solverGeneration());
  if (!shown.length && !(waiting && (filter === "all" || filter === "input"))) {
    return '<div class="review-empty">' + escapeHtml(emptyMessage()) + '</div>';
  }

  let html = "";
  let lastKind: ReviewItemKind | null = null;
  for (const item of shown) {
    if (item.kind !== lastKind) {
      lastKind = item.kind;
      const inKind = shown.filter(other => other.kind === item.kind);
      const openInKind = inKind.filter(other => !other.settled).length;
      html += '<div class="review-group"><span>' + escapeHtml(KIND_LABEL[item.kind]) +
              '</span><span class="review-group-count">' +
              (item.kind === "unchecked"
                ? (inKind.length - openInKind) + " of " + inKind.length
                : String(openInKind)) +
              '</span></div>';
    }
    html += rowHtml(item);
  }

  if (waiting && (filter === "all" || filter === "input")) {
    html += '<div class="review-group"><span>' + escapeHtml(KIND_LABEL.input) + '</span></div>';
    html += runTheSweepHtml();
  }
  return html;
}

function emptyMessage(): string {
  if (filter === "issue")     return "Every check passed. Every rule parses, every name resolves, and every box opens on the starting value it declares.";
  if (filter === "flag")      return "Nothing outstanding. Nobody has left a concern waiting for an answer.";
  if (filter === "unchecked") return "Nothing to check. A pass asks, box by box, whether the links feeding it are right — and no box on this map has anything feeding it.";
  if (filter === "evidence")  return "No gaps. Every link and formula has something recorded, and nothing is old enough to be worth looking at again.";
  if (filter === "input")     return "Nothing odd. Every adjustable box moves something, no box is out of reach, and no single input dominates the map.";
  return "Nothing to review. The map loaded cleanly, nobody has flagged anything, and there is nothing left to check.";
}

function rowHtml(item: ReviewItem): string {
  const current = item.id === currentItemId;
  // A box picked on the map marks its row too, so the queue answers "where am I"
  // however you got there — not only when you arrived through the list.
  const onSelectedBox = !!item.boxId && item.boxId === state.selectedNodeId;
  const comment = item.boxId ? commentOn(item.boxId) : "";
  let html = '<button type="button" class="review-row' +
             (current ? " is-current" : "") +
             (onSelectedBox && !current ? " is-on-map" : "") +
             (item.settled ? " is-settled" : "") +
             (item.coverageState ? " rv-" + item.coverageState : "") +
             '" data-review-item="' + escapeHtml(item.id) + '"' +
             (current ? ' aria-current="true"' : "") +
             ' aria-label="' + escapeHtml(item.spoken) + '"' +
             (comment ? ' data-tooltip="' + escapeHtml(comment) + '"' : "") + '>';
  html +=   '<span class="review-row-mark" aria-hidden="true">' +
            (item.severity
              ? '<span class="review-sev sev-' + item.severity + '"></span>'
              : escapeHtml(markFor(item))) +
            '</span>';
  html +=   '<span class="review-row-body">';
  html +=     '<span class="review-row-name">' + escapeHtml(item.name) + '</span>';
  if (item.why) html += '<span class="review-row-why">' + escapeHtml(item.why) + '</span>';
  html +=   '</span>';
  if (comment) html += '<span class="review-row-note" aria-hidden="true"></span>';
  html += '</button>';
  return html;
}

function inventoryHtml(): string {
  const chosen = chosenRecord();
  const wanted = normaliseEvidenceStatus(chosen);
  const matching = reviewEvidenceItems().filter(record =>
    chosen === "all" || normaliseEvidenceStatus(record.metadata.status) === wanted);
  if (!matching.length) {
    return '<div class="review-empty">No records with that status. Choose another to see the rest.</div>';
  }
  const items = matching.slice(0, inventoryVisibleLimit);
  let html = '<div class="review-group"><span>Evidence inventory</span>' +
             '<span class="review-group-count">' + matching.length + '</span></div>';
  for (const record of items) {
    const gap = evidenceGapReason(record);
    html += '<button type="button" class="review-row" data-review-item="evidence:' +
            escapeHtml(record.id) + '" data-review-inventory="' + escapeHtml(record.id) + '" ' +
            'aria-label="' + escapeHtml(record.label + " — " + evidenceStatusLabel(record.metadata.status)) + '">';
    html +=   '<span class="review-row-mark" aria-hidden="true">' + (gap ? "○" : "✓") + '</span>';
    html +=   '<span class="review-row-body">';
    html +=     '<span class="review-row-name">' + escapeHtml(record.label) + '</span>';
    html +=     '<span class="review-row-why">' +
                escapeHtml(evidenceStatusLabel(record.metadata.status)) +
                (record.kind === "formula" ? " · formula" : "") + '</span>';
    html +=   '</span></button>';
  }
  if (items.length < matching.length) {
    const remaining = matching.length - items.length;
    html += '<button type="button" class="review-fold-toggle" id="review-evidence-more" ' +
            'data-review-action="more-evidence">Show ' +
            Math.min(INVENTORY_BATCH, remaining) + ' more · ' + remaining + ' remaining</button>';
  }
  return html;
}

// ───── The whole sweep, ranked ────────────────────────────────────────────
// The queue carries the oddities. This is the same sweep with nothing left out,
// ordered by how far each input carries — the bar is what a narrow column is
// actually good at, and the three biggest movers say what it carries TO.
function sweepReachHtml(): string {
  if (!sweepIsPossible()) {
    return '<div class="review-empty">Nothing to sweep. This check nudges each adjustable box ' +
           'in turn and reports what moved, so it needs at least one adjustable box with a ' +
           'starting value, and at least one box that is not itself adjustable.</div>';
  }
  if (sweepIsAwaitingRequest(solverGeneration())) return runTheSweepHtml();

  const sweep = currentSweep();
  let html = '<div class="review-group"><span>Every adjustable box, by reach</span>' +
             '<span class="review-group-count">' + sweep.rows.length + '</span></div>';
  for (const row of sweep.rows) html += sweepRowHtml(row, sweep);
  if (sweep.unreached.length) {
    html += '<div class="review-group"><span>Out of reach</span>' +
            '<span class="review-group-count">' + sweep.unreached.length + '</span></div>';
    html += '<div class="review-empty">No adjustable box moves ' +
            escapeHtml(sweep.unreached.slice(0, 6).map(move => move.label).join(", ")) +
            (sweep.unreached.length > 6 ? " and " + (sweep.unreached.length - 6) + " more" : "") +
            '.</div>';
  }
  return html;
}

function sweepRowHtml(row: SweepRow, sweep: Sweep): string {
  const widest = sweep.rows[0] ? sweep.rows[0].reach : 1;
  const width = Math.max(3, widest ? (row.reach / widest) * 100 : 3);
  const movers = row.moves.slice(0, 3).map(move =>
    '<b>' + escapeHtml(move.label) + '</b> <span class="' + (move.pct > 0 ? "up" : "dn") + '">' +
    (move.pct > 0 ? "+" : "") + move.pct.toFixed(1) + '%</span>').join(" · ");

  let html = '<button type="button" class="review-row review-reach-row' +
             (row.reach === 0 ? " is-dead" : "") + '" data-review-box="' +
             escapeHtml(row.id) + '" ' +
             'aria-label="' + escapeHtml(row.label + " — reaches " + row.reach + " box" +
               (row.reach === 1 ? "" : "es")) + '">';
  html +=   '<span class="review-row-body">';
  html +=     '<span class="review-row-name">' + escapeHtml(row.label) + '</span>';
  html +=     '<span class="review-row-top">' + (row.reach ? movers : "moves nothing") + '</span>';
  html +=   '</span>';
  html +=   '<span class="review-row-bar"><i style="width:' + width.toFixed(1) + '%"></i></span>';
  html +=   '<span class="review-row-count">' + row.reach + '</span>';
  return html + '</button>';
}

function runTheSweepHtml(): string {
  return '<div class="review-empty">This check solves the map once per adjustable box — ' +
         'quick, but not instant at this size, so it waits to be asked.' +
         '<button type="button" class="review-run" data-review-action="sweep">' +
         'Run the check</button></div>';
}

// ───── The whole log ──────────────────────────────────────────────────────
// Who said what about which box, agreements included. The queue carries what is
// still open; an audit trail is not only its exceptions, and a record you can
// only read on the screen it was made on is not much of a record — which is why
// Export the log sits in the foot under this.
function wholeLogHtml(): string {
  const log = reviewLog();
  if (!log.length) {
    return '<div class="review-empty">Nobody has recorded a verdict on this map yet.</div>';
  }
  let html = '<div class="review-group"><span>Every box anyone has judged</span>' +
             '<span class="review-group-count">' + log.length + '</span></div>';
  for (const row of log) {
    // Only an OPEN row is a question. A settled one is a record, so its row is
    // navigation to the box and nothing more — offering to "answer" a verdict
    // somebody already closed would be inventing work.
    const open = row.now === "flagged" || row.now === "stale";
    html += '<button type="button" class="review-row" ' +
            (open ? 'data-review-item="flag:' : 'data-review-box="') +
            escapeHtml(row.entry.boxId) + '" aria-label="' +
            escapeHtml(row.label + " — " + row.now + " by " +
                       (row.entry.reviewer || "someone") + " on " + row.entry.date) + '">';
    html +=   '<span class="review-row-mark rv-' + row.now + '" aria-hidden="true">' +
              (row.now === "agreed" ? "✓" : row.now === "flagged" ? "!" :
               row.now === "stale" ? "~" : "○") + '</span>';
    html +=   '<span class="review-row-body">';
    html +=     '<span class="review-row-name">' + escapeHtml(row.label) + '</span>';
    html +=     '<span class="review-row-why">' +
                escapeHtml((row.entry.reviewer || "unsigned") + " · " + row.entry.date +
                           (row.entry.note ? " · " + row.entry.note : "")) + '</span>';
    html +=   '</span></button>';
  }
  return html;
}

function footHtml(openCount: number): string {
  const running = state.reviewPass;
  const named = reviewerNamed();

  let html = '<div class="review-foot">';

  // The name goes on every verdict, so it is asked for before the pass rather
  // than after — a record of who said what is the point, and "unsigned" is a
  // poor answer to give a month later. A FULL name, not initials: this record
  // outlives the session and travels in the exported log.
  if (!running) {
    html += '<div class="review-who' + (named ? "" : " is-wanted") + '">';
    html +=   '<label for="review-reviewer">Your name</label>';
    html +=   '<input id="review-reviewer" class="review-who-input" type="text" maxlength="60" ' +
              'value="' + escapeHtml(state.reviewer) + '" placeholder="Ann Lee" ' +
              'autocomplete="name" aria-describedby="review-who-why" />';
    html += '</div>';
    if (!named) {
      html += '<div class="review-who-why" id="review-who-why">A full name, not initials — ' +
              'every verdict is signed with it.</div>';
    }
  }

  html += '<button type="button" class="review-next" data-review-action="next"' +
          (openCount ? "" : " disabled") + '>' +
          (openCount ? "Next item — " + openCount + " to go" : "Everything has been settled") +
          '</button>';

  html += '<div class="review-footrow">';
  html +=   '<button type="button" class="review-btn review-tray-toggle" data-review-action="tray" ' +
            'aria-expanded="' + (trayOpen ? "true" : "false") + '">' +
            (trayOpen ? "▾ Hide the list" : "▸ The list") + '</button>';
  html +=   '<button type="button" class="review-btn" data-review-action="export" ' +
            'data-tooltip="A .csv of every box: checked or not, by whom, when, the comments, ' +
            'and whether they have been dealt with.">Export the log</button>';
  html +=   '<button type="button" class="review-btn" data-review-action="' +
            (running ? "stop" : "start") + '"' + (running || named ? "" : " disabled") + ' ' +
            'data-tooltip="' + (running
              ? "Leave the pass. Everything said so far is kept."
              : "Signs your verdicts and turns the box panel into a review card.") + '">' +
            (running ? "Stop the pass" : named ? "Start a pass" : "Name first") + '</button>';
  html += '</div>';

  html += '</div>';
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
// One delegated listener on the sidebar, which is stable; its contents are not.
export function initReviewSidebar(): void {
  // Both notifiers are single funnels: every verdict, and starting or stopping a
  // pass, goes through the record's listeners, and every selection change goes
  // through 11-rendering's. Registered once and guarded here rather than by the
  // element check below — that one is about the DOM, and these listeners outlive
  // any element.
  if (!listenersWired) {
    listenersWired = true;
    onReviewRecordChanged(syncReviewSidebar);
    onSelectionChanged(syncReviewSidebar);
  }

  const sidebar = sidebarEl();
  if (!sidebar || sidebar.dataset.wired) return;
  sidebar.dataset.wired = "1";

  sidebar.addEventListener("click", event => {
    const target = event.target as HTMLElement;

    const chip = target.closest("[data-review-filter]") as HTMLElement | null;
    if (chip) {
      filter = chip.getAttribute("data-review-filter") as ReviewFilter;
      inventoryVisibleLimit = INVENTORY_BATCH;
      syncReviewSidebar();
      return;
    }

    const action = target.closest("[data-review-action]") as HTMLElement | null;
    if (action) {
      switch (action.getAttribute("data-review-action")) {
        case "close": closeReviewSidebar(); return;
        case "next":  goToNextReviewItem();  return;
        case "tray":  trayOpen = !trayOpen; syncReviewSidebar(); return;
        case "export": downloadReviewLog(); return;
        case "more-evidence":
          inventoryVisibleLimit += INVENTORY_BATCH;
          syncReviewSidebar();
          return;
        case "sweep":
          requestSweep(solverGeneration());
          invalidateSweep();
          syncReviewSidebar();
          return;
        case "start": {
          const goTo = startReviewPass();   // notifies, which repaints this
          if (goTo) selectReviewItem("unchecked:" + goTo);
          return;
        }
        case "stop": endReviewPass(); return;   // notifies, which repaints this
      }
      return;
    }

    const row = target.closest("[data-review-item]") as HTMLElement | null;
    if (row) { selectReviewItem(row.getAttribute("data-review-item")!); return; }

    // A row from one of the full records with no question attached to it: the
    // whole sweep ranked by reach, or a verdict somebody has already settled.
    // It still names a box, and going there is the whole of what it offers.
    const navigateOnly = target.closest("[data-review-box]") as HTMLElement | null;
    if (navigateOnly) {
      const boxId = navigateOnly.getAttribute("data-review-box")!;
      if (!nodeById[boxId]) return;
      clearReviewItem();
      focusNode(boxId);
      scrollNodeIntoView(boxId);
      if (trayOpen) { trayOpen = false; syncReviewSidebar(); }
    }
  });

  // The name, kept as you type. NOT re-rendered on input: the field would lose
  // focus after the first character. The one control whose state depends on the
  // text — the Start button beside it — is updated by hand instead.
  sidebar.addEventListener("input", event => {
    const target = event.target as HTMLElement;
    if (target.id !== "review-reviewer") return;
    state.reviewer = (target as HTMLInputElement).value.trim();
    const named = reviewerNamed();
    const start = sidebar.querySelector<HTMLButtonElement>('[data-review-action="start"]');
    if (start) {
      start.disabled = !named;
      start.textContent = named ? "Start a pass" : "Name first";
    }
    sidebar.querySelector(".review-who")?.classList.toggle("is-wanted", !named);
  });

  sidebar.addEventListener("change", event => {
    const target = event.target as HTMLElement;
    if (target.id !== "review-evidence-filter") return;
    recordChoice = { ...recordChoice, [filter]: (target as HTMLSelectElement).value };
    inventoryVisibleLimit = INVENTORY_BATCH;
    syncReviewSidebar();
  });
}
