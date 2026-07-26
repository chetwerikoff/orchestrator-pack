# Vitest Runtime-History Protected-Branch Delivery

Issue `#990` extends the protected delivery path introduced by `#731` without
changing the measured runtime-history producer from `#691`. The generated
delivery class is intentionally narrow:

- repository: `chetwerikoff/orchestrator-pack`;
- base: `main`;
- head: `ci/vitest-runtime-history-refresh` in the same repository;
- changed path: `scripts/vitest-runtime-history.json` only;
- privileged actor: the login behind `VITEST_RUNTIME_HISTORY_DELIVERY_TOKEN`;
- merge owner: `.github/workflows/vitest-runtime-history-delivery.yml` on
  `pull_request_target`.

Ordinary contributor and worker PRs do not enter this path and retain the normal
PACK_REVIEWER contract.

## Exact refresh provenance

A data-changing refresh publishes repository-owned commit statuses on the exact
pushed delivery head under context:

`orchestrator-pack/runtime-history-provenance`

The fixed description binds the GitHub Actions run, run attempt, and source
`main` SHA:

```text
runtime-history-provenance run=<run-id> attempt=<attempt> source=<40-hex-main-sha>
```

The refresh posts `pending` immediately after the lease-protected branch push,
then posts `success` after the generated PR has been opened or updated. The
delivery monitor verifies the matching Actions run through the canonical refresh
workflow path, repository, run id/attempt, source `main` SHA, and successful
terminal conclusion. The source `main` SHA is provenance/audit data only; it is
not an ancestor/equality merge gate.

Missing, malformed, ambiguous, mismatched, or unsuccessful provenance fails
closed as `provenance-invalid`. The monitor gives the branch-push/status-publication
self-race one bounded poll before treating still-missing provenance as invalid. If
the PR head no longer equals the exact generated head (for example the empty-commit
recurrence from PR `#995`), the current head exits the unattended class immediately
as `non-generated-head`. The monitor neither blesses nor repairs that head. A later
successful refresh may re-enter the class with a newly bound generated head.

## Live `main` policy, not the historical snapshot

`docs/vitest-runtime-history-delivery-branch-protection.snapshot.json` remains a
historical audit artifact. It is no longer merge-readiness authority and is not
refreshed by this path.

At each decision boundary the monitor reads the current required-status-check
policy GitHub enforces for `main`, then evaluates current checks for the exact PR
head. A required context that appeared after the snapshot therefore blocks
merge until it is genuinely satisfied. Unavailable, malformed, ambiguous, or
unsupported policy fails closed.

The GitHub wrapper expansion is deliberately limited to three read shapes used
by this delivery contract:

1. current `main` required-status policy;
2. one exact refresh Actions run;
3. complete commit-status history for the exact delivery head.

The existing `pr checks` route remains the current-state source. The exact-head
status-history route exists only for same-context precedence and paginates until
completion; there is no generic Actions, reviewer-history, ruleset, or arbitrary
API subsystem.

## Repository-owned pack-review machine admission

If current `main` protection requires `orchestrator-pack/pack-review`, the
generated delivery path may satisfy it with one repository-owned machine status
only after identity, exact successful provenance, one-file scope, clean current
PR state, and every other current required CI context are proven.

The machine status is:

```text
context: orchestrator-pack/pack-review
state: success
description: runtime-history-machine-admission
```

This does **not** mean PACK_REVIEWER ran and it does not fabricate a review.
PACK_REVIEWER remains operator/out-of-band for this generated path. The
delivery workflow does not invoke it. Machine admission is emitted with the
workflow's repository-scoped `GITHUB_TOKEN`; the existing delivery credential
continues to own PR and merge operations.

## Race-safe operator precedence

GitHub's combined/current status view can hide an older record when another
writer posts the same context. Therefore the monitor independently projects the
complete exact-head history for `orchestrator-pack/pack-review`.

Records carrying `runtime-history-machine-admission` are machine records. Every
other record in the context is out-of-band/operator state. The latest
out-of-band record wins:

- `success`: the operator already satisfied pack-review; no machine write;
- `pending`: wait and do not publish or merge;
- `failure` / `error`: `operator-veto-observed`; do not publish or merge;
- no out-of-band record: machine admission may publish one success after all
  other gates pass.

When machine admission is needed, the monitor reads precedence, publishes one
machine success, immediately re-reads the complete history, and re-derives the
out-of-band projection. Thus a concurrent operator failure/error/pending cannot
be erased logically by the machine's later same-context success. An ambiguous
or incomplete history fails closed as `status-history-unprovable`.

Immediately before merge, the monitor again reads the PR/head, file list,
provenance/run, current policy, current `pr checks`, and complete exact-head
status history. There is no machine status write after this final history read.

## Expected-head merge and read-back

The existing squash merge remains expected-head protected:

```text
PUT pulls/<pr>/merge
merge_method=squash
sha=<exact-generated-head>
```

No second merge actuator or bypass exists. After every merge attempt, including
an attempt whose transport fails, the monitor first reads authoritative PR state.
If that read-back already proves the expected PR merged into `main`, the episode
is complete and no duplicate mutation is attempted. If GitHub reported a
successful merge but authoritative read-back does not confirm it, the monitor
fails observably as `merge-readback-failed`.

When a merge is rejected or its transport fails and authoritative read-back
shows the PR is still unmerged, the monitor re-reads the mutable proofs and
returns to the bounded decision. Any later merge attempt therefore follows fresh
head, provenance, current-policy, current-check, and out-of-band-history proof
rather than blindly retrying stale evidence.

Squash semantics do not require the resulting `main` SHA to equal the delivery-head
SHA. Conflicted/unmergeable generated PRs retain the `#757` close-as-obsolete
behavior.

## Permissions and credentials

- The refresh job adds only `statuses: write` to its existing `contents: write`
  permission so `GITHUB_TOKEN` can emit the provenance statuses.
- The trusted delivery workflow adds `statuses: write` for the generated
  machine-admission status and keeps `VITEST_RUNTIME_HISTORY_DELIVERY_TOKEN` for
  the existing privileged PR/merge path.
- There is no new standing credential or branch-protection bypass.
- The runtime-history artifact and the historical branch-protection snapshot are
  never hand-edited by this change.

## Rollout verification

After the implementation lands, observe the first fresh **data-changing**
runtime-history refresh. Record:

- refresh run id and attempt;
- source `main` SHA;
- generated delivery head and PR;
- provenance pending/success binding;
- current required contexts;
- machine-admission result when pack-review is required;
- exact-head out-of-band status projection;
- expected-head merge result;
- authoritative merged-PR read-back.

From generated PR creation through merge/read-back, no operator PACK_REVIEWER
invocation, empty retrigger commit, merge command, snapshot refresh, or manual
retry is part of the successful unattended episode. A no-diff refresh is valid
producer behavior but does not satisfy this rollout observation because it
creates no delivery PR.
