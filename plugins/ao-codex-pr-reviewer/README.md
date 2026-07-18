# AO Codex PR Reviewer

Codex executor used by the pack-owned PR review runner.

Complete invocation, binding, delivery, switching, recovery, and merge contract:
[`docs/pack-review-runbook.md`](../../docs/pack-review-runbook.md).

## Executor boundary

```text
scripts/pack-review-runner.ts
  -> scripts/invoke-pack-review.ps1
  -> scripts/run-pack-review.ps1
  -> plugins/ao-codex-pr-reviewer/bin/review.ts
  -> codex exec review --json
```

The runner and prompt come from the trusted pack checkout. The detached PR worktree is
untrusted review input. Operators start through the pack runner, not this plugin directly.

AO review surfaces remain available upstream in AO 0.10.3 but are retired by this pack;
they are not fallback or dual-write paths.

## Codex contract

- GitHub Issues provide the task/scope contract.
- The shared prompt is `prompts/codex_review_prompt.md`.
- Native review-mode JSONL is parsed into stable structured findings.
- A successful wrapper exit emits one non-empty JSON payload with `verdict`,
  `findingCount`, and `findings`.
- `findingCount` must equal the findings-array length.
- Empty, malformed, contradictory, timeout, or non-zero-exit output is not clean.
- The default local model marker is `gpt-5.5` unless current configuration changes it.
- Slow exhaustive testing belongs to CI; the reviewer follows its bounded command policy.

Optional CI-hosted Codex review may reuse the same prompt/parser/schema, but must not
define a second local review contract.

## Non-goals

- no core patch;
- no AO reviewer-session fallback;
- no automatic merge;
- no secrets in the repository.

Contract markers: Codex, gpt-5.5, PR review, GitHub Issues, no core patch.
