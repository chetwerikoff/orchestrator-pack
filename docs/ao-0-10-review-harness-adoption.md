# Pack-owned review runner adoption (Issue #839)

## Purpose

The pack owns review invocation and operational run/status tracking. AO must not spawn a reviewer for this project. Manual and automatic triggers both enter `scripts/pack-review-runner.ts`, which invokes `scripts/invoke-pack-review.ps1` from the trusted pack checkout, posts the GitHub PR review directly, and records operational state in the pack-side run/status store.

GitHub PR review is the authoritative verdict record. The local store is authoritative only for run existence, in-flight/terminal status, and the run bound to a `(PR, head)` claim. Repository-tracked configuration documents the cutover, but only the operator adoption below changes the live gitignored AO project state.

## Commands

Manual trigger by worker binding:

```bash
node --experimental-strip-types scripts/pack-review-runner.ts start --session-id <worker-session-id>
```

Manual trigger by explicit target:

```bash
node --experimental-strip-types scripts/pack-review-runner.ts start --pr-number <pr> --head-sha <40-hex>
```

Operational status:

```bash
node --experimental-strip-types scripts/pack-review-runner.ts list --project-id orchestrator-pack
```

The adjacent `.js` modules are import-only NodeNext runtime bridges; operators continue to invoke the TypeScript entrypoint shown above. Existing PowerShell adapters resolve that entrypoint through `Get-OpkTypeScriptNodeArguments`: Node 22 uses native strip-types execution, while the repository's Node 20 CI baseline uses the committed TypeScript loader fallback.

Automatic review uses the same runner through the existing PowerShell reconcile and wake adapters. The preserved `scripts/lib/Review-StartClaim.ps1` mutex, atomic-write, and stale-reclaim primitive remains the concurrency authority. Do not use daemon review endpoints or `ao review submit` as a transition or fallback path.

## Required post-merge adoption

1. Read the live project config with `ao project get orchestrator-pack --json`.
2. Clear reviewer-harness wiring. Use the live daemon's accepted empty-state shape: set `reviewers` to an empty array or omit the key, then read the config back and verify that no reviewer harness remains. Do not infer success from exit code alone.
3. Restart the AO daemon or recycle the affected project session according to the local config-change procedure. Verify a newly spawned or restored session observes the cleared config.
4. Remove known pre-cutover reviewer zombies: session 109 for PR #758, session 124 for PR #820, and the stuck #835 fallback. Use `ao session kill` or the existing dead-session reconciliation path. This is one-time hygiene, not a new recurring reaper.
5. Run one fresh manual trigger and one fresh automatic trigger on real open PR heads. For each run verify:
   - the pack runner creates or reuses exactly one current-head run;
   - the trusted reviewer process completes;
   - a GitHub PR review is posted;
   - the pack store reaches terminal status;
   - no daemon review HTTP traffic occurs.

## Failure handling

- Missing, corrupt, duplicate, or ambiguous binding/store state fails closed. Repair it rather than falling back to AO.
- A disappeared stale runner is observed as failed and becomes reclaimable through the existing claim policy.
- A reviewer non-zero exit or timeout records terminal `failed` or `timed_out`; neither is a clean review.
- A new PR head uses a distinct claim key. Trigger the new head instead of reusing stale-head success.

## Rollback

Revert the pack-runner change and deliberately restore the previous project reviewer configuration. Never leave pack and daemon invocation active in parallel because that breaks the exactly-one-run contract.
