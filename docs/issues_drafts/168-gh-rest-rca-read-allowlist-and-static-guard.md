# Close RCA/review gh read gaps before agents hit GraphQL limits

GitHub Issue: [#520](https://github.com/chetwerikoff/orchestrator-pack/issues/520)

```behavior-kind
action-producing
```

## Goal

Extend the shipped #431/#501 REST inventory and classifier-derived static guard so RCA
and review triage instructions never send agents to native GraphQL for recurring legal
read forms (`issue view` with `closedAt`, merged-PR closure lookup, and related bounded
list/view JSON shapes).

## Acceptance criteria

1. `scripts/gh issue view <N> --json state,title,body,closedAt` (with optional
   `--repo chetwerikoff/orchestrator-pack`) routes through REST and emits gh-shaped JSON
   with `closedAt`.

```positive-outcome
asserts: scripts/gh issue view <closed-issue> --repo chetwerikoff/orchestrator-pack --json state,title,body,closedAt succeeds via REST and emits closedAt when native gh --json would fail under GraphQL exhaustion
input: external-tool-output
provenance: capture-backed
```

```producer-emission
producer: orchestrator-pack-scripts
datum: gh-issue-view-closedAt-route
expected: state,title,body,closedAt JSON emitted without native GraphQL use
proof-command: npm test -- gh-wrapper
```

2. RCA merged-PR closure check uses a canonical bounded `gh pr list --state merged
   --search "closes #N" --json number,title,state,mergedAt --limit 10` form covered by
   the classifier and REST inventory.

```producer-emission
producer: orchestrator-pack-scripts
datum: rca-merged-pr-closure-lookup-canonical-read
expected: tracked RCA prompt command is inventory-covered or replaced by an explicit REST-covered canonical read
proof-command: pwsh -NoProfile -File scripts/check-gh-inventory-static.ps1
```

3. Bare `gh pr view <N>` and bare `gh pr checks <N>` fail the static guard when
   introduced as executable instructions; prompts use covered JSON forms instead.

4. `scripts/check-gh-inventory-static.ps1` scans `prompts/investigate_root_cause.md`
   without prose-only false positives on family mentions such as bare `gh issue view`.

```producer-emission
producer: orchestrator-pack-scripts
datum: gh-inventory-static-guard-rca-surface
expected: RCA prompt scan catches executable uncovered gh read forms without prose-only false positives
proof-command: pwsh -NoProfile -File scripts/check-gh-inventory-static.ps1
```

```contract-evidence
binding-id: orchestrator-pack-scripts:gh-issue-view-closedAt-route:state,title,body,closedAt JSON emitted without native GraphQL use
binding-type: cli-behavior
binding: pack scripts/gh emits gh-shaped issue view JSON with closedAt for the canonical RCA issue metadata read
producer: orchestrator-pack-scripts
evidence: NEW(produced-by AC#1)
```

```contract-evidence
binding-id: orchestrator-pack-scripts:gh-inventory-static-guard-rca-surface:RCA prompt scan catches executable uncovered gh read forms without prose-only false positives
binding-type: cli-behavior
binding: gh inventory static guard scans the RCA prompt and fails on uncovered executable gh read forms
producer: orchestrator-pack-scripts
evidence: NEW(produced-by AC#5)
```
