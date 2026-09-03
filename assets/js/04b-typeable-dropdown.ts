// =============================================================================
// TYPEABLE DROPDOWN — upgrades native <select> elements into filter-as-you-type
// -----------------------------------------------------------------------------
// `upgradeSelectsIn(container)` walks `container` for any unupgraded <select>
// and wraps each one:
//
//   <span class="typeable-dropdown">
//     <input class="typeable-dropdown-input" ...>      ← visible, typable
//     <select class="typeable-dropdown-native" ...>    ← kept in DOM, hidden
//     <div  class="typeable-dropdown-popup">…</div>    ← floating listbox
//   </span>
//
// The native <select> stays in the DOM and keeps all its `data-*` attributes.
// All existing code that reads `select.value` or listens for `change` on
// `[data-field]` / `[data-section]` keeps working — picking an option in the
// widget sets `select.value` and dispatches a bubbling `change` event on the
// select.
//
// The added <input> deliberately has NO `data-section`/`data-field` so it
// doesn't get picked up by per-cell listeners that iterate those attributes.
// Builder Tab/Enter navigation (16d-builder-events.ts) recognises it via the
// `.typeable-dropdown-input` class.
//
// Two ways in:
//
//   upgradeSelectsIn(container)      — upgrade every <select> now. For small,
//                                      always-visible groups (the detail panel,
//                                      the wizard's bulk-action bar).
//   upgradeSelectsLazilyIn(container)— one delegated listener; upgrade a select
//                                      the first time it is entered. For a
//                                      container holding thousands of them,
//                                      where upgrading all of them costs more
//                                      than the page is worth. A renderer using
//                                      this may also emit a select carrying only
//                                      its selected <option> and register a
//                                      setLazySelectPreparer() to build the rest
//                                      at upgrade time.
//
// The popup renders at most POPUP_MAX_RENDERED matches and summarises the tail,
// so filtering a very long list stays responsive per keystroke.
//
// Popup positioning is `position: fixed` so it floats above scroll containers
// (e.g. the builder table's scroll area, which has overflow:auto).
//
// ESM note: this file was historically an IIFE that hung `upgradeSelectsIn` off
// `window`. It is now a normal module — the function is a named export and the
// document-level outside-click listener at the bottom runs once on first import.
// =============================================================================

interface DropdownItem {
  value: string;
  label: string;
  optionIndex: number;
}

interface OpenInstance {
  close: () => void;
  commitOrRevert: () => boolean;
  reposition: () => void;
}

// A fixed-position popup is only viewport-relative while none of its ancestors
// establishes a containing block. Tutorial highlighting deliberately uses a
// visual filter, which does establish one; leaving the popup inside a
// highlighted panel therefore applies viewport coordinates relative to the
// panel a second time and can place the options off-screen. Mount open popups
// directly under <body>, then return them to their wrapper when they close.
function mountPopupAtViewportLevel(popup: HTMLElement): void {
  if (document.body && popup.parentElement !== document.body) {
    document.body.appendChild(popup);
  }
}

function restorePopupToWrapper(popup: HTMLElement, wrapper: HTMLElement): void {
  if (wrapper.isConnected) {
    wrapper.appendChild(popup);
  } else {
    popup.remove();
  }
}

// Shared bookkeeping for the popup that is currently open. Only one popup
// can be open at a time — opening another closes any in-flight one.
let openInstance: OpenInstance | null = null;

// How many matching options the popup actually puts in the DOM. Everything
// past this is summarised by one non-selectable footer row. Without the cap a
// keystroke against a 5000-box map rebuilt 5000 <div>s per character typed,
// which is the whole point of a filter box being unusable.
export const POPUP_MAX_RENDERED = 200;

// Public entry point — called from renderers after innerHTML changes.
export function upgradeSelectsIn(container: ParentNode | null | undefined): void {
  if (!container || typeof container.querySelectorAll !== "function") return;
  const selects = container.querySelectorAll<HTMLSelectElement>(
    "select:not(.typeable-dropdown-native)",
  );
  selects.forEach(upgradeSelect);
}

// Finite app controls use the same non-typeable dropdown as the box-edit
// sidebar. Renderers call this after replacing their markup so no native
// browser picker remains visible on small, fixed option sets.
export function upgradeSelectionOnlySelectsIn(
  container: ParentNode | null | undefined,
): void {
  if (!container || typeof container.querySelectorAll !== "function") return;
  const selects = container.querySelectorAll<HTMLSelectElement>(
    "select:not(.typeable-dropdown-native)",
  );
  selects.forEach(selectElement => {
    selectElement.setAttribute("data-dropdown-mode", "select-only");
    upgradeSelect(selectElement);
  });
}

// Lazy entry point — for containers holding a great many <select>s, where
// upgrading all of them up front is the expense. Each upgrade adds three
// elements and ~8 listeners; a builder Boxes step with 5000 rows carries 25000
// selects, so eager upgrading is seconds of work for controls the user will
// touch a handful of.
//
// Instead, attach ONE delegated listener to `container` and upgrade a select
// the first time it is entered — then hand it the focus, so from the user's
// side the control behaves exactly as if it had been upgraded all along.
// `mousedown` is handled in the capture phase as well as `focusin`, because a
// native <select> opens its own popup on mousedown; preventing that is what
// stops the OS dropdown flashing open before the typable one replaces it.
//
// Idempotent: calling it again on the same container is a no-op, so renderers
// may call it after every re-render.
export function upgradeSelectsLazilyIn(container: HTMLElement | null | undefined): void {
  if (!container || typeof container.addEventListener !== "function") return;
  if (container.dataset.typeableLazy === "true") return;
  container.dataset.typeableLazy = "true";

  container.addEventListener("focusin", (event) => {
    upgradeAndFocus(pendingSelectFrom(event.target));
  });
  container.addEventListener(
    "mousedown",
    (event) => {
      const select = pendingSelectFrom(event.target);
      if (!select) return;
      event.preventDefault(); // suppress the native dropdown
      upgradeAndFocus(select);
    },
    true,
  );
}

// The not-yet-upgraded <select> an event landed on, or null.
function pendingSelectFrom(target: EventTarget | null): HTMLSelectElement | null {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return null;
  return el.closest(
    'select:not(.typeable-dropdown-native):not([data-dropdown-mode="select-only"])',
  ) as HTMLSelectElement | null;
}

// Optional hook run against a <select> immediately before it is upgraded.
// Lazy upgrading lets a renderer emit a select carrying ONLY its selected
// option — the resting control looks identical, and the full list (which may be
// thousands of entries, per select) is built here, once, for the one control
// the user actually opened. 16b-builder-render.ts registers the builder's.
let lazySelectPreparer: ((select: HTMLSelectElement) => void) | null = null;
export function setLazySelectPreparer(fn: ((select: HTMLSelectElement) => void) | null): void {
  lazySelectPreparer = fn;
}

function upgradeAndFocus(select: HTMLSelectElement | null): void {
  if (!select) return;
  if (lazySelectPreparer) lazySelectPreparer(select);
  upgradeSelect(select);
  const input = select.parentElement
    ? (select.parentElement.querySelector(".typeable-dropdown-input") as HTMLInputElement | null)
    : null;
  if (input && typeof input.focus === "function") input.focus();
}

function upgradeSelect(select: HTMLSelectElement): void {
  if (select.getAttribute("data-dropdown-mode") === "select-only") {
    upgradeSelectionOnlySelect(select);
    return;
  }
  upgradeTypeableSelect(select);
}

let selectionOnlyDropdownIdentifier = 0;
let typeableDropdownIdentifier = 0;

function upgradeSelectionOnlySelect(select: HTMLSelectElement): void {
  if (!select || select.classList.contains("typeable-dropdown-native")) return;

  const wrapper = document.createElement("span");
  wrapper.className = "typeable-dropdown selection-only-dropdown";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "typeable-dropdown-button" + (select.className ? " " + select.className : "");
  button.setAttribute("role", "combobox");
  button.setAttribute("aria-autocomplete", "none");
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");
  const accessibleLabel = select.getAttribute("aria-label");
  if (accessibleLabel) button.setAttribute("aria-label", accessibleLabel);

  const popup = document.createElement("div");
  popup.className = "typeable-dropdown-popup";
  popup.setAttribute("role", "listbox");
  popup.hidden = true;
  const popupIdentifier = "selection-only-dropdown-" + (++selectionOnlyDropdownIdentifier);
  popup.id = popupIdentifier;
  button.setAttribute("aria-controls", popupIdentifier);

  const parent = select.parentNode!;
  parent.insertBefore(wrapper, select);
  wrapper.appendChild(button);
  wrapper.appendChild(select);
  wrapper.appendChild(popup);
  select.classList.add("typeable-dropdown-native");
  select.setAttribute("aria-hidden", "true");
  select.tabIndex = -1;

  let dropdownItems: DropdownItem[] = [];
  let highlightedItemIndex = 0;

  const syncButtonFromSelect = (): void => {
    button.textContent = currentSelectedLabel(select);
  };

  const renderedItemCount = (): number => Math.min(dropdownItems.length, POPUP_MAX_RENDERED);

  const scrollHighlightedItemIntoView = (): void => {
    const highlightedElement = popup.children[highlightedItemIndex] as HTMLElement | undefined;
    if (!highlightedElement) return;
    const visibleTop = popup.scrollTop;
    const visibleBottom = visibleTop + popup.clientHeight;
    const highlightedTop = highlightedElement.offsetTop;
    const highlightedBottom = highlightedTop + highlightedElement.offsetHeight;
    if (highlightedTop < visibleTop) {
      popup.scrollTop = highlightedTop;
    } else if (highlightedBottom > visibleBottom) {
      popup.scrollTop = highlightedBottom - popup.clientHeight;
    }
  };

  const renderPopupBody = (): void => {
    let popupMarkup = "";
    for (let itemIndex = 0; itemIndex < renderedItemCount(); itemIndex++) {
      const dropdownItem = dropdownItems[itemIndex];
      const className = "typeable-dropdown-item" +
        (itemIndex === highlightedItemIndex ? " highlighted" : "") +
        (dropdownItem.value === select.value ? " current" : "");
      popupMarkup += '<div class="' + className + '" data-item-index="' + itemIndex +
        '" role="option" aria-selected="' + (dropdownItem.value === select.value) + '">' +
        escapeForHtml(dropdownItem.label) + '</div>';
    }
    popup.innerHTML = popupMarkup;
  };

  const rebuildDropdownItems = (): void => {
    dropdownItems = Array.from(select.options).map((option, optionIndex) => ({
      value: option.value,
      label: option.text || "",
      optionIndex: optionIndex,
    }));
    const selectedItemIndex = dropdownItems.findIndex(dropdownItem => dropdownItem.value === select.value);
    highlightedItemIndex = selectedItemIndex >= 0 ? selectedItemIndex : 0;
    if (highlightedItemIndex >= renderedItemCount()) highlightedItemIndex = 0;
    renderPopupBody();
  };

  const positionPopup = (): void => {
    const buttonRectangle = button.getBoundingClientRect();
    const spaceBelow = window.innerHeight - buttonRectangle.bottom;
    const spaceAbove = buttonRectangle.top;
    const desiredMaximumHeight = 240;
    let maximumHeight = Math.min(desiredMaximumHeight, Math.max(80, spaceBelow - 8));
    let popupTop = buttonRectangle.bottom + 2;
    if (spaceBelow < 140 && spaceAbove > spaceBelow) {
      maximumHeight = Math.min(desiredMaximumHeight, Math.max(80, spaceAbove - 8));
      popupTop = buttonRectangle.top - 2 - maximumHeight;
    }
    popup.style.top = popupTop + "px";
    popup.style.minWidth = buttonRectangle.width + "px";
    popup.style.maxHeight = maximumHeight + "px";
    // Left-align with the trigger, then pull back inside if the list is wider
    // than the room to its right — a dropdown on a control near the right edge
    // would otherwise run off the window.
    popup.style.left = buttonRectangle.left + "px";
    const popupWidth = popup.getBoundingClientRect().width;
    const rightmostLeft = window.innerWidth - 8 - popupWidth;
    popup.style.left = Math.max(8, Math.min(buttonRectangle.left, rightmostLeft)) + "px";
  };

  const closeDropdown = (): void => {
    if (popup.hidden) return;
    popup.hidden = true;
    wrapper.classList.remove("open");
    button.setAttribute("aria-expanded", "false");
    window.removeEventListener("scroll", positionPopup, true);
    window.removeEventListener("resize", positionPopup);
    restorePopupToWrapper(popup, wrapper);
    if (openInstance?.close === closeDropdown) openInstance = null;
  };

  const closeWithoutChange = (): boolean => {
    closeDropdown();
    return false;
  };

  const openDropdown = (): void => {
    if (openInstance && openInstance.close !== closeDropdown) openInstance.close();
    rebuildDropdownItems();
    mountPopupAtViewportLevel(popup);
    popup.hidden = false;
    wrapper.classList.add("open");
    button.setAttribute("aria-expanded", "true");
    positionPopup();
    openInstance = {
      close: closeDropdown,
      commitOrRevert: closeWithoutChange,
      reposition: positionPopup,
    };
    window.addEventListener("scroll", positionPopup, true);
    window.addEventListener("resize", positionPopup);
    scrollHighlightedItemIntoView();
  };

  const setHighlightedItem = (itemIndex: number): void => {
    if (itemIndex < 0 || itemIndex >= renderedItemCount()) return;
    const previousElement = popup.children[highlightedItemIndex];
    if (previousElement) previousElement.classList.remove("highlighted");
    highlightedItemIndex = itemIndex;
    const nextElement = popup.children[highlightedItemIndex];
    if (nextElement) nextElement.classList.add("highlighted");
    scrollHighlightedItemIntoView();
  };

  const commitDropdownItem = (dropdownItem: DropdownItem | undefined): void => {
    if (!dropdownItem) return;
    const valueChanged = select.value !== dropdownItem.value;
    select.value = dropdownItem.value;
    syncButtonFromSelect();
    closeDropdown();
    if (valueChanged) select.dispatchEvent(new Event("change", { bubbles: true }));
  };

  syncButtonFromSelect();

  button.addEventListener("click", () => {
    if (popup.hidden) openDropdown();
    else closeDropdown();
  });

  button.addEventListener("keydown", event => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (popup.hidden) {
        openDropdown();
        return;
      }
      const itemIndexDelta = event.key === "ArrowDown" ? 1 : -1;
      setHighlightedItem(Math.max(0, Math.min(
        highlightedItemIndex + itemIndexDelta,
        renderedItemCount() - 1,
      )));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      if (popup.hidden) openDropdown();
      else commitDropdownItem(dropdownItems[highlightedItemIndex]);
    } else if (event.key === "Escape" && !popup.hidden) {
      event.preventDefault();
      event.stopPropagation();
      closeDropdown();
    }
  });

  popup.addEventListener("mousedown", event => {
    const itemElement = (event.target as HTMLElement).closest(".typeable-dropdown-item");
    if (!itemElement) return;
    event.preventDefault();
    event.stopPropagation();
  });

  popup.addEventListener("click", event => {
    const itemElement = (event.target as HTMLElement).closest(".typeable-dropdown-item");
    if (!itemElement) return;
    event.preventDefault();
    event.stopPropagation();
    const itemIndex = Number.parseInt(itemElement.getAttribute("data-item-index") || "", 10);
    if (Number.isFinite(itemIndex)) commitDropdownItem(dropdownItems[itemIndex]);
  });

  popup.addEventListener("mousemove", event => {
    const itemElement = (event.target as HTMLElement).closest(".typeable-dropdown-item");
    if (!itemElement) return;
    const itemIndex = Number.parseInt(itemElement.getAttribute("data-item-index") || "", 10);
    if (!Number.isFinite(itemIndex) || itemIndex === highlightedItemIndex) return;
    setHighlightedItem(itemIndex);
  });

  select.addEventListener("change", syncButtonFromSelect);
}

function upgradeTypeableSelect(select: HTMLSelectElement): void {
  if (!select || select.classList.contains("typeable-dropdown-native")) return;

  // Wrapper sits inline where the <select> used to. The native select is
  // hidden via CSS but kept so existing read/write paths still work.
  const wrap = document.createElement("span");
  wrap.className = "typeable-dropdown";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "typeable-dropdown-input";
  input.setAttribute("autocomplete", "off");
  input.setAttribute("spellcheck", "false");
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");

  // Carry over styling-only classes so the input sits in the same visual
  // slot as the original <select>. Functional / state classes like
  // `invalid` are caught too — we want the same red border on the input.
  // The `typeable-dropdown-native` marker is added below and is not copied.
  if (select.className) {
    input.className += " " + select.className;
  }

  const popup = document.createElement("div");
  popup.className = "typeable-dropdown-popup";
  popup.setAttribute("role", "listbox");
  popup.hidden = true;
  const popupIdentifier = "typeable-dropdown-" + (++typeableDropdownIdentifier);
  popup.id = popupIdentifier;
  input.setAttribute("aria-controls", popupIdentifier);

  // Splice the wrapper in where the select used to be.
  const parent = select.parentNode!;
  parent.insertBefore(wrap, select);
  wrap.appendChild(input);
  wrap.appendChild(select);
  wrap.appendChild(popup);

  select.classList.add("typeable-dropdown-native");
  select.setAttribute("aria-hidden", "true");
  select.tabIndex = -1;

  // Reflect the select's current selection in the input's display.
  syncInputFromSelect(select, input);

  // Local state for the open popup.
  let items: DropdownItem[] = [];
  let highlighted = 0;

  const rebuildItems = (query: string) => {
    const lower = String(query || "")
      .toLowerCase()
      .trim();
    items = [];
    for (let i = 0; i < select.options.length; i++) {
      const opt = select.options[i];
      const label = opt.text || "";
      if (!lower || label.toLowerCase().includes(lower)) {
        items.push({ value: opt.value, label: label, optionIndex: i });
      }
    }
    // Pre-highlight the option that matches the current value when no query
    // has been typed — feels natural to open the popup and see the current
    // pick in focus.
    if (!lower) {
      const cur = items.findIndex((it) => it.value === select.value);
      highlighted = cur >= 0 ? cur : 0;
    } else {
      highlighted = 0;
    }
    // The highlight can only ever sit on a row that exists in the DOM —
    // setHighlighted and scrollHighlightedIntoView both index popup.children.
    // On a list long enough to be truncated, a current value past the cut
    // starts the popup at the top instead; the input still shows that value,
    // and typing a few characters brings it into the rendered set.
    if (highlighted >= renderedCount()) highlighted = 0;
    renderPopupBody();
  };

  // How many of `items` the popup actually draws.
  const renderedCount = () => Math.min(items.length, POPUP_MAX_RENDERED);

  const renderPopupBody = () => {
    if (items.length === 0) {
      popup.innerHTML = '<div class="typeable-dropdown-empty">No matches</div>';
      return;
    }
    const shown = renderedCount();
    let html = "";
    for (let i = 0; i < shown; i++) {
      const cls =
        "typeable-dropdown-item" +
        (i === highlighted ? " highlighted" : "") +
        (items[i].value === select.value ? " current" : "");
      html +=
        '<div class="' +
        cls +
        '" data-i="' +
        i +
        '" role="option">' +
        escapeForHtml(items[i].label) +
        "</div>";
    }
    // Truncation notice. Deliberately NOT a .typeable-dropdown-item, so the
    // mousedown / mousemove handlers below (which match on that class) can't
    // select or highlight it — it is a label, not an option.
    if (items.length > shown) {
      html +=
        '<div class="typeable-dropdown-more">' +
        (items.length - shown) +
        " more — keep typing to narrow</div>";
    }
    popup.innerHTML = html;
  };

  const positionPopup = () => {
    const rect = input.getBoundingClientRect();
    // Default below; flip above if there isn't room.
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const desiredMax = 240;
    let maxHeight = Math.min(desiredMax, Math.max(80, spaceBelow - 8));
    let top = rect.bottom + 2;
    if (spaceBelow < 140 && spaceAbove > spaceBelow) {
      maxHeight = Math.min(desiredMax, Math.max(80, spaceAbove - 8));
      top = rect.top - 2 - maxHeight;
    }
    popup.style.top = top + "px";
    popup.style.minWidth = rect.width + "px";
    popup.style.maxHeight = maxHeight + "px";
    // Left-align with the field, then pull back inside if the list is wider
    // than the room to its right. The detail panel sits flush against the
    // window edge, so its dropdowns are the ones that would run off.
    popup.style.left = rect.left + "px";
    const popupWidth = popup.getBoundingClientRect().width;
    const rightmostLeft = window.innerWidth - 8 - popupWidth;
    popup.style.left = Math.max(8, Math.min(rect.left, rightmostLeft)) + "px";
  };

  // Commit pending typed text if it differs from the current selection,
  // otherwise restore the input to match. Used by Tab, blur, AND the
  // document-level outside-click handler — that last one is the important
  // one: when the user types a filter and clicks an action button (e.g.
  // "Add edge" in the detail panel), the button's click handler reads
  // `select.value` immediately, before blur would normally fire, so we
  // have to commit synchronously inside the mousedown that precedes the
  // click. Returns true if something was committed.
  const commitOrRevert = (): boolean => {
    const typed = input.value.trim();
    const currentLabel = currentSelectedLabel(select).trim();
    if (typed && typed.toLowerCase() !== currentLabel.toLowerCase() && items.length > 0) {
      commitItem(items[highlighted]);
      return true;
    }
    syncInputFromSelect(select, input);
    close();
    return false;
  };

  const open = (initialQuery?: string) => {
    // Close any other open popup first — only one at a time.
    if (openInstance && openInstance.close !== close) openInstance.close();
    rebuildItems(initialQuery !== undefined ? initialQuery : "");
    mountPopupAtViewportLevel(popup);
    popup.hidden = false;
    wrap.classList.add("open");
    input.setAttribute("aria-expanded", "true");
    positionPopup();
    openInstance = { close: close, commitOrRevert: commitOrRevert, reposition: positionPopup };
    window.addEventListener("scroll", positionPopup, true);
    window.addEventListener("resize", positionPopup);
    scrollHighlightedIntoView();
  };

  const close = () => {
    if (popup.hidden) return;
    popup.hidden = true;
    wrap.classList.remove("open");
    input.setAttribute("aria-expanded", "false");
    window.removeEventListener("scroll", positionPopup, true);
    window.removeEventListener("resize", positionPopup);
    restorePopupToWrapper(popup, wrap);
    if (openInstance && openInstance.close === close) openInstance = null;
  };

  const scrollHighlightedIntoView = () => {
    const highlightedElement = popup.children[highlighted] as HTMLElement | undefined;
    if (!highlightedElement) return;
    const visibleTop = popup.scrollTop;
    const visibleBottom = visibleTop + popup.clientHeight;
    const highlightedTop = highlightedElement.offsetTop;
    const highlightedBottom = highlightedTop + highlightedElement.offsetHeight;
    if (highlightedTop < visibleTop) {
      popup.scrollTop = highlightedTop;
    } else if (highlightedBottom > visibleBottom) {
      popup.scrollTop = highlightedBottom - popup.clientHeight;
    }
  };

  const setHighlighted = (idx: number) => {
    if (idx < 0 || idx >= renderedCount()) return;
    const prev = popup.children[highlighted];
    if (prev) prev.classList.remove("highlighted");
    highlighted = idx;
    const next = popup.children[highlighted];
    if (next) next.classList.add("highlighted");
    scrollHighlightedIntoView();
  };

  const commitItem = (item: DropdownItem | undefined) => {
    if (!item) return;
    const changed = select.value !== item.value;
    select.value = item.value;
    input.value = item.label;
    close();
    if (changed) {
      // Existing handlers listen on `change` of `[data-field]` etc — they
      // get the right (id) value via `select.value`.
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  };

  // ─── Input events ──────────────────────────────────────────────────────
  input.addEventListener("focus", () => {
    // Show the full list when the cell is entered — clearer than starting
    // with the current label as a filter (which would show one item and
    // hide the rest).
    input.select();
    open("");
  });

  input.addEventListener("click", () => {
    if (popup.hidden) open(input.value);
  });

  input.addEventListener("input", (event) => {
    // The widget owns the input's value — never bubble its raw typing up
    // to delegated handlers that would try to write it to state.
    event.stopPropagation();
    if (popup.hidden) {
      open(input.value);
    } else {
      rebuildItems(input.value);
    }
  });

  // Native browsers fire `change` on text inputs at blur — block it from
  // bubbling to delegated handlers that would write the typed label to
  // state. The select dispatches its own `change` when we commit.
  input.addEventListener("change", (event) => {
    event.stopPropagation();
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (popup.hidden) {
        open(input.value);
        return;
      }
      setHighlighted(Math.min(highlighted + 1, renderedCount() - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (popup.hidden) {
        open(input.value);
        return;
      }
      setHighlighted(Math.max(highlighted - 1, 0));
    } else if (event.key === "Enter") {
      if (!popup.hidden && items.length > 0) {
        event.preventDefault();
        event.stopPropagation();
        commitItem(items[highlighted]);
      } else if (popup.hidden) {
        event.preventDefault();
        event.stopPropagation();
        open(input.value);
      }
    } else if (event.key === "Escape") {
      if (!popup.hidden) {
        event.preventDefault();
        event.stopPropagation();
        syncInputFromSelect(select, input);
        close();
      }
    } else if (event.key === "Tab") {
      // Tab leaves the cell — auto-commit any typed filter so the user's
      // intent isn't lost when moving forward. Don't preventDefault: the
      // builder's keydown handler (16d) takes care of navigation.
      if (!popup.hidden) commitOrRevert();
    }
  });

  input.addEventListener("blur", () => {
    // Late safety net — the outside-mousedown handler already commits
    // typed text in time for action-button clicks. By the time this fires,
    // commitOrRevert may have already run; the function is idempotent so
    // calling it again is fine.
    setTimeout(() => {
      if (document.activeElement === input) return;
      if (popup.contains(document.activeElement)) return;
      commitOrRevert();
    }, 0);
  });

  // ─── Popup events ─────────────────────────────────────────────────────
  popup.addEventListener("mousedown", (event) => {
    // Keep focus on the input until click commits the highlighted option.
    // Removing the popup during mousedown lets the later click hit whatever
    // was underneath it, which is especially destructive over Review cards.
    const item = (event.target as HTMLElement).closest(".typeable-dropdown-item");
    if (!item) return;
    event.preventDefault();
    event.stopPropagation();
  });

  popup.addEventListener("click", (event) => {
    const item = (event.target as HTMLElement).closest(".typeable-dropdown-item");
    if (!item) return;
    event.preventDefault();
    event.stopPropagation();
    const itemIndex = Number.parseInt(item.getAttribute("data-i")!, 10);
    if (Number.isFinite(itemIndex) && items[itemIndex]) commitItem(items[itemIndex]);
  });

  popup.addEventListener("mousemove", (event) => {
    const item = (event.target as HTMLElement).closest(".typeable-dropdown-item");
    if (!item) return;
    const idx = parseInt(item.getAttribute("data-i")!, 10);
    if (isNaN(idx) || idx === highlighted) return;
    const prev = popup.children[highlighted];
    if (prev) prev.classList.remove("highlighted");
    highlighted = idx;
    item.classList.add("highlighted");
  });
}

function syncInputFromSelect(select: HTMLSelectElement, input: HTMLInputElement): void {
  input.value = currentSelectedLabel(select);
}

function currentSelectedLabel(select: HTMLSelectElement): string {
  const opt = select.options[select.selectedIndex];
  return opt ? opt.text || "" : "";
}

// Local HTML escape — duplicated (rather than relying on global escapeHtml)
// so this widget is self-contained and load-order tolerant.
function escapeForHtml(s: unknown): string {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Close-on-outside-click. mousedown (capture) so we run BEFORE the
// intercepted button's own click handler — that lets us commit any
// typed filter into the underlying <select> in time for the action
// button to read the up-to-date value.
//
// We don't dismiss on clicks INSIDE the dropdown or its popup. The popup
// is position:fixed and therefore not always a descendant of the wrapper
// for layout purposes, but it remains a DOM child of the wrapper, so the
// `.typeable-dropdown` closest() check covers both.
document.addEventListener(
  "mousedown",
  (event) => {
    if (!openInstance) return;
    const t = event.target as HTMLElement;
    if (t.closest && (t.closest(".typeable-dropdown") || t.closest(".typeable-dropdown-popup")))
      return;
    if (typeof openInstance.commitOrRevert === "function") {
      openInstance.commitOrRevert();
    } else {
      openInstance.close();
    }
  },
  true,
);
