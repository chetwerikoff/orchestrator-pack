# AO Reviews board UI (Issue #628)

Vite static bundle forked from `ComposioHQ/agent-orchestrator` @ **v0.9.2** `packages/web` review dashboard.

## Build

```bash
cd tests/ao-reviews-board-runtime/ui
npm install
npm run build
```

Production assets land in `dist/` and are served by the pack runtime server at `/`.

## Data layer

The UI fetches board state only from the sibling runtime `GET /api/reviews` endpoint (Issue #627). It does **not** import `@aoagents/ao-core`, `ao.db`, or removed Next.js `app/api/reviews` routes.

Column assignment uses producer-mapped `status` on each board row (#626), not upstream `getReviewBoardColumn` on 0.9 enums.

## Read-only v1

Trigger, send, execute, and findings actions are visibly disabled until producer write APIs exist.

## Attribution

See `NOTICE` in this directory.

## Isolation (#304)

Fork/vendor/build work runs in an isolated checkout. Session contracts forbid `git checkout --force`, `git reset --hard`, and force-push semantics.
