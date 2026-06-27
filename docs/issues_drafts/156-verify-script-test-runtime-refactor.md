# Verify script test-runtime refactor

GitHub Issue: #488

## Prerequisite

- `docs/issues_drafts/154-ci-cheap-wins.md` (GitHub #486) - establishes low-risk workflow ownership cleanup first.
- `docs/issues_drafts/155-ci-pipeline-split-parallel-test-stage.md` (GitHub #487) - establishes the PR-required full-regression lane that should own Vitest coverage.
- Prior art reconnaissance: no existing draft or queued issue covers `verify.ps1` Vitest duplication, repeated dependency installation, PowerShell spawn batching, or test runtime budgets.

## Goal

Make `verify.ps1` a fast structural verifier instead of a second cold-start test harness, while preserving every contract it currently protects through either the full test lane or explicit structural checks.

```behavior-kind
action-producing
```

## Design analysis

### Critical mechanics

`scripts/verify.ps1` is currently a large verifier that performs multiple inline dependency-install guards and several separate targeted Vitest invocations. In CI, `verify-pack` runs before the full `tests` job and has no Node dependency cache setup of its own. That means the same Vitest coverage can be paid for twice across jobs, and each targeted invocation pays process and test-runner cold start again.

### Industry grounding

KB consult found `Commit stage` and `Continuous integration` notes relevant: the commit stage must deliver rapid feedback with a hard ceiling around ten minutes, slow tests should not silently accumulate, and feedback must be actionable while the change context is fresh. This issue applies that principle inside the local verifier by separating structural checks from full regression execution. Synto had no relevant material.

### Architecture sketch

```text
verify.ps1
  |
  +--> structural/read-only policy checks
  +--> dependency availability preflight once, if any local test-backed check remains
  +--> no duplicate full-suite Vitest ownership

test-all / CI test lane
  |
  +--> owns full Vitest/Pester regression coverage
  +--> reports timing budget regressions
```

### Options considered

1. Keep every targeted Vitest call in `verify.ps1` but share one dependency install. This is low risk but still duplicates the full regression lane and keeps several runner cold starts.
2. Collapse targeted Vitest calls into one invocation only when `verify.ps1` is explicitly asked to run test-backed checks. This preserves a local escape hatch while removing most repeated cold-start overhead.
3. Remove all Vitest execution from `verify.ps1` and require the full test lane for test-backed contracts. This maximizes speed but may make local structural verification less useful for contracts historically checked by `verify.ps1`.

Chosen direction: make full regression ownership explicit and remove duplicate default Vitest work from `verify.ps1`; if a targeted test-backed verifier remains, it must run through one dependency preflight and one test-runner invocation, not repeated inline installs and cold starts.

### Full-class enumeration

- Check class: structural filesystem/prompt/workflow check, Node-backed static check, Vitest-backed regression, Pester-backed regression.
- Invocation class: local developer run, CI `verify-pack`, full CI test lane, explicit debug/test-backed mode.
- Dependency class: already installed, cold checkout with cache, cold checkout without cache, install failure.
- Coverage ownership class: verify-only structural contract, full-test-lane regression, intentionally duplicated smoke check with justification.
- Runtime regression class: slow individual test, slow test file, repeated process spawn, repeated dependency install, runner cold start.

## Binding surface

- `verify.ps1` default behavior is structural/read-only verification and must not duplicate the full Vitest suite ownership already provided by the CI test lane.
- Repeated dependency-install guards are collapsed to one preflight per invocation path that genuinely needs Node dependencies.
- If targeted Vitest coverage remains in `verify.ps1`, it is batched into one runner invocation and documented as smoke/structural coverage rather than a second full-regression owner.
- A runtime budget guard prevents individual tests or files from silently becoming too slow for the commit-stage target.
- Pester setup is cached or preinstalled in CI so PowerShell test startup does not dominate repeated runs.
- The `verify-pack` job has a coherent final dependency state: either the default verifier path is Node-free, or the workflow provides one explicit Node setup/cache step instead of relying on hidden installs inside `verify.ps1`.

```contract-evidence
binding-id: orchestrator-pack:verify-runtime-refactor:verify-default-no-duplicate-vitest-owner
binding-type: local-verifier-runtime-policy
binding: the default verifier path does not duplicate full Vitest regression ownership already provided by the CI test lane
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:verify-runtime-refactor:single-dependency-preflight
binding-type: verifier-dependency-policy
binding: verifier paths that need Node dependencies perform one centralized dependency preflight instead of repeated inline installs
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)

binding-id: orchestrator-pack:verify-runtime-refactor:slow-test-budget-guard
binding-type: test-runtime-budget-policy
binding: the full test harness reports or fails slow-test regressions before they silently erode the commit-stage budget
producer: orchestrator-pack
evidence: NEW(produced-by AC#4)
```

## Files in scope

- `scripts/verify.ps1`
- `scripts/test-all.ps1`
- `scripts/**` test harness helpers and fixtures
- `.github/workflows/**`
- `docs/**`

## Files out of scope

- `vendor/**`
- `packages/core/**`
- Prompt/rule behavior changes unrelated to verification runtime
- GitHub fetch-depth optimization

## Denylist

```denylist
vendor/**
packages/core/**
```

Scope boundary note: This denylist is scoped to `156-verify-script-test-runtime-refactor`.

## Acceptance criteria

1. Default `verify.ps1` no longer performs multiple targeted Vitest cold starts for coverage that the full test lane already owns. Any remaining test-backed path is explicitly justified as smoke/structural verification.

```producer-emission
producer: orchestrator-pack
datum: verify-runtime-refactor
expected: verify-default-no-duplicate-vitest-owner
proof-command: pwsh -NoProfile -File scripts/verify.ps1
```

2. A cold `verify.ps1` invocation performs at most one Node dependency preflight/install decision on the default path; repeated inline `npm ci` guards are removed or centralized.

```producer-emission
producer: orchestrator-pack
datum: verify-runtime-refactor
expected: single-dependency-preflight
proof-command: pwsh -NoProfile -File scripts/verify.ps1
```

3. If `verify.ps1` still runs Vitest by default or by explicit mode, all selected files are batched into one runner invocation with one dependency preflight.
4. The full test lane includes a timing budget guard that fails or clearly flags slow-test regressions before they silently erode the commit-stage target. The threshold is documented and can be adjusted intentionally.

```producer-emission
producer: orchestrator-pack
datum: verify-runtime-refactor
expected: slow-test-budget-guard
proof-command: pwsh -NoProfile -File scripts/test-all.ps1
```

5. CI avoids reinstalling Pester on every relevant run when a cache or preinstall mechanism is available, without weakening version requirements.
6. After internal `npm ci` calls are removed, the `verify-pack` job either remains Node-free on its default path or has one explicit Node setup/cache step for any remaining Node-backed structural checks.
7. The refactor preserves each existing verifier contract by mapping it to either a structural check in `verify.ps1` or an owned test in the full regression lane.

```positive-outcome
asserts: CI and local verification stop paying repeated dependency installs and repeated Vitest cold starts while retaining every verifier contract
input: realistic
```

## Upgrade-safety check

- The PR includes a mapping table from pre-refactor verifier checks to post-refactor owners, so removed duplicate test calls are not mistaken for lost coverage.
- Runtime-budget failures are actionable and identify the slow file/test class, not just a generic timeout.
- The default local verifier remains safe for read-only pack validation and keeps `check-reusable.ps1` independent.

## Verification

- Before/after timing for `pwsh -NoProfile -File scripts/verify.ps1` on a cold or clean dependency state, including dependency-install count and Vitest invocation count.
- Full test lane run showing the regression coverage still executes after duplicate verifier calls are removed.
- Slow-test budget negative fixture or controlled threshold test proving the guard fails when a test/file exceeds the configured budget.
- Existing local checks remain green:

```powershell
pwsh -NoProfile -File scripts/verify.ps1
pwsh -NoProfile -File scripts/check-reusable.ps1
```
