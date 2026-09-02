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

  it("opens with every issue collapsed and expands only the chosen card", () => {
    openReview();
    const toggles = Array.from(document.querySelectorAll("[data-review-issue]")) as HTMLButtonElement[];
    expect(toggles.length).toBeGreaterThan(1);
    expect(toggles.every(toggle => toggle.getAttribute("aria-expanded") === "false")).toBe(true);

    toggles[0].click();

    const expandedToggles = Array.from(document.querySelectorAll('[data-review-issue][aria-expanded="true"]'));
    expect(expandedToggles).toHaveLength(1);
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

  it("groups the floating handoff actions after opening an issue on the map", () => {
    openReview();
    const firstIssueToggle = document.querySelector<HTMLButtonElement>("[data-review-issue]")!;
    firstIssueToggle.click();
    const openOnMapButton = document.querySelector<HTMLButtonElement>("[data-open-review-issue]")!;
    openOnMapButton.click();

    const issueBanner = document.getElementById("review-issue-banner")!;
    expect(issueBanner.hidden).toBe(false);
    expect(issueBanner.querySelector(":scope > .review-banner-main")).not.toBeNull();
    expect(issueBanner.querySelector(":scope > .review-banner-dismiss")).not.toBeNull();

    issueBanner.querySelector<HTMLButtonElement>("#review-banner-toggle")!.click();
    const actionGroup = issueBanner.querySelector(".review-banner-actions")!;
    expect(actionGroup.querySelectorAll(":scope > button")).toHaveLength(1);
    expect(actionGroup.textContent).toContain("Back to Review");
  });

  it("keeps the floating handoff borderless at the top of the map", () => {
    const reviewStyles = readFileSync(resolve(currentDirectory, "../assets/css/17-review.css"), "utf8");
    const bannerRuleStart = reviewStyles.indexOf(".review-issue-banner {");
    const bannerRule = reviewStyles.slice(
      bannerRuleStart,
      reviewStyles.indexOf("}", bannerRuleStart),
    );

    expect(bannerRule).toMatch(/top:\s*calc\(48px \+ var\(--space-3\)\)/);
    expect(bannerRule).toMatch(/bottom:\s*auto/);
    expect(bannerRule).toMatch(/border:\s*0/);
    expect(bannerRule).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\) 40px/);
  });
});
