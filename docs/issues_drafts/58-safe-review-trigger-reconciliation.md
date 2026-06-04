# Safe state-derived review-trigger reconciliation (re-spec §H Decision 1)

GitHub Issue: #163

## Prerequisite

- `docs/issues_drafts/34-review-layer-resilience-after-worker-respawn.md`
  (GitHub #98) — already merged. Provides the review-run idempotency and
  stale-workspace preflight this trigger reuses; nothing new is required from
  it, but the trigger MUST compose with it rather than reinvent it.
- Supersedes the revert in GitHub #99 (which rolled back the original
  state-derived reconciliation, GitHub #58 / draft
  `docs/issues_drafts/11-orchestrator-autonomous-review-loop.md`, GitHub #28,
  after the PR #97 split-brain). This draft re-specifies that design with the
  unsafe behaviour removed; see **Binding surface**.
- Decision record: `docs/issues_drafts/00-architecture-decisions.md` §H
  Decision 1 must move from "rolled back" to "re-specified, scoped" in the
  same change set that ships this (decision logging is the architect's part of
  publishing this draft, not the planner's implementation work).

## Goal

Make review triggering converge from observable repository state so that an
open PR whose current head is not yet reviewed always gets a review run —
without depending on a worker remembering to report, and without depending on
the LLM-orchestrator being healthy enough to take a turn. Today the review
trigger lives only inside the orchestrator's turn loop and only fires off a
worker report; when the orchestrator is stuck (or a report is missing), the
whole review→fix→re-review loop halts silently on an open PR. The trigger must
become a small, deterministic, idempotent reconciliation that can never block
on either of those fragile actors, while never reintroducing the worker
duplication that caused the original rollback.

## Binding surface

This issue commits the repository to the following contracts.

- **State-derived trigger.** Review triggering is derived from observable
  state, not gated on a worker report: the set of open PRs and each PR's
  current head commit come from the repository host (`gh`), and per-head
  review-run coverage comes from `ao review list --json`. A missing, delayed,
  or never-sent `pr_created` / `ready_for_review` report MUST NOT be able to
  block a review.
- **Liveness independent of the LLM orchestrator.** The trigger MUST still
  converge when the LLM-orchestrator session is `stuck`, idle, or otherwise
  not taking healthy turns. Coupling the trigger's reliability to the
  orchestrator's turn loop is the failure this issue removes; binding it to a
  long-running LLM turn is not an acceptable implementation.
- **Safety invariant — review only, never worker lifecycle (this is the #97
  fix).** The only effect the trigger may produce is starting a review run for
  an uncovered head, plus the existing review preflight it composes with
  (idempotency, stale-workspace). It MUST NOT perform any
  worker-lifecycle action: no `ao spawn`, no `--claim-pr`, no `ao session
  kill`, no `ao send` / ping to a worker. The PR #97 split-brain came
  specifically from claiming/spawning a worker while a live worker held the
  branch; severing all worker-lifecycle effects is what makes re-introduction
  safe.
- **Idempotency / no duplicate runs.** Before starting a run the trigger
  composes with the GitHub #98 idempotency and stale-workspace preflight. A
  head counts as **covered** — and the trigger starts nothing — when any
  review run for that exact head SHA is in-flight (`queued` / `preparing` /
  `running` / `reviewing`), is `clean`, **or is a completed run with findings
  that have not been superseded** (e.g. findings awaiting triage or already
  sent to the worker). The trigger fires only for a head with no review run at
  all, or a head whose only runs are `outdated` (superseded by a newer head
  SHA). A completed-with-findings run on the current head is the
  orchestrator's judgement/fix-delegation work to act on — the trigger must
  not keep re-reviewing the same commit underneath it.
- **Low frequency only.** Reconciliation runs at low frequency (order of tens
  of minutes), consistent with §H Decision 2's relaxed no-polling invariant.
  High-frequency or busy polling of `ao` / `gh` state stays out of scope.
- **Division of labour preserved.** Only the mechanical *trigger* is
  decoupled. Judgement work — interpreting findings, deciding fixes,
  delegating to a worker, merge decisions — stays with the orchestrator and is
  unchanged by this issue.
- **Operator adoption** (touches operator-facing surfaces):
  - Merge the updated example configuration into the live, gitignored
    `agent-orchestrator.yaml` (the trigger wiring is not picked up until the
    operator copies the relevant block).
  - Start / supervise whatever low-frequency reconciliation process the design
    introduces (and any new operator env var it documents), per the updated
    go-live / recovery runbook; `ao stop` / `ao start` if the change requires a
    restart to take effect.
  - Verification command(s) the operator can run to confirm the trigger is
    live and fires on an uncovered head (the draft's **Verification** section
    is the source for these).

## Files in scope

- `agent-orchestrator.yaml.example` — trigger wiring / configuration for the
  re-specified reconciliation.
- `scripts/**` — the reconciliation entrypoint and its tests (new files as
  the planner declares them).
- `docs/**` — go-live and recovery runbook updates for the operator process
  (e.g. `orchestrator-autoloop-go-live.md`,
  `orchestrator-recovery-runbook.md`); any new draft/runbook the planner adds.
- Test fixtures for the scenarios in **Acceptance criteria**.

## Files out of scope

- `packages/core/**`, `vendor/**` — never edited.
- AO worker-spawn / lifecycle code paths — this issue must not touch how
  workers are created, claimed, or killed.
- The orchestrator's finding-triage / fix-delegation / merge-decision logic.
- `prompts/agent_rules.md` universal worker policy, except a thin pointer if
  one is genuinely needed.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

## Acceptance criteria

1. **Triggers without a worker report.** Given an open PR whose current head
   has no `clean`/in-flight review run and no worker `pr_created` /
   `ready_for_review` report, the reconciliation starts exactly one review run
   for that head. Provable by a test/fixture that presents such state and
   asserts one run is created.
2. **Triggers while the orchestrator is unavailable.** Given the same
   uncovered open PR and an LLM-orchestrator session that is `stuck` / idle /
   not taking turns, the review run is still created. Provable by a
   test/fixture that simulates the orchestrator being unavailable and asserts
   the run is created anyway.
3. **No duplicate runs (idempotency).** Given a review run for the current
   head that is in-flight (`queued`/`preparing`/`running`/`reviewing`),
   `clean`, **or completed with un-superseded findings (awaiting triage or
   already sent to the worker)**, the reconciliation starts no new run. A new
   run is started only when the head has no run at all, or only `outdated`
   runs. Provable by a test that presents each such status and asserts zero new
   runs for the covered cases and exactly one for the uncovered/outdated case.
4. **No worker-lifecycle effect (split-brain cannot recur).** In a scenario
   where a live worker still holds the PR branch and the reconciliation fires,
   no worker is spawned, claimed, killed, or pinged — only a review run is
   started. Provable by a test reproducing the PR #97 setup and asserting no
   `ao spawn` / `--claim-pr` / `ao session kill` / worker `ao send` occurs.
5. **Low frequency, configurable.** The reconciliation cadence is
   low-frequency by default (order of tens of minutes) and configurable; there
   is no high-frequency busy-poll of `ao`/`gh`. Provable by the default value
   plus a test/fixture exercising the configured cadence.
6. **Operator docs updated.** `agent-orchestrator.yaml.example` no longer
   documents report-driven triggering as the only path; the go-live / recovery
   runbook documents the operator process and the verification command.
   Provable by inspecting those files. (The §H Decision 1 record is updated by
   the architect when this spec is published — see **Prerequisite** — and is
   not part of the planner's done-proof.)

## Upgrade-safety check

- No edits to AO core or `vendor/**`.
- No unsupported AO YAML fields: on AO 0.9.x a `reviewer:` block is silently
  ignored — drive review through the CLI / `orchestratorRules` / the
  reconciliation entrypoint, never an unsupported schema field.
- No new repository secrets. Any new operator env var is documented in the
  runbook and the example config, and defaults to safe behaviour when unset.
- Composes with GitHub #98 idempotency / stale-workspace preflight rather than
  duplicating it.

## Verification

The planner proves done with commands/fixtures that map 1:1 to the acceptance
criteria:

- Criteria 1–4: automated tests over fixtures representing (1) uncovered head
  with no report, (2) uncovered head with the orchestrator unavailable, (3)
  each already-covered run status, (4) live-worker-on-branch split-brain
  scenario — each asserting the stated outcome (run created / not created / no
  worker-lifecycle call). Run via the pack test runner.
- Criterion 5: assert the documented default cadence and a test exercising a
  configured cadence.
- Criterion 6: show the updated example config and runbook (e.g. `git diff` of
  those files in the PR). The §H decision-record edit ships with the spec
  publication, not this implementation PR.
- Live smoke (operator, post-merge, optional): with the reconciliation
  running, present an open PR whose head is unreviewed and confirm a review run
  appears in `ao review list --json` for that head without any worker report
  or manual `ao review run`.
