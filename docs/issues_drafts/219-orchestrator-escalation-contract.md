# Orchestrator escalation contract — delivery plumbing + emitter adoption

GitHub Issue: #641

## Prerequisite

- `docs/issues_drafts/218-journaled-worker-send-0102-argv-cutover.md` (GitHub #640) — **must merge first** for journaled at-least-once delivery to the orchestrator session via `ao send --session --message`. This draft may land with a documented interim wake transport; full guarantee ACs that depend on the journaled chokepoint are gated on #640.
- Shipped wake infrastructure (`docs/issues_drafts/14-orchestrator-wake-mechanism.md`, `docs/issues_drafts/60-orchestrator-wake-supervisor.md`) — listener + heartbeat exist; they are **re-parameterized**, not removed, here.
- `docs/issues_drafts/95-orchestrator-message-egress-registry.md` — message catalog + generated `docs/orchestrator-message-map.md`; escalation classes extend that registry.
- Emitter prior art (signals exist today but route nowhere): `docs/issues_drafts/195-autonomous-dead-worker-reconciler.md`, `docs/issues_drafts/201-submit-reconcile-adoption-and-consumption-proof.md`, `docs/issues_drafts/121-llm-turn-worker-nudge-per-cycle-gate.md`, review-trigger/recovery drafts in the 0.10 series.

**Prior-art verdict (draft-author recon 2026-07-06):** **Genuinely new.** Corpus + index search found no queued draft that defines a first-class escalation delivery contract routing existing `escalate` / `escalated` / `storage_failure` / `ambiguous_claim` / `escalate_degraded_ci` emit sites to orchestrator wake or operator surfaces. Related drafts own individual reconcile outcomes (#195, #201, #211) or transport argv (#640), not the cross-fleet routing contract.

**Decomposition check:** One PR — contract schema, shared publish library, delivery router, catalog entries, emitter adoption at enumerated sites, wake-parameter changes. Sibling scopes explicitly out (see Files out of scope).

**Pre-draft design gate (architect brief carry-forward — not re-derived):** Program direction minimizes LLM orchestrator participation; deterministic side-process scripts own routine orchestration; the LLM is an exception handler woken only by an explicit escalation contract. Today emit sites produce escalation signals that die in logs/outcome JSON; wake surfaces are blind to them. Silence is forbidden — undeliverable escalations must fail loudly in a durable operator-checkable place. Transport leans journaled chokepoint (#640) for at-least-once + audit; `ao events` and `orchestratorRules` / `notifiers` YAML are inert on AO 0.10.2; operator-direct routes must define their own durable surface.

## Goal

Define and ship a first-class orchestrator escalation contract: stable event schema, catalog of escalation classes with owning processes and routes, shared publish entry point, delivery mechanism with stated guarantee and ack surface (without `ao events`), operator-direct inbox for integrity classes, wake-storm aggregation, and adoption at every enumerated emit site — so shrinking the orchestrator from poll-driven safety net to exception handler cannot turn silent failures into permanently silent failures.

```behavior-kind
action-producing
```

```complexity-tier
tier: T3
advisory-prior: T3
escalation-markers: concurrency-state-retry, durable-state-evidence, crash-recovery, event-ordering
```

## Binding surface

### Escalation event schema (minimal stable shape)

Every emitter produces the same envelope (planner picks serialization; fields are normative):

| Field | Required | Semantics |
| --- | --- | --- |
| `schema_version` | yes | Integer; starts at `1`. |
| `escalation_class_id` | yes | Stable id registered in `scripts/orchestrator-message-catalog.json` (e.g. `escalation-dead-worker-recovery`). |
| `source_process` | yes | Side-process child id from `scripts/orchestrator-side-process-registry.json`. |
| `severity` | yes | `info` \| `action` \| `urgent` — routing hint only; route is declared per class in catalog. |
| `correlation_key` | yes | Stable incident identity (e.g. `recovery:orchestrator-pack-7:spawn_denied`). |
| `dedupe_key` | yes | Superset of correlation; may add reason/lifecycle suffix. Used for publish idempotency and wake aggregation. |
| `diagnosis` | yes | JSON object; machine-readable payload (outcome reason, session ids, PR refs — no secrets). |
| `emitted_at_utc` | yes | ISO-8601 UTC timestamp from emitter. |

**Forbidden:** per-emitter bespoke envelope shapes; secrets in `diagnosis`; binding delivery to `orchestratorRules` YAML or `ao events`.

### Catalog / registry placement

- Each `escalation_class_id` is a row in `scripts/orchestrator-message-catalog.json` with: `owning_process`, `route` (`llm-orchestrator` \| `operator` \| `auto-retry-only`), `delivery_guarantee`, `dedupe_owner`, optional `promotion_after_ticks` (required when `route=auto-retry-only`), optional `promotion_target_class_id`, and regenerated `docs/orchestrator-message-map.md` entry.
- `auto-retry-only` classes are recorded for audit but **not** delivered — reconcile retries without waking the LLM or operator.

### Shared publish entry point

- One library function (working name `Publish-OrchestratorEscalation`) in `scripts/lib/` — **the only** supported path from emit sites to the contract.
- **Fail-closed publish:** if publish or downstream delivery cannot complete, the library returns non-success to the caller and records the failure observably:
  1. **Primary:** operator escalation inbox row + structured log when inbox is writable.
  2. **Inbox-unavailable fallback (mandatory):** when inbox write fails (disk full, permissions, lock), append to a separate **escalation-health spool** (append-only, distinct path) **and** emit supervisor-visible stderr; side-process supervisor surfaces spool non-empty as child health degradation. This path must not depend on the failed inbox.
  Publish failure is itself an `escalation-pipeline-failure` class event (meta-watchdog).
- Emit sites listed in architect brief §4 call this entry point; they do not grow bespoke transport wiring.

### Transport and delivery semantics

| Route | Transport | Guarantee | Consumed / ack surface |
| --- | --- | --- | --- |
| `llm-orchestrator` | **Post-#640:** `journaled-worker-send.ps1` targeting orchestrator session (`ao send --session --message`). **Interim (pre-#640):** `Send-OrchestratorWakeMessage` with documented migration note — same ack contract, lighter journal. | At-least-once until **validated** ack | Orchestrator turn invokes shared **`Write-OrchestratorEscalationAck`** helper (not ad-hoc file edits) recording `dedupe_key`, `escalation_class_id`, `correlation_key`, orchestrator `session_id`, observed incident snapshot hash, and `action_result`. Ack must match an outstanding delivery record; malformed, premature, or actor-mismatched acks are rejected and redelivery continues. Wake message body points at the helper; procedure text lives in workspace prompt surface — **not** `orchestratorRules` YAML. |
| `operator` | Durable **operator escalation inbox** state file + structured log line (AO 0.10.2 `notifiers` / `notificationRouting` are inert). | At-least-once until **validated** operator ack | Operator invokes shared **`Write-OperatorEscalationAck`** with matching outstanding inbox delivery, `escalation_class_id`, `correlation_key`, incident generation/snapshot, and operator provenance. Bogus/stale ack markers do not stop redelivery. |
| `auto-retry-only` | None (outcome JSON + audit ledger only). | Audit-only until **promotion threshold** | Each class declares `promotion_after_ticks` in catalog; exhaustion emits a delivered operator or LLM class — never remains audit-only past threshold. |

**Wake-storm bound:** For `llm-orchestrator` route, the router aggregates by `(escalation_class_id, correlation_key)` within a configurable window (default 30s, shared with existing wake dedup state where practical) — at most **one** orchestrator wake per incident class per window.

**#640 dependency:** Journaled-chokepoint rows in the matrix are **gated** until #640 merges. Interim posture: interim wake transport + full ack ledger + operator inbox; migration AC switches transport without changing ack keys or catalog ids.

### Heartbeat and listener re-parameterization (not removal)

- **Heartbeat:** demote from 15-minute poll-driven reconciliation to a **long-interval liveness fallback** (default 4 hours, operator-configurable) once escalation delivery is live. Heartbeat wake class remains in catalog; it does not replace escalation delivery.
- **Listener:** narrow webhook filter to escalation-worthy kinds + existing handoff-envelope admission; generic AO chatter must not wake the orchestrator.

### Worker nudge invariants (unchanged)

- Claim/journal/dedup semantics of worker nudges are unchanged.
- Never wrap `ao send` in an external wall-clock limiter.
- No `--file` / positional `ao send` argv (AO 0.10.2 contract per #640).

```contract-evidence
binding-id: ao:datum:send-message-required
binding: ao send requires --message (message text to deliver)
producer: ao-0-10-cli
binding-type: unstructured
evidence: capture@ao-0-10-cli/send-help
token: --message

binding-id: ao:datum:send-session-required
binding: ao send requires --session (target session id)
producer: ao-0-10-cli
binding-type: unstructured
evidence: capture@ao-0-10-cli/send-help
token: --session

binding-id: orchestrator-pack:escalation-publish:fail-closed-inbox
binding-type: cli-behavior
binding: Publish-OrchestratorEscalation writes to operator escalation inbox when publish or delivery cannot complete
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)

binding-id: orchestrator-pack:escalation-router:wake-storm-cap
binding-type: cli-behavior
binding: N escalations sharing escalation_class_id and correlation_key within the aggregation window produce at most one orchestrator wake
producer: orchestrator-pack
evidence: NEW(produced-by AC#5)

binding-id: orchestrator-pack:escalation-ack:validated-helper
binding-type: cli-behavior
binding: Write-OrchestratorEscalationAck accepts only acks matching outstanding delivery with valid actor session and incident snapshot; bogus ack does not stop redelivery
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)

binding-id: orchestrator-pack:escalation-health-spool:inbox-unavailable
binding-type: cli-behavior
binding: when operator inbox is unwritable, escalation pipeline appends to escalation-health spool and emits supervisor-visible stderr without depending on inbox
producer: orchestrator-pack
evidence: NEW(produced-by AC#6)
```

## Files in scope

- `scripts/lib/` escalation library `(new)` — capabilities: shared publish entry
  point (fail-closed with inbox fallback), route split + aggregation + delivery,
  validated ack, operator-direct durable inbox, inbox-unavailable append-only
  health spool. **File split and names are the planner's** — the working names
  used elsewhere in this draft (`Publish-OrchestratorEscalation`,
  `Write-OrchestratorEscalationAck`, …) name capabilities, not required files.
- `scripts/orchestrator-message-catalog.json` — escalation class entries `(update)`
- `docs/orchestrator-message-map.md` — regenerated `(update)`
- `scripts/orchestrator-wake-common.ps1` — router integration for wake path `(update)`
- `scripts/orchestrator-wake-heartbeat.ps1` — long-interval default `(update)`
- `scripts/orchestrator-wake-listener.ps1` — narrowed filter + escalation handoff `(update)`
- `scripts/orchestrator-side-process-registry.json` — router child if needed `(update)`
- `scripts/orchestrator-escalation-emitter-inventory.json` `(new)` — canonical checked-in emitter inventory (see § Emitter inventory)
- Enumerated emit sites in inventory `(update)` — adopt `Publish-OrchestratorEscalation` only
- `prompts/agent_rules.md` or workspace prompt fragment — orchestrator turn ack procedure `(update)` — wake-message / workspace only, not YAML
- `tests/**` + `tests/external-output-references/**` — scenario matrix fixtures `(new)`

## Files out of scope

- Migrating `ci-failure-orchestrator-turn` message class to a reconcile (sibling draft)
- Re-scoping issue **#625** (rules relocation / exception-handler prompt shrink)
- `ao send` transport argv cutover — **#640** / draft 218
- Review-pipeline scripts series **#623–#626**
- **Removal** of heartbeat or listener (re-parameterization only here)
- `orchestratorRules` / `notifiers` YAML keys (inert on 0.10.2)
- `ao events` polling or consumption definitions
- AO core / `vendor/**`

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
```

```allowed-roots
scripts/**
docs/orchestrator-message-map.md
prompts/**
tests/**
```

## Acceptance criteria

1. **Catalog completeness.** Every in-scope escalation class in the Scenario Matrix (§ Event classes, excluding explicit sibling-deferred rows like E7 and the router-internal control row E9 — proven by AC#5, no catalog row) has exactly one `owning_process`, one `route`, and one `delivery_guarantee` in `orchestrator-message-catalog.json`; guard fails when a non-deferred matrix class lacks an emitter inventory anchor.

```positive-outcome
asserts: every enumerated escalation_class_id in the scenario matrix appears in orchestrator-message-catalog.json with owning_process, route, and delivery_guarantee; orchestrator-message-map.md regenerates without orphan classes
input: realistic
```

2. **At-least-once llm-orchestrator delivery with validated ack.** For `llm-orchestrator` classes, publish → deliver → redeliver on reconcile tick until orchestrator turn successfully invokes `Write-OrchestratorEscalationAck` with matching delivery record; then redelivery stops. Bogus/premature ack attempts do not stop redelivery. Consumed is defined only via validated ack ledger — not `ao events`.

```producer-emission
producer: orchestrator-pack
datum: escalation-ack
expected: validated-helper
proof-command: npx vitest run -t "escalation ack stops redelivery"
red-then-green: bogus ack does not stop redelivery; validated ack stops redelivery for same dedupe_key
```

3. **Fail-closed publish and operator inbox.** When publish or delivery fails, event lands in operator escalation inbox (state file + log) with `escalation-pipeline-failure` class; caller receives non-success; no silent drop.

```producer-emission
producer: orchestrator-pack
datum: escalation-publish
expected: fail-closed-inbox
proof-command: npx vitest run -t "escalation publish fail closed inbox"
red-then-green: simulated delivery failure must create inbox row and log line
```

4. **Emitter adoption.** Every file in `scripts/orchestrator-escalation-emitter-inventory.json` invokes `Publish-OrchestratorEscalation` at the listed anchor; static guard compares inventory to repo call sites. Adding a new emitter is inventory + catalog + emit change — no new transport code per site.

```producer-emission
producer: orchestrator-pack
datum: escalation-emitter-audit
expected: shared-publish-only
proof-command: pwsh -NoProfile -File scripts/check-orchestrator-escalation-emitters.ps1
red-then-green: guard fails if any §4 site emits escalation without shared publish
```

5. **Wake-storm cap.** N publishes sharing `escalation_class_id` + `correlation_key` within the aggregation window produce at most one orchestrator wake.

```producer-emission
producer: orchestrator-pack
datum: escalation-router
expected: wake-storm-cap
proof-command: npx vitest run -t "escalation wake storm cap"
red-then-green: 10 publishes in window must produce 1 wake invocation
```

6. **Meta-watchdog test.** Broken escalation pipeline surfaces loudly: (a) router/delivery failure with writable inbox → inbox row; (b) inbox unwritable → escalation-health spool append + supervisor-visible stderr — never empty success.

```producer-emission
producer: orchestrator-pack
datum: escalation-health-spool
expected: inbox-unavailable
proof-command: npx vitest run -t "escalation meta watchdog"
red-then-green: writable-inbox failure creates inbox row; inbox-unwritable failure creates health-spool row and supervisor-visible stderr without inbox dependency
```

7. **Crash/race/stale-state matrix coverage.** Each row in § Cross-cutting failure modes has a named test fixture or explicit out-of-scope note with owning sibling draft.

8. **#640 migration posture.** Draft documents interim wake transport when #640 absent; post-#640 AC proves journaled chokepoint without changing class ids or ack keys.

9. **Auto-retry-only promotion.** Every `auto-retry-only` catalog row declares `promotion_after_ticks` and `promotion_target_class_id`. When tick budget exhausts, router emits the target delivered class; test proves E11-style persistent escalate does not remain audit-only past threshold.

```producer-emission
producer: orchestrator-pack
datum: escalation-auto-retry-promotion
expected: promotion-after-threshold
proof-command: npx vitest run -t "escalation auto retry promotion"
red-then-green: audit-only ticks below threshold do not wake; at threshold+1 target class delivers
```

10. **Operator ack validation.** Bogus/stale operator ack markers do not stop redelivery for in-scope operator-routed classes (E2, E8, E13 — excluding sibling-deferred E7).

11. **Heartbeat demotion.** Default heartbeat interval ≥ 4 hours when escalation router child is healthy; 15-minute default is not restored.

12. **No worker-nudge regression.** Existing worker-nudge claim/journal/dedup tests pass unchanged; no external wall-clock limiter around `ao send`.

## Emitter inventory

Canonical checked-in inventory (`scripts/orchestrator-escalation-emitter-inventory.json`). Guard and adoption AC#4 use this file — not an external brief.

| File | Anchor (function / outcome branch) |
| --- | --- |
| `scripts/dead-worker-reconcile.ps1` | `outcome=escalated` / worker recovery invoke |
| `scripts/invoke-worker-recovery.ps1` | outcomes `skipped_ambiguous`, `skipped_live`, `spawn_denied`, `partial_failure`, `escalated` |
| `scripts/ci-failure-notification-reconcile.ps1` | `$gate.escalate` |
| `scripts/ci-green-wake-reconcile.ps1` | `$claim.escalate` |
| `scripts/invoke-gated-worker-nudge.ps1` | gate/claim `escalate` |
| `scripts/lib/Worker-NudgeClaim.ps1` | `storage_failure`, `ambiguous_claim` |
| `scripts/lib/Worker-Recovery.ps1` | escalation branch |
| `scripts/lib/Review-StartClaim.ps1` | escalation path |
| `scripts/lib/Review-StartEnvelopeLedger.ps1` | `mark-escalated` |
| `scripts/review-run-recovery.ps1` | `action.escalated`, `writeFailure` |
| `scripts/review-trigger-reconcile.ps1` | `escalate_degraded_ci` |
| `scripts/worker-message-submit-reconcile.ps1` | adoption `escalated` + diagnosis |
| `scripts/orchestrator-wake-listener.ps1` | handoff-envelope admission (worker blocked / question) |

## Scenario Matrix

### Event classes

Each row: **event class → detection source → route → dedupe/correlation key → delivery guarantee → silence failure-mode**.

| ID | Event class | Detection source | Route | Correlation / dedupe key | Guarantee | Silence failure-mode |
| --- | --- | --- | --- | --- | --- | --- |
| E1 | Dead worker recovery exhausted | `invoke-worker-recovery.ps1` outcomes `skipped_ambiguous`, `skipped_live`, `spawn_denied`, `partial_failure`, `escalated`; `dead-worker-reconcile.ps1` `outcome=escalated` | `llm-orchestrator` | `corr:recovery:{sessionId}` / `dedupe:recovery:{sessionId}:{reason}` | At-least-once until ack | Dead worker never noticed; fleet stuck |
| E2 | Claim-store integrity | `Worker-NudgeClaim.ps1` `storage_failure`, `ambiguous_claim` | `operator` | `corr:claim-store:{namespace}` / `dedupe:claim-store:{namespace}:{failureKind}` | At-least-once operator inbox | Corrupt claims cause duplicate/missed nudges undetected |
| E3 | Review trigger degraded CI | `review-trigger-reconcile.ps1` `escalate_degraded_ci` | `llm-orchestrator` | `corr:review-trigger:{prUrl}:{headSha}` / same + `:degraded_ci` | Aggregated at-least-once | CI degraded indefinitely; no review path |
| E4 | Review-run recovery failed | `review-run-recovery.ps1` `action.escalated` or `writeFailure` | `llm-orchestrator` | `corr:review-run:{runId}` / `dedupe:review-run:{runId}:recovery` | At-least-once until ack | Stuck `running` review invisible to orchestrator |
| E5 | Submit adoption escalation | `worker-message-submit-reconcile.ps1` adoption `escalated` + `diagnosis` | `llm-orchestrator` | `corr:submit:{deliveryId}` / `dedupe:submit:{deliveryId}:adoption` | At-least-once until ack | Worker message hang permanent (#201 class) |
| E6 | Worker blocked / handoff question | `orchestrator-wake-listener.ps1` handoff-envelope admission | `llm-orchestrator` | `corr:handoff:{envelopeKey}` / `dedupe:handoff:{envelopeKey}` | At-least-once until ack | Worker blocked; no orchestrator turn |
| E7 | Contested protected finding | **Deferred — sibling draft #625** (rules relocation / exception-handler prompt). Catalog row reserved; emit binding owned by review-pipeline relocation, not this PR. | `operator` (when sibling lands) | `corr:protected-finding:{findingId}` / `dedupe:protected-finding:{findingId}` | Operator inbox when live | Policy violation ships without human gate |
| E8 | Escalation pipeline self-failure | `Publish-OrchestratorEscalation` publish/delivery/inbox write failure | `operator` | `corr:pipeline:{failureKind}` / `dedupe:pipeline:{failureKind}:{minuteBucket}` | Inbox row when writable; **escalation-health spool + supervisor stderr** when inbox unavailable (mandatory) | Program goal violated — silent fleet failure |
| E9 | Wake-storm aggregation (control) | Router observes duplicate `llm-orchestrator` publishes same class+corr in window | internal router | `corr:*` / aggregation window bucket | Max 1 wake per window | Orchestrator woken N times; thrash / cost |
| E10 | CI failure notification escalate | `ci-failure-notification-reconcile.ps1` `$gate.escalate` | `llm-orchestrator` | `corr:ci-failure:{pr}:{head}` / `dedupe:ci-failure:{pr}:{head}:notify` | Aggregated at-least-once | Red CI never reaches orchestrator |
| E11 | CI green wake claim escalate | `ci-green-wake-reconcile.ps1` `$claim.escalate` | `auto-retry-only` (promote to `escalation-ci-green-claim` LLM class after 5 ticks) | `corr:ci-green:{pr}:{head}` / `dedupe:ci-green:{pr}:{head}:claim` | Audit until `promotion_after_ticks`; then LLM delivery | Misclassified — persistent escalate invisible past budget |
| E12 | Gated nudge gate/claim escalate | `invoke-gated-worker-nudge.ps1` gate/claim `escalate` | `llm-orchestrator` | `corr:nudge:{tuple}` / `dedupe:nudge:{tuple}:{reason}` | At-least-once until ack | Worker nudge storm or stall |
| E13 | Review-start envelope ledger | `Review-StartEnvelopeLedger.ps1` mark-escalated | `operator` | `corr:envelope-ledger:{pr}:{head}` / `dedupe:envelope-ledger:{pr}:{head}:n` | Operator inbox | Repeated review-start failures invisible |
| E14 | Review-start claim escalation | `Review-StartClaim.ps1` escalation path | `llm-orchestrator` | `corr:review-start-claim:{pr}:{head}` / `dedupe:review-start-claim:{pr}:{head}` | At-least-once until ack | Duplicate review starts / stuck claim |
| E15 | Worker recovery lib escalate | `Worker-Recovery.ps1` escalation branch | `llm-orchestrator` | `corr:worker-recovery:{sessionId}` / `dedupe:worker-recovery:{sessionId}:{reason}` | At-least-once until ack | Recovery stuck without orchestrator |

### Cross-cutting failure modes (crash / race / stale-state)

For **each** event class E1–E15, the implementation must handle or explicitly defer the axes below. Rows name the **detection source** for the failure itself and the **required contract behavior**.

| Axis | Detection source | Required behavior | Silence failure-mode |
| --- | --- | --- | --- |
| F1 Producer crash after emit, before publish | Reconcile restarts; partial outcome JSON without inbox/ack | Idempotent re-publish on next tick using same `dedupe_key`; no duplicate wakes beyond aggregation window | Incident never escalates after crash |
| F2 Publish succeeds, delivery fails | Router delivery error; journaled send failure; wake throw | Fail-closed → operator inbox (E8); redelivery on next tick for llm route | Escalation logged but never reaches orchestrator |
| F3 Delivery succeeds, LLM turn crashes before ack | Ack ledger missing after wake; subsequent ticks | At-least-once redelivery until ack; wake-storm cap prevents N wakes | Single crash loses incident forever |
| F4 Same incident re-emitted every reconcile tick (stale-state) | Identical `dedupe_key` on each tick | First delivery + capped redelivery; ack stops loop; without ack, aggregated wakes only | Reconcile spam wakes orchestrator each 30–60s |
| F5 Two producers, same correlation key concurrently | Cross-process publish race | Single-winner publish claim or inbox merge; one wake per window | Duplicate conflicting deliveries |
| F6 Stale anchor superseded (worker-submit class) | `dedupe_key` identity mismatch vs live delivery | Resolve superseded keys to terminal state without blind ack; escalate if ambiguous | Stale escalation blocks fresh delivery |

**E11 note:** `auto-retry-only` with `promotion_after_ticks: 5` → `promotion_target_class_id: escalation-ci-green-claim` (LLM route). AC#9 proves promotion.

## Upgrade-safety check

- No AO core / `vendor/**` edits.
- No `orchestratorRules`, `notifiers`, or `notificationRouting` YAML reliance.
- No `ao events` read or consumption definition.
- No regression to worker-nudge claim/journal/dedup (#121/#373).
- No `--file` / positional `ao send`; no external wall-clock limiter on `ao send`.
- Interim transport must migrate to journaled chokepoint post-#640 without class id or ack key churn.

## Verification

- Scenario matrix fixtures E1–E15 (sanitized ids) + F1–F6 axes per AC#7
- `npx vitest run -t "escalation"` (ack, inbox, wake-storm, meta-watchdog)
- `pwsh -NoProfile -File scripts/check-orchestrator-escalation-emitters.ps1`
- Regenerate `docs/orchestrator-message-map.md` from catalog
- `pwsh -NoProfile -File scripts/check-tier-gate-guard.ps1 -DraftPath docs/issues_drafts/219-orchestrator-escalation-contract.md`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/219-orchestrator-escalation-contract.md`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command parked-root -DraftPath docs/issues_drafts/219-orchestrator-escalation-contract.md`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/219-orchestrator-escalation-contract.md`
- `pwsh -NoProfile -File scripts/verify.ps1`
- `pwsh -NoProfile -File scripts/check-reusable.ps1`

## Decisions

### Tier gate / T3-critical (L4-condition) check

Recomputed **T3** (advisory prior T3 confirmed). Per `docs/issues_drafts/187-task-complexity-tier-rubric.md` L4-condition list:

| L4 condition | Applies | Draft coverage |
| --- | --- | --- |
| Fail-closed / fail-open change | yes | Silence forbidden; publish fail-closed to inbox |
| Single-winner / lease / claim | yes | `dedupe_key`, publish claim, wake aggregation |
| Recovery semantics | yes | F1–F3 cross-cutting matrix |
| Live-state mutation | yes | Ack ledger + operator inbox |
| Migration / backcompat | yes | #640 interim posture + heartbeat demotion |
| External side effects | yes | `ao send` wake delivery (capture-backed) |

**T3-critical check: PASS** — competitive + Codex architectural review required; crash/race/stale-state tests mandated in AC#7.

### Design analysis

| Option | Cost | Risk | Sufficiency | Decision |
| --- | ---: | ---: | ---: | --- |
| Status quo — logs only | None | **Critical** — silent failures under program | Insufficient | Rejected |
| Per-reconcile bespoke `ao send` at each emit site | Medium | High drift, no dedupe/ack | Insufficient | Rejected |
| Wake-only (`Send-OrchestratorWakeMessage`) without ack ledger | Low | High — at-most-once, poll replacement | Insufficient | Rejected as final |
| Shared publish + router + journaled chokepoint + ack ledger + operator inbox | Medium | Low-medium — #640 dependency | Sufficient | **Chosen** |
| External queue (Redis/etc.) | High | Ops burden, new failure domain | Excessive | Rejected |

**Transport split:** `llm-orchestrator` → journaled chokepoint post-#640 (interim wake path documented); `operator` → inbox file; `auto-retry-only` → audit only.

**Heartbeat:** demote to 4h fallback — not removed (sibling owns removal).

### Rollback / migration note

- **Rollback:** disabling the escalation router child does **not** restore silent outcome-json-only behavior. `Publish-OrchestratorEscalation` remains fail-closed: writes operator inbox or escalation-health spool on every publish attempt. Router disable may stop LLM wakes but cannot suppress durable visibility.
- **Forward:** #640 lands → flip llm route transport flag; ack keys unchanged.