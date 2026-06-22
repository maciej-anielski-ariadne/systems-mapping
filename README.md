# Systems Map

CSV-driven interactive systems map. Single standalone HTML file, no dependencies, no server, no build step required at runtime. Open the HTML, drop in a CSV, get a layered causal diagram with live what-if simulation.

Domain-agnostic — any system you can express as nodes-with-streams-and-stages plus signed edges will render. The default sample CSV is a small neutral worked example (a three-team product company — 12 nodes, 12 edges) that exercises every feature of the app while staying small enough to grok at a glance.

## Quick start

1. Open `index.html` in any modern browser. (Works fully offline — fonts and code are bundled locally.)
2. The app boots into an **empty 3×3 starter grid** — three streams (rows), three stages (columns), no nodes yet. From here you have three paths:
   - **Build directly on the canvas** (recommended for non-technical users). Click any empty cell to add a node, then rename it in the right panel. Drag from the right edge of a node to another node to draw an edge. Edit streams / stages / categories from the left sidebar (pencil icon to rename / delete, drag handle to reorder, **+ Add** buttons at the bottom of each section).
   - **Import an existing CSV** — click **Import Data** in the header, or drag-drop a `.csv` onto the window.
   - **Bulk edit via the wizard** — click **Edit Data** in the header to open a six-step form (streams → stages → categories → nodes → edges → review). Useful for big edits where the canvas is too fiddly. Hit **Apply to map** to re-render, or **Download CSV** to save a snapshot.
3. Iterate freely. Every canvas edit auto-saves to your browser, so a page refresh restores everything. Click **Export Data** in the header to download the current map as a CSV.

The header has six buttons left-to-right: **Create Map · Edit Data · Import Data · Export Data · Simulate · Reset view**. (**Create Map** clears the canvas and starts a fresh empty grid, asking for confirmation if a map is loaded. **Edit Data** is dimmed until a map exists.)

## What you get

- Layered layout: streams (rows) × stages (columns), nodes placed in grid cells, edges as bezier curves.
- Click a node → highlights its direct inputs (blue) and direct impacts (amber), dims everything else.
- Click a stream label (sidebar or row header) → collapse / expand the whole stream.
- **Smart search** → fuzzy match across every node field — name, description, stream, stage, category, ID, and unit — ranked in that priority order (handles typos like "brder" → "Border" and word-initials like "bff" → "Border Force FTE"). So searching a stream/stage/category name surfaces every node in it. Top results show as a dropdown below the search box, with the matched text highlighted; matching nodes get an amber halo on the map. Press `/` from anywhere on the page to jump to the search box.
- Detail panel → category, stream, stage, baseline + current values, all direct inputs/impacts with per-edge elasticities, click-through navigation. **Edit Node** toggle turns the panel into an edit form (every field as an input, per-row outgoing-edge editor, delete button).
- **Canvas direct edit** → click an empty grid cell to add a node, drag from a node's right edge to another node to draw an edge, press Delete on a selected node to remove it (with a 6-second undo toast). Streams / stages / categories are edited from the left sidebar (pencil to rename / re-colour, drag handle to reorder, **+ Add** at the bottom of each section).
- **Build / Edit wizard** → optional six-step in-app form (streams → stages → categories → nodes → edges → review) with dropdowns for every cross-reference, live validation, and round-trip with the current map. Click **Edit Data** in the header. Useful for bulk edits where the canvas is too fiddly.
- **Simulation mode** → sliders **and** typeable number inputs on every controllable node, grouped by stream. Downstream values recompute live (Cobb-Douglas propagation). The selected node's `Current` value is also editable from the detail panel.
- Outcome nodes get green / red halo colouring when their direction-of-merit metric moves materially from baseline.
- **Collapsible side panels** → click the pin icon in either panel header to collapse it to a thin strip; hover the strip to peek the contents, click the pin again to re-pin.
- **Zoom** → bottom-right `−` / `+` buttons, `Ctrl/Cmd` + scroll-wheel (or trackpad pinch), or `Ctrl/Cmd + =/-/0` to zoom in / out / reset. Pinching anchors on the cursor.
- **Pan** → click-and-drag any empty area of the map to pan around it. Plain scroll-wheel and trackpad two-finger scroll also pan.
- **Survives a refresh** → the loaded CSV, hidden filters, simulation mode + slider positions, selected node, zoom level, panel pin state, and any unsaved wizard work are all persisted in `localStorage`. Close the tab, reopen, keep going. (Loading a different CSV via **Import Data** / applying the wizard replaces what's stored.)

## CSV format

Single file. Six sections delimited by `# SECTION: <name>` lines. Each section has its own column headers on the first non-comment row. Lines starting with `#` are comments, empty lines are ignored. Order doesn't matter to the parser but sections are typically written in build order: structure first, then content.

Edit in any spreadsheet app — each section appears as its own distinct table block. Quote cells with embedded commas; use `""` to escape literal quotes.

### `streams`

Map rows.

| Column | Meaning |
|--------|---------|
| `id`    | Unique identifier. Lowercase, no spaces. Referenced from nodes. |
| `label` | Display name (sidebar + detail panel). |
| `short` | Short label on the row header (uppercase, ~6 chars). |
| `color` | Hex colour for the left bar on each node in this stream. |

### `stages`

Map columns. Rendered left-to-right in the order they appear in this section.

| Column | Meaning |
|--------|---------|
| `id`    | Unique identifier. |
| `label` | Column header text on the map. |

### `categories`

Node types — visual differentiation by colour.

| Column | Meaning |
|--------|---------|
| `id`         | Unique identifier. |
| `label`      | Sidebar legend label. |
| `color`      | Node fill colour (hex). |
| `text_color` | Label colour over the fill. Pick high contrast. |

### `defaults`

Key-value rows. Three keys used when an edge's `elasticity` cell is blank:

| Key | Default | Meaning |
|-----|---------|---------|
| `elasticity_enables`   |  0.30 | Default for `enables` edges (structural prerequisite). |
| `elasticity_increases` |  0.25 | Default for `increases` edges. |
| `elasticity_decreases` | -0.25 | Default for `decreases` edges (negative). |

### `nodes`

| Column | Required | Meaning |
|--------|----------|---------|
| `id`           | yes | Unique identifier. Referenced from edges. |
| `label`        | yes | Display name on the node. |
| `description`  | no  | Tooltip + detail panel description. |
| `stream`       | yes | Must match an id from `streams`. |
| `stage`        | yes | Must match an id from `stages`. |
| `category`     | yes | Must match an id from `categories`. |
| `baseline`     | no* | Numeric baseline value (e.g. 100, 9000, 25). |
| `unit`         | no  | Unit string shown after the value (e.g. `units`, `staff`, `min`, `£bn/yr`, `%`, `index`). |
| `controllable` | no  | `true` to expose this node as a slider in Simulation mode. Use only for exogenous inputs. |
| `direction`    | no  | `higher_better` / `lower_better` / `neutral`. Drives outcome colouring. |
| `slider_max`   | no  | Maximum slider multiplier (e.g. `2.0` = up to 200% of baseline). Default 2.0. |

*Without `baseline` + `unit` a node renders structurally but shows no value and doesn't participate in simulation.

### `edges`

| Column | Required | Meaning |
|--------|----------|---------|
| `from`        | yes | Source node id. |
| `to`          | yes | Target node id. |
| `effect`      | yes | `enables` / `increases` / `decreases`. Determines arrow colour and default elasticity sign. |
| `elasticity`  | no  | Per-edge override (signed number). Blank = use the default for the effect type. |
| `description` | no  | Shown in detail panel. |

## Build / Edit wizard

Click **Edit Data** in the header (or **Create Map** first if you want a fresh start) to open a full-screen wizard that constructs the same CSV without you typing any CSV syntax. The canvas direct-edit flow is usually faster for small tweaks; the wizard shines when you're doing bulk edits or want to see all fields for a row at once.

Six steps in build order:

1. **Streams** — rows of the map. Each gets a colour picker. A **Start from sample** shortcut pre-fills the taxonomy from the bundled sample if you want a scaffold rather than a blank canvas.
2. **Stages** — columns, left-to-right.
3. **Categories** — node types, with fill + label colour pickers.
4. **Nodes** — table view. The stream / stage / category columns are dropdowns sourced from steps 1–3, so cross-reference typos are structurally impossible. Optional simulation fields (baseline, unit, controllable, direction, slider_max) sit alongside the required ones.
5. **Edges** — table view. The **from** / **to** columns are dropdowns sourced from step 4. The three default elasticities sit above the table for quick tuning.
6. **Review** — counts of everything, all validation issues in one place, and the two CTAs:
   - **Apply to map** — round-trips through the same CSV loader as a drag-drop, so all validation runs.
   - **Download CSV** — saves a `.csv` with comments + section headers (drag back in later, or share with colleagues).

Other niceties:

- **Round-trip editing** — opening the wizard while a map is loaded pre-populates every field from the live data. Tweak anything, hit Apply, the map updates.
- **ID auto-fill** — typing a label fills the id (`Air Passenger` → `air_passenger`) on first edit, then leaves it alone so you can override.
- **Duplicate row** — useful for entering many similar nodes that differ only in a field or two. The id is wiped on the duplicate so you don't end up with a duplicate.
- **Live validation** — duplicate ids, unresolved cross-references, blank required fields are flagged on the row and counted in the footer. Apply is disabled until the count is zero.
- **Escape** closes the wizard without applying.

## Simulation model

Cobb-Douglas propagation, solved iteratively:

```
value_target = baseline_target × ∏ (current_source / baseline_source) ^ elasticity_edge
```

- Controllable nodes (sliders): `value = baseline × user_multiplier`.
- Every other node: value computed from its incoming edges.
- The solver sweeps nodes in topological order and iterates to a fixed point. On an acyclic map a single sweep resolves every node, so results are exact. On a map with **feedback loops** it keeps sweeping — each pass feeds the loop's values back into itself — until they converge (or a 100-iteration safety cap is hit).
- Output is always positive, smooth, handles compounding inputs naturally, degrades gracefully at extremes (a source ratio of 0 collapses targets through any positive elasticity).
- The `effect` label sets the default elasticity sign; a per-edge `elasticity` override always wins.

### Feedback loops

Edges may form loops — an output feeding back to affect an upstream input. Negative-feedback loops settle quickly; a runaway positive loop (gain ≥ 1) can't settle, so its values are clamped to something finite and a warning is shown (at load and on the simulation panel). Lower the elasticities on the loop to bring it back into a stable range.

### A note on directional semantics

The structural `effect` label describes the **causal role** ("X is the upstream cause of Y"). The `elasticity` describes the **direction and magnitude in simulation**. These can disagree.

Example: in the UK border sample, `pcp_inspection → passenger_wait_time` is labelled `increases` because PCP processing is structurally the cause of wait time at the border, but the elasticity is **-0.55** because in the simulation `pcp_inspection` represents PCP throughput capacity — more capacity = less wait. The detail panel always shows the elasticity explicitly so this is auditable.

This pattern recurs anywhere an upstream is a capacity/intensity and the downstream is a delay. Reasonable people will model the same edge differently. Override the elasticity if you disagree with the included values.

## Validation

Loader checks every load and reports findings in a toast (top-right) and the console:

- Required sections present and non-empty: `streams`, `stages`, `categories`, `nodes`. Missing any → fatal, nothing loads.
- Every node's `stream` / `stage` / `category` references resolve. Unresolved → warning, node still loads.
- Every edge's `from` / `to` references a known node. Unresolved → warning, edge dropped.
- No duplicate node IDs. Duplicate → warning, second occurrence dropped.
- Edge `effect` is one of `enables` / `increases` / `decreases`. Invalid → warning, edge dropped.

## Files

```
systems_mapping/
├── index.html                       The app entry point — open this in a browser
├── README.md                        This file
└── assets/
    ├── fonts/
    │   ├── fonts.css                @font-face declarations pointing to local files
    │   └── files/*.woff2            24 bundled font files (Fraunces, IBM Plex)
    ├── css/
    │   ├── 01-variables.css         Colours, fonts — change here to retheme
    │   ├── 02-base.css              CSS reset + body + grid background
    │   ├── 03-app-shell.css         Outer 3-column grid + top header + panel pins
    │   ├── 04-sidebar.css           Left sidebar (filters, legend) + unpinned strip
    │   ├── 05-visualization.css     Central SVG + nodes + edges + row/col labels
    │   ├── 06-detail-panel.css      Right panel (selected-node details) + unpinned strip
    │   ├── 07-tooltip.css           Hover popup + UI tooltips
    │   ├── 08-simulation.css        Simulation slider + typeable-input panel
    │   ├── 09-drop-zone.css         "Drop a CSV here" overlay
    │   ├── 10-misc.css              Toast, status bar, zoom controls, no-data dimming
    │   ├── 11-builder.css           Build / Edit wizard overlay
    │   ├── 12-no-borders.css        Global override — strips every CSS border, replaces
    │   │                            state with drop-shadows / box-shadows
    │   └── 13-search.css            Search dropdown + map-match halo
    ├── js/
    │   ├── 01-sample-data.js        Embedded SAMPLE_CSV string (sample.csv copy)
    │   ├── 02-config.js             Pixel sizes (NODE_WIDTH etc.) + shared option lists
    │   ├── 03-state.js              Shared globals (state, NODES, EDGES, …)
    │   ├── 04-utils.js              wrapLabel / escapeHtml / formatScalar / clone helpers
    │   ├── 04a-storage.js           localStorage persistence (CSV, UI, wizard)
    │   ├── 05-csv-parser.js         Multi-section CSV parser (CSV → data)
    │   ├── 05a-csv-serializer.js    Multi-section CSV serializer (data → CSV)
    │   ├── 06-data-loader.js        loadDataFromCsv + rebuildIndexes
    │   ├── 07-simulation-engine.js  Cobb-Douglas propagation + applySimMultiplier
    │   ├── 08-layout.js             Node positioning
    │   ├── 09-graph-selection.js    Ancestor/descendant traversal + selectNode
    │   ├── 10-filters.js            Stream / category visibility
    │   ├── 11-rendering.js          Main SVG renderer
    │   ├── 12-tooltip.js            Hover popup + generic UI-tooltip helper
    │   ├── 13-sidebar.js            Renders the left filter UI
    │   ├── 14-simulation-panel.js   Renders the slider + number-input UI
    │   ├── 15-detail-panel.js       Renders the right-side details
    │   ├── 16-file-io.js            Drag-drop, file picker, CSV download
    │   ├── 16a-builder-state.js     Wizard: state seeding, validation, helpers
    │   ├── 16b-builder-render.js    Wizard: HTML output for the six steps
    │   ├── 16c-builder-editor.js    Wizard: floating "expand this cell" editor
    │   ├── 16d-builder-events.js    Wizard: click / typing / drag handlers
    │   ├── 16e-canvas-edit.js       Canvas gestures: ghost cell, edge drag, delete
    │   ├── 16f-canvas-mutations.js  Sidebar mutations: add/delete/reorder for
    │   │                            streams, stages, categories + the single
    │   │                            applyCanvasMutation() chokepoint
    │   ├── 16g-canvas-undo.js       Undo snapshots + the bottom-of-screen toast
    │   ├── 17-events.js             Wires up search box, buttons, drag-drop, zoom, pan, pins
    │   ├── 17a-search.js            Fuzzy search: scoring, dropdown, map highlights
    │   └── 18-main.js               Startup — restores persisted state
    └── data/
        ├── sample.csv               Small neutral example (3 streams, 12 nodes, 12 edges).
        │                            Powers "Load Sample" + "Download Sample".
        └── empty_template.csv       Empty starter with structure + inline comments.
                                     Reference only — no button loads it.
```

### Why so many small files?

The app was originally a single ~2,500-line HTML file. Splitting it into
~35 small, well-commented files makes it easier for:

- Non-technical editors to find and tweak one thing (e.g. colours live in
  exactly one file: `assets/css/01-variables.css`).
- AI coding assistants to work on one feature without holding the entire
  app in context.

Each file opens with a comment header explaining its job and which other
file calls into it. Most JS files are under 300 lines. The two biggest
features are split across multiple files:

- The **Build / Edit wizard** is split across `16a-builder-state.js`,
  `16b-builder-render.js`, `16c-builder-editor.js`, `16d-builder-events.js`.
  See the comment header of `16a-builder-state.js` for the overview.
- **Canvas direct edit** (the primary editing path — click a cell to add
  a node, drag from a node edge to draw a link) is split across
  `16e-canvas-edit.js` (the gestures), `16f-canvas-mutations.js` (the
  sidebar-driven add/delete/reorder helpers), and `16g-canvas-undo.js`
  (snapshot + toast). See the comment header of `16e-canvas-edit.js`.

## Editing the app

| To change… | Edit… |
|------------|-------|
| Colours, fonts | `assets/css/01-variables.css` |
| The sample CSV that comes built-in | `assets/data/sample.csv` (and re-export the JS constant — see note below) |
| The size of nodes / spacing | `assets/js/02-config.js` |
| The list of valid edge effects, outcome directions, stream colour palette | `assets/js/02-config.js` |
| How nodes propagate values | `assets/js/07-simulation-engine.js` |
| How nodes are positioned | `assets/js/08-layout.js` |
| How nodes/edges are drawn | `assets/js/11-rendering.js` |
| The right detail panel | `assets/js/15-detail-panel.js` |
| Canvas direct-edit gestures (click a cell → node, drag from edge → arrow) | `assets/js/16e-canvas-edit.js` |
| Sidebar add / delete / reorder for streams, stages, categories | `assets/js/16f-canvas-mutations.js` |
| The Build / Edit wizard | `assets/js/16a-builder-state.js` (state + validation), `16b-builder-render.js` (UI), `16c-builder-editor.js` (cell editor), `16d-builder-events.js` (events), `assets/css/11-builder.css` (styles), `assets/js/05a-csv-serializer.js` (CSV writer) |
| Undo snapshot behaviour / toast | `assets/js/16g-canvas-undo.js` |
| Search behaviour / fuzzy matching | `assets/js/17a-search.js`, `assets/css/13-search.css` |
| Button behaviour | `assets/js/17-events.js` |
| Sample data dataset | `assets/data/sample.csv` |
| Strip every border (or restore them) | `assets/css/12-no-borders.css` |

> **Note on sample data:** the `SAMPLE_CSV` constant in
> `assets/js/01-sample-data.js` is a byte-for-byte copy of
> `assets/data/sample.csv` so the app works offline without an HTTP server.
> After editing the CSV, regenerate the JS file — see *Updating the sample
> CSV* below.

## Updating the sample CSV

`assets/data/sample.csv` is the source of truth. The `SAMPLE_CSV` constant in
`assets/js/01-sample-data.js` is a byte-for-byte copy (so the in-page buttons
work without an HTTP server). After editing the CSV, run this one-liner from
the project root to regenerate the JS file:

```bash
python3 -c "
import pathlib
def esc(s): return s.replace('\\\\','\\\\\\\\').replace('\\`','\\\\\\`').replace('\${','\\\\\${')
sample = pathlib.Path('assets/data/sample.csv').read_text()
header = open('assets/js/01-sample-data.js').read().split('const SAMPLE_CSV')[0]
out = header + 'const SAMPLE_CSV = \`' + esc(sample) + '\`;\n'
pathlib.Path('assets/js/01-sample-data.js').write_text(out)
print('Regenerated assets/js/01-sample-data.js')
"
```

If you only ever drag a .csv onto the app (instead of clicking "Load sample"),
you don't need to regenerate.

## No build step

The app is plain HTML, CSS, and JS — open `index.html` and it runs. No npm,
no bundler, no transpiler.

## Limitations

- **Elasticities in the sample are illustrative, not calibrated.** Plausible round figures, not regression coefficients. Defensible for direction-of-effect analysis, not policy costings. To calibrate: substitute real numbers and fit elasticities on time-series data.
- **No threshold non-linearities.** Cobb-Douglas is smooth and monotone. Real-world bottlenecks have kinks (queues blow up non-linearly near capacity); not captured.
- **No confidence intervals.** Point estimates only.
- **No cost / budget side.** Sliders move physical inputs without cost constraints. Easy to add: an additional `unit_cost` node field summed to a budget readout in the simulation panel.
- **Feedback loops settle, they don't oscillate dynamically.** The iterative solver finds the steady state of a loop, not its time-path. A runaway positive loop (gain ≥ 1) has no steady state; its values are clamped and flagged rather than simulated over time.
- **CSV only.** No JSON or API ingestion. Both would be straightforward to add to the loader.
- **Wizard row reordering** is supported for streams, stages, and categories (grab the `⋮⋮` handle on the left of any row to drag it up or down). Node and edge order doesn't affect rendering, so the wizard doesn't expose handles there.
- **`localStorage` only.** State persists in the browser, not in the cloud. Different browsers / private windows / incognito tabs all see their own independent state. Use **Download CSV** in the wizard to share a snapshot.
