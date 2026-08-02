# Launch/watch wrappers

These pack-owned Node 22 wrappers are the recommended safe path for starting a
fresh worker and observing one of the two supported external predicates. They
are non-resident commands: each reads one JSON request from stdin and emits at
most one JSON result on stdout.

## Launch

```bash
node --experimental-strip-types scripts/launch-watch/launch.ts <<'JSON'
{"requestVersion":"launch-request/v1","cwd":"/work/orchestrator-pack","targetRef":"main","remoteRef":"origin/main","model":"cursor-agent","effort":"high","initialInstruction":"Implement the task"}
JSON
```

The launcher fetches and freezes one `origin/main` SHA, refuses dirty/ahead/
diverged/non-main targets, and only fast-forwards a clean eligible local
`main`. It binds the existing Orca worktree and trust producers before creating
one terminal. The observable outer `--command` value preserves the requested
model, effort, and initial instruction using shell-safe encoding.

Launch success means only that the terminal was created, the worktree and
trust evidence matched, and the mandatory post-create binding read succeeded.
The inner agent is owned by Orca through its terminal handle. Startup text is
optional diagnostic data; it does not prove startup, model/effort selection, or
later-message delivery. A failed or ambiguous create is never retried blindly,
and an obtained handle is closed for containment.

## Watch

GitHub pull request:

```bash
node --experimental-strip-types scripts/launch-watch/watch.ts <<'JSON'
{"requestVersion":"watch-request/v1","sourceId":"github.pull-request","predicateId":"pr.merged","repo":"owner/repo","prNumber":1198}
JSON
```

Orca terminal read:

```bash
node --experimental-strip-types scripts/launch-watch/watch.ts <<'JSON'
{"requestVersion":"watch-request/v1","sourceId":"orca.terminal","predicateId":"terminal.read","terminalHandle":"owned-handle"}
JSON
```

The closed watch catalogue contains only `github.pull-request/pr.merged` and
`orca.terminal/terminal.read`. GitHub reads use the requested repository and PR
number through `scripts/gh`, with one in-flight read, a 250 ms minimum interval,
and a 120-read cap. Orca reads accept only the named bounded `ok:true` shape.
Producer failures remain `source-unavailable`; unsupported sources, predicates,
fields, and malformed requests are `invalid-request`.

Both families use the same finite deadline: 10,000–900,000 ms, with launch
defaulting to 120,000 ms and watch defaulting to 30,000 ms. Exactly 5,000 ms is
reserved for cleanup and 1,000 ms for serialization/emission. After the work
cutoff no new productive read, poll, helper, retry, or terminal-create starts.

## Direct path and proof

Direct Orca execution remains available for recovery and expert use, but it
bypasses the wrapper's fresh-revision, trust, binding, finite-watch, typed
outcome, deadline, and cleanup guarantees. No existing entrypoint is silently
routed through these wrappers.

The executable aggregate proof is:

```bash
node --experimental-strip-types scripts/launch-watch/aggregate.ts
```

It fails closed on zero coverage, missing or extra cleanup fixture IDs,
duplicate fixture IDs, missing acceptance mappings, or absent red-then-green
evidence. `--zero-coverage` is a negative self-test for that gate.

Operator adoption: use the wrapper commands above explicitly after this change
is deployed; no daemon, listener, YAML runtime, or session restart is added by
this implementation.
