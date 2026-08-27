// =============================================================================
// FINDING HELPERS — reading state.loadErrors in tests
// -----------------------------------------------------------------------------
// Findings are structured now (see Finding in assets/js/types.ts), so a test can
// assert on the CHECK that fired rather than on the sentence it happened to
// produce. `kinds()` is the stable contract — a reworded message should not fail
// a test, a check that stops firing should. `text()` is still here for the
// handful of assertions where the wording is the point (a parser's own error
// text, a box id inside a sentence).
// =============================================================================
import { state } from "../../assets/js/03-state";
import type { Finding } from "../../assets/js/types";

/** Every finding, or only those about one box. */
export function findings(boxId?: string): Finding[] {
  return boxId === undefined
    ? state.loadErrors.slice()
    : state.loadErrors.filter((f) => f.boxId === boxId);
}

/** The kinds that fired, in order. Pass a box id to narrow to one box. */
export function kinds(boxId?: string): string[] {
  return findings(boxId).map((f) => f.kind);
}

/** Findings rendered back to one string, box id included, for message matching. */
export function text(): string {
  return state.loadErrors
    .map((f) => (f.boxId ? "`" + f.boxId + "` " : "") + f.message + (f.fix ? " " + f.fix : ""))
    .join(" | ");
}

/** The findings that are consequences of another box's mistake. */
export function consequences(): Finding[] {
  return state.loadErrors.filter((f) => f.causedBy);
}

/** The findings that are somebody's actual job. */
export function causes(): Finding[] {
  return state.loadErrors.filter((f) => !f.causedBy);
}
