# Layers — Agent Guide

## Commands
- Install: `npm ci`
- Lint: `npm run lint`
- Typecheck: `npm run typecheck`
- All tests: `npm test`
- Unit tests only: `npm run test:unit`
- Integration tests only: `npm run test:integration`
- Build: `npm run build`
- Dev server: `npm run dev`

Run all of `lint`, `typecheck`, `test` before considering work complete.

## Architecture rules (do not violate)
- There is exactly **one** source of truth: the `Graph` object (see `src/model`).
- Layers 1, 2, and 3 are **views** over `Graph`. They add computed annotations; they must not hold parallel state.
- The ABM companion view is a separate pane, not a fourth overlay. It reads from a node and writes validation flags back onto `Graph`.
- Compute, don't annotate: loops, constraint scores, and T/I/OE deltas are derived from the graph, never hand-authored.

## Conventions
- TypeScript strict mode; `exactOptionalPropertyTypes` is on — do not pass `undefined` to optional fields; omit the key instead.
- No `any`. No `eval`/`new Function` on user input.
- YAML parsing uses the `js-yaml` library with the `core` schema (no `!!js/function`).
- Pure logic (graph, scoring, integration) lives in framework-agnostic modules with unit tests.
- Commits: short imperative subject, one logical change per commit.
