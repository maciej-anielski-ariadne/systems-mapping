# `tests/` — automated tests

Run them with:

```bash
npm test            # one pass (Vitest, jsdom environment)
npm run test:watch  # re-run on change
```

**Layout:** most files are `<module>.test.ts` and test the matching module in
`assets/js/` (e.g. `layout.test.ts` covers `08-layout.ts`, `csv-parser.test.ts` covers
`05-csv-parser.ts`). A few are cross-cutting (`integration.test.ts`, `sim-render.test.ts`,
`virtualization.test.ts`). Plus:

- `fixtures/` — reusable sample graphs/data the tests load instead of hand-building input.
- `helpers/` — shared test utilities (e.g. DOM setup).
- `setup.ts` — global test setup (run once before the suite; wired in `vitest.config.ts`).
- `readme-file-map.test.ts` — a guard that fails if a file in `assets/js/` or `assets/css/`
  isn't listed in the top-level README, so the documentation can't silently drift.

CI runs this suite (plus type-check, lint, and build) on every push — see
`.github/workflows/ci.yml`.
