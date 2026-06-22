#!/usr/bin/env python3
"""
Build a single-file distribution of the Systems Map app.

Reads index.html and inlines every external resource it references:
  • <link rel="stylesheet" href="assets/css/…">  → <style>…</style>
  • the local web fonts (fonts.css)              → @font-face with the .woff2
                                                    files embedded as base64
                                                    data: URIs
  • <script src="assets/js/…">                    → <script>…</script>

The sample / template CSVs are NOT fetched at runtime — the app reads its
starting data from the SAMPLE_CSV constant baked into assets/js/01-sample-data.js
— so they don't need to be inlined. The result is a fully self-contained,
offline-capable .html file you can email, drop on a USB stick, or open with a
double-click.

Usage:
    python3 build-dist.py            # writes dist/systems-map.html

Re-run this whenever you change anything under assets/.
"""

import base64
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent
INDEX = ROOT / "index.html"
OUT_DIR = ROOT / "dist"
OUT_FILE = OUT_DIR / "systems-map.html"

# Matches a stylesheet/script tag and captures its href/src path.
LINK_RE = re.compile(r'<link\s+rel="stylesheet"\s+href="([^"]+)"\s*>')
SCRIPT_RE = re.compile(r'<script\s+src="([^"]+)"\s*>\s*</script>')
# url(./files/xyz.woff2) inside fonts.css
FONT_URL_RE = re.compile(r'url\(\.?/?(files/[^)]+\.woff2)\)')


def read(path: pathlib.Path) -> str:
    return path.read_text(encoding="utf-8")


def inline_fonts_css(css: str, fonts_dir: pathlib.Path) -> str:
    """Replace url(./files/x.woff2) with base64 data: URIs."""
    def repl(match: "re.Match[str]") -> str:
        rel = match.group(1)  # e.g. files/abc.woff2
        data = (fonts_dir / rel).read_bytes()
        b64 = base64.b64encode(data).decode("ascii")
        return f"url(data:font/woff2;base64,{b64})"

    return FONT_URL_RE.sub(repl, css)


def inline_css(href: str) -> str:
    """Return a <style> block for a referenced stylesheet."""
    path = (ROOT / href).resolve()
    css = read(path)
    if path.name == "fonts.css":
        css = inline_fonts_css(css, path.parent)
    return f"<style>\n/* === {href} === */\n{css}\n</style>"


def inline_script(src: str) -> str:
    """Return an inline <script> block for a referenced script."""
    js = read((ROOT / src).resolve())
    # Guard against an accidental </script> inside the source closing the block.
    js = js.replace("</script>", "<\\/script>")
    return f"<script>\n/* === {src} === */\n{js}\n</script>"


def build() -> str:
    html = read(INDEX)
    html = LINK_RE.sub(lambda m: inline_css(m.group(1)), html)
    html = SCRIPT_RE.sub(lambda m: inline_script(m.group(1)), html)
    return html


def main() -> None:
    OUT_DIR.mkdir(exist_ok=True)
    result = build()

    # Sanity check: no remaining references to the assets/ folder in live tags.
    leftover = re.findall(r'(?:href|src)="(assets/[^"]+)"', result)
    if leftover:
        raise SystemExit(f"Un-inlined references remain: {leftover}")

    OUT_FILE.write_text(result, encoding="utf-8")
    size_kb = OUT_FILE.stat().st_size / 1024
    print(f"Wrote {OUT_FILE.relative_to(ROOT)}  ({size_kb:,.0f} KB)")


if __name__ == "__main__":
    main()
