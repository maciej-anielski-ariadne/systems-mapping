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

// Category-filter cases: two fill tags (p1, p2) and two corner tags (s1, s2)
// spread over four boxes, so hiding one tag can be checked against a box that
// still has another tag of the same class, one of the other class, and one with
// nothing left.
//   both      — fills p1+p2, corners s1+s2
//   twofills  — fills p1+p2, no corner
//   mix       — fill p1, corner s1
//   cornersonly — corners s1+s2, no fill
export const CAT_FILTER_CSV = `# SECTION: streams
id,label,short,color
ops,Operations,OPS,#60a5fa

# SECTION: stages
id,label
st1,One

# SECTION: categories
id,label,color,text_color,class
p1,Fill One,#60a5fa,#111111,primary
p2,Fill Two,#34d399,#111111,primary
s1,Corner One,#f59e0b,#111111,secondary
s2,Corner Two,#ef4444,#111111,secondary

# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max
both,Both,,ops,st1,p1|p2|s1|s2,,,,,
twofills,Two Fills,,ops,st1,p1|p2,,,,,
mix,Mix,,ops,st1,p1|s1,,,,,
cornersonly,Corners Only,,ops,st1,s1|s2,,,,,

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

// One input, twelve boxes in the middle, three outputs with four ways into
// each. Enough of a middle layer for "along the way" to be a ranking rather
// than a fact, and enough destinations for the pathway list to have an order.
// Deliberately unrelated names: shared word-stems would let the atlas fold
// these into one family element and change the shape under the tests.
export const WIDE_CSV = `# SECTION: streams
id,label,short,color
ops,Operations,OPS,#60a5fa

# SECTION: stages
id,label
s1,One
s2,Two
s3,Three

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
hub,Hub,,ops,s1,cat,100,units,true,,400
i1,Mike,,ops,s2,cat,41,units,,,
i2,November,,ops,s2,cat,42,units,,,
i3,Oscar,,ops,s2,cat,43,units,,,
i4,Papa,,ops,s2,cat,44,units,,,
i5,Quebec,,ops,s2,cat,45,units,,,
i6,Romeo,,ops,s2,cat,46,units,,,
i7,Sierra,,ops,s2,cat,47,units,,,
i8,Tango,,ops,s2,cat,48,units,,,
i9,Uniform,,ops,s2,cat,49,units,,,
i10,Victor,,ops,s2,cat,50,units,,,
i11,Whiskey,,ops,s2,cat,51,units,,,
i12,Xray,,ops,s2,cat,52,units,,,
yankee,Yankee,,ops,s3,cat,100,units,,higher_better,
zulu,Zulu,,ops,s3,cat,110,units,,higher_better,
juliett,Juliett,,ops,s3,cat,120,units,,higher_better,

# SECTION: edges
from,to,effect,elasticity,style,description
hub,i1,increases,0.20,,Hub lifts Mike
hub,i2,increases,0.25,,Hub lifts November
hub,i3,increases,0.30,,Hub lifts Oscar
hub,i4,increases,0.35,,Hub lifts Papa
hub,i5,increases,0.40,,Hub lifts Quebec
hub,i6,increases,0.45,,Hub lifts Romeo
hub,i7,increases,0.50,,Hub lifts Sierra
hub,i8,increases,0.55,,Hub lifts Tango
hub,i9,increases,0.60,,Hub lifts Uniform
hub,i10,increases,0.65,,Hub lifts Victor
hub,i11,increases,0.70,,Hub lifts Whiskey
hub,i12,increases,0.75,,Hub lifts Xray
i1,yankee,increases,0.30,,Mike into Yankee
i2,yankee,increases,0.40,,November into Yankee
i3,yankee,increases,0.50,,Oscar into Yankee
i4,yankee,increases,0.60,,Papa into Yankee
i5,zulu,increases,0.30,,Quebec into Zulu
i6,zulu,increases,0.40,,Romeo into Zulu
i7,zulu,increases,0.50,,Sierra into Zulu
i8,zulu,increases,0.60,,Tango into Zulu
i9,juliett,increases,0.30,,Uniform into Juliett
i10,juliett,increases,0.40,,Victor into Juliett
i11,juliett,increases,0.50,,Whiskey into Juliett
i12,juliett,increases,0.60,,Xray into Juliett
`;

// Four ways from one input to one output, three of them leaving by the same
// box — so the pathway list has a branch to merge (via Bravo ×3) and one that
// stands alone (via Charlie). Deliberately unrelated names, so the atlas does
// not fold them into a family and change the shape under the test.
export const FAN_CSV = `# SECTION: streams
id,label,short,color
ops,Operations,OPS,#60a5fa

# SECTION: stages
id,label
s1,One
s2,Two
s3,Three
s4,Four

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
alpha,Alpha,,ops,s1,cat,100,units,true,,400
bravo,Bravo,,ops,s2,cat,50,units,,,
charlie,Charlie,,ops,s2,cat,40,units,,,
delta,Delta,,ops,s3,cat,30,units,,,
echo,Echo,,ops,s3,cat,20,units,,,
zulu,Zulu,,ops,s4,cat,10,units,,higher_better,

# SECTION: edges
from,to,effect,elasticity,style,description
alpha,bravo,increases,0.8,,Alpha lifts Bravo
alpha,charlie,increases,0.2,,Alpha lifts Charlie
bravo,zulu,increases,0.5,,straight on to Zulu
charlie,zulu,increases,0.1,,the other way in
bravo,delta,increases,0.4,,round by Delta
delta,zulu,increases,0.6,,Delta to Zulu
bravo,echo,increases,0.3,,round by Echo
echo,zulu,increases,0.2,,Echo to Zulu
`;

// A map with a GATE in the middle of it. `hold` combines its inputs with `min`
// — "you need all of these" — so its number is taken from whichever input is
// furthest behind. Move `pump` as far as you like and `hold` does not budge,
// because `short` is sitting at its baseline and is the weakest of the two.
//
//   pump  ──┬──────────┐
//            │          ├──▶ hold ──▶ far
//            └──▶ short ─┘
//
// `pump → short` is the other half of the fixture: short is a SLIDER, pinned
// wherever the reader left it, so it does not respond to pump at all. The route
// pump → short → hold is structurally real and causally dead — which is what
// the border map's Border Force FTE → Vehicle Physical Search → Lorry Wait
// Times turned out to be.
//
// With pump at ×4: pump's factor is 4^0.5 = 2, short's is 1.0, so min = 1.0 and
// hold stays at 60. Nothing arrives at far either. That is the whole point of
// the fixture: hold is not a box the run failed to REACH, it is a box the run
// reached and was stopped at — and `far` behind it is unreachable by anything
// the sliders can do from here.
export const GATED_CSV = `# SECTION: streams
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
elasticity_increases,0.25

# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max,combine
pump,Pump,,ops,s1,cat,100,units,true,,400,
short,Short Supply,,ops,s1,cat,100,units,true,,400,
hold,Held Box,,ops,s2,cat,60,units,,higher_better,,min
far,Far Output,,ops,s3,cat,20,units,,higher_better,,

# SECTION: edges
from,to,effect,elasticity,style,description
pump,hold,increases,0.5,,plenty of this
short,hold,increases,0.5,,and not enough of this
pump,short,increases,0.5,,structurally connected and causally dead
hold,far,increases,0.9,,everything downstream of the gate
`;

// The same gate, said the other way. `hold` here has no `combine` column at
// all: its formula opens with min(), which is the identical statement — "you
// need both of these" — and on a real map it is the commoner of the two forms.
// The border map has one box using the column and eighteen using formulas.
//
//   hold = min(short * 0.5, pump * 0.5)
//
// With pump at ×4 the second arm is 200 and the first is 50, so hold sits at 50
// and does not move however hard pump is pushed. What is short is `short`.
export const FORMULA_GATE_CSV = `# SECTION: streams
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
elasticity_increases,0.25

# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max,formula
pump,Pump,,ops,s1,cat,100,units,true,,400,
short,Short Supply,,ops,s1,cat,100,units,true,,400,
hold,Held Box,,ops,s2,cat,50,units,,higher_better,,"min(short * 0.5, pump * 0.5)"
far,Far Output,,ops,s3,cat,20,units,,higher_better,,

# SECTION: edges
from,to,effect,elasticity,style,description
pump,hold,increases,0.5,,the arm with plenty in it
short,hold,increases,0.5,,the arm that is short
hold,far,increases,0.9,,everything downstream of the gate
`;
