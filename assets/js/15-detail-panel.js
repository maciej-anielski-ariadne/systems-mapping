// =============================================================================
// RIGHT DETAIL PANEL RENDERING
// -----------------------------------------------------------------------------
// Builds the HTML that appears on the right when a node is selected:
//   • Category / stream / stage tags
//   • Node name + description
//   • Quantification block (baseline / current / delta)
//   • Lists of direct inputs and direct impacts
//   • Counts of full upstream / downstream chain
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

  emptyState.style.display   = "none";
  contentState.style.display = "block";

  const node     = nodeById[state.selectedNodeId];
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
  html +=   '<span class="detail-tag category" style="background: ' + category.color + '; color: ' + category.textColor + ';">' + category.label + '</span>';
  html +=   '<span class="detail-tag">' + stream.label + '</span>';
  html +=   '<span class="detail-tag">' + stage.label + '</span>';
  html += '</div>';

  // ───── Name + description ────────────────────────────────────────────
  html += '<div class="detail-name">' + escapeHtml(node.label) + '</div>';
  html += '<div class="detail-description">' + escapeHtml(node.description || "") + '</div>';

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

  // ───── Direct inputs + impacts lists ────────────────────────────────
  html += renderEdgeList("Direct Inputs",  directInputs,  "from", "No direct inputs (root cause / exogenous resource)");
  html += renderEdgeList("Direct Impacts", directImpacts, "to",   "No direct impacts (terminal outcome)");

  // ───── Full causal chain summary ─────────────────────────────────────
  html += '<div class="detail-list-title"><span>Full Causal Chain</span></div>';
  html += '<div style="font-family: var(--font-mono); font-size: 11px; color: var(--text-secondary); line-height: 1.7;">';
  html +=   '<div><span style="color: var(--edge-ancestor);">●</span> '   + state.ancestorSet.size   + ' upstream ancestor node(s)</div>';
  html +=   '<div><span style="color: var(--edge-descendant);">●</span> ' + state.descendantSet.size + ' downstream impact node(s)</div>';
  html += '</div>';

  contentState.innerHTML = html;

  // Clicking an edge item navigates to that node.
  contentState.querySelectorAll(".detail-edge-item").forEach(item => {
    item.addEventListener("click", () => {
      const targetNodeId = item.getAttribute("data-target-node");
      selectNode(targetNodeId);
      scrollNodeIntoView(targetNodeId);
    });
  });

  // Editable "Current" input in sim mode for controllable nodes.
  // Typing updates state.userOverrides via the shared applySimMultiplier
  // helper from 14-simulation-panel.js, which also syncs the sim panel's
  // slider + value-input. The delta cell is updated inline so the input
  // we're typing into doesn't get wiped by a re-render.
  contentState.querySelectorAll(".detail-value-input").forEach(input => {
    input.addEventListener("input", event => {
      const nodeId = event.target.getAttribute("data-node-id");
      const node = nodeById[nodeId];
      if (!node || !node.baseline) return;
      const raw = parseFloat(event.target.value);
      if (isNaN(raw)) return;
      if (typeof applySimMultiplier === "function") {
        applySimMultiplier(nodeId, raw / node.baseline, event.target);
      }
      if (typeof updateDetailPanelDeltaInline === "function") {
        updateDetailPanelDeltaInline(nodeId);
      }
    });
  });
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
