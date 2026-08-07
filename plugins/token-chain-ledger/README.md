# token-chain-ledger contract

Runtime-neutral cross-session token, cost, and convergence accounting.

## Purpose

The ledger answers what an entire task chain cost, rather than only what one
executor session cost:

```text
chain_id
  planner
  reviewer
  worker
  fix-worker
  final-review
```

It consumes explicit observations. It never discovers sessions through a concrete
runtime API and never invents unavailable token or cost data.

## Extension boundary

Supported surfaces are the accounting plugin, explicit wrapper events, external
ledger writers, and pack-owned `.orchestrator-pack/ledger/` state. Do not patch
`packages/core/**`, misuse tracker fields as cost authority, or commit credentials.

## Required fields

```json
{
  "chain_id": "stable-task-chain-id",
  "session_id": "explicit-session-id",
  "parent_session_id": null,
  "role": "planner|reviewer|worker|fix-worker|final-review|other",
  "task_id": "issue-1352",
  "started_at": "iso8601",
  "ended_at": "iso8601",
  "input_tokens": 0,
  "output_tokens": 0,
  "estimated_cost_usd": 0.0,
  "source": "runtime-session-cost|agent-output-parse|manual-import|unavailable"
}
```

Preserve `chain_id` across planner, reviewer, worker, and fix sessions. Each session
is counted once. Missing values are `null` or unavailable, not zero by assumption.
Per-session cost is attached only to terminal or explicit cost-observed rows; the
aggregator deduplicates equivalent observations by `session_id` and source priority.

## Recording events

Install dependencies from the frozen lockfile, then use `pack-ledger`:

```bash
npm ci --include=dev
pack-ledger report --chain issue-1352 --json
```

Append-only rows live under `.orchestrator-pack/ledger/events.jsonl`. `chain_id` is
resolved from explicit input, explicit task metadata, `issue-{n}`, or a persisted
pack-owned fallback. Runtime and session metadata are accepted only through the
explicit input object; environment aliases are not read.

## Aggregation

Reports include total input and output tokens, total `estimated_cost_usd`, per-role,
per-session cost, per-iteration rollups, missing-data counts, repeated finding
signatures, preserved unknown event kinds, and convergence.

Convergence is derived only from ledger rows. The latest iteration is converged when
it has no blocking finding, no scope violation, and no blocking CI finding or
`ci-failed` reaction. An escalation row yields `escalated`; a terminal chain without
convergence or escalation yields `abandoned`.

Finding signatures are stable hashes of normalized type, code, and path. The same
signature in multiple iterations is reported as repeated evidence; it does not
automatically authorize a retry or runtime effect.

## Safety

- ledger data is accounting evidence, not lifecycle authority;
- a `session_id`, cost row, path, or role never authorizes a runtime action;
- exact runtime effects require an adapter-produced `{ runtime, id, generation }`
  identity;
- raw ledger state remains untracked unless it is a sanitized fixture;
- no core patch, hidden retry, or runtime fallback is part of this plugin.

## Contract markers

- `chain_id`
- planner
- reviewer
- worker
- per-session cost
- `estimated_cost_usd`
