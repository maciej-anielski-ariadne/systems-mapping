// =============================================================================
// SEARCH — fuzzy-matched, ranked, dropdown navigation across the map
// -----------------------------------------------------------------------------
// Replaces the original "type-and-auto-select-first-substring-match" search
// with a real navigation tool:
//
//   • Fuzzy scoring (exact > prefix > substring > subsequence) so "bff"
//     finds "Border Force FTE" and "brder" still matches "Border" despite
//     the typo.
//   • Searches every text field on a node — name, description, stream,
//     stage, category, id, unit — weighted in that priority order (see
//     SEARCH_FIELD_WEIGHTS), not just the name.
//   • Top-8 ranked dropdown under the search input. Matched chars are
//     highlighted wherever they matched (name, id, the stream·stage·category
//     tag, or a description snippet).
//   • Auto-select while typing — the focused result becomes the live
//     selection (preserving the ancestor/descendant trace UX).
//   • Every match gets a `.search-match` class on its node-group, picked
//     up by 13-search.css to render a soft amber halo on the map.
//
// Reuses selectNode / deselectNode / scrollNodeIntoView from
// 09-graph-selection.js. Render still owns the SVG; we just nudge classes
// after each keystroke.
// =============================================================================

import type { GraphNode, SearchMatch } from "./types";
import { escapeHtml } from "./04-utils";
import { CATEGORIES, NODES, stageById, state, streamById } from "./03-state";
import { deselectNode, scrollNodeIntoView, selectNode } from "./09-graph-selection";
import { dataRevision } from "./06-data-loader";
import {
  captureFilterVisibilitySnapshot,
  type FilterVisibilitySnapshot,
  restoreFilterVisibilitySnapshot,
  revealNodeByRestoringRequiredFilters,
} from "./10-filters";
import { showUndoToast } from "./16g-canvas-undo";

export const SEARCH_MAX_RESULTS = 8;
// Every text-bearing field on a node is searchable. Weights set the priority
// when a node matches in more than one field (and, via the weighted score,
// the cross-node ranking): a node's score is the best (matchQuality × weight)
// across its fields. Priority order, high → low:
//   name (label) › description › stream › stage › category › id › unit
// stream/stage/category are stored as ids but matched on their display labels
// (e.g. "Border Force", "Resource") — see nodeSearchFields().
export const SEARCH_FIELD_WEIGHTS: Record<string, number> = {
  label:       1.0,
  description: 0.6,
  stream:      0.4,
  stage:       0.3,
  category:    0.25,
  id:          0.2,
  unit:        0.15,
};

// ───── Scorer ─────────────────────────────────────────────────────────────
// Returns { score, positions } where positions are the indices in `target`
// matched by `query`'s characters (used for the dropdown's <mark> highlights).
// score = 0 means no match.
// `targetLower` lets a caller that already holds the lower-cased form (the
// pre-built search corpus below) skip re-lowercasing the field on every
// keystroke. Omit it and the function behaves exactly as before.
export function scoreMatch(query: string, target: string, targetLower?: string): { score: number; positions: number[] } {
  if (!query || !target) return { score: 0, positions: [] };
  const q = query.toLowerCase();
  const t = targetLower !== undefined ? targetLower : target.toLowerCase();

  if (t === q) {
    return { score: 1000, positions: range(t.length) };
  }
  if (t.startsWith(q)) {
    return { score: 500, positions: range(q.length) };
  }
  const subIdx = t.indexOf(q);
  if (subIdx >= 0) {
    return {
      score: 300 - Math.min(subIdx, 50),
      positions: range(q.length, subIdx),
    };
  }

  // Subsequence (fuzzy) — every char of q must appear in t in order.
  // Reward consecutive runs and word-boundary starts.
  const positions: number[] = [];
  let ti = 0;
  let raw = 0;
  let lastMatch = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    let found = false;
    while (ti < t.length) {
      if (t[ti] === c) {
        raw += 1;
        if (ti === lastMatch + 1) raw += 3;
        if (ti === 0 || /[\s_\-./]/.test(t[ti - 1])) raw += 5;
        positions.push(ti);
        lastMatch = ti;
        ti++;
        found = true;
        break;
      }
      ti++;
    }
    if (!found) return { score: 0, positions: [] };
  }
  return { score: raw, positions };
}

export function range(n: number, offset = 0): number[] {
  const out: number[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = i + offset;
  return out;
}

// ───── Searchable text per node ────────────────────────────────────────────
// Returns the list of { field, text } pairs a query is scored against. stream /
// stage / category are resolved from their ids to the human-readable display
// labels the user sees on the map (the raw ids are not searched). Returned in
// SEARCH_FIELD_WEIGHTS priority order; renderSearchDropdown relies on these
// same resolved labels so matched-character highlights line up.
export function nodeSearchFields(node: GraphNode): { field: string; text: string }[] {
  const streamLabel   = streamById[node.stream] ? streamById[node.stream].label : "";
  const stageLabel    = stageById[node.stage]   ? stageById[node.stage].label   : "";
  const categoryLabel = (typeof CATEGORIES !== "undefined" && CATEGORIES[node.category])
    ? CATEGORIES[node.category].label : "";
  return [
    { field: "label",       text: node.label       || "" },
    { field: "description", text: node.description || "" },
    { field: "stream",      text: streamLabel },
    { field: "stage",       text: stageLabel },
    { field: "category",    text: categoryLabel },
    { field: "id",          text: node.id          || "" },
    { field: "unit",        text: node.unit        || "" },
  ];
}

// ───── Search corpus ──────────────────────────────────────────────────────
// The searchable text of every node, resolved and lower-cased ONCE. Rebuilding
// it per keystroke (nodeSearchFields allocates 7 objects per node, and
// scoreMatch lower-cased each field again) meant every character typed
// allocated tens of thousands of short-lived strings on a large map. The corpus
// is keyed on the NODES array identity plus the data revision (06-data-loader),
// which every edit path bumps through rebuildIndexes — so a rename or a stream
// re-label invalidates it, and plain typing never does.
interface CorpusField { field: string; text: string; lower: string; weight: number }
let _corpus: CorpusField[][] | null = null;
let _corpusNodes: typeof NODES | null = null;
let _corpusRevision = -1;

function searchCorpus(): CorpusField[][] {
  if (_corpus && _corpusNodes === NODES && _corpusRevision === dataRevision()) return _corpus;
  const corpus: CorpusField[][] = new Array(NODES.length);
  for (let i = 0; i < NODES.length; i++) {
    const fields: CorpusField[] = [];
    for (const f of nodeSearchFields(NODES[i])) {
      if (!f.text) continue;
      fields.push({
        field: f.field,
        text: f.text,
        lower: f.text.toLowerCase(),
        weight: SEARCH_FIELD_WEIGHTS[f.field] || 0,
      });
    }
    corpus[i] = fields;
  }
  _corpus = corpus;
  _corpusNodes = NODES;
  _corpusRevision = dataRevision();
  return corpus;
}

// ───── Find matches ───────────────────────────────────────────────────────
// Scores every node against `query` across all searchable fields, keeps the
// best-weighted field per node, and returns the top SEARCH_MAX_RESULTS by
// score desc.
//
// Only the top SEARCH_MAX_RESULTS are kept, so the results are collected into a
// small insertion-sorted array instead of pushing every match and sorting the
// lot: on a map where thousands of nodes match a one-character query, the sort
// was the dominant cost and 99.8% of its work was thrown away.
export function findMatches(query: string): SearchMatch[] {
  if (!query) return [];
  const corpus = searchCorpus();
  const q = query.toLowerCase();
  const results: SearchMatch[] = [];
  let cutoff = 0;   // score of the weakest kept result once the list is full
  for (let i = 0; i < NODES.length; i++) {
    const fields = corpus[i];
    if (!fields) continue;
    let best = 0;
    let bestField: string | null = null;
    let bestPositions: number[] = [];
    for (const f of fields) {
      // The weighted score can't beat the cutoff if a PERFECT match on this
      // field wouldn't — skip scoring it at all.
      if (f.weight === 0) continue;
      const s = scoreMatch(q, f.text, f.lower);
      const weighted = s.score * f.weight;
      if (weighted > best) {
        best = weighted;
        bestField = f.field;
        bestPositions = s.positions;
      }
    }
    if (best <= 0) continue;
    if (results.length === SEARCH_MAX_RESULTS && best <= cutoff) continue;
    const match: SearchMatch = { node: NODES[i], score: best, bestField: bestField as string | undefined, bestPositions };
    // Insert into the (short, descending) keep-list.
    let at = results.length;
    while (at > 0 && results[at - 1].score < best) at--;
    results.splice(at, 0, match);
    if (results.length > SEARCH_MAX_RESULTS) results.pop();
    if (results.length === SEARCH_MAX_RESULTS) cutoff = results[results.length - 1].score;
  }
  return results;
}

// ───── Snippet window around a match ────────────────────────────────────────
// For long fields (descriptions) we show a short window centred on the first
// matched character rather than the whole text, with "…" markers and the match
// positions re-based onto the windowed string.
export function searchSnippet(text: string, positions: number[] | undefined, maxLen: number): { text: string; positions: number[] } {
  if (!text) return { text: "", positions: [] };
  if (text.length <= maxLen) return { text: text, positions: positions || [] };
  const first = (positions && positions.length) ? positions[0] : 0;
  let start = Math.max(0, first - Math.floor(maxLen / 3));
  start = Math.min(start, text.length - maxLen);
  const end = start + maxLen;
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  const shift = (prefix ? 1 : 0) - start;
  const shifted = (positions || [])
    .filter(p => p >= start && p < end)
    .map(p => p + shift);
  return { text: prefix + text.slice(start, end) + suffix, positions: shifted };
}

// ───── Highlight matched characters in a label ────────────────────────────
export function highlightMatched(text: string, positions: number[] | undefined): string {
  if (!text) return "";
  if (!positions || positions.length === 0) return escapeHtml(text);
  const set = new Set(positions);
  let out = "";
  let inMark = false;
  for (let i = 0; i < text.length; i++) {
    const isMatch = set.has(i);
    if (isMatch && !inMark)      { out += "<mark>"; inMark = true; }
    else if (!isMatch && inMark) { out += "</mark>"; inMark = false; }
    out += escapeHtml(text[i]);
  }
  if (inMark) out += "</mark>";
  return out;
}

// ───── Dropdown rendering ─────────────────────────────────────────────────
export function renderSearchDropdown(): void {
  const dropdown = document.getElementById("search-results");
  if (!dropdown) return;

  if (!state.searchQuery) {
    dropdown.hidden = true;
    dropdown.innerHTML = "";
    return;
  }

  if (state.searchMatches.length === 0) {
    dropdown.innerHTML = '<div class="search-result-empty">No matches</div>';
    dropdown.hidden = false;
    return;
  }

  let html = "";
  state.searchMatches.forEach((match: SearchMatch, idx: number) => {
    const node = match.node;
    const focused = idx === state.searchFocusIndex ? " focused" : "";

    // Resolve the display labels (same values nodeSearchFields() matched on),
    // so the matched-character highlight lines up with what's shown.
    const streamLabel   = streamById[node.stream] ? streamById[node.stream].label : (node.stream || "");
    const stageLabel    = stageById[node.stage]   ? stageById[node.stage].label   : (node.stage || "");
    const categoryLabel = (typeof CATEGORIES !== "undefined" && CATEGORIES[node.category])
      ? CATEGORIES[node.category].label : (node.category || "");

    // Highlight a field only when it's the one that matched.
    const seg = (field: string, text: string) => match.bestField === field
      ? highlightMatched(text || "", match.bestPositions)
      : escapeHtml(text || "");

    // When the match is on the description, show a short windowed snippet so
    // it's clear *why* this node surfaced (its name/id/tags won't contain the
    // query).
    let descHtml = "";
    if (match.bestField === "description") {
      const snip = searchSnippet(node.description || "", match.bestPositions, 90);
      descHtml = '<div class="search-result-desc">' + highlightMatched(snip.text, snip.positions) + '</div>';
    }

    html += '<div class="search-result' + focused + '" data-index="' + idx + '" data-node-id="' + escapeHtml(node.id) + '">';
    html +=   '<div class="search-result-main">';
    html +=     '<div class="search-result-label">' + seg("label", node.label || node.id) + '</div>';
    html +=     '<div class="search-result-id">' + seg("id", node.id) + '</div>';
    html +=     descHtml;
    html +=   '</div>';
    html +=   '<div class="search-result-meta">' + seg("stream", streamLabel) + ' · ' + seg("stage", stageLabel) + ' · ' + seg("category", categoryLabel) + '</div>';
    html += '</div>';
  });
  dropdown.innerHTML = html;
  dropdown.hidden = false;

  dropdown.querySelectorAll(".search-result").forEach(el => {
    el.addEventListener("mouseenter", () => {
      const idx = parseInt(el.getAttribute("data-index")!, 10);
      // Hover moves the preview/focus only. A dropdown can appear underneath a
      // stationary pointer while the user types; treating that incidental
      // mouseenter as a committed choice would unexpectedly dismantle filters.
      // Click, Enter, or an arrow-key choice remains the explicit reveal.
      if (!isNaN(idx)) commitSearchFocus(idx, { typing: true });
    });
    el.addEventListener("mousedown", event => {
      // mousedown (not click) so the input doesn't blur before we react.
      event.preventDefault();
      const idx = parseInt(el.getAttribute("data-index")!, 10);
      if (!isNaN(idx)) {
        commitSearchFocus(idx);
        hideSearchDropdown();
      }
    });
  });
}

export function hideSearchDropdown(): void {
  const dropdown = document.getElementById("search-results");
  if (dropdown) dropdown.hidden = true;
}

// Public helper — clears the query, dropdown, and map highlights.
export function clearSearch(): void {
  state.searchQuery = "";
  state.searchMatches = [];
  state.searchFocusIndex = 0;
  const input = document.getElementById("search-input") as HTMLInputElement | null;
  if (input) input.value = "";
  hideSearchDropdown();
  applySearchMatchClasses();
}

// ───── Map halo for non-focused matches ───────────────────────────────────
// render() already adds .search-match to the focused/other matches via
// state.searchMatches (see 11-rendering.js). This helper is for incremental
// updates that don't go through render() — e.g. when the user is typing
// and we want immediate visual feedback before selectNode triggers render.
// Only the nodes that ENTERED or LEFT the match set are touched: the previous
// set is remembered, so a keystroke that changes one match doesn't walk (and
// write to) every drawn box. A full render resets the memo, since the fresh
// markup already carries the right classes.
let _appliedMatchIds: Set<string> = new Set();

// Successive arrow/click choices can reveal more than one result while the
// search Undo toast is active. Keep the first snapshot so one Undo restores
// the complete filter state from before search navigation began, rather than
// restoring only the last incremental reveal.
let searchFilterRevealSnapshot: FilterVisibilitySnapshot | null = null;
let searchFilterUndoFunction: (() => void) | null = null;

function revealSearchTargetThroughFilters(targetNode: GraphNode): void {
  const existingSearchUndoIsActive = searchFilterUndoFunction !== null &&
    state.canvasEdit.toast?.undoFn === searchFilterUndoFunction;
  if (!existingSearchUndoIsActive) {
    searchFilterRevealSnapshot = captureFilterVisibilitySnapshot();
  }

  const filtersChanged = revealNodeByRestoringRequiredFilters(targetNode);
  if (!filtersChanged) {
    if (!existingSearchUndoIsActive) searchFilterRevealSnapshot = null;
    return;
  }

  const snapshotToRestore = searchFilterRevealSnapshot!;
  searchFilterUndoFunction = () => {
    restoreFilterVisibilitySnapshot(snapshotToRestore);
    searchFilterRevealSnapshot = null;
    searchFilterUndoFunction = null;
  };
  showUndoToast("Filters changed to show " + targetNode.label, searchFilterUndoFunction);
}

export function resetSearchMatchClassMemo(): void {
  _appliedMatchIds = new Set(state.searchMatches.map((m: SearchMatch) => m.node.id));
}

export function applySearchMatchClasses(): void {
  const ids = new Set(state.searchMatches.map((m: SearchMatch) => m.node.id));
  let unchanged = ids.size === _appliedMatchIds.size;
  if (unchanged) for (const id of ids) if (!_appliedMatchIds.has(id)) { unchanged = false; break; }
  if (unchanged) return;

  const changed = new Set<string>();
  for (const id of ids) if (!_appliedMatchIds.has(id)) changed.add(id);
  for (const id of _appliedMatchIds) if (!ids.has(id)) changed.add(id);
  for (const id of changed) {
    const group = document.querySelector('#viz-svg .node-group[data-node-id="' + cssEscapeForSearch(id) + '"]');
    if (group) group.classList.toggle("search-match", ids.has(id));
  }
  _appliedMatchIds = ids;
}

// Minimal CSS.escape shim (older Safari / some test environments lack it).
function cssEscapeForSearch(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, ch => "\\" + ch);
}

// ───── Commit focus → auto-select + scroll ────────────────────────────────
export function commitSearchFocus(index: number, options?: { typing?: boolean }): void {
  if (!state.searchMatches.length) return;
  const clamped = Math.max(0, Math.min(index, state.searchMatches.length - 1));
  state.searchFocusIndex = clamped;
  const targetNode = state.searchMatches[clamped].node;
  const targetId = targetNode.id;
  // Typeahead focus remains non-destructive. Only a discrete navigation action
  // (arrow, click, hover, or Enter) restores filters to put the chosen result
  // back on the map.
  if (!options?.typing) revealSearchTargetThroughFilters(targetNode);
  // selectNode repaints the selection (a class/attribute patch on the drawn
  // slice — 11-rendering's renderSelectionChange) and the detail panel.
  // scrollNodeIntoView brings the node on screen.
  if (state.selectedNodeId !== targetId) {
    selectNode(targetId);
    resetSearchMatchClassMemo();
  }
  // While the user is still typing, jump instead of animating: a smooth scroll
  // started on the previous keystroke is still running when the next one
  // arrives, so the map chases a stale target and never settles. A discrete
  // pick (arrow keys / clicking a result) keeps the smooth glide.
  scrollNodeIntoView(targetId, options && options.typing ? "auto" : "smooth");
  // Update the dropdown's .focused class without rebuilding all rows.
  const dropdown = document.getElementById("search-results");
  if (dropdown) {
    dropdown.querySelectorAll(".search-result").forEach((el, idx) => {
      el.classList.toggle("focused", idx === clamped);
    });
  }
}

// ───── Input + keyboard handlers ──────────────────────────────────────────
export function handleSearchInput(): void {
  if (!state.dataLoaded) {
    state.searchQuery = "";
    state.searchMatches = [];
    hideSearchDropdown();
    return;
  }
  const input = document.getElementById("search-input") as HTMLInputElement | null;
  const query = (input && input.value || "").trim();
  state.searchQuery = query;

  if (!query) {
    state.searchMatches = [];
    state.searchFocusIndex = 0;
    hideSearchDropdown();
    applySearchMatchClasses();
    if (state.selectedNodeId) deselectNode();
    return;
  }

  state.searchMatches = findMatches(query);
  state.searchFocusIndex = 0;
  renderSearchDropdown();

  if (state.searchMatches.length > 0) {
    commitSearchFocus(0, { typing: true });
  } else {
    applySearchMatchClasses();
    // Deliberate UX choice: an in-progress query that doesn't *yet* match
    // anything (mid-typing) shouldn't deselect the user's current node and
    // collapse the ancestor/descendant trace — that would flicker the map
    // every time the user crosses a "no-match" intermediate query while
    // typing or backspacing. The user can press Escape to clear everything.
  }
}

export function handleSearchKeydown(event: KeyboardEvent): void {
  // These keys act on the current match list, so make sure a debounced search
  // from the last keystrokes has actually run.
  if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter") {
    flushPendingSearchInput();
  }
  if (event.key === "ArrowDown") {
    if (state.searchMatches.length === 0) return;
    event.preventDefault();
    commitSearchFocus(state.searchFocusIndex + 1);
  } else if (event.key === "ArrowUp") {
    if (state.searchMatches.length === 0) return;
    event.preventDefault();
    commitSearchFocus(state.searchFocusIndex - 1);
  } else if (event.key === "Enter") {
    event.preventDefault();
    if (state.searchMatches.length > 0) commitSearchFocus(state.searchFocusIndex);
    hideSearchDropdown();
    const input = document.getElementById("search-input") as HTMLInputElement | null;
    if (input) input.blur();
  } else if (event.key === "Escape") {
    event.preventDefault();
    if (_searchInputTimer !== null) { clearTimeout(_searchInputTimer); _searchInputTimer = null; }
    const input = document.getElementById("search-input") as HTMLInputElement | null;
    if (input) input.value = "";
    state.searchQuery = "";
    state.searchMatches = [];
    state.searchFocusIndex = 0;
    hideSearchDropdown();
    applySearchMatchClasses();
    if (state.selectedNodeId) deselectNode();
  }
}

// Typing is far faster than a search is worth running: every character
// re-scores the whole map, rebuilds the dropdown, moves the selection and
// scrolls the canvas. Coalesce a burst of keystrokes into one search shortly
// after the user pauses. The select-as-you-type behaviour this file documents is
// unchanged — it just happens once per pause instead of once per character.
export const SEARCH_INPUT_DEBOUNCE_MS = 120;
let _searchInputTimer: ReturnType<typeof setTimeout> | null = null;
let _searchBlurTimer: ReturnType<typeof setTimeout> | null = null;

// Cancel delayed search work without running it. This is intentionally separate
// from flushPendingSearchInput(): a discarded test/lifecycle must not apply an
// old query to the new map.
export function cancelPendingSearchWorkWithoutFlushing(): void {
  if (_searchInputTimer !== null) {
    clearTimeout(_searchInputTimer);
    _searchInputTimer = null;
  }
  if (_searchBlurTimer !== null) {
    clearTimeout(_searchBlurTimer);
    _searchBlurTimer = null;
  }
  searchFilterRevealSnapshot = null;
  searchFilterUndoFunction = null;
}

export function handleSearchInputDebounced(): void {
  if (_searchInputTimer !== null) clearTimeout(_searchInputTimer);
  _searchInputTimer = setTimeout(() => {
    _searchInputTimer = null;
    handleSearchInput();
  }, SEARCH_INPUT_DEBOUNCE_MS);
}

// Run any pending debounced search NOW — for the keys that act on the current
// results (Enter / arrows) so they never operate on a stale match list.
export function flushPendingSearchInput(): void {
  if (_searchInputTimer === null) return;
  clearTimeout(_searchInputTimer);
  _searchInputTimer = null;
  handleSearchInput();
}

// ───── Wire up ────────────────────────────────────────────────────────────
(function attachSearchHandlers() {
  const input = document.getElementById("search-input") as HTMLInputElement | null;
  if (!input) return;
  input.addEventListener("input",   handleSearchInputDebounced);
  input.addEventListener("keydown", handleSearchKeydown as EventListener);

  // Hide dropdown when the input loses focus, but use a tiny delay so a
  // click inside the dropdown can register before we hide it.
  input.addEventListener("blur", () => {
    if (_searchBlurTimer !== null) clearTimeout(_searchBlurTimer);
    _searchBlurTimer = setTimeout(() => {
      _searchBlurTimer = null;
      hideSearchDropdown();
    }, 120);
  });
  // If the user clicks back into the input with a query already entered,
  // restore the dropdown.
  input.addEventListener("focus", () => {
    if (state.searchQuery) renderSearchDropdown();
  });

  // Global "/" shortcut focuses the search input. Skipped when the user
  // is already typing into another input/textarea/select (including the
  // builder's cell editor).
  document.addEventListener("keydown", event => {
    if (event.key !== "/") return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const active = document.activeElement as HTMLElement | null;
    if (active && active.matches && active.matches("input, textarea, select")) return;
    event.preventDefault();
    input.focus();
    input.select();
  });
})();
