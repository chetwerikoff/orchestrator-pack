# Spec-only allowlist for skill instruction markdown

GitHub Issue: #159

## Prerequisite

Both shipped, neither blocking:

- `docs/issues_drafts/43-spec-only-scope-guard-docs-prs.md` (GitHub #121) — spec-only
  PR shape and runtime spec-docs allowlist this issue widens.
- `docs/issues_drafts/55-skills-single-source-mirror.md` (GitHub #156) — canonical skill
  + generated pointer model and skill-pointer drift check (independent gate).

## Goal

Let architect-direct changes confined to **agent skill instruction markdown** land on
`main` through the existing **spec-only** docs PR path (`<!-- pr-type: spec-only -->`,
non-closing `Refs #N`, no declaration snapshot) instead of full implementation-PR
machinery.

## Binding surface

- Reuse the spec-only PR shape unchanged; widen the runtime spec-docs allowlist only.
- Qualifying paths: **markdown only** under `.claude/skills/**` (canonical) and
  `.cursor/skills/**` (generated pointers). Non-markdown under skill directories stays on
  the implementation path.
- Allowlist stays **conjunctive** — every changed path must match; mixing skill markdown
  with code or other surfaces fails.

Safety (preserve in implementation):

1. Conjunctive allowlist — no code smuggling.
2. Markdown-only boundary under skill dirs.
3. Skill-pointer drift check still required on spec-only skill PRs.
4. No worker → declaration snapshot redundant; allowlist + review bound scope.

## Files in scope

- `scripts/**` — allowlist definition and scope-guard entrypoints/tests.
- `docs/repository_policy.md` — canonical documentation.
- `docs/issues_drafts/56-spec-only-allowlist-skills.md` — this spec.

## Acceptance criteria

1. Skill-markdown-only spec-only PR passes without snapshot; issue stays open.
2. Spec-only PR mixing skill markdown with out-of-allowlist path fails.
3. Non-markdown under a skill directory does not qualify.
4. Skill-pointer drift check still fails mismatch on spec-only skill PRs.
5. Prior docs-draft and implementation-PR matrix unchanged.
6. Single canonical allowlist (or drift test if mirrored).
7. `docs/repository_policy.md` documents allowlist and markdown-only boundary.
