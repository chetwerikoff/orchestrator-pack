# Review-status consumer inventory (Issues #611/#720)

Canonical inventory of pack-owned paths that decide, diagnose, or report whether a
worker has handed off `ready_for_review`. Each row names the reader contract and
the live-only invariant when terminated sessions are excluded.

| Consumer | Classification | Reader / fixture | Terminated policy |
| --- | --- | --- | --- |
| `scripts/review-trigger-reconcile.ps1` | worker-status decision reader | `Get-WorkerStatusDecisionSessions` | Live-only: reconcile only plans for open PR heads on live workers; stale/unknown rows skip silently |
| `scripts/review-trigger-reeval.ps1` | worker-status decision reader | `Get-WorkerStatusDecisionSessions` | Live-only: reeval watches bind to current open PR heads |
| `scripts/lib/Invoke-ReviewReadyReportStateSeed.ps1` | worker-status decision reader plus terminated | `Get-WorkerStatusDecisionSessionsIncludingTerminated` | Includes terminated/restored sessions (#391 seed path) |
| `scripts/lib/Get-ClaimedReviewStartSnapshot.ps1` | worker-status decision reader | `Get-WorkerStatusDecisionSessions` | Live-only: claimed review-start gates current live worker ownership |
| `scripts/lib/Invoke-ReviewWakeTrigger.ps1` | worker-status decision reader | `Get-WorkerStatusDecisionSessions` | Live-only: wake hand-off targets live supervised workers |
| `scripts/review-finding-delivery-confirm.ps1` | worker-status decision reader | `Get-WorkerStatusDecisionSessions` | Live-only: delivery confirm matches linked live worker |
| `scripts/ci-green-wake-reconcile.ps1` | worker-status decision reader | `Get-WorkerStatusDecisionSessions` | Live-only: CI-green wake nudges live workers only |
| `scripts/worker-message-submit-reconcile.ps1` | worker-status decision reader | `Get-WorkerStatusDecisionSessions` | Live-only: submit reconcile consumes live worker report stream |
| `scripts/lib/Autonomous-ClaimPrResumeGate.ps1` | worker-status decision reader / plus-terminated | `Get-WorkerStatusDecisionSessions*` via resume gate | Terminated-inclusive only when resume gate requests terminated scan |
| `scripts/dead-worker-reconcile.ps1` | worker-status decision reader plus terminated | `Get-WorkerStatusDecisionSessionsIncludingTerminated` | Explicitly includes terminated rows for recovery classification |
| `scripts/orchestrator-diagnose.ps1` | tracked diagnostic | `Get-WorkerStatusDecisionSessions`; prints `reportSourcePath` and worker-status diagnostics | Live-only diagnostic summary |
| `scripts/lib/Get-WorkerStatusDecisionSessions.ps1` | shared decision reader implementation | session existence + pack report store + pack worker status store overlay | `pack-worker-status-store` JSON under wake-supervisor state dir |
| `scripts/lib/Invoke-AoCliJson.ps1` | AO JSON adapter / legacy fixture implementation | prefix-safe parse, session list, legacy fixture report merge for tests | Not a production decision reader |
| `scripts/orchestrator-wake-listener.ps1` | not a worker-report consumer | webhook envelope only; no `ready_for_review` verdict from AO status | n/a |
| `scripts/lib/Invoke-ReviewStuckRunReaper.ps1` | not a worker-report consumer | review run liveness only | n/a |
| `scripts/lib/Worker-NudgeClaim.ps1` | not a worker-report consumer | session identity / nudge claims | n/a |
| `scripts/lib/Worker-Recovery.ps1` | not a worker-report consumer | recovery spawn identity | n/a |
| `scripts/ci-failure-notification-reconcile.ps1` | not a worker-report consumer | CI failure reaction routing | n/a |
| `agent-orchestrator.yaml.example` orchestrator rules | ad-hoc prompt diagnostic (governed) | Must use `$.data[]` + report-full reader contract prose | n/a |
| `AGENTS.md` review-status section | ad-hoc prompt diagnostic (governed) | Must use `Get-WorkerStatusDecisionSessions*` / pack worker status store | n/a |

## Reader contract

1. Never conclude `no_ready_for_review` from plain `ao status --json` or `ao session ls`.
   Production decisions read `Get-WorkerStatusDecisionSessions*`, which overlays the pack
   worker status store after merging pack worker reports.
2. Session list shape is `$.data[]` with optional `$.sessions[]` fallback — never
   `$.sessions` alone.
3. Diagnostics that print a hand-off verdict must name `reportSourcePath` when present
   and include worker-status degraded diagnostics when status is `unknown` or `stale`.
4. Prefix-safe AO JSON parsing routes through `Invoke-AoCliJson` (or equivalent
   brace-index strip) for notifier/log prefixed CLI output.
5. When `PACK_WORKER_STATUS_STORE_DISABLED` is active or sibling readiness fails,
   decision readers fail closed to `unknown`; worker-facing paths skip silently and do
   not substitute daemon composite status.
