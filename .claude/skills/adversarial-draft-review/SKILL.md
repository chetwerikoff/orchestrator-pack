---
name: adversarial-draft-review
description: Use when the user asks to author a task draft/issue AND involve Codex to challenge the approach first — triggers «с кодексом», «обсуди с кодексом», «посоветуйся с кодексом», «выясни с кодексом», «драфт с кодексом», «создай задачу с кодексом», «придирчиво», «оспорь подход», "draft with codex", "adversarial draft", "challenge the approach". Wraps create-issue-draft: author → adversarial Codex challenge loop (≤3 iterations, evaluate-don't-obey) → normal architect review → sync. Skip plain "создай драфт" with no «с кодексом»/adversarial marker — that goes straight to create-issue-draft.
---

# adversarial-draft-review

This skill **does not redefine** the draft. It inserts an adversarial Codex
challenge loop **between authoring and the normal architect review** of
[`create-issue-draft`](../create-issue-draft/SKILL.md). Authoring structure,
the 5-mode framework, decision logging, the normal `codex review` pass, the
sync gate, and `gh issue create` all stay owned by `create-issue-draft`. You
only add the pre-review challenge loop described below.

## When to invoke

Invoke when the request to create/discuss a task or draft carries a «с
кодексом» marker or an explicit adversarial cue: «с кодексом», «обсуди с
кодексом», «посоветуйся с кодексом», «выясни с кодексом», «драфт с кодексом»,
«создай задачу с кодексом», «придирчиво», «оспорь подход», «adversarial»,
"challenge the approach", "draft with codex". A plain "создай задачу / драфт"
with no such marker → use `create-issue-draft` directly, no loop (the
adversarial pass is a paid Codex run; don't impose it by default).

**Disambiguation:** a «с кодексом» phrase triggers this skill only when the
intent is to **create or shape a task/draft or its approach**. A bare consult
about a failure/bug («посоветуйся/выясни с кодексом, почему упал тест») is
root-cause/rescue territory — defer to `investigate-root-cause` / `codex:rescue`.

Skip if the Codex CLI / companion runtime is unavailable — fall back to
`create-issue-draft` and tell the user the adversarial pass was skipped.

## Flow

1. **Author the draft.** Follow `create-issue-draft`'s "Draft file structure"
   and framework triggers to write `docs/issues_drafts/NN-<slug>.md`. **Stop
   before** its "Codex review the draft" + sync steps — do not run the normal
   review or `gh issue create` yet.

2. **Run the adversarial pass (direct script call).** The `/codex:adversarial-review`
   slash command is `disable-model-invocation: true` — you cannot fire it. Call
   its engine directly so you keep the full wrapping (git-scope resolution,
   diff sizing/self-collect, the adversarial prompt, and the **structured JSON
   findings contract**). Resolve the newest plugin version, run from repo root:

   ```bash
   SCRIPT=$(ls -d ~/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs | sort -V | tail -1)
   node "$SCRIPT" adversarial-review --wait --json --scope working-tree \
     "Challenge the SPEC at docs/issues_drafts/NN-<slug>.md only. Question whether this is the right approach, its hidden assumptions, missing acceptance criteria, hidden coupling, contract drift, and where the design fails under real conditions. Ignore other working-tree changes."
   ```

   - The draft is an untracked working-tree change, so `--scope working-tree`
     picks it up. **Caveat:** the review targets the *whole* working tree — if
     other unrelated changes are present, scope the focus text to the draft
     path (as above) and disregard findings on files outside the draft, or
     author when the tree is otherwise clean.
   - `--json` returns the structured contract: `verdict` (`approve` |
     `needs-attention`), `summary`, `findings[]` (`severity`, `title`, `body`,
     `file`, `line_start`, `line_end`, `confidence`, `recommendation`),
     `next_steps[]`.

3. **Read the findings as proposals, not orders.** Codex argues to break
   confidence in the approach. Treat each finding as a challenge to weigh — never
   as an instruction to apply.

4. **Evaluate each finding against the rubric.** Decide per finding:

   | Verdict | When | Action |
   |---------|------|--------|
   | **Accept** | The alternative is genuinely **simpler AND more reliable**, or the finding exposes a real gap (missing acceptance criterion, hidden coupling, contract drift, scope/security hole). | Revise the draft. |
   | **Partial** | Valid kernel, but the proposed remedy **over-specifies** (prescribes file names, signatures, libraries, internal layout the planner should own). | Fix the spec **minimally** — keep it about *what must be true*, not *how*. Do **not** adopt Codex's prescriptive solution. |
   | **Reject** | Speculative, stylistic, over-engineered, guards an out-of-scope failure mode, or would narrow planner freedom. | Leave the draft; record why. |

   Anchor on CLAUDE.md: planner freedom is non-negotiable, and the cost rule is
   "cheapest sufficient executor with acceptable risk." A finding that pushes
   the spec toward over-specification is itself the bug — reject or trim it.

5. **Log every accept/reject as a decision.** Use `create-issue-draft`'s
   decision-logging path (and `docs/architecture.md` / `00-architecture-decisions.md`
   for architectural calls). One line per finding: what Codex argued, your
   verdict, why. This is the durable record — without it the reasoning dies in
   chat.

6. **Iterate, capped at 3 adversarial passes total.** Re-run step 2 only after
   you accepted/partially-accepted at least one finding and revised the draft.
   **Stop** when any holds:
   - `verdict` is `approve`, or
   - every remaining finding is rejected (nothing left to apply), or
   - 3 passes done — record any still-open findings as explicit risks/open
     questions in the draft and move on.

7. **Hand back to `create-issue-draft`.** Resume its normal flow from "Codex
   review the draft" onward: the standard architect `codex review` pass + sync
   gate + `gh issue create`/`edit`. The adversarial loop **never replaces** this
   review — it precedes it.

8. **Publish.** Then `publish-issue-draft` as usual (default sync-only unless
   the user asks to commit/PR).

## Don't

- **Auto-apply** any finding. Step 4's evaluation is mandatory; blind acceptance
  defeats the point (see draft 19 / Issue #51 — we adopted the *discipline*, not
  an obey-the-adversary stance).
- Let the adversarial pass **substitute** for the normal architect review — both
  run, in order.
- Over-specify the draft to satisfy a finding. Loosen the spec instead.
- Exceed 3 adversarial passes, or re-run with no accepted change (it will churn).
- Skip decision logging.
- Hand-edit the `.cursor/skills/` pointer — it is generated by
  `scripts/generate-skill-pointers.ps1`.
