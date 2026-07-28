# Canonical AO surface identity map

Revision-bound to census inspected source: `8fabf182f4df0a70e2f08f67899658ee886ab337`.

**Rule:** surface identity is **semantic**. Equivalent CLI, daemon HTTP, library, wrapper, or adapter spellings for the same AO operation share one identity. Different semantic operations stay separate even when they share transport, daemon, or path prefix.

## Active surfaces (supported at inspected revision)

| Canonical ID | Semantic operation | CLI / adapter representations | HTTP / library representations | Contract evidence |
|---|---|---|---|---|
| `daemon.health` | Read daemon liveness and API port | `ao status --json`; `Get-AoDaemonHealthJson` | Port from status JSON → `http://127.0.0.1:{port}` base (`Get-AoDaemonApiBaseUrl`) | `scripts/lib/Invoke-AoCliJson.ps1`; `scripts/lib/Invoke-AoReviewApi.ps1` |
| `session.list.workers` | List worker sessions | `ao session ls --json [-p project] [--include-terminated]`; `Get-AoSessionLsJson` | — | `Invoke-AoCliJson.ps1` |
| `session.list.orchestrators` | List orchestrator sessions | `ao orchestrator ls --json`; `Get-AoOrchestratorLsJson` | — | `Invoke-AoCliJson.ps1` |
| `session.get` | Fetch one session record | `ao session get <id> --json`; `Get-AoSessionGetJson` | — | `Invoke-AoCliJson.ps1`; `docs/pr-session-binding-cache.mjs` (live resolution) |
| `session.merged-view` | Merge worker + orchestrator session lists with pack overlays | `Get-AoMergedStatusSessions`; `Get-AoStatusSessions*`; `Get-WorkerStatusDecisionSessions` | — | `Invoke-AoCliJson.ps1`; `scripts/lib/Get-WorkerStatusDecisionSessions.ps1` |
| `events.list` | Read recent daemon events | `ao events list --since … --json`; `Get-AoEventsSince` | — (CLI only in tree) | `Invoke-AoCliJson.ps1`; `scripts/terminal-flood-detect.ps1` |
| `send.message` | Deliver text to a session | `ao send --session <id> --message <text>`; `journaled-worker-send.ps1` | — | `scripts/journaled-worker-send.ps1`; `docs/ao-send-transport-contract.txt` (read-only census input) |
| `spawn.worker` | Spawn a worker session | `ao spawn …`; `Worker-Recovery.ps1` recovery spawn | — | `docs/ao-spawn-shape.mjs`; `scripts/lib/Worker-Recovery.ps1` |
| `spawn.claim-pr` | Spawn with PR claim | `ao spawn --claim-pr …` | — | `docs/ao-spawn-shape.mjs`; autonomous spawn gates |
| `session.lifecycle` | Kill / restore / claim-pr / cleanup session | `ao session kill|restore|claim-pr|cleanup` | — | `docs/orchestrator-recovery-runbook.md`; recovery scripts |
| `daemon.lifecycle` | Stop / start AO daemon | `ao stop`; `ao start <project>` | — | `scripts/set-pack-reviewer.ps1`; `AGENTS.md` (forbidden in managed workers) |
| `project.config.read` | Read project configuration | — | `GET /api/v1/projects/{projectId}`; `Get-AoProjectConfigJson` | `Invoke-AoReviewApi.ps1` |
| `project.config.write` | Update project configuration (reviewer harness) | — | `PUT /api/v1/projects/{projectId}/config`; `Set-AoProjectReviewerHarness` | `Invoke-AoReviewApi.ps1`; `docs/ao-0-10-review-api.mjs` |
| `review.session-list` | List review runs for a worker session | `pack-review-runner.ts list`; `Get-AoSessionReviewsJson` (pack-store fan-out) | `GET /api/v1/sessions/{sessionId}/reviews` (contract path; production list often via pack store) | `docs/ao-0-10-review-api.mjs`; `scripts/pack-review-runner.ts` |
| `review.trigger` | Start a review run for a session/PR | `pack-review-runner.ts start`; `Invoke-AoSessionReviewTrigger` | `POST /api/v1/sessions/{sessionId}/reviews/trigger` (contract path; trigger often via pack runner) | `docs/ao-0-10-review-api.mjs`; `Invoke-AoReviewApi.ps1` |
| `review.fail-stale` | Mark stale in-flight run failed | — | `POST /api/v1/sessions/{sessionId}/reviews/runs/{runId}/fail-stale` | `scripts/harness-post-submit-pn-reconcile.ps1`; gated by `AO_REVIEW_FAIL_STALE_SURFACE` |
| `review.runs.aggregate` | Aggregate review runs across worker sessions | `Get-AoReviewRuns`; `Get-AoReviewRunsFromWorkerSessions` | Per-session HTTP fan-out + pack store merge | `Invoke-AoReviewApi.ps1`; `scripts/review-trigger-reconcile.ps1` |
| `plugin.declare` | Task declaration hook | `ao-declare` (`plugins/ao-task-declaration/bin/declare.ts`) | — | `plugins/ao-task-declaration/` |
| `plugin.scope-guard` | Scope guard hook | `ao-scope-guard` bin/hooks | — | `plugins/ao-scope-guard/` |
| `plugin.review-command` | Execute pack review subprocess | `REVIEW_COMMAND` → `invoke-pack-review.ps1` / `ao-codex-review` | — | `plugins/ao-codex-pr-reviewer/`; `AGENTS.md` |
| `plugin.token-ledger` | Token/cost accounting hook | Plugin writer reading `AO_CHAIN_ID`, `AO_TASK_ID`, `AO_SESSION_INFO_JSON` | — | `plugins/ao-token-chain-ledger/` |
| `pack.worker-report` | Worker lifecycle report (replaces retired `ao report`) | `pack-worker-report` command | — | `docs/worker-report-store.mjs`; `scripts/pack-worker-report.ps1` |

## Retired / shed surfaces (historical representations)

Recorded so discovery hits classify as **non-live consumers** or **`shed`** bindings, not active AO dependencies.

| Canonical ID | Retired representations | Evidence | Disposition |
|---|---|---|---|
| `report.worker-state` | `ao report`; `ao acknowledge` | `scripts/json-producers/retired-surfaces.json` (`ao-report-removed`) | **shed** — replaced by `pack.worker-report` |
| `report.status-embed` | `ao status --reports …` | `retired-surfaces.json` (`ao-status-reports-flag-removed`) | **shed** — pack report store merge |
| `review.project-list` | `ao review list` | `retired-surfaces.json` (`ao-review-list-project-removed`) | **shed** — `review.runs.aggregate` |
| `review.daemon-cli` | `ao review run/send/execute`; retired `scripts/ao-review.ps1` | `retired-surfaces.json`; Issue #839 retirement | **shed** — `pack-review-runner.ts` + HTTP trigger |
| `events.list` (removed CLI) | `ao events list` on builds without events | `retired-surfaces.json` (`ao-events-removed`); `Get-AoEventsDegradedClassification` | **shed** (CLI representation); consumers such as `terminal-flood-detect.ps1` and `agent-orchestrator.yaml.example` **port** to alternate telemetry |

## Equivalence notes (non-obvious)

1. **`Get-AoSessionReviewsJson` vs HTTP GET reviews:** At 0.10.2, production reconciliation often reads the **pack review run store** (`pack-review-runner.ts` / `$AO_BASE/.../code-reviews`) and fans out session linkage. The HTTP path remains the semantic identity for review listing because it denotes the same capability boundary; the pack store is an internal producer substitution, not a different surface.

2. **`Invoke-AoSessionReviewTrigger` vs HTTP POST trigger:** `Invoke-AoReviewApi.ps1` routes trigger through `pack-review-runner.ts start` with `surface: powershell-adapter`. Same semantic identity `review.trigger`.

3. **`session.merged-view` vs `session.list.*`:** Merged view is a **composite consumer** of list + get surfaces plus pack overlays (`worker-report-store`, `worker-status-store`). Bindings are recorded separately when a consumer uses only lists vs merged overlay.

4. **Plugin bins vs `ao` CLI:** `ao-declare` and `ao-scope-guard` are not `ao` subcommands but consume AO-injected session/issue identity — separate canonical IDs (`plugin.declare`, `plugin.scope-guard`).

## Representation map maintenance

Later deletion waves must not redefine identities in this table. They evaluate zero-consumer against **canonical IDs** here, applying any updated representation map published at their candidate revision.
