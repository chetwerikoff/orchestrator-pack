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

### CI failure ping before report-stale (Issue #109)

Issue #109 adds turn-aware **CI failure discipline** to `orchestratorRules` (orchestrator
`ao send` on each turn that sees red required CI, with episode dedupe) and worker **CI
gate** rules in `prompts/agent_rules.md` (no `ready_for_review` on red CI; self-fix in
`fixing_ci`). `reactions.report-stale` and `reactions.ci-failed` stay unchanged as upstream
long-tail backstops.

To adopt:

1. Merge the updated `orchestratorRules` block from `agent-orchestrator.yaml.example`
   (REQUIRED CI, CI FAILURE DISCIPLINE, and review-loop ordering) into live
   `agent-orchestrator.yaml`.
2. Pull the merged repo and confirm `prompts/agent_rules.md` includes the Required CI
   and Worker CI gate sections (git-tracked — no manual copy). Ensure live
   `agentRulesFile` points at that path.
3. Restart AO: `ao stop` then `ao start`.

Behavioural acceptance: on the next real red-CI PR episode, confirm in
`ao events list --json` that the worker self-fixed without a false `ready_for_review`, or
that an orchestrator `ao send` appeared before `report-stale` (~30 min). See
`docs/orchestrator-recovery-runbook.md` (Red CI with idle worker).

### Event-driven review wake trigger (Issue #207)

Issue #207 teaches `orchestrator-wake-listener.ps1` to issue the first `ao review run`
on `merge.ready` (approved-and-green) completion wakes when HEAD READY FOR REVIEW (#195)
holds. Additive to `review-trigger-reconcile.ps1` (#163) and the heartbeat backstop.

**No new operator process** — restart the existing wake supervisor so the listener picks
up the behaviour and side-effect fencing:

1. Merge updated `orchestratorRules` (EVENT-DRIVEN REVIEW TRIGGER) from
   `agent-orchestrator.yaml.example` into live `agent-orchestrator.yaml`.
2. Pull `prompts/agent_rules.md` (event-driven review trigger section).
3. `pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1 -Action Stop` then
   `-Action Start`.
4. Verify: on worker `ready_for_review` + green CI, listener log shows
   `review-wake-trigger: starting review` within seconds of the completion wake (not only
   on the next heartbeat/reconcile tick).

### Deferred-head review re-evaluation (Issue #235)

Issue #235 adds `scripts/review-trigger-reeval.ps1`: a **scoped** supervised child that
re-evaluates recently-deferred-not-ready heads when #195 readiness lands after an early
completion wake (~77 s incident delay; 5-minute bounded watch window). Additive to #207
wake edge and #163 periodic reconcile backstop.

To adopt:

1. Pull `prompts/agent_rules.md` (Deferred-head review re-evaluation section) and
   `docs/orchestrator-wake-runbook.md`.
2. Restart the wake supervisor so it manages the new child:
   `pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1 -Action Stop` then
   `-Action Start`.
3. Verify watch persistence: after a wake defer (`uncovered_not_ready`), confirm
   `{stateRoot}/review-trigger-reeval-watch.json` contains the head entry.
4. Behavioural acceptance: readiness landing after the early wake triggers
   `review-trigger-reeval: starting review` within seconds (not only on reconcile tick).

### First-send review delivery reconcile (Issue #202)

Issue #202 adds a **state-derived first `ao review send` path**: when a review run is in
`needs_triage` with `sentFindingCount: 0` and the linked worker is live and head-owning,
`scripts/review-send-reconcile.ps1` delivers findings outside the LLM-orchestrator turn
(~2-minute cadence). Additive to the orchestrator-turn first-send rule and heartbeat
backstop; re-delivery remains `review-finding-delivery-confirm.ps1` (#171).

To adopt:

1. Merge the updated `orchestratorRules` block (STATE-DERIVED FIRST REVIEW SEND) from
   `agent-orchestrator.yaml.example` into live `agent-orchestrator.yaml`.
2. Pull `prompts/agent_rules.md` (first-send review delivery section) and confirm
   `agentRulesFile` points at it.
3. Restart the wake supervisor so it manages the third child:
   `pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1 -Action Stop` then
   `-Action Start` (or start standalone `scripts/review-send-reconcile.ps1` for debugging).
4. Restart AO: `ao stop` then `ao start` (orchestratorRules reload).

Behavioural acceptance: after review completes to `needs_triage`, worker receives
`ao review send` within ~2–3 minutes without an orchestrator turn. Verify with
`ao review list --json` (run leaves `needs_triage`; `sentFindingCount` increases).

### CI-green worker wake (Issue #191)

Issue #191 adds a **state-derived CI-green fast path**: when required CI is green and the
linked worker is live, head-owning, and pre-hand-off, `scripts/ci-green-wake-reconcile.ps1`
`ao send`s a continue-hand-off nudge (~1-minute cadence; far below `report-stale` ~30 min).
AO 0.9.x has no CI-green `send-to-agent` reaction — this process is the non-turn-gated
delivery path. `reactions.report-stale`, `reactions.ci-failed`, and turn-driven CI-failure
discipline in `orchestratorRules` are unchanged. Does not recover dead workers (#98).

To adopt:

1. Merge the updated `orchestratorRules` block (STATE-DERIVED CI-GREEN WORKER WAKE) from
   `agent-orchestrator.yaml.example` into live `agent-orchestrator.yaml`.
2. Pull `prompts/agent_rules.md` (CI-green orchestrator nudge section) and confirm
   `agentRulesFile` points at it.
3. Start the reconciler in a dedicated terminal (see `docs/orchestrator-autoloop-go-live.md`
   Terminal F): `pwsh -NoProfile -File scripts/ci-green-wake-reconcile.ps1`
4. Restart AO: `ao stop` then `ao start` (orchestratorRules reload).

Behavioural acceptance: worker paused on green required CI receives `ao send` within ~1–2
minutes, not only at `report-stale`. Verify with `ao events list --json` after a real episode.

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

### Post-merge review run terminal (Issue #54)

After a worker PR is merged, AO 0.9.x may leave `code-reviews/` entries in
`needs_triage` or `waiting_update` while the worker session is gone. Issue #54
adds **MERGED PR — REVIEW LOOP TERMINAL** to `orchestratorRules` so the
orchestrator does not send, re-run review, or review-loop ping/respawn on merged
PRs.

To adopt:

1. Merge the updated `orchestratorRules` block from `agent-orchestrator.yaml.example`
   into live `agent-orchestrator.yaml` (MERGED PR section and EXIT condition 5).
2. Restart AO: `ao stop` then `ao start`.
3. If you use the wake listener, restart `scripts/orchestrator-wake-listener.ps1`
   (and heartbeat if used) in their terminals — no wake-filter code change ships
   with this issue.

Operator reference: `docs/orchestrator-recovery-runbook.md` (**After manual PR merge**)
and `docs/orchestrator-wake-runbook.md` (merged-PR wakes).

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

**Split-channel empty JSONL findings (Codex review-mode).** Signature: valid
`exited_review_mode` with `review_output.findings: []`, non-clean
`overall_correctness`, and pack-format `{"findings":[…]}` or exact `NO_FINDINGS`
in `overall_explanation` and/or the last-message file — not prose `[P1]` markers.
The wrapper recovers findings or clean from those secondary channels only (#135);
broad “any JSONL error → lastMessage” fallback remains forbidden. If
`terminationReason` still shows `reports no findings but overall_correctness is not
"patch is correct"` with no recoverable secondary payload, treat as failed review
(not clean) and inspect Codex CLI / prompt alignment.

**Native review output alignment (#136, prevention).** Root cause when the prompt
required pack JSON or exact `NO_FINDINGS`: Codex review-mode often leaves
`review_output.findings[]` empty and dumps pack JSON into `overall_explanation`
(split-channel). **Prevention:** `prompts/codex_review_prompt.md` now requires
native review-mode output so CLI 0.133.x hydrates `findings[]` and
`overall_correctness`; the pack maps only hydrated structured fields via
`review_jsonl.ts` (no prose scraping). **Recovery** for legacy split-channel runs
remains #135. After merge, re-run a live `codex exec review --json` on a PR with
and without findings to confirm hydrated `review_output` before trusting clean runs.

**Codex CLI shape.** Installed Codex CLI treats `codex exec review --base` and a
custom `[PROMPT]` as mutually exclusive. The pack wrapper scopes via prompt text
(`git diff <base>...HEAD`) and stdin prompt mode, not `--base` plus stdin together.

**Windows reviewer sandbox.** The `op-rev-*` read-only sandbox must allow shell
spawns (operator `~/.codex/config.toml`, e.g. `[windows] sandbox = unelevated`).
Otherwise Codex may return an empty review without inspecting the diff.

Regression guards: `scripts/check-review-command-preflight.ps1`,
`scripts/check-orchestrator-rules-quotes.ps1` (via `scripts/verify.ps1`).

### Respawn-induced review disarray (Issue #98)

After a worker is lost and replaced, the AO-local review layer can misbehave in
five recognizable ways. Recovery is CLI-first; see
`docs/orchestrator-recovery-runbook.md` (**Orphan review run after worker respawn**).

| Signature | Symptom | Pack fix / operator action |
|-----------|---------|----------------------------|
| **Run-storm** | Multiple `ao review run` on the same PR head sha within minutes | `orchestratorRules` **REVIEW RUN IDEMPOTENCY** (Issue #189): head is covered when any run matches same `prNumber` + exact `targetSha` and is in-flight or `clean` / `needs_triage` / `waiting_update`; re-read list immediately before `ao review run` |
| **Redundant review on clean head** | Orchestrator turns keep firing `ao review run` while PR head is unchanged and a `clean` run already exists | Same covered-head rule; `failed` / `cancelled` on current head use EMPTY REVIEW TRAP retry-once, not plain re-run |
| **prNumber-less merged run** | After merge cleanup, run has no `prNumber` but `needs_triage` / `waiting_update` | **MERGED PR — REVIEW LOOP TERMINAL**: resolve PR via `linkedSessionId` + `ao status`; inaction when linkage ambiguous |
| **Orphan `needs_triage`** | Open findings on a run whose `linkedSessionId` is `terminated` / `killed` | `ao session claim-pr <pr> <new-session>` then fresh review; do not `ao review send` to dead session |
| **Detached-HEAD `gh` error** | `gh: could not determine current branch: not on any branch` in reviewer workspace | Pack resolves PR via `headRefOid` / `AO_PR_NUMBER` — not bare `gh pr view`; see `scripts/lib/Get-AutoReviewPrContext.ps1` |
| **Stale-workspace `worktree add`** | `git worktree add … already exists`, `findingCount: 0`, `status: failed` | `pwsh -NoProfile -File scripts/reviewer-workspace-preflight.ps1 -RepoRoot .` before retry |
| **Silent `ao review send` failure** | Findings never reach worker after respawn | Orphan run on dead session — use claim-pr + new run, or UI dismiss (manual) |

**Canonical respawn recovery entry point:**

```powershell
ao session claim-pr <pr-number> <new-worker-session-id>
pwsh -NoProfile -File scripts/reviewer-workspace-preflight.ps1 -RepoRoot .
# then ao review run on the new session when idempotency allows
```

Inspect runs with:

```powershell
ao review list orchestrator-pack --json
```

Fields: `linkedSessionId`, `status`, `openFindingCount`, `terminationReason`.

To adopt Issue #98:

1. Merge updated `orchestratorRules` (**REVIEW RUN IDEMPOTENCY**, **STALE REVIEWER
   WORKSPACE**) from `agent-orchestrator.yaml.example` into live yaml.
2. Restart AO: `ao stop` then `ao start`.

Regression guards: `scripts/check-orchestrator-review-idempotency.ps1`,
`scripts/check-auto-review-pr-context.ps1`, `scripts/check-reviewer-workspace-preflight.ps1`
(via `scripts/verify.ps1`).

### Covered-head review idempotency (Issue #189)

Widens **REVIEW RUN IDEMPOTENCY** so the LLM orchestrator turn loop matches the
mechanical reconciler (`review-trigger-reconcile.ps1` / `docs/review-trigger-reconcile.mjs`):
a head is covered by same `prNumber` + exact normalized `targetSha` plus in-flight or
`clean` / `needs_triage` / `waiting_update`. `failed` / `cancelled` on the current head stay
on EMPTY REVIEW TRAP (retry once, not plain re-run). **PRE-RUN COVERAGE RE-CHECK** requires
re-reading `ao review list --json` immediately before `ao review run`.

**MERGED PR — REVIEW LOOP TERMINAL** now covers runs with no `prNumber` when the linked
worker session's PR is merged (resolve via `linkedSessionId`). Unresolvable linkage →
orchestrator inaction (surface for operator).

To adopt Issue #189:

1. Merge updated `orchestratorRules` (**REVIEW RUN IDEMPOTENCY**, **MERGED PR — REVIEW
   LOOP TERMINAL** prNumber-less clause) from `agent-orchestrator.yaml.example` into live
   `agent-orchestrator.yaml`.
2. Restart AO: `ao stop` then `ao start`.
3. Optional smoke: with a PR at one head that already has `clean`, confirm no new runs in
   `ao review list --json` across orchestrator turns until the head advances.

Regression guards: `scripts/check-orchestrator-review-head-coverage.ps1`,
`scripts/review-orchestrator-loop.test.ts` (via `npm test`), plus updated
`scripts/check-orchestrator-review-idempotency.ps1` (via `scripts/verify.ps1`).

### Switching local reviewer: Codex ↔ Claude Sonnet (Issue #86)

**REVIEW_COMMAND** is reviewer-agnostic: `scripts/invoke-pack-review.ps1` (see
`agent-orchestrator.yaml.example`). The operator sets **`PACK_REVIEWER`** to
`codex` or `claude`. On Windows, **User-level** `PACK_REVIEWER` is enough for
review spawn when AO children lack process-scoped inheritance; process-level
export before `ao start` remains recommended for daemon boot env. Layer
precedence: Process → User → Machine (User overrides Machine when process is
unset). Non-Windows: process scope only — no persistent-env fallback in this
pack. The entrypoint dispatches to `scripts/run-pack-review.ps1` or
`scripts/run-pack-review-claude.ps1`. Unset/invalid `PACK_REVIEWER` in all
consulted layers fails closed (no reviewer run, no Codex default).

**Operator migration from Issue #79.** If live `agent-orchestrator.yaml` still
names `run-pack-review.ps1` or `run-pack-review-claude.ps1` in **REVIEW_COMMAND**,
copy the **NAMED REVIEW_COMMAND** line from the example (`invoke-pack-review.ps1`)
and set `PACK_REVIEWER` to match the reviewer you were using. Gitignored
`.ao/run-pack-review-claude.ps1` remains deprecated.

**Strict gate (Issue #79 + #86).** CI runs `scripts/invoke-pack-review-strict-gate.ps1`
on fixtures (no `ao` / `gh`). The gate checks empty-failed trap and
**selector mismatch** (executed wrapper vs `PACK_REVIEWER` / fixture
`expectedReviewer`). Operators run `scripts/orchestrator-diagnose.ps1 -Strict`
when AO is live.

Step-by-step: [`docs/reviewer-switch-runbook.md`](reviewer-switch-runbook.md).
After **PACK_REVIEWER** or YAML changes, restart AO (`ao stop` then `ao start`).

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

#### After `ao` upgrade — verify worker #2074 patch (Windows)

**When:** after every `npm i -g @aoagents/ao@…` (or any global AO install that
reinstalls `@aoagents/ao-plugin-agent-cursor`). Upgrades **do not** apply the patch
automatically until upstream [#2074](https://github.com/ComposioHQ/agent-orchestrator/issues/2074)
ships in the pinned plugin.

**Pass criteria** in `dist/index.js` `getLaunchCommand` (Windows worker path with
`config.prompt`):

- contains `ao-worker-prompt-` (temp task prompt file);
- emits **two** `cat` calls (`systemPromptFile` + `taskPromptFile`), not
  `printf %s` with the task prompt inlined into argv.

The non-Windows `else` branch may still use `printf %s` — that is expected. A
failed upgrade removes the `ao-worker-prompt-` block entirely.

```powershell
$plugin = Join-Path (npm root -g) "@aoagents\ao\node_modules\@aoagents\ao-plugin-agent-cursor\dist\index.js"
if (-not (Test-Path -LiteralPath $plugin)) {
  throw "cursor plugin not found: $plugin"
}
$src = Get-Content -LiteralPath $plugin -Raw
$hasPatch = $src -match 'ao-worker-prompt-' -and $src -match 'cat \$\{shellEscape\(taskPromptFile\)\}'
if (-not $hasPatch) {
  throw @"
Worker #2074 patch missing in:
  $plugin
Expected: ao-worker-prompt- temp file + two cat calls (no printf %s for config.prompt on Windows).
Re-apply the 'Local workaround' steps above, then run node --check on this file.
"@
}
node --check $plugin
Write-Host "OK: worker #2074 file-delivery patch present"
```

If workers again show Signature A (`printf` not recognized) or B (`command line is
too long`) right after an `ao` upgrade, run this check before re-spawning.

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
   **Legacy (native Windows, retired):** `scripts/unlock-op-orchestrator-worktree.ps1`
   — do not use on Ubuntu/WSL2; script removal is tracked in the scripts port
   (Issue #41). On Linux, use `scripts/orchestrator-worktree-preflight.ps1` and
   process hygiene per the recovery runbook.
3. **Before every `ao start` on Windows:**

   ```powershell
   if (Test-Path "$env:USERPROFILE\.ao\bin\agent") {
     Write-Error "Remove ~/.ao/bin/agent before ao start (see migration_notes.md)"
   }
   ```

4. **Workers on Windows** — durable fix is [#2074](https://github.com/ComposioHQ/agent-orchestrator/issues/2074);
   do not reintroduce `~/.ao/bin/agent` as a standing workaround. After every
   `npm i -g @aoagents/ao@…`, run the **After `ao` upgrade — verify worker #2074
   patch** check above (`ao-worker-prompt-` + two `cat`, not reverted `printf %s`).

#### Recovery sequence (EPERM or dead orchestrator)

**Linux / WSL2:**

```powershell
pwsh -NoProfile -File scripts/orchestrator-worktree-preflight.ps1 -Apply
ao stop
ao start
pwsh -File scripts/wait-orchestrator-launch.ps1
```

**Legacy (native Windows only, retired):** `scripts/unlock-op-orchestrator-worktree.ps1`
was the Windows Handle-based helper — not supported on the Linux-only port; do
not run it on Ubuntu/WSL2.

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

### Ubuntu / Linux-first config and docs (Issue #117)

Issue #117 makes `agent-orchestrator.yaml.example` and operator-facing docs
**Linux-first** (Ubuntu / WSL2 Ubuntu, pwsh 7+). Native Windows is no longer a
runtime target (decision §P).

**Operator adoption** — after merge:

1. Merge `agent-orchestrator.yaml.example` into live `agent-orchestrator.yaml`,
   including the updated `orchestratorRules` (pwsh **REVIEW_COMMAND**, no retired
   Windows PowerShell 5.1 launch-hazard prose).
2. Set `projects.*.path` to target repos on **ext4** (`/home/...`). Move clones
   and AO state off **`/mnt/c`** if you used WSL with Windows paths.
3. Provision the environment per
   [`docs/ubuntu-setup-runbook.md`](ubuntu-setup-runbook.md) (snap npm prefix,
   `/snap/bin` on `PATH`, `appendWindowsPath=false` in `/etc/wsl.conf`, agent
   CLIs).
4. Restart AO: `ao stop` then `ao start` (and wake listener/heartbeat if used).

See also [`README.md`](../README.md) (Linux baseline) and decision §P in
[`issues_drafts/00-architecture-decisions.md`](issues_drafts/00-architecture-decisions.md).

### Coworker RTK on AO Cursor workers (Issue #145)

Optional RTK compaction for worker shells is **opt-in** and **host-global** (`~/.cursor/hooks.json`
affects orchestrator and workers on the same machine). No tracked yaml change is required.

**Operator adoption** — after merge (full steps in
[`docs/coworker-rtk-runbook.md`](coworker-rtk-runbook.md)):

1. Record a pre-enable baseline (recent worker PRs: Codex findings, CI, iteration churn).
2. Install coworker; `coworker rtk install` only — do not enable yet.
3. `pwsh -NoProfile -File scripts/apply-coworker-rtk-passthrough.ps1` — verify all pack
   patterns in `coworker rtk passthrough list` (log upstream-default drift if any).
4. `coworker rtk enable` → hook smoke from the runbook.
5. Run the **7-day** qualitative observation window; conclude `continue` | `extend` | `disable`.
6. Rollback: `coworker rtk disable` — do not hand-edit `hooks.json` for routine disable.

Architecture: decision §R in
[`issues_drafts/00-architecture-decisions.md`](issues_drafts/00-architecture-decisions.md).

### RTK net-savings inventory (Issue #199)

Measured missed-savings follow-up to #145. No passthrough manifest change on the current
**no-go** kill-gate path.

**Operator adoption** — after merge:

1. Regenerate the missed-savings inventory on the operator host:
   `pwsh -NoProfile -File scripts/invoke-rtk-discover-inventory.ps1` (optionally
   `-AllProjects -SinceDays 90`). Archive output if useful — numbers are machine-local.
2. No RTK enable/disable or passthrough change required for **no-go** (broad `ao ` unchanged).
3. Restart AO (`ao stop` / `ao start`) so workers load updated **RTK read-exploration**
   guidance in `prompts/agent_rules.md`.

Full method: [`docs/rtk-missed-savings-inventory.md`](rtk-missed-savings-inventory.md).

## Operator adoption contract

Merged worker PRs often change `agent-orchestrator.yaml.example` and docs while
live yaml, listeners, and restarts stay stale. This pack assigns **who documents,
who executes, and when**:

| Role | Responsibility | Timing |
|------|----------------|--------|
| **Architect (issue spec)** | When a task touches operator-facing surfaces, the draft includes an **Operator adoption** subsection under Binding surface listing post-PR steps (yaml merge, processes, env, restart, verification). | Before implementation starts. |
| **Worker** | Before successful completion: add the same checklist to the PR under `## Operator adoption` (near the top) and add or update a matching subsection here. Workers document; they do not treat listeners, secrets, or live yaml merge as done unless the operator confirms. | PR ready (verification green, review clean). |
| **Operator (human)** | Execute the checklist after merge (or before local end-to-end test). Owns gitignored config and long-running processes. | After PR merge. |

**Operator-facing surfaces** (trigger the contract): `agent-orchestrator.yaml.example`;
runbooks that introduce new operator processes; documented operator env vars;
machine-local config outside the repo; `orchestratorRules` or `reactions` changes
requiring `ao stop` / `ao start`.

Umbrella go-live checklist:
[`docs/orchestrator-autoloop-go-live.md`](orchestrator-autoloop-go-live.md).

**Waiver:** cosmetic-only `.example` edits with zero operator follow-up may omit
`migration_notes.md` when the PR body contains this exact line on its own:
`No operator adoption required` (CI enforces; misuse should fail review).

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
3. `ao stop` then `ao start`; run `scripts/orchestrator-wake-supervisor.ps1 -Action Start`
   (preferred — Issue #168) or the manual listener + heartbeat pair in separate
   terminals, and `scripts/review-trigger-reconcile.ps1` in another terminal.

## Orchestrator wake supervisor (Issue #168)

After merge, replace the two-terminal wake startup with the supervisor:

1. Stop any manual `orchestrator-wake-listener.ps1` / `orchestrator-wake-heartbeat.ps1`
   processes (Ctrl+C or close those terminals).
2. From the pack root, with `ao start orchestrator-pack` running:
   `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/orchestrator-wake-supervisor.ps1 -Action Start`
3. Confirm: `... orchestrator-wake-supervisor.ps1 -Action Status` shows listener and
   heartbeat running.
4. Optional: set `AO_ORCHESTRATOR_SESSION_ID` before Start to pin the session id;
   otherwise the supervisor resolves from `ao status` and re-targets on change.

State, PID files, and per-child logs live under
`%LOCALAPPDATA%/orchestrator-pack-wake-supervisor/` (Linux:
`$XDG_STATE_HOME/orchestrator-pack-wake-supervisor/`). Stop with `-Action Stop`.

Manual two-script startup remains documented as fallback in
`docs/orchestrator-wake-runbook.md`.

## Side-process supervisor — full autoloop set (Issue #205)

After merge, use **one** supervisor for all registry-managed side-processes (listener,
heartbeat, review-trigger reconcile, CI-green wake reconcile, review-send reconcile,
delivery-confirm). Replaces separate Terminal D/F reconcile launches and the
#168-only listener+heartbeat+review-send scope.

1. `pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1 -Action Stop` (best effort).
2. Stop any manual reconcile / listener / heartbeat processes still running.
3. `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/orchestrator-wake-supervisor.ps1 -Action Start`
4. Confirm: `-Action Status` lists **all** registry children as `running`.
5. Optional env: `AO_WAKE_SUPERVISOR_ID_DEBOUNCE_POLLS` (default 2),
   `AO_WAKE_SUPERVISOR_SESSION_GLITCH_POLLS` (default 2),
   `AO_WAKE_SUPERVISOR_RESTART_STAGGER_MS` (default 500).

Registry: `scripts/orchestrator-side-process-registry.json` — add new long-running
side-processes here in the same PR that introduces the process.

## State-derived review-trigger reconciliation (Issue #163)

Adds `scripts/review-trigger-reconcile.ps1`: observes open PR heads via `gh`,
coverage via `ao review list --json`, and starts `ao review run` for uncovered heads
when a worker session is already linked. **Never** `ao spawn`, `--claim-pr`,
`ao session kill`, or `ao send` from this process.

To adopt after merge:

1. Merge the **STATE-DERIVED REVIEW TRIGGER** block from
   `agent-orchestrator.yaml.example` into live `orchestratorRules` (documentation
   for operators; the process is the script, not a YAML scheduler).
2. Start reconciliation in a dedicated terminal (default **20**-minute interval):
   `pwsh -NoProfile -File scripts/review-trigger-reconcile.ps1`
3. Optional env: `AO_REVIEW_TRIGGER_RECONCILE_INTERVAL_MINUTES`,
   `AO_REVIEW_TRIGGER_RECONCILE_STATE`.
4. Verify: `pwsh -NoProfile -File scripts/review-trigger-reconcile.ps1 -Once -DryRun`
   then confirm `ao review list --json` shows a run for an uncovered PR head.

See `docs/orchestrator-autoloop-go-live.md` and
`docs/orchestrator-recovery-runbook.md` (State-derived review trigger).

## Head-ready review gate (Issue #195)

Adds `docs/review-head-ready.mjs`: one shared **head ready for review** predicate for
report-driven triggers, `ROUND PROGRESSION`, and `review-trigger-reconcile.ps1`. Review runs
start only after `ready_for_review` for the exact head (or orchestrator degraded-CI branch
after #186 worker hand-off), with required CI green/pending (red defers; missing visibility
→ bounded re-attempt + operator escalation). Uncovered-but-not-ready heads take no review
run and no reconciler lifecycle action.

To adopt after merge:

1. Merge the **HEAD READY FOR REVIEW** block from `agent-orchestrator.yaml.example` into
   live `orchestratorRules` (including updated TRIGGER REVIEW, STATE-DERIVED REVIEW TRIGGER,
   and ROUND PROGRESSION sections).
2. Pull `prompts/agent_rules.md` (**Head ready for review** section).
3. Restart AO: `ao stop` then `ao start`.
4. Restart `scripts/review-trigger-reconcile.ps1` if it runs as a standalone loop (the script
   now fetches `gh pr checks` and branch-protection required-check names per tick).
5. Optional env: `AO_REVIEW_DEGRADED_CI_MAX_ATTEMPTS` (default **3**).
6. Verify fixtures: `npx vitest run scripts/review-head-ready.test.ts scripts/review-trigger-reconcile.test.ts`
   and `pwsh -NoProfile -File scripts/review-trigger-reconcile.ps1 -Once -DryRun`.

See `docs/orchestrator-autoloop-go-live.md` and `docs/review-head-ready.mjs`.

## Reconcile defer subreason and liveness (Issue #212)

Issue #212 makes `review-trigger-reconcile.ps1` defer decisions self-explaining: each
`skip` log line carries a structured `record=` with `primary`, `failedComponents`, and
`observed` snapshot values. Ready heads converge on the reconciler's own tick — no
cached same-head defer.

**No config change required.** No new YAML block; restart the reconcile loop only if
it is already running as a standalone process so it loads the updated script.

To adopt after merge:

1. Pull updated `scripts/review-trigger-reconcile.ps1` and `docs/review-head-ready.mjs`.
2. If `review-trigger-reconcile.ps1` runs standalone, restart that process (supervisor
   restart also suffices when Issue #168/#205 wiring is active).
3. When a PR is stuck without review, read `primary` and `observed` from the reconcile
   log per `docs/orchestrator-recovery-runbook.md` (Diagnosing a deferred PR).

## Review-finding delivery confirmation (Issue #171)

Adds `scripts/review-finding-delivery-confirm.ps1`: observes `waiting_update` runs with
`sentFindingCount > 0` from `ao review list --json`, confirms receipt only when the linked
worker reports `addressing_reviews` (or `fixing_ci` / `ready_for_review`) after send,
then bounded `ao review send` re-delivery or escalation. **Never** `ao spawn`,
`--claim-pr`, `ao session kill`, or `ao send`.

To adopt after merge:

1. Start in a dedicated terminal (default **5**-minute tick and confirmation window):
   `pwsh -NoProfile -File scripts/review-finding-delivery-confirm.ps1`
2. Optional env: `AO_REVIEW_DELIVERY_CONFIRM_INTERVAL_MINUTES`,
   `AO_REVIEW_DELIVERY_CONFIRM_WINDOW_MINUTES`,
   `AO_REVIEW_DELIVERY_CONFIRM_MAX_REDELIVERIES` (default **2**),
   `AO_REVIEW_DELIVERY_CONFIRM_STATE`.
3. Verify: `pwsh -NoProfile -File scripts/review-finding-delivery-confirm.ps1 -Once -DryRun`

See `docs/orchestrator-recovery-runbook.md` (Review finding delivery unconfirmed).

## Source-agnostic worker message submit (Issue #232)

Adds `scripts/worker-message-submit-reconcile.ps1`: unified submit arbiter that presses
Enter for any AO-delivered pending-draft worker message (multi-line or >200 chars),
regardless of sender. Folds in Issue #216 submit; delivery-confirm (#171) no longer
submits. Observes AO events, pack dispatch journal, and review-run state — never pane text.

**New supervised child** under `orchestrator-wake-supervisor.ps1` (#205).

To adopt after merge:

1. Merge updated `scripts/orchestrator-side-process-registry.json` (includes
   `worker-message-submit-reconcile` child).
2. Restart the supervisor so the new child starts: `ao stop` then `ao start`.
3. Optional env: `AO_WORKER_MESSAGE_SUBMIT_INTERVAL_SECONDS` (default **30**),
   `AO_WORKER_MESSAGE_SUBMIT_STATE`, `AO_WORKER_MESSAGE_DISPATCH_JOURNAL`.
4. Verify: `pwsh -NoProfile -File scripts/worker-message-submit-reconcile.ps1 -Once -DryRun`

Audit signal: submit reconcile state file `audit` array and log lines
`[worker-message-submit-reconcile]` with submit/no-op/escalation reasons.

See `docs/orchestrator-recovery-runbook.md` (Submit stuck paste draft).

## Review-ready worker stuck guard (Issue #174)

Adds `docs/review-ready-stuck-guard.mjs`: classifies a **consistent snapshot** when a
live worker flagged `stuck` / `probe_failure` is actually review-ready (owns current PR
head, CI green, `ready_for_review` for that head, **clean** review run — not
`waiting_update`). Plans **hold_grace** (default **15** minutes, monotonic per
session+head) or **recycle_escalate** when affirmative unreachability evidence exists;
forbids blind `ao spawn` / `--claim-pr` on the guard path.

To adopt after merge:

1. Merge the **REVIEW-READY WORKER STUCK GUARD** block from
   `agent-orchestrator.yaml.example` into live `orchestratorRules`.
2. Restart AO so rules reload: `ao stop` then `ao start`.
3. Optional env: `AO_REVIEW_READY_STUCK_GRACE_MINUTES` (default **15**).
4. Verify fixtures: `npx vitest run scripts/review-ready-stuck-guard.test.ts`.

See `docs/orchestrator-recovery-runbook.md` (Review-ready worker false stuck).

## Terminal Device-Attributes flood detection (Issue #173)

Adds read-only `scripts/terminal-flood-detect.ps1` and `docs/terminal-flood-detect.mjs`:
flags session-local sustained `ui.terminal_connected` / `ui.terminal_disconnected` pairs
from `ao events` (signature `terminal_mux_paired_flap`). **Does not** fix the flood —
upstream reset/throttle is
[ComposioHQ/agent-orchestrator#2094](https://github.com/ComposioHQ/agent-orchestrator/issues/2094)
(`active-blocked-upstream`).

To adopt after merge:

1. When a worker shows flood symptoms (CPU pegged, unsubmitted paste, stalled review),
   run:
   `pwsh -NoProfile -File scripts/terminal-flood-detect.ps1 -SessionId <worker-session-id>`
2. Optional env: `AO_TERMINAL_FLOOD_WINDOW_SECONDS` (default **60**),
   `AO_TERMINAL_FLOOD_MIN_PAIRED_CYCLES` (default **6**).
3. Follow `docs/orchestrator-recovery-runbook.md` (Terminal Device-Attributes flood):
   stop the dashboard terminal view → verify signature subsided → re-deliver via Issue #171
   run evidence when quiet.

## Orchestrator wake listener (webhook + local HTTP)

Issue #39 adds an event-driven wake path so the orchestrator session gets a turn
when AO emits urgent/action notifications. Issue #59 adds a separate low-frequency
heartbeat process so the orchestrator still gets turns during event silence.

To adopt on an existing live `agent-orchestrator.yaml`:

1. Merge the `notifiers.webhook` block from `agent-orchestrator.yaml.example`
   (default URL `http://127.0.0.1:17487/ao-wake`).
2. Merge `notificationRouting` so `urgent` and `action` include `webhook` (keep
   your other notifier channels).
3. Set `AO_ORCHESTRATOR_SESSION_ID` to your orchestrator session id (from
   `ao status`) or pass `-OrchestratorSessionId` when starting the listener.
4. Prefer the supervisor (Issue #168):
   `pwsh -File scripts/orchestrator-wake-supervisor.ps1 -Action Start`
   **Manual fallback:** start the listener and heartbeat in separate terminals:
   `pwsh -File scripts/orchestrator-wake-listener.ps1` and
   `pwsh -File scripts/orchestrator-wake-heartbeat.ps1`
6. Verify reachability:
   `Test-NetConnection -ComputerName 127.0.0.1 -Port 17487`
7. Optional dry-run (logs forward decisions without calling `ao send`):
   `pwsh -File scripts/orchestrator-wake-listener.ps1 -DryRun`
   `pwsh -File scripts/orchestrator-wake-heartbeat.ps1 -DryRun -Once`

Full operator steps, dedup window, heartbeat interval, and failure detection are in
`docs/orchestrator-wake-runbook.md`. When the listener is stopped, AO and workers
continue normally; the heartbeat still delivers periodic orchestrator turns until
it is stopped too (and vice versa).

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

## Coworker read-delegation audit (Issue #255)

Phase 1 lowers the ask volume floor to **400 lines**, folds pure file-count and bootstrap
triggers into T1, and adds a **stop-time read-delegation audit** on Claude (`Stop`) and
Cursor (`stop`). The audit flags missed bulk reads; it does **not** block reads.

**Operator adoption** — after merge (full steps in
[`docs/coworker-read-delegation-audit.md`](coworker-read-delegation-audit.md)):

1. Resync machine-local policy mirrors (`~/agent-rules/coworker-policy.md`,
   `~/.codex/AGENTS.md`, `~/.cursor-global`) from `prompts/agent_rules.md`.
2. Add `scripts/invoke-read-delegation-audit-stop.ps1` to `~/.cursor/hooks.json` (`stop`)
   and `.claude/settings.json` (`Stop`) using the documented JSON snippets.
3. Verify `~/.orchestrator-pack/read-delegation-audit.jsonl` receives `work_unit_verdict`
   lines after a completed work unit on each surface.
4. Restart AO: `ao stop` then `ao start` so workers load recalibrated thresholds.

## RCA spec discipline (Issue #221)

After merge of the worker PR that adds RCA/spec discipline rules and
`check-draft-discipline` guards:

1. Pull `prompts/agent_rules.md` (**RCA spec discipline** section),
   `prompts/investigate_root_cause.md`, and the updated architect skills.
2. Restart AO so workers load the new rules: `ao stop` then `ao start`.
3. Optional: run `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command surfaces -RepoRoot .`
   to confirm loader surfaces are wired.

## External-output fixture shape guard (Issue #223)

After merge, CI runs `scripts/check-external-output-shape-guard.ps1` (also
`npm test` via `scripts/external-output-shape-guard.test.ts`). No operator
adoption beyond normal CI.

**Refresh path (AO / gh version bump):**

1. Capture scrubbed raw output under `tests/external-output-references/captures/`
   for the affected command variant (see per-variant `*.provenance.json` for the
   prior capture command and scrub log).
2. Update the matching `tests/external-output-references/variants/**` reference
   (`allowedFields`, `forbiddenFields`, `forbiddenTogether`) so fixtures remain
   anchored to real per-state shapes — do not weaken the guard to silence drift.
3. Extend `tests/external-output-references/trigger-fixture-classification.json`
   when new trigger-test fixture roots or inline opt-outs are added; move
   anchored families out of `inventory.json` when covered.
4. Run `node scripts/external-output-shape-guard.mjs` and
   `npm test -- scripts/external-output-shape-guard.test.ts` locally; push so
   reviewers see the reference diff.

**Owner:** orchestrator-pack maintainers / PR author touching trigger fixtures.

## Read-delegation audit reviewer-path capability (#264)

Post-merge, no machine-local hook JSON rewrite is required if Claude and Cursor
already invoke `scripts/invoke-read-delegation-audit-stop.ps1`. Operators should
run a fresh no-side-effect ordinary session on each surface and confirm the live
JSONL artifact records `reviewerPath:false` and `inDenominator:true` for an
ordinary trigger-firing unit. The metric summary now also exposes
`denominatorCause` and `reviewHookCaptureBranch`; `unknown` capability or
`all-excluded` denominator cause is degraded/fail-loud, not a clean zero.
