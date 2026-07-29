# Worker smoke testing (Issue #1061)

Workers prove operator-visible behavior with a **head-bound Orca smoke run** before `ready_for_review`. CI remains mandatory and separate.

## When smoke is required

| Issue body signal | Worker gate |
|---|---|
| No `smoke-test-plan` fence + `smoke-plan-floor` grandfather marker | Smoke not required (legacy queue only) |
| No `smoke-test-plan` fence on action-producing Issue without grandfather marker | Smoke required; missing plan blocks handoff |
| `smoke-test-plan` with `not-applicable: true` + reason | Smoke skipped |
| `smoke-test-plan` with scenarios | Smoke required for current PR head |

New action-producing tasks must declare a plan during authoring:

```bash
node scripts/draft-discipline.mjs smoke-test-plan --draft path/to/issue-body.md
```

## Supported worker path

```bash
export PATH="$PWD/scripts:$PATH"
worker-smoke-run run \
  --issue <N> \
  --pr <PR> \
  --head-sha <40-hex> \
  --issue-body-file /tmp/issue-body.md \
  --repo-root "$PWD" \
  --cwd "$PWD"
```

Lifecycle:

1. `orca worktree current --json` must resolve the worker cwd to the existing Orca-managed worktree.
2. `orca terminal create --worktree active --command "cursor-agent"` captures one owned handle.
3. Worker sends the smoke prompt, waits/reads through Orca terminal surfaces, parses the `worker-smoke-report` block.
4. Worker closes only `orca terminal close --terminal <owned-handle>` **before** publishing the PR comment; cleanup result is recorded in the report.
5. Pack publishes a top-level PR comment via `gh pr comment` (through pack `scripts/gh`). Smoke-owned `gh` children receive only the supported parent auth/config carriers (`GH_TOKEN` / `GITHUB_TOKEN`, enterprise token variants, `GH_HOST`, `GH_CONFIG_DIR`, `XDG_CONFIG_HOME`, `HOME`, `USERPROFILE`) — not the full parent environment. `GH_REPO` is intentionally not forwarded because it can redirect smoke-owned GitHub operations away from the bound worktree.

## Pack-generated non-PASS causes

Structured `worker-smoke-run` JSON distinguishes at least:

| `nonPassCause` | Meaning |
|---|---|
| `zero_parsed_scenarios` | Required plan parsed to zero executable scenarios; no Orca terminal was created |
| `missing_agent_report` | Agent activity was observed but no parseable `worker-smoke-report` block was found |
| `executed_scenario_failure` | A valid report shows one or more declared scenarios ran and failed |

Top-level `PASS | FAIL | BLOCKED` semantics are unchanged.



## Child-wait delivery and completion

Issue #1115 owns the parent wait contract from prompt delivery through publish-complete child completion.

- Each smoke attempt creates one ephemeral **run identity** before send. Delivery and completion evidence must bind to that same run.
- **Delivery** requires publish-complete durable evidence (for example `delivery.sealed.json` under the run artifact directory). `orca terminal send` success alone is not delivery proof. Ambiguous prior delivery never authorizes resend; optional resend is allowed only on definite non-delivery (`terminal_send_rejected`, `prompt_not_accepted`). Exhaustion yields `prompt_delivery_unconfirmed`, owned-terminal cleanup, and no completion wait.
- **Completion** is accepted only from a **publish-complete** durable artifact for the current run (`completion-<bodySha256>.body` + `completion-<bodySha256>.sealed.json` with matching `runId` and `bodySha256`; in-progress bytes may use `completion.pending.body` only). Each terminalization must use new content-addressed filenames; competing same-run seals are observable as duplicate even on first parent poll. Partial bytes before the seal remain pending and are not classified as PASS, unfenced, or duplicate. One valid seal consumes `PASS | FAIL | BLOCKED`; duplicate same-run terminalizations yield `agent_report_duplicate`; malformed sealed bodies yield `agent_report_unfenced`; no sealed completion at the shared deadline yields `agent_report_timeout`.
- Grounded child exit/idle witnesses may yield `agent_exited_without_report` or `agent_idle_without_report` only when capture-backed on the production path; otherwise the timeout fallback applies.
- Self/unowned handle binding is refused locally (`agent_wait_self_handle`, `agent_wait_unowned_handle`). Known untrustworthy control-plane channels preserve upstream causes without handle re-derivation or smoke verdict synthesis.
- `orca terminal read` is secondary liveness/diagnostic only; suppressing PTY bytes must not change the terminal class when durable artifact evidence is unchanged.
- Delivery, completion publication/consumption, negative-terminal checks, and bounded polling share one terminal-phase budget (<= 30 minutes) started at owned-terminal creation.

### Unsubmitted composer paste (delivery stall)

Recurring Cursor/TUI defect when `worker-smoke-run` delivers a large smoke prompt through `orca terminal send --text … --enter` (`scripts/lib/orca-cli.ts`): Orca reports send success, but the composer keeps the prompt as an **unsubmitted** bracketed paste and the turn does not start. The trailing `--enter` is absorbed by bracketed-paste mode instead of submitting the line. The parent does **not** recover from this state on its own.

**Symptom**

- PTY/composer shows `→ [Pasted text #1 +NNN lines]` — full prompt visible, not submitted.
- No spinner, no `Run Everything` progress, no tool output.
- `.orca-worker-smoke/runs/<runId>/` stays **empty** (no `delivery.sealed.json`, no completion seals).
- Smoke parent is still running and polling; owned handle is still open — but **this state does not clear by itself**.

This has recurred across multiple Cursor smoke sessions; it is not a short benign boot delay.

**Grounded example (2026-07-29, PR #1132 head `447a908b`)**

Run `5dc077c7-6bec-4f0d-b0dd-11986a7f0d74`, terminal `term_a8bcd171-5162-4fc1-8b91-b2606b2f9216`:

| Time (UTC) | Event |
|---|---|
| 17:33:30 | Owned terminal created; `terminal send` returned success |
| 17:33:30 – 17:44:06 | Paste line visible, no spinner/output, run directory empty (~10½ minutes) |
| 17:44:06 | `delivery.sealed.json` appeared **only after the operator manually pressed Enter** in that tab |
| 17:46:17 | Completion seal written; **PASS** published to #1132; owned handle closed |

The published **PASS is not a clean unattended smoke run** — delivery was **manually unblocked**. Without that Enter, the attempt would have remained in this stall until the shared terminal-phase budget expired.

**Forecast without operator intervention**

The parent keeps polling for `delivery.sealed.json` and consumes the **shared terminal-phase budget** (<= 30 minutes from owned-terminal create). With the run directory still empty, exhaustion yields **`prompt_delivery_unconfirmed`**, owned-terminal cleanup, and **no completion wait**.

**Contract gap (r01 today)**

From the PTY, the state is **observably unsubmitted** — not “maybe still accepting.” r01 would allow automated resend only on definite non-delivery (`terminal_send_rejected`, `prompt_not_accepted`), but Orca does not emit those codes for this bracketed-paste stall and `establishSmokePromptDelivery` does not detect the paste line. Until behavioral follow-up lands (operator decision pending), recovery is manual.

**Operator playbook (no automation yet)**

1. **Recognize the stall** — both must hold: unsubmitted paste visible in the composer **and** no `delivery.sealed.json` under `.orca-worker-smoke/runs/<runId>/`.
2. **Press Enter once** in that smoke terminal tab to submit the composer line. Do not re-paste or send a second prompt.
3. **If `delivery.sealed.json` already exists**, do **not** touch the terminal — delivery is established; wait on completion artifacts only.
4. **Do not assume** the stall will resolve on its own; without Enter (or future automated resend), the run will time out to `prompt_delivery_unconfirmed`.

Durable artifacts remain authoritative for delivery/completion classification; PTY appearance is the operator’s cue for this known gap, not an input to the automated parent today.

## Owned-handle supervision

When a worker supervises a child agent in an Orca terminal, binding discipline is behavioral —
pack scripts take the owned handle from `orca terminal create`, but a supervisor that re-binds to
its own terminal after runtime restart can poll forever (2026-07-29 incident).

- **Handle binding.** Record the owned handle from `orca terminal create` **immediately** and use
  **only** that handle for send, read, and close on the supervised child.
- **No re-derivation.** **MUST NOT** replace a lost or missing owned handle by searching
  `orca terminal list` (or equivalent) by title, workspace, position, recency, or any other
  heuristic — including after `runtime_unavailable`, Orca restart, or handle rotation.
- **Self-monitoring is a binding error.** If the supervised handle equals your own terminal,
  treat it as **failed binding**, not as "child still running". **Fail closed** and report; do
  not keep polling.
- **Stale handle = lost run.** If the handle is invalid or unreadable, the supervised run is
  **lost**. Stop, report what is known, and do not guess a replacement or attach to an unrelated
  terminal.
- **Terminal text is not completion.** Visible TUI output may inform liveness only as a
  **secondary** hint. It is **not** a completion signal: the PTY channel is unsigned (every
  agent TUI looks alike), has no reliable negative state (absence of a marker means working, wrong
  output, or dead), and is lossy (Orca may drop PTY bytes when the window is collapsed).
  **Completion** requires a **durable artifact** the child produces (e.g. the `worker-smoke-report`
  block).

## Orca contract evidence

`scripts/lib/orca-cli.ts` consumes concrete Orca JSON fields (`result.worktree.*`, `result.terminal.handle`, `result.lines`). Capture-backed producer evidence lives under `tests/external-output-references/captures/orca-worker-smoke/` (grounding commit `89968a10614d0e5f5a6b7805c81dccc3a1b5110b` per Issue #1061).

## Orca executable selection

Use `ORCA_CLI_COMMAND` when exported. Otherwise prefer `orca-dev`, then `orca-ide`, then `orca`. Do not assume `/usr/bin/orca` is the CLI on Linux.

## Readiness gate

`pack-worker-report --state ready_for_review` invokes `worker-smoke-run gate-check` and fails closed when smoke is required and the current head lacks a bound `PASS` with `terminal-cleanup: closed_owned_handle`. The latest same-head FAIL/BLOCKED report revokes an earlier PASS. Issue binding resolves from `Closes #N` on the PR when `AO_ISSUE_NUMBER` is unset.

Production adoption aligns with Issue #1038: pre-cutover AO workers that are not Orca-managed remain `BLOCKED` rather than faking compliance via another checkout.
