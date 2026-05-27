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

## Usage

Install workspace dependencies from the repository root (`npm install`), then use the
`ao-ledger` CLI from `plugins/ao-token-chain-ledger` (or via `npx tsx` on the bin).

### Recording events (writer)

Append-only rows are written to `.ao/ledger/events.jsonl` under the repository root.
`chain_id` is resolved in priority order: `AO_CHAIN_ID` → AO chain/task id
(`chain_id`, `AO_TASK_CHAIN_ID`, session `task_id`, `AO_TASK_ID`) → `issue-{n}`
→ persisted wrapper fallback (`chain-{utc}-{uuid}` in `.ao/ledger/active-chain.json`).

```typescript
import { appendLedgerRow, prepareLedgerRow } from './lib/writer.js';

const row = prepareLedgerRow({
  repoRoot: process.cwd(),
  issueNumber: 8,
  event_kind: 'finished',
  role: 'worker',
  task_id: '8',
});
appendLedgerRow(row, { repoRoot: process.cwd() });
```

Cost fields use the three-source fallback (`ao-session-cost` via
`AO_SESSION_INFO_JSON`, `agent-output-parse` from stdout, or `manual-import`).
Session-level cost is attached only on `finished` and `cost-observed` rows so a
`started`/`finished` pair does not double-count the same session. The aggregator
also keeps at most one `ao-session-cost` / `agent-output-parse` row per
`session_id` (preferring `ao-session-cost`, then `agent-output-parse`, then
`finished` over `cost-observed`). Explicit
`manual-import` rows always count. Missing cost is stored as `null` with
`source: "unavailable"`.

### Aggregating a chain

```bash
ao-ledger report --chain issue-8
ao-ledger report --chain fixture-chain-8 --ledger plugins/ao-token-chain-ledger/tests/fixtures/three-session-chain.jsonl
ao-ledger report --chain issue-8 --json
```

Reports include total in/out tokens, total estimated cost, per-role and per-iteration
rollups, missing-data counts, finding signature recurrence, and preserved unknown
`event_kind` values.

## Outputs

- total input/output tokens per `chain_id`;
- total estimated cost per `chain_id`;
- per-role breakdown;
- missing-data report when some sessions lack AO cost data.
