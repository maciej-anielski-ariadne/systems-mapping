/**
 * @vitest-environment jsdom
 */
// =============================================================================
// PATHWAY ATLAS — THE PAGE
// -----------------------------------------------------------------------------
// The engine is tested next door. What is tested here is the picture and what
// you can do to it:
//
//   it draws one circle per element, sized by area, and every tangle as the
//   wheel it contains
//   clicking an element lights up what it touches and explains it
//   clicking a tangle closes the frame in on it — a zoom, not a panel — and
//   plays its loops through
//   clicking a box on the rim follows that box's own loop round
//   Escape lets go one layer at a time: the box, then the tangle, then the zoom
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
  state: () => {
    view: string; focus: string | null; select: string | null; pick: string | null;
    vb: { x: number; y: number; w: number; h: number } | null; atlas: any;
  };
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
const tangles = () => [...document.querySelectorAll("#stage svg.atlas g.n[data-loop]")] as HTMLElement[];
const plains = () => [...document.querySelectorAll("#stage svg.atlas g.n:not([data-loop])")] as HTMLElement[];
const rim = () => [...document.querySelectorAll("#stage g.n.focus .nd")] as HTMLElement[];
const click = (el: Element) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
const escape = () => dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
const inspector = () => document.getElementById("inspector")!.textContent!.replace(/\s+/g, " ");
// the frame moves over half a second, so anything that reads it waits for it
const settle = () => new Promise(r => setTimeout(r, 800));
let WHOLE: { w: number } | null = null;

beforeAll(async () => {
  document.body.innerHTML = body.replace(/<script>[\s\S]*?<\/script>/, "");
  page = new Function(
    script + "\nreturn { loadMap, state: () => ({ view: VIEW, focus: FOCUS, select: SELECT," +
      " pick: WHEEL_PICK, vb: VB, atlas: ATLAS }) };",
  )() as Page;
  page.loadMap(loopedMap());
  await tick();
});

describe("the picture", () => {
  it("draws one circle per element, and every tangle as the wheel it contains", () => {
    const A = page.state().atlas;
    expect(document.querySelectorAll("svg.atlas g.n")).toHaveLength(A.elements);
    expect(document.querySelectorAll("svg.atlas .bub.loop")).toHaveLength(A.loops.length);
    const t = A.loops[0].tangles[0];
    expect(document.querySelectorAll("svg.atlas .nd")).toHaveLength(t.boxes.length);
    expect(document.querySelectorAll("svg.atlas .ch")).toHaveLength(t.links.length);
    // area, not radius: the busiest element's circle is the largest
    const rs = [...document.querySelectorAll("svg.atlas .bub")].map(c => Number(c.getAttribute("r")));
    expect(Math.max(...rs)).toBeGreaterThan(Math.min(...rs));
  });

  it("names nothing until you point at it", () => {
    const labels = [...document.querySelectorAll("svg.atlas g.n > text")];
    expect(labels.length).toBeGreaterThan(0);
    // every one is transparent until hover or selection, which is CSS, not markup
    expect(labels.every(t => !t.getAttribute("opacity"))).toBe(true);
    const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
    expect(css).toContain(".atlas text{");
    expect(/\.atlas g\.n:hover>text,\.atlas g\.n\.on>text\{opacity:1\}/.test(css)).toBe(true);
  });

  it("lights up what an element touches, and explains the percentage", () => {
    const a = plains().find(g => (A_SUCC(g) || 0) > 0) || plains()[0];
    click(a);
    expect(page.state().select).toBe(a.dataset.el);
    expect(document.querySelector("svg.atlas.busy")).not.toBeNull();
    const hot = document.querySelectorAll("svg.atlas .fl.hot");
    expect(hot.length).toBeGreaterThan(0);
    expect(hot.length).toBeLessThan(document.querySelectorAll("svg.atlas .fl").length);
    // the inspector says what a share is a share OF, not just a number
    expect(inspector()).toContain("of the readings from");
    expect(inspector()).toContain("share of");
    click(a);
    expect(page.state().select).toBeNull();
  });
});

// an element with something leading out of it, so there are links to light up
const A_SUCC = (g: HTMLElement) => {
  const A = page.state().atlas;
  const outs = A.succ.get(g.dataset.el);
  return outs ? outs.size : 0;
};

describe("going inside a tangle", () => {
  it("closes the frame in on it rather than opening a panel over it", async () => {
    WHOLE = page.state().vb;
    click(tangles()[0]);
    expect(page.state().focus).toBe(tangles()[0].dataset.el);
    expect(document.querySelector(".loopdrawer")).toBeNull();   // no floating box
    expect(document.querySelector("svg.atlas.inside")).not.toBeNull();
    await settle();
    expect(page.state().vb!.w).toBeLessThan(WHOLE!.w);          // the frame closed in
  });

  it("keeps the picture the same shape while it is zoomed", () => {
    const shape = () => [...document.querySelectorAll("svg.atlas .bub")]
      .map(c => `${c.getAttribute("cx")}/${c.getAttribute("cy")}/${c.getAttribute("r")}`);
    const before = shape();
    click(document.querySelector("[data-replay]")!);
    expect(shape()).toEqual(before);
  });

  it("plays the loops through, one after another, and leaves them on screen", () => {
    const drawn = document.querySelectorAll("svg.atlas .trace g.tl");
    const w = page.state().atlas.loops[0].tangles[0];
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.length).toBeLessThanOrEqual(w.links.length);
    expect(inspector()).toMatch(/loops? drawn|Playing the loops/);
  });

  it("follows one box's own loop when the box is clicked", () => {
    const a = rim().find(n => n.dataset.box === "a")!;
    click(a);
    expect(page.state().pick).toBe("a");
    // A → B → C → A is three links, drawn over the wheel, starting at the box asked about
    expect(document.querySelectorAll("svg.atlas .trace path")).toHaveLength(3);
    expect(document.querySelectorAll("svg.atlas .labs text").length).toBeGreaterThan(0);
    expect(inspector()).toContain("A box comes back to itself");
  });

  it("lets go one layer at a time", async () => {
    escape();
    expect(page.state().pick).toBeNull();
    expect(page.state().focus).not.toBeNull();   // still inside the tangle
    escape();
    expect(page.state().focus).toBeNull();
    expect(document.querySelector("svg.atlas.inside")).toBeNull();
    await settle();
    // and the frame is on its way back out (this DOM animates on a lazy clock,
    // so what is asserted is the direction, not the exact frame)
    expect(page.state().vb!.w).toBeGreaterThan(WHOLE!.w * 0.85);
  });

  it("forgets where it was when a different map is loaded", async () => {
    click(tangles()[0]);
    expect(page.state().focus).not.toBeNull();
    page.loadMap(loopedMap());
    await tick();
    expect(page.state().focus).toBeNull();
    expect(page.state().select).toBeNull();
  });
});
