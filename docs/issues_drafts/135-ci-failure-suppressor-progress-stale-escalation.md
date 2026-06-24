# Progress-stale escalation for CI-failure live-worker suppression

GitHub Issue: #439

## Prerequisite

- `docs/issues_drafts/37-ci-failed-ping-before-report-stale-backstop.md` (GitHub #109, closed) - introduced the red-CI worker ping before the 30-minute `report-stale` backstop. This draft does not change the ping's existence; it narrows when the live-worker suppressor may keep holding it back.
- `docs/issues_drafts/110-ci-failure-ping-suppress-on-live-worker-state.md` (GitHub #342, closed) - made the CI-failure ping suppress when the live PR-owning worker is actively in `fixing_ci`, with delivery-time re-check and fail-safe degraded behavior. This draft reuses that lifecycle and adds a freshness condition to the `suppressed-live-worker` branch only.
- `docs/issues_drafts/116-ci-failure-suppressor-bind-fixing_ci-to-head-scoped-report.md` (GitHub #363, closed) - corrected the suppressor to read `fixing_ci` from the latest head-scoped worker report, not session-level status. This draft preserves the stale-head rule: a `fixing_ci` report for an older head remains no-suppress per #363.
- `docs/issues_drafts/106-review-and-cinudge-per-cycle-settle-gate.md` (GitHub #332, closed) and `docs/issues_drafts/121-llm-turn-worker-nudge-per-cycle-gate.md` (GitHub #384, closed) - shipped the shared worker-nudge claim store and transport chokepoint. **Already wired:** `scripts/ci-failure-notification-reconcile.ps1` delivers CI-failure pings via intent-class `ci-failure`, tuple `(PR, episode:<redPeriod>, ci-failure, worker-target)`, `Acquire-WorkerNudgeClaim`, claim token, and `journaled-worker-send.ps1`. This draft extends the suppressor predicate only; it must not add a parallel delivery path or re-plumb #384.
- `docs/issues_drafts/112-review-loop-worker-fresh-green-fast-reengage.md` (GitHub #348, open) is out-of-scope sibling work: green-head review-loop re-engagement after a worker fails to re-report a fresh green head. This draft is red-CI-only and must not mix green-head review-loop policy into the CI-failure suppressor.

**Prior-art verdict:** a new draft is necessary. Live GitHub search on 2026-06-24 for `progress_stale`, `progress-stale`, `suppressed-live-worker`, and `fixing_ci` found no open issue covering same-head stale progress escalation. Bulk local prior-art reconnaissance found #342/#363 cover live-worker suppression and head-scoped report binding, but neither considers whether the same-head `fixing_ci` signal is fresh enough to keep suppressing.

**Incident evidence (motivation, not a one-case contract):** PR #436 / worker `opk-10` on 2026-06-24 had an old red-CI head `1bcb59dd...`, an old same-head `fixing_ci` report at `2026-06-24T07:21:49Z`, a `report-stale` event at `2026-06-24T07:52:30Z`, and later worker progress to head `8f72be5c...`. The observed gap is that the suppressor could still return `SUPPRESS` / `suppressed-live-worker` while CI stayed red and the head/progress signal was frozen.

## Goal

Make `suppressed-live-worker` conditional on a fresh same-head progress signal. A live PR-owning worker whose latest report for the red-CI head is fresh `fixing_ci` still suppresses the CI-failure ping; a stale same-head `fixing_ci` report, unchanged red-CI head, and no fresh progress must arm/produce `SEND` through the **existing** CI-failure reconcile delivery path (#342 episode lifecycle + #384-compatible `ci-failure` claim/journaled send) unless an existing reaction, intent token, or served worker-nudge claim already owns the exact tuple.

```behavior-kind
action-producing
```

## Binding surface

- **Progress freshness window (bounded, observable).** Same-head `fixing_ci` is **fresh** when the head-scoped report's timestamp is within `progressFreshnessMs` of evaluation time (planner picks the clock source; must be restart-comparable like other CI-failure episode timing). **Required constraints:** (1) `progressFreshnessMs` is strictly positive; (2) it is **strictly less than** the shipped `report-stale` / `REPORT_STALE_BACKSTOP_MS` ceiling (~30 minutes) so stale-progress `SEND` can fire before the long-tail backstop alone; (3) a named env override is documented in operator adoption (planner names the key); (4) golden fixtures for AC#1–AC#2 pin one concrete default value. **Fresh worker progress** (refreshes suppression only — evaluated by report timestamp): a newer same-head worker report (including a newer `fixing_ci`). **Episode/dedup reset** (new #342 / #384 tuple — does not make an old report timestamp fresh): new commit/head, CI rerun/new red-period on the same head, or target/session generation change. A CI rerun may start a new red episode and therefore a new `ci-failure` claim tuple, but an old `fixing_ci` report remains stale for the freshness predicate until a newer same-head report arrives.
- **Fresh `fixing_ci` still suppresses.** The #342/#363 suppressor remains valid when the live PR-owning worker's latest report for the current red-CI head is `fixing_ci` **and** that report is fresh per `progressFreshnessMs`.
- **Stale same-head progress must escalate via the existing CI-failure send path.** When the latest same-head `fixing_ci` report is **stale** (older than `progressFreshnessMs`), required CI remains red for that same head, and there is no fresh progress evidence per the bullet above, the decision is no longer plain `suppressed-live-worker`. It must produce an operator-visible audit reason exactly `progress_stale` and must arm/produce `SEND` through the existing CI-failure reconcile delivery path (intent-class `ci-failure`, worker-nudge claim, claim token, journaled send) unless an existing reaction, intent token, or served claim already owns the exact tuple.
- **No parallel delivery path.** Do not add a new orchestrator-turn, raw `ao send`, or sibling reconcile surface for stale-progress escalation. Stale-progress `SEND` flows only through `ci-failure-notification-reconcile.ps1` and its existing #384-compatible integration.
- **No stale-head regression.** If the only `fixing_ci` report belongs to an older head than the active red-CI episode, #363 still wins: the suppressor does not treat it as live same-head fixing progress.
- **Reset conditions are explicit.** A new commit/head, CI rerun/new red-period, or target/session generation change starts a new #342 episode / #384 `ci-failure` tuple under existing identity rules; a newer same-head worker report refreshes suppression while its timestamp is within `progressFreshnessMs`. **At-most-once per served tuple:** within the same `(PR, episode:<redPeriod>, ci-failure, worker-target)`, a served stale-progress `SEND` is not resent; a later stale report in the same red episode suppresses with audit (`already_served` / equivalent) rather than a duplicate ping. A genuinely new episode tuple may arm/produce `SEND` once when eligible.
- **Degraded evidence fails safe.** If the implementation cannot determine progress freshness from its required sources, it follows #342's degraded policy: no blind duplicate send, non-terminal re-evaluation where possible, and operator-visible audit of the missing/unreadable evidence.
- **Contract-evidence constraint.** Existing AO report shape may bind to committed captures. Any newly consumed external producer field for current PR head, CI check-run/red-period/rerun identity, report timestamp ordering, or worker progress freshness must be backed in the implementation PR by a committed capture or production-representative sample before the implementation depends on it. `NEW(...)` is allowed only for repo-owned emissions introduced by this work.

```contract-evidence
binding-id: ao:worker-report:fixing-ci-state
binding-type: structured
binding: ao worker report emits reportState fixing_ci
producer: ao
evidence: capture@ao-worker-report/fixing_ci
selector: $.reportState
expected: fixing_ci

binding-id: orchestrator-pack:ci-failure-progress-freshness.freshDecision:suppressed-live-worker
binding-type: structured
binding: CI-failure live-worker suppressor preserves fresh fixing_ci suppression
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)
selector: $.ci-failure-progress-freshness.freshDecision
expected: suppressed-live-worker

binding-id: orchestrator-pack:ci-failure-progress-stale.auditReason:progress_stale
binding-type: structured
binding: stale same-head fixing_ci decisions emit an operator-visible progress-stale audit reason
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)
selector: $.ci-failure-progress-stale.auditReason
expected: progress_stale
```

## Files in scope

- `scripts/**` and existing script tests that own the CI-failure notification/suppressor, worker-nudge gate, or their shared fixtures.
- `tests/external-output-references/**` only for new capture/sample evidence required by this draft.
- `docs/**` only for focused operator/audit documentation when the implementation adds a new visible reason.

## Files out of scope

- `vendor/**`, `packages/core/**`, and Composio AO internals.
- Green-head review-loop re-engagement (#348) and CI-green nudge policy.
- Rewriting the #342 CI-failure episode lifecycle, #363 head-scoped report reader, or re-plumbing the shipped #384 `ci-failure` claim/journaled-send integration in `ci-failure-notification-reconcile.ps1`.
- Changing what workers must run for `ao report fixing_ci`.
- Live gitignored operator state such as `agent-orchestrator.yaml`.

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
```

## Acceptance criteria

1. **Fresh same-head `fixing_ci` suppresses:** with red CI on head `H`, a live PR-owning worker, and a latest same-head `fixing_ci` report whose timestamp is within `progressFreshnessMs` (fixture pins the default), the CI-failure decision remains `SUPPRESS` with the existing live-worker reason.

```producer-emission
producer: orchestrator-pack
datum: ci-failure-progress-freshness.freshDecision
selector: $.ci-failure-progress-freshness.freshDecision
expected: suppressed-live-worker
proof-command: npm test -- ci-failure-progress-freshness
```

2. **Stale same-head `fixing_ci` escalates once:** with red CI still on unchanged head `H`, the latest same-head report still `fixing_ci` but older than `progressFreshnessMs` (same pinned default), no newer progress evidence, the decision records audit reason `progress_stale` and must arm/produce `SEND` through the existing CI-failure reconcile path (at most one delivery for that stale-progress tuple unless an existing reaction/intent/claim already owns it).

```producer-emission
producer: orchestrator-pack
datum: ci-failure-progress-stale.auditReason
selector: $.ci-failure-progress-stale.auditReason
expected: progress_stale
proof-command: npm test -- ci-failure-progress-stale
```

```positive-outcome
asserts: on realistic red-CI same-head input where a live PR-owning worker's latest fixing_ci report is stale and no head/progress signal changed, the suppressor emits an operator-visible progress_stale decision and arms/produces exactly one SEND through the existing ci-failure reconcile delivery path instead of continuing suppressed-live-worker
input: realistic
```

3. **New progress resets suppression; new episode may re-arm once:** a newer same-head worker report within `progressFreshnessMs` returns to `SUPPRESS`. A new commit/head, CI rerun/new red-period, or target/session generation reset starts a new #342 / #384 tuple; when that new tuple is eligible and stale, it may arm/produce `SEND` once. Within the same served `(PR, episode:<redPeriod>, ci-failure, worker-target)`, a second stale report does not produce another `SEND`.
4. **Stale-head `fixing_ci` remains no-suppress:** when the only `fixing_ci` report belongs to an older head than the active red-CI episode, the result remains `SEND` / no live-worker suppressor per #363, not `progress_stale`.
5. **Operator-visible audit:** stale-progress decisions record enough structured context for an operator to see PR, head, worker target/session generation, latest report timestamp, `progressFreshnessMs` (effective value), decision, and reason `progress_stale`.
6. **No duplicate pings across paths:** concurrent reaction and reconcile evaluations for the same stale-progress tuple produce one winner through the existing CI-failure reconcile + `ci-failure` worker-nudge claim path; losers suppress with audit rather than sending another worker message.
7. **Degraded freshness evidence fails safe:** missing, unreadable, or shape-mismatched progress evidence does not become an unconditional send. It follows the existing #342 degraded policy and records a distinct operator-visible reason.
8. **External evidence is captured before binding:** any implementation reliance on new external fields from AO status/report history or GitHub check-runs includes committed capture-backed or sample-backed contract evidence and a regression fixture using that shape.

## Upgrade-safety check

- No edits under `vendor/**` or `packages/core/**`; AO core remains untouched.
- No new raw `ao send` path and no parallel delivery surface; stale-progress `SEND` uses only the existing CI-failure reconcile path (`ci-failure` intent-class, worker-nudge claim, claim token, journaled send).
- No new repo secrets, live credential reads, or gitignored live YAML changes.
- External producer shape assumptions are either already capture-backed in this repo or added as capture/sample evidence by the implementation PR before use.

## Verification

- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/135-ci-failure-suppressor-progress-stale-escalation.md`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/135-ci-failure-suppressor-progress-stale-escalation.md`
- Targeted test fixtures covering AC#1-AC#8, including fresh suppress, stale same-head escalation, reset on new progress, stale-head no-suppress, degraded evidence, and concurrent single-winner delivery.
- `pwsh -NoProfile -File scripts/verify.ps1`
- `pwsh -NoProfile -File scripts/check-reusable.ps1`

## Design notes

### Prior art

#109 made red-CI wakeups necessary before `report-stale`; #342 suppressed that wakeup when the live worker is already in `fixing_ci`; #363 made the suppressing signal head-scoped; #384 already integrates `ci-failure` claim/journaled send into `ci-failure-notification-reconcile.ps1`. This issue only narrows when that path may stay suppressed — it does not add delivery plumbing. The missing class is not "green head needs review" (#348) and not "post-merge review is terminal" (#112); it is stale progress inside the red-CI live-worker suppressor.

### Failure analysis

Why did the ping stay suppressed? Because the decision treated same-head `fixing_ci` as sufficient proof of active progress. Why was that insufficient? A worker can remain live and keep or expose an old `fixing_ci` report while the red head and CI state do not advance. Why did existing backstops not cover it narrowly? #342's `abandoned-expired` is correlation-only and leaves onward action to `report-stale`, while #363 only fixes where the report is read. The missing contract is a freshness predicate for the already-read progress signal.

### Options

| Option | Cost | Risk | Sufficient |
|---|---|---|---|
| Extend #342/#363 suppressor with progress freshness; stale-progress `SEND` stays on the shipped CI-failure reconcile + `ci-failure` claim path | Low | Needs careful reset/dedup fixtures | Yes |
| Treat all same-head `fixing_ci` older than a threshold as no-suppress immediately | Low | Can spam workers during legitimate long fixes | No |
| Move the whole CI-failure lifecycle into a new supervisor | High | Reimplements shipped #342/#363/#384 behavior | No |

Chosen: extend the existing suppressor with a progress-freshness condition; stale-progress `SEND` remains on the existing CI-failure reconcile delivery path (no parallel #384 integration work).
