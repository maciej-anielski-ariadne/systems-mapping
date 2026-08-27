// =============================================================================
// THE REVIEW PASS — the queue, the verdicts, and whether they still hold
// =============================================================================
import { describe, it, expect, beforeEach } from "vitest";
import { loadDataFromCsv, rebuildIndexes } from "../assets/js/06-data-loader";
import { serializeLiveStateToCsv } from "../assets/js/05a-csv-serializer";
import { state, NODES, EDGES, incomingEdges, setNodes, setEdges } from "../assets/js/03-state";
import {
  recordVerdict, clearVerdict, reviewStateOf, coverage, queueOrder, queuePosition,
  nextOutstanding, stepQueue, toggleSourceFlag, isSourceFlagged, inputFamily,
  fingerprintOf, reviewAction, startReviewPass, endReviewPass,
  reviewLog, openItems, markAddressed,
  reviewReport, reviewReportCsv, reviewReportFilename,
  isFullName, reviewerNamed, commentOn, needsResponse,
} from "../assets/js/24-review-record";

const HEAD = `# SECTION: streams
id,label,short,color
main,Main,MAIN,#888

# SECTION: stages
id,label
s1,One
s2,Two
s3,Three

# SECTION: categories
id,label,color,text_color
c,Thing,#444,#fff

`;

// a and b feed c; c feeds d. Two boxes have inputs, so the queue is [c, d].
const CHAIN = HEAD + `# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max,combine,formula,min,max
a,Lorry exam coverage,,main,s1,c,100,units,true,,2,,,,
b,Parcel exam coverage,,main,s1,c,100,units,true,,2,,,,
e,Mail exam coverage,,main,s1,c,100,units,true,,2,,,,
c,Seizures,,main,s2,c,100,units,,,,,,,
d,Outcome,,main,s3,c,100,units,,,,,,,

# SECTION: edges
from,to,effect,elasticity,description
a,c,increases,,
b,c,increases,0.4,
e,c,increases,,
c,d,increases,,
`;

describe("the queue", () => {
  beforeEach(() => { loadDataFromCsv(CHAIN); state.reviews = {}; });

  it("holds only boxes that something feeds, causes before effects", () => {
    // "Is this everything that drives this box?" has no useful answer for a
    // starting box, so the three inputs are not in the queue.
    expect(queueOrder()).toEqual(["c", "d"]);
    expect(queuePosition("c")).toBe(1);
    expect(queuePosition("a")).toBe(0);
  });

  it("hands back the next box still wanting a verdict, and wraps", () => {
    expect(nextOutstanding(null)).toBe("c");
    recordVerdict("c", "agreed");
    expect(nextOutstanding("c")).toBe("d");
    recordVerdict("d", "agreed");
    expect(nextOutstanding("d")).toBe(null);
  });

  it("steps back and forth without skipping what is done", () => {
    expect(stepQueue("c", 1)).toBe("d");
    expect(stepQueue("d", -1)).toBe("c");
    expect(stepQueue("d", 1)).toBe(null);
  });
});

describe("a verdict expires when the thing it judged changes", () => {
  beforeEach(() => { loadDataFromCsv(CHAIN); state.reviews = {}; });

  it("holds while nothing about the box's inputs moves", () => {
    recordVerdict("c", "agreed", { reviewer: "MA" });
    expect(reviewStateOf("c")).toBe("agreed");
    // A rename is not a change to what drives the box.
    NODES.find((n) => n.id === "c")!.label = "Seizures (all modes)";
    expect(reviewStateOf("c")).toBe("agreed");
  });

  it("goes stale when a strength changes", () => {
    recordVerdict("c", "agreed");
    incomingEdges.c[0].elasticity = 0.9;
    expect(reviewStateOf("c")).toBe("stale");
  });

  it("goes stale when the box's own rule changes", () => {
    recordVerdict("c", "agreed");
    NODES.find((n) => n.id === "c")!.combine = "min";
    expect(reviewStateOf("c")).toBe("stale");
  });

  it("puts a stale box back in the queue", () => {
    recordVerdict("c", "agreed");
    recordVerdict("d", "agreed");
    expect(coverage()).toMatchObject({ agreed: 2, unreviewed: 0, stale: 0 });
    incomingEdges.c[0].elasticity = 0.9;
    expect(coverage()).toMatchObject({ agreed: 1, stale: 1 });
    expect(nextOutstanding(null)).toBe("c");
  });
});

describe("verdicts and flags", () => {
  beforeEach(() => { loadDataFromCsv(CHAIN); state.reviews = {}; state.reviewer = "MA"; });

  it("stamps who and when", () => {
    recordVerdict("c", "agreed");
    expect(state.reviews.c.reviewer).toBe("MA");
    expect(state.reviews.c.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(state.reviews.c.fingerprint).toBe(fingerprintOf(NODES.find((n) => n.id === "c")!));
  });

  it("flags one link rather than the whole list", () => {
    toggleSourceFlag("c", "a");
    expect(isSourceFlagged("c", "a")).toBe(true);
    expect(isSourceFlagged("c", "b")).toBe(false);
    // Flagging one input is itself a judgement, so it creates the record.
    expect(reviewStateOf("c")).toBe("flagged");
    toggleSourceFlag("c", "a");
    expect(isSourceFlagged("c", "a")).toBe(false);
  });

  it("treats Flag as a toggle, so a mis-click is one press to undo", () => {
    reviewAction("c", "flag");
    expect(reviewStateOf("c")).toBe("flagged");
    reviewAction("c", "flag");
    expect(reviewStateOf("c")).toBe("unreviewed");
  });

  it("moves on after Agreed but stays put after Flag", () => {
    expect(reviewAction("c", "agree").goTo).toBe("d");
    expect(reviewAction("d", "flag").goTo).toBeUndefined();
  });
});

describe("the record travels in the spreadsheet", () => {
  it("round-trips through the CSV, and drops rows for boxes that are gone", () => {
    loadDataFromCsv(CHAIN);
    state.reviews = {};
    recordVerdict("c", "flagged", { note: "Strength looks high", reviewer: "MA" });
    toggleSourceFlag("c", "a");

    const csv = serializeLiveStateToCsv(null, {});
    expect(csv).toContain("# SECTION: reviews");

    loadDataFromCsv(csv);
    expect(state.reviews.c.note).toBe("Strength looks high");
    expect(state.reviews.c.reviewer).toBe("MA");
    expect(state.reviews.c.flaggedSources).toEqual(["a"]);
    expect(reviewStateOf("c")).toBe("flagged");

    // A verdict belongs to the map it was given on: loading a different map
    // must not carry somebody's sign-off onto a box in a file they never saw.
    loadDataFromCsv(CHAIN);
    expect(state.reviews).toEqual({});
  });

  it("writes no section at all for a map nobody has reviewed", () => {
    loadDataFromCsv(CHAIN);
    state.reviews = {};
    expect(serializeLiveStateToCsv(null, {})).not.toContain("# SECTION: reviews");
  });
});

describe("the family prompt — the one aimed at what is NOT there", () => {
  it("spots inputs that are the same shape", () => {
    loadDataFromCsv(CHAIN);
    const family = inputFamily("c");
    expect(family).not.toBeNull();
    expect(family!.suffix).toBe("exam coverage");
    expect(family!.members.map((m) => m.varies).sort()).toEqual(["Lorry", "Mail", "Parcel"]);
  });

  it("says nothing when there is no pattern to see", () => {
    expect(inputFamily("d")).toBeNull();   // one input
  });
});

describe("the log — finding the flags again afterwards", () => {
  beforeEach(() => { loadDataFromCsv(CHAIN); state.reviews = {}; state.reviewer = "MA"; });

  it("lists everything anyone said, in queue order", () => {
    recordVerdict("d", "agreed");
    recordVerdict("c", "flagged", { note: "Strength looks high" });
    expect(reviewLog().map((r) => r.entry.boxId)).toEqual(["c", "d"]);
    expect(reviewLog()[0].label).toBe("Seizures");
    expect(reviewLog()[0].now).toBe("flagged");
  });

  it("separates the ones still wanting something done", () => {
    recordVerdict("c", "flagged", { note: "Check with ops" });
    recordVerdict("d", "agreed");
    expect(openItems().map((r) => r.entry.boxId)).toEqual(["c"]);

    // A sign-off that has gone stale is also outstanding — nobody has confirmed
    // the box as it now stands.
    incomingEdges.d[0].elasticity = 0.77;
    expect(openItems().map((r) => r.entry.boxId).sort()).toEqual(["c", "d"]);
  });

  it("names the individually flagged links so the list reads without the map", () => {
    toggleSourceFlag("c", "a");
    expect(openItems()[0].flaggedLabels).toEqual(["Lorry exam coverage"]);
  });

  it("closes a flag out against the box as it now stands, and keeps the why", () => {
    recordVerdict("c", "flagged", { note: "Strength looks high" });
    toggleSourceFlag("c", "a");
    expect(markAddressed("c", "Dropped it to 0.4 after checking the 2024 figures")).toBe(true);
    expect(reviewStateOf("c")).toBe("agreed");
    expect(openItems()).toEqual([]);
    // The note survives: why it was flagged outlives the flag. What was DONE is
    // kept beside it rather than replacing it — they are different facts.
    expect(state.reviews.c.note).toBe("Strength looks high");
    expect(state.reviews.c.addressedNote).toBe("Dropped it to 0.4 after checking the 2024 figures");
    expect(state.reviews.c.flaggedSources).toEqual([]);
    // Re-stamped, so "addressed" means "I looked at THIS version".
    expect(state.reviews.c.fingerprint)
      .toBe(fingerprintOf(NODES.find((n) => n.id === "c")!));
  });

  it("can reopen a box entirely, putting it back in the queue", () => {
    recordVerdict("c", "agreed");
    clearVerdict("c");
    expect(reviewStateOf("c")).toBe("unreviewed");
    expect(nextOutstanding(null)).toBe("c");
  });
});

describe("running a pass", () => {
  beforeEach(() => { loadDataFromCsv(CHAIN); state.reviews = {}; });

  it("keeps the body class and the flag in step, whichever way the pass ends", () => {
    // The class and the flag used to be set at the two call sites rather than
    // together, so ending from the card's own Done button cleared the flag and
    // left the class behind.
    startReviewPass();
    expect(document.body.classList.contains("review-pass")).toBe(true);
    reviewAction("c", "end");            // the card's Done, not the panel's
    expect(state.reviewPass).toBe(false);
    expect(document.body.classList.contains("review-pass")).toBe(false);
  });

  it("starts on the first box wanting a verdict and can be stopped", () => {
    expect(startReviewPass()).toBe("c");
    expect(state.reviewPass).toBe(true);
    recordVerdict("c", "agreed");
    expect(startReviewPass()).toBe("d");
    endReviewPass();
    expect(state.reviewPass).toBe(false);
  });
});

// =============================================================================
// THE FLAG'S TWO DATES — when it was raised, and when it was closed out
// -----------------------------------------------------------------------------
// `reviewer` / `date` always name the LATEST verdict, so once a flag is closed
// they name whoever closed it. Without these an exported log could only ever say
// "agreed by B on the 27th" about a box A had flagged a week earlier — and that
// anybody ever had a concern would vanish from the record.
// =============================================================================
describe("when a concern was raised, and when it was dealt with", () => {
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  beforeEach(() => { loadDataFromCsv(CHAIN); state.reviews = {}; state.reviewer = ""; });

  it("stamps who raised it and when, and keeps both after somebody else closes it", () => {
    recordVerdict("c", "flagged", { reviewer: "AB", date: "2026-08-20", note: "Missing the rail share" });
    expect(state.reviews.c.flaggedOn).toBe("2026-08-20");
    expect(state.reviews.c.flaggedBy).toBe("AB");
    expect(state.reviews.c.addressedOn).toBe("");

    state.reviewer = "Maciej Anielski";
    markAddressed("c", "Added the rail share and re-ran it");
    const entry = state.reviews.c;
    expect(entry.verdict).toBe("agreed");
    expect(entry.reviewer).toBe("Maciej Anielski");   // who closed it
    expect(entry.flaggedBy).toBe("AB");         // who raised it
    expect(entry.flaggedOn).toBe("2026-08-20"); // and when
    expect(entry.addressedOn).toMatch(ISO);
    expect(entry.note).toBe("Missing the rail share");   // why, kept
  });

  it("does not move the raised-on date when the same concern is restated", () => {
    recordVerdict("c", "flagged", { date: "2026-08-20" });
    recordVerdict("c", "flagged", { date: "2026-08-25", note: "…and the strength" });
    expect(state.reviews.c.flaggedOn).toBe("2026-08-20");
    expect(state.reviews.c.date).toBe("2026-08-25");
  });

  it("clears the addressed date when a box is flagged again", () => {
    recordVerdict("c", "flagged", { date: "2026-08-20" });
    recordVerdict("c", "agreed",  { date: "2026-08-21" });
    expect(state.reviews.c.addressedOn).toBe("2026-08-21");

    recordVerdict("c", "flagged", { date: "2026-08-27" });
    expect(state.reviews.c.flaggedOn).toBe("2026-08-27");   // a new concern
    expect(state.reviews.c.addressedOn).toBe("");           // not a dealt-with one
  });

  it("leaves the flag dates empty on a box nobody ever flagged", () => {
    recordVerdict("c", "agreed", { date: "2026-08-20" });
    expect(state.reviews.c.flaggedOn).toBe("");
    expect(state.reviews.c.flaggedBy).toBe("");
    expect(state.reviews.c.addressedOn).toBe("");
  });

  it("dates a concern raised by flagging one link, which does not go through recordVerdict", () => {
    state.reviewer = "MA";
    recordVerdict("c", "agreed", { date: "2026-08-20" });
    toggleSourceFlag("c", "a");
    expect(reviewStateOf("c")).toBe("flagged");
    expect(state.reviews.c.flaggedOn).toMatch(ISO);
    expect(state.reviews.c.flaggedBy).toBe("MA");
  });

  it("carries all three through the spreadsheet and back", () => {
    recordVerdict("c", "flagged", { reviewer: "AB", date: "2026-08-20", note: "Check with policy" });
    recordVerdict("c", "agreed",  { reviewer: "MA", date: "2026-08-27" });

    loadDataFromCsv(serializeLiveStateToCsv(null, {}));
    expect(state.reviews.c.flaggedOn).toBe("2026-08-20");
    expect(state.reviews.c.flaggedBy).toBe("AB");
    expect(state.reviews.c.addressedOn).toBe("2026-08-27");
    expect(state.reviews.c.note).toBe("Check with policy");
  });

  it("reads a file written before these columns existed without inventing a date", () => {
    const older = CHAIN + `
# SECTION: reviews
box,verdict,reviewer,date,note,flagged,fingerprint
c,flagged,AB,2026-08-20,Older file,,zzzzzzzzzz
d,agreed,AB,2026-08-20,,,yyyyyyyyyy
`;
    loadDataFromCsv(older);
    // The flag's only date is the verdict's, which is the one honest guess.
    expect(state.reviews.c.flaggedOn).toBe("2026-08-20");
    expect(state.reviews.c.addressedOn).toBe("");
    // An agreement in an old file was never flagged as far as anyone can tell.
    expect(state.reviews.d.flaggedOn).toBe("");
    expect(state.reviews.d.addressedOn).toBe("");
  });
});

// =============================================================================
// THE EXPORTED LOG
// =============================================================================
describe("the review log as a table", () => {
  beforeEach(() => { loadDataFromCsv(CHAIN); state.reviews = {}; state.reviewer = ""; });

  it("accounts for every box on the map, not only the reviewed ones", () => {
    const rows = reviewReport();
    expect(rows.length).toBe(NODES.length);
    // Queue first, causes before effects; the starting boxes bring up the rear.
    expect(rows.slice(0, 2).map(r => r.boxId)).toEqual(["c", "d"]);
    expect(rows.slice(2).map(r => r.boxId).sort()).toEqual(["a", "b", "e"]);
  });

  it("says why a box is not in the queue rather than calling it unchecked", () => {
    const starting = reviewReport().find(r => r.boxId === "a")!;
    expect(starting.order).toBe(0);
    expect(starting.state).toMatch(/not in the queue/);
    const queued = reviewReport().find(r => r.boxId === "c")!;
    expect(queued.order).toBe(1);
    expect(queued.state).toBe("not checked");
  });

  it("carries the comment, the flagged links and all three dates", () => {
    recordVerdict("c", "flagged", { reviewer: "AB", date: "2026-08-20", note: "Rail share missing" });
    toggleSourceFlag("c", "a");
    recordVerdict("c", "agreed", { reviewer: "MA", date: "2026-08-27" });

    const row = reviewReport().find(r => r.boxId === "c")!;
    expect(row.state).toBe("agreed");
    expect(row.note).toBe("Rail share missing");
    expect(row.flaggedLabels).toEqual(["Lorry exam coverage"]);
    expect(row.flaggedOn).toBe("2026-08-20");
    expect(row.flaggedBy).toBe("AB");
    expect(row.addressedOn).toBe("2026-08-27");
    expect(row.reviewer).toBe("MA");
    expect(row.stillCurrent).toBe(true);
  });

  it("marks a sign-off that no longer applies", () => {
    recordVerdict("c", "agreed", { reviewer: "MA", date: "2026-08-20" });
    incomingEdges["c"][0].elasticity = 0.9;      // the box changed under the verdict
    const row = reviewReport().find(r => r.boxId === "c")!;
    expect(row.stillCurrent).toBe(false);
    expect(row.state).toMatch(/changed since/);
  });

  it("writes a spreadsheet with a row per box and a quoted comment", () => {
    recordVerdict("c", "flagged", { reviewer: "AB", date: "2026-08-20", note: 'He said "check it", then left' });
    const csv = reviewReportCsv();
    const lines = csv.trim().split("\n");
    expect(lines[0]).toContain("addressed on");
    // One header plus one row per box — nothing dropped, nothing doubled.
    expect(lines.length).toBe(NODES.length + 1);
    expect(csv).toContain('"He said ""check it"", then left"');
    expect(reviewReportFilename()).toMatch(/^review-log-\d{4}-\d{2}-\d{2}\.csv$/);
  });
});

// =============================================================================
// WHO SIGNS, AND WHAT IT TAKES TO CLOSE A CONCERN
// -----------------------------------------------------------------------------
// Two rules that exist because the record is read by somebody else, later: it is
// signed with a name rather than initials, and a flag cannot be closed without
// an account of what was actually done about it.
// =============================================================================
describe("a full name, not initials", () => {
  it("accepts a name and refuses initials", () => {
    expect(isFullName("Maciej Anielski")).toBe(true);
    expect(isFullName("Jo Ng")).toBe(true);
    expect(isFullName("J. Smith")).toBe(true);      // an initial plus a name is a name
    expect(isFullName("Ann-Marie Lee")).toBe(true);

    expect(isFullName("MA")).toBe(false);
    expect(isFullName("M A")).toBe(false);
    expect(isFullName("M.A.")).toBe(false);
    expect(isFullName("Ann")).toBe(false);          // one word, however long
    expect(isFullName("  ")).toBe(false);
    expect(isFullName("")).toBe(false);
  });

  it("reads the name off the live state", () => {
    state.reviewer = "MA";
    expect(reviewerNamed()).toBe(false);
    state.reviewer = "Maciej Anielski";
    expect(reviewerNamed()).toBe(true);
  });
});

describe("closing a flag takes an account of what was done", () => {
  beforeEach(() => {
    loadDataFromCsv(CHAIN); state.reviews = {}; state.reviewer = "Maciej Anielski";
  });

  it("refuses to close one on nothing, and writes nothing when it does", () => {
    recordVerdict("c", "flagged", { note: "Strength looks high" });
    expect(markAddressed("c", "")).toBe(false);
    expect(markAddressed("c", "   ")).toBe(false);
    expect(markAddressed("c")).toBe(false);
    // Refused means refused: the box is still flagged and still outstanding.
    expect(reviewStateOf("c")).toBe("flagged");
    expect(openItems().map((r) => r.entry.boxId)).toEqual(["c"]);
  });

  it("keeps what was wrong and what was done as separate facts", () => {
    recordVerdict("c", "flagged", { note: "No rail share among the five" });
    expect(markAddressed("c", "Added it at 0.3, agreed with policy")).toBe(true);
    expect(state.reviews.c.note).toBe("No rail share among the five");
    expect(state.reviews.c.addressedNote).toBe("Added it at 0.3, agreed with policy");
  });

  it("asks the same of Agreed on the card, since that is closing it too", () => {
    recordVerdict("c", "flagged", { note: "Check with ops" });
    const refused = reviewAction("c", "agree");
    expect(refused.refused).toBeTruthy();
    expect(refused.goTo).toBeUndefined();
    expect(reviewStateOf("c")).toBe("flagged");

    const done = reviewAction("c", "agree", { addressedNote: "Ops confirmed it" });
    expect(done.refused).toBeUndefined();
    expect(reviewStateOf("c")).toBe("agreed");
    expect(state.reviews.c.addressedNote).toBe("Ops confirmed it");
  });

  it("still asks when the box has been edited since it was flagged", () => {
    // Editing the links makes it read as "stale", but the concern is still open
    // and somebody still has to say what happened about it.
    recordVerdict("c", "flagged", { note: "Check with ops" });
    incomingEdges.c[0].elasticity = 0.9;
    expect(reviewStateOf("c")).toBe("stale");
    expect(reviewAction("c", "agree").refused).toBeTruthy();
  });

  it("asks nothing of a sign-off that merely went stale", () => {
    // Nothing was ever raised on this box, so there is nothing to account for.
    recordVerdict("c", "agreed");
    incomingEdges.c[0].elasticity = 0.9;
    expect(reviewStateOf("c")).toBe("stale");
    expect(markAddressed("c")).toBe(true);
    expect(reviewStateOf("c")).toBe("agreed");
    expect(state.reviews.c.addressedNote).toBe("");
  });

  it("clears the old account when the box is flagged again", () => {
    recordVerdict("c", "flagged", { note: "First concern" });
    markAddressed("c", "Fixed it");
    expect(state.reviews.c.addressedNote).toBe("Fixed it");

    recordVerdict("c", "flagged", { note: "Second concern" });
    expect(state.reviews.c.addressedNote).toBe("");
    expect(state.reviews.c.addressedOn).toBe("");
  });

  it("carries it through the spreadsheet and into the exported log", () => {
    recordVerdict("c", "flagged", { reviewer: "Ann Lee", date: "2026-08-20", note: "No rail share" });
    markAddressed("c", "Added it at 0.3");

    loadDataFromCsv(serializeLiveStateToCsv(null, {}));
    expect(state.reviews.c.addressedNote).toBe("Added it at 0.3");

    const row = reviewReport().find((r) => r.boxId === "c")!;
    expect(row.addressedNote).toBe("Added it at 0.3");
    const csv = reviewReportCsv();
    expect(csv.split("\n")[0]).toContain("what was done");
    expect(csv).toContain("Added it at 0.3");
  });
});

// =============================================================================
// A COMMENT IS NOT A JUDGEMENT
// -----------------------------------------------------------------------------
// The record has a third state — a note somebody left with no verdict on it —
// because two things were wrong without it. Writing a sentence about a box
// silently flagged it, and taking a flag back deleted the record, which threw
// away the sentence: the one part of a review that takes effort to produce.
// =============================================================================
describe("taking a flag back keeps what was written", () => {
  beforeEach(() => {
    loadDataFromCsv(CHAIN); state.reviews = {}; state.reviewer = "Maciej Anielski";
  });

  it("withdraws the judgement and keeps the note and the marked links", () => {
    recordVerdict("c", "flagged", { note: "Strength looks high", date: "2026-08-20" });
    toggleSourceFlag("c", "a");
    expect(reviewStateOf("c")).toBe("flagged");

    reviewAction("c", "flag");                        // pressed again
    expect(reviewStateOf("c")).toBe("unreviewed");    // back in the queue
    expect(state.reviews.c.note).toBe("Strength looks high");
    expect(state.reviews.c.flaggedSources).toEqual(["a"]);
    expect(isSourceFlagged("c", "a")).toBe(true);
  });

  it("stops claiming a concern was ever raised", () => {
    // Not raised and not closed: a log saying "flagged on the 20th" with no
    // answer would read as an open concern that quietly vanished.
    recordVerdict("c", "flagged", { note: "Check with ops", date: "2026-08-20" });
    expect(state.reviews.c.flaggedOn).toBe("2026-08-20");
    reviewAction("c", "flag");
    expect(state.reviews.c.flaggedOn).toBe("");
    expect(state.reviews.c.flaggedBy).toBe("");
    expect(state.reviews.c.addressedOn).toBe("");

    const row = reviewReport().find((r) => r.boxId === "c")!;
    expect(row.state).toBe("not checked");
    expect(row.note).toBe("Check with ops");       // still in the exported log
    expect(row.flaggedOn).toBe("");
  });

  it("flags it again, note intact, with a fresh date", () => {
    recordVerdict("c", "flagged", { note: "Check with ops", date: "2026-08-20" });
    reviewAction("c", "flag");
    reviewAction("c", "flag");
    expect(reviewStateOf("c")).toBe("flagged");
    expect(state.reviews.c.note).toBe("Check with ops");
    expect(state.reviews.c.flaggedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("still toggles on a box whose links have been edited since", () => {
    recordVerdict("c", "flagged", { note: "Check with ops" });
    incomingEdges.c[0].elasticity = 0.9;
    expect(reviewStateOf("c")).toBe("stale");
    reviewAction("c", "flag");
    expect(reviewStateOf("c")).toBe("unreviewed");
    expect(state.reviews.c.note).toBe("Check with ops");
  });
});

describe("a note with no verdict on it", () => {
  beforeEach(() => {
    loadDataFromCsv(CHAIN); state.reviews = {}; state.reviewer = "Maciej Anielski";
  });

  it("leaves the box unchecked and in the queue", () => {
    recordVerdict("c", "none", { note: "Not sure the strength is right" });
    expect(reviewStateOf("c")).toBe("unreviewed");
    expect(commentOn("c")).toBe("Not sure the strength is right");
    expect(nextOutstanding(null)).toBe("c");
    expect(coverage()).toMatchObject({ unreviewed: 2, flagged: 0, agreed: 0 });
  });

  it("is not an open item — it is an unfinished thought, not a concern", () => {
    recordVerdict("c", "none", { note: "Come back to this" });
    expect(openItems()).toEqual([]);
    // It is still in the log, though: a note nobody can find again is no note.
    expect(reviewLog().map((r) => r.entry.boxId)).toEqual(["c"]);
  });

  it("cannot go stale, because nothing was signed off", () => {
    recordVerdict("c", "none", { note: "Come back to this" });
    incomingEdges.c[0].elasticity = 0.9;
    expect(reviewStateOf("c")).toBe("unreviewed");
  });

  it("survives the spreadsheet", () => {
    recordVerdict("c", "none", { note: "Come back to this" });
    loadDataFromCsv(serializeLiveStateToCsv(null, {}));
    expect(state.reviews.c.verdict).toBe("none");
    expect(state.reviews.c.note).toBe("Come back to this");
    expect(reviewStateOf("c")).toBe("unreviewed");
  });

  it("is what an unreadable verdict becomes, never an agreement", () => {
    const odd = CHAIN + `
# SECTION: reviews
box,verdict,reviewer,date,note,flagged,fingerprint
c,APPROVED,Ann Lee,2026-08-20,From some other tool,,zzzzzzzzzz
`;
    loadDataFromCsv(odd);
    expect(state.reviews.c.verdict).toBe("none");
    expect(reviewStateOf("c")).toBe("unreviewed");
    expect(state.reviews.c.note).toBe("From some other tool");
  });
});

// =============================================================================
// AN UNANSWERED CONCERN BLOCKS AGREEMENT
// -----------------------------------------------------------------------------
// A concern is raised two ways that mean the same thing — pressing Flag, and
// writing what is wrong in the note. Either way it stands until somebody says
// what was done about it.
// =============================================================================
describe("what counts as an unanswered concern", () => {
  beforeEach(() => {
    loadDataFromCsv(CHAIN); state.reviews = {}; state.reviewer = "Maciej Anielski";
  });

  it("counts a flag with no note", () => {
    recordVerdict("c", "flagged");
    expect(needsResponse("c")).toBe(true);
    expect(reviewAction("c", "agree").refused).toBeTruthy();
  });

  it("counts a note on a box nobody has settled, flag or no flag", () => {
    // The note field is where a concern is RAISED, so words in it are a concern
    // even after the flag itself has been taken back.
    recordVerdict("c", "flagged", { note: "Strength looks high" });
    reviewAction("c", "flag");                       // withdrawn, note kept
    expect(reviewStateOf("c")).toBe("unreviewed");
    expect(needsResponse("c")).toBe(true);
    expect(reviewAction("c", "agree").refused).toBeTruthy();
    expect(reviewStateOf("c")).toBe("unreviewed");   // nothing written
  });

  it("stops counting once somebody says what was done", () => {
    recordVerdict("c", "flagged", { note: "Strength looks high" });
    expect(reviewAction("c", "agree", { addressedNote: "Left as is, checked 2024" }).refused)
      .toBeUndefined();
    expect(needsResponse("c")).toBe(false);
    expect(reviewStateOf("c")).toBe("agreed");
  });

  it("counts nothing on a box nobody has written on", () => {
    expect(needsResponse("c")).toBe(false);
    recordVerdict("c", "agreed");
    expect(needsResponse("c")).toBe(false);
  });

  it("asks nothing of an agreement that merely went stale, note and all", () => {
    // The note on an agreed box was settled by the agreement. Re-confirming it
    // after an edit is not answering for anything.
    recordVerdict("c", "agreed", { note: "Agreed with ops on the 20th" });
    incomingEdges.c[0].elasticity = 0.9;
    expect(reviewStateOf("c")).toBe("stale");
    expect(needsResponse("c")).toBe(false);
    expect(markAddressed("c")).toBe(true);
    expect(reviewStateOf("c")).toBe("agreed");
  });

  it("blocks the panel's Addressed button on the same rule", () => {
    recordVerdict("c", "flagged", { note: "Strength looks high" });
    reviewAction("c", "flag");                       // note kept, flag gone
    expect(markAddressed("c")).toBe(false);
    expect(markAddressed("c", "Re-checked, it is right")).toBe(true);
    expect(state.reviews.c.addressedNote).toBe("Re-checked, it is right");
  });
});

describe("who closed the concern, as against who last touched the box", () => {
  beforeEach(() => {
    loadDataFromCsv(CHAIN); state.reviews = {}; state.reviewer = "Ann Lee";
  });

  it("names the closer separately from the raiser", () => {
    recordVerdict("c", "flagged", { reviewer: "Ann Lee", date: "2026-08-20", note: "No rail share" });
    state.reviewer = "Maciej Anielski";
    expect(markAddressed("c", "Added it at 0.3")).toBe(true);

    const entry = state.reviews.c;
    expect(entry.flaggedBy).toBe("Ann Lee");
    expect(entry.addressedBy).toBe("Maciej Anielski");
    expect(entry.reviewer).toBe("Maciej Anielski");
  });

  it("keeps the closer once somebody else touches the box again", () => {
    // `reviewer` moves to whoever gave the latest verdict, so on its own it
    // stops naming the closer after one more edit. This is why addressedBy is
    // its own field rather than something the export infers.
    recordVerdict("c", "flagged", { reviewer: "Ann Lee", date: "2026-08-20", note: "No rail share" });
    state.reviewer = "Maciej Anielski";
    markAddressed("c", "Added it at 0.3");
    incomingEdges.c[0].elasticity = 0.9;              // edited, so it goes stale
    state.reviewer = "Jo Ng";
    markAddressed("c");                               // re-confirmed by a third person

    const entry = state.reviews.c;
    expect(entry.reviewer).toBe("Jo Ng");             // latest verdict
    expect(entry.flaggedBy).toBe("Ann Lee");          // raised it
    expect(entry.addressedBy).toBe("Maciej Anielski");// closed it
  });

  it("clears the closer when the box is flagged again", () => {
    recordVerdict("c", "flagged", { note: "First" });
    markAddressed("c", "Dealt with");
    expect(state.reviews.c.addressedBy).toBe("Ann Lee");
    recordVerdict("c", "flagged", { note: "Second" });
    expect(state.reviews.c.addressedBy).toBe("");
    expect(state.reviews.c.addressedOn).toBe("");
  });

  it("carries both names through the spreadsheet and into the exported log", () => {
    recordVerdict("c", "flagged", { reviewer: "Ann Lee", date: "2026-08-20", note: "No rail share" });
    state.reviewer = "Maciej Anielski";
    markAddressed("c", "Added it at 0.3");

    loadDataFromCsv(serializeLiveStateToCsv(null, {}));
    expect(state.reviews.c.flaggedBy).toBe("Ann Lee");
    expect(state.reviews.c.addressedBy).toBe("Maciej Anielski");

    const row = reviewReport().find((r) => r.boxId === "c")!;
    expect(row.flaggedBy).toBe("Ann Lee");
    expect(row.addressedBy).toBe("Maciej Anielski");
    const csv = reviewReportCsv();
    expect(csv.split("\n")[0]).toContain("addressed by");
    expect(csv).toContain("Maciej Anielski");
  });
});

// =============================================================================
// A REVIEW OUTLIVES THE BOX IT WAS ABOUT
// -----------------------------------------------------------------------------
// Before this, deleting a reviewed box removed the review from the log, the
// badge and the exported report at once — silently, with nothing left to say a
// concern had ever been raised. The case where that costs most is the one where
// deleting the box WAS the answer to the flag.
//
// The record now keeps it. The app's own surfaces stay about the map in front of
// you; the EXPORTED log is where it is noted, which is where a QA trail belongs.
// =============================================================================
describe("when a reviewed box is deleted", () => {
  const remove = (id: string) => {
    setNodes(NODES.filter((n) => n.id !== id));
    setEdges(EDGES.filter((e) => e.from !== id && e.to !== id));
    rebuildIndexes();
  };

  beforeEach(() => {
    loadDataFromCsv(CHAIN); state.reviews = {}; state.reviewer = "Ann Lee";
  });

  it("keeps the review, and stamps the day the box went", () => {
    recordVerdict("c", "flagged", { note: "Strength looks high", date: "2026-08-20" });
    remove("c");
    const entry = state.reviews.c;
    expect(entry).toBeDefined();
    expect(entry.removedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(entry.note).toBe("Strength looks high");
    expect(entry.label).toBe("Seizures");         // still nameable without the box
  });

  it("says so in the exported log, which is the whole point", () => {
    recordVerdict("c", "flagged", { reviewer: "Ann Lee", date: "2026-08-20", note: "Rail share missing" });
    remove("c");

    const row = reviewReport().find((r) => r.boxId === "c")!;
    expect(row.label).toBe("Seizures");
    expect(row.state).toMatch(/^box deleted on \d{4}-\d{2}-\d{2} — last verdict: flagged$/);
    expect(row.note).toBe("Rail share missing");
    expect(row.flaggedBy).toBe("Ann Lee");
    expect(row.removedOn).toBe(state.reviews.c.removedOn);

    const csv = reviewReportCsv();
    expect(csv.split("\n")[0]).toContain("deleted on");
    expect(csv).toContain("Rail share missing");
  });

  it("leaves the app's own surfaces about the map in front of you", () => {
    // Not in the panel's log, not in the queue, not nagging in the badge: there
    // is nothing left to act on, and a list of boxes that are not on the map is
    // a list people stop reading.
    recordVerdict("c", "flagged", { note: "Rail share missing" });
    expect(openItems()).toHaveLength(1);
    remove("c");
    expect(reviewLog().map((r) => r.entry.boxId)).not.toContain("c");
    expect(openItems()).toHaveLength(0);
    // Deleting a box takes its outgoing links too, so `d` — which `c` was the
    // only thing driving — falls out of the queue as well. Nothing to ask about
    // a box nothing feeds.
    expect(coverage().total).toBe(0);
  });

  it("survives the spreadsheet, where a row about a box this map never had does not", () => {
    recordVerdict("c", "flagged", { reviewer: "Ann Lee", date: "2026-08-20", note: "Rail share missing" });
    remove("c");
    const csv = serializeLiveStateToCsv(null, {});

    // A tombstone — a box this map had and somebody deleted — is kept.
    loadDataFromCsv(csv);
    expect(state.reviews.c).toBeDefined();
    expect(state.reviews.c.note).toBe("Rail share missing");
    expect(state.reviews.c.label).toBe("Seizures");
    expect(reviewReport().find((r) => r.boxId === "c")!.state).toContain("box deleted on");

    // A row with NO removal date about a box that is not here is about some
    // other map, and is still dropped — otherwise opening a different file
    // could attach somebody's verdict to a box they never saw.
    const stray = CHAIN + `
# SECTION: reviews
box,label,verdict,reviewer,date,note,flagged,fingerprint,flagged_on,flagged_by,addressed_on,addressed_by,addressed_note,removed_on
not_on_this_map,Some Other Box,agreed,Ann Lee,2026-08-20,From another file,,zzzzzzzzzz,,,,,,
`;
    loadDataFromCsv(stray);
    expect(state.reviews.not_on_this_map).toBeUndefined();
  });

  it("un-marks it when the box comes back, so an undo costs nothing", () => {
    recordVerdict("c", "agreed", { date: "2026-08-20" });
    const before = state.reviews.c.fingerprint;
    const nodes = NODES.slice(); const edges = EDGES.slice();

    remove("c");
    expect(state.reviews.c.removedOn).toBeTruthy();

    setNodes(nodes); setEdges(edges); rebuildIndexes();       // an undo
    expect(state.reviews.c.removedOn).toBe("");
    expect(reviewStateOf("c")).toBe("agreed");
    expect(state.reviews.c.fingerprint).toBe(before);
    expect(reviewReport().find((r) => r.boxId === "c")!.state).toBe("agreed");
  });

  it("names a flagged link whose own box was deleted", () => {
    recordVerdict("c", "flagged", { note: "This input is wrong", flaggedSources: ["a"] });
    remove("a");
    expect(reviewLog()[0].flaggedLabels).toEqual(["a (deleted)"]);
  });
});
