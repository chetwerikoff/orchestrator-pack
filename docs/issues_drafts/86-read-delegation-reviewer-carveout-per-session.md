# Read-delegation audit: reviewer-path carve-out must key on a per-work-unit review signal, not machine-global PACK_REVIEWER

GitHub Issue: #264

## Prerequisite

- `docs/issues_drafts/83-coworker-delegation-threshold-and-enforcement.md`
  (GitHub #255) — the Phase-1 stop-time read-delegation audit this issue
  repairs. #255 shipped the audit, the metric artifact, and the reviewer-path
  carve-out; this issue fixes the carve-out's predicate so the metric is no
  longer structurally empty. It does **not** re-derive the audit contract.

## Goal

Make the read-delegation audit's residual-non-compliance metric actually
measurable. Today the reviewer-path carve-out excludes **every** audited work
unit from the denominator, so the metric the whole Phase-1 build exists to
produce (residual = flagged ÷ delegable trigger-firing units, AC8 of #255) is
permanently `0/0` and uninformative — the exact "green while broken / faked-clean
rate" trap #255 warned against. The carve-out must distinguish *a reviewer is
configured on this machine* (a standing, always-true condition) from *this work
unit is itself a review execution* (the rare condition the carve-out is for),
and exclude only the latter.

```behavior-kind
action-producing
```

## Design analysis

### Observed failure (capture-backed)

The live metric artifact `~/.orchestrator-pack/read-delegation-audit.jsonl`
contains work-unit verdicts on both surfaces, all valid, recent. Of the
`work_unit_verdict` records, **every** one has `reviewerPath: true`,
`excludedFromDenominator: true`, `inDenominator: false`, `flagged: false`.
`triggerFired` was true on several units, yet none entered the denominator.
The residual-non-compliance rate is therefore computed over an empty
denominator on every window.

### Root cause (decision-level)

The carve-out predicate conflates two different facts:

- **Machine-global reviewer configuration.** `PACK_REVIEWER` is exported in the
  operator's shell profile (a standing setting selecting which reviewer the
  pack uses). It is present in the environment of **every** process — every
  Claude session, every Cursor AO worker, every stop hook — regardless of what
  that session is doing. Its presence says nothing about whether the current
  work unit is a review.
- **This-unit-is-a-review-execution.** The condition the carve-out actually
  wants: the audited work unit is the review path running (which legitimately
  never delegates and must be excluded). This is a per-work-unit / per-session
  property, not a machine-wide one.

The stop-hook wrapper injects the ambient `PACK_REVIEWER` into the audit's
session env, and the audit treats a non-empty `PACK_REVIEWER` (or
`REVIEW_COMMAND`) as "reviewer-path session." Because `PACK_REVIEWER` is always
set on the operator machine, the predicate is always true and the carve-out
swallows the entire denominator. The predicate must bind to a per-work-unit
review signal, not to the mere presence of the standing machine-global
reviewer-selection variable.

### Satisfiability gap — resolve by capture before relying on a marker

The fix is only well-posed if the replacement signal is **actually observable**
in the audit's session context for a real review execution. Two facts are not
yet proven and the planner MUST establish them by capturing real behaviour, not
by assuming:

- **(a) Does a real review execution even fire the audit Stop/stop hook?** The
  review path runs the configured reviewer (`PACK_REVIEWER` → the pack review
  wrapper) as its own process. If that process does **not** emit a Claude
  `Stop` / Cursor `stop` event, then **no review-execution work unit ever
  reaches the audit** — in which case the carve-out has no real unit to exclude,
  and the *only* observable effect of today's predicate is the false exclusion
  of ordinary sessions. The fix is then simply: stop excluding on the ambient
  variable; the per-unit branch is defensively correct because no real review
  unit arrives anyway.
- **(b) If it does fire, is a per-invocation review marker present in the
  session context the audit receives, and absent for an ordinary session on the
  same machine?** A candidate is a request-scoped review-command value that is
  not part of the ambient profile environment, but its presence in the *stop
  hook payload* must be demonstrated, not assumed. If no such marker is visible
  to the audit, the review wrapper must emit one explicitly and it must be tested
  end-to-end.

This is the [[review-send-runtime-contract-unsatisfiable]] failure class: a
predicate bound to a signal that is never per-unit-true in production. The
contract below is written to be correct in **both** worlds (a) and (b) and to
forbid shipping a fix proven only against synthetic constructed sessions.

### Critical mechanics

- **The carve-out is a denominator exclusion, and exclusions are dangerous.**
  Anything excluded from the denominator can never be flagged and never counted,
  so an over-broad exclusion silently zeroes the measurement while every other
  part of the pipeline reports healthy. The predicate must be *narrow by
  default*: exclude only on a positive per-unit review signal, never on a
  standing ambient condition that is true for non-review work.
- **Signal provenance, not signal name, is the invariant.** The fix is not "use
  variable X instead of variable Y." It is: the review-path signal must be one
  that is **present only when the current work unit is a review execution** and
  **absent for an ordinary session on the same machine**. A signal that is
  populated from the always-present ambient profile fails this test no matter
  what it is called.
- **Fail-loud parity with #255.** #255 requires that a degraded/empty audit be
  reported as degraded, not as a clean zero residual. A denominator that is
  empty because the carve-out ate it must be observably distinguishable from a
  denominator that is empty because no trigger fired.

### Industry framing

This is the standard "ambient authority vs. request-scoped capability"
distinction: a globally-set environment variable describes machine/operator
configuration, not the intent of an individual unit of work. Audit and
compliance systems gate on the request-scoped fact (what *this* operation is),
not on standing configuration, precisely to avoid a global flag silently
disabling measurement. The same lesson recurs in this repo as machine-global
state masquerading as per-event state (see [[session-runtime-liveness-contract-unsatisfiable]]
class — a predicate bound to a signal that is never per-session-true).

### Architecture sketch

```
  stop hook fires (every session: normal worker, Claude session, OR review exec)
        |
        v
  wrapper builds session context
        |   today: session.reviewerPath <- presence of ambient PACK_REVIEWER  (ALWAYS true)
        |   fix:   session.reviewerPath <- a per-work-unit review-execution signal
        v
  auditWorkUnit:
        excludedFromDenominator = reviewerPath OR codeClass
        |
        +-- reviewer-path review execution  -> excluded (correct, rare)
        +-- ordinary session, reviewer cfg'd -> IN denominator (the fix restores this)
        +-- code-class read                  -> excluded (unchanged)
```

The boundary the planner must honour: the predicate's input is a per-work-unit /
per-session review marker; it must **not** be the bare presence of the standing
machine-global reviewer-selection variable. The exact marker (a request-scoped
review-command/env signal, an explicit session field, or an AO review-execution
flag **only if it reads an already-existing AO-provided field that needs no
`.ao/**`, `packages/core/**`, or `agent-orchestrator.yaml` schema change** — the
denylist and upgrade-safety section forbid those) is the planner's choice — the
contract is its *provenance* (per-unit, not ambient).

### Options considered (cost / risk / sufficiency)

| Option | Cost | Risk | Verdict |
|---|---|---|---|
| **A. Drop the reviewer-path carve-out entirely** | low | Review-execution units (which legitimately never delegate) would be flagged as non-compliant — reintroduces a known false-positive class #255 deliberately excluded | **Reject** — loses a correct exemption |
| **B. Keep ambient-`PACK_REVIEWER` predicate, special-case the metric to ignore the exclusion** | low | Two notions of the denominator drift apart; the carve-out stays wrong everywhere else; patches the symptom not the class | **Reject** — papers over the decision bug |
| **C. Re-bind the carve-out to a per-work-unit review signal; ambient machine-global reviewer-selection alone never excludes (chosen)** | low–medium | Low — narrows an over-broad predicate; covered by the existing equivalence-class fixture harness plus new rows; **correct under either capture outcome** — it does not presume a per-invocation signal already exists, it requires the carve-out to key on one *if* present (world (b)) and to fall back to a defensive proof-of-absence branch if not (world (a)); the AC2 capture decides which | **Chosen** — fixes the class, restores the measurement, keeps the legitimate review exemption |

Chosen: **C**. A loses the legitimate exemption; B keeps the wrong predicate and
splits the denominator definition.

### Equivalence-class enumeration (fix the class, not the case)

The carve-out is an exclusion decision; it must be specified over the class.
Dimensions: **machine reviewer config** {configured (PACK_REVIEWER set),
unconfigured}, **this unit** {ordinary work, actual review execution},
**surface** {Claude, Cursor}. Expected exclusion outcome — the build must pin
every row as a fixture:

| Machine reviewer config | This work unit | Expected carve-out |
|---|---|---|
| configured (PACK_REVIEWER set) | ordinary session/worker | **NOT excluded** — enters denominator; flag/no-flag decided by the normal rules (the regression row) |
| configured | actual review execution (per-unit review signal present) | **excluded** — reviewer-path, as #255 intends |
| unconfigured (PACK_REVIEWER unset) | ordinary session/worker | **NOT excluded** — enters denominator (with the configured-machine ordinary row, this proves machine-config alone never drives exclusion) |
| unconfigured (PACK_REVIEWER unset) | actual review execution carrying a genuine per-unit review signal | **excluded** — the per-unit signal drives the carve-out, so it excludes **regardless of whether ambient PACK_REVIEWER is set**. (This cell is *reachable precisely because the fix makes the signal per-unit/request-scoped*; the old "fails-closed without PACK_REVIEWER" assumption must NOT be used to skip it. Realizable in **world (b)** with a captured payload; **vacuous in world (a)**. The expected behaviour is pinned, not hand-waved.) |
| configured | ordinary session that fired a trigger and did NOT delegate | **NOT excluded AND flagged** — the end-to-end regression the metric needs |
| configured | code-class read | excluded via **code-class** (unchanged), independent of reviewer logic |

Both surfaces MUST yield the same exclusion verdict per row (detection parity,
per #255 AC6).

**Two-world branching of the review-execution rows.** The rows asserting an
*actual review execution → excluded* are only realizable in **world (b)** (the
review execution emits an audit hook carrying the per-unit marker). Under
**world (a)** (the capture shows review executions emit no audit hook), no
review-execution unit ever reaches the audit, so those rows are vacuous — and a
synthetic constructed "review" session is forbidden (AC2). In world (a) the
review-execution rows are replaced by a single proof-of-absence row: no
review-execution work unit reaches the audit, and ordinary trigger-firing units
on the same machine are still not excluded. The remaining rows (ordinary
sessions, code-class, the machine-config-toggle) hold identically in both
worlds. Which branch is in force is decided by the AC2 capture, not by the
planner's preference.

**Reviewer-entrypoint multiplicity is bounded.** The contract assumes the
**single tracked review wrapper** the pack currently uses (`PACK_REVIEWER`
selecting the one local reviewer). A capture proves the marker/no-hook branch
only for the entrypoint it exercised; it must **not** be extrapolated to a
different reviewer. If `PACK_REVIEWER` can select multiple distinct review
entrypoints/wrappers, each requires its own capture or a recorded
equivalence proof — an untested reviewer value must not be assumed excluded by
an ambient fallback (that would reintroduce the very ambient-driven exclusion
this issue removes) nor silently enter the denominator as a false violation.

## Binding surface

This issue commits the repository to:

1. **A per-work-unit reviewer-path predicate.** The audit excludes a work unit
   as reviewer-path **only** when a per-work-unit / per-session signal indicates
   the unit is an actual review execution. The presence of the standing
   machine-global reviewer-**selection** variable alone (the operator's
   profile-exported reviewer choice) MUST NOT cause exclusion. The carve-out's
   intent (real review executions never owe delegation and stay out of the
   denominator) is preserved; only its trigger changes from an ambient standing
   condition to a per-unit signal.
2. **Stop-hook session context carries the corrected signal — proven by
   capture.** Whatever per-unit review marker the predicate keys on, the
   stop-hook wrapper must populate the audit session context from a source that
   is present only for an actual review execution and absent for an ordinary
   session on the same machine. The wrapper must stop letting the always-present
   ambient reviewer-selection variable stand in for "this is a review." The
   review-execution branch of the carve-out MUST be proven against a
   **capture-backed** payload from the real review path (not a hand-built
   session object): either a captured real review-execution stop-hook payload
   showing the chosen marker present, or — if capture shows the review execution
   emits no audit hook event at all (world (a)) — a captured artifact recording
   that finding, which then makes the defensive per-unit branch sufficient.
3. **Denominator-emptiness is observable by cause.** The emitted metric must let
   a consumer distinguish "denominator empty because the carve-out excluded
   everything" from "denominator empty because no trigger fired" — i.e. an
   all-excluded window is not reported as a clean zero residual (fail-loud parity
   with #255's degraded-window requirement).
4. **No change to the code-class carve-out, the threshold numbers, the
   work-unit boundary, machine-observed delegation, or the fail-open/idempotency
   contract** from #255 — those are referenced, not redefined.

**Operator adoption:**
- After this merges, no machine-local JSON wiring changes are required (the
  `Stop` / `stop` hooks already reference the tracked handler). The required adoption check
  is a **fresh ordinary session with no side effects** (a disposable read-only
  unit whose only purpose is to fire the *installed* stop hook) **on each surface
  (Claude and Cursor)** — **not** a re-run of a previously completed,
  side-effecting work unit (re-running a real unit can replay worker actions,
  mutate task/GitHub state, or duplicate artifacts — the duplicate-execution
  failure class). It must show an ordinary trigger-firing unit appearing with
  `inDenominator: true` (not `reviewerPath: true`) in
  `~/.orchestrator-pack/read-delegation-audit.jsonl`. Replaying a captured payload
  through the audit handler is a **supplementary handler-logic test only**: it
  bypasses the installed hook wiring, so it does **not** satisfy adoption — a
  machine with a stale local hook registration could pass replay while real
  sessions still invoke the old wrapper and keep writing `reviewerPath: true`.
- If the chosen per-unit signal requires a new per-invocation marker, that
  marker MUST be emitted by **tracked repo code** (the review path / wrapper),
  not by an operator-supplied untracked local setting. Merging the fix must be
  sufficient for the marker to exist on every review execution — the contract
  cannot depend on a machine-local wiring step the operator might omit (that
  would let a machine merge the fix yet keep producing unmarked executions, the
  same environment-dependent false-clean condition this issue removes). If no
  new marker is needed, state that explicitly; in neither case is an untracked
  operator wiring step the source of the signal.

## Files in scope

- `docs/read-delegation-audit.mjs` — reviewer-path predicate, session-context
  construction, the denominator-cause / review-hook-capability summary emission,
  and the **unconditional** load/surfacing of the persisted capability record
  (AC7) so live metric summaries carry the review-hook capture-branch field on
  every window.
- The **single versioned capability record artifact** (AC7) — one committed,
  scrubbed record carrying at least `{surface, branch (world-a/world-b),
  entrypoint terminal status, normalized hook-wiring fingerprint, behaviour-owning
  code hashes}`. It exists and is loaded **for both worlds** (the branch is a
  field value, not a reason to skip the artifact); its path and schema are the
  planner's choice, but it and its generation/update step are in scope so live
  windows surface the standing capability after the one-time capture. The record
  is **surface-indexed** — mandatory Claude **and** Cursor entries, **or** a
  recorded mechanical-equivalence proof (per AC5) authorizing one shared entry; a
  single unqualified branch value must not be loaded for both surfaces and make
  parity satisfied by construction.
- `docs/read-delegation-audit.d.mts` — session-context type, if the signal shape
  changes.
- `scripts/invoke-read-delegation-audit-stop.ps1` — stop-hook wrapper session
  enrichment (stop injecting the ambient reviewer-selection variable as the
  review signal).
- `scripts/read-delegation-audit.test.ts` — equivalence-class rows above.
- `scripts/fixtures/read-delegation-audit/` — new/updated fixtures for the rows.
- `docs/coworker-read-delegation-audit.md` — the carve-out contract wording, if
  it states the predicate.

## Files out of scope

- The threshold numbers, work-unit boundary, anti-chunking aggregation,
  machine-observed-delegation rule, fail-open/idempotency mechanics from #255.
- The code-class (`--allow-code`) carve-out semantics.
- The Phase-2 pre-read hard block (still deferred per #255).
- `packages/core/**`, `vendor/**`, `.ao/**`.
- The review path scripts themselves (`scripts/invoke-pack-review.ps1` etc.) —
  unless **either** the chosen signal requires the review path to emit a
  per-invocation marker, **or** the side-effect-bounded capture (AC2) cannot be
  performed against a disposable target without a no-publish/dry-run mode that no
  tracked code yet provides. In those cases only the **minimal** enabling line(s)
  — marker emission and/or the no-publish guard needed for a safe capture — are
  in scope; the review logic otherwise stays untouched. The implementer must
  first try a disposable/throwaway target that needs no review-script change, and
  put review-script changes in scope only if that is impossible.

```denylist
vendor/**
packages/core/**
.ao/**
```

## Acceptance criteria

1. An ordinary work unit on a machine where the reviewer-selection variable is
   set (the production condition) is **not** excluded as reviewer-path: it has
   `reviewerPath: false`, and if it fired a trigger it has `inDenominator: true`.
2. The review-execution branch is **capture-backed, not synthetic**: there is a
   captured artifact from the real review path that establishes one of —
   (b) a real review-execution stop-hook payload in which the chosen per-unit
   marker is present and a sibling ordinary-session payload on the same machine
   in which it is absent, with the audit excluding the former and not the
   latter; **or** (a) a **bounded proof of absence** that the review execution
   emits no audit hook event — the capture must show the real review command
   actually ran to completion under the installed stop hook **and** include a
   positive control (an ordinary session in the *same* hook-wired setup that
   *did* produce an audit event), so a misconfigured hook, wrong command, or
   early timeout cannot masquerade as "review emits no event." **"Ran to
   completion" is not enough — the capture must assert an expected-success (or a
   named acceptable dry-run) terminal status AND that the review reached the same
   production stage that would emit the hook/marker.** A review that fails closed
   or exits early (e.g. for a missing dependency, a dry-run abort, or a credential
   gap) also "completes," but observing "no hook" from such a run would *falsely*
   classify the system as world (a) when a successful production review would in
   fact emit a hook. The terminal status and the reached-emission-stage evidence
   are part of the AC2 provenance. **The
   review-execution capture must be side-effect-bounded:** the real review
   entrypoint runs under the installed stop hook (authenticity is preserved), but
   against a **disposable / no-publish target** (a throwaway fixture PR/issue or
   a dry-run review mode) so the capture cannot post comments, mutate production
   PR/task/GitHub state, or consume real credentials; the capture must assert no
   external mutation occurred. Authenticity comes from the real entrypoint + real
   hook, not from mutating production state. The bounded mechanism must either
   already exist in tracked code or be added as the minimal in-scope enabling
   change (per Files out of scope) — a faked capture or one that mutates
   production state does **not** satisfy this. **Credential boundary:** since a
   real review entrypoint may need credentials to complete, the bounded-capture
   approach must pick **one of two cleanly separated branches** (throwaway
   credentials are still credentials — "no real credentials" and "scoped
   throwaway credentials" are not the same guarantee and must not be conflated):
   **(i) null/dry-run transport** — no credential-bearing env is read at all; or
   **(ii) explicitly disposable credentials** — named, scoped to a bounded blast
   radius, audited, and **forbidden from fixture serialization**. Non-consumption
   must be **mechanically bounded, not merely asserted**: the capture runs under a
   **sanitized env allowlist** so real credential-bearing keys are physically
   absent from the capture process env — parent **and** inherited children —
   rather than relying on a textual "we didn't read them" claim a reviewer cannot
   verify. Branch (ii) names exactly which disposable keys the allowlist permits.
   In **both** branches the capture must show no real credential-bearing env
   values were available to (branch i) or serialized in (either branch) the
   committed fixture (reinforcing AC8's scrub). The enforcement mechanism
   (allowlist, instrumented shim) is the planner's; the contract is structural
   absence, not assertion. The exact
   transport/adapter design is the planner's; the contract is that authenticity
   (real entrypoint + real hook) is achieved with **no real-credential
   consumption and no credential value leaking into the repo**. **The capture must also pin the
   observed process/session boundary.** A review wrapper may spawn child
   processes; the hook can fire (or not) at a different process level than the
   top-level entrypoint. The world-(a) proof-of-absence is valid **only** if it
   demonstrates the observation boundary covered the *same parent-plus-child
   process tree* that production review execution uses — otherwise a no-hook
   determination read off the wrong process level could falsely conclude no
   review unit reaches the audit when one does in production. The provenance
   metadata must record the observed process/session boundary. In world (a) the
   criterion is met by showing no review-execution unit reaches the audit and
   the per-unit branch never wrongly excludes an ordinary unit. A fix proven
   only against a hand-constructed "review" session object, or an unbounded "we
   saw no hook" note with no positive control, does **not** satisfy this
   criterion. **Provenance must survive scrubbing.** Because AC8 reduces the
   committed fixture to a minimal schema, a reviewer/CI gate would otherwise be
   unable to tell a real-hook capture from a hand-authored one — a
   reviewer-false-approval path. The captured artifact MUST therefore carry
   provenance metadata sufficient for a reviewer to confirm real-hook origin
   without re-running the path: the invoked review entrypoint identity, evidence
   the installed stop hook was wired during capture, the review command's exit
   status, the positive-control event key, and a derivation link binding the
   committed fixture to that raw capture. **Provenance must also bind the capture
   to the code revision it validates** — record the revision (commit/file-hash)
   of the files whose behaviour the capture proves: at least the audit handler,
   the stop-hook wrapper, and the review-marker-emitting code. The check is
   **exact, not subjective** — it compares the recorded per-file hash (or
   commit + dirty-state) of those behaviour-owning files against the files under
   test and **fails on any mismatch, requiring recapture** ("materially out of
   date" is not a deterministic CI condition and must not be the gate). This
   stops a stale capture from an earlier implementation silently satisfying
   AC2/AC8 after the behaviour it proves has changed.
   **Provenance must also fingerprint the installed hook wiring, not just repo
   files** — the capture proves the behaviour of the *installed* stop hook, and a
   stale local hook registration can still point at an older wrapper path/command
   while the repo file hashes are current. Record a hook-wiring fingerprint in a
   **scrub-safe normalized form that satisfies AC8** — the repo-relative wrapper
   identity, the wrapper's file hash, and a normalized argv/command *shape* with
   the operator-home prefix redacted — **not** the raw absolute path or full
   command string AC8 forbids. CI compares this normalized fingerprint against
   the tracked wrapper invocation the current repo expects and fails on mismatch.
   The attestation must be expressible *without* checking in any forbidden raw
   path/command/secret value. The exact metadata shape
   is the planner's; the contract is that real-hook origin **and current-code
   provenance** — covering both repo files and the installed wiring that ran —
   are *mechanically checkable after scrubbing*, not asserted in prose.
3. The exclusion verdict is driven by the per-unit review signal, **not** by the
   ambient presence of **any** reviewer-related environment variable. The
   current predicate excludes on either `PACK_REVIEWER` **or** `REVIEW_COMMAND`;
   the criterion must cover both: a fixture in which an ordinary unit's session
   env carries `PACK_REVIEWER`, `REVIEW_COMMAND`, or both as **ambient standing
   environment** (not a captured per-unit review signal) does **not** change the
   exclusion outcome — the unit stays `reviewerPath: false`. Neutralizing only
   the selector variable while leaving an ambient `REVIEW_COMMAND` fallback that
   still excludes does not satisfy this criterion. **The signal must carry a
   machine-checkable source, because provenance — not variable name — is the
   invariant.** If the chosen per-unit marker reuses a variable name that can
   also appear ambiently (e.g. `REVIEW_COMMAND`), presence/absence alone cannot
   tell a request-scoped review signal from the same-named ambient value. The
   predicate must therefore key on the signal's *source* (request-scoped review
   wrapper vs. ambient profile env vs. absent), and a fixture must be able to
   assert that an ambient-sourced value never maps to `reviewerPath: true` while
   a request-scoped-sourced marker can. The exact discriminator shape (a source
   field, a separate marker channel, etc.) is the planner's; the contract is that
   ambient-vs-request-scoped is *decidable by the predicate and assertable in a
   fixture*, not inferred from a redacted value. **The guard generalizes to
   whatever new marker is chosen — it must not merely move the bug.** A negative
   fixture MUST set the chosen marker **and** its source discriminator as
   *ambient standing operator/profile env* on an ordinary unit and prove it stays
   `reviewerPath: false`; only a tracked, non-ambient wrapper-derived channel
   (one an ordinary session cannot populate from its environment) may set it
   true. A fix that simply relocates the spoofable field from `PACK_REVIEWER` to
   a new env name (`REVIEW_MARKER`, `PACK_REVIEWER_SOURCE`, …) does **not**
   satisfy this criterion.
4. A fixture exists for **each applicable row** of the equivalence-class table,
   branched by the AC2 capture outcome: the regression row (configured machine +
   ordinary trigger-firing + no-delegation ⇒ not excluded **and** flagged), the
   code-class row (excluded via code-class regardless of reviewer logic), and
   the machine-config-toggle row hold in both worlds. The *actual review
   execution → excluded* rows are required only under **world (b)** (captured
   review-execution payload carrying the marker); under **world (a)** they are
   replaced by a single proof-of-absence fixture showing no review-execution
   unit reaches the audit and ordinary trigger-firing units are still not
   excluded. No synthetic constructed review session may stand in for a missing
   world-(b) capture. **Each fixture asserts the *decomposed* exclusion cause,
   not only the final `excludedFromDenominator`.** Because the exclusion is
   `reviewerPath` **OR** `codeClass`, a row that asserts only the OR'd result can
   pass while `reviewerPath` is still wrongly true (the code-class row would
   still be excluded). Every non-review row — the ordinary rows and the
   code-class row — must assert `reviewerPath: false` explicitly; the code-class
   row must be excluded **via the code-class cause with `reviewerPath: false`**,
   so a regression that re-contaminates the reviewer predicate fails a test even
   though the unit is still excluded overall.
5. **Detection parity:** a test fails if any row yields a different exclusion
   verdict on the Claude vs Cursor audit path. Parity covers **not only the
   exclusion verdict but the structured outputs** (AC6): the two surfaces must
   agree on **both** the per-window denominator cause (no-trigger / all-excluded
   / normal) **and** the review-hook capture branch (world-(a) no-review-hook /
   world-(b)) for the same input — otherwise one surface could report a degraded
   window while the other reports a clean zero residual, preserving the fail-loud
   gap on a single surface. **Parity must not rest on a single-surface capture
   replayed through both code paths.** A single real capture proves only the
   surface it came from; the shared fixture is accepted as covering both surfaces
   **only** with either a per-surface real capture **or** a mechanical proof that
   both installed surface hooks invoke the *same* tracked wrapper with equivalent
   normalized payload fields (the per-surface hook-wiring fingerprint of AC2). The
   latter is the expected route here — both surfaces invoke one PowerShell wrapper
   via `pwsh`, differing only in hook-event name — but it must be *proven*, not
   assumed, before the shared fixture stands in for both surfaces.
6. **Denominator-cause observability (branched by capture outcome):** the metric
   must let a consumer tell an empty denominator caused by exclusion apart from
   one caused by no trigger firing — an all-excluded window is reported as
   degraded/empty by cause, not as a clean zero residual. The cause MUST be
   carried as a **machine-checkable structured field over a closed set of cause
   values** — not as free-form prose or unstable log labels — so CI can assert on
   it deterministically. **Two orthogonal dimensions must be modelled separately,
   not crammed into one enum:** (i) the **per-window denominator cause**
   {no-trigger, all-excluded, normal} — a property of *this* metric window — and
   (ii) the **review-hook capture branch / capability** — a standing property of
   the review entrypoint, not of a window. Its **runtime** enum is three-state:
   {world-(a) no-review-hook, world-(b) hook-present, **unknown/degraded**} (the
   third for a missing/malformed/stale capability record per AC7, so the degraded
   state is schema-pinned and participates in Claude/Cursor parity — not an
   out-of-band error path). A **committed valid** capability record, by contrast,
   may carry only `world-(a)` or `world-(b)`. They are independent: a window can be `normal` for ordinary work
   while the review path is world-(a), or `no-trigger` while a world-(a) capture
   is on record. A single field cannot represent both without losing a dimension
   or inventing unstable precedence rules. **The per-window cause is computed over
   the trigger-firing delegable candidate population, not the whole-window record
   set** — the denominator is over trigger-firing delegable units, so a window in
   which *all trigger-firing candidates* were excluded must report
   exclusion-driven/`all-excluded` **even when ordinary non-trigger records are
   also present**. A mixed-window fixture (an excluded trigger-firing unit
   alongside an ordinary no-trigger unit) MUST still classify as exclusion-driven,
   not `normal` or `no-trigger` — otherwise a single no-trigger record masks the
   exact all-excluded failure this draft exists to surface. Each is a machine-checkable structured
   value a CI gate can match; the field names/shapes are the planner's, the
   contract is the two-dimension separation. This is provable at
   the **metric-summary level** with constructed verdict records (a verdict with
   `excludedFromDenominator: true` vs a no-trigger verdict) — that summary-level
   test holds in both worlds and is **not** a synthetic audit review session
   (AC2's prohibition is on feeding a hand-built review *session* through the
   audit to satisfy the review-execution branch, not on unit-testing the
   summarizer). Under **world (b)** additionally provide the all-excluded window
   from the real captured review-execution payloads; under **world (a)** provide
   denominator-cause coverage for the observable cases instead — a no-review-hook
   window and ordinary trigger-firing units not excluded — since no production
   all-reviewer-path-excluded window can occur.
7. **Missing-review-hook failure mode is pinned:** if the captured finding is
   world (a) — review executions emit no audit hook — that is recorded as the
   captured determination and the contract documents that the reviewer-path
   branch has no production unit to exclude; an absent/empty review-hook window
   is never silently treated as a clean zero residual or a satisfied carve-out.
   The review-hook capture-branch is a **standing property of the review
   entrypoint, not of a window** (AC6 dimension (ii)), and an ordinary live window
   has **no recurring input** to re-derive it from — this is true in **both**
   worlds (world (a): no review event exists in the stream; world (b): an ordinary
   window simply contains no review execution). The determination must therefore
   have a **single defined persistent runtime source** — one versioned
   captured-capability record the summarizer/gate **loads unconditionally** — so
   the standing capability is surfaced as the machine-readable capture-branch
   field on **every live** metric window in **both** worlds, not only in the
   fixture that first proved it. Special-casing persistence to world (a) leaves
   world (b)'s `hook-present` capability with no runtime source and is **not**
   sufficient. A fixture must show a live metric summary still carries the correct
   capture-branch value (world-a *or* world-b) after the capture step. A
   production consumer must be able to observe the review-hook state from the
   metric output, not infer it from the absence of records. **Missing/malformed
   record fails loud, never clean.** Because the capability record is now a
   required runtime input for every live summary and the audit is fail-open, a
   record that is absent, malformed, unreadable, stale, or hash-mismatched MUST
   surface a structured **`unknown`/degraded** capture-branch — never a silently
   omitted field or a clean-looking default that reads as `hook-present`/healthy.
   Negative tests cover the absent, malformed, and hash-mismatched record cases.
   **The record must not become static repo truth detached from the currently
   installed hook.** Its fingerprint proves the wiring *at capture time* only; a
   later stale/changed local hook registration could keep producing broken rows
   while the summarizer still surfaces the committed capability as healthy (a
   reviewer-false-approval path). The summary/adoption gate must therefore compare
   the **currently installed** hook fingerprint against the record's fingerprint —
   e.g. live audit rows self-report the wrapper fingerprint they were emitted
   under and the summarizer cross-checks it — and a mismatch or absence yields the
   `unknown`/degraded branch, not a trusted-healthy one. A negative test pins a
   valid record whose fingerprint no longer matches the installed hook.
8. **Captured fixtures are scrubbed and minimal.** Any artifact captured from
   the real review/session path **and committed anywhere in the repo** — fixtures
   **and** the persisted capability/provenance record (AC7), regardless of its
   path — is reduced to the minimal schema the audit actually consumes (aggregate read volume /
   trigger inputs, the review-marker presence/absence, surface, work-unit key,
   and the env keys the predicate reads) with **values** redacted — no raw env
   values, no secrets/tokens, no absolute operator-home paths, no full command
   strings beyond what a row asserts. **Scrubbing redacts values but must not
   strip the AC2 provenance metadata** — the entrypoint identity, hook-wired
   evidence (the normalized hook-wiring fingerprint), exit status,
   positive-control key, code-revision hashes, and derivation link survive as
   redacted-but-present fields, so the capture stays mechanically attestable
   after minimization. The provenance metadata is the **normalized** form (AC2):
   repo-relative identities, hashes, and redacted-prefix command *shapes* — these
   are explicitly *not* the forbidden raw values, so AC8's redaction and AC2's
   attestation do not conflict. A mechanical check asserts the committed fixtures contain
   none of the forbidden raw values (the enforceable form of #255's "no new repo
   secret" invariant, made a criterion rather than prose) **and** that the
   review-branch fixtures carry the provenance metadata AC2 requires. The check is
   keyed on artifact **kind/content (any committed capture/provenance/capability
   record), not on the `scripts/fixtures/` path** — a capability record placed
   elsewhere is covered identically, so forbidden raw values cannot escape the
   scrub by living outside the fixtures tree.
9. The code-class carve-out, threshold numbers, work-unit boundary,
   machine-observed-delegation rule, and fail-open/idempotency behaviour from
   #255 are unchanged (no regression in their existing fixtures).
10. **Pre-fix poisoned state is handled deterministically.** The live append-only
    artifact already holds rows written by the broken predicate (all
    `reviewerPath: true`) and lacking the new structured fields
    (capture-branch, source discriminator, per-unit cause). Emitted records carry
    an **audit schema / predicate version** stamp, and the summarizer handles a
    mixed old/new JSONL deterministically — pre-fix rows are quarantined/ignored
    (or recomputed), never allowed to keep a window degraded, distort the residual
    rate, or mask the fix, and a new-schema window is never falsely failed by
    legacy rows. A fixture over a JSONL containing **both** pre-fix and post-fix
    records pins this behaviour.
11. **Undecidable-marker middle state is pinned, not parked.** A review
    stop-hook event that *does* reach the audit but whose per-unit review
    marker/source is **absent or undecidable** (the ambiguous middle state
    between world (a) and world (b)) MUST classify to the `unknown`/degraded
    capture-branch (AC7) — it must **not** silently fall into world-(a)
    no-review-hook, nor into ordinary denominator behaviour, nor be excluded as
    reviewer-path. A required fixture pins this exact case on **both** surfaces;
    the listed ACs are not satisfiable without it.

```positive-outcome
asserts: on a captured stop-hook payload from an ordinary session on a machine with the reviewer-selection variable set, where aggregate reads fired the trigger and no delegation/edit/excepted-reason is present, the audit emits a verdict with reviewerPath=false, inDenominator=true, flagged=true, with the same verdict on both the Claude and the Cursor path. Under world (b) only, a sibling unit captured from a real review execution is additionally excluded as reviewer-path; under world (a) no such unit reaches the audit and this clause is vacuous.
input: external-tool-output
provenance: capture-backed
```

## Upgrade-safety check

- No AO core, vendor, or `agent-orchestrator.yaml` schema change.
- No new repo secret. The audit handler still reads only the local hook payload
  and sends file contents nowhere. **Any captured artifact committed to the repo
  — fixtures and the persisted capability/provenance record alike — is scrubbed
  to the minimal consumed schema with values redacted (AC8) and a mechanical
  check enforces it by artifact kind, not by path** — raw env values, secrets,
  operator-home absolute paths, and full command strings must not land anywhere
  in the repo, `scripts/fixtures/` or otherwise.
- The audit remains fail-open (a handler error never wedges a turn) AND
  fail-loud (an all-excluded or errored window is reported degraded, never as a
  clean zero residual).
- The change narrows an over-broad exclusion; it cannot cause a previously
  excluded **real** review execution to be flagged (criterion 2 pins that).

## Verification

1. Run the equivalence-class fixture suite; every row yields its tabled
   exclusion verdict, including the regression and code-class rows.
2. Detection-parity check: identical exclusion verdict on both surfaces per row.
3. Machine-global-vs-per-unit check: a fixture that flips only the ambient
   reviewer-selection variable leaves the exclusion verdict unchanged.
4. **Capture step (resolves the satisfiability gap):** run the real review
   entrypoint under the installed stop hook against a **disposable / no-publish
   target** (throwaway fixture PR/issue or dry-run mode, asserting no external
   mutation) and capture whether it emits an audit Stop/stop event and, if so,
   whether the chosen per-unit marker is present in the payload the audit
   receives. Check the capture in as the artifact backing AC2; the review-branch
   fixtures derive from it. If world (a), record the no-hook finding and rely on
   the defensive per-unit branch.
5. Denominator-cause check: an all-excluded window is emitted as degraded/empty
   by cause, distinguishable from a no-trigger window; an absent review-hook
   window is likewise not reported as a clean zero residual. The per-window cause
   and the review-hook capture-branch are emitted as **two separate** structured
   fields (AC6), and both match across the Claude and Cursor surfaces.
   **Both worlds:** a test loads the single persisted capability record and
   confirms a **live** metric summary surfaces the correct capture-branch field
   (world-a `no-review-hook` *or* world-b `hook-present`) on an ordinary window
   that contains no review execution — not just the one-time fixture — so the
   standing capability does not evaporate after capture in either world.
6. Live re-check: after merge, drive a **fresh no-side-effect ordinary session
   through the installed hook on each surface** (Claude and Cursor) — **not** a
   re-run of a completed, side-effecting work unit, and **not** a payload replay
   (which bypasses the installed wiring and cannot prove adoption) — and confirm
   `~/.orchestrator-pack/read-delegation-audit.jsonl` shows an ordinary
   trigger-firing unit with `inDenominator: true` rather than
   `reviewerPath: true`.
7. Regression: the #255 fixtures for code-class, thresholds, work-unit boundary,
   machine-observed delegation, fail-open, and concurrency still pass unchanged.
8. Mixed-schema check: a JSONL containing both pre-fix (broken-predicate,
   missing-field) and post-fix records summarizes deterministically — legacy rows
   are quarantined/ignored or recomputed, and neither mask the fix nor falsely
   fail a post-fix window (AC10).

## Open questions / residual risks

- **Hook-fired-but-marker-undecidable edge — resolved.** Promoted from an open
  question to a required acceptance criterion (**AC11**) after the architect
  Codex review flagged it (P2): the undecidable middle state must classify to
  `unknown`/degraded with a fixture on both surfaces.
- **Final-pass edits reviewed.** The three pass-10 fixes (3-state runtime
  capture-branch enum, capability-record freshness-vs-installed-hook check,
  sanitized-env-allowlist credential boundary) were folded after the last GPT
  pass; the normal architect `codex review` has since run over the full draft and
  returned only the AC11 finding above (now folded). See the adversarial-review
  log below.

## Adversarial review log (GPT)

GPT loop: 10 passes; stopped because cap-10 (not zero-accept convergence);
last-pass accepted=3; final STATE=completed_valid VALIDATION=ok
pass=d800f752-8f0b-4af3-b5ad-5b5ea818fbf5
sha=ce701c38b45513a234c8e3f187f80db0990a9d4680667027154a371c6076c084.
**Post-GPT change not re-reviewed:** the pass-10 findings were folded after that
SHA, so the current draft is not GPT-covered at its head — deferred to the
architect `codex review`. Raw per-pass artifacts under
`~/.local/state/discuss-with-gpt/86-read-delegation-reviewer-carveout-per-session/`.
Every pass was `VALIDATION=ok` except one transient ChatGPT product error
(`echo-missing`) that was retried to a valid pass. ~30 findings folded
(accept/partial), 2 rejected (POSIX-wrapper false-positive, `GitHub Issue: TBD`
placeholder), and the recurring "split the issue" recommendation was
considered-and-declined (shared capture dependency).
