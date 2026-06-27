# Autonomous spawn worktree git: policy allow must mint sanctioned provenance

GitHub Issue: #470

## Prerequisite

- `docs/issues_drafts/104-orchestrator-spawn-git-process-boundary-deny.md`
  (GitHub #324, closed) - shipped the autonomous-surface process boundary:
  `scripts/ao` gates protected AO verbs and `scripts/git` denies tree-mutating
  git when `AO_AUTONOMOUS_ORCHESTRATOR_SURFACE=1`.
- `docs/issues_drafts/143-orchestrator-spawn-policy-toggles.md`
  (GitHub #458, closed) - intentionally changed autonomous `ao spawn` and
  `ao spawn --claim-pr` from default-deny to policy-controlled allow through
  `docs/autonomous-spawn-policy.json`. This draft covers the unproven #458 AC#5
  internal-git case that materialized after merge.
- `docs/issues_drafts/133-autonomous-review-worktree-git-provenance.md`
  (GitHub #429, closed) - sibling precedent for the same
  `autonomous_mutating_git_denied` gate on AO-owned `git worktree add`, using
  live owned-claim binding plus target-path hardening for review worktrees.
- `docs/issues_drafts/107-orchestrator-restore-branch-sanitization.md`
  (GitHub #353, closed) - proved that PATH/login-shell placement can make the
  #324 boundary inert and moved durable enforcement to the bare-resolution layer.
  This draft must preserve that lesson: a fix that only works when the LLM turn
  cooperatively keeps the marker and pack `scripts/` on PATH is insufficient.
- `docs/issues_drafts/146-autonomous-surface-spawn-budget.md`
  (GitHub #462, closed) - incident trigger only. #462 reduced guarded-command
  spawn amplification; it does not authorize the worker worktree mutation that
  `ao spawn` needs.
- `docs/issues_drafts/147-gh-wrapper-hop-budget-failsafe-regression.md`
  (GitHub #467, open) - current known `verify.ps1` blocker for the `gh-wrapper`
  hop-budget fail-safe. Workers for this issue should not diagnose or absorb that
  unrelated red check; they should cite #467 if full verify remains red only for
  that failure.

Prior-art recon verdict: **new draft extending shipped #458 and #324, with #429
as the design sibling**. Do not reopen #429's review-worktree scope or duplicate
#353's bare-resolution install contract. This issue stitches the spawn-policy
allow decision to the git boundary decision for worker worktrees.

## Goal

When the autonomous spawn policy allows `ao spawn` or `ao spawn --claim-pr`, the
worker worktree creation required by that AO operation must have explicit,
bounded sanctioned provenance for its internal `git worktree add`. The same
change must keep genuinely unsanctioned tree-mutating git denied and must account
for the surface-unset / PATH-strip / absolute-binary escape class honestly: the
pack can remove the incentive for that bypass by making the in-band path work and
can audit/detect stripping, but a fully escaped absolute call to the real AO
binary is outside pack-shim enforcement and belongs to operator/runtime
containment.

```behavior-kind
action-producing
```

## Binding surface

- **Policy decision:** committed `docs/autonomous-spawn-policy.json` currently has
  `allowSpawnNew: true` and `allowClaimPrResume: true`; live
  `Test-AutonomousSpawnDenied` returns `denied=false`, reason
  `spawn_policy_allowed`, actions `spawn-new` and `claim-pr-resume`.
- **Git decision:** the git boundary still treats worker `git worktree add` as
  tree-mutating git. With a representative spawn parent chain, the provenance
  class is `none` and `Test-AutonomousGitDenied` returns
  `autonomous_mutating_git_denied`.
- **Review precedent boundary:** #429's claim-bound allow is scoped to review
  worktrees and review-start claims. A new-work `ao spawn` has no review claim;
  `--claim-pr` resume has spawn/session ownership constraints, not the #417
  review-start claim record.
- **Escape boundary:** unsetting `AO_AUTONOMOUS_ORCHESTRATOR_SURFACE` makes both
  gates report `manual_surface`; removing the pack `scripts/` path and `BASH_ENV`
  resolves bare `ao` outside the pack shim. The observed incident went further:
  it invoked the real AO binary by absolute path after stripping the surface and
  PATH. That fully escaped path cannot be denied by repo-owned shims because no
  pack code runs; this issue treats it as an operator/runtime containment
  residual. The pack-owned fix is working in-band sanctioned spawn provenance plus
  audit/detection for surface stripping.
- **Design analysis:** the binding scenario matrix is in **Decisions - Scenario
  matrix**.

```contract-evidence
binding-id: orchestrator-pack:autonomous-spawn-policy:allows-spawn-and-claim-pr
binding-type: cli-behavior
binding: autonomous surface policy allows spawn-new and claim-pr-resume when committed policy is true/true
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:spawn-worktree-git:denied-without-sanctioned-provenance
binding-type: cli-behavior
binding: worker worktree git worktree add is denied on autonomous surface when no sanctioned spawn provenance exists
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:autonomous-boundary-escape:surface-and-path-cooperative
binding-type: cli-behavior
binding: surface unset and PATH/BASH_ENV/absolute-binary stripping are not pack-enforceable once no shim runs, so the pack contract is in-band repair plus audit/detection
producer: orchestrator-pack
evidence: NEW(produced-by AC#5)
```

## Files in scope

- `scripts/**`
- `docs/**`
- `tests/**`
- `.github/workflows/**` only if needed for reusable verification wiring
- `agent-orchestrator.yaml.example` only for operator adoption text if required

## Files out of scope

- `vendor/**`
- `packages/core/**`
- `.ao/**`
- Rewriting Composio AO core or vendoring a patched `agent-orchestrator`.
- Re-specifying #429 review-start claims except where the implementation extends
  a shared helper/contract without changing the review behavior.
- Reopening #353's general bare-resolution installer unless this path needs a
  targeted regression assertion that the #353 enforcement remains active.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

Scope boundary note: This denylist is scoped to `148-autonomous-spawn-worktree-git-provenance`.

```allowed-roots
scripts/**
docs/**
tests/**
.github/workflows/**
agent-orchestrator.yaml.example
```

## Acceptance criteria

1. **Spawn-policy allow reaches a sanctioned worker-worktree mutation.** On an
   autonomous surface with committed policy true/true, a realistic `ao spawn
   <issue>` path that creates a worker worktree must no longer fail with
   `autonomous_mutating_git_denied` solely because the internal `git worktree add`
   lacks provenance. The proof must capture argv and provenance at the git gate.

```producer-emission
producer: orchestrator-pack
datum: autonomous-spawn-policy
expected: allows-spawn-and-claim-pr
proof-command: implementation-specific focused spawn-policy test or probe
```

```producer-emission
producer: orchestrator-pack
datum: spawn-worktree-git
expected: denied-without-sanctioned-provenance
proof-command: implementation-specific focused git-boundary provenance test or probe
```

2. **Claim-pr resume is mapped explicitly.** `ao spawn --claim-pr <PR>` must have
   a documented and tested outcome for its worker worktree creation: either the
   same sanctioned spawn provenance is used, or the command fails closed before
   raw mutating git. The old `--claim-pr` plus mutating-git collision class must
   remain denied or serialized.
3. **Unsanctioned mutating git still fails closed.** Any tree-mutating git on the
   autonomous surface outside the sanctioned spawn-worktree contract or an
   already shipped sanctioned path must still deny with exit 93.
4. **Target ownership is hardened.** Any allowed spawn worktree mutation must bind
   to the worker target it is supposed to create: project root, worker workspace
   root, issue/PR identity, branch/ref/head, and must-not-pre-exist checks are
   validated before allow. Path traversal, symlink escape, wrong project, wrong
   branch/head, stale session, and residual/colliding worktree cases fail closed.
5. **Escape path is scoped honestly and audited.** The implementation must not
   claim that pack shims can deny a fully escaped `env -u
   AO_AUTONOMOUS_ORCHESTRATOR_SURFACE ... /absolute/path/to/ao spawn ...` call
   after surface stripping. Instead, it must:
   - make the normal in-band autonomous `ao spawn` path work without needing that
     bypass;
   - preserve #353-style protection for bare-resolution/login-shell drift where a
     pack or installed guard still runs;
   - add or preserve an observable audit/detection signal for surface/PATH
     stripping attempts so the operator/runtime layer can treat them as a policy
     violation.

```producer-emission
producer: orchestrator-pack
datum: autonomous-boundary-escape
expected: surface-and-path-cooperative
proof-command: implementation-specific interposer/audit or bare-resolution boundary regression test
```

6. **Spawn-worktree capability has bounded lifetime.** Any minted/bound
   spawn-worktree grant must be single-use or otherwise bounded to the specific
   spawn attempt, with a short lifetime and release/expiry semantics. A failed,
   crashed, or interrupted spawn must not leave a reusable orphan grant that can
   authorize a later unrelated tree mutation.
7. **Mint/consume TOCTOU is closed for new-work spawn.** Concurrent autonomous
   `ao spawn <issue>` attempts for the same worker target must not both receive
   usable worktree authorization. The proof must show a single-winner claim,
   lock, consume-once grant, or equivalent serialization for new-work spawn, not
   only the existing `--claim-pr` collision path.
8. **Policy missing/malformed remains fail-closed.** Missing, unreadable,
   malformed, or non-boolean spawn policy still denies protected spawn actions
   before any worker worktree mutation can be attempted.
9. **Manual/operator path unaffected.** Without the autonomous surface, ordinary
   operator `ao spawn`, `ao spawn --claim-pr`, and manual git behavior remain
   transparent except for any already documented operator guard installed by #353.
10. **Review-worktree behavior is preserved.** Existing #429 review worktree
   positive outcomes and security regressions continue to pass. This issue must
   not loosen review worktree target-path or live-claim checks.

```positive-outcome
asserts: on an autonomous surface with committed spawn policy true/true, a realistic allowed ao spawn creates or reaches the worker worktree mutation through sanctioned spawn provenance while direct unsanctioned mutating git remains denied
input: realistic
```

## Upgrade-safety check

- No edits to `vendor/**`, `packages/core/**`, or vendored AO core.
- No secrets, credential files, or generated runtime state are added.
- The planner chooses the implementation mechanism, but the externally observable
  contract is fail-closed for unsanctioned autonomous mutating git and transparent
  for manual/operator use.
- Any operator adoption step must be documented and verifiable; machine-local
  files under `~/.local/bin` or `.ao/**` are not committed.

## Verification

- Reproduce the pre-fix deny with captured argv/provenance, then show the
  post-fix allowed spawn-worktree path and denied direct-mutation controls.
- Run focused spawn-policy, git-boundary, capability lifetime/concurrency,
  interposer/audit, and #429 review-worktree regression tests.
- Run draft discipline before sync:
  - `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/148-autonomous-spawn-worktree-git-provenance.md`
  - `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/148-autonomous-spawn-worktree-git-provenance.md`
- Run repository checks before the implementation PR is handed off:
  - `pwsh -NoProfile -File scripts/verify.ps1`
  - `pwsh -NoProfile -File scripts/check-reusable.ps1`
  If `verify.ps1` is red only for the known `gh-wrapper` hop-budget failure, cite
  #467/draft 147 rather than expanding this issue to diagnose that blocker.

## Decisions

### Confirmation report

1. **Deny path:** boundary-library probe on 2026-06-26 used argv
   `["worktree","add","/tmp/opk-spawn-probe","HEAD"]` and representative parent
   chain `node ... ao spawn 462` -> `bash ... scripts/ao spawn 462` ->
   `pwsh ... ao-autonomous-guard.ps1 spawn 462`; result:
   `provenanceClass=none`, `denied=true`,
   `reason=autonomous_mutating_git_denied`.
2. **Spawn policy allowed:** live policy JSON is version
   `autonomous-spawn-policy/v1` with `allowSpawnNew=true` and
   `allowClaimPrResume=true`. `Test-AutonomousSpawnDenied` returned allow audit
   lines for both `spawn 462` and `spawn --claim-pr 999991`.
3. **#429 does not cover spawn:** #429 binds review worktree add to #417
   review-start claims and canonical `code-reviews/workspaces` paths. New worker
   spawn has no review-start claim, and claim-pr resume uses spawn/session
   collision safety rather than the review-start claim store.
4. **Claim-pr variant:** existing focused tests confirm claim-pr collision and
   cleanup-required behavior, and also confirm that mutating git is still denied
   during the currently allowed claim-pr path. This draft requires the successor
   behavior to be explicit rather than left as downstream denial.
5. **Bypass:** with the autonomous surface unset, both gates classify as
   `manual_surface`. With `BASH_ENV` unset and pack `scripts/` removed from PATH,
   bare `ao` resolves to `/home/che/.local/bin/ao`, outside `scripts/ao`. The
   incident's stronger absolute-binary escape (`env -u ... /home/che/.local/bin/ao`)
   is not enforceable by pack shims after no pack code is in the process chain;
   it is accepted as an operator/runtime containment residual, with pack-owned
   mitigation limited to working in-band spawn plus audit/detection.

### Design analysis

**Critical mechanics:** `scripts/ao` invokes `Test-AutonomousSpawnDenied` before
delegating to real AO. Once allowed, the real AO spawn path creates a worker
workspace through git. That child git process is later intercepted by
`scripts/git` / `git-autonomous-guard.ps1`, which has no knowledge that the
parent `ao spawn` was policy-allowed. The review path solved the sibling problem
by binding allow to an already durable review-start claim; spawn needs an
equivalent spawn-owned intent, broker, or capability.

**Industry pattern:** privileged mutation behind an automation boundary should be
brokered by explicit capability: a policy decision creates a narrow, auditable
right to perform one downstream mutation; the mutating primitive consumes or
validates that right; missing or malformed capability fails closed. Deep parent
regex and cooperative env/PATH are useful diagnostics, not sufficient authority.

**Architecture sketch:**

```text
autonomous turn
  -> protected ao spawn argv
  -> spawn policy allow decision
  -> mint/bind sanctioned spawn-worktree intent
  -> AO internal git worktree add
  -> git boundary validates intent + target ownership
  -> allow only that worker worktree mutation; otherwise deny
```

**Options (cost / risk / sufficiency):**

| Option | Cost | Risk | Sufficiency |
|---|---:|---|---|
| Extend #429 live-claim allow directly to worker worktrees | Medium | Medium: new-work spawn has no review claim, so a fake review-like claim would blur ownership | Sufficient only if generalized into a spawn-owned claim, not by reusing review claims verbatim |
| Amend #458 spawn gate so an allowed spawn mints/binds one downstream git capability | Medium | Low/medium: closest to the policy decision; must handle cleanup on failed spawn, duplicates, and mint/consume TOCTOU | Cheapest sufficient if target/path ownership, single-use/bounded lifetime, and single-winner behavior are enforced |
| Add a broker that performs the worktree mutation on behalf of AO | High | Medium: strongest separation but more moving parts and adoption risk | Sufficient but likely more than this pack needs unless capability binding cannot be made robust |
| Only widen `SanctionedGitParentMaxDepth` or add `ao spawn` regex provenance | Low | High: repeats the fragile #429 failure mode and still leaves escaped absolute-binary calls outside pack enforcement | Insufficient |

**Chosen direction:** new draft, implemented as a #458/#324 extension. The
preferred cheapest sufficient design is a spawn-owned capability/intent minted
by the allowed spawn-policy path and consumed by the git boundary. If the worker
finds a shared mechanism from #429 that generalizes cleanly, it may reuse it, but
the authority must be spawn-owned, not review-claim-owned.

### Scenario matrix

| Scenario | Current behavior | Required behavior |
|---|---|---|
| `ao spawn <issue>` policy-allowed; internal worker `git worktree add` | Spawn gate allows, git gate denies `autonomous_mutating_git_denied` | Internal worker worktree mutation allowed only with validated spawn provenance |
| `ao spawn --claim-pr <PR>` policy-eligible and safe | Spawn gate allows, internal mutating git still denied today | Explicit allow or fail-closed before raw git; no duplicate owner/collision |
| Direct autonomous `git worktree add` | Denied | Denied |
| Review worktree under #429 claim | Allowed only with live claim/path checks | Preserved |
| Surface unset / PATH strip / absolute real AO | Gates bypassed or classify manual | Out of pack enforcement once no shim runs; normal in-band path works and stripping attempts are auditable/detectable for operator/runtime containment |
| Missing/malformed policy | Spawn denied | Spawn denied before any worktree mutation |
| Manual operator spawn | Transparent | Transparent |
| Residual/colliding worker worktree | Not covered by provenance | Fail closed or explicit cleanup-required refusal |
| Failed/crashed spawn after grant mint | Not covered by provenance | Grant released or expires; no orphan authorization remains |
| Concurrent new-work spawn for same target | Not covered by provenance | Single winner or equivalent serialization before git authorization |
