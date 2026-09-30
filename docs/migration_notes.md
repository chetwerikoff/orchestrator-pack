## Pack-review logical-round migration (Issue #1826)

New cycles use `issue-1826-logical-rounds-1-1-2`: T1=1, T2=1, T3=2
logical rounds. A GPT round still has three concurrent sources and consumes at
most one round. T3 round 2 may target the same commit as round 1.

Open cycles that already carry the earlier `issue-1063-1-2-4` accounting
remain on their persisted distinct-head caps until their existing terminal/reset
path completes. They are not reinterpreted in place.

After the new mode records `reviewStageComplete=true`, later commits do not
consume more required review rounds. CI and smoke remain exact-head checks; the
pack-review status on a later current head is projected as success with the
completed-stage description. Worker notification remains best-effort.

Retry decisions are recomputed from current reviewer evidence rather than stored
as an eligibility flag. Browser GPT uses GitHub publication reconciliation plus
read-only CDP ownership observation. Codex uses its pack-owned process group.
Claude uses the adapter-emitted exact-run child frame, with the active child
binding replaced at the fallback invocation boundary. The native running ceiling
is the smaller of the reviewer budget and 15 minutes. No second lifecycle store
is introduced.

# Migration notes

## Target-owned verification adoption (Issue #2187)

### What changed

Target-repository verification now comes only from the selected project card.
`verification.local` is mandatory for target work; it is an ordered non-empty
list of non-empty command strings. `verification.focused` is optional and
does not replace the local list. The tracked verifier requires an explicit current
target worktree root, proves that root is the Git top level whose canonical
`origin` matches the card repository, then runs only the declared local
commands as `sh -lc <command>` in order with that root as cwd. Invalid card
verification, invalid/mismatched worktree binding, spawn failure, or non-zero
exit fails closed; there is no pack-command fallback.

This change does not make target required-check readiness, live branch policy,
pack-review requirements, PR/base/comparison/merge authority, or non-test
`main` literals project-card-owned. Those remain separate work.

### Operator adoption

1. In every adopted target card, set `verification.local` to the target's
   real local verification commands in execution order. Keep at least one
   non-blank command. Add `verification.focused` only when the target has a
   useful non-empty scoped verification template; focused-only cards are invalid.
2. Keep the pack's own `orchestrator-pack` card populated with the pack's
   own verification commands. Do not replace either pack or target commands with
   a cross-project default.
3. Update the single operator-owned shared worker preamble and
   firefighter/flow-manager templates so `{VERIFY}` expands to:

   ```bash
   node --experimental-strip-types "{PACK_ROOT}/scripts/lib/Invoke-TypeScriptCli.ts" \
     --repo-root "{PACK_ROOT}" --script "{PACK_ROOT}/scripts/lib/target-context.ts" -- \
     verify --project "{PROJECT_ID}" --target-worktree "<explicit-current-target-worktree-root>"
   ```

   The current target worktree root must come from the active task/worktree
   binding. Do not fill it from cwd and do not substitute card `primaryRoot`.
4. Remove concrete pack verification commands such as `scripts/verify.ts`,
   `ci:preflight`, or pack Vitest shards from target-work template paths.
   Pack changes continue to verify from the pack card.
5. Exercise one target with two local commands and one fail-fast case before
   enabling target task execution. Separately maintain required-check/live-policy
   and base/merge configuration; #2187 does not change those authorities.

### Rollback

A source rollback must be accompanied by reverting the operator template
adoption for `{VERIFY}`. Do not restore implicit pack verification for target
work as a compatibility fallback; stop target execution until the selected
revision's explicit verification contract is satisfied.

## Per-project target context adoption (Issue #2185)

### What changed

Target identity is now selected only by the operator-owned card at
`$XDG_CONFIG_HOME/orchestrator-pack/projects/<projectId>.json` (default
`~/.config/orchestrator-pack/projects/<projectId>.json`). The selected card
owns `repository`, `primaryRoot`, `defaultBranch`, Orca workspace/title
patterns, and `browserGpt.projectUrl`. Machine-wide Browser-GPT config keeps
only browser/profile/executable settings. Fleet runtime state is namespaced by
the exact card `projectId`, not by a target-root basename.

### Operator adoption

1. Create `~/.config/orchestrator-pack/projects/orchestrator-pack.json` for the
   pack itself. Point `primaryRoot` at the pack primary checkout, set
   `repository` to `chetwerikoff/orchestrator-pack`, fill the current base
   branch/patterns, move the existing ChatGPT project URL into
   `browserGpt.projectUrl`, and retain the pack's verification declaration for
   #2187.
2. Remove `projectUrl` from
   `.claude/skills/discuss-with-gpt/local.config.json` and stop exporting
   `DISCUSS_WITH_GPT_PROJECT_URL` or `PACK_GPT_BROWSER_PROJECT_URL`.
   Keep only machine-wide Chrome/profile/CDP/executable settings.
3. Update operator-local launchers without committing them:
   `opk-orch-start attach <project> <terminal-handle>` and
   `opk-orch-primary <project> <terminal-handle>` read the selected card and
   pass `--project <id>` to supervised start/operator-primary binding.
   `opk-wake-supervisor <project> ...` selects that project's supervisor as
   defined by #2186. Binding one project must not alter another project's
   operator-primary route.
4. Keep one shared orchestrator prompt and one shared manager/worker/flow-manager
   template set outside git. Replace project literals with
   `{PROJECT_ID}`, `{REPOSITORY}`, `{PRIMARY_ROOT}`, `{PACK_ROOT}`,
   `{DEFAULT_BRANCH}`, and `{VERIFY}`. Start specs name the card path.
   Invoke pack scripts from `{PACK_ROOT}` with `--project {PROJECT_ID}`,
   never "from this worktree".
5. Remove the retired
   `~/.config/orchestrator-fleet/<projectId>.env`. Render the tracked
   `scripts/fleet/fleet-wake@.service` from the selected stable pack checkout
   by replacing `{PACK_ROOT}` with its absolute path; do not render it from a
   target `primaryRoot`.
6. Run `systemctl --user daemon-reload`, enable/restart the relevant
   `fleet-wake@<projectId>` instance, and smoke a project whose
   `primaryRoot` contains no pack scripts. Confirm its log reports a normal
   fleet result and its polling/last-sent state is isolated under that exact
   project id.
7. Validate both the pack card and every adopted target card with
   `node --experimental-strip-types "$PACK_ROOT/scripts/lib/Invoke-TypeScriptCli.ts" --repo-root "$PACK_ROOT" --script "$PACK_ROOT/scripts/lib/target-context.ts" -- check --project <projectId>`.

For a non-pack target, do not adopt the supervisor/first-task steps until #2186
and #2187 have landed as described in
[the target deployment runbook](target_repo_setup.md#deploy-the-pack-into-a-target-project).

### Rollback

Disable the affected `fleet-wake@<projectId>` unit, stop the per-project
supervisor only when #2186 is present and that supervisor was started, and remove
only the target card being rolled back. Reverting repository code is separate
from operator-machine cleanup. Do not restore the retired per-project fleet env
file or ambient Browser-GPT project URL as a fallback.


## Multi-agent live executor profiles (Issue #1610)

### What changed

The six existing `PACK_EXECUTOR_*_{AGENT,MODEL,EFFORT}` triples remain the only
live executor-profile inputs, but their tracked interpretation is now owned once by
`scripts/executor-profile-policy.ts`. That pure policy has a closed two-family
mapping: task-launch profiles recognize Cursor through the task token
`cursor-agent` and OpenCode through `opencode`; smoke profiles recognize Cursor
through `cursor` and OpenCode through `opencode`. Cursor smoke still enters the
existing `agent` executable surface. Concrete model and effort values remain
operator-local and are not tracked here.

Task route admission now happens inside the production `resolveProfile` edge of
`supervised-task-launch-assistant.ts`, before manager Task creation, worktree
creation, terminal spawn, or supervised start. Cursor route applicability remains a
static code-owned fact; it does not gain a fresh route-capability probe. OpenCode is
recognized semantically, but a live route is admitted only after the selected model
is present in `opencode models` and fresh non-mutating installed help/capability
surfaces prove a route that can carry both the selected model and effort. A machine
that cannot prove that channel returns the shared external gate rather than silently
falling back, dropping effort, or changing executor family.

Model-catalog applicability and route admission remain separate. Cursor's historical
opaque model/effort composition is confined to the Cursor translator in the shared
policy; OpenCode keeps model and effort as separate request fields. The shared
pre-effect refusal vocabulary is `executor_route_unavailable`,
`executor_effort_channel_unavailable`, and task-only `executor_route_mismatch`.
Routine and complex smoke use the same policy and the same first two refusal causes
before child spawn. Firefighter execution continues to select the existing routine
or complex smoke profile and gains no `PACK_EXECUTOR_FIREFIGHTER_*` namespace.

Worker-start recovery is attempt-bound. The assistant retains provider receipts only
as internal post-effect integrity evidence, projects only safe PACK-owned result
fields, drops provider-authored recovery commands and free-form provider payloads,
and composes the sole outward retry command from the attempted route/profile plus
the exact provider request id. A retry never re-reads mutable profile state.

No OpenCode provider-form or RuntimeAdapter environment seam was added by #1610.
Those surfaces are conditional on fresh installed capability evidence proving an
exact supported provider request or structured spawn environment requirement; absent
that evidence, the current provider/runtime contracts remain byte-for-byte outside
this cutover.

### Operator adoption

1. Adopt the merged #1610 revision through the normal supported PACK
   deployment/recycle path. Do not copy concrete executor values into tracked files.
2. Keep the selected work-class or smoke-complexity triple in the machine-local
   executor profile store before the task assistant or smoke launcher runs; stored
   fenced keys override live environment values. The package does not add a dotenv
   fallback.
3. For Cursor, confirm the selected opaque catalog identity is present in
   `cursor-agent --list-models`. For OpenCode, confirm the selected model appears in
   `opencode models` and let the launcher inspect the installed non-mutating help
   surfaces before any effect. Do not infer route support from package installation
   alone.
4. Treat `executor_route_unavailable` and
   `executor_effort_channel_unavailable` as external pre-effect gates. An explicit
   caller `startMode` that conflicts with the only proven route returns
   `executor_route_mismatch`; the caller cannot override it into a mutation.
5. On an outcome-unknown worker-start, execute only the PACK-produced
   `nextAction.command` with the same request id. Never replay a provider-authored
   recovery string, re-read a changed profile, create a replacement terminal, or
   silently switch executor family while the original attempt is unresolved.
6. Check one controlled task launch and one routine/complex smoke launch for each
   family that is actually admitted on the installed machine. If OpenCode remains
   externally gated, record that gate as the truthful adoption result rather than
   inventing an unsupported provider/TUI form.
7. Keep firefighter routing on the selected routine/complex smoke profile; do not
   create a firefighter-specific profile triple.

### Rollback

Rollback is a source-control revert followed by the normal supported PACK
adoption/recycle path. Do not preserve #1610 by adding a second profile registry,
provider fallback, compatibility agent token, alternate retry channel, or runtime
environment shim. Provider receipts, WorkerAssignments, and current runtime state
remain subject to the revision that owns them.

## S3 fleet escalation delivery (Issue #1260)

### What changed

The existing bounded TypeScript scheduler now consumes the exact current
`fleet-reconciliation-handoff/v1` record only after that same scheduler invocation
successfully commits and reads it back. Every current `orchestrator_required`
reason is inherited from S1/S2 reconciliation without reclassification. S3 renders
bounded deterministic content from durable reconciliation facts and makes at most
one call to the existing `publishOperatorMessageOnce(...)` seam, only inside the
landed #1532 `withCurrentOperatorPrimaryTarget(...)` synchronous target action.

The scheduler returns the S3 result as `fleetEscalation`; there is no second
recorder, result store, journal, acknowledgement, retry queue, fallback transport,
or dedup lifecycle. `submitted` means only that the runtime submit attempt was
accepted. `ambiguous` never authorizes a resend. A separately admitted explicit
invocation may therefore duplicate an alert.

The implementation base contains the required landings:

- #1245 / PR #1264: `54cf33decf062a7f38fa5a8a02d02053f5089db1`;
- #1258 / PR #1278: `c83c27d9a1d87a5e8136deef76abaa014b5a105c`;
- #1259 / PR #1357: `6cce14b7379a80e5999179476432e6c6e0bcadd8`;
- #1352 / PR #1378: `936e8bd4530aa25085a7a3299efd1588fdf814b4`;
- #1420 / PR #1421: `8c70a1fc70fceeb998bbab077408bbc07e9d93eb`;
- #1440 / PR #1446: `7250a03a2b1b5dc429da39596d965f409c1ad449`;
- #1532 / PR #1585: `c1a6680a96af28a5b33711d73dbacf2297b82b24`.

### Operator adoption

1. Adopt the merged #1260 revision through the normal PACK deployment/recycle path.
   Do not add an AO/PowerShell escalation route, second scheduler, daemon, queue,
   retry journal, or result store.
2. Confirm the current machine-local `operator-primary` designation with the
   canonical #1532 `show` command before expecting a positive S3 send. Repository
   history proving #1532 is landed does **not** prove that a particular host
   currently has a valid designation.
3. Run the production-wired proof:

   ```bash
   node --experimental-strip-types scripts/pr2-foundation/fleet-escalation-proof.ts
   ```

   It must emit exactly one terminal `fleet-escalation-proof/v1` JSON record with
   `producer: "orchestrator-pack"`, `datum: "$.fleetEscalation.result"`,
   `expected: "operator-escalation-only"`,
   `productionBoundary: "scheduler-to-current-operator-publication-seam"`,
   `resultSurface: "runSchedulerTick-return"`, zero forbidden actuator calls,
   zero AO/PowerShell calls, and `retryAuthority: "none"`. The proof injects a
   side-effect-free runtime target and does not send an external operator message.
4. Observe one real eligible reconciliation event after adoption and inspect the
   returned scheduler `fleetEscalation` result. Treat `submitted` as accepted
   submit only, `pre_dispatch_failure` as definite pre-submit failure, and
   `ambiguous` as possible submit with resend forbidden. Do not infer delivery,
   acknowledgement, processing, or completion from any of these values.
5. Confirm S3 remains notification-only: no worker/process/workspace remediation,
   assignment or operator-primary mutation, review start/publication, merge, label,
   or unrelated GitHub mutation is authorized by the S3 result.

See `docs/fleet-escalation-delivery.md` for the complete input, target, publication,
result-surface, duplicate-invocation, and non-remediation contract.

### Rollback

Rollback is an ordinary source-control revert of #1260 followed by the normal PACK
adoption/recycle path. S3 owns no durable retry/dedup/result state, so no state
migration or cleanup is required. Do not preserve S3 by adding a compatibility
router, retry service, alternate target selector, or second result lifecycle.

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

New supervised manager and T1/T2/T3 starts use the pack-owned
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

Issue #1610 supersedes the original single-Cursor profile restriction in this
assistant. The machine-enforced profile boundary is now the shared
`scripts/executor-profile-policy.ts` contract: one selected stable triple, one of
the two closed executor families, executor-specific catalog applicability, a proven
route carrying both model and effort, and child inheritance before effects. Cursor
route admissibility is static; OpenCode route admissibility requires fresh installed
non-mutating capability evidence and otherwise remains externally gated. PACK still
does not scrape raw screen/title/preview/composer text to create a route witness.

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
   `--retry-request`. Never substitute a fresh brief, terminal, worker-start, or
   re-resolved executor profile while the original mutation remains unresolved.
6. After adoption, perform one controlled legal launch for every executor family
   actually admitted by the installed machine. Treat an OpenCode external gate as
   a truthful adoption result when no route proves both model and effort; do not
   work around it by dropping effort, changing family, or inventing a provider
   form.

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
   node --experimental-strip-types scripts/verify.ts
   node --experimental-strip-types scripts/verify.ts --reusable-only
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

## Activation epoch current-pointer integrity (Issue #1880)

### What changed

The single schema-v1 `FileEpochAuthority` now rejects persisted states that cannot
represent the writer's supported contract: `null` with retained history, a non-empty
current id that is not bound to a retained record, and malformed or empty current
values. Existing duplicate-id classification remains prior to current-pointer
classification. Valid empty state, exact non-empty identifiers (including whitespace
when exactly matched), stale-request, nonce-mismatch, and CAS behavior are unchanged.

Recovery reads this authority before import/projection/CAS/follow-up effects, and
wake-supervisor admission verifies it before registry projection or scheduler child
start. The tracked wake-supervisor CLI surfaces the exact secret-safe
`epoch_authority_current_pointer_invalid:*` diagnostic. A refused supervisor may
write its existing `refused` status with that classification; it must not produce a
normal/running child status.

### Operator adoption

After the merged PACK revision is adopted through the normal supported deployment
path, treat any `epoch_authority_current_pointer_invalid:*` result as a
stop/escalate condition. Do not use blind `activate`, generic `recover`, or direct
authority JSON editing as a repair. Issue #1880 deliberately adds no automated repair
or deactivation transition.

Repository acceptance covers producing and surfacing the classification. Any
operator-local launcher must adopt the merged behavior separately; repository workers
do not mutate local launcher files or machine-owned authority state.

### Rollback

Rollback is a source-control revert followed by the normal supported PACK
adoption/recycle path. It does not authorize rewriting an invalid authority file,
adding a compatibility reader, or restoring a second authority.

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
`rollback-preimport` with the same request. After the import boundary, `recover`
remains authoritative only for a structurally valid epoch authority. An
`epoch_authority_current_pointer_invalid:*` result is a stop/escalate condition,
not a repair invitation. Do not delete or hand-edit the evidence, cordon, epoch, or
follow-up artifacts.

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

## Per-project supervisor and durable-state migration (Issue #2186)

This section is the pre-change durable-store inventory required before the #2186
store owners are changed. `projectId` is a namespace selector only; every
project-scoped namespace must persist its resolved `repository` binding and
validate that binding against the current project card before resume, claim,
review pickup, or another state-consuming effect.

| Store / owner | Classification | Before #2186 | Target layout / identity |
| --- | --- | --- | --- |
| Wake-supervisor runtime, scheduler side-process state, cordon/foundation state; `scripts/pr2-foundation/wake-supervisor-state-root.ts` and `scripts/lib/cutover/**` | project-scoped | `$XDG_STATE_HOME/orchestrator-pack-wake-supervisor/` | `$XDG_STATE_HOME/orchestrator-pack-wake-supervisor/<projectId>/` plus a persisted repository binding |
| WorkerAssignment and operator-primary; `scripts/lib/worker-assignment-store.ts` / `scripts/operator-primary-binding.ts` | project-scoped, already partitioned | `~/.orchestrator-pack/projects/<projectId>/worker-assignments.json`; assignment records already carry projectId/repository | same path; consumers additionally validate current card repository before using persisted records |
| Create-Issue work state and canonical review authority; `scripts/lib/canonical-review-directory.ts` plus create-Issue stage owners | project-scoped | `~/.local/state/create-issue-draft/<Issue>/` and `~/.local/state/create-issue-draft/.review/<Issue>/` | `~/.local/state/create-issue-draft/<projectId>/<Issue>/` and `~/.local/state/create-issue-draft/<projectId>/.review/<Issue>/` with repository binding |
| Standalone discuss-with-gpt durable pass artifacts; `.claude/skills/discuss-with-gpt/driver.mjs` and `.cursor/skills/discuss-with-gpt/SKILL.md` | project-scoped | `~/.local/state/discuss-with-gpt/<draft-slug>/` | `~/.local/state/discuss-with-gpt/<projectId>/<draft-slug>/` with repository binding |
| discuss-with-gpt CDP/profile owner; `.claude/skills/discuss-with-gpt/verify-cdp-owner.mjs` | host-global | `~/.local/state/discuss-with-gpt/cdp-<port>-owner.json` | unchanged host-global path |
| Worker status/report stores; `scripts/lib/worker-status-store.mjs` / `docs/worker-report-store.mjs` | project-scoped | files directly under the flat wake-supervisor root | same file names under `orchestrator-pack-wake-supervisor/<projectId>/` |
| Worker smoke receipts; `scripts/lib/worker-smoke-receipt.ts` | project-scoped | `.../orchestrator-pack-wake-supervisor/worker-smoke-receipts/` | `.../orchestrator-pack-wake-supervisor/<projectId>/worker-smoke-receipts/` |
| PR-session binding cache; `scripts/pack-review-runner.ts` / `docs/pr-session-binding-cache.mjs` | project-scoped | `.../orchestrator-pack-wake-supervisor/pr-session-binding-cache.json` | same file under the selected project wake root |
| Pack-review run state; `scripts/lib/pack-review-run-store.ts` | project/repository-scoped, already partitioned | `~/.orchestrator-pack/review-runs/<projectId>/`; run records carry projectId and canonical repository when known | same root; consuming paths require current card repository binding |
| Worker-message dispatch journal and dispatch-terminal mail ledger; `scripts/pr2-foundation/wake-supervisor-state-root.ts` | project-scoped | files directly under the flat wake-supervisor root | same file names under the selected project wake root |
| Browser-GPT recurrence plus create-Issue handoff/terminal/output records; `scripts/chatgpt-browser-turn/**` and create-Issue stage owners | project-scoped | recurrence at `~/.local/state/create-issue-draft/browser-turn-recurrence.jsonl`; governed handoff artifacts live under the canonical create-Issue review/work tree | recurrence and governed handoff records live under the selected project's create-Issue namespace |
| Mechanical transport scratch / machine browser profile and executable configuration | host-global or invocation-local | existing machine-global/scratch locations | unchanged; these are not repository/task durable authority |

Migration is one store-generic cutover rule, not a new migration subsystem. Before
publishing a project destination, stop or fence every writer to the source and
prove the source stable. The destination must be absent or empty. Copy/move must
preserve authoritative bytes and identity and must be read back before the
existing cutover commit boundary is crossed. Before that durable boundary, only
the source is authoritative and an incomplete destination is not consumable.
After it is crossed, only the destination is authoritative and recovery may only
finish source retirement/cleanup. Source and destination both containing live
authority, a repository-binding mismatch, a live writer, or an unprovable
commit-boundary state fails closed; never merge or overwrite the stores.

The existing pack flat wake-supervisor state is migrated once to the
`orchestrator-pack` project namespace. Before producing foundation evidence,
stop the pre-#2186 pack supervisor through the supported old-revision
stop/recycle path and quiesce one-shot writers; the process census deliberately
attributes an unqualified legacy TypeScript supervisor to `orchestrator-pack`
and refuses migration while it remains live. Do not kill processes by title or
substring.

For `--project orchestrator-pack`, the cutover CLI automatically adds the
known flat wake payload stores plus legacy create-Issue `.review`, numeric work
directories, Browser-GPT recurrence state, and unscoped standalone
discuss-with-gpt artifacts to the existing activation transaction. It does not
byte-copy cordon/epoch/supervisor control-plane files: that same transaction
recreates those under the project root and remains their sole commit/recovery
authority. The canonical create-Issue `.review/<Issue>` authority therefore
uses the same absent/empty-destination, source-digest, read-back, CAS and
post-commit source-retirement sequence as the wake payload stores. If execution
stops after publication, rerun the same activation/recovery request with the
same `--project orchestrator-pack`; the persisted cordon/epoch authority, not
directory presence, decides whether recovery finishes forward or refuses an
unprovable state.

The `cdp-<port>-owner.json` record is excluded because it owns one
machine/profile, not one repository. Existing discuss-with-gpt directories that
already contain a project binding are also excluded from the legacy pack move.

The old ad-hoc LeoPoker create-Issue directory is operator-owned. Run this
one-time move only after stopping its writers and consumers, from the trusted
pack checkout. The source and destination must be on the same filesystem.
The project binding is durably written to the quiesced *source* before the
atomic directory rename, so no partially copied/unbound destination is exposed.
The command accepts a completed earlier move only if its binding matches the
current card; it never combines two populated layouts.

```bash
node --experimental-strip-types --input-type=module <<'NODE'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { resolveTargetContext } from './scripts/lib/target-context.ts';
import { assertProjectStateBinding } from './scripts/lib/project-state-binding.ts';

const selected = resolveTargetContext({ projectId: 'leopoker' });
const identity = { projectId: selected.projectId, repository: selected.repository };
// Create-Issue's current canonical owner is HOME-based, independent of XDG_STATE_HOME.
const root = path.join(process.env.HOME || homedir(), '.local', 'state');
const source = path.join(root, 'leopoker-create-issue-draft');
const destination = path.join(root, 'create-issue-draft', 'leopoker');
if (!existsSync(source)) {
  if (!existsSync(destination)) throw new Error('leopoker_migration_source_missing');
  assertProjectStateBinding(destination, identity);
  console.log('leopoker_already_migrated_and_bound');
} else {
  if (existsSync(destination)) throw new Error('leopoker_migration_both_layouts_present');
  const bindingPath = path.join(source, 'project-binding.json');
  if (!existsSync(bindingPath)) {
    const fd = openSync(bindingPath, 'wx', 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify({ schema: 'orchestrator-pack/project-state-binding/v1', ...identity }, null, 2)}\n`);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    const dirFd = openSync(source, 'r');
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  }
  assertProjectStateBinding(source, identity);
  mkdirSync(path.dirname(destination), { recursive: true });
  renameSync(source, destination); // atomic: EXDEV fails instead of cross-filesystem copy
  const dirFd = openSync(path.dirname(destination), 'r');
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  assertProjectStateBinding(destination, identity);
  console.log('leopoker_migrated_and_bound');
}
NODE
```

Never start a consumer between stopping the old writers and the final
repository-binding read-back. A retargeted card, unbound existing destination,
or dual live layouts fail closed without overwriting state.

## Ongoing adoption rule

Keep this file limited to currently actionable operator changes. Historical
procedures remain available in Git history but must not be copied back into active
runbooks when they prescribe removed commands, configuration, state, packages, or
transport.