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
`npm run --silent pack-gpt-review -- --project <PROJECT_ID> --session-id <MANAGER_SESSION_ID> --pr-number <PR_NUMBER>`
when it will park on the existing review-completion notification. The session id is the exact
already-owned supervised session identity, never inferred from branch/worktree/title/PID. If no
such binding is available, omit `--session-id`, keep the review command foregrounded/observed,
consume its terminal result directly, and do not park waiting for `workerNotification`.
The manager never manufactures scheduler, WorkerStatus, WorkerReport, or review-candidate state.

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

It is a continuation-safe launch assistant, not a lifecycle authority. It owns
only the shared mechanical sequence: Node/repository preflight; the production
profile/route admission edge; manager Run/Task admission; supported worktree
setup/reuse proof; at most one fresh RuntimeAdapter-created internal terminal;
two fresh-start Dispatch absence witnesses; launch timing/diagnostics; and the
call to the existing supervised-start boundary. It creates no durable retry
state, queue, lease, WorkerReport/WorkerStatus, scheduler, or second assignment
store.

The calling shell first exports the matching stable profile names. The profile
checkpoint validates the closed executor family, executor-specific model catalog,
model/effort request channel, caller `startMode` when present, and child inheritance
before any manager Task or runtime effect. The returned admitted route is attempt
state: later recovery reuses it and never re-reads mutable live profile values.

Invoke through the canonical wrapper under the Node major declared in `scripts/toolchain/node-version.json`. Exactly one of `--worktree` (a
supported proven-reuse target) or `--worktree-name` (a fresh setup path) is
required by the assistant.

T1 — canonical worker launch:

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
`npm run --silent pack-gpt-review -- --project <PROJECT_ID> [--session-id <SESSION_ID>] --pr-number <PR_NUMBER>`
starts only when review-independent required CI is green on the exact current head;
`orchestrator-pack/pack-review` itself is excluded from that check. A supervised caller that will
park on completion supplies its exact owned session id; an unbound caller omits the option and
keeps the command foregrounded/observed instead of waiting for a notification target that does not exist.

For a frozen three-source review round, 3/3 settles normally. After the existing
stale/grace threshold, 2/3 may settle once as
`Sources: 2/3 (degraded after timeout)`; fewer than two usable sources stays
incomplete.

The coordinator/task dispatch may supply `--blocked-on-json <json>` only when
it authoritatively asserts that the named external dependency predicate is the
active unsatisfied blocker for that exact manager invocation. The supplied
object is a task invariant, not manager-discovered state. It is exactly one of
`{ issue: <positive integer>, condition: "issue_closed", evidence: <non-empty> }`
or `{ pr: <positive integer>, condition: "pr_merged", evidence: <non-empty> }`.
Manager code validates this input and projects it to
`external_pause(external:waiting_on_issue|external:waiting_on_pr)`; the
`pause.resume_when` predicate keeps the same selector and condition and
`pause.evidence` keeps the supplied evidence. Never manufacture that dependency
identity, predicate, evidence, or causality from `cause`, `blocker`, prose,
the managed Issue number, reverse search, guessed PR linkage, or a null action.

On `recoverable` execute the returned `nextAction.argv` once. If the next
result recommends a byte-identical argv, do not execute it again: send one
`escalation` naming the producer and continue independent plan items. On
`contract_defect` send one `escalation` naming the producer and continue
independent plan items. On `external_pause` send one `escalation` with its
`remedy` and continue independent plan items. Before ending a turn without
`worker_done`, drain the inbox. Never send `worker_done --outcome failed` for
any of these. Do not synthesize the refused effect through another tool.

For `external_pause` and `contract_defect`, use
`orca orchestration send --type escalation --thread-id <escalation-id>`.
Derive `escalation-id` deterministically from
`(issue, stage, cause, resume_when)`; the receiver treats the same thread id as
the same escalation. Keep no sender-side send record. If the escalation send
itself fails, retry it exactly once, then continue every independent plan item
and perform the required non-blocking inbox drain before ending the turn without
`worker_done`.

A live Dispatch whose most recent manager message is that escalation is a
**paused unit** while `worker-show` remains non-terminal. The coordinator
identifies it from the Run inbox plus that non-terminal `worker-show` state and
must not re-dispatch the same argv into it. On each existing coordinator wake or
restart, re-read only the typed `resume_when` condition through tracked
`scripts/gh`: `issue_closed` is satisfied only by the named Issue
`state=closed`; `pr_merged` only by the named PR `merged=true`; and
`{ coordinator: true }` means the existing coordinator owns clearing the named dependency and sending the
continuation to the same Dispatch. Legacy `{ operator: true }` is input compatibility only and is normalized
in memory to `{ coordinator: true }`; `issue_closed` and `pr_merged` are unchanged. Until a separate coordinator
sweep/wake change lands, resumption occurs only on existing coordinator wakes; that is a latency limitation,
not permission to settle the Task.

Dispatch/re-dispatch payloads contain role plus task invariants only. Procedure
comes from the current CLI `--help` and returned `nextAction`; do not re-paste
the create-Issue skill or runbooks into repeated dispatches. Browser-GPT
`TerminalEnvelope` remains a separate transport and is unchanged. This
contract adds no watcher, polling daemon, queue, lease, parking store,
acknowledgement protocol, prose parser, reverse dependency lookup, epoch,
fingerprint record, or second persistent coordinator mechanism.

## Core operating laws

1. Watch objective state: live Issue/Task, assignment generation, S1, S2, PR/head, CI/review/smoke and accepted reports. Worker prose is context only.
2. Completion follows the canonical heartbeat/`worker_done` rule above; end-of-turn, substep, wait, helper failure, question, escalation, timer expiry, `recoverable`, `external_pause`, and `contract_defect` never satisfy it.
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

Also run current-head repository verification, declared-runtime typecheck/lint, affected tests, scope guard, runtime-retirement scan, required CI and current-revision review/lens obligations.

## Orca grounding

At #1420 r14 implementation time, the Orca orchestration guide already defines `worker_done` as completion of the active Dispatch/Task rather than completion of one conversational turn, and the supported initial supervised startup path is `worker-start` / `dispatch --inject`. Therefore PACK does not patch Orca core or hardcode PACK role stages upstream.

For named Orca conditions, keep recovery on existing pack-side paths without
changing Orca runtime behavior:

- `nested_worker_depth_exceeded` -> use the existing pane-launch path instead of nesting another worker;
- `dispatch_capability_invalid` -> use the existing orchestration mailbox fallback/path instead of re-dispatching the revoked capability;
- `consumer_fenced` -> re-read the exact current runtime/terminal handle before any effect;
- `stable_pane_required` -> re-read the exact current runtime/terminal handle before any effect.

For `consumer_fenced` and `stable_pane_required`, exact composite identity
remains mandatory: never act on a stale, reused, or guessed handle.

Repository evidence used during implementation: Orca orchestration guide blob `d43a59d7b33e50126efb268184c1a1af38dd4f8a`. The operator must still use/read the installed version-matched guide on the target machine; this repository evidence is not a claim about the installed machine version.

## Operator adoption

Repository merge does not prove machine activation.

After landing the production implementation:

1. adopt the merged PACK revision through the existing supported operator deployment path;
2. preserve the registered side-process supervisor and `pr2-scheduler` child shape;
3. let the first mutating WorkerAssignment path migrate a recognized pre-#1441 `issue-<N>` store (exact `*.pre-task-dispatch-migration` backup, then one canonical rewrite); do not hand-convert, alias, or dual-resolve records; pass explicit `--role worker|orchestrator` on registration;
4. start new supervised manager/T1/T2/T3 work through the supervised Task launch assistant; treat only `outcome=ready`/`ready_and_assignment_bound` as started, and execute only the exact `nextAction` for handled continuations or provider recovery;
5. for one manager authoring launch without an Issue, confirm the assignment is task/Dispatch-keyed with absent Issue metadata, then attach the Issue only after publication without changing the deliverable key/id/generation;
6. verify one stale/remapped runtime identity fences without a stale-handle effect and one Orca error envelope preserves its exact non-empty `error.code` while any provider mutation recovery remains attempt-bound and safely projected by the assistant;
7. perform one controlled selected-profile adoption smoke for every executor family actually admitted on the installed machine; an OpenCode external gate is a valid fail-closed result, not permission to invent a provider/TUI form;
8. before restarting/adopting the supervisor revision, verify the scheduler no longer starts or observes post-review smoke and that one epoch-authorized `scheduler.ts tick` still processes review/CI candidates. The ordinary review-settled worker/orchestrator handoff launches independent smoke; the manager-controlled handoff remains separately supervised. Do not treat a historical pre-cutover smoke lifecycle as a new admission gate.
9. verify later bounded children retain the same trusted S1 lineage and advancing tick sequence;
10. verify one exact REST-visible author/reviewer artifact settles its manager turn even when the helper child is silent/gone, and one published sibling makes a silent concurrent slot possible-or-actual/no-resend without claiming that its payload was proven delivered;
11. verify the latest `fleet-reconciliation-handoff/v1` is readable before treating silence as healthy.

Do not claim live machine supervision before this read-back.

## Worker lifecycle

Workers, orchestrators, and managers read this section before the first side
effect. Direct user authority may override a repository stop rule, but a tier
mismatch remains reportable evidence.

### Worker pre-flight

Before implementation, re-read the live task and apply the T1/T2/T3
failure-type rubric. When reality exceeds the assigned tier, stop and escalate
upward; never silently proceed.

### Runtime identity

Runtime effects require an adapter-produced `{ runtime, id, generation }`
identity. Resolve the exact target through the registered runtime adapter.
Missing, stale, malformed, reused, or mismatched identity performs no effect.
Never reinterpret a session-like string, title, branch, path, or process ID as
authority.

### Review / CI / handoff contract

Local Codex PR review is active through the pack-owned review runner. GitHub PR
review is the authoritative verdict; the pack run store is operational state.

- the canonical prescriptive review entrypoint is `npm run --silent pack-gpt-review -- --project <PROJECT_ID> [--session-id <SESSION_ID>] --pr-number <PR_NUMBER>`; a supervised caller that will park supplies its exact already-owned session id, while an unbound caller omits it and keeps the command foregrounded/observed; scheduler/internal starts remain implementation details;
- the live PR supplies the current head and its closing reference supplies the Issue;
- session-binding cache data is advisory correlation only and cannot veto a valid
  PR-led start or substitute a different repository, head, or Issue;
- a missing exact bound Issue snapshot is captured only after the existing start
  claim is acquired, so concurrent first starts freeze one durable Issue body;
- manual Browser-GPT review uses
  `npm run --silent pack-gpt-review -- --project <PROJECT_ID> [--session-id <SESSION_ID>] --pr-number <PR_NUMBER>`;
  a supervised manager/worker supplies the exact already-owned session id before parking on completion,
  while an unbound invocation stays foregrounded/observed and consumes its terminal result directly;
  a new manual review starts only when review-independent required CI is green for the exact current
  PR head, with `orchestrator-pack/pack-review` itself excluded from that precondition;
- review start/list/status use the pack runner, run store, and claim authority;
- no concrete runtime transport is a fallback review path;
- terminal review JSON on stdout must be non-empty and valid;
- one clean terminal result for the exact same PR head suppresses a redundant
  automatic/common reviewer-model invocation;
- exact authority-selected conflict-free carry-over may establish current-head
  review authority without another reviewer-model invocation;
- an at-cap cycle suppresses further automatic/common reviewer-model calls;
- reviewer invocation and current-head review authority are different facts.

Review-call suppression never carries unrelated review or CI facts across heads.
Required CI stays current-head bound; a prior-head smoke PASS on the same PR
remains sufficient, and smoke is not an at-cap or review admission gate.

### Issue #2161 main-update sequencing

The merge agent performs the sole branch update from `origin/main` immediately before merge, after a same-PR smoke PASS (at any report head) and after required CI is green on the current head. Workers and coordinators must not merge main to clear BEHIND during smoke or review; current-head CI and review authority remain unchanged.

#### Pack-review recovery recipe

Recover interrupted or stale reviews only through the scoped runner; do not start a
replacement same-head review merely because a browser or runner child stopped.

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

## Core operating laws (concise reference)

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

## Production verification (concise reference)

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

## Orca grounding (concise reference)

`worker_done` means completion of the active Dispatch/Task, not one conversational
turn. Use existing pack-side recovery for named Orca conditions:

- `nested_worker_depth_exceeded` -> use the existing pane-launch path instead of nesting another worker;
- `dispatch_capability_invalid` -> use the existing orchestration mailbox fallback/path instead of re-dispatching the revoked capability;
- `consumer_fenced` -> re-read the exact current runtime/terminal handle before any effect;
- `stable_pane_required` -> re-read the exact current runtime/terminal handle before any effect.

For the last two cases, never act on a stale, reused, or guessed handle. Do not patch
Orca core to encode PACK role stages.

## Operator adoption (concise reference)

Repository merge does not prove machine activation. When a change affects
operator-facing runtime/configuration/process behavior, adopt it through the
existing supported operator path and prove the intended live state through a
target-specific supported read-back before claiming activation.

The implementation PR carries the reusable operator handoff rule in
`### Operator adoption handoff`; one-time rollout history does not belong in this
runbook.

## Wake supervisor stall diagnostics and refusal reset
A scheduler tick appends JSONL phase timings to `scheduler-tick-phases.jsonl` under `OPK_SIDE_PROCESS_STATE_DIR` (or the OS-specific supervisor state directory); set `OPK_SCHEDULER_TICK_PHASE_LOG` only when an explicit diagnostic path is needed. Preserve this log when investigating a stall.

For a persisted `scheduler_child_stall_loop`, first repair the measured phase and verify one `scheduler.ts tick`. Then use `orchestrator-wake-supervisor.ts reset-stall-refusal` with the same project, state directory, repo root, epoch authority/id/nonce, target registry, and projected registry arguments as `run`. The command validates the current epoch and registry, refuses to reset a live supervisor or any other refusal reason, and updates the existing status file in place; it does not delete status or establish health. Start the supervisor only after the reset and confirm generation progress with `status`.
## Worker lifecycle (concise reference)

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