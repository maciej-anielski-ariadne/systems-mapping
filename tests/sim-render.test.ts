import { describe, it, expect } from "vitest";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import { render } from "../assets/js/11-rendering";
import { applySimMultiplier } from "../assets/js/14-simulation-panel";
import { formatNodeValue } from "../assets/js/07-simulation-engine";
import { state } from "../assets/js/03-state";
import { LINEAR_CSV } from "./fixtures/graphs";

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
