// The first-open tutorial has its own neutral map. These contracts keep the
// editable CSV, offline embedded string, modelling features and evidence
// examples aligned without coupling the tutorial to either shipped sample.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { TUTORIAL_MAP_CSV } from "../assets/js/01a-tutorial-map-data";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import { serializeLiveStateToCsv } from "../assets/js/05a-csv-serializer";
import { applySimMultiplier } from "../assets/js/14-simulation-panel";
import {
  CATEGORIES,
  EDGES,
  NODES,
  PARAMS,
  cycleInfo,
  nodeById,
  state,
} from "../assets/js/03-state";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const tutorialMapFilePath = resolve(currentDirectory, "../assets/data/tutorial_map.csv");
const tutorialMapFileContents = readFileSync(tutorialMapFilePath, "utf8");

function edgeFromSourceToTarget(sourceIdentifier: string, targetIdentifier: string) {
  return EDGES.find(edge => edge.from === sourceIdentifier && edge.to === targetIdentifier);
}

describe("neutral tutorial map", () => {
  beforeEach(() => {
    expect(loadDataFromCsv(TUTORIAL_MAP_CSV)).toBe(true);
  });

  it("embeds the dedicated CSV byte for byte for offline use", () => {
    expect(TUTORIAL_MAP_CSV).toBe(tutorialMapFileContents);
  });

  it("loads without findings and rests every calculated box at baseline", () => {
    expect(state.loadErrors).toEqual([]);
    expect(state.solverStatus.converged).toBe(true);
    expect(state.solverStatus.feedbackLoopCount).toBeGreaterThanOrEqual(1);
    expect([...cycleInfo.inCycleNodeIds]).toEqual(expect.arrayContaining([
      "community_confidence",
      "feedback_uplift",
      "outreach_reach",
      "registrations",
      "workshops_delivered",
      "attendees_served",
      "participant_satisfaction",
    ]));

    for (const node of NODES) {
      if (node.baseline === undefined) continue;
      expect(state.computedValues[node.id], node.label).toBeCloseTo(node.baseline, 8);
    }
  });

  it("contains the complete tutorial feature inventory", () => {
    expect(NODES).toHaveLength(21);
    expect(EDGES).toHaveLength(25);
    expect(PARAMS).toHaveLength(6);
    expect(Object.keys(CATEGORIES)).toEqual(expect.arrayContaining([
      "resource", "capability", "activity", "outcome", "learning", "access",
    ]));
    expect(NODES.some(node => node.categoryIds.length > 1)).toBe(true);
    expect(NODES.filter(node => node.controllable)).toHaveLength(9);

    expect(new Set(EDGES.map(edge => edge.effect))).toEqual(
      new Set(["enables", "increases", "decreases"]),
    );
    expect(EDGES.some(edge => edge.style === "dashed")).toBe(true);

    expect(nodeById.workshop_readiness.combine).toBe("multiplicative");
    expect(nodeById.delivery_capacity.combine).toBe("min");
    expect(nodeById.community_confidence.combine).toBe("additive");
    expect(NODES.some(node => node.formula?.includes("min("))).toBe(true);
    expect(NODES.some(node => node.formula?.includes("clamp("))).toBe(true);
    expect(NODES.some(node => node.formula?.includes("delay("))).toBe(true);
    expect(NODES.some(node => node.formula?.includes("max("))).toBe(true);
    expect(NODES.some(node => node.minValue !== undefined)).toBe(true);
    expect(NODES.some(node => node.maxValue !== undefined)).toBe(true);
  });

  it("provides named worked examples for every formula-choice lesson", () => {
    expect(nodeById.workshop_readiness.formula).toBeUndefined();
    expect(nodeById.workshop_readiness.combine).toBe("multiplicative");
    expect(edgeFromSourceToTarget("volunteer_hours", "workshop_readiness")?.elasticity)
      .toBeCloseTo(0.35, 8);

    expect(nodeById.outreach_reach.formula)
      .toBe("outreach_effort * people_reached_per_hour * feedback_uplift");
    expect(nodeById.community_confidence.combine).toBe("additive");
    expect(nodeById.delivery_capacity.combine).toBe("min");
    expect(nodeById.registrations.formula)
      .toContain("min(outreach_reach * registration_rate");
    expect(nodeById.registration_share.formula)
      .toBe("clamp(registrations / outreach_reach, 0, 1)");
    expect(nodeById.registration_share.minValue).toBe(0);
    expect(nodeById.registration_share.maxValue).toBe(1);
    expect(nodeById.completed_follow_ups.formula)
      .toBe("attendees_served * completion_share * follow_up_readiness");
    expect(nodeById.unserved_interest.formula)
      .toBe("max(registrations + walk_in_interest - delivery_capacity * seats_per_workshop, 0)");
    expect(nodeById.feedback_uplift.formula).toContain("delay(community_confidence)");
  });

  it("makes the joint product and threshold balance respond as their lessons promise", () => {
    applySimMultiplier("completion_share", 0, null);
    expect(state.computedValues.completed_follow_ups).toBe(0);

    expect(loadDataFromCsv(TUTORIAL_MAP_CSV)).toBe(true);
    applySimMultiplier("walk_in_interest", 2, null);
    expect(state.computedValues.unserved_interest).toBeCloseTo(32, 8);

    expect(loadDataFromCsv(TUTORIAL_MAP_CSV)).toBe(true);
    applySimMultiplier("walk_in_interest", 0, null);
    expect(state.computedValues.unserved_interest).toBe(0);
  });

  it("turns more volunteer time into the downstream changes promised by the tutorial", () => {
    const startingReadiness = state.computedValues.workshop_readiness;
    const startingSatisfaction = state.computedValues.participant_satisfaction;
    const startingConfidence = state.computedValues.community_confidence;
    const startingReach = state.computedValues.outreach_reach;

    // Use the same synchronous public entry point as the simulation panel and
    // detail panel. The solver settles the feedback loop, including delay(),
    // before this call returns.
    applySimMultiplier("volunteer_hours", 1.5, null);

    expect(state.solverStatus.converged).toBe(true);
    expect(state.computedValues.workshop_readiness).toBeGreaterThan(startingReadiness);
    expect(state.computedValues.participant_satisfaction).toBeGreaterThan(startingSatisfaction);
    expect(state.computedValues.community_confidence).toBeGreaterThan(startingConfidence);
    expect(state.computedValues.outreach_reach).toBeGreaterThan(startingReach);
  });

  it("keeps mathematical calibration separate from a hypothesised causal link", () => {
    expect(nodeById.outreach_reach.formulaEvidence).toMatchObject({
      status: "calibrated",
      rationale: "Rate fitted to the tutorial observation set",
      source: "Tutorial observations A",
      lastReviewed: "2026-09-01",
    });
    expect(edgeFromSourceToTarget("outreach_effort", "outreach_reach")?.evidence).toMatchObject({
      status: "hypothesis",
      rationale: "Association fitted but causal effect not established",
    });

    const expectedEvidenceStatuses = new Set([
      "unspecified", "hypothesis", "supported", "calibrated", "validated",
    ]);
    expect(new Set(NODES.map(node => node.formulaEvidence?.status))).toEqual(
      expectedEvidenceStatuses,
    );
    expect(new Set(EDGES.map(edge => edge.evidence?.status))).toEqual(
      expectedEvidenceStatuses,
    );
  });

  it("round-trips calculations styles categories and evidence metadata", () => {
    const serialisedTutorialMap = serializeLiveStateToCsv(undefined, { compact: true });
    expect(loadDataFromCsv(serialisedTutorialMap)).toBe(true);
    expect(state.loadErrors).toEqual([]);
    expect(NODES).toHaveLength(21);
    expect(EDGES).toHaveLength(25);
    expect(PARAMS).toHaveLength(6);
    expect(nodeById.community_confidence.combine).toBe("additive");
    expect(nodeById.registration_share.formula).toContain("clamp(");
    expect(nodeById.completed_follow_ups.formula).toContain("completion_share");
    expect(nodeById.unserved_interest.formula).toContain("max(");
    expect(nodeById.registration_share.secondaryCategories).toContain("learning");
    expect(edgeFromSourceToTarget("community_confidence", "feedback_uplift")?.style).toBe("dashed");
    expect(edgeFromSourceToTarget("venue_slots", "delivery_capacity")?.evidence).toMatchObject({
      status: "validated",
      source: "Tutorial validation cases",
    });
    expect(nodeById.outreach_reach.formulaEvidence?.status).toBe("calibrated");

    for (const node of NODES) {
      if (node.baseline === undefined) continue;
      expect(state.computedValues[node.id], node.label).toBeCloseTo(node.baseline, 8);
    }
  });
});
