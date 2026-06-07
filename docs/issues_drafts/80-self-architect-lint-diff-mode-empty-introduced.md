# Self-architect lint in diff mode must treat an empty introduced-set as clean, not fall back to whole-repo scanning

GitHub Issue: #242

## Prerequisite

- None blocking. Related to `docs/issues_drafts/04-self-architect-lint.md` (the
  lint that this issue corrects) and the existing CI skip for markdown-only PRs in
  `.github/workflows/scope-guard.yml`.

## Goal

When the self-architect lint runs in **diff mode** (a base/head diff is supplied,
as CI does for every pull request), and none of the PR's changed paths fall inside
the lint's scannable scope (they are all outside `scanPaths` or inside
`excludePaths`), the lint must report **zero findings** for that PR — because the
PR introduced nothing in scannable scope, there is nothing for it to flag. Today,
that same "nothing introduced in scope" condition is mistaken for "no diff context
at all," so the lint silently widens to a **whole-repository** duplicate scan and
fails CI on pre-existing debt the PR never touched. A PR whose only changes are
`CLAUDE.md` (outside `scanPaths`) plus its declaration snapshot (inside
`excludePaths`) cannot get a green lint, even though it introduced no lint-relevant
content. This issue makes diff-mode lint scope strictly to what the diff introduced.

```behavior-kind
record-only
```

The lint's success path is emitting a findings report (pure observability over the
diff); it takes no runtime action. This issue only changes **which** findings that
report contains in one scenario — it does not add a side effect.

## Binding surface

This issue commits the self-architect lint to the following diff-mode invariants
(the term "introduced set" = the PR's changed paths that survive the lint's
`scanPaths` / `excludePaths` filter):

- **Diff mode is distinguished from full-scan mode.** When the lint is invoked
  with an explicit base reference (the PR/diff invocation CI uses), it behaves as a
  scoped diff review. The pre-existing full-repository scan behavior (no base
  reference supplied) is unchanged.
- **Empty introduced-set in diff mode ⇒ clean.** When the introduced set is empty
  in diff mode, the lint emits no findings and exits success. It must **not** widen
  to a whole-repository duplicate/near-duplicate/paired-edit scan in that case.
- **Detection of genuinely introduced problems is preserved.** When the introduced
  set is **non-empty**, the lint still flags issues that the diff introduces
  (e.g. a new duplicate literal a changed file adds), exactly as before. The fix
  narrows only the empty-introduced case; it does not blanket-disable the lint or
  weaken detection on real changes.
- **No change to which paths are scannable.** `scanPaths` / `excludePaths`
  membership is not the subject of this issue; the fix is about how diff mode reacts
  when the filtered introduced set is empty, not about which paths pass the filter.
- **CI gating unchanged in shape.** The CI job still runs the lint in strict diff
  mode on pull requests; this issue only removes the spurious whole-repo failure for
  PRs that introduce nothing in scope. No new required check, no workflow gating
  redesign.

This is a CI/tooling correctness fix only — no worker-rule (`prompts/agent_rules.md`),
no live `agent-orchestrator.yaml`, no operator-facing surface, so no operator
adoption step.

### Root cause (5 Whys)

1. *Why did PR #241's lint fail?* It ran a whole-repository duplicate scan and hit
   pre-existing duplicate-literal debt.
2. *Why a whole-repository scan?* The lint's "scope to introduced files" guard was
   inactive, so it compared every scannable file in the repo.
3. *Why inactive?* That guard is keyed on the introduced set being non-empty; the
   introduced set was empty.
4. *Why empty?* The PR's only changed files were outside `scanPaths` (`CLAUDE.md`)
   and inside `excludePaths` (the declaration snapshot under `docs/declarations/**`).
5. *Why does empty-introduced widen to whole-repo instead of reporting nothing?*
   The lint conflates two distinct states — "no diff supplied → full scan" and
   "diff supplied but nothing scannable changed → clean" — into one code path.

Spec-level cure: in diff mode, an empty introduced set is a *clean* outcome, not a
reason to widen into full-repository scanning.

## Files in scope

- `scripts/lint-self-architect.ps1` — the lint runner (diff-mode vs full-scan
  behavior on an empty introduced set).
- `scripts/lint-self-architect.config.json` — only if the chosen fix needs a config
  flag; the planner decides whether config changes at all.
- Lint test/fixture surfaces under `tests/**` (the lint's existing PowerShell
  tests and any fixtures) — add coverage for the scenarios in Acceptance criteria.

## Files out of scope

- `.github/workflows/scope-guard.yml` — the workflow invocation is correct; do not
  paper over the gap by changing the CI gate or markdown-only classification.
- `CLAUDE.md`, `docs/declarations/**` — the surface that surfaced the bug, not its fix.
- `packages/core/**`, `vendor/**`, AO CLI behavior.
- The `scanPaths` / `excludePaths` membership lists themselves (not the subject;
  changing them would be a different, broader decision).

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

```allowed-roots
scripts/**
tests/**
```

## Acceptance criteria

1. **Empty introduced-set in diff mode is clean.** Running the lint in strict diff
   mode over a base/head pair whose changed paths are all outside `scanPaths` or
   inside `excludePaths` produces **zero findings** and a success exit code.
   Provable by a test/fixture: a diff touching only an out-of-scan path (and/or an
   excluded path) yields no findings.
2. **Genuine introduced duplicate is still flagged.** Running the lint in strict
   diff mode over a base/head pair where a changed, in-scope file introduces a
   duplicate literal still reports that finding with a failing exit code. Provable
   by a test/fixture that adds an in-scope duplicate and asserts it is flagged.
3. **Full-scan mode (no base reference) is unchanged.** Invoking the lint without a
   base reference still performs the repository-wide scan it does today. Provable by
   a test/fixture or by asserting existing full-scan behavior is retained.
4. **The CLAUDE.md-only PR class goes green.** A PR whose only diff is `CLAUDE.md`
   plus a `docs/declarations/**` snapshot passes the lint. Provable by a fixture
   mirroring that path set (no in-scope changed files) producing zero findings.

## Upgrade-safety check

- No edits to `packages/core/**` or `vendor/**`; no AO CLI flag assumptions; no new
  repo secrets.
- No new unsupported `agent-orchestrator.yaml` fields; no worker-rule or operator
  surface change.
- Behavior change is confined to the empty-introduced diff-mode branch; full-scan
  mode and real-diff detection are preserved (criteria 2 and 3 are regression
  guards).

## Verification

- Test run (criteria 1, 2, 3, 4): the lint's test suite covers empty-introduced
  diff mode (clean), non-empty introduced with a real duplicate (flagged), full-scan
  mode (unchanged), and the CLAUDE.md + declaration path set (clean).
- Manual reproduction (criterion 4): re-running the lint in strict diff mode against
  the PR that surfaced this bug (`CLAUDE.md` + `docs/declarations/**` only) reports
  zero findings instead of pre-existing whole-repo debt.
