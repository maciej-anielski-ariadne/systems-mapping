import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SOLVER_MAX_ITERATIONS } from "../assets/js/07-simulation-engine";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readProjectFile = (path: string): string => readFileSync(resolve(projectRoot, path), "utf8");

describe("machine-verifiable documentation contracts", () => {
  it("keeps the supported Node runtime aligned across package, CI and README", () => {
    const packageManifest = JSON.parse(readProjectFile("package.json"));
    const continuousIntegrationWorkflow = readProjectFile(".github/workflows/ci.yml");
    const readme = readProjectFile("README.md");

    expect(packageManifest.engines.node).toBe(">=26.0.0");
    expect(continuousIntegrationWorkflow).toContain("node-version: 26");
    expect(readme).toContain("Node.js 26 or newer");
  });

  it("states the actual solver safety cap", () => {
    expect(SOLVER_MAX_ITERATIONS).toBe(250);
    expect(readProjectFile("README.md")).toContain(`${SOLVER_MAX_ITERATIONS}-iteration safety cap`);
  });

  it("documents every persisted review column", () => {
    const readme = readProjectFile("README.md");
    const reviewSection = readme.split("### `reviews` (audit record) — optional")[1]
      ?.split("## Build / Edit wizard")[0] ?? "";
    const reviewColumns = [
      "box", "label", "verdict", "reviewer", "date", "note", "flagged",
      "fingerprint", "flagged_on", "flagged_by", "addressed_on",
      "addressed_by", "addressed_note", "removed_on",
    ];
    for (const column of reviewColumns) expect(reviewSection).toContain(`\`${column}\``);
  });

  it("documents the exact built-artifact and browser gates used by CI", () => {
    const readme = readProjectFile("README.md");
    expect(readme).toContain("npm run test:shuffle");
    expect(readme).toContain("npm run test:browser");
    expect(readme).toContain("dist/systems-map.html");
  });

  it("keeps the scenario-led formula report honest about the shipped border model", () => {
    const report = readProjectFile("docs/formula-modelling-guide.html");
    expect(report).toContain("300 boxes");
    expect(report).toContain("850 links");
    expect(report).toContain("180</b><span>of those boxes actively use Additive");
    expect(report).toContain("currently use formulas, Weakest link, constants or hard bounds");
    expect(report).toContain("proposed modelling scenario");
    expect(report).toContain("Analyst capacity is Adjustable");
    expect(report).toContain("Those incoming Strengths do not calculate it");
  });

  it("documents formula precedence and every supported function in the report", () => {
    const report = readProjectFile("docs/formula-modelling-guide.html");
    expect(report).toContain("Adjustable scenario value → Formula → Combine / link strengths");
    for (const functionName of ["min", "max", "clamp", "delay"]) {
      expect(report).toContain(`<code>${functionName}`);
    }
    expect(report).toContain("previous solver pass—not last month");
    expect(report).toContain("Its answer must equal the target’s starting value");
  });

  it("ties every formula-choice lesson to a worked neutral tutorial example", () => {
    const report = readProjectFile("docs/formula-modelling-guide.html");
    for (const tutorialBoxLabel of [
      "Workshop readiness",
      "People reached",
      "Community confidence",
      "Delivery capacity",
      "Registrations",
      "Registration share",
      "Completed follow-ups",
      "Unserved participant interest",
      "Confidence feedback",
    ]) {
      expect(report).toContain(`<strong>${tutorialBoxLabel}</strong>`);
    }
    expect(report).toContain("no general <code>if/else</code>");
    expect(report).toContain("Open <strong>Learn</strong> and start the first lesson");
  });

  it("separates causal evidence from formula evidence without gating calculations", () => {
    const readme = readProjectFile("README.md");
    const report = readProjectFile("docs/formula-modelling-guide.html");
    const calculationDesign = readProjectFile("docs/CALCULATION-ENGINE-DESIGN.md");
    const combinedDocumentation = [readme, report, calculationDesign].join("\n");

    for (const evidenceStatus of [
      "Unspecified", "Hypothesis", "Supported", "Calibrated", "Validated",
    ]) {
      expect(report).toContain(`<strong>${evidenceStatus}</strong>`);
    }

    for (const evidenceField of [
      "formula_evidence_status",
      "formula_evidence_rationale",
      "formula_evidence_source",
      "formula_evidence_last_reviewed",
      "evidence_status",
      "evidence_rationale",
      "evidence_source",
      "evidence_last_reviewed",
    ]) {
      expect(combinedDocumentation).toContain(evidenceField);
    }

    expect(combinedDocumentation).toContain("causal claim");
    expect(combinedDocumentation).toContain("mathematical form and parameter values");
    expect(combinedDocumentation).toContain("Calibrated or Validated formula");
    expect(combinedDocumentation).toContain("Hypothesis link");
    expect(combinedDocumentation).toContain("informational metadata only");
    expect(combinedDocumentation).toContain("missing or unknown value loads as `unspecified`");
    expect(combinedDocumentation).toContain("empirically fitted relationship");
  });
});
