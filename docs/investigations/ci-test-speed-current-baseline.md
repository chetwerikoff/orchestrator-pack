# CI test speed baseline — 4-way Vitest sharding (pre-#536)

Captured **2026-06-30** from ten successful `scope-guard` workflow runs on
`main` **before** the eight-way Vitest experiment (#536). Durations exclude
GitHub queue time (job `started_at` → `completed_at` via the GitHub Actions
jobs API).

## Method

1. Listed successful `scope-guard` runs on `main` with `event=push` and
   `status=success` (REST:
   `GET /repos/{owner}/{repo}/actions/workflows/scope-guard.yml/runs`).
2. Took the ten most recent runs completed before 2026-06-30T00:00:00Z that
   exposed exactly four `Vitest shard */4` jobs.
3. For each run, recorded per-shard wall time and critical-path seconds as
   `max(shard completed_at) − min(shard started_at)` across the Vitest matrix
   (parallel lanes; typecheck/Pester/verify-pack excluded).

Reproduce with:

```bash
# Example: jobs for one run
gh api repos/chetwerikoff/orchestrator-pack/actions/runs/28401690870/jobs \
  --jq '.jobs[] | select(.name | startswith("Vitest shard")) | {name, started_at, completed_at}'
```

## Per-run evidence

| Run | Head | Slowest shard | Shard 1 | Shard 2 | Shard 3 | Shard 4 | Critical path |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: |
| [28401690870](https://github.com/chetwerikoff/orchestrator-pack/actions/runs/28401690870) | `a715f40` | **3/4** | 162s | 107s | **576s** | 139s | 576s |
| [28401159928](https://github.com/chetwerikoff/orchestrator-pack/actions/runs/28401159928) | `f1b6f2a` | **3/4** | 134s | 92s | **639s** | 139s | 639s |
| [28378829471](https://github.com/chetwerikoff/orchestrator-pack/actions/runs/28378829471) | `86656be` | **3/4** | 157s | 112s | **604s** | 139s | 606s |
| [28366913907](https://github.com/chetwerikoff/orchestrator-pack/actions/runs/28366913907) | `18d07a3` | **3/4** | 138s | 101s | **426s** | 147s | 426s |
| [28363823417](https://github.com/chetwerikoff/orchestrator-pack/actions/runs/28363823417) | `c281a77` | **3/4** | 145s | 116s | **610s** | 149s | 610s |
| [28363202441](https://github.com/chetwerikoff/orchestrator-pack/actions/runs/28363202441) | `bb2fa02` | **3/4** | 137s | 115s | **491s** | 145s | 492s |
| [28362763734](https://github.com/chetwerikoff/orchestrator-pack/actions/runs/28362763734) | `5bfc1cc` | **3/4** | 127s | 97s | **597s** | 119s | 597s |
| [28325525150](https://github.com/chetwerikoff/orchestrator-pack/actions/runs/28325525150) | `2dc7415` | **3/4** | 129s | 102s | **579s** | 116s | 580s |
| [28324925713](https://github.com/chetwerikoff/orchestrator-pack/actions/runs/28324925713) | `cbacfb0` | **3/4** | 126s | 91s | **597s** | 118s | 597s |
| [28324249036](https://github.com/chetwerikoff/orchestrator-pack/actions/runs/28324249036) | `ea7d4ba` | **3/4** | 124s | 96s | **614s** | 114s | 614s |

## Summary (10 runs)

| Metric | Value |
| --- | --- |
| **Vitest shard 3/4 slowest** | **10 / 10** runs |
| Shard 3/4 duration p50 | **597s** (~9m57s) |
| Other shards (1, 2, 4) duration p50 | **125s** (~2m05s); range **91s–162s** |
| Workflow critical path p50 | **597s** (~9m57s) |
| Type-check p50 (same runs) | ~24s |
| Pester p50 (same runs) | ~27s |

## Interpretation

- Critical path is **Vitest-dominated**; typecheck (~24s p50) and Pester (~27s
  p50) are not the bottleneck.
- Imbalance is **runtime skew from round-robin file assignment** (sorted file
  index, not duration), not missing #486–#488 CI wins (cancellation, serial
  in-runner Vitest, per-shard budget).
- **#536 follow-up threshold** (from issue spec): open runtime-weighted
  sharding after merge when the slowest Vitest shard is **≥2× the median** of
  the other shards **or** workflow critical path remains **≥8 minutes**.

## Related docs

- `docs/ci-pipeline-split.md` — pipeline architecture and eight-way experiment
- GitHub #536 — eight-way Vitest sharding task
