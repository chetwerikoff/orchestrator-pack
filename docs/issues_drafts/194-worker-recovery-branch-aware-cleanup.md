# Worker recovery must clean or classify orphan worker branches before respawn

GitHub Issue: #592

## Prerequisite

- `docs/issues_drafts/104-orchestrator-spawn-git-process-boundary-deny.md`
  (GitHub #324, closed) shipped the autonomous git boundary. This draft must
  keep branch deletion inside the sanctioned recovery parent, never as ambient
  autonomous git.
- `docs/issues_drafts/148-autonomous-spawn-worktree-git-provenance.md`
  (GitHub #470, closed), `docs/issues_drafts/149-spawn-grant-worktree-name-binding.md`
  (GitHub #472, closed), `docs/issues_drafts/157-spawn-grant-head-ref-oid-binding.md`
  (GitHub #493, closed), `docs/issues_drafts/162-spawn-grant-repository-identity-binding.md`
  (GitHub #511, closed), `docs/issues_drafts/183-spawn-grant-branch-operand-binding.md`
  (GitHub #561, closed), and `docs/issues_drafts/185-spawn-grant-consume-after-worktree-add.md`
  (GitHub #567, closed) cover the spawn worktree grant axes and finalization
  lifecycle. This draft composes with them; it does not add a new grant axis.
- `docs/issues_drafts/166-orchestrator-worker-recovery-sanctioned-path.md`
  (GitHub #522, closed) shipped the sanctioned worker recovery path with
  candidate-scoped `git worktree remove --force`, recovery claims, retry budget,
  and policy/grant-routed respawn. This draft extends that path only for the
  branch ref left behind by the dead worker.

Prior-art verdict: **new sibling to #522, not a second recovery pipeline**.
Code recon found no `git branch -D` or equivalent in
`scripts/lib/Worker-Recovery.ps1` or `scripts/invoke-worker-recovery.ps1`.
The current recovery path removes the worker worktree but leaves the branch
created by AO's `git worktree add -b`.

Knowledge-base consult: `Fault tolerance.md` frames this as partial-failure
recovery with explicit failure models; `Rollback.md` reinforces restoring a
known-good, configuration-consistent state. Synto returned no relevant
published article. Applied here: branch cleanup must restore a respawnable
state without destroying ambiguous surviving work.

## Goal

When a worker dies before finishing its assigned task, the sanctioned worker
recovery path must delete the local worker branch proven to be a disposable
orphan of that dead session or stop with a durable branch-preservation
diagnostic before respawn. A respawn must not fail merely because the previous
dead session left `feat/issue-N` behind, and recovery must not delete the only
surviving copy of unpushed worker work.

```behavior-kind
action-producing
```

```positive-outcome
asserts: recovery of a proved-dead worker whose disposable worker branch HEAD exactly equals the original grant start OID deletes that local branch before replacement spawn, while unpushed/diverged/open-PR/live-worktree branches are preserved with a durable escalation
input: realistic
provenance: capture-backed
```

## Binding surface

- The only sanctioned destructive cleanup parent remains
  `scripts/invoke-worker-recovery.ps1`; branch mutation must be admitted by the
  same recovery claim and autonomous boundary lineage as #522 worktree removal.
- The branch candidate is the branch bound to the dead session/task, such as
  the branch recorded in AO events/session state or the branch authorized by the
  consumed spawn grant for that session. Recovery must not discover and delete
  arbitrary branches by naming convention alone.
- A disposable branch is one whose branch HEAD OID exactly equals the original
  grant start OID for the dead session, is not checked out by any live
  worktree, has no confirmed open PR head, has no remote-only or local-only
  work, and matches the dead session's expected lineage.
- Missing upstream is not by itself preservation evidence. If the branch HEAD
  equals the original grant start OID and the open-PR check is confirmed absent,
  the local branch may be deleted even with no upstream. Missing upstream plus
  missing grant-start proof, branch HEAD mismatch, remote uncertainty, or local
  commits preserves.
- Open-PR state is tri-state: `confirmed_absent` permits deletion when all other
  branch predicates pass; `confirmed_present` preserves; `unknown` preserves
  with a deduped durable escalation.
- Remote/PR freshness is part of the destructive decision. While holding the
  recovery claim, recovery uses an observation whose age is within an explicit,
  persisted freshness bound and records the source in audit. Fetch/API failure,
  rate limit, stale observation, or uncertain remote branch state becomes
  `remote_unknown` or `pr_unknown` and preserves.
- Rate-limit-caused preservation uses a distinct escalation reason such as
  `blocked_rate_limit_pr_unknown` or `blocked_rate_limit_remote_unknown`, so
  operators can distinguish quota exhaustion from genuinely ambiguous branch
  ownership. Recovery GitHub reads should consume the shared budget/governor
  established by the GitHub fleet work in drafts 191-193 / #583-#585 rather
  than inventing an independent governor here.
- A branch with local-only commits, remote-only commits, diverged history, an
  open PR, live worktree occupancy, ambiguous ownership, missing lineage
  evidence, or unknown PR state is preserved. That outcome is a first-class
  escalation, not a failed script traceback.
- The recovery path must surface `branch_preexists` or equivalent before
  spawning when branch state would make AO's `git worktree add -b` fail. The
  replacement spawn is attempted only after the disposable local branch is
  deleted; reuse of an existing branch is out of scope unless a later draft
  explicitly changes and proves AO spawn semantics for existing branches.
- Lineage proof for destructive deletion requires the consumed spawn grant for
  the dead session. AO `session.spawned` events/session records may support a
  preservation/escalation diagnosis, but they do not by themselves prove the
  branch was created by AO or disposable. If the consumed grant is absent,
  recovery preserves.
- Branch deletion has a just-before-mutation revalidation step while holding the
  recovery claim: branch HEAD OID, worktree occupancy, repository identity,
  fresh remote/PR tri-state, task eligibility, and lineage fields must still
  match the disposable classification.
- The destructive mutation is expected-old-OID guarded. Recovery must delete or
  free the branch name only if the ref still points at the validated branch HEAD
  OID and no live worktree occupies it at mutation time; any OID or occupancy
  change preserves/escalates.
- Reflog-only or dangling surviving work is preservation evidence. If the
  branch reflog or reachable/dangling local objects indicate worker commits that
  were reset away after the original grant start, recovery preserves and
  escalates; quarantine refs are out of scope for this draft.
- Branch deletion writes both an intent audit before mutation and a completion
  audit after mutation, including repo identity, session id, task id, branch,
  deleted HEAD OID, predicates used, and respawn handoff id. Crash/resume after
  deletion but before respawn must observe this audit and continue or escalate
  without duplicate deletion, duplicate respawn, or ambiguous silence.
- The live 2026-07-04 incident is capture-backed but incomplete: opk-128's
  original grant remains; the opk-129 deny-side grant was not present during
  recon. Implementation closure must preserve or reproduce deny-side evidence
  before claiming a new grant-axis root cause.

```contract-evidence
binding-id: orchestrator-pack:worker-recovery-branch-cleanup:orphan-branch-safe
binding-type: cli-behavior
binding: a dead-session-owned worker branch that is not checked out, not diverged, and has no open PR is made safe before recovery respawn
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:worker-recovery-branch-cleanup:preserve-surviving-work
binding-type: cli-behavior
binding: branch cleanup preserves branches that may be the only surviving copy of worker work
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)

binding-id: orchestrator-pack:worker-recovery-branch-cleanup:branch-preexists-classified
binding-type: cli-behavior
binding: recovery classifies pre-existing worker branches before spawning instead of letting git worktree add fail opaquely
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)
```

## Files in scope

- `scripts/**`
- `docs/**`
- `tests/**`
- `tests/external-output-references/**` for scrubbed live/replay captures only

## Files out of scope

- `vendor/**`
- `packages/core/**`
- `.ao/**`
- `agent-orchestrator.yaml`
- Composio AO core patches or vendored source edits.
- Remote branch deletion unless a later architect decision explicitly expands
  scope; this draft is local branch state needed for respawn.
- General repository branch garbage collection, `git worktree prune`, or
  deleting branches unrelated to the dead worker's task lineage.
- Automatic death detection and trigger scheduling; draft 195 owns that.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
```

```allowed-roots
scripts/**
docs/**
tests/**
tests/external-output-references/**
```

## Acceptance criteria

1. **Disposable orphan worker branch is cleaned or made reusable.** A fixture
   starts with a terminated/dead worker, no worker worktree, branch
   `feat/issue-N` whose branch HEAD OID equals the original grant start OID, no
   confirmed open PR head, and no local-only, remote-only, or diverged commits.
   Recovery records branch deletion intent under the #522 claim, performs
   bounded fresh remote/PR observation, revalidates branch and task eligibility
   immediately before mutation, deletes the local branch, writes
   `branch_deleted` completion audit, then routes respawn through the existing
   spawn policy/grant path.

```producer-emission
producer: orchestrator-pack
datum: worker-recovery-branch-cleanup
expected: orphan-branch-safe
proof-command: implementation-specific focused branch cleanup fixture
```

2. **Potential surviving work is preserved.** Fixtures cover branch states:
   branch HEAD equals grant start OID with missing upstream, branch HEAD
   mismatch, exists diverged, local-only commits, remote-only commits, same-name
   remote branch advances after observation, fetch/API failure, rate-limit
   failure, checked
   out by another worktree, open PR confirmed present, open PR unknown, consumed
   grant absent, and ambiguous session/branch ownership. Only the disposable
   branch with fresh confirmed-absent remote/PR state and consumed-grant lineage
   is deleted; every preserving cell emits one durable operator-facing
   escalation and does not retry-storm.

```producer-emission
producer: orchestrator-pack
datum: worker-recovery-branch-cleanup
expected: preserve-surviving-work
proof-command: implementation-specific branch preservation matrix
```

3. **Branch-preexists is classified before respawn.** Recovery detects a
   pre-existing worker branch before invoking replacement `ao spawn`; the result
   is either a safe deletion path or a named `branch_preexists_preserved`
   style escalation. Verification must fail if the only signal is raw
   `git worktree add -b` stderr.

```producer-emission
producer: orchestrator-pack
datum: worker-recovery-branch-cleanup
expected: branch-preexists-classified
proof-command: implementation-specific spawn-preflight/recovery fixture
```

4. **Boundary stays narrow.** Branch deletion or reuse is admitted only from the
   sanctioned recovery parent while holding the matching recovery claim, and
   only for the claimed dead session/task. Raw autonomous `git branch -D` from
   other parents remains denied.
5. **Existing #522 behavior remains green.** Worktree cleanup, dirty artifact
   preservation, live-owner blocking, post-claim revalidation, bounded retry,
   and policy/grant-routed respawn tests continue to pass.
6. **Cleanup-to-respawn task eligibility is fresh.** While holding the recovery
   claim, recovery confirms the issue/PR still needs a replacement worker and no
   newer live owner has claimed it before deleting the branch or spawning.
   Closed/cancelled/superseded tasks and newer owners preserve/escalate.
7. **Crash-resume after deletion is auditable.** A fixture crashes after local
   branch deletion and before replacement spawn. Retry observes
   `branch_deleted` completion audit and either completes the same recovery
   handoff or emits one durable escalation without duplicate side effects.
8. **Ref mutation is atomic against expected HEAD.** Race fixtures cover branch
   HEAD advancing after revalidation, a new worktree checking out the branch,
   and expected-OID guarded delete failure. Each race preserves/escalates and
   never deletes fresh work.
9. **Reflog/reset surviving work is preserved.** A fixture where a worker makes
   local commits and resets branch HEAD back to the original grant start OID
   preserves and escalates instead of deleting the only recovery path. Quarantine
   refs are out of scope.
10. **Linux `pwsh` identity and quoting are tested.** CI-runnable Linux `pwsh`
   fixtures cover branch/worktree/grant identity normalization, slash/case
   variants, and path quoting. Windows-host PowerShell behavior is not covered
   by this repo's current `ubuntu-latest` CI matrix.
11. **GitHub Issue identity is bound before implementation handoff.** The draft
   may remain local with `GitHub Issue: TBD` during architect review, but the
   implementation handoff must first assign the issue number and bind audit/test
   fixtures to that issue identity.
12. **Rate-limit preservation is distinct.** Fixtures cover GitHub rate-limit
   failure during PR/remote freshness checks. The outcome preserves with a
   rate-limit-specific escalation reason and records the seam with drafts
   191-193 / #583-#585; it does not look identical to ordinary branch ambiguity.
13. **Grant-axis recurrence is not guessed.** The 2026-07-04 `head_oid_mismatch`
   incident is either reproduced in a branch-preexists fixture or tied to
   preserved deny-side grant evidence. If reproduction shows a genuinely new
   spawn-grant binding bug after branch cleanup is safe, implementation must
   stop and produce a new narrow draft instead of expanding this one.

## Upgrade-safety check

- No edits to AO core or vendored source.
- No weakening of #324: branch mutation is a recovery-specific capability under
  the blessed parent, not a generic autonomous git permission.
- Fail closed on ambiguous branch ownership, ambiguous liveness, ambiguous PR
  state, missing upstream, and missing evidence.
- Operator escalation is a terminal budget outcome with dedupe, not a repeating
  alert loop.

## Verification

- Focused worker recovery branch cleanup and preservation matrix tests for
  AC#1-AC#4.
- Linux `pwsh` path normalization and quoting tests for AC#10.
- Rate-limit-specific preservation/escalation fixture for AC#12.
- Regression tests for #522 worker recovery and #470/#472/#493/#511/#561/#567
  spawn-grant composition.
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/194-worker-recovery-branch-aware-cleanup.md`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command parked-root -DraftPath docs/issues_drafts/194-worker-recovery-branch-aware-cleanup.md`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/194-worker-recovery-branch-aware-cleanup.md`
- Before implementation PR handoff:
  - `pwsh -NoProfile -File scripts/verify.ps1`
  - `pwsh -NoProfile -File scripts/check-reusable.ps1`

## Decisions

### Recon notes

- `rg` found `reconcile_dead_worker` only in the recovery entrypoint, recovery
  library, docs model, and tests; no live reconciler invokes it.
- `rg` found no `git branch -D` or equivalent in the recovery entrypoint or
  libraries. `Worker-Recovery.ps1` reads branch containment only for artifact
  preservation.
- AO events for opk-128 show spawn on `feat/issue-583`, then manual kill and
  PTY loss. The consumed opk-128 grant records `expectedBranch:
  feat/issue-583`, expected commit `ef9aac20132a0e35bc7515f55a90f326e70f1145`,
  and consumed path `.../worktrees/opk-128`.
- Later events show a manual respawn attempt for issue 583 failing with
  `head_oid_mismatch` at `git worktree add -b feat/issue-583 ... refs/heads/main`.
  The matching deny-side grant was no longer present during recon, so this
  draft treats the grant-axis RCA as incomplete evidence.

### Options judged

1. **Do nothing and let respawn fail on branch collisions.** Rejected because it
   makes autonomous respawn fail on the first recurrence after worktree cleanup.
2. **Delete `feat/issue-N` by naming convention.** Rejected because the branch
   may be the only surviving copy of worker work.
3. **Extend #522 recovery with claim-bound branch classification and narrow
   local branch deletion.** Chosen. It is the cheapest sufficient path and keeps
   git mutation inside the existing recovery boundary.
4. **Create a new spawn-grant axis now.** Rejected for this draft: shipped
   #511/#561/#567 cover the known `worktree add` axes, and current evidence is
   incomplete for a new axis once branch-preexists is handled.

### GPT / review log

- GPT pass 1 (`STATE=completed_valid`, validation ok) found missing-upstream
  policy ambiguity, cleanup-vs-reuse ambiguity, stale/unknown PR risk, weak
  lineage precedence, missing branch revalidation, overloaded OID terms, and
  cross-platform coverage. Verdict: **accepted/partial**. The draft now uses
  deletion-only for disposable local branches, distinguishes original grant
  start OID from branch HEAD OID, permits missing-upstream deletion only when
  grant-start equality and confirmed-absent PR state hold, adds tri-state PR
  handling, strict lineage precedence, just-before-deletion revalidation, and
  cross-platform-shaped identity coverage later narrowed to Linux `pwsh`
  fixtures after architect review.
- GPT pass 2 (`STATE=completed_valid`, validation ok) found fresh remote/PR
  state not bound tightly enough to deletion, missing branch-deleted completion
  audit, over-trusting session/event fallback without consumed grant proof, and
  missing task eligibility revalidation at cleanup-to-respawn handoff. Verdict:
  **accepted/partial**. The draft now requires bounded fresh remote/PR
  observation, consumed-grant lineage for deletion, branch deletion intent and
  completion audits, crash-resume handling after deletion, and fresh task-owner
  eligibility checks before deletion/spawn.
- GPT pass 3 (`STATE=completed_valid`, validation ok) returned `BLOCKED` with
  a critical finding that deletion was not atomic against the expected branch
  HEAD, plus findings on reflog/reset-only surviving work, cache freshness
  bounds, and issue traceability. Verdict: **accepted/partial after cap**. The
  draft now requires expected-old-OID guarded deletion,
  reflog/dangling-work preservation, explicit destructive freshness bounds with
  audit evidence, and issue identity binding before implementation handoff.
  Post-GPT change not re-reviewed because the loop reached the 3-pass cap.

GPT loop: 3 passes; stopped because cap-3; last-pass accepted=4; final STATE=completed_valid VALIDATION=ok pass=2eccd1e1-f475-44da-a837-f41d69793956 sha=8a86c97e91b8895c5536f45b7519298686df575063db30371c1ba63ada9e1aa8

### Revision after architect review

- 2026-07-04 architect review: replaced unbuildable Windows-host fixture with
  CI-runnable Linux `pwsh` path normalization/quoting coverage after confirming
  every workflow uses `ubuntu-latest`.
- Simplified freshness to one rule: destructive decisions use an observation
  within an explicit persisted freshness bound, source recorded. Planner chooses
  the bound/default.
- Removed quarantine as an alternate behavior. Reflog/reset-away surviving work
  now preserves and escalates only.
- Added rate-limit-specific preservation/escalation reason and the seam with
  drafts 191-193 / #583-#585.
- Focused adversarial re-pass was performed without GPT per operator override
  (`gpt не нужен`); see
  `docs/issues_drafts/.review/194-worker-recovery-branch-aware-cleanup/revision-adversarial-pass.md`.
  No driver-error output was used as review evidence.