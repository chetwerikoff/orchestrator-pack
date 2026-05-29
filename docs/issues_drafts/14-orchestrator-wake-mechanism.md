# Orchestrator wake mechanism — event-driven local listener

GitHub Issue: #39

## Prerequisite

- Issue #28 (file `docs/issues_drafts/11-orchestrator-autonomous-review-loop.md`)
  must be merged. #28 defines the orchestrator's decision procedure for
  each turn. This issue is the complementary mechanism that makes sure
  the orchestrator **gets** a turn when AO events fire — without it,
  #28's autonomy is bounded by how often the operator sends a message.
- Issue #9 (file `docs/issues_drafts/06-codex-reviewer-scope-context.md`)
  should be merged. Wake events triggered on local Codex review
  completion are easier to reason about once NO_FINDINGS / wrapper
  failure modes are deterministic.

**Already shipped — this revision is a follow-up increment.** The
event-driven listener described by this draft merged as PR #47
(commit `bc95c09`): `scripts/orchestrator-wake-listener.ps1`,
`docs/orchestrator-wake-filter.mjs`, and the `webhook` notifier wiring are
in `main`. The sections below now also specify a **low-frequency heartbeat
wake**, added after the 2026-05-28 PR #56 incident where the orchestrator
sat idle (and then `stuck`) during event silence — AO emitted only
non-wake events, so a purely event-driven listener never gave the
orchestrator a turn. The heartbeat is the only new mechanism here; the
existing listener, wake-relevant filtering, and single-flight behavior stay
as-is and are NOT re-implemented.

## Goal

Add an event-driven local mechanism that wakes the AO orchestrator
session when a relevant AO event fires (review entered `needs_triage`,
worker reported `pr_created` / `ready_for_review`, CI failed,
`report-stale` triggered, etc.) **and at least once per low-frequency
heartbeat interval even when no event fires at all**, so the orchestrator
can apply #28's decision procedure (including its state-derived
reconciliation trigger) on a real schedule rather than only when the
operator types a message or AO happens to emit a wake-relevant event.

Observed gap (2026-05-28): live review runs `op-rev-11` and `op-rev-16`
sat in `needs_triage` for hours because the orchestrator was idle
between operator messages. `report-stale` reactions fired against
workers, never against the orchestrator session (per AO source:
`report-watcher.js` explicitly skips orchestrator-kind sessions). There
is no AO-native mechanism that wakes the orchestrator on these events.

## Binding surface

Primarily event-driven, **plus a low-frequency heartbeat backstop**. The
original strictly-event-driven, no-scheduler stance (shipped in #47) is
**deliberately relaxed by this revision**: a purely event-driven listener
cannot wake the orchestrator during event silence — exactly the 2026-05-28
PR #56 failure mode — so a coarse heartbeat is now in scope. The heartbeat
is NOT a busy-poller and NOT a ConPTY hack: it is a low-frequency turn
delivery (order of tens of minutes), and it MUST stay independent of the
webhook-receipt path so a single stoppage cannot silence both wakes at once
(see acceptance criteria). The mechanism is:

1. AO's existing **`webhook` notifier plugin** is configured in
   `agent-orchestrator.yaml.example` so AO POSTs to a local URL whenever
   it produces a notification at routing classes that warrant
   orchestrator attention (`urgent`, `action`).
2. A small local HTTP listener accepts those POSTs, derives the
   wake-relevant event kind from the payload, and translates each into a
   short `ao send <orchestrator-session-id> "<wake message>"`.
3. The orchestrator session, on its next AO-message-induced turn, runs
   #28's decision procedure as normal. The `<wake message>` is just a
   nudge with the event kind so the orchestrator's first action this
   turn is to inspect the relevant `ao review list` / `ao status` /
   `ao events list` slice.

This issue commits the repository to:

1. A listener script under `scripts/` that reads webhook POSTs, filters
   to wake-relevant event kinds, and shells `ao send`.
2. Configuration in `agent-orchestrator.yaml.example` (and matching
   migration paragraph) wiring the `webhook` notifier and adjusting
   `notificationRouting` so wake-relevant priorities reach it.
3. Documentation of which event kinds wake the orchestrator and which
   are filtered out (e.g. `info`-class chatter must NOT wake).
4. A runbook describing how an operator starts the listener alongside
   `ao start`, and how to detect listener failures.

## Files in scope

- `scripts/orchestrator-wake-listener.ps1` (new) — listener
  implementation. Planner picks: HTTP framework (native `HttpListener`
  is fine), port (defaults to a documented value, configurable via env
  var), payload-parsing model. Must run on the operator's local machine
  alongside AO, not on CI.
- `scripts/orchestrator-wake-listener.test.ts` (new) — unit tests for
  the event-kind filtering logic (which payloads wake vs which are
  dropped). The listener's HTTP layer can be mocked.
- The heartbeat mechanism (new, follow-up increment) — a separate helper
  and/or operator-side scheduled task that emits the periodic wake. The
  planner picks whether it is a standalone script, a Windows scheduled
  task wrapper, or another local timer, **provided it does not live inside
  the webhook-receipt code path** (see acceptance criteria). Tests cover
  the heartbeat decision/labelling logic the same way the filter is
  tested; the timer/scheduler layer can be mocked.
- `agent-orchestrator.yaml.example` — add the `webhook` notifier
  configuration and the `notificationRouting` additions. Coordinate with
  #28's example so the two contributions to this file do not collide:
  add to the `notifiers` and `notificationRouting` blocks, do not touch
  the `orchestratorRules` block.
- `docs/migration_notes.md` — paragraph instructing operators to start
  the listener alongside `ao start` and how to verify it.
- `docs/orchestrator-wake-runbook.md` (new) — short operator runbook:
  starting the listener, checking it is reachable, what to do if AO
  notifications stop arriving.
- `docs/issues_drafts/14-orchestrator-wake-mechanism.md` — this spec.

## Files out of scope

- `packages/core/**`, `vendor/**`, AO runtime.
- `agent-orchestrator.yaml` (local, gitignored) — the operator updates
  it from the example.
- `prompts/agent_rules.md` — workers do not interact with the listener.
- `prompts/codex_review_prompt.md` — owned by #9.
- `scripts/pr-scope-check.*` — guard implementation is separate.
- Any change to #28's `orchestratorRules` content — this issue only
  adds the mechanism that delivers turns; the decision procedure stays
  unchanged.
- High-frequency / busy polling of AO state. The heartbeat MUST be a
  coarse, low-frequency turn delivery; it MUST NOT poll `ao` state in a
  tight loop, and it MUST NOT itself run #28's decision procedure (it only
  delivers a turn — the orchestrator does the inspecting). A coarse
  heartbeat timer is now **in** scope (see Binding surface / Acceptance
  criteria), superseding this draft's original strictly-event-driven
  exclusion.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
.agent-orchestrator/**
agent-orchestrator.yaml
prompts/**
plugins/**
.github/workflows/**
.claude/skills/**
docs/issues_drafts/11-orchestrator-autonomous-review-loop.md
docs/issues_drafts/06-codex-reviewer-scope-context.md
```

```allowed-roots
scripts/orchestrator-*.ps1
scripts/orchestrator-*.test.ts
agent-orchestrator.yaml.example
docs/**
```

## Acceptance criteria

- **`webhook` notifier wired in example.** `agent-orchestrator.yaml.example`
  contains a `notifiers.webhook` block with a `url` pointing at a
  documented local default (e.g. `http://127.0.0.1:<port>/ao-wake`) and
  a matching `notificationRouting` entry routing `urgent` and `action`
  classes to that notifier.
- **Listener exists and is runnable on Windows.** `scripts/orchestrator-wake-listener.ps1`
  starts an HTTP listener bound to localhost only (not 0.0.0.0). It logs
  startup, accepts POSTs, and exits cleanly on Ctrl+C. The port and the
  orchestrator session ID are configurable (env var or CLI flag);
  defaults documented in the runbook.
- **Wake-relevant event filtering.** The listener forwards an
  `ao send <orchestrator-session> "<wake message>"` for AO notification
  payloads whose semantic type is one of the wake-relevant set, namely
  at least:
  - `review.needs_triage` (or whatever AO labels a notification when a
    review run enters that status);
  - `pr_created` / `ready_for_review` worker transitions;
  - `ci.failing`;
  - `report.stale` against a non-orchestrator session;
  - `merge.ready`.
  Payloads outside this set (info-class chatter, dashboard pings) MUST
  be dropped without calling `ao send`.
- **Wake message names the event.** The forwarded `ao send` message
  includes the event kind and the affected session/PR identifier where
  available, so the orchestrator's next-turn first action is to inspect
  the matching `ao review list` / `ao status` slice rather than do a
  full general sweep.
- **Single-flight per event.** The listener does NOT send a second
  `ao send` for the same wake-relevant event kind on the same session
  within a documented short window (e.g. 30 s). This prevents storm
  amplification when AO retries a notification. The exact window is the
  planner's call; it MUST be documented.
- **Heartbeat wake during event silence.** Beyond event-driven wakes, the
  mechanism MUST deliver a low-frequency heartbeat
  `ao send <orchestrator-session> "<wake message>"` on a fixed interval
  **even when AO emits zero notifications**, so the orchestrator gets a turn
  in event silence and can run its turn-opening reconciliation (see file
  `11-orchestrator-autonomous-review-loop.md`). The interval is the
  planner's call but MUST be low-frequency (order of tens of minutes, and
  much longer than the single-flight window) to avoid turn storms; the
  chosen value MUST be documented in the runbook.
- **Heartbeat independent of the event path's failure modes.** The
  heartbeat MUST NOT be gated on inbound webhook traffic — it MUST keep
  firing when AO sends no notifications, and MUST NOT share a single point
  of failure with the webhook-receipt path such that one stoppage silences
  both wakes. (Rationale: the 2026-05-28 incident showed the orchestrator
  can sit idle precisely when AO emits only non-wake events; a heartbeat
  embedded in the webhook handler would be silent in exactly that case.)
  The mechanism — separate process, scheduled task, or independent timer —
  is the planner's choice; the observable requirement is that **stopping
  AO's notification delivery does not stop the heartbeat**.
- **Heartbeat is labelled and honors single-flight.** The heartbeat wake
  message MUST be distinguishable from event-driven wakes (e.g. a distinct
  wake kind in the message text) so the orchestrator and the logs can tell
  a periodic nudge from a real event, and a heartbeat coinciding with a
  real event within the single-flight window MUST NOT produce a double
  `ao send`.
- **No remote exposure.** The listener binds only to loopback. Refusing
  non-loopback connections is an acceptance criterion.
- **No work without the listener.** When the listener is not running,
  AO continues to function normally — the listener is purely additive.
  Verified by stopping the listener and observing AO and worker
  sessions remain healthy (only the orchestrator stops getting
  automatic wakes).
- **Runbook.** `docs/orchestrator-wake-runbook.md` documents the start
  command, the default port, how to verify the listener is reachable
  (`Test-NetConnection` or equivalent), and how to detect that AO is
  not POSTing (zero-event log line over a documented quiet period).
- **Tests.** `scripts/orchestrator-wake-listener.test.ts` (or
  `.tests.ps1` if Pester is more natural) covers the event-kind filter
  logic on representative payloads, including at least one each of:
  wake-relevant, info-class drop, malformed payload (rejected), and a
  payload missing the session ID (rejected with a log line).
- **No edits to #28's `orchestratorRules`.** This PR MUST NOT modify
  the `orchestratorRules` block in `agent-orchestrator.yaml.example` —
  only the `notifiers` and `notificationRouting` blocks.

## Upgrade-safety check

- No edits to `packages/core/**`, `vendor/**`, AO runtime, the scope
  guard implementation, AO plugins, or the first-principles framework
  docs.
- No new repository secrets. The listener authenticates via loopback
  binding, not via shared secret. If AO's webhook notifier requires a
  signature/secret per the schema, the runbook documents how to
  generate it; the secret value lives in the operator's local AO config
  only.
- `webhook` notifier is a built-in AO 0.9.x plugin per `ao config-help`.
  No new dependency.
- The listener uses only Windows-default PowerShell facilities (no
  external npm packages required at runtime); test harness may use
  Vitest as already configured.
- The heartbeat uses only Windows-default facilities (PowerShell and, if
  chosen, the built-in Task Scheduler); no new repository secret, no new
  npm/runtime dependency, and no edits to `packages/core/**`, `vendor/**`,
  or AO runtime. It shells only `ao send`, already in `ao --help`.

## Verification

- **Static — `webhook` notifier present.** Reading
  `agent-orchestrator.yaml.example` shows the `notifiers.webhook` block
  pointing at the documented local URL and the matching
  `notificationRouting` updates.
- **Static — listener file shape.** Reading
  `scripts/orchestrator-wake-listener.ps1` shows a CLI entry that
  accepts a port and an orchestrator session ID (or env-var defaults),
  binds to loopback only, and routes payloads through a filter
  function.
- **Static — event-kind filter coverage.** Reading
  `scripts/orchestrator-wake-listener.test.ts` (or Pester equivalent)
  shows test cases for at least the four payload classes listed in
  the acceptance criterion.
- **Smoke — repository policy.** `scripts/verify.ps1`,
  `scripts/check-reusable.ps1`, and `scripts/test-all.ps1` clean on the
  PR head.
- **Smoke — listener starts and accepts a synthetic POST.** Manual
  step in verification: run the listener, POST a recorded AO
  notification payload via `Invoke-RestMethod`, observe the listener
  log a forward decision (without actually contacting `ao send` —
  dry-run flag).
- **Manual — end-to-end wake.** With AO running and the listener
  running, manually trigger a `report-stale` (via existing AO event) on
  a stuck worker and observe the orchestrator session receives an
  `ao send` wake message and runs #28's decision procedure on its next
  turn. Document the test transcript in the PR.
- **Static — heartbeat is decoupled from the webhook path.** Reading the
  heartbeat helper/scheduled-task definition shows it emits the periodic
  `ao send` without depending on the listener's HTTP receipt code — i.e. it
  is a separate process / scheduled task / independent timer, not a branch
  inside the webhook handler. The runbook documents the heartbeat interval.
- **Manual — heartbeat fires in event silence.** With AO producing no
  wake-relevant notifications (or with the webhook listener intentionally
  not receiving any POST), observe the orchestrator session still receives
  a heartbeat `ao send` within the documented interval, and that its wake
  message is distinguishable from an event-driven wake.
- **Manual — heartbeat survives a dead webhook path.** Simulate the
  webhook-receipt path being down (e.g. listener not running) and confirm
  the heartbeat still reaches the orchestrator, demonstrating the two wakes
  do not share a single point of failure.
- **Manual — listener stop does not break AO.** Stop the listener and
  confirm `ao status` and active workers continue normally; only the
  orchestrator stops receiving automatic wakes.
