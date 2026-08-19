/**
 * @vitest-environment jsdom
 */
// =============================================================================
// PATHWAY ATLAS — THE PAGE
// -----------------------------------------------------------------------------
// The engine is tested next door. What is tested here is the one thing you can
// do to the picture: open a feedback tangle where it stands. That interaction
// has a contract worth pinning —
//
//   it opens in place      the drawer is anchored to its block, and the picture
//                          does not move or change shape underneath it
//   it closes              by its own control, by clicking the block again, and
//                          by Escape
//   it says what is real   the numbers in the drawer come from the same tangle
//                          the block stands for
//
// The page is run as a page: its markup is put into the document and its script
// evaluated against it, so this breaks if the wiring breaks.
// =============================================================================
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(resolve(root, "tools/pathway-atlas.html"), "utf8");
const body = /<body>([\s\S]*)<\/body>/.exec(html)![1];
const script = /<script>\n([\s\S]*?)<\/script>/.exec(html)![1];

type Page = {
  loadMap: (map: any) => void;
  state: () => { view: string; open: string | null; pick: string | null; atlas: any };
};
let page: Page;

// A map with one honest feedback loop in the middle of a run of boxes, plus a
// branch that goes nowhere near it — so the picture has a tangle to open,
// something either side of it, and a ribbon that should NOT come forward when
// it does.
function loopedMap() {
  const N = (id: string, label: string) =>
    ({ id, label, stream: "", category: "", controllable: false, direction: "" });
  const E = (from: string, to: string, elasticity = 0.3) =>
    ({ from, to, effect: elasticity < 0 ? "decreases" : "increases", elasticity });
  return {
    name: "looped",
    nodes: ["in", "a", "b", "c", "side", "out"].map(id => N(id, id.toUpperCase() + " box")),
    edges: [E("in", "a"), E("a", "b"), E("b", "c"), E("c", "a", -0.4), E("c", "out"),
            E("in", "side"), E("side", "out")],
  };
}

const tick = () => new Promise(r => setTimeout(r, 60));
const flowBlocks = () => [...document.querySelectorAll("#stage g.n[data-loop]")] as HTMLElement[];
const drawer = () => document.querySelector(".loopdrawer");
const ensureOpen = () => {
  if (!drawer()) flowBlocks()[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
};

beforeAll(async () => {
  document.body.innerHTML = body.replace(/<script>[\s\S]*?<\/script>/, "");
  page = new Function(
    script + "\nreturn { loadMap, state: () => " +
      "({ view: VIEW, open: OPEN_LOOP, pick: WHEEL_PICK, atlas: ATLAS }) };",
  )() as Page;
  page.loadMap(loopedMap());
  await tick();
});

describe("opening a tangle in the flow picture", () => {
  it("draws the tangle as one block that says it can be opened", () => {
    expect(page.state().atlas.loops).toHaveLength(1);
    const blocks = flowBlocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0].getAttribute("role")).toBe("button");
    expect(blocks[0].getAttribute("aria-expanded")).toBe("false");
    expect(drawer()).toBeNull();
  });

  it("opens beside the block, without leaving the flow view", () => {
    flowBlocks()[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(page.state().view).toBe("flow");
    const d = drawer()!;
    expect(d).not.toBeNull();
    // anchored: a leader line from the block, and a left edge past the block's
    const lead = document.querySelector("#stage .flow .lead");
    expect(lead).not.toBeNull();
    expect(parseFloat((d as HTMLElement).style.left)).toBeGreaterThan(0);
    expect(document.querySelector("#stage .flow.opened")).not.toBeNull();
    expect(flowBlocks()[0].getAttribute("aria-expanded")).toBe("true");
  });

  it("draws that tangle as a wheel — every box on the rim, every link a chord", () => {
    const t = page.state().atlas.loops[0].tangles[0];
    expect(document.querySelectorAll(".loopdrawer svg.wheel .nd")).toHaveLength(t.boxes.length);
    expect(document.querySelectorAll(".loopdrawer svg.wheel .ch")).toHaveLength(t.links.length);
    // The back chords are the feedback: cut those and the tangle is a sequence.
    const back = [...document.querySelectorAll(".loopdrawer svg.wheel .ch:not(.fw)")];
    expect(back.length).toBeGreaterThan(0);
    expect(back.length).toBeLessThan(t.links.length);
    expect(drawer()!.textContent).toContain(`${t.boxes.length} boxes`);
    // A → B → C → A has one negative link, so it settles rather than runs away.
    expect(drawer()!.textContent).toContain("0R / 1B");
  });

  it("traces the loop through a box when the box is clicked", () => {
    const rim = [...document.querySelectorAll(".loopdrawer svg.wheel .nd")] as HTMLElement[];
    const a = rim.find(n => n.dataset.box === "a")!;
    a.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(page.state().pick).toBe("a");
    expect(document.querySelector("svg.wheel.picked")).not.toBeNull();
    // A → B → C → A is three links, so three chords are drawn over the wheel
    expect(document.querySelectorAll("svg.wheel .trace path")).toHaveLength(3);
    // and the story starts at the box that was asked about
    const cap = document.getElementById("wheel-cap")!;
    expect(cap.textContent).toContain("A box");
    expect(cap.querySelector(".chain")!.textContent!.trim().startsWith("A box")).toBe(true);
  });

  it("lets go of the box before it lets go of the tangle", () => {
    dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(page.state().pick).toBeNull();
    expect(drawer()).not.toBeNull();          // still open on the tangle
    expect(document.querySelector("svg.wheel.picked")).toBeNull();
    dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(drawer()).toBeNull();
  });

  it("brings the ribbons into and out of the tangle forward", () => {
    ensureOpen();
    const hot = document.querySelectorAll("#stage .flow .link.hot");
    expect(hot.length).toBeGreaterThan(0);
    expect(hot.length).toBeLessThan(document.querySelectorAll("#stage .flow .link").length);
  });

  it("keeps the picture the same shape while it is open", () => {
    ensureOpen();
    const shape = (): string[] =>
      [...document.querySelectorAll("#stage .flow rect.node")].map(
        r => `${r.getAttribute("x")}/${r.getAttribute("y")}/${r.getAttribute("height")}`);
    const open = shape();
    document.querySelector("[data-closeloop]")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(drawer()).toBeNull();
    expect(shape()).toEqual(open);
  });

  it("closes on Escape, and on a second click of the same block", () => {
    flowBlocks()[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(drawer()).not.toBeNull();
    flowBlocks()[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(drawer()).toBeNull();

    flowBlocks()[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(drawer()).not.toBeNull();
    dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(drawer()).toBeNull();
  });

  it("opens from the keyboard as well as the mouse", () => {
    flowBlocks()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(drawer()).not.toBeNull();
    dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });

  it("picks a box from the list as well as from the rim, and keeps the drawer open", () => {
    flowBlocks()[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const sel = document.getElementById("wheel-pick") as HTMLSelectElement;
    sel.value = "b";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    expect(page.state().pick).toBe("b");
    expect(drawer()).not.toBeNull();
    expect(document.getElementById("wheel-cap")!.textContent).toContain("B box");
    dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });

  it("forgets what was open when a different map is loaded", async () => {
    flowBlocks()[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(page.state().open).not.toBeNull();
    page.loadMap(loopedMap());
    await tick();
    expect(page.state().open).toBeNull();
    expect(drawer()).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// THE CIRCLES PROTOTYPE
// -----------------------------------------------------------------------------
// A second drawing of the same atlas: area instead of height, so a tangle can be
// drawn as the wheel it opens into. What matters is that it is the SAME atlas —
// the same elements, the same tangle, the same panel — and that switching to it
// changes nothing but the picture.
// -----------------------------------------------------------------------------
describe("the circles view", () => {
  const show = (v: string) =>
    document.querySelector(`#views [data-v="${v}"]`)!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));

  it("draws one circle per element, sized by area, and keeps the tangle a tangle", () => {
    show("circles");
    const atlas = page.state().atlas;
    expect(document.querySelectorAll("svg.circ .bub")).toHaveLength(atlas.elements);
    expect(document.querySelectorAll("svg.circ .bub.loop")).toHaveLength(atlas.loops.length);
    // area, not radius: the biggest circle's r is the square root of its share
    const rs = [...document.querySelectorAll("svg.circ .bub")]
      .map(c => Number(c.getAttribute("r")));
    expect(Math.max(...rs)).toBeGreaterThan(Math.min(...rs));
  });

  it("opens the same wheel from the same click", () => {
    const loop = document.querySelector("svg.circ g.n[data-loop]")!;
    loop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.querySelector(".loopdrawer svg.wheel")).not.toBeNull();
    expect(page.state().view).toBe("circles");
    dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    show("flow");
  });
});
