// =============================================================================
// NEW MAP — the button, and the dialog it must go through
// -----------------------------------------------------------------------------
// This is here because New map regressed to window.confirm() once already: the
// conversion was collateral damage in an unrelated revert, and nothing was
// pinned down to notice. A suppressed native confirm returns false, and
// `if (!confirm(msg)) return;` reads that as "the user said no" — so in an
// embedded or preview browser, or once somebody has ticked "prevent this page
// from creating additional dialogs", the button did nothing at all, silently,
// for the rest of the session.
//
// Its own file rather than a block in confirm.test.ts: that suite empties
// <body> between tests to isolate the dialog, and these need the app's real
// header button, wired by 17-events when the module was evaluated.
// =============================================================================
import { beforeEach, describe, expect, it } from "vitest";
import { confirmIsOpen } from "../assets/js/04c-confirm";
import { NODES } from "../assets/js/03-state";
import { loadDataFromCsv } from "../assets/js/06-data-loader";
import "../assets/js/17-events";

const CONFIRM_CSV = `# SECTION: streams
id,label,short,color
main,Main,MAIN,#888

# SECTION: stages
id,label
one,One
two,Two

# SECTION: categories
id,label,color,text_color
kind,Kind,#444,#fff

# SECTION: nodes
id,label,description,stream,stage,category,baseline,unit,controllable,direction,slider_max,combine,formula,min,max
a,Alpha,,main,one,kind,100,units,true,,2,,,,
b,Beta,,main,two,kind,100,units,,,,,,,

# SECTION: edges
from,to,effect,elasticity,description
a,b,increases,,
`;

const trigger = (): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>(".create-map-trigger")!;
const layer = (): HTMLElement =>
  document.querySelector<HTMLElement>(".app-confirm-layer")!;
const answer = async (which: "accept" | "cancel"): Promise<void> => {
  layer().querySelector<HTMLButtonElement>("[data-confirm-" + which + "]")!.click();
  await new Promise(resolve => setTimeout(resolve, 0));
};

describe("New map", () => {
  beforeEach(() => {
    expect(loadDataFromCsv(CONFIRM_CSV)).toBe(true);
    expect(NODES.map(node => node.id)).toEqual(["a", "b"]);
  });

  it("asks through the app's own dialog, not the browser's", async () => {
    trigger().click();
    await Promise.resolve();
    expect(confirmIsOpen(), "New map must use confirmAction").toBe(true);
    expect(layer().querySelector("[data-confirm-title]")!.textContent)
      .toBe("Clear this map and start again?");
    // Says what is about to be lost, counted, rather than "the current map".
    expect(layer().querySelector("[data-confirm-detail]")!.textContent)
      .toContain("2 boxes and 1 link");
    expect(layer().querySelector("[data-confirm-accept]")!.textContent).toBe("Clear the map");
    await answer("cancel");
  });

  it("keeps the map when the answer is no", async () => {
    trigger().click();
    await Promise.resolve();
    await answer("cancel");
    expect(NODES.map(node => node.id)).toEqual(["a", "b"]);
  });

  it("clears the map when the answer is yes", async () => {
    trigger().click();
    await Promise.resolve();
    await answer("accept");
    // The starter grid carries no boxes — you click a cell to add the first.
    expect(NODES.map(node => node.id)).not.toEqual(["a", "b"]);
  });
});
