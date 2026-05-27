# Implement ao-task-declaration state + validator

## Prerequisite

Issue #3 — Architecture decisions (file `docs/issues_drafts/00-architecture-decisions.md`) must be merged. This issue uses the
two-level model from #3.A (issue body = constraints, snapshot = active scope),
the iteration identity rule from #3.B, the baseline format from #3.D, and the
shared package location from #3.E.

## Goal

Implement DD-026/DD-027 equivalent. Split into two clearly separated
responsibilities:

1. **Issue parser** — extracts authoritative task constraints (`denylist`,
   optional `allowed_roots`) from the linked GitHub Issue body.
2. **Implementer declaration CLI** — produces the active-scope snapshot under
   `docs/declarations/{issue_number}.{iteration_id}.json`, validates it
   against the issue constraints, writes the gitignored mirror under
   `.ao/declarations/`, and enforces the one-amendment-per-iteration rule.

## Binding surface

Agent wrapper + committed snapshot artifact + gitignored runtime mirror.

Reason: AO does not expose a "pre-task validator" plugin slot. The CLI is
invoked by the wrapper under AO's existing agent slot (cursor/codex). The
snapshot is committed as a PR artifact per Issue #3.A; the runtime mirror is
local-only. No core patches; no unsupported YAML fields.

## Files in scope

- `plugins/_shared/lib/normalize.ts` (new) — path normalization (used by #4, #5, #6)
- `plugins/_shared/lib/declaration_schema.ts` (new) — declaration JSON schema + types
- `plugins/_shared/lib/issue_parser.ts` (new) — parse `denylist` / `allowed_roots` fenced blocks from issue body
- `plugins/_shared/package.json` (new)
- `plugins/ao-task-declaration/lib/validate.ts` (new) — enforce #3.A formula against issue constraints
- `plugins/ao-task-declaration/lib/snapshot.ts` (new) — write `docs/declarations/{issue_number}.{iteration_id}.json`
- `plugins/ao-task-declaration/lib/mirror.ts` (new) — write/read `.ao/declarations/` mirror
- `plugins/ao-task-declaration/lib/baseline.ts` (new) — compute baseline per #3.D; reject dirty worktree
- `plugins/ao-task-declaration/lib/iteration.ts` (new) — resolve `iteration_id` per #3.B (AO session id or fallback)
- `plugins/ao-task-declaration/lib/amendment.ts` (new) — single-amendment gate per `iteration_id`
- `plugins/ao-task-declaration/bin/declare.ts` (new) — CLI: `ao-declare --issue <n>`
- `plugins/ao-task-declaration/package.json` (new)
- `plugins/ao-task-declaration/README.md` — append usage section

## Files out of scope

- `vendor/agent-orchestrator/**`
- `packages/core/**` (anywhere)
- Other `plugins/` directories
- `agent-orchestrator.yaml` and `.example`

## Denylist

- `vendor/**`
- `packages/core/**`
- `.ao/**` (runtime state, not source)
- `.env*`, secrets, key files

## Acceptance criteria

- `ao-declare --issue <n>` reads issue body via `gh issue view <n> --json body`.
- Issue parser extracts ` ```denylist ` (mandatory) and ` ```allowed-roots ` (optional) from body.
- CLI writes the snapshot to `docs/declarations/{issue_number}.{iteration_id}.json` with all mandatory metadata fields from #3.A.
- CLI writes a mirror copy under `.ao/declarations/` (gitignored).
- Declaration-time validation enforces only the constraints knowable at declaration time:
  - `declared_paths ⊆ issue.allowed_roots` (when `allowed_roots` is present)
  - `declared_paths ∩ issue.denylist = ∅` (always)
  - `declared_paths` and `declared_globs` are normalized and well-formed
  - Snapshot JSON conforms to `_shared/declaration_schema`
  - The `PR diff ⊆ declared` containment from #3.A is **not** checked here; it is enforced by the runtime guard (#5) and CI (#6).
- Baseline recorded per #3.D: `{ commit_sha, worktree_dirty, active_scope_hash }`.
- `worktree_dirty = true` causes declaration rejection with explicit error.
- `iteration_id` resolved per #3.B: AO session id when available; `wrap-{ts}-{uuid}` fallback otherwise; `iteration_id_source` recorded.
- Second amendment within the same `iteration_id` is rejected without modifying the snapshot; first amendment is recorded in `amendments[]`.
- Path normalization rejects `..`, drive letters, absolute paths, mixed slashes, symlink escapes.
- README updated with example issue body, example snapshot, CLI invocation.
- Unit tests cover: schema, normalization, issue parser, validation formula, baseline dirty-reject, amendment gate, iteration fallback.

## Upgrade-safety check

- `git ls-files | rg -e '^(packages/core|vendor/)'` returns nothing.
- Implementation runs on stock `@aoagents/ao` installed via `npm install -g`; no AO source patched.
- `agent-orchestrator.yaml` not modified to add unsupported fields.
- `.ao/declarations/` is gitignored.
- `./scripts/verify.ps1` and `./scripts/check-reusable.ps1` still pass.

## Verification

- `npm test --workspace=plugins/ao-task-declaration` passes.
- Manual: open a test GitHub Issue with a mandatory ` ```denylist ` fence and an optional ` ```allowed-roots ` fence; pass `--declared-paths` to `ao-declare`; inspect the resulting snapshot in `docs/declarations/` and mirror in `.ao/declarations/`.
