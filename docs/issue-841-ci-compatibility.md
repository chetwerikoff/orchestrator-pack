# Issue 841 CI compatibility

The Wave 3.b gate-runner migration keeps production and operator CLI execution on the repository's Node 22 runtime. The scope-guard workflow currently measures selected Vitest files under Node 20; tests that validate a registered gate therefore use the runner's in-process API on Node versions that cannot parse TypeScript with `--experimental-strip-types`.

This is a test-environment compatibility path only. Node 22 continues to exercise the real runner CLI, including argv parsing, report formatting, and exit-code behavior. The reachability audit accepts both the provisional 3.a retirement spelling and the terminal Wave 3.b `retired-with-reason` classification while v1 compatibility remains supported.

## Review remediation

The post-migration reviews harden seven proof boundaries:

- non-executable Node-backed gates preserve actual child stdout on `SKIP` but never synthesize a legacy `PASS` line;
- schema v2 freezes the deferred `check-reusable.ps1` behavior surface so appended predicates cannot bypass the 283-row census;
- frozen PowerShell replay fixtures exercise successful and failing cases for each deleted entrypoint plus the migrated `verify.ps1` required-file and contract-marker behaviors;
- deferred census references carry an explicit invocation kind and are validated as executable call shapes rather than arbitrary marker substrings;
- test-backed PowerShell references are parsed as TypeScript call expressions and must bind `pwsh`, the adjacent `-File` argument, and the exact retained wrapper path inside one sanctioned `runProcessSync` invocation; the wrapper test uses the subprocess kernel rather than adding a raw child-process exception;
- every ported census row declares `portedInWave`, and Wave 3.b parity completeness is derived from that census-owned migration population instead of from the capture manifest being tested;
- the partial `verify.ps1` replay is bound to the complete frozen source blob, verified Git blob SHA, recorded source offsets, and normalized span hashes, so a predicate mutation cannot be hidden behind an unchanged provenance comment.

The expanded gate-runner suite contains 94 tests, and the foundation suite contains 173 tests. The Linux verification path runs all frozen legacy parity fixtures with PowerShell available. The Wave 3.b parity manifest is version 2 and includes both successful and failing legacy executions.

The rereview-specific mutation regressions cover a disconnected wrapper path plus an unrelated child call, helper-only Node execution without the retained PowerShell wrapper, removal of one migrated script's captures from the manifest, and replay predicate drift while the source-SHA comment remains unchanged.

Frozen legacy scripts under `scripts/fixtures/gate-runner/**` are test evidence, not production deletion candidates. Reachability analysis may retain them as graph evidence but excludes that fixture subtree from the production deletion formula.

The launch-inventory parity proof normalizes only the two merge-tree-sensitive integer counters in the generated audit line. It still compares the complete PASS line shape and the wrapper-level PASS text exactly, so a verdict or diagnostic contract change remains a failure.

A one-off heavy-shard failure in the existing TestMode fleet-reaper wall-clock test was reproduced as an infrastructure launch flake: the focused test passed through the same heavy harness without code changes. Final acceptance still requires a complete green PR workflow on the cleaned head rather than relying on that focused probe alone.

The final review-remediation diff remains confined to the issue's permitted `docs/**` and `scripts/**` roots; temporary workflow and transport files are not part of the proposed tree. Standard pull-request workflows run against the cleaned connector-authored head.
