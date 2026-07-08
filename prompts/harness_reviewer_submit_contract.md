# Harness reviewer submit contract (Issue #658) — supplemental

This file supplements `prompts/codex_review_prompt.md` for AO 0.10 **codex harness**
reviewer sessions. It does **not** replace the trusted-root prompt or mapper chain.

## Submit body shape

Submit mapper JSON, not prose. Finding titles carry `[P0]`–`[P3]` (scope findings
may also include `[scope-violation]` but still require the priority prefix), and
each finding body carries `severity: blocking|non-blocking`.

After AO auto-submits the harness review, the pack validates `latestRun.body` in
the #669 delivery poll loop. Valid bodies are mapper findings JSON or the #663
clean terminal verdict (`{"verdict":"clean","findingCount":0,"findings":[]}`).
Empty bodies, `LGTM`, and prose `Finding:` / `BLOCKING:` bodies are rejected and
bounded-retriggered; delivered invalid bodies are superseded instead of accepted.

## Operator fallback

When the kill-switch is enabled (`PACK_HARNESS_PN_CONTENT_SHAPE_DISABLED=1`), the
post-submit gate escalates. It must not silently accept prose or empty content.

## Claude harness after supersede

AO 0.10.2 cannot reliably relaunch Claude harness after supersede — project config must
use `reviewers:[{harness:codex}]`. Unset `reviewers` defaults to `claude-code` (failure
class); pack trigger entry refuses batch trigger until codex is configured.
