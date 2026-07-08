# Spawn worktree grant consume must commit after worker worktree creation

GitHub Issue: #567

## Prerequisite

- `docs/issues_drafts/104-orchestrator-spawn-git-process-boundary-deny.md`
  (GitHub #324, closed) shipped the autonomous process boundary that denies raw
  `ao spawn` and tree-mutating git unless a sanctioned pack path permits the
  exact mutation.
- `docs/issues_drafts/143-orchestrator-spawn-policy-toggles.md`
  (GitHub #458, closed) made autonomous `ao spawn` / `ao spawn --claim-pr`
  policy-controlled through committed spawn policy.
- `docs/issues_drafts/148-autonomous-spawn-worktree-git-provenance.md`
  (GitHub #470, closed) introduced the spawn-worktree grant, active grant id,
  TTL, single-use consume, holder, path, and repository checks.
- `docs/issues_drafts/149-spawn-grant-worktree-name-binding.md`
  (GitHub #472, closed) repaired the AO-allocated worker worktree basename axis
  so `opk-<session>` worker paths are authorized under an active grant.
- `docs/issues_drafts/157-spawn-grant-head-ref-oid-binding.md`
  (GitHub #493, closed) repaired base-ref / commit-OID matching.
- `docs/issues_drafts/162-spawn-grant-repository-identity-binding.md`
  (GitHub #511, closed) repaired shared git repository identity across linked
  worktrees.
- `docs/issues_drafts/183-spawn-grant-branch-operand-binding.md`
  (GitHub #561, closed) authorized AO's production `git worktree add -b`
  branch operand under the active grant.
- `docs/issues_drafts/166-orchestrator-worker-recovery-sanctioned-path.md`
  (GitHub #522, closed) owns sanctioned stale worktree / owner cleanup and
  worker recovery. This draft does not add a second cleanup path.

Prior-art recon verdict: **new sibling axis extending shipped spawn-grant work**.
Live GitHub REST search found #470/#472/#493/#511/#561/#522 and related PRs, but
no open issue covering `grant_already_consumed` after a consumed grant whose
worker worktree was not durably created by the autonomous orchestrator path.
Coworker bulk recon agreed: existing work covers provenance, name, ref/OID,
repository identity, branch operand, and cleanup/recovery; none owns the
consume-ordering / side-effect-finalization class.

## Goal

Autonomous `ao spawn` must not strand a spawn-worktree grant in terminal
`consumed` state before the AO-owned worker `git worktree add` has durably
created or registered the intended worker worktree. A retry or second internal
worktree-add attempt for the same spawn lineage must receive a precise,
recoverable or terminal classification instead of collapsing into misleading
`grant_already_consumed` / “gh auth” diagnostics.

```behavior-kind
action-producing
```

## Binding surface

- Live incident on 2026-07-01: the orchestrator-side `ao spawn 566` path passed
  GitHub reads when `GH_TOKEN` / `GITHUB_TOKEN` were provided, minted
  spawn-worktree grants for target `566`, and wrote `spawn_worktree_allow`
  audit rows. Repeated attempts then failed with
  `autonomous tree-mutating git denied by boundary gate: grant_already_consumed`.
- Operator/manual spawn of the same issue can later create a worker worktree;
  that later success is not closure evidence for the autonomous orchestrator
  path. The fix must distinguish autonomous-surface behavior from operator
  terminal behavior.
- The current grant record can be marked `consumed=true` with
  `consumedCanonicalPath` set before the operator can tell whether AO's
  downstream worker worktree creation completed, registered, failed, or retried.
  The grant state machine needs an observable finalization boundary tied to the
  real worktree creation outcome.
- The fix must preserve #470's single-use security property: replaying a grant
  from a different holder, different argv/path, different repository, expired
  TTL, or different base ref/OID still fails closed before real git mutation.
- The fix must preserve #472/#493/#511/#561. This issue is about
  consume/finalize ordering and retry classification, not basename, ref/OID,
  repository identity, or branch operand authorization.
- Diagnostics must classify the failure as spawn-worktree grant finalization /
  replay state, not GitHub CLI authentication, when GitHub reads already
  succeeded and the failing stderr is a grant-boundary reason.

```contract-evidence
binding-id: orchestrator-pack:spawn-grant-finalization:grant-consumed-before-durable-worker
binding-type: cli-behavior
binding: autonomous spawn can currently reach spawn_worktree_allow and then fail a retry with grant_already_consumed before durable autonomous worker creation is proven
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:spawn-grant-finalization:commit-after-real-add
binding-type: cli-behavior
binding: spawn grant terminal consumed state is committed only after the authorized worker worktree creation outcome is durably known
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)

binding-id: orchestrator-pack:spawn-grant-finalization:replay-deny-preserved
binding-type: cli-behavior
binding: replay, stale, wrong-holder, wrong-path, wrong-repo, wrong-ref, and arbitrary git attempts remain denied before real mutation
producer: orchestrator-pack
evidence: NEW(produced-by AC#4)
```

## Files in scope

- `scripts/**`
- `docs/**`
- `tests/**`
- `tests/external-output-references/**` only for scrubbed replay/live captures
- `.github/workflows/**` only if focused reusable verification wiring is needed

## Files out of scope

- `vendor/**`
- `packages/core/**`
- `.ao/**`
- Composio AO core patches or vendored source edits.
- Changing spawn policy toggles, GitHub read transport, or GitHub auth handling.
- Reopening #472, #493, #511, or #561 except for regression coverage.
- Broad worker cleanup / orphan recovery behavior owned by #522.
- Treating a successful manual/operator spawn as proof that the autonomous
  orchestrator spawn path is fixed.
- Committing live AO runtime state, local operator config, secrets, credentials,
  or machine-local grant files.

```denylist
vendor/**
packages/core/**
.ao/**
```

```allowed-roots
scripts/**
docs/**
tests/**
tests/external-output-references/**
.github/workflows/**
```

## Acceptance criteria

1. **Autonomous incident class is captured.** A focused fixture, replay, or
   scrubbed live capture records the autonomous-surface sequence: GitHub issue
   read succeeds, spawn policy allows, a spawn-worktree grant is minted,
   `spawn_worktree_allow` is emitted for the intended worker path, and a later
   same-lineage worktree-add attempt fails with `grant_already_consumed` while
   autonomous worker creation is not yet proven durable. The capture must not be
   satisfied by a later operator/manual spawn.

```producer-emission
producer: orchestrator-pack
datum: spawn-grant-finalization
expected: grant-consumed-before-durable-worker
proof-command: implementation-specific focused capture or regression fixture
```

2. **Terminal consume is committed after durable creation outcome.** On the
   successful autonomous path, the grant reaches terminal consumed state only
   after the authorized worker worktree creation outcome is durably known to the
   pack path: the intended canonical worktree exists or is registered according
   to the chosen implementation's observable contract. A preflight-only allow,
   validation-only allow, or failed downstream add must not be indistinguishable
   from a completed consume.

```producer-emission
producer: orchestrator-pack
datum: spawn-grant-finalization
expected: commit-after-real-add
proof-command: implementation-specific focused grant finalization test
```

3. **Retry classification is precise and bounded.** If the same spawn lineage
   retries after an allow but before durable creation, the result is one of:
   same-lineage idempotent completion, bounded same-lineage retry, or a terminal
   diagnostic that names the finalization failure class. It must not surface as
   generic GitHub auth failure, and it must not permit unbounded repeated
   worktree-add attempts.

4. **Security replay denials remain load-bearing.** Negative controls prove that
   expired grants, consumed grants from another lineage, wrong holder, wrong
   canonical worktree path, wrong repository identity, wrong base ref/OID,
   target-preexisting worktree, arbitrary branch operand, and raw mutating git
   still deny before real mutation.

```producer-emission
producer: orchestrator-pack
datum: spawn-grant-finalization
expected: replay-deny-preserved
proof-command: implementation-specific focused negative grant-boundary tests
```

5. **Manual/operator spawn is not closure evidence.** Verification includes a
   guard or documented capture rule proving that an operator-terminal `ao spawn`
   success for the same issue does not satisfy the autonomous orchestrator
   closure proof.

6. **Existing grant axes remain green.** Regression coverage for #472 worktree
   basename, #493 ref/OID, #511 repository identity, and #561 branch operand
   continues to pass with the new finalization semantics.

7. **Diagnostics separate auth from grant finalization.** When GitHub reads
   succeed and the failing stderr contains a spawn-worktree grant reason, the
   operator-visible diagnosis reports spawn-grant finalization/replay state, not
   “GitHub CLI is not authenticated”.

```positive-outcome
asserts: autonomous ao spawn that passes GitHub reads and spawn policy either durably creates/registers the intended worker worktree before terminal grant consume, or emits a precise bounded grant-finalization diagnostic without allowing replay or arbitrary git mutation
input: realistic
provenance: capture-backed
```

## Upgrade-safety check

- Pack-only change; no AO core or vendored source edits.
- No new secrets, credentials, token logging, or local runtime state committed.
- The autonomous boundary remains fail-closed: the fix narrows same-lineage
  finalization/retry only and does not allow ambient mutating git.
- The implementation must be robust to AO allocating worker session ids
  independently from issue numbers.
- The issue does not require changing `agent-orchestrator.yaml.example` unless
  the planner proves an operator-facing adoption step is unavoidable; if so, the
  PR must include operator-adoption notes.

## Verification

- Focused spawn-worktree grant finalization tests for AC#1-AC#7.
- Regression tests covering #472/#493/#511/#561 grant axes.
- No `parked-root-cause` block is present because this draft directly fixes the
  identified finalization-boundary root cause; the parked-root discipline check
  is expected to pass with no parked root.
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/185-spawn-grant-consume-after-worktree-add.md`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command parked-root -DraftPath docs/issues_drafts/185-spawn-grant-consume-after-worktree-add.md`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/185-spawn-grant-consume-after-worktree-add.md`
- `pwsh -NoProfile -File scripts/verify.ps1`
- `pwsh -NoProfile -File scripts/check-reusable.ps1`

## Decisions

### Prior Art

The existing spawn-grant sequence intentionally decomposes one problem into
binding axes: #470 created provenance and single-use grant consumption, #472
accepted AO session basenames, #493 bound mutable refs by OID, #511 repaired
repository identity, #561 authorized branch operands, and #522 owns cleanup and
worker recovery. This draft adds the missing lifecycle/finalization axis. It
must compose with those contracts instead of replacing them.

### 5 Whys

1. Why did the orchestrator report a broken spawn even after GitHub reads
   worked? Because the failure happened in the guarded worker worktree creation
   path, not the GitHub read path.
2. Why did the guarded path report `grant_already_consumed`? Because a
   spawn-worktree grant for the same target/path had already been transitioned
   to consumed.
3. Why was consumed not sufficient proof of success? Because consumed state is
   currently observable before the operator can prove the autonomous worker
   worktree was durably created or registered.
4. Why did retry make the symptom worse? Because single-use security treats the
   second attempt as replay, with no same-lineage finalization/recovery state.
5. Why is this a recurrence class? Because every future grant-bound
   `git worktree add` axis can repeat the same failure if terminal consume is
   not tied to durable side-effect completion.

Stop condition: the durable root is the grant state machine's finalization
boundary, not GitHub auth, worktree basename, ref/OID, repository identity, or
branch operand matching.

### Design Analysis

Critical mechanics: the grant is a capability for one dangerous side effect.
Validation, real git mutation, durable registration, retry, and terminal
diagnostics must be distinct states or equivalence classes. Security requires
that retry is same-lineage and bounded; reliability requires that a validation
allow is not recorded as completed work.

Common practice: capability systems normally distinguish reservation,
in-progress execution, committed success, and terminal failure. Idempotency keys
are scoped to the exact caller/target/operation; replay from a different caller
or operation still fails closed.

Architecture sketch:

```text
autonomous ao spawn
  -> spawn policy allow
  -> mint grant / reserve target
  -> guarded git worktree add
       -> validate all grant axes
       -> execute or observe exact same-lineage operation
       -> commit success only when worker worktree outcome is durable
       -> otherwise terminalize with precise failure or allow bounded retry
```

Options judged:

| Option | Cost | Risk | Sufficient |
|---|---:|---:|---|
| Treat `grant_already_consumed` as operator cleanup only | Low | Leaves autonomous spawn broken and misdiagnosed | No |
| Add same-lineage finalization / idempotency semantics to the grant path | Medium | Must preserve replay denials and avoid retry storms | Yes |
| Delegate all worktree creation to a separate broker service | High | More moving parts and adoption risk | More than needed |

Chosen direction: same-lineage finalization / idempotency semantics in the
pack-side spawn grant path, with tests for success, retry, terminal failure,
and replay-deny equivalence classes. The planner chooses the internal state
representation.