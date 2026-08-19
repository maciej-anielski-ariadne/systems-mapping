// =============================================================================
// PATHWAY MODE — the user interface
// -----------------------------------------------------------------------------
// Three surfaces, all reading from `state.pathway` and all rendered by
// renderPathwayUi() so they can never disagree with each other:
//
//   • The sidebar block — pick two boxes, trace, then flip through the
//     alternative routes between them.
//   • The chip floating over the map — which route is on screen, how many
//     exist, and the controls to cycle or straighten.
//   • The straightened view — the same strand as one left-to-right line, with
//     each link spelled out and the whole chain written as a sentence.
//
// The graph work is all in 09a-pathways.ts; this file only draws it and turns
// clicks into the state transitions that module exports.
//
// A note on the copy. Every count here is exact, including the ones that make
// the feature look worse ("10 shown · 340 exist"). A reading aid that quietly
// drops most of the answer is worse than no reading aid, because you can't tell
// which one you're using.
// =============================================================================

import type { PathwayRoute } from "./types";
import { NODES, STREAMS, edgeById, nodeById, setLayout, state, stageById, streamById } from "./03-state";
import { escapeHtml } from "./04-utils";
import { upgradeSelectsIn } from "./04b-typeable-dropdown";
import {
  clearPathway,
  currentRoute,
  findRoutes,
  pathwayActive,
  pathwayReopenedFilters,
  selectRoute,
  setPathwayView,
  showRoute,
  signFlipCount,
  startPathway,
  stepRoute,
  streamsCrossed,
} from "./09a-pathways";
import { resolveEdgeElasticity, formatNodeValue } from "./07-simulation-engine";
import { computeLayout } from "./08-layout";
import { dataRevision } from "./06-data-loader";
import { render } from "./11-rendering";
import { renderSidebar } from "./13-sidebar";
import { renderDetailPanel } from "./15-detail-panel";
import { scrollNodeIntoView } from "./09-graph-selection";

// Present-tense verb for each link type, used in the straightened view's
// sentence. The map's own vocabulary — not a new one.
const EFFECT_VERB: Record<string, string> = {
  increases: "increases",
  decreases: "decreases",
  enables:   "enables",
};

// A "no route" notice the user hasn't dismissed yet. Transient and local: it
// belongs to this panel, not to the map's state.
let _notice: { text: string; swapTo?: { fromId: string; toId: string } } | null = null;

// ───── Small formatting helpers ───────────────────────────────────────────

const nodeLabel = (id: string): string => (nodeById[id] && nodeById[id].label) || id;

// Strength runs small on a long chain (five links at 0.5 each is 0.03), so
// three decimals is the readable floor. Anything smaller reads as "≈0" —
// which is itself the useful fact: cause does not survive that trip.
function formatStrength(value: number): string {
  if (value >= 0.0005) return value.toFixed(3);
  return "≈0";
}

// Total-routes text, honest about a truncated search. "47+" means the search
// hit its budget, so 47 is a floor rather than the count.
function totalText(): string {
  const p = state.pathway;
  return p.totalRoutes + (p.truncated ? "+" : "");
}

// ───── Route rows (shared by the alternatives list and the suggestions) ────

function routeRowHtml(route: PathwayRoute, index: number, current: boolean): string {
  const ids = route.nodeIds;
  const first = escapeHtml(nodeLabel(ids[0]));
  const last  = escapeHtml(nodeLabel(ids[ids.length - 1]));
  const via   = ids.slice(1, -1).map(id => escapeHtml(nodeLabel(id))).join(" → ");
  const hops  = ids.length - 1;

  let chain = '<span class="pathway-chain">' + first;
  if (via) chain += '<span class="via"> → ' + via + '</span>';
  chain += " → " + last + "</span>";

  // Bar width is capped rather than normalised against the strongest route:
  // an absolute scale means the bar means the same thing between one trace and
  // the next, which matters more here than filling the row.
  const barPct = Math.max(3, Math.min(100, route.strength * 400));
  const netClass = route.sign > 0 ? "pathway-net--up" : "pathway-net--down";
  const netText  = route.sign > 0 ? "↑ net" : "↓ net";

  return (
    '<button class="pathway-route" data-pathway-row="route" data-index="' + index + '"' +
    (current ? ' aria-current="true"' : "") + ">" +
    chain +
    '<span class="pathway-meta">' +
      "<span>" + hops + " hop" + (hops === 1 ? "" : "s") + "</span>" +
      '<span class="pathway-net ' + netClass + '">' + netText + "</span>" +
      '<span class="pathway-strength"><i style="width:' + barPct.toFixed(1) + '%"></i></span>' +
      "<span>" + formatStrength(route.strength) + "</span>" +
    "</span>" +
    "</button>"
  );
}

// ───── The sidebar block ──────────────────────────────────────────────────

function boxOptionsHtml(selectedId: string | null): string {
  let html = "";
  for (const stream of STREAMS) {
    const inStream = NODES.filter(n => n.stream === stream.id);
    if (!inStream.length) continue;
    html += '<optgroup label="' + escapeHtml(stream.label) + '">';
    for (const node of inStream) {
      html += '<option value="' + escapeHtml(node.id) + '"' +
        (node.id === selectedId ? " selected" : "") + ">" +
        escapeHtml(node.label) + "</option>";
    }
    html += "</optgroup>";
  }
  return html;
}

// Which boxes the pickers start on. Once a strand is up they follow it; before
// that they default to the two ends the map itself suggests, so the very first
// Trace click produces something rather than an error.
function defaultEnds(): { fromId: string | null; toId: string | null } {
  const p = state.pathway;
  if (p.fromId && p.toId) return { fromId: p.fromId, toId: p.toId };
  if (!NODES.length) return { fromId: null, toId: null };
  const firstInput = NODES.find(n => n.controllable) || NODES[0];
  const lastOutcome = [...NODES].reverse().find(n => !!n.direction) || NODES[NODES.length - 1];
  return { fromId: firstInput.id, toId: lastOutcome.id };
}

// The pickers hold one <option> per box, so on a large map rebuilding them is
// the expensive part of this panel — and stepping between routes doesn't change
// them at all. So the block is split in two: the controls are rebuilt only when
// their content would actually differ, the routes list on every change.
let _controlsSignature = "";

function controlsHtml(fromId: string | null, toId: string | null): string {
  let html = "";
  html += '<div class="sidebar-section-title"><span>Trace a strand</span></div>';

  html += '<div class="pathway-field">';
  html +=   '<label for="pathway-from">From (cause)</label>';
  html +=   '<select class="pathway-select" id="pathway-from">' + boxOptionsHtml(fromId) + "</select>";
  html += "</div>";

  html += '<div class="pathway-field">';
  html +=   '<label for="pathway-to">To (effect)</label>';
  html +=   '<select class="pathway-select" id="pathway-to">' + boxOptionsHtml(toId) + "</select>";
  html += "</div>";

  html += '<div class="pathway-buttons">';
  html +=   '<button class="pathway-button pathway-button--primary" data-pathway-action="trace">Trace</button>';
  html +=   '<button class="pathway-button" data-pathway-action="swap" title="Swap the two ends">Swap</button>';
  html +=   '<button class="pathway-button" data-pathway-action="clear" title="Leave pathway mode (Esc)"' +
            (pathwayActive() ? "" : " disabled") + ">Clear</button>";
  html += "</div>";
  return html;
}

function routesHtml(): string {
  const p = state.pathway;
  let html = "";

  if (_notice) {
    html += '<div class="pathway-notice">' + escapeHtml(_notice.text);
    if (_notice.swapTo) {
      html += '<button class="pathway-button" data-pathway-action="swap-and-trace">Swap the ends and trace</button>';
    }
    html += "</div>";
  } else if (!pathwayActive()) {
    html += '<p class="pathway-hint">Strictly downstream, so the strand always reads as a causal claim. ' +
            "Or select a box to see the strands it belongs to.</p>";
  }

  if (!pathwayActive()) return html;

  html += '<div class="sidebar-section-title" style="margin-top: var(--section-gap)">' +
          "<span>Routes</span>" +
          '<span class="count">' + p.routes.length + " of " + totalText() + "</span></div>";
  html += '<div class="pathway-list">';
  p.routes.forEach((route, i) => {
    html += routeRowHtml(route, i, i === p.routeIndex);
  });
  html += "</div>";

  if (p.totalRoutes > p.routes.length) {
    html += '<p class="pathway-hint">Showing the ' + p.routes.length +
            " strongest. Strength is the elasticities multiplied along the chain — " +
            "how much of a nudge at the start survives the trip.</p>";
  }
  if (pathwayReopenedFilters()) {
    html += '<p class="pathway-hint">This strand runs through a row, column or tag you had hidden, ' +
            "so it has been reopened. Clearing the strand puts it back.</p>";
  }
  return html;
}

export function renderPathwayPanel(): void {
  const container = document.getElementById("pathway-panel");
  if (!container) return;
  if (!state.dataLoaded || NODES.length < 2) {
    container.innerHTML = "";
    _controlsSignature = "";
    return;
  }

  const ends = defaultEnds();
  // The signature has to be O(1). renderSidebar runs on all sorts of
  // interactions, and walking every box to build it would put an O(N) string
  // join in front of each one — the data revision (bumped by rebuildIndexes)
  // already says "the boxes changed", which is the only thing the options
  // depend on.
  const signature = dataRevision() + "|" + ends.fromId + "|" + ends.toId + "|" +
                    (pathwayActive() ? "on" : "off");

  let controls = container.querySelector<HTMLElement>(".pathway-controls");
  let routes = container.querySelector<HTMLElement>(".pathway-routes");
  if (!controls || !routes) {
    container.innerHTML = '<div class="pathway-controls"></div><div class="pathway-routes"></div>';
    controls = container.querySelector<HTMLElement>(".pathway-controls")!;
    routes = container.querySelector<HTMLElement>(".pathway-routes")!;
    _controlsSignature = "";
  }

  if (signature !== _controlsSignature) {
    controls.innerHTML = controlsHtml(ends.fromId, ends.toId);
    // Both pickers become type-to-filter dropdowns, same as everywhere else a
    // box is chosen in this app.
    upgradeSelectsIn(controls);
    _controlsSignature = signature;
  }
  routes.innerHTML = routesHtml();
}

// ───── The chip over the map ──────────────────────────────────────────────

function renderPathwayChip(): void {
  const chip = document.getElementById("pathway-chip");
  if (!chip) return;
  const route = currentRoute();
  if (!route) {
    chip.hidden = true;
    chip.innerHTML = "";
    return;
  }
  const p = state.pathway;
  const hops = route.nodeIds.length - 1;
  const isRibbon = p.view === "ribbon";

  let html = "";
  html += "<div>";
  html +=   '<div class="pathway-chip-counter">Route ' + (p.routeIndex + 1) + " of " + p.routes.length + "</div>";
  html +=   '<div class="pathway-chip-sub">strongest shown · ' + totalText() + " exist · " +
              hops + " hop" + (hops === 1 ? "" : "s") + " · net " + (route.sign > 0 ? "↑" : "↓") +
              " · " + formatStrength(route.strength) + "</div>";
  html += "</div>";
  html += '<div class="pathway-chip-divider"></div>';
  html += '<div class="pathway-chip-nav">';
  html +=   '<button data-pathway-action="prev" title="Previous route (←)" aria-label="Previous route"' +
            (p.routes.length < 2 ? " disabled" : "") + ">‹</button>";
  html +=   '<button data-pathway-action="next" title="Next route (→)" aria-label="Next route"' +
            (p.routes.length < 2 ? " disabled" : "") + ">›</button>";
  html += "</div>";
  html += '<button class="pathway-chip-action" data-pathway-action="toggle-view" aria-pressed="' +
          (isRibbon ? "true" : "false") + '" title="Straighten the strand into a line (R)">' +
          (isRibbon ? "On the map" : "Straighten") + "</button>";
  html += '<button class="pathway-chip-action" data-pathway-action="clear" title="Leave pathway mode (Esc)">Clear</button>';

  chip.innerHTML = html;
  chip.hidden = false;
}

// ───── The straightened view ──────────────────────────────────────────────

function hopCardHtml(nodeId: string, index: number, lastIndex: number): string {
  const node = nodeById[nodeId];
  if (!node) return "";
  const stream = streamById[node.stream];
  const stage = stageById[node.stage];
  const isEnd = index === 0 || index === lastIndex;

  // The current simulated value if there is one, otherwise the spreadsheet's
  // starting value — the same number the box shows on the map.
  let valueText = formatNodeValue(nodeId);
  if (!valueText && node.baseline !== undefined && node.baseline !== null) {
    valueText = node.baseline + " " + (node.unit || "");
  }

  let html = '<button class="pathway-hop' + (isEnd ? " pathway-hop--end" : "") +
             '" data-pathway-hop="' + escapeHtml(nodeId) + '" title="Show this box on the map">';
  html +=   '<span class="pathway-hop-stripe" style="background:' + escapeHtml((stream && stream.color) || "transparent") + '"></span>';
  html +=   '<span class="pathway-hop-body">';
  html +=     '<span class="pathway-hop-where">' + (index + 1) + " · " +
                escapeHtml((stream && (stream.short || stream.label)) || "") + " / " +
                escapeHtml((stage && stage.label) || "") + "</span>";
  html +=     '<span class="pathway-hop-name">' + escapeHtml(node.label) + "</span>";
  if (valueText) html += '<span class="pathway-hop-value">' + escapeHtml(valueText.trim()) + "</span>";
  html +=   "</span>";
  html += "</button>";
  return html;
}

function linkCellHtml(edgeId: string): string {
  const edge = edgeById[edgeId];
  if (!edge) return "";
  const elasticity = resolveEdgeElasticity(edge);
  const isDefault = edge.elasticity === undefined || edge.elasticity === null || isNaN(edge.elasticity);

  let html = '<div class="pathway-link ' + escapeHtml(edge.effect) + '">';
  html +=   '<svg class="pathway-link-arrow" viewBox="0 0 100 14" preserveAspectRatio="none" aria-hidden="true">';
  html +=     '<path d="M 4 7 L 88 7" stroke="var(--edge-' + escapeHtml(edge.effect) + ')" stroke-width="2"></path>';
  html +=     '<path d="M 88 2 L 98 7 L 88 12 z" fill="var(--edge-' + escapeHtml(edge.effect) + ')"></path>';
  html +=   "</svg>";
  html +=   '<div class="pathway-link-kind">' + escapeHtml(EFFECT_VERB[edge.effect] || edge.effect) + "</div>";
  html +=   '<div class="pathway-link-elasticity">' + elasticity.toFixed(2) + (isDefault ? " (default)" : "") + "</div>";
  html += "</div>";
  return html;
}

// The strand written out. Reading a causal chain aloud is how you find out
// whether you believe it, and it is the one thing the tangled map can never do.
function sentenceHtml(route: PathwayRoute): string {
  const parts: string[] = ["<b>" + escapeHtml(nodeLabel(route.nodeIds[0])) + "</b>"];
  route.edgeIds.forEach((edgeId, i) => {
    const edge = edgeById[edgeId];
    const verb = (edge && EFFECT_VERB[edge.effect]) || "affects";
    parts.push(" " + verb + " <b>" + escapeHtml(nodeLabel(route.nodeIds[i + 1])) + "</b>");
    if (i < route.edgeIds.length - 1) parts.push(", which");
  });

  const flips = signFlipCount(route);
  const up = route.sign > 0;
  parts.push(". That is " + flips + " sign flip" + (flips === 1 ? "" : "s") + " along the way, so raising <b>" +
             escapeHtml(nodeLabel(route.nodeIds[0])) + "</b> ends up " + (up ? "raising" : "lowering") +
             " <b>" + escapeHtml(nodeLabel(route.nodeIds[route.nodeIds.length - 1])) + "</b>.");
  return parts.join("");
}

function renderPathwayRibbon(): void {
  const panel = document.getElementById("pathway-ribbon");
  if (!panel) return;
  const container = document.getElementById("viz-container");
  const route = currentRoute();
  if (!route || state.pathway.view !== "ribbon") {
    panel.hidden = true;
    panel.innerHTML = "";
    if (container) container.classList.remove("pathway-straightened");
    return;
  }
  if (container) container.classList.add("pathway-straightened");

  const p = state.pathway;
  const lastIndex = route.nodeIds.length - 1;
  const up = route.sign > 0;

  let html = "";
  html += '<div class="pathway-ribbon-head">';
  html +=   '<h2 class="pathway-ribbon-title">' + escapeHtml(nodeLabel(route.nodeIds[0])) + " → " +
              escapeHtml(nodeLabel(route.nodeIds[lastIndex])) + "</h2>";
  html +=   '<span class="pathway-ribbon-sub">Route ' + (p.routeIndex + 1) + " of " + p.routes.length +
              " · " + totalText() + " exist</span>";
  html += "</div>";

  // Summary strip. "Net effect" and "Sign flips" sit next to each other on
  // purpose: the second is the working behind the first, so the claim is
  // checkable rather than something to take on faith.
  const cells: Array<[string, string, string]> = [
    ["Hops", String(lastIndex), ""],
    ["Net effect", up ? "increases" : "decreases", up ? "up" : "down"],
    ["Strength", formatStrength(route.strength), ""],
    ["Sign flips", String(signFlipCount(route)), ""],
    ["Rows crossed", String(streamsCrossed(route)), ""],
  ];
  html += '<div class="pathway-readout">';
  for (const [key, value, tone] of cells) {
    html += "<div>";
    html +=   '<span class="pathway-readout-key">' + escapeHtml(key) + "</span>";
    html +=   '<span class="pathway-readout-value ' + tone + '">' + escapeHtml(value) + "</span>";
    html += "</div>";
  }
  html += "</div>";

  html += '<p class="pathway-sentence">' + sentenceHtml(route) + "</p>";

  html += '<div class="pathway-ribbon-scroll"><div class="pathway-ribbon-track">';
  route.nodeIds.forEach((nodeId, i) => {
    html += hopCardHtml(nodeId, i, lastIndex);
    if (i < route.edgeIds.length) html += linkCellHtml(route.edgeIds[i]);
  });
  html += "</div></div>";

  panel.innerHTML = html;
  panel.hidden = false;
}

// ───── One entry point, so the three surfaces can't disagree ──────────────

export function renderPathwayUi(): void {
  renderPathwayPanel();
  renderPathwayChip();
  renderPathwayRibbon();
}

// A change that alters WHICH boxes are drawn (tracing a strand can reopen a
// hidden row) has to recompute the layout before rendering; a change that only
// alters which are lit does not. Tracing and clearing take the expensive path;
// stepping between routes of the same trace takes it too, because a different
// route can cross a different hidden row.
function repaintForPathway(): void {
  setLayout(computeLayout());
  render();
  renderSidebar();          // renders the pathway panel too — see renderSidebar
  renderDetailPanel();
}

// ───── Actions ────────────────────────────────────────────────────────────

function pickerValue(id: string): string | null {
  const el = document.getElementById(id) as HTMLSelectElement | null;
  return el ? el.value : null;
}

export function tracePathwayFromPickers(): void {
  const fromId = pickerValue("pathway-from");
  const toId = pickerValue("pathway-to");
  if (!fromId || !toId) return;
  tracePathway(fromId, toId);
}

export function tracePathway(fromId: string, toId: string): void {
  _notice = null;

  if (fromId === toId) {
    _notice = { text: "Pick two different boxes — a strand needs somewhere to go." };
    clearPathway();
    repaintForPathway();
    return;
  }

  const result = startPathway(fromId, toId);
  if (!result.routes.length) {
    // Strictly downstream means "no route" is a real answer, not a failure. If
    // the causality runs the other way, say so and offer the swap — that is
    // nearly always what the user meant.
    const back = findRoutes(toId, fromId);
    _notice = back.routes.length
      ? {
          text: "No downstream route from " + nodeLabel(fromId) + " to " + nodeLabel(toId) +
                ". The causality runs the other way — there " + (back.total === 1 ? "is 1 route" : "are " + back.total + " routes") + " back.",
          swapTo: { fromId: toId, toId: fromId },
        }
      : {
          text: "No downstream route from " + nodeLabel(fromId) + " to " + nodeLabel(toId) +
                ". These two aren't causally connected in this direction.",
        };
    clearPathway();
  }
  repaintForPathway();
}

// Show a strand the user picked from the suggestions in the detail panel.
export function showSuggestedStrand(route: PathwayRoute): void {
  _notice = null;
  showRoute(route);
  repaintForPathway();
}

export function exitPathway(): void {
  if (!pathwayActive() && !_notice) return;
  _notice = null;
  clearPathway();
  repaintForPathway();
}

export function cyclePathwayRoute(delta: number): void {
  if (!pathwayActive()) return;
  stepRoute(delta);
  repaintForPathway();
}

export function togglePathwayView(): void {
  if (!pathwayActive()) return;
  setPathwayView(state.pathway.view === "ribbon" ? "map" : "ribbon");
  renderPathwayUi();
}

// ───── Wiring ─────────────────────────────────────────────────────────────
// Delegated from the document, once, at module load: every surface above is
// rebuilt by innerHTML on each render, so per-element listeners would have to
// be re-attached constantly. Same pattern the rest of the app uses.

function handleAction(action: string): void {
  switch (action) {
    case "trace":
      tracePathwayFromPickers();
      break;
    case "swap": {
      const from = document.getElementById("pathway-from") as HTMLSelectElement | null;
      const to = document.getElementById("pathway-to") as HTMLSelectElement | null;
      if (!from || !to) return;
      const swapped = from.value;
      from.value = to.value;
      to.value = swapped;
      tracePathwayFromPickers();
      break;
    }
    case "swap-and-trace":
      if (_notice && _notice.swapTo) tracePathway(_notice.swapTo.fromId, _notice.swapTo.toId);
      break;
    case "clear":
      exitPathway();
      break;
    case "prev":
      cyclePathwayRoute(-1);
      break;
    case "next":
      cyclePathwayRoute(1);
      break;
    case "toggle-view":
      togglePathwayView();
      break;
  }
}

document.addEventListener("click", event => {
  const target = event.target as Element;
  if (!target || typeof target.closest !== "function") return;

  const row = target.closest("[data-pathway-row='route']");
  if (row) {
    event.preventDefault();
    const index = Number(row.getAttribute("data-index"));
    if (!isNaN(index)) {
      selectRoute(index);
      repaintForPathway();
    }
    return;
  }

  const actionEl = target.closest("[data-pathway-action]");
  if (actionEl) {
    event.preventDefault();
    handleAction(actionEl.getAttribute("data-pathway-action")!);
    return;
  }

  // A hop card in the straightened view jumps to that box on the map — the
  // straightened view is a reading aid, not a separate place to get lost in.
  const hop = target.closest("[data-pathway-hop]");
  if (hop) {
    event.preventDefault();
    const nodeId = hop.getAttribute("data-pathway-hop")!;
    setPathwayView("map");
    renderPathwayUi();
    scrollNodeIntoView(nodeId);
  }
});
