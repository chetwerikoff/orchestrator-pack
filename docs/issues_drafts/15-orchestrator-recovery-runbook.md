# Orchestrator recovery runbook — stuck / probe_failure handling

GitHub Issue: #40

## Prerequisite

- Issue #28 (file `docs/issues_drafts/11-orchestrator-autonomous-review-loop.md`)
  must be merged. The runbook references #28's decision procedure as the
  expected behavior after recovery.
- Issue #39 (file `docs/issues_drafts/14-orchestrator-wake-mechanism.md`)
  SHOULD be merged. Without #39, the runbook also needs to cover "the
  orchestrator session is healthy but cannot receive wake events", which
  is a #39 concern. With #39 merged, the runbook focuses on lifecycle
  failures.

## Goal

Document a deterministic operator procedure for the case when AO
observability flags the orchestrator session as `stuck` or
`probe_failure` while the worker queue still has open work. Today there
is no written runbook: operators improvise (`ao send` ping, full
`ao stop`/`ao start`, occasionally `ao session kill` and respawn) with
no shared notion of which is safe given the current in-flight state.

Observed gap (2026-05-27): observability flagged `op-orchestrator` as
`stuck` with evidence `idle_beyond_threshold` while the process was
alive. There was no documented recovery sequence; the operator
re-engaged by sending a message, which is fine for that case but offers
no signal for when sending a message is insufficient.

Observed failure mode (surfaced 2026-05-28, PR #56 triage): the
orchestrator can be **alive and taking turns yet still execute nothing**
because its agent (Cursor in a PTY) is blocked on a pending command-approval
prompt — so `ao review run`, `ao send`, and other shell-driven actions never
run even though the session looks active. A kill/respawn is the wrong remedy
here (it discards a healthy session's context); the fix is to clear/approve
the prompt or enable auto-approval for `ao` / `gh` / `powershell`. The
runbook must treat this as a distinct state, not lump it into "stuck".

This issue is **runbook + minor helper**, not new runtime mechanism. No
new plugin, no new event handling, no new YAML schema.

**Related (Issue #63):** when a worker exits immediately after spawn with no PR,
operators must use `docs/migration_notes.md` (worker prompt-delivery launch failure)
instead of this orchestrator-stuck runbook. The shipped runbook at
`docs/orchestrator-recovery-runbook.md` includes that pointer.

## Binding surface

This issue commits the repository to:

1. A short operator-facing recovery runbook explaining how to read AO
   observability state, how to distinguish a legitimately idle
   orchestrator from a stuck one, and the ordered escalation: ping →
   inspect → restart session → respawn → full `ao stop`/`ao start`.
2. A safety checklist for each escalation level — which in-flight
   states are safe to interrupt, which are not, and how to verify after
   each step that no worker or review run was orphaned.
3. Optionally, a thin helper script (PowerShell) that performs the
   first two diagnostic steps (inspect lifecycle state, list open
   review runs, list active workers) and prints a summary so the
   operator does not assemble the picture by hand.

## Files in scope

- `docs/orchestrator-recovery-runbook.md` (new) — the runbook itself.
  Plain operator prose, ordered escalation, safety notes, examples.
- `scripts/orchestrator-diagnose.ps1` (new, optional) — diagnostic
  helper. Read-only: shells `ao status --reports full`,
  `ao review list --json`, `ao events list --since 30m --kind
  session.stuck`, prints a one-screen summary the runbook references.
  No mutation, no kills. Planner picks the exact field set to surface.
- `docs/migration_notes.md` — short paragraph pointing operators at the
  new runbook when AO observability reports stuck states.
- `docs/issues_drafts/15-orchestrator-recovery-runbook.md` — this spec.

## Files out of scope

- `packages/core/**`, `vendor/**`, AO runtime, AO observability
  implementation.
- `agent-orchestrator.yaml` and `agent-orchestrator.yaml.example` —
  the runbook does not require config changes.
- `prompts/agent_rules.md` — workers do not consult this runbook.
- `prompts/codex_review_prompt.md` — owned by #9.
- Any change to #28's `orchestratorRules` — the runbook references that
  procedure but does not modify it.
- Any wake-event handling — that is #39.
- Automatic recovery / auto-respawn of the orchestrator. The runbook
  is **manual** by design; auto-recovery requires AO upstream changes
  and is explicitly excluded.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
.agent-orchestrator/**
prompts/**
plugins/**
.github/workflows/**
.claude/skills/**
agent-orchestrator.yaml
agent-orchestrator.yaml.example
docs/issues_drafts/11-orchestrator-autonomous-review-loop.md
docs/issues_drafts/14-orchestrator-wake-mechanism.md
docs/issues_drafts/06-codex-reviewer-scope-context.md
scripts/pr-scope-check.ps1
scripts/pr-scope-check.ts
scripts/pr-scope-check.test.ts
```

```allowed-roots
docs/orchestrator-recovery-runbook.md
docs/migration_notes.md
docs/issues_drafts/15-orchestrator-recovery-runbook.md
scripts/orchestrator-diagnose.ps1
```

## Acceptance criteria

- **Runbook present and operator-readable.**
  `docs/orchestrator-recovery-runbook.md` exists, written in plain
  prose, organised by ordered escalation steps. An operator unfamiliar
  with this project can follow it without consulting source code.
- **Stuck-vs-idle distinction.** The runbook documents how to tell a
  legitimately idle orchestrator (no in-flight work) from a stuck one,
  using observable signals from `ao status` and the AO event log:
  - active workers in non-terminal states,
  - review runs in `needs_triage` or `waiting_update`,
  - workers awaiting `addressing_reviews`,
  - elapsed time since the last `lifecycle.transition` event on the
    orchestrator session.
  The runbook MUST also document a **third state distinct from both idle and
  stuck — approval-blocked**: the orchestrator session is alive and receiving
  turns, but its Cursor PTY is waiting on a pending command-approval prompt, so
  no `ao` command actually executes. Detection: `ao session attach
  <orchestrator-session>` shows a "waiting for approval" prompt, or the session
  shows turn activity in `ao status` with no corresponding `ao` command effects
  in `ao events list`. The session id is read from AO session state, never
  inferred from the issue or PR number.
- **Approval-blocked ruled out before any escalation.** Before the ordered
  escalation below, the runbook MUST instruct the operator to rule out the
  approval-blocked state above: a pending command-approval prompt is resolved
  by approving/clearing it or enabling auto-approval for `ao` / `gh` /
  `powershell`, **never** by killing the session — the agent is healthy and a
  kill would discard its turn context.
- **Ordered escalation, lowest blast radius first.** The runbook lists,
  in order of increasing impact:
  1. `ao send <orchestrator-session> "<diagnostic prompt>"` — least
     invasive, just gives the session a turn.
  2. Inspect with `ao status --reports full`, `ao review list --json`,
     and the diagnostic helper (if shipped) before any kill.
  3. `ao session kill op-orchestrator` followed by `ao start` —
     respawns the orchestrator session only.
  4. Full `ao stop` / `ao start` — last resort, also restarts the
     dashboard and reloads YAML.
- **Safety check per step.** Each step has a "before" check (what
  in-flight state must be preserved or finished first) and an "after"
  check (how to confirm no worker or review run was orphaned). The
  runbook must NOT recommend killing the orchestrator while a worker is
  mid-push, mid-`ao review send`, or mid-respawn without the operator
  first verifying state.
- **Re-attach behavior documented.** The runbook documents what
  happens to existing review runs (`needs_triage`, `waiting_update`)
  and worker sessions when the orchestrator restarts: they continue to
  exist in AO state; the new orchestrator session must re-discover
  them via `ao review list` / `ao status` on its first turn.
- **Helper script (optional) is read-only.** If
  `scripts/orchestrator-diagnose.ps1` ships, it MUST be read-only — no
  `ao send`, no kills, no writes. Its job is to print a one-screen
  summary for the operator to read before deciding an escalation step.
- **`migration_notes.md` pointer.** A short paragraph in
  `docs/migration_notes.md` directs operators to the new runbook when
  AO observability reports `stuck` or `probe_failure` against the
  orchestrator session.
- **No new automation.** The runbook MUST NOT introduce automatic
  recovery, scheduled tasks, or background processes. Operator-driven
  by design.

## Upgrade-safety check

- No edits to `packages/core/**`, `vendor/**`, AO runtime, AO
  observability, the scope guard implementation, plugins, prompts, or
  the first-principles framework docs.
- No new repository secrets.
- No new dependencies in `package.json`.
- The diagnostic helper, if shipped, uses only Windows-default
  PowerShell facilities and shells `ao` commands already available in
  `ao --help`.

## Verification

- **Static — runbook readability.** A reader of
  `docs/orchestrator-recovery-runbook.md` can list, without
  consulting any other file, the four escalation steps in order and
  identify the safety check for each.
- **Static — re-attach behavior section.** The runbook contains a
  named section describing what happens to in-flight review runs and
  workers across an orchestrator restart.
- **Static — approval-blocked state covered.** The runbook contains a named
  section distinguishing the approval-blocked orchestrator (alive, looks
  active, but its Cursor PTY waits on command approval) from idle and stuck,
  with the `ao session attach` detection step and the "approve/clear or enable
  auto-approval, do not kill" remedy stated before the ordered escalation.
- **Static — no-automation invariant.** The runbook does not introduce
  any cron / scheduled task / background process. Verified by absence
  of such instructions.
- **Smoke — diagnostic helper read-only (if shipped).** Static read of
  `scripts/orchestrator-diagnose.ps1` shows no `ao send`, no
  `ao session kill`, no `ao stop`, no file writes outside transient
  stdout.
- **Smoke — repository policy.** `scripts/verify.ps1`,
  `scripts/check-reusable.ps1`, and `scripts/test-all.ps1` clean on
  the PR head.
- **Manual — dry-run against the current `op-orchestrator` state.**
  Run through the runbook against the current AO state (without
  actually killing anything) and confirm each step's "before" check
  produces a determinate answer.
