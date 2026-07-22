# Development Plan — Layered Constraint Visualization

This plan operationalizes `prompt.md`. It covers project management, build phases, testing (functional, technical, security, performance), documentation, and deployment readiness.

The spec is explicit that this is a **client-side, no-backend** tool. The only persisted artifact is the `Graph` JSON object. All planning decisions below respect that constraint.

---

## 1. Project Management

### 1.1 Methodology
- **Phase-gated incremental delivery.** The spec (§8) already prescribes six build phases; each phase is independently useful and independently shippable. Treat each phase as a milestone with a demoable artifact.
- **One phase in flight at a time.** No phase starts until the prior phase's acceptance tests pass. This prevents the "everything half-done" failure mode the spec warns against.
- **Trunk-based development** on `main`, short-lived feature branches per task, squash-merged. The repo is small; PRs should stay reviewable in under 30 minutes.

### 1.2 Tooling
- **Issue tracker:** GitHub Issues with labels `phase-1..6`, `type:bug|feat|test|docs|chore`, `priority:P0..P2`.
- **Board:** GitHub Projects, columns `Backlog → In Progress → Review → Done`.
- **Milestones:** one per build phase, with a target date and a checklist of phase acceptance criteria (see §3).

### 1.3 Definition of Done (per phase)
A phase is "Done" only when **all** of the following are true:
1. Code implements the phase scope from `prompt.md`.
2. New code passes `npm run lint`, `npm run typecheck`, `npm run test`.
3. New unit + integration tests added and green.
4. Phase acceptance criteria (§3) demonstrably met via a recorded demo or manual test script.
5. README section for the phase's user-facing behavior updated.
6. No `TODO`/`FIXME` left in shipped scope without an linked issue.

### 1.4 Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Cycle enumeration explodes on user-authored graphs | Low (spec caps at ~50 nodes) but real if import is added | High — UX freeze | Hard-cap node count in the import path; run enumeration in a Web Worker; show progress. |
| ABM engine grows into a framework | Medium | Medium — scope creep | Strict v1: vanilla canvas, ≤3 rule primitives, no plugin system. Defer all "nice to have" ABM features to a post-6.0 backlog. |
| Layers drift out of sync (parallel state) | Medium | High — invalidates the whole design principle | Single `Graph` object is the *only* state; lint rule forbids layer-local state containers. Enforced via code review checklist. |
| D3 version churn / bundle bloat | Low | Low | Pin D3 to a single minor; tree-shake only the used modules (`d3-force`, `d3-scale`, etc.) rather than importing `d3` wholesale. |
| Sim engine numeric instability | Medium | Medium — wrong T/I/OE trajectories | RK4 default, Euler opt-in; per-run convergence check (energy/stock-mass conservation where applicable); expose integrator step in UI. |
| User-supplied ABM `update_fn` string executes arbitrary JS | High (by design) | High — XSS / RCE in browser | See §4.3. Sandboxed evaluation, no `eval`/`Function` on raw user input. |

### 1.5 Roles
Solo developer (Jayanth) for v1. Claude Code as the implementation agent per the spec's "Claude Code handoff" framing. All code review by a human before merge to `main`.

---

## 2. Repository & Project Layout

```
layers/
├── prompt.md                  # original spec (read-only source of truth)
├── PLAN.md                    # this file
├── README.md                  # user-facing: what it is, how to run
├── AGENTS.md                  # instructions for Claude Code agents
├── package.json
├── tsconfig.json
├── vite.config.ts
├── index.html
├── public/
│   └── examples/               # sample graph YAML files (beer-distribution, etc.)
├── src/
│   ├── model/                 # §1 data model: Node, Edge, Loop, Graph types
│   ├── dsl/                   # YAML/JSON parser → Graph
│   ├── graph/                 # cycle enumeration, polarity sign, cycle-time
│   ├── layer1/                # CLD renderer (D3)
│   ├── layer2/                # constraint scoring + heat overlay
│   ├── layer3/                # T/I/OE tagging + stock-flow integrator
│   ├── abm/                   # companion view: engine + topology + rules
│   ├── ui/                    # React shell, layer switcher, side panels
│   ├── state/                 # single store over Graph (Zustand or similar)
│   └── io/                    # session save/load, JSON import/export
├── tests/
│   ├── unit/                  # colocated or here; pure-logic tests
│   ├── integration/           # multi-module flows
│   ├── e2e/                   # Playwright, full user journeys
│   ├── fixtures/              # sample graphs (golden + adversarial)
│   └── performance/           # benchmarks (§5.3)
└── docs/
    ├── architecture.md
    ├── data-model.md
    ├── dsl-reference.md
    ├── contributing.md
    └── deployment.md
```

---

## 3. Build Phases (mirrors spec §8, with acceptance criteria)

Each phase below lists: scope, deliverables, and **acceptance criteria** used to mark the milestone Done.

### Phase 1 — Data model + DSL parser
**Scope:** TypeScript interfaces for `Node`, `Edge`, `Loop`, `Graph`; a YAML/JSON parser that produces a validated `Graph`; a single example fixture.
**Deliverables:** `src/model/*`, `src/dsl/*`, one fixture in `public/examples/`.
**Acceptance:**
- Loading a hand-authored YAML returns a `Graph` with all required fields populated.
- Invalid YAML (missing `polarity`, bad `delay.type`, duplicate `id`) fails with a structured error listing every violation, not just the first.
- Round-trip: `Graph → JSON → Graph` is lossless.

### Phase 2 — Layer 1 renderer
**Scope:** D3 force-directed + manual-pin layout; computed loops via DFS; R/B labels; delay edge marks; loop highlight on hover.
**Deliverables:** `src/graph/*`, `src/layer1/*`.
**Acceptance:**
- All elementary cycles in the fixture are detected and labeled R1..Rn / B1..Bn with correct sign.
- Selecting a loop highlights only its edges/nodes.
- Delay edges render with the specified double-hash + magnitude badge.
- Manual pin persists to the `Graph` (layout is part of the model, not view-only).
- Force layout converges in under 2s on the 50-node worst-case fixture (see §5.3).

### Phase 3 — Layer 2 overlay
**Scope:** Constraint score per node; heat coloring on Layer 1; top-3 ranked side panel with score breakdown; weights as sliders.
**Deliverables:** `src/layer2/*`, side-panel UI.
**Acceptance:**
- Score is a pure function of `(Graph, weights)` — same inputs → same output, no hidden state.
- Sliders update scores live (debounced ≤ 100ms) without re-running layout.
- Side panel shows the per-signal breakdown for the top 3, with the "why" inspectable.
- A known-constraint fixture (e.g., the bottleneck in a beer-distribution model) ranks #1 with default weights.

### Phase 4 — Layer 3 overlay + simulation
**Scope:** T/I/OE tagging; stock-flow Euler/RK4 integrator; sparklines for T/I/OE pre/post intervention on the identified constraint.
**Deliverables:** `src/layer3/*`, integrator, sparkline component.
**Acceptance:**
- Integrator conserves stock mass on a closed-system fixture to within 1e-6 over 1000 steps (RK4).
- Sparklines render for T, I, OE on a parameter shift at a user-selected node.
- Intervention is *simulated directional delta* only — no UI surface claiming financial precision (per spec §4).
- Integrator step size and method (Euler/RK4) are user-selectable.

### Phase 5 — Companion ABM view
**Scope:** Agent population authoring bound to a node; local-rule DSL; run; validation flag written back to Layer 1; perturbation re-run.
**Deliverables:** `src/abm/*`, ABM pane UI, validation annotation on Layer 1 nodes.
**Acceptance:**
- A population with a rule that *should* reproduce a known reinforcing loop does so; the bound node shows "validated."
- A deliberately mismatched rule produces a "flagged" annotation with the specific mismatch (polarity or delay).
- Perturbing a slider re-runs and updates the macro verdict (held / weakened / bifurcated).
- ABM runs in a Web Worker; the main thread stays responsive (<16ms frame) during a 10k-agent run.

### Phase 6 — Polish
**Scope:** Layer switcher, session save/load, weight sensitivity UI, example gallery, accessibility pass.
**Deliverables:** `src/io/*`, layer switcher, sensitivity matrix, gallery.
**Acceptance:**
- A session (graph + weights + ABM results) saves to JSON and reloads to identical state.
- Layer switcher enforces one active overlay at a time (per spec §6).
- Keyboard navigation reaches every interactive control; color is not the sole encoding for any state (heat + size + ranking all convey the score).
- Lighthouse a11y score ≥ 95 on the main view.

---

## 4. Testing Strategy

Testing is layered to match the architecture: pure logic is unit-tested exhaustively, integration tests cover cross-module flows, e2e tests cover real user journeys, and non-functional tests (security, performance) run in CI.

### 4.1 Functional Tests
Cover user-visible behavior, written from the spec's user stories.

| Area | Test | Type |
|---|---|---|
| Authoring | Load YAML → graph renders | e2e |
| Authoring | Invalid YAML → structured errors, no partial render | e2e |
| Layer 1 | Hover a loop → only its edges highlight | e2e |
| Layer 1 | R/B labels correct on a 3-loop fixture | unit (renderer output) |
| Layer 2 | Move a weight slider → top-3 reorder correctly | e2e |
| Layer 2 | Score breakdown panel matches computed values | integration |
| Layer 3 | Shift constraint → 3 sparklines update | e2e |
| Layer 3 | Closed-system run conserves mass | unit (integrator) |
| ABM | Validating rule → green flag on bound node | e2e |
| ABM | Mismatched rule → red flag with reason text | e2e |
| ABM | Perturbation slider → verdict updates | e2e |
| Session | Save → reload → identical state | integration |
| Session | Exported JSON re-imports losslessly | unit |

### 4.2 Technical Tests
Cover internal correctness independent of UI.

- **Cycle enumeration:** golden tests against known graphs (directed acyclic → no loops; two-node mutual → one loop; figure-8 → two loops sharing a node). Property test: `len(cycles) <= 2^|E|` and every reported cycle is verifiable by walking edges.
- **Loop sign:** property test — sign is the XOR of edge polarities around the cycle; flipping one edge polarity flips the sign.
- **Cycle time:** sum of edge delays; property test against random graphs that re-derives the value independently.
- **Constraint score:** pure-function golden tests; property test that score is invariant under node-id permutation (the score is structural, not name-dependent).
- **DSL parser:** fuzz with `fast-check` generating arbitrary YAML-ish strings; parser must either produce a valid `Graph` or a structured error — never throw an uncaught exception or silently accept malformed input.
- **Integrator:** convergence + stability tests (RK4 vs Euler on a stiff system), mass-conservation, and a regression test pinning the T/I/OE trajectory of the example fixture to a recorded golden trace (with a documented tolerance).
- **ABM engine:** determinism test — same seed → identical aggregate series; statistical test — mean and variance of aggregate over N runs within tolerance for a known rule.

### 4.3 Security Tests
There is no backend, but the app runs untrusted user input (YAML import, ABM rule strings). Threat model is client-side code execution and data exfiltration.

- **ABM rule evaluation:** the spec allows a "JS snippet or DSL" for `update_fn`. **Do not `eval`/`new Function` raw user strings.** v1 ships a fixed, enumerated rule vocabulary (reorder policy, capacity threshold, info-passing delay) selected via UI — no arbitrary code. If a DSL is added later, it runs inside a `Web Worker` created from a same-origin blob with a hardened CSP (no `unsafe-eval`), and is terminated per run. Test: any attempt to access `window`, `document`, `fetch`, or `import` from the rule throws and is reported.
- **YAML import:** parse with a library that does not support tags that instantiate arbitrary objects (e.g., `yaml` with `schema: 'core'`, not the default which includes `!!js/function`). Test: importing a YAML file containing `!!js/function` is rejected.
- **Content Security Policy:** ship a CSP via a `<meta>` tag (and server header in deployment) that disallows `unsafe-eval`, `unsafe-inline` scripts, and remote origins. CI test: a Playwright test asserts the CSP header/meta is present and that an injected `<script>` from a disallowed origin is blocked.
- **XSS in labels:** node/edge `label` strings render as text, never `innerHTML`. Test: a fixture with `<img src=x onerror=alert(1)>` as a label renders the string literally.
- **Session files:** imported JSON is validated against the `Graph` schema before any rendering. Test: malicious JSON with extra fields or wrong types is rejected; no prototype pollution (`__proto__`/`constructor` keys stripped by the validator).
- **Dependency supply chain:** `npm audit` + `license-checker` in CI; Dependabot enabled; `package-lock.json` committed. Block on any high/critical advisory.
- **No telemetry, no network:** the spec says client-side only. Test: a Playwright test with network interception asserts zero outbound requests during a full session (load → simulate → ABM → save).

### 4.4 Performance Tests
Target: a thinking tool must stay responsive at the spec's stated scale (≤50 nodes) and degrade gracefully above it.

- **Benchmarks** (run in CI on a fixed runner, recorded with a baseline; regression > 20% fails the build):
  - Cycle enumeration on a 50-node / 150-edge worst-case graph: < 50ms.
  - Constraint scoring on the same graph: < 10ms per weight-slider update.
  - Integrator: 1000-step RK4 run on a 20-stock graph: < 100ms.
  - ABM: 10k agents, 500 steps, well-mixed topology, in a Web Worker: < 5s, main-thread frame budget not exceeded.
- **Frame budget:** Playwright test asserts no frame exceeds 16ms during a drag/pan/zoom on the 50-node fixture (Chrome performance timeline via CDP).
- **Memory:** loading, simulating, then clearing a 50-node session returns heap usage to within 5% of the pre-load baseline (no retained closures / detached DOM). Detect detached DOM with the `HeapSnapshot` Leaked Nodes view in a scripted test.
- **Bundle size:** initial JS payload < 250KB gzipped (D3 submodules only, no full `d3`). CI reports bundle size; regression > 15% fails.

---

## 5. Continuous Integration

A single GitHub Actions workflow on every PR and on `main`:

1. `npm ci`
2. `npm run lint` (ESLint + Prettier check)
3. `npm run typecheck` (tsc --noEmit)
4. `npm run test:unit` (Vitest)
5. `npm run test:integration` (Vitest + jsdom)
6. `npm run test:e2e` (Playwright, Chromium)
7. `npm run test:security` (CSP assertion, XSS fixtures, audit gate)
8. `npm run test:perf` (benchmarks + frame-budget + bundle size)
9. `npm run build` (Vite production build)

A second workflow, nightly on `main`, re-runs everything plus `npm audit` and a full Lighthouse pass (a11y, best-practices). Failures open an issue automatically.

**Branch protection:** `main` requires green CI + one human review. No direct pushes.

---

## 6. Documentation

| Document | Audience | Owner | Ready by |
|---|---|---|---|
| `README.md` | Users + contributors | Phase 1, updated each phase | Phase 1 |
| `docs/architecture.md` | Contributors | Explains the single-`Graph` principle, layer-as-view, ABM separation | Phase 2 |
| `docs/data-model.md` | Contributors | Mirrors spec §1 with the actual TS types and invariants | Phase 1 |
| `docs/dsl-reference.md` | Users | Full YAML grammar with examples | Phase 1 |
| `docs/constraints.md` | Users | What the constraint score means, how to read the breakdown, sensitivity notes | Phase 3 |
| `docs/simulation.md` | Users | Integrator choice, step size, what the sparklines do and don't say | Phase 4 |
| `docs/abm.md` | Users | How to author a rule, run, read the verdict, perturb | Phase 5 |
| `docs/contributing.md` | Contributors | Branch model, DoD, test commands, where to add a phase | Phase 1 |
| `docs/deployment.md` | Operators | See §7 | Phase 6 |
| `AGENTS.md` | Claude Code | Lint/typecheck/test commands, conventions, the single-`Graph` rule | Phase 1 |
| In-app help | Users | Tooltips on every signal in the constraint breakdown; `?` overlay on the ABM pane | Each phase |

**API docs:** the `src/model` and `src/graph` modules ship TSDoc on every exported symbol; `typedoc` build runs in CI and is published to GitHub Pages on `main` green.

---

## 7. Deployment Readiness

The app is a static SPA. Deployment is therefore "build and host the static bundle," but several decisions matter.

### 7.1 Build
- `vite build` → `dist/` with content-hashed assets, `index.html`, and the example gallery inlined or copied.
- Source maps uploaded to the release artifact (not served publicly) for debugging.
- The production `index.html` includes the CSP `<meta>` and a `<noscript>` fallback.

### 7.2 Hosting
- **Primary:** GitHub Pages, served from `dist/` via a `deploy` action on tagged releases. Free, no backend, matches the no-network design.
- **Alternative:** Cloudflare Pages or Netlify if a preview deploy per PR is wanted (useful for stakeholder review of each phase). Same static bundle.
- **No server, no functions, no database.** If a future feature needs persistence, it is added as optional `localStorage` / OPFS, not a backend. The deployment doc records this as a hard constraint and flags any PR that introduces a runtime dependency.

### 7.3 Release process
1. Update `CHANGELOG.md` (Keep a Changelog format).
2. Tag `vX.Y.Z` (semver; phases map to minors: v0.1 = Phase 1, …, v1.0 = Phase 6 complete).
3. CI builds, attaches the `dist/` zip and source maps to the GitHub Release.
4. Deploy action publishes to GitHub Pages.
5. Release notes link to the phase's recorded demo.

### 7.4 Pre-deployment checklist (gated by CI, but verified manually before tagging)
- [ ] All phase acceptance criteria met and recorded.
- [ ] `npm audit`: zero high/critical.
- [ ] Lighthouse: perf ≥ 90, a11y ≥ 95, best-practices = 100, SEO ≥ 90 (on the example gallery, which is the most representative page).
- [ ] CSP verified present in deployed headers AND in `index.html` meta (belt and braces).
- [ ] Bundle size within budget (§4.4).
- [ ] One full e2e + security + perf run on the *built* artifact (not just dev mode) passes.
- [ ] `CHANGELOG.md` updated; release notes drafted.
- [ ] Example gallery loads every fixture without console errors.
- [ ] Offline test: load the deployed site, disable network, verify the full session (author → simulate → ABM → save) still works — proving the no-backend claim.

### 7.5 Rollback
GitHub Pages is pinned to a release tag. Rollback = repoint the Pages source to the previous tag. Documented in `docs/deployment.md` with the exact steps.

---

## 8. Sequencing Summary

| Week | Phase | Milestone |
|---|---|---|
| 1 | Phase 1 | `Graph` loads from YAML; CI green; v0.1 internal |
| 2 | Phase 2 | Live CLD renderer with computed loops; v0.2 |
| 3 | Phase 3 | Constraint overlay + sensitivity; v0.3 |
| 4 | Phase 4 | T/I/OE sim + sparklines; v0.4 |
| 5 | Phase 5 | ABM companion + validation; v0.5 |
| 6 | Phase 6 | Polish, a11y, docs, deploy; v1.0 |

Each phase ends with a tagged release and a deployable artifact, so the project is never in a state where "nothing works yet" — consistent with the spec's phase-by-phase guidance.
