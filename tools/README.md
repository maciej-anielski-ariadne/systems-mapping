# `tools/` — standalone analysis tools

Single-file HTML tools that are **not part of the app**. They aren't built,
bundled, or shipped in `dist/systems-map.html`; each one is a self-contained
page you open directly in a browser. Nothing here is loaded by `index.html`.

| File | What it's for |
|------|---------------|
| [`strand-condenser.html`](strand-condenser.html) | Compare four ways of condensing a huge set of near-identical strands, on your own map. |

## `strand-condenser.html`

**Open it:** download the file and double-click it (or drag it into a browser
tab). It needs no server and no install. Everything runs in the page — your
spreadsheet is never uploaded anywhere.

**Load your map:** click **Choose a .csv file…**, or drop the file anywhere on
the page. Use the CSV the app itself saves with the **CSV** header button —
the multi-section format with `# SECTION: nodes` and `# SECTION: edges` in it.
Until you load one, the tool runs on a synthetic 296-box / 839-link map so
there is always something to look at.

**Then:** hit **Worst case** to jump straight to the pair of boxes with the
most routes between them — the trace that breaks the list — or pick a From and
To yourself and hit **Condense**.

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
| **Strongest first** | What the app does today. The baseline, for comparison. |
| **Most different** | Same number of rows, chosen greedily so each is as unlike the others as possible. Each row is labelled with the boxes that appear in it alone. |
| **Families** | Group routes that share a spine and show the differing stretch as a slot. |
| **Where they differ** | No list at all — name the boxes where routes actually split, and how the routes through each one divide. |

### Reading the numbers

The stat strip is the point of the tool.

- **Closest pair** — how different the two most *similar* rows on screen are.
  This is the honest measure of a list's redundancy: one near-duplicate
  anywhere is what makes a list feel repetitive. Low is bad.
- **Boxes covered** — how much of the map the rows touch between them. For a
  fixed number of rows, more is more informative.
- **Repeated boxes** — boxes appearing in half the rows or more. These are
  dimmed in the chains, so what is left highlighted is the difference.

### What it found

Measured on a synthetic map matched to a real one (296 boxes, 839 links,
hub-weighted wiring), for the pair with the most routes:

| | Strongest 8 | Most different 8 |
|---|---|---|
| Closest pair | 25% different | **77% different** |
| Boxes covered | 15 | **48** |

Same number of rows, three times the coverage, and no two rows near-identical.

Two findings argue against the structural approaches:

- **There is usually no spine.** Checking which boxes *every* route must pass
  through gave 0–3 on maps of this density — often zero. So "factor out the
  shared spine and show the rest as variants" has nothing to factor out. The
  **Families** view shows this failure directly, and says so when a slot grows
  wide enough that the grouping has stopped meaning anything.
- **Clustering the top ten is clustering a rounding error.** With 200,000+
  routes, ten is 0.005% of the space; whatever structure comes out describes
  the sample, not the map.

### Caveats

- Figures are computed on a **sample** — the first 30,000 routes the walk
  finds, capped by the same 400,000-step budget the app uses. That sample is
  depth-first-biased, not uniform, which is fine for box frequencies and fork
  points but does mean "most different" picks from a skewed pool.
- The default map is **synthetic**. It has hubs, but not the real bottlenecks a
  hand-built map has. Load your own CSV before drawing conclusions.
