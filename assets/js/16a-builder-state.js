// =============================================================================
// BUILDER PANEL — state, validation, and small helpers
// -----------------------------------------------------------------------------
// One of four files that together implement the in-app Build / Edit wizard:
//
//   16a-builder-state.js   — this file: state seeding, validation, small
//                            helpers (row buttons, drag handle, table-empty,
//                            slugify), and apply/download.
//   16b-builder-render.js  — HTML output for the wizard overlay (header,
//                            footer, six step renderers).
//   16c-builder-editor.js  — the floating "expand this cell" editor that
//                            pops up when the user focuses a text/number
//                            field inside the wizard.
//   16d-builder-events.js  — event wiring: clicks, typing, focus, drag-drop.
//
// The wizard mutates `state.builder` (declared in 03-state.js), NOT the
// live STREAMS / STAGES / CATEGORIES / NODES / EDGES. Cancel discards.
// Apply serialises the builder state to CSV and feeds it through the same
// loadDataFromCsv() path drag-drop uses, so validation runs uniformly.
// =============================================================================

// ───── Constants ──────────────────────────────────────────────────────────
const BUILDER_STEPS = [
  { num: 1, key: "streams",    label: "Streams" },
  { num: 2, key: "stages",     label: "Stages" },
  { num: 3, key: "categories", label: "Categories" },
  { num: 4, key: "nodes",      label: "Nodes" },
  { num: 5, key: "edges",      label: "Edges" },
  { num: 6, key: "review",     label: "Review" },
];

// EFFECT_OPTIONS, DIRECTION_OPTIONS, and STREAM_COLOR_PALETTE all live in
// 02-config.js so the wizard, the detail panel, the canvas edit module, and
// the CSV loader all share one source of truth.

// Sentinel string used to split each step's HTML output into a sticky-top
// section (heading + blurb + action bar) and a scroll-below section (the
// row table). See renderBuilder() in 16b-builder-render.js.
const BUILDER_SPLIT = "<!--builder-split-->";

// ───── Open / close ───────────────────────────────────────────────────────
function openBuilder(options) {
  const fromLoadedData = options && options.fromLoadedData;

  if (fromLoadedData && state.dataLoaded) {
    seedBuilderFromLiveData();
  } else {
    seedBuilderEmpty();
  }
  state.builder.open = true;
  state.builder.step = 1;
  renderBuilder();
}

function closeBuilder() {
  state.builder.open = false;
  hideCellEditor();
  clearBuilderFromStorage();
  const overlay = document.getElementById("builder-overlay");
  if (overlay) {
    overlay.classList.remove("open");
    overlay.innerHTML = "";
  }
}

// ───── Seed helpers ───────────────────────────────────────────────────────
function seedBuilderEmpty() {
  state.builder.streams    = [];
  state.builder.stages     = [];
  state.builder.categories = [];
  state.builder.defaults   = { enables: 0.30, increases: 0.25, decreases: -0.25 };
  state.builder.nodes      = [];
  state.builder.edges      = [];
}

function seedBuilderFromLiveData() {
  // Deep-clone live state into the builder shape. CATEGORIES is a runtime
  // map keyed by id; convert it back to an array.
  state.builder.streams = STREAMS.map(s => ({
    id: s.id, label: s.label, short: s.short, color: s.color,
  }));
  state.builder.stages = STAGES.map(s => ({ id: s.id, label: s.label }));
  state.builder.categories = Object.keys(CATEGORIES).map(id => ({
    id: id,
    label: CATEGORIES[id].label,
    color: CATEGORIES[id].color,
    textColor: CATEGORIES[id].textColor,
  }));
  state.builder.defaults = {
    enables:   DEFAULT_ELASTICITY_BY_EFFECT.enables,
    increases: DEFAULT_ELASTICITY_BY_EFFECT.increases,
    decreases: DEFAULT_ELASTICITY_BY_EFFECT.decreases,
  };
  state.builder.nodes = NODES.map(n => ({
    id: n.id, label: n.label, description: n.description || "",
    stream: n.stream, stage: n.stage, category: n.category,
    baseline: n.baseline !== undefined ? n.baseline : "",
    unit: n.unit || "",
    controllable: !!n.controllable,
    direction: n.direction || "",
    sliderMax: n.sliderMax !== undefined ? n.sliderMax : "",
  }));
  state.builder.edges = EDGES.map(e => ({
    from: e.from, to: e.to, effect: e.effect,
    elasticity: e.elasticity !== undefined ? e.elasticity : "",
    description: e.description || "",
  }));
}

// "Start from sample" button on step 1 — pre-fills streams/stages/categories
// (and the elasticity defaults) from the embedded sample CSV, so the user
// has a taxonomy to work with. Existing rows are replaced.
function seedBuilderFromSample() {
  if (typeof SAMPLE_CSV === "undefined" || !SAMPLE_CSV) {
    showLoadFeedback("Sample CSV not available in this build.", true);
    return;
  }
  const sections = parseCsvDocument(SAMPLE_CSV);

  state.builder.streams = (sections.streams || []).map(row => ({
    id: row.id || "", label: row.label || "", short: row.short || "", color: row.color || "#94a3b8",
  })).filter(s => s.id);

  state.builder.stages = (sections.stages || []).map(row => ({
    id: row.id || "", label: row.label || "",
  })).filter(s => s.id);

  state.builder.categories = (sections.categories || []).map(row => ({
    id: row.id || "", label: row.label || "",
    color: row.color || "#a3a3a3", textColor: row.text_color || "#1c1917",
  })).filter(c => c.id);

  // Pull defaults too if present.
  if (sections.defaults) {
    for (const row of sections.defaults) {
      const v = parseNumericCell(row.value);
      if (v === undefined) continue;
      if (row.key === ELASTICITY_KEYS.enables)   state.builder.defaults.enables   = v;
      if (row.key === ELASTICITY_KEYS.increases) state.builder.defaults.increases = v;
      if (row.key === ELASTICITY_KEYS.decreases) state.builder.defaults.decreases = v;
    }
  }
}

// ───── Small helpers ──────────────────────────────────────────────────────
function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// Build duplicate-id sets so the renderer can flag offending inputs.
function findDuplicateIds(rows) {
  const seen = new Set();
  const dupes = new Set();
  for (const row of rows) {
    if (!row.id) continue;
    if (seen.has(row.id)) dupes.add(row.id);
    seen.add(row.id);
  }
  return dupes;
}

// The duplicate-and-delete buttons that appear at the end of every editable
// row, factored out because every step's table uses them identically.
function rowActionsHtml(section, i) {
  return '<td><div class="builder-row-actions">' +
           '<button class="builder-row-action" data-duplicate="' + section + '" data-index="' + i + '" title="Duplicate">⎘</button>' +
           '<button class="builder-row-action danger" data-delete="' + section + '" data-index="' + i + '" title="Delete">×</button>' +
         '</div></td>';
}

// Drag handle shown at the START of a row in the ordered sections (streams,
// stages, categories). Dragging the row reorders the underlying
// state.builder array — see drag handlers in 16d-builder-events.js.
function rowDragHandleHtml() {
  return '<td class="builder-row-drag" title="Drag to reorder">⋮⋮</td>';
}

function tableEmptyRow(colSpan, message) {
  return '<tr class="builder-empty-row"><td colspan="' + colSpan + '">' + escapeHtml(message) + '</td></tr>';
}

// ───── Validation ────────────────────────────────────────────────────────
// Returns { errors: [...], dup*: Set, *Ids: Set } used by the renderer to
// mark invalid inputs and by the footer to show the issue count.
function validateBuilder() {
  const b = state.builder;
  const errors = [];

  if (b.streams.length === 0)    errors.push("Add at least one stream (Step 1).");
  if (b.stages.length === 0)     errors.push("Add at least one stage (Step 2).");
  if (b.categories.length === 0) errors.push("Add at least one category (Step 3).");
  if (b.nodes.length === 0)      errors.push("Add at least one node (Step 4).");

  const dupStreams    = findDuplicateIds(b.streams);
  const dupStages     = findDuplicateIds(b.stages);
  const dupCategories = findDuplicateIds(b.categories);
  const dupNodes      = findDuplicateIds(b.nodes);

  dupStreams.forEach(id    => errors.push("Duplicate stream id: " + id));
  dupStages.forEach(id     => errors.push("Duplicate stage id: " + id));
  dupCategories.forEach(id => errors.push("Duplicate category id: " + id));
  dupNodes.forEach(id      => errors.push("Duplicate node id: " + id));

  // Coalesced "missing required fields" messages: blank rows just produce
  // one "row N needs id and label" instead of two separate errors, so a
  // freshly-added row doesn't bury everything else under noise.
  const checkRequiredIdAndLabel = (rows, kind) => {
    rows.forEach((row, i) => {
      if (!row.id && !row.label) errors.push(kind + " row " + (i + 1) + " needs an id and label.");
      else if (!row.id)          errors.push(kind + " `" + row.label + "` is missing an id.");
      else if (!row.label)       errors.push(kind + " `" + row.id + "` is missing a label.");
    });
  };
  checkRequiredIdAndLabel(b.streams,    "Stream");
  checkRequiredIdAndLabel(b.stages,     "Stage");
  checkRequiredIdAndLabel(b.categories, "Category");

  const streamIds   = new Set(b.streams.map(s => s.id).filter(Boolean));
  const stageIds    = new Set(b.stages.map(s => s.id).filter(Boolean));
  const categoryIds = new Set(b.categories.map(c => c.id).filter(Boolean));

  b.nodes.forEach((n, i) => {
    if (!n.id && !n.label) {
      errors.push("Node row " + (i + 1) + " needs an id and label.");
    } else {
      if (!n.id)    errors.push("Node `" + n.label + "` is missing an id.");
      if (!n.label) errors.push("Node `" + n.id + "` is missing a label.");
    }
    const ref = (kind, value, knownSet) => {
      if (!value)               errors.push("Node `" + (n.id || n.label || ("row " + (i + 1))) + "` has no " + kind + ".");
      else if (!knownSet.has(value)) errors.push("Node `" + (n.id || n.label) + "` references unknown " + kind + " `" + value + "`.");
    };
    ref("stream",   n.stream,   streamIds);
    ref("stage",    n.stage,    stageIds);
    ref("category", n.category, categoryIds);
    // baseline must be either blank or > 0 (simulation divides by it).
    if (n.baseline !== "" && n.baseline !== undefined && Number(n.baseline) === 0) {
      errors.push("Node `" + (n.id || n.label || ("row " + (i + 1))) + "` has baseline 0 — must be positive or blank.");
    }
  });

  const nodeIds = new Set(b.nodes.map(n => n.id).filter(Boolean));
  b.edges.forEach((e, i) => {
    const tag = "Edge row " + (i + 1);
    if (!e.from)                  errors.push(tag + " has no source node.");
    else if (!nodeIds.has(e.from)) errors.push(tag + " references unknown source node `" + e.from + "`.");
    if (!e.to)                    errors.push(tag + " has no target node.");
    else if (!nodeIds.has(e.to))   errors.push(tag + " references unknown target node `" + e.to + "`.");
    if (!EFFECT_OPTIONS.includes(e.effect)) errors.push(tag + " has invalid effect `" + e.effect + "`.");
  });

  return { errors, dupStreams, dupStages, dupCategories, dupNodes, streamIds, stageIds, categoryIds, nodeIds };
}

// ───── Apply / Download ───────────────────────────────────────────────────
function applyBuilderToMap() {
  const csv = serializeBuilderToCsv(state.builder);
  const ok = loadDataFromCsv(csv);
  if (ok) closeBuilder();
}

function downloadBuilderCsv() {
  const csv = serializeBuilderToCsv(state.builder);
  downloadCsvBlob(csv, "systems_map.csv");
}

// ───── Row data mutations ─────────────────────────────────────────────────
// "Add row" creates a default-shaped object for each section. "Duplicate
// row" clones the row with its id wiped (so the duplicate doesn't fail
// duplicate-id validation immediately).
function addBuilderRow(section) {
  if (section === "streams") {
    state.builder.streams.push({ id: "", label: "", short: "", color: "#94a3b8" });
  } else if (section === "stages") {
    state.builder.stages.push({ id: "", label: "" });
  } else if (section === "categories") {
    state.builder.categories.push({ id: "", label: "", color: "#a3a3a3", textColor: "#1c1917" });
  } else if (section === "nodes") {
    state.builder.nodes.push({
      id: "", label: "", description: "",
      stream: state.builder.streams[0] ? state.builder.streams[0].id : "",
      stage:  state.builder.stages[0]  ? state.builder.stages[0].id  : "",
      category: state.builder.categories[0] ? state.builder.categories[0].id : "",
      baseline: "", unit: "", controllable: false, direction: "", sliderMax: "",
    });
  } else if (section === "edges") {
    state.builder.edges.push({
      from: state.builder.nodes[0] ? state.builder.nodes[0].id : "",
      to:   state.builder.nodes[0] ? state.builder.nodes[0].id : "",
      effect: "increases", elasticity: "", description: "",
    });
  }
}

function duplicateBuilderRow(section, index) {
  const original = state.builder[section][index];
  if (!original) return;
  const copy = Object.assign({}, original);
  // Wipe the id of the duplicated row — duplicates would fail validation.
  if (copy.id !== undefined) copy.id = "";
  state.builder[section].splice(index + 1, 0, copy);
}
