# AO 0.10 review pipeline producer data contract (board and consumers)

GitHub Issue: #626

## Prerequisite

- `docs/issues_drafts/210-ao-010-review-harness-and-trigger-loop.md` (GitHub Issue: TBD) — populates `review_run` rows and per-session `/reviews` payloads.
- `docs/issues_drafts/212-ao-010-review-pipeline-vocabulary-migration.md` (GitHub Issue: TBD) — maps dead 0.9 fields to 0.10 `status`+`verdict` vocabulary used below.
- **Sibling consumer (binds against this contract):** `docs/issues_drafts/214-ao-reviews-board-runtime-aggregation.md` — board read interface table is normative for field names; this issue is the **producer** commitment.
- AO 0.10 per-session API: `GET /api/v1/sessions/{id}/reviews` → `{reviewerHandleId, reviews: PRReviewState[]}` where `PRReviewState` includes `prUrl`, `targetSha`, `status` (`needs_review|running|up_to_date|changes_requested|ineligible`), `latestRun` (`domain.ReviewRun` with `id`, `batchId`, `verdict`, `body`, `githubReviewId`, `deliveredAt`, `status`, …) — `review/planner.go:25-33`, `domain/review.go:30-56`.
- Prior-art verdict: **Genuinely new** producer contract for 0.10. #214 defines consumer shape; this draft binds producer emission.

## Goal

Publish and implement the **producer data contract** — which fields the pack pipeline guarantees for review runs / triage / coverage, how they map from AO 0.10 engine state, and **where consumers read them** (daemon API fan-out primary; no false-equivalence shims). Enable #214/#215 to aggregate populated `runs` without guessing producer semantics.

```behavior-kind
action-producing
```

```complexity-tier
tier: T2
advisory-prior: T2
```

## Binding surface

### Read source decision (closed for v1)

| Source | Verdict |
| --- | --- |
| **Daemon HTTP fan-out** (`GET /sessions` → per-session `GET …/reviews`) | **Primary** — matches #214; upgrade-durable |
| Read-only `ao.db` | **Rejected for v1** — schema-coupled (WAL safe but unversioned) |
| Pack-written sidecar artifact | **Optional cache only** — must be derivable from API; not sole source |

### Producer field contract (aligned with #214 board read interface)

Minimum per-run fields consumers may rely on after #210+#212 land:

| Field group | Fields | Producer source |
| --- | --- | --- |
| Run identity | `id`, `sessionId`, `projectId`, `prUrl`, `targetSha` | `latestRun` + session row (`id`→`sessionId`, `projectId` from session); `id` **nullable** when no `latestRun` (queued) — stable row key = `sessionId` + `prUrl` from `PRReviewState` |
| Run state | `prReviewStatus`, `latestRun.status`, `verdict`, `body`, `githubReviewId`, `deliveredAt`, `batchId` | `GET /api/v1/sessions/{id}/reviews` → `PRReviewState` + `latestRun` (`domain.ReviewRun`) |
| Worker context | `projectName`, `workerBranch`, `workerPrUrl`, `workerStatus`, `workerActivity`, `workerHasRuntime` | `GET /api/v1/sessions` + `/projects` |
| Board column | derived board `status` → `queued\|reviewing\|triage\|waiting\|clean\|failed\|outdated` | **Mapping table below** — producer owns translation from 0.10 engine enums |

**Session row binding (verified 2026-07-06):** `GET /api/v1/sessions` returns `activity`, `branch`, `createdAt`, `harness`, `id`, `isTerminated`, `kind`, `projectId`, `prs`, `status`, `terminalHandleId`, `updatedAt`. Map `branch`→`workerBranch`, `status`→`workerStatus`, `activity`→`workerActivity`, `terminalHandleId`≠`""`→`workerHasRuntime` (derived). **`workerPrUrl`:** optional sidebar hint from session `prs` when exactly one PR URL is present; **nullable** when `prs` is empty or multi-valued — per-run `prUrl` from `PRReviewState` is authoritative for board rows. **No source** for `workerTitle` or `workerRuntimeState` — omitted from v1 contract (consumers render nullable/absent).

### 0.10 → board column mapping (producer-owned)

Engine `PRReviewState.status` + `latestRun` drive board rows. Producer / aggregator applies:

| Engine signal | Board `status` (v0.9.2 enum) |
| --- | --- |
| `needs_review`, no `latestRun` | `queued` |
| `running` | `reviewing` |
| `changes_requested` + `latestRun.deliveredAt` set | `triage` |
| `changes_requested` + not delivered | `waiting` |
| `up_to_date` / verdict `approved` | `clean` |
| `latestRun.status=failed` | `failed` |
| `ineligible` OR head moved vs run `targetSha` | `outdated` |

Open: exact `waiting` vs `triage` split when delivery pending — bind to `deliveredAt` + `latestRun.status` as above; #214 fixture tests use this table.

### Dead vocabulary mapping (no shims)

| 0.9 field / verb | 0.10 binding |
| --- | --- |
| `terminationReason` | **no 1:1** — use `latestRun.status` + worker `isTerminated` |
| `needs_triage` | `verdict=changes_requested` + delivery state |
| `sentFindingCount` | count `delivered` `changes_requested` runs |
| `ao review send` | **gone** — auto-delivery on submit |
| `clean` | `up_to_date` / `approved` |

### Cross-session coverage (Gap #3)

Producer contract includes **fan-out obligation**: consumers may reconstruct fleet view only by iterating sessions — no cross-session `/api/v1/reviews` route (404 verified 2026-07-06). Producer does not add such a route; #214 aggregates.

## Files in scope

- Documented schema / mapping module under `docs/**` or `scripts/lib/**` `(new)`
- `tests/**` — mapping fixture tests for each board column `(new)`
- `tests/external-output-references/**` — populated per-session `/reviews` captures `(new)`

## Files out of scope

- Board aggregation server — #214
- UI fork — #215
- Trigger / reaper implementation — #210 / #211
- `vendor/**`, AO core

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

```allowed-roots
docs/**
scripts/**
tests/**
tests/external-output-references/**
```

## Acceptance criteria

1. **Contract document.** Checked-in mapping table (this draft's tables) plus JSON schema or TypeScript types listing every #214 board field with nullability rules.

2. **Populated capture.** Committed `per-session-reviews-populated` capture with at least one non-empty `latestRun` exercising `running`, `changes_requested`, and `up_to_date` shapes.

```producer-emission
producer: orchestrator-pack
datum: ao-0-10-daemon-capture
expected: per-session-reviews-populated
proof-command: node scripts/external-output-shape-guard.mjs --variant ao-0-10-daemon/per-session-reviews-populated
```

2b. **Session and project source captures.** Committed `sessions-list` and `projects-list` captures under `tests/external-output-references/captures/ao-0-10-daemon/**` scrubbed per #223 — verify worker-context field sources (`branch`, `status`, `activity`, `prs`, `terminalHandleId`, `projectName`) match the contract table.

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

3. **Column mapping tests.** Fixture per engine state row → expected board `status` for all seven columns (#214 enum). Proof via checked-in mapping module unit test (planner-owned test file under `tests/**`).

```positive-outcome
asserts: parameterized mapping fixtures cover all seven engine→board rows in the mapping table with expected board status for each
input: realistic
```

```producer-emission
producer: orchestrator-pack
datum: review-board-column-mapping
expected: engine-to-board-status-table
proof-command: implementation-specific mapping unit test (vitest or node test runner) asserting all seven rows; red-then-green must fail if changes_requested+deliveredAt maps to waiting instead of triage
red-then-green: must fail if changes_requested+deliveredAt maps to waiting instead of triage
```

4. **No false-equivalence fields.** Static guard: producer/mapping code does not emit `needs_triage`, `sentFindingCount`, or `terminationReason` as pseudo-0.10 fields.

```producer-emission
producer: orchestrator-pack
datum: review-producer-contract
expected: no-false-equivalence-fields
proof-command: implementation-specific static string/import guard on mapping module and producer path
red-then-green: must fail if needs_triage, sentFindingCount, or terminationReason appear as emitted field names
```

5. **API-only source.** Producer path does not read `ao.db` for consumer-facing fields in v1.

```producer-emission
producer: orchestrator-pack
datum: review-producer-contract
expected: api-only-no-aodb-read
proof-command: implementation-specific static guard or fixture replay proving mapping path issues only GET /api/v1/* calls
red-then-green: must fail if producer reads ao.db for consumer-facing fields
```

## Upgrade-safety check

- Contract anchored on `/api/v1` shapes with capture-backed guards (#223 lineage).

## Verification

1. Mapping unit tests for seven board columns.
2. Shape guard on populated capture.
3. Discipline checks.

## Decisions

### Design analysis

| Option | Cost | Risk | Sufficiency |
| --- | --- | --- | --- |
| **(a) API fan-out only** | HTTP chatter | None schema | **Land** — matches #214 |
| **(b) ao.db read model** | Low HTTP | Migration breaks | Rejected v1 |
| **(c) Dual-write sidecar** | High drift | Two sources | Rejected |

```contract-evidence
binding-id: orchestrator-pack:ao-0-10-daemon-capture:per-session-reviews-populated
binding-type: structured
binding: committed capture replays populated GET /api/v1/sessions/{id}/reviews shape
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)
expected: per-session-reviews-populated

binding-id: orchestrator-pack:review-board-column-mapping:engine-to-board-status-table
binding-type: structured
binding: producer mapping emits all seven v0.9.2 board statuses from 0.10 engine signals
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)
expected: engine-to-board-status-table
```


