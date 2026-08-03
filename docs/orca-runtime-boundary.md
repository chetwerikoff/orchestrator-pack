# Orca runtime boundary

Issue #1245 extracts a runtime-neutral TypeScript contract around the already-working Orca path. It does not change lifecycle policy and does not provide AO compatibility.

## Current caller census (revalidated at `9d7e095e833674ca0cca97cac64aa04e2714d70f`)

| Current live caller | Operations consumed here | Disposition |
|---|---|---|
| `scripts/worker-smoke-run.ts` through `scripts/lib/orca-cli.ts` | current-worktree readiness, terminal create, send/submit, bounded read, bounded wait, close | existing behavior preserved through the Orca runtime package; caller-wide migration remains #1248 |
| `scripts/launch-watch/watch.ts` | bounded terminal output observation | production path uses the runtime-neutral adapter; explicit injected process runners remain only as a test seam |
| observer fleet (#1258 and dependent tasks) | workspace-complete list/find, bounded liveness, identity/generation, provenance, bounded output | named consumer of this interface; no new monitoring operation or watcher service |

Operations required only by remaining supervisor/recovery callers are intentionally left to #1248, as required by the task split.

## Contract

- Runtime selection has one composition root, `selectRuntimeAdapter`. Default is `orca`. Unknown selections fail before an adapter factory is invoked. There is no automatic detection, fallback, dual execution, hot switch, or cross-runtime adoption.
- Worker identity is `{ opaque id, opaque generation, runtime tag }`. A newly created worker gets a new generation when Orca does not provide a native incarnation. Durable records written by callers must persist all three fields.
- `listWorkers` returns all terminals visible in the selected workspace. Workers created by this adapter instance are `internal`; discovered terminals are `external`. Discovery never grants stop or cleanup authority.
- Liveness is bounded and returns exactly `busy | idle | gone | unknown`. `busy` and `idle` come from bounded Orca `terminal wait --for tui-idle`, not process existence. Confirmed absence of the requested generation is `gone`; timeout, unreachable, malformed, orphaned, and indeterminate states are `unknown`.
- Bounded output exposes an equality-only observation token scoped to worker id and generation. Orca cursor strings/numbers and cursor arithmetic remain inside the adapter. Restart/recreation changes generation, so a prior-generation token is rejected.
- Dispatch performs exactly one native send attempt and returns `dispatched | send_failed | dispatch_unknown`. Ambiguous transport outcomes are never retried automatically.
- Current upstream Orca output (`result.terminal.tail`, string cursor) and the captured legacy smoke shape (`result.lines`, numeric cursor) are normalized internally. Any other consumed response shape returns the named `unsupported` result.

## Adding a future adapter

A future adapter needs an implementation of `RuntimeAdapter`, a static composition-root factory, focused contract tests, and this document updated. Runtime-specific command lines, response fields, handles, cursors, and error text must remain inside that adapter. The deterministic adapter is test-only and is injected by tests; it is not registered as a production runtime.
