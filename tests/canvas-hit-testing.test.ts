// =============================================================================
// CANVAS HIT-TESTING — cell-indexed lookups must match the full scans
// -----------------------------------------------------------------------------
// The pointer paths in 16e (which box is under the cursor, which boxes a marquee
// covers, where a drag would land) used to walk the whole NODES array on every
// mousemove. They now resolve the (stream, stage) cell first and test only what
// is in it, reading computeLayout's cell index. These tests pin the answers to
// the brute-force ones they replaced.
// =============================================================================
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import { render } from "../assets/js/11-rendering";
import {
  dropCellForDrag,
  endMarquee,
  insertionGapCell,
  nodeAtLayoutPoint,
  startMarquee,
  updateMarqueeSelection,
} from "../assets/js/16e-canvas-edit";
import { deselectAll } from "../assets/js/09-graph-selection";
import { isNodeVisible } from "../assets/js/10-filters";
import { NODES, layout, state } from "../assets/js/03-state";

// Two streams × three stages, several boxes stacked per cell.
function gridCsv(): string {
  let nodeRows = "";
  for (const stream of ["ops", "sup"]) {
    for (const stage of ["s1", "s2", "s3"]) {
      for (let k = 0; k < 3; k++) nodeRows += `${stream}_${stage}_${k},Box ${stream} ${stage} ${k},,${stream},${stage},cat,,,,,\n`;
    }
  }
  return `# SECTION: streams
id,label,short,color
ops,Operations,OPS,#60a5fa
sup,Support,SUP,#f59e0b

# SECTION: stages
id,label
s1,Start
s2,Middle
s3,End

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

// The answer the old full-NODES scan gave.
function scanNodeAt(x: number, y: number): string | null {
  for (const node of NODES) {
    if (!isNodeVisible(node)) continue;
    const p = layout.positions[node.id];
    if (!p) continue;
    if (x >= p.x && x < p.x + p.width && y >= p.y && y < p.y + p.height) return node.id;
  }
  return null;
}

function scanMarqueeHits(x1: number, y1: number, x2: number, y2: number): string[] {
  const hits: string[] = [];
  for (const node of NODES) {
    if (!isNodeVisible(node)) continue;
    const p = layout.positions[node.id];
    if (!p) continue;
    if (p.x < x2 && p.x + p.width > x1 && p.y < y2 && p.y + p.height > y1) hits.push(node.id);
  }
  return hits;
}

describe("canvas hit-testing", () => {
  beforeEach(() => {
    loadDataFromCsv(gridCsv());
    render();
  });
  afterEach(() => {
    state.canvasEdit.marquee = null;
    deselectAll();
  });

  it("nodeAtLayoutPoint agrees with a full scan, inside boxes and in the gaps", () => {
    const probes: Array<[number, number]> = [];
    for (const id of Object.keys(layout.positions)) {
      const p = layout.positions[id];
      probes.push([p.x + 1, p.y + 1]);                       // top-left corner
      probes.push([p.x + p.width / 2, p.y + p.height / 2]);  // centre
      probes.push([p.x + p.width / 2, p.y + p.height + 4]);  // the gap below
      probes.push([p.x - 12, p.y + p.height / 2]);           // just left of the column
    }
    probes.push([0, 0], [-50, -50], [99999, 99999]);
    for (const [x, y] of probes) {
      expect(nodeAtLayoutPoint(x, y), `at ${x},${y}`).toBe(scanNodeAt(x, y));
    }
  });

  it("nodeAtLayoutPoint skips boxes hidden by a category filter", () => {
    const target = NODES[0];
    const p = layout.positions[target.id];
    expect(nodeAtLayoutPoint(p.x + 5, p.y + 5)).toBe(target.id);
    state.hiddenCategories = new Set(["cat"]);
    expect(nodeAtLayoutPoint(p.x + 5, p.y + 5)).toBe(null);
    state.hiddenCategories = new Set();
  });

  it("marquee selection matches the full scan for a range of boxes", () => {
    startMarquee({ x: 0, y: 0 }, new MouseEvent("mousemove"));
    const rects: Array<[number, number, number, number]> = [
      [0, 0, layout.totalWidth, layout.totalHeight],   // everything
      [0, 0, 1, 1],                                    // nothing
      [0, 0, layout.totalWidth / 2, layout.totalHeight / 2],
      [layout.totalWidth / 3, layout.totalHeight / 3, layout.totalWidth, layout.totalHeight],
    ];
    for (const [x1, y1, x2, y2] of rects) {
      state.canvasEdit.marquee = { startX: x1, startY: y1, currentX: x2, currentY: y2 };
      updateMarqueeSelection();
      const expected = scanMarqueeHits(x1, y1, x2, y2);
      expect([...state.selectedNodeIds].sort()).toEqual([...expected].sort());
      // The primary is the last hit in NODES order, exactly as the scan picked it.
      expect(state.selectedNodeId).toBe(expected.length ? expected[expected.length - 1] : null);
    }
    endMarquee();
  });

  it("dropCellForDrag lands a dragged box in the slot the cursor is over", () => {
    const stack = layout.cells!["ops:s2"];
    const second = layout.positions[stack[1].id];
    // Cursor just above the middle of the second box, dragging a box from
    // another cell → it inserts before that box.
    const drop = dropCellForDrag(second.x + 10, second.y + 2, "sup_s1_0");
    expect(drop).toMatchObject({ streamId: "ops", stageId: "s2", insertIndex: 1 });

    // Dragging one of the cell's OWN boxes excludes it from the sibling list,
    // so the slots below it shift up by one: the same cursor position now names
    // the slot after the (single) sibling above it.
    const dropSelf = dropCellForDrag(second.x + 10, second.y + 2, stack[0].id);
    expect(dropSelf).toMatchObject({ streamId: "ops", stageId: "s2", insertIndex: 1 });

    // Off the grid entirely.
    expect(dropCellForDrag(-100, -100, "sup_s1_0")).toBe(null);
  });

  it("insertionGapCell only fires in the gaps between boxes", () => {
    const stack = layout.cells!["ops:s1"];
    const first = layout.positions[stack[0].id];
    // Over a box body → no placeholder.
    expect(insertionGapCell(first.x + 10, first.y + 5)).toBe(null);
    // In the gap under the first box → insert at slot 1.
    expect(insertionGapCell(first.x + 10, first.y + first.height + 2))
      .toMatchObject({ streamId: "ops", stageId: "s1", insertIndex: 1 });
  });
});
