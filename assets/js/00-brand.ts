// =============================================================================
// BRAND — the app's name, in one place
// -----------------------------------------------------------------------------
// The same argument as 01-variables.css makes for colour: one file, so somebody
// renaming the app changes a value rather than hunting sixteen string literals
// across eight modules and a static HTML page.
//
// WHY THE VALUES ARE NOT DEFAULTED HERE. They come from .env through Vite, and
// this file deliberately has no "Ariadne Maps" fallback in it. A fallback would
// be compiled INTO the bundle, so the unbranded build would still carry the
// name — hidden rather than removed, findable by anyone who opened the file in
// a text editor. `npm run build:white-label` loads .env.whitelabel, every value
// blank, and the artifact then contains no name at all.
//
// Anything the app WRITES — an exported spreadsheet's header comment, the title
// of a published view-only page — stamps BRAND_NAME too. That is provenance
// rather than decoration: whoever opens the file a year from now has no other
// way of telling what produced it. Fill the values in for a client build rather
// than emptying them, unless the point is that nothing identifies the tool.
// =============================================================================

/** Trim, and treat an unset or whitespace-only value as absent. */
function configured(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The full name. Empty on an unbranded build. */
export const BRAND_NAME = configured(import.meta.env.VITE_BRAND_NAME);

/**
 * The name as it reads mid-sentence — "Ariadne autosaves the current map".
 * Empty on an unbranded build; use appName() wherever a sentence needs a
 * subject, because "autosaves the current map" is not a sentence.
 */
export const BRAND_SHORT = configured(import.meta.env.VITE_BRAND_SHORT);

/** Shown under the name on the empty state. */
export const BRAND_TAGLINE = configured(import.meta.env.VITE_BRAND_TAGLINE);

/**
 * Whether the mark, the wordmark and the favicon are part of this build.
 * "off" removes them; index.html's marked blocks are dropped at build time and
 * do not ship. Defaults to on, so a missing value never silently un-brands a
 * build somebody meant to be branded.
 */
export const BRAND_MARK_VISIBLE = configured(import.meta.env.VITE_BRAND_MARK) !== "off";

/**
 * The subject of a sentence about the app.
 *
 * The lessons say things like "<name> autosaves the current map, view choices
 * and unfinished Bulk edit draft in this browser." Substituting an empty string
 * there produces a sentence with no subject, so an unnamed build says "This
 * app" — which reads correctly in every one of those sentences and is what a
 * white-labelled tool should call itself anyway.
 */
export function appName(): string {
  return BRAND_SHORT || BRAND_NAME || "This app";
}

/**
 * A heading or title naming the app, or `fallback` when there is no name.
 *
 * Used where the name is the whole of the text — the browser tab, the Learn
 * library's own heading. "Learn ." is not a heading, so these get a generic
 * form rather than a gap.
 */
export function brandedTitle(pattern: string, fallback: string): string {
  return BRAND_NAME ? pattern.replace("{name}", BRAND_NAME) : fallback;
}
