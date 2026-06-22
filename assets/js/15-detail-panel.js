// =============================================================================
// RIGHT DETAIL PANEL RENDERING
// -----------------------------------------------------------------------------
// Two completely separate modes for a selected node:
//
//   View mode (default): tags, name, description, quant block, "Edit Node"
//     button (full-width, centred), direct inputs, direct impacts, causal
//     chain summary. Read-only — the user is exploring / tracing.
//
//   Edit mode (toggled on via the button above): tags, "Done editing"
//     button, every node field as an editable input, mini category manager,
//     OUTGOING EDGES (each row editable, each deletable, plus an "Add
//     outgoing edge" affordance), and a delete-node button at the bottom.
//     Replaces the view-mode UI entirely so the user can focus on editing.
//
// Edges no longer have a dedicated panel: clicking one on the canvas opens
// the from-node's edit panel and flashes the corresponding outgoing-edges
// row so the user lands on the edge they wanted to edit.
// =============================================================================

function renderDetailPanel() {
  const emptyState   = document.getElementById("detail-empty");
  const contentState = document.getElementById("detail-content");

  // Nothing selected → show the empty-state placeholder.
  if (!state.selectedNodeId) {
    emptyState.style.display   = "block";
    contentState.style.display = "none";
    return;
  }

  const node = nodeById[state.selectedNodeId];
  if (!node) {
    // Defensive: node was deleted out from under the panel.
    state.selectedNodeId = null;
    emptyState.style.display   = "block";
    contentState.style.display = "none";
    return;
  }

  emptyState.style.display   = "none";
  contentState.style.display = "block";

  const editMode = !!(state.canvasEdit && state.canvasEdit.editMode);
  contentState.innerHTML = editMode ? renderEditMode(node) : renderViewMode(node);

  // Upgrade every freshly-rendered <select> into a typable filterable dropdown.
  // Safe to call before the change handlers below are wired: picking an option
  // dispatches `change` on the underlying <select>, which the wireXxx handlers
  // then listen for.
  if (typeof upgradeSelectsIn === "function") upgradeSelectsIn(contentState);

  // Wire up handlers for whichever mode just rendered.
  wireSharedHandlers(node, contentState);
  if (editMode) {
    wireEditModeHandlers(node, contentState);
  } else {
    wireViewModeHandlers(node, contentState);
  }
}

// =============================================================================
// VIEW MODE
// =============================================================================

function renderViewMode(node) {
  const directInputs = incomingEdges[node.id].map(edge => ({
    edge: edge,
    otherNode: nodeById[edge.from],
  }));
  const directImpacts = outgoingEdges[node.id].map(edge => ({
    edge: edge,
    otherNode: nodeById[edge.to],
  }));

  let html = "";

  // ───── Tags row ──────────────────────────────────────────────────────
  html += renderTagRow(node);

  // ───── Name + description ────────────────────────────────────────────
  html += '<div class="detail-name">' + escapeHtml(node.label) + '</div>';
  if (node.description) {
    html += '<div class="detail-description">' + escapeHtml(node.description) + '</div>';
  }

  // ───── Quantification block ──────────────────────────────────────────
  if (node.baseline !== undefined && node.baseline !== null) {
    html += renderQuantBlock(node);
  }

  // ───── Edit Node button (full-width, centred, above Direct Inputs) ──
  html += '<div class="detail-mode-toggle">';
  html +=   '<button class="detail-mode-button" data-action="toggle-edit-mode">Edit Node</button>';
  html += '</div>';

  // ───── Direct inputs + impacts ──────────────────────────────────────
  html += renderEdgeList("Direct Inputs",  directInputs,  "from", "No direct inputs (root cause / exogenous resource)");
  html += renderEdgeList("Direct Impacts", directImpacts, "to",   "No direct impacts (terminal outcome)");

  return html;
}

function renderQuantBlock(node) {
  const currentValue = state.computedValues[node.id];
  const deltaInfo = formatNodeDelta(node.id);
  const unit = node.unit || "";

  let deltaColor = "var(--text-secondary)";
  if (Math.abs(deltaInfo.pct) >= 0.5) {
    if      (node.direction === "higher_better") deltaColor = deltaInfo.pct > 0 ? "var(--status-good)" : "var(--status-bad)";
    else if (node.direction === "lower_better")  deltaColor = deltaInfo.pct < 0 ? "var(--status-good)" : "var(--status-bad)";
    else                                         deltaColor = deltaInfo.pct > 0 ? "var(--accent-blue)" : "var(--accent-orange)";
  }

  let html = '<div class="detail-quant-block">';
  html +=   '<div class="detail-quant-row"><span class="detail-quant-label">Baseline</span><span class="detail-quant-value">' + escapeHtml(formatScalar(node.baseline)) + ' ' + escapeHtml(unit) + '</span></div>';

  if (state.simulationMode && node.controllable) {
    html += '<div class="detail-quant-row"><span class="detail-quant-label">Current</span><span class="detail-quant-value" style="font-weight:600;">' +
              '<input type="number" class="detail-value-input" step="any" value="' + (currentValue !== undefined ? formatScalar(currentValue) : node.baseline) + '" data-node-id="' + escapeHtml(node.id) + '" aria-label="Current value of ' + escapeHtml(node.label) + '" />' +
              (unit ? ' ' + escapeHtml(unit) : '') +
            '</span></div>';
  } else {
    html += '<div class="detail-quant-row"><span class="detail-quant-label">Current</span><span class="detail-quant-value" style="font-weight:600;">' + escapeHtml(currentValue !== undefined ? formatScalar(currentValue) + ' ' + unit : '—') + '</span></div>';
  }

  html +=   '<div class="detail-quant-row"><span class="detail-quant-label">Δ vs baseline</span><span class="detail-quant-value" style="color:' + deltaColor + '; font-weight:600;">' + escapeHtml(deltaInfo.text || '—') + '</span></div>';
  if (node.controllable) {
    html += '<div class="detail-quant-row"><span class="detail-quant-label">Type</span><span class="detail-quant-value" style="color: var(--text-tertiary);">Exogenous input (sliderable)</span></div>';
  }
  if      (node.direction === "higher_better") html += '<div class="detail-quant-row"><span class="detail-quant-label">Outcome</span><span class="detail-quant-value" style="color: var(--status-good);">↑ higher is better</span></div>';
  else if (node.direction === "lower_better")  html += '<div class="detail-quant-row"><span class="detail-quant-label">Outcome</span><span class="detail-quant-value" style="color: var(--status-good);">↓ lower is better</span></div>';
  else if (node.direction === "neutral")       html += '<div class="detail-quant-row"><span class="detail-quant-label">Outcome</span><span class="detail-quant-value" style="color: var(--text-tertiary);">context-dependent</span></div>';
  html += '</div>';
  return html;
}

// =============================================================================
// EDIT MODE
// =============================================================================

function renderEditMode(node) {
  let html = "";

  // ───── Tags row (kept for at-a-glance context) ───────────────────────
  html += renderTagRow(node);

  // ───── Done editing button (full-width, top of edit mode) ────────────
  html += '<div class="detail-mode-toggle">';
  html +=   '<button class="detail-mode-button active" data-action="toggle-edit-mode">Done editing</button>';
  html += '</div>';

  // ───── Edit form ─────────────────────────────────────────────────────
  html += renderNodeEditBlock(node);

  // ───── Outgoing edges ───────────────────────────────────────────────
  html += renderOutgoingEdgesBlock(node);

  // ───── Delete node ───────────────────────────────────────────────────
  html += '<div class="detail-actions">';
  html +=   '<button class="detail-button detail-delete-btn" data-action="delete-node">Delete node</button>';
  html += '</div>';

  return html;
}

// ───── Edit form ──────────────────────────────────────────────────────
function renderNodeEditBlock(node) {
  const directionOptions = [
    { value: "",              label: "— none —" },
    { value: "higher_better", label: "Higher is better" },
    { value: "lower_better",  label: "Lower is better" },
    { value: "neutral",       label: "Neutral / context" },
  ];
  let html = '<div class="detail-edit-block">';
  html +=   '<div class="detail-list-title"><span>Node fields</span></div>';

  html += editRow("Label",
    '<input type="text" class="detail-edit-input" data-field="label" value="' + escapeHtml(node.label || "") + '">');
  html += editRow("Description",
    '<textarea class="detail-edit-input detail-edit-textarea" data-field="description" rows="2">' + escapeHtml(node.description || "") + '</textarea>');
  html += editRow("Stream",
    selectInput("stream", STREAMS.map(s => ({ value: s.id, label: s.label })), node.stream));
  html += editRow("Stage",
    selectInput("stage", STAGES.map(s => ({ value: s.id, label: s.label })), node.stage));

  html += editRow("Categories", categoryEditControl(node));

  html += editRow("Baseline",
    '<input type="number" step="any" class="detail-edit-input detail-edit-number" data-field="baseline" value="' + (node.baseline !== undefined && node.baseline !== null ? node.baseline : "") + '" placeholder="(blank = no value)">');
  html += editRow("Unit",
    '<input type="text" class="detail-edit-input" data-field="unit" value="' + escapeHtml(node.unit || "") + '" placeholder="e.g. FTE, %, hours">');

  html += '<div class="detail-edit-row">';
  html +=   '<label class="detail-edit-label-inline"><input type="checkbox" data-field="controllable"' + (node.controllable ? " checked" : "") + '> Controllable (sliderable)</label>';
  html += '</div>';

  html += editRow("Outcome direction", selectInput("direction", directionOptions, node.direction || ""));
  html += editRow("Slider max",
    '<input type="number" step="any" class="detail-edit-input detail-edit-number" data-field="sliderMax" value="' + (node.sliderMax !== undefined && node.sliderMax !== null ? node.sliderMax : "") + '" placeholder="default = 2 × baseline">');

  html += '</div>';
  return html;
}

function editRow(label, controlHtml) {
  return '<div class="detail-edit-row"><span class="detail-edit-label">' + escapeHtml(label) + '</span><div class="detail-edit-control">' + controlHtml + '</div></div>';
}

// Multi-select category editor: a checkbox per category, split into Primary
// (fill — several blend into a gradient) and Secondary (corner chips) groups by
// each category's class. Checkboxes carry data-field="categoryToggle" so the
// existing change-listener routes them to applyNodeFieldEdit.
function categoryEditControl(node) {
  const primSet = new Set(node.primaryCategories || (node.category ? [node.category] : []));
  const secSet  = new Set(node.secondaryCategories || []);
  const ids     = Object.keys(CATEGORIES);
  const group = (title, list, checkedSet) => {
    if (!list.length) return "";
    let h = '<div class="detail-cat-group"><div class="detail-cat-group-title">' + title + '</div>';
    for (const id of list) {
      const c = CATEGORIES[id];
      h += '<label class="detail-cat-opt"><input type="checkbox" data-field="categoryToggle" data-cat="' + escapeHtml(id) + '"' +
           (checkedSet.has(id) ? " checked" : "") + '>' +
           '<span class="detail-cat-swatch" style="background:' + c.color + '"></span>' + escapeHtml(c.label) + '</label>';
    }
    return h + '</div>';
  };
  return group("Primary · fill",        ids.filter(id => (CATEGORIES[id].class || "primary") !== "secondary"), primSet) +
         group("Secondary · chips",     ids.filter(id => (CATEGORIES[id].class || "primary") === "secondary"), secSet);
}

// Category / stream / stage tag chips shown at the top of both view and edit
// mode. Same markup in both — extracted so changing the chip style (e.g.
// adding an icon) only happens in one place.
function renderTagRow(node) {
  const stream = streamById[node.stream];
  const stage  = stageById[node.stage];
  const catIds = (node.categoryIds && node.categoryIds.length) ? node.categoryIds : (node.category ? [node.category] : []);

  let html = '<div class="detail-tags">';
  for (const id of catIds) {
    const c = CATEGORIES[id];
    if (!c) continue;
    // Secondary categories read as the corner chip — show a small leading swatch.
    const isSecondary = (c.class || "primary") === "secondary";
    html += '<span class="detail-tag category' + (isSecondary ? " secondary" : "") + '" style="background: ' + c.color + '; color: ' + c.textColor + ';">' +
            (isSecondary ? '▪ ' : '') + escapeHtml(c.label) + '</span>';
  }
  if (stream) html += '<span class="detail-tag">' + escapeHtml(stream.label) + '</span>';
  if (stage)  html += '<span class="detail-tag">' + escapeHtml(stage.label) + '</span>';
  html += '</div>';
  return html;
}

function selectInput(field, options, currentValue) {
  let html = '<select class="detail-edit-input detail-edit-select" data-field="' + field + '">';
  for (const opt of options) {
    const isSelected = (opt.value === currentValue || (currentValue === undefined && opt.value === ""));
    html += '<option value="' + escapeHtml(opt.value) + '"' + (isSelected ? " selected" : "") + '>' + escapeHtml(opt.label) + '</option>';
  }
  html += '</select>';
  return html;
}

// ───── Outgoing edges (edit mode) ─────────────────────────────────────
function renderOutgoingEdgesBlock(node) {
  const outgoing = outgoingEdges[node.id] || [];
  const flashedId = state.canvasEdit && state.canvasEdit.flashedEdgeId;
  const adding = state.canvasEdit && state.canvasEdit.addingEdgeFromNodeId === node.id;

  let html = '<div class="outgoing-edges-block">';
  html +=   '<div class="detail-list-title"><span>Outgoing edges</span><span class="count">' + outgoing.length + '</span></div>';

  if (outgoing.length === 0) {
    html += '<div class="outgoing-edges-empty">No outgoing edges yet. Drag from the right edge of this node on the canvas, or add one below.</div>';
  } else {
    for (const edge of outgoing) {
      const target = nodeById[edge.to];
      const defaultElasticity = DEFAULT_ELASTICITY_BY_EFFECT[edge.effect];
      const flashClass = (edge.id === flashedId) ? " flash" : "";
      html += '<div class="outgoing-edge-row ' + edge.effect + flashClass + '" data-edge-row-id="' + escapeHtml(edge.id) + '">';
      html +=   '<div class="outgoing-edge-header">';
      html +=     '<button class="outgoing-edge-target-link" data-jump-node="' + escapeHtml(edge.to) + '" title="Jump to target node">→ ' + escapeHtml(target ? target.label : edge.to) + '</button>';
      html +=     '<button class="outgoing-edge-delete" data-edge-action="delete" data-edge-id="' + escapeHtml(edge.id) + '" title="Delete this edge">×</button>';
      html +=   '</div>';
      html +=   '<div class="outgoing-edge-controls">';
      html +=     '<select class="detail-edit-input detail-edit-select" data-edge-id="' + escapeHtml(edge.id) + '" data-edge-field="effect">';
      for (const eff of EFFECT_OPTIONS) {
        html +=     '<option value="' + eff + '"' + (edge.effect === eff ? " selected" : "") + '>' + eff + '</option>';
      }
      html +=     '</select>';
      html +=     '<input type="number" step="any" class="detail-edit-input detail-edit-number outgoing-edge-elasticity" data-edge-id="' + escapeHtml(edge.id) + '" data-edge-field="elasticity" value="' + (edge.elasticity !== undefined && edge.elasticity !== null ? edge.elasticity : "") + '" placeholder="ε = ' + defaultElasticity + '" title="Elasticity (blank = default for this effect)">';
      html +=   '</div>';
      html +=   '<textarea class="detail-edit-input detail-edit-textarea outgoing-edge-description" data-edge-id="' + escapeHtml(edge.id) + '" data-edge-field="description" rows="2" placeholder="Optional description">' + escapeHtml(edge.description || "") + '</textarea>';
      html += '</div>';
    }
  }

  // Add affordance — collapsed by default, expands to a target/effect form.
  if (adding) {
    // Exclude nodes the source already has an outgoing edge to — changing
    // an existing edge's effect goes through arrow-cycling on the canvas,
    // not a second parallel edge from the form.
    const connectedTargetIds = new Set(outgoing.map(e => e.to));
    const otherNodes = NODES.filter(n => n.id !== node.id && !connectedTargetIds.has(n.id));
    const hasAnyOtherNode = NODES.some(n => n.id !== node.id);
    // Retained but unused for the dropdown filter — keep for any consumers
    // that reference effect-level dedupe.
    const existingTargets = new Set(outgoing.map(e => e.to + ":" + e.effect));
    html += '<div class="outgoing-edge-add">';
    if (otherNodes.length === 0) {
      const emptyMsg = hasAnyOtherNode
        ? "All other nodes are already connected."
        : "Add at least one other node before connecting edges.";
      html +=   '<div class="outgoing-edges-empty">' + emptyMsg + '</div>';
      html +=   '<button class="detail-edit-link" data-action="cancel-add-edge">Cancel</button>';
    } else {
      html +=   '<div class="outgoing-edge-add-title">Add outgoing edge</div>';
      html +=   '<div class="outgoing-edge-add-row">';
      html +=     '<select class="detail-edit-input detail-edit-select" data-action="pick-add-target">';
      for (const n of otherNodes) {
        html +=     '<option value="' + escapeHtml(n.id) + '">' + escapeHtml(n.label) + '</option>';
      }
      html +=     '</select>';
      html +=     '<select class="detail-edit-input detail-edit-select" data-action="pick-add-effect">';
      for (const eff of EFFECT_OPTIONS) {
        html +=     '<option value="' + eff + '"' + (eff === "increases" ? " selected" : "") + '>' + eff + '</option>';
      }
      html +=     '</select>';
      html +=   '</div>';
      html +=   '<div class="outgoing-edge-add-actions">';
      html +=     '<button class="detail-edit-link" data-action="cancel-add-edge">Cancel</button>';
      html +=     '<button class="detail-button" data-action="confirm-add-edge">Add edge</button>';
      html +=   '</div>';
    }
    html += '</div>';
  } else {
    html += '<button class="detail-edit-link outgoing-edge-add-toggle" data-action="show-add-edge">+ Add outgoing edge</button>';
  }

  html += '</div>';
  return html;
}

// =============================================================================
// HANDLERS
// =============================================================================

function wireSharedHandlers(node, contentState) {
  // Toggle between View and Edit. Shared by both modes (just the label and
  // styling differ).
  const editToggle = contentState.querySelector("[data-action='toggle-edit-mode']");
  if (editToggle) {
    editToggle.addEventListener("click", () => {
      state.canvasEdit.editMode = !state.canvasEdit.editMode;
      if (!state.canvasEdit.editMode) {
        state.canvasEdit.addingEdgeFromNodeId = null;
      }
      renderDetailPanel();
    });
  }
}

function wireViewModeHandlers(node, contentState) {
  // Clicking an edge item navigates to that node.
  contentState.querySelectorAll(".detail-edge-item").forEach(item => {
    item.addEventListener("click", () => {
      const targetNodeId = item.getAttribute("data-target-node");
      selectNode(targetNodeId);
      scrollNodeIntoView(targetNodeId);
    });
  });

  // Editable "Current" input in sim mode for controllable nodes.
  contentState.querySelectorAll(".detail-value-input").forEach(input => {
    input.addEventListener("input", event => {
      const nodeId = event.target.getAttribute("data-node-id");
      const targetNode = nodeById[nodeId];
      if (!targetNode || !targetNode.baseline) return;
      const raw = parseFloat(event.target.value);
      if (isNaN(raw)) return;
      if (typeof applySimMultiplier === "function") {
        applySimMultiplier(nodeId, raw / targetNode.baseline, event.target);
      }
      if (typeof updateDetailPanelDeltaInline === "function") {
        updateDetailPanelDeltaInline(nodeId);
      }
    });
  });
}

function wireEditModeHandlers(node, contentState) {
  // Node-field edits.
  contentState.querySelectorAll("[data-field]").forEach(input => {
    if (input.hasAttribute("data-edge-field")) return;     // edge inputs wired below
    const field = input.getAttribute("data-field");
    if (!field) return;
    input.addEventListener("change", () => {
      applyNodeFieldEdit(node, field, input);
    });
  });

  // Outgoing-edges row edits + delete.
  contentState.querySelectorAll(".outgoing-edge-row [data-edge-field]").forEach(input => {
    const edgeId = input.getAttribute("data-edge-id");
    const field  = input.getAttribute("data-edge-field");
    input.addEventListener("change", () => {
      applyEdgeFieldEdit(edgeId, field, input);
    });
  });
  contentState.querySelectorAll(".outgoing-edge-target-link").forEach(btn => {
    btn.addEventListener("click", () => {
      const targetId = btn.getAttribute("data-jump-node");
      if (nodeById[targetId]) {
        selectNode(targetId);
        scrollNodeIntoView(targetId);
      }
    });
  });
  contentState.querySelectorAll("[data-edge-action='delete']").forEach(btn => {
    btn.addEventListener("click", () => {
      const edgeId = btn.getAttribute("data-edge-id");
      if (typeof deleteEdgeById === "function") deleteEdgeById(edgeId);
    });
  });

  // Add-outgoing-edge affordance.
  const showAddBtn = contentState.querySelector("[data-action='show-add-edge']");
  if (showAddBtn) {
    showAddBtn.addEventListener("click", event => {
      event.preventDefault();
      state.canvasEdit.addingEdgeFromNodeId = node.id;
      renderDetailPanel();
    });
  }
  const cancelAddBtn = contentState.querySelector("[data-action='cancel-add-edge']");
  if (cancelAddBtn) {
    cancelAddBtn.addEventListener("click", event => {
      event.preventDefault();
      state.canvasEdit.addingEdgeFromNodeId = null;
      renderDetailPanel();
    });
  }
  const confirmAddBtn = contentState.querySelector("[data-action='confirm-add-edge']");
  if (confirmAddBtn) {
    confirmAddBtn.addEventListener("click", event => {
      event.preventDefault();
      const targetSel = contentState.querySelector("[data-action='pick-add-target']");
      const effectSel = contentState.querySelector("[data-action='pick-add-effect']");
      if (!targetSel || !effectSel) return;
      const targetId = targetSel.value;
      const effect   = effectSel.value;
      state.canvasEdit.addingEdgeFromNodeId = null;
      if (typeof commitNewEdge === "function") commitNewEdge(node.id, targetId, effect);
    });
  }

  // Delete-node button.
  const delBtn = contentState.querySelector("[data-action='delete-node']");
  if (delBtn) {
    delBtn.addEventListener("click", () => {
      if (typeof deleteSelection === "function") deleteSelection();
    });
  }
}

// =============================================================================
// FIELD WRITES
// =============================================================================

function applyNodeFieldEdit(node, field, input) {
  let value;
  if (input.type === "checkbox") value = input.checked;
  else if (input.type === "number") {
    const v = parseFloat(input.value);
    value = (input.value === "" || isNaN(v)) ? undefined : v;
  } else {
    value = input.value;
  }

  // Plain text / number fields don't affect layout — skip the detail-panel
  // re-render so focus (and tab order) is preserved as the user moves
  // between fields. Layout-affecting changes (stream / stage / category /
  // controllable / direction) trigger a full re-render so the panel reflects
  // the new state.
  let skipDetailRender = false;

  if (field === "label") {
    const trimmed = String(value).trim();
    node.label = trimmed || "Untitled";
    input.value = node.label;
    skipDetailRender = true;
  } else if (field === "description") {
    node.description = String(value || "");
    skipDetailRender = true;
  } else if (field === "stream") {
    if (!streamById[value]) return;
    node.stream = value;
  } else if (field === "stage") {
    if (!stageById[value]) return;
    node.stage = value;
  } else if (field === "categoryToggle") {
    const catId = input.getAttribute("data-cat");
    if (!CATEGORIES[catId]) return;
    // Snapshot so we can fully revert if the edit would empty the node.
    const prev = {
      primaryCategories:   (node.primaryCategories   || []).slice(),
      secondaryCategories: (node.secondaryCategories || []).slice(),
      categoryIds:         (node.categoryIds         || []).slice(),
      category:            node.category,
    };
    const isSecondary = (CATEGORIES[catId].class || "primary") === "secondary";
    const listName = isSecondary ? "secondaryCategories" : "primaryCategories";
    const set = new Set(node[listName] || []);
    if (value) set.add(catId); else set.delete(catId);
    const allIds = Object.keys(CATEGORIES);   // re-derive in CATEGORIES order
    node[listName] = allIds.filter(id => set.has(id));
    node.primaryCategories   = node.primaryCategories   || [];
    node.secondaryCategories = node.secondaryCategories || [];
    node.categoryIds = node.primaryCategories.concat(node.secondaryCategories);
    // A node must keep at least one category — fully revert if it'd empty.
    if (node.categoryIds.length === 0) {
      node.primaryCategories   = prev.primaryCategories;
      node.secondaryCategories = prev.secondaryCategories;
      node.categoryIds         = prev.categoryIds;
      node.category            = prev.category;
      input.checked = true;
      return;
    }
    node.category = node.primaryCategories[0] || node.categoryIds[0];
  } else if (field === "baseline") {
    if (value === undefined) { delete node.baseline; }
    else if (value === 0)    { delete node.baseline; input.value = ""; }   // simulation divides by baseline
    else                     { node.baseline = value; }
    skipDetailRender = true;
  } else if (field === "unit") {
    if (value) node.unit = String(value); else delete node.unit;
    skipDetailRender = true;
  } else if (field === "controllable") {
    if (value) node.controllable = true; else delete node.controllable;
  } else if (field === "direction") {
    if (value) node.direction = value; else delete node.direction;
  } else if (field === "sliderMax") {
    if (value === undefined) delete node.sliderMax;
    else                     node.sliderMax = value;
    skipDetailRender = true;
  }

  if (typeof applyCanvasMutation === "function") applyCanvasMutation({ skipDetailRender: skipDetailRender });
}

function applyEdgeFieldEdit(edgeId, field, input) {
  const edge = EDGES.find(e => e.id === edgeId);
  if (!edge) return;
  if (field === "effect") {
    if (!EFFECT_OPTIONS.includes(input.value)) return;
    edge.effect = input.value;
  } else if (field === "elasticity") {
    const v = parseFloat(input.value);
    if (input.value === "" || isNaN(v)) delete edge.elasticity;
    else                                  edge.elasticity = v;
    // Editing elasticity / description doesn't change layout — preserve focus.
    if (typeof applyCanvasMutation === "function") applyCanvasMutation({ skipDetailRender: true });
    return;
  } else if (field === "description") {
    edge.description = String(input.value || "");
    if (typeof applyCanvasMutation === "function") applyCanvasMutation({ skipDetailRender: true });
    return;
  }
  if (typeof applyCanvasMutation === "function") applyCanvasMutation();
}

// =============================================================================
// SHARED — edge-list rendering used by view mode
// =============================================================================

function renderEdgeList(title, items, direction, emptyText) {
  let html = '<div class="detail-list-title">';
  html +=     '<span>' + escapeHtml(title) + '</span>';
  html +=     '<span class="count">' + items.length + '</span>';
  html +=   '</div>';
  if (items.length === 0) {
    html += '<div style="color: var(--text-tertiary); font-size: 12px; padding: 6px 0;">' + escapeHtml(emptyText) + '</div>';
  } else {
    for (const item of items) {
      html += renderEdgeItem(item.otherNode, item.edge, direction);
    }
  }
  return html;
}

function renderEdgeItem(otherNode, edge, direction) {
  const effectClass = edge.effect;
  const arrow = direction === "from" ? "←" : "→";
  const elasticity = resolveEdgeElasticity(edge);
  const elasticitySign = elasticity > 0 ? "+" : "";
  const elasticityText = elasticity !== 0 ? "ε = " + elasticitySign + elasticity.toFixed(2) : "ε = 0";

  let html = '<div class="detail-edge-item ' + effectClass + '" data-target-node="' + otherNode.id + '">';
  html +=   '<div class="detail-edge-header">';
  html +=     '<div class="detail-edge-name">' + arrow + ' ' + escapeHtml(otherNode.label) + '</div>';
  html +=     '<div class="detail-edge-elasticity">' + escapeHtml(elasticityText) + '</div>';
  html +=   '</div>';
  html +=   '<div class="detail-edge-effect ' + effectClass + '">' + edge.effect + '</div>';
  html +=   '<div class="detail-edge-desc">' + escapeHtml(edge.description) + '</div>';
  html += '</div>';
  return html;
}
