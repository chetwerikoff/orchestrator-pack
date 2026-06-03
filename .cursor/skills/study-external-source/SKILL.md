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

## Codex critical reviewer

Run **without** `--base` — the artifact is the proposal, not a git diff.

**Command discipline:** use `codex review` or
`scripts/review-architect-artifact.ps1 -Kind adoption-proposal` only.
Never `codex exec` / `codex exec review` (PR worker path).

**Preferred (Linux / WSL2 / pwsh 7+):**

```powershell
pwsh -NoProfile -File scripts/review-architect-artifact.ps1 `
  -ArtifactPath $env:TEMP/orchestrator-pack-proposal-<slug>.md `
  -Kind adoption-proposal
```

On Linux when `$env:TEMP` is unset, use `/tmp/orchestrator-pack-proposal-<slug>.md`.

**Manual equivalent (pwsh — append proposal to prompt; no stdin `<` redirect):**

```powershell
$proposal = Get-Content -Raw "$env:TEMP/orchestrator-pack-proposal-<slug>.md"
$prompt = @"
You are a critical reviewer for orchestrator-pack adoption proposals.
Critique the ADOPTION DECISIONS below — do not summarize the external source.
Check: cargo-cult risk, planner-freedom if we spec work, upgrade-safety (no core patch),
command accuracy, and whether pain is real.
Do NOT explore the repository unless the proposal is ambiguous.

Severity: tag valid issues P0/P1/P2.
If no concrete issues remain after your review, respond with exactly:
NO_FINDINGS
(on its own line, no other prose).

--- PROPOSAL ---
$proposal
"@
codex review $prompt
```

Do not pipe stdout through `tail` or `head` — wait for the full response.

Contract: `NO_FINDINGS` = clean; otherwise address P0/P1/P2 findings. See
`docs/issues_drafts/06-codex-reviewer-scope-context.md`.

## Iteration discipline

- **Hard cap: 5 cycles** (proposal → Codex → revise or rebut → repeat).
- Revise the proposal for valid findings; rebut wrong ones in the proposal.
- After cycle 5, stop revising — list remaining concerns as **open questions**.

## Final summary (deliver to user)

≤ 400 words, in the user's language, with this structure:

1. **Verdict** — adopt anything or not.
2. **What we adopt** — Apply/Adapt items only.
3. **What we skip** — and why.
4. **Open questions** — unresolved after 5 Codex cycles.
5. **Next step** — e.g. invoke `create-issue-draft` for an Adapt item, or none.

## Don't

- Cargo-cult adopt because a repo is popular or starred.
- Invent pain points to avoid an all-Skip outcome.
- Skip Codex review on the proposal.
- Run more than **5** Codex iterations silently.
- Commit the proposal file (use `create-issue-draft` for durable specs).
- Implement adoption directly — open a draft and spawn a worker.
