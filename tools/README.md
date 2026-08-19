# `tools/` — standalone analysis tools

Single-file HTML tools that are **not part of the app**. They aren't built,
bundled, or shipped in `dist/systems-map.html`; each one is a self-contained
page you open directly in a browser. Nothing here is loaded by `index.html`.

| File | What it's for |
|------|---------------|
| [`strand-condenser.html`](strand-condenser.html) | Walk every route between two boxes, fold away the repeated lanes, and show only where the pathways differ. |

## `strand-condenser.html`

**Open it:** download the file and double-click it (or drag it into a browser
tab). It needs no server and no install. Everything runs in the page — your
spreadsheet is never uploaded anywhere.

**Load your map:** click **Choose a .csv file…**, or drop the file anywhere on
the page. Use the CSV the app itself saves with the **CSV** header button —
the multi-section format with `# SECTION: nodes` and `# SECTION: edges` in it.
Until you load one, the tool runs on a built-in demo so there is always
something to look at.

**Then:** hit **Worst case** to jump straight to the pair of boxes with the
most routes between them — the trace that breaks the list — or pick a From and
To yourself and hit **Condense**. The two box pickers filter as you type
(arrows to move, Enter to pick, Esc to cancel), because a native dropdown
holding a few hundred boxes cannot be typed past its first letter.

### The problem it exists to test

Pathway mode ([`assets/js/09a-pathways.ts`](../assets/js/09a-pathways.ts))
ranks routes by strength and keeps the strongest ten. On a small map that is
fine. On a large one, a single pair of boxes can have hundreds of thousands of
routes between them, and the strongest ten turn out to be *the same route
printed ten times with small edits* — you flip through four rows before
reaching a genuinely different idea.

The tool runs four condensation strategies over the same route set so they can
be compared on real data rather than argued about:

| Strategy | What it does |
|----------|--------------|
| **Sections** | Fold away the repeated lanes (see below), then group by the shape that is left. The default, and by far the strongest when a map has parallel structure. |
| **Most different** | A fixed number of concrete routes, chosen greedily so each is as unlike the others as possible. Each is labelled with the boxes that appear in it alone. Needs no structure at all. |
| **Strongest first** | What the app does today. The baseline, for comparison. |
| **Where they differ** | No list at all — name the boxes where routes actually split, and how the routes through each one divide. |

## Lanes: the idea Sections is built on

In a real map the repetition is **systematic, not random**. The same chain
appears once per drug type, per region, per product line — *Cannabis Seizure*,
*Cocaine Seizure*, *Heroin Seizure*. Those parallel copies are one story told
N times, so the way to condense them is to **abstract over the thing that
varies**, not to sample or rank.

- A **lane** is one value of that varying dimension (Cannabis, Cocaine, …).
- A **role** is what a box does once its lane is stripped off: `◇ Seizure`.

Two routes that differ only in which lane they ran through are the same story,
and fold into one **section**. What survives on screen is the set of genuinely
different shapes.

**Finding the lanes** — four ways, in the left rail, because no one way is
reliable:

| Mode | How it works |
|------|--------------|
| **Box names (auto)** | Labels differing by exactly one word are candidates. |
| **Structure only** | Boxes interchangeable in the graph, names ignored. Use when naming is inconsistent. |
| **The map's own tags** | Your `category` column already says which lane a box is in. |
| **The map's own rows** | Same, using `stream`. |
| **Don't collapse lanes** | Off, for comparison. |

The name-based mode rests on two tests, and both are load-bearing.

**Not a sequence.** *Cannabis Seizure* and *Cocaine Seizure* differ by one word
— but so do *Cannabis Import* and *Cannabis Seizure*, and those are a
**sequence**, not alternatives. Lane members are alternatives to one another,
so none of them is linked to another; a sequence always fails that, parallel
lanes always pass. Bare numbers are excluded too, since *Overtime 3* is an
instance counter rather than a lane.

**Same part in the graph.** *Pick rate* / *Damage rate* / *Contract rate* is a
perfectly good one-word family that passes everything above — but those boxes
merely share a noun, and folding them invents lanes that explain nothing. Names
cannot settle it; the graph can. Boxes that really are the same box once per
lane **play the same part**: they sit between the same kinds of neighbour. So
each box gets a provisional role from its name, and a family is kept only if
its members' neighbours play the same *roles*. Comparing roles rather than box
ids is what lets this work for lanes that share no infrastructure at all.

On the 296-box demo, whose boxes are not parallel copies, these tests cut the
false lanes from 15 to 6 and the boxes folded from 65 to 6. It is a heuristic,
not a proof — check the lane list in the left rail against what you know.

### Reading a section

    360 routes   [Cocaine, Heroin only]
    Border Force FTE → ◇ Seizure(all 6) → Street price → ◇ Import(Cocaine, Heroin)
      → ◇ County lines(Cocaine, Heroin) → … → Prison places

The badge is the thing to read. **all 6 lanes** means the common story, told
once instead of six times. A named subset means a **real divergence** — a step
some lanes take and others do not. `Sections to show → Only where the lanes
differ` filters to exactly those.

A section is counted as a divergence when *some position* in it is reachable by
only some lanes. Asking instead whether the whole section's lanes add up to
everything gets the wrong answer: a shape can touch all six lanes across its
length while still containing a step that only two of them take.

### Reading the numbers

The stat strip is the point of the tool.

- **Condensation** — routes divided by sections. `139×` means the whole route
  set was 139 tellings of each distinct story. `1.0×` means folding bought
  nothing, and the tool says so rather than pretending otherwise.
- **Lane-specific** — how many sections contain a step only some lanes take.
  These are the divergences worth reading.
- **Closest pair** — how different the two most *similar* rows on screen are.
  This is the honest measure of a list's redundancy: one near-duplicate
  anywhere is what makes a list feel repetitive. Low is bad.
- **Boxes covered** — how much of the map the rows touch between them. For a
  fixed number of rows, more is more informative.
- **Repeated boxes** — boxes appearing in half the rows or more. These are
  dimmed in the chains, so what is left highlighted is the difference.

### Every route, not a sample

The walk is exhaustive — there is no sampling and no step budget. It is
affordable because results are folded into running totals **as routes are
found** rather than kept: memory grows with the number of distinct *shapes*,
which is small, and not with the number of routes, which is not.

The search runs in slices so the page keeps painting; a long walk shows live
progress and can be stopped, and stopping still shows everything found so far,
labelled as partial. The comparison views draw on a **reservoir sample** of
20,000 routes, which gives every route an equal chance of being kept — unlike
"the first N found", which is heavily biased toward whichever branch the walk
entered first.

### What it found

Measured on a synthetic map matched to a real one (296 boxes, 839 links,
hub-weighted wiring), for the pair with the most routes:

| | Strongest 8 | Most different 8 |
|---|---|---|
| Closest pair | 25% different | **77% different** |
| Boxes covered | 15 | **48** |

Same number of rows, three times the coverage, and no two rows near-identical.

On the parallel-lanes demo, where the structure is the kind a real enforcement
map has, folding does far better than any amount of ranking:

    2,505 routes  →  18 sections   (139x)   of which 10 are lane-specific

Three findings shaped the design:

- **Lanes beat everything else, when they exist.** 139x from folding, against
  roughly 2x-3x of usable improvement from any ranking strategy. On the demo,
  the three detection modes (names, tags, rows) independently agree on the same
  six lanes — a good sign the technique is not fitting noise.
- **There is usually no spine.** Checking which boxes *every* route must pass
  through gave 0-3 on dense maps, often zero. So "factor out the shared spine
  and show the rest as variants" has nothing to factor out. This is why there
  is no Families view any more.
- **Clustering a top ten is clustering a rounding error.** With 200,000+
  routes, ten is 0.005% of the space; whatever structure comes out describes
  the sample, not the map. Hence exhaustive enumeration.

### Caveats

- **Sections only helps if your map has repeated structure.** On the 296-box
  demo, whose boxes are not parallel copies of one another, condensation is
  1.0x and the view degenerates into the raw list. It says so on screen.
- **Lane detection is a heuristic.** It can miss families whose names do not
  line up, and it picks the largest family when a box could belong to several.
  Check the lane list in the left rail against what you know before trusting
  the fold.
- **The demo maps are synthetic.** They are shaped like the real thing but do
  not have its quirks. Load your own CSV before drawing conclusions.
