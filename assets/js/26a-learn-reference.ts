// =============================================================================
// LEARN — CALCULATION REFERENCE SHELF
// -----------------------------------------------------------------------------
// Choosing how a box calculates is a decision, not a tour. This module holds the
// sixteen reference entries that used to be read-only steps inside the Learn
// lessons, and shows them as a browsable two-pane shelf that can be opened from
// the Learn hub or from the "?" beside the formula editor — i.e. at the moment
// the question is actually being asked.
//
// The prose is carried over word for word from the lessons it replaces. The one
// piece of new copy per entry is `useWhen`: a single plain sentence naming the
// decision, so a reader can scan the list without already knowing the answer.
//
// The shelf owns its own layer element (`#learn-reference-layer`, created on
// first open) rather than sharing the tutorial's, so the two surfaces can be
// rendered, styled and torn down independently.
// =============================================================================

import { appName } from "./00-brand";
import type { GraphNode } from "./types";
import { escapeHtml } from "./04-utils";

export type LearnReferenceGroup = "combine" | "constraint" | "feedback" | "syntax";

export interface LearnReferenceCard {
  /** Stable kebab-case slug — used as the deep-link target from other surfaces. */
  id: string;
  group: LearnReferenceGroup;
  title: string;
  /** One plain sentence naming the decision this entry settles. */
  useWhen: string;
  whatItDoes: string;
  whyThisChoice: string;
  howToApplyIt: string;
  howToEvaluateIt: string;
  /** The box the matching Learn lesson used to demonstrate this entry. */
  exampleNodeId?: string;
  /** A related point the lesson body never made. Rendered as a fifth paragraph,
   *  so the four carried-over ones stay exactly as they were written. */
  alsoWorthKnowing?: string;
}

export const LEARN_REFERENCE_GROUP_TITLES: Record<LearnReferenceGroup, string> = {
  combine: "Choosing a combine rule",
  constraint: "Caps, shares and limits",
  feedback: "Delays and feedback",
  syntax: "Syntax you can use",
};

export const LEARN_REFERENCE_CARDS: LearnReferenceCard[] = [
  // ── Choosing a combine rule ───────────────────────────────────────────────
  {
    id: "start-with-the-question",
    group: "combine",
    title: "Start with the question the box must answer",
    useWhen: "Use this when you are deciding whether a box needs a written formula at all, or whether Strength and Combine will do.",
    whatItDoes: "A formula calculates from actual values and units. Without a formula, Strength and Combine calculate from each input's percentage change from its starting value. A formula always takes precedence.",
    whyThisChoice: "People reached has a known hours × rate calculation, while Workshop readiness is an estimated response to several influences.",
    howToApplyIt: "Use a formula when you can state the arithmetic and units. Use Strength and Combine when you know direction and relative sensitivity but not an absolute equation.",
    howToEvaluateIt: "Explain the rule in one plain sentence, confirm it reproduces the starting value, check that every named box variable has an incoming arrow, and document global variables separately.",
    exampleNodeId: "outreach_reach",
  },
  {
    id: "standard-independent-effects",
    group: "combine",
    title: "Use Standard for independent proportional effects",
    useWhen: "Use this when several separate things each push a box up or down, and they don't overlap.",
    whatItDoes: "Standard adjusts each incoming percentage change by that link's Strength, then compounds the effects around the box's starting value.",
    whyThisChoice: "Workshop readiness treats preparation time, materials and coordination as separate influences that can reinforce one another.",
    howToApplyIt: "Choose Standard when a statement such as 'a 10% input increase produces about a 3% output increase' is more defensible than an equation in absolute units.",
    howToEvaluateIt: "Move one input at a time, then move them together. If the combined result feels too large because the inputs overlap, use Additive or reduce and re-evidence the Strengths.",
    exampleNodeId: "workshop_readiness",
  },
  {
    id: "additive-overlapping-contributions",
    group: "combine",
    title: "Use Additive when contributions overlap",
    useWhen: "Use this when the things feeding a box measure much the same ground, so counting them separately would overstate the total.",
    whatItDoes: "Additive starts from the box's baseline and adds each Strength-weighted percentage contribution without compounding them together.",
    whyThisChoice: "Community confidence has several related signals. Additive avoids treating those overlapping signals as fully independent multipliers.",
    howToApplyIt: "Choose Additive when inputs contribute to the same outcome and their combined movement should be roughly the sum of their separate movements.",
    howToEvaluateIt: "Test each input alone and compare that with moving them together. If one prerequisite should stop the outcome regardless of the others, Additive is the wrong rule.",
    exampleNodeId: "community_confidence",
  },
  {
    id: "weakest-link-prerequisites",
    group: "combine",
    title: "Use Weakest link when every prerequisite is required",
    useWhen: "Use this when every input is genuinely required, and more of one cannot make up for a shortage of another.",
    whatItDoes: "Weakest link calculates every input's Strength-adjusted proportion and lets only the smallest one set the result.",
    whyThisChoice: "Delivery capacity needs both facilitators and a venue. Extra venue space cannot make up for too few facilitators, and the reverse is also true.",
    howToApplyIt: "Choose Weakest link when every incoming factor is necessary and a stronger input cannot compensate for the limiting one.",
    howToEvaluateIt: "Lower each prerequisite in turn. The result should follow whichever one is limiting and should not improve when only a non-limiting input increases.",
    alsoWorthKnowing: "There is a second way to say 'all of these are required'. If each factor is already a share between 0 and 1, multiplying them inside a formula does the same job, and any factor at zero takes the whole result to zero. Use Weakest link when you are comparing each input against its own normal level; multiply shares when they are proportions of the same thing.",
    exampleNodeId: "delivery_capacity",
  },
  {
    id: "formula-when-units-define-arithmetic",
    group: "combine",
    title: "Use a formula when the units define the arithmetic",
    useWhen: "Use this when you can write the sum out in real units, such as hours times people reached per hour.",
    whatItDoes: "A formula uses the current absolute values of boxes and global variables. It replaces the link-based Combine calculation for that box.",
    whyThisChoice: "People reached is outreach hours × people reached per hour × a feedback multiplier, which naturally produces people per month.",
    howToApplyIt: "Write the simplest equation that matches the real process, add an incoming arrow for every box variable, and keep rates or constants as clearly described global variables.",
    howToEvaluateIt: "Check that the units produce the box's unit, the starting inputs reproduce the stated baseline, and simple test values give results you can calculate by hand.",
    exampleNodeId: "outreach_reach",
  },
  {
    id: "disprove-the-rule",
    group: "combine",
    title: "Try to disprove the rule before trusting it",
    useWhen: "Use this when a rule looks right at the starting values and you want to check it still holds at low, high and unusual settings.",
    whatItDoes: "Scenario tests reveal how the chosen rule behaves away from the comfortable starting point where many different rules can appear correct.",
    whyThisChoice: "A calculation can match one baseline while giving implausible changes, interactions or extremes elsewhere.",
    howToApplyIt: "Test low, starting and high values; change one input at a time; then combine changes. Include zero or missing capacity where that is a real possibility.",
    howToEvaluateIt: "Keep the rule only if direction, scale, interactions and edge cases match the process you are modelling. Record the evidence and uncertainty, not just the equation.",
    exampleNodeId: "workshop_readiness",
  },

  // ── Caps, shares and limits ───────────────────────────────────────────────
  {
    id: "weakest-link-versus-min",
    group: "constraint",
    title: "Choose between Weakest link and min()",
    useWhen: "Use this when a box has a bottleneck and you need to decide whether to compare each input against its own starting value or compare real quantities directly.",
    whatItDoes: "Weakest link compares proportional change from each input's baseline. min() compares absolute candidate values written in a formula and returns the smallest.",
    whyThisChoice: "Both model bottlenecks, but Delivery capacity asks which prerequisite has fallen furthest relative to normal, while Registrations asks whether demand or available places is the smaller number of people.",
    howToApplyIt: "Use Weakest link for necessary readiness factors expressed relative to their baselines. Use min() when you can calculate competing ceilings in the same unit.",
    howToEvaluateIt: "Increase a non-limiting input: the result should stay put. Then move it past the bottleneck and confirm the other input becomes the limiter.",
    alsoWorthKnowing: "There is a third smallest number in the app, and it is not a rule at all. Weakest link compares each input against its own starting value; min() compares real quantities in the same unit; Lowest allowed simply stops the finished result falling below a hard floor, whatever produced it.",
    exampleNodeId: "delivery_capacity",
  },
  {
    id: "cap-demand-with-capacity",
    group: "constraint",
    title: "Cap demand with available capacity",
    useWhen: "Use this when a box cannot rise past a ceiling, such as the number of places you can actually offer.",
    whatItDoes: "min(demand, capacity) returns whichever absolute quantity is smaller, so the realised result cannot exceed either side of the bottleneck.",
    whyThisChoice: "Registrations compares expected demand from reach with the number of places that available workshops can offer.",
    howToApplyIt: "Calculate each candidate separately in the same unit—in this case people per month—then place those candidates inside min().",
    howToEvaluateIt: "Test demand below, equal to and above capacity. The result should follow demand first, meet at the handover point, and then stay capped by capacity.",
    exampleNodeId: "registrations",
  },
  {
    id: "max-for-non-negative-remainder",
    group: "constraint",
    title: "Use max() when a real remainder cannot be negative",
    useWhen: "Use this when a box measures what is left over and the real quantity stops at zero.",
    whatItDoes: "max(balance, 0) returns the calculated balance when it is positive and zero when the calculation would otherwise go below zero.",
    whyThisChoice: "Unserved interest is demand minus available places. Spare capacity can reduce unmet demand to zero, but it cannot create negative people waiting.",
    howToApplyIt: "Write the full balance first so every addition and subtraction remains visible, then add the zero floor only if the real quantity genuinely stops at zero.",
    howToEvaluateIt: "Test capacity below, equal to and above demand. Do not use max(..., 0) when negative values have meaning, such as a budget variance or temperature.",
    alsoWorthKnowing: "Write the subtraction only when the thing being taken away is genuinely part of the thing it is taken from, over the same period. The same shape measured against a threshold rather than a total — max(demand - what routine capacity covers, 0) — gives you only the excess, and nothing at all below that threshold.",
    exampleNodeId: "unserved_interest",
  },
  {
    id: "ratio-numerator-denominator",
    group: "constraint",
    title: "Use a ratio only when numerator and denominator belong together",
    useWhen: "Use this when a box is a share of a bigger total, and the two numbers have to describe the same people over the same period.",
    whatItDoes: "A ratio divides one quantity by another to answer 'what share of the whole?'. Registration share divides registrations by people reached.",
    whyThisChoice: "Both values describe people in the same funnel and time period, so their units cancel to produce a share.",
    howToApplyIt: "Name the population represented by the denominator, make sure the numerator is part of that population, and decide explicitly what zero in the denominator should mean.",
    howToEvaluateIt: "Check zero registrations, a normal case and registrations equal to reach. If the numerator can exceed the denominator, investigate the definitions before relying on a bound.",
    alsoWorthKnowing: "The same idea runs the other way. Multiply a total by a named share to split it into parts, such as the portion of demand arriving one particular way. Keep each share as a clearly described global variable, and where the parts are meant to account for the whole total, check that they add up to 1.",
    exampleNodeId: "registration_share",
  },
  {
    id: "bounds-as-guardrails",
    group: "constraint",
    title: "Use bounds as guardrails, not repairs",
    useWhen: "Use this when a box has a real floor or ceiling, such as a share that cannot fall below 0 or rise above 1.",
    whatItDoes: "clamp(value, 0, 1) keeps a share within its real range. Lowest and highest allowed apply the same kind of limit after a box's calculation.",
    whyThisChoice: "Registration share cannot be below 0 or above 1 by definition, even when unusual inputs or rounding reach the formula.",
    howToApplyIt: "Add a bound only for a genuine physical, definitional or measurement limit, and keep the unconstrained calculation understandable.",
    howToEvaluateIt: "Check when the raw result touches the bound. If the bound is active often or hides a large error, fix the formula or assumptions instead of treating the clipped number as evidence.",
    exampleNodeId: "registration_share",
  },

  // ── Delays and feedback ───────────────────────────────────────────────────
  {
    id: "identify-a-real-feedback-loop",
    group: "feedback",
    title: "First identify a real feedback loop",
    useWhen: "Use this when you think a result loops back to change one of its own causes, and you want to check that story holds up.",
    whatItDoes: "A feedback loop exists when a later result eventually changes an earlier cause, which then influences the result again.",
    whyThisChoice: "The tutorial proposes that community confidence affects later outreach, which changes participation and experience, which may affect confidence again.",
    howToApplyIt: "Describe the complete causal story in words and identify where time passes. Use feedback only when each link has a plausible mechanism, not merely because two measures move together.",
    howToEvaluateIt: "Ask what would interrupt the loop and what evidence supports every arrow. If the story cannot explain either, keep the link as a hypothesis or leave it out.",
    exampleNodeId: "feedback_uplift",
  },
  {
    id: "delay-stops-instant-feedback",
    group: "feedback",
    title: "Use delay() to stop feedback happening instantly",
    useWhen: "Use this when boxes form a circle and one of them has to read an earlier value so the circle can be worked out at all.",
    whatItDoes: "delay(community_confidence) reads that box from the previous calculation round, so the current round never depends directly on its own unfinished answer.",
    whyThisChoice: "The confidence and outreach boxes form a circle. Something must use an earlier value or the result could depend on which box " + appName() + " happened to calculate first.",
    howToApplyIt: "Put delay() on the input that conceptually feeds back later. Make the starting reference neutral so the feedback multiplier begins at 1 instead of shifting the model at baseline.",
    howToEvaluateIt: "Confirm the baseline does not drift, the result is independent of calculation order, and " + appName() + " reports that the loop converged rather than reaching its safety limit.",
    exampleNodeId: "feedback_uplift",
  },
  {
    id: "what-delay-does-not-model",
    group: "feedback",
    title: "Know what delay() does not model",
    useWhen: "Use this when you are tempted to read delay() as a week, a month or a year of real waiting time.",
    whatItDoes: "One calculation round is a technical solver step. It is not automatically a day, month or year, and " + appName() + " does not preserve a sequence of past scenario values.",
    whyThisChoice: "delay() makes a circular calculation well-defined; it does not by itself simulate how the system travels through real time.",
    howToApplyIt: "Use delay() when you want a stable equilibrium for a feedback loop. If the timing, path, peaks or recovery period matter, use a proper time-step model outside this calculation.",
    howToEvaluateIt: "Do not validate delay() against a calendar lag. Instead check the final equilibrium and convergence, and state plainly that real-world timing remains outside the model.",
    exampleNodeId: "feedback_uplift",
  },
  {
    id: "stress-test-the-loop",
    group: "feedback",
    title: "Stress-test the loop before trusting it",
    useWhen: "Use this when a loop settles on an answer and you want to know whether that answer is believable.",
    whatItDoes: "Repeated feedback calculations can settle or grow without limit. A converged answer only says the arithmetic found a stable equilibrium; it does not prove the causal story.",
    whyThisChoice: "Self-reinforcing paths can magnify a small error in direction, strength or timing until the model looks confident but behaves unrealistically.",
    howToApplyIt: "Compare the model with feedback strength at zero, at the central estimate and at plausible low and high values. Try both positive and negative scenario changes.",
    howToEvaluateIt: "Look for a credible final direction and size, plus a converged status. Treat failure to converge or frequent clipping at bounds as reasons to revisit the loop rather than as findings about the real system.",
    exampleNodeId: "feedback_uplift",
  },
  {
    id: "document-the-assumption",
    group: "feedback",
    title: "Document the assumption beside the formula",
    useWhen: "Use this when the loop is finished and the next reader needs to know what was assumed and how confident you are.",
    whatItDoes: "Formula evidence records the loop's status, rationale, source and review date with the calculation that depends on it.",
    whyThisChoice: "A future reader needs to know that the causal loop and feedback strength are modelling assumptions, and that delay() is a calculation device rather than an elapsed-time estimate.",
    howToApplyIt: "Record the evidence for the loop's direction and strength, the range you tested, the convergence result and what new evidence should trigger a review.",
    howToEvaluateIt: "Ask someone else to reproduce the reasoning. The note is complete only if they can explain why the loop is plausible, why the strength is credible and what real-world timing the model does not represent.",
    alsoWorthKnowing: "A link and a formula make two different claims, so keep their two evidence notes apart. The link's note says whether the cause really acts on the effect. The formula's note says whether this equation and its numbers are the right shape for it. A carefully fitted formula can sit on a link that is still only a hypothesis.",
    exampleNodeId: "feedback_uplift",
  },

  // ── Syntax you can use ────────────────────────────────────────────────────
  // Not lesson material: these two carry the reference detail a writer needs at
  // the keyboard — what the formula language accepts, and what the app does
  // when it cannot use what you typed.
  {
    id: "what-you-can-write-in-a-formula",
    group: "syntax",
    title: "What you can write in a formula",
    useWhen: "Use this when you are about to type a formula and need to know which symbols and functions the app understands.",
    whatItDoes: "A formula is built from numbers, box names and global variable names, joined by + - * / and brackets. Multiply and divide are worked out before add and subtract, so brackets settle everything else. A minus sign in front of a value is allowed; a plus sign in front of one is not.",
    whyThisChoice: "The language is deliberately small. There is no general if/else, so a rule that changes shape is written with min(), max() or clamp() rather than a condition.",
    howToApplyIt: "min() and max() each take two or more values and return the smallest or the largest. clamp() takes exactly three: the value, then the lowest and highest it may reach. delay() takes exactly one plain box or global variable name, never a sum or any other expression. Every box you name must also have an arrow into this box.",
    howToEvaluateIt: "Read the formula back and check the brackets say what you meant. Dividing by zero gives 0 rather than an error, so if a number can reach zero underneath a division, decide what that 0 should mean before you rely on it.",
    alsoWorthKnowing: "Lowest allowed and Highest allowed are not part of the formula. They are applied afterwards, to whatever the rule produced. And a box with a slider ignores both its formula and its arrows for as long as the slider is holding it.",
  },
  {
    id: "when-a-formula-cannot-run",
    group: "syntax",
    title: "What happens when a formula cannot run",
    useWhen: "Use this when a box with a formula shows a number you did not expect, or no number at all.",
    whatItDoes: "If the app cannot read a formula it switches that formula off, says so, and falls back to the arrows into the box. A name it does not recognise stays in the formula but reads as 0, and so does a box that has no starting value.",
    whyThisChoice: "A silently wrong number is worse than a reported one. The fallbacks keep the rest of the map working out while making the broken part visible in Review and in the calculation breakdown.",
    howToApplyIt: "Check every name in the formula against the box ids and global variable names you actually have, give every box a starting value, and draw an arrow into this box from every box the formula names.",
    howToEvaluateIt: "Open the calculation breakdown and read which rule actually ran. If it names the arrows rather than the formula, the formula is not what is producing the number.",
    alsoWorthKnowing: "A box with a formula ignores the Strength on its incoming arrows. Those arrows still record what causes what, and " + appName() + " will point out one the formula never reads — often deliberate, sometimes a leftover. Evidence notes are for readers only: they never change a number.",
  },
];

const GROUP_ORDER: LearnReferenceGroup[] = ["combine", "constraint", "feedback", "syntax"];

const LAYER_ID = "learn-reference-layer";
const DIALOG_CLASS = "learn-reference";

/** Which entry the reading pane is showing, so a re-render keeps the reader's place. */
let openCardId: string | null = null;
/** Where focus came from, so closing puts it back where the reader left it. */
let elementFocusedBeforeOpen: HTMLElement | null = null;

export function learnReferenceCardById(cardIdentifier: string): LearnReferenceCard | null {
  return LEARN_REFERENCE_CARDS.find(card => card.id === cardIdentifier) || null;
}

// Which entry answers the question this box is actually posing. Formula wins,
// because a box with a formula ignores its Combine rule entirely (see the header
// of 07-simulation-engine.ts); otherwise the Combine rule names the entry.
export function referenceCardForNode(node: GraphNode | null | undefined): LearnReferenceCard {
  if (node?.formula) return learnReferenceCardById("formula-when-units-define-arithmetic")!;
  if (node?.combine === "min") return learnReferenceCardById("weakest-link-prerequisites")!;
  if (node?.combine === "additive") return learnReferenceCardById("additive-overlapping-contributions")!;
  return learnReferenceCardById("standard-independent-effects")!;
}

// =============================================================================
// MARKUP
// =============================================================================

function indexMarkup(currentCardId: string): string {
  return GROUP_ORDER.map(group => {
    const entries = LEARN_REFERENCE_CARDS.filter(card => card.group === group).map(card =>
      '<li><button type="button" class="learn-reference-link' +
      (card.id === currentCardId ? " is-current" : "") + '"' +
      ' data-learn-reference-card="' + escapeHtml(card.id) + '"' +
      (card.id === currentCardId ? ' aria-current="true"' : "") + ">" +
      escapeHtml(card.title) + "</button></li>",
    ).join("");
    return '<div class="learn-reference-group">' +
      "<h2>" + escapeHtml(LEARN_REFERENCE_GROUP_TITLES[group]) + "</h2>" +
      '<ul class="learn-reference-group-list">' + entries + "</ul></div>";
  }).join("");
}

function detailRow(label: string, body: string): string {
  return "<dt>" + escapeHtml(label) + "</dt><dd>" + escapeHtml(body) + "</dd>";
}

function cardMarkup(card: LearnReferenceCard): string {
  const example = card.exampleNodeId
    ? '<p class="learn-reference-example">Worked example in the Learn map: <code>' +
      escapeHtml(card.exampleNodeId) + "</code></p>"
    : "";
  return '<div class="learn-reference-entry" data-learn-reference-current="' + escapeHtml(card.id) + '">' +
    '<div class="learn-reference-eyebrow">' + escapeHtml(LEARN_REFERENCE_GROUP_TITLES[card.group]) + "</div>" +
    "<h3>" + escapeHtml(card.title) + "</h3>" +
    '<p class="learn-reference-use-when">' + escapeHtml(card.useWhen) + "</p>" +
    '<dl class="learn-reference-detail">' +
      detailRow("What it does", card.whatItDoes) +
      detailRow("Why this choice", card.whyThisChoice) +
      detailRow("How to apply it", card.howToApplyIt) +
      detailRow("How to check it", card.howToEvaluateIt) +
      (card.alsoWorthKnowing ? detailRow("Also worth knowing", card.alsoWorthKnowing) : "") +
    "</dl>" +
    example +
    "</div>";
}

function shelfMarkup(currentCardId: string): string {
  return '<div class="learn-reference-backdrop">' +
    '<section class="' + DIALOG_CLASS + '" role="dialog" aria-modal="true"' +
    ' aria-label="How to choose a box\'s calculation" tabindex="-1">' +
    '<header class="learn-reference-header"><div>' +
      '<div class="learn-reference-kicker">Reference</div>' +
      "<h1>How to choose a box's calculation</h1>" +
      "<p>Short entries on Combine rules, caps and shares, feedback, and what you can " +
      "write in a formula. Read the one you need — there is no order to follow.</p></div>" +
      '<button type="button" class="learn-reference-close" data-learn-reference-action="close"' +
      ' aria-label="Close reference">×</button></header>' +
    '<div class="learn-reference-body">' +
      '<nav class="learn-reference-index" aria-label="Reference contents">' + indexMarkup(currentCardId) + "</nav>" +
      '<div class="learn-reference-reading" tabindex="-1">' + cardMarkup(learnReferenceCardById(currentCardId)!) + "</div>" +
    "</div></section></div>";
}

// =============================================================================
// SURFACE
// =============================================================================

function existingLayer(): HTMLElement | null {
  return document.getElementById(LAYER_ID);
}

// The layer is created on demand rather than living in index.html: the tutorial
// owns `#tutorial-layer`, and a shelf that builds its own element cannot be
// caught out when a test or a re-render replaces the page body.
function ensureLayer(): HTMLElement {
  const found = existingLayer();
  if (found) return found;
  const layer = document.createElement("div");
  layer.id = LAYER_ID;
  layer.className = "learn-reference-layer";
  layer.hidden = true;
  layer.addEventListener("click", handleLearnReferenceClick);
  document.body.appendChild(layer);
  return layer;
}

function handleLearnReferenceClick(event: Event): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const cardButton = target.closest("[data-learn-reference-card]");
  if (cardButton) {
    showLearnReferenceCard(cardButton.getAttribute("data-learn-reference-card") || "");
    return;
  }
  // The dimmed area outside the dialog dismisses it. A click inside the dialog
  // lands on the dialog itself, so it never reaches the backdrop's own hit area.
  if (target.closest('[data-learn-reference-action="close"]') ||
      target.classList.contains("learn-reference-backdrop")) {
    closeLearnReference();
  }
}

export function learnReferenceIsOpen(): boolean {
  const layer = existingLayer();
  return !!layer && !layer.hidden;
}

/** Swap the reading pane to one entry without rebuilding the whole shelf. */
export function showLearnReferenceCard(cardIdentifier: string): boolean {
  const card = learnReferenceCardById(cardIdentifier);
  const layer = existingLayer();
  if (!card || !layer || layer.hidden) return false;
  openCardId = card.id;
  const reading = layer.querySelector(".learn-reference-reading");
  if (reading) {
    reading.innerHTML = cardMarkup(card);
    (reading as HTMLElement).scrollTop = 0;
  }
  layer.querySelectorAll("[data-learn-reference-card]").forEach(button => {
    const isCurrent = button.getAttribute("data-learn-reference-card") === card.id;
    button.classList.toggle("is-current", isCurrent);
    if (isCurrent) {
      button.setAttribute("aria-current", "true");
      button.scrollIntoView({ block: "nearest" });
    } else {
      button.removeAttribute("aria-current");
    }
  });
  return true;
}

export function openLearnReference(cardId?: string): boolean {
  if (!document.body) return false;
  const card = (cardId && learnReferenceCardById(cardId)) ||
    (openCardId && learnReferenceCardById(openCardId)) ||
    LEARN_REFERENCE_CARDS[0];
  if (!learnReferenceIsOpen()) {
    const activeElement = document.activeElement;
    elementFocusedBeforeOpen = activeElement instanceof HTMLElement ? activeElement : null;
  }
  openCardId = card.id;
  const layer = ensureLayer();
  layer.hidden = false;
  layer.innerHTML = shelfMarkup(card.id);
  layer.querySelector<HTMLElement>("." + DIALOG_CLASS)?.focus();
  return true;
}

export function closeLearnReference(): void {
  const layer = existingLayer();
  if (!layer || layer.hidden) return;
  layer.hidden = true;
  layer.innerHTML = "";
  const restoreTo = elementFocusedBeforeOpen;
  elementFocusedBeforeOpen = null;
  if (restoreTo && restoreTo.isConnected) restoreTo.focus();
}

// Escape closes the shelf before anything below it can act on the same key —
// it is the topmost surface whenever it is open.
document.addEventListener("keydown", event => {
  if (event.key !== "Escape" || !learnReferenceIsOpen()) return;
  event.stopPropagation();
  closeLearnReference();
}, true);

// Any surface can open the shelf by markup alone — the Learn hub does not have
// to import this module to add an entry point.
document.addEventListener("click", event => {
  // A click can be dispatched at the document itself, which has no `closest`.
  const eventTarget = event.target;
  if (!(eventTarget instanceof Element)) return;
  const trigger = eventTarget.closest("[data-learn-reference]");
  if (!trigger) return;
  openLearnReference(trigger.getAttribute("data-learn-reference") || undefined);
});
