# Review-start cross-attempt ledger, operator escalation, and surface inventory (PR-2)

GitHub Issue: #516

## Prerequisite

- `docs/issues_drafts/164-review-start-readiness-envelope-external-io-accounting.md` (GitHub **#515**, open) — PR-1 core: infra envelope pause, classification, monotonic `firstAttemptAt` ceiling, supervised gh kill, reaper parity, #481 guard, PR #510 pass+reproduce. **Must merge first.**

**Prior-art verdict:** hardening + observability layer on top of #515. Not required to fix PR #510 within-attempt stall; adds cross-attempt `consecutiveFailureCount`, operator notification, and starter-path inventory.

## Goal

**Parked cause (from #515):** operator-visible notification when repeated review-start budget/infra failures recycle on one (PR, head) without launch

After #515 ships, repeated review-start failures on the same uncovered `(PR, head)` must persist a minimal cross-attempt ledger (`consecutiveFailureCount` beyond `firstAttemptAt`), emit operator-visible notification after N consecutive counted failures, and prove every automated review-start surface routes mandatory preflight `gh` through the supervised gateway from #515.

```behavior-kind
action-producing
```

## Binding surface

**Re-used:** #515 infra pause, classification, `firstAttemptAt`, covered-head (#189).

**Added:**

1. **Cross-attempt ledger.** Per `(PR, head)` while uncovered: `consecutiveFailureCount` increments on counted terminals (`released_for_retry` with `infra_transport`, `hold_budget_exceeded`, `readiness_envelope_exceeded`, `readiness_attempt_ceiling_exceeded`); resets on `run_started`, covered head (#189), or successful preflight reaching launch gate. Persists across claim terminalizations and surface changes — not reset on fresh `acquiredAtUtc` alone.

2. **Operator escalation.** When `consecutiveFailureCount ≥ 3` (configurable), emit operator-visible notification (existing ESCALATE channel + durable audit: PR, head, count, last failure class, surfaces). Rate-limit per `(PR, head)`. Fewer than 3 must not notify.

3. **Starter surface inventory.** Static or fixture guard: every automated review-start surface (`orchestrator_turn`, completion wake / `review-wake-trigger`, `review-trigger-reconcile`, re-eval/seed siblings) routes mandatory preflight `gh` through #515 supervised gateway — no bypass.

Planner freedom: ledger storage location, notification channel wiring.

## Files in scope

- `scripts/**`, `docs/**`, `tests/external-output-references/**`

## Files out of scope

- Re-litigating #515 pause/classification/ceiling semantics
- `vendor/**`, `packages/core/**`, `.ao/**`

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
```

```allowed-roots
scripts/**
docs/**
tests/external-output-references/**
```

## Acceptance criteria

1. **Cross-attempt failure count persists.** Three terminals across different surfaces on same `(PR, head)` without `run_started` yield `consecutiveFailureCount = 3` on the ledger, not three independent counters.

```producer-emission
producer: orchestrator-pack
datum: review-start-envelope-ledger
expected: cross-attempt-failure-count-persists
proof-command: npm test -- review-start-envelope-ledger
```

2. **Operator notification at N=3.** Infra-only PR #510-style pattern triggers notification on 3rd counted failure; reset after covered head clears counter; <3 silent.

```producer-emission
producer: orchestrator-pack
datum: review-start-envelope-ledger
expected: consecutive-failure-notify-at-three
proof-command: npm test -- review-start-envelope-ledger
```

3. **Starter surface inventory.** Guard proves all Goal-listed surfaces use supervised preflight `gh` path.

```producer-emission
producer: orchestrator-pack
datum: review-start-envelope-ledger
expected: all-starter-surfaces-supervised-gh
proof-command: npm test -- review-start-envelope-ledger
```

4. **Concurrent multi-surface race.** Two starters concurrently on same `(PR, head)`: at most one `run_started`, one ledger lineage, no lost counter updates.

```producer-emission
producer: orchestrator-pack
datum: review-start-envelope-ledger
expected: concurrent-surfaces-single-ledger-lineage
proof-command: npm test -- review-start-envelope-ledger
```

```positive-outcome
asserts: after three counted review-start failures on the same uncovered head without launch, operator-visible notification is emitted with PR, head, and failure count
input: realistic
```

## Upgrade-safety check

- Builds on #515 only; backward-compatible absent ledger fields.
- No AO core edits.

## Verification

- `npm test -- review-start-envelope-ledger`
- `npm test -- review-start-envelope-external-io` (regression)
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/165-review-start-envelope-cross-attempt-ledger-and-escalation.md`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/165-review-start-envelope-cross-attempt-ledger-and-escalation.md`

### Architect review (Codex)

- **2026-06-28:** `review-architect-artifact.ps1 -Kind issue-draft` → **NO_FINDINGS**.

### Contract evidence

```contract-evidence
binding-id: orchestrator-pack:review-start-envelope-ledger:cross-attempt-failure-count-persists
binding-type: cli-behavior
binding: consecutiveFailureCount persists across claim terminals and surfaces on same pr-head
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:review-start-envelope-ledger:consecutive-failure-notify-at-three
binding-type: cli-behavior
binding: three counted failures emit operator notification; fewer do not
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)

binding-id: orchestrator-pack:review-start-envelope-ledger:all-starter-surfaces-supervised-gh
binding-type: cli-behavior
binding: every automated review-start surface uses supervised gh preflight gateway
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)

binding-id: orchestrator-pack:review-start-envelope-ledger:concurrent-surfaces-single-ledger-lineage
binding-type: cli-behavior
binding: concurrent starters preserve single ledger lineage and at most one run_started
producer: orchestrator-pack
evidence: NEW(produced-by AC#4)
```
