# gh wrapper hop-budget fail-safe must throw when only wrapper shims are reachable

GitHub Issue: [#467](https://github.com/chetwerikoff/orchestrator-pack/issues/467)

## Prerequisite

- `docs/issues_drafts/136-gh-wrapper-mutual-recursion-terminal-resolution.md` (GitHub [#442](https://github.com/chetwerikoff/orchestrator-pack/issues/442), closed) - shipped identity-based terminal `gh` resolution and the secondary hop-budget fail-safe for wrapper-only PATH chains.

## Goal

Restore the #442 secondary defense: when `resolveRealGhBinary` can only see wrapper shims and no native `gh` executable is reachable, it must fail closed with the hop-budget error instead of returning `undefined` or falling through silently.

```behavior-kind
action-producing
```

## Binding surface

- The #442 resolver must distinguish a real native `gh` executable from pack/AO wrapper shims.
- A PATH made only of wrapper shims is a terminal failure, not a successful resolution.
- The existing regression test `scripts/gh-wrapper.test.ts` case `fail-closed when PATH has only wrapper shims (hop budget)` is the load-bearing fixture: it currently fails on clean `main` because no error is thrown.
- This issue fixes only the fail-safe regression. It does not redesign #442 terminal resolution, REST routing, or gh inventory matching.

```contract-evidence
none
```

## Files in scope

- `scripts/**`
- `tests/**`

## Files out of scope

- `docs/issues_drafts/146-autonomous-surface-spawn-budget.md` / GitHub #462 implementation.
- REST inventory route changes.
- AO core or vendored code.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

Scope boundary note: This denylist is scoped to `147-gh-wrapper-hop-budget-failsafe-regression`.

```allowed-roots
scripts/**
tests/**
```

## Acceptance criteria

1. The clean-main failing test passes: `gh mutual-recursion terminality (Issue #442) > fail-closed when PATH has only wrapper shims (hop budget)` throws an error matching `wrapper hop budget exceeded`.
2. The resolver still returns a native `gh` executable for normal PATH layouts and still skips pack/AO wrapper paths.
3. Existing #442 bounded-recursion smoke tests still complete without timeout under two-wrapper PATH layouts.

```positive-outcome
asserts: with PATH containing only wrapper shims and GH_RESOLVE_MAX_NON_NATIVE=2, resolveRealGhBinary throws the hop-budget fail-closed error instead of returning undefined
input: realistic
```

## Upgrade-safety check

- No edits to `vendor/**`, `packages/core/**`, or vendored AO core.
- No weakening of #442 terminality: native executable identity remains the success condition.
- No new environment variable or local machine pin may be required to make the fail-safe work.

## Verification

- `npm test -- scripts/gh-wrapper.test.ts`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/147-gh-wrapper-hop-budget-failsafe-regression.md`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/147-gh-wrapper-hop-budget-failsafe-regression.md`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command parked-root -DraftPath docs/issues_drafts/147-gh-wrapper-hop-budget-failsafe-regression.md`
- After the targeted suite is green, run `pwsh -NoProfile -File scripts/verify.ps1` and `pwsh -NoProfile -File scripts/check-reusable.ps1`.

## Decisions

- This is a separate blocker issue because #462's spawn-budget work should not have to diagnose a pre-existing #442 fail-safe regression before it can run repository verification.
- The fix is intentionally narrow: restore the fail-closed path that #442 already specified and tested.
