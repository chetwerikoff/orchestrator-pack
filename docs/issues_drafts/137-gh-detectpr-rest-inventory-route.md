# gh inventory REST route for AO detectPR argv (scale / quota hygiene)

GitHub Issue: [#443](https://github.com/chetwerikoff/orchestrator-pack/issues/443)

## Prerequisite

- `docs/issues_drafts/131-gh-rest-fallback-on-graphql-quota-exhaustion.md` (GitHub [#431](https://github.com/chetwerikoff/orchestrator-pack/issues/431), **open**) — REST inventory transport baseline; ships `scripts/gh` matcher + REST routes.
- `docs/issues_drafts/136-gh-wrapper-mutual-recursion-terminal-resolution.md` (GitHub [#442](https://github.com/chetwerikoff/orchestrator-pack/issues/442), **open**, **P0**) — terminal `gh` resolution (mutual-recursion OOM). **Ship before this issue.** #442's passthrough smoke explicitly uses detectPR-shaped argv as the `route: null` repro — routing detectPR here **narrows** that passthrough class without regressing #442 terminality.
- `docs/issues_drafts/138-supervisor-children-gh-rest-shim-path.md` (GitHub [#447](https://github.com/chetwerikoff/orchestrator-pack/issues/447), **open**) — supervisor-child inventory argv (no `--repo` scm-github shapes); **sibling, independent, higher priority** than this issue.

**Prior-art verdict:** **Extends #431** — new inventory route class(es) for two upstream argv shapes sharing the same 6-field `prInfoFromView` set (`detectPR` + `resolvePR`). Not supervisor children (#447), not OOM terminality (#442). Steady-state load is modest; this is **scale/quota hygiene** when session count grows. **Lower priority than #447** (real incident PATH fix); independent of #447 (different argv classes).

**Incident note (2026-06-24):** GraphQL exhaustion in production was driven primarily by wrapper mutual recursion (#442), not steady-state detectPR polling. This issue does not claim to close that incident; it removes detectPR from the GraphQL passthrough bucket once #431+#442 land.

## Goal

When AO `ao-plugin-scm-github` calls `detectPR` or `resolvePR` through pack `scripts/gh`, ensure both argv classes REST-route instead of passthrough to native GraphQL — **scale and quota hygiene**, not OOM prevention (#442) and **lower priority than #447** (supervisor-child PATH for the real incident).

```behavior-kind
action-producing
```

## Binding surface

When `gh` is invoked through pack `scripts/gh` with either **scm-github `prInfoFromView` argv class** (verified from installed `@aoagents/ao-plugin-scm-github` `dist/index.js`):

**detectPR** (`dist/index.js:558–569`):
```
gh pr list --repo <owner/repo> --head <branch> --json number,url,title,headRefName,baseRefName,isDraft --limit 1
```

**resolvePR** (`dist/index.js:591–599`) — same 6-field `--json` set, sibling call site:
```
gh pr view <ref> --repo <owner/repo> --json number,url,title,headRefName,baseRefName,isDraft
```

…the pack inventory matcher routes **both** to REST (non-GraphQL), not passthrough. **Choice (architect):** one route family covering both shapes — shared `prInfoFromView` parity fixture (6 fields), marginal extra cost vs leaving a GraphQL hole.

Today `gh-inventory-match.mjs` REST-routes `pr list --head` only when `--head` is sole flag and `--json` is exactly `number`; `pr-view` does not admit `--repo` with this field set. Both argv classes above get `route: null` → GraphQL passthrough.

REST response shaping must expose **gh-CLI field names** the plugin consumes via `prInfoFromView`: `number`, `url`, `title`, `headRefName`, `baseRefName`, `isDraft` — not raw REST names (`head.ref`, `draft`, etc.). Name mismatch fails silently upstream.

**Out of scope:** supervisor-child inventory argv (#447), OOM/terminal resolution (#442), changing AO plugin or `detectPR` cache TTL, batching N+1 `gh api` in reconcile scripts.

**Operator adoption:** none.

## Contract evidence

Upstream argv shape is AO-owned (`ao-plugin-scm-github`); pack binds via **fixture argv list** in verification (not upstream file paths). No capture manifest entry at draft time.

```contract-evidence
none
```

## Files in scope

- `scripts/**` — inventory matcher, REST routes, co-located wrapper tests (same pattern as #431 `scripts/gh-wrapper.test.ts`).

## Files out of scope

- `vendor/**`, `packages/core/**`, Composio AO core, `ao-plugin-scm-github` source.
- Supervisor spawn PATH (#447), `.ao/autonomous-real-binaries.json`.
- Arbitrary `tests/**` outside `scripts/` — only `tests/external-output-references/**` if a capture is added later.

```denylist
vendor/**
packages/core/**
.ao/**
```

Scope boundary note: This denylist is scoped to `137-gh-detectpr-rest-inventory-route`.

```allowed-roots
scripts/**
```

## Acceptance criteria

1. **Both argv classes REST-routed:** Fixture argv for **detectPR** and **resolvePR** (exact shapes above, shared 6-field `--json`) each classify to a REST inventory route, not passthrough — automated matcher classification tests.

```positive-outcome
asserts: detectPR-shaped argv returns JSON array from REST path in wrapper integration test with gh-CLI field names number, url, title, headRefName, baseRefName, isDraft; resolvePR-shaped argv returns JSON object with the same six gh-CLI field names
input: realistic
```

2. **Field-name parity (observable):** Same integration harness asserts wrapper stdout for **both** argv classes exposes all six `prInfoFromView` consumer fields with gh-CLI names — not REST-native keys.

3. **GraphQL independence:** With GraphQL quota exhausted or mocked, **both** argv classes still succeed via REST (test stub acceptable).

4. **#431 / #442 regression:** Existing inventory routes and #442 terminal-resolution behavior unchanged. **#442 coordination:** after this issue merges, #442 passthrough-smoke must use a **different** `route: null` argv than these shapes (e.g. bare `pr view` without this `--json` set, or non-routable verb).

5. **Fixture is SoT:** PR documents exact detectPR **and** resolvePR fixture argv copied from operator's installed `ao-plugin-scm-github` at implementation time; test fixture list is the observable contract if upstream changes.

## Upgrade-safety check

- Pack `scripts/` only; no AO core edits.
- Ships after #431 and #442 merge.
- REST `core` bucket is finite; routing detectPR off GraphQL moves load to `core` — acceptable at steady-state scale, not immunity.

## Verification

### scm-github argv fixtures (verified 2026-06-24 from installed `@aoagents/ao-plugin-scm-github`)

| Source | Exact argv | Matcher today | Target |
|---|---|---|---|
| `detectPR` (`dist/index.js:558–569`) | `pr list --repo <slug> --head <branch> --json number,url,title,headRefName,baseRefName,isDraft --limit 1` | **passthrough** (null) | REST route |
| `resolvePR` (`dist/index.js:591–599`) | `pr view <ref> --repo <slug> --json number,url,title,headRefName,baseRefName,isDraft` | **passthrough** (null) — `pr-view` rejects `--repo` | REST route |
| `prInfoFromView` consumer fields (both) | `number`, `url`, `title`, `headRefName`, `baseRefName`, `isDraft` | — | stdout parity |

### Class enumeration (argv × quota × route)

| Scenario | GraphQL | REST core | Route | Outcome |
|---|---|---|---|---|
| detectPR poll, shim on PATH | exhausted | healthy | REST-routed | **PASS** |
| resolvePR call, shim on PATH | exhausted | healthy | REST-routed | **PASS** |
| detectPR / resolvePR, shim on PATH | healthy | healthy | REST-routed | **PASS** (REST used) |
| either argv, no shim | exhausted | healthy | passthrough | **FAIL** (GraphQL) |
| either argv, shim on PATH | healthy | exhausted | REST-routed | **FAIL** (core limit) |
| existing `pr-list-open` argv | any | any | unchanged | **PASS** (#431 regression) |

### Commands

- `npx vitest run scripts/gh-wrapper.test.ts` — #431 baseline + new detectPR cases.
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/137-gh-detectpr-rest-inventory-route.md`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/137-gh-detectpr-rest-inventory-route.md`
- `pwsh -NoProfile -File scripts/verify.ps1`

## Design analysis (summary)

| Option | Cost | Risk | Sufficient? |
|--------|------|------|-------------|
| A. Extend inventory matcher for detectPR + resolvePR argv classes (one `prInfoFromView` route family) | Low | Low | **Yes** |
| B. Rely on operator `autonomous-real-binaries.json` pin | Zero | High | No |
| C. Upstream AO changes detectPR to simpler argv | Upstream | Out of pack control | Complementary only |

**Ship order:** #431 → #442 → **#447** (supervisor-child PATH — real incident, higher priority) → **#443** (this — backlog hygiene; **independent of #447**, same #431+#442 prerequisites only).
