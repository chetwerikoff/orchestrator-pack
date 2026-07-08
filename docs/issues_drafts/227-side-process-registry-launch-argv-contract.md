# Side-process registry launch argv contract — escalation-router fix + fleet guard

GitHub Issue: #659

## Prerequisite

- `docs/issues_drafts/219-orchestrator-escalation-contract.md` (GitHub #641, **merged**) — **already does:** escalation event schema, publish/router/ack semantics, operator inbox, and registers `escalation-router` as a required wake-supervisor child with ~30s redelivery cadence for `llm-orchestrator` route. **This draft does not touch those semantics** — only the child's launch argv binding and a fleet-wide guard against registry↔script drift.
- `docs/issues_drafts/71-orchestrator-side-process-supervisor.md` (GitHub #205, **merged**) — **already does:** wake supervisor, registry-driven child spawn, `PassProjectId` / `RequiresOrchestratorSession` / `extraArgs` argv derivation in `Start-OrchestratorWakeSupervisorChild`, crash-backoff quarantine. Backoff behavior is **out of scope** here (symptom only).
- `docs/issues_drafts/217-worker-recovery-spawn-argv-ao-0-10-2.md` (GitHub #638, **merged**) and `docs/issues_drafts/223-worker-recovery-spawn-grant-prompt-convergence.md` (GitHub #652, **merged**) — **already does:** narrow dead-argv class fix for autonomous recovery `ao spawn` argv (positional token, missing `--prompt`). **Class precedent** for "caller builds argv child cannot bind"; this draft generalizes the lesson to **all** registry children, not recovery spawn.
- `docs/issues_drafts/138-supervisor-children-gh-rest-shim-path.md` (GitHub #447, **merged**) — **already does:** supervisor-child PATH prepend for `gh` shim resolution. Orthogonal to argv/param binding; no overlap.

**Prior-art verdict (draft-author recon 2026-07-07):** **Genuinely new** for the fleet registry↔script launch-contract guard. Corpus + queue index search found no open or merged draft owning "validate every `orchestrator-side-process-registry.json` child's declared launch flags against its script param block." #638/#652 fixed one external-CLI argv surface; #641 shipped escalation-router registration but did not exercise supervisor-constructed argv in CI.

**Decomposition check:** One PR — case fix (`escalation-router` binds supervisor argv and completes ticks) plus class guard (all 15 `children[]` entries). Splitting guard from case fix would leave the #641 failure shape mergeable without enforcement and recreate silent prod death.

**Pre-draft design gate (architect brief carry-forward — light T2 pass):** The failure is launch plumbing, not escalation semantics. Root cause is registry↔script argv drift invisible to tests that invoke child scripts with hand-written argv. Industry pattern: derive launch argv in one place (supervisor) and verify callee signatures against that derivation in CI (OpenAPI-style contract tests, Kubernetes admission schema checks). Three options judged:

| Option | Verdict |
|--------|---------|
| **A — Fix `escalation-router` only** (align registry or script for `ProjectId`) | **Rejected alone** — closes the incident but recurrence is guaranteed (#638 class) |
| **B — Guard only** (static matrix without case fix) | **Rejected** — prod stays broken until a follow-up; violates brief Goal A |
| **C — Case fix + fleet guard** deriving supervisor argv (or equivalent static verification of registry flags × param block) | **Land** — cheapest sufficient executor with acceptable risk |

## Goal

Restore `escalation-router` as a healthy wake-supervisor child that completes redelivery ticks when launched with **supervisor-constructed argv** (not hand-written test argv), and add a CI guard that fails when **any** registry child's declared launch contract (`passProjectId`, `requiresOrchestratorSession`, `extraArgs`, and any future registry argv flags) produces argv its script cannot bind — so registry↔script drift is red CI instead of silent prod parameter-binding death.

```behavior-kind
action-producing
```

```complexity-tier
tier: T2
advisory-prior: T1-T2
```

## Binding surface

### Broken today (verified 2026-07-07, worktree)

| Surface | Observation |
|---------|-------------|
| Registry | `escalation-router` declares `passProjectId: true` and `requiresOrchestratorSession: true` (`scripts/orchestrator-side-process-registry.json`) |
| Supervisor | When `PassProjectId` is set, `Start-OrchestratorWakeSupervisorChild` appends `-ProjectId <id>` to child argv (same code path as siblings) |
| Child script | `orchestrator-escalation-router.ps1` param block accepts `OrchestratorSessionId`, `PollSeconds`, `Once` only — **no `ProjectId`** |
| Prod err log | `~/.local/state/orchestrator-pack-wake-supervisor/escalation-router.log.err.previous-*` (123 B): `A parameter cannot be found that matches parameter name 'ProjectId'.` Main log 0 B — business logic never ran |
| Backoff (#205) | Child quarantined; `escalation-router stopped (pid=0)` — backoff worked as designed |
| Live impact | `/tmp/orchestrator-escalation-state.json` holds **4** `llm-orchestrator` records with `operatorStatus: pending` (3× review-start-claim class, 1× submit-adoption class) — no redelivery loop |

**Sibling contrast:** `ci-failure-notification-reaction` also has `passProjectId: true` and **does** declare `[string]$ProjectId` — `escalation-router` is the outlier among `passProjectId` children.

### Launch-contract dimensions (full-class matrix)

Supervisor argv derivation today covers these registry-driven switches (planner may centralize, but guard must cover the **observable argv** the supervisor builds):

| Registry flag / field | Supervisor argv effect (non-test mode) | Child must bind |
|----------------------|----------------------------------------|-----------------|
| `requiresOrchestratorSession: true` | `-OrchestratorSessionId <id>` | `$OrchestratorSessionId` |
| `passProjectId: true` | `-ProjectId <projectId>` when supervisor has project id | `$ProjectId` |
| `extraArgs: [...]` | Expanded tokens after flag substitution (`{stateRoot}`, etc.) | Each switch/param name emitted |

**Fleet scope:** all **15** entries in `children[]` (`listener` … `escalation-router`). Guard must fail on a deliberate mismatch fixture reproducing the #641 shape (`passProjectId: true`, script lacks `ProjectId`) **before** the case fix lands.

### End-state invariants

1. **Supervisor launch path:** every registry child accepts the argv tuple the supervisor derives for it (production path, not direct `-Once` smoke calls).
2. **Case — escalation-router ticks:** child main log advances past 0 bytes; at least one redelivery tick completes under supervisor launch; pending `llm-orchestrator` deliveries become redelivered (or documented operator-clear path if stale records require it — semantics unchanged per #641).
3. **Class — guard:** CI guard fails on mismatch fixture; passes on aligned tree; covers all 15 children.
4. **No semantic drift:** escalation classes, routes, ack procedure, operator inbox, redelivery cadence, crash-backoff (#205) unchanged.

```contract-evidence
binding-id: orchestrator-pack:escalation-router:tick-completes
binding-type: cli-behavior
binding: escalation-router launched via supervisor child-spawn path completes at least one redelivery tick
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)
expected: tick-completes

binding-id: orchestrator-pack:supervisor:passProjectId-appends-ProjectId
binding-type: cli-behavior
binding: when PassProjectId is set supervisor appends -ProjectId to child argv
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)
expected: passProjectId-appends-ProjectId

binding-id: orchestrator-pack:side-process-launch-contract-guard:full-fleet-matrix
binding-type: cli-behavior
binding: CI guard rejects registry/script argv mismatch for every children[] entry
producer: orchestrator-pack
evidence: NEW(produced-by AC#4)
expected: full-fleet-matrix
```

## Files in scope

- `escalation-router` child script and/or its registry row — planner chooses which side to align; contract is bindability, not mandated param names
- Wake-supervisor child spawn / argv derivation library used in production launch path
- `scripts/orchestrator-side-process-registry.json` — only if registry-side adjustment is chosen
- New CI guard + regression fixture reproducing #641 mismatch shape `(new)`
- `tests/**` — guard tests, supervisor-launch integration or static matrix `(update/new)`

## Files out of scope

- Escalation contract semantics — classes, routes, ack, operator inbox, publish library (#641)
- Crash-backoff / quarantine behavior (#205)
- Pending `llm-orchestrator` route descope (unsynced draft 212 / #625 brief)
- Recovery spawn argv (#638/#652) — already guarded elsewhere; cite as precedent only
- `packages/core/**`, `vendor/**`, `agent-orchestrator.yaml`
- Supervisor-child `gh` PATH / REST shim (#447)

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
```

```allowed-roots
scripts/**
tests/**
```

## Acceptance criteria

1. **Case — supervisor launch succeeds.** Launch `escalation-router` through the wake-supervisor production child-spawn path (not a hand-written direct script invocation). Child process stays up past first poll; main log receives non-zero business output; no `ProjectId` parameter-binding error in stderr log.

```positive-outcome
asserts: escalation-router launched via supervisor child-spawn path writes business log lines and completes at least one redelivery tick without ProjectId binding failure
input: realistic
```

```producer-emission
producer: orchestrator-pack
datum: escalation-router
expected: tick-completes
proof-command: implementation-specific test or probe that launches escalation-router through the wake-supervisor production child-spawn path (not direct script invocation) and asserts main log advances with no ProjectId binding error in stderr
red-then-green: pre-fix supervisor launch stderr contains ProjectId binding failure; post-fix main log advances and tick completes
```

2. **Case — argv contract aligned.** The `escalation-router` registry row and script param block agree: supervisor-constructed argv (including `-ProjectId` when `passProjectId` is true and `-OrchestratorSessionId` when `requiresOrchestratorSession` is true) binds successfully.

```producer-emission
producer: orchestrator-pack
datum: supervisor
expected: passProjectId-appends-ProjectId
proof-command: implementation-specific test replays supervisor argv derivation for passProjectId children and asserts -ProjectId is present when registry passProjectId is true; red-then-green must fail if derivation omits -ProjectId for passProjectId:true children
red-then-green: must fail if escalation-router supervisor argv lacks -ProjectId while registry passProjectId is true
```

3. **Class — #641 regression fixture.** A committed fixture encodes the exact failure shape: registry declares `passProjectId: true` for a stand-in child script that lacks the matching param. The new guard **fails** on the fixture tree and **passes** once the contract is aligned.

```positive-outcome
asserts: launch-contract guard exits non-zero on mismatch fixture reproducing passProjectId-without-ProjectId-param shape
input: sample-backed
```

4. **Class — full fleet coverage.** Guard validates **all 15** `children[]` registry entries against their script param blocks (or supervisor-derived argv tuples) — not only `escalation-router`. Adding a new registry child without a bindable script surface fails CI.

```producer-emission
producer: orchestrator-pack
datum: side-process-launch-contract-guard
expected: full-fleet-matrix
proof-command: pwsh -NoProfile -File scripts/check-side-process-launch-contract.ps1
red-then-green: guard fails on mismatch fixture reproducing passProjectId-without-ProjectId-param; passes when all 15 children align
```

5. **Redelivery resumes (observable).** With router healthy and a **seeded or fixture-backed** escalation state containing at least one outstanding `llm-orchestrator` pending delivery, a router tick produces a redelivery attempt (log line or delivery-record transition proving the tick ran — ack semantics unchanged). Clean CI must not depend on the operator's live `/tmp/orchestrator-escalation-state.json` snapshot from the 2026-07-07 incident.

```positive-outcome
asserts: on seeded fixture escalation state with a pending llm-orchestrator delivery, a healthy escalation-router tick emits a redelivery attempt observable in log or delivery record
input: sample-backed
```

6. **No collateral contract edits.** #641 escalation publish/ack tests, #205 backoff tests, and recovery argv guards (#638/#652) remain green without widening their scope.

## Upgrade-safety check

- Pack-owned `scripts/**` and `tests/**` only; no AO core or vendor edits.
- No new secrets; no `agent-orchestrator.yaml` changes required for the contract.
- Guard is additive CI — does not change runtime behavior of already-aligned children.

## Verification

1. `pwsh -NoProfile -File scripts/check-side-process-launch-contract.ps1` — red on mismatch fixture, green on aligned tree (AC#3–#4).
2. Supervisor-launch integration test or documented probe: `escalation-router` tick under production argv (AC#1) — planner-owned test entrypoint; not `verify.ps1 -TestFilter` (unsupported today).
3. `pwsh -NoProfile -File ./scripts/verify.ps1` and `pwsh -NoProfile -File ./scripts/check-reusable.ps1` green.
4. `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/227-side-process-registry-launch-argv-contract.md`
5. `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/227-side-process-registry-launch-argv-contract.md`

### Grounding captures (draft-author, 2026-07-07)

Evidence from this worktree — not fabricated:

```
# escalation-router param block (no ProjectId):
scripts/orchestrator-escalation-router.ps1 lines 6-10: OrchestratorSessionId, PollSeconds, Once only

# registry flags:
scripts/orchestrator-side-process-registry.json escalation-router: passProjectId true, requiresOrchestratorSession true

# prod stderr (previous rotation):
orchestrator-escalation-router.ps1: A parameter cannot be found that matches parameter name 'ProjectId'.

# pending llm-orchestrator records:
/tmp/orchestrator-escalation-state.json records dict length 4, all route=llm-orchestrator operatorStatus=pending
```

## Decisions

- **Prior art:** extends shipped #641 router registration and #205 supervisor spawn model; generalizes #638/#652 dead-argv lesson to wake-supervisor children; does not duplicate recovery spawn guards.
- **Land option C** (case fix + fleet guard). Rejected guard-only and case-only options.
- **Planner freedom:** which side (registry vs script) to edit for `escalation-router`; guard implementation (static param parse vs supervisor argv replay) — acceptance is bindability and fleet matrix coverage only.
- **Tier:** recomputed **T2** (advisory T1–T2); enumerable registry-flag × param-block matrix; launch argv binding only — no new distributed protocol in scope.