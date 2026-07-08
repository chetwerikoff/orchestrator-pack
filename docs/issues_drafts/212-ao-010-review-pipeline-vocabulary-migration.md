# AO 0.10 review pipeline vocabulary migration and orchestrator-rules surface

GitHub Issue: #625

### Revision 2026-07-06

Routine LLM review turn removed from scope for the rules-surface half. The orchestrator
`prompts/**` section is now **script-owned procedure + exception-only** prose (escalation wake
per issue #641); vocabulary/scripts/guards work from PR #634 stands. Worker amends the open
PR #634 — no new PR.

## Prerequisite

- `docs/issues_drafts/210-ao-010-review-harness-and-trigger-loop.md` (GitHub Issue: TBD) — **must merge first.** Supplies `ao-review` shim and trigger/list primitives this migration targets.
- `docs/issues_drafts/213-ao-010-review-producer-data-contract.md` (GitHub Issue: TBD) — field mapping table; scripts must emit/consume `status`+`verdict`, not dead 0.9 fields.
- `docs/issues_drafts/211-ao-010-review-stuck-run-reaper.md` (GitHub Issue: TBD) — orthogonal; reconcile scripts must not assume reaper exists before #211 lands.
- **Sibling consumer:** `docs/issues_drafts/214-ao-reviews-board-runtime-aggregation.md`, `docs/issues_drafts/215-ao-reviews-board-ui-fork.md` — display producer contract; no duplicate aggregation in this issue.
- Grounding: `orchestratorRules` / `agentRules` / `reactions` in `agent-orchestrator.yaml` are **legacy-import-only** at 0.10 (`legacyimport/config.go:39-46`); live config = `domain.ProjectConfig` via API. AO orchestrator system prompt = generic role text only (`session_manager/manager.go:988-989`) — **not** pack `orchestratorRules`.
- CI guards grepping `orchestratorRules` in example yaml (`scripts/check-orchestrator-review-*.ps1`, `check-review-command-preflight.ps1`, `verify.ps1`) — **must move in same PR** as any rules-surface change (constraint b).
- Prior-art verdict: **Extends #210.** No open draft owns 0.10 vocabulary cutover for ~15 review scripts + rules surface migration.
- **Program direction (2026-07-06):** deterministic side-process scripts own routine orchestration; the LLM orchestrator is an exception handler woken only by the escalation contract.
- **Sibling escalation contract:** GitHub Issue #641 — owns ack/wake procedure text and the E7 "contested protected finding" catalog row; **#625 must not duplicate it** (pointer only).
- **In-flight PR:** PR #634 (`issue-625-review-vocabulary-migration`) is open; this revision is a scope amendment the worker applies to that PR — not a reopen of vocabulary migration work.

## Goal

Migrate pack review PowerShell scripts, side-process reconcile loops, and orchestrator **rules surface** off dead 0.9 `ao review run|list|send|execute` vocabulary and false-equivalence fields (`needs_triage`, `sentFindingCount`, `terminationReason`). Document the routine review procedure as **script-owned** (automated starters plus shared `.mjs` predicates in `docs/**`); shrink the `prompts/**` orchestrator section to (a) the manual-operator path, (b) an exception-handling pointer (escalation wake per issue #641), and (c) an explicit statement that the LLM turn does not start or drive routine review rounds. Side-process contracts, `agent-orchestrator.yaml.example` (specified-not-live), and project-config harness (#210) remain operator reference surfaces. Update CI guards in the **same PR** per changed prose.

```behavior-kind
action-producing
```

```complexity-tier
tier: T3
advisory-prior: T3
escalation-markers: multi-surface-span, ci-guard-coupling, contract-≥2-future-issues
```

## Binding surface

### How rules reach the live 0.10 orchestrator (binding recon)

| Surface | 0.9 assumption | 0.10 reality | Migration target |
| --- | --- | --- | --- |
| `orchestratorRules` yaml | AO injects on orchestrator spawn | **Not read at runtime** — import drops | Script-owned procedure docs (`review-trigger-reconcile.ps1`, `review-trigger-reeval.ps1`, `orchestrator-wake-listener.ps1`, shared `.mjs` predicates) + **minimal exception-only** orchestrator prose in `prompts/agent_rules.md` and `docs/orchestrator-autoloop-go-live.md`; live yaml operator-copied |
| `agentRulesFile` | AO injects worker rules | **Not in ProjectConfig** | Worker harness reads `AGENTS.md` / `.cursor/rules` from workspace (Cursor adapter) |
| `ao send` wake nudges | Turn-driven procedure | **Still works** | Wake messages reference migrated procedure in prompts, not dead CLI verbs |
| Side-process scripts | Mechanical `ao review run/send` | **Dead verbs** | Call `ao-review` shim / HTTP trigger per #210 |

**Forbidden:** binding new automation to `orchestratorRules` yaml keys as if AO parses them. **Required:** example yaml + CI guards stay consistent when prompt-side procedure moves.

### Dead vocabulary — mandatory respecification

Every script binding old fields **must** use 0.10 `status`+`verdict` per #213. **No shims** that emit fake `needs_triage` or accept `ao review send` success.

| Removed | Replacement |
| --- | --- |
| `ao review run` | `ao-review run` / `POST …/trigger` |
| `ao review list` | `ao-review list` / `GET …/reviews` (+ session fan-out for fleet) |
| `ao review send` | **removed** — delivery automatic |
| `ao review execute` | **removed** |
| `needs_triage` | `changes_requested` + delivery fields |
| `sentFindingCount` | derived delivered count |
| `terminationReason` on review rows | `latestRun.status` + worker session state |

### Scripts in scope (~15)

At minimum migrate:

- `scripts/review-send-reconcile.ps1`
- `scripts/review-trigger-reconcile.ps1`
- `scripts/review-trigger-reeval.ps1`
- `scripts/review-finding-delivery-confirm.ps1`
- `scripts/review-ready-report-state-seed.ps1`
- `scripts/review-run-recovery.ps1`
- `scripts/reviewer-workspace-preflight.ps1`
- `scripts/review-bulk-send-diagnose.ps1`
- `scripts/orchestrator-diagnose.ps1` (review sections)
- `scripts/lib/Invoke-OrchestratorClaimedReviewRun.ps1`
- `scripts/lib/Invoke-ReviewTriggerReeval.ps1`
- `scripts/lib/Invoke-ReviewWakeTrigger.ps1` (if not fully in #210)
- `scripts/lib/Review-StartClaim.ps1`
- `scripts/run-reviewer-reverify-ao-review-command.ps1` (retire or rebind)
- Associated `docs/*.mjs` predicates

### CI guard co-migration (same PR)

When `orchestratorRules` / `prompts/agent_rules.md` prose moves, update in **same PR**:

- `scripts/check-orchestrator-review-empty-trap.ps1`
- `scripts/check-orchestrator-review-idempotency.ps1`
- `scripts/check-orchestrator-review-head-coverage.ps1`
- `scripts/check-orchestrator-review-head-ready.ps1`
- `scripts/check-review-command-preflight.ps1`
- `scripts/check-pack-reviewer-selector.ps1`
- `scripts/verify.ps1` orchestratorRules sections

### Operator constraints

- **Live `agent-orchestrator.yaml` not edited by worker PR.** Example yaml remains operator reference for wake/webhook wiring; **AO 0.10 does not inject `orchestratorRules` at runtime** — copying yaml does not activate migrated review procedure.
- **Observable adoption for effective review loop:** operator applies #210 project-config `reviewers` harness + restarts wake-supervisor children; routine review rounds must trigger end-to-end with **no orchestrator LLM turn involvement** — adoption verification = a script-driven review trigger observed while the orchestrator session is idle.
- **`PACK_REVIEWER` / `REVIEW_COMMAND`:** document deprecation path toward project-config `reviewers` (#210); guards updated to allow either during transition or enforce post-adoption — planner chooses with fail-loud default.

## Files in scope

- `scripts/**` listed above `(update)`
- `docs/**` review predicates + orchestrator autoloop / recovery runbooks `(update)`
- `prompts/agent_rules.md` — orchestrator review procedure section `(update)`
- `agent-orchestrator.yaml.example` — align example prose with migrated verbs `(update)`
- `scripts/check-*.ps1` CI guards listed above `(update)`
- `tests/**` + `tests/external-output-references/**` `(new/update)`

## Files out of scope

- Trigger loop core — #210
- Stuck-run reaper — #211
- Producer schema doc — #213 (this issue implements mapping in code)
- Board runtime/UI — #214 / #215
- `vendor/**`, live `agent-orchestrator.yaml`

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
```

```allowed-roots
scripts/**
docs/**
prompts/**
tests/**
tests/external-output-references/**
agent-orchestrator.yaml.example
```

## Acceptance criteria

1. **Zero dead CLI in production scripts.** Static scan of in-scope `scripts/**` finds no bare `ao review run`, `ao review list`, `ao review send`, or `ao review execute` outside allowlisted shim implementation and test fixtures.

```producer-emission
producer: orchestrator-pack
datum: review-vocabulary-migration
expected: no-dead-ao-review-verbs
proof-command: implementation-specific ripgrep guard in scripts/check-review-010-vocabulary.ps1 or verify.ps1 hook
red-then-green: must fail if review-send-reconcile.ps1 still invokes ao review send
```

2. **Send reconcile retired or no-op loud.** `review-send-reconcile.ps1` either removed from supervisor registry or exits with explicit REMOVED — auto-delivery supersedes (#210 engine behavior).

3. **False-equivalence guard.** No script emits or consumes `needs_triage`, `sentFindingCount`, or `terminationReason` when reading 0.10 `/reviews` payloads.

4. **CI guards pass.** All `check-orchestrator-review-*` and `verify.ps1` orchestratorRules sections pass after prose migration.

```positive-outcome
asserts: pwsh scripts/verify.ps1 passes orchestratorRules quote-safety and review idempotency guard sections after vocabulary migration
input: realistic
```

5. **Orchestrator procedure in prompts.** The `prompts/agent_rules.md` orchestrator review section must: (a) attribute covered-head / head-ready / claim procedures to the **automated starters by name** (`review-trigger-reconcile.ps1`, `review-trigger-reeval.ps1`, `orchestrator-wake-listener.ps1`); (b) state that the LLM turn does **not** run routine `ao-review run` (the manual operator path stays); (c) reserve the exception path: contested-protected-finding (**E7**) and escalation wakes are handled per **issue #641's** contract — pointer only, no procedure duplication.

6. **Operator adoption observable.** Post-merge checklist requires: (a) #210 `reviewers` harness via project-config API, (b) wake-supervisor restart, (c) verification that a routine review round triggered script-side with the orchestrator LLM **idle**; the orchestrator prompt section contains **no routine-turn review procedure** — **not** yaml-copy alone.

7. **Example yaml aligned.** `agent-orchestrator.yaml.example` `orchestratorRules` block references `ao-review` / trigger path as **operator reference prose** (not AO-injected), not `PACK_REVIEW_SHELL` `--command` chains.

8. **Diagnose script updated.** `orchestrator-diagnose.ps1` review section reads per-session `/reviews` fan-out or shim list — not `ao review list --json`.

9. **Class matrix — vocabulary:**

| Old consumer assumption | Required new behavior |
| --- | --- |
| `list` → `needs_triage` row | `changes_requested` + undelivered `latestRun` |
| `send` clears triage | observe `deliveredAt` |
| `run` starts review | `trigger` |
| `terminationReason=failed` | `latestRun.status=failed` |

## Upgrade-safety check

- All reads via `/api/v1` or shim; no `ao.db` writes.
- CI guards and example yaml co-migrate — no wedge.

## Verification

1. Static dead-verb scan (AC#1).
2. `pwsh scripts/verify.ps1` subset for orchestratorRules guards.
3. Fixture replay for reconcile scripts using 0.10 list shape.
4. Discipline checks.

## Decisions

### Design analysis

| Option | Cost | Risk | Sufficiency |
| --- | --- | --- | --- |
| **(A) Shim-only, keep old field names in scripts** | Lowest | **False equivalence** — rejected | Insufficient |
| **(B) Big-bang rewrite, no shim** | Highest | Missed call sites | Sufficient but risky |
| **(C) Shim + phased vocabulary cutover** | Medium | Requires guardrails | **Land** — #210 shim + this issue completes cutover |

**Land:** **(C)** — shim from #210 is transitional; this issue removes dead verbs from production scripts and moves rules prose to prompts.

### Orchestrator rules surface — sibling finding resolved here

Grounding check #5 uncovered a **distinct surface** (yaml keys not consumed by AO 0.10). Rather than a separate issue, migration is bundled here because CI guards and example yaml are inseparable from vocabulary cutover.

```contract-evidence
binding-id: orchestrator-pack:review-vocabulary-migration:no-dead-ao-review-verbs
binding-type: structured
binding: in-scope production scripts contain no ao review run|list|send|execute outside shim module
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)
expected: no-dead-ao-review-verbs
```