# Switching the local AO reviewer (Codex ↔ Claude Sonnet)

Operator runbook for changing which model runs **local** PR review when the
orchestrator executes `ao review run … --execute --command …`.

AO 0.9.x does not read a `reviewer:` YAML block. **REVIEW_COMMAND** is a single
reviewer-agnostic line (`scripts/invoke-pack-review.ps1`). Which executor runs
is set only by the **`PACK_REVIEWER`** environment variable (`codex` or
`claude`). **User-level** `PACK_REVIEWER` (Windows User environment) is
sufficient for AO review spawn: `invoke-pack-review.ps1` reads persistent User
and Machine layers when process scope is empty. Set process-level export before
`ao start` when the **daemon** must see other variables at boot; restart AO after
changing selector or YAML. Restart the IDE when its integrated terminal must
pick up profile changes unrelated to review spawn.

Both paths use the same pack contract (`prompts/codex_review_prompt.md`,
`NO_FINDINGS`, structured JSON findings, `plugins/ao-codex-pr-reviewer` parser).
Only the **dispatch target** behind `invoke-pack-review.ps1` changes.

## Defaults

| Reviewer | `PACK_REVIEWER` | Dispatched wrapper |
|----------|-----------------|-------------------|
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
| Selector in use | `PACK_REVIEWER` is `codex` or `claude` before `ao start` |
| Rules reloaded | Orchestrator restarted after selector or YAML edit |
| Executor matches selector | Latest `terminationReason` names the wrapper for `PACK_REVIEWER` |
| Clean vs failed | `ao review list <project> --json` — only `clean` + `findingCount: 0` is clean |
| Strict gate (operator) | `pwsh -File scripts/orchestrator-diagnose.ps1 -Strict` |
| Stale runs | After `gh pr update-branch`, trigger review on current head |

## Troubleshooting

| Symptom | Likely cause | Action |
|---------|----------------|--------|
| Review exits immediately, PACK_REVIEWER message | Selector unset/invalid in all layers | Set User or process `PACK_REVIEWER` to `codex` or `claude` |
| Wrong model ran | Selector not set before `ao start` | Fix env, restart AO; check `terminationReason` vs `PACK_REVIEWER` |
| Strict gate selector-mismatch | Drift or wrong env | Align `PACK_REVIEWER` with wrapper named in `terminationReason` |
| Codex usage limit | Quota | Set `PACK_REVIEWER=claude` temporarily |
| Orchestrator never picks new reviewer | No restart | `ao stop` / `ao start` after selector change |

## Related docs

- [`orchestrator-autoloop-go-live.md`](orchestrator-autoloop-go-live.md)
- [`migration_notes.md`](migration_notes.md) — § Issue #86, #79, #60, #55
- [`architecture.md`](architecture.md#review-paths)
- [`plugins/ao-codex-pr-reviewer/README.md`](../plugins/ao-codex-pr-reviewer/README.md)
