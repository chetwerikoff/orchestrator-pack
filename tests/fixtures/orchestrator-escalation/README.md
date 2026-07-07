# Orchestrator escalation scenario matrix fixtures (Issue #641)

Sanitized fixtures for event classes E1–E15 and cross-cutting axes F1–F6.
Vitest coverage lives in `scripts/orchestrator-escalation.test.ts`.

| ID | Fixture focus |
| --- | --- |
| E1 | Dead worker recovery exhausted |
| E2 | Claim-store integrity (operator route) |
| E3 | Review trigger degraded CI |
| E4 | Review-run recovery failed |
| E5 | Submit adoption escalation |
| E6 | Handoff envelope admission |
| E8 | Pipeline self-failure / health spool |
| E10 | CI failure notification escalate |
| E11 | CI green claim auto-retry promotion |
| E12 | Gated nudge escalate |
| E13 | Envelope ledger mark-escalated |
| E14 | Review-start claim escalation |
| E15 | Worker recovery lib escalate |

E7 (protected finding) deferred to sibling #625. E9 (wake-storm control) covered by vitest wake cap test.
