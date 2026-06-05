# Skill-markdown-only PRs need no issue, signal, or snapshot

GitHub Issue: #161

## Prerequisite

`docs/issues_drafts/56-spec-only-allowlist-skills.md` (GitHub #159, shipped via
PR #160) — admitted skill markdown into the spec-only allowlist. This issue
completes it: #159 widened the allowed paths but a skill PR still inherited the
spec-only ceremony (the `<!-- pr-type: spec-only -->` signal and a `Refs #N`
reference). The goal is skill edits with **zero** issue/queue ceremony.

## Goal

A PR whose every changed path is **agent skill instruction markdown** passes
scope guard with no declaration snapshot, **no issue reference** (closing or
non-closing), and **no spec-only signal**. Editing a skill becomes "open a PR
that touches only skill markdown" — no GitHub Issue is filed and none is linked.
The behaviour-affecting safety gates stay in force.

## Binding surface

Introduce a third recognised PR shape, detected **purely from the diff** (not
from any PR-body marker):

- **Skill-doc PR (new):** every changed path matches the skill-markdown globs
  (today `.claude/skills/**/*.md` canonical + `.cursor/skills/**/*.md`
  pointers). It passes scope guard with **none** of: declaration snapshot,
  issue reference, spec-only signal. Its absence must never be a failure reason
  for this shape.
- Detection is **content-based and automatic** — the author adds no marker. A
  skill-doc PR is recognised because of what it touches, not what it declares.
- The shape is **conjunctive**: it applies only when *every* changed path is
  skill markdown. If any path is outside the skill-markdown globs — a
  non-markdown file under a skill directory, a docs draft, code, workflows — the
  PR does **not** qualify as a skill-doc PR and falls through to the **existing**
  classification unchanged (spec-only when signalled, otherwise implementation).
  No existing PR shape changes behaviour.

Safety (preserve in implementation):

1. Conjunctive boundary — a skill-doc PR cannot carry code or other surfaces.
2. Markdown-only under skill dirs — any non-markdown asset there forces the
   implementation path.
3. The skill-pointer drift check stays an independent, required gate and runs on
   skill-doc PRs.
4. No worker and no linked issue → snapshot and issue-fence validation are
   redundant; the diff-content boundary plus PR review bound scope.

## Files in scope

- `scripts/**` — scope-guard contract, entrypoints, and tests
  (`pr-scope-contract.*`, `pr-scope-check.*`).
- `docs/repository_policy.md` — canonical documentation of the skill-doc shape.
- `docs/issues_drafts/57-skill-only-pr-no-ceremony.md` (new) — this spec.

## Files out of scope

- `vendor/**`, `packages/core/**`, `.ao/**`.
- The skill-pointer generator and drift checker — unchanged, still required.
- `.github/workflows/**` — no job wiring change.
- Existing spec-only (docs-draft) and implementation-PR behaviour, except that a
  100%-skill-markdown diff now routes to the new shape instead of demanding a
  signal + reference.

## Denylist

```denylist
# issue 57 — skill-only PR no-ceremony shape
vendor/**
packages/core/**
.ao/**
```

```allowed-roots
scripts/**
docs/**
```

## Acceptance criteria

1. A PR whose every changed path matches the skill-markdown globs passes scope
   guard with **no** snapshot, **no** issue reference, and **no** spec-only
   signal; merging it closes no issue.
2. A PR that includes a non-markdown file under a skill directory does **not**
   qualify as a skill-doc PR (falls through to existing handling).
3. A PR mixing skill markdown with **spec-docs markdown** (all paths within the
   union) **does** get no-ceremony. A PR that includes code, workflows, or any
   path outside the union does **not** qualify; its existing behaviour is unchanged.
   (Extended by #165 / `59-spec-docs-only-pr-no-ceremony.md`.)
4. The skill-pointer drift check still runs on a skill-doc PR and **fails** a
   canonical/pointer mismatch or a hand-edited pointer.
5. The prior spec-only (docs-draft) and implementation-PR test matrices are
   unchanged and still pass.
6. The skill-doc PR shape — its diff-content trigger, the "no
   issue/signal/snapshot" rule, and the markdown-only boundary — is documented
   in one canonical location (`docs/repository_policy.md`).

## Upgrade-safety check

- No edits to `packages/core/**`, `vendor/**`, or `.ao/**`.
- No new repository secrets and no new GitHub Actions permissions.
- No change to AO orchestration wiring (`agent-orchestrator.yaml`, reactions).
- The conjunctive boundary is preserved — the no-ceremony shape never admits a
  PR that touches anything beyond skill markdown.
- Implementation-PR and docs-draft spec-only enforcement (snapshot, references,
  denylist) is unchanged for non-qualifying PRs.
- The skill-pointer drift check remains independent and required.

## Verification

- Unit/contract tests alongside the existing scope-guard suite cover: a
  skill-markdown-only PR passes with no snapshot/reference/signal (criterion 1);
  a non-markdown file under a skill directory does not qualify (criterion 2); a
  mixed skill+docs and skill+code PR behaves as before (criterion 3); the prior
  spec-only and implementation matrices still pass (criterion 5).
- A fixtured check shows the drift check still failing a stale pointer on an
  otherwise-qualifying skill-doc PR (criterion 4).
- `pwsh -NoProfile -File scripts/verify.ps1`,
  `pwsh -NoProfile -File scripts/test-all.ps1`, and the scope-guard workflow are
  green on the PR.
- Grep confirms `docs/repository_policy.md` documents the skill-doc shape
  (criterion 6).
