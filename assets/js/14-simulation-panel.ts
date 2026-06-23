// =============================================================================
// SIMULATION PANEL — sliders + typeable inputs for what-if analysis
// -----------------------------------------------------------------------------
// Renders one slider per controllable input node into the left sidebar, with
// an editable number input alongside it so users can either drag the slider
// or type an exact value.
//
// Both controls update the SAME state.userOverrides[nodeId] multiplier, and
// each updates the other inline (without re-rendering the panel) so focus
// is preserved while typing/dragging.
//
// The detail panel's "Current" row is also editable for controllable nodes
// in sim mode — see 15-detail-panel.js. It calls applySimMultiplier() here.
// =============================================================================

import type { GraphNode } from "./types";
import { state, NODES, STREAMS, nodeById } from "./03-state";
import { escapeHtml, formatScalar } from "./04-utils";
import { recomputeValues, formatNodeDelta } from "./07-simulation-engine";
import { render, scheduleRender } from "./11-rendering";
import { renderDetailPanel } from "./15-detail-panel";
import { saveUiStateToStorage } from "./04a-storage";
import { renderSidebar } from "./13-sidebar";
import { applyPanelPinnedClasses } from "./17-events";

export function renderSimulationPanel(): void {
  const simPanel = document.getElementById("simulation-panel");
  if (!simPanel) return;

  if (!state.simulationMode) {
    simPanel.style.display = "none";
    return;
  }
  simPanel.style.display = "block";

  // Group the controllable input nodes by stream so the sliders are organised.
  const controllableNodes = NODES.filter(n => n.controllable);
  const nodesByStream: Record<string, GraphNode[]> = {};
  for (const stream of STREAMS) nodesByStream[stream.id] = [];
  for (const node of controllableNodes) {
    if (nodesByStream[node.stream]) nodesByStream[node.stream].push(node);
  }

  // ───── Build the HTML ─────────────────────────────────────────────────
  let html = "";
  html += '<div class="sim-header">';
  html +=   '<div class="sim-title">Adjustable inputs</div>';
  html +=   '<button class="sim-reset" id="sim-reset-button">Reset</button>';
  html += '</div>';
  html += '<div class="sim-help">Drag a slider or type a value. Its effects update live.</div>';
  // Placeholder for the feedback-loop non-convergence warning. Kept in the DOM
  // (toggled via updateSimSolverBadge) so slider drags can update it inline
  // without re-rendering the whole panel and stealing focus.
  html += '<div class="sim-solver-badge" id="sim-solver-badge" style="display:none;"></div>';

  for (const stream of STREAMS) {
    const streamNodes = nodesByStream[stream.id];
    if (!streamNodes || streamNodes.length === 0) continue;

    html += '<div class="sim-stream-block">';
    html +=   '<div class="sim-stream-header" style="--stream-color: ' + stream.color + ';">' + escapeHtml(stream.label) + '</div>';

    for (const node of streamNodes) {
      const userMultiplier = state.userOverrides[node.id] !== undefined ? state.userOverrides[node.id] : 1.0;
      const currentValue = node.baseline! * userMultiplier;
      const sliderMax = node.sliderMax || 2.0;
      const sliderStep = 0.01;
      const sliderPct = Math.round(userMultiplier * 100);
      const unit = node.unit || "";

      html += '<div class="sim-slider-row" data-node-id="' + node.id + '">';
      html +=   '<div class="sim-slider-label">';
      html +=     '<span class="sim-slider-name">' + escapeHtml(node.label) + '</span>';
      html +=     '<span class="sim-slider-readout">';
      html +=       '<input type="number" class="sim-value-input" step="any" value="' + formatScalar(currentValue) + '" data-node-id="' + node.id + '" aria-label="Current value of ' + escapeHtml(node.label) + '" />';
      if (unit) html += ' <span class="sim-slider-unit">' + escapeHtml(unit) + '</span>';
      html +=     ' <span class="sim-slider-pct">(' + sliderPct + '%)</span>';
      html +=     '</span>';
      html +=   '</div>';
      html +=   '<input type="range" class="sim-slider" min="0" max="' + sliderMax + '" step="' + sliderStep + '" value="' + userMultiplier + '" data-node-id="' + node.id + '" />';
      html += '</div>';
    }

    html += '</div>';
  }

  simPanel.innerHTML = html;
  updateSimSolverBadge();

  // ───── Wire up the slider + the number input ──────────────────────────
  // Both call applySimMultiplier — only the source field is excluded from
  // the inline sync so we don't fight the user's input.
  simPanel.querySelectorAll(".sim-slider").forEach(slider => {
    slider.addEventListener("input", event => {
      const target = event.target as HTMLInputElement;
      const nodeId = target.getAttribute("data-node-id")!;
      const newMultiplier = parseFloat(target.value);
      if (isNaN(newMultiplier)) return;
      applySimMultiplier(nodeId, newMultiplier, target);
      maybeRefreshDetailPanel(nodeId);
    });
  });
  simPanel.querySelectorAll(".sim-value-input").forEach(input => {
    input.addEventListener("input", event => {
      const target = event.target as HTMLInputElement;
      const nodeId = target.getAttribute("data-node-id")!;
      const node = nodeById[nodeId];
      if (!node || !node.baseline) return;
      const raw = parseFloat(target.value);
      if (isNaN(raw)) return;
      applySimMultiplier(nodeId, raw / node.baseline, target);
      maybeRefreshDetailPanel(nodeId);
    });
  });

  // ───── Wire up reset button ───────────────────────────────────────────
  const resetButton = document.getElementById("sim-reset-button");
  if (resetButton) {
    resetButton.addEventListener("click", () => {
      state.userOverrides = {};
      recomputeValues();
      renderSimulationPanel();
      render();
      renderDetailPanel();
      saveUiStateToStorage();
    });
  }
}

// ───── Shared multiplier-apply (called by sim panel + detail panel) ──────
// Updates state, recomputes downstream values, syncs the other widgets in
// the sim panel inline (preserving focus on the source), and re-renders the
// SVG. Does NOT call renderDetailPanel — see maybeRefreshDetailPanel.
export function applySimMultiplier(nodeId: string, newMultiplier: number, originElement: Element | null): void {
  if (!nodeById[nodeId]) return;
  const node = nodeById[nodeId];
  if (!node.baseline) return;
  const sliderMax = node.sliderMax || 2.0;
  const clamped = Math.max(0, Math.min(newMultiplier, sliderMax));
  state.userOverrides[nodeId] = clamped;
  recomputeValues();
  syncSimRow(nodeId, originElement);
  updateSimSolverBadge();
  scheduleRender();   // coalesce rapid slider-input rebuilds to one per frame
  saveUiStateToStorage();
}

// Show or hide the feedback-loop warning in the sim panel. A non-converged
// solver run means a positive loop ran away (gain ≥ 1); its values are clamped
// but shouldn't be trusted. Dragging a slider is the most likely way a user
// pushes a loop into that regime, so we surface it right here, inline.
export function updateSimSolverBadge(): void {
  const badge = document.getElementById("sim-solver-badge");
  if (!badge) return;
  if (state.solverStatus && !state.solverStatus.converged) {
    badge.textContent = "⚠ A feedback loop did not settle — values capped. Lower the strength on the loop's links.";
    badge.style.display = "block";
  } else {
    badge.style.display = "none";
  }
}

// Update the sim panel's slider + value-input + pct for one row inline,
// skipping whichever element originated the change so we don't overwrite
// what the user is typing.
export function syncSimRow(nodeId: string, originElement: Element | null): void {
  const row = document.querySelector('.sim-slider-row[data-node-id="' + nodeId + '"]');
  if (!row) return;
  const node = nodeById[nodeId];
  if (!node) return;
  const multiplier = state.userOverrides[nodeId] !== undefined ? state.userOverrides[nodeId] : 1.0;
  const currentValue = node.baseline! * multiplier;

  const slider = row.querySelector(".sim-slider") as HTMLInputElement | null;
  if (slider && slider !== originElement) slider.value = String(multiplier);

  const valueInput = row.querySelector(".sim-value-input") as HTMLInputElement | null;
  if (valueInput && valueInput !== originElement) valueInput.value = formatScalar(currentValue);

  const pctEl = row.querySelector(".sim-slider-pct");
  if (pctEl) pctEl.textContent = "(" + Math.round(multiplier * 100) + "%)";
}

// Refresh the detail panel after a sim change — but only when the user
// isn't currently typing into the detail-panel's own value input (which
// would wipe their input and lose focus). For that case, update the delta
// display inline instead.
export function maybeRefreshDetailPanel(changedNodeId: string): void {
  const active = document.activeElement;
  const detailInputActive = active && active.classList && active.classList.contains("detail-value-input");
  if (detailInputActive) {
    updateDetailPanelDeltaInline(changedNodeId);
  } else {
    renderDetailPanel();
  }
}

// Inline-update the "Current" + "Δ vs baseline" cells in the detail panel
// for the currently-selected node, without re-rendering. Used while the
// user is typing into the detail panel's own input.
export function updateDetailPanelDeltaInline(changedNodeId: string): void {
  // Only the selected node's display is relevant.
  if (!state.selectedNodeId) return;
  const selectedId = state.selectedNodeId;
  const block = document.querySelector("#detail-content .detail-quant-block");
  if (!block) return;
  const node = nodeById[selectedId];
  if (!node || node.baseline === undefined) return;

  const unit = node.unit || "";
  const value = state.computedValues[selectedId];
  const delta = formatNodeDelta(selectedId);

  // The "Current" row label is the second row; the value cell is the input
  // if controllable & in sim, otherwise plain text. We just update the
  // delta cell which is always plain text. (Don't touch the input.)
  const rows = block.querySelectorAll(".detail-quant-row");
  // Layout: 0=Baseline, 1=Current, 2=Δ vs baseline.
  if (rows[2]) {
    const valueCell = rows[2].querySelector(".detail-quant-value") as HTMLElement | null;
    if (valueCell) {
      valueCell.textContent = delta.text || "—";
      // Re-colour the delta — same logic as in renderDetailPanel.
      let deltaColor = "var(--text-secondary)";
      if (Math.abs(delta.pct) >= 0.5) {
        if      (node.direction === "higher_better") deltaColor = delta.pct > 0 ? "var(--status-good)" : "var(--status-bad)";
        else if (node.direction === "lower_better")  deltaColor = delta.pct < 0 ? "var(--status-good)" : "var(--status-bad)";
        else                                         deltaColor = delta.pct > 0 ? "var(--accent-blue)" : "var(--accent-orange)";
      }
      valueCell.style.color = deltaColor;
    }
  }
  // If the selected node is NOT the changed node (i.e. it's a downstream
  // node), also update the "Current" cell's text display.
  if (selectedId !== changedNodeId && rows[1]) {
    const cell = rows[1].querySelector(".detail-quant-value") as HTMLElement | null;
    if (cell && !cell.querySelector("input")) {
      cell.textContent = (value !== undefined ? formatScalar(value) + " " + unit : "—");
    }
  }
}

// Flip simulation mode on/off and refresh everything that depends on it.
export function toggleSimulationMode(): void {
  state.simulationMode = !state.simulationMode;

  const button = document.getElementById("sim-toggle-button");
  if (button) {
    button.classList.toggle("active", state.simulationMode);
    button.textContent = state.simulationMode ? "Exit sim" : "Simulate";
  }

  // Pin the sidebar on entry so the user can see the sliders without
  // hovering. Leaves their pin choice alone on exit.
  if (state.simulationMode && !state.sidebarPinned) {
    state.sidebarPinned = true;
    if (typeof applyPanelPinnedClasses === "function") applyPanelPinnedClasses();
  }

  document.body.classList.toggle("sim-mode", state.simulationMode);
  renderSidebar();
  render();
  renderDetailPanel();
  saveUiStateToStorage();
}
