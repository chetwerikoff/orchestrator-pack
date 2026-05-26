# Agent rules for orchestrator-pack

These rules are intended to be injected through Composio AO `agentRulesFile`.
They are portable across AO-supported agents and must not rely on patched AO core.

## Scope discipline

- Do not touch files outside the declared active scope.
- Every task must contain either:
  - an explicit file/path scope, or
  - a denylist that is validated before work starts.
- Treat broad directory declarations such as `src/**` or `**/*` as suspicious.
  Narrow them before editing unless the task explicitly justifies the breadth.
- Normalize paths relative to the repository root before comparing them to scope.

## Before commit

Before staging or committing, compare modified and staged paths with the active
scope:

- inspect changed files with the repository's normal git status/diff commands;
- verify every modified path is allowed and not denied;
- stop and request/record a scoped amendment if any path is outside scope;
- do not rely on PR CI as the first scope check.

## Queued task specs

- Do not delete queued task specs unless the deletion itself is explicitly in
  scope.
- Do not rewrite another task's declaration to make the current diff pass.
- If a task declaration needs to change, record one amendment for the current
  iteration and keep the previous baseline auditable.

## Shared source of truth

- If the same literal, prompt, path, policy, or command is needed in two places,
  first extract a single source of truth.
- Avoid paired script/template edits that can drift. Prefer generating one from
  the other or referencing the same data file.
- Do not duplicate safety-policy prompt text across agents when a shared prompt
  file can be referenced instead.

## Upgrade-safe AO usage

- Prefer plugin, config, prompt, wrapper, hook, or CI extensions over AO core
  patches.
- Do not edit upstream `packages/core/` to satisfy a task.
- If upstream behavior appears missing, write a contract or wrapper first and
  escalate the need for a proper plugin/API only after confirming the gap.
