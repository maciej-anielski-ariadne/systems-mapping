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
  state: () => { view: string; open: string | null; atlas: any };
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

beforeAll(async () => {
  document.body.innerHTML = body.replace(/<script>[\s\S]*?<\/script>/, "");
  page = new Function(
    script + "\nreturn { loadMap, state: () => ({ view: VIEW, open: OPEN_LOOP, atlas: ATLAS }) };",
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

  it("shows the loops of that tangle, and only those", () => {
    const t = page.state().atlas.loops[0].tangles[0];
    const cards = document.querySelectorAll(".loopdrawer .loopcard");
    expect(cards).toHaveLength(t.loops.length);
    expect(drawer()!.textContent).toContain(`${t.boxes.length} boxes`);
    // A → B → C → A has one negative link, so it settles rather than runs away.
    expect(drawer()!.textContent).toContain("0R / 1B");
  });

  it("brings the ribbons into and out of the tangle forward", () => {
    const hot = document.querySelectorAll("#stage .flow .link.hot");
    expect(hot.length).toBeGreaterThan(0);
    expect(hot.length).toBeLessThan(document.querySelectorAll("#stage .flow .link").length);
  });

  it("keeps the picture the same shape while it is open", () => {
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

  it("re-sorts inside the drawer without closing it", () => {
    flowBlocks()[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    document.querySelector('.loopdrawer [data-loopsort="length"]')!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(drawer()).not.toBeNull();
    expect(page.state().open).not.toBeNull();
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
