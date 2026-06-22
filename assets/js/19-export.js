// =============================================================================
// EXPORT — canvas → clipboard image and view-only HTML
// -----------------------------------------------------------------------------
// Two public entry points, wired to the header buttons in 17-events.js:
//   • exportCanvasImage()  → copies the canvas to the clipboard as a PNG image
//   • publishCanvasHtml()  → downloads a self-contained, view-only .html viewer
//
// Both share buildExportModel(), which decides WHAT to draw and reflows it:
//
//   What:  • If a single node is selected → only the highlighted nodes + edges
//            (selected + ancestors/descendants out to state.highlightDepth).
//          • Otherwise → every node currently visible inside the scroll
//            viewport (so the user frames the export by zooming / panning).
//
//   How:   the selection only chooses WHAT to include — never HOW it looks.
//          Everything renders in the map's normal, un-highlighted style (no
//          selection-trace borders, no bold/effect-coloured edges).
//
//   Reflow (always): empty stage columns and stream rows are dropped, and the
//   surviving stream rows are reordered so heavily-connected streams sit
//   adjacent — bringing far-apart but connected nodes closer together. Stage
//   columns keep their left→right order; the grid meaning is preserved.
//
// The rendered SVG is fully self-contained: every colour is resolved from the
// CSS custom properties to a literal value, and the only fonts used are the
// system stack (Arial/Helvetica/sans-serif) the map already uses — so the
// output needs no external CSS, fonts, or scripts.
// =============================================================================

// A literal closing-script tag would break this file once build-dist.py
// inlines it into a single HTML page, so assemble the closing tag from pieces
// (its bytes never contain the contiguous closing sequence).
var EXPORT_CLOSE_SCRIPT = "<" + "/script>";

// Monotonic counter for unique per-node gradient ids in the export SVG.
let _xnodeGradSeq = 0;

// ───── Resolve the live theme's colours to literal values ──────────────────
function exportPalette() {
  const root = getComputedStyle(document.documentElement);
  const v = (name, fallback) => {
    const raw = (root.getPropertyValue(name) || "").trim();
    return raw || fallback;
  };
  return {
    bgDeep:        v("--bg-deep",        "#111827"),
    bgDeepest:     v("--bg-deepest",     "#0a0e1a"),
    bgLight:       v("--bg-light",       "#232a3d"),
    borderSubtle:  v("--border-subtle",  "#2a3346"),
    textPrimary:   v("--text-primary",   "#e7ecf3"),
    textSecondary: v("--text-secondary", "#a1adc4"),
    textTertiary:  v("--text-tertiary",  "#6b7691"),
    edgeDefault:   v("--edge-default",   "#3a455e"),
    statusGood:    v("--status-good",    "#10b981"),
    statusBad:     v("--status-bad",     "#f87171"),
  };
}

// ───── Which nodes/edges to include ────────────────────────────────────────
// Returns { nodeIds:Set, edges:[edge], selectionActive:bool }.
function getExportSelection() {
  const singleSelected = state.selectedNodeId &&
    (!state.selectedNodeIds || state.selectedNodeIds.size <= 1);

  if (singleSelected) {
    const ids = new Set([state.selectedNodeId]);
    if (state.ancestorSet)   state.ancestorSet.forEach(id => ids.add(id));
    if (state.descendantSet) state.descendantSet.forEach(id => ids.add(id));
    // Only the edges highlighted by the current highlight depth.
    const edges = EDGES.filter(e =>
      state.highlightedEdgeIds && state.highlightedEdgeIds.has(e.id) &&
      ids.has(e.from) && ids.has(e.to));
    return { nodeIds: ids, edges, selectionActive: true };
  }

  // No single selection → everything visible within the scroll viewport.
  const rect = visibleLayoutRect();
  const ids = new Set();
  for (const node of NODES) {
    if (!isNodeVisible(node)) continue;
    const pos = layout.positions[node.id];
    if (!pos) continue;                       // nodes in collapsed stages have no position
    if (rect && !rectsOverlap(pos, rect)) continue;
    ids.add(node.id);
  }
  const edges = EDGES.filter(e => ids.has(e.from) && ids.has(e.to));
  return { nodeIds: ids, edges, selectionActive: false };
}

// The currently-visible region of the map, in unscaled layout coordinates
// (the scroll container scrolls the zoom-scaled SVG, so divide by zoom).
function visibleLayoutRect() {
  const scrollEl = document.getElementById("viz-scroll");
  if (!scrollEl) return null;
  const zoom = (state.zoomLevel && !isNaN(state.zoomLevel)) ? state.zoomLevel : 1.0;
  return {
    x:      scrollEl.scrollLeft  / zoom,
    y:      scrollEl.scrollTop   / zoom,
    width:  scrollEl.clientWidth / zoom,
    height: scrollEl.clientHeight/ zoom,
  };
}
function rectsOverlap(a, b) {
  return a.x < b.x + b.width  && a.x + a.width  > b.x &&
         a.y < b.y + b.height && a.y + a.height > b.y;
}

// ───── Reorder stream rows to minimise edge length ─────────────────────────
// Greedy chains, one per connected cluster of streams. Seed each chain with the
// heaviest remaining pair of streams, then grow it on both ends by repeatedly
// attaching the unplaced stream with the strongest tie to either end. When a
// chain can no longer grow we start a NEW chain from the next-heaviest pair, so
// every cluster gets packed together (not just the first). Clusters are emitted
// heaviest-first; streams with no cross-stream edges keep their original order
// at the end. Deterministic (ties broken by original index).
function orderExportStreams(streamIds, edges) {
  const present = streamIds.slice();
  const n = present.length;
  if (n <= 2) return present;

  const idx = new Map(present.map((s, i) => [s, i]));
  const W = present.map(() => new Array(n).fill(0));
  for (const e of edges) {
    const a = nodeById[e.from] && nodeById[e.from].stream;
    const b = nodeById[e.to]   && nodeById[e.to].stream;
    if (a == null || b == null || a === b) continue;
    if (!idx.has(a) || !idx.has(b)) continue;
    const i = idx.get(a), j = idx.get(b);
    W[i][j] += 1; W[j][i] += 1;
  }

  const placed = new Array(n).fill(false);
  const order = [];

  // Strongest-weighted unplaced neighbour of `node` (ties → lowest index).
  const strongestUnplaced = node => {
    let bestK = -1, bestW = 0;
    for (let k = 0; k < n; k++) {
      if (placed[k]) continue;
      if (W[node][k] > bestW || (W[node][k] === bestW && bestW > 0 && (bestK === -1 || k < bestK))) {
        bestW = W[node][k]; bestK = k;
      }
    }
    return { k: bestK, w: bestW };
  };

  while (order.length < n) {
    // Seed: heaviest edge among the still-unplaced streams.
    let bi = -1, bj = -1, bw = 0;
    for (let i = 0; i < n; i++) {
      if (placed[i]) continue;
      for (let j = i + 1; j < n; j++) {
        if (placed[j]) continue;
        if (W[i][j] > bw) { bw = W[i][j]; bi = i; bj = j; }
      }
    }
    if (bw <= 0) {                       // no edges left among unplaced streams
      for (let k = 0; k < n; k++) if (!placed[k]) order.push(k);
      break;
    }
    // Grow this cluster's chain on both ends until it can't extend.
    const chain = [bi, bj];
    placed[bi] = placed[bj] = true;
    for (;;) {
      const atHead = strongestUnplaced(chain[0]);
      const atTail = strongestUnplaced(chain[chain.length - 1]);
      if (atTail.w >= atHead.w && atTail.w > 0)      { placed[atTail.k] = true; chain.push(atTail.k); }
      else if (atHead.w > 0)                         { placed[atHead.k] = true; chain.unshift(atHead.k); }
      else break;
    }
    for (const c of chain) order.push(c);
  }
  return order.map(i => present[i]);
}

// ───── Packed layout over the included subset ──────────────────────────────
function computeExportLayout(nodeIds, streamOrder, stageIds) {
  // Group included nodes into cells, preserving each cell's current vertical
  // stacking order (so the reflow doesn't shuffle nodes within a cell).
  const cells = {};
  for (const node of NODES) {
    if (!nodeIds.has(node.id)) continue;
    const key = node.stream + ":" + node.stage;
    (cells[key] || (cells[key] = [])).push(node);
  }
  for (const key in cells) {
    cells[key].sort((a, b) => {
      const ya = layout.positions[a.id] ? layout.positions[a.id].y : 0;
      const yb = layout.positions[b.id] ? layout.positions[b.id].y : 0;
      return ya - yb;
    });
  }

  // Columns: packed left→right over the included stages only.
  const colX = {};
  let cursorX = SVG_PADDING_LEFT + ROW_HEADER_WIDTH;
  for (const stageId of stageIds) {
    colX[stageId] = cursorX;
    cursorX += NODE_WIDTH + COL_GAP;
  }
  const totalWidth = cursorX - COL_GAP + SVG_PADDING_RIGHT;

  // Rows: packed top→bottom over the (reordered) included streams. Row height
  // is the tallest cell's SUMMED stack height (nodes grow to fit their labels),
  // reusing each node's grown height from the live layout.
  // Per-node grown height: reuse the live layout's measurement, falling back to
  // a fresh measure for any node without a live position (e.g. one in a stage
  // that's collapsed on the canvas but pulled into a selection export).
  const exHeight = id => {
    const p = layout.positions[id];
    if (p && p.height) return p.height;
    const n = nodeById[id];
    return n ? measureNode(n).height : NODE_HEIGHT;
  };
  const rowHeights = {}, rowY = {};
  for (const streamId of streamOrder) {
    let maxContent = 0;
    for (const stageId of stageIds) {
      const c = cells[streamId + ":" + stageId];
      if (!c || !c.length) continue;
      let sum = 0;
      for (const n of c) sum += exHeight(n.id);
      sum += (c.length - 1) * NODE_GAP_Y;
      if (sum > maxContent) maxContent = sum;
    }
    rowHeights[streamId] = (maxContent || NODE_HEIGHT) + ROW_PADDING * 2;   // floor empty rows only (matches live)
  }
  let cursorY = SVG_PADDING_TOP + COL_HEADER_HEIGHT;
  for (const streamId of streamOrder) {
    rowY[streamId] = cursorY;
    cursorY += rowHeights[streamId];
  }
  const totalHeight = cursorY + SVG_PADDING_BOTTOM;

  const positions = {};
  for (const streamId of streamOrder) {
    for (const stageId of stageIds) {
      const c = cells[streamId + ":" + stageId];
      if (!c) continue;
      let y = rowY[streamId] + ROW_PADDING;
      for (let i = 0; i < c.length; i++) {
        const h = exHeight(c[i].id);
        const live = layout.positions[c[i].id];
        const lines = (live && live.labelLines) || measureLabelLines(c[i].label || c[i].id || "", NODE_WIDTH - LABEL_INSET * 2);
        positions[c[i].id] = { x: colX[stageId], y: y, width: NODE_WIDTH, height: h, labelLines: lines };
        y += h + NODE_GAP_Y;
      }
    }
  }
  return { positions, totalWidth, totalHeight, rowY, rowHeights, colX };
}

// ───── Assemble the export model ───────────────────────────────────────────
function buildExportModel() {
  if (!state.dataLoaded || !layout) return null;
  const sel = getExportSelection();
  if (sel.nodeIds.size === 0) return null;

  const streamsPresent = new Set(), stagesPresent = new Set();
  for (const id of sel.nodeIds) {
    const nd = nodeById[id];
    if (!nd) continue;
    streamsPresent.add(nd.stream);
    stagesPresent.add(nd.stage);
  }
  const stageIds        = STAGES.filter(s => stagesPresent.has(s.id)).map(s => s.id);
  const includedStreams = STREAMS.filter(s => streamsPresent.has(s.id)).map(s => s.id);
  const streamOrder     = orderExportStreams(includedStreams, sel.edges);
  const exLayout        = computeExportLayout(sel.nodeIds, streamOrder, stageIds);

  return {
    nodeIds: sel.nodeIds,
    edges: sel.edges,
    selectionActive: sel.selectionActive,
    stageIds,
    streamOrder,
    layout: exLayout,
  };
}

// ───── Bezier path between two node boxes (matches the live renderer) ──────
function exportEdgePath(fromPos, toPos) {
  const startX = fromPos.x + fromPos.width;
  const startY = fromPos.y + fromPos.height / 2;
  const endX   = toPos.x;
  const endY   = toPos.y + toPos.height / 2;
  const ctrlOffset = Math.max(40, Math.abs(endX - startX) * 0.5);
  return "M " + startX + "," + startY +
         " C " + (startX + ctrlOffset) + "," + startY +
         " " + (endX - ctrlOffset) + "," + endY +
         " " + endX + "," + endY;
}

// Outcome-status border colour (good/bad vs baseline) → literal palette value,
// or null. This is part of the map's normal resting appearance, not a
// selection highlight.
function exportOutcomeBorder(nodeId, pal) {
  const c = getOutcomeBorderColor(nodeId);
  if (!c) return null;
  return c.indexOf("good") >= 0 ? pal.statusGood : pal.statusBad;
}

// Node border for an export. The selection only decides WHAT to export, never
// HOW it looks, so nodes always render in their normal, un-highlighted state:
// the default border, plus the good/bad outcome border the live map shows when
// nothing is selected — never the white / blue / amber selection-trace borders.
function exportNodeStroke(nodeId, pal) {
  const outcome = exportOutcomeBorder(nodeId, pal);
  if (outcome) return { color: outcome, width: 2 };
  return { color: "rgba(0,0,0,0.4)", width: 1 };
}

// ───── Render the model to a self-contained SVG string ─────────────────────
// Returns { svg, width, height, nodeInfo } where nodeInfo maps node id →
// metadata used by the published HTML viewer's hover tooltips.
function renderExportSvg(model, opts) {
  opts = opts || {};
  const pal = opts.pal || exportPalette();
  const lay = model.layout;
  const W = lay.totalWidth, H = lay.totalHeight;
  const nodeInfo = {};

  let s = "";
  s += '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H +
       '" viewBox="0 0 ' + W + ' ' + H + '">';

  // Fonts + text sizing baked in (values mirror 05-visualization.css).
  s += '<style>'
     +   'text{font-family:Arial,Helvetica,sans-serif;}'
     +   '.xn-label{font-size:12px;font-weight:500;}'
     +   '.xn-value{font-size:10.5px;font-weight:500;}'
     +   '.xn-delta{font-size:10.5px;font-weight:600;}'
     +   '.xr-label{font-size:11px;font-weight:600;letter-spacing:0.1em;}'
     +   '.xc-header{font-size:11px;font-weight:600;letter-spacing:0.12em;}'
     + '</style>';

  // Background.
  s += '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="' + pal.bgDeep + '"></rect>';

  // Per-stream background stripe + top divider.
  for (const streamId of model.streamOrder) {
    const stream = streamById[streamId] || { color: "#94a3b8" };
    const y = lay.rowY[streamId], h = lay.rowHeights[streamId];
    s += '<rect x="0" y="' + y + '" width="' + W + '" height="' + h + '" fill="' + stream.color + '" opacity="0.04"></rect>';
    s += '<line x1="0" y1="' + y + '" x2="' + W + '" y2="' + y + '" stroke="' + pal.borderSubtle + '" stroke-width="1"></line>';
  }

  // Column-header band + stage labels + vertical dividers.
  const headerBandBottom = SVG_PADDING_TOP + COL_HEADER_HEIGHT;
  s += '<rect x="0" y="0" width="' + W + '" height="' + headerBandBottom + '" fill="' + pal.bgDeep + '"></rect>';
  for (let i = 0; i < model.stageIds.length; i++) {
    const stageId = model.stageIds[i];
    const stage = stageById[stageId] || { label: stageId };
    const cx = lay.colX[stageId] + NODE_WIDTH / 2;
    s += '<text class="xc-header" x="' + cx + '" y="' + (SVG_PADDING_TOP + 24) +
         '" text-anchor="middle" fill="' + pal.textSecondary + '">' + escapeHtml(stage.label) + '</text>';
    if (i < model.stageIds.length - 1) {
      const dividerX = lay.colX[stageId] + NODE_WIDTH + COL_GAP / 2;
      s += '<line x1="' + dividerX + '" y1="' + headerBandBottom + '" x2="' + dividerX + '" y2="' + H +
           '" stroke="' + pal.borderSubtle + '" stroke-width="1" stroke-dasharray="2 4" opacity="0.6"></line>';
    }
  }

  // Row-label strip (stream short codes).
  for (const streamId of model.streamOrder) {
    const stream = streamById[streamId] || { short: streamId, color: "#94a3b8" };
    const y = lay.rowY[streamId], h = lay.rowHeights[streamId];
    s += '<rect x="0" y="' + y + '" width="' + ROW_HEADER_WIDTH + '" height="' + h + '" fill="' + pal.bgDeepest + '"></rect>';
    s += '<rect x="' + (ROW_HEADER_WIDTH - 4) + '" y="' + y + '" width="4" height="' + h + '" fill="' + stream.color + '" opacity="0.7"></rect>';
    s += '<text class="xr-label" x="' + (ROW_HEADER_WIDTH / 2) + '" y="' + (y + h / 2) +
         '" text-anchor="middle" dominant-baseline="middle" fill="' + stream.color + '">' + escapeHtml(stream.short) + '</text>';
  }

  // Edges (drawn before nodes). Rendered in the map's normal, un-highlighted
  // style — gray, thin, semi-transparent, no arrowhead (exactly how the live
  // map draws an edge when nothing is selected). Effect colours and arrowheads
  // are the app's *highlight* state, so they are deliberately not used here.
  for (const edge of model.edges) {
    const fromPos = lay.positions[edge.from], toPos = lay.positions[edge.to];
    if (!fromPos || !toPos) continue;
    const dashAttr = edge.style === "dashed" ? ' stroke-dasharray="6 5"' : '';
    s += '<path d="' + exportEdgePath(fromPos, toPos) + '" fill="none" stroke="' + pal.edgeDefault +
         '" stroke-width="1" stroke-opacity="0.45"' + dashAttr + '></path>';
  }

  // Nodes.
  for (const node of NODES) {
    if (!model.nodeIds.has(node.id)) continue;
    const pos = lay.positions[node.id];
    if (!pos) continue;
    const stream   = streamById[node.stream]   || { color: "#94a3b8" };
    const fillInfo = nodePrimaryFill(node, "xgrad_" + (_xnodeGradSeq++));
    const chips    = nodeSecondaryChips(node, pos);
    const stroke   = exportNodeStroke(node.id, pal);

    s += '<g class="xnode" data-node-id="' + escapeHtml(node.id) + '">';
    s += fillInfo.defs;   // per-node gradient (empty unless multi-primary)

    // Background rect.
    s += '<rect x="' + pos.x + '" y="' + pos.y + '" width="' + pos.width + '" height="' + pos.height +
         '" rx="5" fill="' + fillInfo.fill + '" stroke="' + stroke.color + '" stroke-width="' + stroke.width + '"></rect>';

    // Left stream-colour stripe (rounded only on the left corners).
    const barRadius = 5, barLeft = pos.x, barRight = pos.x + 6, barTop = pos.y, barBottom = pos.y + pos.height;
    s += '<path d="M ' + (barLeft + barRadius) + ',' + barTop +
         ' L ' + barRight + ',' + barTop +
         ' L ' + barRight + ',' + barBottom +
         ' L ' + (barLeft + barRadius) + ',' + barBottom +
         ' A ' + barRadius + ',' + barRadius + ' 0 0 1 ' + barLeft + ',' + (barBottom - barRadius) +
         ' L ' + barLeft + ',' + (barTop + barRadius) +
         ' A ' + barRadius + ',' + barRadius + ' 0 0 1 ' + (barLeft + barRadius) + ',' + barTop +
         ' Z" fill="' + stream.color + '"></path>';

    // Wrapped label — reuse the same grow-to-fit lines the layout sized the box
    // from, so the export matches the live map. Anchored at the symmetric inset.
    const labelLines = pos.labelLines || measureLabelLines(node.label || node.id || "", NODE_WIDTH - LABEL_INSET * 2);
    const lx = pos.x + LABEL_INSET;
    s += '<text class="xn-label" x="' + lx + '" y="' + (pos.y + 16) +
         '" fill="' + fillInfo.textColor + '" dominant-baseline="middle">';
    for (let i = 0; i < labelLines.length; i++) {
      s += '<tspan x="' + lx + '" dy="' + (i === 0 ? "0" : "1.083em") + '">' + escapeHtml(labelLines[i]) + '</tspan>';
    }
    s += '</text>';

    // Value + delta (only for quantified nodes).
    const valueText = formatNodeValue(node.id);
    if (valueText) {
      const valueY = pos.y + pos.height - 12;
      s += '<text class="xn-value" x="' + (pos.x + LABEL_INSET) + '" y="' + valueY +
           '" fill="' + fillInfo.textColor + '" dominant-baseline="middle" opacity="0.75">' + escapeHtml(valueText) + '</text>';
      const deltaInfo = formatNodeDelta(node.id);
      if (deltaInfo.text && deltaInfo.text !== "—") {
        let deltaColor;
        if (node.direction === "higher_better")      deltaColor = deltaInfo.pct > 0 ? "#065f46" : "#7f1d1d";
        else if (node.direction === "lower_better")  deltaColor = deltaInfo.pct < 0 ? "#065f46" : "#7f1d1d";
        else                                         deltaColor = deltaInfo.pct > 0 ? "#1e3a8a" : "#7c2d12";
        const deltaX = chips.svg ? chips.leftEdge - 6 : pos.x + pos.width - LABEL_INSET;
        s += '<text class="xn-delta" x="' + deltaX + '" y="' + valueY +
             '" fill="' + deltaColor + '" text-anchor="end" dominant-baseline="middle">' + escapeHtml(deltaInfo.text) + '</text>';
      }
    }

    // Secondary category chips (bottom-right).
    s += chips.svg;

    s += '</g>';

    // Tooltip metadata for the published viewer.
    nodeInfo[node.id] = {
      label:       node.label || node.id,
      description: node.description || "",
      value:       valueText || "",
      stream:      stream.label || node.stream || "",
      stage:       (stageById[node.stage] && stageById[node.stage].label) || node.stage || "",
      category:    (node.categoryIds && node.categoryIds.length ? node.categoryIds : [node.category])
                     .map(id => (CATEGORIES[id] && CATEGORIES[id].label) || id).filter(Boolean).join(", "),
    };
  }

  s += '</svg>';
  return { svg: s, width: W, height: H, nodeInfo };
}

// ───── Download helper (generic text/binary-ish blob) ──────────────────────
function downloadTextBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime || "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Target raster density. We render at this multiple of the map's natural size
// so the PNG stays crisp when displayed or printed much larger than 1:1.
const EXPORT_PNG_SCALE = 3;
// Conservative canvas ceilings (Chrome caps a side at 16384px and the total
// area well below 2^31). Exceeding either yields a blank/failed canvas, so we
// back the density off for very large maps rather than fail.
const EXPORT_MAX_CANVAS_DIM  = 16384;
const EXPORT_MAX_CANVAS_AREA = 16384 * 16384;

// Rasterize the export SVG to a PNG Blob. Returns a Promise<Blob> so it can be
// handed straight to ClipboardItem (which keeps the originating user-gesture
// alive while the image loads).
//
// Crucially, the SVG is rendered at the *scaled* size (its width/height grow
// while the viewBox stays in layout coordinates), so the browser rasterizes
// the vectors at full target resolution — genuinely sharp at any size — rather
// than upscaling a low-resolution bitmap. The density is clamped so the canvas
// never exceeds the browser's limits; for very large maps it drops below the
// target (even below 1×) to produce the largest valid image instead of failing.
function renderExportPngBlob(svg, width, height, pal) {
  return new Promise((resolve, reject) => {
    let scale = Math.min(
      EXPORT_PNG_SCALE,
      EXPORT_MAX_CANVAS_DIM / width,
      EXPORT_MAX_CANVAS_DIM / height,
      Math.sqrt(EXPORT_MAX_CANVAS_AREA / (width * height))
    );
    if (!isFinite(scale) || scale <= 0) scale = 1;

    const cw = Math.max(1, Math.round(width  * scale));
    const ch = Math.max(1, Math.round(height * scale));

    // Grow the SVG's intrinsic size to the raster size (viewBox unchanged) so
    // it rasterizes vector-sharp at full resolution.
    const scaledSvg = svg.replace(
      /^(<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg") width="[^"]*" height="[^"]*"/,
      '$1 width="' + cw + '" height="' + ch + '"'
    );
    // Blob URL (not a data: URI) so very large maps aren't capped by data-URI
    // length limits. Self-contained, same-origin → does not taint the canvas.
    const blobUrl = URL.createObjectURL(new Blob([scaledSvg], { type: "image/svg+xml;charset=utf-8" }));

    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width  = cw;
        canvas.height = ch;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = pal.bgDeep || "#111827";
        ctx.fillRect(0, 0, cw, ch);
        ctx.drawImage(img, 0, 0, cw, ch);   // 1:1 — image already at full res
        URL.revokeObjectURL(blobUrl);
        if (!canvas.toBlob) { reject(new Error("Canvas.toBlob unsupported")); return; }
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("PNG encoding failed")), "image/png");
      } catch (e) { URL.revokeObjectURL(blobUrl); reject(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(blobUrl); reject(new Error("SVG image failed to load")); };
    img.src = blobUrl;
  });
}

// ───── PUBLIC: copy the canvas to the clipboard as a PNG image ─────────────
function exportCanvasImage() {
  const model = buildExportModel();
  if (!model) { showLoadFeedback("Nothing to export — load a map or zoom to some nodes.", true); return; }

  if (!navigator.clipboard || typeof ClipboardItem === "undefined" || !navigator.clipboard.write) {
    showLoadFeedback("Clipboard image copy isn't available in this browser. Try opening the app over http/localhost.", true);
    return;
  }

  const pal = exportPalette();
  const { svg, width, height } = renderExportSvg(model, { pal });

  // Hand ClipboardItem a Promise<Blob> so the write stays tied to the click
  // gesture even though rasterization is asynchronous.
  const blobPromise = renderExportPngBlob(svg, width, height, pal);
  navigator.clipboard.write([new ClipboardItem({ "image/png": blobPromise })])
    .then(() => showLoadFeedback("Map image copied to clipboard.", false))
    .catch(err => {
      console.error("Clipboard copy failed:", err);
      showLoadFeedback("Couldn't copy to clipboard: " + (err && err.message ? err.message : "permission denied"), true);
    });
}

// ───── PUBLIC: publish as a view-only HTML page ────────────────────────────
function publishCanvasHtml() {
  const model = buildExportModel();
  if (!model) { showLoadFeedback("Nothing to publish — load a map or zoom to some nodes.", true); return; }
  const pal = exportPalette();
  const { svg, width, height, nodeInfo } = renderExportSvg(model, { pal });
  const html = buildPublishHtml(svg, width, height, nodeInfo, pal);
  downloadTextBlob(html, "systems-map.html", "text/html;charset=utf-8");
  showLoadFeedback("Published systems-map.html (view-only)", false);
}

// Wrap the SVG in a minimal, self-contained pan / zoom / hover viewer.
function buildPublishHtml(svg, width, height, nodeInfo, pal) {
  // Guard the embedded JSON against closing-tag breakouts by escaping "<".
  const infoJson = JSON.stringify(nodeInfo).replace(/</g, "\\u003c");

  const viewerJs =
    '(function(){' +
    'var W=' + width + ',H=' + height + ';' +
    'var INFO=' + infoJson + ';' +
    'var scroll=document.getElementById("mv-scroll");' +
    'var svg=document.getElementById("mv-svg");' +
    'var tip=document.getElementById("mv-tip");' +
    'var readout=document.getElementById("mv-zoom");' +
    'var z=1;' +
    'function clamp(v){return Math.max(0.2,Math.min(4,v));}' +
    'function apply(){svg.style.width=(W*z)+"px";svg.style.height=(H*z)+"px";readout.textContent=Math.round(z*100)+"%";}' +
    'function zoomTo(nz,cx,cy){var oz=z;nz=clamp(nz);if(nz===oz)return;' +
      'var r=scroll.getBoundingClientRect();var px=(cx==null?r.width/2:cx-r.left);var py=(cy==null?r.height/2:cy-r.top);' +
      'var lx=(px+scroll.scrollLeft)/oz, ly=(py+scroll.scrollTop)/oz;' +
      'z=nz;apply();scroll.scrollLeft=lx*z-px;scroll.scrollTop=ly*z-py;}' +
    'function fit(){var r=scroll.getBoundingClientRect();z=clamp(Math.min(r.width/W,r.height/H,1));apply();}' +
    'document.getElementById("mv-in").onclick=function(){zoomTo(z+0.1);};' +
    'document.getElementById("mv-out").onclick=function(){zoomTo(z-0.1);};' +
    'document.getElementById("mv-fit").onclick=function(){fit();};' +
    'readout.onclick=function(){zoomTo(1);};' +
    'scroll.addEventListener("wheel",function(e){if(!(e.ctrlKey||e.metaKey))return;e.preventDefault();zoomTo(z*Math.exp(-e.deltaY*0.0035),e.clientX,e.clientY);},{passive:false});' +
    'var pan=null;' +
    'scroll.addEventListener("mousedown",function(e){if(e.button!==0)return;if(e.target.closest&&e.target.closest(".xnode"))return;pan={x:e.clientX,y:e.clientY,l:scroll.scrollLeft,t:scroll.scrollTop};document.body.style.cursor="grabbing";});' +
    'window.addEventListener("mousemove",function(e){if(pan){scroll.scrollLeft=pan.l-(e.clientX-pan.x);scroll.scrollTop=pan.t-(e.clientY-pan.y);}});' +
    'window.addEventListener("mouseup",function(){pan=null;document.body.style.cursor="";});' +
    'function showTip(id,e){var d=INFO[id];if(!d)return;' +
      'var h="<div class=\\"t-title\\">"+esc(d.label)+"</div>";' +
      'var meta=[d.stream,d.stage,d.category].filter(Boolean).join(" \\u00b7 ");' +
      'if(meta)h+="<div class=\\"t-meta\\">"+esc(meta)+"</div>";' +
      'if(d.value)h+="<div class=\\"t-val\\">"+esc(d.value)+"</div>";' +
      'if(d.description)h+="<div class=\\"t-desc\\">"+esc(d.description)+"</div>";' +
      'tip.innerHTML=h;tip.style.display="block";moveTip(e);}' +
    'function moveTip(e){var pad=14;var w=tip.offsetWidth,ht=tip.offsetHeight;' +
      'var x=e.clientX+pad,y=e.clientY+pad;' +
      'if(x+w>window.innerWidth)x=e.clientX-w-pad;if(y+ht>window.innerHeight)y=e.clientY-ht-pad;' +
      'tip.style.left=x+"px";tip.style.top=y+"px";}' +
    'function esc(t){return String(t).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}' +
    'svg.addEventListener("mouseover",function(e){var g=e.target.closest&&e.target.closest(".xnode");if(g)showTip(g.getAttribute("data-node-id"),e);});' +
    'svg.addEventListener("mousemove",function(e){if(tip.style.display==="block")moveTip(e);});' +
    'svg.addEventListener("mouseout",function(e){var g=e.target.closest&&e.target.closest(".xnode");if(g)tip.style.display="none";});' +
    'apply();fit();' +
    '})();';

  return '<!DOCTYPE html>' +
    '<html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Systems Map</title>' +
    '<style>' +
      '*{box-sizing:border-box;}' +
      'html,body{margin:0;height:100%;background:' + pal.bgDeepest + ';' +
        'font-family:Arial,Helvetica,sans-serif;color:' + pal.textPrimary + ';overflow:hidden;}' +
      '#mv-scroll{position:absolute;inset:0;overflow:auto;cursor:grab;}' +
      '#mv-inner{padding:0;}' +
      '#mv-svg{display:block;}' +
      // Zoom card — matches the main app's .viz-zoom-controls styling exactly
      // (titled glass card, transparent borderless buttons, same tokens).
      '#mv-toolbar{position:fixed;top:12px;right:12px;z-index:10;display:flex;flex-direction:column;gap:3px;' +
        'width:120px;padding:5px 6px;border-radius:6px;background:' + pal.bgDeep + 'd9;backdrop-filter:blur(8px);' +
        'font-family:Arial,Helvetica,sans-serif;}' +
      '#mv-title{color:' + pal.textTertiary + ';font-size:9px;text-transform:uppercase;letter-spacing:0.08em;text-align:center;white-space:nowrap;}' +
      '#mv-row{display:flex;align-items:center;justify-content:space-between;gap:2px;}' +
      '#mv-toolbar button{background:transparent;border:none;color:' + pal.textSecondary + ';border-radius:4px;height:26px;' +
        'line-height:1;display:flex;align-items:center;justify-content:center;padding:0;font-family:inherit;cursor:pointer;' +
        'transition:background 0.15s,color 0.15s;}' +
      '#mv-out,#mv-in{width:26px;font-size:16px;}' +
      '#mv-zoom{flex:1;font-size:11px;letter-spacing:0.04em;}' +
      '#mv-fit{width:100%;font-size:10px;text-transform:uppercase;letter-spacing:0.08em;}' +
      '#mv-toolbar button:hover{color:' + pal.textPrimary + ';background:' + pal.bgLight + ';}' +
      '#mv-tip{position:fixed;display:none;max-width:300px;background:' + pal.bgDeep + ';border:1px solid ' + pal.borderSubtle + ';' +
        'border-radius:6px;padding:8px 10px;font-size:12px;pointer-events:none;z-index:20;box-shadow:0 8px 24px rgba(0,0,0,0.5);}' +
      '#mv-tip .t-title{font-weight:600;font-size:13px;margin-bottom:2px;}' +
      '#mv-tip .t-meta{color:' + pal.textTertiary + ';font-size:10.5px;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px;}' +
      '#mv-tip .t-val{color:' + pal.textSecondary + ';margin-bottom:4px;}' +
      '#mv-tip .t-desc{color:' + pal.textSecondary + ';line-height:1.4;}' +
      '#mv-hint{position:fixed;bottom:12px;left:12px;font-size:11px;color:' + pal.textTertiary + ';z-index:10;}' +
    '</style></head><body>' +
    '<div id="mv-scroll"><div id="mv-inner">' + svg.replace('<svg ', '<svg id="mv-svg" ') + '</div></div>' +
    '<div id="mv-tip"></div>' +
    '<div id="mv-toolbar">' +
      '<span id="mv-title">Zoom</span>' +
      '<div id="mv-row">' +
        '<button id="mv-out" title="Zoom out" aria-label="Zoom out">−</button>' +
        '<button id="mv-zoom" title="Reset zoom (click)">100%</button>' +
        '<button id="mv-in" title="Zoom in" aria-label="Zoom in">+</button>' +
      '</div>' +
      '<button id="mv-fit" title="Fit to screen">Fit</button>' +
    '</div>' +
    '<div id="mv-hint">Drag to pan · Ctrl/⌘ + scroll to zoom · hover a node for details</div>' +
    '<script>' + viewerJs + EXPORT_CLOSE_SCRIPT +
    '</body></html>';
}
