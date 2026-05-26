# ao-token-chain-ledger contract

Cross-session token and cost accounting for Composio AO chains without patching
AO core.

## Purpose

AO can expose per-session cost information when available. This contract adds a
chain-level ledger over related sessions, for example:

```text
task_chain_id
  planner session
  reviewer session
  worker session
  fix-worker session
  final-review session
```

The ledger answers "what did the whole task chain cost?" instead of only "what
did this one session cost?".

## Extension boundary

Allowed implementation surfaces:

- observability/accounting plugin;
- agent wrapper that records session start/end events;
- external ledger writer;
- AO session metadata when available;
- workspace-local or user-local `.ao/ledger/*.jsonl` / SQLite state.

Disallowed:

- Tracker plugin misuse for token accounting;
- patches to upstream `packages/core/`;
- committed secrets or API keys.

## Required fields

Each ledger row should record:

```json
{
  "chain_id": "stable-task-chain-id",
  "session_id": "ao-session-id",
  "parent_session_id": "optional-parent-session-id",
  "role": "planner|reviewer|worker|fix-worker|final-review|other",
  "task_id": "tracker-or-ao-task-id",
  "started_at": "iso8601",
  "ended_at": "iso8601",
  "input_tokens": 0,
  "output_tokens": 0,
  "estimated_cost_usd": 0.0,
  "source": "ao-session-cost|agent-wrapper|manual-import"
}
```

## Accounting rules

- Use AO per-session cost first when available.
- Preserve chain_id across planner, reviewer, worker, and fix sessions.
- Do not double count retries; record each session once and aggregate by
  `chain_id`.
- Mark missing token/cost data as unknown instead of inventing values.
- Keep raw ledger state outside committed source unless it is a sanitized sample.

## Outputs

- total input/output tokens per `chain_id`;
- total estimated cost per `chain_id`;
- per-role breakdown;
- missing-data report when some sessions lack AO cost data.
