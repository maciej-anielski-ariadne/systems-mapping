// =============================================================================
// LEFT SIDEBAR RENDERING
// -----------------------------------------------------------------------------
// Builds the HTML for the Stages list (editable), the Stream filter rows
// (editable + filterable), the Category filter rows (filter-only), and —
// when simulation mode is on — delegates to the simulation panel renderer.
//
// Streams and stages support per-row pencil-to-expand editing: the row is
// compact by default; clicking the pencil swaps it for an inline form with
// label / colour / delete controls. Rows are drag-reorderable. State for
// which row (if any) is currently expanded lives in
// state.canvasEdit.editingSidebarItem so it survives a renderSidebar() call.
// Every mutation funnels through applyCanvasMutation() in 16e.
// =============================================================================

function renderSidebar() {
  const sidebarEl = document.getElementById("sidebar");
  if (sidebarEl) {
    sidebarEl.style.visibility = state.dataLoaded ? "visible" : "hidden";
  }
  if (!state.dataLoaded) return;

  // The simulation panel is its own concern — see 14-simulation-panel.js.
  renderSimulationPanel();

  renderStagesList();
  renderStreamsList();
  renderCategoriesList();

  // Newly-rendered rows have data-tooltip; wire them up to the tooltip system.
  if (typeof wireDataTooltips === "function") wireDataTooltips(sidebarEl);

  // NOTE: the "+ Add stream / + Add stage / + Add category" buttons live in
  // index.html (they persist across renders), so they're wired ONCE from
  // 17-events.js at startup. Wiring them here would stack a fresh click
  // listener every render — one click would then add many rows.
}

// ───── Stages ──────────────────────────────────────────────────────────
function renderStagesList() {
  const container = document.getElementById("stages-list");
  const countEl   = document.getElementById("stages-count");
  if (!container) return;
  if (countEl) countEl.textContent = STAGES.length;

  if (STAGES.length === 0) {
    container.innerHTML = '<div class="sidebar-empty">No stages yet. Click "+ Add stage" to create one.</div>';
    return;
  }

  let html = "";
  for (let i = 0; i < STAGES.length; i++) {
    const stage = STAGES[i];
    const isExpanded = isExpandedSidebarItem("stage", stage.id);
    const count = NODES.reduce((acc, n) => n.stage === stage.id ? acc + 1 : acc, 0);
    if (isExpanded) {
      html += '<div class="sidebar-edit-row expanded" data-kind="stage" data-id="' + escapeHtml(stage.id) + '" data-index="' + i + '" draggable="true">';
      html +=   '<div class="sidebar-edit-row-top">';
      html +=     '<span class="sidebar-edit-drag" title="Drag to reorder">⋮⋮</span>';
      html +=     '<input type="text" class="sidebar-edit-input" data-field="label" value="' + escapeHtml(stage.label) + '" aria-label="Stage label">';
      html +=     '<button class="sidebar-edit-collapse" data-action="collapse" title="Close edit">×</button>';
      html +=   '</div>';
      html +=   '<div class="sidebar-edit-row-bottom">';
      html +=     '<span class="sidebar-edit-meta">' + count + ' node' + (count === 1 ? '' : 's') + '</span>';
      html +=     '<button class="sidebar-edit-delete" data-action="delete">Delete stage</button>';
      html +=   '</div>';
      html += '</div>';
    } else {
      html += '<div class="sidebar-edit-row" data-kind="stage" data-id="' + escapeHtml(stage.id) + '" data-index="' + i + '" draggable="true">';
      html +=   '<span class="sidebar-edit-drag" title="Drag to reorder">⋮⋮</span>';
      html +=   '<span class="sidebar-edit-label">' + escapeHtml(stage.label) + '</span>';
      html +=   '<span class="sidebar-edit-count">' + count + '</span>';
      html +=   '<button class="sidebar-edit-pencil" data-action="expand" title="Edit stage">✎</button>';
      html += '</div>';
    }
  }
  html += '<div class="sidebar-drop-end" data-kind="stage" data-target-index="' + STAGES.length + '"></div>';
  container.innerHTML = html;

  wireRowHandlers(container, "stage");
}

// ───── Streams ─────────────────────────────────────────────────────────
function renderStreamsList() {
  const container = document.getElementById("stream-filters");
  if (!container) return;

  if (STREAMS.length === 0) {
    container.innerHTML = '<div class="sidebar-empty">No streams yet. Click "+ Add stream" to create one.</div>';
    const visEl = document.getElementById("visible-streams-count");
    if (visEl) visEl.textContent = "0 / 0";
    return;
  }

  let html = "";
  for (let i = 0; i < STREAMS.length; i++) {
    const stream = STREAMS[i];
    const isHidden   = state.hiddenStreams.has(stream.id);
    const isExpanded = isExpandedSidebarItem("stream", stream.id);
    const count = streamNodeCount[stream.id] || 0;

    if (isExpanded) {
      html += '<div class="sidebar-edit-row expanded" data-kind="stream" data-id="' + escapeHtml(stream.id) + '" data-index="' + i + '" draggable="true">';
      html +=   '<div class="sidebar-edit-row-top">';
      html +=     '<span class="sidebar-edit-drag" title="Drag to reorder">⋮⋮</span>';
      html +=     '<input type="color" class="sidebar-edit-color" data-field="color" value="' + escapeHtml(stream.color || "#94a3b8") + '" title="Stream colour">';
      html +=     '<input type="text" class="sidebar-edit-input" data-field="label" value="' + escapeHtml(stream.label) + '" aria-label="Stream label">';
      html +=     '<button class="sidebar-edit-collapse" data-action="collapse" title="Close edit">×</button>';
      html +=   '</div>';
      html +=   '<div class="sidebar-edit-row-bottom">';
      html +=     '<span class="sidebar-edit-meta">' + count + ' node' + (count === 1 ? '' : 's') + '</span>';
      html +=     '<input type="text" class="sidebar-edit-input sidebar-edit-input-short" data-field="short" value="' + escapeHtml(stream.short || "") + '" maxlength="6" placeholder="Short" aria-label="Short label">';
      html +=     '<button class="sidebar-edit-delete" data-action="delete">Delete stream</button>';
      html +=   '</div>';
      html += '</div>';
    } else {
      const tip = (isHidden ? "Click to show " : "Click to hide ") + stream.label + " — " + count + " node" + (count === 1 ? "" : "s") + " on the map.";
      html += '<div class="sidebar-edit-row filter-row ' + (isHidden ? "disabled" : "") + '" data-kind="stream" data-id="' + escapeHtml(stream.id) + '" data-index="' + i + '" data-tooltip="' + escapeHtml(tip) + '" draggable="true">';
      html +=   '<span class="sidebar-edit-drag" title="Drag to reorder">⋮⋮</span>';
      html +=   '<input type="color" class="sidebar-edit-color sidebar-edit-swatch" data-field="color" value="' + escapeHtml(stream.color || "#94a3b8") + '" title="Stream colour" aria-label="Stream colour">';
      html +=   '<div class="filter-label" data-action="toggle-filter">' + escapeHtml(stream.label) + '</div>';
      html +=   '<div class="filter-count">' + count + '</div>';
      html +=   '<button class="sidebar-edit-pencil" data-action="expand" title="Edit stream">✎</button>';
      html +=   deleteIconButton("Delete stream");
      html += '</div>';
    }
  }
  html += '<div class="sidebar-drop-end" data-kind="stream" data-target-index="' + STREAMS.length + '"></div>';
  container.innerHTML = html;

  const visEl = document.getElementById("visible-streams-count");
  if (visEl) visEl.textContent = (STREAMS.length - state.hiddenStreams.size) + " / " + STREAMS.length;

  wireRowHandlers(container, "stream");
}

// ───── Categories ──────────────────────────────────────────────────────
// Same edit pattern as streams: compact row toggles the filter on click;
// pencil expands an inline form with label, fill colour, text colour, and a
// delete button (cascade with confirm + undo). Drag-to-reorder via the same
// handle. Categories are stored in an insertion-order-preserving object —
// reorderCategories rebuilds it to commit a new order.
function renderCategoriesList() {
  const container = document.getElementById("category-filters");
  const countEl   = document.getElementById("categories-count");
  if (!container) return;
  const ids = Object.keys(CATEGORIES);
  if (countEl) countEl.textContent = ids.length;

  if (ids.length === 0) {
    container.innerHTML = '<div class="sidebar-empty">No categories yet. Click "+ Add category" to create one.</div>';
    return;
  }

  let html = "";
  for (let i = 0; i < ids.length; i++) {
    const catId = ids[i];
    const cat = CATEGORIES[catId];
    const isHidden   = state.hiddenCategories.has(catId);
    const isExpanded = isExpandedSidebarItem("category", catId);
    const count = categoryNodeCount[catId] || 0;

    if (isExpanded) {
      html += '<div class="sidebar-edit-row expanded" data-kind="category" data-id="' + escapeHtml(catId) + '" data-index="' + i + '" draggable="true">';
      html +=   '<div class="sidebar-edit-row-top">';
      html +=     '<span class="sidebar-edit-drag" title="Drag to reorder">⋮⋮</span>';
      html +=     '<input type="color" class="sidebar-edit-color" data-field="color" value="' + escapeHtml(cat.color || "#94a3b8") + '" title="Fill colour (label colour auto-contrasts)">';
      html +=     '<input type="text" class="sidebar-edit-input" data-field="label" value="' + escapeHtml(cat.label) + '" aria-label="Category label">';
      html +=     '<button class="sidebar-edit-collapse" data-action="collapse" title="Close edit">×</button>';
      html +=   '</div>';
      html +=   '<div class="sidebar-edit-row-bottom">';
      html +=     '<span class="sidebar-edit-meta">' + count + ' node' + (count === 1 ? '' : 's') + '</span>';
      html +=     '<button class="sidebar-edit-delete" data-action="delete">Delete category</button>';
      html +=   '</div>';
      html += '</div>';
    } else {
      const tip = (isHidden ? "Click to show " : "Click to hide ") + cat.label + " — " + count + " node" + (count === 1 ? "" : "s") + " on the map.";
      html += '<div class="sidebar-edit-row filter-row ' + (isHidden ? "disabled" : "") + '" data-kind="category" data-id="' + escapeHtml(catId) + '" data-index="' + i + '" data-tooltip="' + escapeHtml(tip) + '" draggable="true">';
      html +=   '<span class="sidebar-edit-drag" title="Drag to reorder">⋮⋮</span>';
      html +=   '<input type="color" class="sidebar-edit-color sidebar-edit-swatch" data-field="color" value="' + escapeHtml(cat.color || "#94a3b8") + '" title="Fill colour (label colour auto-contrasts)" aria-label="Fill colour">';
      html +=   '<div class="filter-label" data-action="toggle-filter">' + escapeHtml(cat.label) + '</div>';
      html +=   '<div class="filter-count">' + count + '</div>';
      html +=   '<button class="sidebar-edit-pencil" data-action="expand" title="Edit category">✎</button>';
      html +=   deleteIconButton("Delete category");
      html += '</div>';
    }
  }
  html += '<div class="sidebar-drop-end" data-kind="category" data-target-index="' + ids.length + '"></div>';
  container.innerHTML = html;

  wireRowHandlers(container, "category");
}

// Small inline trash-icon button for the compact filter rows, so a stream /
// category can be deleted without expanding first. data-action="delete" hooks
// into the existing cascade-delete wiring in wireRowHandlers.
function deleteIconButton(title) {
  return '<button class="sidebar-row-delete" data-action="delete" title="' + escapeHtml(title) + '" aria-label="' + escapeHtml(title) + '">' +
    '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">' +
    '<path fill="currentColor" d="M6.5 1.5h3a1 1 0 0 1 1 1V3h2.5a.5.5 0 0 1 0 1h-.54l-.7 9.06A1.5 1.5 0 0 1 10.27 14.5H5.73a1.5 1.5 0 0 1-1.49-1.44L3.54 4H3a.5.5 0 0 1 0-1h2.5v-.5a1 1 0 0 1 1-1Zm-1.95 2.5.69 8.98a.5.5 0 0 0 .49.52h4.54a.5.5 0 0 0 .49-.52L11.45 4H4.55ZM6.5 3h3v-.5h-3V3Zm.25 2.75a.5.5 0 0 1 .5.5v5a.5.5 0 0 1-1 0v-5a.5.5 0 0 1 .5-.5Zm2.5 0a.5.5 0 0 1 .5.5v5a.5.5 0 0 1-1 0v-5a.5.5 0 0 1 .5-.5Z"/>' +
    '</svg></button>';
}

// ───── Per-row wiring (expand / collapse / edit / delete / drag) ───────
function wireRowHandlers(container, kind) {
  container.querySelectorAll(".sidebar-edit-row").forEach(row => {
    const id = row.getAttribute("data-id");

    // Pencil → expand for editing.
    const expandBtn = row.querySelector("[data-action='expand']");
    if (expandBtn) {
      expandBtn.addEventListener("click", event => {
        event.stopPropagation();
        state.canvasEdit.editingSidebarItem = { kind: kind, id: id };
        renderSidebar();
        focusSidebarEditLabel(kind, id);
      });
    }

    // × → collapse back to compact.
    const collapseBtn = row.querySelector("[data-action='collapse']");
    if (collapseBtn) {
      collapseBtn.addEventListener("click", event => {
        event.stopPropagation();
        state.canvasEdit.editingSidebarItem = null;
        renderSidebar();
      });
    }

    // Field edits (commit on change / blur).
    row.querySelectorAll("[data-field]").forEach(input => {
      input.addEventListener("change", event => {
        const field = input.getAttribute("data-field");
        applySidebarFieldEdit(kind, id, field, input);
      });
    });

    // Delete (cascade with confirm + undo for all three kinds).
    const delBtn = row.querySelector("[data-action='delete']");
    if (delBtn) {
      delBtn.addEventListener("click", event => {
        event.stopPropagation();
        if (kind === "stream"   && typeof deleteStreamWithCascade   === "function") deleteStreamWithCascade(id);
        if (kind === "stage"    && typeof deleteStageWithCascade    === "function") deleteStageWithCascade(id);
        if (kind === "category" && typeof deleteCategoryWithCascade === "function") deleteCategoryWithCascade(id);
      });
    }

    // Filter toggle — clicking the compact row body / swatch / label
    // hides or shows that stream / category on the map. Stages don't have
    // a filter behaviour.
    if ((kind === "stream" || kind === "category") && !row.classList.contains("expanded")) {
      row.addEventListener("click", event => {
        // Pencil, drag handle, inline colour swatch and delete icon have their
        // own handlers — clicks on them must not also toggle the filter.
        if (event.target.closest(".sidebar-edit-pencil, .sidebar-edit-drag, .sidebar-edit-color, .sidebar-row-delete")) return;
        if (kind === "stream")   toggleStream(id);
        if (kind === "category") toggleCategory(id);
      });
    }
  });

  // Drag-to-reorder. Native HTML5 DnD: each row is draggable, and an
  // insertion-marker `.sidebar-drop-end` sentinel sits after the last row
  // so the user can drop at the end. Visual feedback via .drop-target.
  let draggedIndex = null;
  container.querySelectorAll(".sidebar-edit-row[draggable='true']").forEach(row => {
    row.addEventListener("dragstart", event => {
      draggedIndex = parseInt(row.getAttribute("data-index"), 10);
      row.classList.add("dragging");
      // Force the drag image to be the row itself (Firefox is picky).
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", row.getAttribute("data-id") || "");
      }
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      container.querySelectorAll(".drop-target").forEach(el => el.classList.remove("drop-target"));
      draggedIndex = null;
    });
  });

  // Each row + the sentinel can accept a drop. Computing the insertion
  // index from the targeted element keeps this simple.
  const targets = container.querySelectorAll(".sidebar-edit-row, .sidebar-drop-end");
  targets.forEach(target => {
    target.addEventListener("dragover", event => {
      if (draggedIndex === null) return;
      event.preventDefault();
      targets.forEach(el => el.classList.remove("drop-target"));
      target.classList.add("drop-target");
    });
    target.addEventListener("dragleave", () => {
      target.classList.remove("drop-target");
    });
    target.addEventListener("drop", event => {
      event.preventDefault();
      target.classList.remove("drop-target");
      if (draggedIndex === null) return;
      let targetIndex;
      if (target.classList.contains("sidebar-drop-end")) {
        targetIndex = parseInt(target.getAttribute("data-target-index"), 10);
      } else {
        targetIndex = parseInt(target.getAttribute("data-index"), 10);
      }
      if (kind === "stream"   && typeof reorderStreams    === "function") reorderStreams(draggedIndex, targetIndex);
      if (kind === "stage"    && typeof reorderStages     === "function") reorderStages(draggedIndex, targetIndex);
      if (kind === "category" && typeof reorderCategories === "function") reorderCategories(draggedIndex, targetIndex);
    });
  });
}

// ───── Field writes ────────────────────────────────────────────────────
function applySidebarFieldEdit(kind, id, field, input) {
  if (kind === "stream") {
    const stream = streamById[id];
    if (!stream) return;
    if (field === "label") {
      const newLabel = String(input.value || "").trim() || stream.label;
      stream.label = newLabel;
      // Auto-derive a short label only when the previous one matches the
      // auto-derived form (i.e. user hasn't customised it). Otherwise the
      // separate "Short" input wins.
      if (typeof deriveShortLabel === "function") {
        const auto = deriveShortLabel(stream.label);
        if (!stream.short || stream.short === auto) stream.short = auto;
      }
      // Don't re-render the sidebar — preserve focus while the user tabs
      // through the inputs in the expanded row.
      if (typeof applyCanvasMutation === "function") applyCanvasMutation({ skipDetailRender: true, skipSidebarRender: true });
    } else if (field === "short") {
      stream.short = String(input.value || "").trim().slice(0, 6) || (typeof deriveShortLabel === "function" ? deriveShortLabel(stream.label) : stream.label.slice(0, 6));
      if (typeof applyCanvasMutation === "function") applyCanvasMutation({ skipDetailRender: true, skipSidebarRender: true });
    } else if (field === "color") {
      stream.color = input.value;
      if (typeof applyCanvasMutation === "function") applyCanvasMutation({ skipDetailRender: true, skipSidebarRender: true });
    }
  } else if (kind === "stage") {
    const stage = stageById[id];
    if (!stage) return;
    if (field === "label") {
      const newLabel = String(input.value || "").trim() || stage.label;
      stage.label = newLabel;
      const inArray = STAGES.find(s => s.id === id);
      if (inArray) inArray.label = newLabel;
      if (typeof applyCanvasMutation === "function") applyCanvasMutation({ skipDetailRender: true, skipSidebarRender: true });
    }
  } else if (kind === "category") {
    const cat = CATEGORIES[id];
    if (!cat) return;
    if (field === "label") {
      const newLabel = String(input.value || "").trim() || cat.label;
      cat.label = newLabel;
    } else if (field === "color") {
      cat.color = input.value;
      // Label colour is no longer hand-picked — derive black/white for max
      // contrast against the new fill so node labels stay readable.
      if (typeof pickTextColor === "function") cat.textColor = pickTextColor(cat.color);
    }
    // Re-render the detail panel here too — the Category dropdown over there
    // shows the updated label / colour swatch.
    if (typeof applyCanvasMutation === "function") applyCanvasMutation({ skipDetailRender: true, skipSidebarRender: true });
  }
}

function isExpandedSidebarItem(kind, id) {
  const e = state.canvasEdit && state.canvasEdit.editingSidebarItem;
  return !!(e && e.kind === kind && e.id === id);
}
