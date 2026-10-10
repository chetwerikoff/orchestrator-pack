# Coordinator fleet alarm

The fleet alarm is an operator-installed, per-project advisory notifier on the
existing fleet-wake tick. It reads agent panes and existing Orca worker/Task/Dispatch
and terminal evidence, GPT terminal envelopes and selected-repository PR/review/CI
status through tracked GitHub transport. It already sends direct GPT/CI event
messages to eligible units; it also sends narrowly verified PARKED producer Wake
and elapsed-park Reminder messages to the exact live Task/Dispatch unit. Each new
unit message requests an **independent producer re-check**, not execution,
resend, merge, approval or continuation authority. Failed/ambiguous evidence
goes to the coordinator, never an invented producer completion.

The tick only writes its existing ephemeral per-project notifier marks, park
clock and coordinator-signature state. It does not mutate GitHub, Task/Dispatch
or runtime business state, install services, create a second transport, or join
the scheduler, supervisor or side-process registry.

`fleet-sweep.ts` reports matching project agent panes as `busy`, `STOPPED`,
`POLLING`, or `PARKED`. `POLLING` needs polling evidence on two consecutive
sweeps; its previous-sweep marks are ephemeral under
`$XDG_RUNTIME_DIR/fleet-sweep/<project>/`. `PARKED` panes retain their own wait; supported named producers are checked
only for verified seven-field live Task/Dispatch matches. Terminal disappearance
and shell-idle status never count as producer completion. Unsupported, missing
or ambiguous producer evidence is routed to a bounded coordinator alarm.

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

This manual configuration and activation procedure applies to fresh, inactive,
uninstalled or changed service-template cases. Ordinary eligible fleet ticks
require no operator approval. After a separately authorized **code-only merge**
and filesystem adoption, the existing merge-adoption verifier may automatically
use `systemctl --user try-restart` **only** for an already active, registered,
stale fleet-wake unit whose exact project, mapped adopted checkout, MainPID and
process identity have been verified and rechecked before control. It must then
read back a distinct fresh running identity. It never starts an inactive
instance, repairs a failed/mismatched/unverified one or installs/edits env files,
drop-ins or templates; those cases remain `operationally_incomplete` with the
exact adoption remainder for the operator. A fresh already-running process needs
no restart. No operation from a feature worktree is authorized.

Runtime readback after any actual activation must exercise the linked Issue's
fleet regression; a clean-checkout pointer check alone is implementation proof,
not operational verification. The public example contains no machine-specific
values.

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
receives a `Fleet alarm (idle|busy)` message naming all actionable panes. Both idle and busy coordinators receive the first meaningful alarm once, then
another only when the actionable state/question/producer changes or an unchanged
alarm reaches 30 minutes. Cosmetic TUI redraws do not reset that cadence.
Unresolvable or uncertain PARKED producer notifications share the same throttle.
Exact eligible unchanged PARKED units instead receive a shell-inert re-check-only
Reminder once at elapsed 30 minutes, once at 60 minutes, and once in each later
elapsed 30-minute slot; successful producer Wake or a changed park/Task resets
the Reminder clock. New unit effects use a persistent
`attempted_unverified` mark **before** the first send and never automatically
replay that same key after an uncertain/partial send. The current no-coordinator
path returns `no_orchestrator` without any new unit Wake or Reminder.
A failed terminal read skips that tick rather than acting on incomplete evidence.

## Coordinator prompt snippet

At session start, check `systemctl --user status fleet-wake@<project>`. On every
fleet alarm, first process orchestration mail, then run the full `fleet-sweep`.
Give every `STOPPED` or `POLLING` pane its next step in the same turn. A question a
unit typed in its own pane is addressed to the coordinator and must be answered.
For `PARKED` panes, independently recheck each declared producer when a
Wake or Reminder arrives. Never resume, resend or merge solely because the
fleet notifier reported an event; uncertain producer evidence requires
coordinator investigation instead.

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
