---
name: create-issue-draft
description: Author or continue orchestrator-pack Issue specifications using the live Issue, published reviewer comments, author dispositions, the substantive floor, and spec-review:accepted.
---

# create-issue-draft

The live GitHub Issue is the sole task specification and queue entry. This skill
owns create-Issue routing, authoring, review, disposition, and acceptance.
Browser-GPT transport is separate and is owned by
[`docs/browser-gpt-turn-runbook.md`](../../../docs/browser-gpt-turn-runbook.md).
Universal complexity classification is owned only by
[`docs/tiering.md`](../../../docs/tiering.md); use that rubric rather than
copying it here.

## Routing

- A new Issue authoring request uses this skill.
- For an existing `orchestrator-pack` Issue, standalone `manager` /
  `менеджер`, `continue review`, or `продолжи ревью` continues this same
  lifecycle from the live Issue/comments/label.
- Explicit implementation wording such as `execute`, `выполни задачу`,
  `выполни Issue`, or `доделай Issue` routes to
  `execute-issue-with-gpt`, even when `manager` / `менеджер` also appears.
- Ordinary prose that merely mentions manager without an existing Issue target
  does not activate the shorthand.
- `adversarial-draft-review` is optional consultation, not a required review source.

For a resumed Issue, first read the live title, body, labels, and all published
review/disposition comments. Continue only unfinished authoring, review,
disposition, and acceptance work. If the Issue is already accepted, report that
state and do not fall through to implementation.

## Roles

- **Author:** owns Issue title/body mutations and substantive dispositions.
- **Independent GPT reviewer:** publishes its own review comment and never edits
  the Issue.
- **Claude lens:** required only by T3 and publishes its own review comment.
- **Manager/orchestrator:** schedules required reviews, reads GitHub comments,
  checks the substantive floor, applies the acceptance label, and keeps the
  parent Task alive until the accepted Issue state is read back.

A child author/reviewer/lens turn never completes the parent manager Task.

## Authoring contract

A substantive body edit increments the `<!-- source-revision: rNN -->` marker.
The author mutates only the target Issue title/body for specification changes and
re-reads the result after every mutation. A clean review does not require a
synthetic body edit.

The Issue body contains, in this order:

1. **Prerequisite**;
2. **Goal**;
3. a `behavior-kind` fence;
4. a `complexity-tier` fence;
5. **Binding surface**;
6. **Files in scope**;
7. **Files out of scope**;
8. a `denylist` fence;
9. an `allowed-roots` fence;
10. numbered, testable **Acceptance criteria**;
11. **Upgrade-safety check**;
12. a `smoke-test-plan` fence;
13. **Verification** mapped to the acceptance criteria;
14. a `contract-evidence` fence, or explicit accepted `none`.

Action-producing tasks also contain:

```positive-outcome
asserts: <observable action on realistic input>
input: realistic
```

Worker-safety denylist always includes both `packages/core/**` and
`vendor/**`. Allowed roots enumerate every root the worker may edit.

### Compact test-task scope rule

Before handoff, decide from the requested scope/final plan whether an in-scope
test artifact is new, renamed, deleted, or modified. The discovery boundary is
recursive `.test.ts` under `plugins/` and `scripts/`, plus
`tests/agents-md-*.test.ts`.

- Include `scripts/vitest-ci-lanes.config.json` in scope when a discovered test
  needs a new, removed, renamed, or changed lane-classification entry.
- Include `scripts/lib/vitest-pre-topology-measurement.mjs` only when the
  existing measurement mechanism/data itself must change.
- Classification and measurement are independent. Do not infer output scope from
  runtime status, PR filenames, or post-handoff discovery.
- If required output cannot be determined before handoff, keep the task in
  authoring rather than guess or delegate scope widening to the worker.

These paths are Issue-body scope content only; naming them never grants access
outside `allowed-roots`.

## Tier selection and review topology

Classify through `docs/tiering.md#task-complexity-tier-rubric`. Once review
starts, do not lower the tier unless the operator explicitly decides to do so.

| Tier | Required published reviews |
| --- | --- |
| T1 | One independent GPT terminal architectural review. |
| T2 | Three independent GPT architectural reviews launched in parallel, then one independent GPT terminal architectural review. |
| T3 | The T2 GPT reviews, plus one separate Claude architectural-lens review before the GPT terminal review. |

For below-the-ladder work, represent the classification with a
`complexity-tier` fence containing `skip-line: true`. This is no tier, not T1,
and it has no tier-required reviewer stages. Continue the authoring workflow and
run the same substantive floor and acceptance checks; no-tier skips only the
tier review topology.

For every required review, the reviewer reads the live Issue and publishes one
top-level Issue comment. The first line is
`Read revision: #<issue> rNN`, using the revision actually read. The review
checks contradictions, feasibility, unnecessary complexity/cheaper sufficient
designs, and material gaps. Findings and clean verdicts stay in the reviewer's
own comment; the manager does not combine them into replacement output.

For T2/T3, the three GPT architectural reviewers are separate fresh project
chats. Browser-GPT turns use the ordinary shared transport path; send-once,
invocation ownership, same-invocation recovery/harvest, and no-blind-resend are
owned by the shared runbook. A possible delivery never authorizes a new send.
T3 Claude is a separate Claude invocation, not a Browser-GPT substitute.

## Publisher attribution

A reviewer or author-disposition comment counts only when GitHub publisher
metadata identifies the trusted principal for that workflow. Check `user.login`
and, where applicable, `author_association`. Body text, claimed role text, or a
revision marker is not publisher proof. Missing/conflicting publisher metadata
does not satisfy the required review/disposition.

Comment count alone does not prove that the three T2/T3 GPT reviews were
independently launched; independence comes from the manager launch procedure.

## Author dispositions

After each required review round, the author publishes one top-level disposition
comment resolving every finding from that round. Each finding is either:

- **accepted** — the next Issue revision contains the correction; or
- **rejected** — the disposition gives a substantive reason.

A clean round needs no disposition comment and no Issue-body mutation. Findings
from earlier rounds remain unresolved until their author disposition exists.
The author may choose a cheaper sufficient remedy than a reviewer's suggestion.

## Substantive floor and terminal review

Immediately before the terminal GPT review, read the current live Issue body and
run the content-only floor:

```bash
node --experimental-strip-types scripts/tier-gate-guard.ts --text "$LIVE_ISSUE_BODY"
```

Fix known floor failures before terminal review.

If the terminal review finds defects, or a substantive-floor defect is discovered
only after terminal review, the author gets exactly one post-terminal correction
for those findings/floor defects. Increment the revision, apply the fixes, rerun
the same floor, and publish the terminal-round disposition. Do not rerun the
terminal reviewer.

## Acceptance

Apply `spec-review:accepted` only when all of the following are true:

- every tier-required reviewer comment exists and has trusted publisher metadata;
- every finding from every required round has an author disposition;
- the substantive floor passed on the terminal-reviewed revision, or on the one
  permitted post-terminal correction;
- the accepted body is exactly the terminal review's named revision or that one
  permitted correction.

An ordinary later unreviewed body revision is not accepted. A direct operator
amendment is accepted by definition.

After applying the label, re-read the Issue body, comments, and label. Manager
completion is legal only after that fresh read proves the complete accepted
state.

## Reviewer prompt

A GPT reviewer prompt supplies the repository, Issue URL, role
(`architectural-review` or terminal `architectural`), and asks the reviewer to:

1. read the live Issue and current repository policy;
2. review the actual revision for contradictions, feasibility, simplification,
   and missing material coverage;
3. publish its complete verdict/findings as one top-level Issue comment whose
   first line names the revision actually read;
4. avoid editing the Issue or inventing workflow authority.

The T3 Claude lens receives the same substantive review goals but runs through
the separate Claude path.

No other create-Issue runbook is required for the ordinary happy path.
