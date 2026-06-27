# Spawn worktree grant must bind AO session worktree names

GitHub Issue: #472

## Prerequisite

- `docs/issues_drafts/104-orchestrator-spawn-git-process-boundary-deny.md`
  (GitHub #324, closed) - shipped the autonomous process boundary that denies
  protected `ao` verbs and tree-mutating `git` unless a sanctioned provenance
  path exists. The load-bearing invariant remains branch scope: a sanctioned
  branch/checkout/worktree operation may touch only the new worker target,
  never the orchestrator checkout.
- `docs/issues_drafts/133-autonomous-review-worktree-git-provenance.md`
  (GitHub #429, closed) - review-worktree precedent for claim-bound,
  canonical-target git authorization. This draft must preserve its fail-closed
  path and not loosen review worktree authorization.
- `docs/issues_drafts/143-orchestrator-spawn-policy-toggles.md`
  (GitHub #458, closed) - made autonomous `ao spawn` and
  `ao spawn --claim-pr` policy-controlled. This draft only repairs the
  downstream worktree grant used after that policy allows the spawn.
- `docs/issues_drafts/147-gh-wrapper-hop-budget-failsafe-regression.md`
  (GitHub #467, open) - known unrelated `verify.ps1` blocker. Workers should
  cite #467/draft 147 when full verify is red only for the gh-wrapper
  hop-budget regression.
- `docs/issues_drafts/148-autonomous-spawn-worktree-git-provenance.md`
  (GitHub #470, closed by PR #471 at merge `2374ca4`) - added the spawn
  worktree grant for policy-allowed autonomous spawn. This draft is a narrow
  follow-up to the merged grant and must not re-own its lifecycle, target lock,
  TTL, single-use consume, path escape, source-repository binding, or
  cooperative escape-audit work.

Prior-art recon verdict: **rewrite existing #472, do not open a parallel
draft**. The previous multi-verb framing was wrong: AO's extra `fetch`,
`worktree prune`, and `worktree remove` paths are best-effort or outside the
blocking `worktree add` authorization boundary, and #470's parser already
accepts the legitimate `worktree add` shapes. The residual live blocker is the
worktree basename check.

Live evidence on merged `main` after #471: `ao spawn 373` minted a grant for
target `373` with authorized names `373` and `opk-373`, but AO tried to create
`.../worktrees/opk-27`; the consume denied with `worktree_name_mismatch`.

## Goal

Policy-allowed autonomous `ao spawn <issue>` and `ao spawn --claim-pr <PR>` must
authorize the worker worktree path AO actually creates, without requiring the
grant minted from spawn argv to know AO's later allocated session id. The fix
must change only the mint-unknowable name binding axis; path, project/source
repository, active grant, TTL, single-use, holder/process identity, target
lock/TOCTOU, and #324 branch-scope bounds remain fail-closed.

```behavior-kind
action-producing
```

## Binding surface

- Installed AO worktree evidence: in
  `/home/che/.npm-global/lib/node_modules/@aoagents/ao/node_modules/@aoagents/ao-plugin-workspace-worktree/dist/index.js`,
  the create path builds `projectWorktreeDir` from the configured worktree base
  and project id, then sets `worktreePath = join(projectWorktreeDir,
  cfg.sessionId)`. With the current project, the basename is AO's allocated
  session id, e.g. `opk-27`, not the issue or PR number.
- Mint-time evidence: the pack `scripts/ao` shim forwards only the operator's
  original argv into `scripts/ao-autonomous-guard.ps1`; the guard calls
  `Test-AutonomousSpawnDenied -Argv $args`, and
  `Mint-AutonomousSpawnWorktreeGrant -Argv $Argv` builds the grant from those
  argv before real AO allocates the worker session. There is no session id in
  the intercepted argv/env at this point for issue-keyed spawn.
- Merged grant evidence: `docs/spawn-worktree-grant.mjs` builds
  `authorizedWorktreeNames` from `issueTarget`, `opk-${issueTarget}`, and
  `pr-${prNumber}`. `evaluateSpawnWorktreeGrantConsume` derives the actual
  basename from the canonical worktree path and denies
  `worktree_name_mismatch` when it is not in that allowlist.
- Commit `9657fe3` correctly noticed that AO worktree basenames can be
  `opk-*`, but it still derived `opk-<issueNumber>` from the spawn target. That
  remains structurally wrong because AO uses a sequential session id such as
  `opk-27`.
- #470's other bounds stay load-bearing: canonical worktrees-prefix check
  (`path_escape`), target nonexistence (`target_preexists`), TTL 120 seconds
  (`grant_expired`), single-use consume (`grant_already_consumed` plus the
  per-grant consume mutex), source-repository equality
  (`repository_root_mismatch`), expected branch/head matching, holder liveness
  in the PowerShell consume path, active grant id via
  `AO_SPAWN_WORKTREE_GRANT_ID`, and target lock/TOCTOU protection for the spawn
  target.
- Grant-id lineage is the compensating security bound for relaxing the basename
  from an exact issue-derived name to an AO session-name pattern. The fix is
  safe only because the consuming `git worktree add` finds the already-minted
  grant through `AO_SPAWN_WORKTREE_GRANT_ID` carried by the same spawn lineage;
  the implementation must not make the basename pattern sufficient without that
  active grant-id binding.
- The implementation must not widen this to "any basename under worktrees".
  The accepted replacement must still prove that a matching active spawn grant
  is being consumed for this project/repository and that the basename is one AO
  can allocate for a worker session.

```contract-evidence
binding-id: orchestrator-pack:spawn-worktree-name-binding-ao-session-basename:allowed
binding-type: cli-behavior
binding: policy-allowed spawn worktree consume accepts AO's allocated session-id basename under the canonical project worktrees path
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:spawn-worktree-name-binding-security-floor:preserved
binding-type: cli-behavior
binding: name-axis relaxation preserves path escape, wrong project/source-repo, no active grant, expired/replayed grant, target preexists, holder/process, and #324 branch-scope denials
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)

```

## Files in scope

- `scripts/**`
- `docs/**`
- `tests/external-output-references/**` only if live or scrubbed captures are
  needed
- `.github/workflows/**` only if reusable verification wiring needs a focused
  check

## Files out of scope

- `vendor/**`
- `packages/core/**`
- `.ao/**`
- Rewriting Composio AO core or vendoring a patched `agent-orchestrator`.
- Reworking #470 lifecycle, TTL, single-use consume, cleanup, target locking,
  process identity, surface/PATH escape audit, or `new-work`/`claim-pr`
  classification.
- Widening authorization for AO's best-effort `fetch`, `worktree prune`, or
  `worktree remove` paths; the obsolete multi-verb acceptance criteria are
  intentionally removed.
- Claiming pack enforcement over absolute-path real-binary invocation when no
  pack shim or guard runs.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

Scope boundary note: This denylist is scoped to `149-spawn-grant-worktree-name-binding`.

```allowed-roots
scripts/**
docs/**
tests/external-output-references/**
.github/workflows/**
```

## Acceptance criteria

1. **AO session-id basename is authorized under an active spawn grant.** A
   focused test or capture proves that, when a grant minted for `ao spawn 373`
   or `ao spawn --claim-pr <PR>` is active, `git worktree add` targeting the
   canonical project worktrees directory with an AO session basename such as
   `opk-27` is allowed instead of denied with `worktree_name_mismatch`.

```producer-emission
producer: orchestrator-pack
datum: spawn-worktree-name-binding-ao-session-basename
expected: allowed
proof-command: implementation-specific focused spawn worktree grant test or scrubbed live capture
```

2. **Grant-id lineage and security floor remain fail-closed.** Tests prove the
   basename pattern is never sufficient by itself: consume still requires the
   active `AO_SPAWN_WORKTREE_GRANT_ID` lineage for the matching spawn, and still
   denies path escape, wrong project/source repository, missing active grant,
   expired grant, replayed grant, preexisting target, holder/process death,
   branch/head mismatch, and an operation scoped to the orchestrator checkout
   rather than the new worker target.

```producer-emission
producer: orchestrator-pack
datum: spawn-worktree-name-binding-security-floor
expected: preserved
proof-command: implementation-specific focused spawn worktree grant regression suite
```

3. **Mint-time exact issue-derived names are not required for success.** Tests
   include a mismatch where the spawn target is an issue/PR number but the
   consumed basename is a different AO session id. Success must depend on the
   replacement binding plus the existing grant bounds, not on adding the
   session id to `authorizedWorktreeNames` at mint time.

4. **Non-AO basenames still deny with drift-visible diagnostics.** Basenames
   outside the confirmed AO session naming scheme for this package, malformed
   path segments, and ambiguous names under the worktrees prefix deny unless the
   implementation has a stronger captured-session-id proof for that exact
   basename. A basename that is under the canonical worktrees prefix but does
   not match the expected AO session-name scheme must deny with a distinct
   diagnostic reason so an AO naming-scheme drift is observable instead of being
   collapsed into the ordinary `worktree_name_mismatch` class.

5. **Claim-pr and new-work both pass the same contract.** The implementation
   covers both `ao spawn <issue>` and `ao spawn --claim-pr <PR>` without a
   second lifecycle system and without weakening #458 policy checks.

6. **Live off-ramp proof is required.** Before the issue is closed, an operator
   or worker records a live autonomous run showing a real `ao spawn <issue>` and
   a real `ao spawn --claim-pr <PR>` reach the in-band `git worktree add`
   without `worktree_name_mismatch`. Static fixtures alone are insufficient
   because they missed the issue-derived `opk-N` mistake.

```positive-outcome
asserts: policy-allowed autonomous spawn creates the AO session-id worktree in-band while direct or mismatched autonomous mutating git remains denied
input: realistic
provenance: live spawn proof plus focused grant-boundary regression tests
```

## Upgrade-safety check

- No edits to `vendor/**`, `packages/core/**`, `.ao/**`, or Composio AO core.
- No generated runtime state, secrets, tokens, credentials, or local machine
  config are committed.
- Manual/operator surfaces remain unchanged except for documenting the live
  proof required to close the issue.
- The implementation may choose the internal representation for the replacement
  name binding, but the observable contract must stay fail-closed outside an
  active, single-use, short-lived spawn grant for this project/repository.

## Verification

- Focused draft checks before sync:
  - `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/149-spawn-grant-worktree-name-binding.md`
  - `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/149-spawn-grant-worktree-name-binding.md`
- Focused spawn worktree grant tests for the accepted name-binding axis and all
  preserved denial cases.
- Live autonomous `ao spawn <issue>` and `ao spawn --claim-pr <PR>` proof after
  implementation, recorded as a scrubbed transcript or capture.
- Regression tests for #470 spawn worktree grant behavior and #429 review
  worktree provenance.
- Repository checks before implementation handoff:
  - `pwsh -NoProfile -File scripts/verify.ps1`
  - `pwsh -NoProfile -File scripts/check-reusable.ps1`
  If `verify.ps1` is red only for the known gh-wrapper hop-budget regression,
  cite #467/draft 147 instead of absorbing that work here.

## Decisions

### Root cause

The grant binds the consumed worktree basename to values knowable at mint time
from `ao spawn` argv, but AO's actual worktree basename is derived from the
spawn-time session id allocated later by AO. For issue `373`, the grant can mint
`373` and `opk-373`; AO can create `opk-27`. An exact issue-derived basename
allowlist is therefore structurally unsatisfiable for ordinary issue-keyed
autonomous spawn.

### Options

1. **Canonical location + project/source-repo + active single-use grant + TTL +
   AO session-basename pattern.** Cost: low. Risk: low/medium, concentrated in
   confirming the exact AO session basename scheme (`opk-<digits>` for the
   installed package) and keeping malformed names fail-closed. Sufficiency:
   high, because the canonical path, source repo, holder, target lock, TTL, and
   single-use bounds already prevent cross-project or replay use.
2. **Bind to the AO-allocated session id captured after AO allocation and before
   `git worktree add`.** Cost: medium/high. Risk: integration fragility if AO
   exposes no stable hook or marker at that point. Sufficiency: highest if a
   reliable capture point exists, because it restores exact-name binding to the
   real id.
3. **Path + lineage proof.** Cost: medium. Risk: process-tree evidence can be
   platform-sensitive and may be harder to test than the current grant store.
   Sufficiency: possible if the `git worktree add` child is proven to descend
   from the grant-holding `ao spawn` process for this project within TTL.
4. **Continue enumerating exact names at mint.** Rejected. It is the bug: the
   exact AO session basename is not knowable from spawn argv.

Chosen axis for implementation planning: option 1, unless implementation
discovers a reliable AO session-id capture point before `git worktree add`.
Option 1 is the cheapest sufficient repair because it relaxes only the
mint-unknowable basename while preserving the rest of #470's fail-closed bounds.

### GPT pass

Not run by design. This is a localized binding-axis correction on the existing
#470 grant; the main judgment is whether the name-axis relaxation preserves the
security floor, and that is recorded above for architect review.
