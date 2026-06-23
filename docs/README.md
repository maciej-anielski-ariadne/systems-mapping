# Internal docs

Engineering audits and design reviews — **background and history, not user
documentation.** If you just want to use or edit the app, start with the
top-level [`README.md`](../README.md) instead.

| Document | What it covers |
|----------|----------------|
| [`GLOSSARY.md`](GLOSSARY.md) | Plain-language definitions of the technical terms that appear in the code comments (Cobb-Douglas, bezier, BFS/DFS, event delegation, …). Written for non-programmers; the code's `(see docs/GLOSSARY.md)` notes point here. |
| [`CANVAS_EDITING_REVIEW.md`](CANVAS_EDITING_REVIEW.md) | An honest catalogue of the direct-on-the-map editing experience: what works today, the ranked gaps and rough edges, and implementation plans for the highest-impact fixes. |
| [`PERFORMANCE_REVIEW.md`](PERFORMANCE_REVIEW.md) | A codebase-wide rendering/interaction performance pass (hot paths, costs, fixes). The recommendations have since been implemented — kept as a record of what changed and why. |

These were written against specific points in time. Code references inside them
may name `.js` files (the pre-TypeScript layout); the equivalent source today is
the same number under `assets/js/*.ts`.
