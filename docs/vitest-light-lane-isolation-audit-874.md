# Vitest Light Lane Isolation Audit for Issue #874

Selected cell: worker count 2, shard split 2.

Method:

1. Enumerated the light-classified file set from `buildLanePlan()` against
   `scripts/vitest-ci-lanes.config.json`.
2. Scanned the enumerated files for shared-state indicators:
   `process.env`, `process.chdir`, timers, subprocess use, temp directories,
   filesystem mutation, `.ao`, `HOME`, `USERPROFILE`, and network listeners.
3. Manually reviewed the matched files for cross-run shared external resources.

Result: no light-classified file depends on running in the same CI runner as all other
light files, and no file requires cross-shard serialization. Some files mutate
environment variables or temporary files, but they either restore process state in the
test body/hook or use per-test temporary roots. The selected change keeps
`lightMaxWorkers` at 2, so it does not increase in-process sibling concurrency inside a
shard.

| File | Isolation-sensitive for worker=2/shard=2? | Determination |
| --- | --- | --- |
| `plugins/_shared/tests/declaration_schema.test.ts` | no | No cross-run shared external resource found. |
| `plugins/_shared/tests/git_fixture.test.ts` | no | Uses synthetic local fixtures only. |
| `plugins/_shared/tests/issue_parser.test.ts` | no | Pure parser assertions. |
| `plugins/_shared/tests/normalize.test.ts` | no | Pure path/value normalization assertions. |
| `plugins/ao-codex-pr-reviewer/tests/review.test.ts` | no | Uses per-test temp paths or mocked inputs; no cross-shard shared resource. |
| `plugins/ao-scope-guard/tests/check.test.ts` | no | Pure scope-check fixtures. |
| `plugins/ao-scope-guard/tests/declaration_loader.test.ts` | no | Uses synthetic local declaration fixtures. |
| `plugins/ao-scope-guard/tests/normalize_edge.test.ts` | no | Pure normalization assertions. |
| `plugins/ao-task-declaration/tests/amendment.test.ts` | no | Pure declaration behavior assertions. |
| `plugins/ao-task-declaration/tests/baseline.test.ts` | no | Uses synthetic local fixtures. |
| `plugins/ao-task-declaration/tests/iteration.test.ts` | no | Restores environment state around assertions. |
| `plugins/ao-task-declaration/tests/snapshot.test.ts` | no | Uses synthetic local fixtures. |
| `plugins/ao-task-declaration/tests/validate.test.ts` | no | Pure validation assertions. |
| `plugins/ao-token-chain-ledger/tests/aggregate.test.ts` | no | Pure aggregation assertions. |
| `plugins/ao-token-chain-ledger/tests/convergence.test.ts` | no | Pure convergence assertions. |
| `plugins/ao-token-chain-ledger/tests/finding_signature.test.ts` | no | Pure signature assertions. |
| `plugins/ao-token-chain-ledger/tests/session_cost.test.ts` | no | Pure cost/session assertions. |
| `plugins/ao-token-chain-ledger/tests/writer.test.ts` | no | Uses per-test temp directories and restored env state. |
| `scripts/_test-stub-pack-import-closure.test.ts` | no | Uses per-test temp directories. |
| `scripts/ao-0-10-review-trigger.test.ts` | no | Static trigger assertions. |
| `scripts/ao-events-correlation-degraded.test.ts` | no | Pure event-correlation assertions. |
| `scripts/ao-session-adapter.test.ts` | no | Subprocess use is local to the test process. |
| `scripts/ao-spawn-shape.test.ts` | no | Pure shape assertions. |
| `scripts/check-supervisor-test-wait-inventory.test.ts` | no | Subprocess checks are local and read-only. |
| `scripts/contract-evidence.test.ts` | no | Uses per-test temp directories. |
| `scripts/cursor-agent-tui-shim.test.ts` | no | Pure TUI-shim assertions. |
| `scripts/draft-author-relocation-contract.test.ts` | no | Pure contract assertions. |
| `scripts/draft-discipline.test.ts` | no | Pure draft policy assertions. |
| `scripts/escalation-state-test-isolation.test.ts` | no | Isolation assertions use local state only. |
| `scripts/event-consumer-rebind-scenario-matrix.test.ts` | no | Pure matrix assertions. |
| `scripts/events-optional-consumer-signal-recovery.test.ts` | no | Uses per-test temp directories and local state files. |
| `scripts/external-output-shape-guard.test.ts` | no | Pure shape assertions. |
| `scripts/finding-ledger-guard.test.ts` | no | Pure ledger guard assertions. |
| `scripts/gate-runner/census-generator.test.ts` | no | Local fixture generation only. |
| `scripts/gate-runner/census.test.ts` | no | Pure census assertions. |
| `scripts/gate-runner/contracts.test.ts` | no | Pure contract assertions. |
| `scripts/gate-runner/custom/ao-capture-redaction.test.ts` | no | Pure redaction assertions. |
| `scripts/gate-runner/declarative.test.ts` | no | Pure declarative runner assertions. |
| `scripts/gate-runner/goldens.test.ts` | no | Local golden fixtures only. |
| `scripts/gate-runner/registry.test.ts` | no | Pure registry assertions. |
| `scripts/gate-runner/runner.test.ts` | no | Local runner fixtures only. |
| `scripts/gh-inventory-static-guard.test.ts` | no | Uses per-test temp directories. |
| `scripts/graphify/check-graphify-no-installer.test.ts` | no | Uses per-test temp directories. |
| `scripts/graphify/query-graph.test.ts` | no | Local graph fixtures only. |
| `scripts/guard-direct-edit.test.ts` | no | Pure guard assertions. |
| `scripts/harness-post-submit-pn-content-shape.test.ts` | no | Restores environment state around assertions. |
| `scripts/harness-review-bridge.test.ts` | no | Uses per-test temp directories and restored env state. |
| `scripts/json-producers/golden-hygiene.test.ts` | no | Pure JSON producer assertions. |
| `scripts/json-producers/read-delegation-audit-stop.test.ts` | no | Pure JSON producer assertions. |
| `scripts/json-producers/rtk-discover-inventory.test.ts` | no | Pure JSON producer assertions. |
| `scripts/json-producers/sanctioned-worker-kill-record.test.ts` | no | Pure JSON producer assertions. |
| `scripts/json-producers/wave-b-reconciliation.test.ts` | no | Pure JSON producer assertions. |
| `scripts/json-producers/worker-status-report.test.ts` | no | Pure JSON producer assertions. |
| `scripts/kernel/json-artifact.test.ts` | no | Pure JSON artifact assertions. |
| `scripts/kernel/json-contract.test.ts` | no | Pure JSON contract assertions. |
| `scripts/launch-argv-inventory.test.ts` | no | Pure inventory assertions. |
| `scripts/orchestrator-escalation.test.ts` | no | Pure escalation assertions. |
| `scripts/orchestrator-review-start-preflight-audit.test.ts` | no | Uses per-test temp directories. |
| `scripts/orchestrator-wake-heartbeat.test.ts` | no | Uses per-test temp directories; dedupe state is local to each test root. |
| `scripts/orchestrator-wake-supervisor-pr-lane-static.test.ts` | no | Static PR-lane assertions. |
| `scripts/pr-session-binding-cache.test.ts` | no | Local cache fixtures only. |
| `scripts/protected-signal-receipt.test.ts` | no | Pure signal receipt assertions. |
| `scripts/reachability-purge.test.ts` | no | Static reachability fixtures only. |
| `scripts/reaction-config-messages.test.ts` | no | Pure config-message assertions. |
| `scripts/reverify-bound-issue-snapshot.test.ts` | no | Local snapshot fixtures only. |
| `scripts/review-bulk-send-diagnose.test.ts` | no | Local diagnostic fixtures only. |
| `scripts/review-delivery.test.ts` | no | Uses per-test temp directories and restored env state. |
| `scripts/review-producer-contract-mapping.test.ts` | no | Pure contract mapping assertions. |
| `scripts/review-producer-contract.test.ts` | no | Pure producer contract assertions. |
| `scripts/review-ready-report-state-seed.test.ts` | no | Pure seed-state assertions. |
| `scripts/review-ready-stuck-guard.test.ts` | no | Restores environment state around assertions. |
| `scripts/review-send-reconcile.test.ts` | no | Local reconcile fixtures only. |
| `scripts/review-start-claim-lifecycle.test.ts` | no | Pure claim lifecycle assertions. |
| `scripts/review-start-preflight-shield-classifier.test.ts` | no | Pure classifier assertions. |
| `scripts/review-start-repeat-classifier.test.ts` | no | Pure repeat-classifier assertions. |
| `scripts/reviewer-contract-mapping.test.ts` | no | Pure mapping assertions. |
| `scripts/reviewer-failure-evidence.test.ts` | no | Pure evidence assertions. |
| `scripts/run-vitest-heavy-shard.test.ts` | no | Subprocess checks are local and use mocked/fixture state. |
| `scripts/sanctioned-worker-kill-record.test.ts` | no | Uses per-test temp directories. |
| `scripts/scripted-review-confirmed-delivery-gate.test.ts` | no | Local gate fixtures only. |
| `scripts/session-pr-binding-resolver.test.ts` | no | Pure resolver assertions. |
| `scripts/stage-completeness-guard.test.ts` | no | Uses per-test temp directories. |
| `scripts/supervisor-test-wait-race.fixture.test.ts` | no | Uses local temp markers and child process fixture. |
| `scripts/tier-gate-guard.test.ts` | no | Pure tier policy assertions. |
| `scripts/toolchain/toolchain-self-test.test.ts` | no | Uses per-test temp directories and local subprocess fixtures. |
| `scripts/trust-ao-worktree.test.ts` | no | Uses per-test temp directories. |
| `scripts/vestigial-fleet-retirement-pr-b.test.ts` | no | Pure retirement assertions. |
| `scripts/vestigial-fleet-retirement.test.ts` | no | Pure retirement assertions. |
| `scripts/worker-nudge-task-continuation-pr-facet.test.ts` | no | Pure continuation assertions. |
| `scripts/worker-nudge-task-continuation-tuple.test.ts` | no | Pure continuation assertions. |
| `scripts/worker-report-store.test.ts` | no | Uses per-test temp directories and restored env state. |
| `scripts/worker-status-store-live-rca.test.ts` | no | Uses per-test temp directories. |
| `scripts/worker-status-store.test.ts` | no | Uses local store fixtures. |
| `scripts/worktree-gate-claim-completion-seam.test.ts` | no | Uses per-test temp directories. |
| `tests/agents-md-relocation.test.ts` | no | Local file-tree traversal only. |
| `tests/agents-md-size-budget.test.ts` | no | Static size-budget assertions. |
