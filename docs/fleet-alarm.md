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

Run from the pack checkout with the Node major declared in `scripts/toolchain/node-version.json`:

```bash
node --experimental-strip-types scripts/lib/Invoke-TypeScriptCli.ts \
  --repo-root "$PWD" --script "$PWD/scripts/fleet/fleet-sweep.ts" -- \
  --project my-project
```

The selected project card supplies the primary checkout and matching rules. Use
`--json` for machine-readable output and `--lines <n>` to change the displayed
tail. The sweep itself makes no Orca mutation.

## Install one project instance

Choose a short systemd instance name such as `my-project`. Do not run the old
machine-local reference fleet alarm and the pack service for the same project at
the same time.

```bash
mkdir -p ~/.config/orchestrator-fleet ~/.config/systemd/user ~/.local/state/orchestrator-fleet
cp scripts/fleet/fleet-wake@.service ~/.config/systemd/user/
cp scripts/fleet/fleet-wake.env.example ~/.config/orchestrator-fleet/my-project.env
$EDITOR ~/.config/orchestrator-fleet/my-project.env
systemctl --user edit fleet-wake@my-project # per-instance drop-in shown below
systemctl --user daemon-reload
systemctl --user enable --now fleet-wake@my-project
```

Set `PRIMARY` to the absolute primary checkout path. Optional keys are
`WORKSPACE_RE`, `ORCH_TITLE_RE` (default `Cursor`), `ORCH_HANDLE`,
`ARCHITECT_HANDLE`, `BUSY_RE`, and `FLEET_WAKE_INTERVAL` (default `300` seconds).
The selected project card remains the checkout/matching authority. Render the
service's `{PACK_ROOT}` placeholders with the trusted pack path before installing
it; logs append to `~/.local/state/orchestrator-fleet/my-project.fleet-wake.log`.

`ARCHITECT_HANDLE` optionally excludes one exact Orca terminal handle from fleet
units. Both fleet-wake and the one-off sweep consume this environment key; export
it for the one-off command as well. The excluded pane is not screen-read or
classified, named as a unit in fleet alarms, or directly woken for GPT/CI events
or chat banners. No title or pattern identifies an architect: another pane with
the same title remains eligible. Leaving the key unset preserves normal behavior
and coordinator selection. An explicit chat binding to the excluded handle also
stops ownership lookup; it cannot fall through to another worker.

### Operator-owned environment ingress and activation

The tracked unit does not load a local env file. Editing that file and restarting
alone does not supply `ARCHITECT_HANDLE`. The operator must ensure that the selected
instance has a per-instance drop-in. In `systemctl --user edit fleet-wake@my-project`,
save the following service settings (the default override location is
`~/.config/systemd/user/fleet-wake@my-project.service.d/override.conf`):

```ini
[Service]
EnvironmentFile=%h/.config/orchestrator-fleet/%i.env
```

`%h` is the user's home and `%i` is the selected instance name. Keep the file
operator-owned and populate only intended public fleet settings locally. For an
existing instance, activation happens after remote merge and local filesystem
adoption: the operator updates its selected env file, ensures the drop-in above
exists, then runs:

```bash
systemctl --user daemon-reload
systemctl --user restart fleet-wake@my-project
```

Workers and integration actors do not edit local env files, install the drop-in,
or restart the service. Notify the operator after merge/adoption and await its
activation before invoking any verifier that could automatically restart the
service. Runtime readback follows activation and must exercise the linked Issue's
fleet regression; a clean-checkout pointer check is implementation proof only.
The public example contains no machine-specific values.

Check the service and log:

```bash
systemctl --user status fleet-wake@my-project
tail -f ~/.local/state/orchestrator-fleet/my-project.fleet-wake.log
```

A healthy tick logs `nothing stopped` when there is no actionable pane. If the
project has no matching coordinator pane, it logs `normal fleet result: no
orchestrator pane found` and returns without sending a wake. This is a normal
result for projects without a coordinator pane; it does not log `nothing stopped`
for that tick. When an agent pane is `STOPPED` or `POLLING`, the coordinator
receives a `Fleet alarm (idle|busy)` message naming all actionable panes. An idle
coordinator receives the alarm each interval; a busy coordinator receives a
queued follow-up only when the stopped/polling set changed since the last send. A
failed terminal read skips that tick rather than acting on incomplete evidence.

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
