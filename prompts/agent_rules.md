# Agent Rules

These rules are intended to be injected through Composio AO `agentRulesFile`.
They must be portable across AO-supported agents and must not rely on local
`ai-orchestrator` internals.

## First action (AO pickup)

After reading the initial task prompt, your **mandatory first action** in the
AO worktree is:

```powershell
ao acknowledge
```

Run this within **60 seconds** of session start — before `ao-declare`, file
edits, research, commits, or PR work. AO's `reportWatcher` treats a missing
pickup as `no_acknowledge` and marks the session `stuck` while the process is
still alive.

Skipping acknowledge blocks the orchestrator review loop and may trigger
operator recovery or session kill per
[`docs/orchestrator-recovery-runbook.md`](../docs/orchestrator-recovery-runbook.md).

## Local Codex review (active)

Local Codex PR review **is active** in this pack. AO drives it through the
first-class `ao review` CLI (`run`, `send`, `list`, `execute`). Wiring lives in
`orchestratorRules` in `agent-orchestrator.yaml`. Discover runs via
`ao review list <project>` and the AO dashboard.

Review uses Codex CLI with `gpt-5.5`. On AO 0.9.x, a `reviewer:` YAML block is
silently ignored (parsed without error; no code path reads it) — use
`orchestratorRules` and configured AO/plugin/CI review paths, not invented YAML
fields.

See also: [`README.md`](../README.md#local-codex-review-active),
[`docs/architecture.md`](../docs/architecture.md#review-paths).

## Tracker and role policy

- GitHub Issues are the task source of truth for this pack's AO setup.
- Treat every GitHub Issue assigned to AO as the task specification.
- Link every branch and PR back to its source issue; PR bodies must include
  `Closes #N`, `Fixes #N`, or `Resolves #N` for the task issue.
- Put the closing reference in the **first few lines** of the PR description
  (immediately under `## Summary`), not only at the end of a long body. Scope
  guard reads the full body via `gh`; early placement avoids operator confusion
  when debugging CI.
- If **PR scope guard** fails with `missing_issue_link` but the PR already shows
  `Closes #N` in GitHub, re-check the closing line is present and re-run CI — do
  not broaden scope or rewrite the declaration to bypass the guard.
- Planning and coding sessions are expected to run through the Cursor CLI agent
  unless the AO config explicitly overrides the role.
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

## Coworker CLI delegation

Use the external `coworker` CLI (`coworker ask`, `coworker write`) only when this
section’s triggers and fences apply. `coworker stats` is optional for cost
observability. This policy does not replace in-session subagent / Task delegation
rules when those are present. For the broader “cheapest sufficient executor”
ladder, see
[`docs/first_principles_5_operational_framework.md`](../docs/first_principles_5_operational_framework.md).

**Pickup before shell-out.** Run `ao acknowledge` (see **First action**) before the
first `coworker` invocation in the session — same ordering as other implementation
work.

**Mandatory profiles.** Every `coworker ask` MUST pass `--profile code` (fixed; no
per-task override). Every `coworker write` MUST pass `--profile write` unless the
task issue explicitly names a different profile. Do not rely on operator or upstream
CLI defaults.

**Upstream file gate.** Default corpus for `coworker ask` and context for
`coworker write` is text/markdown only. Source-code input requires `--allow-code`
or `COWORKER_ALLOW_CODE=1` per upstream coworker — use only when the task explicitly
requires code at the cheap provider; do not bypass the gate to force delegation on
undeclared code.

**Provider-input fence (no exfiltration).** File material sent to the external
provider — `coworker ask` corpus and `coworker write` context — MUST be
repo-originating and non-secret: this repo’s tracked files, or repo-derived material
(e.g. `git diff`, `git log`, working-tree output captured to a scratch path). Never
send out-of-tree paths, external content, gitignored or secret-bearing files, or
credentials. The `--question` / `--spec` prompt is worker-authored task text: it MUST
carry no secrets or credentials, but need not be a repo file. `coworker ask` performs
no edit — its corpus may span repo context outside the editable declared scope under
this fence. `coworker write --target` is an edit: every `--target` MUST stay inside
the active declared scope.

**Delegate `coworker ask` (with `--profile code`) only when at least one trigger holds:**

- Combined corpus for one question is **more than 600 lines** across all paths in
  that invocation.
- **3 or more files** under one question (same `coworker ask` call).
- Diff or log material to summarize is **more than 200 lines**.
- Bootstrap read of **2 or more** config/doc paths that together total **more than
  600 lines** (or each path is **more than 200 lines**) where bulk read is the work,
  not synthesis.

When **no** ask trigger holds, use deterministic repo tools (search, read, diff,
tests) **instead of** `coworker ask` — do not delegate.

**Delegate `coworker write` (with `--profile write`) only for primary drafts:**

- README, install docs, configuration reference (first cut).
- Standard boilerplate: LICENSE, `.gitignore`, CI workflow yaml skeletons.

Any context/input fed to `coworker write` obeys the provider-input fence above. Do
not use `coworker write` for iterative refinement of in-scope implementation code.
Delegate only when the target does **not** exist yet, or the task issue explicitly
authorizes replacing that file. Upstream `coworker write` truncate-writes by default
— do not overwrite an existing README, LICENSE, `.gitignore`, or workflow file unless
replacement is in scope. Prefer `--stdout` and apply the diff yourself when the target
already exists.

**Do not delegate (keep on the reasoning model):**

- Tasks estimated **under 2000 tokens** of real work (CLI overhead eats savings).
- Debugging, root-cause analysis, races, safety-critical logic.
- Architectural decisions and trade-off reasoning.
- Edits requiring **exact line numbers** or surgical diffs in existing code.
- Inferring user intent or clarifying ambiguous requirements.
- **Review reasoning** — producing or shaping PR-review findings (correctness,
  security, race, logic). The review path — canonical **REVIEW_COMMAND**, **PACK_REVIEWER**,
  and the pack review wrapper it dispatches — MUST NOT be routed through `coworker`.
  Nothing backstops reviewer judgment; the cost rule’s “delegate I/O, keep reasoning”
  does not license cheap review.

**Accountability.** You remain responsible for verifying coworker output, scope,
commits, and AO transitions. `coworker` must not run `ao-declare`, `ao report`, or
open PRs.

## Required CI (CI green)

Worker `ready_for_review`, orchestrator CI pings, and operator recovery docs use
**one** definition of which checks must pass:

- **Preferred:** GitHub **required status checks** for the PR's base branch (branch
  protection), when configured for this repository.
- **Fallback:** when branch protection does not list required checks, **all checks**
  reported for the PR head that belong to this pack's merge contract — workflow
  `scope-guard` jobs such as **Verify orchestrator-pack structure**, **PR scope
  guard**, **Run pack contract tests**, and **Self-architect lint** (see
  `.github/workflows/scope-guard.yml`) — not every optional or third-party check on
  the PR unless the repo already treats them as merge-blocking.

Inspect with `gh pr checks <pr>` (or equivalent) against the **current PR head**.
Do not treat the PR as CI-green while any required check is `fail`, `pending`, or
missing for that head.

## Worker CI gate (`ready_for_review` and self-fix)

**Self-fix is primary;** orchestrator `ao send` on red CI is recovery when the worker
has gone idle — not a substitute for fixing CI yourself.

- Do **not** run `ao report ready_for_review` (or treat the task as done) while
  required CI for the PR head is not green per the definition above.
- **Before** every `ao report ready_for_review`, check required CI for the current
  head; if any check is red or still running, stay in or move to
  `ao report fixing_ci` and fix — push, re-run local verification, wait for green CI.
- If CI was green when you reported but fails on a later push, or you discover red CI
  after reporting `ready_for_review`, immediately `ao report fixing_ci` and fix
  **without waiting** for `ci-failed`, `report-stale`, or operator ping.
- While actively fixing CI, keep reporting `fixing_ci` as needed; do not go idle on a
  red-CI PR expecting the orchestrator to drive the fix unless you are blocked.

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
   when required CI for the PR head is green (see **Required CI**) and the PR is ready
   for the next orchestrator-driven review round.

Use underscore state names (`addressing_reviews`, `fixing_ci`, `ready_for_review`)
so `ao status --reports full` matches what orchestratorRules watches; hyphenated
CLI aliases exist but can stall the autonomous review loop if status never shows
the underscore form.

**Terminal failure.** If you cannot address findings, report terminal failure
with a reason: `ao report completed --note "<reason>"` or `ao send` to the
orchestrator session explaining the blocker. Do not disappear without a signal.

**Forbidden `completed` while review is open.** Do NOT run `ao report completed`
(success termination) while, for the current PR head:

- the latest review run has `openFindingCount > 0` or `sentFindingCount > 0`, or
- any review run for that head is in `needs_triage` (findings not yet sent).

After `ao review send`, findings are `sent_to_agent` (`sentFindingCount > 0`,
`openFindingCount: 0`); report `ao report addressing_reviews` until resolved.
Terminal failure with a reason (`ao report completed --note "<reason>"` or
`ao send`) remains permitted when you cannot address findings.

Completion means nothing further to do; open or sent findings or an unsent
triage queue contradict that. Instead, run `ao report addressing_reviews` (after
briefly allowing the orchestrator to `ao review send` if status is
`needs_triage`), or report terminal failure with a reason.

**Inspect before reporting.** Use `ao review list --json` to confirm run status
and counts; do not infer cleanliness from finding prose.

## AO review command and failed runs (workers)

- Workers MUST NOT invent alternate `ao review run --command` strings. Only the
  orchestrator drives review with the canonical **REVIEW_COMMAND** from project
  config (`agent-orchestrator.yaml` / `agent-orchestrator.yaml.example`).
- Workers MUST NOT treat a failed or cancelled review run as review completion,
  even when `findingCount` is 0 or findings text is empty.
- Workers MUST NOT report that Codex review passed when `ao review list --json`
  shows only `failed` or `cancelled` runs for the current PR head.
- A run with `findingCount: 0` and `status: failed` or `cancelled` is an **empty
  failed review** (reviewer infra/command failure), not a clean review. Read
  `terminationReason`; do not infer success from zero findings alone.

## Operator adoption handoff

When a task changes **operator-facing surfaces** — `agent-orchestrator.yaml.example`
(any block operators must mirror into live yaml), runbooks or go-live docs that
introduce new operator processes (listeners, watchers, schedulers), documented
operator env vars, machine-local config called out in the issue, or
`orchestratorRules` / `reactions` that require `ao stop` / `ao start` — before
reporting successful completion:

- Add **`## Operator adoption`** to the PR body (near the top, under `## Summary`)
  with the post-merge checklist the operator must run.
- Add or update a matching subsection in **`docs/migration_notes.md`**.
- Do **not** run `ao report completed` (or treat the task as done) while the PR
  lacks `## Operator adoption` when `.example` or operator-process docs changed
  in scope.

Workers **document** adoption; they do **not** execute it by default. Do not start
listeners, edit secrets, or merge live `agent-orchestrator.yaml` from an AO
worktree — worktree copies are not the operator checkout. Do not assume adoption
is done unless the operator confirms.

**Optional helper only:** if the worker session runs in the **primary pack
checkout** (not an `op-*` worktree) and the issue explicitly asks, the worker
**may** merge `.example` deltas into live yaml and note that in the PR — still
not a substitute for the operator checklist.

Cosmetic-only `.example` edits with zero operator follow-up may use the exact PR-body
waiver line on its own: `No operator adoption required` (CI enforces pairing;
misuse should fail review). See **`docs/migration_notes.md`** (Operator adoption
contract) and **`docs/orchestrator-autoloop-go-live.md`** for the umbrella
operator checklist.
