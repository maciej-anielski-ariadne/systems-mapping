// =============================================================================
// BUILDER PANEL — render functions
// -----------------------------------------------------------------------------
// HTML output for the wizard overlay: top dispatch (`renderBuilder`), the
// header / footer / step indicator, six step renderers, and tiny helpers
// (`reviewTile`, `optionList`, `refreshBuilderFooter`).
//
// Reads state from `state.builder` (set up in 16a-builder-state.js) and
// validation results from `validateBuilder()`. After painting the overlay
// it calls `attachBuilderEvents()` from 16d-builder-events.js to wire up
// click / drag / typing handlers.
//
// Pattern: each step's HTML is a single string with the `BUILDER_SPLIT`
// marker dividing the always-visible top section (heading, blurb, action
// bar) from the scrollable bottom section (the row table). The split lets
// long row lists scroll while the heading stays anchored.
// =============================================================================

// ───── Main render dispatch ───────────────────────────────────────────────
function renderBuilder() {
  const overlay = document.getElementById("builder-overlay");
  if (!overlay) return;

  // The floating cell editor references DOM nodes inside the overlay. A
  // full re-render destroys those nodes, so close the editor first to
  // avoid a stale trigger reference.
  hideCellEditor();

  if (!state.builder.open) {
    overlay.classList.remove("open");
    overlay.innerHTML = "";
    return;
  }

  let body = "";
  switch (state.builder.step) {
    case 1: body = renderBuilderStreamsStep();    break;
    case 2: body = renderBuilderStagesStep();     break;
    case 3: body = renderBuilderCategoriesStep(); break;
    case 4: body = renderBuilderNodesStep();      break;
    case 5: body = renderBuilderEdgesStep();      break;
    case 6: body = renderBuilderReviewStep();     break;
  }

  const splitIdx = body.indexOf(BUILDER_SPLIT);
  const above  = splitIdx === -1 ? body : body.slice(0, splitIdx);
  const scroll = splitIdx === -1 ? ""   : body.slice(splitIdx + BUILDER_SPLIT.length);

  overlay.innerHTML =
    '<div class="builder-card">' +
      renderBuilderHeader() +
      '<div class="builder-body">' +
        '<div class="builder-step-static">' + above + '</div>' +
        '<div class="builder-step-scroll">' + scroll + '</div>' +
      '</div>' +
      renderBuilderFooter() +
    '</div>';
  overlay.classList.add("open");

  attachBuilderEvents();
  saveBuilderToStorage();
}

function renderBuilderHeader() {
  let dots = "";
  for (const step of BUILDER_STEPS) {
    const active = step.num === state.builder.step ? " active" : "";
    dots += '<button class="builder-step-dot' + active + '" data-step="' + step.num + '">' +
            step.num + ' · ' + escapeHtml(step.label) +
            '</button>';
  }
  return '<div class="builder-header">' +
           '<div class="builder-title">Build / Edit Map</div>' +
           '<div class="builder-step-indicator">' + dots + '</div>' +
           '<button class="builder-close" id="builder-close-button" title="Close (Esc)">×</button>' +
         '</div>';
}

function renderBuilderFooter() {
  const v = validateBuilder();
  const hasErrors = v.errors.length > 0;
  const step = state.builder.step;

  let status = "";
  if (hasErrors) {
    status = '<span class="builder-footer-status warn">' + v.errors.length + ' issue' + (v.errors.length === 1 ? '' : 's') + ' to resolve</span>';
  } else if (state.builder.nodes.length > 0) {
    status = '<span class="builder-footer-status">' + state.builder.nodes.length + ' nodes · ' + state.builder.edges.length + ' edges · ready</span>';
  }

  const backDisabled  = step === 1 ? ' disabled' : '';
  const nextDisabled  = step === 6 ? ' disabled' : '';
  const applyDisabled = hasErrors ? ' disabled' : '';

  return '<div class="builder-footer">' +
           '<button class="builder-action" id="builder-back-button"' + backDisabled + '>← Back</button>' +
           '<button class="builder-action" id="builder-next-button"' + nextDisabled + '>Next →</button>' +
           '<div class="builder-footer-spacer"></div>' +
           status +
           '<button class="builder-action" id="builder-download-button">Download CSV</button>' +
           '<button class="builder-action primary" id="builder-apply-button"' + applyDisabled + '>Apply to map</button>' +
         '</div>';
}

// Inline footer refresh — used after every keystroke in a cell so the
// validation count and Apply button enabled-state stay current, without
// re-rendering the whole panel (which would wipe focus from the cell).
function refreshBuilderFooter() {
  const oldFooter = document.querySelector("#builder-overlay .builder-footer");
  if (!oldFooter) return;
  const wrapper = document.createElement("div");
  wrapper.innerHTML = renderBuilderFooter();
  oldFooter.parentNode.replaceChild(wrapper.firstElementChild, oldFooter);
  wireBuilderFooterButtons();
}

// ───── Step 1: Streams ────────────────────────────────────────────────────
function renderBuilderStreamsStep() {
  const v = validateBuilder();
  let html = "";
  html += '<h2 class="builder-step-heading">Streams — the rows of the map</h2>';
  html += '<p class="builder-step-blurb">Streams are the functional flows or domains running across your map. ' +
          'Each stream becomes a horizontal row. Examples: <i>Operations, Sales, Support</i>, or any grouping that makes sense for your system.</p>';
  html += '<div class="builder-step-help">' +
          '<b>id</b> — short, lowercase, no spaces (e.g. <code>ops</code>). Auto-filled from the label. ' +
          '<b>label</b> — what users see in the sidebar. ' +
          '<b>short</b> — ~6-char uppercase tag on the row header. ' +
          '<b>color</b> — left bar colour on every node in this stream. ' +
          'Drag a row by its <code>⋮⋮</code> handle to reorder.' +
          '</div>';

  html += '<div class="builder-action-bar">';
  html +=   '<button class="builder-action" data-add="streams">+ Add stream</button>';
  if (state.builder.streams.length === 0) {
    html += '<button class="builder-action" id="builder-start-from-sample">Start from sample</button>';
  }
  html += '</div>';

  html += BUILDER_SPLIT;
  html += '<table class="builder-table">';
  html +=   '<thead><tr>' +
              '<th style="width:28px"></th>' +     /* drag handle */
              '<th style="width:120px">ID</th>' +
              '<th>Label</th>' +
              '<th style="width:100px">Short</th>' +
              '<th style="width:80px">Color</th>' +
              '<th style="width:90px"></th>' +
            '</tr></thead><tbody>';

  if (state.builder.streams.length === 0) {
    html += tableEmptyRow(6, 'No streams yet. Click "+ Add stream" to start.');
  } else {
    state.builder.streams.forEach((s, i) => {
      const invalidId = v.dupStreams.has(s.id) || !s.id ? ' invalid' : '';
      html += '<tr draggable="true" data-section="streams" data-index="' + i + '">';
      html +=   rowDragHandleHtml();
      html +=   '<td><input type="text" data-section="streams" data-field="id" data-index="' + i + '" value="' + escapeHtml(s.id) + '" class="' + invalidId + '" placeholder="ops" /></td>';
      html +=   '<td><input type="text" data-section="streams" data-field="label" data-index="' + i + '" value="' + escapeHtml(s.label) + '" placeholder="Operations" /></td>';
      html +=   '<td><input type="text" data-section="streams" data-field="short" data-index="' + i + '" value="' + escapeHtml(s.short) + '" placeholder="OPS" /></td>';
      html +=   '<td><input type="color" data-section="streams" data-field="color" data-index="' + i + '" value="' + escapeHtml(s.color || "#94a3b8") + '" /></td>';
      html +=   rowActionsHtml("streams", i);
      html += '</tr>';
    });
  }

  html += '</tbody></table>';
  return html;
}

// ───── Step 2: Stages ─────────────────────────────────────────────────────
function renderBuilderStagesStep() {
  const v = validateBuilder();
  let html = "";
  html += '<h2 class="builder-step-heading">Stages — the columns of the map</h2>';
  html += '<p class="builder-step-blurb">Stages represent the lifecycle from inputs to outcomes, left-to-right. ' +
          'Examples: <i>Resources, Inputs, Processes, Outcomes</i>. The order you list them is the order ' +
          'they render.</p>';
  html += '<div class="builder-step-help">' +
          '<b>id</b> — lowercase, no spaces (e.g. <code>inputs</code>). Auto-filled. ' +
          '<b>label</b> — column header text on the map. ' +
          'Drag a row by its <code>⋮⋮</code> handle to reorder.' +
          '</div>';

  html += '<div class="builder-action-bar"><button class="builder-action" data-add="stages">+ Add stage</button></div>';

  html += BUILDER_SPLIT;
  html += '<table class="builder-table">';
  html +=   '<thead><tr>' +
              '<th style="width:28px"></th>' +     /* drag handle */
              '<th style="width:200px">ID</th>' +
              '<th>Label</th>' +
              '<th style="width:90px"></th>' +
            '</tr></thead><tbody>';

  if (state.builder.stages.length === 0) {
    html += tableEmptyRow(4, 'No stages yet. Click "+ Add stage".');
  } else {
    state.builder.stages.forEach((s, i) => {
      const invalidId = v.dupStages.has(s.id) || !s.id ? ' invalid' : '';
      html += '<tr draggable="true" data-section="stages" data-index="' + i + '">';
      html +=   rowDragHandleHtml();
      html +=   '<td><input type="text" data-section="stages" data-field="id" data-index="' + i + '" value="' + escapeHtml(s.id) + '" class="' + invalidId + '" placeholder="inputs" /></td>';
      html +=   '<td><input type="text" data-section="stages" data-field="label" data-index="' + i + '" value="' + escapeHtml(s.label) + '" placeholder="Inputs" /></td>';
      html +=   rowActionsHtml("stages", i);
      html += '</tr>';
    });
  }
  html += '</tbody></table>';
  return html;
}

// ───── Step 3: Categories ─────────────────────────────────────────────────
function renderBuilderCategoriesStep() {
  const v = validateBuilder();
  let html = "";
  html += '<h2 class="builder-step-heading">Categories — types of node</h2>';
  html += '<p class="builder-step-blurb">Categories visually distinguish what each node represents. ' +
          'Examples: <i>Resource, Process, Metric, Outcome</i>. Each category has its own colour.</p>';
  html += '<div class="builder-step-help">' +
          '<b>id</b> — lowercase, no spaces. Auto-filled. ' +
          '<b>label</b> — sidebar legend label. ' +
          '<b>color</b> — node fill. ' +
          '<b>text colour</b> — node label colour, pick a high-contrast value vs. the fill. ' +
          'Drag a row by its <code>⋮⋮</code> handle to reorder.' +
          '</div>';

  html += '<div class="builder-action-bar"><button class="builder-action" data-add="categories">+ Add category</button></div>';

  html += BUILDER_SPLIT;
  html += '<table class="builder-table">';
  html +=   '<thead><tr>' +
              '<th style="width:28px"></th>' +     /* drag handle */
              '<th style="width:140px">ID</th>' +
              '<th>Label</th>' +
              '<th style="width:80px">Fill</th>' +
              '<th style="width:80px">Text</th>' +
              '<th style="width:90px"></th>' +
            '</tr></thead><tbody>';

  if (state.builder.categories.length === 0) {
    html += tableEmptyRow(6, 'No categories yet. Click "+ Add category".');
  } else {
    state.builder.categories.forEach((c, i) => {
      const invalidId = v.dupCategories.has(c.id) || !c.id ? ' invalid' : '';
      html += '<tr draggable="true" data-section="categories" data-index="' + i + '">';
      html +=   rowDragHandleHtml();
      html +=   '<td><input type="text" data-section="categories" data-field="id" data-index="' + i + '" value="' + escapeHtml(c.id) + '" class="' + invalidId + '" placeholder="resource" /></td>';
      html +=   '<td><input type="text" data-section="categories" data-field="label" data-index="' + i + '" value="' + escapeHtml(c.label) + '" placeholder="Resource" /></td>';
      html +=   '<td><input type="color" data-section="categories" data-field="color" data-index="' + i + '" value="' + escapeHtml(c.color || "#a3a3a3") + '" /></td>';
      html +=   '<td><input type="color" data-section="categories" data-field="textColor" data-index="' + i + '" value="' + escapeHtml(c.textColor || "#1c1917") + '" /></td>';
      html +=   rowActionsHtml("categories", i);
      html += '</tr>';
    });
  }
  html += '</tbody></table>';
  return html;
}

// ───── Step 4: Nodes ──────────────────────────────────────────────────────
function renderBuilderNodesStep() {
  const v = validateBuilder();
  const streamOptions   = optionList(state.builder.streams.map(s => s.id));
  const stageOptions    = optionList(state.builder.stages.map(s => s.id));
  const categoryOptions = optionList(state.builder.categories.map(c => c.id));

  let html = "";
  html += '<h2 class="builder-step-heading">Nodes — the boxes on the map</h2>';
  html += '<p class="builder-step-blurb">Each node sits at the intersection of one stream (row) and one stage (column), ' +
          'and has one category (colour). The optional fields on the right enable the live Simulation feature.</p>';
  html += '<div class="builder-step-help">' +
          '<b>Required:</b> id, label, stream, stage, category. ' +
          '<b>For simulation</b> add a <b>baseline</b> (e.g. 100) and <b>unit</b> (e.g. <i>units</i>, <i>%</i>, <i>£</i>, or whatever fits). ' +
          'Tick <b>controllable</b> to expose a slider in Simulation mode. ' +
          '<b>direction</b> sets outcome colouring on metric nodes (higher_better / lower_better).' +
          '</div>';

  if (state.builder.streams.length === 0 || state.builder.stages.length === 0 || state.builder.categories.length === 0) {
    html += '<div class="builder-validation errors">' +
              '<div class="builder-validation-title">Setup needed</div>' +
              '<ul>' +
                (state.builder.streams.length    === 0 ? '<li>Go back to Step 1 and add at least one stream.</li>' : '') +
                (state.builder.stages.length     === 0 ? '<li>Go back to Step 2 and add at least one stage.</li>' : '') +
                (state.builder.categories.length === 0 ? '<li>Go back to Step 3 and add at least one category.</li>' : '') +
              '</ul>' +
            '</div>';
  }

  html += '<div class="builder-action-bar"><button class="builder-action" data-add="nodes">+ Add node</button></div>';

  html += BUILDER_SPLIT;
  html += '<table class="builder-table">';
  html +=   '<thead><tr>' +
              '<th style="width:160px">ID</th>' +
              '<th style="width:180px">Label</th>' +
              '<th>Description</th>' +
              '<th style="width:110px">Stream</th>' +
              '<th style="width:110px">Stage</th>' +
              '<th style="width:110px">Category</th>' +
              '<th style="width:90px">Baseline</th>' +
              '<th style="width:90px">Unit</th>' +
              '<th style="width:50px" title="Controllable — show as slider in Simulation mode">Slider</th>' +
              '<th style="width:120px">Direction</th>' +
              '<th style="width:80px">Slider max</th>' +
              '<th style="width:90px"></th>' +
            '</tr></thead><tbody>';

  if (state.builder.nodes.length === 0) {
    html += tableEmptyRow(12, 'No nodes yet. Click "+ Add node".');
  } else {
    state.builder.nodes.forEach((n, i) => {
      const idInvalid       = !n.id || v.dupNodes.has(n.id)   ? ' invalid' : '';
      const streamInvalid   = !v.streamIds.has(n.stream)      ? ' invalid' : '';
      const stageInvalid    = !v.stageIds.has(n.stage)        ? ' invalid' : '';
      const categoryInvalid = !v.categoryIds.has(n.category)  ? ' invalid' : '';

      html += '<tr data-index="' + i + '">';
      html +=   '<td><input type="text" data-section="nodes" data-field="id" data-index="' + i + '" value="' + escapeHtml(n.id) + '" class="' + idInvalid + '" placeholder="team_size" /></td>';
      html +=   '<td><input type="text" data-section="nodes" data-field="label" data-index="' + i + '" value="' + escapeHtml(n.label) + '" placeholder="Team size" /></td>';
      html +=   '<td><input type="text" data-section="nodes" data-field="description" data-index="' + i + '" value="' + escapeHtml(n.description) + '" placeholder="What this node represents" /></td>';
      html +=   '<td><select data-section="nodes" data-field="stream" data-index="' + i + '" class="' + streamInvalid + '"><option value=""></option>' + streamOptions(n.stream) + '</select></td>';
      html +=   '<td><select data-section="nodes" data-field="stage" data-index="' + i + '" class="' + stageInvalid + '"><option value=""></option>' + stageOptions(n.stage) + '</select></td>';
      html +=   '<td><select data-section="nodes" data-field="category" data-index="' + i + '" class="' + categoryInvalid + '"><option value=""></option>' + categoryOptions(n.category) + '</select></td>';
      html +=   '<td><input type="number" step="any" data-section="nodes" data-field="baseline" data-index="' + i + '" value="' + escapeHtml(n.baseline === undefined ? "" : n.baseline) + '" placeholder="100" /></td>';
      html +=   '<td><input type="text" data-section="nodes" data-field="unit" data-index="' + i + '" value="' + escapeHtml(n.unit) + '" placeholder="units" /></td>';
      html +=   '<td style="text-align:center"><input type="checkbox" data-section="nodes" data-field="controllable" data-index="' + i + '"' + (n.controllable ? " checked" : "") + ' /></td>';
      html +=   '<td><select data-section="nodes" data-field="direction" data-index="' + i + '">' +
                  DIRECTION_OPTIONS.map(opt =>
                    '<option value="' + opt + '"' + (opt === (n.direction || "") ? " selected" : "") + '>' + (opt || "—") + '</option>'
                  ).join("") +
                '</select></td>';
      html +=   '<td><input type="number" step="any" data-section="nodes" data-field="sliderMax" data-index="' + i + '" value="' + escapeHtml(n.sliderMax === undefined ? "" : n.sliderMax) + '" placeholder="2.0" /></td>';
      html +=   rowActionsHtml("nodes", i);
      html += '</tr>';
    });
  }
  html += '</tbody></table>';
  return html;
}

// ───── Step 5: Edges ──────────────────────────────────────────────────────
function renderBuilderEdgesStep() {
  const v = validateBuilder();
  const nodeOptions = optionList(state.builder.nodes.map(n => n.id), state.builder.nodes);

  let html = "";
  html += '<h2 class="builder-step-heading">Edges — causal links between nodes</h2>';
  html += '<p class="builder-step-blurb">Each edge goes <b>from</b> a cause <b>to</b> an effect. ' +
          'Pick the effect type — <i>enables</i> (prerequisite), <i>increases</i> (push up), or <i>decreases</i> (push down) — ' +
          'and (optionally) override the elasticity for simulation.</p>';
  html += '<div class="builder-step-help">' +
          '<b>Defaults below</b> — used when the elasticity column is left blank. ' +
          'Elasticity = % change in target value per % change in source value. ' +
          'For <i>decreases</i> effects the default is negative.' +
          '</div>';

  html += '<div class="builder-defaults">' +
            '<label>elasticity_enables<input type="number" step="any" data-default="enables"   value="' + state.builder.defaults.enables   + '" /></label>' +
            '<label>elasticity_increases<input type="number" step="any" data-default="increases" value="' + state.builder.defaults.increases + '" /></label>' +
            '<label>elasticity_decreases<input type="number" step="any" data-default="decreases" value="' + state.builder.defaults.decreases + '" /></label>' +
          '</div>';

  if (state.builder.nodes.length === 0) {
    html += '<div class="builder-validation errors">' +
              '<div class="builder-validation-title">Setup needed</div>' +
              '<ul><li>Go back to Step 4 and add at least one node before defining edges.</li></ul>' +
            '</div>';
  }

  html += '<div class="builder-action-bar"><button class="builder-action" data-add="edges">+ Add edge</button></div>';

  html += BUILDER_SPLIT;
  html += '<table class="builder-table">';
  html +=   '<thead><tr>' +
              '<th style="width:200px">From</th>' +
              '<th style="width:200px">To</th>' +
              '<th style="width:130px">Effect</th>' +
              '<th style="width:110px">Elasticity</th>' +
              '<th>Description</th>' +
              '<th style="width:90px"></th>' +
            '</tr></thead><tbody>';

  if (state.builder.edges.length === 0) {
    html += tableEmptyRow(6, 'No edges yet. Click "+ Add edge".');
  } else {
    state.builder.edges.forEach((e, i) => {
      const fromInvalid = !v.nodeIds.has(e.from) ? ' invalid' : '';
      const toInvalid   = !v.nodeIds.has(e.to)   ? ' invalid' : '';

      html += '<tr data-index="' + i + '">';
      html +=   '<td><select data-section="edges" data-field="from" data-index="' + i + '" class="' + fromInvalid + '"><option value=""></option>' + nodeOptions(e.from) + '</select></td>';
      html +=   '<td><select data-section="edges" data-field="to"   data-index="' + i + '" class="' + toInvalid   + '"><option value=""></option>' + nodeOptions(e.to)   + '</select></td>';
      html +=   '<td><select data-section="edges" data-field="effect" data-index="' + i + '">' +
                  EFFECT_OPTIONS.map(opt =>
                    '<option value="' + opt + '"' + (opt === e.effect ? " selected" : "") + '>' + opt + '</option>'
                  ).join("") +
                '</select></td>';
      html +=   '<td><input type="number" step="any" data-section="edges" data-field="elasticity" data-index="' + i + '" value="' + escapeHtml(e.elasticity === undefined ? "" : e.elasticity) + '" placeholder="(default)" /></td>';
      html +=   '<td><input type="text" data-section="edges" data-field="description" data-index="' + i + '" value="' + escapeHtml(e.description) + '" placeholder="Why this link exists" /></td>';
      html +=   rowActionsHtml("edges", i);
      html += '</tr>';
    });
  }
  html += '</tbody></table>';
  return html;
}

// ───── Step 6: Review ─────────────────────────────────────────────────────
function renderBuilderReviewStep() {
  const v = validateBuilder();
  const b = state.builder;

  let html = "";
  html += '<h2 class="builder-step-heading">Review & finish</h2>';
  html += '<p class="builder-step-blurb">Counts and validation are below. ' +
          '<b>Apply to map</b> loads the data straight into the live app. ' +
          '<b>Download CSV</b> saves a .csv you can drag back in later or share with colleagues.</p>';

  html += BUILDER_SPLIT;
  html += '<div class="builder-review-grid">' +
            reviewTile("Streams",    b.streams.length) +
            reviewTile("Stages",     b.stages.length) +
            reviewTile("Categories", b.categories.length) +
            reviewTile("Nodes",      b.nodes.length) +
            reviewTile("Edges",      b.edges.length) +
          '</div>';

  if (v.errors.length === 0) {
    html += '<div class="builder-validation ok">' +
              '<div class="builder-validation-title">All checks passed</div>' +
              '<ul><li>Ready to apply or download.</li></ul>' +
            '</div>';
  } else {
    html += '<div class="builder-validation errors">' +
              '<div class="builder-validation-title">' + v.errors.length + ' issue' + (v.errors.length === 1 ? '' : 's') + ' to resolve</div>' +
              '<ul>' + v.errors.map(err => '<li>' + escapeHtml(err) + '</li>').join("") + '</ul>' +
            '</div>';
  }

  return html;
}

function reviewTile(label, value) {
  return '<div class="builder-review-tile">' +
           '<div class="builder-review-tile-label">' + escapeHtml(label) + '</div>' +
           '<div class="builder-review-tile-value">' + value + '</div>' +
         '</div>';
}

// Helper: build a closure that returns <option> markup for a list of ids,
// pre-selecting `currentValue`. Optionally accepts a parallel `objects`
// array so options can show the label after the id ("team_size — Team size").
function optionList(ids, objects) {
  return function (currentValue) {
    return ids.map((id, idx) => {
      const display = objects && objects[idx] && objects[idx].label
        ? id + " — " + objects[idx].label
        : id;
      return '<option value="' + escapeHtml(id) + '"' + (id === currentValue ? " selected" : "") + '>' +
             escapeHtml(display) +
             '</option>';
    }).join("");
  };
}
