import { afterEach, describe, expect, it } from "vitest";
import type { GraphNode } from "../assets/js/types";
import {
  LEARN_REFERENCE_CARDS,
  closeLearnReference,
  learnReferenceIsOpen,
  openLearnReference,
  referenceCardForNode,
} from "../assets/js/26a-learn-reference";

function referenceLayer(): HTMLElement | null {
  return document.getElementById("learn-reference-layer");
}

function indexButtons(): HTMLButtonElement[] {
  return Array.from(referenceLayer()!.querySelectorAll<HTMLButtonElement>("[data-learn-reference-card]"));
}

function currentCardId(): string | null {
  return referenceLayer()!.querySelector("[data-learn-reference-current]")
    ?.getAttribute("data-learn-reference-current") || null;
}

function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return { id: "box", label: "Box", stream: "s", stage: "t", ...overrides } as GraphNode;
}

afterEach(() => {
  closeLearnReference();
});

describe("calculation reference content", () => {
  it("carries all eighteen entries with every field filled in", () => {
    expect(LEARN_REFERENCE_CARDS).toHaveLength(18);
    for (const card of LEARN_REFERENCE_CARDS) {
      expect(card.id.length).toBeGreaterThan(0);
      expect(card.title.length).toBeGreaterThan(0);
      expect(card.useWhen.length).toBeGreaterThan(0);
      expect(card.whatItDoes.length).toBeGreaterThan(0);
      expect(card.whyThisChoice.length).toBeGreaterThan(0);
      expect(card.howToApplyIt.length).toBeGreaterThan(0);
      expect(card.howToEvaluateIt.length).toBeGreaterThan(0);
    }
  });

  it("keeps every id unique and kebab-case", () => {
    const identifiers = LEARN_REFERENCE_CARDS.map(card => card.id);
    expect(new Set(identifiers).size).toBe(identifiers.length);
    for (const identifier of identifiers) expect(identifier).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("groups the entries the way the shelf's four headings do", () => {
    const countByGroup = (group: string): number =>
      LEARN_REFERENCE_CARDS.filter(card => card.group === group).length;
    expect(countByGroup("combine")).toBe(6);
    expect(countByGroup("constraint")).toBe(5);
    expect(countByGroup("feedback")).toBe(5);
    expect(countByGroup("syntax")).toBe(2);
  });

  // The shelf is the only place this material lives, so the reference detail a
  // writer needs at the keyboard has to be in it — not linked out to.
  it("stands alone: no entry sends the reader to an external guide", () => {
    for (const card of LEARN_REFERENCE_CARDS) {
      expect(card).not.toHaveProperty("guideAnchor");
    }
    openLearnReference();
    expect(referenceLayer()!.querySelector("a[href]")).toBeNull();
    expect(referenceLayer()!.textContent).not.toContain("Full guide");
  });

  it("covers the formula syntax itself, not only the choice of rule", () => {
    const syntax = LEARN_REFERENCE_CARDS.find(card => card.id === "what-you-can-write-in-a-formula")!;
    expect(syntax.howToApplyIt).toContain("clamp()");
    expect(syntax.howToApplyIt).toContain("delay()");
    expect(syntax.howToEvaluateIt).toContain("Dividing by zero");

    const fallbacks = LEARN_REFERENCE_CARDS.find(card => card.id === "when-a-formula-cannot-run")!;
    expect(fallbacks.whatItDoes).toContain("reads as 0");
  });
});

describe("calculation reference shelf", () => {
  it("renders a modal layer with all sixteen titles on open", () => {
    expect(learnReferenceIsOpen()).toBe(false);
    expect(openLearnReference()).toBe(true);

    const layer = referenceLayer()!;
    expect(layer.hidden).toBe(false);
    expect(learnReferenceIsOpen()).toBe(true);

    const dialog = layer.querySelector(".learn-reference")!;
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(dialog);

    expect(indexButtons()).toHaveLength(18);
    expect(layer.textContent).toContain("Choosing a combine rule");
    expect(layer.textContent).toContain("Caps, shares and limits");
    expect(layer.textContent).toContain("Delays and feedback");
    expect(layer.textContent).toContain("Syntax you can use");
    expect(layer.querySelector("[data-learn-reference-action='close']")).toBeTruthy();
  });

  it("opens directly at a named entry and shows its new lead sentence", () => {
    expect(openLearnReference("cap-demand-with-capacity")).toBe(true);

    expect(currentCardId()).toBe("cap-demand-with-capacity");
    const reading = referenceLayer()!.querySelector(".learn-reference-reading")!;
    expect(reading.textContent).toContain("Cap demand with available capacity");
    expect(reading.textContent).toContain("Use this when a box cannot rise past a ceiling");
    expect(reading.textContent).toContain("What it does");

    const current = indexButtons().filter(button => button.classList.contains("is-current"));
    expect(current).toHaveLength(1);
    expect(current[0].getAttribute("data-learn-reference-card")).toBe("cap-demand-with-capacity");
  });

  it("shows the extra paragraph only on entries that carry one", () => {
    openLearnReference("weakest-link-versus-min");
    const reading = (): string => referenceLayer()!.querySelector(".learn-reference-reading")!.textContent!;
    expect(reading()).toContain("Also worth knowing");
    expect(reading()).toContain("Lowest allowed");

    openLearnReference("start-with-the-question");
    expect(reading()).not.toContain("Also worth knowing");
  });

  it("swaps the reading pane when another title is chosen", () => {
    openLearnReference("start-with-the-question");
    indexButtons().find(button =>
      button.getAttribute("data-learn-reference-card") === "stress-test-the-loop",
    )!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(currentCardId()).toBe("stress-test-the-loop");
    expect(referenceLayer()!.querySelector(".learn-reference-reading")!.textContent)
      .toContain("Stress-test the loop before trusting it");
  });

  it("hides the shelf and restores focus on close", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();

    openLearnReference();
    expect(document.activeElement).not.toBe(opener);

    closeLearnReference();
    expect(learnReferenceIsOpen()).toBe(false);
    expect(referenceLayer()!.hidden).toBe(true);
    expect(referenceLayer()!.innerHTML).toBe("");
    expect(document.activeElement).toBe(opener);
  });

  it("closes on the close button and on Escape", () => {
    openLearnReference();
    referenceLayer()!.querySelector<HTMLButtonElement>("[data-learn-reference-action='close']")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(learnReferenceIsOpen()).toBe(false);

    openLearnReference();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(learnReferenceIsOpen()).toBe(false);
  });

  it("opens from any surface that marks a trigger up", () => {
    const trigger = document.createElement("button");
    trigger.setAttribute("data-learn-reference", "bounds-as-guardrails");
    document.body.appendChild(trigger);

    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(learnReferenceIsOpen()).toBe(true);
    expect(currentCardId()).toBe("bounds-as-guardrails");
    trigger.remove();
  });
});

describe("referenceCardForNode", () => {
  it("prefers the formula entry whenever the box has a formula", () => {
    const node = makeNode({ formula: "min(a, b)", combine: "min" });
    expect(referenceCardForNode(node).id).toBe("formula-when-units-define-arithmetic");
  });

  it("names the weakest-link entry for a min box", () => {
    expect(referenceCardForNode(makeNode({ combine: "min" })).id).toBe("weakest-link-prerequisites");
  });

  it("names the additive entry for an additive box", () => {
    expect(referenceCardForNode(makeNode({ combine: "additive" })).id)
      .toBe("additive-overlapping-contributions");
  });

  it("falls back to the standard entry for a plain box", () => {
    expect(referenceCardForNode(makeNode()).id).toBe("standard-independent-effects");
    expect(referenceCardForNode(makeNode({ combine: "multiplicative" })).id)
      .toBe("standard-independent-effects");
  });
});
