# Codex reviewer JSONL verdict source

GitHub Issue: #127

## Prerequisite

Related prior contract, not blocking: `docs/issues_drafts/06-codex-reviewer-scope-context.md` (GitHub #9) defines the original Codex reviewer scope and `NO_FINDINGS` clean-review contract.

## Goal

Make Codex review-mode machine output the primary source of truth for clean/finding verdicts so AO no longer marks a clean review as `failed` merely because `--output-last-message` contains natural-language prose instead of the exact `NO_FINDINGS` token.

## Binding surface

The reviewer wrapper must stay on `codex exec review` and must treat Codex review-mode events as the durable verdict channel when available. The last-message file remains a fallback/diagnostic channel, not the primary authority for clean reviews in JSONL-enabled runs.

This issue updates the prior clean-review contract from prose/token-first to event-first:

- Codex `--json` stdout captures the parent thread/session id and ordinary public
  events, but is not assumed to contain the review-mode verdict payload.
- The Codex persisted session JSONL under `CODEX_HOME` / `~/.codex/sessions/**` is
  parsed for `event_msg.payload.type == "exited_review_mode"` with
  `payload.review_output`; that payload determines clean vs findings when present
  and valid.
- Exact `NO_FINDINGS` in the final message remains supported as fallback behavior for older/non-JSON-compatible runs.
- Legacy clean prose alone must not be accepted as clean. Prose may help diagnostics, but it is not a verdict source unless corroborated by valid review-mode output.
- Pack-added scope warnings still use the existing behavior when authoritative scope context is unavailable.

5-mode framework summary for this failure-response issue:

- Real problem: review reliability, not model wording. Success is AO clean/finding state matching Codex review-mode machine verdict.
- Assumption destroyed: `--output-last-message` is not a reliable machine contract for review mode.
- Main cost driver: repeated failed clean reviews and manual diagnosis; tests and fixtures should prevent recurrence.
- Risk control: fail closed on missing/malformed machine output and preserve diagnostic snippets.
- Executor choice: bounded plugin/test/docs implementation with Codex review as the safety gate.

## Files in scope

- `plugins/ao-codex-pr-reviewer/lib/**` — reviewer invocation, channel capture, review-event parsing, and verdict selection.
- `plugins/ao-codex-pr-reviewer/tests/**` — regression fixtures and unit tests for JSONL clean/findings/fallback behavior.
- `plugins/ao-codex-pr-reviewer/README.md` — update operator-facing wrapper contract.
- `docs/issues_drafts/44-codex-review-jsonl-verdict-source.md` (new) — this spec.
- `docs/issue_queue_index.md` — register this draft to GitHub #127.
- `docs/issues_drafts/06-codex-reviewer-scope-context.md` — update the #9-descended contract so it no longer implies last-message is the only clean channel.
- `docs/issues_drafts/00-architecture-decisions.md` and `docs/architecture.md` — only if needed to record the event-first review decision.

## Files out of scope

- `vendor/**`, `packages/core/**`, `.ao/**`.
- Replacing `codex exec review` with another reviewer command.
- Retry-until-clean behavior.
- Regex-only acceptance of clean prose.
- Switching the default reviewer to Claude or another model.
- New repository secrets or Codex authentication changes.
- AO core review-status semantics.

## Denylist

```denylist
# issue 127 — codex review JSONL verdict source
vendor/**
packages/core/**
.ao/**
```

```allowed-roots
plugins/ao-codex-pr-reviewer/**
docs/issues_drafts/44-codex-review-jsonl-verdict-source.md
docs/issue_queue_index.md
docs/issues_drafts/06-codex-reviewer-scope-context.md
docs/issues_drafts/00-architecture-decisions.md
docs/architecture.md
```

## Acceptance criteria

- The wrapper invocation requests Codex JSONL output for live `codex exec review` runs while preserving `codex exec review` as the reviewer command.
- The wrapper captures Codex process JSONL stdout, final last-message content, and stderr as distinguishable channels.
- Valid review-mode output with no findings and a clean/correct verdict maps to the existing clean AO effect: wrapper exit `0`, empty AO stdout when authoritative scope context is available, and no Codex-derived structured findings.
- If authoritative scope context is unavailable, the same clean JSONL verdict still exits `0` but preserves the existing pack-added non-blocking scope warning finding.
- Valid review-mode output with findings maps those findings into the pack structured finding payload emitted to AO.
- Exact `NO_FINDINGS` final-message behavior remains supported when no valid review-mode output is available.
- Valid legacy structured final-message/stdout findings (`{"findings":[...]}` or existing accepted wrapper forms) remain supported as fallback when no valid review-mode output is available, and those findings are still surfaced to AO.
- Legacy clean prose without valid review-mode output still fails closed and is not treated as clean.
- Missing, malformed, unsupported, or internally contradictory review-mode output produces clear diagnostic log lines rather than silent success. Contradictory cases include empty findings with a non-clean/incorrect overall verdict, and non-empty findings with a clean/correct overall verdict.
- Parse-failure diagnostics include a short snippet of the final message or process output so operators can distinguish machine-output mismatch from a true Codex process failure.
- Tests cover JSONL invocation arguments, JSONL clean, JSONL findings, malformed JSONL with prose, contradictory review-mode verdicts, exact `NO_FINDINGS` fallback, legacy structured-findings fallback, and prose-only fail-closed behavior.
- The reviewer README and the #9-descended draft contract describe event-first verdict selection and last-message fallback/diagnostic behavior.

## Upgrade-safety check

- No edits to AO core, vendored AO source, or generated runtime state.
- No new secrets or authentication paths.
- No unsupported `agent-orchestrator.yaml` reviewer fields.
- `codex exec review` remains the reviewer command.
- The implementation fails closed when the Codex JSONL schema is missing or incompatible, unless the existing exact `NO_FINDINGS` fallback applies.

## Verification

Run the focused reviewer tests:

```bash
npm test -- plugins/ao-codex-pr-reviewer/tests/review.test.ts
```

Run repository checks before merging:

```powershell
.\scripts\verify.ps1
.\scripts\check-reusable.ps1
```

For manual diagnosis, run or fixture a Codex review where JSONL `review_output` is clean while the final last-message contains prose; the wrapper must report a clean AO result rather than `failed`.
