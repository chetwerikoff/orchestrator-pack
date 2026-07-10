# Pack-Owned Worker Report Store Live Probes - 2026-07-09

Issue: #717

## Summary

AO 0.10 no longer provides the worker report receipt surfaces previously used by pack review
consumers. The pack now owns worker report state through `pack-worker-report`, persisted in
`~/.local/state/orchestrator-pack-wake-supervisor/worker-report-store.json`.

## Live Probes

Captured under `tests/external-output-references/captures/ao-0-10-cli/`.

| Command | Exit | Evidence |
| --- | ---: | --- |
| `ao report` | 1 | `unknown command "report" for "ao"` |
| `ao status --json --reports full` | 2 | `unknown flag: --reports` |

## Contract

- Worker report writes go through `pack-worker-report --state <state>`.
- Consumers read `pack-worker-report-store` records only for live worker acknowledgements.
- Removed AO report surfaces are not valid fallback receipts: `ao report`,
  `ao status --reports`, `/sessions/{id}/reports`, and `.agent-report-audit`.
- If a worker lacks a trusted repo/session/PR/head binding for the report store, the report write is
  skipped silently and no PR or issue comment is used as a substitute worker report state.
