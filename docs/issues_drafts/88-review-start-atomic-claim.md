# Single-flight automated review starts per (PR, head): atomic claim shared by all trigger surfaces

GitHub Issue: #267

## Prerequisite

- `docs/issues_drafts/58-safe-review-trigger-reconciliation.md` (GitHub #163,
  closed) — the periodic state-derived reconciler; one of the three automated
  starter surfaces this issue arbitrates. Its eligibility predicate and
  split-brain envelope (review-run only, zero worker lifecycle) are unchanged.
- `docs/issues_drafts/70-orchestrator-event-driven-review-trigger.md` (GitHub
  #207, closed) — the wake-listener completion-wake trigger; second starter
  surface. Its "covered-head dedupe via run state (#189, residual TOCTOU
  benign)" assumption is the defect this issue removes.
- `docs/issues_drafts/78-review-trigger-reeval-ready-after-early-wake.md`
  (GitHub #235, closed) — the deferred-head watch; third starter surface. Its
  "only #189 TOCTOU duplicate tolerated" clause is superseded here.
- `docs/issues_drafts/65-orchestrator-no-rereview-covered-head.md` (GitHub
  #189, closed) — covered-head idempotency. Kept as-is for sequential dedupe;
  this issue closes the concurrent window #189 explicitly left open.
- `docs/issues_drafts/85-review-trigger-terminal-worker-fallback.md` (GitHub
  #261, closed) — quiescent-worker fallback whose pre-run recheck moves inside
  the claim window; eligibility semantics unchanged.
- `docs/issues_drafts/71-orchestrator-side-process-supervisor.md` (GitHub #205,
  closed) — supervises all three starter processes; the log-preservation
  criterion below lands on its child-logging surface.

## Incident (evidence)

2026-06-11 04:30:11–14Z, PR #266 head `fd2fdb66`: three concurrent
`ao review run` — opk-rev-222 (review-trigger-reeval, watch seeded 04:29:57 by
`wake_defer`), opk-rev-223 (review-trigger-reconcile, 10-min tick coincided),
opk-rev-224 (wake-listener review-wake-trigger; orchestrator LLM had zero
events in the window). All three snapshots were taken before any of the three
run records became visible in `ao review list`. Cost: 3× reviewer runs on one
head; findings from all three were sent to the worker. The race is structural:
the listener and the reeval watch both react seconds-scale to the same
completion wake, so the pair collides on every burst; the periodic reconcile
tick joins whenever it lands inside the window.

## Goal

Automated review starts are **single-flight per (PR number, exact head SHA)**:
at any moment at most one automated `ao review run` is in flight or being
started for a key, no matter how many trigger surfaces decide concurrently.
Re-starts on the same key happen only through the existing failed/cancelled
retry discipline (#60/#98), itself claim-arbitrated — so "single-flight"
and "retry after failure" are one invariant, not two. A crashed or failed
starter never leaves a ready head permanently unreviewed.
Duplicate suppression is by construction (an atomic cross-process reservation
acquired before the run), not by advisory re-checks whose race window the
incident measured at multiple seconds. Losing surfaces record a visible,
attributable skip. The "residual TOCTOU is benign/tolerated" language inherited
from #189/#207/#235 is retired from the canonical rules.

```behavior-kind
action-producing
```

## Binding surface

- **Claim contract.** A reservation keyed by (PR number, normalized head SHA)
  that every automated starter surface — periodic reconcile (including its
  internal start reasons such as the #261 quiescent-worker fallback, which is
  a reconcile decision branch, not a separate process), wake-listener
  trigger, deferred-head reeval, and any future automated starter — must
  acquire **atomically across separate OS processes** before invoking
  `ao review run` for that key. Acquisition must be a true test-and-set (two
  concurrent acquirers cannot both win), durable enough to survive the
  acquirer's crash, and observable by the other surfaces with no registration
  lag. The mechanism (file-create semantics, journal, lock directory, …) is
  the planner's choice; the atomicity, durability, and zero-lag observability
  properties are the contract. Acquisition publishes a **complete, usable
  claim record atomically** (holder, key, acquisition time — whatever the
  contract's other properties need); a partially-written or unreadable claim
  record encountered by any surface is classified ambiguous and handled by
  the fail-closed escalation path, never auto-recovered as stale and never
  treated as no-claim.
- **One key derivation rule.** Every surface derives the claim key the same
  way: PR number plus the full, exact, consistently-normalized head SHA taken
  from the same post-recheck source the eligibility decision used. A surface
  that cannot produce a full unambiguous SHA for the key fails closed (no
  claim, no run, visible skip) — short, mixed-normalization, or
  different-source SHAs must not be able to split one head into two keys.
- **Recheck inside the claim.** The existing pre-run head-ready recheck
  (#189/#261 semantics, unchanged) executes after claim acquisition, so the
  snapshot it trusts cannot be invalidated by a concurrent sibling start.
- **Stale-claim recovery.** A claim whose `ao review run` never registered a
  run record within a bounded, configurable interval may be recovered so the
  head still gets reviewed — and recovery itself must be an atomic ownership
  transfer with the same test-and-set property (two concurrent recoverers
  cannot both win), must survive process restart without falsely re-arming,
  and must leave an audit record naming the recovered claim and the recovering
  surface. Ambiguity (cannot tell whether a run was registered) fails closed
  to no duplicate, with a visible escalation rather than a silent dead head.
  The recovery interval's default must exceed the worst-case observed
  claim-to-run-registration latency by a wide margin (registration is seconds;
  the interval is minutes), so a slow-but-live claimant is not classified
  stale by tuning accident. A configured interval below a documented safe
  floor is rejected or clamped at startup with a visible warning — unsafe
  tuning must not silently reintroduce duplicate recovery.
- **Ownership fencing at the run boundary.** A surface invokes `ao review run`
  only while it still owns the claim, re-verified immediately before
  invocation; a stalled claimant that resumes after its claim was recovered
  detects the ownership loss and aborts with an audit record instead of
  starting. The residual stall window between the final ownership check and
  the invocation is accepted and documented — it is bounded by the
  minutes-scale recovery interval versus the seconds-scale invocation, the
  same order-of-magnitude argument as the recovery default above.
- **Claim-storage failure fails closed and loudly.** When the claim namespace
  is missing, unwritable, or unreadable/corrupt, the surface starts nothing on
  that tick (never "no claim available, proceed anyway") and emits a visible
  escalation, consistent with the existing untrusted-state-fence behavior of
  the reconcile children — a broken claim store must surface as a loud stall,
  not as duplicates and not as a silent dead head.
- **Escalations are resolvable, not terminal.** Every fail-closed escalation
  (ambiguous claim, partial record, storage failure, anomalous timestamp) has
  an **audited operator-resolution path**: a documented operation that
  re-checks current coverage and head state and then clears or re-arms the
  key, leaving an audit record. Without this, fail-closed branches would
  contradict the liveness goal ("never permanently unreviewed") by turning a
  corrupt record into a permanent loud deadlock. Resolution is
  operator-initiated; automation never self-clears an ambiguous escalation.
- **Claim lifecycle is terminal-state explicit.** A claim ends in exactly one
  observable outcome — run started, aborted by the in-claim recheck, released
  for retry after run failure, recovered as stale, or escalated as ambiguous —
  and an aborted-by-recheck claim never enters stale-claim recovery or
  escalation (aborted and stale are distinguishable in the record). "Run
  started" means a **registered covering run record is visible** — the claim
  stays effective (the key unacquirable) from acquisition until that
  visibility or a resolved failure outcome, never released on mere process
  invocation, so the registration-lag window cannot reopen between invoking
  `ao review run` and its record appearing. Outcome names and storage shape
  are the planner's choice; the disjoint-outcomes property, the
  visibility-anchored "started", and the aborted≠stale distinction are the
  contract. Terminal claim records are retained bounded (enough to
  reconstruct recent incidents and satisfy the audit requirements above, not
  unbounded growth of the claim namespace); the bound is the planner's
  choice.
- **Single claim namespace.** All automated starter surfaces resolve one
  canonical machine-local claim namespace (one resolution rule shared by
  every surface — not per-surface defaults), and each surface validates and
  logs the resolved namespace at startup, so a path-resolution mismatch
  (e.g. `/tmp` vs the supervisor state root) cannot silently split the claim
  space back into independent per-surface views. **Stated precondition:**
  all automated starter surfaces for a repo run on one machine (the current
  single-operator-host topology); running supervised automation for the same
  repo on a second host is outside this contract and is called out as such
  in the runbook.
- **Run-failure release.** When `ao review run` exits non-zero under a held
  claim, release is conditional on a post-exit coverage check: the key becomes
  eligible again (for the existing failed/cancelled retry discipline, #60/#98,
  through the claim) only when no registered or in-flight run exists for the
  key or a failed/cancelled terminal is visible; when the post-exit state is
  ambiguous (a run may have partially registered), the claim escalates without
  re-arming — the same fail-closed rule as stale recovery, applied at the
  immediate failure boundary. Duplicate worker-visible findings across a
  legitimate retry (a failed run that already emitted findings, then a retried
  run emitting its own) are an **accepted residual owned by the existing retry
  and finding-delivery disciplines** (#60/#98, #171/#202) — this contract
  arbitrates starts, not finding delivery.
- **Loser visibility.** A surface that finds the key already claimed skips
  with a logged reason that names the key and the claim holder, with holder
  identity sufficient to correlate the claim to the right supervisor child
  log and process generation after a restart (surface name alone does not
  distinguish a live holder from a dead pre-restart one); distinguishable
  from every other defer/skip subreason (#212).
- **Manual override stays manual — with an explicit residual.** Operator-invoked
  `ao review run` is not routed through the claim; automation must tolerate
  (not duplicate, not crash on) runs that appear without a claim once their
  run record is visible. A manual run racing an automated start inside the
  registration-lag window can still produce a duplicate; that residual is
  **operator-owned and accepted by this contract** (documented in the runbook,
  not silently unstated) — the claim guarantees exactly-one among automated
  starters only.
- **Rule-text update.** The canonical `orchestratorRules`
  (`agent-orchestrator.yaml.example`) and `prompts/agent_rules.md` clauses
  descending from #189/#207/#235 stop describing the concurrent duplicate as
  benign/tolerated and instead state the claim contract. The listener's
  trigger-before-wake-dedup ordering (#207) is preserved.
- **Split-brain invariant (PR #97).** All starter surfaces remain review-run
  only: no `ao spawn`, no `--claim-pr`, no `ao session kill`, no `ao send`
  from these processes. The claim adds arbitration, not new side effects.
- **Evidence preservation.** Supervisor child logs survive child/supervisor
  restart (rotate or append — bounded retention; no truncate-on-start), and
  retention at minimum keeps the previous process generation's log readable
  after a restart — enough to reconstruct one full incident across the
  restart that follows it. The 2026-06-11 incident logs survived only because
  they were read minutes before a restart wiped them.
- **Honest start accounting.** Every automated starter surface's tick/turn
  summary distinguishes actually-started runs from claim-skipped and
  recheck-aborted attempts (today reconcile's `started` increments even when
  the pre-run recheck aborts the start; listener and reeval must not repeat
  that pattern).
- **Drift guard.** A mechanical check (same family as the existing
  `scripts/check-*.ps1` static guards, wired into CI like its siblings) fails
  when repo-owned automated code reaches the review-run CLI verb outside the
  claim contract — scanned repo-wide over automated entrypoints (so a future
  starter added outside today's three surfaces is caught), covering indirect
  paths (wrappers, shared helpers, module functions), with an explicit
  allowlist for operator/manual tooling and documentation. The guard **scans**
  repo-wide — including `plugins/**`, which the denylist closes to edits but
  not to scanning; plugins are not automated starter surfaces (the reviewer
  plugin consumes runs, it does not start them), and the guard enforces that
  this stays true. The automated/manual distinction is bound to invocation
  context, not filename or label: any repo-owned path that can be invoked
  non-interactively (supervisor child, CI, event hook, scheduled task) and
  reaches the review-run verb must be claim-gated; the allowlist may carry
  only genuinely interactive operator tooling, every entry with a recorded
  justification, and an unjustified or unlisted reachability fails the guard
  by default.
- **Operator adoption** (orchestrator-side processes change): after merge the
  operator stops **all** supervised children and starts the new generation
  (stop-all-then-start, not a rolling/partial restart, per the recovery
  runbook), then verifies no stray pre-claim starter process remains running
  outside the supervisor (process-table check on the starter command lines);
  verification exercises all three surfaces — a supervised reconcile tick
  **and** a synthetic/fixture completion wake driving the listener and reeval
  paths — with the new skip/claim log lines present and no duplicate runs on
  a test head. One seconds-wide, once-per-adoption residual is **explicitly
  accepted**: a pre-claim start launched by the old generation immediately
  before stop-all may still be registering when the new generation begins;
  the runbook therefore has the operator check `ao review list` coverage
  after restart before trusting the first new-generation tick — a drain
  mechanism for this one-time window is deliberately not built.

## Files in scope

- `scripts/**` (starter entrypoints, shared lib helpers, static checks; new
  claim helper and its check are `(new)`)
- `docs/*.mjs` mechanical filters owned by the three starter surfaces
- `tests/**` and starter-surface fixtures
- `agent-orchestrator.yaml.example` (`orchestratorRules` wording)
- `prompts/agent_rules.md` (rule-text update)
- `.github/workflows/**` (wiring the drift guard alongside existing checks)
- `docs/orchestrator-recovery-runbook.md` / go-live docs (operator adoption)

## Files out of scope

- `packages/core/**`, `vendor/**` (AO internals; `ao review run` permissiveness
  is consumed as-is, not patched)
- `plugins/**` (reviewer plugin behavior unchanged)
- `docs/issues_drafts/**` other than this draft
- Worker lifecycle paths (spawn/respawn/kill) and `ao send` messaging surfaces

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
plugins/**
```

## Acceptance criteria

Each row of the scenario matrix is an equivalence class and must be covered by
at least one fixture-backed test; cells marked *(incident)* must additionally
be reproduced with production-representative captures from the 2026-06-11
incident (`ao review list --json` run shapes; the 04:29:57 `wake_defer`-seeded
reeval watch JSON for the listener+reeval pair). The incident captures live as
**repo-local redacted fixtures** (checked in with the tests, consistent with
the golden-sample provenance discipline), so the capture-backed criteria are
reproducible by CI and reviewers — not satisfiable by synthetic substitutes.

| # | Class (dimensions: surface × claim state × run visibility × head × claimant fate × wake multiplicity) | Expected outcome |
|---|---|---|
| 1 | ≥2 surfaces decide inside the registration-lag window, no claim yet, no run record *(incident)* | exactly one run starts; every loser logs the claim-holder skip |
| 2 | Run in-flight visible for the key | skip (existing #189 behavior, unchanged) |
| 3 | Covered-terminal run visible for the key | skip (existing #189 behavior, unchanged) |
| 4 | failed/cancelled run on the key | retry discipline (#60/#98) runs through the claim; still at most one concurrent retry |
| 5 | Claimant crashed between claim and run; recovery interval elapsed; no run record | exactly one recovery start (concurrent recoverers do not duplicate) |
| 6 | `ao review run` failed under a held claim | key becomes eligible again; no permanent dead head; no duplicate while held |
| 7 | Head superseded between claim and run | in-claim recheck aborts; claim does not block the new head |
| 8 | Wake burst delivers N triggers for one key (listener pre-dedup ordering preserved) | one run; N−1 attributable skips |
| 9 | Manual operator run appears with no claim (record visible) | automation treats the run record as coverage; no duplicate, no crash; the in-lag manual race is the documented operator-owned residual, not a test obligation |
| 10 | Reeval watch + listener fire on the same completion wake (the guaranteed pair) *(incident)* | one run, one attributable skip |

```positive-outcome
asserts: with three starter surfaces deciding concurrently on one (PR, head) whose ao review list snapshot shows no covering run, exactly one ao review run is invoked and the other two log claim-holder skips
input: external-tool-output
provenance: capture-backed
```

- Cross-process atomicity is demonstrated by a test that races at least two
  concurrent acquirers on one key and proves a single winner (not merely two
  sequential calls), executed on the supported runtime platform for the
  supervised children (Linux/WSL2 pwsh 7+, per #118 portability).
- Stale-claim recovery raced by two concurrent recoverers yields exactly one
  recovery (single-winner ownership transfer) plus an audit record; an
  aborted-by-recheck claim never appears as stale-recovered or escalated.
- A slow-but-live claimant (run registration delayed but under way) is not
  recovered prematurely under the default interval; a stalled claimant that
  resumes after recovery aborts on the pre-invocation ownership check with an
  audit record, and no second run starts from it.
- With the claim namespace missing, unwritable, or corrupt, no surface invokes
  `ao review run`, and a visible escalation record is produced (fail-closed
  fixture for each storage-failure shape).
- A fixture where two surfaces derive the key from divergent SHA forms (short
  vs full, mixed normalization) proves the contract fails closed rather than
  producing two claims for one head.
- A non-zero `ao review run` with ambiguous post-exit state (run possibly
  registered) escalates without re-arming the key; a non-zero exit with no
  registered run releases for retry.
- The drift guard catches a fixture starter entrypoint added outside the three
  shipped surfaces that reaches the review-run verb without the claim, and at
  least one bypass fixture reaches the verb **indirectly** (through a shared
  helper or wrapper), not only by direct literal invocation.
- A partially-written or unreadable claim record (crash between reservation
  and metadata publication) is classified ambiguous: visible escalation, no
  auto-recovery, no treat-as-unclaimed — fixture-backed.
- Claim staleness uses a validated age source: a future-dated or otherwise
  anomalous claim timestamp routes to ambiguous escalation rather than
  automatic recovery — fixture-backed.
- The audited operator-resolution path clears an ambiguous escalation only
  after re-checking coverage and head state, leaves an audit record, and
  restores the key to normal arbitration — fixture-backed.
- An allowlisted-but-non-interactively-invocable path that reaches the
  review-run verb fails the drift guard (negative allowlist-governance
  fixture).
- A second acquirer racing the window after `ao review run` invocation but
  before the run record is visible finds the key still held (claim not
  released on invocation) and skips — fixture-backed.
- A manual (no-claim) run whose record becomes visible while a claimant holds
  the claim but has not yet invoked `ao review run` causes the in-claim
  recheck to abort the automated start (visible coverage wins even after
  acquisition) — fixture-backed.
- The canonical `orchestratorRules` and `prompts/agent_rules.md` no longer
  contain the "residual TOCTOU benign/tolerated" wording (verifiable text
  check on the shipped rule files).
- The claim path is start-reason-agnostic: a reconcile start with the #261
  `quiescent_worker_handoff_fallback` reason flows through claim acquisition,
  loser skip, and recheck-abort accounting identically to a plain start —
  fixture-backed.
- A recovery interval configured below the documented floor is rejected or
  clamped at startup with a visible warning (negative configuration fixture).
- Every starter surface logs its resolved claim namespace at startup, and a
  fixture proving a namespace mismatch is detectable (mismatched resolution
  fails loudly rather than silently splitting the claim space).
- Skip lines for a claimed key are distinguishable from every existing defer
  subreason (#212) and carry holder identity restart-correlatable to the
  supervisor child log and process generation (surface name alone does not
  pass).
- Stale-claim recovery interval is configurable; the ambiguous branch (run
  registration unknowable) produces an escalation record, not a second run.
- Child logs from before a supervisor/child restart remain readable after the
  restart (bounded retention is acceptable; truncation to zero is not).
- The reconcile tick summary reports `started=0` for a tick whose only
  planned start was aborted by the in-claim recheck.
- The drift guard fails on a fixture starter that calls `ao review run`
  without the claim, and passes the three shipped surfaces.
- Closed-sibling regression: existing #163/#189/#207/#235/#261 fixtures still
  pass with the claim in place (no behavior change outside the concurrent
  window).

## Upgrade-safety check

- No AO core (`packages/core/**`) or `vendor/**` edits; AO 0.9.x
  `ao review run` / `ao review list` CLI consumed as-is.
- No new repo secrets; claim state lives in existing local state locations
  (machine-local, gitignored), never in the repo.
- No new always-on processes: the claim is a library/contract used by the
  existing supervised children, not a new daemon.
- `agent-orchestrator.yaml.example` stays schema-valid for AO 0.9.x (prose
  rules only; no unsupported YAML keys).

## Verification

- Vitest fixture suites for matrix classes 1–10, including capture-backed
  fixtures for class 1 (incident shapes) and the positive-outcome block.
- A race test proving single-winner acquisition under genuine concurrency.
- `pwsh -NoProfile -File scripts/review-trigger-reconcile.ps1 -Once -DryRun`
  (and the listener/reeval equivalents with their fixtures) show the new
  claim/skip log lines and unchanged eligibility decisions.
- Drift-guard check runs green in CI for the repo as shipped and red on the
  bypass fixture.
- Runbook/go-live docs contain the operator adoption steps; a supervised
  restart on a dev machine completes one tick cycle with no duplicate run on
  a fixture head.

## Decision trail

- **Option A — one shared lock file + recheck inside the lock (all surfaces).**
  Rejected as insufficient alone: serializes unrelated surfaces and still
  needs the stale/crash story (a held lock from a dead process); solves
  mutual exclusion but not exactly-once or recovery.
- **Option B — single-starter architecture (only reconcile starts; listener &
  reeval signal an immediate tick).** Rejected on cost: clean single-writer,
  but a larger refactor of three shipped surfaces and risks the seconds-scale
  latency #207 exists for unless signaling is built too.
- **Option C — atomic per-(PR, head) claim with bounded recovery (chosen).**
  Idempotency-key pattern: O(1) change per surface through one shared
  contract, no cross-surface serialization, crash branch covered by bounded
  recovery with the same exactly-one property. Cheapest sufficient executor
  with tests + Codex review as the safety net.
- RCA artifacts: scenario matrix originated in
  `/tmp/orchestrator-pack-rca-review-duplicate-starts-matrix.md` (architect
  machine; carried into Acceptance criteria above in full).

### GPT adversarial loop (discuss-with-gpt)

Ten fresh-chat passes against the project GPT; every finding evaluated
(accept / partial / reject), draft revised between passes. Key accepted
challenges: single-flight-vs-retry invariant contradiction; visibility-anchored
"started" terminal (claim held until the run record is visible); ownership
fencing at the run boundary; crash-consistent claim records with
partial-record → ambiguous; fail-closed claim-storage behavior; one key
derivation rule; single claim namespace + single-host precondition; audited
operator-resolution path for escalations (liveness); repo-local redacted
incident captures; drift-guard scope (repo-wide scan, invocation-context
classification, governed allowlist, indirect-bypass fixture); start-reason
agnostic claim (incl. #261 fallback); accounting and log-retention hygiene.
Key rejected challenges (with reasons logged per pass in
`~/.local/state/discuss-with-gpt/88-review-start-atomic-claim/`): single-starter
rewrite (cost/latency); CAS/epoch field prescriptions and starter-adapter API
(planner-owned mechanics); Windows-native CI (children run Linux/WSL2 pwsh 7+);
finding-delivery idempotency (owned by #171/#202); per-child version markers
and cross-host fences (over-build).

GPT loop: 10 passes; stopped because cap-10 (last valid pass also produced
no accepted finding — verdict APPROVE, findings=0; pass-10 prompt narrowed to
P0-blocking scope per cap discipline); last-pass accepted=0; final
STATE=completed_valid VALIDATION=ok pass=e98246be-3407-4ffb-84fa-4e86de6827ae
sha=c985db65238922780dd1fa250e67035202c659d3397b767c9b1a8216cff5966a
