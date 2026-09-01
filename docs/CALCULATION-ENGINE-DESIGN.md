# Design decision: per-node calculation rules for simulation mode

**Status:** implemented (2026-08-18). The sections below describe the shipped behaviour;
"*As implemented*" notes flag the few places the build deliberately differs from this
proposal.
**Scope:** the simulation calculation engine (`assets/js/07-simulation-engine.ts` and the
formula language in `07a-formula.ts`), the CSV schema, validation in the data loader, the
detail panel's simulation view, and the Build / Edit wizard.
**Worked example:** `assets/data/advanced_sample.csv` exercises every rule below.

## 1. The problem

The engine applies one global rule to every node:

```
value(N) = baseline(N) × ∏ over incoming edges (value(source) / baseline(source)) ^ elasticity
```

Each incoming link contributes an independent term. That cannot express:

- **Joint requirements** — drug seizures need attempted importation *and* examination
  coverage *and* selection quality *and* detection effectiveness together; today any one
  input can move the outcome on its own.
- **Capacity limits** — treatment provision is bounded by the smaller of demand and
  capacity; today extra demand raises provision past capacity.
- **Ratios** — examination coverage is examinations ÷ traffic, not a blend of a positive
  and a negative effect.
- **Allocation** — one flow (attempted importation) split across routes by shares; today
  the same flow can be "exposed" to every border mode at full strength simultaneously.
- **Conservation / bounds** — outputs can exceed inputs; nothing stops a percentage from
  passing 100.
- **Well-defined feedback** — loops are solved by iterating and hoping for convergence;
  results can depend on sweep order and can run away.
- **Hidden technical detail** — route shares, detection rates and conversion factors have
  nowhere to live except as visible boxes, which would make the map unreadable.

## 2. Options considered

**A. More combine modes only** (per-node switch: multiply / add / min). Cheap, and covers
gates and dilution — but it cannot express ratios, demand-vs-capacity pairs, route shares
or any hidden parameter, so the hardest cases in the issue stay unsolved.

**B. A full system-dynamics engine** (stocks, flows, time integration à la Vensim/Stella).
Solves everything in principle, but changes the character of the product: users would have
to model time constants and integration steps, the UI would need a time axis, and existing
maps have no meaningful translation. Far more machinery than the issue needs.

**C. Layered per-node calculation rules + hidden parameters + a small formula language.**
Keep the current engine as the default, let individual nodes opt in to richer rules, and
give hidden constants a home. This is the recommendation.

## 3. Recommended design (option C)

Five layers, each optional per node. A map that uses none of them computes **exactly** as
today — backward compatibility is by construction, not by migration.

### 3.1 Default unchanged

No new fields → current Cobb-Douglas behaviour, bit for bit. Existing CSVs load and
simulate identically.

### 3.2 `combine` — one-word rules for the common cases

A new optional node column selecting how incoming edge terms aggregate, still in ratio
space (so it composes with existing edges and elasticities, and needs no new inputs):

| `combine` | Meaning | Maths (rᵢ = source ratio, eᵢ = elasticity) |
|---|---|---|
| `multiplicative` *(default)* | independent percentage effects | ∏ rᵢ^eᵢ (today's rule) |
| `additive` | effects add, don't compound | 1 + Σ eᵢ·(rᵢ − 1) |
| `min` | weakest link gates the outcome | min(rᵢ^eᵢ) |

This alone fixes "effects are overstated when related inputs are added together"
(`additive` stops compounding; `min` makes prerequisites gate instead of contribute).

### 3.3 `# SECTION: params` — hidden technical constants

A new optional CSV section for named scalars that belong to the calculation model, not the
visual map:

```
# SECTION: params
id,value,description
share_air,0.35,Share of attempted importation routed by air
detection_rate_xray,0.6,Probability an examined high-risk container is detected
grams_per_seizure,900,Average seizure weight conversion factor
```

Params never render as boxes. They are editable in the builder wizard and the CSV, are
referenceable from formulas, and round-trip through the serializer. This is the
"separate the readable visual map from the underlying calculation model" requirement.

> *As implemented:* the wizard's params step is called **Constants** in the UI (step 6 of
> seven, between Links and Review) — "parameter" is jargon for the audience the wizard is
> for. `params` remains the section name in the CSV and the field name in code.

### 3.4 `formula` — explicit rules where the built-ins aren't enough

A new optional node column holding a small, safe expression evaluated in **absolute
values** (node values already are absolute — baseline × ratio — so formulas read them
directly):

- operators `+ − * / ( )`, numeric literals;
- identifiers: node ids and param ids;
- functions: `min(…)`, `max(…)`, `clamp(x, lo, hi)`, `delay(node_id)`.

Every pattern in the issue reduces to this:

| Need | Example formula |
|---|---|
| Joint requirement (gate) | `seizures = attempted_importation * exam_coverage * selection_quality * detection_rate_xray` |
| Ratio | `exam_coverage = clamp(examinations / traffic, 0, 1)` |
| Capacity constraint | `treatment_provision = min(treatment_demand, treatment_capacity)` |
| Resource allocation / flow split | `air_importation = attempted_importation * share_air` (shares are params, so one flow is never exposed to two modes at once) |
| Flow balance | `undetected_flow = attempted_importation - seizures` |
| Bounds | `clamp(…)`, plus the per-node `min`/`max` columns below |
| Delayed feedback | `street_price = base_price * (1 + price_elasticity * delay(seizure_rate))` |

**Formulas and edges stay consistent.** A node with a formula is computed from the formula
alone, but validation enforces that every *node* id the formula references has an incoming
edge from that node, and warns about incoming edges the formula ignores. The arrows on the
map therefore remain an honest picture of causality; only the *how* moves into the formula
and the constants move into params.

**Feedback evaluation becomes order-independent.** Any cycle passing through a formula node must go
through at least one `delay()` — a validation warning names the cycle otherwise. `delay(x)`
reads x's value from the previous solver sweep, which makes loop results independent of
sweep order. A unit delay does **not** guarantee convergence: loop gain and bounds still
determine whether the values settle. Cycles made only of classic ratio edges keep the
Gauss-Seidel treatment and status reporting.

> *As implemented:* two rules the proposal left implicit. A **slider beats a formula** — a
> `controllable` box is pinned by the user, so its formula never runs (the loader says so),
> which is also why bounds never apply to it. And `delay()` takes a **bare box or param id**,
> not an expression: the solver keeps previous-sweep values per id, so `delay(a + b)` has
> nothing to read and the parser rejects it.

### 3.5 `min` / `max` node columns — hard bounds

Optional absolute clamps applied after any rule. Also upgrades today's "runaway loop
overflowed to Infinity, fall back to baseline" behaviour into something explainable.

### 3.6 Evidence status — causal claim versus mathematical fit

The evidence assessment for a link and the evidence assessment for a formula answer two
different questions:

- **Link status is about causal evidence.** It records the author's assessment of the
  claim that changing the source affects the target in the stated direction.
- **Formula status is about mathematical-form and parameter evidence.** It records the
  author's assessment of the equation's shape, constants and fitted values.

Both use the shared labels **Unspecified**, **Hypothesis**, **Supported**, **Calibrated**
and **Validated**. Their meanings depend on what is being assessed:

| Status | Link: causal evidence | Formula: form and parameter evidence |
|---|---|---|
| Unspecified | No assessment recorded. | No assessment recorded. |
| Hypothesis | A proposed causal direction for exploration. | A proposed equation or parameter set for exploration. |
| Supported | Relevant evidence or domain reasoning supports the claim, without a validation claim. | Relevant evidence or domain reasoning supports the form or parameters, without a calibration or validation claim. |
| Calibrated | The relationship's magnitude has been fitted or tuned to observations; fit alone does not establish causality. | The form or parameter values have been fitted or tuned to observed data. |
| Validated | The causal claim has been assessed using the author's stated validation design. | The form and parameters have been assessed against separate data, cases or another stated validation check. |

An empirically **Calibrated** or **Validated** formula can therefore coexist with a
**Hypothesis** link. Predictive fit and causal identification are not the same claim.
These labels are informational metadata only: they do not enable, disable or reweight a
link or formula, and the calculation engine always runs every syntactically valid active
rule. The application records the author's assessment; it does not certify the evidence
or the validation method.

An explicit formula does not have to be an already-known accounting identity. It may be a
domain assumption, a theory-led functional form or an empirically fitted relationship.
The model should state which of those it is, preserve compatible units and baseline
behaviour, and avoid presenting mathematical fit as proof of the causal arrows.

## 4. Traceability

Alongside `{nodeId → number}`, the engine records, per node, an **explanation**:
which rule ran (default / combine mode / formula), each input's
resolved value, each term's contribution, params read, and whether a clamp or delay was
applied. The detail panel's simulation view renders this as a "how this number was
calculated" breakdown, so every result is auditable back to its inputs and rule — the
issue's traceability requirement, and also the main mitigation for the risk that richer
rules make results harder to trust.

## 5. Validation

All reported through the existing `state.loadErrors` path, with node ids and (for
formulas) the offending token:

- formula syntax errors (`unexpected ')' in formula for seizures`);
- references to unknown node/param ids; param ids that collide with node ids;
- a formula referencing a node it has no incoming edge from (error) or ignoring an
  incoming edge (warning);
- a cycle through a formula node with no `delay()` on the cycle (error naming the nodes);
- `combine` values outside the enum; `min > max`;
- division-by-zero guarded at runtime (result 0, flagged in the trace) rather than at load.

> *As implemented:* **nothing here is fatal.** Every item above loads as a plain-language
> warning in the same list as the existing load warnings, saying what the engine did instead
> ("the formula is ignored", "it will be read as 0", "that link is descriptive only"). The
> calculation-rule errors remain non-fatal. Structural identity errors are different: a
> missing or empty required section, or an invalid or duplicate row, column or category id,
> prevents the map from loading because its coordinates are ambiguous. The reasoning for
> calculation warnings remains that a half-valid calculation model is still worth looking
> at, and opening it with a precise warning teaches the author how to fix it.

## 6. CSV schema summary

- `nodes` section gains optional columns `combine`, `formula`, `min`, `max` — blank means
  today's behaviour.
- `nodes` also carries optional formula-evidence metadata:
  `formula_evidence_status`, `formula_evidence_rationale`, `formula_evidence_source`, and
  `formula_evidence_last_reviewed`.
- `edges` carries optional causal-evidence metadata: `evidence_status`,
  `evidence_rationale`, `evidence_source`, and `evidence_last_reviewed`.
- Both status fields accept `unspecified`, `hypothesis`, `supported`, `calibrated`, and
  `validated`; a missing or unknown value loads as `unspecified`. These fields never
  affect calculation.
- New optional section `params` (`id,value,description`).
- The parser already ignores unknown sections and columns, so new files degrade gracefully
  in older builds, and old files are untouched — **no migration step for existing maps**.

## 7. Implementation phasing

1. **Params + trace plumbing** — parse/serialize `params`, thread an explanation record
   through `computeNodeValues()`. No behaviour change; tests assert identical outputs.
2. **`combine` modes + `min`/`max` bounds** — small engine change, big modelling win.
3. **Formula language** — tokenizer + recursive-descent parser to an AST at load time
   (evaluation per sweep is then cheap), `delay()` semantics in the solver, the new
   validation rules.
4. **UI** — detail-panel calculation breakdown; builder wizard step for params and the new
   node columns.

Each phase is independently shippable and testable; the risky piece (the formula parser)
is isolated, dependency-free and unit-testable in isolation.

## 8. Rejected details, for the record

- **Spreadsheet-style formulas over everything** (no default rule): would force every
  existing map to be rewritten. The layered opt-in keeps simple maps simple.
- **JavaScript escape hatch per node**: unsafe (the app opens arbitrary user CSVs) and
  untraceable. The closed expression grammar is deliberate.
- **A dedicated `allocation` edge type with share weights**: expressible already as
  params + formulas; a bespoke edge type can be added later behind the same trace and
  validation machinery if share-groups turn out to be frequent.
