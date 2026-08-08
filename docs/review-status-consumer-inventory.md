# Review-status consumer inventory

Canonical pack-owned consumers of worker review handoff. Review eligibility is
derived from the pack worker report/status stores, current GitHub PR head, and exact
runtime identity when a runtime-bound action is required.

| Consumer | Role | Terminated policy |
|---|---|---|
| `scripts/review-trigger-reconcile.ps1` | plans current-head review starts | live workers only; stale or unknown ownership fails closed |
| `scripts/review-trigger-reeval.ps1` | reevaluates deferred current-head eligibility | live workers only |
| `scripts/review-ready-report-state-seed.ps1` | seeds review state from accepted handoff reports | may include terminal records only through the explicit seed contract |
| `scripts/review-finding-delivery-confirm.ps1` | confirms finding delivery against linked worker and head | live exact target only |
| `scripts/ci-green-wake-reconcile.ps1` | resumes a live worker after required CI becomes green | live exact target only |
| `scripts/worker-message-submit-reconcile.ps1` | reconciles owned pending worker input | live exact target only |
| `scripts/dead-worker-reconcile.ps1` | classifies explicitly terminal or failed workers for recovery | terminal-inclusive by design; silence is not death |
| `scripts/lib/Get-WorkerStatusDecisionSessions.ps1` | shared status/report overlay reader | exposes typed live, stale, unknown, and terminal states |
| `scripts/lib/WorkerReportStore.ps1` | durable worker report store | reports are evidence, not effect authority |
| `scripts/lib/WorkerStatusStore.ps1` | pack-owned status projection | exact repository/worker/head binding required |
| `scripts/pack-review-runner.ts` | review start/list/status authority | claims and runs bind to exact PR head |
| `scripts/lib/review-start-claim-store.ts` | duplicate-suppression and ownership claim store | stale or mismatched claims cannot authorize start |
| `scripts/lib/worker-status-store.mjs` | TypeScript status projection | preserves unknown and stale outcomes |

## Reader contract

1. Never conclude `no_ready_for_review`, worker death, or safe recovery from one
   missing row, silence, or a plain runtime session listing.
2. Production decisions use the pack report/status overlay and current GitHub state.
3. A decision-bearing status includes repository, worker, PR, head SHA, source,
   freshness, and exact runtime identity when applicable.
4. Missing, malformed, stale, reused, or conflicting identity yields `unknown` or a
   typed non-effect outcome.
5. Worker-facing consumers skip a report write when binding cannot be proved; they
   do not substitute an unrelated runtime status.
6. Review starts require one current-head owner, an eligible handoff state, no
   terminal same-head clean result, and no active same-head claim or run.
7. Terminated-inclusive reads are allowed only for explicit recovery or seeding
   contracts. They never make a terminal record live again.
8. A previous-head status, review, CI result, or receipt is not current-head evidence.

## Status classes

- `live`: exact owner and current identity are proven;
- `stale`: a previously valid record no longer matches the current head or generation;
- `unknown`: required authority or freshness cannot be established;
- `terminal`: explicit lifecycle evidence shows completion, failure, or closure;
- `conflict`: multiple non-equivalent owners or identities claim the same subject.

Only `live` may receive a normal worker-directed effect. `terminal` may participate
in bounded recovery classification. `stale`, `unknown`, and `conflict` perform no
effect.

## Publication boundary

Review computation, delivery observation, and publication are separate. The single
publication owner validates the terminal verdict and exact target before one bounded
dispatch attempt. A comment URL, partial transport response, or operator-visible
receipt is not a substitute for authoritative reread.

## Verification

Focused tests must cover live, stale-head, reused generation, terminal-inclusive,
ambiguous owner, missing store, malformed store, duplicate claim, same-head clean,
new-head reset, and concurrent reconciliation scenarios.
