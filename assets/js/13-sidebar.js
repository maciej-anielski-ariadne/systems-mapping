// =============================================================================
// LEFT SIDEBAR RENDERING
// -----------------------------------------------------------------------------
// Builds the HTML for the Stages list, the Stream filter rows, and the Category
// filter rows (and — in simulation mode — delegates to the simulation panel).
//
// Every row edits fully inline: double-click a name (or a stream's short-label
// chip) to rename it, click the swatch to recolour, and the trash icon to
// delete. Stream/category rows also toggle their map filter on a single click.
// Rows are drag-reorderable. Every mutation funnels through applyCanvasMutation.
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
    const count = NODES.reduce((acc, n) => n.stage === stage.id ? acc + 1 : acc, 0);
    const isHidden = state.hiddenStages.has(stage.id);
    const tip = (isHidden ? "Click to show " : "Click to hide ") + stage.label + " — " + count + " node" + (count === 1 ? "" : "s") + " on the map. Double-click the name to rename.";
    html += '<div class="sidebar-edit-row filter-row ' + (isHidden ? "disabled" : "") + '" data-kind="stage" data-id="' + escapeHtml(stage.id) + '" data-index="' + i + '" data-tooltip="' + escapeHtml(tip) + '" draggable="true">';
    html +=   '<span class="sidebar-edit-drag" title="Drag to reorder">⋮⋮</span>';
    html +=   '<span class="sidebar-edit-label sidebar-inline-edit" data-field="label" title="Double-click to rename">' + escapeHtml(stage.label) + '</span>';
    html +=   '<span class="sidebar-edit-count">' + count + '</span>';
    html +=   deleteIconButton("Delete stage");
    html += '</div>';
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
    const isHidden = state.hiddenStreams.has(stream.id);
    const count = streamNodeCount[stream.id] || 0;
    const short = stream.short || (typeof deriveShortLabel === "function" ? deriveShortLabel(stream.label) : "");

    const tip = (isHidden ? "Click to show " : "Click to hide ") + stream.label + " — " + count + " node" + (count === 1 ? "" : "s") + " on the map. Double-click the name to rename.";
    html += '<div class="sidebar-edit-row filter-row ' + (isHidden ? "disabled" : "") + '" data-kind="stream" data-id="' + escapeHtml(stream.id) + '" data-index="' + i + '" data-tooltip="' + escapeHtml(tip) + '" draggable="true">';
    html +=   '<span class="sidebar-edit-drag" title="Drag to reorder">⋮⋮</span>';
    html +=   '<input type="color" class="sidebar-edit-color sidebar-edit-swatch" data-field="color" value="' + escapeHtml(stream.color || "#94a3b8") + '" title="Stream colour" aria-label="Stream colour">';
    html +=   '<div class="filter-label sidebar-inline-edit" data-field="label" title="Double-click to rename">' + escapeHtml(stream.label) + '</div>';
    html +=   '<span class="sidebar-short-chip sidebar-inline-edit" data-field="short" title="Double-click to edit short label">' + escapeHtml(short) + '</span>';
    html +=   '<div class="filter-count">' + count + '</div>';
    html +=   deleteIconButton("Delete stream");
    html += '</div>';
  }
  html += '<div class="sidebar-drop-end" data-kind="stream" data-target-index="' + STREAMS.length + '"></div>';
  container.innerHTML = html;

  const visEl = document.getElementById("visible-streams-count");
  if (visEl) visEl.textContent = (STREAMS.length - state.hiddenStreams.size) + " / " + STREAMS.length;

  wireRowHandlers(container, "stream");
}

// ───── Categories ──────────────────────────────────────────────────────
// Categories are stored in an insertion-order-preserving object —
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
    const isHidden = state.hiddenCategories.has(catId);
    const count = categoryNodeCount[catId] || 0;

    const tip = (isHidden ? "Click to show " : "Click to hide ") + cat.label + " — " + count + " node" + (count === 1 ? "" : "s") + " on the map. Double-click the name to rename.";
    html += '<div class="sidebar-edit-row filter-row ' + (isHidden ? "disabled" : "") + '" data-kind="category" data-id="' + escapeHtml(catId) + '" data-index="' + i + '" data-tooltip="' + escapeHtml(tip) + '" draggable="true">';
    html +=   '<span class="sidebar-edit-drag" title="Drag to reorder">⋮⋮</span>';
    html +=   '<input type="color" class="sidebar-edit-color sidebar-edit-swatch" data-field="color" value="' + escapeHtml(cat.color || "#94a3b8") + '" title="Fill colour (label colour auto-contrasts)" aria-label="Fill colour">';
    html +=   '<div class="filter-label sidebar-inline-edit" data-field="label" title="Double-click to rename">' + escapeHtml(cat.label) + '</div>';
    html +=   '<div class="filter-count">' + count + '</div>';
    html +=   deleteIconButton("Delete category");
    html += '</div>';
  }
  html += '<div class="sidebar-drop-end" data-kind="category" data-target-index="' + ids.length + '"></div>';
  container.innerHTML = html;

  wireRowHandlers(container, "category");
}

// Small inline trash-icon delete button shared by every sidebar row.
// data-action="delete" hooks into the cascade-delete wiring in wireRowHandlers.
function deleteIconButton(title) {
  return '<button class="sidebar-row-delete" data-action="delete" title="' + escapeHtml(title) + '" aria-label="' + escapeHtml(title) + '">' +
    '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">' +
    '<path fill="currentColor" d="M6.5 1.5h3a1 1 0 0 1 1 1V3h2.5a.5.5 0 0 1 0 1h-.54l-.7 9.06A1.5 1.5 0 0 1 10.27 14.5H5.73a1.5 1.5 0 0 1-1.49-1.44L3.54 4H3a.5.5 0 0 1 0-1h2.5v-.5a1 1 0 0 1 1-1Zm-1.95 2.5.69 8.98a.5.5 0 0 0 .49.52h4.54a.5.5 0 0 0 .49-.52L11.45 4H4.55ZM6.5 3h3v-.5h-3V3Zm.25 2.75a.5.5 0 0 1 .5.5v5a.5.5 0 0 1-1 0v-5a.5.5 0 0 1 .5-.5Zm2.5 0a.5.5 0 0 1 .5.5v5a.5.5 0 0 1-1 0v-5a.5.5 0 0 1 .5-.5Z"/>' +
    '</svg></button>';
}

// Turn an inline-editable element into a text editor: make it contenteditable,
// select its text, and commit on Enter / blur (Escape cancels). The `field`
// ("label" or "short") routes the committed value through applySidebarFieldEdit.
// We disable the row's drag while editing so the cursor can be placed with the
// mouse, then renderSidebar() rebuilds a clean row on commit.
function beginInlineEdit(el, row, kind, id, field) {
  if (!el || el.getAttribute("contenteditable") === "true") return;
  const original = el.textContent;
  el.setAttribute("contenteditable", "true");
  el.classList.add("editing");
  if (row) row.setAttribute("draggable", "false");
  el.focus();

  // Select the whole text so typing replaces it.
  const sel = window.getSelection();
  if (sel) {
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  let finished = false;
  const finish = save => {
    if (finished) return;
    finished = true;
    el.removeAttribute("contenteditable");
    el.classList.remove("editing");
    const newText = el.textContent.trim();
    if (save && newText && newText !== original) {
      applySidebarFieldEdit(kind, id, field, { value: newText });
    }
    renderSidebar(); // rebuild the row in its clean, non-editing state
  };

  el.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      el.textContent = original;
      finish(false);
    }
  });
  el.addEventListener("blur", () => finish(true));
}

// Begin inline rename on a freshly-added row (e.g. just after "+ Add stream"),
// once renderSidebar has painted it.
function focusSidebarInlineLabel(kind, id) {
  setTimeout(() => {
    const row = document.querySelector(".sidebar-edit-row[data-kind='" + kind + "'][data-id='" + CSS.escape(id) + "']");
    const labelEl = row && row.querySelector(".sidebar-inline-edit[data-field='label']");
    if (labelEl) beginInlineEdit(labelEl, row, kind, id, "label");
  }, 0);
}

// ───── Per-row wiring (inline edit / colour / delete / filter / drag) ─────
function wireRowHandlers(container, kind) {
  const isFilter = (kind === "stream" || kind === "category" || kind === "stage");

  container.querySelectorAll(".sidebar-edit-row").forEach(row => {
    const id = row.getAttribute("data-id");

    const toggle = () => {
      if (kind === "stream")   toggleStream(id);
      if (kind === "category") toggleCategory(id);
      if (kind === "stage")    toggleStage(id);
    };

    // Inline colour swatch commits on change.
    row.querySelectorAll("input[data-field]").forEach(input => {
      input.addEventListener("change", () => {
        applySidebarFieldEdit(kind, id, input.getAttribute("data-field"), input);
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

    // Filter toggle — clicking the row body (anything that isn't an interactive
    // control) hides/shows that stream / category on the map. Stages don't
    // filter.
    if (isFilter) {
      row.addEventListener("click", event => {
        if (event.target.closest(".sidebar-edit-drag, .sidebar-edit-color, .sidebar-row-delete, .sidebar-inline-edit")) return;
        toggle();
      });
    }

    // Inline text editing — double-click any editable element (the name, or a
    // stream's short-label chip) to edit it. On filter rows a single click on
    // that element still toggles the filter; a short timer disambiguates the
    // single click from the double click that starts editing.
    row.querySelectorAll(".sidebar-inline-edit").forEach(el => {
      const field = el.getAttribute("data-field");
      let clickTimer = null;
      el.addEventListener("dblclick", event => {
        event.stopPropagation();
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
        beginInlineEdit(el, row, kind, id, field);
      });
      if (isFilter) {
        el.addEventListener("click", event => {
          event.stopPropagation();
          if (el.getAttribute("contenteditable") === "true") return; // already editing
          if (clickTimer) return;
          clickTimer = setTimeout(() => { clickTimer = null; toggle(); }, 220);
        });
      }
    });
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
      // separate short-label chip wins.
      if (typeof deriveShortLabel === "function") {
        const auto = deriveShortLabel(stream.label);
        if (!stream.short || stream.short === auto) stream.short = auto;
      }
    } else if (field === "short") {
      stream.short = String(input.value || "").trim().slice(0, 6) || (typeof deriveShortLabel === "function" ? deriveShortLabel(stream.label) : stream.label.slice(0, 6));
    } else if (field === "color") {
      stream.color = input.value;
    }
  } else if (kind === "stage") {
    const stage = stageById[id];
    if (!stage) return;
    if (field === "label") {
      const newLabel = String(input.value || "").trim() || stage.label;
      stage.label = newLabel;
      const inArray = STAGES.find(s => s.id === id);
      if (inArray) inArray.label = newLabel;
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
  }
  // Editing inline keeps the row in place; skip the sidebar re-render so an
  // in-progress edit isn't torn down (callers that need a rebuild — e.g. the
  // inline-edit commit — call renderSidebar themselves afterwards).
  if (typeof applyCanvasMutation === "function") applyCanvasMutation({ skipDetailRender: true, skipSidebarRender: true });
}
