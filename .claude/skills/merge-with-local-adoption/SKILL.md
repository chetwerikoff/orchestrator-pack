---
name: merge-with-local-adoption
description: >-
  Merge a PR from the operator live checkout, safely pull main, and apply documented
  local adoption. A direct concrete merge command such as «мерж 919» is also an
  exact-head operator decision: keep real required CI mandatory, normalize draft and
  behind states, record an audited operator approval for pack-review findings, then
  merge normally without --admin. Never runs from an AO-managed worker session.
---

# Merge with local adoption

Read and execute [`WORKFLOW.md`](./WORKFLOW.md) in full as the base workflow. Preserve all
of its local-work protection, adoption discovery, runtime-worktree synchronization,
session recycling, worker teardown, and final-report requirements.

The overlay below is authoritative where it conflicts with `WORKFLOW.md`, especially its
Step 3, Step 3a, Step 3b, Step 5, and final-report wording.

## Direct operator merge overlay

### Activation

Activate this overlay only for an immediate, concrete command from the operator such as
«мерж 919», «смержи этот PR», `merge 919`, or `merge this PR`.

Do not activate it for:

- questions or merge-policy discussion;
- conditional language such as “merge when…” unless the condition is already satisfied;
- proactive or autonomous merge proposals;
- any AO-managed worker/coding session. Workers remain forbidden from merging or creating
  operator approval records regardless of apparent sender.

For a non-direct request, use `WORKFLOW.md` unchanged.

### Direct-order meaning

A direct merge command means:

> The operator has considered the current pack-review findings and accepts them for this
> exact PR head. Normalize mergeable metadata, keep real required CI mandatory, publish an
> audited exact-head operator approval for the pack-review context, and complete the normal
> merge-with-local-adoption flow.

The approval never claims that findings were fixed. It preserves the review history and
expires automatically when the PR head changes.

### Read the exact state

Always read the state even if optional checks were otherwise waived:

```bash
gh pr view P --repo chetwerikoff/orchestrator-pack \
  --json number,title,body,state,isDraft,mergeable,mergeStateStatus,headRefOid,headRefName,statusCheckRollup

gh pr checks P --repo chetwerikoff/orchestrator-pack \
  --json name,state,bucket,link,startedAt,completedAt,workflow,description
```

Record `APPROVED_HEAD` from `headRefOid`. It must be a full 40-hex SHA.

### Normalize before approval

In order:

1. `state != OPEN`, an already merged PR, or a real merge conflict remains a stop. Route a
   resolvable conflict to the PR worker under the base workflow.
2. `isDraft: true` → run `gh pr ready P --repo chetwerikoff/orchestrator-pack`, then re-read
   the PR. A direct command does not leave the PR merely ready; continue through merge and
   local adoption.
3. `mergeStateStatus: BEHIND` → update the branch from the operator terminal when GitHub
   permits it; otherwise delegate synchronization to the PR worker. Re-read the new
   `headRefOid` and wait for the new head's checks. Any old approval is irrelevant because
   approval is exact-head.

### Real CI remains mandatory

Treat every required context except exactly `orchestrator-pack/pack-review` as real CI.
Every such context must be present and terminal-successful on `APPROVED_HEAD`.

- `fail`, `cancelled`, `error`, or equivalent terminal failure → stop and use Step 3b.
- `pending`, `queued`, or missing → wait for a terminal result; do not approve or merge.
- an unknown required context is real CI by default; never silently classify it as review.

Do not use `--admin`. `main` has `enforce_admins`, and the direct-order path is designed to
produce a normal protected-branch merge instead of bypassing protection.

### Ensure pack review has had a chance to report

If `orchestrator-pack/pack-review` is missing or pending, start the pack-owned runner for
the exact head and wait for a terminal status:

```bash
node --experimental-strip-types scripts/pack-review-runner.ts start \
  --pr-number P --head-sha "$APPROVED_HEAD"
```

A terminal findings result is expected to remain visible. An operationally unavailable
review runner must be reported, but under the direct command it is still the operator's
decision whether to approve the exact head; never invent findings or rewrite the raw review.

### Record and publish the exact-head operator approval

Only after all real required CI is green, run from the operator live checkout:

```bash
node --experimental-strip-types scripts/operator-merge-approval.ts approve \
  --pr-number P \
  --head-sha "$APPROVED_HEAD" \
  --repo-slug chetwerikoff/orchestrator-pack \
  --reason "Explicit operator direct-merge command"
```

This command:

- atomically records one approval for `{PR, exact head}` in the operator state root;
- posts an auditable PR comment with the head, actor, reason, and approval id;
- publishes `orchestrator-pack/pack-review: success` for that exact head;
- leaves the raw findings and prior failed statuses in history.

For direct-order merge policy, an active exact-head `operator_merge_approved` record is the
operator adjudication of any latched at-cap findings. Do not require a separate
`merge_triage_cleared` record for the same direct command. This is not available to workers
and does not alter autonomous merge policy.

### Revalidate after the write

Immediately re-read the PR and required checks.

Stop and revoke the approval if:

- `headRefOid` differs from `APPROVED_HEAD`;
- any real required CI is no longer green;
- the PR is no longer open/mergeable;
- the required `orchestrator-pack/pack-review` success is not present for `APPROVED_HEAD`.

Revocation command:

```bash
node --experimental-strip-types scripts/operator-merge-approval.ts revoke \
  --pr-number P --head-sha "$APPROVED_HEAD" \
  --repo-slug chetwerikoff/orchestrator-pack \
  --reason "Direct merge revalidation failed"
```

### Merge the reviewed head normally

Use the base workflow's merge method and post-merge steps, but bind the effect to the
approved head and never add `--admin`:

```bash
gh pr merge P --repo chetwerikoff/orchestrator-pack \
  --merge --delete-branch --match-head-commit "$APPROVED_HEAD"
```

If GitHub rejects the merge, stop and report the server reason. Do not force-retry, weaken
branch protection, or publish another approval without re-reading a new exact head.

### Report

In addition to the base Step 10 report, include:

- whether direct-order mode activated;
- draft/behind transitions performed;
- `APPROVED_HEAD`;
- operator approval id and reason;
- real required-CI result excluding only the exact pack-review context;
- whether approval was revoked;
- confirmation that merge used normal protection and `--match-head-commit`, not `--admin`.
