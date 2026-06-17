# Orchestrator message catalog

This catalog is the single source of truth for orchestrator-originated worker/orchestrator
messages. CI audits every pack send site against it and regenerates
[`orchestrator-message-map.md`](./orchestrator-message-map.md).

## Add a new message class

1. **Pick taxonomy keys** — add new `recipient_key` / `intent_key` values (and alias edges if
   needed) in [`scripts/orchestrator-message-taxonomy.json`](../scripts/orchestrator-message-taxonomy.json).
2. **Route through a registered helper** — raw `ao send`, `ao review send`, and draft-submit
   side-effects must live inside a helper listed in
   [`scripts/orchestrator-message-send-helpers.manifest.json`](../scripts/orchestrator-message-send-helpers.manifest.json).
   New helpers must accept a static `message_class_id` at their boundary.
3. **Add a catalog entry** — one row per `message_class_id` in
   [`scripts/orchestrator-message-catalog.json`](../scripts/orchestrator-message-catalog.json)
   with trigger summary, owning #205 process, mechanism, owner references, and a callsite
   signature (`file` / `function` / `anchor` + `predicateBodyHash`).
4. **Compute the predicate hash** —
   `node docs/orchestrator-message-registry.mjs hash-callsites .` and copy the hash into the
   catalog entry.
5. **Regenerate the map** —
   `pwsh -NoProfile -File scripts/generate-orchestrator-message-map.ps1` and commit the diff.
6. **Verify** — `pwsh -NoProfile -File scripts/check-orchestrator-message-registry.ps1` must PASS.

Existing frozen runtime callsites bind through catalog-declared signatures only (no runtime
edits). Overlap is inferred from taxonomy keys; clear collisions with a `semantic_dedup_owner`
scope or a fully evidenced `overlapOverrides` row.
