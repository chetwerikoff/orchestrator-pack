---
name: create-issue-draft
description: Author or continue GPT-authored orchestrator-pack Issue specifications using published Issue review comments, author disposition comments, the existing substantive floor, and spec-review:accepted; no stage receipts, competitive review, or separate acceptance artifact.
---

# create-issue-draft — Issue-comment review and acceptance

The live GitHub Issue is the only task specification and queue entry. This skill owns the create-Issue author, independent reviewer, and manager process. It does not own Browser-GPT transport. Use [the current shared turn runbook](../../../docs/browser-gpt-turn-runbook.md) for its existing sender, observation, and legal recovery contract. Do not alter that sender, add a new gate or receipt, or promote sender envelopes to task-review authority.

## Inputs, routing and roles

- Existing Issue / `manager` / `менеджер` / `continue review`: read its current title, body, labels and all published review/disposition comments. Continue from the current revision; already-published comments count. Do not restart stages, replay a competitive review, or grandfather the Issue onto the old receipt-based mechanism.
- Brief-only task: paste the brief text into the author chat using the [universal author prompt](../../../docs/browser-gpt-turn-runbook.md#universal-author-prompt-template). Never send an operator-local file path to Browser GPT as the brief; use content or a GitHub URL. `discuss-with-gpt` brief-only starts at T2 unless the current rubric raises it.
- Explicit `execute` / `выполни задачу` for an existing Issue routes to `execute-issue-with-gpt`, even if `manager` appears in the same request. `adversarial-draft-review` remains a separate Codex consultation, not a required source.
- GPT author owns substantive Issue edits and all finding dispositions; independent GPT reviewers / Claude lens own their own findings; manager/orchestrator schedules the reviews, checks published comments and dispositions, applies the existing acceptance label, and owns same-Task continuation. The manager never invents author resolutions, calls an unanswered finding clean, or simulates Claude.

Before initiating review, classify the task under [the current tier rubric](../../../docs/tiering.md#task-complexity-tier-rubric). A tier may not decrease after the first review starts unless the operator decides; this is author/operator procedure, not a new freeze record. The present tier fence does not prove a historical tier. A no-tier small fix follows the rubric's below-the-ladder path.

## Review comments and topology

All reviewer output is published directly as top-level comments on the same Issue. **Every required reviewer comment starts on its first line with `Read revision: #<issue> rNN`**, identifying the actual Issue revision read. The author's `source-revision` marker remains informational, not a mechanical equality gate; an `rNN` marker does not prove byte identity.

| Tier | Required published reviewer comments |
| --- | --- |
| T1 | One independent GPT terminal architectural review. |
| T2 | Three GPT architectural-review comments, then one GPT terminal architectural review. |
| T3 | Three GPT architectural-review comments, then one independent Claude architectural-lens comment, then one GPT terminal architectural review. |

The manager launches the three GPT architectural-review sources independently and in parallel for T2/T3, without interpreting their three Issue comments as proof of independent launches. Do not start a T3 competitive stage or substitute a waiver for the required Claude comment. Do not reopen a completed terminal GPT review.

Each reviewer evaluates contradictions, feasibility, overengineering / cheaper sufficient remedies, and missing gaps against the live Issue and current substantive floors. Reviewers do not edit the Issue or serve as its authors. Each review carries its findings or a clean verdict in its **own** Issue comment; preserve each source's findings instead of combining, replacing, or silently discarding any. Avoid mandated formatting tokens, occurrence maps, slot IDs, receipt paths, and synthetic `SIMPLIFICATION_CLEAN` artifacts. In particular, reviewer proposals for new gates are dispositioned exactly as `rejected: operator direction 2026-09-30, no new gates.`

A create-Issue review turn is **complete when the revision-named reviewer Issue comment is published**, even while the shared sender's terminal envelope is pending. If there is neither such a comment nor a reply in the chat, inspect the *unchanged* sender's invocation/retry contract and use only an already-permitted recovery/resend. Mere absence is not send authority. A reply recovered through a permitted path can be published as an Issue comment; duplicated published comments are harmless and do not create separate independent sources.

## Author rounds, substantive floor, and acceptance

After **each** required review round, the GPT author publishes **one Issue disposition comment** resolving every finding from that round. A finding is either **accepted**, with a correction in the next Issue-body revision, or **rejected**, with a substantive reason. A clean round needs no synthetic Issue-body edit. Reviewers' clean comments and prior-round disposition comments remain valid across continuation; do not demand a historical receipt or an author-body change for clean closure. The Issue comment is the finding disposition record.

Keep every required existing Issue-body floor and its meaning. Apply the **existing** `draft-discipline` / tier-gate substantive check on the Issue-body revision the terminal reviewer will read, **before** sending that terminal review. Fix known floor failures first. If a substantive floor failure is discovered only *after* the terminal review (even a clean one), treat it as a finding of that terminal round. The author may use the **single permitted post-terminal correction**, pass the same floor on the corrected revision, and publish the corresponding terminal-round disposition. Do not request a second terminal review, new check, or new acceptance artifact.

The manager/orchestrator applies the existing `spec-review:accepted` Issue label only after:
- all tier-required **published reviewer comments** exist, including Claude for T3, each naming the revision read on its first line;
- the author's Issue disposition comments answer **all findings from every required round**, including earlier architectural rounds;
- the terminal review read a revision on which the existing substantive floor passed, or the only permitted subsequent author correction addressing its findings/late-discovered substantive floor failure passed that same floor; and
- the accepted body is the terminal review's named revision or that one permitted correction. An additional ordinary unreviewed revision is not accepted. Operator amendments remain accepted by definition.

Use the Issue and its comments and label as the only acceptance record. No `stageAttemptId`, stage cycles/receipts, `attempt-*.json`, `reviewLane`, `finalRequiredSlots`, invocation envelope, terminal bundle, legacy `produce-artifacts`, finding-ledger format tokens, `tier-intake/v1`, `tier-gate-decision/v1`, `claude-producer-evidence/v1`, `claude-unavailable` waiver, `create-issue-final-acceptance/v1`, author-round lifecycle validation, or stage-record / nextAction reconciliation authorizes the **create-Issue review or acceptance decision**. The shared sender may retain its own independent transport/observation semantics; those are not substituted for Issue-comment acceptance authority.

Only three limits to inference apply: comment counts cannot prove independent reviewer launches, `rNN` is not a byte-identity guarantee, and the current tier fence does not prove historical tier. Do not compensate with new slot identities, snapshots, provenance gates or freeze records. If acceptance prerequisites do not hold, continue work within the existing Task and ownership rather than apply the label.

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

## Manager continuity and operator-owned adoption

The same manager Task/Dispatch remains active until the required comments, dispositions, substantive floor and acceptance label are read back. Recovery of a shared Browser-GPT send follows only its own runbook; never resend after possible delivery, manufacture a clean verdict, or treat a transport/manager error as a substantive resolution. External pauses remain nonterminal under [the shared chat boundary](../../../docs/chat-executor-rules.md#structured-external-dependency-parking). The existing coordinator owns any paused-unit remedy.

Update the existing operator-local flow-manager/orchestrator prompt carriers as operator-owned adoption, not as repository files in a PR. Do not claim adoption succeeded without a local read-back. This cutover deliberately leaves unrelated shared sender, PR-code review, and unreachable historical implementation/test cleanup to their own scope.
