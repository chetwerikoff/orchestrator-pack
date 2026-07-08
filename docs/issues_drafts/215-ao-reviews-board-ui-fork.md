# AO Reviews board UI fork from upstream 0.9.2 on the pack runtime

GitHub Issue: #628

## Prerequisite

- `docs/issues_drafts/214-ao-reviews-board-runtime-aggregation.md` (GitHub Issue: TBD) — **must merge first.** Supplies the localhost board read JSON, cross-session aggregation over `/api/v1`, and the documented read interface. This issue wires UI to that endpoint only; no duplicate aggregation logic.
- **Hard dependency (producer — 0.10 review pipeline series):** `docs/issues_drafts/210-ao-010-review-harness-and-trigger-loop.md` through `docs/issues_drafts/213-ao-010-review-producer-data-contract.md` (GitHub Issue: TBD each) — repopulates review/triage data consumed indirectly via the #214 runtime. UI displays empty columns until #210+#213 land; must not embed producer logic.
- Upstream fork source: **`ComposioHQ/agent-orchestrator` tag `v0.9.2`**, Apache-2.0. Key UI files at that ref:
  - `packages/web/src/components/ReviewDashboard.tsx` (~42 KB)
  - `packages/web/src/app/reviews/page.tsx`
  - `packages/web/src/lib/review-types.ts`
  - `packages/web/src/lib/review-page-data.ts` (data layer **replaced** — not ported)
  - Removed 0.9 server routes to drop: `packages/web/src/app/api/reviews/{route.ts,findings/route.ts,send/route.ts,execute/route.ts}` (wrapped removed CLI/store).
- Verified: `v0.10.0+` has no `packages/web`; `v0.9.3-nightly-*` still had `web` but **`v0.9.2` is the newest stable tag carrying `packages/web`** — pin explicitly to **`v0.9.2`**.
- Prior-art verdict: **Genuinely new** (UI fork); extends #214 runtime only.

## Goal

Fork the AO 0.9 **Reviews board UI** into the pack as an **upgrade-durable local web tool** that preserves operator kanban triage UX (columns: Queued, Reviewing, Triage, Waiting, Clean, Failed, Outdated) while **replacing the entire data layer** with fetches to the #214 runtime board JSON — never to removed Next.js API routes, `app.asar`, or `ao.db`. Apache-2.0 attribution and license headers survive the fork. After merge, the operator opens the local URL, sees the board against live daemon data (empty runs until the producer issue lands), and can triage across PRs at a glance once producer data exists.

```behavior-kind
action-producing
```

```complexity-tier
tier: T2
advisory-prior: T2
```

## Binding surface

### Invariants

- **UI is consumer only** — no review trigger, send, or execute actions unless #214/runtime later exposes explicit daemon **write** routes documented by AO (out of scope for v1; action buttons may be disabled or read-only until producer + API exist).
- **Data source:** #214 runtime board JSON only. **Forbidden:** `packages/web` server routes, `@aoagents/ao-core` review store, `createCodeReviewStore`, `~/.agent-orchestrator`, direct `ao.db` access, `window.ao`.
- **Fork keeps UI, replaces data layer** — port `ReviewDashboard.tsx` and column mapping (`review-types.ts`); reimplement data loading as HTTP client to #214 endpoint.
- **Dead-vocabulary card elements** — upstream card fields that render 0.9-only vocabulary (finding counts, `terminationReason`, etc.) appear **only when** the #214 read interface supplies them; render nullable/absent otherwise — **no fabricated equivalents**.
- **Apache-2.0 obligations:** retain copyright notices, state upstream origin (`ComposioHQ/agent-orchestrator` @ `v0.9.2`), document modifications in a `NOTICE` or README under `tools/**`.
- **Upgrade durability:** no coupling to installed Electron app beyond what #214 already uses (daemon HTTP).
- **Isolation + git safety:** fork/vendor work in **isolated checkout** only; **forbid** force-checkout/reset; completion proof = forked sources in repo + board renders against live stack, not exit code (#304 / delegate incident class).

### UI port strategy (planner freedom within bounds)

Preserve kanban layout, column labels, card fields visible in upstream dashboard, and project filter UX. Internal component library choices (React version, CSS approach) are planner-owned.

## Files in scope

- New UI tree under the same pack tool directory as #214 `(new)` — components ported from upstream `packages/web` with attribution
- `NOTICE` or tool README with Apache-2.0 attribution under `tools/**` `(new)`
- `tests/**` — smoke/render tests with fixture board JSON from #214 `(new)`
- `docs/**` — operator doc: open board URL, relation to #214 server `(updated)`

## Files out of scope

- Aggregation runtime / local server — #214
- Review pipeline producer — #210–#213 series
- Next.js `app/api/reviews/*` routes (removed pattern — do not recreate)
- `send` / `execute` / findings submission wiring (producer + future API)
- CI workflow changes
- `vendor/**`, AO core, `.ao/**`

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
```

```allowed-roots
tools/**
tests/**
docs/**
```

## Acceptance criteria

1. **Fork attribution.** Attribution file under `tools/**` (e.g. tool-tree `NOTICE` or README) cites `ComposioHQ/agent-orchestrator` @ **`v0.9.2`** and Apache-2.0. Upstream license file preserved or referenced.

2. **Column parity.** All **seven** board columns from upstream `REVIEW_BOARD_COLUMNS` @ `v0.9.2` render: `queued`, `reviewing`, `triage`, `waiting`, `clean`, `failed`, `outdated`. Column assignment uses the **#213 0.10→board-column mapping table** applied to 0.10 `prReviewStatus` + `latestRun` fields from the #214 payload — not direct reuse of upstream `getReviewBoardColumn` on 0.9 status enums in the wire.

```producer-emission
producer: orchestrator-pack
datum: review-board-columns
expected: queued,reviewing,triage,waiting,clean,failed,outdated
proof-command: implementation-specific render test asserting seven column headers
```

3. **Data layer replacement.** UI loads board state exclusively from the #214 JSON endpoint. No imports from `@aoagents/ao-core` review store or Next `server-only` data loaders.

```positive-outcome
asserts: with fixture board JSON containing one run per column bucket, rendered output shows seven column headers and one card in each column
input: realistic
```

```producer-emission
producer: orchestrator-pack
datum: reviews-board-ui
expected: kanban-render-from-runtime-json
proof-command: implementation-specific render test with fixture board JSON
red-then-green: must fail if UI imports @aoagents/ao-core review store or calls removed /api/reviews routes
```

4. **Live stack smoke.** Operator doc steps: start #214 server → open UI URL → board renders session sidebar from daemon-backed JSON; `runs` empty today without error banner beyond optional informational empty state.

5. **Forbidden data-source guard.** Static check or test fails if UI code references `/api/reviews`, `createCodeReviewStore`, `getReviewPageData`, `@aoagents/ao-core` review store modules, `window.ao`, `ao.db`, `~/.agent-orchestrator`, or `packages/web` server-route patterns.

```producer-emission
producer: orchestrator-pack
datum: reviews-board-ui
expected: no-forbidden-data-sources
proof-command: implementation-specific static import and string guard on UI bundle
red-then-green: must fail if UI imports @aoagents/ao-core review store, references /api/reviews, window.ao, ao.db paths, or ~/.agent-orchestrator
```

6. **Bundle is local-static.** Production build is static assets emitted into the tool tree and served **only** via the #214 local server's static-asset hook — not a Next.js production server and not new server middleware in this issue.

7. **Isolation contract** documented for any upstream-vendor session: isolated checkout, clean tree, no force git, artifact proof.

8. **Disabled writes (v1).** Trigger/send/execute controls are absent or visibly disabled until producer + documented write API exist — no silent noops that imply success.

## Upgrade-safety check

- UI depends on #214 read contract and static assets only.
- No `app.asar` / Electron bridge.
- No `ao.db` access.

## Verification

1. Render tests with fixture JSON per AC#3.
2. Live smoke per AC#4 (operator doc).
3. Attribution / import guard per AC#1 and AC#5.
4. `pwsh -NoProfile -File scripts/check-draft-discipline.ps1` on this draft.

## Decisions

### Prior art

Extends #214. Upstream UI at `v0.9.2`; data routes intentionally dropped.

### Design analysis (T2 — three UI port options)

**Critical mechanics:** React kanban; poll #214 JSON on interval; map `DashboardReviewRun` rows to cards; sidebar sessions from same payload.

**Options:**

| Option | Cost | Risk | Sufficiency |
| --- | --- | --- | --- |
| **(a) Keep trimmed Next.js app** | Lowest port from upstream | Heavy runtime; Next server deps for local tool | Sufficient but heaviest |
| **(b) Port components to Vite static bundle** | Medium — strip Next router/layout | Some upstream component deps may need shims | **Cheapest sufficient** — aligns with #214 static server |
| **(c) Minimal rewrite — UX skeleton only** | Highest authoring | Drift from upstream triage UX operators know | Sufficient but wastes fork value |

**Land:** Option **(b)** — Vite (or equivalent) static bundle colocated with #214 tool tree; shares dev server or static middleware from #214.

### Tier note

Remains **T2**: UI port + thin data layer swap. Does **not** escalate to T3 — board read interface consumes producer contract without driving producer design.

```contract-evidence
binding-id: orchestrator-pack:review-board-columns:queued,reviewing,triage,waiting,clean,failed,outdated
binding-type: structured
binding: forked UI renders seven kanban columns matching upstream REVIEW_BOARD_COLUMNS semantics
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)
expected: queued,reviewing,triage,waiting,clean,failed,outdated

binding-id: orchestrator-pack:reviews-board-ui:kanban-render-from-runtime-json
binding-type: structured
binding: UI fetches board state only from #214 runtime endpoint and renders kanban from fixture JSON
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)
expected: kanban-render-from-runtime-json

binding-id: orchestrator-pack:reviews-board-ui:no-forbidden-data-sources
binding-type: structured
binding: UI build contains no import of forbidden review data sources (@aoagents/ao-core review store, /api/reviews, window.ao, ao.db, ~/.agent-orchestrator)
producer: orchestrator-pack
evidence: NEW(produced-by AC#5)
expected: no-forbidden-data-sources
```


