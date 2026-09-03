// =============================================================================
// RIGHT DETAIL PANEL RENDERING
// -----------------------------------------------------------------------------
// Two completely separate modes for a selected node:
//
//   View mode (default): tags, name, description, quant block, "Edit Node"
//     button (full-width, centred), the calculation breakdown (simulation
//     mode only), direct inputs, direct impacts, causal chain summary.
//     Read-only — the user is exploring / tracing.
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

import type { GraphNode, Edge, EffectKind, CalcRule, CombineMode, EvidenceMetadata, NodeExplanation, TraceInput } from "./types";
import {
  STREAMS,
  STAGES,
  CATEGORIES,
  NODES,
  EDGES,
  DEFAULT_ELASTICITY_BY_EFFECT,
  nodeById,
  paramById,
  edgeById,
  outgoingEdges,
  incomingEdges,
  streamById,
  stageById,
  state,
  markEdgeGeometryChanged,
} from "./03-state";
import { upgradeSelectsIn } from "./04b-typeable-dropdown";
import { escapeHtml, formatScalar, formatScalarInput, splitCategoriesByClass, nodeCategoryIds } from "./04-utils";
import { isBlankInput, parseStrictFiniteNumber } from "./05b-input-validation";
import {
  explainNode, formatNodeDelta, resolveEdgeElasticity,
  formulaInLabels, formulaConstants, formulaReads, formulaInLabelsFailed,
} from "./07-simulation-engine";
import {
  isSourceFlagged, entryFor, reviewStateOf, queueOrder, queuePosition,
  coverage, inputFamily, fingerprintOf, toggleSourceFlag, recordVerdict,
  reviewAction, scheduleReviewSave, needsResponse,
} from "./24-review-record";
import {
  isFormulaFunction, FORMULA_NUMBER_PATTERN_SOURCE, FORMULA_IDENTIFIER_PATTERN_SOURCE,
} from "./07a-formula";
import { renderCalculationChoiceGuide } from "./07b-calculation-guide";
import {
  evidenceStatusLabel,
  normaliseEvidenceStatus,
  renderEvidenceEditor,
  updateEvidenceMetadata,
} from "./07c-evidence";
import { EFFECT_OPTIONS } from "./02-config";
import { focusNode, scrollNodeIntoView } from "./09-graph-selection";
import { render, renderSelectionChange } from "./11-rendering";
import { applySimMultiplier, toggleSimulationMode, updateDetailPanelDeltaInline } from "./14-simulation-panel";
import { applySelectionClass, setUiMode } from "./17-events";
import { atlasIsOpen, atlasPanelHtml, openAtlas, putScroll, takeScroll } from "./21-atlas-view";
import { deleteEdgeById, commitNewEdge, deleteSelection } from "./16e-canvas-edit";
import { applyCanvasMutation } from "./16f-canvas-mutations";
import { openLearnReference, referenceCardForNode } from "./26a-learn-reference";

// The "?" beside the formula editor and the calculation breakdown. It opens the
// reference shelf at whichever entry answers the question this box is posing,
// so the explanation arrives where the decision is being made rather than in a
// lesson the reader has to remember to take.
function calculationHelpButton(): string {
  return '<button type="button" class="calc-help" data-action="calculation-help"' +
    ' aria-label="How to choose this box\'s calculation" data-tooltip="How to choose this box\'s calculation">?</button>';
}

export function renderDetailPanel(): void {
  const emptyState   = document.getElementById("detail-empty")!;
  const contentState = document.getElementById("detail-content")!;

  // In reading mode the panel is closed until there's something in it.
  if (typeof applySelectionClass === "function") applySelectionClass();

  if (typeof atlasIsOpen === "function" && atlasIsOpen()) {
    emptyState.style.display   = "none";
    contentState.style.display = "block";
    contentState.classList.remove("is-editing");
    // Replacing the markup throws away where every list inside it was scrolled
    // to, and this panel is re-rendered on every repaint — so picking something
    // forty rows down threw you back to the top, and a slider drag did it many
    // times a second. Lift the offsets out and put them back. See takeScroll in
    // 21-atlas-view for why they are keyed the way they are.
    const scrolled = takeScroll(contentState);
    contentState.innerHTML = atlasPanelHtml();
    putScroll(contentState, scrolled);
    return;
  }

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

  // While an atlas is open the panel belongs to it — one inspector in the app,
  // not two. The atlas writes its own markup and wires its own buttons through
  // the stage's delegated listener.
  if (typeof atlasIsOpen === "function" && atlasIsOpen()) {
    contentState.classList.remove("is-editing");
    contentState.innerHTML = atlasPanelHtml();
    return;
  }

  // Editing the map means editing the box in front of you. There used to be a
  // second switch inside the panel — "Edit box" / "Done editing" — so being in
  // edit mode wasn't enough; you had to say so again, per box, every time the
  // selection changed. One global mode, one answer.
  const editMode = state.uiMode === "edit";
  contentState.classList.toggle("is-editing", editMode);
  contentState.innerHTML = renderNodeSkeleton(node, editMode);

  // Finite choices in the detail panel are selection-only dropdowns. They must
  // not turn into text fields: Row, Column, Adjustable, Outcome, Combine and
  // the other short enumerations are picked from their lists. The one exception
  // is the potentially long list of boxes when adding a link, where filtering
  // by typing remains useful.
  contentState.querySelectorAll<HTMLSelectElement>("select").forEach(selectElement => {
    if (selectElement.getAttribute("data-action") !== "pick-add-target") {
      selectElement.setAttribute("data-dropdown-mode", "select-only");
      const fieldRow = selectElement.closest(".detail-edit-row, .detail-quant-row, .evidence-editor");
      const fieldLabel = fieldRow?.querySelector(
        ".detail-edit-label, .detail-quant-label, label > span",
      )?.textContent?.trim();
      if (fieldLabel && !selectElement.hasAttribute("aria-label")) {
        selectElement.setAttribute("aria-label", fieldLabel);
      }
    }
  });

  // Upgrade only the long-list select left eligible above. Safe to call before
  // change handlers are wired: picking an option dispatches `change` on the
  // underlying select, which the field handlers then receive.
  if (typeof upgradeSelectsIn === "function") upgradeSelectsIn(contentState);

  // Wire up handlers for whichever mode just rendered.
  wireSharedHandlers(node, contentState);
  if (editMode) {
    wireEditModeHandlers(node, contentState);
  } else {
    wireViewModeHandlers(node, contentState);
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
  // Reading mode asks one question of a box — what causes it, what does it
  // affect — so that answer comes first and everything else sits under it.
  // Editing keeps the authoring order: identity, then the fields, then links.
  const reading = state.uiMode !== "edit";

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

  // ── Where the box sits (edit only) ──────────────────────────────────
  //    Label beside the control, like every row below it. These two used to
  //    put their label above, which made the panel read as two different forms
  //    stacked on top of each other and cost ~48px to say so.
  //
  //    Categories are NOT here any more. They were a twelve-row checkbox list
  //    330px down the panel, editing the same tags the strip at the top was
  //    already showing. The strip is the editor now — see renderTagRow.
  if (editMode) {
    html += '<div class="detail-list-title"><span>Placement</span></div>';
    html += '<div class="detail-edit-block">';
    html += editRow("Row", selectInput("stream", STREAMS.map(s => ({ value: s.id, label: s.label })), node.stream));
    html += editRow("Column",  selectInput("stage",  STAGES.map(s => ({ value: s.id, label: s.label })),  node.stage));
    html += '</div>';
  }

  // The pieces below the identity block, named so the two modes can order
  // them differently without either one growing its own copy.
  // "Driven by" / "Drives" rather than "Causes" / "Effects". Both old labels
  // were ambiguous in the same direction: read as verbs, "causes" and "effects"
  // describe what this box does TO other boxes, which is the opposite of what
  // the first list holds. Grammar now carries the direction — a passive and an
  // active form of one verb cannot be read the wrong way round.
  const causes  = renderEdgeList("Driven by", directInputs, "from", "Nothing drives this — it is a starting box.");
  const effects = editMode
    ? renderOutgoingEdgesBlock(node)
    : renderEdgeList("Drives", directImpacts, "to", "This drives nothing — it is a final result.");
  const causesHint = (editMode && directInputs.length)
    ? '<div class="detail-edge-hint">Edit a link from the box it starts at →</div>'
    : "";
  // "How this number is calculated" — the audit trail for the figure shown
  // alongside. View mode only: in edit mode the user is CHANGING the rule (and
  // text-field edits deliberately skip the panel re-render to keep focus), so a
  // breakdown there would be showing yesterday's working. Simulation mode only,
  // because outside it there are no computed numbers to explain.
  const numbers = renderQuantFrame(node, editMode) +
    (!editMode && state.simulationMode ? renderCalculationBreakdown(node) : "");

  // ── The review card ────────────────────────────────────────────────
  // While a pass is running, this panel stops being a description of a box and
  // becomes a question about it. The content underneath is UNCHANGED — the list
  // of what drives the box is already exactly the thing a reviewer has to judge,
  // so the card adds the question, the marks and the verdict rather than a
  // second copy of the box.
  const inPass = reviewingBox(node);
  // On a formula box the strengths on the arrows are ignored outright, so the
  // rows must not invite a judgement on them.
  const reviewMarks = inPass
    ? { boxId: node.id, strengthsIgnored: !!node.formula && !formulaInLabelsFailed(node.id) }
    : undefined;
  if (inPass) {
    // Re-render the incoming list with the review affordances on it.
    //
    // `html` carries the identity block built above — the tags, the name, the
    // description — and it goes in here rather than being dropped. It was
    // dropped, and the card asked "is this everything that drives this box?"
    // about a box whose NAME was nowhere on the panel: the only thing naming it
    // was the rectangle highlighted on the map, and the description, which is
    // often the definition being judged, was off screen entirely.
    return renderReviewStepper(node)
      + html
      + renderReviewAsk(node)
      + renderReviewRule(node)
      + renderSelectedBoxActions(node, directImpacts.length > 0)
      + renderEdgeList("Driven by", directInputs, "from",
          "Nothing drives this — it is a starting box.", reviewMarks)
      + renderReviewFamily(node)
      + effects
      + numbers
      + renderReviewFooter(node);
  }

  if (reading) {
    html += renderSelectedBoxActions(node, directImpacts.length > 0);
    html += '<div class="detail-relationship-lists" role="group" aria-label="Relationships">';
    html += causes;
    html += effects;
    html += '</div>';
    html += numbers;
    return html;
  }

  html += numbers;
  html += causes;
  html += causesHint;
  html += effects;

  // ── Delete node (edit only) ──────────────────────────────────────────
  if (editMode) {
    html += '<div class="detail-actions">';
    html += '<button class="detail-button detail-delete-btn" data-action="delete-node">Delete box</button>';
    html += '</div>';
  }

  return html;
}

/** Actions whose consequence begins with the selected box live together in
 * its panel. Only useful actions are offered: Atlas needs a downstream route,
 * and input simulation needs an adjustable box. */
function renderSelectedBoxActions(node: GraphNode, hasDirectImpacts: boolean): string {
  const actions: string[] = [];
  if (hasDirectImpacts) {
    actions.push('<button class="detail-scope-button detail-atlas-button" data-action="open-atlas">' +
      '<b>Atlas</b><span>Follow every pathway out</span></button>');
  }
  if (node.controllable && !state.simulationMode) {
    actions.push('<button class="detail-scope-button" data-action="simulate-box">' +
      '<b>Simulate input</b><span>Test a change from here</span></button>');
  }
  actions.push('<button class="detail-scope-button" data-action="edit-box">' +
    '<b>Edit box</b><span>Change fields and links</span></button>');
  return '<div class="detail-scope-actions" aria-label="Actions for this box">' + actions.join("") + '</div>';
}

// ═════════════════════════════════════════════════════════════════════════════
// THE REVIEW CARD
// -----------------------------------------------------------------------------
// Four pieces around the panel's existing content. Two of them stick — the
// stepper to the top and the verdict to the bottom — because on the busiest box
// of the map this was built against the panel already overflows a laptop-height
// frame BEFORE any of this is added. Fitting was never available; what is
// available is guaranteeing that the question and the verdict are always reachable
// and only the middle of the list scrolls.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Is THIS panel, right now, a review card for THIS box?
 *
 * One predicate, asked everywhere, because the card does not merely add things
 * to the panel — it also takes one away (the breakdown's verbatim copy of the
 * formula, which the rule block above it is already showing). Two spellings of
 * "we are reviewing" meant the taking-away happened in cases the adding did
 * not: a box outside the queue during a pass had its expression suppressed with
 * nothing put in its place, so the rule was on screen nowhere.
 *
 * Simulation mode is in here because the rail is: it takes the left column,
 * which simulation docks, so the queue cannot be shown beside a simulated map.
 * Without this the card stayed live with the queue gone — the verdict buttons
 * still recording, no progress, and no way back to the list.
 */
function reviewingBox(node: GraphNode): boolean {
  return state.uiMode !== "edit" && state.reviewPass && !state.simulationMode &&
         queuePosition(node.id) > 0;
}

function renderReviewStepper(node: GraphNode): string {
  const at = queuePosition(node.id);
  const total = queueOrder().length;
  const done = coverage();
  const settled = done.agreed + done.flagged;
  let html = '<div class="rv-step">';
  html +=   '<span class="rv-step-count">box ' + at + ' of ' + total + '</span>';
  html +=   '<span class="rv-step-bar" role="progressbar" aria-valuenow="' + settled +
            '" aria-valuemin="0" aria-valuemax="' + total + '"><i style="width:' +
            (total ? Math.round(settled / total * 100) : 0) + '%"></i></span>';
  html +=   '<button type="button" class="rv-step-btn" data-review="prev" ' +
            'data-tooltip="Previous box in the pass" aria-label="Previous box">[</button>';
  html +=   '<button type="button" class="rv-step-btn" data-review="next" ' +
            'data-tooltip="Next box still wanting a verdict" aria-label="Next box">]</button>';
  html +=   '<button type="button" class="rv-step-btn rv-step-end" data-review="end" ' +
            'data-tooltip="Stop the review pass">Done</button>';
  html += '</div>';
  return html;
}

// The question, stated. This is the whole mechanism by which a MISSING link gets
// found: a list you are merely shown invites you to check the rows that are
// there, and a list you are asked about invites you to notice the row that is
// not. One band of copy, and it is the difference between the two.
function renderReviewAsk(node: GraphNode): string {
  const count = (incomingEdges[node.id] || []).length;
  const state_ = reviewStateOf(node.id);
  // "Wrong strengths" is false on a formula box — the engine never reads them.
  // Telling a third of the queue to check something that cannot be wrong is
  // worse than saying nothing, because it looks like the whole question.
  let sub = node.formula
    ? "This box is computed from the rule below, and the " + count + " link" +
      (count === 1 ? "" : "s") + " under it are what the rule draws on. Is the rule " +
      "right, and does it use everything it should?"
    : count === 1
    ? "One link below. Is it right — and is it the only one?"
    : count + " links below. Wrong ones, wrong strengths — and anything that should be here and is not.";
  if (state_ === "stale") {
    sub = "This box was signed off before, and something about what drives it has changed since. " + sub;
  }
  return '<div class="rv-ask' + (state_ === "stale" ? " is-stale" : "") + '">' +
         '<b>Is this everything that drives this box?</b>' +
         '<span>' + escapeHtml(sub) + '</span></div>';
}

// The one prompt aimed at what is NOT there. When several of a box's inputs are
// the same shape, that is a pattern the author built on purpose — and a pattern
// with a member missing is the commonest way a large map goes wrong. The app can
// see the pattern; a reader looking at seven rows usually cannot.
function renderReviewFamily(node: GraphNode): string {
  const family = inputFamily(node.id);
  if (!family) return "";
  const shape = [family.prefix, "…", family.suffix].filter(Boolean).join(" ").trim();
  const names = family.members.map(m => m.varies).filter(Boolean);
  return '<div class="rv-family">' +
    '<b>' + family.members.length + ' of these are the same shape</b> — ' +
    escapeHtml(names.join(", ")) +
    (shape ? ', all of them "' + escapeHtml(shape) + '"' : "") +
    '. Is one of that set missing?</div>';
}

// ═════════════════════════════════════════════════════════════════════════════
// THE RULE, FOR A BOX WHOSE RULE IS NOT ITS ARROWS
// -----------------------------------------------------------------------------
// A formula box is computed from its expression ALONE: the arrows into it go
// descriptive and their strengths are ignored outright. Eighteen of the
// fifty-five boxes in the queue on the map this was built against are formula
// boxes — a third of the pass — and until this block existed the card asked
// "is this everything that drives this box?", showed the arrows, and left the
// thing that actually decides the box off screen entirely. On those boxes the
// list was the wrong list and the right one was nowhere.
//
// So: the expression verbatim, because that is the rule and a sign-off on a rule
// nobody has seen is the theatre the fingerprint exists to prevent. The same
// expression in the map's own labels underneath, because formulas name boxes by
// ID — `hgv_arrivals` in the expression is "Lorry arrivals" in the list, and
// nothing else on screen connects the two. Then the constants, which appear on
// no map anywhere. Then, folded, the working.
//
// The five non-default combine boxes get a line of their own for the same
// reason, though a smaller one: their arrows still do the work, they just add
// up differently.
// ═════════════════════════════════════════════════════════════════════════════

// ───── Reading a formula ──────────────────────────────────────────────────
// Four kinds of name appear in an expression and they are not interchangeable:
// a box on the map, a hidden constant, one of the four functions, or a name that
// resolves to NOTHING. Telling them apart is most of what reading a formula is,
// and at 11px in a 308px column a wall of one-colour monospace does not.
//
// NO NEW HUES. This app's grammar is that colour means "you can act on this",
// with the map's increase / decrease / enable hues as the one sanctioned
// exception — and those three sit inches away on the link rows, so borrowing
// them here would make a formula look like it was full of link kinds. So the
// kinds are told apart by weight, by dimming, and by the same inset chip the
// calculation breakdown already uses for a constant. The single exception is a
// name that resolves to nothing: that is an error the loader flags, and it is
// worth the red.
//
// Tokenised with the parser's OWN patterns (07a-formula exports them), so what
// this colours as a name is exactly what the engine reads as one. Unlike the
// parser, it never throws: a formula that will not parse is precisely when a
// reviewer most needs to be able to read it.
const FORMULA_NUMBER = new RegExp("^" + FORMULA_NUMBER_PATTERN_SOURCE);
const FORMULA_IDENTIFIER = new RegExp("^" + FORMULA_IDENTIFIER_PATTERN_SOURCE);

function formulaToken(
  className: string,
  text: string,
  tooltip?: string,
  attributes: Record<string, string> = {},
): string {
  const attributeMarkup = Object.entries(attributes)
    .map(([name, value]) => ' ' + name + '="' + escapeHtml(value) + '"')
    .join("");
  return '<span class="' + className + '"' + attributeMarkup +
    (tooltip ? ' data-tooltip="' + escapeHtml(tooltip) + '"' : "") +
    ">" + escapeHtml(text) + "</span>";
}

// Formula values need more precision than the map's compact labels. In the
// People reached example, 1.005 is deliberately rendered as 1.01 on the box;
// repeating that rounding in the hover would make 80 × 5 × 1.01 look as if it
// should equal 404 rather than the actual 402.
function formulaTooltipNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return String(Number(value.toPrecision(6)));
}

function formulaBoxTooltip(
  nodeIdentifier: string,
  formulaInputs: TraceInput[],
  delayed: boolean,
): string {
  const sourceNode = nodeById[nodeIdentifier];
  if (!sourceNode) return nodeIdentifier;
  const tracedInput = formulaInputs.find(input =>
    input.kind === "node" && input.id === nodeIdentifier && !!input.delayed === delayed,
  );
  const value = tracedInput?.value ?? state.computedValues[nodeIdentifier] ?? sourceNode.baseline;
  const valueText = value === undefined
    ? "value unavailable"
    : formulaTooltipNumber(value) + (sourceNode.unit ? " " + sourceNode.unit : "");
  return sourceNode.label + " — " + (delayed ? "previous-step value" : "current value") + ": " + valueText;
}

function formulaGlobalVariableTooltip(parameterIdentifier: string): string {
  const parameter = paramById[parameterIdentifier];
  if (!parameter) return parameterIdentifier;
  return "Global variable — value: " + constantText(parameter.value) +
    ". Available to every formula; it is not a box." +
    (parameter.description ? " " + parameter.description + "." : "");
}

export function paintFormula(text: string, formulaInputs: TraceInput[] = []): string {
  const source = String(text || "");
  let html = "";
  let at = 0;
  let nextNodeReferenceIsDelayed = false;
  while (at < source.length) {
    const rest = source.slice(at);

    const space = /^\s+/.exec(rest);
    if (space) { html += escapeHtml(space[0]); at += space[0].length; continue; }

    const number = FORMULA_NUMBER.exec(rest);
    if (number) { html += formulaToken("fx-num", number[0]); at += number[0].length; continue; }

    const name = FORMULA_IDENTIFIER.exec(rest);
    if (name) {
      const word = name[0];
      // The tooltip is half the point: formulas name boxes by ID, so hovering
      // `hgv_arrivals` and being told "Lorry arrivals" is the connection
      // nothing else on screen makes.
      if (isFormulaFunction(word)) {
        html += formulaToken("fx-fn", word, FORMULA_FN_TIP[word] || "");
        nextNodeReferenceIsDelayed = word === "delay";
      } else if (nodeById[word]) {
        html += formulaToken(
          "fx-box",
          word,
          formulaBoxTooltip(word, formulaInputs, nextNodeReferenceIsDelayed),
          {
            "data-formula-node-id": word,
            "data-formula-delayed": String(nextNodeReferenceIsDelayed),
          },
        );
        nextNodeReferenceIsDelayed = false;
      } else if (paramById[word]) {
        html += formulaToken(
          "fx-const",
          word,
          formulaGlobalVariableTooltip(word),
          { "data-formula-param-id": word, "data-formula-kind": "global-variable" },
        );
        nextNodeReferenceIsDelayed = false;
      } else {
        html += formulaToken("fx-unknown", word,
          "This is neither a box on this map nor a constant, so the engine cannot read it.");
        nextNodeReferenceIsDelayed = false;
      }
      at += word.length;
      continue;
    }

    html += formulaToken("fx-op", source[at]);
    at += 1;
  }
  return html;
}

const FORMULA_FN_TIP: Record<string, string> = {
  min:   "The smallest of the values inside — a gate: whichever is short decides.",
  max:   "The largest of the values inside.",
  clamp: "Hold the first value between the two that follow it.",
  delay: "Read this box as it stood one solver step ago — how a feedback loop is made well-defined.",
};

/** Which box's working is folded open. One at a time; not persisted. */
let workingOpenFor: string | null = null;

export function setReviewWorkingOpen(boxId: string | null): void {
  workingOpenFor = boxId;
}

// The value as the author wrote it. formatScalar would round 0.0004 to "0.000",
// which on a rail is a rounding and here is a different constant.
function constantText(value: number): string {
  const shown = formatScalar(value).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return Number(shown.replace(/,/g, "")) === value ? shown : String(value);
}

const COMBINE_SENTENCE: Record<string, string> = {
  additive: "The arrows into this box ADD UP rather than compounding, so two related " +
            "inputs do not overstate the total between them.",
  min:      "The WEAKEST arrow into this box gates it — the smallest input decides the " +
            "result, rather than any one of them carrying it.",
};

function renderReviewRule(node: GraphNode): string {
  const combine = node.combine && node.combine !== "multiplicative" ? node.combine : "";
  if (!node.formula && !combine) return "";      // its rule IS the arrows below

  let html = '<div class="rv-rule">';
  html +=   '<div class="rv-rule-head">The rule for this box</div>';

  if (node.formula) {
    // Verbatim first. Everything under it is a rendering of this, and a reader
    // has to be able to see what is being rendered.
    html += '<div class="rv-expr">' + paintFormula(node.formula, explainNode(node.id)?.inputs || []) + '</div>';

    if (formulaInLabelsFailed(node.id)) {
      // The loader already says so on the Review panel; it belongs here too,
      // because it changes what the reader is being asked to judge.
      html += '<div class="rv-rule-note rv-rule-warn"><b>The engine could not read this.</b> ' +
              'It fell back to the arrows below, so what the box actually does is not what ' +
              'this expression says.</div>';
    } else {
      const labelled = formulaInLabels(node.id);
      if (labelled && labelled !== node.formula) {
        html += '<div class="rv-plain">' + escapeHtml(labelled) + '</div>';
      }
      const consts = formulaConstants(node.id);
      if (consts.length) {
        html += '<div class="rv-consts">';
        for (const param of consts) {
          html += '<div class="rv-const">' +
            '<span class="rv-const-k" data-tooltip="' + escapeHtml(param.description || param.id) + '">' +
              escapeHtml(param.description || param.id) + '</span>' +
            '<span class="rv-const-v">' + escapeHtml(constantText(param.value)) + '</span>' +
          '</div>';
        }
        html += '<div class="rv-rule-note">' + consts.length + ' global variable' +
                (consts.length === 1 ? "" : "s") + ' — available to every formula and not ' +
                'shown as boxes, so this is where they can be checked.</div>';
        html += '</div>';
      }
      // An arrow the expression never reads is drawn and used by nothing. Not an
      // error (the loader checks the other direction — a name with no arrow), and
      // exactly the sort of thing a review is for.
      const reads = formulaReads(node.id);
      const unread = (incomingEdges[node.id] || [])
        .filter(edge => !reads.has(edge.from))
        .map(edge => (nodeById[edge.from] && nodeById[edge.from].label) || edge.from);
      if (unread.length) {
        html += '<div class="rv-rule-note rv-rule-warn"><b>' + unread.length + ' link' +
                (unread.length === 1 ? " is" : "s are") + ' drawn but never read</b> — ' +
                escapeHtml(unread.join(", ")) + '. The rule above does not mention ' +
                (unread.length === 1 ? "it" : "them") + '.</div>';
      }
    }
    html += '<div class="rv-rule-note"><b>The arrows below are descriptive here.</b> The ' +
            'engine reads the rule and nothing else, so a strength on one of them changes ' +
            'nothing.</div>';
  } else {
    html += '<div class="rv-plain">' + escapeHtml(COMBINE_SENTENCE[combine] || combine) + '</div>';
  }

  html += '</div>';

  // The working, folded. It needs the computed numbers and it is long — but it
  // is the difference between "here is a formula" and "here is why this number
  // is what it is", which is the question a reviewer actually has.
  const open = workingOpenFor === node.id;
  html += '<button type="button" class="rv-working-toggle" data-review-working="' +
          escapeHtml(node.id) + '" aria-expanded="' + (open ? "true" : "false") + '">' +
          (open ? "▾" : "▸") + " How this number is calculated</button>";
  if (open) html += renderCalculationBreakdown(node);
  return html;
}

function renderReviewFooter(node: GraphNode): string {
  const entry = entryFor(node.id);
  const now = reviewStateOf(node.id);
  const agreed = now === "agreed";
  const flagged = now === "flagged";

  // An unanswered concern — a flag, or words in the note field — blocks Agreed
  // until somebody says what was done about it. Both fields are live-edited
  // without a re-render (the textarea would lose focus mid-word), so the button
  // states below are the ones this card OPENED with; wireReviewCardHandlers
  // keeps them right from the first keystroke.
  const wanted = needsResponse(node.id);
  const answered = !!entry && !!entry.addressedNote.trim();

  let html = '<div class="rv-foot">';
  html +=   '<div class="rv-verdicts">';
  html +=     '<button type="button" class="rv-v' + (agreed ? " on" : "") + '" data-review="agree"' +
              (wanted ? " disabled" : "") +
              '>Agreed</button>';
  html +=     '<button type="button" class="rv-v flag' + (flagged ? " on" : "") + '" data-review="flag">Flag</button>';
  html +=     '<button type="button" class="rv-v" data-review="skip">Skip</button>';
  html +=   '</div>';
  // The note field is where a concern is RAISED — writing in it flags the box,
  // because saying what is wrong with something is not a different act from
  // saying something is wrong with it. The placeholder says so, since a field
  // that changes a verdict had better admit to it.
  html +=   '<textarea class="rv-note" rows="2" data-review-note="' + escapeHtml(node.id) + '" ' +
            'placeholder="What is wrong? — writing here flags the box">' +
            escapeHtml(entry ? entry.note : "") + '</textarea>';
  // Always rendered, hidden until there is something to answer: it has to be
  // able to appear on a keystroke, and the card cannot re-render to add it
  // without throwing away the half-typed word that summoned it.
  html +=   '<textarea class="rv-note rv-close" rows="2" data-review-close="' + escapeHtml(node.id) + '" ' +
            'placeholder="What was done about it? — needed to agree"' +
            (wanted || answered ? "" : " hidden") + '>' +
            escapeHtml(entry ? entry.addressedNote : "") + '</textarea>';
  // The fingerprint is shown, not hidden: it is what makes the sign-off expire
  // when the box changes, and a reader who can see it can tell that the record
  // is about a specific version of this box rather than about its name.
  if (entry && entry.verdict === "none") {
    // A fingerprint here would claim a version of the box had been signed off.
    // Nothing has been: this is a note somebody left themselves.
    html += '<div class="rv-by">' + escapeHtml(entry.reviewer || "unsigned") +
            " · " + escapeHtml(entry.date) + " · note kept, not yet judged</div>";
  } else if (entry) {
    // Who raised the concern and who closed it, when there has been one. The
    // line above names whoever gave the LATEST verdict, which after a close is
    // the closer and after one more edit is neither of them — so the two ends
    // of a concern are stated outright rather than inferred from it.
    if (entry.flaggedBy || entry.addressedBy) {
      html += '<div class="rv-by">' +
        (entry.flaggedBy
          ? "Raised by " + escapeHtml(entry.flaggedBy) + " on " + escapeHtml(entry.flaggedOn)
          : "Raised on " + escapeHtml(entry.flaggedOn)) +
        (entry.addressedOn
          ? " · closed by " + escapeHtml(entry.addressedBy || "someone") +
            " on " + escapeHtml(entry.addressedOn)
          : " · open") +
        '</div>';
    }
    html += '<div class="rv-by">' +
      escapeHtml(entry.reviewer || "unsigned") + " · " + escapeHtml(entry.date) +
      (now === "stale"
        ? ' · <span class="rv-stale">changed since — was ' + escapeHtml(entry.fingerprint) + '</span>'
        : " · " + escapeHtml(fingerprintOf(node))) +
      '</div>';
  } else {
    html += '<div class="rv-by">' + escapeHtml(state.reviewer || "set your name in Review") +
            ' · not yet judged</div>';
  }
  html += '</div>';
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
    else                                         deltaColor = "var(--accent-amber)";
  }
  const directionOptions = [
    { value: "",              label: "— none —" },
    { value: "higher_better", label: "Higher is better" },
    { value: "lower_better",  label: "Lower is better" },
    { value: "neutral",       label: "Neutral / context" },
  ];
  // `tip` (optional) hangs the panel's usual data-tooltip help off the row's
  // label, so a one-line plain-language explanation is a hover away without
  // spending a line of panel height on it.
  const labelSpan = (label: string, tip?: string): string =>
    '<span class="detail-quant-label"' + (tip ? ' data-tooltip="' + escapeHtml(tip) + '"' : '') + '>' + escapeHtml(label) + '</span>';
  const row = (
    label: string,
    leaf: string,
    tip?: string,
    quantityIdentifier?: string,
  ): string => '<div class="detail-quant-row"' +
    (quantityIdentifier ? ' data-detail-quantity="' + escapeHtml(quantityIdentifier) + '"' : "") +
    ">" + labelSpan(label, tip) + leaf + "</div>";

  // The box's own figures get a label like every other section, so the panel
  // reads as a stack of named blocks rather than as rows that run out.
  let html = '<div class="detail-list-title"><span>This box</span></div>';
  html += '<div class="detail-quant-block">';

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
    html += row("Current", '<span class="detail-quant-value" style="font-weight:600;"><input type="number" class="detail-value-input" step="any" value="' + (currentValue !== undefined ? formatScalarInput(currentValue) : node.baseline) + '" data-node-id="' + escapeHtml(node.id) + '" aria-label="Current value of ' + escapeHtml(node.label) + '" />' + (unit ? ' ' + escapeHtml(unit) : '') + '</span>');
  } else {
    html += row("Current", '<span class="detail-quant-value' + (editMode ? ' detail-quant-derived' : '') + '" style="font-weight:600;">' + escapeHtml(currentValue !== undefined ? formatScalar(currentValue) + ' ' + unit : '—') + '</span>');
  }

  // Δ vs baseline — computed (read-only in both)
  html += row("Change vs start", '<span class="detail-quant-value' + (editMode ? ' detail-quant-derived' : '') + '" style="color:' + deltaColor + '; font-weight:600;">' + escapeHtml(deltaInfo.text || '—') + '</span>');

  // Controllable (edit) / Type (view descriptor). A Yes / No dropdown, like
  // every other choice in this panel — it was a checkbox with the words "has a
  // slider" beside it, which put a second, differently-shaped control and a
  // second piece of prose into a column of one-line values. The empty value is
  // "No" so the existing write path (falsy → delete the flag) is unchanged.
  if (editMode) {
    const adjustableOptions = [
      { value: "",    label: "No" },
      { value: "yes", label: "Yes" },
    ];
    html += row("Adjustable", '<span class="detail-quant-control">' +
      selectInput("controllable", adjustableOptions, node.controllable ? "yes" : "") + '</span>',
      "Gives this box a slider in simulation mode, so its value can be pushed up or down.");
  } else if (node.controllable) {
    html += row("Type", '<span class="detail-quant-value" style="color: var(--text-tertiary);">External input (adjustable)</span>');
  }

  // Outcome direction — descriptor ↔ select
  if (editMode) {
    html += row("Outcome", '<span class="detail-quant-control">' + selectInput("direction", directionOptions, node.direction || "") + '</span>', undefined, "outcome");
  } else {
    let d = "";
    if      (node.direction === "higher_better") d = '<span class="detail-quant-value" style="color: var(--status-good);">↑ higher is better</span>';
    else if (node.direction === "lower_better")  d = '<span class="detail-quant-value" style="color: var(--status-good);">↓ lower is better</span>';
    else if (node.direction === "neutral")       d = '<span class="detail-quant-value" style="color: var(--text-tertiary);">context-dependent</span>';
    if (d) html += row("Outcome", d, undefined, "outcome");
  }

  // Slider max — only where there is a slider to cap. It used to sit here in
  // every box, greyed and inert, for the ones that aren't adjustable.
  if (editMode && node.controllable) {
    html += row("Slider max", '<input type="number" step="any" class="detail-edit-input detail-edit-number detail-quant-input" data-field="sliderMax" value="' + (node.sliderMax !== undefined && node.sliderMax !== null ? node.sliderMax : "") + '" placeholder="2 × base">',
      "How far the slider can be pushed. Blank means twice the starting value.");
  }

  // ── Per-box calculation rules — edit only ────────────────────────────
  // All four are optional and blank by default: a box that sets none of them
  // computes exactly as this app always has (docs/CALCULATION-ENGINE-DESIGN.md
  // §3). They sit at the bottom of the quant block because they're the
  // "advanced" end of the same subject — how this box's number comes about.
  if (editMode) {
    html += renderCalculationChoiceGuide({
      adjustable: !!node.controllable,
      hasFormula: !!node.formula,
    });

    // Blank IS multiplicative, so the default option carries an empty value and
    // an explicit "multiplicative" in the CSV simply shows as the default (a
    // round-trip drops the redundant word; the maths is identical).
    // Short labels: the parenthetical spelled out the engine's name for each
    // rule, which the row's own tooltip already explains at length, and at the
    // width a label-beside control gets it truncated to "Standard (multiplica".
    const combineOptions = [
      { value: "",            label: "Standard" },
      { value: "additive",    label: "Additive" },
      { value: "min",         label: "Weakest link" },
    ];
    const combineValue = node.combine && node.combine !== "multiplicative" ? node.combine : "";
    // A box with a formula is computed from the formula ALONE — its arrows go
    // descriptive (see the header of 07-simulation-engine.ts). So Combine, which
    // only ever says how those arrows add up, has nothing left to decide, and
    // showing it would invite an answer the engine then ignores.
    if (!node.formula) {
      html += row("Combine", '<span class="detail-quant-control">' + selectInput("combine", combineOptions, combineValue) + '</span>',
        "How the arrows into this box add up: standard compounds each effect, additive stops related inputs overstating the total, weakest link lets the smallest input gate the result.");
    }

    html += row("Formula", '<span class="detail-quant-formula-cell"><input type="text" class="detail-edit-input detail-quant-input detail-quant-formula" data-field="formula" value="' + escapeHtml(node.formula || "") + '" placeholder="none" spellcheck="false">' + calculationHelpButton() + '</span>',
      "Overrides the arrows' maths — e.g. min(a, b), clamp(x, lo, hi), delay(x). Every box named here must also have an arrow into this box.");
    html += renderEvidenceEditor({ metadata: node.formulaEvidence, scope: "formula" });

    html += row("Lowest allowed", '<input type="number" step="any" class="detail-edit-input detail-edit-number detail-quant-input" data-field="minValue" value="' + (node.minValue !== undefined && node.minValue !== null ? node.minValue : "") + '" placeholder="none">',
      "A hard floor in this box's own units — the number can never come out below it.");
    html += row("Highest allowed", '<input type="number" step="any" class="detail-edit-input detail-edit-number detail-quant-input" data-field="maxValue" value="' + (node.maxValue !== undefined && node.maxValue !== null ? node.maxValue : "") + '" placeholder="none">',
      "A hard ceiling in this box's own units — useful for a percentage that must never pass 100.");
  }

  html += '</div>';
  return html;
}

// =============================================================================
// CALCULATION BREAKDOWN — "how this number is calculated"
// -----------------------------------------------------------------------------
// The audit trail the design doc asks for (docs/CALCULATION-ENGINE-DESIGN.md
// §4): the engine records, per box, WHICH rule ran and WHAT fed into it
// (state.explanations, rebuilt wholesale on every recompute), and this section
// says it back in plain language.
//
// It is deliberately a short story, not a debug dump: one sentence naming the
// rule, one row per input with its number and that input's share of the answer,
// and a notice only when something actually happened to the figure (a bound
// bit, a division by zero, a name that couldn't be resolved).
// =============================================================================

// One plain-language sentence per rule. The jargon word stays in brackets so a
// user who has read the CSV columns can still map the two together.
const CALC_RULE_SENTENCE: Record<CalcRule, string> = {
  pinned:         "Your slider is holding this box at its current setting.",
  baseline:       "No quantified inputs, so it stays at its starting value.",
  multiplicative: "Multiply the independent proportional effects.",
  additive:       "Add each proportional change to the starting value.",
  min:            "Use the smallest proportional factor from the inputs.",
  formula:        "Use the values named in the formula.",
};

// "9,000 FTE" for a box; global variables are unitless, so just the number.
function calcInputValueText(input: TraceInput): string {
  const sourceNode = nodeById[input.id];
  const unit = sourceNode && sourceNode.unit ? " " + sourceNode.unit : "";
  // A constant is written exactly as its author wrote it. formatScalar rounds
  // 0.0004 to "0.000", which on a box's value rail is a rounding and on a
  // constant is a different number — and a constant shown wrong is worse than a
  // constant not shown, because somebody will check it and pass it.
  if (input.kind === "param") return constantText(input.value) + unit;
  return formatScalar(input.value) + unit;
}

// The input's name. A global variable never appears as a box on the map, so its
// row says that explicitly instead of relying on a diamond whose meaning a new
// reader has not yet been taught.
function calcInputLabelHtml(input: TraceInput): string {
  if (input.kind === "param") {
    const param = paramById[input.id];
    return '<span class="calc-input-param" data-tooltip="' +
      escapeHtml(formulaGlobalVariableTooltip(input.id)) + '">◆ global · ' +
      escapeHtml(input.id) + '</span>';
  }
  const sourceNode = nodeById[input.id];
  return '<span class="calc-input-name">' + escapeHtml(sourceNode ? sourceNode.label : input.id) + '</span>';
}

// What this one input did to the answer, in the shape the box's rule uses:
//   • multiplicative / min — a FACTOR the result is multiplied by ("×1.20")
//   • additive             — a signed share of the starting value ("+20.0%")
//   • formula              — nothing; a formula reads plain values, and the
//                            expression itself is printed above.
function calcInputDetailText(rule: CalcRule, input: TraceInput): string {
  if (input.contribution === undefined) return "";
  if (rule === "additive") {
    const pct = input.contribution * 100;
    return (pct >= 0 ? "+" : "") + pct.toFixed(1) + "%";
  }
  if (rule === "multiplicative" || rule === "min") {
    return "×" + formatScalar(input.contribution);
  }
  return "";
}

function proportionalFactorValueText(input: TraceInput): string {
  return input.contribution === undefined ? "—" : formatScalar(input.contribution);
}

function workedEquationInputValueText(
  rule: CalcRule,
  input: TraceInput,
  inputIndex: number,
): string {
  if (rule === "multiplicative") {
    const multiplicationOperator = inputIndex === 0 ? "" : "× ";
    return multiplicationOperator + proportionalFactorValueText(input);
  }
  if (rule === "min") return proportionalFactorValueText(input);
  return calcInputDetailText(rule, input);
}

function calculationInputTooltip(rule: CalcRule, input: TraceInput): string {
  const currentValueText = formulaBoxTooltip(input.id, [input], !!input.delayed);
  if (rule === "additive") {
    return currentValueText + " · change added to the starting value: " +
      calcInputDetailText(rule, input);
  }
  return currentValueText + " · proportional factor: " +
    proportionalFactorValueText(input) + "×";
}

function calcInputDetailHtml(rule: CalcRule, input: TraceInput): string {
  const text = calcInputDetailText(rule, input);
  return text ? '<span class="calc-input-detail">' + escapeHtml(text) + '</span>' : "";
}

// The two conditional warning sentences, as text. Shared by the renderer and the
// scrub patch so the patch can tell "same notice, new numbers" from "a notice
// appeared" without either copy of the wording drifting.
const DIVIDED_BY_ZERO_NOTICE =
  "Something in the formula divided by zero, so that part was treated as 0.";

function missingInputsNoticeText(missingInputs: string[]): string {
  return "No value found for: " + missingInputs.join(", ") + ". Those parts were treated as 0.";
}

// Which inputs the `min` rule actually settled on. More than one input can have
// the same smallest factor, especially at the starting state where every
// factor is x1.00. Calling whichever row happened to come first the sole gate
// would turn storage order into a mathematical claim, so ties stay ties.
function winningMinInputIndices(inputs: TraceInput[]): number[] {
  const contributions = inputs
    .map(input => input.contribution)
    .filter((contribution): contribution is number => contribution !== undefined);
  if (contributions.length === 0) return [];

  const smallestContribution = Math.min(...contributions);
  const comparisonTolerance = 1e-9 * Math.max(1, Math.abs(smallestContribution));
  const winningIndices: number[] = [];
  for (let inputIndex = 0; inputIndex < inputs.length; inputIndex++) {
    const contribution = inputs[inputIndex].contribution;
    if (contribution === undefined) continue;
    if (Math.abs(contribution - smallestContribution) <= comparisonTolerance) {
      winningIndices.push(inputIndex);
    }
  }
  return winningIndices;
}

function calcInputLabelText(input: TraceInput): string {
  if (input.kind === "param") return input.id;
  const sourceNode = nodeById[input.id];
  return sourceNode ? sourceNode.label : input.id;
}

function joinInputLabels(labels: string[]): string {
  if (labels.length <= 1) return labels[0] || "No input";
  if (labels.length === 2) return labels[0] + " and " + labels[1];
  return labels.slice(0, -1).join(", ") + ", and " + labels[labels.length - 1];
}

function minimumGateSummaryText(inputs: TraceInput[], winningIndices: number[]): string {
  if (winningIndices.length === 0) {
    return "No proportional input factor was available to set the result.";
  }

  const winningInputs = winningIndices.map(inputIndex => inputs[inputIndex]);
  const winningFactor = proportionalFactorValueText(winningInputs[0]) + "×";
  const winningLabels = joinInputLabels(winningInputs.map(calcInputLabelText));
  if (winningInputs.length === 1) {
    return winningLabels + " sets the result because " + winningFactor +
      " is the smallest proportional factor.";
  }
  return winningLabels + " are tied at " + winningFactor +
    ". The first one to fall becomes the gate.";
}

function calculationStartingValueText(node: GraphNode): string {
  if (node.baseline === undefined || node.baseline === null) return "—";
  return formatScalar(node.baseline);
}

function calculationEquationValue(explanation: NodeExplanation): number {
  return explanation.clamp ? explanation.clamp.from : explanation.value;
}

function pinnedCalculationTermText(node: GraphNode, explanation: NodeExplanation): string {
  if (node.baseline === undefined || node.baseline === null || node.baseline === 0) {
    return "Your slider";
  }
  return calculationStartingValueText(node) + " × " +
    formatScalar(explanation.value / node.baseline);
}

function calculationRoleText(
  rule: CalcRule,
  inputs: TraceInput[],
  winningIndices: number[],
): string {
  if (rule === "baseline") return "Starting value sets the result.";
  if (rule === "pinned") return "Your slider sets the result.";
  if (rule === "multiplicative") return "Every input factor shapes the result.";
  if (rule === "additive") return "The input changes combine without compounding.";
  if (rule === "min") return minimumGateSummaryText(inputs, winningIndices);
  return "The formula sets the result directly.";
}

// "Held at the highest allowed value, 100 % — it would have been 132 %."
// Only ever called when a bound ACTUALLY moved the number, so there is always
// a side to name.
function calcClampNoticeText(clamp: NonNullable<NodeExplanation["clamp"]>, unit: string): string {
  const suffix = unit ? " " + unit : "";
  const hitMax = clamp.max !== undefined && !(clamp.from < clamp.max);
  const bound = hitMax ? clamp.max! : clamp.min!;
  const which = hitMax ? "highest allowed value" : "lowest allowed value";
  // A runaway loop can arrive here as Infinity; "would have been Infinity" is
  // no use to anyone, so say what happened instead.
  const wouldHave = Number.isFinite(clamp.from)
    ? "it would have been " + formatScalar(clamp.from) + suffix
    : "without the limit it ran away entirely";
  return "Held at the " + which + ", " + formatScalar(bound) + suffix + " — " + wouldHave + ".";
}

function calculationResultText(node: GraphNode, value: number): string {
  return formatScalar(value) + (node.unit ? " " + node.unit : "");
}

function calculationResultMarkup(node: GraphNode, value?: number): string {
  const result = value === undefined ? "Not calculated" : calculationResultText(node, value);
  return '<div class="calc-result"><span class="calc-result-label">Current result</span>' +
    '<span class="calc-result-value">' + escapeHtml(result) + '</span></div>';
}

export function renderCalculationBreakdown(node: GraphNode): string {
  // Asked for by node, one box at a time: the engine works the breakdown out on
  // demand (and memoises it until the next solve) rather than tracing every box
  // on the map after every solve to have this one entry read. state.explanations
  // is the same thing keyed as a map, for consumers that want to enumerate.
  const explanation = explainNode(node.id);
  if (!explanation) {
    return '<div class="calc-breakdown" data-calc-rule="unavailable">' +
      '<div class="detail-list-title"><span>How this number is calculated</span>' + calculationHelpButton() + '</div>' +
      '<div class="calc-rule">No numeric starting value has been set, so this box has no figure to calculate.</div>' +
      calculationResultMarkup(node) + '</div>';
  }

  const rule = explanation.rule;
  const unit = node.unit || "";
  const inputs = explanation.inputs || [];
  const winningIndices = rule === "min" ? winningMinInputIndices(inputs) : [];
  const winningIndexSet = new Set(winningIndices);

  let html = '<div class="calc-breakdown" data-calc-rule="' + escapeHtml(rule) + '">';
  html +=   '<div class="detail-list-title"><span>How this number is calculated</span>' + calculationHelpButton() + '</div>';
  html +=   '<div class="calc-rule">' + escapeHtml(CALC_RULE_SENTENCE[rule]) + '</div>';

  // Every rule uses the same worked-equation surface. Formula review already
  // shows the expression in its dedicated rule block above, so that one context
  // keeps only the review working and avoids printing a long expression twice.
  const shouldRenderWorkedEquation = rule !== "formula" || !reviewingBox(node);
  const equationValue = calculationEquationValue(explanation);
  if (shouldRenderWorkedEquation) {
    html += '<div class="calc-equation calc-equation--' + escapeHtml(rule) + '" aria-label="Worked equation">';
    if (rule === "baseline") {
      html += '<div class="calc-equation-line"><span>' +
        escapeHtml(calculationStartingValueText(node)) + '</span>';
      html += '<span class="calc-equation-output">= ' + escapeHtml(formatScalar(equationValue)) + '</span></div>';
    } else if (rule === "pinned") {
      html += '<div class="calc-equation-line"><span class="calc-equation-pinned-term">' +
        escapeHtml(pinnedCalculationTermText(node, explanation)) + '</span>';
      html += '<span class="calc-equation-output">= ' + escapeHtml(formatScalar(equationValue)) + '</span></div>';
    } else if (rule === "formula") {
      html += '<div class="calc-equation-formula-line">';
      html += '<div class="calc-formula">' + paintFormula(explanation.formula || "", inputs) + '</div>';
      html += '<span class="calc-equation-output">= ' + escapeHtml(formatScalar(equationValue)) + '</span></div>';
    } else {
      const openingTerm = rule === "multiplicative"
        ? calculationStartingValueText(node) + " × ("
        : rule === "additive"
          ? calculationStartingValueText(node) + " × (1"
          : calculationStartingValueText(node) + " × min(";
      html += '<div class="calc-equation-start"><span class="calc-equation-term">' +
        escapeHtml(openingTerm) + '</span></div>';
    }
  }

  // In the ordinary calculation panel, formula variables already carry their
  // values in hover tooltips and connect to Driven by. Repeating every variable
  // immediately underneath makes the reader reconcile two copies of the same
  // list. A review pass deliberately folds the working away from the expression,
  // so its opened working retains the input rows a reviewer asked to inspect.
  // Link-based rules also retain rows because they have no expression to carry
  // values, factors, delayed badges, or the weakest-link winner.
  if (rule !== "formula" || reviewingBox(node)) {
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i];
      const isWinner = winningIndexSet.has(i);
      const isWorkedEquationInput = rule === "multiplicative" || rule === "additive" || rule === "min";
      const hoverAttributes = isWorkedEquationInput && input.kind === "node"
        ? ' data-calculation-node-id="' + escapeHtml(input.id) + '" data-tooltip="' +
          escapeHtml(calculationInputTooltip(rule, input)) + '"'
        : "";
      html += '<div class="calc-input' + (isWinner ? ' calc-input--winner' : '') +
        '" data-calc-input="' + escapeHtml(input.id) + '"' + hoverAttributes + '>';
      html +=   '<span class="calc-input-label">' + calcInputLabelHtml(input);
      // A delayed read is one solver sweep behind — that's the trick that makes a
      // feedback loop well-defined, and worth saying out loud on the row.
      if (input.delayed) html += ' <span class="calc-badge">previous step</span>';
      html +=   '</span>';
      if (rule === "formula") {
        html += '<span class="calc-input-value">' + escapeHtml(calcInputValueText(input)) + '</span>';
        html += calcInputDetailHtml(rule, input);
      } else {
        html += '<span class="calc-input-detail">' +
          escapeHtml(workedEquationInputValueText(rule, input, i)) + '</span>';
      }
      html += '</div>';
    }
  }

  if (rule === "multiplicative" || rule === "additive" || rule === "min") {
    html +=   '<div class="calc-equation-end"><span>)</span>';
    html +=     '<span class="calc-equation-output">= ' + escapeHtml(formatScalar(equationValue)) + '</span>';
    html +=   '</div>';
  }
  if (shouldRenderWorkedEquation) {
    html += '</div>';
    html += '<div class="calc-equation-summary">' +
      escapeHtml(calculationRoleText(rule, inputs, winningIndices)) + '</div>';
  }

  if (explanation.clamp) {
    html += '<div class="calc-notice calc-notice--clamp">' + escapeHtml(calcClampNoticeText(explanation.clamp, unit)) + '</div>';
  }
  if (explanation.dividedByZero) {
    html += '<div class="calc-notice calc-notice--warn">' + escapeHtml(DIVIDED_BY_ZERO_NOTICE) + '</div>';
  }
  if (explanation.missingInputs && explanation.missingInputs.length) {
    html += '<div class="calc-notice calc-notice--warn">' + escapeHtml(missingInputsNoticeText(explanation.missingInputs)) + '</div>';
  }

  html += calculationResultMarkup(node, explanation.value);
  html += '</div>';
  return html;
}

// =============================================================================
// SCRUB PATCHING — the same panel, with only the numbers rewritten
// -----------------------------------------------------------------------------
// While a slider is moving, everything about the panel except its numbers stays
// put: the same box is selected, with the same rule, the same inputs and the
// same notices. renderDetailPanel() would rebuild all of it — markup, event
// handlers, dropdown upgrades — many times a second, and throw away the user's
// scroll position and focus with it.
//
// So during a scrub we write the new numbers into the existing elements and
// return true. The moment anything STRUCTURAL would differ — a clamp notice
// appearing, a different input winning a `min`, a rule changing, the box
// gaining or losing a row — we return false and the caller does a full render.
// Nothing here decides what the panel says; it only re-states what
// renderQuantFrame / renderCalculationBreakdown would have produced.
// =============================================================================

// Patch the selected box's Current + Δ cells and its calculation breakdown.
// Returns false when the panel has to be rebuilt instead.
export function patchDetailPanelValues(): boolean {
  const selectedId = state.selectedNodeId;
  // Nothing on show — the empty state has no numbers to patch, and a full
  // render would produce the same nothing.
  if (!selectedId) return true;
  const node = nodeById[selectedId];
  if (!node) return false;
  // Edit mode is a different panel (inputs, not values) and isn't a scrub target.
  if (state.uiMode === "edit") return false;
  const content = document.getElementById("detail-content");
  if (!content || content.style.display === "none") return false;

  if (!patchQuantBlock(node, content)) return false;
  return patchCalculationBreakdown(node, content);
}

// The "Current" and "Change vs start" rows of the quantification block.
function patchQuantBlock(node: GraphNode, content: HTMLElement): boolean {
  const block = content.querySelector(".detail-quant-block");
  // A box with no baseline has no block at all in view mode — and no numbers.
  if (!block) return node.baseline === undefined || node.baseline === null;

  const rows = block.querySelectorAll(".detail-quant-row");
  // Layout (view mode): 0 = Starting value, 1 = Current, 2 = Change vs start.
  if (rows.length < 3) return false;

  const unit = node.unit || "";
  const value = state.computedValues[node.id];

  const currentCell = rows[1].querySelector(".detail-quant-value") as HTMLElement | null;
  if (!currentCell) return false;
  const currentInput = currentCell.querySelector("input") as HTMLInputElement | null;
  if (currentInput) {
    // The box the user is holding: never fight what they are typing/dragging.
    if (document.activeElement !== currentInput) {
      currentInput.value = value !== undefined ? formatScalarInput(value) : String(node.baseline);
    }
  } else {
    currentCell.textContent = value !== undefined ? formatScalar(value) + " " + unit : "—";
  }

  const deltaInfo = formatNodeDelta(node.id);
  const deltaCell = rows[2].querySelector(".detail-quant-value") as HTMLElement | null;
  if (!deltaCell) return false;
  deltaCell.textContent = deltaInfo.text || "—";
  deltaCell.style.color = quantDeltaColor(node, deltaInfo.pct);
  return true;
}

// The colour renderQuantFrame paints the Δ row in. Shared so the patched panel
// and the rendered one can never drift apart.
function quantDeltaColor(node: GraphNode, pct: number): string {
  if (Math.abs(pct) < 0.5) return "var(--text-secondary)";
  if (node.direction === "higher_better") return pct > 0 ? "var(--status-good)" : "var(--status-bad)";
  if (node.direction === "lower_better") return pct < 0 ? "var(--status-good)" : "var(--status-bad)";
  return "var(--accent-amber)";
}

// "How this number is calculated": same rule, same inputs in the same order,
// same notices — only the figures move. Anything else and we give up.
function patchCalculationBreakdown(node: GraphNode, content: HTMLElement): boolean {
  const block = content.querySelector(".calc-breakdown");
  const explanation = explainNode(node.id);
  const shouldShow = state.simulationMode;
  if (!block) return !shouldShow;
  if (!shouldShow) return false;

  if (!explanation) {
    if (block.getAttribute("data-calc-rule") !== "unavailable") return false;
    const unavailableResult = block.querySelector(".calc-result-value");
    if (!unavailableResult) return false;
    unavailableResult.textContent = "Not calculated";
    return true;
  }

  const rule = explanation.rule;
  if (block.getAttribute("data-calc-rule") !== rule) return false;

  const inputs = explanation.inputs || [];
  const rows = block.querySelectorAll(".calc-input");
  const expectedRowCount = rule === "formula" && !reviewingBox(node) ? 0 : inputs.length;
  if (rows.length !== expectedRowCount) return false;

  // Slider scrubbing patches this panel instead of rebuilding it. Keep formula
  // hovers synchronized with the new trace values along with the visible rows.
  block.querySelectorAll<HTMLElement>(".fx-box[data-formula-node-id]").forEach(formulaVariable => {
    const nodeIdentifier = formulaVariable.getAttribute("data-formula-node-id");
    if (!nodeIdentifier) return;
    formulaVariable.setAttribute(
      "data-tooltip",
      formulaBoxTooltip(
        nodeIdentifier,
        inputs,
        formulaVariable.getAttribute("data-formula-delayed") === "true",
      ),
    );
  });

  const winningIndices = rule === "min" ? winningMinInputIndices(inputs) : [];
  const winningIndexSet = new Set(winningIndices);
  for (let i = 0; i < expectedRowCount; i++) {
    const row = rows[i];
    const input = inputs[i];
    if (row.getAttribute("data-calc-input") !== input.id) return false;
    // Which input gates a `min` box is part of the story, not a number: if it
    // changed hands, the panel has to be re-rendered to move the badge.
    if (row.classList.contains("calc-input--winner") !== winningIndexSet.has(i)) return false;

    const valueCell = row.querySelector(".calc-input-value");
    const isWorkedEquationInput = rule === "multiplicative" || rule === "additive" || rule === "min";
    if (isWorkedEquationInput) {
      if (valueCell) return false;
    } else {
      if (!valueCell) return false;
      valueCell.textContent = calcInputValueText(input);
    }

    const detailCell = row.querySelector(".calc-input-detail");
    const detailText = isWorkedEquationInput
      ? workedEquationInputValueText(rule, input, i)
      : calcInputDetailText(rule, input);
    if (!detailCell) {
      if (detailText) return false;   // a factor column would have to appear
    } else if (!detailText) {
      return false;                   // …or disappear
    } else {
      detailCell.textContent = detailText;
    }

    if (isWorkedEquationInput && input.kind === "node") {
      if (row.getAttribute("data-calculation-node-id") !== input.id) return false;
      row.setAttribute("data-tooltip", calculationInputTooltip(rule, input));
    }
  }

  const shouldRenderWorkedEquation = rule !== "formula" || !reviewingBox(node);
  if (shouldRenderWorkedEquation) {
    const equationOutput = block.querySelector(".calc-equation-output");
    const equationSummary = block.querySelector(".calc-equation-summary");
    if (!equationOutput || !equationSummary) return false;
    equationOutput.textContent = "= " + formatScalar(calculationEquationValue(explanation));
    equationSummary.textContent = calculationRoleText(rule, inputs, winningIndices);
    if (rule === "pinned") {
      const pinnedTerm = block.querySelector(".calc-equation-pinned-term");
      if (!pinnedTerm) return false;
      pinnedTerm.textContent = pinnedCalculationTermText(node, explanation);
    }
  }

  // Notices are conditional markup, so their presence — and the numbers inside
  // the clamp sentence — decide between patch and rebuild.
  const notices = block.querySelectorAll(".calc-notice");
  const expectedNotices: string[] = [];
  if (explanation.clamp) expectedNotices.push(calcClampNoticeText(explanation.clamp, node.unit || ""));
  if (explanation.dividedByZero) expectedNotices.push(DIVIDED_BY_ZERO_NOTICE);
  if (explanation.missingInputs && explanation.missingInputs.length) {
    expectedNotices.push(missingInputsNoticeText(explanation.missingInputs));
  }
  if (notices.length !== expectedNotices.length) return false;
  for (let i = 0; i < notices.length; i++) {
    if (notices[i].textContent !== expectedNotices[i]) return false;
  }
  const resultValue = block.querySelector(".calc-result-value");
  if (!resultValue) return false;
  resultValue.textContent = calculationResultText(node, explanation.value);
  return true;
}

export function editRow(label: string, controlHtml: string): string {
  return '<div class="detail-edit-row"><span class="detail-edit-label">' + escapeHtml(label) + '</span><div class="detail-edit-control">' + controlHtml + '</div></div>';
}

// The tags a box carries — and, while editing, the control that sets them.
//
// These were two separate things. The strip showed the tags; 330px further down
// a twelve-row checkbox list changed them. Same twelve tags, twice on one
// screen, in two visual languages. Now the strip IS the editor: the tags the
// box has are filled in their own colour, and "+ tag" unfolds the rest as
// outlined chips to click on.
//
// The strip also names the box's row and column while reading. Those are not
// toggles — each is a single choice — so editing shows them under Placement
// instead, as the selects they have always been.
export function renderTagRow(node: GraphNode): string {
  const editing = state.uiMode === "edit";
  const catIds  = nodeCategoryIds(node);

  let html = '<div class="detail-tags' + (editing ? " detail-tags--edit" : "") + '">';

  if (!editing) {
    for (const id of catIds) {
      const c = CATEGORIES[id];
      if (!c) continue;
      html += chipHtml(c.label, c.color);
    }
    const stream = streamById[node.stream];
    const stage  = stageById[node.stage];
    if (stream) html += chipHtml(stream.label, stream.color);
    if (stage)  html += chipHtml(stage.label, null);
    return html + '</div>';
  }

  const on = new Set(catIds);
  const showAll = !!(state.canvasEdit && state.canvasEdit.tagPickerOpen);
  const byClass = splitCategoriesByClass(Object.keys(CATEGORIES));
  const order   = byClass.primary.concat(byClass.secondary);

  for (const id of order) {
    const c = CATEGORIES[id];
    if (!c) continue;
    const isOn = on.has(id);
    // Closed, the strip says what the box IS. Open, it offers everything.
    if (!isOn && !showAll) continue;
    const kind = (c.class || "primary") === "secondary" ? "corner tag" : "fill tag";
    const tip  = (isOn ? "Click to take the " : "Click to give this box the ") + c.label + " " + kind + ".";
    html += '<button type="button" class="filter-chip detail-tag' + (isOn ? " on" : " off") + '"' +
      ' data-field="categoryToggle" data-cat="' + escapeHtml(id) + '"' +
      ' aria-pressed="' + isOn + '" data-tooltip="' + escapeHtml(tip) + '">' +
      '<i style="background:' + escapeHtml(c.color) + '"></i>' +
      '<span class="filter-chip-label">' + escapeHtml(c.label) + '</span></button>';
  }

  html += '<button type="button" class="filter-chip detail-tag-more" data-action="toggle-tag-picker"' +
    ' data-tooltip="' + (showAll ? "Hide the tags this box doesn't have" : "Show every tag") + '">' +
    '<span class="filter-chip-label">' + (showAll ? "− less" : "+ tag") + '</span></button>';

  return html + '</div>';
}

// The panel's tags are the SAME pill the drawer uses — .filter-chip, defined
// once in 04-sidebar.css. They were mono uppercase blocks filled with the tag's
// own colour: three of them wrapped to two lines and shouted louder than the
// box's name directly underneath. A dot carries the colour; the label is what
// you read.
function chipHtml(label: string, color: string | null): string {
  return '<span class="filter-chip detail-tag">' +
    (color ? '<i style="background:' + escapeHtml(color) + '"></i>' : '<i class="plain"></i>') +
    '<span class="filter-chip-label">' + escapeHtml(label) + '</span></span>';
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

  const openId = (state.canvasEdit && state.canvasEdit.openEdgeId) || null;

  let html = '<div class="outgoing-edges-block">';
  html +=   '<div class="detail-list-title"><span>Drives</span><span class="count">' + outgoing.length + '</span></div>';

  if (outgoing.length === 0) {
    html += '<div class="outgoing-edges-empty">No links out yet. Drag from the right edge of this box on the map, or add one below.</div>';
  } else {
    // One line per link, reading the same way the "Driven by" list above it does:
    // direction, name, strength. Click one and its controls unfold underneath.
    //
    // Every link used to be a 121px block — a header, a row of three controls
    // and a two-line description box — all of it on screen at once. Ten links
    // was 1200px of form to scroll past to find the one you wanted, and the
    // list stopped being a list.
    for (const edge of outgoing) {
      const target = nodeById[edge.to];
      const defaultElasticity = DEFAULT_ELASTICITY_BY_EFFECT[edge.effect];
      const isOpen = edge.id === openId;
      const flashClass = (edge.id === flashedId) ? " flash" : "";
      // The same signed, sign-normalised figure the reading rows print, so a
      // link reads identically whichever mode you are in.
      const elasticity = resolveEdgeElasticity(edge);
      const strength = (elasticity > 0 ? "+" : elasticity < 0 ? "−" : "")
        + Math.abs(elasticity).toFixed(2);

      html += '<button type="button" class="drow drow--edit ' + edge.effect + (isOpen ? " open" : "") + flashClass + '"' +
        ' data-edge-row-id="' + escapeHtml(edge.id) + '" data-edge-open="' + escapeHtml(edge.id) + '"' +
        ' aria-expanded="' + isOpen + '"' +
        ' data-tooltip="' + escapeHtml((isOpen ? "Close" : "Edit") + " this link") + '">' +
        '<span class="drow-dir">→</span>' +
        '<span class="drow-name">' + escapeHtml(target ? target.label : edge.to) + '</span>' +
        '<span class="drow-kind ' + edge.effect + '"></span>' +
        '<span class="drow-num">' + escapeHtml(strength) + '</span>' +
        '</button>';

      if (!isOpen) continue;

      html += '<div class="edge-open" data-edge-row-id="' + escapeHtml(edge.id) + '">';
      html +=   '<div class="detail-quant-row"><span class="detail-quant-label">Effect</span>' +
                '<span class="detail-quant-control"><select class="detail-edit-input detail-edit-select" data-edge-id="' + escapeHtml(edge.id) + '" data-edge-field="effect">';
      for (const eff of EFFECT_OPTIONS) {
        html +=   '<option value="' + eff + '"' + (edge.effect === eff ? " selected" : "") + '>' + eff + '</option>';
      }
      html +=   '</select></span></div>';
      const targetFormulaIsActive = !!target && explainNode(target.id)?.rule === "formula";
      const strengthTooltip = targetFormulaIsActive
        ? "This target uses a formula, so the link still documents the causal input but its Strength is ignored."
        : "Target percentage change per source percentage change. Effect sets direction; Strength sets magnitude. Use this for a proportional response, or leave blank for the default.";
      html +=   '<div class="detail-quant-row"><span class="detail-quant-label" data-tooltip="' + escapeHtml(strengthTooltip) + '">Strength</span>' +
                '<input type="number" step="any" class="detail-edit-input detail-edit-number detail-quant-input outgoing-edge-elasticity" data-edge-id="' + escapeHtml(edge.id) + '" data-edge-field="elasticity" value="' + (edge.elasticity !== undefined && edge.elasticity !== null ? edge.elasticity : "") + '" placeholder="default ' + defaultElasticity + '"></div>';
      html +=   '<div class="detail-quant-row"><span class="detail-quant-label">Line</span>' +
                '<span class="detail-quant-control"><select class="detail-edit-input detail-edit-select outgoing-edge-style" data-edge-id="' + escapeHtml(edge.id) + '" data-edge-field="style">' +
                  '<option value="solid"'  + (edge.style === "dashed" ? "" : " selected") + '>Solid</option>' +
                  '<option value="dashed"' + (edge.style === "dashed" ? " selected" : "") + '>Dashed</option>' +
                '</select></span></div>';
      html +=   '<textarea class="detail-edit-input detail-edit-textarea outgoing-edge-description" data-edge-id="' + escapeHtml(edge.id) + '" data-edge-field="description" rows="2" placeholder="Optional description">' + escapeHtml(edge.description || "") + '</textarea>';
      html +=   renderEvidenceEditor({ metadata: edge.evidence, scope: "edge" });
      html +=   '<div class="edge-open-actions">';
      html +=     '<button class="detail-edit-link" data-jump-node="' + escapeHtml(edge.to) + '">Go to this box →</button>';
      html +=     '<button class="detail-edit-link danger" data-edge-action="delete" data-edge-id="' + escapeHtml(edge.id) + '">Delete link</button>';
      html +=   '</div>';
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
    // The last row of the "Drives" list, not a button parked under it: adding a
    // link is the same kind of act as editing one, and it reads as belonging to
    // the list when it sits in it.
    html += '<button type="button" class="drow drow--edit drow--add" data-action="show-add-edge">' +
      '<span class="drow-dir">+</span>' +
      '<span class="drow-name">Add a link out</span>' +
      '</button>';
  }

  html += '</div>';
  return html;
}

// =============================================================================
// HANDLERS
// =============================================================================

export function wireSharedHandlers(node: GraphNode, contentState: HTMLElement): void {
  // Open the atlas on this box: everything downstream of it, as one picture.
  const atlasButton = contentState.querySelector("[data-action='open-atlas']");
  if (atlasButton) {
    atlasButton.addEventListener("click", () => {
      if (typeof openAtlas === "function") openAtlas(node.id);
    });
  }

  const simulateBoxButton = contentState.querySelector("[data-action='simulate-box']");
  if (simulateBoxButton) {
    simulateBoxButton.addEventListener("click", () => {
      if (!state.simulationMode) toggleSimulationMode();
      const input = document.querySelector<HTMLInputElement>(
        '.sim-pct-input[data-node-id="' + CSS.escape(node.id) + '"]',
      );
      if (input) input.focus();
    });
  }

  const editBoxButton = contentState.querySelector("[data-action='edit-box']");
  if (editBoxButton) {
    editBoxButton.addEventListener("click", () => setUiMode("edit"));
  }

  // The "?" beside the formula editor and the calculation breakdown.
  contentState.querySelectorAll("[data-action='calculation-help']").forEach(button => {
    button.addEventListener("click", () => {
      openLearnReference(referenceCardForNode(node).id);
    });
  });

  // Edge stripes navigate to the connected node — in BOTH modes. In edit, the
  // Direct Inputs are read-only links to the source node where they're edited.
  // Keyed on the attribute it reads, not on a styling class: the row's look has
  // changed once already and took this handler's selector with it.
  contentState.querySelectorAll("[data-target-node]").forEach(item => {
    item.addEventListener("click", () => {
      const targetNodeId = item.getAttribute("data-target-node")!;
      focusNode(targetNodeId);
      scrollNodeIntoView(targetNodeId);
    });
  });

  // Calculation working and the list above name the same boxes in different
  // ways. Hover joins those views so a reader can see which direct input the
  // formula token or proportional factor is referring to.
  contentState.querySelectorAll<HTMLElement>(
    ".fx-box[data-formula-node-id], .calc-input[data-calculation-node-id]",
  ).forEach(calculationInput => {
    const nodeIdentifier = calculationInput.getAttribute("data-formula-node-id") ||
      calculationInput.getAttribute("data-calculation-node-id");
    if (!nodeIdentifier) return;
    const matchingDrivenByRows = contentState.querySelectorAll<HTMLElement>(
      '.drow[data-edge-direction="from"][data-target-node="' + CSS.escape(nodeIdentifier) + '"]',
    );
    const setHighlighted = (highlighted: boolean): void => {
      matchingDrivenByRows.forEach(row =>
        row.classList.toggle("is-formula-variable-highlight", highlighted),
      );
    };
    calculationInput.addEventListener("mouseenter", () => setHighlighted(true));
    calculationInput.addEventListener("mouseleave", () => setHighlighted(false));
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

  wireReviewCardHandlers(node, contentState);
}

// ───── The review card's controls ─────────────────────────────────────────
// Every one of these ends in a re-render, because a verdict changes the card
// (the button lights, the byline gains a name and a fingerprint) and the map
// (the box's coverage mark). The note is the exception: it is saved as you type
// and must NOT re-render, or the field would lose focus mid-word.
function wireReviewCardHandlers(node: GraphNode, contentState: HTMLElement): void {
  contentState.querySelectorAll("[data-review]").forEach(button => {
    button.addEventListener("click", event => {
      event.stopPropagation();
      const what = (event.currentTarget as HTMLElement).getAttribute("data-review");
      const close = contentState.querySelector("[data-review-close]") as HTMLTextAreaElement | null;
      const result = reviewAction(node.id, what || "", { addressedNote: close ? close.value : undefined });
      // Refused: nothing was written, so nothing should move either. The button
      // is disabled until the account is there, so this is the second line.
      if (result.refused) { if (close) close.focus(); return; }
      scheduleReviewSave();
      // A verdict changes the box's coverage mark on the map as well as the
      // card. focusNode() repaints on its way to the next box; when the pass
      // stays put (Flag, or the end of the queue) the repaint has to be asked
      // for.
      if (result.goTo) {
        focusNode(result.goTo);
        scrollNodeIntoView(result.goTo);
      } else if (result.ended) {
        // Ending from the card: the panel goes back to describing the box, and
        // every coverage mark comes off the map.
        renderDetailPanel();
        render();
      } else {
        renderDetailPanel();
        renderSelectionChange();
      }
    });
  });

  // The working, folded. A re-render is safe here in a way it is not for the
  // text fields: the click landed on a button, so there is no half-typed word
  // to lose.
  contentState.querySelectorAll("[data-review-working]").forEach(button => {
    button.addEventListener("click", event => {
      event.stopPropagation();
      const boxId = (event.currentTarget as HTMLElement).getAttribute("data-review-working")!;
      setReviewWorkingOpen(workingOpenFor === boxId ? null : boxId);
      renderDetailPanel();
    });
  });

  contentState.querySelectorAll("[data-flag-source]").forEach(button => {
    button.addEventListener("click", event => {
      event.stopPropagation();
      // The row behind this is a jump-to-box button; flagging must not also
      // navigate away from the box being reviewed.
      event.preventDefault();
      const sourceId = (event.currentTarget as HTMLElement).getAttribute("data-flag-source")!;
      toggleSourceFlag(node.id, sourceId);
      renderDetailPanel();
      scheduleReviewSave();
      // Flagging one link can turn an agreement into a concern, and the box's
      // coverage mark on the map is drawn off the verdict — so the map has to be
      // told, exactly as it is for the verdict buttons above.
      renderSelectionChange();
    });
  });

  // ── The two text fields, and the buttons that follow them ──────────────
  // Neither field re-renders the card as it is typed in — the textarea would
  // lose focus after the first character. So everything that depends on their
  // contents is updated by hand here, on every keystroke: whether the box is
  // flagged, whether Agreed is available, and whether the response field is
  // even on screen. This is the price of not re-rendering, and the alternative
  // (a card that repaints mid-word) is worse.
  const note = contentState.querySelector("[data-review-note]") as HTMLTextAreaElement | null;
  const close = contentState.querySelector("[data-review-close]") as HTMLTextAreaElement | null;

  function syncVerdictControls(): void {
    const agree = contentState.querySelector('[data-review="agree"]') as HTMLButtonElement | null;
    const flag = contentState.querySelector('[data-review="flag"]') as HTMLButtonElement | null;
    const wanted = needsResponse(node.id);
    const entry = entryFor(node.id);
    if (agree) {
      agree.disabled = wanted;
      agree.classList.toggle("on", reviewStateOf(node.id) === "agreed");
    }
    if (flag) flag.classList.toggle("on", reviewStateOf(node.id) === "flagged");
    // Never taken away from under the caret. This runs on every keystroke, and
    // on a box that no longer needs a response — one already agreed — clearing
    // the field to rewrite it made the field itself disappear mid-edit, taking
    // the focus with it. A field somebody is standing in stays.
    if (close && document.activeElement !== close) {
      close.hidden = !(wanted || (entry && entry.addressedNote.trim()));
    }
  }

  if (note) {
    note.addEventListener("input", () => {
      const entry = entryFor(node.id);
      // Whether this keystroke moved the VERDICT, as against the words. The map
      // draws a coverage mark off the verdict, so it has to repaint when one
      // changes — and must not repaint when one has not, since that would be a
      // pass over every box on the map per character typed.
      let verdictMoved = false;
      if (entry) {
        entry.note = note.value;
        // Writing a concern IS raising one, whatever the box stood at before.
        // That includes a box already AGREED: this field says "what is wrong",
        // so writing in it is a new concern, and leaving the agreement standing
        // would let somebody type an objection into a box that still reads as
        // signed off. Only a box already flagged is left alone — it is already
        // the thing typing here would make it.
        if (entry.verdict !== "flagged" && note.value.trim()) {
          recordVerdict(node.id, "flagged", { note: note.value });
          verdictMoved = true;
        }
      } else {
        // Typing a note before pressing anything is a real thing to do — it is
        // often what you write while deciding. It flags the box, because an
        // unexplained note is closer to a doubt than to an agreement, and a
        // doubt nobody records is the thing this whole record exists to catch.
        recordVerdict(node.id, "flagged", { note: note.value });
        verdictMoved = true;
      }
      syncVerdictControls();
      scheduleReviewSave();
      if (verdictMoved) renderSelectionChange();
    });
  }

  if (close) {
    close.addEventListener("input", () => {
      const entry = entryFor(node.id);
      // Held on the entry as it is typed, exactly as the note is, so switching
      // box and coming back does not lose it.
      if (entry) { entry.addressedNote = close.value; scheduleReviewSave(); }
      syncVerdictControls();
    });
  }
}

export function wireEditModeHandlers(node: GraphNode, contentState: HTMLElement): void {
  // Node-field edits.
  contentState.querySelectorAll("[data-field]").forEach(input => {
    if (input.hasAttribute("data-edge-field")) return;     // edge inputs wired below
    if (input.classList.contains("detail-tag")) return;   // the tag pills are click-wired below
    const field = input.getAttribute("data-field");
    if (!field) return;
    const editableInput = input as HTMLInputElement;
    const commitsWhileTyping = editableInput.matches('input[type="text"], input[type="number"], textarea');
    if (commitsWhileTyping) {
      input.addEventListener("input", () => {
        const continuingEdit = activeNodeTypingInputs.has(editableInput);
        activeNodeTypingInputs.add(editableInput);
        applyNodeFieldEdit(node, field, editableInput, continuingEdit);
      });
      input.addEventListener("change", () => {
        const editWasAlreadyApplied = activeNodeTypingInputs.has(editableInput);
        activeNodeTypingInputs.delete(editableInput);
        // Keyboard editing emits input before change. A programmatic or
        // assistive-technology change can arrive alone, so keep that path
        // fully functional without adding a duplicate mutation on blur.
        if (!editWasAlreadyApplied) applyNodeFieldEdit(node, field, editableInput);
      });
      input.addEventListener("blur", () => activeNodeTypingInputs.delete(editableInput));
      return;
    }
    input.addEventListener("change", () => applyNodeFieldEdit(node, field, editableInput));
  });

  // Outgoing-edges row edits + delete. The controls sit in the unfolded panel
  // under whichever link row is open (.edge-open), not in the row itself.
  contentState.querySelectorAll(".edge-open [data-edge-field]").forEach(input => {
    const edgeId = input.getAttribute("data-edge-id")!;
    const field  = input.getAttribute("data-edge-field")!;
    input.addEventListener("change", () => {
      applyEdgeFieldEdit(edgeId, field, input as HTMLInputElement);
    });
  });
  contentState.querySelectorAll('[data-evidence-scope="formula"][data-evidence-field]').forEach(input => {
    const field = input.getAttribute("data-evidence-field") as keyof EvidenceMetadata | null;
    if (!field) return;
    wireEvidenceInput(
      input as EvidenceControl,
      field,
      (skipHistoryCapture) => applyFormulaEvidenceFieldEdit(
        node,
        field,
        input as EvidenceControl,
        skipHistoryCapture,
      ),
    );
  });
  contentState.querySelectorAll('.edge-open [data-evidence-scope="edge"][data-evidence-field]').forEach(input => {
    const edgeEditor = input.closest(".edge-open");
    const edgeId = edgeEditor?.getAttribute("data-edge-row-id");
    const field = input.getAttribute("data-evidence-field") as keyof EvidenceMetadata | null;
    if (!edgeId || !field) return;
    wireEvidenceInput(
      input as EvidenceControl,
      field,
      (skipHistoryCapture) => applyEdgeEvidenceFieldEdit(
        edgeId,
        field,
        input as EvidenceControl,
        skipHistoryCapture,
      ),
    );
  });
  contentState.querySelectorAll("[data-jump-node]").forEach(btn => {
    btn.addEventListener("click", () => {
      const targetId = btn.getAttribute("data-jump-node")!;
      if (nodeById[targetId]) {
        focusNode(targetId);
        scrollNodeIntoView(targetId);
      }
    });
  });

  // Unfold one link's controls. Clicking the open row folds it again, so the
  // list can always be returned to a plain list.
  contentState.querySelectorAll("[data-edge-open]").forEach(row => {
    row.addEventListener("click", () => {
      const id = row.getAttribute("data-edge-open")!;
      state.canvasEdit.openEdgeId = (state.canvasEdit.openEdgeId === id) ? null : id;
      renderDetailPanel();
    });
  });

  // Show every tag, or only the ones this box carries.
  const tagMore = contentState.querySelector("[data-action='toggle-tag-picker']");
  if (tagMore) {
    tagMore.addEventListener("click", event => {
      event.preventDefault();
      state.canvasEdit.tagPickerOpen = !state.canvasEdit.tagPickerOpen;
      renderDetailPanel();
    });
  }

  // The tag chips are buttons now, not checkboxes, so they report their own
  // new state to applyNodeFieldEdit rather than the browser doing it.
  contentState.querySelectorAll(".detail-tag[data-cat]").forEach(chip => {
    chip.addEventListener("click", () => {
      // applyNodeFieldEdit reads a checkbox: type + checked + data-cat. A
      // chip is a button, so hand it those three and nothing else — the write
      // path stays exactly as it was when this was a list of checkboxes.
      applyNodeFieldEdit(node, "categoryToggle", {
        type: "checkbox",
        checked: chip.getAttribute("aria-pressed") !== "true",
        getAttribute: (name: string) => chip.getAttribute(name),
      } as unknown as HTMLInputElement);
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

// Text and number fields update the map on every input event so the canvas,
// calculations and tutorial gates respond immediately. Keep one history entry
// for the entire focus session rather than adding an undo step per character.
const activeNodeTypingInputs = new WeakSet<HTMLInputElement>();

// Text provenance must reach the model on `input`, not only after blur: a tab
// can be closed while the caret is still in the field. The first keystroke
// captures the pre-edit undo snapshot; the rest of that focus session update
// the same edit without adding one history entry per character. Every input
// still refreshes the pending CSV, so pagehide can flush the latest text.
type EvidenceControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

const activeEvidenceTypingInputs = new WeakSet<EvidenceControl>();

function wireEvidenceInput(
  input: EvidenceControl,
  field: keyof EvidenceMetadata,
  applyEdit: (skipHistoryCapture: boolean) => void,
): void {
  const commitsWhileTyping = field === "rationale" || field === "source";
  if (commitsWhileTyping) {
    input.addEventListener("input", () => {
      const continuingEdit = activeEvidenceTypingInputs.has(input);
      activeEvidenceTypingInputs.add(input);
      applyEdit(continuingEdit);
    });
    input.addEventListener("change", () => activeEvidenceTypingInputs.delete(input));
    input.addEventListener("blur", () => activeEvidenceTypingInputs.delete(input));
    return;
  }
  input.addEventListener("change", () => {
    applyEdit(false);
    syncEvidenceBadgeForInput(input);
  });
}

function syncEvidenceBadgeForInput(input: HTMLElement): void {
  if (input.getAttribute("data-evidence-field") !== "status") return;
  const badge = input.closest(".evidence-editor")?.querySelector(".evidence-badge") as HTMLElement | null;
  if (!badge) return;
  const status = normaliseEvidenceStatus((input as HTMLInputElement).value);
  badge.className = "evidence-badge evidence-" + status;
  badge.textContent = evidenceStatusLabel(status);
}

// =============================================================================
// FIELD WRITES
// =============================================================================

export function applyNodeFieldEdit(
  node: GraphNode,
  field: string,
  input: HTMLInputElement,
  skipHistoryCapture = false,
): void {
  let value: string | number | boolean | undefined;
  if (input.type === "checkbox") value = input.checked;
  else if (input.type === "number") {
    value = parseStrictFiniteNumber(input.value);
    if (!isBlankInput(input.value) && value === undefined) {
      input.setCustomValidity("Use a finite decimal number.");
      input.reportValidity();
      return;
    }
    input.setCustomValidity("");
  } else {
    value = input.value;
  }

  // Plain text / number fields don't affect layout — skip the detail-panel
  // re-render so focus (and tab order) is preserved as the user moves
  // between fields. Layout-affecting changes (stream / stage / category /
  // controllable / direction) trigger a full re-render so the panel reflects
  // the new state.
  let skipDetailRender = false;
  let mutationImpact: "topology" | "calculation" | "presentation" = "topology";
  let searchableDataChanged = false;

  if (field === "label") {
    const trimmed = String(value).trim();
    node.label = trimmed || "Untitled";
    input.value = node.label;
    skipDetailRender = true;
  } else if (field === "description") {
    node.description = String(value || "");
    skipDetailRender = true;
    mutationImpact = "presentation";
    searchableDataChanged = true;
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
    else if ((value as number) <= 0) {
      input.setCustomValidity("Starting value must be positive or blank.");
      input.reportValidity();
      input.value = node.baseline === undefined ? "" : String(node.baseline);
      return;
    } else {
      node.baseline = value as number;
    }
    skipDetailRender = true;
    mutationImpact = "calculation";
  } else if (field === "unit") {
    if (value) node.unit = String(value); else delete node.unit;
    skipDetailRender = true;
    mutationImpact = "presentation";
    searchableDataChanged = true;
  } else if (field === "controllable") {
    if (value) node.controllable = true; else delete node.controllable;
  } else if (field === "direction") {
    if (value) node.direction = value as GraphNode["direction"]; else delete node.direction;
  } else if (field === "sliderMax") {
    if (value === undefined) delete node.sliderMax;
    else if ((value as number) < 1) {
      input.setCustomValidity("Slider max must be at least 1.");
      input.reportValidity();
      input.value = node.sliderMax === undefined ? "" : String(node.sliderMax);
      return;
    } else {
      node.sliderMax = value as number;
    }
    skipDetailRender = true;
    mutationImpact = "calculation";
  } else if (field === "combine") {
    // Blank (and the redundant explicit "multiplicative") means "no combine
    // column at all" — the standard rule, and the shape an untouched CSV has.
    if (value === "additive" || value === "min") node.combine = value as CombineMode;
    else                                         delete node.combine;
  } else if (field === "formula") {
    // Stored verbatim, exactly as the CSV would. Anything wrong with it —
    // syntax, an unknown name, a missing arrow — is reported by the loader's
    // validation on the way back in, not swallowed here.
    const text = String(value || "").trim();
    if (text) node.formula = text; else delete node.formula;
    skipDetailRender = true;
  } else if (field === "minValue") {
    // TS calls these minValue/maxValue; the CSV columns are min/max.
    if (value === undefined) delete node.minValue;
    else if (node.maxValue !== undefined && (value as number) > node.maxValue) {
      input.setCustomValidity("Minimum cannot be above the current maximum.");
      input.reportValidity();
      input.value = node.minValue === undefined ? "" : String(node.minValue);
      return;
    } else {
      node.minValue = value as number;
    }
    skipDetailRender = true;
    mutationImpact = "calculation";
  } else if (field === "maxValue") {
    if (value === undefined) delete node.maxValue;
    else if (node.minValue !== undefined && (value as number) < node.minValue) {
      input.setCustomValidity("Maximum cannot be below the current minimum.");
      input.reportValidity();
      input.value = node.maxValue === undefined ? "" : String(node.maxValue);
      return;
    } else {
      node.maxValue = value as number;
    }
    skipDetailRender = true;
    mutationImpact = "calculation";
  }

  if (typeof applyCanvasMutation === "function") {
    applyCanvasMutation({
      skipDetailRender: skipDetailRender,
      impact: mutationImpact,
      searchableDataChanged: searchableDataChanged,
      skipHistoryCapture: skipHistoryCapture,
    });
  }
}

export function applyEdgeFieldEdit(edgeId: string, field: string, input: HTMLInputElement): void {
  const edge = edgeById[edgeId];
  if (!edge) return;
  if (field === "effect") {
    if (!EFFECT_OPTIONS.includes(input.value)) return;
    edge.effect = input.value as EffectKind;
    markEdgeGeometryChanged();
  } else if (field === "style") {
    if (input.value === "dashed") edge.style = "dashed"; else delete edge.style;
    markEdgeGeometryChanged();
    // Line style doesn't affect layout — preserve focus.
    if (typeof applyCanvasMutation === "function") {
      applyCanvasMutation({ skipDetailRender: true, impact: "presentation" });
    }
    return;
  } else if (field === "elasticity") {
    const elasticityValue = parseStrictFiniteNumber(input.value);
    if (!isBlankInput(input.value) && elasticityValue === undefined) {
      input.setCustomValidity("Use a finite decimal number.");
      input.reportValidity();
      input.value = edge.elasticity === undefined ? "" : String(edge.elasticity);
      return;
    }
    input.setCustomValidity("");
    if (elasticityValue === undefined) delete edge.elasticity;
    else edge.elasticity = elasticityValue;
    markEdgeGeometryChanged();
    // Editing elasticity / description doesn't change layout — preserve focus.
    if (typeof applyCanvasMutation === "function") {
      applyCanvasMutation({ skipDetailRender: true, impact: "calculation" });
    }
    return;
  } else if (field === "description") {
    edge.description = String(input.value || "");
    if (typeof applyCanvasMutation === "function") {
      applyCanvasMutation({ skipDetailRender: true, impact: "presentation" });
    }
    return;
  }
  if (typeof applyCanvasMutation === "function") applyCanvasMutation();
}

export function applyFormulaEvidenceFieldEdit(
  node: GraphNode,
  field: keyof EvidenceMetadata,
  input: EvidenceControl,
  skipHistoryCapture = false,
): void {
  node.formulaEvidence = updateEvidenceMetadata(node.formulaEvidence, field, input.value);
  if (typeof applyCanvasMutation === "function") {
    applyCanvasMutation({
      skipDetailRender: true,
      impact: "presentation",
      skipHistoryCapture,
    });
  }
}

export function applyEdgeEvidenceFieldEdit(
  edgeId: string,
  field: keyof EvidenceMetadata,
  input: EvidenceControl,
  skipHistoryCapture = false,
): void {
  const edge = edgeById[edgeId];
  if (!edge) return;
  edge.evidence = updateEvidenceMetadata(edge.evidence, field, input.value);
  if (typeof applyCanvasMutation === "function") {
    applyCanvasMutation({
      skipDetailRender: true,
      impact: "presentation",
      skipHistoryCapture,
    });
  }
}

// =============================================================================
// SHARED — edge-list rendering used by view mode
// =============================================================================

export function renderEdgeList(
  title: string,
  items: Array<{ edge: Edge; otherNode: GraphNode }>,
  direction: string,
  emptyText: string,
  review?: { boxId: string; strengthsIgnored?: boolean },
): string {
  let html = '<div class="detail-list-title">';
  html +=     '<span>' + escapeHtml(title) + '</span>';
  html +=     '<span class="count">' + items.length + '</span>';
  html +=   '</div>';
  if (items.length === 0) {
    html += '<div class="drow-empty">' + escapeHtml(emptyText) + '</div>';
  } else {
    for (const item of items) {
      html += renderEdgeItem(item.otherNode, item.edge, direction, review);
    }
  }
  return html;
}

// ONE LINE. It used to be three — the name and its strength, the effect word
// under them, then the link's own sentence — so a box with six causes spent
// eighteen lines saying what six rows can say. The sentence moves to the
// tooltip, where the link's declared kind goes with it; what stays on the row
// is what the maths actually uses, in the column every other number in this
// panel lands in.
//
// The kind (increases / decreases / enables) is a LABEL on the link, and the
// signed strength is what the engine reads. They can disagree — the border map
// has an "increases" link carrying −0.50 — so the number is what the row shows
// and the word is a hover away, rather than the two competing for the same
// glance.
export function renderEdgeItem(
  otherNode: GraphNode,
  edge: Edge,
  direction: string,
  review?: { boxId: string; strengthsIgnored?: boolean },
): string {
  const arrow = direction === "from" ? "←" : "→";
  const elasticity = resolveEdgeElasticity(edge);
  const strength = (elasticity > 0 ? "+" : elasticity < 0 ? "−" : "")
    + Math.abs(elasticity).toFixed(2);
  const weight = elasticity > 0 ? " pos" : elasticity < 0 ? " neg" : "";

  // Kind first, then the sentence: the tooltip is the row's long form, and the
  // word is the part of it a reader is most likely to be checking.
  const tip = edge.effect + (edge.description ? " — " + edge.description : "");
  const jumpDir = direction === "from" ? "(drives this box)" : "(driven by this box)";
  // A strength nobody set. Worth saying HERE, on the row, while the reader is
  // judging it — on the border map every one of Detection & Seizure Rate's seven
  // links is riding on the per-effect default and nothing in the app said so.
  const defaulted = edge.elasticity === undefined || edge.elasticity === null;
  // Where the strengths are ignored — a formula box — "nobody set this one" is
  // beside the point, and pointing at it invites a fix that would change
  // nothing. The number itself is struck through instead, once, and the rule
  // block above says why.
  const moot = !!(review && review.strengthsIgnored);
  const defaultMark = (review && defaulted && !moot)
    ? ' <span class="drow-default" data-tooltip="No strength was set on this link — it is using the default for its effect type.">default</span>'
    : "";

  // Still a real <button>, still carrying data-target-node: Tab reaches it,
  // Enter follows it, and the click handler in wireViewModeHandlers is untouched.
  const row = '<button type="button" class="drow"'
    + ' data-target-node="' + escapeHtml(otherNode.id) + '"'
    + ' data-edge-direction="' + escapeHtml(direction) + '"'
    + ' data-tooltip="' + escapeHtml(tip) + '"'
    + ' aria-label="' + escapeHtml(otherNode.label) + ', strength ' + strength + ', '
    + escapeHtml(edge.effect) + ' ' + jumpDir + '. Jump to it.">'
    + '<span class="drow-dir">' + arrow + '</span>'
    + '<span class="drow-name">' + escapeHtml(otherNode.label) + '</span>'
    + defaultMark
    + '<span class="drow-num' + weight + (moot ? " is-moot" : "") + '"'
    + (moot ? ' data-tooltip="This box is computed from its rule, not from its arrows — this strength is not read."' : "")
    + '>' + strength + '</span>'
    + '</button>';
  if (!review) return row;

  // The row is itself a <button>, so the flag cannot live inside it — a button
  // in a button is invalid, and the click would reach the wrong handler. Sibling
  // in a flex wrapper instead, which also keeps the row's own hit area intact.
  const flagged = isSourceFlagged(review.boxId, otherNode.id);
  return '<div class="drow-review' + (flagged ? " is-flagged" : "") + '">' + row
    + '<button type="button" class="drow-flag" data-flag-source="' + escapeHtml(otherNode.id) + '"'
    + ' data-tooltip="' + (flagged ? "Flagged. Click to clear." : "Flag just this link — a note about one input, not the whole list.") + '"'
    + ' aria-pressed="' + (flagged ? "true" : "false") + '">' + (flagged ? "flagged" : "flag") + '</button>'
    + '</div>';
}
