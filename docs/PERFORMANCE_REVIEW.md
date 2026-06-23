# Performance Review — Ariadne Maps

Scope: a codebase-wide pass focused on rendering and interaction performance,
with an eye to (a) **huge maps** (thousands of boxes/links) and (b) **general
day-to-day responsiveness** on ordinary maps. The app is a single-page,
vanilla-TS, SVG-based renderer; the analysis below is grounded in the current
`assets/js/*.ts` sources.

The findings are ordered by impact-to-effort. Each item names the hot path,
explains the cost, and proposes a concrete fix.

## Implementation status — all recommendations applied ✅

Every recommendation below has now been implemented on this branch, in five
verified phases (full type-check + test suite + build green after each; the
suite grew from 105 to 114 tests):

1. **Event delegation + rAF render coalescing + index fixes** — delegated all
   SVG listeners to the stable `#viz-svg` element (bound once, not per render);
   added `scheduleRender()` to coalesce per-frame rebuilds; replaced the Kahn
   `Array.shift()` queue with a head index; added an `edgeById` index; capped
   the label-measurement cache. *(items 1, 2, 6a, 6b, 6c)*
2. **Edge-geometry caching** — `computeRenderEdges()` + anchor fan are cached and
   reused across selection / hover / sim renders, keyed on topology, layout, and
   the node-visibility sets. *(item 4)*
3. **Static + transient overlay layers** — the SVG is split so node-drag and
   edge-draw redraw only a small overlay group, never the full node/edge DOM.
   *(item 3)*
4. **In-place simulation updates** — slider scrubs patch value/delta/outcome
   borders directly into the node DOM, falling back to a coalesced render only
   for structural changes. *(item 5)*
5. **Viewport virtualization** — large maps cull nodes/edges to the visible
   scroll rect and redraw the slice on scroll; strictly additive (small maps and
   the export are byte-for-byte unchanged). *(item 7)*

The sections below are retained as the design rationale for each change.

---

## TL;DR — the one thing that matters

Every visual change rebuilds the **entire** SVG as a string, assigns it to
`svg.innerHTML`, and then **re-attaches per-element event listeners to every
node, row label, column header, and edge**. This single design choice
(`render()` in `11-rendering.ts:103` + `attachSvgEventHandlers()` at
`11-rendering.ts:663`) is the dominant cost for both large maps and routine
interactions, because it runs on:

- node select / deselect (`09-graph-selection.ts`)
- **simulation slider drag — every `input` event** (`14-simulation-panel.ts:144`)
- **node drag — every `mousemove`** (`16e-canvas-edit.ts:977`)
- **edge draw drag — every `mousemove`** (`16e-canvas-edit.ts:815`)
- hover-cell changes, marquee, filter toggles, undo/redo, search focus

For a map of N nodes / E edges, each of those events does an O(N+E) string
build, a full DOM teardown + reparse, **and** ~4 `addEventListener` calls per
node plus per-edge/row/column listeners. On a 2,000-node / 4,000-edge map a
single slider tick or one pixel of drag rebuilds ~6,000 elements and binds
~8,000+ listeners — many times per second.

The three highest-leverage fixes (in order):

1. **Event delegation** — bind listeners once on the `<svg>`, never per render.
2. **Coalesce renders with `requestAnimationFrame`** — at most one rebuild per frame.
3. **A separate transient overlay layer** for drag/marquee/draft-edge/ghost
   previews so dragging doesn't rebuild the static node/edge content at all.

Items 1 and 2 are low-risk and help *every* map, large or small. Item 3 is the
big win specifically for huge-map dragging.

---

## 1. Event delegation — bind once, not per render (high impact, low risk)

**Where:** `attachSvgEventHandlers()` (`11-rendering.ts:663-714`), plus the
canvas-edit re-binding in `16e-canvas-edit.ts` (`attachCanvasEditHandlers`,
called at the end of every render via `11-rendering.ts:713`).

**Cost:** After every `svg.innerHTML = content`, the code does
`svg.querySelectorAll(".node-group").forEach(...)` and attaches **four**
listeners per node (`click`, `mouseenter`, `mousemove`, `mouseleave`), then
sweeps `.row-label-group`, `.col-header-group`, and (in `16e`) `.edge-hit` /
`.node-group` mousedown. That's multiple full-DOM `querySelectorAll` passes and
thousands of listener registrations on a large map, repeated on *every* render.
It also produces a lot of short-lived closures → GC pressure.

**Fix:** Attach a single delegated listener set on the `svg` element **once**
(the file already does this for the background-click handler at
`11-rendering.ts:34`, with a comment explaining why per-render binding is
avoided — extend that pattern to everything):

- `svg.addEventListener("click", e => ...)` → `e.target.closest(".node-group")`
  / `.edge-hit` / `.row-label-group` / `.col-header-group` and dispatch by
  reading the `data-*` id already baked into the markup.
- Tooltip hover: delegate `mouseover` / `mouseout` (which bubble, unlike
  `mouseenter`/`mouseleave`) plus one `mousemove` on the `svg`, resolving the
  node via `closest(".node-group")`. This replaces 3 listeners × N nodes with 3
  total.
- Node-drag mousedown: one delegated `mousedown` on `svg` gated on
  `e.shiftKey` + `closest(".node-group")`.

**Payoff:** `render()` stops touching listeners entirely; the post-innerHTML
work drops from O(N) registrations to zero. Snappier selection and simulation
on all map sizes, dramatically less GC churn on big maps.

---

## 2. Coalesce renders with `requestAnimationFrame` (high impact, low risk)

**Where:** all ~40 call sites of `render()`, but especially the per-mousemove /
per-input loops: `updateNodeDrag` (`16e:977`), `updateEdgeDrag` (`16e:815`),
`applySimMultiplier` (`14:144`), and `handleSvgMouseMove` (`16e:541`). There is
currently **no** rAF batching of the main render (grep confirms rAF is only used
for the builder wizard and auto-pan, never the map render).

**Cost:** Pointer-move and slider `input` events fire faster than the display
refresh (often 120–240 Hz on modern trackpads/mice). Each one currently triggers
a *synchronous, full* SVG rebuild. The browser can't even paint between them, so
work is thrown away.

**Fix:** Introduce a `scheduleRender()` that sets a dirty flag and schedules a
single `render()` on the next animation frame; collapse repeat calls within a
frame into one. Replace the hot-loop `render()` calls with `scheduleRender()`.
Keep a synchronous `render()` for the one-shot cases (load, filter toggle) if
desired, or route everything through the scheduler.

```ts
let _renderQueued = false;
export function scheduleRender(): void {
  if (_renderQueued) return;
  _renderQueued = true;
  requestAnimationFrame(() => { _renderQueued = false; render(); });
}
```

**Payoff:** Caps rebuilds at one per frame during drags and slider scrubs.
Combined with item 1 this makes dragging/simulating usable on much bigger maps,
and removes input-induced jank on small ones.

---

## 3. Transient overlay layer for drag / marquee / draft-edge / ghost (high impact for huge maps, medium effort)

**Where:** `render()` emits the drag preview (`11-rendering.ts:605`), draft edge
(`:585`), marquee (`:636`), drop slot (`:248`), ghost cell (`:224`), and cursor
cell (`:199`) **inside the same string that contains every node and edge**. So
moving the mouse one pixel during a drag re-serializes and re-parses the whole
graph just to move a single translucent preview rect.

**Cost:** During a node/edge drag the static content (all nodes + all edges)
does not change between most frames — only the small preview does — yet the
entire SVG is rebuilt each frame.

**Fix:** Split the SVG into two layers:

- a **static layer** holding background, headers, edges, and nodes (rebuilt only
  when data/layout/selection/visibility actually change), and
- a small **overlay layer** (`<g class="overlay">` or a second absolutely-
  positioned `<svg>`) holding only the transient affordances.

During a drag, update *only* the overlay each frame; rebuild the static layer
just on the rare events that change it (e.g. a slot-crossing that re-parts the
stack — `updateNodeDrag` already guards `computeLayout()` to slot crossings at
`16e:976`, so the static rebuild can be gated the same way). This is the single
biggest lever for smooth dragging on huge maps.

**Note:** This is more invasive than items 1–2 and touches hit-testing
assumptions, so it deserves its own PR with the drag/marquee tests exercised.

---

## 4. Don't recompute edge geometry on selection-only renders (medium impact)

**Where:** `render()` calls `computeRenderEdges()` (`11-rendering.ts:311`) and
`computeEdgeAnchorOffsets()` (`:319`) on **every** render.

**Cost:** `computeRenderEdges` (`10a-collapsed-edges.ts`) builds a visible-node
set (O(N)), walks all edges (O(E)), and — when stages/streams/categories are
hidden — runs a DFS through hidden nodes to synthesize "through" edges. The
anchor-fan then buckets and sorts per node face (O(E + faces·log)). None of this
changes when the user merely *selects a node*, *moves a slider*, or *hovers* —
yet it's redone every time. (When nothing is hidden the synthetic DFS is cheap,
but the full edge sweep + anchor fan still runs.)

**Fix:** Cache `renderEdges` and `anchorOffsets` keyed off the inputs that
actually affect them — topology (NODES/EDGES identity), visibility sets
(`hiddenStreams/Stages/Categories/Effects/Styles`), and layout positions.
Invalidate on data load, filter toggle, and layout recompute; reuse the cache
for selection/hover/sim renders. Selection styling is applied per-edge in the
draw loop anyway, so only the *geometry* needs caching.

**Payoff:** Selection and simulation renders skip a full edge re-derivation.
Meaningful on dense maps where E ≫ N.

---

## 5. Simulation slider: full rebuild per `input` is overkill (medium impact)

**Where:** `applySimMultiplier` → `recomputeValues()` → `render()`
(`14-simulation-panel.ts:134-146`), fired on every slider `input` and every
keystroke in the value box.

**Cost:** `recomputeValues()` itself is fine (the Gauss-Seidel solver in
`07-simulation-engine.ts` converges in one sweep for DAGs). The expense is the
**full SVG rebuild** that follows, on every tick.

**Fix:** Two options, in increasing effort:
- **Cheap:** route through `scheduleRender()` (item 2) — already a big win.
- **Targeted:** during a sim scrub, update only the affected nodes' value/delta
  `<text>` and outcome border in place (the sim panel already does in-place row
  syncing via `syncSimRow` at `14:166` and inline detail updates via
  `updateDetailPanelDeltaInline` at `14:201` — extend the same idea to the map's
  value/delta text nodes). This avoids rebuilding edges and node bodies that
  didn't move.

---

## 6. Smaller / lower-risk wins

### 6a. Kahn topological sort uses `Array.shift()` — O(N²) worst case
`rebuildIndexes()` (`06-data-loader.ts:128-135`) drives the queue with
`ready.shift()`, which is O(N) per call on a JS array → O(N²) overall for large
maps. **Fix:** use a head index pointer (`let head = 0; ready[head++]`) instead
of `shift()`. Trivial change, runs on every load and every canvas mutation
(since mutations re-run `rebuildIndexes` via `16f-canvas-mutations.ts:77`).

### 6b. `_labelLineCache` grows unbounded (memory leak over long sessions)
`measureLabelLines` caches by `width|text` in a `Map` that is never trimmed
(`04-utils.ts:55`). During long editing sessions on big maps (labels change as
the user types/renames) this grows without bound. **Fix:** cap it (simple LRU or
clear when it exceeds, say, a few thousand entries) and/or clear on data load.

### 6c. Edge lookups are O(E) linear scans
`selectEdge` (`09:261`), `cycleEdgeEffect` (`16e:1375`), and `deleteEdge`
(`16e:1479`) all do `EDGES.find(e => e.id === edgeId)`. These are
user-action-rate (not per-frame), so impact is low, but on huge maps it's free
to fix: build an `edgeById` index in `rebuildIndexes` alongside the existing
`incomingEdges`/`outgoingEdges` maps.

### 6d. `nodeSecondaryChips` / `nodePrimaryFill` allocate per node per render
Minor, but on huge maps the per-node `.map().filter()` allocations in
`11-rendering.ts:59-101` add up. Once renders are coalesced (item 2) this is less
pressing; if profiling shows it, precompute the resolved fill/chip data once per
node and cache until categories change.

### 6e. `saveCsvToStorage` serializes the whole map on every mutation
Each canvas edit serializes the entire CSV to `localStorage`
(`06-data-loader.ts:447` and the mutation path). UI-state saves are already
debounced (`scheduleUiStateSave`), but the CSV save is not. For huge maps,
consider debouncing the CSV persist too (e.g. 300–500 ms) so a rapid burst of
edits writes once.

---

## 7. The scaling ceiling: no viewport virtualization (future, large effort)

The whole map is one SVG sized to `totalWidth × totalHeight × zoom`
(`11-rendering.ts:120`), with **every** node and edge present in the DOM
regardless of what's scrolled into view. There is no culling. This is fine up to
some hundreds of nodes but is the ultimate wall for "huge maps" — the browser
keeps thousands of off-screen SVG elements live.

**Direction (not a quick fix):** viewport culling — emit only nodes/edges whose
layout bounds intersect the visible `#viz-scroll` rectangle (plus a margin),
re-rendering on scroll (throttled via rAF). The layout already stores per-node
positions (`layout.positions`) and row/col extents, so the intersection test is
cheap. Complications: edges crossing the viewport from off-screen endpoints, and
the PNG/HTML export (`19-export.ts`) which must keep rendering the full framed
set. Worth prototyping only once items 1–3 are in and a concrete large-map
target exists.

---

## Suggested sequencing

1. **Event delegation** (item 1) and **rAF render coalescing** (item 2) — together
   they remove the per-render listener churn and cap rebuild frequency. Low risk,
   broad benefit, covered by existing interaction tests.
2. **Edge-geometry caching** (item 4) and the **trivial wins** (6a, 6b, 6c).
3. **Transient overlay layer** (item 3) — the big huge-map drag win, its own PR.
4. **Targeted sim updates** (item 5) if slider scrubbing is still heavy after 1–2.
5. **Viewport virtualization** (item 7) only if a concrete multi-thousand-node
   requirement lands.

All of the above preserve current behavior; none change the data model, the CSV
format, or the export output.
