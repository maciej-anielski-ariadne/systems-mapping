import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { confirmAction, confirmIsOpen } from "../assets/js/04c-confirm";

const layer = (): HTMLElement => document.querySelector<HTMLElement>(".app-confirm-layer")!;
const cancelButton = (): HTMLButtonElement => layer().querySelector<HTMLButtonElement>("[data-confirm-cancel]")!;
const acceptButton = (): HTMLButtonElement => layer().querySelector<HTMLButtonElement>("[data-confirm-accept]")!;

const options = {
  eyebrow: "Delete row",
  title: 'Delete the row "Planning"?',
  detail: ["3 boxes and 5 links will be removed with it."],
  confirmLabel: "Delete row",
  danger: true,
};

describe("confirmAction", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.querySelector(".app-confirm-layer")?.remove();
  });

  afterEach(() => {
    if (confirmIsOpen()) cancelButton().click();
  });

  it("shows the dialog with the copy it was given", async () => {
    const answer = confirmAction(options);
    expect(confirmIsOpen()).toBe(true);
    expect(layer().hidden).toBe(false);
    expect(layer().querySelector("[data-confirm-eyebrow]")!.textContent).toBe("Delete row");
    expect(layer().querySelector("[data-confirm-title]")!.textContent).toBe('Delete the row "Planning"?');
    expect(layer().querySelector("[data-confirm-detail]")!.textContent)
      .toContain("3 boxes and 5 links");
    expect(acceptButton().textContent).toBe("Delete row");
    expect(cancelButton().textContent).toBe("Cancel");

    cancelButton().click();
    await expect(answer).resolves.toBe(false);
  });

  it("resolves true only when the affirmative button is used", async () => {
    const answer = confirmAction(options);
    acceptButton().click();
    await expect(answer).resolves.toBe(true);
    expect(layer().hidden).toBe(true);
    expect(confirmIsOpen()).toBe(false);
  });

  it("treats Escape, Cancel and the backdrop as no", async () => {
    for (const dismiss of [
      () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
      () => cancelButton().click(),
      () => layer().dispatchEvent(new MouseEvent("click", { bubbles: true })),
    ]) {
      const answer = confirmAction(options);
      dismiss();
      // The cautious answer is the one that needs no decision.
      await expect(answer).resolves.toBe(false);
      expect(layer().hidden).toBe(true);
    }
  });

  it("does not treat a click inside the dialog as a backdrop dismissal", async () => {
    const answer = confirmAction(options);
    layer().querySelector("[data-confirm-title]")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(confirmIsOpen()).toBe(true);
    acceptButton().click();
    await expect(answer).resolves.toBe(true);
  });

  it("focuses Cancel, not the destructive button", async () => {
    const answer = confirmAction(options);
    // A stray Enter or Space arriving right behind the click that opened this
    // must not be the thing that deletes somebody's row.
    expect(document.activeElement).toBe(cancelButton());
    cancelButton().click();
    await answer;
  });

  it("keeps Tab inside the dialog", async () => {
    const answer = confirmAction(options);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement).toBe(acceptButton());
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement).toBe(cancelButton());
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(acceptButton());
    cancelButton().click();
    await answer;
  });

  it("gives focus back to whatever opened it", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const answer = confirmAction(options);
    expect(document.activeElement).toBe(cancelButton());
    acceptButton().click();
    await answer;
    expect(document.activeElement).toBe(opener);
  });

  it("marks a destructive action and leaves an ordinary one unmarked", async () => {
    const dangerous = confirmAction(options);
    expect(acceptButton().classList.contains("is-danger")).toBe(true);
    cancelButton().click();
    await dangerous;

    const ordinary = confirmAction({ eyebrow: "Learn", title: "Carry on?", confirmLabel: "Carry on" });
    expect(acceptButton().classList.contains("is-danger")).toBe(false);
    expect(layer().querySelector<HTMLElement>("[data-confirm-detail]")!.hidden).toBe(true);
    cancelButton().click();
    await ordinary;
  });

  it("retires an earlier prompt as cancelled rather than leaving it unresolved", async () => {
    const first = confirmAction(options);
    const second = confirmAction({ ...options, title: "Second question?" });
    // The first promise must settle, or whatever awaited it waits for ever.
    await expect(first).resolves.toBe(false);
    expect(layer().querySelector("[data-confirm-title]")!.textContent).toBe("Second question?");
    acceptButton().click();
    await expect(second).resolves.toBe(true);
  });

  it("is a modal dialog for assistive technology", async () => {
    const answer = confirmAction(options);
    const dialog = layer().querySelector(".app-confirm-dialog")!;
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBe("app-confirm-title");
    expect(document.getElementById("app-confirm-title")).not.toBeNull();
    cancelButton().click();
    await answer;
  });

  it("sits above every other layer in the app", () => {
    // A confirmation asks a question the app is blocked on. Anything drawn over
    // it means the action silently never happens — which is exactly what the
    // Learn hub (z 520) did to this dialog when it sat at 280.
    const css = readdirSync("assets/css")
      .filter(name => name.endsWith(".css"))
      .map(name => readFileSync("assets/css/" + name, "utf8"))
      .join("\n");

    const confirmLadder = css.match(/--z-confirm:\s*(\d+)/);
    expect(confirmLadder, "--z-confirm is defined").not.toBeNull();
    const confirmValue = Number(confirmLadder![1]);

    // Every other rung of the ladder, and every literal z-index anyone wrote.
    const others = [
      ...Array.from(css.matchAll(/--z-(?!confirm)[a-z-]+:\s*(\d+)/g)),
      ...Array.from(css.matchAll(/z-index:\s*(\d+)\s*;/g)),
    ].map(match => Number(match[1])).filter(value => value !== confirmValue);

    expect(others.length).toBeGreaterThan(5);
    expect(Math.max(...others), "highest z-index that is not the confirm layer")
      .toBeLessThan(confirmValue);

    // And the layer must actually use the token rather than a number of its own.
    const misc = readFileSync("assets/css/10-misc.css", "utf8");
    const rule = misc.slice(misc.indexOf(".app-confirm-layer"));
    expect(rule.slice(0, rule.indexOf("}"))).toContain("z-index: var(--z-confirm)");
  });

  it("is the only kind of confirmation the app has", () => {
    // New map regressed to window.confirm() once already: the conversion was
    // collateral damage in an unrelated revert, and nothing was pinned down to
    // notice. A suppressed native confirm returns false, so the button then does
    // nothing — silently, for the rest of the session. This is the guard.
    const sources = readdirSync("assets/js")
      .filter(name => name.endsWith(".ts") && name !== "04c-confirm.ts")
      .map(name => ({ name, text: readFileSync("assets/js/" + name, "utf8") }));

    const offenders: string[] = [];
    for (const source of sources) {
      for (const line of source.text.split("\n")) {
        const code = line.replace(/\/\/.*$/, "").replace(/\*.*$/, "");
        if (/(^|[^.\w])confirm\s*\(/.test(code) && !/confirmAction\s*\(/.test(code)) {
          offenders.push(source.name + ": " + line.trim());
        }
      }
    }
    expect(offenders, "use confirmAction from 04c-confirm.ts instead").toEqual([]);
  });

  it("stops listening once answered, so a later Escape hits nothing", async () => {
    const answer = confirmAction(options);
    acceptButton().click();
    await answer;
    // No throw, no second resolution, and the layer stays shut.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(layer().hidden).toBe(true);
    expect(confirmIsOpen()).toBe(false);
  });
});
