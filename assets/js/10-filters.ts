// =============================================================================
// VISIBILITY FILTERS — hide / show streams, categories, and stages
// -----------------------------------------------------------------------------
// Three Sets in `state` track what the user has hidden:
//   • state.hiddenStreams    — stream ids the user has toggled off (collapse row)
//   • state.hiddenCategories — category ids the user has toggled off
//   • state.hiddenStages     — stage ids the user has toggled off (collapse col)
//
// When a node belongs to any hidden stream, category, OR stage it is not drawn
// (isNodeVisible). Edges touching a hidden node are re-routed as synthetic
// "through" edges by computeRenderEdges (10a-collapsed-edges.js) rather than
// simply dropped, so causal effects stay legible across collapsed slices.
// =============================================================================

import type { GraphNode, Edge, EffectKind } from "./types";
import { state, nodeById, setLayout } from "./03-state";
import { renderDetailPanel } from "./15-detail-panel";
import { computeLayout } from "./08-layout";
import { render } from "./11-rendering";
import { renderSidebar } from "./13-sidebar";
import { saveUiStateToStorage } from "./04a-storage";
import { refreshTraceForSelection } from "./09-graph-selection";
import { nodeCategoryIds } from "./04-utils";

// Hide / show a layout-affecting "dimension" — streams collapse their row,
// stages collapse their column. Flips the id's membership in `hiddenSet`, clears
// the selection when the selected node ends up in the now-hidden slice (so the
// detail panel doesn't point at an invisible node), then recomputes the layout
// and re-renders. `nodeField` is the node property to match the id against
// ("stream" or "stage").
export function setDimensionVisibility(
  hiddenSet: Set<string>,
  id: string,
  nodeField: "stream" | "stage"
): void {
  if (hiddenSet.has(id)) hiddenSet.delete(id);
  else hiddenSet.add(id);

  const selected = state.selectedNodeId && nodeById[state.selectedNodeId];
  if (selected && selected[nodeField] === id && hiddenSet.has(id)) {
    state.selectedNodeId = null;
    state.ancestorSet = new Set();
    state.descendantSet = new Set();
    state.highlightedEdgeIds = new Set();
    renderDetailPanel();
  }
  // Hidden rows/columns change the layout, so recompute before re-rendering.
  setLayout(computeLayout());
  render();
  renderSidebar();
  saveUiStateToStorage();
}

export function toggleStream(streamId: string): void {
  setDimensionVisibility(state.hiddenStreams, streamId, "stream");
}

// Collapse / expand a whole stage (column). Hiding one shrinks its column to a
// thin clickable stub and drops its nodes from the map; causal effects that ran
// THROUGH the hidden nodes are still shown as synthetic "through" edges between
// the visible stages either side — see computeRenderEdges in 10a-collapsed-edges.js.
export function toggleStage(stageId: string): void {
  // Don't leave the keyboard "type to create" cursor parked in a column that's
  // about to collapse (it's still visible now, so this toggle will hide it).
  if (state.canvasEdit && state.canvasEdit.cursorCell &&
      state.canvasEdit.cursorCell.stageId === stageId &&
      !state.hiddenStages.has(stageId)) {
    state.canvasEdit.cursorCell = null;
  }
  setDimensionVisibility(state.hiddenStages, stageId, "stage");
}

// Flip an id in a non-layout "hidden" filter set, then re-render + persist.
// Categories, edge effects, line styles, and trace directions all toggle this
// way (they don't change layout or the selection, unlike the stream/stage
// dimensions, which go through setDimensionVisibility). `beforeRender` runs
// after the flip but before re-rendering — the trace filter uses it to
// recompute the current selection's highlight.
export function toggleHiddenFilter(
  hiddenSet: Set<string>,
  id: string,
  beforeRender?: () => void
): void {
  if (hiddenSet.has(id)) hiddenSet.delete(id);
  else hiddenSet.add(id);
  if (beforeRender) beforeRender();
  render();
  renderSidebar();
  saveUiStateToStorage();
}

export function toggleCategory(categoryId: string): void { toggleHiddenFilter(state.hiddenCategories, categoryId); }
export function toggleEffect(effect: string): void    { toggleHiddenFilter(state.hiddenEffects, effect); }
export function toggleStyle(style: string): void          { toggleHiddenFilter(state.hiddenStyles, style); }
export function toggleTrace(dir: string): void            { toggleHiddenFilter(state.hiddenTrace, dir, refreshTraceForSelection); }

// A node is visible only if its stream, its category, AND its stage are all
// visible.
export function isNodeVisible(node: GraphNode): boolean {
  if (state.hiddenStreams.has(node.stream)) return false;
  if (state.hiddenStages.has(node.stage)) return false;
  // Hidden if ANY category the node carries (primary or secondary) is hidden.
  for (const c of nodeCategoryIds(node)) if (state.hiddenCategories.has(c)) return false;
  return true;
}

// A (real) edge is drawn only if neither its effect nor its line style is
// hidden via the sidebar "Edge types" / "Line style" filters. Purely visual —
// the simulation still runs over every edge. Shared by the renderer + export.
export function isEdgeVisible(edge: Edge): boolean {
  if (state.hiddenEffects.has(edge.effect)) return false;
  if (state.hiddenStyles.has(edge.style || "solid")) return false;
  return true;
}
