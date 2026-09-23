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

- **Supervisor:** owns whole-task continuity, recovery routing, and the
  post-manager local independent-smoke launch. It does not become the Issue
  implementer.
- **Manager:** owns one resumable external GPT Issue-execution session through
  candidate implementation and the reusable manager-owned PR-review convergence
  phase, ending at a settled-review handoff or an evidence-bounded recovery
  handoff.
- **GPT executor:** may implement or fix the Issue, but its status text is
  advisory; current GitHub/repository evidence decides progression and
  completion.

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
preserved and independently authorizes that send. The narrow post-send exception
owned by this runbook is the exact execute-Issue product-error recovery below.
It starts with GitHub-first reconciliation and is available only for the reserved
causes `message_delivery_timed_out` and `product_network_error` after exact
owned-turn proof.

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

The two execute-Issue product errors stay on the existing `turn-result/v1`
contract. An authoritative exact-owned result of this form:

```text
state: recovery_required
scope: conversation
cause: message_delivery_timed_out | product_network_error
```

is terminal evidence for that Browser-GPT turn and enters **Product-error
recovery (GitHub-first)** immediately. It does not create a new TurnState, retry
contract, exit-code contract, or record version. A transport-only
`stream_timeout`, `no_reply`, helper timeout, browser loss, missing envelope, or
process exit is not equivalent evidence and grants no fresh-chat authority.

## Mandatory 27-minute live-chat checkpoint

This checkpoint belongs **only** to this execution workflow. It is not a
universal Browser-GPT timeout and must not be promoted into the shared
Browser-GPT runbook. It is the only execution timer/checkpoint; do not add a
second monitor, watcher, daemon, polling loop, durable timer, or recovery store.

For every submitted execution turn:

1. start normal observation under the shared Browser-GPT turn/long-running
   contract;
2. when an authoritative completed turn result arrives before 27 minutes,
   process it normally; an exact-owned `recovery_required` result with either
   reserved product cause enters the GitHub-first recovery section immediately;
3. when 27 minutes elapse after submission without an authoritative completed
   turn result, perform one **fresh observation of the actual bound ChatGPT
   conversation** using `scripts/browser-gpt-page-probe.ts inspect` and the exact
   authoritative profile/CDP/conversation/target binding already owned by the
   workflow;
4. do not use `--open-if-missing`, create a page, close a page, navigate, Retry,
   resend, or invent a replacement target for this checkpoint; the probe is
   diagnostic/observation-only and its envelope keeps `workflow_authority:
   none`;
5. consume the probe's bounded normalized `execution_recovery_cause` only in
   combination with exact current-turn evidence: the exact execute-Issue owned
   prompt is the current prompt, no completed attributable assistant reply is
   present, and generation is positively not active;
6. do not decide turn completion or replacement authority from helper/launcher
   PID, shell state, heartbeat, elapsed time, missing output, log silence,
   terminal-envelope absence, or the product-cause projection by itself.

The probe's `execution_recovery_cause` is derived from the same Browser-GPT
product-state helper used by the immediate state-light path. The manager does not
own another regex or copy of the two product messages.

Interpret the checkpoint evidence only through this mapping:

- **Reserved product cause + exact owned current prompt + no attributable
  completed reply + no active generation:** enter **Product-error recovery
  (GitHub-first)** below.
- **Generation active:** send zero new user messages and continue observation of
  the same turn.
- **Completed attributable reply:** recover/consume the original turn through
  the existing same-invocation harvest/settlement path before any follow-up.
- **Foreign/sibling prompt, ambiguous ownership, stale earlier-turn product
  banner when distinguishable, unknown generation, missing proof, or conflicting
  evidence:** remain fail-closed on the existing observation/recovery path; no
  fresh chat and no resend.
- **Proven no-send/pre-send failure:** only the existing owning Browser-GPT
  correction/retry contract may authorize another send.

Positive same-turn product proof takes precedence over transport-only
`stream_timeout`/`no_reply` evidence. Without that positive product proof, those
transport failures remain fail-closed and never authorize a fresh conversation.

## Product-error recovery (GitHub-first)

Enter this section only after one of these two proofs for the exact owned turn:

1. an authoritative immediate `turn-result/v1` reports `state:
   recovery_required`, `scope: conversation`, and cause
   `message_delivery_timed_out` or `product_network_error`; or
2. the mandatory 27-minute checkpoint independently observes one of those two
   product causes **and** the manager also has exact current owned-prompt proof,
   no attributable completed reply, and no active generation.

Generic helper timeout, launcher timeout, `stream_timeout`, `no_reply`, browser
loss, missing output/envelope, process death, page ambiguity, or elapsed 27
minutes by itself **never** enters this section.

After exact product-error proof, perform a fresh live GitHub reconciliation for
the exact Issue **before** any replacement ChatGPT send:

1. resolve an existing Issue-bound PR first and record its exact current head;
2. only when no such PR exists, resolve one unambiguous Issue-bound task branch
   and its current commits/head; a coincidental branch name or recent commit is
   not enough;
3. reuse the existing independent Definition-of-Done verification path against
   that current repository/GitHub state; do not create a second DoD classifier;
4. if PR/branch ownership is ambiguous, fail closed and resolve that ambiguity;
   do not open a fresh execution chat.

If current state already establishes a candidate-complete implementation, do
**not** open a replacement implementation conversation. Resolve the exact live
Issue-bound PR/head and required CI state; when the review-entry preconditions
below are satisfied, enter **Manager-owned PR-review convergence**. This manager
path does not return overall `VERIFIED_COMPLETE` before the later
supervisor-owned independent smoke.

Otherwise capture one continuation choice:

- **Existing PR:** Issue URL + PR URL + exact current PR head, with wording
  equivalent to `доделай задачу, продолжай существующую реализацию`.
- **No PR, one unambiguous Issue-owned branch:** Issue URL + exact branch + exact
  current head, with wording equivalent to `доделай задачу, продолжай с этой
  ветки`.
- **No observed Issue-bound work:** ordinary initial Issue URL + `выполни
  задачу` prompt.

### Mandatory final revalidation before the replacement send

GitHub-first reconciliation does not itself consume fresh-chat authority.
Immediately before the replacement prompt is sent, revalidate **both** browser
and repository state:

1. re-observe the exact same old owned conversation/turn;
2. require the same supported product cause to remain visible for that owned
   current turn;
3. require no completed attributable assistant reply;
4. require generation to be positively stopped;
5. perform a final live GitHub read of the selected PR/branch head and current
   completion state.

If any browser condition fails, ownership is ambiguous, the continuation head
changed, or the implementation became candidate-complete, do not send the
prepared replacement prompt. Return to ordinary recovery/observation, or enter
the manager-owned PR-review convergence phase when the final live read proves
its entry preconditions. Never use closing the old tab as evidence that
execution stopped.

Only after this final revalidation may the workflow close **only** the exact
owned failed conversation under existing tab-lifecycle authority and open
exactly one fresh execution conversation with the selected continuation prompt.
Foreign and sibling conversations are untouched. Never press the product Retry
button and never resend into the failed conversation.

## Continue in the same conversation

After a finished reply is recovered normally:

- when the executor reports or clearly leaves remaining work, send one
  continuation in the **same owned conversation**;
- a generic continuation may be `Доделай задачу`;
- when independent manager verification already knows a concrete gap, prefer
  that concrete gap over making GPT rediscover it;
- every continuation is another tracked turn and therefore receives the same
  shared one-turn mechanics plus the same 27-minute execution checkpoint.

Never create a second execution conversation as a convenience for continuation.
The only post-send fresh-conversation exception is the exact product-error
GitHub-first recovery defined above.

## Multi-turn completion loop

```text
submitted GPT turn
  -> authoritative recovery_required/conversation product cause
       OR 27-minute exact checkpoint proof
       -> inspect live GitHub first
       -> candidate implementation already complete
            -> no replacement implementation chat
            -> manager-owned PR-review convergence
       -> otherwise choose PR / branch / no-work continuation
       -> final exact old-chat + live-head/candidate-state revalidation
       -> if still valid: close exact failed owned chat + one fresh execution chat
       -> if invalidated: no fresh send; ordinary observation/recovery or review entry
  -> finished GPT reply
       -> continue / remaining work
            -> same conversation: "Доделай задачу" or concrete gap
            -> shared one-turn mechanics
            -> execution-only 27-minute checkpoint
            -> repeat
       -> claims complete
            -> manager independently resolves live Issue-bound PR/head and required CI
            -> candidate state not ready: same conversation with concrete gap
            -> candidate state ready: manager-owned PR-review convergence
```

No fixed iteration cap replaces completion evidence. Existing supervisor and
Browser-GPT recovery boundaries still apply.

## Manager-owned PR-review convergence

This is the reusable manager phase for an already-existing implementation PR.
The execute-Issue manager enters it after fresh GitHub reads prove one live
Issue-bound OPEN PR, its exact current head, and current required CI green. A
later standalone PR-review skill may enter at the same boundary without
duplicating this lifecycle.

The manager starts or resumes pack review only through:

```bash
npm run --silent pack-gpt-review -- --pr-number <PR_NUMBER>
```

The existing pack-review runner remains the only review authority. The manager
does not create scheduler `ready_for_review`, WorkerReport/WorkerStatus,
PR/session correlation, a scheduler candidate, or a second review state. It also
does not call the low-level Browser-GPT turn helper three times itself.

For every required logical round:

- use the runner's plural Browser-GPT configuration:
  `PACK_GPT_BROWSER_PROJECT_URL` is present and
  `PACK_GPT_BROWSER_CHAT_URL` is absent;
- the runner launches source slots `source-01..03` as independent fresh
  ChatGPT project chats, with its existing admission spacing and invocation
  identities; the implementation conversation, fixer conversations, and sibling
  reviewer conversations are never reused as reviewer sources;
- reviewer-authored runner-bound GitHub source comments plus canonical runner
  state are the progression authority. The manager observes/consumes them and
  never republishes or paraphrases them into a replacement review authority.

When the canonical result for a logical round contains findings, open exactly
one **fresh GPT fixer conversation for that findings-bearing round**. It must be
different from the implementation conversation and every reviewer conversation.
Keep its prompt authority-driven: provide the live Issue URL, PR URL, and exact
reviewed head, then instruct it to read the live Issue, PR, current CI, and
current pack-review/source comments and fix every applicable finding. Do not
paste a stale findings summary when GitHub is available. One fixer conversation
may continue for concrete CI/fix gaps in that same correction episode. Any
required code/spec correction must advance the PR to a Git strict descendant of
the findings-reviewed head, and current required CI must be green before review
progression. The fixer never merges unless the direct top-level operator
separately orders merge.

Preserve the existing logical-round economics and settlement authority:

```text
T1 -> 1 logical round x 3 GPT sources
T2 -> 1 logical round x 3 GPT sources
T3 -> 2 logical rounds x 3 GPT sources
```

A findings-bearing pre-final round is fixed to a strict descendant before the
next required round. Final-cap findings are fixed to a strict descendant and
settled through the existing scoped reconcile; do not launch a cap+1 round:

```text
node --experimental-strip-types scripts/pack-review-runner.ts reconcile \
  --source-repo-root <path> --repo-slug <owner/repo> \
  --pr-number <PR_NUMBER> --immediate
```

A completed `reviewStageComplete` remains completed. A later independent-smoke
fix does not reopen pack review.

### Review observation and recovery

Normal completion comes from the foreground runner/long-running-child result plus
the authoritative GitHub source-comment census. Lost or unsettled observation
uses the existing Browser-GPT pack-review recovery order, not the execute-Issue
27-minute checkpoint and not a new review timeout:

1. reconcile the exact GitHub source comment for the frozen run/source identity;
2. read persisted state-light observation for that exact invocation;
3. when required, perform the shared runbook's read-only CDP census.

Pass every manager-facing review-runner result through the shared #2078/#2081
manager result boundary before acting on it. A runner-owned `nextAction` may
pass through only when its argv is already read-only and its kind belongs to the
shared closed set. A send-capable or opaque runner action is never copied into a
boundary argv: first run only `execute-review-runner-read-only`, then return to
this runbook, which alone may reach the runner-owned send-capable action after
its existing gates. `review_target_unavailable` or another proven external wall
becomes `external_pause`; non-success with no legal read-only action and no
external evidence becomes boundary-only `contract_defect`. Neither outcome
authorizes manager `worker_done --outcome failed`.

Do not insert `sleep`, `ps` polling, or switch to a neighboring Issue as a
substitute for acting on the current pack-review result. A scrubbed foreign-owner
diagnostic from another conversation creates no manager retry authority by
itself.

An exact owned reviewer turn that is still generating below 15 minutes remains
active and receives no replacement. At or beyond 15 minutes it is only eligible
for the shared bounded recovery/replacement decision; elapsed time alone is
never a clean verdict or resend authority. Follow
`docs/browser-gpt-turn-runbook.md` **Pack-review same-round replacement
observation** exactly.

### Settled-review manager handoff

After required review obligations settle, the manager performs fresh exact-state
reads and completes its own role through the existing manager -> supervisor
Task/Dispatch handoff. The handoff carries at least:

- Issue number and URL;
- PR number and URL;
- exact current head;
- current required-CI state;
- pack-review cycle/stage completion and relevant runner id/result when present;
- confirmation that no current material review finding remains open under the
  existing authority;
- next legal action: **launch local independent-smoke worker**.

This is not a new durable terminal state. Manager whole-role completion ends only
the manager role; the parent execute-Issue workflow remains alive. The manager
does not run independent smoke itself.

The supervisor then follows `docs/orchestration-runbook.md`: launch or reuse the
existing supervised local worker as the independent-smoke parent for the exact
handed-off PR/head. That worker prepares current prerequisites and invokes the
existing `worker-smoke-run ... --smoke-actor independent` path. A smoke finding
is fixed by that local worker on a new head and followed by fresh independent
smoke; settled pack review does not reopen. Overall `VERIFIED_COMPLETE` is
possible only after independent smoke passes on the final exact head and the
fresh final verification below succeeds.

## Independent GitHub Definition-of-Done verification

The manager uses fresh reads from this same evidence set to establish review
entry and the settled-review handoff, but manager-role completion is not overall
completion. Before the **top-level workflow** returns `VERIFIED_COMPLETE`,
perform a fresh current-state check under the live Issue and
`docs/chat-executor-rules.md`. For a manager-controlled Browser-GPT
implementation, this check occurs only after the supervisor-owned local
independent smoke has passed on the final exact head. Where applicable, verify
at least:

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

Before the manager's settled-review handoff, a concrete implementation or fixer
gap returns to the owning implementation/fixer conversation as defined above.
After the handoff, independent-smoke findings belong to the supervisor-launched
local worker: that worker fixes to a new head and runs fresh independent smoke;
the completed pack-review stage does not reopen. A red required CI check,
missing scoped file, unresolved material review finding, stale exact-head smoke,
or another live Issue acceptance gap remains non-completion evidence. If an
implementation conversation ended with one of the two exact product-error
proofs, use the GitHub-first fresh-chat recovery above instead of sending into
that failed chat.

## Recovery handoff to the supervisor

The #2078/#2081 shared manager result boundary is the only result classifier.
Do not create another blocker/result state machine, ledger, retry engine, store,
daemon, registry, or supervisor recovery subsystem.

When the manager reaches a repository-owned bookkeeping/observation condition
or another condition it cannot legally repair within its execution scope, pass
the manager-facing producer result through
`scripts/execute-issue-manager-boundary.ts`. On `recoverable`, execute only
the returned read-only observation/reconciliation prerequisite and then resume
the owning runbook. On `external_pause` or `contract_defect`, use the existing
#2078 escalation/non-terminal pause mechanics. A boundary outcome never becomes
manager `worker_done --outcome failed` and never grants replacement-send
authority.

Then return through the existing Task/Dispatch/manager handoff with:

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

Use only after the fresh Definition-of-Done verification passes. For the
manager-controlled Browser-GPT implementation path, this additionally requires
settled canonical pack review and supervisor-owned local independent-smoke PASS
for the final exact head. A manager handoff, implementation-chat completion,
reviewer-chat completion, or `reviewStageComplete` without that final smoke is
not sufficient. This is the normal top-level terminal outcome.

### `OPERATOR_ACTION_REQUIRED`

Use only after legal recovery is exhausted and the remaining obstacle is a
genuine external permission/capability requirement, impossibility, unresolved
target ambiguity, or the possible-send active-turn identity gap for which the
shared Browser-GPT authority forbids guessing. The supervisor-visible name and
trigger meaning stay unchanged, but its manager-side effect is the #2078
escalation with `resume_when: { operator: true }`; the parent Task and manager
Dispatch remain non-terminal, and the manager does not emit
`worker_done --outcome failed`.

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

The execution checkpoint reuses the existing 27-minute workflow checkpoint and
the diagnostic `browser-gpt-page-probe inspect` observation surface. The probe's
product-cause projection is bounded, normalized, and authority-free; manager
logic must combine it with exact owned-turn/reply/generation evidence and the
GitHub-first/final-revalidation gates above.

If real implementation requires a new persistent cross-process ownership or
recovery guarantee, new generic Browser-GPT resend authority, or another
stronger subsystem guarantee, stop before widening this workflow and return to
the live Issue/tier authority.
