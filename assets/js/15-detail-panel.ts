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

import type { GraphNode, Edge, EffectKind } from "./types";
import {
  STREAMS,
  STAGES,
  CATEGORIES,
  NODES,
  EDGES,
  DEFAULT_ELASTICITY_BY_EFFECT,
  nodeById,
  outgoingEdges,
  incomingEdges,
  streamById,
  stageById,
  state,
} from "./03-state";
import { upgradeSelectsIn } from "./04b-typeable-dropdown";
import { escapeHtml, formatScalar, splitCategoriesByClass, nodeCategoryIds } from "./04-utils";
import { formatNodeDelta, resolveEdgeElasticity } from "./07-simulation-engine";
import { EFFECT_OPTIONS } from "./02-config";
import { selectNode, scrollNodeIntoView } from "./09-graph-selection";
import { applySimMultiplier, updateDetailPanelDeltaInline } from "./14-simulation-panel";
import { deleteEdgeById, commitNewEdge, deleteSelection } from "./16e-canvas-edit";
import { applyCanvasMutation } from "./16f-canvas-mutations";

export function renderDetailPanel(): void {
  const emptyState   = document.getElementById("detail-empty")!;
  const contentState = document.getElementById("detail-content")!;

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
  contentState.classList.toggle("is-editing", editMode);
  contentState.classList.remove("just-unlocked");
  contentState.innerHTML = renderNodeSkeleton(node, editMode);

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

  // One-shot "fields unlocked" pulse, set when the user toggled into edit mode
  // (cleared immediately so it doesn't replay on subsequent field re-renders).
  if (state.canvasEdit && state.canvasEdit._justUnlocked) {
    contentState.classList.add("just-unlocked");
    state.canvasEdit._justUnlocked = false;
  }
}

// =============================================================================
// UNIFIED NODE SKELETON — view + edit share ONE structure; toggling Edit just
// swaps each field's leaf (display span ↔ input/select). The same sections sit
// in the same positions in both modes, so the toggle reads as fields unlocking
// in place rather than a layout swap. Leaf elements keep their classes /
// data-attributes, so the existing view / edit handlers + field-write logic
// are unchanged.
// =============================================================================

export function renderNodeSkeleton(node: GraphNode, editMode: boolean): string {
  const directInputs  = incomingEdges[node.id].map((edge: Edge) => ({ edge: edge, otherNode: nodeById[edge.from] }));
  const directImpacts = outgoingEdges[node.id].map((edge: Edge) => ({ edge: edge, otherNode: nodeById[edge.to] }));

  let html = "";

  // ── Identity: tags (both modes) ──────────────────────────────────────
  html += renderTagRow(node);

  // ── Name: display ↔ display-styled input, in the same slot ───────────
  if (editMode) {
    html += '<input type="text" class="detail-edit-input detail-name-input" data-field="label" value="' + escapeHtml(node.label || "") + '" aria-label="Box name">';
  } else {
    html += '<div class="detail-name">' + escapeHtml(node.label) + '</div>';
  }

  // ── Description: text ↔ textarea, in the same slot ───────────────────
  if (editMode) {
    html += '<textarea class="detail-edit-input detail-edit-textarea detail-desc-input" data-field="description" rows="2" placeholder="Description…" aria-label="Description">' + escapeHtml(node.description || "") + '</textarea>';
  } else if (node.description) {
    html += '<div class="detail-description">' + escapeHtml(node.description) + '</div>';
  }

  // ── Mode toggle: the stable anchor between identity and the data ──────
  html += '<div class="detail-mode-toggle">';
  html += editMode
    ? '<button class="detail-mode-button active" data-action="toggle-edit-mode" aria-pressed="true">Done editing</button>'
    : '<button class="detail-mode-button" data-action="toggle-edit-mode" aria-pressed="false">Edit box</button>';
  html += '</div>';

  // ── Identity edit controls (edit only): the chips' source fields ─────
  if (editMode) {
    html += '<div class="detail-edit-block">';
    html += editRow("Row", selectInput("stream", STREAMS.map(s => ({ value: s.id, label: s.label })), node.stream));
    html += editRow("Column",  selectInput("stage",  STAGES.map(s => ({ value: s.id, label: s.label })),  node.stage));
    html += editRow("Categories", categoryEditControl(node));
    html += '</div>';
  }

  // ── Quantification: values ↔ inputs, on the same rail ────────────────
  html += renderQuantFrame(node, editMode);

  // ── Direct inputs — read-only stripes in BOTH modes (incoming edges
  //    are edited from the source node; clicking jumps there) ───────────
  html += renderEdgeList("What feeds in", directInputs, "from", "Nothing feeds into this box — it is a starting input.");
  if (editMode && directInputs.length) {
    html += '<div class="detail-edge-hint">Edit a link from the box it starts at →</div>';
  }

  // ── Direct impacts — read-only stripes (view) ↔ editable editors (edit) ─
  if (editMode) {
    html += renderOutgoingEdgesBlock(node);
  } else {
    html += renderEdgeList("What it affects", directImpacts, "to", "This box does not affect anything else — it is a final result.");
  }

  // ── Delete node (edit only) ──────────────────────────────────────────
  if (editMode) {
    html += '<div class="detail-actions">';
    html += '<button class="detail-button detail-delete-btn" data-action="delete-node">Delete box</button>';
    html += '</div>';
  }

  return html;
}

// One quantification block, shared by both modes. View shows display values on
// the rail; edit swaps each editable value for an input on the SAME rail and
// reveals the edit-only rows (Unit, Controllable, Slider max). Current + Δ are
// computed, so they stay read-only in edit (marked .detail-quant-derived).
export function renderQuantFrame(node: GraphNode, editMode: boolean): string {
  const hasBaseline = node.baseline !== undefined && node.baseline !== null;
  // View shows the block only when there's a baseline (as before); edit always
  // shows it so baseline / unit / direction / etc. can be set.
  if (!editMode && !hasBaseline) return "";

  const unit         = node.unit || "";
  const currentValue = state.computedValues[node.id];
  const deltaInfo    = formatNodeDelta(node.id);
  let deltaColor = "var(--text-secondary)";
  if (Math.abs(deltaInfo.pct) >= 0.5) {
    if      (node.direction === "higher_better") deltaColor = deltaInfo.pct > 0 ? "var(--status-good)" : "var(--status-bad)";
    else if (node.direction === "lower_better")  deltaColor = deltaInfo.pct < 0 ? "var(--status-good)" : "var(--status-bad)";
    else                                         deltaColor = deltaInfo.pct > 0 ? "var(--accent-blue)" : "var(--accent-orange)";
  }
  const directionOptions = [
    { value: "",              label: "— none —" },
    { value: "higher_better", label: "Higher is better" },
    { value: "lower_better",  label: "Lower is better" },
    { value: "neutral",       label: "Neutral / context" },
  ];
  const row = (label: string, leaf: string): string => '<div class="detail-quant-row"><span class="detail-quant-label">' + escapeHtml(label) + '</span>' + leaf + '</div>';

  let html = '<div class="detail-quant-block">';

  // Baseline — display value ↔ number input on the rail
  html += row("Starting value", editMode
    ? '<input type="number" step="any" class="detail-edit-input detail-edit-number detail-quant-input" data-field="baseline" value="' + (hasBaseline ? node.baseline : "") + '" placeholder="—">'
    : '<span class="detail-quant-value">' + escapeHtml(formatScalar(node.baseline!)) + ' ' + escapeHtml(unit) + '</span>');

  // Unit — edit only (folded into the value displays in view)
  if (editMode) {
    html += row("Unit", '<input type="text" class="detail-edit-input detail-quant-input detail-quant-input-text" data-field="unit" value="' + escapeHtml(unit) + '" placeholder="%, people, £, …">');
  }

  // Current — computed; read-only in edit, an input only in view + sim mode
  if (!editMode && state.simulationMode && node.controllable) {
    html += row("Current", '<span class="detail-quant-value" style="font-weight:600;"><input type="number" class="detail-value-input" step="any" value="' + (currentValue !== undefined ? formatScalar(currentValue) : node.baseline) + '" data-node-id="' + escapeHtml(node.id) + '" aria-label="Current value of ' + escapeHtml(node.label) + '" />' + (unit ? ' ' + escapeHtml(unit) : '') + '</span>');
  } else {
    html += row("Current", '<span class="detail-quant-value' + (editMode ? ' detail-quant-derived' : '') + '" style="font-weight:600;">' + escapeHtml(currentValue !== undefined ? formatScalar(currentValue) + ' ' + unit : '—') + '</span>');
  }

  // Δ vs baseline — computed (read-only in both)
  html += row("Change vs start", '<span class="detail-quant-value' + (editMode ? ' detail-quant-derived' : '') + '" style="color:' + deltaColor + '; font-weight:600;">' + escapeHtml(deltaInfo.text || '—') + '</span>');

  // Controllable (edit checkbox) / Type (view descriptor)
  if (editMode) {
    html += row("Adjustable", '<label class="detail-quant-check"><input type="checkbox" data-field="controllable"' + (node.controllable ? " checked" : "") + '> has a slider</label>');
  } else if (node.controllable) {
    html += row("Type", '<span class="detail-quant-value" style="color: var(--text-tertiary);">External input (adjustable)</span>');
  }

  // Outcome direction — descriptor ↔ select
  if (editMode) {
    html += row("Outcome", '<span class="detail-quant-control">' + selectInput("direction", directionOptions, node.direction || "") + '</span>');
  } else {
    let d = "";
    if      (node.direction === "higher_better") d = '<span class="detail-quant-value" style="color: var(--status-good);">↑ higher is better</span>';
    else if (node.direction === "lower_better")  d = '<span class="detail-quant-value" style="color: var(--status-good);">↓ lower is better</span>';
    else if (node.direction === "neutral")       d = '<span class="detail-quant-value" style="color: var(--text-tertiary);">context-dependent</span>';
    if (d) html += row("Outcome", d);
  }

  // Slider max — edit only
  if (editMode) {
    html += row("Slider max", '<input type="number" step="any" class="detail-edit-input detail-edit-number detail-quant-input" data-field="sliderMax" value="' + (node.sliderMax !== undefined && node.sliderMax !== null ? node.sliderMax : "") + '" placeholder="2 × base">');
  }

  html += '</div>';
  return html;
}

export function editRow(label: string, controlHtml: string): string {
  return '<div class="detail-edit-row"><span class="detail-edit-label">' + escapeHtml(label) + '</span><div class="detail-edit-control">' + controlHtml + '</div></div>';
}

// Multi-select category editor: a checkbox per category, split into Primary
// (fill — several blend into a gradient) and Secondary (corner chips) groups by
// each category's class. Checkboxes carry data-field="categoryToggle" so the
// existing change-listener routes them to applyNodeFieldEdit.
export function categoryEditControl(node: GraphNode): string {
  const primSet = new Set(node.primaryCategories || (node.category ? [node.category] : []));
  const secSet  = new Set(node.secondaryCategories || []);
  const byClass = splitCategoriesByClass(Object.keys(CATEGORIES));
  const group = (title: string, list: string[], checkedSet: Set<string>): string => {
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
  return group("Main · fills the box", byClass.primary, primSet) +
         group("Corner tag", byClass.secondary, secSet);
}

// Category / stream / stage tag chips shown at the top of both view and edit
// mode. Same markup in both — extracted so changing the chip style (e.g.
// adding an icon) only happens in one place.
export function renderTagRow(node: GraphNode): string {
  const stream = streamById[node.stream];
  const stage  = stageById[node.stage];
  const catIds = nodeCategoryIds(node);

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

export function selectInput(field: string, options: Array<{ value: string; label: string }>, currentValue: string | undefined): string {
  let html = '<select class="detail-edit-input detail-edit-select" data-field="' + field + '">';
  for (const opt of options) {
    const isSelected = (opt.value === currentValue || (currentValue === undefined && opt.value === ""));
    html += '<option value="' + escapeHtml(opt.value) + '"' + (isSelected ? " selected" : "") + '>' + escapeHtml(opt.label) + '</option>';
  }
  html += '</select>';
  return html;
}

// ───── Outgoing edges (edit mode) ─────────────────────────────────────
export function renderOutgoingEdgesBlock(node: GraphNode): string {
  const outgoing = outgoingEdges[node.id] || [];
  const flashedId = state.canvasEdit && state.canvasEdit.flashedEdgeId;
  const adding = state.canvasEdit && state.canvasEdit.addingEdgeFromNodeId === node.id;

  let html = '<div class="outgoing-edges-block">';
  html +=   '<div class="detail-list-title"><span>What it affects</span><span class="count">' + outgoing.length + '</span></div>';

  if (outgoing.length === 0) {
    html += '<div class="outgoing-edges-empty">No links out yet. Drag from the right edge of this box on the map, or add one below.</div>';
  } else {
    for (const edge of outgoing) {
      const target = nodeById[edge.to];
      const defaultElasticity = DEFAULT_ELASTICITY_BY_EFFECT[edge.effect];
      const flashClass = (edge.id === flashedId) ? " flash" : "";
      html += '<div class="edge-stripe edge-stripe--edit ' + edge.effect + flashClass + '" data-edge-row-id="' + escapeHtml(edge.id) + '">';
      html +=   '<div class="outgoing-edge-header">';
      html +=     '<button class="outgoing-edge-target-link" data-jump-node="' + escapeHtml(edge.to) + '" title="Jump to the box this affects">→ ' + escapeHtml(target ? target.label : edge.to) + '</button>';
      html +=     '<button class="outgoing-edge-delete" data-edge-action="delete" data-edge-id="' + escapeHtml(edge.id) + '" title="Delete this link">×</button>';
      html +=   '</div>';
      html +=   '<div class="outgoing-edge-controls">';
      html +=     '<select class="detail-edit-input detail-edit-select" data-edge-id="' + escapeHtml(edge.id) + '" data-edge-field="effect">';
      for (const eff of EFFECT_OPTIONS) {
        html +=     '<option value="' + eff + '"' + (edge.effect === eff ? " selected" : "") + '>' + eff + '</option>';
      }
      html +=     '</select>';
      html +=     '<input type="number" step="any" class="detail-edit-input detail-edit-number outgoing-edge-elasticity" data-edge-id="' + escapeHtml(edge.id) + '" data-edge-field="elasticity" value="' + (edge.elasticity !== undefined && edge.elasticity !== null ? edge.elasticity : "") + '" placeholder="default ' + defaultElasticity + '" title="Strength (leave blank for the default for this link type)">';
      html +=     '<select class="detail-edit-input detail-edit-select outgoing-edge-style" data-edge-id="' + escapeHtml(edge.id) + '" data-edge-field="style" title="Line style">';
      html +=       '<option value="solid"'  + (edge.style === "dashed" ? "" : " selected") + '>Solid</option>';
      html +=       '<option value="dashed"' + (edge.style === "dashed" ? " selected" : "") + '>Dashed</option>';
      html +=     '</select>';
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
    const connectedTargetIds = new Set(outgoing.map((e: Edge) => e.to));
    const otherNodes = NODES.filter(n => n.id !== node.id && !connectedTargetIds.has(n.id));
    const hasAnyOtherNode = NODES.some(n => n.id !== node.id);
    // Retained but unused for the dropdown filter — keep for any consumers
    // that reference effect-level dedupe.
    const existingTargets = new Set(outgoing.map((e: Edge) => e.to + ":" + e.effect));
    html += '<div class="outgoing-edge-add">';
    if (otherNodes.length === 0) {
      const emptyMsg = hasAnyOtherNode
        ? "Every other box is already linked."
        : "Add at least one more box before drawing links.";
      html +=   '<div class="outgoing-edges-empty">' + emptyMsg + '</div>';
      html +=   '<button class="detail-edit-link" data-action="cancel-add-edge">Cancel</button>';
    } else {
      html +=   '<div class="outgoing-edge-add-title">Add a link out</div>';
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
      html +=     '<button class="detail-button" data-action="confirm-add-edge">Add link</button>';
      html +=   '</div>';
    }
    html += '</div>';
  } else {
    html += '<button class="detail-edit-link outgoing-edge-add-toggle" data-action="show-add-edge">+ Add a link out</button>';
  }

  html += '</div>';
  return html;
}

// =============================================================================
// HANDLERS
// =============================================================================

export function wireSharedHandlers(node: GraphNode, contentState: HTMLElement): void {
  // Toggle between View and Edit. Shared by both modes (just the label and
  // styling differ).
  const editToggle = contentState.querySelector("[data-action='toggle-edit-mode']");
  if (editToggle) {
    editToggle.addEventListener("click", () => {
      state.canvasEdit.editMode = !state.canvasEdit.editMode;
      if (!state.canvasEdit.editMode) {
        state.canvasEdit.addingEdgeFromNodeId = null;
      } else {
        state.canvasEdit._justUnlocked = true;   // pulse the fields on view→edit
      }
      renderDetailPanel();
    });
  }

  // Edge stripes navigate to the connected node — in BOTH modes. In edit, the
  // Direct Inputs are read-only links to the source node where they're edited.
  contentState.querySelectorAll(".edge-stripe--nav").forEach(item => {
    item.addEventListener("click", () => {
      const targetNodeId = item.getAttribute("data-target-node")!;
      selectNode(targetNodeId);
      scrollNodeIntoView(targetNodeId);
    });
  });
}

export function wireViewModeHandlers(node: GraphNode, contentState: HTMLElement): void {
  // Editable "Current" input in sim mode for controllable nodes.
  contentState.querySelectorAll(".detail-value-input").forEach(input => {
    input.addEventListener("input", event => {
      const nodeId = (event.target as HTMLElement).getAttribute("data-node-id")!;
      const targetNode = nodeById[nodeId];
      if (!targetNode || !targetNode.baseline) return;
      const raw = parseFloat((event.target as HTMLInputElement).value);
      if (isNaN(raw)) return;
      if (typeof applySimMultiplier === "function") {
        applySimMultiplier(nodeId, raw / targetNode.baseline, event.target as HTMLInputElement);
      }
      if (typeof updateDetailPanelDeltaInline === "function") {
        updateDetailPanelDeltaInline(nodeId);
      }
    });
  });
}

export function wireEditModeHandlers(node: GraphNode, contentState: HTMLElement): void {
  // Node-field edits.
  contentState.querySelectorAll("[data-field]").forEach(input => {
    if (input.hasAttribute("data-edge-field")) return;     // edge inputs wired below
    const field = input.getAttribute("data-field");
    if (!field) return;
    input.addEventListener("change", () => {
      applyNodeFieldEdit(node, field, input as HTMLInputElement);
    });
  });

  // Outgoing-edges row edits + delete.
  contentState.querySelectorAll(".edge-stripe--edit [data-edge-field]").forEach(input => {
    const edgeId = input.getAttribute("data-edge-id")!;
    const field  = input.getAttribute("data-edge-field")!;
    input.addEventListener("change", () => {
      applyEdgeFieldEdit(edgeId, field, input as HTMLInputElement);
    });
  });
  contentState.querySelectorAll(".outgoing-edge-target-link").forEach(btn => {
    btn.addEventListener("click", () => {
      const targetId = btn.getAttribute("data-jump-node")!;
      if (nodeById[targetId]) {
        selectNode(targetId);
        scrollNodeIntoView(targetId);
      }
    });
  });
  contentState.querySelectorAll("[data-edge-action='delete']").forEach(btn => {
    btn.addEventListener("click", () => {
      const edgeId = btn.getAttribute("data-edge-id")!;
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
      const targetSel = contentState.querySelector("[data-action='pick-add-target']") as HTMLSelectElement | null;
      const effectSel = contentState.querySelector("[data-action='pick-add-effect']") as HTMLSelectElement | null;
      if (!targetSel || !effectSel) return;
      const targetId = targetSel.value;
      const effect   = effectSel.value;
      state.canvasEdit.addingEdgeFromNodeId = null;
      if (typeof commitNewEdge === "function") commitNewEdge(node.id, targetId, effect as EffectKind);
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

export function applyNodeFieldEdit(node: GraphNode, field: string, input: HTMLInputElement): void {
  let value: string | number | boolean | undefined;
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
    if (!streamById[value as string]) return;
    node.stream = value as string;
  } else if (field === "stage") {
    if (!stageById[value as string]) return;
    node.stage = value as string;
  } else if (field === "categoryToggle") {
    const catId = input.getAttribute("data-cat")!;
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
    else                     { node.baseline = value as number; }
    skipDetailRender = true;
  } else if (field === "unit") {
    if (value) node.unit = String(value); else delete node.unit;
    skipDetailRender = true;
  } else if (field === "controllable") {
    if (value) node.controllable = true; else delete node.controllable;
  } else if (field === "direction") {
    if (value) node.direction = value as GraphNode["direction"]; else delete node.direction;
  } else if (field === "sliderMax") {
    if (value === undefined) delete node.sliderMax;
    else                     node.sliderMax = value as number;
    skipDetailRender = true;
  }

  if (typeof applyCanvasMutation === "function") applyCanvasMutation({ skipDetailRender: skipDetailRender });
}

export function applyEdgeFieldEdit(edgeId: string, field: string, input: HTMLInputElement): void {
  const edge = EDGES.find(e => e.id === edgeId);
  if (!edge) return;
  if (field === "effect") {
    if (!EFFECT_OPTIONS.includes(input.value)) return;
    edge.effect = input.value as EffectKind;
  } else if (field === "style") {
    if (input.value === "dashed") edge.style = "dashed"; else delete edge.style;
    // Line style doesn't affect layout — preserve focus.
    if (typeof applyCanvasMutation === "function") applyCanvasMutation({ skipDetailRender: true });
    return;
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

export function renderEdgeList(title: string, items: Array<{ edge: Edge; otherNode: GraphNode }>, direction: string, emptyText: string): string {
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

export function renderEdgeItem(otherNode: GraphNode, edge: Edge, direction: string): string {
  const effectClass = edge.effect;
  const arrow = direction === "from" ? "←" : "→";
  const elasticity = resolveEdgeElasticity(edge);
  const elasticitySign = elasticity > 0 ? "+" : "";
  const elasticityText = elasticity !== 0 ? "Strength " + elasticitySign + elasticity.toFixed(2) : "Strength 0";

  // A real <button> so the "jump to the connected node" action is Tab-reachable
  // and Enter/Space-activatable (the click handler in wireViewModeHandlers works
  // unchanged). aria-label names the otherwise-implicit navigate action.
  const jumpDir = direction === "from" ? "(affects this)" : "(this affects)";
  let html = '<button type="button" class="edge-stripe edge-stripe--nav ' + effectClass + '" data-target-node="' + escapeHtml(otherNode.id) + '" aria-label="Jump to ' + escapeHtml(otherNode.label) + ' ' + jumpDir + '">';
  html +=   '<div class="detail-edge-header">';
  html +=     '<div class="detail-edge-name">' + arrow + ' ' + escapeHtml(otherNode.label) + '</div>';
  html +=     '<div class="detail-edge-elasticity">' + escapeHtml(elasticityText) + '</div>';
  html +=   '</div>';
  html +=   '<div class="detail-edge-effect ' + effectClass + '">' + edge.effect + '</div>';
  html +=   '<div class="detail-edge-desc">' + escapeHtml(edge.description) + '</div>';
  html += '</button>';
  return html;
}
