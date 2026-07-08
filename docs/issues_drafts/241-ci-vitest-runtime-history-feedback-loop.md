# [T3] CI Vitest runtime-history feedback loop

GitHub Issue: #691

## Prerequisite

- `docs/issues_drafts/181-ci-runtime-weighted-vitest-lanes.md` (GitHub #556,
  merged) — built the runtime-weight **consumer**: greedy-LPT heavy-shard
  assignment reads per-file weights from `scripts/vitest-runtime-history.json`,
  with a documented conservative fallback for classified heavy files that have no
  timing history. It also enumerated the "Timing input class"
  (available / missing / stale / corrupt) but scoped the history **producer**
  out. This issue adds that producer; it reuses #556's consumer, classification,
  fallback, and coverage-equivalence guards unchanged.
- `docs/issues_drafts/156-verify-script-test-runtime-refactor.md` (GitHub #488,
  merged) — moved full Vitest ownership + slow-test budget to the test lane.
  This issue does not move regression back into `verify.ps1`.

## Goal

Ground heavy-shard assignment weights in recently-measured CI runtimes instead of
the frozen `ci-baseline-estimates` placeholders the history still ships. Each
Vitest lane run already emits a machine-readable per-file duration report; this
issue closes the loop so those measured durations refresh
`scripts/vitest-runtime-history.json` on a defined, low-noise cadence, and the
committed history reflects observed CI runtime rather than hand-seeded guesses.
Missing and corrupt timing inputs continue to degrade to #556's conservative
fallback; the artifact also records a refresh timestamp so data age is an
observable freshness signal. The refresh is a race-safe single-writer path and
only merges reports from a complete, successful, commit-matched lane set, so a
partial or mismatched run cannot poison the baseline. Outcome, not method: after
this ships, the runtime-weighted LPT balance is computed from real, provenance-
checked evidence, and the fraction of classified heavy files still on seeded or
fallback weights is visible rather than silently green.

```behavior-kind
action-producing
```

```complexity-tier
tier: T3
advisory-prior: T2
```

## Binding surface

- CI has a defined **runtime-history refresh path**: measured per-file Vitest
  durations from the lane runners' JSON reports are merged into
  `scripts/vitest-runtime-history.json` on a single defined cadence (the
  implementation picks the cadence; it must not run once per ordinary PR in a way
  that races concurrent PRs to mutate the committed history).
- The refresh is **noise-resistant**: a single anomalous slow run may not
  permanently dominate a file's recorded weight. The merge applies a documented
  smoothing/aggregation rule (the implementation picks the rule) rather than
  blind last-run-wins.
- The refresh is **fail-safe on bad input**: a missing report, an unparseable /
  truncated report, or a report with zero measured files leaves the existing
  history unchanged and does not corrupt it. Files absent from a given report
  retain their prior recorded value; they are not dropped to the fallback merely
  because one report did not cover them.
- The refresh is a **race-safe single-writer** update to the committed history:
  concurrent triggers (overlapping schedules, pushes, reruns, manual dispatch)
  serialize or detect a stale base and re-resolve; the path is idempotent
  (a no-op when nothing changed) and never commits an older history over a newer
  one. No measurement is silently lost to a lost-update race. **The idempotent
  no-op covers the refresh-timestamp:** identical validated measurements do not
  rewrite the committed history solely to advance freshness, so a main/scheduled
  commit-back cannot churn history-only commits or recursively re-trigger CI.
- The refresh only merges reports carrying valid **provenance**. The report
  universe is the **heavy-shard** report set (LPT weights only classified heavy
  files; light-lane files run bounded-parallel and are not runtime-weighted, so
  the refresh neither requires nor records light-lane timings — a missing
  light-lane report is not a partial-set failure). Valid provenance = **all heavy shards
  ran successfully at a matching commit/ref** (shard-*set* completeness — not that
  every classified file emitted a timing; per-file timing gaps inside an
  otherwise-complete run are accepted and governed by AC#3's retain rule).
  Rejected rather than merged: a heavy-shard report missing from the set, a failed
  shard/run, a rerun of an old workflow, a commit/ref mismatch, or a report naming
  an **unclassified/unknown** path (consistent with #556 classification — not a
  light-lane path per se). (Because the refresh runs only on the authorized
  triggers below, fork PRs cannot reach it; this gate closes the same-repo
  partial/stale/mismatch vectors.)
- The artifact persists a **durable per-entry provenance** signal — for each
  classified heavy file, whether its current recorded weight is `measured`,
  `seeded`, or `fallback` — so measured-vs-seeded status survives across refreshes
  (a value measured three refreshes ago is still distinguishable from a
  never-measured seed, which a numeric-only map cannot do). This provenance sits
  beside, and does not alter, the `files: {path: ms}` numeric map the #556
  consumer reads (e.g. a parallel provenance map / per-entry metadata — the
  implementation picks the shape, but the numeric read must keep working).
- After a refresh, the coverage signal — computed from that durable per-entry
  provenance (not by guessing from bare numbers) — reports the share of classified
  heavy files now on `measured` weight vs. `seeded`/`fallback`; a material
  shortfall is visible in CI output, not silently green.
- The `"source"` marker of the history file distinguishes measured data from the
  seeded baseline, and a **data-change timestamp** records when a file's recorded
  weight last actually changed (explicitly the age of the underlying measurement,
  not the time of the last no-op validation). Freshness therefore means how old
  the measurements are — the signal that matters for stale weights — and is
  consistent with the idempotent no-op (a pure revalidation does not advance it).
  (This issue records the freshness signal; making the #556 consumer actively
  re-measure or reject stale entries on it is out of scope — see Files out of
  scope.)
- #556's consumer contract is unchanged: classification, the conservative
  missing-history fallback, coverage equivalence (shard union == serial
  discovery, no duplicate/unclassified file), and the `onTaskUpdate` /
  `vitest-worker` RPC flake guard all remain load-bearing and are not weakened.
- The history file stays committed, human-diffable JSON in its current shape
  (`{ files: { <path>: <ms> } }`); no new repo secrets.

```contract-evidence
binding-id: orchestrator-pack:ci-vitest-runtime-history:measured-refresh
binding-type: ci-test-scheduling-policy
binding: measured per-file Vitest durations from the lane JSON reports are merged into the committed runtime-history on a defined cadence and used by the #556 weight consumer
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:ci-vitest-runtime-history:noise-resistant-merge
binding-type: ci-test-scheduling-policy
binding: the refresh applies a documented smoothing/aggregation so one anomalous run cannot permanently dominate a file weight
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)

binding-id: orchestrator-pack:ci-vitest-runtime-history:corrupt-input-fail-safe
binding-type: ci-test-scheduling-policy
binding: a missing, unparseable, or empty report leaves the committed history unchanged rather than corrupting or emptying it
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)

binding-id: orchestrator-pack:ci-vitest-runtime-history:race-safe-single-writer
binding-type: ci-test-scheduling-policy
binding: the committed-history refresh serializes concurrent triggers, detects a stale base, is idempotent, and never commits an older history over a newer one
producer: orchestrator-pack
evidence: NEW(produced-by AC#5)

binding-id: orchestrator-pack:ci-vitest-runtime-history:provenance-gate
binding-type: ci-test-scheduling-policy
binding: only a complete, successful, commit-matched lane-set report covering the current classified heavy set is merged; partial/rerun/mismatched/out-of-set reports are rejected
producer: orchestrator-pack
evidence: NEW(produced-by AC#6)

binding-id: orchestrator-pack:ci-vitest-runtime-history:measured-coverage-signal
binding-type: ci-test-scheduling-policy
binding: after refresh, the share of classified heavy files on measured vs seeded/fallback weight is emitted observably and a material shortfall is visible
producer: orchestrator-pack
evidence: NEW(produced-by AC#7)

binding-id: orchestrator-pack:ci-vitest-runtime-history:refresh-cadence-observable
binding-type: ci-test-scheduling-policy
binding: the refresh workflow triggers only on authorized main-context events (main push/schedule/manual-dispatch), never PR, with a concurrency guard, provable from the workflow, so fixtures cannot substitute for wired cadence
producer: orchestrator-pack
evidence: NEW(produced-by AC#8)

binding-id: orchestrator-pack:ci-vitest-runtime-history:durable-per-entry-provenance
binding-type: ci-test-scheduling-policy
binding: the artifact persists per-entry measured/seeded/fallback provenance beside the numeric files map (numeric #556 read preserved) so measured-vs-seeded survives across refreshes
producer: orchestrator-pack
evidence: NEW(produced-by AC#7)

binding-id: orchestrator-pack:ci-vitest-runtime-history:refresh-artifact-handoff
binding-type: ci-test-scheduling-policy
binding: the wired refresh job depends on the heavy-shard jobs and consumes their JSON artifacts from the same successful matching commit, not a report-less no-op workflow
producer: orchestrator-pack
evidence: NEW(produced-by AC#9)
```

## Files in scope

- `scripts/**` — the runtime-history refresh helper and its guard/test.
- `scripts/vitest-runtime-history.json` — updated `"source"` and data.
- `.github/workflows/**` — the trigger that runs the refresh on the chosen
  cadence.
- `docs/**` — the runtime-history / CI pipeline documentation.

## Files out of scope

- The greedy-LPT assignment algorithm, classification map, and coverage guards
  from #556 (`scripts/lib/vitest-ci-lanes.mjs`,
  `scripts/vitest-ci-lanes.config.json`) — consumed, not changed.
- Moving any PR-required test between lanes or to a main/schedule-only slow lane
  (separate issue; #487 scope boundary).
- Splitting heavy test files or changing test timing semantics.
- Raising `heavyShardCount` (a config knob; see Verification note).
- Modifying the #556 consumer to actively re-measure, expire, or reject stale
  entries based on the refresh-timestamp. This issue only *records* the freshness
  signal as an observable; making the consumer act on it (staleness-driven
  re-measurement) is a separate follow-up capability. Shard imbalance itself is
  fully corrected here by grounding weights in measured data — freshness
  enforcement is an additive later refinement, not a gap this issue leaves in its
  own contract.
- `vendor/**`, `packages/core/**`.

## Denylist

```denylist
vendor/**
packages/core/**
```

Scope boundary note: this denylist is scoped to
`241-ci-vitest-runtime-history-feedback-loop`.

```allowed-roots
scripts/**
.github/workflows/**
docs/**
```

## Decisions (design analysis)

**Prior art.** #556 (draft 181) built the runtime-weight consumer (greedy-LPT
over `vitest-runtime-history.json`) and named the "Timing input class"
(available / missing / stale / corrupt) but scoped the history producer out — the
file still ships `"source": "ci-baseline-estimates"`, ~all flat 45000. The lane
runners already emit per-file JSON reports
(`enforce-vitest-runtime-budget.mjs::resolveFileDurationMs` proves the
`startTime`/`endTime` per-`testResults[]` shape is already consumed) but nothing
merges them back. This issue adds the missing producer; it does not rebuild the
consumer, classification, or fallback.

**Critical mechanics.** (1) Report parsing must reuse the exact Vitest
`--reporter=json` per-file duration shape the budget enforcer already reads, so
the producer and the existing consumer never disagree. (2) The merge is a
write to a **committed** artifact, so cadence and concurrency matter: an
uncontrolled per-PR commit-back races two PRs mutating the same file. (3)
Bad-input handling must be non-destructive — a partial/empty report must not
erase weights for files it simply did not cover, or the next assignment
regresses to fallback for real files.

**Industry practice.** Runtime-weighted test balancing (CircleCI test-splitting,
Jest/Vitest shard timing, Bazel timing history) records a rolling per-target
timing profile and rebalances from it; the recognized pitfall is letting one
noisy run poison the profile — solved with smoothing / rolling aggregation and a
main-branch (not per-PR) refresh so history is a stable shared baseline.

**Options considered (cost / risk / sufficiency).**
1. **Per-PR commit-back** — every PR run rewrites history. Cheapest to trigger
   but races concurrent PRs on the committed file, churns diffs, and lets a flaky
   PR run poison the baseline. Rejected: concurrency + noise risk.
2. **Scheduled / main-only refresh job with smoothing** — the lane runs upload
   duration reports; a single main-branch (push/scheduled) job merges them with a
   documented smoothing rule and commits. Calmer, no PR-race, stable baseline.
   **Chosen** — cheapest sufficient executor: it adds one trigger + one merge
   helper, reuses the existing report shape and consumer, and the smoothing rule
   plus non-destructive merge directly answer the two real failure modes
   (poisoning, partial reports).
3. **Reference/extend only — do nothing new** — keep hand-seeding estimates.
   Rejected: the survey proved the producer surface is genuinely empty and the
   frozen estimates are the observed root cause of shard imbalance; #556 left this
   as the open follow-up.

**Full-class enumeration (timing-input × merge-outcome).**
- input *available, stable* → recorded weight ≈ measured (smoothed).
- input *available, one spike among normal* → smoothing suppresses the spike
  (AC#2).
- input *missing report* → history unchanged; consumer uses #556 fallback (AC#3).
- input *unparseable / truncated* → history unchanged, not corrupted (AC#3).
- input *empty (zero files)* → history unchanged; covered files retain prior
  value (AC#3).
- input *incomplete shard SET* (a heavy shard's report missing / the run failed /
  commit mismatch) → whole report **rejected**, history untouched (AC#6 — a
  run-level provenance failure, distinct from per-file coverage).
- input *valid complete set, but some files have no timing in it* → covered files
  merge, those uncovered files **retain prior recorded value**, not dropped to
  fallback (AC#3 — per-file non-destructive within an accepted merge).
Each row maps to an acceptance fixture so the build targets the class, not one
reproduced case. The two axes are independent: **run/shard-set completeness**
(AC#6, reject) vs **per-file coverage within a valid set** (AC#3, retain).

## Acceptance criteria

1. A refresh path merges measured per-file durations from the Vitest lane JSON
   reports into `scripts/vitest-runtime-history.json`, and the committed history's
   `"source"` marker reflects that it now carries measured data. A guard/test
   proves that, given representative lane reports, the merged history assigns each
   measured heavy file a **measured-derived** weight (per the AC#2 smoothing rule,
   which may intentionally differ from the latest raw duration) — moved off the
   seeded 45000 placeholder, not necessarily equal to the raw latest run.

```producer-emission
producer: orchestrator-pack
datum: ci-vitest-runtime-history
expected: measured-refresh
proof-command: pwsh -NoProfile -File scripts/check-ci-pipeline-split.ps1
```

2. Given a file whose report durations vary run-to-run (one anomalous spike among
   normal runs), the merged weight reflects the documented smoothing rule and is
   not pinned to the single spike. A fixture proves the spike does not become the
   recorded weight.

```producer-emission
producer: orchestrator-pack
datum: ci-vitest-runtime-history
expected: noise-resistant-merge
proof-command: pwsh -NoProfile -File scripts/check-ci-pipeline-split.ps1
```

3. Given a missing, unparseable/truncated, or zero-file report, the refresh
   leaves the prior committed history byte-unchanged (no corruption, no mass
   drop-to-fallback for files the bad report simply did not cover). A fixture per
   bad-input class proves this.

```producer-emission
producer: orchestrator-pack
datum: ci-vitest-runtime-history
expected: corrupt-input-fail-safe
proof-command: pwsh -NoProfile -File scripts/check-ci-pipeline-split.ps1
```

4. #556's coverage-equivalence and classification guards still pass after the
   refresh lands: `scripts/check-ci-pipeline-split.ps1` reports shard union ==
   serial discovery, no duplicate/unclassified file, and the conservative
   missing-history fallback is still used for classified heavy files without
   timing data.

5. The refresh is a race-safe single-writer update: given two concurrent
   refresh attempts (or a refresh against a base that moved), the merged history
   is serialized/stale-base-detected, idempotent, and never regresses to an older
   snapshot; no measurement is lost to a lost-update race. A fixture proves the
   concurrent/stale-base case does not lose or overwrite-backwards.

```producer-emission
producer: orchestrator-pack
datum: ci-vitest-runtime-history
expected: race-safe-single-writer
proof-command: pwsh -NoProfile -File scripts/check-ci-pipeline-split.ps1
```

6. The refresh rejects a report whose **run/shard-set** provenance is invalid — a
   heavy shard's report missing, the run failed, or a commit/ref mismatch — and
   merges only a complete, successful, commit-matched heavy-shard set; it also
   rejects a report naming an unclassified/unknown path. (This is the run-level
   axis; per-file coverage *within* an accepted set is governed by AC#3, which
   retains prior values for files a valid set did not time.) A missing light-lane
   report is not a partial-set failure (the refresh records heavy-file weights
   only). Fixtures per rejection class prove the poisoned report does not reach the
   committed baseline, and that idempotent refresh does not create a
   freshness-only commit.

```producer-emission
producer: orchestrator-pack
datum: ci-vitest-runtime-history
expected: provenance-gate
proof-command: pwsh -NoProfile -File scripts/check-ci-pipeline-split.ps1
```

7. The artifact persists durable per-entry provenance (`measured`/`seeded`/
   `fallback`) beside the numeric `files` map without breaking the #556 numeric
   read, and the refresh emits the share of classified heavy files on `measured`
   vs `seeded`/`fallback` weight computed from that provenance; a material
   shortfall is surfaced (diagnostic/visible), not silently passed. Fixtures prove
   (a) a value measured in an earlier refresh stays `measured` across a later
   valid partial run, distinct from a never-measured seed, and (b) a run leaving
   most heavy files on seeded weight is visible in the emitted signal.

```producer-emission
producer: orchestrator-pack
datum: ci-vitest-runtime-history
expected: measured-coverage-signal
proof-command: pwsh -NoProfile -File scripts/check-ci-pipeline-split.ps1
```

```producer-emission
producer: orchestrator-pack
datum: ci-vitest-runtime-history
expected: durable-per-entry-provenance
proof-command: pwsh -NoProfile -File scripts/check-ci-pipeline-split.ps1
```

8. The refresh **wiring itself** is observable and correct: a guard proves the
   refresh workflow triggers only on the authorized set — main push, schedule,
   and operator `workflow_dispatch` (all main-context) — and **never on ordinary
   PR events**, and carries a concurrency guard. So passing the merge-helper
   fixtures cannot be mistaken for a wired refresh path, and the refresh cannot
   accidentally run on PRs. (Manual dispatch is authorized, which is why AC#5
   treats it as a concurrent trigger to serialize, not an illegal one.)

```producer-emission
producer: orchestrator-pack
datum: ci-vitest-runtime-history
expected: refresh-cadence-observable
proof-command: pwsh -NoProfile -File scripts/check-ci-pipeline-split.ps1
```

9. The wired refresh path observably **consumes the current heavy-shard report
   set** — it depends on the heavy-shard Vitest jobs and ingests their JSON
   artifacts from the same successful matching commit, so it cannot be a workflow
   that invokes the helper with no reports and no-ops forever while still passing
   the AC#8 wiring guard and the local fixtures. A guard proves the refresh job's
   dependency on, and artifact consumption from, the current heavy-shard jobs.

```producer-emission
producer: orchestrator-pack
datum: ci-vitest-runtime-history
expected: refresh-artifact-handoff
proof-command: pwsh -NoProfile -File scripts/check-ci-pipeline-split.ps1
```

```positive-outcome
asserts: given representative Vitest lane JSON reports, the refresh writes each measured heavy file a measured-derived weight (per the smoothing rule), moving it off the seeded 45000 placeholder, and the #556 LPT consumer then reads that grounded weight
input: external-tool-output
provenance: sample-backed
```

## Upgrade-safety check

- No AO core, `vendor/**`, or `packages/core/**` edits.
- No unsupported YAML; the refresh trigger uses standard GitHub Actions.
- No new repo secrets; the history file remains committed plaintext JSON.
- The refresh cannot mutate history in a way that breaks the #556 consumer's
  expected `{ files: { <path>: <ms> } }` shape.

## Verification

1. AC#1 — run the refresh helper against representative lane JSON reports (Vitest
   `--reporter=json` output, the same shape `enforce-vitest-runtime-budget.mjs`
   already consumes via `startTime`/`endTime` per `testResults[]`), assert the
   merged `vitest-runtime-history.json` carries measured weights and an updated
   `"source"`.
2. AC#2 — fixture: a file with runs `[normal, normal, spike]`; assert recorded
   weight follows the smoothing rule, not the spike.
3. AC#3 — three fixtures (missing report, truncated/garbage JSON, zero-file
   report); assert the committed history is unchanged in each.
4. AC#4 — `pwsh -NoProfile -File scripts/check-ci-pipeline-split.ps1` passes
   (coverage equivalence, classification, fallback) after the refresh.
5. AC#5 — fixture: two concurrent refresh attempts and a moved-base attempt;
   assert serialized/stale-base-detected merge, idempotent no-op, no backward
   regression, no lost measurement.
6. AC#6 — fixtures per provenance-rejection class (partial lane set, failed lane
   set, commit/ref mismatch, out-of-classified-set path); assert none reach the
   committed baseline, and a complete/successful/matched report does merge.
7. AC#7 — fixture: a refresh leaving most heavy files on seeded weight; assert
   the emitted measured-coverage signal surfaces the shortfall.
8. AC#8 — guard/test asserts the refresh workflow triggers only on authorized
   main-context events (main push/schedule/manual-dispatch), never PR, and
   declares a concurrency guard, read from the workflow file.
9. AC#7 durable provenance — fixture: a file measured in refresh N stays
   `measured` after a later valid partial run that omits it, distinct from a
   never-measured seed; assert the numeric `files` read is unbroken.
10. AC#9 — guard asserts the refresh job depends on the heavy-shard jobs and
    ingests their artifacts from the matching commit (not a report-less no-op).
11. **shardCount follow-up note (folds measure #4):** once measured weights
   populate the history, the operator may revisit `heavyShardCount` (currently 7)
   — but only data-driven, by inspecting per-shard measured weights, and NOT as a
   standalone build. Draft 181 Options-considered #1 already rejected "add more
   round-robin shards" as non-durable; bumping the count on fictional weights is
   theatre. This note is the entire disposition of measure #4 — there is no
   separate shard-count draft.
