import { describe, it } from "vitest";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import { recomputeValues } from "../assets/js/07-simulation-engine";
import { state, NODES, EDGES, nodeById, incomingEdges, topologicalOrder } from "../assets/js/03-state";
import { resolveEdgeElasticity } from "../assets/js/07-simulation-engine";

function buildCsv(opts: {
  nodes: number;
  fanout: number;
  loop?: boolean;
  loopGain?: number;
  formulaEvery?: number;
}): string {
  const N = opts.nodes;
  let s = `# SECTION: streams
id,label,short,color
ops,Operations,OPS,#60a5fa

# SECTION: stages
id,label
`;
  const STAGES = 20;
  for (let i = 0; i < STAGES; i++) s += `s${i},Stage ${i}\n`;
  s += `
# SECTION: categories
id,label,color,text_color,class
cat,General,#a3a3a3,#111111,primary

# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max,combine,formula,min,max
`;
  for (let i = 0; i < N; i++) {
    const stage = "s" + (i % STAGES);
    const controllable = i % STAGES === 0 ? "true" : "";
    let formula = "";
    if (opts.formulaEvery && i % opts.formulaEvery === 0 && i >= STAGES) {
      // reads its first two upstream sources
      const a = i - STAGES;
      const b = Math.max(0, i - STAGES - 1);
      formula = `"min(n${a} * 0.5 + n${b} * 0.5, n${a} * 2)"`;
    }
    s += `n${i},Node ${i},,ops,${stage},cat,100,units,${controllable},,${controllable ? "4" : ""},,${formula},,\n`;
  }
  s += `
# SECTION: edges
from,to,effect,elasticity,style,description
`;
  const lines: string[] = [];
  for (let i = STAGES; i < N; i++) {
    for (let f = 0; f < opts.fanout; f++) {
      const src = i - STAGES - f;
      if (src < 0) continue;
      lines.push(`n${src},n${i},increases,0.2,,`);
    }
  }
  if (opts.loop) {
    // one feedback loop with the requested gain: last node back to an early one
    const g = opts.loopGain ?? 0.9;
    lines.push(`n${N - 1},n${STAGES},increases,${g},,`);
  }
  s += lines.join("\n") + "\n";
  return s;
}

function time(label: string, fn: () => void, runs = 20): void {
  fn(); // warm
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) fn();
  const t1 = performance.now();
  // eslint-disable-next-line no-console
  console.log(
    `${label}: ${((t1 - t0) / runs).toFixed(2)} ms/tick  (nodes=${NODES.length} edges=${EDGES.length} iters=${state.solverStatus.iterations} converged=${state.solverStatus.converged})`,
  );
}

// Mirror of the engine's sweep WITHOUT the trace pass, to split solve vs explain.
function solveOnly(): void {
  const values: Record<string, number> = {};
  for (const node of NODES) {
    if (node.baseline === undefined || node.baseline === null) continue;
    values[node.id] = node.controllable
      ? node.baseline * (state.userOverrides[node.id] ?? 1)
      : node.baseline;
  }
  for (const nodeId of topologicalOrder) {
    const node = nodeById[nodeId];
    if (!node || node.baseline === undefined || node.controllable) continue;
    let logSum = 0;
    for (const edge of incomingEdges[nodeId]) {
      const src = nodeById[edge.from];
      if (!src || !src.baseline || values[edge.from] === undefined) continue;
      logSum +=
        resolveEdgeElasticity(edge) * Math.log(Math.max(values[edge.from] / src.baseline, 1e-6));
    }
    values[nodeId] = node.baseline * Math.exp(logSum);
  }
}

describe("perf scratch", () => {
  it("solve-only vs recompute (5000n)", () => {
    loadDataFromCsv(buildCsv({ nodes: 5000, fanout: 4 }));
    let m = 1;
    time("SOLVE-ONLY 5000n/20000e", () => {
      state.userOverrides = { n0: (m += 0.01) };
      solveOnly();
    });
    time("recomputeValues 5000n/20000e", () => {
      state.userOverrides = { n0: (m += 0.01) };
      recomputeValues();
    });
  });

  it("tight high-gain loop", () => {
    let csv = buildCsv({ nodes: 2000, fanout: 4 });
    // tight 3-cycle with round-trip gain 0.9^3 = 0.729
    csv = csv.replace(
      "\n# SECTION: edges\nfrom,to,effect,elasticity,style,description\n",
      "\n# SECTION: edges\nfrom,to,effect,elasticity,style,description\nn100,n200,increases,0.9,,\nn200,n300,increases,0.9,,\nn300,n100,increases,0.9,,\n",
    );
    loadDataFromCsv(csv);
    let m = 1;
    time("tight loop gain .729, 2000n", () => {
      state.userOverrides = { n0: (m += 0.01) };
      recomputeValues();
    }, 5);
  });

  it("acyclic", () => {
    loadDataFromCsv(buildCsv({ nodes: 2000, fanout: 4 }));
    let m = 1;
    time("acyclic 2000n/8000e", () => {
      state.userOverrides = { n0: (m += 0.01) };
      recomputeValues();
    });
  });

  it("acyclic large", () => {
    loadDataFromCsv(buildCsv({ nodes: 5000, fanout: 4 }));
    let m = 1;
    time("acyclic 5000n/20000e", () => {
      state.userOverrides = { n0: (m += 0.01) };
      recomputeValues();
    });
  });

  it("cyclic gain 0.9", () => {
    loadDataFromCsv(buildCsv({ nodes: 2000, fanout: 4, loop: true, loopGain: 0.9 }));
    let m = 1;
    time("cyclic(gain .9) 2000n", () => {
      state.userOverrides = { n0: (m += 0.01) };
      recomputeValues();
    }, 5);
  });

  it("cyclic gain 0.3", () => {
    loadDataFromCsv(buildCsv({ nodes: 2000, fanout: 4, loop: true, loopGain: 0.3 }));
    let m = 1;
    time("cyclic(gain .3) 2000n", () => {
      state.userOverrides = { n0: (m += 0.01) };
      recomputeValues();
    }, 5);
  });

  it("formula heavy", () => {
    loadDataFromCsv(buildCsv({ nodes: 2000, fanout: 4, formulaEvery: 2 }));
    let m = 1;
    time("formula-every-2 2000n", () => {
      state.userOverrides = { n0: (m += 0.01) };
      recomputeValues();
    });
  });
});
