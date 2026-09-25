# Coordinator fleet alarm

The fleet alarm is an operator-installed, per-project advisory. It reads rendered
Orca terminal screens for agent panes and may send one plain-text wake only to the
project coordinator pane. It never sends to units, reads or mutates
Task/Dispatch/assignment/PR/GitHub state, authorizes an effect, or joins the
scheduler, supervisor, or side-process registry.

`fleet-sweep.ts` reports matching project agent panes as `busy`, `STOPPED`,
`POLLING`, or `PARKED`. `POLLING` needs polling evidence on two consecutive
sweeps; its previous-sweep marks are ephemeral under
`$XDG_RUNTIME_DIR/fleet-sweep/<project>/`. `PARKED` panes are reported but do not
wake the coordinator.

## One-off sweep

Run from the pack checkout with Node 22:

```bash
node --experimental-strip-types scripts/lib/Invoke-TypeScriptCli.ts \
  --repo-root "$PWD" --script "$PWD/scripts/fleet/fleet-sweep.ts" -- \
  --primary "$PWD"
```

Use `--json` for machine-readable output, `--lines <n>` to change the displayed
tail, and `--workspace-re` / `--busy-re` only when the project needs different
matching rules. The sweep itself makes no Orca mutation.

## Install one project instance

Choose a short systemd instance name such as `my-project`. Do not run the old
machine-local reference fleet alarm and the pack service for the same project at
the same time.

```bash
mkdir -p ~/.config/orchestrator-fleet ~/.config/systemd/user ~/.local/state/orchestrator-fleet
cp scripts/fleet/fleet-wake@.service ~/.config/systemd/user/
cp scripts/fleet/fleet-wake.env.example ~/.config/orchestrator-fleet/my-project.env
$EDITOR ~/.config/orchestrator-fleet/my-project.env
systemctl --user daemon-reload
systemctl --user enable --now fleet-wake@my-project
```

Set `PRIMARY` to the absolute primary checkout path. Optional keys are
`WORKSPACE_RE`, `ORCH_TITLE_RE` (default `Cursor`), `ORCH_HANDLE`, `BUSY_RE`, and
`FLEET_WAKE_INTERVAL` (default `300` seconds). The service invokes the pack's
canonical TypeScript wrapper from `PRIMARY` and appends logs to
`~/.local/state/orchestrator-fleet/my-project.fleet-wake.log`.

Check the service and log:

```bash
systemctl --user status fleet-wake@my-project
tail -f ~/.local/state/orchestrator-fleet/my-project.fleet-wake.log
```

A healthy tick logs `nothing stopped` when there is no actionable pane. When an
agent pane is `STOPPED` or `POLLING`, the coordinator receives a `Fleet alarm
(idle|busy)` message naming all actionable panes. An idle coordinator receives the
alarm each interval; a busy coordinator receives a queued follow-up only when the
stopped/polling set changed since the last send. A failed terminal read skips that
tick rather than acting on incomplete evidence.

## Coordinator prompt snippet

At session start, check `systemctl --user status fleet-wake@<project>`. On every
fleet alarm, first process orchestration mail, then run the full `fleet-sweep`.
Give every `STOPPED` or `POLLING` pane its next step in the same turn. A question a
unit typed in its own pane is addressed to the coordinator and must be answered.
Leave `PARKED` panes parked until their declared dependency lands, then resume them.

## Stop or uninstall

```bash
systemctl --user disable --now fleet-wake@my-project
rm -f ~/.config/orchestrator-fleet/my-project.env
systemctl --user daemon-reload
```

Keep `~/.config/systemd/user/fleet-wake@.service` while any other project instance
uses it. After the final project instance is removed, delete the shared template and
run `systemctl --user daemon-reload` once more.

Removing one instance does not affect scheduler/runtime state. Ephemeral polling and
last-sent signature files disappear with the user runtime directory and may also be
removed manually after the service is stopped.
