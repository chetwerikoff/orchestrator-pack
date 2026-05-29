# Switching the local AO reviewer (Codex ↔ Claude Sonnet)

Operator runbook for changing which model runs **local** PR review when the
orchestrator executes `ao review run … --execute --command …`.

AO 0.9.x does not read a `reviewer:` YAML block. The only switch is the
**REVIEW_COMMAND** line in live `agent-orchestrator.yaml` →
`projects.<id>.orchestratorRules`, plus a restart so the orchestrator reloads
the rules.

Both paths use the same pack contract (`prompts/codex_review_prompt.md`,
`NO_FINDINGS`, structured JSON findings, `plugins/ao-codex-pr-reviewer` parser).
Only the **executor** behind the tracked wrapper changes.

## Defaults

| Reviewer | REVIEW_COMMAND (run from AO `op-rev-*` workspace cwd) | Tracked script |
|----------|--------------------------------------------------------|----------------|
| **Codex** (canonical in example YAML) | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/run-pack-review.ps1 --repo-root . --base origin/main` | `scripts/run-pack-review.ps1` |
| **Claude Sonnet** (temporary quota / fallback) | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/run-pack-review-claude.ps1 --repo-root . --base origin/main` | `scripts/run-pack-review-claude.ps1` |

Copy the canonical line from `agent-orchestrator.yaml.example`
(`orchestratorRules` → **NAMED REVIEW_COMMAND** for Codex; **Alternate** block
for the tracked Claude line). Both paths are **relative** to the review
worktree — no gitignored `.ao/` bridge required.

Before merge or declaring review clean, run `.\scripts\orchestrator-diagnose.ps1
-Strict` (live AO) or rely on CI `scripts/invoke-pack-review-strict-gate.ps1`
(fixture-only).

## Switch to Codex (e.g. after a Sonnet trial)

1. **Edit** live `agent-orchestrator.yaml` (gitignored). Set **REVIEW_COMMAND**
   to the Codex line from the table above (`scripts/run-pack-review.ps1`).

2. **Restart AO** so `op-orchestrator` reloads rules:
   ```powershell
   ao stop
   ao start orchestrator-pack
   ```
   (Restart wake listener / worktree trust watcher if you use them — see
   [`orchestrator-autoloop-go-live.md`](orchestrator-autoloop-go-live.md).)

3. **Preflight Codex**
   - `codex --version` on PATH
   - No active usage limit (failed runs often show quota / TUI banner in
     `terminationReason`, not a bad `--command`)
   - Windows: reviewer sandbox allows shell spawns — see
     [migration_notes.md](migration_notes.md) § Issue #60 (`~/.codex/config.toml`)

4. **Smoke one review** (optional but recommended):
   ```powershell
   ao review run <worker-session-id> --execute --command "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/run-pack-review.ps1 --repo-root . --base origin/main"
   ```
   Expect `ao review list --json`: `status: clean` with `findingCount: 0`, or
   `needs_triage` with real findings. On failure, read `terminationReason`; it
   should mention `run-pack-review.ps1`, not `run-pack-review-claude.ps1`.

**Prompt:** Codex loads `prompts/codex_review_prompt.md` from the **review
worktree** (PR head). No extra env vars required.

## Switch to Claude Sonnet (temporary, e.g. Codex quota)

Use when Codex CLI is unavailable but `claude` (Claude Code) is installed and
authenticated.

1. **Edit** live `agent-orchestrator.yaml`. Replace **REVIEW_COMMAND** with the
   Claude line from the table (`scripts/run-pack-review-claude.ps1` — tracked,
   same relative path as Codex).

2. **Do not** embed `"` or inline `--command …` inside the `orchestratorRules:`
   literal — pass `--command` only on the `ao review run` shell invocation. See
   [migration_notes.md](migration_notes.md) § Issue #55.

3. **Restart AO** (same as Codex switch above).

4. **Preflight Claude**
   - `claude --version` on PATH
   - Default model in wrapper: `claude-sonnet-4-6` (override with `--model` in
     forward args when supported)

5. **Smoke one review** — same `ao review run` pattern with the Claude
   **REVIEW_COMMAND**; `terminationReason` on failure should reference
   `run-pack-review-claude.ps1`.

**Prompt:** The tracked wrapper sets `AO_CODEX_REVIEW_PROMPT_FILE` to
`<workspace>/prompts/codex_review_prompt.md` when present so the PR-head prompt
is used. Parser remains `plugins/ao-codex-pr-reviewer`.

### Deprecated `.ao/` bridge

Gitignored `<pack-root>/.ao/run-pack-review-claude.ps1` was an early operator
bridge. It is **deprecated** — use `scripts/run-pack-review-claude.ps1` in
`op-rev-*` worktrees. An optional one-release forwarder under `.ao/` may still
exist locally but must not be the canonical **REVIEW_COMMAND**.

## After any switch

| Check | Command / signal |
|-------|------------------|
| Rules reloaded | Orchestrator session restarted after YAML edit |
| Command in use | Latest run's `terminationReason` names the expected `run-pack-review*.ps1` |
| Clean vs failed | `ao review list <project> --json` — only `clean` + `findingCount: 0` is clean; `failed` with 0 findings is not |
| Strict gate (operator) | `pwsh -File scripts/orchestrator-diagnose.ps1 -Strict` |
| Stale runs | After `gh pr update-branch`, head SHA changes; prior `clean` runs are `outdated` — trigger one new review on current head before merge |

Update operator notes (e.g. `.ao-orchestrator-status.txt`, recovery ping) so the
next session does not copy the wrong **REVIEW_COMMAND**.

## Troubleshooting

| Symptom | Likely cause | Action |
|---------|----------------|--------|
| Review fails immediately, file not found | Wrong or absolute path to deprecated `.ao/` bridge | Use relative `scripts/run-pack-review-claude.ps1` from worktree |
| `scope-context-unavailable` | No `--pr-number` / issue scope | Wrapper auto-detects PR via `gh` when available; or pass `--pr-number N` in forward args |
| Finding body is `npm ci` output | Preflight stdout not silenced | Tracked Claude wrapper redirects `npm ci` off stdout |
| `not NO_FINDINGS or structured JSON` | Model returned prose | Re-run once; ensure prompt includes output contract; check Claude JSON `result` field extraction |
| Codex `exited 1` / usage limit | Quota | Switch to Sonnet temporarily or wait for reset |
| Orchestrator never picks new command | No restart | `ao stop` / `ao start` |
| Strict gate fails on drift | Wrong script ran vs YAML | Read `terminationReason`; align `--command` with **REVIEW_COMMAND** |

## Related docs

- [`orchestrator-autoloop-go-live.md`](orchestrator-autoloop-go-live.md) — three processes, verification table
- [`migration_notes.md`](migration_notes.md) — § Issue #60 (preflight, failed ≠ clean), § Issue #55 (quotes), § Claude tracked wrapper
- [`architecture.md`](architecture.md#review-paths) — review paths overview
- [`plugins/ao-codex-pr-reviewer/README.md`](../plugins/ao-codex-pr-reviewer/README.md) — parser and prompt contract
