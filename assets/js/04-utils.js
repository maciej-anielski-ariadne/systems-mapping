// =============================================================================
// UTILITY HELPERS — small functions used in many places
// -----------------------------------------------------------------------------
// Small helpers:
//   • wrapLabel       – split a node label across two lines if it's too long
//   • escapeHtml      – make user text safe to inject into HTML/SVG strings
//   • formatScalar    – format a number for display ("9,000", "1.25", etc.)
//   • getMapTextScale – font-scale multiplier for the map when zoomed out
// =============================================================================

// Split `text` into up to 2 lines, each no more than `maxCharsPerLine` chars.
// Words are kept whole; if a third line would be needed, the second line is
// truncated with an ellipsis.
function wrapLabel(text, maxCharsPerLine) {
  if (text.length <= maxCharsPerLine) return [text];

  const words = text.split(" ");
  const lines = [];
  let currentLine = "";

  for (const word of words) {
    if ((currentLine + " " + word).trim().length <= maxCharsPerLine) {
      currentLine = (currentLine + " " + word).trim();
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);

  // Limit to 2 lines, adding an ellipsis on the second if there was more.
  // If line 2 is already at the character limit, drop its last char first so
  // the ellipsis doesn't push it past `maxCharsPerLine`.
  if (lines.length > 2) {
    if (lines[1].length >= maxCharsPerLine) {
      lines[1] = lines[1].slice(0, maxCharsPerLine - 1);
    }
    lines[1] = lines[1] + "…";
    return lines.slice(0, 2);
  }
  return lines;
}

// Wrap a node label to fill a pixel width, measuring real text width at the
// node-label font (Arial 12px / weight 500) rather than guessing by character
// count. Returns an array of lines (words kept whole; a single word wider than
// the line is left to overflow, same as before). No line cap — the box "grows
// to fit", so the caller derives the node height from the line count. Cached by
// `width|text` since computeLayout may re-run often (drag, hover) and labels
// rarely change. The font must match .node-label in 05-visualization.css.
const _labelLineCache = new Map();
let _labelMeasureCtx = null;
function measureLabelLines(text, maxWidthPx) {
  text = String(text == null ? "" : text);
  if (!text) return [""];
  const key = maxWidthPx + "|" + text;
  const cached = _labelLineCache.get(key);
  if (cached) return cached;

  if (!_labelMeasureCtx) {
    _labelMeasureCtx = document.createElement("canvas").getContext("2d");
  }
  _labelMeasureCtx.font = "500 12px Arial, Helvetica, sans-serif";

  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const trial = current ? current + " " + word : word;
    // Start a new line once adding the word would exceed the width — but never
    // on an empty line (a lone over-wide word stays whole and overflows).
    if (current && _labelMeasureCtx.measureText(trial).width > maxWidthPx) {
      lines.push(current);
      current = word;
    } else {
      current = trial;
    }
  }
  if (current) lines.push(current);
  const result = lines.length ? lines : [""];
  _labelLineCache.set(key, result);
  return result;
}

// Replace the five HTML-unsafe characters with their entity equivalents so the
// resulting text is safe to inject into innerHTML / SVG markup strings.
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Format a number for display. The decimal precision depends on magnitude:
//   • Above 1 billion: e.g. "1.25" (with implied "bn" elsewhere)
//   • 10,000 and up:   thousands-separated integer ("9,000")
//   • 100 to 9,999:    integer ("250")
//   • 10 to 99:        one decimal ("12.5")
//   • 1 to 9:          two decimals ("3.14")
//   • Below 1:         three decimals ("0.125")
function formatScalar(value) {
  const absValue = Math.abs(value);
  if (absValue >= 1e9)    return (value / 1e9).toFixed(2);
  if (absValue >= 10000)  return Math.round(value).toLocaleString();
  if (absValue >= 100)    return Math.round(value).toString();
  if (absValue >= 10)     return value.toFixed(1);
  if (absValue >= 1)      return value.toFixed(2);
  return value.toFixed(3);
}

// Map text-scale multiplier given the current zoom level. As the user zooms
// out below TEXT_SCALE_RATIO, SVG font-sizes grow inversely with zoom so
// on-screen text stays roughly readable, capped at TEXT_SCALE_MAX so labels
// don't spill out of node-rects. At zoom >= TEXT_SCALE_RATIO this returns
// 1.0 (no scaling). Set as the --map-text-scale CSS variable on #viz-svg
// by both render() and applyZoom().
function getMapTextScale(zoomLevel) {
  if (!zoomLevel || isNaN(zoomLevel) || zoomLevel <= 0) return 1;
  return Math.min(TEXT_SCALE_MAX, Math.max(1, TEXT_SCALE_RATIO / zoomLevel));
}

// Pick the label colour — pure white or near-black — that maximises contrast
// against a given background fill, so category labels stay readable whatever
// fill the user picks. Uses the WCAG relative-luminance crossover (~0.179):
// light fills get dark text, dark fills get white. Accepts #rgb / #rrggbb;
// falls back to white for anything unparseable.
function pickTextColor(bgHex) {
  const hex = String(bgHex || "").trim().replace(/^#/, "");
  let r, g, b;
  if (hex.length === 3) {
    r = parseInt(hex[0] + hex[0], 16);
    g = parseInt(hex[1] + hex[1], 16);
    b = parseInt(hex[2] + hex[2], 16);
  } else if (hex.length === 6) {
    r = parseInt(hex.slice(0, 2), 16);
    g = parseInt(hex.slice(2, 4), 16);
    b = parseInt(hex.slice(4, 6), 16);
  } else {
    return "#ffffff";
  }
  if ([r, g, b].some(v => isNaN(v))) return "#ffffff";
  // Relative luminance (sRGB → linear). Channels normalised to 0..1.
  const lin = c => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return luminance > 0.179 ? "#1c1917" : "#ffffff";
}

// Shallow clone of an edge object — used wherever we snapshot edges into an
// undo entry. Centralised so adding a new edge field doesn't require hunting
// through every undo path.
function cloneEdgeForUndo(edge) {
  return {
    from: edge.from,
    to: edge.to,
    effect: edge.effect,
    elasticity: edge.elasticity,
    description: edge.description,
  };
}

// Shallow clone of a node object — same role as cloneEdgeForUndo, for nodes.
function cloneNodeForUndo(node) {
  return Object.assign({}, node);
}
