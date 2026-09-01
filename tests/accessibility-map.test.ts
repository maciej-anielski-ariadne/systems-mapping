import { describe, expect, it } from "vitest";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import { state } from "../assets/js/03-state";
import { LINEAR_CSV } from "./fixtures/graphs";

describe("semantic SVG map controls", () => {
  it("names boxes and exposes their selected state", () => {
    loadDataFromCsv(LINEAR_CSV);
    const box = document.querySelector<SVGGElement>('.node-group[data-node-id="a"]')!;

    expect(box.getAttribute("role")).toBe("button");
    expect(box.getAttribute("tabindex")).toBe("0");
    expect(box.getAttribute("aria-label")).toContain("Input A, row Operations, column Inputs");
    expect(box.getAttribute("aria-pressed")).toBe("false");

    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(state.selectedNodeId).toBe("a");
    expect(box.getAttribute("aria-pressed")).toBe("true");
  });

  it("exposes row and column collapse controls to keyboard users", () => {
    loadDataFromCsv(LINEAR_CSV);
    const row = document.querySelector<SVGGElement>('.row-label-group[data-stream-id="ops"]')!;
    const column = document.querySelector<SVGGElement>('.col-header-group[data-stage-id="s1"]')!;

    expect(row.getAttribute("aria-label")).toBe("Collapse row Operations");
    expect(column.getAttribute("aria-label")).toBe("Collapse column Inputs");
    row.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(state.hiddenStreams.has("ops")).toBe(true);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Expand row Operations");
  });
});
