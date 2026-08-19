import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import {
  buildExportModel,
  getExportSelection,
  renderExportSvg,
  buildPublishHtml,
  exportPalette,
  exportMaxHighlightDepth,
  exportRasterScale,
  exportViewportFrame,
  EXPORT_CLOSE_SCRIPT,
  EXPORT_MAX_CANVAS_AREA,
  EXPORT_MAX_CANVAS_DIM,
  EXPORT_PNG_SCALE,
} from "../assets/js/19-export";
import { state, setLayout } from "../assets/js/03-state";
import { computeLayout } from "../assets/js/08-layout";
import { refreshNeighborHighlight } from "../assets/js/09-graph-selection";
import { clearPathway, currentRoute, findRoutes, showRoute, startPathway } from "../assets/js/09a-pathways";
import { LINEAR_CSV, REROUTE_CSV } from "./fixtures/graphs";
import { mountAppDom } from "./helpers/dom";

// Pull the inline viewer script body out of a published HTML string.
function viewerScript(html: string): string {
  const open = html.indexOf("<script>") + "<script>".length;
  const close = html.indexOf(EXPORT_CLOSE_SCRIPT, open);
  return html.slice(open, close);
}

describe("interactive published HTML (A → B → C)", () => {
  // Select the head of the chain at depth 2 so the export spans all three
  // nodes + both edges (the jsdom viewport is 0×0, so the no-selection path
  // would include nothing — selection is viewport-independent).
  beforeEach(() => {
    // Tests below mount the published viewer over document.body, so put the
    // app's real markup back first — loadDataFromCsv renders into it.
    mountAppDom();
    loadDataFromCsv(LINEAR_CSV);
    state.highlightDepth = 2;
    state.selectedNodeId = "a";
    state.selectedNodeIds = new Set(["a"]);
    refreshNeighborHighlight();
  });

  it("includes every edge among the nodes with trace metadata", () => {
    const model = buildExportModel({ allEdges: true })!;
    expect(model).not.toBeNull();
    // Both real edges are present (not just the highlighted subset).
    expect(model.edges.map((e) => e.id).sort()).toEqual(["edge_0", "edge_1"]);

    const { svg } = renderExportSvg(model);
    // Edge paths carry the data-* attributes the viewer traces on.
    expect(svg).toContain('class="xedge"');
    expect(svg).toContain('data-from="a"');
    expect(svg).toContain('data-to="b"');
    expect(svg).toContain('data-effect="increases"');
    // Node background rect is tagged so the viewer can paint selection glows.
    expect(svg).toContain('class="xn-bg"');
    // Arrowhead markers for highlighted edges exist.
    expect(svg).toContain('id="xarrow_increases"');
  });

  it("max highlight depth over the subset matches the chain length", () => {
    const model = buildExportModel({ allEdges: true })!;
    expect(exportMaxHighlightDepth(model.edges)).toBe(2);
  });

  it("embeds the graph + controls and emits parseable viewer JS", () => {
    const model = buildExportModel({ allEdges: true })!;
    const pal = exportPalette();
    const { svg, width, height, nodeInfo } = renderExportSvg(model, { pal });
    const html = buildPublishHtml(svg, width, height, nodeInfo, pal, model.edges);

    // Highlight-depth control markup is present.
    expect(html).toContain('id="mv-depth-up"');
    expect(html).toContain('id="mv-depth-down"');
    // Embedded graph data + depth cap.
    expect(html).toContain("var EDGES=");
    expect(html).toContain("MAXD=2");
    // The embedded edge list survives the closing-tag escape and is valid JSON.
    const m = html.match(/var EDGES=(\[.*?\]);var scroll/);
    expect(m).not.toBeNull();
    const edges = JSON.parse(m![1].replace(/\\u003c/g, "<"));
    expect(edges).toHaveLength(2);
    expect(edges[0]).toMatchObject({ from: "a", to: "b", effect: "increases" });

    // The whole viewer script compiles (catches concatenation/syntax errors).
    const js = viewerScript(html);
    expect(() => new Function(js)).not.toThrow();
    // No stray raw "</script>" that would break the inlined page.
    expect(js.includes("</scr" + "ipt>")).toBe(false);
  });

  it("clicking a box traces its connections at runtime", () => {
    const model = buildExportModel({ allEdges: true })!;
    const pal = exportPalette();
    const { svg, width, height, nodeInfo } = renderExportSvg(model, { pal });
    const html = buildPublishHtml(svg, width, height, nodeInfo, pal, model.edges);

    // Mount the viewer's DOM + run its inline script in the test's jsdom.
    const body = html.slice(html.indexOf("<body>") + "<body>".length, html.indexOf("<script>"));
    document.body.innerHTML = body;
    new Function(viewerScript(html))();

    const node = (id: string) => document.querySelector('.xnode[data-node-id="' + id + '"]')!;
    const edge = (id: string) => document.querySelector('.xedge[data-edge-id="' + id + '"]')!;

    // Nothing selected → no highlight classes.
    expect(node("a").classList.contains("sel")).toBe(false);

    // Click A (depth defaults to 1): A selected, B is a direct descendant,
    // C is out of reach and dims; only the A→B edge lights up.
    node("a").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(node("a").classList.contains("sel")).toBe(true);
    expect(node("b").classList.contains("desc")).toBe(true);
    expect(node("c").classList.contains("dim")).toBe(true);
    expect(edge("edge_0").classList.contains("ehi")).toBe(true);
    expect(edge("edge_1").classList.contains("edim")).toBe(true);

    // Widen the trace to depth 2 → C joins the descendant chain, both edges light.
    (document.getElementById("mv-depth-up") as HTMLButtonElement).click();
    expect(document.getElementById("mv-depth")!.textContent).toBe("2");
    expect(node("c").classList.contains("desc")).toBe(true);
    expect(edge("edge_1").classList.contains("ehi")).toBe(true);

    // Clicking the selected box again clears the trace.
    node("a").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(node("a").classList.contains("sel")).toBe(false);
    expect(node("c").classList.contains("dim")).toBe(false);
  });

  it("moves the trace straight from one box to another (incremental update)", () => {
    // The viewer only mutates the classes that actually change between two
    // highlight states, so switching selection WITHOUT deselecting first — the
    // path that never resets everything — has to land on exactly the same
    // classes a fresh trace would.
    const model = buildExportModel({ allEdges: true })!;
    const pal = exportPalette();
    const { svg, width, height, nodeInfo } = renderExportSvg(model, { pal });
    const html = buildPublishHtml(svg, width, height, nodeInfo, pal, model.edges);
    document.body.innerHTML = html.slice(html.indexOf("<body>") + "<body>".length, html.indexOf("<script>"));
    new Function(viewerScript(html))();

    const node = (id: string) => document.querySelector('.xnode[data-node-id="' + id + '"]')!;
    const edge = (id: string) => document.querySelector('.xedge[data-edge-id="' + id + '"]')!;
    const classesOf = (id: string) => [...node(id).classList].filter((c) => c !== "xnode").sort();

    node("a").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    // Straight to C — no intermediate deselect.
    node("c").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(classesOf("c")).toEqual(["sel"]);       // A's old "sel" is gone
    expect(classesOf("b")).toEqual(["anc"]);       // was "desc" of A
    expect(classesOf("a")).toEqual(["dim"]);
    expect(edge("edge_1").classList.contains("ehi")).toBe(true);
    expect(edge("edge_0").classList.contains("edim")).toBe(true);

    // Depth 2 pulls A into the ancestor chain, then back down again.
    (document.getElementById("mv-depth-up") as HTMLButtonElement).click();
    expect(classesOf("a")).toEqual(["anc"]);
    expect(edge("edge_0").classList.contains("ehi")).toBe(true);
    (document.getElementById("mv-depth-down") as HTMLButtonElement).click();
    expect(classesOf("a")).toEqual(["dim"]);
    expect(edge("edge_0").classList.contains("edim")).toBe(true);

    // Clearing leaves every box with no highlight class at all.
    node("c").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    for (const id of ["a", "b", "c"]) expect(classesOf(id)).toEqual([]);
    expect([...edge("edge_0").classList].sort()).toEqual(["xedge"]);
  });

  it("stamps the viewer's svg id at build time instead of patching it in", () => {
    const model = buildExportModel({ allEdges: true })!;
    const pal = exportPalette();
    const patched = renderExportSvg(model, { pal });
    const stamped = renderExportSvg(model, { pal, svgId: "mv-svg" });
    expect(stamped.svg.startsWith('<svg id="mv-svg" ')).toBe(true);
    // Either way the published page is byte-for-byte the same.
    const page = (r: typeof patched) =>
      buildPublishHtml(r.svg, r.width, r.height, r.nodeInfo, pal, model.edges);
    expect(page(stamped)).toBe(page(patched));
  });
});

describe("export layout reuses the live grid geometry", () => {
  // With nothing collapsed and the streams already in order, the export's
  // reflow is a no-op, so its packed columns/rows/size must match the canvas
  // exactly — the guarantee of sharing the packColumns/packRows primitives.
  let scrollEl: HTMLElement | null = null;
  beforeEach(() => {
    mountAppDom();
    loadDataFromCsv(LINEAR_CSV);
    state.selectedNodeId = null;
    state.selectedNodeIds = new Set();
    state.hiddenStreams = new Set();
    state.hiddenStages = new Set();
    setLayout(computeLayout());
    scrollEl = document.getElementById("viz-scroll");
    scrollEl?.parentElement?.removeChild(scrollEl);
  });
  afterEach(() => {
    if (scrollEl) document.body.appendChild(scrollEl);
  });

  it("packs the full map to the same columns, rows, and overall size", () => {
    const live = computeLayout();
    const ex = buildExportModel()!.layout;
    expect(ex.colX).toEqual({ s1: live.colX.s1, s2: live.colX.s2, s3: live.colX.s3 });
    expect(ex.rowY.ops).toBe(live.rowY.ops);
    expect(ex.rowHeights.ops).toBe(live.rowHeights.ops);
    expect(ex.totalWidth).toBe(live.totalWidth);
    expect(ex.totalHeight).toBe(live.totalHeight);
  });
});

describe("viewport framing (no selection)", () => {
  // A → B → C, one row, three columns. The packed geometry is deterministic:
  //   col s1 x=112, s2 x=396, s3 x=680 (each NODE_WIDTH 220 + COL_GAP 64),
  //   totalWidth 916, totalHeight 136 — so a 300px-wide viewport sees exactly
  //   one column at a time and framing is observable.
  //
  // jsdom reports clientWidth/clientHeight as 0 and won't scroll, so the
  // scroller's metrics are stubbed per test. That 0×0 default is itself the
  // fallback the other suites rely on.
  const stub = (dims: { w: number; h: number; left?: number; top?: number }): void => {
    const el = document.getElementById("viz-scroll")!;
    const def = (name: string, value: number): void => {
      Object.defineProperty(el, name, { value, configurable: true });
    };
    def("clientWidth", dims.w);
    def("clientHeight", dims.h);
    def("scrollLeft", dims.left || 0);
    def("scrollTop", dims.top || 0);
  };

  beforeEach(() => {
    mountAppDom();
    loadDataFromCsv(LINEAR_CSV);
    state.selectedNodeId = null;
    state.selectedNodeIds = new Set();
    state.hiddenStreams = new Set();
    state.hiddenStages = new Set();
    state.zoomLevel = 1;
    setLayout(computeLayout());
  });

  it("frames the export on the boxes inside the scroll viewport", () => {
    stub({ w: 300, h: 2000 });                 // only column s1 is on screen
    expect(exportViewportFrame()).toMatchObject({ x: 0, y: 0, width: 300, height: 2000 });

    const model = buildExportModel()!;
    expect([...model.nodeIds]).toEqual(["a"]);
    // A → B has one end off-screen, so it is dropped rather than left dangling.
    expect(model.edges).toHaveLength(0);
  });

  it("follows the scroll position", () => {
    stub({ w: 300, h: 2000, left: 400 });      // scrolled right onto s2 / s3
    const model = buildExportModel()!;
    expect([...model.nodeIds].sort()).toEqual(["b", "c"]);
    // Both ends of B → C are framed, so that edge survives.
    expect(model.edges.map((e) => e.id)).toEqual(["edge_1"]);
  });

  it("divides by the zoom level (the scroller scrolls the scaled SVG)", () => {
    state.zoomLevel = 2;                       // 300 device px = 150 layout px
    stub({ w: 300, h: 2000, left: 800 });      // layout x 400 → same crop as above
    expect(exportViewportFrame()).toMatchObject({ x: 400, y: 0, width: 150, height: 1000 });
    expect([...buildExportModel()!.nodeIds]).toEqual(["b"]);
  });

  it("exports the whole map when it already fits inside the viewport", () => {
    stub({ w: 5000, h: 5000 });
    expect(exportViewportFrame()).toBeNull();
    expect([...buildExportModel()!.nodeIds].sort()).toEqual(["a", "b", "c"]);
  });

  it("exports the whole map when the viewport is degenerate (jsdom's 0×0)", () => {
    stub({ w: 0, h: 0 });
    expect(exportViewportFrame()).toBeNull();
    expect([...buildExportModel()!.nodeIds].sort()).toEqual(["a", "b", "c"]);
  });

  it("exports the whole map when there is no scroll container at all", () => {
    const el = document.getElementById("viz-scroll")!;
    el.parentElement!.removeChild(el);
    expect(exportViewportFrame()).toBeNull();
    expect([...buildExportModel()!.nodeIds].sort()).toEqual(["a", "b", "c"]);
    document.body.appendChild(el);
  });
});

describe("raster density ceilings", () => {
  it("keeps the target density for a normally-sized map", () => {
    expect(exportRasterScale(1200, 800)).toBe(EXPORT_PNG_SCALE);
  });

  it("caps the total canvas area well below the per-side square", () => {
    // The area ceiling is the binding one: 16384² px would be ~1GB of backing
    // store, which Safari/iOS refuse outright.
    expect(EXPORT_MAX_CANVAS_AREA).toBeLessThan(EXPORT_MAX_CANVAS_DIM * EXPORT_MAX_CANVAS_DIM);
    const scale = exportRasterScale(6000, 4000);
    expect(scale).toBeLessThan(EXPORT_PNG_SCALE);
    expect(6000 * scale * 4000 * scale).toBeLessThanOrEqual(EXPORT_MAX_CANVAS_AREA + 1);
  });

  it("degrades below 1× rather than failing on a huge map", () => {
    const scale = exportRasterScale(20000, 12000);
    expect(scale).toBeGreaterThan(0);
    expect(scale).toBeLessThan(1);            // caller warns the user about this
    expect(20000 * scale).toBeLessThanOrEqual(EXPORT_MAX_CANVAS_DIM);
  });

  it("falls back to 1× rather than a non-finite density", () => {
    expect(exportRasterScale(NaN, NaN)).toBe(1);
    expect(exportRasterScale(-10, -10)).toBe(1);
  });
});

describe("emitted coordinate precision", () => {
  // Zoomed out past TEXT_SCALE_RATIO the layout grows boxes by 0.85/zoom, so
  // every height, row offset and bezier control point becomes a repeating
  // fraction — the export used to emit all 17 digits of them, several times per
  // box and twice per edge.
  beforeEach(() => {
    mountAppDom();
    state.zoomLevel = 0.7;
    loadDataFromCsv(LINEAR_CSV);
    state.selectedNodeId = null;
    state.selectedNodeIds = new Set();
    setLayout(computeLayout());
    const el = document.getElementById("viz-scroll");
    el?.parentElement?.removeChild(el!);
  });
  afterEach(() => {
    state.zoomLevel = 1;
  });

  it("rounds every emitted geometry number to one decimal", () => {
    const { svg } = renderExportSvg(buildExportModel()!);
    // The layout really is fractional here — otherwise this test proves nothing.
    expect(svg).toMatch(/\sd="[^"]*\d\.\d/);

    const geometry = svg.match(/\s(?:d|x|y|x1|y1|x2|y2|width|height|rx)="([^"]*)"/g) || [];
    const overPrecise = geometry.filter((attr) => /\d+\.\d\d+/.test(attr));
    expect(overPrecise).toEqual([]);
  });
});

describe("export honours collapsed stages (A → B → C, hide the middle)", () => {
  // The no-selection export covers the whole map (every box passing the sidebar
  // visibility filters), so B is hidden only by the collapsed stage. #viz-scroll
  // is detached here just to keep the DOM minimal; the export no longer crops to
  // the viewport.
  let scrollEl: HTMLElement | null = null;
  beforeEach(() => {
    // The previous describe's last test overwrites document.body with the
    // published viewer; restore the app DOM so the loader's renderDetailPanel
    // (and our #viz-scroll detach below) have their elements back.
    mountAppDom();
    loadDataFromCsv(REROUTE_CSV);
    state.selectedNodeId = null;
    state.selectedNodeIds = new Set();
    state.hiddenStages = new Set(["s2"]);   // collapse the middle stage
    setLayout(computeLayout());
    scrollEl = document.getElementById("viz-scroll");
    scrollEl?.parentElement?.removeChild(scrollEl);
  });
  afterEach(() => {
    if (scrollEl) document.body.appendChild(scrollEl);
  });

  it("reroutes the hidden middle as a synthetic A → C edge instead of dropping the link", () => {
    const model = buildExportModel()!;
    expect(model).not.toBeNull();
    // B is collapsed out; A and C remain.
    expect([...model.nodeIds].sort()).toEqual(["a", "c"]);
    // The pathway survives as ONE synthetic A→C connector — the same rerouting
    // the live map shows — rather than vanishing with its dropped raw edges.
    expect(model.edges).toHaveLength(1);
    expect(model.edges[0]).toMatchObject({ from: "a", to: "c", effect: "increases", synthetic: true });

    // And the SVG actually draws that arrow.
    const { svg } = renderExportSvg(model);
    expect(svg).toContain('data-from="a"');
    expect(svg).toContain('data-to="c"');
    expect(svg).not.toContain('data-to="b"');
  });

  it("carries the synthetic edge into the published viewer so it traces through", () => {
    const model = buildExportModel({ allEdges: true })!;
    const pal = exportPalette();
    const { svg, width, height, nodeInfo } = renderExportSvg(model, { pal });
    const html = buildPublishHtml(svg, width, height, nodeInfo, pal, model.edges);
    const m = html.match(/var EDGES=(\[.*?\]);var scroll/);
    expect(m).not.toBeNull();
    const edges = JSON.parse(m![1].replace(/\\u003c/g, "<"));
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ from: "a", to: "c", effect: "increases" });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Exporting is the only way a strand outlives the session — pathway mode is
// never persisted — so the scoping has to be exact: the chain's boxes and its
// own links, and nothing that merely sits between them.
// ───────────────────────────────────────────────────────────────────────────
describe("a traced strand scopes the export to itself", () => {
  // A → B → C plus a shortcut A → C, so "the boxes on the strand" and "every
  // link among those boxes" are different answers.
  const SHORTCUT_CSV = `# SECTION: streams
id,label,short,color
ops,Operations,OPS,#60a5fa

# SECTION: stages
id,label
s1,Inputs
s2,Middle
s3,Outputs

# SECTION: categories
id,label,color,text_color,class
cat,General,#a3a3a3,#111111,primary

# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max
a,Input A,,ops,s1,cat,100,units,true,,400
b,Middle B,,ops,s2,cat,50,units,,,
c,Output C,,ops,s3,cat,20,units,,higher_better,
d,Spare D,,ops,s2,cat,10,units,,,

# SECTION: edges
from,to,effect,elasticity,style,description
a,b,increases,0.5,,The long way
b,c,increases,0.5,,The long way
a,c,increases,0.9,,The shortcut
a,d,increases,0.5,,Off the strand
`;

  beforeEach(() => {
    mountAppDom();
    loadDataFromCsv(SHORTCUT_CSV);
    setLayout(computeLayout());
  });
  afterEach(() => clearPathway());

  it("exports exactly the strand's boxes and links", () => {
    // The long way round — a → b → c — rather than the a → c shortcut, so the
    // strand's boxes and its links are genuinely different sets.
    const longWay = findRoutes("a", "c").routes.find(r => r.nodeIds.length === 3)!;
    showRoute(longWay);
    expect(currentRoute()!.nodeIds).toEqual(["a", "b", "c"]);

    const sel = getExportSelection();
    expect(sel.selectionActive).toBe(true);
    expect([...sel.nodeIds].sort()).toEqual(["a", "b", "c"]);
    expect(sel.edges.map(e => e.from + "→" + e.to).sort()).toEqual(["a→b", "b→c"]);
  });

  it("keeps the shortcut out even when asked for every edge", () => {
    // allEdges is what the CSV export passes. Everywhere else it means "every
    // link among these boxes", which for a strand would draw back the shortcut
    // the trace just narrowed away — so the strand branch ignores it.
    showRoute(findRoutes("a", "c").routes.find(r => r.nodeIds.length === 3)!);

    const sel = getExportSelection(true);
    expect(sel.edges.map(e => e.from + "→" + e.to).sort()).toEqual(["a→b", "b→c"]);
  });

  it("beats a node selection when both are live", () => {
    showRoute(findRoutes("a", "c").routes.find(r => r.nodeIds.length === 3)!);
    // Select a box that is NOT on the strand; the strand still wins.
    state.selectedNodeId = "d";
    state.selectedNodeIds = new Set(["d"]);
    refreshNeighborHighlight();

    const sel = getExportSelection();
    expect([...sel.nodeIds].sort()).toEqual(["a", "b", "c"]);

    state.selectedNodeId = null;
    state.selectedNodeIds = new Set();
    refreshNeighborHighlight();
  });

  it("builds a model whose layout covers just the strand", () => {
    startPathway("a", "c");
    const model = buildExportModel();
    expect(model).not.toBeNull();
    expect([...model!.nodeIds].sort()).toEqual(["a", "c"]);   // strongest route is the shortcut
    expect(Object.keys(model!.layout.positions).sort()).toEqual(["a", "c"]);
  });

  it("falls back to the normal rules once the strand is cleared", () => {
    startPathway("a", "c");
    clearPathway();
    const sel = getExportSelection();
    expect(sel.selectionActive).toBe(false);
    expect(sel.nodeIds.size).toBe(4);
  });
});
