# Wake supervisor must survive persistent child failure (degraded backoff, fault boundary, null OpenPrs)

GitHub Issue: [#450](https://github.com/chetwerikoff/orchestrator-pack/issues/450)

## Prerequisite

- `docs/issues_drafts/71-orchestrator-side-process-supervisor.md` (GitHub [#205](https://github.com/chetwerikoff/orchestrator-pack/issues/205), **closed**) — supervised side-process registry, session-id debounce + staggered restart with backoff/jitter, per-tick error survival, **empty-collection** OpenPrs tolerance for reconcile children, rapid-exit crash backoff (`Orchestrator-SideProcessCrashBackoff.ps1`). **Already does:** restart storm protection on **session-id change** and **rapid child exit**; `Get-GhChecksBundleByPr` accepts `@()` without binding errors (#205 fixture). **Does not cover:** degraded-**alive** restart storm under persistent dependency outage; supervisor-level fault boundary; **null** (not empty) `OpenPrs` binding in children added after #205.
- `docs/issues_drafts/124-supervisor-empty-pid-file-start-crash.md` (GitHub [#388](https://github.com/chetwerikoff/orchestrator-pack/issues/388), **closed**) — zero-byte child `.pid` files no longer crash Start/Status. **Does not cover:** supervisor loop survival under churn or unhandled exceptions in the poll loop.
- `docs/issues_drafts/138-supervisor-children-gh-rest-shim-path.md` (GitHub [#447](https://github.com/chetwerikoff/orchestrator-pack/issues/447), **open**) — prepend pack `scripts/gh` on supervisor-child PATH to route inventory reads to REST `core`. **Co-required with this issue; neither alone closes the 2026-06-24 incident.** #447 removes one trigger (GraphQL exhaustion on inventory reads); this issue hardens the supervisor against **any** persistent child failure (REST `core` exhaustion under storm, fence errors, future dependencies).
- `docs/issues_drafts/136-gh-wrapper-mutual-recursion-terminal-resolution.md` (GitHub [#442](https://github.com/chetwerikoff/orchestrator-pack/issues/442), **open**, **P0**) — mutual-recursion OOM on dual `gh` wrappers. **Out of scope here:** true `OutOfMemoryException` from wrapper recursion is #442 territory; this issue's fault boundary does **not** claim to catch OOM.

**Prior-art verdict:** **Genuinely new draft** (not an amendment to #205/#124). Those issues shipped rapid-exit backoff, session-id stagger, empty-**collection** tolerance, and empty-pid tolerance. The 2026-06-24 incident class (degraded-alive restart storm → supervisor process exit) is a distinct gap. Amending #205 would blur closed scope and re-open merged acceptance.

**Ship priority:** **#450 > #447.** Both depend only on #431+#442 merge-order gates, not on each other; #450 fixes supervisor fragility itself and ships first. Co-required for full incident closure, built independently.

**Incident context (2026-06-24, independently verified):**

| Claim | Status | Artifact |
|---|---|---|
| Restart storm while children degraded | **Fact** | `grep -c "recovering (attempt" ~/.local/state/orchestrator-pack-wake-supervisor/supervisor.log` → **34,965**; essentially all lines are `attempt 1/3` (10× attempt 2, 2× attempt 3); **0** `terminal degraded` lines |
| `OpenPrs is null` child crash | **Fact** | `supervisor.log` `2026-06-24T18:35:43`: `review-ready-report-state-seed non-working (degraded): Cannot bind argument to parameter 'OpenPrs' because it is null` |
| GraphQL exhaustion as trigger | **Fact** (trigger, not root of supervisor fragility) | #447 incident notes; children failed `gh pr list` / `gh repo view` |
| `ObjectDisposedException` in `StdOutputHandler` | **Fact** | `supervisor.log` lines **~101435–101671** (storm peak ~17:04–17:44 UTC): `Unhandled exception. System.ObjectDisposedException: Cannot write to a closed TextWriter` at `StartProcessCommand.StdOutputHandler` / `StdErrorHandler` (`Process.cs:2248`/`2262`); immediately preceded by `ci-failure-notification-reconcile recovering (attempt 1/3)` churn. Redirect enabled at child spawn (`RedirectStandardOutput`/`RedirectStandardError` when PS ≥ 6). |
| `ChildEntry` null in supervisor loop | **Fact** | `supervisor.log` tail 2026-06-24: `Cannot bind argument to parameter 'ChildEntry' because it is null` — loop-level null-deref under storm; same fault-boundary class as redirect race, not a separate issue. |
| `FileLoadException` child exit | **Fact** | `supervisor.log` ~line 89938: `ci-failure-notification-reaction` exited 134 with `System.IO.FileLoadException: The given assembly name was invalid` — child crash under storm; supervisor must survive via fault boundary, not exit. |
| `state.json` attempts never escalate | **Fact** | `~/.local/state/orchestrator-pack-wake-supervisor/state.json`: `review-ready-report-state-seed` and `worker-message-submit-reconcile` show `attempts: 0` while supervisor log shows thousands of `recovering (attempt 1/3)` |

**D1 mechanism (verified):** Supervisor loop (`Orchestrator-SideProcessSupervisor.ps1`) applies `Test-OrchestratorWakeSupervisorChildCrashRestartAllowed` only when `not $status.Alive` (rapid-exit path). The degraded/stalled-alive path (~1251–1289) restarts **every poll tick** with no degraded backoff. When a restarted child briefly reports `working` + `Alive`, `Reset-OrchestratorWakeSupervisorChildRecoveryState` zeroes `attempts` (~1223–1224), so counters oscillate 0↔1 under persistent outage.

## Goal

The wake supervisor must **never exit** because a supervised child fails persistently. Under any sustained dependency outage or inventory failure, child recovery must be **backed off** (not per-tick churn) and **auto-recover** when the dependency heals (no operator required for rate-limit class outages). The supervisor poll loop must have a **per-child fault boundary** so no unhandled exception from child management (redirect races, loop null-deref, child crash propagation) kills the process. Every gh-fed child must tolerate **null or empty** open-PR inventory without binding crashes — closing the 2026-06-24 incident class independent of which dependency failed.

```behavior-kind
action-producing
```

## Binding surface

- **Degraded-alive backoff (sticky counter):** A child that stays alive but reports `degraded` or `stalled` must not be kill-restarted on every supervisor poll. The **degraded recovery counter must not reset on a transient `working` blip** (planner chooses mechanism — e.g. separate `degradedBackoffUntilMs`, sticky `degradedAttempts`, or equivalent). Time-based backoff between restarts on the degraded path mirrors existing rapid-exit backoff semantics.
- **Two distinct end states (do not conflate):**
  - **Backoff + auto-recovery (C3 — dependency-driven):** When failure is driven by an external dependency (rate limit, fence untrusted, auth blip, REST/GraphQL exhaustion), apply capped exponential backoff + probe/half-open. **Retry indefinitely**; child auto-resumes when dependency recovers (e.g. GitHub rate limit resets within the hour). **No terminal state, no operator required.**
  - **Terminal degraded (narrow — deterministic non-dependency only):** Only when the child crash is a **deterministic code defect** that every restart reproduces identically and is **not** an external dependency outage. Supervisor keeps running; child stays down until code fix + operator restart. **C4 (null OpenPrs) is fixed by null-safety** (child stops crashing), not by entering terminal.
- **Repeated-reason circuit breaker (dependency-agnostic):** When the **same degraded reason** repeats N times within a window, suppress further restarts and enter backoff — regardless of whether the reason mentions `gh`, fence errors, or a future dependency. Optional: enrich logging when the reason matches a known external dependency. **Do not** build per-dependency substring matchers as the primary mechanism.
- **Supervisor fault boundary (C5):** Each child's poll-cycle management (health read, recovery decision, stop, spawn, redirect I/O) is wrapped in a **catch → log → continue** boundary. **No unhandled exception from child management may exit the supervisor process.** Redirect `ObjectDisposedException` is one documented instance; `ChildEntry` null-deref and propagated child crash errors are others observed under the same storm. Redirect hardening (drain-before-dispose, isolated writers, etc.) is a **recommended subset** of this boundary, not the whole contract. **Does not claim to catch true `OutOfMemoryException`** (#442 mutual-recursion OOM remains #442).
- **Null-safe gh inventory:** Every supervised child that consumes open-PR inventory (`OpenPrs` or equivalent) must treat **null, empty, and lookup-failure** as a non-fatal tick outcome (log + degraded health), not a binding crash. Extends #205's empty-**collection** fix to **null** binding and to children added after #205 (notably `review-ready-report-state-seed`).
- **#447 coupling:** Ship order: **#450 before #447** (see Prerequisite). Production incident closure requires both.

**Operator adoption:** After merge, restart wake supervisor (`orchestrator-wake-supervisor.ps1 -Action Stop` then `-Action Start`). Under active `gh` rate-limit, confirm supervisor stays `running`, children backoff (not churn), and **auto-resume** when quota resets — without operator intervention.

## Contract evidence

Binding surface = supervisor recovery state-machine + fault boundary + gh-fed child null-binding (all pack-owned producers).

```contract-evidence
binding-id: orchestrator-pack:supervisor-recovery-degraded-backoff:backoff-engaged
binding-type: cli-behavior
binding: degraded-alive child restart respects backoff window (not every poll tick)
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:supervisor-recovery-auto-recovery:child-resumed
binding-type: cli-behavior
binding: dependency-driven degraded child auto-resumes after probe success without operator
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)

binding-id: orchestrator-pack:supervisor-fault-boundary:supervisor-alive
binding-type: cli-behavior
binding: unhandled child-management exception cannot exit supervisor process
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)

binding-id: orchestrator-pack:supervisor-child-openprs-null:degraded-not-crash
binding-type: cli-behavior
binding: gh-fed child tick survives null OpenPrs inventory input
producer: orchestrator-pack
evidence: NEW(produced-by AC#4)
```

## Files in scope

- `scripts/**` — supervisor loop, recovery/backoff helpers, child spawn I/O, gh-fed reconcile/seed children, fixtures/tests.
- `tests/**` — scenario-matrix fixtures (see Verification).

## Files out of scope

- `vendor/**`, `packages/core/**`, Composio AO core.
- `agent-orchestrator.yaml` (gitignored).
- #447 PATH prepend (separate issue; co-required for incident closure).
- #431 `scripts/gh` shim implementation (prerequisite transport for #447).
- #442 mutual-recursion OOM (true `OutOfMemoryException` from dual-wrapper PATH).

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
```

Scope boundary note: This denylist is scoped to `139-supervisor-crash-hardening-degraded-backoff-and-redirect-safety`.

```allowed-roots
scripts/**
tests/**
docs/**
```

## Acceptance criteria

### Scenario matrix (element 5 — class-not-case)

| # | Child failure mode | Dependency state | Recovery counter | Today | Desired (fixture required) |
|---|---|---|---|---|---|
| C1 | rapid-exit | any | rapidExits→backoff | backoff (covered #205) | keep — no regression |
| C2 | degraded-alive | transient blip | 0→1 | restart once, recovers | keep |
| C3 | **degraded-alive** | **persistently down** (rate limit, fence, auth, etc.) | **oscillates 0↔1** | **unbounded restart/tick; 34k+ `attempt 1/3`** | **capped exponential backoff + repeated-reason circuit breaker; probe/half-open; auto-recover when dependency heals — no terminal, no operator** |
| C4 | crash-on-launch (`OpenPrs` null) | dependency down | restart loop, same crash | binding error (#205 recurrence in `review-ready-report-state-seed`) | **null-safety:** null/empty inventory → degraded tick, no binding crash — **all gh-fed registry children** |
| C5 | C3/C4 churning | any | — | **no fault boundary** → unhandled exceptions exit supervisor (**Fact:** `ObjectDisposedException` `supervisor.log:~101435`; **Fact:** `ChildEntry` null; **Fact:** `FileLoadException` child exit ~89938) | **per-child fault boundary:** catch→log→continue; supervisor never exits; redirect race is one covered instance |
| C6 | session-id change | any | — | debounce+stagger+backoff (#205) | keep — no regression |
| C7 | deterministic non-dependency code crash | n/a (bug in child code) | every restart identical | not observed in incident | **terminal degraded** (narrow); supervisor alive; operator/code fix required — **not** used for C3/C4 |

Working copy: OS temp `supervisor-crash-scenario-matrix.md` (architect scratchpad); matrix above is authoritative for acceptance.

1. **C3 degraded backoff (unit/integration):** Fixture: child reports `degraded` for N consecutive polls while dependency failure persists. Supervisor must **not** emit more than one kill-restart per backoff window; **degraded recovery counter must not reset on a transient `working` blip** (planner picks field — `degradedBackoffUntilMs`, sticky counter, or equivalent).

```producer-emission
producer: orchestrator-pack
datum: supervisor-recovery-degraded-backoff
expected: backoff-engaged
proof-command: npm test -- supervisor-degraded-backoff
```

```positive-outcome
asserts: supervisor emits at most one degraded-path restart per configured backoff window under sustained child degraded health
input: realistic
```

2. **C3 auto-recovery:** Fixture: dependency failure clears after backoff window. Child **auto-resumes** (probe/half-open success) without operator intervention; supervisor and sibling children keep running throughout.

```producer-emission
producer: orchestrator-pack
datum: supervisor-recovery-auto-recovery
expected: child-resumed
proof-command: npm test -- supervisor-auto-recovery
```

3. **C5 fault boundary:** Fixture injects unhandled-exception paths observed under storm: redirect `ObjectDisposedException`, loop `ChildEntry` null-deref, and propagated child crash. Supervisor process remains alive after each; errors logged, poll continues.

```producer-emission
producer: orchestrator-pack
datum: supervisor-fault-boundary
expected: supervisor-alive
proof-command: npm test -- supervisor-fault-boundary
```

4. **C4 null OpenPrs (parameterized):** For each gh-fed registry child that accepts open-PR inventory, a tick with `OpenPrs = $null` and `OpenPrs = @()` completes without binding crash; health reports degraded or success-with-empty, not process exit.

Gh-fed children (inventory consumer — verification must cover each):

| Child id | Inventory entry point |
|---|---|
| `listener` | `Invoke-GhOpenPrList` / admission snapshot |
| `review-trigger-reconcile` | `Invoke-GhOpenPrList` → reconcile plan |
| `review-trigger-reeval` | `Invoke-GhOpenPrList` / scoped refresh |
| `review-ready-report-state-seed` | `githubSnapshot.openPrs` → `Get-ReviewReadyReportStateSeedTerminalClaimKeys` (**2026-06-24 crash site**) |
| `ci-green-wake-reconcile` | `Invoke-GhOpenPrList` |
| `review-send-reconcile` | `Invoke-GhOpenPrList` |
| `review-finding-delivery-confirm` | `Invoke-GhOpenPrList` |
| `ci-failure-notification-reconcile` | `Invoke-GhOpenPrList` |
| `ci-failure-notification-reaction` | `Invoke-GhOpenPrList` |

```producer-emission
producer: orchestrator-pack
datum: supervisor-child-openprs-null
expected: degraded-not-crash
proof-command: npm test -- supervisor-child-openprs-null
```

5. **No regression — #205 / #124 siblings:** Existing fixtures for rapid-exit backoff (C1), session-id stagger (C6), empty-collection `Get-GhChecksBundleByPr` (`scripts/gh-pr-checks-empty-openprs.test.ts`), and empty-pid Start/Status (#388) continue to pass unchanged.

6. **Repeated-reason circuit breaker (dependency-agnostic):** When the same degraded reason string repeats N times within a configured window, supervisor suppresses further restarts until backoff elapses (observable in log + state) — without requiring `gh`-specific substring matching.

7. **C7 terminal degraded (narrow):** Fixture: child with a deterministic non-dependency code defect (same stack trace every restart). After bounded attempts, child enters terminal degraded; supervisor keeps running. **Not** used for dependency outage (C3) or null-inventory (C4).

## Decisions (design analysis)

### Critical mechanics

- Recovery state-machine has **two paths**: not-alive (rapid-exit + crash backoff) vs alive-but-degraded (no backoff today).
- `Reset-OrchestratorWakeSupervisorChildRecoveryState` on transient `working` defeats escalation under churn.
- Supervisor has **no top-level fault firewall** — any unhandled exception from child management exits the whole process (three distinct paths observed in incident log).
- gh inventory flows through `Invoke-GhOpenPrList` / snapshot fields; **null ≠ empty collection** in PowerShell `[array]` binding.

### Industry practice

- **OTP / k8s CrashLoopBackoff:** exponential backoff with **indefinite retry** for transient/dependency failures; terminal only for unrecoverable local state.
- **Circuit breaker half-open probe:** pause → probe → resume when dependency healthy.
- **Supervisor fault isolation:** per-child `try/catch` around management actions (Erlang "let it crash" applies to **children**, not the supervisor).

### Architecture sketch

```
[supervisor poll]
    |
    v
+--- [FAULT BOUNDARY per child] ------------------+
|  [child health?]                                |
|    working (transient) --> do NOT reset degraded counter |
|    degraded/stalled --> [repeated-reason breaker]       |
|                              |                          |
|                              v                          |
|                    [backoff gate] --> [kill+spawn?]      |
|                              |                          |
|                    [probe/half-open when cooldown done] |
|                              |                          |
|                    dependency OK --> auto-resume (C3)   |
+---------------------------------------------------------+
    |
    v
[next child]   (any exception --> log + continue, never exit)
```

### Options (cost / risk / sufficiency)

| Option | Summary | Cost | Risk | Verdict |
|---|---|---|---|---|
| **A — Extend recovery state only** | Sticky degraded counter + backoff in `childRecovery` JSON | Low | High — no fault boundary (C5) | **Insufficient** |
| **B — A + fault boundary + redirect subset** | A plus per-child catch→log→continue; redirect hardening as subset | Medium | Low — closes C3+C5+C7 | **Chosen** |
| **C — External process manager** | systemd/supervisord per child | High | High — portability | Rejected |
| **D — Reference #205 only** | Amend closed issue | Low author cost | High — reopens merged AC | Rejected |

**Chosen: B.** Extends #205 machinery; fault boundary is the durable C5 invariant; redirect is one instance.

## Upgrade-safety check

- No AO core / vendor edits.
- No new secrets.
- Recovery/backoff env vars remain optional overrides with safe defaults.
- Fault boundary does **not** claim to handle true OOM (#442).
- Supervisor remains single entry point (`orchestrator-wake-supervisor.ps1`).

## Verification

```powershell
npm test -- supervisor-degraded-backoff supervisor-auto-recovery supervisor-fault-boundary supervisor-child-openprs-null
npm test -- orchestrator-wake-supervisor gh-pr-checks-empty-openprs
pwsh -NoProfile -File scripts/verify.ps1
```

Manual (operator): induce `gh` rate-limit or run degraded fixture; confirm supervisor stays `running`, log shows backoff (not thousands of `recovering (attempt 1/3)` per hour), and children **auto-resume** when quota resets.
