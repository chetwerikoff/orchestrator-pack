# Wake-supervisor GitHub reads must share PR/CI/protection snapshots

GitHub Issue: #569

## Prerequisite

- `docs/issues_drafts/131-gh-rest-fallback-on-graphql-quota-exhaustion.md`
  (GitHub #431, closed) routes inventory-listed `gh` reads through pack
  `scripts/gh` REST forms. It is transport work; it does not coalesce duplicate
  consumers.
- `docs/issues_drafts/138-supervisor-children-gh-rest-shim-path.md`
  (GitHub #447, closed) makes wake-supervisor children resolve pack `scripts/gh`
  first. It does not change how often children ask GitHub for the same data.
- `docs/issues_drafts/140-graphql-fleet-shared-github-api-gate.md`
  (GitHub #453, closed) shipped Phase 1: SHA memoization and a short-TTL shared
  open-PR-list snapshot. It explicitly left `gh pr checks`, branch protection,
  and per-PR status queries out of scope and counted them only in measurement.
- `docs/issues_drafts/180-wake-supervisor-open-pr-snapshot-coverage-regression.md`
  (GitHub #553, closed) repaired children that bypassed the shared open-PR
  snapshot. It still covered only open-PR list reads.
- `docs/issues_drafts/182-claimed-review-start-scoped-pr-lookup.md`
  (GitHub #557, closed) removed one full-list lookup from the claimed
  review-start path when a PR number is already known. It is a scoped lookup
  fix, not a shared fleet read model.
- `docs/issues_drafts/142-github-fleet-hard-rate-gate-phase2.md`
  is the conditional hard limiter / backoff path. This issue is not that path:
  it removes duplicate work before any hard gate is needed.
- `scripts/lib/Gh-FleetInventoryCache.ps1` already owns the Phase 1 fleet
  inventory cache root, TTL helper, snapshot envelopes, populate locks, audit
  events, and open-PR snapshot producer. This issue extends that existing cache
  family instead of introducing a second independent cache framework.

Prior-art recon verdict: **standalone extension of shipped #453/#553 cache work**.
Live REST search found no open issue that shares CI checks, branch-protection
policy, per-PR view/state, review freshness, or negative lookup data across
wake-supervisor consumers. Coworker bulk recon agreed that #453 deliberately
deferred `gh pr checks` and branch protection, and that #142 is a different
hard-rate-gate problem.

## Goal

Create a repo-scoped GitHub read model for wake-supervisor and adjacent
orchestration helpers so duplicate consumers share one coherent PR/CI/protection
snapshot per TTL/tick instead of each child issuing its own `gh pr list`,
`gh pr view`, `gh pr checks`, branch-protection, or review-freshness read for
the same repo, PR, branch, or head SHA.

The target outcome is optimization, not a fuse: under normal fleet load, GitHub
REST calls must be proportional to **unique data keys** (`repo`, `prNumber`,
`headSha`, `baseBranch`) rather than the number of children or reconcile loops
that need the data.

```behavior-kind
action-producing
```

## Binding surface

- The shared model is produced under a single repo/tick identity and exposed to
  covered consumers as local snapshot reads. A warm snapshot must not spawn
  upstream `gh` for data already covered by that snapshot.
- The implementation must extend the existing `scripts/lib/Gh-FleetInventoryCache.ps1`
  cache framework and tests. A parallel cache root/framework for the same
  wake-supervisor GitHub data is out of scope.
- Covered data classes:
  - Open PR inventory and indexes by `prNumber`, `headRefName`, and `headSha`.
  - Session-to-PR mapping derived from local AO session state plus the PR
    snapshot.
  - CI/check-run facts keyed by unique `headSha`, shared by every consumer that
    needs the same head's check state.
  - Branch-protection / required-check policy keyed by `repo` + `baseBranch`,
    with a longer TTL than CI facts.
  - Per-PR view/state fields already needed by reconcile logic, keyed by
    `prNumber`, without re-listing all open PRs when the PR is known.
  - Review coverage/freshness metadata keyed by `prNumber` + `headSha`; GitHub
    review-comment/thread reads are gated to review-active PRs and use shared
    ETag/freshness results.
  - Negative lookup facts such as `head branch has no PR`, `head already covered`,
    `no review-active PR`, and `no CI change since previous head snapshot`.
- TTL contract by class:
  - PR view/state snapshots use a short TTL because state, draft flag,
    mergeability, and head metadata can change during an active turn.
  - CI/check-run facts keyed by head SHA use a short TTL because pending checks
    transition frequently.
  - Branch-protection / required-check policy uses a longer TTL than PR and CI
    facts because policy changes are operator/config events, not per-head CI
    events.
  - Negative lookup/failure facts use their own short TTL so transient no-PR,
    no-review-active, no-CI-delta, and not-yet-created-check states do not
    suppress later real work.
  - Secondary-limit, abuse-limit, and exhausted-producer errors are not cached
    as success by this issue; hard limiting/backoff remains #142.
- Key and invalidation policy:
  - CI/check facts are keyed by `repo` + `headSha`, not by PR number alone.
  - PR view/state facts are keyed by `repo` + `prNumber`, but any action that
    depends on a head must verify the downstream/current head SHA before acting;
    stale PR-view head data must not launch, send, suppress, or terminalize work.
  - Branch-protection facts are keyed by `repo` + `baseBranch`.
  - Negative facts include the same identity axes as the positive datum they
    replace, plus a short TTL.
- Cold populate is single-flight per key. Concurrent readers for the same key
  must join the in-flight producer instead of spawning duplicate upstream reads.
- Static guards must cover every executable bypass for the newly shared data
  classes, not only `gh pr list`: direct covered-consumer calls to `gh pr view`,
  `gh pr checks`, and `gh api repos/.../branches/.../protection` must fail
  verification unless they are inside the shared producer path.
- Snapshot audit must identify producer calls, cache/snapshot hits, key, TTL
  generation, consumer, and saved duplicate-call count.
- This issue must not add a broad token bucket, cooperative backoff, hard circuit
  breaker, or fake-success behavior. If one producer call still exhausts REST,
  that evidence belongs to #142 or a follow-up hard-gate task.
- **Operator adoption:** after merge, restart the wake supervisor/AO runtime and
  verify the supervisor logs show snapshot hits for covered consumers rather
  than repeated same-key `gh pr list`, `gh pr view`, `gh pr checks`, or branch
  protection reads.

```contract-evidence
binding-id: orchestrator-pack:github-fleet-read-model:shared-pr-ci-protection-snapshot
binding-type: cli-behavior
binding: covered wake-supervisor consumers read shared repo/head/PR snapshots; warm same-key reads produce zero duplicate upstream GitHub calls
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)
```

## Files in scope

- `scripts/**`
- `scripts/fixtures/**`
- `docs/migration_notes.md`
- Focused docs under `docs/**` that explain the measurement or operator
  adoption procedure.

## Files out of scope

- AO core or vendored upstream package edits.
- New GraphQL transport work, GraphQL replacement, or native `gh api graphql`
  query changes.
- Hard rate gate, token bucket, circuit breaker, or cooperative backoff.
- Changing reviewer decision semantics, review-start claims, or worker lifecycle
  ownership.
- Live runtime state files, local credential files, or operator-specific config.

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

1. **Warm shared snapshot positive path:** a representative fixture with at least
   two active PRs, two active sessions, and five supervisor consumers proves
   that a warm same-generation snapshot serves all covered consumers with zero
   duplicate upstream calls for the same repo/list/PR/head/base-branch keys.

```positive-outcome
asserts: with two active workers and five supervisor consumers in one snapshot generation, upstream GitHub reads are bounded to one open-PR inventory populate, one CI/checks read per unique pending head SHA, and one branch-protection read per base-branch TTL; every covered consumer makes its decision from shared snapshot data
input: realistic
```

```producer-emission
producer: orchestrator-pack
datum: github-fleet-read-model
expected: shared-pr-ci-protection-snapshot
proof-command: npm test -- github-fleet-shared-read-model
```

2. **CI by head SHA dedupe:** when multiple consumers ask for check status for
   the same PR head SHA in the same TTL, fake `gh` records exactly one upstream
   checks/status populate for that head. The consumers receive equivalent check
   facts and do not call `gh pr checks` or its REST backing route independently.

3. **Explicit TTL contract:** tests or config-level assertions prove each data
   class has its own TTL bucket: short TTL for PR view/state, short TTL for
   CI/checks by `headSha`, longer TTL for branch protection, and separate short
   TTL for negative facts. Secondary-limit / exhausted-producer failures remain
   classified failures for #142 and are not stored as successful snapshot data.

4. **Key invalidation and stale-head fence:** CI/check facts are keyed by
   `repo` + `headSha`; branch-protection facts by `repo` + `baseBranch`; PR
   view/state facts by `repo` + `prNumber`. A fixture with a stale cached PR
   head proves no downstream action runs until the current head SHA is verified
   at the action boundary.

5. **Branch protection TTL:** required-check policy for the same base branch is
   populated once per configured policy TTL and reused across PRs targeting that
   branch. Tests cover both a warm hit and TTL expiry repopulate.

6. **Per-PR known-key reuse:** when a consumer already knows `prNumber`, it reads
   the shared per-PR snapshot or performs a single-flight scoped PR populate; it
   must not trigger a full open-PR list just to obtain state, head SHA, draft
   state, mergeability, or base branch fields that the model already has.

7. **Negative cache:** repeated same-generation lookups for no-PR branch, no
   review-active PR, already-covered head, and no CI delta are served from
   negative facts. A fixture fails if the implementation repeats `gh pr list
   --head`, `gh pr view`, or checks reads for those negative keys in the same
   TTL.

8. **Review freshness gated:** non-review-active PRs cause zero GitHub
   review-comment/thread reads. Review-active PRs use one shared
   ETag/freshness/read result per TTL and all consumers reuse it.

9. **Single-flight cold populate:** concurrent cold readers for the same key
   produce exactly one upstream populate attempt. All joined readers receive the
   same success or classified failure result, and the test fails on any duplicate
   same-key upstream call during cold populate.

10. **Static guard coverage:** registry-aware static verification fails if a
    covered wake-supervisor consumer bypasses the shared producer with executable
    `gh pr list`, `gh pr view`, `gh pr checks`, or
    `gh api repos/.../branches/.../protection` reads. Textual mentions in docs
    and tests must not mask executable bypasses.

11. **Existing cache framework extension:** tests or static verification prove
    the new data classes use the existing `Gh-FleetInventoryCache.ps1` cache
    root/envelope/lock/audit family rather than a second independent
    wake-supervisor GitHub cache framework.

12. **Measurement harness:** a simulated fleet-load test reports before/after
   upstream call counts for the covered data classes and enforces a regression
   threshold. The target is at least a 5x reduction versus per-consumer reads
   for the fixture, with idle/warm ticks near zero upstream calls except TTL
   producers and genuinely new heads.

13. **Auditability:** every producer call and snapshot hit emits a structured
   audit/event line with the snapshot generation, key, consumer, TTL state, and
   saved duplicate-call count. Operator logs can distinguish producer REST
   failure from consumer bypass.

14. **No hard-gate creep:** static or test coverage fails if this issue adds a
    new token bucket, broad circuit breaker, or fake success path. Existing
    #142 remains the place for hard limiting if optimized producer calls still
    exhaust REST.

## Upgrade-safety check

- No Composio AO core or vendored upstream edits.
- No secrets, local tokens, cookies, or live runtime state committed.
- GitHub reads remain routed through pack `scripts/gh` and REST inventory forms
  where REST can serve the datum.
- The #453/#553 open-PR snapshot contract remains valid; this issue extends the
  shared-data surface in the existing `Gh-FleetInventoryCache.ps1` cache family
  instead of replacing it.
- The #540/#549 GraphQL work remains separate. GraphQL exhaustion is not masked
  by fake success.

## Verification

```powershell
npm test -- github-fleet-shared-read-model
npm test -- github-fleet-cache-coalesce
npm test -- github-fleet-cache-bypass
pwsh -NoProfile -File scripts/check-github-fleet-cache-bypass.ps1
pwsh -NoProfile -File scripts/verify.ps1
pwsh -NoProfile -File scripts/check-reusable.ps1
```

Operator post-merge verification:

```powershell
pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1 -Action Stop
pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1 -Action Start
Start-Sleep -Seconds 120
pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1 -Action Status
```

Then inspect supervisor logs for snapshot-hit audit lines. During a warm
generation, covered consumers must not emit repeated same-key upstream
`gh pr list`, `gh pr view`, `gh pr checks`, branch-protection, or
review-freshness reads.

## Decisions

### Knowledge-base consult

The local KB did not contain a GitHub-specific cache design. The useful framing
was general: `Zero-downtime release.md` emphasizes warm-up before serving load,
`Commit stage.md` emphasizes fast feedback through optimized gates, and
`Fault tolerance.md` emphasizes continuing acceptable service under partial
failures. The task applies that framing by warming one shared read model and
letting consumers degrade from the producer's classified result rather than
duplicating upstream calls.

### Prior Art

#453 already established the read-through cache pattern and #553 repaired
open-PR-list bypasses. #453 explicitly left checks/protection/per-PR status
queries outside Phase 1. #557 handles a known-PR scoped lookup outside the
supervisor fleet. #142 is the conditional hard limiter. Therefore this issue is
the missing optimization layer for shared PR/CI/protection data, not a repeat of
open-PR cache coverage and not a hard-rate-gate task.

### Options

| Option | Cost | Risk | Verdict |
|---|---:|---:|---|
| Only lengthen polling intervals | Low | Reduces freshness and still duplicates same-key reads across consumers | Reject |
| Add #142 hard limiter now | Medium | Protects the quota but preserves wasted work and user explicitly asked for optimization | Reject |
| Extend the existing #453 `Gh-FleetInventoryCache.ps1` family into a repo/head/PR read model | Medium | Focused on duplicate work; preserves REST-first and existing supervisor contracts without a second cache framework | Choose |
| Build a separate cache framework for CI/protection/review data | Medium | Splits TTL, lock, audit, and invalidation semantics across two systems | Reject |
| Replace AO GitHub integration wholesale | High | Too broad; touches upstream/core behavior this pack should not vendor-patch | Reject |

### Stop Condition

The issue is done when covered wake-supervisor consumers use shared
repo/head/PR snapshots and tests prove same-key duplicate upstream GitHub reads
are eliminated for open PR inventory, CI/check facts, branch protection,
per-PR state, review freshness, and negative lookups under warm TTL/single-flight
conditions.
