# Plugins and extension contracts

This directory contains contracts for future external AO extensions. It does not
contain AO core patches.

Contract directories:

- `ao-task-declaration` — DD-026/DD-027 equivalent for declared task scope,
  denylist validation, amendments, and baseline state.
- `ao-scope-guard` — DD-024 equivalent runtime guard plus PR-level CI backup.
- `ao-token-chain-ledger` — cross-session `chain_id` cost/token accounting.

Implementation rules:

- Bind through AO plugin slots, agent wrappers, workspace hooks, pre-commit hooks,
  CI, or external state files.
- Do not modify `packages/core/` in Composio AO.
- Prefer AO session metadata when available.
- Keep workspace-local `.ao/` state gitignored.
- Never commit tokens, API keys, or private credentials.

The README in each plugin directory is the source contract until an implementation
exists.
