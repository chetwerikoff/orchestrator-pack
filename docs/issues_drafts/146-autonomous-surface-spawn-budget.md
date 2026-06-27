# Autonomous guarded commands must stay inside a reduced process-spawn budget

GitHub Issue: [#462](https://github.com/chetwerikoff/orchestrator-pack/issues/462)

## Prerequisite

- `docs/issues_drafts/71-orchestrator-side-process-supervisor.md` (GitHub [#205](https://github.com/chetwerikoff/orchestrator-pack/issues/205), closed) - already provides the registry-owned supervisor and child health model this draft measures.
- `docs/issues_drafts/103-llm-turn-review-start-claimed-gate.md` (GitHub [#318](https://github.com/chetwerikoff/orchestrator-pack/issues/318), closed) and `docs/issues_drafts/104-orchestrator-spawn-git-process-boundary-deny.md` (GitHub [#324](https://github.com/chetwerikoff/orchestrator-pack/issues/324), closed) - already establish process-boundary enforcement for autonomous turns.
- `docs/issues_drafts/128-autonomous-bash-env-interposer-eval-hidden-defense.md` (GitHub [#406](https://github.com/chetwerikoff/orchestrator-pack/issues/406), closed) - already ships the tracked `BASH_ENV` bootstrap/interposer and eval-hidden defense.
- `docs/issues_drafts/136-gh-wrapper-mutual-recursion-terminal-resolution.md` (GitHub [#442](https://github.com/chetwerikoff/orchestrator-pack/issues/442), closed) - already fixes the old `gh` mutual-recursion OOM class; this draft must not reopen that design.
- `docs/issues_drafts/138-supervisor-children-gh-rest-shim-path.md` (GitHub [#447](https://github.com/chetwerikoff/orchestrator-pack/issues/447), closed) and `docs/issues_drafts/140-graphql-fleet-shared-github-api-gate.md` (GitHub [#453](https://github.com/chetwerikoff/orchestrator-pack/issues/453), closed) - already reduce GitHub inventory call pressure for supervisor children.
- `docs/issues_drafts/147-gh-wrapper-hop-budget-failsafe-regression.md` (GitHub [#467](https://github.com/chetwerikoff/orchestrator-pack/issues/467), open) - restores the #442 wrapper-only PATH hop-budget fail-safe. This draft should not require workers to diagnose that pre-existing red `verify.ps1` blocker.

Related, not prerequisite:

- `docs/issues_drafts/139-supervisor-crash-hardening-degraded-backoff-and-redirect-safety.md` (GitHub [#450](https://github.com/chetwerikoff/orchestrator-pack/issues/450), open) - owns persistent child failure backoff, fault boundaries, and null `OpenPrs` handling. Supervisor-fleet aggregate budgeting belongs as a follow-up after #450's recovery state machine lands.

## Goal

Reduce the confirmed autonomous-surface process-spawn amplifier: protected no-op shell turns must not pay per-command helper-process cost, and high-frequency guarded read-only `git`/`ao` commands must eliminate or amortize per-command PowerShell guard startup instead of treating today's guard-spawn rate as the new normal. The issue limits the in-repo spawn class; it does not claim to prove or fix the WSL2 kernel panic itself.

```behavior-kind
action-producing
```

## Binding surface

- **Prior-art verdict:** extends shipped process-boundary and supervisor contracts; does not replace #318/#324/#406 guards, #442 terminal `gh` resolution, #447/#453 GitHub read reductions, or #450 failure backoff.
- **Incident evidence:** the confirmed churn evidence is 19,644 `snap.node.node-*` scopes at roughly 200/min during boot `69037702...`, plus journal `_CMDLINE` counts dominated by `git-autonomous-guard.ps1` and `ao-autonomous-guard.ps1`. The earlier "pwsh storm pairs" framing is not binding: `IPC ServerListenerStarted` was not observed in that boot.
- **Process-spawn budget:** pack-owned guard/wrapper surfaces must expose a testable budget for representative command classes. The planner may choose tracing, counters, fixtures, or a generated manifest; the contract is that existing repository test/check entrypoints can fail on a process-count regression without requiring workflow changes.
- **No-op fast path:** a protected `bash -c` turn containing only builtins/no-op commands must not spawn helper processes per user command after one-time bootstrap.
- **Guarded command budget:** common read-only `git` and `ao` inventory commands exercised by autonomous turns must remove or amortize per-command PowerShell guard startup. Budgets are derived from declared caller cadence multiplied by measured per-command cost, and acceptance must show a reduction from the current guard-spawn baseline rather than merely blessing the baseline.
- **Design analysis:** the binding scenario matrix for the worker is in **Decisions — Scenario matrix** below.

```contract-evidence
none
```

## Files in scope

- `scripts/**`
- `tests/**`
- `docs/**`

## Files out of scope

- WSL kernel changes, Windows-side WSL configuration, or `wsl --update` automation.
- Rewriting AO core or vendored `ComposioHQ/agent-orchestrator`.
- Replacing #450's recovery state machine, adding supervisor-fleet aggregate budgeting, or re-specifying #447/#453 GitHub transport/cache work.
- Removing rtk; rtk is optional coverage-extension evidence, not the assumed root cause.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

Scope boundary note: This denylist is scoped to `146-autonomous-surface-spawn-budget`.

```allowed-roots
scripts/**
tests/**
docs/**
```

## Acceptance criteria

1. A bounded spawn-budget harness covers the mandatory classes marked load-bearing in **Decisions — Scenario matrix**. Coverage-extension classes may be implemented in the same PR when cheap, but are not required for this issue.
2. The no-op shell class proves the `BASH_ENV`/DEBUG-trap path has no per-command helper-process growth: increasing a fixture from 5 to 100 no-op commands may add command execution time, but must not add helper-process events proportional to command count.
3. The guarded read-only `git`/`ao` classes declare and test reduced process budgets for the minimum incident-observed command set: `git config --get remote.origin.url`, `git log --since='60 seconds ago' --format=%H`, `git branch --show-current`, `git status --short --branch`, `ao status --json --reports full`, and `ao review list --json`. The planner may add more read shapes, but these six are mandatory. The acceptance proof must show that per-command PowerShell guard startup is eliminated or amortized for the guarded read path; it is not enough to measure the current spawn count and declare it the budget. The draft does not prescribe whether the implementation uses a shell fast path, a cached decision, a resident helper, or another bounded design.
4. Denied-action safety remains mandatory: at least one tree-mutating `git` action and one denied AO action on the autonomous surface must still fail closed after any fast path, cache, or resident helper is added.
5. `gh` inventory and passthrough argv are covered only to the extent needed to preserve #442/#447/#453 no-recursion and bounded-passthrough behavior. The #442 hop-budget regression is fixed by the prerequisite draft, not by this issue.
6. The healthy wake-supervisor child tick class declares a bounded per-tick process budget and includes a failing fixture/regression case when that budget is exceeded, without pulling degraded recovery or dependency-failure handling into this issue.
7. Verification output reports measured process-spawn counts by surface and command class, plus the derived budget, so future regressions identify the offending class instead of only reporting one aggregate failure.

```positive-outcome
asserts: on realistic autonomous-surface guarded command mixes, the harness reports reduced bounded process-spawn counts per class and fails on a synthetic per-command fork amplifier
input: realistic
```

## Upgrade-safety check

- No edits to `vendor/**`, `packages/core/**`, or vendored AO core.
- No new secrets or machine-local credential files.
- Existing safety gates remain fail-closed: denied `ao`/`git` actions must still be denied after any fast-path or budget work.
- WSL kernel update remains an operator/runtime mitigation outside this repository's implementation scope.

## Verification

- Run the new spawn-budget harness and show per-class counts for every mandatory load-bearing class listed in **Decisions — Scenario matrix**.
- Run the existing autonomous interposer, guard, `gh` wrapper, and reusable checks touched by the implementation.
- Run:
  - `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/146-autonomous-surface-spawn-budget.md`
  - `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/146-autonomous-surface-spawn-budget.md`
  - `npm test -- scripts/autonomous-orchestrator-interposer.test.ts`
  - `npm test -- scripts/gh-wrapper.test.ts`
  - `pwsh -NoProfile -File scripts/check-reusable.ps1`

## Decisions

- **Cause framing:** the WSL2 `kernel BUG at lib/list_debug.c:65` is outside repo ownership. Churn-to-panic causation is plausible but not proven, and idle recurrence was not established. This draft limits the in-repo managed spawn class; it does not claim to prove the only cause of the panic or to replace the operator/runtime `wsl --update` mitigation for Layer A.
- **Option chosen:** add a reduced spawn-budget contract over existing guards. Extending only #450 is too narrow because #450 handles failure backoff, while the confirmed incident evidence also shows steady guard/wrapper churn. Rewriting the guard architecture is too risky because #318/#324/#406 are safety contracts.
- **Planner freedom:** the worker chooses how to eliminate or bound helper-process growth. The required outcome is measured bounded behavior, not a mandated implementation technique.

### Scenario matrix

The harness must cover the load-bearing equivalence classes below. Coverage-extension classes are useful follow-up coverage, not required acceptance for this single PR.

| Class | Surface | Command class | Guard state | Dependency state | Requirement |
|---|---|---|---|---|---|
| Load-bearing A | AO orchestrator tmux shell / autonomous agent shell | shell builtin/no-op | `BASH_ENV` on with autonomous surface | healthy | no per-command helper-process growth after one-time bootstrap |
| Load-bearing B | AO orchestrator tmux shell / autonomous agent shell | read-only `git` and AO read | `BASH_ENV` on with autonomous surface | healthy | reduced/amortized PowerShell guard startup per command |
| Load-bearing C | AO orchestrator tmux shell / autonomous agent shell | tree-mutating denied `git` and denied AO action | `BASH_ENV` on with autonomous surface | healthy | preserve fail-closed behavior while read fast paths are optimized |
| Load-bearing D | wake-supervisor child | representative tick invoking guarded read commands | inherited supervisor env | healthy | enforce a bounded per-tick process budget without making #450 degraded behavior part of this issue |
| Coverage extension | any | `gh` inventory read; `gh` passthrough; rtk on/off cells | `BASH_ENV` off/on; rtk off/on where available | healthy or dependency failure | preserve no-recursion behavior and collect extra budget data when cheap |

Expected outcomes:

- No-op/builtin commands must not pay per-command helper-process cost under `BASH_ENV`; any extra work is one-time shell bootstrap.
- Read-only `git`/AO commands may pay bounded wrapper cost, but repeated calls must reduce or amortize the current per-command guard-process startup.
- Denied action-producing commands may invoke guard logic, but must terminate with bounded process count and no follow-on side effects.
- Supervisor children under dependency failure and aggregate fleet budgeting are deferred to #450 follow-up scope.
- rtk-on and rtk-off cells may be measured when the host supports rtk; rtk is not load-bearing for this issue.
