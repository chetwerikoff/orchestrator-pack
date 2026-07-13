# Vitest live-default store isolation audit

Issue: #752

## Contract

Every writable pack store that can resolve outside the current checkout is listed in
`scripts/vitest-live-store-inventory.json`. The inventory is executable input for:

- the Node write-boundary preload (`scripts/vitest-live-store-preload.mjs`);
- inventory-driven PowerShell launch preflight before each child process is spawned;
- the parent-process pre/post hash and transient-write watcher;
- the mechanical inventory regression check run before `npm test`.

An entry records its store identifier, resolver, write seam, environment override,
canonical production default, live root, basename-scoped sidecars, isolated harness
path, source files, and exclusion state. A new live-default resolver is incomplete
until its inventory row and harness mapping land in the same change.

## Canonical comparison policy

Comparisons freeze the production home and temporary-directory roots at harness entry,
then expand those roots, normalize separators and `..`, resolve the nearest existing
ancestor (therefore resolving symlink/junction aliases even when the leaf does not exist
yet), and use case-insensitive comparison only on Windows. A directory store protects
its full subtree. File stores protect the primary basename plus only the sidecar patterns
declared in their row.

With `OPK_VITEST_HARNESS=1`, a match fails closed before a Node filesystem write or
before a PowerShell child is spawned with a live-default environment override, explicit
path argument, or literal write target. Computed internal paths remain covered by the
parent hash/transient guard. The PowerShell helper retains a direct mechanical pre-open
fence for the isolation self-check. Diagnostics contain the store identifier and
operation only; they do not print file contents or resolved live paths.

## Invocation ownership

`npm test` and `npm run test:watch` launch Vitest through
`scripts/run-vitest-with-harness.mjs`. Each invocation receives a unique owner-only root.
The wrapper establishes every override before importing Vitest, installs the Node
preload and PowerShell child shim, starts the live-store guard, and always runs post-check
and cleanup in `finally` semantics. The shim validates the original PowerShell
a rgv/environment through the inventory, then launches the real executable without
rewriting named parameters while streaming stdio and forwarding termination signals.
When both the child and the guard fail, both failures remain visible and the invocation
is non-zero.

The existing PowerShell light/heavy/shard wrappers already call
`Set-OpkVitestHarnessEnv.ps1` before `npm test`; that helper now supplies the complete
inventory mapping. Direct `vitest`/`npx vitest` without the marker is rejected by
`vitest.config.ts`. The marker is pack-owned and manually setting it is unsupported. As
defense in depth, global setup still starts the inventory guard and each Vitest worker
imports the Node write-boundary preload before test modules.

Stale `opk-vitest-*` roots older than 24 hours are scavenged best-effort with a hard
limit of 16 removals per invocation. The current run root is deleted after the guard
finishes.

## Audit result

Inventoried non-excluded classes:

1. escalation state, operator inbox, and escalation health spool (the #664 lineage);
2. worker-message dispatch journal, submit tracking state, and submit root anchor;
3. worker-status store;
4. review delivery lifecycle, handoff admission, report-state seed, and re-evaluation watch;
5. pack worker-report store and PR↔session binding cache;
6. review-start and worker-nudge claim namespaces under the AO base directory;
7. mechanical Node transport files.

The wake-supervisor state root and default AO base root are also protected as root
classes, so an unlisted basename beneath either production root cannot silently write
just because its leaf is new.

## Exclusion result

No writable store is excluded: every inventory row has `excluded: false`. The mechanical
source scan ignores repository fixtures, golden inputs, declarations, investigations,
and test modules because those are not runtime path-producing seams. Repository-local
Vitest reports are also outside this inventory because their output is checkout-scoped,
not operator live state. Environment variables, CI presence, and a currently missing
file are never treated as exclusion evidence.

## Operator adoption

No production store path or schema changes. No live state migration is required. Test
and CI callers must use `npm test`, `npm run test:watch`, or one of the existing
`run-vitest-*-lane.ps1` wrappers. Any bespoke command that invokes the Vitest binary
directly must switch to the package wrapper rather than setting the harness marker by
hand.
