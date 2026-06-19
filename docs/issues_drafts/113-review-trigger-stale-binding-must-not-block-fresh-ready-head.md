# Stale older ready_for_review reports must not block a head that has its own fresh hand-off

GitHub Issue: #352

## Prerequisite

All merged; this draft **extends** them, it does not replace any:

- `docs/issues_drafts/74-review-head-ready-report-sha-independent-binding.md`
  (GitHub #218, merged) — made the head-ready predicate fire on SHA-less
  `ready_for_review` reports and added the supersession guard (an older report
  must not authorize a newer head). **This draft fixes the cell #218 left open:
  a fresh current-head report and stale older reports coexisting.**
- `docs/issues_drafts/72-reconcile-ready-head-defer-subreason.md` (GitHub #212,
  merged) — introduced the enumerable defer subreasons including
  `stale_report_binding` and the deterministic `primary`/branch fields this
  draft re-classifies.
- `docs/issues_drafts/67-orchestrator-review-gate-on-handoff.md` (GitHub #195,
  merged) — the "ready_for_review for the exact head + CI contract" hand-off
  gate whose intent (a head with a valid hand-off is eligible) this draft
  restores for the coexistence case.
- `docs/issues_drafts/106-review-and-cinudge-per-cycle-settle-gate.md`
  (GitHub #332, merged) — owns the per-cycle settle debounce that currently
  expresses the wrongful block as `ready_for_review_debounce_pending`; this
  draft must keep #332's storm-suppression intact.
- `docs/issues_drafts/88-review-start-atomic-claim.md` (GitHub #267, merged) and
  `docs/issues_drafts/100-review-start-claim-atomic-single-winner.md`
  (GitHub #308, merged) — the atomic per-(PR, head) single-winner start claim
  shared by all automated starters. This draft **does not** add a new lock; it
  must keep newly-eligible heads flowing through this existing claim so
  concurrent eligible evaluations still produce one start.
- `docs/issues_drafts/65-orchestrator-no-rereview-covered-head.md` (GitHub #189,
  merged) — the pre-run re-check that bounds dual-path TOCTOU. The eligibility
  verdict here must remain subject to that re-check, not bypass it.
- Context only (the open sibling whose premise this repairs):
  `docs/issues_drafts/112-review-loop-worker-fresh-green-fast-reengage.md`
  (GitHub #348, open) — handles the inverse case (current head **lacks** a
  fresh report). Its design explicitly assumes a head that **has** a bound
  current-head report is started by the existing report-driven path; this draft
  makes that assumption true.

**Implementation gate (capture-backed):** before changing the predicate, capture
real AO 0.9.x session state from a multi-round review PR and identify the
durable monotonic observable that ties a `ready_for_review` report to a head's
worker iteration. If captured state exposes **no** such observable, stop and
escalate — do not implement against synthetic ordering fields or test-only
injection.

## Goal

Make the automated review-trigger paths start a review on a PR head that has a
genuine fresh `ready_for_review` hand-off on green CI, even when earlier
SHA-less `ready_for_review` reports from prior commits are still present in the
worker session. Today, on a long-running review→fix PR, those accumulated older
reports trip the supersession guard and the head-ready predicate defers every
tick, so AO-local review never auto-starts and depends entirely on an
orchestrator LLM turn to fire it.

```behavior-kind
action-producing
```

## Background (why this is open)

On a PR that has gone through many review→fix rounds, the worker has reported
`ready_for_review` once per head. AO 0.9.x reports carry no head SHA, so each
old report is SHA-less. When the worker hands off the current head, the
predicate correctly sees a fresh current-head report — yet the **older**
SHA-less reports (timestamped before the current head was committed) still
satisfy the supersession guard, which emits a **blocking** `stale_report_binding`
component. The head is then deferred as `ready_for_review_debounce_pending`
despite having a valid current-head hand-off and green CI.

Observed on PR #344, head `0c7da45`: the automated trigger recorded
`stale_report_binding` (not `no_ready_for_review` — the current head **did**
have a fresh report) every tick; across the PR's history the periodic reconcile
logged only skips (no start), and the CI-green wake path likewise never started.
Each review that did run was started by an orchestrator LLM turn, not by an
automated trigger path.

## Binding surface

- The shared head-ready predicate MUST treat a head as eligible when it has a
  valid fresh `ready_for_review` hand-off on green, uncovered CI **regardless of
  how many older SHA-less `ready_for_review` reports remain in the session**.
  The mere presence of stale older reports MUST NOT, on its own, defer a head
  that already carries its own current-head hand-off.
- The supersession contract from #218/#195 MUST be preserved exactly: when the
  current head has **no** fresh hand-off and only an older report exists, the
  head still defers (it is not authorized by the stale report). This draft
  changes only the **coexistence** case (fresh current-head report **and** stale
  older reports both present), not the stale-only case.
- **Freshness MUST be anchored to a monotonic, append-only observable, not to a
  rewritable commit timestamp.** Because AO reports are SHA-less, a report is
  bound to the current head by *ordering*, and that ordering MUST rest on an
  observable the worker session already exposes monotonically — the order in
  which the worker emitted reports relative to its head-change observations — and
  MUST NOT rest on the commit's own author/committer timestamp, which a rebase,
  amend, cherry-pick, or imported commit can rewrite. **Mere emission-after-head
  is not a hand-off:** "latest under the emission order, no newer head observed
  after it" is necessary but not sufficient — a stale report that is delayed,
  replayed, or recovered and lands *after* the current-head observation MUST NOT
  be read as a hand-off. The observable MUST tie the authorizing report to the
  **current head's worker iteration / hand-off event**; absent that tie, the head
  defers. **Fail-closed on ambiguity:** when freshness cannot be established from
  such a monotonic
  ordering (e.g. the only thing that would mark a report "fresh" is a mutable
  commit timestamp), the head MUST be classified **not authorized** (defer), so a
  false-fresh classification — which would authorize review of an un-handed-off
  head and break #218/#195 supersession — is structurally impossible rather than
  left to a heuristic. The same fail-closed rule covers an **incomplete** ordering:
  if a crash/resume, session truncation, or recovery leaves the report/head-change
  ordering partial — so the latest genuine hand-off cannot be established — the
  head defers; an incomplete session MUST NOT let an older report read as the
  current-head hand-off. **Continuity:** when session identity rolls over,
  durable checkpoints are missing, or the ordering stream shows a gap that
  could hide a lost hand-off or head-change event, freshness MUST be classified
  ambiguous/incomplete-fail-closed (defer) — append-only order alone does not
  prove a complete history. The planner picks the exact monotonic observable; the
  contract is that timestamp-only freshness is insufficient and that ambiguous or
  incomplete ordering defers.
  **The monotonic observable MUST already exist in real AO 0.9.x session state**
  (no worker / `packages/core` / report-shape change — #218 settled that). If the
  real captured state exposes **no** durable ordering observable, the predicate
  fails closed and the head keeps deferring — the same status quo as today (no
  regression) — and that absence MUST be escalated before implementation, never
  papered over with a test-only synthetic ordering field (see Verification).
  (The inverse error — a genuinely fresh report misread as absent — is **out of
  scope here** and owned by #348; this draft must not regress into starting an
  un-handed-off head.)
- The #212 defer subreasons MUST stay distinguishable and the deterministic
  `primary`/branch fields MUST remain branch-complete. In the coexistence row,
  `stale_report_binding` MUST NOT appear as a **blocking** failed-component and
  MUST NOT be the `primary`/branch cause. Whether the stale condition is retained
  as a **non-blocking diagnostic** or dropped entirely is the planner's choice —
  the binding requirement is only that it never blocks a head that has a fresh
  current-head hand-off. No existing subreason (`head_covered`,
  `failed_or_cancelled_on_head`, required-CI red/missing/not-yet, degraded-CI
  hand-off) may regress.
- **The decision record MUST expose the freshness basis.** The verdict/defer
  record for a head MUST carry which basis decided it — fresh-by-monotonic-order
  (eligible), stale-only (an older report present but no fresh hand-off),
  no-report (no report at all), or ambiguous/incomplete-fail-closed — so a
  reviewer or a later investigation can tell *why* a head started or
  deferred without re-deriving it from raw session state. When more than one
  label could apply, **`ambiguous/incomplete-fail-closed` takes precedence** (the
  audit field is mutually exclusive). (This is the diagnostic
  gap that made the original incident opaque.) The freshness basis is an **audit
  field orthogonal to** the #212 `primary`/branch **defer** subreasons: the
  eligible value is decision metadata, not a defer cause, and MUST NOT be forced
  into the defer-subreason structure or pollute `primary`/branch semantics (unless
  that structure already carries non-defer decision metadata).
- The #332 per-cycle settle debounce MUST keep suppressing per-commit storms;
  the fix MUST NOT reopen the storm #332 closed. A head that is genuinely inside
  the settle window still debounces for the #332 reason, not for stale-binding.
- The eligibility verdict MUST be bound to a **single evaluated head SHA**: the
  CI result, the coverage check, and the hand-off-freshness check that produce a
  verdict MUST all be read for that same head, so a push mid-evaluation cannot
  combine one head's fresh report with another head's CI or coverage. This
  preserves, and does not replace, the #189 pre-run re-check.
- The repaired classification MUST be the single shared evaluation used by all
  automated paths that classify head-readiness (periodic reconcile, event-driven
  wake, deferred-head re-evaluation, CI-green worker wake, orchestrator-loop
  advisory helper) — no path may keep a private blocking
  stale-binding rule. Making a previously-always-deferred head eligible MUST NOT
  weaken single-start: the newly-eligible head MUST still pass through the
  existing #267/#308 atomic per-(PR, head) single-winner claim, so concurrent
  eligible evaluations across paths yield exactly one started run. This draft
  adds **no** new lock — it relies on the shipped claim.

## Files in scope

- The review head-ready predicate helpers and their consumers under `docs/`
  (the `*.mjs` review trigger / reconcile / orchestrator-loop helpers that
  classify head-readiness and emit defer components).
- The production trigger entrypoints / wrappers under `scripts/` that invoke
  those helpers (the reconcile / CI-green wake / event-driven / deferred-head
  re-evaluation starters) — in scope so none retains a private blocking
  stale-binding rule outside the shared `.mjs` classifier. The primary fix stays
  in the shared predicate; **surgical wrapper edits are allowed** when behavioral
  tests show a private early return or stale-binding branch that must delegate to
  the shared classifier.
- The reconcile/trigger tests and fixtures under `scripts/` (`*.test.ts` and
  their JSON fixtures).
- Type-declaration siblings (`docs/*.d.mts`) only if exported shapes change.
- The declaration snapshot under `docs/declarations/` for this issue (always
  committed via `ao-declare`, not hand-edited).

## Files out of scope

- `agent-orchestrator.yaml.example` and `orchestratorRules` prose — the #195/#332
  contract wording is unchanged; this repairs the mechanical predicate only.
  Touch only if a reviewer shows the prose asserts the wrongful block.
- The worker-side re-engagement build (#348) and review delivery/send paths.
- `packages/core/**`, `vendor/**`, AO CLI behavior — do not attempt to make AO
  store a head SHA on reports (#218 already settled: derive from observable
  state, not from a report-stored SHA).

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

## Acceptance criteria

1. On a session that holds a **fresh** `ready_for_review` hand-off for the
   current head — the latest hand-off under the session's monotonic emission
   order, with no newer head observed after it, **and tied by the raw AO 0.9.x
   observable to the current head's worker iteration / hand-off event** (not
   merely "latest emission wins") — **and** one or more **older** SHA-less
   `ready_for_review` reports from prior commits, with required CI green and the
   head uncovered, the head-ready predicate classifies the head as **eligible**
   and the reconcile plans/starts exactly one review run (`started == 1`). The
   positive fixture asserts that worker-iteration tie, and eligibility MUST NOT
   depend on a bare "report timestamp at/after commit time" comparison (see
   criterion 4) or on bare "latest emission" (see criterion 11).

2. Supersession is preserved (no regression of #218 criterion 3): on a session
   whose **only** `ready_for_review` report is bound to a **prior** head
   iteration — no observable tie to the current head's worker iteration /
   hand-off event under the monotonic ordering (no fresh hand-off for the
   current head) — the head **defers**; it is not authorized by the stale
   report. Commit timestamps alone MUST NOT satisfy this criterion.

3. The block is re-classified, not merely relabeled: in the criterion-1
   scenario, the defer/skip path is **not taken** — there is no
   `ready_for_review_debounce_pending` / `uncovered_not_ready` outcome attributable
   to `stale_report_binding`, and `stale_report_binding` does not appear as a
   blocking failed-component or as the `primary`/branch cause, for a head that has
   a fresh current-head hand-off on green CI. (Whether a non-blocking diagnostic
   trace is retained is unconstrained — only the blocking path is forbidden.)

4. False-fresh is impossible (supersession regression guard): on a session whose
   only `ready_for_review` is an **older** hand-off whose commit timestamp was
   **rewritten** to appear at/after the current head commit (rebase / amend /
   cherry-pick / imported-commit fixture, non-monotonic ordering), the predicate
   classifies the head as **not** authorized and starts no review for the
   un-handed-off head. The criterion-1 and criterion-4 fixtures differ **only** in
   whether a genuine current-head hand-off exists under the monotonic emission
   order — not in the commit-vs-report timestamp relation, which is identical in
   both — proving eligibility does not rest on that timestamp comparison. When
   freshness cannot be established except by the rewritten timestamp, the
   predicate **fails closed** (defers).

5. #332 storm-suppression is intact: a worker that pushes a new commit and
   re-hands-off **inside** the per-cycle settle window still debounces for the
   #332 settle reason (one action per cycle), not via the stale-binding block;
   the per-cycle cap on review starts per worker-iteration is unchanged.

6. The other #212 defer subreasons still fire for their real cases —
   `head_covered`, `failed_or_cancelled_on_head`, required-CI red/missing/not-yet,
   degraded-CI hand-off — none regress to a false "ready," and the deterministic
   `primary`/branch fields stay branch-complete.

7. All automated trigger paths reach the criterion-1 verdict through the same
   shared classification, and a test or assertion shows no path retains a private
   blocking stale-binding rule. Each path's fixture asserts the **downstream
   outcome**, not merely that it consulted the shared classifier, **split by
   consumer type**:
   - **Action-producing starters** (periodic reconcile, event-driven wake,
     deferred-head re-evaluation): on the coexistence-eligible head the path
     plans exactly one start through the #267/#308 claim (no skip, no double-plan),
     and on a defer row it emits the expected #212 subreason/audit shape — so it
     cannot use the eligible verdict yet skip, double-start, or emit a misleading
     status.
   - **Advisory / classification-only consumers** (CI-green worker wake,
     orchestrator-loop helper): must expose the same eligible/defer classification
     and freshness-basis audit as the starters, but are **not** required to own or
     simulate a review-start plan — the CI-green path nudges the worker per #191;
     forcing a claim-path through these consumers would over-specify planner-owned
     internals and invite fake plumbing.

8. Single-start is preserved for the newly-eligible head (no regression of
   #267/#308/#189): when two or more trigger paths evaluate the same
   coexistence-eligible head concurrently, exactly one review run is started — the
   existing atomic per-(PR, head) single-winner claim and the #189 pre-run
   re-check still gate the start, and this draft adds no new lock. A fixture
   exercises concurrent eligible evaluations and asserts `started == 1`. The
   captured planned decision preserves the production **ordering** — eligible
   verdict → claim attempt → #189 pre-run re-check for the same head → would-start
   — and a **negative fixture** where the head becomes covered/superseded after
   eligibility but before start shows #189 flips the captured decision to
   **no-start** (the TOCTOU edge #189 bounds), not a start. Wrapper dry-run
   proofs (criterion 13) exercise planned effects only; the concurrent
   single-start assertion MUST additionally run against the **production**
   review-start-claim implementation with an **isolated temporary state
   backend** — not a mocked claim — so the atomic single-winner boundary is
   proven separately from write-disabled wrapper harnesses.

9. The eligibility verdict is bound to one evaluated head SHA: a test shows the
   CI, coverage, and hand-off-freshness inputs that produce the verdict are read
   for the same head the verdict is attributed to (a head advancing mid-evaluation
   does not yield a verdict mixing inputs from two heads).

10. Incomplete/resumed session fails closed: on a crash/resume or truncated-session
    fixture where the report/head-change ordering is partial (a head-change
    observation or a report emission is missing), the predicate does **not**
    authorize the head from an older report — it defers (fail-closed), never
    false-authorizing an un-handed-off head.

11. Replayed/delayed stale report does not false-authorize: on a fixture where a
    stale `ready_for_review` from an earlier iteration is **emitted/replayed after**
    the current-head observation (with no genuine hand-off for the current head),
    the predicate defers — emission-after-observation alone does not authorize;
    only an observable tying the report to the current head's worker iteration
    does.

12. The decision record exposes the freshness basis: a test asserts the
    verdict/defer record for a head carries which basis decided it
    (fresh-by-monotonic-order / stale-only / no-report /
    ambiguous/incomplete-fail-closed), consistent with the #212
    enumerable-subreason contract. The stale-only and no-report bases stay
    distinguishable (an older report failing supersession is **not** recorded as
    "no report existed").

13. The action-producing production trigger wrappers/entrypoints (advisory-only
    consumers are covered by criterion 7) are validated **behaviorally**, not by a
    string/static check alone: each is exercised against the frozen coexistence
    fixture and must produce the eligible downstream outcome, so a wrapper cannot
    still block the same case through a renamed branch, an early debounce return,
    or a private "not ready" conversion before/after the shared classifier.
    **Every** such wrapper proof MUST run under a deterministic,
    **no-network / no-GitHub-write / no-real-claim / no-real-review-start**
    harness (the same write-disabled boundary as the reconcile dry-run): it
    asserts the *planned* effect — "would start exactly one through the #267/#308
    claim" as a captured decision — and MUST NOT create a real review run, claim
    record, GitHub comment/status, or Issue transition while testing.

```positive-outcome
asserts: with a fresh current-head ready_for_review hand-off plus older SHA-less ready_for_review reports, green CI, and an uncovered head, the predicate classifies the head eligible and plans exactly one review run (production start, or write-disabled would-start capture per criterion 13)
input: external-tool-output
provenance: capture-backed
```

The capture MUST be frozen as an immutable in-repo fixture; the live PR #344
state is **provenance only**, never the executable test input, so the regression
test cannot rot when live GitHub/CI state ages out or is edited. The fixture MUST
be **minimal and redacted**: an explicit allowlist of only the raw fields the
predicate consumes — report state, the ordering/iteration markers, head
observation, required-CI conclusion, **and the head-scoped coverage / review-run
state** (covered terminal/in-flight, failed/cancelled-on-head) the verdict path
reads — never a verbatim raw AO session/log dump. The coverage and CI fields used
by the matrix rows (criterion 6) and the same-head binding (criterion 9) MUST be
these committed fixture fields under the same deterministic injection, **not**
synthesized in the test or fetched from live state. Credential-bearing logs,
tokens, auth headers, local filesystem paths, and unrelated session/issue
metadata MUST NOT be committed, and a secret-scan gate MUST pass before the
fixture lands. (The `.ao/**` denylist does not by itself
prevent copying secrets into a `scripts/` fixture — this allowlist + scan does.)

### Full-class decision matrix (target the class, not the PR #344 case)

The decision is over these input dimensions; **each enumerated row** below is an
authoritative fixture for a distinct behavioral class (not the full A×B×CI×cover
cartesian product). Every listed row must hold, not only the reproduced one. `A` = fresh `ready_for_review` for the current head present;
`B` = stale older SHA-less `ready_for_review` report(s) present; `CI` = required
CI on the current head; `cover` = current-head coverage. Each row is a fixture.

| A | B | CI | cover | Expected verdict |
|---|---|----|-------|------------------|
| yes | yes | green | uncovered | **eligible → start 1** (the bug cell; PR #344 `0c7da45`) |
| yes | no | green | uncovered | eligible → start 1 (#218 AC1 happy path, unchanged) |
| no | yes | green | uncovered | defer — **stale-only** basis, `stale_report_binding` kept distinguishable (an older report failed supersession; #218 AC3) — **not** collapsed to `no_ready_for_review` |
| no | no | green | uncovered | defer `no_ready_for_review` — **no-report** basis (no report existed at all) |
| yes | yes | red | uncovered | defer required-CI red (CI gate wins) |
| yes | yes | missing/not-yet | uncovered | defer required-CI not-yet |
| yes | yes | green | covered terminal/in-flight | defer `head_covered` (#189) |
| yes | yes | green | failed/cancelled-on-head | defer `failed_or_cancelled_on_head` |
| yes | yes | green | uncovered, inside #332 settle window | debounce for the #332 settle reason (not stale-binding) |
| no (only an older report, commit-time rewritten to look fresh) | yes | green | uncovered | defer — **not** authorized (false-fresh forbidden; #218/#195 supersession) |
| yes | yes | green | uncovered, two+ paths evaluate concurrently | exactly one start via the #267/#308 single-winner claim |
| yes | yes | degraded | uncovered | degraded-CI hand-off routing (#195/#212), not stale-binding |
| (ordering partial — crash/resume/truncated session) | yes | green | uncovered | defer — fail-closed, never authorize from the older report |
| no genuine current-head hand-off; an older stale report is **emitted/replayed after** the current-head observation | yes | green | uncovered | defer — emission-after-observation is **not** a hand-off; authorize only when the observable ties the report to the current head's worker iteration |

The first row is the sibling cell that shares the root cause with #218's
stale-only case; closed siblings #218/#212/#332/#195/#267/#308/#189 must be
cross-checked for no-regression on the remaining rows. The false-fresh row guards
the supersession direction this change could newly break; the concurrent row
guards the single-start invariant the claim layer owns.

## Upgrade-safety check

- No edits to `packages/core/**` or `vendor/**`; no change to AO CLI flags or
  the AO 0.9.x report shape (still no head SHA on reports).
- No new unsupported `agent-orchestrator.yaml` fields and no new repo secrets.
- Committed test fixtures carry **no** secrets or private session data — only the
  allowlisted, redacted raw fields the predicate needs; a secret-scan gate passes
  before any AO/CI-derived fixture lands.
- `ao-declare --issue <N>` run with `--declared-paths` and/or `--declared-globs`
  covering every path under **Files in scope** (the planner picks concrete entries
  from that section); the resulting snapshot under `docs/declarations/` is
  committed — not hand-edited. Export-shape changes are not a prerequisite for
  declaring scope.
- The fix must hold against the real AO 0.9.x report shape (SHA-less reports);
  it must not assume an AO version that records a report head SHA.

## Verification

- Unit/integration: the reconcile test suite
  (`scripts/review-trigger-reconcile.test.ts` and the ci-green / event-driven /
  orchestrator-loop test siblings) covers every row of the full-class matrix,
  including the coexistence happy-path fixture (criterion 1/3), the stale-only
  supersession fixture (criterion 2), the false-fresh / rewritten-commit-time
  fixture (criterion 4), the degraded-CI hand-off row (criterion 6), the
  concurrent-eligible single-start fixture (criterion 8), the same-head-snapshot
  fixture (criterion 9), the incomplete/resumed-session fail-closed fixture
  (criterion 10), the replayed/delayed-stale-report fixture (criterion 11), and
  the freshness-basis audit assertion (criterion 12).
- Coverage split: the **full-class matrix** (every row) is proven at the shared
  classifier / reconcile suite level; each **production wrapper** behaviorally
  proves the coexistence-eligible row **plus at least one defer row** that
  exercises its own private early-return risk — not a replay of every matrix row
  in every wrapper (which would only add brittle fixture duplication).
- **Behavioral** wrapper proof (action-producing starters): each is *executed*
  against the frozen coexistence fixture under a write-disabled harness (no
  network / no GitHub write / no real claim / no real review-start) and must
  produce the eligible **planned** outcome — "would start exactly one" as a
  captured decision, not a real side effect (criterion 13). Advisory-only
  consumers prove classification/audit parity only (criterion 7). A static/grep
  check for a named stale-binding string is **supplemental only** — never a
  substitute for the behavioral run, so a renamed branch / early debounce return
  / private "not ready" conversion cannot pass silently.
- This `*.test.ts` suite runs through the `.mjs` classifier on Linux (the
  pack's node/vitest path), exercising the shared predicate directly — not only
  through the PowerShell wrapper — so the fix is proven on the Ubuntu/WSL runtime,
  not just via pwsh (criterion 7).
- The criterion-1 fixture is a **frozen in-repo snapshot** of the PR #344 / head
  `0c7da45` state (a fresh current-head `ready_for_review` plus older SHA-less
  reports), captured once and committed; PR #344 is cited as provenance only. It
  fails under the current binding, passes under the fix. The snapshot MUST
  preserve the **exact raw AO 0.9.x observable** the fix uses for monotonic
  ordering, and criterion 1 MUST pass using only that raw observable — not a
  test-injected ordering field. **If the captured state exposes no durable
  ordering observable, that is a blocking discovery to escalate before
  implementation** (the fix would otherwise pass synthetic tests yet fail closed
  in production); do not synthesize the signal.
- The criterion-4 fixture differs from the criterion-1 fixture only by the
  absence of a genuine current-head hand-off under the monotonic emission order
  (identical commit-vs-report timestamp relation), proving the verdict does not
  rest on the timestamp comparison.
- Dry-run proof: the reconcile wrapper is run against the **same committed frozen
  fixture** as the criterion-1 regression test via a **deterministic fixture
  injection** (an explicit fixture path/selector or a test harness that binds that
  snapshot) — never live repo/GitHub/AO state — and reports the head as ready,
  planning one review run (not `ready_for_review_debounce_pending` /
  `uncovered_not_ready`). The planner picks the injection mechanism; the contract
  is that the dry-run consumes the committed fixture deterministically.
- The shared-classifier coverage of criterion 7 is proven **behaviorally** per
  the wrapper proof above; any static/grep scan is supplemental, not the proof.
- `pwsh -NoProfile -File scripts/orchestrator-diagnose.ps1 -Strict` (or the
  staged-only CI equivalent) passes on the change.
- `pwsh -NoProfile -File scripts/verify.ps1` and
  `pwsh -NoProfile -File scripts/check-reusable.ps1` pass on the PR head
  (PowerShell 7+ on Linux/WSL2).
