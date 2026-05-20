// =============================================================================
// LAYOUT CONFIG — tweakable size constants
// -----------------------------------------------------------------------------
// All hard-coded pixel sizes used when drawing the map live here. Change these
// numbers (and reload the page) to make nodes wider, columns more spaced out,
// etc. There is no need to touch any of the other JS files to do this.
// =============================================================================

// Size of each node (rectangle) drawn on the map, in pixels.
const NODE_WIDTH  = 220;
const NODE_HEIGHT = 70;

// Vertical gap between two stacked nodes in the same cell.
const NODE_GAP_Y = 8;

// Padding at the top and bottom of every stream row.
const ROW_PADDING = 16;

// Height of a stream row when its stream is hidden (collapsed). Just tall
// enough to fit the short label so the user can click it to expand again.
const COLLAPSED_ROW_HEIGHT = 28;

// Horizontal gap between the columns of nodes.
const COL_GAP = 90;

// Width of the row-label strip (e.g. "AIR", "RORO") on the left.
const ROW_HEADER_WIDTH = 110;

// Height of the column header band at the top.
const COL_HEADER_HEIGHT = 40;

// Outer padding around the SVG drawing area.
const SVG_PADDING_LEFT   = 24;
const SVG_PADDING_TOP    = 12;
const SVG_PADDING_RIGHT  = 24;
const SVG_PADDING_BOTTOM = 24;

// Map-text auto-enlargement when the user zooms out.
//
// Below a zoom of TEXT_SCALE_RATIO we grow SVG font-size inversely with
// zoom so on-screen text stays readable. TEXT_SCALE_MAX caps the growth so
// labels do not spill out of node-rects or crash into the value/delta line.
// 1.4× is a deliberate trade-off: typical labels (under ~20 chars) stay
// inside their rect, while a worst-case 24-char label may overflow slightly
// at minimum zoom — accepted in exchange for the readability win.
const TEXT_SCALE_RATIO = 0.85;
const TEXT_SCALE_MAX   = 1.4;

// Key strings used in the CSV's `defaults` section. Centralised here so the
// CSV parser (06-data-loader.js), serializer (05a-csv-serializer.js), and
// the wizard's "Start from sample" path (16a-builder-panel.js) all reference
// the same source of truth.
const ELASTICITY_KEYS = {
  enables:   "elasticity_enables",
  increases: "elasticity_increases",
  decreases: "elasticity_decreases",
};

// ─── Shared option lists ─────────────────────────────────────────────────
// Used by the wizard (16a/16b), the detail panel (15), the canvas edge
// effect picker (16e), and the CSV loader's validation (06). One source of
// truth — change the list here and every UI affected updates.

// The three causal-link kinds an edge can carry.
const EFFECT_OPTIONS = ["enables", "increases", "decreases"];

// Outcome direction-of-merit values. The blank entry is the "(no preference)"
// option in dropdowns.
const DIRECTION_OPTIONS = ["", "higher_better", "lower_better", "neutral"];

// Colour palette cycled through when seeding a new stream / category so
// adjacent ones visually differ. Used by addStream / addCategory (16e) and
// the wizard.
const STREAM_COLOR_PALETTE = [
  "#60a5fa",  // blue
  "#a78bfa",  // purple
  "#34d399",  // emerald
  "#f59e0b",  // amber
  "#f472b6",  // pink
  "#22d3ee",  // cyan
  "#fb7185",  // rose
  "#84cc16",  // lime
];
