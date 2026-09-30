# Worker smoke testing (Issues #1061, #1138, and #1343)

Issue #2250 uses the existing supervised **independent** smoke worker after
pack-review settlement for both ordinary coding-worker PRs and the separate
manager-controlled Browser-GPT handoff. One successful independent PASS is
sufficient for that PR even after later commits; required CI stays green on
the current PR head. Initial FAIL/BLOCKED calls for a substantive worker fix
and an explicit subsequent smoke execution, never a harness automatic retry.

## When smoke is required

| Issue body signal | Worker gate |
|---|---|
| No `smoke-test-plan` fence + `smoke-plan-floor` grandfather marker | Smoke not required (legacy queue only) |
| No `smoke-test-plan` fence on an action-producing Issue without grandfather marker | Smoke required; missing plan blocks handoff |
| `smoke-test-plan` with `not-applicable: true` + reason | Smoke skipped |
| `smoke-test-plan` with scenarios | One successful independent smoke PASS per PR, reusable on later heads |

New action-producing tasks must declare a plan during authoring:

```bash
node scripts/draft-discipline.mjs smoke-test-plan --draft path/to/issue-body.md
```

Routine and complex smoke profiles come from the machine-local executor profile store for the existing `PACK_EXECUTOR_SMOKE_*` names; stored fenced keys override live environment values, and absent keys retain live environment defaults. `worker-smoke-run` does not load `.env` from a worktree or repository root.

## Multi-agent smoke executor policy

`scripts/executor-profile-policy.ts` is the single tracked semantic owner for both
routine and complex smoke profiles. The smoke launcher consumes its descriptor,
validation, translation, catalog, and refusal semantics; this runbook does not
reimplement them.

The existing smoke profile triples stay unchanged. On the smoke surface the closed
agent-token set is `cursor` and `opencode`. Cursor continues through the existing
`agent` executable surface and keeps its historical opaque model/effort translation
inside the shared Cursor translator. OpenCode carries model and effort together through a pack-composed inline agent definition supplied via `OPENCODE_CONFIG_CONTENT` as `{"agent":{"<pack-agent-name>":{"model":"<model>","variant":"<effort>"}}}` and spawned as `opencode --agent <pack-agent-name>` on the top-level surface, with no `--model` or `--variant` flag. Model catalog checks are executor-specific: Cursor uses the Cursor model catalog; OpenCode uses `opencode models`.

A semantically valid OpenCode profile is not automatically spawnable. Before child
creation, `worker-smoke-run` obtains top-level syntax evidence from `opencode --help`
(stdout+stderr, proving `--agent`) and catalog evidence from `opencode models --verbose`.
In the exact smoke cwd it then requires no-write-qualified `debug config` and named
`debug agent` observations, an explicit `default_agent`, preserved baseline semantics,
and isolated child-local state-path evidence before applying the invocation-local
model/effort overlay. Missing route support fails with `executor_route_unavailable`;
missing exact-context effort proof fails with `executor_effort_channel_unavailable`.
The launcher never infers an implicit default, falls back to Cursor, or drops effort.

Cursor smoke route compatibility remains code-owned and does not gain a fresh route
probe. Both executor families still require the selected profile to be inherited by
a child before spawn. The inline definition is carried as an `OPENCODE_CONFIG_CONTENT` prefix in the composed command string, so the conditional RuntimeAdapter env seam remains unchanged.

Firefighter execution still chooses the existing routine or complex smoke profile.
There is no separate `PACK_EXECUTOR_FIREFIGHTER_*` profile or bypass around this
policy.

## Actor ordering

### Ordinary local coding-worker path

The ordinary worker/orchestrator review-settled handoff, not the scheduler,
launches the existing supervised local independent smoke worker. Worker-owned
pre-review smoke is removed; pack-review admission does not depend on smoke.

```text
implementation
  -> PR created with current-head CI green
  -> pack-review cycle
  -> review finding: existing worker fixes; complete remaining review rounds
  -> review obligations settled
  -> existing supervised local independent-smoke worker
  -> smoke worker checks out PR head and runs Issue-declared scenarios
  -> PASS comment on PR -> readiness with current-head CI
  -> first FAIL/BLOCKED -> existing worker/fixer corrects -> explicit smoke execution
  -> completion
```

A new head after PASS does not require another smoke run; the PASS comment
remains on that PR. No scheduler start-or-observe reconciler or replacement
queue, registry, lease, watcher, retry engine, or new worker category is added.

### Manager-controlled Browser-GPT path

A Browser-GPT implementation owned by an `execute-issue-with-gpt` manager does
not fabricate a local coding worker, `ready_for_review`, or worker-owned
pre-review smoke. The manager runs canonical pack review after current-head
CI is green. After review settles, its existing separate manager-to-supervisor
handoff launches the same supervised independent smoke worker.

```text
manager-controlled Browser-GPT implementation
  -> current PR/head + required CI green
  -> manager-owned canonical pack-review cycle
  -> review obligations settled
  -> manager whole-role handoff: next action = independent smoke
  -> supervisor launches local independent-smoke parent
  -> independent smoke on the checked-out PR head
  -> PASS comment on PR
  -> first FAIL/BLOCKED: local worker fix + explicit independent smoke
  -> completion
```

There is no synthetic pre-review worker-owned smoke on this path. The
post-manager local worker is the **independent-smoke parent**, not a retroactive
coding-worker admission shim; it prepares the current worktree and prerequisites,
then invokes `worker-smoke-run ... --smoke-actor independent`.
The manager does not run independent smoke itself and the settled review stage
is not reopened after a worker fix.

## Manager projection of durable worker-smoke evidence

For manager-controlled Browser-GPT work, the existing
`pack-worker-smoke-report/v1` returns through continuation to the same
manager Dispatch. The supervisor uses the existing local worker as independent
smoke parent. The manager re-reads the Issue/PR/head binding and projects
the result through the single #2078 four-outcome boundary; it does not send
`worker_done --outcome failed` or reopen settled review.

- A same-PR PASS projects `completed` with verdict `PASS`; it remains
  sufficient on later heads while current-head CI is green.
- A proven `scenario_assertion_failed` projects `completed` with verdict
  `FAIL`; the existing local worker fixes and explicitly executes smoke on
  the corrected PR. It is not sent to a fresh GPT fixer conversation.
- External credential/product pauses and malformed structured results keep
  the existing `external_pause`/`contract_defect` boundary semantics.
- No retry fence, override receipt, smoke-ordering admission rule, or
  smoke-role/assignment witness is added.

## Pre-smoke prerequisite preparation (parent worker)

Before invoking `worker-smoke-run run`, the parent worker MUST make the environment capable of
executing the real Issue-declared scenarios. The smoke child is not responsible for discovering or
creating missing external prerequisites after launch.

### Smoke-parent first-attempt bootstrap

The parent must pass two independent gates before the first smoke child is
created: dependency/setup readiness and executor-profile readiness. A passing
worker-profile proof does not prove the smoke profile, and a ready worktree
does not prove that a child inherits the profile.

For a fresh smoke worktree, use the existing Orca setup path and continue only
after its successful setup/ready receipt:

```bash
orca worktree create \
  --name <worktree-name> \
  --repo <repo-selector> \
  --base-branch <base-ref> \
  --issue <N> \
  --setup run \
  --json
```

When the smoke parent is using an existing delivery worktree, positively bind it
with `orca worktree current --json` and re-read the already-recorded setup-ready
result; current-worktree binding alone is not setup readiness. A failed,
incomplete, or unknown setup result blocks smoke before child creation.

After setup and all Issue-declared external prerequisites are ready, ensure the
machine-local store contains the selected routine or complex triple. The launcher
loads that store once, overlays only fenced profile keys over live defaults, and
validates the selected triple, executor-specific model catalog, fresh route
capability where required, and child inheritance before any smoke spawn. A failure
reports the first profile/capability blocker and creates no smoke child.

Only after setup readiness and external-prerequisite readiness, invoke the existing
smoke command; the launcher reads the store in that invocation:

```bash
export PATH="$PWD/scripts:$PATH"
worker-smoke-run run \
  --issue <N> \
  --pr <PR> \
  --head-sha <40-hex> \
  --smoke-complexity <routine-or-complex> \
  --smoke-actor independent \
  --issue-body-file <issue-body-file> \
  --repo-root "$PWD" \
  --cwd "$PWD"
```

Do not add a fallback, retry, second selector, or alternate executor when pre-launch
admission fails. Fix the selected operator-local profile or the external installed
capability and make a fresh attempt.

The parent worker must:

1. inspect the current Issue `smoke-test-plan`, every declared scenario, and any named
   skill/runbook/tool contract;
2. derive a concrete prerequisite inventory, including external services, fixtures, credentials or
   account state, listeners, browser conversations, and other long-lived resources required by the
   scenarios;
3. provision each required prerequisite through the repository-approved skill or tool and retain
   its ownership identity or handle so only that resource can be maintained and later cleaned;
4. verify an observable readiness condition for every prerequisite before smoke admission;
5. keep every prerequisite available from before the smoke command is invoked until that command
   terminalizes and ownership-scoped smoke cleanup completes; and
6. refuse to launch smoke and report the concrete blocker when any prerequisite is absent,
   ambiguous, unhealthy, or expected to expire before the lifecycle can finish.

For resources with a TTL, select a lifetime that covers at least the runtime work and its normal cleanup plus a practical setup/teardown margin. An
approved non-disruptive retention mechanism may be used instead, but it must not execute a smoke
scenario, change the behavior under test, or write child-owned progress/completion evidence.

Example: when a scenario requires a separate active browser conversation, use the approved browser
skill or tool before smoke launch, create or select a dedicated owned chat, verify that it is usable,
and keep that chat active for the full prerequisite lifetime. Do not reuse the smoke child’s owned
tab or an unrelated user chat. Clean only the dedicated prerequisite resource after the smoke
command and owned lifecycle cleanup have finished.

Preparation supplies capability, not the expected result: it must not perform the declared scenario,
pre-satisfy the assertion being tested, fabricate smoke evidence, or mutate child-owned
the eventual GitHub smoke report.

Responsibility remains split as follows:

- the parent worker provisions, verifies, retains, and later releases external prerequisites;
- `worker-smoke-run` invokes the selected existing worker and publishes the existing report; and
- the smoke child runs the declared scenarios and supplies actual result observations.

## Supported worker path

The selected project card is the repository authority. The existing worker
checks out the live PR head and executes all `smoke-test-plan` scenarios.
The publishing GitHub comment contains the unchanged
`pack-worker-smoke-report/v1` marker, head, per-scenario outcomes,
`tracked-files-unmodified`, and unchanged machine block with **no actor field**.
The GitHub comment author is publisher metadata, not a smoke worker-role
attestation. Existing secret scrubbing redacts secrets in output and continues;
redaction itself never refuses smoke.

```bash
export PATH="$PWD/scripts:$PATH"
worker-smoke-run run \
  --issue <N> \
  --pr <PR> \
  --head-sha <40-hex> \
  --smoke-complexity <routine-or-complex> \
  --smoke-actor independent \
  --issue-body-file /tmp/issue-body.md \
  --repo-root "$PWD" \
  --cwd "$PWD"
```

## Report admission and trust boundary

For Issue #2250 the accepted smoke evidence is the newest existing
`pack-worker-smoke-report/v1` PASS **comment on the same PR** at any head.
The report's head, per-scenario outcome and tracked-files-unmodified facts are
retained unchanged. The GitHub author is publishing metadata only; no
publisher/producer identity filter, worker-role attestation, edited-comment
rejection, or new provenance admission is performed by readiness. The
supervised independent smoke-worker handoff establishes operational
independence. The PR and required CI must still match the current PR head
for their own separate readiness predicates.

## Exact-head point-in-time coverage

*Retired by Issue #2250.* Earlier-head reports do not require a fresh
current-head coverage fold, ancestor/patch equivalence proof or selective
retry. Historical per-tuple FAIL/BLOCKED precedence, receipt binding,
stable-census and head-equality reconstruction are no longer active smoke
readiness authority. A first non-PASS alone does not satisfy readiness;
an existing worker/fixer correction may be followed by an explicit smoke run.
Once a PASS is on the PR, it remains sufficient on later heads subject to
current-head CI.

## Report and readiness semantics

Readiness selects the newest existing `pack-worker-smoke-report/v1`
**PASS** comment on the same PR at **any report head**, regardless of
publishing author. A first FAIL/BLOCKED cannot satisfy readiness; an
explicit smoke execution after a fix may later produce PASS. A later FAIL
or a later head does not revoke an already-published PASS. Required CI must
still be green on the **current** PR head, and existing review, assignment,
and merge conditions remain separate.

No smoke-head equality, role/assignment check, publisher filter, edited-comment
rejection, census stabilization, FAIL precedence, ancestry/patch equivalence,
carry-only, selective retry, repeated-head admission check, lifecycle receipt,
cleanup-settlement, scheduler starter, or smoke-plan preflight refusal is
a readiness requirement. The `smoke-test-plan` fence remains an authoring
source; guidance not to touch live machine configuration is prose only.

The ordinary worker/orchestrator handoff and manager-controlled supervised
handoff retain their distinct existing owners. The production scheduler no
longer starts or observes smoke. After a fix, the existing worker/fixer
explicitly invokes the smoke worker; no automatic retry machinery is added.

## Runtime verification and rollback

Run the focused current-head suite before marking the PR ready:

```bash
node scripts/run-vitest-with-harness.mjs run --maxWorkers=1 scripts/worker-smoke.test.ts
node scripts/run-vitest-with-harness.mjs run --maxWorkers=1 scripts/worker-smoke-entrypoint-1359.test.ts
```

The suite covers the existing send-once and lifecycle boundaries plus shared
routine/complex executor-policy admission, the OpenCode pre-spawn external effort
gate, exact-target admission, canonical actor/envelope validation, edited and
malformed evidence, cross-run accumulation, quarantine clearing, row
revocation/restoration, page crossing, high-water stabilization, head reset,
same-head Issue edits, publication-order ties, bounded diagnostics, and one-run
compatibility. A real Orca smoke run remains required when the binding Issue's smoke
plan requires it.

Rollback is allowed only after current lifecycle state is clean. No aggregate state cleanup is
needed because the fold creates no cache, ledger, service, watcher, or second durable store.

## Orca executable selection

Use `OPK_RUNTIME_CLI_COMMAND` when exported. Otherwise prefer `orca-dev`, then `orca-ide`, then `orca`.
Do not assume `/usr/bin/orca` is the CLI on Linux.