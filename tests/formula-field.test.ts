import { beforeEach, describe, expect, it } from "vitest";
import { NODES, nodeById, state } from "../assets/js/03-state";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import { selectNode } from "../assets/js/09-graph-selection";
import { renderDetailPanel } from "../assets/js/15-detail-panel";
import { setUiMode } from "../assets/js/17-events";

// A formula long enough to matter. The one on the example map is 120 characters,
// of which the old 143px single-line field showed 21.
const LONG_FORMULA =
  "min((outreach_reach + partner_referrals + community_events) * registration_rate, " +
  "delivery_capacity * seats_per_workshop)";

const CSV = `# SECTION: streams
id,label,short,color
main,Main,MAIN,#64748b

# SECTION: stages
id,label
inputs,Inputs
outcomes,Outcomes

# SECTION: categories
id,label,color,text_color
thing,Thing,#94a3b8,#111827

# SECTION: params
id,value,description
registration_rate,1,Share who register
seats_per_workshop,20,Seats

# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max,combine,formula,min,max
outreach_reach,People reached,,main,inputs,thing,100,people,true,,2,,,,
partner_referrals,Partner referrals,,main,inputs,thing,10,people,true,,2,,,,
community_events,Community events,,main,inputs,thing,5,events,true,,2,,,,
delivery_capacity,Delivery capacity,,main,inputs,thing,8,sessions,true,,2,,,,
registrations,Registrations,,main,outcomes,thing,160,people,,higher_better,,,"${LONG_FORMULA}",,

# SECTION: edges
from,to,effect,elasticity,style,description
outreach_reach,registrations,increases,0.25,,
partner_referrals,registrations,increases,0.2,,
community_events,registrations,increases,0.15,,
delivery_capacity,registrations,increases,0.3,,
`;

const formulaField = (): HTMLTextAreaElement =>
  document.querySelector<HTMLTextAreaElement>("#detail-panel .detail-formula-input")!;

function openRegistrationsForEditing(): void {
  setUiMode("edit");
  selectNode("registrations");
  renderDetailPanel();
}

beforeEach(() => {
  expect(loadDataFromCsv(CSV)).toBe(true);
  state.canvasEdit.openEdgeId = null;
  setUiMode("read");
});

describe("the formula field", () => {
  it("is a wrapping textarea on a row of its own, not a value in the 150px slot", () => {
    openRegistrationsForEditing();
    const field = formulaField();

    expect(field.tagName).toBe("TEXTAREA");
    expect(field.value).toBe(LONG_FORMULA);
    // Still the same field name, so the existing commit path is untouched.
    expect(field.getAttribute("data-field")).toBe("formula");
    // Its own full-width row, not the right-hand column of a label/value row.
    expect(field.closest(".detail-formula-row")).not.toBeNull();
    expect(field.closest(".detail-quant-row")).toBeNull();
    // The "?" that opens the calculation reference comes with it.
    expect(field.closest(".detail-formula-row")!.querySelector(".calc-help")).not.toBeNull();
  });

  it("commits an edit while typing, as the single-line field did", () => {
    openRegistrationsForEditing();
    const field = formulaField();

    field.value = "outreach_reach * 2";
    field.dispatchEvent(new Event("input", { bubbles: true }));

    expect(nodeById.registrations.formula).toBe("outreach_reach * 2");
  });

  it("folds a pasted newline to a space so the parser never sees one", () => {
    openRegistrationsForEditing();
    const field = formulaField();

    // Copying a formula out of a document brings the line breaks with it.
    field.value = "outreach_reach\n  * 2";
    field.dispatchEvent(new Event("input", { bubbles: true }));

    expect(field.value).toBe("outreach_reach * 2");
    expect(field.value).not.toContain("\n");
    expect(nodeById.registrations.formula).toBe("outreach_reach * 2");
  });

  it("treats Enter as done rather than as a new line", () => {
    openRegistrationsForEditing();
    const field = formulaField();
    field.focus();
    const before = field.value;

    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    field.dispatchEvent(enter);

    expect(enter.defaultPrevented).toBe(true);
    expect(field.value).toBe(before);
    expect(document.activeElement).not.toBe(field);
  });

  it("leaves a modified Enter alone, so a shortcut still reaches the app", () => {
    openRegistrationsForEditing();
    const field = formulaField();
    const shortcut = new KeyboardEvent("keydown", {
      key: "Enter", metaKey: true, bubbles: true, cancelable: true,
    });
    field.dispatchEvent(shortcut);
    expect(shortcut.defaultPrevented).toBe(false);
  });

  it("keeps every other quantity in the compact label/value row", () => {
    openRegistrationsForEditing();
    // Only the formula earns a full-width row; the rest still fit their slot.
    for (const field of ["minValue", "maxValue", "baseline"]) {
      const input = document.querySelector('#detail-panel [data-field="' + field + '"]');
      if (!input) continue;
      expect(input.closest(".detail-quant-row"), field + " stays on a quantity row").not.toBeNull();
      expect(input.closest(".detail-formula-row"), field + " is not full width").toBeNull();
    }
  });

  it("renders an empty formula as an empty field rather than the word none", () => {
    setUiMode("edit");
    selectNode("outreach_reach");
    renderDetailPanel();
    const field = formulaField();
    expect(field.value).toBe("");
    expect(field.getAttribute("placeholder")).toBe("none");
  });

  it("escapes a formula containing markup rather than injecting it", () => {
    const node = NODES.find(n => n.id === "registrations")!;
    node.formula = 'a < b && c > d';
    openRegistrationsForEditing();
    // A textarea's value comes from its text content, which is where an
    // unescaped "<" would silently truncate the formula or open a tag.
    expect(formulaField().value).toBe('a < b && c > d');
  });
});
