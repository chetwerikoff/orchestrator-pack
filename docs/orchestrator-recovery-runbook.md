# Orchestrator recovery runbook

Operator procedure when AO observability flags the orchestrator session
(e.g. `op-orchestrator`) as **`stuck`** or **`probe_failure`** while workers,
review runs, or open PRs still need coordination.

This runbook is **manual and read-only until escalation step 3**. It does not
add schedulers, daemons, or automatic recovery. After recovery, the orchestrator
resumes the autonomous review-loop decision procedure defined in
`agent-orchestrator.yaml.example` (`orchestratorRules`) and
`docs/migration_notes.md` (Issue #28).

For first-time setup and the full autoloop checklist (processes, live YAML,
verification), see [`docs/orchestrator-autoloop-go-live.md`](orchestrator-autoloop-go-live.md).

When review runs show `failed` with `findingCount: 0`, run
`.\scripts\orchestrator-diagnose.ps1` first — that pattern is an **empty failed
review**, not a clean pass. Before declaring mergeable, run
`.\scripts\orchestrator-diagnose.ps1 -Strict` (live AO) so command drift and the
empty-review trap fail closed. See `docs/migration_notes.md` (empty-review trap).
When Claude is the active reviewer, `terminationReason` should name
`run-pack-review-claude.ps1`; with Codex, `run-pack-review.ps1`.

For a **healthy orchestrator process that never reacts to CI/review events**, see
[`docs/orchestrator-wake-runbook.md`](orchestrator-wake-runbook.md) (wake listener) before killing sessions.

### Launch failure vs orchestrator stuck (decision table)

| Symptom | Inspect first | Pack pointer |
|---------|---------------|--------------|
| **Worker** exits within ~1 minute of spawn, no PR, no `ao acknowledge` | Worker session PTY | `docs/migration_notes.md` — **Worker** prompt-delivery launch failure (Issue #63) |
| Workers fail at spawn with Signature A/B **right after** `npm i -g @aoagents/ao@…` | `@aoagents/ao-plugin-agent-cursor` `dist/index.js` | `docs/migration_notes.md` — **After `ao` upgrade — verify worker #2074 patch** (`ao-worker-prompt-`, two `cat`) |
| **Orchestrator** `stuck` / `probe_failure` / `detecting` within ~1 minute of `ao start`, `ao session kill` + respawn, or restore | Orchestrator session PTY (`op-orchestrator`) | `docs/migration_notes.md` — **Orchestrator** prompt-delivery launch failure (Issue #91) |
| Spawn logs show `workspace.branch_collision` on `orchestrator/*` | Stale branch/worktree before kill/restart | `scripts/orchestrator-worktree-preflight.ps1` (Issue #91) |
| `ao start` → `EPERM` on `worktrees/op-orchestrator` | Orphan `pwsh` / `cursor-agent` holding the directory | `scripts/orchestrator-worktree-preflight.ps1 -Apply`; `docs/migration_notes.md` |
| Same on **legacy native Windows** (retired) | Orphan processes + 9P locks | **Do not use** `unlock-op-orchestrator-worktree.ps1` on Linux — see migration_notes (legacy) |
| Orchestrator PTY empty, `alive:false`, exit **0** under ~1s | `~/.ao/bin/agent` bash shim shadows real `agent` | Remove shim; `Test-Path ~/.ao/bin/agent` must be **False** before `ao start` |

**Signatures A/B** (worker **and** orchestrator on Windows): Signature A — `printf` not
recognized / `unknown option '-ne'`; Signature B — `command line is too long`.
Do **not** ping or kill `op-orchestrator` for a **worker-only** spawn death.
Do **not** treat worker launch failure as orchestrator stuck.

**Cursor restore metadata:** `restoreFallbackReason: cursor.getRestoreCommand returned null`
is **expected** — AO falls back to `getLaunchCommand`. It is not a standalone defect.

`workspace.branch_collision` on workers (`feat/*`) is separate hygiene; orchestrator
preflight targets **`orchestrator/<session-id>`** only.

## When to use this runbook

| Signal | Meaning |
|--------|---------|
| Dashboard / `ao status` shows orchestrator `stuck` or `probe_failure` | AO lifecycle probe thinks the session stopped making progress |
| Evidence such as `idle_beyond_threshold` | Process may still be alive; the session is not taking turns |
| Open workers, `needs_triage` / `waiting_update` review runs, or PRs awaiting orchestration | Work is not actually finished — recovery may be required |

Legitimate idle (no recovery): no active workers, no review runs in
`needs_triage`, `waiting_update`, `queued`, `preparing`, or `running`, and no
worker stuck in `addressing_reviews` / `fixing_ci` / `ready_for_review` with an
open review path. The orchestrator may simply have nothing to do.

## Scope guard `missing_issue_link` with `Closes #N` visible on GitHub

When **only** the **PR scope guard** job fails and the Actions log says the PR
description must include `Closes #N` / `Fixes #N`, but the PR page already shows
that reference:

1. Confirm the closing line targets the **task** issue (not a docs-only sibling).
2. Confirm `Closes #N` is in the PR body (not only the branch name or a comment).
3. Re-run the failed workflow on the current head. Scope guard reads the full body
   via `gh pr view` (not `github.event.pull_request.body` in workflow `env`).
4. If CI is still red, have the worker move `Closes #N` directly under
   `## Summary`, push, and report `ao report fixing_ci` → `ready_for_review`.
5. Nudge the orchestrator if the session stays idle after green CI:

```powershell
ao send <worker-session-id> @'
PR scope guard is green. Report fixing_ci if needed, then ready_for_review.
Orchestrator: resume review loop for this PR head per orchestratorRules.
'@
```

Do not kill the orchestrator for this pattern alone — it is a **CI / PR-body**
problem, not probe failure.

## Red CI with idle worker (Issue #109)

**Required CI** matches `prompts/agent_rules.md` and `orchestratorRules` in
`agent-orchestrator.yaml.example`: GitHub **required status checks** for the PR base
when branch protection lists them; otherwise all pack merge-contract checks on the
PR head (`scope-guard` jobs: Verify orchestrator-pack structure, PR scope guard, Run
pack contract tests, Self-architect lint).

### Op-6 class (false `ready_for_review`, then idle)

Symptoms: required CI red on the PR head; worker `reportState` is `ready_for_review` or
was recently; worker idle with no new commits; long gap before any fix.

1. Confirm red CI: `gh pr checks <pr> --repo chetwerikoff/orchestrator-pack` (or your
   project repo).
2. Inspect turns and pings — did the orchestrator act on the **catching turn**?

```powershell
ao events list --json
ao status --reports full
```

Look for an early orchestrator `ao send` with CI-fix context **before** only
`report-stale` (~30 minutes since last report) or a late `ci-failed` reaction. In the
2026-05-31 op-6 episode, the catching turn was the worker `ready_for_review` report while
CI was still red; pack rules expect an orchestrator ping on that turn, not ~30 minutes
later.

3. **Manual unblock** — ping the worker (do not assume a separate architect session woke
   it):

```powershell
ao send <worker-session-id> @'
Required CI is still red on this PR head. Run gh pr checks, ao report fixing_ci, fix CI,
then ready_for_review only when required CI is green. Do not treat the task as done on red CI.
'@
```

4. If the worker stays idle after ping, use review-loop respawn discipline in
   `orchestratorRules` or `ao spawn --claim-pr <n>` per runbook #40.

Upstream note: first lifecycle `ci_failed` transition may show `recoveryAction: null` —
that is AO core behaviour; this pack closes the gap on **orchestrator turns**, not on
CI-event-driven turns alone.

### Gated + silently idle (residual risk)

Symptoms: worker **never** reported `ready_for_review` on red CI (gate worked or worker
stayed in `fixing_ci`), but session is idle with red required CI and no commits.

Pack `orchestratorRules` are **turn-driven** — no worker report and no other wake means
no orchestrator turn, so pack CI ping rules do not run. Expect only:

- `reactions.report-stale` (~30 minutes), then `send-to-agent`, and/or
- `reactions.ci-failed` when AO delivers it, and/or
- operator `ao send` or kill-respawn (steps below).

Do not wait indefinitely; manual `ao send` as in op-6 class or escalate per
[Escalation overview](#escalation-overview).

## Stuck vs legitimately idle

Run these **before** any kill or full restart. Optionally use the one-screen
helper:

```powershell
pwsh -File scripts/orchestrator-diagnose.ps1
```

### Observable signals

1. **Active workers** — `ao status --reports full` (or `--json --reports full`).
   Workers in non-terminal statuses (`working`, `spawning`, `waiting_input`, etc.)
   with recent activity or an open PR imply the orchestrator should still be
   driving the loop.

2. **Review runs needing orchestrator action** — `ao review list --json`.
   Flag runs in `needs_triage` (findings not sent) or `waiting_update`
   (findings sent, worker response pending) with `openFindingCount > 0`.

3. **Workers awaiting review response** — in `ao status --reports full`, look for
   `reportState` of `addressing_reviews`, `fixing_ci`, or `ready_for_review` on
   worker sessions tied to open PRs.

4. **Orchestrator lifecycle recency** — `ao events list --since 30m --kind session.stuck`
   and `ao events list --since 2h --type lifecycle.transition -s <orchestrator-id>`.
   A long gap since the last `lifecycle.transition` on the orchestrator session,
   while signals 1–3 are non-empty, supports **stuck** rather than idle.

5. **Recent stuck events** — `session.stuck` events for the orchestrator session
   confirm AO already classified the session as stuck.

If 1–3 are all clear, prefer **no kill**: send a light ping (step 1) or wait;
the observability flag may clear on the next natural turn.

## Escalation overview

| Step | Action | Blast radius |
|------|--------|--------------|
| 1 | `ao send` diagnostic nudge | None — one orchestrator turn |
| 2 | Inspect (`ao status`, `ao review list`, diagnose helper) | None — read-only |
| 3 | `ao session kill <orchestrator-id>` then `ao start` | Orchestrator session only |
| 4 | `ao stop` then `ao start` | Full AO daemon, dashboard, YAML reload |

Do not skip step 2 before step 3 or 4.

---

## Step 1 — Ping (least invasive)

Give the orchestrator session a turn without killing anything.

```powershell
ao send op-orchestrator @'
Recovery ping: ao review list orchestrator-pack --json; ao status --json --reports full.
For any worker with ready_for_review and no clean run on the current PR head, run exactly one review:
  ao review run <worker-session-id> --execute --command "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/run-pack-review.ps1 --repo-root . --base origin/main"
Copy that --command string verbatim from orchestratorRules PACK_REVIEW_SHELL. Forbidden: plugins/ao-codex-pr-reviewer/bin/review.ps1 alone, npm ci && chains, cmd /c without quoting, ao review run without --command.
failed or cancelled with findingCount 0 is NOT clean — read terminationReason before retry.
'@
```

Replace `op-orchestrator` with your orchestrator session id from `ao status`.

**Operator-only review (orchestrator stuck):** run the same `--command` yourself — do not improvise:

```powershell
ao review run <worker-session-id> --execute --command "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/run-pack-review.ps1 --repo-root . --base origin/main"
```

### Before

- Note workers mid-**git push**, mid-**`ao review send`**, or mid-**`ao spawn`**
  (recent `lifecycle.transition` / activity on that worker). A ping alone is safe;
  wait for those to finish if you are about to escalate to step 3+.

### After (wait one to two minutes, then re-check)

```powershell
ao status --reports full
ao events list --since 5m --type lifecycle.transition -s op-orchestrator
```

**Success:** orchestrator status moves off `stuck` / `probe_failure`, new
`lifecycle.transition` (e.g. `stuck → working`), and/or orchestrator activity
shows it processed `ao review list` / sent triage / pinged a worker per
`orchestratorRules`.

**Insufficient:** still stuck with non-empty signals from [Stuck vs idle](#stuck-vs-legitimately-idle) → step 2, then 3 if needed.

---

## Step 2 — Inspect (read-only)

Assemble state before any kill.

```powershell
ao status --reports full
ao review list --json
ao events list --since 30m --kind session.stuck
ao events list --since 2h --type lifecycle.transition -s op-orchestrator
```

Or:

```powershell
pwsh -File scripts/orchestrator-diagnose.ps1 -OrchestratorSessionId op-orchestrator
```

### Before

Same as step 1: identify workers in fragile windows (push, `ao review send`,
respawn). **Do not proceed to step 3** while a worker is in those windows unless
you accept manual follow-up on that PR.

### After

Record:

- Orchestrator session id and status.
- Each active worker: session id, status, PR, latest `reportState`.
- Review runs in `needs_triage` / `waiting_update` with counts.
- Whether a ping was already sent this episode (`ao events list` for `ao send`
  to workers).

This snapshot is your baseline for step 3 **after** checks.

---

## Step 2b — Orchestrator worktree hygiene (before step 3)

When spawn or event logs mention `workspace.branch_collision` on
`orchestrator/op-orchestrator` (or your configured orchestrator id), or
`scripts/orchestrator-diagnose.ps1` lists stale orchestrator worktrees/branches,
clean up **before** step 3:

```powershell
pwsh -File scripts/orchestrator-worktree-preflight.ps1
# optional destructive apply:
pwsh -File scripts/orchestrator-worktree-preflight.ps1 -Apply
```

Then `ao start` and confirm no repeated `branch_collision` in spawn logs.

### Step 2c — Worktree `EPERM` and `~/.ao/bin/agent` shim (before step 3)

**Linux / WSL2 (supported):** clear orphan processes holding the orchestrator
worktree, then preflight:

```powershell
pwsh -NoProfile -File scripts/orchestrator-worktree-preflight.ps1 -Apply
```

See `docs/ubuntu-setup-runbook.md` (ext4 paths) and `docs/migration_notes.md`.

**Legacy — native Windows only (retired):** the subsection below documents
historical Windows-only prevention. Do **not** run
`scripts/unlock-op-orchestrator-worktree.ps1` on Ubuntu/WSL2 (script retirement
is Issue #41).

<details>
<summary>Legacy native Windows (retired)</summary>

Run from **external PowerShell** (not the Cursor agent terminal) when:

- `ao start` fails with `EPERM, Permission denied` on `...\worktrees\op-orchestrator`, or
- `Remove-Item` on that directory fails with “used by another process”, or
- the orchestrator pipe shows `alive:false` with almost no scrollback right after start.

**Prevention (do not repeat):** see `docs/migration_notes.md` — **Windows orchestrator
prevention**. In short: never leave `~/.ao/bin\agent`; clear orphans with Handle +
targeted `taskkill /T`; confirm `Test-Path "$env:USERPROFILE\.ao\bin\agent"` is
**False** before `ao start`; use [#2074](https://github.com/ComposioHQ/agent-orchestrator/issues/2074)
for workers, not a standing bash shim in `~/.ao/bin`.

**One-shot recovery (legacy, do not use on Linux):** formerly
`scripts/unlock-op-orchestrator-worktree.ps1` (retired with the Ubuntu port).

</details>

## Step 3 — Kill orchestrator session and restart AO

Respawns **only** the orchestrator agent session; workers and review state remain
in AO storage.

Run step **2b** first when stale `orchestrator/*` worktree/branch exists.

```powershell
ao session kill op-orchestrator
ao start
pwsh -File scripts/wait-orchestrator-launch.ps1
```

Use your orchestrator id. `ao start` recreates the orchestrator per project
config (same as a normal daemon start after kill).

### Before

- Complete step 2.
- **Unsafe to kill orchestrator now** if any worker is mid-push, mid-`ao review send`,
  or mid-`ao spawn` / `ao session kill` + respawn chain — wait or finish that
  operation first.
- Prefer workers to be in a stable report state (`working`, `addressing_reviews`,
  or terminal) when possible.

### After

```powershell
ao status --reports full
ao review list --json
```

**Success:**

- New orchestrator session appears (may have a new name if your config respawns
  with a fresh id — check `ao status` for `role: orchestrator`).
- Prior workers still listed with same PR/issue linkage.
- Review runs unchanged in `ao review list` (`needs_triage` / `waiting_update`
  still present until the new orchestrator acts).
- No worker left without a session while PR still open (if one vanished, use
  `ao spawn --claim-pr <n>` per `orchestratorRules`).

Then send one recovery nudge (step 1 message) if the new session does not
auto-run within a minute.

---

## Step 4 — Full `ao stop` / `ao start` (last resort)

Restarts the AO daemon, dashboard, and reloads `agent-orchestrator.yaml`. Use only
when step 3 fails, the daemon is unhealthy, or YAML was just changed.

```powershell
ao stop
ao start
```

Optional: `ao start --restore` to bring back sessions from last stop (see `ao start --help`).

### Before

- Same worker safety as step 3; also ensure no other operator is running `ao stop`.
- Note all open PR numbers and worker session ids from step 2.

### After

```powershell
ao status --reports full
ao review list --json
```

Verify workers and review runs reappear; re-run step 1 nudge on the orchestrator
if it does not resume the review loop on its own.

---

## Re-attach after orchestrator restart

**Named section: persistence and re-discovery.**

AO keeps durable state outside the orchestrator chat session:

| Artifact | Across orchestrator kill / `ao stop` |
|----------|--------------------------------------|
| Worker sessions | Remain in AO session store (unless explicitly killed) |
| Review runs (`needs_triage`, `waiting_update`, etc.) | Remain in `ao review list` |
| PR / CI metadata | Unchanged |
| Orchestrator chat context | **Lost** — new session has no memory of prior turns |

After step 3 or 4, the **new** orchestrator session must **re-discover** work on
its first turns using the same commands as `orchestratorRules`:

```text
ao review list --json
ao status --json --reports full
ao events list --json
```

Expected behavior:

- Runs in **`needs_triage`** with `openFindingCount > 0` should receive
  `ao review send <run-id>` when the orchestrator runs the loop again — **except**
  when the linked PR is already merged on GitHub (see [After manual PR merge](#after-manual-pr-merge)).
- Runs in **`waiting_update`** resume **waiting_worker_review_response**; the
  orchestrator applies ping/respawn discipline — it does not re-send findings
  unless a new review round is required — **unless** the linked PR is merged
  (terminal; no ping or respawn for review on that PR).
- Workers in **`addressing_reviews`** / **`fixing_ci`** should be left alone
  unless the loop rules say otherwise.
- Side-processes (if used): prefer `scripts/orchestrator-wake-supervisor.ps1 -Action Stop`
  then `-Action Start` after recovery (registry-managed listener, heartbeat, reconcilers,
  delivery-confirm — Issue #205). Manual fallback is per-script launches — see
  `docs/orchestrator-autoloop-go-live.md` and `docs/orchestrator-wake-runbook.md`.

Nothing in this runbook auto-merges PRs or kills workers; that stays in
`orchestratorRules`.

## State-derived review trigger (Issue #163)

When an open PR head has **no** `ao review list` coverage (no in-flight, clean,
`needs_triage`, or `waiting_update` run for that SHA) and the worker never reported
`pr_created` / `ready_for_review` — or the LLM orchestrator is `stuck` and not
taking turns — start the low-frequency reconcile process (review-run **only**; it
never spawns, claims, kills, or pings workers):

```powershell
cd <orchestrator-pack-root>
pwsh -NoProfile -File scripts/review-trigger-reconcile.ps1
```

Verify wiring without starting a review:

```powershell
pwsh -NoProfile -File scripts/review-trigger-reconcile.ps1 -Once -DryRun
```

Confirm a run appears after an uncovered head exists:

```powershell
ao review list orchestrator-pack --json
```

Default cadence is **10 minutes** (`AO_REVIEW_TRIGGER_RECONCILE_INTERVAL_MINUTES`
overrides). PRs without a linked worker session in `ao status --json --reports full`
are skipped until respawn discipline creates one — the reconcile process must not
call `ao spawn --claim-pr` (PR #97 split-brain guard).

### Diagnosing a deferred PR (Issue #212)

When review does not start and the reconcile log shows `skip PR #N: …`, read the
structured `record=` JSON on the same line (or the skip action from a fixture /
`-DryRun` plan). Each defer names a **primary** subreason, the full
**failedComponents** set, and **observed** snapshot values — sufficient to choose
the recovery path without re-deriving the timeline by hand.

| Primary / branch | Meaning | Operator path |
|------------------|---------|---------------|
| `no_worker_session` | No live worker session linked to the PR head | Respawn / `--claim-pr` discipline — reconciler does not spawn or claim |
| `no_ready_for_review` | Worker has not handed off for the exact head | Worker liveness: `report-stale`, ping, respawn — not degraded-CI orchestrator branch |
| `stale_report_binding` | `ready_for_review` exists but bound to an older head SHA | Wait for worker `ready_for_review` on current head; read `staleReadyForReviewHeadSha` (and `reportBoundHeadSha` when no current-head report exists) in `observed` |
| `degraded_ci_handoff` (`reportRoute: degraded_ci`) | Worker escalated missing/unresolvable required checks | Orchestrator degraded-CI branch (#195): bounded reconcile retries, then escalation |
| `ci_red` | Required CI failing on the head | Fix CI on the PR head |
| `ci_degraded` / `ci_not_yet_observed` | Required-check set missing or not yet visible | Inspect `gh pr checks` / branch protection; see `requiredCheckSource` and `requiredCheckNames` in `observed` |
| `failed_or_cancelled_on_head` | EMPTY REVIEW TRAP on current head | Read `terminationReason` in `observed`; retry-once discipline |
| `head_covered` | #189 coverage — in-flight or covered-terminal run on same PR + head | No new run until head advances |

**Liveness:** the reconciler re-reads report binding, CI, and coverage every tick.
A head that becomes ready after an earlier defer is started on the **next reconcile
tick** — no orchestrator heartbeat required. Prior defer verdicts are not cached.

Example log line:

```text
[2026-06-06 01:48:20] review-trigger-reconcile: skip PR #211: uncovered_not_ready record={"branch":"uncovered_not_ready","primary":"no_ready_for_review","failedComponents":["no_ready_for_review"],"observed":{"prNumber":211,"currentHeadSha":"1607071","reportBoundHeadSha":"none","reportRoute":"none","ciLevel":"green",...}}
```

## Review finding delivery unconfirmed (Issue #171)

`sent_to_agent` / `waiting_update` with `sentFindingCount > 0` means AO **attempted**
to inject findings — not that the worker received them or reported
`addressing_reviews`. When the worker input channel is flooded or stuck, findings can
strand silently ("review sent, 0 open findings") while CI stays green.

## First-send review findings undelivered (Issue #202)

When review completes to `needs_triage` (`openFindingCount > 0`, `sentFindingCount: 0`)
but the worker stays idle with no `ao review send`, the LLM orchestrator may not have
taken a turn (AO 0.9.x emits no wake on `review.needs_triage`; heartbeat backstop is slow).

Run the first-send reconcile loop (mechanical; no LLM-orchestrator turn required):

```powershell
cd <orchestrator-pack-root>
pwsh -NoProfile -File scripts/review-send-reconcile.ps1
```

Dry-run one tick (no `ao review send`, no state write):

```powershell
pwsh -NoProfile -File scripts/review-send-reconcile.ps1 -Once -DryRun
```

### Defaults and env overrides

| Setting | Default | Env var |
|---------|---------|---------|
| Tick interval | **2** minutes | `AO_REVIEW_SEND_RECONCILE_INTERVAL_MINUTES` |
| Persisted dedupe state file | `%TEMP%\orchestrator-review-send-reconcile-state.json` | `AO_REVIEW_SEND_RECONCILE_STATE` |

The loop sends only when `needs_triage`, `sentFindingCount: 0`, `openFindingCount > 0`,
`targetSha` equals the PR current head, linked session is live and head-owning (see
**Session runtime liveness** below), and the PR is not merged. It never calls
`ao spawn`, `--claim-pr`, `ao session kill`, `ao send`, `ao report`, or `ao review run`.
After send, `#171` owns confirmation / re-delivery. Prefer the wake supervisor
(`orchestrator-wake-supervisor.ps1 -Action Status`) so the process is supervised — not
a hand-started orphan daemon.

### Session runtime liveness (`linked_session_runtime_not_alive`; Issue #250)

Supervised reconcile logs `linked_session_runtime_not_alive` or `runtime_not_alive` when
the linked worker fails the shared **runtime-field** rule in
`docs/session-runtime-liveness.mjs`. Distinguish three cases before killing a session:

| Case | Signals | Action |
|------|---------|--------|
| **Genuine death** | `runtime: exited` / `process_missing`, or terminal session `status` (`killed`, `terminated`, `exited`, …) | Respawn / `--claim-pr` per dead-session runbook; do not expect reconcile send/nudge |
| **Shape / contract mismatch (historical)** | Worker operable, `ao status` row has **no** `runtime` field (AO 0.9.x), manual `ao review send` works | Fixed in Issue #250 — upgrade pack; absent `runtime` falls back to status + head ownership |
| **False stuck / flood (#174)** | `stuck` / `probe_failure` with review-ready snapshot, no unreachability evidence | Review-ready stuck guard grace — separate from runtime liveness; see **Review-ready worker false stuck** |

Present but non-`alive` `runtime` (including empty string or values like `unreachable`) is
**non-live** on all action-producing paths — fail closed even when session `status` is
`working`.

Run the sender-side delivery-confirmation loop (mechanical; no LLM-orchestrator turn
required):

```powershell
cd <orchestrator-pack-root>
pwsh -NoProfile -File scripts/review-finding-delivery-confirm.ps1
```

Dry-run one tick (no `ao review send`, no state write):

```powershell
pwsh -NoProfile -File scripts/review-finding-delivery-confirm.ps1 -Once -DryRun
```

### Defaults and env overrides

| Setting | Default | Env var |
|---------|---------|---------|
| Tick interval | **5** minutes | `AO_REVIEW_DELIVERY_CONFIRM_INTERVAL_MINUTES` |
| Confirmation window (wait before re-deliver) | **5** minutes | `AO_REVIEW_DELIVERY_CONFIRM_WINDOW_MINUTES` |
| Max best-effort re-deliveries per run | **2** | `AO_REVIEW_DELIVERY_CONFIRM_MAX_REDELIVERIES` |
| Persisted delivery state file | `%TEMP%\orchestrator-review-delivery-confirm-state.json` | `AO_REVIEW_DELIVERY_CONFIRM_STATE` |

Confirmation is credited only when the **linked** worker reports
`addressing_reviews`, `fixing_ci`, or `ready_for_review` **after** the send timestamp
— not from `sent_to_agent` alone and not from unrelated `working` activity. When two
or more unconfirmed runs share the same PR head and session, a single review-round
report does **not** confirm either run (ambiguous overlap stays unconfirmed).

Re-delivery uses `ao review send <run-id>` to the **existing** linked session when it
is still live and owns the PR. It never calls `ao spawn`, `--claim-pr`, `ao session kill`,
or `ao send`. If the linked session is dead/orphan, the loop **escalates immediately**
(zero re-sends).

### Submit stuck paste draft (Issues #216 / #232)

Draft submit is owned by **`scripts/worker-message-submit-reconcile.ps1`** (Issue #232):
a source-agnostic arbiter that presses tmux **Enter only** for AO-delivered pending-draft
messages (multi-line or >200 chars), regardless of sender. It observes AO events, the pack
dispatch journal, and review-run state — never pane text. Issue #216 submit is folded into
this process; delivery-confirm (#171) no longer presses Enter.

| Setting | Default | Env var |
|---------|---------|---------|
| Tick interval | **30** seconds | `AO_WORKER_MESSAGE_SUBMIT_INTERVAL_SECONDS` |
| Submit reconcile state | `%TEMP%\orchestrator-worker-message-submit-state.json` | `AO_WORKER_MESSAGE_SUBMIT_STATE` |
| Dispatch journal | `%TEMP%\orchestrator-worker-message-dispatch-journal.json` | `AO_WORKER_MESSAGE_DISPATCH_JOURNAL` |

Verify: `pwsh -NoProfile -File scripts/worker-message-submit-reconcile.ps1 -Once -DryRun`

Escalation lines are prefixed `[worker-message-submit-reconcile] ESCALATION:` with
operator-visible diagnosis when submit budget is exhausted or observation stayed ambiguous.

### Escalation message and operator remedy

When confirmation never arrives and re-deliveries are exhausted (or the linked session
is orphan), the process logs:

```text
[review-finding-delivery-confirm] ESCALATION: unconfirmed delivery for review run <run-id> (PR #<n>, session <session-id>). Operator remedy: ...
```

**Operator remedy:**

1. Open the worker session terminal — look for a flooded mux, stuck approval prompt, or
   unsubmitted paste (see **Terminal Device-Attributes flood** below).
2. Confirm `ao status --json --reports full`: linked session must be **live** and still
   on the PR. If `terminated` / `killed` / long `detecting`, do **not** `ao review send`
   into the orphan run — follow **Orphan review run after worker respawn** below.
3. After a live session owns the PR: `ao review send <run-id>` manually once, or start a
   fresh review round (`ao review run` on the live session) per orphan recovery steps.
4. Inspect persisted state (`AO_REVIEW_DELIVERY_CONFIRM_STATE`) — runs are
   `confirmed` vs `escalated`; escalated runs are not retried forever.

Distinct from `review-trigger-reconcile.ps1` (Issue #163), which only **starts** review
runs and never contacts workers.

## Review-ready worker false stuck (Issue #174)

A **live** worker that finished its task (`ready_for_review`, green required CI, clean
review run on the current head) can be misclassified `stuck` / `probe_failure` when the
dashboard terminal is DA-flooded (Issue #173) — the activity probe reads idle input as no
progress. Pack orchestration must **not** reflexively `ao spawn`, `--claim-pr`, kill, or
respawn that session without a consistent-snapshot check.

### Consistent snapshot (classification)

From `ao status --json --reports full`, `gh pr view` (current head), `gh pr checks`, and
`ao review list --json` (no pane scraping), a session is **review-ready** only when **all**
hold on the **same** head:

| Predicate | Source |
|-----------|--------|
| Session owns PR current head | `ownedHeadSha` / PR head match |
| Runtime alive | `runtime: alive` (not `exited` / `process_missing`) |
| Required merge-contract CI green | Same definition as `ready_for_review` in `agent_rules.md` |
| Last `ready_for_review` for that head | Report `headRefOid` matches current head |
| Covering **clean** run | `status: clean`, `findingCount: 0`, same head + `linkedSessionId` |

**Not protected:** `waiting_update` (mid-fix — Issue #171), red/pending CI, stale
`ready_for_review` on a prior head, dead runtime, or missing clean run.

Deterministic helper (fixtures + stdin JSON):

```powershell
node docs/review-ready-stuck-guard.mjs classify < snapshot.json
node docs/review-ready-stuck-guard.mjs plan < snapshot.json
```

Fixture examples: `scripts/fixtures/review-ready-stuck-guard/`.

### Bounded grace, then evidence-backed recovery

When classified review-ready on false stuck:

1. **Hold** — do **not** immediately kill, respawn, or `ao spawn --claim-pr`.
2. **Grace** — default **15** minutes (`AO_REVIEW_READY_STUCK_GRACE_MINUTES`), anchored
   once per `(session, PR head)` on the **first** false stuck; **monotonic** (repeated
   `stuck` reports do not extend grace).
3. **Within grace**, recovery requires **affirmative** unreachability only:
   - failed bounded reachability attempt to the session;
   - Issue #171 delivery **unconfirmed** or **escalated** for the linked run;
   - Issue #173 `terminal_mux_paired_flap` still flagged after stop-verify.
4. **Not evidence:** mere silence (no outbound report) — a quiet review-ready worker may
   have nothing to report until grace expires.
5. **When evidence exists** — prefer careful **recycle** (`ao session kill` + operator
   escalation/notify), **not** blind `ao spawn --claim-pr` (PR #97 split-brain).
6. **After grace** without affirmative unreachable evidence — normal stuck handling may
   resume.

Genuine death (`runtime` not alive) is **not** shielded — orphan/respawn discipline
(Issue #98) still applies.

### Operator adoption

Merge the **REVIEW-READY WORKER STUCK GUARD** block from `agent-orchestrator.yaml.example`
into live `orchestratorRules`, then:

```powershell
ao stop
ao start
```

See `docs/migration_notes.md` (Review-ready worker stuck guard).

## Terminal Device-Attributes flood (Issue #173)

**Queue status:** `active-blocked-upstream` — the durable fix (terminal reset/sanitize on
mux-attach + reconnect-loop throttle) is tracked at
[ComposioHQ/agent-orchestrator#2094](https://github.com/ComposioHQ/agent-orchestrator/issues/2094).
The pack does **not** patch AO core; this section is operator mitigation only.

### Symptoms

Recognise the flood before re-sending findings:

- Worker session is otherwise idle but **CPU stays high** (dashboard terminal re-rendering).
- `ao events list` shows sustained **`ui.terminal_connected` / `ui.terminal_disconnected`**
  cycling for the affected session (pack signature `terminal_mux_paired_flap`).
- Injected `ao send` / `ao review send` text appears in the worker pane as an **unsubmitted**
  `[Pasted text]` block — the agent never starts a turn.
- Review loop stalls with green CI and **0 open findings** while delivery confirmation
  (Issue #171) may show **unconfirmed** / **escalated** runs.

Read-only diagnostic (safe defaults: **60**-second window, **6** paired connect/disconnect
cycles minimum, **30**-second minimum span):

```powershell
cd <orchestrator-pack-root>
pwsh -NoProfile -File scripts/terminal-flood-detect.ps1 -SessionId <worker-session-id>
```

Fixture mode (no live `ao`):

```powershell
pwsh -NoProfile -File scripts/terminal-flood-detect.ps1 -FixturePath scripts/fixtures/terminal-flood-detect/positive-sustained-paired-flap.json
```

| Setting | Default | Env var |
|---------|---------|---------|
| Detection window | **60** seconds | `AO_TERMINAL_FLOOD_WINDOW_SECONDS` |
| Minimum paired mux cycles | **6** | `AO_TERMINAL_FLOOD_MIN_PAIRED_CYCLES` |
| Events fetch lookback | **5** minutes (`-SinceMinutes`) | — |

Exit code **2** means the signature fired for the requested session. The detector uses
**only** `ao events` JSON — it does **not** scrape tmux panes for `ESC[` sequences.

### Stop the reconnect loop

On the **dashboard client** (mux side), close the terminal view that is driving the
reconnect loop — typically the flooded worker session tab/panel. Do **not** kill the
worker session yet; stopping the flapping client is the first step.

### Post-stop verification

Re-run the diagnostic for that session and confirm the signature has **subsided** below
threshold (no `terminal_mux_paired_flap` flag):

```powershell
pwsh -NoProfile -File scripts/terminal-flood-detect.ps1 -SessionId <worker-session-id>
```

If churn **does not drop** within a few minutes (wrong tab closed, stale browser tab, or
external reconnect source), **recycle the session** (`ao session kill <id>` and respawn
per your normal worker discipline, or operator recycle policy) before attempting delivery
again.

### Re-deliver after verified quiet

Only **after** the channel is verified quiet:

1. Prefer Issue **#171** evidence — use the **unconfirmed** or **escalated** review run id
   from `scripts/review-finding-delivery-confirm.ps1` logs or
   `AO_REVIEW_DELIVERY_CONFIRM_STATE`, not a blind resend.
2. Confirm the linked worker is **live** and owns the PR head (`ao status --json --reports full`).
3. `ao review send <run-id>` once to the live session, or start a fresh review round if the
   run is orphan (see **Orphan review run after worker respawn** above).

Do not re-deliver while the mux signature is still flagged — duplicates and silent loss
are both possible.

## Orphan review run after worker respawn

When a worker session is **terminated**, **killed**, or stuck in **detecting** and
AO respawns a replacement (`ao spawn --claim-pr` or automatic respawn), review runs
linked to the **dead** session become **orphans**: they remain in `ao review list`
but `ao review send` cannot deliver findings to a live worker.

### Identify an orphan run

```powershell
ao review list orchestrator-pack --json
ao status --json --reports full
```

From `ao review list --json`, inspect each run for the PR:

| Field | Orphan signal |
|-------|----------------|
| `linkedSessionId` | Matches a worker session in `terminated`, `killed`, or long `detecting` |
| `status` | `needs_triage` with `openFindingCount > 0`, or `waiting_update` with findings never acked |
| `openFindingCount` | Non-zero on a dead linked session blocks merge until resolved |

Do **not** run `ao review send` on an orphan run whose `linkedSessionId` is dead —
delivery fails silently or errors; the worker will never see those findings.

### CLI-first recovery (canonical)

1. **Rebind the PR** to the new live worker session:

   ```powershell
   ao session claim-pr <pr-number> <new-worker-session-id>
   ```

   Example: `ao session claim-pr 97 op-3` after `op-1` died and `op-3` replaced it.

2. **Clear stale reviewer workspace** when the last failed run shows
   `worktree add` / `already exists` in `terminationReason`:

   ```powershell
   pwsh -NoProfile -File scripts/reviewer-workspace-preflight.ps1 -RepoRoot .
   ```

3. **Fresh review** on the live session (after `orchestratorRules` covered-head check —
   no in-flight or covered-terminal run on the current head sha for that PR; see Issue
   #189 — `clean` / `needs_triage` / `waiting_update` count as covered):

   ```powershell
   ao review run <new-worker-session-id> --execute --command "<REVIEW_COMMAND from agent-orchestrator.yaml>"
   ```

   Copy **REVIEW_COMMAND** verbatim from live `agent-orchestrator.yaml` /
   `agent-orchestrator.yaml.example` — do not improvise alternate commands.

4. When the new run reaches `needs_triage` with findings, the orchestrator (or you)
   may `ao review send <new-run-id>` — only on the **live** linked session.

### Manual escape hatch (UI dismiss)

When orphan runs still hold `openFindingCount > 0` and triage cannot reach the dead
session, dismiss findings in the AO dashboard: **Reviews → TRIAGE → resolve/dismiss**
for that run. Label this path **manual** in operator notes; it is not `ao review send`.

See also `docs/migration_notes.md` (**Respawn-induced review disarray**, Issue #98).

## After manual PR merge

When a worker PR is merged on GitHub (human merge per repo policy), AO 0.9.x
**worker** merge cleanup and **AO-local review** persistence are **decoupled**:

| Layer | After merge |
|-------|-------------|
| Worker session / worktree | AO tears down the worker session and worktree as usual |
| `code-reviews/` / `ao review list` | Runs often **remain** (`needs_triage`, `waiting_update`, etc.) |

That split is **expected**. AO core does not today cancel or mark review runs
`outdated` solely because the PR merged; upstream may add that later. This pack
does not require hand-editing review-run JSON under `.agent-orchestrator/`.

**Stale kanban cards are not stuck orchestration.** If `ao review list` still
shows active-looking runs for a **merged** PR, the orchestrator must **not**
treat them as backlog: `orchestratorRules` **MERGED PR — REVIEW LOOP TERMINAL**
(Issue #54, prNumber-less runs Issue #189) forbids `ao review send`, new
`ao review run`, review-loop `ao send` pings, and review-loop
`ao session kill` / `ao spawn --claim-pr` on that PR — including runs with no
`prNumber` when the linked worker session's PR is merged (resolve via
`linkedSessionId` in `ao status`). When linkage is missing or ambiguous, fail
closed to inaction and surface the run for the operator. Focus recovery and
planning on **open** PRs only.

**Redundant covered-head runs (Issue #189).** If multiple `clean` or
`waiting_update` runs exist for the same PR head SHA, the orchestrator should not
start another — widen live yaml per `agent-orchestrator.yaml.example` **REVIEW RUN
IDEMPOTENCY** and restart AO. Clearing historical cards is optional; policy is
inaction, not hand-editing `code-reviews/` JSON.

**Do not** `ao review send` to a worker session that is already `merged` or
`terminated` for that PR — findings cannot reach a live worker. Do not use
recovery step 1 ping text to force triage on merged PRs.

**No `ao review cancel`.** The AO CLI has no review cancel/dismiss command
today; document the gap, do not invent one in this pack.

**Wake listener:** review-related webhook wakes for a merged PR may still reach
the listener; suppression is on the orchestrator turn via `orchestratorRules`
(see `docs/orchestrator-wake-runbook.md`), not by editing wake-filter code.


## Automated review-start claim recovery (Issue #267)

Use the canonical operator adoption and recovery checklist in
[`docs/migration_notes.md`](migration_notes.md#automated-review-start-claim-issue-267).
For runbook triage, the key operational rules are: automated starters must not run when
the claim store is ambiguous or unavailable; operator resolution must first re-check current
review coverage and PR head state; and previous-generation child logs are retained as
`*.previous-*` files for incident reconstruction.

## Quick reference — safety checks

| Step | Before | After |
|------|--------|-------|
| 1 Ping | No worker mid-push / review-send / respawn if planning step 3 soon | Orchestrator left `stuck`; or decide to escalate |
| 2 Inspect | Capture fragile workers | Written snapshot of workers + review runs |
| 3 Kill orchestrator | No fragile workers; step 2 done | Orchestrator respawned; workers + runs still in `ao status` / `ao review list` |
| 4 Full restart | Same as 3; YAML/daemon issue | Daemon up; restore/spawn as needed; re-nudge orchestrator |

## Example (2026-05-27 style)

Observability: `op-orchestrator` **stuck**, evidence `idle_beyond_threshold`, process
alive, workers idle but review run in `waiting_update`.

1. **Ping** — `ao send` with review-loop reminder → orchestrator transitions
   `stuck → working` and processes backlog. **Stop here** if successful.
2. If still stuck with `needs_triage` pending → **inspect**, then **kill
   orchestrator + `ao start`**, verify `ao review list`, **ping** new session.
3. Reserve **`ao stop` / `ao start`** for daemon-level failure only.

## Related docs

- `docs/migration_notes.md` — autonomous review loop and wake listener adoption
- `docs/orchestrator-wake-runbook.md` — event-driven wakes (#39)
- `agent-orchestrator.yaml.example` — `orchestratorRules` (Issue #28)
