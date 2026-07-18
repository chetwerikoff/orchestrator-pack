# AO Codex PR Reviewer

Contract and implementation notes for the Codex executor used by the pack-owned
PR-review runner.

Canonical operator workflow: [`docs/pack-review-runbook.md`](../../docs/pack-review-runbook.md).

## Boundaries

- GitHub Issues are the task source of truth.
- `scripts/pack-review-runner.ts` owns manual and automatic invocation.
- `scripts/invoke-pack-review.ps1` is the reviewer-agnostic subprocess entrypoint.
- `PACK_REVIEWER=codex|claude` chooses the executor.
- GitHub COMMENT is the visible review artifact.
- Exact-head required status `orchestrator-pack/pack-review` carries merge authority.
- The pack review-run store records operational state, durable verdict/findings,
  journal state, and independent delivery outcomes.
- AO does not spawn or store the live pack review.

Historical AO built-in review commands, session-review HTTP, and dashboard review
rows are retired for this project and must not be used as fallback paths.

## Reviewer time budget

- Effective hard budget defaults to **10 minutes**
  (`AO_CODEX_REVIEW_EFFECTIVE_BUDGET_MS`).
- Slow/full-suite commands are blocked by the pack command guard. CI owns exhaustive
  test execution.
- Timeout before a terminal verdict is a failed reviewer run, not a clean result.
- Repeated same-head timeout failures are bounded by review-start escalation policy.

## Live invocation

The runner creates a detached worktree at the exact PR head and invokes the trusted
pack entrypoint:

```text
scripts/pack-review-runner.ts
  -> scripts/invoke-pack-review.ps1
  -> scripts/run-pack-review.ps1
  -> plugins/ao-codex-pr-reviewer/bin/review.ts
  -> codex exec review --json
```

Manual starts use the runner, not the reviewer wrapper directly:

```bash
node --experimental-strip-types scripts/pack-review-runner.ts start \
  --session-id <worker-session-id>
```

Operational status:

```bash
node --experimental-strip-types scripts/pack-review-runner.ts list \
  --project-id orchestrator-pack
```

The adjacent `.js` files are NodeNext import bridges; operators invoke the
TypeScript entrypoint.

## Trusted-root and sandbox split

The runner, prompt, claim helper, reviewer entrypoint, and store implementation are
resolved from the trusted pack checkout. The PR worktree is only the review target.

Trusted local Codex execution requires an explicit `--source codex-local`, no CI
signal, and no `PR_REPO_ROOT`. That mode may use the workspace-write/network-capable
policy needed for `coworker`. Untrusted or CI contexts remain read-only.

Exfiltratable CI/GitHub tokens are removed from the Codex child environment. Codex
authentication uses its normal local auth store.

## Prompt and scope contract

Both local and optional GitHub Actions execution use:

- `prompts/codex_review_prompt.md`;
- linked-issue scope (`denylist`, optional `allowed_roots`);
- the active declaration snapshot when available;
- native review-mode JSONL output;
- the shared finding mapper and signatures.

The prompt is loaded from the pack checkout, never from the reviewed PR.

For diffs above the delegation floor, `coworker` may summarize the diff and map
acceptance criteria, but the main reviewer retains judgment and must independently
validate every candidate finding.

## Terminal stdout contract

Every successful wrapper exit emits non-empty terminal JSON:

```json
{
  "verdict": "clean",
  "findingCount": 0,
  "findings": []
}
```

or:

```json
{
  "verdict": "findings",
  "findingCount": 1,
  "findings": [
    {
      "severity": "error",
      "title": "...",
      "body": "...",
      "filePath": "path/to/file"
    }
  ]
}
```

`findingCount` must match the array length. Missing, malformed, contradictory, or
narration-only output fails closed.

### Verdict sources

1. Preferred: persisted `exited_review_mode.review_output` from Codex JSONL.
2. Bounded split-channel recovery when the native event shape permits it.
3. Last-message fallback only when native review-mode output is unavailable:
   exact `NO_FINDINGS` or one structured findings object.

The wrapper does not infer verdicts by scraping priority markers from free prose.

## Journal-first delivery

After the reviewer returns valid terminal JSON, the TypeScript runner:

1. persists the parsed verdict and findings;
2. posts/reconciles a GitHub COMMENT;
3. writes exact-head required status `orchestrator-pack/pack-review`;
4. notifies the linked worker session;
5. records each delivery outcome independently.

A delivery failure does not change a successful reviewer-process classification.
A later same-head start resumes missing journaled channels without rerunning Codex
or duplicating a completed COMMENT.

The GitHub COMMENT is presentation only. The required status is:

- `success` for clean or non-blocking-only results;
- `failure` for blocking findings;
- `error` for malformed terminal payloads;
- `pending` while the current-head verdict is not yet available.

## Finding mapping

Native findings are mapped to the pack schema with stable signatures and
repository-relative paths. Scope violations and security findings are always
material. Pure style preferences and unsupported speculation are suppressed.

When no authoritative scope can be resolved, the wrapper adds a non-blocking
`scope-context-unavailable` warning rather than inventing scope.

## Optional GitHub Actions path

`.github/workflows/codex-pr-review.yml` remains an optional CI executor for other
repositories. It uses the same prompt, scope, parser, and finding schema. It is not
the local pack-owned invocation path and must not define a second review contract.

## Reviewer selection

Inspect or change the selected local executor:

```powershell
pwsh -NoProfile -File scripts/show-pack-reviewer-status.ps1
pwsh -NoProfile -File scripts/set-pack-reviewer.ps1 \
  -Reviewer <codex|claude> \
  -RestartSupervisor
```

On supported Linux/WSL, restart the pack side-process supervisor so its children
inherit a changed process-scoped selector. Restarting AO does not adopt reviewer
selection because AO does not spawn the reviewer.

## Non-goals

- No core patch.
- No daemon reviewer-session fallback.
- No duplicate review schema for the optional CI path.
- No secrets in the repository.
- No automatic merge.

## Contract markers

- Reviewer: Codex CLI (default model `gpt-5.5`)
- Trigger: pack-owned exact-head PR review
- Verdict: durable pack record + GitHub required status
- Presentation: GitHub COMMENT
- Constraint: no core patch
