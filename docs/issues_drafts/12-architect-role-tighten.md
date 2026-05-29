# Tighten architect role + ship architect-side meta skills

GitHub Issue: #37

## Prerequisite

None. This is a meta-update to Claude Code session instructions and adds
two new Claude Code skills under `.claude/skills/`. It does not depend on
any open issue and does not block any other issue.

Background:

- **`direct-fix-checklist`** — PR #35 attempted a direct architect edit to
  `agent-orchestrator.yaml.example` and was correctly blocked by the PR
  scope guard introduced in #5 / #6. The current `CLAUDE.md` "Don't write
  implementation code" line is too soft to prevent recurrence, and there
  is no documented checklist describing how to land an authorized direct
  fix through the existing guards (snapshot, PR body keyword, manual
  Codex review).
- **`study-external-source`** — the architect is regularly asked
  "изучи <URL>" / "research this repo" and currently re-derives every
  time how to evaluate fit, how to apply the 10-mode first-principles
  framework, how to involve Codex as a critical reviewer of the proposal,
  and where to put the proposal file. A skill captures the procedure and
  the iteration discipline (max 3 cycles).

Both concerns are architect-side meta and live under `.claude/skills/`,
which is why they ship in one PR.

## Goal

Strengthen the Claude Code architect role rules in `CLAUDE.md` so future
sessions default to spawning workers rather than editing tracked files
directly, **and** settle the architect-side skill surface covering the
recurring workflows that today are re-derived per session:

1. `direct-fix-checklist` (new) — the override path when the user
   explicitly authorizes a direct file edit / PR. Lists the snapshot, PR
   body closing-keyword, pre-push self-check, and manual Codex review
   steps required to land cleanly.
2. `study-external-source` (new) — the procedure when the user asks the
   architect to research an external source (GitHub repo, blog, paper)
   and decide what is worth adopting. Applies the 10-mode framework,
   produces a transient proposal file, runs Codex as a critical reviewer
   with a hard 3-iteration cap, and ends in a plain-language summary.
3. `create-issue-draft` (amend) — add a Codex-review step (hard
   3-iteration cap) before an issue draft is synced to GitHub, so drafts
   are critically reviewed for planner-freedom, observable criteria,
   command accuracy, and cross-draft consistency before a worker
   inherits them.

Net effect: no re-derivation of guard requirements or research procedure
per session, no accidental direct PRs that waste CI cycles, no cargo-cult
adoption of external ideas without critical review, and no draft synced
to GitHub without a critical Codex pass.

## Binding surface

This issue commits the repository to:

1. A stronger architect-role contract in `CLAUDE.md` that enumerates the
   categories of tracked files the architect must not edit without
   explicit user authorization, names the scope guard as the enforcement
   mechanism, and points at the new `direct-fix-checklist` skill as the
   override path.
2. A new Claude Code skill discoverable from `.claude/skills/` covering,
   end-to-end, what an authorized direct fix has to do to pass `Verify
   orchestrator-pack structure`, `PR scope guard`, and `Run pack contract
   tests`, plus how to run Codex review manually since the AO orchestrator
   only auto-runs review on worker-spawned PRs.
3. A second new Claude Code skill covering the research procedure for an
   external source: when to invoke, which subset of the 10-mode framework
   to run, the triage buckets (Apply / Adapt / Skip), the proposal file
   format, the Codex critical-reviewer prompt template, the 3-iteration
   cap, and the final-summary structure.

The contract is observable by reading `CLAUDE.md` and the two skill
files; no runtime check is introduced by this issue.

## Files in scope

- `CLAUDE.md` — tighten `## Don't` (and adjust `## Do` if needed) so the
  prohibition is explicit per category and references the new
  `direct-fix-checklist` skill. May reference `study-external-source` in
  a separate Do-bullet about research requests if that improves
  discoverability.
- `.claude/skills/<direct-fix-slug>/SKILL.md` (new) — the
  authorized-override checklist. Suggested slug: `direct-fix-checklist`;
  planner may rename if a better identifier exists, but `CLAUDE.md` must
  reference whatever slug is used.
- `.claude/skills/<study-slug>/SKILL.md` (new) — the external-source
  research procedure. Suggested slug: `study-external-source`; planner
  may rename.
- `.claude/skills/create-issue-draft/SKILL.md` (modify) — add a
  "Codex review the draft (before sync, max 3 iterations)" section so
  every new issue draft gets a critical Codex review before it is synced
  to GitHub. Do not rewrite the existing sections; this is an additive
  amendment.
- `AGENTS.md` — add `.claude/skills/**` to the allowed-edit policy
  surface so it matches the `check-reusable.ps1` allowlist. Today
  `AGENTS.md` does not mention `.claude/` at all, so a worker editing a
  skill would treat it as out of bounds even though CI permits it. This
  is the policy-alignment half of shipping tracked skill files.
- `docs/issues_drafts/12-architect-role-tighten.md` — this spec.

## Files out of scope

- `packages/core/**`, `vendor/**`.
- `prompts/agent_rules.md` — the worker-facing rules; this issue is
  architect-side only.
- `agent-orchestrator.yaml` (local, gitignored) and
  `agent-orchestrator.yaml.example` — review-loop rules belong to #28.
- Any AO upstream change (e.g. native trust prompts, snapshot generation
  outside an AO session).
- `scripts/pr-scope-check.*` — the guard implementation is owned by the
  scope-guard issues, not by this one.
- `docs/first_principles_10_critical_framework.md` — the
  `study-external-source` skill references it but must not modify it.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
.agent-orchestrator/**
agent-orchestrator.yaml
agent-orchestrator.yaml.example
prompts/agent_rules.md
scripts/pr-scope-check.ps1
scripts/pr-scope-check.test.ts
docs/first_principles_10_critical_framework.md
docs/first_principles_5_operational_framework.md
```

```allowed-roots
CLAUDE.md
AGENTS.md
.claude/skills/**
docs/issues_drafts/**
plugins/ao-codex-pr-reviewer/**
plugins/_shared/**
plugins/ao-scope-guard/**
plugins/ao-task-declaration/bin/**
plugins/ao-token-chain-ledger/**
scripts/verify.ps1
scripts/patch-codex-review4.ps1
scripts/pr-scope-check.ts
scripts/lint-self-architect.config.json
scripts/lib/**
```

## Acceptance criteria

### CLAUDE.md tightening

- **Categorical prohibition.** `CLAUDE.md` `## Don't` section explicitly
  names the file categories the architect must not edit without explicit
  user authorization. The list must cover at least: plugin/script code,
  tests, prompt files (except `CLAUDE.md` itself), `agent-orchestrator.yaml.example`,
  GitHub workflow yaml, `README.md`, and any other tracked file that an
  AO worker would normally produce.
- **Authorization mechanic.** `CLAUDE.md` states that the prohibition
  can be lifted only by explicit user authorization for a specific PR
  (not as a standing override), and instructs the architect to invoke
  the `direct-fix-checklist` skill when authorization is granted.
  Generic language like "use good judgement" does not satisfy this.
- **Reference to enforcement.** `CLAUDE.md` mentions
  `scripts/pr-scope-check.ps1` (or "the PR scope guard") as the
  enforcement mechanism so a future session understands why the rule
  exists at the contract level, not just at the policy level.
- **CLAUDE.md ↔ skill links are bidirectional.** Reading `CLAUDE.md`
  makes the existence and trigger of both skills discoverable. Reading
  either skill makes the role context discoverable (either via direct
  link or via clear language pointing back at `CLAUDE.md`).

### `direct-fix-checklist` skill

- **Discoverability.** The skill file lives under
  `.claude/skills/<slug>/SKILL.md` with valid frontmatter (`name`,
  `description`) so Claude Code skill loader picks it up. The
  `description` clearly states the trigger condition (explicit user
  authorization for a direct fix) and the skip condition (gitignored /
  `ao spawn`-able changes).
- **Content coverage.** The skill body documents, each in its own
  clearly-named section:
  - When to invoke and when to skip.
  - The CI checks the PR has to pass (by name as they appear in
    `.github/workflows/scope-guard.yml`).
  - The PR body closing-keyword requirement (`Closes #N` / `Fixes #N` /
    `Resolves #N`) and why `Refs #N` is insufficient.
  - The declaration snapshot requirement (path pattern
    `docs/declarations/<issue>.<iteration>.json`, ownership by
    `ao-task-declaration` plugin, prohibition on hand-editing).
  - At least one viable path to obtain a snapshot without going fully
    through the default worker flow (e.g. spawn a worker just for
    declaration, then take over).
  - The pre-push local self-check (`scripts/verify.ps1`,
    `scripts/test-all.ps1`).
  - The manual Codex review command for direct PRs and how to read its
    clean-vs-findings output. Reference
    `docs/issues_drafts/06-codex-reviewer-scope-context.md` (Issue #9 /
    NO_FINDINGS contract) for the durable form.
  - Decision points for pivoting back to the worker flow.
  - A `Don't` section that explicitly rejects the common workarounds that
    do not work (forged snapshot JSON, `scope-guard-degraded` label as a
    snapshot bypass, `--admin` merge).
- **Command accuracy (verified against source, not guessed).** Every
  concrete CLI command in the skill MUST match the real tool surface:
  - `ao-declare` flags MUST match
    `plugins/ao-task-declaration/bin/declare.ts` (`--issue`,
    `--declared-paths`, `--declared-globs`, `--iteration-id`,
    `--amend`/`--reason`/`--actor`, `--repo-root`) — not invented names
    like `--paths` / `--globs`.
  - Any `ao session kill` example MUST NOT assume the session id equals
    `op-<issue-number>`. AO assigns its own iteration id (e.g. issue #6
    → snapshot `6.op-4.json`, session `op-4`). The skill MUST instruct
    reading the real session id from `ao status` or the snapshot
    filename. (Both lessons from the Codex review of the initial skill
    draft, 2026-05-28.)

### `study-external-source` skill

- **Discoverability.** The skill file lives under
  `.claude/skills/<slug>/SKILL.md` with valid frontmatter. The
  `description` field names at least one explicit trigger phrase the user
  might use ("изучи <URL>", "research this repo", or equivalent) and the
  skip condition (description-only requests, links to our own repo).
- **Content coverage.** The skill body documents, each in its own
  clearly-named section:
  - When to invoke and when to skip.
  - The fetch step (read README + structure + key architecture doc; do
    not read every file).
  - The subset of the 10-mode framework to run for an external-source
    study, with the modes in order and a one-sentence purpose for each.
    The reference to `docs/first_principles_10_critical_framework.md` is
    explicit.
  - The triage buckets — Apply / Adapt / Skip — with the rule that if
    everything is Skip, the skill stops and reports that, without
    inventing a problem to justify adoption.
  - The proposal file location (transient, under `$env:TEMP` or
    equivalent — not committed to repo) and its required sections
    (Source, Existing pain, Decision per item, Concrete suggestions,
    Risks).
  - The Codex critical-reviewer invocation: review run **without**
    `--base`, with a custom prompt that asks Codex to critique the
    adoption decisions (not summarize the source). The prompt
    explicitly asks for `NO_FINDINGS` on clean reviews, P0/P1/P2
    severity tagging otherwise.
  - The iteration discipline — **hard cap at 3 cycles**, surface
    remaining concerns as open questions instead of silent further
    revisions.
  - The final-summary format: ≤ 400 words, in the user's language,
    structured as verdict / what we adopt / what we skip / open
    questions / next step.
  - A `Don't` section explicitly rejecting cargo-cult adoption,
    popularity-based decisions, invented pain points, skipping the
    Codex review, exceeding 3 iterations, committing the proposal file
    without going through `create-issue-draft`, and implementing the
    adoption directly.
- **Role boundary preserved.** The skill explicitly states that adoption
  work itself becomes a draft via `create-issue-draft` and a worker
  spawn, not an architect-direct edit.

### `create-issue-draft` skill amendment

- **Codex-review section added.** The existing
  `.claude/skills/create-issue-draft/SKILL.md` gains a section
  instructing the author to run a critical Codex review on the draft
  **before** syncing it to GitHub, with a **hard 3-iteration cap**. The
  section MUST:
  - give a Windows-PowerShell-valid invocation (no `<` stdin redirect;
    append the draft to the prompt and pass as the single PROMPT arg, or
    use `codex review --uncommitted`);
  - define the critical-reviewer focus: planner-freedom / observable
    acceptance criteria / command accuracy (real `ao` & `ao-declare`
    flags, PowerShell 5.1-valid snippets, session-id != issue-number) /
    denylist+allowed-roots correctness / cross-draft consistency;
  - require `NO_FINDINGS` for a clean draft and P0/P1/P2 tagging
    otherwise;
  - state the iteration discipline (revise valid findings, rebut wrong
    ones, stop at 3, surface remainder as open questions in the synced
    issue) and that sync happens only after convergence or cap.
- **Existing sections preserved.** The amendment is additive — the draft
  structure, planner-freedom checklist, sync procedure, decision logging,
  and fold-back sections remain intact.

### Policy-surface alignment

- **AGENTS.md allows `.claude/skills/**`.** `AGENTS.md` allowed-edit
  list MUST include `.claude/skills/**` so the worker-facing policy
  matches the `check-reusable.ps1` allowlist (which already permits
  `.claude/skills/*`). Without this, a worker editing a skill file would
  read AGENTS.md and conclude the path is out of bounds. The hard bans
  (`packages/core/**`, `vendor/**` except an explicitly requested
  upstream refresh) MUST be preserved unchanged.

### No worker-side or upstream changes

- This PR must not edit `prompts/agent_rules.md`, AO core, the scope-guard
  implementation, or the two first-principles framework files.

## Upgrade-safety check

- No edits to `packages/core/**`, `vendor/**`, AO runtime, or the scope
  guard implementation.
- No new repository secrets.
- No new dependencies in `package.json` / `package-lock.json`.
- The new skill files are allowlisted by `scripts/check-reusable.ps1`
  (`.claude/skills/*` is already an allowed path pattern); verify before
  pushing.
- `CLAUDE.md` is allowlisted at the root level.
- Neither skill introduces runtime hooks, scheduled tasks, or
  `settings.json` edits — they are pure markdown instructions read by
  the Claude Code skill loader.

## Verification

- **Static — CLAUDE.md prohibition.** Reading `CLAUDE.md` `## Don't`
  shows a single bullet (or contiguous bullets) that enumerate the
  prohibited file categories and condition the prohibition on "explicit
  user authorization" or equivalent unambiguous wording.
- **Static — CLAUDE.md skill pointers.** Reading `CLAUDE.md` shows
  explicit references to both new skill slugs, each with one short
  sentence describing when to invoke it.
- **Static — both skills' frontmatter.** Reading each new `SKILL.md`
  shows the required `name` and `description` frontmatter fields, with
  `description` mentioning both the trigger and the skip conditions.
- **Static — `direct-fix-checklist` content sections.** Reading the
  skill shows all the content topics enumerated in its acceptance
  criterion above, each under a recognizable heading.
- **Static — `study-external-source` content sections.** Reading the
  skill shows the framework-subset list, triage buckets, proposal file
  format, Codex prompt anatomy, 3-iteration cap, and final-summary
  format, each under a recognizable heading.
- **Smoke — repository policy.** `scripts/verify.ps1` and
  `scripts/check-reusable.ps1` clean on the PR head. All three changed
  files fit the existing allowlist.
- **Smoke — tests still green.** `scripts/test-all.ps1` passes; nothing
  in this PR alters runtime code, so this is a regression-only check.
- **Manual — operator readability.** An operator following only
  `CLAUDE.md` plus the two new skills can describe, without further
  consultation:
  - what to do when the user says "fix X yourself" (matches the
    `direct-fix-checklist` sections);
  - what to do when the user says "изучи <URL>" (matches the
    `study-external-source` sections).

