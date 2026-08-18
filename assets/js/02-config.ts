// =============================================================================
// LAYOUT CONFIG — tweakable size constants
// -----------------------------------------------------------------------------
// All hard-coded pixel sizes used when drawing the map live here. Change these
// numbers (and reload the page) to make nodes wider, columns more spaced out,
// etc. There is no need to touch any of the other JS files to do this.
// =============================================================================

// Size of each node (rectangle) drawn on the map, in pixels.
export const NODE_WIDTH  = 220;
// Minimum / default node-box height. Real nodes "grow to fit" their label —
// the height is computed from how many lines the name wraps to (nodeBoxHeight
// in 08-layout.js), floored at NODE_HEIGHT. A brand-new single-line node, the
// "type to create" cursor slot, the hover "+ add node" ghost, and empty rows
// are all exactly this tall.
export const NODE_HEIGHT = 40;   // Compact density (was 44; the 44px panel-header /
                          // strip "rhyme" moves to 40 in 03-app-shell.css too)

// Vertical gap between two stacked nodes in the same cell.
export const NODE_GAP_Y = 8;

// Grow-to-fit label metrics.
//   LABEL_INSET       – left text inset inside a node (also clears the
//                       stream-colour stripe); this is where the label's x sits.
//   LABEL_INSET_RIGHT – right text inset, a touch larger than the left so labels
//                       wrap before the text runs right up to the node's edge.
//   NODE_LINE_STEP    – vertical advance between wrapped label lines (matches the
//                       renderer's dy of 1.083em at the 12px label font).
export const LABEL_INSET       = 14;
export const LABEL_INSET_RIGHT = 20;
export const NODE_LINE_STEP    = 13;

// Padding at the top and bottom of every stream row.
export const ROW_PADDING = 12;   // Compact (was 16)

// Height of a stream row when its stream is hidden (collapsed). Just tall
// enough to fit the short label so the user can click it to expand again.
export const COLLAPSED_ROW_HEIGHT = 28;

// Width of a stage column when its stage is hidden (collapsed). Just wide
// enough to show a clickable stub the user can click to expand again.
export const COLLAPSED_COL_WIDTH = 28;

// Horizontal gap between the columns of nodes.
export const COL_GAP = 64;   // Compact (was 90)

// Edge anchor fan-out. When several edges enter (or leave) the same node, they
// no longer all land on the vertical centre of the face — they fan out, one
// landing point per (effect, line-style) bucket, so differently-coloured arrows
// stop merging into one another. FAN_SPACING is the ideal vertical gap between
// adjacent buckets; the actual gap is clamped so all anchors stay inside the
// node face (height minus 2×FAN_MARGIN at top and bottom). See
// computeEdgeAnchorOffsets in 04-utils.ts.
export const FAN_SPACING = 9;
export const FAN_MARGIN  = 8;

// Width of the row-label strip (e.g. "AIR", "RORO") on the left.
export const ROW_HEADER_WIDTH = 96;   // Compact (was 110)

// Height of the column header band at the top.
export const COL_HEADER_HEIGHT = 40;

// Outer padding around the SVG drawing area. Symmetric (was asymmetric:
// top 12 / sides+bottom 24) and tightened for the Compact density.
export const SVG_PADDING_LEFT   = 16;
export const SVG_PADDING_TOP    = 16;
export const SVG_PADDING_RIGHT  = 16;
export const SVG_PADDING_BOTTOM = 16;

// Map-text auto-enlargement when the user zooms out.
//
// Below a zoom of TEXT_SCALE_RATIO we grow SVG font-size inversely with
// zoom so on-screen text stays readable. TEXT_SCALE_MAX caps the growth so
// labels do not spill out of node-rects or crash into the value/delta line.
// 1.4× is a deliberate trade-off: typical labels (under ~20 chars) stay
// inside their rect, while a worst-case 24-char label may overflow slightly
// at minimum zoom — accepted in exchange for the readability win.
export const TEXT_SCALE_RATIO = 0.85;
export const TEXT_SCALE_MAX   = 1.4;

// Key strings used in the CSV's `defaults` section. Centralised here so the
// CSV parser (06-data-loader.js), serializer (05a-csv-serializer.js), and
// the wizard's "Start from sample" path (16a-builder-panel.js) all reference
// the same source of truth.
export const ELASTICITY_KEYS = {
  enables:   "elasticity_enables",
  increases: "elasticity_increases",
  decreases: "elasticity_decreases",
};

// ─── Shared option lists ─────────────────────────────────────────────────
// Used by the wizard (16a/16b), the detail panel (15), the canvas edge
// effect picker (16e), and the CSV loader's validation (06). One source of
// truth — change the list here and every UI affected updates.

// The three causal-link kinds an edge can carry.
export const EFFECT_OPTIONS = ["enables", "increases", "decreases"];

// Outcome direction-of-merit values. The blank entry is the "(no preference)"
// option in dropdowns.
export const DIRECTION_OPTIONS = ["", "higher_better", "lower_better", "neutral"];

// How a box aggregates the arrows pointing into it. The blank entry is the
// "(default)" option in dropdowns, and a blank CSV cell means the same thing:
// multiplicative, i.e. exactly what the app did before the column existed.
// The loader validates against this same list (minus the blank) — see
// COMBINE_MODES in 06-data-loader.js, CombineMode in types.js and
// docs/CALCULATION-ENGINE-DESIGN.md §3.2.
export const COMBINE_OPTIONS = ["", "multiplicative", "additive", "min"];

// Colour palette cycled through when seeding a new stream / category so
// adjacent ones visually differ. Used by addStream / addCategory (16e) and
// the wizard.
export const STREAM_COLOR_PALETTE = [
  "#60a5fa",  // blue
  "#a78bfa",  // purple
  "#34d399",  // emerald
  "#f59e0b",  // amber
  "#f472b6",  // pink
  "#22d3ee",  // cyan
  "#fb7185",  // rose
  "#84cc16",  // lime
];
