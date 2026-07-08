# Spawn worktree grant must authorize AO worktree branch operands

GitHub Issue: #561

## Prerequisite

- `docs/issues_drafts/104-orchestrator-spawn-git-process-boundary-deny.md`
  (GitHub #324, closed) shipped the autonomous process boundary that denies
  raw `ao spawn` and tree-mutating git unless a sanctioned pack grant path
  permits the exact mutation.
- `docs/issues_drafts/143-orchestrator-spawn-policy-toggles.md`
  (GitHub #458, closed) made `ao spawn` and `ao spawn --claim-pr` policy
  controlled through committed spawn policy.
- `docs/issues_drafts/148-autonomous-spawn-worktree-git-provenance.md`
  (GitHub #470, closed) added the spawn worktree grant that carries a
  policy-allowed spawn into the later internal `git worktree add`.
- `docs/issues_drafts/149-spawn-grant-worktree-name-binding.md`
  (GitHub #472, closed) repaired the AO session-id worktree basename axis.
- `docs/issues_drafts/157-spawn-grant-head-ref-oid-binding.md`
  (GitHub #493, closed by PR #497) repaired the base-ref / commit-OID axis and
  documented AO's production shape as `git worktree add -b <branch>
  <workspacePath> <baseRef>`.
- `docs/issues_drafts/162-spawn-grant-repository-identity-binding.md`
  (GitHub #511, closed by PR #517) repaired the linked-worktree versus
  canonical-checkout repository-identity axis through shared git repository
  identity. This draft must preserve that shipped contract, not reimplement it.
- `docs/issues_drafts/166-orchestrator-worker-recovery-sanctioned-path.md`
  (GitHub #522, open) owns stale owner/worktree cleanup and
  `claim_pr_resume_cleanup_required`. This draft does not broaden claim-pr
  cleanup eligibility.

Prior-art recon verdict: **new sibling binding axis, extending shipped
#470/#472/#493/#511 and composing with open #522**. Live `gh` searches for
`branch_mismatch expectedBranch spawn worktree grant` returned no open or closed
issue hits. Coworker bulk recon found the shipped policy, worktree-name,
head-ref/OID, and repository-identity axes, plus open #522 for claim-pr cleanup;
none owns branch-operand authorization for AO's `git worktree add -b` shape.
Knowledge-base search for `branch_mismatch`, `expectedBranch`, and
`claim_pr_resume_cleanup_required` returned no relevant wiki/synto note.

## Goal

Policy-allowed autonomous `ao spawn <issue>` and `ao spawn --claim-pr <PR>` must
authorize the production `git worktree add -b <workerBranch> <workspace>
<authorizedBaseRef>` command when the branch operand is the worker branch AO is
creating for that spawn lineage. The branch operand must become a bounded part
of the spawn grant contract instead of causing `branch_mismatch`, without
weakening path, repo, ref/OID, active-grant, single-use, or cleanup safety.

```behavior-kind
action-producing
```

## Binding surface

- Live reproduction on 2026-07-01 from
  `/home/che/.agent-orchestrator/projects/orchestrator-pack/worktrees/opk-orchestrator`
  with `AO_AUTONOMOUS_ORCHESTRATOR_SURFACE=1`: `Test-AutonomousSpawnDenied`
  for `ao spawn 315` minted a spawn-new grant, but the next guarded
  `git worktree add -b feat/issue-315 <worktree>/opk-315 refs/heads/main`
  denied with `branch_mismatch`.
- The denial occurs after the spawn policy layer: `allowSpawnNew=true` and the
  grant is minted. The blocker is the spawn-worktree grant consume check for the
  branch operand, not the high-level spawn policy.
- The grant currently authorizes worktree target, base ref/OID, repository
  identity, TTL, holder, and active grant lineage. It does not carry a
  production-grounded expected worker branch for ordinary issue spawn, so a
  real `-b <branch>` operand can deny even when every other bound axis is valid.
- The fix must treat `-b <workerBranch>` as an authorized output of the same
  spawn lineage, not as ambient permission to create or rename arbitrary
  branches from the orchestrator worktree.
- `claim-pr` stale-owner/worktree cleanup remains governed by #522. If
  `ao spawn --claim-pr <PR>` is denied before worktree creation with
  `claim_pr_resume_cleanup_required`, that is not a failure of this draft.
- The implementation must preserve #493's commit-OID race protection: branch
  authorization cannot make a mutable base ref sufficient by itself.
- The implementation must preserve #511's shipped repository-identity floor:
  branch authorization cannot let a grant minted for one repository mutate
  another, and must keep same-shared-repository linked worktrees bound by the
  shared git repository identity contract.

```contract-evidence
binding-id: orchestrator-pack:spawn-grant-branch-operand:live-branch-mismatch
binding-type: cli-behavior
binding: policy-allowed autonomous spawn grant can currently deny AO's production git worktree add branch operand with branch_mismatch
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:spawn-grant-branch-operand:authorized-worker-branch
binding-type: cli-behavior
binding: a production-shaped git worktree add -b worker branch is allowed only when it is bound to the active spawn grant lineage and the authorized worktree/base-ref/repository checks also pass
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)

binding-id: orchestrator-pack:spawn-grant-branch-operand:arbitrary-branch-deny
binding-type: cli-behavior
binding: branch operand authorization does not allow arbitrary branch creation, orchestrator-branch mutation, cross-repository mutation, stale/replayed grants, or base-ref/OID drift
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)
```

## Files in scope

- `scripts/**`
- `docs/**`
- `tests/**`
- `tests/external-output-references/**` only if the worker records scrubbed
  live or replay captures
- `.github/workflows/**` only if focused reusable verification wiring is needed

## Files out of scope

- `vendor/**`
- `packages/core/**`
- `.ao/**`
- Patching or vendoring Composio AO core.
- Reopening the #472 worktree basename axis, #493 head-ref/OID axis, or #511
  repository-identity axis except for regression assertions that they still
  compose with branch authorization.
- Broadening `claim-pr` cleanup eligibility, stale ownership cleanup, or worker
  recovery lifecycle; #522 owns that.
- Allowing raw mutating git from the autonomous orchestrator surface without an
  active spawn grant.
- Committing generated runtime state, local operator config, credentials, or
  live AO databases.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

Scope boundary note: this denylist is scoped to
`183-spawn-grant-branch-operand-binding`.

```allowed-roots
scripts/**
docs/**
tests/**
tests/external-output-references/**
.github/workflows/**
```

## Acceptance criteria

1. **Live-shaped failing case is captured before fixing.** A focused fixture or
   scrubbed capture records the current production-shaped denial: policy permits
   `ao spawn <issue>`, a spawn-worktree grant is minted, and guarded
   `git worktree add -b <workerBranch> <canonicalWorkerWorktree>
   <authorizedBaseRef>` denies with `branch_mismatch`.

```producer-emission
producer: orchestrator-pack
datum: spawn-grant-branch-operand
expected: live-branch-mismatch
proof-command: implementation-specific focused pre-fix capture or regression fixture
```

2. **Authorized worker branch passes under the active grant.** With
   `AO_AUTONOMOUS_ORCHESTRATOR_SURFACE=1` and an active spawn-worktree grant for
   the same spawn lineage, a production-shaped `git worktree add -b
   <workerBranch> <canonicalWorkerWorktree> <authorizedBaseRef>` is allowed when
   path, repository identity, worktree basename, base ref/OID, TTL, holder
   liveness, target nonexistence, and active grant id all match.

```producer-emission
producer: orchestrator-pack
datum: spawn-grant-branch-operand
expected: authorized-worker-branch
proof-command: implementation-specific focused spawn-worktree grant test matrix
```

3. **Branch authorization preserves the security floor.** Negative controls deny
   arbitrary branch names, branch names targeting the orchestrator branch,
   malformed branch operands, missing active grant id, expired or replayed grant,
   wrong worktree path, wrong repository identity, target-preexisting worktree,
   and base-ref/OID mismatch. Denials must happen before real git mutation.

```producer-emission
producer: orchestrator-pack
datum: spawn-grant-branch-operand
expected: arbitrary-branch-deny
proof-command: implementation-specific focused negative grant-boundary tests
```

4. **New-work and claim-pr worktree creation share the branch contract.**
   Ordinary `ao spawn <issue>` and the worktree-creation phase of
   `ao spawn --claim-pr <PR>` use the same branch-operand authorization contract.
   Claim-pr attempts that fail earlier with `claim_pr_resume_cleanup_required`
   remain a #522 cleanup result, not a branch-operand failure.

5. **Existing axes remain green.** Regression coverage proves #472
   worktree-name binding, #493 head-ref/OID binding, and #511 shared-repository
   identity binding still fail closed after branch authorization is added.

6. **Live closure proof.** Before closing the implementation issue, record a
   scrubbed live autonomous run or capture-backed replay showing a real
   policy-allowed `ao spawn <issue>` reaches the in-band worktree creation path
   without `branch_mismatch`. If no safe `--claim-pr` candidate exists, the
   closure evidence must explicitly state that `--claim-pr` was blocked by
   #522 cleanup preconditions rather than by branch authorization.

```positive-outcome
asserts: policy-allowed autonomous spawn authorizes AO's production git worktree add -b worker branch while arbitrary branch creation and mismatched grant axes still deny before real git mutation
input: realistic
provenance: capture-backed
```

## Upgrade-safety check

- No edits to `vendor/**`, `packages/core/**`, `.ao/**`, generated runtime
  state, secrets, credentials, or local operator config.
- The #324 autonomous boundary remains fail-closed: branch authorization is only
  available through the active spawn grant path.
- The fix does not depend on a hard-coded issue number, worker session id, or
  one local branch spelling; it covers the class of AO-created worker branches
  while denying unrelated branch operands.
- The planner may choose the implementation shape, but the observable contract
  must stay branch-lineage bound and compose with worktree-name, ref/OID, and
  #511 shared-repository identity checks.

## Verification

- Focused spawn-worktree grant tests for AC#1-AC#5.
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/183-spawn-grant-branch-operand-binding.md`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command parked-root -DraftPath docs/issues_drafts/183-spawn-grant-branch-operand-binding.md`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/183-spawn-grant-branch-operand-binding.md`
- `pwsh -NoProfile -File scripts/verify.ps1`
- `pwsh -NoProfile -File scripts/check-reusable.ps1`

## Decisions

### Prior art

The existing queue has already decomposed the autonomous spawn grant into
binding axes: #470 created the grant, #472 repaired worktree names, #493 repaired
base-ref/OID matching, #511 repaired repository identity, and #522 owns cleanup
plus claim-pr recovery. This draft adds the missing branch-operand axis observed
in a live gate probe. It does not rebuild policy, cleanup, or repository
identity.

### Critical mechanics

The branch operand is a tree/ref mutation, so it cannot be generally allowed
under the autonomous surface. It must be authorized only as part of the already
minted spawn worktree grant, after all other axes still prove that the operation
targets the worker worktree in the intended repository at the intended commit.

### Common practice

This is a capability-scoped command authorization problem: each mutable argv
field is treated as data bound to a narrow capability, not as an ambient right
granted to the process. The established pattern in this repo is to add one
explicit binding axis with positive and negative fixtures, preserving the prior
axes as regression checks.

### Options judged

1. **Extend the spawn-worktree grant with branch-operand authorization
   (chosen).** Cost: low-medium because it reuses #470's mint/consume path.
   Risk: acceptable with negative controls for arbitrary branches. Sufficiency:
   directly fixes the observed `branch_mismatch`.
2. **Allow all `git worktree add -b` under a policy-allowed spawn.** Cost: low,
   but risk high because it bypasses the branch/ref mutation boundary that #324
   exists to enforce. Rejected.
3. **Remove `-b` from AO's worktree command or patch AO core.** Cost and
   upgrade risk are high, and it violates the pack's no-core-patch posture.
   Rejected.
4. **Fold the issue into #522 cleanup.** Insufficient: #522 can make
   `--claim-pr` eligible, but it does not authorize AO's branch operand once
   worktree creation begins.

### Scenario enumeration

- Active grant, matching worker branch, matching path/repo/base ref: allow.
- Active grant, arbitrary branch or orchestrator branch: deny.
- Active grant, matching branch but wrong path/repo/base ref: deny via the
  existing axis.
- Missing, expired, replayed, or consumed grant: deny.
- `spawn --claim-pr` denied before worktree creation with
  `claim_pr_resume_cleanup_required`: out of scope, #522.
- Manual/operator surface without the autonomous marker: unchanged behavior.

