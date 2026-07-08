# GraphQL-exhaustion degraded poll at pack `scripts/gh`

GitHub Issue: [#540](https://github.com/chetwerikoff/orchestrator-pack/issues/540)

## Prerequisite

- `docs/issues_drafts/131-gh-rest-fallback-on-graphql-quota-exhaustion.md` (GitHub [#431](https://github.com/chetwerikoff/orchestrator-pack/issues/431), **closed**) — REST inventory for known reads; passthrough `gh api graphql` unchanged.
- `docs/issues_drafts/170-orchestrator-command-runtime-bootstrap-contract.md` (GitHub [#532](https://github.com/chetwerikoff/orchestrator-pack/issues/532), **closed**) — no temp shims / agent `gh api graphql` workarounds.
- `docs/issues_drafts/173-gh-pr-view-state-rest-route.md` (GitHub [#538](https://github.com/chetwerikoff/orchestrator-pack/issues/538)) — **sibling;** fixes `getPRState` REST fallback. This issue fixes **batch/review-thread GraphQL subprocess churn** while quota is zero.

**Incident note (2026-06-30):** AO lifecycle `enrichSessionsPRBatch` invokes `gh api graphql` every ~30–60s; with GraphQL exhausted, every tick fails and retries with no backoff. `getReviewThreads` repeats the pattern. Phase 1 REST route (#538) does not stop this churn.

**Prior-art verdict:** **Genuinely new** — transport degraded-mode at `scripts/gh` passthrough boundary. Distinct from fleet cache (#453) and conditional REST hard gate (#142).

## Goal

When **primary GraphQL quota** is exhausted, pack `scripts/gh` must suppress repeated network `gh api graphql` attempts until `resources.graphql.reset`, emit operator-visible audit distinguishing suppressed attempts from real GraphQL HTTP, and **never fake successful GraphQL data**. Review-thread and batch enrichment remain **functionally degraded** until quota resets.

```behavior-kind
action-producing
```

## Binding surface

### Degraded-mode invariants

- **Arming triggers (only):**
  - REST `gh api rate_limit` shows `resources.graphql.remaining == 0` with primary-quota semantics; or
  - A live passthrough `gh api graphql` failure whose stderr/exit unambiguously indicates **primary GraphQL quota exhaustion** (`graphql_rate_limit`, primary 403 quota class).
- **Explicit non-triggers (must NOT arm degraded mode):**
  - Secondary / abuse rate limits
  - Auth errors (401/403 non-quota)
  - Network / timeout / DNS failures
  - GraphQL validation / query errors
  - Non-GitHub stderr pollution
  - Malformed wrapper output unrelated to primary quota
- **Cache file:** shared **across subprocess invocations** (AO spawns fresh `gh` each call). Partition key = **GitHub API host + credential rate-limit context**. The fingerprint must match the **actual** GraphQL quota bucket the call would consume — prefer a **non-secret hash or stable token identity** derived from the active `gh` credential (never store raw tokens). Login-only fingerprints (e.g. `gh auth status` user login) are acceptable **only** when verified that the producer quota is user-scoped for that host; otherwise use token-identity partitioning. One exhausted context must not poison another.
- **Cache integrity:** atomic write (write-temp + rename). Malformed, stale-lock, or partial files → deterministic recovery: discard and re-arm only from a fresh qualifying trigger (fail closed, no unbounded retry loop).
- **While degraded:** no network GraphQL until `resources.graphql.reset` epoch elapses; refresh `rate_limit` via REST **≤ 1 per 60s per partition key** across all subprocesses.
- **Telemetry:** operator-visible audit/log event (ndjson or stderr label such as `graphql_degraded_fail_fast`) distinguishing suppressed post-exhaustion attempts from real GraphQL HTTP — documented in `docs/migration_notes.md`.
- **No fake success:** suppressed calls exit non-zero with stable primary-quota exhaustion diagnostic; AO stays degraded until real quota returns.

**Out of scope:**

- Full REST replacement for AO `BatchPRs` or `getReviewThreads` (upstream / separate issue).
- Rewriting GraphQL query text.
- Agent-facing `gh api graphql` workarounds (#532).

**Operator adoption (operator-only — agents must NOT run `ao stop` / `ao start`):** after merge, operator restarts AO so daemon PATH picks up `scripts/gh` changes.

## Contract evidence

```contract-evidence
binding-id: orchestrator-pack:gh-transport:graphql-exhaustion-fail-fast
binding-type: cli-behavior
binding: primary GraphQL quota exhaustion arms partitioned cross-subprocess cache; subsequent passthrough gh api graphql suppresses without network GraphQL until resources.graphql.reset; non-primary errors do not arm; rate_limit refresh <=1 per 60s per partition
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)
```

## Files in scope

- `scripts/**` — `gh` wrapper degraded gate, cache read/write, tests, static guards if needed.
- `docs/migration_notes.md` — operator adoption + telemetry note.

## Files out of scope

- `vendor/**`, `packages/core/**`, AO core / plugin source.
- State-only `pr-view` inventory (#538).

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
```

```allowed-roots
scripts/**
docs/**
```

## Acceptance criteria

1. **Arm from live primary-quota failure:** Harness simulates first passthrough `gh api graphql` returning primary-quota exhaustion; shared partitioned cache arms; second **separate `gh` subprocess** suppresses without network GraphQL; operator-visible audit event recorded.

```producer-emission
producer: orchestrator-pack
datum: gh-transport
expected: graphql-exhaustion-fail-fast
proof-command: npx vitest run scripts/gh-wrapper.test.ts
```

```positive-outcome
asserts: live primary-quota 403 on first graphql passthrough arms partitioned cache; second gh subprocess suppresses without api.github.com/graphql; stderr indicates primary quota exhaustion; operator-visible audit event emitted
input: realistic
```

2. **Reset allows passthrough:** After `resources.graphql.reset` elapses (or harness refresh shows `remaining > 0`), passthrough `gh api graphql` attempts network again.

3. **Non-triggers do not arm:** Fixtures for secondary limit, auth error, network timeout, GraphQL validation error, and unrelated stderr do **not** enter degraded mode or suppress subsequent legitimate passthrough.

4. **Cross-subprocess rate_limit cadence:** ≥3 separate `gh` subprocesses with suppressed `gh api graphql` within 60s share one partition cache and cause ≤1 upstream `rate_limit` network call.

5. **Cache corruption recovery:** Malformed cache file → deterministic discard; degraded mode re-arms only from a fresh qualifying trigger.

6. **Partition isolation:** Exhausted partition A does not suppress partition B when fixtures differ by host **or** by credential rate-limit context (e.g. distinct token-identity fingerprints, not login-only unless user-scoped quota is proven for that fixture).

7. **No fake success:** Suppressed invocations never return synthetic GraphQL success bodies.

8. **#532 guard:** No new agent-facing `gh api graphql` workaround instructions.

## Upgrade-safety check

- Pack `scripts/` only; no AO core edits.
- Fail-fast stops wall-clock churn; does not restore batch/review functionality while GraphQL is zero.
- `rate_limit` refresh bounded to ≤1/60s/partition — does not spam REST `core`.
- Composes with #538; does not replace repo-wide REST budgeting (#142).

## Verification

### Scenario matrix

| Scenario | Arms degraded? | Network GraphQL? | Outcome |
|---|---|---|---|
| Primary quota 403 on first call | yes | suppressed after | **PASS** |
| `remaining == 0` from rate_limit | yes | suppressed | **PASS** |
| Secondary/abuse limit | no | normal passthrough behavior | **PASS** — no false arm |
| Auth / network / validation error | no | not suppressed by degraded cache | **PASS** |
| Reset elapsed / `remaining > 0` | clears | allowed | **PASS** |
| Wrong partition key | no cross-poison | — | **PASS** |

### Commands

- `npx vitest run scripts/gh-wrapper.test.ts`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/175-graphql-exhaustion-degraded-poll.md`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/175-graphql-exhaustion-degraded-poll.md`
- `pwsh -NoProfile -File scripts/verify.ps1`

## Design analysis (summary)

| Option | Cost | Risk | Sufficient? |
|--------|------|------|-------------|
| A. Fail-fast + partitioned cache at `scripts/gh` passthrough | Medium | Medium — must not false-arm | **Yes** for churn class |
| B. Upstream AO backoff in core | High | Out of pack control | Complementary |
| C. Full REST batch replacement | Very high | AO core | Out of scope |

**Chosen:** A. Review threads stay functionally degraded; no fake GraphQL data.

## Decisions

- **Separate from #538:** inventory route is small and can merge first; degraded poll is broader transport contract.
- **Cross-subprocess cache required:** in-process memory insufficient for AO's per-call `gh` spawns.
- **Operator-only restart:** agents must not run `ao stop` / `ao start`.
