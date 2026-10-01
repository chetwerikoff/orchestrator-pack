# Worker smoke testing

The active smoke path is deliberately thin. The PR owner executes the live
Issue's declared `smoke-test-plan` after review has converged and required CI
is green, writes a report file, and publishes that report with
`worker-smoke-run publish`. There is no nested smoke agent, smoke terminal,
independent-smoke actor, scheduler starter, receipt, watcher, retry engine, lock,
or persisted smoke lifecycle.

## When smoke is required

Read the live Issue and resolve its existing `smoke-test-plan` requirement.

- `required` with one or more scenarios: execute every scenario in order and
  publish the result.
- `not-applicable`: no smoke checkout and no `publish`.
- supported `legacy-exempt`: preserve the existing no-smoke path.

Documentation-, policy-, or prompt-only Issues should declare
`not-applicable: true` with a reason when runtime smoke cannot provide
meaningful evidence.

## Multi-agent smoke executor policy

There is no multi-agent smoke executor on the active path. This heading remains
as the stable operational-wiki selector for the former policy surface: required
smoke is now executed directly by the PR owner, and `worker-smoke-run publish`
does not select or launch an executor profile.

## Actor ordering

Smoke starts only after review convergence (when review applies) and green
required CI. The PR owner stays the smoke owner; there is no independent smoke
actor.

## PR-owner execution

### Ordinary worker or firefighter

Use the already-owned PR checkout after review (when applicable) and required
CI are green. Run the Issue scenarios directly in that checkout. Do not launch
another worker or agent merely to repeat them.

### Managed execute-Issue manager

The same manager remains the smoke owner. Its canonical manager worktree stays
on the existing `origin/main`-derived manager branch.

1. Re-read the exact Issue-bound PR and current head H with tracked
   `scripts/gh`.
2. Record the canonical manager worktree HEAD, branch, and status.
3. Fetch H with ordinary Git.
4. Create one unique temporary detached worktree T at H:
   `git worktree add --detach <T> <H>`.
5. Verify `git -C <T> rev-parse HEAD` is H.
6. Run the declared smoke scenarios in T and write the report file there.
7. Run `worker-smoke-run publish ... --repo-root <T>`.
8. Remove only T with `git worktree remove --force <T>`.
9. Verify the canonical manager worktree HEAD, branch, and status are unchanged.
10. Only after successful cleanup feed the already-emitted publish JSON record
    directly to the execute-Issue manager boundary under phase `smoke`.

Do not switch, reset, rebase, merge, or check out another commit in the
canonical manager worktree. Do not use global `git worktree prune`. This
temporary checkout is ordinary local Git state, not a new PACK-managed
worktree lifecycle or persistent record.

A fetch/add/HEAD-identity failure occurs before publication and claims no PASS.
If cleanup or the canonical-worktree unchanged check fails after a successful
comment POST, do not republish and do not consume that record as manager
smoke-phase PASS completion. Surface the exact local cleanup defect through the
existing parent/supervisor path. The already-posted v1 comment remains ordinary
same-PR smoke evidence; cleanup is not a readiness predicate.

## Report file

The report file uses the surviving `worker-smoke-report` grammar:

```text
result: PASS
scenarios:
  - action: <exact Issue action> | expected: <exact Issue expected> | observed: <what happened> | outcome: pass
```

For PASS, the report must contain every declared scenario in exact plan order,
with identical `action | expected` tuples and no duplicate, added, omitted,
wrong, or reordered row. For an early FAIL/BLOCKED, include only the executed
ordered prefix and end on the terminal non-PASS row. That terminal row carries
the existing closed `cause-family`; the report also carries the existing
closed top-level `non-pass-cause`.

Report authors must not place secrets or third-party private data in scenario
text, environment notes, or limitations.

## Publish

From the checkout that was actually exercised:

```bash
worker-smoke-run publish \
  --issue <N> \
  --pr <PR> \
  --report-file <report-file> \
  --repo-root "$PWD"
```

`publish` refuses modified tracked files but ignores untracked files,
including an untracked report file. Before its single comment POST it preserves
only the existing target-identity checks: the checkout origin must resolve to
the selected canonical repository and PR P must exactly close Issue N.

The publisher has no `--head-sha` input. It stamps `head-sha` from local
`git rev-parse HEAD`; it does not compare that value with the live PR head and
does not inspect CI. Each invocation makes zero write attempts until all
pre-publication checks pass, then at most one comment POST. A confirmed response
URL becomes `commentUrl` in the one canonical stdout JSON record. A transport
failure after that one POST attempt exits non-zero; a later whole-command
invocation is the only retry boundary.

New v1 comments contain no terminal handle, Orca executable, terminal-cleanup
field, or `orca-terminal-cleanup` line. Existing legacy v1 comments carrying
those fields remain readable. Both the comment and canonical stdout derive from
the same normalized scrubbed report content.

A successfully published PASS, FAIL, or BLOCKED exits zero and carries the
domain verdict in the comment and stdout record.

## Manager classification

Feed the actual JSON record emitted by `publish` directly to
`classifyExecuteIssueManagerRecord` under phase `smoke`; do not reread the
GitHub comment to construct another record.

- PASS completes smoke after managed temporary-worktree cleanup succeeds.
- A proved `scenario_assertion_failed` /
  `executed_scenario_failure` result enters the existing fixer continuation.
- Supported structured external BLOCKED results retain the existing external
  pause behavior.
- Malformed or unsupported structured causes are contract defects.

There is no `trusted_target_stale` smoke recovery observer, expected-head
witness, or replacement classifier.

## Readiness semantics

Readiness is unchanged by this producer simplification. The newest existing
same-PR `pack-worker-smoke-report/v1` PASS at any report head satisfies the
smoke predicate. Required CI remains bound to the current PR head. A later head
or later FAIL does not revoke an already-published same-PR PASS.

No smoke-head equality, actor/publisher filter, ancestry reconstruction,
receipt, cleanup proof, historical-state gate, or scheduler-owned smoke state is
added to readiness.

## Verification

Focused tests cover terminal-free v1 formatting/legacy reading, exact
plan/report correspondence, untracked-only admission, dirty-tracked refusal,
target identity, moved-live-head/non-green-CI non-gating, single-POST behavior,
secret scrubbing, manager PASS/FAIL/BLOCKED classification, and the managed
temporary detached-worktree sequence.

Run the affected smoke/manager tests plus the repository verification commands
required by policy, including `npm run typecheck` and `npm run lint`.
