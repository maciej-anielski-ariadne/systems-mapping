import { describe, expect, it } from "vitest";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import { NODES, STREAMS, state } from "../assets/js/03-state";
import { render } from "../assets/js/11-rendering";
import { buildExportModel, renderExportSvg } from "../assets/js/19-export";

const HOSTILE_INPUT_CSV = `# SECTION: streams
id,label,short,color
ops,Operations,OPS,url(javascript:alert(1))

# SECTION: stages
id,label
first,First

# SECTION: categories
id,label,color,text_color
general,General,red,expression(alert(1))

# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max
safe,"<script>alert(1)</script>",Safe description,ops,first,general,100,units,true,,2
"bad"" onload=""alert(1)",Rejected,Unsafe identity,ops,first,general,100,units,false,,2

# SECTION: edges
from,to,effect,elasticity,description
`;

describe("hostile imported values at render and export boundaries", () => {
  it("rejects unsafe identity, defaults unsafe colours, and keeps markup as text", () => {
    expect(loadDataFromCsv(HOSTILE_INPUT_CSV)).toBe(true);
    expect(NODES.map(node => node.id)).toEqual(["safe"]);
    expect(STREAMS[0].color).toBe("#94a3b8");
    expect(state.loadErrors.map(finding => finding.kind)).toEqual(expect.arrayContaining([
      "identifier-invalid",
      "colour-invalid",
    ]));

    render();
    const mapSvg = document.getElementById("viz-svg")!;
    expect(mapSvg.querySelector("script")).toBeNull();
    expect(mapSvg.querySelector("[onload]")).toBeNull();
    expect(mapSvg.textContent).toContain("<script>alert(1)</script>");

    const exportModel = buildExportModel({ allEdges: true });
    expect(exportModel).not.toBeNull();
    const exportedSvg = renderExportSvg(exportModel!).svg;
    expect(exportedSvg).not.toContain("<script>alert(1)</script>");
    expect(exportedSvg).not.toContain("javascript:");
    expect(exportedSvg).not.toContain(" onload=");
    expect(exportedSvg).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
