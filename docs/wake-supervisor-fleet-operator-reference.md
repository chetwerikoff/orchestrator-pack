# Wake-supervisor fleet operator reference

Living operator reference for the registry-backed wake-supervisor fleet. Use this document
instead of dated investigation memos when triaging supervised children or fleet-level
supervisor behavior.

**Related:** start/stop mechanics and webhook defaults live in
[`orchestrator-wake-runbook.md`](orchestrator-wake-runbook.md). Review-pipeline context
(without duplicating it here) is in [`architecture.md`](architecture.md#review-paths).

## Supervisor entry point

Single operator entry point for total fleet (Issue #168, expanded registry Issue #205):

```powershell
cd <orchestrator-pack-root>
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/orchestrator-wake-supervisor.ps1 -Action Start
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/orchestrator-wake-supervisor.ps1 -Action Status
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/orchestrator-wake-supervisor.ps1 -Action Stop
```

Default state root: `%LOCALAPPDATA%/orchestrator-pack-wake-supervisor/` (Linux:
`$XDG_STATE_HOME/orchestrator-pack-wake-supervisor/` or `~/.local/state/...`). Per-child
artifacts include `{child-id}.log`, `{child-id}.pid`, `{child-id}.progress.json`, and
side-effect lock files under `{stateRoot}/` when side-effecting.

## Registry roster (authoritative)

Roster derived from `scripts/orchestrator-side-process-registry.json` `children[]` at
implementation time (**16** children):

| `children[].id` | Script | Cadence (s) | Side-effecting |
| --- | --- | ---: | --- |
| `listener` | `orchestrator-wake-listener.ps1` | 300 | yes |
| `heartbeat` | `orchestrator-wake-heartbeat.ps1` | 900 | no |
| `review-trigger-reconcile` | `review-trigger-reconcile.ps1` | 600 | yes |
| `review-trigger-reeval` | `review-trigger-reeval.ps1` | 5 | yes |
| `review-ready-report-state-seed` | `review-ready-report-state-seed.ps1` | 5 | yes |
| `ci-green-wake-reconcile` | `ci-green-wake-reconcile.ps1` | 60 | yes |
| `dead-worker-reconcile` | `dead-worker-reconcile.ps1` | 60 | yes |
| `review-finding-delivery-confirm` | `review-finding-delivery-confirm.ps1` | 300 | yes |
| `worker-message-submit-reconcile` | `worker-message-submit-reconcile.ps1` | 30 | yes |
| `review-run-recovery` | `review-run-recovery.ps1` | 60 | yes |
| `review-stuck-run-reaper` | `review-stuck-run-reaper.ps1` | 60 | yes |
| `review-start-claim-reaper` | `review-start-claim-reaper.ps1` | 30 | yes |
| `ci-failure-notification-reconcile` | `ci-failure-notification-reconcile.ps1` | 60 | yes |
| `ci-failure-notification-reaction` | `ci-failure-notification-reaction.ps1` | 60 | no |
| `escalation-router` | `orchestrator-escalation-router.ps1` | 30 | yes |
| `scripted-review-confirmed-delivery-gate` | `scripted-review-confirmed-delivery-gate.ps1` | 300 | yes |

**Registry drift note:** `requiredChildIds[]` in the same file lists **15** ids and omits
`scripted-review-confirmed-delivery-gate`. This doc treats **`children[]` as authoritative**;
do not "fix" the registry from this issue.

## Coverage index

Every row below is expanded in its section with all five operator fields.

| Id | Verify pattern | Known-broken (authoring-time) |
| --- | --- | --- |
| `listener` | `-DryRun` (long-running HTTP) | Clean |
| `heartbeat` | `-Once -DryRun` | Clean |
| `review-trigger-reconcile` | `-Once -DryRun` | Root A (#688), Root B (#699) |
| `review-trigger-reeval` | `-Once -DryRun` | Root B (#699) |
| `review-ready-report-state-seed` | `-Once -DryRun` | Root B (#699) |
| `ci-green-wake-reconcile` | `-Once -DryRun` | Root A (#688), Root B (#699), Root C |
| `dead-worker-reconcile` | `-Once -DryRun` | Root A (#688) |
| `review-finding-delivery-confirm` | `-Once -DryRun` | Root A (#688), Root B (#699), Root A follow-up (#700), Root C |
| `worker-message-submit-reconcile` | `-Once -DryRun` | Root A (#688), Root A follow-up (#700), Root C |
| `review-run-recovery` | `-Once -DryRun` | Clean |
| `review-stuck-run-reaper` | `-Once -DryRun` | Clean |
| `review-start-claim-reaper` | `-Once -DryRun` | Clean |
| `ci-failure-notification-reconcile` | `-Once -DryRun` | Root A (#688), Root B (#699), Root C |
| `ci-failure-notification-reaction` | `-Once -DryRun` | Root B (#699) |
| `escalation-router` | `-Once` only (no `-DryRun`) | Clean (test-isolation caveat) |
| `scripted-review-confirmed-delivery-gate` | fixture / explicit mandatory params | Root D (#701), Root C |
| **F1** | supervisor log + Status | inherits #450 backoff |
| **F1b** | Status + `{id}.progress.json` freshness | — |
| **F2** | Status + adoption log lines | — |

## Known-broken flag legend (live queue at doc authoring)

Refresh these cells when #688, #699, #700, or #701 merge or change state.

| Root | Mechanism | Tracking (2026-07-08) | Affected children |
| --- | --- | --- | --- |
| **A** | `Get-AoEventsSince` → removed `ao events list` (fail-soft) | [#688](https://github.com/chetwerikoff/orchestrator-pack/issues/688) **OPEN** | `review-trigger-reconcile`, `ci-green-wake-reconcile`, `dead-worker-reconcile`, `review-finding-delivery-confirm`, `worker-message-submit-reconcile`, `ci-failure-notification-reconcile` |
| **B** | `sessionMatchesPr` / `resolveHeadOwningWorkerSessionId` need `prNumber`/`pr`; AO 0.10 `ao session ls` emits `issueId` only | [#699](https://github.com/chetwerikoff/orchestrator-pack/issues/699) **OPEN** | `ci-failure-notification-reaction`, `ci-failure-notification-reconcile`, `review-trigger-reconcile`, `review-trigger-reeval`, `review-ready-report-state-seed`, `ci-green-wake-reconcile`, `review-finding-delivery-confirm` |
| **A follow-up** | Per-consumer correlation/dedup after events removal | [#700](https://github.com/chetwerikoff/orchestrator-pack/issues/700) **OPEN** | `review-trigger-reconcile`, `ci-green-wake-reconcile`, `review-finding-delivery-confirm`, `worker-message-submit-reconcile`, `ci-failure-notification-reconcile` |
| **D** | Registry registers polling child for per-review script with five mandatory params not supplied by supervisor launch | [#701](https://github.com/chetwerikoff/orchestrator-pack/issues/701) **OPEN** | `scripted-review-confirmed-delivery-gate` (crash-loop under F1) |
| **C (secondary)** | `deliveredAt` absent on AO 0.10.2 session-reviews wire | wire fact — verify live reads before claiming broken | `review-finding-delivery-confirm`, `worker-message-submit-reconcile`, `ci-green-wake-reconcile`, `ci-failure-notification-reconcile`, `scripted-review-confirmed-delivery-gate` |
| **Clean** | — | — | `listener`, `heartbeat`, `review-run-recovery`, `review-stuck-run-reaper`, `review-start-claim-reaper`, `escalation-router` |

---

## Fleet scenarios (supervisor-owned)

### F1 — Child crash / crash-loop backoff

| Field | Operator detail |
| --- | --- |
| **Trigger** | Supervised child exits; especially rapid exit within **5000 ms** lifespan (`AO_WAKE_SUPERVISOR_CRASH_RAPID_EXIT_THRESHOLD_MS`). |
| **Expected action** | Exponential backoff before respawn; circuit breaker at **12** rapid exits (`Orchestrator-SideProcessCrashBackoff.ps1`). Supervisor poll loop continues — child management is fault-bounded (Issue #450). **Never** disables other children. |
| **Bound surfaces** | Supervisor state `{stateRoot}/supervisor-state.json` recovery entries per child; child log tail; env tunables `AO_WAKE_SUPERVISOR_CRASH_*`. |
| **Verify (read-only)** | `pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1 -Action Status` — note `backoffUntil` / not running; tail `supervisor.log` for `crash backoff:` lines. |
| **Known-broken flags** | Root **D** (#701): `scripted-review-confirmed-delivery-gate` missing mandatory launch args → immediate exit → F1 rapid-exit accumulation. Root **A** consumers may fail-soft without crashing. |

### F1b — Stall detection (alive but not progressing)

| Field | Operator detail |
| --- | --- |
| **Trigger** | Child process alive, no side-effect lock in flight, and `{child-id}.progress.json` stale beyond `cadenceSeconds × stallGraceMultiplier` (registry default multiplier **4**). |
| **Expected action** | Supervisor treats child as stalled and restarts it. Side-effecting children write progress during ticks via `Orchestrator-SideProcessProgress.ps1`. **Never** kills unrelated children. |
| **Bound surfaces** | `{stateRoot}/{child-id}.progress.json`, `{child-id}.pid`, side-effect lock files (`*-side-effect.lock`). |
| **Verify (read-only)** | Status + inspect progress freshness: `Get-Content <stateRoot>/review-trigger-reconcile.progress.json` (substitute child id); compare `lastProgressMs` to wall clock. |
| **Known-broken flags** | None at authoring time. A child that cannot write progress (crash before first tick) may appear stalled sooner. |

### F2 — Orphan / stale-pid adoption

| Field | Operator detail |
| --- | --- |
| **Trigger** | Supervisor start or poll finds a live `pwsh`/`powershell` process matching a registry child script under the state root, but pid file missing/stale/wrong. |
| **Expected action** | Adopt matching process into pid file, or terminate duplicate when two processes claim the same role. Clears stale pid records when process is dead. **Never** adopts unrelated shells. |
| **Bound surfaces** | `{stateRoot}/{child-id}.pid`, process command lines, supervisor log (`adoption:` lines). |
| **Verify (read-only)** | After manual child start or supervisor restart: `-Action Status` shows expected pid; supervisor log contains `adoption:` or no duplicate warnings. |
| **Known-broken flags** | Adjacent orphan discovery for Stop/Status tracked separately ([#613](https://github.com/chetwerikoff/orchestrator-pack/issues/613)); orthogonal to adoption mechanics. |

---

## Supervised children

### listener

| Field | Operator detail |
| --- | --- |
| **Trigger** | AO `webhook` notifier POST to loopback `http://127.0.0.1:17487/ao-wake` (default). |
| **Expected action** | Filter wake-relevant semantic types; dedupe within 30 s; `ao send` orchestrator nudge. On `merge.ready`, may `ao review run` via fast review trigger (Issue #207) before forwarding wake. Side-effect lock drains concurrent review starts. **Never** runs periodic open-PR reconcile. |
| **Bound surfaces** | `ao send`, `ao status` (session id), `gh` (checks for review wake), `docs/orchestrator-wake-filter.mjs`, `{stateRoot}/listener-side-effect.lock`, shared dedup `%TEMP%/orchestrator-wake-dedup.json` (`AO_WAKE_DEDUP_STATE`). |
| **Verify (read-only)** | `pwsh -NoProfile -File scripts/orchestrator-wake-listener.ps1 -DryRun` (blocks — use dedicated terminal). Smoke: synthetic POST per [`orchestrator-wake-runbook.md`](orchestrator-wake-runbook.md#verify-reachability). |
| **Known-broken flags** | **Clean** |

### heartbeat

| Field | Operator detail |
| --- | --- |
| **Trigger** | Periodic timer (registry cadence 900 s; script default interval 240 min unless `-IntervalMinutes` / `AO_WAKE_HEARTBEAT_INTERVAL_MINUTES`). |
| **Expected action** | Emit labelled `ao send` heartbeat wake (`wake heartbeat.reconcile periodic=reconcile`) independent of webhook traffic. Shares dedup file with listener. **Never** binds HTTP port or reads webhook POSTs. |
| **Bound surfaces** | `ao send`, `ao status`, shared dedup state (`AO_WAKE_DEDUP_STATE`), `docs/orchestrator-wake-filter.mjs` heartbeat tick. |
| **Verify (read-only)** | `pwsh -NoProfile -File scripts/orchestrator-wake-heartbeat.ps1 -Once -DryRun` |
| **Known-broken flags** | **Clean** |

### review-trigger-reconcile

| Field | Operator detail |
| --- | --- |
| **Trigger** | Periodic tick (registry 600 s). |
| **Expected action** | Enumerate open PR heads via `gh`; compare review-run coverage; `ao review run` only when head is ready-for-review (Issue #195). **Never** `ao spawn`, `--claim-pr`, `ao session kill`, or `ao send`. |
| **Bound surfaces** | `gh pr list`, `gh` checks/protection, `Get-AoReviewRuns`, `Get-AoEventsSince` (Root A), `ao session ls` rows via `docs/review-trigger-reconcile.mjs` (`sessionMatchesPr`, `resolveHeadOwningWorkerSessionId` — Root B), state `%TEMP%/orchestrator-review-reconcile-state.json` (`AO_REVIEW_TRIGGER_RECONCILE_STATE`), shared ci-green cycle evidence file. |
| **Verify (read-only)** | `pwsh -NoProfile -File scripts/review-trigger-reconcile.ps1 -Once -DryRun` |
| **Known-broken flags** | Root **A** [#688](https://github.com/chetwerikoff/orchestrator-pack/issues/688) OPEN; Root **B** [#699](https://github.com/chetwerikoff/orchestrator-pack/issues/699) OPEN; Root **A follow-up** [#700](https://github.com/chetwerikoff/orchestrator-pack/issues/700) OPEN |

### review-trigger-reeval

| Field | Operator detail |
| --- | --- |
| **Trigger** | Seconds-scale poll (registry 5 s) over deferred-head watch set. |
| **Expected action** | When a head deferred as not-yet-ready becomes ready within bounded window, `ao review run` with classification `scoped_deferred_head_watch`. **Never** full open-PR reconcile (that is `review-trigger-reconcile`). |
| **Bound surfaces** | `{stateRoot}/review-trigger-reeval-watch.json`, `gh`, `Get-AoReviewRuns`, `docs/review-trigger-reeval.mjs` (uses `resolveHeadOwningWorkerSessionId` — Root B), side-effect lock `review-trigger-reeval-side-effect.lock`. |
| **Verify (read-only)** | `pwsh -NoProfile -File scripts/review-trigger-reeval.ps1 -Once -DryRun` |
| **Known-broken flags** | Root **B** [#699](https://github.com/chetwerikoff/orchestrator-pack/issues/699) OPEN |

### review-ready-report-state-seed

| Field | Operator detail |
| --- | --- |
| **Trigger** | Seconds-scale poll (registry 5 s) over `ao status` reports (including terminated sessions). |
| **Expected action** | Bind accepted `ready_for_review` reports to current PR heads; seed scoped #235 watches; invoke bounded reeval with `startReason=report_state_seed`. **Never** replaces listener or full reconcile. |
| **Bound surfaces** | `ao status --reports full`, `docs/review-ready-report-state-seed.mjs`, `{stateRoot}` seed progress files, `resolveHeadOwningWorkerSessionId` (Root B). |
| **Verify (read-only)** | `pwsh -NoProfile -File scripts/review-ready-report-state-seed.ps1 -Once -DryRun` |
| **Known-broken flags** | Root **B** [#699](https://github.com/chetwerikoff/orchestrator-pack/issues/699) OPEN |

### ci-green-wake-reconcile

| Field | Operator detail |
| --- | --- |
| **Trigger** | Periodic tick (registry 60 s). |
| **Expected action** | When required CI is green and worker is live head-owner pre-hand-off, `ao send` nudge to worker. **Never** `ao spawn`, `--claim-pr`, or session kill; does not recover dead workers. |
| **Bound surfaces** | `gh` checks, `Get-AoEventsSince` (Root A), dispatch journal, `docs/ci-green-wake-reconcile.mjs`, `resolveHeadOwningWorkerSessionId` (Root B), state `%TEMP%/orchestrator-ci-green-wake-state.json` (`AO_CI_GREEN_WAKE_RECONCILE_STATE`), session-reviews `deliveredAt` reads (Root C). |
| **Verify (read-only)** | `pwsh -NoProfile -File scripts/ci-green-wake-reconcile.ps1 -Once -DryRun` |
| **Known-broken flags** | Root **A** [#688](https://github.com/chetwerikoff/orchestrator-pack/issues/688) OPEN; Root **B** [#699](https://github.com/chetwerikoff/orchestrator-pack/issues/699) OPEN; Root **A follow-up** [#700](https://github.com/chetwerikoff/orchestrator-pack/issues/700) OPEN; Root **C** (`deliveredAt` wire) |

### dead-worker-reconcile

| Field | Operator detail |
| --- | --- |
| **Trigger** | Periodic tick (registry 60 s). |
| **Expected action** | Detect assigned workers with capture-backed dead evidence; invoke `invoke-worker-recovery.ps1 -Trigger reconcile_dead_worker` once per recoverable key. Suppresses operator kills and shutdown windows. **Never** starts review runs. |
| **Bound surfaces** | `ao status`, `Get-AoEventsSince` (Root A), `docs/dead-worker-reconciler.mjs`, state `%TEMP%/orchestrator-dead-worker-reconcile-state.json` (`AO_DEAD_WORKER_RECONCILE_STATE`). |
| **Verify (read-only)** | `pwsh -NoProfile -File scripts/dead-worker-reconcile.ps1 -Once -DryRun` |
| **Known-broken flags** | Root **A** [#688](https://github.com/chetwerikoff/orchestrator-pack/issues/688) OPEN |

### review-finding-delivery-confirm

| Field | Operator detail |
| --- | --- |
| **Trigger** | Periodic tick (registry 300 s). |
| **Expected action** | Observe review runs and worker reports; confirm finding delivery when worker reports `addressing_reviews` after delivery signal; escalate on timeout (observe-only for AO 0.10 auto-delivery). **Never** `ao spawn`, `--claim-pr`, kill, or `ao send` (submit owned by worker-message-submit-reconcile). |
| **Bound surfaces** | `Get-AoReviewRuns`, `ao status --reports full`, `Get-AoEventsSince` (Root A), `docs/review-finding-delivery-confirm.mjs`, state `%TEMP%/orchestrator-review-delivery-confirm-state.json`, `sessionMatchesPr` (Root B), `deliveredAt` (Root C). |
| **Verify (read-only)** | `pwsh -NoProfile -File scripts/review-finding-delivery-confirm.ps1 -Once -DryRun` |
| **Known-broken flags** | Root **A** [#688](https://github.com/chetwerikoff/orchestrator-pack/issues/688) OPEN; Root **B** [#699](https://github.com/chetwerikoff/orchestrator-pack/issues/699) OPEN; Root **A follow-up** [#700](https://github.com/chetwerikoff/orchestrator-pack/issues/700) OPEN; Root **C** |

### worker-message-submit-reconcile

| Field | Operator detail |
| --- | --- |
| **Trigger** | Periodic tick (registry 30 s). |
| **Expected action** | Reconcile journaled worker message dispatch/submit queue; `Register-WorkerMessageDispatch` / pack send paths. **Never** owns review-start or CI-failure episode recording. |
| **Bound surfaces** | Worker message dispatch journal, `Get-AoEventsSince` (Root A), `Get-AoReviewRuns`, `docs/worker-message-submit-reconcile.mjs`, state `%TEMP%/orchestrator-worker-message-submit-state.json` (`AO_WORKER_MESSAGE_SUBMIT_STATE`), session-reviews reads (Root C). |
| **Verify (read-only)** | `pwsh -NoProfile -File scripts/worker-message-submit-reconcile.ps1 -Once -DryRun` |
| **Known-broken flags** | Root **A** [#688](https://github.com/chetwerikoff/orchestrator-pack/issues/688) OPEN; Root **A follow-up** [#700](https://github.com/chetwerikoff/orchestrator-pack/issues/700) OPEN; Root **C** |

### review-run-recovery

| Field | Operator detail |
| --- | --- |
| **Trigger** | Periodic tick (registry 60 s). |
| **Expected action** | Terminalize non-terminal review runs whose reviewer process is provably dead after grace, or ambiguous beyond stale threshold. **Never** starts review runs or sends findings. |
| **Bound surfaces** | `Get-AoReviewRuns`, reviewer process identity / liveness, `docs/review-run-recovery.mjs`, optional `StoreDir` param, side-effect lock. Superseded by daemon reaper when `AO_REVIEW_RECOVERY_MODE=daemon`. |
| **Verify (read-only)** | `pwsh -NoProfile -File scripts/review-run-recovery.ps1 -Once -DryRun` |
| **Known-broken flags** | **Clean** |

### review-stuck-run-reaper

| Field | Operator detail |
| --- | --- |
| **Trigger** | Periodic tick (registry 60 s). |
| **Expected action** | Detect same-head runs stuck `status=running` with absent/stale reviewer pane; invoke upstream fail-stale-run when exposed. **Never** submits fabricated review results. |
| **Bound surfaces** | AO review run list / liveness surfaces, side-effect lock `review-stuck-run-reaper-side-effect.lock`. |
| **Verify (read-only)** | `pwsh -NoProfile -File scripts/review-stuck-run-reaper.ps1 -Once -DryRun` |
| **Known-broken flags** | **Clean** |

### review-start-claim-reaper

| Field | Operator detail |
| --- | --- |
| **Trigger** | Periodic tick (registry 30 s). |
| **Expected action** | Terminalize active review-start claims whose local holder is dead with no covering run and no launch-pending intent. **Never** starts new review runs. |
| **Bound surfaces** | Review-start claim store (`Review-StartClaim.ps1`), `Get-AoReviewRuns`, side-effect lock. |
| **Verify (read-only)** | `pwsh -NoProfile -File scripts/review-start-claim-reaper.ps1 -Once -DryRun` |
| **Known-broken flags** | **Clean** |

### ci-failure-notification-reconcile

| Field | Operator detail |
| --- | --- |
| **Trigger** | Periodic tick (registry 60 s) over pending CI-failure episodes. |
| **Expected action** | Evaluate episodes against live worker state; deliver via worker message dispatch when appropriate. **Never** `ao spawn`, `--claim-pr`, or session kill. |
| **Bound surfaces** | `Get-AoEventsSince` (Root A, filtered to `reaction.action_succeeded`), `gh` checks, `docs/ci-failure-notification.mjs`, `{stateRoot}/ci-failure-notification/` store (`AO_CI_FAILURE_NOTIFICATION_STORE`), `resolveHeadOwningWorkerSessionId` (Root B), `deliveredAt` (Root C). |
| **Verify (read-only)** | `pwsh -NoProfile -File scripts/ci-failure-notification-reconcile.ps1 -Once -DryRun` |
| **Known-broken flags** | Root **A** [#688](https://github.com/chetwerikoff/orchestrator-pack/issues/688) OPEN; Root **B** [#699](https://github.com/chetwerikoff/orchestrator-pack/issues/699) OPEN; Root **A follow-up** [#700](https://github.com/chetwerikoff/orchestrator-pack/issues/700) OPEN; Root **C** |

### ci-failure-notification-reaction

| Field | Operator detail |
| --- | --- |
| **Trigger** | Periodic tick (registry 60 s) over open worker PRs with required CI red. |
| **Expected action** | Record pending CI-failure episodes (enqueue-only); machine-checkable `reactions.ci-failed` callsite. Side-effecting flag **false** in registry — observe/record only in this script; delivery is reconcile sibling. **Never** delivers worker messages directly. |
| **Bound surfaces** | `gh` checks bundle, `ao session ls` / status rows (`sessionMatchesPr` — Root B), `{stateRoot}/ci-failure-notification/` episode store. |
| **Verify (read-only)** | `pwsh -NoProfile -File scripts/ci-failure-notification-reaction.ps1 -Once -DryRun` |
| **Known-broken flags** | Root **B** [#699](https://github.com/chetwerikoff/orchestrator-pack/issues/699) OPEN |

### escalation-router

| Field | Operator detail |
| --- | --- |
| **Trigger** | Periodic tick (registry 30 s). |
| **Expected action** | Redeliver outstanding `llm-orchestrator` route escalations via `ao send`. **Never** creates new escalation classes inline. |
| **Bound surfaces** | Orchestrator escalation state (`Get-OrchestratorEscalationStatePath` / `AO_ORCHESTRATOR_ESCALATION_STATE`), `ao send`, requires orchestrator session id. |
| **Verify (read-only)** | `pwsh -NoProfile -File scripts/orchestrator-escalation-router.ps1 -Once` — **no `-DryRun` param** on this script. |
| **Known-broken flags** | **Clean** — separate `/tmp` shared-default state path test-isolation caveat under harness. |

### scripted-review-confirmed-delivery-gate

| Field | Operator detail |
| --- | --- |
| **Trigger** | Intended: per-review invocation after `ao review submit` with explicit `SessionId`, `RunId`, `PrNumber`, `TargetSha`, `Verdict`. Supervisor registry launches it as a **polling child without those params** (Root D). |
| **Expected action** | Poll session reviews API; suppress or fire exactly one journaled worker send for `changes_requested`. **Never** reads `ao.db` directly. |
| **Bound surfaces** | `Get-AoSessionReviewsJson` / review list API, `docs/scripted-review-confirmed-delivery-gate.mjs` (if present), worker dispatch journal, session-reviews `deliveredAt` (Root C). Mandatory params in script param block: `SessionId`, `RunId`, `PrNumber`, `TargetSha`, `Verdict`. |
| **Verify (read-only)** | Not supervisor-smokeable today. Fixture/manual: `pwsh -NoProfile -File scripts/scripted-review-confirmed-delivery-gate.ps1 -SessionId <id> -RunId <id> -PrNumber <n> -TargetSha <sha> -Verdict changes_requested -DryRun` |
| **Known-broken flags** | Root **D** [#701](https://github.com/chetwerikoff/orchestrator-pack/issues/701) OPEN (crash-loop under supervisor); Root **C** |

---

## When to update this document

Update this file in the **same PR** (or an immediate follow-up docs PR) when any of:

1. **`scripts/orchestrator-side-process-registry.json`** — add, remove, or rename a
   `children[].id`, or change `cadenceSeconds`, `sideEffecting`, or `extraArgs` that affect
   verify commands or bound surfaces.
2. **Operator-visible binding change** in a supervised child script — new mandatory param,
   new `-DryRun` / `-Once` flag, new state path env var, new AO/`gh` surface.
3. **Fleet supervisor behavior** affecting F1/F1b/F2 — backoff thresholds, stall grace,
   adoption rules (`Orchestrator-SideProcessCrashBackoff.ps1`,
   `Orchestrator-SideProcessSupervisor.ps1`).
4. **Known-broken queue state** — when #688, #699, #700, or #701 merge or supersede.

Optional drift guard: `scripts/check-wake-supervisor-fleet-doc-coverage.ps1` (registry id ↔ doc
section headings).

## Sources (historical, local-only)

Point-in-time investigation memos (`SUPERVISOR-scenario-inventory-2026-07-08.md`, etc.) were
used only as verify-not-copy prompts during authoring. They are **not** maintained references
and may be absent from a checkout. All operator claims above stand on registry + script + live
issue evidence only.
