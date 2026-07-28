# Canonical AO surface identity map

Revision-bound to census inspected source: `dcda4ed83ffb9027948607860bcdd5276abb2752`.

**Rule:** surface identity is **semantic**. Equivalent CLI, daemon HTTP, library, wrapper, or adapter spellings for the same AO operation share one identity. Different semantic operations stay separate even when they share transport, daemon, or path prefix.

**Axis-4 rule:** pack durable stores are **consumers** on axis 4. Canonical surface IDs name AO **capabilities** (transport, context injection, lifecycle), not store filenames. Drain bindings attach to the semantic surface whose persisted identity the store enables readers to resume — see [`axis4-drain-bindings.md`](./axis4-drain-bindings.md).

## Active surfaces (supported at inspected revision)

| Canonical ID | Semantic operation | CLI / adapter representations | HTTP / library representations | Contract evidence |
|---|---|---|---|---|
| `daemon.health` | Read daemon liveness and API port | `ao status --json`; `Get-AoDaemonHealthJson` | Port from status JSON → `http://127.0.0.1:{port}` base | `scripts/lib/Invoke-AoCliJson.ps1` |
| `session.list.workers` | List worker sessions | `ao session ls --json`; `Get-AoSessionLsJson` | — | `Invoke-AoCliJson.ps1` |
| `session.list.orchestrators` | List orchestrator sessions | `ao orchestrator ls --json`; `Get-AoOrchestratorLsJson` | — | `Invoke-AoCliJson.ps1` |
| `session.get` | Fetch one session record by ID | `ao session get <id> --json`; `Get-AoSessionGetJson` | — | `Invoke-AoCliJson.ps1` |
| `session.merged-view` | Merge worker + orchestrator session lists with pack overlays | `Get-AoMergedStatusSessions`; `Get-WorkerStatusDecisionSessions` | — | `Invoke-AoCliJson.ps1`; `scripts/lib/Get-WorkerStatusDecisionSessions.ps1` |
| `events.list` | Read recent daemon events | `ao events list --since … --json`; `Get-AoEventsSince` (degraded on removed CLI) | — | `Invoke-AoCliJson.ps1`; `agent-orchestrator.yaml.example` |
| `send.message` | Deliver text to a session | `ao send --session <id> --message <text>`; `journaled-worker-send.ps1` | — | `scripts/journaled-worker-send.ps1` |
| `spawn.worker` | Spawn a worker session | `ao spawn …`; `Worker-Recovery.ps1` | — | `docs/ao-spawn-shape.mjs` |
| `spawn.claim-pr` | Spawn with PR claim | `ao spawn --claim-pr …` | — | `docs/ao-spawn-shape.mjs` |
| `session.lifecycle` | Kill / restore / claim-pr / cleanup session | `ao session kill|restore|claim-pr|cleanup` | — | `docs/orchestrator-recovery-runbook.md` |
| `daemon.lifecycle` | Stop / start AO daemon | `ao stop`; `ao start <project>` | — | `scripts/set-pack-reviewer.ps1`; `AGENTS.md` |
| `project.config.read` | Read project configuration | `ao project get <name> --json`; `Get-AoProjectConfigJson` | `GET /api/v1/projects/{projectId}` | `Invoke-AoReviewApi.ps1`; adoption skills |
| `project.config.write` | Update project configuration (reviewer harness) | — | `PUT /api/v1/projects/{projectId}/config` | `Invoke-AoReviewApi.ps1`; `docs/ao-0-10-review-api.mjs` |
| `review.session-list` | List review runs for a worker session | `pack-review-runner.ts list`; `Get-AoSessionReviewsJson` | `GET /api/v1/sessions/{sessionId}/reviews` | `docs/ao-0-10-review-api.mjs`; `scripts/pack-review-runner.ts` |
| `review.trigger` | Start a review run for a session/PR | `pack-review-runner.ts start` | `POST …/reviews/trigger` | `docs/ao-0-10-review-api.mjs` |
| `review.runs.aggregate` | Aggregate review runs across worker sessions | `Get-AoReviewRuns` | Per-session HTTP fan-out + pack store | `Invoke-AoReviewApi.ps1`; `scripts/review-trigger-reconcile.ps1` |
| `plugin.declare` | Task declaration hook | `ao-declare` | — | `plugins/ao-task-declaration/` |
| `plugin.scope-guard` | Scope guard hook | `ao-scope-guard` | — | `plugins/ao-scope-guard/` |
| `plugin.review-command` | Execute pack review subprocess | `REVIEW_COMMAND` | — | `plugins/ao-codex-pr-reviewer/`; `AGENTS.md` |
| `plugin.token-ledger` | Token/cost accounting hook (ledger write) | Plugin writer subprocess | — | `plugins/ao-token-chain-ledger/` |
| `pack.worker-report` | Worker lifecycle report (replaces retired `ao report`) | `pack-worker-report` | — | `docs/worker-report-store.mjs` |

## AO runtime context injection (axis 2 — distinct from transport operations)

These denote AO-provided **identity/context bytes** injected into a process environment. Reading the variable is not the same semantic operation as invoking the transport that would fetch the same fact (e.g. `session.get`).

| Canonical ID | Semantic operation | Representations | Evidence |
|---|---|---|---|
| `context.session-id` | Worker session UUID injected by AO runtime | `AO_SESSION_ID`, `AO_WORKER_SESSION_ID` env reads | `AGENTS.md` (alongside `ao session get`); plugins; dispatch journal |
| `context.orchestrator-session-id` | Orchestrator session UUID from env | `AO_ORCHESTRATOR_SESSION_ID` | `Orchestrator-Escalation.ps1`; wake supervisor paths |
| `context.project-id` | Project slug/id injected by AO | `AO_PROJECT`, `AO_PROJECT_ID` | Harness env; binding cache resolvers |
| `context.issue-id` | Linked issue number/id injected by AO | `AO_ISSUE_NUMBER`, `AO_ISSUE_ID` | Scope guard; declaration plugins |
| `context.worker-handoff` | PR/repo/head binding fields for worker reports | `AO_PR_NUMBER`, `AO_REPO_SLUG`, `AO_HEAD_SHA`, … | `pack-worker-report.ps1`; `WorkerReportStore.ps1` |
| `context.task-ledger` | Chain/task/parent session ledger fields | `AO_CHAIN_ID`, `AO_TASK_ID`, `AO_PARENT_SESSION_ID`, `AO_SESSION_INFO_JSON` | `plugins/ao-token-chain-ledger/` |
| `context.spawn-generation` | Spawn/claim generation counter | `AO_CHILD_GENERATION` | Review-start claim lifecycle |

## Retired / shed surfaces (historical representations)

| Canonical ID | Retired representations | Evidence | Disposition |
|---|---|---|---|
| `report.worker-state` | `ao report`; `ao acknowledge` | `retired-surfaces.json` | **shed** |
| `report.status-embed` | `ao status --reports …` | `retired-surfaces.json` | **shed** |
| `review.project-list` | `ao review list` | `retired-surfaces.json` | **shed** |
| `review.daemon-cli` | `ao review run/send/execute`; `scripts/ao-review.ps1` | Issue #839 | **shed** |
| `review.fail-stale` | HTTP fail-stale run | `docs/ao-0-10-review-api.mjs`; `docs/review-stuck-run-reaper.d.mts` | **shed** at inspected revision — no supported live caller after PR #1039 dead-cut (`harness-post-submit-pn-reconcile.ps1` removed) |
| `events.list` (removed CLI) | `ao events list` on builds without events | `retired-surfaces.json`; `Get-AoEventsDegradedClassification` | CLI **shed**; `agent-orchestrator.yaml.example` **port** obligation remains on alternate telemetry |

## Equivalence notes (non-obvious)

1. **`context.session-id` vs `session.get`:** `AO_SESSION_ID` in a plugin hook is runtime injection. `ao session get` / `Get-AoSessionGetJson` is an explicit fetch — separate canonical IDs.

2. **`context.project-id` vs `project.config.read`:** `AO_PROJECT` env defaulting is injection. `ao project get` / HTTP GET is configuration read — separate IDs.

3. **Axis-4 stores vs surfaces:** Store IDs (e.g. `mechanical-transport`) appear only as axis-4 **consumers**. Their drain bindings attach to semantic surfaces such as `send.message` — see [`axis4-drain-bindings.md`](./axis4-drain-bindings.md).

4. **`Get-AoSessionReviewsJson` vs HTTP GET reviews:** Pack review run store is an internal producer; HTTP path remains the semantic identity for `review.session-list`.

## Representation map maintenance

Later deletion waves evaluate zero-consumer against **canonical IDs** in this table. Store consumers and context injections must not be collapsed into unrelated transport operations.
