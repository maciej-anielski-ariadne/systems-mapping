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
  if (event.target.closest && event.target.closest(".node-group, .row-label-group, .col-header-group, .edge-handle, .ghost-cell, .edge-hit, .edge-path")) {
    return;
  }
  if (state.selectedNodeId || (state.selectedNodeIds && state.selectedNodeIds.size)) {
    deselectAll();
  }
});

// ───── Category rendering helpers (shared with the export in 19-export.js) ──
// How many secondary chips to draw before collapsing the rest into a "+N" pill.
const SECONDARY_CHIP_MAX = 4;

// Monotonic counter for unique gradient ids. Using the node id risked
// collisions (two ids differing only in punctuation sanitize to the same
// string); a counter is collision-proof and the SVG is rebuilt every render.
let _nodeGradSeq = 0;

// Primary fill for a node. One primary → solid; several → a smooth diagonal
// gradient (↘) blending their colours. Returns { defs, fill, textColor }: defs
// is an SVG <defs> string (empty unless a gradient is needed) and must be
// emitted inside the SVG; fill is a colour or url(#gradId). gradId must be
// unique per node. Colours come straight from CATEGORIES (literal hex), so this
// is identical between the live map and the self-contained export.
function nodePrimaryFill(node, gradId) {
  const ids = (node.primaryCategories && node.primaryCategories.length)
    ? node.primaryCategories
    : (node.category ? [node.category] : []);
  // Only PRIMARY-class categories fill the body. (node.category can be a
  // secondary anchor when a node has no primary — such nodes get the gray
  // fallback fill, never a secondary colour painted as both body and chip.)
  const prim = ids.map(id => CATEGORIES[id]).filter(c => c && (c.class || "primary") !== "secondary");
  if (prim.length === 0) return { defs: "", fill: "#a3a3a3", textColor: "#1c1917" };
  if (prim.length === 1) return { defs: "", fill: prim[0].color, textColor: prim[0].textColor };
  const stops = prim.map((c, i) =>
    '<stop offset="' + Math.round(i / (prim.length - 1) * 100) + '%" stop-color="' + c.color + '"></stop>'
  ).join("");
  const defs = '<defs><linearGradient id="' + gradId + '" x1="0" y1="0" x2="1" y2="1">' + stops + '</linearGradient></defs>';
  return { defs: defs, fill: "url(#" + gradId + ")", textColor: prim[0].textColor };
}

// Secondary category chips: small squares in the node's bottom-right, growing
// leftward, capped at SECONDARY_CHIP_MAX with a "+N" pill. Returns { svg,
// leftEdge } — leftEdge is the x of the left-most chip/pill so the value-delta
// can be right-aligned just to its left and never overlap.
function nodeSecondaryChips(node, pos) {
  const sec = (node.secondaryCategories || []).map(id => CATEGORIES[id]).filter(Boolean);
  const rightEdge = pos.x + pos.width;
  if (sec.length === 0) return { svg: "", leftEdge: rightEdge };
  const bs = 12, gap = 3, inset = 8;
  const shown = sec.slice(0, SECONDARY_CHIP_MAX);
  const overflow = sec.length - shown.length;
  const y = pos.y + pos.height - inset - bs;
  let svg = "", minX = rightEdge;
  shown.forEach((c, i) => {
    const x = rightEdge - inset - bs - i * (bs + gap);
    minX = Math.min(minX, x);
    svg += '<rect x="' + x + '" y="' + y + '" width="' + bs + '" height="' + bs + '" rx="2" fill="' + c.color + '" stroke="rgba(0,0,0,0.4)" stroke-width="1"></rect>';
  });
  if (overflow > 0) {
    const pillW = 22, pillX = minX - gap - pillW;
    minX = pillX;
    svg += '<rect x="' + pillX + '" y="' + y + '" width="' + pillW + '" height="' + bs + '" rx="3" fill="rgba(0,0,0,0.3)" stroke="rgba(0,0,0,0.4)" stroke-width="1"></rect>';
    svg += '<text x="' + (pillX + pillW / 2) + '" y="' + (y + bs / 2) + '" text-anchor="middle" dominant-baseline="central" font-family="Arial,Helvetica,sans-serif" font-size="9" font-weight="700" fill="#ffffff">+' + overflow + '</text>';
  }
  return { svg: svg, leftEdge: minX };
}

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
  // Each header is a clickable group (toggles its stage's visibility, mirroring
  // the stream row labels). A hidden stage collapses to a narrow stub: the
  // header shows a "+" and the label runs vertically down a faint full-height
  // band, all of which is clickable to expand again.
  const headerBandBottom = SVG_PADDING_TOP + COL_HEADER_HEIGHT;
  for (const stage of STAGES) {
    const colW = (layout.colWidths && layout.colWidths[stage.id]) || NODE_WIDTH;
    const colLeft = layout.colX[stage.id];
    const isStageCollapsed = state.hiddenStages.has(stage.id);

    const cx = colLeft + colW / 2;
    content += '<g class="col-header-group' + (isStageCollapsed ? ' collapsed' : '') + '" data-stage-id="' + escapeHtml(stage.id) + '">';
    // Transparent hit area over the header band captures the toggle click (the
    // label text has pointer-events:none).
    content += '<rect class="col-header-hit" x="' + colLeft + '" y="0" width="' + colW + '" height="' + headerBandBottom + '"></rect>';
    if (isStageCollapsed) {
      // Faint full-height band so the thin column reads as a strip and can be
      // clicked anywhere down its length; a "+" invites expansion and the label
      // runs vertically down the band.
      content += '<rect class="collapsed-col-band" x="' + colLeft + '" y="' + headerBandBottom + '" width="' + colW + '" height="' + (layout.totalHeight - headerBandBottom) + '"></rect>';
      content += '<text class="col-header-text col-header-plus" x="' + cx + '" y="' + (SVG_PADDING_TOP + 24) + '" text-anchor="middle">+</text>';
      const labelY = headerBandBottom + (layout.totalHeight - headerBandBottom) / 2;
      content += '<text class="col-header-text col-header-stub" x="' + cx + '" y="' + labelY + '" text-anchor="middle" transform="rotate(-90 ' + cx + ' ' + labelY + ')">' + escapeHtml(stage.label) + '</text>';
    } else {
      content += '<text class="col-header-text" x="' + cx + '" y="' + (SVG_PADDING_TOP + 24) + '" text-anchor="middle">' + escapeHtml(stage.label) + '</text>';
    }
    content += '</g>';

    // Dotted divider between columns (skip after the last one)
    if (stage.id !== STAGES[STAGES.length - 1].id) {
      const dividerX = colLeft + colW + COL_GAP / 2;
      content += '<line class="col-divider" x1="' + dividerX + '" y1="' + headerBandBottom + '" x2="' + dividerX + '" y2="' + layout.totalHeight + '"></line>';
    }
  }

  // ───── Keyboard cursor slot (arrow-key navigation on an empty slot) ───
  // The cursor can park on any slot within a stream — including empty slots
  // inside a partially-filled multi-node cell. Render the placeholder at the
  // exact slot position so up/down navigation feels continuous. Suppressed
  // if a hoverCell is already drawing in the same place (mouse-driven hover
  // wins for immediacy).
  const cursorCell = state.canvasEdit && state.canvasEdit.cursorCell;
  if (cursorCell && layout.rowY[cursorCell.streamId] !== undefined && layout.colX[cursorCell.stageId] !== undefined) {
    const hov = state.canvasEdit && state.canvasEdit.hoverCell;
    const sameAsHover = hov && hov.streamId === cursorCell.streamId && hov.stageId === cursorCell.stageId;
    if (!sameAsHover) {
      // Land the placeholder at the cumulative top of its slot (heights vary).
      // Clamp to the cell's "next empty" slot so a stale slotIndex (e.g. after a
      // delete) can't render the box below the row.
      const cursorCellNodes = (layout.cells && layout.cells[cursorCell.streamId + ":" + cursorCell.stageId]) || [];
      const slot = Math.max(0, Math.min(cursorCellNodes.length, cursorCell.slotIndex || 0));
      const x = layout.colX[cursorCell.stageId];
      const y = slotTopY(cursorCell.streamId, cursorCell.stageId, slot);
      content += '<g class="cursor-cell">';
      content +=   '<rect x="' + x + '" y="' + y + '" width="' + NODE_WIDTH + '" height="' + NODE_HEIGHT + '" rx="5"></rect>';
      content +=   '<text x="' + (x + NODE_WIDTH / 2) + '" y="' + (y + NODE_HEIGHT / 2) + '" text-anchor="middle" dominant-baseline="central">Type to create a node</text>';
      content += '</g>';
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
    // Sit in the gap computeLayout opened at the cursor's insert slot (siblings
    // at/after it have displaced down by one). Falls back to the bottom slot
    // when no insertIndex is set.
    const insertSlot = hoverCell.insertIndex != null ? hoverCell.insertIndex : existingInCell;
    const ghostX = layout.colX[hoverCell.stageId];
    // Cumulative top of the gap computeLayout opened for this insert slot.
    const ghostY = slotTopY(hoverCell.streamId, hoverCell.stageId, insertSlot);
    const ghostLabel = "+ add node";
    content += '<g class="ghost-cell" data-stream-id="' + escapeHtml(hoverCell.streamId) + '" data-stage-id="' + escapeHtml(hoverCell.stageId) + '" data-insert-index="' + insertSlot + '">';
    content +=   '<rect x="' + ghostX + '" y="' + ghostY + '" width="' + NODE_WIDTH + '" height="' + NODE_HEIGHT + '" rx="5"></rect>';
    content +=   '<text x="' + (ghostX + NODE_WIDTH / 2) + '" y="' + (ghostY + NODE_HEIGHT / 2) + '" text-anchor="middle" dominant-baseline="central">' + ghostLabel + '</text>';
    content += '</g>';
  }

  // ───── Drag landing slot (during node drag) ───────────────────────────
  // Drawn here so it sits under nodes but over the grid. The siblings have
  // parted to open a gap at the insert index (computeLayout); this dashed rect
  // marks that gap as the landing slot — same visual language as the new-note
  // placeholder. For a same-cell reorder the dragged node's faint ghost rests
  // inside it; for a cross-cell move the gap is open space.
  const drag = state.canvasEdit && state.canvasEdit.draggingNode;
  if (drag && drag.dropCell && drag.dropCell.insertIndex != null && layout.rowY[drag.dropCell.streamId] !== undefined && layout.colX[drag.dropCell.stageId] !== undefined) {
    const dc = drag.dropCell;
    const cellLeft = layout.colX[dc.stageId];
    // Top of the gap = cumulative height of the kept siblings above the insert
    // slot (the dragged group is excluded — it's the one landing here).
    const groupSet = new Set((drag.groupIds && drag.groupIds.length) ? drag.groupIds : [drag.nodeId]);
    const kept = (layout.cells[dc.streamId + ":" + dc.stageId] || []).filter(n => !groupSet.has(n.id));
    let slotY = layout.rowY[dc.streamId] + ROW_PADDING;
    for (let i = 0; i < dc.insertIndex && i < kept.length; i++) {
      const kp = layout.positions[kept[i].id];
      slotY += ((kp && kp.height) || NODE_HEIGHT) + NODE_GAP_Y;
    }
    const dpos = layout.positions[drag.nodeId];
    const dropH = (dpos && dpos.height) || NODE_HEIGHT;
    content += '<rect class="drop-slot" x="' + cellLeft + '" y="' + slotY + '" width="' + NODE_WIDTH + '" height="' + dropH + '" rx="5"></rect>';
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
  // computeRenderEdges (10a) returns both the REAL visible→visible edges and
  // the SYNTHETIC "through" edges that re-route causal effects across hidden
  // stages/streams/categories. Both endpoints of every returned edge are
  // guaranteed visible, so their layout positions always exist.
  const flashedEdgeId = state.canvasEdit && state.canvasEdit.flashedEdgeId;
  // Edges changed by the most recent undo/redo — pulsed briefly so the user
  // sees what the operation touched. Cleared on a timer (16g-canvas-undo.js).
  const undoFlashEdgeIds = state.canvasEdit && state.canvasEdit.flashedEdgeIds;
  // Helper: effect → stroke colour + arrow marker name.
  const effectStroke = effect =>
    effect === "increases" ? "var(--edge-increases)" :
    effect === "decreases" ? "var(--edge-decreases)" :
    effect === "enables"   ? "var(--edge-enables)"   :
                             "var(--edge-default)";
  const effectMarker = effect =>
    (effect === "increases" || effect === "decreases" || effect === "enables") ? effect : "default";

  for (const re of computeRenderEdges()) {
    const fromPos = layout.positions[re.from];
    const toPos   = layout.positions[re.to];
    if (!fromPos || !toPos) continue;   // defensive — endpoints should be visible

    // Edge starts at the right side of the source, ends at the left side of the target.
    const startX = fromPos.x + fromPos.width;
    const startY = fromPos.y + fromPos.height / 2;
    const endX   = toPos.x;
    const endY   = toPos.y + toPos.height / 2;

    // Cubic Bezier with horizontal tangents at both ends — a smooth
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

    if (re.synthetic) {
      // Synthetic "through" edge — presentation only: dashed, no hit-path, not
      // selectable/editable. Bold + coloured when incident to the selected node
      // (highlightedEdgeIds only holds real edge ids, so we check incidence
      // directly); dimmed when some OTHER node is the sole selection.
      const incident = state.selectedNodeId === re.from || state.selectedNodeId === re.to;
      let strokeWidth   = 1.5;
      let strokeOpacity = 0.6;
      let dimmed        = false;
      // Stay gray by default — only show the effect colour when incident to the
      // selected node (synthetic edges aren't directly selectable, so node
      // selection is their only "selected" state). Mirrors real-edge behaviour.
      let strokeColor   = "var(--edge-default)";
      let markerName    = "default";
      if (state.selectedNodeId && state.selectedNodeIds.size <= 1) {
        if (incident) {
          strokeWidth = 2; strokeOpacity = 0.95;
          strokeColor = effectStroke(re.effect);
          markerName  = effectMarker(re.effect);
        } else {
          dimmed = true;
        }
      }
      const effectClass = ' effect-' + re.effect;   // increases / decreases / neutral
      content += '<path class="edge-path synthetic' + effectClass + (dimmed ? ' dimmed' : '') +
        '" d="' + pathD + '" stroke="' + strokeColor +
        '" stroke-width="' + strokeWidth + '" stroke-opacity="' + strokeOpacity +
        '" marker-end="url(#arrow_' + markerName + ')"></path>';
      continue;
    }

    const edge = re.edge;
    // Default styling — overridden if the edge is highlighted by a selection.
    let strokeColor   = "var(--edge-default)";
    let strokeWidth   = 1;
    let strokeOpacity = 0.45;
    let markerEnd     = "";
    let dimmed        = false;
    const isEdgeFlashed = edge.id === flashedEdgeId;

    // Only a single-node selection highlights/dims edges — a multi-selection
    // suppresses neighbour highlighting (highlightedEdgeIds is empty), so leave
    // every edge at its default styling rather than dimming them all.
    if (state.selectedNodeId && state.selectedNodeIds.size <= 1) {
      const isHighlighted = state.highlightedEdgeIds.has(edge.id);
      if (isHighlighted) {
        strokeColor = effectStroke(edge.effect);
        strokeWidth = 2;
        strokeOpacity = 0.9;
        markerEnd = ' marker-end="url(#arrow_' + edge.effect + ')"';
      } else {
        dimmed = true;
      }
    }
    if (isEdgeFlashed) {
      // Edge was just clicked — paint it boldly until the flash flag clears.
      strokeColor = effectStroke(edge.effect);
      strokeWidth = 2.5;
      strokeOpacity = 1;
      markerEnd = ' marker-end="url(#arrow_' + edge.effect + ')"';
      dimmed = false;
    }
    const isEdgeSelected = edge.id === state.selectedEdgeId;
    // The currently-selected edge always renders in its effect colour, bold
    // and undimmed — so creation (auto-select) and arrow-key effect cycling
    // both show an unambiguous colour change without depending on whether
    // the from-node is also selected.
    if (isEdgeSelected) {
      strokeColor = effectStroke(edge.effect);
      strokeWidth = 3;
      strokeOpacity = 1;
      markerEnd = ' marker-end="url(#arrow_' + edge.effect + ')"';
      dimmed = false;
    }

    // Wide invisible hit-path drawn UNDER the visible edge for easier clicking.
    // pointer-events:stroke (set in CSS) limits hits to the stroked area.
    content += '<path class="edge-hit" data-edge-id="' + edge.id + '" d="' + pathD + '"></path>';

    // Effect class lets CSS bind colour-based styles (selected-edge halo, etc)
    // without having to parse the inline stroke value.
    const effectClass = edge.effect ? ' effect-' + edge.effect : '';
    const isEdgeUndoFlashed = undoFlashEdgeIds && undoFlashEdgeIds.has(edge.id);
    const classAttr = ' class="edge-path' + effectClass + (dimmed ? ' dimmed' : '') + (isEdgeFlashed ? ' flashed' : '') + (isEdgeUndoFlashed ? ' undo-flash' : '') + (isEdgeSelected ? ' selected' : '') + '"';
    content += '<path' + classAttr + ' data-edge-id="' + edge.id + '" d="' + pathD + '" stroke="' + strokeColor + '" stroke-width="' + strokeWidth + '" stroke-opacity="' + strokeOpacity + '"' + markerEnd + '></path>';
  }

  // Pre-compute the set of search-match ids once so the per-node check
  // below is O(1) instead of O(matches). Tiny optimisation for 73 nodes,
  // but it also makes the inner loop easier to read.
  const searchMatchIds = (state.searchMatches && state.searchMatches.length > 0)
    ? new Set(state.searchMatches.map(m => m.node.id))
    : null;

  // Nodes changed by the most recent undo/redo — pulsed briefly (and forced
  // un-dimmed by CSS) so the user sees what the operation touched.
  const undoFlashNodeIds = state.canvasEdit && state.canvasEdit.flashedNodeIds;

  // ───── Nodes ──────────────────────────────────────────────────────────
  for (const node of NODES) {
    if (!isNodeVisible(node)) continue;
    const pos = layout.positions[node.id];
    if (!pos) continue;
    const stream   = streamById[node.stream];
    const fillInfo = nodePrimaryFill(node, "ngrad_" + (_nodeGradSeq++));
    const textColor = fillInfo.textColor;
    const chips    = nodeSecondaryChips(node, pos);

    // Class flags applied to the <g> wrapper — see 05-visualization.css
    // and 12-no-borders.css (state glows) + 13-search.css (search halo).
    // Every member of the multi-selection gets the "selected" glow. The
    // ancestor/descendant/dimmed neighbour treatment only applies in
    // single-select (refreshNeighborHighlight empties those sets when >1 is
    // selected, so multi-select renders un-selected nodes plainly — no noise).
    let nodeClasses = "node-group";
    if (state.selectedNodeIds.has(node.id)) {
      nodeClasses += " selected";
    } else if (state.selectedNodeId && state.selectedNodeIds.size <= 1) {
      if      (state.ancestorSet.has(node.id))    nodeClasses += " ancestor";
      else if (state.descendantSet.has(node.id))  nodeClasses += " descendant";
      else                                        nodeClasses += " dimmed";
    }
    if (state.hoveredNodeId === node.id) nodeClasses += " hovered";
    if (searchMatchIds && searchMatchIds.has(node.id)) nodeClasses += " search-match";
    if (undoFlashNodeIds && undoFlashNodeIds.has(node.id)) nodeClasses += " undo-flash";
    // Ghost the source node while it's being dragged — the live preview
    // (rendered below the node loop) follows the cursor.
    if (drag && drag.nodeId === node.id) nodeClasses += " dragging-source";

    content += '<g class="' + nodeClasses + '" data-node-id="' + node.id + '">';
    content += fillInfo.defs;   // per-node gradient def (empty unless multi-primary)

    // ── Background rect with conditional border ──
    let strokeColor = "rgba(0,0,0,0.4)";
    let strokeWidth = 1;
    const outcomeStatusColor = getOutcomeBorderColor(node.id);

    if (state.selectedNodeIds.has(node.id)) {
      strokeColor = "#ffffff";
      strokeWidth = 2.5;
    } else if (state.ancestorSet.has(node.id)) {
      strokeColor = "var(--edge-ancestor)";
      strokeWidth = 2;
    } else if (state.descendantSet.has(node.id)) {
      strokeColor = "var(--edge-descendant)";
      strokeWidth = 2;
    } else if (outcomeStatusColor && !state.selectedNodeId && !state.selectedNodeIds.size) {
      // Show good/bad colour around outcome nodes when nothing is selected.
      strokeColor = outcomeStatusColor;
      strokeWidth = 2;
    }

    content += '<rect class="node-rect" x="' + pos.x + '" y="' + pos.y + '" width="' + pos.width + '" height="' + pos.height + '" rx="5" fill="' + fillInfo.fill + '" stroke="' + strokeColor + '" stroke-width="' + strokeWidth + '"></rect>';

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
    // Lines were wrapped to the node's inner width by computeLayout (which used
    // them to grow the box height); consume them so box height and rendered
    // line count always agree. Anchored to the box top, x at the symmetric inset.
    const labelLines = pos.labelLines || wrapLabel(node.label, 24);
    const labelX = pos.x + LABEL_INSET;
    const labelBlockTopY = pos.y + 16;
    content += '<text class="node-label" x="' + labelX + '" y="' + labelBlockTopY + '" fill="' + textColor + '" dominant-baseline="middle">';
    for (let lineIdx = 0; lineIdx < labelLines.length; lineIdx++) {
      const dy = lineIdx === 0 ? "0" : "1.083em";
      content += '<tspan x="' + labelX + '" dy="' + dy + '">' + escapeHtml(labelLines[lineIdx]) + '</tspan>';
    }
    content += '</text>';

    // ── Value + delta (only for nodes with a baseline) ──
    const valueText = formatNodeValue(node.id);
    if (valueText) {
      const deltaInfo = formatNodeDelta(node.id);
      const valueY = pos.y + pos.height - 12;
      content += '<text class="node-value" x="' + (pos.x + LABEL_INSET) + '" y="' + valueY + '" fill="' + textColor + '" dominant-baseline="middle" opacity="0.75">' + escapeHtml(valueText) + '</text>';

      if (deltaInfo.text && deltaInfo.text !== "—") {
        let deltaColor = "#1c1917";
        if (node.direction === "higher_better") {
          deltaColor = deltaInfo.pct > 0 ? "#065f46" : "#7f1d1d";
        } else if (node.direction === "lower_better") {
          deltaColor = deltaInfo.pct < 0 ? "#065f46" : "#7f1d1d";
        } else {
          deltaColor = deltaInfo.pct > 0 ? "#1e3a8a" : "#7c2d12";
        }
        // Sit the delta just left of any secondary chips so they keep the corner.
        const deltaX = chips.svg ? chips.leftEdge - 6 : pos.x + pos.width - LABEL_INSET;
        content += '<text class="node-delta" x="' + deltaX + '" y="' + valueY + '" fill="' + deltaColor + '" text-anchor="end" dominant-baseline="middle" font-weight="600">' + escapeHtml(deltaInfo.text) + '</text>';
      }
    }

    // ── Secondary category chips (bottom-right) ──
    content += chips.svg;

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

  // ───── Drag preview (a translucent copy of the dragged node at cursor) ──
  if (drag && drag.active && nodeById[drag.nodeId]) {
    const node = nodeById[drag.nodeId];
    const fillInfo = nodePrimaryFill(node, "ndragprev");
    const stream   = streamById[node.stream] || { color: "#94a3b8" };
    const dpos = layout.positions[drag.nodeId];
    const previewH = (dpos && dpos.height) || NODE_HEIGHT;
    const previewLines = (dpos && dpos.labelLines) || wrapLabel(node.label, 24);
    const px = drag.currentX - NODE_WIDTH / 2;
    const py = drag.currentY - previewH / 2;
    content += '<g class="node-drag-preview">';
    content += fillInfo.defs;
    content += '<rect x="' + px + '" y="' + py + '" width="' + NODE_WIDTH + '" height="' + previewH + '" rx="5" fill="' + fillInfo.fill + '" stroke="rgba(0,0,0,0.4)" stroke-width="1"></rect>';
    content += '<rect x="' + px + '" y="' + py + '" width="6" height="' + previewH + '" rx="2" fill="' + stream.color + '"></rect>';
    content += '<text class="node-label" x="' + (px + LABEL_INSET) + '" y="' + (py + 16) + '" fill="' + fillInfo.textColor + '" dominant-baseline="middle">';
    for (let i = 0; i < previewLines.length; i++) {
      const dy = i === 0 ? "0" : "1.083em";
      content += '<tspan x="' + (px + LABEL_INSET) + '" dy="' + dy + '">' + escapeHtml(previewLines[i]) + '</tspan>';
    }
    content += '</text>';
    // Group drag: a count badge in the corner so it's clear the whole
    // selection is moving, not just the previewed primary node.
    if (drag.groupIds && drag.groupIds.length > 1) {
      const bx = px + NODE_WIDTH;
      const by = py;
      content += '<circle class="drag-count-badge" cx="' + bx + '" cy="' + by + '" r="11" fill="#1e293b" stroke="#ffffff" stroke-width="1.5"></circle>';
      content += '<text x="' + bx + '" y="' + by + '" text-anchor="middle" dominant-baseline="central" fill="#ffffff" font-size="11" font-weight="600">' + drag.groupIds.length + '</text>';
    }
    content += '</g>';
  }

  // ───── Marquee selection box (shift+drag on empty canvas) ─────────────
  const marquee = state.canvasEdit && state.canvasEdit.marquee;
  if (marquee) {
    const mx = Math.min(marquee.startX, marquee.currentX);
    const my = Math.min(marquee.startY, marquee.currentY);
    const mw = Math.abs(marquee.currentX - marquee.startX);
    const mh = Math.abs(marquee.currentY - marquee.startY);
    content += '<rect class="marquee-box" x="' + mx + '" y="' + my + '" width="' + mw + '" height="' + mh + '" rx="2"></rect>';
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

  // Clicking a column header toggles the whole stage (collapse / expand its
  // column on the map). Mirrors the stream row-label behaviour above.
  svg.querySelectorAll(".col-header-group").forEach(group => {
    const stageId = group.getAttribute("data-stage-id");
    const stage = stageById[stageId];
    group.addEventListener("click", event => {
      event.stopPropagation();
      toggleStage(stageId);
    });
    if (stage) {
      const collapsed = state.hiddenStages.has(stageId);
      const text = (collapsed ? "Click to expand " : "Click to collapse ") + stage.label + " on the map.";
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
