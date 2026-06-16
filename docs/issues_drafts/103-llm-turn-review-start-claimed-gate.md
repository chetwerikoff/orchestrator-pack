# LLM-orchestrator review-start must pass the same claim + coverage gate as the script starters

GitHub Issue: #318

## Prerequisite

- `docs/issues_drafts/88-review-start-atomic-claim.md` (GitHub **#267**, merged) —
  shipped the per-`(PR, head)` claim store: every **automated script** starter
  (periodic reconcile, wake-listener, deferred-head reeval) acquires the claim
  *before* `ao review run`, held until a covering run record is visible or a
  terminal failure. This draft **re-uses** that claim store, key derivation, and
  acquire-before-run ordering; it does **not** re-implement them. It adds the
  **LLM-orchestrator turn** as a fourth starter that must hold the same claim.
- `docs/issues_drafts/100-review-start-claim-atomic-single-winner.md`
  (GitHub **#308**, open) — hardens #267's claim to a true atomic single-winner
  across concurrent automated starters, and scopes itself explicitly to the three
  script surfaces (it leaves non-script `ao review run` "unclaimed by design").
  This draft is the **companion that brings the LLM-turn path under that same
  claim** — #308 makes the claim atomic; this draft makes the LLM path actually
  take it. **Sequencing (hard):** this draft adds a *fourth* concurrent starter to
  the claim, so the LLM-turn gate MUST NOT be enabled until #308's atomic
  single-winner claim has landed — wiring the LLM path into the pre-#308
  non-atomic claim would add race surface (the very duplicate-start class this
  draft targets). The narrow reported bug (the LLM path taking **no** claim at
  all) is fixable on merged #267 alone; the concurrent-starter atomicity guarantee
  this draft asserts requires #308 first.
- `docs/issues_drafts/91-review-run-crash-safe-terminal-status.md`
  (GitHub **#287**, merged) — crash-safe terminal status + claim release on a
  reaper-detected dead run. **Re-used:** the LLM-turn claim obeys the same
  release-on-terminal lifecycle; a dead LLM-started run must not leave a stuck
  `active` claim.
- `docs/issues_drafts/65-orchestrator-no-rereview-covered-head.md`
  (GitHub **#189**, merged) — defined the covered-head predicate
  (`clean` / `needs_triage` / `waiting_update` + in-flight = covered) and asked
  the LLM loop to obey it **via prose** in `orchestratorRules`. This draft does
  **not** change the predicate; it moves enforcement of that predicate on the LLM
  path from prose-the-model-may-ignore to a **mechanical, fail-closed** gate.
- `docs/issues_drafts/70-orchestrator-event-driven-review-trigger.md`
  (GitHub **#207**, merged) — the wake-listener that, on a clean review, forwards
  the `merge.ready` completion wake to the orchestrator. That forward is the event
  that fans into the LLM turn this draft constrains; the listener itself is
  unchanged.
- `docs/issues_drafts/95-orchestrator-message-egress-registry.md`
  (GitHub **#298**, open) — message catalog/audit. **Relation, not dependency:**
  the wake-listener→orchestrator `merge.ready`→re-review collision this draft
  closes is exactly the kind of cross-path overlap #298 should *catalogue*; this
  draft *prevents* it. No ordering dependency between the two.

## Goal

Stop the LLM-orchestrator turn from launching a review run on a commit that is
already covered by an in-flight or covered-terminal review run. Today three
mechanical starters acquire a per-`(PR, head)` claim and apply the covered-head
predicate before starting; the LLM-orchestrator turn (report-driven trigger and
the `merge.ready`-wake handling path) invokes `ao review run` **directly**,
acquiring no claim and bound only by the prose `REVIEW RUN IDEMPOTENCY` rule —
which a non-deterministic model can read and still disregard. The outcome must
be: the LLM-turn review-start path acquires and honors the **same** claim and the
**same** covered-head predicate as the script starters, and the enforcement is
**mechanical and fail-closed** — the orchestrator cannot bypass it by issuing a
bare or reworded `ao review run`.

```behavior-kind
action-producing
```

## Binding surface

This issue commits the repository to the following contracts.

- **Every autonomous review-start holds the claim — the boundary is
  autonomous-vs-manual, not "which caller".** The gate binds **all** pack-controlled
  autonomous (non-human-operator) review-starts: the LLM-orchestrator turn itself
  **and** any start it causally initiates by delegating to a worker, task helper, or
  pack function. Provenance is not classified caller-by-caller ("orchestrator turn"
  vs "worker" vs "script"); the single carve-out is a deliberate **manual human
  operator** start. Before any such autonomous run is launched, the same
  `(PR, normalized head SHA)` claim used by the script starters (#267/#308) is
  acquired and the covered-head predicate (#189) is applied. A head that is covered
  (in-flight, `clean`, `needs_triage`, or `waiting_update`) yields **no** new run; a
  claim already held by another starter makes the autonomous path lose
  deterministically and launch nothing. A worker-originated start that is *not*
  attributable to a manual operator must not be classifiable as exempt — it is
  autonomous and gated.
- **A single claimed choke point — the autonomous surface has no path to a raw
  run.** Enforcement must hold **above** shell command-string parsing, not by
  pattern-matching one spelling of `ao review run`. The contract: all autonomous
  orchestrator review-starts traverse **one** claimed entry point that performs the
  claim+coverage gate; the autonomous orchestrator runtime has **no** available
  path to launch a raw, ungated review run. This covers **every** review-start
  capability exposed to the LLM runtime, not only shell command strings: shell
  invocation variants (aliases, wrapper scripts, relative/absolute binary paths,
  `ao.cmd`/PowerShell/WSL forms, reworded commands on Ubuntu/WSL or Windows) **and**
  any non-shell surface (structured tool / internal API / MCP-or-action adapter /
  task helper / pack function). The set of autonomous review-start capabilities must
  be **enumerated**, and each one either routed through the claimed entry point or
  made unavailable to the autonomous surface. The planner picks the concrete
  mechanism (claimed entry point, runtime permission boundary, or equivalent); the
  binding requirement is that **no autonomous capability of any form reaches the
  ungated verb**. **Preferred form:** deny the raw verb at the **process/execution
  boundary** so that *no* autonomous child process — including a generated wrapper,
  `npm`/`make`/task script, or PATH-injected helper created *after* preflight — can
  reach `ao review run`; the autonomous surface is exposed only the single claimed
  start capability. A static enumerated inventory + finite bypass fixture is the
  **fallback** only where such boundary denial is not achievable, and is weaker
  because a dynamically generated transitive path can evade it. Prose in `orchestratorRules` may remain as guidance
  but is no longer the only thing standing between an orchestrator turn and a
  duplicate run.
- **Covered-abort leaves no residue.** When the gate aborts because the head is
  covered (or because another starter holds the claim), it leaves **no** `active`
  claim attributable to this turn and **no** spurious review-run or terminal
  record — regardless of whether coverage is detected before or after a claim
  attempt. Acquiring then discovering coverage must release cleanly.
- **Manual operator starts are unchanged.** A human operator's review start stays
  outside this gate (consistent with #267's "manual runs unclaimed by design").
  The constraint binds the **autonomous orchestrator turn**, not a deliberate human
  start. There must be a defined, testable provenance boundary between the
  autonomous surface and a manual operator start; the boundary must fail closed
  against a missing or spoofed marker (an unattributable autonomous-runtime start
  is gated, not waved through), while a genuine manual operator start outside the
  autonomous runtime is not blocked. A manual start aimed at an **already-covered**
  head, **when issued through a pack-provided manual review-start entry point**, is
  still allowed but emits an audit/warning (with manual provenance) so an operator
  under outage pressure does not silently reproduce the duplicate-start class
  believing the gate protects all starts — manual override is visible, not blocked.
  That warning also consults **active claim / launch-attempt** state for the same
  PR/head (not only visible run-state coverage), so a manual start during the
  spawn-to-visible window — where an autonomous review is pending with no visible
  run yet — is still warned. (The claim is consulted for the manual *advisory* only;
  it is still **never** treated as coverage for an autonomous gate decision, per the
  run-state-derived rule above.) A **fully raw** human `ao review run` invoked
  outside any pack surface is, by construction, not observable without modifying AO
  core / the verb (out of scope) — that is an **accepted residual** for a deliberate
  human action; the warning binds only the pack-provided manual path, not the raw
  verb.
- **Failed / cancelled on the current head is not covered, and serial re-tries obey
  the existing turn-persistent discipline.** A `failed` or `cancelled` run on the
  current head does not count as covered (never treat `findingCount: 0` on a failed
  run as clean). The claim only prevents *concurrent* starts — not *serial* re-tries
  across successive orchestrator turns — so the LLM path must run failed/cancelled
  re-tries through the **existing** diagnose-then-retry-once discipline (#60/#98,
  claim-arbitrated per #267), reading `terminationReason` from durable per-head run
  state the same way every surface does. Because that bound derives from run state,
  not per-turn memory, the high-frequency LLM turn must reach the same outcome the
  script starters would (one diagnosed retry, then escalate) — never a looser one
  that loops. This draft re-uses that discipline; it does not redefine the retry bound.
- **Claim lifecycle is shared, including the spawn-to-visible handoff window.** An
  LLM-started run that reaches any terminal outcome — including a reaper-detected
  dead run (#287) — releases or terminalizes its claim; it must not linger `active`
  and block a later legitimate start on the same key. The dangerous window where the
  gate has acquired the claim and spawned the run but the covering run record is
  **not yet visible/associated** in `ao review list` must be handled by a durable
  launch-attempt / owner handoff (e.g. a recorded run-id or child linkage) before or
  at spawn — so a reaper distinguishes "spawned, run pending visibility" (do **not**
  release — releasing would let a later turn launch a duplicate while the review is
  actually running) from "orphaned, no run" (release). Neither a stuck-forever claim
  nor a premature release is acceptable. The "run pending visibility, do not
  release" state must itself be bounded: a child-exit signal or a timeout/heartbeat
  rule converts a pending-visibility launch-attempt that produced no visible run
  into a releasable no-run orphan — so a dead child before the run becomes visible
  cannot block all future legitimate reviews on that PR/head indefinitely, and the
  conversion evidence cannot mistake a still-running review for an orphan.

This is a record-and-act change to an existing autonomous review-start path. It
introduces an operator-facing surface (orchestrator wiring / runtime gating), so:

- **Operator adoption.** After the implementing PR merges, the operator must adopt
  the new orchestrator-side gating: merge any new `orchestratorRules` /
  `agent-orchestrator.yaml.example` changes into the live (gitignored)
  `agent-orchestrator.yaml`, apply any orchestrator-runtime gating configuration
  the PR documents, and restart the orchestrator (`ao stop` / `ao start`) so the
  new gate is in effect. Confirming the gate is live must be a **probe from the
  real autonomous orchestrator runtime** — demonstrating an autonomous covered-head
  start is actually *denied by the gate* after restart — not merely that the
  capability/version marker exists (a marker proves config loaded, not that the
  live autonomous path routes through the choke point). The probe must be
  **side-effect-safe**: it runs against a disposable/sentinel PR+head or a controlled
  launch sink, so that if routing is wrong and the raw verb is reached it cannot
  mutate real production review state (the probe must not be able to create the very
  duplicate it is meant to detect). The PR's verification section must state the
  exact adoption steps, this side-effect-safe live denial probe, and a safe rollback if the preflight refuses after a misapplied change. **Safe rollback never
  restores a permissive ungated autonomous path** — it either disables autonomous
  review-starts (fail-closed, the same refusal state) or reverts the whole feature
  cleanly; an operator under outage pressure must not be able to restore service by
  reopening the duplicate-start path this draft closes.

## Files in scope

- The shared review-start claim helper / coverage predicate already introduced by
  #267/#308 (extended so the orchestrator-turn surface is one of its callers).
- The orchestrator-turn review-start path — `orchestratorRules` in
  `agent-orchestrator.yaml.example` and the canonical worker rules
  (`prompts/agent_rules.md`) — and whatever pack-controlled runtime gating makes
  the enforcement mechanical (e.g. a permission/command gate on the orchestrator
  runtime, or a single claimed entry point the orchestrator is constrained to).
- Tests / fixtures for the scenario matrix below.

## Files out of scope

- The wake-listener (#207) and the three script starters' own trigger logic — they
  already claim correctly; this draft does not change how they start.
- Upstream AO internals — the `ao review run` verb itself
  (`vendor/**`, `packages/core/**`).
- The covered-head **predicate definition** (#189) — re-used verbatim, not
  redefined.
- The atomic single-winner mechanics of the claim (#308) — re-used, not
  re-specified here.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

## Acceptance criteria

- An orchestrator turn that evaluates a PR head **already covered** by an
  in-flight or covered-terminal (`clean` / `needs_triage` / `waiting_update`) run
  launches **no** new review run — the start is aborted at the gate, not left to
  prose compliance.

  ```positive-outcome
  asserts: orchestrator-turn review-start on an uncovered, review-ready head acquires the (PR, head) claim and launches exactly one review run
  input: realistic
  ```

  ```positive-outcome
  asserts: orchestrator-turn review-start on a head whose latest run on that PR+head is clean (covered terminal) launches no review run, given the real ao review list shape
  input: external-tool-output
  provenance: capture-backed
  ```

- No autonomous orchestrator execution form reaches an ungated review run on a
  covered head — the bypass is prevented mechanically (fail-closed), demonstrated
  without relying on the model choosing to obey prose. The bypass fixture
  enumerates execution forms, not one string: at minimum a reworded/aliased
  command, a wrapper script, a relative and an absolute binary path, and the
  platform invocation variants the pack runs under (`ao` vs `ao.cmd`, a PowerShell
  invocation, a WSL-path invocation) — each must end in no launched run on a
  covered head.
- The provenance boundary between the autonomous surface and a manual operator is
  tested both ways: a start whose autonomous-surface marker is **missing or
  spoofed** is gated fail-closed (not waved through as "manual"), and a genuine
  manual operator start outside the autonomous runtime is **not** blocked.
- A covered-abort (head covered, or claim held by another starter) leaves no
  `active` claim attributable to the turn and no spurious review-run or terminal
  record — asserted for both before-claim and after-claim coverage detection.
- When the claim for a `(PR, head)` is already held by another starter
  (reconcile / wake-listener / reeval), an orchestrator turn contending for the
  same key launches nothing and aborts deterministically — the existing
  single-winner guarantee (#308) holds with the orchestrator turn as a contender.
- A `failed` or `cancelled` run on the current head is treated as **not covered**:
  the orchestrator turn may start exactly one retry through the claimed gate, and
  a `failed` run with `findingCount: 0` is never treated as `clean`.
- An orchestrator-started run that terminates (including reaper-detected dead,
  #287) releases/terminalizes its claim; a subsequent legitimate start on the same
  key is not blocked by a stale `active` claim.
- When the orchestrator-side gate configuration is **absent or stale**, the
  autonomous runtime **refuses** to start reviews — a startup/preflight fail-closed
  default — rather than silently continuing on the old ungated path while the repo
  appears fixed. "Stale" is decided against a concrete **gate capability / config
  version marker** (a digest or version the implementation emits and the preflight
  verifies), not mere presence of *some* config — so a still-permissive older live
  runtime gate is detected, not accepted. The same preflight verifies the
  **atomic-single-winner claim capability (#308) is actually present** in the
  shipped claim helper before enabling the LLM gate — so the hard sequencing
  (#308 first) is checked mechanically at startup, not left to prose. Because the
  live `agent-orchestrator.yaml` and runtime wiring are **gitignored**, the
  repo-tracked capability inventory + CI drift check are not sufficient on their
  own: the preflight must emit and validate the capability table **as actually
  loaded by the live runtime** (including gitignored config, adapters, helper
  wiring, profile-specific tools) and refuse autonomous review-starts if any live
  capability is unclassified or not routed through the gate. A preflight
  refusal is **operator-visible** with a reason that distinguishes "autonomous
  review-starts paused by gate preflight" from an unrelated startup failure, so a
  misapplied config does not look like a generic outage.
- **Stale / multiple autonomous runtimes do not keep the raw path alive.** A single
  stale or unmanaged autonomous review-start runtime for the same repo/config (an
  old WSL/Windows session, a detached terminal, a scheduled listener, a stale
  profile) is enough to duplicate a review after the restarted runtime passes its
  probe. The gate must either detect and refuse when such a stale autonomous runtime
  is still active for the repo, or be scoped so that a stale runtime cannot launch
  even if left running (the single-owner supervised-process model, #205, is the
  reference). Passing the live probe on one restarted runtime is not sufficient on
  its own.
- **Fixed gate ordering — fresh head, then claim, then re-read coverage under the
  claim.** Because the LLM turn is driven by an event that may be stale (a
  `merge.ready` wake or a report captured before the head advanced), the gate MUST,
  in order: (1) resolve PR + normalized **current** head from authoritative PR state
  at gate time (re-using #189's pre-run head re-check) — never trust the wake/report
  head as the key; if authoritative PR state cannot be resolved (API outage, deleted
  branch, closed-PR metadata race, ambiguous lookup), the gate **fails closed** —
  no claim is taken when no key exists, no run is launched, and an operator-visible
  refusal/audit reason is recorded; it must **never** fall back to the stale
  wake/report head; (2) confirm the PR is still **review-ready** at gate time by
  re-using the script starters' authoritative eligibility check (#195 HEAD READY FOR
  REVIEW: PR open, not draft, CI contract) — a stale wake/report for a PR since
  merged/closed/converted-to-draft yields no claim and no run; (3) acquire-or-lose
  the `(PR, current head)` claim (#267/#308); (4) **re-read** current-head run-state
  coverage **under the held claim** immediately before launch (#189 pre-run coverage
  re-check / #267 recheck-before-launch fence) and abort if it became covered;
  (5) launch exactly one run or abort with an audit record. Step 4 closes the
  interleave where another starter terminalizes a clean run between the LLM's first
  read and its launch; step 1 closes the stale-event-head class; step 2 closes the
  stale-wake-on-a-no-longer-reviewable-PR class.
- **Fail-closed refusals preserve liveness — no dropped reviews.** A refusal caused
  by a *transient* condition (head-resolution outage, temporary preflight mismatch,
  unknown-row read error) must not permanently drop the review: the PR/head is
  either retried with bounded backoff or left to be picked up by the existing
  periodic reconciler (#163) once the transient condition clears. The fix must not
  trade a duplicate-start failure for a silently-dropped-review failure; eventual
  review after recovery is required.
- **Every gate denial is auditable, with two distinct record shapes.** A **per-start
  denial** (head covered, or claim lost) writes a durable audit record carrying PR,
  normalized head SHA, starter provenance, denial reason, and claim outcome. A
  **preflight refusal** (gate config absent/stale/`#308` capability missing) — which
  happens before any specific PR/head/claim exists — writes a *separate* record
  shape carrying the refusal reason and marker state, with **no** PR/head/claim
  fields (no fabricated values). Neither record is a review-run or terminal-run
  record — no phantom run is invented; the no-spurious-record invariant above holds.
  So "why did this PR not get a fresh review" is an audit lookup, not a guess.
- **Canonical cross-platform identity.** The claim/owner state namespace and the
  coverage key must resolve to the **same** identity across Windows, WSL,
  PowerShell, and Ubuntu invocations for the same GitHub PR/head — canonical GitHub
  repo identity + normalized worktree identity + one shared claim-store namespace.
  Two runtimes that see `C:\…` vs `/mnt/c/…` must not pass single-owner/preflight
  against *different* state namespaces and then both launch for the same PR/head.
- **Denial audit is bounded.** Repeated denials on a covered head under repeated
  `merge.ready` wakes / successive LLM turns are **coalesced/retained** keyed by
  repo/PR/head/provenance/reason (preserve first/last/count) rather than appending
  an unbounded record stream — so the audit trail does not bloat state or
  context-budget under a high-frequency loop.
- **Audit records carry no secrets.** Starter provenance is a bounded non-secret
  identifier (e.g. a surface enum / opaque id), not a free-form payload. Audit and
  probe records MUST NOT persist environment values, tokens, auth headers, raw
  orchestrator prompt/context, or full shell command lines — the autonomous-runtime
  boundary must not become a durable leak surface. The **live capability table**
  emitted at preflight is held to the same bound: it records bounded non-secret
  classifications only and MUST NOT persist raw gitignored config, absolute paths,
  command templates, environment-derived fields, adapter auth material, prompts, or
  tokens.
- **Unknown / malformed / ambiguous run-list rows are fail-closed.** When the
  current-head key's `ao review list` rows cannot be confidently classified —
  schema drift, a status not in the known set, a missing/malformed head SHA, or
  ambiguous duplicate latest-run rows with no deterministic tie-break — the gate
  treats the head as **unknown, not "not covered"**: it does not start a run, and
  records an operator-visible refusal (read-error=unknown, per the #235 principle).
  A parser must never start a duplicate precisely when it should pause for
  attention. Likewise, if **any** confidently-matched current-head row is in-flight
  (`running`/`reviewing`) — even when it is not the latest row in a duplicate/
  malformed history — the head is covered and the gate aborts; in-flight precedence
  is not overridden by a later terminal row.
- **Coverage is derived from run state, not from the claim record.** Whether a head
  is covered is decided by the re-used #189 predicate over the latest review run for
  the **current-head key** (PR + normalized current head SHA) in `ao review list`;
  the existence or terminal-state of a *claim* record is a concurrency/lifecycle
  signal only and is **never** itself treated as coverage. The gate must select the
  authoritative row by filtering on PR + normalized current head SHA and applying
  #189's existing latest-run/tie-break rule (re-used, not redefined) — so stale rows
  on a superseded head do not gate the current-head key, and a current-head
  `failed`/`cancelled` row is not masked by an older `clean` row on a prior head.
- **Scenario matrix (exhaustive fixtures).** For starter = **LLM-orchestrator
  turn**, the row axis is the status of the latest run on the **current-head key**;
  the column axis is the claim window. ("Head advanced" is not a current-head
  status — it is the *absent* row for the new key, covered by the mixed-row fixture
  below.)

  | latest run on current-head key | claim free | claim held by other starter | prior claim record terminal (from a completed run) |
  |---|---|---|---|
  | none for current head (incl. only stale rows on a superseded head) | start (acquire → run) | abort (lose race) | start (acquire → run) |
  | in-flight (`running`/`reviewing`) | abort (covered) | abort | abort (covered) |
  | `clean` | **abort (covered)** ← the 354→355 cell | abort | **abort (covered)** ← exact reproduced cell (354's claim terminal + run clean) |
  | `needs_triage` | abort (covered) | abort | abort (covered) |
  | `waiting_update` | abort (covered) | abort | abort (covered) |
  | `failed` (current head) | start one retry (per #60/#98 bound) | abort | start one retry (per #60/#98 bound) |
  | `cancelled` (current head) | start one retry (per #60/#98 bound) | abort | start one retry (per #60/#98 bound) |

  Plus two cross-cutting fixtures the cells above do not capture on their own:
  - **Mixed-row** (H1/H2): `ao review list` carries a `clean`/`outdated` row on a
    *superseded* head alongside an **absent** current-head key → the gate starts a
    run for the current-head key only, and does not abort on the stale row.
  - **Repeated turns** (#60/#98 serial bound): two or more successive LLM turns
    arrive on the same `failed`/`cancelled` current head → exactly one diagnosed
    retry starts, then the existing discipline escalates / starts no further run —
    proving the high-frequency LLM turn does not become a retry loop.

  Closed-sibling no-regression cross-check: #267 (script×script claim), #308
  (atomic single-winner), #189 (in-flight-only prose), #235 (late ready after
  early wake) must stay green.

## Upgrade-safety check

- No edits to AO core or `vendor/**`; the `ao review run` verb is not modified —
  the gate lives in pack-controlled wiring/runtime around it.
- No unsupported `agent-orchestrator.yaml` schema (AO 0.9.x): a silently-ignored
  YAML block is not an acceptable enforcement surface; the gate must demonstrably
  take effect.
- No new repo secrets, and no secret/credential/env/prompt material persisted in
  audit or probe records (bounded non-secret provenance only).
- The covered-head predicate (#189) and the claim store contract (#267/#308) are
  re-used, not forked — no second definition of "covered" or a second claim store.
- The claim store and the durable launch-attempt / owner handoff persist in the
  **existing #267 claim-store namespace** (the operator/runtime state directory),
  **not** in `.ao/**` and **not** committed to the repo — so the `.ao/**` denylist
  entry does not conflict with hardening this state. The capability inventory is a
  repo-tracked source artifact; runtime claim/handoff records are not.

## Verification

- A fixture drives the orchestrator-turn review-start path with each cell of the
  scenario matrix above and asserts launch-vs-abort per cell. Covering-run state is
  supplied from a **captured / capture-derived** real `ao review list --json` shape
  for **every** status in the matrix — not only `clean` — with the field-shape
  edge cases that flip the verdict exercised explicitly: a `failed` run carrying
  `findingCount: 0`, and a superseded-head `outdated` row. The two `positive-outcome`
  assertions are covered 1:1.
- A **mixed-row** fixture: `ao review list --json` returns a stale `clean`/`outdated`
  row on a superseded head alongside an absent current-head key; the gate starts a
  run for the current-head key and does not abort on the stale row — proving the
  row-selection filters on PR + normalized current head before applying the #189
  predicate.
- A **repeated-turn** fixture: two or more successive LLM turns on the same
  `failed`/`cancelled` current head yield exactly one diagnosed retry, then the
  #60/#98 discipline escalates / starts no further run — proving the bound is
  derived from durable run state, not per-turn memory.
- A fixture (or static capability check) demonstrates the fail-closed bypass guard
  across **all** autonomous review-start capabilities, not only shell strings:
  shell execution forms (reworded/aliased, wrapper script, relative and absolute
  binary path, `ao`/`ao.cmd`/PowerShell/WSL-path variants) **and** any non-shell
  surface (structured tool / internal API / adapter / pack function) exposed to the
  runtime. Each is either shown to route through the claimed entry point or proven
  unavailable to the autonomous surface — aimed at a covered head, none ends in a
  launched run, without the test depending on prose being obeyed.
- The autonomous review-start **capability inventory** is a versioned repo-tracked
  artifact, and a CI/static check fails when a new review-start surface (pack
  helper, tool, adapter, prompt function, command) appears without an explicit
  `gated` / `unavailable` classification — so the bypass cannot silently reopen as
  the runtime grows.
- A **gate-time head-resolution-failure** fixture: authoritative PR state is
  unavailable/ambiguous (outage, deleted branch, closed-PR race); the gate takes no
  claim, launches no run, records an operator-visible refusal, and never falls back
  to the stale event head.
- A **stale-wake-non-reviewable-PR** fixture: a wake/report arrives for a PR since
  merged/closed/converted-to-draft; the #195 eligibility step yields no claim and no
  run.
- A **spawn-to-visible crash** fixture: the gate acquires the claim and spawns the
  run, then crashes before the covering run record is visible; the reaper treats the
  launch-attempt/owner handoff as "run pending" (does not release into a duplicate)
  versus a genuine no-run orphan (releases) — proven both ways.
- A fixture exercises the provenance boundary both ways: a missing/spoofed
  autonomous-surface marker is gated fail-closed, and a genuine manual operator
  start outside the autonomous runtime is not blocked (negative control). A manual
  start on an already-covered head **through the pack-provided manual entry point**
  is allowed but emits the audit/warning with manual provenance (a fully raw
  out-of-pack `ao review run` is the accepted, unobservable residual).
- A fixture demonstrates the preflight fail-closed default keyed on the
  capability/version marker: with the marker absent or mismatched (a still-permissive
  older live gate), the autonomous runtime refuses to start reviews and emits the
  operator-visible "paused by gate preflight" reason (distinct from a generic
  startup failure).
- A fixture demonstrates claim release on an orchestrator-started run that
  terminates (incl. reaper-detected dead), and that a later legitimate start
  succeeds.
- A **crash/resume** fixture for the window where the LLM turn acquires a claim,
  detects coverage, and crashes **before** the covered-abort cleanup completes —
  no review run was ever started: the reaper/resume logic releases (or
  terminalizes) the orphaned claim without inventing a phantom run record, and a
  later legitimate start on the same key is not blocked.
- Two separate audit fixtures matching the two record shapes: (a) a **per-start
  denial** (covered / claim lost) record carries PR, normalized head, starter
  provenance, reason, and claim outcome; (b) a **preflight-refusal** record carries
  the refusal reason and marker state with **no** PR/head/claim fields (no fabricated
  values). Both are distinguishable from a review-run/terminal-run record (no
  phantom run created).
- A **live denial probe** is documented and exercised: from the real autonomous
  orchestrator runtime after restart, an autonomous covered-head start is denied by
  the gate (proving the live path is routed through the choke point, not just that
  a marker is present). A **probe-isolation** assertion proves the probe cannot
  mutate production state even if routing is wrong: the sentinel PR/head cannot
  collide with a real PR and the launch sink cannot write real run / claim / GitHub
  Issue state — asserted over the real state stores before and after the probe (only
  bounded probe records may appear). The probe must also assert it reached the
  **covered-head per-start denial** — the denial reason and audit shape prove the
  claim+coverage gate denied it — not merely that "no run" happened (which an early
  head-resolution/preflight fail-closed path could produce without exercising the
  choke point).
- A **delegated-start** fixture: an autonomous review start the LLM turn initiates
  by **delegating** to a worker / task helper / pack function (not a direct
  top-level `ao review run`) is gated the same as a direct turn start — it is not
  classifiable as exempt, and on a covered head launches no run.
- A **stale-event-head** fixture: the LLM turn is driven by a wake/report carrying
  an old head while authoritative PR state has advanced; the gate keys on the fresh
  current head (step 1), not the stale event head — it neither aborts on the old
  head's coverage nor launches against a superseded head.
- An **interleaving** fixture: between the LLM turn's first coverage read and its
  launch, another starter terminalizes a `clean` run on the current head; the
  under-claim coverage re-read (step 3) aborts the LLM launch — no duplicate run,
  even with the claim acquired.
- An **audit redaction** fixture: a denial/probe record contains the bounded
  provenance id and reason but **no** environment values, tokens, raw prompt/context,
  or full shell command line; and the preflight-refusal record shape carries no
  PR/head/claim fields.
- An **unknown/malformed-row** fixture: an `ao review list` result for the
  current-head key with an unknown status, a missing/malformed head SHA, or
  ambiguous duplicate latest-run rows yields a fail-closed refusal (no run), not a
  "not covered" start.
- A **live-capability** fixture: the preflight validates the capability table as
  loaded by the live runtime (gitignored config included) and refuses when a live
  review-start capability is unclassified or ungated — not merely that the
  repo-tracked inventory is clean.
- A **cross-platform identity** fixture: Windows/PowerShell and WSL/Ubuntu
  invocations for the same GitHub PR/head resolve the same claim-store namespace and
  coverage key (no `C:\…` vs `/mnt/c/…` split that lets two runtimes both launch).
- A **denial-audit coalescing** fixture: repeated denials on the same covered head
  under successive turns produce a bounded coalesced/retained record
  (first/last/count by repo/PR/head/provenance/reason), not an unbounded stream.
- A **transient-refusal recovery** fixture: a head refused on a transient condition
  (head-resolution outage / preflight mismatch / unknown-row) is eventually reviewed
  after the condition clears — via bounded retry or the #163 reconciler — proving
  fail-closed does not silently drop the review.
- A **non-latest in-flight** fixture: a duplicate/malformed history for the
  current-head key with a non-latest `running`/`reviewing` row aborts the start
  (in-flight precedence), not started as if the latest terminal row governed.
- A **generated/transitive path** fixture: a path created after preflight (generated
  wrapper / `npm`/`make`/task script / PATH-injected helper) cannot reach raw
  `ao review run` from the autonomous surface (boundary denial), or — fallback —
  is caught as an unclassified capability.
- A **manual-pending-window** fixture: a manual start **through the pack-provided
  manual entry point** during the spawn-to-visible window (active claim/launch-
  attempt, no visible run) still emits the manual warning by consulting
  claim/launch-attempt state. (A fully raw human `ao review run` outside any pack
  surface is the accepted, unobservable residual — not asserted.)
- A **capability-table redaction** fixture: the emitted live capability table
  contains no raw gitignored config, paths, env, command templates, prompts, or
  tokens.
- The synced GitHub Issue number is referenced by the implementing PR and its
  verification artifacts (the draft's `GitHub Issue:` line is bound at sync, not
  left `TBD` once published).
- Operator-adoption steps from **Binding surface** are listed in the PR with a
  command to confirm the gate is live after `ao stop` / `ao start`.
- Closed-sibling regression suites (#267/#308/#189/#235) run green.

## Decisions

**Prior art (recon verdict: extends / references existing).** The review-start
single-flight surface is already built for three mechanical starters: #267 (claim
store, key, acquire-before-run), #308 (atomic single-winner, open), #287
(crash-safe terminal + claim release), #189 (covered-head predicate, prose-enforced
on the LLM path), #207 (wake-listener forward). This draft **does not re-implement**
any of them — it brings the autonomous LLM-turn path under the same claim +
predicate and makes enforcement mechanical. RCA this session (PR #316: review 355
on covered-clean head 6331d390; `~/.local/share/opencode/log/opencode.log:21061`
shows the orchestrator turn running `ao review run opk-71`; no claim file for 355;
same path created 349+350) proved the prose-only #189 enforcement does not hold on
a non-deterministic model.

**Chosen option (cheapest sufficient with acceptable risk).** Three options judged:
(A) harden the #189 prose — rejected: same class as the failed fix, prose cannot
bind a model; (B) a claimed wrapper the orchestratorRules call instead of bare
`ao review run` — insufficient alone: still depends on the model choosing the
wrapper; (C) deny the raw verb at the process/execution boundary so no autonomous
child process reaches it, exposing only the single claimed start capability —
**chosen**, fail-closed and model-behaviour-independent. A fourth option (modify
`ao review run` itself) was rejected as vendor/AO, out of pack scope. The
enumerated-capability inventory survives only as the weaker fallback where
process-boundary denial is not achievable.

**GPT adversarial loop (discuss-with-gpt).** Run per the user's «с gpt»
instruction; the standard Codex architect-review sync-gate was **skipped** at the
user's explicit "не с кодексом" direction — the GPT loop served as the adversarial
review. Codex draft review can still be run later on request.

GPT loop: 10 passes; stopped because cap-10 (final pass also no-accepted-finding —
genuine convergence); last-pass accepted=0; final STATE=completed_valid
VALIDATION=ok pass=71a5ab42-4b40-4e74-89b3-66b8cac6fa77
sha=28d2fb5434f538cccc6f37c1556a67489f4fc14734195b4cfe505454b7d93eb2.
Findings accepted across passes 1–9 (rejected: #308-TBD-as-this-draft's-gate,
gate-library/wiring split): provenance boundary; single claimed choke point above
shell parsing + cross-platform bypass; #308 hard sequencing; covered-abort no
residue; serial retry via #60/#98; capture-backed all statuses; preflight
fail-safe; run-list row selection; current-head-key matrix axis; versioned config
marker; claim≠coverage; repeated-turn retry; audit split; rollback never ungated;
provenance no-secrets; fresh authoritative head; coverage-vs-claim TOCTOU re-read
under claim; spawn-to-visible handoff; side-effect-safe probe; capability inventory
drift guard; delegated/worker starts gated; stale/multi-instance runtime; probe
isolation; pending-visibility recovery bound; .ao-namespace clarification;
live-gitignored capability validation; probe-reaches-gate assertion; Windows/WSL
canonical identity; unknown-row fail-closed; denial-audit coalescing;
dynamic/transitive path boundary denial; manual pending-window warning; capability-
table redaction; transient-refusal liveness backstop (#163); non-latest in-flight
precedence. Post-loop edits would un-cover the sha — none made.
