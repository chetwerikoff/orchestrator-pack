# Issue 841 CI compatibility

The Wave 3.b gate-runner migration and Issue #900 run production, operator, and CI TypeScript execution on Node 22. Scope-guard and Vitest workflows select Node 22 directly; tests no longer need a Node 20 compatibility execution path.

This is a test-environment compatibility path only. Node 22 continues to exercise the real runner CLI, including argv parsing, report formatting, and exit-code behavior. The reachability audit accepts both the provisional 3.a retirement spelling and the terminal Wave 3.b `retired-with-reason` classification while v1 compatibility remains supported.

## Review remediation

The post-migration reviews harden seven proof boundaries:

- non-executable Node-backed gates preserve actual child stdout on `SKIP` but never synthesize a legacy `PASS` line;
- schema v2 freezes the deferred `check-reusable.ps1` behavior surface so appended predicates cannot bypass the 283-row census;
- frozen PowerShell replay fixtures exercise successful and failing cases for each deleted entrypoint plus the migrated `verify.ps1` required-file and contract-marker behaviors;
- deferred census references carry an explicit invocation kind and are validated as executable call shapes rather than arbitrary marker substrings;
- test-backed PowerShell references are parsed as TypeScript call expressions and must bind `pwsh`, the adjacent `-File` argument, and the exact retained wrapper path inside one sanctioned `runProcessSync` invocation; the wrapper proof is hosted by the gate-runner census suite rather than mutating the supervisor RPC capture scope;
- every ported census row declares `portedInWave`, and Wave 3.b parity completeness is derived from that census-owned migration population instead of from the capture manifest being tested;
- the partial `verify.ps1` replay is bound to the complete frozen source blob, verified Git blob SHA, recorded source offsets, and normalized span hashes, so a predicate mutation cannot be hidden behind an unchanged provenance comment.

The expanded gate-runner suite contains 95 tests, and the foundation suite contains 174 tests. The Linux verification path runs all frozen legacy parity fixtures with PowerShell available. The Wave 3.b parity manifest is version 2 and includes both successful and failing legacy executions.

The rereview-specific mutation regressions cover a disconnected wrapper path plus an unrelated child call, helper-only Node execution without the retained PowerShell wrapper, removal of one migrated script's captures from the manifest, and replay predicate drift while the source-SHA comment remains unchanged.

Frozen legacy scripts under `scripts/fixtures/gate-runner/**` are test evidence, not production deletion candidates. Reachability analysis may retain them as graph evidence but excludes that fixture subtree from the production deletion formula.

The restored supervisor RPC test retains its original two Issue #800 raw-child baseline entries. The proof was relocated instead of changing the frozen RPC binding scope or adding a new policy exception.

The launch-inventory parity proof normalizes only the two merge-tree-sensitive integer counters in the generated audit line. It still compares the complete PASS line shape and the wrapper-level PASS text exactly, so a verdict or diagnostic contract change remains a failure.

Two timing-sensitive heavy tests produced one-off failures during repeated full-matrix runs: detached TestMode supervisor startup and the repo-tick stale-serve window. Each failing scenario passed when rerun in isolation through the same Vitest fleet harness without a code change. Final acceptance still requires a complete green PR workflow on the cleaned head rather than relying on those focused probes alone.

The implementation branch was rebased onto `main` commit `c709020ff3669051f65202724b17339e738b33f4`; the temporary rebase workflow commit was removed before the force-with-lease push. A stale diagnostic exporter was also removed and its queued run completed before the final connector-triggered CI. The final review-remediation diff remains confined to the issue's permitted `docs/**` and `scripts/**` roots.
