# Orchestration runbook

This is the shared, model-neutral operating guide for supervised task creation and implementation in `orchestrator-pack`.

It exists so Claude, Codex, or another compliant executor follows the same lifecycle without relying on private model memory, historical Gists, local helper scripts, terminal layout, or a model-specific skill as the source of truth.

The live GitHub Issue remains the task specification. `AGENTS.md`, current repository policy, current GitHub state, the installed version-matched Orca orchestration guide, and the landed S1/S2 runtime contracts remain authoritative where this runbook points to them.

## Read order

Before acting as an **orchestrator** or **manager**:

1. read live `AGENTS.md`;
2. read this runbook;
3. read the binding live Issue/task;
4. read the current task-authoring/tiering policy when creating/refining an Issue;
5. when Orca is used, read the installed version-matched Orca orchestration guide;
6. read current authoritative runtime/PR/CI/review facts before effects.

Do not substitute remembered Claude behavior for tracked policy.

## Roles

### Orchestrator

The orchestrator is the top-level coordinator.

It:

- manages managers and workers;
- creates/binds Tasks and Dispatches;
- reads authoritative task, runtime, PR, CI, review and smoke facts;
- uses deterministic reconciliation for routine states;
- resolves ambiguity, retry/reassignment and recovery decisions;
- invokes architect/operator reasoning only when facts do not determine a safe next action.

The orchestrator is not a task-authoring manager.

### Manager

A manager is a cheap process agent that owns **creation/refinement of a development task**.

A normal parent manager flow is:

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

A child author/reviewer/lens Dispatch may finish its own narrow Task. Child completion never settles the parent manager Task.

Managers do not supervise coding workers.

### Worker

A worker implements an already-created Issue.

The target bounded handoff is:

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

Independent review and smoke occur after this bounded implementation handoff. Later review/smoke findings create a fresh correction Task/Dispatch.

### Reconciler

The reconciler is deterministic policy/code used by the orchestrator.

It is not an agent role. Its logical decision surface is:

```text
noop
continue
orchestrator_required
```

`continue` is **not a new transport or actuator**. In the existing production design it is realized through the existing S2 fleet-nudge path when that path admits the episode.

The reconciler never sends `worker_done` for an agent and never owns termination authority for a live attempt.

### Architect

The architect is an expensive one-shot reasoning role for genuine architecture/specification decisions. It is not a fleet monitor, scheduler, retry service, or normal recovery layer.

## Binding supervision architecture

Do not rebuild mechanisms that already exist.

### S1 — observation

Current runtime-neutral observation is owned by:

```text
scripts/pr2-foundation/fleet-observer.ts
```

S1 classifies current runtime units using the existing `busy | livelock | idle | exempt | unknown` contract.

Important semantics:

- `busy` requires positive new bounded output after a valid baseline for the same current runtime generation;
- `idle` requires successful current-generation observation, runtime liveness=`idle`, valid bounded output with no new output, and no higher-precedence unknown/exemption condition;
- busy liveness without new output is no-progress/unknown evidence, not healthy progress;
- failed, missing, timed-out, stale, contradictory, wrong-generation, or unreadable evidence is `unknown`, never `idle`;
- process/pane/spinner/heartbeat existence alone proves neither progress nor completion;
- a positive `gone` observation is liveness evidence, not proof that the task result is absent.

Do not import a second N-read pane debounce or another idle detector beside S1.

### S2 — one-shot continuation

Current bounded continuation is owned by:

```text
scripts/pr2-foundation/fleet-nudge-actuator.ts
```

with its existing supporting surfaces:

```text
scripts/pr2-foundation/worker-nudge-claim-store.ts
scripts/pr2-foundation/worker-nudge-gate.ts
scripts/pr2-foundation/worker-dispatch-journal.ts
```

S2 already provides the continuation mechanism. In particular it owns:

- `S2_ONE_SHOT_POLICY = 's2-one-shot-v1'`;
- bounded idle/livelock continuation text;
- one attempt per new eligible S1 class-change episode;
- `not_new_episode` suppression rather than resend loops;
- exact episode identity and stale/epoch fencing;
- per-tick effect budgets;
- the existing claim/gate/journal accounting path;
- typed dispatch outcomes `dispatched | send_failed | dispatch_unknown`.

Therefore this runbook's `continue` rules specify **policy over existing S2**. They do not authorize a second continuation sender, claim store, journal, ACK path, retry loop, or watchdog.

If exact target resolution is unavailable, existing S2 fail-closed outcomes such as `target_unresolved` remain no-send outcomes. Do not bypass them with a second transport.

### Initial supervised task delivery is Orca-owned

Initial supervised Task/Dispatch startup is a different boundary from S2 continuation.

Preferred Orca path:

```text
orca orchestration worker-start --task <task_id> ... --json
```

For supported custom topology/argv, use a recognized agent terminal plus:

```text
orca orchestration dispatch --task <task_id> --to <agent_handle> --inject --json
```

Do not deliver a supervised Task by creating a pane and pasting the task through `terminal send --enter`. Bare-shell/manual terminal prompting remains legitimate for non-supervised/lightweight/full-handoff cases, but it is not the supervised Dispatch path.

Read the structured `worker-start` receipt. `ready`, `stage`, `effects`, setup state and `residualResources` are the authority for what startup proved. Failed or unknown start must be diagnosed from the receipt; do not reduce it to a raw exit code and do not blindly retry.

### Routine S2 continuation keeps the RuntimeAdapter transport

Do **not** migrate live S2 continuation to Orca Dispatch-addressed inbox mail as part of this contract merely because Orca also has messaging.

S2's existing effect seam is the runtime-neutral `RuntimeAdapter` dispatch contract. Keep that seam unless a separate explicitly scoped migration proves a reason to replace it.

The no-new-ACK rule does not prohibit S2's existing claim store and dispatch journal. Those are the **existing** one-shot/accounting authority. It prohibits creating a parallel acknowledgement/delivery/retry subsystem.

Interpret S2 outcomes truthfully:

- `dispatched` — the current RuntimeAdapter contract reports the dispatch as dispatched; this is not a claim that the model completed the requested work;
- `send_failed` — the send is definitively failed under the current contract;
- `dispatch_unknown` — the send outcome is uncertain and must stay uncertain.

Do not convert `dispatch_unknown` into success and do not automatically resend it through another path.

Subsequent S1/task/PR/report movement is used by later reconciliation to decide what is happening now. It is not a reason to invent a worker-read receipt service.

### Orca follow-up mail is a separate coordinator tool

A coordinator may use Orca's stable Dispatch address for explicit supervised guidance when that is the appropriate coordinator action:

```text
orca orchestration send --to dispatch:<dispatch_id> ...
```

Current Orca defines that as structured worker inbox mail consumed on a worker orchestration check. Coordinator `check --ack` acknowledges the coordinator's own Delivery batch; it is not a worker-read receipt.

Do not confuse this manual/coordinator messaging surface with routine deterministic S2 continuation, and do not dual-send the same continuation through both paths.

## Scheduler phases and ownership

### Tick logic

The scheduler tick logic is:

```text
scripts/pr2-foundation/scheduler.ts::runSchedulerTick
```

It has two structurally different phases.

#### Phase 1 — fleet supervision

```text
fleetObserver.tick(...)
-> fleet/reconciliation policy
-> fleetNudgeActuator.tick(...)
```

Manager/worker routine reconciliation belongs here.

If #1420 adds role/task admission logic, it must gate/extend this fleet/S2 path rather than create a second scheduler or continuation actuator.

#### Phase 2 — review start

The later review-start phase uses `liveCandidates()`, which intentionally selects only `ready_for_review` workers with a PR binding and exact head.

Do **not** widen `liveCandidates()` to include managers or pre-handoff workers. A manager creating an Issue has no PR, and an implementation worker before handoff is not a review candidate.

Review-start remains a separate exact-head actuation path.

### Production cadence / activation owner

Do not treat `scheduler.ts::runLoop()` as proof that production supervision is running.

The current activated side-process path is owned by:

```text
scripts/lib/orchestrator-side-process-supervisor.ts::runSupervisor
```

using the registered child:

```text
scripts/orchestrator-side-process-registry.json
  id: pr2-scheduler
  script: pr2-foundation/scheduler.ts
```

The supervisor launches the scheduler as a bounded `scheduler.ts tick` child and applies the registry cadence between child runs. The registry currently declares a 5-second cadence.

The scheduler/supervisor activation remains epoch/registry gated. Do not add a second launcher, daemon, timer, or watchdog.

Activation on the operator machine is an **operator-adoption step**, not something an implementation worker should mutate silently. Until a post-merge/local adoption read-back proves a supervisor-owned tick under the current epoch, report the code as implemented but do not claim live deterministic supervision is active in that operator environment.

## Existing mutation constraints

The scheduler and supervisor are already guarded by landed cutover contracts.

When editing `scripts/pr2-foundation/scheduler.ts`, preserve the existing mutation-semantic gate invariants, including the required dormant literals around:

- `running: false`;
- `activationEpochEnforced: false`;
- `buildDormantScheduler` remaining free of direct `process.env` activation.

The current side-process registry and activation registry projection also pin the `pr2-scheduler` child shape. Do not edit the registry merely to implement #1420. Reuse the existing child and activation path.

A red mutation gate caused by violating one of these invariants is a design error, not a reason to weaken the gate.

## Core operating laws

### 1. Watch objective state, not the worker story

Ask what authoritative lifecycle fact is true now, not merely whether a worker says it is working.

Useful facts include, as applicable:

- current GitHub Issue revision and prerequisites;
- current Task/Dispatch identity;
- current assignment/runtime generation;
- S1 observation;
- S2 episode/outcome;
- current PR and exact head;
- required CI for that head;
- exact-head review/smoke results;
- accepted WorkerReport/WorkerStatus facts;
- authoritative child-stage result surfaces.

Worker prose is context, not sole lifecycle authority.

### 2. `worker_done` means the whole role completion contract

`worker_done` is terminal for the assigned Task/Dispatch attempt.

It does not mean:

- one model turn ended;
- one substep succeeded;
- an Issue or PR merely exists;
- a helper failed;
- the agent is waiting on a child/CI/review;
- the agent sent `ask` or `escalation`;
- a timer elapsed.

Before successful `worker_done`, re-read the Task and verify every applicable role-owned completion criterion. If required work remains, keep the same Dispatch active and continue/wait/ask/escalate instead.

`worker_done --outcome failed` is for a genuinely terminal failed/aborted Task after allowed recovery/coordination is exhausted, not the first recoverable error.

### 3. One LLM turn is not one Dispatch

Keep the same Dispatch across recoverable substeps, prompt returns, child waits, questions/escalations and ordinary continuation of the same Task attempt.

Create a fresh Dispatch only for a real boundary: a different Task/subtask, independent reviewer/lens, correction work after a settled handoff, reassignment, or retry after a proved failed/lost attempt.

### 4. Re-read before retry

A timeout, helper disconnect or lost tool result does not prove an operation failed.

```text
read authoritative state
-> determine whether the operation already succeeded
-> retry only when evidence proves retry is still needed and safe
```

Blind retry is a defect.

### 5. Helper failure is recovery first

A failed browser/helper/wrapper is not automatically a terminal blocker.

Inspect the actual error, re-read authoritative state and use the shortest legitimate supported fallback. Escalate only when a higher-level decision, missing permission/capability, ownership conflict, destructive operator choice, or genuinely exhausted recovery remains.

An `ask` or `escalation` is pre-completion; the unfinished Dispatch stays active unless explicitly terminated/replaced.

### 6. External waits do not block the orchestrator

CI, review, browser state, child results and other external waits are lifecycle state plus future re-checks.

Do not hold the orchestrator/reconciler in a foreground sleep/poll loop. A scheduler/reconciler pass returns promptly so other completed work can be processed.

### 7. Exact identity before effects

Runtime effects require exact current authoritative identity. Do not authorize an effect from terminal title, branch, path, PID alone, display name, first matching pane, stale worker handle, or another heuristic.

### 8. At most one active attempt per exact stage artifact

Before starting a new stage Dispatch, prove no active attempt already exists for the exact stage key.

Typical keys:

```text
Task author/review/lens: {Task, Issue revision, stage}
implementation/review/smoke: {Task, PR, exact head, stage}
```

Retry/reassignment requires the prior exact attempt to be terminal/lost/replaced by explicit orchestrator decision.

### 9. A stage opens on producer handoff, not a proxy

CI green, process idle or PR existence alone does not open review.

For code review, require the producing worker's truthful current-head handoff plus required CI/admission facts for that same head. The reviewer re-reads the head at start and refuses a moved/stale head.

For task review/lens, use the current published Issue revision from the preceding stage.

### 10. Child results require an authoritative delivery surface

A child result is not delivered merely because it appeared in conversation.

Default surfaces:

- Issue author/fix -> published GitHub Issue revision;
- Issue/spec review or architectural lens -> GitHub Issue comment or explicitly named durable task-review surface;
- code review -> authoritative GitHub PR review/comment plus exact-head review state;
- worker handoff -> accepted PACK report/status bound to current assignment/PR/head;
- Orca child settlement -> exact Task/Dispatch terminal state plus any artifact the parent Task requires.

If a required stage has no authoritative observation surface, route `orchestrator_required` rather than pretending the stage is absent/healthy/complete.

### 11. Prompt address space must be valid

Every artifact referenced by a prompt must be readable in the receiving executor's address space.

Do not hand a remote/browser/chat executor an inaccessible local path. Inline bounded content or use a shared connector/URI/artifact it can read.

The receiver must also confirm the artifact class it received before substantive work. A PR review request delivered as a draft-review artifact is a carrier mismatch, not permission to review the wrong object.

### 12. Preserve failure evidence

A failed attempt must keep the diagnostic surface needed for the orchestrator to understand the failure until the orchestrator has re-read it and decided the next action.

Do not destroy the only pane/page/output/workspace witness on the first non-ok result.

### 13. Recovery code does not own termination

A helper, observer, reconciler, nudge actuator, smoke harness or recovery wrapper cannot stop/kill/remove a live attempt merely because a result is non-ok.

Termination/replacement is an orchestrator/operator decision after authoritative re-read.

### 14. Alarm quality matters

False alarms are operational defects.

Each alarm/escalation class must use the designated authority for the condition, scope evidence/effects to the current repository/task, and filter supervisor-generated echo from worker evidence. Do not infer a provider/platform outage from indirect symptoms when a designated provider-status authority is required.

## Manager operating procedure

### Start

Read the full Task contract, prerequisites and tier policy. Make a short ordered plan for the **whole** author/review/fix/lens workflow before starting child work.

### Author/fix

After any Issue publication or revision, read back the current GitHub Issue. A tool success message is not enough when later gates depend on the result.

### Review and lens

Run the number/type of independent task reviews and lens steps required by current tiering policy.

If a finding changes the Issue, previous affected evidence becomes stale. Re-run every invalidated gate against the current revision.

### Completion

The manager may report `task_ready` and send parent `worker_done` only when the **current published Issue revision** has all required author/review/fix/lens gates satisfied and required child results are present on their authoritative surfaces.

## Worker operating procedure

### Start

Read the live Issue/rules/prerequisites and resolve the exact current assignment/runtime identity.

### Implement and verify

Implement scoped changes and run required local verification.

### Publish and self-fix pre-review CI

Create/update the PR, bind to the exact current head and fix worker-owned required pre-review CI for that head.

A pending or red required head is not ready.

### Completion

Successful worker `worker_done` requires a truthful current-head `ready_for_review` handoff and no known worker-owned pre-review blocker.

A PR existing is not enough. Code merely compiling is not enough.

Later independent review/smoke findings create a fresh bounded correction Dispatch.

## Deterministic supervision policy over S1/S2

Routine reconciliation must reuse the existing fleet phase.

Conceptually:

```text
read authoritative role/task facts
+ read trusted S1 snapshot
-> reconcile next role-owned action
-> noop | continue | orchestrator_required
```

Mapping:

- `noop` -> no S2 effect is authorized;
- `continue` -> allow the existing S2 admission/revalidation/one-shot path for the exact eligible episode;
- `orchestrator_required` -> suppress routine S2 actuation and surface the unresolved case through the existing orchestrator-facing path; do not invent a second scheduler or retry loop.

S2 remains responsible for one-shot admission, claim/journal settlement, exact runtime dispatch and its typed dispatch outcome. The reconciler must not implement those responsibilities again.

Representative cases:

| Facts | Decision |
|---|---|
| active/new progress | `noop` |
| trusted S1 idle/livelock + current role-owned work remains + exact target valid | `continue` via S2 |
| full manager completion contract satisfied | `noop` (manager may complete) |
| truthful worker `ready_for_review` handoff with no worker-owned action left | `noop` (worker may complete) |
| missing/ambiguous ownership, unobservable required stage, unresolved S2 target, or unsafe recovery choice | `orchestrator_required` |

Do not automatically resend because a previous dispatch was `dispatch_unknown` or because no semantic progress is yet visible. Let the existing S1/S2 episode model and later authoritative facts drive the next reconciliation.

## Review, CI, smoke and readiness

Keep these separate:

- CI is exact-head evidence, not global completion;
- review is exact-head evidence, not worker self-report;
- smoke is task-defined exact-head/effect evidence;
- `ready_for_review` is the worker handoff boundary;
- PR-level `READY_TO_MERGE`, where used, is derived from authoritative facts and never from worker prose alone;
- merge remains operator-only unless the direct user explicitly orders it.

Failure, timeout, cancellation, ambiguity or missing evidence never becomes success.

## Orca `worker_done` wording

The generic Orca guide/preamble should state the universal rule: `worker_done` settles the whole assigned Task attempt, not merely the current model turn/substep.

At implementation time, inspect the installed/version-matched Orca guide and injected preamble:

- if they already express that whole-Task contract, record the exact Orca version/commit and do not open a gratuitous upstream change;
- if end-of-turn/ambiguous wording remains, use a linked upstream Orca change for guide/preamble/tests;
- do not hardcode PACK manager/worker stage lists into Orca core.

## Model-neutral documentation authority

This runbook is the shared orchestration authority once landed.

`AGENTS.md` must contain a role-triggered reference requiring orchestrator/manager executors to read it.

Do not create a second Codex-only copy. `CLAUDE.md` and `.claude/**` may keep Claude-specific invocation/tool details and pointers, but must not uniquely own shared orchestration/lifecycle/task-authoring rules.

## What not to build again

Unless a later task proves a unique requirement, do not add:

- a second scheduler/daemon/watcher/watchdog;
- a second idle/liveness detector beside S1;
- a second continuation actuator beside S2;
- a parallel S2 claim/journal/ACK/retry state machine;
- heartbeat-as-progress logic;
- global pane/PID/title/path targeting when exact identity exists;
- a second task database duplicating GitHub Issues;
- a second collaboration/GitHub transport abstraction;
- compatibility layers whose only purpose is preserving retired orchestration machinery.

## Local-only legacy cleanup

Historical Claude orchestration helpers may exist only on the operator machine and never have been committed.

They are not repository-worker deletion scope.

After the final flow is adopted, the local orchestrator/operator should:

1. read this runbook and the current Orca guide;
2. inventory local untracked orchestration helpers/state/autostart hooks;
3. classify each `keep | replace | delete`;
4. delete local watcher/watchdog/heartbeat/global-nudge/keyboard-paste/retry/parallel-ACK/state helpers whose responsibility is now covered by Orca, S1/S2, PACK authoritative facts or the deterministic reconciler;
5. keep only a helper with a concrete current responsibility not otherwise served;
6. remove obsolete autostart hooks;
7. verify the normal flow works without retired helpers.

Do not add local files to git merely to delete them.

## Operator adoption

Repository implementation does not silently mutate the operator machine.

If the final change depends on active deterministic supervision, the PR handoff must state the exact activation/read-back procedure for the existing TypeScript side-process supervisor.

After adoption, prove at least one supervisor-owned scheduler tick under the current epoch using the existing supervisor/S1 durable status/progress surfaces. Until that read-back exists, do not claim the operator environment is actively supervised merely because code merged.

## Verification model

Use the right evidence class for the property.

### Code-enforced behavior

Use focused tests/integration evidence for code paths such as:

- S1 classification semantics;
- S2 one-shot episode admission and `not_new_episode` suppression;
- S2 `dispatched | send_failed | dispatch_unknown` settlement;
- exact target/epoch/stale fencing;
- reconciliation gating of existing S2 rather than a second actuator;
- fleet-phase hosting without widening review `liveCandidates()`;
- duplicate active-attempt admission prevention where implemented in code;
- exact-head review admission/refusal where implemented in code;
- `noop | continue | orchestrator_required` branch reachability;
- supervisor/scheduler integration that preserves existing activation/mutation contracts.

### Documentation/prompt contract

Use read-back of `AGENTS.md`, this runbook and the role prompt surfaces for agent-behavior rules such as:

- manager recovery before escalation;
- whole manager author/review/fix/lens completion;
- worker whole-handoff completion;
- authoritative child result publication;
- prompt address-space/carrier correctness;
- failed-evidence preservation and termination authority;
- alarm authority/scoping;
- prerequisite reading and non-blocking wait behavior.

Do not invent fake code tests whose only assertion is that prose exists.

### Current-head and adoption evidence

Before claiming repository implementation complete, use current-head CI/review required by `AGENTS.md` and the active tier policy.

Operator activation is separate adoption evidence as described above.

## Startup checklist — orchestrator

```text
[ ] live AGENTS.md read
[ ] this runbook read
[ ] binding Issue/Task read
[ ] current Orca guide read when applicable
[ ] current S1/S2 and Task/Dispatch identities known
[ ] current PR/head/CI/review facts read where applicable
[ ] routine action uses existing S1/S2 path
[ ] ambiguity goes to orchestrator reasoning, not a new daemon
```

## Manager completion checklist

```text
[ ] whole authoring plan made
[ ] current Issue published and read back
[ ] all required reviews apply to current revision
[ ] all findings fixed/adjudicated
[ ] required lens applies to current revision
[ ] invalidated gates rerun after edits
[ ] required child results are on authoritative surfaces
[ ] task_ready is truthful
[ ] no manager-owned action remains
[ ] only now worker_done
```

## Worker completion checklist

```text
[ ] live Issue/rules/prerequisites read
[ ] scoped implementation complete
[ ] required local verification complete
[ ] exact PR head published
[ ] required pre-review CI acceptable for that head
[ ] no known worker-owned pre-review blocker
[ ] ready_for_review handoff truthful
[ ] only now worker_done
```

## Maintenance rule

When a new orchestration incident teaches a durable lesson:

1. fix the real mechanism or contract;
2. update this runbook only if future operating behavior changes;
3. prefer a concise invariant over preserving an incident diary;
4. never leave a shared orchestration rule only in Claude memory, a private Gist, or a model-specific skill.

If this runbook conflicts with a newer live Issue, `AGENTS.md`, or landed contract, follow the newer authority and update this document in the same work.