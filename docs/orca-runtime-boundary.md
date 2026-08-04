# Orca runtime boundary

Issue #1245 extracts a runtime-neutral TypeScript contract around the already-working Orca path. It does not change lifecycle policy and does not provide AO compatibility.

## Current caller census (revalidated at `4e3a86ead255c6f3e8ef44f34bcaf9446af234b2`)

| Current live caller | Operations consumed here | Disposition |
|---|---|---|
| `scripts/worker-smoke-run.ts` through `scripts/lib/orca-cli.ts` | current-worktree readiness, terminal create, send/submit, bounded read, bounded wait, close | existing behavior remains on the compatibility facade; caller-wide migration and a generation-bound destructive operation remain #1248 |
| `scripts/lib/worker-smoke-bounded-create.ts` through `scripts/lib/orca-cli.ts` | bounded terminal creation | continues through the compatibility facade; no second Orca parser or runtime operation is introduced |
| `scripts/launch-watch/watch.ts` | exact current-worker resolution by opaque id and bounded terminal output observation | production path uses the runtime-neutral adapter; explicit injected process runners remain only as a test seam |
| observer fleet (#1258 and dependent tasks) | workspace-complete list/find, bounded liveness, identity/generation, provenance, bounded output | named consumer of this interface; no new monitoring operation or watcher service |

Operations required only by remaining supervisor/recovery callers are intentionally left to #1248, as required by the task split.

## Contract

- Runtime selection has one composition root, `selectRuntimeAdapter`. Default is `orca`. Unknown selections fail before an adapter factory is invoked. There is no automatic detection, fallback, dual execution, hot switch, or cross-runtime adoption.
- Worker identity is `{ opaque id, opaque generation, runtime tag }`. `findWorkerById` resolves the current composite identity through the adapter without requiring the caller cwd or workspace. Orca's current native incarnation is revalidated before read, dispatch, and liveness effects. A reused terminal handle with a different generation invalidates prior ownership and cannot be acted on through the stale identity.
- `listWorkers` returns all terminals visible in the selected workspace. Workers created by this adapter instance are `internal`; discovered terminals are `external`. Discovery never grants stop or cleanup authority. An explicitly selected non-active workspace is retained for later identity lookup.
- Liveness is bounded by one total deadline covering discovery plus `terminal wait --for tui-idle`, and returns exactly `busy | idle | gone | unknown`. Process existence is never used as activity evidence.
- Every bounded-output result exposes an equality-only observation token scoped to worker id and generation. Orca cursor strings/numbers and cursor arithmetic remain inside the adapter. Cursor progression is authoritative: the adapter uses `nextCursor`, or `latestCursor` when `nextCursor` is null. If Orca supplies neither monotonic witness, the operation fails closed as `runtime_output_progress_unavailable`; line batches and terminal-state changes are never treated as synthetic progress.
- The deterministic test adapter applies the same identity/generation token scope and rejects cross-worker or prior-generation continuation tokens.
- Dispatch performs exactly one native send attempt and returns `dispatched | send_failed | dispatch_unknown`. Ambiguous transport outcomes are never retried automatically.
- The current public Orca CLI closes terminals only by handle and exposes no expected-generation binding. Therefore the shared Orca adapter does not issue a destructive close and returns `runtime_generation_bound_stop_unsupported` for an otherwise owned worker. The existing worker-smoke compatibility facade retains its current close behavior until #1248 can bind migration to a generation-safe native operation; the shared boundary does not claim atomicity that Orca cannot provide.
- Current upstream Orca output (`result.terminal.tail`, string-or-null cursor plus optional `latestCursor`) and the captured legacy smoke shape (`result.lines`, numeric cursor) are normalized internally. Any unsupported consumed response or progress shape returns the named `unsupported` result.

## Worktree lifecycle continuity (Issue #1298)

Worktree creation and teardown are deliberately not added to `RuntimeAdapter` by this task. Issue
#1248 still owns the broad caller migration and any future runtime-neutral lifecycle expansion.
Issue #1298 adds one smaller pack-owned boundary at `scripts/worktree-lifecycle/**` because the
current production problem is disagreement between two native authorities:

- Git's common worktree registry and target `.git` link;
- Orca's supported worktree, agent, and terminal inventories.

The seam performs a bounded dual census and emits one exact classification:
`exact_dual`, `exact_git_only`, `orca_only`, `conflict`, or `absent`. Runtime-specific commands and
response validation stay at the edge; normalized identity and continuation decisions stay in the
pure classifier. Multiple worktrees may legitimately share the same source commit, so equality of
HEAD SHA alone is not a collision. Exact identity requires the active Orca repository id,
canonical path, branch or detached mode, Issue/PR binding, active non-main/non-archived state, and
the complete validated row.

The canonical create/handoff surface is
`scripts/worktree-lifecycle/create-continuation.ts`. One invocation owns the process-local
exclusion across pre-create dual census, one stable primary create, authoritative read-back after
known or unknown command outcome, at most one stable same-source replacement, terminal creation,
and two fresh read-backs proving exactly one new terminal handle. The successful result is
`worker_spawned`; it returns the verified worktree and terminal identities and deliberately exports
no later terminal-spawn authorization. A repeated, concurrent, or exhausted caller receives a
no-effect task-level degraded result and returns control to the scheduler.

The lifecycle seam does not become a universal registry and stores no durable state. Discovery
never grants mutation authority. The read-only post-create classifier can report
`exact_dual_observed`, but it cannot authorize a terminal effect. Unsupported, malformed,
wrong-repository, archived, main-worktree, or present-invalid binding output is a conflict.

For cleanup, mutation safety and work continuity are separate decisions. Existing teardown gates
remain fail-closed for the target. A blocked or ambiguous cleanup returns a structured
`cleanup_deferred` result with `pipelineContinues: true`; it does not invalidate an already
successful merge/adoption or stop unrelated scheduler work. Exact Git-only recovery is explicit,
dry-run-first, and permits only Git's non-force worktree removal after the complete identity,
cleanliness, ignored-data, merge, branch-ownership, terminal, process, exclusion, and live merged-PR
checks are recollected immediately before the effect. Process-census failure is unavailable
evidence, never proof of zero processes.

Standard teardown is also settled from both authorities after the child returns, fails, or times
out. `cleanup_complete` requires exact target absence in Git and Orca with unrelated inventory
unchanged; child exit zero alone is not completion evidence. Effect-before-receipt may settle
complete only from that dual read-back.

No watcher, daemon, lease service, second state store, bulk orphan sweep, private Orca persistence
edit, force removal, or path-only delete is introduced. A future native Orca adopt/register branch
requires installed-version production capture proving its exact command and identity-preserving
read-back; until then it is treated as unsupported.

## Adding a future adapter

A future adapter needs an implementation of `RuntimeAdapter`, a static composition-root factory, focused contract tests, and this document updated. Runtime-specific command lines, response fields, handles, cursors, and error text must remain inside that adapter. The deterministic adapter is test-only and is injected by tests; it is not registered as a production runtime.
