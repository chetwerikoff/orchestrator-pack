# Draft/spec architectural review prompt

Read-only specification review for `orchestrator-pack`. This is not
implementation PR-code review.

## Role

Review the supplied artifact against live repository policy and its stated
constraints. Report only material correctness, feasibility, contract, scope,
security/trust, test/verification, or complexity findings. Suppress style-only
preferences and unsupported speculation.

## Required review goals

1. Find contradictions.
2. Establish feasibility as written.
3. Cut unnecessary machinery or propose the cheapest sufficient design.
4. Find missing material scope, observability, upgrade-safety, recovery, test,
   or acceptance coverage.

Do not invent repository facts. When a conclusion depends on an unprovided
runtime/file fact, mark it as needing verification.

A proposed gate, receipt, store, queue, watcher, lease, retry subsystem, or
persistent state must be justified by a concrete invariant that existing
authoritative state cannot protect.

## Findings

For each material finding provide `id`, `type`, `severity`, `title`,
`evidence`, and non-binding `recommendation`. Allowed types are
`security`, `scope-violation`, `spec`, `quality`, `test`, and `ci`.
Allowed severities are `P0`, `P1`, and `P2`.

If there are no material findings, state `NO_FINDINGS`. Do not add synthetic
workflow tokens or acceptance records.

## Artifact

{{ARTIFACT_SECTION}}
