# RCA skill: separate facts from hypotheses; say so when the cause is not found

GitHub Issue: #294

## Prerequisite

None. Independent of other open drafts; touches only the architect-side
investigation procedure and its skill loader.

## Goal

Make the root-cause investigation procedure require the investigator to (a)
explicitly separate verified facts from hypotheses in every memo, and (b) state
plainly when the evidence does not establish a root cause instead of fabricating
a confident chain. Today the procedure rejects evidence-free causes in its
"Don't" list but never tells the investigator to *label* which claims are facts
vs guesses, nor that "cause not established" is an acceptable, required outcome.
The result: memos can read as confident even when the cause is a guess.

```behavior-kind
record-only
```

This is a documentation/prompt-content change. Every success path is the prose
the procedure produces; there is no runtime side effect.

## Binding surface

The canonical procedure `prompts/investigate_root_cause.md` and its skill loader
`.claude/skills/investigate-root-cause/SKILL.md` must, after this change,
commit the repository to the following behavior for architect-side RCA memos:

- **Facts vs hypotheses are labeled, always.** Every claim is marked as either a
  verified fact (observed in a citable artifact) or a hypothesis (inferred /
  unconfirmed, with what would confirm or refute it). A hypothesis must not be
  written in the grammar of a fact. When multiple causes are possible, they are
  presented as ranked hypotheses with the evidence for and against each, not one
  silently asserted cause.
- **"Cause not established" is a first-class outcome.** When the bounded evidence
  does not establish a root cause, the memo says so plainly (in the plain-terms
  and causes sections), lists the ranked surviving hypotheses, and gives the
  specific missing evidence that would settle it as actionable next-steps —
  rather than manufacturing a 5-Whys chain.
- The report-template section that carries the cause(s) for a follow-up agent,
  and the procedure's "Don't" list, reflect both rules so they are enforced at
  authoring time, not just described.
- The skill loader surfaces both rules as condensed bullets (consistent with the
  existing loader-bullet convention) so they are visible at skill-invocation time
  without reading the full prompt.

No bilingual wording, exact section numbering, or phrasing is mandated — the
implementer matches the existing RU/EN bilingual style and section structure of
the file.

## Files in scope

- `prompts/investigate_root_cause.md`
- `.claude/skills/investigate-root-cause/SKILL.md`

## Files out of scope

- Any other prompt, skill, or doc.
- `prompts/agent_rules.md`, `CLAUDE.md`, `AGENTS.md`, `.cursor/**`.
- Worker/planner/reviewer contracts and any code, tests, or fixtures.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

```allowed-roots
prompts/**
.claude/skills/investigate-root-cause/**
```

## Acceptance criteria

- `prompts/investigate_root_cause.md` contains a clearly delimited rule that every
  claim in the memo is labeled as a fact (with an artifact reference) or a
  hypothesis (with what would confirm/refute it), and that a hypothesis must not
  be stated as a fact.
- The same file requires, when several causes are possible, presenting them as
  ranked hypotheses with evidence for and against each.
- The same file contains a clearly delimited rule that, when the evidence does
  not establish a root cause, the memo states this plainly, lists ranked
  hypotheses, and records the specific missing evidence as next-step items —
  explicitly forbidding a fabricated chain.
- The report-template section that conveys the cause(s) to a follow-up agent
  references the fact/hypothesis labeling and the not-established fallback.
- The procedure's "Don't" list forbids both presenting a hypothesis as a fact and
  manufacturing a cause when the evidence is insufficient.
- `.claude/skills/investigate-root-cause/SKILL.md` lists both rules as loader
  bullets alongside the existing ones.
- Existing RU/EN bilingual style and section ordering of the file are preserved
  (no section removed or renumbered beyond the additions).

## Upgrade-safety check

- No edits to AO core, `vendor/**`, `packages/core/**`, or `.ao/**`.
- No new repository secrets, env vars, or YAML.
- No operator adoption required — documentation-only change; no process,
  restart, or config step is needed once it lands.

## Verification

- Read `prompts/investigate_root_cause.md` and confirm each acceptance bullet
  above is present (facts-vs-hypotheses rule, ranked hypotheses, cause-not-found
  rule, report-template wiring, two new "Don't" entries).
- Read `.claude/skills/investigate-root-cause/SKILL.md` and confirm the two new
  loader bullets are present.
- Confirm `git diff` touches only the two files in **Files in scope**.
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/93-rca-facts-vs-hypotheses.md`
  and the `parked-root` variant both pass.
