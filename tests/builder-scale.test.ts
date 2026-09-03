// =============================================================================
// BUILDER WIZARD AT SCALE — row virtualization, lazy dropdowns, history budget
// -----------------------------------------------------------------------------
// The wizard's tables used to put every row in the DOM and upgrade every
// <select> in the overlay on every render. On a real map that is O(links ×
// boxes) elements on the Links step alone, which hangs the tab. These tests pin
// the three mechanisms that fixed it, plus the two invariants they could
// plausibly break:
//
//   • only a window of rows is rendered, but the DATA is still whole — bulk
//     select-all, sorting, and keyboard navigation all address rows by their
//     data index, not by what happens to be on screen;
//   • a <select> becomes a typable dropdown on first focus rather than at
//     render time;
//   • undo history is capped by retained characters as well as by entry count,
//     so a 50-deep stack of whole-map snapshots can't pin hundreds of MB.
// =============================================================================
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EDGES, NODES, setEdges, setNodes, state } from "../assets/js/03-state";
import { upgradeSelectsLazilyIn, POPUP_MAX_RENDERED } from "../assets/js/04b-typeable-dropdown";
import {
  BUILDER_ROW_FIELDS,
  closeBuilder,
  invalidateBuilderCaches,
  openBuilder,
  sortedBuilderIndices,
  validateBuilder,
  withBuilderValidationMemo,
} from "../assets/js/16a-builder-state";
import {
  BUILDER_VIRTUAL_MIN_ROWS,
  BUILDER_VIRTUAL_WINDOW,
  builderVirtualState,
  renderBuilder,
} from "../assets/js/16b-builder-render";
import {
  _shouldDiffUndo,
  clearHistory,
  historyCharCount,
  HISTORY_CAP,
  HISTORY_CHAR_BUDGET,
  pushHistorySnapshot,
  UNDO_DIFF_MAX_ELEMENTS,
} from "../assets/js/16g-canvas-undo";

const overlay = () => document.getElementById("builder-overlay")!;

// Every <tr> the step's table actually put in the DOM, spacers included.
const domRows = () =>
  overlay().querySelectorAll("table.builder-table tbody tr");

// Just the real rows — spacers stand in for the un-rendered ones.
const realRows = () =>
  overlay().querySelectorAll("table.builder-table tbody tr:not(.builder-virtual-spacer)");

const cell = (section: string, field: string, index: number) =>
  overlay().querySelector(
    '[data-section="' + section + '"][data-field="' + field + '"][data-index="' + index + '"]',
  ) as HTMLInputElement | null;

// Seed the wizard with a taxonomy plus `nodeCount` boxes and `edgeCount` links,
// then paint `step`. Bypasses the CSV round-trip so the sizes stay cheap to set
// up — the wizard only ever reads state.builder.
function seedBuilder(nodeCount: number, edgeCount: number, step: number): void {
  openBuilder();
  state.builder.streams    = [{ id: "ops", label: "Operations", short: "OPS", color: "#60a5fa" }];
  state.builder.stages     = [{ id: "s1", label: "Stage 1" }];
  state.builder.categories = [{ id: "c1", label: "General", color: "#a3a3a3", textColor: "#111111", class: "primary" }];
  state.builder.nodes = Array.from({ length: nodeCount }, (_, i) => ({
    id: "n" + i, label: "Node " + i, description: "", stream: "ops", stage: "s1",
    category: "c1", categoryIds: ["c1"], baseline: "", unit: "",
    controllable: false, direction: "", sliderMax: "",
    combine: "", formula: "", minValue: "", maxValue: "",
  }));
  state.builder.edges = Array.from({ length: edgeCount }, (_, i) => ({
    from: "n" + (i % nodeCount),
    to: "n" + ((i + 1) % nodeCount),
    effect: "increases",
    elasticity: "",
    style: "",
    description: "link " + i,
  }));
  state.builder.step = step;
  renderBuilder();
}

afterEach(() => {
  closeBuilder();
  clearHistory();
});

// ───── U3: row virtualization ─────────────────────────────────────────────
describe("builder row virtualization", () => {
  it("renders a window of rows for a 1000-link step, not one per link", () => {
    seedBuilder(200, 1000, 5);

    // The whole point: a few dozen rows in the DOM instead of 1000.
    expect(realRows().length).toBeLessThan(300);
    expect(realRows().length).toBe(BUILDER_VIRTUAL_WINDOW);
    // Plus one spacer below standing in for the rows we skipped (none above —
    // we're at the top of the list).
    expect(domRows().length).toBe(BUILDER_VIRTUAL_WINDOW + 1);
    expect(builderVirtualState()).toEqual({
      section: "edges", start: 0, total: 1000, window: BUILDER_VIRTUAL_WINDOW,
    });

    // Each link row used to emit two <select>s holding one <option> per box —
    // 1000 × 2 × 200 = 400k option elements. The window caps that too.
    expect(overlay().querySelectorAll("option").length).toBeLessThan(200 * 2 * 300);
  });

  it("select-all applies to the DATA, not to the rendered rows", () => {
    seedBuilder(30, 1000, 5);
    expect(realRows().length).toBeLessThan(1000);

    (overlay().querySelector('[data-selectall="edges"]') as HTMLElement).click();
    expect(state.builder.selected.size).toBe(1000);

    // …and bulk delete then clears the whole data set, not just what was drawn.
    (overlay().querySelector('[data-bulkdelete="edges"]') as HTMLElement).click();
    expect(state.builder.edges.length).toBe(0);
  });

  it("keeps data-index pointing at the data row, never at a window position", () => {
    seedBuilder(30, 1000, 5);
    const first = realRows()[0];
    const last  = realRows()[realRows().length - 1];
    expect(first.getAttribute("data-index")).toBe("0");
    expect(last.getAttribute("data-index")).toBe(String(BUILDER_VIRTUAL_WINDOW - 1));
    // Row 900 exists in the data but not in the DOM.
    expect(state.builder.edges[900]).toBeTruthy();
    expect(cell("edges", "description", 900)).toBe(null);
  });

  it("slices the SORTED order, so the window shows the sorted top of the table", () => {
    seedBuilder(30, 1000, 5);
    (overlay().querySelector('[data-sort="edges"][data-sortkey="description"]') as HTMLElement).click();
    expect(state.builder.sort.edges).toEqual({ key: "description", dir: "asc" });

    const order = sortedBuilderIndices("edges");
    const shown = Array.from(realRows()).map((tr) => Number(tr.getAttribute("data-index")));
    expect(shown).toEqual(order.slice(0, BUILDER_VIRTUAL_WINDOW));
    // Sorting is view-only — the underlying array order is untouched.
    expect(state.builder.edges[0].description).toBe("link 0");
  });

  it("leaves a small table exactly as it was — every row, no spacers", () => {
    const small = BUILDER_VIRTUAL_MIN_ROWS - 1;
    seedBuilder(20, small, 5);
    expect(builderVirtualState()).toBe(null);
    expect(realRows().length).toBe(small);
    expect(overlay().querySelectorAll(".builder-virtual-spacer").length).toBe(0);
    expect(cell("edges", "description", small - 1)).toBeTruthy();
  });

  it("Tab out of the last rendered row materializes the next one", () => {
    seedBuilder(30, 1000, 5);
    const lastVisible = BUILDER_VIRTUAL_WINDOW - 1;
    const desc = cell("edges", "description", lastVisible)!;   // last field of the row
    desc.focus();
    desc.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));

    // The row below was not in the DOM a moment ago; navigation brought it in
    // and landed on its first field.
    const landed = document.activeElement as HTMLElement;
    expect(cell("edges", "from", BUILDER_VIRTUAL_WINDOW)).toBeTruthy();
    expect(landed.closest("tr")!.getAttribute("data-index")).toBe(String(BUILDER_VIRTUAL_WINDOW));
    // Still 1000 links — navigating past the window must not append a row.
    expect(state.builder.edges.length).toBe(1000);
  });

  it("Enter steps down a column into a row outside the window", () => {
    seedBuilder(30, 1000, 5);
    const lastVisible = BUILDER_VIRTUAL_WINDOW - 1;
    const desc = cell("edges", "description", lastVisible)!;
    desc.focus();
    desc.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    const landed = document.activeElement as HTMLElement;
    expect(landed.getAttribute("data-field")).toBe("description");
    expect(landed.getAttribute("data-index")).toBe(String(BUILDER_VIRTUAL_WINDOW));
    expect(state.builder.edges.length).toBe(1000);
  });

  it("still appends a row when Tab really does run off the end of the data", () => {
    seedBuilder(20, 3, 5);
    const desc = cell("edges", "description", 2)!;
    desc.focus();
    desc.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(state.builder.edges.length).toBe(4);
  });

  it("virtualizes the Boxes step too — 17 inputs a row is the other bad case", () => {
    seedBuilder(1000, 0, 4);
    expect(realRows().length).toBe(BUILDER_VIRTUAL_WINDOW);
    expect(builderVirtualState()!.total).toBe(1000);
    expect(cell("nodes", "id", 0)).toBeTruthy();
    expect(cell("nodes", "id", 500)).toBe(null);
  });
});

describe("builder lifecycle memory", () => {
  it("releases detached map copies when the builder closes", () => {
    seedBuilder(4_000, 10_000, 5);
    expect(state.builder.nodes).toHaveLength(4_000);
    expect(state.builder.edges).toHaveLength(10_000);

    closeBuilder();

    expect(state.builder.open).toBe(false);
    expect(state.builder.nodes).toEqual([]);
    expect(state.builder.edges).toEqual([]);
    expect(state.builder.params).toEqual([]);
  });
});

// The keyboard now walks BUILDER_ROW_FIELDS instead of the live DOM, so the two
// have to agree — a column added to a step renderer without a matching entry
// would silently become unreachable by Tab.
describe("BUILDER_ROW_FIELDS matches what each step renders", () => {
  const steps: Array<[string, number]> = [
    ["streams", 1], ["stages", 2], ["categories", 3],
    ["nodes", 4], ["edges", 5], ["params", 6],
  ];

  for (const [section, step] of steps) {
    it("lists " + section + " fields in rendered column order", () => {
      seedBuilder(3, 3, step);
      if (section === "params") {
        state.builder.params = [{ id: "k", value: 1, description: "d" }];
        renderBuilder();
      }
      const row = overlay().querySelector("table.builder-table tbody tr")!;
      const rendered = Array.from(row.querySelectorAll("[data-section][data-field]"))
        .map((el) => el.getAttribute("data-field"));
      expect(rendered).toEqual(BUILDER_ROW_FIELDS[section]);
    });
  }
});

// ───── U4: lazy typeable-dropdown upgrade ─────────────────────────────────
describe("typeable dropdowns upgrade on first focus", () => {
  it("leaves a rendered step's cell selects as plain <select> until focused", () => {
    seedBuilder(20, 5, 5);
    const from = cell("edges", "from", 0)!;
    expect(from.tagName).toBe("SELECT");
    expect(from.classList.contains("typeable-dropdown-native")).toBe(false);
    expect(from.closest(".typeable-dropdown")).toBe(null);
  });

  it("upgrades just that select on focusin, and hands it the focus", () => {
    seedBuilder(20, 5, 5);
    const from = cell("edges", "from", 0)!;
    const other = cell("edges", "to", 0)!;

    from.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    // The focused cell became a typable dropdown…
    expect(from.classList.contains("typeable-dropdown-native")).toBe(true);
    const wrap = from.closest(".typeable-dropdown")!;
    const input = wrap.querySelector(".typeable-dropdown-input") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(document.activeElement).toBe(input);
    // …and reads back the value it is standing in for.
    expect(from.value).toBe(state.builder.edges[0].from);

    // …while its neighbours were left alone.
    expect(other.classList.contains("typeable-dropdown-native")).toBe(false);
  });

  it("emits only the selected option up front, and fills the list on focus", () => {
    seedBuilder(300, 5, 5);
    const from = cell("edges", "from", 0)!;
    // At rest the cell is a <select> holding the blank placeholder plus the one
    // box it points at — not one <option> per box in the map.
    expect(from.querySelectorAll("option").length).toBe(2);
    expect(from.value).toBe(state.builder.edges[0].from);
    const sel = from as unknown as HTMLSelectElement;
    expect(sel.options[sel.selectedIndex].text).toBe(
      state.builder.edges[0].from + " — Node " + state.builder.edges[0].from.slice(1),
    );

    from.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    // Opened: the full list is there, the value survived, and the marker is
    // cleared so the expansion happens once.
    expect(from.querySelectorAll("option").length).toBe(301);
    expect(from.value).toBe(state.builder.edges[0].from);
    expect(from.hasAttribute("data-options")).toBe(false);
  });

  it("leaves a link pointing at a deleted box showing blank, as it always did", () => {
    seedBuilder(10, 3, 5);
    state.builder.edges[0].from = "gone";
    renderBuilder();
    const from = cell("edges", "from", 0)!;
    expect(from.value).toBe("");
    expect(from.classList.contains("invalid")).toBe(true);
  });

  it("keeps the bulk bar's selects upgraded eagerly (they are always on screen)", () => {
    seedBuilder(20, 5, 5);
    (overlay().querySelector('[data-selectall="edges"]') as HTMLElement).click();
    const bulk = overlay().querySelector('select[data-bulkfield="effect"]')!;
    expect(bulk.classList.contains("typeable-dropdown-native")).toBe(true);
  });

  it("upgradeSelectsLazilyIn is idempotent and only touches real selects", () => {
    const host = document.createElement("div");
    host.innerHTML = '<select id="a"><option value="x">x</option></select><input id="b" />';
    document.body.appendChild(host);
    upgradeSelectsLazilyIn(host);
    upgradeSelectsLazilyIn(host);   // second call must not double-bind

    const input = host.querySelector("#b") as HTMLInputElement;
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(host.querySelectorAll(".typeable-dropdown").length).toBe(0);

    const select = host.querySelector("#a") as HTMLSelectElement;
    select.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(host.querySelectorAll(".typeable-dropdown").length).toBe(1);
    host.remove();
  });

  it("caps the popup body and says how many matches it left out", () => {
    const host = document.createElement("div");
    const total = POPUP_MAX_RENDERED + 57;
    host.innerHTML =
      "<select>" +
      Array.from({ length: total }, (_, i) => '<option value="o' + i + '">option ' + i + "</option>").join("") +
      "</select>";
    document.body.appendChild(host);
    upgradeSelectsLazilyIn(host);
    (host.querySelector("select") as HTMLSelectElement)
      .dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    const input = host.querySelector(".typeable-dropdown-input") as HTMLInputElement;
    const popupIdentifier = input.getAttribute("aria-controls")!;
    const popup = document.getElementById(popupIdentifier)!;
    expect(popup.querySelectorAll(".typeable-dropdown-item").length).toBe(POPUP_MAX_RENDERED);
    const more = popup.querySelector(".typeable-dropdown-more")!;
    expect(more.textContent).toBe(total - POPUP_MAX_RENDERED + " more — keep typing to narrow");

    // Typing narrows the list back under the cap, and the notice goes away.
    input.value = "option 12";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(popup.querySelectorAll(".typeable-dropdown-item").length).toBeLessThan(POPUP_MAX_RENDERED);
    expect(popup.querySelector(".typeable-dropdown-more")).toBe(null);
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    host.remove();
  });
});

// ───── U1: undo-history size budget ───────────────────────────────────────
describe("undo history size budget", () => {
  beforeEach(() => {
    clearHistory();
    state.dataLoaded = true;
  });

  it("keeps the full entry depth while the snapshots are small", () => {
    for (let i = 0; i < HISTORY_CAP + 10; i++) pushHistorySnapshot("csv " + i);
    expect(state.history.past.length).toBe(HISTORY_CAP);
    // Oldest went first — the newest HISTORY_CAP entries survive.
    expect(state.history.past[0]).toBe("csv 10");
    expect(historyCharCount()).toBeLessThanOrEqual(HISTORY_CHAR_BUDGET);
  });

  it("evicts oldest snapshots so the total stays inside the character budget", () => {
    // Snapshots big enough that far fewer than HISTORY_CAP of them fit.
    const snapshotChars = Math.floor(HISTORY_CHAR_BUDGET / 6);
    const fits = Math.floor(HISTORY_CHAR_BUDGET / snapshotChars);
    for (let i = 0; i < 20; i++) {
      pushHistorySnapshot(String(i).padEnd(snapshotChars, "x"));
    }
    expect(historyCharCount()).toBeLessThanOrEqual(HISTORY_CHAR_BUDGET);
    expect(state.history.past.length).toBeLessThanOrEqual(fits);
    expect(state.history.past.length).toBeGreaterThan(0);
    // The entries that survived are the most recent ones.
    expect(state.history.past[state.history.past.length - 1].startsWith("19")).toBe(true);
  });

  it("charges the budget across past AND future together", () => {
    const snapshotChars = Math.floor(HISTORY_CHAR_BUDGET / 4);
    for (let i = 0; i < 3; i++) pushHistorySnapshot(String(i).padEnd(snapshotChars, "x"));
    // Simulate undos having moved entries onto the redo stack.
    state.history.future.push("f0".padEnd(snapshotChars, "y"));
    state.history.future.push("f1".padEnd(snapshotChars, "y"));
    pushHistorySnapshot("z".padEnd(snapshotChars, "x"));
    // A fresh edit drops the redo branch outright, and the rest fits.
    expect(state.history.future.length).toBe(0);
    expect(historyCharCount()).toBeLessThanOrEqual(HISTORY_CHAR_BUDGET);
  });

  it("never evicts the only entry, however big it is", () => {
    pushHistorySnapshot("x".repeat(HISTORY_CHAR_BUDGET * 2));
    expect(state.history.past.length).toBe(1);
  });

  it("ignores an empty snapshot rather than stacking a useless entry", () => {
    pushHistorySnapshot("");
    pushHistorySnapshot(null);
    pushHistorySnapshot(undefined);
    expect(state.history.past.length).toBe(0);
  });
});

// ───── U2: the undo flash diff is gated by map size ───────────────────────
// _snapshotSignatures JSON.stringifies every node and every edge, and a restore
// runs it twice — purely to choose which elements pulse for 1.4 seconds. Past
// the threshold that costs more than the reload it decorates, so the diff is
// skipped outright and the map visibly changing IS the feedback.
describe("undo flash diffing is skipped on a large map", () => {
  const fakeNodes = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: "n" + i, label: "N" + i, stream: "s", stage: "t" }));

  afterEach(() => {
    setNodes([]);
    setEdges([]);
  });

  it("diffs a map at the threshold", () => {
    setNodes(fakeNodes(UNDO_DIFF_MAX_ELEMENTS) as never);
    setEdges([]);
    expect(NODES.length + EDGES.length).toBe(UNDO_DIFF_MAX_ELEMENTS);
    expect(_shouldDiffUndo()).toBe(true);
  });

  it("stops diffing one element past it", () => {
    setNodes(fakeNodes(UNDO_DIFF_MAX_ELEMENTS + 1) as never);
    expect(_shouldDiffUndo()).toBe(false);
  });

  it("counts nodes and edges together, not each on its own", () => {
    const half = Math.floor(UNDO_DIFF_MAX_ELEMENTS / 2);
    setNodes(fakeNodes(half) as never);
    setEdges(Array.from({ length: half + 1 }, (_, i) => ({ id: "e" + i, from: "n0", to: "n1" })) as never);
    expect(_shouldDiffUndo()).toBe(false);
  });
});

// ───── U5: per-render-pass memoization ────────────────────────────────────
describe("wizard validation and sort order are computed once per render pass", () => {
  beforeEach(() => {
    seedBuilder(5, 5, 4);
  });

  it("hands every caller inside one pass the same validation result", () => {
    withBuilderValidationMemo(() => {
      expect(validateBuilder()).toBe(validateBuilder());
    });
  });

  it("drops the memo the moment the pass ends", () => {
    let inside: unknown;
    withBuilderValidationMemo(() => { inside = validateBuilder(); });
    expect(validateBuilder()).not.toBe(inside);
  });

  it("never serves a result from an earlier pass, so edits still show up", () => {
    const before = withBuilderValidationMemo(() => validateBuilder().errors.length);
    state.builder.nodes[0].id = "";        // now missing a required id
    const after = withBuilderValidationMemo(() => validateBuilder().errors.length);
    expect(after).toBeGreaterThan(before);
  });

  it("reuses one sorted order until something invalidates it", () => {
    state.builder.sort.nodes = { key: "label", dir: "asc" };
    invalidateBuilderCaches();
    const first = sortedBuilderIndices("nodes");
    expect(sortedBuilderIndices("nodes")).toBe(first);   // same array, no re-sort

    invalidateBuilderCaches();
    expect(sortedBuilderIndices("nodes")).not.toBe(first);
    expect(sortedBuilderIndices("nodes")).toEqual(first); // …but the same answer
  });

  it("re-sorts after a field write changes where a row belongs", () => {
    state.builder.sort.nodes = { key: "label", dir: "asc" };
    invalidateBuilderCaches();
    const before = sortedBuilderIndices("nodes").slice();

    // The cell handler bumps the revision; do the same here.
    state.builder.nodes[4].label = "AAA first";
    invalidateBuilderCaches();
    expect(sortedBuilderIndices("nodes")[0]).toBe(4);
    expect(sortedBuilderIndices("nodes")).not.toEqual(before);
  });
});

describe("wizard canonical input validation", () => {
  beforeEach(() => {
    seedBuilder(1, 0, 4);
  });

  it("rejects unsafe identifiers and colours without rewriting them", () => {
    state.builder.streams[0].id = 'ops" onload="alert(1)';
    state.builder.streams[0].color = "url(javascript:alert(1))";
    state.builder.nodes[0].id = "constructor";

    const validation = validateBuilder();
    expect(validation.invalidIdentifiers).toEqual(new Set([
      'ops" onload="alert(1)',
      "constructor",
    ]));
    expect(validation.errors.join(" ")).toMatch(/literal hexadecimal colour/);
    expect(state.builder.streams[0].id).toBe('ops" onload="alert(1)');
  });

  it("rejects boundary whitespace in builder identities without trimming it", () => {
    state.builder.streams[0].id = " ops ";

    const validation = validateBuilder();

    expect(validation.invalidIdentifiers).toContain(" ops ");
    expect(validation.errors.join(" ")).toMatch(/will not be rewritten/i);
    expect(state.builder.streams[0].id).toBe(" ops ");
  });

  it("shares strict finite and domain numeric rules with import", () => {
    state.builder.nodes[0].baseline = "12xyz";
    state.builder.nodes[0].sliderMax = 0.5;
    state.builder.nodes[0].minValue = 10;
    state.builder.nodes[0].maxValue = 5;

    const messages = validateBuilder().errors.join(" ");
    expect(messages).toMatch(/starting value.*not a finite decimal/i);
    expect(messages).toMatch(/slider max below 1/i);
    expect(messages).toMatch(/minimum above its maximum/i);
  });
});
