# Spawn-gate tests must be structurally unable to reach the live AO daemon

GitHub Issue: [#512](https://github.com/chetwerikoff/orchestrator-pack/issues/512)

## Prerequisite

- `docs/issues_drafts/104-orchestrator-spawn-git-process-boundary-deny.md` (GitHub #324, **closed**) —
  ships the process-boundary deny for autonomous orchestrator spawn/git; `opk-probe` interposer
  matrix lives in `autonomous-orchestrator-interposer.test.ts`.
- `docs/issues_drafts/103-llm-turn-review-start-claimed-gate.md` (GitHub #318, **closed**) —
  review-start guard; on Cursor-runtime workers the process-boundary deny stack is **opt-in and
  inert** unless orchestrator surface bootstrap + `scripts/` PATH prepend are installed (by design —
  fix the tests, not the gate).
- `docs/issues_drafts/158-test-fixture-autonomous-real-binaries-live-leak.md` (GitHub #494,
  **closed**, PR #497) — isolated `withAoSpawnProbeStub` off `repoRoot/.ao/`; **orthogonal axis**
  (config-file collision). This draft covers **armed spawn reaching the live daemon** when isolation
  or stub receipt fails.
- `docs/issues_drafts/161-stub-pack-docs-manifest-dependency-closure.md` (GitHub #508, **open**) —
  stub-pack `docs/*.mjs` import-closure drift guard; **do not merge or restate**. Same consumer file
  `autonomous-spawn-worktree-gate.test.ts` is a **#508 consumer only** (module loading) — it has **no
  live-armed spawn sites** in the verified inventory; keep drafts on their own aspect.
- `docs/issues_drafts/159-autonomous-real-binaries-broken-pointer-policy.md` (GitHub #509, **open**) —
  broken `ao` pointer fallback policy; neighbor only.
- Prior-art recon (2026-06-28): no open issue on the **spawn-gate test → live `cli.spawn_invoked`**
  class (`opk-probe-test-fixture-leaks-live-spawn`). Live operator evidence: `ao events list` showed
  `cli.spawn_invoked` for `opk-probe` / `opk-1` during worker vitest runs with no backing GitHub
  issue — sessions respawned after kill (~25s).

**Verification facts (2026-06-28, live tree):**

| File | Armed spawn / subprocess sites (fixture ids) | Classification |
|------|---------------------------------------------|----------------|
| `autonomous-spawn-policy.test.ts` | L71/89/154/162 `evaluate*` only — no exec | **pure logic — safe** |
| | L316/L351 `pwsh -File isolatedGuard spawn opk-1` in `withAoSpawnProbeStub` | **isolated-stub** (expects probe receipt) |
| | L368 `pack.aoShimPath spawn opk-probe` in `withAoSpawnProbeStub` | **isolated-stub** |
| `autonomous-spawn-worktree-gate.test.ts` | L273 `buildSpawnWorktreeGrantRecord` argv only | **pure logic — safe** |
| | L315 `isolatedGuard spawn opk-470` in `withAoSpawnProbeStub` | **isolated-stub** |
| `autonomous-orchestrator-boundary.test.ts` | L131–138 `evaluate*` / `isSpawnAoArgv` only | **pure logic — safe** |
| | L630/L687/L726 `spawn opk-1` via `pack.bashEnv` / script file in `withAoSpawnProbeStub` | **live-armed-risk** (bare `ao` token — depends on bootstrap PATH prepend) |
| | L873 `isolatedGuard spawn opk-1` in `withAoSpawnProbeStub` | **isolated-stub** (probe asserted) |
| | L891 `pack.aoShimPath spawn --claim-pr` in `withAoSpawnProbeStub` | **isolated-stub** |
| | L910 `pwsh -File guardPath spawn opk-1` — **repo-root** `scripts/ao-autonomous-guard.ps1`, not `pack.scriptsDir` | **repo-root-armed-risk** (mitigated today by `AO_REAL_BINARY=aoStub` + `AO_AUTONOMOUS_ORCHESTRATOR_SURFACE=''`, but pack-root/config split remains a hazard) |
| `autonomous-orchestrator-interposer.test.ts` | L195 `spawnIsolatedOrchestratorBash` + `ao spawn opk-probe` | **live-armed** (surface-off allow — see Binding surface) |
| | L214 `spawnLiveArmedBash` `ao spawn opk-probe` | **live-armed** |
| | L249 copied `scripts/ao spawn opk-probe` (expects exit 93) | **fail-closed deny — safe** |
| | L462/L568/L597/L655/L660 `spawnLiveArmedBash` / `spawnEvalHidden` `ao spawn opk-probe` | **live-armed** |
| | L689 `spawnEvalHidden` worker surface + explicit `AO_REAL_BINARY=aoStub` | **isolated-stub** (probe asserted) |

**Active migration surface (verified):** 7 live-armed sites in `autonomous-orchestrator-interposer.test.ts`
+ 4 live-armed-risk / repo-root-armed-risk sites in `autonomous-orchestrator-boundary.test.ts`.
`autonomous-spawn-policy.test.ts` and `autonomous-spawn-worktree-gate.test.ts` have **zero**
live-armed sites (isolated-stub / pure JS only).

**PATH / `AO_*` trace (live-armed helpers):** `spawnLiveArmedBash` / `spawnEvalHidden` delegate to
`spawnIsolatedOrchestratorBash`, which strips turn-visible env (`AO_REAL_BINARY`, prior `BASH_ENV`),
sets `BASH_ENV=pack.bootstrapPath`, `AO_TMUX_NAME=opk-orchestrator`, and inherits host `PATH`.
Isolated `.ao/autonomous-real-binaries.json` under `pack.packRoot` points at the temp stub. **When
bootstrap/interposer fails to prepend `pack.scriptsDir` or surface bootstrap does not run, `ao`
resolves via host `PATH` → live daemon** — matching observed `cli.spawn_invoked`. Orchestrator-surface
live-armed cases assert `status !== 93` but **do not assert stub/probe receipt**, so a silent live
spawn passes the test.

**Pack-layer sentinel enforceability:** spawn session materialization validation in `vendor/**` /
`packages/core/**` is **out of pack scope**. The pack **does** own `scripts/ao`, `scripts/ao-autonomous-guard.ps1`,
and spawn-policy / boundary libs — a refusal layer is available here (defense-in-depth, not the sole
fix). **Namespace constraint:** `opk-1` / `opk-470` are indistinguishable from legitimate real
session ids (`opk-47`, `opk-54`, …) — pack-layer refuse **must not** block those patterns or real
operator spawns will break. Safe refuse targets: explicitly synthetic ids only (`opk-probe`,
`opk-ci-probe`, or a reserved `__test-spawn-*` namespace — see options).

## Goal

No spawn-gate test can reach the **live** AO daemon: an armed `ao spawn <fixture-id>` must never
create a real session — regardless of whether the runtime deny gate happens to be installed on the
host running vitest. Isolation failure must **fail closed** (test error, not silent live side effect).
The **structural** fix is primary (option A); optional live-daemon observation is secondary where a
daemon is actually reachable (operator / worker host), not assumed in CI.

```behavior-kind
action-producing
```

## Binding surface

**Critical mechanics**

- Fail-closed safety property: the class is “test armed spawn → live daemon,” not one file/line.
- `#494` fixed config collision; **live-armed** interposer helpers and repo-root guard usage remain.
- Process-boundary deny is **off on Cursor workers by design** — tests must not assume the gate
  catches a fall-through spawn.
- `Resolve-RealAoExecutable` ignores `AO_REAL_BINARY` when autonomous surface is active — stub
  routing must come from **pack-local config + pack-local shim path**, not turn-visible env overrides.
- `Get-PackRootFromBoundaryLib` follows **guard/shim script location** — invoking `repoRoot/scripts/*`
  while stub config lives only under temp `pack.packRoot` is a structural hazard.

**Surface-off allow cases (L195 — planner must resolve):** these tests intentionally set
`AO_AUTONOMOUS_ORCHESTRATOR_SURFACE=''` and assert `probeFile` **absent** + `status !== 93` — spawn
is allowed and **must not** be intercepted by the orchestrator deny stack. After the fix, neither
“stub-receipt” nor “deny 93” is the correct post-fix outcome. The draft **requires** an explicit
third outcome for this equivalence class, e.g.:
- spawn targets a **reserved synthetic id** the host refuses to materialize (harmless no-op / structured
  refuse before session creation), **or**
- surface-off `ao` is routed to a **harmless non-live stub** that deliberately does **not** write the
  probe file (probe absence remains the positive signal).

Without one of these, AC2 is **unimplementable** for L195-class cases.

**Failure-class enumeration (must close the class, not today's paths)**

| # | Reach-live path | Draft must close |
|---|-----------------|------------------|
| 1 | Deny gate / interposer absent on host (Cursor worker) | Never rely on gate catching fall-through |
| 2 | Host `PATH` wins over pack shim (not prepended, overridden, or bootstrap/`BASH_ENV` did not run) | Hermetic PATH + fail-closed preflight |
| 3 | Guard/shim invoked from `repoRoot/scripts` while config is temp-pack-only | Eliminate repo-root armed invocations |
| 4 | Copied `scripts/ao` without matching `.ao` config | Fail closed at fixture setup |
| 5 | Orchestrator-surface spawn tests assert only `status !== 93` | Require non-live outcome per surface class (stub-receipt, deny-93, or surface-off rule above) |
| 6 | New test copies armed pattern without isolation | Shared helper; optional live-daemon tripwire |
| 7 | `resolve_real_ao` / `Resolve-RealAoExecutable` PATH walk reaches live `ao` | Structural isolation (A); optional synthetic-id refuse |
| 8 | Vitest worker inherits operator live `.ao` on repo-root code paths | Repo-root armed paths forbidden |
| 9 | Fixture ids `opk-1` / `opk-470` collide with real `opk-N` session namespace | Migrate tests to reserved synthetic namespace and/or refuse only explicit synthetics |

**Options judged (cheapest sufficient wins)**

| Option | Cost | Risk | Sufficiency |
|--------|------|------|-------------|
| **A. Hermetic isolation + outcome assertion per surface class** | Medium — refactor live-armed helpers and boundary bash/script cases to a shared fail-closed fixture API | Low when each surface class has a defined non-live outcome | **Primary — closes class 1–5, 8** |
| **B. Pack-layer refuse for explicit synthetic ids only** | Low–medium | **Unsafe** for `opk-1`/`opk-470` (namespace collision with real sessions); safe only for `opk-probe`, `opk-ci-probe`, `__test-spawn-*` | **Defense-in-depth with A** — not a substitute |
| **B′. Migrate fixture targets to `__test-spawn-*` (or similar)** | Low — test-only id rename | Must update grant/basename tests that embed numeric ids | Cheap leak self-limit: synthetic sessions obvious on the board; makes B safe |
| **C. Fail-closed skip when deny gate not installed** | Low | **Fail-open** if gate probe is wrong | **Rejected** — may not replace A |
| **D. Live-daemon tripwire (operator/worker host)** | Low locally | **No-op in CI** (daemon usually absent); misses leak where daemon absent | **Secondary belt** — observation only where live `ao` is reachable; not the carrying fix |

**Outcome bound (planner picks mechanism):** implement **A** as the carrying fix. **B′** encouraged
when renaming fixture ids is zero-cost alongside A. **B** only for ids proven non-colliding with real
`opk-N`. **D** optional on hosts with a live daemon (local vitest / worker run) — **not** required
CI machinery. **Do not** disable tests, **do not** make the runtime deny gate mandatory on Cursor,
**do not** touch #508 manifest mechanism.

**#508 boundary (explicit):** this draft scopes **live-armed spawn isolation only**. #508 scopes
`docs/*.mjs` copy-manifest closure.

```contract-evidence
none
```

## Files in scope

**Primary migration (live-armed sites only):**

- `scripts/autonomous-orchestrator-interposer.test.ts`
- `scripts/autonomous-orchestrator-boundary.test.ts`
- `scripts/_test-interposer-pack-fixture.ts`
- `scripts/_test-autonomous-ao-stub-fixture.ts` — shared fail-closed helper (planner picks shape)
- `scripts/**` — only as needed for the helper and optional live-daemon tripwire

**Verify-no-regression (no live-armed sites — adapt shared helper only if trivial):**

- `scripts/autonomous-spawn-policy.test.ts`
- `scripts/autonomous-spawn-worktree-gate.test.ts`

**Optional (only if D is implemented):**

- `.github/workflows/**` — not required; tripwire targets operator/worker hosts with live daemon

## Files out of scope

- `vendor/**`, `packages/core/**`
- `prompts/**`, `agent-orchestrator.yaml.example` (gate remains opt-in on Cursor)
- #508 manifest / import-closure implementation
- #509 broken-pointer policy
- Disabling or deleting spawn-gate tests

## Denylist

```denylist
vendor/**
packages/core/**
docs/**
plugins/**
prompts/**
```

```allowed-roots
scripts/**
.github/workflows/**
```

## Acceptance criteria

1. **Invariant (all four suites — cheap):** no subprocess armed `ao spawn` with fixture ids reaches
   the live daemon. Suites with only isolated-stub / pure-JS sites must stay green without migration
   churn beyond shared-helper adoption when trivial.
2. **Migration (two suites only):** every **live-armed** / **live-armed-risk** /
   **repo-root-armed-risk** site in Prerequisite is migrated to the shared fail-closed helper with a
   **surface-appropriate non-live outcome:**
   - orchestrator-surface allow → stub-receipt **or** defined surface-off rule (probe absent + non-live spawn);
   - deny cases → explicit `93` unchanged;
   - worker-surface allow → stub-receipt unchanged.
   **L195-class surface-off allow** must document which third outcome applies before merge.
3. **Repo-root hazard removed:** no armed spawn test invokes `repoRoot/scripts/ao-autonomous-guard.ps1`
   or `repoRoot/scripts/ao` while stub config exists only under a temp `packRoot`.
4. **Fail closed:** if isolation preflight fails (pack scripts not on `PATH`, missing pack-local
   `.ao/autonomous-real-binaries.json`, or allowed spawn missing its surface-class outcome), the test
   **errors** — never falls through to host `ao`.
5. **Deny semantics preserved:** orchestrator-surface **deny** cases (`send`, mutating `git`, interposer
   unavailable) still expect refusal; worker-surface allow cases still expect stub receipt. Default spawn
   policy allow paths stay allow — only the **execution target** becomes non-live.
6. **Namespace-safe defense-in-depth:** any pack-layer fixture-id refuse **excludes** `opk-1` /
   `opk-470` and other collision-prone `opk-N` patterns unless fixture ids are migrated (B′).
7. **Optional live tripwire (D):** when implemented, runs on hosts where a live daemon is reachable
   (operator / worker vitest), not as a CI-only gate; documents no-op expectation when daemon absent.

```positive-outcome
asserts: offline — vitest over the four spawn-gate suites green; every live-armed site in the two migration suites records its surface-class non-live outcome or fails closed; policy and worktree-gate suites unchanged except trivial shared-helper wiring; deliberate isolation break fails preflight not live spawn
input: realistic
verification-mode: offline
```

```positive-outcome
asserts: live-daemon optional — when vitest runs on a host with live ao, no new cli.spawn_invoked rows for synthetic fixture ids after the spawn-gate slice; skipped cleanly when daemon absent
input: realistic
verification-mode: live-integration
```

### Scenario matrix (non-duplicate only)

| Scenario | Expected |
|----------|----------|
| L195 surface-off allow (`AO_AUTONOMOUS_ORCHESTRATOR_SURFACE=''`, probe absent) | Third outcome defined in AC2 — not stub-receipt, not deny-93, not live session |
| Fixture id namespace collision (`opk-1` vs real `opk-47`) | B refuse does not block real ids; B′ or explicit-synthetic refuse only |

## Upgrade-safety check

- Test-infra / pack-script hardening only; no AO core or vendor edits.
- Runtime deny gate remains opt-in on Cursor — tests become self-contained.
- Orthogonal to #508 docs-manifest closure.
- Pack-layer refuse must not break legitimate `opk-N` operator spawns.

## Verification

**Offline (carrying — required):**

1. Targeted vitest over all four suites — green.
2. Negative: deliberate isolation break (planner-owned fixture) fails test preflight, not live spawn.
3. `pwsh -NoProfile -File ./scripts/verify.ps1` green (or cite unrelated blockers).

**Live-daemon (optional — D only):**

4. On operator/worker host with live `ao`: run spawn-gate vitest slice, then `ao events list -p
   orchestrator-pack` — no new `cli.spawn_invoked` for synthetic fixture ids.
5. Document skip when daemon absent (CI default).

## Architect review log

| Pass | Notes |
|------|-------|
| 2026-06-28 agent-brief | Authored from `_agent-brief-spawn-gate-test-live-leak.md` after independent verification; corrected coworker “never leaks” verdict against live `cli.spawn_invoked` evidence |
| 2026-06-28 Codex #1 | `review-architect-artifact.ps1 -Kind issue-draft` — **NO_FINDINGS** |
| 2026-06-28 architect tighten | Narrow migration to interposer+boundary; surface-off allow third outcome; namespace collision for B; demote D; split offline/live positive-outcome; dedupe scenario matrix |
| 2026-06-28 Codex #2 | Post-tighten `review-architect-artifact.ps1 -Kind issue-draft` — **NO_FINDINGS** |
