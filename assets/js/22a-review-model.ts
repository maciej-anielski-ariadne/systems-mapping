// =============================================================================
// DETACHED REVIEW MODEL
// -----------------------------------------------------------------------------
// Review proposals are evaluated against clones of the model. Nothing in this
// file writes to shared state: typing in a proposal can therefore solve and
// validate repeatedly without briefly changing the map, its history, or the
// saved CSV.
// =============================================================================

import {
  DEFAULT_ELASTICITY_BY_EFFECT,
  EDGES,
  NODES,
  PARAMS,
  state,
} from "./03-state";
import { parseFormula, evaluateFormulaValue } from "./07a-formula";
import type {
  Edge,
  ElasticityDefaults,
  Finding,
  FindingSeverity,
  GraphNode,
  Param,
  ReviewFixOperation,
  ReviewProposal,
  ReviewProposalPreview,
  ReviewValueChange,
} from "./types";

const SOLVER_MAXIMUM_ITERATIONS = 250;
const SOLVER_CONVERGENCE_EPSILON = 1e-7;
const SOLVER_LOGARITHM_RATIO_FLOOR = 1e-6;
const DISPLAY_CHANGE_THRESHOLD_PERCENT = 0.05;

// A snapshot is immutable by contract. WeakMap identity therefore gives every
// render and proposal preview a revision-safe cache without retaining old maps.
const solvedValuesBySnapshot = new WeakMap<ReviewModelSnapshot, Record<string, number>>();
const findingsBySnapshot = new WeakMap<ReviewModelSnapshot, Finding[]>();
const proposalsBySnapshot = new WeakMap<ReviewModelSnapshot, Map<string, ReviewProposal[]>>();
const previewsBySnapshot = new WeakMap<ReviewModelSnapshot, Map<string, ReviewProposalPreview>>();
const incomingConnectionsBySnapshot = new WeakMap<ReviewModelSnapshot, Map<string, Edge[]>>();

export interface ReviewModelSnapshot {
  nodes: GraphNode[];
  edges: Edge[];
  params: Param[];
  defaultElasticities: ElasticityDefaults;
}

function incomingConnectionsForSnapshot(snapshot: ReviewModelSnapshot): Map<string, Edge[]> {
  const cachedIncomingConnections = incomingConnectionsBySnapshot.get(snapshot);
  if (cachedIncomingConnections) return cachedIncomingConnections;
  const incomingConnections = new Map<string, Edge[]>();
  for (const connection of snapshot.edges) {
    const connections = incomingConnections.get(connection.to);
    if (connections) connections.push(connection);
    else incomingConnections.set(connection.to, [connection]);
  }
  incomingConnectionsBySnapshot.set(snapshot, incomingConnections);
  return incomingConnections;
}

const REVALIDATED_FINDING_KINDS = new Set([
  "formula-unreadable",
  "slider-beats-formula",
  "combine-beats-formula",
  "name-unknown",
  "name-has-no-link",
  "name-has-no-value",
  "link-unused",
  "rest-drift",
]);

export function captureReviewModelSnapshot(): ReviewModelSnapshot {
  return {
    nodes: NODES.map(node => ({ ...node, categoryIds: [...node.categoryIds], primaryCategories: [...node.primaryCategories], secondaryCategories: [...node.secondaryCategories] })),
    edges: EDGES.map(edge => ({ ...edge })),
    params: PARAMS.map(param => ({ ...param })),
    defaultElasticities: { ...DEFAULT_ELASTICITY_BY_EFFECT },
  };
}

export function applyOperationsToReviewSnapshot(
  originalSnapshot: ReviewModelSnapshot,
  operations: ReviewFixOperation[],
): ReviewModelSnapshot {
  const snapshot: ReviewModelSnapshot = {
    nodes: originalSnapshot.nodes.map(node => ({ ...node, categoryIds: [...node.categoryIds], primaryCategories: [...node.primaryCategories], secondaryCategories: [...node.secondaryCategories] })),
    edges: originalSnapshot.edges.map(edge => ({ ...edge })),
    params: originalSnapshot.params.map(param => ({ ...param })),
    defaultElasticities: { ...originalSnapshot.defaultElasticities },
  };

  for (const operation of operations) {
    if (operation.kind === "set-node-field") {
      const node = snapshot.nodes.find(candidate => candidate.id === operation.nodeId);
      if (node) (node as unknown as Record<string, unknown>)[operation.field] = operation.value;
      continue;
    }

    const connectionIndex = snapshot.edges.findIndex(connection =>
      connection.from === operation.sourceId && connection.to === operation.targetId,
    );
    if (operation.kind === "remove-connection") {
      if (connectionIndex >= 0) snapshot.edges.splice(connectionIndex, 1);
    } else if (operation.kind === "add-connection" && connectionIndex < 0) {
      snapshot.edges.push({
        from: operation.sourceId,
        to: operation.targetId,
        effect: operation.effect,
        elasticity: operation.elasticity,
        description: "",
      });
    } else if (operation.kind === "update-connection" && connectionIndex >= 0) {
      snapshot.edges[connectionIndex].effect = operation.effect;
      snapshot.edges[connectionIndex].elasticity = operation.elasticity;
    }
  }
  return snapshot;
}

export function solveReviewSnapshot(snapshot: ReviewModelSnapshot): Record<string, number> {
  const cachedValues = solvedValuesBySnapshot.get(snapshot);
  if (cachedValues) return cachedValues;

  const values: Record<string, number> = {};
  const previousValues: Record<string, number> = {};
  const nodeByIdentifier = Object.fromEntries(snapshot.nodes.map(node => [node.id, node]));
  const paramByIdentifier = Object.fromEntries(snapshot.params.map(param => [param.id, param]));
  const incomingConnections = incomingConnectionsForSnapshot(snapshot);
  const parsedFormulaByNodeIdentifier: Record<string, ReturnType<typeof parseFormula>> = {};

  for (const node of snapshot.nodes) {
    if (node.baseline !== undefined && node.baseline !== null) values[node.id] = node.baseline;
    if (node.formula) {
      try {
        const parsedFormula = parseFormula(node.formula);
        const linkedSourceIdentifiers = new Set(
          (incomingConnections.get(node.id) || []).map(connection => connection.from),
        );
        const missingDependencyArrow = parsedFormula.references.concat(parsedFormula.delayReferences)
          .some(identifier => nodeByIdentifier[identifier] && !linkedSourceIdentifiers.has(identifier));
        if (!missingDependencyArrow || node.controllable) {
          parsedFormulaByNodeIdentifier[node.id] = parsedFormula;
        }
      }
      catch { /* An unreadable formula deliberately falls back to connections. */ }
    }
  }

  for (let iteration = 0; iteration < SOLVER_MAXIMUM_ITERATIONS; iteration++) {
    Object.assign(previousValues, values);
    let largestRelativeChange = 0;

    for (const node of snapshot.nodes) {
      if (node.baseline === undefined || node.baseline === null || node.controllable) continue;
      const parsedFormula = parsedFormulaByNodeIdentifier[node.id];
      let nextValue: number;

      if (parsedFormula) {
        nextValue = evaluateFormulaValue(parsedFormula, {
          lookup(identifier: string): number | undefined {
            return paramByIdentifier[identifier]?.value ?? values[identifier];
          },
          lookupDelayed(identifier: string): number | undefined {
            return paramByIdentifier[identifier]?.value ?? previousValues[identifier];
          },
        });
      } else {
        nextValue = combineIncomingConnections(
          node,
          incomingConnections.get(node.id) || [],
          nodeByIdentifier,
          values,
          snapshot.defaultElasticities,
        );
      }

      if (node.minValue !== undefined && nextValue < node.minValue) nextValue = node.minValue;
      if (node.maxValue !== undefined && nextValue > node.maxValue) nextValue = node.maxValue;
      if (!Number.isFinite(nextValue)) nextValue = node.baseline;

      const previousValue = values[node.id] ?? node.baseline;
      values[node.id] = nextValue;
      const denominator = Math.abs(previousValue) > 1e-300 ? Math.abs(previousValue) : 1;
      largestRelativeChange = Math.max(largestRelativeChange, Math.abs(nextValue - previousValue) / denominator);
    }

    if (largestRelativeChange < SOLVER_CONVERGENCE_EPSILON) break;
  }
  solvedValuesBySnapshot.set(snapshot, values);
  return values;
}

function combineIncomingConnections(
  node: GraphNode,
  connections: Edge[],
  nodeByIdentifier: Record<string, GraphNode>,
  values: Record<string, number>,
  defaultElasticities: ElasticityDefaults,
): number {
  const baseline = node.baseline as number;
  let logarithmSum = 0;
  let additiveSum = 0;
  let smallestFactor = 1;
  let usableConnectionCount = 0;

  for (const connection of connections) {
    const sourceNode = nodeByIdentifier[connection.from];
    const sourceBaseline = sourceNode?.baseline;
    const sourceValue = values[connection.from];
    if (sourceBaseline === undefined || sourceBaseline === 0 || sourceValue === undefined) continue;
    const sourceRatio = sourceValue / sourceBaseline;
    const elasticity = connection.elasticity ?? defaultElasticities[connection.effect];
    if ((node.combine || "multiplicative") === "additive") {
      additiveSum += elasticity * (sourceRatio - 1);
    } else {
      const factor = Math.exp(elasticity * Math.log(Math.max(sourceRatio, SOLVER_LOGARITHM_RATIO_FLOOR)));
      if ((node.combine || "multiplicative") === "min") {
        if (usableConnectionCount === 0 || factor < smallestFactor) smallestFactor = factor;
      } else {
        logarithmSum += Math.log(factor);
      }
    }
    usableConnectionCount++;
  }

  if ((node.combine || "multiplicative") === "additive") return baseline * (1 + additiveSum);
  if ((node.combine || "multiplicative") === "min") return baseline * (usableConnectionCount ? smallestFactor : 1);
  return baseline * Math.exp(logarithmSum);
}

function makeFinding(
  kind: string,
  severity: FindingSeverity,
  boxId: string,
  discriminator: string,
  message: string,
  fix: string,
  target: Finding["target"],
): Finding {
  return { kind, severity, boxId, issueKey: [kind, boxId, discriminator].join(":"), message, fix, target };
}

export function validateReviewSnapshot(snapshot: ReviewModelSnapshot): Finding[] {
  const cachedFindings = findingsBySnapshot.get(snapshot);
  if (cachedFindings) return cachedFindings;

  const findings: Finding[] = [];
  const values = solveReviewSnapshot(snapshot);
  const nodeByIdentifier = Object.fromEntries(snapshot.nodes.map(node => [node.id, node]));
  const paramIdentifiers = new Set(snapshot.params.map(param => param.id));
  const incomingConnections = incomingConnectionsForSnapshot(snapshot);

  for (const node of snapshot.nodes) {
    let parsedFormula: ReturnType<typeof parseFormula> | null = null;
    if (node.formula) {
      try { parsedFormula = parseFormula(node.formula); }
      catch (error) {
        const message = error instanceof Error ? error.message : "Unknown formula error";
        findings.push(makeFinding("formula-unreadable", "ignored", node.id, "formula",
          "Its formula can't be read: " + message + ". The formula is ignored, so the box falls back to its links.",
          "Fix the expression, or clear the formula cell.",
          { kind: "node-field", nodeId: node.id, field: "formula" }));
      }
    }

    if (parsedFormula && node.controllable) {
      findings.push(makeFinding("slider-beats-formula", "ignored", node.id, "formula",
        "It is ticked adjustable and also has a formula. The slider pins the box, so the formula is dead text.",
        "Untick adjustable, or delete the formula.",
        { kind: "node-field", nodeId: node.id, field: "controllable" }));
    }
    const linkedSourceIdentifiers = new Set(
      (incomingConnections.get(node.id) || []).map(connection => connection.from),
    );
    const missingDependencyArrow = !!parsedFormula && parsedFormula.references.concat(parsedFormula.delayReferences)
      .some(identifier => nodeByIdentifier[identifier] && !linkedSourceIdentifiers.has(identifier));
    const formulaIsActive = !!parsedFormula && !node.controllable && !missingDependencyArrow;

    if (formulaIsActive && node.combine) {
      findings.push(makeFinding("combine-beats-formula", "ignored", node.id, "combine",
        "It has both a combine rule (`" + node.combine + "`) and a formula. The combine rule describes how links add up; the formula replaces them, so the combine rule is ignored.",
        "Clear the combine cell.",
        { kind: "node-field", nodeId: node.id, field: "combine" }));
    }

    if (parsedFormula && !node.controllable) {
      const referencedIdentifiers = new Set([...parsedFormula.references, ...parsedFormula.delayReferences]);
      for (const referencedIdentifier of referencedIdentifiers) {
        if (paramIdentifiers.has(referencedIdentifier)) continue;
        if (!nodeByIdentifier[referencedIdentifier]) {
          findings.push(makeFinding("name-unknown", "wrong", node.id, referencedIdentifier,
            "Its formula mentions `" + referencedIdentifier + "`, which is neither a box nor a constant. It will be read as 0.",
            "Check the spelling, or add the constant.",
            { kind: "formula-reference", nodeId: node.id, referencedId: referencedIdentifier }));
          continue;
        }
        if (!linkedSourceIdentifiers.has(referencedIdentifier)) {
          findings.push(makeFinding("name-has-no-link", "mismatch", node.id, referencedIdentifier,
            "Its formula uses `" + referencedIdentifier + "`, but no link joins the two — the map's links must show every causal input. The formula is ignored until the link is drawn, so the box falls back to its incoming links.",
            "Draw the link from `" + referencedIdentifier + "`, or drop the term.",
            { kind: "connection", sourceId: referencedIdentifier, targetId: node.id }));
        }
        if (nodeByIdentifier[referencedIdentifier].baseline === undefined) {
          findings.push(makeFinding("name-has-no-value", "wrong", node.id, referencedIdentifier,
            "Its formula uses `" + referencedIdentifier + "`, which has no starting value and will be read as 0.",
            "Give it a starting value, or drop the term.",
            { kind: "formula-reference", nodeId: node.id, referencedId: referencedIdentifier }));
        }
      }
      for (const linkedSourceIdentifier of linkedSourceIdentifiers) {
        if (!formulaIsActive) break;
        if (referencedIdentifiers.has(linkedSourceIdentifier)) continue;
        findings.push(makeFinding("link-unused", "mismatch", node.id, linkedSourceIdentifier,
          "A link from `" + linkedSourceIdentifier + "` points at it but its formula never reads that link.",
          "Read it in the formula, or remove the link.",
          { kind: "connection", sourceId: linkedSourceIdentifier, targetId: node.id }));
      }
    }

    if (node.baseline !== undefined) {
      const value = values[node.id];
      if (value !== undefined) {
        const percentDifference = node.baseline === 0
          ? (value === 0 ? 0 : Infinity)
          : ((value - node.baseline) / node.baseline) * 100;
        if (Math.abs(percentDifference) >= DISPLAY_CHANGE_THRESHOLD_PERCENT) {
          findings.push(makeFinding("rest-drift", "wrong", node.id, "baseline",
            "It does not rest at its starting value: it says " + node.baseline + " but opens at " + value + ".",
            "Choose whether the starting value, formula, or limit is wrong.",
            { kind: "node-field", nodeId: node.id, field: "baseline" }));
        }
      }
    }
  }
  findingsBySnapshot.set(snapshot, findings);
  return findings;
}

/** Replace only checks that can be reproduced from the live model. Import-row
 * findings are preserved because the invalid row may deliberately not exist in
 * the live data and cannot be reconstructed after loading. */
export function refreshLiveReviewFindings(): void {
  const preservedFindings = state.loadErrors.filter(finding => !REVALIDATED_FINDING_KINDS.has(finding.kind));
  state.loadErrors.splice(0, state.loadErrors.length, ...preservedFindings, ...validateReviewSnapshot(captureReviewModelSnapshot()));
  if (typeof document !== "undefined") document.dispatchEvent(new CustomEvent("review-findings-changed"));
}

export function reviewProposalsForFinding(finding: Finding, snapshot: ReviewModelSnapshot): ReviewProposal[] {
  const issueKey = finding.issueKey || [finding.kind, finding.boxId || "map", finding.message].join(":");
  let snapshotProposals = proposalsBySnapshot.get(snapshot);
  if (!snapshotProposals) {
    snapshotProposals = new Map<string, ReviewProposal[]>();
    proposalsBySnapshot.set(snapshot, snapshotProposals);
  }
  const cachedProposals = snapshotProposals.get(issueKey);
  if (cachedProposals) return cachedProposals;

  const node = finding.boxId ? snapshot.nodes.find(candidate => candidate.id === finding.boxId) : undefined;
  if (!finding.target || !node) return [];
  const proposals: ReviewProposal[] = [];
  const addProposal = (id: string, label: string, explanation: string, operations: ReviewFixOperation[]): void => {
    proposals.push({ id: issueKey + ":" + id, label, explanation, operations });
  };

  if (finding.kind === "slider-beats-formula") {
    addProposal("use-formula", "Use the formula", "Untick Adjustable so the formula calculates this box.",
      [{ kind: "set-node-field", nodeId: node.id, field: "controllable", value: false }]);
    addProposal("use-slider", "Use the slider", "Keep this as an adjustable input and remove its unused formula.",
      [{ kind: "set-node-field", nodeId: node.id, field: "formula", value: undefined }]);
  } else if (finding.kind === "combine-beats-formula") {
    addProposal("use-formula", "Use the formula", "Remove the combine rule that the formula already replaces.",
      [{ kind: "set-node-field", nodeId: node.id, field: "combine", value: undefined }]);
    addProposal("use-connections", "Use the connections", "Remove the formula and calculate from incoming connections.",
      [{ kind: "set-node-field", nodeId: node.id, field: "formula", value: undefined }]);
  } else if (finding.kind === "formula-unreadable") {
    const repairedFormula = repairUnbalancedParentheses(node.formula || "");
    if (repairedFormula && repairedFormula !== node.formula) {
      try {
        parseFormula(repairedFormula);
        addProposal("repair-formula", "Repair the brackets", "Balance the formula's brackets and keep the expression.",
          [{ kind: "set-node-field", nodeId: node.id, field: "formula", value: repairedFormula }]);
      } catch { /* A best-effort repair is offered only when it parses. */ }
    }
    addProposal("clear-formula", "Remove the formula", "Fall back to the box's incoming connections.",
      [{ kind: "set-node-field", nodeId: node.id, field: "formula", value: undefined }]);
  } else if (finding.kind === "name-has-no-link" && finding.target.kind === "connection") {
    for (const effect of ["increases", "enables", "decreases"] as const) {
      addProposal("add-" + effect, "Add an “" + effect + "” connection", "Make the map show the input already used by the formula.",
        [{ kind: "add-connection", sourceId: finding.target.sourceId, targetId: finding.target.targetId, effect }]);
    }
  } else if (finding.kind === "link-unused" && finding.target.kind === "connection") {
    addProposal("remove-link", "Remove the unused connection", "The formula does not read this connection, so remove it from the picture.",
      [{ kind: "remove-connection", sourceId: finding.target.sourceId, targetId: finding.target.targetId }]);
  } else if (finding.kind === "name-unknown" && finding.target.kind === "formula-reference" && node.formula) {
    const replacementIdentifier = closestIdentifier(finding.target.referencedId, snapshot);
    if (replacementIdentifier) {
      addProposal("correct-name", "Use `" + replacementIdentifier + "`", "Replace the unknown name with the closest existing identifier.",
        [{ kind: "set-node-field", nodeId: node.id, field: "formula", value: replaceFormulaIdentifier(node.formula, finding.target.referencedId, replacementIdentifier) }]);
    }
  } else if (finding.kind === "rest-drift") {
    const values = solveReviewSnapshot(snapshot);
    const restingValue = values[node.id];
    if (restingValue !== undefined) {
      addProposal("accept-rest", "Set the starting value to " + restingValue.toPrecision(5), "Make the declared starting value agree with the current calculation.",
        [{ kind: "set-node-field", nodeId: node.id, field: "baseline", value: restingValue }]);
    }
    if (node.maxValue !== undefined && node.baseline !== undefined && node.maxValue < node.baseline) {
      addProposal("raise-maximum", "Raise the maximum to " + node.baseline, "Keep the starting value and move the excluding maximum.",
        [{ kind: "set-node-field", nodeId: node.id, field: "maxValue", value: node.baseline }]);
    }
    if (node.minValue !== undefined && node.baseline !== undefined && node.minValue > node.baseline) {
      addProposal("lower-minimum", "Lower the minimum to " + node.baseline, "Keep the starting value and move the excluding minimum.",
        [{ kind: "set-node-field", nodeId: node.id, field: "minValue", value: node.baseline }]);
    }
  }

  const rankedProposals = rankReviewProposals(snapshot, proposals).slice(0, 3);
  snapshotProposals.set(issueKey, rankedProposals);
  return rankedProposals;
}

// Used by the collapsed Review list. This deliberately answers only whether a
// proposal can exist; generating/ranking proposals performs detached solves and
// belongs to the one card the reader expands.
export function reviewFindingCanHaveProposal(finding: Finding, snapshot: ReviewModelSnapshot): boolean {
  if (!finding.target || !finding.boxId || !snapshot.nodes.some(node => node.id === finding.boxId)) return false;
  if (finding.kind === "slider-beats-formula" || finding.kind === "combine-beats-formula" ||
      finding.kind === "formula-unreadable" || finding.kind === "name-has-no-link" ||
      finding.kind === "link-unused" || finding.kind === "rest-drift") return true;
  return finding.kind === "name-unknown" && finding.target.kind === "formula-reference" &&
    closestIdentifier(finding.target.referencedId, snapshot) !== null;
}

export function previewReviewProposal(
  snapshot: ReviewModelSnapshot,
  proposal: ReviewProposal,
): ReviewProposalPreview {
  let snapshotPreviews = previewsBySnapshot.get(snapshot);
  if (!snapshotPreviews) {
    snapshotPreviews = new Map<string, ReviewProposalPreview>();
    previewsBySnapshot.set(snapshot, snapshotPreviews);
  }
  const previewKey = proposal.id + "\u0000" + JSON.stringify(proposal.operations);
  const cachedPreview = snapshotPreviews.get(previewKey);
  if (cachedPreview) return cachedPreview;

  const beforeFindings = validateReviewSnapshot(snapshot);
  const afterSnapshot = applyOperationsToReviewSnapshot(snapshot, proposal.operations);
  const afterFindings = validateReviewSnapshot(afterSnapshot);
  const beforeKeys = new Set(beforeFindings.map(finding => finding.issueKey));
  const afterKeys = new Set(afterFindings.map(finding => finding.issueKey));
  const beforeValues = solveReviewSnapshot(snapshot);
  const afterValues = solveReviewSnapshot(afterSnapshot);
  const afterNodeByIdentifier = Object.fromEntries(afterSnapshot.nodes.map(node => [node.id, node]));
  const valueChanges: ReviewValueChange[] = [];

  for (const nodeIdentifier of Object.keys(beforeValues)) {
    const before = beforeValues[nodeIdentifier];
    const after = afterValues[nodeIdentifier];
    if (after === undefined || before === after) continue;
    const percentChange = before === 0 ? null : ((after - before) / before) * 100;
    if (percentChange !== null && Math.abs(percentChange) < DISPLAY_CHANGE_THRESHOLD_PERCENT) continue;
    valueChanges.push({ nodeId: nodeIdentifier, label: afterNodeByIdentifier[nodeIdentifier]?.label || nodeIdentifier, before, after, percentChange });
  }
  valueChanges.sort((left, right) => Math.abs(right.percentChange ?? Infinity) - Math.abs(left.percentChange ?? Infinity));

  const preview = {
    issuesCleared: [...beforeKeys].filter(key => !afterKeys.has(key)).length,
    issuesIntroduced: [...afterKeys].filter(key => !beforeKeys.has(key)).length,
    remainingIssueCount: afterFindings.length,
    valueChanges,
  };
  snapshotPreviews.set(previewKey, preview);
  return preview;
}

function rankReviewProposals(
  snapshot: ReviewModelSnapshot,
  proposals: ReviewProposal[],
): ReviewProposal[] {
  const previewByProposalIdentifier = new Map(
    proposals.map(proposal => [proposal.id, previewReviewProposal(snapshot, proposal)]),
  );
  return proposals.sort((left, right) => {
    const leftPreview = previewByProposalIdentifier.get(left.id)!;
    const rightPreview = previewByProposalIdentifier.get(right.id)!;
    return rightPreview.issuesCleared - leftPreview.issuesCleared
      || leftPreview.issuesIntroduced - rightPreview.issuesIntroduced
      || left.operations.length - right.operations.length;
  });
}

function repairUnbalancedParentheses(formula: string): string | null {
  let balance = 0;
  for (const character of formula) {
    if (character === "(") balance++;
    if (character === ")") balance--;
    if (balance < 0) return null;
  }
  return balance > 0 ? formula + ")".repeat(balance) : null;
}

function replaceFormulaIdentifier(formula: string, fromIdentifier: string, toIdentifier: string): string {
  return formula.replace(new RegExp("\\b" + fromIdentifier.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&") + "\\b", "g"), toIdentifier);
}

function closestIdentifier(unknownIdentifier: string, snapshot: ReviewModelSnapshot): string | null {
  const identifiers = [...snapshot.nodes.map(node => node.id), ...snapshot.params.map(param => param.id)];
  let bestIdentifier: string | null = null;
  let bestDistance = Infinity;
  for (const identifier of identifiers) {
    const distance = editDistance(unknownIdentifier, identifier);
    if (distance < bestDistance) { bestDistance = distance; bestIdentifier = identifier; }
  }
  const maximumDistance = Math.max(2, Math.floor(unknownIdentifier.length / 3));
  return bestDistance <= maximumDistance ? bestIdentifier : null;
}

function editDistance(left: string, right: string): number {
  const previousRow = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    const currentRow = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      currentRow[rightIndex] = Math.min(
        currentRow[rightIndex - 1] + 1,
        previousRow[rightIndex] + 1,
        previousRow[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previousRow.splice(0, previousRow.length, ...currentRow);
  }
  return previousRow[right.length];
}
