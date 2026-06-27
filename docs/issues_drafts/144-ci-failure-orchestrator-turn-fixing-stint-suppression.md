# CI-failure orchestrator-turn nudges must suppress across head churn while a live worker is actively fixing CI

GitHub Issue: #459

## Builds On

- `docs/issues_drafts/37-ci-failed-ping-before-report-stale-backstop.md` (GitHub #109, closed) — introduced the red-CI worker ping before the long `report-stale` backstop.
- `docs/issues_drafts/90-ci-failure-notify-cross-path-dedup.md` (GitHub #283, closed) — reaction-first CI-failure episode dedup and atomic intent claims on the reconcile path.
- `docs/issues_drafts/110-ci-failure-ping-suppress-on-live-worker-state.md` (GitHub #342, closed) — `evaluateLiveWorkerSuppressor`: live PR-owning worker in `fixing_ci` suppresses CI-failure delivery on the **reconcile** path.
- `docs/issues_drafts/116-ci-failure-suppressor-bind-fixing_ci-to-head-scoped-report.md` (GitHub #363, closed) — suppressor reads head-scoped latest worker report, not session-level status; stale-head `fixing_ci` does not suppress.
- `docs/issues_drafts/106-review-and-cinudge-per-cycle-settle-gate.md` (GitHub #332, closed) — per worker-iteration cycle gate for review triggers and CI-green nudges (script surfaces).
- `docs/issues_drafts/121-llm-turn-worker-nudge-per-cycle-gate.md` (GitHub #384, closed) — LLM `orchestrator-turn` worker nudges pass the shared worker-nudge claim gate and journaled send; `ci-failure` intent cycle boundary was left as per-(PR, head) / red-episode when no reconcile red-period is supplied.
- `docs/issues_drafts/135-ci-failure-suppressor-progress-stale-escalation.md` (GitHub #439, closed) — **inverse lever**: stale same-head `fixing_ci` (older than `progressFreshnessMs`) releases suppression and arms `SEND` via the reconcile path only (`progress_stale`).
- `docs/issues_drafts/112-review-loop-worker-fresh-green-fast-reengage.md` (GitHub #348, open) — **sibling, out of scope**: green-head review-loop re-engagement, not red-CI CI-failure nudges.

There are no unsatisfied prerequisites for this task. The listed issues are prior art and constraints, not blockers.

**Prior-art verdict (2026-06-25):** **new issue.** #384 closed the transport/gate surface but explicitly left ci-failure **eligibility/suppressor logic** on the reconcile module untouched. #439 added stale-release on the **same head** only; it does not stop orchestrator-turn from re-arming a new `(PR, head)` tuple on every push while the worker is demonstrably progressing. No open/closed issue owns **cross-head suppression for live `fixing_ci` on the orchestrator-turn path** or **cross-surface ci-failure episode identity**. Do not fold in #384 process-boundary adoption (`check-worker-nudge-gate-adoption.ps1` / raw `ao send` deny) — separate track.

**Incident anchor (PR #457 / `opk-12`, 2026-06-25 UTC):** live worker actively fixing CI received three CI-failure worker messages across three heads in ~15 minutes: reconcile on `91a244b`, orchestrator-turn on `eb24aa7` and `7490f0b`; a fourth orchestrator-turn attempt on `7490f0b` correctly suppressed (claim already `SENT`). Gate audit proves orchestrator-turn sends went **through** `worker-nudge-gate` (`decision:SEND reason:gate_allow`), not around it.

## Goal

When a live PR-owning worker is demonstrably in an active **fixing-CI stint** (alive + fresh `fixing_ci` progress evidence per #342/#363/#439), CI-failure worker nudges must **suppress on every surface** — including `orchestrator-turn` — across head churn on the same PR, until the stint ends. A fresh push/head while the worker is still fixing CI is **progress**, not grounds to re-ping. Stale/no-progress must still release suppression per #439 (`progress_stale` via reconcile only). Same-head dedup already working must stay working.

```behavior-kind
action-producing
```

## Binding surface

### Critical mechanics

- **Active fixing-CI stint (episode).** Stint membership is computed from observable state; no durable "open stint" record is required. A stint is open when Class **A** or **B** below holds. The stint **stays open across head advances** on the same PR while progress remains fresh per #439. A same-PR head advance under the same live PR-owning worker, with CI still red and no closing condition, is qualifying progress and refreshes the stint even if the worker has not emitted another `fixing_ci` report yet. The stint **closes** when: required CI green for the active head; worker no longer live PR-owner; worker leaves `fixing_ci` without a fresh replacement; target/session generation rotation; or operator-visible degraded fail-safe per #342. An indefinite same-owner head-advance loop where CI never turns green is intentionally not terminated by this mechanism; it remains owned by the existing report-stale / session-stuck backstop path from #109 and related runtime policy.
- **#363 is preserved; this issue extends it via cross-head stint bridge (explicit).** Head-scoped suppressor rules from #363/#439 are unchanged. The **new** behavior is a bounded cross-head stint bridge — not session-level `status` / `agentReportedState`:
  - **Class A — head-scoped fresh `fixing_ci`:** latest worker report for the **current red head** is `fixing_ci` within `progressFreshnessMs` → **SUPPRESS** on all surfaces (`suppressed-live-worker`).
  - **Class B — cross-head stint bridge (extension):** current red head has **no** head-scoped `fixing_ci` report yet, but a head-scoped `fixing_ci` report exists on an earlier head and every later head advance is within the same computed stint: same PR, same live PR-owning worker, no closing condition, and each observed head advance refreshes progress → **SUPPRESS** on all surfaces until the worker reports `fixing_ci` on the new head, a freshness gap appears with no qualifying head progress, or a closing condition appears. This covers one or more “new head before worker report catches up” advances without weakening #363.
  - **Class C — stale-head / no qualifying report (#363 unchanged):** older-head `fixing_ci` evidence is stale, separated from the current head by a closing condition, or otherwise fails the Class B bridge; or there is no head-scoped `fixing_ci` report for this red episode and no Class B bridge → **SEND** eligible (`no_suppressor` on reconcile; orchestrator-turn follows the same predicate, not a looser per-head gate). Class C explicitly excludes stale same-head `fixing_ci`: that case is owned by #439 `progress_stale` reconcile delivery plus orchestrator-turn stale deference, not by ordinary SEND eligibility.
- **Orchestrator-turn and reconcile must make the suppression/stale decision atomically with claim acquisition.** A read-then-act predicate check before claim acquisition is insufficient. The shared decision may be represented as a claim, claim metadata, or another single writer primitive, but concurrent reconcile and orchestrator-turn evaluations of the same `(PR, head/red-episode, ci-failure, worker-target)` must produce at most one worker-observable send.
- **Cross-surface decision visibility.** Reconcile keys claims as `episode:<redPeriod>` (`head-red:<sha>:stint-N`); orchestrator-turn falls back to `episode:<pr>:<sha>`. Namespaces do not collide today. Both surfaces must observe the **same suppression / stale-escalation decision** before any worker-observable send. Planner may implement via unified stint key, shared record, or shared predicate call, provided the decision and claim step are atomic.
- **#439 reconciliation + reconcile-owned stale deference (mandatory).**
  - **Fresh progress** (Class A or B) → **SUPPRESS** on all surfaces.
  - **Stale same-head `fixing_ci`** (Class A false: report older than `progressFreshnessMs`, unchanged head, CI still red) → reconcile arms **one** `progress_stale` `SEND` (#439). Orchestrator-turn **must not** parallel-send.
  - **Reconcile-owned stale deference:** when reconcile arms or serves `progress_stale` for `(PR, head, ci-failure, worker-target)`, orchestrator-turn defers to that reconcile-owned decision for the same red episode/tuple. This should be represented by the same shared decision/claim mechanism where possible, not by a second independent state machine. If the existing terminal claim cannot express that the red episode is still active after a served `progress_stale` ping, the implementation may add durable claim metadata for that fact. Terminal `SENT`/`SUPPRESS` alone must not reopen orchestrator-turn while the same red episode remains active; deference clears when the red episode is superseded, CI turns green, ownership changes, or fresh Class A/B evidence opens a new active fixing stint.
  - **Any red during an open stint** (still red, newly red, new required-check failure on same head) → **SUPPRESS** while Class A or B holds. A new red-period / failing check does **not** re-open orchestrator-turn pings during active fixing.
- **First failure on a cold worker** (no open stint, Class C) → at most one CI-failure nudge per existing episode/claim rules. Successful delivery alone does **not** open a fixing-CI stint; only qualifying live/fresh `fixing_ci` progress evidence opens one.
- **Fail-safe.** Unreadable suppressor inputs follow #342 degraded policy: no blind duplicate send; operator-visible audit; reconcile remains backstop for `progress_stale`.

### Industry / world practice

Mature alerting coalesces repeat “still red” signals to an actor already working the failure until ownership or progress evidence changes.

### Architecture sketch

```
[CI red / head advance]
        |
        v
 +------+------+
 | ci-failure  |
 | classifier  |
 +------+------+
        |
        v
 +------+------+     fresh fixing_ci stint open?
 | shared live |---- yes --> SUPPRESS (all surfaces)
 | worker      |              |
 | suppressor  |              v
 +------+------+         (orchestrator-turn + reconcile)
        | no
        v
 +------+------+     stale same-head? -----> reconcile: progress_stale SEND
 | shared      |     reconcile-owned ----> orchestrator-turn: SUPPRESS
 | claim gate  |     stale deference
 +------+------+
        |
        v
 [journaled worker send]
```

Both surfaces make the same suppression/stale-escalation decision inside the shared claim/decision step.

### Options (cost / risk / sufficiency)

| Option | Cost | Risk | Sufficient |
|--------|------|------|------------|
| **A — Wire shipped `evaluateLiveWorkerSuppressor` into worker-nudge-gate for `ci-failure`, plus shared fixing-stint episode across surfaces** | Medium | Must fixture cross-head + #439 stale-release corners | **Yes (recommended)** |
| **B — Re-key orchestrator-turn only to reconcile `head-red:<sha>:stint-N` without stint-spanning key** | Low | Still re-arms every new head/red-period; does not fix the incident class | No |
| **C — Orchestrator-turn disable `ci-failure` nudges entirely (reconcile-only delivery)** | Low | Regresses legitimate cold-path LLM-turn pings; duplicates policy split | No |

**Chosen: A.** Extends shipped #342/#363/#439 suppressor and #384 gate — cheapest sufficient executor. B fixes namespace collision only, not cross-head storm. C over-corrects.

### Scenario matrix (acceptance fixtures — one per cell)

Legend: **S** = suppress (no worker-observable send), **SEND** = may arm one delivery, **REL** = #439 stale release via reconcile only, **DEFER** = orchestrator-turn defers to reconcile-owned stale decision.

Equivalence classes (deterministic):
- **A** = head-scoped fresh `fixing_ci` on current red head
- **B** = cross-head stint bridge (fresh `fixing_ci` on an earlier head, one or more same-owner head advances after report refresh progress, catch-up pending)
- **C** = #363 stale-head / no qualifying head-scoped report (no bridge)

| Worker state | Head event | Surface | CI state | Class | Expected |
|--------------|------------|---------|----------|-------|----------|
| live + fixing_ci | same head repeat | orchestrator-turn | still red | A | **S** |
| live + fixing_ci | same head repeat | reconcile | still red | A | **S** |
| live + fixing_ci | fresh head + new fixing_ci report | orchestrator-turn | still red | A | **S** |
| live + fixing_ci | fresh head + new fixing_ci report | reconcile | still red | A | **S** |
| live + fixing_ci | fresh head, no report yet | orchestrator-turn | still red | B | **S** |
| live + fixing_ci | fresh head, no report yet | reconcile | still red | B | **S** |
| live + fixing_ci | H1 report fresh, H2 and H3 pushed before catch-up | orchestrator-turn | still red | B | **S** |
| live + fixing_ci | H1 report, H2/H3/H4 same-owner pushes exceed report age window | orchestrator-turn | still red | B | **S** |
| live + fixing_ci | indefinite same-owner head churn, CI never green | either | still red | B | **S** here; terminal escalation belongs to #109 backstop |
| live + fixing_ci | fresh head, only stale-head report | orchestrator-turn | still red | C | **SEND** |
| live + fixing_ci | fresh head, only stale-head report | reconcile | still red | C | **SEND** |
| live + fixing_ci | fresh head | orchestrator-turn | newly red / new failing check | A or B | **S** |
| live + fixing_ci | fresh head | reconcile | newly red / new failing check | A or B | **S** |
| live + fixing_ci (stale same head) | same head | orchestrator-turn | still red | — | **S** (no parallel stale ping) |
| live + fixing_ci (stale same head) | same head | reconcile | still red | — | **REL → SEND** once (`progress_stale`) |
| live + fixing_ci (stale same head) | same head | orchestrator-turn | still red, reconcile-owned stale decision | — | **DEFER → S** |
| concurrent reconcile + orchestrator-turn | same tuple | cross-surface | still red | any | <= 1 worker-observable send |
| live + other / not fixing_ci | any | either | still red | C | **SEND** |
| dead / not PR owner | fresh head | either | still red | C | **SEND** when eligible |
| live + fixing_ci | any | either | green | — | **S** (no ci-failure intent) |
| cold (no stint) | first red on head | orchestrator-turn | newly red | C | **SEND** once |
| cold (no stint) | first red on head | reconcile | newly red | C | **SEND** once |
| live + fixing_ci (fresh) | same head, claim already SENT | orchestrator-turn | still red | A | **S** (same-tuple dedup) |

**Regression anchor:** Class **B** on orchestrator-turn — `live + fixing_ci + alive + fresh head on same PR + still-red CI` ⇒ **S**.

### Scope fences

- **Out:** #384 process-boundary adoption / raw `ao send` deny / `check-worker-nudge-gate-adoption.ps1` — reference only.
- **Out:** #348 green-head review re-engagement.
- **Out:** Changing worker `ao report fixing_ci` obligations.
- **Out:** Touching live workers (`opk-12`, etc.).

```contract-evidence
binding-id: ao:worker-report:fixing-ci-state
binding-type: structured
binding: ao worker report exposes fixing_ci as the active CI repair state
producer: ao
evidence: capture@ao-worker-report/fixing_ci
selector: $.reportState
expected: fixing_ci

binding-id: orchestrator-pack:ci-failure-fixing-stint.suppressReason:suppressed-live-worker
binding-type: structured
binding: orchestrator-turn ci-failure suppresses with live-worker reason when fixing stint open
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)
selector: $.ci-failure-fixing-stint.suppressReason
expected: suppressed-live-worker

binding-id: orchestrator-pack:ci-failure-progress-stale.auditReason:progress_stale
binding-type: structured
binding: stale same-head fixing_ci still escalates only via reconcile with progress_stale
producer: orchestrator-pack
evidence: NEW(produced-by AC#4)
selector: $.ci-failure-progress-stale.auditReason
expected: progress_stale
```

## Files in scope

- `docs/worker-nudge-gate.mjs` and orchestrator-turn gate callers — atomic suppression/stale-escalation decision for `ci-failure` integrated with the shared claim step.
- `docs/ci-failure-notification.mjs` and `scripts/ci-failure-notification-reconcile.ps1` — shared predicate, cross-head stint bridge, reconcile-owned stale deference metadata when existing claims cannot represent active red-episode ownership.
- `scripts/*.test.ts` — scenario matrix fixtures (Classes A/B/C, reconcile-owned stale deference, concurrent cross-surface evaluation, newly red during stint).
- `tests/external-output-references/**` — capture for new contract-evidence rows only.

**Only if needed (not default scope):** `scripts/journaled-worker-send.ps1` (transport threading); `docs/migration_notes.md` (new env keys).

## Files out of scope

- `vendor/**`, `packages/core/**`, AO internals.
- `agent-orchestrator.yaml` (live).
- #384 adoption checker / orchestratorRules deny prose (separate track).
- #348 review-loop re-engagement.

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
```

Scope boundary note: This denylist is scoped to `144-ci-failure-orchestrator-turn-fixing-stint-suppression`.

## Acceptance criteria

1. **Orchestrator-turn cross-head suppress:** the Class A/B rows in the scenario matrix evaluate **SUPPRESS** on orchestrator-turn (no worker-observable send). Gate audit records suppress reason equivalent to live-worker suppression.

```producer-emission
producer: orchestrator-pack
datum: ci-failure-fixing-stint.suppressReason
selector: $.ci-failure-fixing-stint.suppressReason
expected: suppressed-live-worker
proof-command: npm test -- ci-failure-fixing-stint-orchestrator-turn
```

2. **Same-head dedup preserved:** the same-head duplicate row in the scenario matrix remains **SUPPRESS** through the existing claim `SENT` / already-served path.

3. **Reconcile + turn agree on open stint:** after reconcile suppresses or records a qualifying Class A/B active-stint decision, orchestrator-turn on a later head does not send while stint fresh. A reconcile `SEND` by itself does not open the stint.

4. **#439 stale-release unchanged + reconcile-owned stale deference:** stale same-head `fixing_ci`, red CI, no fresh progress ⇒ reconcile arms **one** `progress_stale` `SEND`; orchestrator-turn defers to that reconcile-owned stale decision and does not parallel-send while the same red episode remains active.

```producer-emission
producer: orchestrator-pack
datum: ci-failure-progress-stale.auditReason
selector: $.ci-failure-progress-stale.auditReason
expected: progress_stale
proof-command: npm test -- ci-failure-progress-stale
```

5. **#363 stale-head preserved (Class C):** Class C rows in the matrix remain **SEND** / `no_suppressor` eligible. Older-head `fixing_ci` suppresses only when it qualifies for Class B; stale or closing-condition-separated older-head evidence does not suppress.

6. **Class B catch-up bridge and head-push freshness:** same-owner head advances refresh active-stint freshness while no closing condition appears. Include fixtures for H1 report fresh with H2/H3 pushed before catch-up, and H1 report followed by H2/H3/H4 same-owner pushes over longer than the original report age window; both remain **SUPPRESS** on orchestrator-turn.

7. **Newly red during open stint:** the newly-red / new-required-check matrix rows remain **SUPPRESS** on both surfaces while Class A or B holds.

8. **Cold path still pings once:** Class C, no live owner, no qualifying report, or no computed active stint ⇒ first eligible CI-failure delivery **SEND**s once per existing episode rules. That delivery alone does not create an active stint.

9. **Cross-surface atomic decision agreement:** fixture proves reconcile and orchestrator-turn reach the same SUPPRESS/SEND verdict for Classes A/B/C, and a concurrent reconcile + orchestrator-turn evaluation of the same tuple yields at most one worker-observable send.

10. **Operator audit:** suppress decisions record PR, heads, worker target/generation, class (A/B/C), reconcile-owned stale deference state, progress signal source (`fixing_ci` report vs same-owner head advance), suppress reason, and surface.

```positive-outcome
asserts: on realistic PR #457-class input where the worker was live with fixing_ci across head churn, orchestrator-turn ci-failure gate returns SUPPRESS instead of SEND gate_allow, while stale same-head progress still escalates only through reconcile progress_stale
input: realistic
```

## Upgrade-safety check

- No `vendor/**` or `packages/core/**` edits.
- No new raw `ao send` surface; journaled send + claim gate unchanged in transport.
- #439 `progress_stale` reconcile-only delivery preserved.
- Degraded unreadable state fails safe per #342.

## Verification

- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/144-ci-failure-orchestrator-turn-fixing-stint-suppression.md`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/144-ci-failure-orchestrator-turn-fixing-stint-suppression.md`
- Scenario matrix tests (AC#1–#10)
- Existing `npm test -- ci-failure-progress-freshness` and `npm test -- ci-failure-progress-stale` remain green
- `pwsh -NoProfile -File scripts/verify.ps1`
- `pwsh -NoProfile -File scripts/check-reusable.ps1`
