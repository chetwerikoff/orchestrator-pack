# Architecture

## Principle

`orchestrator-pack` is a thin, upgrade-safe layer around upstream Composio AO.
The AO lifecycle remains upstream-owned. Local behavior is expressed as:

- YAML config examples;
- prompt templates;
- external plugin contracts;
- read-only verification scripts;
- GitHub Actions checks.

No local code should modify upstream AO core.

## Layout

```text
orchestrator-pack/
  README.md
  agent-orchestrator.yaml.example
  docs/
  prompts/
  plugins/
  scripts/
  .github/workflows/
```

Optional upstream reference checkout:

```text
vendor/agent-orchestrator/
```

Rules for `vendor/agent-orchestrator`:

- disposable reference only;
- no local modifications;
- never used as `packages/core`;
- may be removed and recloned at any time.

## Extension layers

### Config layer

`agent-orchestrator.yaml.example` demonstrates stock AO settings:

- Windows `process` runtime;
- Cursor CLI as the default agent;
- role overrides so the planner/orchestrator and coder/worker both use Cursor CLI;
- worktree isolation;
- desktop notifications;
- explicit GitHub Issues tracker and GitHub SCM config;
- `agentRulesFile` pointing to `prompts/agent_rules.md`;
- safe reactions that do not auto-merge.

The current upstream AO schema supports `orchestrator` and `worker` role
overrides. It does not expose a stable first-class `reviewer` role field in the
YAML schema. Codex `gpt-5.5` review should therefore be added as an external
plugin/workflow or explicit Codex review session, not as an unsupported YAML key
and never as a core patch.

### Prompt layer

`prompts/agent_rules.md` provides portable guardrails that any AO-supported agent
can receive through `agentRulesFile`.

`prompts/self_architect_check.md` is a small reusable review block to reduce
unnecessary subsystems, duplicate prompt literals, and broad scope declarations.

### Plugin-contract layer

The plugin directories are contracts, not implementations:

- `ao-task-declaration` declares active scope and baseline state.
- `ao-scope-guard` enforces active scope at runtime and defines the PR CI backup.
- `ao-token-chain-ledger` aggregates cost/tokens by chain across sessions.
- `ao-codex-pr-reviewer` defines the optional Codex `gpt-5.5` PR-review path.

Future implementations should bind to AO plugin slots, wrappers, hooks, or
external state files. They must not patch AO core.

### CI layer

`.github/workflows/scope-guard.yml` currently runs the read-only verifier and
contains the TODO for PR diff scope validation.

CI is the second line of defense. Runtime scope guard remains mandatory because
an agent can mutate the working tree and index before a PR exists.

## Data boundaries

Allowed local state locations for future implementations:

- AO session metadata when exposed by upstream AO;
- workspace-local `.ao/` state that is gitignored;
- external JSONL/SQLite ledgers outside committed source;
- CI artifacts for audit output.

Disallowed:

- committed secrets;
- local patches in `packages/core`;
- hidden changes under `vendor/agent-orchestrator`;
- mandatory migration of the old `.ai-loop/` layout.
