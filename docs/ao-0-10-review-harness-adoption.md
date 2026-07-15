# Pack-owned review runner adoption (Issue #839)

Operator steps for moving orchestrator-pack review invocation and run/status reads off the AO daemon on AO **0.10.x**.
This supersedes the daemon reviewer-harness procedure originally documented for Issue #623 and complements
[`ao-0-10-operator-upgrade-runbook.md`](ao-0-10-operator-upgrade-runbook.md).

## Prerequisites

- Pull the merged Issue #839 change into the trusted operator checkout.
- Node and PowerShell versions required by the repository verification suite are available.
- `PACK_REVIEWER` selects `codex` or `claude`; reviewer identity, model selection, prompt, and `[Pn]` contract remain owned by `scripts/invoke-pack-review.ps1`.
- The GitHub credential used by the runner belongs to a reviewer/bot identity distinct from the PR author. GitHub rejects self-approval and self-request-changes reviews.

## 1. Clear daemon reviewer-harness wiring

The pack runner starts the reviewer process directly. AO no longer owns review spawn or review run/status rows for this project.
Clear or omit the live project's `reviewers` key with the same full-config mechanism used for other AO project config changes.
Do not submit a partial config payload that unintentionally erases unrelated keys.

Inspect the live project first:

```bash
ao project get orchestrator-pack --json
```

Re-apply the complete intended project config with `reviewers` omitted or empty. The exact empty-state payload is AO-build dependent,
so verify the result rather than assuming the command succeeded semantically:

```bash
ao project set-config orchestrator-pack --config-json '<complete config with reviewers omitted or empty>'
ao project get orchestrator-pack --json
```

The verification result must show no active reviewer harness for `orchestrator-pack`.

## 2. Restart AO and recycle affected sessions

Restart/recycle AO according to the standard config-change procedure; do not assume a live daemon reloads project config automatically.
Recycle long-lived worker/orchestrator sessions when their tracked `AGENTS.md` or checkout content must change.

Pre-cutover daemon reviewer sessions are not consulted by the new claim/status logic. Remove the known one-time remnants:

```bash
ao session kill 109
ao session kill 124
# Also kill the stuck #835 fallback session identified in the live AO inventory.
```

The existing dead-session reconciliation path may be used instead. This is operator hygiene, not a new recurring review reaper.

## 3. Pack runner and status store

Control plane:

- `scripts/pack-review-runner.ts` — TypeScript/Node review runner.
- `scripts/lib/pack-review-run-store.ts` — durable pack-owned operational run/status store.
- `scripts/lib/Review-StartClaim.ps1` — existing authoritative atomic per-(PR, full head SHA) claim primitive.
- `scripts/lib/Invoke-AoReviewApi.ps1` — compatibility adapter for existing PowerShell consumers; it does not call daemon review trigger/list HTTP.
- `scripts/invoke-pack-review.ps1` — trusted reviewer selector/entrypoint, resolved from the trusted pack checkout rather than the reviewed worktree.

GitHub PR review is the sole durable verdict record. The local pack store contains operational run existence, status, claim ownership,
logs, and staleness evidence; it is not a competing verdict source.

Default state root:

```text
~/.orchestrator-pack/review-runs/orchestrator-pack
```

Overrides:

- `ORCHESTRATOR_PACK_STATE_ROOT`
- `PACK_REVIEW_RUN_STORE_ROOT`
- `PACK_REVIEW_RUN_STALE_MINUTES` (safe floor enforced)

## 4. Manual trigger and status

Manual and automatic paths use the same runner and the same `Review-StartClaim.ps1` authority.

Explicit PR/head:

```bash
node --experimental-strip-types scripts/pack-review-runner.ts start \
  --pr-number <PR> --head-sha <full-40-hex-head-SHA>
```

Session-bound trigger through the durable session/PR binding cache:

```bash
node --experimental-strip-types scripts/pack-review-runner.ts start \
  --session-id <worker-session-id>
```

Read operational status:

```bash
node --experimental-strip-types scripts/pack-review-runner.ts list \
  --project-id orchestrator-pack
```

The runner verifies the open PR's live head, creates an isolated exact-head worktree, invokes the trusted reviewer script,
posts the GitHub PR review, writes terminal status, and removes the worktree. It never calls or waits on `ao review submit`.

## 5. Automatic trigger paths

The existing automatic surfaces remain PowerShell orchestration/glue and acquire the existing shared claim before calling the runner:

- `scripts/lib/Invoke-ReviewWakeTrigger.ps1`
- `scripts/review-trigger-reconcile.ps1`
- `scripts/review-trigger-reeval.ps1`

They invoke the shared TypeScript runner through `Invoke-AoReviewTriggerForWorker` with the claim already acquired.
No separate manual-only shim exists; `scripts/ao-review.ps1` is retired.

Start or recycle the supervisor children after adoption:

```powershell
pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1
pwsh -NoProfile -File scripts/review-trigger-reconcile.ps1 -Once -DryRun
```

## 6. Review-before-cleanup and disappeared runners

`Worker-Recovery.ps1` continues to use `Assert-ReviewBeforeCleanupGate`, but the gate reads pack-store rows rather than daemon session reviews.
Do not remove a worktree or recover a worker while a fresh pack run covers the current PR head.

Self-reported reviewer failure/timeout writes terminal `failed` / `timed_out`. If the runner or host disappears before it can report,
the existing staleness window makes the row consumer-visible as failed (`runner_disappeared_stale`) and allows the existing stale-claim
recovery path to re-arm the key. No always-on review watchdog is added.

Corrupt, duplicate-active, or ambiguous records fail closed: a new review is not started and the operator receives an observable error.

## 7. Smoke proof

Use a real open PR whose current head satisfies the shared head-ready predicate.

1. Run one manual trigger and confirm exactly one runner starts.
2. Run `review-trigger-reconcile.ps1 -Once` for an eligible automatic trigger and confirm it invokes the same runner.
3. Confirm a GitHub PR review is posted for the exact head.
4. Confirm the pack store reaches `up_to_date`, `changes_requested`, `failed`, or `timed_out` rather than remaining `running` indefinitely.
5. Confirm the inventoried review scripts produce zero requests to `/api/v1/sessions/*/reviews` and `/reviews/trigger`.
6. Confirm a second near-simultaneous manual/automatic attempt on the same PR/head observes the existing claim/run and starts no second reviewer process.

The independent Reviews-board dashboard daemon client is intentionally outside this migration. Once daemon reviewer-harness wiring is removed,
that dashboard may show its documented empty/error state until a separate follow-up re-plumbs or retires it.

## Rollback

A Git revert restores the prior daemon seam in repository code. If rolling back, re-apply the previous complete AO project config deliberately
and restart AO. Do not leave both daemon reviewer spawn and the pack runner active: a parallel path breaks idempotency and can double-post reviews.

## Related

- Issue **#839** — pack-owned review runner and status store
- Issue **#719** — pack-owned session/PR binding cache precedent
- Issue **#718** — stdout-first confirmed delivery transport retained unchanged
- Issue **#658/#663** — trusted reviewer identity, prompt, model selection, structured findings, and clean verdict
- Issue **#746/#748** — worker liveness/status and one-time zombie cleanup support
