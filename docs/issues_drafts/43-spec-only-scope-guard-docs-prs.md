# Spec-only scope-guard mode for docs-only draft PRs

GitHub Issue: #121

## Prerequisite

None blocking. Related, not blocking:

- `.claude/skills/publish-issue-draft/SKILL.md` (sync-only default) — already
  shipped; this issue removes the "until that lands" caveat it leaves in the
  batch/full-publish Common steps. The skill must be re-pointed at the lighter
  path **in the same PR** that ships this behavior.

## Goal

Let a draft be published to `main` as a **spec-only** docs PR without the
declaration-snapshot + auto-close + reopen machinery that exists for
implementation PRs. Publishing a spec must stop closing the implementation
issue it describes, so the close/reopen dance disappears and a pure
`docs/issues_drafts/**` change no longer needs `ao-declare`. Implementation PRs
keep their current, stricter contract unchanged.

## Binding surface

This issue commits the repository to a scope-guard contract with **two**
recognised PR shapes:

1. **Implementation PR (unchanged):** must carry a GitHub closing reference
   (`Closes/Fixes/Resolves #N`), must have a committed declaration snapshot
   under `docs/declarations/<N>.*.json`, and the diff is validated against that
   snapshot and the issue-body fences. Behaviour and failure reasons stay as they
   are today.

2. **Spec-only PR (new):** passes scope guard **without** a committed declaration
   snapshot when **all** of the following hold:
   - the PR carries an unambiguous, machine-detectable **spec-only signal** that
     a reader and the guard agree on (the planner chooses its concrete form;
     it must be documented where contributors will see it);
   - every changed path lies inside a bounded, documented **spec-docs
     allowlist** (at minimum `docs/issues_drafts/**` and
     `docs/issue_queue_index.md`; `docs/architecture.md` and
     `docs/issues_drafts/00-architecture-decisions.md` are candidates — the set
     is the contract, enumerate it in one place);
   - the PR references the implementation issue with a reference the guard can
     resolve to a number, using a form that does **not** trigger GitHub
     auto-close (so no reopen step is ever needed).

A PR that declares itself spec-only but touches any path outside the spec-docs
allowlist must **fail** the guard — the lighter path must not become an escape
hatch for code.

The closing-keyword set and any new non-closing reference handling are currently
**duplicated** between `scripts/pr-scope-check.ts` (the `ISSUE_LINK_PATTERN`
constant, explicitly commented "keep in sync with pr-scope-check.ps1") and the
PowerShell entrypoint. The two implementations must not drift: derive both from a
single canonical definition, or add a test that fails when they diverge. Do not
fix one and leave the other.

## Files in scope

- `scripts/**` — the scope-guard entrypoints and their tests (`pr-scope-check.*`).
- `plugins/ao-scope-guard/**` and `plugins/_shared/**` — only if the link/marker
  parsing or path classification needs to move to a shared, single-source helper.
- `.github/workflows/**` — the scope-guard workflow, if the spec-only branch
  needs different job wiring.
- `docs/issues_drafts/43-spec-only-scope-guard-docs-prs.md` (new) — this spec.
- `.claude/skills/publish-issue-draft/SKILL.md` and
  `.cursor/skills/publish-issue-draft/SKILL.md` — re-point batch/full-publish at
  the spec-only path and drop the snapshot/`Closes`/reopen steps once available.
- `.claude/skills/direct-fix-checklist/SKILL.md` and its `.cursor` mirror — only
  to clarify that the `Closes #N` requirement applies to **implementation**
  direct PRs, not spec-only docs PRs.

## Files out of scope

- `vendor/**`, `packages/core/**`, `.ao/**`.
- Any implementation-PR behaviour: closing-keyword requirement, snapshot
  requirement, denylist/allowed-roots validation for non-spec PRs.
- `agent-orchestrator.yaml` / `.example` and reactions — this is a CI contract
  change, not a wiring change.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

```allowed-roots
scripts/**
plugins/ao-scope-guard/**
plugins/_shared/**
.github/workflows/**
docs/**
.claude/skills/**
.cursor/skills/**
```

## Acceptance criteria

1. A PR whose diff is confined to the spec-docs allowlist, carrying the spec-only
   signal and a non-closing issue reference, **passes** scope guard with **no**
   committed declaration snapshot for that issue.
2. Merging such a PR leaves the referenced implementation issue **open** (no
   auto-close, therefore no reopen step).
3. A PR carrying the spec-only signal but touching at least one path outside the
   spec-docs allowlist **fails** scope guard with a clear reason.
4. An implementation PR (no spec-only signal) still **requires** both a closing
   reference and a committed snapshot, and still fails today's reasons
   (`missing_issue_link`, `missing_snapshot`, `scope_violation`) when either is
   absent — i.e. the existing test matrix for implementation PRs still passes.
5. The closing-keyword recognition (and any added non-closing reference parsing)
   produces identical results from the TypeScript and PowerShell entrypoints,
   proven by a test that fails if the two definitions drift.
6. `publish-issue-draft` (both skill copies) describes the spec-only publish path
   without referencing a declaration snapshot, `Closes #N`, or a reopen step for
   docs-only drafts; the "until that lands" caveat is removed.
7. The spec-only signal form and the spec-docs allowlist are documented in one
   canonical location that a contributor opening a docs PR will find.

## Upgrade-safety check

- No edits to `packages/core/**`, `vendor/**`, or `.ao/**`.
- No new repository secrets; no new GitHub Actions permissions beyond what the
  scope-guard workflow already holds.
- No change to AO orchestration wiring (`agent-orchestrator.yaml`, reactions).
- The spec-only branch must not weaken denylist enforcement for implementation
  PRs.

## Verification

- Unit/contract tests in `scripts/pr-scope-check.test.ts` (and any shared-helper
  test) cover: spec-only pass without snapshot (criterion 1); spec-only with an
  out-of-allowlist path fails (criterion 3); implementation PR without closing
  ref or without snapshot still fails (criterion 4).
- A cross-implementation test demonstrates TS and PowerShell agree on the
  reference-keyword decision for a shared fixture set (criterion 5).
- A manual or fixtured end-to-end check shows a spec-only PR merging without the
  linked issue transitioning to CLOSED (criterion 2).
- `./scripts/verify.ps1`, `./scripts/test-all.ps1`, and the scope-guard workflow
  are green on the PR.
- Grep confirms the two skill copies no longer instruct snapshot/`Closes`/reopen
  for docs-only drafts (criterion 6).
