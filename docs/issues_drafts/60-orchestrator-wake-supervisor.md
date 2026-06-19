# Single supervisor for the orchestrator wake processes (listener + heartbeat)

GitHub Issue: #168

## Prerequisite

- The wake mechanism (GitHub #39, `14-orchestrator-wake-mechanism.md`) and the
  heartbeat backstop (GitHub #59) — already shipped as
  `scripts/orchestrator-wake-listener.ps1` and
  `scripts/orchestrator-wake-heartbeat.ps1`. This issue does not change their
  internal behaviour; it supervises them.
- Relates to GitHub #163 (`58-safe-review-trigger-reconciliation.md`) — the
  durable fix that removes review-triggering's dependence on the orchestrator
  turn. This supervisor is the **reliability band-aid for the wake mechanism**,
  not a substitute for #163; see **Out of scope** / **Goal**.

## Goal

Replace the manual "open two terminals and run two commands" step with a single
operator entry point that brings up the wake listener and the heartbeat together
and keeps both alive. Today an operator must remember to start both, in two
terminals, with the right session id exported; if either is forgotten or dies
silently (the exact cause of the PR #162 incident — heartbeat simply not
running), the orchestrator stops getting woken and the review→fix loop stalls.
One supervised entry point removes that whole failure class.

## Binding surface

- **One entry point starts both.** A single operator command launches the wake
  listener and the heartbeat. The operator no longer runs two commands in two
  terminals.
- **Supervision / auto-restart.** The supervisor monitors both children and
  restarts either one if it exits, so a silent death cannot leave a gap.
- **Two independent processes — never merged.** The listener and heartbeat MUST
  remain separate processes with no shared failure path: the supervisor launches
  and monitors two children, it does not fold them into one loop. This preserves
  the §H Decision 2 invariant — the heartbeat stays independent of the
  webhook-receipt path so a single stoppage cannot silence both wakes. A design
  that merges them into one process fails this issue.
- **Session-id resolution (the key behaviour) — owned by the supervisor.**
  Resolution happens at the supervisor layer, which controls child start/stop;
  the children keep their existing contract of receiving the id via the
  `AO_ORCHESTRATOR_SESSION_ID` environment variable and are otherwise unchanged.
  - An explicit override (`AO_ORCHESTRATOR_SESSION_ID` set in the supervisor's
    environment) is honoured when set.
  - When unset, the supervisor **resolves the id from `ao status`** for the
    project (the session whose role is orchestrator) rather than hardcoding it,
    and supplies it to each child it launches.
  - The supervisor resolves before (re)starting a child, and **re-resolves and
    restarts both children (listener and heartbeat) when the orchestrator
    session id changes** (e.g. the orchestrator restarts under a new id) — never
    one child while the other keeps waking the stale id. The children are never
    left running against a stale id; the supervisor drives this by controlling
    child lifecycle, not by changing the children's wake path.
  - **The orchestrator session disappearing at runtime** (after the children are
    up) is also handled: the supervisor stops or suspends both children rather
    than letting them keep waking a now-nonexistent id, and returns to the
    waiting state until a session reappears (then relaunches both against it).
  - **No orchestrator session yet** is a wait-or-report condition, never a crash
    and never a blind wake: the supervisor waits (bounded poll) with a clear
    status before launching the children against a session, proceeds once one
    appears, and on a chosen timeout exits with an actionable message ("start
    `ao` for project X first"). It MUST NOT launch a child pointed at a
    nonexistent or unrelated session.
- **Detached + logged.** The supervised processes run detached from the
  launching terminal, with their output captured to logs, so failures are
  visible after the fact.
- **Status and stop.** The operator can query whether both are up and stop both
  cleanly from the same entry point.
- **Operator adoption** (introduces a new operator process):
  - The go-live / recovery runbook is updated so the supervisor is the
    documented way to bring up the wake processes, replacing the two-terminal
    manual steps; the manual commands remain documented as the fallback.
  - Any new operator env var or flag the supervisor introduces is documented,
    with safe default behaviour when unset.

## Files in scope

- `scripts/**` — the supervisor entry point and its tests (new files as the
  planner declares them), consistent with the existing wake scripts.
- `docs/**` — go-live and recovery runbook updates
  (`orchestrator-autoloop-go-live.md`, `orchestrator-recovery-runbook.md`).
- Test fixtures for the supervision and id-resolution scenarios.

## Files out of scope

- `packages/core/**`, `vendor/**`, `.ao/**`.
- The internal decision logic of `orchestrator-wake-listener.ps1` and
  `orchestrator-wake-heartbeat.ps1` — supervised, not rewritten. Touch them only
  if a clean start/stop signal genuinely requires it.
- `agent-orchestrator.yaml` / `.example` and reactions — no orchestration wiring
  change.
- Review-trigger liveness — removing the dependence of review triggering on the
  orchestrator turn is GitHub #163, not this issue. This supervisor only keeps
  the wake processes reliably running; if the orchestrator is wedged in a way a
  wake cannot recover, that is #163's domain.

## Denylist

```denylist
# issue 60 — orchestrator wake supervisor
vendor/**
packages/core/**
.ao/**
```

```allowed-roots
scripts/**
docs/**
```

## Acceptance criteria

1. A single documented command starts both the listener and the heartbeat as
   **two separate processes**; both are observable as running afterwards.
2. If either child process exits, the supervisor restarts it. Provable by a test
   that terminates one child and asserts it comes back.
3. The two processes are independent: stopping the webhook/listener path does
   not stop the heartbeat, and stopping the heartbeat does not stop the
   listener. Provable by a test asserting no shared-fate termination.
4. Session-id resolution (supervisor-owned): with `AO_ORCHESTRATOR_SESSION_ID`
   set, the children are launched with that id; with it unset, the supervisor
   resolves the id from `ao status` (project orchestrator session) and supplies
   it to the children. Provable by tests for both paths.
5. With no orchestrator session present, the supervisor does **not** crash and
   does **not** send a wake to a nonexistent/unrelated session; it surfaces a
   clear waiting status and, once a session appears, targets it. Provable by a
   fixture with no orchestrator session then one appearing.
5a. If no orchestrator session ever appears, the supervisor does **not** wait
   forever or fail vaguely: after the bounded poll it exits (or surfaces) with
   an actionable message naming the project and the "start `ao` first" remedy.
   Provable by a fixture where no session appears within the bound, asserting
   the bounded outcome and the message — not an infinite wait.
6. When the orchestrator session id changes (e.g. restart under a new id), the
   supervisor re-resolves and restarts **both** children (listener and
   heartbeat) against the new id, so subsequent wakes target the new id, not the
   stale one and no child is left on the old id. Provable by a test that changes
   the resolved id mid-run and asserts both children are restarted with the new
   id.
6a. When the orchestrator session disappears at runtime (after the children are
   up), the supervisor stops or suspends both children rather than continuing to
   wake the now-nonexistent id, and returns to the waiting state. Provable by a
   fixture where a running session disappears, asserting both children stop
   waking the stale id.
7. A status query reports both up/down; a stop command stops both cleanly.
8. The go-live / recovery runbook documents the supervisor as the operator
   entry point (with the manual two-terminal commands kept as fallback).
   Provable by inspecting the runbook.
9. The children run **detached** from the launching terminal and their output
   is captured to logs: closing or exiting the launching shell does not stop
   them, and each child's output is retrievable from its log afterwards.
   Provable by a test/fixture asserting child survival independent of the
   launching shell and the presence of per-child log output.

## Upgrade-safety check

- No edits to `packages/core/**`, `vendor/**`, or `.ao/**`.
- No new repository secrets and no new GitHub Actions permissions.
- No change to AO orchestration wiring (`agent-orchestrator.yaml`, reactions).
- The two wake processes stay independent — the supervisor never merges them
  into a single shared-fate process.
- The wake listener and heartbeat decision logic is unchanged.

## Verification

- Automated tests over fixtures cover: both children start as separate processes
  (criterion 1); a killed child is restarted (criterion 2); independence / no
  shared-fate stop (criterion 3); id override vs `ao status` resolution
  (criterion 4); no-session wait-and-report without a blind wake (criterion 5)
  and the bounded no-session-ever timeout with its actionable message
  (criterion 5a); both children relaunched on an id change (criterion 6) and
  both children stopped/suspended when the session disappears at runtime
  (criterion 6a); status/stop (criterion 7); detached child survival past the
  launching shell plus per-child log output (criterion 9). Run via the pack test
  runner.
- Grep confirms the runbook documents the supervisor entry point and keeps the
  manual fallback (criterion 8).
- Live smoke (operator, optional): run the single command, confirm both
  processes are up via the status query, kill one, confirm it restarts, then
  stop both cleanly.
