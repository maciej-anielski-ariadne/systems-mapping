import { describe, it, expect, beforeEach } from "vitest";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import {
  buildExportModel,
  renderExportSvg,
  buildPublishHtml,
  exportPalette,
  exportMaxHighlightDepth,
  EXPORT_CLOSE_SCRIPT,
} from "../assets/js/19-export";
import { state } from "../assets/js/03-state";
import { refreshNeighborHighlight } from "../assets/js/09-graph-selection";
import { LINEAR_CSV } from "./fixtures/graphs";

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
