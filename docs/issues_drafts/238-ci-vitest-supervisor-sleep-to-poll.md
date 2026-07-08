# [T3] Replace fixed-duration sleeps in supervisor/wake heavy-lane tests with condition polling

GitHub Issue: #693

## Prerequisite

- `docs/issues_drafts/155-ci-pipeline-split-parallel-test-stage.md` (GitHub #487) — ships the
  PR-required Vitest lane split, fail-closed shard aggregate, and the worker-RPC flake
  regression guard that heavy-lane runs must keep green.
- `docs/ci-pipeline-split.md` (GitHub #556) — replaces round-robin sharding with
  **light/heavy** lanes; the supervisor/wake cluster lives on the heavy lane and its
  wall-clock floor is recorded in `scripts/vitest-runtime-history.json` (~120–200s/file for
  the affected tests).
- `scripts/supervisor-recovery.test-helpers.ts` — already exports bounded log polling via
  `waitForSupervisorLogMatch` (short interval, max timeout, throws on expiry); this is the
  pattern to generalize rather than per-test ad-hoc sleeps.
- `scripts/supervisor-degraded-backoff.test.ts` — reference implementation mixing
  `waitForSupervisorLogMatch` / `waitForMarker` with deliberate fixed windows; not a
  blocking prerequisite but shows the correct positive-wait shape.
- Prior-art reconnaissance (2026-07-08): no queued draft/issue targets conversion of fixed
  `setTimeout` budgets in `orchestrator-wake-supervisor.test.ts` or
  `supervisor-fault-boundary.test.ts`. Sibling CI speedup briefs (#1 harvest, #2 file split)
  are orthogonal; this draft stands alone.
- Task-decomposition verdict: **single PR** — one behavioral class (wait semantics in the
  heavy supervisor/wake Vitest cluster), one rollback surface, one flake-guard coupling.

```complexity-tier
tier: T3
advisory-prior: T3
```

## Goal

Cut the heavy-lane Vitest makespan floor by replacing fixed-duration `setTimeout` waits in
the supervisor/wake integration tests with **bounded condition polling** that returns as soon
as the awaited observable is true — without weakening any assertion and without
reintroducing Vitest worker `onTaskUpdate` RPC flake accepted by #487/#556.

```behavior-kind
action-producing
```

## Design analysis

### Critical mechanics

The affected tests spawn real supervisor/wake subprocesses and currently burn full fixed
budgets every run even when the awaited log line, marker file, process exit, or stdout
fragment appears early. `waitForSupervisorLogMatch` already polls `readSupervisorLog` on a
short interval up to a caller-chosen max; several sites instead use naked
`await new Promise(r => setTimeout(r, N))` before asserting. Converting a **positive** wait
(wait *for* an event) to polling preserves the timeout ceiling (max wait ≥ prior fixed
budget) while shrinking typical runtime. Converting a **negative** or **quiescence** wait
(prove something did **not** happen for N ms, or hold a stability window) to "poll until
condition" would pass instantly and destroy the test — those sites must remain bounded fixed
waits. Poll-loop **interval** sleeps inside an existing `while` are not the problem; the
fixed **budget** sleeps before assertions are.

### Industry grounding

Integration suites commonly use "wait for condition with timeout" helpers (poll the same
observable the assertion uses) instead of unconditional delays. The anti-pattern is
replacing quiescence windows with early-exit polls. Heavy CI lanes often cap parallelism to
avoid worker-RPC starvation; speedups must not trade that guard for in-runner contention.

### Architecture sketch

```text
supervisor/wake Vitest it()
  |
  +--> spawn supervisor + children (unchanged)
  |
  +--> positive wait site
  |       -> shared bounded poller (log / marker / pid alive / stdout / exit)
  |       -> return early on match; throw at max >= old fixed budget
  |
  +--> negative / quiescence site
  |       -> keep fixed window (or explicit windowed sampler), never early-exit poll
  |
  +--> assertions (unchanged meaning)
  |
  +--> teardown (prefer poll-for-exit where currently blind sleep)
```

### Options considered

1. **Leave sleeps; optimize CI sharding only.** Cheapest diff but leaves ~120–200s/file
   floor untouched — insufficient for this brief's goal.
2. **Per-test ad-hoc poll loops.** Low ceremony but duplicates interval/timeout semantics and
   invites inconsistent flake handling — rejected; extend the existing helper family instead.
3. **Convert every `setTimeout` including quiescence windows.** Would shrink wall time but
   silently weaken negative assertions — rejected.
4. **Shared bounded poller for positive waits; inventory-guarded negative preservation**
   (chosen). Reuses `waitForSupervisorLogMatch` / `waitForMarker` patterns, keeps bounded
   timeouts, and machine-checks that negative classes stay fixed.

### Full-class enumeration (wait site × verdict)

| Wait class | Observable | Example in cluster | Verdict |
|------------|------------|-------------------|---------|
| Log-appears (positive) | Supervisor log regex | Fault-boundary already uses `waitForSupervisorLogMatch`; wake file still has blind waits before log/stdout checks | **Convert** to bounded poll (max ≥ old budget) |
| Marker/state-file (positive) | `waitForMarker` / state dir files | Marker waits mostly correct; some assert-after-sleep without polling marker | **Convert** remaining assert-first sleeps |
| Process alive/dead (positive) | `isAlive(pid)` / pid file absent | Post-`Stop` sleeps then `expect(isAlive).toBe(false)` | **Convert** to poll-for-exit |
| Stdout/subprocess output (positive) | Accumulated child stdout | Blind 1500ms before `expect(stdout).toContain(...)` | **Convert** to poll stdout |
| In-loop poll interval | Same as parent wait | 250–500ms inside `while` polling markers/PIDs | **Keep** as interval (not a budget sleep) |
| Quiescence / negative | "No restart", "still dead", "no extra recovery", **still-alive / no shared-fate** over N ms | 2000ms heartbeat still alive after listener kill; 6000ms PID-unchanged check; 8000ms still-dead after fixture; degraded-backoff 12s log-count window | **Keep fixed window** — poll-for-alive or poll-for-unchanged would pass instantly |
| Deliberate observation window | Count events across elapsed time | sustained-degraded recovery count over 12s (pattern only — reference file out of scope) | **Keep windowed** — not a single exit condition |
| Teardown settle | After `SIGTERM` before `Stop` | 500–1500ms after `child.kill` | **Convert when asserting exit**; otherwise minimal bounded settle poll ≤ old budget |

## Binding surface

- Every **positive** fixed-budget sleep in the in-scope supervisor/wake tests is replaced by
  a shared bounded poller waiting on the same observable the subsequent assertion uses; each
  poller's max wait is **≥** the replaced fixed budget and **≤** the replaced budget plus a
  small documented tolerance (default: same value as the old budget; larger only when the
  inventory row documents why failure latency must not regress).
- Every **negative / quiescence / windowed** site records a start snapshot or baseline counter
  in the inventory so delta assertions over the observation window cannot read stale artifacts
  from a prior run.
- Assertion meaning is unchanged: timeouts still fail loudly; no assertion is relaxed, no
  retry-of-assertion loop masks failures.
- The #487/#556 worker-RPC flake guard remains load-bearing for heavy-lane runs — speedup
  must not increase accepted `onTaskUpdate` / `vitest-worker` timeout signatures.
- Shared pollers inherit the existing helper poll cadence (≥200ms interval, matching
  `waitForMarker` / `waitForSupervisorLogMatch`); no sub-200ms poll storms or unbounded
  full-log rereads without a generation/offset cursor when the log grows.
- Rollback is documented: restore prior fixed sleeps and remove the wait-site inventory guard
  if repeat-run CI shows new timing flake.
- Every **converted** inventory row records its generation boundary (start timestamp, prior
  PID/content, or log offset); the inventory guard fails when any converted row lacks one.
- Race/stale-state fixtures prove polling observes the intended generation per observable
  family — not a prior run's artifacts.

```contract-evidence
binding-id: orchestrator-pack:supervisor-test-waits:site-classification
binding-type: test-harness-wait-policy
binding: every fixed sleep in the in-scope supervisor/wake tests is classified as positive-convertible, negative/quiescence-fixed, poll-interval, or teardown-poll — negative classes are not converted
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:supervisor-test-waits:positive-poll
binding-type: test-runtime-wait-semantics
binding: positive waits in the in-scope tests use shared bounded polling with max timeout at least the prior fixed budget and return as soon as the condition is met
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)

binding-id: orchestrator-pack:supervisor-test-waits:runtime-p75-improvement
binding-type: test-runtime-performance
binding: under heavy-lane settings recorded in vitest-runtime-history.json, p75 wall time per in-scope file is lower than merge-base baseline — machine-checked, not prose-only
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)

binding-id: orchestrator-pack:supervisor-test-waits:negative-preserved
binding-type: test-runtime-quiescence-semantics
binding: negative and quiescence waits keep their full observation window so assertions that something did not happen within N ms cannot pass instantly
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)

binding-id: orchestrator-pack:supervisor-test-waits:heavy-lane-rpc-guard
binding-type: test-runtime-flake-regression
binding: heavy-lane Vitest runs do not accept recurring worker onTaskUpdate RPC timeouts as normal CI behavior after the sleep-to-poll change — static guard plus fail-closed scripted validation of 3-pass repeat-run log artifacts
producer: orchestrator-pack
evidence: NEW(produced-by AC#5)

binding-id: orchestrator-pack:supervisor-test-waits:assertion-strength
binding-type: test-harness-assertion-policy
binding: in-scope expect statements are not weakened — removed checks, widened matchers, and unconditional retry loops are rejected by a machine-checked guard or inventory fingerprint
producer: orchestrator-pack
evidence: NEW(produced-by AC#4)
```

## Files in scope

- `scripts/orchestrator-wake-supervisor.test.ts`
- `scripts/supervisor-fault-boundary.test.ts`
- `scripts/supervisor-recovery.test-helpers.ts` (and related supervisor test setup/helpers
  only as needed to share pollers)
- `scripts/vitest-runtime-history.json` (refresh timing evidence after change)
- `scripts/check-ci-pipeline-split.ps1` (may be extended for the AC#5 repeat-run RPC
  artifact verifier; or a new in-scope verifier script under `scripts/**` with proof-command
  updated accordingly)
- Lightweight guard or fixture proving wait-site classification (planner picks path/name)
- `docs/ci-pipeline-split.md` (rollback/migration note section)

## Files out of scope

- Splitting test files (sibling brief #2)
- Moving tests off the PR path (sibling brief #5)
- Changing supervisor product behavior, production timeouts, or wake scripts
- Light-lane tests unrelated to supervisor/wake
- `vitest.config.ts` and other repo-root config — worker-count / lane assignment changes
  are out of scope; RPC-guard regressions must be resolved via test-side polling only
- `plugins/**`, `vendor/**`, `packages/core/**`

## Denylist

```denylist
vendor/**
packages/core/**
plugins/**
```

Scope boundary note: This denylist is scoped to `238-ci-vitest-supervisor-sleep-to-poll`.

```allowed-roots
scripts/**
docs/ci-pipeline-split.md
```

Scope note: fixtures and guards introduced by this task live under `scripts/**` (planner
chooses paths); `tests/**` is not an allowed root for this draft. Docs edits are limited to
the rollback/migration note path(s) listed in Files in scope. The task declaration and
PR scope guard must enumerate only the in-scope files listed above plus any new guard/fixture
paths introduced by this change — unrelated `scripts/**` or `docs/**` edits are out of scope.

## Acceptance criteria

1. **Wait-site inventory is machine-checked.** A guard or fixture enumerates every
   `setTimeout`/fixed-delay site in the in-scope files and classifies it
   (`positive-convertible`, `negative/quiescence-fixed`, `poll-interval`, `teardown-poll`).
   Each row records the **following assertion** (or window purpose), one-line rationale, and
   for every `positive-convertible` / `teardown-poll` row a **generation boundary** field
   (start timestamp, prior PID/content, or log offset); for every `negative/quiescence-fixed`
   / `windowed` row a **start snapshot** or baseline counter field so delta assertions over
   the observation window cannot read stale state from a prior run.
   The inventory classifies every wait site in the **in-scope files** using the
   design-analysis taxonomy (examples in the table are illustrative patterns, not out-of-scope
   files); any unclassified in-scope site or converted row missing a generation boundary fails
   the guard.

```producer-emission
producer: orchestrator-pack
datum: supervisor-test-waits
expected: site-classification
proof-command: pwsh -NoProfile -File scripts/check-supervisor-test-wait-inventory.ps1
```

2. **Positive waits poll.** All `positive-convertible` and `teardown-poll` sites use a
   shared bounded poller (extend the existing `waitForSupervisorLog*` / `waitForMarker`
   family or equivalent shared helper — planner chooses shape) with max timeout ≥ the replaced
   fixed budget. Process-exit polling reuses existing cross-platform `isAlive`/kill helpers
   already used in the cluster — no ad-hoc platform-specific exit semantics.    Under the same heavy-lane worker/concurrency settings as
   `scripts/vitest-runtime-history.json`, the **p75** wall time per in-scope file is lower
   than the **merge-base** baseline entry for that file (not merely a self-edited value in
   the same PR); a scripted check or CI-produced metrics artifact performs the comparison
   (may extend the wait-inventory guard or a sibling script under `scripts/**`).

```producer-emission
producer: orchestrator-pack
datum: supervisor-test-waits
expected: positive-poll
proof-command: pwsh -NoProfile -File scripts/check-supervisor-test-wait-inventory.ps1
```

```producer-emission
producer: orchestrator-pack
datum: supervisor-test-waits
expected: runtime-p75-improvement
proof-command: pwsh -NoProfile -File scripts/check-supervisor-test-wait-inventory.ps1
```

3. **Negative/quiescence waits preserved.** Sites tagged `negative/quiescence-fixed` or
   `windowed` retain their full observation window. A **separate negative regression corpus**
   (fixture file or guard subcommand — planner chooses) carries an intentionally
   **misclassified** quiescence site tagged `positive-convertible`; the guard must reject
   that corpus in isolation. The production inventory used for acceptance remains
   fail-closed green — the misclassified row is not part of the shipped inventory artifact.

```producer-emission
producer: orchestrator-pack
datum: supervisor-test-waits
expected: negative-preserved
proof-command: pwsh -NoProfile -File scripts/check-supervisor-test-wait-inventory.ps1
```

4. **Assertions unchanged.** No in-scope `expect` is weakened (no removed checks, no
   widened matchers, no additional unconditional retries). A machine-checked assertion
   fingerprint or diff guard (planner chooses mechanism — may extend the wait inventory
   guard) rejects weakened matchers or removed checks in the in-scope test files. Bounded
   timeouts still throw/fail when conditions are genuinely slow.

```producer-emission
producer: orchestrator-pack
datum: supervisor-test-waits
expected: assertion-strength
proof-command: pwsh -NoProfile -File scripts/check-supervisor-test-wait-inventory.ps1
```

5. **Heavy-lane RPC flake guard stays green.** The existing static guard
   (`check-ci-pipeline-split.ps1`) stays green **and** a **fail-closed scripted verifier**
   (planner chooses path — may extend an existing CI check) validates captured heavy-lane log
   artifacts from ≥**3** consecutive passes under CI-equivalent worker/concurrency settings:
   exit non-zero on any `onTaskUpdate` / `vitest-worker` RPC timeout signature. Each artifact
   must carry metadata binding it to the **current PR commit** (SHA), heavy-lane command/config
   fingerprint, and run timestamp — stale or missing metadata fails closed. PR prose or linked
   URLs alone are insufficient.

```producer-emission
producer: orchestrator-pack
datum: supervisor-test-waits
expected: heavy-lane-rpc-guard
proof-command: pwsh -NoProfile -File scripts/check-ci-pipeline-split.ps1
```

Repeat-run RPC artifact validation (≥3 consecutive passes, zero timeout signatures) is
mandatory and enforced by the scripted verifier cited above — not optional PR narration.

6. **Rollback/migration note.** `docs/ci-pipeline-split.md` documents how to revert to fixed
   sleeps if repeat-run CI flake appears, which guard to disable, and that #556 heavy-lane
   assignment is unchanged (no separate linked docs file required).
7. **Race/stale-state fixture.** Fixtures prove each **converted observable family** (log,
   marker/state-file, stdout, process-exit as applicable) waits for the **current** run's
   generation — not a prior PID, marker, log tail, or stdout buffer. At least one fixture per
   family introduced or extended by this change; the inventory guard cross-checks that every
   converted row's generation-boundary field is exercised by a fixture or inline test path.

```positive-outcome
asserts: in-scope supervisor/wake heavy-lane tests finish sooner on the common path because positive waits exit on first condition match, while negative quiescence windows and assertion strength stay intact and heavy-lane CI shows no accepted Vitest worker-RPC flake recurrence
input: realistic
```

## Upgrade-safety check

- Production supervisor/wake behavior is untouched; only test wait strategy changes.
- Bounded max waits ≥ prior fixed budgets — slow paths still fail loudly.
- No change to required CI lane classification or aggregate fail-closed semantics.
- Planner owns helper extension vs new shared poller, but must not scatter one-off poll loops
  across tests.

## Verification

- `pwsh -NoProfile -File scripts/check-supervisor-test-wait-inventory.ps1` (classification,
  positive-poll, negative-preserved contracts).
- `pwsh -NoProfile -File scripts/check-ci-pipeline-split.ps1` (RPC flake regression guard).
- Targeted Vitest: in-scope supervisor/wake files green locally.
- Updated `scripts/vitest-runtime-history.json` entries with lower **p75** wall time per
  in-scope file under the same heavy-lane settings, verified by the scripted merge-base
  comparison required in AC#2 (prose-only PR narration is insufficient).
- Fail-closed repeat-run RPC artifact verifier (AC#5) green on ≥3 consecutive heavy-lane
  log artifacts.
- Negative-wait regression fixture cited in AC#3 executed in CI.
- Race/stale-state fixture cited in AC#7 executed in CI (one per converted observable family).
- Rollback note present and cites revert steps.
- Existing local checks remain green:

```powershell
pwsh -NoProfile -File scripts/verify.ps1
pwsh -NoProfile -File scripts/check-reusable.ps1
```
