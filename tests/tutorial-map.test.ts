// The first-open tutorial has its own neutral map. These contracts keep the
// editable CSV, offline embedded string, modelling features and evidence
// examples aligned without coupling the tutorial to either shipped sample.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { TUTORIAL_MAP_CSV, TUTORIAL_MAP_SMALL_CSV } from "../assets/js/01a-tutorial-map-data";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import { serializeLiveStateToCsv } from "../assets/js/05a-csv-serializer";
import { applySimMultiplier } from "../assets/js/14-simulation-panel";
import {
  CATEGORIES,
  EDGES,
  NODES,
  PARAMS,
  STAGES,
  STREAMS,
  cycleInfo,
  layout,
  nodeById,
  state,
} from "../assets/js/03-state";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const tutorialMapFilePath = resolve(currentDirectory, "../assets/data/tutorial_map.csv");
const tutorialMapFileContents = readFileSync(tutorialMapFilePath, "utf8");
const smallTutorialMapFilePath = resolve(currentDirectory, "../assets/data/tutorial_map_small.csv");
const smallTutorialMapFileContents = readFileSync(smallTutorialMapFilePath, "utf8");

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
    expect(NODES).toHaveLength(50);
    expect(EDGES).toHaveLength(83);
    expect(PARAMS).toHaveLength(6);
    expect(STREAMS.map(stream => stream.id)).toEqual([
      "planning", "partnerships", "delivery", "community", "learning",
    ]);
    expect(STAGES.map(stage => stage.id)).toEqual([
      "inputs", "design", "preparedness", "coordination", "engagement", "participation",
      "experience", "outcomes", "follow_up", "learning_cycle",
    ]);
    expect(layout.totalWidth).toBe(2904);
    expect(Object.keys(CATEGORIES)).toEqual(expect.arrayContaining([
      "resource", "capability", "activity", "outcome", "learning", "access",
    ]));
    expect(NODES.some(node => node.categoryIds.length > 1)).toBe(true);
    expect(NODES.filter(node => node.controllable)).toHaveLength(12);
    expect(NODES.map(node => node.id)).toEqual(expect.arrayContaining([
      "partner_readiness",
      "partner_referrals",
      "delivery_experience",
      "community_advocates",
      "data_quality",
      "feedback_responses",
      "service_adaptations",
      "improvement_backlog",
    ]));
    // The learning column is two boxes that mean different things, not five
    // interchangeable counts of "actions".
    expect(NODES.filter(node => node.stage === "learning_cycle").map(node => node.id))
      .toEqual(["improvement_backlog", "service_adaptations"]);
    expect(nodeById.improvement_backlog.unit).not.toBe(nodeById.service_adaptations.unit);
    expect(nodeById.improvement_backlog.direction).toBe("lower_better");
    expect(nodeById.service_adaptations.direction).toBe("higher_better");

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
      .toContain("outreach_reach + partner_referrals + community_events");
    expect(nodeById.registration_share.formula)
      .toBe("clamp(registrations / outreach_reach, 0, 1)");
    expect(nodeById.registration_share.minValue).toBe(0);
    expect(nodeById.registration_share.maxValue).toBe(1);
    expect(nodeById.completed_follow_ups.formula)
      .toBe("attendees_served * completion_share * follow_up_readiness");
    expect(nodeById.unserved_interest.formula)
      .toBe("max(registrations + walk_in_interest - delivery_capacity * seats_per_workshop, 0)");
    expect(nodeById.feedback_uplift.formula).toContain("delay(community_confidence)");
    // Every input to the joint product is a share, so the answer should be a
    // whole number of people rather than 86.4 of them.
    expect(nodeById.completed_follow_ups.baseline).toBe(81);
    expect(Number.isInteger(state.computedValues.completed_follow_ups)).toBe(true);
  });

  it("closes the learning stage back into the system it learns about", () => {
    // The last column used to funnel inwards and stop. Adaptations now change
    // what gets measured, and the backlog they leave behind is felt in delivery.
    expect(edgeFromSourceToTarget("service_adaptations", "data_quality")?.effect).toBe("increases");
    expect(edgeFromSourceToTarget("unserved_interest", "improvement_backlog")?.effect)
      .toBe("increases");
    expect(edgeFromSourceToTarget("improvement_backlog", "facilitator_confidence")?.effect)
      .toBe("decreases");
    for (const learningBoxId of ["service_adaptations", "improvement_backlog"]) {
      expect(EDGES.filter(edge => edge.from === learningBoxId).length,
        learningBoxId).toBeGreaterThan(0);
    }

    // Data quality -> insight -> evidence -> adaptations -> data quality is a
    // second, self-contained loop, and the solver still settles with both.
    expect(state.solverStatus.feedbackLoopCount).toBeGreaterThanOrEqual(2);
    expect(state.solverStatus.converged).toBe(true);
    expect([...cycleInfo.inCycleNodeIds]).toEqual(expect.arrayContaining([
      "service_adaptations",
      "data_quality",
      "insight_quality",
      "evidence_confidence",
    ]));
  });

  it("explains the two capacity links that are allowed to be stronger than the rest", () => {
    // Delivery capacity is a min() gate, so it tracks its scarcest input one for
    // one. Anyone who notices the outlier must find the reason on the link.
    for (const sourceId of ["facilitator_slots", "venue_slots"]) {
      const capacityLink = edgeFromSourceToTarget(sourceId, "delivery_capacity");
      expect(capacityLink?.elasticity, sourceId).toBe(1);
      expect(capacityLink?.description, sourceId).toContain("Strength 1");
    }
    expect(nodeById.delivery_capacity.combine).toBe("min");
    const otherStrengths = EDGES
      .filter(edge => edge.to !== "delivery_capacity" && edge.elasticity !== undefined)
      .map(edge => Math.abs(edge.elasticity as number));
    expect(Math.max(...otherStrengths)).toBeLessThanOrEqual(0.6);
  });

  it("carries assurance defects for Review to find without breaking the model", () => {
    // Deliberate teaching material: three provenance problems, no maths errors.
    expect(state.loadErrors).toEqual([]);

    // 1. No evidence at all on the strongest link into the feedback loop.
    const confidenceLink = edgeFromSourceToTarget("participant_satisfaction", "community_confidence");
    expect(confidenceLink?.elasticity).toBeCloseTo(0.4, 8);
    expect(confidenceLink?.evidence?.status).toBe("unspecified");
    expect(confidenceLink?.evidence?.rationale).toBeFalsy();
    expect(confidenceLink?.evidence?.source).toBeFalsy();

    // 2. A fitted relationship nobody has looked at for years.
    const referralLink = edgeFromSourceToTarget("shared_message", "partner_referrals");
    expect(referralLink?.evidence?.status).toBe("calibrated");
    expect(referralLink?.evidence?.lastReviewed).toBe("2020-11-06");

    // 3. The highest strength outside the capacity gate, on a hypothesis.
    const firstAttendanceLink = edgeFromSourceToTarget("partner_referrals", "first_time_attendees");
    expect(firstAttendanceLink?.elasticity).toBeCloseTo(0.55, 8);
    expect(firstAttendanceLink?.evidence?.status).toBe("hypothesis");
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
    expect(NODES).toHaveLength(50);
    expect(EDGES).toHaveLength(83);
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

// ═════════════════════════════════════════════════════════════════════════════
// THE SMALL MAP
// -----------------------------------------------------------------------------
// The first three lessons run on a twelve-box cut of the same programme. It has
// to be simple enough to trace by eye and exact enough that a learner's first
// slider tells the truth, so the contract is deliberately tight: one loop, two
// formulas, four sliders, and nothing borrowed from the later lessons.
// ═════════════════════════════════════════════════════════════════════════════
describe("small tutorial map", () => {
  beforeEach(() => {
    expect(loadDataFromCsv(TUTORIAL_MAP_SMALL_CSV)).toBe(true);
  });

  it("embeds the dedicated CSV byte for byte for offline use", () => {
    expect(TUTORIAL_MAP_SMALL_CSV).toBe(smallTutorialMapFileContents);
  });

  it("loads without findings and rests every calculated box at baseline", () => {
    expect(state.loadErrors).toEqual([]);
    expect(state.solverStatus.converged).toBe(true);

    for (const node of NODES) {
      if (node.baseline === undefined) continue;
      expect(state.computedValues[node.id], node.label).toBeCloseTo(node.baseline, 8);
    }
  });

  it("has exactly one feedback loop short enough to trace by eye", () => {
    expect(state.solverStatus.feedbackLoopCount).toBe(1);
    expect([...cycleInfo.inCycleNodeIds].sort()).toEqual([
      "community_confidence", "registrations", "unserved_interest",
    ]);
    // Three hops: confidence brings registrations, registrations the programme
    // cannot seat become unserved interest, unserved interest costs confidence.
    expect(edgeFromSourceToTarget("community_confidence", "registrations")?.effect)
      .toBe("increases");
    expect(edgeFromSourceToTarget("registrations", "unserved_interest")?.effect)
      .toBe("increases");
    expect(edgeFromSourceToTarget("unserved_interest", "community_confidence")?.effect)
      .toBe("decreases");
  });

  it("is three rows by four columns with twelve boxes and four sliders", () => {
    expect(NODES).toHaveLength(12);
    expect(STREAMS.map(stream => stream.id)).toEqual(["planning", "delivery", "community"]);
    expect(STAGES.map(stage => stage.id))
      .toEqual(["inputs", "preparedness", "participation", "outcomes"]);
    expect(NODES.filter(node => node.controllable).map(node => node.id)).toEqual([
      "volunteer_hours", "venue_slots", "outreach_effort", "access_barriers",
    ]);
    // Direction is not desirability: one box on the map is better when smaller.
    expect(nodeById.access_barriers.direction).toBe("lower_better");
  });

  it("carries exactly two formulas and none of the later lessons' functions", () => {
    const formulaBoxes = NODES.filter(node => node.formula);
    expect(formulaBoxes.map(node => node.id).sort())
      .toEqual(["outreach_reach", "workshops_delivered"]);
    expect(nodeById.outreach_reach.formula).toBe("outreach_effort * people_reached_per_hour");
    expect(nodeById.workshops_delivered.formula)
      .toBe("min(registrations / seats_per_workshop, venue_slots)");
    for (const laterLessonFunction of ["delay(", "clamp(", "max("]) {
      expect(formulaBoxes.some(node => node.formula?.includes(laterLessonFunction)),
        laterLessonFunction).toBe(false);
    }
    // The gate's answer to the map's question: the venues are the binding arm,
    // so demand alone cannot deliver another session.
    expect(state.computedValues.workshops_delivered).toBeCloseTo(8, 8);
    expect(state.computedValues.registrations / 20).toBeGreaterThan(8);
  });

  it("shares its box ids with the full map so lesson checkpoints carry over", () => {
    expect(NODES.map(node => node.id)).toEqual(expect.arrayContaining([
      "volunteer_hours", "outreach_effort", "access_barriers", "outreach_reach",
      "workshops_delivered", "community_confidence", "workshop_readiness",
    ]));
    expect(nodeById.workshop_readiness.formula).toBeUndefined();
    expect(nodeById.workshop_readiness.combine).toBe("multiplicative");
    expect(PARAMS.map(param => param.id)).toContain("people_reached_per_hour");

    expect(loadDataFromCsv(TUTORIAL_MAP_CSV)).toBe(true);
    const fullMapIdentifiers = new Set(NODES.map(node => node.id));
    expect(loadDataFromCsv(TUTORIAL_MAP_SMALL_CSV)).toBe(true);
    for (const node of NODES) expect(fullMapIdentifiers.has(node.id), node.id).toBe(true);
  });

  it("moves every slider it offers", () => {
    for (const inputIdentifier of NODES.filter(node => node.controllable).map(node => node.id)) {
      expect(loadDataFromCsv(TUTORIAL_MAP_SMALL_CSV)).toBe(true);
      const before = { ...state.computedValues };
      applySimMultiplier(inputIdentifier, 1.5, null);
      expect(state.solverStatus.converged, inputIdentifier).toBe(true);
      const moved = NODES.filter(node =>
        node.id !== inputIdentifier &&
        node.baseline !== undefined &&
        Math.abs(state.computedValues[node.id] - before[node.id]) > 1e-9);
      expect(moved.length, inputIdentifier).toBeGreaterThan(0);
    }
  });
});
