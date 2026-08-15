# Orchestration runbook

This document is the shared, model-neutral operating guide for supervised task creation and implementation in `orchestrator-pack`.

It is intentionally written so the same orchestration behavior is available to Claude, Codex, or another compliant executor. Model memory, historical Gists, local helper scripts, terminal layout, and one model-specific skill are not sources of truth for the lifecycle described here.

The GitHub Issue remains the live task specification. `AGENTS.md`, current repository policy, current GitHub state, and the version-matched Orca orchestration guide remain authoritative where this runbook points to them.

## When to read this runbook

Read this document before acting as an **orchestrator** or **manager**, and whenever a worker lifecycle/recovery decision depends on orchestration semantics rather than implementation details.

Do not use remembered behavior from an older Claude session in place of this document.

## Roles

Use these names consistently.

### Orchestrator

The orchestrator is the top-level coordinator.

It:

- manages managers and workers;
- chooses and starts Tasks/Dispatches;
- reads authoritative task, PR, CI, review, smoke, assignment, report, and runtime facts;
- uses deterministic supervision for routine cases;
- resolves ambiguous recovery/ownership situations;
- invokes an architect or operator only for a real higher-level decision;
- does not treat itself as a task-creation manager.

### Manager

A manager is a cheap process agent that manages **creation of a development task**.

Its job is not finished after an Issue is first created. It owns the full task-authoring quality loop required by the task tier, for example:

```text
user goal
  -> understand scope/tier/prerequisites
  -> author or revise Issue
  -> read back current published Issue
  -> independent review(s)
  -> findings -> fix/revise -> review current revision again
  -> required architectural lens
  -> lens finding/change -> fix/revise -> rerun invalidated gates
  -> prove current Issue revision passed all required gates
  -> task_ready
  -> worker_done
```

A manager does not supervise coding workers after implementation handoff.

### Worker

A worker executes an already-created development Issue.

Its normal bounded completion target is implementation handoff, not merge and not an arbitrary end of an LLM turn:

```text
read live Issue and rules
  -> verify prerequisites/admission
  -> implement scoped task
  -> run required local verification
  -> create/update PR and exact head
  -> fix required pre-review CI for that head
  -> publish truthful ready_for_review handoff
  -> verify no known worker-owned pre-review blocker remains
  -> worker_done
```

Independent review and smoke are orchestrator-managed stages after that bounded worker handoff. If they later create new actionable implementation work, the orchestrator starts a fresh correction Task/Dispatch.

### Reconciler

The reconciler is deterministic code used by the orchestrator for routine supervision.

It is not an agent and does not reason about architecture.

Its normal decision surface is:

```text
noop
continue
orchestrator_required
```

It never emits `worker_done` for an agent and never terminates a live attempt.

### Architect

The architect is an expensive, one-shot reasoning role for genuine architecture/specification decisions.

It is not a monitor, scheduler, retry service, or substitute for normal manager recovery.

## Core operating laws

These are the durable lessons migrated from the historical orchestration experiments and incident analysis.

### 1. Watch the objective, not the worker story

The primary question is not “does the worker say it is working?” but “what authoritative task/lifecycle fact is true now?”

Useful objective facts include, as applicable:

- current GitHub Issue revision;
- current prerequisites/blockers;
- current WorkerAssignment generation;
- current Task/Dispatch identity;
- current PR and exact head;
- required CI state for that head;
- current review result/findings for that head;
- current smoke result for that head;
- current durable WorkerReport/WorkerStatus facts;
- exact RuntimeAdapter identity and current Orca Dispatch provenance.

Worker prose is context, not sole lifecycle authority.

### 2. `busy` is not `progress`, and `idle` is positive evidence

A live process, active pane, spinner, terminal existence, heartbeat, CPU usage, or unchanged scrollback does not prove useful progress.

Use the existing S1 observer semantics rather than inventing a new model-specific detector:

- `busy` requires positive new bounded output after a valid baseline for the same current runtime generation;
- `idle` requires successful current-generation observation, positive runtime liveness=`idle`, valid bounded output with no new output, and no higher-precedence exemption/unknown condition;
- `busy` liveness with no positive output is no-progress evidence, not healthy progress;
- failed, missing, timed-out, stale, contradictory, wrong-generation, or unreadable evidence is `unknown`, never `idle`;
- positive same-generation `gone` is a liveness fact, not proof that the task result is absent.

The historical “take N pane reads” workaround is not a second idle detector. If the current RuntimeAdapter/S1 observation disagrees or cannot establish a positive class, classify `unknown` and do not act destructively.

### 3. Silence proves nothing by itself

No output for ten minutes does not by itself prove:

- failure;
- health;
- completion;
- delivery;
- a safe retry boundary.

Time is only a checkpoint trigger for re-reading facts.

### 4. Evidence that matters must be re-readable and registered

If a lifecycle decision depends on a fact, prefer evidence that survives outside the process that produced it.

Examples include GitHub state, durable reports, exact-head CI/review/smoke results, Orca Task/Dispatch records, and the existing S1 snapshot/progress surface.

A producer of a lifecycle fact is not complete merely because it wrote somewhere. The deterministic reconciler must explicitly enumerate the authoritative source that supplies each fact it consumes. Adding a new producer without wiring its observation surface into that closed input set is a defect.

If a required stage exists but the reconciler has no authoritative observation channel for it, classify the case `orchestrator_required`; never silently treat “not observed” as healthy, absent, or complete.

Do not make a temporary log, hidden terminal buffer, conversation-only reply, local scratch file, or one model's private memory the only place a required fact exists.

### 5. Re-read before retry

A timeout, disconnected helper, browser automation error, or lost tool response does not prove the operation failed.

Before retrying an operation that may have succeeded:

```text
read authoritative current state
-> determine whether the operation already succeeded
-> retry only when evidence says it did not succeed and retry is safe
```

Blind retries create duplicates and false recovery paths.

### 6. Helper failure is not automatically a blocker

A failed helper script or browser wrapper is first a recovery problem.

The agent should inspect the real error and use the shortest legitimate supported alternative available in the environment. If direct browser control, a lower-level supported command, or another normal read/write path exists, use it and continue the original plan.

Escalate only after concrete recovery attempts show that higher-level coordination or a missing external capability/permission is actually required.

### 7. Routine supervision is deterministic

Do not spend an LLM every ten minutes asking whether a worker should continue.

The reconciler reads facts and liveness, classifies the state, performs at most one bounded effect, and returns.

The orchestrator reasons only when deterministic policy cannot safely select the next effect.

### 8. Exact identity before effects

Runtime effects must target the exact current assignment/Dispatch/runtime identity.

Do not authorize effects from:

- terminal title;
- branch name;
- path;
- PID alone;
- display name;
- first matching pane;
- stale worker handle;
- short identifier that is not the current authority.

Stale/lost/failed attempts are reconciled from exact authoritative facts, not heuristics.

### 9. Do not confuse external waiting with abandonment

Waiting for a child author/reviewer/lens result, CI, review, smoke, or an orchestrator answer can be a normal lifecycle state.

An agent with unfinished role-owned work must remain attached to its current Task/Dispatch until its completion contract is terminal.

### 10. One LLM turn is not one Dispatch

A model returning to its prompt is not a Task boundary.

A Dispatch represents a concrete attempt of a Task. It may span multiple model turns, recoverable substeps, questions, waits, and continuations.

Create a fresh Dispatch only when the boundary is real: a different Task/subtask, an independent reviewer/lens, a correction round after a settled handoff, reassignment, or retry after a proved failed/lost attempt.

### 11. Use Orca's supervised delivery path; do not rebuild prompt delivery in PACK

For supervised Dispatch work, Orca owns initial worker startup and task injection.

Preferred path:

```text
orca orchestration worker-start
```

When custom topology/argv requires lower-level composition, use a recognized agent terminal plus:

```text
orca orchestration dispatch --inject
```

Do **not** use the Orca bare-shell recipe `terminal send --text ... --enter` as the task-delivery mechanism for a supervised Dispatch. That path is valid for bare-shell/lightweight/manual prompting, but it recreates the historical keyboard-injection failure class and does not provide the supervised injected lifecycle contract.

For supervised startup, inspect the structured `worker-start` receipt. `ready` and its `stage/effects/setup/residualResources` fields are the authority for what startup/dispatch work Orca proved. A failed or unknown start is handled from that receipt; do not reduce it to a raw process return code and do not blindly retry.

This removes the historical “PACK created a pane and pasted the task with keystrokes” class from normal supervised startup. PACK must not recreate an alternate startup/prompt-injection transport beside Orca.

### 12. A follow-up accepted by Orca is not proof the worker consumed it

Coordinator guidance to a live supervised worker uses the stable Dispatch address:

```text
orca orchestration send --to dispatch:<dispatch_id> ...
```

Current Orca defines this follow-up as **structured inbox mail, not prompt injection**. The worker receives it on its next `orchestration check`.

Therefore distinguish:

- **initial supervised task delivery** — handled by `worker-start` / `dispatch --inject` and its structured startup/dispatch receipt;
- **follow-up acceptance** — Orca accepted coordinator mail for the Dispatch;
- **follow-up consumption/action** — later worker behavior proves the mail was checked/acted on.

Coordinator-side `check --ack <delivery_id>` acknowledges the coordinator's own Run delivery batch; it is not a worker-read receipt for a follow-up sent to the worker.

If the current Orca version exposes an authoritative worker-side consumption fact, PACK may consume that fact through the normal adapter/state boundary. Do not assume such a fact exists when the installed contract does not expose it.

Absent a direct worker-consumption witness, use subsequent **existing** lifecycle evidence, for example:

- positive new bounded output for the exact same runtime generation;
- a durable WorkerReport/WorkerStatus change for the same assignment/Task;
- a child Task/Dispatch start or authoritative stage result that the follow-up was intended to cause;
- PR/head or other task-specific authoritative movement that is causally appropriate for the requested continuation.

A missing post-send fact does **not** authorize an automatic resend loop. One bounded continuation episode is followed by observation; if the same actionable state persists without trustworthy evidence that work resumed, route `orchestrator_required`.

Do not add a parallel ACK/delivery-confirm/retry service merely to implement this law.

### 13. The supervisor must prove its own decision paths are reachable

“No event” and “the branch is broken and can never fire” are operationally indistinguishable unless tested.

Every reconciler decision class must be exercised by focused tests/integration evidence:

- `noop` on an active/healthy or fully satisfied case;
- `continue` on a positively actionable case;
- `orchestrator_required` on an ambiguous/unresolved case;
- the “all completion gates satisfied” path for manager and worker handoff.

A new decision branch without reachability evidence is incomplete.

### 14. The orchestrator and reconciler never block on an external condition

Do not sit in a foreground sleep/poll loop waiting for CI, review, a child, browser state, or another external condition.

A wait is represented by current lifecycle state plus a future re-check. The current pass returns promptly so other completed work can be observed.

A tool invocation may have its own bounded timeout, but the orchestrator does not turn that into an eight-minute foreground polling loop.

### 15. Admit at most one active attempt for one exact stage artifact

Before starting a new Dispatch, check the authoritative active-attempt set for the exact stage key.

Typical keys are:

- task author/review/lens: `{Task, Issue revision, stage}`;
- implementation/review/smoke: `{Task, PR, exact head, stage}`;
- retry/reassignment: prior attempt must be proved terminal/lost before a replacement attempt is admitted.

If an active attempt already exists for that key, do not start another one. Observe the current attempt or route ambiguity upward.

### 16. A downstream stage opens on a producer handoff, never a proxy signal alone

CI green, process idle, PR existence, or another proxy does not by itself open the next stage.

For coding review, admission requires the producing worker's truthful terminal handoff for the exact current PR head, plus the required CI/admission facts for that same head. The reviewer re-reads the head at start and refuses a moved/stale head rather than reviewing a different artifact.

For task-authoring review/lens, admission requires the current published Issue revision produced by the preceding stage, not an older cached draft.

### 17. A child-stage result is not delivered until it reaches the authoritative surface

Conversation-only output is not a final stage result when the surrounding workflow reads GitHub or another durable source.

The Task must name the result surface. Defaults are:

- Issue author/fix: the published GitHub Issue revision;
- Issue/spec review or architectural lens: a GitHub Issue comment or another explicitly named durable task-review surface;
- code review: the authoritative GitHub PR review/comment surface plus exact-head review state;
- worker lifecycle handoff: the accepted PACK report/status surface bound to the exact assignment/PR/head;
- Orca child Task settlement: exact Task/Dispatch terminal state plus any stage artifact the parent needs to continue.

A child saying “done” in chat while the required authoritative surface is absent is non-delivery.

### 18. Prompt references must exist in the executor's address space

Before dispatch, every referenced artifact must be resolvable by that executor.

Do not hand a remote/browser/chat executor an inaccessible local filesystem path and expect it to infer the contents. If a shared URI/connector/file is unavailable, inline the necessary bounded content or choose a carrier that can read it.

The receiving executor also confirms the artifact class it actually received before acting: Issue review, PR review, code patch, research brief, etc. A carrier mismatch is a dispatch defect, not permission to review the wrong object.

### 19. A failed attempt must preserve its diagnostic evidence

Failure handling must not immediately destroy the only surface that explains the failure.

Do not automatically close/remove a failed pane/page/process/workspace or erase its bounded diagnostics before the orchestrator has re-read the relevant evidence and decided the next action. Cleanup follows diagnosis/decision, not the first non-ok return.

### 20. Recovery machinery does not own termination authority

A helper, observer, reconciler, recovery wrapper, smoke harness, or nudge actuator must not press Stop/kill/remove a live attempt merely because an outcome is non-ok.

Termination/replacement of a live attempt is an explicit orchestrator/operator decision after authoritative re-read. `unknown` is no-action, and a known non-ok result is still not automatic termination authority.

### 21. False alarms are costly lifecycle defects

An alarm/escalation class must use its designated authority, scope itself to the current repository/task, and filter its own generated output from evidence.

Do not infer a provider/platform outage from indirect zombie/queued symptoms when a designated provider status authority is required. Do not read the supervisor's own nudge/echo as a worker verdict. Do not emit repo-global alerts from another repository's state.

Prefer fewer trustworthy alarms to a noisy channel that operators learn to ignore.

## `worker_done` contract

`worker_done` is a strong terminal lifecycle event.

It means:

> The entire completion contract of this Task/Dispatch attempt is terminal. Every required stage owned by this role is satisfied, or the coordinator has explicitly made the Task terminally failed/aborted.

It does **not** mean:

- “my current answer ended”;
- “I finished one substep”;
- “I created the Issue”;
- “I created the PR”;
- “a helper broke”;
- “I asked the orchestrator a question”;
- “I escalated a blocker”;
- “I am waiting on another stage”;
- “ten minutes passed”.

Before successful `worker_done`, the agent should re-read the Task and be able to answer yes to every applicable check:

```text
Is this the current Task/Dispatch?
Did I read the full Task contract and prerequisites?
Did I execute every required stage for my role?
Are required child results current and delivered to their authoritative surfaces?
Did I address or explicitly adjudicate every required finding for the current artifact/head?
Did I perform required read-back/verification?
Is there no remaining manager/worker-owned action in this Dispatch?
```

If any answer is no, do not send successful `worker_done`.

Use continuation, waiting, `ask`, or `escalation` while keeping the Dispatch active.

`worker_done --outcome failed` is for a genuinely terminal failed/aborted Task after allowed recovery/coordination is exhausted, not the first recoverable tool error.

## Manager operating procedure

### Start

The manager first reads:

1. live `AGENTS.md`;
2. this runbook;
3. live user goal / binding Issue context;
4. current task-authoring/tiering policy required for the requested task;
5. explicit prerequisites/blockers and whether they are satisfied.

Then it writes a short ordered plan covering the **whole** task-creation workflow before starting child work.

A task whose own contract says it is blocked is not dispatched as implementation-ready until that prerequisite is resolved or the direct operator changes the contract.

### Authoring

The manager starts or reuses the proper authoring path to create/revise the Issue.

After publication, it reads the current GitHub Issue back. A tool success message without read-back is not enough when the result matters to later gates.

### Review loop

Run the number/type of independent task reviews required by current task-tier policy.

Before starting each review, prove there is no already-active review attempt for the exact current Issue revision/stage.

If a review finds a material issue:

```text
review finding
-> author/fix current Issue
-> read back new Issue revision
-> previous review is stale for changed content
-> run a fresh required review against current revision
```

Do not count a clean review of an old Issue revision as evidence for a changed one.

A reviewer/lens result must reach the authoritative task-review surface. A conversation-only verdict is not a completed review stage.

### Lens

Run the required architectural lens for the task tier against the current Issue revision.

If the lens causes a meaningful Issue change, rerun every earlier gate invalidated by that change.

### Manager completion

The manager may report `task_ready` and send its parent `worker_done` only when the **current published Issue revision** has all required authoring/review/lens gates satisfied and all required child results are delivered on their authoritative surfaces.

Child author/reviewer/lens Dispatches can correctly finish their own narrow Tasks without completing the parent manager Task.

## Manager recovery procedure

On ordinary friction:

```text
inspect actual error/output
-> read authoritative state
-> determine whether the operation may already have succeeded
-> use the shortest supported fallback/lower-level path if available
-> retry only when safe and necessary
-> continue the original plan
```

Examples of ordinary recoverable friction:

- a helper wrapper fails but direct supported browser control is available;
- a tool call times out but GitHub/current state can be read back;
- an expected convenience command is unavailable but a repository-approved lower-level path exists.

Escalate to the orchestrator only for evidence-backed conditions such as:

- missing external permission/capability;
- unresolved specification contradiction;
- ownership conflict;
- destructive operator choice;
- exact recovery route cannot be determined safely;
- recovery is genuinely exhausted after concrete attempts.

An escalation is **pre-completion**. The manager Task remains active and resumes after the answer/recovery unless the orchestrator explicitly terminates/replaces it.

## Worker operating procedure

### Start

The worker reads the live Issue and repository rules, checks prerequisites, resolves the exact current assignment/runtime identity, and plans the full implementation handoff.

Before starting a replacement/retry Dispatch, the orchestrator must prove the previous exact attempt is terminal/lost or intentionally reassigned.

### Implement and verify

The worker implements only scoped changes and runs required local verification.

### Publish and self-fix pre-review CI

The worker creates/updates the PR, records the exact current head, and handles worker-owned required pre-review CI failures for that head.

A red required head is not ready. A pending required head is not green.

CI green alone is not review admission.

### Worker completion and review admission

The worker may send successful `worker_done` only after it has a truthful current-head `ready_for_review` handoff and no known worker-owned pre-review blocker remains.

A PR existing is not enough. Code merely compiling is not enough.

Only after that producer handoff may the orchestrator admit independent review for the same exact head, subject to required CI/admission rules and the one-active-attempt gate. The reviewer re-reads the current head before work and refuses a moved head.

If later independent review or smoke produces implementation findings, that is a **new correction Task/Dispatch** after the previous bounded worker handoff.

## Deterministic supervision loop

### Cadence owner

The existing cadence owner is `scripts/pr2-foundation/scheduler.ts`:

```text
runLoop()
  -> runSchedulerTick(...)
```

`FoundationConfig.scheduler.pollIntervalMs` supplies the scheduler cadence. #1420 does not create a second timer/loop. A policy threshold such as “re-check within ten minutes” is evaluated on the existing scheduler ticks; it is not another sleeping process.

The current scheduler runs its phases serially and each phase must stay bounded. External waits are represented as state and future re-checks, not foreground sleeps.

### Authoritative fact sources

The reconciler input contract must enumerate the sources it actually reads. The expected current classes include:

- live GitHub Issue/task/prerequisite state;
- current WorkerAssignment/Task/Dispatch identity and generation;
- accepted PACK WorkerReport/WorkerStatus state;
- current PR/exact head and required CI;
- current exact-head review/smoke facts;
- current RuntimeAdapter/S1 liveness/output observation;
- exact child-stage result surfaces required by the active manager/worker plan.

Implementation may rename/refine these after current architecture inspection, but it may not rely on an unregistered producer.

### Positive idle

For the current S1 implementation, `positive idle` means the existing observer class `idle`: successful same-generation required observations, liveness=`idle`, valid bounded output proving no new output, and no higher-precedence `unknown`/exemption condition.

It does **not** mean “no busy marker happened to be visible.”

### Finite pass

On each admitted reconciliation pass:

```text
read authoritative lifecycle facts
-> read bounded runtime/liveness observation
-> classify
-> perform at most one allowed effect
-> return
```

Decision surface:

```text
noop
continue
orchestrator_required
```

The timer is only a re-check trigger. It never proves failure, progress, task consumption, or follow-up delivery.

### Manager cases

| Facts | Decision |
|---|---|
| manager active / child author-review-lens work running | `noop` |
| positive idle + Issue missing required review | `continue` |
| positive idle + current review findings unresolved | `continue` |
| positive idle + required lens missing | `continue` |
| positive idle + helper failed but supported recovery remains | `continue` |
| all current manager completion gates satisfied | `noop` (manager may complete) |
| required stage has no registered observation surface | `orchestrator_required` |
| repeated actionable idle after one bounded follow-up without authoritative post-send evidence | `orchestrator_required` |
| liveness/ownership/recovery facts ambiguous | `orchestrator_required` |

### Worker cases

| Facts | Decision |
|---|---|
| new output / active progress | `noop` |
| positive idle + implementation/fix work remains | `continue` |
| positive idle + required pre-review CI red | `continue` |
| current head is truthfully `ready_for_review` with no worker-owned action left | `noop` (worker may complete) |
| required stage has no registered observation surface | `orchestrator_required` |
| repeated actionable idle after one bounded follow-up without authoritative post-send evidence | `orchestrator_required` |
| gone/stopped/identity ambiguity | `orchestrator_required` |

### Bounded continuation

A normal continuation goes only to the exact current active Dispatch using Orca's Dispatch address, not terminal keystrokes:

```text
orca orchestration send --to dispatch:<dispatch_id> ...
```

Keep it short, for example:

> Continue the current assigned Task. Re-read current authoritative facts, execute the next role-owned action from your existing plan, and do not settle the Dispatch while any required stage remains. If a genuine unresolved blocker remains after supported recovery, report the evidence and attempts already made.

The send result proves mail acceptance only to the extent Orca's contract says so. On later reconciliation, look for subsequent existing worker/lifecycle evidence. Do not broadcast, use `terminal send --enter`, create a new Dispatch, or re-send the same continuation merely because the agent is still idle.

One bounded follow-up without later trustworthy evidence that work resumed escalates to `orchestrator_required` rather than becoming an infinite nudge loop.

### Proving the cadence owner itself

Do not add a second watchdog for the scheduler.

Use the existing durable S1 progress/snapshot evidence (`schedulerGeneration`, `tickSequence`, `completedAt`/progress) as the current checkpoint witness while S1 owns that surface. A stale/missing checkpoint discovered during ordinary orchestrator reads is an orchestration problem requiring diagnosis; it is not proof that all supervised work is healthy.

If the final architecture replaces that S1 surface, preserve the same property: the cadence owner's latest completed checkpoint must be re-readable without creating another resident monitor.

## Orchestrator exception path

`orchestrator_required` means deterministic policy cannot safely choose the next effect.

The orchestrator may:

- answer an `ask`;
- resolve an ordinary ownership/recovery ambiguity;
- restore or select a supported recovery route;
- decide whether an attempt is truly failed/lost and should be retried;
- decide whether a live attempt should be terminated/replaced;
- reassign work;
- invoke an architect or operator for a genuine decision.

The orchestrator should not become a permanent polling LLM and must not block in foreground waits for CI/review/children.

## Architect escalation

Use an architect only for a real decision class, for example:

- specification contradiction;
- architecture decision;
- tier/risk-boundary decision;
- ownership conflict that cannot be resolved from current facts;
- recovery exhausted;
- acceptance criteria impossible as written;
- review-at-cap decision requiring architectural/operator judgment.

Credentials, permissions, destructive operator choices, and direct user ambiguity are operator/user matters, not architect work.

## Review, CI, smoke, and readiness

Keep these concepts separate.

- CI is exact-head evidence, not global task completion.
- CI green is never sufficient by itself to open review; the producing worker's exact-head handoff is required.
- Review is exact-head evidence, not a worker self-report.
- Reviewers verify the exact head at admission and refuse moved/stale heads.
- Smoke is exact-head/effect evidence defined by the task.
- `ready_for_review` is a worker handoff boundary after its required pre-review obligations.
- PR-level `READY_TO_MERGE`, where used, is derived from authoritative lifecycle facts and is never asserted merely because a worker says done.
- Merge remains operator-only unless the direct user explicitly orders it.

Never convert failure, timeout, cancellation, ambiguity, missing delivery, or missing evidence into success.

## Recovery model

When an attempt appears stale/lost/failed:

```text
re-read authoritative Task/Dispatch/assignment/PR/head/report/CI/review/smoke state
-> preserve diagnostic evidence
-> determine whether the intended stage already succeeded
-> determine whether the attempt is still active
-> determine whether it is definitely failed/lost
-> determine whether ownership/head/prerequisite changed
-> choose the smallest supported next action
```

Do not begin with a lock, lease, retry daemon, permanent recovery queue, or new state store unless a real unserved requirement proves one is necessary.

Recovery helpers may observe and report. They do not terminate a live attempt on their own.

## What not to build again

Historical experiments showed repeated failure modes from adding supervision machinery around supervision machinery.

Do not recreate, unless a current task proves a unique need:

- a second resident monitor/watcher/watchdog;
- a separate heartbeat monitor that treats heartbeat as proof of useful work;
- a monitor whose own logger/watcher process becomes the health signal;
- a durable retry service for ordinary recoverable orchestration;
- a parallel lease/ack/delivery-confirm state machine;
- temporary state ledgers that duplicate authoritative GitHub/Orca/PACK facts;
- broad pane/PID/title/branch/path targeting when exact identity exists;
- infinite nudge loops;
- a second scheduler owner;
- a second task database duplicating GitHub Issues;
- a second collaboration/GitHub transport abstraction;
- compatibility layers whose only purpose is keeping retired orchestration machinery alive.

The target architecture should have fewer competing authorities and fewer background processes than the historical setup.

## Historical lessons kept; mechanisms retired

Use this disposition rule for the old Claude-memory/Gist material:

| Historical material | Disposition |
|---|---|
| Objective-state supervision lessons | **Keep** in this runbook |
| `busy != progress`, silence/heartbeat caveats | **Keep** in this runbook |
| Supervised-start-via-Orca and follow-up-consumption lessons | **Keep** in this runbook without a new ACK service |
| Exact identity and stale-attempt fencing lessons | **Keep** in this runbook |
| Re-read-before-retry and helper-fallback lessons | **Keep** in this runbook |
| One-active-attempt/stage-admission lessons | **Keep** in this runbook |
| Authoritative result-surface/address-space lessons | **Keep** in this runbook |
| Preserve-failure-evidence/termination-authority lessons | **Keep** in this runbook |
| Manager/worker/orchestrator role distinctions | **Keep** in this runbook |
| Long incident diary details | **Drop** unless needed to explain a current invariant |
| Local resident watcher/watchdog/heartbeat logger machinery | **Retire** when duplicated by current Orca/PACK facts and reconciler |
| Local broad-pane/global-nudge scripts | **Retire** when exact Task/Dispatch targeting is available |
| Local keyboard/paste task-delivery wrappers for supervised Dispatches | **Retire** in favor of `worker-start` / `dispatch --inject` |
| Local retry/ack/delivery-confirm state machines | **Retire** unless a current production requirement proves a unique remaining responsibility |
| Claude-only private orchestration memory | **Retire as authority** after useful rules are represented in tracked docs |

## Local-only legacy script cleanup

Some historical orchestration helpers may exist only on the operator machine and may never have been committed to this repository.

Those files are **not a repository worker deletion task** merely because this runbook deprecates their behavior.

After this runbook is adopted, the local orchestrator should:

1. read this runbook and the current Orca guide;
2. inventory local untracked orchestration helpers/state directories;
3. classify each `keep | replace | delete` against the current target architecture;
4. delete local-only watcher/watchdog/heartbeat/global-nudge/retry/ack/state scripts whose responsibility is now covered by Orca, PACK authoritative facts, or the deterministic reconciler;
5. delete supervised task-delivery wrappers that create/pick a pane and paste the task via terminal keystrokes when `worker-start` / `dispatch --inject` is available;
6. keep only a helper with a concrete current responsibility that is not otherwise served;
7. remove obsolete local startup/autostart hooks that would resurrect deleted helpers;
8. verify the surviving normal flow still works without those local scripts.

Do not ask an implementation worker to manufacture tracked deletions for files that never existed in git.

If local cleanup changes operator-facing configuration or supervised processes, record the exact adoption steps in the relevant PR/runbook handoff.

## Startup checklist for an orchestrator

Before supervising a new workflow:

```text
[ ] read live AGENTS.md
[ ] read this runbook
[ ] read the binding Issue/task
[ ] read the version-matched Orca orchestration guide when using Orca
[ ] verify explicit prerequisites/blockers before dispatch
[ ] identify current manager/worker Tasks and exact Dispatches
[ ] prove there is no already-active attempt for the exact stage/artifact before starting another
[ ] identify authoritative assignment/report/PR/head/CI/review/smoke facts
[ ] identify the authoritative result surface for every child/stage being started
[ ] verify prompt references are resolvable in the target executor's address space
[ ] for supervised startup use Orca worker-start (preferred) or dispatch --inject; never keyboard/paste task delivery
[ ] read the structured worker-start/dispatch result rather than infer startup from a raw return code
[ ] use deterministic reconciliation for routine states
[ ] use exact identity for effects and dispatch:<id> for supervised follow-up
[ ] use designated authorities for alarms/escalations and keep repository scope exact
[ ] invoke reasoning only for ambiguity/decision
```

## Completion checklist for a manager

```text
[ ] full authoring plan was made before work
[ ] prerequisites were satisfied or explicitly changed by operator authority
[ ] current Issue was published and read back
[ ] all required reviews apply to the current Issue revision
[ ] all required findings are fixed/adjudicated
[ ] required lens applies to the current Issue revision
[ ] every required child result reached its authoritative surface
[ ] any gate invalidated by later edits was rerun
[ ] task_ready is truthful for the current Issue
[ ] no manager-owned step remains
[ ] only now may the parent manager Dispatch send worker_done
```

## Completion checklist for a worker

```text
[ ] live Issue/rules/prerequisites were read
[ ] scoped implementation is complete
[ ] required local verification was run
[ ] PR/current exact head is published
[ ] required pre-review CI is acceptable for that head
[ ] no known worker-owned pre-review blocker remains
[ ] ready_for_review handoff is truthful and durable
[ ] only now may this worker Dispatch send worker_done
```

## Verification expectations for supervision

The implementation that claims this runbook must prove at least:

```text
[ ] noop branch reachable
[ ] continue branch reachable
[ ] orchestrator_required branch reachable
[ ] manager all-gates-satisfied branch reachable
[ ] worker ready-for-review completion branch reachable
[ ] positive idle uses current S1 semantics; contradictory evidence -> unknown
[ ] supervised Dispatch startup uses worker-start/dispatch --inject, not terminal send --enter
[ ] worker-start failed/unknown/ready receipts are interpreted from structured stage/effects/ready evidence
[ ] one bounded dispatch-addressed follow-up has later authoritative worker/lifecycle evidence or escalates without resend loop
[ ] coordinator-side check --ack is never treated as a worker-read receipt
[ ] unregistered lifecycle producer/stage -> orchestrator_required
[ ] duplicate active stage attempt is refused
[ ] review does not start on CI-green proxy alone
[ ] conversation-only child result is non-delivery when an authoritative surface is required
[ ] inaccessible prompt reference/carrier mismatch is rejected before work
[ ] failed attempt preserves diagnostic evidence until orchestrator decision
[ ] recovery helper cannot terminate a live attempt
[ ] orchestrator/reconciler return instead of blocking on external waits
[ ] stale cadence checkpoint is observable from existing durable progress evidence
```

## Maintenance rule

When a new orchestration incident teaches a durable lesson:

1. fix the real mechanism or contract;
2. update this runbook only if the lesson changes future operating behavior;
3. prefer one concise invariant over preserving an incident diary;
4. register any new lifecycle fact producer with the deterministic reader that depends on it;
5. do not put the new shared rule only into Claude memory, a private Gist, or a model-specific skill.

If this runbook conflicts with the live GitHub Issue, `AGENTS.md`, or a newer landed contract, follow the newer authoritative source and update this document in the same work so the contradiction does not remain.
