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

const SAMPLE_CSV = `# Systems Map — Simple sample
# A small, neutral worked example you can use as a placeholder while learning
# the schema. Models a three-team product company (Operations, Sales,
# Support) so most readers can follow the cause-and-effect chains without
# any domain background. 12 nodes, 12 edges — small enough to grok at a
# glance, big enough to exercise every feature of the app.
#
# Drag this file onto the app to load it. Edit in Excel, Sheets, or a plain
# text editor. The "Build / Edit" wizard in the header is the no-spreadsheet
# alternative.
#
# Sections (in order): streams, stages, categories, defaults, nodes, edges.

# SECTION: streams
# id    - unique stream identifier (referenced from nodes)
# label - display name
# short - short label on the row header (uppercase, ~6 chars)
# color - hex colour for the stream's left bar
id,label,short,color
ops,Operations,OPS,#60a5fa
sales,Sales,SALES,#34d399
support,Support,SUPPORT,#fbbf24

# SECTION: stages
# Columns of the map, rendered left-to-right in CSV order.
id,label
resources,Resources
activities,Activities
outputs,Outputs
outcomes,Outcomes

# SECTION: categories
# Node types. Each gets its own fill / text colour pair.
id,label,color,text_color
resource,Resource,#d4a373,#1c1917
activity,Activity,#7dd3fc,#082f49
metric,Metric,#5eead4,#042f2e
outcome,Outcome,#86efac,#052e16

# SECTION: defaults
# Used when an edge's \`elasticity\` cell is blank.
key,value
elasticity_enables,0.3
elasticity_increases,0.25
elasticity_decreases,-0.25

# SECTION: nodes
# controllable=true exposes the node as a slider in Simulation mode.
# direction (higher_better / lower_better) colours an outcome's halo
# green/red when the value moves materially from baseline.
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max
team_size,Team size,People working in the Operations stream.,ops,resources,resource,10,people,true,,3
marketing_spend,Marketing budget,Monthly spend on paid acquisition campaigns.,sales,resources,resource,5000,£/mo,true,,3
support_staff,Support staff,Customer support headcount.,support,resources,resource,4,people,true,,3
content_production,Content production,Day-to-day writing and publishing of articles.,ops,activities,activity,,,,,
campaign_execution,Campaign execution,Running the paid campaigns funded by the marketing budget.,sales,activities,activity,,,,,
ticket_handling,Ticket handling,Triaging and resolving inbound support tickets.,support,activities,activity,,,,,
content_published,Content published,Number of articles or assets shipped each month.,ops,outputs,metric,20,pieces/mo,,higher_better,
leads_generated,Leads generated,New marketing-qualified leads per month.,sales,outputs,metric,100,leads/mo,,higher_better,
avg_resolution_time,Avg resolution time,Mean hours between ticket open and close.,support,outputs,metric,24,hours,,lower_better,
brand_awareness,Brand awareness,Index score from a monthly survey panel.,ops,outcomes,outcome,50,index,,higher_better,
monthly_revenue,Monthly revenue,Total billable revenue for the month.,sales,outcomes,outcome,50000,£/mo,,higher_better,
customer_satisfaction,Customer satisfaction,CSAT score (0-100) from post-resolution surveys.,support,outcomes,outcome,85,% CSAT,,higher_better,

# SECTION: edges
# \`effect\` describes the causal role (enables / increases / decreases);
# \`elasticity\` is the % change in target per % change in source — leave
# blank to fall back to the default for the effect type. \`decreases\` edges
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
