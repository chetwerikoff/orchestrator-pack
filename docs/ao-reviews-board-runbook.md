# AO Reviews board runtime — operator runbook (Issue #627)

## Purpose

Serve the cross-session Reviews board **read model** by aggregating AO 0.10 daemon HTTP (`/api/v1`) across sessions. This runtime is **read-only** — it does not trigger reviews or write `ao.db`.

## Prerequisites

- AO **0.10.x** desktop daemon listening on `127.0.0.1:3001` (or set `AO_DAEMON_URL`).
- Pack checkout with `tests/ao-reviews-board-runtime/` present.
- Node.js with repo `devDependencies` installed (`npm ci` at pack root).

## Start the board runtime

```bash
cd /path/to/orchestrator-pack
AO_DAEMON_URL=http://127.0.0.1:3001 AO_REVIEWS_BOARD_PORT=4310 \
  node --import tsx tests/ao-reviews-board-runtime/start.ts
```

Expected console output includes the bound URL and board JSON path.

## Smoke verification

With the daemon running:

```bash
curl -fsS http://127.0.0.1:4310/health
curl -fsS http://127.0.0.1:4310/api/reviews | jq '.runs, .dashboardLoadError'
```

Today (before review producer #210 lands) expect HTTP 200, valid JSON, and `runs: []` when sessions have empty per-session `/reviews` arrays.

Project filter:

```bash
curl -fsS 'http://127.0.0.1:4310/api/reviews?projectId=orchestrator-pack'
```

## Regression check

```powershell
pwsh -NoProfile -File tests/ao-reviews-board-runtime/check.ps1
```

## Fail-loud behavior

When the daemon is down or a required `/api/v1` read fails, `/api/reviews` returns HTTP **503** with a JSON body containing `dashboardLoadError` (classified string). The runtime does **not** silently return an empty board.

## Isolation and git safety (#304)

Any AO worker session implementing or extending this tool must use an **isolated checkout**. Forbidden in session contracts:

- `git checkout --force`
- `git reset --hard`
- force-push semantics

Completion proof is **artifacts** (runtime source, tests, live curl against daemon) — not exit code alone.

## Out of scope (sibling issues)

- UI fork: #215
- Review production / `ao review` pipeline: #210–#213
- `agent-orchestrator.yaml` changes

## Upgrade safety

The runtime depends only on versioned `/api/v1` HTTP and pack-side artifacts. It does not import AO desktop packages, read `ao.db`, or couple to `app.asar`.
