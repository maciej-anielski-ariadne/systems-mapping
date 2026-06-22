// =============================================================================
// MULTI-SELECT ACTION BAR — batch edit / move / delete for a multi-selection
// -----------------------------------------------------------------------------
// When two or more nodes are selected (via the shift+drag marquee or shift+click
// toggle — see 16e / 09), a small floating bar appears at the bottom-centre of
// the canvas showing "N selected" plus controls to act on the whole group:
//
//   • Category / Stream / Stage dropdowns — reassign that property on every
//     selected node in one undoable mutation.
//   • Delete — remove all selected nodes + their incident edges (delegates to
//     deleteSelection in 16e, same as the Delete key).
//
// The bar is a plain DOM overlay (NOT part of the SVG), lazily appended to
// <body> the first time it's needed (mirrors ensureUndoToastEl in 16g). It's
// re-rendered by renderMultiSelectBar(), which selection changes and
// applyCanvasMutation both call, so its count / dropdowns stay accurate.
// =============================================================================

function ensureMultiSelectBarEl() {
  if (document.getElementById("multi-select-bar")) return;
  const el = document.createElement("div");
  el.id = "multi-select-bar";
  el.className = "multi-select-bar";
  el.style.display = "none";
  document.body.appendChild(el);
}

// Build a labelled <select> whose first option is a non-committal placeholder.
// `data-msb` tags the field so renderMultiSelectBar can wire the change handler.
function multiSelectFieldMarkup(field, placeholder, options) {
  let html = '<select class="msb-select" data-msb="' + field + '">';
  html += '<option value="">' + escapeHtml(placeholder) + '</option>';
  for (const opt of options) {
    html += '<option value="' + escapeHtml(opt.value) + '">' + escapeHtml(opt.label) + '</option>';
  }
  html += '</select>';
  return html;
}

function renderMultiSelectBar() {
  ensureMultiSelectBarEl();
  const el = document.getElementById("multi-select-bar");
  if (!el) return;
  const n = (state.selectedNodeIds && state.selectedNodeIds.size) || 0;
  if (n < 2) {
    el.style.display = "none";
    el.innerHTML = "";
    return;
  }

  // Bulk-set replaces the PRIMARY (fill) category, so only offer primaries.
  const categoryOpts = Object.keys(CATEGORIES)
    .filter(id => (CATEGORIES[id].class || "primary") !== "secondary")
    .map(id => ({ value: id, label: CATEGORIES[id].label || id }));
  const streamOpts   = STREAMS.map(s => ({ value: s.id, label: s.label || s.id }));
  const stageOpts    = STAGES.map(s => ({ value: s.id, label: s.label || s.id }));

  let html = '<span class="msb-count">' + n + ' selected</span>';
  html += multiSelectFieldMarkup("category", "Set category…", categoryOpts);
  html += multiSelectFieldMarkup("stream",   "Move to row…", streamOpts);
  html += multiSelectFieldMarkup("stage",    "Move to column…", stageOpts);
  html += '<button class="msb-delete" type="button">Delete</button>';
  el.innerHTML = html;
  el.style.display = "flex";

  el.querySelector('[data-msb="category"]').addEventListener("change", e => batchSetProperty("category", e.target.value));
  el.querySelector('[data-msb="stream"]').addEventListener("change",   e => batchSetProperty("stream",   e.target.value));
  el.querySelector('[data-msb="stage"]').addEventListener("change",    e => batchSetProperty("stage",    e.target.value));
  el.querySelector('.msb-delete').addEventListener("click", () => {
    if (typeof deleteSelection === "function") deleteSelection();
  });
}

// Apply one property to every selected node. Validates the value the same way
// the detail-panel field writes do (15-detail-panel.js), then funnels the whole
// batch through a single applyCanvasMutation so it's one undo step.
function batchSetProperty(field, value) {
  if (!value) return;
  if (field === "category" && !CATEGORIES[value]) return;
  if (field === "stream"   && !streamById[value]) return;
  if (field === "stage"    && !stageById[value]) return;

  const ids = [...state.selectedNodeIds];
  let changed = 0;
  for (const id of ids) {
    const node = nodeById[id];
    if (!node) continue;
    if (node[field] === value) continue;
    node[field] = value;
    // Setting the primary category bulk-replaces it while keeping each node's
    // existing secondary chips.
    if (field === "category") {
      const secs = (node.categoryIds || []).filter(cid => CATEGORIES[cid] && (CATEGORIES[cid].class || "primary") === "secondary");
      node.primaryCategories = [value];
      node.secondaryCategories = secs;
      node.categoryIds = [value].concat(secs);
    }
    changed++;
  }
  if (!changed) {
    // Nothing actually moved (all already had this value) — just reset the
    // dropdown back to its placeholder via a re-render.
    renderMultiSelectBar();
    return;
  }
  applyCanvasMutation();   // auto-captures the pre-mutation snapshot → one undo step
  showUndoToast(changed === 1 ? "1 box updated" : changed + " boxes updated", () => historyUndo());
}
