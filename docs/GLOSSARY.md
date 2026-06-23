# Glossary — plain-language definitions

A friendly reference for terms that show up in the code comments. You don't need a
computer-science or maths background to follow along — each entry explains the idea in
everyday language and ties it to how this app (Ariadne Maps) actually uses it.

The code comments say "(see docs/GLOSSARY.md)" the first time one of these terms appears in
a file. Jump here, read the entry, go back.

---

## The model (boxes, links, and numbers)

**Node / box.** One box on the map — a thing in your system (a team, a metric, an input).
In the spreadsheet these live in the `nodes` section.

**Edge / link.** An arrow from one box to another, meaning "this causes / affects that."
In the spreadsheet these live in the `edges` section. Every edge is `enables`, `increases`,
or `decreases`.

**Baseline.** A box's starting value before you change anything (e.g. a team of 100 people).
Simulation works in *ratios* to the baseline, so a box with no baseline just sits on the
map without taking part in the numbers.

**Elasticity (link strength).** A single number on each link that says *how strongly* the
cause moves the effect. Think "stretchiness": an elasticity of 0.3 means if the cause
doubles, the effect grows by roughly 30% of the way there. It can be negative (the cause
going up pushes the effect down). Borrowed from economics, where elasticity measures how
much one quantity responds to another.

**Cobb-Douglas.** The specific formula used to combine a box's incoming links into its
value. In plain terms: multiply together each input's *ratio-to-its-baseline*, each raised
to that link's elasticity, then scale by the box's own baseline. The nice properties are
that it's always positive, smooth, and handles several inputs compounding naturally. (Named
after the economists who popularised the formula.) The math is written out in the header of
`07-simulation-engine.ts`.

**Gain (of a feedback loop).** When links form a loop that feeds back on itself, "gain" is
how much the loop amplifies each time round. Gain below 1 settles down to a steady answer;
gain of 1 or more runs away to infinity, so the app clamps it and shows a warning instead of
pretending it has a real value.

## Graphs (boxes-and-arrows, the math sense)

**Graph.** Just the network of boxes (nodes) and arrows (edges). "Graph" here means
boxes-and-arrows, not a bar chart.

**Ancestors / descendants.** Following arrows *backwards* from a box gives its ancestors
(its causes); following them *forwards* gives its descendants (its effects).

**BFS — breadth-first search.** A way to explore a network outward in rings: first all the
boxes one arrow away, then all the boxes two arrows away, and so on. The app uses it to
light up a selected box's neighbours level-by-level (the "highlight depth" control).

**DFS — depth-first search.** The other common way to explore a network: follow one chain of
arrows as far as it goes, then back up and try the next branch. The app uses it to trace
causal paths and to find loops.

**Cycle / feedback loop.** A chain of arrows that eventually leads back to where it started
(A affects B affects C affects A). Loops are allowed, but they make the simulation harder —
see *Gauss-Seidel* and *gain*.

**Topological sort.** Putting the boxes in an order where every cause comes before its
effects. If you can do this for the whole map, there are no loops. The simulation uses this
order so that, on a loop-free map, one pass computes every box exactly. (The app builds it
with "Kahn's algorithm", a standard recipe for the job.) DFS cycle-detection sometimes
labels nodes white / gray / black — unvisited / on the current path / fully done — as a
bookkeeping trick to spot when a path loops back on itself.

**Gauss-Seidel sweep.** A "keep refining until it settles" technique. When the map has loops
there's no perfect order, so the solver sweeps through all the boxes updating each from the
latest values of its inputs, then sweeps again, and again — each pass gets closer to the
answer — until the numbers stop moving (or it hits a safety cap). Named after two
mathematicians; you can read it as "iterate to a stable answer."

## Drawing the map (SVG)

**SVG.** "Scalable Vector Graphics" — the browser format the map is drawn in. Instead of
pixels, it's a set of shape instructions (lines, curves, text), so it stays crisp at any
zoom. The renderer builds these instructions as text and hands them to the browser.

**Cubic bezier curve / tangent.** The smooth S-shaped curve each link arrow is drawn as. A
cubic bezier is defined by its two endpoints plus two "control points" that pull the curve
into shape; the *tangent* is the direction the curve is heading as it leaves or arrives at a
box (the app makes links leave and arrive horizontally so they look tidy).

**Edge anchor / fan-out.** The exact point on a box's edge where an arrow attaches is its
"anchor." When several arrows touch the same side of a box, the app spreads (fans) their
anchor points apart vertically so they don't pile up on one spot.

**Casing / knockout gap.** To keep crossing arrows readable, each arrow is drawn twice: once
as a slightly fatter background stroke in the page colour (the "casing"), then the real
coloured line on top. The casing punches a small gap — a "knockout" — wherever one arrow
crosses another, so it's clear which line is in front.

**Virtualization.** Only building the parts of the map that are actually on screen. On a huge
map, drawing every box would be slow, so the renderer skips boxes scrolled out of view and
adds them back as you pan. ("Virtual" because the off-screen ones exist in the data but not
in the drawing.)

## Browser & JavaScript plumbing

**Event delegation.** Instead of attaching a separate click-handler to every box (thousands
on a big map), the app attaches *one* handler to the container and figures out which box was
clicked from the event. Fewer handlers, set up once — faster and simpler.

**ESM live bindings.** A detail of how JavaScript modules (ES Modules) share variables. When
one file imports a value from another, it sees the *latest* value, not a frozen copy — but
only the file that owns it can change it. That's why some shared values come with a small
"setter" function: it's the owning file's permission slip to update them.

**Debounce.** "Wait until things go quiet before acting." When something fires rapidly (every
keystroke, every scroll tick), a debounced action holds off until the flurry stops, then runs
once. The app debounces saving-to-browser-storage so it isn't writing on every tiny change.

**requestAnimationFrame (rAF) / render coalescing.** A browser hook that runs your code right
before the screen next repaints (~60 times a second). The app "coalesces" rendering with it:
if ten things change in quick succession, it redraws *once* on the next frame instead of ten
times.

**Client vs. layout coordinates.** Two different rulers. "Client" coordinates are pixels on
the physical screen (where the mouse is). "Layout" coordinates are positions on the map's own
canvas, before zoom and pan. The app constantly converts between them — e.g. turning a mouse
click into "which map cell is that?"

**contenteditable.** A browser feature that lets you type directly into an element on the
page (not just a form box). The sidebar uses it so you can rename a row in place by clicking
its text.

**Marquee selection.** Dragging a rectangle across the map to select everything inside it —
the dashed box you draw, like selecting files on a desktop.

**Undo snapshot.** A saved copy of the whole map taken just before an edit, so "undo" can
restore it. The app keeps a short stack of these snapshots for multi-step undo/redo.
