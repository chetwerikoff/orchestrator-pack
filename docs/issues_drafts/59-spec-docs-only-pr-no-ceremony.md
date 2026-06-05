# Spec-docs-markdown-only PRs need no issue, signal, or snapshot

GitHub Issue: #165

## Prerequisite

`docs/issues_drafts/57-skill-only-pr-no-ceremony.md` (GitHub #161) — introduces
the diff-content-detected, no-ceremony PR shape for skill markdown. This issue
extends that same shape to **spec-docs markdown** (drafts, the queue index, and
the architecture/decision docs) so authoring or revising a spec needs no issue
reference, no spec-only signal, and no declaration snapshot — the same treatment
skills get. It shares the scope-guard contract surface with #161; the two should
land coherently (this issue assumes #161's detection machinery exists).

## Goal

A PR whose every changed path is **spec-docs markdown** passes scope guard with
no declaration snapshot, **no issue reference** (closing or non-closing), and
**no spec-only signal**. Editing or adding a draft becomes "open a PR that
touches only spec-docs markdown" — the same zero-ceremony flow skills already
have. The behaviour-affecting safety gates stay in force. Today such a PR still
inherits spec-only ceremony (the `<!-- pr-type: spec-only -->` signal plus a
`Refs #N` reference); for a pure docs-draft change that reference is redundant
because the draft *is* the spec and no worker reads a separate fence.

## Binding surface

Extend the diff-content no-ceremony detection (introduced in #161) so it
recognises spec-docs markdown in addition to skill markdown:

- **Spec-docs set.** The spec-docs markdown surface is the existing spec-only
  docs allowlist restricted to markdown: today the draft tree, the queue index,
  the architecture doc, and the architecture-decisions doc. (The implementation
  reads the canonical allowlist; this draft does not pin individual paths beyond
  naming the surface.)
- **No-ceremony set = union.** A PR qualifies for the no-ceremony shape when
  **every** changed path is markdown within the **union** of the skill-markdown
  surface (#161) and the spec-docs surface above. Such a PR passes scope guard
  with **none** of: declaration snapshot, issue reference, spec-only signal. The
  absence of any of those must never be a failure reason for this shape.
- **Detection is content-based and automatic** — the author adds no marker. A
  PR is recognised by what it touches, not what it declares.
- **Conjunctive boundary.** The shape applies only when every changed path is in
  the union set. If any path is outside it — code, workflows, a non-markdown
  asset, `agent-orchestrator.yaml.example`, `docs/declarations/**` — the PR does
  **not** qualify and falls through to the **existing** classification unchanged
  (spec-only when signalled, otherwise implementation).
- **Supersedes one #161 clause.** #161's acceptance treated a skill-markdown +
  docs-draft mix as *not* no-ceremony (falling through to spec-only). With this
  issue, a PR whose paths are all within the union (any mix of skill markdown
  and spec-docs markdown) **does** get no-ceremony. No other #161 behaviour
  changes. (Cross-draft note: #161's draft/issue body is updated in the same
  change set so the two specs do not contradict.)

Safety (preserve in implementation):

1. Conjunctive boundary — a no-ceremony PR cannot carry code, config, workflows,
   declarations, or any non-markdown surface.
2. Markdown-only — only `.md` paths within the named surfaces qualify; a
   non-markdown file forces the implementation path.
3. No worker and no linked issue → snapshot and issue-fence validation are
   redundant for this shape; the diff-content boundary plus PR review bound
   scope. (Same rationale as #161.)
4. Implementation-PR and (signalled) spec-only enforcement is unchanged for any
   PR that does not fully qualify.

## Files in scope

- `scripts/**` — the scope-guard contract, entrypoints, and tests (the same
  scope-guard sources #161 touches).
- `docs/repository_policy.md` — canonical documentation of the extended
  no-ceremony shape.
- `docs/issues_drafts/57-skill-only-pr-no-ceremony.md` — update the one
  superseded clause (cross-draft consistency).
- `docs/issues_drafts/59-spec-docs-only-pr-no-ceremony.md` (new) — this spec.

## Files out of scope

- `vendor/**`, `packages/core/**`, `.ao/**`.
- `.github/workflows/**` — no job wiring change.
- The skill-pointer generator and drift checker — unchanged, still required.
- Implementation-PR behaviour and signalled spec-only behaviour, except that a
  fully-qualifying markdown diff now routes to the no-ceremony shape instead of
  demanding a signal + reference.

## Denylist

```denylist
# issue 165 — spec-docs markdown no-ceremony (extends #161 machinery)
vendor/**
packages/core/**
.ao/**
.github/workflows/**
```

```allowed-roots
scripts/**
docs/**
```

## Acceptance criteria

1. A PR whose every changed path is spec-docs markdown passes scope guard with
   **no** snapshot, **no** issue reference, and **no** spec-only signal; merging
   it closes no issue.
2. A PR whose paths are a mix of skill markdown and spec-docs markdown (all
   within the union set) **also** passes with no ceremony.
3. A PR that includes any non-markdown path, or a markdown path outside the
   union set (e.g. `README.md`, a workflow, `agent-orchestrator.yaml.example`),
   does **not** qualify and falls through to existing handling unchanged.
4. The previously-required spec-only (signalled) and implementation-PR test
   matrices still pass for PRs that do not fully qualify.
5. #161's skill-only behaviour is unchanged except the documented mix clause;
   the skill-pointer drift check still runs and still fails a stale pointer on
   an otherwise-qualifying PR.
6. The extended no-ceremony shape — its diff-content trigger, the union
   surface, the "no issue/signal/snapshot" rule, and the markdown-only boundary
   — is documented in one canonical location (`docs/repository_policy.md`), and
   `57-skill-only-pr-no-ceremony.md` no longer contradicts it.

## Upgrade-safety check

- No edits to `packages/core/**`, `vendor/**`, or `.ao/**`.
- No new repository secrets and no new GitHub Actions permissions.
- No change to AO orchestration wiring (`agent-orchestrator.yaml`, reactions).
- The conjunctive boundary is preserved — the no-ceremony shape never admits a
  PR that touches anything beyond the markdown union surface.
- Implementation-PR and signalled spec-only enforcement (snapshot, references,
  denylist) is unchanged for non-qualifying PRs.

## Verification

- Unit/contract tests alongside the existing scope-guard suite cover: a
  spec-docs-markdown-only PR passes with no snapshot/reference/signal
  (criterion 1); a skill+spec-docs markdown mix passes (criterion 2); a PR with
  a non-markdown path or an out-of-union markdown path falls through
  (criterion 3); the prior signalled-spec-only and implementation matrices still
  pass (criterion 4).
- A fixtured check shows the skill-pointer drift check still failing a stale
  pointer on an otherwise-qualifying PR (criterion 5).
- `pwsh -NoProfile -File scripts/verify.ps1`,
  `pwsh -NoProfile -File scripts/test-all.ps1`, and the scope-guard workflow are
  green on the PR.
- Grep confirms `docs/repository_policy.md` documents the extended shape and
  `57-skill-only-pr-no-ceremony.md` reflects the superseded clause (criterion 6).
