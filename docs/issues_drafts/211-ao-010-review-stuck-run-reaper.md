# AO 0.10 stuck review-run liveness reaper

GitHub Issue: #624

## Prerequisite

- `docs/issues_drafts/210-ao-010-review-harness-and-trigger-loop.md` (GitHub Issue: TBD) — **must merge first.** Supplies trigger loop and `ao-review` shim; this issue adds recovery when trigger mints `running` rows that never complete.
- AO 0.10 facts (re-verified `v0.10.2`): no engine-side reaper for `status=running`. `Plan()` skips PRs with `running` for current head (`review/planner.go:60-61`). Same-head stuck runs **cannot** be superseded by a fresh trigger — only head advance supersedes (`review/review.go:228`). Reviewer pane handle `review-<workerId>` (`review/launcher.go:66-68`).
- Incident class: reviewer crash or daemon restart mid-run → perpetual `running` → PR never re-triggers (Gap #2).
- **External prerequisite (may block full recovery AC):** supported AO **`fail-stale-run`** HTTP/CLI surface. If absent, this issue still ships detection + alert; recovery AC applies only after prerequisite lands. Upstream tracking: `AgentWrapper/agent-orchestrator#2070` (`ao review prune`; canonical org — `ComposioHQ/agent-orchestrator` redirects).
- Prior-art verdict: **Genuinely new** for 0.10. Shipped #98 workspace preflight and #171 delivery-confirm are 0.9-era; do not assume they cover 0.10 `running` persistence.

## Goal

Pack-owned detection and recovery for stale `review_run` rows stuck in `status=running` when the reviewer pane is dead or aged out — restoring trigger eligibility without fighting engine idempotency. Same-head stuck runs are the hard case; head-moved stale runs are handled by engine supersession (#210).

```behavior-kind
action-producing
```

```complexity-tier
tier: T3
advisory-prior: T3
escalation-markers: state-machine-core, recovery-class, concurrency
```

## Binding surface

### Invariants

- **No engine reaper exists.** Pack must not assume AO will age out `running` rows.
- **Same-head recovery requires an AO fail-stale-run surface (external prerequisite).** AO 0.10 exposes no public HTTP/CLI to mark a stale `running` run `failed` today (engine marks `failed` only on launch errors — `review/review.go:264-266`). `SupersedeStaleRunningReviewRuns` applies only when the PR head **advances** (`review/review.go:228`). **Forbidden:** pack AO core / `vendor/**` changes and pack direct `ao.db` writes.
- **This issue's pack scope:** supervised **detection** (age floor + pane probe) and **recovery invocation** only when a supported fail-stale-run surface already exists (upstream AO route/CLI — prerequisite or parallel upstream issue). If no surface exists at implementation time, ship detection + classified alert + documented upstream follow-up; **do not** claim recovery AC pass.
- **Age floor + pane liveness.** Classify `stuck_same_head` only when: run `running`, head unchanged, pane absent/stale, **and** age ≥ floor. **Healthy pane always suppresses stuck classification** even above age floor.
- **Probe reviewer liveness.** Use `reviewerHandleId` from `GET …/reviews` + runtime/mux pane health where available. **Unknown pane liveness → alert only; never invoke fail-stale-run.** Age threshold may classify `stuck_same_head` for alerting only when pane is **confirmed absent/stale**, not when liveness is unknown.
- **Re-trigger after recovery.** Once stale run cleared, trigger loop (#210) may mint new pass idempotently.
- **Just-in-time revalidation before fail.** Immediately before invoking fail-stale-run, re-read `GET …/reviews` for the same `(sessionId, prUrl, targetSha)` and re-probe pane liveness. Abort recovery (no fail call) if pane is healthy, head changed, or run is no longer `running` — prevents TOCTOU false fails.
- **Never submit fake results.** Reaper does not call `submit` with fabricated verdicts.
- **Supervised side-process.** Reaper runs under wake-supervisor or sibling lock — no duplicate reapers per worker.
- **Isolation (#304).** Isolated checkout; no force git; artifact proof.

### Recovery classes

| Class | Detection signal | Recovery outcome |
| --- | --- | --- |
| Reviewer crash | Pane gone, run `running`, head unchanged | Clear blocking run; allow re-trigger |
| Daemon restart | Run `running`, pane handle stale | Same |
| Long-running legitimate review | Pane alive, age < threshold | No action |
| Head moved while running | Engine supersedes on trigger | #210 handles — reaper no-op |

## Files in scope

- New reaper module under `scripts/**` `(new)`
- `scripts/orchestrator-wake-supervisor.ps1` / side-process registry — register reaper child `(update)`
- `scripts/review-run-recovery.ps1` — rebind to 0.10 surfaces or supersede `(update)`
- `tests/**` + `tests/external-output-references/**` — stuck-run fixtures `(new)`
- `docs/**` — operator runbook for stuck-review recovery `(update)`

## Files out of scope

- Trigger loop / harness — #210
- Vocabulary migration — #212
- Board consumer — #214 / #213
- AO core / `vendor/**`

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
```

```allowed-roots
scripts/**
tests/**
tests/external-output-references/**
docs/**
```

## Acceptance criteria

1. **Detect stuck same-head run.** Fixture: `running` run, unchanged `targetSha`, dead pane signal, **age ≥ configured floor** → reaper classifies `stuck_same_head`. Fixture with absent pane but age **below** floor → **not** classified stuck.

```positive-outcome
asserts: reaper classifies a running run with unchanged targetSha, absent reviewer pane, and age at or above the configured floor as stuck_same_head; the same fixture below the floor is not classified stuck
input: realistic
```

2. **Recovery unblocks Plan (requires upstream fail-stale-run surface).** When upstream fail-stale-run / prune-class surface exists (see Open questions — `AgentWrapper/agent-orchestrator#2070`), after reaper invokes it **only following just-in-time revalidation** (run still `running`, head unchanged, pane still absent/stale), `GET …/reviews` shows `needs_review` (not `running`) for that PR/head, and trigger returns 201. **Without upstream surface:** ship detection + alert only; recovery AC is not claimed in this PR.

```producer-emission
producer: orchestrator-pack
datum: review-stuck-run-reaper
expected: recovery-unblocks-trigger
proof-command: implementation-specific fixture replay post-recovery trigger eligibility using supported fail-stale-run action (executed only when upstream prerequisite present)
red-then-green: must fail if running row still blocks Plan after recovery action when prerequisite present
```

3. **Upstream prerequisite documented.** Runbook cites `AgentWrapper/agent-orchestrator#2070` (`ao review prune`; canonical org — `ComposioHQ/agent-orchestrator` redirects) or equivalent when recovery is not yet invokable.

4. **Live pane always protects.** Confirmed healthy pane → never `stuck_same_head`, even when age ≥ floor. Unknown liveness → alert-only; no fail invocation.

5. **Unknown liveness is non-destructive.** Fixture: pane probe unavailable, age above floor → classified alert, **no** fail-stale-run call.

6. **Alert-only mode observable (when upstream fail surface absent).** Reaper emits a classified supervisor log line (wake-supervisor child log) with parseable fields: `classification`, `sessionId`, `prUrl`, `runId`, `targetSha`, `ageSeconds`, `paneLiveness` (`healthy|absent|unknown`). Proof: fixture replay captures log output and asserts fields present with no fail invocation.

```producer-emission
producer: orchestrator-pack
datum: review-stuck-run-reaper
expected: alert-only-classified
proof-command: implementation-specific fixture asserting classified supervisor log line without fail-stale-run call
red-then-green: must fail if unknown liveness triggers fail invocation
```

7. **No ao.db writes from pack.** Recovery uses supported daemon API/CLI only — not direct SQL.

8. **Supervisor single-flight.** Two reaper ticks cannot double-recover same run (lock or idempotent recovery).

9. **Scenario matrix:**

| Scenario | Detection | Recovery (when fail API exists) |
| --- | --- | --- |
| Reviewer crash mid-run | `stuck_same_head` after age+pane gate | Reaper clears block |
| Daemon restart mid-run | Same | Same |
| Live pane, long review | No stuck classification | No-op |
| Duplicate trigger while running | No stuck classification | Engine mutex — no-op |
| Head moved | No same-head stuck | Engine supersedes — no-op |
| Fail API absent | Alert only | Parked — upstream prerequisite |

## Upgrade-safety check

- Daemon API / pane probes only; **no** pack reads or writes of `ao.db` or `.ao/**` in v1 (forbidden by denylist — no optional diagnostic exception).

## Verification

1. Fixture replay for stuck detection + post-recovery trigger.
2. Supervisor registration guard.
3. Discipline checks on this draft.

## Decisions

### Design analysis (three options)

| Option | Cost | Risk | Sufficiency |
| --- | --- | --- | --- |
| **(a) Pane probe + age threshold** | Medium ops tuning | False positive kills valid review | **Cheapest sufficient** |
| **(b) Read-only ao.db `updated_at` only** | Low HTTP | Schema coupling | Rejected for primary path |
| **(c) Operator manual only** | Zero automation | PRs stuck until human | Insufficient |

**Land:** **(a)** supervised reaper with configurable age floor + pane liveness.

```contract-evidence
binding-id: orchestrator-pack:review-stuck-run-reaper:recovery-unblocks-trigger
binding-type: structured
binding: after reaper recovery, trigger eligibility restored for same-head PR previously blocked by running run
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)
expected: recovery-unblocks-trigger
```

