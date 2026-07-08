# Orchestrator must autonomously respawn dead assigned workers without planning new work

GitHub Issue: #593

## Prerequisite

- `docs/issues_drafts/82-session-runtime-liveness-contract-satisfiable.md`
  (GitHub #250, closed) defines satisfiable runtime liveness and fail-closed
  handling for missing or ambiguous runtime fields.
- `docs/issues_drafts/104-orchestrator-spawn-git-process-boundary-deny.md`
  (GitHub #324, closed) keeps raw autonomous spawn/git mutation denied unless
  a sanctioned pack path admits the exact operation.
- `docs/issues_drafts/143-orchestrator-spawn-policy-toggles.md`
  (GitHub #458, closed) makes autonomous spawn actions policy-controlled.
  This draft follows the same pattern for autonomous respawn with a committed,
  fail-closed operator kill-switch toggle that defaults OFF.
- `docs/issues_drafts/166-orchestrator-worker-recovery-sanctioned-path.md`
  (GitHub #522, closed) shipped the sanctioned recovery entrypoint,
  claim-before-act lifecycle, candidate-scoped worktree cleanup, bounded retry,
  and policy/grant-routed respawn.
- `docs/issues_drafts/194-worker-recovery-branch-aware-cleanup.md`
  (GitHub #592) is a hard prerequisite for enabling autonomous crash respawn.
  Without it, automatic respawn can repeatedly fail on the previous worker
  branch. If implementation lands the reconciler code first, recoverable crash
  handling must remain disabled until #194's branch-safe recovery contract is
  present.
- `docs/issues_drafts/34-review-layer-resilience-after-worker-respawn.md`
  (GitHub #98, closed) owns review-layer hygiene after a respawn exists. This
  draft only recreates or reattaches the dead worker.

Prior-art verdict: **extension of #522, not a new recovery mechanism**. The
entrypoint already has `-Trigger reconcile_dead_worker`, but recon found no
live caller in `scripts/`, `plugins/`, `prompts/`, or `.github/`. Existing
reconcilers/nudges intentionally do not recover dead sessions.

Knowledge-base consult: `Fault tolerance.md` says partial failures require
explicit failure models; `Rollback.md` frames recovery as restoration to a
known-good state. Synto returned no relevant published article. Applied here:
the reconciler binds to captured AO death evidence, classifies kill origin, and
fails closed instead of guessing from stale status alone.

## Goal

The orchestrator must detect that an already-assigned worker died before its
task reached a terminal outcome and must autonomously invoke the sanctioned
worker recovery path end-to-end. It must not respawn after an operator shutdown
or manual session kill, must not plan new work from open issues, and must
escalate once on ambiguous state or exhausted recovery budget.

```behavior-kind
action-producing
```

```positive-outcome
asserts: a capture-backed dead assigned worker with unfinished issue or PR ownership is classified as recoverable and triggers exactly one sanctioned worker recovery attempt, while operator-killed, merged, live, ambiguous, and budget-exhausted cases do not auto-respawn
input: realistic
provenance: capture-backed
```

## Binding surface

- Detection is bound to durable AO evidence captured under AC#1. The opk-128
  capture proves `session.kill_started`, `ui.terminal_pty_lost`, and
  `session.killed` with `reason: manually_killed`; other event names or
  project-level shutdown markers are AC#1 capture deliverables, not assumptions
  in the binding surface.
- Current `ao status --json` returns top-level `data`, `reviews`, and `meta`;
  active worker rows do not expose a stable `runtime` field in the active view,
  and terminated sessions are hidden behind `meta.hiddenTerminatedCount`.
  Detection must not depend on a runtime field unless a capture proves it for
  the target AO version.
- The 2026-07-04 opk-128 evidence proves operator-origin discrimination is
  feasible for at least one shutdown shape: `session.kill_started` and
  `session.killed` carry `data.reason: manually_killed`, adjacent to
  `ui.terminal_pty_lost`. That shape is a suppression case, not a respawn case.
- `ui.terminal_pty_lost` alone is not enough for respawn; in opk-128 it appeared
  during a manual kill with exit code 0. Crash/PTY-loss recovery requires
  absence of operator suppression evidence plus unfinished task ownership and
  dead-runtime evidence.
- The reconciler invokes `scripts/invoke-worker-recovery.ps1 -Trigger
  reconcile_dead_worker` only after it has independently produced the
  `probedDeadEvidence` classification. The current recovery library sets
  `probedDeadEvidence` from the trigger string; this draft makes that caller
  proof load-bearing.
- The reconciler has its own durable observation cursor before invoking #522.
  The reconciliation key includes at least session id, issue or PR id, branch,
  worktree path, death event id or timestamp, observed head/start OID when
  available, and classifier version. Processed, suppressed, escalated,
  claim-lost, and recovered outcomes are persisted under that key.
- Before invoking `invoke-worker-recovery.ps1`, the reconciler persists an
  `attempt_started` lease under the reconciliation key. Replay reconciles that
  lease against the #522 recovery claim, live owner, and task-level claim before
  any retry.
- Autonomous crash respawn enablement is fail-closed behind a machine-checkable
  capability gate: the default-OFF autonomous respawn policy toggle is enabled
  by explicit operator adoption, #522 recovery checks pass, #194 branch-safe
  recovery checks pass by name, retry/storm bounds are configured, and effective
  runtime policy reports the narrow Option C rule. Detection predicates are
  capture-pinned; any observed shape outside the captured set fails closed to
  audit-only. If any gate is missing, the reconciler audits only and does not
  invoke recovery.
- "Silence until state changes" is keyed to the persisted reconciliation key.
  Silence is invalidated only by a new death event for the same session, a new
  live owner for the task, branch OID/state change, PR/issue terminal-state
  change, manual operator acknowledgement, or explicit retry-budget reset.
- Shutdown suppression uses project-level evidence captured under AC#1, not
  guessed event names. Those captured markers define a bounded, operator-tunable
  shutdown suppression window. Partial, reordered, or missing per-worker kill
  events inside that window suppress or escalate; they do not respawn.
- Ownership resolution order is: consumed spawn/recovery grant lineage for the
  session, then AO session/event records that agree on session id, issue/PR,
  branch, worktree, and repository identity, then GitHub PR/issue live state as
  terminal-state refinement. Disagreement or truncated records fail closed.
- Issue-only ownership is not enough when a branch may have produced a PR.
  Recovery needs captured PR identity or a branch-to-PR lookup with
  unambiguous result; multiple matches, unavailable lookup, or merged/closed PR
  uncertainty fails closed.
- GitHub terminal-state refinement uses live PR merged/closed state, issue
  closed state, and current head SHA when a PR exists. If any required field is
  unavailable and affects whether work is unfinished, recovery escalates once
  instead of using stale cache as proof.
- Every decision emits structured audit with classification, evidence ids,
  suppression reason, target issue/PR, branch/worktree identity, recovery claim
  result, retry budget state, and next allowed action.
- Storm bounds are explicit, persisted, restart-surviving, and operator-tunable.
  Suggested defaults are 3 recovery attempts per reconciliation key,
  exponential backoff starting at 60 seconds with jitter, and project
  concurrency cap 1, but the planner owns the final defaults.
- Clean exits are split into `clean_exit_terminal` and
  `clean_exit_unfinished`. Terminal suppression requires live task terminal
  proof such as merged/closed PR or closed issue; clean exit without terminal
  proof is escalation-only unless the fixture also contains positive
  non-operator abnormal-death evidence.
- Capture fixtures have a scrub contract: sanitization preserves uniqueness,
  ordering, path-shape class, repository identity class, reason values, stable
  synthetic ids across related fixtures, branch/worktree relation, issue/PR ids,
  and classifier-critical timestamps.
- Cleanup-zombie detection by absence is out of scope for autonomous respawn.
  A non-terminal stale/cleanup-looking worker without positive death evidence
  remains on the existing report-stale/backstop path; the reconciler may emit
  one audit-visible `cleanup_zombie_unclassified` marker but must not respawn.
- Rate-limit-caused unknown GitHub state uses a distinct escalation reason such
  as `blocked_rate_limit_pr_unknown`, so operators can distinguish quota
  exhaustion from genuinely ambiguous task state. Recovery GitHub reads should
  consume the shared budget/governor established by drafts 191-193 / #583-#585
  rather than inventing an independent governor here.
- Scope is only assigned unfinished work: a session with a bound issue or PR
  and no terminal outcome. The reconciler must not scan open issues and spawn
  workers that were never assigned.
- Operator-facing prose in `prompts/agent_rules.md` and mirrored docs that say
  reconcilers do not recover dead sessions become stale after this ships and
  must be updated with the narrow Option C rule.

```contract-evidence
binding-id: orchestrator-pack:dead-worker-reconciler:captured-death-contract
binding-type: cli-behavior
binding: dead-worker detection binds only to AO fields/events captured for the supported AO version
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:dead-worker-reconciler:operator-kill-suppression
binding-type: cli-behavior
binding: operator ao stop/session kill evidence suppresses autonomous worker respawn
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)

binding-id: orchestrator-pack:dead-worker-reconciler:assigned-task-only
binding-type: cli-behavior
binding: auto-respawn only reattaches the dead worker's unfinished assigned task and never plans new work from open issues
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)

binding-id: orchestrator-pack:dead-worker-reconciler:storm-bounded-single-flight
binding-type: cli-behavior
binding: simultaneous dead-worker detections are bounded by per-worker recovery claims, retry budget, backoff, and a project-level storm guard
producer: orchestrator-pack
evidence: NEW(produced-by AC#4)
```

## Files in scope

- `scripts/**`
- `prompts/agent_rules.md`
- `agent-orchestrator.yaml.example` if the effective runtime policy gate needs
  an example-config rule update
- `docs/**`
- `tests/**`
- `tests/external-output-references/**` for scrubbed AO event/status captures
- `.github/workflows/**` only if reusable verification wiring is needed

## Files out of scope

- `vendor/**`
- `packages/core/**`
- `.ao/**`
- `agent-orchestrator.yaml`
- Composio AO core patches or vendored source edits.
- Operator adoption of live `agent-orchestrator.yaml` rules; this PR documents
  it, but the operator applies daemon-cached runtime config.
- Fast alerting UX beyond the single escalation signal.
- The self-clearable `SURFACE=0` window.
- Review-layer post-respawn behavior; #98 owns that.
- New issue planning from the open GitHub issue queue.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
```

```allowed-roots
scripts/**
prompts/**
docs/**
tests/**
tests/external-output-references/**
.github/workflows/**
```

## Acceptance criteria

1. **Death-signal contract is capture-backed.** Scrubbed fixtures capture AO
   0.9.x event/status/session shapes for at least: crash or runtime-lost
   termination, operator `ao stop` or `ao session kill`, PTY loss, clean exit or
   `pr_merged`, spawn rollback/failure, and any project-level shutdown markers
   used for suppression. Each fixture states which fields are present and which
   are absent; predicates may not bind to fields missing from captures. Observed
   shapes outside the captured set fail closed to audit-only.

```producer-emission
producer: orchestrator-pack
datum: dead-worker-reconciler
expected: captured-death-contract
proof-command: implementation-specific AO event/status capture replay
```

2. **Operator-origin kills suppress respawn.** An `ao stop`/shutdown window and
   an explicit `session.kill_started`/`session.killed` event with
   `reason: manually_killed` suppress autonomous respawn for affected workers.
   The opk-128 style sequence (`session.spawned` -> `session.kill_started` ->
   `ui.terminal_pty_lost` -> `session.killed`) is a no-respawn fixture.

```producer-emission
producer: orchestrator-pack
datum: dead-worker-reconciler
expected: operator-kill-suppression
proof-command: implementation-specific operator-kill suppression fixture
```

3. **Recoverable crash path invokes #522 exactly once.** A dead worker with
   unfinished bound issue/PR, no operator suppression evidence, no live owner,
   safe branch/worktree state, and retry budget available triggers exactly one
   `invoke-worker-recovery.ps1 -Trigger reconcile_dead_worker` attempt under the
   existing recovery claim. Claim losers and concurrent ticks record no-op
   outcomes. The invocation is covered from CI-runnable Linux `pwsh`, including
   paths with spaces and mixed slash styles. The test also proves the
   machine-checked enablement gate for the default-OFF respawn toggle,
   #194/#522, configured bounds, and effective runtime policy passes before
   recovery can run. Windows-host PowerShell behavior is not covered by this
   repo's current `ubuntu-latest` CI matrix.

```producer-emission
producer: orchestrator-pack
datum: dead-worker-reconciler
expected: assigned-task-only
proof-command: implementation-specific recoverable-death fixture
```

4. **Scenario matrix is explicit.** Tests or table-driven fixtures cover:
   death cause `{crash/runtime_lost, operator stop/session kill, PTY lost, clean
   exit/pr_merged, cleanup-zombie}` x branch state `{absent, exists expected
   OID, exists diverged}` x worktree state `{present, destroyed, dangling
   gitdir}` x PR state `{none opened, open, merged}` x retry history `{first,
   within budget, exhausted}` x concurrency `{reconciler vs operator spawn,
   reconciler vs recovery claim}` x suppression `{inside shutdown window,
   outside window}`. Each cell has allow, skip, preserve, or escalate as an
   expected outcome.

```producer-emission
producer: orchestrator-pack
datum: dead-worker-reconciler
expected: storm-bounded-single-flight
proof-command: implementation-specific dead-worker matrix tests
```

5. **Storm guard handles fleet shutdown.** If `ao stop` or daemon shutdown kills
   many workers, the reconciler does not start N respawns. Suppressed deaths are
   recorded compactly; unsuppressed recoverable deaths are bounded by per-worker
   claims plus persisted, explicit, operator-tunable retry/backoff/concurrency
   bounds. Suggested defaults are 3 attempts, 60-second initial exponential
   backoff with jitter, and project concurrency cap 1. Fixtures include partial
   and reordered shutdown events inside the configured suppression window.
6. **Operator wins races.** If a manual operator `ao spawn` races the reconciler
   for the same issue/PR, the reconciler observes the new live owner or active
   recovery claim and does not double-spawn. Verification covers a manual spawn
   starting after the reconciler's first no-live-owner check but before recovery
   side effects; the reconciler uses a task-level single-flight claim or a
   second live-owner check after acquiring the recovery claim and immediately
   before spawn/git side effects.
7. **Ambiguity fails closed.** Ambiguous liveness, missing task ownership,
   ambiguous kill origin, missing branch safety, GitHub REST uncertainty that
   affects terminal PR state, or exhausted retry budget produce one durable
   operator-facing escalation and then silence until state changes.
8. **Durable cursor and audit are replay-safe.** Reconciler restart, AO restart,
   log replay, or crash after escalation does not duplicate respawn, duplicate
   escalation, or lose the next permitted action. State-change invalidation is
   fixture-backed for new live owner, new death event, PR terminal-state change,
   branch OID change, manual acknowledgement, and retry reset. A crash after
   `attempt_started` but before #522 outcome is reconciled against the #522
   claim/live owner before retry.
9. **Clean exits are not collapsed.** Fixtures distinguish terminal clean exit
   from clean unfinished exit. `pr_merged`/closed terminal proof suppresses;
   clean exit without terminal proof is escalation-only unless positive
   non-operator abnormal-death evidence exists.
10. **Cleanup-zombie remains out of auto-respawn.** A non-terminal stale or
   cleanup-looking worker without positive death evidence is not auto-respawned.
   It remains covered by report-stale/backstop behavior and may emit one
   audit-visible `cleanup_zombie_unclassified` marker.
11. **Rate-limit unknowns are visible.** GitHub rate-limit failures during
   PR/issue terminal-state refinement produce a rate-limit-specific escalation
   reason and name the seam with drafts 191-193 / #583-#585.
12. **Effective runtime policy is reported.** Verification reports the running
   daemon's effective policy/config state separately from docs/example config,
   even when applying live `agent-orchestrator.yaml` remains an operator step.
13. **Prompt/runtime surface updated.** `prompts/agent_rules.md` and durable docs
   no longer say reconcilers categorically do not recover dead sessions. They
   state the narrow rule: auto-respawn applies only to a dead worker that was
   already assigned unfinished work and is not operator-suppressed. Operator
   adoption notes mention daemon config cache/session prompt restore traps.
14. **No new planning surface.** Static or fixture-backed verification proves the
   reconciler derives target issue/PR only from the dead worker's captured
   session/task binding, never from open issue scans or GitHub queue selection.
15. **Issue-only PR ambiguity fails closed.** Fixtures cover issue-only sessions
   where no PR exists, exactly one branch-matching PR exists, a PR is
   merged/closed, and multiple PRs match. Ambiguity or terminal PR state blocks
   respawn.

## Upgrade-safety check

- The #324 boundary remains intact; all git mutation stays inside #522/#194
  sanctioned recovery and existing spawn grants.
- No edits to AO core or vendored source.
- Recovery is fail-closed on ambiguity and rate-limited across project storms.
- The replacement worker inherits only the dead worker's own unfinished task;
  no autonomous planning of unassigned issues is introduced.
- Operator kill/shutdown remains authoritative.

## Verification

- AO event/status/session capture replay tests for AC#1-AC#4.
- Focused reconciler tests for operator suppression, crash recovery,
  cleanup-zombie handling, retry budget, project-level storm guard, and
  operator/manual spawn races.
- Durable cursor/audit replay tests for restart, duplicate observation, and
  silence invalidation.
- Crash-after-invoke replay test for the `attempt_started` lease.
- Manual `ao spawn` race/TOCTOU fixture.
- Issue-only branch-to-PR ambiguity fixtures.
- Machine-checked enablement-gate tests for the default-OFF respawn toggle,
  #194/#522 checks, configured bounds, and runtime policy.
- GitHub terminal-state precedence tests for PR merged/closed, issue closed,
  current head SHA, and unavailable fields.
- Clean-exit terminal vs unfinished fixtures.
- Capture scrub-contract validation.
- Configured retry/backoff/concurrency/shutdown-window bound tests, including
  suggested defaults as fixtures without freezing them as spec constants.
- Cleanup-zombie audit-only/report-stale fixture.
- Rate-limit-specific escalation fixture and shared-governor seam assertion.
- Effective runtime policy report check.
- Linux `pwsh` invocation/path quoting tests.
- Regression tests for #522 worker recovery and draft 194 branch cleanup.
- Static guard that no new open-issue planning path feeds respawn.
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/195-autonomous-dead-worker-reconciler.md`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command parked-root -DraftPath docs/issues_drafts/195-autonomous-dead-worker-reconciler.md`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/195-autonomous-dead-worker-reconciler.md`
- Before implementation PR handoff:
  - `pwsh -NoProfile -File scripts/verify.ps1`
  - `pwsh -NoProfile -File scripts/check-reusable.ps1`

## Operator Adoption

Autonomous respawn ships behind a committed default-OFF policy toggle following
the #458 spawn-policy toggle pattern. Operator adoption explicitly flips that
toggle ON only after #194/#522 checks, capture fixtures, runtime policy report,
and prompt/doc updates are present. If implementation touches live
`orchestratorRules` or `agent-orchestrator.yaml.example`, the PR documents that
the operator must apply the live config change and restart AO (`ao stop` /
`ao start`) because daemon config and restored session prompts can cache stale
rules. The worker PR must not edit the gitignored live `agent-orchestrator.yaml`.

## Decisions

### Recon notes

- GitHub REST states on 2026-07-04: #511, #522, #561, and #567 are CLOSED.
- `rg` found `reconcile_dead_worker` in the recovery entrypoint/model/tests but
  no live reconciler caller.
- Current event search for `agent_process_exited` returned no events, while
  opk-128 search returned `session.kill_started`, `ui.terminal_pty_lost`, and
  `session.killed` with `reason: manually_killed`.
- Current `ao status --json` active view has `data/reviews/meta`; it hides
  terminated sessions and does not expose stable runtime fields in active rows.
- Session JSON records across the local store commonly include `worktree`,
  `branch`, `issue`, `runtimeHandle`, `lifecycle`, `lifecycleEvidence`, and
  `status`, but opk-128's live session file was mostly truncated to `createdAt`.
  Detection must tolerate incomplete records by using event/status capture
  replay and fail-closed rules.

### Options judged

1. **Teach the LLM prompt to run recovery manually on sight.** Rejected; it is
   not autonomous and repeats the current operator/LLM turn dependency.
2. **Add a new recovery pipeline.** Rejected; #522 already shipped the legal
   cleanup/spawn primitive and claim lifecycle.
3. **Add a dead-worker reconciler/event consumer that invokes #522.** Chosen.
   It is the smallest extension that removes the operator step while preserving
   boundaries.
4. **Respawn on any PTY loss or killed status.** Rejected; opk-128 proves PTY
   loss can be operator-initiated and must be suppressed.

### GPT / review log

- GPT pass 1 (`STATE=completed_valid`, validation ok) found missing durable
  cursor/dedupe, underspecified silence invalidation, weak shutdown suppression,
  assumed task identity, unbounded GitHub terminal-state uncertainty,
  cross-platform invocation risk, conditional #194 ordering, and implicit audit
  schema. Verdict: **accepted/partial**. The draft now requires a persisted
  reconciliation key/outcome ledger, explicit silence invalidation triggers,
  project-level shutdown-window suppression with partial/reordered event
  fixtures, ownership resolution precedence, live GitHub terminal-state
  refinement with fail-closed unavailable fields, hard enablement prerequisite
  on #194, structured audit fields, and cross-platform-shaped invocation
  coverage later narrowed to Linux `pwsh` fixtures after architect review.
- GPT pass 2 (`STATE=completed_valid`, validation ok) found enablement could
  slip while #194 is still TBD, retry/storm bounds lacked numeric defaults,
  clean exits were collapsed with terminal PR merges, AO version/schema
  compatibility was not enforced, scrubbed captures could erase classifier
  fields, and live runtime policy reporting was missing. Verdict:
  **accepted/partial**. The draft now requires a machine-checked capability gate,
  explicit default retry/backoff/concurrency/shutdown-window bounds, clean
  terminal vs unfinished exit classification, captured-shape fail-closed checks,
  scrub-contract validation, and effective runtime policy reporting.
- GPT pass 3 (`STATE=completed_valid`, validation ok) found missing
  pre-side-effect `attempt_started` state, manual `ao spawn` race TOCTOU,
  issue-only PR terminal-state ambiguity, unsafe clean-exit-unfinished recovery,
  and config example scope mismatch. Verdict: **accepted/partial after cap**.
  The draft now requires a pre-invoke lease, task-level/second-check
  single-flight against manual spawn, branch-to-PR ambiguity fail-closed rules,
  escalation-only clean unfinished exits unless abnormal evidence exists, and
  includes `agent-orchestrator.yaml.example` when needed. Post-GPT change not
  re-reviewed because the loop reached the 3-pass cap.

GPT loop: 3 passes; stopped because cap-3; last-pass accepted=5; final STATE=completed_valid VALIDATION=ok pass=102da21d-4135-4e52-84f1-0747351dc9f1 sha=20cb4882d4d7133e0f28827fb14fb1549866800ae5285719cd005403a77d2e91

### Revision after architect review

- 2026-07-04 architect review: replaced unbuildable Windows-host fixture with
  CI-runnable Linux `pwsh` path normalization/quoting coverage after confirming
  every workflow uses `ubuntu-latest`.
- Removed guessed binding-surface event names for project shutdown. Only the
  captured opk-128 `session.kill_started`, `ui.terminal_pty_lost`, and
  `session.killed` / `reason: manually_killed` shape is named in the binding
  surface; project-level shutdown markers are AC#1 capture deliverables.
- Removed AO schema-fingerprint registry machinery. The contract is
  capture-pinned predicates plus fail-closed audit-only behavior for uncaptured
  shapes.
- Changed frozen retry/storm numbers into operator-tunable configured bounds
  with suggested defaults, preserving planner freedom.
- Added default-OFF autonomous respawn policy toggle, cleanup-zombie
  out-of-scope/report-stale disposition, and rate-limit-specific escalation
  seam with drafts 191-193 / #583-#585.
- Decomposition decision: keep 195 as one implementation draft after cuts. The
  classifier, durable cursor, audit-only gate, and acting reconciler share one
  state machine and one enablement gate; splitting into 195a/195b would create a
  second handoff contract around the same cursor and likely duplicate fixtures.
  The default-OFF toggle and audit-only fail-closed gate still let the PR land
  safely before operator adoption enables action-producing respawn.
- Focused adversarial re-pass was performed without GPT per operator override
  (`gpt не нужен`); see
  `docs/issues_drafts/.review/195-autonomous-dead-worker-reconciler/revision-adversarial-pass.md`.
  No driver-error output was used as review evidence.