# Isolate the orchestrator escalation state store from test/CI writes

GitHub Issue: [#664](https://github.com/chetwerikoff/orchestrator-pack/issues/664)

## Prerequisite

- **REUSED merged lineage (wire to; do not rebuild):**
  - `docs/issues_drafts/219-orchestrator-escalation-contract.md` (GitHub #641) — durable
    escalation publication contract: `Publish-OrchestratorEscalation`,
    `Get-OrchestratorEscalationStatePath`, ack lifecycle (`status`/`operatorStatus` →
    `acked`), operator inbox + health spool, message catalog. **This draft adds a
    test/live isolation boundary to that existing state-path resolution — it does not
    add a new store, schema, or delivery path.**
  - `docs/issues_drafts/227-side-process-registry-launch-argv-contract.md` (GitHub #659,
    merged 2026-07-07) — fixed the `escalation-router` child argv binding so the router
    actually completes ticks. **Merging #659 made the latent leak visible:** the
    now-live `orchestrator-escalation-router.ps1` redelivers every unacked
    `route=llm-orchestrator` record, including leaked test records. #659 noted the
    test-vs-live contention but did **not** prescribe an isolation mechanism — that gap
    is this draft.
- **Open queue (no conflict — different axis):**
  - `docs/issues_drafts/229-pack-wide-launch-argv-contract-inventory.md` (GitHub #661) —
    launch-surface argv inventory; concerns child *launch contracts*, not escalation
    *state storage*. Independent.
- **Incident grounding (2026-07-07):** the live orchestrator pane was spammed with
  repeated `escalation-review-start-claim` (E14) deliveries. Root cause: test-fixture
  records in the shared live store `/tmp/orchestrator-escalation-state.json`. After
  #659/PR #662 merged and the supervisor restarted, the router redelivered them
  (attempts 10–13). A `escalation-claim-store-integrity` record carries a
  `/tmp/opk-vitest-ao-base-*` vitest temp path in its correlation key while sitting
  in the shared store — proof that vitest wrote into the live store.

**Prior-art verdict (draft-author recon 2026-07-07):** **Extends existing.** No shipped,
merged, or open draft covers isolating the escalation state store from test/emit-site
writes. #641 built the store and shared-default fallback; #659 fixed the router that
now faithfully redelivers whatever is in that store. This draft closes the gap both
left open.

**Decomposition check:** One PR — shared test-harness isolation + fail-closed resolver
fence + regression guard. Not splittable into independently-shippable slices.

**Pre-draft design gate (T3 — tier gate overrode advisory-prior T2 on red-flag markers
`durable-state-evidence` + `external-api-transport`; #574 monotonic):**

| Option | Cost / risk | Sufficiency | Verdict |
|--------|-------------|-------------|---------|
| **(a) Isolate escalation paths at global test/CI bootstrap** (vitest global setup + CI env, plus the shared pwsh helper) | Low — one bootstrap covers bypass paths | Isolates all emit-site tests including those that skip the pwsh helper | **Land (primary)** |
| **(b) Fail-closed fence in `Get-OrchestratorEscalationStatePath`** keyed to a pack-owned explicit marker: under the marker, reject the shared production default from **any** path source | Low — marker only set by harness; production never sets it | Class-closer regardless of per-test discipline | **Land (backstop)** |
| **(c) Thread explicit `-StatePath` through `Invoke-OrchestratorEscalationEmit`** | Medium — touches emit sites; still no default fence | Improves testability but does not fence the default | **Reject as primary** — optional if it simplifies (a) |
| **(d) Extend #641/#659 without isolation** | Zero build | Insufficient — leak recurs on every emit-site test run | **Reject** |

Recommended: **(a) + (b) together** on the #641 resolver — harness isolation is the
mechanism, the fence is the discipline-independent class-closer.

## Goal

No test or CI run may write escalation records into a store that a live supervisor reads.
Every escalation emit reached under a test/CI context MUST resolve an **isolated**
escalation state path (and isolated operator-inbox / health-spool), and the shared
default store path MUST be **fail-closed** against writes originating from a test/CI
context. Production escalation delivery is unchanged: with no pack-owned test marker
set, path resolution and the shared-default fallback behave exactly as today.

```behavior-kind
action-producing
```

```complexity-tier
tier: T3
advisory-prior: T2
```

## Binding surface

### Invariants (non-negotiable)

- **Test emits resolve an isolated store.** Any escalation published while a pack-owned
  test/CI marker is active resolves an escalation state path **outside** the shared
  production default (`[TempPath]/orchestrator-escalation-state.json`). The same
  isolation covers operator-inbox and health-spool directories.
- **Fail-closed on all three shared-default surfaces under test/CI — any path source.**
  When the pack-owned marker is present and resolution would yield a shared production
  default path for **escalation state**, **operator inbox**, or **health spool**,
  resolution **errors** (fail-closed) — regardless of whether that path came from resolver
  fallback, env var, or an explicit parameter. Setting env vars or parameters to the
  shared defaults under the marker must still fail closed for each surface.
- **Pack-owned explicit marker — not ambient CI detection.** The marker is a
  **pack-owned, explicit** env var set only by the test harness (`scripts/**`
  global bootstrap and lane wrappers). It is **not** inferred from ambient signals
  (`CI`, `NODE_ENV=test`, etc.). Real operational scripts run inside
  CI/deploy/automation must never trip the fence.
- **Marker at global test/CI bootstrap (script-owned surfaces).** The marker and isolated
  escalation / operator-inbox / health-spool paths are established at a **global test
  bootstrap under `scripts/**`** (e.g. vitest `globalSetup` referenced from
  `vitest.config.ts`) and inherited by every `npm test` / CI lane via the existing
  `scripts/run-vitest-*-lane.ps1` wrappers (which set harness env before invoking
  vitest). Paths that bypass `scripts/_test-pwsh-helpers.ts` must still inherit the
  marker and isolated paths from that bootstrap.
- **Production path unchanged — proven without mutating shared defaults.** With no
  marker set, escalation state, operator-inbox, and health-spool resolvers return the
  same shared-default values as today, asserted by **resolving each path only** (no
  publish). The production publish path is proven by a publish given an **explicit
  isolated `StatePath`**. No test ever publishes to shared defaults.
- **Class-level fix, not the one reproduced site.** Isolation at the shared resolver +
  global bootstrap covers **all** emit sites below; new emit-site tests inherit without
  per-site edits.
- **No escalation semantics change.** Ack lifecycle, redelivery, wake-storm cap, catalog,
  routes, and the router loop are untouched.
- **No AO core / vendor edits.** No changes under `vendor/**` or `packages/core/**`.

### Emit-site class (all resolve the store via the shared #641 resolver — fixture the resolver, not each site)

| Emit class id | Site (grounding) | Route |
|---------------|------------------|-------|
| `escalation-review-start-claim` | `scripts/lib/Review-StartClaim.ps1` | llm-orchestrator (reproduced spam) |
| `escalation-envelope-ledger` | `scripts/lib/Review-StartEnvelopeLedger.ps1` | operator |
| `escalation-claim-store-integrity` | `scripts/lib/Worker-NudgeClaim.ps1` | operator (vitest-path leak) |
| `escalation-submit-adoption` | `scripts/worker-message-submit-reconcile.ps1` | llm-orchestrator |
| `escalation-ci-green-claim-audit` | `scripts/ci-green-wake-reconcile.ps1` | (per catalog) |
| `escalation-review-run-recovery` | `scripts/review-run-recovery.ps1` | (per catalog) |
| `escalation-review-trigger-degraded-ci` | `scripts/review-trigger-reconcile.ps1` | (per catalog) |
| `escalation-ci-failure-notify` | `scripts/ci-failure-notification-reconcile.ps1` | (per catalog) |
| `escalation-dead-worker-recovery` | `scripts/invoke-worker-recovery.ps1`, `scripts/dead-worker-reconcile.ps1` | (per catalog) |
| `escalation-handoff-envelope` | `scripts/orchestrator-wake-listener.ps1` | (per catalog) |
| `escalation-gated-nudge` | `scripts/invoke-gated-worker-nudge.ps1` | (per catalog) |
| `escalation-worker-recovery` | `scripts/lib/Worker-Recovery.ps1` | (per catalog) |

All route through `Invoke-OrchestratorEscalationEmit` → `Publish-OrchestratorEscalation` →
`Get-OrchestratorEscalationStatePath`.

```contract-evidence
binding-id: orchestrator-pack:escalation-state:test-isolated-path
binding-type: cli-behavior
binding: an escalation published under an active pack-owned test marker resolves an escalation state path outside the shared production default; the shared default file is not created or mutated by the test run
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)
expected: test-isolated-path

binding-id: orchestrator-pack:escalation-state:fail-closed-shared-default
binding-type: cli-behavior
binding: with the pack-owned test marker set, resolving or publishing to any shared production default surface (escalation state, operator inbox, health spool) errors (fail-closed) regardless of path source — fallback, env var, or explicit parameter
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)
expected: fail-closed-shared-default

binding-id: orchestrator-pack:escalation-state:global-bootstrap-inherited
binding-type: cli-behavior
binding: a child pwsh process spawned without scripts/_test-pwsh-helpers.ts still inherits the pack-owned marker and isolated escalation paths from the global test bootstrap
producer: orchestrator-pack
evidence: NEW(produced-by AC#5)
expected: global-bootstrap-inherited

binding-id: orchestrator-pack:escalation-state:production-path-unchanged
binding-type: cli-behavior
binding: with no pack-owned test marker set, resolving escalation state, operator inbox, and health spool paths (resolution only, no publish) returns the same shared-default values as before this change, and a publish given an explicit isolated StatePath succeeds; no test publishes to shared defaults
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)
expected: production-path-unchanged

binding-id: orchestrator-pack:escalation-state:suite-no-shared-writes
binding-type: cli-behavior
binding: the regression guard snapshots any preexisting shared production default store, preserves it, and after the emit-site suite fails only on mutation or a new test-originated record (not on mere preexistence)
producer: orchestrator-pack
evidence: NEW(produced-by AC#4)
expected: suite-no-shared-writes
```

## Files in scope

- `scripts/**` global test bootstrap (e.g. vitest `globalSetup` module) — establish the
  pack-owned marker and isolated escalation / operator-inbox / health-spool paths
  `(new/update)`
- `vitest.config.ts` — at most a one-line `globalSetup` reference to the bootstrap
  module under `scripts/**` `(update)`
- `scripts/run-vitest-*-lane.ps1` — ensure CI/local lane wrappers export harness env
  before invoking vitest `(update)`
- `scripts/_test-pwsh-helpers.ts` — extend the isolated env block to inherit bootstrap
  env `(update)`
- `scripts/lib/Orchestrator-Escalation.ps1` — fail-closed fence in state-path resolution
  keyed to the pack-owned marker `(update)`
- `scripts/**` — regression guard that the shared production default store is unwritten
  after the emit-site test suite; new fixture(s) `(new/update)`
- `scripts/lib/Invoke-OrchestratorEscalationEmit.ps1` — only if threading `StatePath`
  simplifies isolation (optional per option (c)) `(optional update)`

The planner picks the marker env-var name, isolated-path layout, and fence error shape.
Named seam files are grounding, not prescribed internals.

## Files out of scope

- `vendor/**`, `packages/core/**`, `agent-orchestrator.yaml`
- Escalation semantics: ack lifecycle, routes, wake-storm cap, catalog,
  `orchestrator-escalation-router.ps1` redelivery loop
- Purging currently-leaked live `/tmp` records — operator runtime step, already done
  manually 2026-07-07

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
```

```allowed-roots
scripts/**
vitest.config.ts
```

## Acceptance criteria

1. **Test emits resolve an isolated store.** With the pack-owned test marker active (as
   set by global test/CI bootstrap), publishing any escalation writes to an **isolated**
   escalation state path; the shared production default file is not created or mutated.
   Operator-inbox and health-spool writes are likewise isolated. Red-then-green: fails
   while bootstrap leaves escalation paths unset and emits fall through to the shared
   default.

```positive-outcome
asserts: an escalation published under the test harness writes to an isolated state path and leaves the shared production default store untouched
input: realistic
```

```producer-emission
producer: orchestrator-pack
datum: escalation-state
expected: test-isolated-path
proof-command: a test that publishes an escalation through the shared pwsh helper and asserts the isolated path was written and the shared production default path was not
red-then-green: must fail when bootstrap does not isolate the escalation state path
```

2. **Fail-closed on all shared-default surfaces from any path source.** With the
   pack-owned marker set, resolving or publishing to any shared production default
   surface errors — for escalation state, operator inbox, and health spool — whether
   the path came from resolver fallback, env var pointing at the shared default, or an
   explicit parameter equal to the shared default. No write to shared production paths
   occurs.

```positive-outcome
asserts: with the marker set, all three surfaces and all three path sources fail closed without mutating shared production stores
input: realistic
```

```producer-emission
producer: orchestrator-pack
datum: escalation-state
expected: fail-closed-shared-default
proof-command: tests covering fallback, env-var, and explicit-parameter sources for escalation state, operator inbox, and health spool that each assert fail-closed behavior without touching shared defaults
red-then-green: must fail while any surface or source silently returns or writes a shared default under the marker
```

3. **Production path unchanged — non-mutating proof.** With no pack-owned test marker set,
   the escalation state, operator-inbox, and health-spool resolvers **return** the same
   shared-default values as before the change, each asserted by **resolving the path only,
   without publishing**. A publish given an **explicit isolated `StatePath`** succeeds
   unchanged. The fence is unreachable without the marker.

```positive-outcome
asserts: with no marker set, all three resolvers return pre-change shared-default values (resolution only, no write) and a publish to an explicit isolated StatePath succeeds
input: realistic
```

```producer-emission
producer: orchestrator-pack
datum: escalation-state
expected: production-path-unchanged
proof-command: a test that (a) asserts all three resolver outputs equal shared defaults with no marker and no publish, and (b) publishes to an explicit isolated StatePath and asserts success — never publishing to shared defaults
red-then-green: must fail if the fence changes production resolution for any surface when the marker is absent
```

4. **Suite-wide regression guard (class, snapshot-preserving).** The guard **snapshots**
   any preexisting shared production default store and preserves it. After running the
   escalation-adjacent emit-site test suite, it fails closed **only** if the store was
   mutated or a **new test-originated record** appears; a preexisting, unchanged store
   passes. The guard never deletes or rewrites live operator state.

```positive-outcome
asserts: after the emit-site suite, the snapshot-preserving guard shows the shared default store unmutated and free of new test-originated records
input: sample-backed
```

```producer-emission
producer: orchestrator-pack
datum: escalation-state
expected: suite-no-shared-writes
proof-command: a guard that snapshots any preexisting shared default store, runs the emit-site tests, and asserts no mutation and no new test-originated record (preexisting unchanged store passes)
red-then-green: must fail if any emit-site test mutates the shared default store or adds a test-originated record
```

5. **Global bootstrap inherited by bypass paths.** A child `pwsh` process spawned
   directly (not via `scripts/_test-pwsh-helpers.ts`) under an active vitest run still
   sees the pack-owned marker and isolated escalation paths. The same holds when tests
   are invoked through `scripts/run-vitest-*-lane.ps1` (CI and local lane entrypoints).

```positive-outcome
asserts: bypass-path child processes inherit marker and isolated paths from global bootstrap without requiring the pwsh helper
input: realistic
```

```producer-emission
producer: orchestrator-pack
datum: escalation-state
expected: global-bootstrap-inherited
proof-command: a test that spawns pwsh without the helper and asserts marker plus isolated paths are present; lane-wrapper coverage asserted for run-vitest entrypoints
red-then-green: must fail when only _test-pwsh-helpers.ts sets the marker
```

## Upgrade-safety check

- Pack scripts + tests only; no AO core / vendor edits; no `agent-orchestrator.yaml`
  change; no new repo secrets.
- The pack-owned test marker is harness/CI-only; it is never set in a production
  supervisor/orchestrator runtime, and is not inferred from ambient `CI` or `NODE_ENV`.
- No escalation schema, catalog, route, or ack-contract change.

## Verification

1. `pwsh -NoProfile -File ./scripts/verify.ps1` and `pwsh -NoProfile -File ./scripts/check-reusable.ps1` green.
2. `npm test` — new isolation/fence tests (AC#1–#5) green; existing escalation-adjacent
   tests remain green.
3. `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/231-escalation-state-store-test-isolation.md`
4. `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/231-escalation-state-store-test-isolation.md`
5. `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command parked-root -DraftPath docs/issues_drafts/231-escalation-state-store-test-isolation.md`
6. Manual: run the full suite, then assert `[TempPath]/orchestrator-escalation-state.json`
   was not created/mutated by the run (AC#4).

### Grounding captures (draft-author, 2026-07-07)

```
# Shared-default fallback (scripts/lib/Orchestrator-Escalation.ps1:19-24):
function Get-OrchestratorEscalationStatePath {
    param([string]$StatePath = '')
    if ($StatePath) { return $StatePath }
    if ($env:AO_ORCHESTRATOR_ESCALATION_STATE) { return $env:AO_ORCHESTRATOR_ESCALATION_STATE }
    return Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-escalation-state.json'
}

# Emit helper has NO StatePath param (scripts/lib/Invoke-OrchestratorEscalationEmit.ps1:19-42).

# Test helper isolates AO_BASE_DIR only (scripts/_test-pwsh-helpers.ts:26-37):
#   mkdtempSync('opk-vitest-ao-base-') → AO_BASE_DIR; no escalation env.

# Router redelivers unacked llm records (scripts/orchestrator-escalation-router.ps1:25-34).

# Correct pattern in one test (scripts/side-process-launch-contract.test.ts ~107, ~165):
#   $env:AO_ORCHESTRATOR_ESCALATION_STATE = <isolated path>
```
