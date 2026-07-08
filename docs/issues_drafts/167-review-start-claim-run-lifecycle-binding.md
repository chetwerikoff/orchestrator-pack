# Review-start claim and AO run lifecycle binding

GitHub Issue: #521

## Prerequisite

- `docs/issues_drafts/88-review-start-claim-single-flight.md` (GitHub #267) - already introduced the per-`(PR, head)` review-start claim as the single-flight primitive for automated starters.
- `docs/issues_drafts/100-review-start-claim-atomic-single-winner.md` (GitHub #308) - already made claim acquisition atomic across concurrent automated starters and durable in the canonical claim store.
- `docs/issues_drafts/103-llm-turn-review-start-claimed-gate.md` (GitHub #318, closed 2026-06-16) - already required LLM-orchestrator review-start to pass the same claim and covered-head gate as script starters.
- `docs/issues_drafts/104-orchestrator-spawn-git-process-boundary-deny.md` (GitHub #324, closed 2026-06-17) - already denies autonomous spawn and tree-mutating git at the process boundary.
- `docs/issues_drafts/129-review-start-claim-liveness-reaper.md` (GitHub #417, closed 2026-06-24) - already added holder liveness, durable launch-pending intent, bounded hold, and `launch_pending_budget_exceeded`.
- `docs/issues_drafts/141-worktree-gate-claim-completion-ownership.md` (GitHub #454, closed 2026-06-25) - already made worktree gate and claimed review-run completion share one review-start claim terminalization owner.
- `docs/issues_drafts/133-autonomous-review-worktree-git-provenance.md` (GitHub #429, closed 2026-06-25) - already hardens claim-bound `git worktree add` provenance and correctly produces `no_live_claim` denial when no live claim exists.
- `docs/issues_drafts/160-gh-wrapper-rest-inventory-closure.md` (GitHub #501, closed 2026-06-28) - already closes the GitHub REST-wrapper coverage gap; this issue must not reframe the incident as a `gh` rate-limit or GraphQL transport problem.

**Prior-art verdict:** new tight sibling, not an amendment to #318/#324/#417/#454. Those issues are closed and each owns one side of the lifecycle. This issue extends the shipped contracts into one bidirectional invariant: a review-start claim and the AO review run it launches must remain reconciled from launch through completion or terminal denial. No open GitHub issue already covers both `missing_claim_for_review_run` and post-completion `launch_pending_budget_exceeded` as one class.

## Goal

Automated review-start surfaces must keep the review-start claim and the AO review run reconciled across the whole lifecycle: no AO review run is launched by a pack-owned automated path without a live claim lineage, any already-observed pack-owned no-claim run is diagnosed early, and no claim is terminalized as launch-pending once its matching AO run is visible, live, or terminal.

```behavior-kind
action-producing
```

## Binding surface

- The pack-owned launch path for automated review runs enforces a live review-start claim before invoking AO review launch. If an automated surface cannot prove that claim before launch, the pack-owned launch path fails closed. `missing_claim_for_review_run` is additive evidence for any already-created or observed no-claim run; it is not a substitute for launch prevention.
- The pack-owned lifecycle reconciler binds claim state and AO run state by repo/project namespace, PR, normalized full head SHA, and run id or reviewer session id when known. The binding must cover both directions:
  - claim -> run: a `launch_pending` claim transitions once the matching AO run is created, started, completed, or failed.
  - run -> claim: a pack-owned AO review run without a matching live or reconciled claim is diagnosed as `missing_claim_for_review_run` before the failure is discoverable only as a worktree-boundary `no_live_claim`.
- Manual operator-invoked AO review runs are outside this automated claim contract unless they carry pack-owned automated provenance. A manual AO run without a claim must not be falsely classified as `missing_claim_for_review_run`.
- The claim reaper must consult the matching AO run visibility before terminalizing a launch-pending claim as `launch_pending_budget_exceeded`. A visible live, completed, failed, or cancelled run is not launch-pending anymore.
- #429's worktree boundary remains a final safety net. This issue adds the earlier lifecycle diagnostic; it does not weaken the existing `no_live_claim` denial.
- The contract is observable state and diagnostics only. Planner chooses storage, watcher placement, retry shape, and internal function names.

### Design analysis

**5 Whys.**

Problem: PR #519 had both a run-without-claim failure on head `a7f0e4d190556d2a61082878e82c6e5164f6a31e` and a claim-with-completed-run terminalization on head `5a20a5d5c3d590ce6ec041e57a390ea63e39158a`.

Why #1: the launch side and the completion/reaper side can disagree about whether a review run is claim-owned.
Why #2: #318/#324 guard the raw autonomous boundary, #417 guards claim liveness and launch-pending budget, #454 guards completion ownership, and #429 guards worktree provenance, but no one invariant reconciles claim and AO run state in both directions.
Why #3: a raw or insufficiently instrumented launch path can create an AO review run before claim evidence exists, especially where Cursor guard coverage is opt-in or off.
Why #4: the reaper can classify a claim as stale launch-pending even after the AO run is visible and the reviewer has completed normally.
Why #5: lifecycle state is split across claim store, AO run metadata, reviewer evidence, and boundary denial, with no required early diagnostic for the inconsistent cells.

Root cause: review-start claim ownership is not a bidirectional lifecycle invariant; it is enforced as separate launch, reaper, completion, and worktree checks.

Corrective action: add one pack-owned lifecycle binding contract, with fixtures for both inconsistent cells and a keystone `missing_claim_for_review_run` diagnostic.

**State-class matrix.**

```text
Claim state        AO run state                         Expected outcome
live/acquired      not launched yet                      launch may proceed under existing claim gate
launch_pending     created/started/live                  claim reconciles to run_started or equivalent non-terminal active state
launch_pending     completed/failed/cancelled            claim reconciles to the run outcome, never launch_pending_budget_exceeded
terminal/stale     no matching run                       existing terminal outcome remains valid
none               no matching run                       no-op
none               pack-owned run created/live           missing_claim_for_review_run diagnostic; automated launch path fails closed
none               manual operator run without provenance no missing_claim_for_review_run false positive
none               worktree add attempted                #429 no_live_claim denial still fires as final boundary
terminal unrelated run for same PR other head            no cross-head reconciliation
terminal unrelated run for other repo/project            no cross-project reconciliation
```

**Options considered.**

1. Amend #318/#324 only. Low implementation surface, but insufficient: it covers the missing-claim launch cell and leaves the #417/#454 post-run terminalization recurrence alive.
2. Amend #417/#454 only. Low implementation surface, but insufficient: it fixes launch-pending reaper/completion disagreement and leaves raw or uninstrumented launch paths discoverable only at `git worktree add`.
3. New sibling over the lifecycle invariant. Cheapest sufficient executor with acceptable risk: it reuses shipped gates and asks for one reconciliation contract plus fixtures for the two recurrent cells.

## Files in scope

- `scripts/**`
- `docs/**`
- `tests/external-output-references/**`

## Files out of scope

- AO core package changes or vendored modifications
- Draft 166 and its issue body
- Reopening the #429 worktree-path hardening contract
- Reframing this recurrence as GitHub API rate-limit, GraphQL quota, or REST-wrapper inventory work
- Prescribing AO internal schema, package layout, function names, or storage filenames

```denylist
vendor/**
packages/core/**
.ao/**
docs/issues_drafts/166-*
```

```allowed-roots
scripts/**
docs/**
tests/external-output-references/**
```

## Acceptance criteria

1. **Automated launch requires live claim.** A pack-owned automated review launch on an uncovered PR/head fails closed before creating an AO review run unless a live review-start claim lineage exists for that repo/project namespace, PR, and normalized full head SHA.

```producer-emission
producer: orchestrator-pack
datum: review-start-claim-run-binding
expected: launch-without-live-claim-fails-before-run
proof-command: npm test -- review-start-claim-run-binding
```

2. **Already-observed no-claim run is diagnosed.** For an already-created or observed pack-owned automated review run with no matching live or reconciled claim, a fixture matching PR #519 head `a7f0e4d190556d2a61082878e82c6e5164f6a31e` emits `missing_claim_for_review_run` with repo/project namespace, PR, normalized full head SHA, run id or reviewer session id when known, surface, provenance, and detection point before the only durable signal is #429's `autonomous_mutating_git_denied` / `no_live_claim` worktree denial.

```producer-emission
producer: orchestrator-pack
datum: review-start-claim-run-binding
expected: observed-no-claim-run-diagnostic-before-worktree-denial
proof-command: npm test -- review-start-claim-run-binding
```

3. **Launch-pending reconciles visible AO run.** A fixture matching claim `pr-519-5a20a5d5c3d590ce6ec041e57a390ea63e39158a` with `launchPendingInvokedAtUtc=2026-06-28T15:44:30Z` and AO run `review-run-fa05d810-85e6-4f1c-8f06-57d50790c6b5` created at `2026-06-28T15:44:30.964Z` does not terminalize as `launch_pending_budget_exceeded`; it reconciles to a run-started/completed lineage.

```producer-emission
producer: orchestrator-pack
datum: review-start-claim-run-binding
expected: launch-pending-visible-run-not-budget-terminalized
proof-command: npm test -- review-start-claim-run-binding
```

4. **Completed reviewer beats launch-pending budget.** When the matching reviewer evidence shows normal completion (`exitCode=0`, `completionStatus=normal`) before the reaper decision time, the claim terminal outcome reflects the run completion or a reconciled post-run state, not `launch_pending_budget_exceeded`.

```producer-emission
producer: orchestrator-pack
datum: review-start-claim-run-binding
expected: completed-reviewer-not-launch-pending-budget
proof-command: npm test -- review-start-claim-run-binding
```

5. **Visible terminal run beats launch-pending budget.** When the matching AO run is visible as failed or cancelled before the reaper decision time, the claim terminal outcome reflects the visible run terminal state or a reconciled post-run state, not `launch_pending_budget_exceeded`.

```producer-emission
producer: orchestrator-pack
datum: review-start-claim-run-binding
expected: visible-terminal-run-not-launch-pending-budget
proof-command: npm test -- review-start-claim-run-binding
```

6. **#429 remains final safety net.** The existing boundary case with no live claim still denies tree-mutating git as `autonomous_mutating_git_denied` / `no_live_claim`. This issue only adds the earlier lifecycle diagnostic; it does not create a bypass credential.

```producer-emission
producer: orchestrator-pack
datum: review-start-claim-run-binding
expected: no-live-claim-worktree-denial-preserved
proof-command: npm test -- review-start-claim-run-binding
```

7. **Surface coverage includes Cursor guard-off recurrence.** A fixture or static guard covers the autonomous/Cursor review-start surface where the local guard is opt-in or off. Either the Cursor surface can no longer launch pack-owned automated review outside the claimed path, proven by static guard or inventory, or that residual raw path is explicitly documented as manual/operator-only out of scope and cannot carry pack-owned automated provenance. A pack-owned automated launch from that surface must fail closed without a live or reconciled claim. If a no-claim AO run is already created or observed, the same fixture also requires a deterministic `missing_claim_for_review_run` diagnostic tied to that surface before #429's worktree denial remains the only signal.

```producer-emission
producer: orchestrator-pack
datum: review-start-claim-run-binding
expected: cursor-guard-off-surface-covered
proof-command: npm test -- review-start-claim-run-binding
```

8. **Provenance and namespace isolation.** Manual operator AO review runs without pack-owned automated provenance do not emit `missing_claim_for_review_run`. A claim/run pair for the same PR but a different normalized full head SHA, or for another repo/project namespace, does not reconcile with the current claim/run.

```producer-emission
producer: orchestrator-pack
datum: review-start-claim-run-binding
expected: provenance-and-namespace-isolation
proof-command: npm test -- review-start-claim-run-binding
```

```positive-outcome
asserts: a visible AO review run created from a live launch-pending claim is reconciled into the claim lifecycle instead of being reaped as launch_pending_budget_exceeded
input: realistic
```

## Upgrade-safety check

- No edits under `vendor/**`, `packages/core/**`, or `.ao/**`.
- The pack launcher and boundary own the obligation; AO internals remain a producer the pack observes, not a core patch target.
- The worktree boundary remains fail-closed when claim evidence is missing.
- The issue is compatible with already-shipped #267/#308/#318/#417/#454/#429 contracts and extends rather than replaces them.

## Verification

- `npm test -- review-start-claim-run-binding`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/167-review-start-claim-run-lifecycle-binding.md`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/167-review-start-claim-run-lifecycle-binding.md`
- `pwsh -NoProfile -File scripts/verify.ps1`
- `pwsh -NoProfile -File scripts/check-reusable.ps1`

### Incident evidence used for authoring

- PR #519 head `a7f0e4d190556d2a61082878e82c6e5164f6a31e`: failed review runs `opk-rev-1092` and `opk-rev-1095` reached `git worktree add` and were denied by #429 with no live claim. Local claim-store search found no matching acquire/terminal record.
- PR #519 head `5a20a5d5c3d590ce6ec041e57a390ea63e39158a`: claim `review-trigger-reeval` entered launch-pending at `2026-06-28T15:44:30Z`; AO run `review-run-fa05d810-85e6-4f1c-8f06-57d50790c6b5` started immediately and reviewer `opk-rev-1072` completed normally at `2026-06-28T15:47:46Z`; reaper terminalized the claim as `launch_pending_budget_exceeded` at `2026-06-28T15:48:14Z`.
- The same evidence window did not show `gh` rate-limit or quota failure; current transport follow-up #501 is already closed and out of scope.

### Contract evidence

```contract-evidence
binding-id: orchestrator-pack:review-start-claim-run-binding:launch-without-live-claim-fails-before-run
binding-type: cli-behavior
binding: automated review launch without a live claim fails before creating an AO review run
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:review-start-claim-run-binding:observed-no-claim-run-diagnostic-before-worktree-denial
binding-type: cli-behavior
binding: already-observed pack-owned no-claim review run produces a lifecycle diagnostic before only worktree denial remains
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)

binding-id: orchestrator-pack:review-start-claim-run-binding:launch-pending-visible-run-not-budget-terminalized
binding-type: cli-behavior
binding: launch-pending claim with visible matching AO run is not terminalized as launch_pending_budget_exceeded
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)

binding-id: orchestrator-pack:review-start-claim-run-binding:completed-reviewer-not-launch-pending-budget
binding-type: cli-behavior
binding: normal reviewer completion before reaper decision prevents launch_pending_budget_exceeded terminalization
producer: orchestrator-pack
evidence: NEW(produced-by AC#4)

binding-id: orchestrator-pack:review-start-claim-run-binding:visible-terminal-run-not-launch-pending-budget
binding-type: cli-behavior
binding: visible failed or cancelled matching AO run prevents launch_pending_budget_exceeded terminalization
producer: orchestrator-pack
evidence: NEW(produced-by AC#5)

binding-id: orchestrator-pack:review-start-claim-run-binding:no-live-claim-worktree-denial-preserved
binding-type: cli-behavior
binding: no-live-claim worktree denial remains fail-closed
producer: orchestrator-pack
evidence: NEW(produced-by AC#6)

binding-id: orchestrator-pack:review-start-claim-run-binding:cursor-guard-off-surface-covered
binding-type: cli-behavior
binding: Cursor guard-off automated review-start surface fail-closes without claim and emits missing-claim diagnostic for already-observed no-claim runs
producer: orchestrator-pack
evidence: NEW(produced-by AC#7)

binding-id: orchestrator-pack:review-start-claim-run-binding:provenance-and-namespace-isolation
binding-type: cli-behavior
binding: manual operator runs without pack-owned provenance are not false positives and other heads/projects do not reconcile
producer: orchestrator-pack
evidence: NEW(produced-by AC#8)
```
