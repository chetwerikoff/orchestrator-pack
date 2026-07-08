# Review-status consumer inventory (Issue #611)

Canonical inventory of pack-owned paths that decide, diagnose, or report whether a
worker has handed off `ready_for_review`. Each row names the reader contract and
the live-only invariant when terminated sessions are excluded.

| Consumer | Classification | Reader / fixture | Terminated policy |
| --- | --- | --- | --- |
| `scripts/review-trigger-reconcile.ps1` | report-full reader | `Get-AoStatusSessionsWithReports` | Live-only: reconcile only plans for open PR heads on live workers; terminated rows omitted by default merge |
| `scripts/review-trigger-reeval.ps1` | report-full reader | `Get-AoStatusSessionsWithReports` | Live-only: reeval watches bind to current open PR heads |
| `scripts/lib/Invoke-ReviewReadyReportStateSeed.ps1` | report-full-plus-terminated reader | `Get-AoStatusSessionsWithReportsIncludingTerminated` | Includes terminated/restored sessions (#391 seed path) |
| `scripts/lib/Get-ClaimedReviewStartSnapshot.ps1` | report-full reader | `Get-AoStatusSessionsWithReports` | Live-only: claimed review-start gates current live worker ownership |
| `scripts/lib/Invoke-ReviewWakeTrigger.ps1` | report-full reader | `Get-AoStatusSessionsWithReports` | Live-only: wake hand-off targets live supervised workers |
| `scripts/review-finding-delivery-confirm.ps1` | report-full reader | `Get-AoStatusSessionsWithReports` | Live-only: delivery confirm matches linked live worker |
| `scripts/ci-green-wake-reconcile.ps1` | report-full reader | `Get-AoStatusSessionsWithReports` | Live-only: CI-green wake nudges live workers only |
| `scripts/worker-message-submit-reconcile.ps1` | report-full reader | `Get-AoStatusSessionsWithReports` | Live-only: submit reconcile consumes live worker report stream |
| `scripts/lib/Autonomous-ClaimPrResumeGate.ps1` | report-full / plus-terminated | `Get-AoStatusSessionsWithReports*` via resume gate | Terminated-inclusive only when resume gate requests terminated scan |
| `scripts/dead-worker-reconcile.ps1` | report-full-plus-terminated reader | `Get-AoStatusSessionsWithReportsIncludingTerminated` | Explicitly includes terminated rows for recovery classification |
| `scripts/orchestrator-diagnose.ps1` | tracked diagnostic (fixed #611) | `Get-AoStatusSessionsWithReports`; prints `reportSourcePath` | Live-only diagnostic summary |
| `scripts/lib/Invoke-AoCliJson.ps1` | shared reader implementation | `Get-AoStatusSessionsWithReports*`, `Invoke-AoCliJson` prefix-safe parse, audit-backed fallback | CLI `--reports full` when available; else `.agent-report-audit/<session>.ndjson` |
| `scripts/orchestrator-wake-listener.ps1` | not a worker-report consumer | webhook envelope only; no `ready_for_review` verdict from AO status | n/a |
| `scripts/lib/Invoke-ReviewStuckRunReaper.ps1` | not a worker-report consumer | review run liveness only | n/a |
| `scripts/lib/Worker-NudgeClaim.ps1` | not a worker-report consumer | session identity / nudge claims | n/a |
| `scripts/lib/Worker-Recovery.ps1` | not a worker-report consumer | recovery spawn identity | n/a |
| `scripts/ci-failure-notification-reconcile.ps1` | not a worker-report consumer | CI failure reaction routing | n/a |
| `agent-orchestrator.yaml.example` orchestrator rules | ad-hoc prompt diagnostic (governed) | Must use `$.data[]` + report-full reader contract prose | n/a |
| `AGENTS.md` review-status section | ad-hoc prompt diagnostic (governed) | Must use `Get-AoStatusSessionsWithReports` / explicit audit path | n/a |

## Reader contract

1. Never conclude `no_ready_for_review` from plain `ao status --json` or `ao session ls`
   rows whose `reports` are empty when report-full or audit-backed state contains an
   accepted current-head `ready_for_review`.
2. Session list shape is `$.data[]` with optional `$.sessions[]` fallback — never
   `$.sessions` alone.
3. Diagnostics that print a hand-off verdict must name `reportSourcePath` (CLI or
   audit fixture).
4. Prefix-safe AO JSON parsing routes through `Invoke-AoCliJson` (or equivalent
   brace-index strip) for notifier/log prefixed CLI output.
