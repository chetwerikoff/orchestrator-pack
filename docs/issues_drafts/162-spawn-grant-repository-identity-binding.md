# Spawn worktree grant must bind repository identity across worktrees

GitHub Issue: #511

## Prerequisite

- `docs/issues_drafts/104-orchestrator-spawn-git-process-boundary-deny.md`
  (GitHub #324, closed) shipped the autonomous process boundary that denies
  tree-mutating git unless a sanctioned grant/provenance path allows it. This
  draft preserves that security floor: the grant still authorizes exactly one
  repository and must not become a cross-repo bypass.
- `docs/issues_drafts/148-autonomous-spawn-worktree-git-provenance.md`
  (GitHub #470, closed) added the spawn worktree grant that carries an allowed
  autonomous `ao spawn` into the later internal `git worktree add`.
- `docs/issues_drafts/149-spawn-grant-worktree-name-binding.md`
  (GitHub #472, closed) repaired the grant on the AO session worktree-name
  axis. This draft is a different axis: repository identity.
- `docs/issues_drafts/157-spawn-grant-head-ref-oid-binding.md`
  (GitHub #493, closed by PR #497) repaired the grant on the ref/OID axis. This
  draft must not reopen that work; it only requires ref/OID logic to remain
  scoped to the same repository identity.

Prior-art recon verdict: **new #470 sibling axis, not a duplicate of #472 or
#493**. Local queue/GitHub searches on 2026-06-28 found the shipped name and
OID binding drafts/issues, but no open draft for grant `repository_root`
identity across a main checkout and linked worktree.

Knowledge-base consult on 2026-06-28: `wiki` had no repo-specific note for this
spawn grant bug; `synto` returned no matching article/source segment. Generic
KB notes `Authorization.md` and `Security.md` reinforce that a capability must
remain bound to its authorized resource and fail closed on ambiguity, while
`Version control.md` supports versioned, reproducible evidence for the external
git behavior.

## Goal

Policy-allowed autonomous `ao spawn <issue>` and `ao spawn --claim-pr <PR>` must
consume the spawn worktree grant when the grant was minted from one worktree of
the pack repository and consumed from another worktree of that same git
repository. Repository identity for this grant is the shared git repository
identity, not the per-worktree checkout root. A grant minted for repo A must
still be denied when consumed against repo B.

```behavior-kind
action-producing
```

## Binding surface

- Confirmed root cause on 2026-06-28: the PowerShell mint/consume resolver
  calls `git rev-parse --show-toplevel`, so minting inside
  `/home/che/.agent-orchestrator/projects/orchestrator-pack/worktrees/opk-orchestrator`
  records that linked-worktree path as `sourceRepositoryRoot`, while consume
  from `/home/che/projects/orchestrator-pack` passes the canonical pack checkout
  root as the effective repository. The JS comparator trims trailing slashes and
  compares paths by equality, so it denies `repository_root_mismatch`.
- The same git probe showed the two paths have different `--show-toplevel`
  outputs but the same shared git common directory:
  `/home/che/projects/orchestrator-pack/.git` after resolving `.git` relative
  to the canonical checkout. That is the repository identity the grant should
  bind.
- The fix must make mint and consume consistent. Repairing only the mint
  resolver, only the consume effective-root resolver, or only the comparator is
  insufficient unless all grant repository checks evaluate the same shared-repo
  identity.
- The repository identity invariant is: two checkouts/worktrees satisfy the
  spawn-grant repository binding only when their `git rev-parse
  --git-common-dir` output, resolved relative to the cwd where git produced it
  and then realpathed/canonicalized, identifies the same shared git repository.
  A per-worktree top-level path is not the identity for this check.
- Other grant fields resolved from the transient mint cwd must be audited in the
  same implementation. Current ref/OID resolution uses `sourceRepositoryRoot`;
  if the repository binding changes to shared identity, the implementation must
  either resolve refs through a repo-owned worktree/root that is stable for that
  identity, or prove and test that shared `.git` refs make the existing ref/OID
  fields equivalent across linked worktrees. Worktrees with distinct checked-out
  branch state, detached HEAD, or per-worktree metadata must be covered
  explicitly rather than assumed away.

```contract-evidence
binding-id: orchestrator-pack:spawn-grant-repository-identity:worktree-main-equivalent
binding-type: cli-behavior
binding: a spawn worktree grant minted from an orchestrator linked worktree and consumed from the canonical pack root is accepted when both resolve to the same shared git repository identity
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:spawn-grant-repository-identity:cross-repo-deny
binding-type: cli-behavior
binding: a spawn worktree grant bound to repository A is denied when the consuming git worktree add is evaluated against repository B
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)

binding-id: orchestrator-pack:spawn-grant-repository-identity:real-resolver-output
binding-type: cli-behavior
binding: repository identity fixtures are grounded in real git resolver output for show-toplevel and git-common-dir instead of hand-shaped path strings
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)

binding-id: orchestrator-pack:spawn-grant-repository-identity:ambiguous-unresolved-fail-closed
binding-type: cli-behavior
binding: ambiguous, unresolvable, or mismatched repository identity fails closed before real git mutation unless real resolver output proves the same shared repository identity
producer: orchestrator-pack
evidence: NEW(produced-by AC#4)
```

## Files in scope

- `scripts/**`
- `docs/**`
- `tests/**`
- `.github/workflows/**` only if needed for reusable verification wiring

## Files out of scope

- `vendor/**`
- `packages/core/**`
- `.ao/**`
- Rewriting Composio AO core or vendoring a patched `agent-orchestrator`.
- Reopening the #472 worktree-name axis or #493/#497 head-ref/OID axis except
  for regression assertions that those bounds still run after repository
  identity succeeds.
- Live operator retry of `ao spawn` during spec authoring. Implementation may
  require live proof before closure, but this draft authoring task is static
  confirmation plus issue sync.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

Scope boundary note: this denylist is scoped to
`162-spawn-grant-repository-identity-binding`.

```allowed-roots
scripts/**
docs/**
tests/**
.github/workflows/**
```

## Acceptance criteria

1. **Same shared repo, different worktree roots are allowed.** A focused test or
   capture creates a real repository with a linked worktree, mints a spawn
   worktree grant from one worktree, consumes/evaluates it from the other, and
   no longer denies `repository_root_mismatch` when both resolve to the same
   shared git repository identity.

```producer-emission
producer: orchestrator-pack
datum: spawn-grant-repository-identity
expected: worktree-main-equivalent
proof-command: implementation-specific focused repository-identity grant test or capture replay
```

2. **Different repositories still deny.** A grant minted for repo A and consumed
   against repo B denies with `repository_root_mismatch` or an equivalent
   repository-identity denial before any tree mutation reaches real git.

```producer-emission
producer: orchestrator-pack
datum: spawn-grant-repository-identity
expected: cross-repo-deny
proof-command: implementation-specific focused repository-identity negative test
```

3. **Evidence uses real git resolver output.** Fixtures/golden captures include
   the actual `git rev-parse --show-toplevel` and `git rev-parse
   --git-common-dir` outputs used to establish the positive and negative cases;
   hand-shaped string-only roots are not sufficient.

```producer-emission
producer: orchestrator-pack
datum: spawn-grant-repository-identity
expected: real-resolver-output
proof-command: implementation-specific capture-manifest replay or focused fixture integrity test
```

4. **Ambiguous repository identity fails closed.** Any ambiguous,
   unresolvable, or mismatched repository identity fails closed before real git
   mutation unless real resolver output proves the same shared repository
   identity. Representative controls should use reachable AO/repo shapes such
   as stale/deleted linked worktree metadata or symlinked paths; other malformed
   resolver or nested-repository forms are examples, not mandatory fixture
   cells.

```producer-emission
producer: orchestrator-pack
datum: spawn-grant-repository-identity
expected: ambiguous-unresolved-fail-closed
proof-command: implementation-specific focused repository-identity ambiguity test
```

5. **Existing grant bounds still fire after repo identity passes.** Worktree
   name/session binding (#472), head-ref/OID binding (#493/#497), TTL,
   single-use consume, holder liveness, target-preexists, path-prefix escape,
   and active grant-id lineage remain tested and fail closed.
6. **Other cwd-bound grant fields are audited.** Ref/OID resolution,
   default-branch base ref resolution, claim-pr PR-head resolution, and any
   other grant field currently derived from the mint cwd are either folded into
   the shared-repository invariant or explicitly scoped out with a failing
   negative control showing no worktree-vs-main drift.
7. **Live closure proof.** Before the implementation issue is closed, scrubbed
   live autonomous runs from the orchestrator worktree show `ao spawn <issue>`
   and `ao spawn --claim-pr <PR>` minting and consuming the grant in-band,
   creating/reaching the worker worktree and starting or resuming the session
   without operator fallback from the pack root. If live `--claim-pr` cannot be
   safely exercised in the closure window, AC#6 must carry an explicit
   capture-backed audit explaining the scoped-out risk.

```positive-outcome
asserts: an autonomous spawn worktree grant minted from a linked orchestrator worktree is consumed from the canonical pack root when both checkouts share the same git common directory, while a grant consumed from a different repository is denied
input: realistic
provenance: capture-backed
```

## Upgrade-safety check

- No edits to `vendor/**`, `packages/core/**`, `.ao/**`, generated runtime state,
  secrets, credentials, or local machine config.
- The #324 boundary is not weakened: a grant remains a narrow capability for a
  single repository identity and cannot authorize another repository's worktree.
- The planner may choose the exact resolver/comparator shape, but the observable
  contract must be shared-repo identity, consistent across mint and consume,
  and fail-closed on ambiguity or resolver failure.
- Captures must be scrubbed before commit; remote URLs with embedded tokens,
  auth headers, cookies, `.env` values, and private data must not enter
  fixtures or issue text.

## Verification

- Focused repository-identity grant tests for linked-worktree allow,
  cross-repo deny, and the ambiguous/unresolved identity invariant in AC#4,
  using real git repositories/worktrees and real resolver output.
- Regression tests for #470 grant lifecycle, #472 worktree-name binding, and
  #493/#497 head-ref/OID binding.
- Capture-manifest replay or equivalent contract-evidence verification grounded
  in real resolver output.
- Draft discipline before sync:
  - `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/162-spawn-grant-repository-identity-binding.md`
  - `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command parked-root -DraftPath docs/issues_drafts/162-spawn-grant-repository-identity-binding.md`
    (expected PASS with no `parked-root-cause` block because this draft does
    not contain a parked RCA item)
  - `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/162-spawn-grant-repository-identity-binding.md`
- Before implementation PR handoff:
  - `pwsh -NoProfile -File scripts/verify.ps1`
  - `pwsh -NoProfile -File scripts/check-reusable.ps1`

## Decisions

### Confirmation report

1. `scripts/git-autonomous-guard.ps1` emits the #324 process-boundary denial
   message and exits 93 when `Test-AutonomousGitDenied` returns denied. A valid
   spawn worktree grant is therefore the sanctioned bypass for the internal
   `git worktree add`; without it, tree-mutating git remains denied.
2. `scripts/lib/Autonomous-SpawnWorktreeGate.ps1` resolves
   `sourceRepositoryRoot` through `git rev-parse --show-toplevel` at mint and
   resolves the effective repository through the same function at consume.
3. `docs/spawn-worktree-grant.mjs` consumes `grant.sourceRepositoryRoot` and
   `input.effectiveRepositoryRoot`, then calls `canonicalRepositoryRootsEqual`.
   That comparator trims slashes and compares path strings, case-insensitive
   only on Windows. It treats `/home/che/.../worktrees/opk-orchestrator` and
   `/home/che/projects/orchestrator-pack` as different.
4. Local git probe:
   - orchestrator worktree `--show-toplevel`:
     `/home/che/.agent-orchestrator/projects/orchestrator-pack/worktrees/opk-orchestrator`
   - orchestrator worktree `--git-common-dir`:
     `/home/che/projects/orchestrator-pack/.git`
   - canonical pack root `--show-toplevel`:
     `/home/che/projects/orchestrator-pack`
   - canonical pack root `--git-common-dir`: `.git` relative to the canonical
     pack root, resolving to `/home/che/projects/orchestrator-pack/.git`
5. Verdict: root cause confirmed. This is a false-deny on the
   `repository_root` axis caused by per-worktree top-level path equality, not a
   name-axis or OID-axis bug.

### Design analysis

1. Critical mechanics: the grant is a short-lived capability minted by the
   allowed spawn path and consumed by the git boundary. The repository check is
   the first coarse security bound before name, path, and ref checks.
2. Best practice: bind authorization to the resource identity actually being
   protected. For git worktrees, the protected repository identity is the shared
   git repository, while the working-tree root is an instance of that repository.
3. Architecture sketch:

```text
mint cwd worktree --real git resolver--> shared repo identity
        |                                  |
        v                                  v
grant.sourceRepositoryIdentity      consume effectiveRepositoryIdentity
        \                                  /
         \-- equality on shared identity --/
                       |
              existing grant checks continue
```

4. Options:
   - Keep `--show-toplevel` equality and require spawn from the canonical root:
     rejected because it preserves the autonomous-orchestrator false deny and
     encourages operator fallback.
   - Normalize only one side to the canonical pack root: rejected because it
     moves drift and remains path-policy-specific rather than repository
     identity-specific.
   - Compare shared git repository identity such as realpathed
     `--git-common-dir` consistently at mint and consume: accepted as cheapest
     sufficient. It matches the observed same-repo/different-worktree case and
     preserves cross-repo denial.
   - Remove repository-root binding and rely on path/worktree/ref checks:
     rejected as a #324 weakening; it would let lower-level checks carry a
     cross-repo authorization question they were not designed to answer.
5. Full-class enumeration: linked worktree vs main checkout must allow;
   trailing-slash/case-realpath variants must follow platform canonicalization;
   different clones of the same remote, unrelated repos, symlinked paths,
   stale/deleted worktrees, missing metadata, and malformed resolver output must
   deny or be explicitly classified by tests. Nested/submodule forms are not
   mandatory in this repo while no `.gitmodules` path exists; include them only
   if the implementation makes that shape reachable.

### Resolved design questions

- **Identity basis:** use shared git repository identity, not per-worktree
  `--show-toplevel`. The intended invariant is `--git-common-dir` resolved
  relative to the git command cwd and then realpathed/canonicalized, or an
  equivalent shared-repository identity.
- **Where enforced:** mint and consume must use the same invariant, and the
  comparator must compare that invariant. A one-sided fix is not acceptable.
- **#324 non-weakening:** same shared repo may pass; different repo must deny.
  Resolver failure or ambiguous identity fails closed.
- **Other cwd-bound fields:** implementation must audit all grant fields that
  depend on mint cwd. Ref/OID fields may be scoped out only if tests prove that
  shared `.git` identity makes them equivalent across the involved worktrees, or
  they are folded into the same stable repo-identity resolver.

### Adversarial review log

- Codex adversarial pass 1 returned `needs-attention`: repository-shape edge
  cases were only in design prose, so an implementation could close with a
  happy linked-worktree fixture plus simple cross-repo deny while missing
  submodule/nested, symlink, stale/deleted worktree, and malformed metadata
  cases. Verdict: **accepted**. The draft promoted those cells into AC#4 and a
  matching `contract-evidence` row.
- Cold adversarial retries after that accepted change both failed before
  returning findings (`stream disconnected before completion`). No additional
  Codex finding was available to evaluate before the normal draft review gate.
- Architect review pass 1 raised P2 asking for a `parked-root-cause` block
  because the Verification section lists the parked-root checker. Verdict:
  **rejected as checker-inaccurate, clarified anyway**. The local
  `parked-root` command is expected to pass with no block because this is not a
  parked-RCA draft; Verification now states that expected pass condition
  explicitly.
- Architect follow-up before implementation: AC#4 was narrowed from five
  mandatory fixture cells to one fail-closed ambiguity invariant, with
  stale/deleted worktree and symlinked path as representative reachable shapes.
  The draft also made `--git-common-dir` cwd-relative resolution explicit and
  extended live closure proof to `--claim-pr` or a capture-backed scoped-out
  audit.
