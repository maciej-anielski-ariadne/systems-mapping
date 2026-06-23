# `assets/css/` — the app's styles

Plain CSS, no preprocessor. Files are numbered (`01-`, `02-`, …) and loaded in that
order by `index.html`, each focused on one area of the UI (its header comment says which).

**Most common edit:** colours, fonts, and design tokens all live in
[`01-variables.css`](01-variables.css). Change them there and reload — the rest of the
files reference those variables.

There is **no `12-*.css`** — the number is retired, not a missing file. The sequence
jumps `11-builder.css` → `13-search.css` on purpose.

For the full one-line index of every stylesheet, see the top-level
[README](../../README.md#files) (**Files** section).
