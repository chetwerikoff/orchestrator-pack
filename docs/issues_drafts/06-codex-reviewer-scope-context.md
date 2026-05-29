# Codex PR reviewer — integrate scope context

GitHub Issue: #9

## Prerequisite

Issue #3 — Architecture decisions (file `docs/issues_drafts/00-architecture-decisions.md`), #6 (CI PR diff validator), and #8 (ledger
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

- `prompts/codex_review_prompt.md` (new) — shared reviewer prompt template referencing scope, required finding format, and the `NO_FINDINGS` clean-review contract
- `plugins/ao-codex-pr-reviewer/bin/review.{ts,ps1}` (new) — reviewer wrapper invoked by AO via `ao review run --command`; calls `codex exec review`, parses output, filters `NO_FINDINGS`, emits structured findings
- `plugins/ao-codex-pr-reviewer/README.md` — append dual-path scope-context behavior and the wrapper invocation contract
- `.github/workflows/codex-pr-review.yml` — optional path: inject scope context, structured finding requirements, and the `NO_FINDINGS` skip in the PR-comment step
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
- **Clean-review contract (`NO_FINDINGS` token):**
  - The prompt MUST instruct Codex: when no concrete bugs, contract violations,
    or scope violations are identified, emit the single token `NO_FINDINGS` on
    its own line as the entire response body. No prose narration such as
    "No concrete bugs were identified" — that text is forbidden.
  - The reviewer wrapper (`plugins/ao-codex-pr-reviewer/bin/review.*`) MUST
    treat trimmed stdout **exactly equal to** `NO_FINDINGS` as **zero findings**.
    No finding record is created, written to disk, or surfaced to AO or to the
    GitHub Actions comment step.
  - **Empty stdout is NOT a clean review.** If trimmed stdout is empty while
    Codex exited 0, the wrapper MUST exit non-zero with a clear log line
    (`reviewer produced empty output — refusing to mark run as clean`).
    Reason: empty output indicates a swallowed payload, a wrapper bug, or a
    CLI/model regression — not an absence of issues. Silent acceptance would
    let a broken reviewer masquerade as a green review.
  - On `NO_FINDINGS`, the local AO review run still completes normally
    (`findingCount: 0`, `status: completed`). The GitHub Actions path posts a
    short comment `## Codex Review — no findings` instead of dumping reviewer
    prose.
  - Rationale: observed during the #11 review cycle (2026-05-27) — AO 0.9.x
    wraps any non-empty reviewer stdout as a `severity: warning` finding,
    so "no bugs" narration becomes noise that gets routed to the worker
    via `reactions.changes-requested` and burns tokens on a non-action.
- Codex auth flow for the optional GitHub Actions path remains unchanged
  (`CODEX_AUTH_JSON` when that path is used).
- Local AO path inherits Codex CLI auth from the user's environment
  (`codex login` state); no repository secret required.
- No additional repository secrets introduced.
- No changes to AO core / `packages/core/**`: the `NO_FINDINGS` filter lives
  in the plugin-owned wrapper, not in AO runtime.

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
- **`NO_FINDINGS` round-trip:**
  - Synthetic fixture where Codex returns exactly `NO_FINDINGS` → reviewer
    wrapper writes zero finding records; `ao review list` shows
    `findingCount: 0, openFindingCount: 0` for the run.
  - Synthetic fixture where Codex returns prose like "No concrete bugs
    were identified" (legacy/regression case) → wrapper rejects the
    output with a non-zero exit and a clear log line; AO marks the run
    as `failed`, not as a warning-finding. This prevents silent regressions
    if a future model drifts from the contract.
  - Synthetic fixture where Codex exits 0 with empty stdout → wrapper
    rejects the run with a non-zero exit and the
    `reviewer produced empty output` log line; AO marks the run as
    `failed`. Empty output must not be silently treated as a clean review.
