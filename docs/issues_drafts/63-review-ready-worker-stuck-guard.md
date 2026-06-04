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
idle. If pack orchestration then **reflexively** reacts to `stuck` by respawning,
killing, or re-claiming that session, it destroys or duplicates a healthy worker and
its branch (the PR #97 split-brain class) for no reason.

But the guard must not over-correct into a **trap**: in the DA-flood case the
process is often *alive but unreachable* (input channel corrupted), so "process
running" is **not** proof of health — a blanket "never touch a live review-ready
session" would protect a stranded, unrecoverable worker forever. So the discipline
is two-sided: suppress the **reflexive/blind** lifecycle action on a `stuck` flag,
but still allow a **bounded, evidence-backed recovery** when the live worker is
*proven unreachable* — preferring careful recycle over a blind respawn/claim that
re-creates split-brain. The guard buys the worker a grace window to be recognised as
review-ready, it does not grant permanent immunity.

## Binding surface

- **Consistent-snapshot classification.** Define, from observable state, when a
  `stuck`/idle-flagged session is a worker that finished against the **current** PR
  head — keyed on **one consistent snapshot**, not loosely-correlated predicates:
  - the linked session **owns the PR's current head**, **and**
  - its runtime is **alive** (the worker process is running), **and**
  - the current head's **required merge-contract CI is green** (same CI-green
    definition the pack already uses for `ready_for_review` / orchestrator
    recovery), **and**
  - its last accepted `ready_for_review` report is **for that head** (or was made
    after that commit became the head — a stale `ready_for_review` from before the
    head moved or ownership changed does NOT count), **and**
  - a review run covers that **same head/session pair**.
  A stale-report or head-moved race (all predicates loosely true on a head the
  worker never declared ready) MUST NOT classify as review-ready. **Red or pending
  required CI on the current head disqualifies the protection** — that worker is
  routed to the normal CI-failure / stuck handling, not shielded.
- **Only a finished worker is protected — `waiting_update` is out of scope.** Only a
  review run that is **covering/clean** (review passed; awaiting external reviewer or
  merge) grants the *review-ready* protection below — that is a *finished* worker. A
  **`waiting_update`** run means findings were *sent and the system is awaiting the
  worker to address them* — the worker is **not finished**, so it is **not**
  review-ready and gets **no** protection here; that leg (did the finding reach the
  worker, re-deliver/escalate) is GitHub #171's domain, not this guard's. To avoid a
  contradiction, the #171 **delivery-unconfirmed/escalated** state has a **single**
  meaning in this issue: it is *unreachability evidence* (the recovery side below),
  **never** a protection-granting state.
- **No reflexive lifecycle action; bounded, monotonic grace, then evidence-backed
  recovery.** For a session classified review-ready, pack orchestration MUST NOT
  *immediately* `ao spawn`, `--claim-pr`, kill, or respawn it on a
  `stuck`/`probe_failure` signal — it is left in place for a bounded grace window
  (and remains reachable for a #171 re-delivery). The grace is anchored **once** to
  the **first** false-stuck for the `(session, PR head)` snapshot and is
  **monotonic** — it has a documented maximum/default and does **not** restart on
  repeated `stuck`/`probe_failure` reports or re-observations, so a live-but-
  unreachable worker cannot be protected past the deadline. **However**, "runtime
  alive" is not proof of reachability: if within the grace the live worker is
  **proven unreachable by affirmative evidence** — a **failed bounded reachability
  attempt**, a #171 **delivery-unconfirmed/escalated** state, or #173 showing the
  flood **did not clear** — then bounded recovery **is** permitted, preferring a
  careful **recycle** with escalation over a blind respawn/claim that re-creates the
  PR #97 split-brain. **Mere absence** of an outbound progress signal from an
  otherwise-quiet review-ready worker is **not** evidence of unreachability and MUST
  NOT trigger recovery before the grace deadline (a clean review-ready worker may
  simply have nothing to report). The guard prevents *premature* destruction, not
  *all* recovery.
- **Genuine death is unchanged.** If the runtime is actually dead (process gone),
  this guard does **not** apply — the orphan-reap / respawn discipline (#98) still
  governs. The guard narrows only the *false-positive* case: a **live** process
  misread as stuck — and even then only buys a bounded grace, not immunity.
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

1. The review-ready classification keys on **one consistent snapshot** — linked
   session owns the current PR head **and** runtime alive **and** the current head's
   required merge-contract CI is **green** **and** last accepted `ready_for_review`
   is for that head (or after it became head) **and** a review run covers that same
   head/session pair — and is satisfiable without scraping the pane. Provable by a
   positive fixture and negative fixtures that are **not** classified review-ready:
   a **stale-report / head-moved** race (predicates loosely true on a head the worker
   never declared ready) and a **red-CI** and **pending-CI** current head.
2. Only a **covering/clean** run grants review-ready protection; a **`waiting_update`**
   run does **not** (the worker is mid-fix, not finished — that leg is #171's domain).
   The #171 delivery-unconfirmed/escalated state is used **only** as unreachability
   evidence (criterion 4), never to grant protection. Provable by fixtures:
   covering-run → protected; `waiting_update` → **not** protected.
3. A session classified review-ready is **not** *immediately* respawned, killed, or
   re-claimed on a `stuck`/`probe_failure` signal — it is held for a bounded grace.
   The grace is anchored to the **first** false-stuck for the `(session, PR head)`
   snapshot, has a documented maximum, and is **monotonic** — repeated `stuck`
   reports do **not** extend it. Provable by a fixture asserting no immediate
   lifecycle action within the grace, **and** a fixture where repeated stuck reports
   do not push protection past the deadline.
4. Recovery within the grace requires **affirmative** unreachability evidence — a
   failed bounded reachability attempt, a delivery-unconfirmed/escalated state, or a
   not-cleared flood — **not** mere absence of an outbound signal. When such evidence
   exists, bounded recovery proceeds as a careful recycle/escalation, not a blind
   `--claim-pr`/spawn. Provable by two fixtures: (a) affirmative-unreachable →
   recovery proceeds (recycle/escalate); (b) a **quiet but not affirmatively
   unreachable** review-ready worker stays protected until the grace deadline (no
   recovery on silence alone).
5. A genuinely dead session (runtime not alive) is **not** shielded — the existing
   orphan/respawn path (#98) still applies. Provable by a dead-runtime fixture
   asserting the guard does not suppress recovery.
6. An ordinary `stuck` session that is **not** review-ready (no qualifying
   `ready_for_review` for the head, or no covering run) is **not** shielded — normal
   stuck handling applies. Provable by a fixture asserting the guard does not
   over-reach.
7. The canonical `orchestratorRules` in `agent-orchestrator.yaml.example` carries
   the guard clause; the recovery/go-live runbook documents the behaviour, the
   bounded-grace-then-recovery path, and the `ao stop` / `ao start` adoption step.
   Provable by grep / inspection.

## Upgrade-safety check

- No edits to `packages/core/**`, `vendor/**`, or `.ao/**`.
- The durable rule lives in `agent-orchestrator.yaml.example` / `prompts/agent_rules.md`,
  never in the gitignored local `agent-orchestrator.yaml`.
- The guard narrows only the false-positive (live process misread as stuck); it does
  not weaken genuine-orphan handling (#98) or introduce any new worker-spawn path.
- No new repository secrets and no new GitHub Actions permissions.

## Verification

- Automated tests over fixtures cover: consistent-snapshot positive vs
  stale-report/head-moved, red-CI, and pending-CI negatives (criterion 1);
  covering-run protected vs bare `waiting_update` not protected (criterion 2); no
  immediate lifecycle action within the grace and repeated stuck reports not
  extending it past the deadline (criterion 3); affirmatively-unreachable → bounded
  recovery as recycle/escalation (not blind claim/spawn), but quiet-not-unreachable
  stays protected to the deadline (criterion 4); dead-runtime → recovery not
  suppressed (criterion 5); stuck-but-not-review-ready → normal handling
  (criterion 6). Run via the pack test runner.
- Grep confirms the `agent-orchestrator.yaml.example` `orchestratorRules` clause and
  the runbook adoption note incl. the grace-then-recovery path (criterion 7).
- Live smoke (operator, optional): with a review-ready worker flagged `stuck` by a
  flooded pane, confirm pack orchestration holds it through the grace (no immediate
  respawn/kill); and, when the worker is genuinely unreachable, that recovery
  proceeds as a careful recycle rather than a blind claim.
