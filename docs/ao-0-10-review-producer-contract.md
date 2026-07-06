# AO 0.10 review pipeline producer data contract (Issue #626)

Producer commitment for review runs / triage / coverage mapped from AO 0.10 engine state.
Consumer board aggregation (#214) binds against these field names and the board `status` enum.

## Read source (v1, closed)

| Source | Verdict |
| --- | --- |
| Daemon HTTP fan-out (`GET /api/v1/sessions` → per-session `GET …/reviews`, `GET /api/v1/projects`) | **Primary** |
| Read-only `ao.db` | **Rejected for v1** |
| Pack-written sidecar artifact | Optional cache only — must be derivable from API |

Implementation: `scripts/lib/review-producer-contract.ts`

## Producer field contract (#214 board read interface)

| Field group | Fields | Producer source |
| --- | --- | --- |
| Run identity | `id`, `sessionId`, `projectId`, `prUrl`, `targetSha` | `latestRun` + session row; `id` nullable when no `latestRun` (queued). Stable row key = `sessionId` + `prUrl`. |
| Run state | `prReviewStatus`, `latestRunStatus`, `verdict`, `body`, `githubReviewId`, `deliveredAt`, `batchId` | `GET /api/v1/sessions/{id}/reviews` → `PRReviewState` + `latestRun` |
| Worker context | `projectName`, `workerBranch`, `workerPrUrl`, `workerStatus`, `workerActivity`, `workerHasRuntime` | `GET /api/v1/sessions` + `GET /api/v1/projects` |
| Board column | `status` → `queued\|reviewing\|triage\|waiting\|clean\|failed\|outdated` | Mapping table below |

### Session row binding

`GET /api/v1/sessions` row fields:

| API field | Board field | Rule |
| --- | --- | --- |
| `id` | `sessionId` | Direct |
| `projectId` | `projectId` | Direct |
| `branch` | `workerBranch` | Direct |
| `status` | `workerStatus` | Direct |
| `activity` | `workerActivity` | Direct |
| `terminalHandleId` | `workerHasRuntime` | `terminalHandleId !== ""` |
| `prs` | `workerPrUrl` | Set only when exactly one PR URL; nullable when empty or multi-valued |
| `projects[].name` | `projectName` | Join on `projectId` |

**Omitted v1:** `workerTitle`, `workerRuntimeState` — no AO 0.10 source.

## 0.10 → board column mapping

Evaluated by `mapEngineToBoardStatus` in precedence order:

| Engine signal | Board `status` |
| --- | --- |
| `latestRun.status=failed` | `failed` |
| `ineligible` OR head moved vs run `targetSha` | `outdated` |
| `running` (`PRReviewState.status`) | `reviewing` |
| `changes_requested` + `latestRun.deliveredAt` set | `triage` |
| `changes_requested` + not delivered | `waiting` |
| `needs_review`, no `latestRun` | `queued` |
| `up_to_date` / verdict `approved` | `clean` |

## Dead vocabulary (no shims)

| 0.9 field / verb | 0.10 binding |
| --- | --- |
| `terminationReason` | `latestRun.status` + worker `isTerminated` |
| `needs_triage` | `verdict=changes_requested` + delivery state |
| `sentFindingCount` | count delivered `changes_requested` runs |
| `ao review send` | removed — auto-delivery on submit |
| `clean` | `up_to_date` / `approved` |

Producer code must not emit `needs_triage`, `sentFindingCount`, or `terminationReason` as row fields.

## Cross-session coverage

No cross-session `/api/v1/reviews` route. Fleet view = iterate sessions and fan out per-session `/reviews`.

## JSON schema

Machine-readable nullability: `docs/ao-0-10-review-producer-contract.schema.json`

## Capture fixtures

| Variant | Path |
| --- | --- |
| `ao-0-10-daemon/per-session-reviews-populated` | `tests/external-output-references/captures/ao-0-10-daemon/per-session-reviews-populated.raw.json` |
| `ao-0-10-daemon/sessions-list` | `tests/external-output-references/captures/ao-0-10-daemon/sessions-list.raw.json` |
| `ao-0-10-daemon/projects-list` | `tests/external-output-references/captures/ao-0-10-daemon/projects-list.raw.json` |
