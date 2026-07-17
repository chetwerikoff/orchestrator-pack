# Issue 841 post-rebase CI

- The implementation branch is rebased onto `main` commit `af70ecf032724a6279cda87d45c23e649064fe09` with no commits behind.
- Wave 3.b ownership is frozen by an independent migration inventory and a generated digest that includes `classification`, `gateIds`, and `portedInWave`.
- Every migrated `verify.ps1` row is bound to its concrete required-file, contract-marker, prompt-glob, or standalone-owner replacement rule.
- Test-backed legacy references require the exact repository-owned PowerShell wrapper and fail-closed child-process handling.
- The frozen PowerShell parity replay keeps all assertions and uses a dedicated 30-second integration-test timeout.
- The long-running repo-tick fixture uses a 300-second default test TTL; its stale-window case still overrides the TTL to 2 seconds.
- Temporary rebase, diagnostic, export, fix, and stale-run cancellation workflows are absent from the proposed tree.
- The final CI target is a connector-authored commit after the latest rebase.
