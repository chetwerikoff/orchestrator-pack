# tmux CI-nudge suppression shim (operator-local, 2026-07-15)

Operator-local `tmux` PATH shim that drops AO 0.10.2's native, unconditional CI-failure
nudge before it ever reaches a worker's tmux pane. Not a pack-owned/tracked artifact — no
install script, no PR, no Issue. See
[`docs/architecture.md`](architecture.md#native-ao-ci-nudge-suppression-operator-local-tmux-shim-2026-07-15)
and [`docs/issues_drafts/00-architecture-decisions.md`](issues_drafts/00-architecture-decisions.md)
§W for the full rationale (why a daemon binary patch was rejected, why the PATH shim
survives AO updates, why the paired `Enter` must be dropped too).

## What it does

Intercepts every `tmux` invocation the AO daemon makes (it shells out to the real `tmux`
CLI via `internal/adapters/runtime/tmux.execRunner.Run`). Drops only:

- a literal `send-keys -l` payload containing `"CI is failing on your PR. Review the
  output below and push a fix."`;
- the immediately-following `send-keys ... Enter` to the **same** target, within a short
  TTL (default 10s) — otherwise a bare `Enter` would fire into whatever the worker is
  mid-typing once the nudge text itself never lands.

Everything else (session lifecycle, review-finding pastes, ordinary worker key sends)
passes straight through to the real binary, unchanged. Any parsing ambiguity falls open to
passthrough, never to drop.

## Install (per operator host)

```bash
cp /path/to/tmux-shim ~/.local/bin/tmux   # see "Current source" below
chmod +x ~/.local/bin/tmux
command -v tmux   # must print ~/.local/bin/tmux (PATH already puts it ahead of /usr/bin)
```

**Restart the AO daemon after install.** The daemon resolves `tmux`'s path once at process
start, not per call (confirmed empirically) — a shim installed while the daemon is already
running has no effect until the daemon restarts:

```bash
ao stop
ao start   # may print the "desktop app" launcher notice; poll `ao status` until ready
```

Live tmux worker sessions are unaffected by an AO daemon restart — tmux itself is a
separate process the daemon merely talks to.

## Verify

```bash
~/.local/bin/tmux -V                 # passthrough sanity: must print the real tmux version
~/.local/bin/tmux list-sessions      # passthrough sanity: must list real live sessions
tail -f ~/.local/state/tmux-ci-nudge-shim/log.jsonl   # watch drops as they happen
```

`ao status` should report `pid` as a **new** number after restart, and its `PATH` (via
`tr '\0' '\n' < /proc/<pid>/environ | grep PATH`) must still list `~/.local/bin` ahead of
`/usr/bin`.

There is no offline reproduction of the live daemon's exact nudge invocation — confidence
comes from an isolated test harness (fake `tmux` stand-in, 10/10 cases: nudge dropped,
paired Enter dropped, unrelated sends/Enters pass through, non-`send-keys` commands pass
through, stale marker does not suppress a late Enter) plus the log going quiet for that
message class in production. If the log stays empty across a real CI failure, the shim
did not intercept it — check `command -v tmux` under the daemon's actual environment; the
daemon likely was not restarted after install, or something else changed the daemon's PATH
back to resolving the system `tmux` first.

## Rollback

```bash
rm ~/.local/bin/tmux
ao stop && ao start
```

No self-heal, no drift-repair loop (unlike the `cursor-agent` TUI shim) — nothing will
re-clobber `~/.local/bin/tmux` on its own, so rollback is just deleting the file plus a
daemon restart.

## Known limitation

Breaks silently (falls back to letting nudges through, not to a crash) if AO ever stops
shelling out to the `tmux` CLI for `send-keys` and switches to a control-socket protocol
instead. Self-detecting: the audit log goes quiet for `dropped-nudge` / `dropped-paired-enter`
entries while nudges resume appearing in worker panes.

## Current source

The shim script and its isolated test harness (fake `tmux` stand-in + test suite) were
built and verified in a 2026-07-15 session before install; ask the architect session for
the current copy if this file needs to be reinstalled on a new host. Not yet promoted to a
tracked pack script (see §W status note on formalizing this for multi-operator
distribution).
