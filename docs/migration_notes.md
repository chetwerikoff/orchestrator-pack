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

### Patch: `sentFindingCount` pending-worker detection (Issue #45)

Issue #45 corrects the review-loop contract after `ao review send`: findings move
to `sent_to_agent`, so `openFindingCount` is 0 while `sentFindingCount > 0` and
the run stays `waiting_update`. Operators must refresh both surfaces:

1. Copy the updated `orchestratorRules` block from `agent-orchestrator.yaml.example`
   into live `agent-orchestrator.yaml` (under `projects.<id>.orchestratorRules`).
2. Ensure `agentRulesFile` points at the updated `prompts/agent_rules.md` (pull
   the repo or sync that file into your deployment).
3. Restart AO so prompts and rules reload: `ao stop` then `ao start`.

Skipping the YAML merge leaves the orchestrator treating `waiting_update` as idle
when only `sentFindingCount` is non-zero; skipping restart leaves workers on the
old completion rule.

### Windows `orchestratorRules` quote safety (Issue #55)

On Windows, AO starts the Cursor agent through a PowerShell 5.1 prompt template that
substitutes `orchestratorRules` text into the launch command. Any **double-quote
character** in the `orchestratorRules:` literal (including inline `--command "…"`
wrappers) is not escaped correctly; flags such as `-NoProfile` leak into Cursor's
argv and the orchestrator session fails at launch with `error: unknown option
'-NoProfile'` and observability `stuck` / `probe_failure`.

**Safe adoption pattern:**

1. Copy the `orchestratorRules` block from `agent-orchestrator.yaml.example` (Issue
   #55+). The block defines **REVIEW_COMMAND** once (pack wrapper shell line) and
   tells the orchestrator to pass it via `ao review run <id> --execute --command …`
   at the shell — not embedded as a quoted `--command` line inside the rules text.
2. Do not add `"` characters anywhere inside the `orchestratorRules:` literal when
   merging into live `agent-orchestrator.yaml`.
3. Restart AO after merge: `ao stop` then `ao start`.

Regression guard: `scripts/check-orchestrator-rules-quotes.ps1` (also run from
`scripts/verify.ps1`).

### AO local review preflight and failed runs (Issue #60)

AO reviewer workspaces (`code-reviews/workspaces/op-rev-*`) are fresh git
checkouts without `node_modules`. The pack wrapper needs `tsx` from the reviewed
repo root.

**Canonical review command.** Copy **REVIEW_COMMAND** from
`agent-orchestrator.yaml.example` — it runs `scripts/run-pack-review.ps1`, which
executes `npm ci --include=dev` then `plugins/ao-codex-pr-reviewer/bin/review.ps1`.
Do not improvise alternate `--command` chains (`&&`, nested `if`, or bare
`review.ps1` without preflight).

**Failed ≠ clean.** A run with `status: failed` or `cancelled` and
`findingCount: 0` is **not** a clean review. Read `terminationReason` from
`ao review list --json` before retry; do not `ao review send` on failed runs.

**Empty-review trap.** When `findingCount` is 0 but `status` is `failed`, the
reviewer process failed before emitting `NO_FINDINGS` or JSON findings — AO is
not saying the PR is clean. The pack wrapper now copies Codex/CLI error lines
into stderr so `terminationReason` often includes `usage limit`, `ERR_MODULE_NOT_FOUND`,
or `review.ps1` without preflight. Run `.\scripts\orchestrator-diagnose.ps1` before
declaring mergeable; compare `terminationReason` to live **REVIEW_COMMAND** (script
name must match). Use the Claude bridge when Codex quota is exhausted — see
[reviewer-switch-runbook.md](reviewer-switch-runbook.md).

**Codex CLI shape.** Installed Codex CLI treats `codex exec review --base` and a
custom `[PROMPT]` as mutually exclusive. The pack wrapper scopes via prompt text
(`git diff <base>...HEAD`) and stdin prompt mode, not `--base` plus stdin together.

**Windows reviewer sandbox.** The `op-rev-*` read-only sandbox must allow shell
spawns (operator `~/.codex/config.toml`, e.g. `[windows] sandbox = unelevated`).
Otherwise Codex may return an empty review without inspecting the diff.

Regression guards: `scripts/check-review-command-preflight.ps1`,
`scripts/check-orchestrator-rules-quotes.ps1` (via `scripts/verify.ps1`).

### Switching local reviewer: Codex ↔ Claude Sonnet

The canonical **REVIEW_COMMAND** in `agent-orchestrator.yaml.example` targets
**Codex** via `scripts/run-pack-review.ps1` (tracked in the repo).

For a temporary **Claude Sonnet** path, operators use a gitignored bridge under
`<pack-root>/.ao/run-pack-review-claude.ps1` and an **absolute** path in live
`agent-orchestrator.yaml` (AO `op-rev-*` workspaces do not contain `.ao/`).

Step-by-step switch instructions, preflight, smoke `ao review run`, and
troubleshooting: [`docs/reviewer-switch-runbook.md`](reviewer-switch-runbook.md).

After any **REVIEW_COMMAND** change, restart AO (`ao stop` then `ao start`) so
`orchestratorRules` reload.

### Worker prompt-delivery launch failure on Windows (Issue #63)

On Windows, AO starts **worker** Cursor sessions with a launch command built by
`@aoagents/ao-plugin-agent-cursor`: the worker system-prompt file and task prompt
are inlined into the shell command via `$(cat …; printf …)`. That is separate
from `orchestratorRules` quote safety (Issue #55), which only affects the
orchestrator launch path.

**Named condition:** worker **prompt-delivery launch failure** — the agent process
exits within about a minute of `spawning → working`, with no PR, no
`ao acknowledge`, and usually no Cursor chat. AO may show `working → detecting →
stuck` and `agent_process_exited`. Do **not** treat this as orchestrator stuck;
use this subsection instead of `docs/orchestrator-recovery-runbook.md` ping/kill
for the orchestrator.

**Signature A — POSIX builtin under PowerShell (default AO shell).** PTY shows:

- `printf : The term 'printf' is not recognized …`
- `error: unknown option '-ne'`

**Signature B — command line too long (shell-independent).** PTY shows:

- `The command line is too long.`

Occurs when the inlined prompt exceeds the Windows argv limit (observed with
~24 KB worker prompt files on issue #60). The orchestrator often survives
because its launch uses `$(cat <file>)` only (no `printf`) and a smaller prompt.

**`AO_SHELL=bash` is not a sufficient workaround.** Tested on this pack: bash
clears Signature A but then `agent: command not found` (Git Bash does not run
`agent.cmd` without a shim), and with a shim large prompts still hit Signature B.

**Pack-side checks:** `scripts/check-worker-launch-failure.ps1` (PTY fixtures as
`*.txt` under `tests/fixtures/worker-launch-failure/`), wired in
`scripts/verify.ps1`.
`scripts/orchestrator-diagnose.ps1` flags workers with no PR in
`detecting`/`exited` as possible launch failures.

**Upstream fix (escalation):** file against [ComposioHQ/agent-orchestrator](https://github.com/ComposioHQ/agent-orchestrator) —
`@aoagents/ao-plugin-agent-cursor` should pass the worker prompt via a file or
agent flag, not inline argv, and must not use POSIX `printf` on Windows.

**Not launch failure:** `workspace.branch_collision` warnings during spawn are
worktree hygiene; inspect separately.

## Autoloop go-live (operator checklist)

Issues #28, #39, and #60 are merged (#42, #47, #65): rules, wake listener, and
`scripts/run-pack-review.ps1` are in the repo. Adoption is still manual — live
`agent-orchestrator.yaml` is gitignored.

**Start here:** [`docs/orchestrator-autoloop-go-live.md`](orchestrator-autoloop-go-live.md)

Minimum live YAML fixes not in older copies:

1. Merge current `orchestratorRules` and **COMMAND DISCIPLINE** from
   `agent-orchestrator.yaml.example`.
2. Set `reactions.approved-and-green.priority: action` (otherwise mergeable events
   never hit the webhook listener).
3. `ao stop` then `ao start`; run `scripts/orchestrator-wake-listener.ps1` alongside.

## Orchestrator wake listener (webhook + local HTTP)

Issue #39 adds an event-driven wake path so the orchestrator session gets a turn
when AO emits urgent/action notifications, without polling or schedulers.

To adopt on an existing live `agent-orchestrator.yaml`:

1. Merge the `notifiers.webhook` block from `agent-orchestrator.yaml.example`
   (default URL `http://127.0.0.1:17487/ao-wake`).
2. Merge `notificationRouting` so `urgent` and `action` include `webhook` (keep
   your other notifier channels).
3. Set `AO_ORCHESTRATOR_SESSION_ID` to your orchestrator session id (from
   `ao status`) or pass `-OrchestratorSessionId` when starting the listener.
4. In a separate terminal from the AO daemon, start the listener before or with
   `ao start`:
   `pwsh -File scripts/orchestrator-wake-listener.ps1`
5. Verify reachability:
   `Test-NetConnection -ComputerName 127.0.0.1 -Port 17487`
6. Optional dry-run (logs forward decisions without calling `ao send`):
   `pwsh -File scripts/orchestrator-wake-listener.ps1 -DryRun`

Full operator steps, dedup window, and failure detection are in
`docs/orchestrator-wake-runbook.md`. When the listener is stopped, AO and workers
continue normally; only automatic orchestrator wakes stop.

## Orchestrator stuck / probe_failure recovery

When AO observability flags the orchestrator session (e.g. `op-orchestrator`) as
`stuck` or `probe_failure` while workers or review runs still need coordination,
use the manual escalation runbook — do not improvise kills without inspecting
in-flight state first:

1. Read `docs/orchestrator-recovery-runbook.md` (ordered steps: ping → inspect →
   kill orchestrator session → full `ao stop`/`ao start`).
2. Optionally run `pwsh -File scripts/orchestrator-diagnose.ps1` for a read-only
   one-screen snapshot before escalation.

If a **worker** (not the orchestrator) exits immediately after spawn with no PR,
see **Worker prompt-delivery launch failure on Windows (Issue #63)** above — do not
apply orchestrator stuck recovery to that worker.

After recovery, the orchestrator re-applies `orchestratorRules` from your live
YAML (see **Autonomous review loop** above). This path does not add automatic
recovery or new AO configuration.
