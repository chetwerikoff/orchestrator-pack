# Switching the local AO reviewer (GPT ↔ Codex ↔ Claude)

Operator runbook for changing which model runs **local** PR review when the
orchestrator executes `ao review run … --execute --command …`.

AO 0.9.x does not read a `reviewer:` YAML block. **REVIEW_COMMAND** is a single
reviewer-agnostic line (`scripts/invoke-pack-review.ps1`). Which executor runs
is set only by the **`PACK_REVIEWER`** environment variable (`gpt`, `codex`, or
`claude`). **User-level** `PACK_REVIEWER` (Windows User environment) is
sufficient for AO review spawn: `invoke-pack-review.ps1` reads persistent User
and Machine layers when process scope is empty. Set process-level export before
`ao start` when the **daemon** must see other variables at boot; restart AO after
changing selector or YAML. Restart the IDE when its integrated terminal must
pick up profile changes unrelated to review spawn.

Both Codex/Claude paths and GPT use the same pack findings contract
(`NO_FINDINGS`, structured JSON findings, `plugins/ao-codex-pr-reviewer`
parser/emitter). GPT inspects the PR through the browser/GitHub read surface and
returns a terminal payload; **the pack runner remains the sole GitHub publisher**.
GPT failure, quota/login issues, malformed output, or stale-head rejection do
**not** auto-switch to Codex — set `PACK_REVIEWER=codex` explicitly for backup.

## Defaults

| Reviewer | `PACK_REVIEWER` | Dispatched wrapper |
|----------|-----------------|-------------------|
| **Browser GPT** (explicit opt-in) | `gpt` | `scripts/run-pack-review-gpt.ts` |
| **Codex** (example default) | `codex` | `scripts/run-pack-review.ps1` |
| **Claude Sonnet** (quota / fallback) | `claude` | `scripts/run-pack-review-claude.ps1` |

**REVIEW_COMMAND** (unchanged when switching — copy from `agent-orchestrator.yaml.example`):

`powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/invoke-pack-review.ps1 --repo-root . --base origin/main`

Unset or invalid `PACK_REVIEWER` in **all** consulted layers: the entrypoint
exits non-zero and runs **no** reviewer (fail-closed; no silent Codex default).

**Layer precedence (Windows):** Process → User → Machine. When process scope is
unset, User wins over Machine for the same name (e.g. User `claude` + Machine
`codex` resolves `claude`). Non-Windows hosts use process scope only in this
pack — no persistent-env fallback; unset process scope remains fail-closed.
The canonical PR-number GPT command below uses the invocation-bound reviewer
channel, so its temporary `gpt` binding wins without changing Process, User, or
Machine configuration.

Before merge or declaring review clean, run `.\scripts\orchestrator-diagnose.ps1
-Strict` (live AO) or rely on CI `scripts/invoke-pack-review-strict-gate.ps1`
(fixture-only).

## Switch to GPT (browser)

1. **Set** `PACK_REVIEWER=gpt` in the environment AO inherits (user profile,
   service unit, or shell before `ao start`).
2. **Configure browser transport** for the operator machine:
   - `PACK_GPT_BROWSER_PROFILE` — absolute path to the dedicated automation profile
   - `PACK_GPT_BROWSER_CDP` — CDP endpoint (default `http://127.0.0.1:9222`)
   - `PACK_GPT_BROWSER_CHAT_URL` or `PACK_GPT_BROWSER_PROJECT_URL` — target chat or project
3. **Point live YAML** at the reviewer-agnostic entrypoint (`invoke-pack-review.ps1`).
4. **Restart AO** after selector or YAML edits.
5. **Smoke one review** (optional) with `PACK_REVIEWER=gpt`; on failure,
   `terminationReason` should reference `run-pack-review-gpt.ts`. GPT failure does
   **not** auto-failover to Codex.

### GPT plural PR-review rounds (Issue #1276)

The first GPT review round uses three frozen independent source slots for every
tier. Later T3 rounds also use three; later T1/T2 rounds use one. Plural rounds
must use `PACK_GPT_BROWSER_PROJECT_URL` with fresh project/new-chat conversations.
A plural start with `PACK_GPT_BROWSER_CHAT_URL` fails closed; fixed-chat remains
available for single-source rounds.

Source admission starts are spaced by 10 seconds at the runner boundary. The
mandatory profile send slot remains enabled for each fresh-conversation
prepare+send section; post-send observation may overlap across sources. The
runner retries only the exact zero-send
`state_light_new_chat_send_slot_timeout` collision once for the same frozen slot.
Generic UI mismatch, malformed output, missing terminal result, and any
possible/post-send delivery are never resent.

Browser-GPT pack review now uses the Issue #1120 state-light `turn` path: one
fresh owned tab per invocation, one user-prompt send, page/DOM completion, and
invocation-local failure. Do not run `status/list`, `clear`, capability/Gate-B,
`publication-status`, or possible-delivery recovery before retrying a recoverable
review turn. If a page/process/chat is genuinely lost, start a fresh invocation;
a rare duplicate recoverable GPT review prompt is accepted. The helper never
closes foreign tabs and old control state cannot admission-block a healthy review.

## Run one Browser-GPT review by PR number

From the current canonical repository checkout, use the pack-owned foreground
command:

```bash
npm run --silent pack-gpt-review -- --pr-number <PR_NUMBER>
```

`--silent` is part of the canonical command: it suppresses npm lifecycle banners
so terminal stdout remains exactly one machine-readable runner JSON object.

The PR number is the only required task argument. Optional
`--timeout-seconds <N>` overrides the runner's 45-minute default. Do not supply a
head SHA: the command resolves the canonical repository, verifies that the PR is
`OPEN`, and obtains the live full current head before Browser-GPT can send.
Repository lookup failure, an absent or closed PR, GitHub read failure, or an
invalid head exits non-zero before GPT/browser or GitHub publication effects.

This command binds `gpt` through `PACK_REVIEW_BOUND_REVIEWER` for this invocation
only. It does not mutate persistent `PACK_REVIEWER` configuration, and a
conflicting Windows User/Machine selector cannot redirect this invocation to
Codex or Claude.

A fresh run emits one compact start line on stderr containing PR number, bound
head, run ID, and timeout, then remains foregrounded until the existing runner
returns a terminal result. Terminal stdout remains one machine-readable runner
JSON object. The existing runner owns prompt/result composition, the post-review
live-head check, and GitHub publication; this command does not publish a review
itself.

A new run is eligible only when the existing generic `(PR, head)` runner state
and start-claim path allow it. When an active same-head run, a persisted terminal
same-head run, or a start-claim refusal prevents a new run, the command exits
non-zero with `outcome: "review_not_started"` and preserves the underlying
`runnerReason`. That means Browser-GPT did **not** execute for this invocation;
there is no force/re-run option for an already reviewed same head.

The result is valid only for the bound head. If the PR head moves before
publication, the existing runner rejects the earlier-head result. Timeout is a
non-zero terminal failure. `Ctrl-C` interrupts the foreground command and is not
success; the command does not detach, create a PID contract, or promise that the
review survives after the caller exits.

The browser prerequisites from **Switch to GPT (browser)** still apply. Unlike a
persistent reviewer switch, this one invocation does not require changing
`PACK_REVIEWER` or restarting AO.

## Switch to Codex

1. **Set** `PACK_REVIEWER=codex` in the environment AO inherits (user profile,
   service unit, or shell before `ao start`).
2. **Point live YAML** at the reviewer-agnostic entrypoint if still on legacy
   per-wrapper `REVIEW_COMMAND` lines — copy **NAMED REVIEW_COMMAND** from
   `agent-orchestrator.yaml.example` (`invoke-pack-review.ps1` only).
3. **Restart AO** so rules reload:
   ```powershell
   ao stop
   ao start orchestrator-pack
   ```
4. **Preflight Codex**
   - `codex --version` on PATH
   - No active usage limit (`terminationReason` on failed runs)
   - Windows: reviewer sandbox allows shell spawns — see
     [migration_notes.md](migration_notes.md) § Issue #60
5. **Smoke one review** (optional):
   ```powershell
   $env:PACK_REVIEWER = 'codex'
   ao review run <worker-session-id> --execute --command "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/invoke-pack-review.ps1 --repo-root . --base origin/main"
   ```
   Expect `ao review list --json`: `clean` or `needs_triage`. On failure,
   `terminationReason` should reference `run-pack-review.ps1`, not the Claude wrapper.

## Switch to Claude Sonnet

1. **Set** `PACK_REVIEWER=claude`.
2. **Ensure** live **REVIEW_COMMAND** uses `invoke-pack-review.ps1` (not
   `run-pack-review-claude.ps1` as REVIEW_COMMAND).
3. **Do not** embed `"` or inline `--command …` inside `orchestratorRules:` — see
   [migration_notes.md](migration_notes.md) § Issue #55.
4. **Restart AO** (same as Codex).
5. **Preflight Claude**
   - `claude --version` on PATH
   - Default model in wrapper: `claude-sonnet-4-6`
6. **Smoke one review** — same `--command` as above with `PACK_REVIEWER=claude`;
   `terminationReason` on failure should reference `run-pack-review-claude.ps1`.

### Deprecated `.ao/` bridge

Gitignored `<pack-root>/.ao/run-pack-review-claude.ps1` is **deprecated**. Do
not use `.ao/` in **REVIEW_COMMAND**.

## After any switch

| Check | Command / signal |
|-------|------------------|
| Selector in use | `PACK_REVIEWER` is `gpt`, `codex`, or `claude` before `ao start` |
| Rules reloaded | Orchestrator restarted after selector or YAML edit |
| Executor matches selector | Latest `terminationReason` names the wrapper for `PACK_REVIEWER` |
| Clean vs failed | `ao review list <project> --json` — only `clean` + `findingCount: 0` is clean |
| Strict gate (operator) | `pwsh -File scripts/orchestrator-diagnose.ps1 -Strict` |
| Stale runs | After `gh pr update-branch`, trigger review on current head |

## Troubleshooting

| Symptom | Likely cause | Action |
|---------|----------------|--------|
| Review exits immediately, PACK_REVIEWER message | Selector unset/invalid in all layers | Set User or process `PACK_REVIEWER` to `gpt`, `codex`, or `claude` |
| Wrong model ran | Selector not set before `ao start` | Fix env, restart AO; check `terminationReason` vs `PACK_REVIEWER` |
| GPT browser turn blocked/failed | Invocation-local browser/UI/quota/attribution failure | Read the compact turn result. Fix the local blocker or start a fresh review invocation when the old page/chat is genuinely lost; do not clear legacy helper state |
| PR-number command returns `review_not_started` | Existing active/terminal same-head run or start claim refused a new run | Read `runnerReason`; do not report GPT success or bypass generic runner reuse with force/clear |
| Strict gate selector-mismatch | Drift or wrong env | Align `PACK_REVIEWER` with wrapper named in `terminationReason` |
| Codex usage limit | Quota | Set `PACK_REVIEWER=claude` or `gpt` temporarily |
| Orchestrator never picks new reviewer | No restart | `ao stop` / `ao start` after selector change |

## Operator scripts (checklist + verify)

From pack repo root:

```powershell
pwsh -NoProfile -File scripts/show-pack-reviewer-status.ps1
pwsh -NoProfile -File scripts/set-pack-reviewer.ps1 -Reviewer codex -RestartAo
```

Agent skill: `.claude/skills/switch-pack-reviewer/SKILL.md` (full checklist).  
Human-readable copy: [`switch-pack-reviewer-checklist.md`](switch-pack-reviewer-checklist.md).

## Related docs

- [`orchestrator-autoloop-go-live.md`](orchestrator-autoloop-go-live.md)
- [`migration_notes.md`](migration_notes.md) — § Issue #86, #79, #60, #55
- [`architecture.md`](architecture.md#review-paths)
- [`plugins/ao-codex-pr-reviewer/README.md`](../plugins/ao-codex-pr-reviewer/README.md)
