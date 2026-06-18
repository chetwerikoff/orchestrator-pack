# Source-agnostic worker-message delivery with confirmed consumption

GitHub Issue: TBD

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
path** is reliably submitted to the worker and tracked to **confirmed consumption
or bounded escalation**, with no manual operator `Enter`. A delivery that is never
consumed and never escalates (the current silent-loop failure) must become
impossible. The guarantee is **fail-closed at adoption**: a config-level preflight
verifies the journaled-routing rule is active and escalates `wrapper_not_adopted`
when it is not — rather than a blanket claim that silently breaks if the operator
rule is missing.

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

## Binding surface

- **One send path, journaled around the side-effect (transactional outbox).**
  Orchestrator→worker message sends commit an outbox journal entry **before** the
  send and a dispatch-outcome (`dispatched` | `send_failed`) **after** it, so
  every routed delivery is observable with a known dispatch result.
- **Journal stores metadata only — never the raw payload (security).** The outbox
  entry records `delivery_id`, source, message **shape** (char length, line
  count, pending-draft vs short), and dispatch outcome — **not** the message text
  (worker messages can carry credentials, session URLs, or private data). The
  journal lives outside the repo working tree (or gitignored), is permission-
  restricted to its owner, is retention-bounded, uses atomic write with
  quarantine-on-corruption (the existing mechanical-json-state discipline), and a
  parse failure **escalates** rather than silently misclassifying.
- **Secret-safe payload transport — stdin/pipe only.** The wrapper hands the
  message to `ao send` over **stdin/pipe only** — **never** as a command-line
  argument and **never** via a raw-payload temp file (a temp file could persist
  the secret across a wrapper crash, AO hang, process kill, or failed delete). The
  raw payload must not appear in argv, process listings, logs, `-DryRun` output,
  PowerShell transcripts, exception traces, or the journal. The metadata-only
  journal is necessary but not sufficient; transport is the other half of the
  secret guarantee. This presumes `ao send` accepts the payload over stdin/pipe
  with argument-path semantics — an unverified dependency (see **Open
  dependencies**); it must be confirmed locally as the first implementation step,
  not silently assumed.
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
- **Durable delivery identity — non-sensitive fields only.** Each delivery carries
  a stable `delivery_id` established **before** dispatch. Attempt accounting,
  vanish detection, de-duplication, and escalation dedup all key off this exact
  id. The id and any persisted identity component (source-key, session, path)
  are **non-sensitive** — opaque or a hash of canonical non-secret identifiers;
  any free-text / URL / path / branch component is hashed or excluded, **never**
  stored verbatim, so the metadata-only guarantee covers the id fields, the
  active-delivery record, dry-run artifacts, and the escalation dedup key too.
- **Confirmed consumption — fail-closed on ambiguity.** A delivery is `consumed`
  only on an observable worker signal after its send timestamp, scoped to that
  worker session (e.g. an `ao report` transition). When correlation to the exact
  delivery is **ambiguous** — multiple in-flight deliveries for one session and no
  AO-carried delivery id to disambiguate (AO 0.9.x does not echo one; do **not**
  assume a field AO never emits) — the delivery stays **unconfirmed** and rides
  the attempt budget to escalation, rather than being falsely credited by a weaker
  heuristic. An earlier or unrelated report never confirms.
- **Enter-eligibility gated on a real paste; single-owner terminal assumption.**
  Only a delivery whose dispatch outcome is `dispatched` and whose path is a
  pending draft is `Enter`-eligible. A `send_failed` delivery is
  terminal/escalated and **must never** receive an `Enter` (Enter with no draft
  pasted would submit stale terminal input). The pending-draft-vs-short
  determination is taken from an **authoritative post-dispatch signal**
  (AO/wrapper state: `draft_present` / `auto_submitted` / `unknown`), **not** a
  length/line-count guess: only `draft_present` is `Enter`-eligible,
  `auto_submitted` waits for consumption, and an **`unknown`** shape is **not**
  Enter-eligible — it fails closed to bounded escalation rather than risking an
  Enter into an empty/stale prompt. The design assumes the worker
  terminal is **single-owner / AO-driven** while a tracked draft is pending (not a
  human scratchpad). Because pane text is never read, the arbiter cannot detect
  silent buffer contamination directly; it relies on the existing intervening-
  input deferral (#232: an AO `activity.transition→active` or send event after the
  paste marks the delivery `stale_input` and **suppresses** auto-Enter). Residual
  risk — contamination that emits no AO signal — is an explicit, documented
  limitation, not a silent assumption.
- **Crash-safe accounting; the arbiter never replays a payload, only re-`Enter`s a
  present draft.** Model `claim_acquired`, `dispatch_attempted` (paste handed to
  `ao send`), and `outcome_observed` as distinct, durably-recorded phases; the
  attempt **budget is consumed only at `dispatch_attempted`**. Because the wrapper
  persists **no payload** (security), the arbiter can never re-send a lost
  message — it can only re-press `Enter` on a draft AO can **observably** confirm
  is still present, or escalate. Resume policy by crash point:
  - **before `ao send` is invoked** (no paste landed; payload not recoverable from
    metadata-only state) → **ambiguous escalation** so the source re-sends; never a
    promised replay.
  - **paste landed, but `Enter`/outcome lost** → re-press `Enter` **only** when an
    AO-observable signal confirms the pending draft is still present (a redundant
    `Enter` then cannot submit stale input because it is gated on the real draft);
    if AO **cannot prove** draft-present → **ambiguous escalation**, never a blind
    `Enter`.
  - **`ao send` invoked but interrupted** (killed / timed out / partial paste) →
    **no blind re-attempt** (could duplicate / concatenate); resolve only with
    positive evidence of no-paste or a landed paste, otherwise **ambiguous
    escalation**.
  A crash after the keypress before the outcome write does not reset the count; no
  phase consumes budget without submitting yet escalates as if it had;
  `dispatch_unknown` is never a silent limbo.
- **Confirmed consumption, then bounded escalation — with a concrete bound.** The
  attempt budget and a **maximum time-to-escalation** are explicit, finite,
  operator-overridable defaults (the #232 arbiter already defines a max-attempts
  count and a delivery budget window), so a never-confirmed delivery escalates
  **within a known wall-clock bound** — never an unbounded "silent for too long".
  Operator overrides are **validated fail-closed**: a non-finite, disabled,
  negative, zero, or unreasonably-large bound is rejected and escalated as
  `config_invalid` **before** any delivery is tracked — an override can never
  silently remove the bounded-escalation guarantee.
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
  carries a **state-root identity/epoch**: on startup, an active-delivery store
  whose identity does not match (an **empty alternate root** from a changed cwd /
  `$HOME` / account / Windows–WSL path) **escalates** rather than treating
  empty-as-authoritative — an empty record from the wrong root is not "nothing
  pending".
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

- `scripts/**` — a single journaled send-wrapper entry point `(new)`, an adoption
  preflight, and the extension of the existing submit arbiter
  (`worker-message-submit-reconcile.ps1` and its mechanical node filter) to:
  observe the outbox journal source, gate Enter-eligibility on dispatch outcome,
  record attempts across the three phases, detect vanish, dedup escalation, and
  apply the fail-closed worktree-drift exclusion.
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
asserts: on realistic AO-status + outbox-journal input, the arbiter plans an Enter submit for a journaled, dispatched, pending-draft plain-`ao send` delivery to a live worker (fixture-level; the live-Codex end-to-end path is the manual smoke check below)
input: realistic
```

- **Plain-`ao send` coverage.** A journaled plain `ao send` pending-draft delivery
  to a live worker is planned for submit, identical to a review-send delivery.
- **Journal is metadata-only and durable.** A fixture asserts the outbox entry
  contains shape metadata + `delivery_id` + dispatch outcome and **no** raw
  payload; a corrupt/partial journal escalates (quarantine), not misclassifies.
- **`delivery_id` correlation, fail-closed.** Consumption is credited only on a
  post-send session-scoped signal; with two in-flight deliveries and no echoed id
  the arbiter does **not** falsely confirm either (stays unconfirmed → escalates).
- **Three-phase crash safety + side-effect boundary.** Fixtures for crash after
  (a) `claim_acquired` before keypress → **escalates** (no payload to replay),
  budget not consumed; (b) `dispatch_attempted` recorded before keypress, keypress
  not delivered → resume re-presses Enter **iff** AO observably confirms the draft
  is still present, else **ambiguous escalation** — never a stale submit; (c) after
  keypress before outcome → counted, not reset; (d) after outcome → terminal.
- **`send_failed` terminal, never Enter.** No Enter is planned for a `send_failed`
  delivery; it escalates.
- **Idempotent escalation.** Repeated ticks over the same exhausted delivery emit
  one operator-visible escalation (dedup by `delivery_id`), not per-tick spam, and
  do not touch GitHub Issue state.
- **Escalate-on-vanish needs the durable record.** A tracked non-terminal delivery
  absent from all current sources escalates across a simulated restart.
- **Single-flight (no duplicate Enter).** A two-runner / restarted-supervisor
  fixture proves ≤1 Enter per `delivery_id`.
- **Worktree-drift exclusion is fail-closed.** Proven-drift (target SHA + worker
  head captured) → no escalation; missing/ambiguous evidence → ambiguous
  escalation. Two fixtures.
- **Cross-surface payload fidelity (wrapper → `ao send`).** The wrapper passes a
  multi-line, >200-char payload (including a path with spaces) to `ao send`
  without corruption across the pack's PowerShell surfaces (Windows PowerShell,
  WSL `pwsh`) — this is about the send call, not journal storage.
- **Secret-safe transport — all named surfaces.** A check proves a secret-shaped
  token in the payload is **absent** from argv, process listings, logs, `-DryRun`
  output, PowerShell transcripts, sanitized exception traces, supervisor
  stdout/stderr, and the journal artifact — across the fake-`ao send`
  success/failure/timeout/interrupted paths (present only as shape metadata).
- **Adoption preflight proves effective routing, not presence.** A
  present-but-ineffective routing rule (malformed / shadowed / wrong-precedence /
  schema-ignored — probe **not** observed in the outbox under the current AO
  epoch) escalates `wrapper_not_adopted`; only an observed probe passes. A
  stale-process / wrong-config-path / changed-epoch case is covered.
- **Adoption probe is side-effect-isolated.** A fixture proves the probe produces
  **no** real worker terminal input, **no** active-delivery record, **no** attempt
  budget consumption, and **no** consumption/escalation record — only an outbox
  observation.
- **`ao send` stdin/pipe contract is a hard gate.** A fixture/spike proves the
  transport path is blocked (issue gated, not implemented with argv) when the
  local `ao send` stdin/pipe contract check fails — never an argv-payload fallback.
- **No reentrant self-wrap.** A fixture proves the wrapper's own internal `ao send`
  is **not** routed back through the wrapper (sentinel honored): one orchestrator
  send produces exactly one outbox entry and one delivery, never recursion/dupes.
- **Branch-complete adoption probe.** A fixture proves the probe fails adoption
  when one real routing branch/source/message-shape is unwrapped (a single
  synthetic path passing is insufficient).
- **Config overrides validated fail-closed.** A fixture where max-attempts /
  time-to-escalation is set non-finite / zero / negative / huge escalates
  `config_invalid` before tracking, never silently unbounded.
- **Authoritative shape, unknown fails closed.** A fixture proves the
  pending-draft-vs-short label comes from an authoritative signal (not length
  alone); an `unknown` shape plans **no** Enter and escalates (threshold-drift /
  misclassification covered).
- **Sentinel cannot become a global bypass.** A fixture where a leaked/inherited
  reentrancy sentinel is present on a **real** orchestrator send proves the send is
  still journaled (no bypass).
- **`dispatch_unknown` resolution.** Separate fixtures for crash (a) before
  `ao send` is invoked → **escalates** (payload not recoverable; no replay); (b)
  after `ao send` returns but before outcome persistence → resolved
  deterministically (not left in limbo, not falsely escalated).
- **Short / self-submitted deliveries are tracked too (no Enter).** A dispatched
  short (single-line, ≤ threshold) message that AO auto-submits with no pending
  draft is still tracked to **confirmed consumption or bounded escalation** —
  with **no** Enter step — never dropped as untracked silence. Fixture proves a
  short delivery reaches a terminal state without any planned Enter.
- **Active-record durability + state-root identity.** A corrupt/truncated
  active-delivery tracking state is quarantined and escalates; and a **wrong-state-
  root** restart (empty alternate store from a changed cwd / `$HOME` / account /
  path) escalates on startup instead of treating the empty store as authoritative.
- **Intervening-input suppresses Enter.** A fixture where an AO intervening-input
  signal arrives after the paste marks the delivery `stale_input` and plans **no**
  Enter.
- **Interrupted send never blindly re-pastes.** A fixture where `ao send` was
  invoked then interrupted resolves to ambiguous escalation (or a proven
  no-paste/landed-paste), never a blind second paste.
- **`ao send` failure mapping.** Fake-`ao send` fixtures for success, non-zero
  exit, timeout, thrown exception, and interrupted execution each map to the exact
  dispatch outcome (`dispatched` / `send_failed` / interrupted-unknown) — a
  failure is never recorded as `dispatched`.
- **Dry-run isolation.** A `-DryRun` run writes only to an isolated/sandbox state
  root (or simulates); a fixture asserts the production journal and active-delivery
  records are **unchanged** after a dry-run (no phantom deliveries, no consumed
  budget).
- **Bounded time-to-escalation.** A fixture asserts a never-confirmed delivery
  escalates within the configured finite bound (default max-attempts × budget),
  not an unbounded wait.
- **No secrets in any dynamic argument.** A fixture where a secret-shaped token
  appears in a source-key / session / path / config-path / state-root value proves
  it is absent (hashed or excluded) from **both** the persisted artifacts
  (`delivery_id`, journal, active record, dry-run artifact, escalation dedup key)
  **and** the runtime surfaces (argv, process listings, logs, PowerShell
  transcripts, exception traces, supervisor stdout/stderr) — every dynamic
  wrapper/AO argument, not only the raw payload.
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
- **`ao send` stdin/pipe contract.** A real local contract check confirms `ao send`
  ingests the payload over stdin/pipe (Windows PowerShell + WSL `pwsh`); if it does
  not, the secret-safe-transport guarantee is flagged as the parked upstream
  dependency below, not silently assumed.
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
- **No new repo secrets and no payload persistence** — the journal stores only
  non-sensitive shape metadata, outside the working tree / gitignored.
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
  escalation dedup; secret-token absence from argv / process-list / transcript /
  exception traces / supervisor stdout-stderr / dry-run / logs / journal;
  adoption **effective-routing probe** (present-but-ineffective rule → escalate);
  preflight stale-process / wrong-path; short/self-submitted tracked-without-Enter;
  intervening-input → no-Enter.
- Cross-surface payload-fidelity fixtures (Windows PowerShell + WSL `pwsh`) for a
  multi-line, >200-char payload with a spaced path, asserting the value handed to
  `ao send`.
- **Manual live smoke check (documented, not a CI gate):** operator routes one
  multi-line `ao send` of a **synthetic non-secret** payload through the wrapper to
  a live Codex worker and confirms auto-submit with no manual Enter — recorded with
  **sanitized metadata-only** evidence in the runbook (no terminal transcript, no
  session URL, no raw message body, no worker output), since the synthetic fixtures
  cannot prove the Codex-TUI paste/Enter integration that caused the original
  symptom and the runbook is itself a secret surface.
- `pwsh -NoProfile -File scripts/worker-message-submit-reconcile.ps1 -Once -DryRun`
  stays green; the wrapper's `-DryRun`/fixture mode writes only to an isolated
  state root and a fixture asserts the production journal / active-delivery records
  are unchanged after it.
- Fake-`ao send` fixtures (success / non-zero exit / timeout / exception /
  interrupted) assert the exact dispatch-outcome mapping; a bounded-time-to-
  escalation fixture asserts escalation within the finite default bound.

## Open dependencies / parked risks

- **`ao send` non-argv ingestion (P1 — verify first).** The secret-safe transport
  assumes `ao send` accepts the payload over stdin/pipe with the same semantics as
  the argument path. AO upstream is out of scope, so this is an **unverified
  external dependency**: the first implementation step is a local contract check.
  If `ao send` lacks non-argv ingestion, that is a **hard blocker** for this
  issue's secret-safe transport: resolve via upstream `ao send` stdin support, or
  **split/stop** — land only the non-transport observation / accounting /
  escalation / vanish parts under a separate scope, behind this gate. There is
  **no argv payload fallback** and **no payload temp file**: argv exposes the
  secret, so an "accepted, documented argv-exposure limitation" is still a
  credential leak, not a parked risk. The non-transport parts hold regardless and
  may land first behind this gate.

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
