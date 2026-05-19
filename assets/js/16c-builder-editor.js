// =============================================================================
// BUILDER PANEL — floating "expand this cell" editor
// -----------------------------------------------------------------------------
// When the user focuses a text or number cell inside the wizard, we pop up
// a wider, taller editor anchored near the cell. The cell's <input> stays
// the source of truth — the editor's textarea mirrors back to it (and
// dispatches a normal "input" event) so the handleBuilderInput path in
// 16d-builder-events.js keeps working unchanged.
//
// One editor at a time, lives on document.body (so it can spill past the
// wizard card if the cell is near a screen edge). Closed by Esc, click
// outside, or by focusing a different editable cell.
// =============================================================================

const CELL_EDITOR_TYPES_SELECTOR = '.builder-table input[type="text"], .builder-table input[type="number"]';
let cellEditorState = null;

// Look up the column heading for a cell so the editor's title can say
// "Description · Row 4" instead of just "Edit cell".
function columnHeaderForCell(cell) {
  const td = cell.closest("td");
  if (!td) return "";
  const tr = td.parentElement;
  const colIndex = Array.prototype.indexOf.call(tr.children, td);
  const table = cell.closest("table");
  const ths = table ? table.querySelectorAll("thead th") : [];
  return (ths[colIndex] && ths[colIndex].textContent.trim()) || "";
}

function openCellEditor(trigger) {
  // If we're already editing the same cell, nothing to do.
  if (cellEditorState && cellEditorState.trigger === trigger) return;
  hideCellEditor();

  const columnLabel = columnHeaderForCell(trigger) || "Edit cell";
  const rowIndex = parseInt(trigger.getAttribute("data-index"), 10);
  const rowDescriptor = isNaN(rowIndex) ? "" : ("Row " + (rowIndex + 1));

  const editor = document.createElement("div");
  editor.className = "builder-cell-editor";
  editor.innerHTML =
    '<div class="builder-cell-editor-title">' +
      '<b>' + escapeHtml(columnLabel) + '</b>' +
      (rowDescriptor ? '<span>' + escapeHtml(rowDescriptor) + '</span>' : '') +
    '</div>' +
    '<textarea class="builder-cell-editor-textarea" spellcheck="true"></textarea>' +
    '<div class="builder-cell-editor-hint"><kbd>Esc</kbd> close · click outside to dismiss · changes save as you type</div>';
  document.body.appendChild(editor);

  const textarea = editor.querySelector("textarea");
  textarea.value = trigger.value;

  // Position the editor near the trigger. Prefer below-and-aligned-left.
  // If it would overflow, flip / clamp into the viewport.
  positionCellEditor(editor, trigger);

  // Re-position when the page scrolls (wizard scroll area is the typical case).
  const onScroll = () => positionCellEditor(editor, trigger);
  window.addEventListener("scroll", onScroll, true);

  // Sync textarea → trigger input → state.builder (handleBuilderInput picks
  // it up via the existing delegated "input" listener on the overlay).
  const sync = () => {
    trigger.value = textarea.value;
    trigger.dispatchEvent(new Event("input",  { bubbles: true }));
    trigger.dispatchEvent(new Event("change", { bubbles: true }));
  };
  textarea.addEventListener("input", sync);

  // Esc closes; Cmd/Ctrl+Enter also closes (for keyboard-driven dismiss).
  textarea.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      event.stopPropagation();
      event.preventDefault();
      hideCellEditor();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      hideCellEditor();
    }
  });

  // Click outside the editor or its trigger closes it.
  const onMouseDownOutside = event => {
    if (editor.contains(event.target)) return;
    if (event.target === trigger)       return;
    // Clicking another editable cell will open a new editor; let that
    // happen naturally via focusin.
    hideCellEditor();
  };
  // Defer to next tick so the current click that opened us doesn't count.
  setTimeout(() => document.addEventListener("mousedown", onMouseDownOutside), 0);

  cellEditorState = { editor, trigger, textarea, onScroll, onMouseDownOutside };
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

function positionCellEditor(editor, trigger) {
  const rect = trigger.getBoundingClientRect();
  const margin = 12;
  const editorWidth = editor.offsetWidth || 480;
  const editorHeight = editor.offsetHeight || 200;

  let left = rect.left;
  if (left + editorWidth > window.innerWidth - margin) {
    left = window.innerWidth - editorWidth - margin;
  }
  if (left < margin) left = margin;

  let top = rect.bottom + 4;
  if (top + editorHeight > window.innerHeight - margin) {
    // Try placing above the trigger instead.
    const above = rect.top - editorHeight - 4;
    top = above >= margin ? above : Math.max(margin, window.innerHeight - editorHeight - margin);
  }

  editor.style.left = left + "px";
  editor.style.top  = top + "px";
}

function hideCellEditor() {
  if (!cellEditorState) return;
  const { editor, onScroll, onMouseDownOutside } = cellEditorState;
  window.removeEventListener("scroll", onScroll, true);
  document.removeEventListener("mousedown", onMouseDownOutside);
  if (editor && editor.parentNode) editor.parentNode.removeChild(editor);
  cellEditorState = null;
}

// Delegated focusin handler — used by attachBuilderEvents() in
// 16d-builder-events.js. Opens the floating editor for the focused cell
// if it's a text / number input (not selects, colors, checkboxes — those
// have native UIs that already work well).
function handleBuilderFocus(event) {
  if (event.target.matches(CELL_EDITOR_TYPES_SELECTOR)) {
    openCellEditor(event.target);
  }
}
