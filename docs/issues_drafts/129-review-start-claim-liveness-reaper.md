# Review-start claim lifecycle must reclaim by holder liveness, not age alone

GitHub Issue: #417

## Prerequisite

- `docs/issues_drafts/100-review-start-claim-atomic-single-winner.md` (GitHub **#308**,
  merged) — atomic per-`(PR, head)` claim, canonical store, claim release when a
  **covering run** reaches terminal via the #287 dead-run reaper. **Gap this issue
  closes:** release paths assume the holder survives to call completion, or that a
  terminal run exists with a bound run id the recovery path recognizes.
- `docs/issues_drafts/120-event-driven-review-trigger-on-ready-for-review-handoff.md`
  (GitHub **#381**, merged) — handoff admission + ≤30s first-review latency target;
  AC17 orphaned-claim reclaim on **re-acquire** only. **Gap:** reclaim is
  **age-based** (fixed stale window), not **liveness-based**; no background sweeper.
- `docs/issues_drafts/123b-review-ready-report-state-seed-backstop.md` (GitHub **#391**,
  merged) — co-primary fast path that **consumes** the claim; this issue hardens what
  happens when seed (or any acquirer) holds a claim across slow I/O or dies mid-flight.
- `docs/issues_drafts/103-llm-turn-review-start-claimed-gate.md` (GitHub **#318**,
  merged) — LLM-turn claim must obey the same orphan / no-run release semantics.
  This issue delivers the **shared** liveness reaper those ACs presuppose.

## Sibling

- `docs/issues_drafts/130-review-handoff-admission-receipt-budget-degrade.md` (GitHub
  **#418**) — handoff `admission_lookup_unknown` receipt-budget burn (separate Node
  listener runtime). PR #407 upper segment (~14 min handoff) vs this draft's claim-hold
  segment (~9 min). Independent PRs.

## Prior-art recon (Gate A)

| Source | What it already settled | Why this draft is still needed |
|--------|-------------------------|--------------------------------|
| **#267 / #308 (shipped)** | Acquire-before-run; single winner; release when run terminal + visible | No periodic reaper; dead holder with no completed release leaves `active`; `run_not_visible` after successful run can leave `active` |
| **#381 AC17 (shipped)** | Orphan reclaim on next acquire attempt | On-demand only; **StaleMinutes** age gate, not holder PID/process liveness; wrong-head keys never touched |
| **#287 run reaper (shipped)** | Terminalize dead **review run** | `Release-ReviewStartClaimForTerminalizedRun` needs **boundRunId** match; claim without binding → silent skip |
| **#318 (shipped)** | LLM claim: do not release while run launch pending visibility | Reaper must inherit same non-duplication rule; not spelled in this draft's ACs before review |
| **#391 seed (shipped)** | Poll backstop + claim consumption | Incident PR #407: seed held claim ~9 min over gh I/O while all surfaces `claim-skip` |
| **#390 (shipped)** | Handoff admission | Receipt-budget burn on lookup failure → **sibling #418**, not this draft |
| **Open drafts** | None cover claim **background reaper**, **I/O-bounded hold**, or **run_not_visible terminalize** | — |

**Decomposition verdict:** **claim lifecycle only** (D1 hold over I/O, D2 no reaper,
D3 post-run `run_not_visible`). Handoff receipt degradation is **sibling #418**
(separate runtime / harness). **Single-PR buildable** — no separate migration issue;
legacy field-less orphans are cleared by the same reaper predicate as new claims.

## Goal

Automated review-start claims must not behave as unbounded coarse locks. An
`active` claim is reclaimed when the holder is dead and there is no in-flight
covering run for `(PR, head)` — **without** waiting a fixed age window and
**without** requiring a later starter to collide on the exact same head key. Claim
ownership must not span slow external snapshot I/O. Reclaim plus any subsequent
restart must never produce two concurrent review runs on the same `(PR, head)` —
non-duplication is enforced by atomic single-winner acquire (#308), not by
assuming run records are already visible. A post-run completion that cannot see
the new run must terminalize the claim, not leave it `active`.

```behavior-kind
action-producing
```

```contract-evidence
none
```

No new upstream AO/gh field binding. Evidence is pack-local claim records,
supervisor logs, and the PR #407 / opk-2 recurrence (2026-06-23).

## Binding surface

**Re-used (do not re-implement):** per-`(PR, head)` key, acquire-before-run
ordering, single-winner acquisition (#308), covered-head / readiness gates (#195,
#352), automated starter surfaces, #287 run terminalization.

**Added / corrected:**

1. **Liveness-based orphan reclaim (D2).** A supervised periodic sweeper inspects
   `active` claims and terminalizes them when **all** hold:
   - holder is **provably not alive** on the local supervisor host — liveness check
     MUST NOT be fooled by PID reuse (planner owns mechanism);
   - no covering review run for `(PR, head)` per the same in-flight predicate
     already used at acquire time (planner owns exact status set);
   - no durable launch-pending intent still active within its bounded budget (see
     §4);
   - reclaim and completion paths are **lost-update-safe**: concurrent reclaim or a
     late completion from a superseded holder MUST NOT clobber a newer winning claim
     (planner owns versioning / locking).
   Reclaim is **not** gated on `StaleMinutes` alone when holder is provably dead on
   the local host and launch-pending is absent. When a **terminal-covered** run
   exists for `(PR, head)` but the claim is still `active` (including unbound
   `boundRunId`), the reaper terminalizes the claim with WARN audit — not only
   run-recovery.
   **Non-local holder:** do not PID-reclaim; mark operator-visible for manual
   resolution (fail-closed). All production claims are one-host (single operator).

2. **Reaper run-state source (D2).** The sweeper evaluates “covering / in-flight
   run” from the **local review-run store** (same source as `ao review list` —
   one batch read per tick, not per-claim GitHub open-PR fetches). Hot path must
   not add fresh gh/API round-trips per active claim per tick. **Reclaim does not
   require a fresh PR open/closed lookup** — dead holder + no local covering run is
   sufficient whether the PR is open or merged; PR-state in the scenario matrix is
   **descriptive** only. Corrupt or ambiguous run-store evidence for a key blocks
   reclaim for **that key only** (fail-closed); unrelated keys continue.

3. **Bounded claim hold — no lock over network I/O (D1).** External snapshot work
   (open-PR fetch, status poll, CI bundle) required to decide whether to run must
   either complete **before** claim acquisition, or run under a **bounded hold
   budget** after acquisition — hold, terminalization/reclaim, and any subsequent
   start share **one ≤30s end-to-end deadline from readiness** (#381); sub-budgets
   are operator-configurable (planner owns default) but MUST NOT sum past that
   envelope. Budget expiry MUST transition to a non-active terminal outcome
   plus audit so other surfaces are not `claim-skip` for multi-minute gh
   degradation. A holder whose claim was terminalized by hold expiry MUST NOT
   authorize `ao review run` or completion side effects on that superseded claim.
   Hold expiry MUST also **unblock other starters** within the ≤30s readiness envelope
   — via synchronous reclaim before `claim-skip`, wake/admission re-check, or
   equivalent immediate retry path (ten-minute reconcile is not the primary trigger).

4. **Durable launch-pending (D2 + #318).** Before invoking `ao review run`, the
   holder MUST persist durable launch intent on the claim (planner owns
   representation). The reaper consults that intent — not merely “dead holder +
   empty run-store” — when deciding reclaim. While intent is active and within its
   bounded budget (within the same ≤30s readiness envelope as hold budget),
   reaper does not reclaim into a second start. Budget expiry without a visible run
   record → fenced non-retry terminalization per shared predicates.

5. **Post-run claim completion is mandatory (D3).** If `ao review run` succeeds but
   the post-run snapshot cannot yet see a covering run, the claim MUST transition to
   a **non-active fenced** outcome within a visibility budget (within the same
   ≤30s readiness envelope) — today `run_not_visible` leaves the claim `active`;
   this issue closes that gap. **No blind retry:** a second start is allowed only
   after **positive reconciliation** (run record visible, failed-invoke proof, or
   operator resolution) — empty local store alone does not clear the fence.
   Fenced states MUST be operator-visible (e.g. `ao review list` status). Escalation
   audit when visibility stays ambiguous after the budget.

6. **Run-recovery path must release orphan claims without boundRunId (D2).** When
   a covering run exists for `(PR, head)` but the claim has no `boundRunId`,
   recovery must terminalize the orphan with at least **WARN**-level audit — not
   silent `superseded_claim` skip (today `superseded_claim` is in the no-WARN
   allowlist).

7. **Non-duplication under reclaim (D2 + #308).** Reclaiming an orphan must not
   race a holder's in-flight `ao review run` into duplicate runs: if a covering run
   is already in-flight for the key, reaper no-ops; launch-pending intent active →
   no release into a second start. Authoritative guarantee: at most one successful
   automated start per `(PR, head)` at a time via atomic acquire (#308). Reaper,
   recovery, and every automated starter MUST use the **same shared predicates** —
   not per-surface ad-hoc checks.

8. **Supervised reaper child.** Exactly **one** sweeper acts on the canonical claim
   store at a time; a crashed sweeper role is recoverable (planner owns singleton
   enforcement). Implemented as one supervised side-process with pack registry entry
   and restart-on-crash. Orphan reclaim on dead local holder with no launch-pending
   and no covering run MUST complete within **≤30s** of holder death — reaper period
   ≤30s **or** any automated starter that would `claim-skip` on a dead-holder
   `active` claim runs the same reclaim predicate synchronously before skipping.

9. **Terminal-reason contract.** Non-active outcomes introduced here MUST use a
   shared finite terminal-reason set with explicit retry-eligibility mapping
   consumed by shared predicates (planner owns names; mapping is normative). No
   surface may invent ad-hoc retry semantics.

10. **Latency target preserved.** Crash-free path with healthy dependencies: first
    automated review start after accepted `ready_for_review` + green CI remains
    ≤30s (#381). Ten-minute reconcile stays **backstop only**.

**Cosmetic note (out of scope):** misleading `surface` label in claim JSON when
seed acquires through shared planned-run helper.

## Files in scope

- Shared review-start claim module and its recovery hooks.
- Automated review-start surfaces that acquire claims (seed, reeval, reconcile,
  handoff trigger, LLM-turn per #318) — lifecycle / hold-budget / audit only.
- Review-run recovery integration for orphan claim terminalization.
- Pack side-process registry entry for the claim-reaper child.
- Tests and capture-backed recurrence fixtures for PR #407 claim-hold segment.

## Files out of scope

- Handoff receipt-budget degradation — **sibling #418**.
- One-time operator pre-ship cleanup of legacy orphan claim files; after ship the
  reaper predicate clears dead-local orphans with pre-invoke proof (28 active claims
  observed 2026-06-23; merged PRs included when predicate satisfied).
- Repo-wide GitHub API rate-limit budgeting.
- AO core webhook payload shape.
- Review execution, finding delivery, worker spawn.

## Denylist

```denylist
# review-start claim lifecycle
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
```

## Acceptance criteria

### Liveness reaper (D2)

- `active` claim, holder provably dead on local host, no launch-pending, no
  in-flight covering run for `(PR, head)` → non-active within ≤30s of holder death
  **without** waiting `StaleMinutes`.
- Terminal-covered run for key + `active` claim (unbound `boundRunId` included) →
  reaper terminalizes with WARN ≤ one reaper period.
- Non-local holder → no PID reclaim; operator-visible manual-resolution marker.
- Claim on head *H1* does not block review on *H2* when *H1*'s holder is dead and
  no run covers *H1*.
- Run-recovery: covering run + claim without `boundRunId` → terminalized with audit
  (not silent `superseded_claim`).
- Legacy field-less `active` claims: dead-local + no covering run → reclaim when
  authoritative local evidence shows **pre-invoke death** (holder dead + no `boundRunId`,
  no run-store covering record, no post-acquire side-effect audit for that key); if any
  invoke evidence exists → fence until positive reconciliation (no separate migration machine).

### Launch-pending (#318 class)

- Fixture: holder records launch intent, invokes `ao review run`, dies before run
  JSON appears → reaper does **not** reclaim; single run when record appears.
- Fixture: launch intent absent, dead-local holder, empty run-store → reclaim ≤1
  period.
- Fixture: launch intent active past bounded budget with no run record → fenced
  non-retry terminal; within the ≤30s readiness envelope, bounded reconciliation
  or operator-visible blocked state (not unbounded active claim-skip).

### Non-duplication

- Fixture: holder dead after invoke but before run visible with launch intent set →
  reaper does **not** release into a second start; single run when record appears.
- Fixture: reclaim + restart on same key → **exactly one** in-flight run for that
  key; losing acquirers abort per #308.
- Fixture: hold-budget expiry while holder still alive → superseded holder cannot
  launch; second surface may acquire and start once.
- Fixture: superseded holder attempts late completion after a newer winner acquired
  → no mutation of newer claim (lost-update-safe).

### Reaper data source

- Fixture: N active claims on one tick → at most one batch local run-store read,
  zero per-claim gh open-PR fetches.

### Bounded hold (D1)

- Fixture: post-acquire gh stall beyond configured hold budget → non-active claim +
  audit; hold terminalization, reclaim, and second-surface start complete within
  **≤30s end-to-end from readiness** (no ~9 min `claim-skip` window).
- Happy path hold ≪ 30s; #308 single-winner unchanged.

### Post-run visibility

- Fixture: `ao review run` exit 0, post-run list empty → non-active within
  visibility budget; outcome fenced — no second start until positive reconciliation.
- Fixture: run visible within budget → terminal success outcome (planner owns name).

### PID-reuse-safe liveness

- Fixture: PID reuse on local host → original holder recognized **dead** (reclaim
  proceeds) without trusting the unrelated process occupying the PID.

### Sweeper operability

- Fixture: reaper child registered, killed, supervisor restarts within one period.

### Audit

- Every `active` → non-active transition emits one structured audit row (claim key,
  prior/new state, terminal reason, decision source, run-store evidence summary).

### Recurrence (claim segment only)

- PR #407 class: from readiness, hold terminalization + reclaim + eligible starter
  start complete within ≤30s end-to-end when gh stalls — not ~9 min exclusive hold.

```positive-outcome
asserts: dead local-host holder with no in-flight run leaves active claim non-active within one reaper period without requiring same-head re-acquire
input: realistic
```

```positive-outcome
asserts: after reclaim and restart on the same (PR, head) key, exactly one in-flight review run exists for that key
input: realistic
```

```positive-outcome
asserts: claim held through simulated gh stall beyond hold budget is released and a second automated starter acquires and launches within the latency target
input: realistic
```

```positive-outcome
asserts: successful review run with temporarily invisible run record does not leave an active claim after the visibility budget elapses
input: realistic
```

## Upgrade-safety check

- No AO core / `vendor/**` edits.
- Claim schema backward-compatible or migrates in-flight `active` records safely.
- No new secrets. Supervisor registry change is additive.

## Verification

- Reaper: dead local holder, no run → non-active ≤30s.
- Non-local holder → fail-closed, operator-visible.
- Non-duplication: launch-pending + dead holder → no double run.
- Run-store: batch read, no per-claim gh; per-key fail-closed on corrupt evidence.
- Hold-budget + fenced post-run + run-recovery unbound + lost-update fixtures.
- PR #407 claim-hold timeline regression.

## Decisions (design analysis)

### Critical mechanics

- Three release paths today: holder completion, run-recovery
  `Release-ReviewStartClaimForTerminalizedRun` (needs `boundRunId` match else silent
  `superseded_claim`), on-demand acquire resolve (age < 10 min → `claimed`).
- `Complete-ReviewStartClaim` with `run_started` can return `run_not_visible` —
  claim stays `active`.
- Pending handoff retries re-fetch open PRs on lookup failure → **sibling #418**.

### Options (cost / risk / sufficiency)

| Option | Summary | Cost | Risk | Sufficient? |
|--------|---------|------|------|-------------|
| **A (chosen)** | Supervisor reaper + bounded hold + durable launch intent + fenced post-run terminalize + recovery unbound + shared predicates (#308 non-dup) | Low–medium | False reclaim if launch intent ignored | Yes, with non-dup AC |
| **B** | Full phased state machine (CAS/lease/fencing taxonomy, multi-host identity, quarantine machines) | High | Drift; spec churn | Over-built — **trimmed out** after 10-pass GPT over-convergence |
| **C** | External lease store | High | Ops | No |

### Full-class scenario matrix

Dimensions: **holder** {alive, dead-local}; **run** {none, in-flight,
terminal-covered, launch-pending}; **PR** {open, closed/merged}; **head** {same,
advanced}; **trigger** {reaper, acquire, run-recovery, hold-timeout}.

| # | Holder | Run | PR | Event | Outcome |
|---|--------|-----|-----|-------|---------|
| 1 | alive | none | open | hold budget exceeded | non-active + audit |
| 2 | dead-local | none | open | reaper | terminalize ≤30s |
| 3 | dead-local | none | closed | reaper | terminalize (legacy orphan) |
| 4 | dead-local | none | advanced head | reaper | clear H1 orphan |
| 5 | alive | in-flight | open | reaper | no-op |
| 6 | dead-local | in-flight | open | reaper | no-op until run terminal |
| 7 | dead-local | launch-pending | open | reaper | no release → no dup (#318) |
| 8 | alive | none | open | run ok, not visible | fenced non-active after budget |
| 9 | dead-local | none | open | second acquirer | acquire after reaper |
| 10 | dead-local | terminal-covered | open | reaper / recovery unbound | terminalize + WARN |

### Incident anchor (PR #407 claim segment)

- Seed claim 07:51:23; holder pid dead; `active` 27+ min; all surfaces `claim-skip`.
- Run 08:00:29 via holder path; reconcile later `head_covered`.
- 28/28 `active` claims in store (includes merged PRs #322, #334).

### GPT review summary (trimmed 2026-06-23)

10-pass GPT loop hit cap-10 without convergence; spec had drifted toward rejected
Option B. **Retained as WHAT invariants:** PID-reuse-safe liveness; durable
launch-pending intent; lost-update-safe reclaim/completion; fenced post-run
ambiguity with positive reconciliation; single recoverable sweeper. **Rejected /
cut:** foreign-host/WSL machinery, CAS/lease/TTL protocols, blocking_quarantine
state machine, triple fixed 15s budgets, per-pass decision tables. **Parked open
risk:** pre-acquire external snapshot stall can miss ≤30s without an active claim
to reap — not in scope; monitor in implementation.

## Related

- GitHub **#308**, **#381**, **#391**, **#318**, **#287**, **#163**, sibling **#418**.
