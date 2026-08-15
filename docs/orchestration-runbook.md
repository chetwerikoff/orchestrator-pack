# Orchestration runbook

This is the shared, model-neutral operating guide for supervised task creation and implementation in `orchestrator-pack`.

It exists so Claude, Codex, or another compliant executor follows the same lifecycle without relying on private model memory, historical Gists, local helper scripts, terminal layout, or a model-specific skill as the source of truth.

The live GitHub Issue remains the task specification. `AGENTS.md`, current repository policy, current GitHub state, the installed version-matched Orca orchestration guide, and the landed PACK runtime/lifecycle authorities remain authoritative where this runbook points to them.

## Read order

Before acting as an **orchestrator** or **manager**:

1. read live `AGENTS.md`;
2. read this runbook;
3. read the binding live Issue/task;
4. read current task-authoring/tiering policy when creating/refining an Issue;
5. when Orca is used, read the installed version-matched Orca orchestration guide;
6. read current assignment/runtime/PR/CI/review facts before effects.

Do not substitute remembered Claude behavior for tracked policy.

## Roles

### Orchestrator

The orchestrator is the top-level coordinator. It manages managers and workers, creates/binds Tasks and Dispatches, reads authoritative state, resolves ambiguity/recovery/reassignment/termination decisions, and invokes architect/operator reasoning only when deterministic policy cannot choose safely.

### Manager

A manager is a cheap process agent that owns creation/refinement of a development task.

```text
understand user goal / tier / prerequisites
-> create or revise Issue
-> read back current published Issue revision
-> run required independent task review(s)
-> findings -> author/fix -> read back new revision -> rerun invalidated review(s)
-> run required architectural lens
-> lens finding/change -> author/fix -> rerun invalidated gates
-> prove CURRENT Issue revision passed all required gates
-> task_ready
-> worker_done
```

Child author/reviewer/lens completion never settles the parent manager Task. Managers do not supervise coding workers.

### Worker

A worker implements an already-created Issue.

```text
read live Issue/rules/prerequisites
-> implement scoped work
-> run required local verification
-> create/update PR and exact head
-> fix required pre-review CI for that head
-> publish truthful ready_for_review handoff
-> verify no known worker-owned pre-review blocker remains
-> worker_done
```

Independent review and smoke occur after this bounded handoff. Later review/smoke findings create a fresh correction Task/Dispatch.

### Reconciler

The reconciler is deterministic policy/code used by the orchestrator. It is not an agent role.

```text
noop
continue
orchestrator_required
```

`continue` is policy over the existing S2 fleet-nudge path, not a new sender. The reconciler never emits `worker_done` and never owns live-attempt termination.

### Architect

The architect is an expensive one-shot reasoning role for genuine architecture/specification decisions. It is not a monitor, scheduler, retry service, or normal recovery layer.

## Binding supervision architecture

Do not rebuild mechanisms that already exist.

### S1 — observation

Runtime-neutral observation is owned by:

```text
scripts/pr2-foundation/fleet-observer.ts
```

S1 owns `busy | livelock | idle | exempt | unknown` classification.

- `busy` requires positive new bounded output after a trusted baseline;
- `idle` requires positive current-generation liveness=`idle` plus valid bounded output and no higher-precedence unknown/exemption condition;
- busy liveness without positive output is no-progress evidence, not healthy progress;
- failed, missing, timed-out, stale, contradictory or wrong-generation evidence is `unknown`, never `idle`;
- process/pane/spinner/heartbeat existence alone proves neither progress nor completion.

Do not add a second pane debounce or another idle detector beside S1.

### S1 continuity across bounded scheduler children

Production cadence is a sequence of short-lived `scheduler.ts tick` children owned by the TypeScript side-process supervisor. A normal cadence child exit is **not** a supervision-lineage restart.

Therefore the S1 `schedulerGeneration` must represent the current trusted supervision lineage/activation epoch, not one OS child process. Separate cadence children under the same valid activation epoch reuse the same accepted `schedulerGeneration` and monotonically advancing tick sequence. A real activation-epoch change, invalid/corrupt continuity state, or explicit lineage reset creates a fresh generation and fresh baselines.

This intentionally supersedes the old assumption that every scheduler-process exit resets S1. The old assumption was valid for a resident scheduler process; it is not valid for the current supervisor topology where process exit is the normal cadence boundary.

S1 must reconstruct only the **minimum persistence-safe continuity** required for the next bounded child. Reuse the existing S1 atomic snapshot authority rather than adding a second observer store.

Allowed continuity data is bounded and runtime-neutral, for example:

- current supervision/activation lineage identifier and `schedulerGeneration`;
- monotonically advancing `tickSequence`;
- stable `unitRef` mapping keyed by the current PACK assignment identity/generation when available;
- prior S1 class and livelock streak;
- `hasBaseline`;
- a bounded digest of the prior bounded-output bytes needed only for cross-process positive-change comparison.

Do **not** persist raw `RuntimeWorkerIdentity`, raw runtime id/generation, `RuntimeObservationToken`, terminal output, prompts, replies, workspace paths, titles, PIDs or adapter-private fields.

At each child start, re-read the current assignment authority and current RuntimeAdapter workers. Reconstruct a unit only when the current assignment and exact in-memory RuntimeWorkerIdentity still agree. Missing, stale, ambiguous or generation-mismatched assignment/runtime evidence cannot restore continuity and cannot authorize S2.

For units with no authoritative assignment correspondence, S1 may still publish safe observer evidence, but cross-process continuity must fail closed rather than guessing identity from title/path/order.

A persisted output digest is observation evidence only. Digest difference can establish positive bounded-output movement; equality is not proof of health or completion. Unknown/missing digest state is a fresh baseline and cannot fabricate progress/livelock history.

### #1416 owns live assignment/runtime binding

The authoritative producer for current logical assignment generation and local exact RuntimeAdapter identity is the `WorkerAssignment` boundary owned by Issue #1416 / #1412.

#1420 must **not** resurrect PR/session heuristics, branch matching, pane titles or a second assignment store to make S2 live.

Until the minimum #1416 assignment/runtime binding has landed and #1420 names the exact landed API/commit:

- production S2 target resolution remains fail-closed `target_unresolved`;
- no claim/journal/send attempt is admitted for unresolved targets;
- unit tests with fixtures do not prove live production binding;
- #1420 may advance documentation and fail-closed integration work, but it may not claim live routine continuation or `task_ready` completion.

After #1416 lands, same-tick binding is:

```text
current WorkerAssignment generation
+ current local RuntimeAdapter identity
+ current S1 in-memory unit
-> exact resolved S2 target
```

Raw runtime identity remains in memory for the effect and is not written to S1/S2 persistence-safe records.

If the landed #1416 assignment model does not cover a supervised role such as a task-authoring manager, that role is not silently guessed into S2. Its routine effect remains fail-closed and is surfaced to the orchestrator until a single authoritative role-aware assignment boundary exists.

### S2 — one-shot continuation

Bounded continuation is owned by:

```text
scripts/pr2-foundation/fleet-nudge-actuator.ts
```

with:

```text
scripts/pr2-foundation/worker-nudge-claim-store.ts
scripts/pr2-foundation/worker-nudge-gate.ts
scripts/pr2-foundation/worker-dispatch-journal.ts
```

S2 already owns:

- `S2_ONE_SHOT_POLICY = 's2-one-shot-v1'`;
- bounded idle/livelock continuation messages;
- one attempt per new eligible S1 class-change episode;
- `not_new_episode` suppression;
- exact episode/epoch fencing;
- effect budgets;
- claim/gate/journal accounting;
- `dispatched | send_failed | dispatch_unknown` outcomes.

The runbook's `continue` rules specify policy over S2. They do not authorize a second continuation sender, claim store, journal, ACK path, retry loop, or watchdog.

### Initial supervised task delivery is Orca-owned

Initial Task/Dispatch startup is different from S2 continuation.

Preferred path:

```text
orca orchestration worker-start --task <task_id> ... --json
```

For supported custom topology/argv:

```text
orca orchestration dispatch --task <task_id> --to <agent_handle> --inject --json
```

Do not deliver a supervised Task by keyboard/paste `terminal send --enter`.

Read the structured `worker-start` receipt. `ready`, `stage`, `effects`, setup state and `residualResources` are the authority for what startup proved. Failed/unknown start is diagnosed from the receipt and is never blindly retried.

### Routine S2 continuation keeps RuntimeAdapter

Do not migrate routine S2 continuation to Orca inbox mail in this contract. S2 keeps the existing runtime-neutral RuntimeAdapter dispatch seam.

The existing S2 claim store and dispatch journal are the one-shot/accounting authority. The no-new-ACK rule prohibits a parallel acknowledgement/delivery/retry system; it does not delete the existing S2 accounting path.

Interpret outcomes truthfully:

- `dispatched` — RuntimeAdapter reports dispatched; it is not semantic proof that the model completed the work;
- `send_failed` — definitive send failure;
- `dispatch_unknown` — uncertain dispatch; preserve uncertainty and do not automatically resend.

Orca Dispatch-addressed mail remains a separate explicit coordinator tool. Do not dual-send one routine continuation through both paths.

## Scheduler phases and ownership

### Phase 1 — fleet supervision

```text
fleetObserver.tick(...)
-> deterministic role/task reconciliation
-> fleetNudgeActuator.tick(...)
-> durable reconciliation handoff when orchestrator reasoning is required
```

Manager/worker routine reconciliation belongs here.

### Phase 2 — review start

The later review-start phase uses `liveCandidates()`, which intentionally selects only `ready_for_review` workers with a PR binding and exact head.

Do not widen `liveCandidates()` to managers or pre-handoff workers. Review-start remains a separate exact-head actuation path.

### Production cadence / activation owner

Production side-process ownership is:

```text
scripts/lib/orchestrator-side-process-supervisor.ts::runSupervisor
```

with registered child:

```text
pr2-scheduler -> pr2-foundation/scheduler.ts
```

The supervisor launches bounded `scheduler.ts tick` children and applies the registered cadence between them. `scheduler.ts::runLoop()` is not production activation proof.

Activation remains epoch/registry gated. Do not add another launcher, daemon, timer, watcher or watchdog.

Operator-machine activation/read-back is an operator-adoption step. Until a post-adoption read-back proves a supervisor-owned tick under the current epoch, report repository implementation truthfully but do not claim live supervision is active on that machine.

## Durable `orchestrator_required` handoff

Current `main` has no named durable producer/consumer surface for the logical `orchestrator_required` decision. Scheduler stdout is insufficient because the bounded child exits and successful stdout is not an orchestrator-consumed durable authority.

Use the smallest explicit carrier rather than pretending an existing path exists:

```text
fleet-reconciliation-handoff/v1
```

The implementation should use one bounded atomic **latest-state** artifact under the existing orchestrator-pack local state root. It is evidence delivery, not a queue, mailbox, retry system, claim store, acknowledgement protocol or lifecycle authority.

The handoff contains only persistence-safe facts needed to re-read the unresolved case, for example:

- schema/version;
- project/repository identity;
- `schedulerGeneration` + `tickSequence` + activation-lineage binding;
- decision exactly `orchestrator_required`;
- closed reason code;
- role (`manager | worker`) when known;
- Task/Issue/Dispatch/assignment generation identifiers when authoritative and persistence-safe;
- timestamp/digest/size bounds needed for read-back integrity.

It must never contain raw RuntimeWorkerIdentity, observation tokens, terminal output, prompts/replies, credentials or adapter-private data.

Producer: scheduler fleet/reconciliation phase after authoritative classification.

Consumer: top-level orchestrator/operator checkpoint. The runbook requires the orchestrator to read this latest handoff when supervising the repository and before treating silence as healthy.

The carrier uses atomic replace and a strict size/row bound. It carries no resend or exactly-once semantics. A later safe tick may replace an earlier latest-state record.

If a tick must publish `orchestrator_required` but cannot atomically commit/read back the handoff, the tick must not return a silent success. It exits/fails with a bounded reason so the existing TypeScript side-process supervisor records a non-success/refusal diagnostic in its existing status surface. Do not fall back to AO wake compatibility or another notification transport.

## Existing mutation constraints

When editing `scripts/pr2-foundation/scheduler.ts`, preserve landed mutation-semantic gate invariants, including the required dormant literals around:

- `running: false`;
- `activationEpochEnforced: false`;
- `buildDormantScheduler` remaining free of direct `process.env` activation.

The current side-process registry and activation registry projection pin the `pr2-scheduler` child shape. Reuse them. Do not weaken mutation gates to pass CI.

## Core operating laws

### 1. Watch objective state, not worker prose

Use current Issue/task, assignment generation, S1 state, S2 episode/outcome, PR/head, CI/review/smoke and accepted report facts. Worker prose is context, not sole lifecycle authority.

### 2. `worker_done` means whole-role completion

`worker_done` is terminal for the assigned Task/Dispatch attempt. It is not end-of-turn, one substep, helper failure, waiting, question, escalation or timer expiry.

Before success, re-read the Task and verify every applicable role-owned completion criterion. Failed outcome is reserved for a genuinely terminal failed/aborted Task after allowed recovery/coordination is exhausted.

### 3. One LLM turn is not one Dispatch

Keep the same Dispatch across recoverable substeps, prompt returns, child waits, questions/escalations and ordinary continuation. Create a fresh Dispatch only for a real Task/subtask/reviewer/correction/reassignment/retry boundary.

### 4. Re-read before retry

Timeout/helper loss does not prove failure. Read authoritative state first; retry only when evidence proves the operation did not already succeed and retry is safe.

### 5. Helper failure is recovery first

Inspect the real error and use the shortest legitimate supported fallback. Escalate only for missing capability/permission, ownership/spec conflict, destructive choice or exhausted recovery. `ask`/`escalation` leaves unfinished Dispatch active.

### 6. External waits are non-blocking

CI/review/browser/child waits are lifecycle state plus future re-checks. Do not hold orchestrator/reconciler in foreground sleep/poll loops.

### 7. Exact identity before effects

Never authorize effects from terminal title, branch, path, PID alone, display name, first matching pane or stale handle.

### 8. At most one active attempt per exact stage artifact

Typical keys:

```text
Task author/review/lens: {Task, Issue revision, stage}
implementation/review/smoke: {Task, PR, exact head, stage}
```

Retry/reassignment requires prior attempt terminal/lost/replaced evidence.

### 9. Stage opens on producer handoff, not proxy state

CI green, process idle or PR existence alone does not open review. Reviewers re-read exact head/revision and refuse stale/moved artifacts.

### 10. Child results need authoritative delivery

Conversation-only output is non-delivery when the Task requires GitHub or another durable surface.

### 11. Prompt address space must be valid

Every prompt reference must be readable by the receiving executor. Carrier/artifact-class mismatch is rejected before substantive work.

### 12. Preserve failure evidence

Do not destroy the only pane/page/output/workspace witness before orchestrator read-back.

### 13. Recovery code does not own termination

Observer/reconciler/nudge/helper/smoke recovery code cannot kill/remove a live attempt merely because an outcome is non-ok. Termination/replacement is orchestrator/operator authority.

### 14. Alarm quality matters

Use designated authority, scope to current repo/task and filter supervisor self-echo. False alarms are operational defects.

## Deterministic reconciliation policy

```text
authoritative role/task/assignment facts
+ trusted cross-process S1 continuity
-> reconcile
-> noop | continue | orchestrator_required
```

- `noop` -> no S2 effect;
- `continue` -> permit existing S2 admission/revalidation/one-shot path for the exact eligible episode;
- `orchestrator_required` -> suppress routine S2 and durably publish the bounded latest-state handoff described above.

Representative cases:

| Facts | Decision |
|---|---|
| active/new progress | `noop` |
| trusted S1 idle/livelock + exact current #1416 binding + role-owned work remains | `continue` via S2 |
| full manager completion contract satisfied | `noop` (manager may complete) |
| truthful worker current-head `ready_for_review` with no worker-owned action left | `noop` (worker may complete) |
| missing/ambiguous assignment, unobservable stage, unresolved target, unsafe recovery choice | `orchestrator_required` |

Do not resend `dispatch_unknown` or reimplement `not_new_episode` outside S2.

## Manager operating procedure

Read the full Task, prerequisites and tier policy. Plan the whole author/review/fix/lens flow. Read back every Issue revision. Re-run invalidated gates after findings. Report `task_ready` and parent `worker_done` only for the current published revision after all required gates and authoritative child-result publications are satisfied.

## Worker operating procedure

Read live Issue/rules/prerequisites and exact current assignment. Implement scoped work, verify locally, create/update PR, fix worker-owned pre-review CI, publish truthful current-head `ready_for_review`, verify no worker-owned pre-review blocker remains, then `worker_done`.

## Review, CI, smoke and readiness

Keep these separate:

- CI is exact-head evidence, not completion;
- review is exact-head evidence;
- smoke is task-defined exact-head/effect evidence;
- `ready_for_review` is worker handoff;
- merge readiness is derived from authoritative current facts;
- merge remains operator-only unless directly ordered.

Failure, timeout, cancellation, ambiguity or missing evidence never becomes success.

## Orca `worker_done` wording

At implementation time inspect the installed/version-matched Orca guide and injected preamble.

- If whole-Task semantics are already explicit, record exact version/commit and make no gratuitous upstream change.
- If end-of-turn/ambiguous wording remains, use a linked upstream guide+preamble+focused-tests change.
- Do not hardcode PACK manager/worker stage lists into Orca core.

## Model-neutral documentation authority

This runbook is the shared authority once landed. `AGENTS.md` must require orchestrator/manager executors to read it.

Do not create a Codex-specific fork. `CLAUDE.md`/`.claude/**` may contain Claude-specific invocation details and pointers, but no unique shared lifecycle/task-authoring rule.

Historical Claude memory/Gists are migration input only.

## Production composition proof

Same-process tests are insufficient for the supervisor topology.

The implementation must include an integration harness that invokes **separate Node child processes** through the same `scheduler.ts tick` entrypoint and the same durable state paths used by production. A deterministic RuntimeAdapter/assignment fixture is allowed, but the S1 snapshot/handoff must cross real process boundaries.

Minimum positive sequence:

```text
child N
  -> establish trusted S1 baseline/continuity
  -> exit
child N+1
  -> recover same supervision lineage + unit correspondence
  -> observe eligible idle/class change (or continue livelock streak)
  -> reconcile exact current assignment
  -> permit existing S2
  -> one S2 attempt settles
  -> exit
child N+2
  -> recover continuity
  -> same episode does not become a duplicate continuation
```

For livelock, configure a small positive `livelockTicks` in the fixture and use enough **separate child processes** to cross it. Do not replace this with repeated calls inside one process.

Negative companions:

- activation epoch changes -> fresh `schedulerGeneration`, no restored episode;
- assignment generation changes/stales -> no effect;
- runtime identity mismatches current assignment -> no effect;
- continuity snapshot corrupt/missing -> fresh/unknown fail-closed state;
- S2 `dispatch_unknown` survives as uncertain and causes no alternate transport/retry;
- required `orchestrator_required` handoff survives child exit and is readable afterward;
- handoff commit/read-back failure makes the scheduler tick non-success so supervisor status records failure.

A repository/unit test that injects one in-memory `FleetObserver` into repeated `runSchedulerTick()` calls does not satisfy this production-composition proof.

## Local legacy cleanup

Old Claude orchestration helpers discussed in the historical memory are local/untracked. They are not repository deletion scope.

After the final runbook/implementation is adopted, the local orchestrator/operator should inventory local helper scripts/state/autostart hooks as `keep | replace | delete`, remove superseded keyboard/paste/watchdog/retry/ack/global-nudge machinery, and verify normal orchestration without them. Do not add untracked local files to git merely to delete them.
