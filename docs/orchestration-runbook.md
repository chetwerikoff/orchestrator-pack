# Orchestration runbook

This is the shared, model-neutral operating guide for supervised task creation and implementation in `orchestrator-pack`. Claude, Codex, or another compliant executor uses the same lifecycle; model-private memory, historical Gists, terminal layout and local helper scripts are not lifecycle authority.

The live GitHub Issue remains the task specification. `AGENTS.md`, current repository state, current GitHub state, the installed version-matched Orca orchestration guide, and the landed PACK runtime/lifecycle authorities remain authoritative where this runbook points to them.

## Mandatory read order

Before acting as an **orchestrator** or **manager**:

1. read live `AGENTS.md`;
2. read this runbook;
3. read the binding live Issue/task;
4. read task-authoring/tiering policy when creating or revising an Issue;
5. when Orca is involved, read the installed version-matched Orca orchestration guide;
6. re-read current assignment/runtime/PR/CI/review facts immediately before effects.

## Roles and completion

### Orchestrator

The orchestrator is the top-level coordinator. It owns ambiguity, recovery, reassignment, termination, and architect/operator escalation. It observes authoritative state and does not infer completion from worker prose or terminal appearance.

### Manager

A manager owns the complete task-authoring workflow:

```text
understand goal / tier / prerequisites
-> create or revise Issue
-> read back current Issue revision
-> required independent review
-> findings -> fix -> read back -> rerun invalidated review
-> architectural lens
-> lens finding/change -> fix -> rerun invalidated gates
-> prove CURRENT revision passed applicable gates
-> task_ready
-> worker_done
```

Child author/reviewer/lens `worker_done` never settles the parent manager Task. A single LLM turn is never a Dispatch.

### Worker

A worker owns the bounded implementation workflow:

```text
read live Issue/rules
-> implement scoped work
-> required local verification
-> create/update PR and exact head
-> worker-owned pre-review CI
-> truthful current-head ready_for_review
-> verify no known worker-owned pre-review blocker remains
-> worker_done
```

Independent review and smoke happen after this bounded handoff. A later finding opens a fresh correction Dispatch.

### Reconciler

The reconciler is deterministic policy/code and returns only:

```text
noop | continue | orchestrator_required
```

It never sends `worker_done`, never terminates a live attempt, and never becomes a second sender.

### Architect

The architect is an expensive one-shot architecture/specification role, not a fleet monitor, scheduler, retry service, or recovery daemon.

## Executor profiles by role, tier, and smoke complexity

Executor selection for new manager/worker work and smoke work is a stable work-class-to-profile rule. It does not change tier classification, WorkerAssignment, RuntimeAdapter, browser-chat lifecycle, scheduler, recovery, review, or smoke authorities.

Immediately before starting new work, resolve exactly one executor profile from the work class:

```text
manager work         -> manager executor profile
T1 worker            -> T1 executor profile
T2 worker            -> T2 executor profile
T3 worker            -> T3 executor profile
routine smoke work   -> routine-smoke executor profile
complex smoke work   -> complex-smoke executor profile
```

Each profile has operator-local `agent`, `model`, and `effort` values under stable names:

```text
PACK_EXECUTOR_MANAGER_AGENT
PACK_EXECUTOR_MANAGER_MODEL
PACK_EXECUTOR_MANAGER_EFFORT

PACK_EXECUTOR_T1_AGENT
PACK_EXECUTOR_T1_MODEL
PACK_EXECUTOR_T1_EFFORT

PACK_EXECUTOR_T2_AGENT
PACK_EXECUTOR_T2_MODEL
PACK_EXECUTOR_T2_EFFORT

PACK_EXECUTOR_T3_AGENT
PACK_EXECUTOR_T3_MODEL
PACK_EXECUTOR_T3_EFFORT

PACK_EXECUTOR_SMOKE_ROUTINE_AGENT
PACK_EXECUTOR_SMOKE_ROUTINE_MODEL
PACK_EXECUTOR_SMOKE_ROUTINE_EFFORT

PACK_EXECUTOR_SMOKE_COMPLEX_AGENT
PACK_EXECUTOR_SMOKE_COMPLEX_MODEL
PACK_EXECUTOR_SMOKE_COMPLEX_EFFORT
```

The variable names and work-class-to-profile mapping are tracked policy. Their concrete values are machine/operator-local configuration and must not be committed as repository defaults. Resolve the current local values immediately before starting new work. Changing an `agent`, `model`, or `effort` value applies to subsequent work and does not require a repository Issue or PR; changing the stable mapping or variable contract does.

`agent` selects the already-supported invocation path. Cursor uses the existing local Cursor/Orca launch path and passes the configured model/effort. GPT uses the existing chat/Browser-GPT path, including for implementation workers. Smoke complexity selects only between the routine-smoke and complex-smoke executor profiles; it does not create a task tier or change smoke admission, evidence, ownership, or lifecycle rules.

This profile rule does not add a runtime selector, WorkerAssignment type, provider registry, scheduler, service, store, queue, daemon, fallback transport, or retry mechanism.

Current operator-local example only — these are not repository defaults:

```text
manager       -> Cursor / Luna / low
T1 worker     -> Cursor / Luna / medium
T2 worker     -> Cursor / Luna / high
T3 worker     -> GPT through chat
routine smoke -> Cursor / Luna / medium
complex smoke -> Cursor / Luna / high
```

For example, switching the local T3 profile from GPT to Cursor makes subsequent T3 work use the existing Cursor/Orca path without a tracked policy edit. Smoke works the same way: routine versus complex selects the corresponding local smoke profile, whose values can be changed locally without editing tracked policy.

## Supervised initial delivery and WorkerAssignment

Initial supervised Task delivery remains Orca-owned. Use the PACK supervised-start boundary through the canonical TypeScript launcher:

```text
node --experimental-strip-types scripts/lib/Invoke-TypeScriptCli.ts \
  --script scripts/pr2-foundation/supervised-worker-start.ts -- \
  --issue-number <N> \
  --repository <owner/repo> \
  -- \
  --task <task_id> <worker-start options>
```

The wrapper calls supported Orca `orchestration worker-start` with structured JSON output. It publishes a current local WorkerAssignment only after Orca returns a proven `ready` receipt with both `taskId` and `dispatchId`. Failed, malformed, or outcome-unknown startup does not create a successful assignment.

The minimum current assignment authority is:

```text
scripts/lib/worker-assignment-store.ts
```

A durable assignment contains only persistence-safe logical facts: project/repository, Issue, Task, assignment id, monotonically advancing assignment generation, `kind`, `provider`, provider lifecycle `bindingKey`, and timestamp. For current local Orca workers the binding key is the Orca **Dispatch id**.

It must never contain raw `RuntimeWorkerIdentity`, runtime id/generation, terminal handle, `RuntimeObservationToken`, output, prompt/reply, workspace path, title, PID, or adapter-private fields.

This minimum authority lands in #1420 so production supervision does not wait for the rest of #1416. #1416 remains the owner of the broader local/remote WorkerReport/WorkerStatus lifecycle, remote ownership, ownership switching/history and associated semantics. It must consume/extend this assignment authority rather than introduce another store.

## Exact local runtime binding

Runtime effects remain behind `RuntimeAdapter`.

For Orca, the assignment `dispatchId` is resolved through the adapter's `resolveAssignmentWorker` seam. The Orca adapter calls `orchestration worker-show --dispatch <dispatchId>`, requires Orca's exact-worker observation, and only then resolves the current terminal to an exact adapter-produced `RuntimeWorkerIdentity` **in memory**.

The effect mapping is therefore:

```text
current WorkerAssignment generation
+ provider lifecycle binding (Orca Dispatch id)
+ current RuntimeAdapter exact-worker resolution
+ current S1 unit
-> exact S2 target
```

Missing, stale, ambiguous, remote/not-applicable, unsupported, or mismatched evidence is fail-closed and performs no routine effect. Never replace this with PR/session/title/path/pane/PID heuristics.

## S1 — single observation authority

Observation is owned by:

```text
scripts/pr2-foundation/fleet-observer.ts
```

S1 owns `busy | livelock | idle | exempt | unknown`.

- `busy` requires positive bounded-output movement after a trusted baseline;
- `idle` requires current exact liveness=`idle` plus valid bounded output;
- busy liveness without positive output is no-progress evidence, not healthy progress;
- failed, timed-out, stale, contradictory, unsupported or wrong-generation evidence is `unknown`;
- process/pane/spinner/heartbeat existence alone is not progress or completion evidence.

Do not add a second observer, pane debounce, idle detector, or resident monitor.

## S1 continuity across bounded scheduler children

Production cadence remains:

```text
runSupervisor
-> spawn scheduler.ts tick child
-> child exits
-> registered cadence
-> spawn next scheduler.ts tick child
```

Normal cadence-child exit is not a supervision-lineage restart. In production, `schedulerGeneration` belongs to the trusted activation lineage, not the OS process lifetime.

The current activation epoch is reduced to a persistence-safe activation-lineage digest. When the existing atomic S1 snapshot contains the same accepted lineage, the next child reuses its `schedulerGeneration` and advances `tickSequence`. A real epoch change, corrupt/untrusted continuity, or explicit reset starts a fresh generation/baseline.

The existing S1 snapshot remains the only observer persistence authority. Its bounded continuity extension may persist only:

- activation lineage digest;
- `schedulerGeneration` and `tickSequence`;
- assignment id/generation -> stable `unitRef` correspondence;
- previous S1 class;
- livelock streak;
- `hasBaseline`;
- SHA-256 digest of prior bounded-output bytes.

Raw runtime identity/token/output never enters the snapshot. On every child, current assignments and current RuntimeAdapter workers are re-read. Continuity is restored only when the current assignment generation resolves to the current exact in-memory runtime identity. Otherwise the unit is fresh/fail-closed.

Digest difference is positive movement evidence. Digest equality alone is not proof of health or completion.

## S2 — single routine continuation actuator

Routine continuation is owned by:

```text
scripts/pr2-foundation/fleet-nudge-actuator.ts
```

with the existing authorities:

```text
worker-nudge-claim-store.ts
worker-nudge-gate.ts
worker-dispatch-journal.ts
```

Preserve:

- `s2-one-shot-v1`;
- only a new eligible `idle`/`livelock` class-change episode may start an attempt;
- `not_new_episode` suppression;
- exact episode/epoch fencing;
- budgets;
- claim/gate/journal accounting;
- `dispatched | send_failed | dispatch_unknown` outcomes.

Routine S2 dispatch stays on RuntimeAdapter. Initial delivery stays Orca-owned. Do not dual-send through Orca mail or another transport. `dispatch_unknown` is uncertain and never authorizes automatic resend or an alternate transport.

## Scheduler phases

`runSchedulerTick` remains two phases.

### Phase 1 — fleet supervision

```text
S1 observation
-> deterministic reconciliation
-> existing S2 when exactly admitted
-> durable orchestrator_required handoff when reasoning is required
```

### Phase 2 — review start

The existing `liveCandidates()` path remains limited to `ready_for_review` workers with PR/head binding. Do not widen it to managers or pre-handoff workers.

The registered production owner remains `scripts/lib/orchestrator-side-process-supervisor.ts::runSupervisor` with the existing `pr2-scheduler` child. Do not replace bounded `scheduler.ts tick` children with `runLoop()`, another daemon, timer, watcher, or watchdog.

## Durable `orchestrator_required` handoff

The named carrier is:

```text
fleet-reconciliation-handoff/v1
```

Implementation:

```text
scripts/pr2-foundation/fleet-reconciliation-handoff.ts
```

It is one bounded atomic **latest-state** artifact under the PACK local state root. It is evidence delivery only, not a queue, mailbox, retry system, ACK protocol, lease, claim, dedup store, or lifecycle authority.

Safe fields include project/repository, activation lineage, `schedulerGeneration`, `tickSequence`, decision, closed reason code, role and persistence-safe Task/Issue/assignment identifiers when known, timestamp and integrity digest.

Forbidden fields include raw runtime identity/token, terminal output, prompt/reply, credentials and adapter-private data.

The scheduler must atomically commit and read back a required handoff. If this fails, the scheduler tick is non-success so the existing supervisor status exposes the failure. There is no fallback notification transport.

The top-level orchestrator/operator reads the latest handoff before treating fleet silence as healthy.

## Deterministic reconciliation

```text
authoritative Task/role/assignment facts
+ trusted S1 continuity
-> noop | continue | orchestrator_required
```

- active/new progress -> `noop`;
- trusted new idle/livelock episode + exact current local assignment/runtime binding + role-owned work remains -> `continue` through existing S2;
- unresolved/stale/ambiguous target, untrusted observer/assignment state, unsupported local effect, or uncertain dispatch requiring reasoning -> `orchestrator_required` plus durable handoff;
- manager whole-role completion or worker truthful `ready_for_review` handoff -> `noop`, then that role may complete according to its own contract.

## Core operating laws

1. Watch objective state: live Issue/Task, assignment generation, S1, S2, PR/head, CI/review/smoke and accepted reports. Worker prose is context only.
2. `worker_done` is whole Task/Dispatch completion, never end-of-turn, substep, wait, helper failure, question, escalation or timer expiry.
3. Keep one Dispatch across recoverable substeps. Create a fresh Dispatch only for a real Task/subtask/reviewer/correction/reassignment/retry boundary.
4. Re-read authoritative state before retry. Timeout or helper loss does not prove the operation failed.
5. Helper failure is recovery first. Escalate only for missing capability/permission, ownership/spec conflict, destructive choice, or exhausted legitimate recovery.
6. External waits are non-blocking lifecycle state; do not hold the orchestrator foreground in sleep/poll loops.
7. Exact identity before effects. Never authorize effects from display name, terminal title, branch, path, PID, stale handle, or first match.
8. At most one active attempt per exact stage artifact. Retry/reassignment requires prior attempt terminal/lost/replaced evidence.
9. Downstream stages open on authoritative producer handoff, not PR existence, CI green, idle state, or another proxy.
10. Child results must reach the Task's named authoritative delivery surface; conversation-only output is non-delivery when a durable carrier is required.
11. Prompt references must be resolvable in the receiver's address space and use the correct carrier class.
12. Preserve failure diagnostics until orchestrator read-back.
13. Observer/reconciler/nudge/recovery code does not own termination of a live attempt.
14. Alarms must use designated authority, current repository/task scope and self-echo filtering.

## Production verification

### Browser-GPT modal capability

Before starting Browser-GPT work, the orchestrator must verify that the
pack-owned rate-limit modal capability is running against the configured
automation browser. Verification is a capability check: its startup/attached
page evidence must be visible, and a recent scan must be observable; a shell
PID, an old log line, or a waiting turn alone is not proof. If the capability
is absent, start the repository's documented modal-watcher entrypoint with the
same browser debugging endpoint, then re-check its startup and page-attachment
evidence before launching or retrying browser turns. Stop it only through its
documented signal path, which releases its own CDP sockets and no other tabs.

This is a browser-page overlay watcher, not an agent observer, idle detector,
terminal monitor, scheduler, retry service, or send authority. The modal is
usually an ordinary `div` without `role="dialog"`; detection therefore uses
short rendered text matching the known temporary-limit messages plus an exact
`Got it` or `OK` button. While it remains visible, the composer is unavailable,
so browser turns sit in `waiting` with `last_reply_length: 0`, which looks in
logs like profile overload; five managers were blocked this way before the
operator inspected the screen. Dismissing the overlay does not clear the
server-side limit or prove delivery: preserve Browser-GPT `send_count`
semantics (`0` may be repeated safely; `1` or more requires harvesting and
must not be resent).

For #1420, same-process component tests are supplementary. Production composition must include real separate Node processes invoking `scheduler.ts tick` against shared production-equivalent state paths and prove at least:

- child N creates trusted baseline;
- child N+1 restores the same activation lineage/generation and advances tick sequence;
- enough separate children cross a positive livelock threshold;
- exact current assignment + exact RuntimeAdapter identity admits one existing S2 continuation;
- later children do not duplicate the same episode;
- epoch change starts a fresh generation/baseline;
- stale/unresolved identity and `dispatch_unknown` remain fail-closed;
- a required handoff remains readable after the producer child exits;
- handoff commit/read-back failure makes the tick non-success.

Also run current-head repository verification, Node 22 typecheck/lint, affected tests, scope guard, runtime-retirement scan, required CI and current-revision review/lens obligations.

## Orca grounding

At #1420 r14 implementation time, the Orca orchestration guide already defines `worker_done` as completion of the active Dispatch/Task rather than completion of one conversational turn, and the supported initial supervised startup path is `worker-start` / `dispatch --inject`. Therefore PACK does not patch Orca core or hardcode PACK role stages upstream.

Repository evidence used during implementation: Orca orchestration guide blob `d43a59d7b33e50126efb268184c1a1af38dd4f8a`. The operator must still use/read the installed version-matched guide on the target machine; this repository evidence is not a claim about the installed machine version.

## Operator adoption

Repository merge does not prove machine activation.

After landing the production implementation:

1. adopt the merged PACK revision through the existing supported operator deployment path;
2. preserve the registered side-process supervisor and `pr2-scheduler` child shape;
3. start supervised workers through the PACK supervised-worker-start boundary so current assignments are published from successful Orca receipts;
4. verify a supervisor-owned `scheduler.ts tick` under the current activation epoch;
5. verify later bounded children retain the same trusted S1 lineage and advancing tick sequence;
6. verify the latest `fleet-reconciliation-handoff/v1` is readable before treating silence as healthy.

Do not claim live machine supervision before this read-back.