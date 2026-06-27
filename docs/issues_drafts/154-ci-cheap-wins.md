# CI cheap wins: PR cancellation, dependency cache, and duplicate audit ownership

GitHub Issue: #486

## Prerequisite

- `docs/issues_drafts/03-scope-guard-ci.md` (GitHub #6) - existing CI scope guard; this issue must not weaken PR scope enforcement.
- `docs/issues_drafts/54-ci-path-filter-markdown-only.md` (GitHub #155) - already skips heavy advisory jobs for markdown-only PRs; this issue preserves that classifier and does not replace it.
- Prior art reconnaissance: no existing draft or queued issue covers PR-scoped cancellation, dependency caching gaps, or read-delegation audit workflow deduplication. Related read-delegation audit specs define the policy and fixtures, but not their CI ownership.

## Goal

Reduce avoidable CI queue time and repeated setup work with low-risk workflow changes while preserving main-branch verification and existing scope/security gates.

```behavior-kind
action-producing
```

## Binding surface

- PR runs may cancel older in-progress runs for the same PR identity, not merely the same branch name, so unrelated fork PRs with matching branch names cannot cancel each other; `push` runs for `main` must never be cancelled by newer pushes.
- Workflows that install npm dependencies for pack-owned jobs use dependency caching consistently where the runner supports it.
- The read-delegation audit fixture suite has one CI owner for a given non-markdown PR run; any standalone audit workflow must either add unique checks not covered by the full suite or skip the duplicate fixture run.
- The existing markdown-only classifier remains conservative: any non-doc/code-bearing change still receives the full mandatory CI set.

```contract-evidence
binding-id: orchestrator-pack:ci-cheap-wins:gha-pr-cancellation-scope
binding-type: github-actions-workflow-policy
binding: CI cancellation applies to superseded pull-request runs but cannot cancel push-to-main verification
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:ci-cheap-wins:npm-cache-coverage
binding-type: github-actions-dependency-cache-policy
binding: pack workflow jobs that install npm dependencies use cache setup or document why caching is unavailable
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)

binding-id: orchestrator-pack:ci-cheap-wins:read-delegation-audit-ci-owner
binding-type: ci-test-ownership-policy
binding: the read-delegation audit fixture suite has one ordinary non-markdown PR CI owner
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)
```

## Files in scope

- `.github/workflows/**`
- `docs/**`
- `scripts/check-ci-cheap-wins.ps1` (new) or the renamed single guard that owns all three producer-emission proof commands

## Files out of scope

- `vitest.config.ts`
- `scripts/verify.ps1`
- `scripts/test-all.ps1`
- `plugins/**`
- `vendor/**`
- `packages/core/**`

## Denylist

```denylist
vendor/**
packages/core/**
```

Scope boundary note: This denylist is scoped to `154-ci-cheap-wins`.

## Acceptance criteria

1. PR cancellation is added only for pull-request runs and is scoped to the same PR identity, not just `head_ref` / branch name. A new push to `main` starts and completes independently even if another main run is already in progress; this is covered by workflow expression review or a small static guard.

```producer-emission
producer: orchestrator-pack
datum: ci-cheap-wins
expected: gha-pr-cancellation-scope
proof-command: pwsh -NoProfile -File scripts/check-ci-cheap-wins.ps1
```

2. Jobs that run `npm ci` in the relevant workflows either use npm cache setup or document why caching is impossible for that job. The current uncached pack dependency installs in PR scope guard and reusable Codex review are covered.

```producer-emission
producer: orchestrator-pack
datum: ci-cheap-wins
expected: npm-cache-coverage
proof-command: pwsh -NoProfile -File scripts/check-ci-cheap-wins.ps1
```

3. The read-delegation audit fixture test is not executed twice on the same ordinary non-markdown PR CI path. If the standalone workflow remains, it owns only checks that are not already part of the full test suite or has an explicit skip condition for the duplicate fixture path.

```producer-emission
producer: orchestrator-pack
datum: ci-cheap-wins
expected: read-delegation-audit-ci-owner
proof-command: pwsh -NoProfile -File scripts/check-ci-cheap-wins.ps1
```

4. Markdown-only PR behavior from #155 is unchanged: docs/skills/rules-only markdown changes continue to skip heavy advisory jobs, while mixed or code-bearing changes still run the mandatory gates.
5. No fetch-depth reduction is bundled into this issue. Diff-sensitive jobs keep correct base/head comparison semantics.

```positive-outcome
asserts: superseded PR pushes stop wasting runner time, dependency installs reuse cache where safe, and the read-delegation fixture has one CI owner per ordinary PR run
input: realistic
```

## Upgrade-safety check

- Main branch verification remains fail-closed: cancellation expressions cannot apply to `push` events.
- Scope guard and reusable review jobs retain their trusted checkout semantics; caching cannot change which checkout supplies policy code.
- The duplicate-audit change preserves all read-delegation policy checks, including pointer consistency and CI-gate meta-check coverage.

## Verification

- Static workflow guard proving `cancel-in-progress` is pull-request gated and cannot cancel `push` to `main`.
- `scripts/check-ci-cheap-wins.ps1` proves the PR-cancellation, npm-cache coverage, and read-delegation audit ownership contracts.
- CI dry-run or workflow expression test covering PR update, main push, markdown-only PR, and non-markdown PR cases.
- Existing local checks remain green:

```powershell
pwsh -NoProfile -File scripts/verify.ps1
pwsh -NoProfile -File scripts/check-reusable.ps1
```
