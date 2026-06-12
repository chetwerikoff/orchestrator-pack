---
name: change-orchestrator-runtime
description: >-
  Change the orchestrator's model, prompt/rules, or runtime and make the change
  actually take effect. Use when the user wants to swap the orchestrator model
  (e.g. a different deepseek/openrouter model), edit orchestratorRules / the
  orchestrator prompt, or switch the orchestrator runtime
  (opencode/codex/cursor/claude) — e.g. «поменяй модель оркестратора», «смени
  промпт оркестратора»,
  «другой оркестратор», «change orchestrator model», «edit orchestrator rules»,
  «switch orchestrator runtime». Editing agent-orchestrator.yaml + `ao start` is
  NOT enough — this skill covers the daemon-cache + session-restore traps and the
  verification that the new rules/model actually loaded.
---

# Change the orchestrator's model or prompt (orchestrator-pack)

Project: `orchestrator-pack` · orchestrator session: `opk-orchestrator`

## WHY this is NOT "edit the YAML and restart" (3 traps)

1. **The daemon caches the config.** A plain `ao start` prints "reattached to
   running daemon" and does NOT re-read the YAML. → you must `ao stop --all`,
   not just restart the session.
2. **The orchestrator is a persisted session that AO RESTORES.** On restore the
   generated `orchestrator-prompt-*.md` and `AGENTS.md` are NOT regenerated —
   the old rules/model stay baked into them forever.
3. **The session metadata** `sessions/opk-orchestrator.json` is what makes AO
   restore instead of fresh-spawning. While it exists, edits never land.
   (`ao session kill --purge-session` is NOT enough — start then fails with
   "cannot be restored: OpenCode session mapping is missing".)

Bottom line: to apply ANY change you must force AO to do a FRESH spawn of the
orchestrator. The APPLY PROCEDURE below does exactly that. Traps 1–3 are
runtime-independent; the opencode shim is opencode-only.

## FILE MAP

- Config (edit here): `agent-orchestrator.yaml` (repo root; local, gitignored)
  - orchestrator block: `projects.orchestrator-pack.orchestrator`
    - `agent:` — runtime (opencode / codex / cursor / claude-code …)
    - `agentConfig.model:` — model
    - `agentConfig.permissions:` — permission mode
  - `projects.orchestrator-pack.orchestratorRules: |` — orchestrator rules/prompt
- AO data: `~/.agent-orchestrator/projects/orchestrator-pack/`
  - `sessions/opk-orchestrator.json`            ← session metadata (trap #3)
  - `orchestrator-prompt-opk-orchestrator.md`   ← generated prompt (goes stale)
  - `worktrees/opk-orchestrator/AGENTS.md`       ← opencode's copy of the prompt
  - `session-backups/`                           ← back the metadata up here
- opencode delivery shim: `~/.local/bin/opencode` (real binary
  `~/.npm-global/bin/opencode`); log `~/.agent-orchestrator/opencode-shim/bridge.log`
  - Why: AO 0.9.2 does not deliver turns into the opencode TUI (upstream bug
    AgentWrapper/agent-orchestrator#2115). The shim converts delivery to
    `opencode run --session`. Needed ONLY while the orchestrator runs on opencode.

## SCENARIO A — different MODEL on the same opencode runtime

1. In YAML: `orchestrator.agentConfig.model: <new-model>` (opencode provider
   format, e.g. `deepseek/deepseek-v4-flash`).
2. Make sure opencode has access to the new model's provider (key in env /
   `opencode auth`). deepseek works because `DEEPSEEK_API_KEY` is supplied via
   `BASH_ENV=~/.config/deepseek/coworker.env`. A new model needs its own creds.
3. No shim edit needed: it reads `--model` from AO's launch and forwards it.
4. → run the **APPLY PROCEDURE**.
5. Extra check: `grep 'model=' ~/.agent-orchestrator/opencode-shim/bridge.log | tail -1`
   should show the new model.

## SCENARIO B — different PROMPT / RULES

The "orchestrator prompt" is two surfaces:
- **Rules (usually what you want):** `orchestratorRules` in the YAML — go into
  `AGENTS.md` / the prompt file on a fresh spawn.
- **Kickoff nudge** ("start your turn") — a `KICKOFF` CONSTANT inside the shim
  `~/.local/bin/opencode`. Edit only to change the start message itself (e.g.
  make the turn "observe only, do not spawn").

Then → **APPLY PROCEDURE**.

## SCENARIO C — switch the RUNTIME (codex / cursor / claude-code)

- In YAML: `orchestrator.agent: <codex|cursor|claude-code>` (+ model if needed).
- The opencode shim is irrelevant — those runtimes deliver turns natively, bug
  #2115 does not apply. Leave the shim in place (it only triggers on the
  `opencode --session` form).
- These runtimes are full tool-loop agents (unlike opencode-deepseek they do NOT
  need the `--dangerously-skip-permissions` workaround).
- → **APPLY PROCEDURE** (traps 1–3 are the same).

## APPLY PROCEDURE (required for every scenario)

```bash
P=orchestrator-pack ; S=opk-orchestrator
AO=~/.agent-orchestrator/projects/$P

# 1. (you already edited agent-orchestrator.yaml)

# 2. kill the DAEMON (not just the session — else it reattaches and ignores edits)
ao stop --all -y

# 3. force a FRESH spawn: back up + remove the session metadata and the stale prompt
mkdir -p "$AO/session-backups"
mv "$AO/sessions/$S.json" "$AO/session-backups/$S.$(date +%Y%m%d-%H%M%S).json"
rm -f "$AO/orchestrator-prompt-$S.md"
# (AO recreates the worktree and AGENTS.md itself)

# 4. start (it becomes a foreground daemon → background it with nohup)
cd "$HOME/projects/$P"
nohup ao start "$P" >/tmp/ao-start.log 2>&1 &

# 5. wait and check
sleep 12
grep -iE "Orchestrator session ready|setup failed|error" /tmp/ao-start.log
```

## VERIFY (do not trust "applied" without this)

```bash
P=orchestrator-pack ; S=opk-orchestrator
AO=~/.agent-orchestrator/projects/$P
PF="$AO/orchestrator-prompt-$S.md"
AG="$AO/worktrees/$S/AGENTS.md"

# both mtimes must be FRESH (just now)
stat -c '%y %n' "$PF" "$AG"

# new text PRESENT, old text ABSENT — in BOTH files
grep -c "NEW_EXPECTED_TEXT" "$PF" "$AG"      # expect >0
grep -c "OLD_TEXT"          "$PF" "$AG"      # expect 0

# behavior: after the kickoff turn there must be no unexpected spawns (manual mode)
sleep 60
ao status                                     # expect (no active sessions)
pgrep -af worker-prompt-opk                    # expect empty
```

If after restart `grep` still shows the OLD text / mtime is not fresh → the
session metadata was not removed (step 3) or the daemon was not killed (step 2).
Repeat.

## IMPORTANT NOTES

- **Manual spawn mode is intentional.** `orchestratorRules` contains
  `OPERATOR-GATED SPAWN` — the orchestrator must NOT pull issues into work on its
  own; work starts only via the operator's `ao spawn`. Do not remove this unless
  you want an autonomous orchestrator. If it still spawns, harden the shim
  `KICKOFF` to "observe only".
- **opencode-deepseek needs `--dangerously-skip-permissions`** (else it
  auto-rejects shell tools). Already in the shim. Not needed for codex/cursor/claude.
- **Disable the shim** (revert to stock opencode delivery):
  `rm ~/.local/bin/opencode && ln -s ~/.npm-global/bin/opencode ~/.local/bin/opencode`
- **Do not "just restart."** The only correct path is the APPLY PROCEDURE.
- `agent-orchestrator.yaml` is local gitignored config; edits do not reach git.
