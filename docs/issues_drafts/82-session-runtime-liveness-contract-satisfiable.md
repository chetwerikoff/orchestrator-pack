# Session runtime liveness must be satisfiable from live AO status output (shared contract)

GitHub Issue: #250

## Prerequisite

- Shipped context (not blocking re-open of these issues — this draft **amends the
  shared contract** they depend on):
  - `docs/issues_drafts/63-review-ready-worker-stuck-guard.md` (GitHub #174) —
    **origin** of `isRuntimeAlive` and its fail-closed semantics
    (`docs/review-ready-stuck-guard.mjs`).
  - `docs/issues_drafts/69-orchestrator-review-send-reconcile.md` (GitHub #202,
    closed, PR #204) — **consumer** of `isRuntimeAlive` for first `ao review send`.
  - `docs/issues_drafts/66-orchestrator-ci-green-wake-worker.md` (GitHub #191) —
    **consumer** for CI-green worker nudge pre-send.
- Complements (do not duplicate):
  - `docs/issues_drafts/76-golden-sample-fixtures-field-shape-guard.md` (GitHub #223)
    — phantom-field / per-variant capture discipline for external-tool fixtures.
  - `docs/issues_drafts/81-reconcile-state-roundtrip-and-supervisor-health.md`
    (GitHub #248) — reconcile state round-trip corruption; orthogonal to runtime
    liveness (same incident family 2026-06-09, different root cause).
- Same **class** as `docs/issues_drafts/74-review-head-ready-report-sha-independent-binding.md`
  (GitHub #218): acceptance proved on fixture shapes the live tool never emits.

## Goal

Make the pack's shared **session runtime liveness** predicate satisfiable on AO 0.9.x
live snapshots so action-producing reconcile paths (#202 first-send, #191 CI-green
nudge, #174 review-ready classification inputs) can fire on a genuinely live,
head-owning worker — without weakening split-brain fail-closed rules when the
process is **affirmatively dead** (`runtime: exited`, `process_missing`, or
terminal session status).

```behavior-kind
action-producing
```

**Incident (2026-06-09).** Review `opk-rev-177` (PR #247, head `9ff9d58`, worker
`opk-31`) completed to `needs_triage` with `sentFindingCount: 0`. Supervised
`review-send-reconcile` logged `linked_session_runtime_not_alive` at 09:30 and
09:33 while the worker was operable (manual `ao review send` succeeded). Root
cause: `isRuntimeAlive` requires `session.runtime === 'alive'`, but
`ao status --json --reports full` on AO 0.9.2 emits **no** `runtime` field;
missing field is fail-closed by design. Fixtures for #202/#174/#191 inject
`"runtime": "alive"`, masking the production shape (#218 class).

## Binding surface

- **Single canonical liveness contract** for all pack paths that gate side effects
  on worker/orchestrator process health from `ao status` session rows. **At least
  three divergent helpers exist today** and MUST be reconciled, not just the two first
  noticed: `isRuntimeAlive` (`docs/review-ready-stuck-guard.mjs`, #174 — missing =
  dead), `isSessionAlive` (`docs/worker-message-dispatch-observe.mjs` — rejects only
  `exited`/`process_missing`, so a present non-live value like `unreachable` falls
  through to "alive"), and `Test-OrchestratorSessionLaunchHealthy`
  (`scripts/lib/Get-OrchestratorLaunchHealth.ps1` — missing/empty = healthy). The
  issue MUST **inventory every gate that reads liveness from `ao status` session rows**
  (the reconcile/trigger/delivery/message-submit family) and, per gate, either migrate
  it to the shared rule or record an explicit out-of-scope rationale — so a "canonical"
  contract cannot ship while a sibling action-producing gate still fails open on a
  present non-live runtime. This issue fixes the **class**, not only #202.
- **Production-representative input.** Liveness MUST be decidable from the same
  session snapshot shape `Get-AoStatusSessions` uses today (`ao status --json
  --reports full`) **without requiring fields the live tool omits**. When AO
  later adds `runtime`, the contract MUST remain correct (affirmative death
  signals still fail-closed).
- **Unify divergent semantics — of the `runtime`-field rule only.**
  `scripts/lib/Get-OrchestratorLaunchHealth.ps1` currently treats a **missing**
  `runtime` as healthy when status is `working`; `isRuntimeAlive` treats missing as
  dead. The shared contract this issue introduces governs **how a `runtime` field
  (absent / affirmative-live / present-non-live) is interpreted** — and only that.
  It does **not** collapse role-specific status semantics: launch-health keeps its
  orchestrator-session status disqualifiers (`detecting`, `stuck`, `probe_failure`,
  `errored`, `exited`, …) and worker paths keep their worker-status set. Both
  modules MUST apply the *same* missing-vs-present `runtime` rule; neither inherits
  the other's status-disqualifier list. Out of scope: re-deriving launch-health's
  per-status orchestrator semantics (those stay owned by their issue, #91).
- **Death remains fail-closed.** Explicit `runtime` values that mean process death
  (`exited`, `process_missing`, and any other values the capture-backed golden
  sample documents as terminal) MUST still block send/nudge/shield paths.
  Terminal **session status** values already enumerated for workers (e.g. `killed`,
  `terminated`, `exited` in the existing non-live set) remain disqualifiers
  independent of `runtime`.
- **Missing vs present is asymmetric (fail-closed default for present values).**
  Only an **absent** `runtime` field falls back to the other liveness signals
  (session status, head ownership). A `runtime` field that is **present but not an
  affirmative live value** (`alive`) MUST be treated as **non-live** — fail-closed —
  whether or not it is one of the enumerated death strings. The contract MUST NOT
  let an unrecognized/degraded present value (e.g. a future AO emitting
  `starting`, `unreachable`, `detecting`, or a renamed non-alive value) fall through
  to "live"; AO explicitly reporting a non-alive runtime is a stronger signal than
  silence. A present value is treated as live only when the capture-backed reference
  documents it as an affirmative live value.
- **`stuck` is not automatically dead.** AO may flag `stuck` / `probe_failure`
  while the process is alive (#174 / #173 flood class). This issue MUST NOT
  conflate "missing `runtime`" with "stuck means dead" — but it also MUST NOT
  grant blanket immunity to unreachable workers (#174 grace/recovery semantics
  stay owned by #174, not re-litigated here).
- **Capture before ship.** Before merging, refresh or add a committed,
  scrubbed capture of `ao status --json --reports full` for at least one **live
  worker** session row (and document AO version). The golden-sample guard (#223)
  anchors session-status variants from that capture; this issue adds the
  **missing-runtime worker row** as a mandatory variant.
- **No upstream AO core edits** in this pack issue. Optional upstream ask (AO
  emits `runtime` on status) may be noted in recovery docs but is not the
  deliverable.

## Files in scope

- `docs/**` — shared liveness module and reconcile decision helpers; golden-sample
  references / capture metadata for `ao status` session rows.
- `scripts/**` — reconcile entrypoints, tests, launch-health alignment.
- `tests/fixtures/**` — production-representative session rows **without**
  synthetic `runtime` unless modelling an explicit death variant.
- `docs/orchestrator-recovery-runbook.md` — diagnosis row for
  `linked_session_runtime_not_alive` when caused by shape mismatch vs genuine death.

## Files out of scope

- `vendor/**`, `packages/core/**`, `.ao/**`.
- Changing #174 grace-window / recovery orchestration rules (only the liveness
  predicate input shape).
- `agent-orchestrator.yaml` / `.example` orchestratorRules text unless a one-line
  cross-reference to the reconciler path is required for operator clarity.
- #248 state-file round-trip (parallel track).

```denylist
# issue 82 — session runtime liveness contract
vendor/**
packages/core/**
.ao/**
```

```allowed-roots
docs/**
scripts/**
tests/**
```

## Acceptance criteria

1. **Production-shape first-send (positive).** With a review run in `needs_triage`,
   `sentFindingCount: 0`, `openFindingCount > 0`, matching PR head, and a linked
   worker session row taken from the **capture-backed** `ao status` worker variant
   that has **no** `runtime` property (and is otherwise live/head-owning), the
   review-send reconcile path plans and executes `ao review send` (fixture dry-run
   + integration test; no synthetic `runtime: alive` on that row).

```positive-outcome
asserts: review-send reconcile plans ao review send for needs_triage run when ao status session row has no runtime field but is otherwise live and head-owning
input: external-tool-output
provenance: capture-backed
```

2. **Production-shape CI-green nudge (positive).** Same capture-backed session row
   (no `runtime`) does not block a qualifying CI-green nudge when all other
   pre-send gates pass — asserted on fixture.

```positive-outcome
asserts: ci-green reconcile plans worker nudge when ao status session row omits runtime but worker owns head and CI transition qualifies
input: external-tool-output
provenance: capture-backed
```

3. **Affirmative death fail-closed (all three consumers).** When the session row
   carries `runtime: exited` or `runtime: process_missing` (per golden-sample
   variant), **none** of the three consumers acts on it: review-send does not send,
   ci-green does not nudge, and the **review-ready stuck guard (#174) does not grant
   the shield** (an affirmatively dead worker stays eligible for recovery). Each
   death variant has a per-consumer fixture asserting the skip / no-shield with an
   enumerable reason — the shield path is tested for death, not only the two
   action-producing send paths.

4. **Terminal status fail-closed (all three consumers).** Session status in the
   existing non-live worker set (e.g. `killed`, `terminated`) disqualifies **all
   three** consumers regardless of `runtime` presence or absence: review-send no
   send, ci-green no nudge, and review-ready stuck guard **no shield** (a terminal
   worker stays eligible for recovery even if its row also carries `runtime: alive`).
   Fixture per status, with `runtime`-present and `runtime`-absent variants.

   > **Consumer-coverage rule (applies to AC 3, 4, 5a, 10).** Every disqualifier
   > this contract defines (affirmative death runtime, terminal/non-live status,
   > present-non-live runtime) MUST be asserted for **all three** consumers — and the
   > review-ready guard's "no shield" is a first-class assertion, not an afterthought
   > to the two send paths. A disqualifier proven only for review-send / ci-green
   > does not satisfy this issue.

5. **AO adds `runtime: alive` (forward compatibility).** A session row with explicit
   `runtime: alive` still passes liveness; death variants still fail — fixtures for
   both.

5a. **Unknown / non-live present `runtime` fails closed.** A session row carrying a
    `runtime` value that is **present but not the affirmative live value** and is
    **not** in the enumerated death set (e.g. a future/renamed `starting`,
    `unreachable`, `detecting`) MUST be treated as **non-live**: review-send and
    ci-green plan no send/nudge, and the review-ready guard does not grant the shield
    on the strength of that value. Fixture per consumer asserts the present-unknown
    value does **not** fall through to "live" — distinguishing it from the
    **absent**-field case (AC 1–2), which does fall back to status/head signals.

6. **Unified contract.** Launch-health / orchestrator health checks and reconcile
   liveness gates use the **same** documented rules for missing vs present
   `runtime` (no "missing = healthy" in one module and "missing = dead" in
   another).

7. **Phantom-field guard (#223 alignment).** Session fixtures used by the three
   consumers cannot require `runtime` on the default live-worker `ao status` variant
   unless the capture-backed reference documents that field as present for that
   variant — enforced by the #223 guard or an issue-local test that fails if the
   default happy-path fixture includes `runtime` while the reference omits it.

8. **Incident regression.** A fixture models the 2026-06-09 `opk-rev-177` shape:
   `needs_triage`, `sentFindingCount: 0`, worker linked, AO status row without
   `runtime` → plan contains `send`, not `linked_session_runtime_not_alive`.

9. **Operator diagnosis.** Recovery runbook distinguishes:
   - genuine death (`runtime` terminal / non-live status),
   - shape/contract mismatch (historical `linked_session_runtime_not_alive` on live
     worker — fixed by this issue),
   - #174 false-stuck / flood (separate row, unchanged).

10. **#174 shield boundary holds after relaxing missing-runtime (regression for the
    widened shield).** Because the review-ready stuck guard (#174) consumes the same
    liveness predicate, relaxing **absent** `runtime` from "dead" to "fall back to
    status" widens which `stuck` / `probe_failure` sessions can be shielded from
    false-stuck recovery. The spec MUST pin both sides with capture-backed
    missing-runtime worker rows in `stuck` and `probe_failure`:
    - **(a) shield preserved:** a missing-runtime `stuck`/`probe_failure` worker that
      owns the current head, has a covering clean run and ready-for-review report, and
      shows **no** unreachability evidence is still shielded within the existing grace
      window — recovery is **not** triggered merely because `runtime` is absent.
    - **(b) recovery not blocked:** the same missing-runtime session is **not**
      granted blanket immunity — when the existing #174 recovery signals fire
      (bounded reachability failure, delivery unconfirmed/escalated, or flood not
      cleared), the guard still permits recovery. The grace/recovery mechanism itself
      stays owned by #174; this AC only proves absent-`runtime` does not silently
      disable it.
    - **(c) capture operability (#223 discipline):** the **missing-`runtime` field
      shape** for the worker row MUST be anchored to a real committed live-worker
      capture (per the pre-merge gate). The `stuck` / `probe_failure` **status**
      variants — being transient and hard to capture on demand — MAY be constructed by
      overlaying that captured field shape with the independently-enumerated status
      value, recorded as a documented #223 exception with a named follow-up to refresh
      from a genuine degraded capture if one is later observed. A planner MUST NOT
      block merge waiting for a rare live degraded state, nor silently synthesize the
      whole row.

11. **Pre-action recheck not weakened by the relaxed field (freshness parity).**
    Relaxing the runtime-field rule removes a hard process-health signal from the
    positive path, so the existing pre-action recheck MUST NOT regress. Each consumer
    re-validates the linked session against a fresh `ao status` read at the action
    boundary — session still present, same identity/role, still owns the current PR
    head, status + runtime-field rule still pass — **before** emitting a side effect or
    granting the #174 shield; if the session disappeared, changed identity, lost head
    ownership, or the fresh read is unavailable/ambiguous, the consumer fails closed
    with an enumerable reason. This is **parity with (and extension of) the recheck
    #202 already performs**, now explicitly covering ci-green nudge and the #174 shield
    grant — not a new bespoke re-read mechanism. Fixture/integration asserts a row that
    was eligible at snapshot but stale at recheck (head moved / session gone) yields
    no send/nudge/shield.

12. **Liveness-gate inventory is complete (no sibling fails open).** The PR enumerates
    **every** repo gate that decides worker/orchestrator liveness from `ao status`
    session rows — at minimum `isRuntimeAlive` (#174), `isSessionAlive`
    (`worker-message-dispatch-observe`), the message-submit reconcile path
    (`worker-message-submit-reconcile`), launch-health, and the review-send / ci-green /
    review-trigger / delivery-confirm consumers — and for each records **migrate** (now
    applies the shared missing-vs-present runtime rule) or **out-of-scope** (named
    reason, e.g. purely observational with no side effect). Every **action-producing**
    gate in the inventory MUST fail closed on a present non-live runtime (e.g.
    `unreachable`), proven by a fixture — closing the `isSessionAlive` fall-through the
    same way AC 5a closes it for review-send/ci-green. A grep/test asserts no remaining
    side-effecting gate treats a present non-affirmative-live runtime as live.

## Upgrade-safety check

- No edits to `vendor/**`, `packages/core/**`, or `.ao/**`.
- No new repository secrets or GitHub Actions permissions.
- Split-brain envelope preserved: no new `ao spawn`, `--claim-pr`, `ao session kill`,
  or `ao report` on these paths.
- Fail-closed on **affirmative** death signals; fix applies to **missing-field**
  unsatisfiability only.

## Verification

- Vitest suites for review-send, ci-green-wake, and review-ready-stuck-guard pass
  with new capture-backed fixtures.
- **Launch-health coverage proves AC 6 (not assumed).** `Get-OrchestratorLaunchHealth.ps1`
  has its own tests exercising the **same** missing-vs-present `runtime` rule:
  absent, affirmative-live, terminal, present-unknown, and present-empty/null (as
  PowerShell may serialize it) — asserting a present non-affirmative-live value
  (including the empty string the current `-and`-guarded check lets through) is
  treated as **non-live**, while its orchestrator-status disqualifier list is
  unchanged. AC 6 is a divergence-closing assertion across the JS and PowerShell
  sides, so coverage on **both** is mandatory; passing only the JS consumer suites
  does not satisfy it.
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1` passes for this draft
  (`behavior-kind`, `positive-outcome`).
- Golden-sample / phantom-field guard ( #223 ) includes the `ao status` session row
  reference used by criteria 1–2.
- **Pre-merge operator step (recorded in PR body):** on a machine with a live worker
  session, capture `ao status --json --reports full` and confirm the committed
  reference matches (AO version noted). If zero sessions, block merge until capture
  is refreshed on next live worker — do not ship on assertion alone.
- Grep confirms no remaining reconcile happy-path fixture that **requires**
  `runtime: alive` while the capture-backed default worker variant omits `runtime`.

## Decision log — adversarial Codex review

Pass 1 (`needs-attention`, 3 findings):

- **F1 (high) — relaxing missing-runtime widens the #174 stuck/probe_failure shield
  with no AC pinning the recovery boundary → ACCEPT.** The review-ready guard
  consumes the same predicate (`reviewReady = reasons.length === 0`; `runtime_not_alive`
  is one reason), so absent-runtime now removes a gate that kept missing-runtime
  workers out of the shield. Added AC 10 (a/b): shield preserved without unreachability
  evidence; recovery still permitted when #174 signals fire. Referenced #174's existing
  recovery inputs rather than redefining its grace mechanism (stays in scope).
- **F2 (high) — unknown present `runtime` values could fall through to "live" → ACCEPT.**
  Added the missing-vs-present **asymmetry** to the binding surface (absent = fall back
  to status; present-non-`alive` = fail-closed) and AC 5a (per-consumer fixture for an
  unknown present value). Closes a forward-compat hole and reinforces F1.
- **F3 (medium) — one predicate couples worker side-effects and orchestrator launch
  health → PARTIAL.** Valid drift kernel, but the proposed remedy (role-specific
  subcontracts + per-status orchestrator ACs) over-specifies and creeps into #91
  launch-health scope. Instead scoped "unify" to the **`runtime`-field interpretation
  rule only**; role-specific status disqualifiers stay each module's own (and #91's).
  Rejected the per-status AC battery as scope creep.

Pass 2 (`needs-attention`, 1 finding):

- **F4 (high) — affirmative death (`exited` / `process_missing`) not acceptance-tested
  for the #174 shield consumer → ACCEPT.** AC 3 originally only required review-send
  and ci-green death fixtures; a planner could leave the shield protecting an
  affirmatively dead worker. Extended AC 3 to all three consumers, requiring the
  review-ready guard to **not** shield on a death-runtime row (symmetric to AC 10's
  missing-runtime case).

Pass 3 (`needs-attention`, 1 finding):

- **F5 (high) — terminal session status (`killed`/`terminated`) not acceptance-tested
  for the #174 shield consumer → ACCEPT.** Same class as F4 but for AC 4 (status, not
  runtime). Extended AC 4 to all three consumers and added a **consumer-coverage rule**
  (AC 3/4/5a/10): every disqualifier must assert the review-ready guard's "no shield",
  not only the two send paths — closing the per-AC walk generally rather than one AC at
  a time.

Pass 4 (`needs-attention`, 2 findings):

- **F6 (high) — AC 6 (unified contract) not provable; launch-health untested → ACCEPT.**
  Verification only listed JS-consumer Vitest suites; `Get-OrchestratorLaunchHealth.ps1`
  (PowerShell) was unproven, and its `$Session.runtime -and …` guard lets a present
  empty string pass as healthy — diverging from the new present-non-live rule. Added a
  Verification item requiring launch-health coverage on the same rule (absent / alive /
  terminal / present-unknown / present-empty), preserving its status disqualifiers.
- **F7 (medium) — AC 10 capture-backed `stuck`/`probe_failure` rows not operable → ACCEPT.**
  Those states are transient/hard to capture; the gate as written forces block-or-
  synthesize. Added AC 10(c): anchor the missing-`runtime` **field shape** to a real
  capture, allow status-variant construction under a documented #223 exception with a
  refresh follow-up; no indefinite block, no silent full-row synthesis.

Pass 5 (`needs-attention`, 1 finding):

- **F8 (high) — stale-snapshot race; relaxed field removes a hard health signal from
  the positive path → PARTIAL.** Valid kernel: draft was silent on preserving the
  pre-action recheck. But the staleness race predates this issue and #202 already
  rechecks before send; on AO 0.9.2 an exited worker still surfaces a terminal
  **status** (caught by AC 4), so the relaxation widens only the head-movement/
  session-replacement window. Added AC 11 requiring **recheck parity** (preserve #202's
  recheck, extend to ci-green nudge and the #174 shield, fail-closed on
  change/disappearance) — rejected the "invent a new single-snapshot read" framing as
  duplicating recheck logic the planner already owns.

Pass 6 (`needs-attention`, 1 finding):

- **F9 (high) — "canonical contract" claimed but a sibling gate (`isSessionAlive`) was
  never inventoried and fails open on present non-live runtime → ACCEPT.** Verified a
  **third** divergent helper: `isSessionAlive` (`worker-message-dispatch-observe.mjs:370`)
  rejects only `exited`/`process_missing` then falls back to status, so a present
  `runtime: unreachable` is treated as alive; grep shows further gates
  (`worker-message-submit-reconcile`, `review-finding-delivery-confirm`, `review-trigger-*`).
  Strengthened binding-surface bullet 1 (names the 3 known helpers, requires a full gate
  inventory) and added AC 12 (inventory + migrate-or-document per gate; every
  action-producing gate fails closed on present non-live runtime). Directly serves the
  issue's "fix the class" intent.

Pass 7 (`approve`, 0 findings): loop converged. Accepted across the run: F1, F2, F4, F5,
F6, F7, F8 (partial), F9. Rejected: F3 (scope creep into #91). Net effect: the draft
moved from a missing-field happy-path fix to a shared-contract spec covering all
liveness gates, both fail-open (present non-live) and fail-closed (#174 shield) edges,
launch-health provability, capture operability, and pre-action freshness.
