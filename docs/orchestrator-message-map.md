# Orchestrator message map

> Generated from `scripts/orchestrator-message-catalog.json`. Do not edit by hand.

## Per-class summary

| message_class_id | trigger | owning_process | recipient | intent | mechanism | semantic_dedup |
| --- | --- | --- | --- | --- | --- | --- |
| ci-failure-reaction-routed | AO ci-failed reaction routed through journaled-worker-send wrapper | journaled-worker-send | specific-session | ci-failure-fix | ao-send | issue-283 |
| ci-failure-reconcile-ping | Pending red-CI episode eligible after reconcile preflight | ci-failure-notification-reconcile | head-owning-worker | ci-failure-fix | ao-send | issue-283 |
| ci-green-worker-nudge | Required CI green + worker pre-hand-off state after reconcile | ci-green-wake-reconcile | head-owning-worker | ci-green-handoff | ao-send | none |
| orchestrator-wake-heartbeat | Periodic heartbeat tick when orchestrator session is live | heartbeat | orchestrator-session | heartbeat-nudge | ao-send | none |
| orchestrator-wake-webhook | AO webhook POST routed through wake filter yields a wake message | listener | orchestrator-session | wake-nudge | ao-send | none |
| review-findings-first-send | AO 0.10 auto-delivery on review submit (pack first-send reconcile REMOVED) | review-finding-delivery-confirm | specific-session | review-findings-first | ao-auto-delivery | none |
| review-findings-redelivery | Bounded re-delivery when first send unconfirmed | review-finding-delivery-confirm | specific-session | review-findings-redelivery | ao-review-send | none |
| worker-input-draft-submit | Pending worker-input draft observed in dispatch journal | worker-message-submit-reconcile | specific-session | worker-input-submit | draft-submit | none |

## Escalation classes

| code | escalation_class_id | trigger | owning_process | route | delivery_guarantee | dedupe_owner |
| --- | --- | --- | --- | --- | --- | --- |
| E1 | escalation-dead-worker-recovery | Dead worker recovery exhausted | dead-worker-reconcile | llm-orchestrator | at-least-once-until-ack | issue-641 |
| E2 | escalation-claim-store-integrity | Worker nudge claim-store integrity failure | worker-message-submit-reconcile | operator | at-least-once-operator-inbox | issue-641 |
| E3 | escalation-review-trigger-degraded-ci | Review trigger degraded CI exhausted | review-trigger-reconcile | llm-orchestrator | at-least-once-until-ack | issue-641 |
| E4 | escalation-review-run-recovery | Review-run recovery failed | review-run-recovery | llm-orchestrator | at-least-once-until-ack | issue-641 |
| E5 | escalation-submit-adoption | Worker message submit adoption escalated | worker-message-submit-reconcile | llm-orchestrator | at-least-once-until-ack | issue-641 |
| E6 | escalation-handoff-envelope | Worker blocked / handoff question admitted | listener | llm-orchestrator | at-least-once-until-ack | issue-641 |
| E7 | escalation-protected-finding | Contested protected finding (deferred sibling #625) | review-finding-delivery-confirm | operator | at-least-once-operator-inbox | issue-641 |
| E8 | escalation-pipeline-failure | Escalation pipeline publish/delivery failure | escalation-router | operator | at-least-once-operator-inbox | issue-641 |
| E10 | escalation-ci-failure-notify | CI failure notification reconcile escalate | ci-failure-notification-reconcile | llm-orchestrator | at-least-once-until-ack | issue-641 |
| E11 | escalation-ci-green-claim-audit | CI green wake claim escalate (audit) | ci-green-wake-reconcile | auto-retry-only (promotes after 5 ticks to escalation-ci-green-claim) | audit-until-promotion | issue-641 |
| E11-promoted | escalation-ci-green-claim | CI green wake claim escalate (promoted) | ci-green-wake-reconcile | llm-orchestrator | at-least-once-until-ack | issue-641 |
| E12 | escalation-gated-nudge | Gated worker nudge gate/claim escalate | ci-green-wake-reconcile | llm-orchestrator | at-least-once-until-ack | issue-641 |
| E13 | escalation-envelope-ledger | Review-start envelope ledger mark-escalated | review-start-claim-reaper | operator | at-least-once-operator-inbox | issue-641 |
| E14 | escalation-review-start-claim | Review-start claim escalation path | review-start-claim-reaper | llm-orchestrator | at-least-once-until-ack | issue-641 |
| E15 | escalation-worker-recovery | Worker recovery lib escalation branch | dead-worker-reconcile | llm-orchestrator | at-least-once-until-ack | issue-641 |

## Overlap summary

- Unowned collisions: 0
- Owner-covered pairs: 1
- Evidenced overrides: 0

