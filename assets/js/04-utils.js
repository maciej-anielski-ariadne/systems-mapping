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
