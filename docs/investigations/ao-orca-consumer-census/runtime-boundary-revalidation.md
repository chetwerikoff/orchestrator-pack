# Runtime-boundary caller revalidation

Issue #1245 revalidated the Issue #1036 census against default-branch commit
`9d7e095e833674ca0cca97cac64aa04e2714d70f`.

## Current live Orca path wrapped here

| Caller | Current operation | #1245 disposition |
|---|---|---|
| `scripts/worker-smoke-run.ts` | worktree readiness, terminal input, bounded output, bounded wait, close | existing behavior retained through `scripts/lib/orca-cli.ts`, which is now a compatibility facade over the Orca adapter |
| `scripts/lib/worker-smoke-bounded-create.ts` | bounded terminal creation | routed through the same Orca adapter instead of owning a second CLI parser |
| `scripts/launch-watch/watch.ts` | bounded terminal output read | native response parsing moved behind the Orca adapter; wrapper outcomes remain unchanged |

The runtime operation contract is the subset required by the caller classes that
Issue #1248 will migrate: health/readiness, list/find workers, spawn in a selected
workspace, send/submit input, bounded output, bounded busy/idle liveness, stop,
and owned-workspace removal. Review/config/report/plugin/operator-daemon surfaces
from the #1036 census are non-runtime AO service usage and remain outside this
boundary for #1250.

## Boundary decisions

- Runtime identity is opaque id plus opaque generation. The Orca adapter hashes
  native handles and never exports handles as shared identity fields.
- Runtime-owned workers are tagged `internal`; same-workspace terminals discovered
  by listing are tagged `external`. Discovery never grants stop/remove authority.
- Bounded output exposes an opaque generation-scoped observation token. Both the
  legacy numeric `nextCursor` capture and current string/null Orca cursor shape are
  accepted inside the adapter, but neither native representation crosses the
  shared contract.
- Liveness uses bounded `terminal wait --for tui-idle` evidence and returns only
  `busy | idle | gone | unknown`. Process existence is not consulted.
- Send/submit performs one adapter attempt and returns only
  `dispatched | send_failed | dispatch_unknown`; ambiguous outcomes are not retried.
- Runtime selection is static, defaults to `orca`, and fails before side effects for
  unknown or unavailable adapters. No AO legacy adapter is created because no live
  consumer was proven for #1245 AC#8.

## Ownership of later work

Issue #1248 migrates remaining runtime callers and may complete adapter operations
that are defined here but not exercised by the current working path. Issue #1250
owns non-runtime AO service removal. This task adds no scheduler, watcher service,
durable store, fallback, dual execution, or cross-runtime adoption.
