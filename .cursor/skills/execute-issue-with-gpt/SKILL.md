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
8. For a manager-controlled Browser-GPT implementation, consume the manager's
   settled pack-review handoff instead of treating manager completion as overall
   completion. Launch or reuse the existing supervised local worker as the
   independent-smoke parent for the exact handed-off PR/head. The parent execute
   workflow stays alive until that exact-head independent smoke passes and a
   fresh final current-state verification succeeds.

Supervisor launch and recovery remain governed by
[`docs/orchestration-runbook.md`](../../../docs/orchestration-runbook.md) and the
existing supervised manager Task/Dispatch path.

## Manager contract

The manager owns one resumable external GPT Issue-execution session. Before its
first Browser-GPT side effect it reads both:

- [`docs/chatgpt-task-execution-runbook.md`](../../../docs/chatgpt-task-execution-runbook.md);
- [`docs/browser-gpt-turn-runbook.md`](../../../docs/browser-gpt-turn-runbook.md).

The execution runbook owns first-session initialization, same-conversation
continuations, the execution-only 27-minute live-chat checkpoint, candidate-state
verification, the reusable manager-owned PR-review convergence phase, and
manager-to-supervisor handoff. After the implementation conversation reaches a
candidate-complete current PR/head with required CI green, the manager enters that
shared review phase; it does not report overall `VERIFIED_COMPLETE`.

The shared review phase invokes only the canonical
`npm run --silent pack-gpt-review -- --pr-number <PR_NUMBER>` runner. Required
reviewer sources are fresh project chats owned by that runner. A findings-bearing
logical round gets one fresh GPT fixer conversation distinct from the
implementation conversation and every reviewer conversation; after a
strict-descendant fix and current CI green, the existing tier/cap review authority
continues. The manager never manufactures scheduler `ready_for_review` state or
acts as the independent-smoke actor.

The shared Browser-GPT runbook remains the sole owner of one-turn launch,
observation, attribution, recovery, retry/no-resend, publication, and tab
mechanics.

For execute-Issue recovery, the three reserved product causes are
`message_delivery_timed_out`, `product_network_error`, and `message_stream_error`.
They stay on the existing `turn-result/v1` axis as
`state: recovery_required` with `scope: conversation`; they do not introduce a
new turn state. An authoritative owned result with one of these causes enters
the execution runbook's GitHub-first reconciliation immediately. If work remains,
the manager first sends one ordinary tracked continuation in the same exact
owned conversation; this is not the product Retry control. Fresh-chat fallback
is allowed only after the continuation has received the full 10-minute minimum
grace, is authoritatively settled/recovered under the existing Browser-GPT
lifecycle, and final chat/GitHub reads prove no progress and the saved
PR/head, branch/head, or no-work baseline remains unchanged. At the existing
27-minute checkpoint, use `browser-gpt-page-probe inspect` only as observation:
its normalized `execution_recovery_cause` must be combined with exact owned-turn,
reply, and generation evidence before it can authorize that same recovery
branch. Elapsed time, missing output, helper silence, `stream_timeout`, or
`no_reply` alone never authorize a replacement conversation.

For execute-Issue recovery, the 27-minute checkpoint uses the exact durable
invocation identity already retained by the manager. Invoke the existing probe
in identity-bound form with the exact retained CDP/profile/invocation plus the
already-owned page locator:

```text
browser-gpt-page-probe inspect
  --cdp <exact retained endpoint>
  --profile <exact retained configured profile>
  --invocation-id <exact retained invocation id>
  (--url <exact owned conversation url> | --target-id <exact owned target id>)
```

The probe resolves only the matching `state-light-turn-observation/v1` record
for `{configured profile key, invocation id}`; it does not scan sibling records,
alternate profiles, or page-wide markers to recover identity. A bounded
observer/wait slice is not the lifetime of the Browser-GPT turn. Slice expiry
without authoritative settlement preserves the exact run identity, attempt
identity, invocation id, profile, CDP endpoint, and conversation binding and
permits only continued observation of that same invocation.

When the identity-bound 27-minute read says the exact owned turn is still
generating, send zero new user messages and continue bounded observation of the
same invocation. The first post-checkpoint continuation starts one
recovery-observation episode with the existing
`DEFAULT_TIMEOUT_MS = 1_800_000 ms` ceiling; later observation slices consume
the remaining budget and never reset or extend it. If the exact turn is still
unsettled/generating when that ceiling is exhausted, automatic re-observation
stops and the exact fail-closed condition is handed to the existing supervisor
boundary. Exhaustion creates no resend, replacement-invocation, or fresh-chat
authority.

A replacement/resumed manager does not create a new conversation merely because
it is a new process. It first follows the execution runbook's recovery branch and
the shared Browser-GPT evidence requirements. After exact product-error proof,
reconcile GitHub and try the one tracked continuation in the same exact owned
conversation. Before any fresh-chat fallback, the exact continuation invocation
must have completed the full 10-minute grace and be authoritatively
settled/recovered under existing Browser-GPT authority; fresh chat additionally
requires final reads proving no chat progress and the unchanged saved repository
baseline. If the cause is gone, a reply or generation appeared, ownership is
ambiguous, the baseline changed, or settlement evidence is unavailable, do not
send the fallback; resume ordinary observation/recovery or review convergence.

## Terminal outcomes

Normal operator-visible completion is `VERIFIED_COMPLETE`. For a
manager-controlled Browser-GPT implementation, the manager may complete its own
role only after the canonical pack-review obligations settle and it hands the
supervisor the exact Issue/PR/head/CI/review facts with `independent smoke` as
the next legal action. Overall `VERIFIED_COMPLETE` is legal only after the
supervisor-owned local independent-smoke worker passes on the final exact head and
a fresh current-state verification under `docs/chat-executor-rules.md` and the
live Issue succeeds. GPT self-report and manager completion are advisory rather
than overall completion authority.

`OPERATOR_ACTION_REQUIRED` is exceptional. Use it only after the legal existing
recovery path is exhausted and the remaining condition is a genuine external
permission/capability failure, impossibility, unresolved target ambiguity, or the
fail-closed possible-send identity gap described above.

Merge is never implicit. Stop at the verified repository completion/readiness
state unless the direct top-level operator separately orders merge.

## No new machinery

This workflow adds no second Browser-GPT transport/probe/runtime behavior,
generic browser skill, daemon, scheduler, watcher, queue, lease, retry service,
durable conversation/completion database, cross-process invocation registry,
second supervisor recovery subsystem, or second Definition-of-Done authority.
The existing page probe remains diagnostic/observation-only for the execution
checkpoint and never owns Retry, resend, close, open, or navigation authority.
