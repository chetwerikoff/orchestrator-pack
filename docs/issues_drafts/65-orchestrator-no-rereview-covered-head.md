# Orchestrator must not re-review a head SHA already covered by a terminal review run

GitHub Issue: #189

## Prerequisite

- `docs/issues_drafts/58-safe-review-trigger-reconciliation.md` (GitHub #163,
  merged via PR #166 / #179) — shipped the mechanical reconciler with the
  authoritative "covered head" definition (`isHeadCovered` /
  `COVERED_TERMINAL_REVIEW_STATUSES` = `clean` / `needs_triage` /
  `waiting_update`, plus in-flight). This issue makes the **LLM-orchestrator
  prose loop** obey the same coverage semantics; the two trigger paths must
  share one definition of "covered", not drift.
- `docs/issues_drafts/34-review-layer-resilience-after-worker-respawn.md`
  (GitHub #98, merged) — the current `orchestratorRules` idempotency clause
  ("REVIEW RUN IDEMPOTENCY") it ships only suppresses a new run while a prior
  run for the head is **in-flight** (`running` / `reviewing`). This issue
  widens that clause; it does not replace #98.
- GitHub #54 (merged) — "MERGED PR — REVIEW LOOP TERMINAL". This issue closes a
  residual gap in that rule (a review run that carries no `prNumber`), it does
  not re-open the merged-run question.

## Goal

Stop the orchestrator from launching redundant review runs against a commit
that was already reviewed. Today two trigger paths can start `ao review run`:
the mechanical reconciler (#163), which correctly treats a `clean` /
`needs_triage` / `waiting_update` run on the current head as **covered** and
starts nothing; and the LLM-orchestrator review loop described in
`orchestratorRules`, whose idempotency clause only blocks a new run while a
prior run is still in-flight. When a PR sits at one head SHA waiting for a human
merge (e.g. `mergeable` → `stuck`), orchestrator turns keep firing while the
head never advances, and the prose loop re-issues review on the already-clean
commit. The outcome must be: a head SHA that is already covered by a terminal
review run gets **no** new review run from either path, and a review run linked
to a merged PR is terminal even when it carries no `prNumber`.

## Binding surface

This issue commits the repository to the following contracts.

- **Covered-head short-circuit (LLM-orchestrator loop).** Before initiating any
  `ao review run`, the orchestrator review loop MUST treat a head SHA as
  **covered** — and start nothing — when a review run for that exact head SHA is
  in-flight *or* is in a covered terminal status. The covered-terminal set is
  the same one the mechanical reconciler uses; the canon MUST NOT define a
  narrower set (e.g. in-flight only) for the prose path than for the
  reconciler. Via this covered/uncovered path a new run may be started only for
  a head with no review run at all, or whose only runs are `outdated`
  (superseded by a newer head SHA). The single exception is a `failed` /
  `cancelled` current-head run, which is **not** covered and does **not** go
  through this plain uncovered path — it follows the diagnose-then-retry-once
  discipline in the next clause.
- **`failed` / `cancelled` are not covered, but keep their existing
  discipline.** A `failed` or `cancelled` run on the current head is **not** a
  covered terminal status (never treat `findingCount: 0` on a failed run as
  clean), so the head is not blocked forever — but it is also not silently
  re-reviewed as if uncovered. The existing `orchestratorRules` discipline
  governs it unchanged: read `terminationReason` first, retry at most once after
  diagnosing the cause, escalate otherwise. This issue MUST NOT weaken or
  duplicate that EMPTY-REVIEW-TRAP / retry-once contract; it only states that
  `failed` / `cancelled` sit outside the covered set and outside the plain
  "uncovered → start one run" path.
- **Dual-path concurrency window (residual, bounded — not eliminated).** Two
  independent triggers (the LLM loop on a turn, the low-frequency reconciler on
  a tick) can both observe the same uncovered head before either's new run is
  visible in `ao review list --json`. The canon MUST require a **re-check of
  head coverage immediately before emitting `ao review run`** (read coverage,
  then run, with the smallest possible gap) so the exposed window is one path's
  read→run gap, not the whole turn/tick interval. Perfect cross-process
  serialization of the two triggers is explicitly **out of scope**: a rare
  double-run from simultaneous observation is acceptable residual risk — it
  self-heals (one run goes `outdated`, no worker-lifecycle effect) — and closing
  it fully would require a shared lock this issue does not mandate.
- **Single definition of "covered" — identity, not just status.** "Covered" is
  defined once and neither trigger path may diverge from it. The requirement is
  observable no-drift, **not** shared runtime plumbing: the reconciler's runtime
  predicate is unchanged (see **Files out of scope**); the prose canon must
  simply assert the same predicate, enforced by a guard. Coverage is the
  **full predicate**, not merely the status set: a run covers a head only
  when it matches the **same PR linkage** *and* the **exact normalized head
  SHA** *and* a covered/in-flight status. A run with the same SHA but a
  different PR (shared/reused commit) MUST NOT be treated as coverage — that
  would silently skip a needed review, the very failure this issue prevents.
  The acceptance is observable drift-prevention: a guard fails if the prose
  canon and the reconciler disagree on this predicate (the planner chooses the
  guard mechanism). This issue does not pick which path "wins" at runtime — it
  guarantees they cannot diverge on the coverage predicate.
- **Merged-PR terminal applies to `prNumber`-less runs (#54 residual).** A
  review run is terminal-on-merge when its linked worker session belongs to a
  merged PR, **even if the run record carries no `prNumber`**. The merged-PR
  terminal rule MUST resolve merge state via the run's linked session (and that
  session's PR), not solely via a `prNumber` field on the run. This closes the
  observed race where merge cleanup kills and re-launches the worker session,
  and a review run created on the restored session lands with no `prNumber` and
  escapes the terminal guard.
- **Degraded session linkage → fail closed to inaction.** The restored-session
  race can also leave the linkage un-resolvable: the linked session is absent
  from `ao status`, was restored under a different id, or its PR metadata is
  missing or ambiguous. When a `prNumber`-less run's merge state **cannot** be
  resolved to a specific merged PR, the orchestrator MUST default to **inaction**
  — no `ao review send`, no new review round, no worker-lifecycle action — and
  surface the run for the operator rather than guess. Inaction is safe because
  "terminal" here means *do nothing*; the failure mode to prevent is acting
  (send / new round / wrong-PR work) on an unresolved run, not leaving a stale
  card. This matches #54's orchestrator-inaction policy.
- **No new worker-lifecycle effect.** This issue changes only when a review run
  is or is not *initiated*, and how a merged run is *recognized as terminal*. It
  MUST NOT add or change any `ao spawn`, `--claim-pr`, `ao session kill`, or
  worker `ao send` behaviour (the #163 / #97 split-brain invariant stays).
- **Operator adoption** (touches operator-facing surfaces):
  - Merge the updated `orchestratorRules` block from
    `agent-orchestrator.yaml.example` into the live, gitignored
    `agent-orchestrator.yaml`; `ao stop` / `ao start` so the orchestrator reads
    the widened idempotency clause.
  - Any recovery-runbook note on recognizing / clearing redundant covered-head
    runs and `prNumber`-less merged runs that the design introduces.

## Files in scope

- `agent-orchestrator.yaml.example` — canonical `orchestratorRules`: widen the
  review-run idempotency clause to the covered-terminal set, and extend the
  MERGED-PR terminal clause to `prNumber`-less runs via the linked session.
- `prompts/agent_rules.md` — the universal mirror of the same review-loop
  contract, kept consistent with the canon.
- `scripts/**` — the static regression guard(s) that assert the canon contains
  the covered-head and `prNumber`-less-merged clauses (extend the existing
  idempotency guard or add a new one, as the planner declares), plus any
  fixtures.
- `docs/**` — recovery / go-live runbook updates if the operator-facing
  recognition steps change.

## Files out of scope

- `packages/core/**`, `vendor/**` — never edited.
- `scripts/review-trigger-reconcile.ps1` / `docs/review-trigger-reconcile.mjs`
  behaviour — the reconciler already implements the correct coverage; this
  issue aligns the prose loop *to* it, it does not re-spec the reconciler. (A
  shared coverage definition MAY be referenced, but the reconciler's runtime
  behaviour does not change.)
- AO worker-spawn / lifecycle code paths.
- The orchestrator's finding-triage / fix-delegation / merge-decision logic.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

## Acceptance criteria

1. **Covered-terminal head is not re-reviewed.** The canonical
   `orchestratorRules` (and its `prompts/agent_rules.md` mirror) state that the
   orchestrator must not initiate a new review run for a head SHA that already
   has a review run in a covered terminal status (`clean`, `needs_triage`,
   `waiting_update`) or an in-flight status — only an uncovered head or a head
   whose only runs are `outdated` may get a new run. Provable by a static guard
   that fails if the canon lacks the covered-terminal short-circuit (the current
   guard only checks the in-flight phrasing).
2. **Coverage predicate cannot drift.** A guard fails if the prose canon and the
   mechanical reconciler disagree on the coverage **predicate** — same PR
   linkage *and* exact normalized head SHA *and* covered/in-flight status, not
   the status set alone. Provable by a check/fixtures comparing predicate
   behaviour, including a same-SHA-different-PR case (must NOT count as covered)
   and a same-PR-different-SHA case (must NOT count as covered), failing on
   divergence.
3. **`failed` / `cancelled` stay on the existing retry path.** The canon states
   that `failed` / `cancelled` runs on the current head are not covered (not
   re-reviewed as plain uncovered) and are governed by the existing
   `terminationReason` / retry-once / escalate discipline — neither blocked
   forever nor silently re-run. Provable by a static guard asserting the clause
   and by fixtures presenting a `failed` and a `cancelled` run on the current
   head asserting the existing-discipline outcome (one diagnosed retry, not an
   unconditional new run and not permanent block).
4. **Pre-run coverage re-check.** The canon requires re-reading head coverage
   immediately before emitting `ao review run`, and the design exposes only one
   path's read→run gap (not the full turn/tick interval). Provable by a static
   guard asserting the re-check clause and a fixture where a run becomes covered
   between the loop's first observation and the pre-run re-check, asserting no
   new run is emitted.
5. **Merged-PR terminal covers `prNumber`-less runs.** The canon states that a
   review run whose linked session belongs to a merged PR is terminal even when
   the run carries no `prNumber`, resolved via the linked session rather than a
   run-level `prNumber`. Provable by a static guard asserting the clause, and —
   where the design adds executable logic — a fixture reproducing the
   "merged PR, session restored, run has no `prNumber`" shape and asserting the
   run is classified terminal (no send / no new round).
6. **Unresolvable linkage fails closed to inaction.** For a `prNumber`-less run
   whose merge state cannot be resolved to a specific merged PR — linked session
   missing from `ao status`, restored under a different id, or ambiguous/missing
   PR metadata — the orchestrator takes no `ao review send`, no new round, and no
   worker-lifecycle action, and surfaces the run for the operator. Provable by
   fixtures for each degraded shape (session missing; restored-id mismatch;
   ambiguous PR metadata) asserting inaction (no send / no new run) rather than a
   guess.
7. **No worker-lifecycle change.** No acceptance criterion or shipped change
   introduces `ao spawn` / `--claim-pr` / `ao session kill` / worker `ao send`.
   Provable by inspecting the diff and the forbidden-command guards already in
   the repo staying green.
8. **Regression fixture for the observed incident.** A fixture representing two
   covered runs on one head SHA (`clean` then a turn that would otherwise
   re-trigger) asserts that no third run is initiated. Provable by that fixture
   under the pack test runner.
9. **Operator docs updated.** Any new operator recognition/recovery step is in
   the runbook, and `agent-orchestrator.yaml.example` carries the widened
   clauses. Provable by inspecting those files.

## Upgrade-safety check

- No edits to AO core or `vendor/**`.
- No unsupported AO YAML fields: drive everything through `orchestratorRules`
  prose + the existing CLI; on AO 0.9.x a `reviewer:` block is silently ignored.
- No new repository secrets; no new always-on process (this is a prose-contract
  + static-guard change, not a new daemon).
- Composes with #98 idempotency, #163 reconciler coverage, and #54 merged-PR
  terminal rather than duplicating or contradicting them.

## Verification

The planner proves done with checks/fixtures mapping 1:1 to acceptance criteria:

- Criteria 1–2: static guard(s) over `agent-orchestrator.yaml.example` and
  `prompts/agent_rules.md` asserting the covered-terminal short-circuit and the
  no-drift coverage **predicate** check (same PR linkage + exact head SHA +
  covered/in-flight status), with same-SHA-different-PR and
  same-PR-different-SHA cases asserting non-coverage.
- Criterion 3: static guard for the `failed` / `cancelled` clause plus fixtures
  presenting a `failed` and a `cancelled` run on the current head, asserting the
  existing diagnose-then-retry-once outcome (not unconditional new run, not
  permanent block).
- Criterion 4: static guard for the pre-run re-check clause plus a fixture where
  the head becomes covered between first observation and the pre-run re-check,
  asserting no new run.
- Criteria 5–6: static guard for the `prNumber`-less merged clause and the
  fail-closed-to-inaction clause, plus fixtures for the
  "merged PR, session restored, no `prNumber`" terminal case and each degraded
  shape (session missing; restored-id mismatch; ambiguous PR metadata) asserting
  inaction.
- Criterion 7: `git diff` review and the existing forbidden-command / split-brain
  guards passing.
- Criterion 8: the two-covered-runs-on-one-head fixture asserting zero new runs.
- Criterion 9: show the updated example config and runbook in the PR diff.
- Live smoke (operator, post-merge, optional): with a PR sitting at one head SHA
  that already has a `clean` run, confirm no further review runs appear in
  `ao review list --json` across orchestrator turns until the head advances.
