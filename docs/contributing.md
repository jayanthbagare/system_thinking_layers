# Contributing

## Branch model

Trunk-based development on `main`. Short-lived feature branches per task,
squash-merged via PR. Keep PRs reviewable in under 30 minutes.

`main` is branch-protected: green CI + one human review required. No direct
pushes.

## Definition of Done

A task is "Done" only when **all** are true:

1. Code implements the intended scope.
2. `npm run lint`, `npm run typecheck`, `npm test` all pass.
3. New unit/integration tests added and green.
4. Acceptance criteria (see `PLAN.md` for the active phase) demonstrably met.
5. Relevant docs updated.
6. No `TODO`/`FIXME` left in shipped scope without a linked issue.

## Commits

Short imperative subject, one logical change per commit. Example:

```
Add Graph data model with structural validation
```

## Where things live

| Concern | Location |
|---|---|
| Data model | `src/model/` |
| DSL parsing | `src/dsl/` |
| Cycle enumeration | `src/graph/` (Phase 2) |
| Layer 1 renderer | `src/layer1/` (Phase 2) |
| Pure logic + unit tests | `tests/unit/` |
| Cross-module flows | `tests/integration/` |
| Full user journeys | `tests/e2e/` (Phase 2+) |

## Architecture rules (do not violate)

- Exactly one source of truth: the `Graph` object.
- Layers 1–3 are views over `Graph`; they must not hold parallel state.
- The ABM companion is a separate pane, not a fourth overlay.
- Compute, don't annotate: loops, constraint scores, and T/I/OE deltas are
  derived from the graph, never hand-authored.
