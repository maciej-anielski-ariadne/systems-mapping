import { describe, it, expect, afterEach } from "vitest";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import {
  render,
  maybeRenderForViewport,
  VIRTUALIZE_MIN_NODES,
  CULL_MARGIN,
  computeCullRect,
} from "../assets/js/11-rendering";
import { NODES } from "../assets/js/03-state";

// Run any render() scheduled via requestAnimationFrame (scheduleRender).
function flushFrame(): Promise<void> {
  return new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res())));
}

// Build a CSV with `n` nodes spread across many stages in one stream, so the
// map is far wider/taller than any small viewport.
function bigCsv(n: number): string {
  const stages = 25;
  let nodeRows = "";
  for (let i = 0; i < n; i++) {
    nodeRows += `node${i},Node ${i},,ops,s${i % stages},cat,,,,,\n`;
  }
  let stageRows = "";
  for (let s = 0; s < stages; s++) stageRows += `s${s},Stage ${s}\n`;
  return `# SECTION: streams
id,label,short,color
ops,Operations,OPS,#60a5fa

# SECTION: stages
id,label
${stageRows}
# SECTION: categories
id,label,color,text_color,class
cat,General,#a3a3a3,#111111,primary

# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max
${nodeRows}
# SECTION: edges
from,to,effect,elasticity,style,description
`;
}

// jsdom reports 0 for clientWidth/Height (no layout). Shadow them on the live
// scroller instance so computeCullRect sees a real viewport.
function mockViewport(width: number, height: number, scrollLeft = 0, scrollTop = 0): void {
  const el = document.getElementById("viz-scroll")!;
  for (const [prop, val] of [
    ["clientWidth", width], ["clientHeight", height],
    ["scrollLeft", scrollLeft], ["scrollTop", scrollTop],
  ] as const) {
    Object.defineProperty(el, prop, { value: val, configurable: true, writable: true });
  }
}

function clearViewportMock(): void {
  const el = document.getElementById("viz-scroll");
  if (!el) return;
  for (const prop of ["clientWidth", "clientHeight", "scrollLeft", "scrollTop"]) {
    delete (el as unknown as Record<string, unknown>)[prop];
  }
}

afterEach(clearViewportMock);

describe("viewport virtualization", () => {
  it("renders every node when the viewport size is unknown (e.g. tests/jsdom)", () => {
    loadDataFromCsv(bigCsv(VIRTUALIZE_MIN_NODES + 50));
    // No viewport mock → clientWidth/Height are 0 → cull disabled → draw all.
    expect(computeCullRect()).toBe(null);
    render();
    expect(document.querySelectorAll(".node-group").length).toBe(NODES.length);
  });

  it("never culls below the node-count threshold even with a small viewport", () => {
    loadDataFromCsv(bigCsv(VIRTUALIZE_MIN_NODES - 1));
    mockViewport(300, 300, 0, 0);
    expect(computeCullRect()).toBe(null); // under threshold
    render();
    expect(document.querySelectorAll(".node-group").length).toBe(NODES.length);
  });

  it("draws only the nodes near the viewport on a large map", () => {
    loadDataFromCsv(bigCsv(VIRTUALIZE_MIN_NODES + 200));
    mockViewport(300, 300, 0, 0);
    expect(computeCullRect()).not.toBe(null);
    render();
    const drawn = document.querySelectorAll(".node-group").length;
    expect(drawn).toBeGreaterThan(0);          // the top-left slice is visible
    expect(drawn).toBeLessThan(NODES.length);  // but not the whole map
  });

  it("draws a different slice after scrolling far away", () => {
    loadDataFromCsv(bigCsv(VIRTUALIZE_MIN_NODES + 200));

    mockViewport(300, 300, 0, 0);
    render();
    const topLeftIds = new Set(
      Array.from(document.querySelectorAll(".node-group")).map((g) => g.getAttribute("data-node-id")),
    );

    // Scroll to the far bottom-right of the map and redraw.
    mockViewport(300, 300, 100000, 100000);
    render();
    const farIds = new Set(
      Array.from(document.querySelectorAll(".node-group")).map((g) => g.getAttribute("data-node-id")),
    );

    // The two slices should not be identical (different region of the map).
    const sameAsTopLeft = farIds.size === topLeftIds.size &&
      [...farIds].every((id) => topLeftIds.has(id));
    expect(sameAsTopLeft).toBe(false);
  });

  it("does NOT rebuild on a small scroll within the already-drawn margin", async () => {
    loadDataFromCsv(bigCsv(VIRTUALIZE_MIN_NODES + 200));
    mockViewport(400, 400, 0, 0);
    render();
    const elBefore = document.querySelector(".ml-static-layer .node-group")!;
    expect(elBefore.isConnected).toBe(true);

    // Scroll a fraction of the margin — still well inside the drawn slice, so the
    // browser can scroll natively and we must NOT rebuild (the element stays put).
    const smallStep = Math.floor((CULL_MARGIN - 250) / 2); // comfortably below the trigger
    mockViewport(400, 400, smallStep, smallStep);
    maybeRenderForViewport();
    await flushFrame();
    expect(elBefore.isConnected).toBe(true); // same DOM node → no rebuild
  });

  it("rebuilds once the viewport nears the edge of the drawn slice", async () => {
    loadDataFromCsv(bigCsv(VIRTUALIZE_MIN_NODES + 200));
    mockViewport(400, 400, 0, 0);
    render();
    const elBefore = document.querySelector(".ml-static-layer .node-group")!;
    expect(elBefore.isConnected).toBe(true);

    // Scroll past the margin so the viewport reaches the drawn edge → rebuild.
    mockViewport(400, 400, CULL_MARGIN + 1000, CULL_MARGIN + 1000);
    maybeRenderForViewport();
    await flushFrame();
    // The old slice's nodes were detached when innerHTML was rewritten.
    expect(elBefore.isConnected).toBe(false);
  });
});
