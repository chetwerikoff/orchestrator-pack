# Vitest live-default store isolation audit

Issue: #752

## Contract

Every writable pack store that can resolve outside the current checkout is declared in
`scripts/vitest-live-store-inventory.json`. The inventory is executable input for:

- the Node write-boundary preload;
- the PowerShell resolver/write guard;
- the parent-process hash and transient-write guard;
- the mechanical completeness check executed before `npm test`.

Each store row records its identifier, resolver, real filesystem write boundary,
environment overrides, canonical production default, containing live root,
basename-scoped sidecars, isolated harness path, source seams, and exclusion state.
No writable store is excluded.

## Canonical comparison and class backstops

The harness freezes production HOME, temporary directory, AO base, and wake-supervisor
state roots before changing test environment variables. Path comparison then expands
those frozen roots, normalizes separators and relative segments, resolves the nearest
existing ancestor to catch symlink/junction aliases, and applies case-insensitive
comparison only on Windows.

Two class-level backstops protect `${TMP}/orchestrator-*.json` (including mechanical
sidecars) and `${TMP}/orchestrator-*.lock`. The complete wake-supervisor state root and
AO base root are also write-fenced, so a newly introduced basename cannot silently reach
live state. Class fences do not satisfy inventory ownership: the source scan still fails
when a new resolver/writer seam is not assigned to a concrete inventory row.

## Harness ordering and isolation

`npm test` and `npm run test:watch` execute `scripts/run-vitest-with-harness.mjs`.
Existing PowerShell lane wrappers call `Set-OpkVitestHarnessEnv.ps1` before invoking npm.
Both entry paths:

1. freeze the production roots;
2. create a collision-free owner-only `opk-vitest-*` root;
3. redirect `TMPDIR`, `TEMP`, `TMP`, AO base, wake-supervisor state, and every named
   store override into that root;
4. install Node and PowerShell write-boundary guards before Vitest or pack modules load;
5. start the parent live-store guard before spawning Vitest;
6. run the guard in finally semantics and preserve both child and guard failures;
7. clean the invocation root best-effort and scavenge only a bounded number of stale
   roots older than 24 hours.

Raw `vitest` / `npx vitest` invocation without `OPK_VITEST_HARNESS=1` is rejected by
`vitest.config.ts`. Repository verifier helpers use `npm test -- <file>` rather than
bypassing the wrapper.

## Audited writable classes

The committed inventory currently covers 30 concrete store classes:

- escalation state, operator inbox, and health spool;
- the entire wake-supervisor runtime state root;
- dispatch journal, submit tracking, submit root anchor, worker status, worker reports,
  and PR↔session binding cache;
- review delivery lifecycle, handoff admission, report seed, reevaluation watch,
  review-trigger reconcile state, CI-green state, wake dedupe state, and wake-side-effect
  lock;
- dead-worker reconcile state and operator-clearance writer;
- worker-message adoption state and both dry-run roots;
- review-start, worker-nudge, and claim-pr-resume namespaces;
- orchestrator review-start audit and worker-nudge audit roots;
- AO code-review run/liveness state, audit, and sidecars;
- mechanical transport and generic orchestrator side-effect lock files.

Additional source files that read or write an already catalogued store are attached to
that store row rather than represented as duplicate stores.

## Inventory completeness and exclusion safety

The source audit searches the allowed roots for PowerShell, TypeScript, JavaScript,
workflow, and inline production-default path seams. A candidate passes only when it is:

- owned by at least one concrete store row, or
- listed as an explicit discovery exclusion with a mechanical no-write proof.

The only discovery exclusion is `scripts/check-reusable.ps1`: it is a read-only tracked
file policy validator. The guard rejects that exclusion if a filesystem write API is
introduced. Fixtures, tests, declarations, and investigation captures are immutable
inputs and are excluded by location, not by discretionary per-store waivers.

## Regression evidence

`scripts/check-vitest-live-store-isolation.mjs` exercises:

- fallback, environment, and explicit live-path blocking;
- frozen-root and symlink-alias canonicalization;
- unique concurrent invocation roots;
- complete environment propagation;
- Node sync, callback, and promise write interception before open;
- PowerShell resolver and direct-write interception;
- write-then-delete detection for concrete stores, class fences, and the wake root;
- raw Vitest refusal and supported npm-wrapper wiring.

Snapshots contain hashes and metadata only. Live records are never copied into logs or
CI artifacts.

## Operator adoption

No production path or schema changes. No live-state migration or cleanup is performed.
Custom test commands must invoke `npm test`, `npm run test:watch`, or an existing
`run-vitest-*-lane.ps1` wrapper; setting the harness marker manually is unsupported.
