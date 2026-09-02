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
`.cursor/skills/create-issue-draft/SKILL.md`; this runbook does not copy that
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
-> required pack-review stage (logical rounds: T1=1, T2=1, T3=2)
-> review finding: worker fixes or explicitly resolves/rejects findings
-> if T3 round 1 settled: required round 2 (same head is allowed)
-> durable reviewStageComplete
-> later heads: no new required pack-review round; project pack-review success status only
-> independent smoke / ordinary exact-head validation as separately required
-> independent-smoke finding: worker fix + fresh independent smoke
-> completion
-> worker_done
```

Worker-owned smoke and independent smoke are different actors and different
gates. Ordinary smoke and CI remain exact-current-head evidence. The required
pack-review stage is a PR/task-cycle obligation, not a per-commit retry loop:
new cycles use logical-round caps T1=1, T2=1, T3=2, and every required GPT
round uses three concurrent sources. A T3 clean first round does not complete
the stage; round 2 remains required and may review the same head. Once the
required rounds and any findings are settled, durable `reviewStageComplete`
prevents later commits, smoke fixes, or CI-only changes from reopening or
consuming another required review round.

After a current-head smoke returns a gap or fail, the next legal coordinator step is a worker fix that produces a new SHA, then a fresh smoke of that exact SHA:

```text
worker-owned smoke (current SHA)
  |-- PASS --> pack-review eligible
  |-- FAIL/BLOCKED --> fix (new SHA) --> worker-owned smoke that SHA

pack-review logical round
  |-- T1/T2 settled --> reviewStageComplete
  |-- T3 round 1 settled --> round 2 (same or later SHA)
  |-- final findings --> fix/resolve findings --> reviewStageComplete (no worker-smoke prerequisite)
```

Old-head smoke and CI proofs do not count for a new head. Review-stage
completion is different: after `reviewStageComplete=true`, a later head receives
`orchestrator-pack/pack-review=success` with the description
`Required pack-review stage completed; no additional review round required.`
without launching another required reviewer. An independent-smoke finding still
requires a worker fix and fresh independent smoke; it does not reopen the
completed pack-review stage. Exact smoke folding and SHA-binding stay in
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

Each profile keeps the existing operator-local `agent`, `model`, and `effort` values under these stable tracked names:

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

`scripts/executor-profile-policy.ts` is the single tracked semantic owner for those
six triples. Do not duplicate its descriptor table, validation rules, translation,
or refusal semantics in another launcher. The policy has exactly two logical
executor families for these live profiles:

```text
task agent token   cursor-agent -> Cursor
smoke agent token  cursor       -> Cursor
smoke executable                -> existing agent surface

task agent token   opencode     -> OpenCode
smoke agent token  opencode     -> OpenCode
```

Concrete model and effort values remain machine/operator-local and must stay out of
tracked documentation, Task metadata, launch output, and PR metadata. The launching
process may provide live defaults; the task assistant and smoke launcher overlay
the machine-local executor profile store, with stored fenced keys winning over
live values. The lower-level
`supervised-worker-start` boundary remains profile-neutral. Missing, empty,
malformed, unsupported, unavailable, or non-admissible profile state fails closed
before the first governed effect. Do not load `.env` from a worktree or
repository root, add a second registry, compatibility token, fallback family, or
heuristic selector.

Model applicability and route admission are separate checks. Cursor catalog
applicability comes from `cursor-agent --list-models`; Cursor catalog identity and
spawn `--model` are different strings: admission continues to use the opaque
`model-effort` identity, while the translator emits a parameterized model with
`context`, `reasoning`, and `fast=false` when the operator sets
`PACK_EXECUTOR_CURSOR_CONTEXT`, and preserves the legacy spawn composition when it
is unset. The context window is operator-selected and never inherited from host
CLI state. OpenCode catalog applicability comes from `opencode models`; the
selected model and effort are carried together through an invocation-local agent
definition in `OPENCODE_CONFIG_CONTENT`. The top-level spawned command uses
`--agent` only, never `--model` or `--variant`.

For OpenCode exact-terminal work, early `resolveProfile` proves only selector,
top-level `--agent` syntax, and catalog route evidence. After worktree preparation,
contextual finalization runs in that exact path before terminal/Dispatch/start effects.
It requires a no-write-qualified `debug config`/`debug agent` observation, a
non-empty explicit `default_agent`, preservation of baseline agent semantics under
the selected model/variant overlay, and an isolated child-local XDG state root.
Missing proof returns `executor_effort_channel_unavailable`; launcher-cwd evidence
and implicit default ordering are never substitutes.

Cursor route admissibility is a static code-owned compatibility fact and therefore
must not gain a fresh route-capability probe. OpenCode is semantically recognized,
but a task or smoke child is admitted only after fresh non-mutating evidence from the
spawned top-level surface proves the route carries both values: top-level `opencode --help`
(proving `--agent` support on stdout+stderr), `opencode models --verbose` (proving the effort is an available variant), and `opencode debug agent <pack-agent-name>` run with the inline definition (proving the resolved agent carries both). Probe surface must equal spawn surface; probing a subcommand the pack does not spawn is never route evidence. Package installation alone is not route evidence. When no such route is proven, the selected OpenCode profile remains a truthful external gate rather than falling back to Cursor, dropping effort, or inventing an unsupported form.

Both edges capture stdout and stderr for every capability probe; a tool that prints capability output to stderr is not read as absent capability. The model-catalog read continues to consume stdout only, matching the observed `opencode models` stream split.

The shared pre-effect route vocabulary is closed:

```text
executor_route_unavailable
executor_effort_channel_unavailable
executor_route_mismatch        # task caller selected a conflicting startMode
```

`executor_route_mismatch` is task-only. Task route admission is owned by the
production `LaunchDependencies.resolveProfile` edge inside the assistant's
`executor_profile` checkpoint. That edge receives caller `startMode`, validates the
catalog/capability route, and returns one admitted route before manager Task
creation, worktree creation, terminal spawn, or supervised start. The outer
assistant consumes that decision and does not re-decide it. Caller intent is never
a bypass.

Smoke uses the same semantic policy and the first two refusal codes for both
routine and complex profiles before child spawn. Firefighter work keeps the
existing mapping to a routine or complex smoke profile; there is no
`PACK_EXECUTOR_FIREFIGHTER_*` namespace.

A structured child environment may be added to the RuntimeAdapter spawn contract
only when fresh installed evidence proves an admitted executor route actually needs
it. Likewise, an OpenCode provider form may be added to the lower-level supervised
start only when fresh installed Orca/OpenCode evidence proves the exact request.
Without that evidence those conditional surfaces remain unchanged; docs do not
invent capability for them. The current OpenCode inline agent definition is carried as an `OPENCODE_CONFIG_CONTENT` prefix in the composed `opencode --agent <pack-agent-name>` command string on the governed spawn path, so the four conditional runtime files (`scripts/runtime/contracts.ts`, `scripts/orca-runtime/adapter.ts`, `scripts/orca-runtime/task-adapter.ts`, `scripts/orca-runtime/task-adapter.test.ts`) remain byte-for-byte unchanged.

### Supervised Task launch assistant

For new **manager, T1, T2, and T3** work that uses the supervised local lifecycle,
the canonical composition point is:

```text
scripts/pr2-foundation/supervised-task-launch-assistant.ts
```

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
`outcome=continue` with the legal same-mutation replay identity; it does not
authorize a second fresh brief.

For every genuinely fresh known Task, `dispatch-show --task <task-id> --json`
must prove exact `dispatch === null` **twice**: once before worktree/terminal
effects and again immediately before supervised-start. Any present, malformed,
unknown, or competing Dispatch is a continuation/reconciliation result, never
permission for another start. Provider-identified recovery of an already attempted
worker-start is different from a fresh start: execute only the PACK-composed
`nextAction.command`, using the same attempt-bound route/profile resources and exact
provider request id. The assistant drops provider-authored recovery commands and
does not re-read mutable profile state. Do not create a new terminal or re-run the
fresh double-null admission while that mutation remains unresolved.

Worktree path/head existence is not setup readiness. A fresh worktree proceeds
only from the supported same-invocation setup-complete witness; reuse proceeds
only from a supported proven-reuse witness. Missing or unknown setup evidence is
`outcome=continue`.

The exact-terminal boundary remains machine-enforced through structured contracts:
one RuntimeAdapter-created worker with provenance `internal`, exact
`{runtime,id,generation}`, exact target workspace, and `idle` RuntimeAdapter
liveness. The assistant does **not** scrape raw screen/title/preview/composer text.
OpenCode admission must therefore come from the fresh installed capability
surfaces named by the policy, not a guessed screen/TUI state. Config/Agent loading
is not presumed read-only: exact-worktree before/after no-write evidence is required
before those observations can block or admit a route. A known contrary observation
is still blocking.

The assistant emits one structured result. `outcome=ready` means only that the
existing `runSupervisedWorkerStart` returned `ready_and_assignment_bound`; the
assistant projects a small PACK-owned success summary rather than returning the raw
provider receipt. `outcome=continue` reports the first failed/absent checkpoint,
known safe resource identities, responsible actor, bounded evidence, exact legal
`nextAction`, and assistant-entry/per-stage timings. Raw provider receipts,
residual-resource payloads, free-form provider messages/next steps, and provider
recovery commands are internal-only and are not serialized outward. Concrete
model/effort values may appear only where they are required inside the sole
attempt-bound retry command. Both ready and handled continue exit zero; malformed
invocation or an internal failure that cannot emit the structured envelope exits
non-zero. The helper never claims to measure time before its own entry.

## Supervised initial delivery and WorkerAssignment

This section applies only to executor paths that use the existing Orca-managed supervised worker lifecycle. Standalone GPT/Browser-GPT implementation work follows `docs/chat-executor-rules.md` and `docs/browser-gpt-turn-runbook.md` instead and does not create an Orca WorkerAssignment.

For new manager/T1/T2/T3 supervised starts, operators invoke the supervised Task
launch assistant above rather than hand-compose terminal/start sequencing. The
assistant's successful final edge is still the existing PACK boundary:

```text
scripts/pr2-foundation/supervised-worker-start.ts::runSupervisedWorkerStart
```

That lower-level boundary calls supported Orca `orchestration worker-start` with structured JSON output. It publishes a current local WorkerAssignment only after Orca returns a proven `ready` receipt with both `taskId` and `dispatchId`. Failed, malformed, or outcome-unknown startup does not create a successful assignment. A structurally valid Orca error envelope with a non-empty `error.code` remains non-success. Structured provider mutation-recovery data may be retained internally by this lower-level boundary, but the launch assistant exports only safe request/Dispatch identity and its own attempt-bound retry command; provider-authored recovery commands and raw receipts do not become caller authority.

`--issue-number` may be omitted when the GitHub Issue is not yet available for manager authoring. The assignment is then stored under the one canonical deliverable key derived from `(taskId, dispatchId)` with no Issue metadata. After publication, attach the positive Issue number to that same record; the canonical key, assignment id, and generation do not change. Local supervised start and remote registration require exactly one explicit `--role worker|orchestrator` before any Orca or store mutation. Recognized pre-cutover `issue-<N>` stores are migrated once through the existing assignment lock and atomic replace path after an exact sibling backup; unknown keys remain untrusted. Do not invent an `issue-<N>` alias, dual lookup, or second writer.

The assistant consumes `PACK_EXECUTOR_*` only during pre-effect profile/route validation.
`supervised-worker-start` itself remains executor-profile neutral unless a later
freshly evidenced conditional provider extension explicitly changes that boundary;
it owns successful Orca receipt/placement/assignment publication semantics only.

The minimum current assignment authority is:

```text
scripts/lib/worker-assignment-store.ts
```

A durable assignment contains only persistence-safe logical facts: project/repository, optional published Issue metadata, Task, assignment id, monotonically advancing assignment generation, `kind`, `provider`, provider lifecycle `bindingKey`, optional registration `role` (`worker` or `orchestrator`), and timestamp. For current local Orca workers the binding key is the Orca **Dispatch id**. The sole live assignment-store key is derived from the stable `(taskId, dispatchId)` deliverable identity. A recognized pre-#1441 `issue-<N>` store is read as the canonical key census and migrated once on the next mutation after an exact backup; it is not dual-resolved and not repaired if keys are unknown or rows are corrupt. New publications persist the caller-supplied role; migrated pre-role rows keep `role` absent.

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

## Scheduler inbox reconciliation

The existing scheduler tick performs an inbox-gated orchestration-mail reconcile after fleet supervision and before review processing. The same tick also runs a dispatch-terminal-mail pulse over persisted Orca worker assignments: for each bound `dispatchId` it re-reads `orchestration worker-show`, and when the lifecycle is terminal it sends exactly one `type: dispatch_terminal` message to the bound Run with `{ dispatch_id, state, stage, last_error }`, deduped by a durable ledger. The Orca task adapter applies the same notify-on-terminal decision when assignment resolution first classifies a Dispatch as inactive, so worker death observed during fleet supervision and the scheduled pulse share one sender rather than the dead-worker reconciler. It reads unread Orca messages by exact `message_id`, resolves only each message's exact recipient, and reuses the delivery pointer behavior; an exact pointer-only composer receives submit-only Enter while idle or two while busy whether the pointer was just written or already present. Each resolved worker-generation/run recipient identity owns one atomically claimed notification episode; continuous unread recipient episodes re-arm at 1, 2, 4, ... minutes capped at 30 minutes, while an episode is released only after that recipient has no unread mail left. It never performs global composer polling or groups a terminal-peek result into a Delivery. The existing local-state ledger persists episode claims, schedule, message stamping, and ambiguous outcomes; Orca read state remains authoritative across process restarts. A successful exact-message pointer/Enter is reported only as per-message `delivery: delivered-looking` with `terminalReceipt: unproven`, bound to current worker generation plus exact `runId` and `messageId`. Local dispatch acceptance, Enter success, wrapper exit, pointer/composer state, liveness, `read`, `delivered_at`, terminal title, or timing never upgrades that record to terminal receipt; positive recipient receipt remains outside this path until a separate task binds a real recipient-side producer and observation surface. Manual smoke may invoke `node --experimental-strip-types scripts/cursor-unsent-composer-submit.ts --reconcile`.

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

The registered production owner remains `scripts/lib/orchestrator-side-process-supervisor.ts::runSupervisor` with the existing `pr2-scheduler` child. Do not replace bounded `scheduler.ts tick` children with `runLoop()`, another daemon, timer, watcher, or watchdog. The periodic scheduler tick owns fleet supervision only; it does not read Cursor composer screens.

After the existing pack-side worker-notification delivery event settles successfully or ambiguously, that delivery path performs one immediate exact-target screen read, including while the worker is Running. An empty first read receives one awaited 250 ms render grace and exactly one final read; no delivery receives a third read or a long-lived retry. Exact Orca mailbox-pointer lines receive one submit-only Enter while idle or two while busy so Cursor uses its follow-up queue. Gone or unknown liveness and human or mixed text have no effect. The bounded reaction is awaited, and delivery-journal/claim identity owns duplicate suppression so a later distinct delivery may contain the same pointer text. A `dispatch_unknown` result remains ambiguous until runtime evidence and later same-agent processing are established. A delivery-event failure does not create a composer side effect. A crashed scheduler is restarted by the existing supervisor crash-backoff; do not add a second registry child, daemon, timer, watcher, global screen poll, or long-lived CLI watcher beside a live supervisor. Manual/smoke CLI remains `node --experimental-strip-types scripts/cursor-unsent-composer-submit.ts` (`--once` for one immediate scan).

Ordinary Orca orchestration mail does not pass through the pack worker-notification hook. A repository-governed sender therefore owns one immediate message-bound companion action after each successful or ambiguous `orchestration send` or `reply`: `node --experimental-strip-types scripts/cursor-unsent-composer-submit.ts --delivery --message-id <exact-message-id>`. The command looks up exactly that unread message, resolves its current composite recipient identity, counts unread mail for that recipient and Run, proves exact-message retrievability with landed terminal `--peek`, reads that composer once, refuses human or mixed text, and atomically claims the worker-generation/Run recipient episode shared by all currently unread messages for that recipient. The first eligible action writes one truthful recipient-appropriate directive pointer through `RuntimeAdapter` when composer is empty, then submits Enter through the same bounded delivery reaction; an already present exact pointer skips duplicate write but still receives Enter, and new mail in an already-unread mailbox does not create another pointer. Producer identity remains unproven by `unread` or `delivered_at` alone. A Dispatch recipient receives bare `orca orchestration check`; a coordinator recipient receives `orca orchestration check --run <run-id>`. The claim is released only after the recipient has no unread mail left, and a second invocation after that message's consumption still produces no write or Enter while any unread sibling remains. For blocking `ask`, use its bounded initial wait to obtain committed message id, run this companion action immediately, then resume same ask using Orca's returned recovery action; do not create a second question or wait for answer before nudging. If sender cannot prove one exact message and recipient identity, it leaves composer untouched and reports delivery as requiring operator/orchestrator handling.

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
3. let the first mutating WorkerAssignment path migrate a recognized pre-#1441 `issue-<N>` store (exact `*.pre-task-dispatch-migration` backup, then one canonical rewrite); do not hand-convert, alias, or dual-resolve records; pass explicit `--role worker|orchestrator` on registration;
4. start new supervised manager/T1/T2/T3 work through the supervised Task launch assistant; treat only `outcome=ready`/`ready_and_assignment_bound` as started, and execute only the exact `nextAction` for handled continuations or provider recovery;
5. for one manager authoring launch without an Issue, confirm the assignment is task/Dispatch-keyed with absent Issue metadata, then attach the Issue only after publication without changing the deliverable key/id/generation;
6. verify one stale/remapped runtime identity fences without a stale-handle effect and one Orca error envelope preserves its exact non-empty `error.code` while any provider mutation recovery remains attempt-bound and safely projected by the assistant;
7. perform one controlled selected-profile adoption smoke for every executor family actually admitted on the installed machine; an OpenCode external gate is a valid fail-closed result, not permission to invent a provider/TUI form;
8. verify a supervisor-owned `scheduler.ts tick` under the current activation epoch;
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

- automatic and common starts use `scripts/pack-review-runner.ts` and name the PR;
- the live PR supplies the current head and its closing reference supplies the Issue;
- session-binding cache data is advisory correlation only and cannot veto a valid
  PR-led start or substitute a different repository, head, or Issue;
- a missing exact bound Issue snapshot is captured only after the existing start
  claim is acquired, so concurrent first starts freeze one durable Issue body;
- manual Browser-GPT review uses
  `npm run --silent pack-gpt-review -- --pr-number <PR_NUMBER>`;
- review start/list/status use the pack runner, run store, and claim authority;
- no concrete runtime transport is a fallback review path;
- terminal review JSON on stdout must be non-empty and valid;
- one clean terminal result for the exact same PR head suppresses a redundant
  automatic/common reviewer-model invocation;
- exact authority-selected conflict-free carry-over may establish current-head
  review authority without another reviewer-model invocation;
- an at-cap cycle suppresses further automatic/common reviewer-model calls;
- reviewer invocation and current-head review authority are different facts.

Review-call suppression never carries unrelated evidence across heads. Required CI
and declared smoke stay exact-current-head. On a new head, smoke admission is checked
before an at-cap automatic refusal; conflict-free carry-over may remove the model
call but not the current-head smoke or CI obligation.

#### Pack-review recovery recipe

Recover an interrupted or stale GPT review through the existing scoped runner; do
not start a replacement same-head review merely because a browser/runner child
stopped:

```text
node --experimental-strip-types scripts/pack-review-runner.ts reconcile \
  --source-repo-root <path> --repo-slug <owner/repo> \
  --pr-number <PR_NUMBER> --immediate
```

For operator no-review waiver evidence and exact-head receipt staleness, use only `docs/pack-review-waiver-merge-runbook.md`.

The reconciler first re-reads credentialed GitHub source comments. For a frozen
three-source round, 3/3 settles normally; 2/3 remains waiting before the existing
shared stale/grace threshold and may settle once after that threshold as
`Sources: 2/3 (degraded after timeout)`. Fewer than two usable sources after the
threshold remains incomplete and reports the missing-source action. A late third
source does not reopen an already settled 2/3 round or consume another cap unit.
Every ordinary manual/chat/automatic start uses the same consuming review budget;
there is no launcher-specific same-head extra-review bypass. Under logical-round
accounting, a findings-bearing required round is mechanically settled only when
GitHub ancestry proves that the current PR head is a strict descendant of the
reviewed head. At final cap, advance the PR with the fix commit and rerun scoped
`reconcile --immediate`; no semantic finding-resolution evidence or cap+1 full
review is required. Exact-head CI and declared smoke remain separate merge gates
and do not participate in this review-settlement predicate.

### Required CI

Use protected-branch required checks when configured. Otherwise require every
pack merge-contract check for the current PR head. CI is not green while a
required check is failed, pending, cancelled, or missing.

**Self-fix is primary.** Do **not** run `pack-worker-report --state ready_for_review`
while required CI is not green. A red head remains `fixing_ci`; a pending head
stays engaged until green, red, or an evidence-backed degraded-CI handoff.

Green CI alone is not exit. The worker must finish review and handoff
obligations for the same head.

### Worker report store

Report lifecycle state through the pack-owned command:

```text
pack-worker-report --state <ready_for_review|fixing_ci|addressing_reviews|completed|blocked>
```

If the report command cannot prove the current repository, worker, PR, and head
binding, **skip silently** for the report write only and continue the required
task. Do not substitute comments for durable report state.

### PR-created handoff

Worker self-drive is primary. After PR creation, continue through current-head
CI, review feedback, smoke, and handoff. Do not idle in a transient state. On
delivered findings use `addressing_reviews`, then `fixing_ci` as needed, and
return to `ready_for_review` only after required checks are green.

Failure, timeout, cancellation, ambiguity, or missing evidence never becomes
clean or successful. **Must not** idle with open findings or silently disengage
without a current-head handoff.

### Review-cycle cap

Use the tracked review-cycle authority. First clean head yields
`clean_early_stop`; reaching the tier cap with open findings yields
`at_cap_open_findings` for architect/operator triage. A cap never converts
findings into approval and never authorizes another automatic/common
reviewer-model call.

### Worker smoke

Run the task's declared smoke plan against the current head. Smoke evidence
must be bound to the exact code, configuration, identity, and lifecycle under
test. A harness failure is investigated; it is not overwritten with a synthetic
pass. Review carry-over, same-head clean suppression, and cap exhaustion do not
carry smoke evidence to another head.

### Operator adoption handoff

When work changes operator-facing configuration, runtime selection, supervised
processes, environment variables, or tracked policy delivery, add a precise
`## Operator adoption` section to the PR body and update the active migration
notes. Workers document adoption but do not mutate the operator's machine
unless the direct user orders it.

A cosmetic documentation-only change may state `No operator adoption required`.
Do not describe a removed compatibility route as rollback or adoption.