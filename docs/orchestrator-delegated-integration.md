# Orchestrator-delegated integration

This runbook owns the bounded post-readiness integration phase for Issue #926.
It extends the existing supervised local-worker and merge/adoption authorities;
it does not create another review, merge scheduler, durable outcome store, or
credential boundary.

## Sequence and serialize

After implementation, required review, CI, and current-head smoke are complete,
the orchestrator re-reads the live Issue, PR/head/base, `main`, and each concrete
explicit dependency named by the task. Resolve only explicit relationships into
`merge_now` or `wait_for_dependency`. A `wait_for_dependency` decision launches no
integration worker and authorizes no delegated effect. Issue closure is not proof that a
dependency PR landed, and broad file overlap is not a dependency.

Serialize the primary checkout by live reasoning. If another delegated
integration assignment for that checkout is still active, wait. After a
terminal or proven-inactive predecessor, re-read dependency, readiness,
mergeability, head, and base facts instead of retaining a lock, queue, lease, or
serialization store.

## Assignment carrier

Launch the integration worker through
`scripts/pr2-foundation/supervised-worker-start.ts` as a normal local Orca
worker with `--role worker`. Its current WorkerAssignment may carry exactly one
optional `delegatedIntegration` marker with only:

- `prNumber`;
- `expectedHeadSha`, the 40-hex current PR head;
- `predecessorAssignmentId`;
- `predecessorGeneration`.

The marker is structured policy data, not a free-form mode string or
cryptographic capability. Publication requires a numbered Issue, local Orca
worker role, an exact current worker predecessor, and matching predecessor
id/generation. The replacement receives its normal new assignment id and
generation.

The existing WorkerAssignment store remains the only persistent carrier.
Malformed or extra-key marker state, an absent marker, changed PR/head or
predecessor, stale assignment, or a different current `taskId` performs no
delegated integration effect. Reuse is allowed only when the already-current
integration assignment carries the same exact marker. The existing
`withCurrentWorkerAssignmentFence` compares the marker as part of exact-current
identity. Do not create a second role, assignment store, integration registry,
lease, lock, queue, heartbeat, or outcome ledger.

When a direct CLI start is required, enter through the canonical TypeScript
launcher rather than launching the business entrypoint directly:

```bash
node --experimental-strip-types scripts/lib/Invoke-TypeScriptCli.ts \
  --script scripts/pr2-foundation/supervised-worker-start.ts -- \
  --issue-number <ISSUE> --repository <owner/repo> --role worker \
  --delegated-integration '{"prNumber":<PR>,"expectedHeadSha":"<40-hex>","predecessorAssignmentId":"<wa-id>","predecessorGeneration":<N>}' \
  -- --task <task-id> <ordinary supervised Orca worker-start args>
```

Immediately before every delegated status write, merge, primary-checkout
adoption mutation, or task-owned recovery mutation, re-read the exact current
assignment/Dispatch identity and marker and fail closed on drift. Long-lived
free-form prompt text is never authority.

## Canonical readiness and projection repair

Canonical readiness remains `evaluatePostSmokeReadiness()` in
`scripts/worker-smoke-run.ts`. It binds the live current WorkerAssignment into
the existing `evaluateReadiness()` target and supplies current PR
identity/head, review-independent required CI, required review/finding/cap
facts, exact-head smoke, and one accepted corroborated current-worker lifecycle.
The integration worker therefore establishes its ordinary corroborated current
worker lifecycle and consumes that production result for its own exact
assignment/PR/head. Delegated integration proceeds only when the result is
exactly `READY_TO_MERGE`.

Do not reconstruct readiness from individual GitHub statuses,
`reviewStageComplete`, tier-cap state, strict-descendant settlement, or prose.
Draft/conflict/mergeability and live dependency sequencing remain separate fresh
merge gates.

If canonical production readiness is already `READY_TO_MERGE` but the
exact-head `orchestrator-pack/pack-review` commit status is FAILURE or absent,
the delegated worker may repair only that stale/missing projection under
`docs/pack-review-waiver-merge-runbook.md`. Re-read assignment+marker,
sequencing, PR head/base, readiness, draft/conflict, and mergeability
immediately before the status POST and again before merge. The description must
identify an orchestrator-delegated projection repair after
`READY_TO_MERGE`. The write does not prove a review ran, resolve a finding,
waive smoke/CI/dependency order, or synthesize readiness. SUCCESS needs no
repair; NOT_READY or unknown authority remains blocked.

## Merge, adoption, and report

Run the delegated branch of
`.cursor/skills/merge-with-local-adoption/SKILL.md`. Local-adoption prose is a
hint only: independently inspect the Issue, PR body including
`## Operator adoption`, changed paths/content, active migration/runbooks, and
live operator-machine state. Apply only source-derived task-owned changes, then
use the smallest supported real CLI/API/status read-back for every runtime
behavior changed by the PR. Cleanup remains the existing exact-target worktree
lifecycle and does not broaden to the primary checkout or sibling work.

The final handoff reports the PR, merge SHA, adopted local HEAD, source
paths/config/runbooks and live observations that drove adoption, applied
adoption actions, live verification result, exact residual state/blocker, and
next action. The outcome vocabulary is only
`operationally_complete` or `operationally_incomplete`; neither value is
persisted as a WorkerReport state or in a new durable outcome store.

For a post-merge failure, stop further mutation and report exact residual
machine state by default. Restore a task-owned local mutation only when the
component's current supported runbook/CLI/API already defines a compatible
reverse/restore operation with read-back. Do not invent a generic
rollback/snapshot service.
