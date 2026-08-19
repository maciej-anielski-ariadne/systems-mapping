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

import { EDGES, NODES, nodeById, state } from "./03-state";
import { escapeHtml } from "./04-utils";
import { resolveEdgeElasticity } from "./07-simulation-engine";
import { scrollNodeIntoView, selectNode } from "./09-graph-selection";
import { renderDetailPanel } from "./15-detail-panel";
import {
  END,
  buildAtlas,
  buildGraph,
  canonicalCycle,
  formatCount,
  measure,
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
let traceRAF = 0;
const CHAIN_MAX = 7;                  // boxes named in a loop caption; the rest are on the wheel

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
  WHEEL_PICK = null; WHEEL_LOOP = 0; WHEEL_TANGLE = null;
  FOCUS = null; SELECT = null; VB = null; WORLD = null;
  stopTour();
  document.body.classList.add("atlas-open");
  renderAtlas();
}

export function closeAtlas(): void {
  if (!state.atlas) return;
  stopTour();
  cancelAnimationFrame(traceRAF);
  state.atlas = null;
  START = null; ATLAS = null; GRAPH = null; WORLD = null; VB = null;
  FOCUS = null; SELECT = null;
  WHEELS.clear();
  document.body.classList.remove("atlas-open");
  const stage = stageEl();
  if (stage) { stage.innerHTML = ""; stage.hidden = true; }
  renderDetailPanel();
}

// Draw (or redraw) the whole picture, then frame it and play whatever the
// current state says should be playing.
export function renderAtlas(): void {
  const stage = stageEl();
  if (!stage || !ATLAS) return;
  stage.hidden = false;
  stage.innerHTML = viewAtlas(ATLAS, measure(ATLAS));
  if (!WORLD) return;
  VB = FOCUS && WORLD.at.has(FOCUS) ? frameOn(FOCUS) : wholePicture();
  setScale();
  paintAtlas();
  revealAtlas();
  if (FOCUS) playTour();
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
let FOCUS: any = null;             // the tangle we are inside
let SELECT: any = null;            // the element being explained
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
      parts.push(`<path class="fl" data-a="${escapeHtml(a)}" data-b="${escapeHtml(b)}" stroke-width="${t.toFixed(2)}"
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
      (node.loop ? tangleWheel(node, cx, cy, r) : "") +
      `<text x="${cx.toFixed(1)}" y="${(cy + r + 15).toFixed(1)}" text-anchor="middle">${
        node.loop ? "↻ " : ""}${escapeHtml(clip(node.label, 30))}${
        node.boxes.length > 1 && !node.loop ? " ×" + node.boxes.length : ""}</text></g>`);
  }

  return `<div class="atlas-legend">
      <span><i class="sw sw-el"></i>an element — its <b>area</b> is the share of readings through it</span>
      <span><i class="sw sw-loop"></i>↻ feedback — click to go inside it</span>
      <span class="sim-only"><i class="sw sw-good"></i>colour is which way it has moved since you
        started <b>simulating</b> — size still says how much runs through</span>
      <span>point at anything to name it · ${pctNote()}</span>
    </div>
    <div class="atlaswrap">
      <svg class="atlas" viewBox="0 0 ${W} ${H}" style="--z:1" role="application"
        aria-label="Every pathway downstream of ${escapeHtml(labelOf(A.start))}">${parts.join("")}</svg>
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
    ctl.hidden = !zoomedIn && !FOCUS;
    const out = ctl.querySelector("[data-zoomout]") as HTMLElement | null;
    if (out) out.textContent = FOCUS ? "Back out" : "Fit to width";
    const rp = ctl.querySelector("[data-replay]") as HTMLElement | null;
    if (rp) rp.hidden = !FOCUS;
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

function paintAtlas() {
  const svg = svgEl();
  if (!svg || !WORLD) return;
  const A = WORLD.A, M = WORLD.M;
  const lit = FOCUS || SELECT;
  svg.classList.toggle("busy", !!lit);
  svg.classList.toggle("inside", !!FOCUS);

  for (const g of svg.querySelectorAll("g.n")) {
    const id = g.dataset.el;
    g.classList.toggle("on", id === lit);
    g.classList.toggle("focus", id === FOCUS);
    g.classList.toggle("near", !!lit && lit !== id &&
      (A.succ.get(lit) || new Set<any>()).has(id) || (!!lit && (A.succ.get(id) || new Set<any>()).has(lit)));
  }
  for (const p of svg.querySelectorAll(".fl"))
    p.classList.toggle("hot", !!lit && (p.dataset.a === lit || p.dataset.b === lit));
  setScale();
  refreshAtlasValues();
  paintWheel();
  renderInspector();
}

function selectEl(id: any) {
  if (FOCUS && id !== FOCUS) leaveTangle(true);
  SELECT = id === SELECT ? null : id;
  WHEEL_PICK = null;
  paintAtlas();
}

function enterTangle(id: any) {
  if (FOCUS === id) return;
  stopTour();
  FOCUS = id; SELECT = id; WHEEL_PICK = null; WHEEL_LOOP = 0;
  WHEEL_TANGLE = WORLD.A.nodes.get(id).tangles[0];
  paintAtlas();
  zoomTo(frameOn(id), playTour);
}

function leaveTangle(quiet: any) {
  if (!FOCUS) return;
  stopTour();
  const svg = svgEl();
  if (svg) { const tr = svg.querySelector("g.n.focus .trace"); if (tr) tr.innerHTML = ""; }
  FOCUS = null; WHEEL_PICK = null;
  if (!quiet) SELECT = null;
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
  const w = WHEELS.get(FOCUS);
  if (!w) return [];
  return [...w.loops].sort((a, b) => b.gain - a.gain || a.cycle.length - b.cycle.length)
    .slice(0, TOUR_MAX);
}

function playTour() {
  if (!FOCUS) return;
  stopTour();
  const svg = svgEl();
  const g = svg && svg.querySelector("g.n.focus .trace");
  const w = WHEELS.get(FOCUS);
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
  const A = WORLD.A, M = WORLD.M, start = labelOf(A.start);
  const explain = `<p class="hint">Every <b>%</b> on this page is a share of the
    <b>readings</b> — the ${formatCount(A.shapes)} distinct pathways this page tells from
    <b>${escapeHtml(start)}</b>. “14% of everything” means fourteen readings in every hundred pass
    through it.</p>`;

  if (FOCUS) {
    const node = A.nodes.get(FOCUS), t = node.tangles[0];
    const w = WHEELS.get(FOCUS);
    const loops = w ? w.loops : [];
    const r = loops.filter((l: any) => l.reinforcing).length;
    const shown = Math.min(TOUR_MAX, loops.length);
    const playing = tourRAF && tourAt >= 0 && tourAt < shown;
    const picked = WHEEL_PICK;
    const through = picked ? loopsThrough(picked) : [];
    const loop = through.length ? rotateTo(through[WHEEL_LOOP % through.length], picked) : null;
    return `<div class="ins">
      <header><b>↻ Inside a tangle of ${t.boxes.length} ${plural(t.boxes.length, "box", "boxes")}</b>
        <span class="m">${w ? w.back.length : 0} ${plural(w ? w.back.length : 0, "link")} back ·
          ${r}R / ${loops.length - r}B · ${t.independent} independent</span></header>
      <p class="lede">Boxes sit round the rim in an order that makes almost every link run clockwise.
        The chords across the middle are the ones that run back — <b>they are the feedback</b>, and
        cutting them would leave a plain sequence.</p>
      <p class="cap">${playing
        ? `Playing the loops — <b>${tourAt + 1}</b> of ${shown}${
            loops.length > shown ? ` (the ${shown} strongest of ${loops.length})` : ""}.`
        : `<b>${shown}</b> ${plural(shown, "loop")} drawn${
            loops.length > shown ? ` — the strongest of ${loops.length}` : ""}. Point at a box on the
            rim to name it; click one to follow its own loop round.`}</p>
      ${picked ? loopCaption(picked, loop, through) : ""}
      <div class="row-btns" style="margin-top:9px">
        <button class="btn" type="button" data-replay>Replay the loops</button>
        <button class="btn" type="button" data-zoomout>← Back out to the whole map</button>
      </div>${explain}</div>`;
  }

  if (SELECT && A.nodes.has(SELECT)) {
    const node = A.nodes.get(SELECT);
    const names = (set: any) => [...set].filter((x: any) => x !== END).map(labelOf);
    const ins = names(A.pred.get(SELECT) || new Set<any>()), outs = names(A.succ.get(SELECT) || new Set<any>());
    const list = (l: any) => l.length
      ? l.slice(0, 6).map((n: any) => `<em>${escapeHtml(clip(n, 30))}</em>`).join("") +
        (l.length > 6 ? `<i>+${l.length - 6} more</i>` : "")
      : `<i>nothing</i>`;
    // The one thing the picture cannot say. A circle can stand for twenty
    // boxes; here they are by name, and each one opens itself on the map.
    const boxes = node.boxes.map((b: any) =>
      `<button type="button" class="atlas-box" data-atlas-box="${escapeHtml(b)}">${
        escapeHtml(clip(boxLabel(b), 44))}</button>`).join("");
    return `<div class="ins">
      <header><b>${escapeHtml(node.label)}</b>
        <span class="m">${pct(M.weight(SELECT))} of everything${
          node.boxes.length > 1 ? ` · ${node.boxes.length} boxes` : ""}</span></header>
      <p class="cap"><b>${pct(M.weight(SELECT))}</b> of the readings from <b>${escapeHtml(start)}</b>
        pass through here${node.boxes.length > 1
          ? `, and this one circle stands for ${node.boxes.length} boxes that behave alike`
          : ""}.</p>
      <div class="wires"><span class="k">reached from</span><div class="chain">${list(ins)}</div></div>
      <div class="wires"><span class="k">leads to</span><div class="chain">${list(outs)}</div></div>
      <p class="k-head">${node.boxes.length === 1 ? "The box" : "The " + node.boxes.length + " boxes"}
        behind this circle <span class="m">— click one to open it on the map</span></p>
      <div class="atlas-boxes">${boxes}</div>
      ${explain}</div>`;
  }

  return `<div class="ins">
    <header><b>Everything downstream of ${escapeHtml(start)}</b>
      <span class="m">${A.elements} elements · ${formatCount(A.shapes)} readings</span></header>
    <p class="lede">Click a circle for the boxes behind it and what it touches. An amber
      <b>↻</b> opens as a wheel of its own feedback.</p>
    ${explain}</div>`;
}

function loopCaption(picked: any, loop: any, through: any) {
  if (!loop) return `<p class="cap"><b>${escapeHtml(boxLabel(picked))}</b> — no loop found through it.</p>`;
  return `<p class="cap"><b>${escapeHtml(boxLabel(picked))}</b> comes back to itself
      ${through.length} ${plural(through.length, "way")}${through.length > 1
        ? ` — showing ${WHEEL_LOOP % through.length === 0 ? "the shortest"
            : (WHEEL_LOOP % through.length) + 1 + " of " + through.length}` : ""}.</p>
    <p class="chain">${loop.cycle.slice(0, CHAIN_MAX).map((b: any, i: any) =>
      `<em class="${b === picked ? "head" : ""}">${escapeHtml(clip(boxLabel(b), 24))}</em>` +
      `<i>${loop.links[i].elasticity < 0 ? "−" : "+"}→</i>`).join("")}${
      loop.cycle.length > CHAIN_MAX ? `<i>${loop.cycle.length - CHAIN_MAX} more →</i>` : ""}
      <em class="head">${escapeHtml(clip(boxLabel(picked), 24))}</em></p>
    <p class="m">${loop.reinforcing ? "Reinforcing" : "Balancing"} ·
      ${loop.cycle.length} ${plural(loop.cycle.length, "box", "boxes")} ·
      gain ${loop.gain < 0.0005 ? "≈0" : loop.gain.toFixed(3)}</p>
    ${through.length > 1
      ? `<div class="row-btns" style="margin-top:7px">
           <button class="btn" type="button" data-wheelnext>Next loop through it</button></div>` : ""}`;
}

// ---------------------------------------------------------------------------
// INSIDE THE TANGLE — one box, and how it comes back to itself
// ---------------------------------------------------------------------------
// The tour shows every loop. This shows one: click a box on the rim and its own
// loop draws itself round, starting and ending where you clicked, because a
// loop has no beginning but an explanation does.
// ---------------------------------------------------------------------------
function paintWheel() {
  const svg = svgEl();
  if (!svg) return;
  const g = FOCUS && svg.querySelector("g.n.focus");
  if (!g) return;
  const w = WHEELS.get(FOCUS);
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
  const w = WHEELS.get(FOCUS);
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
  const w = WHEELS.get(FOCUS);
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
  paintAtlas();
}


// ---------------------------------------------------------------------------
// WHAT SIMULATION IS DOING
// ---------------------------------------------------------------------------
// Structure is what the atlas is FOR — how much of everything runs through a
// place. While the sliders are out, it also says which way each place has moved:
// green / red where the boxes carry a direction of merit (the map's own good and
// bad), plain up / down where they don't. The size never changes — that would be
// two different measures fighting over one circle.
// ---------------------------------------------------------------------------
const MOVE_FLOOR = 0.005;      // below half a percent, nothing has really moved

function elementMove(id: any): number {
  const node = ATLAS && ATLAS.nodes.get(id);
  if (!node) return 0;
  let sum = 0, seen = 0;
  for (const boxId of node.boxes) {
    const box = nodeById[boxId];
    if (!box || box.baseline === undefined || box.baseline === null || !box.baseline) continue;
    const now = state.computedValues[boxId];
    if (!Number.isFinite(now)) continue;
    sum += (now - box.baseline) / Math.abs(box.baseline);
    seen++;
  }
  return seen ? sum / seen : 0;
}

// An element can hold boxes that disagree about which way is better, and a
// single colour cannot honestly answer for both — so merit colouring is used
// only where they agree.
function moveClass(id: any): string {
  const move = elementMove(id);
  if (Math.abs(move) < MOVE_FLOOR) return "";
  const node = ATLAS.nodes.get(id);
  const merits = new Set(node.boxes.map((b: any) => nodeById[b] && nodeById[b].direction).filter(Boolean));
  if (merits.size === 1) {
    const merit = [...merits][0];
    if (merit === "higher_better") return move > 0 ? "good" : "bad";
    if (merit === "lower_better")  return move > 0 ? "bad"  : "good";
  }
  return move > 0 ? "up" : "down";
}

// Recolour without rebuilding: a slider drag calls this many times a second.
export function refreshAtlasValues(): void {
  const svg = svgEl();
  if (!svg || !ATLAS) return;
  svg.classList.toggle("simulating", !!state.simulationMode);
  for (const g of svg.querySelectorAll("g.n")) {
    const el = g as HTMLElement;
    const cls = state.simulationMode ? moveClass(el.dataset.el) : "";
    el.classList.toggle("good", cls === "good");
    el.classList.toggle("bad",  cls === "bad");
    el.classList.toggle("up",   cls === "up");
    el.classList.toggle("down", cls === "down");
  }
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

export function atlasZoomPercent(): number {
  if (!WORLD || !VB) return 1;
  return wholePicture().w / VB.w;
}

export function atlasFitWidth(): void {
  if (!WORLD) return;
  stopTour();
  FOCUS = null;
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
      if (FOCUS) leaveTangle(false); else atlasFitWidth();
      return;
    }
    if (target.closest("[data-replay]"))      { WHEEL_PICK = null; paintAtlas(); playTour(); return; }
    if (target.closest("[data-wheelnext]"))   { WHEEL_LOOP++; paintAtlas(); return; }

    const nd = target.closest("g.n.focus .nd") as HTMLElement | null;
    if (nd) { pickWheelBox(nd.dataset.box); return; }

    const g = target.closest("svg.atlas g.n") as HTMLElement | null;
    if (!g) return;
    if (g.dataset.loop) enterTangle(g.dataset.el);
    else selectEl(g.dataset.el);
  });

  // Double-click closes the frame in on any element, tangle or not.
  stage.addEventListener("dblclick", event => {
    const g = (event.target as Element).closest("svg.atlas g.n") as HTMLElement | null;
    if (!g || !WORLD || !WORLD.at.has(g.dataset.el)) return;
    event.preventDefault();
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

  stage.addEventListener("mouseover", event => {
    const tip = document.getElementById("tooltip");
    if (!tip) return;
    const target = event.target as Element;
    if (!target || !target.closest) return;
    const nd = target.closest("g.n.focus .nd") as HTMLElement | null;
    if (nd) {
      const w = WHEELS.get(FOCUS);
      const n = w ? w.share.get(nd.dataset.box) : 0;
      tip.innerHTML = `<div class="tooltip-title">${escapeHtml(boxLabel(nd.dataset.box))}</div>` +
        `<div class="tooltip-text">in ${n} ${plural(n, "loop")} of this tangle · click to follow one</div>`;
      tip.classList.add("visible");
      return;
    }
    const g = target.closest("svg.atlas g.n") as HTMLElement | null;
    if (!g || !ATLAS || !ATLAS.nodes.has(g.dataset.el)) { tip.classList.remove("visible"); return; }
    const node = ATLAS.nodes.get(g.dataset.el);
    const M = measure(ATLAS);
    tip.innerHTML = `<div class="tooltip-title">${escapeHtml(node.label)}</div>` +
      `<div class="tooltip-text">${pct(M.weight(g.dataset.el))} of all readings pass through · ` +
      `${node.boxes.length} ${plural(node.boxes.length, "box", "boxes")}` +
      `${node.loop ? " · click to go inside" : ""}</div>`;
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
    content.addEventListener("click", event => {
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
  if (event.key !== "Escape" || !atlasIsOpen()) return;
  if (WHEEL_PICK) { pickWheelBox(null); return; }
  if (FOCUS)      { leaveTangle(false); return; }
  if (SELECT)     { SELECT = null; paintAtlas(); return; }
  closeAtlas();
});

addEventListener("resize", () => {
  if (!atlasIsOpen() || !VB || !WORLD) return;
  // At rest the view IS the frame's shape, so a resize re-fits it; zoomed in or
  // inside a tangle, the reader chose that frame and it is left alone.
  if (!FOCUS && VB.w >= wholePicture().w - 1) VB = wholePicture();
  setScale();
});
