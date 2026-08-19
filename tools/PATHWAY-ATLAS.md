# Pathway Atlas

A standalone page for reading **everything downstream of one box** on a map too
interconnected to read directly. Not part of the app — open
`tools/pathway-atlas.html` in a browser and drop in the CSV the app's CSV button
saves. Everything runs locally; nothing is uploaded.

There is no demo map and no sample data: the page is empty until you load your
own file, so nothing on screen is ever something other than your map.

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
impact cannot be missed, however far it meanders. It is checked in
`tests/pathway-atlas.test.ts` by expanding the on-screen tree back out and
comparing it against brute force.

**Sound.** Every step on screen is a step the map actually contains. This is the
one grouping by name can break at the edges, and it is worth being precise about
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

## Grouping, and the one real trade-off

Three settings used to sit in the rail. They are now fixed, because a page whose
answer depends on which switches you left on is a page you cannot quote:

| | fixed at | why |
| --- | --- | --- |
| how far to group | **as far as possible** | hold a group together up to the point where holding it together would invent feedback the map does not contain — the most condensation available without inventing anything |
| smallest family | **3 boxes** | two boxes that happen to rhyme are a coincidence; three sharing a prefix and a suffix are a pattern |
| lane reuse | **2 roles** | a lane value must play its part in more than one role, so a single coincidental pair cannot mint a lane |

The first of these is the trade-off. Grouping as far as possible is always
**complete** — no pathway is missed — but it is not always **sound**: some
members of a group go on to differ, so the page can offer more readings than
there are real pathways, and it says so at the top when it does. On the 296-box
test map that is 208 of 482 steps taken by only part of their group, and the
page condenses 292 elements to 129 rather than 254.

The honest answer to "which members?" is not a switch, it is the element itself:
click any block and the rail lists every box inside it.

## Flow, which is the whole thing as one picture

The structure and the presentation are separate problems, and the first version
only solved the first one. A complete nested outline of 129 elements is still a
wall of words and arrows. Six presentations were built and measured against each
other — proportional blocks, parallel strands, a lane grid, one step at a time,
and the outline — and **Flow** is the one that stayed:

- columns are how far along a pathway you are;
- the height of a block and the thickness of a ribbon are how much of everything
  runs through it;
- there is nothing to open and no reading order — the shape *is* the answer;
- clicking a block puts its contents in the rail: every box the element stands
  for, however many.

On the 296-box test map it is one screen. The other five are gone; what they
were each good at is recorded in the git history if any of it is wanted back.

**Loops** keeps its own tab for now, because feedback is not yet drawn into the
Flow picture — see below.

## Feedback loops

Contracting a tangle to one element keeps the counting honest, but on its own it
turns the most interesting part of a map into a black box. On a test map one
tangle held **108 boxes and 79 independent loops**, and the only thing the page
said about it was 108 names joined by arrows.

Three things fixed that.

**A tangle is not a loop.** It is many loops sharing edges. The unit people
actually think in is the single loop, so the tool now decomposes each tangle into
individual loops rather than showing the tangle whole.

**Polarity and gain, which were being thrown away.** Both fall straight out of
the elasticities already in the CSV — multiply the signs for one, the magnitudes
for the other — and neither was being used:

| | | |
| --- | --- | --- |
| **Reinforcing** | an even number of negative links | a nudge comes back amplified; it runs away or collapses unless something else holds it |
| **Balancing** | an odd number | a nudge comes back opposed; it settles, and resists being pushed |

**Which loops to show.** A tangle can hold more loops than anyone will read. The
page takes the *shortest loop through each box*, then ranks by gain. That gives
two properties worth having: no box in the tangle is left without a story, and
the ones that actually move the system come first. On the 108-box tangle it turns
79 independent loops into 43 readable ones.

Each loop is drawn as a **ring**: boxes round a circle, arrows following it, a
`+` or `−` on every link, and a big **R** or **B** in the middle. Past eight
boxes a ring stops being readable — labels collide and it stops looking circular
— so a long loop is laid out flat with the closing link drawn as a return.
Where every box in a loop sits in one lane, the card names the lane once and the
ring drops it, so `Cat A Treatment Referral` reads as `Treatment Referral`
instead of being clipped to `Cat A Treatmen…`.

Loops live in two places: a **Loops view** listing every one on the map, sortable
by gain, length or polarity; and inline in Flow, where a tangle is one amber
block that opens into the rings when clicked. Drawing the two as a single
picture — feedback where it sits in the flow rather than on its own tab — is the
work still to do.

**One thing worth knowing about your data.** If two boxes are joined by two links
that disagree about sign, the polarity of every loop through them depends on
which link you take. Silently picking whichever was listed first would make the
answer arbitrary, so the stronger link wins and the count of disagreements is
reported rather than swallowed.

## Reading the page

- **A block** is one element: a box, a group of boxes that behave alike, or a
  contracted feedback tangle (amber). Its height is how much of everything runs
  through it.
- **`◇ Seizure ×8`** is one element standing for eight boxes. Click it and the
  rail names all eight.
- **A ribbon** is a step, and its thickness is the same measure — so a thin
  ribbon out of a tall block is a rare way on from a common place.
- **A contracted tangle** is entered and left but never gone round, which is
  what makes the count finite and matches how people read a strand. Click it for
  its loops.
- **Pathways** is the true number of routes; **readings** is how many distinct
  stories the page tells. On a well-folding map readings is far smaller; where
  grouping is over-reaching, readings is larger, and the note at the top says so.

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
| **size** — at least 3 members | two boxes that happen to rhyme |
| **adjacency** — members must not be linked to each other | `Import Stage → Seizure Stage → Testing Stage`, which is a sequence, not a set of alternatives |
| **reuse** — a lane value must play its part in at least 2 roles | one coincidental pair minting a lane |
| **role** — members' neighbours must play overlapping parts | `Pick rate` / `Damage rate`, which share a word and nothing else |

Bare numbers are never lane values: `Overtime 3` is an instance counter, not a
lane. Every family the page found is listed in the rail, and each one opens to
show its members and the lane value each contributes — which is how you check
that the dimensions it found are the dimensions you think in.

---

## What it does not do

- **It does not rank the pathways.** Elasticities decide loop polarity and gain,
  but not the order of what leads where; that ordering is by how many readings
  run through each. Sorting by strength would be a small addition.
- **It runs downstream only.** The start box is a source, not a destination.
- **Feedback is on its own tab.** Loops are analysed and drawn, but not yet
  placed where they sit in the Flow picture.
- **Grouping over-approximates**, as set out above, and says so on screen when
  it does.

---

## Working on it

The engine lives inside `tools/pathway-atlas.html` between the
`ATLAS-ENGINE-START` and `ATLAS-ENGINE-END` markers. `tests/pathway-atlas.test.ts`
reads it out of the file and runs against it, so there is only ever one copy to
be wrong. Edit the HTML, then `npm test`.
