// =============================================================================
// LAYOUT — decide where every node sits on the canvas
// -----------------------------------------------------------------------------
// `computeLayout` runs once after a CSV is loaded. It works out:
//   • the height of each stream row (tall enough to fit its busiest cell)
//   • the X position of each column (based on stage order)
//   • the X/Y position of every node (within its (stream, stage) cell)
//   • the overall SVG width/height
//
// The result is stored in the global `layout` object (see 03-state.js) and is
// then used by the renderer in 11-rendering.js to actually draw things.
// =============================================================================

function computeLayout() {
  // ───── Group nodes into (stream, stage) cells ─────────────────────────
  const cells = {};
  for (const node of NODES) {
    const key = node.stream + ":" + node.stage;
    if (!cells[key]) cells[key] = [];
    cells[key].push(node);
  }

  // ───── Height of each stream row (max nodes in any of its cells) ──────
  // Hidden streams get a compact COLLAPSED_ROW_HEIGHT instead — their row
  // label stays visible as a clickable stub so the user can re-expand.
  const rowHeights = {};
  for (const stream of STREAMS) {
    if (state.hiddenStreams.has(stream.id)) {
      rowHeights[stream.id] = COLLAPSED_ROW_HEIGHT;
      continue;
    }
    let maxNodesInCell = 0;
    for (const stage of STAGES) {
      const cellNodes = cells[stream.id + ":" + stage.id] || [];
      if (cellNodes.length > maxNodesInCell) maxNodesInCell = cellNodes.length;
    }
    // Minimum 1 unit tall even if every cell is empty, so the row header
    // still has somewhere to sit.
    const units = Math.max(1, maxNodesInCell);
    rowHeights[stream.id] = units * NODE_HEIGHT + (units - 1) * NODE_GAP_Y + ROW_PADDING * 2;
  }

  // ───── Cumulative Y position for each row ─────────────────────────────
  const rowY = {};
  let cursorY = SVG_PADDING_TOP + COL_HEADER_HEIGHT;
  for (const stream of STREAMS) {
    rowY[stream.id] = cursorY;
    cursorY += rowHeights[stream.id];
  }
  const totalHeight = cursorY + SVG_PADDING_BOTTOM;

  // ───── X position for each column ─────────────────────────────────────
  const colX = {};
  let cursorX = SVG_PADDING_LEFT + ROW_HEADER_WIDTH;
  for (const stage of STAGES) {
    colX[stage.id] = cursorX;
    cursorX += NODE_WIDTH + COL_GAP;
  }
  const totalWidth = cursorX - COL_GAP + SVG_PADDING_RIGHT;

  // ───── Position every individual node ─────────────────────────────────
  const positions = {};
  for (const stream of STREAMS) {
    for (const stage of STAGES) {
      const cellNodes = cells[stream.id + ":" + stage.id] || [];
      const cellTopY = rowY[stream.id] + ROW_PADDING;
      for (let nodeIdx = 0; nodeIdx < cellNodes.length; nodeIdx++) {
        positions[cellNodes[nodeIdx].id] = {
          x: colX[stage.id],
          y: cellTopY + nodeIdx * (NODE_HEIGHT + NODE_GAP_Y),
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
        };
      }
    }
  }

  return {
    positions,
    totalWidth,
    totalHeight,
    rowY,
    rowHeights,
    colX,
    cells,
  };
}
