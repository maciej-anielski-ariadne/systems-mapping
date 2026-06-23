# `assets/js/` — the app's TypeScript

**Entry point:** [`18-main.ts`](18-main.ts). `index.html` loads only that file; it
imports every other module in order, restores your saved session, and boots the map.

**Why the numbers?** Files are prefixed `01-`, `02-`, … to fix the **load order**
(lower numbers are foundations the higher ones build on). Letter suffixes (`04a`, `16e`)
slot a related file in without renumbering everything after it. So you read the folder
top-to-bottom: data model → parsing → simulation → layout → rendering → UI → editing.

**Two big features are split across several files** (each file's header comment explains
how the pieces fit):

- **Build / Edit wizard** — `16a-builder-state.ts` (state + validation),
  `16b-builder-render.ts` (UI), `16c-builder-editor.ts` (cell editor),
  `16d-builder-events.ts` (events).
- **Canvas direct edit** (the main editing path) — `16e-canvas-edit.ts` (gestures),
  `16f-canvas-mutations.ts` (add/delete/reorder), `16g-canvas-undo.ts` (undo),
  `16h-canvas-inline-rename.ts`, `16i-canvas-keyboard-nav.ts`, `16j-multi-select-bar.ts`.

`types.ts` holds the shared data-model types every module imports.

**Hit an unfamiliar term?** Comments explain jargon in plain language at first use and
point to [`docs/GLOSSARY.md`](../../docs/GLOSSARY.md) — a non-programmer's reference for
terms like *Cobb-Douglas*, *bezier*, *BFS/DFS*, *topological sort*, and *event delegation*.

**Don't know which file?** Every file opens with a comment header describing its job. For
a one-line index of all of them, and a "I want to change X → open this file" table, see
the top-level [README](../../README.md#files) (**Files** and **Editing the app** sections)
— that's the source of truth this folder is kept in sync with.
