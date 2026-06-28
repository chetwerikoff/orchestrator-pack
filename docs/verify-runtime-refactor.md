# Verify runtime refactor (Issue #488)

`scripts/verify.ps1` is a **fast structural verifier** on the default path. Full
Vitest/Pester regression ownership lives in `scripts/test-all.ps1` and the CI
`test-vitest` / `test-pester` lanes introduced by Issue #487.

## Default vs smoke paths

| Invocation | Node npm ci | Vitest | Purpose |
| --- | ---: | ---: | --- |
| `pwsh -NoProfile -File scripts/verify.ps1` | 0 | 0 | Structural/read-only pack verification (CI `verify-pack`) |
| `pwsh -NoProfile -File scripts/verify.ps1 -TestBackedSmoke` | ≤1 | 1 batched run | Local smoke/debug only; not CI default |
| `pwsh -NoProfile -File scripts/test-all.ps1` | ≤1 | 1 full suite + budget guard | Local full regression |
| CI `test-vitest` matrix | 1 (cached) | sharded full suite | Required PR regression lane |

## Contract ownership mapping

Pre-refactor Vitest blocks removed from default `verify.ps1` are **not** lost —
each contract remains owned by a structural check and/or the full regression lane.

| Former verify check | Post-refactor owner | Notes |
| --- | --- | --- |
| `gh-wrapper/vitest` | `scripts/check-gh-wrapper.ps1` + `scripts/gh-wrapper.test.ts` (full lane) | Static wiring guard stays in verify; behavior regression in Vitest shard |
| `github-fleet-cache/vitest` | `scripts/check-github-fleet-cache-bypass.ps1` + fleet-cache `*.test.ts` (full lane) | Bypass guard stays structural |
| `contract-evidence/vitest` | draft discipline fixtures + `scripts/contract-evidence.test.ts` (full lane) | Manifest integrity node check stays in verify (no npm ci) |
| `autonomous-spawn-policy/vitest` | `scripts/check-autonomous-spawn-policy.ps1` + `autonomous-spawn-policy.test.ts` | Inventory drift guard stays structural |
| `autonomous-spawn-worktree/vitest` | worktree gate structural checks + `autonomous-spawn-worktree-gate.test.ts` | |
| `autonomous-spawn-budget/vitest` | `scripts/check-autonomous-spawn-budget.ps1` + `autonomous-spawn-budget.test.ts` | |
| `review-pipeline-spawn-budget/vitest` | `scripts/check-review-pipeline-spawn-budget.ps1` + spawn budget Vitest files | |
| `autonomous-interposer/vitest` | boundary checks + `autonomous-orchestrator-interposer.test.ts` | |

Optional `-TestBackedSmoke` batches the former targeted files in **one** Vitest
invocation after **one** dependency preflight via
`scripts/invoke-verify-test-backed-smoke.ps1`.

## Slow-test budget (full lane)

Thresholds are canonical in `scripts/test-runtime-budget.config.json`:

- **perTestMs** (default 120000): fail when a single Vitest case exceeds this.
- **perFileMs** (default 450000): fail when a test file total exceeds this (~7.5 min). CI integration-heavy script suites may legitimately approach this on cold GHA runners.

`scripts/test-all.ps1` writes Vitest JSON to `.vitest-runtime-report.json` and
runs `scripts/enforce-vitest-runtime-budget.mjs`. Failures name the slow test
and/or file class — not a generic timeout.

Adjust thresholds intentionally when a test class legitimately grows; do not
silently raise budgets to greenwash regressions.

## CI wiring

- **`verify-pack`**: runs structural `verify.ps1` before any Node setup; npm ci
  is not hidden inside verify. Node setup remains explicit for
  `check-ci-pipeline-split.ps1`.
- **`test-pester`**: caches `~/.local/share/powershell/Modules/Pester` and uses
  `scripts/install-pester-ci.ps1` on cache miss (Pester 5+ requirement unchanged).

## Verification

```powershell
pwsh -NoProfile -File scripts/verify.ps1
pwsh -NoProfile -File scripts/check-reusable.ps1
pwsh -NoProfile -File scripts/check-verify-runtime.ps1
pwsh -NoProfile -File scripts/test-all.ps1
```

Negative budget fixture: `scripts/test-runtime-budget.test.ts`.
