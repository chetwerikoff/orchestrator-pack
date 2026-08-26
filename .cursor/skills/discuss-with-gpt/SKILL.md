---
name: discuss-with-gpt
description: Use when the user asks to adversarially challenge a draft/artifact with GPT (the custom ChatGPT project) — triggers «с gpt», «с гпт», «обсуди с gpt», «обсуди с гпт», «посоветуйся с gpt», «выясни с gpt», «драфт с gpt», «создай задачу с gpt», "draft with gpt", "discuss with gpt", "challenge with gpt". Brief-only creation routes through create-issue-draft. Standalone artifact challenge keeps driver.mjs. Tracked create/review turns follow the canonical Browser-GPT carrier and portable manager runbook; this skill retains routing, draft-author relocation policy, and standalone-driver policy. OpenCode is the default flow-manager when no runtime is selected; a capable operator-selected runtime such as Cursor or Codex may manage create-issue-draft without becoming a reviewer-engine substitute.
---

# discuss-with-gpt

Runs GPT browser work against the custom ChatGPT project. There are two distinct
roles and their contracts must not be mixed:

- **Standalone adversarial review** — challenges an existing local artifact on
  explicit user request. It continues to use `driver.mjs`, PASS_ID/SHA validation,
  and standalone durable pass states.
- **Tracked create/review transport** — `create-issue-draft` author/reviewer turns
  follow the canonical carrier, runbook, and workflow-owned stage contracts. They
  are not the standalone driver and do not inherit its retry/validation state
  machine.

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

## Draft-author relocation

When Issue #579 relocation is active, the draft-author is a delegated role rather
than the architect's live-session authoring mode. The owning create-issue workflow
still defines tiering, stage order, review-loop acceptance, and publication gates;
this section owns only the relocated author-session contract.

### Role split

- **Architect:** brief, advisory tier prior, T3 lens pass, tier-gate escalation,
  contested protected findings, and **pre-sync review**. The architect does not
  author the full spec in the live session while relocation is active.
- **Draft-author session:** execute the full create-issue draft from the brief —
  recon, decomposition, tier gate, design analysis when required, review loop,
  disposition ledger, discipline checks, and Codex draft review — while obeying
  the owning create-issue workflow.

### Brief handoff

The minimum handoff is problem/goal, advisory tier prior, constraints and
out-of-scope, plus grounding pointers the architect verified. No prescribed brief
file path is required.

### Isolation

Work in an **isolated checkout or scratch workspace**. Never perform authoring Git
operations in the architect's live working tree. Shared-index authoring,
dirty-tree delegation, force checkout/reset recovery, and force-push semantics are
forbidden.

### Engine selection

- Default relocated draft-author engine: **Cursor**; never auto-switch it.
- **Codex or Sonnet 5** require an explicit user request.
- Completion evidence names `authoringEngine` and `selectionBasis`
  (`default` | `explicit-request`). A non-Cursor draft-author with `default`
  selection basis is invalid.
- When the author engine equals the wrapper adversary engine, run the adversarial
  pass as an independent instance so author and adversary remain distinct.

### Completion proof

Exit status is not completion proof. Complete only when the draft exists at the
expected path, discipline checks pass, the review-loop outcome is recorded, and
the completion record links the brief, draft path, engine, selection basis, tier,
review outcome, disposition status, discipline results, and final status.

Mechanical guard: `scripts/check-draft-author-relocation-contract.ps1`.

### Fallback and sync boundary

Until relocation is active, or when the delegate is unavailable or incomplete,
use architect-as-author `create-issue-draft` in the architect session and record
the fallback reason. The draft-author session must not sync or publish an Issue
before architect pre-sync review and the existing workflow gates pass.

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
routing, draft-author relocation policy, and the standalone `driver.mjs` contract
here. The create-issue skill owns workflow, tier, stage, capture, receipt, and
acceptance policy.

Tracked stage cardinality, chat topology, and business order belong exclusively
to [the canonical create-issue-draft skill](../create-issue-draft/SKILL.md);
this routing skill does not restate them.

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
Before reporting any standalone terminal state, re-read the newest artifact in
`~/.local/state/discuss-with-gpt/<draft-slug>/`. The on-disk record outranks
agent recollection and any earlier tool refusal. A preflight refusal on one
invocation path is not a terminal state while a `completed_valid` artifact
exists for that PASS_ID.

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
4. Validate PASS_ID/SHA and packet shape; record the durable state/artifact, then
   re-read the newest artifact before reporting any standalone terminal state.
5. Evaluate findings rather than obeying them blindly. Apply accepted content
   changes only through the owning workflow.
6. Use at most three fresh standalone passes unless another owning contract says
   otherwise.
