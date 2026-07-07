# AO Reviews board runtime — operator runbook (Issues #627 / #628)

## Purpose

Serve the cross-session Reviews board **read model** by aggregating AO 0.10 daemon HTTP (`/api/v1`) across sessions, and host the forked Reviews board **UI** (upstream 0.9.2 kanban) as static assets. This runtime is **read-only** — it does not trigger reviews or write `ao.db`.

## Prerequisites

- AO **0.10.x** desktop daemon listening on `127.0.0.1:3001` (or set `AO_DAEMON_URL`).
- Pack checkout with `tests/ao-reviews-board-runtime/` present.
- Node.js with repo `devDependencies` installed (`npm ci` at pack root).
- UI bundle built once: `cd tests/ao-reviews-board-runtime/ui && npm install && npm run build`.

## Start the board runtime

```bash
cd /path/to/orchestrator-pack
AO_DAEMON_URL=http://127.0.0.1:3001 AO_REVIEWS_BOARD_PORT=4310 \
  node --import tsx tests/ao-reviews-board-runtime/start.ts
```

Expected console output includes the bound URL, board UI path (`/`), and board JSON path.

## Open the board UI

With the runtime running, open `http://127.0.0.1:4310/` in a browser.

- Session sidebar and project filter load from daemon-backed JSON.
- Kanban columns render all seven upstream board states.
- `runs` is empty today (before review producer #210 lands) — expect an informational empty state, not a hard failure when the daemon is healthy.

Optional project filter: `http://127.0.0.1:4310/?projectId=orchestrator-pack`

## Smoke verification

With the daemon running:

```bash
curl -fsS http://127.0.0.1:4310/health
curl -fsS http://127.0.0.1:4310/api/reviews | jq '.runs, .dashboardLoadError'
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4310/
```

Today (before review producer #210 lands) expect HTTP 200, valid JSON, and `runs: []` when sessions have empty per-session `/reviews` arrays. The UI root should return HTTP 200 (built bundle or build reminder HTML).

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

Completion proof is **artifacts** (runtime + UI sources, tests, live curl against daemon) — not exit code alone.

## Out of scope (sibling issues)

- Review production / `ao review` pipeline: #210–#213
- `agent-orchestrator.yaml` changes

## Upgrade safety

The runtime and UI depend only on versioned `/api/v1` HTTP (via the pack aggregator) and pack-side static assets. They do not import AO desktop packages, read `ao.db`, or couple to `app.asar`.
