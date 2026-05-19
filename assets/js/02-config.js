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

// Key strings used in the CSV's `defaults` section. Centralised here so the
// CSV parser (06-data-loader.js), serializer (05a-csv-serializer.js), and
// the wizard's "Start from sample" path (16a-builder-panel.js) all reference
// the same source of truth.
const ELASTICITY_KEYS = {
  enables:   "elasticity_enables",
  increases: "elasticity_increases",
  decreases: "elasticity_decreases",
};
