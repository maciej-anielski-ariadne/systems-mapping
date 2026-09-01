// =============================================================================
// EVIDENCE METADATA — shared authoring and display helpers
// -----------------------------------------------------------------------------
// Evidence describes how well-supported a causal link or formula is. It is
// deliberately separate from the calculation model: changing any field here
// must never change an elasticity, formula, computed value, or solver path.
// =============================================================================

import type { EvidenceMetadata, EvidenceStatus } from "./types";
import { escapeHtml } from "./04-utils";

export const EVIDENCE_STATUSES: EvidenceStatus[] = [
  "unspecified",
  "hypothesis",
  "supported",
  "calibrated",
  "validated",
];

export function normaliseEvidenceStatus(value: unknown): EvidenceStatus {
  const candidate = String(value || "").trim().toLowerCase();
  return EVIDENCE_STATUSES.includes(candidate as EvidenceStatus)
    ? candidate as EvidenceStatus
    : "unspecified";
}

export function evidenceStatusLabel(status: unknown): string {
  const normalisedStatus = normaliseEvidenceStatus(status);
  return normalisedStatus.charAt(0).toUpperCase() + normalisedStatus.slice(1);
}

export function evidenceMetadataOrDefault(metadata?: EvidenceMetadata | null): EvidenceMetadata {
  return {
    status: normaliseEvidenceStatus(metadata?.status),
    rationale: metadata?.rationale || "",
    source: metadata?.source || "",
    lastReviewed: metadata?.lastReviewed || "",
  };
}

export function evidenceBadgeHtml(metadata?: EvidenceMetadata | null): string {
  const status = normaliseEvidenceStatus(metadata?.status);
  return '<span class="evidence-badge evidence-' + status + '">' +
    escapeHtml(evidenceStatusLabel(status)) + '</span>';
}

export function evidenceStatusOptionsHtml(currentStatus: unknown): string {
  const normalisedStatus = normaliseEvidenceStatus(currentStatus);
  return EVIDENCE_STATUSES.map(status =>
    '<option value="' + status + '"' + (status === normalisedStatus ? " selected" : "") + '>' +
      escapeHtml(evidenceStatusLabel(status)) + '</option>',
  ).join("");
}

export interface EvidenceEditorOptions {
  metadata?: EvidenceMetadata | null;
  scope: "formula" | "edge";
  builderSection?: "nodes" | "edges";
  builderIndex?: number;
  open?: boolean;
}

/**
 * One compact editor used by the box panel and Bulk edit. The badge remains
 * visible while the optional provenance fields stay folded until requested.
 */
export function renderEvidenceEditor(options: EvidenceEditorOptions): string {
  const metadata = evidenceMetadataOrDefault(options.metadata);
  const scopeDescription = options.scope === "formula"
    ? "Evidence for the mathematical form and its parameter values."
    : "Evidence that this causal relationship exists.";
  const statusGuidance = options.scope === "formula"
    ? '<b>Hypothesis</b> proposes a form or parameters for exploration; <b>Supported</b> has relevant evidence or reasoning; ' +
      '<b>Calibrated</b> has been fitted to observed data; <b>Validated</b> has been assessed against separate data, cases, or another stated check.'
    : '<b>Hypothesis</b> proposes a causal direction; <b>Supported</b> has relevant evidence or reasoning; ' +
      '<b>Calibrated</b> means the relationship\'s magnitude was fitted to observations, which alone does not establish causality; ' +
      '<b>Validated</b> means the causal claim was assessed using the stated validation design.';
  const builderAttributes = options.builderSection !== undefined && options.builderIndex !== undefined
    ? ' data-evidence-section="' + options.builderSection + '" data-index="' + options.builderIndex + '"'
    : "";
  const openAttribute = options.open ? " open" : "";

  let html = '<details class="evidence-editor evidence-editor--' + options.scope + '"' + openAttribute + '>';
  html += '<summary><span>Evidence</span>' + evidenceBadgeHtml(metadata) + '</summary>';
  html += '<div class="evidence-editor-body">';
  html += '<p>' + escapeHtml(scopeDescription) + ' This records provenance only; it never changes the calculation.</p>';
  html += '<p>' + statusGuidance + '</p>';
  html += '<label><span>Status</span><select data-evidence-field="status" data-evidence-scope="' + options.scope + '"' + builderAttributes + '>' +
    evidenceStatusOptionsHtml(metadata.status) + '</select></label>';
  html += '<label><span>Rationale</span><textarea rows="2" data-evidence-field="rationale" data-evidence-scope="' + options.scope + '"' +
    builderAttributes + ' placeholder="Why this status is appropriate">' + escapeHtml(metadata.rationale || "") + '</textarea></label>';
  html += '<label><span>Source or citation</span><input type="text" data-evidence-field="source" data-evidence-scope="' + options.scope + '"' +
    builderAttributes + ' value="' + escapeHtml(metadata.source || "") + '" placeholder="Document, dataset, URL, or reference"></label>';
  // A date input silently renders imported non-ISO source text as blank. This
  // preserving text field recommends the interoperable form without erasing
  // what the source actually said.
  html += '<label><span>Last reviewed (YYYY-MM-DD)</span><input type="text" data-evidence-field="lastReviewed" data-evidence-scope="' + options.scope + '"' +
    builderAttributes + ' value="' + escapeHtml(metadata.lastReviewed || "") + '" placeholder="YYYY-MM-DD"></label>';
  html += '</div></details>';
  return html;
}

export function updateEvidenceMetadata(
  metadata: EvidenceMetadata | undefined,
  field: keyof EvidenceMetadata,
  value: string,
): EvidenceMetadata {
  const nextMetadata = evidenceMetadataOrDefault(metadata);
  if (field === "status") {
    nextMetadata.status = normaliseEvidenceStatus(value);
  } else {
    const trimmedValue = value.trim();
    if (trimmedValue) nextMetadata[field] = trimmedValue;
    else delete nextMetadata[field];
  }
  return nextMetadata;
}
