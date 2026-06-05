# Terminal Device-Attributes flood: operator detection + recovery (upstream-tracked)

GitHub Issue: #173

**Queue status:** `active-blocked-upstream` — the durable fix (terminal
reset/sanitize on mux-attach + reconnect-loop throttle) lives in AO core / the
dashboard and is tracked at **ComposioHQ/agent-orchestrator#2094**. The pack does
**not** patch core; this issue delivers the pack-side parts that are achievable
now (detection signature + operator recovery runbook) and tracks the upstream fix.
Same class as draft 38 (#122) and draft 50 (#140).

## Prerequisite

- Upstream **ComposioHQ/agent-orchestrator#2094** — dashboard worker terminal
  floods with Device-Attributes reports (`ESC[>84;0;0c` DA2, `ESC[?1;2c` DA1)
  correlated with the mux WebSocket reconnecting ~1/sec; AO/dashboard concern, not
  pack-patchable. This issue is the pack-side companion, not the fix.
- Relates to GitHub #171 (`61-review-finding-delivery-confirmation.md`) — the flood
  is the channel corruption that makes a sent finding never reach the worker; #171
  detects/re-delivers/escalates the lost delivery, this issue addresses the flood's
  operator-visible recovery. Distinct concerns, same incident family (opk-8/PR#166,
  opk-10/PR#169).
- Relates to GitHub #174 (`63-review-ready-worker-stuck-guard.md`, the item-3
  companion) — that issue
  keeps a review-ready worker from being treated as lost when the flood trips a
  false `stuck`; this issue is about recognising and clearing the flood itself.

## Goal

When a worker session's dashboard terminal floods with Device-Attributes reports
(thousands of `ESC[>84;0;0c`, correlated with mux WebSocket connect/disconnect
flapping), an operator currently has no documented way to recognise it or recover:
the worker pegs CPU re-rendering, injected `ao send` / `ao review send` messages
land as unsubmitted pastes and never reach the agent, and the review→fix loop
stalls with green CI and "0 open findings." Until the upstream reset/throttle fix
ships (#2094), give operators a **named detection signature** (from observable AO
state, not pane scraping) and a **recovery runbook** so a flooded session is caught
and cleared instead of silently stranding work.

## Binding surface

- **Detection signature from observable AO state — specific, not just "high churn".**
  Provide a way to flag a session exhibiting the flood from **observable signals**,
  not by scraping the tmux pane for escape bytes (fragile, runtime specific). The
  signature MUST be discriminating, not merely "many terminal events":
  - **session-local** — attributable to a specific affected session, not global
    dashboard activity;
  - **paired flapping** — repeated `ui.terminal_connected` *and*
    `ui.terminal_disconnected` cycling, not one-off connects;
  - **sustained over a bounded window** — present across a window, not a single
    spike;
  - **distinguishable from benign reconnects** — a single dashboard refresh, an AO
    restart / network blip, multiple legitimate terminal viewers, or general
    websocket instability MUST NOT trip it.
  The signature names the affected session and the evidence.
- **Operator recovery runbook — with a verified-stopped gate before re-delivery.**
  Document the end-to-end recovery: how to recognise the flood (symptoms: CPU-pegged
  idle worker, the signature above in `ao events`, an injected finding visible as an
  unsubmitted `[Pasted text]`); how to stop the reconnect loop (the mux-client side —
  e.g. closing the flooded dashboard terminal view driving it); a **post-stop
  verification** that the signature for that session has actually subsided below the
  threshold (closing the wrong view / a stale tab / an external loop must be caught),
  with explicit **fallback to recycling the session** when churn does not drop; and
  only **after** the channel is verified quiet, how to re-deliver the stranded
  finding — driven, when available, by the #171 unconfirmed/escalated run evidence
  (run identity) rather than a blind ad-hoc resend that could duplicate or re-lose
  it. The runbook must state plainly that the **root fix is upstream (#2094)** and
  these are mitigations.
- **No core / dashboard patching.** The reset/sanitize-on-attach and reconnect
  throttle are out of scope for the pack (AO core / dashboard). This issue only adds
  pack-owned detection + docs and tracks #2094.
- **Operator adoption** (introduces a recovery procedure and possibly a diagnostic
  entry point): the recovery runbook is linked from the recovery/go-live docs; any
  new diagnostic command or flag is documented with safe defaults.

## Files in scope

- `scripts/**` — an optional read-only diagnostic that surfaces the flood signature
  from `ao events` (new files as the planner declares them), and its tests.
- `docs/**` — the recovery runbook section and the upstream-tracking note.
- Test fixtures for the detection signature.

## Files out of scope

- `packages/core/**`, `vendor/**`, `.ao/**` — AO owns the terminal mux, the activity
  probe, and `ao send` delivery; the reset/sanitize + reconnect-throttle fix is
  upstream (#2094), not here.
- `agent-orchestrator.yaml` / `.example` and reactions — no orchestration wiring
  change in this issue (the lifecycle-guard clause is the `63-*` companion).
- The delivery-confirmation mechanism — that is GitHub #171.

## Denylist

```denylist
# issue 62 — terminal Device-Attributes flood resilience
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml.example
agent-orchestrator.yaml
```

```allowed-roots
scripts/**
docs/**
```

## Acceptance criteria

1. A documented **detection signature** flags a session exhibiting the flood only on
   a **session-local, paired (`connected`+`disconnected`), sustained** flap in
   `ao events` over a bounded window, and names the affected session and the
   evidence. Provable by a positive fixture (sustained paired flapping → flagged)
   **and negative fixtures that must NOT flag**: a single dashboard refresh / one-off
   connect, an AO restart or network blip, multiple legitimate terminal viewers, and
   general (non-session-local) websocket instability.
2. The detection does **not** depend on scraping the tmux pane for escape bytes.
   Provable by the detection running purely from the event/observable inputs in the
   fixture.
3. The recovery runbook documents, in order: the flood symptoms; how to stop the
   reconnect loop; a **post-stop verification** that the signature for that session
   has subsided below the threshold, with a **fallback to recycling the session**
   when it has not; and — only **after** the channel is verified quiet — how to
   re-deliver the stranded finding (driven by the #171 unconfirmed/escalated run
   evidence when available, not a blind resend). It states the root fix is upstream
   **#2094**. Provable by inspecting the runbook for each step.
4. The runbook / queue note links upstream **ComposioHQ/agent-orchestrator#2094**
   and marks this work `active-blocked-upstream` for the reset/throttle fix.
   Provable by grep.
5. Any new diagnostic command or flag is documented with its safe default. Provable
   by inspecting the docs.

## Upgrade-safety check

- No edits to `packages/core/**`, `vendor/**`, or `.ao/**`.
- No change to AO orchestration wiring (`agent-orchestrator.yaml`, reactions).
- The terminal mux, activity probe, and `ao send` delivery are **read/observed**,
  not redefined — the fix to their behaviour is upstream #2094.
- No new repository secrets and no new GitHub Actions permissions.

## Verification

- Automated tests over fixtures cover the detection signature: flagged on a
  session-local, paired, sustained flap window, and **not** flagged on each benign
  case — single refresh/one-off connect, AO restart/network blip, multiple viewers,
  global non-session-local instability (criterion 1) — all driven without pane
  scraping (criterion 2). Run via the pack test runner.
- Grep confirms the recovery runbook documents, in order, symptoms → stop →
  post-stop verification with recycle fallback → verified-quiet re-delivery, the
  upstream link, and the `active-blocked-upstream` status (criteria 3–4), and any
  new diagnostic flag with its default (criterion 5).
- Live smoke (operator, optional): on a flooded session, follow the runbook to stop
  the loop, verify the signature subsided for that session, then re-deliver the
  stranded finding, confirming the worker resumes.
