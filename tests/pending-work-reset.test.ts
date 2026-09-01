import { describe, expect, it } from "vitest";
import {
  loadBuilderFromStorage,
  loadCsvFromStorage,
  loadUiStateFromStorage,
  scheduleBuilderSave,
  scheduleCsvSave,
  scheduleUiStateSave,
} from "../assets/js/04a-storage";
import { state } from "../assets/js/03-state";
import { scheduleReviewSave } from "../assets/js/24-review-record";
import { handleSearchInputDebounced } from "../assets/js/17a-search";

// These two cases deliberately leave real timers pending between them. The
// global beforeEach in setup.ts must cancel them before clearing storage/state;
// otherwise the second case observes writes and a search from the first.
describe.sequential("global pending-work isolation", () => {
  it("leaves delayed work that belongs only to this test", () => {
    scheduleCsvSave("stale map from the preceding test");
    scheduleUiStateSave();

    state.builder.open = true;
    scheduleBuilderSave();

    state.dataLoaded = true;
    scheduleReviewSave();

    const searchInput = document.getElementById("search-input") as HTMLInputElement;
    searchInput.value = "stale query from the preceding test";
    handleSearchInputDebounced();
  });

  it("does not run delayed writes or search after the next test reset", async () => {
    await new Promise(resolve => setTimeout(resolve, 700));

    expect(loadCsvFromStorage()).toBeNull();
    expect(loadUiStateFromStorage()).toBeNull();
    expect(loadBuilderFromStorage()).toBeNull();
    expect(state.searchQuery).toBe("");
    expect(state.searchMatches).toEqual([]);
  });
});
