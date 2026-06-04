# Do not treat a review-ready worker as lost on a false `stuck` classification

GitHub Issue: #174

## Prerequisite

- Relates to GitHub #173 (`62-terminal-flood-resilience.md`) /
  ComposioHQ/agent-orchestrator#2094: a DA-flooded pane is what makes the native
  activity probe misread a live, review-ready worker as `idle`→`stuck`
  (`probe_failure`). This issue does not fix the flood (that is #173 / upstream); it
  stops the false `stuck` from **costing** the worker.
- Relates to GitHub #171 (`61-review-finding-delivery-confirmation.md`) — #171
  re-delivers/escalates a finding that never reached the worker; this issue ensures
  the worker is still **there** to receive a re-delivery (not respawned/killed out
  from under it). Complementary.
- Relates to GitHub #98 (`34-review-layer-resilience-after-worker-respawn.md`,
  **closed**) — that issue hardens the review layer **after** a respawn already
  happened; this issue prevents an **unnecessary** respawn/kill of a healthy
  review-ready worker in the first place. It must not weaken the genuine-orphan
  handling #98 established.

## Goal

A worker that finished its task — reported `ready_for_review`, opened a PR with
green CI, and is awaiting review — can be flagged `stuck` (`probe_failure`) when its
dashboard pane is DA-flooded, because the activity probe reads the flooded pane as
idle. If pack orchestration then reacts to `stuck` by respawning, killing, or
re-claiming that session, it destroys or duplicates a healthy worker and its branch
(the PR #97 split-brain class) for no reason. Make the discipline explicit: a
session that is **alive and review-ready** must be treated as *awaiting review*,
not as a *lost worker*, regardless of a `stuck`/`probe_failure` flag.

## Binding surface

- **Observable "review-ready, not lost" classification.** Define, from observable
  state, when a `stuck`/idle-flagged session is actually a healthy worker awaiting
  review and MUST NOT be respawned, killed, or re-claimed:
  - its runtime is **alive** (the worker process is running), **and**
  - its last accepted lifecycle report is `ready_for_review` (awaiting external
    review), **and**
  - a review run exists or is awaiting update for the PR's **current head**.
  When all hold, the session is *awaiting-review*, not *lost*.
- **No worker-lifecycle action against a review-ready session.** Under that
  classification, pack orchestration MUST NOT `ao spawn`, `--claim-pr`, kill, or
  respawn the session on a `stuck`/`probe_failure` signal. The healthy worker is
  left in place (and remains reachable for a #171 re-delivery).
- **Genuine death is unchanged.** If the runtime is actually dead (process gone),
  this guard does **not** apply — the orphan-reap / respawn discipline (#98) still
  governs. The guard narrows only the *false-positive* case: a **live** process
  misread as stuck.
- **Durable home, not a local patch.** The discipline lands where it is tracked and
  operator-adopted: the canonical `orchestratorRules` in
  `agent-orchestrator.yaml.example` (and, if a worker/agent-facing note is needed,
  `prompts/agent_rules.md`). A deterministic helper MAY back it so the
  classification is testable rather than prose-only. It MUST NOT be implemented by
  hand-editing the local gitignored `agent-orchestrator.yaml` or reactions.
- **Operator adoption** (changes canonical `orchestratorRules`): the
  `agent-orchestrator.yaml.example` clause is documented for operators to merge into
  their live config, with the recovery runbook noting the behaviour change and the
  required `ao stop` / `ao start` to adopt it.

## Files in scope

- `agent-orchestrator.yaml.example` — the canonical `orchestratorRules` clause for
  the review-ready guard.
- `prompts/agent_rules.md` — a clause only if a worker/agent-facing rule is needed.
- `scripts/**` — an optional deterministic classification helper and its tests.
- `docs/**` — recovery / go-live runbook note and the operator adoption step.
- Test fixtures for the classification (review-ready-alive vs genuinely-dead vs
  ordinary-stuck).

## Files out of scope

- `packages/core/**`, `vendor/**`, `.ao/**` — the activity probe and `stuck`
  classification are AO core; this issue governs the pack's **reaction** to the
  flag, not the flag itself.
- The flood detection/recovery and upstream tracking — that is #173 / #2094.
- The delivery-confirmation / re-delivery mechanism — that is GitHub #171.
- The local gitignored `agent-orchestrator.yaml` — never hand-edited as the durable
  fix; the `.example` carries the canonical rule.

## Denylist

```denylist
# issue 63 — review-ready worker stuck guard
vendor/**
packages/core/**
.ao/**
```

```allowed-roots
scripts/**
docs/**
prompts/**
agent-orchestrator.yaml.example
```

## Acceptance criteria

1. The "review-ready, not lost" classification is defined from observable state —
   runtime alive **and** last accepted report `ready_for_review` **and** a review
   run **covering the current PR head, including a run awaiting update**
   (e.g. `waiting_update`) — and is satisfiable without scraping the pane. Provable
   by fixtures for **both** review-run cases (a completed/covering run and an
   awaiting-update run) classified *awaiting-review*.
2. A session under that classification is **not** respawned, killed, or re-claimed
   on a `stuck`/`probe_failure` signal. Provable by a fixture asserting no
   worker-lifecycle action is taken for a review-ready-but-stuck session.
3. A genuinely dead session (runtime not alive) is **not** shielded by the guard —
   the existing orphan/respawn path still applies. Provable by a fixture with a dead
   runtime asserting the guard does not suppress recovery.
4. An ordinary `stuck` session that is **not** review-ready (no `ready_for_review`,
   or no review run for the head) is **not** shielded — normal stuck handling
   applies. Provable by a fixture asserting the guard does not over-reach.
5. The canonical `orchestratorRules` in `agent-orchestrator.yaml.example` carries
   the guard clause; the recovery/go-live runbook documents the behaviour and the
   `ao stop` / `ao start` adoption step. Provable by grep / inspection.

## Upgrade-safety check

- No edits to `packages/core/**`, `vendor/**`, or `.ao/**`.
- The durable rule lives in `agent-orchestrator.yaml.example` / `prompts/agent_rules.md`,
  never in the gitignored local `agent-orchestrator.yaml`.
- The guard narrows only the false-positive (live process misread as stuck); it does
  not weaken genuine-orphan handling (#98) or introduce any new worker-spawn path.
- No new repository secrets and no new GitHub Actions permissions.

## Verification

- Automated tests over fixtures cover the four classification cases:
  review-ready-alive (both a covering run and an awaiting-update run) →
  awaiting-review, no lifecycle action (criteria 1–2);
  dead-runtime → guard does not suppress recovery (criterion 3); stuck-but-not-
  review-ready → normal handling (criterion 4). Run via the pack test runner.
- Grep confirms the `agent-orchestrator.yaml.example` `orchestratorRules` clause and
  the runbook adoption note (criterion 5).
- Live smoke (operator, optional): with a review-ready worker flagged `stuck` by a
  flooded pane, confirm pack orchestration leaves it in place (no respawn/kill) and
  it remains reachable for re-delivery.
