# Codex PR reviewer — integrate scope context

## Prerequisite

Issue #3 — Architecture decisions, #6 (CI PR diff validator), and #8 (ledger
event schema) must be merged. This issue reuses the same snapshot path
(`docs/declarations/{issue_number}.{iteration_id}.json`), issue-parsing helper
from `_shared`, and structured finding format from #3.F.

## Goal

Pass active scope from ao-task-declaration into Codex review across both
supported review paths so the reviewer can flag out-of-scope changes in
addition to code-quality findings.

## Binding surface

Dual path, shared contract:

1. **Primary:** AO local built-in Codex review (`codex exec review`) with
   findings surfaced in the AO dashboard and returned to workers through AO
   reactions.
2. **Optional:** reusable GitHub Actions Codex review workflow for PR comments
   and external visibility.

Both paths use the same prompt template, scope context, and structured finding
format. GitHub Actions review must not define an independent schema.

## Files in scope

- `prompts/codex_review_prompt.md` (new) — shared reviewer prompt template referencing scope and required finding format
- `plugins/ao-codex-pr-reviewer/README.md` — append dual-path scope-context behavior
- `.github/workflows/codex-pr-review.yml` — optional path: inject scope context and structured finding requirements
- `docs/issues_drafts/06-codex-reviewer-scope-context.md` — this spec

## Files out of scope

- Codex CLI internals
- AO core, vendor
- Other plugin directories

## Denylist

- `vendor/**`
- `packages/core/**`
- `.ao/**`

## Acceptance criteria

- Local AO review and GitHub Actions review both consume the same
  `prompts/codex_review_prompt.md` contract.
- Review context includes:
  - PR diff;
  - issue denylist and `allowed_roots`;
  - snapshot `declared_paths` and `declared_globs`;
  - the common structured finding format from #3.F.
- Review output emits findings with mandatory `type`, `code`, `severity`,
  `path`, `summary`, and `source` fields.
- Review output can include human-readable markers such as `[scope-violation]`,
  but machine identity comes from `(type, code, normalized path)` and the
  derived signature from #3.F.
- Scope violations are flagged distinctly from code-quality findings.
- Backward-compatible behavior: when neither issue body fences nor snapshot
  exist, the scope section is omitted from the prompt and the review output
  includes a non-blocking warning finding.
- Codex auth flow for the optional GitHub Actions path remains unchanged
  (`CODEX_AUTH_JSON` when that path is used).
- No additional repository secrets introduced.

## Upgrade-safety check

- No AO YAML or core changes.
- Codex CLI invocation signature unchanged unless verified by local `codex --help`.
- GitHub Actions path remains optional and reusable from target repositories.

## Verification

- Local AO Codex review with mismatched scope produces a blocking
  `scope-violation` finding.
- Optional GitHub Actions review with mismatched scope produces the same finding
  structure in a PR comment.
- Matching scope produces only code findings or none.
- Existing reusable workflow wiring still resolves when the optional path is enabled.
