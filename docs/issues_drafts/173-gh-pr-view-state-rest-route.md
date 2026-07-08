# REST-route `gh pr view --json state` for AO getPRState fallback

GitHub Issue: [#538](https://github.com/chetwerikoff/orchestrator-pack/issues/538)

## Prerequisite

- `docs/issues_drafts/131-gh-rest-fallback-on-graphql-quota-exhaustion.md` (GitHub [#431](https://github.com/chetwerikoff/orchestrator-pack/issues/431), **closed** PR #437) — pack `scripts/gh` inventory classifier + REST routes. **Already does:** multi-field `pr-view` sets such as `number,headRefOid,baseRefName,state`. **Does not cover:** `gh pr view <n> --json state` alone.
- `docs/issues_drafts/169-gh-resolvepr-rest-inventory-route.md` (GitHub [#530](https://github.com/chetwerikoff/orchestrator-pack/issues/530), **open**) — six-field `prInfoFromView` for `resolvePR` / full `detectPR`. **Out of scope here.**

**Incident note (2026-06-30):** With GraphQL quota exhausted, AO `getPRState` fallback (`gh pr view --json state`) passthroughs to native GraphQL and fails. Classifier probe: `state` alone → `null`; `number,headRefOid,baseRefName,state` → `pr-view` REST. Related follow-up for batch GraphQL churn: `docs/issues_drafts/175-graphql-exhaustion-degraded-poll.md`.

**Prior-art verdict:** **Extends #431** — narrow inventory gap only. Distinct from #530/#531 six-field argv.

## Goal

Route AO `getPRState`'s `gh pr view <n> --repo <slug> --json state` argv through pack REST inventory so the fallback succeeds when GraphQL quota is exhausted.

```behavior-kind
action-producing
```

## Binding surface

Installed `@aoagents/ao-plugin-scm-github` calls (verified 2026-06-30):

```text
gh pr view <n> --repo <owner/repo> --json state
```

No `--jq` in the AO call path — do not require `--jq .state` unless a future verified consumer appears.

`mapPullToGhJson` in `scripts/lib/gh-rest-routes.mjs` already supports `state`; **matcher allowlist** is the missing piece.

**Out of scope:** AO plugin source changes; six-field `prInfoFromView` (#530); GraphQL batch degraded poll (#175).

**Operator adoption:** none (PATH shim only).

## Contract evidence

```contract-evidence
binding-id: orchestrator-pack:gh-inventory:pr-view-state-only-classifier
binding-type: cli-behavior
binding: gh pr view <n> --json state (with --repo) classifies to pr-view REST, not passthrough
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:gh-inventory:pr-view-state-only-execution
binding-type: cli-behavior
binding: gh pr view <n> --json state succeeds via REST with GraphQL quota exhausted in harness, including MERGED enum parity
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)
```

## Files in scope

- `scripts/**` — inventory matcher, REST route mapper if needed, co-located tests.

## Files out of scope

- `vendor/**`, `packages/core/**`, AO plugin source.
- GraphQL degraded-poll transport (#175).

```denylist
vendor/**
packages/core/**
.ao/**
```

```allowed-roots
scripts/**
```

## Acceptance criteria

1. **Classifier:** `gh pr view <n> --json state` with and without `--repo` classifies to `pr-view` REST, not passthrough — automated matcher test.

```producer-emission
producer: orchestrator-pack
datum: gh-inventory
expected: pr-view-state-only-classifier
proof-command: npx vitest run scripts/gh-wrapper.test.ts
```

```positive-outcome
asserts: argv ['pr','view','527','--json','state'] classifies to route id pr-view; mocked REST pull returns JSON containing state with gh-CLI enum (OPEN/CLOSED/MERGED)
input: realistic
```

2. **GraphQL-independent execution:** With GraphQL quota exhausted or mocked, `gh pr view <n> --json state` succeeds via REST and emits only `state` with gh-CLI enum parity including **`MERGED`** (merged PR must not collapse to bare `CLOSED`).

```producer-emission
producer: orchestrator-pack
datum: gh-inventory
expected: pr-view-state-only-execution
proof-command: npx vitest run scripts/gh-wrapper.test.ts
```

```positive-outcome
asserts: under GraphQL-exhausted harness, state-only pr-view returns {"state":"OPEN"} for an open PR and {"state":"MERGED"} for a merged PR fixture without invoking api.github.com/graphql
input: capture-backed
```

3. **Regression:** Existing `pr-view` allowed field sets (#431, #501, #530 six-field when shipped) unchanged.

## Upgrade-safety check

- Pack `scripts/` only.
- Adds one REST `GET /pulls/{n}` per `getPRState` fallback call — bounded by AO poll cadence × open PR count; does not replace repo-wide REST budgeting.

## Verification

| Scenario | Route | Outcome |
|---|---|---|
| `gh pr view <n> --json state` shim on PATH, GraphQL exhausted | `pr-view` REST | **PASS** |
| `gh pr view <n> --json state` no shim, GraphQL exhausted | passthrough | **FAIL** (unchanged) |
| Existing multi-field `pr-view` sets | unchanged | **PASS** |

### Commands

- `npx vitest run scripts/gh-wrapper.test.ts`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/173-gh-pr-view-state-rest-route.md`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/173-gh-pr-view-state-rest-route.md`
- `pwsh -NoProfile -File scripts/verify.ps1`

## Design analysis (summary)

| Option | Cost | Risk | Sufficient? |
|--------|------|------|-------------|
| A. Add `['state']` to `pr-view` allowlist + mapper parity | Low | Low | **Yes** for `getPRState` fallback |
| B. Change AO plugin to use multi-field argv | Upstream | Out of pack control | No |
| C. Temp bash shim in `scripts/gh` | Zero now | Violates #532 | No |

**Chosen:** A. Ships independently; pairs with #175 for batch GraphQL churn but does not block it.
