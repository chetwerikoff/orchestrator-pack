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

## Fetch step (bounded)

1. Open the URL (README, top-level structure, primary architecture/overview doc).
2. Skim entry points only — **do not** read every file or clone the full tree unless required.
3. Note license, maintenance signals, and overlap with existing pack contracts.

## 10-mode framework subset

Run these modes **in order** from
`docs/first_principles_10_critical_framework.md` (full doc not required inline):

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

Required sections:

1. **Source** — URL, version/date, one-line what it is.
2. **Existing pain** — our problem statements only (no invented gaps).
3. **Decision per item** — Apply / Adapt / Skip with rationale.
4. **Concrete suggestions** — files/contracts affected if not Skip.
5. **Risks** — upgrade safety, scope creep, operator burden.

Example path: `$env:TEMP/orchestrator-pack-proposal-<slug>.md` (Linux/WSL: `/tmp/...` if TEMP unset)

## Adversarial Codex review

Use the **adversarial-review** engine — the same cold-skeptic pass that
[`adversarial-draft-review`](../adversarial-draft-review/SKILL.md) runs — **not**
a plain `codex review`. It argues to break confidence in the adoption decisions
and returns a structured JSON findings contract you **evaluate, never obey**.
The `/codex:adversarial-review` slash command is `disable-model-invocation:
true`, so call its engine directly.

The proposal lives under `$TEMP` (outside the repo), so the engine's git-diff
scope has nothing to chew on — **embed the proposal in the focus text** and tell
Codex to attack the PROPOSAL, disregarding any unrelated working-tree changes.
Resolve the newest plugin version, run from repo root:

```bash
SCRIPT=$(ls -d ~/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs | sort -V | tail -1)
PROPOSAL=$(cat "${TMPDIR:-/tmp}/orchestrator-pack-proposal-<slug>.md")
node "$SCRIPT" adversarial-review --wait --json --scope working-tree \
  "Challenge the ADOPTION PROPOSAL below — do NOT summarize the external source, and ignore any unrelated working-tree changes. Question whether the pain is real, cargo-cult risk, whether each Apply/Adapt truly fits our constraints (AO-no-core-patch, Windows CI, planner freedom), upgrade safety, command accuracy, hidden coupling, and overlap with existing pack contracts.

--- PROPOSAL ---
$PROPOSAL"
```

`--json` returns the structured contract: `verdict` (`approve` |
`needs-attention`), `summary`, `findings[]` (`severity`, `title`, `body`,
`confidence`, `recommendation`), `next_steps[]`. Do not pipe stdout through
`tail` or `head` — wait for the full response.

Skip if the Codex CLI / companion runtime is unavailable — fall back to no
adversarial pass and say so in the final summary.

## Evaluate findings — don't obey

Codex argues to break confidence; treat each finding as a challenge to weigh,
not an instruction to apply. Decide per finding:

| Verdict | When | Action |
|---------|------|--------|
| **Accept** | Exposes a real gap — invented pain, cargo-cult adoption, broken upgrade safety (core patch), wrong/unsafe command, missed coupling or overlap with an existing pack contract. | Revise the proposal (flip Apply→Adapt/Skip, fix rationale or risks). |
| **Partial** | Valid kernel, but the remedy **over-specifies** *how* we'd implement (file names, signatures, libraries, internal layout the planner should own). | Fix the proposal **minimally** — keep it about *what must be true*; leave the how to the later `create-issue-draft`. |
| **Reject** | Speculative, stylistic, guards an out-of-scope failure mode, or pushes us to over-spec / narrow planner freedom. | Leave the proposal; record why. |

Anchor on CLAUDE.md: planner freedom is non-negotiable; the cost rule is
"cheapest sufficient executor with acceptable risk." A finding that pushes the
proposal toward over-specification is itself the bug — reject or trim it. Log
every accept/reject — one line per finding: what Codex argued, your verdict,
why — in the proposal's decision trail. See
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

## Final summary (deliver to user)

≤ 400 words, in the user's language, with this structure:

1. **Verdict** — adopt anything or not.
2. **What we adopt** — Apply/Adapt items only.
3. **What we skip** — and why.
4. **Open questions** — unresolved after the adversarial loop.
5. **Next step** — e.g. invoke `create-issue-draft` for an Adapt item, or none.

## Don't

- Cargo-cult adopt because a repo is popular or starred.
- Invent pain points to avoid an all-Skip outcome.
- **Auto-apply** any finding — the Accept/Partial/Reject evaluation is mandatory.
- Skip the adversarial Codex pass on the proposal (unless the runtime is down).
- Run more than **10** adversarial passes, or re-run with no accepted change.
- Resume a single Codex thread across iterations to save tokens.
- Commit the proposal file (use `create-issue-draft` for durable specs).
- Implement adoption directly — open a draft and spawn a worker.
