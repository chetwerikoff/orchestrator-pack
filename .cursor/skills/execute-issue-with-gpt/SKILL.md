---
name: execute-issue-with-gpt
description: Use for explicit requests to execute or continue an existing orchestrator-pack GitHub Issue through GPT, including “execute Issue #N”, “выполни задачу”, “выполни Issue”, and “доделай Issue”. The supervisor keeps whole-task continuity, launches or resumes the existing manager work class, and reaches VERIFIED_COMPLETE only after independent current GitHub Definition-of-Done verification.
---

# execute-issue-with-gpt

This skill is the canonical supervisor/workflow routing authority for an explicit
request to execute an **existing** GitHub Issue through GPT. It does not own the
mechanics of one Browser-GPT turn and does not create a second browser workflow.

## Trigger and boundaries

Use this skill when the direct operator asks to execute or continue an existing
Issue, for example `execute Issue #N`, `выполни задачу`, `выполни Issue #N`, or
`доделай Issue #N`.

Do not use it merely to create/revise an Issue, review a PR, discuss an artifact,
or perform an unrelated GPT consultation. Those requests keep their existing
skills and authorities.

The supervisor reads the live Issue and current repository policy. It does not
load `create-issue-draft` merely to learn Browser-GPT mechanics. The shared
portable authority for one tracked Browser-GPT turn is
[`docs/browser-gpt-turn-runbook.md`](../../../docs/browser-gpt-turn-runbook.md).
The composition of multiple completed turns into one Issue execution is owned by
[`docs/chatgpt-task-execution-runbook.md`](../../../docs/chatgpt-task-execution-runbook.md).

## Supervisor contract

The supervisor owns **completion continuity**, not substantive implementation.

1. Resolve the exact existing Issue and use the existing supervised Task path
   with `work-class=manager`; do not add another manager class or launch system.
2. Give the manager the Issue identity/URL and the execute-Issue assignment.
3. Keep the parent task alive until the execution runbook reaches
   `VERIFIED_COMPLETE` or the existing top-level stop boundary is genuinely
   reached.
4. Treat manager/helper/browser/runtime failures as recovery work while the
   existing authoritative evidence still identifies the owned execution
   session/turn, or proves that no prior send/session must be preserved.
5. When recovery is required, inspect the concrete current condition and resume
   through a manager only from the exact authoritative evidence required by the
   owning Browser-GPT recovery branch. Read the deep Browser-GPT runbook itself
   only when performing or diagnosing that recovery.
6. If a possible send occurred and the exact authoritative
   conversation/invocation/profile/CDP identity required by the recovery path is
   unavailable after legal recovery is exhausted, fail closed: no fresh chat,
   no duplicate prompt, and no guessed identity.
7. Never take over the substantive Issue implementation merely because manager
   recovery is required.

Supervisor launch and recovery remain governed by
[`docs/orchestration-runbook.md`](../../../docs/orchestration-runbook.md) and the
existing supervised manager Task/Dispatch path.

## Manager contract

The manager owns one resumable external GPT Issue-execution session. Before its
first Browser-GPT side effect it reads both:

- [`docs/chatgpt-task-execution-runbook.md`](../../../docs/chatgpt-task-execution-runbook.md);
- [`docs/browser-gpt-turn-runbook.md`](../../../docs/browser-gpt-turn-runbook.md).

The execution runbook owns first-session initialization, same-conversation
continuations, the execution-only 27-minute live-chat checkpoint, independent
GitHub Definition-of-Done verification, and manager-to-supervisor recovery
handoff. The shared Browser-GPT runbook remains the sole owner of one-turn launch,
observation, attribution, recovery, retry/no-resend, publication, and tab
mechanics.

A replacement/resumed manager does not create a new conversation merely because
it is a new process. It first follows the execution runbook's recovery branch and
the shared Browser-GPT evidence requirements.

## Terminal outcomes

Normal operator-visible completion is `VERIFIED_COMPLETE`, and only after a fresh
current-state verification under `docs/chat-executor-rules.md` and the live Issue.
GPT self-report is advisory rather than completion authority.

`OPERATOR_ACTION_REQUIRED` is exceptional. Use it only after the legal existing
recovery path is exhausted and the remaining condition is a genuine external
permission/capability failure, impossibility, unresolved target ambiguity, or the
fail-closed possible-send identity gap described above.

Merge is never implicit. Stop at the verified repository completion/readiness
state unless the direct top-level operator separately orders merge.

## No new machinery

This workflow adds no Browser-GPT transport/probe/runtime behavior, generic
browser skill, daemon, scheduler, watcher, queue, lease, retry service, durable
conversation/completion database, cross-process invocation registry, second
supervisor recovery subsystem, or second Definition-of-Done authority.
