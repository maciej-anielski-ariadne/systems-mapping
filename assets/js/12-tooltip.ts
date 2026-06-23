// =============================================================================
// TOOLTIP — show / move / hide the hover popup
// -----------------------------------------------------------------------------
// One <div id="tooltip"> is reused for every node. JS sets its innerHTML when
// the cursor enters a node, moves it to follow the cursor, and hides it when
// the cursor leaves.
// =============================================================================

import { state } from "./03-state";
import { escapeHtml, formatScalar } from "./04-utils";
import { formatNodeDelta } from "./07-simulation-engine";
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

  tooltip.innerHTML =
    '<div class="tooltip-title">' + escapeHtml(node.label) + '</div>' +
    valueLine +
    '<div class="tooltip-desc">' + escapeHtml(node.description || "") + '</div>';

  tooltip.classList.add("visible");
  moveTooltip(event);
}

// Keep the tooltip near the cursor, but flip to the other side if it would
// overflow the screen edge.
export function moveTooltip(event: MouseEvent): void {
  const offset = 12;
  let x = event.clientX + offset;
  let y = event.clientY + offset;

  const rect = tooltip.getBoundingClientRect();
  if (x + rect.width  > window.innerWidth  - 10) x = event.clientX - rect.width  - offset;
  if (y + rect.height > window.innerHeight - 10) y = event.clientY - rect.height - offset;

  tooltip.style.left = x + "px";
  tooltip.style.top  = y + "px";
}

export function hideTooltip(): void {
  tooltip.classList.remove("visible");
}

// ───── Generic UI tooltip ────────────────────────────────────────────────
// For buttons / filter rows / row labels / anything that isn't a node. The
// same #tooltip element is reused so we don't pay for an extra DOM node
// per tooltipped control. Content is a single line of plain text.
export function showUiTooltip(text: string, event: MouseEvent): void {
  if (!text) return;
  tooltip.innerHTML = '<div class="tooltip-text">' + escapeHtml(text) + '</div>';
  tooltip.classList.add("visible");
  moveTooltip(event);
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

function tipTargetFrom(event: Event): Element | null {
  const target = event.target as Element | null;
  return target && typeof target.closest === "function" ? target.closest("[data-tooltip]") : null;
}

document.addEventListener("mouseover", event => {
  const el = tipTargetFrom(event);
  if (!el || el === activeTipEl) return;
  activeTipEl = el;
  showUiTooltip(el.getAttribute("data-tooltip") || "", event as MouseEvent);
});

document.addEventListener("mousemove", event => {
  if (!activeTipEl) return;
  const el = tipTargetFrom(event);
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
