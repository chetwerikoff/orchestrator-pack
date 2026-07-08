# Retire `ci-failure-orchestrator-turn` — reconcile-only CI-failure notification ownership

GitHub Issue: #645

## Prerequisite

- `docs/issues_drafts/90-ci-failure-notify-cross-path-dedup.md` (GitHub #283) — **already does:** reaction-first CI-failure episode dedup, atomic intent claims, orchestrator-turn decision defers to reaction event and worker `fixing_ci` state.
- `docs/issues_drafts/110-ci-failure-ping-suppress-on-live-worker-state.md` (GitHub #342) — **already does:** enqueue-only reaction child, single live-state evaluation at delivery, pending→terminal episode lifecycle; reconcile path owns heavy lifetime management.
- `docs/issues_drafts/135-ci-failure-suppressor-progress-stale-escalation.md` (GitHub #439) — **already does:** stale same-head `fixing_ci` escalation via reconcile only (`progress_stale`).
- `docs/issues_drafts/144-ci-failure-orchestrator-turn-fixing-stint-suppression.md` (GitHub #459) — **already does:** cross-head suppression during live fixing-CI stint; shared suppression predicate before claim and post-stale escalation lock on both surfaces. **This draft preserves that semantic on the reconcile path only** — orchestrator-turn delivery is removed, not redesigned.
- `docs/issues_drafts/95-orchestrator-message-egress-registry.md` (GitHub #298) — **already does:** message catalog + generated `docs/orchestrator-message-map.md`; this draft extends with a zero-`orchestrator-rules`-owner invariant guard.
- `docs/issues_drafts/212-ao-010-review-pipeline-vocabulary-migration.md` (GitHub #625) — **sibling, out of scope:** review vocabulary + rules-surface shrink; does not own CI-failure message-class retirement.
- `docs/issues_drafts/219-orchestrator-escalation-contract.md` (GitHub #641) — **sibling, out of scope:** escalation delivery contract; explicitly defers `ci-failure-orchestrator-turn` migration to this draft.
- `docs/issues_drafts/218-journaled-worker-send-0102-argv-cutover.md` (GitHub #640) — **sibling, out of scope:** journaled send argv; reconcile already uses `journaled-worker-send.ps1`.

**Prior-art verdict (draft-author recon 2026-07-06):** **Extends / references existing** — mechanical CI-failure notification is shipped on reaction+reconcile; this draft retires the zombie orchestrator-turn catalog row and dead `orchestratorRules` callsite, adds a durable class invariant, and rebinds #459 coverage. No open draft owns this retirement slice.

**Decomposition check:** One PR — catalog removal + cross-ref co-migration + example-yaml reframe + phrase-guard lockstep + zero-owner guard + test rebinding + gated-nudge ci-failure arm caller-survival verdict. Sibling scopes (#641 escalation routing, #640 send argv, #625 review pipeline) explicitly out.

**Pre-draft design gate (architect brief carry-forward — not re-derived):** On AO 0.10.2, `orchestratorRules` is legacy-import-only — the `ci-failure-orchestrator-turn` recording turn can never fire. The live signal path is fully mechanical: `ci-failure-notification-reaction.ps1` (record, 60s child, `sideEffecting=false`) → `ci-failure-notification-reconcile.ps1` (evaluate, send via `journaled-worker-send.ps1`). Program direction: deterministic side-process scripts own routine orchestration; this is the last worker-bound message class still attributed to `orchestrator-rules`. Durable fix: remove the zombie class **and** guard against any future `owning_process=orchestrator-rules` catalog entry.

### Critical mechanics

- **Zombie catalog row:** `ci-failure-orchestrator-turn` in `scripts/orchestrator-message-catalog.json` (~line 130) has `owning_process=orchestrator-rules`, `mechanism=ao-send`, `delivery_idempotency_owner=none`, callsite anchored to `agent-orchestrator.yaml.example` "CI FAILURE DISCIPLINE" prose (`predicateBodyHash` `3d374368bdefbba9`). AO 0.10.2 never injects `orchestratorRules` — dead path.
- **Live owners:** `ci-failure-reaction-routed` (reaction record) + `ci-failure-reconcile-ping` (reconcile evaluate+send). Both already listed in `semanticDedupCoverage.messageClassIds` alongside the zombie class (~lines 118, 152, 247–252).
- **Suppression semantics (#459):** `evaluateCiFailureSuppressorDecision` in `docs/ci-failure-notification.mjs` is surface-parameterized; reconcile already calls it. Cross-head fixing-stint bridge, post-stale escalation lock, and reconcile-owned stale deference must remain exercised **against reconcile** after turn retirement.
- **Phrase guard coupling:** `scripts/check-ci-failure-notification.ps1` requires phrases including `CI FAILURE DISCIPLINE` and `phase=record` in `agent-orchestrator.yaml.example`. Prose reframe must update the phrase list in lockstep — do not weaken silently.
- **Gated-nudge ci-failure arm:** `scripts/invoke-gated-worker-nudge.ps1` (~lines 203–224) assembles `ci-failure` gate payload with default `targetResolutionSource=orchestrator-turn`. Corpus search finds **zero production callers** invoking `invoke-gated-worker-nudge.ps1` with `ci-failure` intent; reconcile sends exclusively via `journaled-worker-send.ps1`. The arm is turn-only scaffolding + unit tests.

### Industry / world practice

Strangle dead configuration paths: retire unused catalog ownership, re-attribute to the live mechanical owner, and add a static invariant so the dead class cannot re-enter without an explicit spec change.

### Architecture sketch

```
[red required-check signal on open worker PR]
        |
        v
 +---------------------------+
 | ci-failure-notification-  |  owning_process: ci-failure-notification-reaction
 | reaction.ps1 (record)     |  class: ci-failure-reaction-routed
 +-------------+-------------+
               | pending episode (phase=record)
               v
 +---------------------------+
 | ci-failure-notification-  |  owning_process: ci-failure-notification-reconcile
 | reconcile.ps1 (evaluate)  |  class: ci-failure-reconcile-ping
 +-------------+-------------+
               | evaluateCiFailureSuppressorDecision(surface=reconcile)
               v
 +---------------------------+
 | journaled-worker-send.ps1 |
 +---------------------------+

[REMOVED] orchestratorRules "CI FAILURE DISCIPLINE" turn recording
          ci-failure-orchestrator-turn catalog row
          invoke-gated-worker-nudge ci-failure arm (dead)
```

### Options (cost / risk / sufficiency)

| Option | Cost | Risk | Sufficient |
| --- | --- | --- | --- |
| **A — Remove zombie class + cross-refs, reframe yaml as operator reference, add zero-`orchestrator-rules` guard, rebind #459 tests to reconcile-only** | Medium | Must not drop suppression fixtures; phrase guard must stay green | **Yes (recommended)** |
| **B — Keep catalog row but mark `deprecated` / `inactive`** | Low | Zombie remains; future drift; does not satisfy program direction | No |
| **C — Rewire turn to call `invoke-gated-worker-nudge` with `ci-failure` intent** | Medium | Re-introduces LLM-orchestrator ownership; contradicts operator direction | No |

**Chosen: A.** Extends shipped reaction+reconcile pair (#283/#342/#439) and #459 suppression — cheapest sufficient executor. B leaves the dead class. C reverses program direction.

### Gated-nudge ci-failure arm — caller-survival verdict (pre-recon)

| Evidence | Result |
| --- | --- |
| Production callers of `invoke-gated-worker-nudge.ps1` with `IntentClass=ci-failure` | **0** (corpus search; only `task-continuation` and `review-findings` in live yaml prose) |
| Reconcile send path | `journaled-worker-send.ps1` only — no `invoke-gated-worker-nudge` reference |
| Test callers | `worker-nudge-gate.test.ts` unit tests + `ci-failure-fixing-stint-orchestrator-turn.test.ts` surface-parameterized fixtures |
| **Verdict** | **DEAD for production** — retire the `ci-failure` branch in `invoke-gated-worker-nudge.ps1` (fail-closed or remove) and rebind/remove turn-surface fixtures; do not blind-delete without replacement assertions on reconcile |

## Goal

Remove the zombie `ci-failure-orchestrator-turn` message class and every cross-reference to it; reframe `agent-orchestrator.yaml.example` CI FAILURE DISCIPLINE prose as **operator reference** to the mechanical reaction+reconcile pair (not orchestrator instruction); add a catalog guard that fails CI if any entry regains `owning_process=orchestrator-rules`; prove red-CI worker notification and #459 fixing-stint suppression survive on the reconcile path only; deliver an evidence-backed caller-survival verdict on the gated-nudge ci-failure arm and retire it if dead.

```behavior-kind
action-producing
```

```complexity-tier
tier: T2
advisory-prior: T2
```

## Binding surface

- **Catalog removal (binding):** Delete the `ci-failure-orchestrator-turn` entry from `scripts/orchestrator-message-catalog.json` and remove `ci-failure-orchestrator-turn` from every `semanticDedupCoverage.messageClassIds` list (three ci-failure-related entries). Regenerate `docs/orchestrator-message-map.md` via the existing generator — do not hand-edit if generator-owned.
- **Cross-ref co-migration:** Update `scripts/orchestrator-message-owner-mechanisms.manifest.json`, `docs/orchestrator-message-registry.mjs`, and any audit JSON surfaces that enumerate the removed class (e.g. `docs/submit-reconcile-delivery-source-audit.json` if still referenced).
- **Zero-owner invariant (durable class fix):** New guard (planner picks script name) asserts `scripts/orchestrator-message-catalog.json` contains **zero** entries with `owning_process=orchestrator-rules`. Wired into the same CI path that consumes the catalog today (`scripts/verify.ps1` and/or `scripts/orchestrator-message-registry.test.ts`).
- **Example yaml reframe:** `agent-orchestrator.yaml.example` CI FAILURE DISCIPLINE block (~line 134) and bottom reference (~line 565) describe the mechanical pair as operator reference — reaction records (`phase=record`), reconcile evaluates and sends. Remove any prose implying the orchestrator turn **records** or **owns** CI-failure delivery. **Do not edit live `agent-orchestrator.yaml`.**
- **Phrase guard lockstep:** `scripts/check-ci-failure-notification.ps1` phrase list updated in the same PR if prose changes; guard must pass with reframed operator-reference wording.
- **#459 suppression preservation:** Existing `evaluateCiFailureSuppressorDecision` semantics unchanged. Tests that today pass `surface: 'orchestrator-turn'` must be **rebound or replaced** to exercise `surface: 'ci-failure-notification-reconcile'` (or direct reconcile module entry points) with equivalent scenario matrix cells — no silent deletion of suppression coverage.
- **Gated-nudge arm retirement:** Because the caller-survival verdict is **DEAD**, remove or fail-closed the `ci-failure` intent path in `invoke-gated-worker-nudge.ps1`; update `docs/worker-nudge-gate.mjs` only if needed to keep reconcile path clean. Document caller-search evidence in test or AC commentary.

```contract-evidence
binding-id: orchestrator-pack:catalog-ci-failure-orchestrator-turn-absent:no-entry-no-dedup-reference
binding: message catalog contains no entry with message_class_id ci-failure-orchestrator-turn
producer: orchestrator-pack
binding-type: structured
evidence: NEW(produced-by AC#1)
selector: $.entries[?(@.message_class_id=='ci-failure-orchestrator-turn')]
expected: []

binding-id: orchestrator-pack:catalog-zero-orchestrator-rules-owner:guard-fails-on-reintroduction
binding: message catalog contains zero entries with owning_process orchestrator-rules
producer: orchestrator-pack
binding-type: structured
evidence: NEW(produced-by AC#2)
selector: $.entries[?(@.owning_process=='orchestrator-rules')]
expected: []

binding-id: orchestrator-pack:ci-failure-fixing-stint.suppressReason:suppressed-live-worker
binding: reconcile-path ci-failure suppresses with live-worker reason when fixing stint open across head churn
producer: orchestrator-pack
binding-type: structured
evidence: NEW(produced-by AC#4)
selector: $.ci-failure-fixing-stint.suppressReason
expected: suppressed-live-worker

binding-id: orchestrator-pack:catalog-ci-failure-reconcile-ping-owner:ci-failure-notification-reconcile
binding: catalog retains ci-failure-reconcile-ping as reconcile-owned delivery class
producer: orchestrator-pack
binding-type: structured
evidence: NEW(produced-by AC#3)
selector: $.entries[?(@.message_class_id=='ci-failure-reconcile-ping')].owning_process
expected: ci-failure-notification-reconcile

binding-id: orchestrator-pack:check-ci-failure-notification:phrase-guard-pass
binding: check-ci-failure-notification.ps1 passes on reframed agent-orchestrator.yaml.example
producer: orchestrator-pack
binding-type: cli-behavior
evidence: NEW(produced-by AC#6)
selector: exit-code
expected: 0
```

**Operator adoption:** After merge, operators who copied old CI FAILURE DISCIPLINE prose from `agent-orchestrator.yaml.example` should re-copy the reframed operator-reference block. No live yaml edit in this PR. Reaction+reconcile side-process children are already supervisor-managed — no new adoption steps beyond optional yaml example refresh.

## Files in scope

- `scripts/orchestrator-message-catalog.json` — remove zombie entry + dedup list references
- `scripts/orchestrator-message-owner-mechanisms.manifest.json` — co-migrate
- `docs/orchestrator-message-registry.mjs` — co-migrate
- `docs/orchestrator-message-map.md` — regenerate
- `docs/submit-reconcile-delivery-source-audit.json` — remove stale class reference if present
- `agent-orchestrator.yaml.example` — reframe CI FAILURE DISCIPLINE as operator reference
- `scripts/check-ci-failure-notification.ps1` — phrase list lockstep update
- `scripts/**` — new zero-`orchestrator-rules`-owner guard; test updates for catalog/registry
- `scripts/invoke-gated-worker-nudge.ps1` — retire dead `ci-failure` arm
- `docs/worker-nudge-gate.mjs` — only if needed after arm retirement
- `scripts/ci-failure-fixing-stint-orchestrator-turn.test.ts` — rebind to reconcile surface (rename optional)
- `scripts/orchestrator-message-registry.test.ts` — assert absence + zero-owner guard
- `scripts/worker-nudge-gate.test.ts` — update if turn-surface ci-failure fixtures removed
- `tests/**` — replacement assertions as needed

## Files out of scope

- Escalation contract delivery — **#641** / draft 219
- Journaled send transport argv — **#640** / draft 218
- Review pipeline vocabulary — **#625** / draft 212 / PR #634
- Live `agent-orchestrator.yaml` (gitignored operator copy)
- Heartbeat / listener parameters; episode-store schema; reconcile send semantics redesign
- `prompts/**` orchestrator exception-handler shrink (owned by #625)
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
docs/orchestrator-message-registry.mjs
docs/worker-nudge-gate.mjs
docs/submit-reconcile-delivery-source-audit.json
agent-orchestrator.yaml.example
tests/**
```

## Acceptance criteria

1. **Catalog absence:** `scripts/orchestrator-message-catalog.json` has no `ci-failure-orchestrator-turn` entry and no `semanticDedupCoverage.messageClassIds` list references it. Regenerated `docs/orchestrator-message-map.md` and `docs/orchestrator-message-registry.mjs` agree.

```positive-outcome
asserts: orchestrator-message-catalog.json contains zero entries with message_class_id ci-failure-orchestrator-turn and zero semanticDedupCoverage.messageClassIds lists naming it; orchestrator-message-map.md regenerates without the removed class
input: realistic
```

```producer-emission
producer: orchestrator-pack
datum: catalog-ci-failure-orchestrator-turn-absent
expected: no-entry-no-dedup-reference
proof-command: npm test -- orchestrator-message-registry -t "ci-failure-orchestrator-turn absent"
```

2. **Zero `orchestrator-rules` owner invariant:** A new guard fails CI when any catalog entry has `owning_process=orchestrator-rules`. Guard is wired into the catalog CI path (verify and/or registry test suite).

```producer-emission
producer: orchestrator-pack
datum: catalog-zero-orchestrator-rules-owner
expected: guard-fails-on-reintroduction
proof-command: npm test -- orchestrator-message-registry -t "zero orchestrator-rules owner"
```

3. **Reconcile-only ownership survives:** Catalog retains `ci-failure-reaction-routed` and `ci-failure-reconcile-ping` with correct `owning_process` values. A test asserts end-to-end red-CI notification coverage is owned by the reaction+reconcile pair — not the removed class.

```producer-emission
producer: orchestrator-pack
datum: catalog-ci-failure-reconcile-ping-owner
expected: ci-failure-notification-reconcile
proof-command: npm test -- orchestrator-message-registry -t "ci-failure reconcile ownership"
```

4. **#459 fixing-stint suppression on reconcile path:** The scenario matrix from #459 (cross-head bridge, post-stale escalation lock, newly-red-during-open-stint, cold-path SEND, class A/B/C matrix) is demonstrably exercised with `surface: 'ci-failure-notification-reconcile'` (or direct reconcile module entry points). No suppression AC is silently deleted — removed `orchestrator-turn` surface fixtures are replaced with reconcile-bound equivalents.

```producer-emission
producer: orchestrator-pack
datum: ci-failure-fixing-stint.suppressReason
selector: $.ci-failure-fixing-stint.suppressReason
expected: suppressed-live-worker
proof-command: npm test -- ci-failure-fixing-stint
```

5. **Gated-nudge ci-failure arm caller-survival + retirement:** Document evidence (caller search + test inventory) that production had zero `invoke-gated-worker-nudge.ps1` callers with `ci-failure` intent. The dead arm is retired (removed or fail-closed). Any removed test documents what reconcile-bound assertion replaces it.

6. **Example yaml operator reference + phrase guard:** `agent-orchestrator.yaml.example` CI FAILURE DISCIPLINE prose reads as operator reference to the mechanical reaction+reconcile pair (record via reaction child, evaluate/send via reconcile child). `scripts/check-ci-failure-notification.ps1` passes with its phrase list updated in the same PR.

```producer-emission
producer: orchestrator-pack
datum: check-ci-failure-notification
expected: phrase-guard-pass
proof-command: pwsh -NoProfile -File scripts/check-ci-failure-notification.ps1
```

7. **Registry test suite green:** `scripts/orchestrator-message-registry.test.ts` updated for removed class; no test deletion without replacement assertion that the signal is owned by `ci-failure-reaction-routed` + `ci-failure-reconcile-ping`.

## Upgrade-safety check

- Pack-owned `scripts/**`, `docs/orchestrator-message-map.md`, and `agent-orchestrator.yaml.example` only; no AO core edits.
- No new delivery mechanism or episode-store schema change — removal and re-attribution only.
- `orchestratorRules` yaml keys remain inert on AO 0.10.2; this draft does not bind new automation to them.
- Sibling drafts (#641, #640, #625) scopes untouched.
- Suppression semantics (#342/#363/#439/#459) preserved on reconcile — not redesigned.

## Verification

- `npm test -- ci-failure-fixing-stint` (or renamed reconcile-bound suite)
- `npm test -- orchestrator-message-registry`
- `npm test -- worker-nudge-gate` (if fixtures change)
- `pwsh -NoProfile -File scripts/check-ci-failure-notification.ps1`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/220-ci-failure-orchestrator-turn-class-retirement.md`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/220-ci-failure-orchestrator-turn-class-retirement.md`
- `pwsh -NoProfile -File ./scripts/verify.ps1` green (or cite unrelated blockers)