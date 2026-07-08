# Complete Phase-0 telemetry keying and audit retention

GitHub Issue: #588

## Prerequisite

- GitHub #582 is closed and shipped the first Phase-0 telemetry slice: supervised
  cache audit enablement, durable wrapper call journaling, wrapper-side
  rate-limit header capture, and writer support for PR/head fields on
  review-start preflight refusal records. This issue is the completion follow-up,
  not an amendment to #582.
- `docs/declarations/582.codex-telemetry-audit.json` is the baseline declaration
  for the shipped telemetry audit. This issue verifies and extends that baseline
  instead of remeasuring all caller attribution from scratch.
- `docs/issues_drafts/193-review-start-preflight-transient-rate-limit-shield.md`
  (GitHub #584, open) requires directly PR/head-keyed preflight records or an
  already-shipped Phase-0 producer. This issue owns that producer completion;
  #584 remains the independent retry/backoff shield consumer.
- `docs/issues_drafts/192-github-fleet-shared-api-governor-phase2.md`
  (GitHub #585, open) consumes Phase-0 wrapper/header/cache telemetry for later
  governor tuning. This issue must not absorb governor admission, budget, lane,
  or cooldown mechanics.
- GitHub #534 closed the PowerShell `$Pid` parameter regression and static guard.
  This issue must not reintroduce a `$Pid` parameter while touching review-start
  PowerShell surfaces.

Prior-art verdict: **new completion draft after closed #582**. Local verification
on 2026-07-04 found that `Write-OrchestratorReviewStartPreflightRefusal` accepts
`-PrNumber` and `-HeadSha`, and `scripts/orchestrator-review-start-preflight.ps1`
already passes environment-derived PR/head identity. The remaining unkeyed
producer call sites are in
`scripts/lib/Invoke-OrchestratorClaimedReviewRun.ps1` at the early pre-claim
refusal and `head_unresolved` refusal branches. Sibling
`Write-OrchestratorReviewStartDenialAudit` calls already carry PR/head fields.
The same verification found no rotation/retention path for
`gh-wrapper-audit.jsonl` or `github-fleet-cache/audit.jsonl`; live local files
had grown to 141,110 and 11,846 lines respectively.

Knowledge-base note: the local KB had no repository-specific article for this
exact Phase-0 issue. The relevant general notes were `Correlation Identifier`
(use infrastructure metadata to correlate records) and `Acceptance testing` /
`Commit stage` (acceptance criteria must be concrete and fast-feedback). This
draft applies that as explicit PR/head audit keys and executable rotation
scenario fixtures.

## Goal

Close the remaining Phase-0 telemetry blind spots before any dispatcher or
governor tuning: make every review-start preflight refusal record directly
PR/head-keyed when the identity is known, and bound the disk footprint of both
persistent GitHub audit JSONL streams without making GitHub calls fail because
audit maintenance failed.

```behavior-kind
action-producing
```

## Binding surface

- `scripts/lib/Orchestrator-ReviewStartAudit.ps1` already writes `prNumber` and
  normalized `headSha` fields for preflight refusals, but its defaults
  (`prNumber: 0`, empty head) are still reachable. Old history with
  `prNumber: 0` remains readable for backward compatibility.
- `scripts/orchestrator-review-start-preflight.ps1` already derives PR/head
  identity from `AO_REVIEW_START_PR_NUMBER`, `AO_PR_NUMBER`,
  `AO_REVIEW_START_HEAD_SHA`, `AO_PR_HEAD_SHA`, and `AO_HEAD_SHA`, then passes
  those fields to the refusal writer. The implementation must not rewrite that
  path or rename those fields while fixing the still-unkeyed producers.
- `scripts/lib/Invoke-OrchestratorClaimedReviewRun.ps1` currently has two
  refusal writer calls that omit `-PrNumber` and `-HeadSha`: the early pre-claim
  refusal and the `head_unresolved` branch. Both have `$PrNumber` and the event
  head identity in scope. These must become keyed producers.
- The wrapper audit stream is
  `~/.local/state/orchestrator-pack-wake-supervisor/gh-wrapper-audit.jsonl`
  by default, written from `scripts/lib/gh-wrapper.mjs` via append-only JSONL.
- The fleet cache audit stream is
  `~/.local/state/orchestrator-pack-wake-supervisor/github-fleet-cache/audit.jsonl`
  by default, written from `Write-GhFleetInventoryCacheAudit` in
  `scripts/lib/Gh-FleetInventoryCache.ps1`.
- Both audit streams are best-effort observability. A rotation or retention
  error must be logged or audited when possible, but must not fail, delay
  indefinitely, or relabel the upstream GitHub wrapper/cache operation.
- Rotation mechanism class: use bounded, best-effort, opportunistic maintenance
  on audit append with a nonblocking advisory lock per audit file. A writer that
  cannot acquire the maintenance lock appends and skips rotation. A rotator that
  cannot safely rename/delete because another process has the file open skips
  and leaves the active file appendable. Records may land in either the active
  file or the just-rotated segment during a race, but must not be partially
  truncated, interleaved into invalid JSONL, or lost by the rotator.
- Hot-path maintenance is bounded: the normal append path may perform at most one
  cheap active-file size probe before appending or deciding to rotate. Segment
  directory enumeration and age/total-footprint prune evaluation run only when a
  rotation trigger fires, or are equivalently throttled to rotation events.
- Boundary precedence is explicit: active-file size triggers rotation; retention
  age and/or total-footprint policy governs segment deletion; retention is the
  authoritative disk-footprint bound when size and age/count pressures conflict.
- Operator-visible bounds are required for both streams as outcomes, not a fixed
  knob inventory. The implementation may use shared or per-stream policy and one
  or multiple configuration inputs, but absent or malformed config must fall back
  to documented bounded defaults. Those defaults are grounded in the measured
  2026-07-04 rates: wrapper audit about 264 bytes/line and 100-130 MB/day, cache
  audit about 517 bytes/line and 15-20 MB/day. The documented default envelope
  must preserve days of recent traffic while naming a concrete total-footprint
  bound, e.g. roughly 0.7-1.5 GB/week for the wrapper stream and 0.1-0.2 GB/week
  for the cache stream before the configured cap prunes older segments.

```contract-evidence
binding-id: orchestrator-pack:phase0-telemetry:preflight-refusal-pr-head-key
binding-type: audit-record
binding: review-start preflight refusal records carry PR number and best available head SHA when the starter knows them
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:phase0-telemetry:wrapper-audit-bounded-retention
binding-type: audit-record
binding: gh-wrapper-audit.jsonl is persisted with bounded best-effort size/age retention and complete JSONL records under concurrent appends
producer: orchestrator-pack
evidence: NEW(produced-by AC#4)

binding-id: orchestrator-pack:phase0-telemetry:cache-audit-bounded-retention
binding-type: audit-record
binding: github-fleet-cache/audit.jsonl is persisted with bounded best-effort size/age retention and complete JSONL records under concurrent appends
producer: orchestrator-pack
evidence: NEW(produced-by AC#5)
```

Design analysis:

| Option | Verdict | Reason |
| --- | --- | --- |
| Opportunistic append-path rotation with nonblocking per-file lock | Chosen | Single-PR sized, works across the current Node and PowerShell appenders, and keeps audit maintenance best-effort. |
| Dedicated supervisor-owned rotator process | Rejected for this issue | Adds a new runtime child/lifecycle and is disproportionate for two JSONL files unless opportunistic rotation proves insufficient. |
| Documentation-only external logrotate | Rejected | Does not satisfy the pack-owned bounded-footprint contract and leaves autonomous hosts blind by default. |

## Files in scope

- `scripts/lib/Invoke-OrchestratorClaimedReviewRun.ps1`
- `scripts/orchestrator-review-start-preflight.ps1`
- `scripts/lib/Orchestrator-ReviewStartAudit.ps1`
- `scripts/lib/gh-wrapper.mjs`
- `scripts/lib/Gh-FleetInventoryCache.ps1`
- Focused tests/fixtures under `scripts/**` and `tests/**` as needed.
- `docs/**` for this issue draft, review artifacts, and operator-visible audit
  bound documentation.
- `agent-orchestrator.yaml.example` only if the selected config/env knob names
  require example adoption.

## Files out of scope

- AO core or vendored upstream package edits.
- Passthrough/GraphQL header enrichment beyond the wrapper telemetry already
  shipped by #582.
- AO-core `scm` error classification.
- Shared governor admission, lane, cooldown, or budget mechanics from #585.
- Review-start retry/backoff shield behavior from #584.
- New telemetry analysis/reporting tools.
- Machine-local runtime state or credentials.

```denylist
vendor/**
packages/core/**
.ao/**
.agent-orchestrator/**
agent-orchestrator.yaml
```

```allowed-roots
scripts/**
docs/**
tests/**
agent-orchestrator.yaml.example
```

## Acceptance criteria

1. **Preflight refusal call-site keying:** every reachable call to
   `Write-OrchestratorReviewStartPreflightRefusal` passes PR number when known
   and the best available head identity. The two claimed-run branches in
   `Invoke-OrchestratorClaimedReviewRun.ps1` are covered explicitly: early
   pre-claim refusal uses the event/request head, and `head_unresolved` uses the
   event/request head as the refusal key even when the live current head could
   not be resolved. A `git grep`/fixture check proves no new unkeyed call site
   exists outside the writer definition.

```positive-outcome
asserts: review-start preflight refusal records emitted from every known starter surface carry PR number and best available head identity when the caller knows them
input: realistic
provenance: sample-backed
```

```producer-emission
producer: orchestrator-pack
datum: phase0-telemetry
expected: preflight-refusal-pr-head-key
proof-command: implementation-specific focused review-start audit fixture
```

2. **Preflight record backward compatibility:** legacy records with
   `prNumber: 0` or empty `headSha` still parse and remain visible as historical
   unkeyed rows. New keyed records add no mandatory migration of old JSONL
   history and do not rename existing fields consumed by #584 or existing audit
   readers.

3. **Denial audit negative guard:** `Write-OrchestratorReviewStartDenialAudit`
   remains PR/head-keyed at all sibling denial call sites. A grep/static guard
   proves no touched denial writer call loses its existing PR/head arguments
   while fixing refusal records; this issue does not add fixtures merely to
   re-prove shipped denial keying.

4. **Wrapper audit bounded footprint:** `gh-wrapper-audit.jsonl` has a documented
   operator-visible bounded footprint with conservative defaults. The append
   happy path performs at most one active-file size probe; segment enumeration
   and age/total-footprint pruning run only when the rotation trigger fires, or
   are equivalently throttled to rotation events. When the active file exceeds
   the size trigger, maintenance rotates to timestamped JSONL segment(s), and
   retention deletes older segments according to the authoritative footprint
   policy. Rotation or prune failure is observable but never makes the wrapped
   `gh` call fail.

```producer-emission
producer: orchestrator-pack
datum: phase0-telemetry
expected: wrapper-audit-bounded-retention
proof-command: implementation-specific focused gh-wrapper audit rotation fixture
```

5. **Fleet cache audit bounded footprint:** `github-fleet-cache/audit.jsonl`
   has the same documented operator-visible bounded-footprint outcome with
   conservative defaults. The append happy path performs at most one active-file
   size probe; segment enumeration and age/total-footprint pruning run only when
   rotation triggers, or are equivalently throttled to rotation events. A cache
   audit append succeeds or is skipped according to the existing best-effort
   semantics even if retention maintenance cannot rotate or prune.

```producer-emission
producer: orchestrator-pack
datum: phase0-telemetry
expected: cache-audit-bounded-retention
proof-command: implementation-specific focused fleet-cache audit rotation fixture
```

6. **Concurrency scenario matrix:** tests or fixtures cover the writer/rotator
   matrix below for both Node wrapper audit and PowerShell cache audit where the
   filesystem semantics are reachable. Platform-specific rename/delete failures
   may assert skip-and-retry-later, but no cell may truncate an in-flight record
   or make an upstream GitHub operation fail.

| Writer state | Rotator state | File state | Required outcome |
| --- | --- | --- | --- |
| single writer appending | no rotator | below bound | append only, no rotate |
| single writer appending | same process obtains lock | over size bound | rotate/prune best-effort, append remains valid JSONL |
| multiple writers append concurrently | one writer obtains lock | over size bound | every successful append is a complete JSONL line in active or rotated segment |
| multiple writers append concurrently | lock contention | over size bound | contenders skip rotation and append; one rotator may rotate |
| writer opens before rename | rotator renames active file | over size bound | record lands complete in either old segment or new active file |
| rotator cannot rename/delete | platform/file lock failure | over size or retention bound | active file remains appendable; maintenance failure is observable |
| corrupted/truncated historical segment exists | rotator prunes by age/count | retained and expired segments mixed | active append unaffected; prune does not parse or rewrite active JSONL |

7. **Operator-visible bounds:** docs or config examples name the bounded policy,
   defaults, state directory, and expected footprint envelope for both audit
   streams without mandating a specific number of knobs. Defaults retain days of
   recent traffic, cap total disk growth, and use the measured rates above to
   state concrete default footprints. Disabled, absent, or malformed config
   falls back to conservative bounded defaults rather than unbounded retention.

8. **Phase boundaries preserved:** this issue emits the Phase-0 producers needed
   by #584 and #585, but does not implement #584 retry/backoff classes, #585
   governor admission/lanes/cooldowns, new dispatcher tuning, or telemetry
   analysis tooling.

9. **PowerShell `$Pid` guard:** no touched PowerShell file introduces
   `param(...$Pid...)`, and the existing #534 static guard remains green.

## Upgrade-safety check

- No AO core, vendored upstream, runtime-state, or credential files are edited.
- Existing JSONL schemas are additive/backward-compatible.
- Audit maintenance is best-effort and cannot turn observability failure into a
  GitHub operation failure.
- Bounds are operator-visible before any Phase-2 dispatcher/governor tuning can
  rely on these logs.

## Verification

- `rg -n "Write-OrchestratorReviewStartPreflightRefusal|Write-OrchestratorReviewStartDenialAudit" scripts -g '*.ps1'`
- Focused review-start audit tests covering keyed refusal records from claimed
  run surfaces plus a static/grep guard that no standalone preflight or denial
  writer call lost already-shipped PR/head arguments.
- Focused Node wrapper audit rotation/retention tests.
- Focused PowerShell fleet-cache audit rotation/retention tests.
- Scenario-matrix fixture for writer/rotator/file-state races.
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/196-phase0-telemetry-completion.md`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/196-phase0-telemetry-completion.md`
- `pwsh -NoProfile -File scripts/verify.ps1`
- `pwsh -NoProfile -File scripts/check-reusable.ps1`

## Review notes

- Intake tier: **T2**. The work changes cross-process audit persistence and
  concurrency behavior but is bounded to pack-owned scripts and docs; it does
  not introduce a new runtime child or governor mechanism.
- Codex architect review is required before sync. If the first pass emits
  findings, run fixes and require two consecutive clean passes after the last
  fix per the task brief.