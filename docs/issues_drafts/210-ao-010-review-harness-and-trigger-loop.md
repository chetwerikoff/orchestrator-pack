# AO 0.10 review harness config and pack-owned trigger loop

GitHub Issue: #623

## Prerequisite

- Live operator environment on AO **0.10.x** (verified 2026-07-06: `ao review --help` lists **only** `submit`; `review` / `review_run` / `pr_reviews` in `~/.ao/data/ao.db` row counts **0**, `PRAGMA journal_mode` = `wal`).
- AO 0.10 review engine facts (re-verified at `ComposioHQ/agent-orchestrator` `v0.10.2` in scratchpad `ao-src`):
  - Three session-scoped HTTP routes: `GET/POST /api/v1/sessions/{id}/reviews`, `POST …/reviews/trigger`, `POST …/reviews/submit` (`backend/internal/httpd/controllers/reviews.go:63-67`).
  - Reviewer = first-class AI agent session in the worker worktree; deterministic handle `review-<workerId>` (`review/launcher.go`).
  - **No daemon-side auto-trigger** — `.Trigger()` has exactly two production callers: HTTP controller and review service delegate (`reviews.go:91`, `service/review/review.go:87`). Frontend `SessionInspector.tsx:461-497` is the only shipped UI trigger.
- `docs/issues_drafts/206-ao-010-session-status-readers-migration.md` (GitHub #619) — session identity / liveness readers for trigger targeting; orthogonal but same upgrade generation.
- **Sibling consumer (hard dependency):** `docs/issues_drafts/214-ao-reviews-board-runtime-aggregation.md` and `docs/issues_drafts/215-ao-reviews-board-ui-fork.md` — consume review state this pipeline **produces**; field contract owned by `docs/issues_drafts/213-ao-010-review-producer-data-contract.md`.
- Shipped / closed adjacent (do not re-derive):
  - `docs/issues_drafts/31-deterministic-reviewer-selection.md` (GitHub #86), `docs/issues_drafts/36-pack-reviewer-env-at-review-spawn.md` (GitHub #106) — incumbent `PACK_REVIEWER` / `REVIEW_COMMAND` selection; this draft **migrates reviewer driving to AO typed `reviewers` harness config**, not resurrected `--command`.
  - Prior review-storm / idempotency incidents #242, #318, #332, #376, #403, #407 — trigger loop must not fight engine idempotency.
- Prior-art verdict: **Genuinely new.** Coworker corpus survey and `gh issue list --search "review pipeline 0.10"` on `chetwerikoff/orchestrator-pack` (2026-07-06) found no shipped trigger-loop draft. Closed #122 is 0.9 dashboard cleanup only.

## Goal

Re-establish pack-driven code review on AO 0.10 by (1) configuring the project's reviewer harness through AO's typed `ProjectConfig.reviewers` API (Codex incumbent), and (2) owning the **trigger loop** the engine lacks — idempotent `POST /api/v1/sessions/{workerId}/reviews/trigger` when a worker PR head is review-ready. Deliver a thin **anti-corruption boundary** (`ao-review` or equivalent) so existing reconcile scripts can migrate argv incrementally without false-equivalence shims. Bind **review-before-worker-cleanup** as a lifecycle invariant.

```behavior-kind
action-producing
```

```complexity-tier
tier: T3
advisory-prior: T3
escalation-markers: state-machine-core, multi-surface-span, contract-≥2-future-issues
```

## Binding surface

### Invariants (non-negotiable)

- **AO engine is unavoidable.** `submit` requires a prior trigger-minted `runId` (404 otherwise — `service/review/review.go:169-174`). No pack-side reviewer that bypasses trigger.
- **Harness via project config, not `--command`.** Reviewer selection = `ProjectConfig.Reviewers[0].Harness` with fallback `claude-code` (`domain/projectconfig.go:57-63`). Set through `PUT /api/v1/projects/{id}/config` or `ao project set-config <id> --config-json '{"reviewers":[{"harness":"codex"}]}'`. Registered harnesses: `claude-code | codex | opencode` (`adapters/reviewer/registry.go:26-28`).
- **Trigger loop ownership (Gap #1).** Pack decides **when** to trigger per worker session at PR-ready. Engine already dedupes (mutex + `Plan` skip + `ErrDuplicateReviewRun` fallback — `review/review.go:247-253`; 201 new / 200 reused — `reviews.go:96-101`). Pack must not double-fight idempotency.
- **Review-before-cleanup (lifecycle reorder).** Trigger hard-fails on terminated / empty-workspace worker (`review/review.go:172-177` → 422). Review runs must **complete or be reaped** before worker session termination or worktree cleanup.
- **Live `agent-orchestrator.yaml` is operator-owned.** This draft **specifies** harness/trigger adoption steps; it does **not** edit the live yaml. Applying harness config is a **separate manual operator step** documented in operator adoption.
- **Isolation + completion proof (#304 class).** Any fork/session work in isolated checkout; forbid force-checkout/reset; proof = live daemon trigger produces `review_run` rows end-to-end, not exit code alone.

### Trigger eligibility (pack guard)

Bind a pack-owned **ready-for-review predicate** before trigger (successor to #195 head-ready gate, evaluated against AO 0.10 surfaces — not dead `ao review list`). Predicate must be capture-backed. Defer / skip when: head already covered (`up_to_date` / approved), run `running` for same head, PR ineligible (draft/merged/closed), or worker session terminated.

### Anti-corruption boundary

Ship a pack-local CLI shim (planner names it; brief calls it `ao-review`) mapping legacy argv to 0.10 primitives:

| Legacy (0.9) | 0.10 primitive | Notes |
| --- | --- | --- |
| `ao review run <session>` | `POST …/reviews/trigger` | Idempotent; returns run ids |
| `ao review list` (session scope) | `GET …/reviews` | Per-session only |
| `ao review send` | **removed** — delivery automatic on submit | Shim must **not** fake send success |
| `ao review execute` | **removed** — reviewer is AO agent | No external `--command` |

Shim isolates ~15 scripts from AO churn; may adopt in-process `ao review trigger` CLI when upstream lands (`review/review.go:1-9` foreshadow).

### Operator adoption

1. Set project reviewer harness (example — operator runs after merge, not in draft-author session):
   `ao project set-config orchestrator-pack --config-json '{"reviewers":[{"harness":"codex"}]}'`
2. Verify: `GET /api/v1/projects/orchestrator-pack/config` includes `reviewers`.
3. Start / verify wake-supervisor children pick up new trigger path.
4. **Do not** edit live `agent-orchestrator.yaml` from worker PR — operator merges example changes separately.

## Files in scope

- New pack trigger loop module / `ao-review` shim under `scripts/**` `(new)`
- `scripts/lib/Invoke-AoCliJson.ps1` — daemon HTTP helpers for trigger/list `(extend)`
- `scripts/lib/Invoke-ReviewWakeTrigger.ps1`, `scripts/orchestrator-wake-listener.ps1` — rebind wake path from dead `ao review run` to trigger `(update)`
- `scripts/review-trigger-reconcile.ps1`, `scripts/review-trigger-reeval.ps1` — trigger entry rebinding `(update)`
- `tests/external-output-references/**` — trigger/list/submit capture corpus `(new)`
- `tests/**` — idempotency + trigger eligibility fixtures `(new)`
- `docs/**` — operator harness + trigger adoption `(update)`
- `agent-orchestrator.yaml.example` — document harness adoption pointer only; **no** resurrected `--command` prose `(update if needed)`

## Files out of scope

- Stuck-`running` reaper — `docs/issues_drafts/211-ao-010-review-stuck-run-reaper.md`
- Full dead-vocabulary script migration + CI guard moves — `docs/issues_drafts/212-ao-010-review-pipeline-vocabulary-migration.md`
- Producer field contract spec — `docs/issues_drafts/213-ao-010-review-producer-data-contract.md` (this issue **implements** population; #213 owns interface)
- Reviews board runtime/UI — #214 / #215
- `vendor/**`, AO core, live `agent-orchestrator.yaml`

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
tests/external-output-references/**
docs/**
agent-orchestrator.yaml.example
```

## Acceptance criteria

1. **Harness configured.** Operator adoption path sets `reviewers:[{harness:codex}]` (or pack-chosen harness) via project-config API. Verification fixture replays `GET /api/v1/projects/{id}/config` shape with non-empty `reviewers`.

```positive-outcome
asserts: after operator adoption, project config JSON includes reviewers[0].harness matching pack incumbent (codex)
input: realistic
```

2. **Trigger mints runs.** Against live daemon with a review-ready worker PR, `POST …/reviews/trigger` returns 201 or 200 and `review_run` row exists (read-only count proof). Shim `ao-review run <session>` delegates to same outcome.

```producer-emission
producer: orchestrator-pack
datum: ao-0-10-review-trigger
expected: trigger-mints-review-run
proof-command: implementation-specific test replaying committed trigger response capture; red-then-green must fail if shim calls removed ao review run argv
```

3. **Idempotent same-head.** Duplicate trigger for same (session, PR, head) returns 200 reused; no duplicate `running` rows for same target SHA.

```positive-outcome
asserts: two consecutive triggers for the same worker session and PR head yield one running or complete run for that targetSha
input: realistic
```

4. **Head-move supersedes.** When PR head advances, next trigger supersedes stale `running` run for old head (`review/review.go:228`) and plans new head.

5. **Terminated worker rejected.** Trigger against terminated session returns classified 422; trigger loop skips terminated workers without tight-spin.

6. **No false send shim.** `ao-review send` (if present) exits non-zero or prints explicit REMOVED — never silent success.

7. **Review-before-cleanup documented.** Operator runbook states: do not terminate worker / remove worktree until review runs for current head are `complete|delivered|failed` or reaped per #211.

8. **Review-before-cleanup enforced.** Worker termination and worktree-cleanup entry points invoked by the pack trigger/wake path (including wake-supervisor teardown hooks and worker-recovery scripts rebound in this issue) **refuse** to proceed when `GET /api/v1/sessions/{workerId}/reviews` shows any `latestRun.status=running` for the worker's current PR head. Outcome: classified abort (non-zero exit or HTTP 409 equivalent) with parseable reason — not silent cleanup. Proof: fixture replay where a `running` run exists for current head → cleanup/terminate call blocked; after run reaches `complete|failed` or #211 reaps → cleanup proceeds.

```positive-outcome
asserts: termination or worktree cleanup is refused while a running latestRun exists for the worker current PR head, and proceeds once that run is no longer running
input: realistic
```

```producer-emission
producer: orchestrator-pack
datum: review-before-cleanup-gate
expected: cleanup-blocked-while-running
proof-command: implementation-specific fixture replay asserting cleanup/terminate refusal when latestRun.status=running for current head
red-then-green: must fail if cleanup proceeds while a running run blocks the current head
```

9. **Wake path rebound.** `Invoke-ReviewWakeTrigger` uses trigger primitive, not `ao review run`.

```producer-emission
producer: orchestrator-pack
datum: review-wake-trigger
expected: post-reviews-trigger-not-ao-review-run
proof-command: static call-site guard or fixture replay proving outbound URL is /reviews/trigger
red-then-green: must fail if wake trigger still invokes ao review run
```

10. **Scenario matrix (pack guards):**

| Scenario | 0.10 engine behavior | Pack guard |
| --- | --- | --- |
| Duplicate trigger, same head | Idempotent 200 | Safe — do not bypass |
| Head moves mid-review | Stale run kept; new trigger for new head | Re-trigger on push / ready |
| Submit without trigger | 404 | Never submit unminted id |
| Trigger on terminated worker | 422 | Skip; reorder cleanup |
| Concurrent triggers | Mutex serialises | Safe within one daemon |

## Upgrade-safety check

- Depends on versioned `/api/v1` HTTP only for trigger/list — no `ao.db` writes.
- No `--command` external reviewer hook (removed in 0.10).
- Shim can adopt future `ao review trigger` CLI without changing reconcile semantics.

## Verification

1. Capture-backed tests for trigger 201/200, list shape, idempotent replay.
2. Live smoke (operator doc): one manual trigger → `review_run` count increases from 0.
3. Static guard: no remaining `ao review run` in rebound wake/trigger entry scripts.
4. `pwsh -NoProfile -File scripts/check-draft-discipline.ps1` on this draft.

## Decisions

### Prior art

No shipped 0.10 trigger loop. Engine provides trigger/submit; pack owns scheduling.

### Design analysis (T3 — four options)

**Critical mechanics:** Project-config harness selection → per-worker HTTP trigger → AO spawns reviewer agent in worker worktree → reviewer posts via `gh` and `ao review submit` → auto-delivery on `changes_requested` when head matches (`service/review/review.go:255-260`).

**Industry pattern:** Platform-owned review agents with external orchestrator trigger (GitHub Actions `pull_request` → bot) — orchestrator owns *when*, engine owns *how*.

**Architecture sketch:**

```
[Pack trigger loop / wake / reconcile] --POST trigger--> [AO daemon :3001]
        |                                                      |
        | ao-review shim (anti-corruption)                     v
        |                                              [Reviewer agent in worker WT]
        |                                                      |
        |                                              submit + auto-deliver
        v
[#214 board reads GET /reviews fan-out]
```

**Options (cost / risk / sufficiency):**

| Option | Cost | Risk | Sufficiency |
| --- | --- | --- | --- |
| **(A) Full compat shim `ao-review`** | Low script churn | False-equivalence on `send`/synthesized fields | Transitional only |
| **(B) Native rewrite all scripts** | High blast radius | Missed call sites | Sufficient but expensive |
| **(C) Pack-side runner bypassing trigger** | — | **Blocked** — submit 404 | Rejected |
| **(D) Native harness + pack trigger only** | Medium | Must build trigger loop | **Cheapest sufficient** target |

**Land:** **(D)** delivered through **(A)** as anti-corruption boundary for incremental script migration (#212 completes vocabulary cutover).

### Orchestrator rules surface (grounding check #5 — cross-ref)

AO 0.10 does **not** inject `orchestratorRules` at runtime (`domain/projectconfig.go:17-18`; legacy import drops keys — `legacyimport/config.go:39-46`). Orchestrator system prompt is generic AO role text only (`session_manager/manager.go:988-989`). Pack rules reach the live orchestrator via workspace files + `ao send` turn nudges — migration owned by #212. **Do not bind trigger loop to yaml `orchestratorRules` prose.**

```contract-evidence
binding-id: orchestrator-pack:ao-0-10-review-trigger:trigger-mints-review-run
binding-type: structured
binding: POST /api/v1/sessions/{id}/reviews/trigger creates or reuses review_run for eligible PR head
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)
expected: trigger-mints-review-run

binding-id: orchestrator-pack:review-before-cleanup-gate:cleanup-blocked-while-running
binding-type: structured
binding: worker termination and worktree cleanup refuse while latestRun.status=running for current PR head
producer: orchestrator-pack
evidence: NEW(produced-by AC#8)
expected: cleanup-blocked-while-running

binding-id: orchestrator-pack:review-wake-trigger:post-reviews-trigger-not-ao-review-run
binding-type: structured
binding: wake trigger path calls daemon /reviews/trigger not removed ao review run CLI
producer: orchestrator-pack
evidence: NEW(produced-by AC#9)
expected: post-reviews-trigger-not-ao-review-run
```
