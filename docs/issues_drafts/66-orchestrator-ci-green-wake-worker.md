# Orchestrator must wake the live PR-owning worker when CI turns green after `fixing_ci`

GitHub Issue: #191

## Prerequisite

- None blocking. Relates to (does **not** depend on):
  - `docs/issues_drafts/37-ci-failed-ping-before-report-stale-backstop.md`
    (GitHub #109) — the **orchestrator-side CI-failure ping** plus the
    `report-stale` (~30 min) backstop. This issue is the **missing CI-success
    mirror** of that same ping: red-CI already re-engages the worker; green-CI
    does not, except via the slow backstop.
  - `docs/issues_drafts/64-pr-created-not-terminal-worker-handoff.md`
    (GitHub #186) — the **worker-side** obligation to drive `pr_created` to a
    hand-off signal. That rule makes a *live* worker not stop silently; this
    issue ensures the orchestration *re-engages* that worker the moment CI lets
    it proceed. Complementary halves: worker willingness vs orchestrator trigger.
  - `docs/issues_drafts/00-architecture-decisions.md` §O / GitHub #98 —
    respawn on **genuine worker death**. This issue does **not** replace that
    net; a dead worker is still out of scope here and stays #98's job. This
    issue only shrinks how often the death-respawn path is reached.
  - `docs/issues_drafts/63-review-ready-worker-stuck-guard.md` (GitHub #174)
    and `docs/issues_drafts/61-review-finding-delivery-confirmation.md`
    (GitHub #171) — the **live, head-owning, single-session** invariants this
    issue must obey (no spawn, no `--claim-pr`, no kill, no split-brain).

## Goal

When a worker has opened a PR, reported `fixing_ci`, pushed a fix, and is
waiting for required CI to re-run, the orchestration must re-engage **that same
live worker** as soon as the PR's required CI transitions to green — so the
worker can complete its hand-off (`ready_for_review`) without waiting out the
~30-minute `report-stale` backstop, and without the orchestrator killing and
respawning a fresh worker.

Today the asymmetry strands the worker: a CI **failure** pings it
(`ci-failed → send-to-agent`), but CI turning **green** only emits an operator
notification (`approved-and-green → notify`, and that also requires review
approval, so it fires later than the bare-CI-green moment). A worker that paused
for CI therefore sits idle until `report-stale`, widening the window in which it
can silently die — the opk-6 / Issue #189 / PR #190 incident, where the worker's
process exited from its pane during the CI wait and only a full `--claim-pr`
respawn recovered it.

Root cause (5 Whys, opk-6 / PR #190): worker ended in `stuck`/`exited` with an
unadvanced green PR → because nothing re-engaged it when CI went green → because
the orchestrator only has a CI-**failure** ping, not a CI-**success** one →
because the success path was assumed covered by the worker self-driving (#186)
and by `report-stale` → but a worker physically cannot proceed until the async
CI result returns, and the only fast re-engagement event (CI green) is wired to
`notify`, not to the worker → so a paused-but-live worker has no timely trigger,
and a paused worker that dies in the gap forces the expensive respawn path.

The durable fix is a **fast, idempotent, live-worker-only** orchestrator trigger
on CI-green-after-`fixing_ci`, mirroring the existing CI-failure ping.

## Binding surface

- The repository commits to a documented orchestration behavior: **on a PR
  whose required CI transitions to green while its linked worker is alive,
  head-owning, and has not yet had a `ready_for_review` (or later) state
  accepted for the current head SHA, the orchestrator re-engages that same
  worker once** to resume its hand-off.
- The trigger is a **fast path**, not a replacement: it must coexist with the
  `report-stale` backstop (slow recovery) and the `approved-and-green` operator
  notification (which keeps its current meaning), and must not pre-empt the
  death-respawn path (#98) for genuinely dead workers.
- The behavior's durable home is the canonical orchestration config
  (`agent-orchestrator.yaml.example` — `reactions` and/or `orchestratorRules`)
  and `prompts/agent_rules.md`, consistent with how #109 and #189 are housed.
  Whether AO 0.9.x exposes a discrete CI-green reaction trigger or the behavior
  must live in `orchestratorRules` prose plus the state-derived path is a
  **planner determination** (see Acceptance criteria) — this spec does not
  presume a reaction key exists.
- **Operator adoption** (touches `reactions` / `orchestratorRules` and
  `prompts/agent_rules.md`): after merge the operator must merge the new
  reaction/rule into the live `agent-orchestrator.yaml`, then `ao stop` / `ao
  start` so the orchestrator reloads; verification command(s) per the
  Verification section.

## Files in scope

- `agent-orchestrator.yaml.example` — the canonical `reactions` /
  `orchestratorRules` surface (the trigger and its guards).
- `prompts/agent_rules.md` — the universal worker/orchestrator rule text the
  example config references.
- Orchestration helper scripts under `scripts/**` **only if** the planner needs
  a state-derived check (e.g. alongside the existing review-trigger
  reconciliation path) — planner's choice; new files marked `(new)`.
- Tests/fixtures covering the trigger and its guards (`tests/**`,
  `scripts/fixtures/**`, or the relevant plugin test dir) — planner's choice.
- `docs/issues_drafts/37-ci-failed-ping-before-report-stale-backstop.md` and/or
  `docs/architecture.md` — only to record the CI-success mirror as a decision,
  if the planner adds an orchestration helper.

## Files out of scope

- `packages/core/**`, `vendor/**` — never.
- AO plugin runtime cores under `plugins/**/*` except test fixtures the task
  needs.
- `.github/workflows/**` — this task changes no CI definition.
- The standalone worker prompt files beyond `prompts/agent_rules.md`.
- Anything implementing **death detection or respawn** (#98) — explicitly not
  this task.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
.github/workflows/**
```

## Acceptance criteria

1. **Feasibility resolved, not assumed — and delivery is not turn-gated.** The
   deliverable states whether AO 0.9.x emits a CI-green/CI-transition reaction
   trigger usable for `send-to-agent`. If it does, the trigger uses it. If it
   does **not**, the behavior must still deliver the nudge **without depending on
   an LLM orchestrator taking a turn** — i.e. a dedicated, automatically-running
   sender path (not prose alone that only fires when the orchestrator next
   thinks), with bounded worst-case latency from green-observed to nudge-sent
   that is demonstrably far below the `report-stale` window. A prose-only
   `orchestratorRules` rule that runs only on the next orchestrator turn does
   **not** satisfy this criterion. Note: the existing review-trigger
   reconciliation path issues `ao review run`, not worker `ao send`, so reusing
   it as-is is insufficient — the planner must provide an actual worker-`send`
   delivery path. Either way the example config validates against the AO 0.9.x
   schema (no silently-ignored blocks). The mechanism and its measured latency
   bound are the planner's to choose and report.
2. **Fires on the right state — level-derived, not edge-only.** The
   re-engagement is owed for any PR whose **required CI** (same definition as
   `prompts/agent_rules.md` REQUIRED CI) is **currently green** for a head SHA
   whose linked worker's last accepted state is pre-hand-off (`fixing_ci` /
   `working` / `pr_created`), with no `ready_for_review` / `addressing_reviews` /
   later state accepted on that head, **and which has not already been nudged for
   that transition identity** (criterion 4). It must converge from the *current
   state*, not only from a live red→green edge: a head that is already green when
   the sender starts, restarts, or is first adopted — or that flipped green
   while the sender was down — must still be nudged on the next evaluation, not
   left until `report-stale`. The idempotency record is what prevents this
   level check from re-nudging an already-handled head.
3. **Live, head-owning, single-session — re-checked at send time, fail-closed.**
   The trigger sends **only** to the alive worker session linked to that PR head;
   it never spawns, never `--claim-pr`, never kills, and never messages a
   different session — the #97/#171/#174 split-brain invariants hold.
   Ownership + liveness (PR head SHA still current, linked session id unchanged,
   runtime alive) are re-verified on a **single consistent snapshot immediately
   before sending**, not only when the green edge was first observed; if the
   head moved, the session id changed (respawn/reclaim), or the runtime is not
   alive, the trigger **does nothing and consumes no dedupe slot** (fail closed;
   death-respawn #98 owns the not-alive case). The dedupe record (criterion 4)
   is written **only after** a send to a confirmed-live owner succeeds — a
   send aimed at a stale/dead/replaced target must never mark the transition as
   already-nudged.
4. **Idempotent across reruns and concurrent observers.** At most one nudge per
   genuine *pre-hand-off → green* transition. Repeated identical green
   observations of an already-nudged state do not re-send. A renewed
   red-or-pending → green on the **same head SHA** (a CI rerun or red/green
   flap — head does **not** change on rerun) is a **new eligible transition**,
   not a suppressed duplicate, provided the worker is still pre-hand-off. If two
   observation paths (e.g. a reaction and a reconciler) see the same transition,
   they must not both send — at most one nudge reaches the worker per
   transition. The deliverable defines the transition identity that makes this
   hold; this spec fixes the **behavior**, not the storage shape.
   - **Failure-mode priority (no exactly-once illusion).** Strict exactly-once
     across a sender crash is not achievable, so the spec fixes which way to
     fail: when a send succeeded but its dedupe record was lost/uncertain
     (crash/timeout), the acceptable outcome is **at most a benign duplicate
     nudge to the same still-live, still-pre-hand-off owner** — a second
     "continue" message is effect-idempotent for a worker that is already
     working. What is **never** acceptable: (i) the ambiguity suppressing the
     *only* nudge for a transition, or (ii) a retry/duplicate landing on a
     stale/dead/replaced target (criterion 3's pre-send recheck still gates
     every send, including retries).
5. **Does not pre-empt review or merge rules.** The trigger does not fire once
   the worker is in the review loop (`ready_for_review` accepted) — it must not
   collide with the "do not ping a review-ready worker" guard (#174); and it
   does not itself merge, approve, or alter `approved-and-green` semantics.
6. **Backstop preserved.** `report-stale` and the CI-failure ping remain
   functional and unchanged in meaning; the new trigger is additive and is the
   fast path, not their replacement.
7. **Scope honesty recorded.** The deliverable documents (in the rule text or
   architecture note) that this trigger reduces the frequency of the
   death-respawn path but does not recover an already-dead worker — that remains
   #98.

## Upgrade-safety check

- No edits to `packages/core/**` or `vendor/**`.
- No unsupported YAML: the example config must parse and validate on AO 0.9.x;
  any reaction key used must be one AO actually honors (no silently-ignored
  blocks, per the `reviewer:`-block precedent in `CLAUDE.md`).
- No new repo secrets or external services.
- No change to required-CI definition, review-trigger idempotency (#189), or the
  death/respawn contract (#98) — this task only adds the CI-green nudge.

## Verification

1. **Feasibility + non-turn-gated delivery stated** — the PR/declaration states
   the AO 0.9.x trigger mechanism chosen (reaction key vs a dedicated
   automatically-running worker-`send` path) and reports its worst-case
   green-observed → nudge-sent latency bound, showing it is far below
   `report-stale` and does not require an LLM orchestrator turn (Acceptance
   criterion 1).
2. **Config validates** — the orchestrator starts cleanly with the updated
   example config merged (no schema error, no ignored block); show `ao start`
   reloading and `ao status` healthy.
3. **Edge, idempotency, flap, and race tested** — automated fixtures/tests
   demonstrate: (a) a pre-hand-off worker on a head whose required CI flips green
   receives exactly one nudge; (b) a second identical green observation of the
   same already-nudged state sends nothing; (c) a renewed red/pending→green on
   the **same head SHA** (rerun/flap) while still pre-hand-off is treated as a
   new eligible transition and nudges again; (d) two observation paths seeing one
   transition produce **at most one** `ao send`; (e) a `ready_for_review`-accepted
   head receives no nudge; (f) a head with no alive linked worker receives no
   nudge (and no spawn/claim/kill); (g) **races**: worker dies between green
   observation and send → no nudge, dedupe slot not consumed; respawn/reclaim
   changes the session id before send → no nudge to the stale id; PR head moves
   before send → no nudge to the superseded head; (h) **post-send record loss**:
   send succeeds but the dedupe write is lost/uncertain → a retry yields at most
   a benign duplicate to the *same live pre-hand-off owner* and never a
   suppressed-only nudge nor a send to a stale/dead target; (i) **level
   recovery**: a head already green with a live pre-hand-off worker when the
   sender first starts / restarts / is adopted (no observed edge) is still nudged
   once on the next evaluation, not stranded to `report-stale`. Tests map 1:1 to
   Acceptance criteria 2–5.
4. **Backstop intact** — a test or documented check shows `report-stale` and the
   CI-failure ping still fire on their own triggers (Acceptance criterion 6).
5. **Live smoke (operator)** — after adoption (`ao stop` / `ao start`), the
   operator confirms via `ao events` / `ao status` that a worker paused on a
   green-CI PR is re-engaged within the fast window rather than only at
   `report-stale`.

## Open questions / risks

- **Trigger availability (primary risk).** If AO 0.9.x has no CI-green reaction
  key, the orchestratorRules-prose path depends on the orchestrator taking a
  turn; the state-derived reconciliation path (as used for #163/#189) should
  bound that latency. The planner must confirm which mechanism actually delivers
  the nudge promptly.
- **Overlap with #186.** If #186's worker self-drive proves sufficient in
  practice for live workers, this trigger's marginal value is the latency cut
  (~30 min → seconds) and the shrunk idle-death window; it is still additive,
  not redundant, because a live worker cannot act before CI returns.

## Decision log (adversarial Codex pass, cycle 1)

Findings weighed as proposals, not orders (planner freedom is non-negotiable;
remedies encoded as outcomes, not Codex's prescribed storage/cadence):

- **Accepted (high) — "fallback degrades to turn-driven prose."** Real gap: the
  existing state-derived reconciler issues `ao review run`, not worker
  `ao send`, so a prose-only fallback would fire only on the next orchestrator
  turn — the very gap this issue closes. Hardened Acceptance criterion 1 to
  require non-turn-gated delivery with a reported latency bound; left the
  mechanism to the planner. Rejected the prescribed "dedicated reconciler with
  fixed cadence" wording as over-specification.
- **Partial (high) — "idempotency not durable under flaps/concurrency."**
  Accepted the kernel: CI reruns/flaps recur on the **same** head SHA, so
  head-SHA-only dedupe wrongly suppresses a later legitimate green; concurrent
  observers could double-send. Rewrote criterion 4 to define behavior across
  same-head reruns and concurrent paths. Rejected the prescribed dedupe-key
  schema (PR#/run-IDs/status-epoch/storage) — planner's to design.
- **Accepted (medium) — "live guard checked conceptually, not at send time."**
  Genuine TOCTOU; mirrors the house pre-run-recheck pattern (#189/#163).
  Hardened criterion 3 with a single-snapshot pre-send recheck, fail-closed, and
  "record dedupe only after a successful send to a confirmed-live owner," plus
  race fixtures in Verification. Encoded as outcomes, not data structures.

## Decision log (adversarial Codex pass, cycle 2)

- **Accepted (high) — "successful send + lost dedupe record → duplicate."** Real
  spec-level ambiguity introduced by cycle-1's "record only after successful
  send": exactly-once across a crash is impossible. Resolved by **declaring the
  failure-mode priority** in criterion 4 rather than adding machinery — bias
  at-most-once, tolerate a rare benign duplicate to the same live pre-hand-off
  owner (a second "continue" is effect-idempotent), but never suppress the only
  nudge and never let a retry hit a stale/dead target (criterion 3 pre-send
  recheck still gates retries). Added Verification fixture (h). Mechanism left
  open.

## Decision log (adversarial Codex pass, cycle 3 — cap)

- **Accepted (high) — "edge-only trigger strands already-green PRs after sender
  downtime/adoption."** Real gap: keying on the red→green *edge* misses heads
  that are already green when the sender starts/restarts/is adopted, or that
  flipped while it was down. Resolved by making criterion 2 **level/state-derived**
  (fire for any currently-green + pre-hand-off + not-yet-nudged head, converge
  from current state, not only an observed edge) — mirroring the #163
  state-derived reconciler; idempotency (criterion 4) prevents re-nudging. Added
  Verification fixture (i). Mechanism/cadence left to the planner. **3-pass cap
  reached; no findings left open.**
