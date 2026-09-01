// =============================================================================
// PATHWAY ATLAS — THE PICTURE
// -----------------------------------------------------------------------------
// Everything downstream of one box, drawn as one thing you zoom into.
//
// Every element is a circle whose AREA is the share of readings running through
// it; left to right is how far along a pathway you are — the only thing on
// screen saying which way round the story goes. A knot of feedback is a circle
// already, so it is drawn as the wheel it contains: its boxes round the rim,
// its loops as chords across the middle. Opening one is a zoom, not a link to
// somewhere else: the picture stays put and the frame closes in.
//
// Nothing is named until you point at it. A hundred names at once is fog.
//
// What it does NOT own: the header, the drawer, or the right-hand panel. The
// panel is the app's, and the atlas fills it through atlasPanelHtml() — so
// there is one inspector in the app rather than two.
// =============================================================================

import { EDGES, NODES, nodeById, outgoingEdges, state } from "./03-state";
import { escapeHtml, formatScalar } from "./04-utils";
import {
  EFFECT_FLOOR_PCT,
  formatNodeDelta,
  maxEffectPct,
  nodeEffect,
  explainNode,
  gatedBy,
  resolveEdgeElasticity,
} from "./07-simulation-engine";
import { getDescendants, scrollNodeIntoView, selectNode } from "./09-graph-selection";
import { hideTooltip } from "./12-tooltip";
import { renderDetailPanel } from "./15-detail-panel";
import {
  END,
  buildAtlas,
  buildGraph,
  canonicalCycle,
  formatCount,
  measure,
  strands,
  wheelOf,
} from "./20-atlas-engine";

// ───── What is open ───────────────────────────────────────────────────────
// GRAPH is the whole map as the engine wants it; ATLAS is everything downstream
// of START. Both are rebuilt only when the map or the start box changes — the
// picture is redrawn far more often than it is recomputed.
let GRAPH: any = null;
let ATLAS: any = null;
let START: string | null = null;

const WHEELS = new Map<any, any>();   // one wheel layout per tangle, built when first drawn
let WHEEL_PICK: any = null;           // the box being explained inside a tangle
let WHEEL_LOOP = 0;                   // which of its loops, when it has several
let WHEEL_TANGLE: any = null;         // the tangle that box belongs to
// Whether the current pick came from the wheel or from a row in the list. Only
// a pick made on the wheel means "show me the loops through this box".
let PICK_FROM_WHEEL = false;
let traceRAF = 0;
const CARD_MAX = 12;                  // loop diagrams listed in the panel

// ───── One strand at a time ───────────────────────────────────────────────
// A strand is a single reading — the left edge of the picture to the right —
// which is the thing every percentage here is a share OF. drawn() is the one
// being read; the list is worked out on demand and cached, because the panel
// re-renders on every repaint and the walk should not.
const STRAND_MAX = 60;                // strands listed; the walk stops there too
// Characters a pathway's "via" label may spend on box names, shared out between
// however many hops it takes to tell that pathway from its siblings.
const CHAIN_BUDGET = 36;
// Every route the picked ROW stands for, not just one of them. A row reading
// "via Vehicle Document Check ×4" is four routes that leave the same way, and
// its percentage is what all four carried between them — but picking it used to
// light only the first, so the number in the panel and the run on the picture
// were about different things. The row is the unit the reader chose; it is the
// unit that gets lit.
let STRAND_CACHE: any = null;

// ───── One reading ────────────────────────────────────────────────────────
// What is being looked at, in one record, with one way to change it.
//
// There used to be six variables answering that question — a picked circle, a
// chain of chosen forks, the pathways drawn, the element traced back to the
// sliders, the tangle being looked inside, and the fork being pointed at — and
// they took turns interrupting one another through rules written out by hand at
// two dozen separate sites. Two of this file's bugs came straight out of that:
// a tree that compared false against itself, and an inspector nailed to zero
// pixels while the picture it belonged to was on screen.
//
// What is DRAWN is no longer one of them. It is worked out from this record
// every time it is needed (see `drawn()`), so it cannot drift from it — which
// is the drift the old drawn() variable kept having.
interface Reading {
  roots: any[];             // circles clicked on the picture, in the order clicked
  open: any[][];            // row-paths the reader has opened, each destination-first
  current: any[];           // the row last taken hold of: what is drawn, and marked
  lanes: LanePick[];        // a box picked out from under a folded row
  trace: any | null;        // an element traced back to the sliders that moved it
  traceKey: string | null;  // which control asked for that trace, so it can be un-asked
  inside: any | null;       // the tangle being looked inside
}

// Which of the boxes a folded row stands for the reader has picked out, per row.
// Per row rather than one at a time, for the same reason rows open independently:
// picking Cannabis under ◇ Seizure says nothing about ◇ Targets three rows down,
// and moving that row's forks about would be answering a question nobody asked.
interface LanePick { path: any[]; value: string }

const R: Reading = { roots: [], open: [], current: [], lanes: [], trace: null, traceKey: null, inside: null };

// Pointed at, not chosen. Deliberately NOT part of the reading: it changes what
// is drawn and nothing else, and it is gone the moment the pointer moves on.
let POINTED: Fork | null = null;

// ── Everything below here is WORKED OUT from the reading, never stored ────

// The pathways the picture is drawing. Pointing wins over choosing, because
// pointing is what the reader is doing right now; a circle picked with nothing
// narrowed under it draws everything running through it, which is exactly what
// pointing at it showed — so the click leaves what the pointer promised.
function drawn(): any[][] | null {
  // Empty is NONE, not "some". An empty array is truthy, and returning one told
  // every caller downstream that there were pathways to draw — dimming the
  // whole picture in favour of nothing.
  const some = (list: any[][] | null | undefined) => (list && list.length ? list : null);
  if (POINTED) return some(POINTED.paths);
  const chain = openChain();
  if (chain.length) return some(chain[chain.length - 1].paths);
  if (R.roots.length && !R.trace && WORLD) return some(pathsThrough(R.roots));
  return null;
}

// The element a trace runs back from. Either one asked for by name — a box row
// in the movers list — or the destination chosen in the pathway list, because a
// destination and the routes reaching it are the same set of circles, and
// holding it is what lets each ribbon carry its own share of the change rather
// than a plain in-or-out.
function traceEl(): any {
  if (R.trace) return R.trace;
  const chain = openChain();
  return chain.length === 1 ? chain[0].via : null;
}

let TRACE_OF: any = null;
let TRACE_CACHE: { els: Set<any>; links: Set<any> } | null = null;

function trace(): { els: Set<any>; links: Set<any> } | null {
  const el = traceEl();
  if (el === null || el === undefined) return null;
  if (TRACE_OF !== el) { TRACE_OF = el; TRACE_CACHE = traceTo(el); }
  return TRACE_CACHE;
}

// ───── Small helpers the picture leans on ─────────────────────────────────
const plural = (n: number, one: string, many?: string): string => (n === 1 ? one : many || one + "s");
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const pct = (f: number): string =>
  (f >= 0.1 ? (f * 100).toFixed(0) : f >= 0.001 ? (f * 100).toFixed(1) : "<0.1") + "%";
const labelOf = (id: any): string => (ATLAS && ATLAS.nodes.get(id) ? ATLAS.nodes.get(id).label : String(id));
const boxLabel = (id: any): string => (nodeById[id] ? nodeById[id].label : String(id));
const stageEl = (): HTMLElement | null => document.getElementById("atlas-stage");

// The right panel is the inspector, so "re-render the inspector" is "re-render
// the panel". The tour calls this once per loop, not once per frame.
//
// The panel is rebuilt by replacing its innerHTML, which throws away the scroll
// position of everything inside it. That is invisible while the panel is short
// and intolerable once it isn't: picking a mover forty rows down the pathway
// list answered the question and then threw you back to the top, so reading the
// list meant scrolling to the same place again after every single click. So the
// scroll offsets are lifted out, the panel is rebuilt, and they are put back.
//
// Keyed by what a container IS rather than by its position, because a rebuild
// can legitimately add or drop sections — a key that shifted with the section
// order would restore one list's offset onto another.
const SCROLLERS = ".strands, .mvrows, .loopcards";

function scrollKey(el: Element): string {
  if (el.classList.contains("mvrows")) return "mv:" + ((el as HTMLElement).dataset.section || "");
  return el.classList.contains("strands") ? "strands" : "loops";
}

export function takeScroll(root: HTMLElement | null): Map<string, number> {
  const out = new Map<string, number>();
  if (!root) return out;
  if (root.scrollTop) out.set("", root.scrollTop);
  for (const el of root.querySelectorAll(SCROLLERS)) {
    if (el.scrollTop) out.set(scrollKey(el), el.scrollTop);
  }
  return out;
}

export function putScroll(root: HTMLElement | null, saved: Map<string, number>): void {
  if (!root || !saved.size) return;
  const top = saved.get("");
  if (top) root.scrollTop = top;
  for (const el of root.querySelectorAll(SCROLLERS)) {
    const was = saved.get(scrollKey(el));
    // Assigning clamps to the new content height by itself, so a list that got
    // shorter comes back at its end rather than out of bounds.
    if (was) el.scrollTop = was;
  }
}

// renderDetailPanel does the save/restore itself, around the innerHTML write
// that loses the offsets — so every route into the panel is covered, including
// the ones that do not come through here (a slider scrub reaches it directly).
function renderInspector(): void {
  if (typeof renderDetailPanel === "function") renderDetailPanel();
}

// ───── Opening and closing ────────────────────────────────────────────────
// The atlas reads the WHOLE map, filters and all: hiding a row changes what you
// are looking at, not what is true, and a count that quietly dropped half the
// map would be worse than no count.
export function atlasIsOpen(): boolean {
  return !!(state.atlas && state.atlas.startId);
}

export function openAtlas(startId: string): void {
  if (!nodeById[startId]) return;
  state.atlas = { startId };
  START = startId;
  GRAPH = buildGraph({
    name: "map",
    nodes: NODES.map(n => ({ id: n.id, label: n.label, direction: n.direction || "" })),
    // The engine reads only the sign and the size of a link. resolveEdgeElasticity
    // is what the simulation uses too, so "decreases" is negative in both.
    edges: EDGES.map(e => ({ from: e.from, to: e.to, id: e.id, effect: e.effect,
                             elasticity: resolveEdgeElasticity(e) })),
  });
  ATLAS = buildAtlas(GRAPH, startId, { grouping: "loose", lanes: { minMembers: 3, minTokenFamilies: 2 } });
  WHEELS.clear();
  PAIR_GAIN.clear();
  PATHS_THROUGH.clear();
  WHEEL_PICK = null; WHEEL_LOOP = 0; WHEEL_TANGLE = null; PICK_FROM_WHEEL = false;
  MOVES_OPEN = {};
  R.roots = []; R.open = []; R.current = []; R.lanes = [];
  R.trace = null; R.traceKey = null; R.inside = null;
  POINTED = null; TRACE_OF = null; TRACE_CACHE = null;
  STRAND_CACHE = null; VB = null; WORLD = null;
  stopTour();
  document.body.classList.add("atlas-open");
  syncAtlasButton();
  renderAtlas();
}

export function closeAtlas(): void {
  if (!state.atlas) return;
  stopTour();
  cancelAnimationFrame(traceRAF);
  state.atlas = null;
  START = null; ATLAS = null; GRAPH = null; WORLD = null; VB = null;
  R.inside = null; R.roots = []; R.open = []; R.current = []; R.lanes = []; POINTED = null;
  WHEELS.clear();
  document.body.classList.remove("atlas-open");
  const stage = stageEl();
  if (stage) { stage.innerHTML = ""; stage.hidden = true; }
  syncAtlasButton();
  renderDetailPanel();
}

// ───── The ways in ────────────────────────────────────────────────────────
// Three doors, one room, and three because they answer different questions.
// The header button says the atlas EXISTS — you meet the name before you have
// any reason to want it, which is the only way a name is any use later. The
// card in the box panel is where the question actually occurs ("what does this
// feed?"), and that is after you have clicked a box. Double-click is for the
// fifth time, once you know both.
//
// All three are wired here rather than in the header / map / panel modules,
// so the ways into the atlas can be counted by reading one file.
//
// The atlas is a reading tool, so every door is shut while editing — the
// header control is .read-only, the panel card is drawn in reading only, and
// the double-click checks the mode below. Nothing switches your mode for you
// as a side effect of a click.

const PICK_MAX = 6;   // boxes offered when nothing is selected

// How much of the map lies downstream of a box. NODES.length as the depth is
// an unbounded walk said in a way that cannot run away: no simple path can be
// longer than the map has boxes.
function atlasReach(id: string): number {
  return getDescendants(id, NODES.length).size;
}

// The boxes worth starting from: the ones the most of the map hangs off. A box
// with nothing downstream is not offered — its atlas would be one circle.
export function atlasStartCandidates(): { id: string; label: string; reach: number }[] {
  return NODES
    .map(n => ({ id: n.id, label: n.label, reach: atlasReach(n.id) }))
    .filter(c => c.reach > 0)
    .sort((a, b) => b.reach - a.reach || a.label.localeCompare(b.label))
    .slice(0, PICK_MAX);
}

const atlasButtonEl = (): HTMLElement | null => document.getElementById("atlas-button");
const atlasMenuEl = (): HTMLElement | null => document.getElementById("atlas-menu");

// While the picture is open the button is the way back out of it — the same
// bargain Simulate makes with the mode it turns on.
export function syncAtlasButton(): void {
  const button = atlasButtonEl();
  if (!button) return;
  const open = atlasIsOpen();
  button.innerHTML = (open ? "Change starting box" : "Atlas") +
    '<span class="header-caret" aria-hidden="true">▾</span>';
  button.classList.toggle("active", open);
  button.setAttribute("data-tooltip", open
    ? "Choose a different box to start the atlas from."
    : "Every pathway out of one box, as one picture you zoom into.");
}

export function setAtlasMenuOpen(open: boolean): void {
  const menu = atlasMenuEl(), button = atlasButtonEl();
  if (!menu || !button) return;
  const show = !!open && state.dataLoaded;
  // The button's own hover tooltip would sit on top of the list it just
  // opened, so it gets out of the way.
  if (show && typeof hideTooltip === "function") hideTooltip();
  if (show) menu.innerHTML = atlasMenuHtml();
  menu.hidden = !show;
  button.classList.toggle("active", show || atlasIsOpen());
  button.setAttribute("aria-expanded", show ? "true" : "false");
}

function atlasMenuHtml(): string {
  const picks = atlasStartCandidates();
  if (!picks.length) {
    return '<div class="menu-foot">Nothing on this map has anything downstream of it yet.</div>';
  }
  // The column of figures is labelled once at the head rather than carrying
  // the word "boxes" six times down the list.
  return '<div class="menu-head"><span>Start the atlas from</span>' +
    '<span>Boxes downstream</span></div>' +
    picks.map(p =>
      '<button class="menu-item menu-item--pick" role="menuitem" data-atlas-start="' +
      escapeHtml(p.id) + '"><span class="pick-name">' + escapeHtml(p.label) +
      '</span><span class="pick-reach">' + p.reach + '</span></button>').join("") +
    '<div class="menu-foot">…or click any box on the map, then Atlas.</div>';
}

// The header button. With a box selected it goes straight in; with nothing
// selected it offers the boxes worth starting from. It is never disabled: a
// greyed control is a control people stop seeing, and being seen is this
// one's entire job.
let ENTRY_WIRED = false;

export function initAtlasEntry(): void {
  if (ENTRY_WIRED) return;
  ENTRY_WIRED = true;

  const button = atlasButtonEl();
  if (button) {
    button.addEventListener("click", event => {
      event.stopPropagation();
      if (!state.dataLoaded) return;
      if (atlasIsOpen()) {
        const menu = atlasMenuEl();
        setAtlasMenuOpen(!menu || menu.hidden);
        return;
      }
      const selected = state.selectedNodeId;
      if (selected && nodeById[selected] && outgoingEdges[selected] && outgoingEdges[selected].length) {
        setAtlasMenuOpen(false);
        openAtlas(selected);
        return;
      }
      const menu = atlasMenuEl();
      setAtlasMenuOpen(!menu || menu.hidden);
    });
  }

  // Picking a start from the list, and closing the list on anything else.
  document.addEventListener("click", event => {
    const menu = atlasMenuEl();
    if (!menu || menu.hidden) return;
    const target = event.target as HTMLElement | null;
    if (target && target.closest && target.closest("#atlas-button")) return;
    const pick = target && target.closest ? target.closest("[data-atlas-start]") as HTMLElement | null : null;
    setAtlasMenuOpen(false);
    if (pick && pick.dataset.atlasStart) openAtlas(pick.dataset.atlasStart);
  });

  document.addEventListener("keydown", event => {
    const menu = atlasMenuEl();
    if (event.key === "Escape" && menu && !menu.hidden) {
      setAtlasMenuOpen(false);
      event.stopPropagation();
    }
  }, true);

  // Double-click a box on the map. The accelerator, not the way in — nothing
  // announces it, so it is only ever a shortcut for someone who already knows
  // what it is a shortcut TO. Reading mode only: in edit, a double-click on a
  // box belongs to the box.
  const vizSvg = document.getElementById("viz-svg");
  if (vizSvg && !vizSvg.dataset.atlasWired) {
    vizSvg.dataset.atlasWired = "1";
    vizSvg.addEventListener("dblclick", event => {
      if (state.uiMode === "edit" || !state.dataLoaded) return;
      const target = event.target as Element;
      if (!target || !target.closest) return;
      const group = target.closest(".node-group") as HTMLElement | null;
      if (!group) return;
      const id = group.getAttribute("data-node-id");
      // Same bar the panel card sets itself: a box with nothing downstream
      // would open a picture of one circle.
      if (!id || !outgoingEdges[id] || !outgoingEdges[id].length) return;
      event.preventDefault();
      event.stopPropagation();
      openAtlas(id);
    });
  }

  syncAtlasButton();
}

const atlasExitButton = document.getElementById("atlas-exit-button");
if (atlasExitButton) {
  atlasExitButton.addEventListener("click", () => {
    if (atlasIsOpen()) closeAtlas();
  });
}

// Draw (or redraw) the whole picture, then frame it and play whatever the
// current state says should be playing.
export function renderAtlas(): void {
  const stage = stageEl();
  if (!stage || !ATLAS) return;
  stage.hidden = false;
  stage.innerHTML = viewAtlas(ATLAS, measure(ATLAS));
  if (!WORLD) return;
  VB = R.inside && WORLD.at.has(R.inside) ? frameOn(R.inside) : wholePicture();
  setScale();
  paintAtlas();
  revealAtlas();
  if (R.inside) playTour();
}

// The picture draws itself in, column by column, so the first thing a reader
// sees is the shape arriving rather than a wall of circles already there.
function revealAtlas(): void {
  const svg = svgEl();
  if (!svg || reduced()) return;
  for (const g of svg.querySelectorAll("g.n")) {
    const at = WORLD.at.get((g as HTMLElement).dataset.el) || [0];
    (g as HTMLElement).style.animationDelay = Math.min(700, (at[0] / WORLD.W) * 620).toFixed(0) + "ms";
  }
  svg.classList.add("reveal");
  setTimeout(() => svg.classList.remove("reveal"), REVEAL + 800);
}

const WORLD_H = 900;          // the picture's own coordinate space
const MAX_R = 62;             // radius of the busiest element
const TOUR_MAX = 14;          // loops played through on entering a tangle
const REVEAL = 900;           // how long the picture takes to draw itself in

let WORLD: any = null;             // where everything is, in world coordinates
let VB: any = null;                // the frame we are looking through
let vbRAF = 0, tourRAF = 0, tourAt = -1;

const reduced = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function wheelFor(id: any, t: any) {
  if (!WHEELS.has(id)) WHEELS.set(id, wheelOf(t));
  return WHEELS.get(id);
}

// A chord bowed toward the middle, so two links between distant boxes do not
// lie on top of each other.
const chordPath = (x1: any, y1: any, x2: any, y2: any, cx: any, cy: any, pull: any) =>
  `M${x1.toFixed(1)} ${y1.toFixed(1)}Q${(cx + (x1 + x2 - 2 * cx) * pull).toFixed(1)} ${
    (cy + (y1 + y2 - 2 * cy) * pull).toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`;

function viewAtlas(A: any, M: any) {
  const cols: any[] = [];
  for (const [id] of A.nodes) {
    if (id === END) continue;
    const d = M.depth.get(id);
    if (d === undefined) continue;
    (cols[d] || (cols[d] = [])).push(id);
  }
  const used = cols.filter(Boolean);
  if (!used.length) return `<p class="busy">Nothing to draw.</p>`;

  const H = WORLD_H, PAD = 40;
  const COL_W = Math.max(56, Math.min(300, 1900 / Math.max(1, used.length)));
  const W = PAD * 2 + (used.length - 1) * COL_W;

  // Area is the measure, so the radius is its square root. One scale for the
  // whole picture, set by whichever column is fullest — otherwise two circles
  // of the same size in different columns would mean different things.
  const sq = (id: any) => Math.sqrt(Math.max(M.weight(id), 0.000012));
  let k = Infinity;
  for (const col of used) {
    const sum = col.reduce((a: any, id: any) => a + sq(id), 0);
    k = Math.min(k, (H - 2 * PAD - 5 * (col.length - 1)) / (2 * sum));
  }
  k = Math.min(k, MAX_R / Math.max(...used.flat().map(sq)));
  const rOf = new Map<any, any>(used.flat().map(id => [id, Math.max(2.4, k * sq(id))]));

  const y = new Map<any, any>();
  const place = () => {
    for (const col of used) {
      const need = col.reduce((a: any, id: any) => a + 2 * rOf.get(id), 0);
      const room = H - 2 * PAD - need;
      // Spread a column across the frame rather than huddling it in the middle —
      // the empty half of the picture was telling the reader nothing.
      const gap = Math.max(4, Math.min(78, room / Math.max(1, col.length - 1)));
      let cur = PAD + Math.max(0, (room - gap * (col.length - 1)) / 2);
      for (const id of col) { y.set(id, cur + rOf.get(id)); cur += 2 * rOf.get(id) + gap; }
    }
  };
  place();
  const bary = (id: any) => {
    const ps = [...A.pred.get(id)].filter(q => y.has(q));
    return ps.length ? ps.reduce((a, q) => a + y.get(q), 0) / ps.length : y.get(id) || 0;
  };
  for (let pass = 0; pass < 2; pass++) {
    for (let c = 1; c < used.length; c++) used[c].sort((a: any, b: any) => bary(a) - bary(b));
    place();
  }
  const at = new Map<any, any>(used.flat().map(id => [id, [PAD + M.depth.get(id) * COL_W, y.get(id)]]));
  // What is actually drawn, edges of the circles included. Fitting to the
  // nominal width instead clipped whichever element was fat enough to hang past
  // it — usually the start box, the last one you want cut off.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [id, p] of at) {
    const r = rOf.get(id);
    minX = Math.min(minX, p[0] - r); maxX = Math.max(maxX, p[0] + r);
    minY = Math.min(minY, p[1] - r); maxY = Math.max(maxY, p[1] + r);
  }
  const bounds = { x: minX - 12, y: minY - 22, w: (maxX - minX) + 24, h: (maxY - minY) + 44 };
  WORLD = { W, H, at, rOf, A, M, bounds };

  const parts: any[] = [];
  for (const [a, outs] of A.succ) {
    if (a === END || !at.has(a)) continue;
    for (const b of outs) {
      if (b === END || !at.has(b)) continue;
      const [ax, ay] = at.get(a), [bx, by] = at.get(b);
      const x1 = ax + rOf.get(a), x2 = bx - rOf.get(b), mx = (x1 + x2) / 2;
      // A line as wide as the circles it joins stops being a line. Thick enough
      // to compare, never thick enough to become the picture.
      const t = Math.max(0.7, Math.min(24, 0.85 * Math.min(rOf.get(a), rOf.get(b)),
        M.linkWeight(a, b) * H * 0.5));
      // data-w is the STRUCTURAL width — the share of readings — kept on the
      // path so the effect-flow mode can borrow the channel and hand it back.
      parts.push(`<path class="fl" data-a="${escapeHtml(a)}" data-b="${escapeHtml(b)}" data-w="${
        t.toFixed(2)}" stroke-width="${t.toFixed(2)}"
        d="M${x1.toFixed(1)} ${ay.toFixed(1)}C${mx.toFixed(1)} ${ay.toFixed(1)} ${
        mx.toFixed(1)} ${by.toFixed(1)} ${x2.toFixed(1)} ${by.toFixed(1)}"></path>`);
    }
  }
  for (const id of used.flat()) {
    const node = A.nodes.get(id), r = rOf.get(id), [cx, cy] = at.get(id);
    const cls = "bub" + (id === A.start ? " start" : node.loop ? " loop" : "");
    parts.push(`<g class="n${node.loop ? " tangle" : ""}" data-el="${escapeHtml(id)}"${
        node.loop ? ' data-loop="1"' : ""} tabindex="0" role="button"
        aria-label="${escapeHtml(node.label)}, ${pct(M.weight(id))} of everything${
          node.loop ? ". Feedback — opens as a wheel" : ""}">` +
      `<circle class="${cls}" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}"></circle>` +
      // The gate. A bar drawn across the way IN — the side the effect arrives
      // from — so it reads as the flow meeting something rather than as a badge
      // stuck on the circle. Hidden unless the box is actually held; see .held
      // in the stylesheet.
      `<line class="gate" x1="${(cx - r - 5).toFixed(1)}" y1="${(cy - Math.max(7, r * 0.55)).toFixed(1)}"
        x2="${(cx - r - 5).toFixed(1)}" y2="${(cy + Math.max(7, r * 0.55)).toFixed(1)}"></line>` +
      (node.loop ? tangleWheel(node, cx, cy, r) : "") +
      `<text x="${cx.toFixed(1)}" y="${(cy + r + 15).toFixed(1)}" text-anchor="middle">${
        node.loop ? "↻ " : ""}${escapeHtml(clip(node.label, 30))}${
        node.boxes.length > 1 && !node.loop ? " ×" + node.boxes.length : ""}` +
      // The move goes in the LABEL, not on the disc. A tangle's disc already
      // has its wheel drawn inside it, and the smallest circles here are a few
      // pixels across — so there is no room in the middle that is room on every
      // circle. In the label it appears under exactly the rule the label
      // appears under: lit, or pointed at. Reading a lit run then gives the
      // name and the size of the move at every step along it.
      //
      // On its OWN LINE, though. Beside the name it sat at the right-hand end
      // of the widest thing on screen, which on a lit run through neighbouring
      // circles is precisely where the next label starts — so the first thing
      // to be painted over was the number. Under the name each label is half
      // as wide and the figures line up down the run. The offset is in `em`,
      // so it tracks the font size, which is itself calc(12px / --z): the two
      // lines stay one line apart at every zoom, where a fixed offset in world
      // units would drift apart as the frame closed in.
      `<tspan class="mag" x="${cx.toFixed(1)}" dy="1.25em"></tspan></text></g>`);
  }

  return `<div class="atlas-legend">
      <span><i class="sw sw-el"></i>an element — its <b>area</b> is the share of readings through it</span>
      <span><i class="sw sw-loop"></i>↻ feedback — click to go inside it</span>
      <span class="sim-only"><i class="sw sw-good"></i>colour is what <b>simulating</b> did to it —
        red worse, green better, amber moved · grey has not moved · size still says how much
        runs through</span>
      <span class="sim-only">only links the effect travels are drawn · pick a box and each
        thickens by <b>the share it carried</b></span>
      <span class="sim-only"><i class="sw sw-gate"></i>a bar means the change
        <b>stopped there</b> · nothing beyond it is drawn</span>
      <span>point at anything to name it · ${pctNote()}</span>
    </div>
    <div class="atlaswrap">
      <svg class="atlas" viewBox="0 0 ${W} ${H}" style="--z:1" role="application"
        aria-label="Atlas of ${escapeHtml(labelOf(A.start))} — every pathway out of it">${parts.join("")}</svg>
      <div class="atlas-controls">
        <button class="atlas-btn" type="button" data-atlas-close>← Back to the map</button>
        <div class="zoomctl" id="atlas-zoomctl" hidden>
          <button class="atlas-btn" type="button" data-zoomout>Fit to width</button>
          <button class="atlas-btn" type="button" data-replay>Replay the loops</button>
        </div>
      </div>
      <div class="atlas-zoom" role="group" aria-label="Zoom the atlas">
        <button class="atlas-btn" type="button" data-atlas-zoom="out" aria-label="Zoom out">−</button>
        <button class="atlas-btn" type="button" id="atlas-zoom-readout"
          data-atlas-zoom="fit" aria-label="Fit the whole picture across the frame">100%</button>
        <button class="atlas-btn" type="button" data-atlas-zoom="in" aria-label="Zoom in">+</button>
      </div>
    </div>`;
}

// The share every percentage on this page is a share of. Said once, in the
// legend, and again in full whenever a number is shown.
const pctNote = () =>
  `<b>%</b> is the share of all readings that pass through`;

// A tangle drawn as what it contains: boxes round the rim in an order that
// makes almost every link run clockwise, and the few that run the other way —
// the feedback — as chords across the middle. Far away it is a texture; zoomed
// in it is the whole diagram.
function tangleWheel(node: any, cx: any, cy: any, r: any) {
  const t = node.tangles[0];
  if (!t) return "";
  const w = wheelFor(node.id, t);
  const n = w.order.length;
  const R = r * 0.8;
  const at = new Map<any, any>(w.order.map((b: any, i: any) => {
    const a = (-Math.PI / 2) + (i * 2 * Math.PI) / n;
    return [b, [cx + R * Math.cos(a), cy + R * Math.sin(a), a]];
  }));
  w.at = at; w.centre = [cx, cy]; w.radius = R;
  const key = (e: any) => e.from + "" + e.to;
  const polar = new Map<any, any>(w.loops.map((l: any) => [key(l.back), l]));
  const maxGain = Math.max(...w.loops.map((l: any) => l.gain), 0.0001);
  const out: any[] = [];
  for (const e of w.forward) {
    const [x1, y1] = at.get(e.from), [x2, y2] = at.get(e.to);
    out.push(`<path class="ch fw" data-k="${escapeHtml(key(e))}" d="${chordPath(x1, y1, x2, y2, cx, cy, 0.3)}"></path>`);
  }
  for (const e of w.back) {
    const l = polar.get(key(e));
    const [x1, y1] = at.get(e.from), [x2, y2] = at.get(e.to);
    out.push(`<path class="ch bk" data-k="${escapeHtml(key(e))}" d="${chordPath(x1, y1, x2, y2, cx, cy, 0.22)}"
      stroke="${l && l.reinforcing ? "var(--c1)" : "var(--c2)"}"
      stroke-width="${l ? (0.9 + (l.gain / maxGain) * 1.8).toFixed(2) : 1}"></path>`);
  }
  out.push(`<g class="trace"></g>`);
  const maxShare = Math.max(...w.share.values(), 1);
  for (const b of w.order) {
    const [x, yy] = at.get(b);
    const rr = (R / n) * 2.2 * (0.5 + (w.share.get(b) / maxShare) * 0.9);
    out.push(`<circle class="nd" data-box="${escapeHtml(b)}" cx="${x.toFixed(1)}" cy="${yy.toFixed(1)}"
      r="${Math.max(0.7, Math.min(R / 7, rr)).toFixed(2)}"></circle>`);
  }
  out.push(`<g class="labs"></g>`);
  return out.join("");
}

// ---------------------------------------------------------------------------
// LOOKING AT IT — zoom, pan, and what is lit up
// ---------------------------------------------------------------------------
const svgEl = (): any => document.querySelector("#atlas-stage svg.atlas");

// One world unit is this many screen pixels. Text and hairlines divide by it,
// so they stay the same size on screen however far in the frame has closed.
function setScale() {
  const svg = svgEl();
  if (!svg || !VB) return;
  const box = svg.getBoundingClientRect();
  const z = Math.min(box.width / VB.w, box.height / VB.h) || 1;
  svg.style.setProperty("--z", z.toFixed(4));
  svg.setAttribute("viewBox", `${VB.x.toFixed(1)} ${VB.y.toFixed(1)} ${VB.w.toFixed(1)} ${VB.h.toFixed(1)}`);
  // The frame moves every animation frame, and what belongs to a zoomed-in
  // frame — the grab cursor, the way back out — has to keep up with it.
  const zoomedIn = VB.w < wholePicture().w - 1;
  svg.classList.toggle("zoomed", zoomedIn);
  const ctl = document.getElementById("atlas-zoomctl");
  if (ctl) {
    // The way back is offered whenever there is somewhere to come back FROM —
    // inside a tangle, or simply zoomed in past the whole picture.
    ctl.hidden = !zoomedIn && !R.inside;
    const out = ctl.querySelector("[data-zoomout]") as HTMLElement | null;
    if (out) out.textContent = R.inside ? "Back out" : "Fit to width";
    const rp = ctl.querySelector("[data-replay]") as HTMLElement | null;
    if (rp) rp.hidden = !R.inside;
  }
  const readout = document.getElementById("atlas-zoom-readout");
  if (readout) readout.textContent = Math.round(atlasZoomPercent() * 100) + "%";
}

// The frame the picture rests in: the whole of it across the width, filling
// the frame rather than sitting letterboxed inside it. The SVG keeps its aspect
// ratio, so a viewBox shaped like the frame is what stops the browser padding
// the sides.
function frameAspect(): number {
  const svg = svgEl();
  const box = svg ? svg.getBoundingClientRect() : null;
  const w = box && box.width ? box.width : 16;
  const h = box && box.height ? box.height : 9;
  return w / h;
}

function wholePicture(): any {
  const b = WORLD.bounds || { x: 0, y: 0, w: WORLD.W, h: WORLD.H };
  const aspect = frameAspect();
  // Fit the width of what is drawn. Where the picture is taller than that
  // leaves room for, the rest is panned to rather than shrunk away: a tall map
  // squeezed into a short frame stops being readable long before it fits.
  let w = b.w, h = w / aspect;
  if (h < b.h) { h = b.h; w = h * aspect; }
  return { x: b.x - (w - b.w) / 2, y: b.y - (h - b.h) / 2, w, h };
}

function frameOn(id: any) {
  const [cx, cy] = WORLD.at.get(id), r = WORLD.rOf.get(id);
  const svg = svgEl();
  const box = svg ? svg.getBoundingClientRect() : { width: 16, height: 9 };
  const aspect = (box.width || 16) / (box.height || 9);
  // Close in until the tangle owns the frame, but never so far that a small
  // one fills the screen with its two neighbours.
  const h = Math.max(r * 2.9, WORLD.H * 0.12), w = h * aspect;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

function zoomTo(target: any, then?: any) {
  cancelAnimationFrame(vbRAF);
  const from = VB || wholePicture();
  if (reduced()) { VB = target; setScale(); if (then) then(); return; }
  const t0 = performance.now(), MS = 620;
  const ease = (t: any) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const step = (now: any) => {
    const f = Math.min(1, (now - t0) / MS), e = ease(f);
    VB = {
      x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e,
      w: from.w + (target.w - from.w) * e, h: from.h + (target.h - from.h) * e,
    };
    setScale();
    if (f < 1) vbRAF = requestAnimationFrame(step);
    else if (then) then();
  };
  vbRAF = requestAnimationFrame(step);
}

// Every pathway from the start box, or — once a circle has been picked — every
// pathway that runs THROUGH it and on to whatever it ends up feeding. A circle
// in the middle of the map is not a place the story stops; asking about one
// asks what it leads to, and the answer is the outputs on the far side of it.
const PATHS_THROUGH = new Map<string, any[][]>();

// In ORDER. Two circles picked mean "the pathways that go through this one and
// then that one" — clicking along a route is how a route gets narrowed down, so
// a circle upstream of one already picked is not a narrowing, it is a new
// question. That is what makes stacking safe: the test for "is this one further
// along" is simply whether any pathway still holds them all in order.
function holdsInOrder(path: any[], els: any[]): boolean {
  let at = -1;
  for (const el of els) {
    const next = path.indexOf(el, at + 1);
    if (next < 0) return false;
    at = next;
  }
  return true;
}

function pathsThrough(els: any[]): any[][] {
  if (!els.length || !WORLD) return [];
  const key = els.join("\u0000");
  if (PATHS_THROUGH.has(key)) return PATHS_THROUGH.get(key)!;
  // The walk is gated on the first, which is the cheapest gate the engine
  // offers; the rest are a filter over what it hands back.
  const list = strands(WORLD.A, { through: els[0], limit: STRAND_MAX }).list
    .filter((p: any[]) => holdsInOrder(p, els));
  PATHS_THROUGH.set(key, list);
  return list;
}

// Cached against what it depends on, since renderInspector runs on every
// repaint. The cached OBJECT is also the key the fork tree is built against, so
// this staying stable is what keeps the list's identities stable.
function strandList(): any {
  const empty = { list: [], truncated: false, reachable: true };
  if (!WORLD) return empty;
  // Every pathway on the map, whatever is picked. Picking a circle used to
  // re-root this — the eleven outputs became one, and the list you were reading
  // was replaced by a different list about somewhere else. It opens the list
  // now instead: the outputs stay where they are and the branches the circle is
  // on unfold to it. So the walk no longer depends on what is picked, and
  // neither does the tree built from it.
  const key = String(WORLD.A.start);
  if (STRAND_CACHE && STRAND_CACHE.key === key) return STRAND_CACHE.result;
  const result = strands(WORLD.A, { through: null, limit: STRAND_MAX });
  STRAND_CACHE = { key, result };
  return result;
}

// A circle, as the list would put it: everything running through it, all the
// way out to what it feeds. Pointing at a circle draws this, and clicking pins
// it — so what the pointer showed is exactly what the click leaves.
function forkToElement(els: any[]): Fork | null {
  if (!WORLD || !ATLAS || !els.length) return null;
  const last = els[els.length - 1];
  if (!ATLAS.nodes.has(last) || last === WORLD.A.start) return null;
  const list = pathsThrough(els);
  return list.length ? { via: last, paths: list, kids: [], depth: 0 } : null;
}

// What clicking a circle would leave you with: added to the trail if any
// pathway still runs through them all in order, and a fresh start if not. The
// pointer shows this, so the click can only ever leave what was shown.
function rootsAfterClicking(el: any): any[] {
  const at = R.roots.indexOf(el);
  if (at >= 0) return R.roots.slice(0, at);        // clicking one again drops it
  const stacked = R.roots.concat([el]);
  return pathsThrough(stacked).length ? stacked : [el];
}

// Two picks are the same pick when they cover the same routes.
const sameStrand = (a: any[][], b: any[][]) =>
  a.length === b.length &&
  new Set(a.map(p => p.join("\u0000"))).size ===
    new Set([...a, ...b].map(p => p.join("\u0000"))).size;

// The frame a strand wants: all of it, with room round it, in the shape of the
// window so the browser does not letterbox it.
function frameOnStrand(path: any[]) {
  if (!WORLD || !path.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const id of path) {
    const at = WORLD.at.get(id);
    if (!at) continue;
    const r = WORLD.rOf.get(id) || 0;
    x0 = Math.min(x0, at[0] - r); x1 = Math.max(x1, at[0] + r);
    y0 = Math.min(y0, at[1] - r); y1 = Math.max(y1, at[1] + r);
  }
  if (!isFinite(x0)) return null;
  const aspect = frameAspect();
  const padX = (x1 - x0) * 0.06 + 24, padY = (y1 - y0) * 0.22 + 24;
  let w = (x1 - x0) + padX * 2, h = (y1 - y0) + padY * 2;
  if (w / h < aspect) w = h * aspect; else h = w / aspect;
  return { x: (x0 + x1) / 2 - w / 2, y: (y0 + y1) / 2 - h / 2, w, h };
}

// Escape steps back out one fork at a time; see the keydown handler below.
// ↑ / ↓ point at the row above or below, and Enter chooses it — the same two
// acts the pointer performs, for anyone not using one.

// ───── Telling one pathway from another ───────────────────────────────────
// Every pathway starts in the same place, so the list can only tell them apart
// by where they GO — and it does that one FORK at a time.
//
// The top of the tree is the destinations. Under a destination, each level is
// the next box where the pathways still in play stop agreeing: that box is the
// one just past their longest common prefix, and it is the SHORTEST thing that
// tells them apart, so no two rows at a level can read the same.
//
// The list used to be flattened to two of those levels — destination, then the
// first fork — with a "×4" standing in for four routes drawn on top of one
// another. The count was the only trace of everything past that first fork, and
// there was no way to get at it. Now the count is a door: opening a fork lights
// what is under it, frames it, and shows the next fork down.

interface Fork {
  via: any;          // the element this fork is named by
  paths: any[][];    // every pathway under it
  kids: Fork[];      // the next fork down, or none when one pathway is left
  depth: number;     // 0 = a destination, 1 = its first fork, and so on
}

function forks(paths: any[][], depth: number): Fork[] {
  let lcp = 0;
  while (paths.every(p => p.length > lcp && p[lcp] === paths[0][lcp])) lcp++;
  const byNext = new Map<any, any[][]>();
  for (const p of paths) {
    // A pathway that stops exactly where its siblings carry on has no box to be
    // named by. It is a leaf either way, so it keeps the null and is named for
    // arriving straight there.
    const next = lcp < p.length ? p[lcp] : null;
    if (!byNext.has(next)) byNext.set(next, []);
    byNext.get(next)!.push(p);
  }
  const out: Fork[] = [];
  for (const [via, ps] of byNext) {
    out.push({
      via, paths: ps, depth,
      kids: via !== null && ps.length > 1 ? forks(ps, depth + 1) : [],
    });
  }
  return out;
}

// The way down to a picked circle inside one destination: the forks to open so
// that the row the circle is on is on screen. Descends while exactly one fork
// still leads to it — where several do, the circle is on divergent routes and
// there is no single row to open down to, so it stops there and marks the fork
// it reached.
function chainTo(dest: Fork, els: any[]): Fork[] {
  const last = els[els.length - 1];
  const out: Fork[] = [];
  let here = dest;
  while (here.kids.length) {
    if (here.via === last) break;                  // this row IS the last circle
    const on = here.kids.filter(k => holds(k, els));
    if (on.length !== 1) break;
    out.push(on[0]);
    here = on[0];
  }
  return out;
}

const holds = (f: Fork, els: any[]): boolean =>
  f.paths.some(p => holdsInOrder(p, els));

// The tree, built once per pathway list rather than per call. Identity is the
// whole point: the chain you have open, the row marked as chosen, the rows the
// arrow keys step through and the fork a circle belongs to are all compared by
// IDENTITY, and rebuilding the tree on every call quietly made every one of
// those comparisons false. strandList() hands back the same object while its
// own cache stands, so it is the key.
let TREE_OF: any = null;
let TREE: Fork[] = [];

// ── The handle a row carries ──────────────────────────────────────────────
// A row used to carry its whole way down as element ids joined by a separator,
// and an element id is not safe to join. A folded family's id is built by the
// engine as "L:" + prefix + SEP + suffix, and SEP was the very character the
// join used — so every folded row encoded to a path that decoded into a longer,
// different one, nothing matched it, and a row standing for a family could not
// be opened at all. Clicking it did nothing, and nothing it could ever do.
//
// The way down never becomes a string now. The row carries an opaque handle
// and the path is looked up, so no character in a label can break it.
const FORK_KEY = new Map<Fork, string>();     // fork → the handle its row carries
const KEY_PATH = new Map<string, any[]>();    // handle → the way down to that fork
const KEY_FORK = new Map<string, Fork>();     // handle → the fork itself

function forkTree(): Fork[] {
  const res = strandList();
  if (TREE_OF !== res) {
    TREE_OF = res;
    TREE = destinationForks(res.list);
    indexForks(TREE);
  }
  return TREE;
}

// Handed out once per tree, alongside the tree, so a handle and the fork it
// names cannot come apart.
function indexForks(tree: Fork[]): void {
  FORK_KEY.clear(); KEY_PATH.clear(); KEY_FORK.clear();
  let n = 0;
  const walk = (level: Fork[], trail: any[]): void => {
    for (const f of level) {
      const mine = trail.concat([f.via]);
      const key = "f" + (n++);
      FORK_KEY.set(f, key); KEY_PATH.set(key, mine); KEY_FORK.set(key, f);
      walk(f.kids, mine);
    }
  };
  walk(tree, []);
}

// The destinations, in the order the walk found them — which, because it is
// shortest-pathway-first, is nearest destination first.
function destinationForks(list: any[][]): Fork[] {
  const byDest = new Map<any, any[][]>();
  for (const p of list) {
    const dest = p[p.length - 1];
    if (!byDest.has(dest)) byDest.set(dest, []);
    byDest.get(dest)!.push(p);
  }
  return [...byDest].map(([dest, paths]) => ({
    via: dest, paths, depth: 0,
    kids: paths.length > 1 ? forks(paths, 1) : [],
  }));
}

// A fork delivers everything under it, so its weight is the SUM of its
// pathways' gains, not its strongest — taking the strongest would drop the
// others on the floor and the column would stop adding up.
const forkGain = (f: Fork): number => f.paths.reduce((a, p) => a + pathGain(p), 0);

// ───── Where you are in that tree ─────────────────────────────────────────
// R.current is the chain of forks last taken hold of, outermost first. Empty is the
// top: the list is the destinations, nothing is lit, and the picture is whole.
// One fork open per level, because you can only read one at a time — opening a
// sibling replaces the fork you were in rather than adding to it.


// A path of vias as the forks it names, or as far down it as still exists — the
// list is rebuilt whenever the map changes, so a path can go stale.
function forksAlong(path: any[]): Fork[] {
  const out: Fork[] = [];
  let kids = forkTree();
  for (const via of path) {
    const next = kids.find(f => f.via === via);
    if (!next) break;
    out.push(next);
    kids = next.kids;
  }
  return out;
}

// The row last taken hold of, as forks. Trimmed back to what still exists.
function openChain(): Fork[] {
  const out = forksAlong(R.current);
  if (out.length !== R.current.length) R.current = out.map(f => f.via);
  return out;
}

// ── What is open ──────────────────────────────────────────────────────────
// Opening a row no longer closes any other. The list used to hold ONE open
// chain, so taking hold of a row anywhere shut whatever was open elsewhere —
// every row below it moved, and the thing you were about to read next was no
// longer where you had just seen it. Rows are independent now: a row opens when
// you click it and closes when you click it again, and nothing else moves
// either time.
const samePath = (a: any[], b: any[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);
const startsWith = (path: any[], prefix: any[]) =>
  path.length >= prefix.length && prefix.every((v, i) => v === path[i]);

// Does this row show its forks? Because it was opened, or because something
// opened below it has to be reached through it.
const isOpen = (path: any[]) => R.open.some(o => startsWith(o, path));

// ── The boxes a folded row stands for ─────────────────────────────────────
// A folded circle is several boxes that share a core phrase — four Seizure
// boxes, one per drug — so a row named after it reads "via ◇ Seizure" for all
// four at once, and the forks beneath it are the union of what the four do.
// Naming them under the row, and letting one be picked, is the map saying which
// of the four actually takes each step onward. The engine worked that out on
// the way past and has been handing it back unused ever since (stepLanes);
// nothing here recomputes it.
const laneAt = (path: any[]): string | null => {
  const hit = R.lanes.find(l => samePath(l.path, path));
  return hit ? hit.value : null;
};

// Picking the one already picked lets go of it, which is the rule every other
// control in this panel follows.
function pickLane(path: any[], value: string): void {
  const had = laneAt(path);
  R.lanes = R.lanes.filter(l => !samePath(l.path, path));
  if (had !== value) R.lanes.push({ path, value });
  // No reframe: which of four boxes is being asked about does not change where
  // the picture is looking.
  syncStrandToOpen(false);
}

// What a folded element stands for, or nothing when it is not a family. A
// tangle is folded too, and what it holds is loops rather than alternatives —
// the aside already draws those as diagrams.
function lanesOf(via: any): string[] {
  if (!ATLAS || via === null) return [];
  const node = ATLAS.nodes.get(via);
  if (!node || node.loop || !node.lanes || node.boxes.length < 2) return [];
  const out = [...node.lanes].map(String).sort();
  return out.length > 1 ? out : [];
}

// The forks under a folded row that this box does NOT take. They stay on screen
// and stay in the arithmetic: going quiet is the map saying "not this one",
// which is a different thing from the map not saying anything, and a column
// that silently dropped rows would stop adding up to the number above it.
//
// A row's forks split at the first element they disagree on, which is not
// always the very next one — so the step to ask about is read off the pathway
// rather than assumed to be the fork's own name. A step the engine recorded no
// boxes for is KEPT: the list may not narrow as far as it could, but it can
// never quieten a route that this box really does take.
function offLane(f: Fork, lane: string): Set<Fork> {
  const out = new Set<Fork>();
  const steps = ATLAS && ATLAS.stepLanes;
  if (!steps) return out;
  for (const k of f.kids) {
    const takes = k.paths.some(p => {
      const at = p.indexOf(f.via);
      if (at < 0 || at + 1 >= p.length) return true;
      const took = steps.get(f.via + ">" + p[at + 1]);
      return !took || took.has(lane);
    });
    if (!takes) out.add(k);
  }
  return out;
}

// Light everything under where you are, and frame it. At the top there is
// nothing to light, so the picture goes back to being whole.
// The reading has changed: repaint, and frame what it now draws. There is
// nothing to set here — what is drawn follows from the reading — which is the
// whole point of the reading being one record.
function syncStrandToOpen(reframe: boolean): void {
  POINTED = null;
  // A box traced back to the sliders and a fork read in the list are two
  // answers to the same question, so taking one lets go of the other. This used
  // to be written out again at each place that changed either of them, which is
  // how they came to disagree; there is one place now, and it is here.
  // (The trace a chosen destination implies is not this one — that is worked
  // out in traceEl(), and letting go of an explicit trace cannot disturb it.)
  dropTrace();
  paintAtlas();
  if (!reframe) return;
  const paths = drawn();
  const f = paths ? frameOnStrand(paths.flat()) : wholePicture();
  if (f) zoomTo(f);
}

// One click, three things: light every pathway under this fork, frame them,
// and open it so the next fork can be picked.
// `path` is the whole way down to the row: the destination first, then each
// fork. Because the row carries it, this never has to reconstruct the
// ancestors from whatever was open — which is what used to fail when the list
// had been opened by a circle rather than drilled by hand.
function openFork(path: any[]): void {
  if (!path.length) return;
  // Open or shut, and nothing else: a row you click closes if it is open and
  // opens if it is not. Requiring it to be the CURRENT row as well meant the
  // first click on a row opened by a circle only took hold of it, and it took a
  // second click to close what already looked open — the two-click surprise
  // this control keeps being reported for. Pointing at a row already draws it
  // without committing, so there is nothing left for a take-hold-only click to
  // be for.
  if (isOpen(path)) {
    R.open = R.open.filter(o => !startsWith(o, path));
    R.current = path.slice(0, -1);
    syncStrandToOpen(true);
    return;
  }
  // Deeper, or sideways? Only going deeper is a change of PLACE, and only a
  // change of place moves the camera.
  const deeper = path.length > R.current.length;
  // Ancestors stay in the set. Dropping them left a row open only by implication
  // — through the path of a row deeper down — so closing that deeper row closed
  // the whole branch with it, which is the collapsing this was meant to end.
  R.open = R.open.filter(o => !samePath(o, path)).concat([path]);
  R.current = path;
  syncStrandToOpen(deeper);
}

// Stepping back out. Depth 0 is the top.
// Narrowing and rooting are two separate depths of letting go: this pops the
// narrowing only. The circle the list is rooted on is let go of by the top row
// or by Escape, once there is no narrowing left to undo — so one press, or one
// click, is always exactly one step back out.
function closeToDepth(depth: number): void {
  const path = R.current.slice(0, depth);
  R.open = R.open.filter(o => !startsWith(o, R.current.slice(0, depth + 1)));
  R.current = path;
  syncStrandToOpen(true);
}

// ───── What each route contributed ────────────────────────────────────────
// The rows under a destination say how much of ITS change came by each route,
// and they add up to the destination's change. That is not a presentational
// trick — it is what the engine's own arithmetic says.
//
// The default rule is multiplicative: value = baseline × ∏(source ratio)^strength.
// Take logs and it becomes a SUM — ln(ratio) at a box is the sum, over its
// incoming links, of strength × ln(ratio) at the source. Unrolled back to the
// input, the change at a destination is the sum, over every route reaching it,
// of (the product of the strengths along that route) × the change at the input.
// So a route's share of the total is its signed gain over the sum of all their
// gains, and the shares are exact rather than estimated.
//
// Two honest limits, both recorded rather than hidden:
//   • a circle can stand for several boxes (a family, or a whole tangle), and
//     there is then no single link between two circles — the strongest
//     underlying link wins, which is the rule the engine already uses when it
//     contracts a tangle;
//   • a box using `additive`, `min` or a formula is not multiplicative, so its
//     logs do not add. The split is then a proportion, not an identity.
// A route whose gain is NEGATIVE (an odd number of "decreases" links along it)
// contributes against the total, and shows as such — which is the whole point
// of splitting them up.
const PAIR_GAIN = new Map<string, number>();

// Signed, not absolute: the direction a route pushes in is half of what it
// contributes. (The loop machinery elsewhere wants |strength| — this does not.)
//
// A GATE transmits nothing, whatever its elasticity says. The structural figure
// below is a property of the MAP and is cached for its lifetime; whether the box
// at the far end is currently held is a property of THIS RUN and has to be asked
// every time. Without this the panel went on attributing a share to routes the
// picture drew as stopping dead — "via Vehicle Physical Search −0.3%" against a
// route carrying nothing — and the share it took came out of the routes that had
// actually carried something.
function pairGain(a: any, b: any): number {
  return heldBy(b) ? 0 : structuralGain(a, b);
}

function structuralGain(a: any, b: any): number {
  const key = a + "\u0000" + b;
  const had = PAIR_GAIN.get(key);
  if (had !== undefined) return had;
  const from = ATLAS && ATLAS.nodes.get(a), to = ATLAS && ATLAS.nodes.get(b);
  let best = 0;
  if (from && to && GRAPH) {
    const targets = new Set<any>(to.boxes);
    for (const box of from.boxes) {
      for (const e of GRAPH.out.get(box) || []) {
        if (targets.has(e.to) && Math.abs(e.elasticity || 0) > Math.abs(best)) best = e.elasticity || 0;
      }
    }
  }
  PAIR_GAIN.set(key, best);
  return best;
}

const pathGain = (path: any[]): number => {
  let gain = 1;
  for (let i = 0; i + 1 < path.length; i++) gain *= pairGain(path[i], path[i + 1]);
  return gain;
};

// Split `total` across `weights` and round to one decimal so that the printed
// numbers ADD UP to the printed total. Rounding each share on its own leaves a
// column that visibly fails to sum, which is exactly the complaint this whole
// number answers — so the remainder goes to the largest fractions (the standard
// largest-remainder apportionment).
function apportion(total: number, weights: number[]): number[] | null {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum || !Number.isFinite(sum)) return null;
  const tenths = weights.map(w => (total * w / sum) * 10);
  const out = tenths.map(v => Math.floor(v));
  let owed = Math.round(total * 10) - out.reduce((a, b) => a + b, 0);
  const order = tenths
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < Math.abs(owed) && order.length; k++) {
    out[order[k % order.length].i] += owed > 0 ? 1 : -1;
  }
  return out.map(v => v / 10);
}

// ───── What the rows say ──────────────────────────────────────────────────

const steps = (f: Fork): string => {
  const lens = f.paths.map(p => p.length);
  const lo = Math.min(...lens), hi = Math.max(...lens);
  return lo === hi ? `${lo} ${plural(lo, "step")}` : `${lo}–${hi} steps`;
};

// A fork is named by the box that makes it different from its siblings. At the
// first fork under a destination that is "via X"; deeper down the pathways have
// already agreed on a via, so it is "then via X" — the word says the label is
// picking up where the row above left off rather than starting again.
const forkLabel = (f: Fork): string =>
  f.via === null ? "straight there" : (f.depth > 1 ? "then via " : "via ") + clip(labelOf(f.via), 28);

// One line each. The row stays one line even when it is the one being read —
// the pathway itself is drawn, framed and named on the picture, and repeating
// it here as text would say the same thing twice in the same glance.
function forkRow(
  f: Fork, chosen: boolean, share: number | null, direction: string | undefined,
  isEl: boolean, quiet: boolean,
): string {
  // While the sliders are out, the right-hand number stops being how LONG the
  // route is and becomes how much of the destination's change came THIS way.
  // Which fork did the work is the question a simulation is asking.
  const right = state.simulationMode
    ? (share === null ? "—" : signed(share))
    : steps(f);
  return `<button type="button" class="strandrow${chosen ? " cur" : ""}${
      isEl ? " isel" : ""}${quiet ? " quiet" : ""}" ${rowAttrs(f)}>
    <span class="line"><span class="dest">${escapeHtml(forkLabel(f))}${
      f.paths.length > 1 ? `<em>×${f.paths.length}</em>` : ""}</span><span
      class="m${state.simulationMode && share !== null
        ? " " + shareMerit(share, direction) : ""}">${escapeHtml(right)}</span></span></button>`;
}

// The boxes a folded row stands for, named, with one pickable. Under the row
// rather than beside it, because it IS the row's next level: the row says "via
// ◇ Seizure" for four boxes at once, and this is the four.
//
// Nothing here is a filter over the list. Picking one quietens the forks that
// box does not take and leaves them where they are, so the count above still
// covers what is under it and letting go costs one click.
function laneStrip(f: Fork, path: any[]): string {
  const lanes = lanesOf(f.via);
  if (!lanes.length || !f.kids.length) return "";
  const on = laneAt(path);
  const key = FORK_KEY.get(f) || "";
  // The line above the boxes says the same thing whether one is picked or not.
  // It used to drop its hint on picking, which reflowed the boxes under it —
  // so the box you had just clicked moved out from under the pointer.
  return `<div class="lanestrip" role="group" aria-label="The ${lanes.length} boxes ${
      escapeHtml(labelOf(f.via))} stands for">` +
    `<span class="ln">${lanes.length} ${plural(lanes.length, "box", "boxes")} — ` +
    `pick one to see which way it goes</span>` +
    lanes.map(l => `<button type="button" class="lane${l === on ? " on" : ""}"` +
      ` data-lane="${escapeHtml(l)}" data-lanerow="${escapeHtml(key)}"` +
      ` aria-pressed="${l === on ? "true" : "false"}">${escapeHtml(l)}</button>`).join("") +
    `</div>`;
}

// The destination's change, split down the chain you have opened, so the rows
// at any depth still add up to the number printed above them. At depth 1 that
// number is the destination's own move; deeper, it is the slice this fork was
// apportioned by its parent.
function shareAtOpen(chain: Fork[]): number | null {
  if (!state.simulationMode || !chain.length || !ATLAS) return null;
  const dest = ATLAS.nodes.get(chain[0].via);
  const effect = dest ? movesOf(dest.boxes) : null;
  if (!effect || !effect.moved) return null;
  let share = effect.pct;
  for (let i = 1; i < chain.length; i++) {
    const sibs = chain[i - 1].kids;
    const parts = apportion(share, sibs.map(forkGain));
    const at = sibs.indexOf(chain[i]);
    if (!parts || at < 0) return null;
    share = parts[at];
  }
  return share;
}

// ───── Pointing, and choosing ─────────────────────────────────────────────
// They are different acts, and the list treats them differently. POINTING at a
// fork — with the mouse, with the arrow keys, or at one of its circles on the
// picture — draws it, and does nothing else: it does not commit, and it does
// not move the camera. So a whole fork can be swept by running down it, and
// nothing passed on the way costs a click to undo. CHOOSING commits, and only
// then does the picture open the next level under it.
//
// What is drawn while pointing is exactly what choosing would leave you with,
// rather than a second thing lit beside it. Amber is already spoken for in this
// picture (it is the colour of the route being read), and a fork drawn on top
// of another fork is the muddle this whole list was rebuilt to end.


// Every fork with a row on screen, in the order the rows are in. The picture
// and the arrow keys both work off this, so all three ways of pointing at a
// fork can only ever agree with one another.
let VISIBLE: Fork[] = [];

export function previewFork(f: Fork | null): void {
  if (POINTED === f) return;
  POINTED = f;
  // No reframe, and no re-render of the panel: the row being pointed at is
  // under the pointer, and redrawing the list would pull it out from under it.
  paintAtlas(false);
}

// What pointing at a circle draws. A row in the list narrows the ways of
// reaching ONE destination; a circle on the map changes which destination that
// is. So the two surfaces are not the same list twice — they are the two halves
// of the same question, "where to" and "which way", and each shows what
// clicking it would leave you with.
function forkAtElement(el: any): Fork | null {
  // Exactly what clicking it would leave: added to the trail if it is further
  // along, a fresh start if it is not. So a circle that would narrow the trail
  // previews the narrowing, and one that would replace it previews the
  // replacement — the pointer never promises something the click will not do.
  return forkToElement(rootsAfterClicking(el));
}

// The fork a row stands for, from the handle the row carries. A row at depth d
// is one of the forks under whatever is chosen at d-1, which is what makes a
// row at an ancestor's level still clickable: it is a sibling of that ancestor,
// not of where you are.
function forkOfKey(raw: string | undefined): Fork | null {
  if (!raw) return null;
  forkTree();                    // the index is handed out with the tree
  return KEY_FORK.get(raw) || null;
}

// The way down to a fork. The rows carry a handle to it; the keyboard has no
// row to read one off, so it asks for the fork's own.
function pathOfFork(target: Fork): any[] {
  forkTree();
  const key = FORK_KEY.get(target);
  // A circle's fork is made up on the spot rather than taken from the tree
  // (see forkToElement), so it has no handle and no way down — which is what
  // stops Enter on one from opening a row that does not exist.
  return (key ? KEY_PATH.get(key) : null) || [];
}

function stepPreview(delta: number): void {
  if (!VISIBLE.length) return;
  const at = POINTED ? VISIBLE.indexOf(POINTED) : -1;
  const next = at < 0
    ? (delta > 0 ? 0 : VISIBLE.length - 1)
    : (at + delta + VISIBLE.length) % VISIBLE.length;
  previewFork(VISIBLE[next]);
  // Keep the row that is now being pointed at in view — with the whole chain
  // listed, the fork you are sweeping towards can be below the fold.
  // By its own handle, not its name and depth: the same fork name can appear at
  // the same depth under two different outputs, and the first match is not
  // necessarily the one being pointed at.
  const key = FORK_KEY.get(VISIBLE[next]) || "";
  const row = document.querySelector(
    `#detail-content [data-forkpath="${CSS.escape(key)}"]`);
  if (row && typeof row.scrollIntoView === "function") {
    row.scrollIntoView({ block: "nearest" });
  }
}

// ───── The list ───────────────────────────────────────────────────────────
// Nothing is ever replaced. Every level you have opened stays on screen with
// the forks beside it, the chosen one in white, the next level indented under
// it. A wrong turn is undone by pointing at the right row, because the right
// row never left; and the whole of what you have walked is one surface the
// pointer can sweep.

// A row carries the WHOLE way down to it, not just its own name and depth.
// Guessing the ancestors from whatever chain happened to be open is what broke
// when the list was opened by a circle rather than drilled by hand: the click
// wrote a chain whose first entry was a fork where a destination belonged, the
// chain failed to resolve, and the entire list unwound.
const rowAttrs = (f: Fork): string =>
  `data-fork="${f.via === null ? "" : escapeHtml(String(f.via))}" data-forkdepth="${f.depth}"` +
  ` data-forkpath="${escapeHtml(FORK_KEY.get(f) || "")}"`;

// The row hands its handle straight back. Nothing is parsed, so nothing can be
// mis-parsed.
const decodePath = (raw: string | undefined): any[] =>
  (raw ? KEY_PATH.get(raw) : null) || [];

// A destination row: the output, how far it moved against the biggest mover on
// the map, and by how much. There is no separate "final outputs" list because
// this is it.
function destRow(
  f: Fork, chosen: boolean, outputScale: number, quiet = false, marked = false,
): string {
  const dest = ATLAS.nodes.get(f.via);
  const effect = state.simulationMode && dest ? movesOf(dest.boxes) : null;
  const move = effect && effect.boxes.length
    ? `<span class="dmove ${effect.moved ? effect.merit : "flat"}">${signed(effect.pct)}</span>`
    : "";
  const bar = effect && effect.moved ? moveBar(effect.pct, effect.merit, outputScale) : "";
  return `<button type="button" class="dhead${chosen ? " cur" : ""}${
    quiet ? " quiet" : ""}" ${rowAttrs(f)}><span class="dname">${
    marked ? `<span class="hitdot" aria-hidden="true"></span>` : ""}${
    escapeHtml(clip(labelOf(f.via), 26))}</span>${
    f.paths.length > 1 ? `<span class="m">×${f.paths.length}</span>` : ""}${bar}${move}</button>`;
}

// The loop the wheel is drawing, if any — so the row for it can be marked.
function isDrawnLoop(loop: any): boolean {
  if (!WHEEL_PICK) return false;
  const through = loopsThrough(WHEEL_PICK);
  if (!through.length) return false;
  const drawing = rotateTo(through[WHEEL_LOOP % through.length], WHEEL_PICK);
  return canonicalCycle(drawing.cycle) === canonicalCycle(loop.cycle);
}

function strandsHtml(): string {
  const res = strandList();
  if (!res.list.length) return "";
  openChain();          // trims R.current back to what still exists
  VISIBLE = [];

  // While simulating, the destination that MOVED most comes first — the run is
  // the question being asked, so the answer leads. At rest the order is the
  // walk's own, which is shortest-pathway first. (`movesOf` is cached per solve
  // upstream, so asking every destination for its move costs one pass.)
  let dests = forkTree();
  let outputScale = 0;
  if (state.simulationMode && ATLAS) {
    const moved = new Map<any, number>(dests.map(g => {
      const node = ATLAS.nodes.get(g.via);
      const e = node ? movesOf(node.boxes) : null;
      return [g.via, e && e.moved ? Math.abs(e.pct) : 0];
    }));
    dests = [...dests].sort((a, b) => moved.get(b.via)! - moved.get(a.via)!);
    outputScale = Math.max(...moved.values(), 0);
  }

  // The way back to nothing chosen at all, and the count everything below is a
  // part of.
  // The circles clicked, in the order clicked. The list opens to the last of
  // them, and only along the branches that hold all of them in order.
  const els = R.roots;
  const last = els.length ? els[els.length - 1] : null;
  const picked = last && ATLAS && ATLAS.nodes.has(last) ? ATLAS.nodes.get(last) : null;

  // The top row is the whole map's pathways and stays that way, whatever is
  // picked — it is the way back to nothing chosen.
  let html = `<button type="button" class="pathall${
    R.current.length || els.length ? "" : " cur"}" data-crumb="0">` +
    `<span class="dname">All pathways</span><span class="m">×${res.list.length}</span></button>`;

  // What a picked circle has to say that its pathways cannot: the loops it
  // contains, and the boxes it stands for — the way back out to the map. Drawn
  // once, under the first output the circle turns up in.
  const asideHtml = (): string => {
    if (!picked) return "";
    const loops = tangleLoops(last);
    const boxes = picked.boxes.length > 1 ? picked.boxes : [];
    if (!loops.length && !boxes.length) return "";
    return `<div class="pathaside">${
      loops.length
        ? `<div class="loopcards">${loops.slice(0, CARD_MAX).map((l: any, i: number) =>
            loopCard(l, i, isDrawnLoop(l), false)).join("")}</div>`
        : ""}${
      boxes.map((b: any) =>
        `<button type="button" class="atlas-boxrow" data-atlas-box="${escapeHtml(b)}">` +
        `<span class="bn">${escapeHtml(clip(boxLabel(b), 30))}</span>` +
        `<span class="go">open ↗</span></button>`).join("")}</div>`;
  };

  // One level per call. A row shows its forks when the reader has opened it, or
  // when something opened further down has to be reached through it, or when a
  // picked circle lies below it. `stopAt` is the row a circle's own expansion
  // ends on: opening reaches the circle and goes no further, because going
  // further would be answering a question nobody asked.
  const levelHtml = (
    level: Fork[], depth: number, trail: any[], above: Fork[],
  ): string => {
    const destFork = above[0] || null;
    const dest = destFork && ATLAS ? ATLAS.nodes.get(destFork.via) : null;
    const direction = dest ? agreedDirection(dest.boxes) : undefined;
    // Each level splits the share of the fork above it — of THIS branch's fork,
    // not of whichever branch happens to be current, now that several can be
    // open at once. So the rows at any depth still add up to the number the row
    // above them prints, in every branch on screen.
    const share = depth > 0 ? shareAtOpen(above) : null;
    const shares = depth > 0 && share !== null ? apportion(share, level.map(forkGain)) : null;

    // A box picked out from under the row above quietens the forks it does not
    // take. `trail` IS that row's way down, so this is the row's own pick and
    // not whichever branch happens to be current.
    const parent = above.length ? above[above.length - 1] : null;
    const picked = parent ? laneAt(trail) : null;
    const hushed = parent && picked ? offLane(parent, picked) : null;

    return level.map((f, i) => {
      VISIBLE.push(f);
      const mine = trail.concat([f.via]);
      // The row the circle is ON, rather than a row on the way down to it.
      const isEl = els.includes(f.via);
      const current = samePath(R.current, mine);
      const row = forkRow(f, current || isEl, shares ? shares[i] : null, direction, isEl,
        !!hushed && hushed.has(f));
      if (!f.kids.length || !isOpen(mine)) return row;
      return row + `<div class="pathlvl">${laneStrip(f, mine)}${
        levelHtml(f.kids, depth + 1, mine, above.concat([f]))}</div>`;
    }).join("");
  };

  let asideDone = false;
  html += dests.map(d => {
    VISIBLE.push(d);
    // A picked circle opens every output it is on, all at once — "all the
    // pathways it is part of" is inherently plural. The outputs it never
    // reaches stay shut and go quiet: still there, still countable, plainly not
    // part of this.
    const hit = !!els.length && holds(d, els);
    const mine = [d.via];
    const row = destRow(d, samePath(R.current, mine), outputScale,
      !!els.length && !hit, hit);
    if (!d.kids.length || !isOpen(mine)) return row;
    const aside = hit && !asideDone ? (asideDone = true, asideHtml()) : "";
    return row + `<div class="pathlvl">${aside}${laneStrip(d, mine)}${
      levelHtml(d.kids, 1, mine, [d])}</div>`;
  }).join("");

  // The readout. With a circle picked it is the circle's own line — its name,
  // its share of everything, and how many pathways it is on — which is the one
  // thing it has to say that no row in the list says for it. Otherwise it says
  // what is drawn, and how to sweep without a pointer.
  const held = openChain();
  const here = held.length ? held[held.length - 1] : null;
  const said = picked && WORLD
    ? `${els.map((e: any) => clip(labelOf(e), 18)).join(" → ")} · ${
        pct(WORLD.M.weight(last))} of everything · on ${
        pathsThrough(els).length} ${plural(pathsThrough(els).length, "pathway")}`
    : here
      ? `${here.paths.length} ${plural(here.paths.length, "pathway")} drawn`
      : "Point at a row to draw it";
  html += `<div class="pathfoot">${escapeHtml(said)} · ↑ ↓ to sweep · Enter to choose</div>`;
  return `<div class="strands">${html}</div>`;
}

// The links the thing being read runs along — a pathway's own steps, or every
// link a trace reaches. paintAtlas lights them; paintFlow has to know about
// them too, so it is written once here rather than twice there.
function highlightLinks(): Set<any> | null {
  if (drawn()) {
    const out = new Set<any>();
    for (const path of drawn()!) {
      for (let i = 0; i + 1 < path.length; i++) out.add(path[i] + "\u0000" + path[i + 1]);
    }
    return out;
  }
  const t = trace();
  return t ? t.links : null;
}

function paintAtlas(repanel = true) {
  const svg = svgEl();
  if (!svg || !WORLD) return;
  // ONE thing lights the picture: what is being read. There used to be a second
  // — the last circle clicked, held on its own — which lit itself, made every
  // link TOUCHING it hot whether or not that link was on any pathway being
  // drawn, and exempted its neighbours from the dimming. It was a survivor from
  // when clicking a circle meant "select this one element", it did not update
  // when you pointed at something else, and it only ever tracked the last
  // circle of a trail. So pointing anywhere left a ghost of the last circle
  // clicked: bright links and undimmed circles belonging to nothing on screen.
  //
  // What is left of it is one case a pathway cannot cover: a box asked about
  // from the movers list when nothing has moved, so there is no run to trace
  // and no route to draw. That box is still worth picking out where it stands.
  const lone = R.trace && !trace() ? R.trace : null;
  // A strand lights every element along it and every link between them. `.on`
  // already means "full strength, and named", so the strand gets its labels
  // and everything off it recedes, with no new rules to write.
  // A pathway and a trace light the picture the same way — a set of elements
  // and the links between them — so they share the machinery.
  const t = trace();
  const onStrand = drawn() ? strandLit() : (t ? t.els : null);
  // Cut at the same place the ribbons are, so the highlight ENDS where the
  // effect does. Left uncut, a route whose middle was cut still lit its later
  // steps — they carry something, just not anything from here — and a hot
  // segment floating downstream of the stop is a worse read than the gap this
  // all started with.
  const strandLinks = routeLinks();
  // Where the change came in: the sliders that moved, as circles, and only the
  // ones this run actually reached.
  const traceStarts = new Set<any>(trace()
    ? changedInputIds().map(elementOfBox).filter((el: any) => el && trace()!.els.has(el))
    : []);
  svg.classList.toggle("busy", !!lone || !!onStrand);
  svg.classList.toggle("traced", !!trace());
  svg.classList.toggle("inside", !!R.inside);

  for (const g of svg.querySelectorAll("g.n")) {
    const id = g.dataset.el;
    g.classList.toggle("on", id === lone || (!!onStrand && onStrand.has(id)));
    // The two ENDS of a traced run keep their names while the middle of it goes
    // quiet: the box asked about, and the input the change started at. A run
    // named only at its far end says what arrived without saying what set off,
    // and the whole point of a trace is the pair — this much went in there,
    // this much came out here. See the .traced rule in the stylesheet.
    g.classList.toggle("ends", !!trace() && (id === traceEl() || traceStarts.has(id)));
    g.classList.toggle("focus", id === R.inside);
  }
  // Hot means "on the route being read", and nothing else. It used to also mean
  // "touching the circle you last clicked", which is how three links out of a
  // circle nobody was looking at stayed lit while the pointer was somewhere
  // else entirely.
  for (const p of svg.querySelectorAll(".fl"))
    p.classList.toggle("hot",
      !!strandLinks && strandLinks.has(p.dataset.a + "\u0000" + p.dataset.b));
  setScale();
  refreshAtlasValues();
  paintWheel();
  // Pointing repaints the picture and leaves the list alone: the row under the
  // pointer would be replaced mid-hover, and the pointer would come to rest on
  // a different row than the one it was sent to.
  if (repanel) renderInspector();
}

// ───── One thing at a time ────────────────────────────────────────────────
// A circle, a box's row in the movers list, a destination heading and a pathway
// row are four ways of asking the same question — "explain this one" — and each
// answers it by lighting a run of circles. Two of them held at once put two
// answers in the picture with nothing to say which lit what, so taking one lets
// go of the others.
//
// R.root and drawn() are the one pair that is NOT a conflict: the pathway list
// is filtered `through: R.root`, so every pathway on offer already runs through
// the selected circle. Picking one is reading further into that selection, not
// starting a second one — and clearing R.root there would re-filter the list
// out from under the row just clicked.
function dropTrace() { R.traceKey = null; R.trace = null; }

// Picking a circle asks "what runs through here, and where does it come out".
// The list narrows to those pathways — the outputs on the far side of it — and
// the top row of the list becomes the circle, so the picture and the panel are
// naming the same thing. Picking it again lets go, which is the same rule as
// clicking the chosen row.
// Clicking a circle OPENS rows; it does not hold them open. The expansion used
// to be worked out afresh on every render from the circles picked, which meant
// it overruled the reader: a row open because a circle put it there could not
// be closed, because the next render opened it again. So the circles seed the
// open set once, and from then on the rows are the reader's — one source of
// truth for what is open, and it is the same one whoever opened it.
function seedOpenForRoots(): void {
  R.open = [];
  R.current = [];
  if (!R.roots.length) return;
  for (const d of forkTree()) {
    if (!holds(d, R.roots)) continue;
    // Down to the row the circle is ON, and no further: opening past it would
    // be answering a question nobody asked. That is the row's PARENT, since a
    // row is open when something below it is.
    const path = [d.via].concat(chainTo(d, R.roots).map(f => f.via)).slice(0, -1);
    if (path.length) R.open.push(path);
  }
}

function selectEl(id: any) {
  if (R.inside && id !== R.inside) leaveTangle(true);
  R.roots = rootsAfterClicking(id);
  seedOpenForRoots();
  dropTrace();
  WHEEL_PICK = null; PICK_FROM_WHEEL = false;
  syncStrandToOpen(true);
}

// Getting inside a tangle is now a change of PICTURE and nothing else — the
// panel is the same list it was, with the tangle as its top row. It used to
// swap the panel for a page of loop cards with no way onward, which is what
// made a tangle feel like somewhere else rather than somewhere on the way.
function enterTangle(id: any, then?: () => void) {
  if (R.inside === id) { if (then) then(); return; }
  stopTour();
  R.inside = id; R.roots = [id]; WHEEL_PICK = null; WHEEL_LOOP = 0;
  PICK_FROM_WHEEL = false;
  seedOpenForRoots();
  WHEEL_TANGLE = WORLD.A.nodes.get(id).tangles[0];
  paintAtlas();
  zoomTo(frameOn(id), then || playTour);
}

function leaveTangle(quiet: any) {
  if (!R.inside) return;
  stopTour();
  const svg = svgEl();
  if (svg) { const tr = svg.querySelector("g.n.focus .trace"); if (tr) tr.innerHTML = ""; }
  R.inside = null; WHEEL_PICK = null; PICK_FROM_WHEEL = false;
  if (!quiet) R.roots = [];
  paintAtlas();
  if (!quiet) zoomTo(wholePicture());
}

// ---------------------------------------------------------------------------
// THE TOUR — every loop in the tangle, one after another, left on screen
// ---------------------------------------------------------------------------
// Entering a tangle plays its loops through: each draws itself round, then
// stays, faded, while the next one draws. What builds up is the answer to the
// question a list of loops cannot answer — how they sit on top of each other.
// ---------------------------------------------------------------------------
function stopTour() {
  cancelAnimationFrame(tourRAF);
  tourRAF = 0; tourAt = -1;
}

function tourLoops() {
  const w = WHEELS.get(R.inside);
  if (!w) return [];
  return [...w.loops].sort((a, b) => b.gain - a.gain || a.cycle.length - b.cycle.length)
    .slice(0, TOUR_MAX);
}

function playTour() {
  if (!R.inside) return;
  stopTour();
  const svg = svgEl();
  const g = svg && svg.querySelector("g.n.focus .trace");
  const w = WHEELS.get(R.inside);
  if (!g || !w) return;
  const loops = tourLoops();
  if (!loops.length) { renderInspector(); return; }

  g.innerHTML = loops.map((l, i) => `<g class="tl" data-i="${i}">${
    l.links.map((e: any) => {
      const [x1, y1] = w.at.get(e.from), [x2, y2] = w.at.get(e.to);
      const backwards = w.pos.get(e.to) <= w.pos.get(e.from);
      return `<path d="${chordPath(x1, y1, x2, y2, w.centre[0], w.centre[1], backwards ? 0.22 : 0.3)}"
        stroke="${l.reinforcing ? "var(--c1)" : "var(--c2)"}"></path>`;
    }).join("")}</g>`).join("");

  const groups = [...g.querySelectorAll("g.tl")];
  const lens = groups.map(gg => [...gg.querySelectorAll("path")].map(p =>
    typeof p.getTotalLength === "function" ? p.getTotalLength() : 0));
  groups.forEach((gg, i) => [...gg.querySelectorAll("path")].forEach((p, j) => {
    p.style.strokeDasharray = lens[i][j];
    p.style.strokeDashoffset = lens[i][j];
  }));

  if (reduced()) {
    groups.forEach(gg => {
      gg.classList.add("done");
      [...gg.querySelectorAll("path")].forEach(p => { p.style.strokeDashoffset = 0; });
    });
    tourAt = loops.length;
    renderInspector();
    return;
  }

  const DRAW = 620, HOLD = 260, PER = DRAW + HOLD;
  const t0 = performance.now();
  const tick = (now: any) => {
    const t = now - t0;
    const i = Math.min(loops.length - 1, Math.floor(t / PER));
    if (i !== tourAt) { tourAt = i; renderInspector(); }
    groups.forEach((gg, gi) => {
      const local = (t - gi * PER) / DRAW;
      const f = Math.max(0, Math.min(1, local));
      gg.classList.toggle("done", local >= 1);
      gg.classList.toggle("live", local >= 0 && local < 1);
      [...gg.querySelectorAll("path")].forEach((p, j) => {
        const per = 1 / lens[gi].length;
        const fj = Math.max(0, Math.min(1, (f - j * per) / per));
        p.style.strokeDashoffset = (lens[gi][j] * (1 - fj)).toFixed(2);
      });
    });
    if (t < loops.length * PER) { tourRAF = requestAnimationFrame(tick); return; }
    groups.forEach((gg, gi) => {
      gg.classList.remove("live"); gg.classList.add("done");
      [...gg.querySelectorAll("path")].forEach(p => { p.style.strokeDashoffset = 0; });
    });
    tourAt = loops.length; tourRAF = 0;
    renderInspector();
  };
  tourRAF = requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------
// THE INSPECTOR — one place for whatever is being looked at
// ---------------------------------------------------------------------------
export function atlasPanelHtml(): string {
  if (!WORLD) return "";
  const A = WORLD.A, start = labelOf(A.start);

  // ONE panel. It used to be three — the run, a picked circle's own page, and a
  // tangle's own page — each with its own title, its own numbers and its own
  // body, and picking anything swapped between them. The tangle one dropped the
  // pathway list altogether, so getting inside a tangle meant losing every way
  // out of it; that is what made tangles feel like a different application.
  //
  // Now the title never moves and the list never leaves. What is picked is a
  // ROW in that list, and everything a picked circle has to say — its share,
  // the boxes it stands for, the loops it contains — is a level underneath it.
  // There is no prose: the picture teaches itself, and the space belongs to the
  // thing the picture cannot say.
  return `<div class="ins">
      <header><b>Atlas of ${escapeHtml(start)}</b><span class="m">${
        A.elements} elements · ${formatCount(A.shapes)} readings</span></header>
      ${runEffectHtml() + pathwaysLabel() + strandsHtml()}</div>`;
}

// The tangle an element contains, if it is one. A circle can stand for a knot
// of boxes that feed back into each other; that knot is what its loops belong
// to.
function tangleOf(el: any): any {
  if (!el || !ATLAS || !ATLAS.nodes.has(el)) return null;
  const node = ATLAS.nodes.get(el);
  return node.tangles && node.tangles.length ? node.tangles[0] : null;
}

// Every loop in this tangle, once each. The wheel knows one loop per link that
// runs back; the tangle's own analysis adds the shortest way round each box.
// A reader wants the union of both, deduped, strongest first.
function tangleLoops(el: any = R.inside): any[] {
  const t = tangleOf(el);
  if (!t) return [];
  if (!WHEELS.has(el)) WHEELS.set(el, wheelOf(t));
  const w = WHEELS.get(el);
  if (!w) return [];
  const all: any[] = [], seen = new Set<any>();
  for (const l of [...t.loops, ...w.loops]) {
    const k = canonicalCycle(l.cycle);
    if (seen.has(k)) continue;
    seen.add(k);
    all.push(l);
  }
  return all.sort((a, b) => b.gain - a.gain || a.cycle.length - b.cycle.length);
}

// One line per loop: which way it runs, the boxes it goes through, and how
// strong it is. The wheel beside it is the drawing — a second, smaller drawing
// in the list was saying the same shape twice, and cost five times the height.
// A real <button> rather than a div with role=button, so Enter and Space work
// without a keydown handler of our own.
function loopCard(loop: any, i: number, drawn: boolean, related: boolean): string {
  const names = loop.cycle.map((id: any) => boxLabel(id));
  // Whole names, and one ellipsis at the end of the row rather than one per
  // box. Cutting every name to a fixed width made a run of stumps — "Attempts
  // after … › Goods tha…" — where nothing was readable and the shape of the
  // loop was gone anyway. Now the first box is always legible, you read as many
  // more as fit, and the browser ends the line.
  const chain = names.map((nm: string, j: number) =>
    (j ? `<i>\u203a</i>` : "") + escapeHtml(nm)).join("");
  const kind = loop.reinforcing ? "Reinforcing" : "Balancing";
  return `<button type="button" class="loopcard ${loop.reinforcing ? "r" : "b"}${
      drawn ? " sel" : ""}${related && !drawn ? " rel" : ""}"
      data-loopidx="${i}" aria-pressed="${drawn}"
      aria-label="${kind} loop through ${loop.cycle.length} ${
        plural(loop.cycle.length, "box", "boxes")}: ${
        escapeHtml(names.join(", then "))}. Follow it round the wheel.">
    <span class="pol">${loop.reinforcing ? "R" : "B"}</span>
    <span class="lbl">${chain}</span>
    <span class="m">${loop.gain < 0.0005 ? "\u22480" : loop.gain.toFixed(3)}</span></button>`;
}

// Clicking a card draws that loop. The wheel already knows how to draw "the
// Nth loop through box B", so a card resolves itself into that rather than
// carrying a second, parallel idea of what is selected.
function selectLoopCard(i: number) {
  const loop = tangleLoops()[i];
  if (!loop) return;
  const box = loop.cycle[0];
  WHEEL_PICK = box;
  PICK_FROM_WHEEL = false;
  const k = canonicalCycle(loop.cycle);
  const at = loopsThrough(box).findIndex((l: any) => canonicalCycle(l.cycle) === k);
  WHEEL_LOOP = at >= 0 ? at : 0;
  paintAtlas();
}

function paintWheel() {
  const svg = svgEl();
  if (!svg) return;
  const g = R.inside && svg.querySelector("g.n.focus");
  if (!g) return;
  const w = WHEELS.get(R.inside);
  if (!w) return;
  const picked = WHEEL_PICK && w.pos.has(WHEEL_PICK) ? WHEEL_PICK : null;
  g.classList.toggle("picked", !!picked);

  const through = picked ? loopsThrough(picked) : [];
  const loop = through.length ? rotateTo(through[WHEEL_LOOP % through.length], picked) : null;
  const onCycle = new Set<any>(loop ? loop.cycle : picked ? [picked] : []);
  const key = (e: any) => e.from + "" + e.to;
  const onLink = new Set<any>((loop ? loop.links : []).map(key));
  if (picked) for (const e of w.touching.get(picked) || []) onLink.add(key(e));

  for (const el of g.querySelectorAll(".ch")) el.classList.toggle("on", onLink.has(el.dataset.k));
  for (const el of g.querySelectorAll(".nd")) {
    const mine = el.dataset.box === picked;
    el.classList.toggle("on", onCycle.has(el.dataset.box));
    el.classList.toggle("sel", mine);
  }
  g.querySelector(".labs").innerHTML = picked ? wheelLabels(picked, [...onCycle]) : "";

  const trace = g.querySelector(".trace");
  if (picked) {
    trace.innerHTML = `<g class="tl live">${(loop ? loop.links : []).map((e: any) => {
      const [x1, y1] = w.at.get(e.from), [x2, y2] = w.at.get(e.to);
      const backwards = w.pos.get(e.to) <= w.pos.get(e.from);
      return `<path d="${chordPath(x1, y1, x2, y2, w.centre[0], w.centre[1], backwards ? 0.22 : 0.3)}"
        stroke="${loop && loop.reinforcing ? "var(--c1)" : "var(--c2)"}"></path>`;
    }).join("")}</g>`;
    runTrace(trace);
  } else if (!tourRAF && tourAt < 0) {
    trace.innerHTML = "";
  }
}

// Names on adjacent rim positions overprint, so they are spaced — and the box
// being explained is always one of them.
function wheelLabels(picked: any, cycle: any) {
  const w = WHEELS.get(R.inside);
  if (!w || !w.at) return "";
  const n = w.order.length, apart = Math.max(2, Math.round(n / 30));
  const out = [picked];
  for (const b of cycle) {
    if (out.length >= 9) break;
    if (out.some(o => Math.abs(w.pos.get(o) - w.pos.get(b)) < apart)) continue;
    out.push(b);
  }
  return out.map(b => {
    const p = w.at.get(b);
    if (!p) return "";
    const a = p[2], lx = w.centre[0] + (w.radius + 6) * Math.cos(a),
          ly = w.centre[1] + (w.radius + 6) * Math.sin(a);
    const left = Math.cos(a) < -0.08;
    return `<text class="bl" x="${lx.toFixed(1)}" y="${(ly + 3).toFixed(1)}"
      text-anchor="${left ? "end" : Math.cos(a) > 0.08 ? "start" : "middle"}"
      >${escapeHtml(clip(boxLabel(b), 24))}</text>`;
  }).join("");
}

function loopsThrough(box: any) {
  const w = WHEELS.get(R.inside);
  if (!w) return [];
  const all: any[] = [], seen = new Set<any>();
  // Two sets of loops, both worth having: the one each back link closes, which
  // is what the chords ARE, and the shortest loop through each box, which is
  // what a reader asking "how does this come round" actually wants.
  for (const l of [...(WHEEL_TANGLE ? WHEEL_TANGLE.loops : []), ...w.loops]) {
    const k = canonicalCycle(l.cycle);
    if (seen.has(k) || !l.cycle.includes(box)) continue;
    seen.add(k);
    all.push(l);
  }
  return all.sort((a, b) => a.cycle.length - b.cycle.length || b.gain - a.gain);
}

// A loop has no beginning, but an explanation does: the reader asked about THIS
// box, so the story starts and ends there.
function rotateTo(loop: any, box: any) {
  const i = loop.cycle.indexOf(box);
  if (i <= 0) return loop;
  return { ...loop,
    cycle: loop.cycle.slice(i).concat(loop.cycle.slice(0, i)),
    links: loop.links.slice(i).concat(loop.links.slice(0, i)) };
}

// The loop draws itself, link by link, and starts again. Watching the line come
// back round is the part a still picture cannot do — so if the reader has asked
// for less motion, the whole loop is simply drawn at once instead.
function runTrace(g: any) {
  cancelAnimationFrame(traceRAF);
  const paths = [...g.querySelectorAll("path")];
  if (!paths.length || typeof paths[0].getTotalLength !== "function") return;
  const lens = paths.map(p => p.getTotalLength());
  paths.forEach((p, i) => { p.style.strokeDasharray = lens[i]; });
  if (reduced()) {
    paths.forEach(p => { p.style.strokeDashoffset = 0; });
    return;
  }
  const STEP = 340, HOLD = 900, total = paths.length * STEP + HOLD;
  const t0 = performance.now();
  const tick = (now: any) => {
    const t = (now - t0) % total;
    paths.forEach((p, i) => {
      const f = Math.max(0, Math.min(1, (t - i * STEP) / STEP));
      p.style.strokeDashoffset = (lens[i] * (1 - f)).toFixed(2);
    });
    traceRAF = requestAnimationFrame(tick);
  };
  traceRAF = requestAnimationFrame(tick);
}

function pickWheelBox(box: any) {
  stopTour();
  WHEEL_PICK = box && box !== WHEEL_PICK ? box : null;
  WHEEL_LOOP = 0;
  PICK_FROM_WHEEL = !!WHEEL_PICK;
  paintAtlas();
}


// ---------------------------------------------------------------------------
// WHAT SIMULATION IS DOING
// ---------------------------------------------------------------------------
// WHAT THE SIMULATION IS DOING
// ---------------------------------------------------------------------------
// Structure is what the atlas is FOR — how much of everything runs through a
// place. While the sliders are out, colour says what the run did to that place:
// green / red where the boxes carry a direction of merit (the map's own good
// and bad), amber where they do not — it moved, and the map has no view on
// whether that is good news. The size never changes; that would be two
// different measures fighting over one circle.
//
// The strength of the colour is measured against the biggest mover on the WHOLE
// map (maxEffectPct), which is the same scale the map's own boxes use — so a
// circle here and a box there at the same strength moved by the same amount.
// ---------------------------------------------------------------------------

interface BoxMove { id: string; label: string; pct: number }

interface ElementEffect {
  /** Average % move across the boxes here that carry a number. */
  pct: number;
  moved: boolean;
  /** 0..1 against the biggest mover on the map. */
  strength: number;
  merit: "good" | "bad" | "none";
  /** Every box here that has a number, biggest mover first. */
  boxes: BoxMove[];
}

const EMPTY_EFFECT: ElementEffect = { pct: 0, moved: false, strength: 0, merit: "none", boxes: [] };

// The move on a list of boxes, as one answer. An element can hold boxes that
// disagree about which way is better, and a single colour cannot honestly
// answer for both — so merit colouring is used only where they agree, and
// everything else is amber.
function movesOf(boxIds: string[]): ElementEffect {
  const moves: BoxMove[] = [];
  let sum = 0;
  for (const boxId of boxIds) {
    const box = nodeById[boxId];
    if (!box || box.baseline === undefined || box.baseline === null || !box.baseline) continue;
    const pct = formatNodeDelta(boxId).pct;
    if (!Number.isFinite(pct)) continue;
    moves.push({ id: boxId, label: boxLabel(boxId), pct: pct });
    sum += pct;
  }
  if (!moves.length) return EMPTY_EFFECT;
  moves.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
  const pct = sum / moves.length;
  const moved = Math.abs(pct) >= EFFECT_FLOOR_PCT;
  const top = maxEffectPct();
  const strength = moved && top > 0 ? Math.pow(Math.min(1, Math.abs(pct) / top), 0.6) : 0;

  // An element that has not really moved has no merit to report — "flat" is a
  // thing a CONTRIBUTION can be, not a thing an element is.
  const m = moved ? shareMerit(pct, agreedDirection(boxIds)) : "none";
  const merit: ElementEffect["merit"] = m === "flat" ? "none" : m;
  return { pct: pct, moved: moved, strength: strength, merit: merit, boxes: moves };
}

// An element can hold boxes that disagree about which way is better, and one
// colour cannot honestly answer for both — so a direction is only used when
// they agree on it.
function agreedDirection(boxIds: string[]): string | undefined {
  const dirs = new Set(boxIds.map(b => nodeById[b] && nodeById[b].direction).filter(Boolean));
  return dirs.size === 1 ? ([...dirs][0] as string) : undefined;
}

// The colour a number takes: the merit its box would carry if it had moved by
// this much. Unlike meritOf there is no floor — a small CONTRIBUTION is still a
// contribution, not a box that failed to move — so a route pulling the other
// way shows in the opposite colour, which is the whole reason for splitting a
// total into routes at all.
type Merit = "good" | "bad" | "none" | "flat";

function shareMerit(share: number, direction: string | undefined): Merit {
  if (!share) return "flat";
  if (direction === "higher_better") return share > 0 ? "good" : "bad";
  if (direction === "lower_better")  return share > 0 ? "bad"  : "good";
  return "none";
}

function elementEffect(id: any): ElementEffect {
  const node = ATLAS && ATLAS.nodes.get(id);
  return node ? movesOf(node.boxes) : EMPTY_EFFECT;
}

// The circles are chrome on a themed picture rather than chips carrying their
// own text, so unlike the map's box fills these follow the theme.
const MERIT_HUE: Record<string, string> = {
  good: "var(--status-good)",
  bad:  "var(--status-bad)",
  none: "var(--accent-amber)",
};

const effectFill = (merit: string, strength: number): string =>
  `color-mix(in srgb, ${MERIT_HUE[merit] || MERIT_HUE.none} ${
    Math.round(22 + 78 * Math.max(0, Math.min(1, strength)))}%, var(--border-strong))`;

// Recolour without rebuilding: a slider drag calls this many times a second.
// Every circle is repainted, not just the ones that moved — the ramp is
// measured against the biggest mover, so one box running away restates the
// colour of everything else.
export function refreshAtlasValues(): void {
  const svg = svgEl();
  if (!svg || !ATLAS) return;
  const simulating = !!state.simulationMode;
  svg.classList.toggle("simulating", simulating);
  // Worked out once for the frame, not once per circle — it is one pass over
  // the whole picture.
  const shares = simulating ? strandShares() : null;

  for (const g of svg.querySelectorAll("g.n")) {
    const el = g as HTMLElement;
    if (!simulating) {
      el.classList.remove("flat");
      el.style.removeProperty("--simfill");
      setMag(el, EMPTY_EFFECT);
      continue;
    }
    const effect = elementEffect(el.dataset.el);
    el.classList.toggle("flat", !effect.moved);
    if (effect.moved) el.style.setProperty("--simfill", effectFill(effect.merit, effect.strength));
    else el.style.removeProperty("--simfill");
    setMag(el, effect, shares);
  }

  // Inside a tangle the rim dots are the boxes themselves, so they carry their
  // own move rather than the wheel's average.
  for (const c of svg.querySelectorAll("circle.nd")) {
    const dot = c as unknown as SVGElement & { dataset: DOMStringMap; style: CSSStyleDeclaration };
    if (!simulating) { dot.style.removeProperty("--simfill"); continue; }
    const effect = nodeEffect(dot.dataset.box || "");
    if (effect.moved) dot.style.setProperty("--simfill", effectFill(effect.merit, effect.strength));
    else dot.style.removeProperty("--simfill");
  }

  // Which links are carrying anything changes with every solve, so this belongs
  // on the per-frame path rather than on the rebuild — a slider drag reaches
  // here and never touches paintAtlas.
  paintFlow(svg);
}

// The number beside the name. Written on every circle whether it is lit or not
// — the label it lives in is invisible until the circle is lit or pointed at,
// so writing them all costs nothing and saves deciding, on a path that runs
// many times a second while a slider is dragged, which ones are about to be
// looked at. An element standing for several boxes reads as the average of
// them, the same figure its tooltip and its row in the list report.
function setMag(g: HTMLElement, effect: ElementEffect,
                shares?: Map<any, StrandShare> | null): void {
  const t = g.querySelector("tspan.mag") as SVGElement | null;
  if (!t) return;
  // Reading one pathway, a circle on it says what THAT pathway carried — the
  // same figure the row in the panel prints. Off it, or with none picked, it
  // says what the whole run did.
  const share = shares ? shares.get(g.dataset.el) : null;
  if (carries(share)) {
    t.textContent = (share!.exact ? "" : "~") + signed(share!.pct);
    t.setAttribute("class", "mag " + meritOfElement(g.dataset.el, share!.pct));
    g.classList.remove("held");
    return;
  }
  if (state.simulationMode && effect.moved) {
    t.textContent = signed(effect.pct);
    t.setAttribute("class", "mag " + effect.merit);
    g.classList.remove("held");
    return;
  }
  // Where a mover prints its size, a held box prints what is holding it. The
  // number would be "0.0%", which is true and says nothing.
  const gate = heldBy(g.dataset.el);
  g.classList.toggle("held", !!gate);
  t.textContent = gate ? "held by " + clip(gate.label, 22) : "";
  t.setAttribute("class", "mag" + (gate ? " hold" : ""));
}

// ───── Held back ──────────────────────────────────────────────────────────
// An element stands for one or more boxes. It is HELD when it did not move and
// one of its boxes is being gated by something that did not move either — see
// gatedBy() in the engine. What holds it is named, because "this one is stuck"
// is only half an answer; the other half is what to move instead.
function heldBy(id: any): { label: string } | null {
  const node = ATLAS && ATLAS.nodes.get(id);
  if (!node || !state.simulationMode) return null;
  if (elementEffect(id).moved) return null;
  for (const boxId of node.boxes) {
    const gate = gatedBy(boxId);
    if (gate) return { label: gate.label };
  }
  return null;
}

// Every element the run STOPS at. A gate is the case worth marking, but it is
// not the only one: a box that did not move cannot have passed anything on,
// whatever the structure says. The commonest of these is not a gate at all —
// it is one of your own sliders, sitting where you left it. Border Force FTE
// feeds Vehicle Physical Search, which feeds Lorry Wait Times; move the first
// and the middle one does not budge, because it is pinned at 100% by the
// slider, so the last one hears nothing. Drawing that route through implied a
// path from the first to the last that does not exist.
//
// Recomputed per frame — a slider drag can free one or catch another.
function blockedElements(): Set<any> {
  const out = new Set<any>();
  if (!ATLAS || !state.simulationMode) return out;
  for (const id of ATLAS.nodes.keys()) {
    if (id !== END && !elementEffect(id).moved) out.add(id);
  }
  return out;
}

// A blocked box passes nothing on, so the picture stops there: the route is
// drawn up TO it and no further. That absence is the point — it is the run
// saying, in the one channel that cannot be misread, that these outputs are not
// reachable by what you moved. What ARRIVES is still drawn, at a hairline: the
// change does reach the box, and a route cut off at its own source would look
// like the picture had simply failed to draw it.
//
// An element is only cut once EVERY route-link into it has been cut. On a
// trace, a box fed by a blocked route and a live one is still fed.
function cutAfterBlocks(keep: Set<any> | null): Set<any> | null {
  if (!keep || !keep.size) return keep;
  const blocked = blockedElements();
  if (!blocked.size) return keep;

  const out = new Set<any>(keep);
  const feeds = new Map<any, number>();
  for (const key of out) {
    const b = String(key).split("\u0000")[1];
    feeds.set(b, (feeds.get(b) || 0) + 1);
  }
  const cut = [...blocked];
  while (cut.length) {
    const from = cut.pop();
    for (const key of [...out]) {
      const [a, b] = String(key).split("\u0000");
      if (a !== String(from)) continue;
      out.delete(key);
      const left = (feeds.get(b) || 1) - 1;
      feeds.set(b, left);
      if (left <= 0) cut.push(b);
    }
  }
  return out;
}


// ───── What ONE pathway carried, box by box ───────────────────────────────
// A circle's percentage is what the whole run did to that box. While a pathway
// is being read that is the wrong number: the panel row said this route carried
// +5.1% to Trade-Driven GDP Growth and the circle at the end of it said +5.8%,
// which is the total across all eight ways in. Two numbers for one thing on one
// screen, and the one on the picture was answering a question nobody had asked.
//
// The split is the same log-space identity the panel's rows use, so the circle
// at the end of a pathway now prints exactly what the row does. For a box b on
// the route:
//
//   share(b) = gain of the route so far ÷ gain of EVERY route into b
//
// and the box's own move is apportioned by it. up(b) is the same sum the
// contributions are measured against — one DP over the picture in depth order,
// which is a topological order because a link always runs from a lower depth to
// a higher one.
//
// EXACTNESS. Taking logs turns the multiplicative rule into a sum, so for a box
// whose inputs multiply, the routes into it add up EXACTLY and this is an
// identity. Through `min`, `additive` or a formula they do not: the gain is a
// linearisation and the split is a proportion, not a fact. Marked with a
// leading ~ when any box on the route so far is one of those — this map is
// formula-heavy, and a figure on a picture reads as exact unless it says
// otherwise.
function splitIsExact(el: any): boolean {
  const node = ATLAS && ATLAS.nodes.get(el);
  if (!node) return false;
  // A tangle is a contracted cycle: its "gain" is the strongest link across a
  // knot of them, which is a summary and never an identity.
  if (node.loop) return false;
  return node.boxes.every((boxId: string) => {
    const rule = explainNode(boxId)?.rule;
    return rule === "multiplicative" || rule === "baseline";
  });
}

// Σ, over every route from something the reader moved to n, of the route's gain.
// The denominator each contribution is a share OF.
function upWeights(): Map<any, number> {
  const up = new Map<any, number>();
  if (!ATLAS || !WORLD) return up;
  const depth = WORLD.M.depth;
  const sources = new Set<any>(changedInputIds().map(elementOfBox).filter(Boolean));
  const els = [...ATLAS.nodes.keys()]
    .filter((id: any) => id !== END)
    .sort((a: any, b: any) => (depth.get(a) || 0) - (depth.get(b) || 0));
  for (const n of els) {
    let v = sources.has(n) ? 1 : 0;
    for (const p of ATLAS.pred.get(n) || []) {
      if (p === END) continue;
      v += (up.get(p) || 0) * pairGain(p, n);
    }
    up.set(n, v);
  }
  return up;
}

interface StrandShare { pct: number; exact: boolean }

// Below this a share PRINTS as "0.0%", and a circle saying 0.0% is a circle
// claiming to be part of a run it had no part in. The number is the printing
// threshold rather than the moved-or-not one: a route that carried 0.1% did
// carry something, and saying so is the whole point of splitting them up.
const CARRIES = 0.05;
const carries = (share: StrandShare | null | undefined): boolean =>
  !!share && Math.abs(share.pct) >= CARRIES;

// The circles a picked pathway actually reached. The rest of its route is still
// structurally there — hover any of it — but a circle lit as part of a run it
// contributed nothing to, printing 0.0% beside its name, is the picture padding
// the story out with boxes that are not in it.
//
// The exception is a box the change was STOPPED at. It carries nothing by
// definition and it is the most informative circle on the route: it says where
// this pathway ends, and what to move instead.
//
// Written once and read by both painters. They used to decide separately, and
// a ribbon drawn to a circle the other one had stopped lighting is exactly the
// kind of disagreement neither of them can see.
function strandLit(): Set<any> | null {
  if (!drawn()) return null;
  const shares = strandShares();
  return new Set<any>(drawn()!.flat().filter((id: any) =>
    !shares || carries(shares.get(id)) || !!heldBy(id)));
}

// The links of the route being read, after both cuts: at whatever stopped the
// change, and at whatever it never reached.
function routeLinks(): Set<any> | null {
  const links = cutAfterBlocks(highlightLinks());
  const lit = strandLit();
  if (!links || !lit) return links;
  return new Set<any>([...links].filter((key: any) => {
    const [a, b] = String(key).split("\u0000");
    return lit.has(a) && lit.has(b);
  }));
}

// Good or bad is a property of the BOX, not of the share — a route pulling a
// "lower is better" box down is good news however small its part in it was.
function meritOfElement(el: any, pct: number): string {
  const node = ATLAS && ATLAS.nodes.get(el);
  return node ? meritOf(pct, agreedDirection(node.boxes)) : "none";
}

function strandShares(): Map<any, StrandShare> | null {
  if (!drawn() || !state.simulationMode || !ATLAS || !WORLD) return null;
  const paths = drawn()!;
  const start = paths[0] && paths[0][0];
  if (!start) return null;

  // The picked row's own routes: which circles they touch, and which links.
  const els = new Set<any>(paths.flat());
  const links = new Set<string>();
  for (const path of paths) {
    for (let i = 0; i + 1 < path.length; i++) links.add(path[i] + "\u0000" + path[i + 1]);
  }

  // Same DP as up(), but walking ONLY the picked row's links: how much of what
  // reaches each circle came by this row. A row standing for four routes counts
  // all four, which is what its percentage in the panel counts.
  const depth = WORLD.M.depth;
  const order = [...els].filter(id => id !== END)
    .sort((a: any, b: any) => (depth.get(a) || 0) - (depth.get(b) || 0));
  const mine = new Map<any, number>();
  const exact = new Map<any, boolean>();
  for (const n of order) {
    let v = n === start ? 1 : 0;
    let ex = n === start ? true : splitIsExact(n);
    for (const p of ATLAS.pred.get(n) || []) {
      if (!links.has(p + "\u0000" + n)) continue;
      v += (mine.get(p) || 0) * pairGain(p, n);
      if (!exact.get(p)) ex = false;
    }
    mine.set(n, v);
    exact.set(n, ex);
  }

  const up = upWeights();
  const out = new Map<any, StrandShare>();
  for (const n of order) {
    const total = up.get(n) || 0;
    const share = total !== 0 ? (mine.get(n) || 0) / total : (n === start ? 1 : 0);
    out.set(n, { pct: elementEffect(n).pct * share, exact: !!exact.get(n) });
  }

  // The destination is the one circle whose figure is ALSO printed in the panel,
  // and the panel's is rounded so that a column of contributions adds up to the
  // total above it. Taking that exact figure rather than re-deriving it keeps
  // the two from ever differing by the last decimal place.
  const picked = drawn()!;
  const dest = picked[0][picked[0].length - 1];
  const printed = printedShare(dest);
  if (printed !== null && out.has(dest)) {
    out.set(dest, { pct: printed, exact: !!exact.get(dest) });
  }
  return out;
}

// What the panel prints for where you are in the list, if it prints anything.
// Taken from the same walk the list itself prints from, so the picture and the
// panel can never disagree by the last decimal place.
function printedShare(dest: any): number | null {
  const chain = openChain();
  if (!chain.length || chain[0].via !== dest) return null;
  return shareAtOpen(chain);
}

// ───── The effect, flowing ────────────────────────────────────────────────
// While a trace is up, a ribbon stops meaning "this many readings run through
// here" and starts meaning "this much of the picked box's change arrived by
// here". The atlas spends BOTH of its strong channels on structure — a circle's
// area and a ribbon's width are the same measure at two granularities — so
// thickness is the one that can be lent out without the structural picture
// collapsing. Area still says how much runs through.
//
// Worth the mode existing: on the border map the fattest ribbon in the picture
// carries none of the effect at all. Structure is not where the effect went.
//
// The arithmetic is the same log-space identity the panel's contributions use,
// aggregated per LINK instead of per route. Two passes over the traced
// subgraph, in depth order (a link always runs from a lower depth to a higher
// one, so depth order is a topological order):
//   up(n)   = Σ gains of every route from a moved slider to n
//   down(n) = Σ gains of every route from n to the picked box
//   flow(a→b) = up(a) × gain(a,b) × down(b),  as a share of up(target)
// The shares across any cut of the subgraph sum to 1, which is what makes the
// picture add up the way the list does.
export function traceLinkShares(): Map<string, number> | null {
  const at = traceEl();
  if (!trace() || !at || !WORLD || !ATLAS) return null;
  const depth = WORLD.M.depth;
  const T = trace()!;
  const els = [...T.els].sort(
    (a: any, b: any) => (depth.get(a) || 0) - (depth.get(b) || 0));
  const sources = new Set<any>(
    changedInputIds().map(elementOfBox).filter((el: any) => el && trace()!.els.has(el)));

  const up = new Map<any, number>();
  for (const n of els) {
    let v = sources.has(n) ? 1 : 0;
    for (const p of ATLAS.pred.get(n) || []) {
      if (T.els.has(p)) v += (up.get(p) || 0) * pairGain(p, n);
    }
    up.set(n, v);
  }

  const down = new Map<any, number>();
  for (let i = els.length - 1; i >= 0; i--) {
    const n = els[i];
    let v = n === at ? 1 : 0;
    for (const c of ATLAS.succ.get(n) || []) {
      if (T.els.has(c)) v += pairGain(n, c) * (down.get(c) || 0);
    }
    down.set(n, v);
  }

  const total = up.get(at) || 0;
  if (!total) return null;
  const out = new Map<string, number>();
  for (const key of T.links) {
    const at = key.indexOf("\u0000");
    const a = key.slice(0, at), b = key.slice(at + 1);
    out.set(key, ((up.get(a) || 0) * pairGain(a, b) * (down.get(b) || 0)) / total);
  }
  return out;
}

// Which links an effect is actually travelling along right now. Without a
// picked box there are no per-link shares to draw, but there is still a plain
// yes/no: a link carries the run if the effect can reach its start AND its end
// actually moved. Everything else is structure the run never touched, and while
// the sliders are out that is exactly what the reader does not want drawn — the
// atlas is otherwise a picture of every route the effect DIDN'T take.
//
// Returns null when not simulating (draw everything, as before) and an empty
// set when nothing has moved (draw nothing — the same blank slate the map shows
// on entering simulation, filling in as the sliders move).
function liveLinks(): Set<string> | null {
  if (!state.simulationMode || !ATLAS || !WORLD) return null;
  const sources = changedInputIds()
    .map(elementOfBox)
    .filter((el): el is string => el !== null && ATLAS.nodes.has(el));
  const live = new Set<string>();
  if (!sources.length) return live;

  // Reachable from something the user moved.
  const down = new Set<any>(sources), stack = [...sources];
  while (stack.length) {
    const id = stack.pop();
    for (const n of ATLAS.succ.get(id) || []) {
      if (n === END || down.has(n)) continue;
      down.add(n);
      stack.push(n);
    }
  }
  // One pass for "did this element move", not one per link.
  const moved = new Map<any, boolean>();
  const didMove = (id: any): boolean => {
    let had = moved.get(id);
    if (had === undefined) { had = elementEffect(id).moved; moved.set(id, had); }
    return had;
  };
  // A link is drawn when the change travelled it: its start moved, and so did
  // its end. The one exception is a GATE — a box the change reached and was
  // stopped at. It did not move, but the change arriving is exactly what is
  // being held back, and a held box with nothing visibly reaching it is a mark
  // with no story attached to it. So the arriving links are drawn; it is what
  // LEAVES a gate that is not (see cutAfterBlocks).
  for (const a of down) {
    if (!didMove(a)) continue;
    for (const b of ATLAS.succ.get(a) || []) {
      if (b === END || !down.has(b)) continue;
      if (!didMove(b) && !heldBy(b)) continue;
      live.add(a + "\u0000" + b);
    }
  }
  return live;
}

// Widths, applied to the live paths — the picture is not rebuilt for this.
function paintFlow(svg: any): void {
  // A picked box gives per-link shares, which are the finer answer; without one
  // the yes/no from liveLinks still keeps the dead structure off the picture.
  const shares = traceLinkShares();
  const live = shares ? null : liveLinks();
  // A route being read is drawn WHOLE. Some of its steps carry no measurable
  // magnitude of their own — a link into a box that barely moved, or one whose
  // part in the run is to hold a condition open rather than to push a number
  // along — and dropping those left the highlight with a hole in the middle of
  // it, which reads as "the route stops here" when the route does no such
  // thing. They are drawn at a hairline instead: still there, still lit, and
  // visibly carrying next to nothing.
  const keep = routeLinks();
  const HAIRLINE = 1.2;
  for (const p of svg.querySelectorAll(".fl")) {
    const path = p as unknown as SVGElement & { dataset: DOMStringMap };
    const key = path.dataset.a + "\u0000" + path.dataset.b;
    const structural = Number(path.dataset.w) || 1;
    const onRoute = !!keep && keep.has(key);

    if (shares) {
      const share = Math.abs(shares.get(key) || 0);
      path.classList.toggle("off", share <= 0 && !onRoute);
      if (share > 0) {
        // Never fatter than the circles it joins — a line as wide as its
        // endpoints stops being a line, the same guard the structural width uses.
        const rA = WORLD.rOf.get(path.dataset.a) || 8, rB = WORLD.rOf.get(path.dataset.b) || 8;
        const cap = Math.max(1.4, 0.85 * Math.min(rA, rB));
        path.setAttribute("stroke-width", Math.min(cap, 1.2 + share * 18).toFixed(2));
      } else if (onRoute) {
        path.setAttribute("stroke-width", String(HAIRLINE));
      }
      continue;
    }

    path.classList.toggle("off", !!live && !live.has(key) && !onRoute);
    path.setAttribute("stroke-width", String(
      !!live && !live.has(key) && onRoute ? HAIRLINE : structural));
  }
}

// ───── Saying it in the panel ─────────────────────────────────────────────
const MOVE_ROWS = 8;          // rows before the rest is summed up in a word
// The two sections of the run itself show only their strongest mover until
// asked for more. The list is sorted, so one row is the answer to "what did
// this run do" — the rest is the supporting detail, and it is one click away.
const HEADLINE_ROWS = 1;
// The boxes between the input and the outputs are a RANKING, not a fact — one
// row of it says almost nothing, and this is the only place an intermediate box
// gets a number of its own at all.
const ALONG_ROWS = 3;

const signed = (pct: number): string =>
  (Math.abs(pct) < 0.05 ? "" : pct > 0 ? "+" : "") + (Math.abs(pct) < 0.05 ? "0.0" : pct.toFixed(1)) + "%";

const meritOf = (pct: number, direction: string | undefined): string => {
  if (Math.abs(pct) < EFFECT_FLOOR_PCT) return "flat";
  if (direction === "higher_better") return pct > 0 ? "good" : "bad";
  if (direction === "lower_better")  return pct > 0 ? "bad"  : "good";
  return "none";
};

// ───── Pointing at a mover ────────────────────────────────────────────────
// Clicking a row in the movers list answers "how did the run reach this box":
// every circle and link lying on a route from a slider you MOVED to that box
// lights up, and the frame closes on the whole of it. The panel stays where it
// is — the point of the list is to be run down one row after another, and
// swapping to the element's own page on the first click would end that after
// one. It is a highlight, not a selection; R.root still belongs to the picture.


// The boxes the user is actually holding — a slider away from where it started.
// These are the premise of the whole run, which is why they get a section of
// their own above everything the run then did.
function changedInputIds(): string[] {
  const out: string[] = [];
  for (const id of Object.keys(state.userOverrides)) {
    const m = state.userOverrides[id];
    if (typeof m === "number" && Math.abs(m - 1) > 1e-9 && nodeById[id]) out.push(id);
  }
  return out;
}

const isChangedInput = (boxId: string): boolean => {
  const m = state.userOverrides[boxId];
  return typeof m === "number" && Math.abs(m - 1) > 1e-9;
};

// Everything on ANY route from a moved slider to `target`: forward-reachable
// from a source AND backward-reachable from the target is exactly "lies on some
// path between them". Null when nothing moved, or when nothing that moved can
// reach it — the caller then just lights the box on its own.
function traceTo(target: any): { els: Set<any>; links: Set<any> } | null {
  if (!ATLAS) return null;
  const sources = changedInputIds()
    .map(elementOfBox)
    .filter((el): el is string => el !== null && ATLAS.nodes.has(el));
  if (!sources.length) return null;

  const walk = (seeds: any[], next: (id: any) => any) => {
    const seen = new Set<any>(seeds), stack = [...seeds];
    while (stack.length) {
      const id = stack.pop();
      for (const n of next(id) || []) {
        if (n === END || seen.has(n)) continue;
        seen.add(n);
        stack.push(n);
      }
    }
    return seen;
  };
  const down = walk(sources, (id) => ATLAS.succ.get(id));
  if (!down.has(target)) return null;
  const up = walk([target], (id) => ATLAS.pred.get(id));

  const els = new Set<any>();
  for (const id of down) if (up.has(id)) els.add(id);
  if (!els.size) return null;

  const links = new Set<any>();
  for (const a of els) for (const b of ATLAS.succ.get(a) || []) {
    if (els.has(b)) links.add(a + "\u0000" + b);
  }
  return { els, links };
}

// The circle a box sits in — an element can stand for several boxes, and a box
// inside a tangle lights the tangle.
function elementOfBox(boxId: string): any {
  if (!ATLAS) return null;
  for (const [id, node] of ATLAS.nodes) {
    if (id !== END && node.boxes && node.boxes.indexOf(boxId) !== -1) return id;
  }
  return null;
}

// Where the frame goes to show you a box. NOT frameOn — that one is for
// entering a tangle, where the tangle is meant to own the screen; used here it
// closed in to 2000% and you saw the circle and nothing else, which is no help
// at all when the question is "where does this sit". This keeps about half the
// picture's height in frame, so the box arrives with its neighbours around it.
function frameNear(id: any) {
  const [cx, cy] = WORLD.at.get(id);
  const r = WORLD.rOf.get(id) || 0;
  const h = Math.max(r * 6, WORLD.H * 0.5), w = h * frameAspect();
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

// Two things ask for this — a box's row in the movers list, and a destination's
// heading in the pathway list — so they share it, keyed by whichever control is
// pressed rather than by what it happens to point at.
function litFor(key: string, el: any) {
  if (!el || !WORLD || !WORLD.at.has(el)) return;
  if (R.traceKey === key) {
    // Letting go leaves the frame where it is: the reader put it there by
    // clicking, and yanking it back would undo a move they did not ask to undo.
    dropTrace();
    paintAtlas();
    return;
  }
  // Whatever was being read before, this replaces it.
  R.roots = []; R.open = []; R.current = []; R.lanes = [];
  R.traceKey = key; R.trace = el;
  paintAtlas();
  // A trace is a shape, so the frame fits the shape. With nothing moved to
  // trace FROM there is nothing to fit, so the box is simply picked out where
  // it stands — moving the frame for a single circle would be a lurch with no
  // new information at the end of it.
  const t = trace();
  if (t) { const f = frameOnStrand([...t.els]); if (f) zoomTo(f); }
}

const litBox = (boxId: string) => litFor("box\u0000" + boxId, elementOfBox(boxId));
// (The destination heading used to trace its element back through the picture.
// That click is now the way INTO the destination's pathways, which light the
// same routes as they go — so the tracer it called has no caller left.)

// Capped until asked otherwise. The cap is what keeps the panel readable on a
// map where half the boxes moved; the button is there because "18 more, all
// smaller" with no way to reach them is a tease. Open, the list takes the
// panel's flexible height and scrolls, so it never pushes the pathways off the
// bottom. The choice is remembered while the atlas is open — a reader who
// asked for the whole list rarely wants it folded again two clicks later.
// Keyed by section, because there is more than one list now and opening the
// outputs should not unfold everything else with it.
let MOVES_OPEN: Record<string, boolean> = {};

function moveList(moves: BoxMove[], key: string, cap = MOVE_ROWS): string {
  const open = !!MOVES_OPEN[key];
  // Over every mover in the section, not just the shown ones — otherwise the
  // bars would all rescale the moment the list was expanded.
  const scale = Math.max(...moves.map(m => Math.abs(m.pct)), 0);
  const capped = moves.length > cap;
  const shown = open ? moves : moves.slice(0, cap);
  const toggle = capped
    ? `<button type="button" class="mv more" data-moves-toggle="${escapeHtml(key)}"
        aria-expanded="${open}">${
        open ? "Show fewer" : `${moves.length - shown.length} more, all smaller`}</button>`
    : "";
  // The button sits OUTSIDE the list, not at the end of it: open, the list
  // scrolls, and a fold-up control you have to scroll to the bottom to reach is
  // a control you cannot find.
  return `<div class="mvrows${capped && open ? " open" : ""}" data-section="${escapeHtml(key)}">${
    shown.map(m => moveRow(m, scale)).join("")}</div>${toggle}`;
}

// One box: its name, a bar either side of a centre line, and the number. The
// bar is measured on the same scale as the colours, so a long bar here and a
// strong colour on the map are the same statement.
// A bar either side of a centre line, measured against the biggest mover IN ITS
// OWN LIST — so a full bar means "the most of anything here".
//
// It used to be measured against the biggest mover anywhere on the map, which
// tied it to the map's colour scale. That reads well as a principle and failed
// completely in practice: the biggest mover anywhere is almost always a slider
// the user is holding, and every OUTPUT is a fraction of its input. On the
// border map the whole outputs list drew as four-pixel stubs against a +91%
// input, so the one thing the bar exists to show — the gaps between neighbours
// in a ranked list — was the one thing it could not show. Each section is a
// ranking of peers and now scales to its own; the eyebrow above it says which
// peers. (The map's colours keep the global scale: they are comparing a box to
// the whole run, not to the three boxes listed beside it.)
function moveBar(pct: number, merit: string, scale: number): string {
  const width = scale > 0 ? Math.min(1, Math.abs(pct) / scale) * 50 : 0;
  const side = pct > 0 ? "left" : "right";
  return `<span class="bar"><i style="width:${width.toFixed(1)}%;${side}:50%;background:${
    MERIT_HUE[merit] || "var(--text-tertiary)"}"></i></span>`;
}

function moveRow(move: BoxMove, scale: number): string {
  const merit = meritOf(move.pct, nodeById[move.id] && nodeById[move.id].direction);
  const lit = R.traceKey === "box\u0000" + move.id;
  return `<button type="button" class="mv ${merit}${lit ? " lit" : ""}"
      data-moverbox="${escapeHtml(move.id)}" aria-pressed="${lit}"
      aria-label="${escapeHtml(move.label)}, ${signed(move.pct)}. Find it in the picture.">
    <span class="nm">${escapeHtml(clip(move.label, 30))}</span>
    ${moveBar(move.pct, merit, scale)}
    <span class="pc">${signed(move.pct)}</span></button>`;
}

// The block that goes at the top of the panel while the sliders are out: the
// headline move, then a row per box for anything standing for more than one.
// Same shape for a single element, a group of boxes, and a tangle — a reader
// should not have to learn it three times.
function effectHtml(boxIds: string[], plural_: string): string {
  if (!state.simulationMode) return "";
  const effect = movesOf(boxIds);
  if (!effect.boxes.length) {
    return `<div class="effect"><div class="big flat">—</div>
      <div class="sub">no numbers on ${boxIds.length > 1 ? "these boxes" : "this box"}</div></div>`;
  }
  const merit = effect.moved ? effect.merit : "flat";
  const single = effect.boxes.length === 1;
  let sub: string;
  if (single) {
    const box = nodeById[effect.boxes[0].id];
    const now = state.computedValues[effect.boxes[0].id];
    const unit = (box && box.unit) || "";
    sub = now === undefined
      ? "against its starting value"
      : `${escapeHtml(formatScalar(now))} ${escapeHtml(unit)} · started at ${
          escapeHtml(formatScalar(box.baseline!))} ${escapeHtml(unit)}`;
  } else {
    const top = effect.boxes[0];
    sub = `average across ${effect.boxes.length} ${plural_} · biggest ${
      escapeHtml(clip(top.label, 24))} ${signed(top.pct)}`;
  }
  const rows = single ? "" : `<div class="eyebrow">Box by box</div>` + moveList(effect.boxes, "boxes");
  return `<div class="effect"><div class="big ${merit}">${signed(effect.pct)}</div>
    <div class="sub">${sub}</div></div>${rows}`;
}

// The same answer as the panel's block, in one line, for the hover. Written
// only while the sliders are out — the tooltip's job the rest of the time is to
// name the thing, and a line saying "0.0%" every time would drown that.
function tipEffect(boxIds: string[], plural_: string): string {
  if (!state.simulationMode) return "";
  const effect = movesOf(boxIds);
  if (!effect.boxes.length) return "";
  const merit = effect.moved ? effect.merit : "flat";
  const detail = effect.boxes.length > 1
    ? ` · average of ${effect.boxes.length} ${plural_}, biggest ${
        escapeHtml(clip(effect.boxes[0].label, 22))} ${signed(effect.boxes[0].pct)}`
    : "";
  // A still box says why. The label under the circle has room for "held by X"
  // and no more; this is where the rest of it goes.
  const gate = effect.moved ? null : boxIds.map(gatedBy).find(Boolean);
  const held = gate
    ? `<div class="tooltip-held">Held back by <b>${escapeHtml(gate.label)}</b></div>`
    : "";
  return `<div class="tooltip-move ${merit}"><b>${signed(effect.pct)}</b>${
    effect.moved ? " since you started simulating" : " — hasn't moved"}${detail}</div>${held}`;
}

// The pathway list is the panel's whole body when nothing is simulating, and
// needs no name. With an effect block above it, it needs one.
const pathwaysLabel = (): string =>
  state.simulationMode ? `<div class="eyebrow">Pathways</div>` : "";

// A box nothing on this picture leads out of: the element holding it has no
// successors but the END sentinel. These are the boxes every pathway arrives
// at, which is why they are also the destinations the pathway list groups by.
function isFinalOutput(boxId: string): boolean {
  const el = elementOfBox(boxId);
  if (el === null || !ATLAS) return false;
  const outs = ATLAS.succ.get(el);
  if (!outs) return true;
  for (const o of outs) if (o !== END) return false;
  return true;
}

// Nothing selected: the run itself. Which boxes moved, biggest first — the one
// at the top is the box the whole colour scale is measured against.
function runEffectHtml(): string {
  if (!state.simulationMode || !ATLAS) return "";
  const ids: string[] = [];
  for (const [, node] of ATLAS.nodes) for (const b of node.boxes || []) ids.push(b);
  const effect = movesOf(ids);
  const movers = effect.boxes.filter(m => Math.abs(m.pct) >= EFFECT_FLOOR_PCT);
  if (!effect.boxes.length) return "";
  if (!movers.length) {
    return `<div class="effect"><div class="big flat">—</div>
      <div class="sub">nothing has moved yet — drag a slider</div></div>`;
  }
  // Three sections, in the order the story runs: what you moved, what it
  // finally did, and the machinery in between. The inputs come out of "along
  // the way" entirely — a slider you are holding is the premise of the run, not
  // one of its results, and reading it as an effect of itself is nonsense.
  const inputs = movers.filter(m => isChangedInput(m.id));
  // Final outputs are deliberately absent from "along the way": they have their
  // own ranked list below, as the headings of the pathway groups.
  const rest = movers.filter(m => !isChangedInput(m.id) && !isFinalOutput(m.id));
  // No headline. It used to lead with the biggest mover and a count, and every
  // word of it is now said better by the sections themselves: the first row of
  // "changed input" IS what you moved, the first row of "final outputs" IS the
  // biggest thing that came of it, and each says so with its own bar and
  // number. A summary that repeats the first line of the list below it is just
  // the list, said worse.
  return (inputs.length
      ? `<div class="eyebrow">${plural(inputs.length, "Changed input")}</div>` +
        moveList(inputs, "inputs")
      : "") +
    // No "final outputs" section: the pathway list below IS the outputs, ranked
    // by how far each moved, each with the routes that got it there. A section
    // above it could only have repeated its first line.
    (rest.length
      ? `<div class="eyebrow">Along the way</div>` + moveList(rest, "rest", ALONG_ROWS)
      : "");
}

// ---------------------------------------------------------------------------
// ZOOM AND PAN
// ---------------------------------------------------------------------------
// The frame is a viewBox, so zooming is arithmetic on four numbers rather than
// a transform stack: divide the width about the cursor and the picture grows
// under it. 100% is the whole picture across the width — the view it rests in —
// so the readout means here what it means on the map: you are seeing all of it.
//
// The gestures match the map on purpose: plain wheel / two-finger scroll pans,
// ctrl (or pinch) zooms about the cursor.
// ---------------------------------------------------------------------------
export const ATLAS_ZOOM_MIN = 0.25;
export const ATLAS_ZOOM_MAX = 24;

// The drawn radius of one element. Exported so a test can check the picture's
// own rule — a ribbon is never fatter than the circles it joins.
export function atlasRadius(id: any): number {
  return (WORLD && WORLD.rOf.get(id)) || 0;
}

export function atlasZoomPercent(): number {
  if (!WORLD || !VB) return 1;
  return wholePicture().w / VB.w;
}

export function atlasFitWidth(): void {
  if (!WORLD) return;
  stopTour();
  R.inside = null;
  paintAtlas();
  zoomTo(wholePicture());
}

export function atlasZoomBy(factor: number, anchorClientX?: number, anchorClientY?: number): void {
  if (!WORLD || !VB) return;
  const base = wholePicture().w;
  const w = Math.max(base / ATLAS_ZOOM_MAX, Math.min(base / ATLAS_ZOOM_MIN, VB.w / factor));
  if (Math.abs(w - VB.w) < 0.01) return;
  const h = VB.h * (w / VB.w);

  // Anchored on the cursor when there is one: the point under the pointer is
  // what the reader is thinking about, and it should not move.
  const svg = svgEl();
  let fx = 0.5, fy = 0.5;
  if (svg && typeof anchorClientX === "number" && typeof anchorClientY === "number") {
    const box = svg.getBoundingClientRect();
    if (box.width && box.height) {
      fx = Math.max(0, Math.min(1, (anchorClientX - box.left) / box.width));
      fy = Math.max(0, Math.min(1, (anchorClientY - box.top) / box.height));
    }
  }
  VB = { x: VB.x + (VB.w - w) * fx, y: VB.y + (VB.h - h) * fy, w, h };
  setScale();
}

export function atlasPanBy(dxWorld: number, dyWorld: number): void {
  if (!VB) return;
  VB = { ...VB, x: VB.x + dxWorld, y: VB.y + dyWorld };
  setScale();
}

// ---------------------------------------------------------------------------
// THE PICTURE ANSWERS THE POINTER
// ---------------------------------------------------------------------------
// One delegated listener set on the stage, bound once. Click an element to
// light up what it touches; click a tangle to go inside it; drag to move when
// the frame has closed in; Escape lets go one layer at a time.
// ---------------------------------------------------------------------------
let panFrom: any = null;
let panMoved = 0;

function atlasPointerDown(e: PointerEvent): void {
  const svg = svgEl();
  if (!svg || !VB) return;
  panFrom = { x: e.clientX, y: e.clientY, vb: { ...VB } };
  panMoved = 0;
}

function atlasPointerMove(e: PointerEvent): void {
  if (!panFrom) return;
  const svg = svgEl();
  if (!svg) return;
  const box = svg.getBoundingClientRect();
  const z = Math.min(box.width / VB.w, box.height / VB.h) || 1;
  const dx = e.clientX - panFrom.x, dy = e.clientY - panFrom.y;
  panMoved = Math.max(panMoved, Math.hypot(dx, dy));
  // Capture only once a drag is real: taking the pointer on the way down makes
  // every subsequent click land on the whole picture instead of the circle
  // under the cursor, and nothing on a rim can be clicked again.
  if (panMoved > 4) {
    svg.classList.add("panning");
    try { svg.setPointerCapture(e.pointerId); } catch (_) {}
    VB = { ...panFrom.vb, x: panFrom.vb.x - dx / z, y: panFrom.vb.y - dy / z };
    setScale();
  }
}

function atlasPointerUp(e: PointerEvent): void {
  const svg = svgEl();
  if (svg) {
    svg.classList.remove("panning");
    try { svg.releasePointerCapture(e.pointerId); } catch (_) {}
  }
  panFrom = null;
}

export function initAtlasStage(): void {
  initAtlasEntry();
  const stage = stageEl();
  if (!stage || stage.dataset.wired) return;
  stage.dataset.wired = "1";

  stage.addEventListener("pointerdown", e => { if ((e.target as Element).closest("svg.atlas")) atlasPointerDown(e); });

  // Ctrl / Cmd + wheel and trackpad pinch zoom about the cursor; a plain wheel
  // or two-finger scroll pans. The same division of labour as the map, so the
  // gesture you already know keeps working when the picture changes.
  stage.addEventListener("wheel", event => {
    const e = event as WheelEvent;
    if (!VB || !(e.target as Element).closest("svg.atlas")) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      atlasZoomBy(Math.exp(-e.deltaY * 0.0022), e.clientX, e.clientY);
      return;
    }
    const svg = svgEl();
    const box = svg ? svg.getBoundingClientRect() : null;
    const perPx = box && box.width ? VB.w / box.width : 1;
    atlasPanBy(e.deltaX * perPx, e.deltaY * perPx);
  }, { passive: false });
  stage.addEventListener("pointermove", atlasPointerMove);
  stage.addEventListener("pointerup", atlasPointerUp);
  stage.addEventListener("pointercancel", atlasPointerUp);

  stage.addEventListener("click", event => {
    // A drag that ends on a circle is not a click on it.
    if (panMoved > 4) { panMoved = 0; return; }
    const target = event.target as Element;
    if (!target || !target.closest) return;

    if (target.closest("[data-atlas-close]")) { closeAtlas(); return; }
    const zoomBtn = target.closest("[data-atlas-zoom]") as HTMLElement | null;
    if (zoomBtn) {
      const which = zoomBtn.dataset.atlasZoom;
      if (which === "fit") atlasFitWidth();
      else atlasZoomBy(which === "in" ? 1.3 : 1 / 1.3);
      return;
    }
    // Inside a tangle this backs out of it; merely zoomed in, it fits the width.
    if (target.closest("[data-zoomout]")) {
      if (R.inside) leaveTangle(false); else atlasFitWidth();
      return;
    }
    if (target.closest("[data-replay]"))      { WHEEL_PICK = null; PICK_FROM_WHEEL = false; paintAtlas(); playTour(); return; }

    const nd = target.closest("g.n.focus .nd") as HTMLElement | null;
    if (nd) { pickWheelBox(nd.dataset.box); return; }

    const g = target.closest("svg.atlas g.n") as HTMLElement | null;
    if (!g) return;
    selectEl(g.dataset.el);
  });

  // Double-click closes the frame in on any element — and on a tangle, closing
  // in IS going inside it, where its loops are. A single click is now the same
  // question everywhere ("how do I get here"), so the way in moved here.
  stage.addEventListener("dblclick", event => {
    const g = (event.target as Element).closest("svg.atlas g.n") as HTMLElement | null;
    if (!g || !WORLD || !WORLD.at.has(g.dataset.el)) return;
    event.preventDefault();
    if (g.dataset.loop) { enterTangle(g.dataset.el); return; }
    zoomTo(frameOn(g.dataset.el));
  });

  stage.addEventListener("keydown", event => {
    const e = event as KeyboardEvent;
    if (e.key !== "Enter" && e.key !== " ") return;
    const g = (e.target as Element).closest && (e.target as Element).closest("svg.atlas g.n") as HTMLElement | null;
    if (!g) return;
    e.preventDefault();
    if (g.dataset.loop) enterTangle(g.dataset.el); else selectEl(g.dataset.el);
  });

  // Pointing at a circle points at the fork it belongs to — the picture and
  // the list are the same control seen twice, so either can be swept.
  stage.addEventListener("pointerover", event => {
    if (!atlasIsOpen() || R.inside) return;
    const g = (event.target as Element)?.closest?.("svg.atlas g.n") as HTMLElement | null;
    previewFork(g ? forkAtElement(g.dataset.el) : null);
  });
  stage.addEventListener("pointerleave", () => previewFork(null));

  stage.addEventListener("mouseover", event => {
    const tip = document.getElementById("tooltip");
    if (!tip) return;
    const target = event.target as Element;
    if (!target || !target.closest) return;
    const nd = target.closest("g.n.focus .nd") as HTMLElement | null;
    if (nd) {
      const w = WHEELS.get(R.inside);
      const n = w ? w.share.get(nd.dataset.box) : 0;
      tip.innerHTML = `<div class="tooltip-title">${escapeHtml(boxLabel(nd.dataset.box))}</div>` +
        tipEffect([nd.dataset.box!], "boxes") +
        `<div class="tooltip-text">in ${n} ${plural(n, "loop")} of this tangle · click to follow one</div>`;
      tip.classList.add("visible");
      return;
    }
    const g = target.closest("svg.atlas g.n") as HTMLElement | null;
    if (!g || !ATLAS || !ATLAS.nodes.has(g.dataset.el)) { tip.classList.remove("visible"); return; }
    const node = ATLAS.nodes.get(g.dataset.el);
    const M = measure(ATLAS);
    tip.innerHTML = `<div class="tooltip-title">${escapeHtml(node.label)}</div>` +
      tipEffect(node.boxes, plural(node.boxes.length, "box", "boxes")) +
      `<div class="tooltip-text">${pct(M.weight(g.dataset.el))} of all readings pass through · ` +
      `${node.boxes.length} ${plural(node.boxes.length, "box", "boxes")}` +
      `${node.loop ? " · double-click to go inside" : ""}</div>`;
    tip.classList.add("visible");
  });

  stage.addEventListener("mousemove", event => {
    const tip = document.getElementById("tooltip");
    if (!tip || !tip.classList.contains("visible")) return;
    tip.style.left = (event as MouseEvent).clientX + 14 + "px";
    tip.style.top  = (event as MouseEvent).clientY + 14 + "px";
  });

  // The panel is the app's, so its atlas content is wired here rather than in
  // the detail panel — clicking a box name closes the atlas and opens that box.
  const content = document.getElementById("detail-content");
  if (content && !content.dataset.atlasWired) {
    content.dataset.atlasWired = "1";

    // Pointing at a row draws its fork, and nothing else. Leaving the list puts
    // back whatever is actually chosen.
    content.addEventListener("pointerover", event => {
      if (!atlasIsOpen()) return;
      const row = (event.target as Element)?.closest?.("[data-fork]") as HTMLElement | null;
      previewFork(row ? forkOfKey(row.dataset.forkpath) : null);
    });
    content.addEventListener("pointerleave", () => {
      if (atlasIsOpen()) previewFork(null);
    });
    content.addEventListener("click", event => {
      const t = event.target as Element;
      // The panel carries its own copies of the atlas controls, and a click on
      // one of them never reached the stage's handler — so they are wired here.
      if (t && t.closest && atlasIsOpen()) {
        const card = t.closest("[data-loopidx]") as HTMLElement | null;
        if (card) {
          const i = Number(card.dataset.loopidx);
          // A loop can only be DRAWN from inside its tangle — the wheel is the
          // drawing — so the row is also the way in. The list stays put.
          const tangle = R.roots[R.roots.length - 1];
          if (tangle && R.inside !== tangle) enterTangle(tangle, () => selectLoopCard(i));
          else selectLoopCard(i);
          return;
        }
        // The pathway list: a fork opens, "All pathways" steps back out.
        const crumb = t.closest("[data-crumb]") as HTMLElement | null;
        if (crumb) {
          const to = Number(crumb.dataset.crumb);
          // "All pathways" is the way back to nothing picked at all, so it
          // lets go of a circle as readily as of a narrowing.
          if (to === 0 && !R.current.length && R.roots.length) {
            R.roots = []; syncStrandToOpen(true); return;
          }
          closeToDepth(to);
          return;
        }
        // Before the row it sits under, because a box picked out from under a
        // folded row is a narrowing of that row rather than a second click on
        // it — opening the row again would shut what was just asked about.
        const lane = t.closest("[data-lane]") as HTMLElement | null;
        if (lane) {
          const at = KEY_PATH.get(lane.dataset.lanerow || "");
          if (at) pickLane(at, lane.dataset.lane!);
          return;
        }
        const fork = t.closest("[data-fork]") as HTMLElement | null;
        if (fork) { openFork(decodePath(fork.dataset.forkpath)); return; }
        const more = t.closest("[data-moves-toggle]") as HTMLElement | null;
        if (more) {
          const key = more.dataset.movesToggle!;
          MOVES_OPEN[key] = !MOVES_OPEN[key];
          renderInspector();
          return;
        }
        const mover = t.closest("[data-moverbox]") as HTMLElement | null;
        if (mover) { litBox(mover.dataset.moverbox!); return; }
        if (t.closest("[data-replay]")) { WHEEL_PICK = null; PICK_FROM_WHEEL = false; paintAtlas(); playTour(); return; }
        if (t.closest("[data-zoomout]")) {
          if (R.inside) leaveTangle(false); else atlasFitWidth();
          return;
        }
      }
      const el = (event.target as Element).closest("[data-atlas-box]") as HTMLElement | null;
      if (!el || !atlasIsOpen()) return;
      const id = el.dataset.atlasBox!;
      closeAtlas();
      if (nodeById[id] && typeof selectNode === "function") {
        selectNode(id);
        if (typeof scrollNodeIntoView === "function") scrollNodeIntoView(id);
      }
    });
  }

  stage.addEventListener("mouseleave", () => {
    const tip = document.getElementById("tooltip");
    if (tip) tip.classList.remove("visible");
  });
}

// Escape lets go one layer at a time: the box inside a tangle, then the tangle,
// then the selection, then the atlas itself.
document.addEventListener("keydown", event => {
  if (!atlasIsOpen()) return;
  const target = event.target as HTMLElement | null;
  // Never while typing: the search box and every field in the app take these
  // keys for themselves.
  if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    stepPreview(event.key === "ArrowDown" ? 1 : -1);
    return;
  }
  if (event.key === "Enter" && POINTED) {
    event.preventDefault();
    const path = pathOfFork(POINTED);
    if (path.length) openFork(path);
    return;
  }
});

document.addEventListener("keydown", event => {
  if (event.key !== "Escape" || !atlasIsOpen()) return;
  if (R.current.length) { closeToDepth(R.current.length - 1); return; }
  if (WHEEL_PICK)     { pickWheelBox(null); return; }
  if (R.inside)       { leaveTangle(false); return; }
  // Through the same door as clicking the circle again, so Escape lets go of
  // exactly what a click would — and the frame comes back with it.
  if (R.roots.length) { selectEl(R.roots[R.roots.length - 1]); return; }
  closeAtlas();
});

addEventListener("resize", () => {
  if (!atlasIsOpen() || !VB || !WORLD) return;
  // At rest the view IS the frame's shape, so a resize re-fits it; zoomed in or
  // inside a tangle, the reader chose that frame and it is left alone.
  if (!R.inside && VB.w >= wholePicture().w - 1) VB = wholePicture();
  setScale();
});
