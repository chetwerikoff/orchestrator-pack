# ChatGPT task execution runbook

This runbook owns the **multi-turn composition** for executing one existing GitHub
Issue through GPT until the repository Definition of Done is independently
verified. It does not own the mechanics of one Browser-GPT turn.

The sole portable authority for one tracked Browser-GPT turn is
[`docs/browser-gpt-turn-runbook.md`](browser-gpt-turn-runbook.md). Use that
runbook for browser/configuration preflight, fresh versus existing conversation
selection, invocation identity, launch, marker ownership, observation,
page-completion semantics, same-invocation recovery/harvest, retry/no-resend,
publication/cleanup, and tab lifecycle. Do not copy those mechanics here.

`docs/chat-executor-rules.md` remains the standalone chat Definition-of-Done
authority. `docs/orchestration-runbook.md` remains the model-neutral
supervisor/manager lifecycle authority.

## Scope and role split

This runbook is entered only from the explicit execute-existing-Issue workflow
owned by `.cursor/skills/execute-issue-with-gpt/SKILL.md`.

- **Supervisor:** owns whole-task continuity and recovery routing. It does not
  become the Issue implementer.
- **Manager:** owns one resumable external GPT Issue-execution session through
  verified completion or an evidence-bounded recovery handoff.
- **GPT executor:** may implement the Issue, but its status text is advisory;
  current GitHub/repository evidence decides completion.

The execute supervisor does not need to read `create-issue-draft` to learn
Browser-GPT mechanics. The manager reads this runbook and the shared Browser-GPT
runbook before its first Browser-GPT side effect. The supervisor reads the deep
Browser-GPT runbook only when it must perform or diagnose Browser-GPT recovery.

## Preconditions

Before the first execution turn, the manager:

1. reads the live Issue and required repository policy;
2. confirms the Issue is executable under its current prerequisites and scope;
3. reads this runbook and `docs/browser-gpt-turn-runbook.md`;
4. preserves any authoritative execution-session/turn identity already supplied
   by an earlier manager or recovery handoff;
5. applies all one-turn preconditions from the shared Browser-GPT runbook.

A replacement/resumed manager is not a first-session initialization merely
because its process is new.

## First-session initialization

Open one fresh ChatGPT execution conversation only when the owning Browser-GPT
contract and current evidence establish that no prior execution session/send for
this assignment must be preserved.

The initial human-facing prompt stays deliberately small. Use the equivalent of:

```text
<ISSUE_URL> выполни задачу

At the end of each finished response report:
EXECUTION_STATUS: complete | continue
PR: <url | none>
HEAD: <sha | none>
REMAINING: <what remains | none>
```

Submit that initial Issue/execution request exactly once under the shared
Browser-GPT turn authority.

Do not inject a large policy prompt that copies repository rules already
available to the executor. The live Issue and live repository policy remain the
authoritative implementation contract.

## Resumed or replacement manager

On replacement/resume, first recover and reuse the existing authoritative
execution session/turn evidence required by the shared Browser-GPT runbook.
Never open a fresh conversation merely because the previous manager process is
gone.

A fresh execution conversation or a new initial send is legal only when the
owning Browser-GPT contract positively proves that no prior send/session must be
preserved and independently authorizes that send. The one narrow post-send
exception is the exact owned `message_delivery_timed_out` recovery defined below:
it authorizes GitHub-first reconciliation, and only after that reconciliation may
the manager replace the failed conversation.

If a possible send occurred but the exact authoritative
conversation/invocation/profile/CDP identity required by the owning recovery
branch is unavailable, send nothing and hand that exact fail-closed condition to
the supervisor. Do not scan, infer, guess, or reconstruct an invocation identity
outside the shared authority.

If elapsed time for an existing submitted turn cannot be reconstructed but the
exact authoritative binding needed to identify that turn **is** available, make
a fresh live observation of the actual owned conversation before any new prompt.
Do not restart an arbitrary timer and blindly wait or send.

## Per-turn execution contract

Every manager -> ChatGPT execution turn is one ordinary tracked Browser-GPT turn
under `docs/browser-gpt-turn-runbook.md` plus the execution-only checkpoint in
the next section.

A new user turn is legal only after the previous owned turn has been settled or
recovered under the shared authority and there is a concrete reason to continue.
The workflow is completion-driven, not iteration-count-driven.

The compact status footer is an executor hint:

```text
EXECUTION_STATUS: complete | continue
PR: <url | none>
HEAD: <sha | none>
REMAINING: <what remains | none>
```

Missing or malformed status does not prove success or failure.
`EXECUTION_STATUS: complete` never bypasses independent current-state
verification.

An authoritative `turn-result/v1` whose exact owned state is
`message_delivery_timed_out` is a terminal product-error observation for that
turn. Do not wait until the 27-minute checkpoint after this state is already
known; enter **Message-delivery timeout recovery (GitHub-first)** below. This
state authorizes reconciliation, never blind resend.

## Mandatory 27-minute live-chat checkpoint

This checkpoint belongs **only** to this execution workflow. It is not a
universal Browser-GPT timeout and must not be promoted into the shared
Browser-GPT runbook.

For every submitted execution turn:

1. start normal observation under the shared Browser-GPT turn/long-running
   contract;
2. when an authoritative completed turn result arrives before 27 minutes,
   process it normally; an exact owned `message_delivery_timed_out` result enters
   the recovery section below immediately;
3. when 27 minutes elapse after submission without an authoritative completed
   turn result, perform a **fresh independent observation of the actual bound
   ChatGPT conversation page** using the state-light execution checkpoint and
   the exact authoritative profile/CDP/invocation binding;
4. invoke the existing state-light entry surface in observation-only mode,
   equivalent to:

   ```text
   scripts/chatgpt-browser-turn/state-light-entry.ts execution-checkpoint \
     --profile <authoritative-profile> \
     --cdp <authoritative-cdp> \
     --invocation-id <authoritative-invocation-id>
   ```

   The checkpoint obtains the owned marker and conversation URL from the
   existing `state-light-turn-observation/v1` record. Do not pass, infer, scan,
   or reconstruct a replacement marker/conversation identity;
5. do not decide turn completion from helper/launcher PID, shell state,
   heartbeat, timeout, missing output, log silence, or terminal-envelope
   absence;
6. treat the checkpoint as one-shot observation only. Elapsed time is never
   completion, failure, retry, resend, replacement-invocation, fresh-chat, or
   `Доделай` authority.

The checkpoint reuses the same normalized product-message classifier and the
same owned-marker cardinality/reply/generation predicates as the immediate
state-light path. It does not click Retry, create a page, navigate a page, send a
message, add a watcher, or create a second recovery store.

Interpret the checkpoint observation only through this mapping:

- **`message_delivery_timed_out`:** the exact bound page, exact owned current
  prompt, stable product timeout banner, no attributable assistant reply, and no
  active generation were all established. Enter **Message-delivery timeout
  recovery (GitHub-first)** below.
- **`owned_reply_generating`:** send zero new user messages and continue
  observation of the same turn.
- **`owned_reply_completed`:** recover/consume the original turn through the
  existing same-invocation harvest/settlement path before any follow-up.
- **`owned_turn_unsettled`:** continue the existing bounded observation/recovery
  path; there is no fresh-chat authority.
- **`ambiguous` or unavailable checkpoint evidence:** remain fail-closed on the
  existing recovery path; no fresh chat and no resend.
- **Proven no-send/pre-send failure:** only the existing owning Browser-GPT
  correction/retry contract may authorize another send.

No second watcher, raw-CDP loop, Playwright monitor, timer service, daemon,
durable 27-minute state, new cross-process session/invocation registry, or
manager-owned timeout regex is introduced by this checkpoint.

## Message-delivery timeout recovery (GitHub-first)

This section is entered only after either:

1. an authoritative immediate `turn-result/v1` for the exact owned invocation
   reports `state: message_delivery_timed_out`; or
2. the mandatory 27-minute checkpoint independently reports exact
   `message_delivery_timed_out` for that same authoritative invocation.

Generic helper timeout, launcher timeout, `stream_timeout`, `no_reply`, browser
loss, missing output/envelope, process death, page ambiguity, or elapsed 27
minutes by itself **never** enters this section.

After one of the two exact timeout proofs, and before any replacement ChatGPT
send, perform a fresh live GitHub reconciliation for the exact Issue:

1. find an existing PR only through authoritative Issue/PR identity and record
   its current head;
2. otherwise find an unambiguous Issue-owned task branch/current commits through
   authoritative repository identity; a coincidental branch name or recent
   commit is not enough;
3. independently check whether current GitHub/repository state already satisfies
   Definition of Done;
4. if candidate ownership is ambiguous, fail closed and resolve that ambiguity;
   do not open a fresh execution chat.

Repository continuation state is advisory input to the replacement executor;
current GitHub state remains authoritative. Capture that continuation state
**before** closing the failed conversation.

Then:

- **Existing PR and work remains:** close only the exact owned failed
  conversation under the existing tab lifecycle authority, open one fresh
  execution conversation, and include the Issue URL + PR URL + exact current
  head with wording equivalent to `доделай задачу, продолжай существующую
  реализацию`.
- **No PR, but one unambiguous Issue-owned task branch/current head and work
  remains:** close only the exact owned failed conversation, open one fresh
  execution conversation, and include the Issue URL + branch + exact current
  head with wording equivalent to `доделай задачу, продолжай с этой ветки`.
- **No observed task work:** close only the exact owned failed conversation and
  use the ordinary initial Issue URL + `выполни задачу` prompt in one fresh
  execution conversation.
- **Definition of Done already independently satisfied:** do not open another
  ChatGPT conversation; complete the normal verification path and return
  `VERIFIED_COMPLETE`.

Never press the product Retry button. Never resend into the failed conversation.
Never close a sibling/foreign tab by focus, age, URL similarity, or timeout text.
Fresh-chat authority exists only for the two exact timeout proofs above and is
consumed by opening at most one replacement execution conversation after
GitHub-first reconciliation.

## Continue in the same conversation

After a finished reply is recovered:

- when the executor reports or clearly leaves remaining work, send one
  continuation in the **same owned conversation**;
- a generic continuation may be `Доделай задачу`;
- when independent manager verification already knows a concrete gap, prefer
  that concrete gap over making GPT rediscover it;
- every continuation is another tracked turn and therefore receives the same
  shared one-turn mechanics plus the same 27-minute execution checkpoint.

Never create a second execution conversation as a convenience for continuation.
The only post-send fresh-conversation exception is the exact
`message_delivery_timed_out` GitHub-first recovery defined above.

## Multi-turn completion loop

```text
submitted GPT turn
  -> exact message_delivery_timed_out result
       OR 27-minute exact checkpoint confirmation
       -> inspect live GitHub first
       -> DoD already satisfied: VERIFIED_COMPLETE
       -> PR/branch/no-work continuation state captured
       -> close exact failed owned chat
       -> one fresh execution chat
  -> finished GPT reply
       -> continue / remaining work
            -> same conversation: "Доделай задачу" or concrete gap
            -> shared one-turn mechanics
            -> execution-only 27-minute checkpoint
            -> repeat
       -> claims complete
            -> manager independently verifies current GitHub/repository state
            -> DoD satisfied: VERIFIED_COMPLETE
            -> DoD not satisfied: same conversation with concrete gap
            -> repeat
```

No fixed iteration cap replaces completion evidence. Existing supervisor and
Browser-GPT recovery boundaries still apply.

## Independent GitHub Definition-of-Done verification

Before returning `VERIFIED_COMPLETE`, perform a fresh current-state check under
the live Issue and `docs/chat-executor-rules.md`. Where applicable, verify at
least:

- the intended scoped implementation is published in the PR;
- changed paths/diff match the Issue scope;
- important publication results were read back;
- required CI is green for the exact current PR head;
- required smoke is bound to that current head when the Issue declares smoke;
- no known current material review finding remains unresolved;
- current-head review authority is acceptable;
- merge has **not** been performed unless the direct top-level operator
  separately ordered merge.

An executor self-report, prior-turn summary, old PR head, old CI, or old review
is not completion evidence.

When verification finds a concrete gap, send that exact gap back into the same
ChatGPT conversation and continue the loop. Examples include a red required CI
check, missing scoped file, unresolved material review finding, stale head-bound
smoke, or another live Issue acceptance gap. If the immediately preceding owned
conversation ended in exact `message_delivery_timed_out`, use the GitHub-first
fresh-chat recovery above instead of sending into that failed chat.

## Recovery handoff to the supervisor

Do not create a new blocker/result state machine.

When the manager reaches a condition it cannot legally repair within its
execution scope, return through the existing Task/Dispatch/manager handoff with:

- the Issue identity;
- the concrete obstacle;
- the last verified repository/GitHub state;
- all exact conversation/invocation/profile/CDP identity that is actually
  available;
- the next legal recovery action under the owning runbook.

The supervisor attempts recovery and returns work to a manager only when
existing authoritative evidence can identify the owned session/turn without
guessing.

Manager/helper/browser/runtime failure is not by itself an operator-facing
terminal state. Normal internal recovery includes cases such as manager process
exit when the exact session/turn binding survives, helper timeout/lost result
with retained turn identity, a turn crossing the 27-minute checkpoint while the
bound conversation remains observable, temporary browser/CDP/runtime
unavailability that preserves required identity, stale manager runtime state,
partial implementation, red CI, or another concrete implementation gap.

If a possible send occurred and the exact authoritative recovery identity is
unavailable after the legal existing recovery path is exhausted, the supervisor
fails closed: no fresh execution conversation, no duplicate prompt, no invented
history, and `OPERATOR_ACTION_REQUIRED` names the missing identity/evidence
boundary.

## Operator-visible terminal states

### `VERIFIED_COMPLETE`

Use only after the fresh Definition-of-Done verification passes. This is the
normal terminal outcome.

### `OPERATOR_ACTION_REQUIRED`

Use only after legal recovery is exhausted and the remaining obstacle is a
genuine external permission/capability requirement, impossibility, unresolved
target ambiguity, or the possible-send active-turn identity gap for which the
shared Browser-GPT authority forbids guessing.

Do not use `OPERATOR_ACTION_REQUIRED` merely because a manager/helper/browser
attempt failed, CI is red, GPT left work incomplete, or a recoverable runtime
condition occurred.

## Non-goals

This workflow does not add or redesign:

- a generic Browser-GPT skill;
- a manager work class or coding-worker supervisor role;
- Browser-GPT send-once rules, marker grammar, page-completion semantics,
  generic retry/no-resend authority, or tab lifecycle;
- `discuss-with-gpt` standalone-driver behavior;
- a daemon, scheduler, watcher, polling service, queue, lease, claim,
  acknowledgement, retry engine, blocker ledger, conversation database,
  completion database, or cross-process invocation/session registry;
- a second supervisor recovery subsystem;
- a second Definition-of-Done classifier;
- automatic merge;
- model/provider selection policy;
- per-engine copies of this workflow.

The execution-only `execution-checkpoint` command is a bounded one-shot observer
on the existing state-light entry surface. It reuses the existing observation
record, exact page identity, transcript reader, marker cardinality, product
classifier, and profile authority; it is not a second Browser-GPT transport or
monitor.

If real implementation requires a new persistent cross-process ownership or
recovery guarantee, new generic Browser-GPT resend authority, or another
stronger subsystem guarantee, stop before widening this workflow and return to
the live Issue/tier authority.
