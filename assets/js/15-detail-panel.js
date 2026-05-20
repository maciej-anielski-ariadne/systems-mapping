// =============================================================================
// RIGHT DETAIL PANEL RENDERING
// -----------------------------------------------------------------------------
// Builds the HTML that appears on the right when a node or edge is selected:
//   • Tags (category / stream / stage)
//   • Node name + description
//   • Quantification block (baseline / current / delta)
//   • Inline edit fields (every node attribute is mutable here)
//   • Mini category manager (collapsible)
//   • Lists of direct inputs and direct impacts
//   • Counts of full upstream / downstream chain
//
// When an edge is selected (canvas-edit clicked an edge), the panel renders
// an edge view: from / to / effect / elasticity / description / delete.
// =============================================================================

function renderDetailPanel() {
  const emptyState   = document.getElementById("detail-empty");
  const contentState = document.getElementById("detail-content");

  const selectedEdgeId = state.canvasEdit && state.canvasEdit.selectedEdgeId;

  // Nothing selected → show the empty-state placeholder.
  if (!state.selectedNodeId && !selectedEdgeId) {
    emptyState.style.display   = "block";
    contentState.style.display = "none";
    return;
  }

  emptyState.style.display   = "none";
  contentState.style.display = "block";

  if (selectedEdgeId) {
    renderEdgeDetail(selectedEdgeId, contentState);
    return;
  }

  const node     = nodeById[state.selectedNodeId];
  if (!node) {
    // Defensive: node was deleted out from under the panel.
    state.selectedNodeId = null;
    emptyState.style.display = "block";
    contentState.style.display = "none";
    return;
  }
  const stream   = streamById[node.stream];
  const category = CATEGORIES[node.category];
  const stage    = stageById[node.stage];

  // Pull lists of incoming/outgoing edges paired with their "other" node.
  // (incomingEdges / outgoingEdges always have an array for every node id —
  // rebuildIndexes guarantees it.)
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
  html += '<div class="detail-tags">';
  if (category) {
    html += '<span class="detail-tag category" style="background: ' + category.color + '; color: ' + category.textColor + ';">' + escapeHtml(category.label) + '</span>';
  }
  if (stream) html += '<span class="detail-tag">' + escapeHtml(stream.label) + '</span>';
  if (stage)  html += '<span class="detail-tag">' + escapeHtml(stage.label) + '</span>';
  html += '</div>';

  // ───── Name + description ────────────────────────────────────────────
  html += '<div class="detail-name">' + escapeHtml(node.label) + '</div>';
  if (node.description) {
    html += '<div class="detail-description">' + escapeHtml(node.description) + '</div>';
  }

  // ───── Quantification block ──────────────────────────────────────────
  if (node.baseline !== undefined && node.baseline !== null) {
    const currentValue = state.computedValues[node.id];
    const deltaInfo = formatNodeDelta(node.id);
    const unit = node.unit || "";

    // Colour the delta value based on whether change is "good" for this node.
    let deltaColor = "var(--text-secondary)";
    if (Math.abs(deltaInfo.pct) >= 0.5) {
      if      (node.direction === "higher_better") deltaColor = deltaInfo.pct > 0 ? "var(--status-good)" : "var(--status-bad)";
      else if (node.direction === "lower_better")  deltaColor = deltaInfo.pct < 0 ? "var(--status-good)" : "var(--status-bad)";
      else                                         deltaColor = deltaInfo.pct > 0 ? "var(--accent-blue)" : "var(--accent-orange)";
    }

    html += '<div class="detail-quant-block">';
    html +=   '<div class="detail-quant-row"><span class="detail-quant-label">Baseline</span><span class="detail-quant-value">' + escapeHtml(formatScalar(node.baseline)) + ' ' + escapeHtml(unit) + '</span></div>';

    // "Current" row: editable input when in sim mode for controllable
    // (exogenous) nodes — lets the user type a precise value here without
    // hunting down the slider. For everything else (sim-mode downstream
    // nodes, or non-sim mode) it's a read-only display.
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
  }

  // ───── Inline edit fields ────────────────────────────────────────────
  html += renderNodeEditBlock(node);

  // ───── Direct inputs + impacts lists ────────────────────────────────
  html += renderEdgeList("Direct Inputs",  directInputs,  "from", "No direct inputs (root cause / exogenous resource)");
  html += renderEdgeList("Direct Impacts", directImpacts, "to",   "No direct impacts (terminal outcome)");

  // ───── Full causal chain summary ─────────────────────────────────────
  html += '<div class="detail-list-title"><span>Full Causal Chain</span></div>';
  html += '<div style="font-family: var(--font-mono); font-size: 11px; color: var(--text-secondary); line-height: 1.7;">';
  html +=   '<div><span style="color: var(--edge-ancestor);">●</span> '   + state.ancestorSet.size   + ' upstream ancestor node(s)</div>';
  html +=   '<div><span style="color: var(--edge-descendant);">●</span> ' + state.descendantSet.size + ' downstream impact node(s)</div>';
  html += '</div>';

  // ───── Delete button ────────────────────────────────────────────────
  html += '<div class="detail-actions" style="margin-top:18px;">';
  html +=   '<button class="detail-button detail-delete-btn" data-action="delete-node">Delete node</button>';
  html += '</div>';

  contentState.innerHTML = html;

  // Wire all editable behaviour, including the mini category manager.
  wireNodeEditHandlers(node, contentState);

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

  // Delete-node button.
  const delBtn = contentState.querySelector("[data-action='delete-node']");
  if (delBtn) {
    delBtn.addEventListener("click", () => {
      if (typeof deleteSelection === "function") deleteSelection();
    });
  }
}

// ───── Render: node edit block ──────────────────────────────────────────
function renderNodeEditBlock(node) {
  const directionOptions = [
    { value: "",              label: "— none —" },
    { value: "higher_better", label: "Higher is better" },
    { value: "lower_better",  label: "Lower is better" },
    { value: "neutral",       label: "Neutral / context" },
  ];
  let html = '<div class="detail-edit-block">';
  html +=   '<div class="detail-list-title"><span>Edit</span></div>';

  // Label.
  html += editRow("Label",
    '<input type="text" class="detail-edit-input" data-field="label" value="' + escapeHtml(node.label || "") + '">');

  // Description.
  html += editRow("Description",
    '<textarea class="detail-edit-input detail-edit-textarea" data-field="description" rows="2">' + escapeHtml(node.description || "") + '</textarea>');

  // Stream.
  html += editRow("Stream", selectInput("stream", STREAMS.map(s => ({ value: s.id, label: s.label })), node.stream));

  // Stage.
  html += editRow("Stage", selectInput("stage", STAGES.map(s => ({ value: s.id, label: s.label })), node.stage));

  // Category (with Manage categories toggle).
  const catOptions = Object.keys(CATEGORIES).map(id => ({ value: id, label: CATEGORIES[id].label }));
  html += editRow("Category",
    selectInput("category", catOptions, node.category) +
    '<button class="detail-edit-link" data-action="toggle-category-manager">' +
      (state.canvasEdit && state.canvasEdit.categoryManagerOpen ? "Hide categories" : "Manage categories") +
    '</button>');

  if (state.canvasEdit && state.canvasEdit.categoryManagerOpen) {
    html += renderCategoryManager();
  }

  // Baseline.
  html += editRow("Baseline",
    '<input type="number" step="any" class="detail-edit-input detail-edit-number" data-field="baseline" value="' + (node.baseline !== undefined && node.baseline !== null ? node.baseline : "") + '" placeholder="(blank = no value)">');

  // Unit.
  html += editRow("Unit",
    '<input type="text" class="detail-edit-input" data-field="unit" value="' + escapeHtml(node.unit || "") + '" placeholder="e.g. FTE, %, hours">');

  // Controllable.
  html += '<div class="detail-edit-row">';
  html +=   '<label class="detail-edit-label"><input type="checkbox" data-field="controllable"' + (node.controllable ? " checked" : "") + '> Controllable (sliderable)</label>';
  html += '</div>';

  // Direction.
  html += editRow("Outcome direction", selectInput("direction", directionOptions, node.direction || ""));

  // Slider max.
  html += editRow("Slider max",
    '<input type="number" step="any" class="detail-edit-input detail-edit-number" data-field="sliderMax" value="' + (node.sliderMax !== undefined && node.sliderMax !== null ? node.sliderMax : "") + '" placeholder="default = 2 × baseline">');

  html += '</div>';
  return html;
}

function editRow(label, controlHtml) {
  return '<div class="detail-edit-row"><span class="detail-edit-label">' + escapeHtml(label) + '</span><div class="detail-edit-control">' + controlHtml + '</div></div>';
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

// ───── Render: mini category manager ───────────────────────────────────
function renderCategoryManager() {
  let html = '<div class="detail-category-manager">';
  html +=   '<div class="detail-category-manager-title">Categories</div>';
  const ids = Object.keys(CATEGORIES);
  if (ids.length === 0) {
    html += '<div class="detail-category-manager-empty">No categories yet. Add one below.</div>';
  } else {
    for (const id of ids) {
      const cat = CATEGORIES[id];
      const count = categoryNodeCount[id] || 0;
      html += '<div class="detail-category-row" data-cat-id="' + escapeHtml(id) + '">';
      html +=   '<input type="text" class="detail-edit-input detail-category-label" data-cat-field="label" value="' + escapeHtml(cat.label) + '">';
      html +=   '<input type="color" class="detail-category-color" data-cat-field="color" value="' + escapeHtml(cat.color) + '" title="Fill colour">';
      html +=   '<input type="color" class="detail-category-color" data-cat-field="textColor" value="' + escapeHtml(cat.textColor) + '" title="Label text colour">';
      html +=   '<button class="detail-category-delete' + (count > 0 ? " disabled" : "") + '" data-cat-action="delete"' + (count > 0 ? ' title="Used by ' + count + ' node(s) — reassign first" disabled' : ' title="Delete category"') + '>×</button>';
      html += '</div>';
    }
  }
  html += '<button class="detail-edit-link" data-cat-action="add">+ Add category</button>';
  html += '</div>';
  return html;
}

// ───── Wire: handlers for the edit block + category manager ────────────
function wireNodeEditHandlers(node, root) {
  // Generic node-field edits.
  root.querySelectorAll(".detail-edit-input[data-field], input[data-field]").forEach(input => {
    const field = input.getAttribute("data-field");
    if (!field) return;
    const eventName = (input.tagName === "SELECT" || input.type === "checkbox") ? "change" : "change";
    input.addEventListener(eventName, () => {
      applyNodeFieldEdit(node, field, input);
    });
  });

  // "Manage categories" toggle.
  const toggleBtn = root.querySelector("[data-action='toggle-category-manager']");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", event => {
      event.preventDefault();
      state.canvasEdit.categoryManagerOpen = !state.canvasEdit.categoryManagerOpen;
      renderDetailPanel();
    });
  }

  // Category manager rows.
  root.querySelectorAll(".detail-category-row").forEach(row => {
    const catId = row.getAttribute("data-cat-id");
    row.querySelectorAll("[data-cat-field]").forEach(input => {
      const catField = input.getAttribute("data-cat-field");
      input.addEventListener("change", () => {
        applyCategoryFieldEdit(catId, catField, input);
      });
    });
    const delBtn = row.querySelector("[data-cat-action='delete']");
    if (delBtn) {
      delBtn.addEventListener("click", event => {
        event.preventDefault();
        if (delBtn.hasAttribute("disabled")) return;
        delete CATEGORIES[catId];
        if (typeof applyCanvasMutation === "function") applyCanvasMutation();
      });
    }
  });

  const addBtn = root.querySelector("[data-cat-action='add']");
  if (addBtn) {
    addBtn.addEventListener("click", event => {
      event.preventDefault();
      addNewCategory();
    });
  }
}

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

  // Field-specific validation and write.
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
  } else if (field === "category") {
    if (!CATEGORIES[value]) return;
    node.category = value;
  } else if (field === "baseline") {
    if (value === undefined) { delete node.baseline; }
    else if (value === 0)    { delete node.baseline; input.value = ""; }   // reject 0 (simulation divides by it)
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

function applyCategoryFieldEdit(catId, field, input) {
  const cat = CATEGORIES[catId];
  if (!cat) return;
  if (field === "label") {
    cat.label = String(input.value).trim() || cat.label;
  } else if (field === "color" || field === "textColor") {
    cat[field] = input.value;
  }
  if (typeof applyCanvasMutation === "function") applyCanvasMutation();
}

function addNewCategory() {
  // Pick a stable id like "category_N".
  let n = Object.keys(CATEGORIES).length + 1;
  let id = "category_" + n;
  while (CATEGORIES[id]) { n++; id = "category_" + n; }
  CATEGORIES[id] = {
    label: "Category " + n,
    color: "#a3a3a3",
    textColor: "#1c1917",
  };
  if (typeof applyCanvasMutation === "function") applyCanvasMutation();
}

// ───── Render: edge detail (when an edge is selected) ───────────────────
function renderEdgeDetail(edgeId, contentState) {
  const edge = EDGES.find(e => e.id === edgeId);
  if (!edge) {
    if (state.canvasEdit) state.canvasEdit.selectedEdgeId = null;
    document.getElementById("detail-empty").style.display = "block";
    contentState.style.display = "none";
    return;
  }
  const fromNode = nodeById[edge.from];
  const toNode   = nodeById[edge.to];
  const effectColors = {
    enables:    "var(--accent-purple)",
    increases:  "var(--accent-green)",
    decreases:  "var(--accent-red)",
  };

  let html = "";
  html += '<div class="detail-tags">';
  html +=   '<span class="detail-tag" style="background:' + effectColors[edge.effect] + '; color: var(--bg-deepest); border:none; font-weight:600;">' + escapeHtml(edge.effect) + '</span>';
  html += '</div>';

  html += '<div class="detail-name">Edge</div>';

  // From / to links.
  html += '<div class="detail-edge-endpoints">';
  html +=   '<div class="detail-edge-endpoint"><span class="detail-edit-label">From</span>';
  html +=     '<button class="detail-edge-endpoint-link" data-jump-node="' + escapeHtml(edge.from) + '">' + escapeHtml(fromNode ? fromNode.label : edge.from) + '</button>';
  html +=   '</div>';
  html +=   '<div class="detail-edge-endpoint"><span class="detail-edit-label">To</span>';
  html +=     '<button class="detail-edge-endpoint-link" data-jump-node="' + escapeHtml(edge.to) + '">' + escapeHtml(toNode ? toNode.label : edge.to) + '</button>';
  html +=   '</div>';
  html += '</div>';

  // Effect / elasticity / description.
  html += '<div class="detail-edit-block">';
  html +=   '<div class="detail-list-title"><span>Edit</span></div>';

  const effectOptions = ["enables", "increases", "decreases"].map(e => ({ value: e, label: e }));
  html += editRow("Effect", selectInput("edge-effect", effectOptions, edge.effect));

  const defaultElasticity = DEFAULT_ELASTICITY_BY_EFFECT[edge.effect];
  html += editRow("Elasticity",
    '<input type="number" step="any" class="detail-edit-input detail-edit-number" data-field="edge-elasticity" value="' + (edge.elasticity !== undefined && edge.elasticity !== null ? edge.elasticity : "") + '" placeholder="default = ' + defaultElasticity + '">');

  html += editRow("Description",
    '<textarea class="detail-edit-input detail-edit-textarea" data-field="edge-description" rows="2">' + escapeHtml(edge.description || "") + '</textarea>');
  html += '</div>';

  // Delete button.
  html += '<div class="detail-actions" style="margin-top:18px;">';
  html +=   '<button class="detail-button detail-delete-btn" data-action="delete-edge">Delete edge</button>';
  html += '</div>';

  contentState.innerHTML = html;

  // From/to navigation.
  contentState.querySelectorAll("[data-jump-node]").forEach(btn => {
    btn.addEventListener("click", () => {
      const nid = btn.getAttribute("data-jump-node");
      if (nodeById[nid]) {
        selectNode(nid);
        scrollNodeIntoView(nid);
      }
    });
  });

  // Effect / elasticity / description edits.
  const effectSelect = contentState.querySelector("[data-field='edge-effect']");
  if (effectSelect) {
    effectSelect.addEventListener("change", () => {
      edge.effect = effectSelect.value;
      if (typeof applyCanvasMutation === "function") applyCanvasMutation();
    });
  }
  const elasticityInput = contentState.querySelector("[data-field='edge-elasticity']");
  if (elasticityInput) {
    elasticityInput.addEventListener("change", () => {
      const v = parseFloat(elasticityInput.value);
      if (elasticityInput.value === "" || isNaN(v)) delete edge.elasticity;
      else edge.elasticity = v;
      if (typeof applyCanvasMutation === "function") applyCanvasMutation();
    });
  }
  const descInput = contentState.querySelector("[data-field='edge-description']");
  if (descInput) {
    descInput.addEventListener("change", () => {
      edge.description = descInput.value;
      if (typeof applyCanvasMutation === "function") applyCanvasMutation();
    });
  }

  const delBtn = contentState.querySelector("[data-action='delete-edge']");
  if (delBtn) {
    delBtn.addEventListener("click", () => {
      if (typeof deleteSelection === "function") deleteSelection();
    });
  }
}

// Render a titled list of edge items (used for both "Direct Inputs" and
// "Direct Impacts"). `items` is an array of { edge, otherNode } pairs;
// `direction` is "from" or "to" (controls the arrow glyph in the row).
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

// One row in either the "Direct Inputs" or "Direct Impacts" list.
// `direction` is "from" (this edge comes INTO the selected node) or "to".
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
