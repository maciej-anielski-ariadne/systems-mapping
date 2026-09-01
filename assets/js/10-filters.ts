// =============================================================================
// VISIBILITY FILTERS — hide / show streams, categories, and stages
// -----------------------------------------------------------------------------
// Three Sets in `state` track what the user has hidden:
//   • state.hiddenStreams    — stream ids the user has toggled off (collapse row)
//   • state.hiddenCategories — category ids the user has toggled off
//   • state.hiddenStages     — stage ids the user has toggled off (collapse col)
//
// A node in a hidden stream or stage is not drawn (isNodeVisible). Hidden
// CATEGORIES work differently: they strip that fill / corner colour from every
// node carrying it, and only remove the node when a whole class of its tags is
// hidden (all its fill tags, or all its corner tags — the two are judged
// separately). Edges touching a hidden node are re-routed as synthetic
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
import {
  isNodeVisibleWithFilters,
  nodeCategoryIds,
  splitCategoriesByClass,
} from "./04-utils";

export interface FilterVisibilitySnapshot {
  hiddenStreams: Set<string>;
  hiddenStages: Set<string>;
  hiddenCategories: Set<string>;
}

// Search can take the user to a box whose row, column, or category class has
// been hidden. Keep this snapshot deliberately limited to the three filters
// that decide whether a box exists on the map; edge and trace filters do not
// affect whether the search target can be shown.
export function captureFilterVisibilitySnapshot(): FilterVisibilitySnapshot {
  return {
    hiddenStreams: new Set(state.hiddenStreams),
    hiddenStages: new Set(state.hiddenStages),
    hiddenCategories: new Set(state.hiddenCategories),
  };
}

function refreshAfterFilterVisibilityChange(layoutChanged: boolean): void {
  if (layoutChanged) setLayout(computeLayout());
  render();
  renderSidebar();
  saveUiStateToStorage();
}

// Reveal only what is required for this box. A category class hides a box only
// when every category in that class is hidden, so restoring the first category
// in a fully-hidden class is sufficient and preserves the user's other category
// choices. Returns whether any filter changed, so the caller can offer Undo
// only when it has something real to restore.
export function revealNodeByRestoringRequiredFilters(node: GraphNode): boolean {
  let layoutChanged = false;
  let filterChanged = false;

  if (state.hiddenStreams.delete(node.stream)) {
    layoutChanged = true;
    filterChanged = true;
  }
  if (state.hiddenStages.delete(node.stage)) {
    layoutChanged = true;
    filterChanged = true;
  }

  const categoriesByClass = splitCategoriesByClass(nodeCategoryIds(node));
  for (const categoryClass of [categoriesByClass.primary, categoriesByClass.secondary]) {
    if (categoryClass.length > 0 && categoryClass.every(categoryId => state.hiddenCategories.has(categoryId))) {
      state.hiddenCategories.delete(categoryClass[0]);
      filterChanged = true;
    }
  }

  if (filterChanged) refreshAfterFilterVisibilityChange(layoutChanged);
  return filterChanged;
}

// Undo for a search reveal restores the exact three filter Sets. If that makes
// the selected search result invisible again, retire the selection as normal
// filter toggles do so the detail panel never points at a missing box.
export function restoreFilterVisibilitySnapshot(snapshot: FilterVisibilitySnapshot): void {
  state.hiddenStreams = new Set(snapshot.hiddenStreams);
  state.hiddenStages = new Set(snapshot.hiddenStages);
  state.hiddenCategories = new Set(snapshot.hiddenCategories);

  const selectedNode = state.selectedNodeId ? nodeById[state.selectedNodeId] : undefined;
  if (selectedNode && !isNodeVisible(selectedNode)) {
    state.selectedNodeId = null;
    state.selectedNodeIds = new Set();
    state.selectedEdgeId = null;
    state.ancestorSet = new Set();
    state.descendantSet = new Set();
    state.highlightedEdgeIds = new Set();
  }

  setLayout(computeLayout());
  render();
  renderSidebar();
  renderDetailPanel();
  saveUiStateToStorage();
}

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

// Has this category survived the sidebar "Fill tag" / "Corner tag" filters?
// Hiding a category strips its COLOUR rather than the boxes carrying it: the
// renderer drops it from the fill gradient (nodePrimaryFill) and from the
// corner chips (nodeSecondaryChips) in 11-rendering.js, and the box itself
// only leaves the map when a whole class of its tags goes dark (isNodeVisible).
export function isCategoryVisible(categoryId: string): boolean {
  return !state.hiddenCategories.has(categoryId);
}

// A node is visible only if its stream and its stage are visible and neither
// class of tag it carries has been filtered away entirely.
export function isNodeVisible(node: GraphNode): boolean {
  return isNodeVisibleWithFilters(
    node,
    state.hiddenStreams,
    state.hiddenStages,
    state.hiddenCategories,
  );
}

// A (real) edge is drawn only if neither its effect nor its line style is
// hidden via the sidebar "Edge types" / "Line style" filters. Purely visual —
// the simulation still runs over every edge. Shared by the renderer + export.
export function isEdgeVisible(edge: Edge): boolean {
  if (state.hiddenEffects.has(edge.effect)) return false;
  if (state.hiddenStyles.has(edge.style || "solid")) return false;
  return true;
}
