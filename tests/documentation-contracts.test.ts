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
});
