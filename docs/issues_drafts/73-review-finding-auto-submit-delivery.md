# Submit the stuck review-finding draft so it actually reaches the worker

GitHub Issue: #216

## Prerequisite

- `docs/issues_drafts/61-review-finding-delivery-confirmation.md` (GitHub #171) —
  the sender-side delivery-confirm listener this extends. Its remediation ladder
  (re-deliver → escalate), its `sent_to_agent ≠ receipt` framing, and its causal
  confirmation predicate are the foundation; this issue adds a **submit** rung.
- `docs/issues_drafts/71-orchestrator-side-process-supervisor.md` (GitHub #205) —
  the submit runs inside the supervised delivery-confirm listener. No new
  unsupervised process.
- Relates (not blocking): `docs/issues_drafts/62-terminal-flood-resilience.md`
  (GitHub #173, upstream **ComposioHQ/agent-orchestrator#2094**) — the
  no-pane-mutation origin and the flood signature; `docs/issues_drafts/63-review-ready-worker-stuck-guard.md`
  (GitHub #174) — the split-brain "don't kill a live worker" guard this honors.

## Goal

A review finding that AO has delivered to a worker must actually **reach the
worker** — i.e. be submitted so the worker reads it — instead of rotting as an
unsubmitted `[Pasted text]` draft in the worker's input. Today the loop stalls
with green CI and zero open findings until a human presses Enter (incident
opk-17 / PR #214, 2026-06-06).

## Root cause (confirmed in AO source — `@aoagents/ao-core` 0.9.2)

This is a **deterministic AO-core delivery bug**, not flood or chance. AO delivers
every session message through one core path (`session-manager.send` →
`tmux.sendKeys`):

1. `tmux send-keys Escape` (clear the input);
2. if the message is **multi-line or > 200 chars**, write it to a temp file and
   `tmux load-buffer` + `paste-buffer` — a **bracketed paste** (the collapsed
   `[Pasted text +N lines]` block); otherwise `send-keys -l` (literal type);
3. wait, then send **one** `Enter`.

Two failures combine:

- **A single `Enter` does not submit a multi-line bracketed paste to an idle
  Cursor-CLI agent.** The block stays a draft; the trailing Enter is absorbed by
  the paste rather than submitting. Short/single-line messages skip the paste path
  and their Enter submits — which is why short handoffs land but multi-line
  findings stall.
- **Delivery confirmation mistakes the draft for success.** `sendWithConfirmation`
  treats "pane output changed since baseline" as delivered — and a `[Pasted text]`
  draft *is* a visible change — so it reports success and **never retries** the
  Enter. (AO's own CLI fallback `send.js → sendViaTmux` retries Enter up to 3× and
  only accepts active/queued; the core path the orchestrator uses does not.)

**Why "orchestrator → input, everything else → queue":** the orchestrator delivers
a finding exactly when the worker has just finished and gone **idle**
(`ready_for_review`) — the idle + multi-line-paste failing case. Messages that
arrive while the recipient is **busy** are queued by Cursor ("Press up to edit
queued messages") and consumed at turn-end — that is "everything else."

5 Whys → spec-level cause: the only delivery path AO exposes to the pack
(`ao send` / `ao review send`) cannot reliably submit a multi-line finding to an
idle worker, and #171 guarantees *escalation* of an unconfirmed delivery but never
*submission* of the already-pasted draft. The durable fix is upstream; the pack
bridge submits the draft locally.

## Binding surface

What this issue commits the repository to (contracts; implementation left to the
planner):

- **Pack bridge — submit the stuck draft (immediate delivery).** When the
  delivery-confirm listener sees a finding delivered (`sent_to_agent`) but **not
  consumed** within the window (no run-attributed `addressing_reviews` for this
  run/head — #171's causal predicate; an unrelated turn does **not** count as
  consumption), it submits the pending input to the worker (the action AO's core
  delivery omitted). Because AO's `sendKeys` does `Escape` (clear) immediately
  before pasting, the pending input is the just-delivered finding — submitting it
  delivers exactly that finding (or enqueues it if the worker is mid-turn).
- **Live, head-owning session only (split-brain invariant).** Submit only to a
  session that is live and owns the **exact current head SHA** of the run's PR.
  Never spawn, never `--claim-pr`, never kill (carries #171/#174 verbatim).
- **Pre-submit recheck on a single fresh snapshot, fail-closed.** Immediately
  before submitting, re-verify on one snapshot: session still live, still owns the
  same PR + exact head SHA, still unconfirmed by the causal predicate. Any
  ambiguity or change → no submit, escalate.
- **Input-freshness gate (never submit a stale/unrelated draft).** AO's
  `Escape`+paste only establishes the input contents *at delivery time*; by the
  time the bridge acts, an operator keystroke, another `ao send`/`ao review send`,
  or a newer paste could have changed it. The submit must therefore guarantee the
  input at submit time **is this finding**, via one of (planner's choice, no pane
  scraping):
  - **(a) freshness from state/events** — submit only when the listener's own
    delivery state + AO event stream show *this finding's controlled delivery was
    the latest input-affecting action for this run/head, with no intervening
    send/input/worker-turn event since*; any intervening activity → fail closed to
    escalation; or
  - **(b) controlled re-deliver immediately before submit** — re-deliver the
    review run's **exact stored finding content** (not composed/edited) and submit
    it as one action, so the contents are known at submit time.
  Absent such a guarantee → no submit, escalate.
- **Bounded attempts + cross-path dedupe.** At most a small, env-overridable number
  of submit attempts per `(runId, head SHA)`; on exhaustion, **escalate**. Dedupe
  on the decision recorded for that key, persisted in the existing delivery-confirm
  state (`AO_REVIEW_DELIVERY_CONFIRM_STATE`), so a restarted sender, an adopted
  state file, or concurrent observers never double-submit. A new head SHA on the
  same PR is a new budget.
- **Flood-aware (defer, never early-escalate).** While the #173 flood signature is
  active, perform **no** submit and **defer** (a submit into a reconnecting pane is
  a no-op at best); resume eligibility only after the channel is verified quiet
  (#173). The run still escalates only at #171's normal trigger, never earlier.
- **Ladder placement (no #171 regression).** #171's bounded re-delivery stays
  mandatory and unchanged (it handles a genuinely failed send). The submit rung
  runs **after** re-deliveries are exhausted and **immediately before** #171's
  escalation; it must never advance escalation earlier than #171 does today.
- **Escalation remains the terminal guarantee.** The submit is best-effort, layered
  before escalation, never replacing it. When it cannot proceed (any fail-closed
  branch, attempts exhausted, flood active), the run escalates per #171.
- **No pane scraping; degrade safely.** The decision is state-derived (delivery
  state + causal predicate), not from parsing pane text. If the submit mechanism is
  unavailable or errors, fail closed to escalation; never block or crash the
  supervised tick.
- **Upstream bug filed.** File an upstream AO issue (sibling of #2094): core
  `tmux.sendKeys` should retry/verify the submit for multi-line pastes (as
  `sendViaTmux` already does), and `sendWithConfirmation` should not count a
  visible draft as delivery. When that ships, the pack bridge can retire.
- **Operator adoption.** The recovery runbook documents that the listener now
  submits stuck drafts, when it submits vs escalates, and how to tell from the
  delivery-confirm state/log. Any new env knob documented with a safe default; if
  `orchestratorRules`/`reactions`/env wiring changes, list the post-PR operator
  steps (yaml merge / `ao stop`/`ao start` / env).

## Files in scope

- `scripts/**` — the delivery-confirm listener, its decision helper, the submit
  adapter, and their tests (planner owns names, signatures, and the submit
  mechanism).
- `scripts/fixtures/**` `(new)` — fixtures for the decision and adapter tests.
- `docs/orchestrator-recovery-runbook.md` — operator note.
- `agent-orchestrator.yaml.example` and `prompts/agent_rules.md` — **only if** a
  documented operator env knob or wiring is introduced.
- `docs/issues_drafts/00-architecture-decisions.md` — decision-log entry for the
  narrowed no-pane-mutation stance (synced to Issue #3 in the same PR).

## Files out of scope

- AO core (`@aoagents/ao-core` `tmux.sendKeys` / `sendWithConfirmation`) — the
  durable fix is upstream (#2094 sibling), not pack-patchable.
- Flood **detection** itself (#173) — this issue only consumes its signal.
- Review **trigger**/coverage (#163/#189/#207), wake liveness (#168/#205), worker
  lifecycle (spawn/`--claim-pr`/kill, #98/#174).
- Pane **scraping** for content verification — explicitly excluded.
- `packages/core/**`, `vendor/**`, `.ao/**`.

```denylist
vendor/**
packages/core/**
.ao/**
```

## Acceptance criteria

Policy logic is fixture-driven; the submit mechanism that mutates the terminal
carries adapter/boundary tests (the risk surface lives there).

1. **Submits when delivered-but-unconsumed.** Given a fixture where the run is
   `sent_to_agent`, the window elapsed, the session is live and owns the exact head
   SHA, #171's causal predicate is **not** met, and #171's bounded re-delivery is
   exhausted → the listener emits exactly one submit action for that
   `(runId, head SHA)` and records it.
2. **No-op only on causal consumption.** Given a run-attributed `addressing_reviews`
   for this run/head before the window or at recheck → no submit. An **unrelated**
   turn (operator message, unrelated queued follow-up) does **not** count — the run
   stays unconfirmed and on the submit/escalate path (no silent drop).
3. **Fail-closed on ambiguity.** Session not live / not head-owner / head changed at
   recheck / overlapping ambiguous runs → no submit; escalate per #171.
4. **Bounded + escalates.** Attempt budget exhausted for `(runId, head SHA)` → no
   further submit; run recorded `escalated`. New head SHA resets the budget.
5. **Flood → defer.** #173 flood signature active → no submit, defer; eligibility
   resumes only after the channel is verified quiet; never escalate earlier than
   #171.
6. **Dedupe / restart-safe.** Concurrent ticks or a restarted sender over the same
   `(runId, head SHA)` → at most one submit total.
7. **Never authors content.** The bridge never composes or edits finding text — it
   either submits the already-pasted draft (option a) or re-delivers the review
   run's exact stored finding content verbatim (option b). Assert the bridge emits
   no text it authored itself.
8. **Stale/changed input refused.** Given an intervening input-affecting event
   (operator keystroke, another send, a newer paste, or a worker turn) since this
   finding's controlled delivery → **no submit**; escalate. The fixture proves the
   bridge refuses to submit when freshness cannot be established (so it cannot push
   unrelated text and log it as this finding's delivery).
9. **Adapter fail-closed (terminal boundary).** Adapter tests proving the submit
   mechanism escalates (no Enter) when session addressing is stale/unavailable, the
   target session is wrong, or it times out/errors — exercising the adapter, not
   only the policy.
10. **Submit-behavior verified.** A recorded check (test or documented manual
    probe + result) confirming that the chosen submit action actually causes an idle
    worker to consume a multi-line `[Pasted text]` draft (and enqueues, not
    interrupts, a busy one), across the relevant worker states — so the bridge is
    built on observed behavior, not assumption.
11. **Degrades, doesn't crash.** Submit mechanism unavailable/errors → tick fails
    closed to escalation, listener continues.
12. **Upstream filed.** The upstream AO issue (core retry/verify submit +
    confirmation fix) is filed and linked from the decision log.
13. **Operator docs + decision log.** Runbook documents submit-vs-escalate and how
    to read it; `00-architecture-decisions.md` records the narrowed
    no-pane-mutation stance, synced to Issue #3 in the same PR.

## Upgrade-safety check

- No AO core / `vendor/**` / dashboard edits; the core delivery fix is upstream.
- No unsupported YAML: AO 0.9.x exposes no submit reaction key — the trigger stays
  a state-derived listener path.
- No new repo secrets.
- The submit mechanism must fail closed (→ escalation) when the multiplexer or
  session addressing is unavailable; never block, hang, or crash the supervised
  tick.
- The narrowed no-pane-mutation exception is **submit-only of the already-delivered
  draft, causal-unconfirmed, recheck-gated, bounded, flood-deferred, and
  escalation-backed** — it does not authorize composing input, retyping content, or
  any worker-lifecycle action.

## Decision log (to record in `00-architecture-decisions.md`)

The flood/delivery family (#173/#174) holds "never mutate the worker pane." This
issue narrows that to a single submit of the draft AO already pasted, justified by
the confirmed AO-core root cause (core delivery clears + pastes but never reliably
submits a multi-line paste, and mis-confirms the draft as delivered). Record: (a)
what the exception permits/forbids; (b) why submit-only of an AO-cleared-then-
pasted draft, causal-gated + bounded + flood-deferred, is a small risk surface; (c)
the upstream fix (core retry/verify + confirmation) that would retire the bridge.

## Verification

- Vitest fixtures on the decision helper for ACs 1–8 (sibling of
  `review-finding-delivery-confirm.test.ts`), each a discrete fixture + state
  assertion; no-authored-content assertion for AC 7; stale/changed-input refusal
  fixture for AC 8.
- Adapter fail-closed tests for AC 9 (stale/unavailable addressing, wrong session,
  timeout/error → escalate, no Enter).
- AC 10 submit-behavior evidence recorded (test or documented probe + result).
- AC 11 degrade/no-crash test.
- AC 12 upstream issue link; runbook lint + `00-architecture-decisions.md` / Issue
  #3 sync for AC 13.
- `pwsh -NoProfile` snippets on Linux/WSL2 (pwsh 7+); required pack CI green; no
  core/vendor/dashboard diff.
