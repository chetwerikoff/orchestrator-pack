# Source-agnostic worker-message delivery with confirmed consumption

GitHub Issue: #373

## Prerequisite

- `docs/issues_drafts/73-review-finding-auto-submit-delivery.md` (GitHub #216,
  merged) and the source-agnostic submit arbiter (GitHub #232, merged) — this
  issue **extends** that arbiter so it also covers plain orchestrator `ao send`
  deliveries and makes its outcome accounting crash-safe. It does not replace it.
- `docs/issues_drafts/71-orchestrator-side-process-supervisor.md` (GitHub #205,
  merged) — the arbiter and any new reconcile run under the existing supervised
  side-process host; no new unsupervised process.

## Goal

Every message the orchestrator sends to a worker **through the journaled send
path** is submitted to the worker and tracked to **confirmed consumption or bounded
operator escalation** — never a silent loop, never a manual `Enter` for the common
case. `ao send` makes the first submit attempt itself (it pastes and presses
`Enter`, with its own retry); when that does not land (the draft is left pending and
the worker goes idle), the arbiter **backstops** it by pressing `Enter` via tmux —
gated on the existing #216/#232 idle-stable + unconsumed + no-intervening-input
inference, never blindly. A delivery that is never consumed and never escalates (the
current silent-loop failure) must become impossible: it either confirms, is
submitted by a bounded backstop, or escalates to the operator. The guarantee is
**fail-closed at adoption**: a config-level preflight verifies the journaled-routing
rule is active and escalates `wrapper_not_adopted` when it is not — rather than a
blanket claim that silently breaks if the operator rule is missing.

```behavior-kind
action-producing
```

## Background (why this is open)

After the worker runtime switched to Codex, the Codex TUI no longer auto-submits
AO-pasted pending-draft messages (multi-line or >200 chars); the Cursor TUI used
to. The submit arbiter (#232) presses `Enter`, but it only observes three
delivery sources — the reaction allowlist, the pack dispatch journal, and
review-run state. A plain `ao send` from the orchestrator produces **no AO event
the arbiter can see and writes no journal entry**, so those deliveries are
invisible to the arbiter and sit unsubmitted until a human presses `Enter`.

Separately, the arbiter's attempt accounting increments only at the **outcome**
step, after the `Enter` side-effect. A crash or interruption between the
side-effect and the outcome write leaves the attempt count at zero forever, so
the per-delivery attempt budget is never reached and the delivery loops
`submit → stale-claim → submit` without ever escalating to the operator.

**Why this is reopened (the #351 revert), and what the producer-reality check
found.** A prior build of this spec (PR #351, issue #347) was merged then
**reverted** (revert merged via PR #364): its transport bound delivery to an
`ao send` **stdin/pipe** ingestion flag that **no published AO version implements**
(verified against AO 0.9.2 local, 0.9.5 stable, 0.10.1-nightly). The wrapper
therefore failed closed permanently, and the fail-closed adoption gate blocked the
pre-existing #232 submit-reconcile on every tick. This is the binding-bug class:
the spec bound to a producer interface that does not exist.

Re-grounding the spec against the **real** `ao send` implementation (AO 0.9.2,
`@aoagents/ao-cli` `commands/send.js`) surfaced two more premises the prior spec
got wrong:
- **`ao send` submits the message itself.** After pasting, it presses `Enter`
  (`tmux send-keys … Enter`) and retries the keypress up to **3×** under its own
  activity detection. It is **not** a paste-only call whose `Enter` the arbiter
  owns. So the arbiter is the **conditional backstop** for when that submit does
  not land — exactly as the shipped #216/#232 path already works: it presses `Enter`
  by **direct tmux `send-keys`** to the worker pane, gated on the existing
  **idle-stable + unconsumed + no-intervening-input** inference (AO 0.9.x has no
  literal "draft-present" field — the idle inference is the proxy, and it is what
  prevents a duplicate: a draft `ao send` already submitted leaves the worker
  *active*, so the idle-gate does not fire).
- **`ao send` spools the raw payload to a world-readable `/tmp/ao-send-<ts>.txt`**
  for the multiline / >200-char (pending-draft) class — the exact class this issue
  targets — then unlinks it in a `finally` that **ignores cleanup failure**. The
  payload's on-disk lifetime is therefore **outside any wrapper's control**, so a
  wrapper-level "secret-safe transport" guarantee is **unachievable** for that
  class. Combined with the fact that orchestrator→worker messages carry **no
  credentials** (they are CI/wake nudges, review findings, submit prompts — see
  `docs/orchestrator-message-map.md`), the entire **secret-safety surface is
  dropped** from this spec: no secret-redaction transport, no payload-file
  lifecycle, no secret-absence acceptance criteria. The spec keeps only **delivery
  + confirmed consumption + bounded escalation + crash-safe accounting + fail-closed
  adoption**.

The corrected transport simply **binds to the interface `ao send` actually
exposes**, captured at authoring time (`ao send --help`, AO 0.9.2:
`Usage: ao send [options] <session> [message...]`, `-f, --file <path>`). The
non-transport guarantees (three-phase accounting, adoption preflight, submit-arbiter
extension, journal, escalation, scenario matrix) are otherwise **unchanged** from
the pre-revert contract. (How the planner realizes this — reworking the reverted
implementation or building afresh — is its choice; the spec constrains end-state
behavior, not the patch strategy.)

## Binding surface

- **One send path, journaled around the side-effect (transactional outbox).**
  Orchestrator→worker message sends commit an outbox journal entry **before** the
  send and a dispatch-outcome (`dispatched` | `send_failed`) **after** it, so
  every routed delivery is observable with a known dispatch result.
- **Journal stores metadata only (observability + size).** The outbox entry records
  `delivery_id`, source, message **shape** (char length, line count, pending-draft
  vs short), and dispatch outcome — **not** the message text (it adds no
  observability value and bloats the journal). The journal lives outside the repo
  working tree (or gitignored), is retention-bounded, uses atomic write with
  quarantine-on-corruption (the existing mechanical-json-state discipline), and a
  parse failure **escalates** rather than silently misclassifying.
- **Transport binds only to the interface `ao send` actually exposes.** The wrapper
  delivers the message through the real `ao send` ingestion captured at authoring
  time (`ao send --help`, AO 0.9.2): `Usage: ao send [options] <session>
  [message...]` with `-f, --file <path>` (*"Send contents of a file instead"*).
  There is **no `--stdin`/pipe ingestion flag** — binding to one is what made the
  prior build (#351) fail closed permanently (see **Background**). The planner
  picks between the positional `[message...]` form and `--file <path>`; both are
  real (`--file` avoids any argv length ceiling for large payloads). Whichever form
  is chosen **must deliver option-shaped payloads intact** — a message beginning with
  `-` or containing tokens like `--file` must **not** be parsed as an `ao send`
  option. The positional form is admissible **only** with a `--` end-of-options
  delimiter **proven supported** by the captured real CLI; otherwise the planner uses
  `--file` (immune, since the payload is file content, not argv). No transport
  guarantee is made about the payload's on-disk lifetime: `ao send` itself spools
  the multiline/large payload to a `/tmp/ao-send-<ts>.txt` outside the wrapper's
  control (see **Background**), and worker messages carry no secrets, so this issue
  makes **no secret-safety / payload-redaction claim** — only that the chosen
  transport is an interface `ao send` truly supports and delivers the message
  intact.
- **`ao send` makes the first submit; the arbiter backstops via tmux `Enter`.** Per
  the captured implementation, `ao send` pastes **and** presses `Enter` itself (up to
  3× under its own activity detection), so the journaled send **is** the primary
  submit attempt. When it does not land, the arbiter backstops it exactly as the
  shipped #216/#232 path does: it presses `Enter` by **direct tmux `send-keys` to the
  worker pane** (not via `ao send`, no payload replay), **fail-closed** when tmux is
  unavailable or the session address is stale/missing. AO 0.9.x exposes no literal
  "draft-present" field, so eligibility is the existing **idle-inference**, not a
  mythical signal: the arbiter presses `Enter` only when the delivery is to the
  **live-owner** session, is **not** confirmed-consumed, has **no intervening input
  activity** after the paste (the #232 `stale_input` guard), and the worker has been
  **idle-stable** for the settle window — i.e. the draft is demonstrably still
  pending and was not submitted. Crucially, the no-intervening-activity guard is
  **durable, not recomputed from current idle**: once an `activity.transition→active`
  is observed **after** the paste, that is recorded as **submission evidence** and
  **permanently suppresses** any further backstop `Enter` for this delivery — even
  after the worker finishes processing and returns to idle (the `active → idle, still
  unconfirmed` sequence must **not** re-arm the Enter, which would land on an empty or
  newer prompt). So `ao send`'s own submit, once it makes the worker active, durably
  closes the backstop; a blind `Enter` is never issued.
- **Reentrancy bypass — the wrapper never wraps its own `ao send`.** The wrapper
  itself invokes `ao send`; if the adopted routing rule matched that internal
  invocation, the wrapper would re-wrap itself (recursive wrapping, duplicate
  outbox entries, duplicate delivery, or a send loop — violating single-flight and
  bounded escalation). The wrapper's internal `ao send` carries a reentrancy
  sentinel (marker / env var) that is excluded from routing, and only
  orchestrator-originated sends are wrapped. The sentinel is **child-process-scoped
  and non-inheritable** (or nonce-bound to that single internal invocation) so it
  cannot leak to the orchestrator process / shell / supervisor / later sends — a
  leaked or inherited sentinel on a **real** orchestrator send must **not** bypass
  journaling. Self-interception must be impossible by construction; a global
  bypass must be impossible by leakage.
- **Adoption enforced at config/preflight bound to the running AO, not a file.**
  Because a bare `ao send` is genuinely unobservable, the arbiter does **not** try
  to reverse-detect each one (that would be indistinguishable from human terminal
  input). Instead a preflight proves **effective routing** — a **side-effect-
  isolated** probe (a synthetic recipient / outbox-only observation, never
  delivered to a real worker, never tracked as a delivery, never consuming attempt
  budget) under the current AO epoch must appear in the outbox — and escalates
  `wrapper_not_adopted`, loudly, if the probe is **not** observed. Proving the rule
  *line is present* is not enough (a malformed / shadowed / wrong-precedence /
  schema-ignored rule can be present yet ineffective). The probe must cover **every
  adopted routing branch** (each source/recipient/message-shape class the rule
  governs), or the rule must be **source/shape-independent by construction** — a
  single synthetic path passing must not false-green while other real routes stay
  unwrapped. The preflight binds to the
  **effective running AO instance** (a restart/reload epoch tied to the exact
  config path it loaded), not merely a file on disk — so a stale process, a
  different config root, or a Windows/WSL path mismatch cannot show green while
  bare sends stay unjournaled. Adoption is **revalidated on every AO restart /
  reload epoch** (not a one-time pass): the last-validated epoch + config path are
  persisted and compared, so config drift or a restart after an earlier green
  check re-triggers the escalation rather than silently re-opening the gap.
- **Adoption failure escalates; it does not (and cannot) block plain sends, and
  never disables the pre-existing reconcile.** When the routing rule is absent or
  ineffective, plain `ao send` calls **bypass the wrapper entirely** — so the arbiter
  **cannot suppress** them; it can only make their non-coverage **loud**. The
  contract is therefore **escalation without suppression**: a red `wrapper_not_adopted`
  state raises an operator-actionable escalation (adopt the rule) and the plain-send
  path stays **uncovered** until adopted — the arbiter does not claim to journal or
  gate sends it never sees. Critically, this is the explicit guard against the #351
  revert cause (the prior adoption gate blocked the pre-existing #232 reconcile on
  **every** tick): adoption-red must **never** disable the already-shipped sources —
  **review-send, reaction-routed, and dispatch-journal** deliveries **continue to
  reconcile, submit, and escalate normally**. Adoption is a loud signal about *new*
  coverage, not a kill-switch on the existing arbiter.
- **Durable delivery identity.** Each delivery carries a stable `delivery_id`
  established **before** dispatch. Attempt accounting, vanish detection,
  de-duplication, and escalation dedup all key off this exact id, and it survives a
  supervisor restart (persisted with the active-delivery record).
- **Confirmed consumption requires positive causal correlation; otherwise
  fail-closed.** A delivery is `consumed` only on a worker signal the arbiter can
  **causally tie to that exact delivery**. AO 0.9.x carries **no** delivery id on
  any report (do **not** assume a field AO never emits), so a session-scoped report
  arriving after the send timestamp is **not** sufficient on its own — it may be
  unrelated (the worker doing something else), and that is true even when only one
  delivery is in flight. Absent a causally-correlatable signal, the delivery stays
  **unconfirmed** and rides the budget to **escalation**, never falsely credited by
  a temporal/session-scope heuristic. Because reliable correlation is the exception
  under AO 0.9.x, **bounded escalation — not confirmation — is the load-bearing
  guarantee**; an unconfirmed delivery is surfaced to the operator, never dropped.
- **Enter-eligibility by inference, not a literal AO field; single-owner terminal
  assumption.** Only a delivery whose dispatch outcome is `dispatched` and whose
  path is a pending draft is `Enter`-eligible. A `send_failed` delivery is
  terminal/escalated and **must never** receive an `Enter` (Enter with no draft
  pasted would submit stale terminal input). AO 0.9.x exposes **no** literal
  draft-present field, so the pending-vs-submitted determination is the existing
  **idle-stable + no-intervening-input inference** (#232) — **not** pane text and
  **not** a length/line-count guess: a delivery is treated as a still-pending draft
  only while the worker stays **idle-stable** with **no** AO `activity.transition→
  active` / send event after the paste; an intervening event marks it `stale_input`
  and **suppresses** the `Enter`; an already-`auto_submitted` delivery (worker went
  active) waits for consumption; an **indeterminate** state fails closed to bounded
  escalation rather than risking an Enter into an empty/stale prompt. The design
  assumes the worker terminal is **single-owner / AO-driven** while a tracked draft
  is pending (not a human scratchpad). Because pane text is never read, the arbiter
  cannot detect silent buffer contamination that emits no AO signal — an explicit,
  documented residual limitation, not a silent assumption.
- **Crash-safe accounting; the arbiter never replays a payload, only backstops a
  still-present draft.** Two distinct side effects exist: the one-time **send** (the
  `ao send` call, which pastes **and** presses `Enter` itself) and any later
  **backstop `Enter`** the arbiter issues when the send's own `Enter` did not
  submit. Model `claim_acquired`, the send outcome (`dispatched` | `send_failed`),
  and per-backstop **`enter_attempted` → `outcome_observed`** as distinct,
  durably-recorded phases. The send happens **once** — the arbiter never re-sends a
  payload (it persists none) and never re-runs `ao send`. **A slot is consumed when
  an `enter_attempted` record is durably finalized — conservatively, at-most-once per
  slot** (the record is written *immediately before* the keypress; the record→keypress
  pair cannot be atomic, so a crash in that gap **still spends the slot** even if the
  physical Enter may not have fired). This is deliberate **at-most-once** accounting:
  it never under-counts (the original "attempt-count-stays-zero-forever" loop is
  closed), and it may rarely over-count by one un-fired keypress — acceptable because
  `max-attempts` still finitely bounds slots and the wall-clock deadline backstops a
  delivery that thereby never submits. A slot is therefore **never re-pressed**; a lost
  outcome does not reopen its slot. If the delivery is still unconfirmed and eligible
  and budget remains, the **next** attempt consumes the **next** slot; when
  `max-attempts` is exhausted the delivery **escalates** (with `max-attempts = 1`: one
  slot, then escalate if unconfirmed — never a deadlock, never an unbounded re-press).
  The only "no slot consumed" case is a crash **before** an `enter_attempted` record is
  finalized (still the `claim_acquired` phase), which is resumable, bounded by the
  wall-clock deadline. Because each backstop `Enter` fires only
  under the **idle-stable + no-intervening-input** inference (worker idle, draft not
  yet submitted), a duplicate cannot land on an already-submitted draft (a submitted
  draft makes the worker active, failing the idle-gate); a stray `Enter` on a truly
  idle empty prompt submits nothing harmful. The budget (`max-attempts`) bounds the
  number of backstop `Enter`s; the escalation deadline itself is the separate
  **wall-clock max-pending-age from dispatch** (below), independent of how many (or
  zero) backstop `Enter`s fire. Resume policy by crash point:
  - **before `ao send` is invoked** (send not started; payload not recoverable from
    metadata-only state) → **ambiguous escalation** so the source re-sends; never a
    promised replay.
  - **`ao send` returned but its outcome was not persisted** → `dispatch_unknown`,
    reconciled per that state's policy below (idle-inference / consumption evidence
    resolves it; otherwise bounded ambiguous escalation).
  - **a backstop `Enter`/outcome lost** → the issued keypress already counts its slot;
    do **not** re-press the same slot. If the delivery is still unconfirmed and the
    idle-stable + no-intervening-input inference still holds **and** budget remains, the
    **next** attempt consumes the **next** slot and presses once more; if budget is
    exhausted or the inference no longer holds → **escalation**, never a blind `Enter`.
  - **crash before any keypress was issued** (`enter_attempted` not finalized) → no
    slot consumed; resume issues the first/next keypress while eligible, bounded by the
    wall-clock deadline.
  - **`ao send` invoked but interrupted** (killed / timed out / partial paste) →
    **no blind re-attempt** (could duplicate / concatenate); resolve only with
    positive evidence of no-paste or a landed paste, otherwise **ambiguous
    escalation**.
  A crash after the keypress before the outcome write does not reset the count; the
  at-most-once accounting may spend a slot whose physical Enter never fired (the
  conservative trade-off above), but a delivery is **never** dropped without reaching
  consumption or escalation, and `dispatch_unknown` is never a silent limbo.
- **Confirmed consumption, then bounded escalation — with a concrete bound.** The
  escalation deadline is a **wall-clock max-pending-age measured from the earliest
  durable delivery timestamp** (`claim_acquired` / invocation-start — **not**
  dispatch-completion, which `dispatch_unknown` deliveries never observe), so even a
  delivery whose dispatch outcome is never known still has a fixed clock origin and
  reaches bounded escalation. It is applied to **every** tracked delivery
  independently of Enter eligibility — so a short/self-submitted delivery that
  performs **zero** backstop `Enter`s still
  escalates at the same wall-clock deadline if never confirmed. The backstop
  `max-attempts` bounds *how many* Enters may fire within that window; it does not
  define the deadline. Both inherit the **#232 arbiter defaults** as the baseline
  (the shipped `worker-message-submit-reconcile` constants: a max-pending-age window
  of `DELIVERY_BACKSTOP_MS` = 30 min and a `MAX_SUBMIT_ATTEMPTS` = 3), so a
  never-confirmed delivery escalates **within a known wall-clock bound** — never an
  unbounded "silent for too long".
  Operator overrides are **validated fail-closed** against an objective predicate:
  the max-pending-age must be a **finite number in `(0, ageCeiling]`** and max-attempts
  a **finite integer in `[1, attemptsCeiling]`** (the planner declares each `ceiling`
  as a constant). An invalid value (non-finite, disabled, ≤ 0, non-integer attempts, or
  `> ceiling`) is **rejected and escalated as `config_invalid`**, but — exactly like
  the adoption-failure rule — this **never stops tracking**: reconciliation continues
  under the **safe bounded built-in defaults** (the shipped #232 constants) so every
  delivery (new and already-shipped sources) stays tracked and bounded. The invalid
  override is ignored, not allowed to become a kill-switch. A fixture exercises each
  rejection class and the accepted boundary, so "valid" is testable
  without reading Claude's mind — an override can never silently remove the
  bounded-escalation guarantee.
  When the budget is exhausted without confirmed consumption, the delivery
  **escalates with an operator-visible, idempotent diagnosis** (deduplicated by
  `delivery_id`, no per-tick spam) through the existing supervised escalation
  surface. Escalation does **not** mutate GitHub Issue / task state (out of scope —
  a delivery hiccup must not rewrite issue state). No delivery ends in silence.
- **Escalate-on-vanish via a durable active-delivery record.** The arbiter keeps
  its own durable, restart-surviving record of non-terminal deliveries (its
  tracking state). A delivery present in that record but absent from **all**
  current observation sources before confirmed consumption is an escalation event,
  detected by comparing the durable record against current sources, so journal
  overwrite, event-window aging, or a supervisor restart cannot turn a live
  delivery into silence. This active-delivery record gets the **same** durability
  discipline as the journal (atomic write, permission restriction, quarantine-on-
  corruption, parse-failure escalation) — a truncated or wrong-path tracking state
  must not silently lose the only record of a non-terminal delivery. It also
  carries a **state-root identity/epoch** anchored to an **independently-discoverable
  canonical location** — one that does **not** move with cwd / `$HOME` / account /
  Windows–WSL drift (e.g. derived from the AO config path the adoption preflight
  already binds to). The expected identity lives at that canonical anchor, separate
  from the active-delivery store root. On startup the store root's identity is
  compared against the anchor: a **mismatch or a store root that is empty/absent while
  the anchor records a prior identity** → **escalates** (the empty root is the *wrong*
  root, not "nothing pending"); only when the anchor itself records **no** prior
  identity is an empty store a legitimate **first run** (which then establishes the
  identity at the anchor). This makes wrong-root drift detectable instead of
  indistinguishable from a fresh start.
- **Single-flight per delivery.** Concurrent reconcile ticks or a restarted
  supervisor must not dispatch a duplicate `Enter` for the same `delivery_id`;
  claim acquisition is atomic per delivery.
- **Out of scope — worktree-drift vanish (fail-closed exclusion).** A review-run
  delivery that vanished because AO marked the run `outdated`/superseded due to the
  linked worker's git worktree drifting off the PR branch is **not** a
  delivery-layer failure. Escalation is suppressed **only when** both the run's
  target SHA **and** the linked worker's head are durably captured and positively
  prove drift (head ≠ target on a still-open PR). When that evidence is missing or
  ambiguous, the arbiter escalates as **ambiguous** rather than silently ignoring a
  possible real vanish. The worktree-drift class itself is recovery-runbook
  territory, not this issue.
- **Never pane text.** Observation and consumption confirmation derive from AO
  events, the outbox journal, review-run state, and `ao report` transitions —
  never from scraping the worker terminal pane.

- **Operator adoption.** `orchestratorRules` (live `agent-orchestrator.yaml`,
  operator-local) must be updated so the orchestrator emits worker sends via the
  journaled wrapper, and AO restarted (`ao stop` / `ao start`) so the new rules
  load. The PR provides the wrapper and the exact `orchestratorRules` line to
  adopt; the operator applies it and restarts. The preflight above keeps an
  un-adopted configuration loud.

## Files in scope

- `scripts/**` (and the `docs/*.mjs` mechanical-filter helpers the arbiter already
  uses) — a journaled send path `(new)`, an adoption preflight, and the extension of
  the existing submit arbiter to: observe the outbox journal source, gate
  Enter-eligibility on dispatch outcome, record attempts across the defined phases,
  detect vanish, dedup escalation, and apply the fail-closed worktree-drift
  exclusion. The planner chooses the entry-point count, file names, and filter
  structure.
- `docs/**` — operator adoption notes (recovery runbook / migration notes), the
  `orchestratorRules` line to adopt, and a manual live-smoke procedure; do **not**
  edit the gitignored live `agent-orchestrator.yaml`.

## Files out of scope

- `agent-orchestrator.yaml` (gitignored live config — operator applies the rule).
- `packages/core/**`, `vendor/**`, AO upstream behavior.
- The worktree-drift / review-supersede class itself (recovery-runbook territory).
- GitHub Issue / task-state mutation on delivery escalation.

```denylist
vendor/**
packages/core/**
.ao/**
```

## Acceptance criteria

```positive-outcome
asserts: on realistic AO-status + outbox-journal input where a journaled, dispatched plain-`ao send` delivery left a pending draft STILL present (the send's own Enter did not submit), the arbiter plans a backstop Enter submit for that delivery to a live worker (fixture-level; the live-Codex end-to-end path is the manual smoke check below)
input: realistic
```

- **Plain-`ao send` coverage.** A journaled plain `ao send` pending-draft delivery
  to a live worker is planned for submit, identical to a review-send delivery.
- **Journal is metadata-only and durable.** A fixture asserts the outbox entry
  contains shape metadata + `delivery_id` + dispatch outcome and **no** raw
  payload; a corrupt/partial journal escalates (quarantine), not misclassifies.
- **Consumption requires causal correlation, fail-closed.** Consumption is credited
  **only** on a worker signal causally tied to that exact `delivery_id`. A post-send
  session-scoped signal alone is **insufficient** — even with a single in-flight
  delivery (it may be unrelated). With no AO-echoed delivery id, a fixture proves the
  arbiter stays **unconfirmed → escalates** rather than falsely confirming (single
  in-flight and two-in-flight cases).
- **Crash safety + side-effect boundary (defined phases).** A pre-invocation marker
  records whether `ao send` invocation **began** (since `ao send` itself pastes then
  Enters, a started invocation may have landed the paste). Fixtures for crash after
  (a) `claim_acquired` with the marker showing invocation **not** begun → no send
  happened → re-source/escalate, budget not consumed; (a′) `claim_acquired` with
  invocation **begun** but no persisted send outcome → `dispatch_unknown`, reconciled
  per that state's policy (landed-paste evidence required before any Enter / causal
  consumption evidence; else bounded ambiguous escalation); (b) `enter_attempted`
  recorded (slot counted) but outcome lost → the slot stands; the **next** attempt
  presses once more **iff** the idle-stable + no-intervening-input inference still
  holds **and** budget remains, else **escalation** — never a same-slot re-press,
  never a stale submit; (b′) crash **before** any keypress was issued
  (`enter_attempted` not finalized) → no slot consumed, resume issues a keypress while
  eligible, bounded by the wall-clock deadline; (c) after keypress before outcome →
  counted, not reset; (d) after `outcome_observed` → the **attempt/slot** is complete,
  but the **delivery** is terminal only once **consumed** or **escalated** — an
  observed Enter outcome alone does not confirm consumption, so an unconfirmed delivery
  continues to the next attempt (if eligible and budget remains) or rides the deadline
  to escalation; tracking is never silently dropped after an Enter.
- **`send_failed` terminal, never Enter.** No Enter is planned for a `send_failed`
  delivery; it escalates.
- **Idempotent escalation.** Repeated ticks over the same exhausted delivery emit
  one operator-visible escalation (dedup by `delivery_id`), not per-tick spam, and
  do not touch GitHub Issue state.
- **Escalate-on-vanish needs the durable record.** A tracked non-terminal delivery
  absent from all current sources escalates across a simulated restart.
- **Single-flight per attempt (no concurrent duplicate Enter).** A two-runner /
  restarted-supervisor fixture proves no two runners execute the **same**
  `enter_attempted` concurrently (one claim/lease wins) — bounded sequential backstop
  Enters up to `max-attempts` are allowed, but the same attempt never double-fires.
- **Worktree-drift exclusion is fail-closed.** Proven-drift (target SHA + worker
  head captured) → no escalation; missing/ambiguous evidence → ambiguous
  escalation. Two fixtures.
- **Payload fidelity for the selected transport (wrapper → `ao send`).** The wrapper
  passes a multi-line, >200-char payload (including a path with spaces) to `ao send`
  without corruption on the pack's execution surface (pwsh 7+ on Linux/WSL2), for
  **whichever** supported ingestion form the planner chose (positional `[message...]`
  or `--file`) — the criterion does not assume multiple paths. This is about the send
  call, not journal storage.
- **Adoption preflight proves effective routing, not presence.** A
  present-but-ineffective routing rule (malformed / shadowed / wrong-precedence /
  schema-ignored — probe **not** observed in the outbox under the current AO
  epoch) escalates `wrapper_not_adopted`; only an observed probe passes. A
  stale-process / wrong-config-path / changed-epoch case is covered.
- **Adoption probe is side-effect-isolated.** A fixture proves the probe produces
  **no** real worker terminal input, **no** active-delivery record, **no** attempt
  budget consumption, and **no** consumption/escalation record — only an outbox
  observation.
- **Transport binds to a real `ao send` interface (captured).** A fixture/contract
  check proves the wrapper delivers through an ingestion form `ao send` actually
  supports — the positional `[message...]` or `--file <path>` form per the captured
  `ao send --help` — and the build fails closed (transport gated) if that local
  contract check fails. No binding to a nonexistent flag (the #351 `--stdin`
  regression).
- **Arbiter never blind-`Enter`s; backstop only under the idle-inference.** A
  fixture proves that after a `dispatched` send the arbiter presses `Enter` (via
  direct tmux `send-keys`) **only** while the **idle-stable + unconsumed +
  no-intervening-input** inference holds, and presses **nothing** when the worker is
  **active** (the send already submitted) — so an `ao send` that submitted on its own
  never receives a duplicate/stale `Enter`. A separate fixture proves the `Enter`
  path is **fail-closed** when tmux is unavailable or the session address is stale.
- **`active → idle, still unconfirmed` does not re-arm the backstop.** A fixture
  drives the sequence: paste → worker goes **active** (submission evidence recorded) →
  worker returns **idle** while consumption stays unconfirmed. It proves the arbiter
  presses **no** further `Enter` (the durable post-paste activity evidence permanently
  suppresses the backstop), so a stale Enter never lands on an empty/newer prompt; the
  delivery rides to consumption or the deadline, not another keypress.
- **Adoption red escalates without suppression; existing reconcile keeps running.** A
  fixture with `wrapper_not_adopted` red proves the operator-actionable escalation
  fires (plain-send coverage reported missing, **not** silently claimed) **and** that
  review-send, reaction-routed, and dispatch-journal deliveries still reconcile,
  submit, and escalate on the same tick (the #351 revert cause — adoption blocking the
  pre-existing #232 reconcile — cannot recur).
- **No reentrant self-wrap.** A fixture proves the wrapper's own internal `ao send`
  is **not** routed back through the wrapper (sentinel honored): one orchestrator
  send produces exactly one outbox entry and one delivery, never recursion/dupes.
- **Branch-complete adoption probe.** A fixture proves the probe fails adoption
  when one real routing branch/source/message-shape is unwrapped (a single
  synthetic path passing is insufficient).
- **Config overrides validated fail-closed, without a kill-switch.** A fixture where
  max-attempts or max-pending-age is non-finite / zero / negative / non-integer
  attempts / above its declared `ceiling` escalates `config_invalid` **and proves
  reconciliation continues under the safe built-in defaults** (new and already-shipped
  sources stay tracked and bounded — an invalid override is ignored, never a
  kill-switch); the accepted boundary value passes — never silently unbounded.
- **Pending-vs-submitted from the idle-inference, unknown fails closed.** A fixture
  proves the pending-vs-submitted determination comes from the AO activity / idle
  inference (worker idle-stable, no intervening input) — **not** a length/line-count
  guess; an indeterminate state plans **no** Enter and escalates (threshold-drift /
  misclassification covered).
- **Sentinel cannot become a global bypass.** A fixture where a leaked/inherited
  reentrancy sentinel is present on a **real** orchestrator send proves the send is
  still journaled (no bypass).
- **`dispatch_unknown` resolution.** Separate fixtures for crash (a) before
  `ao send` invocation began → **escalates** (payload not recoverable; no replay);
  (b) invocation begun but outcome not persisted → reconciled by the
  `dispatch_unknown` policy: idle state alone is **not** sufficient to fire a
  backstop Enter here, because an idle worker is indistinguishable between
  "paste landed, not yet submitted" and "process died before pasting" — so a
  backstop Enter requires **positive landed-paste evidence**; absent it, escalate
  **ambiguous** (no blind keypress). Consumption is credited only on **causal**
  (`delivery_id`-tied) evidence, **not** a session-scoped post-send transition. When
  neither is available it fails closed to **bounded ambiguous escalation** (never
  falsely credited as `dispatched` or `consumed`, never silently looped).
- **Short / self-submitted deliveries are tracked too (no Enter).** A dispatched
  short (single-line, ≤ threshold) message that AO auto-submits with no pending
  draft is still tracked to **confirmed consumption or bounded escalation** —
  with **no** Enter step — never dropped as untracked silence. Fixture proves a
  short delivery reaches a terminal state without any planned Enter.
- **Active-record durability + state-root identity (canonical anchor).** A
  corrupt/truncated active-delivery tracking state is quarantined and escalates; and a
  **wrong-state-root** restart (empty/absent store while the **canonical anchor**
  records a prior identity, from a changed cwd / `$HOME` / account / path) escalates on
  startup — while a **genuine first run** (anchor has no prior identity) does **not**
  escalate. Two fixtures prove both arms (the empty store is not blindly treated as
  authoritative, and a real first run is not falsely escalated).
- **Intervening-input suppresses Enter.** A fixture where an AO intervening-input
  signal arrives after the paste marks the delivery `stale_input` and plans **no**
  Enter.
- **Interrupted send never blindly re-pastes.** A fixture where `ao send` was
  invoked then interrupted resolves to ambiguous escalation (or a proven
  no-paste/landed-paste), never a blind second paste.
- **`ao send` failure mapping (only pre-side-effect failures are `send_failed`).**
  Fake-`ao send` fixtures map by **whether the failure is proven to precede the
  paste**: success → `dispatched`; a failure **proven to occur before any paste**
  (e.g. session-not-found / immediate arg rejection) → `send_failed` (terminal, no
  draft). A non-zero exit / timeout / thrown exception that **could** have occurred
  *after* `ao send` pasted or pressed Enter is **ambiguous** — it does **not** map to
  `send_failed` (that would strand a pending draft); it resolves to the separate
  **`dispatch_unknown`** state and is reconciled by that state's
  deterministic policy (ambiguous escalation unless paste status is proven), never
  left in limbo.
- **Dry-run isolation.** A `-DryRun` run writes only to an isolated/sandbox state
  root (or simulates); a fixture asserts the production journal and active-delivery
  records are **unchanged** after a dry-run (no phantom deliveries, no consumed
  budget).
- **Bounded time-to-escalation (wall-clock, Enter-independent).** A fixture asserts
  a never-confirmed delivery escalates within the configured finite **max-pending-age
  measured from the earliest durable delivery timestamp** (`claim_acquired` /
  invocation-start, so a `dispatch_unknown` delivery with no dispatch-completion time
  still has a clock), not an unbounded wait — and a **short/self-submitted** delivery
  (zero backstop Enters) escalates at that same wall-clock deadline, proving the
  deadline does not depend on Enter eligibility.
- **Unprovable draft-present → no Enter.** A resume fixture where AO cannot confirm
  the pending draft is still present plans **no** Enter and escalates ambiguous
  (never a blind re-Enter); and a pre-invocation-crash fixture escalates (no
  replay), since the payload is not persisted.
- **Adoption revalidates per epoch.** A fixture where adoption was green, then the
  AO restart/reload epoch (or config path) changes to an un-adopted state,
  re-escalates `wrapper_not_adopted` — not a one-time pass.
- **Adoption preflight runs live in the supervised loop, not only as a fixture.**
  The preflight executes on the #205-supervised host each reconcile epoch (and on
  every AO restart/reload), and a shipped-but-un-adopted config emits an
  idempotent, operator-actionable `wrapper_not_adopted` escalation through the
  supervised escalation surface — so an un-adopted wrapper cannot run indefinitely
  as a silent passive status note while worker sends bypass the journal. A fixture
  asserts the supervised tick invokes the preflight and surfaces the escalation
  (deduplicated per epoch, no per-tick spam); the live wiring is confirmed by the
  manual smoke check. (Incident 2026-06-18: the wrapper was unshipped/un-adopted,
  so the orchestrator merely narrated "journaled-worker-send not adopted" as a
  status line and no nudge was delivered — the escalation must drive adoption, not
  passively report it.)
- **`ao send` interface contract (captured, committed).** A real local contract
  check confirms the chosen transport form is one `ao send` actually supports (per
  the captured `ao send --help`, AO 0.9.2: positional `[message...]` and
  `-f, --file <path>`), on pwsh 7+ (Linux/WSL2), and the build commits that
  capture-backed evidence so the transport binding is provable against producer
  reality, not assumed. If neither supported form ingests the message, the
  transport is a hard blocker per **Open dependencies** — never a binding to a
  nonexistent flag.
- **Scenario-matrix coverage (fix the class).** Asserted across the matrix below —
  each coherent cell a fixture.

### Scenario matrix (coherent cells only)

- **Journaled deliveries** — source ∈ {dispatch-journal/pack-send, review-send,
  plain `ao send` via wrapper, reaction-allowlist}, crossed only with applicable
  dimensions:
  - **message-shape** ∈ {pending-draft (needs Enter), short/self-submitted (no
    Enter)} — short deliveries are tracked to consumed-or-escalated with **no**
    Enter step, not dropped as untracked.
  - **dispatch-outcome** ∈ {dispatched, send_failed} — `send_failed` → terminal
    escalation, never Enter.
  - **outcome-record** ∈ {recorded, lost-before-record} — `lost-before-record`
    must still reach a terminal state (three-phase accounting), never a loop.
  - **delivery-visibility** ∈ {visible, delivery-layer-vanished (event window
    aged, status change under a still-current head, journal overwrite)} —
    `vanished` → escalation.
- **Bare `ao send` (not journaled)** → caught by the **adoption preflight**, not
  per-delivery detection (negative/adoption cell).
- **Operator manual input** (a human typing directly; no AO dispatch, no journal
  entry) → arbiter ignores it: no submit, no tracking, no escalation.
- **Explicitly excluded** from the vanished column: `outdated-via-worktree-drift`
  (proven-drift suppresses, ambiguous escalates).

## Upgrade-safety check

- No edits to `packages/core/**`, `vendor/**`, or AO upstream.
- No new unsupervised process — extends the #205-supervised arbiter.
- No unsupported `agent-orchestrator.yaml` schema fields; the only live-config
  change is an `orchestratorRules` send-routing line the operator adopts.
- **No new repo secrets.** The journal stores only shape metadata, outside the
  working tree / gitignored; it is never committed. This issue makes no
  secret-safety claim about the message payload (see **Background**).
- No worker-terminal pane scraping introduced.

## Verification

- Vitest/Pester fixtures for every coherent scenario-matrix cell and acceptance
  bullet, following the existing `worker-message-submit-reconcile.test.ts` pattern
  (mechanical node-filter `plan`/`outcome` over synthetic AO-status, events,
  journal, and review-run inputs — no live tmux).
- Three-phase crash fixtures including the **record-before-keypress / keypress-
  not-delivered** interleave and the `dispatch_unknown` cases (crash before
  `ao send` invoked vs after it returns before outcome persistence); vanish-across-
  restart; proven-drift vs ambiguous-drift; two-runner single-flight; ambiguous
  multi-in-flight no-false-confirm; corrupt-journal **and** corrupt active-record
  quarantine-escalation; **wrong-state-root** restart escalation; idempotent-
  escalation dedup; **backstop-only-on-still-present-draft** (no blind/duplicate
  `Enter` when the send already submitted);
  adoption **effective-routing probe** (present-but-ineffective rule → escalate);
  preflight stale-process / wrong-path; short/self-submitted tracked-without-Enter;
  intervening-input → no-Enter.
- Payload-fidelity fixtures (pwsh 7+ on Linux/WSL2) for a multi-line, >200-char
  payload (including a path with spaces **and an option-shaped payload** — leading
  `-`, embedded `--file`) over the selected transport form, asserting the value handed
  to `ao send` is delivered intact (positional form only with a proven `--`
  end-of-options delimiter; else `--file`).
- **Manual live smoke check (documented, not a CI gate):** operator routes one
  multi-line `ao send` through the wrapper to a live Codex worker and confirms the
  message is submitted (no manual Enter), since the synthetic fixtures cannot prove
  the live Codex-TUI paste/Enter integration that caused the original symptom.
- `pwsh -NoProfile -File scripts/worker-message-submit-reconcile.ps1 -Once -DryRun`
  stays green; the wrapper's `-DryRun`/fixture mode writes only to an isolated
  state root and a fixture asserts the production journal / active-delivery records
  are unchanged after it.
- Fake-`ao send` fixtures (success / non-zero exit / timeout / exception /
  interrupted) assert the exact dispatch-outcome mapping; a bounded-time-to-
  escalation fixture asserts escalation within the finite default bound.

## Open dependencies / parked risks

- **`ao send` interface (grounded at authoring; re-confirmed at build).** The
  transport binds to a form `ao send` actually exposes in the captured authoring
  interface (`ao send --help`, AO 0.9.2: positional `[message...]` and
  `-f, --file <path>`) — replacing the prior build's binding to a **stdin/pipe**
  flag that no published AO version implements (the binding that forced the #351
  revert). The residual external dependency is narrow: the **operator's installed
  AO must still expose one of those forms**, re-confirmed by the build's local
  contract check. If a future AO drops both, that is a **hard blocker**: resolve via
  the supported ingestion path, or **split/stop** — land only the non-transport
  observation / accounting / escalation / vanish parts behind this gate.
- **AO-owned send behavior (documented, not this issue's to fix).** Two verified
  `ao send` behaviors are upstream-owned and explicitly out of scope: (1) `ao send`
  presses `Enter` itself (up to 3×) — the arbiter is a conditional backstop around
  this, never a blind submitter; (2) `ao send` spools the multiline/large payload to
  a world-readable `/tmp/ao-send-<ts>.txt` it cleans up best-effort — so payload
  on-disk lifetime is outside any wrapper's control and **no secret-safety guarantee
  is made** (worker messages carry no credentials). Changing either would require an
  AO upstream change (`packages/core`/`vendor` — out of scope).

## Decisions (GPT adversarial pass)

Pass 1 (`completed_valid` / `VALIDATION=ok`, NEEDS_ATTENTION, 9 findings) — all
accepted: fail-closed non-adoption; `delivery_id` correlation; three-phase
crash accounting; `send_failed`-never-Enter; durable vanish record; fail-closed
worktree-drift exclusion; single-flight; matrix split into coherent cells;
cross-surface payload fidelity.

Pass 2 (`completed_valid` / `VALIDATION=ok`, BLOCKED, 7 findings):
- *Outbox can persist secrets (critical)* → **accepted**: journal is metadata-only
  (no raw payload), outside-tree/gitignored, permission-restricted, retention-
  bounded, atomic + quarantine-on-corruption.
- *`delivery_id` not proven to reach the worker signal* → **accepted (fail-closed)**:
  ambiguous correlation stays unconfirmed → escalates; do not assume an AO id
  field AO never emits.
- *Bare-send detection contradicts the observability gap* → **accepted**: replaced
  after-the-fact detection with a config/preflight adoption check.
- *`dispatch_attempted` not atomic with Enter* → **accepted**: defined the
  side-effect boundary (record before keypress) + at-least-once resume gated on a
  still-present pending draft; added the record-before-keypress fixture.
- *Live Codex behavior unverified by synthetic fixtures* → **accepted**:
  positive-outcome scoped to fixture-level; added a documented manual live-smoke
  check.
- *Outbox atomicity / parse-failure unspecified* → **accepted**: durability
  properties + corrupt-journal escalation fixture.
- *Escalation not bound to Issue/task state* → **partial**: accepted idempotent,
  dedup-by-`delivery_id`, operator-visible escalation; **rejected** binding it to
  GitHub Issue/task mutation (scope creep — a delivery hiccup must not rewrite
  issue state).

Pass 3 (`completed_valid` / `VALIDATION=ok`, BLOCKED, 5 findings) — all accepted:
- *Raw payload may leak via wrapper→`ao send` transport (critical)* → secret-safe
  non-argv transport; raw payload absent from argv/logs/dry-run/transcript/journal.
- *Preflight may validate a file, not the running AO* → preflight bound to the
  effective running instance / restart epoch; stale-process / wrong-path fixture.
- *Pre-send orphan state undefined* → explicit `dispatch_unknown` state with a
  deterministic reconcile policy + separate crash fixtures.
- *Active-delivery record lacks the journal's durability rules* → same atomic /
  quarantine / parse-fail-escalate discipline + corrupt-active-record fixture.
- *"Real pending draft" not safe from interleaved manual input* → single-owner
  terminal invariant + existing intervening-input deferral suppresses auto-Enter;
  unsignaled contamination documented as accepted residual limitation.

Pass 4 (`completed_valid` / `VALIDATION=ok`, BLOCKED, 5 findings) — all accepted:
- *Temp-file transport can persist secrets across a crash (critical)* → transport
  narrowed to **stdin/pipe only**, no raw-payload temp file.
- *`dispatch_unknown` omits the interrupted/partial-paste middle* → added the
  `ao send` invoked-but-interrupted sub-state: no blind re-attempt, ambiguous
  escalation unless paste status is proven.
- *Dry-run may mutate real state* → dry-run isolated to a sandbox state root;
  fixture asserts production journal/active records unchanged.
- *`ao send` failure mapping unvalidated* → fake-`ao send` fixtures (exit / timeout
  / exception / interrupted) → exact dispatch outcome.
- *Budget not concretely bounded* → explicit finite, operator-overridable
  max-attempts + time-to-escalation, asserted by a fixture.

Pass 5 (`completed_valid` / `VALIDATION=ok`, BLOCKED, 5 findings) — all accepted:
- *Secrets can leak via `delivery_id` / source-key (critical)* → identity fields
  are non-sensitive (opaque/hashed), covering journal, active record, dry-run, and
  escalation dedup key.
- *"Pending draft present" unobservable without pane text* → re-`Enter` only on an
  AO-observable draft-present signal, else ambiguous escalation; never a blind
  re-Enter.
- *Pre-send crash retry contradicts no-persistence* → unified invariant: the
  arbiter **never replays a payload** (only re-`Enter`s a present draft); a
  pre-invocation crash escalates for the source to re-send.
- *stdin/pipe depends on an unverified `ao send` contract* → recorded as a parked
  P1 dependency + a real local contract check (Open dependencies).
- *Adoption can drift after a one-time preflight* → revalidation on every AO
  restart/reload epoch, with the validated epoch/config path persisted.

Pass 6 (`completed_valid` / `VALIDATION=ok`, BLOCKED, 2 findings) — both accepted:
- *Acceptance still required pre-send replay/retry, contradicting no-payload
  (critical)* → fixed the stale acceptance bullets to **escalate** on
  pre-invocation / claim-only crash (no replay), matching the binding-surface
  invariant.
- *Short / self-submitted messages absent from the contract* → added a
  message-shape dimension; short deliveries are tracked to consumed-or-escalated
  with no Enter step.

Pass 7 (`completed_valid` / `VALIDATION=ok`, BLOCKED, 3 findings) — all accepted
(tightening acceptance to match the stated guarantees):
- *Secret-safety acceptance narrower than the contract (critical)* → extended the
  check to transcripts, exception traces, supervisor stdout/stderr, and process
  listings across the fake-`ao send` paths.
- *Adoption preflight can false-green on a present-but-ineffective rule* → preflight
  now proves **effective routing** via an outbox-observed probe under the current
  epoch, not rule-line presence.
- *Wrong-state-root active-record loss untestable* → added a state-root
  identity/epoch guard; a wrong-root empty store escalates on startup.

Pass 8 (`completed_valid` / `VALIDATION=ok`, BLOCKED, 3 findings) — all accepted:
- *Open dependency could waive the no-argv guarantee (critical)* → made lack of
  `ao send` non-argv ingestion a **hard blocker** (no argv-payload fallback; split/
  stop behind the gate).
- *Adoption probe may mutate a real worker* → probe is side-effect-isolated
  (synthetic sink / outbox-only), no worker input / active record / budget; fixture.
- *Secret check missed non-payload dynamic arguments* → generalized the
  named-surface secret-absence check to every dynamic wrapper/AO argument.

Pass 9 (`completed_valid` / `VALIDATION=ok`, BLOCKED, 4 findings) — all accepted:
- *Wrapper can recursively wrap its own `ao send` (critical)* → reentrancy sentinel
  excludes the wrapper's internal send from routing; self-interception impossible
  by construction.
- *Adoption probe may false-green without covering all routes* → probe must cover
  every adopted routing branch or the rule be source/shape-independent.
- *Live-smoke evidence is a new secret surface* → synthetic non-secret payload +
  sanitized metadata-only runbook evidence.
- *Operator overrides not constrained finite* → overrides validated fail-closed
  (`config_invalid` before tracking).

Pass 10 / cap (`completed_valid` / `VALIDATION=ok`, **NEEDS_ATTENTION** — softened
from BLOCKED, 0 critical, 2 findings) — both accepted:
- *Pending-draft-vs-short classification unproven* → label from an authoritative
  post-dispatch signal (`draft_present`/`auto_submitted`/`unknown`); `unknown`
  fails closed (no Enter).
- *Reentrancy sentinel could become a global bypass if leaked/inherited* → sentinel
  child-scoped / non-inheritable / nonce-bound; a leaked sentinel on a real send
  must not bypass journaling.

**GPT loop: 10 passes; stopped because cap-10; last-pass accepted=2; final
STATE=completed_valid VALIDATION=ok pass=5feb6696-efcb-4f7d-8cb9-8217e74d240c
sha=cad459feb34327a91afb05e007587803a47d764c788d1f2a7763a2d1717232e2.** Trajectory
converged (BLOCKED→NEEDS_ATTENTION, 0 critical at the cap; findings shrank from 9
to 2 and shifted from design holes to test-provability). The two pass-10 fixes
above were applied **after** the final reviewed pass, so those specific edits are
**not themselves adversarially re-reviewed** (cap reached) — both are well-bounded
fail-closed refinements; an 11th pass was disallowed by the 10-pass cap.

**Post-convergence addition (2026-06-18, not re-reviewed by the GPT loop).** Added
the "Adoption preflight runs live in the supervised loop" acceptance criterion
after a live incident (PR #344/opk-34): the journaled wrapper was unshipped/un-
adopted, so the orchestrator only *narrated* "journaled-worker-send not adopted"
and no worker nudge was delivered. The addition is a well-bounded tightening of the
existing fail-closed adoption surface (preflight must execute on the supervised
host and drive an operator-actionable escalation, not run only as a fixture); it
does not change any existing guarantee. Flagged as **post-GPT change not re-
reviewed** per the discuss-with-gpt stop rule — fold into the next adversarial pass
if this draft is reopened. The trigger half of the same incident (`ci-green-wake` /
review-wake-trigger skipping a post-handoff worker on a fresh green head with no
`ready_for_review`) is **out of scope here** — it is a trigger-eligibility concern
in a different reconciler, carried in its own draft (see the queue index).

**Post-revert re-grounding (2026-06-20, supersedes the secret-safety decisions of
Pass 2/3/4/5/7/8/9 and the Pass-10 classification note).** The merged build #351 was
reverted (PR #364) because its transport bound to an `ao send` **stdin/pipe**
ingestion flag that no published AO version implements — the spec named a producer
interface that does not exist (binding-bug class). Re-grounding against the real
`ao send` (AO 0.9.2, `@aoagents/ao-cli` `commands/send.js`) drove three changes:
- **Transport** now binds only to a form `ao send` actually exposes (positional
  `[message...]` or `--file <path>`, per captured `ao send --help`). The earlier
  stdin-only decisions (Pass 4 "stdin/pipe only, no temp file"; Pass 3/5/8 stdin
  references) are void.
- **Secret-safety surface dropped entirely** (supersedes Pass 2 outbox-secret, Pass
  3/4 transport-secret, Pass 5 `delivery_id`-secret, Pass 7/8 named-surface secret
  decisions). Verified cause: `ao send` itself spools the multiline/large payload to
  a world-readable `/tmp/ao-send-<ts>.txt` outside any wrapper's control, so a
  wrapper-level secret-safe-transport guarantee is **unachievable**; and the actual
  message classes carry **no credentials** (`docs/orchestrator-message-map.md`). The
  spec keeps delivery + confirmed consumption + bounded escalation + crash-safe
  accounting + fail-closed adoption only.
- **Enter ownership corrected.** Verified that `ao send` presses `Enter` itself (up
  to 3×). The arbiter is reframed from "owns the submit" to a **conditional
  backstop** for when that submit does not land. The backstop is **not** new
  machinery and is **not** parked: it is exactly the shipped #216/#232 path —
  `Enter` pressed by **direct tmux `send-keys`** (fail-closed on missing tmux/
  session), gated on the existing **idle-stable + unconsumed + no-intervening-input**
  inference (AO 0.9.x has no literal draft-present field; the idle inference is the
  proxy, and it is what prevents a double-submit — a draft `ao send` already
  submitted leaves the worker active, failing the idle-gate). The attempt budget
  counts backstop `Enter`s (recorded before the keypress), not the one-time send.
  (An earlier draft of this re-grounding wrongly concluded the backstop was
  unbuildable for lack of a literal AO signal; the shipped idle-inference disproves
  that — corrected here.)

**Codex architect-review convergence (2026-06-20).** Ran the critical-architect Codex
pass iteratively **to `NO_FINDINGS`** (clean terminal verdict). Findings shrank and
shifted from design holes to fine-grained lifecycle/accounting edges, and several were
**substantive catches** folded in: the `active → idle, still-unconfirmed` stale-Enter
race (durable post-paste submission evidence now permanently suppresses the backstop);
the at-most-once slot-accounting boundary (record→keypress non-atomic → conservative
slot consumption); the wall-clock deadline origin for `dispatch_unknown` (earliest
durable timestamp, not dispatch-completion); **adoption failure escalates without
suppression and never disables the pre-existing #232 reconcile** (re-proving the #351
revert cause cannot recur); the same **no-kill-switch** rule extended to invalid config
overrides (escalate `config_invalid`, keep reconciling under safe defaults); a
**canonical-anchor** state-root identity (so an empty wrong root is distinguishable
from a genuine first run); and option-shaped-payload transport safety (`--` delimiter
proven, else `--file`).

The prior #351 implementation stays in history as a reuse option, but the spec
mandates end-state behavior, not a patch strategy. Re-grounded against producer
reality and Codex-reviewed **to convergence (`NO_FINDINGS`)**; **not** re-run through
the GPT adversarial loop — fold the secret-drop + backstop model into the next
adversarial pass if the draft is reopened.
