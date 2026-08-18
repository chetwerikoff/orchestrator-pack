# Vitest Runtime-History Protected-Branch Delivery

Issue `#990` extends the protected delivery path introduced by `#731` without
changing the measured runtime-history producer from `#691`. The generated
delivery class is intentionally narrow:

- repository: `chetwerikoff/orchestrator-pack`;
- base: `main`;
- head: `ci/vitest-runtime-history-refresh` in the same repository;
- changed path: `scripts/vitest-runtime-history.json` only;
- generated branch/PR actor: the login behind `VITEST_RUNTIME_HISTORY_DELIVERY_TOKEN`;
- current-policy read and expected-head merge actor: that same capability-bearing
  delivery identity;
- repository-owned machine-admission status actor: the `pull_request_target`
  workflow's repository-scoped `GITHUB_TOKEN`.

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

## Bounded supplemental light-target refresh

The refresh workflow has one explicit, closed supplemental mode for
`scripts/pack-reviewer-preference.test.ts`. It is enabled only by a
`workflow_dispatch` input containing the full 40-hex SHA of a same-repository
source commit. The measurement job checks out that exact commit, verifies that
the source tree classifies the fixed target as `light`, runs only that target,
and uploads the standard Vitest report plus source-bound companion metadata.

That job has `contents: read` permission and no delivery or status authority.
The privileged refresh job runs the checked-in `main` producer and consumes the
downloaded report as data. It never runs code, package hooks, or commands from
the measured checkout. The producer rejects missing, duplicate, malformed,
failed, wrong-lane, wrong-target, wrong-source, non-finite, zero, or negative
evidence before changing history.

Bounded provenance uses a compact versioned status description so the full
identities remain below GitHub’s 140-character commit-status limit:

```text
runtime-history-provenance/v1 r=<run-id> a=<attempt> s=<trusted-workflow-sha> x=<measured-source-sha>
```

The `x` field implies the fixed supplemental target and the trusted workflow
revision is the `s` field; the parser rejects any incomplete or mismatched
binding. Ordinary refreshes retain the legacy-compatible provenance form.

The delivery monitor requires every status row in one episode to bind the same
run, attempt, trusted workflow revision, measured source revision, and fixed
target. The status is published on the exact generated delivery head, so the
existing exact-head and one-file delivery gates remain authoritative. Ordinary
heavy-shard refreshes retain the legacy-compatible provenance form.

A same-payload retry preserves the existing stable delivery head only when that
remote head already has exact provenance whose bound refresh run/attempt is
terminally successful. The refresh checks the existing exact-head status history
and that one bound Actions run before deciding to skip the push. If the existing
provenance is missing, malformed, bound to a failed/non-successful run, or
otherwise cannot establish a successful episode, the retry does **not** reuse that
head as an unattended authority. It keeps the reconciled payload, regenerates a
distinct generated commit identity when necessary, and lease-pushes a fresh exact
head so the new refresh episode can emit its own provenance and retrigger the
existing delivery PR. This closes the crash window where a prior episode pushed
and opened the PR but failed before its terminal provenance write: an identical
later measurement can recover without an empty operator retrigger commit or
manual intervention.

Missing, malformed, ambiguous, mismatched, or unsuccessful provenance fails
closed as `provenance-invalid`. The monitor gives the branch-push/status-publication
self-race one bounded poll before treating still-missing provenance as invalid. If
the PR head no longer equals the exact generated head (for example the empty-commit
recurrence from PR `#995`), the current head exits the unattended class immediately
as `non-generated-head`. The monitor neither blesses nor repairs that head. A later
successful refresh may re-enter the class with a newly bound generated head.

## Generated branch publication and late `main` drift

Issue `#1469` removes the failed cross-ref CAS introduced by `#1384` / PR `#1398`.
The refresh producer never submits `refs/heads/main` to `updateRefs`, `git push`, a
REST ref update, or another ref-mutation request. Protected `main` changes only
through its sanctioned PR/merge path.

Commit-back first fetches `origin/main`, resets to that trusted head, and either
preserves the source proposal or performs the existing measurement-only stale
reconcile. Stale reconciliation is allowed only when the complete canonical
Vitest inventory is equal. Addition, deletion, or reintroduction of a canonical
test path refuses before a delivery commit is prepared.

### Ownership split after the first rollout

The first post-#1468 rollout exposed a separate legacy measured-weight reconcile
defect. That defect is owned by Issue `#1472` / PR `#1473`. The repair is deliberately
caller-side at `reconcile --require-equal-inventory`; this Issue does not duplicate
that repair and does not change `mergeConcurrentRefreshes` or
`reconcileProposedHistoryAgainstRemote` in
`scripts/lib/vitest-runtime-history-merge.mjs`.

Issue `#1469` retains the surrounding publication contract: trusted-main candidate
validation, final result reporting, artifact shape, merge authority, and live
rollout proof. If S6 later proves that the fourteen legacy weighted paths are still
lost after `#1473` has landed, that preservation finding returns to `#1472` rather
than creating a third merge-library refactor task.

### Trusted-main publication guard

Every production `reconcile --require-equal-inventory` call is already positioned
before delivery publication. At that existing boundary, the CLI now reads the raw
history from the exact trusted `main` tree and validates the candidate before any
remote delivery mutation:

- every canonical path with a finite positive trusted-main weight retains a finite
  positive candidate weight;
- trusted `measured` / `seeded` provenance is not reduced to missing/fallback
  state;
- `contentSha` shape and values are projected from current trusted `main`, with
  entries pruned only when the canonical path is absent from that trusted tree;
- the result count is derived from the actual candidate bytes produced at that
  boundary, rather than describing an earlier intermediate artifact;
- in GitHub Actions production reconciliation, the candidate is passed through the
  existing pre-topology unresolved-target authority. The owner and
  `PRE_TOPOLOGY_MAX_FILES = 32` remain unchanged. If the existing authority
  observes more than 32 live measurement targets, reconciliation exits non-zero
  before the delivery branch, provenance, or generated PR can be published.

This guard intentionally does not redefine merge-library semantics and does not
introduce a second approximation of the topology bound. Equal-inventory `main`
advancement remains compatible with existing stale-reconcile semantics because
artifact shape is taken from the newly fetched trusted-main history, not from an
older pending/generated candidate.

Immediately before publication, the producer fetches `main` again, checks the
prepared history against that tree with `--require-equal-inventory`, and requires
the freshly observed `main` SHA to equal the parent of the prepared one-file
delivery commit (`HEAD^`). This binds the generated commit to the exact trusted
base on which it is about to be published without requiring the workflow's
original `GITHUB_SHA` to remain current. An equal-inventory advancement that was
already reconciled during commit-back therefore remains valid; a later base
advance requires a fresh refresh rather than fabricated membership.

Only `ci/vitest-runtime-history-refresh` is then updated. Existing-branch updates
use an exact `--force-with-lease` expectation for the previously fetched remote
head; first publication uses the corresponding absent-ref lease. A stale lease
fails rather than overwriting an unrelated newer delivery head.

After the delivery-ref update, the producer fetches `main` once more. If it moved,
the producer restores the prior delivery ref, or deletes a newly created ref,
using a lease that expects the just-pushed generated head. The run fails before
provenance or PR publication. Failure to perform that rollback also fails
observably; it never becomes successful delivery evidence.

There remains an unavoidable interval after the producer's final read and before
the protected merge request. The delivery monitor closes that interval without a
second `main` mutation. If GitHub reports the generated PR as `behind`, the monitor
closes it as obsolete and requires a fresh complete refresh from the newer base.
For the final read/merge race, the monitor live-reads the current required-status
policy and requires `strict: true`; a non-strict policy is
`current-policy-unsupported` and cannot authorize merge.

The monitor re-reads mutable proof before any later merge attempt. The focused
regression matrix covers add, delete, and reintroduce membership drift after
candidate preparation: each stale candidate becomes obsolete, performs no merge,
and requires a fresh complete refresh. An equal-inventory late advance is
conservatively handled by the same fresh-base retry and never requires a threshold
change or fabricated history membership.

## Live `main` policy, not the historical snapshot

`docs/vitest-runtime-history-delivery-branch-protection.snapshot.json` remains a
historical audit artifact. It is no longer merge-readiness authority and is not
refreshed by this path.

At each decision boundary the monitor reads the current required-status-check
policy GitHub enforces for `main`, then evaluates current checks for the exact PR
head. A required context that appeared after the snapshot therefore blocks
merge until it is genuinely satisfied. Unavailable, malformed, ambiguous,
unsupported, or non-strict policy fails closed.

The first live recurrence proved that the repository-scoped `GITHUB_TOKEN` cannot
serve this boundary: its real request to
`branches/main/protection/required_status_checks` returned HTTP 403 (`Resource not
accessible by integration`). The same identity is not the protected-main merge
identity relied on by this repository either. Therefore the delivery job uses the
already configured `VITEST_RUNTIME_HISTORY_DELIVERY_TOKEN` for the live policy
read and expected-head merge. Before monitor/merge it performs a read-only
capability probe and records the current required contexts. S4 remains the
required live proof: HTTP 200 on a real `pull_request_target` event; fixture/static
shape alone cannot close that criterion.

The GitHub wrapper expansion is deliberately limited to three read shapes used
by this delivery contract:

1. current `main` required-status policy;
2. one exact refresh Actions run;
3. complete commit-status history for the exact delivery head.

The existing `pr checks` route remains the current-state source. The exact-head
status-history route exists only for same-context precedence and paginates until
completion; there is no generic Actions, reviewer-history, ruleset, or arbitrary
API subsystem. The refresh retry recovery reuses the same already-classified
exact-head status-history and single Actions-run reads; it does not add another
GitHub read shape.

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
workflow's repository-scoped `GITHUB_TOKEN`; `MACHINE_STATUS_TOKEN` temporarily
selects that token only for this status write. Policy reads and merge calls remain
on the delivery identity.

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

No second merge actuator exists. The merge request is issued only by the trusted
`pull_request_target` delivery workflow using the capability-bearing
`VITEST_RUNTIME_HISTORY_DELIVERY_TOKEN`. After every merge attempt, including an
attempt whose transport fails, the monitor first reads authoritative PR state. If
that read-back already proves the expected PR merged into `main`, the episode is
complete and no duplicate mutation is attempted. If GitHub reported a successful
merge but authoritative read-back does not confirm it, the monitor fails
observably as `merge-readback-failed`.

When a merge is rejected or its transport fails and authoritative read-back
shows the PR is still unmerged, the monitor re-reads the mutable proofs and
returns to the bounded decision. Any later merge attempt therefore follows fresh
head, provenance, current-policy, current-check, and out-of-band-history proof
rather than blindly retrying stale evidence.

Squash semantics do not require the resulting `main` SHA to equal the delivery-head
SHA. Conflicted/unmergeable or behind generated PRs use the close-as-obsolete
behavior and require regeneration from current `main`.

## Permissions and credentials

- The refresh job adds `statuses: write` for provenance emission and `actions: read`
  for the bounded same-payload provenance recovery check, alongside its existing
  `contents: write` permission.
- `VITEST_RUNTIME_HISTORY_DELIVERY_TOKEN` remains the existing credential for
  generated branch publication, generated PR open/update, trusted sender identity,
  current required-policy read, and expected-head merge.
- The delivery workflow's repository-scoped `GITHUB_TOKEN` remains the
  repository-owned machine-admission status writer only; it is not treated as an
  administration-capable protected-main policy reader or merge authority.
- There is no new standing credential or branch-protection expansion.
- The runtime-history artifact and the historical branch-protection snapshot are
  never hand-edited by this change.

## Operational pause and rollout verification

The refresh producer is intentionally disabled while Issue `#1469` remains in the
repair phase. PR `#1471` stays open and unmerged as the real red-head negative
artifact for S5. Do not repair it by hand and do not re-enable the producer merely
to obtain another candidate.

The current ownership/order is:

1. review and land PR `#1473` (owner: `#1472`);
2. land the merge-authority and fail-closed publication repair (owner: `#1469`);
3. re-enable the producer only as the first action of S6;
4. run S6 end to end;
5. run S7 against PR `#1467`.

For the first fresh **data-changing** runtime-history refresh after re-enable,
record:

- refresh run id and attempt;
- source `main` SHA;
- prepared delivery commit parent and generated delivery head;
- generated delivery PR;
- trusted and candidate positive-weight counts from the final production reconcile;
- existing pre-topology unresolved-target count and unchanged bound `32`;
- provenance pending/success binding;
- successful current-policy capability probe and listed required contexts;
- machine-admission result when pack-review is required;
- exact-head out-of-band status projection;
- expected-head merge result;
- authoritative merged-PR read-back;
- confirmation that the producer performed no protected-`main` ref mutation;
- confirmation that post-rollout `main` retains every canonical weighted path it
  had before S6. This is AC10 verification; preservation implementation remains
  owned by `#1472` / `#1473`.

AC9 no longer authorizes task creation. After generated history reaches `main`,
rebase/update PR `#1467` from current `main` and obtain fresh exact-head CI. If
`Verify orchestrator-pack structure` still reports more than 32 unresolved targets,
record the observed count and evidence as a comment on Issue `#1469` and stop. Do
not raise the bound, relocate the `#1380` test, hand-edit history, or create a new
Issue, PR, or branch without an explicit operator instruction.

From generated PR creation through merge/read-back, no operator PACK_REVIEWER
invocation, empty retrigger commit, merge command, snapshot refresh, manual
history edit, branch-protection change, or manual retry is part of the successful
unattended episode. A no-diff refresh is valid producer behavior but does not
satisfy S6 because it creates no delivery PR.
