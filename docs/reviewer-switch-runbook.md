# Switching the local AO reviewer (Codex ↔ Claude Sonnet)

Operator runbook for changing which model runs **local** PR review when the
orchestrator executes `ao review run … --execute --command …`.

AO 0.9.x does not read a `reviewer:` YAML block. The only switch is the
**REVIEW_COMMAND** line in live `agent-orchestrator.yaml` →
`projects.<id>.orchestratorRules`, plus a restart so the orchestrator reloads
the rules.

Both paths use the same pack contract (`prompts/codex_review_prompt.md`,
`NO_FINDINGS`, structured JSON findings, `plugins/ao-codex-pr-reviewer` parser).
Only the **executor** behind the wrapper changes.

## Defaults

| Reviewer | REVIEW_COMMAND (run from AO `op-rev-*` workspace cwd) | In repo? |
|----------|--------------------------------------------------------|----------|
| **Codex** (canonical) | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/run-pack-review.ps1 --repo-root . --base origin/main` | Yes — `scripts/run-pack-review.ps1` |
| **Claude Sonnet** (temporary) | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <pack-root>/.ao/run-pack-review-claude.ps1 --repo-root . --base origin/main` | No — `.ao/` is gitignored; operator-maintained on each machine |

Copy the canonical Codex line from `agent-orchestrator.yaml.example`
(`orchestratorRules` → **NAMED REVIEW_COMMAND**).

## Switch to Codex (e.g. after a Sonnet trial)

1. **Edit** live `agent-orchestrator.yaml` (gitignored). Replace **REVIEW_COMMAND**
   with the Codex line from the table above (relative `scripts/run-pack-review.ps1`
   only — do not use the `.ao/` bridge path).

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

5. **Leave `.ao/` in place** — unused bridge scripts do not affect Codex.

**Prompt:** Codex loads `prompts/codex_review_prompt.md` from the **review
worktree** (PR head). No extra env vars required.

## Switch to Claude Sonnet (temporary, e.g. Codex quota)

Use when Codex CLI is unavailable but `claude` (Claude Code) is installed and
authenticated.

1. **Install the local bridge** under `<pack-root>/.ao/` (gitignored), if not
   already present:
   - `run-pack-review-claude.ps1` — `npm ci`, build prompt via `review.ts
     --prompt-only`, run `claude --print`, parse through pack `review.ts` fixture
     path
   - `emit-claude-fixture-review.mjs` — feeds Claude stdout into the same parser
     as Codex

   The bridge must:
   - Use an **absolute** path to `run-pack-review-claude.ps1` in **REVIEW_COMMAND**
     (AO workspaces under `code-reviews/workspaces/op-rev-*` do **not** contain
     gitignored `.ao/`)
   - Set `AO_CODEX_REVIEW_PROMPT_FILE` to `<workspace>/prompts/codex_review_prompt.md`
     so the PR-head prompt is used (pack checkout alone may lag `main`)
   - Auto-append `--pr-number` when resolvable from `git rev-parse HEAD` + `gh pr list`
   - Keep `npm ci` off stdout (AO treats review-command stdout as reviewer output)

   Example **REVIEW_COMMAND** (adjust drive letter / path):
   ```text
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:/Users/<you>/Documents/Projects/orchestrator-pack/.ao/run-pack-review-claude.ps1 --repo-root . --base origin/main
   ```

2. **Do not** embed `"` or inline `--command …` inside the `orchestratorRules:`
   literal — pass `--command` only on the `ao review run` shell invocation. See
   [migration_notes.md](migration_notes.md) § Issue #55.

3. **Restart AO** (same as Codex switch above).

4. **Preflight Claude**
   - `claude --version` on PATH
   - Model default in bridge: `claude-sonnet-4-6` (override with `--model` in
     forward args if the script supports it)

5. **Smoke one review** — same `ao review run` pattern; `terminationReason` on
   failure should reference `run-pack-review-claude.ps1`.

**Prompt:** Same `prompts/codex_review_prompt.md` contract; executor is Claude,
parser remains `plugins/ao-codex-pr-reviewer`.

## After any switch

| Check | Command / signal |
|-------|------------------|
| Rules reloaded | Orchestrator session restarted after YAML edit |
| Command in use | Latest run's `terminationReason` names the expected `.ps1` |
| Clean vs failed | `ao review list <project> --json` — only `clean` + `findingCount: 0` is clean; `failed` with 0 findings is not |
| Stale runs | After `gh pr update-branch`, head SHA changes; prior `clean` runs are `outdated` — trigger one new review on current head before merge |

Update operator notes (e.g. `.ao-orchestrator-status.txt`, recovery ping) so the
next session does not copy the wrong **REVIEW_COMMAND**.

## Troubleshooting

| Symptom | Likely cause | Action |
|---------|----------------|--------|
| Review fails immediately, file not found | Relative `.ao/...` in REVIEW_COMMAND | Use absolute pack-root path to bridge |
| `scope-context-unavailable` | No `--pr-number` / issue scope | Bridge should auto-detect PR; or pass `--pr-number N` in forward args |
| Finding body is `npm ci` output | Preflight stdout not silenced | Bridge must redirect `npm ci` away from stdout |
| `not NO_FINDINGS or structured JSON` | Model returned prose | Re-run once; ensure prompt includes output contract; check Claude JSON `result` field extraction |
| Codex `exited 1` / usage limit | Quota | Switch to Sonnet temporarily or wait for reset |
| Orchestrator never picks new command | No restart | `ao stop` / `ao start` |

## Related docs

- [`orchestrator-autoloop-go-live.md`](orchestrator-autoloop-go-live.md) — three processes, verification table
- [`migration_notes.md`](migration_notes.md) — § Issue #60 (preflight, failed ≠ clean), § Issue #55 (quotes)
- [`architecture.md`](architecture.md#review-paths) — review paths overview
- [`plugins/ao-codex-pr-reviewer/README.md`](../plugins/ao-codex-pr-reviewer/README.md) — parser and prompt contract
