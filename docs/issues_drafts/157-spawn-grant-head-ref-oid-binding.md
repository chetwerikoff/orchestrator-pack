# Spawn worktree grant must bind head refs by git OID

GitHub Issue: #493

## Prerequisite

- `docs/issues_drafts/143-orchestrator-spawn-policy-toggles.md`
  (GitHub #458, closed) made autonomous `ao spawn` and
  `ao spawn --claim-pr` policy-controlled instead of globally denied.
- `docs/issues_drafts/148-autonomous-spawn-worktree-git-provenance.md`
  (GitHub #470, closed) added the spawn worktree grant that lets a
  policy-allowed AO spawn carry sanctioned provenance into the worker
  `git worktree add`.
- `docs/issues_drafts/149-spawn-grant-worktree-name-binding.md`
  (GitHub #472, closed) repaired the same grant on the worktree-name axis:
  AO allocates session worktree names after the pack mints the grant.
- `docs/issues_drafts/133-autonomous-review-worktree-git-provenance.md`
  (GitHub #429, closed) is the sibling review-worktree precedent and must not
  regress.
- Queue check on 2026-06-28: `gh issue view`/REST confirmed #470, #472, and
  #429 are closed; REST search for open issues containing this ref-axis class
  returned no hits; `docs/issue_queue_index.md` maps #470/#472/#429 to the
  shipped drafts above; local draft grep found no open draft mentioning
  `expectedHeadRef` or `head_ref_mismatch`.
- Knowledge-base consult on 2026-06-28: `wiki` had no specific spawn-grant note;
  `synto` returned no matching article/source segment. Generic KB notes
  `Version control.md` and `Commit stage.md` reinforce that the fix should be
  backed by versioned capture fixtures and fast regression checks, not a
  one-off manual observation.

Prior-art recon verdict: **extends shipped #470/#472 as a new binding axis of
the same spawn-worktree grant**. Do not reopen the old issues, and do not create
a new service; repair the grant's ref-commit comparison and fixtures.

## Goal

Policy-allowed autonomous `ao spawn <issue>` must authorize the worker
`git worktree add` when the argv commit/ref and the grant's expected head
identify the same git object, regardless of whether AO spells that commit as
`HEAD`, `origin/main`, `refs/heads/main`, a branch name, or an OID. For
`ao spawn --claim-pr <PR>`, this draft binds the current AO 0.9.x two-step
producer shape: AO creates the workspace from a default-branch base ref first,
then checks out the PR. The default-branch worktree-add grant must be OID-bound,
and post-checkout verification/audit must compare expected PR-head OID with
actual workspace HEAD. A durable pre-checkout worker-handoff blocker is not in
scope unless capture proves a real handoff window exists.

```behavior-kind
action-producing
```

## Binding surface

- `docs/spawn-worktree-grant.mjs` currently checks the parsed worktree-add commit
  before the action-specific branch: `expectedHead = grant.expectedHeadRef ??
  'HEAD'`; if `String(shape.commit) !== expectedHead`, consume denies
  `head_ref_mismatch`. Because this check precedes both `claim-pr-resume` and
  `spawn-new`, the bug applies to both actions.
- The same file's grant record defaults `expectedHeadRef` to `HEAD` when the
  caller does not provide one. The PowerShell runtime mirror in
  `scripts/lib/Autonomous-SpawnWorktreeGate.ps1` mints
  `expectedHeadRef = 'HEAD'`.
- The current focused tests are fixture-biased: the spawn-worktree gate fixtures
  pass `HEAD` as the worktree-add commit and do not cover `origin/main`,
  `refs/heads/main`, a branch name, or an OID spelling of the same commit.
- Installed AO source evidence, AO package `@aoagents/ao` 0.9.5: the workspace
  worktree plugin resolves a base ref, then calls
  `git worktree add -b <branch> <workspacePath> <baseRef>`. Its base-ref resolver
  prefers an existing `origin/<defaultBranch>` and otherwise falls back to
  `refs/heads/<defaultBranch>`. Therefore AO 0.9.x can emit a non-`HEAD`
  commit token for a normal spawn worktree even when that token resolves to the
  same commit as `HEAD`.
- Installed AO CLI/source evidence for `ao spawn --claim-pr`: the CLI first
  calls `sm.spawn({ projectId, issueId, agent, prompt })`; only after the session
  and workspace are created does it call `sm.claimPR(session.id, <PR>)`. The
  claim path then resolves the PR and runs `gh pr checkout` inside the already
  created workspace. This means the worker `git worktree add` for
  `--claim-pr` is not created from the PR head today; it is created from the
  same default-branch base-ref path as ordinary spawn, and only later switched
  to the PR branch.
- Root-cause confirmation: the ref-axis failure is a binding bug, not a path or
  basename bug. The gate compares ref spellings literally even though git's
  authorization question is object identity. For `claim-pr`, there is an
  additional mint-side contract gap: AO 0.9.x does not create the worktree from
  the PR head, so the grant must not use an implicit `HEAD` guess. It must
  record the default-branch start object used for worktree-add and separately
  verify the post-checkout PR head.
- TOCTOU boundary: resolving `origin/main` or another mutable ref and then
  letting `git worktree add` use that same mutable token can race with the ref
  advancing. The contract must normalize to the verified immutable commit OID
  at execution, or prove an equivalent atomic re-resolution immediately at the
  actual worktree add.
- Commit-object boundary: "same git object" means both sides peel to the same
  commit object. Annotated tags, tree/blob OIDs, ambiguous prefixes, and
  unpeelable objects must not produce inconsistent JS/PowerShell outcomes.
- Handoff-window hypothesis: a pack-owned durable checkout-pending state machine
  and worker-handoff blocker may be required if AO can start or resume the
  worker before post-checkout verification. This draft does not assume that
  window. AC#5 must capture checkout-completion timing relative to worker
  handoff; only that evidence can justify a follow-up state-machine draft.
- Evidence gap retained for implementation: this draft has source-level AO
  evidence, not a fresh live `ao spawn` capture, because the authoring task
  explicitly forbade spawning workers. Closing the issue requires a scrubbed
  capture manifest for both actions that records the actual argv token AO emits
  in the target environment.

```contract-evidence
binding-id: orchestrator-pack:spawn-worktree-head-ref-source-evidence-non-head-base-ref:observed
binding-type: unstructured
binding: AO 0.9.x workspace worktree creation can pass a resolved base ref such as origin/main or refs/heads/main to git worktree add instead of literal HEAD
producer: orchestrator-pack
evidence: NEW(produced-by AC#5)

binding-id: orchestrator-pack:spawn-worktree-head-ref-literal-compare-denies-equivalent-ref:observed
binding-type: unstructured
binding: spawn worktree grant consume denies when the worktree-add commit token string differs from expectedHeadRef even if both refs resolve to the same git object
producer: orchestrator-pack
evidence: NEW(produced-by AC#5)

binding-id: orchestrator-pack:spawn-worktree-head-ref-claim-pr-default-branch-before-pr-checkout:observed
binding-type: unstructured
binding: AO 0.9.x spawn --claim-pr creates the worker workspace before claimPR checks out the PR branch, so the worktree-add ref is not yet the PR head
producer: orchestrator-pack
evidence: NEW(produced-by AC#5)

binding-id: orchestrator-pack:spawn-worktree-head-ref-oid-equivalence-security-floor:preserved
binding-type: structured
binding: accepting alternate ref spellings is safe only when both the expected ref and argv ref peel to the same expected commit object in the already-bound source repository for the specific spawn action
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)

binding-id: orchestrator-pack:spawn-worktree-claim-pr-two-step-state:default-branch-oid-then-pr-head-verified
binding-type: structured
binding: under AO 0.9.x two-step claim-pr, default-branch worktree creation is OID-bound separately from post-checkout verification that workspace HEAD equals the expected PR-head object
producer: orchestrator-pack
evidence: NEW(produced-by AC#4)

binding-id: orchestrator-pack:spawn-worktree-head-ref-normalized-oid:closes-mutable-ref-race
binding-type: structured
binding: after ref authorization, mutable ref tokens are not used in a way that can advance between verification and git worktree add
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

```

## Files in scope

- `scripts/**`
- `docs/**`
- `tests/external-output-references/**`
- `.github/workflows/**` only if reusable verification wiring is required

## Files out of scope

- `vendor/**`
- `packages/core/**`
- `.ao/**`
- Vendoring or patching Composio AO core.
- Reworking #470 grant TTL, active grant id, holder/process identity, source
  repository binding, target lock, path escape, target-preexists, or basename
  binding except as needed to keep their regression matrix green.
- Reopening #429 review-worktree authorization except for shared regression
  checks that prove it is unchanged.
- Broadening `claim-pr` lifecycle policy, duplicate-owner safety, or cleanup
  semantics beyond the head-ref binding necessary for this grant.
- Implementing a durable checkout-pending state machine, worker handoff blocker,
  or crash/retry duplicate-owner lifecycle for `claim-pr`. Those are a
  follow-up only if AC#5 capture proves a real pre-checkout handoff window.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

Scope boundary note: this denylist is scoped to
`157-spawn-grant-head-ref-oid-binding`.

```allowed-roots
scripts/**
docs/**
tests/external-output-references/**
.github/workflows/**
```

## Acceptance criteria

1. **OID comparison replaces literal ref comparison.** The spawn-worktree grant
   consume path compares the expected head and the worktree-add commit by
   resolved commit identity, or by an explicitly justified equivalent set that
   is no weaker than commit-OID identity. Resolution must run against the
   already-bound source repository with an explicit repo path/git-dir, never an
   ambient cwd. Both sides must peel to a commit; unpeelable refs, tree/blob
   OIDs, and non-commit objects deny with distinct diagnostics. The comparison
   remains in the shared pre-action position so it covers both `spawn-new` and
   the worktree-creation phase of `claim-pr-resume`.

   After authorization, the actual worktree creation must use the verified full
   commit OID or prove an equivalent atomic re-resolution at execution time. A
   test must simulate a mutable branch or `origin/main` advancing after
   verification and prove the worktree is created from the authorized commit or
   the operation fails closed. The same fixture must prove that using the
   normalized full OID preserves AO's expected branch name, workspace HEAD,
   session metadata, and cleanup/resume identity for ordinary spawn and the
   claim-pr pre-checkout phase.

```producer-emission
producer: orchestrator-pack
datum: spawn-worktree-head-ref-comparison
expected: oid-equivalent
proof-command: implementation-specific focused spawn-worktree grant test matrix
```

```producer-emission
producer: orchestrator-pack
datum: spawn-worktree-head-ref-normalized-oid
expected: closes-mutable-ref-race
proof-command: implementation-specific mutable-ref race test for normalized full-OID worktree creation
```

2. **Security floor for ref equivalence is explicit.** A ref spelling is allowed
   only because it resolves to the expected object for this grant and action;
   arbitrary refs, stale refs, another PR head, or `main` where the expected
   object is a PR head deny. Ambiguous or unresolvable refs fail closed with an
   observable reason. Negative fixtures include resolving the same textual ref
   from the wrong repository/cwd and proving it does not authorize the grant.

3. **`spawn-new` matrix covers real AO base-ref spellings.** Fixtures include
   each spelling resolving to the same commit and expect allow:
   `HEAD`, `origin/main` when present, `refs/heads/main`, full OID, uniquely
   resolving short OID, branch name, and detached `HEAD` at that OID. Negative
   fixtures include at least one ref that resolves to a different commit, one
   unresolvable ref, and one ambiguous short-OID prefix; all deny.
   Tag and non-commit fixtures cover annotated tags that peel to a commit
   consistently, annotated tags that do not, and raw tree/blob OIDs.

```producer-emission
producer: orchestrator-pack
datum: spawn-worktree-head-ref-oid-equivalence-security-floor
expected: preserved
proof-command: implementation-specific wrong-repo stale-ref ambiguous-prefix and non-commit ref fixture matrix
```

4. **`claim-pr-resume` uses an explicit two-step AO 0.9.x contract.** For this
   issue, do not pretend the initial `git worktree add` is PR-head-bound unless
   upstream AO changes first.

   **AC4a - default-branch worktree-add binding:** worktree creation for
   `ao spawn --claim-pr <PR>` is authorized as default-branch workspace creation
   using the same resolved commit-OID rule as `spawn-new`. The minter must
   record the expected worktree-add start object explicitly for the
   `claim-pr-resume` action, not fall through to an implicit symbolic `HEAD`
   default. The contract must choose and document whether that expected object is
   a pinned default-branch OID minted before AO runs, or a "resolve-now at
   execution" token normalized to immutable OID before `git worktree add`.

   **AC4b - post-checkout verification and audit:** after AO performs the PR
   checkout, verification records expected PR-head OID, actual workspace HEAD
   OID, PR number, PR branch/ref spelling used, and outcome. A claim is
   successful only if the verified workspace HEAD equals the expected PR-head
   OID. Checkout failure, wrong PR head, another PR head, unresolved PR ref, or
   `main` after the checkout phase fails closed and emits an audit reason.

   **AC4c - follow-up only if capture proves the window:** durable
   checkout-pending state, worker-handoff execution blocking, and crash/retry or
   duplicate-owner lifecycle are out of scope for this draft unless AC#5 capture
   proves AO can hand execution to the worker before checkout verification. If
   such a window exists, create a follow-up draft whose prerequisite is that
   timing capture.

```producer-emission
producer: orchestrator-pack
datum: spawn-worktree-claim-pr-two-step-state
expected: default-branch-oid-then-pr-head-verified
proof-command: implementation-specific focused claim-pr default-branch OID binding plus post-checkout PR-head verification test or scrubbed capture replay
```

5. **Capture-backed fixtures replace fixture-only `HEAD`.** Tests include a
   capture manifest for both actions:
   - `ao spawn <issue>` records AO package version, argv emitted to the git
     gate, the concrete production gate/interceptor entrypoint that observed
     the argv, source repo OID for `HEAD`, and OID for the emitted base ref;
   - `ao spawn --claim-pr <PR>` records the worktree-add argv token, the
     default-branch start OID used for worktree creation, the PR head OID, and
     the post-claim checkout result.
   - for `claim-pr`, the capture records timing: when worker handoff or the
     first executable worker action becomes possible relative to checkout
     completion and PR-head verification. This timing evidence decides whether
     AC4c follow-up is needed; absence of a pre-checkout handoff window keeps
     the state-machine blocker out of scope.

   Static hand-written `HEAD` fixtures alone are insufficient for closure. The
   capture manifest must be replayed by a focused automated test or documented
   reusable verification command; a non-replayed transcript is not enough. The
   capture must prove the same production invocation path operators use reached
   the pack gate for both spawn-new and claim-pr, not merely that source code or
   a standalone shim predicts that argv.

```producer-emission
producer: orchestrator-pack
datum: spawn-worktree-head-ref-source-evidence-non-head-base-ref
expected: observed
proof-command: capture-manifest replay proving AO 0.9.x worktree add emits a non-HEAD base-ref token in at least one supported environment
```

```producer-emission
producer: orchestrator-pack
datum: spawn-worktree-head-ref-literal-compare-denies-equivalent-ref
expected: observed
proof-command: focused fixture proving the current literal comparison denies same-OID alternate spelling before the fix
```

```producer-emission
producer: orchestrator-pack
datum: spawn-worktree-head-ref-claim-pr-default-branch-before-pr-checkout
expected: observed
proof-command: capture-manifest replay proving AO 0.9.x claim-pr creates the worktree before PR checkout in the production path
```

```producer-emission
producer: orchestrator-pack
datum: spawn-worktree-head-ref-capture-manifest
expected: spawn-new-and-claim-pr-captured
proof-command: implementation-specific scrubbed live capture or deterministic git-shim capture that does not expose secrets
```

6. **Closed issues do not regress.** The #470 sanctioned provenance path, #472
   worktree basename binding, and #429 review-worktree authorization continue
   to pass their focused regression suites. The new ref equivalence must not
   weaken path escape, target-preexists, source-repository, active grant id,
   TTL, replay, holder/process, or review-claim checks.

7. **JS and PowerShell parity is required.** The JavaScript grant model and the
   PowerShell runtime mirror share the same allow/deny matrix, repo-bound
   resolution behavior, commit peeling/type validation, short-OID ambiguity
   handling, mutable-ref race handling, claim-pr default-branch worktree-add
   binding, post-checkout PR-head verification audit, and diagnostic reason
   classes.

8. **Operator-facing diagnostics and allow audit distinguish the class.** A same-OID alternate
   spelling that previously hit `head_ref_mismatch` now allows; a different-OID
   ref still denies with a reason that makes the expected object and actual ref
   resolution class debuggable without leaking credentials. Successful allow
   decisions persist a scrubbed audit tuple containing expected ref token,
   expected commit OID, actual argv token, actual commit OID, normalization mode,
   source repository identity, action, and grant id.

```positive-outcome
asserts: policy-allowed autonomous spawn accepts real production-gate-observed AO worktree-add ref spellings only after they peel to the expected commit object and cannot race through a mutable ref after verification, claim-pr worktree-add is bound to the default-branch start commit and post-checkout verification records expected PR-head versus actual workspace HEAD before treating the claim as successful, while different-object refs stale unresolved ambiguous or non-commit refs deny and #470 #472 #429 security bounds remain unchanged
input: realistic
provenance: capture-backed
```

## Upgrade-safety check

- No edits to `vendor/**`, `packages/core/**`, `.ao/**`, generated runtime state,
  secrets, tokens, or local credential files.
- The durable fix is implemented through the pack-owned grant/gate, tests, and
  capture fixtures; Composio AO remains an observed upstream producer, not a
  vendored dependency fork.
- The implementation may inspect AO source or capture AO argv, but must scrub
  command output before committing artifacts. Remote URLs with embedded tokens,
  auth headers, cookies, `.env` values, and private data must not enter fixtures
  or issue text.
- The ref-equivalence design is constrained by git object identity, not by
  accepting arbitrary human-readable ref names.

## Verification

- Run focused spawn-worktree grant tests covering the `spawn-new` and
  `claim-pr-resume` ref-form matrix, including JavaScript and PowerShell parity.
- Run mutable-ref TOCTOU, wrong-repo/cwd, short-OID ambiguity, tag peeling,
  non-commit object, claim-pr default-branch worktree-add binding, and
  post-checkout PR-head verification focused tests.
- Run normalized full-OID branch/session metadata fixtures for spawn-new and the
  claim-pr pre-checkout phase.
- Run the capture-manifest replay test or documented reusable verification
  command for both AO spawn actions, including claim-pr handoff-vs-checkout
  timing evidence.
- Run the #470/#472/#429 regression suites or their documented focused
  equivalents.
- Run draft discipline checks before publishing:
  - `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/157-spawn-grant-head-ref-oid-binding.md`
  - `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command parked-root -DraftPath docs/issues_drafts/157-spawn-grant-head-ref-oid-binding.md`
  - `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/157-spawn-grant-head-ref-oid-binding.md`
- Before final handoff of the implementation PR, run repository verification:
  - `pwsh -NoProfile -File scripts/verify.ps1`
  - `pwsh -NoProfile -File scripts/check-reusable.ps1`

## Decisions

### Prior Art

- Accepted: this is a new #470/#472 sibling axis, not a duplicate of the closed
  name-binding issue. The earlier fixes proved the grant shape is useful but
  fixture-biased.
- Accepted: source-level AO 0.9.5 evidence is enough to author the draft without
  violating the task's "do not spawn workers" constraint. It is not enough to
  close implementation; capture-backed fixtures remain mandatory.
- Accepted: cheapest sufficient comparison is resolved OID equality. A
  hand-maintained equivalence list of ref strings would keep missing producer
  spellings and would not answer short/full OID or detached-head cases.
- Accepted from GPT pass 1: AO 0.9.x `claim-pr` must be specified as a two-step
  default-branch workspace creation followed by verified PR-head checkout, not
  as an ambiguous either/or between default branch and PR-head worktree add.
- Accepted from GPT pass 1: OID resolution must be tied to the already-bound
  source repo, short OIDs must be unique, capture manifests must be replayed,
  and JavaScript/PowerShell parity must be acceptance criteria.
- Accepted manually from GPT pass 2 despite `STATE=invalid` hash mismatch:
  mutable-ref TOCTOU must be closed by normalized full OID or equivalent
  atomicity; ref resolution must peel and validate commit objects. Re-scoped
  after architect review: durable claim-pr pending state and crash/retry rules
  are not mandatory without timing capture.
- Partially accepted from GPT pass 3: capture manifests must name and prove the
  production gate/interceptor path; normalized full-OID creation must preserve AO
  branch and session metadata; successful allow paths need durable scrubbed audit
  tuples. Rejected after architect review: mandatory claim-pr handoff/execution
  blocker before evidence proves a pre-checkout handoff window.
- Architect review after GPT: accepted the strict ref-OID core, security floor,
  capture-backed fixtures, JS/PowerShell parity, and mutable-ref TOCTOU. Changed
  AC4c from mandatory scope to capture-gated follow-up because the draft had
  source evidence for AO's sequence but not evidence of an exploitable
  worker-handoff window before checkout completes.
- GPT loop stopped by operator command before pass 4 completed. Audit:
  3 completed/attempted passes plus one operator-aborted pass; stopped because
  operator requested ending GPT, not because of clean no-accepted-finding
  convergence; last valid pass accepted=4; final valid
  `STATE=completed_valid` `VALIDATION=ok`
  pass `807f930d-53b3-4725-9899-f2245d20b9bb`
  sha `dc3e6e85fec25636bb26599b00aac7206e5e76c093d6a69639f4bfebb6388116`.

### Design Analysis

1. Critical mechanics: the grant binds a later `git worktree add` to a preceding
   policy-allowed `ao spawn`. The current comparison binds a string spelling,
   but git executes against an object. The fix must compare object identity
   while preserving all other grant bounds.
2. Best practice: capture the external producer's actual argv and keep it under
   versioned fixtures. This matches the repo's contract-evidence discipline and
   the KB guidance that build/verification artifacts should be reproducible and
   version-controlled.
3. Architecture sketch: mint records the expected ref/object for the action;
   consume resolves both expected and actual refs in the trusted source repo;
   allow only if object IDs match and all existing grant bounds pass.
4. Options:
   - Literal string allowlist: cheapest superficially, rejected because it would
     add `refs/heads/main`/`origin/main` one spelling at a time and miss OIDs.
   - Resolved OID equality: accepted as cheapest sufficient. It matches git's
     semantics and handles branch names, full/short OIDs, and detached HEAD.
   - Equivalence set plus action-specific literals: rejected unless used only as
     an optimization over OID equality, because it is harder to audit and easier
     to drift from producer reality.
   - PR-head-at-worktree-add for `claim-pr`: rejected for this issue unless AO
     changes first, because installed AO 0.9.5 creates the workspace before
     `claimPR` checkout. The pack-owned contract here is default-branch
     worktree-add OID binding plus post-checkout PR-head verification/audit.
     Durable pending-state handoff blocking is follow-up-only if capture proves
     the handoff window.
5. Full-class enumeration: `spawn-new` covers default branch spellings and OID
   spellings for the same commit; `claim-pr-resume` covers default-branch
   worktree-add binding plus post-checkout PR-head verification;
   negative controls cover other commits, another PR head, stale refs,
   unresolved refs, and regressions of #470/#472/#429 security bounds.

### GPT Loop

- Pass 1 `STATE=completed_valid`, `VALIDATION=ok`,
  pass `074f5ac6-a1a9-4aff-bf25-1f4b2790dd64`,
  sha `ed139c5fec0818eb9c7045bdfbb3d647f06c3a48a222da2f0d53c69908633f20`.
  Accepted/partial: split `claim-pr` into the AO 0.9.x two-step contract; add
  post-checkout verification/audit fields; require repo-bound ref resolution;
  deny ambiguous short OIDs; require replayable capture manifests; require
  JavaScript/PowerShell parity. Rejected: assigning GitHub issue identity now,
  because this is explicitly a pre-sync local draft with `GitHub Issue: TBD`.
