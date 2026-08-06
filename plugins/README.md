# Plugins and extension contracts

This directory contains contracts for future external AO extensions. It does not
contain AO core patches.

Contract directories:

- `task-declaration` — DD-026/DD-027 equivalent for declared task scope,
  denylist validation, amendments, and baseline state.
- `scope-guard` — DD-024 equivalent runtime guard plus PR-level CI backup.
- `token-chain-ledger` — cross-session `chain_id` cost/token accounting.
- `codex-pr-reviewer` — Codex `gpt-5.5` PR-review contract while planner and
  worker roles remain on Cursor CLI.

Implementation rules:

- Bind through AO plugin slots, agent wrappers, workspace hooks, pre-commit hooks,
  CI, or external state files.
- Do not modify `packages/core/` in Composio AO.
- Prefer AO session metadata when available.
- Keep workspace-local `.orchestrator-pack/` state gitignored.
- Never commit tokens, API keys, or private credentials.

The README in each plugin directory is the source contract until an implementation
exists.
