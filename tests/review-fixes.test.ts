import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import { EDGES, NODES, state } from "../assets/js/03-state";
import {
  applyOperationsToReviewSnapshot,
  captureReviewModelSnapshot,
  previewReviewProposal,
  reviewProposalsForFinding,
  solveReviewSnapshot,
  validateReviewSnapshot,
} from "../assets/js/22a-review-model";
import { applyConfirmedReviewProposal } from "../assets/js/22b-review-apply";
import { closeReview, initReviewStage, openReview } from "../assets/js/23-review-panel";
import {
  currentReviewItem, initReviewSidebar, setReviewFilter, syncReviewSidebar,
} from "../assets/js/25-review-sidebar";
import { renderDetailPanel } from "../assets/js/15-detail-panel";
import { setUiMode } from "../assets/js/17-events";
import { FORMULA_INVALID_CSV } from "./fixtures/graphs";

const currentDirectory = dirname(fileURLToPath(import.meta.url));

const REVIEW_FIX_CSV = `# SECTION: streams
id,label,short,color
main,Main,M,#888

# SECTION: stages
id,label
one,One
two,Two

# SECTION: categories
id,label,color,text_color
kind,Kind,#444,#fff

# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max,combine,formula,min,max
source,Source,,main,one,kind,100,units,true,,2,,,,
target,Target,,main,two,kind,100,units,,,,,"source * 2",,
input,Input,,main,one,kind,10,units,true,,2,,,,
conflicted,Conflicted,,main,two,kind,10,units,true,,2,,"input",,

# SECTION: edges
from,to,effect,elasticity,description
input,conflicted,increases,,
`;

const sidebar = (): HTMLElement => document.getElementById("review-sidebar") as HTMLElement;
const issueRows = (): HTMLButtonElement[] =>
  Array.from(sidebar().querySelectorAll('[data-review-item^="issue:"]'));

beforeEach(() => {
  loadDataFromCsv(REVIEW_FIX_CSV);
  initReviewSidebar();
  initReviewStage();
  closeReview();
});

describe("detached proposal evaluation", () => {
  it("previews a connection fix without changing the live map", () => {
    const snapshot = captureReviewModelSnapshot();
    const finding = validateReviewSnapshot(snapshot).find(candidate =>
      candidate.kind === "name-has-no-link" && candidate.boxId === "target",
    )!;
    const proposal = reviewProposalsForFinding(finding, snapshot)[0];
    const liveConnectionCount = EDGES.length;
    const liveValues = { ...state.computedValues };

    const preview = previewReviewProposal(snapshot, proposal);

    expect(preview.issuesCleared).toBeGreaterThanOrEqual(1);
    expect(EDGES).toHaveLength(liveConnectionCount);
    expect(state.computedValues).toEqual(liveValues);
    expect(applyOperationsToReviewSnapshot(snapshot, proposal.operations).edges).toHaveLength(liveConnectionCount + 1);
  });

  it("uses the same rest values as the live solver for this acyclic model", () => {
    expect(solveReviewSnapshot(captureReviewModelSnapshot())).toEqual(state.computedValues);
  });

  it("reuses solved values and proposal previews for an unchanged snapshot", () => {
    const snapshot = captureReviewModelSnapshot();
    expect(solveReviewSnapshot(snapshot)).toBe(solveReviewSnapshot(snapshot));

    const finding = validateReviewSnapshot(snapshot).find(candidate =>
      candidate.kind === "name-has-no-link" && candidate.boxId === "target",
    )!;
    const proposal = reviewProposalsForFinding(finding, snapshot)[0];
    expect(previewReviewProposal(snapshot, proposal)).toBe(previewReviewProposal(snapshot, proposal));
  });

  it("offers no inert source-divided-by-itself formula proposal", () => {
    expect(loadDataFromCsv(FORMULA_INVALID_CSV)).toBe(true);
    const snapshot = captureReviewModelSnapshot();
    const finding = validateReviewSnapshot(snapshot).find(candidate =>
      candidate.kind === "link-unused" && candidate.boxId === "extra_edge",
    )!;
    const proposals = reviewProposalsForFinding(finding, snapshot);
    const unusedSourceIdentifier = finding.target!.kind === "connection"
      ? finding.target!.sourceId
      : "";

    expect(proposals.map(proposal => proposal.label)).toEqual(["Remove the unused connection"]);
    expect(proposals.every(proposal =>
      proposal.operations.every(operation => operation.kind !== "set-node-field" ||
        !String(operation.value).includes("/ " + unusedSourceIdentifier)),
    )).toBe(true);
  });

  it("validates a large link-heavy snapshot without scanning every link for every box", () => {
    const nodeCount = 16_000;
    const edgeCount = 40_000;
    const snapshot = {
      nodes: Array.from({ length: nodeCount }, (_, nodeIndex) => ({
        id: "review_scale_" + nodeIndex,
        label: "Review scale " + nodeIndex,
        description: "",
        stream: "main",
        stage: "one",
        category: "kind",
        categoryIds: ["kind"],
        primaryCategories: ["kind"],
        secondaryCategories: [],
      })),
      edges: Array.from({ length: edgeCount }, (_, edgeIndex) => ({
        id: "review_scale_edge_" + edgeIndex,
        from: "review_scale_" + (edgeIndex % nodeCount),
        to: "review_scale_" + ((edgeIndex * 17 + 1) % nodeCount),
        effect: "increases" as const,
        description: "",
      })),
      params: [],
      defaultElasticities: { enables: 0.3, increases: 0.25, decreases: -0.25 },
    };

    const startedAt = performance.now();
    expect(validateReviewSnapshot(snapshot)).toEqual([]);
    const elapsedMilliseconds = performance.now() - startedAt;

    expect(elapsedMilliseconds).toBeLessThan(1_000);
  });
});

describe("confirmed Review fixes", () => {
  it("activates a dependency formula only after its missing arrow is confirmed", () => {
    expect(state.computedValues.target).toBe(100);
    expect(state.explanations.target.rule).toBe("baseline");
    const finding = state.loadErrors.find(candidate =>
      candidate.kind === "name-has-no-link" && candidate.boxId === "target",
    )!;
    const proposal = reviewProposalsForFinding(finding, captureReviewModelSnapshot())
      .find(candidate => candidate.id.endsWith(":add-increases"))!;

    expect(applyConfirmedReviewProposal(proposal)).toBe(true);

    expect(state.computedValues.target).toBe(200);
    expect(state.explanations.target.rule).toBe("formula");
    expect(state.loadErrors.some(candidate => candidate.issueKey === finding.issueKey)).toBe(false);
  });

  it("applies a proposal as one Undo step and immediately rechecks the issue", () => {
    const finding = state.loadErrors.find(candidate =>
      candidate.kind === "slider-beats-formula" && candidate.boxId === "conflicted",
    )!;
    const proposal = reviewProposalsForFinding(finding, captureReviewModelSnapshot())
      .find(candidate => candidate.id.endsWith(":use-formula"))!;
    const historyLengthBefore = state.history.past.length;

    expect(applyConfirmedReviewProposal(proposal)).toBe(true);

    expect(NODES.find(node => node.id === "conflicted")!.controllable).toBe(false);
    expect(state.history.past).toHaveLength(historyLengthBefore + 1);
    expect(state.loadErrors.some(candidate => candidate.issueKey === finding.issueKey)).toBe(false);
  });

  it("opens on no item, and picking one makes exactly one current", () => {
    openReview();
    setReviewFilter("issue");
    const rows = issueRows();
    expect(rows.length).toBeGreaterThan(1);
    expect(currentReviewItem()).toBeUndefined();
    expect(sidebar().querySelectorAll(".review-row.is-current")).toHaveLength(0);

    rows[0].click();

    expect(sidebar().querySelectorAll(".review-row.is-current")).toHaveLength(1);
    expect(currentReviewItem()!.kind).toBe("issue");
    closeReview();
  });

  it("keeps the list where it was when an item is picked", () => {
    openReview();
    const listBefore = sidebar().querySelector<HTMLElement>(".review-list")!;
    listBefore.scrollTop = 180;

    issueRows()[0].click();

    const listAfter = sidebar().querySelector<HTMLElement>(".review-list")!;
    expect(listAfter).not.toBe(listBefore);          // the markup was rebuilt
    expect(listAfter.scrollTop).toBe(180);           // the reader's place was not
    closeReview();
  });

  it("owns its exit without discarding Edit mode", () => {
    setUiMode("edit");
    openReview();
    expect(state.uiMode).toBe("edit");

    (document.getElementById("review-close") as HTMLButtonElement).click();
    expect(state.uiMode).toBe("edit");
    expect(document.body.classList.contains("review-open")).toBe(false);
    closeReview();
  });

  it("hands the fix to the box panel without closing the list or switching mode", () => {
    // This is the whole change. Opening an issue used to close Review, force
    // edit mode and pin a floating banner carrying the one issue you clicked —
    // a second, smaller copy of the panel, with its own Back to Review.
    setUiMode("read");
    openReview();
    setReviewFilter("issue");
    issueRows()[0].click();
    renderDetailPanel();

    expect(sidebar().hidden).toBe(false);            // the list stayed
    expect(state.uiMode).toBe("read");               // nothing was assumed
    const block = document.querySelector("#detail-panel [data-review-item-block]")!;
    expect(block.querySelector('[data-review-item-action="confirm-fix"]')).not.toBeNull();
    expect(block.querySelector(".review-preview-summary")!.textContent).toContain("cleared");
    closeReview();
  });

  it("has no floating handoff left to keep in step", () => {
    // The banner existed only because the list disappeared. Nothing disappears
    // now, so both it and the markup it needed are gone — and a stylesheet still
    // carrying its rules is how a deleted surface comes back by accident.
    const reviewStyles = readFileSync(resolve(currentDirectory, "../assets/css/17-review.css"), "utf8");
    expect(reviewStyles).not.toContain("review-issue-banner");
    expect(reviewStyles).not.toContain("review-banner");
    const markup = readFileSync(resolve(currentDirectory, "../index.html"), "utf8");
    expect(markup).not.toContain("review-issue-banner");
    expect(markup).not.toContain("review-stage");

    // And the sidebar reserves the column it sits in, rather than covering the
    // map the way the overlay did.
    expect(reviewStyles).toMatch(
      /body\.review-open:not\(\.sim-mode\) \.app \{ --sidebar-w: var\(--review-w\); \}/,
    );
  });
});
