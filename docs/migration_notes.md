# Migration notes

## PACK operator-primary logical binding (Issue #1532)

### What changed

`operator-primary` is now one explicit PACK project-level designation of one
current local `WorkerAssignment`. The designation is the optional
`operatorPrimary` pointer inside the existing `worker-assignment-store/v1`; no
second target store, registry, cache, lease, daemon, watcher, queue, retry service,
or native Orca role was added. The durable pointer contains only persistence-safe
`taskId`, provider `bindingKey`, assignment id, and PACK logical assignment
generation. Raw runtime id/generation, terminal state, output, process/pane/session
identity, workspace/title, and adapter-private evidence remain memory-only.

`scripts/lib/operator-primary-target.ts::withCurrentOperatorPrimaryTarget` resolves
the exact current local assignment through the registered RuntimeAdapter, keeps the
adapter-produced runtime identity only in memory, immediately exact-revalidates it
with `findWorker`/`sameRuntimeWorker`, and admits one structurally synchronous
receipt-returning caller action while the existing WorkerAssignment-store lock is
held. That lock fences PACK logical rebinding/replacement only. The exact target is
a freshly resolved/revalidated snapshot; PACK does not claim to fence a provider
`bindingKey` remap after that snapshot.

### Operator adoption

1. Adopt the merged #1532 PACK revision through the normal supported deployment or
   recycle path. Do not hand-edit `worker-assignments.json` and do not create a
   second role/target file.
2. Read the current persistence-safe designation through the canonical Node 22
   wrapper:

   ```bash
   node --experimental-strip-types scripts/lib/Invoke-TypeScriptCli.ts \
     --script scripts/operator-primary-binding.ts -- show
   ```

3. Select the intended **current local** WorkerAssignment from existing
   authoritative assignment evidence, then bind it explicitly. The command accepts
   logical Task/provider-binding identity only; it never accepts a terminal/runtime
   id:

   ```bash
   node --experimental-strip-types scripts/lib/Invoke-TypeScriptCli.ts \
     --script scripts/operator-primary-binding.ts -- \
     bind --task-id <task-id> --binding-key <provider-binding-key> \
     --operator-attested
   ```

4. Run `show` again and confirm `status: "binding_current"` with the exact logical
   pointer expected. For an intentional rebind, use `replace` with the complete
   pointer returned by the prior `show` as the `--expected-*` CAS expectation plus
   the new `--task-id`/`--binding-key`. Never blind-overwrite a current binding.
5. Before enabling the #1260 S3 consumer, point-revise #1260 to the landed #1532
   commit and exact `withCurrentOperatorPrimaryTarget` / `operatorPrimarySyncResult`
   exports, closed pre-action vocabulary, snapshot-freshness rule, synchronous
   receipt/fence rule, adoption assumption, rollback rule, and current-head focused
   proof command. #1532 itself performs no publication or retry.

### Rollback

A pre-#1532 writer can parse the same v1 store but does not preserve the new
optional pointer on rewrite. Therefore rollback while `operatorPrimary` is present
is unsupported. Before starting an older writer, capture the exact current logical
pointer with `show`, retire exactly that pointer under the #1532-capable binary,
and read back `binding_absent`:

```bash
node --experimental-strip-types scripts/lib/Invoke-TypeScriptCli.ts \
  --script scripts/operator-primary-binding.ts -- \
  retire \
  --expected-task-id <task-id> \
  --expected-binding-key <provider-binding-key> \
  --expected-assignment-id <assignment-id> \
  --expected-assignment-generation <generation> \
  --operator-attested
node --experimental-strip-types scripts/lib/Invoke-TypeScriptCli.ts \
  --script scripts/operator-primary-binding.ts -- show
```

Only after the exact read-back proves pointer absence may the operator adopt/recycle
to an older revision. Do not preserve the role through a compatibility alias,
second store, schema bridge, or heuristic selector.

## Policy-context routing reduction (Issue #1488)

### What changed

`AGENTS.md` is the sole universal project-policy canon, Claude and Cursor surfaces
route task-specific mechanics to their owning skills/runbooks, and the ordinary
coworker read-delegation threshold is now the single prose trigger of **more than
600 lines**. Cursor constant context is reduced to `AGENTS.md` plus the shortened
always-applied ASCII rule; other Cursor rules are scoped by globs, descriptions,
or named skills.

### Operator adoption

1. Pull the merged #1488 revision into each operator checkout or managed session
   that consumes the tracked policy surfaces.
2. Resync the existing machine-local mirrors of `AGENTS.md` through the supported
   external sync step: `~/agent-rules/coworker-policy.md`, generated
   `~/.codex/AGENTS.md`, and the `~/.cursor-global` symlink target when present.
   Do not hand-edit those mirrors as a substitute for the normal sync.
3. Recycle only affected Claude/Cursor sessions or managed pack consumers through
   the currently supported deployment/session mechanism so they load the updated
   tracked policy and hook wiring.
4. Existing Claude/Cursor read-delegation Stop/stop hooks remain owned by
   `docs/coworker-read-delegation-audit.md`; #1488 does not introduce a second
   hook or local configuration source. Where those hooks are installed, verify one
   fresh ordinary >600-line work unit appends the expected audit verdict after the
   affected session has reloaded the new revision.

### Rollback

Revert the #1488 change, resync the same tracked-policy mirrors from the reverted
checkout, and recycle the affected sessions or managed pack consumers through the
same supported deployment/session mechanism. Do not preserve the new routing or
threshold by adding a compatibility copy, second policy registry, or alternate
hook.

## Continuation-safe supervised Task launch assistant (Issue #1479)

### What changed

New Cursor/Orca manager and T1/T2/T3 starts use the pack-owned
`scripts/pr2-foundation/supervised-task-launch-assistant.ts` composition. The
launcher is an **assistant**, not a lifecycle blocker, scheduler, retry service,
or second start authority. It performs only the shared mechanical preparation
around the existing successful-start boundary. A launch is ready only when the
existing `runSupervisedWorkerStart` returns `ready_and_assignment_bound`; the
#1441 task/Dispatch WorkerAssignment identity remains authoritative.

For every genuinely fresh known Task, the assistant proves `dispatch === null`
before worktree/terminal effects and again immediately before supervised-start.
Managers additionally prove their explicitly supplied current Run, and an
existing manager Task must be proven to belong to that exact Run before effects.
A manager brief is one caller-serialized Orca Task-create mutation; provider
unknown outcomes are recovered only by replaying that same mutation with its
exact provider request id.

The v1 TUI/profile blocking contract deliberately changes. PACK no longer claims
that every launch has a machine-readable proof of the visible Cursor model,
effort, and empty composer because the production RuntimeAdapter/Orca contracts
do not expose such a structured witness. The machine-enforced boundary is now:
exact `cursor-agent`; selected model/effort applicability checked before spawn;
selected stable profile variables inherited by a child; one RuntimeAdapter-created
internal terminal with exact `{runtime,id,generation}` identity in the exact
workspace; and `idle` RuntimeAdapter liveness before delivery. PACK does not
scrape raw screen/title/preview/composer text to recreate the retired witness.
A known contrary observation still fails closed.

### Operator adoption

1. Adopt the merged PACK revision through the normal supported deployment/recycle
   path. Do not copy concrete executor profile values into the repository.
2. Export exactly the matching `PACK_EXECUTOR_<WORK_CLASS>_{AGENT,MODEL,EFFORT}`
   names into the launching process before invoking the assistant. The helper
   reads the live environment; it does not source or persist an operator-local
   profile file.
3. Invoke the canonical Node 22 TypeScript wrapper for
   `supervised-task-launch-assistant.ts`. T1/T2/T3 use an exact Task and intended
   worktree input; every manager supplies `--run` and exactly one of `--task` or
   caller-serialized `--manager-brief`. A GitHub Issue is optional for manager
   authoring work.
4. Treat `outcome=ready` only as the projection of
   `ready_and_assignment_bound`. Treat `outcome=continue` as a recoverable launch
   result and execute only its named legal `nextAction`; do not mark the parent
   Task blocked, completed, or done merely because launch did not reach ready.
5. For provider outcome-unknown Task-create or worker-start, reuse the exact
   returned provider request id and replay the same mutation with
   `--retry-request`. Never substitute a fresh brief, terminal, or worker-start
   while the original mutation remains unresolved.
6. After adoption, perform one controlled legal Cursor/Orca launch and visually
   confirm the expected selected profile and clean first-turn state. This is a
   one-time adoption smoke for provider drift, not a per-launch PACK parser or
   durable authority. If the provider visibly ignores the validated profile,
   stop adoption and fix the provider/launch contract.

### Rollback

Rollback is a source-control revert followed by the normal supported PACK
adoption/recycle path. Do not preserve this helper by adding a second retry
store, compatibility lifecycle state, alternate start authority, screen parser,
or state conversion. Existing WorkerAssignment and provider mutation evidence
remain subject to the code revision that owns them.

## Runtime identity and completion-authority hard cut (Issue #1441)

### What changed

Issue #1441 makes three existing authorities explicit at their consumers:

- runtime effects remain bound to exact `{ runtime, id, generation }` identity; a remapped/reused handle without a production-proven exact current target is fenced rather than heuristically rebound;
- manager author/reviewer completion is read from the exact REST-visible GitHub artifact, while child/PID/pane/heartbeat/terminal-envelope state remains diagnostic only;
- WorkerAssignment persistence is keyed only by the supervised-start receipt's stable `(taskId, dispatchId)` deliverable identity. `issueNumber` is optional metadata attached after publication and never changes that key, assignment id, or generation.

A structurally valid Orca supervised-start error envelope also preserves its exact non-empty `error.code` in structured failure evidence. It remains a failed start and never publishes a successful assignment.

Issue #1495 replaces that unreadable hard cut with a closed, lossless migration: recognized `issue-<N>` keys are re-keyed to canonical `task-dispatch-*` keys after an exact sibling backup, while unknown keys and corrupt stores still fail closed. There is still no dual-key lookup, alias, promotion, second live store, or heuristic repair.

For concurrent Browser-GPT author/reviewer batches, a REST-visible sibling publication proves that the batch publication transport functioned, but it does not prove that a silent sibling payload crossed the composer. The silent sibling is therefore classified `possible-or-actual`, resend is forbidden, and the slot settles as an incident carrying its invocation identity. With zero REST-visible publications, no slot is classified as delivered. Stage-level `partial` settlement remains owned by #1439.

### Operator adoption

1. Adopt the merged PACK revision through the normal supported pack deployment/recycle path.
2. Do not hand-edit `worker-assignments.json`. The first mutating WorkerAssignment path against a recognized `issue-<N>` or mixed store creates an exact `*.pre-task-dispatch-migration` backup, rewrites canonical `task-dispatch-*` keys once, then continues the ordinary compare-and-publish. Confirm the live store is canonical and the backup matches the original bytes. Supply an explicit `--role worker|orchestrator` on local supervised start and remote registration; missing or invalid role fails before Orca/store mutation. Pre-role rows stay readable with `role` absent.
3. Start one brief-only supervised worker without `--issue-number`. Confirm the ready receipt contains the expected `taskId` and non-empty `dispatchId`, and that the store contains exactly one canonical task/dispatch key with no Issue metadata yet.
4. After the Issue is published, attach its positive Issue number through the tracked assignment-store path and confirm the canonical key, assignment id, and generation are unchanged. Issue-scoped scheduler/fleet behavior may begin only after this metadata exists.
5. Exercise one stale/remapped Orca target. Confirm a changed generation, `exactWorker: false`, missing current identity, or ambiguous observation performs no send/read/stop/reassignment effect and returns the existing unresolved/fenced result.
6. Exercise one Orca `worker-start` error envelope with a non-empty code such as `agent_unconfigured`. Confirm the exact code is reported and no successful assignment is published.
7. Exercise one author or reviewer turn whose helper child is silent or gone after publication. Confirm a fresh GitHub REST read-back of the exact expected Issue body/hash or the exact unedited invocation-bound reviewer comment settles manager completion without requiring a second child handoff or resend.
8. Exercise one three-slot concurrent reviewer batch with at least one REST-visible sibling publication and one silent `child_stdout_eof_timeout` slot. Confirm the silent slot is `possible-or-actual`, resend is forbidden, and its invocation identity is retained in the incident. Repeat with zero published siblings and confirm no slot is classified as delivered.

Do not change credentials, local browser profiles/CDP state, or other generated runtime state as part of this adoption except for the explicit WorkerAssignment-store retirement/reset above.

### Rollback

Rollback is a source-control revert followed by the normal supported adoption/recycle path. If a migration backup exists beside the live store, it is recovery evidence for the pre-canonical bytes, not a second live authority. Restore only by replacing the live file with those exact backup bytes under operator control; do not run a second migrator, dual-key reader, or hand conversion.

## Runtime-neutral hard cut (Issue #1352)

### What changed

The repository no longer carries an active dependency on the removed orchestration
platform. Executable commands, daemon and HTTP clients, configuration and state
roots, environment authority, review transport, runtime-specific helper symbols,
operator setup prescriptions, and old plugin identities were removed rather than
aliased.

Current behavior is owned by these tracked authorities:

- `RuntimeAdapter` and the runtime registry for terminal and worker operations;
- Orca as the currently registered concrete adapter;
- `scripts/pack-review-runner.ts`, the pack review store, and the review claim
  authority for review start, list, and status;
- `scripts/lib/operator-publication.ts` for bounded zero-or-one operator
  publication;
- `scripts/lib/worker-degraded-ci-handoff.ts` for exact-composite degraded-CI
  handoff;
- runtime-neutral declaration, scope, accounting, and Codex review plugins;
- `scripts/runtime-retirement/retired-surface-guard.ts` as the single active
  scanner for removed surfaces.

No compatibility alias, dual execution, fallback transport, state conversion,
drain wait, or rollback execution path was introduced.

### Operator adoption

1. Pull the merged pack into each checkout or managed session that must execute the
   updated tracked policy and scripts.
2. Use Node.js 22.x and install the frozen workspace dependencies with
   `npm ci --include=dev`.
3. Recycle only affected managed sessions or supervised pack processes so they load
   the new `AGENTS.md`, scripts, plugin paths, and package identities. Do not add a
   removed configuration file or state root to make an old procedure work.
4. Confirm the concrete runtime is registered through
   `scripts/runtime/registry.ts` and that effects receive an adapter-produced
   `{ runtime, id, generation }` identity.
5. Run current-head verification:

   ```bash
   npm run typecheck:foundation
   npm run lint:foundation
   npm run test:foundation
   npm run gate-runner-selftest
   node --experimental-strip-types scripts/runtime-retirement/retired-surface-selftest.ts
   pwsh -NoProfile -File scripts/verify.ps1
   pwsh -NoProfile -File scripts/check-reusable.ps1
   ```

6. Verify one current-head review through the pack review runner, one exact-composite
   runtime operation through the registered adapter, and the task-specific smoke
   scenarios before declaring the rollout complete.

### Host cleanup boundary

Removal of obsolete host software, user configuration, caches, or state is optional
post-merge operator work. Repository acceptance does not wait for that cleanup, and
old host records never authorize a side effect.

Cleanup must be identity-scoped and performed outside managed worker sessions. Do
not delete arbitrary workspaces, credentials, unrelated state, or audit evidence.

### Rollback

Rollback is a source-control revert of the hard-cut changes followed by the normal
current-head verification for the reverted tree. Do not convert old state, restore a
fallback transport, or reinterpret an old short identifier as runtime authority.
Existing GitHub review, CI, Issue, PR, and audit history remains immutable evidence.

## First-time supervisor activation (Issue #1422)

### What changed

First activation now uses the existing `orchestrator-cutover-activate.ts`
transaction when the request has no claimed legacy PID (`legacySupervisorPid`
omitted or `0`). Before the cordon is written, the transaction observes all of
the following: an empty epoch authority, no live registered TypeScript
supervisor or `pr2-scheduler` child, no live legacy supervisor or registered
legacy writer, and a roster containing only the local host. Any competing or
unobservable state fails closed without committing an epoch.

The required `foundation-923-adoption.json` is produced by the tracked
TypeScript command; it must not be hand-written:

```bash
node --experimental-strip-types scripts/cutover/foundation-adoption-producer.ts \
  --repo-root "$PWD" \
  --state-dir "$HOME/.local/state/orchestrator-pack-wake-supervisor"
node --experimental-strip-types scripts/orchestrator-cutover-activate.ts \
  activate <greenfield-activation-request.json>
```

On a greenfield machine, the machine-canonical state root must not contain
`foundation-config.json`, `app-state.json`, or a committed migration journal.
Recognizable migration journals use the canonical
`migration-journals/*.migration-journal.json` location and name; prepared,
imported, committed, or corrupt records are refused rather than treated as
greenfield absence.
The producer records that absence by observing the canonical paths, empty epoch
authority, registered-child census, legacy-writer census, and live repository.
Its greenfield evidence includes a readiness observation from the registered
runtime adapter, rather than a retired preflight or app-state-version claim. The
heartbeat timestamp comes from the live observation at production time rather than source-file mtime.
It does not synthesize dormant-layer defaults. A partially present set of those
inputs is ambiguous and fails closed. A machine with the complete artifact set
continues through the existing artifact-backed foundation proof.
The producer rejects alternate paths and caller-supplied journal rosters.
`OPK_WAKE_SUPERVISOR_STATE_DIR` is rejected on this production path, so it cannot
select a second authority root. This greenfield contract proves only the local
host's absence of a predecessor; it does not claim a global fleet-membership
roster from writable JSON.
The request must bind `expectedOldEpochId: null`, the locally observed
single-host expectation, the emitted evidence path, and the existing three cutover stores. A request
with a claimed legacy PID still takes the identity, aliveness, old-revision
ownership, writer capture, drain, and termination path. No flag or environment
variable bypasses `proveFoundationAdoption`.

### Rollback

Before the import boundary, use `prove-rollback` and then
`rollback-preimport` with the same request. After the import boundary, use
`recover`; the existing forward-only recovery and epoch CAS remain authoritative.
Do not delete or hand-edit the evidence, cordon, epoch, or follow-up artifacts.

## Bounded-child S1/S2 supervision (Issue #1420)

### What changed

Issue #1420 makes the existing `pr2-scheduler` cadence production-capable across
separate bounded `scheduler.ts tick` child processes without adding another daemon
or scheduler. S1 continuity is restored only from the existing atomic S1 snapshot
when the current activation lineage, current WorkerAssignment generation, and exact
RuntimeAdapter-resolved worker still agree. Routine continuation remains the
existing S2 one-shot path.

The production S1 census resolves only the exact current workers attached to
current local WorkerAssignments. This covers supervised child worktrees without
using the repository root or active worktree as fleet scope, while unassigned
external terminals remain excluded by the existing provenance filter.

A successful supervised local start must go through the PACK
`scripts/pr2-foundation/supervised-worker-start.ts` boundary so the proven Orca
Dispatch publishes the current local WorkerAssignment. The persistence-safe binding
is the Orca `dispatchId`; raw RuntimeWorkerIdentity, terminal handles/generations,
output and observation tokens are not persisted in assignment or S1 state.

Cases that cannot be safely resolved remain fail-closed. `dispatch_unknown` is not
retried through another transport, and `orchestrator_required` is published only
through the bounded atomic `fleet-reconciliation-handoff/v1` latest-state artifact.

### Operator adoption

1. Merge and pull the #1420 pack revision into the operator checkout that owns the
   existing TypeScript side-process supervisor. Do not change the registered
   `pr2-scheduler` child shape or add a parallel scheduler/watchdog.
2. Use the existing supported pack adoption/recycle path so the supervisor and new
   bounded children load the merged `AGENTS.md`, runtime adapter contract, assignment
   store, scheduler and runbook. Do not hand-edit generated runtime state.
3. Start new supervised local manager/worker attempts through
   `scripts/pr2-foundation/supervised-worker-start.ts`; a failed or unknown Orca
   startup must not be treated as a current successful assignment.
4. Read back one successful current local assignment and verify that its durable
   binding contains the logical assignment generation and Orca `dispatchId`, not a
   raw runtime id/generation or terminal title/path/PID.
5. Observe a supervisor-owned `scheduler.ts tick` under the current activation
   epoch, then observe a later bounded child under the same epoch. Confirm that the
   accepted S1 `schedulerGeneration` is unchanged while `tickSequence` advances.
6. For an eligible supervised idle/livelock case with an exact current assignment,
   verify one S2 attempt settles through the existing claim/gate/journal path and a
   later child does not recreate the same episode. Do not infer success from worker
   prose alone.
7. Verify at least one fail-closed case: stale/missing assignment, runtime mismatch,
   remote assignment, lineage reset, or `dispatch_unknown` must produce no alternate
   send/retry.
8. Read the latest `fleet-reconciliation-handoff/v1` artifact before treating
   supervision silence as healthy. If a required handoff cannot be committed and
   read back, the scheduler child must surface non-success through the existing
   supervisor status rather than silently succeeding.

Repository merge alone is not evidence that the operator machine is active on the
new supervision contract. Do not claim live adoption until steps 1-8 are observed
against the current deployed activation epoch.

### Rollback

Rollback is a source-control revert to the prior pack revision followed by the
normal supported pack adoption/recycle path. Do not preserve a partially adopted
#1420 assignment/S1/S2 path by adding compatibility aliases, heuristic target
resolution, dual-send, a fallback runtime selector, or a second scheduler/store.
Previously written bounded state is evidence only and never authorizes an effect
when it no longer matches the active code/epoch/assignment contract.

## Ongoing adoption rule

Keep this file limited to currently actionable operator changes. Historical
procedures remain available in Git history but must not be copied back into active
runbooks when they prescribe removed commands, configuration, state, packages, or
transport.
