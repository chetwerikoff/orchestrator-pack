# Issue #906 operator adoption

Issue #906 removes the legacy estate in one revertible cut. The generated manifest at `scripts/estate-cut/issue-906.manifest.json` is the authoritative base-pinned disposition record. Reproduce the final checks with:

```text
npm run estate-cut:check
npm run test:issue-906
npm run gate-runner-selftest
```

The final implementation tree was also validated with `npm run typecheck:foundation`, `npm run lint:foundation`, `npm run test:foundation`, the full `npm test` suite, `git diff --check`, and the surviving trusted PowerShell verification entry points.

The surviving supervisor entry point remains `scripts/orchestrator-wake-supervisor.ps1`. Its registry now starts exactly:

- `review-trigger-reconcile`
- `review-trigger-reeval`
- `review-ready-report-state-seed`

No machine-local state is migrated. Existing `.ao/**`, state directories, journals, locks, caches, and process markers are deliberately left untouched on operator machines. They are abandoned historical state for the removed owners; operators may archive or delete them only under their normal local retention procedure.

The former GitHub fleet cache measurement note is preserved as historical evidence at `docs/archive/issue-906/github-fleet-cache-measurement.md`. It is not a migration instruction and does not authorize reactivating the deleted owner.

To roll back the repository cut, revert the Issue #906 merge commit as one unit. Do not selectively restore deleted scripts or tests: the manifest, census terminal classifications, pruned supervisor registry, and verification inventories are one atomic compatibility boundary.
