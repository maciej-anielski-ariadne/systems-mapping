import { describe, it, expect, beforeEach } from "vitest";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import { computeLayout } from "../assets/js/08-layout";
import { state } from "../assets/js/03-state";
import {
  COLLAPSED_ROW_HEIGHT,
  NODE_WIDTH,
  OVERVIEW_COLUMN_MINIMUM_SCREEN_WIDTH,
  nodeWidthForZoom,
} from "../assets/js/02-config";
import { LINEAR_CSV } from "./fixtures/graphs";

describe("computeLayout (linear chain, 1 row × 3 columns)", () => {
  beforeEach(() => {
    loadDataFromCsv(LINEAR_CSV);
    state.zoomLevel = 1;
  });

  it("positions every node and orders columns left-to-right", () => {
    const layout = computeLayout();
    expect(Object.keys(layout.positions).sort()).toEqual(["a", "b", "c"]);
    expect(layout.colX.s1).toBeLessThan(layout.colX.s2);
    expect(layout.colX.s2).toBeLessThan(layout.colX.s3);
    expect(layout.totalWidth).toBeGreaterThan(0);
    expect(layout.totalHeight).toBeGreaterThan(0);
  });

  it("groups nodes into (stream:stage) cells", () => {
    const layout = computeLayout();
    expect(layout.cells?.["ops:s1"]?.map((n) => n.id)).toEqual(["a"]);
    expect(layout.cells?.["ops:s3"]?.map((n) => n.id)).toEqual(["c"]);
  });

  it("collapses a hidden stream's row to the stub height", () => {
    state.hiddenStreams = new Set(["ops"]);
    const layout = computeLayout();
    expect(layout.rowHeights.ops).toBe(COLLAPSED_ROW_HEIGHT);
  });

  it("widens open columns at overview zoom to preserve a readable screen width", () => {
    state.zoomLevel = 0.25;
    const layout = computeLayout();
    const expectedColumnWidth = OVERVIEW_COLUMN_MINIMUM_SCREEN_WIDTH / state.zoomLevel;

    expect(nodeWidthForZoom(1)).toBe(NODE_WIDTH);
    expect(layout.colWidths.s1).toBe(expectedColumnWidth);
    expect(layout.colWidths.s1 * state.zoomLevel)
      .toBe(OVERVIEW_COLUMN_MINIMUM_SCREEN_WIDTH);
    expect(layout.positions.a.width).toBe(NODE_WIDTH);
    expect(layout.positions.a.x).toBe(
      layout.colX.s1 + (layout.colWidths.s1 - NODE_WIDTH) / 2,
    );
  });
});
