# Browser-GPT turn runbook

This is the shared transport/recovery authority for one tracked Browser-GPT
turn. It is workflow-neutral: Issue authoring, execute-Issue, pack-review, and
other callers keep their own substantive lifecycle and acceptance authority.

## Local-only configuration

Use operator-provided ChatGPT project/profile/CDP configuration. Never copy
cookies, browser profiles, credentials, or session state into a worktree or
tracked file.

## Start-of-shift preflight

Before a send-capable turn:

1. run from the trusted pack checkout with the intended worktree as `--cwd`;
2. use the tracked Node 22 entrypoint and current Browser-GPT scripts;
3. prove the intended browser profile/CDP endpoint is reachable;
4. resolve the intended ChatGPT project card/URL when a fresh project chat is required;
5. prepare stable input bytes and one invocation id;
6. ensure output/launcher-owned artifact paths are distinct and unoccupied.

A failed preflight performs no send. Do not repair credentials, solve CAPTCHA,
or silently substitute another profile/project.

## Prepare one turn

Each turn has one input snapshot, one invocation id, one destination output,
and either `--new-chat --project-url <url>` or `--chat-url <url>`.

Do not pass workflow-specific review-stage, slot, acceptance, or publication
authority through transport. Prompt content carries the substantive role/task.

## Launch

Normal manager adapter:

```text
npm run --silent flow-manager-browser-gpt-long-run --   --run-identity <run>   --attempt-identity <attempt>   --handoff-receipt <path>   --invocation-id <id>   --terminal-envelope <path>   --output <path>   --profile <profile>   --cdp <url>   --input <prompt-file>   --cwd <worktree>   [--project-url <url> --new-chat | --chat-url <url>]
```

The adapter returns after launcher handoff is proven; that is not proof of a
model reply or workflow-level completion.

## Observe and settle

The authoritative transport result is one `turn-result/v1`. The long-running
child projects it into its terminal envelope and records delivery as
`not-sent`, `POSSIBLY_DELIVERED`, or `landed`.

- Proven pre-send failure with `send_count: 0` may be retried only when the
  calling workflow already authorizes retry.
- Possible/proven delivery forbids blind resend.
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
