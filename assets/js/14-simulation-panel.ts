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
import { escapeHtml, formatScalar, formatScalarInput } from "./04-utils";
import { biggestMover, recomputeValues, formatNodeDelta } from "./07-simulation-engine";
import { render, scheduleRender, updateSimulationValuesInPlace } from "./11-rendering";
import { patchDetailPanelValues, renderDetailPanel } from "./15-detail-panel";
import { saveUiStateToStorage, scheduleUiStateSave } from "./04a-storage";
import { renderSidebar } from "./13-sidebar";
import { applyPanelPinnedClasses, setFiltersOpen, setUiMode } from "./17-events";
import { atlasIsOpen, refreshAtlasValues } from "./21-atlas-view";
import { syncReviewRail } from "./25-review-rail";

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
  // "Adjustable boxes", not "adjustable inputs": since the box panel started
  // saying "Driven by", the word "input" was left meaning only one thing — a box
  // you can move — and it is clearer to call that what it is.
  html +=   '<div class="sim-title">Adjustable boxes</div>';
  html +=   '<button class="sim-reset" id="sim-reset-button">Reset</button>';
  html += '</div>';
  // The help line that stood here said what a number field is. The scale note
  // below says what the map's colours currently mean, which changes as you
  // drag — that one is worth its two lines and this one was not.
  // The map's colours are measured against the biggest mover, which changes as
  // you drag — so the scale has to say out loud what its top end currently is,
  // or a colour would mean something different every few seconds with no way to
  // tell. Kept in the DOM and patched inline (updateSimScaleNote) for the same
  // reason the solver badge is: a scrub must not rebuild the panel.
  html += '<div class="sim-scale" id="sim-scale-note"></div>';
  // Placeholder for the feedback-loop non-convergence warning. Kept in the DOM
  // (toggled via updateSimSolverBadge) so slider drags can update it inline
  // without re-rendering the whole panel and stealing focus.
  html += '<div class="sim-solver-badge" id="sim-solver-badge" style="display:none;"></div>';

  for (const stream of STREAMS) {
    const streamNodes = nodesByStream[stream.id];
    if (!streamNodes || streamNodes.length === 0) continue;

    html += '<div class="sim-stream-block">';
    html +=   '<div class="sim-stream-header" style="--stream-color: ' + escapeHtml(stream.color) + ';">' + escapeHtml(stream.label) + '</div>';

    for (const node of streamNodes) {
      const userMultiplier = state.userOverrides[node.id] !== undefined ? state.userOverrides[node.id] : 1.0;
      const currentValue = node.baseline! * userMultiplier;
      const sliderPct = Math.round(userMultiplier * 100);
      const unit = node.unit || "";

      // ONE LINE, and no track. A track spends a whole line on a position you
      // can read off the percentage beside it, and thirty-three of them made
      // this panel two and a bit screens tall. What is left is what the reader
      // actually sets: the figure, and how far it is from where it started.
      //
      // BOTH are editable and both mean the same thing — type 13230 or type
      // 147, whichever you happen to know. Dragging sideways on either scrubs
      // it, so the panel has not lost its drag, only the furniture around it.
      // Both fields carry the box's ceiling as a real `max`. It was already
      // being enforced on the way in — type 300 into a box that stops at 200
      // and the field simply came back 200 — but with nothing declaring the
      // limit, that read as the field refusing what you typed rather than as a
      // limit you had reached. `min` is 0 for the same reason.
      const ceiling = sliderCeiling(node);
      const maxValue = node.baseline! * ceiling;
      const maxPct = Math.round(ceiling * 100);
      const moved = Math.abs(userMultiplier - 1) > 0.0005;
      html += '<div class="sim-slider-row' + (moved ? " moved" : "") + '" data-node-id="' + escapeHtml(node.id) + '">';
      html +=   '<span class="sim-slider-name" title="' + escapeHtml(node.label) + '">' + escapeHtml(node.label) + '</span>';
      html +=   '<input type="number" class="sim-value-input" step="any" min="0" max="' + formatScalarInput(maxValue) + '" value="' + formatScalarInput(currentValue) + '" data-node-id="' + escapeHtml(node.id) + '" aria-label="Value of ' + escapeHtml(node.label) + ' in ' + escapeHtml(unit || "units") + '. Drag sideways or type. Up to ' + formatScalarInput(maxValue) + '." />';
      html +=   '<span class="sim-slider-unit">' + escapeHtml(unit) + '</span>';
      html +=   '<span class="sim-pct-field">';
      html +=     '<input type="number" class="sim-pct-input" step="1" min="0" max="' + maxPct + '" value="' + sliderPct + '" data-node-id="' + escapeHtml(node.id) + '" aria-label="' + escapeHtml(node.label) + ' as a percentage of its starting value. Drag sideways or type. Up to ' + maxPct + '%." />';
      html +=     '<span class="sim-pct-sign">%</span>';
      html +=   '</span>';
      html += '</div>';
    }

    html += '</div>';
  }

  simPanel.innerHTML = html;
  updateSimSolverBadge();
  updateSimScaleNote();

  bindSimPanelHandlers(simPanel);
}

// ───── Delegated panel handlers — bound ONCE, never per render ────────────
// The panel's innerHTML is rebuilt whenever the map or the mode changes, so
// per-slider listeners meant one addEventListener per control per rebuild (two
// per adjustable box) and a fresh closure each time. The panel element itself is
// stable, so one listener set on it handles every row, for every rebuild, and
// dispatches on the target's class.
//
// The guard remembers the ELEMENT rather than a bare "done" flag. Both say
// "bind once" for the panel we have, but a boolean also says it about a panel
// we have never seen: if anything ever replaces #simulation-panel, a flag would
// leave the new element with no listeners at all — every slider and the Reset
// button dead, silently, with nothing thrown to notice it by.
let boundSimPanel: HTMLElement | null = null;

function bindSimPanelHandlers(simPanel: HTMLElement): void {
  if (boundSimPanel === simPanel) return;
  boundSimPanel = simPanel;

  // Drag / type: write the override now, solve and repaint once per frame.
  simPanel.addEventListener("input", event => {
    const target = event.target as HTMLInputElement;
    if (!target || !target.classList) return;
    const nodeId = target.getAttribute("data-node-id");
    if (!nodeId) return;

    if (target.classList.contains("sim-value-input")) {
      const node = nodeById[nodeId];
      if (!node || !node.baseline) return;
      const raw = parseFloat(target.value);
      if (isNaN(raw)) return;
      scheduleSimTick(nodeId, raw / node.baseline, target);
    } else if (target.classList.contains("sim-pct-input")) {
      // The same setting, said the other way. 100 is where the box started.
      const pct = parseFloat(target.value);
      if (isNaN(pct)) return;
      scheduleSimTick(nodeId, pct / 100, target);
    }
  });

  // Commit (mouse released on a slider, focus left a typed value): drain any
  // frame still owed, then give the detail panel one full, unpatched render so
  // anything the scrub patch skipped is definitely right.
  simPanel.addEventListener("change", event => {
    const target = event.target as HTMLInputElement;
    if (!target || !target.classList) return;
    if (!target.classList.contains("sim-value-input") && !target.classList.contains("sim-pct-input")) return;
    flushSimTick();
    renderDetailPanel();
    saveUiStateToStorage();
  });

  // ───── Dragging, without a track ─────────────────────────────────────
  // Taking the track away would have taken the drag with it, and dragging is
  // how a reader sweeps a value to see what happens rather than deciding a
  // figure in advance. So the NUMBER is the track: press it and move sideways
  // and it scrubs, one percent of the starting value per pixel.
  //
  // A press that never moves is left alone, so clicking still puts a caret in
  // the field and typing still works. Three pixels is the threshold — below
  // that a click is a click, however unsteady the hand.
  let scrub: {
    input: HTMLInputElement; nodeId: string; startX: number; from: number; live: boolean;
  } | null = null;

  const scrubbable = (el: Element | null): el is HTMLInputElement =>
    !!el && !!(el as HTMLElement).classList && (
      (el as HTMLElement).classList.contains("sim-value-input") ||
      (el as HTMLElement).classList.contains("sim-pct-input"));

  simPanel.addEventListener("pointerdown", event => {
    const target = (event as PointerEvent).target as Element;
    if (!scrubbable(target)) return;
    const nodeId = target.getAttribute("data-node-id");
    if (!nodeId) return;
    scrub = {
      input: target,
      nodeId: nodeId,
      startX: (event as PointerEvent).clientX,
      from: state.userOverrides[nodeId] !== undefined ? state.userOverrides[nodeId] : 1,
      live: false,
    };
  });

  simPanel.addEventListener("pointermove", event => {
    if (!scrub) return;
    const dx = (event as PointerEvent).clientX - scrub.startX;
    if (!scrub.live) {
      if (Math.abs(dx) < 3) return;
      scrub.live = true;
      // The caret would otherwise sit blinking in a field being dragged, and
      // the drag would select its text.
      scrub.input.blur();
      document.body.classList.add("sim-scrubbing");
      try { scrub.input.setPointerCapture((event as PointerEvent).pointerId); } catch { /* not captured, still works */ }
    }
    event.preventDefault();
    // Never below zero: a negative multiple of a starting value is not a thing
    // the map can mean.
    const next = Math.max(0, scrub.from + dx * 0.01);
    // No origin element: both fields on the row should follow the drag, since
    // neither is being typed into.
    scheduleSimTick(scrub.nodeId, next, null);
  });

  const endScrub = () => {
    if (!scrub) return;
    const wasLive = scrub.live;
    scrub = null;
    document.body.classList.remove("sim-scrubbing");
    if (!wasLive) return;      // a plain click: leave the field to focus itself
    flushSimTick();
    renderDetailPanel();
    saveUiStateToStorage();
  };
  simPanel.addEventListener("pointerup", endScrub);
  simPanel.addEventListener("pointercancel", endScrub);

  simPanel.addEventListener("click", event => {
    const target = event.target as Element;
    if (!target || typeof target.closest !== "function") return;
    if (!target.closest("#sim-reset-button")) return;
    resetSimulation();
  });
}

export function resetSimulation(): void {
  cancelSimTick();
  state.userOverrides = {};
  recomputeValues();
  renderSimulationPanel();
  render();
  renderDetailPanel();
  saveUiStateToStorage();
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

// The ceiling can never sit below 100%. `slider_max` is a multiple of the
// starting value, and one under 1 made the box's own starting value
// unreachable: nudging the slider clamped it DOWN, and typing 100 back in
// clamped it down again, so a single touch left the box — and everything
// downstream of it — stuck below where it started with no way back but Reset.
// The loader rejects such a value outright; this is the second line of defence,
// since sliderMax is also editable field-by-field in the detail panel.
export function sliderCeiling(node: GraphNode): number {
  return Math.max(1, node.sliderMax || 2.0);
}

function clampMultiplier(node: GraphNode, newMultiplier: number): number {
  return Math.max(0, Math.min(newMultiplier, sliderCeiling(node)));
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
  updateSimScaleNote();
  // Patch the changed values straight into the existing node DOM. Only when that
  // can't apply cleanly (a delta label must appear or disappear) do we fall back
  // to a coalesced full render.
  if (!updateSimulationValuesInPlace()) scheduleRender();
  // The atlas, if it is open, is looking at the same numbers.
  if (typeof atlasIsOpen === "function" && atlasIsOpen()) refreshAtlasValues();
}

// What the colours on the map currently mean. Full colour is the biggest mover
// in this run, so naming it is what stops a relative scale from being a lie:
// a pale map reads as "nothing moved much" rather than as a broken one.
export function updateSimScaleNote(): void {
  const note = document.getElementById("sim-scale-note");
  if (!note) return;
  const top = biggestMover();
  if (!top) {
    note.innerHTML = "Boxes are grey until they move. Nothing has moved yet.";
    return;
  }
  const delta = formatNodeDelta(top.node.id);
  note.innerHTML =
    'Box colour is what this run did: <b class="good">better</b>, <b class="bad">worse</b>, ' +
    '<b class="none">moved</b>, grey has not moved. Full colour is the biggest mover — ' +
    '<b>' + escapeHtml(top.node.label) + ' ' + escapeHtml(delta.text) + '</b>.';
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

  // Two ways of saying one number, so each follows the other — except the one
  // being typed into, which is left alone mid-keystroke.
  const valueInput = row.querySelector(".sim-value-input") as HTMLInputElement | null;
  if (valueInput && valueInput !== originElement) valueInput.value = formatScalarInput(currentValue);

  const pctInput = row.querySelector(".sim-pct-input") as HTMLInputElement | null;
  if (pctInput && pctInput !== originElement) pctInput.value = String(Math.round(multiplier * 100));

  row.classList.toggle("moved", Math.abs(multiplier - 1) > 0.0005);
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
        else                                         deltaColor = "var(--accent-amber)";
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
  // Editing changes the model; simulation changes inputs to that model. They
  // use the same canvas controls for different jobs, so entering simulation
  // finishes editing first rather than leaving two active modes behind one
  // toolbar.
  if (!state.simulationMode && state.uiMode === "edit") setUiMode("read");
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
  // Same reason as the mode switch in 17-events' applyUiMode: the rail is a
  // reading-mode surface, and simulation docks the left panel where it lives.
  syncReviewRail();
  if (typeof atlasIsOpen === "function" && atlasIsOpen()) refreshAtlasValues();
  renderSidebar();
  render();
  renderDetailPanel();
  saveUiStateToStorage();
}

const toolbarSimulationResetButton = document.getElementById("toolbar-sim-reset");
if (toolbarSimulationResetButton) toolbarSimulationResetButton.addEventListener("click", resetSimulation);

const simulationExitButton = document.getElementById("simulation-exit-button");
if (simulationExitButton) {
  simulationExitButton.addEventListener("click", () => {
    if (state.simulationMode) toggleSimulationMode();
  });
}
