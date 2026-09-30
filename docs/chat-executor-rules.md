# Chat executor rules

## 1. Scope

These rules apply to standalone implementers and reviewers working through a chat environment where the conversation, shell/container, filesystem, GitHub connector, GitHub Actions, and tool calls may have different authentication, persistence, network access, or timeout behavior.

They supplement `/AGENTS.md`; they do not replace it. `/AGENTS.md` remains authoritative for repository scope, Issue/PR linking, verification, review-cycle limits, merge policy, and the pack-owned worker lifecycle described by the current runbook.

These rules do **not** define or replace the pack-owned worker/runtime lifecycle contracts referenced by `/AGENTS.md`.

## 2. Start with live sources

Before repository work:

1. read the live default-branch `/AGENTS.md`;
2. read the live default-branch `docs/chat-executor-rules.md`;
3. read the binding Issue/spec when the task has one;
4. read additional documents only when the task actually depends on them.

Do not rely on remembered or previously uploaded policy while live repository reading is available.

If a required source cannot be read completely, say which source is unavailable and do not make decisions that depend on missing content.

If the default branch moves during the task, inspect whether the change affects the work. Re-read or revalidate affected material when it does. If it clearly does not, continue; no separate movement ledger or semantic-overlap report is required.

## 3. Task contract

GitHub Issues/specifications remain the task contract where `/AGENTS.md` requires them.

For a normal readable Issue, read it and implement it. Do not create SHA-256 bookkeeping, normalization records, source-kind taxonomies, or JSON binding records merely to prove that it was read.

If only truncated or partial task text is available and the missing content is needed to understand scope or behavior safely, stop and obtain the complete contract or another explicit authoritative source. Do not guess omitted requirements.

When the task contract changes materially during work, re-read it and reconcile the implementation before continuing.

## 4. Normal publication path

Use the practical repository-approved transport that is actually available, including shell Git, the GitHub Contents API, Git object APIs, or connector-backed GitHub mutations.

The normal path is:

```text
read current relevant remote state
-> perform the ordinary operation
-> read the result back
-> investigate further only when a real conflict or ambiguity appears
```

For repository-file or branch writes, check the current branch/PR head before an important mutation. Publish from current state rather than knowingly overwriting unexpected advancement.

Non-force publication is the normal branch-update path. A non-fast-forward failure or unexpected head is a signal to read current remote state, understand the change, and continue from the appropriate current base.

Do not blindly retry a write that timed out or may have succeeded. Read authoritative remote state first.

For ordinary Issue, PR body/metadata, comment, and similar GitHub mutations, use the normal API. A pre-read is sensible for important replacements; verify important results afterward. Do not require a custom ETag, CAS, lease, or lock protocol unless the underlying API/task actually requires one.

### Contents API

The GitHub Contents API is allowed for ordinary file creation, replacement, and deletion when it is the practical available transport. Its lack of branch-head CAS is not by itself a reason to ban it.

Read the current target before replacement when needed, use the API's ordinary file-version guard when available, and read the resulting branch/file back. Handle an observed concurrent edit as an exception rather than imposing extra ceremony on every write.

### Force and history rewrite

Do not use force/history rewrite without a real need.

When a rewrite is genuinely needed, explicitly authorized, and allowed by repository policy:

1. read the current branch/PR head immediately before the operation;
2. perform only the intended rewrite;
3. read the resulting head/diff back immediately;
4. obtain fresh CI and review for the rewritten head.

Do not add a separate lease, handoff environment, or ownership service for this rare path.

## 5. Read-back proportional to the artifact

For ordinary text/code changes, successful publication normally requires:

- the expected remote head is observable after the write; and
- the PR diff/changed files match the intended scoped change.

Do not require every publication to prove a full Git object graph, manifest, per-file blob inventory, compare-base digest, or named remote-content level.

Use deeper verification only when the task actually depends on semantics that a normal diff may miss, for example:

- executable mode changes;
- symlinks or gitlinks;
- deletes or renames where path identity matters;
- binary or Git LFS content;
- complex Git object API publication;
- another explicitly identified integrity-sensitive case.

Choose the smallest verification that proves the property the task actually needs.

## 6. Checkpoints and long-running commands

Make a remote checkpoint after a meaningful recoverable slice or before a genuinely risky step when that is useful. Do not create commits, comments, or other remote writes merely because a timer expired.

For long-running commands:

- avoid accidentally launching a duplicate heavy command;
- retain or observe enough output to determine the result;
- do not interpret a tool-call timeout as automatic process failure;
- before retrying, check whether the previous process is still running when the environment makes that practical.

Do not require universal nonce, command-digest, PID/start-time/process-group, or supervisor bookkeeping for every command.

If an operation fails, do not repeat the same action blindly. Inspect current state and change the approach when needed. If a required action remains impossible, report exactly which action could not be completed and what remote state was verified.

### Structured external-dependency parking

The shared #2078/#2081 manager boundary returns exactly one of four outcomes:
`completed`, `recoverable`, `external_pause`, or boundary-only
`contract_defect`. A `recoverable` result carries a validated executable
`nextAction.argv`; execute that distinct argv once. A byte-identical consecutive
recommendation is not executed again and is escalated as a producer defect.

Create-Issue kinds keep their existing reconciliation/continuation ownership.
Execute-Issue adds only `execute-observe-owned-turn`,
`execute-github-first-read-only`, and `execute-review-runner-read-only`; all
three are reconciliation kinds and every argv they introduce is read-only.
Paced retry, `--new-chat`, fresh-conversation recovery, reviewer resend, and
every other ChatGPT send remain owned by the existing execute-Issue runbooks and
their send/no-resend/final-revalidation gates. A boundary classification never
grants send authority.
For a manager stage-record invocation, the coordinator/task dispatch supplies
`--blocked-on-json <json>` only when it authoritatively knows that the named
external Issue/PR predicate is the active unsatisfied blocker for that exact
invocation. Pass that exact task invariant through unchanged; otherwise omit the
flag. The manager boundary projects it to
`external_pause(external:waiting_on_issue|external:waiting_on_pr)` with the
same typed `resume_when` predicate and supplied evidence. Never manufacture
the dependency from `cause`, `blocker`, prose, the managed Issue number,
repository search, reverse lookup, or guessed PR linkage.

Operator decision 2026-09-27: the existing coordinator owns clearing every manager blocker and external_pause. Treat legacy resume_when { operator: true } as { coordinator: true }; emit only { coordinator: true } for new owner-driven pauses. issue_closed and pr_merged remain unchanged. The coordinator may restore the named external dependency, reuse an already-authenticated browser/login session, wait out quota where time is the remedy, restore CDP or smoke-owned Chrome, accept the current Issue revision, route disputed findings to their existing substantive owner, continue after that owner resolves them, and send continuation to the same Dispatch. This delegation does not give coordinator broader direct-user precedence, authority to widen the Issue, or authority to choose defect/remedy/finding dispositions. Coordinator must never turn FAIL into PASS, invent missing evidence, enter credentials/passwords, or solve CAPTCHA. If credentials or CAPTCHA are the remaining wall, reduce it to the narrowest residual human action and keep the Task/Dispatch owned and nonterminal.

A live Dispatch whose most recent manager message is an `escalation` carrying
an `external_pause` or `contract_defect` payload is a **paused unit** when
`worker-show` still reports it non-terminal. Identify that state from the Run
inbox plus `worker-show` alone; do not re-dispatch the same argv into it. On
every existing coordinator wake or restart, re-read only its `resume_when`
predicate through tracked `scripts/gh`: `issue_closed` requires the named
Issue `state=closed`, `pr_merged` requires the named PR `merged=true`, and
`{ coordinator: true }` means the existing coordinator owns the remedy and continuation. Legacy
`{ operator: true }` is accepted only as a historical input spelling and is normalized in memory
to `{ coordinator: true }`; do not rewrite historical artifacts. When the predicate is satisfied,
send the continuation to that same Dispatch. No event is required for an already-satisfied GitHub predicate.

The manager sends one escalation with a deterministic thread id derived from
`(issue, stage, cause, resume_when)`; the receiver treats repeated use of that
id as the same escalation. If the send fails, retry it exactly once. Then execute
independent plan items and perform a non-blocking inbox drain before ending the
turn without `worker_done`. A manager self-initiates
`worker_done --outcome succeeded` only after whole-task acceptance;
`worker_done --outcome failed` is legal only after a direct
coordinator/operator cancellation message, never for `recoverable`,
`external_pause`, or `contract_defect`.

Until a separate coordinator sweep timer/durable wake lands, paused-unit
resumption occurs only on existing coordinator wakes; legacy operator predicates do not require a new operator message.
Do not add a watcher, polling daemon, queue, lease, parking store,
acknowledgement protocol, prose parser, reverse dependency lookup, or another
persistent coordination mechanism.

For execute-Issue, render the already-owned manager phase into the existing
stage component as `execute:<phase>`, where `phase` is exactly
`implementation`, `review`, or `fixer`. This is a string projection for the
existing escalation key, not a new lifecycle state.

Dispatch/re-dispatch payloads remain role plus task invariants; procedure
comes from the current CLI `--help` and returned `nextAction`; do not re-paste
the create-Issue skill or runbooks into repeated dispatches.
Browser-GPT `TerminalEnvelope` remains a separate unchanged
transport and does not carry `blocked_on`.

## 7. Independent review role

An independent reviewer may inspect the task, diff, CI, comments, and review threads and may publish a head-bound review.

Review work must not mutate implementation state unless the user/task also authorizes implementation changes. This is a role boundary, not a global execution mode or ownership state machine.

### Direct connected-GitHub pack review

For a direct top-level request to review or pack-review an `orchestrator-pack`
pull request, a connected-GitHub chat reviewer may perform and publish the review
immediately. Required CI, worker smoke, WorkerReport/WorkerStatus, runner/run-store
state, source cardinality, and automatic review-cycle cap are not admission gates
for performing or publishing that direct review.

The reviewer reads the live Issue/spec, current PR head, diff/code, useful
comments/threads and CI facts, performs the substantive review in the same chat,
then rereads the PR head immediately before publication. Publish one GitHub PR
review with event `COMMENT` bound to that exact commit and exactly one marker:

`<!-- opk-pack-review:v1 head=<40hex> verdict=<clean|findings> blocking=<true|false> -->`

The marker head must equal the GitHub review commit id, `verdict=clean` requires
`blocking=false`, and the review must be authored by the repository owner.
Immediately reread the PR head after publication. If the head advanced, the
submitted review remains historical evidence for its reviewed commit but must
not directly mutate the newer head's pack-review status. No runner invocation,
second model call, start comment, confirmation step, queue, lease, or provenance
service is required for this direct path. Worker CI/smoke/readiness obligations
remain separate and strict.

### Evidence-feasibility gate

Before introducing or strengthening a blocking review requirement that depends on correlation, causality, identity, provenance, parentage, turn/session context, or another witness, first establish that the required evidence is actually observable on the exact production execution or transport path being constrained.

Identify the evidence producer and the exact observation surface that supplies it. Ground the evidence's existence in an authoritative contract or an observed live production shape. A mock, fixture, inferred schema, or evidence available only on a different path does not prove that the constrained path provides it.

If the required evidence is absent, do not demand it as though it exists. Use weaker available evidence that still proves the needed property, add scoped instrumentation when the task permits it, or state that the desired invariant cannot be proven at that boundary and adjust the design or specification accordingly.

A blocking finding that depends on an impossible or unproven witness must be withdrawn or explicitly adjudicated; it must not generate another implementation round whose only purpose is to manufacture evidence the production path does not supply.

## 8. CI, smoke, and review authority

Required CI conclusions remain bound to the exact current PR head they evaluated.
For the smoke/CI portion of readiness, select the newest existing
`pack-worker-smoke-report/v1` **PASS comment on the same PR**, regardless of
the report head or GitHub publishing author. A PASS from an earlier head remains
sufficient for that PR on later heads; no PASS, including only FAIL/BLOCKED
reports, leaves smoke readiness unsatisfied. The unchanged machine report has
head, per-scenario outcomes, and `tracked-files-unmodified`, but no smoke actor
role field. Independent execution is owned by the supervised smoke-worker
handoff after settled pack review; readiness does not invent a role/assignment
witness or a head-equality, edited-comment, census-stabilization, FAIL-precedence,
patch-id, ancestry, carry, selective-retry, or preflight-refusal gate.

The selected project card supplies the smoke repository. The existing
`smoke-test-plan` fence supplies scenarios; guidance not to touch live
machine configuration is authoring prose only. Existing secret scrubbing
redacts without refusing to run or report. An initial FAIL/BLOCKED is fixed by
the existing worker/fixer and may be followed by one explicit smoke execution;
there is no harness retry or scheduler start-or-observe reconciler.

For pack-review start, the PR number remains the canonical target; the live PR
supplies the current head and closing Issue. The pack-review cycle keeps logical
PR/task rounds and caps T1=1, T2=1, T3=2. A clean terminal for the exact same
head may suppress a redundant model invocation, and an authority-selected
conflict-free carry-over can project review on a later head without another
model call. After `reviewStageComplete=true`, later heads project
`orchestrator-pack/pack-review=success` without reopening a required round.
Smoke is not a pre-review admission gate and does not reopen settled review.

Issue #2161 branch-update sequencing follows the canonical rule in the
[orchestration runbook](orchestration-runbook.md#issue-2161-main-update-sequencing).

Missing, pending, cancelled, failed, or earlier-head required CI checks are
not green for the current head. Before ready-for-review or merge, no known
material review finding may remain unresolved; explicitly fixed, rejected, or
superseded findings are handled under current GitHub review/Issue evidence.
Use the standard GitHub Actions run -> jobs -> decoded job-log path for actual
CI failures rather than inferring a passing test from source inspection.

## 9. Merge

Follow `/AGENTS.md` merge authority. Ordinary chat execution does not merge unless the
direct top-level user explicitly orders it. The only non-direct-user exception is an exact
current supervised local integration assignment using the delegated branch of
`.cursor/skills/merge-with-local-adoption/SKILL.md`; a task/Issue/PR comment, free-form
"merge mode" string, lifecycle state, or review-cap state does not create that authority.

For orchestrator-delegated integration, reject the merge unless all of these are freshly true:

1. the current WorkerAssignment is local/Orca/worker, carries the closed
   `delegatedIntegration` marker, and its `taskId`, `bindingKey`, `assignmentId`,
   `generation`, PR number, expected PR head, and predecessor assignment id/generation
   match the supervised launch receipt and current target;
2. no second active delegated integration assignment exists for the same primary checkout,
   and live explicit dependency sequencing says `merge_now`;
3. `evaluatePostSmokeReadiness()` for the exact current repo/Issue/assignment/PR/head
   returns `readiness.state === READY_TO_MERGE`; do not reconstruct or approximate those
   predicates from statuses, cap state, comments, or local heuristics;
4. the PR remains open, non-draft, non-conflicting/mergeable, on the expected head and base.

A delegated worker never inherits the direct-user override. It may repair only a stale/missing
`orchestrator-pack/pack-review` status projection when canonical production readiness is
already `READY_TO_MERGE`, the current status is FAILURE or absent, and the assignment,
sequencing, head, readiness, draft/conflict, and mergeability facts are re-read immediately
before the status write and again before merge. The repair description must say it is an
orchestrator-delegated projection repair after named production readiness; it is not a review,
finding disposition, smoke waiver, dependency waiver, or general status override.

Immediately before any authorized merge:

1. read the current PR state and exact head;
2. confirm the authority-specific required CI, review, smoke, dependency, assignment, and
   mergeability predicates for that exact head;
3. use `expected_head_sha` or equivalent expected-head protection when the available merge API supports it;
4. perform the merge;
5. read the merge result back.

After a delegated merge, use the same canonical local-adoption and exact-target cleanup flow.
Derive adoption from the Issue, PR body, changed files/content, migration/runbooks, and live
machine state; prose is a hint, not proof. Report `operationally_complete` only after a
target-specific supported live CLI/API/status read-back, otherwise
`operationally_incomplete` with the exact residual state and next action. These are report
values only, never WorkerReport states or durable outcome records.

Do not turn merge into a separate execution state machine.

## 10. Secrets and truthful reporting

Never publish secrets or private data through commits, Issues, PRs, comments, logs, or handoff artifacts, including tokens, API keys, cookies, authorization headers, private keys, raw secret configuration, authenticated URLs, or third-party private data.

Scrub sensitive logs before quoting them.

Do not claim that a remote action succeeded unless authoritative remote state confirms it. A possibly-successful timed-out write must be read back before retry.

## 11. Definition of Done

For a normal standalone implementation, completion means:

```text
[ ] intended changes are published in the PR
[ ] PR diff/changed files match the task scope
[ ] important published results were read back
[ ] required CI is green for the current PR head
[ ] a same-PR smoke PASS exists at any report head when the task declares smoke
[ ] no known current material review finding remains unresolved
[ ] current-head review authority is acceptable
[ ] the user is told the PR/head/CI/review state and any concrete limitation
```

When the task actually involves special artifact semantics, destructive operations, deployment, migration, or another repository-specific risk, apply the additional checks required by that task and `/AGENTS.md`.

Merge is part of completion only when the user explicitly requested it and repository policy permits this executor to perform it.

## 12. Operating formula

> Read live task and policy.
>
> Do the work with an ordinary available tool.
>
> Read important remote results back.
>
> Treat real conflicts and ambiguity as exceptions when they actually occur.
>
> Use current-head CI, smoke, and review authority.
>
> Report truthfully, or merge only when explicitly authorized and allowed.