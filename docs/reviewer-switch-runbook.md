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

### Canonical Browser-GPT worker start (Issue #1111)

Workers start a detached Browser-GPT pack review with **one PR-number command**:

```bash
node --experimental-strip-types scripts/start-pack-review-chat.ts <pr-number> [--json]
```

The command resolves the open PR and current head, atomically claims the
`stage=pack-review` identity, and either starts exactly one new review or adopts/recovers
the existing same-head turn. Machine-readable JSON is written to stdout.

**Do not** hand-build `mktemp` → prompt → `nohup ... --new-chat` → PID-file chains.

**Ambiguous failure is not resend authority.** A launch error, shell exit, timeout,
backgrounded caller, or missing stdout does not authorize a replacement chat. Re-run the
canonical command to adopt/recover; only producer-grounded proven-non-delivery plus the
required remediation may allow a new send. Query `npm run chatgpt-browser-turn -- status/list`
for helper evidence before manual retry.

`REVIEW_COMMAND` / `scripts/run-pack-review-gpt.ts` remain the synchronous terminal-verdict
path; GitHub publication stays on `scripts/pack-review-runner.ts`.

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
| GPT browser turn blocked/failed | Profile incidents or transport ambiguity | Run `npm run chatgpt-browser-turn -- status/list`; resolve `possible_delivery` before retry |
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
