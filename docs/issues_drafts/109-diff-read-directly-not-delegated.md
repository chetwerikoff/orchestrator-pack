# Diffs are read directly, never delegated to coworker

GitHub Issue: #337

## Prerequisite

Builds on / strengthens already-shipped work — cite, do not re-implement:

- `docs/issues_drafts/52-coworker-cli-delegation-policy.md` (GitHub #148) —
  shipped the **reviewer carve-out**: the PR-review *judgment/findings* are never
  delegated to the cheap provider ("does not license cheap review"). It left the
  ask-condition "diff **or** log material >200 lines" intact, so the diff *bulk
  read* could still be summarized by coworker while judgment stayed local.
- `docs/issues_drafts/86-read-delegation-reviewer-carveout-per-session.md`
  (GitHub #264, CLOSED) — reviewer-path carve-out in the **audit** keys on a
  per-work-unit review signal, not ambient `PACK_REVIEWER`. Audit side only; not
  re-touched here.
- `docs/issues_drafts/83-coworker-delegation-threshold-and-enforcement.md`
  (GitHub #255, CLOSED) — audit thresholds; left "diff/log 200" unchanged. This
  draft changes that one ask-condition for diffs only.

## Goal

A diff is review evidence, not bulk I/O to offload: line-level correctness
(conditions, off-by-one, missing checks, types) lives in the exact diff text and a
cheap-model summary loses it. Extend the #148 reviewer carve-out so the **diff
read itself** — not only the review judgment — stays on the reasoning model, for
**every** agent. The read-delegation policy must instruct agents to read diffs
directly at any size and keep coworker delegation for logs and other non-diff
bulk. Logs and the general line floor are unchanged.

```behavior-kind
record-only
```

This draft changes worker-facing policy text only — a documentation edit with no
runtime side effect and no observable action on any success path. Enforcement on
the operator's local machine is a gitignored hook outside the repo (see Files out
of scope) and is already aligned.

## Binding surface

The repository's worker-facing delegation rules commit to:

- **Diffs are never delegated.** Diff material — `git diff` / `git show` output and
  `.diff` / `.patch` files — is read directly by the reading agent, at any size,
  and is never handed to `coworker` for summarization. This holds for every agent,
  not only the reviewer.
- **The read-delegation diff condition is removed.** The delegation rule that made
  "diff **or** log material > N lines" mandatory no longer applies to diffs. Logs
  and other non-diff bulk keep their existing delegation floor.
- **The reviewer prompt directs direct diff reading.** The Codex review contract
  tells the reviewer to inspect the PR diff directly and does not present a
  coworker diff-summarization recipe as the path for large diffs.
- **Consistency across the policy surfaces.** Every worker-facing surface that
  currently states the diff-delegation recipe or the "diff or log" delegation rule
  is updated in the same change, so no surface still tells an agent to hand a diff
  to coworker.

The provider-input fence, the log/general delegation floors, and the #148
reviewer-judgment carve-out are unchanged.

## Files in scope

- `prompts/codex_review_prompt.md` — the reviewer's diff-handling guidance.
- `prompts/agent_rules.md` — the read-delegation ask-conditions and any PR-diff
  recipe.
- `docs/issues_drafts/00-architecture-decisions.md` — record the strengthened
  carve-out as a decision entry (or the architecture decision log that owns it).

## Files out of scope

- `docs/issues_drafts/52-...`, `83-...`, `86-...` and their issues — referenced,
  not rewritten.
- Any plugin, script, test, or runtime code (`plugins/**`, `scripts/**`).
- The operator-local read-delegation hook (gitignored, outside the repo) — already
  aligned by the operator; not a repo file.
- Log and general-floor delegation rules — unchanged.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
plugins/**
scripts/**
.github/workflows/**
```

```allowed-roots
prompts/**
docs/issues_drafts/**
```

## Acceptance criteria

- The Codex review contract (`prompts/codex_review_prompt.md`) tells the reviewer
  to read the PR diff directly and contains **no** instruction to hand a diff to
  `coworker` for summarization, at any size.
- `prompts/agent_rules.md` read-delegation ask-conditions no longer make a diff a
  mandatory-delegation case: the former "diff or log >N lines" delegation rule
  applies to **logs/non-diff bulk only**, and the text states diffs are read
  directly.
- No worker-facing policy surface in the repo still presents a "write the diff to a
  file then `coworker ask`" recipe as the way to handle a large PR diff.
- The change explicitly states the scope is **all agents**, not the reviewer alone,
  and references #148 as the carve-out it strengthens.
- The #148 reviewer-judgment prohibition and the log/general delegation floors
  remain stated and unchanged.
- A reader of the updated rules can determine, for a 1000-line diff, that the
  correct action is "read it directly" with no ambiguity.

## Upgrade-safety check

- No AO core, `vendor/**`, or `packages/core/**` edits.
- No `agent-orchestrator.yaml` schema or unsupported YAML changes.
- No new repository secrets.
- Documentation/policy-text change only; no executable code paths altered in-repo.

## Verification

- A **repository-wide** search over worker-facing policy surfaces — at least
  `prompts/**`, `AGENTS.md`, `.cursor/rules/**`, and `docs/**` — finds no remaining
  diff→coworker delegation recipe and no "diff or log" ask-condition that still
  includes diffs (only logs / non-diff bulk remain).
- Reading the updated `prompts/agent_rules.md` read-delegation section, the diff
  case is explicitly "read directly," and the log/general floors are intact.
- The decision entry in `00-architecture-decisions.md` (or the architecture log)
  cites #148 and states the strengthened carve-out applies to all agents.
- The repository's standard pre-land verification gates pass on the change:
  `pwsh -NoProfile -File scripts/verify.ps1` and
  `pwsh -NoProfile -File scripts/check-reusable.ps1` (PowerShell 7+ on Linux/WSL2).
