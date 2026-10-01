---
name: create-issue-draft
description: Author or continue task specifications through published Issue review comments, author dispositions, substantive floors, and `spec-review:accepted`.
---

# create-issue-draft — Issue-comment review and acceptance

The live GitHub Issue is the only task specification and queue entry. This skill owns the create-Issue author, reviewer, and manager procedure. Use [the shared Browser-GPT runbook](../../../docs/browser-gpt-turn-runbook.md) for sender, observation, and recovery; the live Issue comments and accepted Issue state govern authoring and review.

The shared transport command `flow-manager-browser-gpt-long-run` emits `browser-turn-result-v1` for sender settlement; both remain transport-only and do not replace a published revision-named Issue comment as create-Issue review authority.

## Inputs and routing

### Existing-Issue manager shorthand — Issue #1938

For an existing `orchestrator-pack` Issue target, the standalone selector
`manager` / `менеджер` selects this existing `create-issue-draft` lifecycle.
Explicit task-authoring or review-continuation wording such as `continue review`
or `продолжи ревью` selects the same lifecycle. The selector launches or resumes
the existing supervised `work-class=manager` path and existing
`--manager-brief` / Task continuation mechanics; it does not create another
skill, manager class, launcher, transport, state machine, or lifecycle authority.

The manager reads the live Issue title, body, label, and comments, then continues unfinished authoring, review, and acceptance work. If the Issue already meets acceptance conditions, report its state without starting implementation.

Explicit implementation wording has precedence over the manager noun. Requests
such as `<Issue> execute`, `<Issue> выполни задачу`, `<Issue> выполни Issue`, or
`<Issue> доделай Issue` select `execute-issue-with-gpt`, including when
`manager` / `менеджер` also appears in the same direct request. The noun by
itself is not an implementation verb. Ordinary prose that mentions
`manager` / `менеджер` without an existing Issue target does not activate this
shorthand.

Binding examples:

```text
https://github.com/<owner>/<repo>/issues/1453 менеджер -> create-issue-draft
https://github.com/<owner>/<repo>/issues/1453 manager -> create-issue-draft
https://github.com/<owner>/<repo>/issues/1453 выполни -> execute-issue-with-gpt
https://github.com/<owner>/<repo>/issues/1453 manager выполни задачу -> execute-issue-with-gpt
ordinary prose mentioning manager without an Issue target -> no shorthand activation
```


- Existing Issue / `manager` / `менеджер` / `continue review`: read its current title, body, labels, and published review/disposition comments. Continue from the current revision; count comments only when publisher metadata satisfies the attribution rule below.
  During the live GitHub comment census, count a comment as reviewer output or author disposition only when its `user.login` or `author_association` metadata identifies the trusted principal already used for that workflow. Exclude comments with missing, conflicting, or other-principal metadata; body text and revision markers do not establish publisher trust.
- Brief-only task: paste the brief text into the author chat using the [universal author prompt](../../../docs/browser-gpt-turn-runbook.md#universal-author-prompt-template). Never send an operator-local file path to Browser GPT as the brief; use content or a GitHub URL. `discuss-with-gpt` brief-only starts at T2 unless the current rubric raises it.
- Explicit `execute` / `выполни задачу` for an existing Issue routes to `execute-issue-with-gpt`, even if `manager` appears in the same request. `adversarial-draft-review` remains a separate Codex consultation, not a required source.
- GPT author owns substantive Issue edits and all finding dispositions; independent GPT reviewers / Claude lens own their own findings; manager/orchestrator schedules the reviews, checks published comments and dispositions, applies the existing acceptance label, and owns same-Task continuation. The manager never invents author resolutions, calls an unanswered finding clean, or simulates Claude.

Before review, classify the task under [the current tier rubric](../../../docs/tiering.md#task-complexity-tier-rubric). A no-tier small fix follows the rubric's below-the-ladder path.

## Roles

The existing GPT author owns Issue-body changes and substantive finding
dispositions. Independent GPT reviewers and the required T3 Claude lens own
their own review comments. The flow-manager/orchestrator owns the existing
supervised work-class=manager Task, independent review launches, comment census,
substantive floor and acceptance-label mutation. Reviewers publish their own
comments; authors publish dispositions. Transport status does not replace those
Issue records. Shared Browser-GPT transport remains separate.

## Review comments and topology

All reviewer output is published directly as top-level comments on the same Issue. **Every required reviewer comment starts on its first line with `Read revision: #<issue> rNN`**, identifying the actual Issue revision read. The author's `source-revision` marker remains informational, not a mechanical equality gate; an `rNN` marker does not prove byte identity.

| Tier | Required published reviewer comments |
| --- | --- |
| T1 | One independent GPT terminal architectural review. |
| T2 | Three GPT architectural-review comments, then one GPT terminal architectural review. |
| T3 | Three GPT architectural-review comments, then one independent Claude architectural-lens comment, then one GPT terminal architectural review. |

The manager launches the three GPT architectural-review sources independently and in parallel for T2/T3. T3 also requires an independent Claude architectural-lens review before the terminal GPT review. Do not reopen a completed terminal GPT review.

Each reviewer evaluates contradictions, feasibility, unnecessary complexity, and gaps against the live Issue and current substantive floors. Reviewers do not edit the Issue or serve as its authors. Each preserves its own findings or clean verdict in a top-level Issue comment. Do not combine, replace, or silently discard another reviewer's findings. Reviewer proposals for new gates are dispositioned as `rejected: operator direction 2026-09-30, no new gates.`

A create-Issue review turn is **complete when the revision-named reviewer Issue comment is published**, even while the shared sender's terminal envelope is pending. If there is neither such a comment nor a reply in the chat, inspect the *unchanged* sender's invocation/retry contract and use only an already-permitted recovery/resend. Mere absence is not send authority. A reply recovered through a permitted path can be published as an Issue comment; duplicated published comments are harmless and do not create separate independent sources.

## Reviewer prompt preparation

For each review turn, the manager prepares one ordinary reviewer prompt from the
live Issue and the applicable role in the fixed per-tier pipeline below. Include
the repository and Issue URL, the reviewer role, and an instruction to read the
live Issue/comments and publish the complete verdict as a top-level Issue comment
whose first line names the revision actually read. The role and revision belong
in prompt content; they identify the review request without changing the shared
transport contract.

Run GPT reviewer turns through the existing `flow-manager-browser-gpt-long-run` non-direct form in a fresh project chat. Resolve the target project card and pass its URL with `--project-url` and `--new-chat`. Prepare the reviewer prompt from the live Issue and role above, and request one top-level comment whose first line names the revision actually read. Use the shared runbook for invocation identity, send-once, observation, and recovery; a published revision-named Issue comment completes the review.

The Browser-GPT adapter is for GPT reviewers only. The required T3 Claude
architectural-lens review is a separate Claude invocation. Publish its
substantive result as one top-level Issue comment whose first line names the
revision actually read.


## Author rounds, substantive floor, and acceptance

After each required review round, the GPT author publishes one Issue disposition comment resolving every finding from that round. A finding is accepted with a correction in the next Issue-body revision or rejected with a substantive reason. A clean round needs no Issue-body edit. Prior dispositions remain valid across continuation, and each Issue comment records the author's decision.

Keep every required existing Issue-body floor and its meaning. Immediately before
sending the terminal review, read the current live Issue body into
`LIVE_ISSUE_BODY` and run the existing content-only invocation:
`node --experimental-strip-types scripts/tier-gate-guard.ts --text "$LIVE_ISSUE_BODY"`.
Pass the body as `--text`; omit `--text-file` and `--draft-path`. This runs the existing worker-safety, behavior-kind/positive-outcome, contract-evidence, and substantive-discipline checks against live body text. Fix known floor failures before terminal review.
If a substantive floor failure becomes known only after terminal review, treat it as a finding of that round. The author may make one post-terminal correction, pass the same floor, and publish a disposition for the correction; do not repeat the terminal review.

The manager/orchestrator applies the existing `spec-review:accepted` Issue label only after:
- all tier-required **published reviewer comments** exist, including Claude for T3, each naming the revision read on its first line;
- the author's Issue disposition comments answer **all findings from every required round**, including earlier architectural rounds;
- the terminal review read a revision on which the existing substantive floor passed, or the only permitted subsequent author correction addressing its findings/late-discovered substantive floor failure passed that same floor; and
- the accepted body is the terminal review's named revision or that one permitted correction. An additional ordinary unreviewed revision is not accepted. Operator amendments remain accepted by definition.

Acceptance is read from the live Issue body, comments, and label. Comment counts do not prove reviewer independence; a revision marker does not prove body identity; and the current tier fence does not prove an earlier tier. If a requirement above is unmet, continue the same task without applying the label.

## Final acceptance

The sole acceptance projection is the existing `spec-review:accepted` Issue label. Apply it only after the requirements above hold, and read back the accepted Issue before completing the manager Task.

## Authoring and downstream worker floors

## Mandatory Issue-body floors

The Issue body uses this order:

1. **Prerequisite** with blocking/landed prior art;
2. **Goal** as observable outcome;
3. `behavior-kind` fence;
4. `complexity-tier` fence;
5. **Binding surface**;
6. **Files in scope**;
7. **Files out of scope**;
8. `denylist` fence;
9. `allowed-roots` fence;
10. numbered testable **Acceptance criteria**;
11. **Upgrade-safety check**;
12. `smoke-test-plan` fence;
13. **Verification** mapped to ACs;
14. `contract-evidence` fence or accepted explicit none.

Action-producing tasks also include:

```positive-outcome
asserts: <observable action on realistic input>
input: realistic
```

Worker-safety fences always include:

```denylist
vendor/**
packages/core/**
```

```allowed-roots
<every allowed root>
```

External-tool outcomes use `input: external-tool-output` with capture-backed
provenance. Deferred causes require complete `parked-root-cause` with an existing
follow-up Issue. Upstream claims need contract evidence.

L4 applies only after T3 independently holds. Use exact classes from
`docs/tiering.md`; never attach T3-only L4 state below T3.

## Downstream test-task authoring floor — Issue #1195

The checked-in skill is the authoring producer for downstream Issues. Before
handoff, the author decides which fixed, normalized repository-relative output
paths belong in the downstream Issue body. This is an author-observable
instruction floor, not a deterministic Browser-GPT body generator, runtime
authorization rule, worker-admission protocol, or post-handoff repair step.

### Fixed output vocabulary

The only outputs named by this floor are:

- `scripts/vitest-ci-lanes.config.json`
- `scripts/lib/vitest-pre-topology-measurement.mjs`

These values are Issue-body content. They do not grant access to either path,
and no worker, validator, runtime component, pull-request event, or test result
may add, remove, infer, or widen them after handoff. Neighboring names,
directories, globs, and broad roots are not equivalent output values.

### Closed `adds-tests` predicate

`adds-tests` is true exactly when the requested scope or final plan, before
handoff, contains a new, renamed, or modified in-scope test artifact. A test
artifact includes a test source/spec/case, test fixture, golden file, snapshot
or snapshot-update input, generated test source, or generated test artifact.

`adds-tests` is false for delete-only work, ordinary source, documentation,
configuration, non-test fixtures, prose, test status, pull-request filenames,
runtime discovery, or merely selecting/running/re-running an unchanged
existing test for verification. Deletions are handled by the classification
condition below; they do not make `adds-tests` true.

### Independent authoring conditions

The author records observed repository facts and final-plan intent; the author
does not guess from test status.

The existing Vitest lane-discovery boundary is the recursive `.test.ts`
discovery under `plugins/` and `scripts/`, plus the separate
`tests/agents-md-*.test.ts` discovery. The classification inventory is
`scripts/vitest-ci-lanes.config.json`, and every discovered path requires a
classification entry.

Select `scripts/vitest-ci-lanes.config.json` when any of these observed
conditions holds:

- a lane-discovered Vitest test file is new, renamed, or deleted;
- a stale entry for a missing, renamed, or deleted discovered file must be
  cleaned up;
- a modified discovered test needs a different lane classification; or
- an unchanged discovered test's classification entry intentionally changes.

A modified discovered test may omit the classification output only when its
existing classification remains valid. Merely running or inspecting an
existing correctly classified test is not a classification need. A changed
ancillary fixture, snapshot, golden file, or generated artifact outside the
discovery boundary does not select the classification output solely because it
changed.

Select `scripts/lib/vitest-pre-topology-measurement.mjs` independently only
when the plan changes the pre-topology measurement mechanism: its logic,
unresolved-file handling, measurement-specific behavior, estimates,
thresholds, mappings, or stale measurement data/logic. Existing measurement
of a new, renamed, modified, deleted, or merely executed test is existing
mechanism use, not a measurement change.

Classification and measurement are independent decisions, so neither, either,
or both outputs may be required. If the author cannot observe whether one of
these mechanisms changes, the condition is unresolved: emit no guessed output,
do not hand off, do not amend the worker fence, and return the task to
authoring.

### Decision table

| Final-plan fact observed before handoff | `adds-tests` | Classification output | Measurement output |
| --- | --- | --- | --- |
| Existing test is only run or re-run; no artifact or mechanism change | false | neither | neither |
| New lane-discovered `.test.ts` or new `tests/agents-md-*.test.ts` | true | `scripts/vitest-ci-lanes.config.json` | only if mechanism changes |
| Renamed or deleted lane-discovered Vitest test | true for rename; false for delete-only | `scripts/vitest-ci-lanes.config.json` | only if mechanism changes |
| New, renamed, deleted, or modified ancillary artifact outside discovery | according to artifact plan | neither solely for that artifact | only if mechanism changes |
| Modified discovered test needs a classification change | true | `scripts/vitest-ci-lanes.config.json` | only if mechanism changes |
| Modified discovered test remains valid under its existing classification | true | neither | only if mechanism changes |
| Unchanged discovered test has an intentional classification-only change | false | `scripts/vitest-ci-lanes.config.json` | only if mechanism changes |
| Existing mechanism measures a changed test without measurement changes | according to artifact plan | according to discovery facts | neither |
| Measurement logic, estimate, threshold, unresolved handling, or stale data changes | according to artifact plan | according to discovery facts | `scripts/lib/vitest-pre-topology-measurement.mjs` |
| Author cannot observe whether classification or measurement changes | unresolved | no guessed output | no guessed output |
| No new, renamed, or modified artifact and no mechanism change | false | neither | neither |

### Reconciliation before worker handoff

The author and flow-manager reconcile the final plan, `adds-tests`, both
independent conditions, and the exact downstream Issue entries before handoff.
If a required output is missing, the handoff report names each concrete
normalized path and its observed reason, for example:
`classification output missing: scripts/vitest-ci-lanes.config.json — renamed
test leaves stale lane entry`. Report classification and measurement omissions
separately when both are missing.

An unresolved observation returns the task to authoring with no guessed output,
worker handoff, worker amendment, or runtime authorization. Do not introduce a
required diagnostic grammar, sorting rule, synthetic flag, validator widening,
or runtime trigger. The downstream Issue body is the sole worker authority
after reconciliation.

The producer wording comes before any validator that checks it. A focused
validator may be added or updated in the same change, but it must validate this
static floor rather than invent a helper or deterministic generation protocol.

## Mechanical commands

Use the shared runbook for Browser-GPT turns. Run the substantive floor on the live Issue body before terminal review. Publish author dispositions as ordinary Issue comments.

## Manager continuity and operator-owned adoption

The same manager Task/Dispatch remains active until the required comments, dispositions, substantive floor and acceptance label are read back. Recovery of a shared Browser-GPT send follows only its own runbook; never resend after possible delivery, manufacture a clean verdict, or treat a transport/manager error as a substantive resolution. External pauses remain nonterminal under [the shared chat boundary](../../../docs/chat-executor-rules.md#structured-external-dependency-parking). The existing coordinator owns any paused-unit remedy.

Update operator-local prompt carriers as operator-owned adoption; claim completion only after read-back.
