# Auto-fix loop convergence metrics and tests

## Prerequisite

Issues #8 and #9 must be merged. This issue consumes ledger events from #8 and
structured findings from #3.F / #9.

## Goal

Define and test how AO reaction-driven auto-fix loops are measured, reported,
and escalated without patching AO core.

## Binding surface

Ledger reports and fixtures only. AO reactions remain configured in
`agent-orchestrator.yaml.example`; this issue does not introduce a new reviewer
or a new AO plugin slot.

## Files in scope

- `plugins/ao-token-chain-ledger/lib/convergence.ts` (new) — compute loop state from ledger events
- `plugins/ao-token-chain-ledger/tests/fixtures/` — converging, repeated-finding, CI-fail, and missing-cost fixtures
- `plugins/ao-token-chain-ledger/README.md` — document convergence report
- `docs/issues_drafts/09-auto-fix-loop-convergence.md` — this spec

## Files out of scope

- AO core, vendor
- New review systems
- Per-issue threshold overrides

## Acceptance criteria

- Define convergence as:
  - no blocking findings;
  - CI green;
  - no scope violations.
- Define repeated finding as the same structured finding `signature` appearing
  across multiple review/fix iterations.
- Convergence report includes:
  - total iteration count;
  - blocking finding count by iteration;
  - repeated signatures;
  - final state: `converged`, `escalated`, or `abandoned`;
  - missing cost/token data summary.
- Threshold sources are limited to:
  - AO reaction configuration for operational retry/escalation behavior;
  - ledger report configuration for analytical warnings.
- Prompt rules do not duplicate numeric thresholds.
- Fixtures cover:
  - review flags finding → worker fixes → review clean;
  - same signature repeats across iterations;
  - CI fails then passes after fix;
  - missing cost data with valid loop accounting.

## Upgrade-safety check

- Reads only ledger JSONL and config; no AO internals.
- No AO YAML schema changes.
- No core / vendor changes.

## Verification

- Unit tests for convergence states and repeated-signature detection pass.
- `ao-ledger report --chain <id>` displays convergence state for fixture chains.
- `./scripts/verify.ps1` and `./scripts/check-reusable.ps1` still pass.
