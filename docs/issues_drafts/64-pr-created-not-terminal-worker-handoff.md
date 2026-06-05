# A freshly opened PR is not a terminal state — worker must drive `pr_created` to a hand-off signal

GitHub Issue: #186

## Prerequisite

- None blocking. Relates to (does not depend on):
  - GitHub #174 (`63-review-ready-worker-stuck-guard.md`) — that guard protects a
    worker that **already reported** `ready_for_review` from a false `stuck`. This
    issue ensures the `ready_for_review` is **emitted in the first place** on the
    initial PR-creation path; they are complementary halves of the same hand-off.
  - GitHub #109 (`37-ci-failed-ping-before-report-stale-backstop.md`) — that is the
    **orchestrator-side** CI-failure ping / `report-stale` backstop (recovery when a
    worker goes idle). This issue is the **worker-side primary obligation** the
    backstop exists to cover for; self-drive is primary, the backstop is recovery.

## Goal

A worker can open a PR for its task and then treat opening the PR as "done" —
going idle while required CI is still running and before ever reporting
`ready_for_review`. When that happens on a green-CI PR with no review findings,
nothing downstream advances: the orchestrator's merge-ready notification depends
on the worker's `ready_for_review`, so the PR strands with green CI and a clean
review that no one acts on.

Root cause (5 Whys, opk-3 / PR #185 incident): the worker went idle on a green PR
that never received `ready_for_review` → because nothing in `prompts/agent_rules.md`
**positively requires** the worker to drive a freshly created PR to a hand-off
signal → because the existing reporting rules are **negative or path-scoped**:
they forbid reporting `ready_for_review` *prematurely* (while CI is red) and forbid
going idle *on a red-CI PR* or *on the review-feedback path*, but none covers the
**initial `pr_created` → first-review** transition when CI is green and no findings
have landed yet → so "CI still running when I finished editing" reads to the worker
as a legitimate stopping point → the autonomous loop never closes.

The fix is a worker-facing rule that makes the initial PR-creation path carry the
same "do not go idle silently" obligation the review-feedback and red-CI paths
already carry: opening a PR is a transient state, not completion.

## Binding surface

- **`pr_created` is a transient state, not completion.** A worker-facing rule in
  `prompts/agent_rules.md` establishes that opening a PR for the task does not
  discharge the worker's obligation. The worker must drive that PR to an explicit
  **hand-off signal** before it may go idle, stop, or treat the task as done.
- **Two kinds of state — only two of them permit *stopping*.** Distinguish a state
  the worker may **disengage/stop** in from one it must stay **actively engaged** in:
  - **Disengage-permitting (stop) states — exactly two:** a **terminal hand-off**
    (`ao report ready_for_review` once **required CI for the current PR head is
    green**, reusing the pack's existing single **Required CI** definition — no new
    CI definition; or a **terminal-failure** report with a reason via the existing
    convention when the worker genuinely cannot reach a ready state), **or** an
    **evidence-backed escalation** to the orchestrator for degraded CI (below), a
    non-terminal hold in which the worker hands the baton over and stays reachable.
  - **Continued-engagement (must NOT stop) state:** while required CI is still
    resolving on the current head, the worker stays in the existing §Worker CI gate's
    reported handling **and remains actively engaged** — monitoring CI until it
    reaches green (→ `ready_for_review`), red (→ the existing fix path), or the
    degraded-CI escalation. Filing an in-progress report (e.g. `fixing_ci`) on
    pending CI is **not** a stopping point; treating it as "done for now" and
    disengaging is exactly the stranded-green-PR failure this issue closes, merely
    non-silent.
  Reaching green CI with no findings is **not** an exit by itself — the worker must
  still emit `ready_for_review`.
- **The hand-off is for the head observed at report time.** `ready_for_review`
  counts only when it corresponds to the PR's **current head at the moment of the
  report** — reusing the existing §Worker CI gate discipline ("check required CI for
  the current head **before every** `ao report ready_for_review`"). A report that
  validated an earlier head which has since moved (the worker's own later push, a
  rebase, or any head change between CI observation and the report) is **stale** and
  does **not** satisfy this obligation; the worker re-checks the current head and
  re-reports. This must not weaken or duplicate the existing current-head check — it
  binds the new initial-path obligation to it, consistent with #174's treatment of a
  stale `ready_for_review` after a head move.
- **Forbidden disengagement on an unreported PR — pending CI defers to the existing
  gate.** The worker MUST NOT stop or treat the task as done while a PR it opened has
  **not reached one of the two stop states** (terminal hand-off or evidence-backed
  escalation) for that PR's **current head** — **including** the case where CI was
  still running at the moment editing finished. While required CI is still running,
  the worker stays in the **existing §Worker CI gate's reported handling** for
  not-yet-green CI (today: `ao report fixing_ci` while red/pending) **and remains
  actively engaged** until CI resolves or it escalates — that in-progress report is
  not a stop state. This clause introduces **no new silent wait state**. Because the
  existing gate folds "red" and "still running" into one action, **reconciling that
  gate so a merely-pending head has one unambiguous reported action that does not
  read as permission to stop is in scope** for this `prompts/agent_rules.md` change
  (clarify the existing gate rather than add a parallel rule).
- **Degraded or non-resolving CI has a bounded escape — not infinite polling, not
  false terminal failure.** The stay-engaged obligation assumes CI eventually
  resolves to green or red. When it does **not** — required checks missing or never
  triggered, a run `cancelled`, auth / rate-limit / infrastructure failure, or CI
  pending past a reasonable bound — the worker MUST escalate with evidence (e.g.
  `ao send` to the orchestrator describing the blocked condition) rather than (a)
  polling indefinitely to satisfy the positive obligation, or (b) reporting
  **terminal failure** for what is a transient CI delay. Terminal failure is for a
  genuinely unreachable ready state, not for "CI is slow." This escalation is itself
  a **permitted non-silent hand-off**: after sending it the worker has satisfied the
  anti-silence obligation and may stop active polling while remaining reachable for
  the orchestrator's response — it does **not** leave the worker still bound to keep
  polling or forced to misreport terminal failure to "close" the PR. The rule states
  the obligation qualitatively (bounded wait → escalate) and leaves the exact bound
  and escalation channel to the worker / existing conventions; it complements the
  orchestrator-side CI-failure ping / `report-stale` backstop (#109), it does not
  restate it.
- **Consistency with existing rules (no contradiction, no duplication).** The clause
  **complements** and must not restate or conflict with the existing negative/scoped
  rules: the §Worker CI gate ban on *premature* `ready_for_review` while CI is red,
  and the §AO review response ban on idling *on the review-feedback path*. It closes
  the one path those leave open — initial creation with green/in-flight CI and no
  findings yet — and reuses their vocabulary (underscore state names, the Required CI
  definition, the terminal-failure convention) rather than introducing parallel terms.
- **Worker self-drive is primary.** The rule frames worker self-drive as primary and
  the orchestrator ping / `report-stale` backstop (#109) as recovery, consistent with
  the existing §Worker CI gate framing ("self-fix is primary").

## Files in scope

- `prompts/agent_rules.md` — the worker-facing clause closing the
  `pr_created` → first-review hand-off gap (placed with the existing worker
  reporting / CI-gate rules), **including** reconciling the existing §Worker CI gate
  so a merely-pending head has one unambiguous, non-silent reported action (clarify
  the existing gate, do not add a parallel rule).

## Files out of scope

- `agent-orchestrator.yaml.example` and `orchestratorRules` — the orchestrator-side
  reaction (merge-ready emission, stuck recovery) is governed by #174 / #109; this
  issue is the worker obligation only. The user scoped this fix to the worker
  contract.
- `packages/core/**`, `vendor/**`, `.ao/**` — AO core and local state.
- The local gitignored `agent-orchestrator.yaml`.
- Any change to the **Required CI** definition itself — this clause **reuses** it.

## Denylist

```denylist
# issue 64 — pr_created is not terminal (worker hand-off)
vendor/**
packages/core/**
.ao/**
```

```allowed-roots
prompts/**
```

## Acceptance criteria

1. `prompts/agent_rules.md` contains a worker-facing rule stating that opening a PR
   (`pr_created`) is a transient state, not task completion. Provable by inspection /
   grep of the clause.
2. The clause permits the worker to **disengage/stop** on the initial PR path in
   **exactly two categories** of state: (A) a **terminal hand-off** — itself either
   `ao report ready_for_review` once required CI for the current head is green (per
   the existing **Required CI** definition) **or** a terminal-failure report with a
   reason; or (B) an **evidence-backed escalation**. A still-resolving-CI in-progress
   report (e.g. `fixing_ci`) is neither category — it is a **continued-engagement**
   state, **not** a stopping point. Provable by inspection.
3. The clause forbids treating the task as done / disengaging while a PR the worker
   opened has **never reached** one of the two stop states for its current head,
   **including** when CI was still running at the moment editing finished, and
   explicitly names "filed an in-progress report on pending CI, then stopped" as a
   forbidden recurrence of the stranded-green-PR failure. It routes still-running CI
   to the existing §Worker CI gate handling (no new silent wait state), with
   reconciliation of that gate's pending action in scope. Provable by inspection.
4. The clause binds the hand-off to the **current head at report time**: a
   `ready_for_review` that validated an earlier, since-moved head is **stale** and
   does not satisfy the obligation, expressed as a **reuse** of the existing
   §Worker CI gate current-head check (not a new mechanism, consistent with #174).
   Provable by inspection.
5. The clause provides a **bounded escape** for degraded / non-resolving CI
   (missing / untriggered checks, `cancelled` runs, infra/auth failure, or
   over-bound pending): escalate with evidence (e.g. `ao send`) rather than poll
   indefinitely or report terminal failure for a transient delay — stated
   qualitatively, without pinning a numeric timeout. Provable by inspection.
6. The clause does **not** introduce a second CI-green definition, a new report state
   name, or a restatement that contradicts the existing §Worker CI gate (premature
   `ready_for_review` ban) or §AO review response (review-path idle ban). It reuses
   the existing Required CI definition, underscore state names, and terminal-failure
   convention. Provable by inspection and by the pack's existing markdown/skill
   consistency checks remaining green.
7. The repository's existing contract tests / CI for `prompts/agent_rules.md` (and any
   markdown-only no-ceremony scope-guard path that applies to a prompts-only change)
   pass on the change. Provable by green required CI on the implementing PR.

## Upgrade-safety check

- No edits to `packages/core/**`, `vendor/**`, or `.ao/**`.
- The durable rule lives in `prompts/agent_rules.md` (worker-facing canonical), never
  in the gitignored local `agent-orchestrator.yaml`.
- No new CI-green definition, no new report-state vocabulary, no orchestratorRules /
  reactions change.
- No new repository secrets and no new GitHub Actions permissions.

## Verification

- Grep / inspection confirms the new clause and that it covers: `pr_created` as
  transient (criterion 1), the two terminating signals with the existing Required CI
  reuse (criterion 2), the forbidden-idle condition including CI-still-running
  (criterion 3), current-head/stale-report binding (criterion 4), the bounded
  degraded-CI escape (criterion 5), and the absence of a duplicate CI definition /
  new state name (criterion 6).
- Required CI on the implementing PR is green, including any prompts-file or
  markdown-only consistency check the pack already runs (criteria 6–7).

## Adversarial review log (Codex, pre-sync)

One adversarial pass (`needs-attention`, 2 findings); both carried a real kernel,
evaluated against planner freedom and the prompt-rule (not code-guard) nature:

- **F1 (high) — head-specific hand-off not verifiable.** *Partial.* Real kernel: a
  stale `ready_for_review` after a head move must not satisfy the obligation (the
  #174 race). But Codex's remedy (fixture-style evidence) conflates a deterministic
  code-guard (#63/#174) with a worker-facing **prose rule** — requiring fixtures for
  an LLM-followed sentence is over-specification. Resolved by **reusing** the
  existing §Worker CI gate current-head check and adding inspection-level acceptance
  (criterion 4) — no new test machinery, planner freedom preserved.
- **F2 (medium) — stay-engaged rule has no bounded blocked path.** *Accept.* Real
  gap: "wait until CI resolves" assumes CI always resolves; cancelled / missing /
  untriggered / infra-failed CI would force infinite polling or a false terminal
  failure. Added a **bounded escalation** escape (criterion 5), stated qualitatively
  (no numeric timeout — that stays the worker's), complementing #109's
  orchestrator-side backstop.

Second pass (`needs-attention`, 2 findings) — both flagged tension my *own*
revisions introduced; both accepted:

- **F3 (high) — pending-CI path contradicts the existing §Worker CI gate.** *Accept.*
  The existing gate folds "red **or still running**" into one `fixing_ci` action;
  my "stay engaged until CI resolves" implied a new silent wait state. Resolved by
  deferring pending CI to the existing gate's reported handling (no new wait state)
  and putting **reconciliation of that gate's pending action in scope** of the same
  `prompts/agent_rules.md` change, so there is one unambiguous non-silent action.
- **F4 (medium) — degraded-CI escalation not a permitted hand-off vs the idle ban.**
  *Accept.* I had framed "exactly two terminating signals," which left escalation
  outside the permitted set → idle-ban would still bite after escalating. Reframed
  the prohibition as against **silent** idle, with three permitted non-silent states
  (terminal hand-off, in-progress report, evidence-backed escalation); escalation is
  an explicit non-terminal hold in which the worker stays reachable but need not
  poll. Removes the contradiction.

Third pass (`needs-attention`, 1 high) — caught a hole my own F4 fix opened;
accepted and applied **after the 3-pass cap** (no 4th Codex re-run — it is an
obvious tightening toward the core invariant, prescribed by the finding itself, and
the normal architect `codex review` gate re-checks it):

- **F5 (high) — in-progress report could satisfy the anti-idle rule and disengage.**
  *Accept.* Treating the §Worker CI gate in-progress report as a permitted *stop*
  state recreated the exact incident non-silently (file `fixing_ci` on pending →
  stop → CI greens → no `ready_for_review` → stranded). Split the states: only a
  **terminal hand-off** or an **evidence-backed escalation** permit stopping; a
  still-resolving-CI in-progress report is a **continued-engagement** state, never a
  stopping point.

Normal architect `codex review` pass then ran (P2): "exactly two states" but three
named signals — *Accept (clarity)*, reworded to **two categories** (A terminal
hand-off = `ready_for_review`-on-green *or* terminal-failure; B escalation).

Two further adversarial passes (operator-requested, beyond the 3-pass cap) both
returned **approve** — no remaining HIGH/MEDIUM contradiction, race, planner-freedom
violation, or scope creep; pending CI stays continued-engagement, degraded CI has the
escalation escape, current-head staleness reuses the existing check, scope stays in
`prompts/agent_rules.md`.
