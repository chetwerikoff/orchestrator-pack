# Fleet audit retention resolver must survive repeated writes

GitHub Issue: #610

## Prerequisite

- GitHub #588 is closed and introduced bounded retention for wrapper and fleet-cache audit streams. This draft is a post-close defect in the runtime shape of that retention path, not a reopening of retention policy semantics.
- `docs/issues_drafts/140-graphql-fleet-shared-github-api-gate.md` (GitHub #453, closed), `docs/issues_drafts/186-github-fleet-shared-pr-ci-snapshot.md` (GitHub #569, closed), and `docs/issues_drafts/191-github-fleet-repo-tick-snapshot-consolidation.md` (GitHub #583, closed) rely on fleet-cache audit evidence remaining available.
- Recon evidence: seed stderr still shows repeated `github-fleet-cache-audit: write_failed reason=The term 'Resolve-AuditJsonlRetentionPolicy' is not recognized...` through 2026-07-05 11:47 UTC.
- Two-call repro result: in one `pwsh` process with a seed-shaped state root and audit enabled, the first audit write created one JSONL line; the second consecutive write emitted `Resolve-AuditJsonlRetentionPolicy` not recognized and did not append a second JSONL line.
- Pattern recon: a tight structural search found exactly two guarded intra-function dot-source sites in the pack: the fleet-cache audit path that loads the retention resolver, and `scripts/lib/Audit-JsonlRetention.ps1:9-12`, where `Ensure-AuditJsonlProcessAliveLoaded` loads `Orchestrator-ProcessAlive.ps1` behind `$Script:AuditJsonlProcessAliveLoaded`. This draft covers the class, not only the first site.
- Prior-art verdict: no existing draft in the reviewed corpus covers this repeated-write PowerShell scope-lifetime defect. This remains a narrow wiring/load-shape fix, with T3 retained by the tier gate.

## Goal

Every long-lived runspace that reaches a guarded intra-function dot-source path can use symbols loaded by that path on repeated calls. The fleet-cache audit write path can write repeated audit lines and apply the existing retention resolver on each write. The sibling process-alive loader is either fixed by the same class treatment or proven unaffected by an explicit regression/static check.

```behavior-kind
action-producing
```

```complexity-tier
tier: T3
advisory-prior: T1
```

## Binding Surface

- Guarded intra-function dot-source pattern under script-scope loaded flags.
- Fleet-cache audit JSONL write path and existing audit retention resolver availability.
- Audit retention process-alive maintenance helper availability.
- Seed-shaped child/runspace invocation shape.
- Stderr failure reporting for audit write failures.

## Operator Adoption

No operator action is required. Existing audit retention policy semantics and audit schema remain unchanged.

## Files In Scope

- Pack-owned guarded-dot-source load surfaces used by audit retention.
- Pack-owned regression fixture for repeated audit writes from a child-shaped invocation and sibling process-alive maintenance shape.
- Pack-owned verification wiring that keeps the repeated-write shape in CI.

## Files Out Of Scope

- `vendor/**`
- `packages/core/**`
- Retention policy semantics.
- Audit schema changes.
- GitHub read economy or governor behavior.

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

1. **Repeated writes succeed:** In one long-lived process/runspace with audit enabled and a seed-shaped state root, two or more consecutive fleet-cache audit writes append the same number of JSONL records and emit no `write_failed` resolver-not-found error. The proof command is red-then-green: it fails against current pre-draft main, where the second write loses the resolver, and passes after the fix.

```producer-emission
producer: orchestrator-pack
datum: fleet-audit-retention
expected: repeated-write-resolver
proof-command: pwsh -NoProfile -File scripts/check-audit-retention-guarded-dotsource.ps1
red-then-green: must fail on pre-draft main for the two-call fleet-cache audit write shape and pass after this draft lands
```

2. **Regression shape is production-like:** The regression fixture invokes the audit path through a child-shaped state/audit environment rather than only importing the retention module or calling the resolver directly. A single-call fixture is not sufficient; the required proof performs repeated calls in the same long-lived runspace.

3. **Guarded dot-source class covered:** Verification enumerates every site matching "script-scope loaded flag wraps a dot-source inside a function". The current required list is:

   | Site | Loaded target | Required disposition |
   | --- | --- | --- |
   | fleet-cache audit writer guarded retention load | audit JSONL retention module | fixed; repeated fleet-cache audit writes keep resolver available |
   | `Ensure-AuditJsonlProcessAliveLoaded` | process-alive helper | fixed by the same class treatment or proven unaffected by a repeated stale-lock/process-alive maintenance fixture |

   The proof either adds a static guard preventing this pattern from returning, or records an enumerated-and-dispositioned list that fails when a new unclassified site appears.

4. **Retention still runs:** The existing retention resolver remains applied to the fleet-cache audit stream on repeated writes. The fix must not bypass retention to make the append succeed.

5. **Audit-only fault boundary remains:** If an audit write fails for an unrelated reason, the cache data path remains non-fatal as before, but the resolver-availability regression is eliminated.

```producer-emission
producer: orchestrator-pack
datum: fleet-audit-retention
expected: audit-only-boundary
proof-command: pwsh -NoProfile -File scripts/check-audit-retention-guarded-dotsource.ps1
red-then-green: audit-only boundary remains green after the repeated-call red-then-green regression is fixed
```

6. **No policy/schema drift:** Audit retention policy values and JSONL schema are unchanged except for restoring the missing repeated records.

```positive-outcome
asserts: a seed-shaped long-lived child can emit repeated fleet-cache audit records without losing records after the first write, and retention still applies on each append
input: realistic
provenance: capture-backed
```

## Upgrade-Safety Check

The change is upgrade-safe because it stays in pack-owned audit/retention loading and test surfaces and does not modify Composio AO core or vendor code.

## Verification

- Automated two-or-more-write regression fixture using a seed-shaped child/state environment.
- Existing audit retention tests still pass.
- Existing fleet-cache tests still pass.
- Pack verification scripts pass.

```contract-evidence
binding-id: orchestrator-pack:fleet-audit-retention:repeated-write-resolver
binding-type: cli-behavior
binding: repeated fleet-cache audit writes from one seed-shaped long-lived child append all records and keep the existing retention resolver available
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:fleet-audit-retention:audit-only-boundary
binding-type: cli-behavior
binding: unrelated audit write failures remain non-fatal to the cache data path while resolver availability is restored
producer: orchestrator-pack
evidence: NEW(produced-by AC#5)
```

## Decisions

- Chosen approach: specify the smallest repeated-write availability contract. The bug is not that retention policy is wrong; it is that the resolver is unavailable after the first write in a long-lived runspace.
- Rejected: reopen #588. The retention feature shipped; this is a post-close production-shape defect.
- Rejected: satisfy the draft with a single-call module test. Local repro proves that a single call can pass while the second call loses the audit record.