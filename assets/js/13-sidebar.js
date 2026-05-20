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

  // Wire the "+ Add stream / + Add stage" buttons (re-runs every render —
  // cheap, and avoids stale closures over removed buttons).
  document.querySelectorAll(".sidebar-add-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const kind = btn.getAttribute("data-add");
      if (kind === "stream" && typeof addStream === "function") addStream();
      if (kind === "stage"  && typeof addStage  === "function") addStage();
    });
  });
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
      html +=   '<div class="filter-swatch" style="background: ' + stream.color + ';" data-action="toggle-filter"></div>';
      html +=   '<div class="filter-label" data-action="toggle-filter">' + escapeHtml(stream.label) + '</div>';
      html +=   '<div class="filter-count">' + count + '</div>';
      html +=   '<button class="sidebar-edit-pencil" data-action="expand" title="Edit stream">✎</button>';
      html += '</div>';
    }
  }
  html += '<div class="sidebar-drop-end" data-kind="stream" data-target-index="' + STREAMS.length + '"></div>';
  container.innerHTML = html;

  const visEl = document.getElementById("visible-streams-count");
  if (visEl) visEl.textContent = (STREAMS.length - state.hiddenStreams.size) + " / " + STREAMS.length;

  wireRowHandlers(container, "stream");
}

// ───── Categories (filter-only, no edit-from-sidebar yet) ──────────────
function renderCategoriesList() {
  const container = document.getElementById("category-filters");
  if (!container) return;
  let html = "";
  for (const [catId, cat] of Object.entries(CATEGORIES)) {
    const isHidden = state.hiddenCategories.has(catId);
    const count = categoryNodeCount[catId] || 0;
    if (count === 0) continue;
    const tip = (isHidden ? "Click to show " : "Click to hide ") + cat.label + " nodes — " + count + " on the map.";
    html += '<div class="filter-row ' + (isHidden ? "disabled" : "") + '" data-cat-id="' + escapeHtml(catId) + '" data-tooltip="' + escapeHtml(tip) + '">';
    html +=   '<div class="filter-swatch" style="background: ' + cat.color + ';"></div>';
    html +=   '<div class="filter-label">' + escapeHtml(cat.label) + '</div>';
    html +=   '<div class="filter-count">' + count + '</div>';
    html += '</div>';
  }
  container.innerHTML = html;
  container.querySelectorAll(".filter-row").forEach(row => {
    row.addEventListener("click", () => {
      toggleCategory(row.getAttribute("data-cat-id"));
    });
  });
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

    // Delete stream / stage (cascade with confirm + undo).
    const delBtn = row.querySelector("[data-action='delete']");
    if (delBtn) {
      delBtn.addEventListener("click", event => {
        event.stopPropagation();
        if (kind === "stream" && typeof deleteStreamWithCascade === "function") deleteStreamWithCascade(id);
        if (kind === "stage"  && typeof deleteStageWithCascade  === "function") deleteStageWithCascade(id);
      });
    }

    // Filter toggle (compact streams only — clicking the row body or its
    // swatch / label toggles hide/show).
    if (kind === "stream" && !row.classList.contains("expanded")) {
      row.addEventListener("click", event => {
        // Pencil and drag handle have their own handlers — let them bubble
        // out of this block.
        if (event.target.closest(".sidebar-edit-pencil, .sidebar-edit-drag")) return;
        toggleStream(id);
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
      if (kind === "stream" && typeof reorderStreams === "function") reorderStreams(draggedIndex, targetIndex);
      if (kind === "stage"  && typeof reorderStages  === "function") reorderStages(draggedIndex, targetIndex);
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
  }
}

function isExpandedSidebarItem(kind, id) {
  const e = state.canvasEdit && state.canvasEdit.editingSidebarItem;
  return !!(e && e.kind === kind && e.id === id);
}
