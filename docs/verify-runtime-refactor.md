# Verify runtime refactor (Issue #488)

This document now records the terminal Node 22 verification state. The historical
PowerShell/Pester migration is complete; the removed wrappers are not active
verification or compatibility entrypoints.

## Active verification

Run the current-head checks from the repository root:

```bash
node --experimental-strip-types scripts/verify.ts
node --experimental-strip-types scripts/verify.ts --reusable-only
npm run typecheck:foundation
npm run lint:foundation
npm run gate-runner-selftest
node --experimental-strip-types scripts/runtime-retirement/retired-surface-selftest.ts
npm test
```

`scripts/verify.ts` owns structural verification. The TypeScript gate runner and
Vitest suites own behavioral regression coverage; CI selects and shards those suites
without a PowerShell or Pester lane. Dependency installation remains explicit and is
never hidden inside verification.

Historical Issue #488 ownership mappings remain available in Git history. They are
not current invocation instructions.
