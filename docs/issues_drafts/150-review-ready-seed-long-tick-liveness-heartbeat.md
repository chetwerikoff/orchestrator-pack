# Review-ready seed must not false-stall during legitimate long ticks

GitHub Issue: #473

## Prerequisite

- `docs/issues_drafts/71-orchestrator-side-process-supervisor.md` (GitHub
  [#205](https://github.com/chetwerikoff/orchestrator-pack/issues/205), **closed**) —
  supervised side-process registry, per-child cadence/grace, progress/heartbeat concept,
  and side-effect-safe stall recovery. **Does not cover:** a legitimate child tick whose
  duration exceeds `cadenceSeconds * stallGraceMultiplier` while progress remains at
  `phase=poll`.
- `docs/issues_drafts/123b-review-ready-report-state-seed-backstop.md` (GitHub
  [#391](https://github.com/chetwerikoff/orchestrator-pack/issues/391), **closed**) —
  introduces `review-ready-report-state-seed`, the seconds-scale seed path for accepted
  `ready_for_review` reports. **Does not cover:** grown-state runtime liveness.
- `docs/issues_drafts/139-supervisor-crash-hardening-degraded-backoff-and-redirect-safety.md`
  (GitHub [#450](https://github.com/chetwerikoff/orchestrator-pack/issues/450),
  **closed**) — degraded-alive backoff and supervisor fault boundary. **Sibling:** it
  reduces restart-storm damage after a false stall; this draft prevents the false stall.
- `docs/issues_drafts/140-graphql-fleet-shared-github-api-gate.md` (GitHub
  [#453](https://github.com/chetwerikoff/orchestrator-pack/issues/453)) — fleet inventory
  cache. **Adjacent only:** cache may reduce tick cost, but liveness must remain correct
  when cache is absent, cold, or still too slow.

**Prior-art verdict:** **Genuinely new draft.** #205/#391/#450/#453 are prerequisites or
siblings, not owners of the long-tick heartbeat invariant.

**Incident facts verified on 2026-06-26:**

| Claim | Artifact |
|---|---|
| Stall threshold is 20s | registry has `cadenceSeconds=5`, `stallGraceMultiplier=4`; supervisor formula is `cadence * grace * 1000` |
| Progress is sparse today | seed child writes `phase=poll` before the tick and `tick_success` / `tick_error` after; no intermediate heartbeat |
| Dry-run tick exceeds threshold | five local `-Once -DryRun` scratch-state samples: `35.76s`, `37.69s`, `34.49s`, `35.34s`, `35.47s`; observed range including prior samples: `16-38s` |
| Live loop was active | `supervisor.log` showed repeated `review-ready-report-state-seed non-working (stalled): no fresh tick progress` + `degraded backoff ... next restart in 30s` through `03:43:54Z` |
| PID recycled | observed `review-ready-report-state-seed.pid` change from `1221759` to `1249784` during verification |
| Child killed before complete | child log in the failing window showed `starting` + `pollClass`, then restart; no `tick complete` for that process |
| State size pressure remains | `ao review list --json` about `734KB`; `ao status --json --reports full --include-terminated` about `1.1MB` |

## Goal

`review-ready-report-state-seed` must stay supervised without being kill-restarted during
a legitimate long tick. The liveness contract must distinguish:

- fast tick below threshold;
- legitimate slow tick above threshold but making bounded forward progress;
- real hang / no progress;
- tick error.

The threshold remains a watchdog, not a workload budget. Raising cadence/grace alone is
not accepted as the standalone fix for this incident class because the observed tick
duration varies with state and can keep growing.

```behavior-kind
action-producing
```

## Binding surface

- **Progress-evidenced heartbeat:** long seed ticks emit bounded operational heartbeats
  during expensive sub-steps so `lastProgressMs` advances before the stall threshold.
  Heartbeats must prove forward progress through a bounded cursor/checkpoint, item-count
  advance, completed sub-step, finite work plan, or equivalent. A sequence number alone
  is record ordering, not proof of work.
- **Identity-bound freshness:** heartbeat freshness counts only for the currently owned
  child process/generation/tick. Fresh progress from a prior PID/generation is ignored.
  Process death outranks progress freshness.
- **Single tick at a time:** default expected behavior is single-tick-at-a-time; if the
  next configured cadence interval fires while the previous tick is still active, the
  child skips/joins or fail-closes without duplicate work or side effects. Planner may
  choose mechanism.
- **Side-effect lock interaction:** lock deferral alone is insufficient if the slow phase
  happens before lock acquisition. Slow pre-lock scan must heartbeat or enter an explicit
  bounded protected phase. Live protected side effects still prevent duplicate review
  starts/sends; stale/orphaned protection eventually surfaces degraded/stalled evidence.
- **Finite fixture convergence:** a tick cannot remain `working` forever by discovering
  apparent progress. The deterministic grown-state fixture must include a bounded
  finite-work plan and must reach one terminal outcome from the allowed vocabulary within
  60s. This is a test budget for the fixture, not a production workload limit for
  arbitrarily larger states.
- **Bounded metadata:** heartbeat/progress/audit records are overwrite-oriented,
  size-bounded, and allowlisted/redacted. They must not persist raw AO/GitHub payloads,
  auth material, session transcripts, or reviewer context.
- **Upgrade safety:** old sparse `phase=poll` progress files from before this change are
  ignored, migrated, or cleaned before new freshness semantics trust them.
- **Operator adoption:** after merge, restart the wake supervisor from the pack root:
  `pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1 -Action Stop`, then
  `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/orchestrator-wake-supervisor.ps1 -Action Start`.
  Live verification is a smoke check only; deterministic fixtures are the release gate.

## Files in scope

- `scripts/**` — seed progress emission, supervisor verdict/registry metadata if needed,
  liveness fixtures, and guards.
- `tests/external-output-references/**` — redacted/generated external-output samples if
  the planner needs persistent fixtures outside `scripts/**`.
- `docs/**` — runbook / migration notes.

## Files out of scope

- `vendor/**`
- `packages/core/**`
- `.ao/**`
- `agent-orchestrator.yaml`
- Composio AO core behavior.
- Review-start eligibility TOCTOU / pre-side-effect revalidation — follow-up draft 151.
- Process-tree descendant ownership and external-command streaming hardening — follow-up
  unless the planner finds it is the minimal way to satisfy this issue's side-effect lock
  invariant.
- #453 cache implementation.

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
```

Scope boundary note: This denylist is scoped to `150-review-ready-seed-long-tick-liveness-heartbeat`.

```allowed-roots
scripts/**
tests/external-output-references/**
docs/**
```

## Acceptance criteria

### Compact liveness matrix

| Scenario | Expected verdict/action | Required proof |
|---|---|---|
| Fast tick completes below 20s | `working` then success/no-candidate/skip/defer; no restart | `expected: fast-tick-ok` |
| Legitimate grown-state fixture runs >20s with progress heartbeats | no false `stalled`; same owned generation reaches a non-degraded terminal outcome within the 60s fixture budget | `expected: long-tick-not-stalled` |
| Current child has only stale/sparse `phase=poll` and no bounded progress evidence | stale progress is not accepted as fresh; verdict becomes degraded/stalled/defer instead of indefinite `working` | `expected: stale-poll-regression` |
| Real hang after `phase=poll` | `stalled`; #450 recovery/backoff path engages | `expected: hang-still-stalled` |
| Tick throws/returns error | classified as tick error/degraded error, not misreported as forward progress or generic no-progress hang | `expected: tick-error-classified` |
| Heartbeat repeats phase or sequence only with no finite progress | degraded/stalled/defer within bounded window; not indefinitely `working` | `expected: progress-livelock-fails` |
| Progress belongs to prior PID/generation/tick | ignored for current child freshness | `expected: progress-identity` |
| In-flight child exits after fresh heartbeat before terminal outcome | process death wins; recovery path engages | `expected: dead-process-not-fresh` |
| Cadence fires while prior tick active | skip/join/fail-closed; no duplicate work or side effect | `expected: overlap-safe` |
| Slow scan before side-effect lock | heartbeat/protected phase prevents false stall; live lock prevents duplicate side effects | `expected: side-effect-safe-long-scan` |
| Stale/orphaned protected state | eventually degraded/stalled; no indefinite immunity | `expected: stale-lock-bounded` |
| Torn/corrupt/future-skewed progress record | deterministic ignore/degraded/stalled; no crash; no false freshness | `expected: atomic-progress-read` |
| Pre-upgrade sparse progress file | ignored/migrated/cleaned before freshness is trusted | `expected: upgrade-safe-progress` |
| Large generated AO/GitHub-shaped payload near measured sizes | production seed scan/planning path emits progress at real boundaries; no raw payload leakage | `expected: large-payload-progress` |

1. The blocking `review-ready-seed-liveness` verification target must structurally map
   every matrix row and every `expected:` label above to a named deterministic fixture; a
   missing mapping fails the target. This target is expected to run under the existing
   `npm test` CI path; no new workflow file is required.

2. The grown-state fixture must use generated AO/GitHub-shaped payloads near the measured
   `734KB` review-list and `1.1MB` status sizes. Captured payloads may be used only if
   redacted, secret-scanned, bounded, and raw captures are not committed.

3. Threshold-crossing tests must use a controllable clock, injected time source, or
   shortened test threshold while exercising the same production verdict path; routine CI
   must not depend on real 20s+ sleeps as the only proof.

4. Terminal outcomes are class-specific and must use existing #391/#450 vocabulary:
   legitimate long-tick success fixtures end in success, no-candidate, skip, or existing
   defer outcome; hang/stale/corrupt/error negative fixtures may end in stalled, degraded,
   defer, or recovery as named by their matrix rows. Stable PID is required only if the
   chosen implementation remains a long-running child loop; otherwise stable
   ownership/generation is the invariant. Repeated `tick_error` is degraded evidence, not
   success.

5. **Fast tick proof:** the blocking fixture proves the `fast-tick-ok` row.

```producer-emission
producer: orchestrator-pack
datum: review-ready-seed-liveness
expected: fast-tick-ok
proof-command: npm test -- review-ready-seed-liveness
```

6. **Long tick proof:** the blocking fixture proves the `long-tick-not-stalled` row.

```producer-emission
producer: orchestrator-pack
datum: review-ready-seed-liveness
expected: long-tick-not-stalled
proof-command: npm test -- review-ready-seed-liveness
```

7. **Sparse/stale poll proof:** the blocking fixture proves the `stale-poll-regression`
   row.

```producer-emission
producer: orchestrator-pack
datum: review-ready-seed-liveness
expected: stale-poll-regression
proof-command: npm test -- review-ready-seed-liveness
```

8. **Hang proof:** the blocking fixture proves the `hang-still-stalled` row.

```producer-emission
producer: orchestrator-pack
datum: review-ready-seed-liveness
expected: hang-still-stalled
proof-command: npm test -- review-ready-seed-liveness
```

9. **Tick-error proof:** the blocking fixture proves the `tick-error-classified` row.

```producer-emission
producer: orchestrator-pack
datum: review-ready-seed-liveness
expected: tick-error-classified
proof-command: npm test -- review-ready-seed-liveness
```

10. **Progress-livelock proof:** the blocking fixture proves the `progress-livelock-fails`
   row.

```producer-emission
producer: orchestrator-pack
datum: review-ready-seed-liveness
expected: progress-livelock-fails
proof-command: npm test -- review-ready-seed-liveness
```

11. **Identity proof:** the blocking fixture proves the `progress-identity` row.

```producer-emission
producer: orchestrator-pack
datum: review-ready-seed-liveness
expected: progress-identity
proof-command: npm test -- review-ready-seed-liveness
```

12. **Dead-process proof:** the blocking fixture proves the `dead-process-not-fresh` row.

```producer-emission
producer: orchestrator-pack
datum: review-ready-seed-liveness
expected: dead-process-not-fresh
proof-command: npm test -- review-ready-seed-liveness
```

13. **Overlap proof:** the blocking fixture proves the `overlap-safe` row.

```producer-emission
producer: orchestrator-pack
datum: review-ready-seed-liveness
expected: overlap-safe
proof-command: npm test -- review-ready-seed-liveness
```

14. **Side-effect-safe scan proof:** the blocking fixture proves the
    `side-effect-safe-long-scan` row.

```producer-emission
producer: orchestrator-pack
datum: review-ready-seed-liveness
expected: side-effect-safe-long-scan
proof-command: npm test -- review-ready-seed-liveness
```

15. **Stale-lock proof:** the blocking fixture proves the `stale-lock-bounded` row.

```producer-emission
producer: orchestrator-pack
datum: review-ready-seed-liveness
expected: stale-lock-bounded
proof-command: npm test -- review-ready-seed-liveness
```

16. **Atomic progress proof:** the blocking fixture proves the `atomic-progress-read` row.

```producer-emission
producer: orchestrator-pack
datum: review-ready-seed-liveness
expected: atomic-progress-read
proof-command: npm test -- review-ready-seed-liveness
```

17. **Upgrade sparse-progress proof:** the blocking fixture proves the
    `upgrade-safe-progress` row.

```producer-emission
producer: orchestrator-pack
datum: review-ready-seed-liveness
expected: upgrade-safe-progress
proof-command: npm test -- review-ready-seed-liveness
```

18. **Large-payload progress proof:** the blocking fixture proves the
    `large-payload-progress` row.

```producer-emission
producer: orchestrator-pack
datum: review-ready-seed-liveness
expected: large-payload-progress
proof-command: npm test -- review-ready-seed-liveness
```

```positive-outcome
asserts: with a generated grown-state seed tick whose wall time exceeds the previous 20s threshold, the supervised child emits identity-bound forward-progress heartbeats and reaches a non-degraded terminal outcome without false stall or ownership/generation confusion, while a no-progress hang fixture still reports stalled and enters recovery
input: realistic
```

## Upgrade-safety check

- No `vendor/**`, `packages/core/**`, `.ao/**`, or Composio AO core edits.
- #391 seed business semantics remain intact: eligible reports, dedupe, and review-start
  constraints are unchanged except for liveness progress emission.
- #450 recovery/backoff remains the response to true degraded/stalled children.
- Heartbeat/progress metadata is bounded and redacted.
- Operator restart documented.

## Contract evidence

```contract-evidence
binding-id: orchestrator-pack:review-ready-seed-liveness:long-tick-not-stalled
binding-type: cli-behavior
binding: a legitimate review-ready-report-state-seed tick longer than the prior 20s threshold advances identity-bound progress and is not classified as stalled before a non-degraded terminal outcome
producer: orchestrator-pack
evidence: NEW(produced-by AC#6)

binding-id: orchestrator-pack:review-ready-seed-liveness:fast-tick-ok
binding-type: cli-behavior
binding: a seed tick completing below the previous threshold is not restarted and reaches a normal terminal outcome
producer: orchestrator-pack
evidence: NEW(produced-by AC#5)

binding-id: orchestrator-pack:review-ready-seed-liveness:stale-poll-regression
binding-type: cli-behavior
binding: sparse or stale poll-only progress is not accepted as fresh progress for the current child
producer: orchestrator-pack
evidence: NEW(produced-by AC#7)

binding-id: orchestrator-pack:review-ready-seed-liveness:hang-still-stalled
binding-type: cli-behavior
binding: a seed child that emits poll progress and then makes no further progress beyond the effective threshold is still classified as stalled and recovered
producer: orchestrator-pack
evidence: NEW(produced-by AC#8)

binding-id: orchestrator-pack:review-ready-seed-liveness:tick-error-classified
binding-type: cli-behavior
binding: a seed tick error is classified as a tick error/degraded error rather than accepted as progress or collapsed into a no-progress hang
producer: orchestrator-pack
evidence: NEW(produced-by AC#9)

binding-id: orchestrator-pack:review-ready-seed-liveness:progress-livelock-fails
binding-type: cli-behavior
binding: heartbeat records that do not show finite forward progress cannot keep the child working indefinitely
producer: orchestrator-pack
evidence: NEW(produced-by AC#10)

binding-id: orchestrator-pack:review-ready-seed-liveness:progress-identity
binding-type: cli-behavior
binding: stale or mismatched progress from a prior process generation or tick identity cannot satisfy freshness for the current supervised child
producer: orchestrator-pack
evidence: NEW(produced-by AC#11)

binding-id: orchestrator-pack:review-ready-seed-liveness:dead-process-not-fresh
binding-type: cli-behavior
binding: an in-flight child process exit after a fresh heartbeat but before a terminal outcome is treated as process death, not as fresh working state
producer: orchestrator-pack
evidence: NEW(produced-by AC#12)

binding-id: orchestrator-pack:review-ready-seed-liveness:overlap-safe
binding-type: cli-behavior
binding: a new cadence interval while a previous seed tick is active cannot start duplicate independent seed work or duplicate side effects
producer: orchestrator-pack
evidence: NEW(produced-by AC#13)

binding-id: orchestrator-pack:review-ready-seed-liveness:side-effect-safe-long-scan
binding-type: cli-behavior
binding: a slow scan before side-effect lock acquisition remains supervised without false stall while preserving duplicate-side-effect safety
producer: orchestrator-pack
evidence: NEW(produced-by AC#14)

binding-id: orchestrator-pack:review-ready-seed-liveness:stale-lock-bounded
binding-type: cli-behavior
binding: stale or orphaned protected state cannot grant indefinite stall immunity
producer: orchestrator-pack
evidence: NEW(produced-by AC#15)

binding-id: orchestrator-pack:review-ready-seed-liveness:atomic-progress-read
binding-type: cli-behavior
binding: concurrent or corrupt progress-record reads are handled safely and cannot be accepted as fresh progress
producer: orchestrator-pack
evidence: NEW(produced-by AC#16)

binding-id: orchestrator-pack:review-ready-seed-liveness:upgrade-safe-progress
binding-type: cli-behavior
binding: pre-upgrade sparse progress records are ignored, migrated, or cleaned before new freshness semantics trust them
producer: orchestrator-pack
evidence: NEW(produced-by AC#17)

binding-id: orchestrator-pack:review-ready-seed-liveness:large-payload-progress
binding-type: cli-behavior
binding: large generated AO/GitHub-shaped payloads exercise progress emission at production scan/planning boundaries without raw payload leakage
producer: orchestrator-pack
evidence: NEW(produced-by AC#18)
```

## Verification

- `npm test -- review-ready-seed-liveness`
- `npm test -- supervisor`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/150-review-ready-seed-long-tick-liveness-heartbeat.md`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/150-review-ready-seed-long-tick-liveness-heartbeat.md`
- `pwsh -NoProfile -File scripts/verify.ps1`
- `pwsh -NoProfile -File scripts/check-reusable.ps1`

**Non-gating operator smoke after restart:** run
`pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1 -Action Status`, observe at
least three completed tick outcomes including one non-error success/no-candidate/skip/defer
outcome, and confirm no new false seed `stalled` / `degraded backoff` entries during the
window. This smoke check does not replace the deterministic release gate.

## Decisions

- **Design choice:** B is the baseline: progress-evidenced heartbeats tied to
  process/generation identity. C is allowed where needed: single-tick-at-a-time skip/join
  behavior or a cheap poll / expensive work split. A (raise threshold only) is rejected as
  standalone because observed duration variance (`16-38s`) can grow with state and would
  blind the watchdog.
- **Default overlap expectation:** single-tick-at-a-time; overlapping cadence ticks skip or
  join rather than start a second independent seed tick.
- **Scope trim after review:** late GPT-loop hardening around pre-side-effect eligibility
  revalidation, process-tree descendants, external command streaming, live old-writer
  drain, and status/reporting state taxonomy is not in the core #150 scope unless the
  planner proves it is necessary for the matrix above.
- **Follow-up:** `docs/issues_drafts/151-review-ready-seed-pre-side-effect-revalidation.md`
  owns the review-start eligibility TOCTOU / immediate pre-side-effect revalidation.
- **GPT loop note:** The first version ran 10 GPT passes and became over-expanded. This
  revision keeps the accepted core from early passes and records late-pass concerns as
  follow-up/hardening, not mandatory #150 scope.

## Planner-freedom checklist

- [ ] No required function signature or import path.
- [ ] No prescribed folder layout beyond allowed roots.
- [ ] No pinned library version.
- [ ] Acceptance criteria are behaviorally verifiable by tests or live commands, not by
      architect-only diff reading.
