# Worker smoke testing

The PR owner executes the live Issue's required smoke scenarios after review has
converged and required CI is green, then publishes the report with
`worker-smoke-run publish`. A same-PR PASS remains sufficient across later PR
heads; required CI stays current-head bound.

## When smoke is required

Read the live Issue and resolve its existing `smoke-test-plan` requirement.

- `required` with one or more scenarios: execute every scenario in order and
  publish the result.
- `not-applicable`: no smoke checkout and no `publish`.
- supported `legacy-exempt`: preserve the existing no-smoke path.

An Issue limited to documentation, policy, prompt, or skill text declares
`smoke-test-plan` with `not-applicable: true` and a one-line reason. Smoke
scenarios describe executable behavior only. A stale-content search belongs in
an acceptance criterion with the exact task-specific `rg` command and expected
empty result. The PR owner runs it before review and quotes the command and result
in the PR body; it is never a smoke scenario. See the task-authoring skill for
the exact Issue-authoring requirements.

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

## Readiness semantics

The newest existing same-PR `pack-worker-smoke-report/v1` PASS at any report
head satisfies smoke readiness across later PR heads. Required CI remains bound
to the current PR head. A later head or later same-PR FAIL does not revoke an
already-published PASS.

## Verification

Focused tests cover terminal-free v1 formatting/legacy reading, exact
plan/report correspondence, untracked-only admission, dirty-tracked refusal,
target identity, moved-live-head/non-green-CI non-gating, single-POST behavior,
secret scrubbing, manager PASS/FAIL/BLOCKED classification, and the managed
temporary detached-worktree sequence.

Run the affected smoke/manager tests plus the repository verification commands
required by policy, including `npm run typecheck` and `npm run lint`.
