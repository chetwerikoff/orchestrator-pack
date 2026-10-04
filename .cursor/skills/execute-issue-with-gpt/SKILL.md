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
   `VERIFIED_COMPLETE` or a genuine external top-level stop boundary is
   reached. Shared-boundary `external_pause` and `contract_defect` are
   non-terminal manager outcomes and do not settle the parent Task/Dispatch.
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
8. For a manager-controlled Browser-GPT implementation, treat settled pack
   review as a nonterminal transition into the same manager's `execute:smoke`
   phase. Keep that manager Dispatch alive. For a required scenario-bearing
   plan, the manager re-reads the exact Issue-bound PR/current head with tracked
   `scripts/gh`, creates one unique temporary detached Git worktree at that
   commit without switching its canonical `origin/main` manager worktree,
   executes the plan there, and runs `worker-smoke-run publish --repo-root`
   from that checkout. Remove only that temporary worktree and prove the
   canonical manager worktree HEAD/branch/status unchanged before consuming the
   already-emitted publish JSON through the shared boundary. `PASS` may
   complete the manager role; proved `FAIL` enters the existing fixer
   continuation and smoke is explicitly executed again after the corrected
   head is ready. Settled pack review stays complete. `not-applicable` and
   supported `legacy-exempt` requirements keep the existing no-smoke path.

Supervisor launch and recovery remain governed by
[`docs/orchestration-runbook.md`](../../../docs/orchestration-runbook.md) and the
existing supervised manager Task/Dispatch path.

## Manager contract

The manager owns one resumable external GPT Issue-execution session. Before its
first Browser-GPT side effect it reads both:

- [`docs/chatgpt-task-execution-runbook.md`](../../../docs/chatgpt-task-execution-runbook.md);
- [`docs/browser-gpt-turn-runbook.md`](../../../docs/browser-gpt-turn-runbook.md).
Every manager-facing turn-driver, page-probe, and review-runner result is
projected through the single shared #2078/#2081 four-outcome boundary before the
manager acts on it. Execute-Issue boundary actions are limited to the three
read-only reconciliation kinds; the boundary never emits `--new-chat`, a fresh
conversation, reviewer resend, or another ChatGPT-send-capable argv. Send
authority remains exclusively with the existing runbook send/no-resend/final-
revalidation gates. A boundary outcome never becomes manager
`worker_done --outcome failed`.

At the start of **every** manager turn, re-read the live Issue before choosing
the turn prompt or next action. If the title/body changed since the manager's
last authoritative read, treat those live bytes as delta scope for the same
Issue-bound PR/branch and carry that delta through the existing execution loop.
Do not ask the operator to re-accept their edit or open a second implementation.

The execution runbook owns first-session initialization, same-conversation
continuations, the execution-only 30-minute live-chat checkpoint, candidate-state
verification, the reusable manager-owned PR-review convergence phase, and
manager-to-supervisor handoff. After the implementation conversation reaches a
candidate-complete current PR/head with required CI green, the manager enters that
shared review phase; it does not report overall `VERIFIED_COMPLETE`.

The shared review phase invokes only the canonical
`npm run --silent pack-gpt-review -- --project <PROJECT_ID> --session-id <MANAGER_SESSION_ID> --pr-number <PR_NUMBER>`
runner when the supervised manager will park on review completion. The session id is the manager's
exact already-owned supervised identity; never infer it from branch/worktree/title/PID. If that
binding is unavailable, omit `--session-id`, keep the runner foregrounded/observed, consume its
terminal result directly, and do not park waiting for `workerNotification`. Required
reviewer sources are fresh project chats owned by that runner. A findings-bearing
logical round gets one fresh GPT fixer conversation distinct from the
implementation conversation and every reviewer conversation; after a
strict-descendant fix and current CI green, the existing tier/cap review authority
continues. The manager never manufactures scheduler `ready_for_review` state or
delegates required smoke to a separate smoke actor.

The shared Browser-GPT runbook remains the sole owner of one-turn launch,
observation, attribution, recovery, retry/no-resend, publication, and tab
mechanics.

Execute-Issue product-error recovery—including its reserved causes, GitHub-first reconciliation, same-conversation continuation, checkpoint, grace period, and fallback gates—is owned by the [execution runbook](../../../docs/chatgpt-task-execution-runbook.md). Follow that runbook; this skill does not restate those mechanics.

## Terminal outcomes

Normal operator-visible completion is `VERIFIED_COMPLETE`. For a
manager-controlled Browser-GPT implementation, the same manager may complete
its own role only after canonical pack-review obligations settle and, when smoke
is required, its `execute:smoke` path has published a same-PR PASS and
successfully removed the temporary PR checkout while preserving the canonical
manager worktree. Overall `VERIFIED_COMPLETE` additionally requires
current-head required CI green and a fresh current-state verification under
`docs/chat-executor-rules.md` and the live Issue. GPT self-report and manager
completion are advisory rather than overall completion authority.

`OPERATOR_ACTION_REQUIRED` is exceptional and names only a remaining
credential/CAPTCHA human action after legal recovery is exhausted. The remedy
identifies exactly one action from observed evidence; the coordinator resumes the
same Dispatch after observing its completion. Manager-side effect is the shared
#2078 escalation with canonical `resume_when: { coordinator: true }`; legacy
`{ operator: true }` pause records are input compatibility only and normalize
to coordinator ownership without rewriting history. The parent Task and manager
Dispatch remain non-terminal and no `worker_done --outcome failed` is sent.

Merge is never implicit. Stop at the verified repository completion/readiness
state unless the direct top-level operator separately orders merge.

## No new machinery
The #2078/#2081 shared boundary is the only manager result classifier. Do not
add a second blocker/result classifier, ledger, retry engine, store, daemon,
registry, or supervisor recovery subsystem.

This workflow adds no second Browser-GPT transport/probe/runtime behavior,
generic browser skill, daemon, scheduler, watcher, queue, lease, retry service,
durable conversation/completion database, cross-process invocation registry,
second supervisor recovery subsystem, or second Definition-of-Done authority.
The existing page probe remains diagnostic/observation-only for the execution
checkpoint and never owns Retry, resend, close, open, or navigation authority.
