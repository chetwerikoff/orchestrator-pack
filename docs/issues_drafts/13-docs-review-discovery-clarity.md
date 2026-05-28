# Docs: positive canonical statement of local Codex review across discovery surfaces

GitHub Issue: #38

## Prerequisite

- Issue #28 (`docs/issues_drafts/11-orchestrator-autonomous-review-loop.md`) must be merged. #28 owns the review-loop spec and touches `prompts/agent_rules.md` (worker response contract section). Landing #13 after #28 keeps the two edits to `agent_rules.md` in distinct sections.
- Issue #37 (`docs/issues_drafts/12-architect-role-tighten.md`) must be merged. #37 owns the architect-role tightening in `CLAUDE.md` and the `direct-fix-checklist` skill. Landing #13 after #37 keeps the `CLAUDE.md` edits in distinct sections (architect-role vs review-wiring).
- Issue #36 (yaml.example mirror) should also be merged first. The `reviewer`-framing line in `agent-orchestrator.yaml.example` belongs to the yaml.example owner, not this issue.

## Goal

Make the existing **active local Codex review path** immediately discoverable to any agent or contributor reading the project's top-level files. Today several discovery surfaces lead with negative framing ("AO 0.9.x has no first-class `reviewer:` YAML role; wire review through external plugin/workflow"), which causes fresh agents — including Claude sessions, worker prompts, and human contributors — to conclude "this project does not have local review". Empirically the opposite is true: review-runs `op-rev-*` are visible in `ao review list orchestrator-pack` and on the AO dashboard right now. The fix is a reframing pass: positive statement first, config-detail (no YAML field) as a footnote. No code changes.

Additional accuracy fix: AO 0.9.2 **silently accepts** a `reviewer:` block in YAML (no schema validation error, no warning — empirically verified by loading a YAML with `reviewer: agent: codex` and observing `ao status` returning clean). The current docs framing as "unsupported" reads as "AO will error" when reality is "AO ignores it". The reframing must correct this nuance.

## Binding surface

This issue commits the repository to:

1. A canonical positive paragraph describing the local Codex review wiring (`ao review run/send/list/execute` as first-class CLI commands, `orchestratorRules` as the integration point in `agent-orchestrator.yaml`, `ao review list <project>` as the discovery surface for runs).
2. That paragraph or a clearly-equivalent variant appearing near the top of every project-level discovery surface listed in Files in scope.
3. Where existing text uses the words "unsupported" / "not a first-class role" / "wire through external", that text is reframed so the positive fact (review is active) leads and the nuance (no `reviewer:` YAML field, AO silently ignores it if added) follows.
4. Cross-references between the discovery surfaces so a reader entering from any of them can find the others.

No new prohibitions, no new acceptance gates, no implementation changes.

## Files in scope

- `README.md` — add or hoist a short "Review setup" section near the top.
- `CLAUDE.md` — add a "Review wiring" pointer in a section that does not overlap with #37's architect-role / `direct-fix-checklist` content.
- `prompts/agent_rules.md` — reframe the existing review-model paragraph near the top. Must remain distinct from #28's worker-response-contract section so the two issues' edits do not collide.
- `docs/architecture.md` — reorder the existing review paragraphs so the positive "AO local Codex review is the primary path" statement leads.
- `docs/github_issues_cursor_codex_setup.md` — same reorder; primary path first, config detail second.
- `plugins/ao-codex-pr-reviewer/README.md` — reframe the "Do not add unsupported `reviewer:` keys" sentence to "AO 0.9.x silently ignores a `reviewer:` YAML block; wire reviewer via `orchestratorRules` + the `ao review` CLI".
- `docs/issues_drafts/13-docs-review-discovery-clarity.md` — this spec.

## Files out of scope

- `agent-orchestrator.yaml.example` — owned by #36 and #28.
- `packages/core/**`, `vendor/**`, AO runtime.
- `scripts/`, `plugins/` source code (only `plugins/ao-codex-pr-reviewer/README.md` is touched).
- Tests, CI workflows.
- Any change to the actual review wiring (review-loop rules belong to #28, reviewer wrapper belongs to #9).

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
.agent-orchestrator/**
agent-orchestrator.yaml
agent-orchestrator.yaml.example
scripts/**
plugins/ao-codex-pr-reviewer/bin/**
plugins/ao-codex-pr-reviewer/lib/**
plugins/ao-codex-pr-reviewer/tests/**
prompts/codex_review_prompt.md
.github/workflows/**
.claude/skills/**
```

```allowed-roots
README.md
CLAUDE.md
prompts/agent_rules.md
docs/**
plugins/ao-codex-pr-reviewer/README.md
```

## Acceptance criteria

- **Positive statement present in each in-scope discovery surface.** Reading `README.md`, `CLAUDE.md`, `prompts/agent_rules.md`, `docs/architecture.md`, `docs/github_issues_cursor_codex_setup.md`, and `plugins/ao-codex-pr-reviewer/README.md`, a reader who never opens another file MUST be able to state: (a) local Codex review IS active in this project, (b) the orchestrator drives it via `ao review run/send/list`, (c) wiring lives in the `orchestratorRules` block of `agent-orchestrator.yaml`, (d) current runs are visible via `ao review list <project>` and the AO dashboard.
- **Discovery position.** In `README.md`, `prompts/agent_rules.md`, and `CLAUDE.md`, the positive statement appears within the first scrolling page of the file (top section, not buried under Notes or Appendix).
- **No negative-first framing.** Any sentence that starts with "AO does not have a `reviewer:` role" / "AO does not expose…" / "Desired review model is…" / "wire through external" MUST be moved after the positive fact, OR rewritten so it is no longer the lead.
- **Accurate nuance.** Wherever the docs reference what happens if `reviewer:` is added to YAML, the wording MUST reflect empirical AO 0.9.2 behavior: the field is silently ignored (parsed without error, but no code path reads it).
- **Cross-references.** Each of `README.md`, `CLAUDE.md`, `prompts/agent_rules.md`, `docs/architecture.md` contains a pointer to at least one of the other three.
- **No content drift on review-wiring contract.** Where wiring details appear (CLI commands, `orchestratorRules` location), all in-scope files agree on the same names.
- **No new prohibitions.**

## Verification

- **Static — positive lead.** Each in-scope file: the first paragraph that mentions review reads positively.
- **Static — first-page placement.** In `README.md`, `prompts/agent_rules.md`, and `CLAUDE.md`, the review statement is within the first ~50 lines.
- **Static — accurate nuance.** Every occurrence of `reviewer:` / `reviewer field` / `reviewer role` in the in-scope files reads consistent with "AO 0.9.x silently ignores this; review is wired through `orchestratorRules` + `ao review` CLI."
- **Static — cross-references.** At least one valid pointer between `README.md`, `CLAUDE.md`, `prompts/agent_rules.md`, and `docs/architecture.md` is present in each of the four.
- **Smoke — pack verification.** `scripts/verify.ps1` and `scripts/check-reusable.ps1` clean on the PR head.
