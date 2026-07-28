# AO_* axis-2 explicit non-consumer exclusions

Inspected revision: `dcda4ed83ffb9027948607860bcdd5276abb2752`

**Excluded tokens:** 255 of 274

| Token | Reason | Evidence |
|---|---|---|
| `AO_AGENT_ORCHESTRATOR_STATE_DIR` | §7.2 test/harness-only | scripts/lib/Get-WorkerMessageAdoptionBinding.ps1, scripts/worker-message-submit-reconcile.test.ts |
| `AO_APP_STATE_PATH` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/pr2-foundation/worker-notification-target.ts |
| `AO_AUTONOMOUS_ORCHESTRATOR_SURFACE` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | docs/issue_queue_index.md, docs/migration_notes.md |
| `AO_AUTONOMOUS_SURFACE_BOOTSTRAP` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | docs/spawn-worktree-grant.mjs |
| `AO_BASE` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/review-start-claim.test.ts, scripts/_test-pwsh-helpers.ts (+31 more) |
| `AO_BASE_DIR` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/review-start-claim.test.ts, scripts/_test-pwsh-helpers.ts (+30 more) |
| `AO_BINARY` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/lib/OpkVitestChildProcessEnv.ps1, scripts/vitest-live-store-preload.mjs (+1 more) |
| `AO_CI_FAILURE_NOTIFICATION_STORE` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/lib/Ci-Failure-Notification-Common.ps1, agent-orchestrator.yaml.example |
| `AO_CI_FAILURE_PROGRESS_FRESHNESS_MS` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | docs/ci-failure-notification.mjs, docs/migration_notes.md |
| `AO_CI_GREEN_WAKE_RECONCILE_INTERVAL_MINUTES` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/ci-green-wake-reconcile.ps1, agent-orchestrator.yaml.example |
| `AO_CI_GREEN_WAKE_RECONCILE_STATE` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/ci-green-wake-reconcile.ps1, scripts/review-trigger-reconcile.ps1 (+6 more) |
| `AO_CI_RED_WATCHDOG_INACTIVITY_MS` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/lib/Ci-Red-Watchdog.ps1 |
| `AO_CI_RED_WATCHDOG_MAX_ATTEMPTS` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/lib/Ci-Red-Watchdog.ps1 |
| `AO_CI_RED_WATCHDOG_STATE_DIR` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/ci-red-watchdog-lookup-retention.Tests.ps1, scripts/lib/ci-red-watchdog-ledger.mjs (+1 more) |
| `AO_CLAIMED_REVIEW_RUN_BYPASS` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/Orchestrator-AutonomousReviewStartGate.ps1, scripts/lib/Autonomous-ReviewWorktreeGate.ps1 |
| `AO_CODEX_REVIEW_EFFECTIVE_BUDGET_MS` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | plugins/ao-codex-pr-reviewer/README.md, plugins/ao-codex-pr-reviewer/lib/reviewer_budget.ts (+2 more) |
| `AO_CODEX_REVIEW_PROMPT_FILE` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/harness-review-bridge.ts, scripts/run-pack-review-claude.ps1 (+1 more) |
| `AO_CODEX_REVIEW_SKIP_GH` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | plugins/ao-codex-pr-reviewer/lib/scope_context.ts |
| `AO_CODEX_REVIEW_SOFT_DEADLINE_MS` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | plugins/ao-codex-pr-reviewer/lib/reviewer_budget.ts, docs/migration_notes.md |
| `AO_CODEX_REVIEW_TEST_BUDGET_MS` | §7.2 test/harness-only | plugins/ao-codex-pr-reviewer/lib/reviewer_budget.ts, plugins/ao-codex-pr-reviewer/tests/reviewer-budget.test.ts, docs/migration_notes.md |
| `AO_CODEX_REVIEW_TIMEOUT_RETRY_MAX` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/pr2-foundation/terminalized/reviewer-failure-evidence-markers.ts, plugins/ao-codex-pr-reviewer/lib/reviewer_budget.ts (+2 more) |
| `AO_DAEMON_BASE_URL` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/lib/Invoke-AoReviewApi.ps1, scripts/check-harness-post-submit-pn-live-smoke.ps1 (+1 more) |
| `AO_DAEMON_URL` | §7.1 mention-only / no reader in declared corpus | (none) |
| `AO_DATA` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | .claude/skills/merge-with-local-adoption/SKILL.md |
| `AO_DEAD_WORKER_EFFECTIVE_RUNTIME_POLICY` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/dead-worker-reconcile.ps1 |
| `AO_DEAD_WORKER_GH_CLOSED_RAW_FIXTURE` | §7.2 test/harness-only | scripts/dead-worker-reconcile.ps1 |
| `AO_DEAD_WORKER_GH_MERGED_RAW_FIXTURE` | §7.2 test/harness-only | scripts/dead-worker-reconcile.ps1 |
| `AO_DEAD_WORKER_LIVE_PAYLOAD_FIXTURE` | §7.2 test/harness-only | scripts/dead-worker-reconcile.ps1 |
| `AO_DEAD_WORKER_OPEN_PRS_FIXTURE` | §7.2 test/harness-only | scripts/dead-worker-reconcile.ps1 |
| `AO_DEAD_WORKER_RECONCILE_STATE` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/vitest-live-store-inventory.json, scripts/lib/vitest-live-store-harness.mjs (+5 more) |
| `AO_DEAD_WORKER_RESPAWN_POLICY_FIXTURE` | §7.2 test/harness-only | scripts/dead-worker-reconcile.ps1 |
| `AO_DELIVERY_RUN_ID` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/WorkerReportStore.ps1, docs/vitest-light-lane-isolation-audit-874.md |
| `AO_DIRECT_EDIT_REASON` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/guard-direct-edit.mjs, docs/vitest-light-lane-isolation-audit-874.md |
| `AO_DRAFT_AUTHOR` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/guard-direct-edit.mjs, docs/migration_notes.md (+1 more) |
| `AO_DRAFT_AUTHOR_FALLBACK_REASON` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/guard-direct-edit.mjs, docs/migration_notes.md (+1 more) |
| `AO_ESCALATION_FORCE_HEALTH_FAILURE` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/lib/Orchestrator-Escalation.ps1, scripts/orchestrator-escalation.test.ts (+1 more) |
| `AO_ESCALATION_FORCE_INBOX_FAILURE` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/lib/Orchestrator-Escalation.ps1, scripts/orchestrator-escalation.test.ts (+1 more) |
| `AO_ESCALATION_FORCE_SEND_FAILURE` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/lib/Orchestrator-Escalation.ps1, scripts/orchestrator-escalation.test.ts (+2 more) |
| `AO_ESCALATION_HEALTH_SPOOL` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/_test-pwsh-helpers.ts, scripts/vitest-surviving-store-isolation.ts (+9 more) |
| `AO_FLEET_HYGIENE_ALERT_FILE` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/lib/Cursor-Agent-TuiShim.ps1, scripts/lib/Orchestrator-FleetHygiene.ps1 (+3 more) |
| `AO_FLEET_HYGIENE_ALIVE_PIDS_FIXTURE` | §7.2 test/harness-only | scripts/lib/Orchestrator-FleetHygiene.ps1 |
| `AO_FLEET_HYGIENE_DUPLICATE_LOG_STORM_MIN` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/lib/Orchestrator-FleetHygiene.ps1, docs/fleet-hygiene-sentinel-runbook.md |
| `AO_FLEET_HYGIENE_FORCE_UNSUPPORTED_PLATFORM` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/lib/Orchestrator-FleetHygiene.ps1 |
| `AO_FLEET_HYGIENE_KILL_ENABLE` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/lib/Orchestrator-FleetHygiene.ps1, docs/examples/fleet-hygiene-sentinel.systemd.timer.example (+2 more) |
| `AO_FLEET_HYGIENE_KILL_LOG_FIXTURE` | §7.2 test/harness-only | scripts/lib/Orchestrator-FleetHygiene.ps1 |
| `AO_FLEET_HYGIENE_MAX_PWSH_COUNT` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/lib/Orchestrator-FleetHygiene.ps1, docs/fleet-hygiene-sentinel-runbook.md (+1 more) |
| `AO_FLEET_HYGIENE_MAX_SUPERVISOR_LOG_BYTES` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/lib/Orchestrator-FleetHygiene.ps1, docs/fleet-hygiene-sentinel-runbook.md |
| `AO_FLEET_HYGIENE_MAX_SUPERVISOR_RSS_KB` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/lib/Orchestrator-FleetHygiene.ps1, docs/fleet-hygiene-sentinel-runbook.md (+1 more) |
| `AO_FLEET_HYGIENE_MOCK_KILL` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/lib/Orchestrator-FleetHygiene.ps1 |
| `AO_FLEET_HYGIENE_PROCESS_ENV_FIXTURE` | §7.2 test/harness-only | scripts/lib/Orchestrator-FleetHygiene.ps1 |
| `AO_FLEET_HYGIENE_PROCESS_RSS_FIXTURE` | §7.2 test/harness-only | scripts/lib/Orchestrator-FleetHygiene.ps1 |
| `AO_FLEET_HYGIENE_PWSH_COUNT_FIXTURE` | §7.2 test/harness-only | scripts/lib/Orchestrator-FleetHygiene.ps1 |
| `AO_FLEET_HYGIENE_PWSH_PIDS_FIXTURE` | §7.2 test/harness-only | scripts/lib/Orchestrator-FleetHygiene.ps1 |
| `AO_FLEET_HYGIENE_SKIP_SINGLETON` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/lib/Orchestrator-FleetHygiene.ps1 |
| `AO_FLEET_HYGIENE_STATUS_EXIT_CODE` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/lib/Orchestrator-FleetHygiene.ps1 |
| `AO_FOO` | §7.1 mention-only / no reader in declared corpus | (none) |
| `AO_GH_COMMAND` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | docs/pr-session-binding-cache.mjs |
| `AO_HARNESS_REVIEW_SUBMIT_BIN` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/harness-review-bridge.ts |
| `AO_HARNESS_REVIEW_SUBMIT_CAPTURE_FILE` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/harness-review-bridge.ts, docs/vitest-light-lane-isolation-audit-874.md |
| `AO_JOURNALED_SEND_ARGV_CEILING_CHARS` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/journaled-worker-send.ps1 |
| `AO_JOURNALED_SEND_ASSUME_CONTRACT` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/journaled-worker-send.ps1, scripts/pr2-foundation/worker-notification.ts |
| `AO_JOURNALED_SEND_CAPABILITY_TEST_FIXTURE` | §7.2 test/harness-only | scripts/lib/Journaled-WorkerSendInternalCapability.ps1 |
| `AO_JOURNALED_SEND_INTERNAL` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/lib/Journaled-WorkerSendInternalCapability.ps1, scripts/journaled-worker-send.ps1 (+2 more) |
| `AO_LOG` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/pack-review-worker-notification.cases.ts |
| `AO_MECHANICAL_TRANSPORT_MAX_AGE_SECONDS` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/lib/MechanicalReconcileNode.ps1, scripts/worker-message-submit-reconcile.test.ts |
| `AO_MECHANICAL_TRANSPORT_TEMP` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/_test-pwsh-helpers.ts, scripts/_test-vitest-harness-env.ts (+7 more) |
| `AO_NUDGE_GATE_UNRESOLVED_ESCALATE_COUNT` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | docs/worker-nudge-gate.mjs |
| `AO_NUDGE_GATE_UNRESOLVED_ESCALATE_MS` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | docs/worker-nudge-gate.mjs |
| `AO_OPERATOR_ESCALATION_INBOX` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/_test-pwsh-helpers.ts, scripts/vitest-surviving-store-isolation.ts (+9 more) |
| `AO_ORCHESTRATOR_ESCALATION_HEALTH_SPOOL` | §7.2 test/harness-only | scripts/orchestrator-escalation-router.test.ts |
| `AO_ORCHESTRATOR_ESCALATION_OPERATOR_INBOX` | §7.2 test/harness-only | scripts/orchestrator-escalation-router.test.ts |
| `AO_ORCHESTRATOR_ESCALATION_STATE` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/_test-pwsh-helpers.ts, scripts/vitest-surviving-store-isolation.ts (+11 more) |
| `AO_PASTE_CHAR_THRESHOLD` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/pr2-foundation/terminalized/worker-message-dispatch-observe.ts, scripts/pr2-foundation/worker-dispatch-journal.ts |
| `AO_PR856_TEST_LOG` | §7.2 test/harness-only | docs/vitest-light-lane-isolation-audit-874.md |
| `AO_PR856_TEST_MODE` | §7.2 test/harness-only | docs/vitest-light-lane-isolation-audit-874.md |
| `AO_PROJECT_CONFIG_PATH` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/pr2-foundation/terminalized/ao-0-10-review-api.ts, docs/ao-0-10-review-api.mjs |
| `AO_PR_SESSION_BINDING_CACHE` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/pr-session-binding-cache.test.ts, scripts/vitest-live-store-inventory.json (+13 more) |
| `AO_PUBLISH_FALLBACK` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | .claude/skills/publish-issue-draft/SKILL.md |
| `AO_PWSH_BINARY` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/_resolve-pwsh.sh |
| `AO_REAL_BINARY` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/_test-git-fixture.ts, docs/migration_notes.md |
| `AO_REPORT_STATE_SEED_FIXTURE_STEP_DELAY_MS` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/Review-ReadyReportStateSeedProgress.ps1 |
| `AO_REPORT_STATE_SEED_GITHUB_REFRESH_SECONDS` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/Invoke-ReviewReadyReportStateSeed.ps1 |
| `AO_REPORT_STATE_SEED_STATE` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/vitest-live-store-inventory.json, scripts/lib/Record-ReviewReadyReportStateSeed.ps1 (+14 more) |
| `AO_REVIEW_BUDGET_STARTED_MS` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | plugins/ao-codex-pr-reviewer/lib/reviewer_budget.ts, plugins/ao-codex-pr-reviewer/bin/command-guard/guard-lib.sh (+1 more) |
| `AO_REVIEW_CLAIM_ATTEMPT_CEILING_MS` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | docs/review-start-claim-lifecycle.mjs |
| `AO_REVIEW_CLAIM_DIR` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/review-start-claim.test.ts, scripts/run-review-ready-seed-revalidation-fixture.ps1 (+10 more) |
| `AO_REVIEW_CLAIM_HOLD_BUDGET_MS` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | docs/review-start-claim-lifecycle.mjs |
| `AO_REVIEW_CLAIM_LAUNCH_PENDING_BUDGET_MS` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | docs/review-start-claim-lifecycle.mjs |
| `AO_REVIEW_CLAIM_MUTEX_STALE_SECONDS` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/review-start-claim.test.ts, scripts/lib/review-start-claim-cli.ts |
| `AO_REVIEW_CLAIM_READINESS_ENVELOPE_MS` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/review-start-claim-lifecycle.test.ts, docs/migration_notes.md |
| `AO_REVIEW_CLAIM_REAPER_PERIOD_SECONDS` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/review-start-claim-lifecycle.test.ts, docs/review-start-claim-lifecycle.mjs |
| `AO_REVIEW_CLAIM_STALE_MINUTES` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/review-start-claim.test.ts, scripts/lib/review-start-claim-cli.ts |
| `AO_REVIEW_CLAIM_TERMINAL_COUNT` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/review-start-claim.test.ts, scripts/lib/review-start-claim-cli.ts |
| `AO_REVIEW_CLAIM_TERMINAL_RETENTION` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/review-start-claim-cli.ts |
| `AO_REVIEW_CLAIM_TEST_STALE_BARRIER_DIR` | §7.2 test/harness-only | scripts/lib/review-start-claim-store.ts, scripts/pr2a/final-conformance.test.ts |
| `AO_REVIEW_CLAIM_VISIBILITY_BUDGET_MS` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/review-start-claim.test.ts, docs/review-start-claim-lifecycle.mjs |
| `AO_REVIEW_DEGRADED_CI_MAX_ATTEMPTS` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/pr2-foundation/terminalized/review-head-ready.ts, docs/migration_notes.md |
| `AO_REVIEW_DELIVERY_CONFIRM_INTERVAL_MINUTES` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | docs/migration_notes.md |
| `AO_REVIEW_DELIVERY_CONFIRM_MAX_REDELIVERIES` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | docs/migration_notes.md |
| `AO_REVIEW_DELIVERY_CONFIRM_STATE` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | docs/migration_notes.md |
| `AO_REVIEW_DELIVERY_CONFIRM_WINDOW_MINUTES` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | docs/migration_notes.md |
| `AO_REVIEW_DELIVERY_TERMINAL_RETENTION_DAYS` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | docs/review-delivery-lifecycle.mjs |
| `AO_REVIEW_EFFECTIVE_BUDGET_MS` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | plugins/ao-codex-pr-reviewer/lib/reviewer_budget.ts, plugins/ao-codex-pr-reviewer/bin/command-guard/guard-lib.sh (+1 more) |
| `AO_REVIEW_FAILURE_EVIDENCE_DEBUG` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/invoke-pack-review.ps1, docs/migration_notes.md |
| `AO_REVIEW_FAILURE_EVIDENCE_OUTPUT_TAIL_LIMIT` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/Review-FailureEvidence.ps1, scripts/review-failure-evidence.Tests.ps1 |
| `AO_REVIEW_FAILURE_EVIDENCE_SUMMARY_TAIL_LIMIT` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | docs/migration_notes.md, docs/vitest-light-lane-isolation-audit-874.md |
| `AO_REVIEW_FAIL_STALE_PATH` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | docs/review-stuck-run-reaper.d.mts |
| `AO_REVIEW_FAIL_STALE_SURFACE` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | docs/migration_notes.md |
| `AO_REVIEW_HANDOFF_WAKE_ADMISSION_STATE` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/vitest-live-store-inventory.json, scripts/lib/vitest-live-store-harness.mjs (+4 more) |
| `AO_REVIEW_HARD_DEADLINE_MS` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | plugins/ao-codex-pr-reviewer/lib/reviewer_budget.ts, plugins/ao-codex-pr-reviewer/bin/command-guard/guard-lib.sh |
| `AO_REVIEW_LIST_PATH` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/pr2-foundation/terminalized/ao-0-10-review-api.ts, docs/ao-0-10-review-api.mjs |
| `AO_REVIEW_LIVENESS_DEBUG` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/invoke-pack-review.ps1 |
| `AO_REVIEW_READY_STUCK_GRACE_MINUTES` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/review-ready-stuck-guard.test.ts, docs/review-ready-stuck-guard.mjs |
| `AO_REVIEW_RECOVERY_AMBIGUOUS_STALE_MS` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | docs/review-run-liveness.mjs, docs/migration_notes.md |
| `AO_REVIEW_RECOVERY_CRASH_GRACE_MS` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | docs/review-run-liveness.mjs, docs/migration_notes.md |
| `AO_REVIEW_RECOVERY_MAX_REVIEW_DURATION_MS` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | docs/review-run-liveness.mjs, docs/migration_notes.md |
| `AO_REVIEW_RUN_ID` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/WorkerReportStore.ps1, scripts/estate-cut/task-311-tests/task-311-delivery.test-support.ts |
| `AO_REVIEW_SEND_RECONCILE_INTERVAL_MINUTES` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | docs/orchestrator-recovery-runbook.md |
| `AO_REVIEW_SEND_RECONCILE_STATE` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | docs/orchestrator-recovery-runbook.md |
| `AO_REVIEW_SOFT_DEADLINE_MS` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | plugins/ao-codex-pr-reviewer/lib/reviewer_budget.ts |
| `AO_REVIEW_START_CLAIM_STALE_MINUTES` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/review-start-claim-cli.ts |
| `AO_REVIEW_START_CONSECUTIVE_FAILURE_ESCALATE_THRESHOLD` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/Review-StartEnvelopeLedger.ps1 |
| `AO_REVIEW_START_GH_CALL_COUNT` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/fixtures/review-start-envelope-external-io/fake-gh-scenario.ps1 |
| `AO_REVIEW_START_GH_SCENARIO` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/fixtures/review-start-envelope-external-io/fake-gh-scenario.ps1 |
| `AO_REVIEW_START_HEAD_SHA` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/orchestrator-review-start-preflight.ps1 |
| `AO_REVIEW_START_MONOTONIC_NOW_MS` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/Review-StartEnvelopeExternalIo.ps1, scripts/estate-cut/task-311-tests/task-311-claim.test-support.ts |
| `AO_REVIEW_START_PREFLIGHT_SHIELD_CAPTURE_TIMEOUT_MS` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/Review-StartPreflightShield.ps1 |
| `AO_REVIEW_START_PREFLIGHT_SHIELD_JITTER_MS` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/Review-StartPreflightShield.ps1 |
| `AO_REVIEW_START_PREFLIGHT_SHIELD_MAX_ATTEMPTS` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/Review-StartPreflightShield.ps1 |
| `AO_REVIEW_START_PREFLIGHT_SHIELD_WALL_CLOCK_BUDGET_MS` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/lib/Review-StartPreflightShield.ps1 |
| `AO_REVIEW_START_PR_NUMBER` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/orchestrator-review-start-preflight.ps1 |
| `AO_REVIEW_START_RUN_ID` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/WorkerReportStore.ps1 |
| `AO_REVIEW_START_SCOPED_GH_COMMAND` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/_test-pwsh-helpers.ts, scripts/lib/Gh-PrChecks.ps1 |
| `AO_REVIEW_START_SCOPED_GH_FAIL_UNTIL_ATTEMPT` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/fixtures/review-start-scoped-gh-json-capture/fake-gh-scenario.ps1 |
| `AO_REVIEW_START_SCOPED_GH_HEAD_SHA` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/_test-pwsh-helpers.ts, scripts/lib/Review-StartPreflightShield.ps1 |
| `AO_REVIEW_START_SCOPED_GH_HEAD_SHA_A` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/_test-pwsh-helpers.ts, scripts/fixtures/review-start-scoped-gh-json-capture/fake-gh-scenario.ps1 |
| `AO_REVIEW_START_SCOPED_GH_HEAD_SHA_B` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/_test-pwsh-helpers.ts, scripts/fixtures/review-start-scoped-gh-json-capture/fake-gh-scenario.ps1 |
| `AO_REVIEW_START_SCOPED_GH_SCENARIO` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/_test-pwsh-helpers.ts, scripts/fixtures/review-start-scoped-gh-json-capture/fake-gh-scenario.ps1 |
| `AO_REVIEW_START_SCOPED_GH_STATE_FILE` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/_test-pwsh-helpers.ts, scripts/fixtures/review-start-scoped-gh-json-capture/fake-gh-scenario.ps1 |
| `AO_REVIEW_START_SUPERVISED_GH_COMMAND` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/Review-StartSupervisedGh.ps1, docs/migration_notes.md |
| `AO_REVIEW_START_TEST_CHILD_PID_FILE` | §7.2 test/harness-only | scripts/fixtures/review-start-envelope-external-io/steal-claim-then-hang.ps1 |
| `AO_REVIEW_START_TEST_CLAIM_PATH` | §7.2 test/harness-only | scripts/fixtures/review-start-envelope-external-io/steal-claim-then-hang.ps1 |
| `AO_REVIEW_START_TEST_DELAY_BEFORE_PID_UPDATE_MS` | §7.2 test/harness-only | scripts/lib/Review-StartSupervisedGh.ps1 |
| `AO_REVIEW_START_WRAPPER_CHILD_PID_FILE` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/fixtures/review-start-envelope-external-io/fake-gh-scenario.ps1 |
| `AO_REVIEW_SUBCOMMANDS` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/pr2-foundation/terminalized/ao-0-10-review-api.ts, docs/ao-0-10-review-api.mjs |
| `AO_REVIEW_TEST_BUDGET_MS` | §7.2 test/harness-only | plugins/ao-codex-pr-reviewer/lib/reviewer_budget.ts, plugins/ao-codex-pr-reviewer/bin/command-guard/guard-lib.sh, plugins/ao-codex-pr-reviewer/tests/reviewer-budget.test.ts |
| `AO_REVIEW_TRIGGER_PATH` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/pr2-foundation/terminalized/ao-0-10-review-api.ts, docs/ao-0-10-review-api.mjs |
| `AO_REVIEW_TRIGGER_RECONCILE_INTERVAL_MINUTES` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/review-trigger-reconcile.ps1, docs/orchestrator-recovery-runbook.md |
| `AO_REVIEW_TRIGGER_RECONCILE_STATE` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/review-trigger-reconcile.ps1, scripts/vitest-live-store-inventory.json (+7 more) |
| `AO_REVIEW_TRIGGER_REEVAL_WATCH_STATE` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/vitest-live-store-inventory.json, scripts/lib/vitest-live-store-harness.mjs (+4 more) |
| `AO_SANCTIONED_WORKER_KILL_RECORD_PATH` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/json-producers/sanctioned-worker-kill-record.ts, scripts/lib/Sanctioned-Worker-Kill-Record.ps1 |
| `AO_SCOPE_GUARD_BYPASS` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | plugins/ao-scope-guard/README.md, plugins/ao-scope-guard/hooks/pre-commit.ps1 (+1 more) |
| `AO_SCOPE_GUARD_SKIP_GH` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | plugins/ao-scope-guard/lib/denylist.ts |
| `AO_SCRIPTED_REVIEW_DELIVERY_DEBUG` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/Invoke-ScriptedReviewStdoutDelivery.ps1 |
| `AO_SCRIPTED_REVIEW_DELIVERY_POLL_INTERVAL_SECONDS` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | docs/orchestrator-recovery-runbook.md, docs/scripted-review-confirmed-delivery-gate.mjs |
| `AO_SCRIPTED_REVIEW_DELIVERY_POLL_WINDOW_SECONDS` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | docs/orchestrator-recovery-runbook.md, docs/scripted-review-confirmed-delivery-gate.mjs |
| `AO_SCRIPTED_REVIEW_SKIP_POST_SUBMIT_DELIVERY` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/Invoke-ScriptedReviewPostSubmitDelivery.ps1, docs/migration_notes.md |
| `AO_SCRIPTED_REVIEW_SUBMIT_VISIBILITY_SECONDS` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | docs/scripted-review-post-submit-delivery.mjs, docs/vitest-light-lane-isolation-audit-874.md |
| `AO_SEND` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/_ao-send-0102-test-fixture.ts, scripts/pr2-foundation/terminalized/worker-message-dispatch-observe.ts |
| `AO_SEND_0102_HELP` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/_ao-send-0102-test-fixture.ts, scripts/worker-message-submit-reconcile.test.ts |
| `AO_SEND_HELP_EOF` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/_ao-send-0102-test-fixture.ts, scripts/worker-message-submit-reconcile.test.ts |
| `AO_SESSION_KEYS` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/pr2-foundation/mutation-semantic-gates.ts, scripts/pr2-foundation/binding.ts |
| `AO_SESSION_KIND` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | docs/merge-triage-gate.mjs |
| `AO_SHELL` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/Test-WorkerLaunchFailure.ps1, docs/migration_notes.md |
| `AO_SIDE_EFFECT_LOCK_MAX_AGE_MINUTES` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/Orchestrator-SideEffectFence.ps1, scripts/pr2-foundation/worker-nudge-claim-store.ts |
| `AO_SIDE_PROCESS_AO_LIVENESS_SHIM_DISABLED` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/Orchestrator-SideProcessProgress.ps1 |
| `AO_SIDE_PROCESS_CHILD_ID` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/gh-wrapper.mjs, scripts/lib/gh-governor.mjs |
| `AO_SIDE_PROCESS_HEALTH_DEGRADED_THRESHOLD` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/Orchestrator-SideProcessHealth.ps1 |
| `AO_SIDE_PROCESS_HEALTH_RECOVERY_MAX_ATTEMPTS` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/Orchestrator-SideProcessHealth.ps1 |
| `AO_SIDE_PROCESS_LIVENESS_ACTIVE` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/gh |
| `AO_SIDE_PROCESS_LIVENESS_CLI` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/Orchestrator-SideProcessProgress.ps1 |
| `AO_SIDE_PROCESS_NOW_MS` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/Orchestrator-SideProcessProgressEvidence.ps1, scripts/lib/Orchestrator-SideProcessProgress.ps1 |
| `AO_SIDE_PROCESS_OWNER_PID` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/Orchestrator-SideProcessProgress.ps1, scripts/kernel/side-process-liveness.ts |
| `AO_SIDE_PROCESS_PRIOR_PROGRESS_JSON` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/run-review-ready-seed-liveness-fixture.ps1 |
| `AO_SIDE_PROCESS_PROGRESS_DIR` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/Orchestrator-SideProcessProgress.ps1, scripts/mechanical-json-state.Tests.ps1 |
| `AO_SIDE_PROCESS_STATE_DIR` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/review-delivery.test.ts, scripts/review-start-claim.test.ts |
| `AO_SIDE_PROCESS_TICK_ID` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/kernel/side-process-liveness.ts |
| `AO_SIGNAL_SURFACES` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/pr2-foundation/terminalized/events-optional-consumer-signal-recovery.ts, scripts/pr2-foundation/terminalized/events-optional-consumer-signal-recovery.d.ts |
| `AO_SPAWN_DISPLAY_NAME_MAX_LENGTH` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | docs/ao-spawn-shape.d.mts, docs/ao-spawn-shape.mjs |
| `AO_SPAWN_FIXTURE_PR_HEAD_OID` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/Autonomous-SpawnWorktreeGate.ps1 |
| `AO_SPAWN_FIXTURE_PR_REF_TOKEN` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/Autonomous-SpawnWorktreeGate.ps1 |
| `AO_SPAWN_WORKTREE_FIXTURE_MODE` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/Orchestrator-AutonomousSpawnGate.ps1, scripts/lib/Autonomous-SpawnWorktreeGate.ps1 |
| `AO_SPAWN_WORKTREE_GRANT_ID` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/Autonomous-SpawnWorktreeGate.ps1, docs/migration_notes.md |
| `AO_SPAWN_WORKTREE_SESSION_BASENAME_PATTERN` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | docs/spawn-worktree-grant.d.mts, docs/spawn-worktree-grant.mjs |
| `AO_TASK_CHAIN_ID` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | plugins/ao-token-chain-ledger/README.md, plugins/ao-token-chain-ledger/lib/writer.ts |
| `AO_TERMINAL_FLOOD_MIN_PAIRED_CYCLES` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | docs/orchestrator-recovery-runbook.md, docs/migration_notes.md |
| `AO_TERMINAL_FLOOD_WINDOW_SECONDS` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | docs/orchestrator-recovery-runbook.md, docs/migration_notes.md |
| `AO_TESTMODE_FLEET_HEARTBEAT_GRACE_SECONDS` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/TestMode-FleetLease.ps1 |
| `AO_TESTMODE_FLEET_LANE_LEASE_ID` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/run-vitest-heavy-shard.ps1, scripts/invoke-testmode-fleet-reaper.ps1 |
| `AO_TESTMODE_FLEET_LEASE_TTL_SECONDS` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/TestMode-FleetLease.ps1 |
| `AO_TESTMODE_FLEET_NO_PROGRESS_SECONDS` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/TestMode-FleetLease.ps1 |
| `AO_TMUX_NAME` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/_test-git-fixture.ts, docs/migration_notes.md |
| `AO_TRUSTED_PACK_ROOT` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/lib/Import-TrustedReverifyBootstrap.ps1, scripts/lib/Invoke-AoReviewApi.ps1 (+7 more) |
| `AO_VERSION` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/pr2-foundation/mutation-behavior-recipes.ts, scripts/pr2-foundation/binding.ts |
| `AO_WAKE_DEDUP_STATE` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/orchestrator-wake-common.ps1, scripts/vitest-live-store-inventory.json (+4 more) |
| `AO_WAKE_LISTENER_PROJECT_ID` | §7.2 test/harness-only | scripts/review-start-claim.test.ts |
| `AO_WAKE_LISTENER_SIDE_EFFECT_LOCK` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/vitest-live-store-inventory.json, scripts/lib/vitest-live-store-harness.mjs (+4 more) |
| `AO_WAKE_SUPERVISOR_CRASH_BASE_BACKOFF_SECONDS` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/lib/Orchestrator-SideProcessCrashBackoff.ps1 |
| `AO_WAKE_SUPERVISOR_CRASH_MAX_BACKOFF_SECONDS` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/lib/Orchestrator-SideProcessCrashBackoff.ps1 |
| `AO_WAKE_SUPERVISOR_CRASH_MAX_RAPID_EXITS` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/lib/Orchestrator-SideProcessCrashBackoff.ps1 |
| `AO_WAKE_SUPERVISOR_CRASH_RAPID_EXIT_THRESHOLD_MS` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/lib/Orchestrator-SideProcessCrashBackoff.ps1 |
| `AO_WAKE_SUPERVISOR_CRASH_TERMINAL_RAPID_EXITS` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/lib/Orchestrator-SideProcessCrashBackoff.ps1 |
| `AO_WAKE_SUPERVISOR_DEGRADED_BASE_BACKOFF_SECONDS` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/lib/Orchestrator-SideProcessDegradedBackoff.ps1, scripts/supervisor-fault-boundary.shared.ts (+1 more) |
| `AO_WAKE_SUPERVISOR_DEGRADED_DETERMINISTIC_TERMINAL_ATTEMPTS` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/lib/Orchestrator-SideProcessDegradedBackoff.ps1 |
| `AO_WAKE_SUPERVISOR_DEGRADED_MAX_ATTEMPTS_BEFORE_BACKOFF` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/lib/Orchestrator-SideProcessDegradedBackoff.ps1 |
| `AO_WAKE_SUPERVISOR_DEGRADED_MAX_BACKOFF_SECONDS` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/lib/Orchestrator-SideProcessDegradedBackoff.ps1, docs/migration_notes.md |
| `AO_WAKE_SUPERVISOR_DEGRADED_REPEATED_REASON_THRESHOLD` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/lib/Orchestrator-SideProcessDegradedBackoff.ps1, docs/migration_notes.md |
| `AO_WAKE_SUPERVISOR_DEGRADED_REPEATED_REASON_WINDOW_MS` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/lib/Orchestrator-SideProcessDegradedBackoff.ps1, docs/migration_notes.md |
| `AO_WAKE_SUPERVISOR_DEGRADED_STABLE_WORKING_POLLS` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/lib/Orchestrator-SideProcessDegradedBackoff.ps1, docs/migration_notes.md |
| `AO_WAKE_SUPERVISOR_FIXTURE` | §7.2 test/harness-only | scripts/fixtures/orchestrator-wake-supervisor/ao-stub.sh |
| `AO_WAKE_SUPERVISOR_ID_DEBOUNCE_POLLS` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | docs/migration_notes.md |
| `AO_WAKE_SUPERVISOR_LEASE_GATE_HOLD_MS` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/lib/Orchestrator-WakeSupervisorLease.ps1 |
| `AO_WAKE_SUPERVISOR_LEASE_HEARTBEAT_TTL_MS` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/lib/Orchestrator-WakeSupervisorLease.ps1, docs/migration_notes.md |
| `AO_WAKE_SUPERVISOR_LEASE_STALE_GRACE_MS` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/lib/Orchestrator-WakeSupervisorLease.ps1, docs/migration_notes.md |
| `AO_WAKE_SUPERVISOR_POLL_SECONDS` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | docs/orchestrator-autoloop-go-live.md |
| `AO_WAKE_SUPERVISOR_PROCESS_CMDLINE_FIXTURE` | §7.2 test/harness-only | scripts/lib/Get-ProcessCommandLine.ps1 |
| `AO_WAKE_SUPERVISOR_PROJECT_ID` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/lib/orchestrator-side-process-observer.ts, scripts/orchestrator-wake-supervisor-test-child.ps1 (+1 more) |
| `AO_WAKE_SUPERVISOR_RESTART_STAGGER_MS` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | docs/migration_notes.md |
| `AO_WAKE_SUPERVISOR_SESSION_GLITCH_POLLS` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | docs/migration_notes.md |
| `AO_WAKE_SUPERVISOR_START_HANDOFF_TIMEOUT_SEC` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/lib/Orchestrator-WakeSupervisorLease.ps1, docs/migration_notes.md |
| `AO_WAKE_SUPERVISOR_STATE_DIR` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/review-delivery.test.ts, scripts/_test-vitest-harness-env.ts (+12 more) |
| `AO_WAKE_SUPERVISOR_STATUS_FAILURE` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/lib/Orchestrator-SideProcessCrashBackoff.ps1, scripts/fixtures/orchestrator-wake-supervisor/ao-stub.sh |
| `AO_WAKE_SUPERVISOR_TERMINAL_REARM_GRACE_SECONDS` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/lib/Orchestrator-SideProcessCrashBackoff.ps1 |
| `AO_WAKE_SUPERVISOR_TERMINAL_REARM_MAX_ATTEMPTS` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/lib/Orchestrator-SideProcessCrashBackoff.ps1 |
| `AO_WAKE_SUPERVISOR_TERMINAL_REARM_TTL_SECONDS` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/lib/Orchestrator-SideProcessCrashBackoff.ps1 |
| `AO_WAKE_SUPERVISOR_TEST_ERROR_UNTIL_MS` | §7.2 test/harness-only | scripts/orchestrator-wake-supervisor-test-child.ps1 |
| `AO_WAKE_SUPERVISOR_TEST_FAST_STOP` | §7.2 test/harness-only | scripts/supervisor-recovery.test-helpers.ts |
| `AO_WAKE_SUPERVISOR_TEST_MARKER_DIR` | §7.2 test/harness-only | scripts/lib/Invoke-TestModeFleetReaper.ps1, scripts/lib/Orchestrator-FleetHygiene.ps1, scripts/orchestrator-wake-supervisor-test-child.ps1 |
| `AO_WAKE_SUPERVISOR_TEST_PROMPT_BLOCK_DELAY_MS` | §7.2 test/harness-only | scripts/orchestrator-wake-supervisor-test-child.ps1 |
| `AO_WAKE_SUPERVISOR_WAIT_SECONDS` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | docs/orchestrator-autoloop-go-live.md |
| `AO_WORKER_ITERATION_BRANCH_PATTERN` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | docs/dead-worker-reconciler.d.mts, docs/dead-worker-reconciler.mjs |
| `AO_WORKER_MESSAGE_ADOPTION_BRANCH` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/Invoke-WorkerMessageSendAdoptionPreflight.ps1, scripts/journaled-worker-send.ps1 |
| `AO_WORKER_MESSAGE_ADOPTION_CONFIG_PATH` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/Invoke-WorkerMessageSendAdoptionPreflight.ps1, scripts/lib/Get-WorkerMessageAdoptionBinding.ps1 |
| `AO_WORKER_MESSAGE_ADOPTION_CONFIG_PATH_HASH` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/Invoke-WorkerMessageSendAdoptionPreflight.ps1, scripts/journaled-worker-send.ps1 |
| `AO_WORKER_MESSAGE_ADOPTION_EPOCH` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/Invoke-WorkerMessageSendAdoptionPreflight.ps1, scripts/lib/Get-WorkerMessageAdoptionBinding.ps1 |
| `AO_WORKER_MESSAGE_ADOPTION_EPOCH_HASH` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/Invoke-WorkerMessageSendAdoptionPreflight.ps1, scripts/journaled-worker-send.ps1 |
| `AO_WORKER_MESSAGE_ADOPTION_PROBE` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/invoke-gated-worker-nudge.ps1, scripts/lib/Invoke-WorkerMessageSendAdoptionPreflight.ps1 |
| `AO_WORKER_MESSAGE_ADOPTION_PROBE_V1` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/invoke-gated-worker-nudge.ps1, scripts/lib/Invoke-WorkerMessageSendAdoptionPreflight.ps1 |
| `AO_WORKER_MESSAGE_ADOPTION_RUN_ID_HASH` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/Invoke-WorkerMessageSendAdoptionPreflight.ps1, scripts/journaled-worker-send.ps1 |
| `AO_WORKER_MESSAGE_ADOPTION_STATE` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/vitest-live-store-inventory.json, scripts/lib/vitest-live-store-harness.mjs (+5 more) |
| `AO_WORKER_MESSAGE_DISPATCH_JOURNAL` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/review-delivery.test.ts, scripts/vitest-live-store-inventory.json (+13 more) |
| `AO_WORKER_MESSAGE_SUBMIT_INTERVAL_SECONDS` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/worker-message-submit-reconcile.ps1, docs/orchestrator-recovery-runbook.md |
| `AO_WORKER_MESSAGE_SUBMIT_STATE` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/vitest-live-store-inventory.json, scripts/lib/vitest-live-store-harness.mjs (+7 more) |
| `AO_WORKER_NOTIFICATION_JOURNAL_LOCK_STALE_MS` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/pr2-foundation/worker-notification-compat.test.ts, scripts/pr2-foundation/journal-lock.ts |
| `AO_WORKER_NUDGE_CLAIM_DIR` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/_test-pwsh-helpers.ts, scripts/vitest-live-store-inventory.json (+6 more) |
| `AO_WORKER_NUDGE_CLAIM_LEASE_MS` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/Worker-NudgeClaim.ps1, scripts/pr2-foundation/worker-nudge-claim-store.ts |
| `AO_WORKER_NUDGE_CLAIM_STALE_MINUTES` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/Worker-NudgeClaim.ps1, scripts/pr2-foundation/worker-nudge-claim-store.ts |
| `AO_WORKER_RECOVERY_BRANCH_OBSERVATION_TTL_SECONDS` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/Worker-RecoveryBranchCleanup.ps1 |
| `AO_WORKER_RECOVERY_CLAIM_STALE_MINUTES` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/Worker-RecoveryClaim.ps1 |
| `AO_WORKER_RECOVERY_DIR` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/Worker-RecoveryClaim.ps1 |
| `AO_WORKER_RECOVERY_MUTEX_STALE_SECONDS` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/lib/Worker-RecoveryClaim.ps1 |
| `AO_WORKER_REPORT_DEBUG` | §7.3 pack-owned or non-AO-runtime (no AO consumer binding after surface map) | scripts/pack-worker-report.ps1 |
| `AO_WORKER_REPORT_STORE` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/vitest-live-store-inventory.json, scripts/lib/worker-status-store.mjs (+9 more) |
| `AO_WORKER_STATUS_STORE` | §7.3 pack-owned AO-flavoured name; not AO transport consumer | scripts/vitest-live-store-inventory.json, scripts/lib/worker-status-store.mjs (+7 more) |
| `AO_WRAPPER_SCRIPT` | §7.2 test/harness-only | scripts/gh-wrapper.test.ts |
