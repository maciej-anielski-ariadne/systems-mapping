import { describe, it, expect, afterEach } from "vitest";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import {
  render,
  maybeRenderForViewport,
  VIRTUALIZE_MIN_NODES,
  VIRTUALIZE_MIN_EDGES,
  CULL_MARGIN,
  RERENDER_BUFFER,
  computeCullRect,
  _edgeCandidateCountForCull,
} from "../assets/js/11-rendering";
import { EDGES, NODES, layout } from "../assets/js/03-state";

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

// A map with links, deliberately much TALLER than any test viewport: 12 stream
// rows x 25 stages, 3 boxes stacked per cell (ids r<row>_s<stage>_<slot>), plus
// enough links to clear the edge threshold. Three links are named:
//   r0_s0_0  -> r0_s24_0    a long link running straight along the top row
//   r0_s0_0  -> r11_s24_0   a long DIAGONAL link — its endpoint box covers the map
//   r0_s23_0 -> r0_s24_0    a short neighbour link at the top right
const ROWS = 12, STAGE_COUNT = 25, PER_CELL = 3;

function gridRows(): { streamRows: string; stageRows: string; nodeRows: string } {
  let nodeRows = "";
  for (let r = 0; r < ROWS; r++) {
    for (let s = 0; s < STAGE_COUNT; s++) {
      for (let k = 0; k < PER_CELL; k++) {
        nodeRows += `r${r}_s${s}_${k},Box ${r}-${s}-${k},,st${r},s${s},cat,,,,,\n`;
      }
    }
  }
  let stageRows = "";
  for (let s = 0; s < STAGE_COUNT; s++) stageRows += `s${s},Stage ${s}\n`;
  let streamRows = "";
  for (let r = 0; r < ROWS; r++) streamRows += `st${r},Stream ${r},S${r},#60a5fa\n`;
  return { streamRows, stageRows, nodeRows };
}

function linkedCsv(): string {
  const { streamRows, stageRows, nodeRows } = gridRows();
  let edgeRows = "";
  edgeRows += "r0_s0_0,r0_s24_0,increases,0.5,solid,\n";
  edgeRows += `r0_s0_0,r${ROWS - 1}_s24_0,increases,0.5,solid,\n`;
  edgeRows += "r0_s23_0,r0_s24_0,increases,0.5,solid,\n";
  // Filler: a short chain along each row so the edge count clears the threshold.
  let filler = 0;
  const target = VIRTUALIZE_MIN_EDGES + 50;
  for (let r = 0; r < ROWS && filler < target; r++) {
    for (let s = 0; s < STAGE_COUNT - 1 && filler < target; s++) {
      for (let k = 0; k < PER_CELL && filler < target; k++) {
        edgeRows += `r${r}_s${s}_${k},r${r}_s${s + 1}_${k},enables,0.5,solid,\n`;
        filler++;
      }
    }
  }
  return csvDoc(streamRows, stageRows, nodeRows, edgeRows);
}

// Same grid, but every link spans a long, random distance — the shape that used
// to defeat culling completely.
function hairballCsv(): string {
  const { streamRows, stageRows, nodeRows } = gridRows();
  let edgeRows = "";
  let seed = 7;
  const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = (): string =>
    `r${Math.floor(rnd() * ROWS)}_s${Math.floor(rnd() * STAGE_COUNT)}_${Math.floor(rnd() * PER_CELL)}`;
  for (let i = 0; i < VIRTUALIZE_MIN_EDGES + 500; i++) {
    const from = pick(), to = pick();
    if (from === to) continue;
    edgeRows += `${from},${to},increases,0.5,solid,\n`;
  }
  return csvDoc(streamRows, stageRows, nodeRows, edgeRows);
}

function csvDoc(streamRows: string, stageRows: string, nodeRows: string, edgeRows: string): string {
  return `# SECTION: streams
id,label,short,color
${streamRows}
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
${edgeRows}`;
}

// The minted id of the first edge between two boxes.
function edgeIdFor(from: string, to: string): string {
  return EDGES.find((e) => e.from === from && e.to === to)!.id!;
}

// data-edge-id of every drawn (visible) link.
function drawnEdgeIds(): Set<string> {
  return new Set(
    Array.from(document.querySelectorAll(".ml-static-layer .edge-path"))
      .map((p) => p.getAttribute("data-edge-id"))
      .filter((id): id is string => id !== null),
  );
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
    // Half the gap between the drawn edge and the rebuild trigger line — i.e.
    // comfortably inside the drawn slice, wherever the two constants sit.
    const smallStep = Math.floor((CULL_MARGIN - RERENDER_BUFFER) / 2);
    mockViewport(400, 400, smallStep, smallStep);
    maybeRenderForViewport();
    await flushFrame();
    expect(elBefore.isConnected).toBe(true); // same DOM node → no rebuild
  });

  it("still draws every link when the viewport size is unknown", () => {
    loadDataFromCsv(linkedCsv());
    expect(computeCullRect()).toBe(null);
    render();
    expect(drawnEdgeIds().size).toBe(EDGES.length);
  });

  it("draws a link that crosses the viewport even though both its boxes are off-screen", () => {
    loadDataFromCsv(linkedCsv());
    // Park the viewport over the middle of the row the long link runs along.
    const mid = layout.positions["r0_s12_0"];
    mockViewport(300, 300, mid.x - 100, mid.y - 100);
    render();

    // Neither end of the long link is anywhere near the viewport…
    const drawnNodes = new Set(
      Array.from(document.querySelectorAll(".node-group")).map((g) => g.getAttribute("data-node-id")),
    );
    expect(drawnNodes.has("r0_s0_0")).toBe(false);
    expect(drawnNodes.has("r0_s24_0")).toBe(false);
    // …but the curve between them runs straight through it, so it is drawn.
    expect(drawnEdgeIds().has(edgeIdFor("r0_s0_0", "r0_s24_0"))).toBe(true);
  });

  it("culls a long link whose curve stays far from the viewport", () => {
    loadDataFromCsv(linkedCsv());
    // The diagonal link runs from the top-left box to the bottom-right one, so
    // the box around its ENDPOINTS covers the whole map — the old endpoint-AABB
    // test kept it alive in every slice. Its curve, though, sags away from the
    // top-right corner, which is where we look.
    const topRight = layout.positions["r0_s24_0"];
    mockViewport(300, 300, topRight.x - 200, Math.max(0, topRight.y - 100));
    render();
    const drawn = drawnEdgeIds();
    expect(drawn.has(edgeIdFor("r0_s0_0", "r11_s24_0"))).toBe(false);
    // Sanity: the culling isn't just dropping everything — a link between two
    // boxes right here is still drawn.
    expect(drawn.has(edgeIdFor("r0_s23_0", "r0_s24_0"))).toBe(true);
  });

  it("keeps the drawn-link count bounded on a hairball map", () => {
    loadDataFromCsv(hairballCsv());
    // Look at the top-right of the map: the region long links' endpoint boxes
    // cover but their sagging curves mostly miss.
    mockViewport(400, 400, layout.totalWidth - 400, 0);
    render();
    const drawn = document.querySelectorAll(".ml-static-layer .edge-path").length;
    expect(drawn).toBeGreaterThan(0);

    // How many links the OLD test (the box around an edge's two end boxes)
    // would have kept for this exact slice. Long links defeat it, so on a
    // hairball it keeps most of the map; the curve test has to do meaningfully
    // better than that, and better than half the map in absolute terms.
    const cull = computeCullRect()!;
    // The geometry-revision index must narrow the expensive curve tests before
    // the exact cull below; otherwise DOM virtualization still scans every link.
    const indexedCandidates = _edgeCandidateCountForCull(cull);
    expect(indexedCandidates).toBeLessThan(EDGES.length * 0.5);
    let endpointBoxSurvivors = 0;
    for (const e of EDGES) {
      const a = layout.positions[e.from], b = layout.positions[e.to];
      if (!a || !b) continue;
      const x1 = Math.min(a.x, b.x), y1 = Math.min(a.y, b.y);
      const x2 = Math.max(a.x + a.width, b.x + b.width), y2 = Math.max(a.y + a.height, b.y + b.height);
      if (x1 <= cull.maxX && x2 >= cull.minX && y1 <= cull.maxY && y2 >= cull.minY) endpointBoxSurvivors++;
    }
    expect(drawn).toBeLessThan(endpointBoxSurvivors * 0.75);
    expect(drawn).toBeLessThan(EDGES.length * 0.5);
  });

  it("emits pointer hit-paths only for links reaching the real viewport", () => {
    loadDataFromCsv(hairballCsv());
    mockViewport(400, 400, layout.totalWidth / 2, layout.totalHeight / 2);
    render();
    const paths = document.querySelectorAll(".ml-static-layer .edge-path").length;
    const hits  = document.querySelectorAll(".ml-static-layer .edge-hit").length;
    // Hit-paths are invisible, so the ones drawn out in the cull margin (beyond
    // the viewport, where the pointer can't be) are not emitted at all.
    expect(hits).toBeLessThan(paths);
    expect(hits).toBeGreaterThan(0);
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
