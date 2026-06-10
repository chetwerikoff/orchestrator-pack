---
name: study-external-source
description: Use when the user asks to study an external source — e.g. "изучи <URL>", "research this repo", "evaluate this project for adoption". Skip for description-only questions, links to our own orchestrator-pack repo, or tasks that only need a short answer without adoption triage.
---

# study-external-source

Research an external GitHub repo, blog, paper, or URL and decide what (if
anything) is worth adopting in `orchestrator-pack`. Architect role:
`CLAUDE.md` — adoption work lands via **`create-issue-draft`** + worker spawn,
not architect-direct edits.

## When to invoke

- User points at an **external** URL/repo and wants fit/adoption analysis.
- User uses phrases like "изучи …", "research this repo", "should we adopt X".

## When to skip

- Pure explanation with no adoption decision.
- Link is this repository or a known internal draft (use issue queue instead).
- User already issued a tracked GitHub Issue — work the issue, don't duplicate.

## Research step — delegate the reading to `coworker` (mandatory)

The bulk reading of an external source is exactly the I/O this pack delegates:
**you do not read the source yourself — `coworker` does.** Keep the judgment,
conclusions, and adoption decisions on the main reasoning model; push the
fetch-and-summarise legwork to the cheap model. See the **Coworker CLI
delegation** policy in [`prompts/agent_rules.md`](../../../prompts/agent_rules.md)
(single source of truth) for the profile and code-gate rules.

Procedure:

1. **Availability check first.** `command -v coworker`. If it is missing,
   unavailable, or rate-limited, fall back to reading in-session and **say so**
   in the final report. Otherwise the research below MUST go through coworker.
2. **Bounded, thorough read via coworker.** Ask `coworker ask --profile code`
   to read and summarise the source's entry points — README, top-level
   structure, the primary architecture/overview doc, license, and
   maintenance/activity signals. Request a *detailed* extraction, not a
   one-paragraph blurb: capabilities, design choices, dependencies,
   stated trade-offs, and anything that overlaps our existing pack contracts.
   Source code requires the `--allow-code` gate — pass it only when the question
   genuinely needs code, and only after scrubbing secrets.
3. **Iterate as needed.** Fan out more `coworker ask` calls for the specific
   sub-areas the adoption question hinges on. Do not pull the whole tree; chase
   only what the decision needs.
4. **You synthesise.** coworker returns raw reading; the comparison, the fit
   analysis, and every Apply/Adapt/Skip call stay with you. Verify coworker's
   summary against the source before you rely on it.

State in the final report whether the research went through coworker or fell
back in-session, and why.

## 10-mode framework subset

Run these modes **in order** from
`docs/first_principles_10_critical_framework.md` (full doc not required inline)
over the material coworker brought back:

| Mode | One-line purpose |
|------|------------------|
| **1. Real Problem** | Confirm we have a real pain, not hype or a proxy task. |
| **2. Assumption Destruction** | List what we assume about the source; mark physics vs convention. |
| **5. Analogical vs First Principles** | Detect cargo-cult copying; rebuild fit for *our* constraints. |
| **3. Physics Test** | Separate impossible from hard/expensive/unfamiliar in our stack. |
| **4. Constraint Removal** | Classify hard vs soft constraints (AO-no-core-patch, Windows CI, etc.). |
| **9. Outsider Perspective** | Ask naive questions the source's authors may have stopped asking. |

Do not run modes 6–8 or 10 unless the user escalates to a full architectural decision.

## Triage buckets

For each candidate idea, assign exactly one:

- **Apply** — fits with minimal change; cite concrete pack touchpoints.
- **Adapt** — valuable idea but needs contract/wrapper redesign first.
- **Skip** — no fit, duplicate, or cost/risk outweighs benefit.

If **every** item is **Skip**, stop the skill: report that plainly. Do not invent pain to justify adoption.

## Proposal file (transient)

Write under `$env:TEMP` (or OS temp) — **never commit** to the repo.
Example path: `$env:TEMP/orchestrator-pack-proposal-<slug>.md`
(Linux/WSL: `/tmp/...` if TEMP unset).

The proposal must be **detailed** — it is both the record you reason from and
the exact payload Codex will attack, so it carries the full case for *and*
against each decision. Required sections:

1. **Source** — URL, version/date, one-line what it is; note whether the read
   went through coworker.
2. **Existing pain** — our problem statements only (no invented gaps).
3. **Where it works better / where it works worse** — an explicit, honest map
   of the source's (or proposal's) strengths and weaknesses: which contexts it
   beats our current approach in, and which contexts it loses or adds cost/risk.
   This is the comparison Codex will probe, so do not soften either side.
4. **What to apply — and how** — for every **Apply** / **Adapt** item, the
   concrete change: which pack files/contracts it touches and the mechanism by
   which we'd land it (draft + worker), at the *what-must-be-true* level
   (leave the *how* to the planner — see Planner freedom in `CLAUDE.md`).
5. **What NOT to apply — and why** — for every **Skip** item, the explicit
   reason it is rejected (duplicate, no fit, cost/risk, breaks upgrade safety,
   over-reach). Rejections are first-class content, not omissions — Codex must
   be able to argue against each one.
6. **Risks** — upgrade safety, scope creep, operator burden.

## Adversarial Codex review — challenge BOTH sides

Use the **adversarial-review** engine — the same cold-skeptic pass that
[`adversarial-draft-review`](../adversarial-draft-review/SKILL.md) runs — **not**
a plain `codex review`. It argues to break confidence in the adoption decisions
and returns a structured JSON findings contract you **evaluate, never obey**.
The `/codex:adversarial-review` slash command is `disable-model-invocation:
true`, so call its engine directly.

Send Codex **everything from sections 3–5 of the proposal** — the
strengths/weaknesses map, the apply-and-how items, **and** the skip-and-why
items. Codex must challenge the **rejected** decisions as hard as the accepted
ones: "argue we are wrong to skip X", "argue this Apply is actually a bad fit".
A one-sided attack that only questions adoptions is incomplete.

The proposal lives under `$TEMP` (outside the repo), so the engine's git-diff
scope has nothing to chew on — **embed the proposal in the focus text** and tell
Codex to attack the PROPOSAL, disregarding any unrelated working-tree changes.
Resolve the newest plugin version, run from repo root:

```bash
SCRIPT=$(ls -d ~/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs | sort -V | tail -1)
PROPOSAL=$(cat "${TMPDIR:-/tmp}/orchestrator-pack-proposal-<slug>.md")
node "$SCRIPT" adversarial-review --wait --json --scope working-tree \
  "Challenge the ADOPTION PROPOSAL below — do NOT summarize the external source, and ignore any unrelated working-tree changes. Attack BOTH directions: (a) for every Apply/Adapt, argue the pain is unreal, the fit is cargo-cult, it breaks our constraints (AO-no-core-patch, Windows CI, planner freedom), or the upgrade/command is unsafe; (b) for every Skip, argue we are WRONG to reject it and are leaving real value on the table. Also probe the where-it-works-better/worse map for bias, hidden coupling, and overlap with existing pack contracts.

--- PROPOSAL ---
$PROPOSAL"
```

`--json` returns the structured contract: `verdict` (`approve` |
`needs-attention`), `summary`, `findings[]` (`severity`, `title`, `body`,
`confidence`, `recommendation`), `next_steps[]`. Do not pipe stdout through
`tail` or `head` — wait for the full response.

Skip if the Codex CLI / companion runtime is unavailable — fall back to no
adversarial pass and say so in the final report.

## Evaluate findings — don't obey

Codex argues to break confidence in **both** the adoptions and the rejections;
treat each finding as a challenge to weigh, **never** as an instruction to
apply. Do not flip a decision just because Codex pushed on it — decide what is
genuinely applicable and what is excessive. Decide per finding:

| Verdict | When | Action |
|---------|------|--------|
| **Accept** | Exposes a real gap — invented pain, cargo-cult adoption, broken upgrade safety (core patch), wrong/unsafe command, missed coupling/overlap, **or a Skip that genuinely throws away value**. | Revise the proposal (flip Apply→Adapt/Skip, or Skip→Adapt; fix rationale, the works-better/worse map, or risks). |
| **Partial** | Valid kernel, but the remedy **over-specifies** *how* we'd implement (file names, signatures, libraries, internal layout the planner should own). | Fix the proposal **minimally** — keep it about *what must be true*; leave the how to the later `create-issue-draft`. |
| **Reject** | Speculative, stylistic, guards an out-of-scope failure mode, or pushes us to over-spec / narrow planner freedom / adopt for adoption's sake. | Leave the proposal; record why. |

Anchor on CLAUDE.md: planner freedom is non-negotiable; the cost rule is
"cheapest sufficient executor with acceptable risk." A finding that pushes the
proposal toward over-specification, or toward adopting something just because
Codex challenged the Skip, is itself the bug — reject or trim it. Log every
accept/reject — one line per finding: what Codex argued, your verdict, why — in
the proposal's decision trail. See
`docs/issues_drafts/06-codex-reviewer-scope-context.md`.

## Iteration discipline

- **Hard cap: 10 adversarial passes total**, and *you* carry the
  cross-iteration memory — each re-run of the review step is a fresh **cold**
  Codex thread with no memory of prior passes (by design: a cold skeptic
  re-attacks without anchoring or sycophantic drift).
- Re-run only after you accepted/partially-accepted at least one finding and
  revised the proposal. Append a settled-decisions block to the re-run focus
  text so the cold skeptic does not relitigate:

  ```
  Already decided in earlier passes — do NOT re-raise (settled):
  - <finding>: rejected — <one-line reason>
  - <finding>: resolved — proposal now <what changed>
  Attack the current proposal afresh for NEW weaknesses only.
  ```

- **Stop** when any holds: `verdict` is `approve`; every remaining finding is
  rejected (nothing left to apply); or 10 passes done — record any still-open
  findings as **open questions**.
- Never resume a single Codex thread across iterations (it softens into
  agreement and defeats the gate); keep cold restarts + the settled ledger.

## Final report (deliver to user)

Plain, non-technical language — **so a grandmother could follow it** — in the
user's language. No jargon dumps; explain any unavoidable term in one clause.
Structure:

1. **Final decision** — in one or two sentences: do we adopt anything, and the
   gist of why.
2. **What works better / worse** — the honest strengths-and-weaknesses summary
   from the proposal, in everyday words.
3. **What we take, and how** — the Apply/Adapt items and roughly what changes.
4. **What we leave out, and why** — the Skip items and the plain reason.
5. **What Codex challenged, and how we answered** — list **every** finding Codex
   raised (on both adoptions and rejections) with your one-line verdict
   (agreed / partly / disagreed) and the reason. Do not hide rejected findings.
6. **Open questions** — anything still unresolved after the loop.
7. **Next step** — e.g. invoke `create-issue-draft` for an Adapt item, or none.

Note in the report whether the research went through coworker or fell back
in-session.

## Don't

- Read the external source yourself when coworker is available — delegate it.
- Cargo-cult adopt because a repo is popular or starred.
- Invent pain points to avoid an all-Skip outcome.
- Send Codex only the adoptions — it must attack the rejections too.
- **Auto-apply** any finding — the Accept/Partial/Reject evaluation is mandatory;
  flip a decision only when *you* judge it genuinely right, not because Codex said so.
- Skip the adversarial Codex pass on the proposal (unless the runtime is down).
- Run more than **10** adversarial passes, or re-run with no accepted change.
- Resume a single Codex thread across iterations to save tokens.
- Commit the proposal file (use `create-issue-draft` for durable specs).
- Implement adoption directly — open a draft and spawn a worker.
