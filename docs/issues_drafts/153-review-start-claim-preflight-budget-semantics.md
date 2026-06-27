# Review-start claim hold budget must not charge mandatory launch preflight

GitHub Issue: #481

## Prerequisite

- `docs/issues_drafts/88-review-start-atomic-claim.md` (GitHub #267, shipped) and `docs/issues_drafts/100-review-start-claim-atomic-single-winner.md` (GitHub #308, shipped) - define the per-`(PR, head)` single-winner review-start claim. This draft reuses that claim; it must not weaken single-flight or reopen duplicate review starts.
- `docs/issues_drafts/103-llm-turn-review-start-claimed-gate.md` (GitHub #318, shipped) - extends the same claim gate to the autonomous LLM-orchestrator turn. This draft corrects the budget semantics on that claimed path and the sibling automated starters.
- `docs/issues_drafts/104-orchestrator-spawn-git-process-boundary-deny.md` (GitHub #324, shipped) - process-boundary deny remains the safety backstop for raw autonomous side effects; this draft does not add a bypass.
- `docs/issues_drafts/120-event-driven-review-trigger-on-ready-for-review-handoff.md` (GitHub #381, shipped) - establishes the threshold-below-real-latency lesson for review-start liveness; this draft applies that lesson to claim hold/launch budgets.
- `docs/issues_drafts/129-review-start-claim-liveness-reaper.md` (GitHub #417, shipped via PR #407) - owns claim lifecycle, liveness reaper, bounded hold, launch-pending, and visibility semantics. This draft is a follow-up correction: the current bounded hold can be consumed by the holder's own mandatory pre-launch work.
- `docs/issues_drafts/150-review-ready-seed-long-tick-liveness-heartbeat.md` (GitHub #473, open) and `docs/issues_drafts/151-review-ready-seed-pre-side-effect-revalidation.md` (GitHub #475, open) - adjacent long-latency seed liveness and TOCTOU revalidation work. They do not own shared hold-budget charging semantics for all claimed review-start surfaces.

**Prior-art verdict:** new follow-up, not a replacement claim system. Existing work already provides single-winner acquisition, LLM-turn adoption, liveness reaping, launch-pending intent, and pre-side-effect revalidation patterns. The uncovered gap is narrower: a fresh, live holder can self-expire before launch because the hold clock starts before slow but required acquire-to-launch work.

## Goal

The review-start claim hold budget must not be spent on the holder's own mandatory pre-launch preparation. Slow-but-healthy snapshot/revalidation/workspace-preflight work may defer or retry safely, but it must not starve automated review starts for a ready, uncovered head, and it must not weaken the existing single-winner and stale-holder recovery contracts.

```behavior-kind
action-producing
```

## Binding surface

- **Budget semantics:** hold budget bounds stale, idle, or superseded ownership; it must not make a fresh live holder fail before the first legitimate launch opportunity solely because the holder performed mandatory pre-launch preparation.
- **Single-winner and TOCTOU safety:** the final side-effect boundary still revalidates readiness, coverage, and claim ownership so competing starters cannot both invoke `ao review run` for the same `(PR, head)` and stale candidates cannot launch.
- **Dead-holder recovery:** any design that changes when acquisition happens or when hold age starts must preserve bounded recovery for a holder that dies before launch; removing the false expiry must not create an indefinite active claim.
- **Outcome and diagnostics clarity:** pre-launch hold expiry, launch-pending/visibility timeout, covered/claim-lost, and degraded/retry outcomes remain distinct, and operator-facing prose must not describe a fresh self-expiry as stale holds, too many in-flight reviews, or concurrency pressure.

Planner freedom is intentional: the implementation may reorder acquisition, rescope the hold clock, add liveness/progress evidence, or combine approaches. Conditional hardening for a chosen option belongs in implementation tests and PR review, not in this draft as mandatory proof for every possible design branch.

## Files in scope

- `scripts/**` - review-start claim lifecycle, automated starter behavior, diagnostics, and tests/fixtures.
- `docs/**` - lifecycle/runbook/migration notes and this draft.
- `tests/external-output-references/**` - redacted/generated samples if needed for representative `gh`/AO-shaped latency fixtures.

## Files out of scope

- `vendor/**`
- `packages/core/**`
- `.ao/**`
- `agent-orchestrator.yaml`
- Replacing the existing review-start claim store.
- Reworking reviewer execution or Codex review semantics after `ao review run` is accepted.
- Generic lifecycle hardening not required by this bug class, including clock-skew hardening, cross-surface API call budgeting, and legacy-record schema migration unless the chosen implementation changes those surfaces.
- Garbage-collecting old `.locks/**` directories, unless a fixture proves they directly affect claim acquisition for this bug class.

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
```

Scope boundary note: This denylist is scoped to `153-review-start-claim-preflight-budget-semantics`.

```allowed-roots
scripts/**
docs/**
tests/external-output-references/**
```

## Acceptance criteria

1. **Fresh slow preflight does not false-expire.** With a fresh claimed holder, no in-flight review run, and mandatory pre-launch snapshot/revalidation/workspace-preflight latency longer than the previous 15s hold budget but still inside the intended readiness envelope, the path must not terminate as `hold_budget_exceeded` solely because of that preflight latency. A ready, uncovered, same-head path with healthy evidence must either launch exactly once, become covered/claim-lost at the final boundary, or defer with structured retryable/degraded evidence that does not leave an ambiguous active claim.

```producer-emission
producer: orchestrator-pack
datum: review-start-claim-budget-semantics
expected: fresh-slow-preflight-not-hold-expired
proof-command: npm test -- review-start-claim-budget-semantics
```

2. **Single-winner final boundary is preserved.** If two automated surfaces race while pre-launch work is slow, at most one review run is started for the same `(PR, head)`. If readiness, head, coverage, or claim ownership changes before the final side effect, the stale candidate emits no review start and records the existing structured skip/claim-lost/covered reason.

```producer-emission
producer: orchestrator-pack
datum: review-start-claim-budget-semantics
expected: slow-preflight-single-winner-final-recheck
proof-command: npm test -- review-start-claim-budget-semantics
```

3. **Dead pre-launch holder remains recoverable.** If the holder dies during pre-launch work before a review run is invoked, the claim lifecycle reaches a non-active reclaim/retry/escalation outcome within the configured lifecycle envelope; the fix must not create an unbounded live-lock by removing or moving the old hold deadline.

```producer-emission
producer: orchestrator-pack
datum: review-start-claim-budget-semantics
expected: dead-prelaunch-holder-recovered
proof-command: npm test -- review-start-claim-budget-semantics
```

4. **Launch-pending remains a separate budget class.** Post-invoke run visibility failures remain classified under launch-pending/visibility semantics, not masked as pre-launch hold expiry. Fixtures cover both the PR #479-shaped `hold_budget_exceeded` class and the repeated `launch_pending_budget_exceeded` class from the 64-record histogram.

```producer-emission
producer: orchestrator-pack
datum: review-start-claim-budget-semantics
expected: hold-and-launch-pending-classes-distinct
proof-command: npm test -- review-start-claim-budget-semantics
```

5. **Diagnostics corrected.** A terminal outcome equivalent to the PR #479 record (fresh acquire/hold timestamps, `inFlightCount: 0`, pre-launch age just over the old hold budget, readiness envelope still open) is reported as fresh pre-launch budget exhaustion or its replacement outcome, not as concurrent-review pressure, stale prior holds, or too many in-flight reviews. The record includes enough phase timing or explicit unavailable markers to separate pre-launch from launch-pending/visibility.

```producer-emission
producer: orchestrator-pack
datum: review-start-claim-budget-semantics
expected: fresh-self-expiry-diagnostic
proof-command: npm test -- review-start-claim-budget-semantics
```

6. **Bare timeout bump is insufficient.** A regression fixture or static guard proves that merely increasing `holdBudgetMs` without correcting pre-launch charging, final-boundary safety, and launch-pending distinction does not satisfy this issue.

```producer-emission
producer: orchestrator-pack
datum: review-start-claim-budget-semantics
expected: constant-only-bump-insufficient
proof-command: npm test -- review-start-claim-budget-semantics
```

7. **Healthy ready head converges to launch.** For a same-head, ready, uncovered candidate with healthy evidence and latency within the readiness envelope, repeated slow preflight must converge to a legitimate launch attempt, covered state, or claim-lost state within a bounded attempt/time envelope. It may not defer forever under a new label. Terminal escalation without at least one legitimate launch attempt is allowed only when evidence is unavailable or unsafe, the envelope expires, another surface covers or wins, or an infrastructure failure is explicitly classified.

```producer-emission
producer: orchestrator-pack
datum: review-start-claim-budget-semantics
expected: healthy-ready-head-converges
proof-command: npm test -- review-start-claim-budget-semantics
```

```positive-outcome
asserts: when a current ready head has no covering run and the automated starter's mandatory pre-launch work is slow but healthy, exactly one review-start side effect proceeds or a structured retryable/degraded non-launch outcome is recorded without misclassifying the fresh holder as a stale/concurrent hold
input: realistic
```

### Scenario Matrix

| Scenario | Holder | Pre-launch latency | Run state | Expected outcome |
|---|---|---|---|---|
| Fresh fast path | alive | below old hold budget | none | exactly one launch or covered-at-final-boundary |
| Fresh slow preflight | alive | above old hold budget, envelope open | none | not `hold_budget_exceeded` solely from own preflight |
| Dead mid-preflight | dead/local | any | none | bounded reclaim/retry/escalation |
| Concurrent starter | alive x2 | any | none | one winner; loser claim-lost/covered/defer |
| Stale at final boundary | alive | any | head/readiness/coverage changed | no launch; structured stale/covered reason |
| Launch invoked, run invisible | launch-pending holder | post-invoke/visibility | none visible | launch-pending/visibility outcome, not pre-launch hold |
| Repeated healthy slow preflight | alive | repeated but envelope-valid | none | bounded launch attempt, covered, or claim-lost; no infinite defer |

## Upgrade-safety check

- No AO core or vendored package edits.
- Existing per-`(PR, head)` single-winner claim semantics remain authoritative.
- Existing launch-pending and post-run visibility protections are preserved or made stricter; they are not removed to avoid one timeout.
- No raw `.env`, auth, GitHub token, session transcript, or reviewer context is persisted in new diagnostics or fixtures.
- If the chosen implementation changes claim record schema or stores new fixture evidence, it must use backward-compatible interpretation and sanitized checked-in or generated fixtures, not live operator `~/.agent-orchestrator/**` state.
- Operator-facing restarts or environment changes, if any, are documented in migration notes; otherwise no operator adoption step is required.
- Script changes remain PowerShell 7+ compatible on Linux/WSL2 and do not assume Windows-only behavior unless the implementation documents a platform-specific reason and tests it.

## Verification

- `npm test -- review-start-claim-budget-semantics`
- Existing review-start claim lifecycle tests selected by the implementation.
- For script-level changes, run the claim-budget/lifecycle test path under the repo's supported PowerShell 7+ Linux/WSL2 environment; add Windows coverage if the implementation touches Windows-specific path/process handling.
- Ensure any new `review-start-claim-budget-semantics` regression target is included in the default CI/test gate or an explicitly mandatory PR check when implementation lands.
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/153-review-start-claim-preflight-budget-semantics.md`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/153-review-start-claim-preflight-budget-semantics.md`

## Evidence and design analysis

### Verification notes

- The live PR #479 terminal record at `~/.agent-orchestrator/projects/orchestrator-pack/review-start-claims/terminal/pr-479-943b6cefbc6071f785d99b0eaf745bd579644d85.json.hold_budget_exceeded.1782460699102.json` has `decisionSource=hold_budget`, `inFlightCount=0`, `acquiredAtUtc=2026-06-26T07:58:02.4816307Z`, `holdStartedAtUtc=2026-06-26T07:58:02.4816934Z`, `terminalAtUtc=2026-06-26T07:58:19.1010510Z`, hold `ageMs=16449`, hold `budgetMs=15000`, and readiness envelope `budgetMs=30000`, `remainingMs=13551`, `reason=within_envelope`. That confirms a fresh holder self-expired before launch; the observed record does not support concurrent review pressure or a stale prior hold.
- Local terminal histogram on 64 records: `run_started=23`, `hold_budget_exceeded=14`, `launch_pending_budget_exceeded=11`, `run_not_visible_fenced=7`, `recovered_orphan_liveness=6`, `released_for_retry=2`, `released_after_run_terminalized=1`. Budget failures cluster by PR/head (`pr-460` hold x8, `pr-469` launch-pending x4, `pr-471` launch-pending x5, plus `pr-463`, `pr-476`, `pr-479`), so this is a recurrence class.
- Current source ordering confirms acquire-before-preflight-before-launch-gate on the observed and sibling surfaces: orchestrator-turn acquires at `scripts/lib/Invoke-OrchestratorClaimedReviewRun.ps1:132`, then re-snapshots/rechecks at `:143-149`, runs reviewer workspace preflight at `:165`, and calls the launch gate at `:172`; reconcile acquires at `scripts/review-trigger-reconcile.ps1:456`, rechecks at `:471-479`, preflights at `:495`, and gates at `:501`; wake/listener acquires at `scripts/lib/Invoke-ReviewWakeTrigger.ps1:313`, re-snapshots/rechecks at `:369-421`, preflights at `:465`, and gates at `:471`; re-eval acquires at `scripts/lib/Invoke-ReviewTriggerReeval.ps1:58`, re-snapshots/rechecks at `:85-107`, preflights at `:153`, and gates at `:160`.
- The shared lifecycle gate checks hold budget before launch-pending: `scripts/lib/Review-StartClaimLifecycle.ps1:108-132`; `Test-ReviewStartClaimHoldBudgetExceeded` computes age from `holdStartedAtUtc` or `acquiredAtUtc` and compares it to `min(config.holdBudgetMs, envelope.budgetMs)` at `scripts/lib/Review-StartClaimLifecycle.ps1:439-460`. Defaults are `readinessEnvelopeMs=30000`, `holdBudgetMs=15000`, `launchPendingBudgetMs=15000`, and `visibilityBudgetMs=15000` in `docs/review-start-claim-lifecycle.mjs:17-20`, resolved at `:69-106`.
- I could not precisely allocate the 16.449s in PR #479 between the fresh GitHub/AO snapshot and reviewer workspace preflight from the terminal record alone. The contract therefore treats both as mandatory pre-launch work and requires diagnostics if the implementation can observe the source.
- A stale `.locks/pr-338-.../owner.json` directory was present but was not shown to block this incident; lock garbage collection is kept out of scope unless a worker proves it contributes to this failure.
- Live `gh issue list` / `gh pr list` prior-art queries failed on 2026-06-26 with `GraphQL: API rate limit already exceeded for user ID 85295154`; prior art was therefore based on local `docs/issue_queue_index.md`, issue drafts, declarations, and a `coworker ask` corpus summary.

### 5 Whys

1. Why did PR #479 not get an orchestrator-turn review? The fresh claim was terminalized as `hold_budget_exceeded` before `ao review run`.
2. Why did the fresh claim exceed hold budget? The hold timer started at acquire, before mandatory fresh snapshot/recheck and reviewer workspace preflight.
3. Why did that matter? The default hold budget is 15s while the readiness envelope is 30s; the observed acquire-to-gate latency was 16.449s.
4. Why is this recurring? Multiple automated starters use the same acquire-before-preflight-before-launch-gate pattern, and GitHub/AO reads in this pack frequently take seconds to tens of seconds.
5. Why did the operator-facing diagnosis point to the wrong cause? The terminal outcome name and prose conflate fresh self-expiry with stale/concurrent hold pressure instead of inspecting in-flight count, acquire/hold delta, and launch phase.

### Recurrence diagnostic

**Recurrence (recurrence-diagnostic).** This is a recurrence of #417's bounded-hold intent: claim lifecycle work added a 15s hold budget and launch-pending/visibility budgets so active claims would not behave as unbounded coarse locks. The prior acceptance shape can still pass for stale/dead holder reclaim and launch-pending visibility while the bug reproduces for a different equivalence cell: a fresh live holder doing mandatory acquire-to-launch preflight ages past `holdBudgetMs` before its first launch opportunity. `pass + reproduce` therefore points at the spec/fixture boundary, not another one-off PR #479 patch: the prior lifecycle closed stale/orphan and post-run visibility cells but under-specified fresh live pre-launch budget charging and diagnostic classification.

### Options considered

| Option | Cost | Risk | Sufficiency | Judgment |
|---|---|---|---|---|
| A. Acquire after snapshot/preflight, immediately before launch | Medium | Reopens a TOCTOU boundary unless final readiness/coverage/claim revalidation is airtight | Sufficient if paired with final-boundary revalidation | Viable; conditional pre-claim side-effect/API bounds belong to implementation tests if chosen |
| B. Rescope the hold clock to begin at launch-gate/launch-pending boundary | Medium | A live but wedged preflight needs separate liveness/progress/degraded handling | Sufficient if dead/prelaunch holders still recover within envelope | Viable; may be safer than moving acquisition when preflight needs claim-bound authority |
| C. Liveness/progress-based hold rather than fixed wall-clock age | Higher | More state and PID/progress correctness burden | Sufficient and robust for variable gh latency | Good complement, but likely heavier as the primary first fix |
| D. Barely raise `holdBudgetMs` | Low | Treats the symptom; future gh latency can exceed the new number and launch-pending remains ambiguous | Insufficient alone | Reject as standalone; acceptable only as a temporary operator override with diagnostics |

**Chosen contract:** require the cheapest sufficient executor to make pre-launch budget charging semantically correct while preserving final-boundary revalidation, dead-holder recovery, and launch-pending distinction. The planner may choose A, B, C, or a hybrid after inspecting current tests; a bare constant bump cannot satisfy the acceptance criteria.

### GPT adversarial loop log

- Initial GPT loop overgrew the draft: 5 browser invocations including one invalid hash-mismatch; each valid pass produced more accepted findings, and the draft inflated to 23 ACs / 23 bindings. Architect review rejected that as a decomposition/planner-freedom failure.
- Scope correction applied: retained the high-value early findings that protect the core concurrency contract, collapsed duplicate and conditional findings into six acceptance criteria, moved generic hygiene to verification/upgrade-safety, and removed conditional A/B/C proof obligations from the spec body.

### Contract evidence

```contract-evidence
binding-id: orchestrator-pack:review-start-claim-budget-semantics:fresh-slow-preflight-not-hold-expired
binding-type: cli-behavior
binding: fresh claimed holder with slow mandatory pre-launch work is not denied solely by pre-launch hold age
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:review-start-claim-budget-semantics:slow-preflight-single-winner-final-recheck
binding-type: cli-behavior
binding: racing or stale automated starters under slow preflight produce at most one review start and stale candidates do not launch
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)

binding-id: orchestrator-pack:review-start-claim-budget-semantics:dead-prelaunch-holder-recovered
binding-type: cli-behavior
binding: dead holder during pre-launch work reaches bounded reclaim/retry/escalation instead of indefinite active ownership
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)

binding-id: orchestrator-pack:review-start-claim-budget-semantics:hold-and-launch-pending-classes-distinct
binding-type: cli-behavior
binding: hold-budget and launch-pending/visibility budget recurrence classes are separately classified and covered
producer: orchestrator-pack
evidence: NEW(produced-by AC#4)

binding-id: orchestrator-pack:review-start-claim-budget-semantics:fresh-self-expiry-diagnostic
binding-type: cli-behavior
binding: fresh self-expiry diagnostics do not claim concurrent review pressure or stale prior holds
producer: orchestrator-pack
evidence: NEW(produced-by AC#5)

binding-id: orchestrator-pack:review-start-claim-budget-semantics:constant-only-bump-insufficient
binding-type: cli-behavior
binding: constant-only holdBudgetMs bump without semantic correction does not satisfy this issue
producer: orchestrator-pack
evidence: NEW(produced-by AC#6)

binding-id: orchestrator-pack:review-start-claim-budget-semantics:healthy-ready-head-converges
binding-type: cli-behavior
binding: healthy ready uncovered same-head candidates within the readiness envelope cannot defer forever without launch attempt, covered state, or claim loss
producer: orchestrator-pack
evidence: NEW(produced-by AC#7)
```
