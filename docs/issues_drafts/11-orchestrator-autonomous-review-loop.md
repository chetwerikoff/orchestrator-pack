# Orchestrator: autonomous review loop with worker response contract

GitHub Issue: #28

## Prerequisite

- Issue #9 NO_FINDINGS contract (file `docs/issues_drafts/06-codex-reviewer-scope-context.md`) must be merged. This issue assumes
  the reviewer wrapper already enforces the `NO_FINDINGS` clean-review contract,
  so cleanliness is determined by `findingCount`, never by parsing finding prose.
- Architecture decisions (file `docs/issues_drafts/00-architecture-decisions.md`)
  defines the agent role split — orchestrator coordinates, worker implements,
  reviewer is Codex AO-local.

## Goal

Make the AO orchestrator drive the review→fix loop **without a human typing
"review loop"** for every PR, and stop treating `merge_ready` / `ready_for_review`
as task-complete while the latest AO-local review is still `waiting_update`.
Add a worker-side response contract so an idle Cursor session on Windows cannot
silently swallow review findings. The loop MUST start from the observable
existence of an unreviewed open PR, not solely from the worker announcing it: a
worker that never reports `ready_for_review` must not be able to silently
prevent review from ever running.

This issue is a **prompt/config contract over the orchestrator's decision
procedure**, not a runtime-enforced wall-clock SLA. Wall-clock timing values
that appear below are operator guidance for the orchestrator prompt, not
guarantees enforced by any background component introduced here.

Observed failure (op-3 on 2026-05-27): `ao review send` succeeded in metadata,
the worker never reported `addressing_reviews`, the orchestrator waited
~14 minutes until an explicit user ping. The durable fix is in the spec for
orchestrator behavior and worker rules, not in the merged code of any one PR.

Observed failure (PR #56 on 2026-05-28, **follow-up after this draft's first
implementation merged**): the worker session was mergeable but never reported
`ready_for_review`; `ao review list` showed zero runs for the PR and the
orchestrator went `stuck` with no review ever initiated. Spec-level root cause:
the review trigger was gated entirely on the worker's self-report, so a missed
or delayed report left no path to start review. The state-derived trigger added
below (see the "State-derived review trigger" acceptance criterion) closes that
gap; the rest of this draft already shipped.

## Binding surface

This issue commits the repository to a reusable contract covering:

1. **Orchestrator rules** (the text that the orchestrator agent receives at
   spawn) describing the autonomous review loop, its triggers (both
   report-driven and state-derived / reconciliation), an explicit named state
   for "review send issued, awaiting worker response", the decision procedure
   on each subsequent orchestrator turn, and a round limit.
2. **Worker rules** (`prompts/agent_rules.md`) requiring an explicit transition
   to `addressing_reviews` (via `ao report addressing_reviews`) after `ao
   review send` lands, or an explicit terminal failure report with a reason.
   Silent idleness is forbidden.
3. **Reactions configuration** wiring the AO `report-stale` reactionKey as
   a long-tail backstop only. The 30-minute `staleReportTimeoutMs` is
   hardcoded upstream in AO 0.9.x and is **not** the SLA — it is a last-resort
   reminder for workers that stayed silent long enough to trigger AO's stale
   report watcher.
4. **Migration notes** so the live `agent-orchestrator.yaml` does not drift
   from the reusable example shipped in the pack.

**No-watchdog constraint.** This issue intentionally does not add a background
monitor, periodic poller, daemon, scheduler, or new persistent tracking store.
All behavior is enforced through:

1. Orchestrator prompt rules while the orchestrator is active.
2. Worker prompt rules.
3. Existing AO CLI state (`ao review list --json`, `ao status --json --reports full`,
   `ao events list --json`).
4. Existing AO reactions, particularly `report-stale`, as a long-tail backstop.

The contract is observable from `ao events list` (reactionKey traffic),
`ao review list` (`findingCount`), and `ao status --reports full` (worker
transitions). No new tracking storage is introduced.

## Files in scope

- `agent-orchestrator.yaml.example` — carry the canonical `orchestratorRules`
  block and the `reactions: report-stale` backstop. This file is the source
  of truth for the team; the live config copies from here.
- `prompts/agent_rules.md` — add the worker response contract and the
  explicit list of transitions the worker must emit on the review path.
- `docs/migration_notes.md` — add a section describing how to merge updated
  `orchestratorRules` and `reactions` into a pre-existing live
  `agent-orchestrator.yaml`.
- `docs/issues_drafts/11-orchestrator-autonomous-review-loop.md` — this spec.

## Files out of scope

- Live `agent-orchestrator.yaml` (user-local, gitignored).
- `packages/core/**` and `vendor/**`.
- AO upstream changes (e.g. making `staleReportTimeoutMs` user-configurable,
  improving Windows ConPTY delivery). Track separately.
- Reviewer wrapper (`plugins/ao-codex-pr-reviewer/`) — owned by issue #9 / file `06-...`.
- Background monitor / periodic poller / daemon — explicitly excluded by the
  no-watchdog constraint above. Any future watchdog work is a separate draft.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
.agent-orchestrator/**
plugins/ao-codex-pr-reviewer/**
```

```allowed-roots
agent-orchestrator.yaml.example
prompts/**
docs/**
```

## Acceptance criteria

- **Autonomy as a rule, not a wall-clock guarantee.** The
  `orchestratorRules` text MUST contain explicit instruction to initiate
  `ao review run <session> --execute` whenever a worker reaches
  `ready_for_review` on an open PR, without waiting for a human prompt
  containing the words "review" or "loop". Verified by reading the rules
  block, not by timing how long until it fires.
- **State-derived review trigger (reconciliation, not report-gated).** In
  addition to the report-driven trigger above, the `orchestratorRules` MUST
  instruct the orchestrator, as part of the turn-opening inspection, to:
  1. enumerate open PRs and each PR's current head SHA from **GitHub** (via
     the `gh` CLI the rules already use for PR operations — the open-PR set
     exists in GitHub regardless of whether any worker reported), and
  2. cross-reference each open PR's head SHA against `ao review list --json`,
  3. resolve the target worker session for that PR from AO session state
     (`ao status --json --reports full`); if no live session is associated
     with the PR, the rules MUST say how the orchestrator obtains one (e.g.
     `ao spawn --claim-pr <PR>`) before running review,
  4. then initiate a review run (through the pack review wrapper, per the
     existing review-run invocation rule) for any open PR whose current head
     SHA has no review run and no run currently in flight — **even when no
     worker has reported `pr_created` or `ready_for_review` for it**.

  The trigger MUST derive the open-PR/head-SHA set from GitHub and the
  review-run state from `ao review list --json`, so that a missing or delayed
  worker report cannot block review. The rule MUST NOT start a second run while
  a run for the current head SHA is `queued`, `preparing`, or `running`; MUST
  reuse the existing `outdated` / round-progression handling when the head SHA
  advances; and remains subject to the 20-round stop rule below. This adds
  **no background process** — the check runs only when the orchestrator already
  has a turn, and guaranteeing those turns during event silence is owned by
  file `14-orchestrator-wake-mechanism.md`. Verified by reading the rules block.
- **Cleanliness derives from count, not prose.** The orchestrator MUST
  decide cleanliness from `ao review list --json`
  (`findingCount: 0, openFindingCount: 0`), never by reading or
  pattern-matching finding body prose. This honors the NO_FINDINGS contract
  from file `06-...`.
- **Named review-run states the rules MUST handle.** The
  `orchestratorRules` block MUST handle the AO-emitted review-run statuses
  exactly as they appear in `ao review list --json`. As of AO 0.9.x these
  include at minimum:
  - `needs_triage` — review run completed, findings have not been sent to
    the worker yet. The orchestrator MUST call `ao review send <run-id>`
    for any `needs_triage` run with `openFindingCount > 0`.
  - `waiting_update` — review run already had findings sent
    (`sentFindingCount > 0`) and the orchestrator is awaiting the worker's
    response.
  Invented statuses are forbidden (e.g. `awaiting_triage`).
- **Named pending state.** The rules MUST introduce an explicit named state
  for "review send issued, awaiting worker response" (suggested:
  `waiting_worker_review_response`; planner picks the exact identifier).
  While a PR is in this state, the orchestrator MUST NOT treat
  `merge_ready`, `ready_for_review`, or stale dashboard metadata as
  task-complete.
- **Exit conditions from the pending state.** The rules MUST list the
  observable conditions under which the PR leaves the pending state, namely:
  - the worker reports `addressing_reviews` via `ao report`,
  - the worker pushes a new commit on the PR branch,
  - the worker reports a terminal failure with a reason,
  - the orchestrator has observed AO/session state proving the worker is
    unavailable and has performed a respawn attempt.
- **Turn-driven decision procedure.** On each subsequent orchestrator turn
  while the PR remains in the pending state, the rules MUST require the
  orchestrator to inspect `ao review list --json`, `ao status --json
  --reports full`, and recent `ao events list --json` **before any other
  planning work**. Wall-clock target windows MAY appear as operator guidance
  (e.g. "expect worker acknowledgement within ~2 minutes; ping after that;
  respawn ~3 minutes after the ping") but the rules MUST explicitly state
  that these are guidance, not independently enforced timers.
- **Ping discipline.** On the next orchestrator turn after detecting no
  worker acknowledgement and no new PR commit, the orchestrator sends
  exactly one explicit `ao send` ping asking the worker to check pending
  AO review findings and report `addressing_reviews` or terminal failure.
  The rules MUST forbid sending multiple pings before observing the next
  worker response.
- **Respawn discipline.** If a later orchestrator turn still observes no
  acknowledgement and no new PR commit, the rules MUST instruct the
  orchestrator to kill the stale worker session via
  `ao session kill <worker-session>` — where the session id is read from AO
  session state (`ao status --json --reports full`), never inferred from the
  PR number or the issue number — and respawn via `ao spawn --claim-pr <PR>`.
- **Round limit as prompt-level stop rule.** The rules MUST instruct the
  orchestrator to stop initiating new review→fix cycles on the same PR
  after **20 completed review runs whose `openFindingCount > 0` or
  `findingCount > 0`** for that PR. The count source is `ao review list
  --json` filtered to runs against the current PR; no durable counter or
  daemon is added. On the 21st outstanding review with open findings, the
  orchestrator routes a notification to the human (`notify`-class action or
  direct notification) and does not respawn.
- **No merge by orchestrator.** The orchestrator MUST NOT call `gh pr merge`
  or click Merge. Merge is a human decision in this repo. The orchestrator
  MAY emit a "ready for human merge" notification only when **all** of the
  following are true:
  - the latest AO-local review run for the current PR head is in a terminal
    completed status (e.g. `clean` / a finished run — **not** `queued`,
    `preparing`, `running`, or `outdated`, whose zero counts are merely
    "no result yet") **and** has `findingCount: 0` and `openFindingCount: 0`;
  - the PR is open with green CI for the same head SHA;
  - either the worker has reported `ready_for_review` for the current PR
    head, **or** the latest clean review ran after the worker's latest
    `ready_for_review` report and no newer commits exist;
  - the orchestrator has not observed a later `changes-requested`,
    `ci-failed`, or failed review run for the same head.
- **Backstop reaction wiring.** The `reactions` block MUST contain a
  `report-stale` entry with `auto: true, action: send-to-agent`, and a
  `message` that explicitly tells the worker to check pending AO review
  findings. This is a backstop only; the round-limit and ping discipline
  do not depend on it firing.
- **Worker response contract.** `prompts/agent_rules.md` MUST contain a
  worker-side clause that:
  - lists the exact `ao report` states the worker must emit on the review
    path (`addressing_reviews`, optionally `fixing_ci`, then
    `ready_for_review`);
  - forbids silently going idle after receiving review findings;
  - requires a terminal failure signal via an explicit `ao send` to the
    orchestrator (or a non-`completed` terminal report) with a reason if the
    worker cannot address findings — **not** `ao report completed`, which the
    next clause forbids while findings remain open, so the two clauses do not
    contradict;
  - **forbids `ao report completed` while the latest review run for the
    current PR head has `openFindingCount > 0`, or while any review run
    for the current PR head is in `needs_triage`.**
- **Migration paragraph.** `docs/migration_notes.md` MUST contain a
  paragraph instructing operators how to fold the updated
  `orchestratorRules` block from `agent-orchestrator.yaml.example` into
  their existing live config and restart AO (run `ao stop`, then `ao start`)
  for the rules to take effect.

## Upgrade-safety check

- No edits to `packages/core/**`, `vendor/**`, or any AO runtime code.
- No new repository secrets. The orchestrator and worker behaviors rely
  only on commands already in `ao --help`
  (`spawn --claim-pr`, `report`, `review run/send/list`, `send`,
  `session kill`).
- YAML changes are schema-compatible with
  `https://raw.githubusercontent.com/ComposioHQ/agent-orchestrator/main/schema/config.schema.json`:
  - `reactions.report-stale` matches the reactionKey enum used in
    `notification-data.js` (`report-stale` → `report.stale`).
  - `reactionConfig` fields used MUST be a subset of:
    `auto, action, message, priority, retries, escalateAfter, threshold,
    includeSummary`.
- AO's 30-minute `staleReportTimeoutMs` is upstream-hardcoded and is **not**
  patched here. Wall-clock enforcement is intentionally out of scope; see
  the no-watchdog constraint in the binding surface.

## Verification

- **Static — orchestratorRules content.** Reading
  `agent-orchestrator.yaml.example` shows an `orchestratorRules` block that
  contains, at minimum:
  - explicit handling of AO-emitted statuses (`needs_triage` triggers
    `ao review send`; `waiting_update` is the awaiting-worker state);
  - a state-derived reconciliation trigger that (a) enumerates open PRs and
    their current head SHA from GitHub via the `gh` CLI, (b) cross-references
    each against `ao review list --json`, (c) resolves the target worker
    session from `ao status --json --reports full` and names the no-live-session
    path (e.g. `ao spawn --claim-pr <PR>`) before running review, and (d)
    starts a review run for any open PR whose current head SHA has no run and
    none in flight — explicitly independent of any worker `pr_created` /
    `ready_for_review` report, with the in-flight / `outdated` / round-limit
    guards stated;
  - the named pending state for "review send issued, awaiting worker
    response";
  - the four named exit conditions from that state;
  - a turn-opening decision procedure that inspects
    `ao review list --json`, `ao status --json --reports full`, and
    `ao events list --json`;
  - the single-ping and respawn discipline using `ao send`,
    `ao session kill`, and `ao spawn --claim-pr`;
  - the 20-round prompt-level stop rule sourced from `ao review list
    --json`;
  - the merge-ready preconditions including the deadlock-safe
    `ready_for_review` clause;
  - an explicit sentence stating that wall-clock targets are operator
    guidance, not enforced timers.
- **Static — agent_rules.md content.** Reading `prompts/agent_rules.md`
  shows the worker response contract listing the required `ao report`
  transitions, the prohibition on silent idleness after receiving AO-local
  review findings, the terminal failure path, and the prohibition on
  `ao report completed` while `openFindingCount > 0` or any run on the
  current head is in `needs_triage`.
- **Static — reactions wiring.** Reading `agent-orchestrator.yaml.example`
  shows the `report-stale` reaction block with `auto: true,
  action: send-to-agent`, and a `message` field referencing pending AO
  review findings.
- **Smoke — config parses cleanly.** Applying the example-derived
  `orchestratorRules` and `reactions` blocks to a live
  `agent-orchestrator.yaml`, then running `ao start`, produces no
  schema validation warnings and no parser errors in `ao` startup logs.
- **Behavioral — one decision-procedure walkthrough.** With the orchestrator
  active and given control (e.g. via a manually issued `ao send` from the
  operator), and with `ao review list` showing a run in `waiting_update`
  with `openFindingCount > 0` for an open PR whose worker has not reported
  `addressing_reviews` since the send timestamp, the orchestrator executes
  the documented decision procedure: it issues exactly one `ao send` ping
  if no prior ping is recorded in `ao events list` for this pending
  state, otherwise it issues `ao session kill` followed by `ao spawn
  --claim-pr <PR>`. This is a single voluntary walkthrough verifying the
  rules are actionable when the orchestrator has a turn — it is not a
  wall-clock test of when the next turn will occur.
- **Manual — operator readability.** An operator following only
  `docs/migration_notes.md` and the orchestratorRules block can describe,
  without consulting the architect, what the orchestrator should do next
  for a given combination of `ao review list` state and worker
  `ao status --reports full` state.
