import { beforeEach, describe, expect, it } from "vitest";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import { state } from "../assets/js/03-state";
import { NODES, layout } from "../assets/js/03-state";
import {
  clearSearch,
  findMatches,
  handleSearchInput,
  handleSearchKeydown,
  highlightMatched,
  scoreMatch,
} from "../assets/js/17a-search";
import { applyNodeFieldEdit } from "../assets/js/15-detail-panel";
import { SAMPLE_CSV } from "../assets/js/01-sample-data";

describe("search interaction", () => {
  beforeEach(() => loadDataFromCsv(SAMPLE_CSV));

  it("ranks exact, prefix and fuzzy matches and escapes highlighted output", () => {
    expect(scoreMatch("team", "team").score).toBeGreaterThan(scoreMatch("team", "team health").score);
    expect(scoreMatch("tmhlth", "Team health").score).toBeGreaterThan(0);
    expect(highlightMatched("<Team>", [1])).toContain("&lt;");
    expect(findMatches("resolution")[0].node.label).toMatch(/resolution/i);
  });

  it("renders results, selects with arrows, and clears with Escape", () => {
    const input = document.getElementById("search-input") as HTMLInputElement;
    input.value = "team";
    handleSearchInput();

    expect(state.searchMatches.length).toBeGreaterThan(1);
    expect(document.querySelectorAll("#search-results .search-result").length).toBeGreaterThan(1);
    const firstSelectedNodeId = state.selectedNodeId;
    handleSearchKeydown(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    expect(state.selectedNodeId).not.toBe(firstSelectedNodeId);

    handleSearchKeydown(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(state.searchQuery).toBe("");
    expect(state.searchMatches).toEqual([]);
    expect(input.value).toBe("");
  });

  it("retains the current selection while a partial query has no match", () => {
    const input = document.getElementById("search-input") as HTMLInputElement;
    input.value = "retention";
    handleSearchInput();
    const selectedNodeId = state.selectedNodeId;
    input.value = "zzzz-no-match";
    handleSearchInput();
    expect(state.selectedNodeId).toBe(selectedNodeId);
    clearSearch();
  });

  it.each(["description", "unit"])(
    "invalidates searchable text after a presentation-only %s edit without rebuilding layout",
    field => {
      const node = NODES[0];
      const uniqueSearchText = field === "description" ? "fresh description token" : "freshunit";
      expect(findMatches(uniqueSearchText)).toEqual([]); // Prime the old corpus.
      const layoutBeforeEdit = layout;
      const input = document.createElement("input");
      input.type = "text";
      input.value = uniqueSearchText;

      applyNodeFieldEdit(node, field, input);

      expect(findMatches(uniqueSearchText)[0]?.node.id).toBe(node.id);
      expect(layout).toBe(layoutBeforeEdit);
    },
  );
});
