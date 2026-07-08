# Wake-supervisor children must not bypass the shared open-PR REST snapshot

GitHub Issue: #553

## Prerequisite

- `docs/issues_drafts/140-graphql-fleet-shared-github-api-gate.md` (GitHub #453, closed) — already shipped the Phase 1 shared open-PR-list snapshot and SHA memo contract for wake-supervisor fleet inventory reads.
- `docs/issues_drafts/138-supervisor-children-gh-rest-shim-path.md` (GitHub #447, closed) — already makes wake-supervisor children resolve pack `scripts/gh`, so covered reads use REST instead of native GraphQL.
- `docs/issues_drafts/131-gh-rest-fallback-on-graphql-quota-exhaustion.md` (GitHub #431, closed) — already routes inventory-listed `gh` reads through REST.
- `docs/issues_drafts/139-supervisor-crash-hardening-degraded-backoff-and-redirect-safety.md` (GitHub #450, closed) — already makes persistent child failures degraded/backoff instead of killing the supervisor.

Prior-art verdict: this is **not** a new cache design and not a GraphQL transport task. #453 already owns the shared REST-backed open-PR snapshot. The live 2026-06-30 evidence shows a recurrence/coverage gap after #453: multiple wake-supervisor children still log `gh pr list failed ... gh-wrapper: REST route failed ... (HTTP 403)`. That means the failing route is already REST, but the affected children are still causing upstream list traffic instead of relying on one shared snapshot in the hot path.

## Goal

Close the post-#453 live recurrence where wake-supervisor children still produce upstream `gh pr list` traffic and REST `HTTP 403` failures. Under a warm shared open-PR snapshot, the affected children must read local snapshot data and produce zero additional upstream `gh pr list` calls for the same repo/list key.

```behavior-kind
action-producing
```

## Binding surface

- The live affected children are in scope: `review-trigger-reconcile`, `ci-green-wake-reconcile`, `review-send-reconcile`, `review-finding-delivery-confirm`, `ci-failure-notification-reconcile`, and `ci-failure-notification-reaction`.
- Their open-PR inventory path must use the shared REST-backed open-PR snapshot from #453. A warm snapshot must satisfy their open-PR list needs without calling upstream `gh pr list`.
- Direct or indirect `gh pr list --state open` bypasses in these children must fail a registry-aware static guard unless they are inside the single shared snapshot producer.
- This issue must distinguish two cases in tests and diagnostics:
  - **Bypass/coverage regression:** a child calls upstream list without going through the shared snapshot.
  - **Snapshot producer failure:** the single shared producer calls REST and receives upstream `403`.
- The implementation must not switch these children back to GraphQL, add a hard token bucket, or redesign supervisor child lifecycle. If the shared snapshot producer itself still gets REST `403` after duplicate child list calls are removed, route that evidence to the existing Phase 2 hard-gate stub, not this task.
- **Operator adoption:** after merge, restart wake supervisor and confirm that the affected children no longer emit repeated `gh pr list failed ... REST route failed ... HTTP 403` lines during a warm snapshot window.

```contract-evidence
binding-id: orchestrator-pack:wake-supervisor-open-pr-snapshot:no-child-list-bypass
binding-type: cli-behavior
binding: affected wake-supervisor children use the shared open-PR snapshot and produce zero upstream gh pr list calls under a warm snapshot
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)
```

## Files in scope

- `scripts/**`
- `scripts/fixtures/**`
- `docs/migration_notes.md`

## Files out of scope

- New token bucket / cooperative backoff / circuit breaker machinery.
- GraphQL degraded-poll work from #540 and class-level GraphQL closure from #549.
- Changing GitHub REST inventory field mappings unrelated to open-PR list snapshots.
- Adding or removing wake-supervisor registry children.
- AO core, vendored upstream packages, or live runtime state files.

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

## Acceptance criteria

1. **Warm snapshot positive path:** a representative fixture creates a valid shared open-PR snapshot, runs each affected child's open-PR inventory path, and proves zero upstream `gh pr list` calls occur for the same repo/list key.

```positive-outcome
asserts: with a warm shared open-PR snapshot, every affected wake-supervisor child reads local snapshot data and emits no upstream gh pr list request
input: realistic
```

```producer-emission
producer: orchestrator-pack
datum: wake-supervisor-open-pr-snapshot
expected: no-child-list-bypass
proof-command: npm test -- github-fleet-cache-bypass
```

2. **Live-regression fixture:** a fixture modeled on the 2026-06-30 logs fails before the fix when multiple affected children each reach `gh pr list` and would receive REST `HTTP 403`; after the fix, only the shared snapshot producer may reach upstream and children consume the shared result.

3. **Registry-aware static guard:** adding a direct `gh pr list --state open` call to any registry child, or to a helper used by these children outside the shared snapshot producer, fails verification. Existing allowed textual mentions in tests/docs do not mask executable bypasses.

4. **Error attribution:** when an upstream REST `403` occurs inside the shared snapshot producer, logs distinguish `snapshot_populate_failed` from `child_list_bypass`. This prevents future RCA from mislabeling a producer failure as a child transport gap.

5. **No GraphQL fallback:** tests prove the affected open-PR list path does not call native GraphQL when REST/list fixtures fail.

6. **No Phase 2 creep:** no token bucket, circuit breaker, or repo-wide backoff is introduced by this issue. If producer-level REST `403` remains after duplicate child list calls are removed, the PR body or follow-up note points to the existing Phase 2 hard-gate path instead of expanding this scope.

## Upgrade-safety check

- No Composio AO core or vendored upstream edits.
- No secrets or live runtime state committed.
- No unsupported YAML fields.
- #453 cache semantics remain the basis; this issue closes coverage/adoption regression, not a replacement design.
- #540/#549 GraphQL work remains separate.

## Verification

```powershell
npm test -- github-fleet-cache-bypass
npm test -- github-fleet-cache-coalesce
npm test -- github-fleet-cache-memo
pwsh -NoProfile -File scripts/check-github-fleet-cache-bypass.ps1
pwsh -NoProfile -File scripts/verify.ps1
pwsh -NoProfile -File scripts/check-reusable.ps1
```

Operator post-merge verification:

```powershell
pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1 -Action Stop
pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1 -Action Start
Start-Sleep -Seconds 120
pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1 -Action Status
```

Then inspect the supervisor child logs for the affected children. During a warm snapshot window, they must not emit repeated `gh pr list failed ... gh-wrapper: REST route failed ... (HTTP 403)` lines.

## Decisions

### Prior Art

#447 and #431 already moved covered child reads to REST. The live error text `gh-wrapper: REST route failed ... (HTTP 403)` confirms those processes are not falling back to GraphQL. #453 already shipped the intended shared snapshot/memo layer. Therefore this task is a targeted post-#453 coverage regression: remove duplicate child-level open-PR list calls and prove warm snapshot reads produce no upstream list traffic.

### Options

| Option | Cost | Risk | Verdict |
|---|---:|---:|---|
| Add a hard GitHub circuit breaker now | High | Scope creep; user explicitly wants REST/list conversion, not backoff | Reject for this issue |
| Re-open #453 wholesale | Medium | Blurs a closed shipped task with a narrow live regression | Reject |
| Add targeted coverage fixtures + static guard for affected children | Low | Focused; directly matches live evidence | Choose |

### Stop Condition

This issue is done when affected children cannot bypass the shared open-PR snapshot under warm-cache conditions. It does not need to prove GitHub will never return REST `403` to the single producer; that belongs to Phase 2 if it still reproduces after duplicate list calls are removed.
