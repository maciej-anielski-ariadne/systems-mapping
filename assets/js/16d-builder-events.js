// =============================================================================
// BUILDER PANEL — event wiring (clicks, typing, focus, drag-to-reorder)
// -----------------------------------------------------------------------------
// All input handling for the wizard lives here. Most of it is event
// delegation — we attach ONE listener per event type to the persistent
// #builder-overlay element and route to the right handler based on the
// `data-*` attribute of the target.
//
//   handleBuilderClick    — buttons inside the overlay (step dots, +Add,
//                           duplicate, delete row).
//   handleBuilderCellChange — every input/change in an editable cell or
//                             a default-elasticity field.
//   handleBuilderFocus    — defined in 16c-builder-editor.js, opens the
//                           floating cell editor on focus.
//   handleBuilderDrag*    — drag-to-reorder for streams / stages /
//                           categories rows.
//   handleBuilderInput    — the "data-section / data-field" field update,
//                           with id and short auto-fill.
//
// Plus per-render rebinding for the once-only buttons in the header /
// footer (close, back, next, apply, download, start-from-sample).
// =============================================================================

// ───── Footer button rebind ──────────────────────────────────────────────
// Two flavours of event wiring: full-render binding (attachBuilderEvents)
// re-binds everything after a full innerHTML replace; footer-only binding
// (wireBuilderFooterButtons) is also reused after the inline footer refresh
// triggered by every keystroke. Keeping them in one place avoids drift.
function wireBuilderFooterButtons() {
  const back = document.getElementById("builder-back-button");
  if (back) back.addEventListener("click", () => {
    if (state.builder.step > 1) { state.builder.step -= 1; renderBuilder(); }
  });
  const next = document.getElementById("builder-next-button");
  if (next) next.addEventListener("click", () => {
    if (state.builder.step < 6) { state.builder.step += 1; renderBuilder(); }
  });
  const apply = document.getElementById("builder-apply-button");
  if (apply) apply.addEventListener("click", applyBuilderToMap);
  const download = document.getElementById("builder-download-button");
  if (download) download.addEventListener("click", downloadBuilderCsv);
}

// ───── Delegated click handler ───────────────────────────────────────────
// Looks at the closest data-* attribute on the click target and dispatches.
function handleBuilderClick(event) {
  const overlay = document.getElementById("builder-overlay");
  const target = event.target.closest("[data-step], [data-add], [data-duplicate], [data-delete]");
  if (!target || !overlay || !overlay.contains(target)) return;

  if (target.hasAttribute("data-step")) {
    const step = parseInt(target.getAttribute("data-step"), 10);
    if (!isNaN(step)) { state.builder.step = step; renderBuilder(); }
    return;
  }
  if (target.hasAttribute("data-add")) {
    addBuilderRow(target.getAttribute("data-add"));
    renderBuilder();
    return;
  }
  const index = parseInt(target.getAttribute("data-index"), 10);
  if (isNaN(index)) return;
  if (target.hasAttribute("data-duplicate")) {
    duplicateBuilderRow(target.getAttribute("data-duplicate"), index);
    renderBuilder();
  } else if (target.hasAttribute("data-delete")) {
    state.builder[target.getAttribute("data-delete")].splice(index, 1);
    renderBuilder();
  }
}

// Routes input + change events to the appropriate field updater based on
// which data-* attribute the target carries.
function handleBuilderCellChange(event) {
  if      (event.target.matches("[data-section][data-field]")) handleBuilderInput(event);
  else if (event.target.matches("[data-default]"))             handleBuilderDefault(event);
}

// ───── Drag-to-reorder for streams / stages / categories rows ───────────
// HTML5 drag-and-drop: the source row stashes its section+index on
// dragstart; the target row computes "drop above / below" from the cursor's
// vertical position. On drop, splice the array, re-render.
let _builderDragSource = null;

function handleBuilderDragStart(event) {
  const row = event.target.closest("tr[draggable='true']");
  if (!row) return;
  _builderDragSource = {
    section: row.getAttribute("data-section"),
    index:   parseInt(row.getAttribute("data-index"), 10),
  };
  row.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
  // Firefox requires some data on the transfer or dragstart fires but no
  // subsequent dragover events arrive.
  try { event.dataTransfer.setData("text/plain", row.getAttribute("data-index")); } catch (_) {}
}

function handleBuilderDragOver(event) {
  if (!_builderDragSource) return;
  const row = event.target.closest("tr[draggable='true']");
  if (!row) return;
  if (row.getAttribute("data-section") !== _builderDragSource.section) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  const rect = row.getBoundingClientRect();
  const above = event.clientY < rect.top + rect.height / 2;
  document.querySelectorAll(".builder-table tr.drop-target-above, .builder-table tr.drop-target-below").forEach(el => {
    el.classList.remove("drop-target-above", "drop-target-below");
  });
  row.classList.add(above ? "drop-target-above" : "drop-target-below");
}

function handleBuilderDrop(event) {
  if (!_builderDragSource) return;
  const row = event.target.closest("tr[draggable='true']");
  if (!row) { handleBuilderDragEnd(); return; }
  if (row.getAttribute("data-section") !== _builderDragSource.section) {
    handleBuilderDragEnd();
    return;
  }
  event.preventDefault();
  const targetIndex = parseInt(row.getAttribute("data-index"), 10);
  const rect = row.getBoundingClientRect();
  const above = event.clientY < rect.top + rect.height / 2;
  const arr = state.builder[_builderDragSource.section];
  const fromIndex = _builderDragSource.index;
  let toIndex = above ? targetIndex : targetIndex + 1;
  if (fromIndex < toIndex) toIndex -= 1;   // splice() shifts elements after the removed one
  if (fromIndex !== toIndex) {
    const [moved] = arr.splice(fromIndex, 1);
    arr.splice(toIndex, 0, moved);
  }
  handleBuilderDragEnd();
  renderBuilder();
  saveBuilderToStorage();
}

function handleBuilderDragEnd() {
  _builderDragSource = null;
  document.querySelectorAll(".builder-table tr.dragging, .builder-table tr.drop-target-above, .builder-table tr.drop-target-below").forEach(el => {
    el.classList.remove("dragging", "drop-target-above", "drop-target-below");
  });
}

// ───── Top-level event attachment ────────────────────────────────────────
function attachBuilderEvents() {
  const overlay = document.getElementById("builder-overlay");
  if (!overlay) return;

  // Buttons that exist exactly once in the rendered overlay — wire by id.
  // These get fresh DOM each render, so they need to be re-bound every time.
  const close = document.getElementById("builder-close-button");
  if (close) close.addEventListener("click", closeBuilder);
  const startFromSample = document.getElementById("builder-start-from-sample");
  if (startFromSample) startFromSample.addEventListener("click", () => {
    seedBuilderFromSample();
    renderBuilder();
  });
  wireBuilderFooterButtons();

  // Delegated listeners live on the overlay element itself (which persists
  // across renders), so we attach them exactly once. The data-attribute
  // flag below makes this idempotent.
  if (overlay.dataset.builderDelegated !== "true") {
    overlay.addEventListener("click",     handleBuilderClick);
    overlay.addEventListener("input",     handleBuilderCellChange);
    overlay.addEventListener("change",    handleBuilderCellChange);
    overlay.addEventListener("focusin",   handleBuilderFocus);
    overlay.addEventListener("dragstart", handleBuilderDragStart);
    overlay.addEventListener("dragover",  handleBuilderDragOver);
    overlay.addEventListener("drop",      handleBuilderDrop);
    overlay.addEventListener("dragend",   handleBuilderDragEnd);
    overlay.dataset.builderDelegated = "true";
  }
}

// ───── Field updaters ────────────────────────────────────────────────────
function handleBuilderDefault(event) {
  const key = event.target.getAttribute("data-default");
  const raw = event.target.value;
  if (raw === "") return;
  const val = parseFloat(raw);
  if (!isNaN(val)) {
    state.builder.defaults[key] = val;
    saveBuilderToStorage();
  }
}

function handleBuilderInput(event) {
  const el      = event.target;
  const section = el.getAttribute("data-section");
  const field   = el.getAttribute("data-field");
  const index   = parseInt(el.getAttribute("data-index"), 10);
  if (!section || !field || isNaN(index)) return;
  const row = state.builder[section][index];
  if (!row) return;

  let newValue;
  if (el.type === "checkbox") {
    newValue = el.checked;
  } else if (el.type === "number") {
    newValue = el.value === "" ? "" : parseFloat(el.value);
    if (typeof newValue === "number" && isNaN(newValue)) newValue = "";
  } else {
    newValue = el.value;
  }

  row[field] = newValue;

  // Auto-fill id from the label, and short label for streams — but only the
  // first time, so the user can override either freely afterwards.
  if (field === "label" && !row.id) {
    const slug = slugify(newValue);
    if (slug) {
      row.id = slug;
      const idInput = el.closest("tr").querySelector('[data-field="id"]');
      if (idInput && !idInput.value) idInput.value = slug;
    }
  }
  if (section === "streams" && field === "label" && !row.short) {
    const short = String(newValue || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    if (short) {
      row.short = short;
      const shortInput = el.closest("tr").querySelector('[data-field="short"]');
      if (shortInput && !shortInput.value) shortInput.value = short;
    }
  }

  // Update the footer (validation count + button enabled state) without
  // doing a full re-render — otherwise we'd wipe focus from the input
  // the user is currently typing in.
  refreshBuilderFooter();
  saveBuilderToStorage();
}
