import { beforeEach, describe, expect, it } from "vitest";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import { state } from "../assets/js/03-state";
import { NODES, layout } from "../assets/js/03-state";
import {
  clearSearch,
  commitSearchFocus,
  findMatches,
  handleSearchInput,
  handleSearchKeydown,
  highlightMatched,
  scoreMatch,
} from "../assets/js/17a-search";
import { applyNodeFieldEdit } from "../assets/js/15-detail-panel";
import { SAMPLE_CSV } from "../assets/js/01-sample-data";
import { nodeCategoryIds, splitCategoriesByClass } from "../assets/js/04-utils";

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

  it("does not change filters while typing focuses a hidden result", () => {
    const targetNode = NODES.find(node => nodeCategoryIds(node).length > 0)!;
    state.hiddenStreams = new Set([targetNode.stream]);
    state.hiddenStages = new Set([targetNode.stage]);
    state.hiddenCategories = new Set(nodeCategoryIds(targetNode));
    state.searchMatches = [{ node: targetNode, score: 1000 }];

    commitSearchFocus(0, { typing: true });

    expect(state.hiddenStreams).toEqual(new Set([targetNode.stream]));
    expect(state.hiddenStages).toEqual(new Set([targetNode.stage]));
    expect(state.hiddenCategories).toEqual(new Set(nodeCategoryIds(targetNode)));
  });

  it("does not reveal a hidden result when its dropdown row appears beneath the pointer", () => {
    const targetNode = NODES.find(node => nodeCategoryIds(node).length > 0)!;
    state.hiddenStreams = new Set([targetNode.stream]);
    state.hiddenStages = new Set([targetNode.stage]);
    state.hiddenCategories = new Set(nodeCategoryIds(targetNode));
    const input = document.getElementById("search-input") as HTMLInputElement;
    input.value = targetNode.label;

    handleSearchInput();
    document.querySelector<HTMLElement>("#search-results .search-result")!
      .dispatchEvent(new MouseEvent("mouseenter"));

    expect(state.hiddenStreams.has(targetNode.stream)).toBe(true);
    expect(state.hiddenStages.has(targetNode.stage)).toBe(true);
    expect(state.hiddenCategories).toEqual(new Set(nodeCategoryIds(targetNode)));
  });

  it("reveals a discretely selected hidden result and Undo restores the exact filters", () => {
    const targetNode = NODES.find(node => nodeCategoryIds(node).length > 0)!;
    const targetCategories = splitCategoriesByClass(nodeCategoryIds(targetNode));
    const hiddenStreamsBeforeSelection = new Set([targetNode.stream]);
    const hiddenStagesBeforeSelection = new Set([targetNode.stage]);
    const hiddenCategoriesBeforeSelection = new Set(nodeCategoryIds(targetNode));
    state.hiddenStreams = new Set(hiddenStreamsBeforeSelection);
    state.hiddenStages = new Set(hiddenStagesBeforeSelection);
    state.hiddenCategories = new Set(hiddenCategoriesBeforeSelection);
    state.searchMatches = [{ node: targetNode, score: 1000 }];

    // Typeahead may focus the result, but Enter is the discrete selection that
    // should reveal it. This also covers the case where it is already selected.
    commitSearchFocus(0, { typing: true });
    handleSearchKeydown(new KeyboardEvent("keydown", { key: "Enter" }));

    expect(state.hiddenStreams.has(targetNode.stream)).toBe(false);
    expect(state.hiddenStages.has(targetNode.stage)).toBe(false);
    for (const categoryClass of [targetCategories.primary, targetCategories.secondary]) {
      if (categoryClass.length > 0) {
        expect(categoryClass.some(categoryId => !state.hiddenCategories.has(categoryId))).toBe(true);
      }
    }
    expect(state.canvasEdit.toast?.message).toContain("show");

    const undoButton = document.querySelector("#canvas-undo-toast .undo-link") as HTMLButtonElement;
    undoButton.click();

    expect(state.hiddenStreams).toEqual(hiddenStreamsBeforeSelection);
    expect(state.hiddenStages).toEqual(hiddenStagesBeforeSelection);
    expect(state.hiddenCategories).toEqual(hiddenCategoriesBeforeSelection);
    expect(state.selectedNodeId).toBeNull();
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
