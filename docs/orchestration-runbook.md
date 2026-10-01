# Orchestration runbook

This is the shared, model-neutral operating guide for supervised work in
`orchestrator-pack`. The live GitHub Issue is the task specification. `AGENTS.md`,
current repository/GitHub state, installed version-matched Orca guidance, and the
owners named below remain authoritative.

## Mandatory read order

Before acting as an orchestrator or manager:

1. Read live `AGENTS.md`.
2. Read this runbook.
3. Read the binding live Issue/task.
4. Read task-authoring/tiering policy when creating or revising an Issue.
5. When Orca is involved, read the installed version-matched Orca orchestration guide.
6. Re-read the exact current assignment/runtime/PR/CI/review facts immediately before effects.

Workers follow the `## Worker lifecycle` section before their first side effect.

## Roles and completion

### Orchestrator

The orchestrator owns top-level ambiguity, recovery, reassignment, termination, and
architect/operator escalation. It acts from authoritative state and never infers
completion from prose, terminal appearance, process existence, or silence.

### Manager

A manager owns the complete manager workflow, not one LLM turn. Child
author/reviewer/lens completion never settles the parent manager Task.

Create-Issue procedure is owned by `.cursor/skills/create-issue-draft/SKILL.md`.
Execute-Issue multi-turn procedure is owned by
`docs/chatgpt-task-execution-runbook.md`; one-turn Browser-GPT mechanics are owned by
`docs/browser-gpt-turn-runbook.md`.

For manager-controlled Browser-GPT implementation, after settled review
the same manager Dispatch remains nonterminal. Required scenario-bearing smoke
continues in that Dispatch under phase `smoke` (`execute:smoke`); no smoke worker,
new work class, or smoke supervisor is created. The manager resolves the exact
Issue-bound PR/current head H with tracked `scripts/gh`, runs the Issue plan in one
temporary detached Git worktree at H, publishes with `worker-smoke-run publish`,
removes only that worktree, and confirms its canonical `origin/main` worktree is
unchanged (procedure:
`### Worker smoke`). The orchestrator does not wait for scheduler `ready_for_review`.
A proved assertion FAIL enters the existing fixer continuation and an explicit smoke
on the corrected head without reopening the settled pack-review stage.

The manager starts pack review with
`npm run --silent pack-gpt-review -- --pr-number <PR_NUMBER>` and never manufactures
scheduler, WorkerStatus, WorkerReport, or review-candidate state.

### Worker

A worker owns one bounded implementation through scoped changes, local verification,
PR/head publication, required CI, required pack review, review fixes, required smoke
run by the worker itself on its PR checkout, and truthful completion. Detailed obligations live in
`## Worker lifecycle`; do not restate them elsewhere.

### Reconciler

The reconciler returns only:

```text
noop | continue | orchestrator_required
```

It never sends `worker_done`, never terminates a live attempt, and never becomes a
second sender.

### Architect

The architect is a one-shot architecture/specification role. It is not a fleet
observer, scheduler, retry service, or recovery daemon.

## Executor profiles by role, tier, and smoke complexity

`scripts/executor-profile-policy.ts` is the sole semantic owner of executor
selection, validation, translation, route admission, and refusal semantics. Resolve
one profile immediately before new work:

```text
manager -> manager profile
T1 worker -> T1 profile
T2 worker -> T2 profile
T3 worker -> T3 profile
routine smoke -> routine-smoke profile
complex smoke -> complex-smoke profile
```

Tracked profile names follow one pattern:
`PACK_EXECUTOR_{MANAGER|T1|T2|T3|SMOKE_ROUTINE|SMOKE_COMPLEX}_{AGENT|MODEL|EFFORT}`.
Concrete model/effort values remain operator-local and never enter tracked task or
PR metadata.

Supported executor families are Cursor and OpenCode. Admission must prove the
selected model/effort route through the policy owner and fail closed with the closed
vocabulary:

```text
executor_route_unavailable
executor_effort_channel_unavailable
executor_route_mismatch
```

`executor_route_mismatch` is task-only. Do not add a fallback family, compatibility
token, second registry, heuristic selector, or silently drop effort. Firefighter
work reuses the routine/complex smoke profiles.

### Supervised Task launch assistant

The canonical composition point for supervised manager/T1/T2/T3 starts is
`scripts/pr2-foundation/supervised-task-launch-assistant.ts`. It owns internal
double-null timing, selector resolution, ff-only refresh steps, structured envelopes,
and provider-recovery internals. Agents preserve only the obligations below.

Before effects, pass the assistant's repository/runtime/profile preflight. A fresh
worktree must have supported setup proof; a reused worktree must have supported
reuse proof. For manager continuation, the exact Run/Task and caller-supplied
worktree selector must identify one clean manager-local non-main branch; after those
identity checks, refresh it from `origin/main` only with the assistant's ff-only
path. Never reset, rebase, merge, force-repair, replace the worktree, or mutate the
shared primary checkout as recovery.

Canonical worker launch:

```bash
node --experimental-strip-types scripts/lib/Invoke-TypeScriptCli.ts \
  --script scripts/pr2-foundation/supervised-task-launch-assistant.ts -- \
  --repository <owner/repo> --work-class <t1|t2|t3> --issue-number <N> \
  --task <task-id> --worktree-name <worktree-name> --base-branch <base-ref>
```

Manager with an existing Task uses `--work-class manager --run <run-id> --task
<task-id> --worktree <worktree-selector>`. Manager creation uses `--work-class
manager --run <run-id> --manager-brief <caller-serialized-brief> --worktree-name
<name> --base-branch origin/main`.

Launch/status/`nextAction` handling is owned once in `## Deterministic reconciliation`.

## Supervised initial delivery and WorkerAssignment

Supervised starts finish through
`scripts/pr2-foundation/supervised-worker-start.ts::runSupervisedWorkerStart`.
Publish a local WorkerAssignment only after Orca returns a proven `ready` receipt
with both Task and Dispatch identity. Failed, malformed, or outcome-unknown startup
does not publish a successful assignment.

When a manager starts before an Issue exists, store the assignment by its canonical
Task/Dispatch deliverable identity and attach the positive Issue later to that same
record. Recognized `issue-<N>` stores migrate only through the existing assignment
store path; never create an alias, dual lookup, or second writer.

`scripts/lib/worker-assignment-store.ts` owns durable record fields and
dead-observation mechanics. Agent-facing publication, migration, and exact-binding
rules stay here; the field inventory does not.

## Exact local runtime binding

Runtime effects require the registered RuntimeAdapter to resolve the current
assignment to an exact adapter-produced `{runtime,id,generation}` identity in
memory. Missing, stale, ambiguous, remote/not-applicable, unsupported, reused, or
mismatched evidence fails closed and performs no routine effect.

Never authorize effects from PR/session/title/path/pane/PID heuristics or a stale
handle. Re-read the exact current runtime identity before each effect.

## S1 — single observation authority

`scripts/pr2-foundation/fleet-observer.ts` is the only S1 observer. Do not add
another observer, idle detector, pane debounce, or monitor. The only exception is
the advisory fleet alarm in `docs/fleet-alarm.md`, which may wake the coordinator
but never authorizes unit effects.

Process, pane, spinner, heartbeat, or process existence is not progress or completion
evidence.

## S1 continuity across bounded scheduler children

`scripts/pr2-foundation/fleet-observer.ts` and `scheduler.ts` own S1 snapshot,
activation-lineage, classification, and continuity mechanics. Agents do not
reconstruct or persist those mechanics elsewhere. Each bounded child still re-reads
current assignments and current adapter identities before any effect.

## S2 — single routine continuation actuator

`scripts/pr2-foundation/fleet-nudge-actuator.ts` is the only routine continuation
sender. Its stores own episode, budget, claim, gate, and journal mechanics.

Do not dual-send through Orca mail or another transport. `dispatch_unknown` is
uncertain and never authorizes automatic resend or alternate transport.

## Bound-run inbox drain and acknowledgement

At each guarded lifecycle boundary, drain the exact bound Run through
`RuntimeAdapter.checkInbox` until authoritative empty or the existing deadline.
Process every message in one Delivery before acknowledging it. If any message
fails, do not acknowledge the Delivery and do not advance.

Exactly one acknowledgement is issued per Delivery, never per message. Missing,
malformed, foreign, unsupported, ambiguous, duplicate/concurrent-ack, or
deadline-exhausted evidence is not empty and never authorizes resend.

Role obligations are mandatory:

- **Manager:** drain before starting or claiming the next authoring/review round, immediately before manager `worker_done`, and immediately before ending a turn without `worker_done`.
- **Worker:** drain immediately before worker `worker_done` and before emitting a blocker/escalation that hands control upward.
- **Coordinator / flow-manager / orchestrator acting on the bound Run:** drain before issuing a reply, ruling, escalation decision, or dispatch, and again before reporting its own turn complete.

Supervised agents do not emit `type: heartbeat` / `subject: alive` control chatter merely to assert liveness.
A supervised agent with no actionable report sends nothing.
A supervised manager emits `worker_done --outcome succeeded` exactly once, and only after acceptance satisfies its existing whole-task completion contract.
`recoverable`, `external_pause`, and `contract_defect` never complete or settle the parent task.
A manager sends `worker_done --outcome failed` only after a direct coordinator/operator cancellation message, never because a repository-owned check refused or paused work.
S1 remains the sole liveness observer.

## Create-Issue GitHub completion

For create-Issue author/reviewer/lens work, workflow completion is determined
from the live GitHub Issue state defined by
`.cursor/skills/create-issue-draft/SKILL.md`. A published revision-named
review comment can complete its review turn even while a Browser-GPT transport
envelope is still pending; conversely a terminal child/envelope without the
required GitHub comment does not satisfy create-Issue review or acceptance.

Do not add a second create-Issue completion store or workflow-specific
transport authority. Transport uncertainty follows the shared no-blind-resend
and same-invocation recovery contract in `docs/browser-gpt-turn-runbook.md`.

## Scheduler inbox reconciliation

The existing scheduler tick owns orchestration-mail reconciliation and
dispatch-terminal mail. `scripts/cursor-unsent-composer-submit.ts` owns composer
classification, pointer submission, render timing, and unread-episode mechanics;
agents do not reproduce them.

After each successful or ambiguous repository-governed `orchestration send` or
`reply`, run exactly one companion action:

```text
node --experimental-strip-types scripts/cursor-unsent-composer-submit.ts \
  --delivery --message-id <exact-message-id>
```

For blocking `ask`, run the companion action after the bounded initial wait returns
the committed message id, then resume the same ask through Orca's returned recovery
action. If the sender cannot prove one exact message and recipient, leave the
composer untouched and report the delivery for orchestrator handling. Do not create
a second question, alternate transport, or blind resend.

## Scheduler phases

Phase 1 is `S1 observation -> deterministic reconciliation -> existing S2 when
admitted -> durable orchestrator_required handoff when reasoning is required`.

Phase 2 starts review only from the existing `liveCandidates()` path for
`ready_for_review` workers with PR/head binding. Managers and pre-handoff workers are
not widened into that candidate set.

`scripts/lib/orchestrator-side-process-supervisor.ts` owns bounded scheduler-child
cadence and stall/restart mechanics. Do not replace it with another daemon, timer,
watcher, or watchdog.

The scheduler does not start, observe, or reconcile smoke. The PR owner executes a
required scenario-bearing plan itself; the managed path keeps the same execute-Issue
manager and its bounded temporary detached checkout. No replacement poller or queue
exists.

## Durable `orchestrator_required` handoff

`scripts/pr2-foundation/fleet-reconciliation-handoff.ts` owns
`fleet-reconciliation-handoff/v1` shape and persistence mechanics. It is latest-state
evidence, not a queue or lifecycle authority.

The orchestrator/operator reads the latest handoff before treating fleet silence as
healthy. A required handoff commit/read-back failure makes the scheduler tick
non-success; there is no fallback notification transport.

## Deterministic reconciliation

Reconciliation returns only `noop | continue | orchestrator_required`. `continue`
goes only through the existing S2; unresolved or ambiguous effects go to
`orchestrator_required`.

Only the merge agent updates a branch from `origin/main`, once, immediately before
merge. Workers and coordinators never merge `main` merely to clear BEHIND.

A new manual review
`npm run --silent pack-gpt-review -- --pr-number <PR_NUMBER>` starts only when
review-independent required CI is green on the exact current head;
`orchestrator-pack/pack-review` itself is excluded from that check.

For a frozen three-source review round, 3/3 settles normally. After the existing
stale/grace threshold, 2/3 may settle once as
`Sources: 2/3 (degraded after timeout)`; fewer than two usable sources stays
incomplete.

Recover an interrupted or stale review through:

```text
node --experimental-strip-types scripts/pack-review-runner.ts reconcile \
  --source-repo-root <path> --repo-slug <owner/repo> \
  --pr-number <PR_NUMBER> --immediate
```

Never start a replacement review on the same head merely because a runner/browser
child stopped.

A launch counts as started only on `outcome=ready` /
`ready_and_assignment_bound`. Provider recovery runs only through the returned
`nextAction`; handled continuation never authorizes a fresh start.

## Structured external-dependency parking

The manager boundary uses the existing closed outcomes `completed`, `recoverable`,
`external_pause`, and boundary-only `contract_defect`. On `recoverable`, execute the
returned non-null `nextAction.argv` once. A byte-identical consecutive action is not
executed again; escalate it as a producer defect.

Supply `--blocked-on-json` only when the coordinator authoritatively knows the named
Issue/PR predicate is the exact active blocker. Keep the supplied
`issue_closed | pr_merged` predicate and evidence unchanged; never infer dependency
identity from prose, cause, blocker text, reverse lookup, or the managed Issue.
`{ coordinator: true }` means the existing coordinator owns the remedy and
continuation to the same Dispatch. The prior boolean input is normalized in memory
to `{ coordinator: true }`; `issue_closed` and `pr_merged` remain unchanged.

For `external_pause` or `contract_defect`, send one escalation with a deterministic
thread id derived from `(issue, stage, cause, resume_when)`. Retry a failed
escalation send exactly once. The unit stays paused and nonterminal; never
re-dispatch the same argv into a live paused Dispatch. Resume only through the
existing coordinator wake when the typed predicate is satisfied.

Inbox drain and `worker_done` obligations are owned by
`## Bound-run inbox drain and acknowledgement`; parking does not redefine them.
Browser-GPT `TerminalEnvelope` remains a separate transport and is unchanged.
Do not add a parking store, watcher, poller, reverse-dependency service, or second
persistent coordination mechanism.

## Core operating laws

1. Objective state is authoritative; prose and terminal appearance are context only.
2. Keep one Dispatch across recoverable substeps; create a fresh one only for a real
   task/subtask/reviewer/correction/reassignment/retry boundary.
3. Re-read authoritative state before retry; timeout or helper loss does not prove
   failure.
4. Helper failure is recovery first; escalate only for missing capability/permission,
   ownership/spec conflict, destructive choice, or exhausted legitimate recovery.
5. External waits do not hold the orchestrator foreground in sleep/poll loops.
6. Exact composite identity is mandatory before effects; first-match heuristics never
   authorize effects.
7. At most one active attempt exists per exact stage artifact; retry/reassignment
   requires prior terminal/lost/replaced evidence.
8. Downstream stages open on authoritative producer handoff, not proxy signals such as
   PR existence, CI green, or idle state.
9. Durable delivery uses the Task's named authoritative surface; conversation-only
   output is not delivery when a durable carrier is required.
10. Prompt references must resolve in the receiver's address space and use the correct
    carrier class.
11. Preserve failure diagnostics until orchestrator read-back.
12. Observer/reconciler/nudge/recovery code never owns termination of a live attempt.
13. Alarms use designated authority, current scope, and self-echo filtering.

## Production verification

### Browser-GPT modal capability

Before Browser-GPT turns, verify that the pack-owned rate-limit modal capability is
running against the configured automation browser. Require visible startup/attached
page evidence and a recent scan; a PID, old log line, or waiting turn is not proof.
If absent, start the documented modal-watcher entrypoint against the same browser
debugging endpoint and re-check before launch or retry.

The watcher is not an agent observer, scheduler, retry service, or send authority.
Dismissing a modal does not prove delivery or clear a server-side limit; preserve
the Browser-GPT send/no-resend contract.

Run current-head repository verification, required CI, and applicable review
obligations for the work being completed.

## Orca grounding

`worker_done` means completion of the active Dispatch/Task, not one conversational
turn. Use existing pack-side recovery for named Orca conditions:

- `nested_worker_depth_exceeded` -> use the existing pane-launch path instead of nesting another worker;
- `dispatch_capability_invalid` -> use the existing orchestration mailbox fallback/path instead of re-dispatching the revoked capability;
- `consumer_fenced` -> re-read the exact current runtime/terminal handle before any effect;
- `stable_pane_required` -> re-read the exact current runtime/terminal handle before any effect.

For the last two cases, never act on a stale, reused, or guessed handle. Do not patch
Orca core to encode PACK role stages.

## Operator adoption

Repository merge does not prove machine activation. When a change affects
operator-facing runtime/configuration/process behavior, adopt it through the
existing supported operator path and prove the intended live state through a
target-specific supported read-back before claiming activation.

The implementation PR carries the reusable operator handoff rule in
`### Operator adoption handoff`; one-time rollout history does not belong in this
runbook.

## Worker lifecycle

Workers, orchestrators, and managers read this section before the first side effect.
Direct user authority may override a repository stop rule, but a tier mismatch
remains reportable evidence.

### Worker pre-flight

Before implementation, re-read the live task and apply the T1/T2/T3 failure-type
rubric. When reality exceeds the assigned tier, stop and escalate upward; never
silently proceed.

### Runtime identity

Runtime effects require an adapter-produced `{runtime,id,generation}` identity.
Resolve the exact target through the registered runtime adapter. Missing, stale,
malformed, reused, or mismatched identity performs no effect.

### Review / CI / handoff contract

Required CI is exact-current-head evidence. Missing, pending, cancelled, failed, or
earlier-head required checks are not green. Green CI alone is not exit: complete
review and handoff obligations for the same current head.

Pack review is a PR/task-cycle obligation with logical-round caps T1=1, T2=1, T3=2.
A T3 clean round 1 still requires round 2. Once required rounds and findings settle,
the durable `reviewStageComplete` state prevents later commits, smoke fixes, or
CI-only changes from reopening the required stage. A cap never converts findings
into approval.

Manual start, degraded-source settlement, and interrupted-review recovery follow
`## Deterministic reconciliation`; do not duplicate those rules here.

### Main-update sequencing

The merge agent performs the sole branch update from `origin/main` once,
immediately before merge, after same-PR smoke readiness and current-head required CI
are satisfied. Workers and coordinators never merge `main` merely to clear BEHIND.

#### Pack-review recovery recipe

Use the `reconcile --immediate` recipe in `## Deterministic reconciliation`.
Required CI remains bound to the current head; one same-PR smoke PASS at any report head satisfies smoke readiness and is not a review-settlement gate.

### Required CI

Use protected-branch required checks when configured; otherwise require every pack
merge-contract check for the current head. Do not report `ready_for_review` while
required CI is non-green. Fix red CI; a pending head stays engaged until green, red,
or an evidence-backed degraded-CI handoff through
`scripts/lib/worker-degraded-ci-handoff.ts`. Never turn failure, cancellation,
timeout, ambiguity, or missing evidence into success.

### Worker report store

Report lifecycle state through:

```text
pack-worker-report --state <ready_for_review|fixing_ci|addressing_reviews|completed|blocked>
```

If the command cannot prove current repository, worker, PR, and head binding, skip
only that report write and continue the required task. Do not substitute comments
for durable report state.

### PR-created handoff

After PR creation, self-drive through current-head CI, review findings, smoke, and
handoff. Use `addressing_reviews` while fixing delivered findings, then `fixing_ci`
as needed, and return to `ready_for_review` only when required CI is green. Do not
idle with open findings or disengage without a truthful current-head handoff.

### Review-cycle cap

The tracked review-cycle authority owns `clean_early_stop` and
`at_cap_open_findings`. First clean eligible head may early-stop; open findings at
cap require architect/operator triage. Cap exhaustion never approves findings and
never authorizes another automatic/common reviewer-model call.

### Worker smoke

After review convergence and green required CI, the PR owner executes a required
scenario-bearing `smoke-test-plan` itself and publishes the existing
`pack-worker-smoke-report/v1` comment. A plain worker/firefighter uses its existing
PR checkout. The managed execute-Issue manager reads exact Issue-bound P/current H
through tracked `scripts/gh`, records its canonical manager worktree
HEAD/branch/status, fetches H, creates one unique detached temporary worktree T at H,
verifies T's HEAD, runs the plan and `worker-smoke-run publish --repo-root T`,
removes only T, and confirms the canonical manager worktree is unchanged before
consuming the publish record. This is ordinary local Git state, not a PACK worktree
lifecycle; do not use global `git worktree prune` or alter the manager's
`origin/main` refresh contract. Detail is owned by `docs/worker-smoke-testing.md`.

`publish` stamps local HEAD, has no expected-head input, and does not inspect
live-head equality or CI. Setup failure occurs before publication and claims no
PASS. Cleanup failure after a successful POST authorizes neither republish nor
manager PASS-completion consumption. The newest same-PR PASS remains reusable across
later heads without filtering by actor; required CI remains separately bound to the
current head. A proved assertion FAIL is handled by the existing fixer continuation
and an explicit subsequent smoke execution, never an automatic harness retry.

### Orchestrator-delegated integration

After implementation/review/CI/smoke readiness, delegated merge/adoption/cleanup is
owned by the [orchestrator-delegated integration runbook](orchestrator-delegated-integration.md).
Do not replace it with another role, store, queue, lock, evaluator, or outcome
ledger.

### Operator adoption handoff

When work changes operator-facing configuration, runtime selection, supervised
processes, environment variables, or tracked policy delivery, add a precise
`## Operator adoption` section to the PR body. Workers document adoption but do not
mutate the operator's machine unless the direct user orders it.

A cosmetic documentation-only change may state `No operator adoption required`.