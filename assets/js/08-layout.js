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
  //
  // While the user is hovering a cell whose contents are already at the
  // row's max-slot count, we reserve one extra slot so the ghost preview
  // ("+ add another") has somewhere to sit without overlapping the row
  // below. The slot disappears the moment the hover leaves.
  const hoverCell = (state.canvasEdit && state.canvasEdit.hoverCell) || null;
  // During a node drag, the dropCell behaves like hoverCell: we reserve one
  // extra slot in the target cell so the insertion drop-line has somewhere to
  // sit without overlapping nodes below. The dragged node is still in NODES
  // (rendered ghosted in its source cell), so the source row already has the
  // right height.
  const dragDropCell = (state.canvasEdit && state.canvasEdit.draggingNode && state.canvasEdit.draggingNode.dropCell) || null;
  const draggedNodeId = (state.canvasEdit && state.canvasEdit.draggingNode && state.canvasEdit.draggingNode.nodeId) || null;
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
    if (hoverCell && hoverCell.streamId === stream.id) {
      const inHoverCell = (cells[stream.id + ":" + hoverCell.stageId] || []).length;
      if (inHoverCell + 1 > maxNodesInCell) maxNodesInCell = inHoverCell + 1;
    }
    if (dragDropCell && dragDropCell.streamId === stream.id) {
      // Count cell-occupants excluding the dragged node (which will leave
      // its source cell when the drop commits, but is still in NODES now).
      const cellNodes = cells[stream.id + ":" + dragDropCell.stageId] || [];
      let inCell = 0;
      for (const n of cellNodes) if (n.id !== draggedNodeId) inCell++;
      if (inCell + 1 > maxNodesInCell) maxNodesInCell = inCell + 1;
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
      // While the placeholder hovers this cell, part the stack: every note at
      // or after the insert slot drops down one slot so the shadow placeholder
      // has an open gap to sit in (the renderer draws it at the same slot).
      const gapAt = (hoverCell && hoverCell.streamId === stream.id &&
                     hoverCell.stageId === stage.id && hoverCell.insertIndex != null)
                  ? hoverCell.insertIndex : null;
      for (let nodeIdx = 0; nodeIdx < cellNodes.length; nodeIdx++) {
        const slot = (gapAt !== null && nodeIdx >= gapAt) ? nodeIdx + 1 : nodeIdx;
        positions[cellNodes[nodeIdx].id] = {
          x: colX[stage.id],
          y: cellTopY + slot * (NODE_HEIGHT + NODE_GAP_Y),
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
