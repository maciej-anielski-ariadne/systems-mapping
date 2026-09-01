import { beforeEach, describe, expect, it } from "vitest";
import { EDGES, NODES, state } from "../assets/js/03-state";
import { flushPendingSaves, loadCsvFromStorage } from "../assets/js/04a-storage";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import { selectNode } from "../assets/js/09-graph-selection";
import { renderDetailPanel } from "../assets/js/15-detail-panel";
import { openBuilder, closeBuilder } from "../assets/js/16a-builder-state";
import { renderBuilder } from "../assets/js/16b-builder-render";
import { setUiMode } from "../assets/js/17-events";
import {
  initReviewStage,
  openReview,
  closeReview,
  reviewEvidenceItems,
  syncReviewButton,
} from "../assets/js/23-review-panel";

const EVIDENCE_CSV = `# SECTION: streams
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
conversion_rate,1,Neutral conversion rate

# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max,combine,formula,min,max,formula_evidence_status,formula_evidence_rationale,formula_evidence_source,formula_evidence_last_reviewed
input,Input,,main,inputs,thing,100,units,true,,2,,,,,unspecified,,,
outcome,Outcome,,main,outcomes,thing,100,units,,higher_better,,,input * conversion_rate,,,calibrated,Fitted to a baseline study,Study B,2026-08-01

# SECTION: edges
from,to,effect,elasticity,style,description,evidence_status,evidence_rationale,evidence_source,evidence_last_reviewed
input,outcome,increases,0.5,,Input is expected to increase the outcome,supported,Repeated observational finding,Study A,1 August 2026
`;

function changeValue(input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

beforeEach(() => {
  expect(loadDataFromCsv(EVIDENCE_CSV)).toBe(true);
  state.canvasEdit.openEdgeId = null;
  setUiMode("read");
});

describe("evidence authoring", () => {
  it("edits formula evidence without changing computed values or drawing a map badge", () => {
    const outcome = NODES.find(node => node.id === "outcome")!;
    const computedBefore = { ...state.computedValues };
    setUiMode("edit");
    selectNode(outcome.id);
    renderDetailPanel();

    const status = document.querySelector(
      '[data-evidence-scope="formula"][data-evidence-field="status"]',
    ) as HTMLSelectElement;
    expect(status.value).toBe("calibrated");
    expect(status.closest(".evidence-editor")?.textContent).toContain("form or parameters");
    const source = document.querySelector(
      '[data-evidence-scope="formula"][data-evidence-field="source"]',
    ) as HTMLInputElement;
    source.value = "Independent model comparison";
    source.dispatchEvent(new Event("input", { bubbles: true }));
    expect(outcome.formulaEvidence?.source).toBe("Independent model comparison");
    changeValue(status, "validated");

    expect(outcome.formulaEvidence?.status).toBe("validated");
    expect(state.computedValues).toEqual(computedBefore);
    expect(status.closest(".evidence-editor")?.querySelector(".evidence-badge")?.textContent).toBe("Validated");
    expect(document.getElementById("viz-svg")?.textContent).not.toContain("Validated");
  });

  it("edits causal-link evidence from the unfolded link controls", () => {
    const edge = EDGES[0];
    const computedBefore = { ...state.computedValues };
    setUiMode("edit");
    selectNode("input");
    state.canvasEdit.openEdgeId = edge.id || null;
    renderDetailPanel();

    const rationale = document.querySelector(
      '.edge-open [data-evidence-scope="edge"][data-evidence-field="rationale"]',
    ) as HTMLTextAreaElement;
    expect(rationale.value).toMatch(/observational/);
    expect(rationale.closest(".evidence-editor")?.textContent).toContain("does not establish causality");
    const lastReviewed = document.querySelector(
      '.edge-open [data-evidence-scope="edge"][data-evidence-field="lastReviewed"]',
    ) as HTMLInputElement;
    expect(lastReviewed.type).toBe("text");
    expect(lastReviewed.value).toBe("1 August 2026");
    expect(lastReviewed.previousElementSibling?.textContent).toContain("YYYY-MM-DD");
    const historyLengthBeforeTyping = state.history.past.length;
    rationale.value = "Triangulated";
    rationale.dispatchEvent(new Event("input", { bubbles: true }));
    rationale.value = "Triangulated across two studies";
    rationale.dispatchEvent(new Event("input", { bubbles: true }));

    expect(edge.evidence?.rationale).toBe("Triangulated across two studies");
    expect(state.computedValues).toEqual(computedBefore);
    expect(state.history.past.length).toBe(historyLengthBeforeTyping + 1);

    // No blur/change event: pagehide's normal flush must still have a pending
    // CSV containing the latest text.
    flushPendingSaves();
    expect(loadCsvFromStorage()).toContain("Triangulated across two studies");
  });

  it("keeps provenance when Bulk edit clones the live map and edits nested fields", () => {
    openBuilder({ fromLoadedData: true });
    state.builder.step = 4;
    renderBuilder();
    const formulaEditor = document.querySelector(
      '.builder-evidence-cell [data-evidence-section="nodes"][data-evidence-field="status"][data-index="1"]',
    ) as HTMLSelectElement;
    expect(formulaEditor.value).toBe("calibrated");
    changeValue(formulaEditor, "validated");
    expect(state.builder.nodes[1].formulaEvidence?.status).toBe("validated");

    state.builder.step = 5;
    renderBuilder();
    const linkEditor = document.querySelector(
      '.builder-evidence-cell [data-evidence-section="edges"][data-evidence-field="source"][data-index="0"]',
    ) as HTMLInputElement;
    expect(linkEditor.value).toBe("Study A");
    changeValue(linkEditor, "Study A; Study C");
    expect(state.builder.edges[0].evidence?.source).toBe("Study A; Study C");
    closeBuilder();
  });
});

describe("evidence in Review", () => {
  it("includes recorded formula evidence before a formula exists, but omits a truly blank record", () => {
    const input = NODES.find(node => node.id === "input")!;
    expect(input.formula).toBeUndefined();
    expect(reviewEvidenceItems().find(item => item.id === "formula:input")).toBeUndefined();

    input.formulaEvidence = {
      status: "hypothesis",
      rationale: "The proposed form still needs testing",
    };
    const recordedItem = reviewEvidenceItems().find(item => item.id === "formula:input");
    expect(recordedItem).toMatchObject({
      kind: "formula",
      detail: "Formula not set",
      metadata: {
        status: "hypothesis",
        rationale: "The proposed form still needs testing",
      },
    });
  });

  it("lists formula and link provenance as filterable information", () => {
    expect(reviewEvidenceItems().map(item => item.kind).sort()).toEqual(["formula", "link"]);
    initReviewStage();
    syncReviewButton();
    expect(document.querySelector("#review-button .review-badge")).toBeNull();
    openReview();

    expect(document.querySelectorAll(".review-evidence-item")).toHaveLength(2);
    expect(document.querySelector(".review-evidence-list")?.textContent).toContain("Calibrated");
    expect(document.querySelector(".review-evidence-list")?.textContent).toContain("Supported");

    const filter = document.getElementById("review-evidence-filter") as HTMLSelectElement;
    changeValue(filter, "supported");
    expect(document.querySelectorAll(".review-evidence-item")).toHaveLength(1);
    const linkEvidenceItem = document.querySelector(".review-evidence-item") as HTMLElement;
    expect(linkEvidenceItem.textContent).toContain("Causal link");
    expect(linkEvidenceItem.getAttribute("data-review-box")).toBe("input");

    linkEvidenceItem.click();
    expect(state.uiMode).toBe("edit");
    expect(state.selectedNodeId).toBe("input");
    expect(state.canvasEdit.openEdgeId).toBe(EDGES[0].id);
    expect(document.querySelector('.edge-open [data-evidence-scope="edge"]')).not.toBeNull();
    closeReview();
  });

  it("reveals large evidence inventories in bounded batches", () => {
    const templateEdge = EDGES[0];
    for (let edgeIndex = 0; edgeIndex < 205; edgeIndex++) {
      EDGES.push({ ...templateEdge, id: "evidence_scale_" + edgeIndex });
    }
    initReviewStage();
    openReview();
    const filter = document.getElementById("review-evidence-filter") as HTMLSelectElement;
    changeValue(filter, "all");

    expect(document.querySelectorAll(".review-evidence-item")).toHaveLength(100);
    let moreButton = document.getElementById("review-evidence-more") as HTMLButtonElement;
    expect(moreButton.textContent).toContain("Show 100 more");
    moreButton.click();
    expect(document.querySelectorAll(".review-evidence-item")).toHaveLength(200);

    moreButton = document.getElementById("review-evidence-more") as HTMLButtonElement;
    expect(moreButton.textContent).toContain("Show 7 more");
    moreButton.click();
    expect(document.querySelectorAll(".review-evidence-item")).toHaveLength(207);
    expect(document.getElementById("review-evidence-more")).toBeNull();
    closeReview();
  });
});
