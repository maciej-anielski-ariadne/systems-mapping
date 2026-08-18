// =============================================================================
// LARGE-MAP FILLS (H5) — pre-desaturated colours instead of a per-box filter
// -----------------------------------------------------------------------------
// `.node-rect` / `.node-stripe` carry `filter: saturate(0.32)`, i.e. one
// rasterization pass per box. Above PRE_DESATURATE_MIN_BOXES drawn boxes the
// renderer bakes the same transform into the emitted fills and tags the group
// `.pre-desat`, which turns the CSS filter off (05-visualization.css).
//
// The gate is what keeps this safe: below the threshold — every map in normal
// use — not a single byte of the markup changes.
// =============================================================================
import { describe, it, expect, afterEach } from "vitest";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import { render, desaturateColor, PRE_DESATURATE_MIN_BOXES } from "../assets/js/11-rendering";
import { selectNode, deselectAll } from "../assets/js/09-graph-selection";

const CATEGORY_COLOR = "#3b82f6";
const STREAM_COLOR = "#f59e0b";

function mapCsv(n: number): string {
  const stages = 10;
  let nodeRows = "";
  for (let i = 0; i < n; i++) nodeRows += `node${i},Node ${i},,ops,s${i % stages},cat,,,,,\n`;
  let stageRows = "";
  for (let s = 0; s < stages; s++) stageRows += `s${s},Stage ${s}\n`;
  return `# SECTION: streams
id,label,short,color
ops,Operations,OPS,${STREAM_COLOR}

# SECTION: stages
id,label
${stageRows}
# SECTION: categories
id,label,color,text_color,class
cat,General,${CATEGORY_COLOR},#111111,primary

# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max
${nodeRows}
# SECTION: edges
from,to,effect,elasticity,style,description
`;
}

function rectOf(id: string): Element {
  return document.querySelector('.node-group[data-node-id="' + id + '"] .node-rect')!;
}

afterEach(() => deselectAll());

describe("desaturateColor", () => {
  it("matches the sRGB saturate() matrix the CSS filter applies", () => {
    // Hand-computed for saturate(0.32) on #3b82f6 (R=59, G=130, B=246):
    //   r = 0.46484*59 + 0.48620*130 + 0.04896*246 = 102.7 → 103 (0x67)
    //   g = 0.14484*59 + 0.80620*130 + 0.04896*246 = 125.4 → 125 (0x7d)
    //   b = 0.14484*59 + 0.48620*130 + 0.36896*246 = 162.5 → 163 (0xa3)
    expect(desaturateColor(CATEGORY_COLOR)).toBe("#677da3");
  });

  it("leaves greys and unparseable colours alone", () => {
    expect(desaturateColor("#808080")).toBe("#808080");
    expect(desaturateColor("var(--edge-default)")).toBe("var(--edge-default)");
  });
});

describe("pre-desaturated fills above the box threshold", () => {
  it("changes nothing on a map below the threshold", () => {
    loadDataFromCsv(mapCsv(200));
    render();
    const rect = rectOf("node0");
    expect(rect.getAttribute("fill")).toBe(CATEGORY_COLOR);
    expect(rect.closest(".node-group")!.classList.contains("pre-desat")).toBe(false);
    expect(
      document.querySelector('.node-group[data-node-id="node0"] .node-stripe')!.getAttribute("fill"),
    ).toBe(STREAM_COLOR);
  });

  it("bakes the desaturation into the fills above it", () => {
    loadDataFromCsv(mapCsv(PRE_DESATURATE_MIN_BOXES + 20));
    render();
    const rect = rectOf("node0");
    expect(rect.closest(".node-group")!.classList.contains("pre-desat")).toBe(true);
    expect(rect.getAttribute("fill")).toBe(desaturateColor(CATEGORY_COLOR));
    expect(
      document.querySelector('.node-group[data-node-id="node0"] .node-stripe')!.getAttribute("fill"),
    ).toBe(desaturateColor(STREAM_COLOR));
  });

  it("keeps literal colours on boxes whose CSS filter is not the resting one", () => {
    loadDataFromCsv(mapCsv(PRE_DESATURATE_MIN_BOXES + 20));
    render();
    selectNode("node0");
    // The selected box drops back to the real colours + the glow filter…
    const selected = rectOf("node0");
    expect(selected.closest(".node-group")!.classList.contains("pre-desat")).toBe(false);
    expect(selected.getAttribute("fill")).toBe(CATEGORY_COLOR);
    // …while its neighbours stay baked.
    const other = rectOf("node5");
    expect(other.closest(".node-group")!.classList.contains("pre-desat")).toBe(true);
    expect(other.getAttribute("fill")).toBe(desaturateColor(CATEGORY_COLOR));

    // And deselecting puts the selected box back the way it was.
    deselectAll();
    const after = rectOf("node0");
    expect(after.closest(".node-group")!.classList.contains("pre-desat")).toBe(true);
    expect(after.getAttribute("fill")).toBe(desaturateColor(CATEGORY_COLOR));
  });
});
