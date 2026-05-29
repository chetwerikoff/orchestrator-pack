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

For a **worker that exits within ~1 minute of spawn** with no PR, no
`ao acknowledge`, and no Cursor chat, see
`docs/migration_notes.md` (**Worker prompt-delivery launch failure on Windows,
Issue #63**) first. Inspect the worker terminal for Signature A (`printf` not
recognized / `unknown option '-ne'`) or Signature B (`command line is too long`).
That is **not** orchestrator stuck — do not ping or kill `op-orchestrator` for it.
`workspace.branch_collision` during spawn is a separate worktree-hygiene concern.

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

## Step 3 — Kill orchestrator session and restart AO

Respawns **only** the orchestrator agent session; workers and review state remain
in AO storage.

```powershell
ao session kill op-orchestrator
ao start
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
  `ao review send <run-id>` when the orchestrator runs the loop again.
- Runs in **`waiting_update`** resume **waiting_worker_review_response**; the
  orchestrator applies ping/respawn discipline — it does not re-send findings
  unless a new review round is required.
- Workers in **`addressing_reviews`** / **`fixing_ci`** should be left alone
  unless the loop rules say otherwise.
- Wake listener (if used) is separate — restart it if you run
  `scripts/orchestrator-wake-listener.ps1`; see `docs/orchestrator-wake-runbook.md`.

Nothing in this runbook auto-merges PRs or kills workers; that stays in
`orchestratorRules`.

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
