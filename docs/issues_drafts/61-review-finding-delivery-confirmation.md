# Confirmed delivery of review findings to the worker (sender-side reconciliation)

GitHub Issue: #171

## Prerequisite

- GitHub #163 (`58-safe-review-trigger-reconciliation.md`) — state-derived review
  **trigger**, scoped to `ao review run` only with **zero worker-lifecycle
  action**. That issue guarantees a review *run* starts for an uncovered head; it
  deliberately does **not** touch the worker. This issue is the next leg: it
  confirms the *finding produced by that run* actually reached the worker.
  Distinct concern (delivery), distinct mechanism — see **Binding surface**.
- GitHub #168 (`60-orchestrator-wake-supervisor.md`) — keeps the wake listener and
  heartbeat alive so the orchestrator gets turns. This issue rides on turns being
  available but adds the receipt-confirmation and re-delivery the wake layer does
  not perform. A delivered turn is not a delivered finding.
- GitHub #88 (`32-worker-acknowledge-pickup-contract.md`, **closed**) — the worker
  runs `ao acknowledge` once on **initial** pickup at spawn. This issue is the
  symmetric **sender-side** confirmation for the review-finding leg, where a
  worker-side ack cannot help: if the worker never received the message (blocked
  input channel), it can never ack. Confirmation must therefore be observed by the
  sender, not awaited from the worker.
- GitHub #98 (`34-review-layer-resilience-after-worker-respawn.md`, **closed**) —
  post-respawn idempotency / orphan-run reap. This issue does **not** respawn; it
  confirms delivery to the **existing** session and escalates rather than
  auto-respawning. Respawn discipline stays #98's domain.
- Logs a new decision under `docs/issues_drafts/00-architecture-decisions.md` §H
  (Review trigger reconciliation and orchestrator turn delivery), as a third,
  separate concern: *finding delivery confirmation*.

## Goal

When AO marks a review finding `sent_to_agent`, that status records only that a
best-effort message injection was **attempted** — not that the worker received it
or began acting on it. When the worker's input channel is unavailable (a flooded
terminal, a stuck session), the finding is **silently lost**: the dashboard shows
"review sent, 0 open findings," the PR sits with green CI, and no fix ever lands.
This is the PR #166 / opk-8 incident (2026-06-04): finding `sent_to_agent` at
08:25:36, but the worker never transitioned to `addressing_reviews` and the
finding stranded.

Make finding delivery **observable, with bounded best-effort recovery and a
guaranteed escalation backstop** — not silent. After a send, confirm the worker
actually began the review round within a bounded window. If not, attempt bounded
**best-effort** re-delivery to the same session. **Escalation, not re-delivery, is
the guarantee:** re-delivery can recover the *transient* case (the worker finished
its turn and is idle but its input channel is healthy); under the named incident
class — a corrupted/flooded input channel — re-delivery through that same channel
can deterministically fail, so the contract guarantees only that an unconfirmed
delivery is **detected and escalated** to the operator with an actionable message,
never left silently "sent" with the loop wedged. Restoring the channel itself
(the terminal-flood root cause) is a separate upstream concern (see **Files out of
scope**); this issue makes the loss *visible and owned*, it does not promise
delivery over a broken channel.

## Binding surface

- **Confirmation signal is causally tied to the review round — not generic
  activity.** A send counts as received only when the linked worker emits a
  review-round progress signal *after* the send — an `addressing_reviews` (or
  equivalent structured worker report) for that session, observed after the send
  timestamp. Generic "the worker did something" activity MUST NOT count as proof of
  receipt: unrelated post-send activity would falsely mark a lost delivery as
  received and recreate the silent-loss failure with better-looking metadata. The
  bare AO `sent_to_agent` status likewise MUST NOT be treated as proof of receipt.
- **Ambiguous overlap is treated as unconfirmed (conservative), never as a shared
  confirmation.** When more than one unconfirmed-delivery run is active for the same
  PR head and session (duplicate triggers, a manual send, or a quick re-review), a
  single post-send review-round report MUST NOT be credited to a specific run as
  proof of delivery — one report could otherwise satisfy the timestamp/session/head
  test for a different run whose findings never arrived, recreating silent loss at
  run level. Confirmation is credited only when attribution is unambiguous (exactly
  one unconfirmed run for that head/session, or a run-identifying correlation is
  actually available in the signal). Otherwise each such run stays unconfirmed and
  follows the bounded re-deliver / escalate path.
- **Granularity is the review run / PR head, not the individual finding.** The
  observable substrate on the target AO version (0.9.2) is **run-level**: the
  project-scoped `ao review list <project> --json` exposes per-run status, linked
  session, and PR/head; there is no
  supported CLI for per-finding identity, and the per-finding JSON under gitignored
  `code-reviews/**` is not a stable orchestrator contract (consistent with the
  Gate-0 finding in #140). Confirmation, re-delivery, and tracking therefore key off
  the **review run for a PR head sent to a session**, not off individual finding
  ids. (If a future AO version exposes durable per-finding identifiers, the contract
  may tighten then — it MUST NOT depend on them now, nor on hand-reading the
  gitignored findings dir.)
- **Bounded confirmation window.** After a send, the mechanism waits a bounded
  window for the confirmation signal before acting. The window is configurable with
  a safe default.
- **Best-effort re-delivery to the same live session only.** If the window elapses
  with no confirmation, the run's findings are re-delivered to the **existing linked
  session**, a bounded number of times, as a **best-effort** recovery (it succeeds
  for the idle-but-healthy-channel case; it is *not* claimed to succeed when the
  channel is corrupted). Re-delivery MUST NOT spawn, claim (`--claim-pr`), kill, or
  otherwise alter worker lifecycle — it only re-sends to the session that already
  owns the branch. This preserves the PR #97 split-brain invariant (consistent with
  #163 and #98): re-introducing safety came specifically from *not* claiming or
  spawning a worker.
- **Liveness + ownership precondition — never re-send into an orphan.** Before each
  re-delivery, the mechanism MUST verify the linked session is still live and still
  owns this PR/head. Review runs linked to terminated, killed, missing, replaced, or
  stuck-in-launch/detecting sessions remain visible in `ao review list` (the orphan
  class hardened by #98), and `ao review send` into such a run can fail silently or
  never reach a worker. If the linked session is not a live owner of the head, the
  mechanism MUST NOT re-send — it goes straight to the escalation/remedy path. This
  issue does not reap orphan runs (that is #98) and does not respawn (that is the
  operator/#98 path); it refuses to re-deliver into one and escalates instead.
- **Escalation is the guarantee — bounded, no retry-storm.** After the bounded
  re-deliveries still produce no confirmation, the mechanism **stops** (it MUST NOT
  retry forever into a dead or flooded channel) and surfaces an actionable
  escalation carrying at least: the session id, the PR number, the **review-run
  identifier** whose delivery is unconfirmed, and the documented operator remedy.
  The run's delivery-tracking state must then be distinguishable from a
  confirmed-delivered run. (This issue tracks **delivery**, two states only —
  delivery-confirmed vs delivery-unconfirmed/escalated. Whether the worker then
  *resolves* the findings is the review-completion concern: #163 re-triggers a new
  run on the new head, which begins a fresh delivery cycle. Tracking a separate
  "addressed/resolved" state is out of scope here.)
- **Not coupled to the LLM-orchestrator's judgement turn.** Per §H, mechanical
  convergence must not depend solely on the LLM-orchestrator taking a healthy turn.
  The confirmation/re-delivery loop converges deterministically on a mechanical
  cadence (riding the existing wake/heartbeat cadence or its own low-frequency
  loop), not only when the orchestrator chooses to act.
- **Distinct from the #163 review-trigger reconciler.** This delivery-confirmation
  mechanism is a **separate** mechanism. It MUST NOT be folded into #163's
  review-run-only reconciler, whose zero-worker-contact invariant forbids exactly
  the re-delivery (a worker-directed message) this issue performs.
- **Idempotent and low-frequency.** A finding already confirmed-delivered or
  addressed is never re-sent; the loop does not busy-poll worker or `ao` state.
- **Operator adoption** (introduces operator-tunable behaviour and a new escalation
  path):
  - Any new operator env var / flag (confirmation-window length, re-delivery
    count) is documented, with safe default behaviour when unset.
  - The recovery runbook documents the new escalation message and the operator
    remedy (how to read it, what to check, how to manually re-drive or recover the
    session).

## Files in scope

- `scripts/**` — the delivery-confirmation/re-delivery mechanism and its tests
  (new files as the planner declares them), consistent with the existing
  review/wake scripts.
- `docs/**` — recovery runbook update and the §H decision-log entry.
- Test fixtures for the confirmation, re-delivery, escalation, and idempotency
  scenarios.

## Files out of scope

- `packages/core/**`, `vendor/**`, `.ao/**` — AO owns `ao review send` and the
  `sent_to_agent` status; this issue **reads** that status, it does not redefine
  the CLI or the status semantics.
- The internal logic of #163's review-trigger reconciler and #168's wake
  supervisor — composed with, not rewritten.
- `agent-orchestrator.yaml` / `.example` and reactions — no orchestration wiring
  change.
- **Fixing the terminal-flood root cause itself** (the dashboard terminal-mux
  re-init storm that corrupted the opk-8 input channel) — that is an upstream AO /
  dashboard concern tracked separately. This issue ensures a lost delivery is
  **detected and escalated**, not that the channel never breaks.
- Worker-side acknowledgement of review rounds — a worker that never received the
  message cannot ack; confirmation here is sender-side by design (see Goal).

## Denylist

```denylist
# issue 61 — review finding delivery confirmation
vendor/**
packages/core/**
.ao/**
.github/workflows/**
agent-orchestrator.yaml.example
```

```allowed-roots
scripts/**
docs/**
```

## Acceptance criteria

1. A run's delivery is classified confirmed only on a review-round progress signal
   from the linked session *after* the send (an `addressing_reviews`/equivalent
   structured report), never on `sent_to_agent` alone and never on generic
   unrelated worker activity. Provable by two fixtures: (a) `sent_to_agent` set but
   no review-round signal follows → **not** confirmed; (b) only unrelated post-send
   activity (no review-round signal) → **not** confirmed.
1a. When two or more unconfirmed runs are active for the same PR head and session,
   a single post-send review-round report does **not** mark either run confirmed;
   the ambiguous runs stay unconfirmed and take the re-deliver/escalate path.
   Provable by a fixture with two overlapping unconfirmed runs and one post-send
   report asserting neither is credited as delivered.
2. Confirmation, re-delivery, and tracking key off the **review run for a PR head
   sent to a session**, read from a supported observable source (the project-scoped
   `ao review list <project> --json` run-level state) — not off per-finding
   identifiers and not by reading
   the gitignored `code-reviews/**` findings files. Provable by a test that drives
   the mechanism from run-level observable state only.
3. The confirmation window is bounded, has a safe default, and is configurable.
   Provable by tests for the default and an override.
4. On no confirmation within the window, the run's findings are re-delivered to the
   **same** linked session, bounded by a configurable count. Provable by a fixture
   asserting the re-delivery count and that the target is the existing session.
4a. Before each re-delivery, the linked session is verified live and still owning
   the PR/head; if it is terminated, killed, missing, replaced, or stuck in
   launch/detecting beyond the orphan threshold, the mechanism does **not** re-send
   and goes straight to escalation. Provable by a fixture with an orphan/dead linked
   session asserting zero re-sends and an immediate escalation.
5. The no-confirmation path performs **no** worker-lifecycle action (no spawn, no
   `--claim-pr`, no kill). Provable by a test asserting none of those calls occur
   on that path.
6. After the bounded re-deliveries without confirmation, the loop **stops** (no
   infinite retry) and emits an escalation containing the session id, PR number,
   the unconfirmed **review-run identifier**, and the operator remedy. Provable by
   a fixture asserting the bounded stop and the escalation content.
7. Run-level delivery state distinguishes two outcomes — delivery-confirmed and
   delivery-unconfirmed/escalated. Provable by inspecting the recorded state across
   both paths. (No separate "addressed/resolved" state — that is out of scope; see
   Binding surface.)
8. A run already delivery-confirmed is never re-delivered (idempotent). Provable by
   a fixture where the review-round progress signal exists and no re-send occurs.
9. The confirmation + re-delivery loop converges without depending on the
   LLM-orchestrator taking a judgement turn. Provable by a fixture/test exercising
   the mechanical path with no orchestrator LLM turn.
10. The recovery runbook documents the escalation message and the operator remedy,
   and any new env var / flag is documented with its safe default. Provable by
   inspecting the runbook.

## Upgrade-safety check

- No edits to `packages/core/**`, `vendor/**`, or `.ao/**`.
- AO's `ao review send` behaviour and the `sent_to_agent` status are **read**, not
  redefined.
- No new repository secrets and no new GitHub Actions permissions.
- No change to AO orchestration wiring (`agent-orchestrator.yaml`, reactions).
- The #163 reconciler and #168 supervisor logic are unchanged.
- Re-delivery never spawns, claims, or kills a worker — the split-brain invariant
  holds.

## Verification

- Automated tests over fixtures cover, 1:1 with the criteria: `sent_to_agent` (and,
  separately, unrelated post-send activity) without a review-round signal is not
  "confirmed" (criterion 1); overlapping unconfirmed runs for one head/session are
  not falsely credited by one report (criterion 1a); run-level observable source
  only, no per-finding / gitignored-file dependence (criterion 2); default + override window
  (criterion 3); bounded re-delivery to the same session (criterion 4) and no
  re-send into an orphan/dead linked session — escalate instead (criterion 4a); no
  worker-lifecycle calls on the no-confirmation path (criterion 5); bounded stop +
  escalation content including the review-run id (criterion 6); the two
  distinguishable run-level delivery states (criterion 7); idempotent no re-send for
  delivery-confirmed runs (criterion 8); convergence on the mechanical path with
  no LLM turn (criterion 9). Run via the pack test runner.
- Grep confirms the recovery runbook documents the escalation message, operator
  remedy, and any new env/flag default (criterion 10).
- Live smoke (operator, optional): with a worker whose input channel is
  unavailable, confirm the mechanism re-delivers the bounded number of times, then
  escalates with the actionable message (naming the run, PR, and session) rather
  than wedging silently.
