import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hideTooltip, tooltip } from "../assets/js/12-tooltip";

describe("committed interaction tooltip dismissal", () => {
  let tooltippedButton: HTMLButtonElement;

  beforeEach(() => {
    hideTooltip();
    tooltippedButton = document.createElement("button");
    tooltippedButton.setAttribute("data-tooltip", "Committed action hint");
    tooltippedButton.addEventListener("click", (event) => event.stopPropagation());
    document.body.append(tooltippedButton);
  });

  afterEach(() => {
    tooltippedButton.remove();
    hideTooltip();
  });

  it("dismisses a hovered tooltip on click and restores it only after re-entry", () => {
    tooltippedButton.dispatchEvent(
      new MouseEvent("mouseover", { bubbles: true, clientX: 20, clientY: 20 }),
    );
    expect(tooltip.classList.contains("visible")).toBe(true);
    expect(tooltip.textContent).toContain("Committed action hint");

    tooltippedButton.click();
    expect(tooltip.classList.contains("visible")).toBe(false);

    tooltippedButton.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: 22, clientY: 20 }),
    );
    expect(tooltip.classList.contains("visible")).toBe(false);

    tooltippedButton.dispatchEvent(
      new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }),
    );
    tooltippedButton.dispatchEvent(
      new MouseEvent("mouseover", { bubbles: true, clientX: 24, clientY: 20 }),
    );
    expect(tooltip.classList.contains("visible")).toBe(true);
  });
});
