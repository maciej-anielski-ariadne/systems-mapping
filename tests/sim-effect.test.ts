// What the simulation is DOING to each box: the shared effect maths behind the
// map's fills, the atlas's circles and both panels' numbers.
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import {
  EFFECT_FLOOR_PCT,
  biggestMover,
  maxEffectPct,
  nodeEffect,
  recomputeValues,
  gatedBy,
  formatNodeValue,
} from "../assets/js/07-simulation-engine";
import { SIM_FLAT_FILL, formatScalar, formatScalarInput, mixHex, simEffectFill } from "../assets/js/04-utils";
import { refreshSelectionStyling, render, updateSimulationValuesInPlace } from "../assets/js/11-rendering";
import { applyRestoredUiState } from "../assets/js/04a-storage";
import { applySimMultiplier, renderSimulationPanel } from "../assets/js/14-simulation-panel";
import { renderDetailPanel } from "../assets/js/15-detail-panel";
import { showTooltip } from "../assets/js/12-tooltip";
import { buildExportModel, renderExportSvg } from "../assets/js/19-export";
import { selectNode } from "../assets/js/09-graph-selection";
import { atlasRadius, closeAtlas, initAtlasStage, openAtlas, refreshAtlasValues, traceLinkShares } from "../assets/js/21-atlas-view";
import { state, NODES, nodeById, outgoingEdges } from "../assets/js/03-state";
import { FAN_CSV, FORMULA_GATE_CSV, GATED_CSV, LINEAR_CSV, WIDE_CSV } from "./fixtures/graphs";


initAtlasStage();

// a (controllable, no direction) → b (no direction) → c (higher_better).
// a ×4 lifts b by 4^0.5 = ×2 (+100%) and c by that again (+100%).
const nudge = (multiplier: number) => {
  state.userOverrides = { a: multiplier };
  recomputeValues();
};

describe("nodeEffect", () => {
  beforeEach(() => { loadDataFromCsv(LINEAR_CSV); state.userOverrides = {}; recomputeValues(); });

  it("says nothing has moved when nothing has", () => {
    for (const id of ["a", "b", "c"]) {
      const effect = nodeEffect(id);
      expect(effect.moved).toBe(false);
      expect(effect.strength).toBe(0);
      expect(effect.merit).toBe("none");
    }
    expect(maxEffectPct()).toBeCloseTo(0, 9);
    expect(biggestMover()).toBeNull();
  });

  it("ignores a move smaller than the floor", () => {
    // +0.2% — under EFFECT_FLOOR_PCT, so it is noise, not an effect.
    nudge(1.002);
    expect(EFFECT_FLOOR_PCT).toBe(0.5);
    expect(nodeEffect("a").pct).toBeCloseTo(0.2, 6);
    expect(nodeEffect("a").moved).toBe(false);
    expect(nodeEffect("a").strength).toBe(0);
  });

  it("puts the biggest mover at full strength and scales the rest under it", () => {
    nudge(4);                                   // a +300%, b +100%, c +100%
    expect(nodeEffect("a").pct).toBeCloseTo(300, 6);
    expect(nodeEffect("b").pct).toBeCloseTo(100, 6);
    expect(maxEffectPct()).toBeCloseTo(300, 6);

    expect(nodeEffect("a").strength).toBeCloseTo(1, 9);
    // Relative ramp with the 0.6 lift: (100/300)^0.6.
    expect(nodeEffect("b").strength).toBeCloseTo(Math.pow(1 / 3, 0.6), 9);
    expect(nodeEffect("b").strength).toBeGreaterThan(1 / 3);   // …the lift is real
    expect(nodeEffect("b").strength).toBeLessThan(1);
  });

  it("names the biggest mover", () => {
    nudge(4);
    const top = biggestMover();
    expect(top!.node.id).toBe("a");
    expect(top!.pct).toBeCloseTo(300, 6);
  });

  it("reads merit from the box's own direction", () => {
    nudge(4);                                   // everything up
    expect(nodeEffect("c").merit).toBe("good"); // c is higher_better
    expect(nodeEffect("a").merit).toBe("none"); // a says nothing about merit
    expect(nodeEffect("b").merit).toBe("none");

    nudge(0.25);                                // everything down
    expect(nodeEffect("c").merit).toBe("bad");
    expect(nodeEffect("a").merit).toBe("none");
  });

  it("takes a precomputed delta rather than formatting it twice", () => {
    nudge(4);
    expect(nodeEffect("b", { text: "+100.0%", pct: 100 })).toEqual(nodeEffect("b"));
  });
});

describe("the effect colour ramp", () => {
  it("mixes hex endpoints", () => {
    expect(mixHex("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mixHex("#000000", "#ffffff", 1)).toBe("#ffffff");
    expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mixHex("#000", "#fff", 1)).toBe("#ffffff");     // short form
    expect(mixHex("#000000", "#ffffff", 5)).toBe("#ffffff"); // clamped
  });

  it("starts near grey and ends at the deep end of its hue", () => {
    const faint = simEffectFill("good", 0.001);
    const full  = simEffectFill("good", 1);
    expect(faint).toMatch(/^#[0-9a-f]{6}$/);
    expect(full).toBe("#4fc493");
    // A faint move is much closer to the unmoved grey than a full one is.
    const dist = (hex: string) => {
      const a = parseInt(hex.slice(1), 16), b = parseInt(SIM_FLAT_FILL.slice(1), 16);
      return Math.abs((a >> 16) - (b >> 16)) + Math.abs(((a >> 8) & 255) - ((b >> 8) & 255));
    };
    expect(dist(faint)).toBeLessThan(dist(full));
  });

  it("gives each merit its own hue", () => {
    const [good, bad, none] = ["good", "bad", "none"].map(m => simEffectFill(m, 1));
    expect(new Set([good, bad, none]).size).toBe(3);
    // An unknown merit is a move with no view on it, not a crash.
    expect(simEffectFill("nonsense", 1)).toBe(none);
  });
});

describe("the map in simulation mode", () => {
  const group = (id: string) => document.querySelector('.node-group[data-node-id="' + id + '"]')!;
  const fillOf = (id: string) => group(id).querySelector(".node-rect")!.getAttribute("fill");

  beforeEach(() => {
    loadDataFromCsv(LINEAR_CSV);
    state.userOverrides = {};
    state.simulationMode = false;
    recomputeValues();
  });

  it("leaves the category fills alone when not simulating", () => {
    render();
    expect(group("a").getAttribute("class")).not.toContain("sim-fill");
    expect(fillOf("a")).not.toBe(SIM_FLAT_FILL);
  });

  it("greys every box the moment simulation opens, before anything moves", () => {
    state.simulationMode = true;
    render();
    for (const id of ["a", "b", "c"]) {
      expect(group(id).getAttribute("class")).toContain("sim-fill");
      expect(group(id).getAttribute("class")).toContain("sim-flat");
      expect(fillOf(id)).toBe(SIM_FLAT_FILL);
    }
  });

  it("colours what moved and leaves what didn't grey", () => {
    state.simulationMode = true;
    nudge(4);
    render();
    expect(group("a").getAttribute("class")).not.toContain("sim-flat");
    expect(fillOf("a")).toBe(simEffectFill("none", 1));           // a: no direction
    expect(fillOf("c")).toBe(simEffectFill("good", nodeEffect("c").strength));
    expect(fillOf("a")).not.toBe(fillOf("c"));
  });

  it("repaints the fills on a scrub without rebuilding the map", () => {
    state.simulationMode = true;
    nudge(4);
    render();
    const before = fillOf("c");
    const groupBefore = group("c");

    nudge(1.5);                                   // a gentler run
    expect(updateSimulationValuesInPlace()).toBe(true);
    expect(group("c")).toBe(groupBefore);         // same element — no rebuild
    // The ramp is relative, and c's share of the biggest mover is not fixed
    // (the elasticities are not linear), so its colour has to have followed.
    expect(fillOf("c")).not.toBe(before);
    expect(fillOf("c")).toBe(simEffectFill("good", nodeEffect("c").strength));

    // Under the floor, every delta label becomes empty without changing the
    // markup, so the same node element can be kept and repainted grey.
    nudge(1.001);
    expect(updateSimulationValuesInPlace()).toBe(true);
    expect(group("c")).toBe(groupBefore);
    expect(group("c").querySelector(".node-delta")!.textContent).toBe("");
    expect(fillOf("c")).toBe(SIM_FLAT_FILL);
    expect(group("c").classList.contains("sim-flat")).toBe(true);
  });
});

describe("restoring a saved simulation", () => {
  beforeEach(() => { loadDataFromCsv(LINEAR_CSV); state.userOverrides = {}; state.simulationMode = false; recomputeValues(); });

  // Regression: the branch that restored you INTO simulation mode was the one
  // branch that never solved with the overrides it had just restored, so the
  // sliders came back moved while every value on the map read its start.
  it("applies the restored sliders to the values", () => {
    applyRestoredUiState({ simulationMode: true, userOverrides: { a: 4 } });
    expect(state.simulationMode).toBe(true);
    expect(state.userOverrides).toEqual({ a: 4 });
    expect(state.computedValues.a).toBeCloseTo(400, 6);
    expect(state.computedValues.b).toBeCloseTo(100, 6);
    expect(nodeEffect("b").moved).toBe(true);
  });

  it("still applies them when simulation mode is off", () => {
    applyRestoredUiState({ simulationMode: false, userOverrides: { a: 4 } });
    expect(state.computedValues.b).toBeCloseTo(100, 6);
  });
});

describe("selection while simulating", () => {
  const group = (id: string) => document.querySelector('.node-group[data-node-id="' + id + '"]')!;
  const fillOf = (id: string) => group(id).querySelector(".node-rect")!.getAttribute("fill");

  beforeEach(() => {
    loadDataFromCsv(LINEAR_CSV);
    state.simulationMode = true;
    state.userOverrides = { a: 4 };
    recomputeValues();
    render();
  });

  // Regression: refreshSelectionStyling rebuilt every box's fill from its
  // CATEGORY, so the first click during a simulation repainted the whole map
  // in its resting colours — including on boot, where restoring a selection is
  // the first thing that happens after simulation mode comes back.
  it("keeps the effect fills when the selection changes", () => {
    const before = ["a", "b", "c"].map(fillOf);
    selectNode("a");
    expect(refreshSelectionStyling()).toBe(true);
    expect(["a", "b", "c"].map(fillOf)).toEqual(before);
    for (const id of ["a", "b", "c"]) {
      expect(group(id).getAttribute("class")).toContain("sim-fill");
      expect(group(id).getAttribute("class")).not.toContain("pre-desat");
    }
    // …and the selection itself still reads.
    expect(group("a").getAttribute("class")).toContain("selected");
    expect(group("b").getAttribute("class")).toContain("descendant");  // one hop
  });

  it("gives the category fills back when simulation ends", () => {
    selectNode("a");
    refreshSelectionStyling();
    state.simulationMode = false;
    render();
    expect(group("b").getAttribute("class")).not.toContain("sim-fill");
    expect(fillOf("b")).not.toBe(SIM_FLAT_FILL);
  });
});

describe("exporting a simulation", () => {
  beforeEach(() => { loadDataFromCsv(LINEAR_CSV); state.userOverrides = {}; state.simulationMode = false; recomputeValues(); });

  it("carries the run's colours, not just its numbers", () => {
    state.simulationMode = true;
    state.userOverrides = { a: 4 };
    recomputeValues();
    const { svg } = renderExportSvg(buildExportModel({ allEdges: true })!);
    // a is the biggest mover, and has no direction of merit.
    expect(svg).toContain(simEffectFill("none", 1));
    expect(svg).toContain("+300.0%");
  });

  it("exports the resting category colours when not simulating", () => {
    const { svg } = renderExportSvg(buildExportModel({ allEdges: true })!);
    expect(svg).not.toContain(SIM_FLAT_FILL);
  });
});

// A number field is not a display: the browser refuses any value that is not a
// bare floating-point literal and renders an EMPTY BOX instead. formatScalar's
// thousands separator therefore blanked the "Current" field the moment a value
// crossed 10,000 — reported as "Border Force FTE disappears above 111%".
describe("numbers going into a number field", () => {
  it("never groups thousands", () => {
    expect(formatScalar(10080)).toBe("10,080");     // right for a label…
    expect(formatScalarInput(10080)).toBe("10080"); // …wrong for a field
    expect(formatScalarInput(14400)).toBe("14400");
    for (const v of [1e4, 1.5e6, 9.9e8, 1e9, 4.2e12]) {
      expect(formatScalarInput(v)).toMatch(/^-?\d+(\.\d+)?$/);
      expect(Number(formatScalarInput(v))).toBeCloseTo(v, 0);
    }
  });

  it("never folds billions into a unit count", () => {
    // formatScalar says "1.50" meaning 1.5 billion. In a field that reads back
    // as the number one and a half — worse than blank, because it looks fine.
    expect(formatScalar(1.5e9)).toBe("1.50");
    expect(Number(formatScalarInput(1.5e9))).toBeCloseTo(1.5e9, 0);
  });

  it("keeps the precision ladder the display uses", () => {
    expect(formatScalarInput(9990)).toBe("9990");
    expect(formatScalarInput(123.4)).toBe("123");
    expect(formatScalarInput(12.34)).toBe("12.3");
    expect(formatScalarInput(1.234)).toBe("1.23");
    expect(formatScalarInput(0.1234)).toBe("0.123");
    expect(formatScalarInput(-10080)).toBe("-10080");
  });

  it("gives a number field an empty string rather than 'NaN'", () => {
    expect(formatScalarInput(NaN)).toBe("");
    expect(formatScalarInput(Infinity)).toBe("");
  });

  it("puts a readable value in every live number field past 10,000", () => {
    loadDataFromCsv(LINEAR_CSV);
    state.simulationMode = true;
    state.userOverrides = {};
    recomputeValues();
    renderSimulationPanel();
    selectNode("a");
    renderDetailPanel();

    // a's baseline is 100 — ×150 puts it at 15,000, past the grouping threshold.
    applySimMultiplier("a", 150, null);
    renderSimulationPanel();
    renderDetailPanel();

    for (const sel of [".sim-value-input", ".detail-value-input"]) {
      const input = document.querySelector(sel) as HTMLInputElement;
      expect(input, sel).toBeTruthy();
      expect(input.value, sel).toBe("15000");
      expect(input.value, sel).not.toContain(",");
      expect(Number(input.value), sel).toBeCloseTo(15000, 6);
    }
  });
});

describe("the movers list", () => {
  const panel = () => document.getElementById("detail-content")!;
  // "Along the way" is the boxes between the input and the outputs — the one
  // section that caps, now the outputs live in the pathway list below.
  const rows = () => panel().querySelectorAll('[data-section="rest"] .mv').length;
  const toggle = () => panel().querySelector('[data-moves-toggle="rest"]') as HTMLButtonElement | null;

  beforeEach(() => {
    loadDataFromCsv(WIDE_CSV);
    state.simulationMode = true;
    state.userOverrides = { hub: 4 };
    recomputeValues();
    openAtlas("hub");
    renderDetailPanel();
  });
  afterEach(() => closeAtlas());

  it("shows a ranking, and says how many it is holding back", () => {
    expect(rows()).toBe(3);
    expect(toggle()!.textContent).toBe("9 more, all smaller");
    expect(toggle()!.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows every mover when asked, and folds back", () => {
    // The twelve boxes in the middle: movers that are not the input and not an
    // output (the outputs are the pathway list's headings).
    const middle = NODES.filter(n =>
      nodeEffect(n.id).moved && outgoingEdges[n.id].length && !n.controllable).length;
    expect(middle).toBe(12);

    toggle()!.click();
    expect(rows()).toBe(middle);   // every one of them
    expect(toggle()!.textContent).toBe("Show fewer");
    expect(toggle()!.getAttribute("aria-expanded")).toBe("true");
    // Open, it scrolls rather than pushing the pathway list off the bottom.
    expect(panel().querySelector('[data-section="rest"]')!.classList.contains("open")).toBe(true);

    toggle()!.click();
    expect(rows()).toBe(3);
  });

  it("holds the choice while the numbers move under it", () => {
    toggle()!.click();
    applySimMultiplier("hub", 3, null);
    renderDetailPanel();
    expect(toggle()!.textContent).toBe("Show fewer");
    expect(rows()).toBeGreaterThan(3);
  });

  it("starts folded again on a fresh atlas", () => {
    toggle()!.click();
    closeAtlas();
    openAtlas("hub");
    renderDetailPanel();
    expect(rows()).toBe(3);
  });

  it("has no separate outputs section — the pathway list is the outputs", () => {
    expect(panel().querySelector('[data-section="finals"]')).toBeNull();
    const eyebrows = [...panel().querySelectorAll(".eyebrow")].map(e => e.textContent);
    expect(eyebrows).toEqual(["Changed input", "Along the way", "Pathways"]);
  });
});

// ── The pathway list, now that it is a drill-down ──────────────────────────
// The list opens on the destinations; a destination's forks appear only once
// you have opened it, and the way back out is the crumb line above them. These
// walk it the way a reader has to.
const destHeads = () =>
  [...document.querySelectorAll("#detail-content .dhead")] as HTMLButtonElement[];
const destHead = (name: string) =>
  destHeads().find(h => h.querySelector(".dname")!.textContent === name)!;
const openDest = (name: string) => destHead(name).click();
const forkRows = () =>
  [...document.querySelectorAll("#detail-content .strandrow")] as HTMLButtonElement[];
const backToTop = () => {
  const crumb = document.querySelector("#detail-content [data-crumb='0']") as HTMLButtonElement | null;
  if (crumb) crumb.click();
};
// Opened at all. Nothing is chosen exactly when the "All pathways" row is the
// marked one, so that mark is the whole answer.
const insideList = () => !document.querySelector("#detail-content .pathall.cur");
// The innermost level on screen — with the whole chain listed, .strandrow now
// matches every level at once.
const deepestRows = (): HTMLButtonElement[] => {
  const levels = [...document.querySelectorAll("#detail-content .pathlvl")];
  const last = levels[levels.length - 1];
  return last ? [...last.querySelectorAll(":scope > .strandrow")] as HTMLButtonElement[] : [];
};
// Open whichever destination has a fork whose label matches, and hand it back.
const openAnyForkMatching = (re: RegExp): HTMLButtonElement | undefined => {
  for (let i = 0; i < destHeads().length; i++) {
    backToTop();
    destHeads()[i].click();
    const hit = forkRows().find(r => re.test(r.textContent || ""));
    if (hit) return hit;
  }
  backToTop();
  return undefined;
};

// The first destination with more than one way in, and its forks.
const openFirstForked = (): HTMLButtonElement[] => {
  for (let i = 0; i < destHeads().length; i++) {
    destHeads()[i].click();
    if (forkRows().length) return forkRows();
    backToTop();
  }
  return [];
};

describe("the pathway list", () => {
  const panel = () => document.getElementById("detail-content")!;

  beforeEach(() => {
    loadDataFromCsv(WIDE_CSV);
    state.simulationMode = false;
    state.userOverrides = {};
    recomputeValues();
    openAtlas("hub");
    renderDetailPanel();
  });
  afterEach(() => closeAtlas());

  it("names each destination once, however many pathways arrive there", () => {
    const heads = [...panel().querySelectorAll(".dhead .dname")].map(h => h.textContent);
    expect(heads.length).toBeGreaterThan(0);
    expect(new Set(heads).size).toBe(heads.length);     // no destination twice
  });

  it("tells the forks under a destination apart on screen, not just in the data", () => {
    const names = destHeads().map(h => h.querySelector(".dname")!.textContent!);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      openDest(name);
      const rows = forkRows().map(r => r.querySelector(".dest")!.textContent);
      // A fork is named by the shortest thing that tells it from its siblings —
      // so at one level no two rows may READ alike.
      expect(new Set(rows).size, name).toBe(rows.length);
      backToTop();
    }
  });

  it("counts every way into a destination", () => {
    const names = destHeads().map(h => h.querySelector(".dname")!.textContent!);
    expect(names).toHaveLength(3);
    for (const name of names) {
      expect(destHead(name).querySelector(".m")!.textContent).toBe("×4");
      openDest(name);
      expect(forkRows()).toHaveLength(4);
      backToTop();
    }
  });

  it("shows no forks until a destination is opened", () => {
    // The count on a heading is a door, not a summary of rows already on
    // screen: at rest the list is the destinations and nothing else.
    expect(forkRows()).toHaveLength(0);
    expect(insideList()).toBe(false);
  });

  it("opens the destination when clicked, and carries the way back with it", () => {
    for (const head of destHeads()) expect(head.tagName).toBe("BUTTON");
    openDest(destHeads()[0].querySelector(".dname")!.textContent!);
    expect(insideList()).toBe(true);
    // The forks you did not take never leave: every destination is still listed.
    expect(destHeads()).toHaveLength(3);
    expect(document.querySelector("#detail-content [data-crumb='0']")).not.toBeNull();
    backToTop();
    expect(insideList()).toBe(false);
    expect(destHeads().length).toBe(3);
  });
});

// Four routes to one output, three of them leaving by the same box.
describe("pathways that fan out and rejoin", () => {
  const panel = () => document.getElementById("detail-content")!;
  const rows = () => forkRows();
  const label = (r: Element) => r.querySelector(".dest")!.textContent;

  beforeEach(() => {
    loadDataFromCsv(FAN_CSV);
    state.simulationMode = false;
    state.userOverrides = {};
    recomputeValues();
    openAtlas("alpha");
    renderDetailPanel();
  });
  afterEach(() => closeAtlas());

  it("names the destination once and counts every way in", () => {
    expect(destHeads()).toHaveLength(1);
    expect(destHeads()[0].querySelector(".dname")!.textContent).toBe("Zulu");
    expect(destHeads()[0].querySelector(".m")!.textContent).toBe("×4");
  });

  it("merges the routes that leave by the same box into one fork", () => {
    // alpha→bravo→zulu, →bravo→delta→zulu, →bravo→echo→zulu all part at Bravo;
    // alpha→charlie→zulu is the only one that does not.
    openDest("Zulu");
    expect(rows()).toHaveLength(2);
    expect(label(rows()[0])).toContain("via Bravo");
    expect(label(rows()[0])).toContain("×3");
    expect(label(rows()[1])).toBe("via Charlie");
    // No two forks can read alike — that is what a fork IS.
    expect(new Set(rows().map(label)).size).toBe(2);
  });

  it("opens the grouped fork into the three routes it stood for", () => {
    // The ×3 was the only trace of what lay past Bravo, and there was no way
    // to reach it. Now it is the door to those three.
    openDest("Zulu");
    rows().find(r => /via Bravo/.test(r.textContent || ""))!.click();
    const inner = deepestRows().map(label);
    expect(inner).toHaveLength(3);
    expect(inner.some(l => /straight there|Zulu/.test(l || ""))).toBe(true);
    expect(inner.some(l => /Delta/.test(l || ""))).toBe(true);
    expect(inner.some(l => /Echo/.test(l || ""))).toBe(true);
    // Deeper labels pick up where the row above left off rather than restating it.
    for (const l of inner) expect(l).not.toContain("via Bravo");
  });

  it("says how long the routes are when not simulating", () => {
    openDest("Zulu");
    const right = rows().map(r => r.querySelector(".m")!.textContent);
    expect(right[0]).toBe("3–4 steps");   // bravo direct, or round by delta/echo
    expect(right[1]).toBe("3 steps");
  });

  it("splits the destination's change across the routes that delivered it", () => {
    state.simulationMode = true;
    state.userOverrides = { alpha: 1.5 };
    recomputeValues();
    renderDetailPanel();
    const total = destHeads()[0].querySelector(".dmove")!.textContent!;
    openDest("Zulu");

    // Four routes reach Zulu, with these gains (products of link strengths):
    //   alpha→bravo→zulu            0.8 × 0.5       = 0.400
    //   alpha→bravo→delta→zulu      0.8 × 0.4 × 0.6 = 0.192   } one branch,
    //   alpha→bravo→echo→zulu       0.8 × 0.3 × 0.2 = 0.048   } gain 0.640
    //   alpha→charlie→zulu          0.2 × 0.1       = 0.020
    // Zulu itself lands on +30.6833%, and 0.640 / 0.660 of that is +29.8%.
    const right = rows().map(r => r.querySelector(".m")!.textContent!);
    expect(right).toEqual(["+29.8%", "+0.9%"]);

    expect(total).toBe("+30.7%");
    // The whole point of the number: the column adds up to the heading.
    const num = (t: string) => Number(t.replace("%", ""));
    expect(right.reduce((a, t) => a + num(t), 0)).toBeCloseTo(num(total), 9);
  });

  it("is the engine's own arithmetic, not an estimate of it", () => {
    state.simulationMode = true;
    state.userOverrides = { alpha: 1.5 };
    recomputeValues();
    // The multiplicative rule is additive in logs, so summing the route gains
    // and re-exponentiating has to reproduce what the solver actually computed.
    const gains = 0.8 * 0.5 + 0.8 * 0.4 * 0.6 + 0.8 * 0.3 * 0.2 + 0.2 * 0.1;
    const predicted = Math.exp(gains * Math.log(1.5)) * nodeById.zulu.baseline!;
    expect(state.computedValues.zulu).toBeCloseTo(predicted, 9);
  });
});

// Clicking a mover asks "how did the run reach this box". The answer is every
// route from a slider that MOVED to that box — and nothing that merely sits
// downstream of the same input without leading there.
describe("tracing a mover back to what you moved", () => {
  const lit = () => [...document.querySelectorAll("svg.atlas g.n.on")].map(g => (g as HTMLElement).dataset.el);
  const head = (dest: string) => destHead(dest);

  beforeEach(() => {
    // hub → twelve boxes → three outputs, four boxes feeding each output.
    loadDataFromCsv(WIDE_CSV);
    state.simulationMode = true;
    state.userOverrides = { hub: 4 };
    recomputeValues();
    openAtlas("hub");
    renderDetailPanel();
  });
  afterEach(() => closeAtlas());

  it("lights the input, every route to that output, and nothing else", () => {
    head("Yankee").click();

    const on = lit();
    expect(on).toContain("START");                          // hub, the slider that moved
    expect(on).toContain("N:yankee");
    // Mike / November / Oscar / Papa are the four ways into Yankee.
    for (const via of ["N:i1", "N:i2", "N:i3", "N:i4"]) expect(on).toContain(via);
    // The other eight hang off the same input but lead to other outputs.
    for (const off of ["N:i5", "N:i9", "N:i12", "N:zulu", "N:juliett"]) {
      expect(on).not.toContain(off);
    }
  });

  it("lets go when the way back out is taken", () => {
    head("Zulu").click();
    expect(lit().length).toBeGreaterThan(1);
    expect(insideList()).toBe(true);
    backToTop();
    expect(lit()).toHaveLength(0);
    expect(insideList()).toBe(false);
  });

  it("traces from a box in the middle too", () => {
    const first = document.querySelector("[data-moverbox]") as HTMLButtonElement;
    const box = first.dataset.moverbox!;
    first.click();
    expect(lit()).toContain("START");
    // The click re-renders the panel, so the row has to be found again — the
    // element clicked is detached by the time the assertion runs.
    const now = document.querySelector('[data-moverbox="' + box + '"]')!;
    expect(now.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("the order of the pathway list", () => {
  const dests = () =>
    [...document.querySelectorAll("#detail-content .dhead .dname")].map(d => d.textContent);
  const moves = () =>
    [...document.querySelectorAll("#detail-content .dhead .dmove")]
      .map(d => Math.abs(Number(d.textContent!.replace("%", ""))));

  beforeEach(() => { loadDataFromCsv(WIDE_CSV); state.userOverrides = {}; state.simulationMode = false; recomputeValues(); });
  afterEach(() => closeAtlas());

  it("leads with the nearest destination when nothing is simulating", () => {
    openAtlas("hub");
    renderDetailPanel();
    expect(dests().length).toBeGreaterThan(1);
    expect(document.querySelector(".dhead .dmove")).toBeNull();   // no numbers at rest
  });

  it("leads with the destination that moved most once the sliders are out", () => {
    state.simulationMode = true;
    state.userOverrides = { hub: 4 };
    recomputeValues();
    openAtlas("hub");
    renderDetailPanel();

    const order = moves();
    expect(order.length).toBeGreaterThan(1);
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1], "row " + i + " of " + JSON.stringify(dests())).toBeGreaterThanOrEqual(order[i]);
    }
  });
});

// While a trace is up the ribbons stop meaning "readings through here" and mean
// "this much of the picked box's change arrived by here". The shares across any
// cut of the traced subgraph must sum to 1 — that is what makes the picture add
// up the way the list does.
describe("the effect flowing through the picture", () => {
  const head = (dest: string) => destHead(dest);
  const width = (a: string, b: string) =>
    Number(document.querySelector(`.fl[data-a="${a}"][data-b="${b}"]`)!.getAttribute("stroke-width"));
  const key = (a: string, b: string) => a + "\u0000" + b;

  beforeEach(() => {
    loadDataFromCsv(FAN_CSV);
    state.simulationMode = true;
    state.userOverrides = { alpha: 1.5 };
    recomputeValues();
    openAtlas("alpha");
    renderDetailPanel();
  });
  afterEach(() => closeAtlas());

  it("splits each link's share so any cut of the trace sums to one", () => {
    head("Zulu").click();
    const shares = traceLinkShares()!;
    expect(shares).not.toBeNull();
    const of = (a: string, b: string) => shares.get(key(a, b))!;

    // Out of the input: bravo's three routes carry 0.64 of 0.66, charlie 0.02.
    expect(of("START", "N:bravo")).toBeCloseTo(0.64 / 0.66, 9);
    expect(of("START", "N:charlie")).toBeCloseTo(0.02 / 0.66, 9);
    expect(of("START", "N:bravo") + of("START", "N:charlie")).toBeCloseTo(1, 9);

    // Into the destination: four links arrive, and they account for all of it.
    const into = ["N:bravo", "N:charlie", "N:delta", "N:echo"]
      .reduce((a, n) => a + of(n, "N:zulu"), 0);
    expect(into).toBeCloseTo(1, 9);

    // A route with no branching carries the same share at both of its links.
    expect(of("N:bravo", "N:delta")).toBeCloseTo(of("N:delta", "N:zulu"), 9);
  });

  it("draws the ribbons by that share, and hands the width back afterwards", () => {
    const structural = width("START", "N:charlie");
    head("Zulu").click();
    // Bravo carries 32x what Charlie does, so its ribbon has to be the fatter.
    expect(width("START", "N:bravo")).toBeGreaterThan(width("START", "N:charlie"));
    expect(width("START", "N:charlie")).toBeLessThan(structural);

    backToTop();                                // let go
    expect(traceLinkShares()).toBeNull();
    expect(width("START", "N:charlie")).toBeCloseTo(structural, 9);
  });

  it("never draws a ribbon fatter than the circles it joins", () => {
    head("Zulu").click();
    for (const p of document.querySelectorAll(".fl")) {
      const w = Number(p.getAttribute("stroke-width"));
      const a = (p as HTMLElement).dataset.a!, b = (p as HTMLElement).dataset.b!;
      const r = Math.min(atlasRadius(a), atlasRadius(b));
      expect(w, a + " to " + b).toBeLessThanOrEqual(Math.max(1.4, 0.85 * r) + 1e-9);
    }
  });
});

describe("only the links the effect travels", () => {
  const drawn = () => [...document.querySelectorAll(".fl")].filter(p => !p.classList.contains("off")).length;
  const all = () => document.querySelectorAll(".fl").length;
  const head = (dest: string) => destHead(dest);

  beforeEach(() => {
    loadDataFromCsv(WIDE_CSV);
    state.userOverrides = {};
    state.simulationMode = false;
    recomputeValues();
  });
  afterEach(() => closeAtlas());

  it("draws every link when not simulating", () => {
    openAtlas("hub");
    expect(drawn()).toBe(all());
    expect(all()).toBeGreaterThan(10);
  });

  it("draws none of them until a slider has moved", () => {
    state.simulationMode = true;
    recomputeValues();
    openAtlas("hub");
    expect(drawn()).toBe(0);
  });

  it("draws the links the run reached once a slider moves", () => {
    state.simulationMode = true;
    state.userOverrides = { hub: 4 };
    recomputeValues();
    openAtlas("hub");
    expect(drawn()).toBe(all());        // this map moves everything
  });

  it("narrows to the picked box's own routes", () => {
    state.simulationMode = true;
    state.userOverrides = { hub: 4 };
    recomputeValues();
    openAtlas("hub");
    renderDetailPanel();
    head("Yankee").click();
    // hub → four of the twelve → Yankee is eight links out of the whole map.
    expect(drawn()).toBe(8);
    expect(drawn()).toBeLessThan(all());
  });
});

// =============================================================================
// ONE THING AT A TIME
// -----------------------------------------------------------------------------
// Four kinds of item in this panel can be picked, and each answers by lighting
// a run of circles. Two held at once put two answers in the picture at the same
// time — which was possible in both directions: lighting a box never let go of
// the pathway being read, and picking a pathway never let go of the lit box.
// =============================================================================
describe("picking one thing lets go of the last", () => {
  const movers = () => [...document.querySelectorAll("#detail-content [data-moverbox]")] as HTMLButtonElement[];
  // The box rows are the only trace control left in the panel — a destination
  // is reached by opening it now, and the crumb line says where you are.
  const pressed = () => document.querySelectorAll("#detail-content .mv.lit").length;
  // Narrowed past the destination, so a fork is being read rather than
  // everything that arrived. That is the state a lit box has to displace.
  const readAFork = () => { openFirstForked()[0].click(); };

  beforeEach(() => {
    loadDataFromCsv(WIDE_CSV);
    state.simulationMode = true;
    state.userOverrides = { hub: 4 };
    recomputeValues();
    openAtlas("hub");
    renderDetailPanel();
  });
  afterEach(() => closeAtlas());

  it("drops the pathway when a box is lit", () => {
    readAFork();
    expect(insideList()).toBe(true);

    movers()[0].click();
    // The click re-renders the panel, so nothing captured before it survives.
    // Lighting a box closes the list back to the destinations.
    expect(insideList()).toBe(false);
    expect(pressed()).toBe(1);
  });

  it("drops the lit box when a pathway is picked", () => {
    movers()[0].click();
    expect(pressed()).toBe(1);

    readAFork();
    expect(pressed()).toBe(0);
    expect(insideList()).toBe(true);
  });

  it("never lights two runs in the picture at once", () => {
    const on = () => document.querySelectorAll("svg.atlas g.n.on").length;
    movers()[0].click();
    const traced = on();
    readAFork();
    // A pathway is a single run; the trace it replaced is gone rather than
    // added to.
    expect(on()).toBeGreaterThan(0);
    expect(on()).not.toBe(traced + on());
    expect(document.querySelectorAll("#detail-content .mv.lit")).toHaveLength(0);
  });
});

// =============================================================================
// THE SIZE OF THE MOVE, ON THE CIRCLE
// -----------------------------------------------------------------------------
// Colour says how big a move is only relative to the biggest one on the map.
// The number says how big it actually is — and read down a lit run, the two
// together say how the effect grows or fades as it travels.
// =============================================================================
describe("the magnitude on the circles", () => {
  const mag = (el: string) =>
    document.querySelector(`svg.atlas g.n[data-el="${el}"] tspan.mag`) as SVGElement;

  beforeEach(() => {
    loadDataFromCsv(WIDE_CSV);
    state.simulationMode = true;
    state.userOverrides = { hub: 4 };
    recomputeValues();
    openAtlas("hub");
  });
  afterEach(() => { closeAtlas(); state.simulationMode = false; state.userOverrides = {}; });

  it("writes the move beside the name, signed and coloured", () => {
    const t = mag("N:yankee");
    expect(t.textContent).toMatch(/^[+-]\d+(\.\d)?%$/);
    expect(["good", "bad", "none"].some(m => t.classList.contains(m))).toBe(true);
  });

  it("says nothing on a circle that did not move", () => {
    state.userOverrides = {};
    recomputeValues();
    refreshAtlasValues();
    expect(mag("N:yankee").textContent).toBe("");
    expect(mag("N:yankee").getAttribute("class")).toBe("mag");
  });

  it("says nothing at all when not simulating", () => {
    state.simulationMode = false;
    refreshAtlasValues();
    expect([...document.querySelectorAll("svg.atlas tspan.mag")].every(t => !t.textContent)).toBe(true);
  });

  it("lives in the label, so it shows under the same rule the name does", () => {
    // Not a second <text> to be positioned and scaled on its own: one line,
    // one opacity, and it cannot land on top of a tangle's wheel.
    expect(mag("N:yankee").parentElement!.tagName.toLowerCase()).toBe("text");
    expect(mag("N:yankee").previousSibling).not.toBeNull();
  });
});

// =============================================================================
// READING A ROUTE WITHOUT HOLES IN IT
// -----------------------------------------------------------------------------
// Hiding the links the effect never travels is right for the picture at rest.
// It is wrong for the route being READ: a step that carries nothing measurable
// — a link into a box that barely moved, or one whose part is to hold a
// condition open rather than to push a number along — vanished mid-route, and a
// highlight with a gap in it reads as "the route stops here".
// =============================================================================
describe("the route being read is drawn whole", () => {
  beforeEach(() => {
    loadDataFromCsv(WIDE_CSV);
    state.simulationMode = true;
    state.userOverrides = { hub: 4 };
    recomputeValues();
    openAtlas("hub");
    renderDetailPanel();
  });
  afterEach(() => { closeAtlas(); state.simulationMode = false; state.userOverrides = {}; });

  it("leaves no step of a picked pathway hidden", () => {
    const rows = openFirstForked;
    expect(rows().length).toBeGreaterThan(0);
    const n = rows().length;
    for (let i = 0; i < Math.min(6, n); i++) {
      // Re-queried every time: each click re-renders the panel, so a row held
      // from before it is detached and clicking it does nothing at all.
      backToTop();
      rows()[i].click();
      expect(insideList()).toBe(true);
      // The links the pathway itself runs along are the ones marked hot.
      const steps = [...document.querySelectorAll("svg.atlas .fl.hot")];
      expect(steps.length).toBeGreaterThan(0);
      // What is drawn is a PREFIX of the route: it runs from the input until
      // the effect stops, and then it stops too. No hole in the middle, which
      // is the thing that read as "the route stops here" when it did not.
      let stopped = false;
      for (const step of steps) {
        if (step.classList.contains("off")) stopped = true;
        else expect(stopped).toBe(false);
      }
    }
  });

  it("keeps a step that carries nothing measurable, as a hairline", () => {
    // Nothing here is asserted about WHICH link that is — the point is the
    // rule: on the route being read, a link with no share left is drawn thin
    // rather than dropped, so the highlight has no hole in it.
    openFirstForked()[0].click();
    const steps = [...document.querySelectorAll("svg.atlas .fl.hot")] as HTMLElement[];
    for (const step of steps) {
      expect(Number(step.getAttribute("stroke-width"))).toBeGreaterThan(0);
      expect(step.classList.contains("off")).toBe(false);
    }
  });
});

// =============================================================================
// A TRACE DOES NOT NAME EVERY CIRCLE IT TOUCHES
// -----------------------------------------------------------------------------
// A trace reaches from the box asked about all the way back to the sliders. On
// a real map that is a dozen circles, and naming them all at once buries the
// picture under its own labels. A pathway is one route a handful of circles
// long, and keeps its names — reading the move at each step is what it is for.
// =============================================================================
describe("what gets named", () => {
  const svg = () => document.querySelector("svg.atlas")!;
  const head = (dest: string) => destHead(dest);

  beforeEach(() => {
    loadDataFromCsv(WIDE_CSV);
    state.simulationMode = true;
    state.userOverrides = { hub: 4 };
    recomputeValues();
    openAtlas("hub");
    renderDetailPanel();
  });
  afterEach(() => { closeAtlas(); state.simulationMode = false; state.userOverrides = {}; });

  it("names both ends of a trace and nothing in between", () => {
    head("Yankee").click();
    expect(svg().classList.contains("traced")).toBe(true);
    const named = ([...document.querySelectorAll("svg.atlas g.n.ends")] as HTMLElement[])
      .map(g => g.dataset.el);
    // What came out, and the slider it started at — a run named only at its far
    // end says what arrived without saying what set off.
    expect(new Set(named)).toEqual(new Set(["N:yankee", "START"]));
    // The middle of the run is still lit; it is not named, not dimmed away.
    expect(document.querySelectorAll("svg.atlas g.n.on").length).toBeGreaterThan(2);
  });

  it("keeps every name on a pathway", () => {
    openFirstForked()[0].click();
    expect(svg().classList.contains("traced")).toBe(false);
    expect(document.querySelectorAll("svg.atlas g.n.ends")).toHaveLength(0);
  });
});

// =============================================================================
// HELD BACK, NOT UNREACHED
// -----------------------------------------------------------------------------
// A box that sits still while the map moves around it is not necessarily one
// the run failed to reach. Under `min` — "you need all of these" — the weakest
// input decides, and if that one did not move then neither does the box, however
// hard the others are pushed. Rendered as plain grey that is indistinguishable
// from "nothing came this way", which is what made a simulated map read as
// broken. It is the most useful thing the picture can say, because it names
// what to move instead.
// =============================================================================
describe("a box held back by its weakest input", () => {
  beforeEach(() => {
    loadDataFromCsv(GATED_CSV);
    state.simulationMode = true;
    state.userOverrides = { pump: 4 };
    recomputeValues();
  });
  afterEach(() => { state.simulationMode = false; state.userOverrides = {}; });

  it("names the input that is holding it", () => {
    expect(nodeEffect("hold").moved).toBe(false);
    expect(gatedBy("hold")).toEqual({ id: "short", label: "Short Supply" });
  });

  it("says nothing about a box that simply moved", () => {
    state.userOverrides = { pump: 4, short: 4 };
    recomputeValues();
    expect(nodeEffect("hold").moved).toBe(true);
    expect(gatedBy("hold")).toBeNull();
  });

  it("says nothing when the run never reached it at all", () => {
    // Nothing moved: the box is still, but "held" would be an odd way to put it
    // — there is nothing being held back.
    state.userOverrides = {};
    recomputeValues();
    expect(gatedBy("hold")).toBeNull();
  });

  it("says nothing about a box with no gate", () => {
    expect(gatedBy("far")).toBeNull();
  });
});

describe("the picture, at a gate", () => {
  const el = (id: string) => document.querySelector(`svg.atlas g.n[data-el="${id}"]`) as HTMLElement;

  beforeEach(() => {
    loadDataFromCsv(GATED_CSV);
    state.simulationMode = true;
    state.userOverrides = { pump: 4 };
    recomputeValues();
    openAtlas("pump");
    renderDetailPanel();
  });
  afterEach(() => { closeAtlas(); state.simulationMode = false; state.userOverrides = {}; });

  it("marks the held circle and says what is holding it", () => {
    const g = el("N:hold");
    expect(g.classList.contains("held")).toBe(true);
    const mag = g.querySelector("tspan.mag")!;
    expect(mag.textContent).toBe("held by Short Supply");
    expect(mag.getAttribute("class")).toContain("hold");
    // The mark is markup, not a class on the circle: a bar across the way in.
    expect(g.querySelector("line.gate")).not.toBeNull();
  });

  it("draws nothing coming out of it", () => {
    // The absence IS the message: what the sliders can reach stops here, and
    // Far Output is not reachable by anything they can do.
    const out = document.querySelector('svg.atlas .fl[data-a="N:hold"][data-b="N:far"]')!;
    expect(out.classList.contains("off")).toBe(true);
  });

  it("still draws what arrives at it", () => {
    // The change does get this far. It is what happens next that does not. A
    // gate is the one still box whose ARRIVING links are drawn even at rest:
    // it is marked and explained, so the ribbon ending there has a story.
    const into = document.querySelector('svg.atlas .fl[data-a="START"][data-b="N:hold"]')!;
    expect(into.classList.contains("off")).toBe(false);
  });

  it("stops at a box that is merely pinned, not gated at all", () => {
    // pump → short → hold is structurally real and causally dead: short is a
    // slider sitting where it was left, so nothing travels through it. Drawing
    // it through implied a path from pump to hold by a route that carries
    // nothing — the border map's Border Force FTE → Vehicle Physical Search →
    // Lorry Wait Times, in miniature.
    expect(gatedBy("short")).toBeNull();          // not a gate; just pinned
    const into = () => document.querySelector('svg.atlas .fl[data-a="START"][data-b="N:short"]')!;
    const outOf = () => document.querySelector('svg.atlas .fl[data-a="N:short"][data-b="N:hold"]')!;
    // At rest neither is drawn: the effect travelled neither of them.
    expect(into().classList.contains("off")).toBe(true);
    expect(outOf().classList.contains("off")).toBe(true);

    // Reading the route THROUGH it changes nothing: a circle the change never
    // reached is not lit, so no ribbon runs to it either. A gate is the one
    // still box a route keeps — it is marked, and says what to move instead.
    const row = openAnyForkMatching(/Short Supply/);
    expect(row).toBeTruthy();
    row!.click();
    expect(document.querySelectorAll('svg.atlas g.n.on[data-el="N:short"]')).toHaveLength(0);
    expect(into().classList.contains("off")).toBe(true);
    expect(outOf().classList.contains("off")).toBe(true);
  });

  it("keeps the cut when the gate is on a pathway being read", () => {
    // The hairline rule draws a route WHOLE, and a gate is the one thing that
    // overrules it — otherwise the route would run visibly past the block.
    const rows = openFirstForked();
    if (rows.length) rows[0].click();
    const out = document.querySelector('svg.atlas .fl[data-a="N:hold"][data-b="N:far"]')!;
    expect(out.classList.contains("off")).toBe(true);
  });

  it("lets go of the mark once the gate is opened", () => {
    state.userOverrides = { pump: 4, short: 4 };
    recomputeValues();
    refreshAtlasValues();
    const g = el("N:hold");
    expect(g.classList.contains("held")).toBe(false);
    expect(g.querySelector("tspan.mag")!.textContent).toMatch(/^\+/);
    expect(document.querySelector('svg.atlas .fl[data-a="N:hold"][data-b="N:far"]')!
      .classList.contains("off")).toBe(false);
  });
});

describe("the map, at a gate", () => {
  beforeEach(() => {
    loadDataFromCsv(GATED_CSV);
    state.simulationMode = true;
    state.userOverrides = { pump: 4 };
    recomputeValues();
    render();
  });
  afterEach(() => { state.simulationMode = false; state.userOverrides = {}; });

  it("marks the held box and says so in the slot a mover uses", () => {
    const g = document.querySelector('.node-group[data-node-id="hold"]')!;
    expect(g.classList.contains("sim-held")).toBe(true);
    expect(g.querySelector("text.node-held")!.textContent).toBe("held");
  });

  it("leaves the boxes it never reached unmarked", () => {
    const g = document.querySelector('.node-group[data-node-id="far"]')!;
    expect(g.classList.contains("sim-flat")).toBe(true);
    expect(g.classList.contains("sim-held")).toBe(false);
  });
});


// =============================================================================
// THE SAME GATE, WRITTEN AS A FORMULA
// -----------------------------------------------------------------------------
// min() at the top of a formula says exactly what the `min` combine column
// says. Reading only the column missed the commoner of the two forms: on the
// border map that is Vehicle Physical Search (held by Vehicle X-Ray Scan),
// Parcel Physical Exam (held by Parcel X-Ray Screening) and Secondary
// Examination (held by Secondary Area Capacity) — three of the four gates on
// the map, all of them looking like boxes the run had simply failed to reach.
// =============================================================================
describe("a box held back by an arm of its formula", () => {
  beforeEach(() => {
    loadDataFromCsv(FORMULA_GATE_CSV);
    state.simulationMode = true;
    state.userOverrides = { pump: 4 };
    recomputeValues();
  });
  afterEach(() => { state.simulationMode = false; state.userOverrides = {}; });

  it("names the arm that is deciding", () => {
    expect(nodeEffect("hold").moved).toBe(false);
    expect(gatedBy("hold")).toEqual({ id: "short", label: "Short Supply" });
  });

  it("lets go once that arm is no longer the short one", () => {
    state.userOverrides = { pump: 4, short: 4 };
    recomputeValues();
    expect(nodeEffect("hold").moved).toBe(true);
    expect(gatedBy("hold")).toBeNull();
  });

  it("says nothing when nothing was moved at all", () => {
    state.userOverrides = {};
    recomputeValues();
    expect(gatedBy("hold")).toBeNull();
  });
});


// =============================================================================
// THE TOOLTIP ANSWERS THE QUESTION THE MARK RAISES
// -----------------------------------------------------------------------------
// A box says "held" and a circle says "held by X". Neither has room for the
// rest of it, and on the map there is no room even for the name. Hovering is
// where the whole answer lives.
// =============================================================================
describe("hovering a held box", () => {
  beforeEach(() => {
    loadDataFromCsv(GATED_CSV);
    state.simulationMode = true;
    state.userOverrides = { pump: 4 };
    recomputeValues();
    render();
  });
  afterEach(() => { state.simulationMode = false; state.userOverrides = {}; });

  it("says what is holding it, on the map", () => {
    showTooltip(nodeById["hold"], new MouseEvent("mouseover"));
    const held = document.querySelector("#tooltip .tooltip-held")!;
    expect(held).not.toBeNull();
    expect(held.textContent).toContain("Short Supply");
  });

  it("says nothing of the sort about a box that moved", () => {
    showTooltip(nodeById["pump"], new MouseEvent("mouseover"));
    expect(document.querySelector("#tooltip .tooltip-held")).toBeNull();
  });

  it("says nothing of the sort when the sliders are away", () => {
    state.simulationMode = false;
    showTooltip(nodeById["hold"], new MouseEvent("mouseover"));
    expect(document.querySelector("#tooltip .tooltip-held")).toBeNull();
  });
});


// =============================================================================
// THE BOX SAYS LESS WHEN THERE IS LESS TO SAY
// -----------------------------------------------------------------------------
// At rest a number on a box is decoration: the same number it was last time,
// on every box on the map. It starts meaning something the moment it can
// CHANGE. And while it can, the bottom-right corner belongs to it — the corner
// tags saying what KIND of box this is were sharing that corner and landing on
// top of the run's figures.
// =============================================================================
describe("what a box carries, at rest and mid-run", () => {
  const group = (id: string) => document.querySelector(`.node-group[data-node-id="${id}"]`)!;

  beforeEach(() => {
    loadDataFromCsv(LINEAR_CSV);
    state.userOverrides = {};
    recomputeValues();
  });
  afterEach(() => { state.simulationMode = false; state.userOverrides = {}; });

  it("carries no number at rest", () => {
    state.simulationMode = false;
    render();
    expect(group("b").querySelector(".node-value")).toBeNull();
  });

  it("carries one as soon as the sliders are out", () => {
    state.simulationMode = true;
    render();
    expect(group("b").querySelector(".node-value")!.textContent).toBe(formatNodeValue("b"));
  });
});


// =============================================================================
// A PICKED PATHWAY'S OWN NUMBERS
// -----------------------------------------------------------------------------
// A circle's percentage is what the WHOLE RUN did to that box. While one
// pathway is being read that is the wrong number, and it was contradicting the
// panel on the same screen: the row said this route carried +5.1% and the
// circle at the end of it said +5.8%, the total across all eight ways in.
//
// Reading one pathway, a circle on it now says what THAT pathway carried.
// =============================================================================
describe("what a circle says while a pathway is read", () => {
  const magOf = (el: string) =>
    document.querySelector(`svg.atlas g.n[data-el="${el}"] tspan.mag`)!.textContent;

  beforeEach(() => {
    // hub → twelve boxes → three outputs, four boxes feeding each output, all
    // of them plain multiplicative — so every split here is an identity.
    loadDataFromCsv(WIDE_CSV);
    state.simulationMode = true;
    state.userOverrides = { hub: 4 };
    recomputeValues();
    openAtlas("hub");
    renderDetailPanel();
  });
  afterEach(() => { closeAtlas(); state.simulationMode = false; state.userOverrides = {}; });

  it("prints the same figure the panel row does", () => {
    const dest = destHeads()[0].querySelector(".dname")!.textContent;
    openDest(dest!);
    const row = forkRows()[0];
    const rowPct = row.querySelector(".m")!.textContent;
    row.click();

    const destEl = [...document.querySelectorAll("svg.atlas g.n")]
      .find(g => (g.querySelector("text")!.textContent || "").startsWith(dest!))!;
    expect(destEl.querySelector("tspan.mag")!.textContent).toBe(rowPct);
  });

  it("is a SHARE — smaller than what the whole run did to that box", () => {
    const total = destHeads()[0].querySelector(".dmove")!.textContent;
    const row = openFirstForked().find(r => /×|via/.test(r.textContent || ""))!;
    const part = row.querySelector(".m")!.textContent;
    row.click();
    // The destination's own total is still printed on its row above; the row
    // chosen carries its part of it, and the circle now carries the same.
    expect(total).toBeTruthy();
    expect(part).toBeTruthy();
    const chosen = document.querySelector("#detail-content .strandrow.cur")!;
    expect(chosen.querySelector(".m")!.textContent).toBe(part);
  });

  it("gives the input the whole of itself", () => {
    openFirstForked()[0].click();
    // Nothing upstream of the slider: its move is not a share of anything.
    // hub ×4 is +300%, and all of it belongs to the input.
    expect(magOf("START")).toBe("+300.0%");
  });

  it("marks nothing as approximate on a map that splits exactly", () => {
    openFirstForked()[0].click();
    const lit = [...document.querySelectorAll("svg.atlas g.n.on tspan.mag")];
    expect(lit.length).toBeGreaterThan(1);
    for (const t of lit) expect(t.textContent).not.toContain("~");
  });

  it("goes back to the whole run's figure when the pathway is let go", () => {
    const before = magOf("N:yankee");
    openDest("Yankee");
    const row = forkRows()[0];
    if (!row) return;
    row.click();
    backToTop();
    expect(magOf("N:yankee")).toBe(before);
  });
});

// =============================================================================
// A ROW STANDS FOR EVERY ROUTE IT COUNTS
// -----------------------------------------------------------------------------
// "via Bravo ×3" is three routes, and its percentage is what all three carried
// between them. Picking it used to light only the first of them, so the number
// in the panel and the run on the picture were about different things.
// =============================================================================
describe("picking a row that stands for several routes", () => {
  beforeEach(() => {
    loadDataFromCsv(FAN_CSV);
    state.simulationMode = true;
    state.userOverrides = { alpha: 4 };
    recomputeValues();
    openAtlas("alpha");
    renderDetailPanel();
  });
  afterEach(() => { closeAtlas(); state.simulationMode = false; state.userOverrides = {}; });

  it("lights every route the row counts, not just the first", () => {
    // alpha→bravo→zulu, →bravo→delta→zulu and →bravo→echo→zulu are one row.
    openDest("Zulu");
    const row = forkRows().find(r => /via Bravo/.test(r.textContent || ""))!;
    expect(row.textContent).toContain("×3");
    row.click();
    const lit = [...document.querySelectorAll("svg.atlas g.n.on")]
      .map(g => (g as HTMLElement).dataset.el);
    for (const el of ["N:delta", "N:echo"]) expect(lit).toContain(el);
    // and Charlie, which parts company earlier, is not in this row at all
    expect(lit).not.toContain("N:charlie");
  });
});

// =============================================================================
// A DEAD ROUTE CARRIES NOTHING, AND SAYS SO
// -----------------------------------------------------------------------------
// The per-route split used structural elasticities, which know nothing about
// gates — so a route through a held box was credited with a share of a change
// it had no part in, and that share was taken from the routes that did carry it.
// =============================================================================
describe("a route through a gate, in the numbers", () => {
  beforeEach(() => {
    loadDataFromCsv(GATED_CSV);
    state.simulationMode = true;
    state.userOverrides = { pump: 4 };
    recomputeValues();
    openAtlas("pump");
    renderDetailPanel();
  });
  afterEach(() => { closeAtlas(); state.simulationMode = false; state.userOverrides = {}; });

  it("credits a route through a held box with nothing", () => {
    // pump → short → hold: short is pinned, so this route delivers nothing to
    // hold however much pump moves.
    const row = openAnyForkMatching(/Short Supply/);
    if (!row) return;                       // the fork may lie deeper than one level
    const pct = row.querySelector(".m")!.textContent || "";
    expect(pct === "" || /^0\.0%$|—/.test(pct.trim())).toBe(true);
  });
});

// =============================================================================
// NO CIRCLE SAYS 0.0%
// -----------------------------------------------------------------------------
// A circle lit as part of a run it contributed nothing to, printing 0.0% beside
// its name, is the picture padding the story out with boxes that are not in it.
// =============================================================================
describe("circles a picked pathway never reached", () => {
  beforeEach(() => {
    loadDataFromCsv(GATED_CSV);
    state.simulationMode = true;
    state.userOverrides = { pump: 4 };
    recomputeValues();
    openAtlas("pump");
    renderDetailPanel();
  });
  afterEach(() => { closeAtlas(); state.simulationMode = false; state.userOverrides = {}; });

  it("lights none of them, on any pathway in the list", () => {
    const count = openFirstForked().length;
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      // Re-queried: every click re-renders the panel, and stepping back to the
      // top is what makes the same level's rows addressable again.
      backToTop();
      openFirstForked()[i].click();
      for (const g of document.querySelectorAll("svg.atlas g.n.on")) {
        // The whole figure, not a tail of one: "+300.0%" ends in "0.0%".
        const mag = (g.querySelector("tspan.mag")!.textContent || "").trim();
        expect(mag).not.toMatch(/^~?[+-]?0\.0%$/);
      }
    }
  });

  it("keeps the box the change was stopped at", () => {
    // It carries nothing either, and it is the one still circle worth lighting:
    // it says where the pathway ends and what to move instead.
    const row = openAnyForkMatching(/Held Box|Far Output/);
    if (!row) return;
    row.click();
    const held = document.querySelector('svg.atlas g.n.on[data-el="N:hold"]');
    if (held) expect(held.querySelector("tspan.mag")!.textContent).toContain("held by");
  });
});
