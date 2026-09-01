import { beforeEach, describe, expect, it } from "vitest";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import { NODES, nodeById, state } from "../assets/js/03-state";
import { LINEAR_CSV } from "./fixtures/graphs";
import {
  handleCanvasEnterCreate,
  handleCanvasTab,
  moveCanvasCursor,
} from "../assets/js/16i-canvas-keyboard-nav";
import {
  commitInlineRename,
  inlineRenameAppend,
  revertInlineRename,
  startInlineRename,
} from "../assets/js/16h-canvas-inline-rename";

describe("keyboard authoring", () => {
  beforeEach(() => {
    loadDataFromCsv(LINEAR_CSV);
    state.uiMode = "edit";
  });

  it("moves across the grid and creates a box below the cursor", () => {
    expect(moveCanvasCursor(0, 1)).toBe(true);
    expect(state.selectedNodeId).toBe("a");
    expect(handleCanvasTab("next")).toBe(true);
    expect(state.selectedNodeId).toBe("b");
    const nodeCountBeforeCreate = NODES.length;
    expect(handleCanvasEnterCreate()).toBe(true);
    expect(NODES).toHaveLength(nodeCountBeforeCreate + 1);
    expect(state.canvasEdit.inlineRename).not.toBeNull();
  });

  it("commits and reverts an inline rename without losing the original", () => {
    startInlineRename("a");
    inlineRenameAppend("N");
    inlineRenameAppend("e");
    inlineRenameAppend("w");
    expect(commitInlineRename()).toBe(true);
    expect(nodeById.a.label).toBe("New");

    startInlineRename("a");
    inlineRenameAppend("X");
    expect(revertInlineRename()).toBe(true);
    expect(nodeById.a.label).toBe("New");
  });
});
