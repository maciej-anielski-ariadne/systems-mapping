// =============================================================================
// Post-build gate: does the artifact carry the name it was meant to?
// -----------------------------------------------------------------------------
// The point of `npm run build:white-label` is that the built file contains no
// brand string — not hidden behind a CSS rule, not sitting in a data URI, ABSENT.
// That is a property of a 900KB minified blob, which is exactly the kind of
// thing nobody checks by eye and nobody notices has broken.
//
// So it is checked here, as part of the build rather than as a test somebody
// might not run. A default build asserts the opposite: the name IS present,
// because a rebrand that silently drops the name from the normal build is the
// same failure in the other direction.
//
//   node scripts/check-brand.mjs            → expects the .env brand
//   node scripts/check-brand.mjs --absent   → expects no brand at all
// =============================================================================
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDirectory = process.argv.find(argument => argument.startsWith("--dir="))
  ?.slice("--dir=".length) || "dist";
const artifactPath = resolve(root, artifactDirectory + "/systems-map.html");

/** The brand words to look for, read from .env rather than hardcoded here. */
async function brandWordsFromEnv() {
  const text = await readFile(resolve(root, ".env"), "utf8");
  const words = new Set();
  for (const line of text.split("\n")) {
    const match = /^\s*VITE_BRAND_(NAME|SHORT)\s*=\s*(.*)$/.exec(line);
    const value = match?.[2]?.trim();
    if (value) words.add(value);
  }
  if (!words.size) {
    throw new Error(".env defines no VITE_BRAND_NAME — nothing to check for.");
  }
  return [...words];
}

const expectAbsent = process.argv.includes("--absent");
const artifact = await readFile(artifactPath, "utf8");
const words = await brandWordsFromEnv();

const found = words.filter(word => artifact.includes(word));

if (expectAbsent && found.length) {
  // Show a little of each hit: on a minified file the surrounding characters
  // are the only way to tell a stray literal from an inlined example map.
  console.error(artifactPath + " still carries the brand:\n");
  for (const word of found) {
    let at = artifact.indexOf(word);
    let shown = 0;
    while (at !== -1 && shown < 3) {
      console.error("  " + JSON.stringify(artifact.slice(Math.max(0, at - 40), at + word.length + 40)));
      at = artifact.indexOf(word, at + 1);
      shown++;
    }
  }
  console.error(
    "\nAn unbranded build must not contain the name at all. Route the string " +
    "through assets/js/00-brand.ts, or wrap the markup in <!--brand--> … " +
    "<!--/brand--> so the build drops it.",
  );
  process.exit(1);
}

if (!expectAbsent && !found.length) {
  console.error(
    artifactDirectory + "/systems-map.html carries none of " + JSON.stringify(words) + ".\n" +
    "A normal build is supposed to be branded — check .env reached the build.",
  );
  process.exit(1);
}

console.log(
  expectAbsent
    ? artifactDirectory + "/systems-map.html carries no brand string."
    : artifactDirectory + "/systems-map.html carries the brand (" + found.join(", ") + ").",
);
