# [T3] Move wall-clock supervisor/wake e2e tests to a separate CI stage

GitHub Issue: #694

## Prerequisite

- **Charter (mandatory):** `docs/issues_drafts/155-ci-pipeline-split-parallel-test-stage.md`
  (GitHub #487) AC#8 — *"No existing PR-required test may be moved into a
  main/schedule-only slow lane by this issue. Any such move requires a separate
  issue, coverage-delta proof, and explicit review approval."* This draft **is**
  that separate issue; it must ship the coverage-delta proof and obtain explicit
  review approval before merge.
- `docs/issues_drafts/154-ci-cheap-wins.md` (GitHub #486) — PR-scoped concurrency
  contract reused by #487; this draft must not define a second cancellation policy.
- Shipped CI pipeline split (#487, #536, #556): runtime-weighted Vitest lanes,
  fail-closed **Run pack contract tests** aggregate, lane classification in
  `scripts/vitest-ci-lanes.config.json`, guard in
  `scripts/check-ci-pipeline-split.ps1`. Documented in `docs/ci-pipeline-split.md`.
- **Red-signal family to mirror for post-merge failures:** CI-failure ping /
  suppressor chain `docs/issues_drafts/90-ci-failure-notify-cross-path-dedup.md`
  (#283), `docs/issues_drafts/110-ci-failure-ping-suppress-on-live-worker-state.md`
  (#342), `docs/issues_drafts/116-ci-failure-suppressor-bind-fixing_ci-to-head-scoped-report.md`
  (#363) — episode-keyed, fail-closed delivery semantics. Also
  `docs/issues_drafts/66-orchestrator-ci-green-wake-worker.md` (#191) for
  required-CI transition visibility on PR heads.
- Prior-art reconnaissance (**2026-07-08**): no queued draft or open issue
  relocates PR-required Vitest files into a main/schedule-only acceptance stage.
  #487/#556 explicitly fence that move behind a separate issue (this draft). CI
  heavy-lane speedup briefs #1–#4 (parallel shards, light lane, runtime weighting,
  budget alignment) optimize the PR path but do not remove the wall-clock
  subprocess floor. This is a **single-PR** unit: stage split + coverage-delta
  proof + guard extension.

## Goal

Relocate the identified wall-clock supervisor/wake subprocess e2e Vitest suites out
of the PR-blocking commit lane into a dedicated later CI stage (post-merge on `main`
and/or scheduled) so ordinary PRs reach fast feedback under the commit-stage
ceiling, **without silently dropping regression coverage**. Every relocated file
still runs on a defined trigger with fail-closed aggregation; a red result in the
later stage reaches a human owner through the same class of red-signal machinery as
PR CI failures.

```behavior-kind
action-producing
```

```complexity-tier
tier: T3
advisory-prior: T3
recomputed-markers: ci-review-gating, crash-recovery, test-harness-correctness, concurrency-state-retry
```

## Binding surface

- **Coverage-delta (charter AC#8):** PR-required **Run pack contract tests**
  no longer executes the relocated wall-clock files; a separate stage executes
  exactly that set on `push` to `main` and on a defined schedule; machine-checked
  proof shows no missing or duplicate coverage across PR vs post-merge lanes.
- **Commit-stage budget:** ordinary non-markdown PRs keep the existing fail-closed
  PR aggregate but with materially lower Vitest heavy-lane makespan after the move
  (stretch: commit-stage ideal ~90s; hard ceiling ~10min per KB `Commit stage`).
- **Fail-closed semantics preserved:** the new stage reuses the same aggregate
  discipline as #487/#556 — red, missing, timed-out, cancelled, or unexpectedly
  skipped upstream lanes prevent a green aggregate; no `continue-on-error` masking.
- **Classification guards unchanged:** #556 lane union / classification-required /
  worker-RPC flake scan (`onTaskUpdate`, `vitest-worker`) remain authoritative for
  the PR lane; the post-merge lane cannot introduce unclassified files or bypass
  RPC flake detection on any parallel path it uses.
- **Red-signal ownership:** a failure on the post-merge stage produces an
  operator-visible alert on the failing `main` head — not a silent advisory badge.
  The alert path reuses or extends the CI-failure notification / suppressor
  machinery (#283/#342/#363) where the failure is PR-adjacent, and otherwise uses
  an equivalent fail-closed main-branch notification contract documented in the
  coverage-delta proof with named owner, delivery target, episode/dedup key,
  retry/idempotency rule, and explicit behavior when alert delivery itself fails.
- **Main-head containment:** while the post-merge wall-clock stage is pending or
  red on a `main` head, dependent automation must not treat that head as fully
  green for supervisor/wake-sensitive promotion paths. Containment is exposed as a
  machine-readable status/check (GitHub check run, workflow output, or equivalent
  artifact named in the proof) that downstream wake/release gates must consult —
  not documentation-only policy.
- **Rollback:** documented, reversible migration with **ordered** steps — PR lane
  re-includes moved files and proves green **before** the post-merge stage is
  disabled; disabling post-merge alone must not be a valid rollback path.

```contract-evidence
binding-id: orchestrator-pack:vitest-wallclock-e2e-split:pr-lane-excludes-moved-files
binding-type: ci-shard-aggregation-policy
binding: PR-required Run pack contract tests Vitest lanes exclude every relocated wall-clock file with no coverage gap versus pre-move PR-required union
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)

binding-id: orchestrator-pack:vitest-wallclock-e2e-split:post-merge-stage-runs-moved-files
binding-type: github-actions-required-test-policy
binding: a dedicated post-merge CI stage runs the full relocated wall-clock file set on every main push and on schedule with fail-closed aggregation
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)

binding-id: orchestrator-pack:vitest-wallclock-e2e-split:post-merge-red-human-visible
binding-type: cli-behavior
binding: a red post-merge wall-clock stage result reaches an operator-visible alert path so main-head regressions are not silent
producer: orchestrator-pack
evidence: NEW(produced-by AC#5)

binding-id: orchestrator-pack:vitest-wallclock-e2e-split:rollback-reversible
binding-type: ci-shard-aggregation-policy
binding: rollback restores PR-required execution of relocated files without test rewrites and is documented in repo CI docs
producer: orchestrator-pack
evidence: NEW(produced-by AC#8)
```

## Files in scope

- `.github/workflows/**` — PR lane trim + new post-merge/schedule stage wiring
- `scripts/vitest-ci-lanes.config.json` — lane assignment for moved vs PR-retained files
- `scripts/vitest-runtime-history.json` — update only if shard/history semantics change
- `scripts/ci-pipeline-split.config.json` — post-merge stage job names / triggers
- `scripts/check-ci-pipeline-split.ps1` and focused guard fixtures/tests under `scripts/**`
- `docs/ci-pipeline-split.md` and coverage-delta proof section (this issue)
- CI-failure notification / main-branch alert wiring under `scripts/**` only where
  needed to satisfy AC#5

## Files out of scope

- Weakening #556 classification-required or RPC flake guards
- Moving any file **not** in the enumerated wall-clock set below
- `plugins/**` (hard denylist — guard fixtures live under `scripts/**` only)
- `scripts/verify.ps1` broad refactor
- `vendor/**`, `packages/core/**`

```denylist
vendor/**
packages/core/**
plugins/**
```

Scope boundary note: denylist applies to this draft only; `plugins/**` is a hard
exclusion — no conditional worker exception.

```allowed-roots
.github/workflows/**
scripts/**
docs/**
tests/external-output-references/**
```

## Acceptance criteria

1. **Charter linkage and explicit review approval.** Issue body and PR cite #487
   AC#8 as charter. Merge requires recorded explicit review approval for relocating
   PR-required coverage (architect review gate). The coverage-delta guard fails
   closed unless an **immutable** approval reference from an authorized reviewer
   exists in GitHub (issue comment or PR review record on this issue/PR) and names
   this enumerated move set — not a repo file the same PR can create or edit.

2. **Coverage-delta proof — PR lane exclusion.** The PR-required Vitest light/heavy
   lanes and **Run pack contract tests** aggregate no longer execute any relocated
   file. A machine-checked report lists: files removed from PR lanes, files retained
   PR-required, and proves the PR lane union is a strict subset of the pre-move
   PR-required union with only the enumerated removals. The guard proves set
   invariants against a **pinned pre-move baseline** (merge-base `main` SHA at
   charter approval time or a committed pre-move manifest artifact — not the
   mutable PR checkout alone): `moved` equals exactly the six enumerated files;
   `pr_retained ∩ moved = ∅`; `pr_retained ∪ moved` equals the pre-move
   PR-required union (no missing or duplicate file identity across lanes).

```producer-emission
producer: orchestrator-pack
datum: vitest-wallclock-e2e-split
expected: pr-lane-excludes-moved-files
proof-command: pwsh -NoProfile -File scripts/check-ci-pipeline-split.ps1
```

3. **Coverage-delta proof — post-merge stage execution.** A dedicated workflow stage
   (separate job or workflow triggered on `push` to `main` and on `schedule`) runs
   the relocated **test files** (six enumerated Vitest files) with fail-closed
   aggregation on that stage; declared runtime support files/config may execute but
   are listed in a checked allowlist separate from the moved test-file set. Schedule
   cadence is documented (minimum: daily). **Steady state:** the guard proves the
   **latest `main` head SHA** has a recorded completed post-merge wall-clock result
   (or fails/alerts when the newest head lacks one beyond a bounded age). **Bootstrap
   (first merge):** when the post-merge stage workflow is newly introduced, the guard
   accepts a documented first-merge exception until the first `main` push after merge
   completes one green post-merge run — then steady-state enforcement applies.

```producer-emission
producer: orchestrator-pack
datum: vitest-wallclock-e2e-split
expected: post-merge-stage-runs-moved-files
proof-command: pwsh -NoProfile -File scripts/check-ci-pipeline-split.ps1
```

4. **Enumerated move set with per-file justification.** Only these six files move;
   each justification cites subprocess spawn + real wall-clock polling/sleep (not
   merely a `heavy` label):

   | File | Justification |
   | --- | --- |
   | `scripts/supervisor-fault-boundary.test.ts` | Spawns real `orchestrator-wake-supervisor.ps1` children; polls markers/logs up to 25s per case; `vitest-runtime-history.json` ~200s GHA/file. |
   | `scripts/orchestrator-wake-supervisor.test.ts` | Full supervisor lifecycle e2e; `setTimeout` polls up to **8000ms** and 6000ms; spawns supervisor + listener processes; ~180s GHA/file. |
   | `scripts/orchestrator-wake-listener.test.ts` | Wake-filter integration cluster co-deployed with supervisor; subprocess `node` CLI evaluate path; measured ~120s GHA/file despite short unit cases — retained only as part of this wall-clock cluster per brief verification. |
   | `scripts/orchestrator-wake-supervisor-orphan-integration.test.ts` | Orphan integration spawns supervisor + sleeps **2500ms** polling loops; ~120s GHA/file. |
   | `scripts/supervisor-auto-recovery.test.ts` | Recovery e2e spawns supervisor; polls with 1000ms sleeps and **8000ms** error window; ~120s GHA/file. |
   | `scripts/supervisor-degraded-backoff.test.ts` | Degraded/backoff e2e spawns supervisor; multiple 500–1500ms sleeps; ~120s GHA/file. |

   **Explicitly not moved:** files that are heavy only by subprocess/git integration
   without multi-second wall-clock polling (for example
   `scripts/orchestrator-wake-supervisor-orphan-identity.test.ts` at ~45s with
   static identity assertions) and all light-lane/unit-heavy files. This issue
   must not make substantive assertion-weakening edits to the six relocated test
   files — lane/workflow moves only.

5. **Red-signal / human visibility on post-merge failure.** When the post-merge
   wall-clock stage fails on `main`, an operator-visible alert fires within the
   same notification class as PR CI failures (#283/#342/#363 semantics: deduped,
   fail-closed, not silently swallowed). The coverage-delta proof documents the
   trigger, named owner, delivery target, episode/dedup key, retry/idempotency
   rule, triage steps without opening Actions blindly, and fail-closed behavior
   when alert delivery itself fails (no silent green on delivery miss).

```producer-emission
producer: orchestrator-pack
datum: vitest-wallclock-e2e-split
expected: post-merge-red-human-visible
proof-command: pwsh -NoProfile -File scripts/check-ci-pipeline-split.ps1
```

6. **Merge-window safety and main-head containment.** Documentation states how a
   regression cannot hide in the gap between PR merge and post-merge stage
   completion: every `main` push runs the post-merge stage; schedule backstops;
   the failing head SHA is recorded in the alert payload; PR merge does not mark
   the wall-clock suite "passed" without that stage having run green on the merged
   commit (PR aggregate excludes those tests). While the post-merge wall-clock
   stage is **pending or red** on a `main` head, a machine-readable containment
   status/check blocks supervisor/wake-sensitive downstream automation (worker wake,
   release promotion, or equivalent hooks named in the proof) from treating that
   head as fully green until the stage completes green or an operator documents an
   explicit override.

7. **#556 / RPC guards preserved.** `scripts/check-ci-pipeline-split.ps1` still
   enforces classification-required, lane union equivalence for PR lanes, and
   worker-RPC flake log scan on PR paths. The post-merge stage does not disable
   serial in-runner execution where needed to avoid `onTaskUpdate` recurrence.

8. **Rollback and migration note.** `docs/ci-pipeline-split.md` (or equivalent)
   documents forward migration steps, rollback with **ordered** steps (re-add moved
   files to PR lanes and verify green **before** disabling the post-merge workflow;
   disabling post-merge alone is an invalid rollback that drops coverage), and
   baseline before/after PR **Run pack contract tests** wall times with moved-file
   counts. A guard or negative fixture proves rollback-order violation is detected.

```producer-emission
producer: orchestrator-pack
datum: vitest-wallclock-e2e-split
expected: rollback-reversible
proof-command: pwsh -NoProfile -File scripts/check-ci-pipeline-split.ps1
```

9. **Baseline evidence.** PR records before/after wall time for **Run pack contract
   tests** using named GHA fields (job `duration` from the workflow run API or
   equivalent stable field, queue/wait as `run_started_at` minus trigger time or
   documented substitute), shard/lane counts from the coverage-delta report, and
   confirmation that PR lane RPC flake scan stays clean. Post-merge stage runner
   OS/shell assumptions (e.g. Ubuntu + pwsh/node for supervisor subprocess tests)
   are pinned in workflow config and verified by the guard.

```positive-outcome
asserts: an ordinary non-markdown PR reaches Run pack contract tests green without executing the six relocated wall-clock supervisor/wake files, while a main push runs those six files in the post-merge stage and a deliberate failure there surfaces an operator-visible red-signal alert
input: realistic
```

## Upgrade-safety check

- PR required-check name **Run pack contract tests** remains stable; only its covered
  file set shrinks per the coverage-delta proof.
- Post-merge stage is additive; rollback follows AC#8 ordered steps (re-add to PR
  lanes and prove green before disabling post-merge) — not disable-alone.
- No edits to `vendor/**` or `packages/core/**`.

## Verification

- `pwsh -NoProfile -File scripts/check-ci-pipeline-split.ps1` — extended for
  wall-clock stage split, coverage-delta, and rollback docs.
- Representative GHA run: non-markdown PR with green PR aggregate excluding moved
  files; `main` push running post-merge stage on merged SHA.
- Negative fixture: post-merge stage red → executable alert dry-run proves delivery
  (not wiring inspection alone).
- Negative fixture: alert-delivery failure does not silently swallow the red stage.
- Negative fixture: latest `main` head lacks post-merge wall-clock result despite schedule.
- Negative fixture: containment status absent while post-merge pending/red.
- Negative fixture: PR lane cannot skip classification for moved files (still listed
  in manifest under post-merge classification, not PR lanes).
- Negative fixture: rollback-order violation (disable post-merge before PR re-inclusion).
- Negative fixture: coverage-delta guard fails without immutable GitHub approval reference.
- Negative fixture: same-PR self-created approval artifact is rejected.
- Existing checks remain green:

```powershell
pwsh -NoProfile -File scripts/verify.ps1
pwsh -NoProfile -File scripts/check-reusable.ps1
```

## Decisions

### Design analysis

**Critical mechanics:** PR lane file assignment via `vitest-ci-lanes.config.json` and
heavy-shard planner; aggregate binding via `ci-test-aggregate.ps1`; post-merge
workflow trigger; notification path for non-PR failures; coverage-delta machine proof.

**Industry grounding:** KB `Commit stage` (~90s ideal, ~10min ceiling) — acceptance
tests belong in later parallel stages / build grid, not the first feedback gate.

**Architecture sketch:**

```text
PR update (non-markdown)
  |
  +--> existing fast lanes (typecheck, vitest light, vitest heavy w/o wall-clock files, pester)
  |
  +--> Run pack contract tests (PR aggregate; smaller Vitest union)

push main / schedule
  |
  +--> wall-clock acceptance stage (six relocated files only)
  |
  +--> fail-closed aggregate + operator red-signal on failure
```

**Options considered:**

| Option | Cost | Risk | Sufficiency | Decision |
| --- | ---: | ---: | ---: | --- |
| (a) Relocate entire enumerated suites to main/schedule only | Medium | Medium: coverage-delta + alert path required | Sufficient when AC#2–#6 satisfied | **Chosen** |
| (b) Keep all files PR-required; rely on prior heavy-lane speedups only | Low | High: wall-clock floor remains | Insufficient for commit-stage ceiling | Rejected |
| (c) Tiered — PR smoke subset + full suite post-merge | High | Medium: two test definitions to drift | Sufficient but more moving parts | Rejected (no brief-verified smoke subset; adds drift surface) |

**Full-class enumeration:**

- Trigger class: PR, push `main`, schedule, markdown-only skip (unchanged).
- Lane class: PR Vitest light/heavy (trimmed), post-merge wall-clock lane, pester, aggregate.
- Failure class: test red, infra miss, timeout, cancel, RPC flake recurrence.
- Visibility class: PR required check, post-merge alert, suppressor dedup (#283 family),
  main-head containment while post-merge pending/red.

### Task decomposition

Kept as **one draft / one PR**. Splitting PR-lane trim from post-merge stage wiring
would allow a coverage gap between merges; the smallest safe unit is the full
coverage-delta move plus guard proof.

### Explicit review approval (#487 AC#8)

Recorded approval must be machine-checkable via the coverage-delta guard (AC#1).
Architect + adversarial review must approve relocating PR-required tests before
merge; the guard reference does not substitute for human judgment but prevents
silent merge without a recorded approval artifact.
