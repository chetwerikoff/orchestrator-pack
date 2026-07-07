# AO Reviews board runtime (Issue #627)

Pack-local backend-for-frontend that aggregates AO 0.10 daemon HTTP reads into the Reviews board JSON consumed by the UI fork (#215).

## Start

From the pack root:

```bash
AO_DAEMON_URL=http://127.0.0.1:3001 AO_REVIEWS_BOARD_PORT=4310 \
  node --import tsx tests/ao-reviews-board-runtime/start.ts
```

Defaults:

| Variable | Default |
| --- | --- |
| `AO_DAEMON_URL` | `http://127.0.0.1:3001` |
| `AO_REVIEWS_BOARD_HOST` | `127.0.0.1` |
| `AO_REVIEWS_BOARD_PORT` | `4310` |

## Endpoints

| Path | Description |
| --- | --- |
| `/health` | Liveness JSON |
| `/api/reviews` | Aggregated board document (`?projectId=` optional filter) |
| `/api/dashboard/reviews` | Alias of `/api/reviews` |
| `/` | Minimal HTML index |

## Data sources (read-only)

- `GET /api/v1/sessions`
- `GET /api/v1/projects`
- `GET /api/v1/sessions/{sessionId}/reviews` (per-session fan-out)

Forbidden: cross-session `/api/v1/reviews*`, `ao.db`, `~/.agent-orchestrator/**`, shipped `app.asar` internals.

## Verification

```powershell
pwsh -NoProfile -File tests/ao-reviews-board-runtime/check.ps1
```

## Isolation

Fork/vendor/build work for this tool runs in an isolated checkout — never the architect's live working tree (#304). Session contracts forbid `git checkout --force`, `git reset --hard`, and force-push semantics.

## Related

- Producer mapping contract: `scripts/lib/review-producer-contract.ts` (Issue #626)
- Operator runbook: `docs/ao-reviews-board-runbook.md`
- Board JSON schema: `tests/ao-reviews-board-runtime/board-read-interface.schema.json`
