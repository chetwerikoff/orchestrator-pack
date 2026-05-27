# Implement ao-token-chain-ledger writer + aggregator

## Prerequisite

Issue #3 — Architecture decisions (file `docs/issues_drafts/00-architecture-decisions.md`) must be merged. This issue uses `chain_id`
distinct from `iteration_id`: a chain may contain multiple iterations
(re-runs after CI fail), but the ledger aggregates by chain.

This issue should land before #6 and #9 emit review/CI events so downstream
components do not invent ad-hoc event formats.

## Goal

Cross-session cost, review, reaction, and convergence accounting under a single
`chain_id` (planner → worker → reviewer → fix-worker → final review), on top of
AO's existing per-session cost when available.

The ledger answers "what did the whole task chain cost and how did the loop
behave?" instead of only "what did this one session cost?".

## Binding surface

Agent wrapper (writer) plus a standalone CLI (aggregator). External JSONL state
under `.ao/ledger/`.

Reason: AO does not expose a complete observability slot. The wrapper records
session, finding, reaction, escalation, and cost observations without touching
AO core.

## Files in scope

- `plugins/ao-token-chain-ledger/lib/writer.ts` (new) — append ledger rows with `chain_id`
- `plugins/ao-token-chain-ledger/lib/aggregate.ts` (new) — aggregate by `chain_id`, role tag, event kind, and finding signature
- `plugins/ao-token-chain-ledger/lib/session_cost.ts` (new) — read AO session cost when present
- `plugins/ao-token-chain-ledger/bin/ledger.ts` (new) — CLI: `ao-ledger report --chain <id>`
- `plugins/ao-token-chain-ledger/package.json` (new)
- `plugins/ao-token-chain-ledger/README.md` — append usage section

## Files out of scope

- AO core, `vendor/`
- Tracker plugins
- Other plugin directories

## Denylist

- `vendor/**`
- `packages/core/**`
- `.ao/ledger/**` (runtime state, gitignored)
- `.env*`, secrets

## Acceptance criteria

- Writer accepts append-only JSONL rows with this core shape:

```json
{
  "chain_id": "string",
  "chain_id_source": "ao | issue | pr | wrapper_generated | manual",
  "iteration_id": "string | null",
  "session_id": "string | null",
  "parent_session_id": "string | null",
  "parent_session_id_source": "ao | inferred | unavailable | manual",
  "task_id": "issue-or-task-id",
  "event_kind": "started | finished | finding | reaction | escalation | cost-observed",
  "role": "string tag",
  "timestamp": "ISO 8601",
  "finding": null,
  "reaction": null,
  "cost": {
    "input_tokens": null,
    "output_tokens": null,
    "estimated_cost_usd": null,
    "source": "ao-session-cost | agent-output-parse | manual-import | unavailable"
  }
}
```

- `role` is a tag, not a schema enum. Known values may include `planner`,
  `worker`, `reviewer`, or `fix-worker`, but new AO role names are preserved as
  data.
- `event_kind` has a recognized initial set (`started`, `finished`, `finding`,
  `reaction`, `escalation`, `cost-observed`). Unknown values are preserved
  as-is by writer and aggregator; additions to the recognized set require a
  schema migration note in #3.
- Finding events embed the structured finding object from #3.F, including
  `code`; the writer or aggregator computes the derived `signature` from
  `(type, code, normalized path)`.
- `chain_id` is mandatory. Source priority:
  1. explicit `AO_CHAIN_ID`;
  2. AO chain/task id if exposed;
  3. linked issue id as `issue-{n}`;
  4. wrapper fallback `chain-{utc_timestamp}-{short_uuid}`, persisted locally so later events reuse it.
- Missing `parent_session_id` never crashes the writer. Record
  `parent_session_id: null` and `parent_session_id_source: "unavailable"`.
- **Three-source fallback** for cost data, recorded in `cost.source`:
  1. `"ao-session-cost"` — read AO's documented `AgentSessionInfo.cost` when available;
  2. `"agent-output-parse"` — parse known cost lines from agent stdout when AO does not expose the event;
  3. `"manual-import"` — explicit user-supplied row.
- Missing cost data is recorded as `null` with `source: "unavailable"`; aggregator never silently zero-fills.
- Aggregator outputs: total in/out tokens, total cost, per-role-tag breakdown, missing-data report, per-`iteration_id` rollup, and finding signature recurrence counts.
- A sanitized sample ledger fixture lives under `plugins/ao-token-chain-ledger/tests/fixtures/`.
- Live ledger writes go only to `.ao/ledger/` and stay out of git.

## Upgrade-safety check

- Reads AO session cost via documented shapes when available and degrades to parsed/manual/unavailable sources otherwise.
- No assumptions about AO internals beyond documented fields.
- No core / vendor / YAML changes.

## Verification

- Unit tests: aggregation math, missing-data handling, role tag grouping, unknown `event_kind` preservation, finding signature recurrence.
- Integration test: synthetic chain of three sessions; report matches expected totals and recurrence counts.
- `./scripts/verify.ps1` still passes.
