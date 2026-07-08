# Wake-supervisor GitHub reads must use one repo-tick inventory snapshot

GitHub Issue: #583

## Prerequisite

- `docs/issues_drafts/131-gh-rest-fallback-on-graphql-quota-exhaustion.md`
  (GitHub #431, closed) routes inventory-listed `gh` reads through pack
  `scripts/gh` REST forms. This task must not bypass that wrapper or add
  GraphQL fallbacks.
- `docs/issues_drafts/138-supervisor-children-gh-rest-shim-path.md`
  (GitHub #447, closed) makes wake-supervisor children resolve pack
  `scripts/gh` first. Transport routing is already solved for covered child
  reads.
- `docs/issues_drafts/140-graphql-fleet-shared-github-api-gate.md`
  (GitHub #453, closed) introduced the shared fleet cache, populate lock,
  wait-hit path, and short-TTL open-PR snapshot.
- `docs/issues_drafts/180-wake-supervisor-open-pr-snapshot-coverage-regression.md`
  (GitHub #553, closed) repaired children that bypassed the shared open-PR
  snapshot.
- `docs/issues_drafts/182-claimed-review-start-scoped-pr-lookup.md`
  (GitHub #557, closed) moved claimed review-start lookup from full open-PR
  list pressure to scoped PR lookup when the PR number is known. This issue
  must preserve that no-full-list regression contract for claimed review-start.
- `docs/issues_drafts/186-github-fleet-shared-pr-ci-snapshot.md`
  (GitHub #569, closed) extended the #453 cache family to PR view, CI/checks,
  branch protection, review freshness, and negative lookups. This issue builds
  on it; it does not rebuild those data classes.
- `docs/issues_drafts/106-review-and-cinudge-per-cycle-settle-gate.md`
  (GitHub #332, closed) and
  `docs/issues_drafts/121-llm-turn-worker-nudge-per-cycle-gate.md`
  (GitHub #384, closed) already own per-cycle worker-nudge dedup. This issue
  must not add a parallel nudge/idempotency store.
- `docs/issues_drafts/175-graphql-exhaustion-degraded-poll.md`
  (GitHub #540, closed) and the GraphQL quota recurrence closure issue
  (GitHub #549, closed) own GraphQL passthrough degraded mode and uncovered
  GraphQL read-shape closure. This issue is demand consolidation for
  wake-supervisor reads, not GraphQL replacement.
- `docs/issues_drafts/142-github-fleet-hard-rate-gate-phase2.md`
  is the local unsynced Phase-2 hard-rate-gate draft. GitHub issue #142 is
  unrelated. This issue must not absorb token buckets, hard concurrency caps,
  backoff, or header capture.
- `docs/issues_drafts/190-relocate-draft-authoring-to-cursor-session.md`
  (GitHub #582, PR #581, merged at `ef9aac20`) shipped persistent wrapper
  invocation audit and defaulted `GH_FLEET_CACHE_AUDIT` /
  `GH_WRAPPER_AUDIT` into supervisor child environments. AC#10 measurement
  must consume those shipped JSONL ledgers; this issue does not need a local
  measurement helper.

Prior-art verdict: **standalone follow-up to shipped #569**. The cache already
has true same-key single-flight; the uncovered demand problem is that the
current model is still per-datum/per-key TTL refresh. A busy tick over many PRs
can still produce a train of upstream PR-view/check/protection populates instead
of one repo-level inventory refresh consumed by every child.

## Goal

Make the wake-supervisor fleet's background GitHub reads proportional to one
repo inventory refresh per bounded interval, plus genuinely new heads, rather
than to the number of children, open PRs, and staggered child ticks. Covered
children should consume one coherent repo-tick snapshot and refresh it through a
single producer while preserving the existing freshness and action-boundary
head checks from #453/#553/#569.

```behavior-kind
action-producing
```

## Binding surface

- **Verified design-log verdict:** `scripts/lib/Gh-FleetInventoryCache.ps1`
  already has populate locks, 30-second waiters, `wait_hit` audit events, and
  bypass failures for same-key concurrent misses. The issue must not be framed
  as "add single-flight"; it must close the remaining per-key/per-TTL demand
  leak.
- A repo-tick inventory snapshot has one producer identity per repo and bounded
  interval. Covered children read the same generation for open PRs, PR view
  fields, CI/check facts, branch protection, review freshness, and negative
  facts.
- Refresh semantics must coalesce **staggered** child ticks, not only concurrent
  misses. The implementation may use serve-stale-while-one-refreshes,
  tick-aligned refresh, or a longer bounded freshness window, but the observable
  contract is one refresh owner and bounded staleness for covered data.
- Freshness contracts from existing review-start/preflight paths must not weaken:
  action-producing paths still verify current head SHA at the action boundary,
  and any existing fresh/bypass path that deliberately avoids stale cache must
  remain out of this consolidation unless tests prove equivalence.
- Snapshot keying must stay repo-scoped and head-aware: CI facts by head SHA,
  PR facts by PR number plus current-head validation, branch protection by base
  branch, and negative facts by the same identity axes as the positive datum.
- Producer failure is classified and visible. A failed refresh must not be
  cached as success and must not cause every waiting child to launch its own
  upstream GitHub read storm. Bounded stale serve is allowed only within the
  declared staleness budget and with explicit audit.
- Covered executable GitHub read call sites must remain routed through pack
  `scripts/gh` inventory or explicit REST `gh api repos/...` forms already
  allowed by the wrapper policy. No `gh api graphql`, raw `curl`, temporary
  `gh` shims, or wrapper bypasses.
- AO Node daemon polling is out of scope. If implementation discovers daemon
  reads entering pack `scripts/gh` in a way that could consume the repo-tick
  snapshot without AO core edits, report that to the architect as a coverage
  extension candidate; do not silently expand this issue.
- Baseline and post-merge evidence must distinguish: repo-tick producer calls,
  cache hits, stale-served hits, populate failures, bypass attempts, per-child
  consumers, and total wrapper invocations by route.

```contract-evidence
binding-id: orchestrator-pack:github-fleet-repo-tick-snapshot:one-refresh-owner
binding-type: cli-behavior
binding: covered wake-supervisor children consume one repo-tick GitHub inventory generation; staggered same-interval ticks do not produce per-child or per-PR duplicate upstream refreshes
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)
```

## Files in scope

- `scripts/**`
- `scripts/fixtures/**`
- `docs/migration_notes.md`
- Focused docs under `docs/**` for measurement and operator verification.

## Files out of scope

- AO core or vendored upstream package edits.
- Token bucket, hard rate gate, broad concurrency cap, circuit breaker, backoff,
  or header-capture telemetry.
- New persistent wrapper invocation logging or a local measurement helper.
- New GraphQL query work, GraphQL replacement, or native GraphQL fallback.
- New worker-nudge/idempotency store competing with #332/#384.
- Review-start freshness bypasses that intentionally require live current-head
  validation.
- Local runtime state, credentials, or machine-specific operator config.

## Denylist

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
```

## Acceptance criteria

1. **Repo-tick positive path:** with a fixture representing at least five
   covered supervisor consumers and at least ten open PRs, staggered child ticks
   within the configured interval consume one repo-tick snapshot generation.
   Upstream GitHub reads are bounded by one repo inventory refresh plus one read
   per genuinely new head/policy key, not by `children x PRs`.

```positive-outcome
asserts: staggered wake-supervisor children over a multi-PR fixture consume one repo-tick GitHub inventory generation, and duplicate upstream reads do not scale with child count or PR count
input: realistic
```

```producer-emission
producer: orchestrator-pack
datum: github-fleet-repo-tick-snapshot
expected: one-refresh-owner
proof-command: npm test -- github-fleet-repo-tick-snapshot
```

2. **Existing same-key single-flight preserved:** cold concurrent same-key
   readers still join the existing populate lock/wait-hit path. Existing
   #453/#569 coalesce fixtures remain green, and the new repo-tick producer does
   not create a second lock/cache framework for the same datum.

3. **TTL-stagger leak closed:** a fixture with child ticks offset across more
   than the old 15-second per-key TTL proves the covered fleet does not
   serially repopulate the same repo inventory once per child. The test fails if
   staggered ticks produce repeated same-generation upstream PR-view/check/list
   populates.

4. **Serve-stale/refresh failure semantics:** when a refresh is already in
   progress, readers either receive the previous generation within the declared
   staleness bound or wait for the single producer. When the producer fails,
   waiters receive one classified failure or bounded stale result; the failure
   is never cached as success, no fake-success REST/GraphQL result is returned,
   and waiters do not bypass into independent GitHub reads.

5. **Freshness no-regression matrix:** fixtures cover child tick
   `{aligned, staggered, burst-on-head-advance, restart-cold}` x snapshot
   `{fresh, stale-within-bound, populating, populate-failed, absent}` x API
   `{ok, rate-limited, transient-error}`. Each cell asserts the expected
   consume/refresh/fail/stale outcome, including no-regression cells for
   #453/#553/#557/#569 behavior.

6. **Action-boundary head safety:** any consumer that may start a review, send a
   worker nudge, suppress work, or terminalize state verifies the current PR
   head at its existing action boundary. A stale repo-tick snapshot cannot
   authorize an action on an advanced head.

7. **Call-site coverage table enforced:** static or fixture-backed verification
   enumerates every GitHub read in this exhaustive wake-supervisor child set:
   `ci-failure-notification-reconcile`,
   `ci-failure-notification-reaction`, `ci-green-wake-reconcile`,
   `review-send-reconcile`, `review-finding-delivery-confirm`,
   `review-trigger-reconcile`, `review-trigger-reeval`,
   `review-ready-report-state-seed`, `listener`, `heartbeat`,
   `review-run-recovery`, `worker-message-submit-reconcile`, and
   `review-start-claim-reaper`. The covered repo-tick consumer set includes
   `review-trigger-reeval` and `review-ready-report-state-seed`; the latter is
   covered because shipped wrapper telemetry, not failure attribution, shows it
   as the largest GitHub caller.
   Each child is classified as repo-tick snapshot, existing fresh/bypass
   exception, explicit REST route, or no-GitHub-read/negligible out-of-coverage.
   Covered child paths may not call `gh pr list`, `gh pr view`,
   `gh pr checks`, branch protection, or review freshness upstream directly
   outside the producer.

8. **GraphQL route containment:** covered wake-supervisor reads remain on pack
   `scripts/gh` REST inventory or allowed REST `gh api repos/...` forms. Tests
   or static guards fail on `gh api graphql`, raw `curl api.github.com`,
   temporary `gh` shims, wrapper bypasses, or fake-success GraphQL/REST results
   in covered paths.

9. **Idempotency overlap not duplicated:** this issue adds no parallel
   per-PR/head or per-cycle send gate. The #332/#384 WorkerNudgeClaim overlap
   remains documented in Decisions, not re-proven by new fixtures here.

10. **Measurable baseline and acceptance evidence:** the operator procedure
    captures before/after counts from the shipped
    `gh-wrapper-audit.jsonl` and GitHub fleet cache audit JSONL. Wrapper audit
    evidence reads `entry` / `complete` rows with `child`, `command`,
    `subcommand`, `argvHash`, `prNumber`, `headRef`, `kind`, `route`,
    `status`, `rateLimit`, and `rateLimitKind`; cache audit evidence reads
    event names such as populate, hit, wait-hit, stale-hit, populate failure,
    and bypass denial with key/generation fields. The post-merge target is
    that, with N open PRs and the full supervisor fleet, covered upstream reads
    per interval are a small constant independent of child count, plus reads for
    genuinely new heads and base-branch policy keys.

11. **Auditability:** every repo-tick producer refresh, consumer hit,
    stale-served hit, wait-hit, populate failure, and bypass denial emits
    structured audit data with repo, generation, consumer, route/data class,
    staleness age, and saved duplicate-call count.

## Upgrade-safety check

- No Composio AO core or vendored upstream edits.
- No secrets, tokens, cookies, local runtime state, or operator-specific config
  committed.
- The #453/#553/#569 cache family remains the authoritative GitHub fleet cache;
  this issue extends its refresh ownership model instead of replacing it.
- GitHub read transport remains REST-first through pack `scripts/gh`; uncovered
  read forms are inventory-extension reports, not GraphQL/curl/shim workarounds.
- Shipped wrapper/cache audit telemetry and Phase-2 hard governor work remain
  separate. This issue consumes the #582/#581 telemetry for AC#10 evidence; it
  must not implement a second telemetry channel.

## Verification

```powershell
npm test -- github-fleet-repo-tick-snapshot
npm test -- github-fleet-shared-read-model
npm test -- github-fleet-cache-coalesce
npm test -- github-fleet-cache-bypass
pwsh -NoProfile -File scripts/check-github-fleet-cache-bypass.ps1
pwsh -NoProfile -File scripts/check-gh-inventory-static.ps1
pwsh -NoProfile -File scripts/verify.ps1
pwsh -NoProfile -File scripts/check-reusable.ps1
```

Operator evidence using shipped supervisor telemetry:

```powershell
$env:GH_FLEET_CACHE_AUDIT = '1'
$env:GH_WRAPPER_AUDIT = '1'
# Observe one normal fleet window and one busy/head-advance window.
```

Record per interval: wrapper invocations by child/route, repo-tick snapshot
generation count, populate/wait-hit/stale-hit/bypass events, and supervisor
rate-limit-class failures. Acceptance evidence must compare those counts to
both the failure-log baseline and the shipped wrapper telemetry baseline below,
then explain which share was removed by demand consolidation rather than
Phase-2 hard limiting:

- 2026-06-20 through 2026-07-04: about 16,700 rate-limit-class failures in
  wake-supervisor logs.
- Worst day: 4,856 failures.
- 2026-06-30 burst: about 220 failures per minute for about two hours across
  11 open PRs.
- Top-5 caller share: about 84% of rate-limit-class failures, from
  `ci-failure-notification-reconcile`, `ci-failure-notification-reaction`,
  `ci-green-wake-reconcile`, `review-send-reconcile`, and
  `review-finding-delivery-confirm`.
- All-time API signature split in the audit: GraphQL 15,294 failures, REST
  4,556 failures. This issue must report only the portion removed by
  wake-supervisor demand consolidation; GraphQL passthrough and AO daemon
  reductions belong to #540/#549 or Phase 2 unless covered by this PR's own
measured call-site table.
- Shipped wrapper audit after #582/#581 recorded about 64,815 wrapper calls in
  the first roughly 5.8 hours, or about 11,000-13,000 calls/hour against the
  core budget of 5,000/hour.
- About 43% of audited wrapper calls failed, with thousands of records/hour
  carrying `x-ratelimit-remaining: 0`, proving primary quota exhaustion in
  addition to the secondary-limit incidents above.
- `gh pr list` accounted for 38,554 calls, about 59% of all wrapper
  invocations, making repo-tick open-PR snapshot consolidation the direct
  target.
- `review-ready-report-state-seed` accounted for 28,641 calls, about 44% of
  all wrapper invocations, mostly `pr list` and per-PR `pr view`. It was nearly
  invisible in failure-only attribution because many calls succeeded while
  burning quota.

## Decisions

### Knowledge-base consult

The local wiki had no GitHub-fleet-specific design note, and Synto returned no
relevant article/source hits. The useful KB framing was generic:
`Message Expiration.md` treats TTL as a validity bound for stale data, and
`Fault tolerance.md` frames partial failure as continuing acceptable service
with explicit failure models. The draft applies that by making staleness a
declared bound and producer failure a classified outcome, not an implicit child
bypass.

### Evidence log

- **Single-flight contradiction resolved:** Memo B is correct. The cache has
  same-key populate locks, `Wait-GhFleetSnapshotEnvelope`, a 30-second populate
  wait, wait-hit audit events, and bypass errors. A draft that simply says
  "add single-flight" would duplicate shipped behavior.
- **TTL/stagger leak confirmed:** default TTL for open PR list, PR view, and CI
  checks is 15 seconds, while runtime cache mtimes showed a long burst of
  `pr-view` entries populated roughly one per second across many keys. That is
  not an absence of same-key locking; it is per-key/per-PR refresh demand.
- **Uncached top-5 child bypass mostly refuted:** top child scripts consume
  `Gh-PrChecks.ps1`, which routes open PR list, PR view, CI checks, and branch
  protection through `Gh-FleetInventoryCache.ps1`. The remaining gap is coverage
  and refresh granularity, not obvious bare `gh pr list` bypass in those top
  paths.
- **Telemetry dependency satisfied:** #582/#581 shipped the persistent
  `gh-wrapper-audit.jsonl` denominator with entry/complete rows by child,
  argv/route, PR/head fields, status, and rate-limit headers. AC#10 now binds
  to that wrapper audit plus `GH_FLEET_CACHE_AUDIT`; no local helper or hard
  ordering remains.
- **Consumer selection uses call volume, not only failures:** failure logs found
  `review-trigger-reeval` as the sixth-largest rate-limit producer, while the
  wrapper audit showed `review-ready-report-state-seed` as the largest total
  GitHub caller. Coverage must satisfy both rankings.
- **GraphQL path separated:** covered child reads are intended to route through
  pack `scripts/gh` REST inventory, with #540/#549 owning passthrough GraphQL
  degraded mode and uncovered GraphQL closure. This issue should not hide
  GraphQL errors with fake success or new query rewrites.
- **AO daemon coverage not proven in scope:** the PowerShell fleet cache cannot
  serve AO Node daemon reads by construction unless those reads enter through
  pack `scripts/gh` and a repo-tick snapshot API. Treat AO daemon demand as
  out-of-scope unless implementation can cover it without AO core edits.
- **#332 overlap verdict:** no second idempotency draft. `ci-failure`,
  `ci-green-handoff`, `findings-delivery`, and
  `review-findings-redelivery` paths already acquire WorkerNudgeClaim tuples;
  #332/#384 own per-cycle/per-intent nudge dedup. This draft records that
  overlap and forbids a parallel gate.

### Call-site enumeration

| Child / surface | GitHub read need | Current route evidence | Transport attribution | Classification |
|---|---|---|---|---|
| `ci-failure-notification-reconcile` | open PRs, PR view, CI checks, required checks | uses `Invoke-GhOpenPrList` and `Get-GhChecksBundleByPr`; sends via `WorkerNudgeClaim` intent `ci-failure` | shipped wrapper audit measures child/route/status/rate-limit; GraphQL closure remains #540/#549 | cached today; move to repo-tick snapshot |
| `ci-failure-notification-reaction` | open PR lookup | uses `Invoke-GhOpenPrList` | shipped wrapper audit measures child/route/status/rate-limit | cached today; move to repo-tick snapshot |
| `ci-green-wake-reconcile` | open PRs, PR view, CI checks, required checks, review runs | uses `Invoke-GhOpenPrList`, `Get-GhChecksBundleByPr`, and `WorkerNudgeClaim` intent `ci-green-handoff` | shipped wrapper audit measures child/route/status/rate-limit; GraphQL closure remains #540/#549 | cached today; move GitHub reads to repo-tick snapshot |
| `review-send-reconcile` | open PRs and review-run state | uses `Invoke-GhOpenPrList`; send uses `WorkerNudgeClaim` intent `findings-delivery` | shipped wrapper audit measures child/route/status/rate-limit | cached today; move GitHub read to repo-tick snapshot |
| `review-finding-delivery-confirm` | open PRs and review-run state | uses `Get-OpenPrList` -> `Invoke-GhOpenPrList`; redelivery uses `WorkerNudgeClaim` intent `review-findings-redelivery` | shipped wrapper audit measures child/route/status/rate-limit | cached today; move GitHub read to repo-tick snapshot |
| `review-trigger-reconcile` | open PRs, PR view, CI checks, required checks | uses `Invoke-GhOpenPrList` and `Get-ReconcileChecksByPr`; review start uses existing review-start claim | shipped wrapper audit measures child/route/status/rate-limit | cached today; move GitHub reads to repo-tick snapshot while preserving fresh pre-run checks |
| `review-trigger-reeval` | scoped open PRs, PR view/current head, CI checks, required checks | uses `Invoke-GhOpenPrList` + `Get-ReviewTriggerReevalChecksByPr`; before `ao review run`, acquires review-start claim, resolves fresh claimed snapshot, runs `preRunRecheck`, and passes launch gate | shipped wrapper audit measures child/route/status/rate-limit; failure audit showed this was the sixth-largest rate-limit producer | cached today; move GitHub reads to repo-tick snapshot while preserving fresh pre-run recheck |
| `listener` | none in this consolidation class | audit found zero rate-limit lines for this child | none/negligible | out of coverage |
| `heartbeat` | none in this consolidation class | audit found zero rate-limit lines for this child | none/negligible | out of coverage |
| `review-run-recovery` | none in this consolidation class | audit found zero rate-limit lines for this child | none/negligible | out of coverage |
| `worker-message-submit-reconcile` | none in this consolidation class | audit found zero rate-limit lines for this child | none/negligible | out of coverage |
| `review-ready-report-state-seed` | open PRs by tracked number, PR view/current head, CI checks, required checks | `Invoke-ReviewReadyReportStateSeedTick` refreshes `New-ReviewReadyReportStateSeedGitHubSnapshot` every 5-29s using `Invoke-GhOpenPrListForNumbers` and `Get-GhChecksBundleByPr`; pre-claim and `report_state_seed` review-start boundaries use fresh `Invoke-ReviewStartScopedGhPrView` / supervised `gh pr view` plus `Get-GhChecksBundleByPr` | shipped wrapper audit showed 28,641 calls, 44% of all wrapper invocations, mostly `pr list` and per-PR `pr view` | move background snapshot reads to repo-tick snapshot; preserve fresh pre-claim and review-start action-boundary checks |
| `review-start-claim-reaper` | none in this consolidation class | audit found zero rate-limit lines for this child | none/negligible | out of coverage |
| AO Node daemon | PR/CI/session enrichment | not served by `Gh-FleetInventoryCache.ps1` | separate AO path | out of scope; report a coverage-extension candidate if pack `scripts/gh` entry is discovered |

### Options

| Option | Cost | Risk | Sufficiency | Verdict |
|---|---:|---:|---:|---|
| Only tune TTLs on #569 per-key cache | Low | weakens freshness or still serially repopulates per PR/key under staggered ticks | Partial | Reject |
| Add serve-stale-while-refresh to existing per-key cache only | Medium | improves same-key expiry but still leaves multi-PR repo ticks proportional to PR count | Partial | Reject as sole fix |
| Add one repo-tick snapshot producer/consumer model on top of #569 | Medium | requires careful staleness/head-boundary tests, but reuses shipped cache/audit/transport | High | Choose |
| Build a separate inventory service/broker process | High | new lifecycle, crash, and operator adoption surface; duplicates supervisor/cache ownership | High | Reject for Phase 1 |
| Route everything to Phase-2 hard governor | Medium | protects quota after waste occurs and absorbs out-of-scope token bucket/backoff work | Low for demand consolidation | Reject |

Chosen direction: a repo-tick snapshot producer/consumer model layered on the
existing #453/#569 cache family. It is the cheapest sufficient executor because
it closes staggered and multi-PR duplicate demand while preserving shipped
REST-wrapper and cache contracts.

### Decomposition

One draft. Snapshot consolidation and send/nudge idempotency are different
mechanisms, but the idempotency half is already substantially shipped in
#332/#384 and in current top-5 call sites through WorkerNudgeClaim. A second
draft would duplicate prior art unless a fresh audit finds a specific uncovered
send surface; that should be authored as a narrow follow-up with a named caller,
not bundled here.