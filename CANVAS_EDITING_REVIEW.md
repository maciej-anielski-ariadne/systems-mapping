# Canvas Editing Review — Ariadne Maps

## Context

The app boots into an empty 3×3 grid and the README positions canvas direct editing as the **recommended path for non-technical users**. This document audits what works, what's missing, and what's awkward — with the explicit example of "can't move nodes between or within streams" as a known pain point.

This document is (a) an honest catalogue of the current state, (b) a ranked list of gaps and rough edges, and (c) concrete implementation plans for the four highest-impact fixes so they can be shipped in a follow-up turn.

Scope is the canvas + adjacent surfaces that drive canvas state: gestures (`16e-canvas-edit.js`), mutations (`16f-canvas-mutations.js`), undo (`16g-canvas-undo.js`), rendering (`11-rendering.js`), layout (`08-layout.js`), the detail panel's edit mode (`15-detail-panel.js`), and the sidebar (`13-sidebar.js`). The builder wizard is out of scope — it's a separate editing path.

---

## Part 1 — What works today

| Capability | Gesture | Where |
|---|---|---|
| Add node | Click empty cell (ghost preview shows "+ add node" / "+ add another") | `16e-canvas-edit.js:252-285` |
| Create edge | Drag from node's right-edge handle → drop on target → pick effect | `16e:324-471` |
| Select node | Click node | `11-rendering.js:360-365` → `selectNode` (`09-graph-selection.js:73`) |
| Navigate to edge's source | Click edge body (wide hit-path) | `16e:164-170` → `selectEdge` (`09:102`) |
| Delete node | `Delete` / `Backspace` on selected node, or "Delete node" button in edit panel | `16e:79-81, 481-503` |
| Delete edge | × button in detail panel's outgoing-edges list | `15-detail-panel.js:388-393` → `16e:507-518` |
| Cancel edge drag | `Escape` | `16e:66-72, 384-395` |
| Edit node fields | Detail panel "Edit Node" toggle → label, description, stream/stage/category, baseline, unit, controllable, direction, sliderMax | `15-detail-panel.js:170-207, 439-492` |
| Add/edit outgoing edge | Detail panel edit mode → "+ Add outgoing edge" / per-row dropdowns | `15:242-310` |
| Add/delete/rename/recolor/reorder streams, stages, categories | Sidebar pencil-expand + drag-handle | `13-sidebar.js` + `16f:51-237` |
| Toggle stream/category visibility | Click sidebar swatch or canvas row label | `13:120-121`, `11:380-392` |
| Undo last delete | 6-second toast at bottom of screen | `16g-canvas-undo.js` |
| Pan | Click-drag any empty SVG area; wheel/two-finger scroll | `17-events.js:371-428` |
| Zoom | Ctrl/Cmd+wheel; +/- buttons; Ctrl/Cmd+=/-/0 | `17:233-369` |
| Persist | Every mutation re-serializes to CSV and writes to `localStorage` | `16f:36-48` |

The architecture is clean: every mutation funnels through `applyCanvasMutation()` (`16f:36-48`) which rebuilds indexes, recomputes layout, recomputes simulation values, re-renders, and persists. This is a good chokepoint to extend.

---

## Part 2 — Missing features (ranked by user impact)

### Tier 1 — Foundational gestures users expect

1. **Cannot drag a node to a different cell** (different stream or different stage). The only way to move a node is open the detail panel, click Edit, change two dropdowns. Data model fully supports the move — `node.stream` and `node.stage` are plain editable fields and the CSV round-trips them as-is. This is **gesture-only** missing. *(`15-detail-panel.js:184-187, 464-469` is the existing dropdown path; no mousedown handler on `.node-group` for drag.)*

2. **Cannot reorder nodes within the same cell.** Siblings in `(stream, stage)` are stacked vertically by NODES array order (`08-layout.js:77-84`). There is no `order` field — sibling order = array position. Reordering would mean splicing the NODES array. No UI exists. *(README explicitly says nodes "don't affect rendering, so the wizard doesn't expose handles there" — this is incorrect; vertical order in a cell IS determined by NODES order, and the wizard's lack of handles propagates the limitation into canvas too.)*

3. **Cannot delete an edge directly from the canvas.** Clicking an edge calls `selectEdge` which jumps you into the source node's edit mode and scrolls the edge row into view — you then have to find and click the × button. `Delete` while an edge is "selected" does nothing because `deleteSelection` only checks `state.selectedNodeId` (`16e:482`). No `state.selectedEdgeId` exists. *(`09-graph-selection.js:102-137` shows selectEdge does navigation, not selection.)*

4. **Undo is single-level and delete-only.** `pushUndo` does `state.undoStack = [entry]` (`16g:26`) — each new delete wipes the previous. Renames, edits, moves, edge creation, reorder are not undoable at all. No `Ctrl+Z` / `Ctrl+Shift+Z`. The 6-second toast is the only path to undo, and only for the most recent delete.

### Tier 2 — High-friction omissions

5. **Cannot rename a node on the canvas.** No double-click to edit label inline. Must click node → "Edit Node" → focus label field. Especially painful right after creation, where the auto-focused label input in the detail panel is hidden behind the unpinned panel strip if the user collapsed it.

6. **Cannot drag-reorder streams or stages via canvas row/column headers.** The reorder logic exists (`16f:205-237`), and the sidebar has drag handles, but the canvas headers are click-only (and only toggle visibility for streams, nothing for stages).

7. **No multi-select.** `state.selectedNodeId` is a single id. No Shift/Ctrl+click, no rubber-band selection. Blocks bulk-delete, bulk-move, bulk-recategorise.

8. **No re-route for existing edges.** Changing source or target means delete + redraw. No drag-the-endpoint UX.

9. **No keyboard shortcut to add an edge from selection.** Power-user gap — you always have to grab the hover-only handle with the mouse.

10. **No "duplicate node" affordance.** Cloning a node with similar baseline/unit/category means recreating each field.

### Tier 3 — Polish gaps

11. **Effect picker can render off-screen.** `showEffectPicker` (`16e:413-441`) writes `left/top = clientX/Y` with no viewport-edge clamping. Drop an edge near the right or bottom edge and the picker goes under the fold.

12. **Edge-handle (drag source) is invisible until hover.** New users won't know they can drag from nodes. No empty-state hint mentions this once the first node exists (the hint at `11:347` disappears after the first add).

13. **Node delete has no confirmation.** Contrast: stream/stage/category delete uses `confirm()` showing affected counts. A node with 10 incident edges vanishes silently. The undo toast is the only safety net, and it's single-level.

14. **No discoverable keyboard help.** Delete, Escape, Ctrl-wheel-zoom, Ctrl+=/-/0 all exist; nothing surfaces them. A `?` shortcut showing a cheat sheet would close the gap.

15. **Sidebar rename/recolor/reorder are silent and not undoable.** Drag a stream from row 3 to row 1, change your mind — no toast, no undo.

16. **Native `confirm()` dialogs for cascade deletes** clash with the app's dark theme and aren't keyboard-accessible everywhere.

17. **Detail-panel re-render loses focus** on stream/stage/category dropdown changes (no `skipDetailRender` is passed — see `15-detail-panel.js:466-472`).

18. **`Backspace` deletes nodes globally** (not just `Delete`). On macOS this is the standard back/delete-character key — a user with focus outside an input but with a selected node can blow it away by reflexively hitting Backspace.

19. **No incoming-edge editing from the detail panel.** Outgoing edges are fully editable; to add/remove a parent you must navigate to the parent and edit there. Asymmetric.

20. **Duplicate (from, to, effect) edge protection only exists for canvas drag** (`16e:462-463`); the "+ Add outgoing edge" form in the detail panel doesn't check.

21. **Setting baseline to `0` silently deletes the field** (`15-detail-panel.js:474-476` — comment explains the divide-by-baseline reason, but no user feedback).

22. **Search results dropdown keyboard nav** lives outside this audit but worth a follow-up.

---

## Part 3 — Implementation plan for top 4 improvements

These four ship the biggest UX delta with the smallest surface change. They share infrastructure (drag state, sibling-index computation, undo capture), so building them together is cheaper than separately.

### 3.1 Drag a node between cells (and reorder within a cell)

These are one feature — the within-cell case is just "source cell == target cell". Build them together.

**Approach.** Mousedown on `.node-group` starts a candidate drag (no commit yet). Past a 4px threshold (mirroring `PAN_DRAG_THRESHOLD` at `17-events.js:385`), promote to a real drag: hide the node visually, render a translucent "drag preview" at the cursor, and highlight the cell under the cursor with a drop-line at the insertion index. On mouseup with a valid target, mutate `node.stream` / `node.stage` and splice the NODES array so the dragged node lands at the correct sibling position. On mouseup off-grid or with no movement, no-op.

**Files to touch.**

- `assets/js/03-state.js:46-56` — add to `canvasEdit`:
  ```js
  draggingNode: null,  // { nodeId, startClientX, startClientY, currentX, currentY,
                       //   originStreamId, originStageId, originIndex,
                       //   targetStreamId, targetStageId, targetIndex, active }
  ```
  `active` flips true once the drag passes the threshold (so a sub-threshold mouseup still fires a normal select-node click).

- `assets/js/16e-canvas-edit.js` — add three new functions next to the edge-drag helpers (~line 320):
  ```js
  function beginNodeDrag(nodeId, clientX, clientY) { /* set state, bind window listeners */ }
  function updateNodeDrag(event) { /* clientPointToLayout → cell + index lookup; set targetStreamId, targetStageId, targetIndex; render() */ }
  function endNodeDrag(event) { /* if active && valid target: mutateNodePosition(); else: nothing */ }
  function mutateNodePosition(node, targetStreamId, targetStageId, targetIndex) {
    /* node.stream = targetStreamId; node.stage = targetStageId;
       const idx = NODES.indexOf(node);
       NODES.splice(idx, 1);
       // Re-resolve target index in case the splice shifted it
       const siblings = NODES.filter(n => n.stream === targetStreamId && n.stage === targetStageId);
       const insertAt = … // see below for the algorithm
       NODES.splice(insertAt, 0, node);
       applyCanvasMutation(); */
  }
  ```
  The "insert at correct global NODES index" is the only tricky bit: targetIndex is the **sibling index in the cell**, but NODES is a flat array. Resolve it by walking NODES once and counting how many entries belong to `(targetStreamId, targetStageId)` and inserting after the (targetIndex - 1)th such entry; if targetIndex === 0, insert at the position of the first sibling (or, if no siblings yet, anywhere in NODES — order in flat array doesn't matter for cells with one node).

- `assets/js/16e-canvas-edit.js:138-150` — `attachCanvasEditHandlers`: add a mousedown handler on `.node-group` that calls `beginNodeDrag(nodeId, clientX, clientY)`. Bind it **only** on the rect/label area, NOT on `.edge-handle` (which already has its own mousedown). Check `event.target.closest(".edge-handle")` and bail if it matches.

- `assets/js/11-rendering.js:236` — add class `dragging-source` to the node-group's class string when `state.canvasEdit.draggingNode?.nodeId === node.id`. The CSS uses this to dim the original.

- `assets/js/11-rendering.js:341` — after the draft-edge block, add a similar block to render the drag preview: a translucent rectangle at `draggingNode.currentX, currentY` and an insertion drop-line in the target cell. Reuse `wrapLabel` to put the label on the preview.

- `assets/js/11-rendering.js:360-365` — node click handler: the click that fires after a successful drag must be swallowed. Mirror the pan handler's `window.addEventListener("click", swallow, { capture: true, once: true });` pattern from `17-events.js:422-425`.

- `assets/css/05-visualization.css` — add at end:
  ```css
  .node-group.dragging-source .node-rect { opacity: 0.25; }
  .node-group.dragging-source { cursor: grabbing; }
  .node-drag-preview { opacity: 0.9; pointer-events: none; filter: drop-shadow(0 6px 12px rgba(0,0,0,0.4)); }
  .drop-target-cell { fill: rgba(96, 165, 250, 0.12); stroke: var(--accent-blue); stroke-dasharray: 5 4; pointer-events: none; }
  .drop-line { stroke: var(--accent-blue); stroke-width: 2.5; stroke-linecap: round; pointer-events: none; }
  ```

- **Computing `targetIndex` (insertion slot within a cell).** Given the cursor's layout Y, find the cell's existing siblings, and:
  - If cursor is above the first sibling's vertical midline → targetIndex = 0
  - Otherwise: targetIndex = the sibling whose vertical midline the cursor is above (insert *before* it). If past the last sibling's midline → targetIndex = siblings.length (append).
  - When source cell == target cell and source index < targetIndex, subtract 1 (standard array-reorder index correction; matches `reorderStreams` at `16f:210`).

**Risks / tradeoffs.**
- Click vs drag disambiguation: must not lose the existing single-click → selectNode behaviour. The threshold + swallow-trailing-click pattern from the pan handler is the safe recipe.
- Hidden streams: a node dragged into a hidden stream's row would disappear. Either skip hidden streams in hit-detection or auto-expand on drop.
- Layout reflow during drag: `applyCanvasMutation` is called on drop only, not during. Hover-cell expansion logic in `08-layout.js:43-46` (the "+ add another" slot reservation) needs the same treatment for drag — reserve a slot in the target cell while `draggingNode.active`.
- Persistence: `serializeLiveStateToCsv` writes nodes in NODES order, so all of this round-trips with no schema change.

**Verify.** Open `index.html`. Add three nodes to one cell. Drag node #3 above node #1 — order updates and persists across refresh. Drag a node to a different stream — node jumps row. Drag to a different stage — node jumps column. Sub-threshold mousedown+release on a node still selects it. Drag past hidden stream row → either skipped or auto-expanded (pick one). Drag aborted by Escape (add to `16e:66-78`).

---

### 3.2 Delete edge from canvas

**Approach.** Promote edge selection from a navigation-only concept (`selectEdge` in `09-graph-selection.js:102`) to a real selection state. `Delete` dispatches on whether a node or edge is selected. Reuse the existing `.edge-path.selected` CSS class which is already wired in CSS at `05-visualization.css:260-262` but currently never applied.

**Files to touch.**

- `assets/js/03-state.js:16` — add `selectedEdgeId: null,`. Document that node and edge selection are mutually exclusive.

- `assets/js/09-graph-selection.js:102-137` — `selectEdge`: set `state.selectedEdgeId = edgeId` in addition to the existing navigation behaviour. Clear it in `deselectNode` (line 87) and `deselectAll` (line 142). In `selectNode` (line 73), also clear `state.selectedEdgeId` at the top.

- `assets/js/11-rendering.js:205` — add the `selected` class to the edge-path's `class` attribute when `edge.id === state.selectedEdgeId`. Pattern:
  ```js
  const classAttr = ' class="edge-path' + (dimmed ? ' dimmed' : '') + (isEdgeFlashed ? ' flashed' : '') + (edge.id === state.selectedEdgeId ? ' selected' : '') + '"';
  ```

- `assets/js/16e-canvas-edit.js:481-503` — `deleteSelection`: at the top, before the node branch, add:
  ```js
  if (state.selectedEdgeId) {
    deleteEdgeById(state.selectedEdgeId);
    state.selectedEdgeId = null;
    return true;
  }
  ```
  `deleteEdgeById` already exists at line 507 and already handles undo + toast.

- `assets/js/15-detail-panel.js` — when an edge is selected (not a node), either keep the existing behaviour (panel shows the from-node in edit mode) or render an edge-focused panel. Recommend: keep current behaviour, just additionally select the edge. Users can press Delete from either focus.

**Risks / tradeoffs.**
- Existing `selectEdge` also navigates to the source node's edit mode and flashes the edge row. That stays — selection is additive.
- `state.selectedEdgeId` is not persisted to localStorage (matches the existing transient `flashedEdgeId`). Fine — selection clears on reload anyway.
- `Backspace` is still bound to delete — same caveat as for nodes (see Tier 2 issue #18). Consider restricting to `Delete` only when reviewing the keyboard handler at `16e:79`.

**Verify.** Draw an edge. Click its body. The edge gets a soft halo (the existing `.edge-path.selected` CSS). Press `Delete` — edge disappears, undo toast appears. Click Undo — edge returns. Clicking another node clears the edge selection.

---

### 3.3 Multi-level undo / redo with `Ctrl+Z` / `Ctrl+Shift+Z`

**Approach.** Snapshot the full CSV string before every mutation. Undo restores by re-feeding the previous snapshot through `loadDataFromCsv()`. Cap the stack at ~50 entries. Add a redo stack that's cleared on any new mutation.

This snapshot-the-CSV approach is the simplest because (a) the CSV is **already serialized on every mutation** (`16f:44`), so we have a known-good representation; (b) `loadDataFromCsv` is the trusted entry point; (c) it gives us undo/redo for *every* mutation (renames, recolors, reorders, edge creates, the new drag-to-move, everything) for free, not just deletes. Cost: ~5–50KB per snapshot for typical maps, plus a brief flash on restore. Both acceptable.

**Files to touch.**

- `assets/js/03-state.js:58` — replace `undoStack: []` with:
  ```js
  history: {
    past: [],     // array of CSV strings (older → newer); current state is NOT here
    future: [],   // array of CSV strings (cleared on every new mutation)
    pending: null // staged before-snapshot; committed by applyCanvasMutation
  },
  ```

- `assets/js/16g-canvas-undo.js` — replace `pushUndo` / `restoreFromUndo` with `historyCapture` / `historyUndo` / `historyRedo`:
  ```js
  const HISTORY_CAP = 50;

  function historyCapture(beforeCsv) {
    state.history.past.push(beforeCsv);
    if (state.history.past.length > HISTORY_CAP) state.history.past.shift();
    state.history.future.length = 0;
  }
  function historyUndo() {
    if (state.history.past.length === 0) return false;
    const beforeCsv = state.history.past.pop();
    const currentCsv = serializeLiveStateToCsv();
    state.history.future.push(currentCsv);
    loadDataFromCsv(beforeCsv);  // existing trusted reload path
    return true;
  }
  function historyRedo() {
    if (state.history.future.length === 0) return false;
    const afterCsv = state.history.future.pop();
    const currentCsv = serializeLiveStateToCsv();
    state.history.past.push(currentCsv);
    loadDataFromCsv(afterCsv);
    return true;
  }
  ```
  Keep `showUndoToast` / `dismissUndoToast` exactly as they are — the toast still serves the "soft" undo for deletes. Toast's Undo button now just calls `historyUndo()` (no closure-captured snapshot needed).

- `assets/js/16f-canvas-mutations.js:36-48` — `applyCanvasMutation`: capture the **previous** state's CSV before re-serializing. The cleanest pattern is to keep the last-serialized CSV on `state.lastCsvSnapshot` so every mutation has a "pre" image without needing each call-site to opt in:
  ```js
  function applyCanvasMutation(options) {
    if (!_suspendUndoCapture && state.lastCsvSnapshot) {
      state.history.past.push(state.lastCsvSnapshot);
      if (state.history.past.length > HISTORY_CAP) state.history.past.shift();
      state.history.future.length = 0;
    }
    rebuildIndexes();
    layout = computeLayout();
    recomputeValues();
    if (!options || !options.skipSidebarRender) renderSidebar();
    render();
    if (!options || !options.skipDetailRender) renderDetailPanel();
    try {
      const afterCsv = serializeLiveStateToCsv();
      state.lastCsvSnapshot = afterCsv;
      saveCsvToStorage(afterCsv);
    } catch (err) { console.warn("Persisting canvas mutation failed:", err); }
  }
  ```
  Seed `state.lastCsvSnapshot` in two places: `06-data-loader.js:276` (after `saveCsvToStorage(csvText)` add `state.lastCsvSnapshot = csvText;`), and `bootEmptyStateGrid` (`16e-canvas-edit.js:88`) after the initial render.

  Set `_suspendUndoCapture = true` while inside `historyUndo` / `historyRedo` so restoration doesn't push its own snapshots, and clear `state.history.past/future` when a brand-new CSV is loaded from outside undo (drop-zone import, "Load sample", wizard "Apply").

  **Back-compat shims:** keep `pushUndo()` as a no-op and `restoreFromUndo()` as `() => historyUndo()` so the existing toast-Undo wiring (`16g:103`) keeps working without rewrites to the delete call sites (`16e:497, 515`, `16f:128, 161, 197`).

- Update all snapshot-pushing sites:
  - `16e-canvas-edit.js:497, 515` — remove `pushUndo(snapshot)`; the auto-capture in `applyCanvasMutation` handles it. Keep the `showUndoToast` calls — toast handler now calls `historyUndo()` instead of `restoreFromUndo(snapshot)`.
  - `16f-canvas-mutations.js:128, 161, 197` — same.
  - `16g-canvas-undo.js` — `restoreFromUndo` can be deleted; or kept as a thin wrapper that calls `historyUndo()`.

- `assets/js/16e-canvas-edit.js:58-82` — add to the keydown handler:
  ```js
  const cmdOrCtrl = event.metaKey || event.ctrlKey;
  if (cmdOrCtrl && event.key === "z" && !event.shiftKey) {
    if (historyUndo()) event.preventDefault();
    return;
  }
  if ((cmdOrCtrl && event.key === "z" && event.shiftKey) ||
      (cmdOrCtrl && event.key === "y")) {
    if (historyRedo()) event.preventDefault();
    return;
  }
  ```
  Keep the input-target guard at line 62 — `Ctrl+Z` should still do native undo inside text fields.

**Risks / tradeoffs.**
- **Focus loss on restore.** `loadDataFromCsv` re-renders everything; the active input loses focus and any partial typing. For typing-heavy edits (renaming a node), the user expects browser-native field-level undo to win inside the field; only commit a history entry on field blur, not on every keystroke. Since `applyNodeFieldEdit` already fires on `change` (blur, not `input`), this is fine out of the box — and the input-target guard at `16e:62` ensures Ctrl+Z inside a textbox goes to the browser, not to our handler.
- **Selection / scroll loss on restore.** Before `loadDataFromCsv`, capture `{ selectedNodeId, selectedEdgeId, editMode, zoomLevel, scrollTop, scrollLeft }`. After the restore renders, re-apply: re-`selectNode` if the id still resolves, restore `state.canvasEdit.editMode`, set `state.zoomLevel`, and write `viz-scroll.scrollTop/Left`. Without this, every undo jumps the user to the empty selection at scroll 0,0 — jarring.
- **Memory.** 50 snapshots × ~20KB = ~1MB worst case for a large map. Acceptable.
- **Coalescing.** Rapid renames (one snapshot per `change` event) inflate the stack. For v1, accept it — the depth cap of 50 contains the damage. Future polish: debounce captures within 500ms when the previous entry's label matches.
- **Toast still useful?** Yes — the 6s "Undo" toast is more discoverable than the keyboard shortcut for non-power users. Keep it for deletes only; its handler now just calls `historyUndo()`.

**Verify.** Make 8 mutations of mixed kinds (add node, rename, draw edge, recolor stream, drag node, delete edge, reorder stage in sidebar, delete node). Press `Ctrl+Z` 8 times — every change reverses in order. Press `Ctrl+Shift+Z` 8 times — every change re-applies. After undo, make a new mutation — redo stack clears. Toast Undo still works for the most recent delete and is equivalent to a single `Ctrl+Z`.

---

## Verification (end-to-end smoke test for any of the above)

Open `index.html` in a browser (no build step). Then:

1. **Drag-to-move + within-cell reorder:** Click an empty cell to add 3 nodes in the same cell. Drag node #3 above #1 — vertical order updates. Drag any node to a different stream — node jumps row. Drag to a different stage — node jumps column. Refresh page — order and positions persist (CSV round-trip via `localStorage`).
2. **Delete edge from canvas:** Drag an edge between two nodes. Click the edge body. Press `Delete` — edge disappears, undo toast appears. Click Undo — edge returns.
3. **Multi-level undo:** Make 5 mutations (add node, rename, draw edge, delete node, recolor stream). Press `Ctrl+Z` five times — every change reverses in order. Press `Ctrl+Shift+Z` to redo.
4. **No regressions:** Existing flows still work — ghost cell click, edge drag-from-handle, effect picker, detail-panel field edits, sidebar add/delete/reorder, pan/zoom, drop-zone CSV import, simulation mode slider.

---

## Critical files (read these before implementing)

- `assets/js/16e-canvas-edit.js` — gesture handlers, drag state, delete entry points
- `assets/js/16f-canvas-mutations.js` — `applyCanvasMutation` chokepoint + sidebar mutations
- `assets/js/16g-canvas-undo.js` — undo snapshots + toast
- `assets/js/08-layout.js` — cell-based positioning; sibling order = NODES array order
- `assets/js/11-rendering.js` — node groups, edge handles, edge hit-paths
- `assets/js/09-graph-selection.js` — `selectNode`, `selectEdge`, `deselectAll`
- `assets/js/15-detail-panel.js` — edit-mode form; `applyNodeFieldEdit` / `applyEdgeFieldEdit` patterns to mirror
- `assets/js/03-state.js` — global state shape; add `selectedEdgeId`, `draggingNode`, expanded undo here
- `assets/js/05a-csv-serializer.js` + `assets/js/06-data-loader.js` — CSV round-trip preserves NODES array order, so within-cell reorder needs no schema change
- `assets/css/05-visualization.css` — node + handle + ghost-cell styling; add drag-state classes here
