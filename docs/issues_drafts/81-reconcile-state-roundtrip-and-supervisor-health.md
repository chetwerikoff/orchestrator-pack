# Reconcile-state round-trip must be corruption-proof and the wake supervisor must report real health

GitHub Issue: #248

## Prerequisite

- None blocking. Related (not blocking):
  - `docs/issues_drafts/60-orchestrator-wake-supervisor.md` (GitHub #168) — brings up
    the supervisor and the liveness-only `-Action Status`; this issue extends that
    Status and the supervisor loop to report **real workability**, not just liveness.
  - `docs/issues_drafts/76-golden-sample-fixtures-field-shape-guard.md` (GitHub #223) —
    sibling field-shape concern; this issue adds a **state-file round-trip** invariant
    (serialize→read→serialize is a fixed point), complementary to fixture field-shape.

## Goal

Make every orchestrator side-process state file (`/tmp/orchestrator-*-state.json`)
impossible to self-corrupt and self-healing if already corrupt, across the **whole
matrix** of reconcile children — not just the one process observed crashing. In the
same issue, make `-Action Status` and the supervisor's own monitoring report whether
each child is **actually working**, so a child failing every tick is never shown as
healthy "running", and the supervisor surfaces (and where appropriate recovers from)
a non-working child.

```behavior-kind
action-producing
```

## Background (confirmed root cause)

A state-map value is a PowerShell `[hashtable]` when it comes from the in-memory default
state, but a `PSCustomObject` when it comes from `ConvertFrom-Json`. Enumerating such a
value via `.PSObject.Properties` over the `[hashtable]` case yields CLR reflection members
(`Keys/Values/Count/SyncRoot/IsFixedSize/IsReadOnly/IsSynchronized`) instead of dictionary
entries. Those 7 names get written into the map and serialized to the state file; on the
next read they appear as real note-properties and are re-written — the round-trip is not a
fixed point. Proven live: a pristine start (no state file) writes the 7-key corruption on
tick 1 and crashes on tick 2, so deleting the file does **not** fix it. The corruption is
fatal only where a garbage value reaches a mandatory non-empty parameter (one child crashes
every tick); other children carry it silently or self-heal by luck. Separately, the per-tick
error is caught and only logged, the "tick complete" progress phase is written even after a
caught error, and Status reads pid liveness only — so a 100%-failing child reports "running".

The full design-analysis matrix (5 elements incl. full-class enumeration) was authored to a
temp annex during drafting (not committed, per the design-gate long-table convention); the
binding equivalence classes are enumerated directly in **Acceptance criteria** below — those
ACs, not any external doc, are the contract.

## Binding surface

> **Two distinct coverage scopes.** The **state-roundtrip corruption** concern applies to
> **PowerShell-managed** state (the bug is a PowerShell `[hashtable]`/`PSObject` reflection
> artifact). The **health/workability** concern applies to **all** supervised children in the
> registry. These are deliberately different sets — see Coverage.

- **State round-trip is corruption-proof and self-healing.** For every PowerShell-managed
  stateful child, reading then writing its state must preserve the same real entries (semantic
  stability over the parsed map — exact byte/key ordering is the planner's choice) and must
  never emit the CLR-reflection keys above, regardless of whether the prior state was missing,
  clean, already-corrupt, partial (a map field missing/null), or unparseable (truncated /
  malformed JSON). An already-corrupt or unparseable on-disk file must converge to a clean
  file on the next successful tick rather than crash the read. The guarantee must hold for
  **every** state path — preferably by consolidating onto a single shared chokepoint so
  children inherit it, but any **bespoke** state read/write path that does not use the shared
  helper (e.g. `review-finding-delivery-confirm`'s own `Get-DeliveryState`/`Set-DeliveryState`)
  must either adopt the shared point or independently satisfy the same invariants. No per-child
  copy may drift, and no bespoke path may escape the guarantee. **Exempt:** the wake dedup state
  (`/tmp/orchestrator-wake-dedup.json`) is owned/read/written entirely by the JS filter
  `docs/orchestrator-wake-filter.mjs`; JS JSON round-trip is not subject to this PowerShell
  class, so it is out of the corruption matrix (but stays in the health scope below).
- **State writes are durable, and recovery never silently drops action-tracking fences.** A
  write that is interrupted (process killed mid-write, or a supervisor restart overlapping an
  in-flight write) must not leave a state file that crashes the next read. Recovery must
  distinguish two cases:
  - *Recoverable corruption* (reflection-key pollution mixed with real entries): strip the
    bogus keys but **keep** the real entries — self-heal must not lose real data.
  - *Total parse loss* (truncated/malformed, nothing recoverable): for **action-tracking**
    state (dedup/idempotency/audit fences — e.g. `sent`, `deliveries`/`audit`, `runs`,
    `nudged`/`pendingJournal`), the child must NOT silently reset to empty and then act, since
    that could re-emit an already-delivered side effect or lose retry-bounding/audit evidence.
    It must prefer last-known-good (so a good prior file survives an interrupted write),
    preserve/quarantine the unparseable file rather than overwrite it with empty, and when the
    fences cannot be trusted it must **fail closed** (take no new side effect for the affected
    entries) and escalate visibly (operator-facing) rather than blast duplicates.
  The planner picks the mechanism (e.g. atomic replace + backup); the invariants are no
  unrecoverable-on-read file, no silent loss of real entries, and no duplicate/forgotten side
  effect on recovery. (A single child runs one sequential tick loop, so two ticks of the *same*
  child never overlap; the only overlap to defend is restart-vs-write.)
- **No tick may crash because of state shape.** A garbage or absent identifier must never be
  passed to a mandatory non-empty parameter; the child either skips that entry or fails the
  entry closed with a logged reason, but the tick loop survives.
- **Status reports real workability.** `-Action Status` must distinguish at least: working
  (alive and ticking without error), degraded (alive but erroring on its recent ticks, with
  the reason), stalled (alive but no fresh tick progress), and stopped (no live process). A
  child failing every tick must NOT render as plain "running". It must also distinguish an
  **intentional non-failure idle state** — e.g. a session-dependent child deliberately not
  running (or parked) because there is no live orchestrator session — from a fault: such a
  child reads as waiting/suspended, NOT degraded/stalled/stopped-as-fault, and must not trigger
  recovery churn. (This is the normal idle posture when no worker session exists.) Classification
  must be robust
  to real tick patterns, not just the all-error/all-ok extremes: a one-off transient error
  followed by recovery must return to working (no sticky-degraded noise), a child erroring on
  a sustained run of recent ticks must read degraded, and a freshly (re)started child that has
  not yet ticked must not inherit a stale prior verdict. The exact thresholds/windows are the
  planner's choice; the required behavior is the classification under these patterns.
- **The supervisor monitors health, not just liveness — for every supervised child.** The
  health/workability classification covers **all** registry-supervised children (listener,
  heartbeat, the reconcile children, review-trigger-reeval), not only the PowerShell state-file
  set. The supervisor's own loop must
  detect a degraded or stalled child (sustained tick errors or stale progress) and surface the
  problem (log and/or its existing notification path), identifying the child and the reason —
  silence while a child is non-working is not acceptable. If the supervisor also restarts a
  child to recover it, recovery must be **bounded**: a child that stays non-working across
  repeated recovery attempts must end in a visible degraded/terminal report, never an infinite
  silent restart-loop (which would mask a persistent state bug — and this corruption is
  restart-proof, so an unbounded restart would thrash). Restart eligibility, backoff, and
  rate-limit values are the planner's choice; the invariant is detect-and-surface, and
  bounded-recovery-then-escalate.
- **Health signal distinguishes outcome.** The per-child progress/health signal must let an
  observer tell a successful tick from a tick that errored, and recover the last-error reason
  and enough recency information to support the classification above (today the `tick_complete`
  phase is written even after a caught error, so success and failure are indistinguishable).
  The signal's exact field shape is the planner's choice.

- **Coverage is auditable, derived from a discovery basis — not a hand-list.** The set of
  in-scope state files must be derived from observable sources that capture **every** side
  process with a JSON state file — **both** the shared-helper callers **and** bespoke
  read/write paths (`review-finding-delivery-confirm`'s `Get/Set-DeliveryState` is the known
  bespoke case). The side-process registry `scripts/orchestrator-side-process-registry.json`
  enumerates the children; the helper-caller set alone is **insufficient** because it misses
  bespoke paths. The coverage check must fail if any discovered state file / map field lacks
  the round-trip / genesis / corrupt / partial fixtures — so a future child, a newly added map
  field, or a bespoke state path cannot silently reintroduce the bug. The discovery mechanism
  is the planner's choice; the invariant is that **no** PowerShell-managed side-process state
  file escapes the matrix. The JS-owned wake dedup state is the one documented exemption (see
  the corruption bullet above). **Health** coverage is the broader set — all registry children —
  and is enforced separately (criteria 7–8, 10).

This issue commits the repo to those invariants. It does **not** prescribe the helper names,
the serialization mechanism (`-AsHashtable`, type-guarded iteration, schema, etc.), the
health-field shape, the thresholds/windows, or the restart/backoff policy — the planner owns
all of that.

## Files in scope

- `scripts/**` — the shared reconcile/state helper(s), and **every** side process that
  persists a JSON state file (whether via the shared helper or a bespoke path). The current
  inventory is: ci-green-wake (`heads`/`nudged`/`pendingJournal`), review-send (`sent`),
  review-trigger (`degradedCi`), worker-message-submit (`deliveries`/`audit`),
  **review-trigger-reeval** (`watchEntries`, via `lib/Record-ReviewTriggerReevalWatch.ps1`),
  and **review-finding-delivery-confirm** (`runs`) — which uses a **bespoke** state path
  (`Get/Set-DeliveryState`), not the shared helper, and is in scope all the same. This list is
  the inventory *as of authoring* — the binding source of truth is the discovery basis in
  **Coverage** below, not this list. Also the wake supervisor.
- `scripts/lib/**` — the shared state-file read/write/iteration helper(s).
- Tests and fixtures under `scripts/**` (round-trip regression fixtures; corrupt-state fixtures).

## Files out of scope

- `packages/core/**`, `vendor/**`, `.ao/**`.
- `agent-orchestrator.yaml` / `*.yaml.example` (no wiring change required by this issue).
- Plugin code under `plugins/**`.
- The node filter CLIs’ decision logic (`docs/*-reconcile.mjs`) except where they already
  receive state — the planner may leave plan/decision logic untouched.

```denylist
vendor/**
packages/core/**
.ao/**
```

```allowed-roots
scripts/**
```

## Acceptance criteria

Each class below must be a fixture/test; closed sibling issues must show no regression.

1. **Round-trip fixed point (all children × all state-map fields).** For each stateful child
   and each of its state-map fields, a write→read→write cycle of a representative populated
   map preserves the same real entries (semantic equality over the parsed map) with **none**
   of `Keys/Values/Count/SyncRoot/IsFixedSize/IsReadOnly/IsSynchronized` as keys.
2. **Empty/default genesis is clean.** Starting a child with **no** state file produces, after
   one tick, a state file whose maps are clean (empty `{}` or real entries) — never the 7-key
   structure. (Covers the proven tick-1 genesis.)
3. **Self-heal from corrupt on-disk state.** Given a state file pre-seeded with the real
   7-key corrupt blob (capture-backed), the next successful tick rewrites it clean and the
   tick does **not** crash.
4. **Partial/missing-field input does not corrupt.** Given a state file missing or nulling a
   map field, the read path does not inject a value that re-corrupts on write.
5. **Unparseable state recovers without crash AND without unsafe reset.** Given a
   truncated/malformed JSON state file, the read does not crash. For pure tracking with no side
   effect, recovery to clean default is fine. For **action-tracking** state (dedup/idempotency/
   audit fences), recovery must not silently reset to empty and then act: it preserves
   last-known-good where possible, quarantines the unparseable file rather than overwriting it
   empty, and when fences are untrusted the affected entries fail closed (no new side effect)
   with operator-visible escalation. A write interrupted mid-flight (or overlapped by a restart)
   does not leave a file that crashes the next read and does not lose the prior good state.
6. **No mandatory-parameter crash.** Given any of the corrupt/partial/unparseable inputs
   above, no tick passes an empty/garbage identifier to a mandatory non-empty parameter; the
   tick completes (entries skipped or failed-closed with a logged reason).
7. **Status classification (incl. real tick patterns + intentional idle).** `-Action Status`
   reports a child as: degraded **with a reason** when it errors on a sustained run of recent
   ticks (not plain "running"); working when ticking without error; stalled when alive with no
   fresh progress; stopped when no live process AND it should be running; and a distinct
   non-failure waiting/suspended state when a session-dependent child is intentionally not
   running because there is no live orchestrator session. Additionally: a one-off transient
   error followed by a healthy tick returns to working (not sticky-degraded), and a
   just-(re)started child that has not yet ticked does not inherit a stale prior verdict. A
   child in the intentional waiting/suspended state is not reported as degraded and does not
   trigger recovery.
8. **Supervisor surfaces a non-working child, recovery is bounded.** The supervisor monitoring
   path detects a sustained-erroring or stalled child and emits an observable signal (log
   and/or notification path) naming the child and the reason. If it restarts the child to
   recover, a child that stays non-working across repeated attempts ends in a visible
   degraded/terminal report — no infinite silent restart-loop.
9. **Coverage is enforced from a discovery basis (helper + bespoke paths).** A coverage check
   derives the in-scope **PowerShell-managed** state files from the side-process registry and the
   union of shared-helper callers **and** bespoke PowerShell JSON state read/write paths, and
   fails if any discovered state file / map field lacks the criteria-1–6 fixtures — including
   `review-trigger-reeval` (`watchEntries`) and the bespoke `review-finding-delivery-confirm`
   (`runs`). The JS-owned wake dedup state is explicitly exempt (documented reason). A new
   child/field/bespoke PowerShell path cannot ship without the round-trip guarantee. (Health
   coverage — criteria 7,8,10 — independently spans all registry children.)
10. **Health signal outcome.** The per-child health/progress signal lets an observer
    distinguish a tick that succeeded from a tick that errored, and exposes the last-error
    reason used by the classification in criterion 7.

State self-heal (round-trip fix) — a clean heal produces no degraded signal:

```positive-outcome
asserts: a state file pre-seeded with the real 7-key corrupt blob is rewritten to a clean map by the next tick with no tick error logged, and -Action Status reads the child as working (clean self-heal, not degraded)
input: external-tool-output
provenance: capture-backed
```

Health classification (workability fix) — a real sustained failure is reported and recovers:

```positive-outcome
asserts: a child driven into a sustained tick-error condition is reported by -Action Status as degraded with the error reason, and returns to working after a subsequent healthy tick
input: realistic
```

## Upgrade-safety check

- No edits to `packages/core/**`, `vendor/**`, `.ao/**`.
- No AO YAML schema changes; no new `reactions`/`orchestratorRules` keys required.
- No new repo secrets.
- State files remain machine-local under the OS temp path; no new tracked state.
- Backward-compatible read: existing clean state files keep working unchanged; only corrupt
  shapes are normalized.

## Verification

- Run the new round-trip and self-heal fixtures: `pwsh -NoProfile -File scripts/<test runner>`
  (planner’s runner) plus the existing `*.test.ts` suites for the affected children stay green.
- Demonstrate criterion 2 by launching a child with `-Once` against an absent `-StateFile` and
  inspecting the written file is clean.
- Demonstrate criterion 3 by seeding the corrupt blob, ticking once, and asserting the file is
  clean and no `tick error` was logged.
- Demonstrate criteria 6–7 by seeding a child into a permanent tick-error condition and
  asserting `-Action Status` output classifies it as degraded with reason and the supervisor
  log/notification names it.
- Map each acceptance criterion to at least one automated assertion.

## Adversarial review ledger

Cold-restart Codex challenge passes (evaluate-don't-obey; planner freedom preserved).

**Pass 1 (verdict: needs-attention):**
- *Partial writes / malformed JSON / concurrency (P1)* — **accepted, scoped.** Added
  unparseable-JSON recovery + interrupted/overlapping-write durability (AC5, binding bullet).
  Rejected the "concurrent ticks" framing: a child runs one sequential loop, so only
  restart-vs-write overlap is real — spec says so rather than inventing intra-child concurrency.
- *Health can lie under real tick patterns (P1)* — **accepted, minimally.** Added transient-recovery,
  sustained-error, and just-restarted-no-stale-verdict behavior to Status (AC7) and the binding
  surface; kept thresholds/windows planner-owned (no field schema imposed).
- *Supervisor response too vague (P2)* — **partially accepted.** Added bounded-recovery /
  no-silent-restart-loop / terminal-visible-degraded invariant (AC8); left restart/backoff
  numbers to the planner (declining to mandate a full restart-policy matrix as over-spec).
- *Coverage not auditable (P2)* — **accepted.** Added an enforced discovery/inventory check
  (AC9 + binding bullet) so a new child/field cannot ship without the round-trip fixtures.
- *Byte-stable over-specifies (P2)* — **accepted.** Replaced byte-stability with semantic
  stability over the parsed map (AC1) — removed the serializer-ordering lock.

**Pass 2 (verdict: needs-attention):**
- *Stateful child `review-trigger-reeval` omitted from the inventory (P2)* — **accepted.**
  Verified it persists `watchEntries` via the same `Get/Set-MechanicalJsonStateFile` helper
  with the same `@{}`-in-default pattern (currently clean, same class). Added it to Files in
  scope and tied the coverage guarantee (AC9 + binding) to a discovery basis (side-process
  registry / helper callers) so the inventory cannot silently miss a child again.

**Pass 3 (verdict: needs-attention):**
- *Bespoke state path can escape the helper-caller discovery basis (P1)* — **accepted.**
  Verified `review-finding-delivery-confirm` uses its own `Get/Set-DeliveryState`
  (`ConvertFrom-Json`/`Set-Content`), not the shared helper, yet carries the same
  `.PSObject.Properties` pattern. Broadened the discovery basis to registry children + **both**
  helper-caller and bespoke read/write paths (AC9 + binding + Files-in-scope), and required the
  guarantee to hold for every state path (consolidate onto the shared point or independently
  satisfy the invariants) so no bespoke path escapes the matrix.

**Pass 4 (verdict: needs-attention):**
- *Wake dedup JSON state could escape the "every side-process state file" claim (P1)* —
  **accepted, scoped.** Verified `/tmp/orchestrator-wake-dedup.json` is owned entirely by the
  JS filter `docs/orchestrator-wake-filter.mjs` (`fs.read/writeFileSync`, `Object.entries`, own
  lock); PowerShell only passes its path to the `dedup` CLI. JS JSON round-trip is not subject
  to the PowerShell hashtable/PSObject reflection class. Rather than pull `docs/*.mjs` + Node
  into scope, **narrowed** the corruption contract to PowerShell-managed state and added an
  explicit documented exemption for the JS dedup. Split the spec into two scopes: corruption
  (PowerShell state) vs health (all registry children, incl. listener/heartbeat) — which also
  removes the latent coupling between the two concerns.

**Pass 5 (verdict: needs-attention):**
- *Positive-outcome conflated clean self-heal with a degraded verdict (P1)* — **accepted.**
  The corrupt-blob case self-heals with no error (AC3), so it cannot also be observed as
  "degraded-with-reason" without fabricating a verdict. Split the positive-outcome into two:
  (a) corrupt-blob self-heal → clean file + no tick error + Status working; (b) a separate
  sustained tick-error fixture → Status degraded-with-reason → working after recovery. Removes
  the contradiction and keeps the health signal honest.

**Pass 6 (verdict: needs-attention):**
- *False external decision-log reference (P2)* — **accepted.** The draft claimed the matrix was
  recorded in `00-architecture-decisions.md` (it was not; allowed-roots is `scripts/**`, so the
  planner couldn't repair it anyway). Removed the claim; the binding equivalence classes live in
  Acceptance criteria (the contract), with the full matrix as an uncommitted temp annex.

**Pass 7 (verdict: needs-attention):**
- *Health taxonomy missed intentional session-wait/suspended children (P2)* — **accepted.**
  Real designed behavior (observed June-7: children stop when the orchestrator session
  disappears) would be misreported as stopped/churn by the 4-state taxonomy. Added a distinct
  non-failure waiting/suspended state to AC7 and the Status binding bullet: a session-dependent
  child with no live orchestrator session reads as waiting, not degraded, and triggers no recovery.

**Pass 8 (verdict: needs-attention):**
- *Malformed/interrupted recovery could erase action-tracking fences (P1)* — **accepted.** A
  blanket "recover to clean default" would let an idempotency/dedup/audit fence (`sent`,
  `deliveries`/`audit`, `runs`, `nudged`/`pendingJournal`) reset to empty and then re-emit an
  already-delivered side effect or lose retry-bounding evidence. Split recovery: recoverable
  corruption strips garbage but keeps real entries; total parse loss on action-tracking state
  must prefer last-known-good, quarantine the bad file, and fail closed + escalate rather than
  silently zero and act (AC5 + durability binding bullet). Aligns with the repo fail-closed
  (#221) discipline.
