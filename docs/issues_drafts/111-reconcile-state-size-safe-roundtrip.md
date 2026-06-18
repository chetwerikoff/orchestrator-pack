# Reconcile-state round-trip must survive an over-buffer state and reconcile state must stay bounded without dropping safety fences

GitHub Issue: #339

## Prerequisite

- None blocking. Extends already-merged work (cite, do not re-implement):
  - `docs/issues_drafts/81-reconcile-state-roundtrip-and-supervisor-health.md`
    (GitHub #248) — made the reconcile-state round-trip **corruption-proof**
    against *shape* corruption (PSObject `Keys/Values/Count/...` keys), added
    self-heal-from-backup, established a **single-writer-per-child + atomic-write
    vs. restart-overlap** model, forbids **dropping action-tracking fences**, and
    already owns the **real-workability `-Action Status`** contract
    (working / degraded-with-reason / stalled / intentional-idle / stopped, with
    transient-recovery and bounded restart escalation). This draft re-uses all of
    that and adds only the **size/transport** cell #248 left open (no `size`,
    `64`, `pipe`, or growth-cap clause exists in #248). It must not weaken any
    #248 invariant.
  - `docs/issues_drafts/60-orchestrator-wake-supervisor.md` (GitHub #168) — brought
    up the wake supervisor whose `-Action Status` #248 then made workability-aware.
    Referenced for context only; this draft does **not** change the health surface.

## Goal

A reconcile child must keep working as its state grows. Two gaps remain after
#248: (1) the parent↔child state round-trip silently truncates a child output
that crosses an OS pipe/stdout buffer boundary, so a large-enough state wedges
the child — every tick throwing a JSON parse error while the process stays alive;
(2) reconcile state (and the append-only source ledgers it is derived from) can
grow without limit, so the state inevitably re-crosses that boundary over time.
This issue makes the round-trip survive an over-buffer state **up to an explicit
supported envelope, failing closed beyond it** (never silently truncating or
overwriting good state with a partial result), and makes reconcile state
**bounded without dropping any entry still needed for dedupe, retry, recovery, or
audit**.

```behavior-kind
action-producing
```

## Binding surface

This issue commits the repository to two invariants over the shared reconcile
machinery. It **re-uses** #248's corruption-proof read/self-heal, its
single-writer + atomic-write model, its no-drop-action-fences rule, and its
`-Action Status` health contract; it **adds** size/transport safety and a
safety-preserving state bound. It does not change, restate, or weaken the #248
health surface (that contract stays exactly as #248 defines it; this draft only
asserts it still holds — see "Fold-back" below).

1. **Size-safe state round-trip, with a fail-closed envelope.** The shared
   mechanical reconcile round-trip (parent serialises state → child filter
   transforms it → parent reads the result back) must transfer the child's output
   without truncating it at an OS pipe/stdout buffer limit, **up to an explicit
   declared maximum state size**. Within that envelope a state larger than the
   buffer round-trips intact and the tick parses it. Beyond the envelope, or on a
   partial / truncated / malformed / interrupted child result, the round-trip
   must **fail closed**: it must never accept a partial result as if complete, and
   the parent must **commit the new state only after the child output is complete
   and validated** — a partial or failed child result must leave the prior trusted
   state (and #248's backup) intact, surface the failure, and compose with #248's
   self-heal recovery. Temporary artifacts must be cleaned up on timeout, crash,
   or disk-full. The transport mechanism (temp file, length framing, chunked read)
   is the planner's choice; the binding requirements are *no size-dependent
   truncation within the envelope*, *fail-closed beyond it*, and *no partial result
   ever overwrites trusted state*.

2. **Bounded reconcile state that preserves safety fences.** Every reconcile child
   whose persisted/derived state — and every append-only source ledger it derives
   from — can grow with activity must enforce a hard upper bound so it cannot
   exceed a safe size over time. Bounding must **not** drop any entry still
   operationally required: an entry that still backs **deduplication, an unfinished
   retry/backoff budget, an unresolved delivery, or a required audit fence** must
   be retained even if old or nominally terminal (this is #248's no-drop-fences
   rule applied to retention). If the ceiling cannot be met without removing a
   still-required entry, the child must **fail closed** — surface a degraded/
   over-capacity signal — rather than silently evict it. The bound must cover the
   **unbounded growers**, not only an already-capped list. Retention/eviction must
   **compose with #248's single-writer + atomic-write-vs-restart model**: an
   eviction pass must not lose an entry written concurrently by a restarted child
   or a concurrent source-ledger writer (no lost update). The eviction policy
   (terminality + age, ring, etc.) is the planner's choice; the binding
   requirements are a *stable ceiling*, *no required entry dropped*, *fail-closed
   when unmeetable*, and *no lost concurrent update*.

   **Ceiling must fit the transport envelope (cross-layer).** The storage ceiling
   here must be chosen with **headroom below invariant 1's transport envelope** for
   the maximum serialised child output plus admission/transform overhead, so a
   state that satisfies its storage ceiling can **never** produce a child output
   that exceeds the envelope. Otherwise the wedge simply reappears at the envelope
   instead of the old buffer boundary. The two limits are a related pair, not
   independent numbers; the relationship (not the exact bytes) is binding.

   **Crash-consistent compaction (cross-artifact ordering).** Pruning a source
   ledger must be crash-consistent with recovery: source-ledger evidence must not
   be evicted until the derived state **and** #248's last-known-good backup that
   incorporate it are durable. A crash followed by #248 self-heal must never
   restore a backup whose supporting source-ledger evidence was already pruned —
   which would repeat an already-performed external action or lose retry/audit
   history. The ordering guarantee is binding; the mechanism is the planner's.

   **Eviction-safety predicate (explicit horizon).** "Operationally required" must
   be an **explicit, declared, tested predicate per bounded class** — the replay /
   retry / recovery / audit horizon after which an entry is provably no longer
   needed — not an implementation guess. An entry must not be evictable while a
   delayed duplicate, an unfinished retry, a restorable backup, or an upstream
   replay can still depend on it, including **after compaction and after restart**.

   **Admission at the ceiling.** When the ledger/state is already at the ceiling
   and every retained entry is still required (nothing is evictable), a **new
   event** must not be allowed to either exceed the ceiling or be silently dropped
   after its external action occurred. Admission must be **write-ahead and
   fail-closed**: no new irreversible external action may be treated as
   accepted/completed unless its required durable fence is first recorded within
   the ceiling; if that fence cannot be recorded, the action must be **refused /
   back-pressured** before it happens (a visible over-capacity signal), and must
   become possible again once capacity frees. Ingress must never leave an executed
   action without its dedupe/retry/recovery fence.

   **Pre-action fence lifecycle (no binary done-flag).** Because the fence is
   written *before* the irreversible action, it must carry an explicit lifecycle —
   at least **pending** (fence durable, action not yet confirmed), **completed**
   (action confirmed), and **failed/uncertain** — not a binary "handled" flag. A
   crash *after* the fence is durable but *before* the action, or *after* the
   action but *before* completion is recorded, must resolve deterministically: an
   action that never occurred must **not** be suppressed forever (a `pending` fence
   is reconciled and stays retryable, never read as `completed`), and an action
   whose outcome is uncertain must be resolved by the existing recovery path
   without an unsafe blind re-execution. The lifecycle must preserve both dedupe
   and retry semantics across these crash boundaries.

   **Upgrade / rollback compatibility.** Introducing the fence lifecycle changes
   the persisted record shape, and existing state survives the `ao stop` / `ao
   start` adoption. Interpretation of **pre-change** persisted records must be
   backward-safe, and newly written records must be rollback-safe against
   immediately-prior code (version skew): a legacy/terminal record must never be
   misread as `pending` (which would repeat an irreversible action) nor a
   `pending`/unfinished record as `completed` (which would suppress unfinished
   work). The binding requirement is the **safety outcome under version skew**;
   the migration/schema-versioning mechanics are the planner's choice.

   **Admission reserves the whole lifecycle, not just `pending`.** Because the
   later lifecycle records (`completed`, `failed/uncertain`) may be **larger** than
   the initial `pending` fence, admission must guarantee bounded capacity for
   **every mandatory post-admission transition**, not only the pending write. An
   action must not be admitted/executed when its `pending` fence fits but its
   eventual terminal record could not be persisted without exceeding the ceiling
   or evicting still-required data — that would leave the outcome permanently
   unresolved and block recovery. Admission reserves worst-case terminal capacity
   up front; the reservation accounting is the planner's choice.

   **Cold-start convergence from already-oversized state.** On first run after this
   change, the existing state/ledger may **already exceed** the new ceiling — this
   is the observed incident's exact condition (a state already past the buffer when
   the fix lands). The child must **converge**: compact the safely-evictable
   entries, drop below the ceiling, and resume processing automatically — not
   fail-closed forever before compaction runs. Only genuinely **non-evictable**
   oversized state (all entries still required) may remain fail-closed, and then as
   a visible degraded signal. This is what makes the `ao stop` / `ao start`-only
   adoption real: the fix self-heals the pre-existing bloat instead of requiring a
   manual trim.

- **Operator adoption:** none beyond the standard `ao stop` / `ao start` already
  required to pick up changed reconcile scripts; this draft adds no new operator
  env var, YAML surface, or go-live process.

## Files in scope

- The shared mechanical reconcile round-trip helper used by the reconcile
  children (`scripts/lib/**`).
- The reconcile child(ren) whose state can grow unbounded, and the append-only
  source ledger writer(s) they derive from, for the bounding invariant
  (`scripts/**`).
- Test fixtures exercising an over-buffer state, a partial/truncated child
  result, retention-preserves-fences, and concurrent-writer-vs-eviction
  (`scripts/fixtures/**`) `(new)`.

## Files out of scope

- `packages/core/**`, `vendor/**`, `.ao/**` (AO internals).
- `agent-orchestrator.yaml` / `.example` (no new wiring required).
- The wake-supervisor health / `-Action Status` surface owned by #248 — **not
  changed here**; only asserted as a non-regression.
- The #248 shape-corruption read / self-heal path — preserved unchanged, not
  rewritten.

```denylist
vendor/**
packages/core/**
.ao/**
```

## Decisions (design analysis)

**Prior art.** #248 (draft 81) hardened the *same* round-trip against shape
corruption, added self-heal, the single-writer/atomic-write model, the
no-drop-fences rule, and the real-workability `-Action Status`. It explicitly did
**not** cover size/transport: its self-heal keys off whether the on-disk file
parses, and here the file is valid — the truncation happens in the parent's
capture of the child's output once it crosses the OS buffer boundary, a path
#248 never inspects. So the size class is a sibling cell of the same machinery,
the way #248 closed the shape cell.

**Health stays in #248 (de-scoped after adversarial review).** The observed
incident also failed to *surface* the wedge — the child was alive, every tick
threw for hours, nothing flagged it. That exact mode is already #248's contract
(its motivation cites "per-tick error caught and only logged, 'tick complete'
written even after error, Status reads pid liveness only → 100%-failing child
reports running"; its acceptance requires `degraded`-with-reason on sustained
tick errors). Re-specifying it here would duplicate and risk weakening the
shipped contract, so it is **out of scope**. The residual — that #248's shipped
health signal did not fire for an exception thrown *inside the round-trip* — is a
**fold-back to #248** (verify the implementation classifies a round-trip throw as
a failing tick), tracked under #248, not re-specified weakly here.

**Class, not case.** The reproduced case is one reconcile child wedged for hours
(every tick threw "Conversion from JSON failed … position 65536" while alive;
deleting the state file and its backup did not help — the state was recomputed
each tick from an append-only dispatch ledger that had no prune; cleared live by
trimming that ledger). The **class** is *every reconcile child whose derived/
persisted state can cross the buffer limit* — that is the coverage axis,
mirroring #248's "whole matrix" stance. Full decision/FSM/ordering/concurrency
enumeration (gate element 5) is not the root here — the root is mechanical
(serialisation size + unbounded growth) — but the concurrency surface that the
**added eviction** introduces is handled explicitly via the compose-with-#248
requirement in invariant 2 (raised by adversarial review).

**Options (cost / risk / sufficiency).**
- **A — bound the state only.** Cheap, but insufficient alone: it slows growth
  without removing the ceiling — any other reconcile child whose state grows hits
  the same wall. A band-aid, and on its own it tempts unsafe eviction.
- **B — make the round-trip size-safe (fail-closed envelope).** ⭐ **Chosen —
  cheapest sufficient executor with acceptable risk.** It is the class fix: every
  reconcile child becomes immune to the wedge within the supported envelope and
  fails closed beyond it. Medium cost (one shared helper), risk contained by
  tests + Codex review; blast radius is shared, so an over-buffer golden fixture
  and a partial-result fixture are required.
- **C — B plus A together.** Adopted: B is the load-bearing fix; A is folded in as
  invariant 2 *with* the adversarial-review safety constraints (no dropped fence,
  fail-closed, compose-with-#248), not as a bare size cap. C stops short of
  prescribing transport/eviction internals (planner's choice).

Rejected "build fresh / ignore #248" — the survey proved the surface is *not*
empty; this extends #248's machinery and must not regress it.

### Adversarial review log (pass 1, verdict needs-attention → revised)

- *Eviction may drop live dedupe/retry/recovery fences* — **accepted**: invariant
  2 now forbids dropping any required fence and fails closed when the ceiling is
  unmeetable; acceptance adds a semantic-preservation test.
- *Concurrency matrix around read-modify-write waived* — **partially accepted**:
  did not adopt a new CAS/lock prescription (#248 already owns single-writer +
  atomic-write-vs-restart); invariant 2 now requires eviction to *compose* with
  that model and adds a concurrent-writer-vs-eviction fixture.
- *Health re-specifies #248 more weakly* — **accepted**: health removed from
  scope; only a #248 non-regression check remains; residual folded back to #248.
- *"Any size" lacks a resource / partial-transport contract* — **accepted**:
  invariant 1 now declares an explicit envelope, fails closed beyond it, commits
  only after a complete validated output, never overwrites trusted state with a
  partial result, cleans up temp artifacts, and composes with #248 recovery.

### Adversarial review log (pass 2, verdict needs-attention → revised)

- *Over-capacity ingress can break the ceiling or lose an unfenced action* —
  **accepted**: invariant 2 now adds a write-ahead, fail-closed **admission**
  clause (no irreversible action accepted without recording its durable fence;
  refuse/back-pressure before the action when the fence cannot fit; recover when
  capacity frees), with a matching acceptance criterion and admission-at-ceiling
  fixture. The earlier four findings were carried as settled and not re-raised.

### Adversarial review log (pass 3, verdict needs-attention → revised)

- *Ledger compaction not crash-consistent with recoverable state* — **accepted**:
  invariant 2 now requires crash-consistent compaction ordering (source-ledger
  evidence not evicted until the derived state + #248 backup incorporating it are
  durable) + a crash-boundary fixture.
- *No defined horizon for when a fence becomes evictable* — **accepted**:
  invariant 2 now requires an explicit, declared, tested **eviction-safety
  predicate** per bounded class (replay/retry/recovery/audit horizon, including
  delayed replay after compaction/restart).
- *Storage ceiling not tied to the transport envelope* — **accepted**: invariant 2
  now binds the ceiling to leave headroom below invariant 1's envelope (the wedge
  must not reappear at the envelope) + a boundary/encoding-expansion fixture.
- The five earlier findings were carried as settled and not re-raised.

### Adversarial review log (pass 4, verdict needs-attention → revised)

- *Pre-action fence can falsely mark an unexecuted action as handled (crash window
  between fence and action)* — **accepted**: the admission fence now carries an
  explicit **pending / completed / failed-uncertain** lifecycle (no binary
  done-flag), with deterministic crash resolution and crash fixtures for
  after-fence-before-action and after-action-before-completion. The eight earlier
  findings were carried as settled and not re-raised.

### Adversarial review log (pass 5, verdict needs-attention → revised)

- *Persisted fences have undefined lifecycle semantics after upgrade/rollback* —
  **accepted**: invariant 2 now requires backward- and rollback-safe
  interpretation of persisted fence records under version skew (no legacy record
  misread as `pending`, no unfinished record as `completed`), with pre-change-state
  and version-skew fixtures; migration mechanics left to the planner. The nine
  earlier findings were carried as settled and not re-raised.

### Adversarial review log (pass 6, verdict needs-attention → revised)

- *A `pending` fence can fit while its completion record cannot* — **accepted**:
  admission now reserves bounded capacity for every mandatory lifecycle transition
  (worst-case terminal record), not just the `pending` write, with a boundary
  fixture where `pending` fits but a later state expands. The ten earlier findings
  were carried as settled and not re-raised.

### Adversarial review log (pass 7, verdict needs-attention → revised)

- *No recovery contract for pre-existing over-ceiling state on upgrade* —
  **accepted** (and incident-critical): invariant 2 now requires cold-start
  **convergence** — on first run against an already-oversized-but-compactable
  state/ledger the child compacts and resumes automatically (self-heals the bloat
  under stop/start-only adoption); only oversized *and* all-required state stays
  fail-closed. Added an upgrade-seeded fixture. The eleven earlier findings were
  carried as settled and not re-raised.

## Acceptance criteria

- A reconcile state whose serialised form **exceeds the OS pipe/stdout buffer
  limit but is within the declared envelope** round-trips through the shared
  helper intact: the parent reads back the child's complete output and parses it
  without error (no truncation at the buffer boundary).
- With such an over-buffer state present, the affected reconcile child's tick
  **completes and produces its normal outcome** (e.g. a submit/transition)
  instead of throwing — proven on a fixture sized past the boundary.
- A **partial / truncated / malformed / interrupted** child result is **rejected,
  not committed**: the prior trusted state and #248's backup are left intact, the
  failure is surfaced, and the next successful tick recovers — i.e. a partial
  result never overwrites good state. Temp artifacts are cleaned up after
  timeout, crash, **and disk-full**.
- A state **beyond the declared envelope** is handled **fail-closed** (a visible
  over-capacity/degraded signal), never as a silent truncation that corrupts the
  round-trip.
- Every reconcile child with growth-capable state (and its source ledger) has a
  demonstrable **upper bound**: driving it well past the previous overflow volume
  keeps persisted state under the ceiling — and the **unbounded growers** are
  bounded, not only an already-capped list.
- Bounding **preserves safety fences**: an entry still backing dedupe, an
  unfinished retry budget, an unresolved delivery, or a required audit fence is
  **retained** even when old/terminal; if the ceiling cannot be met without
  dropping such an entry, the child **fails closed** rather than evicting it.
  Proven by a semantic test (dedupe/retry/recovery outcome unchanged after a
  bounding pass), not only a size check.
- Eviction **composes with #248's single-writer + atomic-write-vs-restart model**:
  a concurrent-writer-vs-eviction fixture proves no entry written by a restarted
  child or concurrent source-ledger writer is lost.
- **Admission at the ceiling is write-ahead and fail-closed**: with the ledger
  full of all-required (non-evictable) entries, a new event is **either** recorded
  with its durable fence within the ceiling **or** refused/back-pressured before
  its external action — never appended past the ceiling, and never executed
  without its fence. Recovery (the event becomes admissible once capacity frees)
  is demonstrated.
- #248 invariants still hold (no regression): a shape-corrupted or unparseable
  state file is still recovered via self-heal, and the `-Action Status`
  workability classification is unchanged.

```positive-outcome
asserts: given a reconcile state serialised larger than the OS pipe/stdout buffer limit but within the declared envelope, the parent round-trip returns the child's complete output, the tick parses it and emits its normal action outcome (e.g. a submit/transition) rather than a JSON-conversion failure
input: external-tool-output
provenance: capture-backed
```

## Upgrade-safety check

- No edits to `packages/core/**`, `vendor/**`, or `.ao/**`.
- No new repository secrets; no new operator env var or YAML schema.
- No AO-version-specific behaviour assumed; the round-trip and reconcile scripts
  are repo-owned.
- #248 invariants (corruption-proof read, self-heal, single-writer/atomic write,
  no-drop-fences, `-Action Status` workability) preserved, not rewritten.

## Verification

- A fixture state whose serialised size is **past the OS buffer boundary, within
  the envelope** is fed through the shared round-trip helper; the test asserts the
  parsed result equals the child's intended output (byte-faithful, no truncation).
- A reconcile-child unit/fixture test runs one tick over that over-buffer state
  and asserts the tick **succeeds with its normal outcome**, not a conversion
  error.
- A partial/truncated/malformed/interrupted child-output fixture asserts the
  parent **does not commit** it: prior state + #248 backup intact, failure
  surfaced, recovery on the next tick, temp artifacts removed. The cleanup
  assertion covers all three required failure modes — **timeout, crash, and
  disk-full** (e.g. a simulated write failure mid-transfer) — not just timeout/crash.
- An over-envelope fixture asserts a **fail-closed** visible signal (not silent
  truncation).
- A growth test drives the child and its source ledger past the previous overflow
  volume and asserts persisted state stays under the ceiling.
- A retention test asserts a dedupe/retry/unresolved/audit-fence entry survives a
  bounding pass (semantic outcome unchanged), and that an unmeetable ceiling
  produces a fail-closed signal rather than dropping a required entry.
- A concurrent-writer-vs-eviction fixture asserts no concurrently-written entry is
  lost by an eviction pass.
- An **admission-at-ceiling** fixture (ledger full of all-required entries, new
  event arrives) asserts the event is either fenced within the ceiling or
  refused/back-pressured before its external action — never appended past the
  ceiling, never executed without a fence — and that it becomes admissible again
  once capacity frees.
- **Pre-action fence lifecycle**: a crash *after fence durable, before action* and
  a crash *after action, before completion recorded* each resolve
  deterministically — a never-executed action is not suppressed forever (its
  `pending` fence stays retryable), an uncertain outcome is resolved without an
  unsafe blind re-execution, and dedupe + retry semantics survive both boundaries.
- **Fence upgrade/rollback safety**: a fixture loading representative pre-change
  persisted state, and a version-skew/rollback case, prove no legacy/terminal
  record is misread as `pending` (no repeated action) and no unfinished record as
  `completed` (no suppressed work).
- **Lifecycle capacity reservation**: a boundary fixture where the `pending` fence
  fits but a later (`completed` / `failed-uncertain`) record is larger proves the
  action is admitted only when its worst-case terminal record is also guaranteed
  to fit — no outcome is left permanently unresolved for lack of room.
- **Cold-start convergence**: an upgrade fixture seeded with pre-change state/ledger
  **already over the ceiling but safely compactable** (the incident condition)
  converges below the ceiling and resumes processing automatically — proving the
  fix self-heals existing bloat under stop/start-only adoption. State that is
  oversized *and* all-required remains fail-closed (visible degraded), not silently
  forced under.
- **Ceiling-fits-envelope**: a boundary-sized record (and an encoding-expansion /
  transform-expansion case) proves a state within its storage ceiling still
  produces a child output **within** the transport envelope — the wedge does not
  reappear at the envelope.
- **Crash-consistent compaction**: a crash-boundary fixture (crash interleaved
  with a prune) followed by #248 self-heal proves recovery retains dedupe / retry /
  audit semantics — no external action is repeated and no required evidence is
  lost because the ledger was pruned ahead of the durable state+backup.
- **Eviction-safety predicate**: each bounded class's declared predicate is tested
  against its real replay/retry/recovery/audit horizon, including a **delayed
  replay after compaction and after restart** — an entry is evicted only once
  provably no longer required.
- A #248-regression fixture (shape-corrupted + unparseable state file) still
  recovers via self-heal, and `-Action Status` workability output is unchanged —
  proving the size work did not break the shape or health paths.
