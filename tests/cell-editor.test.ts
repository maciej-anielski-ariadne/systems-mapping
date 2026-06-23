// =============================================================================
// BUILDER CELL EDITOR — close / exit / unhighlight contract
// -----------------------------------------------------------------------------
// Regression cover for the bug where the "expanded popup" textarea (spawned
// when a builder text cell overflows) would not close on click-away and left
// the underlying <input> stuck with its focus ring ("no way to exit and
// unhighlight"). The real-browser trigger is editor.focus() being ignored
// mid-`input`-dispatch; jsdom can't reproduce that focus timing, but the
// observable contract — close removes the editor, and a dismiss that leaves
// the trigger focused blurs it — is deterministic and is what we assert here.
// =============================================================================
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  openCellEditor,
  hideCellEditor,
  cellEditorState,
} from "../assets/js/16c-builder-editor";

function mountCell(value: string): HTMLInputElement {
  const table = document.createElement("table");
  table.className = "builder-table";
  table.innerHTML =
    "<tbody><tr><td><input type='text' data-section='nodes' " +
    "data-field='label' data-index='0'></td></tr></tbody>";
  document.body.appendChild(table);
  const input = table.querySelector("input") as HTMLInputElement;
  input.value = value;
  return input;
}

describe("builder cell editor — close / unhighlight", () => {
  let input: HTMLInputElement;

  beforeEach(() => {
    input = mountCell("a value long enough to overflow its narrow cell");
  });

  afterEach(() => {
    hideCellEditor({ skipAnimation: true });
    document.querySelectorAll("table.builder-table").forEach(t => t.remove());
  });

  it("openCellEditor mounts the overlay and tracks state", () => {
    openCellEditor(input);
    expect(cellEditorState).not.toBeNull();
    expect(document.querySelector(".builder-cell-editor")).toBeTruthy();
  });

  it("hideCellEditor removes the overlay and clears state", () => {
    openCellEditor(input);
    hideCellEditor({ skipAnimation: true });
    expect(cellEditorState).toBeNull();
    expect(document.querySelector(".builder-cell-editor")).toBeNull();
  });

  it("a user dismiss blurs a trigger that still holds focus (unhighlight)", () => {
    openCellEditor(input);
    // Simulate the focus-failure mode: focus never left the underlying input.
    input.focus();
    expect(document.activeElement).toBe(input);
    hideCellEditor({ userDismissed: true, refocusTrigger: false });
    // The cell must not be left highlighted: the trigger is blurred.
    expect(document.activeElement).not.toBe(input);
  });

  it("mousedown outside the editor closes it", async () => {
    openCellEditor(input);
    // The outside-listener attaches on the microtask (see openCellEditor),
    // so let it register before dispatching the click.
    await Promise.resolve();
    document.body.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true }),
    );
    expect(cellEditorState).toBeNull();
    expect(document.querySelector(".builder-cell-editor")).toBeNull();
  });
});
