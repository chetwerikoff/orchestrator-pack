# Worker smoke testing (Issues #1061 and #1138)

Workers prove operator-visible behavior with a **head-bound Orca smoke run** before
`ready_for_review`. CI remains mandatory and separate. Issue #1138 adds progress-aware
deadlines, durable spawn state, cooperative cancellation, deterministic recovery, and an
orthogonal lifecycle-cleanliness gate without changing Browser-GPT transport or smoke report
authority.

## When smoke is required

| Issue body signal | Worker gate |
|---|---|
| No `smoke-test-plan` fence + `smoke-plan-floor` grandfather marker | Smoke not required (legacy queue only) |
| No `smoke-test-plan` fence on an action-producing Issue without grandfather marker | Smoke required; missing plan blocks handoff |
| `smoke-test-plan` with `not-applicable: true` + reason | Smoke skipped |
| `smoke-test-plan` with scenarios | Smoke required for the current PR head |

New action-producing tasks must declare a plan during authoring:

```bash
node scripts/draft-discipline.mjs smoke-test-plan --draft path/to/issue-body.md
```

## Supported worker path

```bash
export PATH="$PWD/scripts:$PATH"
worker-smoke-run run \
  --issue <N> \
  --pr <PR> \
  --head-sha <40-hex> \
  --issue-body-file /tmp/issue-body.md \
  --repo-root "$PWD" \
  --cwd "$PWD"
```

The supported lifecycle is:

1. `orca worktree current --json` positively binds the supplied cwd to the existing
   Orca-managed worktree.
2. A smoke-only admission lock is acquired. Deterministic preflight classifies and safely
   cleans prior worker-smoke state before any new child is created.
3. The run id, run directory, and `lifecycle.json` reservation are durably written before
   terminal creation. The create subprocess has a finite timeout.
4. A successful create response must return a terminal handle. That handle is written to the
   same registry before prompt delivery; no title/list/recency heuristic may replace it.
5. Publish-complete delivery and sealed current-run completion retain the Issue #1115 contract.
6. After delivery, only legal child-produced declared-scenario transitions refresh the stall
   deadline. A separate absolute safety ceiling is never reset.
7. Every terminal path converges on the same cancellation/cleanup routine. Only the recorded
   handle may be closed. Operator-action files are tombstoned and `terminal.json` records the
   result even when no PR smoke report is published.
8. The PR comment is published only after owned-terminal cleanup. `gate-check` independently
   requires both current-head smoke/CI evidence and clean lifecycle state.

## Report and control-plane semantics

Top-level `PASS | FAIL | BLOCKED`, current-head report selection, receipt/provenance checks, and
latest-same-head revocation remain unchanged. Pack-generated non-PASS causes continue to include
zero parsed scenarios, missing/invalid agent reports, and executed scenario failures.

Issue #1125 control-plane classification also remains unchanged:

| Phase | Stable cause |
|---|---|
| `worktree current` or terminal create cannot launch, returns empty stdout, or returns malformed JSON before a handle is acquired | `orca_control_plane_unavailable_preflight` |
| send/read/submit/close returns a recognized channel code after a handle is acquired | `orca_control_plane_lost_mid_smoke` |

`orca worktree current` is still the only positive worktree authority. The harness does not
restart Orca, reconnect, discover sockets, select another worktree, or promote arbitrary valid
JSON errors into a control-plane cause.

## Delivery and completion authority

Each attempt has one run identity. Delivery requires `delivery.sealed.json` bound to that run;
`terminal send` success alone is not proof. Ambiguous delivery never authorizes a full-prompt
resend. The existing visible-bracketed-paste recovery may submit Enter without re-sending text.
Delivery establishment is separately bounded to **10 minutes** and cannot be extended by scenario
progress that has not begun.

Completion is accepted only from one publish-complete current-run pair:

```text
completion-<sha256>.body
completion-<sha256>.sealed.json
```

The seal must bind the current run and exact body digest. Partial bytes, PTY text, in-memory
lookalikes, wrong-run artifacts, malformed reports, and duplicate terminalizations do not become a
PASS. PTY reads remain secondary liveness/diagnostic evidence only.

## Finite scenario progress and deadlines

After delivery, the child appends progress events to `progress.ndjson`. For each Issue-declared
scenario ordinal, the only accepted sequence is:

```text
not_started -> started -> terminal(pass|fail|blocked|skipped)
```

An event advances progress only when it is durable, binds the current run, names the next declared
ordinal, and is the next legal transition. The following never refresh stall age:

- wrong-run or stale bytes;
- unknown ordinals;
- duplicate or backward transitions;
- terminal-before-start, post-terminal, or non-monotonic transitions;
- free-form milestones, heartbeats, mtime/byte growth, PTY chatter, or process liveness;
- anything written by the supervisor.

Production defaults:

| Bound | Default | Meaning |
|---|---:|---|
| terminal create | 60 seconds | `spawnSync` cannot block the parent indefinitely |
| delivery | 10 minutes | delivery must seal before scenario waiting starts |
| progress stall | 25 minutes | no accepted declared-scenario transition during this interval terminates as `progress_stall` |
| absolute lifecycle ceiling | 4 hours | terminates as `absolute_safety_ceiling`; progress never resets it |
| cooperative shutdown | 2 minutes | bounded wait for child acknowledgement or sealed completion before handle close |

The absolute ceiling starts with lifecycle reservation/create and is not granted again after
another phase. A legal slow plan may therefore run beyond the former 30-minute wall, while true
stall and absolute-ceiling outcomes remain mechanically distinct.

## Child-only progress and cancellation protocol

The smoke prompt names the run-local progress, cancel-request, and acknowledgement paths. The
registered child must:

1. append `started` before each declared scenario;
2. append one terminal outcome after that scenario;
3. check `cancel-request.json` between scenarios, before each new Browser-GPT turn, and immediately
   after an already-started turn returns;
4. after cancellation, start no new scenario or turn and write current-run cancellation
   acknowledgement or ordinary sealed completion.

The supervisor may create the run, deliver/nudge the prompt, observe durable artifacts, write the
cancel request, wait, and clean the bound child. It has no production path that writes accepted
progress or completion. Browser-GPT send-once, owned-tab, sibling-independence, and final-capture
behavior remain owned by Issues #1120 and #1140 and are not reimplemented here.

## Durable spawn state and ambiguity recovery

`lifecycle.json` records a finite per-run state such as reservation, create in progress, bound,
ambiguous unbound, cleanup pending, clean, or cleanup failed. It is not a lease, daemon, heartbeat,
global process database, or general scheduler.

When create times out, is cancelled, returns no output, returns malformed output, or otherwise
cannot prove a handle, the reservation becomes `ambiguous_unbound`. On a later supported preflight
it may become `abandoned_unbound` only when all current-run evidence says execution never began:

- no handle was durably bound;
- no delivery seal exists;
- no accepted progress exists;
- no completion seal or cancellation acknowledgement exists.

The original ambiguity diagnostic remains durable. Any unattributable terminal is left alone:
without a bound handle the parent never delivered the prompt, so it neither adopts nor kills that
terminal. Any delivery/execution evidence forbids abandonment and keeps the state blocking.

## Cancellation, cleanup, and restart recovery

Cancellation, operator stop, supported termination signal, delivery exhaustion, progress stall,
absolute ceiling, child verdict, handled exception, and restart recovery use one ownership-scoped
cleanup contract:

1. stop admitting new scenario work;
2. write an idempotent current-run cancel request when an active child is being stopped;
3. wait at most the shutdown bound for child acknowledgement/completion;
4. close only handles durably recorded in that run registry;
5. tombstone `live/OPERATOR-ACTION-*.txt` before declaring the run clean;
6. write `terminal.json` with reason, acknowledgement observation, close outcome, and cleanup
   result;
7. remain idempotent on retry: a clean/abandoned entry is not closed or terminalized again.

No terminal-list lookup, title matching, process scan, or recency heuristic is cleanup authority.
Unrelated or unattributable Browser-GPT work is never killed, adopted, or made blocking merely
because it exists.

The earlier documentation-only caveat is revised as follows: automatic harness teardown now has a
candidate implementation in `worker-smoke-run`, but the implementation PR must remain draft until
a current-head reduced-threshold lifecycle canary and required CI pass. A failed or unavailable
canary is not permission to claim runtime verification or mark the PR ready.

## Deterministic preflight and concurrent starts

Before create, preflight performs one bounded classify/clean/re-evaluate pass:

- stale smoke admission owned by a dead supervisor may be removed;
- safely removable operator files are tombstoned;
- expired unbound create reservations are classified and abandoned only under the evidence rules
  above;
- bound/incomplete prior runs are closed by their recorded handle only;
- corrupt state, failed close, executable ambiguous state, or unsafe routing state remains blocking.

Admission uses a worker-smoke-only create-once lock. At most one concurrent `worker-smoke-run run`
may cross the spawn boundary. The loser refuses without touching the winner. This is not a global
Browser-GPT lock and does not serialize unrelated browser work.

## Readiness gate

`pack-worker-report --state ready_for_review` invokes `worker-smoke-run gate-check`. Handoff is
allowed only when all independent predicates hold:

- the Issue requires smoke and the current PR head has a fully covering pack-produced PASS;
- required CI is green;
- the owned terminal was closed and report provenance/receipt validate;
- there is no active admission, live bound worker-smoke child, incomplete teardown, executable
  ambiguous state, corrupt registry, or unsafe smoke operator-routing file.

A same-head PASS cannot bypass unclean lifecycle state. Operator cancellation may omit a new FAIL
comment, but it still must produce clean durable lifecycle state before admission or handoff.

## Runtime verification and rollback

Run the focused current-head canary with controllable clocks before marking the PR ready:

```bash
npx vitest run scripts/lib/worker-smoke-lifecycle.test.ts
```

The canary must visibly cover: a sealed PASS after virtual elapsed time beyond 30 minutes, a true
stall, continuously progressing absolute-ceiling termination, create timeout ambiguity, concurrent
admission, restart recovery, idempotent bound-only close, and stale operator-file tombstoning.
A real Orca smoke run remains required when the binding Issue's smoke plan requires it.

Rollback is allowed only after current lifecycle state is clean. Do not roll back while a bound
child, active admission, incomplete teardown, or executable ambiguous reservation remains. Durable
historical and `abandoned_unbound` diagnostics may remain; they are non-blocking audit records.

## Orca executable selection

Use `ORCA_CLI_COMMAND` when exported. Otherwise prefer `orca-dev`, then `orca-ide`, then `orca`.
Do not assume `/usr/bin/orca` is the CLI on Linux.
