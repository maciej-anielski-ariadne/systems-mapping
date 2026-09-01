# `tests/` — automated tests

Run them with:

```bash
npm test            # one pass (Vitest, jsdom environment)
npm run test:shuffle # fixed seed used in CI to prove isolation
npm run test:browser # built-artifact Chromium acceptance + 300-box budget
npm run test:watch  # re-run on change
```

**Layout:** most files are `<module>.test.ts` and test the matching module in
`assets/js/` (e.g. `layout.test.ts` covers `08-layout.ts`, `csv-parser.test.ts` covers
`05-csv-parser.ts`). A few are cross-cutting (`integration.test.ts`, `sim-render.test.ts`,
`virtualization.test.ts`). Plus:

- `fixtures/` — reusable sample graphs/data the tests load instead of hand-building input.
- `helpers/` — shared test utilities (e.g. DOM setup).
- `setup.ts` — global test setup (run once before the suite; wired in `vitest.config.ts`).
- `source-inventory.test.ts` — narrowly checks that source filenames appear in the README.
- `documentation-contracts.test.ts` — checks machine-verifiable runtime, solver, schema and
  command claims rather than pretending a filename inventory proves behavioral truth.
- `browser/` — Playwright acceptance against the exact built single-file artifact.

CI runs the normal and shuffled suites, type-check, lint, build freshness and
the Chromium acceptance suite on every push — see
`.github/workflows/ci.yml`.
