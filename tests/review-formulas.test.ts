// =============================================================================
// REVIEWING A BOX WHOSE RULE IS NOT ITS ARROWS
// -----------------------------------------------------------------------------
// A formula box is computed from its expression ALONE — the arrows into it go
// descriptive and their strengths are ignored outright. Eighteen of the
// fifty-five queue boxes on the border map are formula boxes, and the review
// card used to ask "is this everything that drives this box?", show the arrows,
// and leave the expression off screen. On those boxes the list was the wrong
// list, and the right one was nowhere.
// =============================================================================
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import { state } from "../assets/js/03-state";
// focusNode, not selectNode: selectNode is a toggle, and calling it twice on
// the same box in one test would deselect rather than re-render.
import { focusNode } from "../assets/js/09-graph-selection";
import { renderDetailPanel, setReviewWorkingOpen, paintFormula } from "../assets/js/15-detail-panel";
import { reviewAction, reviewStateOf, startReviewPass } from "../assets/js/24-review-record";
import {
  formulaInLabels, formulaConstants, formulaReads, formulaInLabelsFailed,
} from "../assets/js/07-simulation-engine";

const HEAD = `# SECTION: streams
id,label,short,color
main,Main,MAIN,#888

# SECTION: stages
id,label
s1,Before
s2,After

# SECTION: categories
id,label,color,text_color
c,Thing,#444,#fff

# SECTION: params
id,value,description
exams_per_fte_yr,0.0004,Exams one officer can do in a year
referral_rate,0.09,Share of containers targeting would refer

`;

// `gated` is a formula box: two of its three arrows are named in the rule and
// the third is not. `plain` is an ordinary box, `weakest` a combine box.
const CSV = HEAD + `# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max,combine,formula,min,max
officers,HMRC Customs FTE,,main,s1,c,100,FTE,true,,2,,,,
arrivals,Container arrivals,,main,s1,c,100,m/yr,true,,2,,,,
weather,Weather,,main,s1,c,100,index,true,,2,,,,
gated,Container Examination,,main,s2,c,0.04,m exams/yr,,,,,"min(officers * exams_per_fte_yr, arrivals * referral_rate)",,
plain,Seizures,How many we catch,main,s2,c,100,units,,,,,,,
weakest,Counter-Terrorism,,main,s2,c,100,index,,,,min,,,

# SECTION: edges
from,to,effect,elasticity,description
officers,gated,enables,,
arrivals,gated,enables,,
weather,gated,increases,,
officers,plain,increases,0.4,
officers,weakest,increases,0.3,
arrivals,weakest,increases,0.2,
`;

const panel = (): HTMLElement => document.getElementById("detail-content") as HTMLElement;
const show = (id: string): HTMLElement => { focusNode(id); renderDetailPanel(); return panel(); };

beforeEach(() => {
  expect(loadDataFromCsv(CSV)).toBe(true);
  state.reviews = {};
  state.reviewer = "Maciej Anielski";
  state.uiMode = "read";
  state.simulationMode = false;
  setReviewWorkingOpen(null);
  startReviewPass();
});

describe("reading the rule off the engine", () => {
  it("gives the expression back with the box ids swapped for labels", () => {
    // The constants read as their values: putting `teu_exams_per_fte_yr` back in
    // a line whose whole job is to be readable would defeat it, and they are
    // listed by name underneath.
    expect(formulaInLabels("gated"))
      .toBe("min(HMRC Customs FTE × 0.0004, Container arrivals × 0.09)");
  });

  it("brackets a negated group, which is the whole meaning of the line", () => {
    // `-(a + b)` printed without its brackets reads as "−a + b" — a different
    // expression, on the one line a reviewer reads to check the rule against.
    // A rendering that quietly restates the rule is worse than no rendering.
    loadDataFromCsv(CSV.replace(
      "min(officers * exams_per_fte_yr, arrivals * referral_rate)",
      "-(officers + arrivals) + 100",
    ));
    expect(formulaInLabels("gated"))
      .toBe("−(HMRC Customs FTE + Container arrivals) + 100");
  });

  it("names the constants the rule leans on, which are on no map anywhere", () => {
    expect(formulaConstants("gated").map((p) => p.id))
      .toEqual(["exams_per_fte_yr", "referral_rate"]);
    expect(formulaConstants("plain")).toEqual([]);
  });

  it("says which of the drawn arrows the rule actually reads", () => {
    expect([...formulaReads("gated")].sort()).toEqual(["arrivals", "officers"]);
  });

  it("knows when the engine could not read the formula at all", () => {
    expect(formulaInLabelsFailed("gated")).toBe(false);
    loadDataFromCsv(CSV.replace("min(officers * exams_per_fte_yr, arrivals * referral_rate)",
                                "min(officers * * exams_per_fte_yr"));
    expect(formulaInLabelsFailed("gated")).toBe(true);
  });
});

describe("what the review card shows on a formula box", () => {
  it("still names the box it is asking about", () => {
    // The card is a QUESTION about a box, and it used to drop the identity
    // block the panel had already built — so the reviewer was asked "is this
    // everything that drives this box?" with the box's name nowhere on the
    // panel, and its description, often the definition being judged, off
    // screen entirely. The only thing naming it was a rectangle on the map.
    const card = show("gated");
    expect(card.querySelector(".detail-name")!.textContent).toBe("Container Examination");
    expect(card.querySelector(".rv-step")).not.toBeNull();       // and still the stepper
    expect(card.querySelector(".rv-foot")).not.toBeNull();       // and still the verdict
  });

  it("shows the description too, which is often the thing being judged", () => {
    expect(show("plain").querySelector(".detail-description")!.textContent)
      .toBe("How many we catch");
  });

  it("goes back to describing the box when the map is being simulated", () => {
    // The rail takes the left column, which simulation docks, so the queue
    // cannot be shown beside a simulated map. The card used to stay live with
    // the queue gone: verdict buttons still recording, no progress, and no way
    // back to the list.
    state.simulationMode = true;
    const card = show("gated");
    expect(card.querySelector(".rv-step")).toBeNull();
    expect(card.querySelector(".rv-foot")).toBeNull();
    // …and the expression is back where it lives outside a pass, rather than
    // being suppressed for a rule block that is no longer rendered.
    expect(card.querySelector(".calc-formula")).not.toBeNull();
    state.simulationMode = false;
  });

  it("puts the expression on screen, verbatim", () => {
    const html = show("gated").innerHTML;
    expect(html).toContain("The rule for this box");
    expect(show("gated").querySelector(".rv-expr")!.textContent)
      .toBe("min(officers * exams_per_fte_yr, arrivals * referral_rate)");
  });

  it("puts the same rule underneath in the map's own labels", () => {
    // Formulas name boxes by id. Nothing else on screen connects `officers` in
    // the expression to "HMRC Customs FTE" in the list.
    expect(show("gated").querySelector(".rv-plain")!.textContent)
      .toContain("HMRC Customs FTE");
  });

  it("lists the constants with their values", () => {
    const consts = Array.from(show("gated").querySelectorAll(".rv-const"))
      .map((c) => c.textContent!.replace(/\s+/g, " ").trim());
    expect(consts).toHaveLength(2);
    expect(consts.join(" ")).toContain("0.0004");
    expect(consts.join(" ")).toContain("0.09");
  });

  it("calls out an arrow the rule never reads", () => {
    // Not an error — the loader checks the other direction, a name with no
    // arrow. A link drawn and read by nothing is exactly a review's business.
    const warn = show("gated").querySelector(".rv-rule-warn")!;
    expect(warn.textContent).toContain("1 link is drawn but never read");
    expect(warn.textContent).toContain("Weather");
  });

  it("stops inviting a judgement on strengths the engine never reads", () => {
    const card = show("gated");
    expect(card.querySelectorAll(".drow-num.is-moot").length).toBe(3);
    expect(card.querySelectorAll(".drow-default").length).toBe(0);
    expect(card.innerHTML).toContain("The arrows below are descriptive here");
  });

  it("asks about the rule rather than about the strengths", () => {
    const ask = show("gated").querySelector(".rv-ask span")!.textContent!;
    expect(ask).toContain("computed from the rule below");
    expect(ask).not.toContain("wrong strengths");
  });

  it("says so when the engine could not read the formula", () => {
    loadDataFromCsv(CSV.replace("min(officers * exams_per_fte_yr, arrivals * referral_rate)",
                                "min(officers * * exams_per_fte_yr"));
    startReviewPass();
    const card = show("gated");
    expect(card.querySelector(".rv-expr")!.textContent).toContain("*  *".replace("  ", " * ").slice(0, 1));
    expect(card.querySelector(".rv-rule-warn")!.textContent).toContain("could not read this");
    // Fallen back to the arrows, so their strengths are live again.
    expect(card.querySelectorAll(".drow-num.is-moot").length).toBe(0);
  });
});

describe("the working, folded", () => {
  it("offers it shut, and opens it in place", () => {
    const toggle = () => show("gated").querySelector("[data-review-working]") as HTMLButtonElement;
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(panel().querySelector(".calc-breakdown")).toBeNull();

    toggle().click();
    expect(panel().querySelector("[data-review-working]")!.getAttribute("aria-expanded")).toBe("true");
    const breakdown = panel().querySelector(".calc-breakdown")!;
    expect(breakdown).not.toBeNull();
    // The thing a reviewer actually wants: which arm the value came from.
    expect(breakdown.textContent).toContain("HMRC Customs FTE");
  });

  it("shows the working outside simulate mode, which is where a pass runs", () => {
    expect(state.simulationMode).toBe(false);
    (show("gated").querySelector("[data-review-working]") as HTMLButtonElement).click();
    expect(panel().querySelector(".calc-breakdown")).not.toBeNull();
  });

  it("writes a constant exactly as its author wrote it", () => {
    // formatScalar rounds 0.0004 to "0.000". On a box's value rail that is a
    // rounding; on a constant it is a different number, and somebody would
    // check it and pass it.
    (show("gated").querySelector("[data-review-working]") as HTMLButtonElement).click();
    const rows = Array.from(panel().querySelectorAll(".calc-input"))
      .map((r) => r.textContent!.replace(/\s+/g, " ").trim());
    expect(rows.join(" | ")).toContain("0.0004");
    expect(rows.join(" | ")).not.toContain("0.000 ");
  });

  it("does not print the expression twice", () => {
    // The rule block a few rows up is already showing it, and a second copy of
    // a long expression is a third of a 340px panel.
    (show("gated").querySelector("[data-review-working]") as HTMLButtonElement).click();
    expect(panel().querySelectorAll(".rv-expr").length).toBe(1);
    expect(panel().querySelector(".calc-formula")).toBeNull();
  });
});

describe("boxes whose rule IS their arrows", () => {
  it("says nothing extra on an ordinary box", () => {
    const card = show("plain");
    expect(card.querySelector(".rv-rule")).toBeNull();
    expect(card.querySelector("[data-review-working]")).toBeNull();
    expect(card.querySelectorAll(".drow-num.is-moot").length).toBe(0);
  });

  it("explains a weakest-link box in a line, and still offers the working", () => {
    const card = show("weakest");
    expect(card.querySelector(".rv-rule")).not.toBeNull();
    expect(card.querySelector(".rv-plain")!.textContent).toContain("WEAKEST");
    expect(card.querySelector(".rv-expr")).toBeNull();          // there is no expression
    expect(card.querySelector("[data-review-working]")).not.toBeNull();
    // Its arrows still do the work, so their strengths are still live.
    expect(card.querySelectorAll(".drow-num.is-moot").length).toBe(0);
  });
});

// =============================================================================
// READING THE EXPRESSION — four kinds of name, told apart
// -----------------------------------------------------------------------------
// At 11px in a 308px column a wall of one-colour monospace is not readable, and
// the distinction that matters is which names are boxes, which are hidden
// constants, and which resolve to nothing at all.
// =============================================================================
describe("painting a formula", () => {
  const paint = (text: string) => {
    const host = document.createElement("div");
    host.innerHTML = paintFormula(text);
    return host;
  };

  it("tells a box, a constant, a function and a number apart", () => {
    const host = paint("min(officers * exams_per_fte_yr, 4)");
    expect(host.querySelector(".fx-fn")!.textContent).toBe("min");
    expect(host.querySelector(".fx-box")!.textContent).toBe("officers");
    expect(host.querySelector(".fx-const")!.textContent).toBe("exams_per_fte_yr");
    expect(host.querySelector(".fx-num")!.textContent).toBe("4");
    expect(Array.from(host.querySelectorAll(".fx-op")).map((o) => o.textContent).join(""))
      .toBe("(*,)");
  });

  it("marks a name that resolves to nothing, which is what the loader flags", () => {
    const host = paint("officers * nonsense_id");
    const bad = host.querySelector(".fx-unknown")!;
    expect(bad.textContent).toBe("nonsense_id");
    expect(bad.getAttribute("data-tooltip")).toContain("cannot read it");
  });

  it("says what a box id is called on the map — the connection nothing else makes", () => {
    // Formulas name boxes by id. `officers` in an expression is "HMRC Customs
    // FTE" in the list beside it, and until this tooltip nothing said so.
    const boxVariable = paint("officers").querySelector(".fx-box")!;
    expect(boxVariable.getAttribute("data-formula-node-id")).toBe("officers");
    expect(boxVariable.getAttribute("data-tooltip")).toBe(
      "HMRC Customs FTE — current value: 100 FTE",
    );

    const globalVariable = paint("exams_per_fte_yr").querySelector(".fx-const")!;
    expect(globalVariable.getAttribute("data-formula-kind")).toBe("global-variable");
    expect(globalVariable.getAttribute("data-tooltip")).toContain("Global variable — value: 0.0004");
  });

  it("gives back exactly the text it was handed", () => {
    // Painting must not lose, reorder or reformat a character: what is on screen
    // is what is in the spreadsheet, or the audit is worthless.
    const source = "clamp((a + b) / 100, 0, 1.5)";
    expect(paint(source).textContent).toBe(source);
  });

  it("cannot be made to inject markup from a spreadsheet", () => {
    const host = paint('a < <img src=x onerror="boom"> b');
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toContain("<img");
  });

  it("still reads a formula the parser rejects, which is when it matters most", () => {
    const host = paint("min(officers * * exams_per_fte_yr");
    expect(host.querySelector(".fx-box")!.textContent).toBe("officers");
    expect(host.textContent).toBe("min(officers * * exams_per_fte_yr");
  });

  it("paints the expression in the review card, not just escapes it", () => {
    const card = show("gated");
    const expr = card.querySelector(".rv-expr")!;
    expect(expr.querySelectorAll(".fx-box").length).toBe(2);
    expect(expr.querySelectorAll(".fx-const").length).toBe(2);
    expect(expr.querySelector(".fx-fn")!.textContent).toBe("min");
    // …and still reads back as the exact text in the spreadsheet.
    expect(expr.textContent).toBe("min(officers * exams_per_fte_yr, arrivals * referral_rate)");
  });
});

// =============================================================================
// THE PASS COVERS THE WHOLE MAP, IN EITHER MODE
// -----------------------------------------------------------------------------
// Two things a reviewer could not do. A box nothing drives was kept out of the
// queue, so the commonest fault on a large map — a driver box nobody marked
// adjustable, or a link never drawn — was the one thing no verdict could
// settle. And the card was hidden in edit mode, so the one place a reviewer can
// act on what they have just found was the one place they could not then record
// a verdict on it.
// =============================================================================
describe("a box nothing drives", () => {
  it("is in the pass, and is asked the other half of the question", () => {
    const card = show("officers");
    expect(card.querySelector(".rv-step")).not.toBeNull();
    expect(card.querySelector(".rv-foot")).not.toBeNull();
    expect(card.querySelector(".rv-ask b")!.textContent).toBe("Should anything drive this box?");
    expect(card.querySelector(".rv-ask span")!.textContent)
      .toContain("what a missing link looks like from here");
  });

  it("can be agreed, and the verdict sticks to the box", () => {
    show("officers");
    expect(reviewStateOf("officers")).toBe("unreviewed");
    reviewAction("officers", "agree");
    expect(reviewStateOf("officers")).toBe("agreed");
  });
});

describe("the review card in edit mode", () => {
  beforeEach(() => { state.uiMode = "edit"; });
  afterEach(() => { state.uiMode = "read"; });

  it("keeps the question and the verdict buttons", () => {
    const card = show("plain");
    expect(card.querySelector(".rv-step")).not.toBeNull();
    expect(card.querySelector(".rv-ask")).not.toBeNull();
    expect(card.querySelector('[data-review="agree"]')).not.toBeNull();
    expect(card.querySelector('[data-review="flag"]')).not.toBeNull();
    expect(card.querySelector('[data-review="skip"]')).not.toBeNull();
  });

  it("leaves the box editable underneath, which is the point of being here", () => {
    const card = show("plain");
    // The name is an input, not a display span: the fields are still unlocked.
    expect(card.querySelector("input.detail-name-input")).not.toBeNull();
    expect(card.querySelector(".detail-desc-input")).not.toBeNull();
  });

  it("records a verdict from edit mode", () => {
    const card = show("plain");
    (card.querySelector('[data-review="agree"]') as HTMLButtonElement).click();
    expect(reviewStateOf("plain")).toBe("agreed");
  });

  it("still stands down for a simulated map", () => {
    state.simulationMode = true;
    const card = show("plain");
    expect(card.querySelector(".rv-foot")).toBeNull();
    state.simulationMode = false;
  });
});
