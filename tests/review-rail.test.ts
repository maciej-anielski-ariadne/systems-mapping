// =============================================================================
// THE SURFACES A REVIEW PASS RUNS ON
// -----------------------------------------------------------------------------
// The rail exists because the two halves of a review never used to share a
// screen: opening the panel hid the map, starting a pass closed the panel, and
// mid-pass the only trace of the queue was "box 3 of 5". So what is pinned down
// here is mostly "does it show the right thing at the right time" — it appears
// with the pass and only while reading, it lists every box with where it stands,
// and it follows the selection however the selection was made.
//
// The last block covers the two things these surfaces REFUSE to do: start a pass
// nobody has put their name to, and close a concern without saying what was done
// about it. Both are enforced in the record (see review-record.test.ts); what is
// checked here is that the buttons say so rather than failing silently.
// =============================================================================
import { describe, it, expect, beforeEach } from "vitest";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import { state, nodeById } from "../assets/js/03-state";
import { selectNode } from "../assets/js/09-graph-selection";
import { initReviewRail, syncReviewRail } from "../assets/js/25-review-rail";
import {
  recordVerdict, startReviewPass, endReviewPass, queueOrder, reviewStateOf, reviewAction,
} from "../assets/js/24-review-record";
import { initReviewStage, openReview, closeReview } from "../assets/js/23-review-panel";
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

const rail = (): HTMLElement => document.getElementById("review-rail") as HTMLElement;
const rows = (): HTMLElement[] => Array.from(rail().querySelectorAll(".rail-row"));
const names = (): string[] => rows().map(r => (r.querySelector(".rail-name") as HTMLElement).textContent!);

initReviewRail();
// Listener wiring is application setup, not part of any one test. Keeping it
// at suite setup makes the tests independent of declaration or shuffle order.
initReviewStage();

beforeEach(() => {
  loadDataFromCsv(CSV);          // ends any pass, as loading a map does
  state.reviews = {};
  state.reviewer = "MA";
  state.uiMode = "read";
  state.simulationMode = false;
  syncReviewRail();
});

describe("when the rail is on screen", () => {
  it("stays out of the way until a pass is running", () => {
    expect(rail().hidden).toBe(true);
    startReviewPass();
    expect(rail().hidden).toBe(false);
    endReviewPass();
    expect(rail().hidden).toBe(true);
  });

  it("comes back when the mode does — a pass survives a trip into editing", () => {
    // Nothing was telling the rail about a mode switch, so a pass came back from
    // editing with the flag still set and the rail still hidden: running, with
    // no sign of it anywhere. Both mode switches now sync it.
    startReviewPass();
    setUiMode("edit");
    expect(rail().hidden).toBe(true);
    setUiMode("read");
    expect(state.reviewPass).toBe(true);
    expect(rail().hidden).toBe(false);

    toggleSimulationMode();
    expect(rail().hidden).toBe(true);
    toggleSimulationMode();
    expect(rail().hidden).toBe(false);
  });

  it("goes away in the modes where the box panel is not a review card", () => {
    // A pass turns the box panel into a review card only while reading. A rail
    // pointing at a panel that is not asking anything would be pointing at
    // nothing — and both side columns are already spoken for in those modes.
    startReviewPass();
    expect(rail().hidden).toBe(false);

    state.uiMode = "edit";
    syncReviewRail();
    expect(rail().hidden).toBe(true);

    state.uiMode = "read";
    state.simulationMode = true;
    syncReviewRail();
    expect(rail().hidden).toBe(true);
  });

  it("comes down when a different map is opened", () => {
    startReviewPass();
    expect(rail().hidden).toBe(false);
    loadDataFromCsv(CSV);        // a pass belongs to the map it was started on
    expect(state.reviewPass).toBe(false);
    expect(rail().hidden).toBe(true);
  });
});

describe("what the rail lists", () => {
  beforeEach(() => { startReviewPass(); });

  it("holds every box in the queue, in the order the pass runs", () => {
    expect(names()).toEqual(["Exam coverage", "Seizures", "Outcome"]);
    expect(rows().length).toBe(queueOrder().length);
  });

  it("groups by the map's own columns, counting what is done in each", () => {
    const groups = Array.from(rail().querySelectorAll(".rail-group"))
      .map(g => g.textContent!.replace(/\s+/g, " ").trim());
    expect(groups).toEqual(["At the border 0/2", "After 0/1"]);

    recordVerdict("c", "agreed");
    syncReviewRail();
    expect(rail().querySelector(".rail-group")!.textContent).toContain("1/2");
  });

  it("names each column once, even when the queue walks in and out of it", () => {
    // Causes-before-effects revisits a column whenever a box in a later column
    // feeds one in an earlier column. Segmenting the queue on "the column
    // changed" named Border Processing three separate times on the border map —
    // eleven headings for six columns, which is a list with interruptions
    // rather than a grouping.
    loadDataFromCsv(CSV.replace(
      "d,Seizures,,main,s2,c,100,units,,,,,,,",
      "d,Seizures,,main,s3,c,100,units,,,,,,,\nf,Follow-up,,main,s2,c,100,units,,,,,,,",
    ).replace(
      "d,e,increases,,",
      "d,e,increases,,\nd,f,increases,,",
    ));
    state.reviews = {};
    startReviewPass();

    // The queue itself does interleave — that is what makes this a real case.
    const columnsInQueueOrder = queueOrder().map(id => nodeById[id].stage);
    expect(new Set(columnsInQueueOrder).size).toBeLessThan(columnsInQueueOrder.length);

    const groups = Array.from(rail().querySelectorAll(".rail-group"))
      .map(g => g.textContent!.split(" ").slice(0, -1).join(" ").trim());
    expect(groups.length).toBe(new Set(groups).size);
    expect(groups).toEqual(["At the border", "After"]);   // map order, left to right
  });

  it("marks each box with where it stands, in a glyph and in words", () => {
    recordVerdict("c", "agreed");
    recordVerdict("d", "flagged", { note: "Check the strength" });
    syncReviewRail();

    const byName = (label: string) => rows().find(r => r.textContent!.includes(label))!;
    expect(byName("Exam coverage").className).toContain("rv-agreed");
    expect(byName("Exam coverage").querySelector(".rail-mark")!.textContent).toBe("✓");
    expect(byName("Seizures").className).toContain("rv-flagged");
    // The glyph is decoration; the label says the same thing in words.
    expect(byName("Seizures").getAttribute("aria-label")).toContain("flagged");
    expect(byName("Outcome").getAttribute("aria-label")).toContain("not checked yet");
  });

  it("marks a box somebody has left a comment on, verdict or not", () => {
    // Otherwise a note on an unjudged box is invisible everywhere but the box
    // itself — the same write-only failure the log exists to fix, one state down.
    recordVerdict("c", "none", { note: "Not sure the strength is right" });
    syncReviewRail();

    const row = rows().find(r => r.textContent!.includes("Exam coverage"))!;
    expect(row.className).toContain("rv-unreviewed");        // still unchecked
    expect(row.querySelector(".rail-note-dot")).not.toBeNull();
    expect(row.getAttribute("aria-label")).toContain("has a comment");
    expect(row.getAttribute("data-tooltip")).toBe("Not sure the strength is right");

    const plain = rows().find(r => r.textContent!.includes("Outcome"))!;
    expect(plain.querySelector(".rail-note-dot")).toBeNull();
  });

  it("counts how far the pass has got", () => {
    recordVerdict("c", "agreed");
    syncReviewRail();
    expect(rail().querySelector(".rail-count")!.textContent).toContain("1 of 3");
    expect(rail().querySelector(".rail-next")!.textContent).toContain("2 to go");
  });

  it("offers the log for export, whether or not anyone has reviewed anything", () => {
    expect(rail().querySelector('[data-rail="export"]')).not.toBeNull();
  });
});

describe("working through the queue", () => {
  beforeEach(() => { startReviewPass(); });

  it("highlights the box you are standing on, however you got there", () => {
    // Landing on the first outstanding box is the pass starting; clicking a box
    // on the map is not, and the rail has to follow both. It listens to the one
    // funnel every selection change goes through rather than to the callers.
    const current = () => (rail().querySelector(".rail-row.is-current") as HTMLElement | null);
    selectNode("d");
    expect(current()!.textContent).toContain("Seizures");
    selectNode("e");
    expect(current()!.textContent).toContain("Outcome");
  });

  it("stays on the box when asked to go to the one it is already on", () => {
    // selectNode is a toggle — right for a click on the map, wrong for anything
    // that TAKES you somewhere. Aimed at the box you are standing on it used to
    // deselect it, so "Start a pass" on a map whose restored selection happened
    // to be the first outstanding box cleared the selection and left the box
    // panel empty. Every navigation in the review flow goes through focusNode.
    selectNode("e");
    expect(state.selectedNodeId).toBe("e");
    const row = rows().find(r => r.textContent!.includes("Outcome"))!;
    row.click();
    expect(state.selectedNodeId).toBe("e");
    expect(rail().querySelectorAll(".rail-row.is-current").length).toBe(1);
  });

  it("does not clear the selection when Next wraps round to the box you are on", () => {
    // Next means "the next one still wanting a verdict", and the queue wraps —
    // so with one box left and you standing on it, Next lands where you already
    // are. The toggle turned that into a deselect.
    recordVerdict("c", "agreed");
    recordVerdict("e", "agreed");
    selectNode("d");                       // the only one left
    syncReviewRail();
    (rail().querySelector('[data-rail="next"]') as HTMLElement).click();
    expect(state.selectedNodeId).toBe("d");
    expect(rail().querySelectorAll(".rail-row.is-current").length).toBe(1);
  });

  it("takes you to the box when a row is clicked", () => {
    const row = rows().find(r => r.textContent!.includes("Outcome"))!;
    row.click();
    expect(state.selectedNodeId).toBe("e");
  });

  it("moves to the next box still wanting a verdict", () => {
    selectNode("c");
    recordVerdict("c", "agreed");
    syncReviewRail();
    (rail().querySelector('[data-rail="next"]') as HTMLElement).click();
    expect(state.selectedNodeId).toBe("d");
  });

  it("says so when there is nothing left rather than offering a dead button", () => {
    for (const id of queueOrder()) recordVerdict(id, "agreed");
    syncReviewRail();
    const next = rail().querySelector(".rail-next") as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    expect(next.textContent).toContain("Every box has been checked");
  });

  it("narrows to what is still open, and back again", () => {
    recordVerdict("c", "agreed");
    recordVerdict("d", "flagged");
    syncReviewRail();

    (rail().querySelector('[data-rail-filter="open"]') as HTMLElement).click();
    expect(names()).toEqual(["Outcome"]);

    (rail().querySelector('[data-rail-filter="flagged"]') as HTMLElement).click();
    expect(names()).toEqual(["Seizures"]);

    (rail().querySelector('[data-rail-filter="all"]') as HTMLElement).click();
    expect(names()).toEqual(["Exam coverage", "Seizures", "Outcome"]);
  });

  it("says nothing matches rather than showing an empty list", () => {
    (rail().querySelector('[data-rail-filter="flagged"]') as HTMLElement).click();
    expect(rows().length).toBe(0);
    expect(rail().querySelector(".rail-empty")!.textContent).toContain("Nothing matches");
  });

  it("opens the next pass on the whole list, not on yesterday's chip", () => {
    // A filter belongs to the sitting. Carried across, a pass opened showing
    // three boxes and looked exactly like a pass with three boxes in it.
    (rail().querySelector('[data-rail-filter="flagged"]') as HTMLElement).click();
    expect(rows().length).toBe(0);

    endReviewPass();
    startReviewPass();
    expect(names()).toEqual(["Exam coverage", "Seizures", "Outcome"]);
  });

  it("keeps the keyboard on the button it was on across a repaint", () => {
    // Every update rebuilds the rail's markup, so the button somebody just
    // pressed stops existing. Without putting focus back, "next, next, next"
    // meant a tab tour of the whole list between each press.
    const next = rail().querySelector('[data-rail="next"]') as HTMLElement;
    next.focus();
    next.click();
    const now = document.activeElement as HTMLElement;
    expect(now).not.toBe(document.body);
    expect(now.getAttribute("data-rail")).toBe("next");
    expect(now).not.toBe(next);          // a new element, playing the same part
  });

  it("stops the pass from the rail", () => {
    (rail().querySelector('[data-rail="stop"]') as HTMLElement).click();
    expect(state.reviewPass).toBe(false);
    expect(rail().hidden).toBe(true);
  });
});

describe("what these surfaces refuse to do", () => {
  it("explains why source boxes are outside the review-pass denominator", () => {
    openReview();

    const scope = document.querySelector(".review-scope-note") as HTMLElement;
    expect(scope.textContent).toContain("Why 3 of 5?");
    expect(scope.textContent).toContain("2 source boxes have no incoming links");
    expect(scope.textContent).toContain("excluded from the pass");

    closeReview();
  });

  it("will not start a pass until there is a name to sign it with", () => {
    state.reviewer = "";
    openReview();
    const start = document.getElementById("review-start-pass") as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(start.textContent).toContain("name");
    start.click();
    expect(state.reviewPass).toBe(false);

    // Typing a name lights it up without a re-render — the field would lose
    // focus mid-word if the panel repainted on every keystroke.
    const field = document.getElementById("review-reviewer") as HTMLInputElement;
    field.value = "MA";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    expect(start.disabled).toBe(true);              // still initials

    field.value = "Maciej Anielski";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    expect(start.disabled).toBe(false);
    expect(start.textContent).not.toContain("name");

    start.click();
    expect(state.reviewPass).toBe(true);
    closeReview();
  });

  it("will not close a flag from the panel until somebody says what was done", () => {
    state.reviewer = "Maciej Anielski";
    recordVerdict("c", "flagged", { note: "Strength looks high" });
    openReview();

    const addressed = document.querySelector(
      '[data-log-action="addressed"][data-log-box="c"]') as HTMLButtonElement;
    expect(addressed.disabled).toBe(true);
    addressed.click();
    expect(reviewStateOf("c")).toBe("flagged");     // nothing written

    const field = document.querySelector('[data-close-note="c"]') as HTMLTextAreaElement;
    field.value = "Dropped it to 0.4";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    expect(addressed.disabled).toBe(false);

    addressed.click();
    expect(reviewStateOf("c")).toBe("agreed");
    expect(state.reviews.c.addressedNote).toBe("Dropped it to 0.4");
    closeReview();
  });

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
