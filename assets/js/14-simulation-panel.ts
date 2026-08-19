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
import { render, scheduleRender, updateSimulationValuesInPlace } from "./11-rendering";
import { patchDetailPanelValues, renderDetailPanel } from "./15-detail-panel";
import { saveUiStateToStorage, scheduleUiStateSave } from "./04a-storage";
import { renderSidebar } from "./13-sidebar";
import { applyPanelPinnedClasses, setFiltersOpen } from "./17-events";
import { atlasIsOpen, refreshAtlasValues } from "./21-atlas-view";

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

  bindSimPanelHandlers(simPanel);
}

// ───── Delegated panel handlers — bound ONCE, never per render ────────────
// The panel's innerHTML is rebuilt whenever the map or the mode changes, so
// per-slider listeners meant one addEventListener per control per rebuild (two
// per adjustable box) and a fresh closure each time. The panel element itself is
// stable, so one listener set on it handles every row, for every rebuild, and
// dispatches on the target's class.
let simPanelHandlersBound = false;

function bindSimPanelHandlers(simPanel: HTMLElement): void {
  if (simPanelHandlersBound) return;
  simPanelHandlersBound = true;

  // Drag / type: write the override now, solve and repaint once per frame.
  simPanel.addEventListener("input", event => {
    const target = event.target as HTMLInputElement;
    if (!target || !target.classList) return;
    const nodeId = target.getAttribute("data-node-id");
    if (!nodeId) return;

    if (target.classList.contains("sim-slider")) {
      const newMultiplier = parseFloat(target.value);
      if (isNaN(newMultiplier)) return;
      scheduleSimTick(nodeId, newMultiplier, target);
    } else if (target.classList.contains("sim-value-input")) {
      const node = nodeById[nodeId];
      if (!node || !node.baseline) return;
      const raw = parseFloat(target.value);
      if (isNaN(raw)) return;
      scheduleSimTick(nodeId, raw / node.baseline, target);
    }
  });

  // Commit (mouse released on a slider, focus left a typed value): drain any
  // frame still owed, then give the detail panel one full, unpatched render so
  // anything the scrub patch skipped is definitely right.
  simPanel.addEventListener("change", event => {
    const target = event.target as HTMLInputElement;
    if (!target || !target.classList) return;
    if (!target.classList.contains("sim-slider") && !target.classList.contains("sim-value-input")) return;
    flushSimTick();
    renderDetailPanel();
    saveUiStateToStorage();
  });

  simPanel.addEventListener("click", event => {
    const target = event.target as Element;
    if (!target || typeof target.closest !== "function") return;
    if (!target.closest("#sim-reset-button")) return;
    cancelSimTick();
    state.userOverrides = {};
    recomputeValues();
    renderSimulationPanel();
    render();
    renderDetailPanel();
    saveUiStateToStorage();
  });
}

// ───── One solve + repaint per animation frame ────────────────────────────
// A slider fires `input` at 100-240 Hz on a modern pointer. Solving and
// repainting inside every one of those events means most of the work lands on
// frames the browser never gets to draw. Instead the handler writes the override
// immediately (so state is never behind the widget) and asks for a tick; the
// tick runs once per frame, no matter how many events arrived.
//
// Anything that needs the update to have happened ALREADY — a test, a commit
// handler, a mode change — calls flushSimTick() to drain it synchronously.
interface PendingSimTick {
  nodeId: string;
  origin: Element | null;
}

let pendingSimTick: PendingSimTick | null = null;
let pendingFrameHandle: number | null = null;

function requestFrame(callback: () => void): number {
  if (typeof requestAnimationFrame === "function") return requestAnimationFrame(callback);
  return setTimeout(callback, 16) as unknown as number;
}

function cancelFrame(handle: number): void {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle);
  else clearTimeout(handle);
}

// Write the override straight away, and queue the solve + repaint for the next
// frame. Later calls in the same frame replace the queued one.
export function scheduleSimTick(nodeId: string, newMultiplier: number, originElement: Element | null): void {
  const node = nodeById[nodeId];
  if (!node || !node.baseline) return;
  state.userOverrides[nodeId] = clampMultiplier(node, newMultiplier);
  pendingSimTick = { nodeId: nodeId, origin: originElement };
  if (pendingFrameHandle === null) pendingFrameHandle = requestFrame(runSimTick);
}

// Run any owed tick right now. Safe (and free) to call when nothing is pending.
export function flushSimTick(): void {
  if (pendingFrameHandle !== null) {
    cancelFrame(pendingFrameHandle);
    pendingFrameHandle = null;
  }
  runSimTick();
}

// Drop an owed tick without running it — used when the whole panel is about to
// be rebuilt from scratch anyway (Reset).
function cancelSimTick(): void {
  if (pendingFrameHandle !== null) {
    cancelFrame(pendingFrameHandle);
    pendingFrameHandle = null;
  }
  pendingSimTick = null;
}

function runSimTick(): void {
  pendingFrameHandle = null;
  const tick = pendingSimTick;
  if (!tick) return;
  pendingSimTick = null;

  applySimUpdate(tick.nodeId, tick.origin);
  // A scrub patches the detail panel's numbers in place; the drag-end `change`
  // event above gives it a full render.
  maybeRefreshDetailPanel(tick.nodeId, { scrub: true });
  scheduleUiStateSave();
}

function clampMultiplier(node: GraphNode, newMultiplier: number): number {
  const sliderMax = node.sliderMax || 2.0;
  return Math.max(0, Math.min(newMultiplier, sliderMax));
}

// ───── Shared multiplier-apply (called by sim panel + detail panel) ──────
// Updates state, recomputes downstream values, syncs the other widgets in
// the sim panel inline (preserving focus on the source), and re-renders the
// SVG. Does NOT call renderDetailPanel — see maybeRefreshDetailPanel.
export function applySimMultiplier(nodeId: string, newMultiplier: number, originElement: Element | null): void {
  const node = nodeById[nodeId];
  if (!node || !node.baseline) return;
  state.userOverrides[nodeId] = clampMultiplier(node, newMultiplier);
  // Called directly (the detail panel's Current field, a test), so it is
  // synchronous by contract: the DOM reflects the new value the moment it
  // returns. Only the panel's own high-rate `input` events are coalesced, and a
  // tick they left owed is superseded by the solve we are about to run.
  pendingSimTick = null;
  applySimUpdate(nodeId, originElement);
  // Slider drags fire this at pointer-move rate; the debounced saver writes
  // once when the drag goes quiet instead of per event.
  scheduleUiStateSave();
}

// Solve, then repaint: the shared body of a direct call and a coalesced tick.
function applySimUpdate(nodeId: string, originElement: Element | null): void {
  recomputeValues();
  syncSimRow(nodeId, originElement);
  updateSimSolverBadge();
  // Patch the changed values straight into the existing node DOM. Only when that
  // can't apply cleanly (a delta label must appear or disappear) do we fall back
  // to a coalesced full render.
  if (!updateSimulationValuesInPlace()) scheduleRender();
  // The atlas, if it is open, is looking at the same numbers.
  if (typeof atlasIsOpen === "function" && atlasIsOpen()) refreshAtlasValues();
}

// Show or hide the feedback-loop warning in the sim panel. The simulation works
// by recalculating values over and over until they stop changing ("converge").
// If a loop amplifies itself each time round — its "gain" is 1 or more (see
// docs/GLOSSARY.md) — the values never settle and grow without limit, so the
// solver gives up and reports `converged: false`. We cap those values so the UI
// doesn't show infinity, but they shouldn't be trusted. Dragging a slider is the
// most likely way a user pushes a loop into that runaway state, so we surface
// the warning right here, inline.
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
export function maybeRefreshDetailPanel(changedNodeId: string, options?: { scrub?: boolean }): void {
  const active = document.activeElement;
  const detailInputActive = active && active.classList && active.classList.contains("detail-value-input");
  if (detailInputActive) {
    updateDetailPanelDeltaInline(changedNodeId);
    return;
  }
  // Mid-scrub, rebuilding the whole panel (re-running every field, every
  // handler and every dropdown upgrade) for a set of numbers that changed by a
  // fraction of a percent is the single most expensive thing a slider frame can
  // do. Patch the numbers instead, and fall back to a full render the moment the
  // panel's SHAPE would differ (a clamp notice appearing, a different input
  // gating a min rule, the rule itself changing).
  if (options && options.scrub && patchDetailPanelValues()) return;
  renderDetailPanel();
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
  // Everything below re-renders from scratch, so an owed slider tick has nothing
  // left to contribute.
  cancelSimTick();
  state.simulationMode = !state.simulationMode;

  const button = document.getElementById("sim-toggle-button");
  if (button) {
    button.classList.toggle("active", state.simulationMode);
    button.textContent = state.simulationMode ? "Exit sim" : "Simulate";
  }

  // The sliders ARE the left panel, so entering simulation has to bring it
  // out: pinned open while editing (leaving the pin choice alone on exit),
  // and docked rather than drawered while reading — you work the sliders
  // against the map, and a drawer that closes when you click the map would
  // take them away every time you looked at what moved. The docking is CSS
  // off body.sim-mode; what's needed here is to make sure no half-open
  // drawer is left over it.
  if (state.simulationMode && !state.sidebarPinned) {
    state.sidebarPinned = true;
    if (typeof applyPanelPinnedClasses === "function") applyPanelPinnedClasses();
  }
  if (state.simulationMode && typeof setFiltersOpen === "function") setFiltersOpen(false);

  document.body.classList.toggle("sim-mode", state.simulationMode);
  if (typeof atlasIsOpen === "function" && atlasIsOpen()) refreshAtlasValues();
  renderSidebar();
  render();
  renderDetailPanel();
  saveUiStateToStorage();
}
