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
