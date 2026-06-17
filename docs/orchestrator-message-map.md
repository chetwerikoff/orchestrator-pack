# Orchestrator message map

> Generated from `scripts/orchestrator-message-catalog.json`. Do not edit by hand.

## Per-class summary

| message_class_id | trigger | owning_process | recipient | intent | mechanism | semantic_dedup |
| --- | --- | --- | --- | --- | --- | --- |
| ci-failure-orchestrator-turn | Orchestrator turn CI FAILURE DISCIPLINE predicate returns SEND | orchestrator-rules | head-owning-worker | ci-failure-fix | ao-send | issue-283 |
| ci-failure-reaction-routed | AO ci-failed reaction routed through journaled-worker-send wrapper | journaled-worker-send | specific-session | ci-failure-fix | ao-send | issue-283 |
| ci-green-worker-nudge | Required CI green + worker pre-hand-off state after reconcile | ci-green-wake-reconcile | head-owning-worker | ci-green-handoff | ao-send | none |
| orchestrator-wake-heartbeat | Periodic heartbeat tick when orchestrator session is live | heartbeat | orchestrator-session | heartbeat-nudge | ao-send | none |
| orchestrator-wake-webhook | AO webhook POST routed through wake filter yields a wake message | listener | orchestrator-session | wake-nudge | ao-send | none |
| review-findings-first-send | Review run needs_triage with unsent findings on live session | review-send-reconcile | specific-session | review-findings-first | ao-review-send | none |
| review-findings-redelivery | Bounded re-delivery when first send unconfirmed | review-finding-delivery-confirm | specific-session | review-findings-redelivery | ao-review-send | none |
| worker-input-draft-submit | Pending worker-input draft observed in dispatch journal | worker-message-submit-reconcile | specific-session | worker-input-submit | draft-submit | none |

## Overlap summary

- Unowned collisions: 0
- Owner-covered pairs: 1
- Evidenced overrides: 0

