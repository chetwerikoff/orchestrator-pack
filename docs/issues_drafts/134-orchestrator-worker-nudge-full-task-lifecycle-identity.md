# Gated task-continuation nudge for issue-bound worker with stable issue-keyed identity (including after PR open)

GitHub Issue: [#430](https://github.com/chetwerikoff/orchestrator-pack/issues/430)

## Prerequisite

- `121-llm-turn-worker-nudge-per-cycle-gate.md` → [#384](https://github.com/chetwerikoff/orchestrator-pack/issues/384) (**CLOSED**, PR [#385](https://github.com/chetwerikoff/orchestrator-pack/pull/385) merged) — PR-keyed `(PR, cycle, intent-class, worker-target)` claim store for **existing** intent classes. **This draft adds `task-continuation` with an issue-keyed tuple that stays issue-keyed after PR open.**
- `82-session-runtime-liveness-contract-satisfiable.md` → [#250](https://github.com/chetwerikoff/orchestrator-pack/issues/250) (**CLOSED**) — shared `isSessionAlive` / `isRuntimeFieldLive` live-target predicate (`docs/session-runtime-liveness.mjs`). **Reused for send admission; no new reachability table.**
- `104-orchestrator-spawn-git-process-boundary-deny.md` → [#324](https://github.com/chetwerikoff/orchestrator-pack/issues/324) (**CLOSED**) — orchestrator cannot spawn/replace workers; targets the **already-assigned** session only.

**Prior-art verdict:** No duplicate open issue. Narrow extension of #384.

### Producer-evidence gate (blocking for draft sync)

| Scenario | Status | Capture |
|---|---|---|
| Issue-only (`issue` set, `prNumber` null) | **Captured** | `capture@ao-status-session/working-no-runtime` |
| Same row after PR (`issue` + `prNumber`) | **Captured** | `capture@ao-status-session/issue-with-pr-facet` |
| Restore / replacement distinction | **Not captured** | **Out of scope v1** |

## Goal

Add a **gated `task-continuation`** path so the autonomous orchestrator can send **one** dedup-safe continuation command to an **issue-bound worker** (including while `prNumber` is null), without raw `ao send`.

**Routing rule (must not be ambiguous):**

> **`task-continuation` is always issue-keyed — before and after PR open.**
> **All other intent classes remain PR-keyed per shipped #384** (`-PrNumber` required, PR-claim target, PR-prefixed tuple).

**In scope:** first orchestrator continuation («commit, rebase, open PR, report when ready») while `issue` is set.

**Out of scope v1:** CI/review/liveness changes, #332 cycle machine, replacement/resume generation, instruction-revision episodes, break-glass redesign, #392 coalescing.

```behavior-kind
action-producing
```

## Root cause (verified)

Pre-PR orchestrator→worker nudges are impossible: gated entry requires `-PrNumber` for all intents today; raw send denied (#384/#406). Tasks begin on **issue** (`ao spawn <issue>`). #384 has no issue-keyed tuple for orchestrator coordination commands.

## Binding surface

### Narrow commitment

Add **`task-continuation` only**: issue-keyed tuple in the **same** claim store and transport chokepoint as #384. PR/head/review-run are **audit context** for this class, never the dedup namespace key.

### Intent-class routing (canonical)

| Intent class | Tuple anchor | Entry params | Target resolution |
|---|---|---|---|
| **`task-continuation`** | `(projectId, issueNumber, cycle, class, worker-target)` — **always**, even when `prNumber` is known | `-IssueNumber` + `-SessionId` required; `-PrNumber` optional audit only | Issue-task ownership (below) |
| **All #384 classes** | `(prNumber, cycle, class, worker-target)` — **unchanged** | `-PrNumber` required | PR-claim target — **unchanged** |

### Task identity (no alias table, no migration)

- **Canonical task key for `task-continuation`:** `(projectId, issueNumber)` from `ao status` `issue` (pre-PR shape: `capture@ao-status-session/working-no-runtime`; post-PR facet: `capture@ao-status-session/issue-with-pr-facet`). Missing/conflicting `issue` → fail-closed suppress.
- **When `prNumber` appears on the same session:** task key **unchanged**; same issue-keyed tuple stays served (AO shape: same captures).
- **No legacy migration:** new intent class only; do not remap PR-keyed records from other classes.

### Issue owner bootstrap (v1 — safe, atomic)

Before minting generation or sending, resolve the **unique live issue owner** from `ao status` for `(projectId, issueNumber)`:

1. **Candidate set:** worker/coding sessions where `issue` matches, `isSessionAlive(session)` is true (#250), same `project`.
2. **Cardinality:**
   - **Exactly one** live candidate → proceed to session-id check.
   - **Zero** live candidates → **fail-closed suppress** (`no_issue_owner`).
   - **Two or more** live candidates → **fail-closed suppress** (`ambiguous_issue_owner`) — never pick arbitrarily.
3. **Session-id match:** caller `-SessionId` **must equal** the sole candidate's `name`. Mismatch → suppress (`session_not_issue_owner`).
4. **Atomic bootstrap:** issue ownership record create is **CAS / single-winner** on `(project, issue)` — same discipline as #384 claim store. Two concurrent first-time bootstraps with **different** `-SessionId` values resolve to **at most one** bound `ownerSessionId` (identical winner) or **no binding** if neither passes the unique-owner predicate at commit time — never two owners. **Existing record:** subsequent sends require stored `ownerSessionId` to match the current sole live owner; bootstrap does not re-run on mismatch.
5. **After bootstrap:** `ownerSessionId` fixed; session `name` change for same issue → suppress (v1 fail-closed; replacement/restore out of scope).

**Pack-issued generation** per `(project, issue)` is minted only as part of successful atomic bootstrap above. Do not use local HEAD or commit count as generation.

### `task-continuation` cycle boundary (v1)

- **One send per `(projectId, issueNumber, workerTargetGeneration)`** — fixed cycle key (e.g. `task-gen:<generation>`). Not head-SHA-based.
- Materially different text, same generation → suppress + operator escalation. Instruction-revision episodes — out of scope v1.

### Claim lifecycle (`task-continuation` — same semantics as #384)

- **`FAILED_DEFINITIVE`:** claim released / retryable; next evaluation may send again for the same tuple if still eligible.
- **`UNCERTAIN`:** **no** automatic resend; bounded operator escalation; tuple stays served.

### Send admission — reuse #250 / #384 live-target

- `isSessionAlive(session)` + `preSendRecheck` (ci-green / review-send TOCTOU pattern).
- Capture-backed variants: `capture@ao-status-session/working-no-runtime`, `runtime-alive`, `runtime-exited`, `runtime-process_missing`.

### Unchanged from #384

- All **PR-keyed** intent classes, cycle derivations, reconcile integrations, raw-send deny, adoption for PR-routed nudges — **unchanged**.
- **`task-continuation` never joins the PR-keyed path:** even when `prNumber` is present on the session, orchestrator `task-continuation` invocations **must** use the issue-keyed tuple and `-IssueNumber` (not `-PrNumber` as dedup anchor). PR-keyed routing applies only to the other intent classes.

### Operator adoption

- `agent-orchestrator.yaml.example`: `task-continuation` with `-IssueNumber` + `-SessionId` + `-IntentClass task-continuation`.
- Post-merge: `ao stop` / `ao start`; extended adoption check.

```contract-evidence
binding-id: ao:status-session:issue-pr-facet:issue
binding-type: structured
binding: ao status session row retains issue after prNumber appears on the same row
producer: ao
evidence: capture@ao-status-session/issue-with-pr-facet
selector: $.issue
expected: 417

binding-id: ao:status-session:issue-pr-facet:pr-number
binding-type: structured
binding: ao status session row exposes prNumber on the same row as issue after PR open
producer: ao
evidence: capture@ao-status-session/issue-with-pr-facet
selector: $.prNumber
expected: 427

binding-id: orchestrator-pack:task-continuation-tuple:complete
binding-type: structured
binding: gated task-continuation forms a complete issue-keyed dedup tuple without prNumber
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)
selector: task-continuation-tuple
expected: complete

binding-id: orchestrator-pack:issue-owner-bootstrap:unique-owner
binding-type: structured
binding: issue owner bootstrap binds exactly one live issue owner atomically
producer: orchestrator-pack
evidence: NEW(produced-by AC#4)
selector: issue-owner-bootstrap
expected: unique-owner

binding-id: orchestrator-pack:task-continuation-pr-facet:no-redelivery
binding-type: structured
binding: task-continuation stays issue-keyed and suppresses redelivery when session gains prNumber for the same issue
producer: orchestrator-pack
evidence: NEW(produced-by AC#5)
selector: task-continuation-pr-facet
expected: no-redelivery

binding-id: orchestrator-pack:raw-send-deny:deny
binding-type: cli-behavior
binding: autonomous orchestrator surface still denies raw ao send to workers
producer: orchestrator-pack
evidence: NEW(produced-by AC#7)
selector: raw-send-deny
expected: deny
```

## Design analysis

### Critical mechanics

- Branch `task-continuation` → issue-keyed tuple; all other classes → PR-keyed #384.
- Unique live owner resolution from `ao status` before bootstrap; CAS ownership record; claim lifecycle unchanged from #384.

### Industry practice

- **Idempotency keys** span workflow stages without renaming the business key when optional facets appear (PR number late-binding).
- **Leader election / single-winner CAS** before side effects — same pattern as #384 review-start and nudge claims.

### Architecture

```
[invoke-gated-worker-nudge]
  task-continuation?
    yes → unique live issue owner (ao status + isSessionAlive)
        → SessionId match → CAS bootstrap → issue-keyed claim → send
    no  → PR-keyed #384 path
```

### Options (cost / risk / sufficiency)

| Option | Cost | Risk | Sufficient |
|---|---|---|---|
| **Issue-keyed branch in #384** | low | owner-bootstrap ambiguity if unique-owner + CAS omitted | **yes**, with atomic unique-owner resolution |
| **Separate pre-PR store** | medium | dual namespace at PR open | yes, but redundant |
| **Raw send pre-PR** | low | duplicate storm, no dedup | **no** |

**Chosen:** issue-keyed branch in #384.

## Scenario matrix (v1 only)

| stage | owner resolution | instruction | session / delivery | expected |
|---|---|---|---|---|
| issue-only | **one** live owner, SessionId match | first `task-continuation` | unsent | **SEND** once |
| issue-only | **zero** live owners | first | unsent | **SUPPRESS** (`no_issue_owner`) |
| issue-only | **two+** live owners | first | unsent | **SUPPRESS** (`ambiguous_issue_owner`) |
| issue-only | one owner, **SessionId mismatch** | first | unsent | **SUPPRESS** (`session_not_issue_owner`) |
| issue-only | one owner | first | **concurrent bootstrap**, two SessionIds | **exactly one** owner bound or **none** — never two |
| issue-only | bound owner | exact duplicate | SENT | **SUPPRESS** |
| issue-only | bound owner | different text, same gen | SENT | **SUPPRESS** + escalate |
| issue-only | bound owner | first | `FAILED_DEFINITIVE` | **retry** on next tick |
| issue-only | bound owner | first | `UNCERTAIN` | **no auto-resend**; escalate |
| issue-only | bound owner | first | not `isSessionAlive` | **SUPPRESS** |
| issue-only | bound owner | first | session id changed | **SUPPRESS** (v1) |
| PR open | bound owner | first `task-continuation` | unsent | **SEND** via **issue-keyed** tuple |
| PR open | bound owner | same as pre-PR SENT | prNumber appeared | **SUPPRESS** (same issue key) |
| PR open | any | review-findings / ci-green / … | — | **#384 regression group** |

## Files in scope

- `scripts/**`, `docs/worker-nudge-gate.mjs`, `scripts/*.test.ts`
- `tests/external-output-references/captures/ao-status-session/issue-with-pr-facet.*` (shipped with spec)
- `agent-orchestrator.yaml.example`, `docs/orchestrator-recovery-runbook.md`

## Files out of scope

- `docs/worker-iteration-cycle.mjs`, non-`task-continuation` intent changes, legacy claim migration, replacement/resume v1, `vendor/**`, `packages/core/**`, live yaml.

```denylist
vendor/**
packages/core/**
```

Scope boundary note: This denylist is scoped to `134-orchestrator-worker-nudge-full-task-lifecycle-identity`.

## Acceptance criteria

1. **Producer capture — pre-PR issue:** `capture@ao-status-session/working-no-runtime`.

2. **Producer capture — post-PR facet:** `capture@ao-status-session/issue-with-pr-facet` proves `issue` **and** `prNumber` on the same row (`417` / `427`).

3. **Issue-keyed tuple — first send:** captured issue-only shape; tuple does not use `PrNumber` as key → one delivery.

```producer-emission
producer: orchestrator-pack
datum: task-continuation-tuple
expected: complete
proof-command: npm test -- worker-nudge-task-continuation-tuple
```

4. **Issue owner bootstrap:** fixtures prove: one live owner → bind; zero → suppress; two+ → suppress ambiguous; concurrent bootstrap → exactly one identical owner or no binding.

```producer-emission
producer: orchestrator-pack
datum: issue-owner-bootstrap
expected: unique-owner
proof-command: npm test -- worker-nudge-issue-owner-bootstrap
```

5. **PR facet — no redelivery:** SENT issue-only; session shape per post-PR capture; identical invocation → suppress (issue-keyed, not PR path).

```producer-emission
producer: orchestrator-pack
datum: task-continuation-pr-facet
expected: no-redelivery
proof-command: npm test -- worker-nudge-task-continuation-pr-facet
```

6. **Post-PR routing:** session with `prNumber`; `task-continuation` still issue-keyed.

7. **Raw send deny:** boundary regression unchanged.

```producer-emission
producer: orchestrator-pack
datum: raw-send-deny
expected: deny
proof-command: npm test -- autonomous-worker-nudge-boundary
```

8. **#384 regression group:** existing PR-keyed tests green.

9. **Live-target:** `isSessionAlive` failure → suppress (capture-backed variants).

10. **Claim lifecycle (issue-keyed):** `FAILED_DEFINITIVE` retryable; `UNCERTAIN` no auto-resend + escalate.

11. **Adoption:** example YAML + checker for issue-keyed `task-continuation`.

```positive-outcome
asserts: orchestrator delivers exactly one issue-keyed task-continuation when exactly one live issue owner matches SessionId, suppresses ambiguous/zero-owner cases, and after prNumber appears suppresses redelivery without switching to the PR-keyed path
input: realistic
```

## Upgrade-safety check

- New intent class only; no migration of existing PR-keyed claim records.
- Tuple schema version bump if needed.

## Verification

- `npm test --` v1 fixtures + `scripts/worker-nudge-gate.test.ts`
- `pwsh scripts/verify.ps1` && `pwsh scripts/check-reusable.ps1`
- `pwsh scripts/check-worker-nudge-gate-adoption.ps1`
