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

For create-Issue independent review, the reviewer publishes its own complete
verdict/findings as the governed top-level Issue comment. The manager consumes
the reviewer receipt and owns later workflow/disposition actions; it does not
normally relay or summarize a review into a replacement comment. The canonical
reviewer publication and prompt policy remains in
`.claude/skills/create-issue-draft/SKILL.md`; this runbook does not copy that
prompt. Any genuine-write-failure exception remains limited to the fallback
already defined by that owning skill.

### Worker

A worker owns the bounded implementation workflow:

```text
read live Issue/rules
-> implement scoped work
-> required local verification
-> create/update PR and exact head
-> worker-owned smoke (exact head; fix and repeat until PASS)
-> tier/cap-governed pack-review cycle
-> review finding: worker fix + exact-head worker-owned smoke + next review cycle
-> settled review obligations
-> independent smoke
-> independent-smoke finding: worker fix + fresh independent smoke
-> completion
-> worker_done
```

Worker-owned smoke and independent smoke are different actors and different
gates. Pack-review starts only after the exact current head has a passing
worker-owned smoke. Independent smoke starts only after the review tier/cap
obligations settle. Once independent smoke has started, pack-review is
forbidden for this work, including after a smoke-driven fix.

After a current-head smoke returns a gap or fail, the next legal coordinator step is a worker fix that produces a new SHA, then a fresh smoke of that exact SHA:

```text
worker-owned smoke (current SHA)
  |-- PASS --> pack-review eligible
  |-- FAIL/BLOCKED --> fix (new SHA) --> worker-owned smoke that SHA

pack-review (settled)
  |-- eligible --> independent smoke
  |-- finding --> fix (new SHA) --> worker-owned smoke that SHA --> next pack-review cycle
```

Old-head smoke proofs do not count for a new head. A review finding requires
worker-owned smoke before the next governed review cycle. An independent-smoke
finding requires only a worker fix and fresh independent smoke; it never opens a
later pack-review cycle. Exact folding and SHA-binding stay in
`docs/worker-smoke-testing.md`.

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

The variable names and work-class-to-profile mapping are tracked policy. Concrete `agent`, `model`, and `effort` values are machine/operator-local configuration and must stay out of tracked documentation. Keep those values only in the existing gitignored local configuration/environment surface, resolve them immediately before starting new work, and treat a local value change as applying to subsequent work without a repository Issue or PR. Changing the stable mapping or variable contract remains a repository policy change.

The gitignored local configuration file is a store, not the live process environment. The orchestrator or launching shell must export the matching `PACK_EXECUTOR_*` values into the live process environment before smoke or a new manager/worker spawn. The smoke launcher and supervised Task launch assistant read only that live environment; neither opens the gitignored local configuration file. The lower-level `supervised-worker-start` boundary still does not read `PACK_EXECUTOR_*`. A missing, empty, malformed, unsupported, or non-applicable live launch profile fails closed before Task/runtime effects, so the presence of a file on disk is not a substitute. Do not add a pack dotenv loader, second selector, or compatibility fallback to close this gap.

`agent` selects an already-supported invocation/lifecycle path:

- Cursor/Orca implementation work uses the existing local Cursor/Orca launch path. New manager/T1/T2/T3 starts use the supervised Task launch assistant below; initial delivery still ends at the existing PACK supervised-start boundary and publishes the current local WorkerAssignment only after Orca returns a proven ready receipt.
- GPT/Browser-GPT implementation work uses the existing standalone chat-implementer contract in `docs/chat-executor-rules.md` and the Browser-GPT turn mechanics in `docs/browser-gpt-turn-runbook.md`. That path is not an AO-managed Orca worker start and does not synthesize or publish an Orca WorkerAssignment.
- Changing a profile between those already-supported executor paths changes only which existing path subsequent work uses; it does not create a new selector or lifecycle authority.
- Smoke complexity selects only between the routine-smoke and complex-smoke executor profiles; it does not create a task tier or change smoke admission, evidence, ownership, or lifecycle rules.

The smoke launcher receives exactly one producer-owned `--smoke-complexity`
value (`routine` or `complex`). It resolves that profile immediately before
child creation, validates all three local values and the supported agent, and
fails closed before spawn when the profile is missing, malformed, unsupported,
mixed, or cannot be applied through the existing launch command.

This profile rule does not add a runtime selector, WorkerAssignment type, provider registry, scheduler, service, store, queue, daemon, fallback transport, or retry mechanism.

For example, changing the local T3 `agent` between the already-supported GPT/Browser-GPT and Cursor/Orca paths changes the path used by subsequent T3 work without a tracked policy edit. Routine versus complex smoke works the same way: it selects the corresponding local smoke profile, whose concrete values remain local-only.

### Supervised Task launch assistant

For new Cursor/Orca **manager, T1, T2, and T3** work, the canonical composition
point is:

```text
scripts/pr2-foundation/supervised-task-launch-assistant.ts
```

It is a continuation-safe launch assistant, not a lifecycle authority. It owns
only the shared mechanical sequence: Node/repository preflight; exact live
executor-profile validation; manager Run/Task admission; supported worktree
setup/reuse proof; one fresh RuntimeAdapter-created internal terminal; two
fresh-start Dispatch absence witnesses; launch timing/diagnostics; and the call
to the existing supervised-start boundary. It creates no durable retry state,
queue, lease, WorkerReport/WorkerStatus, scheduler, or second assignment store.

The calling shell first exports the matching stable profile names. Concrete
values remain local and must not appear in tracked docs, Task metadata, launch
output, or PR metadata. For this assistant v1, the supported executable is
exactly `cursor-agent`; literal `cursor` and any other agent value fail closed
before Task/runtime effects. Model/effort applicability and child inheritance
are validated before spawn.

Invoke through the canonical Node 22 wrapper. Exactly one of `--worktree` (a
supported proven-reuse target) or `--worktree-name` (a fresh setup path) is
required by the assistant.

T1:

```bash
node --experimental-strip-types scripts/lib/Invoke-TypeScriptCli.ts \
  --script scripts/pr2-foundation/supervised-task-launch-assistant.ts -- \
  --repository <owner/repo> --work-class t1 --issue-number <N> \
  --task <task-id> --worktree-name <worktree-name> --base-branch <base-ref>
```

T2:

```bash
node --experimental-strip-types scripts/lib/Invoke-TypeScriptCli.ts \
  --script scripts/pr2-foundation/supervised-task-launch-assistant.ts -- \
  --repository <owner/repo> --work-class t2 --issue-number <N> \
  --task <task-id> --worktree-name <worktree-name> --base-branch <base-ref>
```

T3:

```bash
node --experimental-strip-types scripts/lib/Invoke-TypeScriptCli.ts \
  --script scripts/pr2-foundation/supervised-task-launch-assistant.ts -- \
  --repository <owner/repo> --work-class t3 --issue-number <N> \
  --task <task-id> --worktree-name <worktree-name> --base-branch <base-ref>
```

Manager with an existing Task:

```bash
node --experimental-strip-types scripts/lib/Invoke-TypeScriptCli.ts \
  --script scripts/pr2-foundation/supervised-task-launch-assistant.ts -- \
  --repository <owner/repo> --work-class manager --run <run-id> \
  [--issue-number <N>] --task <task-id> --worktree <worktree-selector>
```

Manager with one caller-serialized brief:

```bash
manager_brief='<caller-serialized manager Task spec>'
node --experimental-strip-types scripts/lib/Invoke-TypeScriptCli.ts \
  --script scripts/pr2-foundation/supervised-task-launch-assistant.ts -- \
  --repository <owner/repo> --work-class manager --run <run-id> \
  [--issue-number <N>] --manager-brief "$manager_brief" \
  --worktree-name <worktree-name> --base-branch <base-ref>
```

Every manager invocation supplies the exact current `--run`. Before effects, the
assistant requires the installed read-only Run authority to agree with that id.
For `--task`, it also requires exactly one membership witness for that Task in
that exact Run. For `--manager-brief`, exactly one Orca Task-create mutation is
allowed and success requires a non-empty authoritative Task id/status. A
provider outcome-unknown Task-create carrying a request id returns
`outcome=continue` with the legal same-mutation `--retry-request` action; it does
not authorize a second fresh brief.

For every genuinely fresh known Task, `dispatch-show --task <task-id> --json`
must prove exact `dispatch === null` **twice**: once before worktree/terminal
effects and again immediately before supervised-start. Any present, malformed,
unknown, or competing Dispatch is a continuation/reconciliation result, never
permission for another start. Provider-identified recovery of an already
attempted worker-start is different from a fresh start: execute only the exact
recovery action returned by the assistant, using the same Task/worktree/terminal
/options and provider request id. Do not create a new terminal or re-run the
fresh double-null admission while that mutation remains unresolved.

Worktree path/head existence is not setup readiness. A fresh worktree proceeds
only from the supported same-invocation setup-complete witness; reuse proceeds
only from a supported proven-reuse witness. Missing or unknown setup evidence is
`outcome=continue`.

The terminal boundary is machine-enforced through structured contracts: one
RuntimeAdapter-created worker with provenance `internal`, exact
`{runtime,id,generation}`, exact target workspace, and `idle` RuntimeAdapter
liveness. The assistant does **not** scrape raw screen/title/preview/composer text.
The old per-launch claim that PACK can prove visible model/effort and empty
composer from the production API is retired because those structured witnesses
are not exposed. A known contrary observation is still blocking. After rollout,
perform one controlled visual profile/clean-first-turn smoke as provider-adoption
evidence; it is not a per-launch parser or durable authority.

The assistant emits one structured result. `outcome=ready` means only that the
existing `runSupervisedWorkerStart` returned `ready_and_assignment_bound`.
`outcome=continue` is handled non-success with the first failed/absent checkpoint,
observed cause, known resources, responsible actor, evidence, exact legal
`nextAction`, and assistant-entry/per-stage timings. Both ready and handled
continue exit zero; malformed invocation or an internal failure that cannot emit
the structured envelope exits non-zero. The helper never claims to measure time
before its own entry.

## Supervised initial delivery and WorkerAssignment

This section applies only to executor paths that use the existing Orca-managed supervised worker lifecycle. Standalone GPT/Browser-GPT implementation work follows `docs/chat-executor-rules.md` and `docs/browser-gpt-turn-runbook.md` instead and does not create an Orca WorkerAssignment.

For new manager/T1/T2/T3 Cursor/Orca starts, operators invoke the supervised Task
launch assistant above rather than hand-compose the terminal/start sequence. The
assistant's successful final edge is still the existing PACK boundary:

```text
scripts/pr2-foundation/supervised-worker-start.ts::runSupervisedWorkerStart
```

That lower-level boundary calls supported Orca `orchestration worker-start` with structured JSON output. It publishes a current local WorkerAssignment only after Orca returns a proven `ready` receipt with both `taskId` and `dispatchId`. Failed, malformed, or outcome-unknown startup does not create a successful assignment. A structurally valid Orca error envelope with a non-empty `error.code` remains non-success and exposes that exact code. When Orca also supplies structured mutation-recovery fields in `error.data`, the boundary preserves the exact request id and optional accepted Dispatch/recovery command so the assistant can return the one legal recovery action without inventing retry state.

`--issue-number` may be omitted when the GitHub Issue is not yet available for manager authoring. The assignment is then stored under the one canonical deliverable key derived from `(taskId, dispatchId)` with no Issue metadata. After publication, attach the positive Issue number to that same record; the canonical key, assignment id, and generation do not change. Do not use an `issue-<N>` key, alias, promotion, dual lookup, or conversion path.

The assistant consumes `PACK_EXECUTOR_*` only during pre-spawn launch validation.
`supervised-worker-start` itself remains executor-profile neutral and does not read
those variables; it owns successful Orca receipt/placement/assignment publication
semantics only.

The minimum current assignment authority is:

```text
scripts/lib/worker-assignment-store.ts
```

A durable assignment contains only persistence-safe logical facts: project/repository, optional published Issue metadata, Task, assignment id, monotonically advancing assignment generation, `kind`, `provider`, provider lifecycle `bindingKey`, and timestamp. For current local Orca workers the binding key is the Orca **Dispatch id**. The sole assignment-store key is derived from the stable `(taskId, dispatchId)` deliverable identity. A pre-#1441 generated store using `issue-<N>` object keys is intentionally unreadable after the hard cut; the operator retires/resets that generated `worker-assignments.json` instead of migrating or dual-resolving it.

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

Missing, stale, ambiguous, remote/not-applicable, unsupported, or mismatched evidence is fail-closed and performs no routine effect. Never replace this with PR/session/title/path/pane/PID heuristics. Orca's installed production observation does not provide a stable `pane_key` witness together with the current handle/incarnation, so a remap that cannot be proven through the existing Dispatch exact-worker binding takes the #1441 fence outcome. Do not synthesize a pane key or rebind by handle/title/path/PID/first match.

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

Routine S2 dispatch stays on RuntimeAdapter. For executor paths using Orca-managed workers, initial delivery stays Orca-owned. Standalone Browser-GPT chat execution is outside this WorkerAssignment/S2 path. Do not dual-send through Orca mail or another transport. `dispatch_unknown` is uncertain and never authorizes automatic resend or an alternate transport.

## Bound-run inbox drain and acknowledgement

For an Orca-bound Run, all roles use the single runtime-neutral `RuntimeAdapter.checkInbox` seam. The Orca adapter maps that seam to `orca orchestration check [--ack <delivery_id>] --run <run_id>` without `--wait`. One check returns either authoritative empty or one oldest unacknowledged Delivery. A Delivery is the atomic replay-and-ack unit even when it contains many messages.

At one lifecycle boundary, process the inbox serially:

```text
check current bound run
-> empty: boundary may advance
-> Delivery: surface and process every message
-> any message fails: do not ack; boundary is blocked/degraded
-> all messages succeed: carry that exact delivery_id on the next check
-> repeat until authoritative empty or the existing lifecycle deadline expires
```

Exactly one acknowledgement is issued per Delivery, never per message. Missing, malformed, foreign/sibling-run, unsupported, ambiguous, duplicate/concurrent-ack, or deadline-exhausted evidence is not empty and does not authorize resend. `read`, `delivered_at`, process state, pane state, heartbeat existence, and terminal-send exit status never prove that mail was surfaced.

The provider does not expose a reliable snapshot of “Deliveries present when the boundary began”. Do not invent one. The existing lifecycle/turn deadline bounds the drain. If continuous arrivals prevent an authoritative empty result before that deadline, report an explicit busy/degraded boundary and do not advance. Do not turn the drain into a watcher, poller, subscription, daemon, retry service, queue, or second observer.

Role obligations are mandatory:

- **Manager:** drain before starting or claiming the next authoring/review stage and immediately before manager `worker_done`.
- **Worker:** drain immediately before worker `worker_done` and before emitting a blocker/escalation that hands control upward.
- **Coordinator / flow-manager / orchestrator acting on the bound Run:** drain before issuing a reply, ruling, escalation decision, or dispatch, and again before reporting its own turn complete.

Every message returned by the drain is surfaced and processed in the same role turn before the guarded action. An unreachable/unsupported/ambiguous drain is reported as degraded/blocking evidence and is never silently skipped.

Supervised agents do not emit `type: heartbeat` / `subject: alive` control chatter merely to assert liveness. A supervised agent with no actionable report sends nothing. S1 remains the sole liveness observer; existing observer heartbeat/process-liveness artifacts remain observation evidence, not agent assertions.

## Published GitHub artifact completion and batch attribution

For create-Issue author/reviewer/lens work, the manager's completion and delivery authority is the fresh GitHub REST-visible artifact, not the launcher child or its terminal envelope. The existing long-running child envelope, PID, pane, spinner, log growth, silence, and heartbeat remain timeout/diagnostic hints only.

For an author turn, completion requires the exact tuple `(repository, issue_number, source_revision, exact_body_sha256)` from a fresh Issue read-back. GitHub editor/principal provenance is not invented when the Issue read surface does not expose it as a turn witness. A matching revision with a different exact body hash is a blocking mismatch; a stale/missing revision is non-terminal.

For a reviewer/lens turn, completion requires exactly one unedited top-level comment from the currently authenticated principal whose first two non-empty lines bind the expected Issue/revision and exact invocation marker. The manager-held `stage` and `source-slot` must also match that publication. A foreign, edited, stale, missing-invocation, duplicate, ambiguous, or wrong-stage/slot publication cannot settle the current turn. A possible or confirmed send is never resent merely because the child is silent or gone.

The long-running `wait` command may carry the publication expectation directly:

```text
# reviewer/lens
... flow-manager-long-running-child.ts wait \
  --run-identity <run> --attempt-identity <attempt> \
  --terminal-envelope <path> --handoff-receipt <path> --deadline-ms <ms> \
  --publication-kind reviewer --repository <owner/repo> --issue-number <N> \
  --source-revision <rNN> --invocation-id <id> --stage <stage> --source-slot <slot>

# author
... flow-manager-long-running-child.ts wait \
  --run-identity <run> --attempt-identity <attempt> \
  --terminal-envelope <path> --handoff-receipt <path> --deadline-ms <ms> \
  --publication-kind author --repository <owner/repo> --issue-number <N> \
  --source-revision <rNN> --body-sha256 <exact-body-sha256>
```

When a publication expectation is present, an incident envelope such as `child_stdout_eof_timeout` does not end the wait as success or failure before the publication read-back settles or blocks. `completion_authority: published_artifact` is emitted only for the exact authoritative publication; the child envelope, when present, is retained alongside it as diagnostics. Missing/unavailable REST evidence stays non-terminal until the bounded deadline.

For one concurrent plural batch, classify each slot from the REST publication census. A slot with its own authoritative artifact is `actual` and no-resend. If at least one sibling in the same batch is REST-visible while another slot is silent/missing, the silent slot is `possible-or-actual`, resend is forbidden, and it settles as an incident retaining that invocation identity. The sibling publication proves that the batch transport worked; it does **not** prove that the silent payload crossed the composer. With zero published siblings, no slot is classified as delivered. The stage-level `partial` rule for a short capture set remains the separate #1439 authority.

Do not add a second observer, completion store, delivery-status store, reconciliation pass, retry service, or fallback transport around this rule.

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

The same `pr2-scheduler` tick also submits an unsent headed Cursor composer when it contains only the exact Orca mailbox poke, after 10 seconds of unchanged composer text. Quiet and submitted fingerprints persist across tick processes. A crashed tick is restarted by the existing supervisor crash-backoff; do not add a second registry child or a long-lived CLI watcher beside a live supervisor. Manual/smoke CLI remains `node --experimental-strip-types scripts/cursor-unsent-composer-submit.ts` (`--once` for one scan).

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
3. retire/reset the pre-#1441 generated `worker-assignments.json` before new assignment publication; do not convert, alias, or dual-resolve `issue-<N>` records;
4. start new Cursor/Orca manager/T1/T2/T3 work through the supervised Task launch assistant; treat only `outcome=ready`/`ready_and_assignment_bound` as started, and execute only the exact `nextAction` for handled continuations or provider recovery;
5. for one manager authoring launch without an Issue, confirm the assignment is task/Dispatch-keyed with absent Issue metadata, then attach the Issue only after publication without changing the deliverable key/id/generation;
6. verify one stale/remapped runtime identity fences without a stale-handle effect and one Orca error envelope preserves its exact non-empty `error.code` and any structured mutation-recovery request id while remaining non-success;
7. perform one controlled visual Cursor profile/clean-first-turn smoke; treat it as adoption evidence only, not a per-launch PACK parser or durable witness;
8. verify a supervisor-owned `scheduler.ts tick` under the current activation epoch;
9. verify later bounded children retain the same trusted S1 lineage and advancing tick sequence;
10. verify one exact REST-visible author/reviewer artifact settles its manager turn even when the helper child is silent/gone, and one published sibling makes a silent concurrent slot possible-or-actual/no-resend without claiming that its payload was proven delivered;
11. verify the latest `fleet-reconciliation-handoff/v1` is readable before treating silence as healthy.

Do not claim live machine supervision before this read-back.