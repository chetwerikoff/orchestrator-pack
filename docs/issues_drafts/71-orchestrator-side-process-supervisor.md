# One supervised entry point for all orchestrator side-processes, with liveness self-healing

GitHub Issue: #205

## Prerequisite

None blocking. Generalizes / subsumes the supervision notes in:

- `docs/issues_drafts/60-orchestrator-wake-supervisor.md` (GitHub #168) — the existing
  supervisor of the wake **listener** + **heartbeat** (restart-on-exit only). This draft
  broadens that supervisor's scope and its failure model; the #168 invariants
  (independent children, supervisor-owned session-id resolution) are preserved, not
  replaced.
- `docs/issues_drafts/69-orchestrator-review-send-reconcile.md` (GitHub #202,
  criterion 9) — requires the new delivery reconciler to run under a broadened
  supervisor. That requirement becomes a special case of this draft; if #202 merges
  first with a narrower broadening, this draft generalizes it (additive, not a gate).

## Goal

Replace the current "start several independent processes by hand, each unsupervised or
only restart-on-exit" setup with **one** operator entry point that owns and keeps alive
**all** orchestrator side-processes, and that recovers a child which has **crashed** OR
gone **alive-but-stalled** (hung, or stuck in a repeating blocking error). Today the
wake listener and heartbeat are supervised (restart-on-exit), but the review-trigger
reconcile, the CI-green worker-wake reconcile, and the review-finding delivery-confirm
run as bare, unsupervised processes — and even the supervised ones are only restarted
on clean exit, not on a silent stall. A single death or stall in any of them silently
disables part of the autoloop.

**Root cause (5 Whys, condensed).** Review trigger was unavailable for a whole episode
→ the review-trigger reconcile process was dead → it crashed at 2026-06-05 11:21 with
`Cannot bind argument to parameter 'OpenPrs' because it is an empty collection` (zero
open PRs) and its loop terminated on that one tick error → nothing restarted it because
it ran outside any supervisor → only the wake listener + heartbeat are supervised, and
only on exit. Two durable gaps: (a) the reconcile loop dies on a single tick error and
does not tolerate the empty-open-PRs state; (b) supervision does not cover all
side-processes nor catch a stalled-but-alive child.

**Decision — custom supervisor, not systemd/pm2 (logged).** Extend the existing #168
pwsh supervisor rather than delegating to systemd/pm2/a generic process manager. Reason:
the children need supervisor-owned **AO-session-id resolution** (resolve from `ao status`,
re-resolve on id change) that a generic manager does not natively do, and the supervisor
must run cross-platform on the operator's WSL2/pwsh setup where the #168 supervisor
already ships. A generic manager remains a valid **fallback** for raw restart-on-exit but
is not the primary mechanism. Do not re-open this as "just use systemd."

**Decision — one issue, two layers (logged).** Process supervision and in-child reconcile
crash-resilience are kept in this single issue deliberately (the operator asked for one
self-healing entry point, and both descend from the same 2026-06-05 incident), but they
are **distinct concerns with distinct acceptance criteria and distinct durable homes**
(the supervisor script vs the reconcile scripts). They are complementary defense-in-depth,
not one mechanism: a resilient loop should not die; the supervisor catches it if it does
or stalls. The planner may land them as separate PRs under this issue.

## Binding surface

- **One entry point owns all side-processes — registry is the single source of truth.** A
  single operator command starts, stops, and reports status for the full set the autoloop
  needs. At authoring time that set is: the wake **listener**, the **heartbeat**, the
  **review-trigger reconcile**, the **CI-green worker-wake reconcile**, and the
  **review-finding delivery-confirm** (five). But the managed set is defined by an
  **extensible registry/configuration** the supervisor reads — **not** a hardcoded count —
  so a future side-process (e.g. draft 70's fast review-trigger, **if** it is implemented
  as a process) is added by **registration**, not a new bespoke launcher. **Composition
  rule:** any PR that introduces a new long-running orchestrator side-process MUST add its
  registry entry **and** its start/stop/status/restart/stall coverage in the **same**
  change; supervision validation (below) keys off *every registered child*, so a new
  process cannot ship outside the supervisor by being "not one of the original five."
- **Children stay independent — never merged.** Each managed process remains its own
  process with no shared failure path; the supervisor launches and monitors N children,
  it does not fold any two into one loop (preserves the #168 Decision-2 invariant: the
  heartbeat stays independent of the webhook-receipt path; generalized to all children).
- **Self-healing on crash AND on stall — but stall-restart must be side-effect-safe.**
  The supervisor restarts a child that exits (crash / non-zero), within a bounded time,
  leaving the others running. It ALSO detects a child that is alive but not making
  progress — hung, or stuck repeating a blocking error — and recovers it. Because the
  managed children issue real side effects (`ao review run`, `ao review send`), stall
  detection MUST distinguish *legitimately idle between ticks* and *slow on an AO/GitHub
  call* from *hung*, and recovery MUST NOT duplicate an in-flight side effect:
  - The liveness signal is a **progress/heartbeat** contract per child (the planner picks
    the mechanism), with an idle-safe threshold defined **relative to that child's own
    cadence** — a child idle for less than its tick interval is healthy, not stalled.
  - A child is **not** restarted while a fenced side-effecting command is in flight; a
    restart after a partial side effect must be **idempotent** against authoritative AO
    state (a covered run / a run already out of `needs_triage` is not re-issued), so a
    false-positive or real stall-restart produces **no** duplicate `ao review run` /
    `ao review send` and no stale/false dedupe record.
  - False-positive resistance is observable: a child that is merely idle or slow is not
    restarted; only a child past its idle-safe threshold with no progress is.
- **Session-id resolution generalized — without a restart storm or shared fate.** Reuse
  #168's supervisor-owned resolution for every managed child: honor an explicit override;
  otherwise resolve the orchestrator session id from `ao status`; re-resolve when the id
  changes; stop/suspend children when the session disappears; wait-or-report (bounded,
  actionable message) when no orchestrator session exists yet — never launch a child at a
  nonexistent or unrelated id. To keep the #168 Decision-2 "no shared fate" invariant true
  in practice (a single id-resolution glitch must not down the whole autoloop at once):
  - A **transient** `ao status` failure or a brief id **flap** is **debounced** — the
    supervisor does not tear down all children on a single glitch; it confirms the change
    is stable before acting.
  - On a confirmed id change, children are restarted **staggered / rolling** (not all
    simultaneously), each with restart **backoff + jitter**, and each is **drained** (let
    an in-flight fenced command finish or fail closed) before stop.
  - Supervisor-level failure handling is explicit: the supervisor's own crash is itself
    recoverable (operator restart documented), and a child keeps its last-good behaviour
    rather than being killed by an ambiguous supervisor state.
- **Reconcile-loop crash resilience (durable home: the reconcile scripts) — fenced, not
  a blind swallow.** Independent of the supervisor, each reconcile loop must survive a
  single tick failure: a per-tick error is logged and the loop continues — one tick error
  never terminates the long-running process. The live pre-run recheck snapshot must
  tolerate **zero open PRs** (an empty collection) without crashing — extending the
  fixture-only fix #195 to the live path. **Safety boundary (not optional):** the
  per-tick catch is at a **safe boundary** — a tick that failed **after** a partial side
  effect must NOT record false success; the next tick **fails closed** and re-derives from
  authoritative AO state (dedupe via run/send state, same discipline as #189/#202), so
  continuing past an error never masks corrupted state nor enables a duplicate
  `ao review send` / `ao review run`. A broad catch-all that swallows mid-side-effect and
  blindly continues fails this issue.
- **Delivery-process restart safety (#202/#171 contract preserved).** The
  `review-finding delivery-confirm` child carries a dedupe/state-file contract that
  governs first-send vs re-delivery (#202 first `ao review send`; #171 confirmation /
  bounded re-delivery). Restarting or stall-recovering it MUST preserve that contract:
  no false delivery record, no repeated `waiting_update` send, no re-delivery loop, no
  first-send by a path that already sent — and it must remain compatible with the #171
  confirmation process. Supervising this child must not regress the first-send/re-delivery
  boundaries #202 depends on.
- **Supervisor lifecycle integrity (no duplicate children, fail-closed config, defined
  partial-start, safe stop).**
  - **Crash/restart adoption.** Because children run detached, a restarted supervisor MUST
    enumerate existing managed children by **stable identity** and adopt or safely terminate
    them **before** launching replacements — never leave two copies of a side-effecting child
    (`review-trigger reconcile`, `delivery-confirm`) running at once.
  - **Registry validation, fail-closed.** The managed-set registry/config is validated at
    startup against a required-child definition (all required children present; no duplicate
    ids / log / state paths; runnable commands; the cadence/heartbeat metadata stall
    detection needs; side-effecting children classified for fencing). On a malformed or
    incomplete registry the supervisor **fails closed** with an actionable message and
    launches **nothing** — it does not silently run a reduced set.
  - **Partial-start is defined.** If only part of the set starts, startup does **not** report
    success: it exits nonzero/actionable and either rolls back the started children or enters
    an **explicit** degraded state that does not let healthy children drive unsafe downstream
    side effects against absent peers.
  - **Stop is drained too.** The same drain / fail-closed semantics as id-change restart apply
    to operator **stop**: a stop during an in-flight fenced `ao review run` / `ao review send`
    lets it finish or fail closed, leaving no false dedupe record and no duplicate send/run on
    the next start.
- **Detached + logged; clean status/stop.** All managed processes run detached with their
  output captured to logs; the operator can query whether all are up and stop all cleanly
  from the same entry point.
- **Operator adoption.** The go-live and recovery runbooks are updated so the single
  supervisor is the documented way to bring up the side-processes, replacing the
  per-process manual launches; the manual commands remain documented as the fallback.
  Document any new operator env var / flag with a safe default when unset, and the
  restart step. List the post-PR operator steps (new launch command, env, restart,
  status-verification command).

## Files in scope

- `scripts/**` — the generalized supervisor entry point, the reconcile-loop resilience
  changes, and their tests (new files as the planner declares them), consistent with the
  existing wake / reconcile scripts.
- `docs/**` — `orchestrator-autoloop-go-live.md`, `orchestrator-recovery-runbook.md`, and
  the wake-runbook updates.
- Test fixtures for supervision (crash + stall), id-resolution across all children, and
  the reconcile crash-resilience / empty-open-PRs scenarios.

## Files out of scope

- `packages/core/**`, `vendor/**`, `.ao/**`.
- The local (gitignored) `agent-orchestrator.yaml`.
- The **decision logic** of each child beyond what crash-resilience requires: the
  supervisor supervises children, it does not rewrite their wake / reconcile algorithms.
  The only in-child changes in scope are the per-tick error handling and the empty-open-PRs
  tolerance in the reconcile loops.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

## Acceptance criteria

1. One command starts the full managed set; one command reports the status (up/down) of
   every managed child; one command stops all cleanly.
2. Each managed child runs as a separate process; crashing/killing one is auto-restarted
   by the supervisor within a bounded time, and the other children are unaffected.
3. A child that is alive but not making progress (simulated hang or repeating blocking
   error) is detected and recovered without operator action — demonstrated with a stub
   child in a test.
4. **Stall detection is side-effect-safe.** Tests show: (a) a child merely idle within its
   tick cadence, or slow on an AO/GitHub call, is **not** restarted (no false positive);
   (b) a stall-restart around an in-flight `ao review run` and an in-flight `ao review send`
   produces **no** duplicate run/send and no false/stale dedupe record — the restarted
   child re-derives from authoritative AO state and no-ops on already-covered / already-sent.
5. Session-id resolution behaviour from #168 (override / resolve-from-`ao status` /
   re-resolve on id change / stop on session disappearance / wait-or-report when none)
   applies to **all** managed children — test.
6. **No restart storm / shared fate.** Tests show: a transient `ao status` failure or a
   brief id flap is debounced (children are not all torn down on one glitch); a confirmed
   id change restarts children **staggered with backoff/jitter** (not simultaneously), each
   drained before stop; a single id-resolution glitch does not down the whole managed set
   at once.
7. Each reconcile loop survives a single tick error: injecting a throwing tick logs the
   error and the process keeps ticking (does not exit) — test.
8. **Tick error handling is fenced / fail-closed.** A test injecting a failure **after** a
   partial side effect shows the loop does **not** record false success and the next tick
   re-derives from authoritative AO state (no duplicate `ao review send` / `ao review run`);
   a blind catch-all that continues mid-side-effect fails the test.
9. The live pre-run recheck path handles zero open PRs without a crash (no
   empty-collection bind error) — a fixture replaying the 2026-06-05 11:21 condition passes.
10. **Delivery-process restart safety.** Fixtures restarting / stall-recovering the
    `review-finding delivery-confirm` child **before**, **during**, and **after** a send
    show: no false delivery record, no repeated `waiting_update` send, no re-delivery loop,
    no first-send by an already-sent path, and continued compatibility with the #171
    confirmation process (#202 boundaries preserved).
11. **Supervisor crash/restart adoption.** A test restarting the supervisor while children
    are running shows it discovers existing children by stable identity and adopts or
    safely terminates them — no duplicate side-effecting child ends up running.
12. **Registry validation fail-closed + covers every registered child.** Tests for
    missing-required-child, duplicate id/path, invalid command, and misclassified
    side-effecting entry show the supervisor refuses to start (actionable error, launches
    nothing) rather than running a reduced set. Validation and supervision key off **every
    registered child**, not a hardcoded set — a newly registered side-process (e.g. a
    draft-70 fast-trigger process) is supervised and validated like any other with no spec
    change here.
13. **Partial-start handling.** A fixture where one child fails to start shows startup
    exits nonzero/actionable and either rolls back or reports an explicit degraded state —
    never a silent success with a missing required child.
14. **Stop-during-drain safety.** Tests stopping the supervisor during an in-flight
    `ao review run` and `ao review send` show the command drains or fails closed, with no
    false dedupe record and no duplicate run/send on the next start.
15. The go-live / recovery runbook documents the single supervisor as the primary bring-up
    and retains the manual per-process commands as the fallback.

## Upgrade-safety check

- No edits under `packages/core/**` or `vendor/**`; AO is consumed, not patched.
- Children remain independent processes — no design that folds two managed processes into
  one shared loop.
- No unsupported YAML fields; no `reviewer:` block.
- No new repository secrets; any new operator env var is documented with a safe default.

## Verification

- pwsh 7+ tests / fixtures for criteria 1–15, runnable in CI without a live AO:
  start/stop/status of the managed set; fault-injection for crash and stall recovery;
  side-effect-safe stall detection (no false-positive restart, no duplicate run/send);
  id-resolution across all children; debounce + staggered/backoff restart on id flap;
  per-tick error survival; fenced/fail-closed tick error handling; empty-open-PRs
  tolerance; delivery-process restart safety before/during/after a send; supervisor
  crash/restart adoption; registry validation fail-closed; partial-start handling;
  stop-during-drain safety.
- A supervisor `status` output enumerates all managed children and their up/down state.
- The recovery runbook change is present and the manual fallback commands still resolve.
