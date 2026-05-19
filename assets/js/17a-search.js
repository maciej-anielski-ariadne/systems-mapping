// =============================================================================
// SEARCH — fuzzy-matched, ranked, dropdown navigation across the map
// -----------------------------------------------------------------------------
// Replaces the original "type-and-auto-select-first-substring-match" search
// with a real navigation tool:
//
//   • Fuzzy scoring (exact > prefix > substring > subsequence) so "bff"
//     finds "Border Force FTE" and "brder" still matches "Border" despite
//     the typo.
//   • Top-8 ranked dropdown under the search input. Matched chars are
//     highlighted in the result label.
//   • Auto-select while typing — the focused result becomes the live
//     selection (preserving the ancestor/descendant trace UX).
//   • Every match gets a `.search-match` class on its node-group, picked
//     up by 13-search.css to render a soft amber halo on the map.
//
// Reuses selectNode / deselectNode / scrollNodeIntoView from
// 09-graph-selection.js. Render still owns the SVG; we just nudge classes
// after each keystroke.
// =============================================================================

const SEARCH_MAX_RESULTS = 8;
const SEARCH_FIELD_WEIGHTS = { label: 1.0, id: 0.7, description: 0.3 };

// ───── Scorer ─────────────────────────────────────────────────────────────
// Returns { score, positions } where positions are the indices in `target`
// matched by `query`'s characters (used for the dropdown's <mark> highlights).
// score = 0 means no match.
function scoreMatch(query, target) {
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
  const positions = [];
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

function range(n, offset = 0) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = i + offset;
  return out;
}

// ───── Find matches ───────────────────────────────────────────────────────
// Scores every node against `query` on label / id / description, keeps the
// best field per node, and returns the top SEARCH_MAX_RESULTS by score desc.
function findMatches(query) {
  if (!query) return [];
  const results = [];
  for (const node of NODES) {
    const sLabel = scoreMatch(query, node.label || "");
    const sId    = scoreMatch(query, node.id    || "");
    const sDesc  = scoreMatch(query, node.description || "");

    const wLabel = sLabel.score * SEARCH_FIELD_WEIGHTS.label;
    const wId    = sId.score    * SEARCH_FIELD_WEIGHTS.id;
    const wDesc  = sDesc.score  * SEARCH_FIELD_WEIGHTS.description;

    let best = wLabel;
    let bestField = "label";
    let bestPositions = sLabel.positions;
    if (wId > best)   { best = wId;   bestField = "id";          bestPositions = sId.positions; }
    if (wDesc > best) { best = wDesc; bestField = "description"; bestPositions = sDesc.positions; }
    if (best <= 0) continue;

    results.push({ node, score: best, bestField, bestPositions });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, SEARCH_MAX_RESULTS);
}

// ───── Highlight matched characters in a label ────────────────────────────
function highlightMatched(text, positions) {
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
function renderSearchDropdown() {
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
  state.searchMatches.forEach((match, idx) => {
    const focused = idx === state.searchFocusIndex ? " focused" : "";
    const labelHtml = match.bestField === "label"
      ? highlightMatched(match.node.label || "", match.bestPositions)
      : escapeHtml(match.node.label || match.node.id || "");
    const idHtml = match.bestField === "id"
      ? highlightMatched(match.node.id || "", match.bestPositions)
      : escapeHtml(match.node.id || "");
    const stream   = streamById[match.node.stream] ? streamById[match.node.stream].short : (match.node.stream || "");
    const stage    = match.node.stage || "";
    const category = match.node.category || "";

    html += '<div class="search-result' + focused + '" data-index="' + idx + '" data-node-id="' + escapeHtml(match.node.id) + '">';
    html +=   '<div class="search-result-main">';
    html +=     '<div class="search-result-label">' + labelHtml + '</div>';
    html +=     '<div class="search-result-id">' + idHtml + '</div>';
    html +=   '</div>';
    html +=   '<div class="search-result-meta">' + escapeHtml(stream) + ' · ' + escapeHtml(stage) + ' · ' + escapeHtml(category) + '</div>';
    html += '</div>';
  });
  dropdown.innerHTML = html;
  dropdown.hidden = false;

  dropdown.querySelectorAll(".search-result").forEach(el => {
    el.addEventListener("mouseenter", () => {
      const idx = parseInt(el.getAttribute("data-index"), 10);
      if (!isNaN(idx)) commitSearchFocus(idx);
    });
    el.addEventListener("mousedown", event => {
      // mousedown (not click) so the input doesn't blur before we react.
      event.preventDefault();
      const idx = parseInt(el.getAttribute("data-index"), 10);
      if (!isNaN(idx)) {
        commitSearchFocus(idx);
        hideSearchDropdown();
      }
    });
  });
}

function hideSearchDropdown() {
  const dropdown = document.getElementById("search-results");
  if (dropdown) dropdown.hidden = true;
}

// Public — called by 17-events.js's Reset View button.
function clearSearch() {
  state.searchQuery = "";
  state.searchMatches = [];
  state.searchFocusIndex = 0;
  const input = document.getElementById("search-input");
  if (input) input.value = "";
  hideSearchDropdown();
  applySearchMatchClasses();
}

// ───── Map halo for non-focused matches ───────────────────────────────────
// render() already adds .search-match to the focused/other matches via
// state.searchMatches (see 11-rendering.js). This helper is for incremental
// updates that don't go through render() — e.g. when the user is typing
// and we want immediate visual feedback before selectNode triggers render.
function applySearchMatchClasses() {
  const ids = new Set(state.searchMatches.map(m => m.node.id));
  document.querySelectorAll("#viz-svg .node-group").forEach(group => {
    const id = group.getAttribute("data-node-id");
    group.classList.toggle("search-match", ids.has(id));
  });
}

// ───── Commit focus → auto-select + scroll ────────────────────────────────
function commitSearchFocus(index) {
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
function handleSearchInput() {
  if (!state.dataLoaded) {
    state.searchQuery = "";
    state.searchMatches = [];
    hideSearchDropdown();
    return;
  }
  const input = document.getElementById("search-input");
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

function handleSearchKeydown(event) {
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
    const input = document.getElementById("search-input");
    if (input) input.blur();
  } else if (event.key === "Escape") {
    event.preventDefault();
    const input = document.getElementById("search-input");
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
  const input = document.getElementById("search-input");
  if (!input) return;
  input.addEventListener("input",   handleSearchInput);
  input.addEventListener("keydown", handleSearchKeydown);

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
    const active = document.activeElement;
    if (active && active.matches && active.matches("input, textarea, select")) return;
    event.preventDefault();
    input.focus();
    input.select();
  });
})();
