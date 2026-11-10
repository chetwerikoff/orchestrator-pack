# Browser-GPT turn runbook

This is the shared transport/recovery authority for one tracked Browser-GPT
turn. It is workflow-neutral: Issue authoring, execute-Issue, pack-review, and
other callers keep their own substantive lifecycle and acceptance authority.

## Local-only configuration

Use operator-provided ChatGPT project/profile/CDP configuration. Never copy
cookies, browser profiles, credentials, or session state into a worktree or
tracked file.

## Start-of-shift preflight

1. Enter a trusted current checkout and read the live `AGENTS.md` and
   `docs/chat-executor-rules.md`.
2. Verify the repository's declared Node-runtime requirement and the exact task/turn
   identities supplied by the owning workflow. For governed create-Issue
   reviewer turns, this includes the current tier, role, stage, source slot,
   and frozen revision. A workflow that does not define create-review
   `stage`, `slot`, or frozen revision must not invent values for them.
   When this shift is the next turn of an already-admitted manager workflow,
   the owning workflow must also supply that exact Run/Task context and the
   exact caller-held manager worktree selector. Before Browser-GPT reads new
   tracked turn inputs, apply the same manager refresh boundary owned by the
   supervised Task launch assistant: resolve the selector through Orca, prove
   repository/path identity with only bounded read-only git queries, fetch
   `origin/main`, then require already-equal or a clean ancestor-only
   fast-forward on the distinct manager-local branch. For a manager-bound
   create-Issue shift, a repository-owned mismatch returns
   `recoverable(reconcile-stage-read-only)`; external reality returns
   `external_pause`; malformed producer output is a boundary
   `contract_defect`. A generic Browser-GPT shift without this manager
   binding emits no manager-refresh git command, and an already-running turn or
   frozen create-Issue stage attempt is never refreshed mid-turn.
3. Select the target project card for this invocation with `--project
   <PROJECT_ID>` when the owning caller supports that option, or set
   `OPK_PROJECT_ID` for the invocation. The selected card supplies the
   Browser-GPT project URL; do not set a separate URL in environment or
   local configuration. Resolve other Browser-GPT configuration without
   copying operator files into the worktree. A governed create-Issue send may
   pass `--operator-browser-config <absolute-path>`; the inline
   send-boundary preflight reads that exact operator-local file in place.
   For a governed create-Issue caller, a legal retry is
   `recoverable(retry-create-issue-browser-preflight)`; operator-owned
   configuration that must change outside the repository is an
   `external_pause` with the exact remedy/evidence, never a terminal manager
   refusal.
4. Confirm the configured headed automation Chrome is running and logged in.
   Never type credentials. Create-Issue callers do not run a separate mandatory
   preflight command: the declared Node runtime, tracked GitHub transport and Browser-GPT
   configuration are revalidated inline before the first launcher/browser/send
   side effect.
5. Start or verify the configured browser through the existing launcher:
   `.claude/skills/discuss-with-gpt/launch-chrome.sh`. Select the applicable
   canonical workflow; stage cardinality and topology belong to that workflow,
   not this runbook.

## Prepare one turn

Each turn has one input snapshot, one invocation id, one destination output,
and either `--new-chat --project-url <url>` or `--chat-url <url>`.

Do not pass workflow-specific review-stage, slot, acceptance, or publication
authority through transport. Prompt content carries the substantive role/task.

## Launch

Normal manager adapter:

```text
npm run --silent flow-manager-browser-gpt-long-run --   --run-identity <run>   --attempt-identity <attempt>   --owner-task-id <approved-task>   --owner-dispatch-id <approved-dispatch>   --handoff-receipt <path>   --invocation-id <id>   --terminal-envelope <path-ending-in-terminal.json>   --output <path>   --profile <profile>   --cdp <url>   --input <prompt-file>   --cwd <worktree>   [--bound-issue <owner/repo>#<number>]   [--project-url <url> --new-chat | --chat-url <url>]
```

`--bound-issue` names the managed Issue target that the upstream Task/Dispatch
is bound to (Issue authors and reviewers). Its repository must be the selected
project card repository. It only lets the driver record a pre-SEND Issue body
digest for later task-progress reconciliation; never derive it from the prompt,
URL or GitHub activity. It cannot be combined with `--repo`/`--pr`.

PR-author-only variant (a PR author whose turn may push to an existing OPEN PR;
Issue authors and reviewers keep the normal command above):

```text
npm run --silent flow-manager-browser-gpt-long-run --   --run-identity <run>   --attempt-identity <attempt>   --owner-task-id <approved-task>   --owner-dispatch-id <approved-dispatch>   --handoff-receipt <path>   --invocation-id <id>   --terminal-envelope <path-ending-in-terminal.json>   --output <path>   --profile <profile>   --cdp <url>   --input <prompt-file>   --cwd <worktree>   --repo <owner/repo> --pr <number>   [--project-url <url> --new-chat | --chat-url <url>]
```

`--repo` and `--pr` are one pair: pass both or neither. With the pair, the
explicit `--cwd <worktree>` branch must be the head ref of the OPEN PR in the
selected project card repository. A second author of the same PR is refused
with `conversation_busy` / `pr_author_occupied` and nothing is sent; retry only
after that turn ends. When the PR head changes during the turn, the result is
`ok` with `cause: author_effect_pr_head_changed` and no `--output` reply:
inspect the PR. The original tab is never Stopped; it settles for at most 10
minutes (never past the turn deadline) and then takes the usual guarded close,
or stays open with `cleanup_unconfirmed` if it is still busy or not provably
its own. The result is published after that settle. One project card per
repository is assumed; a SEND by an orphaned child after its turn deadline is
a named residual, not prevented.

A `conversation_busy` / `conversation_incident_active` record whose exact
producer PID has exited releases only its conversation custody, and only when
the next turn's read-only view of that conversation Page is positively idle
(not generating, last reply finished). The incident, its output identity and
its possible delivery stay recorded: the original output still refuses with
`destination_bound_to_unresolved_delivery`. A live, ownerless, generating or
unreadable holder keeps blocking. Release grants no resend.

The adapter returns after launcher handoff is proven; that is not proof of a
model reply or workflow-level completion.

Managed launches require both `--owner-task-id` and `--owner-dispatch-id`.
Durable artifacts (terminal envelope, original handoff receipt, receipt locator)
live under `$XDG_STATE_HOME/orchestrator-pack/`, or
`~/.local/state/orchestrator-pack/` when XDG is unset; a caller-supplied
`--handoff-receipt`/`--terminal-envelope` path contributes only its basename
(the terminal name still ends in `terminal.json`), and accepted/v1 returns the
resolved paths. `--predecessor-invocation-id` and `--predecessor-attempt-identity`
take only the earlier invocation and attempt: the launcher reads that
predecessor's original Run/Task/Dispatch from its own durable locator, and a
settled `ok`/landed predecessor is a no-op that never admits the new Send.
A one-sided pair is `predecessor_invocation_and_attempt_required`; naming this
invocation as its own predecessor is `predecessor_self_invocation_forbidden`.
Genuinely independent new work omits both flags. A verified predecessor whose
old Page only failed post-identity cleanup (`cleanup_unconfirmed`) keeps that
Page untouched and allows the separately admitted fresh Page; an absent,
foreign or unproven predecessor identity, terminal, Send/phase proof or
created-target ownership is `predecessor_handoff_unproven`: reconcile it
read-only. `--profile <profile>` must be an absolute user-data directory (POSIX, WSL
`/mnt/<drive>/...`, Windows `C:\...`/`C:/...`, or a Windows `\\server\share`
path on Windows); a relative, drive-relative or unsupported UNC value is
refused with `profile_absolute_user_data_dir_required` before any state is
allocated. Refusals print an exact code and `nextStep`. After the launcher may have
started, a refusal names only the adapter's own code and marks physical SEND
unknown: reconcile the original invocation, never resend. Details:
[flow-manager runbook](flow-manager-long-running-child-runbook.md).

## Observe and settle

The authoritative transport result is one `turn-result/v1`. The long-running
child projects it into its terminal envelope and records delivery as
`not-sent`, `POSSIBLY_DELIVERED`, or `landed`.

- Proven pre-send failure with `send_count: 0` may be retried only when the
  calling workflow already authorizes retry.
- Possible/proven delivery forbids a blind resend.
- Timeout, child exit, missing envelope, or absent output does not prove no send.
- Recovered reply bytes belong to the same invocation/conversation.
- `ok` with `send_count: 0` or `author_effect_pr_head_changed` and no owned
  Send witness stays `POSSIBLY_DELIVERED`; GitHub movement never makes it
  `landed`.
- When the original receipt carries a pre-SEND baseline, the terminal adds
  `diagnostics.github_effect` (`target_progress_observed` or
  `effect_unverified`, attribution always `unverified`). Progress needs the
  same still-OPEN target with unchanged base/head repository and ref, read
  twice coherently. It never changes incident, exit or delivery.

### Non-success observation gate

Read exact state/cause, send count, owned conversation identity, and current
page/browser liveness before the owning workflow chooses a next action.
Product/login/quota/network walls are evidence, not send authority.
A busy current Page (`stop_visible`, `generation_in_progress`,
`continue_generating_visible`, `unreadable` or `contradictory`) is
`conversation_busy` with nothing sent; a historic harvest never overrules it.
The manager pauses a still-generating inspect and names the next exact-original
read-only inspect for the next existing wake; it emits no immediate argv.

### Same-invocation recovery

When delivery may have happened, retain the original invocation/conversation
identity, re-observe that Page when possible, harvest only an attributable reply,
and publish output once. A redirect away from the bound conversation is
`cause: conversation_unavailable`, not a new Send license. Transport delivery
remains `POSSIBLY_DELIVERED` when unproven; a repository effect can settle the
**workflow** without falsely changing the transport envelope to `landed`.

#### GitHub effect read and adoption (Issue #2827)

On **every existing owner wake**, the still-current Task+Dispatch owner first
reads the original launcher start timestamp from its authoritative handoff and
performs a fresh GitHub effect read for the selected project repository and
bound Issue N. Read the effect, not just `issue view N` or the originally
bound PR. Include all pages of the relevant GitHub listings:

- **Executor:** list the repository's open PRs explicitly linked to Issue N,
  including their creation timestamps and heads, **and** published branches
  explicitly tied to Issue N with evidence that they appeared since the original
  launcher start. A PR whose `createdAt` is later than that start is a possible
  turn effect. A branch requires both an Issue-N ownership witness and a
  post-start creation/first-publication witness (for example, an owned
  pre-launch branch absence snapshot plus its now-published head); a matching
  branch name or recent commit alone does not prove branch creation. Compare
  any retained pre-send baseline; do not guess absent timestamps or authorship.
- **Issue author:** read current Issue body and the post-launch Issue edit
  timeline or equivalent original pre-SEND body baseline and timestamped edit
  evidence, plus newly created Issue comments. A body revision or comment
  after launcher start is a possible effect; `updatedAt` alone (which can
  change for unrelated reasons) is not evidence of a body revision.

If the post-start effect exists, **adopt the observed current PR/branch,
Issue body revision or comment as the workflow's delivered outcome**, do not
send a new turn, and continue the existing Issue/PR author or executor lifecycle.
A found effect takes precedence over launcher/Page uncertainty. Do not infer
which model invocation authored a GitHub write or upgrade the original transport
status. An ambiguous or incomplete effect read is not proof of no effect and
does not grant a new Send.

For **every executor-manager wake**, regardless of turn outcome, list **all
open Issue-N-linked PRs** (not merely the one previously known). Resolve any
effect/adoption first. If more than one is open, keep the already-adopted **open**
PR; otherwise keep the earliest-created PR (tie-break by smaller PR number).
For each other PR, publish a comment naming the Issue and the kept PR, **then
close that duplicate PR**, and read back its closed state. Never delete the
duplicate PR's branch. If the list or Issue linkage is ambiguous, reconcile
GitHub first instead of closing a guessed PR. This is manager wake work, not a
new watcher or a second PR-selection service.

#### One bounded fresh turn after a missing effect

If the full GitHub effect read finds no post-start effect, reconcile the
original launcher and the original **identity-bound** Page. A live/unproven
launcher or a Page still generating, unreadable, contradictory, or otherwise
possibly busy keeps the original turn pinned: observe or recover it, **no
blind resend**. Merely failing to attach to CDP is not proof of idle Page.
A positively unavailable original Page means its **exact owned target** is
confirmed absent; it does not mean a generic probe error.

Only **after the original turn deadline**, with the launcher **positively
dead**, the original Page **positively idle or unavailable**, a complete
negative GitHub-effect read, and the **same exact Task+Dispatch owner**, admit
**exactly one** fresh ordinary `--new-chat` turn. It is a newly stated,
genuinely distinct continuation intent with fresh invocation, attempt, output
and conversation identities, not a resend of the earlier prompt. Give it the
live Issue plus the adopted PR/head, proven Issue-owned branch/head or truthful
no-work baseline required by the execution workflow. Do not require an
architect/operator decision for this specific recovery case. Revalidate
GitHub effects and Page/launcher conditions just before the new Send.

Count this admission against the **original uncertain turn** using the
existing owned-turn/handoff history. On later wakes, reconcile that successor
rather than admitting another fresh turn for the same original incident; no
new ledger, retry service or persistence format is introduced. If any condition
is unknown, keep read-only recovery of the incumbent with no new Send. A
post-deadline orphaned server-side Send is a residual possibility, not evidence
that cancellation happened.

The following ordered manager decision table is the fixture-testable
projection of those rules. Predicates are derived from the reads above; in
particular `no_effects_verified` is false on a failed/partial GitHub read,
`launcher_positively_dead` requires positive original-launcher evidence,
`page_generating_or_unproven` includes an unreadable/uncertain Page, and
`page_idle_or_unavailable` requires affirmative exact-owned evidence.
First matching row wins; `otherwise` is the final fallback.

| Predicate | Action |
| --- | --- |
| `effect_found` | `adopt_existing_no_send` |
| `!no_effects_verified` | `reconcile_original_no_send` |
| `!launcher_positively_dead` | `observe_original_no_send` |
| `page_generating_or_unproven` | `observe_original_no_send` |
| `!deadline_passed` | `observe_original_no_send` |
| `!same_task_dispatch_owner` | `reconcile_original_no_send` |
| `fresh_turn_already_admitted` | `reconcile_successor_no_send` |
| `page_idle_or_unavailable` | `admit_one_fresh_new_chat` |
| `otherwise` | `reconcile_original_no_send` |

The owner-run `wait` may still publish one uncertainty envelope only after
the original launcher is positively dead and only for its approved original
Task+Dispatch. It never signals a live launcher. The manager does not use
this table to alter Browser-GPT transport status or the original Page's
guarded tab-lifecycle authority.

### Diagnostic recurrence journal

Transport incident/observation records are diagnostic evidence only. They are
not task acceptance, review authority, or a retry budget.

## Publication and tab lifecycle

Successful state-light completion atomically publishes the harvested assistant
reply. Publication conflict is a transport failure; do not overwrite conflicting
output. Post-send non-success pages remain available for recovery; close only
resources with proven ownership and never close sibling tabs as collateral.

## Incident handling

Keep the smallest truthful state: exact invocation/profile/conversation identity
when known, delivery status, observed state/cause, and any legal same-invocation
observation action. Never synthesize success from liveness, spinner state,
timeout, or another workflow's artifact.

## One-shot diagnosis

The page probe is read-only diagnostic evidence. It may inspect the exact owned
conversation, but never sends, retries, changes workflow state, or grants
acceptance authority.

## Shift handoff/close

Handoff exact invocation/profile/project identity, owned conversation URL when
known, current transport result/uncertainty, and output/envelope paths. Continue
the same invocation when recovery remains legal. Workflow completion is decided
by the calling workflow.

The explicit `cancel` command in `scripts/chatgpt-browser-turn/state-light-entry.ts`
uses `state-light-cancellation.ts`, which can return
`cancellation_owned_tab_and_generation_unproven` as non-success without
confirming Stop. A URL, prompt marker, receipt, PID, closed local process or
disappearing Stop control does not prove the original tab/active generation or
revoke an already-issued GitHub connector write. Launcher handoff is not author
completion. Author/disposition decisions and reconciliation of *landed* Issue
writes belong to the
[create-Issue owner](../.cursor/skills/create-issue-draft/SKILL.md#possibly-sent-authordisposition-turns-at-owner-controlled-handoff),
not this transport runbook.

## Universal author prompt template

Copy this prompt and substitute placeholders. Browser GPT sees only this chat and GitHub; never pass a local path (`~/.local/state/**`, `/tmp/**`, a worktree) as input — paste the content or give a GitHub link:

```text
Role: author for <REPOSITORY>.
You write the Issue; you are not the manager.
Use the GitHub plugin (connector) for every read and write of {REPOSITORY}; it is connected with push access. Call it before you say it is unavailable. You have no shell, test runner or database: never claim you ran them.
Mode: <brief-only-create|revise-existing-issue>.
Authoritative input for brief-only-create (paste binding sections, or the whole brief with background sections marked):
<BRIEF_TEXT>
[paste actual brief content here]
</BRIEF_TEXT>
For revise-existing-issue, authoritative input is live Issue <ISSUE_URL>; expected revision: <EXPECTED_REVISION>.

Read the live target through GitHub when an Issue exists. Follow the canonical
create-issue-draft procedure and current tier, floor, and scope rules.
For brief-only-create, author from the supplied brief. For revise-existing-issue,
preserve the source revision marker and increment it for a substantive body
revision. Apply these requirements: <AUTHORING_REQUIREMENTS>.

Only mutate the target Issue title/body. Do not create a PR, label, milestone,
merge, or unrelated GitHub authority. Re-read the final body for consistency.
After a successful mutation return only this receipt, at most 15 lines:
Issue URL/number, revision marker, and changed sections.
Use the existing audited genuine-write-failure fallback only when the direct
GitHub mutation actually fails.
Never include or fabricate an OPKTURNV1... transport marker; the tracked
transport owns marker insertion.
```

## Maintenance matrix

Shared implementation owners:

- `scripts/chatgpt-browser-turn/state-light-entry.ts` — turn/session entry;
- `scripts/chatgpt-browser-turn/state-light-turn.ts` and `state-light-*` — send,
  observation, recovery, output;
- `scripts/flow-manager-long-running-child.ts` — child survival/envelope;
- `scripts/flow-manager-browser-gpt-long-run.ts` — ordinary manager adapter;
- `scripts/browser-gpt-page-probe.ts` — read-only diagnostic probe.

Workflow-specific review stages, dispositions, labels, PR readiness, and merge
authority stay outside these transport owners.
