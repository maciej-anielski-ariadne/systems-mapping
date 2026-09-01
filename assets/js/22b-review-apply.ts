// =============================================================================
// CONFIRMED REVIEW PATCHES
// -----------------------------------------------------------------------------
// Proposals stay detached until the author confirms one. This is the only
// bridge back to the live model, and it applies every operation before calling
// the canvas mutation chokepoint once. One confirmation is therefore one CSV
// snapshot and one Undo step, even when a proposal changes several things.
// =============================================================================

import { EDGES, NODES, markEdgeGeometryChanged, setEdges } from "./03-state";
import { applyCanvasMutation } from "./16f-canvas-mutations";
import type { Edge, ReviewFixOperation, ReviewProposal } from "./types";

export function applyConfirmedReviewProposal(proposal: ReviewProposal): boolean {
  if (!proposal.operations.length) return false;
  for (const operation of proposal.operations) applyOperationToLiveModel(operation);
  applyCanvasMutation();
  return true;
}

function applyOperationToLiveModel(operation: ReviewFixOperation): void {
  if (operation.kind === "set-node-field") {
    const node = NODES.find(candidate => candidate.id === operation.nodeId);
    if (!node) return;
    if (operation.value === undefined || operation.value === "") {
      delete (node as unknown as Record<string, unknown>)[operation.field];
    } else {
      (node as unknown as Record<string, unknown>)[operation.field] = operation.value;
    }
    return;
  }

  const connectionIndex = EDGES.findIndex(connection =>
    connection.from === operation.sourceId && connection.to === operation.targetId,
  );
  if (operation.kind === "remove-connection") {
    if (connectionIndex >= 0) setEdges(EDGES.filter((_, index) => index !== connectionIndex));
    return;
  }
  if (operation.kind === "add-connection") {
    if (connectionIndex >= 0) return;
    const connection: Edge = {
      from: operation.sourceId,
      to: operation.targetId,
      effect: operation.effect,
      description: "",
    };
    if (operation.elasticity !== undefined) connection.elasticity = operation.elasticity;
    EDGES.push(connection);
    markEdgeGeometryChanged();
    return;
  }
  if (connectionIndex >= 0) {
    EDGES[connectionIndex].effect = operation.effect;
    if (operation.elasticity === undefined) delete EDGES[connectionIndex].elasticity;
    else EDGES[connectionIndex].elasticity = operation.elasticity;
    markEdgeGeometryChanged();
  }
}
