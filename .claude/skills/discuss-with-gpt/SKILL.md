---
name: discuss-with-gpt
description: Use when the user asks to adversarially challenge a draft/artifact with GPT (the custom ChatGPT project) — triggers «с gpt», «с гпт», «обсуди с gpt», «обсуди с гпт», «посоветуйся с gpt», «выясни с gpt», «драфт с gpt», «создай задачу с gpt», "draft with gpt", "discuss with gpt", "challenge with gpt". Brief-only creation routes through create-issue-draft. Standalone artifact challenge keeps driver.mjs. Tracked create/review turns follow the canonical Browser-GPT carrier and portable manager runbook; this skill retains routing and standalone-driver policy. OpenCode is the default flow-manager when no runtime is selected; a capable operator-selected runtime such as Cursor or Codex may manage create-issue-draft without becoming a reviewer-engine substitute.
---

# discuss-with-gpt

Runs GPT browser work against the custom ChatGPT project. There are two distinct
roles and their contracts must not be mixed:

- **Standalone adversarial review** — challenges an existing local artifact on
  explicit user request. It continues to use `driver.mjs`, PASS_ID/SHA validation,
  and standalone durable pass states.
- **Tracked create/review transport** — `create-issue-draft` author/reviewer turns
  use the repository package entrypoint `npm run chatgpt-browser-turn -- ...` and
  the state-light Issue #1120 transport contract. It is not the standalone driver
  and does not inherit its retry/validation state machine.

Issue-body floors, tiering, finding-ledger normalization, chat-role separation,
and acceptance remain owned by `create-issue-draft`. Claude runs only the T3
`architectural-lens` stage defined there. Flow-manager runtime selection follows
that canonical skill: **OpenCode** is the default only when no runtime is selected;
a capable operator-selected runtime such as **Cursor or Codex** may manage the flow.
Codex manager selection does not let Codex replace Browser-GPT reviewer stages or
the required T3 Claude lens.

## Routing

| Trigger | Route |
|---------|-------|
| «с gpt» / «с гпт» / «обсуди с gpt» / "discuss with gpt" over an existing local artifact | standalone `driver.mjs` flow in this skill |
| «создай задачу с gpt» / brief-only "draft with gpt" | `create-issue-draft` brief-only entry; effective tier floor T2 |
| GPT-authored Issue task, with or without historical task-chat URL | `create-issue-draft`; tracked mechanics are supplied by the canonical carrier and runbook |
| «с кодексом» / "with codex" over an existing artifact for challenge/review | `adversarial-draft-review` |
| explicit request to create or manage a task with Codex | `create-issue-draft` with Codex selected as flow-manager |
| bug/root-cause consult | `investigate-root-cause` / `codex:rescue` |

Do not impose the standalone adversarial loop on normal create-issue-draft stages.

## Browser preconditions and tracked-turn pointer

Both standalone and tracked paths require the already-running configured headed
automation Chrome with a logged-in ChatGPT session. Never type credentials.
Use the local launcher and gitignored configuration; do not place profile,
project, conversation, CDP, input, or output values in tracked content.

For tracked create/review turns, follow the canonical carrier
[`.cursor/rules/flow-manager-browser-turn-monitoring.mdc`](../../../.cursor/rules/flow-manager-browser-turn-monitoring.mdc)
and [`docs/browser-gpt-turn-runbook.md`](../../../docs/browser-gpt-turn-runbook.md).
Those documents own launch order, observation, marker attribution, publication,
retry/no-resend, tab lifecycle, probe, and handoff mechanics. This skill keeps
only routing and the standalone `driver.mjs` contract here. The create-issue
skill owns workflow, tier, stage, capture, receipt, and acceptance policy.

## create-issue-draft chat topology

- authoring/fixes: current author chat; when unavailable it may be reconstructed
  from the live Issue in a fresh dedicated tab;
- T3 competitive: fresh chat for each of 1–3 passes;
- T3 `architectural-review`: exactly one fresh chat after competitive;
- T3 Claude `architectural-lens`: independent Claude Code CLI, no browser review chat;
- terminal GPT `architectural`: exactly one fresh chat, distinct from author,
  competitive, and `architectural-review`; it remains the final M5 anchor.

The canonical T3 business order is:

```text
competitive → architectural-review → Claude lens → GPT lens
```

## Standalone adversarial driver

Standalone `driver.mjs` remains separate from the tracked helper. It keeps prompt
construction, PASS_ID/DRAFT_SHA256 echo validation, durable pass artifacts, and
its own supported modes.

### Standalone pass states

| State | Meaning |
|-------|---------|
| `completed_valid` | PASS_ID+SHA validated and packet parses; clean APPROVE still needs a genuine-review quality check |
| `low_quality` | syntactically valid but generic/non-specific review |
| `invalid` | echo missing, hash mismatch, truncation, or malformed packet |
| `chrome_not_running` / `login_required` / `quota_limit` / `challenge` / `wrong_project` / `cdp_profile_mismatch` | preflight blocker |
| `stream_timeout` / `no_reply` | generation incomplete; standalone retry policy applies |
| `send_failed` | prompt did not land as a user message |
| `driver_error` | unexpected Playwright/UI failure |
| `skipped` | browser unavailable and user absent |
| `fallback_codex` | standalone adversarial flow used its explicit Codex fallback |

Fail loud on `skipped`, `invalid`, or `fallback_codex`; never represent a
standalone state as a tracked-helper result.

### Standalone long turns

The standalone driver retains its own long timeout and page-observation rules.
A running local process proves nothing about ChatGPT state. When operator
observation is needed, inspect the standalone chat page rather than claiming
liveness from PID/log state. Hand-copied page text cannot become
`completed_valid` because it lacks PASS_ID/SHA validation and the durable driver
record.

These standalone rules do **not** create a second monitor for tracked
create-issue-draft turns.

### Standalone tabs

When standalone mode intentionally targets a persistent conversation, pass its
`--chat-url`; fresh adversarial passes use `--new-chat`. Never merge two
standalone review streams into one chat. Close standalone tabs according to the
standalone driver contract without touching tabs owned by tracked helper
invocations or other agents.

## Standalone flow

1. Obtain the existing local markdown artifact. Brief-only task creation routes to
   `create-issue-draft` instead.
2. Build the standalone adversarial prompt with the artifact as untrusted data and
   a fresh PASS_ID/draft SHA.
3. Run the standalone browser driver in a fresh review chat.
4. Validate PASS_ID/SHA and packet shape; record the durable state/artifact.
5. Evaluate findings rather than obeying them blindly. Apply accepted content
   changes only through the owning workflow.
6. Use at most three fresh standalone passes unless another owning contract says
   otherwise.
