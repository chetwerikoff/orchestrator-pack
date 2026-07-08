# Autonomous review retry after recoverable review-infrastructure failure

GitHub Issue: #539

## Prerequisite

- `docs/issues_drafts/24-ao-review-preflight-and-failed-run-discipline.md` (GitHub #60, closed) — failed/cancelled zero-finding runs are not clean coverage; retry must stay inside failed-run discipline.
- `docs/issues_drafts/65-orchestrator-no-rereview-covered-head.md` (GitHub #189, closed) — covered-terminal and in-flight runs block duplicate starts; failed/cancelled runs remain uncovered.
- `docs/issues_drafts/91-review-run-crash-safe-terminal-status.md` (GitHub #287, closed) — stuck non-terminal runs are terminalized so failed-run retry can proceed; this issue does not replace liveness recovery.
- `docs/issues_drafts/101-reviewer-failure-evidence-log.md` (GitHub #312, closed) — persists bounded reviewer failure evidence sidecars.
- `docs/issues_drafts/103-llm-turn-review-start-claimed-gate.md` (GitHub #318, closed) — autonomous review starts must use the claimed review entrypoint, not raw `ao review run`.
- `docs/issues_drafts/145-codex-reviewer-time-budget-and-timeout-escalation.md` (GitHub #461, closed) — ships `timeout_no_verdict` classification and a bounded same-head retry cap at review-start decision points for **post-run** failed/cancelled outcomes.
- `docs/issues_drafts/164-review-start-readiness-envelope-external-io-accounting.md` (GitHub #515, closed) and `docs/issues_drafts/165-review-start-envelope-cross-attempt-ledger-and-escalation.md` (GitHub #516, closed) — own **pre-launch** review-start envelope/infra transport failures and `consecutiveFailureCount`. **This draft consumes #516 for pre-launch classes; it does not add a second counter for the same stall.**
- `docs/issues_drafts/171-review-start-supervised-gh-pid-param-regression.md` (GitHub #534, **open**) — deterministic reconcile-tick bind regression; **prerequisite / incident example only**. After #534 lands, the next reconcile tick works; before fix, autonomous retry cannot help. Not a failure class this issue models.

**Prior-art verdict:** new sibling draft closing the **post-run** autonomous-recovery gap left by #461. Verified PR #528/opk-90: `timeout_no_verdict` existed in #312 sidecar evidence, but pack gates reading `ao review list` via `Get-AoReviewRuns` could not classify the failed run and denied bounded retry. Worker recovery (#522 / draft 166) is adjacent and out of scope.

## Goal

For a review-ready worker on the current PR head, give the autonomous orchestrator one narrow, auditable, bounded path to re-attempt review after **recoverable post-run reviewer-infrastructure failures** (especially `timeout_no_verdict`) — without operator terminal intervention — while still escalating true empty-review traps and non-recoverable outcomes after the retry budget is exhausted.

**Out of scope for this issue:** pre-launch review-start envelope/transport retry and escalation — already #515/#516. Deterministic regressions such as #534 — fix there, not here.

```behavior-kind
action-producing
```

## Binding surface

### Lifecycle split (load-bearing)

| Lifecycle | Owner | This issue |
|---|---|---|
| Pre-launch claim/preflight/transport failure (no `ao review run` yet) | #515 / #516 `consecutiveFailureCount` | **Consume only** — do not define a parallel ledger |
| Post-run `failed` / `cancelled` reviewer outcome on a head | #461 timeout cap + this issue | **Own** enrichment, classification, retry eligibility, shared decision result |

### Pack-owned enriched review-run view

Pack code loads runs through `ao review list` (e.g. `Get-AoReviewRuns` in `scripts/lib/Invoke-AoCliJson.ps1`). **Raw AO core run JSON may remain unchanged.**

This issue requires a **pack-owned normalized/enriched review-run view** consumed by all retry gates to expose, for each failed/cancelled run under consideration:

- `failureClass` (taxonomy below or `unknown`);
- `retryEligible` (from post-run retry ledger + #461 cap);
- `escalationReason` when exhausted.

Enrichment joins shipped #312 sidecar evidence only under the stale-link rules below. Gates (`orchestrator-claimed-review-run`, `review-wake-trigger`, `review-head-ready`, `codex-reviewer-timeout-retry`) must consume this enriched view — not ad hoc per-surface sidecar scraping.

**Incident PR #528 correction:** `opk-rev-1134` had `timeout_no_verdict` in `reviewer-failure-evidence/opk-rev-1134.json`, but enriched input to gates lacked `failureClass` because classification was not centralized — autonomous retry was denied.

### Post-run failure taxonomy

Only explicitly classified **recoverable transient reviewer infra** failures may receive autonomous same-head retry.

| Class | Meaning | Autonomous retry |
|---|---|---|
| `timeout_no_verdict` | Reviewer budget elapsed before verdict (#461) | Yes, bounded (reuse #461 cap) |
| `reviewer_process_crash` | Abnormal wrapper exit with zero findings **only when classifier proves transient infra** (#312) | Yes, bounded |
| `workspace_preflight_transient` | Workspace preflight failed for **transient env/infra** reasons only | Yes, bounded |
| `empty_output` / `malformed_output` | Unusable reviewer payload (#9) | **No** — empty-review trap |
| `auth_failure` | Auth / credential / permission failure | **No** — operator action |
| `quota_exceeded` / `usage_limit` | Rate/quota exhaustion | **No** — operator/backoff |
| `config_error` | Misconfiguration requiring operator fix | **No** |
| `dependency_missing` | Missing binary/deps/env the worker cannot self-heal | **No** |
| `unknown` | No trustworthy structured evidence | **No** — fail closed |

Immediate escalation (no autonomous retry) also remains required for: unsent findings (`ao review send`, not retry); repeated same-head same-class failures after budget; any non-transient crash/preflight class above.

### #312 sidecar join safety

Sidecar join is allowed only when linkage is **fresh and consistent**. Reject (treat as `unknown`, fail closed) when any holds:

- stale or missing by-run pointer;
- reviewer session id reused across unrelated runs;
- run fingerprint mismatch between run record and sidecar;
- PR number or normalized head SHA mismatch.

### Retry budget identity

Post-run retry state is keyed by **`(project, PR number, normalized head SHA, failureClass)`**. Reviewer session id, model, and command variant are diagnostic only — a new head SHA resets the relevant budget.

### Shared decision result (not duplicate launchers)

Existing start surfaces must consume the **same enriched classifier + post-run retry decision**:

- completion wake / `review-wake-trigger`;
- `review-trigger-reconcile` (for post-run failed/cancelled heads only);
- orchestrator turn via `scripts/invoke-orchestrator-claimed-review-run.ps1`;
- report-state / head-ready backstops.

All retries launch only through the claimed review entrypoint (#318). Raw autonomous `ao review run` from an LLM turn remains denied.

Surfaces that are thin wrappers around the same primitive need not each carry duplicate fixtures — see AC#2.

### Cooldown / storm prevention

Per `(PR, head, failureClass)` for **post-run** classes:

- minimum cooldown between autonomous retries (planner chooses; >0 for reconcile/wake);
- cap automatic retries (default: one retry after first counted failure; compose with #461 for `timeout_no_verdict`);
- concurrent deciders converge via existing review-start claim — no duplicate reviewer storm.

### Escalation after exhaustion

When post-run retry budget is exhausted, emit operator-visible escalation distinguishing:

- **`infra_no_trustworthy_verdict`** — reviewer infrastructure failed; manual retry may be appropriate;
- **`clean_review`** / **`needs_triage`** — do not use infra escalation wording;

Include PR, head SHA, failure class, attempt count, last run id, and cap. Operator message must say infra failure, not "review passed".

### Manual operator path after exhaustion

Operator one-off retry via `scripts/invoke-manual-review-run.ps1` with explicit **operator provenance**, audited separately from autonomous retry counters. Manual override may bypass autonomous budget but must not be invocable from autonomous LLM turns (#318).

### Interaction with `needs_triage` and sent findings

`needs_triage` or unsent findings → **`ao review send`**, not a new review run.

### Interaction with covered-head dedupe

Failed/cancelled runs are not clean coverage (#60/#189). Retry only through failed-run discipline + shared claim lifecycle.

### Design analysis

**Critical mechanics.** #461 added `timeout_no_verdict` counting but gates still read thin `ao review list` rows. PR #528 showed enrichment/classification must be pack-owned and centralized. Pre-launch stalls belong to #516 — duplicating that ledger here would create two counters for one reconcile stall.

**Architecture sketch.**

```text
ao review list (raw, AO-owned)
        |
        v
pack enricher (join #312 when linkage fresh)
        |
        v
post-run classifier + retry ledger (PR, head, failureClass)
        |
        +-- non-retryable / unknown ----> escalate
        |
        +-- recoverable post-run infra
                |
                +-- under budget --> shared decision: claimed review start
                +-- exhausted -----> retry_bound_exhausted + infra escalation

(pre-launch transport/envelope --> #516 only; not this path)
```

**Options.**

| Option | Cost | Risk | Sufficient |
|---|---:|---:|---|
| Require AO core run JSON schema change | High | Forbidden core patch | No |
| Pack-owned enricher + shared post-run classifier/decision | Medium | Must fixture sidecar stale-link rejection | **Yes** |
| Re-open #461 for terminationReason text only | Low | Leaves enrichment gap; PR #528 class persists | No |
| Second ledger for pre-launch + post-run | Medium | Double-count with #516 | No |

Chosen: pack-owned enrichment + post-run retry decision reused by existing surfaces. Pre-launch stays #516.

## Files in scope

- `scripts/**` — enricher at `Get-AoReviewRuns` / shared classifier path, retry ledger, gate consumers, manual wrapper audit hooks.
- `docs/**` — shared classifier modules, `docs/migration_notes.md` operator notes, fixtures.
- `tests/external-output-references/**` — capture fixtures if needed.

## Files out of scope

- `vendor/**`, `packages/core/**`, `.ao/**`, AO core run JSON schema changes
- `prompts/**` (operator guidance via `docs/migration_notes.md` only)
- Pre-launch envelope ledger semantics (#515/#516 re-litigation)
- #534 implementation (prerequisite only)
- Worker worktree cleanup / respawn (#522 / draft 166)
- Raw `ao review run` from autonomous LLM turns
- GraphQL/REST transport inventory (#168/#173)

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
prompts/**
```

```allowed-roots
scripts/**
docs/**
tests/external-output-references/**
```

## Acceptance criteria

1. **Pack-owned enriched view exposes classification fields.** Fixture mirroring PR #528 (`timeout_no_verdict` in #312 sidecar, generic `terminationReason` on raw `ao review list` row) proves the **pack enricher output** consumed by gates exposes `failureClass`, `retryEligible`, and (when applicable) `escalationReason` — without requiring new fields on raw AO core JSON. Same fixture proves first bounded autonomous retry for `timeout_no_verdict`.

```producer-emission
producer: orchestrator-pack
datum: autonomous-review-retry
expected: failure-class-on-enriched-view
proof-command: npm test -- autonomous-review-retry
```

2. **Shared classifier + independent launcher integration.** Exhaustive unit/fixture coverage of the shared post-run classifier and retry-ledger decision. Plus **one integration fixture per actually independent launcher path** that reaches `ao review run` (not one per thin wrapper). All integrations must show the same shared decision result before launch.

```producer-emission
producer: orchestrator-pack
datum: autonomous-review-retry
expected: shared-ledger-autonomous-retry
proof-command: npm test -- autonomous-review-retry
```

3. **Repeated same-head same-class failure over budget denies launch** with `retry_bound_exhausted` and `escalationReason` visible to operators.

```producer-emission
producer: orchestrator-pack
datum: autonomous-review-retry
expected: retry-bound-exhausted-escalation
proof-command: npm test -- autonomous-review-retry
```

4. **New head resets retry budget.**

5. **`needs_triage` with unsent findings routes to send, not retry.**

6. **Unknown/malformed evidence fails closed.** Missing classification and no fresh sidecar does not auto-retry.

7. **Non-retryable post-run classes fail closed.** Fixtures for `auth_failure`, `quota_exceeded` / `usage_limit`, `config_error`, and `dependency_missing` do not receive autonomous retry even when zero findings.

8. **#312 sidecar stale-link rejection.** Fixtures prove join rejection (fail closed → `unknown`) for: stale/missing by-run pointer; reused reviewer session across unrelated runs; run fingerprint mismatch; PR/head mismatch. Fresh consistent linkage still classifies PR #528-shaped `timeout_no_verdict`.

```producer-emission
producer: orchestrator-pack
datum: autonomous-review-retry
expected: sidecar-stale-link-rejected
proof-command: npm test -- autonomous-review-retry
```

9. **In-flight or covered-terminal run blocks duplicate retry.** #189 precedence preserved.

10. **Raw autonomous `ao review run` remains denied** from LLM turn (#318).

```producer-emission
producer: orchestrator-pack
datum: autonomous-review-retry
expected: no-raw-ao-review-run
proof-command: npm test -- autonomous-review-retry
```

11. **Manual operator retry is audited separately** — manual wrapper can force one start after autonomous exhaustion without resetting autonomous ledger counters.

```producer-emission
producer: orchestrator-pack
datum: autonomous-review-retry
expected: manual-operator-audit-separate
proof-command: npm test -- autonomous-review-retry
```

12. **Pre-launch failures stay on #516.** Fixture or static guard proves this issue does not increment a second pre-launch counter for `infra_transport` / envelope terminals already counted by #516.

```positive-outcome
asserts: on PR #528-class incident (review-ready worker, failed zero-finding post-run run with recoverable `timeout_no_verdict` evidence, CI green on current head), pack enrichment classifies the failure and the orchestrator autonomously performs one bounded claimed-review retry without operator terminal intervention; auth/quota/config/unknown classes do not auto-retry; after repeated same-class failure the system emits distinct infra escalation without review storm
input: realistic
```

## Contract evidence

```contract-evidence
binding-id: orchestrator-pack:autonomous-review-retry:failure-class-on-enriched-view
binding-type: structured
binding: pack-owned enriched review-run view consumed by gates exposes machine-readable failureClass retryEligible and escalationReason without requiring AO core JSON schema changes
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:autonomous-review-retry:shared-ledger-autonomous-retry
binding-type: structured
binding: first recoverable post-run infra failure on a head yields one autonomous claimed-review retry via shared classifier decision across independent launcher paths
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)

binding-id: orchestrator-pack:autonomous-review-retry:retry-bound-exhausted-escalation
binding-type: structured
binding: repeated same-head same-class post-run recoverable infra failures stop with retry_bound_exhausted and operator-visible infra escalation
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)

binding-id: orchestrator-pack:autonomous-review-retry:sidecar-stale-link-rejected
binding-type: structured
binding: stale or mismatched #312 sidecar linkage is rejected and does not enable autonomous retry
producer: orchestrator-pack
evidence: NEW(produced-by AC#8)

binding-id: orchestrator-pack:autonomous-review-retry:no-raw-ao-review-run
binding-type: cli-behavior
binding: autonomous LLM turn cannot start raw ao review run; claimed entrypoint only
producer: orchestrator-pack
evidence: NEW(produced-by AC#10)

binding-id: orchestrator-pack:autonomous-review-retry:manual-operator-audit-separate
binding-type: cli-behavior
binding: manual invoke-manual-review-run retry after exhaustion is audited with operator provenance and does not arm autonomous retry budget reset
producer: orchestrator-pack
evidence: NEW(produced-by AC#11)
```

## Scenario matrix

| Scenario | Expected |
|---|---|
| First `timeout_no_verdict` on current head, worker ready, CI green | Enriched view classifies; one autonomous claimed-review retry |
| Second `timeout_no_verdict` same head over cap | `retry_bound_exhausted` + infra escalation |
| New head after prior exhaustion | Post-run retry budget reset |
| `needs_triage` with unsent findings | `ao review send`; no new review |
| `auth_failure` / `quota_exceeded` / `config_error` / `dependency_missing` | No auto retry |
| Failed run, `unknown`, no fresh sidecar | Fail closed |
| `malformed_output` | Empty-review trap |
| Stale/mismatched #312 sidecar linkage | Join rejected; fail closed |
| In-flight / covered-terminal on head | No duplicate retry (#189) |
| Raw autonomous `ao review run` from LLM turn | Denied (#318) |
| Operator manual retry after exhaustion | Manual wrapper; audited; autonomous ledger unchanged |
| Pre-launch `infra_transport` stall | #516 ledger only; no second counter from this issue |
| #534 bind crash before fix | Prerequisite #534; not modeled as retry class here |
| Dead worker / stale worktree only | Out of scope → #522 |

## Upgrade-safety check

- Pack-only; no AO core schema changes.
- Composes with #516 for pre-launch; does not weaken #318 / #189.
- Sidecar join safety prevents misclassified retries.

## Verification

1. Run AC proof commands (`npm test -- autonomous-review-retry` or planner-chosen suite).
2. `pwsh -NoProfile -File ./scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/174-autonomous-review-retry-after-recoverable-infra-failure.md` (and positive-outcome / parked-root).
3. `pwsh -NoProfile -File ./scripts/verify.ps1` and `pwsh -NoProfile -File ./scripts/check-reusable.ps1` on implementation PR(s).

## Architect review (Codex)

- **Pass 1:** P1 run-record persistence; P2 backstop coverage; P2 Windows paths. Revised.
- **Pass 2:** **NO_FINDINGS** (pre-scope-narrowing).
- **Pass 3** (operator findings): narrowed to post-run enrichment; pack-owned view not AO JSON; #516 consumes pre-launch; #534 prerequisite only; non-retryable auth/quota/config classes; sidecar stale-link ACs; lighter AC#2; `prompts/**` out of scope.
- **Pass 4** (`review-architect-artifact.ps1`, narrowed draft): **NO_FINDINGS**.

## Operator adoption

Document in `docs/migration_notes.md`:

- enriched view vs raw `ao review list` row;
- infra retry vs clean review vs empty-review trap;
- when to use `invoke-manual-review-run.ps1` after autonomous exhaustion.
