# REST-route scm-github resolvePR argv (claim-pr) and complete prInfoFromView mapping

GitHub Issue: [#530](https://github.com/chetwerikoff/orchestrator-pack/issues/530)

## Prerequisite

- `docs/issues_drafts/131-gh-rest-fallback-on-graphql-quota-exhaustion.md` (GitHub [#431](https://github.com/chetwerikoff/orchestrator-pack/issues/431), **merged** PR #437) — pack `scripts/gh` inventory classifier + REST routes; baseline transport.
- `docs/issues_drafts/136-gh-wrapper-mutual-recursion-terminal-resolution.md` (GitHub [#442](https://github.com/chetwerikoff/orchestrator-pack/issues/442), **merged**) — terminal `gh` resolution; passthrough must not recurse.
- `docs/issues_drafts/137-gh-detectpr-rest-inventory-route.md` (GitHub [#443](https://github.com/chetwerikoff/orchestrator-pack/issues/443), **closed** PR [#451](https://github.com/chetwerikoff/orchestrator-pack/pull/451)) — **partial ship only:** REST-routed narrow `detectPR` argv (`pr list --head` with `--json number,url --limit 1`). Did **not** ship `resolvePR` (`pr view`) or the full six-field `prInfoFromView` set.

**Prior-art verdict:** **Extends #431 + completes the #443 tail** — same `prInfoFromView` consumer field names, different argv class than #451. Not supervisor-child PATH (#447, merged), not review/merge-verify `pr view` forms (#501, merged), not RCA read allowlist (#520, merged). **Do not reopen #443** — that issue is closed; this draft tracks the remaining inventory gap explicitly.

**Incident note (2026-06-29):** With GraphQL quota exhausted (`remaining: 0`) and REST `core` healthy, `ao spawn --claim-pr <PR>` failed at `scm-github.resolvePR` because `gh pr view … --json number,url,title,headRefName,baseRefName,isDraft` still passthroughs to native GraphQL. Operator unblock required a temporary REST shim in `scripts/gh` until workers could respawn.

## Goal

When AO `ao-plugin-scm-github` resolves a PR reference (`resolvePR`) or looks up a branch PR (`detectPR` with the upstream six-field JSON set) through pack `scripts/gh`, route those argv classes to REST and emit gh-CLI field names the plugin consumes — so `ao spawn --claim-pr` and branch auto-detect survive GraphQL exhaustion.

```behavior-kind
action-producing
```

## Binding surface

When `gh` is invoked through pack `scripts/gh` with either **scm-github `prInfoFromView` argv class** (verified from installed `@aoagents/ao-plugin-scm-github` `dist/index.js`):

**resolvePR** (`dist/index.js:591–599`) — **primary; blocks `claim-pr`:**
```
gh pr view <ref> --repo <owner/repo> --json number,url,title,headRefName,baseRefName,isDraft
```

**detectPR** (full upstream six-field set; extends the narrow #451 route):
```
gh pr list --repo <owner/repo> --head <branch> --json number,url,title,headRefName,baseRefName,isDraft --limit 1
```

…the inventory matcher routes **both** to REST (non-GraphQL), not passthrough. `--repo` on `pr view` must not disqualify routing (`parsed.repo` is separate from `flags`).

REST response shaping must expose **gh-CLI field names** consumed by `prInfoFromView`: `number`, `url`, `title`, `headRefName`, `baseRefName`, `isDraft` — mapping REST `html_url → url`, `head.ref → headRefName`, `draft → isDraft`. Name mismatch fails silently upstream.

**Out of scope:** changing AO plugin source, `detectPR` cache TTL, `gh pr checkout` / merge / edit passthrough, supervisor-child PATH (#447), operator temporary `scripts/gh` bash shims (remove any local unblock once inventory ships).

**Operator adoption:** none.

## Contract evidence

Upstream argv shape is AO-owned (`ao-plugin-scm-github`); pack binds via **fixture argv list** in verification (not upstream file paths). No capture manifest entry at draft time.

```contract-evidence
none
```

## Files in scope

- `scripts/**` — inventory matcher, REST pull→gh JSON mapping, co-located wrapper tests, static inventory guard patterns if needed.

## Files out of scope

- `vendor/**`, `packages/core/**`, Composio AO core, `ao-plugin-scm-github` source.
- `.ao/**`, `agent-orchestrator.yaml` (local).
- Arbitrary `tests/**` outside `scripts/` — only `tests/external-output-references/**` if a capture is added later.

```denylist
vendor/**
packages/core/**
.ao/**
```

Scope boundary note: This denylist is scoped to `169-gh-resolvepr-rest-inventory-route`.

```allowed-roots
scripts/**
```

## Acceptance criteria

1. **resolvePR argv REST-routed:** Fixture argv for **resolvePR** (exact shape above) classifies to a REST inventory route (`pr-view` family or equivalent), not passthrough — automated matcher classification test.

```positive-outcome
asserts: resolvePR-shaped argv returns a JSON object from the REST path with gh-CLI field names number, url, title, headRefName, baseRefName, isDraft
input: realistic
```

2. **detectPR six-field argv REST-routed:** Fixture argv for **detectPR** with the full six-field `--json` set and `--limit 1` classifies to REST (`pr-list-head` or equivalent), not passthrough — automated matcher classification test.

```positive-outcome
asserts: detectPR-shaped argv with six prInfoFromView fields returns a JSON array (length ≤ 1) from REST with the same six gh-CLI field names on each element
input: realistic
```

3. **Field-name parity (observable):** Wrapper integration harness asserts stdout for **both** argv classes exposes all six `prInfoFromView` consumer fields with gh-CLI names — not REST-native keys.

4. **GraphQL independence:** With GraphQL quota exhausted or mocked, **both** argv classes still succeed via REST (test stub acceptable).

5. **#431 / #442 / #451 regression:** Existing inventory routes (including narrow `number,url` detectPR from #451), terminal-resolution behavior, and unrelated `pr-view` field sets (#501) unchanged.

6. **No operator shim left behind:** Any temporary operator REST unblock inserted directly in `scripts/gh` (outside the inventory matcher) is removed when this ships; the inventory route is the only supported path.

## Upgrade-safety check

- Pack `scripts/` only; no AO core edits.
- REST `core` bucket is finite; moving `resolvePR` off GraphQL adds one `GET /pulls/{n}` per claim — acceptable at spawn/claim frequency, not immunity from core limits.
- Ships independently of open worker-recovery drafts (#522/#166); recovery may *call* claim-pr but does not own this transport.

## Verification

### scm-github argv fixtures (verify from operator's installed `@aoagents/ao-plugin-scm-github` at implementation time)

| Source | Exact argv | Matcher today (main) | Target |
|---|---|---|---|
| `resolvePR` | `pr view <ref> --repo <slug> --json number,url,title,headRefName,baseRefName,isDraft` | **passthrough** (null) | REST route |
| `detectPR` (full) | `pr list --repo <slug> --head <branch> --json number,url,title,headRefName,baseRefName,isDraft --limit 1` | **passthrough** (null) | REST route |
| `detectPR` (#451 partial) | `pr list --repo <slug> --head <branch> --json number,url --limit 1` | REST (`pr-list-head`) | unchanged |
| `prInfoFromView` fields | `number`, `url`, `title`, `headRefName`, `baseRefName`, `isDraft` | partial mapping (`url` yes; `headRefName`/`isDraft` missing from mapper base) | stdout parity |

### Class enumeration (argv × quota × route)

| Scenario | GraphQL | REST core | Route | Outcome |
|---|---|---|---|---|
| `ao spawn --claim-pr`, shim on PATH | exhausted | healthy | REST-routed resolvePR | **PASS** |
| branch detectPR poll (6-field), shim on PATH | exhausted | healthy | REST-routed detectPR | **PASS** |
| either argv, shim on PATH | healthy | healthy | REST-routed | **PASS** |
| either argv, no shim | exhausted | healthy | passthrough | **FAIL** |
| #451 narrow detectPR argv | any | any | unchanged REST | **PASS** |
| existing `pr-view` #501 field sets | any | any | unchanged | **PASS** |

### Commands

- `npx vitest run scripts/gh-wrapper.test.ts`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/169-gh-resolvepr-rest-inventory-route.md`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/169-gh-resolvepr-rest-inventory-route.md`
- `pwsh -NoProfile -File scripts/verify.ps1`

## Design analysis (summary)

| Option | Cost | Risk | Sufficient? |
|--------|------|------|-------------|
| A. Extend #431 inventory matcher + `mapPullToGhJson` for both six-field argv classes (one `prInfoFromView` family) | Low | Low | **Yes** |
| B. Leave operator bash shim in `scripts/gh` | Zero now | High — drifts from inventory, untested, breaks passthrough invariants | No |
| C. Upstream AO changes `resolvePR` to `gh api` directly | Upstream | Out of pack control; leaves other `gh` callers exposed | Complementary only |

**Prior art:** #451 chose the minimal detectPR slice (`number,url`) to close #443 quickly; this draft finishes the spec'd `prInfoFromView` parity without re-litigating #431/#442.

**Ship order:** anytime after #431+#442 (both merged); no dependency on #447/#501/#520.
