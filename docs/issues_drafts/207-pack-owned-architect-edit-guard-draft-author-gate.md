# Pack-owned architect edit guard with draft-author override gate

GitHub Issue: #618

## Prerequisite

- `docs/issues_drafts/190-relocate-draft-authoring-to-cursor-session.md` (GitHub #579,
  closed) — ships the relocation contract: architect owns the brief; the isolated
  Cursor draft-author session authors task specs. **This draft adds the missing runtime
  gate** that the #579 prose/check surfaces do not enforce today.
- `docs/issues_drafts/12-architect-role-tighten.md` (GitHub #37, closed) — ships the
  architect direct-edit prohibition for tracked implementation surfaces and the
  `direct-fix-checklist` escape hatch. **Already does:** category-based deny for
  plugins/scripts/tests/prompts with `AO_DIRECT_EDIT_REASON` as the recorded override.
  **Not shipped:** pack-owned, versioned PreToolUse hook source or regression tests;
  the live guard remains machine-local and gitignored.
- `docs/issues_drafts/35-operator-adoption-handoff-contract.md` (GitHub #101, closed) —
  ships the three-role operator adoption contract. **Reused here:** tracked hook source
  ships in the PR; the operator manually re-points gitignored Claude Code settings at
  the tracked source after merge.
- `scripts/check-draft-author-relocation-contract.ps1` +
  `scripts/draft-author-relocation-contract.mjs` (shipped with #579) — validate
  relocation **prose surfaces** only. **Not shipped:** runtime Write/Edit enforcement
  in the architect's Claude Code session.

Prior-art verdict (**recon 2026-07-06**): **genuinely new single-PR guard build.**
`gh issue list` (open/closed) for `architect edit guard`, `guard-direct-edit`,
`draft-author override`, `PreToolUse guard`, and `AO_DRAFT_AUTHOR` found no open issue
and no closed issue that already owns pack-tracked architect PreToolUse hook source or
a draft-author override runtime gate. Local `docs/issues_drafts/**` search found no
queued draft on this axis. This is not a decomposition child; one coherent contract
(tracked guard + tests + operator adoption) fits a single PR.

## Goal

Make the architect-session Claude Code PreToolUse edit guard **pack-owned and
tested**, and extend it so Write/Edit of task draft files under
`docs/issues_drafts/` is **denied by default** unless the operator records an explicit
architect-as-author override reason — steering normal authoring to the isolated
Cursor draft-author session per #579 while preserving the legitimate architect-as-author path.

```behavior-kind
action-producing
```

```complexity-tier
tier: T1
advisory-prior: T1
```

The guard enacts observable allow/deny decisions on architect-session Write/Edit
attempts; regression tests prove the decision matrix.

## Binding surface

- **Pack-owned hook source.** Ship a tracked, reviewable implementation of today's
  machine-local `.claude/hooks/guard-direct-edit.mjs` behavior (planner picks path and
  module layout under allowed roots). The live gitignored copies
  (`.claude/hooks/guard-direct-edit.mjs`, `.claude/settings.json`) are **not** edited by
  the worker PR.
- **Operator adoption (required).** After merge, the operator re-points machine-local
  Claude Code PreToolUse wiring (`Edit` and `Write` matchers) at the **tracked hook
  source** — via symlink or a tiny local wrapper that delegates to the tracked file.
  A one-time copy into `.claude/hooks/` is discouraged because it recreates the drift
  class this draft closes; if an operator must copy, the adoption checklist MUST
  include an observable refresh step (re-copy or hash check against tracked source)
  after every pack pull that touches the hook. Document the steps in
  `docs/migration_notes.md` and the PR `## Operator adoption` section. Include a
  verification step: an architect-session Write to `docs/issues_drafts/<probe>.md`
  without `AO_DRAFT_AUTHOR_FALLBACK_REASON` must deny with the draft-author delegation
  message; with a non-empty reason set, the same probe must allow.
- **Preserve today's guard contract** (verified against live source quoted in the
  architect brief):
  - Read stdin JSON; extract `tool_input.file_path`.
  - Resolve path relative to `CLAUDE_PROJECT_DIR` (default: cwd).
  - **Fail-open** when JSON parse fails, required fields are missing, or the resolved
    path escapes the project root.
  - **Deny** via PreToolUse hook output: `hookSpecificOutput.permissionDecision: "deny"`
    with a human-readable reason, **exit 0** (not a thrown error).
  - Existing allowlist surfaces remain **no harder than today** (architect-session
    guard only — not worker PR scope; see Denylist note below):
    `.claude/**`, `CLAUDE.md`, `docs/architecture.md`, `docs/issue_queue_index.md`,
    `.ao/**`, `agent-orchestrator.yaml`.
  - `AO_DIRECT_EDIT_REASON` (non-empty) continues to allow Write/Edit on paths that are
    not otherwise allowed — including non-draft denied paths. It does **not** replace
    the draft-specific override gate below.
- **Draft-file gate (new behavior).** Remove the unconditional allow rule for all of
  `docs/issues_drafts/**`. Replace it with a **scoped gate** on task draft markdown at
  the issues-drafts root only:
  - **Gated:** `docs/issues_drafts/<name>.md` where `<name>` is a single path segment
    (no `/` in the name). Examples: `207-pack-owned-architect-edit-guard.md` — gated;
    `docs/issues_drafts/.review/207-slug/pass-01.capture.txt` — **not** gated.
  - **Deny** gated draft-file Write/Edit unless `AO_DRAFT_AUTHOR_FALLBACK_REASON` is
    non-empty (trimmed). The deny reason MUST name the default route: delegate spec
    authoring to an isolated Cursor draft-author session from the architect brief
    (#579), and state that setting `AO_DRAFT_AUTHOR_FALLBACK_REASON` records the
    legitimate architect-as-author override per #579.
  - **Allow** gated draft-file Write/Edit when `AO_DRAFT_AUTHOR_FALLBACK_REASON` is
    non-empty — same escape pattern as `AO_DIRECT_EDIT_REASON`, separate env var so
    the override is explicit and auditable.
- **Review-artifact subtree unchanged.** Paths under `docs/issues_drafts/.review/**`
  must remain allowed without `AO_DRAFT_AUTHOR_FALLBACK_REASON` so architect T3 lens
  edits and review captures are not blocked. The implementation MUST include an
  **explicit allow rule** for `docs/issues_drafts/.review/**` (or equivalent
  nested-path match). Excluding nested paths from the draft-file gate alone is
  insufficient — without this rule, removing the old blanket `docs/issues_drafts/**`
  allow would fall through to deny.
- **Runtime scope.** This guard applies only to the architect's **Claude Code**
  session (PreToolUse `Edit` / `Write`). Cursor draft-author sessions run
  `cursor-agent` in isolated checkouts and do not execute these hooks — do not invent
  cross-runtime enforcement.
- **Publish hook out of scope.** `.claude/hooks/guard-direct-gh-publish.mjs` remains
  machine-local for this build; only the direct-edit guard is pack-owned here.

```contract-evidence
binding-id: orchestrator-pack:architect-edit-guard:draft-file-deny-without-override
binding-type: cli-behavior
binding: architect-session Write/Edit of docs/issues_drafts/<draft>.md denies unless AO_DRAFT_AUTHOR_FALLBACK_REASON is non-empty
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:architect-edit-guard:draft-file-allow-with-override-reason
binding-type: cli-behavior
binding: architect-session Write/Edit of docs/issues_drafts/<draft>.md allows when AO_DRAFT_AUTHOR_FALLBACK_REASON is set
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)

binding-id: orchestrator-pack:architect-edit-guard:review-subtree-unchanged
binding-type: cli-behavior
binding: architect-session Write/Edit under docs/issues_drafts/.review/ allows without AO_DRAFT_AUTHOR_FALLBACK_REASON
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)

binding-id: orchestrator-pack:architect-edit-guard:fail-open-malformed-input
binding-type: cli-behavior
binding: hook fail-opens on malformed stdin JSON and on paths that escape the project root
producer: orchestrator-pack
evidence: NEW(produced-by AC#5)
```

## Files in scope

- Tracked hook implementation and any small shared helper it needs (planner's choice
  under allowed roots).
- `scripts/**` — regression tests and any verify wiring the planner adds.
- `docs/migration_notes.md` — operator adoption steps for re-pointing machine-local
  Claude Code settings at the tracked hook source.
- `docs/**` — brief cross-reference to #579 relocation if the planner adds a runbook
  pointer; no requirement to edit relocation skill prose in this PR unless recon proves
  a drift.
- This spec file.

## Files out of scope

- Machine-local `.claude/settings.json` and gitignored `.claude/hooks/*.mjs` copies —
  operator adoption only.
- `guard-direct-gh-publish.mjs` pack-tracking (separate future build if needed).
- Draft-author Cursor session runner / isolation mechanics (#579 already shipped).
- `docs/issue_queue_index.md` sync, GitHub issue create/edit, publish flows.
- `agent-orchestrator.yaml` live file, `packages/core/**`, `vendor/**`, `.ao/**`.

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
```

**Denylist vs guard allowlist.** The denylist bounds **worker implementation PR scope**
(what tracked paths a worker may edit). The preserved guard allowlist above bounds
**architect-session Claude Code Write/Edit** at runtime and intentionally retains
today's live-hook exceptions for machine-local operator surfaces (`.ao/**`,
`agent-orchestrator.yaml`). Those paths stay denylisted for worker PRs and out of scope
for this build's tracked edits; the guard must not remove architect-session access that
exists today.

```allowed-roots
scripts/**
docs/**
tests/**
.claude/skills/**
```

## Acceptance criteria

1. **Draft-file deny without override reason.** A regression fixture simulating PreToolUse
   stdin for Write/Edit targeting `docs/issues_drafts/NN-probe-slug.md` with empty
   `AO_DRAFT_AUTHOR_FALLBACK_REASON` produces deny JSON (`permissionDecision: deny`),
   exit 0, and a reason that names the Cursor draft-author delegation path and
   `AO_DRAFT_AUTHOR_FALLBACK_REASON` as the override escape.

```positive-outcome
asserts: architect-session guard denies Write/Edit of a root-level docs/issues_drafts/*.md file when AO_DRAFT_AUTHOR_FALLBACK_REASON is unset, with exit 0 and a deny payload naming draft-author delegation
input: realistic
```

```producer-emission
producer: orchestrator-pack
datum: architect-edit-guard
expected: draft-file-deny-without-override
proof-command: implementation-specific focused guard stdin fixture for gated draft path
```

2. **Draft-file allow with override reason.** The same fixture with non-empty
   `AO_DRAFT_AUTHOR_FALLBACK_REASON` allows (no deny JSON / allow path per hook
   contract).

```producer-emission
producer: orchestrator-pack
datum: architect-edit-guard
expected: draft-file-allow-with-override-reason
proof-command: implementation-specific focused guard stdin fixture with AO_DRAFT_AUTHOR_FALLBACK_REASON set
```

3. **Review subtree unchanged.** Write/Edit under `docs/issues_drafts/.review/NN-slug/`
   allows without `AO_DRAFT_AUTHOR_FALLBACK_REASON`.

```producer-emission
producer: orchestrator-pack
datum: architect-edit-guard
expected: review-subtree-unchanged
proof-command: implementation-specific focused guard stdin fixture for .review nested path
```

4. **Existing allowlist preserved.** Fixtures prove `docs/architecture.md`,
   `docs/issue_queue_index.md`, `CLAUDE.md`, `.claude/skills/create-issue-draft/SKILL.md`,
   `.ao/` paths, and `agent-orchestrator.yaml` remain **guard-allowed** without either
   override env var — same as today's hook. This AC tests architect-session guard
   behavior only; it does not authorize worker PR edits to denylisted paths.

5. **Fail-open contract.** Fixtures for malformed stdin JSON, missing `file_path`, and
   a path resolving outside the project root each fail-open (allow), matching today's
   guard.

```producer-emission
producer: orchestrator-pack
datum: architect-edit-guard
expected: fail-open-malformed-input
proof-command: implementation-specific focused guard stdin fixtures for parse error and out-of-project path
```

6. **`AO_DIRECT_EDIT_REASON` preserved for non-draft paths.** A fixture targeting a
   non-allowlisted, non-draft path (e.g. `plugins/probe.mjs`) denies without
   `AO_DIRECT_EDIT_REASON` and allows with non-empty `AO_DIRECT_EDIT_REASON`.

7. **Tracked source is versioned.** `git ls-files` includes the shipped hook source;
   `git check-ignore` does **not** match the tracked hook path. Only
   `.claude/skills/**` remains the tracked `.claude` subtree per current gitignore.

8. **Operator adoption documented.** `docs/migration_notes.md` and the implementing PR
   body contain an `## Operator adoption` checklist: how to point machine-local
   `.claude/settings.json` PreToolUse `Edit`/`Write` matchers at the tracked hook
   source via symlink or delegating wrapper (copy only with mandatory refresh/hash
   check after pack pulls), plus the probe verification from Binding surface.

9. **Scenario matrix.** Fixtures cover reachable combinations across path class
   `{gated draft .md, .review nested, architecture.md, issue_queue_index.md, CLAUDE.md,
   .claude/skills, .ao, non-allowlisted implementation path}` × env
   `{no reason, AO_DRAFT_AUTHOR_FALLBACK_REASON set, AO_DIRECT_EDIT_REASON set}`.
   Non-applicable cells are documented; every reachable cell asserts allow or deny.

## Upgrade-safety check

- No AO core, `vendor/`, or `packages/core/` edits.
- Fail-open on malformed/out-of-project input is preserved — a broken hook must not brick
  every architect Edit/Write.
- Draft-author isolated sessions are unaffected (different runtime).
- Machine-local settings remain operator-owned; the PR does not assume it can edit them.

## Verification

- Focused guard regression fixtures for AC#1–AC#9 (planner picks runner: vitest, node
  test, or pwsh — consistent with repo conventions).
- `pwsh -NoProfile -File scripts/verify.ps1`
- `pwsh -NoProfile -File scripts/check-reusable.ps1`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/207-pack-owned-architect-edit-guard-draft-author-gate.md`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/207-pack-owned-architect-edit-guard-draft-author-gate.md`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command parked-root -DraftPath docs/issues_drafts/207-pack-owned-architect-edit-guard-draft-author-gate.md`
- `pwsh -NoProfile -File scripts/check-tier-gate-guard.ps1 -DraftPath docs/issues_drafts/207-pack-owned-architect-edit-guard-draft-author-gate.md`

## Decisions

### Prior art (reconnaissance)

Shipped #579 relocation prose and `check-draft-author-relocation-contract` validate
contract surfaces but do not block architect Write/Edit at runtime. The 2026-07-06
incident (architect began authoring draft 206 directly) was caught only by operator
observation because the live guard allowlists `docs/issues_drafts/**` unconditionally.
The guard itself is gitignored (`.gitignore:67` `.claude/*` with only
`.claude/skills/**` tracked), so rule drift has no CI or review home.

### Design analysis

Critical mechanics: stdin JSON parse, project-relative path resolution, ordered allow
rules (unchanged surfaces → draft-file gate → `AO_DIRECT_EDIT_REASON` escape), deny JSON
shape, fail-open edges. Industry pattern for IDE hooks: small pure decision function,
table-driven allow rules, env-recorded break-glass reasons, and regression tests on stdin
fixtures — not prompt-level string matching.

| Option | Cost | Risk | Sufficiency | Decision |
|---|---:|---:|---:|---|
| Patch only the gitignored local hook file | Very low | High: repeats the drift class; no CI | Insufficient | Rejected |
| Prompt/rule-only reminder in CLAUDE.md | Low | High: no mechanical enforcement (#579 incident) | Insufficient | Rejected |
| Pack-owned tracked hook + tests + operator adoption re-point | Medium-low | Low: adoption step may lag until operator runs checklist | Sufficient | **Chosen** |

Architecture sketch:

```
PreToolUse (Edit|Write) stdin
        │
        ▼
  parse + relativize path ──fail──▶ allow (fail-open)
        │
        ▼
  unchanged allowlist? (.claude, CLAUDE.md, architecture, index, .ao, yaml)
        │yes──▶ allow
        ▼
  docs/issues_drafts/.review/** ?
        │yes──▶ allow (explicit rule; no override env required)
        ▼
  docs/issues_drafts/<single-segment>.md ?
        │yes──▶ AO_DRAFT_AUTHOR_FALLBACK_REASON set? ──yes──▶ allow
        │              │no──▶ deny (names draft-author path)
        ▼
  AO_DIRECT_EDIT_REASON set? ──yes──▶ allow
        │no──▶ deny (existing message)
```

Scenario enumeration (fix the class):

| Path class | Override unset | `AO_DRAFT_AUTHOR_FALLBACK_REASON` | `AO_DIRECT_EDIT_REASON` only |
|---|---|---|---|
| Gated draft `NN-slug.md` | deny | allow | deny (draft gate first) |
| `.review/**` nested | allow | allow | allow |
| `docs/architecture.md` | allow | allow | allow |
| `plugins/foo.mjs` | deny | deny | allow |
