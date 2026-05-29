# SkillOpt trilogy — shared pack boundaries

Canonical shared **Files out of scope** and **Denylist** fences for drafts 28–30.
Issue-specific drafts cross-link here instead of duplicating fenced literals.

## Files out of scope (shared)

- The finding format / `NO_FINDINGS` contract (owned by GitHub #9) — reused, not changed.
- Run-state discipline (failed/cancelled run ≠ clean) — owned by GitHub #79.
- Any autonomous optimizer that edits prompts without operator acceptance.
- `agent-orchestrator.yaml` / `.ao/**` (gitignored live files).
- `packages/core/**`, `vendor/**`, AO upstream schema or CLI changes.

## Denylist

```denylist
vendor/**
packages/core/**
code-reviews/**
.ao/**
```

```allowed-roots
scripts/**
tests/**
docs/**
```
