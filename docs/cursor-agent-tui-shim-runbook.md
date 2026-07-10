# Cursor-agent TUI shim (Issue #725)

Pack-owned argv interposition on `~/.local/bin/cursor-agent` restores interactive
Composer TUI for AO worker tmux panes while preserving stock headless behavior for
reviews, draft-author nohup runs, piped consumers, and manual use.

## Install (once per AO Cursor host)

From the pack root after merge:

```powershell
pwsh -NoProfile -File scripts/install-cursor-agent-tui-shim.ps1
```

This copies the tracked shim to `~/.local/share/orchestrator-pack/cursor-agent-tui-shim.sh`
and symlinks `~/.local/bin/cursor-agent` at that script. **`~/.local/bin/agent` is never
modified** — trust bootstrap depends on headless `agent -p`.

## Verify (offline, no LLM turn)

```powershell
pwsh -NoProfile -File scripts/verify-cursor-agent-tui-shim.ps1
```

Checks:

- Topological: `cursor-agent` resolves to the pack shim (symlink **and** regular-file
  clobber shapes).
- Behavioral translate path: worker `AO_SESSION_ID` + `-p` + `stream-json` through a real
  PTY (`script -qec`) → TUI attach, not immediate headless exit.
- Behavioral passthrough: non-worker signatures → stock headless behavior.
- Trust-watcher running-state (read-only): distinct signal when
  `orchestrator-worktree-trust-watcher.ps1` is absent.

Failures emit stderr JSON alerts and optionally append to `AO_FLEET_HYGIENE_ALERT_FILE`
(same sink as fleet hygiene sentinel #711).

**PTY trap:** do not probe via `tmux new-session` + `send-keys` — documented invalid
instant-exit artifact. Use `script -qec` only.

## Drift self-heal

When `orchestrator-worktree-trust-watcher.ps1` is running, each poll cycle (~8s default)
re-applies the shim symlink if cursor-agent self-update clobbered `~/.local/bin/cursor-agent`
(symlink repoint **or** regular-file replace). Self-heal logs and alerts loudly — not silent
repair.

Bounded latency = trust-watcher poll interval. Confirm after `cursor-agent update`:

```powershell
pwsh -NoProfile -File scripts/verify-cursor-agent-tui-shim.ps1
```

## Rollback

Restore stock cursor-agent (does **not** touch `agent`):

```bash
ln -sf "$(ls -d ~/.local/share/cursor-agent/versions/2026* | sort | tail -1)/cursor-agent" ~/.local/bin/cursor-agent
```

Stop relying on pack interposition by keeping the stock symlink and not re-running install.
See [`docs/migration_notes.md`](migration_notes.md) for operator adoption checklist.

## Translate branch contract

Translation runs only when **all** hold:

1. stdout is a TTY;
2. `AO_SESSION_ID` matches `^orchestrator-pack-[0-9]+$`;
3. argv contains `-p` or `--print` **and** `stream-json`.

Then the shim drops `-p`, `--print`, `--trust`, and `--output-format <val>` and execs the
newest real binary under `~/.local/share/cursor-agent/versions/2026*`. Otherwise argv is
passed through unchanged.
