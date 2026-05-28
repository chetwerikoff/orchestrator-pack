# Autonomous review loop — operator go-live checklist

GitHub: [#68](https://github.com/chetwerikoff/orchestrator-pack/issues/68)

## Prerequisite

**Already merged (do not re-implement):**

- Issue #28 — autonomous review loop (`orchestratorRules`, `report-stale`,
  `prompts/agent_rules.md`; merged PR #42).
- Issue #39 — event-driven wake listener (`scripts/orchestrator-wake-listener.ps1`,
  `docs/orchestrator-wake-filter.mjs`, webhook wiring in example; merged PR #47).
- Issue #60 — review preflight and failed-run discipline (`scripts/run-pack-review.ps1`,
  CI guards; merged PR #65).

**Open follow-ups (reference only; out of scope for #68):**

- Issue #58 — state-derived reconciliation (`gh` open-PR set × `ao review list`)
  in `orchestratorRules`; architecture §H.
- Issue #59 — low-frequency heartbeat backstop in or beside the wake listener;
  architecture §H.

- Issue #15 — recovery runbook shipped at `docs/orchestrator-recovery-runbook.md`;
  go-live doc cross-links it, does not duplicate.

## Goal

The **implementation** for autoloop (rules, wake listener, pack review wrapper)
is already in `main`. Operators still fail to get a loop on the next spawn
because adoption is scattered and one live-config gap silences webhooks.

Observed gap (2026-05-28, issue #51 / PR #66): worker `ready_for_review`, CI
green, `mergeable`; listener only `dropped: not_wake_relevant`; zero review runs
until manual `ao send`; orchestrator then used forbidden review commands.

This issue delivers a **single operator go-live checklist**: how to turn on what
is already shipped (processes, live YAML merge from example, verification), how
to fix the `approved-and-green` webhook gap, and how to route failures to
existing runbooks. It does **not** rebuild #28 / #39 / #60.

## Binding surface

The repository MUST commit to:

1. **Canonical go-live doc** (`docs/orchestrator-autoloop-go-live.md`), in fixed
   section order:
   - **What is already in the repo** — pointers to merged capabilities (#28 / #39 /
     #60): `orchestratorRules` loop, wake listener, `REVIEW_COMMAND` /
     `scripts/run-pack-review.ps1`, `COMMAND DISCIPLINE` in the example.
   - **Processes to run** — `ao start` + `scripts/orchestrator-wake-listener.ps1`
     (`AO_ORCHESTRATOR_SESSION_ID`); defaults from wake runbook.
   - **Live config checklist** (gitignored `agent-orchestrator.yaml`): diff against
     `agent-orchestrator.yaml.example`; merge `orchestratorRules`, `reactions`,
     `notifiers` / `notificationRouting`; set `approved-and-green.priority: action`;
     copy **REVIEW_COMMAND** verbatim into `ao review run --execute --command`;
     `ao stop` then `ao start`.
   - **Known gaps vs follow-up issues** — #58 (reconciliation prose in rules),
     #59 (heartbeat); optional interim `ao send` on a schedule until #59, labelled
     temporary; event-only wake from #39 is production, not “missing.”
   - **Verification** — listener `accepted:` (synthetic POST), `ao review list`,
     orchestrator not `stuck`, `terminationReason` shows `run-pack-review.ps1`.
   - **Failure routing** — recovery runbook (stuck), wake runbook (no accepts),
     migration_notes (preflight, worker launch).
2. **Example config** — `reactions.approved-and-green` includes `priority: action`
   (partial override today drops default priority → desktop-only → listener never
   sees `merge.ready`).
3. **Discovery** — `docs/migration_notes.md` subsection **Autoloop go-live**;
   one-paragraph cross-links from wake and recovery runbooks.

## Files in scope

- `docs/orchestrator-autoloop-go-live.md` (new)
- `agent-orchestrator.yaml.example` — `approved-and-green.priority: action`
- `docs/migration_notes.md` — adoption pointer
- `docs/orchestrator-wake-runbook.md`, `docs/orchestrator-recovery-runbook.md` —
  cross-links only
- `docs/issues_drafts/26-orchestrator-autoloop-go-live.md` — this spec

Optional: extend `scripts/orchestrator-diagnose.ps1` with read-only autoloop
readiness hints; planner's call.

## Files out of scope

- `vendor/**`, `packages/core/**`, AO upstream.
- Heartbeat implementation (#59).
- Reconciliation `gh` prose in example rules (#58).
- Re-implementing wake listener, `run-pack-review`, or autonomous-loop rules (#28–#60).
- Live `agent-orchestrator.yaml` (gitignored).

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
```

```allowed-roots
docs/**
agent-orchestrator.yaml.example
scripts/orchestrator-diagnose.ps1
```

## Acceptance criteria

- **Go-live doc states merged baseline.** It names #28 / #39 / #60 (and PR #42 /
  #47 / #65) as shipped and tells the operator to **adopt** from example, not wait
  for those issues.
- **Adoption path is complete.** Doc alone covers: start AO + listener, merge live
  YAML, `approved-and-green` fix, `REVIEW_COMMAND` at shell time, restart, verify.
- **PR #66 class documented** — `ao report ready_for_review` ≠ webhook;
  `approved-and-green` without `priority: action` silences mergeable wake.
- **Follow-ups named, not blocked.** Doc mentions #58 / #59 as enhancements; does
  not claim heartbeat or full reconciliation are required to use #28 / #39 / #60.
- **Example has `priority: action`** on `approved-and-green`.
- **Cross-links** from migration_notes and both runbooks resolve to go-live doc.

## Upgrade-safety check

- No AO core / vendor edits.
- Example change is additive only.
- No secrets in repo docs.

## Verification

1. Static: files in scope exist; links resolve.
2. Static: `approved-and-green` includes `priority: action` in example.
3. `.\scripts\verify.ps1` and `.\scripts\check-reusable.ps1` pass.
4. Manual: operator following only the go-live doc on a machine with merged live
   YAML gets listener `accepted:` on synthetic `merge.ready` POST and a review run
   for a `ready_for_review` worker without typing "review" (or documents the
   single remaining gap with pointer to #58 / #59 if event path alone is insufficient).
