---
name: discuss-with-gpt
description: Use when the user asks to adversarially challenge a draft/artifact with GPT (the custom ChatGPT project) — triggers «с gpt», «с гпт», «обсуди с gpt», «обсуди с гпт», «посоветуйся с gpt», «выясни с gpt», «драфт с gpt», «создай задачу с gpt», "draft with gpt", "discuss with gpt", "challenge with gpt". Brief-only creation routes through create-issue-draft. Standalone artifact challenge keeps driver.mjs. Tracked create/review turns use the state-light send-once Browser-GPT helper from Issue #1120: `npm run chatgpt-browser-turn -- turn ...`, one dedicated owned tab, one exact prompt send, and stable page/DOM completion; shell/PID/log liveness is not evidence. Legacy status/clear/capability/recovery/mutex/lease state is diagnostic only, incidents are invocation-local, sibling tabs are untouched, and possible or post-send ambiguity forbids resend. OpenCode is the default flow-manager when no runtime is selected; a capable operator-selected runtime such as Cursor or Codex may manage create-issue-draft without becoming a reviewer-engine substitute.
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
| GPT-authored Issue task, with or without historical task-chat URL | `create-issue-draft`; this skill supplies tracked Browser-GPT mechanics |
| «с кодексом» / "with codex" over an existing artifact for challenge/review | `adversarial-draft-review` |
| explicit request to create or manage a task with Codex | `create-issue-draft` with Codex selected as flow-manager |
| bug/root-cause consult | `investigate-root-cause` / `codex:rescue` |

Do not impose the standalone adversarial loop on normal create-issue-draft stages.

## Browser preconditions

Both paths connect to an already-running automation Chrome with a logged-in
ChatGPT session. Never type credentials.

```bash
bash .claude/skills/discuss-with-gpt/launch-chrome.sh
```

- Exit 0 means the launcher found/started the configured automation browser.
- Do not wrap the launcher in `timeout`; it owns its bounded startup wait.
- Do not launch parallel hand-rolled diagnostics or a second Chrome owner.
- Automation Chrome uses the dedicated configured profile and loopback CDP port.

Operator configuration remains local/gitignored:

| Setting | Env var | `local.config.json` key |
|---------|---------|---------------------------|
| Custom GPT project URL | `DISCUSS_WITH_GPT_PROJECT_URL` | `projectUrl` |
| Chrome user-data-dir | `DISCUSS_WITH_GPT_CHROME_USER_DATA_DIR` | `chromeUserDataDir` |
| Chrome executable (optional) | `DISCUSS_WITH_GPT_CHROME_PATH` | `chromePath` |

## Tracked helper for create/review — Issue #1120

Use the package entrypoint so the Node-major guard runs first.

Existing conversation:

```bash
npm run chatgpt-browser-turn -- \
  --profile /absolute/path/to/automation-profile \
  --cdp http://127.0.0.1:9222 \
  --input /absolute/path/to/message.txt \
  --output /absolute/path/to/reply.txt \
  --chat-url https://chatgpt.com/c/<conversation-id>
```

Fresh conversation:

```bash
npm run chatgpt-browser-turn -- \
  --profile /absolute/path/to/automation-profile \
  --cdp http://127.0.0.1:9222 \
  --input /absolute/path/to/message.txt \
  --output /absolute/path/to/reply.txt \
  --new-chat \
  --project-url <configured-project-url>
```

The current flow-manager prepares exact argv plus absolute input/output paths.
The helper is a **single-invocation fast path**, not admission/recovery authority:

1. verify the local browser/profile/UI preconditions needed for this invocation;
2. open one dedicated owned tab, even when `--chat-url` names an existing chat;
3. navigate, snapshot input, and submit the user prompt once;
4. observe only that owned tab until one final assistant node is stable and no
   longer generating, advancing continuation UI when applicable;
5. publish the captured final reply and close only the owned tab;
6. emit one compact `turn-result/v1` result plus direct incident information.

The tracked contract has one owned tab and one send boundary. Page/DOM
completion is sufficient; shell/PID/log/background-job liveness and service
terminal/network witnesses are not completion evidence. Sibling or foreign
tabs are never closed, commandeered, or used to admit, veto, restart, or
invalidate this invocation.

### Completion and attribution

- Page/DOM completion is sufficient. Do not require service-terminal/network
  witness or capability/Gate-B evidence after the final assistant reply is stable.
- Progress/intermediate assistant nodes are not concatenated into the final result.
- The invocation must observe its own exact user prompt after the page baseline.
  Additional/interleaved user activity, page loss, UI failure, cleanup failure,
  timeout, output conflict, or publication conflict makes only that invocation
  `observation_uncertain`/degraded; it never blocks or changes a sibling tab.
- A normal generating/wait poll is not an incident.
- Login, quota, challenge, unusable composer, redirect/UI mismatch, or publication
  conflict are local invocation results.

### Send-once and lost-state policy

The live invocation has exactly one user-message send boundary. After that the
helper only polls/reads the same tab. It never silently re-sends because of a
slow reply, timeout, missing old witness, or ambiguous local process state.

When a process/page/chat is genuinely lost and cheap continuation is unavailable,
the flow-manager may start a **fresh invocation in a fresh chat and send again**.
A duplicate recoverable GPT text request is an accepted residual risk. Do not
query or clear legacy helper state to authorize the replacement.

Any possible delivery, post-send failure, ambiguous delivery, output conflict,
missing terminal result, or `send_count: 1` forbids resend within that
invocation; retain it as invocation-local incident evidence. Only a proven
pre-send zero-send failure may use the separately defined bounded retry.

### Legacy control/recovery state is non-authoritative

Tracked create/review progression must not wait for or clear:

- `status/list`, `clear`, capability, Gate-B characterization;
- `publication-status` as delivery/admission authority;
- `possible_delivery`, `profile_wall`, tombstone/orphan recovery state;
- profile/conversation/task/Issue/PR mutexes, claims, queues, leases, or adoption
  records.

Old files/control commands may remain for historical compatibility or diagnosis,
but they are not live create/review gates. Do not copy the old retained-recovery
root or require candidate/gate digests before a normal turn.

### Incident journal and reporting

Direct unexpected helper events append best-effort to:

```text
~/.local/state/create-issue-draft/browser-turn-recurrence.jsonl
```

The journal is append-only retrospective analytics. Never scan it before a turn,
never lock/dedupe it, and never let historical rows or append failure grant/veto
browser work. Carry the same directly observed incident class into the current
flow-manager report. Cleanup failure after a captured reply is an incident but
must not invalidate the captured reply or close foreign tabs.

### No second tracked monitor in #1120

Do not add or run a parallel direct-CDP inspector/watchdog for tracked turns, and
do not infer "GPT is still generating" from PID/log/background-job liveness. The
dedicated direct-agent fallback/supervision policy is a separate follow-up task.

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
