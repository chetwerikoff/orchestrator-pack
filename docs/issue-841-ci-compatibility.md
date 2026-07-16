# Issue 841 CI compatibility

The Wave 3.b gate-runner migration keeps production and operator CLI execution on the repository's Node 22 runtime. The scope-guard workflow currently measures selected Vitest files under Node 20; tests that validate a registered gate therefore use the runner's in-process API on Node versions that cannot parse TypeScript with `--experimental-strip-types`.

This is a test-environment compatibility path only. Node 22 continues to exercise the real runner CLI, including argv parsing, report formatting, and exit-code behavior. The reachability audit accepts both the provisional 3.a retirement spelling and the terminal Wave 3.b `retired-with-reason` classification while v1 compatibility remains supported.
