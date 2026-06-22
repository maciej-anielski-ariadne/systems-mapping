// =============================================================================
// VITEST SETUP — jsdom shims + DOM mount (runs before every test file's imports)
// -----------------------------------------------------------------------------
// Two jobs:
//   1. Fill jsdom's gaps: a deterministic <canvas> 2D context (the layout/label
//      code measures text widths through it) and no-op scroll helpers.
//   2. Mount the real index.html <body> BEFORE any app module is imported. Some
//      modules (e.g. 17-events) capture elements via getElementById at module
//      top level, so the DOM has to exist the moment they evaluate.
// =============================================================================
import { beforeEach, vi } from "vitest";
import { mountAppDom } from "./helpers/dom";

// ── Canvas 2D context (jsdom returns null) ──────────────────────────────────
function makeContextStub(): Partial<CanvasRenderingContext2D> {
  return {
    font: "",
    measureText(text: string): TextMetrics {
      // ~7px per character — a deterministic proxy for 12px Arial. Tests assert
      // on line counts derived from this, so it must stay stable.
      return { width: String(text).length * 7 } as TextMetrics;
    },
    fillRect: () => {},
    clearRect: () => {},
    drawImage: () => {},
    fillText: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    fill: () => {},
    save: () => {},
    restore: () => {},
    translate: () => {},
    scale: () => {},
  } as Partial<CanvasRenderingContext2D>;
}

HTMLCanvasElement.prototype.getContext = vi.fn(() =>
  makeContextStub(),
) as unknown as HTMLCanvasElement["getContext"];

// ── Scrolling (jsdom doesn't implement these) ───────────────────────────────
Element.prototype.scrollIntoView = function () {};
Element.prototype.scrollTo = function () {} as Element["scrollTo"];
window.scrollTo = function () {} as typeof window.scrollTo;

// ── localStorage ────────────────────────────────────────────────────────────
// The global `localStorage` in this runtime (Node 25 ships an experimental Web
// Storage global) isn't a usable Storage, so install a clean in-memory one. The
// app only ever calls setItem/getItem/removeItem, all wrapped in try/catch.
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(String(key), String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
}
const memoryStorage = new MemoryStorage();
Object.defineProperty(globalThis, "localStorage", {
  value: memoryStorage,
  configurable: true,
  writable: true,
});
if (typeof window !== "undefined") {
  Object.defineProperty(window, "localStorage", {
    value: memoryStorage,
    configurable: true,
    writable: true,
  });
}

// ── Mount the app DOM ONCE, before any module imports ───────────────────────
// Modules like 11-rendering capture `const svg = getElementById("viz-svg")` at
// import time, so the #viz-svg they draw into must be the live one for the whole
// file. Re-mounting per test would detach those captured references. Renders
// overwrite their containers' innerHTML each call, so this stays clean enough;
// localStorage is what we reset between tests.
mountAppDom();

// ── Per-test isolation ──────────────────────────────────────────────────────
beforeEach(() => {
  memoryStorage.clear();
});
