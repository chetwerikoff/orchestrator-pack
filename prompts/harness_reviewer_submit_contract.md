# Harness reviewer submit contract (Issue #658) — supplemental

This file supplements `prompts/codex_review_prompt.md` for AO 0.10 **codex harness**
reviewer sessions. It does **not** replace the trusted-root prompt or mapper chain.

## Before `ao review submit`

1. Resolve trusted pack root (`AO_TRUSTED_PACK_ROOT` or operator main worktree).
2. Run `scripts/harness-review-bridge.ps1` from that root with `-RunId` and `-TrustedBaseRoot`.
3. Confirm stdout JSON carries `[P0]`–`[P3]` on every finding title (scope findings may
   also include `[scope-violation]` but still require the priority prefix) and
   `severity: blocking|non-blocking` inside each finding body.

## Operator fallback

When the kill-switch is enabled (`PACK_HARNESS_BRIDGE_DISABLED=1`), stop and ask the
operator to complete review via `scripts/invoke-pack-review.ps1` (manual path; frozen
contract).

## Claude harness after supersede

AO 0.10.2 cannot reliably relaunch Claude harness after supersede — project config must
use `reviewers:[{harness:codex}]`. Unset `reviewers` defaults to `claude-code` (failure
class); pack trigger entry refuses batch trigger until codex is configured.
