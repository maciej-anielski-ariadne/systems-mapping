# Pathway Atlas

A standalone page for reading **everything downstream of one box** on a map too
interconnected to read directly. Not part of the app — open
`tools/pathway-atlas.html` in a browser and drop in the CSV the app's CSV button
saves. Everything runs locally; nothing is uploaded.

[Download it here.](https://github.com/maciej-anielski-ariadne/systems-mapping/raw/main/tools/pathway-atlas.html)
Right-click → Save link as, then open the file.

---

## The idea it is built on

**Never enumerate the pathways.**

The previous tool, `strand-condenser.html`, walked every route between two boxes
and folded the results as they arrived. That works up to a point and then stops:
on a 296-box map it reached about twenty million routes in eighty seconds and ran
out of memory. Raising the cap only moves the wall.

The wall is avoidable, because the complete set of pathways from a box is already
written down in the map. It is the subgraph of everything that box can reach.
Enumerating it converts a linear amount of information into an exponential amount
of paper. So this tool does not enumerate. It rewrites that subgraph into a
smaller one standing for the same pathways, and gets the counts by arithmetic
over the structure:

| step | what it does |
| --- | --- |
| **scope** | keep only what the start box can reach |
| **loops** | contract each feedback loop to a single element |
| **name** | propose a grouping from the box names |
| **refine** | split any group whose members do not behave alike |
| **decompose** | cut the result into single-entry / single-exit regions |
| **count** | exact totals by dynamic programming, in arbitrary precision |

Every step is linear or near-linear in the size of the map. A 296-box, 818-link
map builds in about 15 milliseconds. There is no progress bar because nothing is
slow enough to need one, no sampling, no budget, and no cap.

---

## The two guarantees

**Complete.** Every pathway in the map is one of the readings on screen. An
impact cannot be missed, however far it meanders. This holds on both grouping
settings and is checked in `tests/pathway-atlas.test.ts` by expanding the
on-screen tree back out and comparing it against brute force.

**Sound.** Every step on screen is a step the map actually contains. This is the
one that grouping by name quietly breaks, and it is worth being precise about
why. Fold `Cannabis Seizure` and `Cocaine Seizure` into one `◇ Seizure` and the
page will happily offer

> Cannabis Import → ◇ Seizure → Cocaine Testing

which is a sentence no route in the map says. The fix is to treat the names as a
**proposal** and then check it: a group survives only while its members agree
about which groups they lead to. Where they disagree it is split — and that split
is worth reading, because it is the map telling you where the lanes stop behaving
alike.

That check has a second effect, which is what makes the whole approach work.
Name-grouping can turn an ordinary forward path into feedback:

> Cannabis Testing → Shared Factor 3 → Cocaine Import → Cocaine Seizure → Cocaine Testing

is forward at every step, and a loop the moment both Testings become `◇ Testing`.
A tool that claims feedback the modeller never drew is worse than one that
condenses less. Refinement rules it out by construction: a loop among groups
would force an endless forward chain through an acyclic graph, so once the loops
are contracted first, no false one can appear.

---

## Grouping: the one real trade-off

The **Group boxes** control chooses when to stop refining. Both settings are
complete; they differ in how much is claimed about the members of a group.

| | As far as possible *(default)* | Only where behaviour matches |
| --- | --- | --- |
| stops when | the grouping is loop-safe | nothing more can be split |
| every step shown is real | not necessarily | yes |
| readings vs pathways | readings can exceed pathways | readings ≤ pathways |
| condensation, 296-box demo | 292 → **129** elements, 83 choice points | 292 → **254**, 208 choice points |

On the 296-box demo the looser setting halves the page, at the cost of 208 of 482
steps being taken by only part of their group. The lane badge on each branch is
what tells you which — that is not a footnote, it is the answer to "where do the
pathways differ". The stricter setting gives a page where every step is universal
and reads more like the raw map.

Start on the default. If a stretch looks wrong, switch to strict and see whether
it survives.

---

## Six ways to read it

The structure and the presentation are separate problems, and the first version
only solved the first one. A complete nested outline of 129 elements is still a
wall of words and arrows. The view switcher offers the same atlas — the identical
numbers, nothing recomputed per view — in six forms. Measured on the 296-box
demo, from one box that reaches all 296:

| View | What it is for | Height on screen |
| --- | --- | --- |
| **Flow** | The whole thing as one picture. Columns are how far along you are; block height and ribbon thickness are how much runs through. Nothing to open. | one screen |
| **Blocks** | No arrows at all. Each split is a row of blocks as wide as its share, with what follows underneath. Click one to give it the frame. | 338px |
| **Strands** | A spine with branches that leave and rejoin, the way people describe a pathway out loud. Named *and* coloured, so identity is never colour alone. | 1,007px |
| **Lane grid** | One row per element, one column per lane. A row with gaps is where the lanes stop behaving alike, and the view says nothing else. | one screen |
| **Step through** | One decision at a time. The least on screen of the six — you walk a pathway rather than read one. | one screen |
| **Outline** | The original: everything at once, nested, complete. Kept for comparison. | 1,686px |

Two of these needed a limit to be worth having. Drawn to full depth, Strands came
out 11,482px tall — worse than the outline it exists to replace — and Blocks
recursed until the blocks were slivers a few pixels wide, destroying the one
thing that view is for. Both now draw a level or two and then offer a way in,
which is what the drill-down is for.

## Reading the page

- **The spine** runs straight down: segments every pathway through that point
  follows. A segment is shared by definition — it is on screen once and stands
  for every reading that passes through it.
- **A split** shows its alternatives, commonest first, each with an exact count
  and a percentage, and says where they all meet again.
- **`◇ Seizure ×8`** is one element standing for eight boxes. Click it to see
  which.
- **`loop of 4`** is a feedback loop, contracted. A pathway enters and leaves it
  but never goes round it — that is what makes the count finite, and it matches
  how people read a strand.
- **`Cannabis, Cocaine only`** on a branch means exactly those lanes reach it.
  This is the divergence.
- **`carries on into X, opened above`** appears where two alternatives rejoin
  before the main rejoin point. Rather than printing the shared stretch twice,
  the page points at it. Nothing is lost; both readings continue identically
  from there.

**Pathways** is the true number of routes. **Readings** is how many distinct
stories the page tells. On a well-folding map readings is far smaller; where the
looser grouping is over-reaching, readings is larger, and the page says so.

---

## The name-grouping rules

A **lane** is one value of a dimension the map repeats itself along — `Cannabis`,
`Cocaine`, `Cat A`. A **role** is what a box does with its lane stripped off:
`Cat ◇ Targets`.

The family key is a **prefix and a suffix**, not a single word position. That
matters twice over:

- the varying part can be several words long — `Cat A Targets` / `Cat B Targets`
  groups on `Cat A` / `Cat B`;
- the varying parts can differ in length between members — `Class A Drug Seizure`
  and `Cannabis Seizure` land in the same family, because both share the key
  *(prefix "", suffix "Seizure")*.

Four tests keep it honest, because label similarity alone invents families:

| test | what it stops |
| --- | --- |
| **size** — at least 3 members *(adjustable)* | two boxes that happen to rhyme |
| **adjacency** — members must not be linked to each other | `Import Stage → Seizure Stage → Testing Stage`, which is a sequence, not a set of alternatives |
| **reuse** — a lane value must play its part in at least 2 roles | one coincidental pair minting a lane |
| **role** — members' neighbours must play overlapping parts | `Pick rate` / `Damage rate`, which share a word and nothing else |

Bare numbers are never lane values: `Overtime 3` is an instance counter, not a
lane. Two controls in the rail move the first and third thresholds so you can see
what appears and vanishes on your own map.

---

## What it does not do

- **It does not rank.** Elasticities are read from the CSV but not yet used to
  weight or order the alternatives; ordering is by how many readings run through
  each. If sorting by strength would help, that is a small addition.
- **It runs downstream only.** The start box is a source, not a destination.
- **The looser grouping over-approximates**, as set out above, and says so on
  screen when it does.

---

## Working on it

The engine lives inside `tools/pathway-atlas.html` between the
`ATLAS-ENGINE-START` and `ATLAS-ENGINE-END` markers. `tests/pathway-atlas.test.ts`
reads it out of the file and runs against it, so there is only ever one copy to
be wrong. Edit the HTML, then `npm test`.
