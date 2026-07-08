# Claimed review-start must use scoped PR lookup instead of full open-PR list

GitHub Issue: #557

## Prerequisite

- `docs/issues_drafts/103-llm-turn-review-start-claimed-gate.md` (GitHub #318, closed) — already establishes that autonomous orchestrator review starts must go through the claimed review-start gate instead of bare `ao review run`.
- `docs/issues_drafts/169-gh-resolvepr-rest-inventory-route.md` (GitHub #530, closed) — already proves the scoped PR lookup pattern for AO resolve/detect PR shapes.
- `docs/issues_drafts/178-graphql-quota-recurrence-closure.md` (GitHub #549, open) — owns class-level GraphQL read-shape closure; this issue is a narrower REST/list-pressure fix.
- `docs/issues_drafts/180-wake-supervisor-open-pr-snapshot-coverage-regression.md` (GitHub #553, open) — owns wake-supervisor child open-PR-list bypasses; this issue covers the separate claimed review-start path.

Prior-art verdict: **new narrow task**. The live 2026-06-30 symptom is that `invoke-orchestrator-claimed-review-run.ps1` blocks because the claimed review-start snapshot path reaches full `gh pr list`, and REST returns `HTTP 403` even while `rate_limit` still shows substantial core remaining. Direct manual `ao review run --execute` bypasses this gate, but that bypass is not the autonomous path and is not the fix. Since the claimed path already knows the target PR number, it should not list all open PRs.

## Goal

The autonomous claimed review-start path must resolve the target PR with a scoped PR lookup keyed by the known PR number, not by listing all open PRs. A full `gh pr list --state open --limit 200` failure must not block claimed review-start when the target PR can be resolved by number.

```behavior-kind
action-producing
```

## Binding Surface

- The claimed review-start snapshot used by `scripts/invoke-orchestrator-claimed-review-run.ps1` must not require a full open-PR list when `PrNumber` is known.
- Pre-claim evaluation and post-claim pre-run recheck must both use scoped target-PR data for the planned PR.
- The scoped target-PR row must preserve the data needed by the existing gate: PR number, head SHA, base branch, open/closed state, and commit-date enrichment where required.
- If the scoped lookup says the PR is closed, missing, or no longer matches the expected head, the gate must deny cleanly; it must not fall back to full `gh pr list`.
- Manual operator `ao review run --execute` behavior is out of scope. This issue fixes the autonomous claimed path, not the manual bypass.
- This issue must not add token buckets, global backoff, or wake-supervisor cache redesign.

```contract-evidence
binding-id: orchestrator-pack:claimed-review-start:scoped-pr-lookup
binding-type: cli-behavior
binding: claimed review-start uses scoped PR lookup instead of full open-PR list
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)
```

## Files in scope

- `scripts/invoke-orchestrator-claimed-review-run.ps1`
- `scripts/lib/**`
- `scripts/*claimed-review*.test.ts`
- `scripts/fixtures/**`
- `docs/migration_notes.md`

## Files out of scope

- Wake-supervisor child snapshot coverage from #553.
- GraphQL fail-fast / recurrence closure from #540 / #549.
- GitHub hard rate gate, token bucket, circuit breaker, or cooperative backoff.
- Manual `ao review run --execute` command semantics.
- AO core or vendored upstream packages.
- Live runtime state files.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
~/.local/state/**
.agent-orchestrator/**
```

```allowed-roots
scripts/**
docs/**
```

## Acceptance Criteria

1. **Scoped lookup positive path:** with a fixture where full `gh pr list --state open` returns REST `HTTP 403`, but scoped lookup for the known PR number succeeds, the claimed review-start snapshot resolves the target PR and reaches the existing gate/recheck flow instead of failing on the full-list transport.

```positive-outcome
asserts: claimed review-start resolves a known PR number through scoped PR lookup and reaches gate/recheck even when full gh pr list returns REST HTTP 403
input: realistic
```

```producer-emission
producer: orchestrator-pack
datum: claimed-review-start
expected: scoped-pr-lookup
proof-command: npm test -- orchestrator-claimed-review-run
```

2. **No full-list fallback:** when scoped lookup fails because the PR is closed, missing, or has an unexpected head, the claimed path denies with the existing gate semantics and does not call full `gh pr list` as a fallback.

3. **Claim-held path covered:** the post-claim pre-run recheck uses the same scoped target-PR behavior; acquiring a review-start claim must not switch the snapshot reader back to full open-PR listing.

4. **Static regression guard:** verification fails if the claimed review-start snapshot path contains an executable full open-PR list call for the known-PR case.

5. **No GraphQL fallback:** scoped lookup uses the pack-supported GitHub read transport and must not call native GraphQL to recover from REST/list failures.

6. **Manual bypass unchanged:** direct manual `ao review run --execute` remains outside this autonomous gate. The PR must not loosen process-boundary restrictions or claim ownership checks to make the symptom disappear.

## Upgrade-safety Check

- No Composio AO core or vendored upstream edits.
- No secrets or live runtime state committed.
- No unsupported YAML fields.
- Existing claimed review-start ownership and coverage gates remain authoritative.
- The fix reduces unnecessary list traffic; it does not claim to solve all GitHub REST `403` classes.

## Verification

```powershell
npm test -- orchestrator-claimed-review-run
npm test -- review-start-envelope
pwsh -NoProfile -File scripts/verify.ps1
pwsh -NoProfile -File scripts/check-reusable.ps1
```

Manual smoke, when GitHub is reachable:

```powershell
pwsh -NoProfile -File scripts/invoke-orchestrator-claimed-review-run.ps1 -PrNumber <open-pr-number> -SessionId <session-id> -ReviewCommand <configured-review-command> -DryRun
```

The smoke must not require full `gh pr list` to resolve the target PR.

## Decisions

### Prior Art

#553 covers wake-supervisor children that should consume the shared open-PR snapshot. This script is not one of those children. #530 already establishes that scoped PR-number lookup is the right shape when a PR number is known. Therefore this issue is not a duplicate: it applies the same scoped-read principle to the claimed review-start gate.

### Options

| Option | Cost | Risk | Verdict |
|---|---:|---:|---|
| Keep full `gh pr list` and add backoff | Medium | Still blocks on the noisy endpoint; user explicitly rejected waiting/backoff as the fix | Reject |
| Reuse wake-supervisor open-PR snapshot | Medium | Couples autonomous claimed gate to supervisor state and still lists all PRs on cold populate | Reject |
| Scoped lookup by known PR number | Low | Narrow; directly avoids the failing list endpoint | Choose |

### Stop Condition

This issue is done when the claimed review-start path can evaluate and recheck a known PR using scoped target-PR data without full open-PR listing. If the scoped PR endpoint itself later returns REST `403`, that is a separate producer-level GitHub rate-limit issue, not this task.
