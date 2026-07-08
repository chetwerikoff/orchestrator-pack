# Seed snapshot failure must not fan out GitHub reads

GitHub Issue: #609

## Prerequisite

- `docs/issues_drafts/123b-review-ready-report-state-seed-backstop.md` (GitHub #391, closed) introduces the state-derived seed path. This draft preserves that seed decision surface and changes only its GitHub read economy under failure.
- `docs/issues_drafts/150-review-ready-seed-long-tick-liveness-heartbeat.md` (GitHub #473, closed) and `docs/issues_drafts/151-review-ready-seed-pre-side-effect-revalidation.md` (GitHub #475, closed) remain binding: degraded read behavior must not create false stalls or skip pre-side-effect revalidation.
- `docs/issues_drafts/140-graphql-fleet-shared-github-api-gate.md` (GitHub #453, closed), `docs/issues_drafts/186-github-fleet-shared-pr-ci-snapshot.md` (GitHub #569, closed), and `docs/issues_drafts/191-github-fleet-repo-tick-snapshot-consolidation.md` (GitHub #583, closed) provide the shared snapshot/cache lineage. This draft extends their degraded-mode contract for the seed fan-out recurrence; it does not rebuild the cache family.
- `docs/issues_drafts/192-github-fleet-shared-api-governor-phase2.md` (GitHub #585, open) owns fleet-wide admission, lane, and token-bucket mechanics. This draft must not absorb those mechanics; it only defines seed/read-path behavior when the shared snapshot is unavailable.
- Recon evidence: local fleet-cache audit shows repeated `repo_tick_populate_failed` for route `open_pr_list` through 2026-07-05 11:47 UTC. Earlier `snapshot_populate_failed` records show non-JSON parse failures beginning 2026-07-04 07:00 UTC, followed by primary-limit `pr-view` failures while the snapshot bundle was already degraded. This is a #583-class recurrence: shared snapshot population exists, but a producer failure poisons availability and leaves consumers in degraded behavior. The shared open-PR-list cache entries observed locally were stale at 2026-07-04 12:07 UTC and older.
- Prior-art verdict: extends existing shared snapshot/cache work; not already covered by #585 because the governor controls admission/cooldown globally, while this draft prevents a seed-local degraded snapshot from becoming an unbounded per-head read storm.

## Goal

When the shared GitHub snapshot is fresh, the seed sweep uses bounded list-shaped reads that cover all candidate heads. When that snapshot is stale, absent, or populate-failing, the seed degrades to bounded behavior and must not fan out to per-head live reads across the candidate set.

```behavior-kind
action-producing
```

```complexity-tier
tier: T3
advisory-prior: T2
```

## Binding Surface

- Review-ready seed background sweep GitHub read path.
- Shared GitHub fleet snapshot/cache behavior consumed by the seed.
- Negative lookup and stale/degraded cache outcomes for head-to-PR resolution.
- Wrapper audit evidence for route, child, status, rate-limit, and cache/populate events.
- Sibling reader classification for the worker-message-submit reconcile path when it uses the same per-head lookup class.

## Operator Adoption

No operator config migration is required. Existing local polling cadence may remain seconds-scale, but GitHub read cadence must be bounded independently of the local poll interval.

## Files In Scope

- Pack-owned GitHub fleet cache/read-economy surfaces.
- Pack-owned review-ready seed read orchestration surfaces.
- Pack-owned tests, fixtures, and audit parsers that prove read counts and degraded outcomes.
- Pack-owned repair of the confirmed open-PR snapshot populate failure class, including non-JSON output and rate-limit failure handling.
- Pack-owned documentation or runbook notes if needed to describe the degraded-mode evidence.

## Files Out Of Scope

- `vendor/**`
- `packages/core/**`
- Live operator-owned runtime configuration.
- Webhook invalidation.
- GitHub fleet governor admission/lane/token-bucket mechanics owned by #585.
- Changes to what the seed decides; only the GitHub reads used to reach the same decision are in scope. Candidate sweep membership must not be used to change whether a head that would have produced a seed decision is considered.

```denylist
vendor/**
packages/core/**
.ao/**
.agent-orchestrator/**
~/.local/state/**
agent-orchestrator.yaml
```

```allowed-roots
scripts/**
docs/**
tests/**
agent-orchestrator.yaml.example
```

## Acceptance criteria

1. **Healthy snapshot economy:** With a fresh shared snapshot, one seed sweep over the candidate set uses O(1) list-shaped GitHub reads for head coverage. The local seconds-scale seed poll does not multiply live GitHub reads by candidate head count.

2. **Populate-failing snapshot is bounded:** With the shared snapshot in `populate-failing` state, one seed tick does not issue live per-head GitHub reads across the candidate set. The tick either serves bounded stale data, skips/defers the GitHub-dependent portion, or uses a shared repair window/cooldown whose aggregate attempts across seed workers cannot exceed the AC#6 hourly budget. Failed repair attempts emit classified evidence and suppress further repair attempts until the observed reset/cooldown or the configured budget window allows another attempt.

3. **Stale/absent snapshot is bounded:** Stale or absent snapshot states have explicit behavior that does not silently fall back to per-head fan-out. Any repair attempt is coalesced by the same shared repair window/cooldown used for populate failures, not by individual tick cadence, and has an audit-visible outcome.

4. **Negative results suppress repeated reads without changing decisions:** A head classified as no-PR-yet suppresses re-reading across ticks for its TTL. Dead or stale branches may remain in the same logical candidate sweep, but their GitHub reads are suppressed by cache/TTL/degraded-state behavior; this draft must not exclude a head from seed consideration if that head would have produced a seed decision. The acceptance fixture includes a candidate set large enough to prove that 95 dead/stale heads cannot produce 95 live head lookups per tick.

5. **Rate-limit refusal cooldown:** A read refused by primary or secondary rate limit is not immediately retried by the same seed sweep or next tick before the observed reset/cooldown. This draft may consume a governor signal when #585 provides one, but must still define seed-local bounded behavior when the signal is unavailable.

6. **Populate root cause repaired:** The confirmed populate-failure recurrence is fixed in this issue, not merely bounded. A red-then-green fixture proves that the non-JSON parse failure class seen from 2026-07-04 07:00 and the later rate-limit/connectivity populate failures produce classified repair/degraded outcomes without poisoning the shared snapshot and without causing consumer fan-out. The fixture must fail against pre-draft main and pass after the fix.

7. **Explicit budget:** With 5 workers, a seconds-scale local seed poll, and a candidate set at least as large as the 95-head incident shape, sustained seed GitHub consumption is at most 150 upstream GitHub reads/hour, i.e. 3% of the 5,000/hour core budget. The test or analysis proof states the assumed worker count, tick cadence, candidate count, and measured maximum GitHub reads/hour.

8. **Class matrix:** Verification covers at least these equivalence classes and states expected read count and behavior for each class. The dimensions remain snapshot state, head class, and API outcome; rows with identical behavior are intentionally grouped.

   | Equivalence class | Snapshot state | Head class | API outcome | Expected behavior |
   | --- | --- | --- | --- | --- |
   | healthy open PR | fresh | open-PR | ok | serve from shared snapshot or one coalesced read; no per-head fan-out |
   | healthy negative | fresh | no-PR-yet | ok | negative result cached for TTL |
   | healthy dead branch | fresh | dead-branch | ok | negative/stale read suppression; no repeated live reads and no seed-decision exclusion |
   | bounded stale | stale | open-PR, no-PR-yet, dead-branch | ok | bounded stale serve or shared repair-window attempt; no fan-out |
   | rate-limited populate failure | populate-failing | open-PR, no-PR-yet | primary-403, secondary-403 | defer/serve stale and record cooldown until reset/window; no immediate retry storm |
   | poisoned/transport populate failure | populate-failing | dead-branch | non-JSON/transport | repair/degraded outcome is classified; shared snapshot is not poisoned; no per-head fan-out |
   | absent snapshot repair | absent | open-PR | ok | one shared-window repair attempt at most, bounded by AC#7 |
   | absent snapshot refused | absent | no-PR-yet, dead-branch | primary-403, non-JSON/transport | defer/classify until reset/window; no repeated retry and no fan-out |

```producer-emission
producer: orchestrator-pack
datum: seed-snapshot-failure
expected: bounded-read-economy
proof-command: pwsh -NoProfile -File scripts/check-seed-snapshot-failure-bounded-read-economy.ps1
red-then-green: must fail on pre-draft main for populate-failing/stale/absent degraded-mode classes and pass after this draft lands
```

9. **Sibling path accounted:** The worker-message-submit reconcile reader is either covered by the same read-economy fixture for the shared per-head lookup class, or a separate follow-up is explicitly named with evidence explaining why it cannot land in the same PR.

10. **No regression of seed lineage:** Existing seed liveness, long-tick, and pre-side-effect revalidation contracts from #391/#473/#475 still pass.

```producer-emission
producer: orchestrator-pack
datum: seed-snapshot-failure
expected: lineage-preserved
proof-command: pwsh -NoProfile -File scripts/check-review-ready-report-state-seed.ps1
red-then-green: existing lineage command may stay green on pre-draft main, but the implementation must also run the AC#8 degraded-mode red-then-green proof so this existing command cannot be the only evidence for the new behavior
```

```positive-outcome
asserts: a shared snapshot outage no longer converts a seed tick into an O(candidate-heads) GitHub read storm; operators see a classified degraded snapshot outcome and the seed stays within its stated hourly read budget
input: realistic
provenance: capture-backed
```

## Upgrade-Safety Check

The change is upgrade-safe because it stays in pack-owned cache/seed surfaces and does not patch Composio AO core or vendor code.

## Verification

- Automated fixture for fresh, stale, populate-failing, and absent snapshot states with a multi-head candidate set.
- Automated fixture proving negative entries suppress reads across at least two ticks.
- Automated fixture proving primary/secondary rate-limit refusal is not reissued before reset/cooldown.
- Wrapper-audit or deterministic fake-GitHub proof of maximum live read count per tick and per hour.
- Existing seed liveness/revalidation checks still pass.
- Pack verification scripts pass.

```contract-evidence
binding-id: orchestrator-pack:seed-snapshot-failure:bounded-read-economy
binding-type: cli-behavior
binding: a seed tick with fresh, stale, absent, or populate-failing shared snapshot state has bounded GitHub read behavior and cannot fan out by candidate head count
producer: orchestrator-pack
evidence: NEW(produced-by AC#8)

binding-id: orchestrator-pack:seed-snapshot-failure:lineage-preserved
binding-type: cli-behavior
binding: seed liveness and pre-side-effect revalidation contracts from #391, #473, and #475 remain intact while only read economy changes
producer: orchestrator-pack
evidence: NEW(produced-by AC#10)
```

## Decisions

- Chosen approach: extend the existing shared snapshot/cache family with a seed-specific degraded-mode read-economy contract. This is smaller than rebuilding the cache family and avoids duplicating #585 governor mechanics.
- Rejected: make the seed wait for #585 only. The governor can limit admission but does not by itself define what the seed should do when a shared snapshot is unavailable.
- Rejected: treat the live symptom as a missing cache. Recon showed head-to-PR negative lookup exists; the recurrence is failure-path fan-out after snapshot populate failure.