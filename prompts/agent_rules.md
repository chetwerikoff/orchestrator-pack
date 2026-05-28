# Agent Rules

These rules are intended to be injected through Composio AO `agentRulesFile`.
They must be portable across AO-supported agents and must not rely on local
`ai-orchestrator` internals.

## Tracker and role policy

- GitHub Issues are the task source of truth for this pack's AO setup.
- Treat every GitHub Issue assigned to AO as the task specification.
- Link every branch and PR back to its source issue; PR bodies should include
  `Closes #N`, `Fixes #N`, or an explicit issue reference as appropriate.
- Planning and coding sessions are expected to run through the Cursor CLI agent
  unless the AO config explicitly overrides the role.
- Desired review model is Codex CLI with `gpt-5.5`, but do not invent unsupported
  AO YAML fields for reviewers. Use only configured AO/plugin/CI review paths.
- Do not use Vibe Kanban or Linear unless the config explicitly changes the tracker.

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

## Review feedback handling

When AO sends review feedback through `changes-requested` or `ci-failed`:

- Treat the feedback as a scoped correction for the same issue and chain.
- Classify each finding as scope, spec, quality, test, CI, or security.
- Make the smallest change that resolves the finding.
- Do not broaden the declaration only to silence review feedback.
- If feedback appears repetitive or contradictory, stop guessing and escalate
  with evidence.
- Report verification commands and unresolved findings before handing back.

## AO review response contract (workers)

When AO-local review findings land (via `changes-requested`, `ao review send`,
or the `report-stale` backstop), the worker MUST NOT go idle silently.

**Required `ao report` transitions on the review path:**

1. `ao report addressing_reviews` — as soon as you begin working on findings
   (mandatory after findings are delivered; do not wait for a human ping).
2. `ao report fixing_ci` — optional, while fixing CI triggered by review fixes.
3. `ao report ready_for_review` — after pushing fixes and local verification,
   when the PR is ready for the next orchestrator-driven review round.

Use underscore state names (`addressing_reviews`, `fixing_ci`, `ready_for_review`)
so `ao status --reports full` matches what orchestratorRules watches; hyphenated
CLI aliases exist but can stall the autonomous review loop if status never shows
the underscore form.

**Terminal failure.** If you cannot address findings, report terminal failure
with a reason: `ao report completed --note "<reason>"` or `ao send` to the
orchestrator session explaining the blocker. Do not disappear without a signal.

**Forbidden `completed` while review is open.** Do NOT run `ao report completed`
while, for the current PR head:

- the latest review run has `openFindingCount > 0`, or
- any review run for that head is in `needs_triage` (findings not yet sent).

Completion means nothing further to do; open findings or an unsent triage queue
contradict that. Instead, run `ao report addressing_reviews` (after briefly
allowing the orchestrator to `ao review send` if status is `needs_triage`), or
report terminal failure with a reason.

**Inspect before reporting.** Use `ao review list --json` to confirm run status
and counts; do not infer cleanliness from finding prose.
