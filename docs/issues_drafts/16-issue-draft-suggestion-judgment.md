# Add improvement-suggestion channel + architect judgment to create-issue-draft Codex review

GitHub Issue: #44

## Prerequisite

- Issue #12 (file `docs/issues_drafts/12-architect-role-tighten.md`) — that
  issue introduced the "Codex review the draft (before sync, max 3 iterations)"
  section in `.claude/skills/create-issue-draft/SKILL.md`. This issue amends
  that same section, so #12 must be merged first.

Background: today the draft-review step asks Codex for a single channel of
output — must-fix findings tagged `P0`/`P1`/`P2`, else the bare `NO_FINDINGS`
token. There is no place for Codex to raise an *optional* improvement that the
architect might reasonably decline, and no documented step where the architect
decides whether such an improvement is worth applying or is over-specification.
In practice the architect wants Codex to *propose* betterments and wants to act
as the gate that accepts the worthwhile ones and rejects the excessive ones.

Framing (the "mirror"): a strict reviewer prompt — e.g. the
`openai/codex-plugin-cc` adversarial-review `finding_bar` — explicitly tells the
reviewer to *suppress* the lower-value class ("do not include style feedback,
naming feedback, low-value cleanup, or speculative concerns"). This issue does
the mirror image: instead of discarding that class, it routes it into a
**separate, optional, architect-gated** suggestion channel. Mandatory findings
stay the must-fix channel; suggestions are exactly the betterments a strict
reviewer would otherwise drop, surfaced for an explicit apply-or-skip decision.

## Goal

Amend the `create-issue-draft` skill's draft-review step so the Codex pass
produces two distinct kinds of output — mandatory findings the architect must
resolve, and optional improvement *suggestions* the architect may decline — and
so the skill documents an explicit architect judgment step that decides, per
suggestion, whether to apply it or skip it as redundant / scope-creeping /
over-specifying. Outstanding suggestions the architect chooses to skip must not
block the GitHub sync. Sync is blocked only while mandatory `P0`/`P1`/`P2`
findings remain unresolved; on reaching the hard 3-iteration cap the architect
may sync once remaining findings are recorded as open questions — exactly the
escape-valve behavior #12 already defines for findings.

## Binding surface

This issue commits the repository to, observable by reading
`.claude/skills/create-issue-draft/SKILL.md`:

1. The draft-review step instructs Codex to separate its output into two
   labelled channels: **mandatory findings** (the existing `P0`/`P1`/`P2`
   severities) and **optional improvement suggestions** (a distinct label).
   Each suggestion follows a fixed **template** so it can be weighed
   mechanically: *what it improves* → *concrete benefit* → *what exactly to
   change*. Each suggestion also carries a **confidence score** (a number from
   `0` to `1`) signalling how strongly the reviewer backs it, so a weak
   suggestion is visibly distinct from a strong one.
2. The skill defines an **architect judgment step**: for each suggestion the
   architect records an explicit apply-or-skip decision with a one-line
   rationale, with a stated default toward skipping when the suggestion
   re-introduces over-specification, scope creep, or duplicates an existing
   constraint.
3. The **sync gate** is restated so that skipped suggestions never block
   `gh issue create` / `gh issue edit`; sync is blocked only by unresolved
   mandatory findings. On reaching the 3-iteration cap, sync may proceed once
   remaining findings are recorded as open questions.
4. The change is confined to this skill's manual draft-review convention and
   does **not** alter the machine `NO_FINDINGS` contract used by the
   worker-PR reviewer wrapper (see Files out of scope).

## Files in scope

- `.claude/skills/create-issue-draft/SKILL.md` — amend the existing
  "Codex review the draft" section (and the iteration-discipline / sync-gate
  text under it) to add the suggestion channel and the architect judgment
  step. Additive/edit-in-place to that section; do not rewrite the unrelated
  draft-structure, planner-freedom-checklist, sync, decision-logging, or
  fold-back sections.
- `docs/issues_drafts/16-issue-draft-suggestion-judgment.md` — this spec.

## Files out of scope

- `prompts/codex_review_prompt.md` and `plugins/ao-codex-pr-reviewer/**` — the
  worker-PR reviewer wrapper and its shared prompt template. The machine
  `NO_FINDINGS` contract (Issue #6, file
  `docs/issues_drafts/06-codex-reviewer-scope-context.md`: trimmed stdout
  exactly equal to `NO_FINDINGS` ⇒ zero findings) is owned there and must not
  change. This issue's suggestion channel applies only to the architect's
  manual `codex review` of a draft, whose output is read by the architect, not
  parsed by the wrapper.
- The auto-fix-loop convergence contract (Issue #9, file
  `docs/issues_drafts/09-auto-fix-loop-convergence.md`).
- `CLAUDE.md` — the architect-role rules; no change required by this issue.
- All other `.claude/skills/**` skills.
- `prompts/agent_rules.md`, AO core, scope-guard implementation, CI workflows.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
agent-orchestrator.yaml.example
prompts/agent_rules.md
prompts/codex_review_prompt.md
plugins/ao-codex-pr-reviewer/**
scripts/pr-scope-check.ps1
```

```allowed-roots
.claude/skills/create-issue-draft/**
docs/issues_drafts/16-issue-draft-suggestion-judgment.md
```

## Acceptance criteria

- **Two output channels documented.** The "Codex review the draft" section
  instructs Codex to emit mandatory findings (`P0`/`P1`/`P2`) and optional
  improvement suggestions under a distinct, clearly-named label.
- **Suggestion template defined.** The section requires every suggestion to
  follow a fixed shape — *what it improves*, *concrete benefit*, *what exactly
  to change* — so the architect can judge it on facts, not impression.
- **Suggestion confidence defined.** The section requires each suggestion to
  carry a confidence score in the range `0`–`1`; the section states how the
  architect uses it (e.g. low-confidence suggestions default toward skip).
- **Reviewer prompt reflects both channels.** The PowerShell-embedded review
  prompt in the section asks for the two categories explicitly, and for each
  suggestion asks for the template fields (*what it improves*, *concrete
  benefit*, *what exactly to change*) plus the `0`–`1` confidence score; it
  remains a Windows-PowerShell-5.1-valid snippet (no `<` stdin redirect; draft
  appended to the prompt and passed as the single PROMPT argument, or
  `codex review --uncommitted`).
- **Architect judgment step exists.** The section documents that, for each
  suggestion, the architect records an explicit apply-or-skip decision plus a
  one-line rationale, and gives the default-to-skip criteria covering at least:
  re-introducing planner-prescription / over-specification, adding criteria or
  sections the goal does not require, and duplicating a constraint already
  enforced elsewhere (e.g. `denylist`/`allowed-roots`, `prompts/agent_rules.md`,
  `00-architecture-decisions.md`).
- **Apply criterion stated.** The section states when a suggestion *should* be
  applied (it closes a real gap — an ambiguity the planner would otherwise
  raise, a missing prerequisite, an unobservable acceptance criterion, or a
  cross-draft contract drift).
- **Sync gate unchanged for findings, relaxed for suggestions.** The section
  states that skipped suggestions never block sync, and that sync is blocked
  only while `P0`/`P1`/`P2` findings remain unresolved. On reaching the hard
  3-iteration cap, sync may proceed once remaining findings are recorded as open
  questions — the section gives this single, unambiguous rule.
- **Iteration cap preserved.** The hard 3-iteration cap from #12 remains; the
  amendment does not raise or remove it.
- **No machine-contract drift.** The amendment does not modify, and does not
  instruct anything that contradicts, the worker-PR reviewer `NO_FINDINGS`
  contract owned by Issue #6. The bare-`NO_FINDINGS` clean-review convention
  for the manual draft review may be redefined to mean "no findings and no
  suggestions," but only within this skill's manual-review text.
- **Other sections intact.** Draft structure, planner-freedom checklist, sync
  procedure, cross-issue / decision-logging, and fold-back sections are
  unchanged except where they reference the review step.

## Upgrade-safety check

- No edits to `packages/core/**`, `vendor/**`, AO runtime, the reviewer wrapper,
  or the scope-guard implementation.
- No new repository secrets, dependencies, runtime hooks, scheduled tasks, or
  `settings.json` edits — the change is pure markdown read by the Claude Code
  skill loader.
- `.claude/skills/**` is already on the `AGENTS.md` allowed-edit surface and the
  `scripts/check-reusable.ps1` allowlist; no policy-surface change is required.

## Verification

- **Static — two channels.** Reading
  `.claude/skills/create-issue-draft/SKILL.md` shows the review section naming
  both a mandatory-findings channel (`P0`/`P1`/`P2`) and a distinct optional
  improvement-suggestion channel, and shows the embedded prompt requesting both.
- **Static — judgment step.** Reading the section shows an architect
  apply-or-skip step with a one-line-rationale requirement and the default-skip
  criteria enumerated in the acceptance criteria above, plus the apply criterion.
- **Static — sync gate.** Reading the section shows that skipped suggestions do
  not block sync, that sync is blocked only by unresolved findings, and that on
  reaching the 3-iteration cap sync may proceed once remaining findings are
  recorded as open questions.
- **Static — boundary preserved.** Reading the section shows no edit to, and no
  instruction contradicting, the worker-PR `NO_FINDINGS` machine contract; the
  diff touches no file under `plugins/ao-codex-pr-reviewer/**` or
  `prompts/codex_review_prompt.md`.
- **Smoke — policy + tests.** `scripts/verify.ps1`, `scripts/check-reusable.ps1`,
  and `scripts/test-all.ps1` are clean on the PR head (regression-only: no
  runtime code changes).
- **Static — rules explicit.** The amended section explicitly states, in text:
  (a) that mandatory `P0`/`P1`/`P2` findings block sync and skipped suggestions
  do not; (b) the per-suggestion apply-or-skip decision plus one-line-rationale
  requirement; and (c) the suggestion template fields and the `0`–`1` confidence
  score. Each is locatable by reading the section — no sample run or subjective
  judgement required.
