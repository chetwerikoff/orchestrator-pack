# Static reaction message shape must not be guessed from a stale in-code stub map

GitHub Issue: TBD

## Prerequisite

- `docs/issues_drafts/77-worker-message-submit-source-agnostic.md` (GitHub #232) — shipped
  submit arbiter; classifies `pending-draft` vs `self-submitted` from delivery shape.
  **Regression:** static-text reactions use a hardcoded stub map instead of live config text.
- `docs/issues_drafts/71-orchestrator-side-process-supervisor.md` (GitHub #205) — supervised
  child host (unchanged).
- `docs/issues_drafts/89-worker-message-delivery-confirmed-consumption.md` (GitHub #373) —
  scenario matrix assumes accurate `deliveryPath`.
- `docs/issues_drafts/95-orchestrator-message-egress-registry.md` (GitHub #298) — **queued**
  related work on orchestrator message single-source; not shipped on `main`.
- `docs/issues_drafts/117-spec-contract-evidence-grounding-gate.md` (GitHub #366) — contract
  evidence discipline.
- Binding-bug pattern (#218 / #381): in-pack config fidelity drift, not upstream AO wire shape.

**Follow-up (out of scope here):** `docs/issues_drafts/127b-dynamic-reaction-delivery-shape-default.md`
— `send-to-agent` reactions whose text is not statically available in YAML
(`changes-requested` today).

## Pre-sync grounding

Gate A captures are declared in `contract-evidence` below (`capture@ao-reaction-*`). AO reaction
events do not carry message body; shape bindings use config text + pane reproduction (provenance
documents both).

## Goal

For `auto: true` / `action: send-to-agent` reactions whose text is **statically declared** in
operator YAML (`reactions.<key>.message`), the submit arbiter must classify delivery shape from
that live text — **never** from a hardcoded stub map that can drift.

Today the live reconcile path (non-`-Fixture`) supplies stub `reactionMessages` that disagree
with YAML: `report-stale` is 73 chars in code vs 224 in config → `self-submitted` →
`tracking_auto_submitted` noop → Enter never dispatched → `delivery_backstop_exhausted` while the
worker pane holds an unsubmitted draft.

Incident: `opk-165:1782123033110:reaction:report-stale` (PR #380, 2026-06-22).

```behavior-kind
action-producing
```

```contract-evidence
binding-id: ao:reaction:event.kind:reaction.action_succeeded
binding-type: structured
binding: AO 0.9.x reaction success event kind for delivered reactions
producer: ao-reaction-event
evidence: capture@ao-reaction-event/report_stale_send
selector: $.kind
expected: reaction.action_succeeded

binding-id: ao:reaction:event.data.action:send-to-agent
binding-type: structured
binding: AO reaction action that delivers text into worker pane
producer: ao-reaction-event
evidence: capture@ao-reaction-event/report_stale_send
selector: $.data.action
expected: send-to-agent

binding-id: ao:reaction:event.data.reactionKey:report-stale
binding-type: structured
binding: Reaction key for report-stale backstop delivery
producer: ao-reaction-event
evidence: capture@ao-reaction-event/report_stale_send
selector: $.data.reactionKey
expected: report-stale

binding-id: ao:reaction:config.message.charLength:gt-200
binding-type: unstructured
binding: Live reactions.report-stale.message exceeds AO paste threshold (200 chars) — pending-draft class
producer: ao-reaction-config
evidence: capture@ao-reaction-config/report_stale_message
token: Worker idle (report-stale backstop)
selector: charLength
expected: gt:200

binding-id: ao:reaction:delivery.pane:unsubmitted-draft
binding-type: unstructured
binding: After AO delivery of report-stale message, worker pane shows unsubmitted input requiring second Enter
producer: ao-reaction-delivery
evidence: capture@ao-reaction-delivery/report_stale_worker_pane
token: Worker idle (report-stale backstop)
selector: paneContainsUnsubmittedDraft
expected: true
```

## Design analysis (pre-draft gate)

### Critical mechanics

- Submit reconcile observes `reaction.action_succeeded` + `send-to-agent` events.
- Shape (paste vs literal) drives `deliveryPath` → submit vs noop.
- AO paste threshold: multiline **or** charLength > 200.
- Reaction path reads `reactionMessages[reactionKey]` from a reconcile-supplied map — not from
  event payload or dispatch journal.
- Missing map keys → silent `continue`.

### Architecture sketch

```
reactions.<key>.message (YAML, static only) ──► AO delivers to pane
        │                                              │
        │ (must match)                                 ▼
        │                                     [unsubmitted draft]
        X today: stale stub map
        ▼
wrong deliveryPath → tracking_auto_submitted noop
```

### Options (illustrative — planner picks mechanism)

| Option | Cost | Risk | Sufficient for **this** slice? |
|--------|------|------|-------------------------------|
| Resolve shape from live `reactions.*.message` in operator config | Low | Low for static keys only | **Yes** for static-text reactions |
| Record reaction text in dispatch journal at send time | Medium | Low | Yes, but wider than needed here |
| Pane scrape for shape | High | High (#232 forbids) | No |

**Invariant (not a prescribed implementation):** for reactions with static YAML `message:`, shape
classification MUST use that live text or an equally authoritative delivery record — never a
drifting in-code duplicate. Dynamic-text reactions are **out of scope** (see `127b`).

### In-scope class matrix (static message only)

| Dimension | Class | Expected outcome |
|-----------|-------|------------------|
| Key | `report-stale`, YAML message >200 chars | `pending-draft` → Enter dispatched |
| Key | Same key, stub <200 chars (negative) | Must **not** classify from stub when YAML is longer |
| Key | Static message present in YAML, absent from old stub map | Shape resolved from YAML |
| Key | `ci-failed` stub present but YAML is `notify` | No false reaction-shape tracking |
| Form | charLength 201 | `pending-draft` |
| Form | charLength 199 | `self-submitted` |
| Form | Multiline, total <200 chars | `pending-draft` |
| Branch | Correct `pending-draft`, idle worker | `submit`, `submitted≥1` |
| Branch | Wrong `self-submitted` on pending-draft | Must not `tracking_auto_submitted` loop |

## Binding surface

- **Static-text reactions only.** For `send-to-agent` reactions with a non-empty
  `reactions.<key>.message` in live operator config, `deliveryPath` MUST be derived from that
  text (or an equally authoritative AO delivery record the planner identifies) — never from a
  hardcoded stub.
- **Remove stale stub entries** that misrepresent live config (e.g. `ci-failed` text while live
  reaction is `notify`).
- **Drift regression guard.** CI fails if resolved shape for a fixture static reaction diverges
  from example-YAML text (minimum: `report-stale`).
- **Preserves #232 invariants.** Human input never triggers submit; truly short self-submitted
  paths remain no-op.

**Operator adoption.** No new process. `ao stop` / `ao start` after reconcile script deploy if
supervisor child must restart (#205).

## Files in scope

- Submit reconcile / reaction observation wiring for **static-text** reactions.
- Regression fixtures and CI guards for matrix above.
- Existing `capture@ao-reaction-*` manifest entries (keep in sync if paths change).

## Files out of scope

- `vendor/**`, `packages/core/**`, `.ao/**`.
- **Dynamic-text `send-to-agent` reactions** (`changes-requested` — no static `message:` in
  YAML; AO generates body; event carries no text). See `127b` and `parked-root-cause` below.
- Changing `reactions.report-stale` prose (operator choice).
- Upstream AO single-Enter-after-paste fix.
- Full #298 message-catalog audit.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

## Acceptance criteria

```positive-outcome
asserts: on capture-backed report-stale reaction delivery (charLength 224, pending-draft class), submit arbiter dispatches Enter at least once before terminal escalation — not tracking_auto_submitted noop for the full backstop window
input: external-tool-output
provenance: capture-backed
```

1. **Shape fidelity (report-stale).** Gate A captures: `deliveryPath` is `pending-draft` (224),
   not `self-submitted` (73-char stub). Fails on current `main`.
2. **Threshold boundary.** charLength 199 → `self-submitted`; 201 → `pending-draft`.
3. **Multiline short.** Multiline static message with total charLength <200 → `pending-draft`.
4. **Submit action.** `pending-draft` report-stale on idle worker → `submit`; integration path
   records `submitted≥1`.
5. **No stale ci-failed stub.** Live `ci-failed` is `notify` — stub-map text must not drive
   reaction-shape tracking (negative control).
6. **Drift guard.** CI fails when example-YAML `report-stale` shape diverges from arbiter
   resolution.
7. **Incident recurrence.** `opk-165:1782123033110:reaction:report-stale`: corrected shape →
   submit attempts; stub shape → negative control (pre-fix fail).
8. **Escalation after submit budget.** `delivery_backstop_exhausted` only after bounded submit
   attempts on correct `pending-draft` — not immediate `tracking_auto_submitted` loop.

## Parked class (pre-sync — add `parked-root-cause` fence with `#N` when `127b` syncs)

- **cause:** `send-to-agent` reactions without static `reactions.<key>.message` (`changes-requested`
  today) cannot have shape resolved from YAML; AO generates text dynamically; events carry no
  body; pane scrape forbidden (#232).
- **evidence:** live yaml — `changes-requested` has `send-to-agent`, no `message:`; silent
  `continue` when stub map lacks key (`extractReactionDeliveries`); no-silent-drop invariant
  and review-send overlap proof belong in `127b`.
- **reason-deferred:** #127 YAML-read returns empty shape; touching the `continue` path for
  dynamic keys is out of scope here; default-safe policy + audit invariant → `127b`.
- **follow-up:** `docs/issues_drafts/127b-dynamic-reaction-delivery-shape-default.md` → assign
  `#N` before publish and replace this section with a `parked-root-cause` fence.
- **resolution-policy:** static slice resolved by #127; dynamic class reopens via #127b only.

## Upgrade-safety check

- Pack-only; no AO core bump.
- Existing dispatch-journal deliveries unaffected.
- Supervisor child restart per #205 after deploy.

## Verification

- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/127-reaction-delivery-shape-stub-drift.md`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/127-reaction-delivery-shape-stub-drift.md`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command parked-root -DraftPath docs/issues_drafts/127-reaction-delivery-shape-stub-drift.md`
- Planner-chosen tests for static-text class matrix.
- `pwsh -NoProfile -File scripts/verify.ps1`

## Decision log

- Decomposed from original single draft per architect review 2026-06-22: static slice shippable
  here; dynamic slice → `127b`.
- New issue (not fold into #232/#373): drift-guard ACs specific to config-fidelity regression.
