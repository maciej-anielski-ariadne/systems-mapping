// =============================================================================
// PATHWAY MODE AT SCALE
// -----------------------------------------------------------------------------
// Two things here could plausibly hang a big map, and both are pinned:
//
//   • the search itself — a dense graph holds combinatorially many simple
//     paths, so findRoutes has a budget and reports a truncated count rather
//     than running until the tab dies;
//   • the sidebar block — it holds one <option> per box, and renderSidebar runs
//     on all sorts of interactions, so the panel must not rebuild those options
//     unless the boxes actually changed.
// =============================================================================
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import { state } from "../assets/js/03-state";
import {
  PATHWAY_SEARCH_BUDGET,
  clearPathway,
  findRoutes,
  startPathway,
} from "../assets/js/09a-pathways";
import { renderPathwayPanel } from "../assets/js/09b-pathway-ui";
import { mountAppDom } from "./helpers/dom";

// A layered map: `layers` columns of `width` boxes each, every box in a layer
// wired to every box in the next. Route count between the two ends is
// width^(layers-1) — 4^7 = 16384 at the defaults below — which is exactly the
// explosion the cap exists for.
function layeredCsv(layers: number, width: number): string {
  const stages = Array.from({ length: layers }, (_, i) => `s${i},Layer ${i}`).join("\n");
  const nodes: string[] = [];
  const edges: string[] = [];
  for (let layer = 0; layer < layers; layer++) {
    for (let i = 0; i < width; i++) {
      const id = `n${layer}_${i}`;
      const controllable = layer === 0 ? "true" : "";
      const direction = layer === layers - 1 ? "higher_better" : "";
      nodes.push(`${id},Box ${layer}-${i},,ops,s${layer},cat,100,units,${controllable},${direction},`);
      if (layer > 0) {
        for (let j = 0; j < width; j++) {
          edges.push(`n${layer - 1}_${j},${id},increases,0.5,,wired`);
        }
      }
    }
  }
  return `# SECTION: streams
id,label,short,color
ops,Operations,OPS,#60a5fa

# SECTION: stages
id,label
${stages}

# SECTION: categories
id,label,color,text_color,class
cat,General,#a3a3a3,#111111,primary

# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max
${nodes.join("\n")}

# SECTION: edges
from,to,effect,elasticity,style,description
${edges.join("\n")}
`;
}

describe("route search on a densely connected map", () => {
  beforeEach(() => loadDataFromCsv(layeredCsv(8, 4)));
  afterEach(() => clearPathway());

  it("keeps only the cap, but counts every route it found", () => {
    const result = findRoutes("n0_0", "n7_0");
    expect(result.routes.length).toBeLessThanOrEqual(10);
    expect(result.total).toBe(4 ** 6);       // 4096 ways across the six inner layers
    expect(result.truncated).toBe(false);
    // Every kept route is a real, simple, 7-hop chain.
    for (const route of result.routes) {
      expect(route.nodeIds).toHaveLength(8);
      expect(new Set(route.nodeIds).size).toBe(8);
      expect(route.strength).toBeCloseTo(0.5 ** 7, 12);
    }
  });

  it("stops at the budget rather than running away, and says so", () => {
    // 12 layers of 5 is 5^10 ≈ 9.7M routes — far past the budget.
    loadDataFromCsv(layeredCsv(12, 5));
    const started = Date.now();
    const result = findRoutes("n0_0", "n11_0");
    const elapsed = Date.now() - started;
    // The budget is what keeps a Trace click from freezing the tab. Well under
    // a second on a worst-case map is the bar; the loose ceiling here is so a
    // slow CI box doesn't fail the build.
    console.log(`worst-case route search: ${elapsed}ms, ${result.total} routes found`);
    expect(elapsed).toBeLessThan(3000);
    expect(result.truncated).toBe(true);
    expect(result.routes.length).toBeGreaterThan(0);   // still gives you something to read
    expect(result.total).toBeGreaterThan(0);           // …and the count is an honest floor
    expect(PATHWAY_SEARCH_BUDGET).toBeGreaterThan(0);
  });
});

describe("the sidebar block does not rebuild its box pickers needlessly", () => {
  beforeEach(() => {
    mountAppDom();
    document.body.insertAdjacentHTML("beforeend", '<div id="pathway-panel"></div>');
    loadDataFromCsv(layeredCsv(8, 4));
  });
  afterEach(() => clearPathway());

  it("reuses the rendered <option> elements across repeated renders", () => {
    renderPathwayPanel();
    const from = document.getElementById("pathway-from")!;
    const optionCount = from.querySelectorAll("option").length;
    expect(optionCount).toBe(32);            // one per box

    renderPathwayPanel();
    renderPathwayPanel();
    // Same element, not a rebuilt one — the panel skipped the expensive half.
    expect(document.getElementById("pathway-from")).toBe(from);
  });

  it("rebuilds them when a trace changes which boxes the pickers point at", () => {
    renderPathwayPanel();
    const before = document.getElementById("pathway-from");
    startPathway("n0_1", "n7_2");
    renderPathwayPanel();
    expect(state.pathway.fromId).toBe("n0_1");
    expect(document.getElementById("pathway-from")).not.toBe(before);
    expect((document.getElementById("pathway-from") as HTMLSelectElement).value).toBe("n0_1");
  });

  it("always refreshes the routes list, cheap half or not", () => {
    startPathway("n0_0", "n7_0");
    renderPathwayPanel();
    expect(document.querySelectorAll("#pathway-panel .pathway-route").length).toBe(10);
    clearPathway();
    renderPathwayPanel();
    expect(document.querySelectorAll("#pathway-panel .pathway-route").length).toBe(0);
  });
});
