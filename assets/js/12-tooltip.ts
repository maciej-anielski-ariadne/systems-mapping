// =============================================================================
// TOOLTIP — show / move / hide the hover popup
// -----------------------------------------------------------------------------
// One <div id="tooltip"> is reused for every node. JS sets its innerHTML when
// the cursor enters a node, moves it to follow the cursor, and hides it when
// the cursor leaves.
// =============================================================================

import { state } from "./03-state";
import { escapeHtml, formatScalar } from "./04-utils";
import { formatNodeDelta, gatedBy } from "./07-simulation-engine";
import type { GraphNode } from "./types";

export const tooltip = document.getElementById("tooltip") as HTMLDivElement;

// Build the tooltip body and position it near the cursor.
export function showTooltip(node: GraphNode | null | undefined, event: MouseEvent): void {
  if (!node) return;

  // Build a "Current: X (+5% vs baseline Y)" line if the node has quant data.
  let valueLine = "";
  if (node.baseline !== undefined && node.baseline !== null) {
    const value = state.computedValues[node.id];
    const unit = node.unit || "";
    const valueStr = value !== undefined ? formatScalar(value) + " " + unit : "—";
    const baselineStr = formatScalar(node.baseline) + " " + unit;
    const deltaInfo = formatNodeDelta(node.id);
    valueLine =
      '<div class="tooltip-quant">' +
        '<span class="tooltip-quant-label">Current:</span> ' +
        '<span class="tooltip-quant-value">' + escapeHtml(valueStr) + '</span>' +
        (deltaInfo.text && deltaInfo.text !== "—"
          ? ' <span class="tooltip-quant-delta">(' + escapeHtml(deltaInfo.text) + ' vs starting value ' + escapeHtml(baselineStr) + ')</span>'
          : ' <span class="tooltip-quant-delta">starting value ' + escapeHtml(baselineStr) + '</span>') +
      '</div>';
  }

  // Why a box that did not move did not move. It is the one thing a still box
  // has to say, and on the map it is the ONLY place it can say it in full —
  // there is room on the box for the word "held" and no room at all for what is
  // holding it.
  let heldLine = "";
  const gate = state.simulationMode ? gatedBy(node.id) : null;
  if (gate) {
    heldLine = '<div class="tooltip-held">Held back by <b>' + escapeHtml(gate.label) + '</b></div>';
  }

  // What the box IS comes straight after its name; what it is DOING follows.
  // The description was arriving last, under the numbers, which put the one
  // line that tells a reader what they are looking at below the lines that
  // assume they already know.
  const description = (node.description || "").trim();

  tooltip.innerHTML =
    '<div class="tooltip-title">' + escapeHtml(node.label) + '</div>' +
    (description ? '<div class="tooltip-desc">' + escapeHtml(description) + '</div>' : "") +
    valueLine +
    heldLine;

  tooltip.classList.add("visible");
  invalidateTooltipSize();
  positionTooltip(event.clientX, event.clientY);
}

// ───── Position + size ────────────────────────────────────────────────────
// Two costs used to be paid on EVERY mousemove while a tooltip was up:
//   • getBoundingClientRect() — a forced synchronous layout of the page, in the
//     middle of a pointer-move handler, on a page whose SVG can hold tens of
//     thousands of elements. The tooltip's size only changes when its CONTENT
//     does, so it is measured once per content and cached.
//   • two style writes per event — mousemoves arrive faster than the screen
//     refreshes, so all but the last were invisible. Moves are coalesced onto
//     the next animation frame; the first placement (on show) stays synchronous
//     so the tooltip never appears at the previous cursor position.
let _tipW = 0, _tipH = 0, _tipSizeValid = false;

function invalidateTooltipSize(): void {
  _tipSizeValid = false;
}

function tooltipSize(): { w: number; h: number } {
  if (!_tipSizeValid) {
    const rect = tooltip.getBoundingClientRect();
    _tipW = rect.width;
    _tipH = rect.height;
    _tipSizeValid = true;
  }
  return { w: _tipW, h: _tipH };
}

// A resize changes the wrap width the CSS gives the tooltip, so re-measure.
if (typeof window !== "undefined") {
  window.addEventListener("resize", invalidateTooltipSize);
}

function positionTooltip(clientX: number, clientY: number): void {
  const offset = 12;
  let x = clientX + offset;
  let y = clientY + offset;

  const size = tooltipSize();
  // The map-wide actions now share a collision-free dock along the bottom.
  // Treat that dock as unavailable space too: a tooltip that technically fits
  // in the viewport can still cover the controls the user is about to reach.
  const bottomControlClearance = window.innerWidth <= 600 ? 206 : 142;
  const bottomLimit = window.innerHeight - bottomControlClearance;
  if (x + size.w > window.innerWidth  - 10) x = clientX - size.w - offset;
  if (y + size.h > bottomLimit) y = clientY - size.h - offset;
  if (y < 10) y = 10;

  tooltip.style.left = x + "px";
  tooltip.style.top  = y + "px";
}

// Keep the tooltip near the cursor, but flip to the other side if it would
// overflow the screen edge. Coalesced onto the next frame — see above.
let _pendingMove: { x: number; y: number } | null = null;
let _moveRAF = 0;
const _raf: (cb: FrameRequestCallback) => number =
  typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb => setTimeout(() => cb(0), 16) as unknown as number);

export function moveTooltip(event: MouseEvent): void {
  _pendingMove = { x: event.clientX, y: event.clientY };
  if (_moveRAF) return;
  _moveRAF = _raf(() => {
    _moveRAF = 0;
    const pt = _pendingMove;
    _pendingMove = null;
    if (pt && tooltip.classList.contains("visible")) positionTooltip(pt.x, pt.y);
  });
}

export function hideTooltip(): void {
  tooltip.classList.remove("visible");
  _pendingMove = null;
}

// A click commits the action under the pointer, so the hover hint has finished
// its job. Hide it even when the control stops the click from bubbling (menus
// do this), which is why this listener runs during capture. The active hover
// target deliberately stays intact: small pointer movement over the same
// control must not immediately resurrect a hint the user just dismissed.
document.addEventListener("click", hideTooltip, { capture: true });

// ───── Generic UI tooltip ────────────────────────────────────────────────
// For buttons / filter rows / row labels / anything that isn't a node. The
// same #tooltip element is reused so we don't pay for an extra DOM node
// per tooltipped control. Content is a single line of plain text.
export function showUiTooltip(text: string, event: MouseEvent): void {
  if (!text) return;
  tooltip.innerHTML = '<div class="tooltip-text">' + escapeHtml(text) + '</div>';
  tooltip.classList.add("visible");
  invalidateTooltipSize();   // new content → new measured size
  positionTooltip(event.clientX, event.clientY);
}

// ───── Delegated data-tooltip handling ────────────────────────────────────
// One document-level listener set drives every HTML element carrying a
// `data-tooltip` attribute. Using closest('[data-tooltip]') means the
// INNERMOST tooltipped element under the cursor wins automatically, so a small
// control nested inside a tooltipped row shows its own hint — never the row's,
// and never both at once (there is only one #tooltip element, so two tooltips
// can never overlap). mouseover/mouseout bubble (unlike mouseenter/mouseleave),
// which is what makes the delegation work.
let activeTipEl: Element | null = null;
// The event target the last mousemove resolved, and what it resolved TO. While
// the cursor travels across one element (the overwhelming majority of moves)
// the answer cannot change, so the closest() ancestor walk — which on the map
// climbs out of a node group through the SVG on every single event — is skipped
// entirely and only the cheap reposition runs.
let _lastMoveTarget: EventTarget | null = null;
let _lastMoveResult: Element | null = null;

function tipTargetFrom(event: Event): Element | null {
  const target = event.target as Element | null;
  return target && typeof target.closest === "function" ? target.closest("[data-tooltip]") : null;
}

function tipTargetCached(event: Event): Element | null {
  if (event.target === _lastMoveTarget) return _lastMoveResult;
  const el = tipTargetFrom(event);
  _lastMoveTarget = event.target;
  _lastMoveResult = el;
  return el;
}

document.addEventListener("mouseover", event => {
  const el = tipTargetFrom(event);
  if (!el || el === activeTipEl) return;
  activeTipEl = el;
  showUiTooltip(el.getAttribute("data-tooltip") || "", event as MouseEvent);
});

document.addEventListener("mousemove", event => {
  if (!activeTipEl) return;
  const el = tipTargetCached(event);
  if (el && el !== activeTipEl) {            // moved onto a nested / different target
    activeTipEl = el;
    showUiTooltip(el.getAttribute("data-tooltip") || "", event as MouseEvent);
    return;
  }
  if (!el) { activeTipEl = null; hideTooltip(); return; }
  moveTooltip(event as MouseEvent);
});

document.addEventListener("mouseout", event => {
  if (!activeTipEl) return;
  const to = (event as MouseEvent).relatedTarget as Element | null;
  // Still inside the same tooltipped element (e.g. onto a child)? keep showing.
  if (to && typeof to.closest === "function" && to.closest("[data-tooltip]") === activeTipEl) return;
  activeTipEl = null;
  hideTooltip();
});
