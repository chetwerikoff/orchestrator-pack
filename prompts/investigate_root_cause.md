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

### Recurrence diagnostic (recurrence-diagnostic — first step when the bug is "already fixed")

When the user reports a **recurring** bug or says a prior fix "should have"
resolved it, make this the **first** workflow step — before new code patches or
new acceptance criteria:

1. **Identify the prior fix's own acceptance check** — the criterion or fixture
   that was green when the last fix merged (issue body AC, regression fixture,
   documented verification command).
2. **When safe and representative**, **re-run that check against current live
   state** (same command/fixture shape; note any environment skew).
3. **Evidence rule (not an exclusive verdict):** `pass + reproduce` — if the prior
   check **passes** while the bug **still reproduces**, record that as **strong
   evidence the spec or fixture is the defect** — descend into the spec/fixture (field shape,
   production-representative input, wrong binding) before re-patching
   implementation.
4. **Record instead of concluding** when the prior check is unidentifiable,
   unsafe to run live, non-deterministic, or affected by version skew /
   partial rollout / races / flaky dependencies — a genuine runtime defect
   remains reachable.

**Worked example (#212→#218):** review did not auto-start after a worker reported
`ready_for_review` on green CI. The prior acceptance check was green on a fixture
whose `ao report` record included `headRefOid`, while live AO 0.9.x reports
carry **no** head SHA. Pass + reproduce ⇒ the binding/spec pointed at a field the
real tool never emits — fix the predicate contract, not another defer log.

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

#### 5-Whys stop condition (reject intermediate artifacts)

These are **not** acceptable **terminal root cause** statements — continue the chain until
you reach a data/contract/field-level fact:

- "A component returned or logged value **X**."
- "The decision/defer record is imprecise / missing a subreason."

**Rejecting example:** "Reconcile deferred because `ready_for_review` did not
match the head" → **continue:** AO 0.9.x `ao report` stores no head SHA, so a
predicate that requires `report.headRefOid` is **unsatisfiable** — the defect is
the binding assumption about external tool output shape, not the defer log text.

Acceptable terminal causes name a **false assumption about real data** (a field
the external tool never emits, a fixture that invents a shape) or a missing
contract/guard.

### Resolve queue status (before §3 / §4 claims)

Before listing anything under **§3 Already done** or **§4 Planned**:

1. Consult [`docs/issue_queue_index.md`](../docs/issue_queue_index.md) to map each
   cited `docs/issues_drafts/NN-<slug>.md` path to its GitHub Issue number (never
   treat the draft filename prefix as the GitHub `#`).
2. For each candidate issue, read live metadata (at minimum):
   `gh issue view <N> --repo chetwerikoff/orchestrator-pack --json state,title,body,closedAt`.
3. Do **not** infer open, closed, planned, or shipped from a draft file existing
   or from draft presence in the repo alone.

### Verify §4 (planned) — ship check (mandatory)

**§4 is where false positives hurt most.** Treat every candidate issue/draft as
*guilty until proven still outstanding*. Do not copy issue titles or draft summaries
into §4 without completing the ship check below.

**Build §3 before §4.** List mitigations and shipped work in §3 first; only then
consider open issues for §4.

For **each** issue/draft you might put in §4:

| Step | Check | If true → |
|------|--------|-----------|
| A | `gh issue view` → `state` is **closed** | **Exclude from §4.** If the outcome matters to the investigation, one line in **§3** (worked / partial / failed) with close reason or merged PR ref. |
| B | Merged PR linked to the issue (`gh pr list --repo chetwerikoff/orchestrator-pack --state merged --search "closes #N"` or issue timeline / comments) | **Exclude from §4** unless the PR clearly did *not* implement the scoped acceptance criteria. |
| C | Acceptance criteria from the issue body (or linked draft) already satisfied on **`main`** — files/paths exist, behavior present, `git log -n 5 -- <paths>` shows merge after issue open | **Exclude from §4**; record in **§3** as shipped (note **open issue, work on main** if `state` is still open). |
| D | `docs/declarations/*.json` or merged worker PR scope matches the issue’s declared outcome for this topic | **Exclude from §4**; **§3** instead. |
| E | Issue is **open** but only tracks spec/ops follow-up while implementation is already on `main` | **§3** for what shipped; **§4** only if you state the *remaining* gap in one line (not the whole original issue scope). |
| F | Issue is **open**, no merged PR, and criteria are **not** on `main` | **May list in §4** — status only: `#N` open, one sentence on what would change when done. |

When in doubt, **spot-check `main`** (read files, run a narrow grep, or `git log`
on paths named in the issue) rather than trusting the open issue or an old draft.

**§4 may be empty.** Write explicitly that no open queue items remain for this
topic (e.g. «Нет открытых задач в очереди по этой теме»). Prefer an empty §4
over listing work that is already shipped.

**Dedupe §3 ↔ §4:** the same outcome must not appear in both sections. If it is
on `main` or in a merged PR, it belongs in **§3**, not **§4**, regardless of
issue state.

### Search existing mitigations

- Open and closed GitHub Issues (via registry-resolved numbers and `gh issue view`);
  `docs/issues_drafts/`; [`docs/issue_queue_index.md`](../docs/issue_queue_index.md);
  `docs/architecture.md` and `docs/issues_drafts/00-architecture-decisions.md`.
- Read-only scan of `prompts/`, `AGENTS.md`, `agent-orchestrator.yaml.example`,
  and relevant plugins/scripts **as evidence** — do not edit them during
  investigation unless the user authorized **`direct-fix-checklist`** for a
  named direct PR.

Record what was tried, whether it worked, partially worked, or failed / was wrong.

### Search planned work (for §4 only)

- Find *candidates* via registry + topic search in open issues and
  `docs/issues_drafts/`.
- Run **Verify §4 (planned) — ship check** on every candidate before writing §4.
- Include in §4 **only** survivors: open issues whose scoped work is **not** already
  on `main`. One line each: `#N` + what remains outstanding (not the full issue
  essay).
- Shipped or closed items discovered here belong in **§3**, not §4.

### Role boundary

- Durable fixes: **`create-issue-draft`** + worker spawn (`ao spawn`), or amend
  an existing draft/issue — not hand-patches to merged implementation.
- Direct edits to tracked implementation files only when the user explicitly
  authorized **`direct-fix-checklist`** for one named PR.

---

## Report template

Deliver to the user in **their language**, **fixed section order**, **≤ 900 words**
unless they asked for depth or the **design-analysis block** applies (see below —
that block may exceed the cap; long comparison tables and option matrices still
go to OS temp and are linked, not pasted in chat). Put long tables or raw dumps
in `$env:TEMP` (or OS temp) and link paths in the memo — do not paste huge
tables in chat.

**Always include sections 1–6 in every report.** Do not stop after technical
causes or a single “best next step” paragraph. The user should not need a
follow-up ask for a plain-language summary, immediate steps, or prevention —
those are mandatory parts of this template. The design-analysis block is
**conditional** — not a seventh always-on section; include it only when the
applies condition below holds.

**Every recommended action** (including optional improvements, follow-up
drafts, and trade-offs) must appear as a numbered step in **§5** (now) or **§6**
(prevention/stability). There is **no** separate “best further steps” section.

### Section rules

| # | Heading (RU) | Heading (EN) | Content |
|---|----------------|--------------|---------|
| 1 | **Простыми словами** | **In plain terms** | 2–4 short paragraphs: what broke or misbehaved, what actually caused it (no jargon, or jargon explained in parentheses), and what it means for the user right now. No file paths unless the user needs to open one. |
| 2 | **Причины** | **Causes** | Evidence-backed root cause(s) for **another agent** or a follow-up task: facts, artifact refs (`gh` #, PR, log path), 5 Whys chain when the ask was about a failure. Structured bullets; precise enough to implement from. |
| 3 | **Что уже сделано** | **Already done** | Mitigations in the repo; label each: worked / partial / failed or wrong. |
| 4 | **Что будет сделано** | **Planned** | **Only after ship check:** open GitHub Issues whose acceptance criteria are **not** already on `main`. One line per survivor: `#N` + what **remains** outstanding. **Status only** — no action steps. Empty §4 with an explicit “none” line is valid. Never list closed issues, merged PRs, or work already in **§3**. Do not repeat steps from §5–§6. |
| 5 | **Что сделать сейчас** | **What to do now** | **Numbered steps** (1., 2., …): everything that should happen **soon** — fix, unblock, verify, operator steps (restart, env, local YAML), and **optional** near-term improvements that are not durable prevention. Skip items already fully covered by §4 unless you add a net-new step. One concrete action per step; say who/what executes (you, architect, `ao spawn`, operator). |
| 6 | **Чтобы не повторялось** / **Чтобы работало стабильно** | **So it does not recur** / **So it stays stable** | **Numbered steps** (1., 2., …): everything **durable** — spec/draft/issue, `prompts/agent_rules.md`, CI guard, config contract, follow-up drafts, ranked gaps not covered by §3 and §4; not one-off patches to merged code. Skip items already fully covered by §4 unless you add a net-new step. Pick the heading that matches the ask (recurrence vs steady-state correctness); use both headings only if both apply. |

Sections **5** and **6** must be actionable checklists, not prose summaries. If a step
belongs in a worker PR, say so (`ao spawn` / open draft) instead of implying a
direct architect patch unless **`direct-fix-checklist`** was authorized.

### Conditional design-analysis block (build-class durable fixes)

When the durable recommendation — the prevention content in **§6** (or a numbered
step there that names the long-term fix) — is to **build or redesign** a
non-trivial component, contract, or service (work that would become a
`create-issue-draft` + worker build), the report must include a **design-analysis
block** in addition to §1–§6. Placement is the implementer's choice: a clearly
labeled subsection under **§6**, a linked annex, or an extension of the
prevention steps — but it must be visibly conditional, not folded into §1–§6 as
if always required.

**Applies when** the durable fix is a non-trivial build (new component / contract /
service that would become its own task draft and worker build).

**Skips when** the durable fix is an operator/runtime step, a config or YAML
change, a one-line spec or rule edit, or another small fix — forcing a
three-option architecture analysis onto those is noise. The reader must be able
to decide applies-vs-skips from these conditions without guessing.

When the block **applies**, include **all** of the following (prescribe *what*
the recommendation must contain — not file names, function signatures, import
paths, or library choices):

1. **Critical mechanics for *this* problem** — the patterns, data structures,
   integrations, and boundary / edge conditions that decide whether the design
   holds.
2. **Industry / world best practices** — how this *class* of problem is solved in
   the field; what the established approach is and why.
3. **Services / components architecture sketch** — how the proposed pieces fit
   together (responsibilities, data flow, boundaries). ASCII diagrams are fine.
4. **≥ 3 implementation options, each with an explicit trade-off** — not three
   restatements of one approach. Judge each on **cost, risk, and sufficiency**
   (tests + Codex review as the safety net) per the repo **cost rule** in
   [`CLAUDE.md`](../CLAUDE.md) and
   [`docs/first_principles_5_operational_framework.md`](../docs/first_principles_5_operational_framework.md)
   — land on the **cheapest sufficient executor with acceptable risk**, not
   "which is best." Name the recommended option and why the others lost.
5. **Full-class scenario enumeration** — **only when** the root cause sits on a
   **decision / state-machine / event-ordering / concurrency / idempotency** path
   (including re-execution after an ambiguous failure): enumerate the decision's
   input dimensions × their values, name the **sibling cells** that share the
   root cause or are at risk, and the expected outcome per equivalence class, so
   the build targets the **class, not the one reproduced case**. A single-axis
   build that is not element-5-eligible still needs elements 1–4.

**Recurrence + class-not-case (element 5).** When the investigation is a
recurrence (**recurrence-diagnostic** — the prior fix should have covered it)
**and** the durable fix is a build-class, element-5-eligible cause (the design
block already applies), element 5 is **mandatory**, not optional: recurrence is
evidence the prior fix closed one cell, so the recommendation must name the whole
class. A recurring **config / one-line / operator** fix still **skips** the
design block entirely — element 5 is **not** forced there; **recurrence-diagnostic**
governs those without a scenario matrix.

**Build-draft handoff (recommendation only).** When the recommendation is a
build and element 5 applies, state that the resulting `create-issue-draft`
**should** carry the enumerated scenario matrix as exhaustive acceptance (each
cell a fixture; closed sibling issues cross-checked for no-regression).
**Enforcement** that the build-draft actually preserves the matrix is the
`create-issue-draft` scenario-completeness gate and `check-draft-discipline.ps1`
companion — this RCA rule **recommends** the handoff; it does not bind or verify
that downstream workflow.

**Length and temp files.** The design block may exceed the ≤ 900-word memo cap.
Long option matrices and comparison tables go to `$env:TEMP` (or OS temp) per the
existing convention; link the path in the memo. Keep §1–§6 themselves lean.

---

## Optional Codex self-check (architect-only)

Not a merge gate. After drafting the memo, you may run Codex CLI on the memo text
(max **3** iterations).

**Command discipline:** `codex review` or
`scripts/review-architect-artifact.ps1 -Kind rca-memo` only — never `codex exec`.
Do not pipe stdout through `tail` or `head`.

**Preferred (Linux / WSL2 / pwsh 7+):**

```powershell
pwsh -NoProfile -File scripts/review-architect-artifact.ps1 `
  -ArtifactPath $env:TEMP/orchestrator-pack-rca-memo.md `
  -Kind rca-memo
```

**Manual equivalent (pwsh string composition — no stdin `<` redirect):**

```powershell
$memo = Get-Content -Raw $env:TEMP/orchestrator-pack-rca-memo.md
$prompt = @"
You are a critical reviewer for a root-cause investigation memo.
Challenge unsupported claims, missing queue/architecture search, items listed
under Planned (§4) that are closed, merged, or already on main, and patches
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
  prefix alone — use the registry, `gh issue view`, merged PR search, and
  spot-checks on `main` first.
- Put closed, merged, or already-shipped work in **§4 Planned** — that belongs
  in **§3 Already done** (see **Verify §4 — ship check**).
- Pad **§4** with open issues you did not verify against `main` and linked PRs.
- Skip queue, draft, or architecture search when the topic is in-repo behavior.
- Duplicate **`study-external-source`** for external adoption asks.
- Patch merged implementation code as the durable fix — fix spec, contract, or
  rule and spawn a worker.
- Commit transient memos or proposal files to the repo.
