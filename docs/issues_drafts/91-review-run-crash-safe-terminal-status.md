# Crash-safe terminal status for a review run whose reviewer process dies mid-flight

GitHub Issue: #287

```behavior-kind
action-producing
```

## Prerequisite

- `docs/issues_drafts/24-ao-review-preflight-and-failed-run-discipline.md` (GitHub #60) —
  **closed**; established **failed-run discipline** (`failed`/`cancelled` ≠ clean,
  `terminationReason` check). That contract assumes a run **reaches** a terminal status;
  this issue covers the case where the run **never reaches one** because the writer never ran.
- `docs/issues_drafts/34-review-layer-resilience-after-worker-respawn.md` (GitHub #98) —
  **closed**; established the **orphan-run reap path** keyed on a **dead linked worker
  session** (`linkedSessionId` terminated/killed). This issue covers the distinct class where
  the **linked worker is alive** but the **reviewer's own process** died, leaving the run
  pinned `running`.
- `docs/issues_drafts/58-safe-review-trigger-reconciliation.md` (GitHub #163) — **closed**;
  the state-derived review-trigger reconciler and its coverage predicate. This issue tightens
  what that predicate may treat as **covering**.
- `docs/issues_drafts/72-reconcile-ready-head-defer-subreason.md` (GitHub #212) — **closed**;
  the `head_covered` no-start class. This issue makes `head_covered` liveness-aware; it does
  not change the defer-subreason taxonomy.
- `docs/issues_drafts/65-orchestrator-no-rereview-covered-head.md` (GitHub #189) — **closed**;
  covered-head idempotency and the per-head start de-duplication that bounds dual-path TOCTOU.
  This issue relies on that existing per-head claim to gate replacement starts — making a head
  *eligible* (clause 6) is necessary, not sufficient, to start a run.
- `docs/issues_drafts/71-orchestrator-side-process-supervisor.md` (GitHub #205) — **closed**;
  the single supervised entry point for orchestrator side-processes. If this issue's recovery
  tick is a long-running process, it registers there (side-effect-safe, no duplicate
  `ao review run`/`send`). A supervisor-owned lease/heartbeat for the reviewer is one
  acceptable realization of the liveness identity below — not a mandated one.

## Goal

When a review run's reviewer process is killed or dies mid-flight — the linked worker still
alive — the run must not remain pinned in a non-terminal `running` state. Today the terminal
status is written only by the in-process happy path, so any kill of the `ao review run`
process tree (orchestrator turn ending, daemon restart, a superseding start, or an operator
reap) before that path completes leaves the run `running` forever with no `terminationReason`;
it is then bucketed `outdated` and masquerades as a benign superseded run, while the
`head_covered` coverage predicate trusts the dead `running` run and blocks every re-trigger.
The outcome this issue commits to: a review run whose reviewer is provably no longer alive is
recorded as a distinct non-clean terminal outcome with a recorded reason, stops counting as
coverage, and so leaves the head re-reviewable by the existing reconciler — without depending
on the dying process to cooperate, without ever reaping a review whose reviewer is still
genuinely running, and without overwriting a result the normal path wrote in the same window.

```positive-outcome
asserts: a run in `running` whose attached reviewer-liveness identity is provably not alive past the grace window is conditionally transitioned to a failed-family terminal status carrying a recorded reason, ceases to satisfy head-coverage, and emits an audit record
input: external-tool-output
provenance: capture-backed
```

## Binding surface

This issue commits the repository to:

1. **Durable reviewer-liveness identity.** A `running` review record MUST carry a durable
   liveness identity for the exact reviewer process instance — enough to distinguish "this
   reviewer is still alive" from "a different or reused process now holds that identity" and
   from "identity cannot be verified" (e.g. after a restart). A bare reusable process id is
   insufficient on its own. The planner chooses the token's composition; the contract is only
   that recovery can validate the *exact* instance, not merely a reusable handle. The identity
   MUST be durable by the time the run is observable as `running`; if it is missing or only
   partially captured, the run resolves to the **ambiguous** outcome (clause 3) — never a
   confident reap and never "ambiguous forever" (it is bounded by clause 8's stale threshold).
2. **Recovery is independent of the dying process.** The mechanism that records the terminal
   outcome MUST be able to do so when the reviewer process tree has already been killed by
   signal (including a non-catchable kill) or lost to a restart — it MUST NOT rely solely on
   the reviewer writing its own status on the way out. A best-effort in-process write on a
   catchable signal MAY exist as a fast path but does not satisfy this clause alone.
3. **Three liveness outcomes, not two.** Per run the recovery tick resolves the reviewer
   identity to exactly one of: **alive** (leave untouched), **provably-not-alive** (drive to the
   terminal transition once a short crash-stability grace has elapsed — see clause 8), or
   **unverifiable/ambiguous** (identity cannot be confirmed — e.g. process table not visible
   after restart, or identity missing/partial per clause 1). A genuinely running reviewer MUST
   NOT be reaped regardless of elapsed time within the supported review duration. An
   **ambiguous** run is driven to terminal only after its stale threshold (clause 8), with a
   reason **distinct from** provably-not-alive (so operators can tell "reviewer confirmed dead"
   from "reviewer liveness never confirmable"). This issue **guarantees** that every
   **dead-or-ambiguous** non-terminal run reaches terminal within a bounded window
   (provably-dead→short grace, ambiguous→stale threshold); an **alive** reviewer's run reaches
   terminal through its own completion or the existing in-process review timeout (out of scope
   here, clause 8) — this issue does not claim to bound the alive case.
4. **Coverage is freed only by the terminal transition.** A run covers its head while, and only
   while, it is in a **non-terminal** status; coverage is freed by the run reaching a terminal
   status (normal completion or recovery), never by a bare liveness observation. So a
   provably-dead run keeps covering (reap-pending) until its terminal transition has atomically
   succeeded — a replacement is never started against a head whose prior run is still
   non-terminal. This issue **guarantees** that every **dead-or-ambiguous** non-terminal run
   reaches terminal within the bounded window of clause 3, so coverage frees in bounded time for
   the cases it owns; an **alive** reviewer's own termination remains the responsibility of the
   existing in-process review timeout (a hung-but-alive reviewer is out of scope, Files out of
   scope) — this issue references that timeout, it does not re-specify it. The coverage decision
   itself is a **pure read of persisted run status** — no inline OS process inspection, no state
   mutation.
5. **Conditional transition against the authoritative status.** The transition's ownership gate
   is **liveness, not the status label**: recovery acts on a non-terminal run whose reviewer is
   classified dead/ambiguous, and a run with a **live** reviewer is never terminalized whatever
   its non-terminal label (`running`, or any AO transient/in-progress state — which resolves to
   authoritative-busy → fail closed, never a reap). The terminal-vs-non-terminal classification
   MUST derive from AO's own status source (the classification `ao review list` uses) or a
   committed pack-owned compatibility map — never an ad-hoc guessed label list; an
   **unrecognized AO status fails closed** (treated as covering, never reaped by guesswork) — and
   such an unknown-status observation MUST emit a de-duplicated, **escalated** health/audit signal
   (not silent permanent coverage), with install/config validation failing when the committed
   status map is stale relative to AO's status source. The terminal transition is applied only if,
   at write time, the run's **authoritative status is still non-terminal** and the **same
   liveness identity (or run-local fingerprint)** is still attached; otherwise the recovery tick
   aborts without writing. The write **re-reads the latest authoritative record and preserves its
   other/unknown fields** (atomic replace, not a blind overwrite from stale in-memory contents),
   so a concurrent operator edit or other foreign writer to the same run-record state is not
   clobbered. The race against a normal completion is decided by re-reading the authoritative run
   status (terminal is a one-way door) and writing atomically (e.g. write-to-temp-then-rename, or
   whatever AO-supported run-state path applies) — **not** by a pack-private revision token the
   normal reviewer path does not advance, and not by wall-clock comparison. When the reviewer
   identity is **missing/partial** (the crash-before-identity-commit case), the CAS instead keys
   on a **stable run-local fingerprint** (e.g. run id + creation epoch) so the transition neither
   aborts forever for lack of an identity to compare, nor fires against a later unrelated rewrite
   of that run record. If the authoritative status cannot be read or updated atomically, recovery
   fails closed (no write) rather than risk overwriting a legitimate completed/failed result.
5a. **Authoritative write surface and mandatory production path.** The recovery transition writes
   to the **same AO runtime run-record state** that the normal completion path writes and that the
   operator edits for manual cleanup — the per-project AO runtime state tree **outside the
   repository** (where `ao review list` reads its runs), via an atomic file replace. This is
   distinct from the `denylist`: the `denylist` governs **repository source-path edits** the
   planner may not make (`.ao/**`, `vendor/**`, `packages/core/**`); it does not forbid writing
   AO's out-of-repo runtime state, which is the only correct target here. The mechanism MUST have
   **exactly one registered production execution path** (a #205-supervised process or an existing
   reconciler hook) — verified active after install, and verified to be the *only* such path. It
   relies on #205 to keep that path a **single live instance**; independently, every per-tick
   operation (transition, audit, escalation, first-observation clocking, replacement
   coordination) MUST be **idempotent under accidental concurrent instances**, so a double
   `ao start` / supervisor split-brain cannot double-count or corrupt. It MUST NOT land as a
   script only callable from tests while real runs stay pinned. A **persistent failure to perform
   the atomic terminal write** is itself a distinct, de-duplicated, **escalated** audited state
   (not per-tick audit spam, not a silent note that leaves the head covered forever). If AO does
   not tolerate a concurrency-safe atomic external write to that runtime state, this issue is
   **blocked on an AO-supported terminalize-run write path** rather than corrupting state — see
   Upgrade-safety.
6. **The terminal outcome is a distinguishable failed-family status, written atomically with its
   reason.** A reaped run takes a terminal status the existing failed-vs-clean discipline (#60)
   already treats as non-clean — explicitly **not** the superseded / `outdated` bucket — and
   carries a recorded reason machine-distinguishable from "completed then superseded by a newer
   head." The **terminal** reasons form a **committed, enumerable set of distinct categories** —
   at least provably-dead, ambiguous-stale, and legacy-ambiguous — persisted in the run record's
   terminal reason so downstream consumers (#60 discipline, #171 delivery) can rely on the set;
   the exact literal spelling of each is the planner's. A **persistent atomic-write failure is
   NOT one of these** — by definition the terminal write did not happen, so it cannot be a
   run-record terminal reason; it is a separate recovery-escalation/health audit signal
   (clause 5a) that never masquerades as a terminal run reason. The **terminal reason and the
   liveness evidence are part of the same atomic terminal write** as the status change, so a crash
   can never leave a terminal status without its reason (no silent transition). It is never
   counted as a clean / coverage signal.
7. **Replacement is guaranteed, exactly once — and actually starts.** After a dead/ambiguous run
   reaches terminal and stops covering, the existing per-head start de-duplication (#189/#163 and
   the `review-start-claims` claim) must permit **exactly one** replacement — both "no more than
   one" (no two live reviewers) and "at least one" (a stale claim left by the dead run must not
   permanently block the legitimate replacement). Crucially, "permit one" must become "one
   actually starts": this relies on the existing review-trigger reconciler being **periodic and
   bounded** (#163/#212), so a freed head is observed and re-reviewed within the reconciler's
   interval **without any new trigger from this issue** — recovery emits no start signal of its
   own. If that reconciler were purely event-driven, recovery would need a minimal freed-head
   signal; because it is periodic, none is added here. This issue must not leave a claim state
   that strands the head as nominally-eligible but practically un-startable.
8. **Three bounded time windows, with one invariant.** Reaping a **provably-not-alive** run
   needs only a short **crash-stability grace** (long enough to avoid racing a just-exited
   process whose own status write is in flight, not the full review duration). An **alive**
   reviewer is never reaped at any elapsed time — that protection comes from the liveness check,
   not a timer. The **ambiguous stale threshold MUST exceed the maximum supported review
   duration**, so that a still-`running`, still-unverifiable reviewer past that point cannot be a
   genuinely-live in-duration review being falsely reaped. "Maximum supported review duration"
   MUST be the **actually enforced** in-process review timeout (the existing hard timeout that
   terminates a codex review and lets the reviewer write a verdict), not an unenforced number;
   install/config validation fails if the ambiguous stale threshold does not exceed that enforced
   timeout, or if no such terminating timeout is in force. All windows are operator-configurable
   with documented defaults and concrete fixture values pinned by tests. The windows applied to a
   run are the **effective values captured at that run's start**: changing the config while a run
   is already in flight MUST NOT retroactively shorten a live run's protection (no reaping a
   legitimate review early because the deadline moved under it). A **legacy / pre-feature
   non-terminal run** that has no captured windows or identity is treated as ambiguous with the
   clock started at **first recovery observation** (not an unknown run-start), using conservative
   default windows, and audited as a legacy-window assignment — so pre-upgrade stuck runs (the
   capture-backed motivating case) are recoverable without retroactively mis-timing live runs.
9. **No secrets in identity, evidence, or audit.** The reviewer-liveness identity, the persisted
   liveness evidence, and every audit/skip record MUST use a redacted, allowlisted schema. It is
   forbidden to persist command lines, environment values, session/auth tokens, credential-
   bearing paths, or profile/cwd data that may carry secrets — into run records, sidecars, audit
   logs, fixtures, or CI artifacts. Skip records for a still-ambiguous run are de-duplicated (one
   per run / identity / ambiguous-evidence epoch, not one per tick). The transition audit is
   **durable across a crash between the terminal write and a separate audit write**: a
   recovery-written terminal reason found without its transition audit is detected and backfilled
   **exactly once** (an audit-outbox / reconciliation invariant), so a crash in that window cannot
   leave a terminal run record with no audit of how/why it was recovered.
10. **Operator adoption.** Because clause 5a mandates a registered production path, the change
   MUST ship operator-adoption docs containing the **concrete** post-PR commands (not a promise of
   them): merge any `agent-orchestrator.yaml.example` / supervisor-registry change into the live
   config, restart via `ao stop` / `ao start`, and the exact command plus expected
   "registered and live" output that confirms the recovery tick is running (not merely present on
   disk).

## Files in scope

- `scripts/**` — the recovery/liveness logic and its tests/fixtures (pack-owned reconcile or
  supervised side-process surface).
- `plugins/ao-codex-pr-reviewer/**` — the reviewer-liveness identity capture at run start, and
  the optional best-effort in-process terminal write on a catchable signal.
- `agent-orchestrator.yaml.example` — only if a supervised process or `orchestratorRules`
  clause is added.
- `prompts/agent_rules.md` — only if a universal rule clause is needed.
- `docs/**` — recovery-runbook / operator-facing description of the new terminal outcome.

## Files out of scope

- AO core / vendored runtime (`packages/core/**`, `vendor/**`).
- The `markSuperseded` "kill in-flight before the claim guard decides a new run is warranted"
  **ordering** (why a superseding start kills the prior run's process at all) — this issue
  recovers the corpse but does not change that ordering.
- Auto-start eligibility for a quiescent worker (GitHub #261), review-finding delivery
  (GitHub #171), and heartbeat-based detection of a **hung-but-alive** reviewer (a reviewer
  whose process is alive but making no progress is left to the in-process review timeout).
- **GitHub Issue / PR review-state surfacing.** This issue changes only local AO review-run
  state. A reaped run simply stops covering the head; the fresh run started by the existing
  reconciler delivers its outcome through the normal path (#171). No Issue/PR comment, label,
  or check is mutated here.
- **Native (non-WSL) Windows.** The reviewer runs under WSL2/Linux; native-Windows process
  identity / restart semantics are out of scope. (See Upgrade-safety.)

```denylist
vendor/**
packages/core/**
.ao/**
```

## Acceptance criteria

- Given a `running` run whose attached liveness identity is provably not alive and whose
  crash-stability grace has elapsed, the recovery mechanism transitions it to a failed-family
  terminal status (never the superseded / `outdated` bucket) with a non-empty recorded reason,
  written atomically with the reason. (Capture-backed fixture available: a real stuck `running`
  run with `terminationReason` null whose reviewer was killed mid-flight.)
- Given a `running` run whose reviewer identity is **alive** (a slow but live review), the
  mechanism leaves it untouched — no transition, no reason — regardless of elapsed time within
  the supported review duration.
- Given a `running` run whose reviewer identity is **unverifiable/ambiguous** (including
  missing or partially-captured identity, e.g. a crash between the run becoming visible as
  `running` and its identity being committed), the mechanism does not reap it before the stale
  threshold and the skipped reap is audited **once per ambiguous-evidence epoch, not once per
  tick**. Once the stale threshold (which exceeds the maximum supported review duration) elapses
  it is transitioned to a failed-family terminal status whose reason is **distinct from** the
  provably-not-alive reason.
- Coverage is freed only by a terminal status: a `running` run (alive, provably-dead-not-yet-
  reaped, or ambiguous) still covers its head; a fixture flips to not-covering only once the run
  reaches terminal. The coverage decision reads persisted run status only — no OS process
  inspection — so a fixture with no live process state still decides correctly.
- A reused process id that is **not** the original reviewer instance is treated as not-alive
  (or ambiguous), never as a live reviewer — a run is not kept alive by an unrelated process
  inheriting the id.
- Concurrent-completion safety: if the normal reviewer writes a terminal status during the
  recovery window, the recovery transition does not overwrite it — the write aborts because a
  re-read of the **authoritative run status is no longer non-terminal**, not because of a
  wall-clock or pack-private-token compare. The abort/terminalize behavior is asserted over every
  supported non-terminal label, not only `running`.
- After a dead/ambiguous run reaches terminal, **exactly one** replacement can be started: no
  two live reviewers on the head, and a stale start-claim left by the dead run does not
  permanently block the one legitimate replacement (proven with the recovery tick and reconciler
  running concurrently).
- On a quiescent install, terminalizing a stuck run results in the existing periodic reconciler
  actually starting **one** replacement review within its interval — without any external event
  and without a new trigger from the recovery mechanism.
- Per-tick operations are idempotent under accidental concurrent instances of the recovery path
  (simulated double instance): no double transition, no duplicate audit/escalation, no
  double-started replacement.
- No identity, liveness-evidence, or audit/skip record persists a command line, environment
  value, session/auth token, credential-bearing path, or profile/cwd data — asserted by a
  no-secret-leak fixture over run records, sidecars, and audit logs.
- A run that reached a terminal status through the normal path (including `failed` via a
  reviewer process that exited non-zero) is not altered by the recovery mechanism.
- A run reaped for a dead reviewer is distinguishable by its recorded reason from a
  completed-then-superseded run, and is never counted as a clean / coverage signal.
- The recovery mechanism is side-effect-safe under repeated ticks and concurrent observers: it
  does not double-transition a run, and it issues no `ao review run` / `ao review send` itself.
- The recovery tick has a registered production execution path and is observably active after a
  clean install (not merely a script callable from tests); a reaped run's terminal status is
  visible through `ao review list` like any other terminal run. Exactly one production path is
  active — an install with both the supervised process and a reconciler hook registered, or with
  neither active, is detected and fails the check.
- Changing a time-window config (max review duration, crash grace, ambiguous stale threshold)
  while a run is already in flight does not retroactively shorten that run's protection: a fixture
  that moves the deadline mid-run does not cause an early reap of an otherwise-protected review.
- A persistent inability to perform the atomic terminal write surfaces as a distinct, escalated,
  de-duplicated audited state — not per-tick audit spam, and not a head left silently covered
  forever under a generic note.
- A legacy / pre-feature non-terminal run (no captured windows or identity — the capture-backed
  stuck-run fixture) is recovered: treated as ambiguous, clock from first observation,
  conservative default windows, audited as a legacy-window assignment.
- A run with a live reviewer is never terminalized regardless of its non-terminal status label;
  an AO transient/in-progress write state resolves to fail-closed, not a reap.
- A concurrent foreign write (operator manual edit) to the same run-record state is not
  clobbered by recovery: the atomic write preserves the latest record's other fields.
- Install/config validation fails if the ambiguous stale threshold does not exceed the actually
  enforced in-process review timeout, or if no terminating review timeout is in force.

## Upgrade-safety check

- No edits to `packages/core/**` or `vendor/**`; no AO-core behavior assumed beyond the
  documented `ao review list` / run-record fields and review-run statuses. If the run record
  cannot carry the liveness identity natively, it is persisted in a pack-owned sidecar, not by
  patching AO core. The sidecar MUST carry a **verifiable binding** to its run record (e.g. run
  id + creation epoch fingerprint); a stale, orphaned, duplicated, or mismatched sidecar (after a
  manual edit, restore, or migration of the run record) is treated as **missing identity →
  ambiguous**, never as a confident match and never as fail-closed-forever.
- The terminal write targets local AO run-record state (the same state normal completion writes
  and the operator edits for cleanup), via an atomic file replace, never an AO-core edit. This
  assumes AO tolerates a concurrency-safe atomic external replace of that state; the
  implementation MUST verify that assumption and **fail closed** (leave the run non-terminal,
  audited) if it does not hold — and in that case this issue is blocked on an AO-supported
  terminalize-run write path before it can ship its action-producing clause. (Open dependency,
  recorded in Verification.)
- No unsupported `agent-orchestrator.yaml` schema (no silently-ignored top-level blocks); any
  new wiring uses `orchestratorRules` / supervised-process registration consistent with #205.
- No new repository secrets.
- Reviewer-liveness identity capture and validation must hold on the supported runtime —
  Linux/WSL2 with pwsh 7+ — including the case where the process table is not fully visible
  after a restart (which resolves to **ambiguous**, not a false reap). Native (non-WSL) Windows
  is out of scope (Files out of scope); the mechanism must fail closed to **ambiguous** rather
  than false-reap if ever run there.

## Verification

- Unit/fixture tests enumerate the full class matrix: provably-not-alive + `running` → reaped
  to the failed-family outcome with reason (the capture-backed stuck-run fixture);
  alive + non-terminal → untouched; ambiguous + non-terminal → covering and not reaped before
  the stale threshold, then reaped with a distinct reason and no longer covering after it;
  missing/partial identity (including a "never-started" run with no captured reviewer identity)
  → uniformly **ambiguous** (covering until the stale threshold), never short-grace reaped;
  already-terminal (clean / failed) → untouched.
- A PID-reuse / wrong-process collision fixture proves a reused id is not mistaken for the live
  reviewer.
- A missing/partial-identity fixture proves the conditional terminalization keys on the stable
  run-local fingerprint (run id + creation epoch): it neither aborts forever nor fires against a
  later unrelated rewrite of that run record.
- A config-change-during-active-run fixture proves window changes do not retroactively shorten a
  live run's protection.
- A repeated-terminal-write-failure fixture proves the failure escalates once (de-duplicated),
  not per tick, and the head is not silently left covered forever.
- A duplicate-production-path install check fails when both the supervised process and a
  reconciler hook are registered (or when neither is active).
- A legacy-run migration fixture (non-terminal run with no captured windows/identity) proves
  first-observation clocking, conservative defaults, and the legacy-window audit.
- A foreign-writer race fixture (operator edits the run record concurrently) proves recovery's
  atomic write preserves the latest record's other fields and does not corrupt it.
- An install/config validation test proves the ambiguous stale threshold is rejected unless it
  exceeds the enforced in-process review timeout.
- A test proves a non-terminal run with a live reviewer (any non-terminal label) is not reaped,
  and an AO transient write state fails closed rather than terminalizing; the abort/terminalize
  matrix is exercised over every supported non-terminal label, not only `running`.
- An end-to-end test on a quiescent install proves that after a stuck run is terminalized, the
  existing periodic reconciler starts exactly one replacement review within its interval, with no
  external event and no new trigger emitted by recovery.
- A concurrent-instance test (two instances of the registered recovery path) proves transition,
  audit, escalation, first-observation clocking, and replacement remain idempotent.
- A test proves a persistent atomic-write failure never appears as a run-record terminal reason
  (it surfaces only on the separate escalation/health channel), and the run stays non-terminal.
- A stale/orphan/duplicate sidecar fixture (run record manually edited / restored / migrated
  while the sidecar identity stays old) proves the run is treated as missing-identity → ambiguous,
  not terminalized against the wrong logical run and not stuck fail-closed forever.
- An unknown/unrecognized AO status fixture proves the run fails closed (covering, not reaped by
  guesswork), emits a de-duplicated escalated health/audit signal, and that the classification
  derives from AO's status source or the committed map; an install/config check fails when that
  committed map is stale relative to AO's status source.
- A crash-injection test for **terminal write succeeded but the separate audit write was lost**
  proves a later tick backfills exactly one transition audit (no silent recovered-but-unaudited
  terminal run).
- A test proves a provably-not-alive run is reaped after the short crash-stability grace (not
  the review-duration window), and that an alive run is never reaped regardless of elapsed time.
- A concurrency test runs the recovery tick and the review-trigger reconciler against the same
  head and proves: an **ambiguous** original blocks any replacement until its stale threshold,
  and once it (or a provably-not-alive run) frees the head, exactly one replacement is claimed
  (no duplicate, no two live reviewers).
- A race test proves the conditional transition aborts when a normal terminal write lands first,
  decided by a re-read of the **authoritative run status** (no longer `running`), so a legitimate
  completed/failed result is never overwritten — and a test asserts the check does not depend on
  a pack-private token the normal path never advances.
- A coverage test proves coverage is freed only by a terminal status: a `running` run (alive,
  provably-dead-pre-reap, or ambiguous) covers; the same run flips to not-covering once terminal
  — read from persisted status only, no OS inspection.
- A crash-injection test for **run-visible-as-`running` then crash before identity commit** →
  resolves to ambiguous-and-covering (no false reap, no coverage gap); and a second crash-
  injection for **crash after the status transition but before any separate audit step** → no
  reasonless terminal exists (reason is part of the atomic terminal write).
- A no-secret-leak fixture asserts no command line, env value, token, credential-bearing path,
  or profile/cwd data appears in run records, sidecars, or audit logs.
- An invariant test asserts the configured ambiguous stale threshold exceeds the maximum
  supported review duration.
- An audit test asserts a record is emitted for a recovery transition and for an
  ambiguous-liveness skip, with the required fields, and that repeated ticks against the same
  still-ambiguous run do not emit duplicate skip records (one per evidence epoch).
- A cross-shell liveness fixture exercises Linux / WSL2 / pwsh 7+, including the
  ambiguous-after-restart path.
- A repeated-tick test proves idempotence (no double-transition) and that the mechanism emits
  no `ao review run` / `ao review send`.
- An install-level check proves the recovery tick is registered in the AO runtime path (the #205
  registry or an existing reconciler hook) and actually runs on a clean install — not merely
  that the unit is callable from a test. `ao` status/registry output shows it live after
  `ao start`; the operator-adoption steps reproduce that state from a clean merge.
- A test exercises the production authoritative write surface (atomic replace of the local AO
  run-record state) and confirms `ao review list` reflects the terminal status afterward; a
  companion check proves recovery fails closed (run left non-terminal, audited) if that write
  cannot be performed atomically.
