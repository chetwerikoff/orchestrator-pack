# Plugins and extension contracts

This directory contains runtime-neutral pack plugins. It contains no core patch and
no concrete runtime implementation.

Active plugins:

- `task-declaration` — DD-026/DD-027 task scope, denylist, amendment, and baseline evidence;
- `scope-guard` — DD-024 runtime guard plus PR-level CI second line;
- `token-chain-ledger` — explicit `chain_id`, token, cost, finding, and convergence accounting;
- `codex-pr-reviewer` — bounded Codex `gpt-5.5` review for GitHub Issues-linked PRs.

Implementation rules:

- depend on public pack contracts and explicit inputs;
- use `RuntimeAdapter` only when a runtime operation is required;
- never import a concrete adapter into business logic;
- keep `.orchestrator-pack/` generated state gitignored;
- do not patch `packages/core/**` or vendor an upstream implementation;
- do not add compatibility aliases, dual execution, hidden retry, or fallback transport;
- never commit credentials or private runtime state.

Each plugin README defines its observable contract. Code and tests implement that
contract; historical plugin identities are not aliases.
