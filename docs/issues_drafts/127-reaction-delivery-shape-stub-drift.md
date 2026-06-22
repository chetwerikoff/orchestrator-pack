# Static reaction message shape must not be guessed from a stale in-code stub map

GitHub Issue: #402

## Prerequisite

- `docs/issues_drafts/77-worker-message-submit-source-agnostic.md` (GitHub #232) — shipped
  submit arbiter; classifies `pending-draft` vs `self-submitted` from delivery shape.
  **Regression:** static-text reactions use a hardcoded stub map instead of live config text.
- `docs/issues_drafts/71-orchestrator-side-process-supervisor.md` (GitHub #205) — supervised
  child host (unchanged).
- `docs/issues_drafts/89-worker-message-delivery-confirmed-consumption.md` (GitHub #373) —
  shipped; journaled deliveries including **`review-send`** (Enter / confirmed consumption).
- `docs/issues_drafts/92-arbiter-budget-eligibility-resume.md` (GitHub #293) — shipped;
  Enter-on-busy enqueue-safe for arbiter backstop (#373 surface).
- `docs/issues_drafts/95-orchestrator-message-egress-registry.md` (GitHub #298) — **queued**
  related work on orchestrator message single-source; not shipped on `main`.
- `docs/issues_drafts/117-spec-contract-evidence-grounding-gate.md` (GitHub #366) — contract
  evidence discipline.
- Binding-bug pattern (#218 / #381): in-pack config fidelity drift, not upstream AO wire shape.

## Pre-sync grounding

Gate A captures are declared in `contract-evidence` below (`capture@ao-reaction-*`). AO reaction
events do not carry message body; shape bindings use config text + pane reproduction (provenance
documents both).

**AC1 overlap (code, 2026-06-22):** live dynamic review-findings delivery runs through
`review-send` (`review-send-reconcile.ps1` → `Register-WorkerMessageDispatch` with real
`$reviewMessage` text). Reliability of that path is **#232 / #373 / #293**, not stub-map shape.
`changes-requested` reaction path is **dormant** (0 `reaction.action_succeeded` events / 30d+).
Former follow-up draft `127b` **folded** into this issue — see Decision log.

**Contract-evidence limit:** unstructured rows below are **token-only** grounding (no
machine-checked shape predicates until #125). Shape fidelity is proven by **AC/fixture resolution**
against **live operator YAML**, not by capture decoration.

**Config authority (class-level).** Runtime shape MUST come from the **live operator config AO is
actually running** (typically gitignored `agent-orchestrator.yaml` or operator-configured path) —
**not** from `agent-orchestrator.yaml.example` (committed template) and **not** from in-code stub.
The bug class is «copy drifts from live truth»; fixing stub→example would only move the drift.
`agent-orchestrator.yaml.example` is a **CI/fixture proxy**; live config is **runtime truth**.
Gate A config capture (`report_stale_message`) documents live text at incident time for
example↔live drift checks in AC7.

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

binding-id: ao:reaction:config.message:report-stale-token
binding-type: unstructured
binding: Live reactions.report-stale.message present in operator config capture (shape proved by AC/fixtures)
producer: ao-reaction-config
evidence: capture@ao-reaction-config/report_stale_message
token: Worker idle (report-stale backstop)

binding-id: ao:reaction:delivery.pane:report-stale-token
binding-type: unstructured
binding: Worker pane after report-stale delivery shows unsubmitted draft tail (shape proved by AC/fixtures)
producer: ao-reaction-delivery
evidence: capture@ao-reaction-delivery/report_stale_worker_pane
token: Worker idle (report-stale backstop)
```

## Design analysis (pre-draft gate)

### Critical mechanics

- Submit reconcile observes `reaction.action_succeeded` + `send-to-agent` events.
- Shape (paste vs literal) drives `deliveryPath` → submit vs noop.
- AO paste threshold: multiline **or** charLength > 200.
- Reaction path reads `reactionMessages[reactionKey]` from a reconcile-supplied map — not from
  event payload or dispatch journal.
- **Config authority:** runtime reads **live** operator YAML (gitignored); `.example` is not
  runtime source.
- Missing map keys → silent `continue` today (`extractReactionDeliveries`).
- **Live dynamic findings** use `review-send` journal with real message text — governed by
  #232/#373/#293, not this stub-map defect.

### Architecture sketch

```
reactions.<key>.message (YAML, static) ──► AO delivers to pane
        │                                              │
        │ (must match)                                 ▼
        │                                     [unsubmitted draft]
        X today: stale stub map
        ▼
wrong deliveryPath → tracking_auto_submitted noop

review-send (live dynamic findings) ──► journal + real text ──► #232/#373/#293

changes-requested reaction (dormant) ──► miss in map ──► audit record (AC6), not bare continue
```

### Options (illustrative — planner picks mechanism)

| Option | Cost | Risk | Sufficient for **this** slice? |
|--------|------|------|-------------------------------|
| Resolve shape from live `reactions.*.message` in operator config at observation tick | Low | Low for static keys; config may change between AO delivery and tick | **Yes** for static-text reactions (accepted trade vs journal-at-delivery) |
| Record reaction text in dispatch journal at send time | Medium | Low | Yes, wider than needed here (Option B if rollover risk unacceptable) |
| Pane scrape for shape | High | High (#232 forbids) | No |

**Invariant (not a prescribed implementation):** for reactions with static YAML `message:`, shape
classification MUST use that live text or an equally authoritative delivery record — never a
drifting in-code duplicate.

### In-scope class matrix (static message + visibility guard)

| Dimension | Class | Expected outcome |
|-----------|-------|------------------|
| Key | `report-stale`, YAML message >200 chars | `pending-draft` → Enter dispatched |
| Key | Same key, stub <200 chars (negative) | Must **not** classify from stub when YAML is longer |
| Key | Static message present in YAML, absent from old stub map | Shape resolved from YAML |
| Key | `ci-failed` stub present but YAML is `notify` | No false reaction-shape tracking |
| Key | Reaction key, no resolvable text (e.g. `changes-requested`) | Named audit — not bare `continue` |
| Form | charLength 201 | `pending-draft` |
| Form | charLength 199 | `self-submitted` |
| Form | Multiline, total <200 chars | `pending-draft` |
| Branch | Correct `pending-draft`, idle worker | `submit`, `submitted≥1` |
| Branch | Wrong `self-submitted` on pending-draft | Must not `tracking_auto_submitted` loop |

## Binding surface

- **Static-text reactions only.** For `send-to-agent` reactions with a non-empty
  `reactions.<key>.message` in **live operator config** (the file AO actually runs — not
  `agent-orchestrator.yaml.example`), `deliveryPath` MUST be derived from that text at observation
  time (or an equally authoritative delivery record the planner identifies) — never from a
  hardcoded stub or committed example template.
- **Audit on miss (visibility only).** Observed `send-to-agent` reaction whose key has no
  resolvable message text (empty YAML `message:`, not in config) → observable
  `reason=reaction_message_unresolved` (log or fixture field) — never bare `continue`. Does
  **not** add delivery tracking, Enter obligation, or default-safe shape (live dynamic
  findings: `review-send` + #232/#373/#293).
- **Config read/parse failure (static keys).** Named defer/escalate — never stub fallback or
  silent skip; observable `reason=reaction_config_unavailable`.
- **Remove stale stub entries** that misrepresent live config (e.g. `ci-failed` text while live
  reaction is `notify`).
- **Drift regression guard (two layers).** (1) **Runtime:** never resolve shape from example or
  stub — live operator config only. (2) **CI:** `agent-orchestrator.yaml.example` is a test proxy;
  CI fails when arbiter-resolved shape for `report-stale` disagrees with example **or** when
  example `report-stale` message text disagrees with Gate A live config capture
  (`capture@ao-reaction-config/report_stale_message`).
- **Preserves #232 invariants.** Human input never triggers submit; truly short self-submitted
  paths remain no-op.

**Operator adoption.** No new process. `ao stop` / `ao start` after reconcile script deploy if
supervisor child must restart (#205).

## Files in scope

- Submit reconcile / reaction observation wiring for **static-text** reactions.
- `extractReactionDeliveries` audit-on-miss for unresolvable reaction keys (same edit surface).
- Regression fixtures and CI guards for matrix above.
- Existing `capture@ao-reaction-*` manifest entries (keep in sync if paths change).

## Files out of scope

- `vendor/**`, `packages/core/**`, `.ao/**`.
- **Default-safe shape / Enter policy** for dynamic-text reactions when text is unknown — live
  dynamic findings delivery is `review-send` (#232/#373/#293); `changes-requested` reaction
  path dormant (0 events/30d+).
- Changing `reactions.report-stale` prose (operator choice).
- Upstream AO single-Enter-after-paste fix.
- Full #298 message-catalog audit.

## Denylist / allowed-roots

```denylist
vendor/**
packages/core/**
.ao/**
```

```allowed-roots
scripts/**
docs/worker-message-dispatch-observe.mjs
tests/external-output-references/**
```

## Acceptance criteria

```positive-outcome
asserts: on capture-backed report-stale reaction delivery (charLength 224, pending-draft class), submit arbiter dispatches Enter at least once before terminal escalation — not tracking_auto_submitted noop for the full backstop window
input: external-tool-output
provenance: capture-backed
```

1. **Shape fidelity (report-stale).** Gate A captures ground incident inputs (event, config text,
   pane). **Fixture or integration** asserts arbiter `deliveryPath` is `pending-draft` (224),
   not `self-submitted` (73-char stub). Fails on current `main`.
2. **Threshold boundary.** charLength 199 → `self-submitted`; **200** → `self-submitted`;
   201 → `pending-draft` (proves strict `> 200`, not `>= 200`).
3. **Multiline short.** Multiline static message with total charLength <200 → `pending-draft`.
4. **Submit action.** `pending-draft` report-stale on idle worker → `submit`; integration path
   records `submitted≥1`.
5. **No stale ci-failed stub.** Live `ci-failed` is `notify` — stub-map text must not drive
   reaction-shape tracking (negative control).
6. **Audit on miss (visibility only).** `changes-requested` (or any key with no resolvable
   text) `reaction.action_succeeded` fixture → reconcile tick emits an **observable** outcome:
   log line or fixture field containing `reason=reaction_message_unresolved` and
   `reactionKey=<key>` — not bare `continue` with zero trace. Does **not** create a tracked
   delivery, Enter attempt, or shape classification (live dynamic findings: `review-send`).
6b. **Config read failure (static keys).** Fixture: static reaction key present in YAML but
   config read/parse unavailable at tick → observable `deferred` or `escalated` outcome with
   `reason=reaction_config_unavailable` (or fixture-equivalent field) — not stub fallback, not
   silent skip.
7. **Drift guard (live vs example).** **Runtime:** integration/fixture with explicit live-config
   message text (or config-read from fixture path standing in for live file) — not
   `agent-orchestrator.yaml.example` as runtime source. **CI:** fails when (a) arbiter-resolved
   `report-stale` shape disagrees with example proxy, **or** (b) example `report-stale` message
   text disagrees with `capture@ao-reaction-config/report_stale_message` (live truth at incident).
8. **Incident recurrence.** `opk-165:1782123033110:reaction:report-stale`: corrected shape →
   submit attempts; stub shape → negative control (pre-fix fail).
9. **Escalation after submit budget.** `delivery_backstop_exhausted` only after the
   configured per-delivery submit attempt budget is exhausted on correct `pending-draft`
   classification — not before budget consumption, not immediate `tracking_auto_submitted` loop.

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
- `pwsh -NoProfile -File scripts/check-reusable.ps1`

## Decision log

- Decomposed from original single draft per architect review 2026-06-22; static slice shippable
  here; dynamic slice initially → `127b`.
- New issue (not fold into #232/#373): drift-guard ACs specific to config-fidelity regression.
- **#127b folded (2026-06-22, AC1 code verdict).** `review-send-reconcile.ps1` registers
  deliveries with real `$reviewMessage` via `Register-WorkerMessageDispatch` — shape correct;
  Enter/consumption/busy-enqueue governed by **#232/#373/#293**. `changes-requested` reaction
  dormant (0 events/30d+). Remaining work is one visibility guard (AC6 audit-on-miss in
  `extractReactionDeliveries`) — below decomposition threshold for a standalone issue; no
  `parked-root-cause` fence or follow-up issue. Former P1-A split rationale (no-silent-drop +
  delivery policy) obsolete once live path ownership confirmed.
- **No deferred build** for dynamic findings delivery — `review-send` is live owner; sleeping
  reaction path closed by AC6 audit record only.
- **Adversarial Codex pass 1 (needs-attention):**
  - *Config-at-tick vs delivery-time skew* — **partial accept:** documented trade in options
    table; journal-at-delivery remains wider alternative; rollover ACs out of scope for stub-drift
    incident class.
  - *Unstructured capture selectors inert* — **partial accept:** honest limit in Pre-sync;
    shape proof via AC/fixtures not selector fields; #125 queued for machine grounding.
  - *Audit-only leaves pane stuck for unknown keys* — **reject** for full fail-closed delivery
    policy (folded with #127b; live path is review-send); **partial** via AC6b config-read
    failure for static keys.
- **Architect Codex pass 1 (P2):** observable `reason=` tokens for AC6/AC6b — **accept**;
  `allowed-roots` fence — **accept**.
- **Architect Codex pass 2 (P2):** AC1 capture vs `deliveryPath` assertion split — **accept**.
- **Architect Codex pass 3 (P2):** add `check-reusable.ps1` to Verification — **accept**.
- **Architect Codex pass 4 (P2, cap):** charLength=200 boundary + submit-budget exhaustion —
  **accept**; no further Codex iteration (5-pass limit).
- **Architect final P1 (post-cap):** live operator config is runtime truth; `.example` is CI/fixture
  proxy only; AC7/binding drift guard catches example↔live capture drift — closes «stub→example»
  class relocation.
