import { describe, it, expect, beforeEach } from "vitest";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import { render } from "../assets/js/11-rendering";
import {
  applySimMultiplier,
  flushSimTick,
  renderSimulationPanel,
} from "../assets/js/14-simulation-panel";
import { deselectAll, selectNode } from "../assets/js/09-graph-selection";
import { formatNodeValue, recomputeValues } from "../assets/js/07-simulation-engine";
import { renderDetailPanel } from "../assets/js/15-detail-panel";
import { state, NODES } from "../assets/js/03-state";
import {
  LINEAR_CSV,
  COMBINE_CSV,
  FORMULA_CSV,
  BOUNDS_CSV,
  DELAY_LOOP_CSV,
  FORMULA_INVALID_CSV,
} from "./fixtures/graphs";

// A → B → C, A controllable. Moving A's slider recomputes B and C.
describe("simulation slider updates node values in place", () => {
  function bValueEl(): Element {
    return document.querySelector(
      '.node-group[data-node-id="b"] .node-value',
    )!;
  }
  function bGroup(): Element {
    return document.querySelector('.node-group[data-node-id="b"]')!;
  }

  it("patches the existing DOM (no rebuild) when no delta label appears/disappears", () => {
    loadDataFromCsv(LINEAR_CSV);

    // First nudge makes B's delta label appear (a structural change), so this
    // takes the full-render fallback. Flush it synchronously to establish the
    // delta element before we test the in-place path.
    applySimMultiplier("a", 1.5, null);
    render();
    expect(bGroup().querySelector(".node-delta")).toBeTruthy();

    // Capture stable references — the in-place path must NOT replace these.
    const groupBefore = bGroup();
    const valueElBefore = bValueEl();

    // Second nudge: B's delta stays present, nothing is selected → in-place
    // update runs synchronously, no full render.
    applySimMultiplier("a", 1.6, null);

    expect(bGroup()).toBe(groupBefore); // same element → not rebuilt
    expect(bValueEl()).toBe(valueElBefore);
    expect(bValueEl().textContent).toBe(formatNodeValue("b"));
    // Sanity: value reflects the new multiplier (B = 50 * 1.6^0.5).
    expect(state.computedValues.b).toBeCloseTo(50 * Math.sqrt(1.6), 6);
  });

  it("keeps the map value in sync with the computed value", () => {
    loadDataFromCsv(LINEAR_CSV);
    applySimMultiplier("a", 2.0, null);
    render();
    expect(bValueEl().textContent).toBe(formatNodeValue("b"));
    expect(state.computedValues.b).toBeCloseTo(50 * Math.sqrt(2.0), 6);
  });
});

// A selection used to force the whole SVG to be rebuilt on every slider event,
// because the selected / ancestor / descendant borders take precedence over the
// outcome colour. Those sets don't change while a slider moves, so the in-place
// patch applies the same precedence itself.
describe("in-place patching with a selection active", () => {
  function group(id: string): Element {
    return document.querySelector('.node-group[data-node-id="' + id + '"]')!;
  }

  it("keeps the selection border across a scrub, and still moves the numbers", () => {
    loadDataFromCsv(LINEAR_CSV);
    applySimMultiplier("a", 1.5, null); // make B's delta label exist
    selectNode("b");                    // b selected → c becomes a descendant

    const bGroupBefore = group("b");
    const cGroupBefore = group("c");
    expect(bGroupBefore.querySelector(".node-rect")!.getAttribute("stroke")).toBe("#ffffff");

    applySimMultiplier("a", 1.8, null);

    // Patched, not rebuilt.
    expect(group("b")).toBe(bGroupBefore);
    expect(group("c")).toBe(cGroupBefore);
    // Selection border survives, and the descendant border with it.
    const bRect = bGroupBefore.querySelector(".node-rect")!;
    expect(bRect.getAttribute("stroke")).toBe("#ffffff");
    expect(bRect.getAttribute("stroke-width")).toBe("2.5");
    expect(cGroupBefore.querySelector(".node-rect")!.getAttribute("stroke")).toBe(
      "var(--edge-descendant)",
    );
    // …and the numbers are the new ones.
    expect(bGroupBefore.querySelector(".node-value")!.textContent).toBe(formatNodeValue("b"));
    expect(state.computedValues.b).toBeCloseTo(50 * Math.sqrt(1.8), 6);

    deselectAll();
  });
});

// Slider `input` events arrive far faster than the screen refreshes, so the
// panel writes the override immediately and coalesces the solve + repaint into
// one per animation frame. flushSimTick() drains whatever is owed.
describe("slider events are coalesced into one tick per frame", () => {
  function slider(nodeId: string): HTMLInputElement {
    return document.querySelector(
      '.sim-slider[data-node-id="' + nodeId + '"]',
    ) as HTMLInputElement;
  }

  function drag(nodeId: string, value: number): void {
    const el = slider(nodeId);
    el.value = String(value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  beforeEach(() => {
    loadDataFromCsv(LINEAR_CSV);
    state.simulationMode = true;
    renderSimulationPanel();
    render();
  });

  it("writes the override at once but solves once, on flush", () => {
    const before = state.computedValues.b;

    drag("a", 1.4);
    drag("a", 1.7);
    drag("a", 2.0);

    // State is never behind the widget…
    expect(state.userOverrides.a).toBe(2.0);
    // …but the solve hasn't run yet.
    expect(state.computedValues.b).toBe(before);

    flushSimTick();
    expect(state.computedValues.b).toBeCloseTo(50 * Math.sqrt(2.0), 6);
    // Nothing owed any more.
    flushSimTick();
    expect(state.computedValues.b).toBeCloseTo(50 * Math.sqrt(2.0), 6);
  });

  it("clamps to the slider's range, as the direct call does", () => {
    drag("a", 9999);
    flushSimTick();
    expect(state.userOverrides.a).toBe(400); // the fixture's slider_max

    drag("a", -5);
    flushSimTick();
    expect(state.userOverrides.a).toBe(0);
  });
});

// A scrub rewrites the detail panel's numbers in place. The panel is rebuilt
// only when its SHAPE would change (a notice appearing, a different input
// gating a min rule) or when the drag ends.
describe("detail panel patching during a scrub", () => {
  it("updates the numbers without rebuilding the panel", () => {
    loadDataFromCsv(LINEAR_CSV);
    state.simulationMode = true;
    state.canvasEdit.editMode = false;
    renderSimulationPanel();
    render();
    selectNode("c");

    const breakdownBefore = document.querySelector("#detail-content .calc-breakdown")!;
    const inputRowBefore = breakdownBefore.querySelector(".calc-input")!;
    const deltaCellBefore = document.querySelectorAll(
      "#detail-content .detail-quant-row",
    )[2].querySelector(".detail-quant-value")!;

    const el = document.querySelector('.sim-slider[data-node-id="a"]') as HTMLInputElement;
    el.value = "4";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    flushSimTick();

    // Same elements — the panel was patched, not re-rendered.
    expect(document.querySelector("#detail-content .calc-breakdown")).toBe(breakdownBefore);
    expect(breakdownBefore.querySelector(".calc-input")).toBe(inputRowBefore);
    // Carrying the new numbers: C = 20 × √4 = 40, driven by B = 100.
    expect(deltaCellBefore.textContent).toBe("+100.0%");
    expect(inputRowBefore.querySelector(".calc-input-value")!.textContent).toBe("100 units");
    expect(inputRowBefore.querySelector(".calc-input-detail")!.textContent).toBe("×2.00");

    deselectAll();
  });
});

// =============================================================================
// DETAIL PANEL — "How this number is calculated"
// -----------------------------------------------------------------------------
// The audit trail from docs/CALCULATION-ENGINE-DESIGN.md §4: the panel renders
// state.explanations[selectedNode] as a plain-language breakdown. These tests
// pin the shape of that breakdown for every rule the engine can report, and
// check that the notices only ever appear when the engine actually flagged
// something.
// =============================================================================

// Select a node and render the panel in the requested mode. Values are
// recomputed first so the explanations match the overrides being tested.
function showPanel(
  nodeId: string,
  options: { sim?: boolean; edit?: boolean; overrides?: Record<string, number> } = {},
): HTMLElement {
  state.userOverrides = options.overrides || {};
  recomputeValues();
  state.simulationMode = options.sim !== false;
  // The per-box edit form belongs to editing mode, so asking for it means
  // being in it.
  state.uiMode = options.edit ? "edit" : "read";
  state.canvasEdit.editMode = !!options.edit;
  state.selectedNodeId = nodeId;
  renderDetailPanel();
  return document.getElementById("detail-content")!;
}

function breakdown(): HTMLElement | null {
  return document.querySelector("#detail-content .calc-breakdown");
}

function ruleText(): string {
  return document.querySelector("#detail-content .calc-rule")!.textContent!;
}

function inputRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll("#detail-content .calc-input"));
}

// "Input A | 150 units | ×1.50" — the three cells of one input row, joined so a
// single assertion can read like the rendered line does.
function rowCells(row: HTMLElement): string[] {
  return [".calc-input-label", ".calc-input-value", ".calc-input-detail"]
    .map((selector) => row.querySelector(selector))
    .filter(Boolean)
    .map((cell) => cell!.textContent!.trim());
}

function notices(): string[] {
  return Array.from(document.querySelectorAll("#detail-content .calc-notice")).map(
    (el) => el.textContent!.trim(),
  );
}

describe("calculation breakdown — link-based rules", () => {
  beforeEach(() => {
    expect(loadDataFromCsv(COMBINE_CSV)).toBe(true);
  });

  it("names the standard rule and shows each link's factor", () => {
    showPanel("mult", { overrides: { a: 1.5, b: 1.2 } });
    expect(breakdown()!.getAttribute("data-calc-rule")).toBe("multiplicative");
    expect(ruleText()).toContain("compound");
    expect(inputRows().map(rowCells)).toEqual([
      ["Input A", "150 units", "×1.50"],
      ["Input B", "120 units", "×1.20"],
    ]);
  });

  it("shows additive terms as signed shares, not factors", () => {
    showPanel("add", { overrides: { a: 1.5, b: 0.8 } });
    expect(breakdown()!.getAttribute("data-calc-rule")).toBe("additive");
    expect(ruleText()).toContain("add up");
    expect(inputRows().map(rowCells)).toEqual([
      ["Input A", "150 units", "+50.0%"],
      ["Input B", "80.0 units", "-20.0%"],
    ]);
  });

  it("marks the winning input for the weakest-link rule", () => {
    showPanel("gate", { overrides: { a: 1.5, b: 1.2 } });
    expect(breakdown()!.getAttribute("data-calc-rule")).toBe("min");
    expect(ruleText()).toContain("Weakest input");

    const rows = inputRows();
    expect(rows.map((row) => row.classList.contains("calc-input--winner"))).toEqual([
      false,
      true,
    ]);
    // The winner is called out in words too, not just with a colour.
    expect(rows[1].textContent).toContain("gates this");
    expect(rows[0].textContent).not.toContain("gates this");
  });

  it("says so plainly when nothing quantified feeds the box", () => {
    showPanel("lone", { overrides: { a: 1.5 } });
    expect(breakdown()!.getAttribute("data-calc-rule")).toBe("baseline");
    expect(ruleText()).toContain("starting value");
    expect(inputRows()).toHaveLength(0);
  });

  it("reports a slider-held box as pinned, with no working to show", () => {
    showPanel("a", { overrides: { a: 1.5 } });
    expect(breakdown()!.getAttribute("data-calc-rule")).toBe("pinned");
    expect(ruleText()).toContain("slider");
    expect(inputRows()).toHaveLength(0);
  });

  it("is absent outside simulation mode, and while editing", () => {
    showPanel("mult", { sim: false, overrides: { a: 1.5 } });
    expect(breakdown()).toBeNull();

    showPanel("mult", { edit: true, overrides: { a: 1.5 } });
    expect(breakdown()).toBeNull();
  });
});

describe("calculation breakdown — formulas", () => {
  beforeEach(() => {
    expect(loadDataFromCsv(FORMULA_CSV)).toBe(true);
  });

  it("prints the expression and every value it read", () => {
    showPanel("seizures");
    expect(breakdown()!.getAttribute("data-calc-rule")).toBe("formula");
    expect(
      document.querySelector("#detail-content .calc-formula")!.textContent,
    ).toBe("traffic * exam_coverage * detection_rate");
    // A formula reads plain values, so no per-input factor column.
    expect(inputRows().map(rowCells)).toEqual([
      ["Traffic", "1000 items"],
      ["Exam coverage", "0.200 share"],
      ["◆ detection_rate", "0.600"],
    ]);
  });

  it("styles a hidden constant as a chip carrying its description", () => {
    showPanel("seizures");
    const chip = document.querySelector("#detail-content .calc-input-param")!;
    expect(chip.textContent).toContain("detection_rate");
    expect(chip.getAttribute("data-tooltip")).toBe(
      "Probability an examined item is detected",
    );
    // The boxes beside it are named by their labels, not their ids.
    expect(document.querySelector("#detail-content .calc-input-name")!.textContent).toBe(
      "Traffic",
    );
  });

  it("flags a division by zero, and only when one happened", () => {
    showPanel("exam_coverage");
    expect(notices()).toEqual([]);

    showPanel("exam_coverage", { overrides: { traffic: 0 } });
    expect(notices().join(" ")).toContain("divided by zero");
  });
});

describe("calculation breakdown — delayed reads, bounds and missing names", () => {
  it("badges a value read from the previous solver step", () => {
    expect(loadDataFromCsv(DELAY_LOOP_CSV)).toBe(true);
    showPanel("p", { overrides: { a: 1.2 } });

    const rows = inputRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector(".calc-badge")!.textContent).toBe("previous step");
  });

  it("explains a bound that bit, naming the number it would have been", () => {
    expect(loadDataFromCsv(BOUNDS_CSV)).toBe(true);

    showPanel("capped", { overrides: { a: 2 } });
    expect(notices()).toEqual([
      "Held at the highest allowed value, 120 units — it would have been 200 units.",
    ]);

    showPanel("floored", { overrides: { a: 0.5 } });
    expect(notices()).toEqual([
      "Held at the lowest allowed value, 90.0 units — it would have been 50.0 units.",
    ]);
  });

  it("stays quiet when no bound moved the number", () => {
    expect(loadDataFromCsv(BOUNDS_CSV)).toBe(true);
    showPanel("both", { overrides: { a: 1.1 } });
    expect(notices()).toEqual([]);
  });

  it("names an input it could not resolve", () => {
    expect(loadDataFromCsv(FORMULA_INVALID_CSV)).toBe(true);
    showPanel("unknown_ref");
    expect(notices().join(" ")).toContain("No value found for: mystery");
  });
});

// =============================================================================
// DETAIL PANEL — the per-box calculation-rule edit fields
// -----------------------------------------------------------------------------
// combine / formula / min / max ride the SAME mutation path as baseline and
// unit (applyNodeFieldEdit → applyCanvasMutation), so a change lands on the
// node, is re-indexed, and is serialised back out to CSV.
// =============================================================================
describe("detail panel calculation-rule edit fields", () => {
  beforeEach(() => {
    expect(loadDataFromCsv(LINEAR_CSV)).toBe(true);
    showPanel("b", { edit: true });
  });

  function node(): Record<string, unknown> {
    return NODES.find((n) => n.id === "b")! as unknown as Record<string, unknown>;
  }

  function edit(field: string, value: string): void {
    const input = document.querySelector(
      "#detail-content [data-field='" + field + "']",
    ) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  it("offers the three combine rules with the standard one as the blank default", () => {
    const select = document.querySelector(
      "#detail-content select[data-field='combine']",
    ) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => [o.value, o.text])).toEqual([
      ["", "Standard (multiplicative)"],
      ["additive", "Additive"],
      ["min", "Weakest link (min)"],
    ]);
    expect(select.value).toBe("");
  });

  it("round-trips combine, formula and the two bounds onto the node", () => {
    edit("formula", " a * 2 ");
    edit("minValue", "10");
    edit("maxValue", "250");
    edit("combine", "min"); // a select — re-renders the panel, so do it last

    expect(node().formula).toBe("a * 2"); // stored verbatim, trimmed
    expect(node().minValue).toBe(10);
    expect(node().maxValue).toBe(250);
    expect(node().combine).toBe("min");

    // The mutation path serialises back to CSV, which is what persists and what
    // the loader re-validates.
    expect(state.lastCsvSnapshot).toContain("a * 2");
  });

  it("clears each field back to the default when blanked", () => {
    edit("formula", "a * 2");
    edit("minValue", "10");
    expect(node().formula).toBe("a * 2");

    edit("formula", "");
    edit("minValue", "");
    edit("combine", "");

    expect(node().formula).toBeUndefined();
    expect(node().minValue).toBeUndefined();
    expect(node().combine).toBeUndefined();
  });

  it("keeps focus on a text field so tabbing between them survives the edit", () => {
    const input = document.querySelector(
      "#detail-content [data-field='formula']",
    ) as HTMLInputElement;
    input.focus();
    input.value = "a * 3";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    // Same element still in the document (the panel was not re-rendered).
    expect(document.contains(input)).toBe(true);
  });

  it("hangs one-line plain-language help off each new field's label", () => {
    const tips = Array.from(
      document.querySelectorAll("#detail-content .detail-quant-label[data-tooltip]"),
    ).map((el) => el.getAttribute("data-tooltip")!);
    expect(tips).toHaveLength(4);
    expect(tips.join(" ")).toContain(
      "every box named here must also have an arrow into this box",
    );
  });
});
