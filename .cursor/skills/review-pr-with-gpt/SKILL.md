---
name: review-pr-with-gpt
description: Use when an orchestrator or supervisor routes an explicit standalone implementation-review request for an exact existing orchestrator-pack PR, or for an exact Issue whose implementation PR must be resolved before review effects, including “PR #N review”, “review PR #N”, “pack review #N”, and “Issue #N review”. Standalone connected-GitHub chat reviewers keep the direct-review path. Reuse the existing supervised manager work class and the shared manager-owned PR-review convergence phase; do not create a second review lifecycle.
---

# review-pr-with-gpt

This skill is a thin orchestrator/supervisor routing wrapper for an operator who
already has an implementation PR and explicitly asks the orchestrator to review
it. It is not the direct connected-GitHub chat review procedure. It owns no
Browser-GPT review mechanics, source semantics, findings settlement, review caps,
fixer protocol, smoke implementation, or second completion state.

After exact target resolution, enter the existing
[Manager-owned PR-review convergence](../../../docs/chatgpt-task-execution-runbook.md#manager-owned-pr-review-convergence)
phase introduced by Issue #1953. That section remains the single authority for
review convergence and manager handoff.

## Trigger and intent boundaries

Use this skill only when the active role is the orchestrator/supervisor and the
operator request contains both an exact PR or Issue target and explicit
implementation-review intent, for example:

- `PR #N review`, `review PR #N`, or `pack review #N`;
- `Issue #N review`, `Issue #N pack review`, or
  `review the implementation for Issue #N`.

Explicit implementation verbs such as `execute`, `выполни задачу`,
`выполни Issue`, or `доделай Issue` remain owned by
`execute-issue-with-gpt`. Existing-Issue `manager` / `менеджер`,
`continue review`, and task-spec/create-Issue review continuation remain owned
by `create-issue-draft`. A connected-GitHub chat executor acting as the direct
reviewer for a top-level PR review or pack-review request follows the direct-review
procedure in `docs/chat-executor-rules.md` instead; do not activate this skill in
that standalone direct-review context. Ordinary discussion containing “review”
without an exact PR/Issue target does not activate this skill.

An exact Issue review request selects this skill without a pre-routing PR
uniqueness query. The manager performs the binding check below before any review
effect.

## Supervisor entry

Use the existing supervised Task path with `work-class=manager`. Launch or
resume that existing manager work class with the exact repository and requested
PR/Issue identity plus the standalone implementation-review assignment. Do not
add a manager class, launcher, scheduler route, queue, watcher, or durable review
state.

The manager's settled-review result is the same whole-role handoff used by the
shared Issue #1953 phase. After that handoff, the supervisor follows the existing
post-manager path and launches or reuses the local supervised
independent-smoke worker for the exact handed-off PR/head. Review settlement by
itself is not overall `VERIFIED_COMPLETE`.

## Manager target resolution

Before any reviewer, fixer, or model effect, re-read live GitHub authority.

For a direct PR target:

1. require the exact PR to be **OPEN**;
2. resolve its repository, PR number, current exact head, and closing Issue
   reference;
3. re-read the linked live Issue and its tier/scope authority;
4. reject a closed PR, missing closing Issue, or conflicting Issue binding
   without silently substituting another target.

For an exact Issue target, resolve open implementation PRs by GitHub closing
reference after this skill has been selected. Review effects are legal only when
GitHub proves **exactly one open implementation PR whose closing reference binds
that Issue**. If zero or multiple PRs satisfy the binding, do not guess by branch
name, recency, author, or first match, and do not fall back to initial
implementation. Surface the exact absence or ambiguity through the existing
manager/supervisor handling.

## Enter the shared review phase

Once the exact live PR/Issue/head binding is established, enter the shared
manager-owned PR-review convergence phase linked above. Do not restate or fork
its mechanics here.

If review authority is already active, partially published, or settled,
resume/reconcile that existing authority. Do not create a duplicate same-head
round merely because this standalone entrypoint was invoked later. If the
required review stage is already complete, perform no redundant reviewer-model
call and continue to the shared settled-review handoff/independent-smoke
decision.

Review findings may be fixed only on the resolved existing implementation PR
through the shared fresh-fixer path. The absence of a valid implementation PR
never authorizes initial implementation.

## Boundaries

This skill adds no review runner, source-comment contract, fixer lifecycle,
review cap, Browser-GPT recovery rule, smoke authority, scheduler bridge, or
state machine. It does not merge unless the direct top-level operator separately
orders merge.
