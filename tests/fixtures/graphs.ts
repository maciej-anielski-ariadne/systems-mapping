// =============================================================================
// TEST FIXTURES — small, hand-verified CSV graphs
// -----------------------------------------------------------------------------
// Each constant is a complete multi-section CSV the loader accepts. The maths in
// the comments is what the simulation/layout tests assert against.
// =============================================================================

// Linear chain  A → B → C  (single stream, three stages).
//   value(A) = 100 × m           (A is controllable; m = user multiplier)
//   value(B) =  50 × m^0.5       (edge A→B elasticity 0.5)
//   value(C) =  20 × m^0.5       (edge B→C elasticity 1.0)
// So a ×4 override on A gives B=100, C=40 (sqrt(4)=2).
export const LINEAR_CSV = `# SECTION: streams
id,label,short,color
ops,Operations,OPS,#60a5fa

# SECTION: stages
id,label
s1,Inputs
s2,Middle
s3,Outputs

# SECTION: categories
id,label,color,text_color,class
cat,General,#a3a3a3,#111111,primary

# SECTION: defaults
key,value
elasticity_enables,0.30
elasticity_increases,0.25
elasticity_decreases,-0.25

# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max
a,Input A,,ops,s1,cat,100,units,true,,400
b,Middle B,,ops,s2,cat,50,units,,,
c,Output C,,ops,s3,cat,20,units,,higher_better,

# SECTION: edges
from,to,effect,elasticity,style,description
a,b,increases,0.5,,A lifts B
b,c,increases,1.0,,B lifts C
`;

// Stable feedback loop  B ↔ C  (gain 0.09 < 1 → converges), driven by A.
export const FEEDBACK_CSV = `# SECTION: streams
id,label,short,color
ops,Operations,OPS,#60a5fa

# SECTION: stages
id,label
s1,One
s2,Two

# SECTION: categories
id,label,color,text_color,class
cat,General,#a3a3a3,#111111,primary

# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max
a,Driver,,ops,s1,cat,100,units,true,,400
b,Loop B,,ops,s2,cat,100,units,,,
c,Loop C,,ops,s2,cat,100,units,,,

# SECTION: edges
from,to,effect,elasticity,style,description
a,b,increases,0.5,,
b,c,increases,0.3,,
c,b,increases,0.3,,
`;

// Runaway positive loop  B ↔ C  (log-gain 4 ≥ 1 → diverges, clamps to baseline).
export const RUNAWAY_CSV = `# SECTION: streams
id,label,short,color
ops,Operations,OPS,#60a5fa

# SECTION: stages
id,label
s1,One
s2,Two

# SECTION: categories
id,label,color,text_color,class
cat,General,#a3a3a3,#111111,primary

# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max
a,Driver,,ops,s1,cat,100,units,true,,400
b,Loop B,,ops,s2,cat,100,units,,,
c,Loop C,,ops,s2,cat,100,units,,,

# SECTION: edges
from,to,effect,elasticity,style,description
a,b,increases,1.0,,
b,c,increases,2.0,,
c,b,increases,2.0,,
`;

// Three stages A(s1) → B(s2) → C(s3); hiding stage s2 reroutes A → C synthetic.
export const REROUTE_CSV = `# SECTION: streams
id,label,short,color
ops,Operations,OPS,#60a5fa

# SECTION: stages
id,label
s1,Start
s2,Middle
s3,End

# SECTION: categories
id,label,color,text_color,class
cat,General,#a3a3a3,#111111,primary

# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max
a,Node A,,ops,s1,cat,,,,,
b,Node B,,ops,s2,cat,,,,,
c,Node C,,ops,s3,cat,,,,,

# SECTION: edges
from,to,effect,elasticity,style,description
a,b,increases,,,
b,c,increases,,,
`;

// One node carrying a primary + a secondary category (pipe-separated).
export const MULTICAT_CSV = `# SECTION: streams
id,label,short,color
ops,Operations,OPS,#60a5fa

# SECTION: stages
id,label
s1,One

# SECTION: categories
id,label,color,text_color,class
prim,Primary,#60a5fa,#111111,primary
sec,Secondary,#f59e0b,#111111,secondary

# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max
n,Node,,ops,s1,prim|sec,,,,,

# SECTION: edges
from,to,effect,elasticity,style,description
`;

// Params + the optional per-box calculation columns (combine / formula /
// min / max). Nothing here changes how the map computes in this wave — the
// fixture exists to prove the data model and the CSV round-trip carry it:
//   • two params (never drawn as boxes)
//   • `served`  — a formula (with commas inside it, so quoting is exercised)
//   • `total`   — combine `additive`
//   • `capacity`— hard min/max bounds
export const PARAMS_CSV = `# SECTION: streams
id,label,short,color
ops,Operations,OPS,#60a5fa

# SECTION: stages
id,label
s1,One
s2,Two

# SECTION: categories
id,label,color,text_color,class
cat,General,#a3a3a3,#111111,primary

# SECTION: params
id,value,description
share_air,0.35,Share of the flow routed by air
detection_rate,0.6,"Probability an examined item is detected, per inspection"

# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max,combine,formula,min,max
demand,Demand,,ops,s1,cat,100,units,true,,400,,,,
capacity,Capacity,,ops,s1,cat,80,units,true,,400,,,0,200
served,Served,,ops,s2,cat,80,units,,higher_better,,,"clamp(min(demand, capacity), 0, 200)",,
total,Total,,ops,s2,cat,80,units,,,,additive,,,

# SECTION: edges
from,to,effect,elasticity,style,description
demand,served,increases,0.5,,
capacity,served,increases,0.5,,
demand,total,increases,0.5,,
capacity,total,increases,0.5,,
`;

// Deliberately broken params + calculation columns for validation tests:
//   • good    — valid param
//   • good    — DUPLICATE param id (second occurrence rejected)
//   • notnum  — value isn't a number (rejected)
//   • n1      — param id clashing with a box id (rejected)
//   • (blank) — a row with no id (silently skipped, like a blank node row)
//   • n1      — unknown `combine` value (ignored, box kept)
//   • n2      — min greater than max (both limits ignored, box kept)
export const PARAMS_INVALID_CSV = `# SECTION: streams
id,label,short,color
ops,Operations,OPS,#60a5fa

# SECTION: stages
id,label
s1,One

# SECTION: categories
id,label,color,text_color,class
cat,General,#a3a3a3,#111111,primary

# SECTION: params
id,value,description
good,0.5,A perfectly fine constant
good,0.7,Duplicate id
notnum,abc,Value is not a number
n1,1,Clashes with a box id
,9,No id at all

# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max,combine,formula,min,max
n1,Node One,,ops,s1,cat,,,,,,sideways,,,
n2,Node Two,,ops,s1,cat,,,,,,,,10,5

# SECTION: edges
from,to,effect,elasticity,style,description
`;

// The three `combine` rules side by side, fed by the SAME two inputs so the
// tests can compare them directly (both links have elasticity 1.0):
//   • mult  — multiplicative (the default): ∏ rᵢ       → compounds
//   • add   — additive:      1 + Σ (rᵢ − 1)            → does not compound
//   • gate  — min:           min(rᵢ)                   → weakest input wins
//   • lone  — no incoming links at all (stays at baseline; rule "baseline")
// With a=×1.2 and b=×1.2:  mult 144, add 140, gate 120.
// With a=×1.5 and b=×1.0:  mult 150, add 150, gate 100.
export const COMBINE_CSV = `# SECTION: streams
id,label,short,color
ops,Operations,OPS,#60a5fa

# SECTION: stages
id,label
s1,Inputs
s2,Outputs

# SECTION: categories
id,label,color,text_color,class
cat,General,#a3a3a3,#111111,primary

# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max,combine,formula,min,max
a,Input A,,ops,s1,cat,100,units,true,,400,,,,
b,Input B,,ops,s1,cat,100,units,true,,400,,,,
mult,Multiplicative,,ops,s2,cat,100,units,,,,,,,
add,Additive,,ops,s2,cat,100,units,,,,additive,,,
gate,Weakest link,,ops,s2,cat,100,units,,,,min,,,
lone,No inputs,,ops,s2,cat,100,units,,,,,,,

# SECTION: edges
from,to,effect,elasticity,style,description
a,mult,increases,1.0,,
b,mult,increases,1.0,,
a,add,increases,1.0,,
b,add,increases,1.0,,
a,gate,increases,1.0,,
b,gate,increases,1.0,,
`;

// The four formula patterns from the design doc, with self-consistent starting
// values (no override → every box sits exactly on its baseline):
//   • exam_coverage — a RATIO held inside 0..1 by clamp()
//   • seizures      — a GATE (joint product), incl. a hidden param
//   • provision     — a CAPACITY limit, min(demand, capacity)
//   • air_flow      — an ALLOCATION, one flow split by a param share
export const FORMULA_CSV = `# SECTION: streams
id,label,short,color
ops,Operations,OPS,#60a5fa

# SECTION: stages
id,label
s1,Inputs
s2,Middle
s3,Outputs

# SECTION: categories
id,label,color,text_color,class
cat,General,#a3a3a3,#111111,primary

# SECTION: params
id,value,description
share_air,0.35,Share of the flow routed by air
detection_rate,0.6,Probability an examined item is detected

# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max,combine,formula,min,max
traffic,Traffic,,ops,s1,cat,1000,items,true,,4000,,,,
examinations,Examinations,,ops,s1,cat,200,items,true,,2000,,,,
demand,Demand,,ops,s1,cat,100,cases,true,,400,,,,
capacity,Capacity,,ops,s1,cat,80,cases,true,,400,,,,
exam_coverage,Exam coverage,,ops,s2,cat,0.2,share,,,,,"clamp(examinations / traffic, 0, 1)",,
seizures,Seizures,,ops,s3,cat,120,items,,higher_better,,,traffic * exam_coverage * detection_rate,,
provision,Provision,,ops,s3,cat,80,cases,,higher_better,,,"min(demand, capacity)",,
air_flow,Air flow,,ops,s2,cat,350,items,,,,,traffic * share_air,,

# SECTION: edges
from,to,effect,elasticity,style,description
examinations,exam_coverage,increases,1.0,,
traffic,exam_coverage,decreases,-1.0,,
traffic,seizures,increases,1.0,,
exam_coverage,seizures,increases,1.0,,
demand,provision,increases,1.0,,
capacity,provision,increases,1.0,,
traffic,air_flow,increases,1.0,,
`;

// Hard min/max bounds. Every downstream box takes the same ×m from `a`
// (elasticity 1.0), so a=×2 pushes them all to 200 and a=×0.5 to 50:
//   • capped  — max 120 only  (a=×2   → 120, clamp recorded)
//   • floored — min 90 only   (a=×0.5 →  90, clamp recorded)
//   • both    — min 90, max 120
//   • a       — controllable AND bounded: a slider is never clamped (×4 → 400).
export const BOUNDS_CSV = `# SECTION: streams
id,label,short,color
ops,Operations,OPS,#60a5fa

# SECTION: stages
id,label
s1,Inputs
s2,Outputs

# SECTION: categories
id,label,color,text_color,class
cat,General,#a3a3a3,#111111,primary

# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max,combine,formula,min,max
a,Input A,,ops,s1,cat,100,units,true,,400,,,,150
capped,Capped,,ops,s2,cat,100,units,,,,,,,120
floored,Floored,,ops,s2,cat,100,units,,,,,,90,
both,Both bounds,,ops,s2,cat,100,units,,,,,,90,120

# SECTION: edges
from,to,effect,elasticity,style,description
a,capped,increases,1.0,,
a,floored,increases,1.0,,
a,both,increases,1.0,,
`;

// A feedback loop made well-defined by delay(). `p` reads last sweep's `q`, so
// no box ever needs its own value within a sweep:
//     p = 80 + 0.2 × delay(q)        q = 0.5 × a + 0.5 × p
// At a = 100 that fixed point is exactly the baselines (100, 100); at a = 120 it
// is p = 92/0.9 = 102.2222…, q = 60 + 0.5p = 111.1111….
export const DELAY_LOOP_CSV = `# SECTION: streams
id,label,short,color
ops,Operations,OPS,#60a5fa

# SECTION: stages
id,label
s1,Inputs
s2,Loop

# SECTION: categories
id,label,color,text_color,class
cat,General,#a3a3a3,#111111,primary

# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max,combine,formula,min,max
a,Driver,,ops,s1,cat,100,units,true,,400,,,,
p,Price,,ops,s2,cat,100,units,,,,,80 + 0.2 * delay(q),,
q,Quantity,,ops,s2,cat,100,units,,,,,0.5 * a + 0.5 * p,,

# SECTION: edges
from,to,effect,elasticity,style,description
q,p,increases,1.0,,
a,q,increases,1.0,,
p,q,increases,1.0,,
`;

// The same loop with the two formula boxes declared the other way round. A
// delayed loop must land on the same fixed point either way — that is the whole
// point of the unit delay.
export const DELAY_LOOP_REORDERED_CSV = DELAY_LOOP_CSV.replace(
  "p,Price,,ops,s2,cat,100,units,,,,,80 + 0.2 * delay(q),,\nq,Quantity,,ops,s2,cat,100,units,,,,,0.5 * a + 0.5 * p,,",
  "q,Quantity,,ops,s2,cat,100,units,,,,,0.5 * a + 0.5 * p,,\np,Price,,ops,s2,cat,100,units,,,,,80 + 0.2 * delay(q),,",
);

// A map with NO loop in its arrows that still reads through delay(). One sweep
// can't be trusted to be the answer here, so the solver must keep sweeping
// instead of taking its acyclic shortcut.
//   y = 50 + 0.5 × delay(x)   → 100 at x = 100, 110 at x = 120.
export const DELAY_ACYCLIC_CSV = `# SECTION: streams
id,label,short,color
ops,Operations,OPS,#60a5fa

# SECTION: stages
id,label
s1,Inputs
s2,Outputs

# SECTION: categories
id,label,color,text_color,class
cat,General,#a3a3a3,#111111,primary

# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max,combine,formula,min,max
x,Input X,,ops,s1,cat,100,units,true,,400,,,,
y,Output Y,,ops,s2,cat,100,units,,,,,50 + 0.5 * delay(x),,

# SECTION: edges
from,to,effect,elasticity,style,description
x,y,increases,1.0,,
`;

// One deliberate instance of every formula warning the loader can raise:
//   • oops            — formula text that doesn't parse (box falls back to links)
//   • unknown_ref     — mentions `mystery`, which is neither box nor param
//   • no_edge         — uses `a` with no arrow from `a`
//   • extra_edge      — has an arrow from `b` its formula never reads
//   • reads_nb        — uses `nb`, a box with no starting value
//   • both_rules      — `combine` AND a formula (the formula wins)
//   • pinned_formula  — controllable AND a formula (the slider wins)
//   • c1 / c2         — a same-sweep loop through formulas, no delay() in it
export const FORMULA_INVALID_CSV = `# SECTION: streams
id,label,short,color
ops,Operations,OPS,#60a5fa

# SECTION: stages
id,label
s1,Inputs
s2,Outputs

# SECTION: categories
id,label,color,text_color,class
cat,General,#a3a3a3,#111111,primary

# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max,combine,formula,min,max
a,Input A,,ops,s1,cat,100,units,true,,400,,,,
b,Input B,,ops,s1,cat,100,units,true,,400,,,,
nb,No baseline,,ops,s1,cat,,,,,,,,,
oops,Bad syntax,,ops,s2,cat,100,units,,,,,2 * ),,
unknown_ref,Unknown name,,ops,s2,cat,100,units,,,,,mystery + a,,
no_edge,Missing arrow,,ops,s2,cat,100,units,,,,,a * 2,,
extra_edge,Spare arrow,,ops,s2,cat,100,units,,,,,a * 2,,
reads_nb,Reads a blank box,,ops,s2,cat,100,units,,,,,nb + 1,,
both_rules,Two rules,,ops,s2,cat,100,units,,,,additive,a * 2,,
pinned_formula,Slider and formula,,ops,s2,cat,100,units,true,,400,,a * 2,,
c1,Cycle one,,ops,s2,cat,100,units,,,,,c2 * 1,,
c2,Cycle two,,ops,s2,cat,100,units,,,,,c1 * 1,,

# SECTION: edges
from,to,effect,elasticity,style,description
a,oops,increases,1.0,,
a,unknown_ref,increases,1.0,,
a,extra_edge,increases,1.0,,
b,extra_edge,increases,1.0,,
nb,reads_nb,increases,1.0,,
a,both_rules,increases,1.0,,
a,pinned_formula,increases,1.0,,
c2,c1,increases,1.0,,
c1,c2,increases,1.0,,
`;

// Deliberately broken references for validation tests:
//   • good   — valid node
//   • good   — DUPLICATE id (second occurrence rejected)
//   • badref — references a stream that doesn't exist (dropped)
//   • zero   — baseline 0 (rejected; node kept without baseline)
//   • edge to a non-existent node (rejected)
export const INVALID_CSV = `# SECTION: streams
id,label,short,color
ops,Operations,OPS,#60a5fa

# SECTION: stages
id,label
s1,One

# SECTION: categories
id,label,color,text_color,class
cat,General,#a3a3a3,#111111,primary

# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max
good,Good,,ops,s1,cat,10,,,,
good,Dup,,ops,s1,cat,,,,,
badref,Bad Stream,,nope,s1,cat,,,,,
zero,Zero Baseline,,ops,s1,cat,0,,,,

# SECTION: edges
from,to,effect,elasticity,style,description
good,ghost,increases,,,
`;
