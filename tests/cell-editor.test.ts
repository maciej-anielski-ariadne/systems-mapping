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
  CELL_EDITOR_TYPES_SELECTOR,
} from "../assets/js/16c-builder-editor";
import { state } from "../assets/js/03-state";
import { BUILDER_SPLIT } from "../assets/js/16a-builder-state";
import { renderBuilderParamsStep } from "../assets/js/16b-builder-render";

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

// The Constants step (step 6) was added after this editor existed, so this is
// the "it plugs into the same machinery" check: its cells must be the kind the
// overflow editor picks up, and the editor must be able to name the column it
// opened over (that name is what a screen reader announces).
describe("builder cell editor — the Constants step uses the same cells", () => {
  let host: HTMLDivElement;

  beforeEach(() => {
    state.builder.params = [
      { id: "share_air", value: 0.35, description: "Share of the flow routed by air, from the 2024 traffic survey" },
    ];
    host = document.createElement("div");
    // The step's HTML is one string split into a sticky top and a scrolling
    // table by BUILDER_SPLIT; for this test the two halves can just sit
    // together in one container.
    host.innerHTML = renderBuilderParamsStep().split(BUILDER_SPLIT).join("");
    document.body.appendChild(host);
  });

  afterEach(() => {
    hideCellEditor({ skipAnimation: true });
    host.remove();
    state.builder.params = [];
  });

  it("renders id / value / description cells the editor recognises", () => {
    const id    = host.querySelector('input[data-section="params"][data-field="id"]') as HTMLInputElement;
    const value = host.querySelector('input[data-section="params"][data-field="value"]') as HTMLInputElement;
    const desc  = host.querySelector('input[data-section="params"][data-field="description"]') as HTMLInputElement;

    expect(id.value).toBe("share_air");
    expect(value.type).toBe("number");
    expect(id.matches(CELL_EDITOR_TYPES_SELECTOR)).toBe(true);
    expect(value.matches(CELL_EDITOR_TYPES_SELECTOR)).toBe(true);
    expect(desc.matches(CELL_EDITOR_TYPES_SELECTOR)).toBe(true);
  });

  it("names the column and row when it opens over a constants cell", () => {
    const desc = host.querySelector('input[data-section="params"][data-field="description"]') as HTMLInputElement;
    openCellEditor(desc);
    const editor = document.querySelector(".builder-cell-editor")!;
    expect(editor.getAttribute("aria-label")).toBe("Edit Description, row 1");
    expect((editor as HTMLTextAreaElement).value).toBe(desc.value);
  });
});
