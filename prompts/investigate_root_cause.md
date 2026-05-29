# Root cause investigation (architect-side)

Canonical procedure for interactive architect-side agents (Cursor CLI, Codex CLI,
Claude Code). AO worker roles (planner, PR reviewer) are out of scope — they
follow issue bodies and JSON contracts instead.

## Triggers

Run this procedure when the user's message matches any of these (case-insensitive,
substring or clear paraphrase):

**Russian:** «разобраться с причиной», «в чём причина», «что это», «разберись»,
«почему упал», «что сломалось», «отладь», «что случилось», «почему не работает».

**English / slang:** «root cause», «why did», «figure out why», «investigate the
cause», «wtf».

## Skip

Do **not** run when:

- The ask is pure implementation with no analysis (build/fix/add X only).
- The ask is external adoption or fit research — use **`study-external-source`**
  (`.claude/skills/study-external-source/`, `.cursor/skills/` if present) instead.
- A single tracked GitHub Issue already fully answers the question — work that
  issue instead of duplicating investigation.

## Auto-invoke

If the user's message matches a **Trigger** above, **start this procedure
immediately** — do not wait for the user to name a skill, slug, or file path.
Discovery via `AGENTS.md`, skill wrappers, or `CLAUDE.md` is best-effort; when in
doubt and triggers match, follow this file.

---

## Workflow

### Scope the question

- Restate what failed, recurs, or is unclear; bound time and repo (this pack vs
  upstream AO vs target repo).
- Note what evidence the user already gave vs what you must find.

### Gather evidence (bounded)

Collect only what answers the scoped question:

- User context, session history, and any artifacts they named.
- `ao review list` and `code-reviews/findings/` when the topic involves review,
  CI, or merge loops.
- PR diffs, review-run JSON, planner logs, and relevant `gh` issue/PR comments.
- Targeted `git log` / `git blame` on touched paths — not full-repo archaeology.

Stop gathering when additional search is unlikely to change the root-cause
conclusion.

### 5 Whys (failures and recurrence)

For failures, flaky behavior, or recurring problems, apply **5 Whys** per
[`docs/first_principles_5_operational_framework.md`](../docs/first_principles_5_operational_framework.md)
§ **5 Whys Debug Mode** (mini-checklist: Problem → Why #1–#5 → Root cause →
Corrective action → Prevention).

Follow the architect-side loop in [`CLAUDE.md`](../CLAUDE.md) § **Failure response**
(reproduce from artifacts → 5 Whys → fix at spec/contract/rule level → capture
lesson) — that section is the single source for the sequence; do not invent a
parallel loop here.

Stop at **spec / contract / rule** level (issue body, draft, `prompts/agent_rules.md`,
declaration, CI guard), not at symptom patches on merged code.

### Resolve queue status (before planned/shipped claims)

Before listing any task as **planned** or **shipped** in the report:

1. Consult [`docs/issue_queue_index.md`](../docs/issue_queue_index.md) to map each
   cited `docs/issues_drafts/NN-<slug>.md` path to its GitHub Issue number (never
   treat the draft filename prefix as the GitHub `#`).
2. For each GitHub number, read live state:
   `gh issue view <N> --repo chetwerikoff/orchestrator-pack --json state,title`.
3. Do **not** infer open, closed, planned, or shipped from a draft file existing
   or from draft presence in the repo alone.

### Search existing mitigations

- Open and closed GitHub Issues (via registry-resolved numbers and `gh issue view`);
  `docs/issues_drafts/`; [`docs/issue_queue_index.md`](../docs/issue_queue_index.md);
  `docs/architecture.md` and `docs/issues_drafts/00-architecture-decisions.md`.
- Read-only scan of `prompts/`, `AGENTS.md`, `agent-orchestrator.yaml.example`,
  and relevant plugins/scripts **as evidence** — do not edit them during
  investigation unless the user authorized **`direct-fix-checklist`** for a
  named direct PR.

Record what was tried, whether it worked, partially worked, or failed / was wrong.

### Search planned work

- Open GitHub Issues (state from `gh issue view`, numbers from the registry) and
  drafts that already plan changes on this topic.
- Summarize what each would change if merged. Label shipped vs planned from GitHub
  state, not from draft filename or draft-file existence alone.

### Role boundary

- Durable fixes: **`create-issue-draft`** + worker spawn (`ao spawn`), or amend
  an existing draft/issue — not hand-patches to merged implementation.
- Direct edits to tracked implementation files only when the user explicitly
  authorized **`direct-fix-checklist`** for one named PR.

---

## Report template

Deliver to the user in **their language**, **fixed section order**, **≤ 600 words**
unless they asked for depth. Put long tables or raw dumps in `$env:TEMP` (or OS
temp) and link paths in the memo — do not paste huge tables in chat.

1. **Причины** — evidence-backed root cause(s); include 5 Whys summary when the
   ask was about a failure.
2. **Что уже сделано** — mitigations in the repo; label each: worked / partial /
   failed or wrong.
3. **Что будет сделано** — open GitHub Issues and `docs/issues_drafts/` that
   already plan work; what each would change if merged.
4. **Что лучше всего ещё сделать** — ranked gaps not covered by (2)–(3); durable
   fixes are specs/rules/issues, not patches to merged code.

(English sessions may use equivalent headings: **Causes**, **Already done**,
**Planned**, **Best next steps** — same order and content.)

---

## Optional Codex self-check (architect-only)

Not a merge gate. After drafting the memo, you may run Codex CLI on the memo text
(max **3** iterations). Use PowerShell string composition — **no** stdin `<`
redirect.

```powershell
$memo = Get-Content -Raw $env:TEMP\orchestrator-pack-rca-memo.md
$prompt = @"
You are a critical reviewer for a root-cause investigation memo.
Challenge unsupported claims, missing queue/architecture search, and patches
proposed as durable fixes. Tag valid issues P0/P1/P2.
If no concrete issues remain, respond with exactly:
NO_FINDINGS
(on its own line, no other prose).

--- MEMO ---
$memo
"@
codex review $prompt
```

Revise the memo for valid findings; stop after cycle 3 and list open questions.

---

## Don't

- Invent causes without evidence from the bounded gather step.
- List work as planned or shipped from draft-file existence or draft filename
  prefix alone — use the registry and `gh issue view` first.
- Skip queue, draft, or architecture search when the topic is in-repo behavior.
- Duplicate **`study-external-source`** for external adoption asks.
- Patch merged implementation code as the durable fix — fix spec, contract, or
  rule and spawn a worker.
- Commit transient memos or proposal files to the repo.
