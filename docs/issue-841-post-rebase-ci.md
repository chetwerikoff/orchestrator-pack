# Issue 841 post-rebase CI

- The implementation branch is rebased onto `main` commit `0423fd4f0f364fca2c5185cbb8240f49f73af46e` with no commits behind.
- The frozen PowerShell parity replay keeps all assertions and uses a dedicated 30-second integration-test timeout.
- The long-running repo-tick fixture uses a 300-second default test TTL; its stale-window case still overrides the TTL to 2 seconds.
- Temporary rebase, diagnostic, export, fix, and stale-run cancellation workflows are absent from the proposed tree.
- The final CI target is a connector-authored commit after the latest rebase and stale-run cleanup.
