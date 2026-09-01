// =============================================================================
// CALCULATION-CHOICE GUIDANCE
// -----------------------------------------------------------------------------
// The direct box editor and the bulk builder ask the same modelling question:
// should this value be supplied as a scenario input, respond proportionally to
// its links, or be calculated by an explicit equation? Keep that explanation in
// one renderer so the two authoring surfaces cannot drift into different advice.
// =============================================================================

export interface CalculationChoiceGuideOptions {
  adjustable?: boolean;
  hasFormula?: boolean;
  open?: boolean;
}

function contextualLead(options: CalculationChoiceGuideOptions): string {
  if (options.adjustable) {
    return "This box is adjustable, so Simulation supplies its scenario value directly. " +
      "Its formula and incoming calculation are ignored while it remains adjustable.";
  }
  if (options.hasFormula) {
    return "This box uses a formula. Incoming arrows still show its causes, but their " +
      "Strength values are not used in the calculation.";
  }
  return "This box currently uses its incoming links. Start with Strength when the " +
    "response is proportional; use a formula only when the relationship itself has a different shape.";
}

export function renderCalculationChoiceGuide(
  options: CalculationChoiceGuideOptions = {},
): string {
  return '<details class="calculation-choice-guide"' + (options.open ? " open" : "") + '>' +
    '<summary>How should this box calculate?</summary>' +
    '<div class="calculation-choice-guide-body">' +
      '<p class="calculation-choice-lead">' + contextualLead(options) + '</p>' +
      '<div class="calculation-choice-options">' +
        '<div><b>Scenario multiplier</b><span>Make the box Adjustable when a user should test an external input. ' +
          '100% means its starting value. This changes the scenario, not the causal rule.</span></div>' +
        '<div><b>Link Strength</b><span>Use when a percentage change in the cause should produce a stable percentage ' +
          'change in the effect. Strength is the target % response per source % change; Effect sets its direction.</span></div>' +
        '<div><b>Formula</b><span>Use for exact equations in absolute units: conversion rates, shares, ratios, ' +
          'capacity limits, balances, thresholds, joint requirements, or delayed feedback.</span></div>' +
      '</div>' +
      '<p><b>Then choose how links combine:</b> Standard compounds independent effects; Additive sums related effects ' +
        'without compounding; Weakest link lets the scarcest prerequisite gate the result.</p>' +
      '<p><b>Formula setup:</b> make its result equal this box\'s starting value at the baseline; keep units compatible; ' +
        'draw an incoming arrow from every box it names; put fixed rates or shares in Constants; add bounds for real ' +
        'limits; and use <code>delay(box_id)</code> when a feedback formula must read the previous solver pass.</p>' +
      '<p class="calculation-choice-syntax"><code>+ − × ÷</code> are written as <code>+ - * /</code>. ' +
        'Available functions: <code>min</code>, <code>max</code>, <code>clamp</code>, <code>delay</code>.</p>' +
    '</div>' +
  '</details>';
}
