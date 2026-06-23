import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Guard against documentation drift: every source file under assets/js and
// assets/css must be named somewhere in the top-level README. If you add a
// module and forget to document it, this test fails and tells you which file.
// Keeps the README's "Files" / "Editing the app" tables a trustworthy index
// for newcomers.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(resolve(root, "README.md"), "utf8");

function sourceFiles(dir: string, ext: string): string[] {
  return readdirSync(resolve(root, dir))
    .filter((f) => f.endsWith(ext))
    .sort();
}

describe("README documents every source file", () => {
  it.each(sourceFiles("assets/js", ".ts"))(
    "lists assets/js/%s",
    (file) => {
      expect(readme, `add "${file}" to the README "Files" section`).toContain(file);
    },
  );

  it.each(sourceFiles("assets/css", ".css"))(
    "lists assets/css/%s",
    (file) => {
      expect(readme, `add "${file}" to the README "Files" section`).toContain(file);
    },
  );
});
