# Migration notes

Source migration note read read-only from:

`C:\Users\che\.claude\projects\C--Users-che-Documents-Projects-ai-orchestrator\memory\project_composio_migration.md`

## Goal

Port only the safety contracts that stock Composio Agent Orchestrator does not
already provide architecturally. Do not fork or patch AO core.

## Upstream AO capabilities to preserve

AO already provides:

- per-session worktrees;
- PR, CI, and review reactions;
- dashboard/status UX;
- YAML config through `agent-orchestrator.yaml`;
- `agentRules` / `agentRulesFile` prompt injection;
- session metadata and flat-file state;
- plugin slots for runtime, agent, workspace, tracker, SCM, notifier, and
  terminal integrations.

The pack therefore adds contracts around AO instead of replacing AO orchestration.

## Port priority

1. Task declaration contract equivalent to DD-026/DD-027:
   - declared allowlist metadata;
   - denylist validation;
   - baseline hash/state;
   - one amendment per iteration.
2. Runtime scope gate equivalent to DD-024:
   - first line of defense before `git add`/commit;
   - implemented through an agent wrapper, workspace hook, or pre-commit path;
   - not CI-only.
3. PR-level CI scope check:
   - second line of defense for PR diffs;
   - blocks merge when changed files exceed declared scope;
   - does not replace the runtime guard.
4. Self-architect checks:
   - prompt-level check now;
   - optional CI lint later.
5. Chain token ledger:
   - aggregate planner/reviewer/worker/fix-worker/final-review sessions by
     `chain_id`;
   - build on AO per-session cost when available;
   - not a Tracker plugin.

## Correct terminology

- Say "runtime scope gate + PR CI check", not "commit-gate plugin".
- Say "chain token ledger", not "Tracker token plugin".
- Use `agent-orchestrator.yaml`, not `composio.config.ts`.
- Frame this work as migrating safety contracts, not migrating the orchestrator.

## Explicit non-goals

Do not port:

- Windows-only `lib_codex_exec.ps1`, `cmd /c`, stream/BOM fixes from the old
  project;
- `install_into_project.ps1`;
- the `.ai-loop/` layout as a mandatory protocol;
- per-iteration console-tail UX already covered by AO dashboard/reactions.

## Autonomous review loop (`orchestratorRules` + `report-stale`)

Issue #28 ships the canonical autonomous review-loop contract in
`agent-orchestrator.yaml.example` (`orchestratorRules` block and
`reactions.report-stale` backstop) plus worker rules in `prompts/agent_rules.md`.

To adopt on an existing live `agent-orchestrator.yaml`:

1. Open `agent-orchestrator.yaml.example` and copy the full `orchestratorRules`
   literal for your project (under `projects.<id>.orchestratorRules`).
2. Merge the `report-stale` entry under top-level `reactions` (keep your other
   reaction entries; do not duplicate keys).
3. Ensure `agentRulesFile: prompts/agent_rules.md` (or equivalent path) so workers
   receive the review response contract.
4. Restart AO so prompts reload: `ao stop` then `ao start`.

Until restart, the orchestrator and workers keep prior prompt text. The live YAML
is gitignored — diff against the example when upgrading; do not hand-edit only
the worker rules without updating `orchestratorRules`.
