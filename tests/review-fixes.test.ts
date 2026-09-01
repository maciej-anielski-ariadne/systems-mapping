import { beforeEach, describe, expect, it } from "vitest";
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
import { setUiMode } from "../assets/js/17-events";

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

beforeEach(() => {
  loadDataFromCsv(REVIEW_FIX_CSV);
  initReviewStage();
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
});

describe("confirmed Review fixes", () => {
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

  it("opens with every issue collapsed and expands only the chosen card", () => {
    openReview();
    const toggles = Array.from(document.querySelectorAll("[data-review-issue]")) as HTMLButtonElement[];
    expect(toggles.length).toBeGreaterThan(1);
    expect(toggles.every(toggle => toggle.getAttribute("aria-expanded") === "false")).toBe(true);

    toggles[0].click();

    const expandedToggles = Array.from(document.querySelectorAll('[data-review-issue][aria-expanded="true"]'));
    expect(expandedToggles).toHaveLength(1);
  });

  it("temporarily replaces the toolbar without discarding Edit mode", () => {
    setUiMode("edit");
    openReview();
    expect(state.uiMode).toBe("edit");

    (document.getElementById("review-exit-button") as HTMLButtonElement).click();
    expect(state.uiMode).toBe("edit");
    expect(document.body.classList.contains("review-open")).toBe(false);
    closeReview();
  });
});
