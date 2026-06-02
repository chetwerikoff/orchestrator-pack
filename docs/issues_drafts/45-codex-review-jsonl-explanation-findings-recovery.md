# Codex reviewer: split-channel JSONL explanation findings recovery

GitHub Issue: #135

## Prerequisite

- `docs/issues_drafts/44-codex-review-jsonl-verdict-source.md` (GitHub #127) — closed;
  JSONL-first verdict selection on `main`.

## Goal

When Codex review-mode JSONL presents only the named split-empty recovery shapes,
the reviewer wrapper delivers findings or a clean verdict to AO instead of failing
closed. All JSONL-first fail-closed invariants from #127 remain unchanged for every
other case.

## Binding surface

Failure-response contract extension to #127. Shape-gated recovery for:

- **Sub-shape A:** pack-format `{"findings":[…]}` in `overall_explanation` and/or
  last message.
- **Sub-shape B:** exact `NO_FINDINGS` (trimmed, no extra prose) in those channels.

Forbidden: prose `[P1]` acceptance, broad JSONL-error → lastMessage fallback, recovery
on contradictory JSONL.

## Acceptance criteria

See GitHub #135 (implementation tracked there).

## Verification

```bash
npm test -- plugins/ao-codex-pr-reviewer/tests/review.test.ts
```
