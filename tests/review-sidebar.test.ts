// =============================================================================
// THE SURFACES A REVIEW RUNS ON
// -----------------------------------------------------------------------------
// The sidebar exists because a review's two halves never used to share a screen:
// the panel was an overlay across the map, so opening anything it named closed
// it. What is pinned down here is mostly "does it show the right thing at the
// right time" — one queue holding every kind of item, rows that navigate rather
// than expand, and an item whose question lands in the box panel beside the box
// it is about.
//
// The last block covers the things these surfaces REFUSE to do: start a pass
// nobody has put their name to, and close a concern without saying what was done
// about it. Both are enforced in the record (see review-record.test.ts); what is
// checked here is that the buttons say so rather than failing silently.
// =============================================================================
import { describe, it, expect, beforeEach } from "vitest";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import { edgeById, state, nodeById } from "../assets/js/03-state";
import { selectNode } from "../assets/js/09-graph-selection";
import {
  closeReviewSidebar, currentReviewItem, initReviewSidebar, openReviewSidebar,
  selectReviewItem, setReviewFilter, syncReviewSidebar,
} from "../assets/js/25-review-sidebar";
import {
  recordVerdict, startReviewPass, endReviewPass, reviewStateOf, reviewAction,
  scheduleReviewSave,
} from "../assets/js/24-review-record";
import { initReviewStage } from "../assets/js/23-review-panel";
import { renderDetailPanel } from "../assets/js/15-detail-panel";
import { setUiMode } from "../assets/js/17-events";
import { toggleSimulationMode } from "../assets/js/14-simulation-panel";

const CSV = `# SECTION: streams
id,label,short,color
main,Main,MAIN,#888

# SECTION: stages
id,label
s1,Before
s2,At the border
s3,After

# SECTION: categories
id,label,color,text_color
c,Thing,#444,#fff

# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max,combine,formula,min,max
a,Officers,,main,s1,c,100,units,true,,2,,,,
b,Scanners,,main,s1,c,100,units,true,,2,,,,
c,Exam coverage,,main,s2,c,100,units,,,,,,,
d,Seizures,,main,s2,c,100,units,,,,,,,
e,Outcome,,main,s3,c,100,units,,,,,,,

# SECTION: edges
from,to,effect,elasticity,description
a,c,increases,,
b,c,increases,,
c,d,increases,,
d,e,increases,,
`;

const sidebar = (): HTMLElement => document.getElementById("review-sidebar") as HTMLElement;
const rows = (): HTMLElement[] => Array.from(sidebar().querySelectorAll(".review-row"));
const names = (): string[] =>
  rows().map(row => (row.querySelector(".review-row-name") as HTMLElement).textContent!);
const groups = (): string[] =>
  Array.from(sidebar().querySelectorAll(".review-group span:first-child"))
    .map(heading => heading.textContent!);
const chip = (kind: string): HTMLButtonElement =>
  sidebar().querySelector('[data-review-filter="' + kind + '"]') as HTMLButtonElement;
const itemBlock = (): HTMLElement | null =>
  document.querySelector("#detail-panel [data-review-item-block]");

initReviewSidebar();
// Listener wiring is application setup, not part of any one test. Keeping it at
// suite setup makes the tests independent of declaration or shuffle order.
initReviewStage();

beforeEach(() => {
  loadDataFromCsv(CSV);          // ends any pass, as loading a map does
  state.reviews = {};
  state.reviewer = "Maciej Anielski";
  state.uiMode = "read";
  state.simulationMode = false;
  closeReviewSidebar();
  setReviewFilter("all");
});

describe("when the sidebar is on screen", () => {
  it("opens and closes with Review, not with a pass", () => {
    // The overlay this replaced could not be open at the same time as a pass:
    // starting one closed it. They are the same surface now.
    expect(sidebar().hidden).toBe(true);
    openReviewSidebar();
    expect(sidebar().hidden).toBe(false);
    startReviewPass();
    expect(sidebar().hidden).toBe(false);
    endReviewPass();
    expect(sidebar().hidden).toBe(false);
    closeReviewSidebar();
    expect(sidebar().hidden).toBe(true);
  });

  it("stays up through a trip into editing — fixing something must not cost the list", () => {
    openReviewSidebar();
    setUiMode("edit");
    expect(sidebar().hidden).toBe(false);
    setUiMode("read");
    expect(sidebar().hidden).toBe(false);
  });

  it("stands down while simulating, where the left column is the sliders", () => {
    openReviewSidebar();
    expect(sidebar().hidden).toBe(false);
    toggleSimulationMode();
    expect(sidebar().hidden).toBe(true);
    toggleSimulationMode();
    expect(sidebar().hidden).toBe(false);
  });

  it("forgets the current item when it closes", () => {
    // A question with no list behind it is the floating banner this replaced.
    openReviewSidebar();
    startReviewPass();
    selectReviewItem("unchecked:c");
    renderDetailPanel();
    expect(itemBlock()).not.toBeNull();

    closeReviewSidebar();
    renderDetailPanel();
    expect(itemBlock()).toBeNull();
  });
});

describe("what the queue holds", () => {
  beforeEach(() => { openReviewSidebar(); });

  it("puts every kind of review item in one list, under its own heading", () => {
    recordVerdict("c", "flagged", { note: "Strength looks high" });
    syncReviewSidebar();
    expect(groups()).toContain("What people flagged");
    expect(groups()).toContain("Not checked");
    // Every link on this map has no evidence recorded, so the gaps are real.
    expect(groups()).toContain("Evidence");
  });

  it("lists every box with something feeding it, and no box without", () => {
    setReviewFilter("unchecked");
    expect(names()).toEqual(["Exam coverage", "Seizures", "Outcome"]);
    expect(names()).not.toContain("Officers");   // nothing drives it
  });

  it("accounts for the boxes the pass leaves out", () => {
    setReviewFilter("unchecked");
    const note = sidebar().querySelector(".review-scope-note") as HTMLElement;
    expect(note.textContent).toContain("Why 3 of 5?");
    expect(note.textContent).toContain("2 source boxes have no incoming links");
    expect(note.textContent).toContain("excluded from the pass");
  });

  it("marks each box with where it stands, in a glyph and in words", () => {
    recordVerdict("c", "agreed");
    recordVerdict("d", "flagged", { note: "not sure" });
    setReviewFilter("unchecked");

    const marks = rows().map(row =>
      (row.querySelector(".review-row-mark") as HTMLElement).textContent!.trim());
    expect(marks).toEqual(["✓", "!", "○"]);
    expect(rows()[0].getAttribute("aria-label")).toContain("agreed");
    expect(rows()[1].getAttribute("aria-label")).toContain("flagged");
    expect(rows()[2].getAttribute("aria-label")).toContain("not checked yet");
  });

  it("counts how far the whole review has got, not just the pass", () => {
    const before = sidebar().querySelector(".review-progress")!.textContent!;
    expect(before).toMatch(/^0 of \d+/);
    // recordVerdict is the primitive; every path in the app follows it with the
    // save, which is what notifies everything watching the record.
    recordVerdict("c", "agreed");
    scheduleReviewSave();
    expect(sidebar().querySelector(".review-progress")!.textContent).toMatch(/^1 of \d+/);
  });

  it("narrows to one kind and back again", () => {
    setReviewFilter("unchecked");
    expect(groups()).toEqual(["Not checked"]);
    expect(chip("unchecked").getAttribute("aria-pressed")).toBe("true");
    setReviewFilter("all");
    expect(groups().length).toBeGreaterThan(1);
  });

  it("offers no chip for a kind with nothing in it", () => {
    // A filter that can only ever show an empty list is not a filter.
    expect(chip("flag")).toBeNull();
    recordVerdict("c", "flagged", { note: "Strength looks high" });
    syncReviewSidebar();
    expect(chip("flag")).not.toBeNull();
  });

  it("says what an empty filter means rather than showing a blank list", () => {
    setReviewFilter("issue");
    expect(sidebar().querySelector(".review-empty")!.textContent)
      .toContain("Every check passed");
  });

  it("offers the log for export, whether or not anyone has reviewed anything", () => {
    expect(sidebar().querySelector('[data-review-action="export"]')).not.toBeNull();
  });

  it("keeps the keyboard on the button it was on across a repaint", () => {
    const next = sidebar().querySelector('[data-review-action="next"]') as HTMLButtonElement;
    next.focus();
    syncReviewSidebar();
    expect(document.activeElement!.getAttribute("data-review-action")).toBe("next");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Everything the old overlay could show that a queue of things-to-decide does
// not: the whole sweep ranked by reach, the whole log including agreements, the
// coverage key. Each sits behind the picker on its own chip, queue option first.
// ─────────────────────────────────────────────────────────────────────────────
describe("the records behind the queue", () => {
  const picker = (): HTMLSelectElement =>
    sidebar().querySelector("#review-evidence-filter") as HTMLSelectElement;
  const choose = (value: string): void => {
    picker().value = value;
    picker().dispatchEvent(new Event("change", { bubbles: true }));
  };

  beforeEach(() => { openReviewSidebar(); });

  it("offers no picker on a chip that has nothing behind it", () => {
    setReviewFilter("unchecked");
    expect(picker()).toBeNull();
  });

  it("ranks every adjustable box by reach, with the bar and its biggest movers", () => {
    setReviewFilter("input");
    expect(picker().value).toBe("odd");
    choose("reach");

    const reachRows = Array.from(sidebar().querySelectorAll(".review-reach-row"));
    // Both adjustable boxes on this map, not only the odd ones.
    expect(reachRows.length).toBe(2);
    expect(reachRows.map(row => row.querySelector(".review-row-name")!.textContent).sort())
      .toEqual(["Officers", "Scanners"]);
    // The bar is the point of the view: a width, per row.
    for (const row of reachRows) {
      const bar = row.querySelector<HTMLElement>(".review-row-bar i")!;
      expect(bar.style.width).toMatch(/%$/);
      expect(Number(row.querySelector(".review-row-count")!.textContent)).toBeGreaterThan(0);
    }
    expect(sidebar().querySelector(".review-row-top")!.textContent).toMatch(/%/);
  });

  it("says what the sweep did, so the ranking is a ranking of something", () => {
    setReviewFilter("input");
    expect(sidebar().querySelector(".review-hint")!.textContent)
      .toContain("on its own, every other slider at 100%");
  });

  it("takes a reach row to its box without inventing a question about it", () => {
    setReviewFilter("input");
    choose("reach");
    const row = sidebar().querySelector<HTMLElement>(".review-reach-row")!;
    const boxId = row.getAttribute("data-review-box")!;
    expect(row.getAttribute("data-review-item")).toBeNull();

    row.click();
    expect(state.selectedNodeId).toBe(boxId);
    expect(currentReviewItem()).toBeUndefined();
    renderDetailPanel();
    expect(itemBlock()).toBeNull();
  });

  it("shows the whole log, agreements included, behind the flagged chip", () => {
    recordVerdict("c", "agreed");
    recordVerdict("d", "flagged", { note: "Strength looks high" });
    scheduleReviewSave();

    setReviewFilter("flag");
    expect(picker().value).toBe("open");
    expect(names()).toEqual(["Seizures"]);            // only the open one

    choose("all");
    expect(names().sort()).toEqual(["Exam coverage", "Seizures"]);
    // An agreement is a record, not a question: its row goes to the box.
    const agreedRow = rows().find(row =>
      row.querySelector(".review-row-name")!.textContent === "Exam coverage")!;
    expect(agreedRow.getAttribute("data-review-item")).toBeNull();
    expect(agreedRow.getAttribute("data-review-box")).toBe("c");
    // The open one still is a question.
    const flaggedRow = rows().find(row =>
      row.querySelector(".review-row-name")!.textContent === "Seizures")!;
    expect(flaggedRow.getAttribute("data-review-item")).toBe("flag:d");
    expect(flaggedRow.querySelector(".review-row-why")!.textContent)
      .toContain("Strength looks high");
  });

  it("keys the coverage bar, including the state that has no mark", () => {
    recordVerdict("c", "agreed");
    scheduleReviewSave();
    setReviewFilter("unchecked");
    const key = sidebar().querySelector(".review-cov-key")!;
    expect(key.textContent).toContain("1 agreed");
    expect(key.textContent).toContain("0 flagged");
    expect(key.textContent).toContain("2 not looked at");
  });

  it("keeps each chip's choice to itself", () => {
    setReviewFilter("input");
    choose("reach");
    setReviewFilter("evidence");
    expect(picker().value).toBe("gaps");              // not "reach"
    setReviewFilter("input");
    expect(picker().value).toBe("reach");             // remembered
  });
});

describe("following an item", () => {
  beforeEach(() => { openReviewSidebar(); });

  it("takes the map to the item's box and hands the question to the box panel", () => {
    selectReviewItem("unchecked:d");
    renderDetailPanel();
    expect(state.selectedNodeId).toBe("d");
    expect(itemBlock()).not.toBeNull();
    expect(itemBlock()!.querySelector(".review-item-title")!.textContent).toBe("Seizures");
  });

  it("does NOT switch the app into editing", () => {
    // The overlay had to: it was closing, and edit was the only place a fix
    // could happen. Nothing closes now, so nothing is assumed.
    state.uiMode = "read";
    selectReviewItem("unchecked:d");
    expect(state.uiMode).toBe("read");
  });

  it("leaves the list where it was — the row marks itself instead", () => {
    selectReviewItem("unchecked:d");
    const current = sidebar().querySelectorAll(".review-row.is-current");
    expect(sidebar().hidden).toBe(false);
    expect(current.length).toBe(1);
    expect(current[0].getAttribute("aria-current")).toBe("true");
  });

  it("steps to the next item still wanting an answer", () => {
    setReviewFilter("unchecked");
    selectReviewItem("unchecked:c");
    (sidebar().querySelector('[data-review-action="next"]') as HTMLButtonElement).click();
    expect(currentReviewItem()!.id).toBe("unchecked:d");
  });

  it("refuses an item that is not in the queue", () => {
    selectReviewItem("flag:c");
    expect(currentReviewItem()).toBeUndefined();   // nothing has flagged c

    recordVerdict("c", "flagged", { note: "Strength looks high" });
    scheduleReviewSave();
    selectReviewItem("flag:c");
    expect(currentReviewItem()!.kind).toBe("flag");
  });

  it("drops the current item when the map underneath it is replaced", () => {
    recordVerdict("c", "flagged", { note: "Strength looks high" });
    scheduleReviewSave();
    selectReviewItem("flag:c");
    expect(currentReviewItem()).toBeDefined();

    loadDataFromCsv(CSV);        // a review belongs to the map it was made on
    state.reviews = {};
    syncReviewSidebar();
    expect(currentReviewItem()).toBeUndefined();
    renderDetailPanel();
    expect(itemBlock()).toBeNull();
  });

  it("opens the right panel for an item even before a box is selected", () => {
    state.selectedNodeId = null;
    selectReviewItem("unchecked:c");
    expect(document.querySelector(".app")!.classList.contains("has-selection")).toBe(true);
  });
});

describe("answering an item in the box panel", () => {
  beforeEach(() => { openReviewSidebar(); });

  it("records a link's evidence from the item's own fields", () => {
    setReviewFilter("evidence");
    const first = rows()[0];
    first.click();
    renderDetailPanel();

    const edgeId = currentReviewItem()!.edgeId!;
    const block = itemBlock()!;
    const rationale = block.querySelector(
      '[data-review-evidence-field="rationale"]') as HTMLTextAreaElement;
    rationale.value = "Checked against the 2024 intake figures";
    rationale.dispatchEvent(new Event("input", { bubbles: true }));

    expect(edgeById[edgeId].evidence!.rationale).toBe("Checked against the 2024 intake figures");
  });

  it("keeps an answered row in place instead of pulling it out mid-word", () => {
    // Recording a rationale takes the item out of the queue on the FIRST
    // keystroke. A row that vanishes under the cursor, taking its own fields
    // with it, is not an answer — it is a lost sentence.
    setReviewFilter("evidence");
    rows()[0].click();
    renderDetailPanel();
    const block = itemBlock()!;

    const rationale = block.querySelector(
      '[data-review-evidence-field="rationale"]') as HTMLTextAreaElement;
    rationale.value = "C";
    rationale.dispatchEvent(new Event("input", { bubbles: true }));

    const still = currentReviewItem();
    expect(still).toBeDefined();
    expect(still!.settled).toBe(true);
    expect(still!.why).toBe("Recorded");
    expect(rows().some(row => row.classList.contains("is-current"))).toBe(true);

    // Moving on is what retires it.
    (sidebar().querySelector('[data-review-action="next"]') as HTMLButtonElement).click();
    expect(currentReviewItem()!.id).not.toBe(still!.id);
    expect(rows().map(row => row.getAttribute("data-review-item"))).not.toContain(still!.id);
  });

  it("will not close a flag until somebody says what was done about it", () => {
    recordVerdict("c", "flagged", { note: "Strength looks high" });
    selectReviewItem("flag:c");
    renderDetailPanel();

    const block = itemBlock()!;
    const addressed = block.querySelector(
      '[data-review-item-action="log-addressed"]') as HTMLButtonElement;
    expect(addressed.disabled).toBe(true);
    addressed.click();
    expect(reviewStateOf("c")).toBe("flagged");     // nothing written

    const field = block.querySelector("[data-review-close-note]") as HTMLTextAreaElement;
    field.value = "Dropped it to 0.4";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    expect(addressed.disabled).toBe(false);

    addressed.click();
    expect(reviewStateOf("c")).toBe("agreed");
    expect(state.reviews.c.addressedNote).toBe("Dropped it to 0.4");
  });

  it("will not start a pass until there is a name to sign it with", () => {
    state.reviewer = "";
    syncReviewSidebar();
    const start = sidebar().querySelector(
      '[data-review-action="start"]') as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(start.textContent).toContain("Name");
    start.click();
    expect(state.reviewPass).toBe(false);

    // Typing a name lights it up without a re-render — the field would lose
    // focus mid-word if the sidebar repainted on every keystroke.
    const field = sidebar().querySelector("#review-reviewer") as HTMLInputElement;
    field.value = "MA";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    expect(start.disabled).toBe(true);              // still initials

    field.value = "Maciej Anielski";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    expect(start.disabled).toBe(false);
    expect(start.textContent).not.toContain("Name first");

    start.click();
    expect(state.reviewPass).toBe(true);
  });
});

describe("what the box panel refuses to do", () => {
  it("greys out Agreed on the box panel while a flag is unaccounted for", () => {
    state.reviewer = "Maciej Anielski";
    recordVerdict("c", "flagged", { note: "Strength looks high" });
    startReviewPass();
    selectNode("c");
    renderDetailPanel();

    const agree = document.querySelector('[data-review="agree"]') as HTMLButtonElement;
    expect(agree.disabled).toBe(true);
    const field = document.querySelector("[data-review-close]") as HTMLTextAreaElement;
    expect(field).not.toBeNull();

    field.value = "Checked against the 2024 figures";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    expect(agree.disabled).toBe(false);

    agree.click();
    expect(reviewStateOf("c")).toBe("agreed");
    expect(state.reviews.c.addressedNote).toBe("Checked against the 2024 figures");
  });

  it("asks nothing extra of a box nobody has raised anything about", () => {
    state.reviewer = "Maciej Anielski";
    startReviewPass();
    selectNode("c");
    renderDetailPanel();
    const agree = document.querySelector('[data-review="agree"]') as HTMLButtonElement;
    expect(agree.disabled).toBe(false);
    // The field is rendered but out of the way — it has to be able to appear on
    // a keystroke, and the card cannot repaint to add it without eating the
    // half-typed word that summoned it.
    const close = document.querySelector("[data-review-close]") as HTMLTextAreaElement;
    expect(close.hidden).toBe(true);
  });

  it("flags the box as soon as somebody writes what is wrong with it", () => {
    state.reviewer = "Maciej Anielski";
    startReviewPass();
    selectNode("c");
    renderDetailPanel();

    const note = document.querySelector("[data-review-note]") as HTMLTextAreaElement;
    const agree = document.querySelector('[data-review="agree"]') as HTMLButtonElement;
    const close = document.querySelector("[data-review-close]") as HTMLTextAreaElement;
    expect(agree.disabled).toBe(false);

    note.value = "The strength here looks far too high";
    note.dispatchEvent(new Event("input", { bubbles: true }));

    // Flagged on the first keystroke, and the card says so without repainting.
    expect(reviewStateOf("c")).toBe("flagged");
    expect(document.querySelector('[data-review="flag"]')!.className).toContain("on");
    expect(agree.disabled).toBe(true);
    expect(close.hidden).toBe(false);

    // …and the way out is to answer it, not to delete it.
    close.value = "Checked against the 2024 figures — left as is";
    close.dispatchEvent(new Event("input", { bubbles: true }));
    expect(agree.disabled).toBe(false);
    agree.click();
    expect(reviewStateOf("c")).toBe("agreed");
    expect(state.reviews.c.note).toBe("The strength here looks far too high");
    expect(state.reviews.c.addressedNote).toBe("Checked against the 2024 figures — left as is");
  });

  it("re-raises a concern written onto a box that was already agreed", () => {
    // The field says "what is wrong", so writing in it is a new concern whatever
    // the box stood at. Leaving the agreement standing would let somebody type
    // an objection into a box that still reads as signed off — and closing a
    // flag KEEPS its note, so an agreed box commonly has text in that field.
    state.reviewer = "Maciej Anielski";
    recordVerdict("c", "agreed");
    startReviewPass();
    selectNode("c");
    renderDetailPanel();

    const note = document.querySelector("[data-review-note]") as HTMLTextAreaElement;
    note.value = "Actually the rail share is missing";
    note.dispatchEvent(new Event("input", { bubbles: true }));
    expect(reviewStateOf("c")).toBe("flagged");
    expect((document.querySelector('[data-review="agree"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it("re-raises a concern written onto a box whose flag was withdrawn", () => {
    state.reviewer = "Maciej Anielski";
    recordVerdict("c", "flagged", { note: "First thought" });
    reviewAction("c", "flag");                       // withdrawn, note kept
    expect(reviewStateOf("c")).toBe("unreviewed");

    startReviewPass();
    selectNode("c");
    renderDetailPanel();
    const note = document.querySelector("[data-review-note]") as HTMLTextAreaElement;
    note.value = "First thought, and now a second";
    note.dispatchEvent(new Event("input", { bubbles: true }));
    expect(reviewStateOf("c")).toBe("flagged");
  });
});
