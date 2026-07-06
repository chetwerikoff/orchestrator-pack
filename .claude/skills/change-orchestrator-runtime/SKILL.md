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

## WHY this is NOT "edit the YAML and restart" (4 traps)

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
4. **AO 0.10.x stores the live registered project config in `~/.ao/data/ao.db`.**
   The repo-local YAML can say `cursor` while `ao project get orchestrator-pack`
   still says `orchestrator.agent: opencode`; the daemon follows the registered
   project config.

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
- AO 0.10.x registered config (also update here):
  - inspect: `ao project get orchestrator-pack --json`
  - replace: `ao project set-config orchestrator-pack --config-json '<full-object>'`
  - WARNING: `ao project set-config --orchestrator-agent cursor` replaces the
    config object in AO 0.10.2; preserve `sessionPrefix`, `env`, and `worker`.
- AO 0.10.x runtime data: `~/.ao/data/`
  - worktree: `worktrees/orchestrator-pack/orchestrator/opk-orchestrator`
  - daemon state: `running.json`, `ao.db`
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
- In AO 0.10.x registered config: set the same runtime with a full-object
  replacement, e.g. keep `worker.agent: cursor`, `sessionPrefix: opk`, and
  project `env` while changing `orchestrator.agent`.
- The opencode shim is irrelevant — those runtimes deliver turns natively, bug
  #2115 does not apply. Leave the shim in place (it only triggers on the
  `opencode --session` form).
- These runtimes are full tool-loop agents (unlike opencode-deepseek they do NOT
  need the `--dangerously-skip-permissions` workaround).
- Cursor Agent compatibility check:
  `cursor-agent -p --output-format stream-json --trust` may fail with
  `Error: No prompt provided for print mode`. If AO launches exactly that shape,
  install a local compatibility wrapper at `~/.local/bin/cursor-agent` that
  preserves normal calls but strips `--print`, `--output-format`, and `--trust`
  for AO's promptless tmux launch, then execs the real Cursor Agent. Verify in
  tmux that the screen shows Cursor Agent, not that error.
- → **APPLY PROCEDURE** (traps 1–3 are the same).

## APPLY PROCEDURE (required for every scenario)

AO 0.10.x current CLI:

```bash
P=orchestrator-pack ; S=opk-orchestrator

# 1. Edit agent-orchestrator.yaml if it is still used by your flow.

# 2. Update the registered project config too; preserve the full object.
ao project get "$P" --json
ao project set-config "$P" --config-json '{
  "defaultBranch":"main",
  "sessionPrefix":"opk",
  "env":{
    "PACK_REVIEWER":"codex",
    "PATH":"/home/che/projects/orchestrator-pack/scripts:/home/che/.local/bin:/home/che/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  },
  "agentConfig":{},
  "worker":{"agent":"cursor","agentConfig":{}},
  "orchestrator":{"agent":"cursor","agentConfig":{}}
}' --json

# 3. Stop daemon and kill stale tmux/runtime processes.
ao stop --timeout 10s || true
tmux list-sessions -F '#{session_name}' 2>/dev/null | grep '^orchestrator-pack-' |
  xargs -r -n1 tmux kill-session -t
pkill -f '/home/che/.npm-global/bin/opencode' 2>/dev/null || true
pkill -f '/home/che/.local/share/cursor-agent/.*/index.js worker-server' 2>/dev/null || true

# 4. Remove stale current worktree/session prompt so AO fresh-spawns.
rm -rf "$HOME/.ao/data/worktrees/$P/orchestrator/$S"
rm -f "$HOME/.agent-orchestrator/projects/$P/orchestrator-prompt-$S.md"
if [ -f "$HOME/.agent-orchestrator/projects/$P/sessions/$S.json" ]; then
  mkdir -p "$HOME/.agent-orchestrator/projects/$P/session-backups"
  mv "$HOME/.agent-orchestrator/projects/$P/sessions/$S.json" \
    "$HOME/.agent-orchestrator/projects/$P/session-backups/$S.$(date +%Y%m%d-%H%M%S).json"
fi

# 5. Start desktop-owned daemon.
ao start --json
```

Legacy AO 0.9.x procedure:

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

AO 0.10.x:

```bash
ao status
ao project get orchestrator-pack --json    # expect orchestrator.agent == cursor
ao orchestrator ls --json                  # expect active harness == cursor
tmux list-panes -a -F '#{session_name} #{pane_current_command}'
pgrep -af 'opencode|deepseek|cursor-agent'
tmux capture-pane -pt orchestrator-pack-<N>:0.0 -S -80
```

Expected:
- the active orchestrator is non-terminated and `harness: cursor`;
- tmux command uses `~/.local/bin/cursor-agent`, not opencode/deepseek;
- captured pane does not show `No prompt provided for print mode`;
- no unexpected spawned worker sessions remain unless the operator asked for one.

Legacy AO 0.9.x:

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
- **Cursor on AO 0.10.2 may need the local `cursor-agent` compatibility wrapper**
  described above until AO passes a valid prompt or uses an interactive launch
  shape. Keep the wrapper outside the repo (`~/.local/bin/cursor-agent`) and
  leave the real binary under `~/.local/share/cursor-agent/versions/...`.
- **Disable the shim** (revert to stock opencode delivery):
  `rm ~/.local/bin/opencode && ln -s ~/.npm-global/bin/opencode ~/.local/bin/opencode`
- **Do not "just restart."** The only correct path is the APPLY PROCEDURE.
- `agent-orchestrator.yaml` is local gitignored config; edits do not reach git.
