/* =============================================================================
 * CONFIRM — the app's own "are you sure?"
 * -----------------------------------------------------------------------------
 * Every destructive action used to gate on the native window.confirm(). That is
 * not a dialog the app controls, and in several ordinary situations it never
 * appears and returns false immediately:
 *
 *   • embedded and preview browsers suppress it;
 *   • a cross-origin iframe is not allowed to show one at all;
 *   • the browser's own "prevent this page from creating additional dialogs"
 *     box, once ticked, silences every later call for the rest of the session.
 *
 * A suppressed confirm() returns false, and `if (!confirm(msg)) return;` reads
 * that as "the user said no". The button then does nothing, silently, for ever —
 * which is exactly how New map and Reset all progress came to look broken.
 *
 * This is the same dialog in the app's own DOM, so it is always shown, always
 * styled like the rest of the app, and can be tested.
 * ========================================================================== */

export interface ConfirmOptions {
  /** Small capitalised label above the title, naming the area being acted on. */
  eyebrow: string;
  title: string;
  /** Extra lines under the title. Plain text; each becomes its own paragraph. */
  detail?: string[];
  /** The affirmative button's label. Say what will happen: "Delete row". */
  confirmLabel: string;
  cancelLabel?: string;
  /** Marks the affirmative button as destructive. */
  danger?: boolean;
}

let layer: HTMLElement | null = null;
let closeActive: ((confirmed: boolean) => void) | null = null;

function buildLayer(): HTMLElement {
  const element = document.createElement("div");
  element.className = "app-confirm-layer";
  element.hidden = true;
  element.innerHTML =
    '<section class="app-confirm-dialog" role="dialog" aria-modal="true" ' +
    'aria-labelledby="app-confirm-title" aria-describedby="app-confirm-detail">' +
    '<p class="app-confirm-eyebrow" data-confirm-eyebrow></p>' +
    '<h2 id="app-confirm-title" data-confirm-title></h2>' +
    '<div id="app-confirm-detail" data-confirm-detail></div>' +
    '<div class="app-confirm-actions">' +
    '<button type="button" class="app-confirm-button app-confirm-button--secondary" data-confirm-cancel></button>' +
    '<button type="button" class="app-confirm-button app-confirm-button--primary" data-confirm-accept></button>' +
    "</div></section>";
  // Mounted on <body>, never inside the map: #viz-container is overflow:hidden
  // and would clip it, which no z-index can undo.
  document.body.appendChild(element);
  return element;
}

/**
 * Ask the reader to confirm. Resolves true only on a deliberate yes — Escape,
 * the Cancel button and a click on the backdrop all resolve false, so the
 * cautious answer is the one that needs no decision.
 */
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  // A second request while one is open can only come from code, never from a
  // click: the overlay covers the page. Retire the first as cancelled so a
  // pending promise is never left unresolved.
  if (closeActive) closeActive(false);

  if (!layer || !layer.isConnected) layer = buildLayer();
  const dialogLayer = layer;

  const eyebrow = dialogLayer.querySelector<HTMLElement>("[data-confirm-eyebrow]")!;
  const title = dialogLayer.querySelector<HTMLElement>("[data-confirm-title]")!;
  const detail = dialogLayer.querySelector<HTMLElement>("[data-confirm-detail]")!;
  const cancelButton = dialogLayer.querySelector<HTMLButtonElement>("[data-confirm-cancel]")!;
  const acceptButton = dialogLayer.querySelector<HTMLButtonElement>("[data-confirm-accept]")!;

  eyebrow.textContent = options.eyebrow;
  title.textContent = options.title;
  detail.textContent = "";
  for (const line of options.detail || []) {
    const paragraph = document.createElement("p");
    paragraph.textContent = line;
    detail.appendChild(paragraph);
  }
  detail.hidden = !(options.detail || []).length;
  cancelButton.textContent = options.cancelLabel || "Cancel";
  acceptButton.textContent = options.confirmLabel;
  acceptButton.classList.toggle("is-danger", !!options.danger);

  const previouslyFocused = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;

  return new Promise<boolean>(resolve => {
    const finish = (confirmed: boolean): void => {
      if (closeActive !== finish) return;
      closeActive = null;
      dialogLayer.hidden = true;
      dialogLayer.removeEventListener("click", onLayerClick);
      document.removeEventListener("keydown", onKeyDown, true);
      cancelButton.removeEventListener("click", onCancel);
      acceptButton.removeEventListener("click", onAccept);
      // Focus goes back where it was, so a keyboard user is not dropped at the
      // top of the document after answering.
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
      resolve(confirmed);
    };

    const onCancel = (): void => finish(false);
    const onAccept = (): void => finish(true);
    const onLayerClick = (event: MouseEvent): void => {
      if (event.target === dialogLayer) finish(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
        return;
      }
      if (event.key !== "Tab") return;
      // Two focusable elements, so both directions are the same move: go to the
      // other one. Honouring shiftKey here would leave Shift+Tab stuck.
      event.preventDefault();
      (document.activeElement === cancelButton ? acceptButton : cancelButton).focus();
    };

    closeActive = finish;
    dialogLayer.hidden = false;
    dialogLayer.addEventListener("click", onLayerClick);
    document.addEventListener("keydown", onKeyDown, true);
    cancelButton.addEventListener("click", onCancel);
    acceptButton.addEventListener("click", onAccept);
    // Cancel takes focus, not the destructive button: a stray Enter or Space
    // arriving right after the click that opened this must not delete anything.
    cancelButton.focus();
  });
}

/** True while a confirmation is on screen. */
export function confirmIsOpen(): boolean {
  return !!closeActive;
}
