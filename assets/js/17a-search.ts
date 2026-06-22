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
export function scoreMatch(query: string, target: string): { score: number; positions: number[] } {
  if (!query || !target) return { score: 0, positions: [] };
  const q = query.toLowerCase();
  const t = target.toLowerCase();

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

// ───── Find matches ───────────────────────────────────────────────────────
// Scores every node against `query` across all searchable fields, keeps the
// best-weighted field per node, and returns the top SEARCH_MAX_RESULTS by
// score desc.
export function findMatches(query: string): SearchMatch[] {
  if (!query) return [];
  const results: SearchMatch[] = [];
  for (const node of NODES) {
    let best = 0;
    let bestField: string | null = null;
    let bestPositions: number[] = [];
    for (const f of nodeSearchFields(node)) {
      if (!f.text) continue;
      const s = scoreMatch(query, f.text);
      const weighted = s.score * (SEARCH_FIELD_WEIGHTS[f.field] || 0);
      if (weighted > best) {
        best = weighted;
        bestField = f.field;
        bestPositions = s.positions;
      }
    }
    if (best <= 0) continue;
    results.push({ node, score: best, bestField: bestField as string | undefined, bestPositions });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, SEARCH_MAX_RESULTS);
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
      if (!isNaN(idx)) commitSearchFocus(idx);
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
export function applySearchMatchClasses(): void {
  const ids = new Set(state.searchMatches.map((m: SearchMatch) => m.node.id));
  document.querySelectorAll("#viz-svg .node-group").forEach(group => {
    const id = group.getAttribute("data-node-id");
    group.classList.toggle("search-match", ids.has(id!));
  });
}

// ───── Commit focus → auto-select + scroll ────────────────────────────────
export function commitSearchFocus(index: number): void {
  if (!state.searchMatches.length) return;
  const clamped = Math.max(0, Math.min(index, state.searchMatches.length - 1));
  state.searchFocusIndex = clamped;
  const targetId = state.searchMatches[clamped].node.id;
  // selectNode renders the SVG (which picks up search-match classes) and
  // the detail panel. scrollNodeIntoView brings it on screen.
  if (state.selectedNodeId !== targetId) {
    selectNode(targetId);
  }
  scrollNodeIntoView(targetId);
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
    commitSearchFocus(0);
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
    hideSearchDropdown();
    const input = document.getElementById("search-input") as HTMLInputElement | null;
    if (input) input.blur();
  } else if (event.key === "Escape") {
    event.preventDefault();
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

// ───── Wire up ────────────────────────────────────────────────────────────
(function attachSearchHandlers() {
  const input = document.getElementById("search-input") as HTMLInputElement | null;
  if (!input) return;
  input.addEventListener("input",   handleSearchInput);
  input.addEventListener("keydown", handleSearchKeydown as EventListener);

  // Hide dropdown when the input loses focus, but use a tiny delay so a
  // click inside the dropdown can register before we hide it.
  input.addEventListener("blur", () => {
    setTimeout(hideSearchDropdown, 120);
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
