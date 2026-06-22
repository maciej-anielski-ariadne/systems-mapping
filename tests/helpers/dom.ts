// =============================================================================
// DOM FIXTURE — load the real index.html body into jsdom
// -----------------------------------------------------------------------------
// Many code paths (loadDataFromCsv → render / renderSidebar / renderDetailPanel,
// the simulation panel, the search box) look up elements by id. Rather than
// hand-build a partial DOM, we inject the actual index.html <body> markup (minus
// the module <script>) so integration tests exercise the genuine element graph.
// =============================================================================
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const indexHtmlPath = resolve(here, "../../index.html");

let cachedBody: string | null = null;

function readBodyMarkup(): string {
  if (cachedBody !== null) return cachedBody;
  const html = readFileSync(indexHtmlPath, "utf-8");
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  let body = bodyMatch ? bodyMatch[1] : "";
  // Strip any <script> tags — we drive modules from the test, not the page.
  body = body.replace(/<script[\s\S]*?<\/script>/gi, "");
  cachedBody = body;
  return body;
}

/**
 * Reset document.body to the app's real markup. Call in beforeEach for any test
 * that renders into the DOM.
 */
export function mountAppDom(): void {
  document.body.innerHTML = readBodyMarkup();
}
