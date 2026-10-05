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
npm run --silent flow-manager-browser-gpt-long-run --   --run-identity <run>   --attempt-identity <attempt>   --handoff-receipt <path>   --invocation-id <id>   --terminal-envelope <path-ending-in-terminal.json>   --output <path>   --profile <profile>   --cdp <url>   --input <prompt-file>   --cwd <worktree>   [--project-url <url> --new-chat | --chat-url <url>]
```

The adapter returns after launcher handoff is proven; that is not proof of a
model reply or workflow-level completion.

## Observe and settle

The authoritative transport result is one `turn-result/v1`. The long-running
child projects it into its terminal envelope and records delivery as
`not-sent`, `POSSIBLY_DELIVERED`, or `landed`.

- Proven pre-send failure with `send_count: 0` may be retried only when the
  calling workflow already authorizes retry.
- Possible/proven delivery forbids a blind resend.
- Timeout, child exit, missing envelope, or absent output does not prove no send.
- Recovered reply bytes belong to the same invocation/conversation.

### Non-success observation gate

Read exact state/cause, send count, owned conversation identity, and current
page/browser liveness before the owning workflow chooses a next action.
Product/login/quota/network walls are evidence, not send authority.

### Same-invocation recovery

When delivery may have happened: retain invocation/conversation identity,
re-observe the owned conversation, harvest only an attributable reply, and
publish output once. If attribution remains uncertain, report uncertainty and
preserve no-resend semantics.

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
