# Risk-tier the draft-review depth in create-issue-draft (stricter pass for high-blast-radius drafts)

GitHub Issue: #52

## Prerequisite

- Draft `docs/issues_drafts/16-issue-draft-suggestion-judgment.md` (GitHub Issue
  #44) amends the **same** "Codex review the draft" section of
  `.claude/skills/create-issue-draft/SKILL.md`. To avoid a same-file conflict
  this issue must land **after** #44 is merged, and must build on (not revert)
  the two-channel / architect-judgment text #44 introduces.

Background: today every draft authored through `create-issue-draft` gets the
**same** single capped Codex review regardless of blast radius — a docs typo and
a database-migration spec are reviewed identically. The
`pimenov/codex-pro-review-bundle-skill` repo (MIT) frames work in **risk tiers**
and only escalates review for high-impact plans. We adopt that *taxonomy as a
trigger* — not its manual ChatGPT-Pro / bundle-builder / Python workflow. The
escalation stays **local**: a stricter, more adversarial Codex pass on the draft
for high-risk specs, within the existing review machinery.

## Goal

Make draft-review depth proportional to blast radius. Add a risk classification
step to `create-issue-draft` so that **high-risk** drafts (changes to auth,
data/schema/migrations, production/deploy/routing, external writes, or
payments/permissions) require a **stricter adversarial review pass** before
sync, while **low-risk** drafts keep the current single pass. The escalation
reuses the existing local `codex review` flow and the existing 3-iteration cap;
it introduces no external tool, no manual export, and no new machine contract.

## Binding surface

Observable by reading `.claude/skills/create-issue-draft/SKILL.md`:

1. A **risk-classification step** before the draft-review step: the architect
   tags each draft `low-risk` or `high-risk`, where `high-risk` is defined by an
   enumerated blast-radius list (at least: auth/permissions; data, schema, or
   migration; production, deploy, routing, or DNS; external writes to
   trackers/CMS/cloud/email/git hosting; payments/billing/credentials).
2. An **escalation rule**: high-risk drafts require at least one **stricter,
   adversarial** Codex pass — one that challenges the approach, assumptions, and
   failure modes, not only mechanical lint — completed before
   `gh issue create` / `gh issue edit`. Low-risk drafts keep the current single
   pass.
3. The escalation operates **within** the existing review section (from #44):
   it reuses the same `codex review` invocation pattern, the same
   mandatory-findings vs optional-suggestions channels, and the **same hard
   3-iteration cap** — it does not raise the cap or add iterations beyond it.
4. The risk tag is **recorded in the draft** (a one-line risk classification the
   reader can see), so the chosen depth is auditable.
5. No change to any machine contract: the worker-PR reviewer, the `NO_FINDINGS`
   token, and the structured-finding format are untouched (different surface).

## Files in scope

- `.claude/skills/create-issue-draft/SKILL.md` — add the risk-classification
  step and the high-risk escalation rule into the existing review/iteration
  text; do not rewrite unrelated sections (draft structure, planner-freedom
  checklist, sync, decision-logging, fold-back).
- `docs/issues_drafts/20-draft-risk-tier-review.md` — this spec.

## Files out of scope

- `prompts/codex_review_prompt.md` and `plugins/ao-codex-pr-reviewer/**` — the
  **worker-PR** diff reviewer and its machine `NO_FINDINGS` contract (owned by
  Issue #9). This issue is about reviewing the **draft/spec**, a different
  surface; the finding-bar work for the worker-PR reviewer is Issue #51.
- Other `.claude/skills/**` skills.
- `prompts/agent_rules.md`, `CLAUDE.md`, AO core, scripts, CI workflows.
- The external repo's `build_bundle.py`, privacy gate, ChatGPT-Pro export, and
  decision-log template — deliberately not adopted (manual/Python workflow we
  do not run; secret patterns already covered by `scripts/check-reusable.ps1`).

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
agent-orchestrator.yaml.example
prompts/agent_rules.md
prompts/codex_review_prompt.md
plugins/**
scripts/**
.github/workflows/**
CLAUDE.md
.claude/skills/study-external-source/**
.claude/skills/direct-fix-checklist/**
```

```allowed-roots
.claude/skills/create-issue-draft/**
docs/issues_drafts/20-draft-risk-tier-review.md
```

## Acceptance criteria

- **Risk-classification step present.** `.claude/skills/create-issue-draft/SKILL.md`
  documents a step where the architect classifies each draft `low-risk` or
  `high-risk`, and enumerates the high-risk blast-radius categories listed in
  Binding surface item 1.
- **Escalation rule present.** The skill states that high-risk drafts require at
  least one stricter, adversarial Codex pass (challenging approach/assumptions/
  failure modes) before sync, and that low-risk drafts keep the single pass.
- **Within existing cap.** The skill text keeps the hard 3-iteration cap from
  #44/#12 and does not raise it or add iterations; the stricter pass counts
  against that cap.
- **Risk tag recorded.** The skill instructs that the chosen risk tier is
  written into the draft (a visible one-line classification), so an operator can
  see which depth was applied.
- **Channels preserved.** The escalation reuses the mandatory-findings /
  optional-suggestions channels and the architect-judgment step from #44; it
  does not replace or contradict them.
- **No machine-contract drift.** The diff touches only
  `.claude/skills/create-issue-draft/SKILL.md` and this draft; nothing under
  `plugins/ao-codex-pr-reviewer/**` or `prompts/codex_review_prompt.md` changes,
  and the `NO_FINDINGS` machine contract is not mentioned as changed.
- **Adversarial pass is steered, not a new tool.** The stricter pass is
  described as a framing of the existing `codex review` (no `--base`) on the
  draft; the skill does not introduce a new script, binary, or external export.

## Upgrade-safety check

- No edits to `packages/core/**`, `vendor/**`, AO runtime, the worker-PR
  reviewer, or any plugin.
- No new repository secrets, dependencies, runtime hooks, or YAML changes.
- Markdown-only change to one skill file consumed by the Claude Code skill
  loader (and readable by Cursor/Codex per existing discovery).
- The hard 3-iteration cap and the `NO_FINDINGS` machine contract are unchanged.

## Verification

- **Static — classification + escalation.** Reading
  `.claude/skills/create-issue-draft/SKILL.md` shows the risk-classification
  step, the enumerated high-risk categories, the high-risk stricter-pass rule,
  and the low-risk single-pass rule.
- **Static — cap preserved.** Grep shows the hard 3-iteration cap language is
  still present and not increased.
- **Static — risk tag recorded.** The skill instructs writing the risk tier into
  the draft.
- **Static — scope of diff.** `git diff --name-only` on the PR head lists only
  `.claude/skills/create-issue-draft/SKILL.md` and
  `docs/issues_drafts/20-draft-risk-tier-review.md`.
- **Smoke.** `scripts/verify.ps1`, `scripts/check-reusable.ps1`, and
  `scripts/test-all.ps1` are clean on PR head (markdown-only; no runtime code).
- **Manual — depth proportionality.** An architect following only the amended
  section can, for a sample migration/auth draft, state that it is `high-risk`
  and requires the stricter pass, and for a docs-typo draft state that it is
  `low-risk` and keeps the single pass.
