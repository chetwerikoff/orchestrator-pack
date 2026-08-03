# Orca runtime boundary

Issue #1245 extracts a runtime-neutral TypeScript contract around the already-working Orca path. It does not change lifecycle policy and does not provide AO compatibility.

## Current caller census (revalidated at `fbc51b8dab3b42c8696fae8fa091119d3ecd04ea`)

| Current live caller | Operations consumed here | Disposition |
|---|---|---|
| `scripts/worker-smoke-run.ts` through `scripts/lib/orca-cli.ts` | current-worktree readiness, terminal create, send/submit, bounded read, bounded wait, close | existing behavior preserved through the Orca runtime package; caller-wide migration remains #1248 |
| `scripts/lib/worker-smoke-bounded-create.ts` through `scripts/lib/orca-cli.ts` | bounded terminal creation | continues through the compatibility facade; no second Orca parser or runtime operation is introduced |
| `scripts/launch-watch/watch.ts` | bounded terminal output observation | production path uses the runtime-neutral adapter; explicit injected process runners remain only as a test seam |
| observer fleet (#1258 and dependent tasks) | workspace-complete list/find, bounded liveness, identity/generation, provenance, bounded output | named consumer of this interface; no new monitoring operation or watcher service |

Operations required only by remaining supervisor/recovery callers are intentionally left to #1248, as required by the task split.

## Contract

- Runtime selection has one composition root, `selectRuntimeAdapter`. Default is `orca`. Unknown selections fail before an adapter factory is invoked. There is no automatic detection, fallback, dual execution, hot switch, or cross-runtime adoption.
- Worker identity is `{ opaque id, opaque generation, runtime tag }`. Orca's current native incarnation is revalidated before read, dispatch, liveness, and stop effects. A reused terminal handle with a different generation invalidates prior ownership and cannot be acted on through the stale identity.
- `listWorkers` returns all terminals visible in the selected workspace. Workers created by this adapter instance are `internal`; discovered terminals are `external`. Discovery never grants stop or cleanup authority. An explicitly selected non-active workspace is retained for later identity lookup.
- Liveness is bounded by one total deadline covering discovery plus `terminal wait --for tui-idle`, and returns exactly `busy | idle | gone | unknown`. Process existence is never used as activity evidence.
- Every bounded-output result exposes an equality-only observation token scoped to worker id and generation. Orca cursor strings/numbers and cursor arithmetic remain inside the adapter. When Orca returns no cursor, the adapter uses a deterministic output fingerprint inside the opaque token so empty, unchanged, and changed observations remain distinguishable.
- Dispatch performs exactly one native send attempt and returns `dispatched | send_failed | dispatch_unknown`. Ambiguous transport outcomes are never retried automatically.
- Current upstream Orca output (`result.terminal.tail`, string-or-null cursor) and the captured legacy smoke shape (`result.lines`, numeric cursor) are normalized internally. Any other consumed response shape returns the named `unsupported` result.

## Adding a future adapter

A future adapter needs an implementation of `RuntimeAdapter`, a static composition-root factory, focused contract tests, and this document updated. Runtime-specific command lines, response fields, handles, cursors, and error text must remain inside that adapter. The deterministic adapter is test-only and is injected by tests; it is not registered as a production runtime.
