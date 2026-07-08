# AO Reviews board runtime: cross-session aggregation on the 0.10 daemon API

GitHub Issue: #627

## Prerequisite

- Live operator environment on AO **0.10.x** with the desktop-owned daemon on `127.0.0.1:3001` serving versioned HTTP `/api/v1/*` (verified 2026-07-06: `GET /api/v1/sessions` and `GET /api/v1/projects` return 200; per-session `GET /api/v1/sessions/{id}/reviews` returns `{"reviewerHandleId":"","reviews":[]}`; cross-session routes `/api/v1/reviews`, `/api/v1/reviews/list`, `/api/v1/dashboard/reviews` return 404).
- **Hard dependency (producer — 0.10 review pipeline series):**
  - `docs/issues_drafts/210-ao-010-review-harness-and-trigger-loop.md` (GitHub Issue: TBD) — trigger loop and harness; populates `review_run` rows.
  - `docs/issues_drafts/211-ao-010-review-stuck-run-reaper.md` (GitHub Issue: TBD) — stale `running` recovery.
  - `docs/issues_drafts/212-ao-010-review-pipeline-vocabulary-migration.md` (GitHub Issue: TBD) — dead 0.9 vocabulary cutover.
  - `docs/issues_drafts/213-ao-010-review-producer-data-contract.md` (GitHub Issue: TBD) — **normative** producer field contract and 0.10→board-column mapping table this draft consumes.
  This draft **reads** triage/review state surfaced via per-session `/reviews`. **Sequencing:** #214 may land **before** #210–#212 using committed daemon captures and the #213 mapping contract (draft or merged); **live** populated `runs` against a running daemon require #210+#213. #213's mapping table is the normative contract for column derivation in either mode.
- `docs/issues_drafts/206-ao-010-session-status-readers-migration.md` (GitHub #619) — sibling AO 0.10 reader migration; orthogonal (CLI session rows vs daemon HTTP for the board).
- `docs/issues_drafts/204-review-status-consumers-report-full-json-reader.md` (GitHub #611, open) — report-full consumers; **not** the Reviews board producer; cite only to avoid conflating report-full CLI bindings with board triage data.
- Shipped / closed adjacent work (does not deliver the board):
  - `docs/issues_drafts/38-review-dashboard-terminal-cleanup-on-start.md` (GitHub #122, closed) — operator script for CLEAN/FAILED → OUTDATED on the **0.9** dashboard; API surface removed in 0.10.
  - AO 0.10.2 removed `packages/web` and the shipped Reviews board (`ComposioHQ/agent-orchestrator` `v0.10.0+` has no `packages/web`; installed Electron renderer `resources/app.asar` contains no `ReviewDashboard` or `/reviews` route — only unrelated `DashboardSubhead` asset).
- Prior-art verdict: **Genuinely new.** Coworker corpus survey and `gh issue list --search "reviews board"` / `"review pipeline 0.10"` on `chetwerikoff/orchestrator-pack` (2026-07-06) found no shipped or queued board-fork draft. The parallel producer brief is the only adjacent in-flight work.

## Goal

Deliver a **pack-local, upgrade-durable runtime** that reconstructs the cross-session Reviews board **read model** on AO 0.10 by aggregating the versioned daemon HTTP API (`/api/v1`) across sessions. The runtime exposes a stable **board read interface** (JSON document matching the fields the UI consumes) to a sibling UI-fork issue; it does **not** implement review production, GitHub review integration, or CI wiring. The operator can start the local server, confirm aggregated board data against a live daemon (empty `reviews` arrays today; populated after the producer lands), and verify upgrade-safety invariants without touching the architect's live git tree.

```behavior-kind
action-producing
```

```complexity-tier
tier: T2
advisory-prior: T2
```

## Binding surface

### Invariants (non-negotiable)

- **Data consumer only.** This runtime **reads** triage/review state; it never triggers reviews, submits findings, or writes `ao.db`. Review production is owned by the parallel producer issue.
- **Primary dependency: versioned daemon HTTP API** (`GET /api/v1/sessions`, `GET /api/v1/projects`, `GET /api/v1/sessions/{sessionId}/reviews`, and other **documented read** routes the producer issue binds). **Forbidden:** coupling to `app.asar` internals, `window.ao`, or writes to `ao.db`.
- **Read-only `ao.db` is rejected for v1.** Tables `review`, `review_run`, and `pr_reviews` exist in WAL mode with the daemon as sole writer (verified 2026-07-06: all three tables present, row counts 0, `PRAGMA journal_mode` = `wal`). A reader is technically safe, but it couples the board to an **internal, unversioned schema** rather than `/api/v1`. This issue chooses **daemon API only**; a future draft may revisit read-only DB only if the daemon exposes no sufficient cross-session read surface after the producer lands.
- **Cross-session aggregation is this runtime's job.** AO 0.10 exposes reviews **per session only**; there is no cross-session list route (404 verified). The runtime must fan out over session rows and merge a project-scoped (or all-projects) board view.
- **Legacy flat-file state is not a source.** `~/.agent-orchestrator/` is stale legacy (read-only, not wired).
- **Upgrade durability.** Survive AO updates by depending only on `/api/v1` and pack-side artifacts — never shipped-app internals.
- **Isolation + git safety (contract-level for any session this issue spawns).** Fork/vendor/build work runs in an **isolated checkout** — never the architect's live working tree (#304 class). **Forbid** `git checkout --force`, `git reset --hard`, and force-push semantics in session contracts. **Completion proof = artifacts** (runtime source present, server serves aggregated JSON against live daemon, discipline checks pass) — not exit code alone.

### Board read interface (consumer contract — fields the UI reads)

The runtime serves a single JSON document (exact transport path is planner-chosen) whose shape preserves the **0.9 Reviews board semantics** the UI fork expects. Minimum fields per row (`DashboardReviewRun` lineage from upstream `packages/web/src/lib/review-types.ts` @ `v0.9.2`):

| Field group | Fields | Source today | After producer lands |
| --- | --- | --- | --- |
| Run identity | `id`, `sessionId`, `projectId`, `prUrl`, `targetSha` | `latestRun` + session row (`id`→`sessionId`, `projectId` from session); `id` **nullable** when no `latestRun` (queued) — stable row key = `sessionId` + `prUrl` from `PRReviewState` | same |
| Run state | `prReviewStatus`, `latestRun.status`, `verdict`, `body`, `githubReviewId`, `deliveredAt`, `batchId` | empty `reviews` arrays today | `PRReviewState` + `latestRun` via `/reviews` (#213) |
| Worker context | `projectName`, `workerBranch`, `workerPrUrl`, `workerStatus`, `workerActivity`, `workerHasRuntime` | `GET /api/v1/sessions` + `/projects` | same — verified 0.10 session row fields only |
| Board column | derived board `status` → column (`queued` \| `reviewing` \| `triage` \| `waiting` \| `clean` \| `failed` \| `outdated`) | #213 mapping table (0.10 engine enums → seven columns) | unchanged |

**Session row binding (verified 2026-07-06):** `GET /api/v1/sessions` returns `activity`, `branch`, `createdAt`, `harness`, `id`, `isTerminated`, `kind`, `projectId`, `prs`, `status`, `terminalHandleId`, `updatedAt`. Map `branch`→`workerBranch`, `status`→`workerStatus`, `activity`→`workerActivity`, `terminalHandleId`≠`""`→`workerHasRuntime` (derived). **`workerPrUrl`:** optional sidebar hint from session `prs` when exactly one PR URL is present; **nullable** when `prs` is empty or multi-valued — per-run `prUrl` from `PRReviewState` is authoritative for board rows. **No source** for `workerTitle` or `workerRuntimeState` — omitted from v1 contract (UI fork renders nullable/absent).

Sidebar payload (minimum): `sidebarSessions`, `orchestrators`, `workerOptions`, `projects`, `projectName`, optional `dashboardLoadError` when aggregation fails fail-loud. **Client-owned:** project selection (`selectedProjectId`) stays in the UI (#215) — not emitted by this stateless read endpoint.

**Column mapping:** Fixture and aggregation tests bind the **0.10 wire vocabulary** on per-session `/reviews` payloads (`PRReviewState.status`, `latestRun.status`, `verdict`, `deliveredAt`, …) and apply the producer-owned **0.10→board-column mapping table** in `docs/issues_drafts/213-ao-010-review-producer-data-contract.md` to derive the seven v0.9.2 board columns. Do **not** assert impossible payloads where run rows already carry board-column enum strings.

### Placement

**Tracked in pack** under a new top-level tool directory (planner names it; e.g. `tools/ao-reviews-board/`). Justification: Apache-2.0 fork attribution, reproducible operator path, and upgrade-durability docs belong in git. **Not** gitignored local-only — operator can still run without CI.

### Operator adoption

Document a single operator entry (script or `npm`/`bun` command) to start the local server against `AO_DAEMON_URL` defaulting to `http://127.0.0.1:3001`. No change to `agent-orchestrator.yaml` or AO core.

## Files in scope

- New pack-local tool tree for the aggregation runtime and local static server `(new)`
- `tests/external-output-references/**` — daemon HTTP capture corpus for `/api/v1/sessions`, `/api/v1/projects`, per-session `/reviews` `(new captures)`
- `tests/**` — aggregation fixture tests `(new)`
- `docs/**` — operator runbook for starting the board runtime `(new or updated)`

## Files out of scope

- UI components forked from upstream `ReviewDashboard.tsx` — sibling `docs/issues_drafts/215-ao-reviews-board-ui-fork.md`
- Review pipeline producer / `ao review` CLI re-wiring — #210–#213 series
- `scripts/**` pack reconcile/automation changes — **except** read-only invocation of the existing `scripts/external-output-shape-guard.mjs` proof harness (no edits to that script required); optional thin operator launcher may live under the tool tree instead
- Stock-dashboard-in-browser shim (serve shipped 0.10 Electron SPA)
- GitHub-side review integration
- CI workflow changes (local tool)
- `vendor/**`, AO core, `.ao/**`, live `agent-orchestrator.yaml`
- `~/.agent-orchestrator/**` reads or writes

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
~/.ao/**
agent-orchestrator.yaml
~/.agent-orchestrator/**
```

```allowed-roots
tools/**
tests/**
docs/**
```

## Acceptance criteria

1. **Daemon read surface.** Runtime fetches session and project lists from `/api/v1` only (no POST). With live daemon (2026-07-06 shape), aggregation completes without error when `reviews` arrays are empty.

```positive-outcome
asserts: GET against the runtime's board JSON endpoint returns HTTP 200 with `runs: []`, non-empty `projects`, and session-derived sidebar rows when the daemon has sessions but zero review runs
input: realistic
```

```producer-emission
producer: orchestrator-pack
datum: reviews-board-aggregation
expected: merged-board-json-from-daemon-reads-only
proof-command: implementation-specific test invoking aggregation against committed daemon captures
red-then-green: must fail if runtime reads ao.db or calls removed cross-session /api/v1/reviews
```

2. **Populated-run aggregation (fixture).** With a committed capture (or test fixture) where at least one session's `/reviews` payload uses the **AO 0.10 wire shape** (`PRReviewState.status` ∈ `needs_review|running|up_to_date|changes_requested|ineligible` plus `latestRun` with `status`, `verdict`, `deliveredAt`, …), aggregation merges that run into `runs`, derives the board column via the **#213 0.10→board-column mapping table** (seven v0.9.2 columns: `queued` … `outdated`), and respects per-`projectId` filtering (runs from other projects excluded when filtered). Fixture payloads must **not** embed board-column enum strings in the daemon wire — only 0.10 engine fields. This AC proves merge + column derivation for **each row** of the #213 mapping table (seven board columns) via populated fixtures or a parameterized mapping test — not a single representative run only.

```positive-outcome
asserts: replaying populated per-session reviews captures (or parameterized mapping fixtures) yields HTTP 200 with merged runs in the expected board column for **each** #213 mapping-table row, and project filter excludes out-of-scope runs
input: realistic
```

```producer-emission
producer: orchestrator-pack
datum: ao-0-10-daemon-capture
expected: per-session-reviews-populated
proof-command: node scripts/external-output-shape-guard.mjs --variant ao-0-10-daemon/per-session-reviews-populated
red-then-green: must fail if aggregator ignores non-empty per-session /reviews payloads or drops project filter
```

3. **Per-session fan-out only.** For each session in scope, runtime calls `GET /api/v1/sessions/{sessionId}/reviews` and merges results. Runtime must **not** call a cross-session reviews list route (e.g. `/api/v1/reviews`); proof is by observed outbound URLs in fixture replay, not by requiring the daemon route stay 404 forever.

```producer-emission
producer: orchestrator-pack
datum: cross-session-reviews-route
expected: per-session-fanout-only
proof-command: implementation-specific test recording outbound daemon URLs during aggregation replay; must fail if any request targets /api/v1/reviews without a session id segment
red-then-green: must fail if aggregator calls a cross-session /api/v1/reviews list route
```

4. **Fail-loud aggregation.** If the daemon is unreachable or a required `/api/v1` read fails, the board JSON includes a classified `dashboardLoadError` (or HTTP 503 with error body) — no silent empty board posing as "no reviews".

5. **Project filter.** Supports `all` and per-`projectId` views consistent with upstream board behavior (filter sessions and runs by project).

6. **Producer-ready interface.** Documented JSON schema (or TypeScript types checked into the tool tree) lists every field in the Board read interface table; fields the producer does not yet populate remain nullable/empty without crashing the aggregator.

7. **Upgrade-safety proof.** Runtime has **zero** imports from `/usr/lib/agent-orchestrator/**`, `app.asar`, or AO npm packages pinned to the installed desktop version. Dependency audit check (script or test) fails if such imports appear.

8. **Isolation contract.** Any spawn/fork session contract in docs states: isolated checkout, no force-checkout/reset, artifact-based completion proof. A discipline note in the operator doc references #304 / delegate git incident class.

9. **Capture corpus.** Committed captures under `tests/external-output-references/captures/ao-0-10-daemon/**` for sessions list, projects list, per-session reviews (empty array shape), and populated per-session reviews, scrubbed per #223.

```producer-emission
producer: orchestrator-pack
datum: ao-0-10-daemon-capture
expected: sessions-list
proof-command: node scripts/external-output-shape-guard.mjs --variant ao-0-10-daemon/sessions-list
```

```producer-emission
producer: orchestrator-pack
datum: ao-0-10-daemon-capture
expected: projects-list
proof-command: node scripts/external-output-shape-guard.mjs --variant ao-0-10-daemon/projects-list
```

```producer-emission
producer: orchestrator-pack
datum: ao-0-10-daemon-capture
expected: per-session-reviews-empty
proof-command: node scripts/external-output-shape-guard.mjs --variant ao-0-10-daemon/per-session-reviews-empty
```

10. **Local server.** Operator can bind a localhost port (default planner-chosen) serving the board JSON and a minimal health page proving the server is up. Static UI assets are out of scope for this issue (sibling #215 wires the fork).

11. **No legacy sources.** Static analysis or test proves runtime does not read `~/.agent-orchestrator/**` or `code-reviews/**` flat files.

## Upgrade-safety check

- Depends only on versioned `/api/v1` HTTP and pack-side artifacts.
- No `ao.db` writes; no `ao.db` reads in v1.
- No `app.asar` / Electron bridge coupling.
- No CI-facing changes.

## Verification

1. Unit/integration tests replay committed `ao-0-10-daemon` captures through the aggregator (empty and populated per-session reviews shapes per AC#1 and AC#2).
2. Live smoke (operator doc): with daemon on `127.0.0.1:3001`, curl the board JSON endpoint — 200, valid shape, empty `runs` today.
3. Upgrade-safety import audit per AC#7.
4. `pwsh -NoProfile -File scripts/check-draft-discipline.ps1` commands on this draft (see architect handoff).
5. Sibling UI issue `215-ao-reviews-board-ui-fork.md` depends on this runtime's read interface.

## Decisions

### Prior art

No shipped board fork. #214 ships first with empty-run proof and capture-backed populated fixtures bound to #213's mapping table; **live** daemon populated `runs` follow #210+#213 merge.

### Design analysis (T2 — three options judged)

**Critical mechanics:** Per-session review API + session metadata → merged kanban columns; refresh on poll or SSE (`/api/v1/events` exists but optional for v1); localhost server serves JSON to UI.

**Industry pattern:** BFF (backend-for-frontend) aggregating micro-APIs — standard for dashboards when no list endpoint exists.

**Architecture sketch:**

```
[Browser UI #215] --HTTP--> [Pack local server #214] --GET /api/v1/*--> [AO daemon :3001]
                                                      (no ao.db)
```

**Options (cost / risk / sufficiency):**

| Option | Cost | Risk | Sufficiency |
| --- | --- | --- | --- |
| **(a) Trimmed Next.js server routes** | High deps; closest to upstream `packages/web/src/app/api/reviews/*` | Next version churn; heavy for local-only tool | Sufficient but expensive |
| **(b) Static aggregator + tiny Node/Bun server** | Medium port; reimplement aggregation only | Must keep JSON shape aligned with UI fork | **Cheapest sufficient** — matches pack local-tool pattern |
| **(c) Read-only `ao.db` SQL aggregator** | Low HTTP chatter | **Schema coupling** — breaks on AO DB migrations without API versioning | Rejected for v1 (internal schema unversioned) |
| **(d) Reference shipped 0.10 dashboard** | Lowest if it existed | **Not available** — board removed | N/A |

**Land:** Option **(b)** — tiny local server + daemon fan-out. UI fork (#215) consumes JSON; no Next.js runtime in pack.

### ao.db read-only trade (explicit)

Rejected for v1: WAL-safe reads still bind to undocumented columns (`review_run.status`, `verdict`, … verified 2026-07-06). Daemon API is the durability contract.

### Upstream fork ref (for sibling UI issue)

Pin UI fork to **`ComposioHQ/agent-orchestrator` tag `v0.9.2`** (`packages/web` present; `ReviewDashboard.tsx` ~42 KB). No `v0.9.4`/`v0.9.5` tags; `v0.10.0` removed `packages/web` entirely.

```contract-evidence
binding-id: orchestrator-pack:ao-0-10-daemon-capture:sessions-list
binding-type: structured
binding: committed capture replays GET /api/v1/sessions shape used by aggregator
producer: orchestrator-pack
evidence: NEW(produced-by AC#9)
expected: sessions-list

binding-id: orchestrator-pack:ao-0-10-daemon-capture:projects-list
binding-type: structured
binding: committed capture replays GET /api/v1/projects shape used by aggregator
producer: orchestrator-pack
evidence: NEW(produced-by AC#9)
expected: projects-list

binding-id: orchestrator-pack:ao-0-10-daemon-capture:per-session-reviews-empty
binding-type: structured
binding: committed capture replays GET /api/v1/sessions/{id}/reviews empty-array shape
producer: orchestrator-pack
evidence: NEW(produced-by AC#9)
expected: per-session-reviews-empty

binding-id: orchestrator-pack:cross-session-reviews-route:per-session-fanout-only
binding-type: structured
binding: aggregation outbound daemon calls use per-session /reviews only — no cross-session list route
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)
expected: per-session-fanout-only

binding-id: orchestrator-pack:reviews-board-aggregation:merged-board-json-from-daemon-reads-only
binding-type: structured
binding: runtime board JSON endpoint returns runs array and sidebar fields from daemon reads only
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)
expected: merged-board-json-from-daemon-reads-only

binding-id: orchestrator-pack:ao-0-10-daemon-capture:per-session-reviews-populated
binding-type: structured
binding: committed capture replays GET /api/v1/sessions/{id}/reviews with at least one non-empty run merged into board JSON
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)
expected: per-session-reviews-populated
```


