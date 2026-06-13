# Orchestrator CI-failure ping: suppress the duplicate via the reaction's observable event

GitHub Issue: #283

## Prerequisite

None required to merge. Shares the "guard predicate bound to an event AO never
emits" failure class with the review-trigger head-binding work
(`docs/issues_drafts/85-review-trigger-terminal-worker-fallback.md`) and the
delivery-ledger work (`docs/issues_drafts/89-worker-message-delivery-confirmed-consumption.md`);
this issue is scoped narrowly to the CI-failure-notification decision and does
not depend on either landing first. **Relationship to #89:** this issue
suppresses on the reaction having *sent* to the active target, not on confirmed
*consumption* — consumption is #89's domain. If #89 lands, the predicate should
prefer its delivery signal over the bare `reaction.action_succeeded` event (noted
in Binding surface); until then, "sent to the active session" is the suppression
basis and the residual is recorded, not hidden.

## Goal

When a worker PR's required CI goes red, the orchestrator must **not** add a
redundant "CI failed, fix it" ping once the worker has already been notified for
that failure episode. Today the orchestrator's CI FAILURE DISCIPLINE turn fires
a second ping seconds after the AO built-in `ci-failed` reaction already sent
one, because the orchestrator's dedup guard is bound to an observable AO never
produces (a successful `ao send` emits no event). This issue makes the
orchestrator suppress its ping on the **observable** signal that the reaction
already notified the worker, and emit at most one ping itself when it is the sole
notifier.

**Scope boundary (non-goal).** This closes the **observed, dominant** ordering —
reaction-first (the daemon reaction is instant on detection; the orchestrator is
turn-driven, so it almost always observes the failure second). It does **not**
close the reverse ordering — orchestrator-first, then the unconditional reaction
fires later — because the built-in reaction lives in the AO daemon and cannot
consult repo-side state (see **Residual risk**). At-most-one is therefore scoped
to "the orchestrator does not duplicate a notification the worker already has,"
not a symmetric cross-path guarantee.

```behavior-kind
action-producing
```

## Binding surface

The repository commits to a **deterministic, observable** decision for the
orchestrator's CI-failure ping, replacing the current prose guard that keys on a
non-emitted "prior `ao send` ping" event:

- A single **episode key** identifies a CI-failure episode:
  `{repo, PR number, head SHA, red-period discriminator, active notification
  target}`. The head SHA alone is **not** the key — two PRs or a reopened/forked
  branch can share a commit, and a per-PR record keyed on commit alone could
  suppress a different PR's only ping.
  - **Active notification target (restart / crash-resume).** Suppression binds to
    the worker session that is the **current** notification target for the PR. A
    reaction event or intent token recorded against a **superseded** session
    (after a daemon restart or a worker crash/resume that rotated the session)
    MUST NOT suppress the active session's ping — otherwise a crash-resume silently
    loses the only notification. The planner picks how the target is identified;
    the invariant is that a prior-session notification does not count as notifying
    the active session.
  - **Red-period discriminator (same-SHA red→green→red).** Required CI can go red,
    green (rerun / flaky), then red again on the **same** head SHA. Green **ends**
    the episode; a later red period on the same SHA is a **new** episode and is
    separately notifiable. The key needs a discriminator that changes across an
    intervening green and **survives a missed green observation** — a flaky rerun
    can go red→green→red between orchestrator turns, so a discriminator that
    relies on *observing* the green edge is insufficient; derive it from a durable
    CI identity that changes per run/attempt (e.g. a check-suite run/attempt id).
    The discriminator represents the **aggregate** required-CI red period — a new
    episode requires aggregate required CI to have returned **green**, not merely a
    per-leg / matrix-attempt rerun while the aggregate stays continuously red
    (raw per-check attempt churn must not fragment one red period into many
    episodes and re-ping). The planner picks the source; the invariant is: *an
    intervening aggregate green — observed or not — must not let a prior red
    period's reaction event or intent token suppress the next red period's ping,
    and per-check attempt churn without an aggregate green must not start a new
    episode.*
  - **One episode per uninterrupted red-CI run.** Within a single red period (no
    intervening green) on an unchanged head SHA, the episode is the **same** even
    as the failing required-check set evolves (matrix legs turning red at
    different times). Accumulating additional failing required checks MUST NOT
    start a new episode or re-notify — the worker already knows CI is red.
  - The failing required-check set is **context the ping carries** (which jobs
    failed), not part of the episode identity. A transient fetch failure (the SCM
    tracker's observed `Failed to fetch CI checks`) MUST NOT manufacture a new
    episode or flip a recorded decision.
  - **One canonical CI source for episode identity.** The predicate must derive
    the head/red-period/check context from a single canonical source (or a defined
    precedence), and that source must be **consistent with the basis the reaction
    observed** — if the orchestrator reads `gh pr checks` while the reaction fired
    off AO's SCM tracker, a disagreement (a check one sees and the other does not,
    or a differently-reported rerun attempt) can yield a false SEND or false
    SUPPRESS. The planner picks the source; consistency with the reaction's basis
    for the same episode is the contract.
- The orchestrator's CI-failure ping for an episode is **suppressed** when either
  is observably true for that episode:
  - the AO built-in `ci-failed` reaction has already notified the worker for this
    episode (its `reaction.action_succeeded` event with `reactionKey=ci-failed`
    is the observable token — this event *is* emitted, unlike a successful
    `ao send`). The event MUST be **bound to the full episode identity**
    `{repo, PR, head SHA, red-period, active target}` before it suppresses — a
    shorter `{repo, PR, head SHA, red-period}` tuple is **incomplete context that
    cannot suppress** on its own, since a reaction sent to a superseded session
    must not silence the active session.
    Binding is by **episode identity, not wall-clock**: a legitimate reaction-first
    event timestamps *before* the orchestrator's own later turn-observation (the
    daemon reaction is instant; the orchestrator is turn-driven) — it MUST still
    match and suppress. "Stale" means a **different SHA or a prior red-period**
    (pre-green), not "earlier than my turn." An event that cannot be bound (wrong
    SHA, prior red-period, or malformed) is a **no-match** and does **not**
    suppress — a stale reaction must never silence the only ping for a new
    episode, and the dominant reaction-first event must never be mis-rejected as
    stale. The
    no-match path is a safety fallback for stale/malformed events, **not** an
    acceptable steady state: if the real `reaction.action_succeeded` event
    structurally lacks the fields needed to bind it to the episode, Option B's
    premise fails and the design must escalate (see **Residual risk**) rather
    than silently degrade to "orchestrator always sends". **Scope of "notified":**
    `reaction.action_succeeded` evidences the reaction *send* completed to the
    active session target — it is **not** proof the worker *consumed* the message.
    Confirmed delivery/consumption is the concern of the delivery-ledger work
    (`docs/issues_drafts/89-worker-message-delivery-confirmed-consumption.md`);
    this issue suppresses on "reaction sent to the active target," does not
    regress that gap, and — if #89 lands — the predicate SHOULD consume its
    delivery signal instead of the bare success event; or
  - the worker is visibly self-fixing **this episode** via an explicit `fixing_ci`
    report correlated to the **full episode identity**
    (`{repo, PR, head SHA, red-period, active target}`), not a shorter
    `{repo, PR, head SHA}` + timestamp. Binding only on `{repo, PR, head SHA}` +
    time would let an old `fixing_ci` that happens to post-date the *new* episode
    start (after a same-SHA red→green→red, or against a superseded session) wrongly
    suppress the active target's only ping. A **stale** `fixing_ci` (earlier head,
    earlier red-period, or superseded session) and a generic `addressing_reviews`
    that does not reference CI for this episode are both **insufficient** to
    suppress.
    - **A new commit is not a within-episode self-fix suppressor — it is a new
      episode.** A new commit changes the head SHA, so it cannot be evidence for
      "this (head-keyed) episode": the old head's episode is **superseded** (its
      ping is moot — that head is gone), and the new head, if its required CI is
      red, is a **fresh** episode re-evaluated from scratch with **no inherited**
      reaction-match or intent token. This removes the contradiction between
      "new commit = self-fixing" and "new head = new episode."
- When neither holds (e.g. the reaction never fired because the SCM tracker
  failed to fetch checks, and the worker has not reacted), the orchestrator
  sends **exactly one** ping for the episode through a **single idempotent
  send operation** (planner shapes it).
  - **Idempotency via an atomically-claimed write-ahead intent token.** Because a
    successful orchestrator `ao send` emits no observable of its own (the original
    bug), the send MUST be made idempotent against a **durable, episode-keyed
    intent token written before the send**, not a record written after it. The
    token write MUST be an **atomic create-if-absent claim**: two concurrent CI
    FAILURE DISCIPLINE turns, retries, restored sessions, or overlapping daemon
    invocations must not both observe "no token," both claim, and both send. Only
    the winning claimant sends; the loser observes the existing token and
    suppresses. (Same atomic per-`(pr, head)` claim discipline the review-start
    race uses.) A token that exists means "this episode's orchestrator ping is
    already owned": the next turn sees the token and does not re-send. Lookup is
    by **exact episode key**, never a broad scan (a broad scan risks an accidental
    stale match across episodes).
  - **Crash boundary resolves to at-most-once (chosen failure mode).** With no
    delivery receipt from `ao send`, a post-crash state of "token written, send
    unconfirmed" is **indistinguishable** between "send already succeeded,
    confirmation lost" and "send never happened" — so the design MUST pick one
    behavior, not give opposite rules for identical-looking states. The chosen
    invariant is **at-most-once**: an existing intent token **suppresses** the
    next turn (no retry). **An *observable* `ao send` failure is not this
    ambiguous case** — if `ao send` returns a definite failure after the claim
    (no message left), the claim MUST NOT become a permanent silent suppressor:
    the token is either released for a bounded retry or marked **failed-owned** and
    escalated operator-visibly (like repeated HELPER-ERROR), never left to suppress
    every later turn. At-most-once SUPPRESS-on-token applies only to the genuinely
    **unobservable** crash state. The cost is a rare lost orchestrator ping when
    the send truly never happened *and* the reaction also did not fire. The intended bound
    on that residual is the existing `report-stale` (~30 min) backstop plus the
    next still-red turn re-deciding only if no token was written — **but the bound
    is only real if `report-stale` actually surfaces a worker that was never
    notified about red CI** (it may today key on stale reports / session liveness,
    not "idle-but-uninformed"). Verification MUST confirm the lost-ping state is
    surfaced by `report-stale` (or a named backstop); if not, the residual is
    recorded as **not fully bounded**, not silently assumed closed. This trades a
    rare delayed ping for a hard no-duplicate guarantee — the issue's purpose. The
    token's storage surface is the planner's; the write-ahead-then-send ordering
    and the at-most-once crash resolution are the contract.
- The decision is made by a **deterministic predicate** (planner names and
  shapes it) that can be exercised by tests against fixed inputs — not by
  LLM-prose recall across turns. The predicate's verdict is **authoritative**:
  the `orchestratorRules` path sends or suppresses strictly per the verdict, not
  as advisory prose. The predicate's behavior on its own failure (helper error /
  unreadable state) MUST be defined and default to the safe direction (do not
  emit a duplicate; re-decide next turn from observables).
  - **Final action is binary; bindability is a diagnostic, not an action.** The
    predicate's terminal output is exactly **SEND** or **SUPPRESS** (with a
    defined error → safe-direction). Reaction-event states like *no-match* /
    *unbindable* are **diagnostics that feed** the decision — a no-match reaction
    event simply does not suppress, so it contributes to SEND unless another
    suppressor applies; an all-no-match real reaction-first capture is the merge
    gate failure (Residual risk). These diagnostics are recorded in the audit but
    MUST NOT be returnable as a terminal action, so the live path never faces an
    ambiguous verdict it has no action for.
  - **Decide against one snapshot; revalidate the target before applying
    (TOCTOU).** The active notification target can rotate (session crash/resume,
    daemon move) between predicate-input capture and the SEND/SUPPRESS apply. The
    decision MUST be computed against a single **target-generation snapshot**, and
    SUPPRESS/SEND applied only if that generation is **still current** at apply
    time; if the target rotated, re-decide for the new target rather than apply a
    decision made for a target that is no longer active — otherwise a stale match
    suppresses the active session's only ping while the audit shows a "valid"
    SUPPRESS.
- **Live invocation contract.** The predicate is invoked by the live daemon
  through a **tracked wrapper** with a defined contract: repo-root resolution
  (no cwd assumptions), an exit-code / verdict-channel contract, and a timeout.
  Unit fixtures passing while the live daemon silently fails to invoke the helper
  (path/quoting/executable-bit/pwsh-vs-bash/WSL-path/cwd drift) is itself the
  failure mode this guards. The issue **declares the single supported operator
  runtime** (the pack's pwsh-7+/WSL2 environment) and the live wrapper +
  atomic-claim checks run there; a cross-runtime matrix (native Ubuntu/bash,
  Windows PowerShell) is out of scope unless and until the pack declares support
  for more — so a green check on the declared runtime is the contract, not a
  false multi-runtime promise. A single helper failure resolves to the defined safe
  direction (above, suppress), not an undefined fallback — but **repeated** helper
  failure must not become silent indefinite suppression: after a bounded number of
  consecutive live HELPER-ERROR outcomes for CI-failure discipline, the design
  MUST raise an **operator-visible** failure (and fail verification/adoption),
  rather than quietly disabling the orchestrator's CI ping forever. Fail loud, not
  silent.
- **Decision audit (observability — cures the original blind spot).** Every
  predicate decision and live-path action emits a **redacted, episode-keyed audit
  line** recording at least: episode key, **`terminal_action`** — a closed
  two-value enum **SEND | SUPPRESS** (a helper/error case is `SUPPRESS` with a
  `diagnostic.error_kind=helper_error`; never a third action value, never
  NO-MATCH), separate **diagnostic** fields (reaction-bind status: matched /
  no-match / unbindable, self-fix-bind status, error_kind), the reason, the bound
  reaction event id (if any), and the intent-token state. The investigation that motivated this issue was hampered precisely
  because a successful `ao send` left no trace; this record makes false
  suppression, all-no-match bindability failures, and stale-rule behavior
  reconstructable after the fact. Intent tokens and audit records carry a defined
  **retention/compaction** rule with explicit **episode-closure triggers** —
  aggregate required CI green, new-head supersession, and PR closed/merged/branch
  deleted — plus a **minimum crash/replay retention** so a compactor neither keeps
  records forever nor deletes evidence still needed to detect a later stale
  duplicate or false suppress (e.g. a superseded-target cleanup must not drop the
  active target's in-flight episode).

The built-in `ci-failed` reaction stays the unconditional instant backstop; this
issue does **not** change AO's reaction (it lives in the daemon and cannot defer
to repo state). The dedup is therefore one-directional: the orchestrator defers
to the reaction, never the reverse.

- **Residual risk (explicit, in scope to document — not to fix here).** The
  reverse ordering — the orchestrator sends first, then the unconditional daemon
  reaction fires for the same episode — is **not** closed by this design, because
  the reaction cannot consult the orchestrator's intent token. The draft does not
  claim to. Two levers fully close it but are deliberately out of this issue's
  scope: (a) the operator disables or escalation-gates the `ci-failed` reaction
  (`auto`/`retries`) in the live `agent-orchestrator.yaml`, leaving the
  orchestrator the sole notifier — a config decision, not a worker build; or
  (b) AO core makes the reaction consult shared state — upstream, out of scope.
  This issue's acceptance does not depend on either; the residual is recorded so
  a future operator/upstream decision is informed, not silently inherited. A
  related residual: if the captured `reaction.action_succeeded` event proves
  structurally unbindable to the episode key (see suppression rule above), Option
  B cannot suppress at all and the only remaining closure is lever (a) — the
  Verification step that captures the event surfaces this before merge.

- **Operator adoption (blocking, two-phase).** Phase 1 lands the worker-authored
  tracked surfaces (predicate, fixtures, canonical rule reference). Phase 2 is an
  operator-adoption gate: the operator merges the equivalent change into the live
  (gitignored) `agent-orchestrator.yaml` and applies it via `ao stop` / `ao start`
  (per the `change-orchestrator-runtime` skill — daemon-cache + session-restore
  traps). Because the live config is gitignored and manually merged, tracked tests
  can be green while the active daemon runs stale rules — reproducing the exact
  duplicate-ping bug. So adoption is **not** considered done on a runbook
  instruction alone: a **recorded artifact captured from the active daemon**
  proving the new observable episode-key guard is loaded is required, and the
  GitHub Issue's closure is tied to that artifact, not to the merge of Phase 1.
  List the exact steps and the artifact-capture command in the runbook.

## Files in scope

- `scripts/**` — a new deterministic predicate/helper that decides ping vs.
  suppress for a CI-failure episode, plus its tests/fixtures `(new)`.
- `agent-orchestrator.yaml.example` — document the corrected CI FAILURE
  DISCIPLINE guard (observable episode-key dedup) so the live rules have a
  canonical tracked reference.
- `docs/**` — architecture decision entry and any operator runbook step for the
  adoption above.

## Files out of scope

- `packages/core/**`, `vendor/**`, `.ao/**` — never touched.
- AO's built-in `ci-failed` reaction behavior (daemon-internal; not modifiable
  from the repo). This issue only changes the orchestrator's side.
- The live `agent-orchestrator.yaml` (gitignored operator config) — adopted by
  the operator, not committed by the worker.
- `worker-message-submit-reconcile` self-submit classification — the ci-failed
  message stays a noop there (71-char self-submitted); this issue does not change
  submit-arbiter behavior.

```denylist
vendor/**
packages/core/**
.ao/**
```

## Acceptance criteria

The predicate is exercised over the full episode-decision matrix (input
dimensions × values), each as a deterministic fixture:

- **Reaction already notified, worker idle, no prior orch ping** → SUPPRESS.
  This is the reproduced duplicate; today the orchestrator sends here.
- **Reaction-first event timestamped before the orchestrator's first
  observation** (same `{repo, PR, head SHA, red-period}`) → MATCH → SUPPRESS.
  The dominant ordering must not be mis-rejected as "stale" for being earlier
  than the orchestrator's turn.
- **Same head SHA, red→green→red** (rerun/flaky) → the post-green red is a **new**
  episode: the prior red-period's reaction event / intent token does **not**
  suppress the new ping.
- **Green missed between turns** (red→green→red where the orchestrator never
  observed the green edge) → still a new episode for the later red (the
  discriminator derives from CI run/attempt identity, not an observed green).
- **Concurrent intent-token claim** — two CI FAILURE DISCIPLINE turns race on the
  same episode with no prior token → exactly **one** claims and sends; the other
  observes the token and SUPPRESSES. The race is exercised through the **tracked
  wrapper and the real configured token store on the supported operator runtime**
  (pwsh / WSL / NTFS-mounted paths), not only an in-memory or POSIX-local
  primitive — or the token store is constrained to a proven-atomic primitive.
- **Restored / replaced worker session** — a reaction event or intent token
  recorded against a **superseded** session, with the active session now the
  notification target for the same `{repo, PR, head SHA, red-period}` → does
  **not** suppress the active session's ping.
- **Active-target rotation during the decision window (TOCTOU)** — the
  notification target rotates between predicate-input capture and apply → the
  decision is **not** applied against the stale target; it re-decides for the new
  active target (no stale SUPPRESS of the active session's only ping).
- **Per-check attempt churn without aggregate green** — a matrix leg is rerun
  (attempt id changes) while aggregate required CI stays continuously red → the
  **same** episode, no new ping.
- **Observable `ao send` failure after token claim** — `ao send` returns a
  definite failure after the claim → the token does **not** permanently suppress;
  it is released for a bounded retry or marked failed-owned and escalated
  operator-visibly (not silent SUPPRESS).
- **CI-source equivalence** — a capture-backed fixture compares the predicate's
  chosen CI source against the basis the reaction observed for the same episode;
  a disagreement does not silently flip the verdict (canonical source / defined
  precedence holds).
- **Reaction event absent, worker idle, no prior orch ping** → SEND (orchestrator
  is the sole notifier; covers the SCM-fetch-failed / reaction-never-fired case).
  On the no-crash path this is exactly one ping; across the crash boundary the
  guarantee is **at most one** claimed send attempt (per the chosen semantics).
- **Worker visibly self-fixing this episode** via an explicit `fixing_ci` report
  correlated to the full episode identity, any reaction state → SUPPRESS. (A new
  *commit* is not a within-episode suppressor — see the New-head row.)
- **Stale `fixing_ci` from an earlier head / red-period / session**, new red
  episode → does **not** suppress.
- **Generic `addressing_reviews` not referencing CI for this head** → does
  **not** suppress (insufficient self-fix signal).
- **Prior orchestrator intent token for this episode, nothing changed** →
  SUPPRESS (no second ping before the worker reports `fixing_ci`, pushes a
  commit, or required CI turns green).
- **New head SHA** (worker pushed a new commit) → the prior head's episode is
  **superseded** (its ping moot — that head is gone); if the new head's required
  CI is red it is a **new** episode re-evaluated from scratch with **no inherited**
  reaction-match or intent token. Proves the new-commit / new-episode semantics do
  not double-suppress or double-send.
- **Same head SHA, additional required check turns red later in the run** → the
  **same** episode: no new episode, no re-ping (the worker already knows CI is
  red for this head).
- **Cross-PR / reopened-branch collision** — a different PR shares the same head
  SHA and failing-check set → the `{repo, PR}` portion of the key keeps the
  episodes distinct; one PR's record never suppresses the other's ping.
- **Stale reaction event from an earlier SHA** present, new episode on a new head
  with no reaction yet → the unbindable/stale event is a no-match → SEND.
- **Reaction event bindability (merge gate)** → a captured
  `reaction.action_succeeded` fixture from a real red-CI episode is shown
  **bindable to the full episode identity** `{repo, PR, head SHA, red-period,
  active target}` — including the minimal stable active-target discriminator, so a
  superseded-session reaction cannot pass the gate yet suppress the active
  session. "Every reaction-first case resolves to no-match" is a **failing**
  outcome (Option B cannot suppress) that must surface the **Residual risk**
  escalation, not pass as green.
- **Transient fetch failure** (`Failed to fetch CI checks`) mid-episode → does
  not create a new episode and does not flip a recorded decision.
- **At-most-once crash boundary around the write-ahead intent token:**
  - intent token written, send succeeds, post-send confirmation lost, next turn →
    SUPPRESS (token owns the episode; no duplicate);
  - intent token written, send-vs-no-send unresolvable after a crash, next turn →
    SUPPRESS (chosen at-most-once mode; the rare lost ping is the documented
    `report-stale` residual, not a duplicate);
  - token present, later turn on the same unchanged episode → SUPPRESS.
- **Final-action schema** → the predicate's terminal output is only SEND or
  SUPPRESS (with error → safe-direction); a test proves a no-match / unbindable
  reaction state is a recorded **diagnostic** and is **never** returned as the
  terminal action.
- **Decision audit** → each fixture asserts the emitted episode-keyed audit line
  records the terminal action (the closed enum **SEND | SUPPRESS** — a helper
  error is `SUPPRESS` + `diagnostic.error_kind=helper_error`, never a third
  value), the suppression basis / reaction-bind diagnostic, reason, bound reaction
  event id (if any), and intent-token state.
- **Closed terminal-action enum** → a wrapper/schema test rejects any predicate
  terminal value outside `SEND | SUPPRESS` (including `error-suppress`, `NO-MATCH`,
  or any third token).
- **Repeated HELPER-ERROR escalation** → after the bounded number of consecutive
  live helper-invocation failures, an operator-visible failure is raised (and
  verification/adoption fails) rather than silent indefinite suppression.
- **Exact-key lookup / retention** → token and audit lookups are by exact episode
  key (a broad scan that could stale-match a sibling episode fails the test); the
  retention/compaction rule keeps growth bounded without dropping records needed
  for recent crash/replay diagnostics. Closure-trigger fixtures cover aggregate
  green, new-head supersession, and **PR closed/merged/branch-deleted**; a
  superseded-target cleanup must not drop the active target's in-flight episode.
- **Live-path-obeys-verdict + invocation (end-to-end)** → the active CI FAILURE
  DISCIPLINE path is shown to **invoke** the predicate through the tracked wrapper
  (repo-root resolution, exit-code/verdict contract, timeout) and send/suppress
  strictly from its returned verdict (including an error verdict), under the
  operator's actual daemon shell/runtime — not treat it as advisory prose,
  proving the fix is enforced at runtime, not just unit-green.

```positive-outcome
asserts: on red CI with no prior reaction event and an idle worker, the predicate decides SEND and the orchestrator emits one CI-failure ping on the no-crash path (at most one claimed send across the crash boundary)
input: external-tool-output
provenance: capture-backed
```

Capture-backed: the reaction-event fixture and the failing-check input use the
real shapes emitted by `ao events list --json` (`reaction.action_succeeded`,
`reactionKey=ci-failed`) and the chosen CI source (`gh pr checks` / `ao status`),
captured from a real red-CI episode — not a hand-invented shape. Captured
fixtures MUST be **minimized and redacted before commit** (see Upgrade-safety):
keep only the fields the predicate binds on — which **includes the minimal stable
target discriminator** used to distinguish the active vs a superseded session, so
the restored-session fixture stays real — and strip auth material, raw message
payloads, operator-local absolute paths, and unrelated session/worker payload not
needed for the test.

## Upgrade-safety check

- No edits to AO core (`packages/core/**`), `vendor/**`, or `.ao/**`.
- No new repo secrets. **Captured fixtures from live `ao events` / CI output are
  redaction-gated** — a fixture-safety check rejects secrets, auth material,
  absolute operator-local paths, and unnecessary message-payload/session fields
  before they land in the tracked test surface.
- No unsupported `agent-orchestrator.yaml` schema additions — the change is to
  `orchestratorRules` prose plus a repo-side predicate the prose calls; no new
  top-level YAML keys are required.
- The built-in `ci-failed` reaction is unchanged; its instant-backstop role and
  `retries` are preserved.

## Verification

- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/90-ci-failure-notify-cross-path-dedup.md` passes.
- The predicate's test suite covers every episode-matrix row above and is green
  (one fixture per equivalence class).
- A documented end-to-end check: simulate a red-CI episode where the reaction
  fires first; confirm the orchestrator's CI FAILURE DISCIPLINE path resolves to
  SUPPRESS for that episode (no second ping), and resolves to SEND-once when the
  reaction event is absent.
- Operator-adoption steps are present in the runbook and name the
  `change-orchestrator-runtime` apply + verify sequence.
- **Live-config equivalence check (blocking adoption artifact).** The runbook
  includes a concrete step that captures a **recorded artifact from the active
  daemon** proving its CI FAILURE DISCIPLINE block contains the new observable
  episode-key guard — comparing the live (gitignored) `agent-orchestrator.yaml`
  rules against the tracked canonical reference, not merely "`ao start`
  succeeded." Issue closure is tied to this artifact (Phase 2), not to the Phase 1
  merge — a tracked fix passing tests while the daemon runs stale rules must be
  caught here. The artifact MUST:
  - be **redacted / digest-based** — the live config is gitignored because it
    holds operator-only detail; capture only the CI FAILURE DISCIPLINE
    block or its fingerprint, rejecting secrets, auth material, absolute local
    paths, and session ids beyond the minimal discriminator (same redaction bar
    as captured fixtures — a runbook command that dumps live config into an
    issue/log must not leak credentials);
  - **pin the executed predicate version, not just the rule text** — config-text
    equivalence does not prove the daemon resolves the wrapper to the *current*
    helper. Include a **redacted repo-root fingerprint / logical repo identity**
    (not a raw absolute local path — those are operator-local and must not leak
    into an issue/log) + git SHA, a wrapper identity, the predicate/helper content
    hash, and **one active-daemon dry-run verdict produced by that exact helper** —
    so closure binds to the running executable, not stale prose over a stale
    checkout.
- **Lost-ping backstop check.** A documented dry-run confirms the at-most-once
  lost-ping state (token written, send never happened, reaction absent) is
  eventually surfaced by `report-stale` (or a named backstop). If it is not, the
  residual is recorded in this issue as **not fully bounded** rather than assumed
  closed.

## Decision log

- **Chosen — orchestrator defers to the reaction's observable event (Option B).**
  The orchestrator's CI-failure ping is gated on a deterministic predicate that
  keys dedup on the `reaction.action_succeeded` / `ci-failed` event (which AO
  *does* emit) plus the worker's self-fix signals. Cheapest path that is both
  enforceable and preserves the Op-6 target (orchestrator still pings when the
  reaction did not fire). Cost: one repo-side predicate + rules edit + operator
  re-adopt.
- **Rejected — collapse to one notifier (Option A).** Drop the orchestrator's
  CI ping and rely solely on the reaction, or vice-versa. Kills the duplicate by
  construction but loses coverage: the reaction is the only notifier when no
  orchestrator turn happens (its documented backstop role), and the orchestrator
  is the only one that pings on a `ready_for_review`-while-red turn (Op-6) and
  when the reaction's fetch fails. Removing either drops a real case.
- **Rejected — shared bidirectional delivery ledger (Option C).** A single
  idempotency token both paths write/check before sending. Most robust but the
  built-in reaction lives in the AO daemon and cannot be made to consult a
  repo-side ledger, so the symmetric version is unbuildable here; the achievable
  asymmetric form collapses to Option B.
- **Class, not case.** Same failure class as the review-trigger head-binding and
  review-send unsatisfiable-predicate bugs: a guard bound to a field/event the
  system never produces. The durable rule — *a "do not duplicate notification"
  guard must dedup on an observable event (`reaction.action_succeeded` for the
  relevant `reactionKey` + episode key), never on a non-emitted "prior `ao send`"*
  — is recorded so future reaction-vs-pack-rule overlaps (e.g. `report-stale`)
  inherit it.
- **GPT adversarial pass 1** (`completed_valid`, `VALIDATION=ok`, NEEDS_ATTENTION,
  7 findings). Accepted/partially-accepted: predicate verdict authoritative not
  advisory + defined helper-failure direction (high); prior-ping record durable/
  observable with a defined crash-safe direction (high); reaction event must be
  *bound* to the episode key or treated as no-match, with a stale-event negative
  test (high); episode-start boundary defined (medium); check-set canonicalization
  + transient-fetch invariant (medium, trimmed to keep the normalization algorithm
  with the planner); live-config equivalence verification (medium); crash/retry
  boundary fixtures (medium). None over-specified into the draft — storage
  surface, helper name, JSON shape, and normalization algorithm stay the
  planner's. GPT's ALTERNATIVE (single idempotent send+record; optional
  intent-ledger) folded into the Binding surface, not adopted as a separate
  design.
- **GPT adversarial pass 2** (`completed_valid`, `VALIDATION=ok`, NEEDS_ATTENTION,
  1 critical + 3 high + 3 medium). Accepted: (critical) one-directional dedup
  cannot meet "regardless of which path fires first" → **Goal narrowed** to
  reaction-first / orchestrator-defers, reverse ordering an explicit non-goal
  with a **Residual risk** block (operator lever = disable/escalation-gate the
  reaction); (high) episode key widened to `{repo, PR, head SHA}` so a shared
  commit across PRs can't cross-suppress; (high) a same-head accumulation of
  failing checks is the **same** episode (check-set dropped from identity → no
  multi-ping in one run); (high) send-success/record-fail was not duplicate-safe
  with the listed observables → replaced "record-after-send" with a **write-ahead
  intent token** the send is idempotent against; (medium) reaction-event
  bindability made a **merge gate** (all-no-match is a failure, not a pass);
  (medium) self-fix bound to the head (generic `addressing_reviews` insufficient);
  (medium) added an **end-to-end** criterion that the live path invokes and obeys
  the predicate verdict, not advisory prose. Planner freedom preserved (token
  storage, helper shape, retry mechanics left open). GPT's ALTERNATIVE to collapse
  to one notifier is the **Residual risk** lever, kept out of scope deliberately.
- **GPT adversarial pass 3** (`completed_valid`, `VALIDATION=ok`, NEEDS_ATTENTION,
  3 high + 3 medium). Accepted: (high) same-SHA red→green→red needs a **red-period
  discriminator** (green ends the episode; a later red is new) so a prior period's
  event/token can't suppress the next ping; (high) the "not predating episode
  start" rule mis-rejected the **legitimate reaction-first** event (instant daemon
  vs turn-driven orchestrator) → binding is by **episode identity, not wall-clock**;
  (high) the crash retry rules demanded an **unobservable** send-vs-no-send
  distinction → resolved by **choosing at-most-once** (ambiguous post-crash →
  SUPPRESS; rare lost ping bounded by `report-stale`); (medium) stale `fixing_ci`
  from an earlier head/red-period/session must not suppress; (medium) added an
  **episode-keyed decision-audit** line for every verdict (also cures the original
  "successful `ao send` leaves no trace" blind spot); (medium) added a **live
  invocation contract** (tracked wrapper, repo-root resolution, exit-code/verdict
  contract, timeout, live check under the operator runtime) so unit-green can't
  mask a daemon that never invokes the helper. GPT re-pitched the single-notifier
  ALTERNATIVE; kept as the documented residual lever, not adopted.
- **GPT adversarial pass 4** (`completed_valid`, `VALIDATION=ok`, NEEDS_ATTENTION,
  3 high + 3 medium — all operational-hardening, no design holes). Accepted:
  (high) intent token must be an **atomic create-if-absent claim** (concurrent
  turns must not both claim and send — the review-start race class) + race
  fixture; (high) red-period discriminator must **survive a missed green**
  (derive from CI run/attempt identity, not an observed green edge) + green-missed
  fixture; (high) committed captured fixtures need a **redaction/minimization
  gate** (live `ao events` can carry session ids/payloads/paths) — credential-leak
  guard on the tracked surface; (medium) **bounded repeated-HELPER-ERROR
  escalation** (operator-visible failure, not silent indefinite suppression);
  (medium) **one canonical CI source** consistent with the reaction's basis (gh
  vs `ao status` disagreement must not flip the verdict); (medium) **exact-key
  lookup + retention/compaction** for tokens/audit records. GPT's
  ALTERNATIVE again the residual single-notifier lever — not adopted.
- **GPT adversarial pass 5** (`completed_valid`, `VALIDATION=ok`, NEEDS_ATTENTION,
  2 high + 2 medium — count dropping, narrowing to delivery/runtime semantics).
  Accepted: (high) `reaction.action_succeeded` evidences *send*, not worker
  *consumption* → scoped suppression to "sent to the active target," cross-linked
  consumption to #89, recorded the residual; (high) session identity made a
  **first-class** part of the episode key (active notification target) with a
  **restored/replaced-session** fixture so a superseded session's event/token
  can't suppress the active ping; (medium) reworded "exactly one" to
  no-crash-exactly-one / at-most-once-across-crash for consistency with the chosen
  semantics; (medium) the atomic-claim race fixture must run through the **real
  wrapper/token-store/runtime** (pwsh/WSL/NTFS), not an in-memory primitive. GPT's
  ALTERNATIVE (sole-notifier lever) unchanged — residual, not adopted.
- **GPT adversarial pass 6** (`completed_valid`, `VALIDATION=ok`, NEEDS_ATTENTION,
  0 high + 3 medium + 1 low — severities collapsed to operational polish).
  Accepted: (medium) operator adoption made **blocking & two-phase** — issue
  closure tied to a recorded active-daemon artifact, not a runbook instruction;
  (medium) the `report-stale` lost-ping bound was **asserted, not verified** →
  added a dry-run check that the lost-ping state is actually surfaced, else the
  residual is recorded as not-fully-bounded; (low) fixture redaction must
  **retain the minimal target discriminator** so the restored-session fixture
  stays real. **Rejected:** `GitHub Issue: TBD` is the correct pre-sync state
  (the sync/publish step assigns the number) — not a draft defect. GPT's
  ALTERNATIVE (two-phase land-then-adopt) was adopted as the adoption framing.
- **GPT adversarial pass 7** (`completed_valid`, `VALIDATION=ok`, NEEDS_ATTENTION,
  2 high + 3 medium — the new surface is the adoption artifact added in pass 6).
  Accepted: (high) the predicate's **terminal action is binary** (SEND/SUPPRESS +
  error→safe) — no-match/unbindable is a recorded **diagnostic**, never a terminal
  verdict, so the live path is never ambiguous (kept the concept, not GPT's field
  names); (high) the **active-daemon adoption artifact needs the same redaction
  bar** as fixtures — digest/block-only, no leaked config secrets/paths/sessions;
  (medium) the `fixing_ci` suppressor must bind to the **full episode identity**
  (red-period + active target), not `{repo,PR,head}`+time, or a stale report
  re-suppresses; (medium) **declared single supported runtime** (pwsh-7+/WSL2)
  rather than a false multi-runtime promise; (medium) the adoption artifact must
  **pin the executed predicate version** (repo root + git SHA + wrapper path +
  helper content hash + one live dry-run verdict), not just the YAML rule text.
  GPT's ALTERNATIVE (typed decision object) folded as contract requirements, not
  a prescribed schema.
- **GPT adversarial pass 8** (`completed_valid`, `VALIDATION=ok`, NEEDS_ATTENTION,
  2 high + 2 medium — narrow runtime/edge refinements of pass-7 additions).
  Accepted: (high) **active-target TOCTOU** — decide against a single target
  snapshot and revalidate the target before applying SEND/SUPPRESS, else a
  mid-window session rotation produces a stale SUPPRESS of the active ping
  (fixture added); (high) an **observable `ao send` failure after the claim** is
  not the ambiguous crash case — the token must not become a permanent silent
  suppressor; release/retry or mark failed-owned and escalate (fixture added);
  (medium) the red-period discriminator must represent the **aggregate** red
  period — per-check/matrix attempt churn without an aggregate green must not
  fragment one episode (fixture added); (medium) cleaned the **self-contradiction**
  where the audit still listed NO-MATCH as a verdict → `terminal_action`
  (SEND/SUPPRESS/error) with separate diagnostic fields, NO-MATCH removed from the
  action enum. GPT's ALTERNATIVE (snapshot object with target generation) folded
  as the snapshot/revalidate contract, not a prescribed schema.
- **GPT adversarial pass 9** (`completed_valid`, `VALIDATION=ok`, NEEDS_ATTENTION,
  2 high + 2 medium — internal-consistency fixes from the widened episode key).
  Accepted: (high) the reaction **bindability merge gate** must require the **full
  episode identity incl. active target**, else a superseded-session reaction passes
  the gate yet suppresses the active ping; (high) resolved the **self-fix vs
  new-head contradiction** — a new commit is *not* a within-episode suppressor; it
  supersedes the old head's episode and starts a fresh re-evaluated episode (only
  an explicit `fixing_ci` report suppresses within an episode); (medium) the
  adoption artifact required repo root yet banned absolute paths → **redacted
  repo-root fingerprint / logical identity**, not a raw path; (medium) defined
  **episode-closure triggers** for retention (aggregate green, new-head
  supersession, PR closed/merged/branch-deleted) + minimum crash-retention. GPT's
  ALTERNATIVE (narrow Phase 1 to reaction-suppression only) noted; kept self-fix in
  scope since its semantics are now unambiguous.
- **GPT adversarial pass 10 (cap)** (`completed_valid`, `VALIDATION=ok`,
  NEEDS_ATTENTION, 1 high + 1 medium, both `partially-addressed` — pure wording
  leaks, no new design hole). Accepted and closed in place: (high) one inline
  reaction-binding sentence still carried the shorter `{repo,PR,head,red-period}`
  tuple → replaced with the full episode identity (shorter tuple marked
  "incomplete context that cannot suppress"); (medium) `terminal_action` wording
  reintroduced `error-suppress` as a third value → enum closed to **SEND |
  SUPPRESS**, helper error recorded as `SUPPRESS` + `diagnostic.error_kind`, plus
  a closed-enum schema test. These two were wording-consistency fixes applied
  **after** the pass-10 capture, so they are not adversarially re-reviewed
  (`post-GPT change not re-reviewed`) — but they introduce no new behavior, only
  align stray text to already-settled contracts.

- **GPT adversarial pass 11 (convergence)** (`completed_valid`, `VALIDATION=ok`,
  **VERDICT=APPROVE, 0 findings, approve_empty=true**). After the two pass-10
  wording fixes, a fresh cold reviewer found **no** correctness hole — a genuine
  empty-APPROVE (the reply enumerates the coverage it actually checked:
  bindability, active-target rotation, concurrent claim, crash boundary,
  observable send failure, live invocation, adoption, retention, redaction,
  CI-source equivalence, lost-ping backstop; and re-acknowledges the scoped
  residuals), not a lazy rubber-stamp. Convergence reached.

**GPT loop:** 11 passes; stopped because **no-accepted-finding-in-last-pass**
(empty-APPROVE convergence, continued past the soft cap-10 at operator direction);
last-pass accepted=0; final STATE=completed_valid VALIDATION=ok
pass=e3c7f106-4ffc-412e-918c-0e9d7785692a
sha=5d0acf3434e4c65086ccfe0807cdb6cafb66ef25472a1d04e8a2abeb34e42a3c. Two
explicit residuals remain recorded in the spec, not closed: the **reverse-ordering
duplicate** (orchestrator-first then reaction; closable only by the operator
reaction-disable lever or AO core) and the **not-fully-bounded lost-ping** if
`report-stale` proves not to cover the at-most-once residual (Verification gates
this).

- **Codex draft-review: operator-waived.** The standard architect `codex review`
  pass on this draft was **not** run — the Codex CLI hit its usage limit, and the
  operator explicitly directed publish without it («публикуй без ревью»). The
  11-pass GPT adversarial loop (converged, empty-APPROVE) is the adversarial
  signal of record for this spec; the Codex draft-review is deferred and may be
  run later against the synced issue. Recorded here so the skipped gate is
  explicit, not silent.
