# Review-start preflight transient rate-limit shield

GitHub Issue: #584

## Prerequisite

- `docs/issues_drafts/164-review-start-readiness-envelope-external-io-accounting.md`
  (GitHub #515, closed) pauses review-start readiness accounting around
  supervised external IO, but the current fresh-head preflight still needs a
  transient rate-limit shield.
- `docs/issues_drafts/165-review-start-envelope-cross-attempt-ledger-and-escalation.md`
  (GitHub #516, closed), `docs/issues_drafts/167-review-start-claim-run-lifecycle-binding.md`
  (GitHub #521, closed), GitHub #534, and `docs/issues_drafts/153-review-start-claim-preflight-budget-semantics.md`
  (GitHub #481, closed) establish claim/run lifecycle, ledger, and hold-budget
  semantics. This issue extends those semantics to the transient preflight
  branch without weakening them.
- `docs/issues_drafts/184-review-start-scoped-gh-json-stderr-isolation.md`
  (GitHub #566, closed) owns exit-0 structured output pollution. This issue owns
  nonzero transient 403/429/5xx classification and must keep #566 separate.
- `docs/issues_drafts/186-github-fleet-shared-pr-ci-snapshot.md`
  (GitHub #569, closed) deduplicates fleet reads but intentionally does not
  serve the review-start fresh-head preflight from cache.
- `docs/issues_drafts/192-github-fleet-shared-api-governor-phase2.md`
  is the sibling source-side governor. This shield must land independently if
  the governor slips.

Prior-art verdict: **new single-PR resilience shield**. No open issue found that
owns review-start scoped preflight retry/backoff. The #580 handoff matrix is the
starting matrix; this draft extends it with terminal-class and no-side-effect
guards.

## Goal

Make the review-start fresh-head preflight resilient to transient GitHub
rate-limit and transport failures: classify primary rate-limit 403,
secondary/abuse-limit 403, 429, and transient 5xx/network failures as bounded
retriable pauses, re-read the current head on every attempt, and leave no
review run or worktree side effects when the preflight cannot succeed inside
the budget.

```behavior-kind
action-producing
```

## Binding surface

- The review-start scoped preflight currently launches pack `scripts/gh pr view
  <PR> --json number,headRefOid,baseRefName,state` through `ProcessStartInfo`.
  Any nonzero child exit maps to terminal `gh_command_failed`; exit-0 parse
  pollution remains the #566 class.
- The preflight bypasses the fleet cache by design because it needs the freshest
  head SHA. The shield must preserve that freshness contract; it must not serve
  the preflight from a stale shared snapshot.
- Retriable classes are primary rate-limit 403 with reset/rate-limit headers,
  secondary/abuse-limit 403, 429, transient 5xx, timeout, and network transport
  failures. `Retry-After` or shared governor cooldown is honored when available;
  without headers, the shield uses conservative fixed backoff with jitter and
  records degraded classification.
- The shield's retry wall-clock budget must fit inside the seated claim/launch
  hold budget. If an implementation cannot prove that fit, the retry pause is
  accounted as supervised external IO under #515 before this shield can claim
  successful launch-budget behavior.
- Every retry performs a fresh current-head read. If the head drifts during the
  pause, the new head is evaluated; no stale review run is born.
- No review run record and no AO reviewer worktree may be created until the
  claim/launch grant is still seated and the fresh-head preflight succeeds.
  Exhaustion after bounded retries releases for retry, or the nearest existing
  transient outcome, with no worktree litter.
- That no-side-effect guard binds at the run-record and worktree creation
  points for every review-start surface: reconcile child, orchestrator turn, and
  manual invoke script. A surface-specific path cannot create a run/worktree by
  bypassing the traced reconcile lifecycle.
- Terminal classes stay terminal and visible: 401 bad credentials, missing
  native binary or adoption config, policy/boundary deny, PR not open,
  malformed argv, and parse pollution are not retried as transient rate limits.
- Shield refusal/retry records are directly PR/head-keyed. If an already-shipped
  Phase-0 producer owns those fields, this shield's emitted artifact must
  include a directly verifiable link to that PR number and head SHA. Today
  opaque-hash preflight records make #580-style attribution too expensive.

```contract-evidence
binding-id: orchestrator-pack:review-start-preflight-shield:transient-retry
binding-type: cli-behavior
binding: review-start preflight classifies primary/secondary 403, 429, and transient transport failures as bounded retriable pauses instead of terminal gh_command_failed
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:review-start-preflight-shield:fresh-head-each-retry
binding-type: cli-behavior
binding: each retry re-reads the current PR head before allowing review start
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)

binding-id: orchestrator-pack:review-start-preflight-shield:no-side-effects-before-success
binding-type: cli-behavior
binding: transient preflight exhaustion leaves no review run record and no reviewer worktree
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)
```

## Files in scope

- `scripts/**`
- `docs/**`
- `tests/**` only for focused fixtures if existing test layout requires it

## Files out of scope

- AO core or vendored upstream package edits.
- The sibling shared GitHub governor.
- Serving review-start fresh-head preflight from the fleet cache.
- Reopening #566 structured output pollution.
- Machine-local runtime state or credentials.

```denylist
vendor/**
packages/core/**
.ao/**
.agent-orchestrator/**
~/.local/state/**
agent-orchestrator.yaml
```

```allowed-roots
scripts/**
docs/**
tests/**
```

## Acceptance criteria

1. **Transient retry positive path:** a fixture where the first preflight child
   exits with primary rate-limit 403, secondary/abuse-limit 403, 429, or a
   timeout and the next attempt succeeds produces a successful review-start
   decision rather than terminal `gh_command_failed`. Retry delay is bounded,
   jittered, and honors `Retry-After` or reset/rate-limit headers when present.

```positive-outcome
asserts: review-start preflight that first receives a transient primary/secondary 403, 429, or timeout retries within a bounded budget and proceeds only after a fresh successful current-head read
input: external-tool-output
provenance: sample-backed
```

```producer-emission
producer: orchestrator-pack
datum: review-start-preflight-shield
expected: transient-retry
proof-command: implementation-specific focused review-start preflight fixture
```

2. **Fresh head on every retry:** a fixture where the PR head changes during the
   backoff proves the retry reads the new head and either proceeds on the new
   head or defers cleanly. It must not start a run on the captured old head and
   must not create `outdated` churn.

```producer-emission
producer: orchestrator-pack
datum: review-start-preflight-shield
expected: fresh-head-each-retry
proof-command: implementation-specific focused head-drift fixture
```

3. **No side effects on exhaustion:** when transient retries exhaust the
   wall-clock/attempt budget, the outcome is `release_for_retry` or the existing
   equivalent transient disposition. No review run record appears, no reviewer
   worktree exists, and the claim/launch grant is released or terminalized with
   a transient reason.

```producer-emission
producer: orchestrator-pack
datum: review-start-preflight-shield
expected: no-side-effects-before-success
proof-command: implementation-specific focused no-run-no-worktree fixture
```

4. **Grant expiry during backoff:** if the claim/launch grant is seated on the
   first attempt but expires during the shield's backoff pause, the path cleanly
   releases or terminalizes without a review run record or reviewer worktree and
   records a truthful transient/budget reason. It must not report a misleading
   terminal `gh_command_failed` or leave a half-started state.

5. **No-claim sibling cell:** if the preflight would otherwise succeed but the
   claim or worktree grant is not seated, the path produces no side effect. This
   protects the #578/#580 no-claim recurrence class.

6. **Terminal guard:** 401 bad credentials, missing real binary/adoption config,
   policy/boundary deny, PR not open, malformed argv, and #566 parse pollution
   each produce a distinct visible terminal outcome. None are retried as
   transient rate-limit failures.

7. **Header degradation:** with `Retry-After`/rate-limit headers present, the
   shield honors them; with headers absent, it uses conservative fixed backoff
   and records that classification was degraded.

8. **Audit keying:** shield refusal/retry records include PR number and head SHA
   directly, or include a directly verifiable reference to an already-shipped
   Phase-0 producer record carrying those exact fields. Opaque hash-only
   preflight records are no longer the sole attribution path.

9. **Scenario matrix fixtures:** acceptance fixtures cover reachable
   combinations across preflight gh `{ok, primary/secondary 403 transient,
   429 transient, timeout transient, 5xx/network transient, terminal
   policy/config/401/malformed, PR not open}`, grant `{seated, not seated,
   expires during backoff}`, and head `{stable, drifted during pause}`. Retry
   exhaustion is an expected outcome after repeated transient inputs, not a
   separate child-exit input class. Cells without a retry pause, such as `ok` with
   `expires during backoff` or terminal config failure with head drift, are
   marked non-applicable rather than asserted as executable paths. Every
   reachable cell asserts run/no-run, worktree/no-worktree, and
   retry/release/terminal outcome.

## Upgrade-safety check

- No AO core or vendor edits.
- Fresh-head correctness is stronger than cache reuse; the shield must not
  authorize review starts from stale cached PR data.
- Retry budget is small and bounded so the orchestrator does not hang forever.
- Terminal credential/config/policy failures stay operator-visible.

## Verification

- Focused review-start preflight fixtures for AC#1 through AC#9.
- Existing #515/#516/#521/#481 lifecycle and hold-budget tests remain green.
- Existing #566 structured output tests remain green.
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/193-review-start-preflight-transient-rate-limit-shield.md`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/193-review-start-preflight-transient-rate-limit-shield.md`
- `pwsh -NoProfile -File scripts/verify.ps1`
- `pwsh -NoProfile -File scripts/check-reusable.ps1`

## Decisions

### Knowledge base

Local `wiki` search returned no relevant preflight/rate-limit shield material
and `synto` returned no relevant articles or source segments. The design is
grounded in the #580 handoff, repo code, and live/closed issue prior art.

### Design analysis

Critical mechanics are classification, bounded retry, fresh-head re-read,
claim/grant lifecycle ordering, and terminal-class separation. World practice
for this class is bounded exponential or fixed backoff with jitter, honoring
`Retry-After`, retrying only idempotent reads, and keeping credential/config
failures terminal.

| Option | Cost | Risk | Sufficiency | Decision |
|---|---:|---:|---:|---|
| Do nothing until the shared governor lands | Low | High: the fresh-head bypass remains a review-start victim | Insufficient | Rejected |
| Serve the preflight from #569 cache | Low | High: weakens current-head safety | Insufficient | Rejected |
| Add a bounded preflight transient shield | Medium-low | Low-medium: retry classification and lifecycle coupling need focused fixtures | Sufficient | Chosen |
| Fold shield into the governor draft | Medium | Medium-high: delays an independent protection behind two-runtime concurrency work | Sufficient but poorly sequenced | Rejected |

### Lifecycle Verdict

Current review-start code acquires a review-start claim before the claimed
fresh snapshot, runs the pre-run fresh-head GitHub read, aborts and completes the
claim on denied recheck, then only after success enters the side-effect fence,
workspace preflight/launch gate, and `ao review run`. This draft keeps that
ordering and strengthens the denied-transient cell: no run record and no
worktree before successful fresh preflight plus seated claim/grant.

### Scenario Matrix

The TASK-580 handoff matrix is carried forward and expanded:

| preflight gh | grant seated? | head | expected |
|---|---|---|---|
| ok | yes | stable | run may start after launch gates |
| primary/secondary 403 or 429 | yes | stable | pause and retry; no run/worktree until success |
| primary/secondary 403 or 429 | yes | drifted during pause | retry re-reads new head; old-head run never born |
| timeout | yes | stable or drifted | bounded retry using same fresh-head rule |
| 5xx/network transient | yes | stable or drifted | bounded retry using same fresh-head rule |
| transient pause | expires during backoff | any | clean release/terminalize with truthful transient/budget reason; no run/worktree |
| exhausted after backoff | yes | any | release for retry; no run/worktree litter |
| ok | no | any | no side effect |
| 401/config/policy/malformed | any | any | terminal visible outcome, no transient retry |
| PR not open | any | any | normal no-open-PR/no-run outcome, not retry |