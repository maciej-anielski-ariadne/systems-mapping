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

  it("documents formula precedence and every supported function in the reference shelf", () => {
    const shelf = readProjectFile("assets/js/26a-learn-reference.ts");
    expect(shelf).toContain("A formula always takes precedence");
    for (const functionName of ["min(", "max(", "clamp(", "delay("]) {
      expect(shelf).toContain(functionName);
    }
    expect(shelf).toContain("previous");
    expect(shelf).toContain("no general");
    expect(shelf).toContain("if/else");
  });

  it("keeps every reference entry tied to a worked box in the tutorial map", () => {
    const shelf = readProjectFile("assets/js/26a-learn-reference.ts");
    const tutorialMap = readProjectFile("assets/data/tutorial_map.csv");
    const exampleIdentifiers = [...shelf.matchAll(/exampleNodeId: "([a-z_]+)"/g)].map(match => match[1]);

    expect(exampleIdentifiers.length).toBeGreaterThanOrEqual(8);
    for (const identifier of new Set(exampleIdentifiers)) {
      expect(tutorialMap, `${identifier} must still exist in the tutorial map`)
        .toContain(`\n${identifier},`);
    }
  });

  it("keeps the reference shelf standing alone, with no link out to a removed guide", () => {
    const shelf = readProjectFile("assets/js/26a-learn-reference.ts");
    expect(shelf).not.toContain("formula-modelling-guide");
    expect(shelf).not.toContain("guideAnchor");
    expect(() => readProjectFile("docs/formula-modelling-guide.html")).toThrow();
  });

  it("separates causal evidence from formula evidence without gating calculations", () => {
    const readme = readProjectFile("README.md");
    const calculationDesign = readProjectFile("docs/CALCULATION-ENGINE-DESIGN.md");
    const combinedDocumentation = [readme, calculationDesign].join("\n");

    for (const evidenceStatus of [
      "Unspecified", "Hypothesis", "Supported", "Calibrated", "Validated",
    ]) {
      expect(calculationDesign).toContain(evidenceStatus);
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
