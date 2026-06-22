// =============================================================================
// SAMPLE CSV DATA  ⚠️  GENERATED FILE — DO NOT EDIT BY HAND
// -----------------------------------------------------------------------------
// The string below is a byte-for-byte copy of:
//   • SAMPLE_CSV  ← assets/data/sample.csv  (small neutral example)
//
// Edit assets/data/sample.csv (in Excel / Google Sheets / a text editor),
// then regenerate this file using the snippet in the project README
// ("Updating the sample CSV"). Otherwise the in-page "Load sample" /
// "Download sample" buttons will drift out of sync with the .csv on disk.
//
// These strings power:
//   • "Load sample"      – calls loadDataFromCsv(SAMPLE_CSV)
//   • "Download sample"  – saves SAMPLE_CSV as a .csv file
// =============================================================================

export const SAMPLE_CSV = `# Systems Map — Simple sample
# A small, neutral worked example you can use as a placeholder while learning
# the schema. Models a three-team product company (Operations, Sales,
# Support) so most readers can follow the cause-and-effect chains without
# any domain background. 12 boxes, 12 links — small enough to grok at a
# glance, big enough to exercise every feature of the app.
#
# Drag this file onto the app to load it. Edit in Excel, Sheets, or a plain
# text editor. The "Build / Edit" wizard in the header is the no-spreadsheet
# alternative.
#
# Sections (in order): streams (rows), stages (columns), categories, defaults, nodes (boxes), edges (links).

# SECTION: streams
# id    - unique row identifier (referenced from boxes)
# label - display name
# short - short label on the row header (uppercase, ~6 chars)
# color - hex colour for the row's left bar
id,label,short,color
ops,Operations,OPS,#60a5fa
sales,Sales,SALES,#34d399
support,Support,SUPPORT,#fbbf24

# SECTION: stages
# Columns of the map, shown left-to-right in CSV order.
id,label
resources,Resources
activities,Activities
outputs,Outputs
outcomes,Outcomes

# SECTION: categories
# Box types. class = primary (fill; several blend into a gradient) or
# secondary (a small chip in the box's bottom-right). A box's category cell
# can list several ids, pipe-separated (e.g. outcome|metric).
id,label,color,text_color,class
resource,Resource,#d4a373,#1c1917,primary
activity,Activity,#7dd3fc,#082f49,primary
metric,Metric,#5eead4,#042f2e,primary
outcome,Outcome,#86efac,#052e16,primary
risk,Risk,#fca5a5,#450a0a,secondary

# SECTION: defaults
# Used when a link's \`elasticity\` cell is blank.
key,value
elasticity_enables,0.3
elasticity_increases,0.25
elasticity_decreases,-0.25

# SECTION: nodes
# controllable=true exposes the box as a slider in Simulation mode.
# direction (higher_better / lower_better) colours an outcome's glow
# green/red when the value moves materially from its starting value.
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max
team_size,Team size,People working in Operations.,ops,resources,resource,10,people,true,,3
marketing_spend,Marketing budget,Monthly spend on paid acquisition campaigns.,sales,resources,resource|risk,5000,£/mo,true,,3
support_staff,Support staff,Customer support headcount.,support,resources,resource,4,people,true,,3
content_production,Content production,Day-to-day writing and publishing of articles.,ops,activities,activity,,,,,
campaign_execution,Campaign execution,Running the paid campaigns funded by the marketing budget.,sales,activities,activity,,,,,
ticket_handling,Ticket handling,Triaging and resolving inbound support tickets.,support,activities,activity,,,,,
content_published,Content published,Number of articles or assets shipped each month.,ops,outputs,metric,20,pieces/mo,,higher_better,
leads_generated,Leads generated,New marketing-qualified leads per month.,sales,outputs,metric,100,leads/mo,,higher_better,
avg_resolution_time,Avg resolution time,Mean hours between ticket open and close.,support,outputs,metric|risk,24,hours,,lower_better,
brand_awareness,Brand awareness,Index score from a monthly survey panel.,ops,outcomes,outcome,50,index,,higher_better,
monthly_revenue,Monthly revenue,Total billable revenue for the month.,sales,outcomes,outcome|metric,50000,£/mo,,higher_better,
customer_satisfaction,Customer satisfaction,CSAT score (0-100) from post-resolution surveys.,support,outcomes,outcome,85,% CSAT,,higher_better,

# SECTION: edges
# \`effect\` describes the cause-and-effect role (enables / increases / decreases);
# \`elasticity\` is the % change in target per % change in source — leave
# blank to fall back to the default for the effect type. \`decreases\` links
# should use a NEGATIVE elasticity number.
from,to,effect,elasticity,description
team_size,content_production,enables,,More people = more content output.
content_production,content_published,increases,0.6,Content production directly drives the volume metric.
content_published,brand_awareness,increases,0.4,Sustained publishing raises brand awareness over time.
content_published,leads_generated,increases,0.2,Content is a top-of-funnel lead source (cross-team effect).
marketing_spend,campaign_execution,enables,,Budget gates how many paid campaigns can run.
campaign_execution,leads_generated,increases,0.5,Campaigns drive the bulk of marketing-qualified leads.
leads_generated,monthly_revenue,increases,0.5,Each lead converts at some rate into recurring revenue.
brand_awareness,monthly_revenue,increases,0.15,Stronger brand makes every other funnel step convert better.
support_staff,ticket_handling,enables,,Staff capacity gates how many tickets get handled.
ticket_handling,avg_resolution_time,decreases,-0.5,More handling capacity shortens average wait time.
avg_resolution_time,customer_satisfaction,decreases,-0.4,Longer waits drag the CSAT score down.
customer_satisfaction,monthly_revenue,increases,0.1,Happier customers retain longer and refer more.
`;
