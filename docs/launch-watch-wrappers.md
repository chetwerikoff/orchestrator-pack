# Watch wrapper

The pack-owned Node 22 watch entrypoint is an observation-only surface. Worker
start is **not** routed through this directory: the governed start path is
`scripts/pr2-foundation/supervised-worker-start.ts`, which invokes Orca
`orchestration worker-start` for an already selected Task, terminal, and
worktree and publishes the current WorkerAssignment only after admission.

`scripts/launch-watch/launch.ts` is retired and has no replacement alias or
fallback. Do not use the watch surface as start authority.

## Watch

GitHub pull request:

```bash
node --experimental-strip-types scripts/lib/Invoke-TypeScriptCli.ts --script scripts/launch-watch/watch.ts -- <<'JSON'
{"requestVersion":"watch-request/v1","sourceId":"github.pull-request","predicateId":"pr.merged","repo":"owner/repo","prNumber":1198}
JSON
```

Orca terminal read:

```bash
node --experimental-strip-types scripts/lib/Invoke-TypeScriptCli.ts --script scripts/launch-watch/watch.ts -- <<'JSON'
{"requestVersion":"watch-request/v1","sourceId":"orca.terminal","predicateId":"terminal.read","terminalHandle":"owned-handle"}
JSON
```

The closed watch catalogue contains only `github.pull-request/pr.merged` and
`orca.terminal/terminal.read`. GitHub reads use the requested repository and PR
number through `scripts/gh`, with one in-flight read, a 250 ms minimum interval,
and a 120-read cap. Orca reads accept only the named bounded `ok:true` shape.
Producer failures remain `source-unavailable`; unsupported sources, predicates,
fields, and malformed requests are `invalid-request`.

Watch uses a finite 10,000–900,000 ms deadline and defaults to 30,000 ms.
Exactly 5,000 ms is reserved for cleanup and 1,000 ms for serialization and
emission. After the work cutoff no new productive read, poll, helper, or retry
starts.

## Proof

The executable watch-only aggregate proof is:

```bash
node --experimental-strip-types scripts/lib/Invoke-TypeScriptCli.ts --script scripts/launch-watch/aggregate.ts --
```

It fails closed on zero coverage, missing or extra cleanup fixture IDs,
duplicate fixture IDs, missing acceptance mappings, or absent red-then-green
evidence. `--zero-coverage` is a negative self-test for that gate.

The watch command remains non-resident and observation-only. No daemon,
listener, worker-start authority, compatibility launcher, or automatic fallback
is added here.
