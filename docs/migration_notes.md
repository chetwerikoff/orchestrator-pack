# Migration notes

Source migration note read read-only from:

`C:\Users\che\.claude\projects\C--Users-che-Documents-Projects-ai-orchestrator\memory\project_composio_migration.md`

## Issue queue index (2026-05)

Operators and architects resolving draft files to GitHub Issues should use
[`issue_queue_index.md`](issue_queue_index.md). Draft filename prefixes are not
GitHub Issue numbers; query live state with `gh issue view` rather than inferring
from draft files in the repo.

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

### State-derived review trigger (Issue #58)

Issue #58 adds a **reconciliation** trigger to `orchestratorRules`: on each
orchestrator turn the rules now instruct enumerating open PRs and head SHAs from
GitHub (`gh pr list --state open --json number,headRefOid`), cross-referencing
`ao review list --json`, resolving the worker session from `ao status --json
--reports full` (or `ao spawn --claim-pr <PR>` when none exists), and starting
review for any open PR head with no run and none in flight — even when the worker
never reported `pr_created` or `ready_for_review`. This closes the PR #56 gap
(report-only gating). No new AO daemon or poller is added; the check runs only
when the orchestrator already has a turn.

To adopt on an existing live `agent-orchestrator.yaml`:

1. Copy the updated `orchestratorRules` block from `agent-orchestrator.yaml.example`
   (look for STATE-DERIVED REVIEW TRIGGER and the gh pr list reconciliation steps).
2. Keep `agentRulesFile: prompts/agent_rules.md` so workers retain the review
   response contract.
3. Restart AO so prompts reload: `ao stop` then `ao start`.

Until restart, a missed `ready_for_review` report can still block review because
the live orchestrator keeps the old report-only trigger text.

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

For a temporary **Claude Sonnet** path, swap **REVIEW_COMMAND** to the parallel
tracked wrapper `scripts/run-pack-review-claude.ps1` (same relative
`--repo-root . --base origin/main` flags). Gitignored
`<pack-root>/.ao/run-pack-review-claude.ps1` is **deprecated** — optional
one-release forwarder only; `op-rev-*` worktrees do not contain `.ao/`.

**Strict gate (Issue #79).** CI runs `scripts/invoke-pack-review-strict-gate.ps1`
on committed fixtures (no `ao` / `gh`). Operators run
`scripts/orchestrator-diagnose.ps1 -Strict` before merge when AO is running live.
Failed/cancelled runs with `findingCount: 0` and `terminationReason` naming a
script other than **REVIEW_COMMAND** fail closed.

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

**Mechanism (verified from plugin source).** In `@aoagents/ao-plugin-agent-cursor`
`dist/index.js` `getLaunchCommand`, the **worker** path inlines the task prompt:
`"$(cat <systemPromptFile>; printf '\n\n'; printf %s '<prompt>')"`. The
**orchestrator** (and any session with no separate task prompt) takes the
**cat-only** path `"$(cat <systemPromptFile>)"`, which survives because `cat` is
a PowerShell alias for `Get-Content` while `printf` does not exist. So the
`printf %s '<prompt>'` tail is the single source of **both** signatures: A
(`printf` absent) and B (the whole prompt lands in argv). The systemPromptFile is
**already** delivered via a file — only the task prompt is inlined.

**Upstream fix (escalation, FILED):**
[ComposioHQ/agent-orchestrator#2074](https://github.com/ComposioHQ/agent-orchestrator/issues/2074).
The durable fix: deliver the task prompt the same way the system prompt already
is — write it to a file and `cat` it (mirror the cat-only path), removing the
POSIX `printf` dependency and keeping the prompt out of argv. No new agent CLI
flag is required; the positional `$(cat …)` substitution is proven on Windows by
the surviving orchestrator path. Still present byte-identical in `0.9.1`
(`latest`), `0.9.3-nightly`, and `0.10.1-nightly` as of 2026-05-30 — do **not**
expect an `ao` upgrade to fix it yet.

**Local workaround (this machine, until upstream ships).** The globally installed
plugin (`$(npm root -g)/@aoagents/ao/node_modules/@aoagents/ao-plugin-agent-cursor/dist/index.js`)
is patched, Windows-only (`if (isWindows())`), to write `config.prompt` to a temp
file and `cat` it instead of `printf`-inlining it — the exact shape proposed in
#2074. The original is backed up alongside as `index.js.orig`. This is **not** a
tracked repo change (vendor package outside the repo) and is **lost on plugin
reinstall/upgrade** (`npm i -g @aoagents/ao@…`). To re-apply after an upgrade:
in `getLaunchCommand`, guard the `printf` line with `if (isWindows())`, and in the
Windows branch write the prompt (`"\n\n" + config.prompt`) to
`join(tmpdir(), 'ao-worker-prompt-<sessionId>.txt')` and emit
`"$(cat <systemPromptFile>; cat <thatFile>)"` (add `writeFileSync`/`tmpdir`
imports). Verify with `node --check` and that the built command contains no
`printf` and two `cat` calls. Remove the workaround once #2074 ships and pin the
fixed plugin version in `docs/orchestrator-autoloop-go-live.md`.

**Not launch failure:** `workspace.branch_collision` warnings during spawn are
worktree hygiene; inspect separately.

### Dead orchestrator vs `ao spawn` (operator)

`ao spawn <issue>` starts or revives **worker** sessions only. It does **not**
restart a dead orchestrator. If `op-orchestrator` is already `detecting` /
`exited` / `stuck` with `runtime=exited` or `process_missing`, repeated
`ao spawn` only bumps probe counters against a corpse — it is not a recovery step.

**Restart the orchestrator explicitly:**

```powershell
ao session kill op-orchestrator   # when a stale session record exists
ao start                          # recreates orchestrator when the daemon is up
# or: ao stop; ao start
pwsh -File scripts/wait-orchestrator-launch.ps1
```

Attach within the first ~20s for live PTY output:
`ao session attach op-orchestrator`.

### Windows orchestrator prevention — `~/.ao/bin/agent` shim and worktree EPERM (RCA 2026-05-30)

**Observed:** `op-orchestrator` exits instantly (`runtime=exited`, `process_missing`,
empty PTY / `alive:false`); or `ao start` fails with `EPERM` on
`worktrees/op-orchestrator` while reproducing the same launch command in isolation
stays resident.

**Root causes (two layers, often together):**

1. **Bash `agent` shim in `~/.ao/bin`** — AO prepends that directory on every spawn
   (`buildAgentPath` in `@aoagents/ao-core`). AO installs only **`gh` / `git`**
   wrappers there (`.cjs` + `.cmd` on Windows), **never** `agent`. A manual
   `~/.ao/bin/agent` bash script (historically created for `AO_SHELL=bash` worker
   experiments — Git Bash cannot resolve `agent.cmd`) makes **pwsh** resolve
   `agent` to the shim → immediate exit **0**, no cursor-agent child.
2. **Orphan ConPTY children** — `pwsh` + `cursor-agent` under the orchestrator
   worktree survive `ao session kill` / `ao stop` and hold directory handles. With
   `orchestratorSessionStrategy: delete`, the next `ao start` runs `rmSync` on the
   worktree → **`EPERM`**.

**Ruled out for the instant-exit signature:** JediTerm env alone, prompt size,
`unref` on pty-host stdio, cursor-plugin #2074 worker patch (orchestrator uses
cat-only `$(cat <file>)`).

#### Do not repeat (operator checklist)

1. **Do not place `~/.ao/bin\agent`** (or any bash shim) in the directory AO always
   prepends to `PATH`. For Windows workers use upstream
   [#2074](https://github.com/ComposioHQ/agent-orchestrator/issues/2074) (task
   prompt via temp file in the patched cursor plugin), not a permanent shim in
   `~/.ao/bin`.
2. **After `ao session kill`, failed spawn, or `EPERM`** — clear orphans before the
   next `ao start`. Use [Sysinternals Handle](https://learn.microsoft.com/en-us/sysinternals/downloads/handle)
   on the worktree path → `taskkill /T /F /PID <pid>` for each holder. **Do not**
   run `Get-Process node | Stop-Process` (kills the IDE / this Cursor session).
   Pack helper: `scripts/unlock-op-orchestrator-worktree.ps1` (external PowerShell).
3. **Before every `ao start` on Windows:**

   ```powershell
   if (Test-Path "$env:USERPROFILE\.ao\bin\agent") {
     Write-Error "Remove ~/.ao/bin/agent before ao start (see migration_notes.md)"
   }
   ```

4. **Workers on Windows** — durable fix is [#2074](https://github.com/ComposioHQ/agent-orchestrator/issues/2074);
   do not reintroduce `~/.ao/bin/agent` as a standing workaround.

#### Recovery sequence (EPERM or dead orchestrator)

```powershell
pwsh -NoProfile -File scripts/unlock-op-orchestrator-worktree.ps1
# or: preflight -Apply after handle-based kill; then ao stop; ao start
pwsh -File scripts/wait-orchestrator-launch.ps1
node $env:TEMP\ao-pipe-read.cjs   # trust pipe: alive:true + orchestrator scrollback
```

See also `docs/orchestrator-recovery-runbook.md` (step 2b) and
`scripts/orchestrator-worktree-preflight.ps1`.

### Orchestrator trust-bootstrap loop / missing full prompt (Issue #91)

**Named condition:** **trust-bootstrap-only launch** — the orchestrator PTY (or its
Cursor transcript) receives only `workspace-trust-bootstrap: reply OK only.` (~68 B),
not the full orchestrator prompt (~13 KB at
`~/.agent-orchestrator/projects/<project>/orchestrator-prompt-op-orchestrator.md`).
The agent answers `OK` and exits; AO then reports `working → detecting → stuck` /
`probe_failure` with `detectingEvidenceHash` e.g. `9f6adba924ef` and
`lifecycleEvidence` like `signal_disagreement runtime=alive process=dead` (PTY host
may stay up while the cursor child is gone).

**Not the model:** cursor-agent is **not** inherently one-turn-only when the full
prompt is delivered — orchestrator transcripts through **2026-05-29** and
**2026-05-30 ~06:45** show many turns with the full “orchestrator agent” prompt. A
misleading “turn-exit” hypothesis came from a diagnostic run with an explicit
“Reply READY then stop” prompt and closed stdin; do not use that as production
behavior.

**Regression window (observed):** full-prompt sessions through early **2026-05-30**;
from **~09:22** onward, trust-bootstrap-only transcripts dominate while the on-disk
orchestrator prompt file remains correct (~13 KB). Correlates with **2026-05-30**
morning changes (plugin #2074 patch timing, `agentRulesFile` → missing spawn-stub
after pull, repeated `ao session kill` / `branch_collision` on `orchestrator/*`) —
exact “bootstrap replaces launch” mechanism in AO/plugin is still open; confirm
with `ao session attach op-orchestrator` in the first ~20s after `ao start`.

**Separate from headless trust jsonl:** `scripts/trust-ao-worktree.ps1` runs a
**separate** `agent -p` with the bootstrap text to write `.workspace-trusted`.
`orchestrator-worktree-trust-watcher.ps1` does this for each new worktree. Those
runs create small bootstrap transcripts under `~/.cursor/projects/.../agent-transcripts/`
— **do not** treat them as the orchestrator PTY without checking mtime and first
user message (full prompt starts with `# orchestrator-pack Orchestrator` / `You are
the **orchestrator agent**`).

**Orchestrator vs worker (2026-05-30):**

| Surface | Typical failure today | Fix layer |
|---------|---------------------|-----------|
| **Orchestrator** | Bootstrap-only or dead session after kill/collision; `ao spawn` does not revive | This section + worktree preflight + explicit `ao stop`/`ao start`; attach PTY |
| **Worker** | Missing `agentRulesFile` target (e.g. `prompts/agent_rules_spawn_stub.md` removed by pull while live YAML still references it) | Set `agentRulesFile: prompts/agent_rules.md` in live YAML; worker #2074 file patch |

Plugin #2074 diff touches **worker** `printf` inlining only; orchestrator uses
cat-only launch. A/B revert of `index.js` → `.orig` did not restore full-prompt
transcripts by itself — bootstrap loop is not explained by worker argv patch alone.

**Operator routing:** Signature A/B → Issue #63 when the **first** PTY line shows
`printf` / `command line is too long` before any cursor turn. Bootstrap-only /
`probe_failure` with full prompt file present → this section and
`docs/orchestrator-recovery-runbook.md` (orchestrator `probe_failure` = missing full
launch or post-kill corpse, **not** “idle orchestrator”). Do not use `ao spawn` to
revive a dead orchestrator (see **Dead orchestrator vs `ao spawn`**).

**Remediation order (operator, live `agent-orchestrator.yaml`):**

1. `agentRulesFile: prompts/agent_rules.md` (do not point at a stub that is not on disk).
2. Stop `orchestrator-worktree-trust-watcher.ps1` during diagnosis if it is running.
3. `pwsh -File scripts/orchestrator-worktree-preflight.ps1 -Apply` for `branch_collision`.
4. `ao stop` then `ao start`; optional `pwsh -File scripts/wait-orchestrator-launch.ps1` (stderr from notifiers breaks JSON — use `2>$null` or fix script).
5. `ao session attach op-orchestrator` within ~20s — first screen must be full orchestrator text, not bootstrap only.

**Stale `orchestrator/*` worktree/branch:** after `ao session kill`, leftover
`orchestrator/op-orchestrator` branch or worktree dir causes `workspace.branch_collision`
on respawn. Pack hygiene: `scripts/orchestrator-worktree-preflight.ps1` before `ao start`.

**Pack-side checks:** `scripts/check-orchestrator-launch-failure.ps1` — Signature A/B
PTY fixtures only.

**Upstream ask:** [#2074](https://github.com/ComposioHQ/agent-orchestrator/issues/2074)
(prompt file delivery) plus clarification: orchestrator launch must deliver the full
`orchestrator-prompt-*.md` in the PTY session, not stop after trust bootstrap.

**Restore metadata:** `restoreFallbackReason: cursor.getRestoreCommand returned null`
is normal for Cursor restore; not root cause alone.

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

If a **worker** (not the orchestrator) exits within ~1–2 minutes of spawn with no
PR, see **Worker prompt-delivery launch failure (Issue #63)** and check live
`agentRulesFile` points at an on-disk file — do not apply orchestrator stuck
recovery to that worker.

After recovery, the orchestrator re-applies `orchestratorRules` from your live
YAML (see **Autonomous review loop** above). This path does not add automatic
recovery or new AO configuration.
