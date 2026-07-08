# [T2] Split heavy Vitest mega-files for LPT shard balance

GitHub Issue: #692

Note: this draft may be authored with `GitHub Issue: TBD`, but it must be bound to a
concrete GitHub Issue before implementation work begins (PR evidence should reference that
Issue).

## Prerequisite

- `docs/issues_drafts/155-ci-pipeline-split-parallel-test-stage.md` (GitHub #487, closed) —
  shipped PR-required full regression via sharded Vitest lanes, serial-vs-shard coverage
  preservation, and the worker-RPC flake regression guard. **Reused, not rebuilt:** lane
  union must still equal serial discovery; heavy shards stay serial in-runner.
- GitHub #556 (local draft `181`, merged) — shipped runtime-weighted heavy shards (LPT bin
  packing on whole files), light/heavy classification manifest, and
  `scripts/check-ci-pipeline-split.ps1` as the coverage-equivalence guard. **Reused, not
  rebuilt:** `assignHeavyShards` in `scripts/lib/vitest-ci-lanes.mjs` treats each test file
  as atomic; this issue lowers the per-file makespan floor so LPT can spread work.
- `docs/ci-pipeline-split.md` — operator/runbook reference for lane topology, classification,
  and verification commands (Issues #487/#556).
- Sibling in the CI heavy-lane speedup series (brief #1, harvest): new split files need
  `scripts/vitest-runtime-history.json` entries so LPT weights are real on first measured
  run; coordinate with that harvest work but do not block on it — until then the
  `heavyDefaultRuntimeMs` conservative default applies.
- Prior-art verdict (**recon 2026-07-08**): **extends shipped #556/#487 CI machinery.**
  No open issue or local draft targets splitting oversized heavy-lane Vitest mega-files for
  shard balance. Briefs #3 (sleep reduction) and #5 (PR-path removal) are explicitly out of
  scope here.

## Goal

Lower the heavy-lane per-shard makespan floor by splitting the largest heavy Vitest
integration suites into several smaller test files along their existing independent
`describe` / `it` boundaries, so runtime-weighted LPT can distribute pieces across different
heavy shards. Each `it` must run identically — only its file home changes. Coverage must
remain provably unchanged: the union of assertions after the split equals before.

```behavior-kind
action-producing
```

```complexity-tier
tier: T2
advisory-prior: T2
```

## Design analysis

### Critical mechanics

`assignHeavyShards` assigns **whole files** to heavy shards using LPT on
`vitest-runtime-history.json` weights (`heavyDefaultRuntimeMs` = 120s when history is
missing). The slowest single file on a shard sets a makespan floor regardless of how well
other shards balance. The oversized cluster (~120s–200s estimated each) includes
`supervisor-fault-boundary`, `orchestrator-wake-supervisor`, `supervisor-auto-recovery`,
`supervisor-degraded-backoff`, `orchestrator-wake-listener`, and
`orchestrator-wake-supervisor-orphan-integration`. Natural split seams already exist where
each `it` spins up an isolated supervisor scenario.

### Options considered

1. **Re-tune shard count / weights only** — cheapest config change but cannot beat a single
   ~180–200s file co-located on one shard; insufficient alone.
2. **Split mega-files along describe/it seams (chosen)** — preserves test semantics, lets LPT
   place pieces on different shards; load-bearing obligation is coverage equivalence policed
   by the existing #556 guard.
3. **Extract shared setup modules that change execution** — rejected as out of scope; would
   risk harness behavior drift and would raise tier.

Chosen direction: option 2 — file-boundary moves only, with machine-checked coverage
equivalence and heavy classification for every resulting file.

## Binding surface

- Every oversized heavy file in scope is split into two or more Vitest test files along
  natural `describe` / `it` seams chosen by the planner. No prescribed split points or new
  filenames.
- **Coverage equivalence is the hard invariant:** after the split, serial discovery and the
  union of all lane/shard assignments must describe the same test files exactly once, with
  every new file explicitly classified `heavy`. Proof command:
  `pwsh -NoProfile -File scripts/check-ci-pipeline-split.ps1`.
- **Semantics preservation:** no change to what tests assert or how they exercise supervisor
  behavior — file home only. The split must not introduce reliance on cross-file module
  evaluation order, global singletons, or shared setup/teardown that only existed because
  cases lived in the same mega-file. Since split pieces may run on different heavy shards,
  the resulting file set must remain safe under shard-level parallelism (no implicit shared
  ports, temp paths, or global process state). Sleep reduction and PR-path removal stay in
  sibling briefs.
- **Classification and weights:** each resulting file is listed `heavy` in
  `scripts/vitest-ci-lanes.config.json` and is present in
  `scripts/vitest-runtime-history.json` with a measured runtime or a documented estimate.
  When a new file is awaiting brief #1 harvest, it is explicitly recorded as defaulted so
  shard-balance claims can be framed appropriately.
- **No workflow or lane-topology change:** heavy shard count, light lane, and aggregate check
  name stay as shipped in #556; only the file set and manifest entries change.
- **No verifier drift:** this PR does not change the lane discovery / aggregation proof
  machinery (`scripts/check-ci-pipeline-split.ps1` and the heavy-shard assignment logic).
  If verifier changes are required, split that work into a separate issue/PR.

```contract-evidence
binding-id: orchestrator-pack:vitest-heavy-split:coverage-equivalence
binding-type: ci-shard-aggregation-policy
binding: after mega-file splits, lane union equals serial Vitest discovery with no missing, duplicate, or unclassified file
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:vitest-heavy-split:heavy-classification-complete
binding-type: structured
binding: every Vitest file produced by the split is explicitly classified heavy in the lane manifest
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)

binding-id: orchestrator-pack:vitest-heavy-split:semantics-preserved
binding-type: test-runtime-flake-regression
binding: split pieces run the same assertions and supervisor exercises as before the file-boundary move
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)
```

## Files in scope

- `scripts/supervisor-fault-boundary.test.ts` and any new heavy files split from it
- `scripts/orchestrator-wake-supervisor.test.ts` and any new heavy files split from it
- `scripts/supervisor-auto-recovery.test.ts` and any new heavy files split from it
- `scripts/supervisor-degraded-backoff.test.ts` and any new heavy files split from it
- `scripts/orchestrator-wake-listener.test.ts` and any new heavy files split from it
- `scripts/orchestrator-wake-supervisor-orphan-integration.test.ts` and any new heavy files
  split from it
- `scripts/vitest-ci-lanes.config.json` — classification map updates
- `scripts/vitest-runtime-history.json` — per-file weight entries for new files when known
- `docs/**` — only if the PR records before/after shard-balance evidence

## Files out of scope

- Product / production code under `plugins/**`
- `.github/workflows/**` — lane topology unchanged
- `vitest.config.ts` — no CI execution model change
- Sleep-duration reduction inside tests (sibling brief #3)
- Moving slow tests off the PR path (sibling brief #5)
- `scripts/verify.ps1` ownership changes
- `vendor/**`, `packages/core/**`, `.ao/**`

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

```allowed-roots
scripts/**
docs/**
```

## Acceptance criteria

1. **Coverage equivalence after split:** `pwsh -NoProfile -File scripts/check-ci-pipeline-split.ps1`
   passes on the PR branch — lane union equals serial discovery, no duplicate file across
   lanes/shards, matrix count matches config, and no unclassified discovered file.

```producer-emission
producer: orchestrator-pack
datum: vitest-heavy-split
expected: coverage-equivalence
proof-command: pwsh -NoProfile -File scripts/check-ci-pipeline-split.ps1
```

2. **Heavy classification complete:** every Vitest file created by splitting the in-scope
   mega-files is listed `heavy` in `scripts/vitest-ci-lanes.config.json`; removed source
   filenames are not left referenced.

```producer-emission
producer: orchestrator-pack
datum: vitest-heavy-split
expected: heavy-classification-complete
proof-command: pwsh -NoProfile -File scripts/check-ci-pipeline-split.ps1
```

3. **Semantics preserved:** for each in-scope mega-file, the post-split file set runs the same
   `it` / `describe` cases with the same assertions and supervisor exercises; only file
   boundaries moved. The PR cites a before/after test-name inventory or equivalent diff
   showing no dropped, altered, or duplicated cases, generated from machine output (Vitest
   listing or an equivalent deterministic inventory) so the claim is auditable. The PR also
   states plainly whether any changes beyond file-boundary moves were required (expected:
   none).

```producer-emission
producer: orchestrator-pack
datum: vitest-heavy-split
expected: semantics-preserved
proof-command: npx vitest run --run scripts
```

4. **Mega-file floor removed:** each in-scope source mega-file that exceeded ~120s estimated
   runtime in `scripts/vitest-runtime-history.json` is replaced by two or more heavy files
   so no single resulting file retains the pre-split ~120s–200s dominance class. The PR
   includes before/after per-file runtime evidence (measured CI run output and/or
   `vitest-runtime-history.json`) that supports this claim.
5. **Runtime weights recorded:** `scripts/vitest-runtime-history.json` lists every new heavy
   file with a measured or documented estimate. Files awaiting brief #1 harvest are
   explicitly recorded as defaulted (interim `heavyDefaultRuntimeMs`) and the PR does not
   treat defaults as measured proof.
6. **Shard-balance evidence:** the implementation PR records before/after heavy-shard
   assignment (slowest shard duration and the heaviest file on that shard) from a
   representative non-markdown PR CI run, showing the slowest heavy shard no longer stacks
   two of the pre-split mega-files back-to-back on one shard. If some new files temporarily
   inherit `heavyDefaultRuntimeMs`, the PR notes that the LPT assignment is using defaults
   and treats the CI run’s observed shard durations as the primary evidence, without
   over-claiming per-file balance beyond what is measured.
7. **Issue binding before implementation:** the implementation PR references a concrete
   GitHub Issue for this work, and the draft header is updated so it no longer contains
   `GitHub Issue: TBD` when execution begins.

```positive-outcome
asserts: on a representative non-markdown PR CI run after the split, check-ci-pipeline-split stays green and the slowest heavy shard no longer carries two pre-split mega-files serially on one shard
input: realistic
```

## Upgrade-safety check

- No edits under `vendor/**` or `packages/core/**`.
- No change to the aggregate status name (**Run pack contract tests**) or lane job topology
  from #556.
- No weakening of the #487 worker-RPC flake regression guard — heavy shards remain serial
  in-runner; light lane parallelism untouched.
- Planner freedom preserved for split seams, new filenames, and any colocated test helpers.

## Verification

- `pwsh -NoProfile -File scripts/check-ci-pipeline-split.ps1` — green (AC#1–2).
- Targeted Vitest over the split suites — green with the same case inventory as pre-split
  (AC#3).
- `pwsh -NoProfile -File scripts/verify.ps1` and
  `pwsh -NoProfile -File scripts/check-reusable.ps1` — green.
- PR evidence artifact: before/after heavy-shard assignment table with slowest-shard duration
  (AC#6).
