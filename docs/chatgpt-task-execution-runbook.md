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
owning Browser-GPT contract positively proves that no prior send/session must
be preserved and independently authorizes that send. The narrow post-send
exception owned by this runbook is execute-Issue product-error recovery: after
GitHub-first reconciliation, it first attempts one tracked continuation in the
same exact owned conversation. That episode is available only for
`message_delivery_timed_out`, `product_network_error`, or `message_stream_error`
after exact owned-turn proof.
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

The three execute-Issue product errors stay on the existing `turn-result/v1`
contract. An authoritative exact-owned result of this form:

```text
state: recovery_required
scope: conversation
cause: message_delivery_timed_out | product_network_error | message_stream_error
```

is terminal evidence for that Browser-GPT turn and enters **Product-error
recovery (GitHub-first)** immediately. It does not create a new TurnState, retry
contract, exit-code contract, or record version. A transport-only
`stream_timeout`, `no_reply`, helper timeout, browser loss, missing envelope, or
process exit is not equivalent evidence and grants no continuation or fresh-chat
authority.

`message_stream_error` is the existing classifier's exact mapping for the
rendered literal `Error in message stream`; the same structural/ownership gates
and stable two-read confirmation apply.

## Mandatory 27-minute live-chat checkpoint

At the existing 27-minute checkpoint, use `browser-gpt-page-probe inspect` only
as observation: its normalized `execution_recovery_cause` must be combined with
exact owned-turn, reply, and generation evidence before it can authorize that
same recovery branch. Elapsed time, missing output, helper silence,
`stream_timeout`, or `no_reply` alone never authorizes a replacement
conversation.

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
it is a new process. It follows the recovery branch and shared Browser-GPT
evidence requirements. A product-error continuation is a new tracked user turn
after the prior product-error turn has authoritatively settled; it is not the
product Retry control and does not alter the prior invocation. Before any fresh
chat fallback, the exact continuation invocation must also be settled/recovered
under the existing Browser-GPT lifecycle and the final chat/GitHub checks below
must still permit fallback. If any required identity or settlement evidence is
unavailable, fail closed without a fresh chat.

This section owns the 27-minute live-chat checkpoint and the one additional
execution timing rule: a 10-minute minimum grace after a confirmed product-error
continuation send. Neither is a universal Browser-GPT timeout; do not add a
second monitor, watcher, daemon, polling loop, durable timer, or recovery store.

For every submitted execution turn:

1. start normal observation under the shared Browser-GPT turn/long-running
   contract;
2. when an authoritative completed turn result arrives before 27 minutes,
   process it normally; an exact-owned `recovery_required` result with one of
   the three reserved product causes enters the GitHub-first recovery section immediately;
3. when 27 minutes elapse after submission without an authoritative completed
   turn result, perform a **fresh identity-bound observation of the actual owned
   ChatGPT conversation** with the caller-retained binding:

   ```text
   browser-gpt-page-probe inspect
     --cdp <exact retained endpoint>
     --profile <exact retained configured profile>
     --invocation-id <exact retained invocation id>
     (--url <exact owned conversation url> | --target-id <exact owned target id>)
   ```

   The probe derives the configured profile key, reads only the exact
   `state-light-turn-observation/v1` record for that invocation, applies its
   durable phase before marker projection, and never falls back to another
   record/profile or a page-wide marker choice;
4. treat expiry or loss of a bounded observer/wait slice as observation loss
   only. It does not settle the turn. Preserve the exact run identity, attempt
   identity, invocation id, profile, CDP endpoint, and conversation binding for
   continued observation;
5. do not use `--open-if-missing`, create a page, close a page, navigate, Retry,
   resend, or invent a replacement target for this checkpoint; the probe is
   diagnostic/observation-only and its envelope keeps `workflow_authority:
   none`;
6. if the identity-bound checkpoint reports the exact owned turn still
   generating with no supported cause, send zero new user messages and continue
   bounded observation/re-observation of that same invocation. The first
   post-checkpoint continuation starts one recovery-observation episode whose
   total automatic-continuation ceiling is the existing
   `DEFAULT_TIMEOUT_MS = 1_800_000 ms`; every later slice consumes the same
   remaining budget and cannot reset or extend it;
7. if that single post-checkpoint budget is exhausted while the exact turn is
   still unsettled/generating, stop automatic re-observation and hand the exact
   fail-closed condition to the existing supervisor boundary. Exhaustion grants
   no resend, replacement invocation, or fresh-chat authority;
8. consume the probe's bounded normalized `execution_recovery_cause` only in
   combination with exact current-turn evidence: the exact execute-Issue owned
   prompt is the current prompt, no completed attributable assistant reply is
   present, and generation is positively not active. Do not decide completion
   or replacement authority from helper/launcher PID, shell state, heartbeat,
   elapsed time, missing output, log silence, terminal-envelope absence, or the
   product-cause projection by itself.

The probe's `execution_recovery_cause` is derived from the same Browser-GPT
product-state helper used by the immediate state-light path. That classifier owns
the exact `Error in message stream` -> `message_stream_error` mapping; the manager
does not add another regex or copy of the product messages.

Interpret the checkpoint evidence only through this mapping:

- **Reserved product cause + exact owned current prompt + no attributable
  completed reply + no active generation:** enter **Product-error recovery
  (GitHub-first)** below.
- **Generation active:** send zero new user messages and continue observation of
  the same invocation inside the one post-checkpoint recovery-observation
  episode; later bounded slices consume its remaining `1_800_000 ms` budget
  rather than starting a new checkpoint or resetting that ceiling.
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

Enter this section only after one of these proofs for the exact owned turn:

1. an authoritative immediate `turn-result/v1` reports `state:
   recovery_required`, `scope: conversation`, and cause
   `message_delivery_timed_out`, `product_network_error`, or
   `message_stream_error`; or
2. the mandatory 27-minute checkpoint independently observes one of those three
   product causes **and** the manager also has exact current owned-prompt proof,
   no attributable completed reply, and no active generation.

Generic helper timeout, launcher timeout, `stream_timeout`, `no_reply`, browser
loss, missing output/envelope, process death, page ambiguity, or elapsed 27
minutes by itself **never** enters this section.

After exact product-error proof, perform a fresh live GitHub reconciliation for
the exact Issue before sending any continuation:

1. resolve an existing Issue-bound PR first and record its exact current head;
2. only when no such PR exists, resolve one unambiguous Issue-bound task branch
   and its current commits/head; a coincidental branch name or recent commit is
   not enough;
3. if neither exists, record **No observed Issue-bound work**: no Issue-bound PR
   or unambiguous Issue-owned branch exists; this is an observed absence, not a
   synthetic head;
4. reuse the existing independent Definition-of-Done verification path against
   that current repository/GitHub state; do not create a second DoD classifier;
5. if PR/branch ownership is ambiguous, fail closed and resolve that ambiguity;
   do not send a continuation or open a fresh execution chat.

If current state already establishes a candidate-complete implementation, do
**not** send `Доделай задачу` and do not open an implementation conversation.
Resolve the exact live Issue-bound PR/head and required CI state; when the
review-entry preconditions below are satisfied, enter **Manager-owned PR-review
convergence**. This manager path does not return overall `VERIFIED_COMPLETE`
before the later supervisor-owned independent smoke.

### Same-conversation continuation first

Otherwise save the exact selected baseline and send exactly one ordinary tracked
continuation user turn in the **same exact owned ChatGPT conversation**:

- **Existing PR:** concrete known gap, or `Доделай задачу` with the Issue URL, PR
  URL, and exact baseline head as needed to continue that same implementation;
- **No PR, one unambiguous Issue-owned branch:** concrete known gap, or
  `Доделай задачу` tied to the Issue, same branch, and exact baseline head;
- **No observed Issue-bound work:** `Доделай задачу` (or a concrete known gap)
  in the same conversation; do not synthesize a branch/head.

This is a new tracked user turn after the exact product-error turn is settled,
not a retry of that turn. Never press the product `Retry` control. Reuse the
existing Browser-GPT existing-conversation send, attribution, observation, and
settlement path; add no second transport or generic resend authority.

If the continuation shows positive progress—active generation, an attributable
completed assistant reply, advancement of the same PR/branch head, or creation
of a valid Issue-bound PR/branch from a no-work baseline—keep the same
conversation authoritative and continue the ordinary multi-turn flow. A
candidate-complete repository state still short-circuits into review
convergence.

### Minimum no-progress grace and fallback

After the continuation send is authoritatively confirmed, observe that exact
continuation in the same conversation for a minimum **10-minute grace window**.
An immediately unchanged GitHub read is insufficient: repository effects may
lag the turn by several minutes. During the window, any positive chat or
repository progress above suppresses this recovery episode's no-progress
fallback; continue the normal observation and consume any completed reply.

The 10-minute grace is not turn-settlement, cancellation, close, navigation, or
replacement-send authority. If the continuation is still unsettled when the
window expires, open no fresh chat and close no tab; continue the existing
same-invocation observation/recovery path or use its existing supervisor
boundary. The exact continuation invocation must be authoritatively
settled/recovered under the shared Browser-GPT lifecycle before fallback can be
considered. A repeated supported product error on that exact continuation does
not bypass the full grace; its authoritative terminal result may satisfy
settlement only after the grace and final checks.

At or after the full grace, perform fresh final reads of both the exact owned
conversation and live repository state. A no-progress fallback is permitted
only if the exact continuation invocation is settled/recovered, no active
generation or attributable completed reply or other chat progress exists, and
the saved repository baseline is unchanged:

- **Existing PR:** same Issue-bound PR and same head;
- **No PR, one Issue-owned branch:** same branch and same head;
- **No observed Issue-bound work:** still no Issue-bound PR or unambiguous
  Issue-owned branch.

If the baseline advanced, Issue-bound work appeared, ownership became
ambiguous, or implementation is candidate-complete, do not send a prepared
fallback. Return to same-conversation observation/current-state evaluation or
enter review convergence when its preconditions hold.

Only after all fallback gates pass may the manager open exactly one fresh
execution conversation:

- **Existing PR:** Issue URL + same PR URL + exact unchanged baseline head;
  instruct GPT to continue that implementation.
- **No PR, one Issue-owned branch:** Issue URL + same branch + exact unchanged
  head; instruct GPT to continue that implementation.
- **No observed Issue-bound work:** Issue URL + existing ordinary initial prompt
  `выполни задачу`; create no synthetic repository identity.

Do not create a replacement branch or PR merely because the conversation
changed. Under existing tab-lifecycle authority, close only the exact old owned
conversation after fallback is authorized and the continuation is settled;
never close foreign/sibling conversations. Closing a tab is cleanup, not proof
of repository or server-side state.

## Multi-turn completion loop

```text
submitted GPT turn
  -> authoritative recovery_required/conversation product cause
       OR 27-minute exact checkpoint proof
       -> inspect live GitHub first and save PR/head, branch/head, or no-work baseline
       -> candidate implementation already complete
            -> no implementation continuation chat
            -> manager-owned PR-review convergence
       -> otherwise send one tracked continuation in same exact owned conversation
       -> positive chat/repository progress: stay in same conversation
       -> confirmed send: observe same continuation for at least 10 minutes
       -> unsettled at grace expiry: no fresh chat; continue existing settlement/recovery
       -> settled, no progress, full grace, unchanged baseline
            -> final current-state checks
            -> one fresh chat preserving same PR/branch, or Issue-only no-work prompt
            -> close only exact old owned conversation under tab-lifecycle authority
       -> invalidated baseline/candidate-complete: no stale fresh send; re-evaluate/review
  -> finished GPT reply
       -> continue / remaining work in same conversation
       -> claims complete: independently verify live Issue-bound PR/head and CI
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

When the canonical runner returns a runner-owned `nextAction`, execute that
action promptly within the runner's own bound. Do not insert `sleep`, `ps`
polling, or switch to a neighboring Issue as a substitute for acting on the
current pack-review result. A scrubbed foreign-owner diagnostic from another
conversation creates no manager retry authority by itself. When the runner
returns no legal `nextAction`, preserve its existing terminal/no-resend result
instead of inventing one.

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
implementation conversation ended with one of the three exact product-error
proofs, use the GitHub-first same-conversation continuation and settled,
identity-preserving fresh-chat fallback above.

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

The execution checkpoint reuses the existing 27-minute workflow checkpoint and
the diagnostic `browser-gpt-page-probe inspect` observation surface. The probe's
product-cause projection is bounded, normalized, and authority-free; manager
logic must combine it with exact owned-turn/reply/generation evidence and the
GitHub-first/final-revalidation gates above.

If real implementation requires a new persistent cross-process ownership or
recovery guarantee, new generic Browser-GPT resend authority, or another
stronger subsystem guarantee, stop before widening this workflow and return to
the live Issue/tier authority.
