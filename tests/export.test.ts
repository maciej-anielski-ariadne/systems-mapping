import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import {
  buildExportModel,
  renderExportSvg,
  buildPublishHtml,
  exportPalette,
  exportMaxHighlightDepth,
  EXPORT_CLOSE_SCRIPT,
} from "../assets/js/19-export";
import { state, setLayout } from "../assets/js/03-state";
import { computeLayout } from "../assets/js/08-layout";
import { refreshNeighborHighlight } from "../assets/js/09-graph-selection";
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
