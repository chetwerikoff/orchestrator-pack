# Submit reconcile adoption and consumption proof

GitHub Issue: #602

## Prerequisite

- `docs/issues_drafts/77-worker-message-submit-source-agnostic.md`
  (GitHub #232, closed) shipped the source-agnostic submit arbiter: AO delivery
  state drives Enter submission, not caller identity or pane text.
- `docs/issues_drafts/89-worker-message-delivery-confirmed-consumption.md`
  (GitHub #281/#373, closed) shipped journaled worker-send adoption probing and
  `wrapper_not_adopted` escalation. This draft strengthens the adoption proof
  and its interaction with submit reconcile; it must not add a parallel worker
  send path.
- `docs/issues_drafts/92-arbiter-budget-eligibility-resume.md`
  (GitHub #293, closed) moved retry eligibility to consumption evidence and
  introduced the `busy_dispatch_environment_unknown` class when busy-dispatch
  proof is missing. This draft fixes the false-consumption sibling cell.
- PR #601, "Fix submit reconcile empty quarantine self-heal", reclaimed stale
  orphan anchors and explicitly left `wrapper_not_adopted` as a separate
  runtime/PATH follow-up axis. This draft owns that follow-up plus the masking
  false-consumed defect; it must not weaken #601 anchor reclaim.

Prior-art verdict: **extension of shipped submit-reconcile and journaled-send
contracts, not a new mechanism**. Coworker prior-art recon found no open or
unsynced local draft that already owns the combined `wrapper_not_adopted` plus
false `consumed` class. Existing work covers the arbiter, adoption probe, busy
smoke marker, and #601 orphan-anchor latch; this draft binds the missing
end-to-end proof that the orchestrator's `ao send` route actually uses
`scripts/journaled-worker-send.ps1` and that submit reconcile marks delivery
`consumed` only after observed consumption.

Knowledge-base consult: `wiki` search found `Wire Tap`, `Event-Driven Consumer`,
and `Guaranteed Delivery`: audit/inspection, actual receive, and durable send
receipt are separate facts. `synto` returned no published article for this
repo-specific defect. Applied here: `submitted`, `busy_dispatch_environment_unknown`,
`absent`, and lack of a journal record are not consumption proof.

## Goal

Make worker-message submit reconcile prove both halves of the delivery path:
the live orchestrator worker-send route is adopted by `journaled-worker-send`,
and a delivery is recorded as `consumed` only after observed Enter/flush
consumption. The live incident `opk-134` / `review-run-9754242b` must become
self-diagnosing: no silent loss, no permanent latch, and no blind Enter against
stale draft state.

```behavior-kind
action-producing
```

```complexity-tier
tier: T3
advisory-prior: T3
```

## Binding surface

- The incident chain is load-bearing regression evidence:
  `wrapper_not_adopted` meant the orchestrator's `ao send` path was resolving to
  `scripts/ao`, which `exec`s the real AO binary and does not journal the
  message through `scripts/journaled-worker-send.ps1`. The adoption probe found
  no journal; submit reconcile therefore had no authority to press Enter.
- The masking defect is that `busy_dispatch_environment_unknown` or an
  untrusted `draftState` transition such as `absent` could still transition a
  delivery to `submitted`/`consumed` without positive observed Enter/flush
  evidence. Once that happened, retry stopped and the missing adoption stayed
  permanently hidden.
- Adoption success requires production-shaped evidence that the orchestrator
  route, with the same PATH/config surface used by the live daemon, invokes
  `journaled-worker-send.ps1` and emits a correlatable journal record for the
  delivery identity. A present file, a prose rule, or a successful raw
  `scripts/ao` execution is not enough.
- Consumption success requires an observed post-submit consumption signal for
  the specific delivery identity. The signal must be positive,
  per-delivery-correlated, and observed after the relevant delivery anchor.
  `submitted`, `busy_dispatch_environment_unknown`, "attempted Enter",
  `draftState: absent`, `draftState: unknown`, missing observation data, or a
  missing journal are nonterminal for consumption unless paired with positive
  consumption evidence.
- Every repo-owned worker-message delivery source that can target an AO worker
  must route through the same journaled transport or be explicitly out of scope
  with a reason. At minimum the implementation audits review-send, reaction
  routed delivery, CI-failure/CI-green worker nudges, and orchestrator-turn
  worker nudges against `docs/orchestrator-message-map.md` /
  `docs/orchestrator-message-registry.mjs`.
- Live daemon adoption is part of done. Fixtures prove the state machine, but
  the implementing PR or post-merge checklist must also verify the running AO
  daemon's effective route reports adopted for the worker-send surface. A green
  fixture alone is not sufficient, because #601 passed tests while the live
  daemon route still reported `wrapper_not_adopted`.
- The backstop may press Enter only when the delivery remains live, the draft is
  still current for the same delivery identity, and the environment is idle or
  otherwise proven safe by the existing busy-dispatch smoke contract. It must not
  press Enter for a changed, absent, or superseded draft.
- `wrapper_not_adopted` escalation is bounded and operator-actionable. It should
  reappear when still true after state changes or configured cadence, but the
  same unchanged defect must not spam every tick.
- A delivery that cannot become consumable because adoption/observation remains
  unavailable must reach a bounded terminal escalation that removes it from the
  active delivery count while preserving audit evidence. It must not hold
  `activeDeliveryCount > 0` forever and thereby recreate the #601 latch.
- #601 anchor reclaim remains intact: stale orphan anchors without corroborating
  active state can still be reclaimed. This draft only prevents missing adoption
  and unknown busy dispatch from being misclassified as consumed.

```contract-evidence
binding-id: orchestrator-pack:submit-reconcile:journaled-adoption-required
binding-type: cli-behavior
binding: production-shaped orchestrator worker-send route is adopted only when journaled-worker-send emits a correlatable journal record
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:submit-reconcile:no-false-consumed
binding-type: cli-behavior
binding: busy_dispatch_environment_unknown and submitted without observed Enter/flush never mark a delivery consumed
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)

binding-id: orchestrator-pack:submit-reconcile:idle-backstop-current-draft
binding-type: cli-behavior
binding: delivery backstop presses Enter only for a still-current live delivery when idle or proven safe
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)

binding-id: orchestrator-pack:submit-reconcile:bounded-wrapper-escalation
binding-type: cli-behavior
binding: wrapper_not_adopted escalates without per-tick spam and without suppressing retryable live delivery state
producer: orchestrator-pack
evidence: NEW(produced-by AC#4)

binding-id: orchestrator-pack:submit-reconcile:active-delivery-terminal-escalation
binding-type: cli-behavior
binding: adoption-unavailable or observation-unavailable deliveries stop counting as active only after bounded terminal escalation, not by false consumed
producer: orchestrator-pack
evidence: NEW(produced-by AC#4)
```

## Files in scope

- `scripts/**`
- `docs/**`
- `tests/**`
- `agent-orchestrator.yaml.example` only if the adoption route/example needs a
  documented operator config update
- `prompts/**` only if orchestrator runtime prose must name the corrected route

## Files out of scope

- `vendor/**`
- `packages/core/**`
- `.ao/**`
- `agent-orchestrator.yaml`
- Weakening #601 anchor-reclaim behavior.
- Raw AO core or vendored AO changes.
- Automated blind Enter for a stale, changed, absent, or uncorrelated draft.
- Immediate operator unstick of `opk-134`; that remains a manual Enter outside
  the PR.

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
```

```allowed-roots
scripts/**
docs/**
tests/**
tests/external-output-references/**
agent-orchestrator.yaml.example
prompts/**
```

## Acceptance criteria

1. **Adoption really works.** A production-shaped fixture using the same
   route shape as the orchestrator daemon proves `ao send` reaches
   `scripts/journaled-worker-send.ps1` and creates a correlatable journal record
   for the delivery identity. A fixture where `scripts/ao` merely `exec`s the
   real AO binary without the journaled wrapper reports `wrapper_not_adopted`
   and does not authorize Enter. Verification also includes a live-runtime
   adoption check against the running daemon route, or an explicit post-merge
   operator adoption verification step that blocks declaring the rollout done.

```positive-outcome
asserts: production-shaped orchestrator worker-send routing through journaled-worker-send creates a delivery journal record, and the non-adopted scripts/ao exec path is rejected as wrapper_not_adopted
input: realistic
provenance: capture-backed
```

```producer-emission
producer: orchestrator-pack
datum: submit-reconcile
expected: journaled-adoption-required
proof-command: implementation-specific adoption-route fixture
```

2. **No false consumed.** `busy_dispatch_environment_unknown`, missing
   busy-smoke proof, missing journal, `draftState: absent`,
   `draftState: unknown`, unavailable observation data, or
   submitted-without-positive-consumption evidence never marks a delivery
   `consumed`. Consumption requires a positive, per-delivery-correlated signal
   observed after the relevant delivery anchor. Otherwise the delivery remains
   retryable or escalates according to the existing budget/backstop rules.

```producer-emission
producer: orchestrator-pack
datum: submit-reconcile
expected: no-false-consumed
proof-command: implementation-specific false-consumed regression fixture
```

3. **Idle backstop submits only current live delivery.** When a delivery remains
   live and unconsumed past the delivery backstop, the worker is idle, and the
   draft identity still matches the live delivery, reconcile presses Enter and
   then waits for consumption evidence before marking `consumed`. The same
   backstop no-ops for changed, absent, superseded, or uncorrelated draft state.

```producer-emission
producer: orchestrator-pack
datum: submit-reconcile
expected: idle-backstop-current-draft
proof-command: implementation-specific idle-backstop fixture
```

4. **Escalation is visible without spam.** Persistent `wrapper_not_adopted` or
   persistent unconsumed delivery emits an operator-visible escalation keyed by
   delivery/session/adoption epoch, suppresses duplicate same-state spam, and
   re-emits only after a meaningful state change or configured cadence. After
   the bounded budget is exhausted, the delivery reaches terminal escalated
   state and no longer contributes to active delivery count; it is not marked
   consumed unless positive consumption is later observed.

```producer-emission
producer: orchestrator-pack
datum: submit-reconcile
expected: bounded-wrapper-escalation
proof-command: implementation-specific escalation-dedupe fixture
```

```producer-emission
producer: orchestrator-pack
datum: submit-reconcile
expected: active-delivery-terminal-escalation
proof-command: implementation-specific active-delivery-terminal-escalation fixture
```

5. **Behavioral regression tests cover S1-S7.** Focused tests or fixtures cover
   the scenario matrix below, including the live incident shape
   `opk-134` / `review-run-9754242b` with sanitized identifiers. The tests assert
   behavior, not just log text.

6. **All delivery sources are audited.** Review-send, reaction-routed delivery,
   CI-failure/CI-green nudges, and orchestrator-turn worker nudges are each
   either proven to use the adopted journaled transport or named as a deliberate
   non-worker-message source. Partial adoption for only one source does not
   satisfy this issue.

## Scenario Matrix

| ID | Adoption journal | Busy/idle evidence | Draft state | Consumption evidence | Expected outcome |
|---|---|---|---|---|---|
| S1 | present and correlated | idle or safe | current | observed after Enter | Enter may be sent; then mark consumed |
| S2 | missing because route bypasses wrapper | any | current | none | `wrapper_not_adopted`; no Enter; escalation |
| S3 | present | `busy_dispatch_environment_unknown` | current | none or observation unavailable | keep unconsumed; retry/backstop/escalate, never consumed |
| S4 | present | idle past backstop | current | none before Enter | send one bounded Enter attempt, then wait for consumption proof |
| S5 | present | idle past backstop | changed/superseded | none | no Enter; stale-draft escalation or changed-state resolution |
| S6 | present | busy-safe smoke proven | current | observed after queued Enter | mark consumed only after observed consumption |
| S7 | present or missing | any | absent or identity mismatch | none | no blind Enter; resolve absent/changed or escalate visibly |

## Upgrade-safety check

- No AO core or vendored upstream edits.
- Do not weaken #601 stale orphan-anchor reclaim.
- Do not convert adoption failure into a raw `ao send` fallback.
- Do not treat `submitted` as receipt.
- Do not treat `draftState: absent`, unknown observation, or missing telemetry as
  receipt.
- Do not let adoption-unavailable deliveries pin #601 active-delivery accounting
  forever; terminal escalation must clear active status without pretending
  consumption occurred.
- Do not add new secrets, machine-local state, or unsupported live YAML keys.
- Any operator-facing config/example change must include post-PR adoption steps;
  the PR itself must not modify live `agent-orchestrator.yaml`.

## Verification

- Focused adoption-route tests for AC#1.
- Live daemon-route adoption verification, or a mandatory post-merge operator
  adoption verification checklist that blocks rollout completion.
- Focused submit-reconcile false-consumed tests for AC#2.
- Focused idle/current-draft backstop tests for AC#3.
- Focused escalation dedupe tests for AC#4.
- Scenario fixtures for S1-S7, including a sanitized `opk-134` /
  `review-run-9754242b` reproduction artifact.
- Source audit proving all worker-message delivery sources route through the
  adopted journaled transport.
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/201-submit-reconcile-adoption-and-consumption-proof.md`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/201-submit-reconcile-adoption-and-consumption-proof.md`
- `pwsh -NoProfile -File scripts/check-tier-gate-guard.ps1 -DraftPath docs/issues_drafts/201-submit-reconcile-adoption-and-consumption-proof.md`
- `pwsh -NoProfile -File scripts/verify.ps1`
- `pwsh -NoProfile -File scripts/check-reusable.ps1`

## Decisions

### Design analysis

Critical mechanics are route adoption proof, per-delivery identity correlation,
consumption evidence, current-draft validation, backstop timing, and
restart-safe escalation dedupe. The relevant world practice is the standard
messaging distinction between send/submit audit and consumer acknowledgement:
an audit record can prove that a send path was used, but receipt requires a
separate acknowledgement or consumption observation.

| Option | Cost | Risk | Sufficiency | Decision |
|---|---:|---:|---:|---|
| Operator-only unstick | Low | High: fixes `opk-134` once but leaves recurrence and masking false-consumed | Insufficient | Rejected |
| Blind Enter whenever delivery is old | Low | High: can submit stale or changed draft content and weakens #232 safety | Insufficient | Rejected |
| Extend shipped submit-reconcile and journaled-send contracts in place | Medium | Low-medium: needs production-shaped route fixture and state-machine tests | Sufficient | Chosen |
| Replace the message path with a new queue | High | High: duplicates #232/#373 machinery and increases migration risk | Excessive | Rejected |

### Incident handling

The live `opk-134` unstick is a manual operator action: press Enter in that
worker terminal after verifying the draft is current. The implementation PR
must not encode that one-time manual step as an automated bypass.