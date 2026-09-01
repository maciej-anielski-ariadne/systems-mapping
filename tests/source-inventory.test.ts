import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This deliberately proves only the README's source-file inventory. Behavioral
// and schema truth are checked separately in documentation-contracts.test.ts
// and in the built-artifact browser acceptance suite.
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(resolve(projectRoot, "README.md"), "utf8");

function sourceFileNames(directory: string, extension: string): string[] {
  return readdirSync(resolve(projectRoot, directory))
    .filter(fileName => fileName.endsWith(extension))
    .sort();
}

describe("README source-file inventory", () => {
  it.each(sourceFileNames("assets/js", ".ts"))(
    "lists assets/js/%s",
    fileName => {
      expect(readme, `add "${fileName}" to the README Files section`).toContain(fileName);
    },
  );

  it.each(sourceFileNames("assets/css", ".css"))(
    "lists assets/css/%s",
    fileName => {
      expect(readme, `add "${fileName}" to the README Files section`).toContain(fileName);
    },
  );
});
