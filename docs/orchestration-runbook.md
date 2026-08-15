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
  -> understand scope/tier
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

It never emits `worker_done` for an agent.

### Architect

The architect is an expensive, one-shot reasoning role for genuine architecture/specification decisions.

It is not a monitor, scheduler, retry service, or substitute for normal manager recovery.

## Core operating laws

These are the durable lessons migrated from the historical orchestration experiments and incident analysis.

### 1. Watch the objective, not the worker story

The primary question is not “does the worker say it is working?” but “what authoritative task/lifecycle fact is true now?”

Useful objective facts include, as applicable:

- current GitHub Issue revision;
- current WorkerAssignment generation;
- current Task/Dispatch identity;
- current PR and exact head;
- required CI state for that head;
- current review result/findings for that head;
- current smoke result for that head;
- current durable WorkerReport/WorkerStatus facts;
- exact RuntimeAdapter identity and current Orca Dispatch provenance.

Worker prose is context, not sole lifecycle authority.

### 2. `busy` is not `progress`

A live process, active pane, spinner, terminal existence, heartbeat, CPU usage, or unchanged scrollback does not prove useful progress.

For output-based observation:

- new bounded output after a known baseline is evidence of activity;
- positive idle is evidence that the agent can accept work;
- busy with unchanged output is unknown/no-progress evidence, not proof of healthy work;
- gone/stopped is a liveness fact, not proof that the task result is absent;
- contradictory or unreadable observation is `unknown`, not permission for a destructive action.

### 3. Silence proves nothing by itself

No output for ten minutes does not by itself prove:

- failure;
- health;
- completion;
- a safe retry boundary.

Time is only a checkpoint trigger for re-reading facts.

### 4. Evidence that matters must be re-readable

If a lifecycle decision depends on a fact, prefer evidence that survives outside the process that produced it.

Examples include GitHub state, durable reports, exact-head CI/review/smoke results, and Orca Task/Dispatch records.

Do not make a temporary log, a hidden terminal buffer, or one model's private memory the only place a required fact exists.

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
Did I read the full Task contract?
Did I execute every required stage for my role?
Are required child results current and available?
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
4. current task-authoring/tiering policy required for the requested task.

Then it writes a short ordered plan covering the **whole** task-creation workflow before starting child work.

### Authoring

The manager starts or reuses the proper authoring path to create/revise the Issue.

After publication, it reads the current GitHub Issue back. A tool success message without read-back is not enough when the result matters to later gates.

### Review loop

Run the number/type of independent task reviews required by current task-tier policy.

If a review finds a material issue:

```text
review finding
-> author/fix current Issue
-> read back new Issue revision
-> previous review is stale for changed content
-> run a fresh required review against current revision
```

Do not count a clean review of an old Issue revision as evidence for a changed one.

### Lens

Run the required architectural lens for the task tier.

If the lens causes a meaningful Issue change, rerun every earlier gate invalidated by that change.

### Manager completion

The manager may report `task_ready` and send its parent `worker_done` only when the **current published Issue revision** has all required authoring/review/lens gates satisfied.

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

The worker reads the live Issue and repository rules, resolves the exact current assignment/runtime identity, and plans the full implementation handoff.

### Implement and verify

The worker implements only scoped changes and runs required local verification.

### Publish and self-fix pre-review CI

The worker creates/updates the PR, records the exact current head, and handles worker-owned required pre-review CI failures for that head.

A red required head is not ready. A pending required head is not green.

### Worker completion

The worker may send successful `worker_done` only after it has a truthful current-head `ready_for_review` handoff and no known worker-owned pre-review blocker remains.

A PR existing is not enough. Code merely compiling is not enough.

If later independent review or smoke produces implementation findings, that is a **new correction Task/Dispatch** after the previous bounded worker handoff.

## Deterministic supervision loop

Use an existing scheduler/cadence owner. Do not add another resident watcher merely to run this loop.

At a maximum ten-minute checkpoint interval for active local Dispatches:

```text
read authoritative lifecycle facts
-> read bounded runtime/liveness observation
-> classify
-> perform at most one allowed effect
-> return
```

The timer is only the maximum re-check cadence. It never proves failure or progress.

### Manager cases

| Facts | Decision |
|---|---|
| manager active / child author-review-lens work running | `noop` |
| positive idle + Issue missing required review | `continue` |
| positive idle + current review findings unresolved | `continue` |
| positive idle + required lens missing | `continue` |
| positive idle + helper failed but supported recovery remains | `continue` |
| all current manager completion gates satisfied | `noop` (manager may complete) |
| repeated actionable idle after one bounded continuation | `orchestrator_required` |
| liveness/ownership/recovery facts ambiguous | `orchestrator_required` |

### Worker cases

| Facts | Decision |
|---|---|
| new output / active progress | `noop` |
| positive idle + implementation/fix work remains | `continue` |
| positive idle + required pre-review CI red | `continue` |
| current head is truthfully `ready_for_review` with no worker-owned action left | `noop` (worker may complete) |
| repeated actionable idle after one bounded continuation | `orchestrator_required` |
| gone/stopped/identity ambiguity | `orchestrator_required` |

### Bounded continuation

A normal continuation goes only to the exact current local Task/Dispatch/runtime target and should be short, for example:

> Continue the current assigned Task. Re-read current authoritative facts, execute the next role-owned action from your existing plan, and do not settle the Dispatch while any required stage remains. If a genuine unresolved blocker remains after supported recovery, report the evidence and attempts already made.

Do not broadcast or create a new Dispatch merely because the agent returned idle.

## Orchestrator exception path

`orchestrator_required` means deterministic policy cannot safely choose the next effect.

The orchestrator may:

- answer an `ask`;
- resolve an ordinary ownership/recovery ambiguity;
- restore or select a supported recovery route;
- decide whether an attempt is truly failed/lost and should be retried;
- reassign work;
- invoke an architect or operator for a genuine decision.

The orchestrator should not become a permanent polling LLM.

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
- Review is exact-head evidence, not a worker self-report.
- Smoke is exact-head/effect evidence defined by the task.
- `ready_for_review` is a worker handoff boundary after its required pre-review obligations.
- PR-level `READY_TO_MERGE`, where used, is derived from authoritative lifecycle facts and is never asserted merely because a worker says done.
- Merge remains operator-only unless the direct user explicitly orders it.

Never convert failure, timeout, cancellation, ambiguity, or missing evidence into success.

## Recovery model

When an attempt appears stale/lost/failed:

```text
re-read authoritative Task/Dispatch/assignment/PR/head/report/CI/review/smoke state
-> determine whether the intended stage already succeeded
-> determine whether the attempt is still active
-> determine whether it is definitely failed/lost
-> determine whether ownership/head/prerequisite changed
-> choose the smallest supported next action
```

Do not begin with a lock, lease, retry daemon, permanent recovery queue, or new state store unless a real unserved requirement proves one is necessary.

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
| Exact identity and stale-attempt fencing lessons | **Keep** in this runbook |
| Re-read-before-retry and helper-fallback lessons | **Keep** in this runbook |
| Manager/worker/orchestrator role distinctions | **Keep** in this runbook |
| Long incident diary details | **Drop** unless needed to explain a current invariant |
| Local resident watcher/watchdog/heartbeat logger machinery | **Retire** when duplicated by current Orca/PACK facts and reconciler |
| Local broad-pane/global-nudge scripts | **Retire** when exact Task/Dispatch targeting is available |
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
5. keep only a helper with a concrete current responsibility that is not otherwise served;
6. remove obsolete local startup/autostart hooks that would resurrect deleted helpers;
7. verify the surviving normal flow still works without those local scripts.

Do not ask an implementation worker to manufacture tracked deletions for files that never existed in git.

If local cleanup changes operator-facing configuration or supervised processes, record the exact adoption steps in the relevant PR/runbook handoff.

## Startup checklist for an orchestrator

Before supervising a new workflow:

```text
[ ] read live AGENTS.md
[ ] read this runbook
[ ] read the binding Issue/task
[ ] read the version-matched Orca orchestration guide when using Orca
[ ] identify current manager/worker Tasks and exact Dispatches
[ ] identify authoritative assignment/report/PR/head/CI/review/smoke facts
[ ] use deterministic reconciliation for routine states
[ ] use exact identity for effects
[ ] invoke reasoning only for ambiguity/decision
```

## Completion checklist for a manager

```text
[ ] full authoring plan was made before work
[ ] current Issue was published and read back
[ ] all required reviews apply to the current Issue revision
[ ] all required findings are fixed/adjudicated
[ ] required lens applies to the current Issue revision
[ ] any gate invalidated by later edits was rerun
[ ] task_ready is truthful for the current Issue
[ ] no manager-owned step remains
[ ] only now may the parent manager Dispatch send worker_done
```

## Completion checklist for a worker

```text
[ ] live Issue/rules were read
[ ] scoped implementation is complete
[ ] required local verification was run
[ ] PR/current exact head is published
[ ] required pre-review CI is acceptable for that head
[ ] no known worker-owned pre-review blocker remains
[ ] ready_for_review handoff is truthful
[ ] only now may this worker Dispatch send worker_done
```

## Maintenance rule

When a new orchestration incident teaches a durable lesson:

1. fix the real mechanism or contract;
2. update this runbook only if the lesson changes future operating behavior;
3. prefer one concise invariant over preserving an incident diary;
4. do not put the new shared rule only into Claude memory, a private Gist, or a model-specific skill.

If this runbook conflicts with the live GitHub Issue, `AGENTS.md`, or a newer landed contract, follow the newer authoritative source and update this document in the same work so the contradiction does not remain.