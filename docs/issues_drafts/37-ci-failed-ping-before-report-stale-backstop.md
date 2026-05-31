# CI failure must ping worker before 30-minute report-stale backstop

GitHub Issue: #109

**Numbering:** draft file **37** (`37-ci-failed-ping-before-report-stale-backstop.md`) is not
[GitHub #37](https://github.com/chetwerikoff/orchestrator-pack/issues/37) (`12-architect-role-tighten.md`).

**Pre-sync review:** Codex CLI over usage limit until 2026-06-02 — draft self-reviewed
against planner-freedom checklist; re-run Codex draft review when quota resets.

## Prerequisite

- `docs/issues_drafts/11-orchestrator-autonomous-review-loop.md` (GitHub #28) — **closed**;
  `reactions.ci-failed` and `reactions.report-stale` wired in `agent-orchestrator.yaml.example`;
  orchestratorRules autonomous review loop.
- `docs/issues_drafts/32-worker-acknowledge-pickup-contract.md` (GitHub #88) — **closed**;
  worker `ao acknowledge` pickup; unrelated to CI ping but same lifecycle surface.
- `docs/issues_drafts/15-orchestrator-recovery-runbook.md` (GitHub #40) — operator recovery
  for stuck / probe_failure sessions.

**Observed failure (2026-05-31, issue #106 / PR #108, session `op-6`):**

Timestamps from AO lifecycle observability and GitHub Actions (may differ by a few
seconds — not used for sub-minute ordering claims).

| Time (UTC) | Event |
|------------|--------|
| ~02:03:08 | AO lifecycle: `stuck → ci_failed`, session `fixing_ci`, **`recoveryAction: null`** (no `send-to-agent`) |
| ~02:03:14 | GitHub CI run completes: PR scope guard **failure** |
| 02:03:41 | Worker `ao report ready_for_review` while CI still red — **orchestrator catching turn** in this episode |
| 02:03–02:33 | Lifecycle polls: `ci_failing`, **`recoveryAction: null`**; worker idle; **no further orchestrator turns** |
| 02:34:08 | `report-stale` fires: 30 minutes since last report, `reportState: ready_for_review` |
| 02:34:09 | First `send-to-agent` (`report-stale`) |
| 02:36:13 | First `send-to-agent` (`ci-failed`) — first upstream CI-failure reaction ping (~33 min after CI failure) |
| 02:43+ | Worker fixes CI; PR mergeable |

**Causal read:** red CI alone does not create an orchestrator turn (re-dispatch is
**turn-driven**, not CI-event-driven). In op-6 the only orchestrator catching turn in the
02:03–02:34 window was the worker's `ready_for_review` report. No turn → orchestrator
rules in binding surface §2 do not run → gap until AO's 30-minute `report-stale` backstop.

Operator expectation: CI red → worker fixes within minutes. Actual: worker prematurely
reported done, went idle; orchestrator did not ping on the catching turn; upstream
`ci-failed` reaction ping arrived only after `report-stale` / a later state transition.
A separate architect/Claude investigation overlapped in wall-clock time but did not
cause the worker wake (see AO events: `report-stale` then `ci-failed` `send-to-agent`).

Artifacts: AO events `report_watcher.triggered`, `reaction.action_succeeded`
(`report-stale`, `ci-failed`); lifecycle observability
`lifecycle-manager-*.ndjson` (`recoveryAction: null` on `ci_failing` polls).

## Goal

Close the gap where a worker declares done on a **red-CI** PR and then sits idle while
required CI is still failing. **Primary:** worker must not enter `ready_for_review` on red
CI and must self-heal in `fixing_ci`. **Secondary:** on each **orchestrator turn** that
observes red CI (especially right after a misleading worker report), orchestrator rules
must `ao send` a CI-fix prompt — not rely on the 30-minute `report-stale` timer alone.
Upstream `recoveryAction: null` on first `ci_failed` remains documented; not patched here.

## Binding surface

**What “CI green” means (planner must document once).** Rules and AC use “required CI” /
“CI green” without prescribing a single `gh` invocation. The planner MUST define in one
place (worker rules + orchestrator rules + runbook — same definition everywhere) which
checks count:

- **Preferred:** GitHub **required status checks** for the PR’s base branch (branch
  protection), when configured for this repo.
- **Fallback:** when branch protection does not list required checks, **all checks
  reported for the PR head that belong to this pack’s merge contract** (e.g. scope-guard
  workflow jobs named in `docs/` or `.github/workflows/` for orchestrator-pack) — not
  every optional or third-party check on the PR unless the repo already treats them as
  merge-blocking.

Worker `ready_for_review` and orchestrator ping logic MUST use the **same** definition.
Ambiguity (“all `gh pr checks` green” vs “only required”) is an acceptance failure.

**Turn model (read first).** Orchestrator rule changes are **turn-driven**: a failing CI
check does not by itself schedule an orchestrator turn. A catching turn is typically a
worker `ao report`, webhook wake, or operator/orchestrator session activity. If the
worker goes idle and nothing else creates turns, binding surface §2 below does **not**
fire until AO's hardcoded `report-stale` backstop (~30 minutes) or manual `ao send`.
This issue does **not** promise wall-clock time from CI failure — only discipline **on
the next orchestrator turn** that sees red CI.

1. **Worker rules (primary fix; turn-independent).** `prompts/agent_rules.md` MUST forbid
   `ao report ready_for_review` (and treating the task as done) while required CI checks
   for the PR head are not green. Worker MUST check CI status (e.g. `gh pr checks` or
   equivalent) before reporting `ready_for_review`. If CI is already red or fails after a
   report, worker MUST `ao report fixing_ci` and fix **without waiting** for an external
   ping — **self-fix is primary**; orchestrator ping is only when the worker has gone
   idle or stopped progressing. The op-6 class of failure should not start if the worker
   never reports `ready_for_review` on red CI.

**Residual risk (gated + silently idle).** If §1 works, the op-6-style catching turn (a
false `ready_for_review` while CI is red) should not occur. If the worker instead stays in
`fixing_ci` (or never reports) but **goes idle without commits** — no worker report, no new
turn — §2 still has nothing to hook. Pack orchestrator rules cannot replace AO’s ~30-minute
`report-stale` or manual `ao send` in that case. This issue documents that ceiling; it does
not patch upstream lifecycle.

2. **Orchestrator rules (recovery; turn-dependent).** On **each orchestrator turn** while
   any open worker PR has red required CI on the current head (source: `gh pr checks` /
   enrichment / `ao status` — planner picks), the orchestrator MUST `ao send` the worker
   with CI failure context (scope guard log, missing `Closes #N`, declaration snapshot,
   etc.) **before** other planning work, unless a ping for the same CI failure episode
   was already sent — **except** when the worker is already visibly active on CI fix
   (same turn or recent `fixing_ci` / new commits); do not double-drive an in-progress
   self-fix. Operator guidance: **≤ 3 minutes after the next orchestrator turn** that
   observes red CI (in op-6, that turn was the worker's `ready_for_review` report at
   02:03:41), not ≤ 3 minutes from CI failure wall-clock. Explicit prose: if no turn
   occurs, §2 does not run; `report-stale` remains the long-tail safety net.

3. **Reactions block unchanged in shape.** Keep `reactions.ci-failed` /
   `reactions.report-stale` in `agent-orchestrator.yaml.example`; `report-stale` remains
   the upstream long-tail backstop. Pack rules in §1–§2 reduce how often operators depend
   on it.

4. **Operator docs.** `docs/orchestrator-recovery-runbook.md` gains a short subsection covering:
   - **op-6 class:** CI red, worker idle, previously said `ready_for_review` → verify
     orchestrator turn; `ao events list` for missing early orchestrator `ao send` vs only
     `report-stale` / late `ci-failed`; manual `ao send`; do not assume architect activity
     woke the worker.
   - **gated + silently idle:** worker never falsely reported `ready_for_review`, but session
     idle with red CI and no progress → pack rules cannot ping without a turn; expect only
     upstream `report-stale` (~30 min) or operator `ao send` / kill-respawn per runbook #40.

5. **Out of scope for this issue:** patches to `packages/core/**` or `vendor/**` AO
   lifecycle (`recoveryAction: null` on first `ci_failed` transition is upstream
   behaviour; document as known gap; optional upstream follow-up by operator).

## Operator adoption

After merge: fold updated `orchestratorRules` prose from `agent-orchestrator.yaml.example`
into live `agent-orchestrator.yaml`; restart AO (`ao stop` / `ao start`). No new env vars.

## Files in scope

- `agent-orchestrator.yaml.example` — orchestratorRules CI-failure ping discipline (turn-aware)
- `prompts/agent_rules.md` — worker: no `ready_for_review` on red CI; self-fix precedence
- `docs/orchestrator-recovery-runbook.md` — operator triage subsection
- `docs/migration_notes.md` — one paragraph pointing operators at rule merge + restart
- `docs/issue_queue_index.md` — registry row (when issue is synced)

## Files out of scope

- `vendor/**`, `packages/core/**`, AO CLI / lifecycle-manager source
- Live `agent-orchestrator.yaml` (gitignored)
- Plugins/scripts unless a committed fixture is needed to lint orchestratorRules
  keywords (planner's choice)

## Denylist

```denylist
vendor/**
packages/core/**
code-reviews/**
.ao/**
```

```allowed-roots
prompts/**
docs/**
agent-orchestrator.yaml.example
```

## Acceptance criteria

**Note:** Most criteria below are **prose-contract** checks (grep/lint). They prove the
rules exist, not that AO lifecycle behaves correctly. Behaviour validation is the
operator manual criterion at the end.

- **CI green definition.** Worker rules, orchestrator rules, and runbook subsection use
  one documented definition of which checks must pass (required status checks when
  configured; else pack merge-contract checks — see binding surface). No contradictory
  “all checks” vs “required only” wording.
- **Worker gate (primary).** `prompts/agent_rules.md` forbids `ready_for_review` when CI
  is not green per that definition; requires CI status check before report; names
  `fixing_ci` while fixing; states self-fix is primary and external ping is not required
  when the worker is already fixing.
- **Orchestrator ping (recovery).** `agent-orchestrator.yaml.example` `orchestratorRules`
  require `ao send` on each turn that observes red CI per the same definition (episode
  dedupe; do-not-ping-while-actively-fixing). Prose states turn-driven model and **not** a
  wall-clock guarantee from CI failure. **Done for this AC is prose + operator validation
  only** — grep/CI cannot prove orchestrator runtime obeys rules.
- **Residual risk documented.** Runbook (and optionally a sentence in orchestrator rules)
  explicitly lists **gated + silently idle** (no false `ready_for_review`, no turn, red CI)
  as upstream-limited: only `report-stale` / manual intervention — not a pack gap to close
  in this issue.
- **Backstop unchanged.** `reactions.report-stale` documented as ~30-minute upstream
  long-tail; `reactions.ci-failed` retained.
- **Recovery runbook.** Subsection covers op-6-class and **gated + silently idle** paths
  (see binding surface §4) with manual unblock steps.
- **Migration.** `docs/migration_notes.md` tells operators to merge rules and restart AO.
- **Static verification.** `.\scripts\verify.ps1` passes; `Select-String` (or self-architect
  lint if wired) shows turn-aware CI-failure phrases in example rules and agent rules.
- **Behavioural validation (operator, required for “done”).** On the **next** real PR
  episode where required CI fails, operator confirms in `ao events list` that either (a)
  the worker never reported `ready_for_review` on red CI and self-fixed in `fixing_ci`, or
  (b) an orchestrator `ao send` (or equivalent pack-disciplined ping) appears **before**
  `report-stale` (~30 min). Record PR/session id in the issue or a short ops note. Absence
  of this step means only wording was shipped.

## Upgrade-safety check

- No AO core / vendor edits.
- No new secrets; uses existing `gh` / AO status surfaces.
- Does not weaken #28 review loop or merge gate (orchestrator still must not merge).
- Planner free to choose exact `gh` invocation and ping dedupe key shape in rules text.

## Verification

```powershell
# Prose-contract only — does not prove runtime behaviour
Select-String -Pattern 'ready_for_review|fixing_ci|turn-driven|next orchestrator turn' `
  prompts/agent_rules.md, agent-orchestrator.yaml.example
Select-String -Pattern 'report-stale|30.minute|ci.failed|ready_for_review' `
  docs/orchestrator-recovery-runbook.md
.\scripts\verify.ps1
```

**Operator (required for behavioural acceptance):** on the next red-CI episode after
merge, within one business day or the next worker PR — check `ao events list --json` for
early orchestrator ping vs only `report-stale` / late `ci-failed`; file a one-line result
on the GitHub issue or ops log.
