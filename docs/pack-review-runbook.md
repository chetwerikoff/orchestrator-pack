# Pack-owned PR review — canonical operator runbook

This is the single complete description of the current `orchestrator-pack` PR-review
contract. Other live documents should contain only audience-specific rules and a link
here. Historical issue drafts, migration records, and open pull requests are not runtime
authority.

## Ownership and upstream boundary

PR review for this pack is owned by `orchestrator-pack`:

- manual and automatic starts enter `scripts/pack-review-runner.ts`;
- `scripts/invoke-pack-review.ps1` is the reviewer-agnostic subprocess entrypoint;
- `PACK_REVIEWER=codex|claude` selects the reviewer behind that entrypoint;
- the pack review-run store is the durable operational and result record;
- GitHub receives a COMMENT review for human presentation;
- exact-head status `orchestrator-pack/pack-review` is the pack review merge-authority signal;
- worker notification is an independent delivery channel.

AO review surfaces remain available upstream in AO 0.10.3, including review HTTP API,
`ao review submit`, and project reviewer configuration. `orchestrator-pack` does not use
those surfaces as invocation, status, delivery, or merge-authority paths. They are
**retired by orchestrator-pack**, not removed upstream, and are not fallback or dual-write
paths for pack-owned review.

The tracked `agent-orchestrator.yaml.example` is a legacy-import example and migration
fixture. AO 0.10.3 does not apply its old `orchestratorRules`, `reactions`, `runtime`,
`workspace`, tracker, SCM, or rules fields as live pack-review policy. The current
operator contract is this runbook; worker instructions live in `AGENTS.md`.

## Durable PR ↔ session binding

The durable binding is pack-owned and stored locally at:

```text
~/.local/state/orchestrator-pack-wake-supervisor/pr-session-binding-cache.json
```

`AO_PR_SESSION_BINDING_CACHE` may override that path. The cache record binds repository,
PR number, session id, issue signal, and the last registered head when available.

For a start using `--session-id`, `pack-review-runner.ts` resolves the repository,
`prNumber`, and saved head from this cache, then independently queries GitHub and verifies
that the PR is open and the requested target is still its current head. A stale or
ambiguous binding fails closed.

AO session data has only a supporting role:

- confirm that the session exists;
- distinguish worker and orchestrator roles;
- determine live or terminated state;
- provide `issueId` as an additional signal.

AO Reviews do not participate in durable binding. Do not infer PR ownership from AO review
state. Also do not assume the AO 0.10.3 bulk `ao session ls --json` result contains
`branch`, `prs[]`, `prNumber`, `.pr`, or `ownedHeadSha`; it does not. A `prs[]` value may
appear in the result of `session claim-pr`, but it is not a bulk-session-list field.

This document intentionally does not describe unmerged fallback work from other pull
requests as current behavior.

## Manual start

Start from a durable worker-session binding:

```bash
node --experimental-strip-types scripts/pack-review-runner.ts start \
  --session-id <worker-session-id>
```

Start from an explicit immutable target:

```bash
node --experimental-strip-types scripts/pack-review-runner.ts start \
  --pr-number <pr-number> \
  --head-sha <40-hex-head-sha>
```

The runner checks the open PR and current GitHub head before review. Head drift fails
closed; review the new head with a new start.

## Exact-head execution

The runner reviews one `(repository, PR number, 40-character head SHA)` target. It creates
a detached worktree at that SHA and treats the reviewed checkout as untrusted input.
Runner code, store code, prompts, and reviewer wrappers are resolved from a trusted pack
checkout.

Automatic starters converge on the same runner and shared per-(PR, head) claim. They may
plan or enqueue a candidate, but immediately before launch they must re-check the current
head, readiness, coverage, and claim ownership. No live pack path invokes `ao review run`.

## Durable result and delivery sequence

The current ordering is:

1. invoke the selected reviewer in the exact-head detached worktree;
2. parse and validate the terminal JSON payload;
3. persist the verdict and complete findings list in the pack run journal;
4. attempt the GitHub COMMENT review;
5. attempt exact-head status `orchestrator-pack/pack-review`;
6. attempt worker notification;
7. record each channel outcome independently and terminalize the run.

A GitHub COMMENT, required status, or worker-notification failure does not turn a valid
reviewer result into reviewer-process failure and does not erase the journaled verdict.
Same-head recovery resumes incomplete delivery from the journal. It must not recompute an
already journaled review or derive one channel's result from another channel.

Malformed, empty, or contradictory terminal output is failure, not a clean review. A
reviewer timeout or non-zero exit also produces no clean signal.

## Status and evidence

List pack-owned runs:

```bash
node --experimental-strip-types scripts/pack-review-runner.ts list \
  --project-id orchestrator-pack
```

PowerShell consumers may use the compatibility `Get-AoReviewRuns` pack-store view. The
name is retained for compatibility; it must not fan out to AO review state or make daemon
review rows authoritative.

For a run, inspect:

- repository, PR number, target SHA, and linked session id;
- operational status and `failureReason`;
- `reviewVerdict`, `findingCount`, and complete `findings`;
- journal outcome;
- independent GitHub COMMENT, required-status, and worker-notification outcomes;
- stored reviewer stdout and stderr when the process or payload failed.

Do not infer merge readiness from the run status alone. Re-check the current GitHub head,
required repository CI, and the exact-head pack-review status.

## Merge authority

The GitHub COMMENT is presentation only. The pack review condition for merge is the exact
status context:

```text
orchestrator-pack/pack-review
```

A merge decision must bind all evidence to the same current head. Required repository CI
must also be green, the PR must remain open and mergeable, and no independent blocking
review may remain. Only the operator merges.

## Reviewer selection and adoption

Inspect the effective selector:

```powershell
pwsh -NoProfile -File scripts/show-pack-reviewer-status.ps1
```

Set the reviewer and restart the pack side-process supervisor so new children inherit it:

```powershell
pwsh -NoProfile -File scripts/set-pack-reviewer.ps1 \
  -Reviewer <codex|claude> \
  -RestartSupervisor
```

Reviewer invocation still enters `pack-review-runner.ts`, which calls
`invoke-pack-review.ps1`. Restarting AO is not reviewer adoption and does not make AO own
the review path. `-RestartAo` is a deprecated compatibility alias only; when accepted by
the helper it must target the pack supervisor lifecycle, not restart AO.

## Historical and deprecated pack documents

The AO Reviews Board and its producer-contract documents describe a historical
daemon-review prototype. They are not a source of truth for pack-owned review, and their
seven board statuses are not the current pack run model. Operators should use the pack
review-run store, GitHub COMMENT, and exact-head required status instead.

Historical documents may mention `ao review run`, `ao review list`, `ao review submit`,
`ao events`, `ao report`, `ao status --reports`, daemon review, the old reviewer harness,
or deleted pack children only when the text is explicitly labelled historical, upstream,
retired, or forbidden. Such references are not live procedures.

Physical deletion of the Reviews Board runtime, AO compatibility helpers, events/report
compatibility, and broader process consolidation are separate cleanup tasks and are not
performed by this documentation change.
