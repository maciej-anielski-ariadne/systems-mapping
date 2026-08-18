import { describe, it } from "vitest";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import { render, svg } from "../assets/js/11-rendering";
import { layout } from "../assets/js/03-state";

function bigCsv(n: number, e: number, streams: number, stages: number): string {
  let nodeRows = "";
  for (let i = 0; i < n; i++) {
    nodeRows += `node${i},Node label number ${i} here,,st${i % streams},s${i % stages},cat,100,u,,,\n`;
  }
  let streamRows = "";
  for (let s = 0; s < streams; s++) streamRows += `st${s},Stream ${s},S${s},#60a5fa\n`;
  let stageRows = "";
  for (let s = 0; s < stages; s++) stageRows += `s${s},Stage ${s}\n`;
  let edgeRows = "";
  let made = 0;
  for (let i = 0; i < n && made < e; i++) {
    for (let k = 1; k <= Math.ceil(e / n) && made < e; k++) {
      const to = (i + k * stages) % n;
      if (to === i) continue;
      edgeRows += `node${i},node${to},increases,0.2,,\n`;
      made++;
    }
  }
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

function mockViewport(w: number, h: number, sl = 0, st = 0): void {
  const el = document.getElementById("viz-scroll")!;
  for (const [p, v] of [["clientWidth", w], ["clientHeight", h], ["scrollLeft", sl], ["scrollTop", st]] as const) {
    Object.defineProperty(el, p, { value: v, configurable: true, writable: true });
  }
}

function bench(n: number, e: number): void {
  loadDataFromCsv(bigCsv(n, e, 10, 20));
  // Scroll far past the end of the map so NOTHING is inside the cull rect:
  // isolates the fixed per-render scan cost from the emit cost.
  mockViewport(1400, 900, 10_000_000, 10_000_000);
  render();
  let best = Infinity;
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    render();
    best = Math.min(best, performance.now() - t);
  }
  console.log(`N=${n} E=${e} map=${layout.totalWidth}x${layout.totalHeight} ` +
    `EMPTY-SLICE render best=${best.toFixed(1)}ms drawn=${svg.querySelectorAll(".node-group").length} ` +
    `els=${svg.querySelectorAll("*").length}`);
}

describe("perf scratch 3", () => {
  it("fixed per-render scan cost", () => {
    bench(500, 2500);
    bench(1000, 5000);
    bench(2000, 10000);
  }, 300000);
});
