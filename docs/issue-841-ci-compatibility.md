# Issue 841 CI compatibility

The Wave 3.b gate-runner migration keeps production and operator CLI execution on the repository's Node 22 runtime. The scope-guard workflow currently measures selected Vitest files under Node 20; tests that validate a registered gate therefore use the runner's in-process API on Node versions that cannot parse TypeScript with `--experimental-strip-types`.

This is a test-environment compatibility path only. Node 22 continues to exercise the real runner CLI, including argv parsing, report formatting, and exit-code behavior. The reachability audit accepts both the provisional 3.a retirement spelling and the terminal Wave 3.b `retired-with-reason` classification while v1 compatibility remains supported.

## Review remediation

The post-migration review hardens four proof boundaries:

- non-executable Node-backed gates preserve actual child stdout on `SKIP` but never synthesize a legacy `PASS` line;
- schema v2 freezes the deferred `check-reusable.ps1` behavior surface so appended predicates cannot bypass the 283-row census;
- frozen PowerShell replay fixtures exercise a meaningful negative case for each deleted entrypoint plus the migrated `verify.ps1` required-file and contract-marker behaviors;
- deferred census references carry an explicit invocation kind and are validated as executable call shapes rather than arbitrary marker substrings.

The expanded gate-runner suite contains 89 tests, and the foundation suite contains 168 tests. The Linux verification path runs the legacy parity fixtures with PowerShell available. The Wave 3.b parity manifest is version 2 and includes both successful and failing legacy executions.

Frozen legacy scripts under `scripts/fixtures/gate-runner/**` are test evidence, not production deletion candidates. Reachability analysis may retain them as graph evidence but excludes that fixture subtree from the production deletion formula.

The launch-inventory parity proof normalizes only the two merge-tree-sensitive integer counters in the generated audit line. It still compares the complete PASS line shape and the wrapper-level PASS text exactly, so a verdict or diagnostic contract change remains a failure.

The final review-remediation diff remains confined to the issue's permitted `docs/**` and `scripts/**` roots; temporary workflow and transport files are not part of the proposed tree. Standard pull-request workflows run against this cleaned tree after stale diagnostic runs have been cancelled. The final connector-authored head is the only verification target.
