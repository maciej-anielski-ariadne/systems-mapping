// =============================================================================
// MAIN SVG RENDERER
// -----------------------------------------------------------------------------
// One function — `render()` — produces the entire SVG content for the central
// visualization. It is called whenever anything visual changes: a node is
// selected, a filter is toggled, a slider is moved, a new CSV is loaded.
//
// The render is "stringly typed" — we build a single string of SVG markup and
// assign it to svg.innerHTML in one go. This is simpler and surprisingly fast
// for graphs of this size (a few hundred nodes / edges).
//
// Once the string is committed, `attachSvgEventHandlers()` wires up click,
// hover, and mousemove listeners on the freshly-inserted DOM nodes.
// =============================================================================

// Single grabbed reference to the SVG element we draw into.
const svg = document.getElementById("viz-svg");

// One-time listener: clicking the empty SVG background deselects whatever
// is selected (node OR edge). Registered ONCE here so it does not accumulate
// each time render() replaces svg.innerHTML.
svg.addEventListener("click", event => {
  // Ignore clicks on canvas-edit affordances — they manage their own state.
  if (event.target.closest && event.target.closest(".node-group, .row-label-group, .edge-handle, .ghost-cell, .edge-hit, .edge-path")) {
    return;
  }
  if (state.selectedNodeId) {
    deselectAll();
  }
});

function render() {
  // When no CSV is loaded at all, blank the SVG. The empty-state grid path
  // boots via bootEmptyStateGrid() which sets state.dataLoaded = true and
  // seeds 3 streams x 3 stages with no nodes — so an empty NODES array is
  // a valid render state and we proceed below.
  if (!state.dataLoaded) {
    svg.setAttribute("width", 0);
    svg.setAttribute("height", 0);
    svg.innerHTML = "";
    return;
  }

  // Size the SVG canvas to fit the layout, scaled by the current zoom level
  // (state.zoomLevel defaults to 1.0). The viewBox stays in unscaled layout
  // coordinates so the SVG natively rescales every element by the same factor.
  const zoom = (state.zoomLevel && !isNaN(state.zoomLevel)) ? state.zoomLevel : 1.0;
  svg.setAttribute("width",  layout.totalWidth  * zoom);
  svg.setAttribute("height", layout.totalHeight * zoom);
  svg.setAttribute("viewBox", "0 0 " + layout.totalWidth + " " + layout.totalHeight);
  // Grow SVG text-size when zoomed out (capped) so labels stay readable.
  // Picked up by `font-size: calc(<base> * var(--map-text-scale, 1))` in
  // assets/css/05-visualization.css.
  svg.style.setProperty("--map-text-scale", getMapTextScale(zoom));

  let content = "";

  // ───── <defs>: arrowhead markers for the different edge types ─────────
  content += '<defs>';
  const arrowColors = {
    default:    "var(--edge-default)",
    enables:    "var(--edge-enables)",
    increases:  "var(--edge-increases)",
    decreases:  "var(--edge-decreases)",
    ancestor:   "var(--edge-ancestor)",
    descendant: "var(--edge-descendant)",
  };
  for (const [name, color] of Object.entries(arrowColors)) {
    content += '<marker id="arrow_' + name + '" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">';
    content += '<path d="M 0 0 L 10 5 L 0 10 z" fill="' + color + '"></path>';
    content += '</marker>';
  }
  content += '</defs>';

  // ───── Background stripes (one per stream row) ────────────────────────
  for (const stream of STREAMS) {
    if (state.hiddenStreams.has(stream.id)) continue;
    const rowYPos    = layout.rowY[stream.id];
    const rowHeight  = layout.rowHeights[stream.id];

    // Very faint coloured stripe behind the row
    content += '<rect x="0" y="' + rowYPos + '" width="' + layout.totalWidth + '" height="' + rowHeight + '" fill="' + stream.color + '" opacity="0.025"></rect>';
    // Horizontal divider line just above each row
    content += '<line x1="0" y1="' + rowYPos + '" x2="' + layout.totalWidth + '" y2="' + rowYPos + '" stroke="var(--border-subtle)" stroke-width="1"></line>';
  }

  // ───── Top band where column headers sit ──────────────────────────────
  content += '<rect x="0" y="0" width="' + layout.totalWidth + '" height="' + (SVG_PADDING_TOP + COL_HEADER_HEIGHT) + '" fill="var(--bg-deep)"></rect>';

  // ───── Column headers + vertical dividers ─────────────────────────────
  for (const stage of STAGES) {
    const x = layout.colX[stage.id] + NODE_WIDTH / 2;
    content += '<text class="col-header-text" data-stage-id="' + escapeHtml(stage.id) + '" x="' + x + '" y="' + (SVG_PADDING_TOP + 24) + '" text-anchor="middle">' + escapeHtml(stage.label) + '</text>';

    // Dotted divider between columns (skip after the last one)
    if (stage.id !== STAGES[STAGES.length - 1].id) {
      const dividerX = layout.colX[stage.id] + NODE_WIDTH + COL_GAP / 2;
      content += '<line class="col-divider" x1="' + dividerX + '" y1="' + (SVG_PADDING_TOP + COL_HEADER_HEIGHT) + '" x2="' + dividerX + '" y2="' + layout.totalHeight + '"></line>';
    }
  }

  // ───── Ghost cell (hover preview for adding a new node) ───────────────
  // Drawn here so it sits ABOVE background stripes but BELOW row labels and
  // nodes. Shown over any cell whose existing-node rects don't already cover
  // the cursor position — for partially-filled cells the ghost sits in the
  // next stack slot. computeLayout reserves an extra slot of row height when
  // the hovered cell is at the row's max-slot count, so the ghost always
  // has somewhere to land without clipping into the row below.
  const hoverCell = state.canvasEdit && state.canvasEdit.hoverCell;
  if (hoverCell && layout.rowY[hoverCell.streamId] !== undefined && layout.colX[hoverCell.stageId] !== undefined) {
    const existingInCell = NODES.reduce((acc, n) => (n.stream === hoverCell.streamId && n.stage === hoverCell.stageId) ? acc + 1 : acc, 0);
    const ghostX = layout.colX[hoverCell.stageId];
    const ghostY = layout.rowY[hoverCell.streamId] + ROW_PADDING + existingInCell * (NODE_HEIGHT + NODE_GAP_Y);
    const ghostLabel = existingInCell > 0 ? "+ add another" : "+ add node";
    content += '<g class="ghost-cell" data-stream-id="' + escapeHtml(hoverCell.streamId) + '" data-stage-id="' + escapeHtml(hoverCell.stageId) + '">';
    content +=   '<rect x="' + ghostX + '" y="' + ghostY + '" width="' + NODE_WIDTH + '" height="' + NODE_HEIGHT + '" rx="5"></rect>';
    content +=   '<text x="' + (ghostX + NODE_WIDTH / 2) + '" y="' + (ghostY + NODE_HEIGHT / 2) + '" text-anchor="middle" dominant-baseline="central">' + ghostLabel + '</text>';
    content += '</g>';
  }

  // ───── Row label strip on the left (per stream) ───────────────────────
  // Hidden streams keep their label so the user can click to expand again;
  // they're rendered with a .collapsed class for a dimmer visual treatment.
  // Renaming / re-colouring streams happens in the sidebar — the canvas
  // row label is click-to-toggle-only.
  for (const stream of STREAMS) {
    const isCollapsed = state.hiddenStreams.has(stream.id);
    const rowYPos = layout.rowY[stream.id];
    const rowHeight = layout.rowHeights[stream.id];
    const labelText = isCollapsed ? "+ " + stream.short : stream.short;

    content += '<g class="row-label-group' + (isCollapsed ? ' collapsed' : '') + '" data-stream-id="' + stream.id + '">';
    content += '<rect class="row-label-bg" x="0" y="' + rowYPos + '" width="' + ROW_HEADER_WIDTH + '" height="' + rowHeight + '"></rect>';
    // Thin coloured stripe on the right edge of the strip
    content += '<rect x="' + (ROW_HEADER_WIDTH - 4) + '" y="' + rowYPos + '" width="4" height="' + rowHeight + '" fill="' + stream.color + '" opacity="' + (isCollapsed ? 0.4 : 0.7) + '"></rect>';
    content += '<text class="row-label-text" fill="' + stream.color + '" x="' + (ROW_HEADER_WIDTH / 2) + '" y="' + (rowYPos + rowHeight / 2) + '" text-anchor="middle" dominant-baseline="middle">' + escapeHtml(labelText) + '</text>';
    content += '</g>';
  }

  // ───── Edges (drawn BEFORE nodes so nodes sit on top) ─────────────────
  const flashedEdgeId = state.canvasEdit && state.canvasEdit.flashedEdgeId;
  for (const edge of EDGES) {
    const fromNode = nodeById[edge.from];
    const toNode   = nodeById[edge.to];
    if (!fromNode || !toNode) continue;
    if (!isNodeVisible(fromNode) || !isNodeVisible(toNode)) continue;

    const fromPos = layout.positions[edge.from];
    const toPos   = layout.positions[edge.to];

    // Edge starts at the right side of the source, ends at the left side of the target.
    const startX = fromPos.x + fromPos.width;
    const startY = fromPos.y + fromPos.height / 2;
    const endX   = toPos.x;
    const endY   = toPos.y + toPos.height / 2;

    // Cubic Bezier with horizontal tangents at both ends — produces a smooth
    // left-to-right curve regardless of vertical offset.
    const deltaX = endX - startX;
    const ctrlOffset = Math.max(40, Math.abs(deltaX) * 0.5);
    const ctrl1X = startX + ctrlOffset;
    const ctrl2X = endX - ctrlOffset;
    const pathD =
      "M " + startX + "," + startY +
      " C " + ctrl1X + "," + startY +
      " " + ctrl2X + "," + endY +
      " " + endX + "," + endY;

    // Default styling — overridden if the edge is highlighted by a selection.
    let strokeColor   = "var(--edge-default)";
    let strokeWidth   = 1;
    let strokeOpacity = 0.45;
    let markerEnd     = "";
    let dimmed        = false;
    const isEdgeFlashed = edge.id === flashedEdgeId;

    if (state.selectedNodeId) {
      const isHighlighted = state.highlightedEdgeIds.has(edge.id);
      if (isHighlighted) {
        if      (edge.effect === "increases") strokeColor = "var(--edge-increases)";
        else if (edge.effect === "decreases") strokeColor = "var(--edge-decreases)";
        else                                  strokeColor = "var(--edge-enables)";
        strokeWidth = 2;
        strokeOpacity = 0.9;
        markerEnd = ' marker-end="url(#arrow_' + edge.effect + ')"';
      } else {
        dimmed = true;
      }
    }
    if (isEdgeFlashed) {
      // Edge was just clicked — paint it boldly until the flash flag clears.
      if      (edge.effect === "increases") strokeColor = "var(--edge-increases)";
      else if (edge.effect === "decreases") strokeColor = "var(--edge-decreases)";
      else                                  strokeColor = "var(--edge-enables)";
      strokeWidth = 2.5;
      strokeOpacity = 1;
      markerEnd = ' marker-end="url(#arrow_' + edge.effect + ')"';
      dimmed = false;
    }

    // Wide invisible hit-path drawn UNDER the visible edge for easier clicking.
    // pointer-events:stroke (set in CSS) limits hits to the stroked area.
    content += '<path class="edge-hit" data-edge-id="' + edge.id + '" d="' + pathD + '"></path>';

    const classAttr = ' class="edge-path' + (dimmed ? ' dimmed' : '') + (isEdgeFlashed ? ' flashed' : '') + '"';
    content += '<path' + classAttr + ' data-edge-id="' + edge.id + '" d="' + pathD + '" stroke="' + strokeColor + '" stroke-width="' + strokeWidth + '" stroke-opacity="' + strokeOpacity + '"' + markerEnd + '></path>';
  }

  // Pre-compute the set of search-match ids once so the per-node check
  // below is O(1) instead of O(matches). Tiny optimisation for 73 nodes,
  // but it also makes the inner loop easier to read.
  const searchMatchIds = (state.searchMatches && state.searchMatches.length > 0)
    ? new Set(state.searchMatches.map(m => m.node.id))
    : null;

  // ───── Nodes ──────────────────────────────────────────────────────────
  for (const node of NODES) {
    if (!isNodeVisible(node)) continue;
    const pos = layout.positions[node.id];
    if (!pos) continue;
    const stream   = streamById[node.stream];
    const category = CATEGORIES[node.category];

    // Class flags applied to the <g> wrapper — see 05-visualization.css
    // and 12-no-borders.css (state glows) + 13-search.css (search halo).
    let nodeClasses = "node-group";
    if (state.selectedNodeId) {
      if      (node.id === state.selectedNodeId)  nodeClasses += " selected";
      else if (state.ancestorSet.has(node.id))    nodeClasses += " ancestor";
      else if (state.descendantSet.has(node.id))  nodeClasses += " descendant";
      else                                        nodeClasses += " dimmed";
    }
    if (state.hoveredNodeId === node.id) nodeClasses += " hovered";
    if (searchMatchIds && searchMatchIds.has(node.id)) nodeClasses += " search-match";

    content += '<g class="' + nodeClasses + '" data-node-id="' + node.id + '">';

    // ── Background rect with conditional border ──
    let strokeColor = "rgba(0,0,0,0.4)";
    let strokeWidth = 1;
    const outcomeStatusColor = getOutcomeBorderColor(node.id);

    if (node.id === state.selectedNodeId) {
      strokeColor = "#ffffff";
      strokeWidth = 2.5;
    } else if (state.ancestorSet.has(node.id)) {
      strokeColor = "var(--edge-ancestor)";
      strokeWidth = 2;
    } else if (state.descendantSet.has(node.id)) {
      strokeColor = "var(--edge-descendant)";
      strokeWidth = 2;
    } else if (outcomeStatusColor && !state.selectedNodeId) {
      // Show good/bad colour around outcome nodes when nothing is selected.
      strokeColor = outcomeStatusColor;
      strokeWidth = 2;
    }

    content += '<rect class="node-rect" x="' + pos.x + '" y="' + pos.y + '" width="' + pos.width + '" height="' + pos.height + '" rx="5" fill="' + category.color + '" stroke="' + strokeColor + '" stroke-width="' + strokeWidth + '"></rect>';

    // ── Coloured stripe down the left edge (the stream colour) ──
    // We draw it as a path so only the left corners are rounded — the right
    // side is flush against the rectangle.
    const barWidth  = 6;
    const barRadius = 5;
    const barLeft   = pos.x;
    const barRight  = pos.x + barWidth;
    const barTop    = pos.y;
    const barBottom = pos.y + pos.height;
    const barPath =
      "M " + (barLeft + barRadius) + "," + barTop +
      " L " + barRight + "," + barTop +
      " L " + barRight + "," + barBottom +
      " L " + (barLeft + barRadius) + "," + barBottom +
      " A " + barRadius + "," + barRadius + " 0 0 1 " + barLeft + "," + (barBottom - barRadius) +
      " L " + barLeft + "," + (barTop + barRadius) +
      " A " + barRadius + "," + barRadius + " 0 0 1 " + (barLeft + barRadius) + "," + barTop +
      " Z";
    content += '<path d="' + barPath + '" fill="' + stream.color + '"></path>';

    // ── Label (wrapped to up to 2 lines) ──
    // One <text> with one or two <tspan> children. Using `dy="1.083em"` (the
    // 13/12 ratio of the previous hard-coded line-height) means the gap
    // between lines scales with the font-size, so labels stay legible when
    // --map-text-scale grows on zoom-out without lines overlapping.
    const labelLines = wrapLabel(node.label, 24);
    const labelBlockTopY = pos.y + 16;
    content += '<text class="node-label" x="' + (pos.x + 14) + '" y="' + labelBlockTopY + '" fill="' + category.textColor + '" dominant-baseline="middle">';
    for (let lineIdx = 0; lineIdx < labelLines.length; lineIdx++) {
      const dy = lineIdx === 0 ? "0" : "1.083em";
      content += '<tspan x="' + (pos.x + 14) + '" dy="' + dy + '">' + escapeHtml(labelLines[lineIdx]) + '</tspan>';
    }
    content += '</text>';

    // ── Value + delta (only for nodes with a baseline) ──
    const valueText = formatNodeValue(node.id);
    if (valueText) {
      const deltaInfo = formatNodeDelta(node.id);
      const valueY = pos.y + pos.height - 12;
      content += '<text class="node-value" x="' + (pos.x + 14) + '" y="' + valueY + '" fill="' + category.textColor + '" dominant-baseline="middle" opacity="0.75">' + escapeHtml(valueText) + '</text>';

      if (deltaInfo.text && deltaInfo.text !== "—") {
        let deltaColor = "#1c1917";
        if (node.direction === "higher_better") {
          deltaColor = deltaInfo.pct > 0 ? "#065f46" : "#7f1d1d";
        } else if (node.direction === "lower_better") {
          deltaColor = deltaInfo.pct < 0 ? "#065f46" : "#7f1d1d";
        } else {
          deltaColor = deltaInfo.pct > 0 ? "#1e3a8a" : "#7c2d12";
        }
        content += '<text class="node-delta" x="' + (pos.x + pos.width - 10) + '" y="' + valueY + '" fill="' + deltaColor + '" text-anchor="end" dominant-baseline="middle" font-weight="600">' + escapeHtml(deltaInfo.text) + '</text>';
      }
    }

    // Edge-drag handle on the right edge of every node. Visible only on hover
    // via CSS. Mousedown starts an edge-drag (see 16e-canvas-edit.js).
    content += '<circle class="edge-handle" data-node-id="' + escapeHtml(node.id) + '" cx="' + (pos.x + pos.width) + '" cy="' + (pos.y + pos.height / 2) + '" r="6"></circle>';

    content += '</g>';
  }

  // ───── Draft edge preview (while user drags from a node's edge handle) ───
  const draft = state.canvasEdit && state.canvasEdit.draftEdge;
  if (draft) {
    const fromPos = layout.positions[draft.fromNodeId];
    if (fromPos) {
      const sx = fromPos.x + fromPos.width;
      const sy = fromPos.y + fromPos.height / 2;
      const ex = draft.currentX;
      const ey = draft.currentY;
      const dx = ex - sx;
      const ctrl = Math.max(40, Math.abs(dx) * 0.5);
      const draftD =
        "M " + sx + "," + sy +
        " C " + (sx + ctrl) + "," + sy +
        " " + (ex - ctrl) + "," + ey +
        " " + ex + "," + ey;
      content += '<path class="draft-edge" d="' + draftD + '"></path>';
    }
  }

  // ───── Empty-state hint when no nodes exist ───────────────────────────
  if (NODES.length === 0) {
    const cx = (ROW_HEADER_WIDTH + layout.totalWidth) / 2;
    const cy = (SVG_PADDING_TOP + COL_HEADER_HEIGHT + layout.totalHeight) / 2;
    content += '<text class="empty-state-hint" x="' + cx + '" y="' + cy + '" text-anchor="middle" dominant-baseline="middle">';
    content +=   '<tspan x="' + cx + '" dy="0">Click any cell to add your first node.</tspan>';
    content +=   '<tspan x="' + cx + '" dy="1.5em" class="empty-state-hint-sub">Drag from a node\'s right edge to draw an edge. Press Delete to remove. Need bulk import? Use Build map.</tspan>';
    content += '</text>';
  }

  // Commit the markup, then wire up event listeners.
  svg.innerHTML = content;
  attachSvgEventHandlers();
}

// Attach click / hover / leave listeners to every node and row label.
// Called fresh after every render() because innerHTML replaces all children.
function attachSvgEventHandlers() {
  // Node click → select; hover → show tooltip.
  svg.querySelectorAll(".node-group").forEach(group => {
    group.addEventListener("click", event => {
      event.stopPropagation();
      const nodeId = group.getAttribute("data-node-id");
      selectNode(nodeId);
    });
    group.addEventListener("mouseenter", event => {
      const nodeId = group.getAttribute("data-node-id");
      showTooltip(nodeById[nodeId], event);
    });
    group.addEventListener("mousemove", event => {
      moveTooltip(event);
    });
    group.addEventListener("mouseleave", () => {
      hideTooltip();
    });
  });

  // Clicking the row label toggles the whole stream (hide / show its row
  // on the map). Renaming and re-colouring streams happens in the sidebar.
  svg.querySelectorAll(".row-label-group").forEach(group => {
    const streamId = group.getAttribute("data-stream-id");
    const stream = streamById[streamId];
    group.addEventListener("click", event => {
      event.stopPropagation();
      toggleStream(streamId);
    });
    if (stream) {
      const collapsed = state.hiddenStreams.has(streamId);
      const text = (collapsed ? "Click to expand " : "Click to collapse ") + stream.label + " on the map.";
      if (typeof attachTooltip === "function") attachTooltip(group, text);
    }
  });

  // (The svg-background click → deselect listener is registered once at
  // the top of this file, not here — see the comment above the file's
  // `const svg = …` line.)

  // Canvas direct-edit affordances (ghost cell click, edge handles, '+' buttons,
  // edge clicks, label double-clicks). Defined in 16e-canvas-edit.js.
  if (typeof attachCanvasEditHandlers === "function") attachCanvasEditHandlers();
}
