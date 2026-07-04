---
name: adversarial-draft-review
description: Use when the user asks to author a task draft/issue AND involve Codex to challenge the approach first — triggers «с кодексом», «обсуди с кодексом», «посоветуйся с кодексом», «выясни с кодексом», «драфт с кодексом», «создай задачу с кодексом», «придирчиво», «оспорь подход», "draft with codex", "adversarial draft", "challenge the approach". Wraps create-issue-draft: author → adversarial Codex challenge loop (≤3 iterations, evaluate-don't-obey) → normal architect review → sync. Skip plain "создай драфт" with no «с кодексом»/adversarial marker — that goes straight to create-issue-draft.
---

# adversarial-draft-review

Inserts an **adversarial Codex challenge loop** between draft authoring and the
normal architect review in
[`create-issue-draft`](../create-issue-draft/SKILL.md). Codex CLI twin of
[`discuss-with-gpt`](../discuss-with-gpt/SKILL.md).

Authoring structure, 5-mode framework, decision logging, normal `codex review`,
sync gate, and `gh issue create` stay owned by `create-issue-draft`.

## When to invoke

| Trigger | Skill |
|---------|-------|
| «с кодексом» / «придирчиво» / «оспорь подход» / "draft with codex" | **this skill** |
| «с gpt» / «с гпт» | [`discuss-with-gpt`](../discuss-with-gpt/SKILL.md) |
| plain «создай драфт» (no marker) | `create-issue-draft` directly |
| bug/root-cause consult | `investigate-root-cause` / `codex:rescue` |

Do not impose by default — adversarial pass is a paid Codex run.

Skip if Codex CLI / companion runtime unavailable — fall back to
`create-issue-draft` and tell the user the pass was skipped.

## Flow

### 1. Author the draft

Follow `create-issue-draft`'s structure and framework triggers →
`docs/issues_drafts/NN-<slug>.md`. **Stop before** "Codex review the draft" + sync.

### 2. Run the adversarial pass

`/codex:adversarial-review` is `disable-model-invocation: true` — call the engine
directly from repo root:

```bash
SCRIPT=$(ls -d ~/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs | sort -V | tail -1)
node "$SCRIPT" adversarial-review --wait --json --scope working-tree \
  "Challenge the SPEC at docs/issues_drafts/NN-<slug>.md only. Question whether this is the right approach, its hidden assumptions, missing acceptance criteria, hidden coupling, contract drift, and where the design fails under real conditions. Ignore other working-tree changes."
```

- Draft as untracked working-tree change → `--scope working-tree` picks it up.
  **Caveat:** review targets the whole tree — scope focus text to the draft path
  and disregard findings outside it, or author when the tree is clean.
- `--json` returns: `verdict` (`approve` | `needs-attention`), `summary`,
  `findings[]` (`severity`, `title`, `body`, `file`, `line_start`, `line_end`,
  `confidence`, `recommendation`), `next_steps[]`.

**Hard cap: 3 adversarial passes total** (including the first).

### 3. Read findings as proposals

Codex argues to break confidence. Each finding is a challenge to weigh — never an
instruction to apply. Capture verbatim output and normalize into the draft's
finding-disposition ledger per `create-issue-draft` (Issue #575).

### 4. Evaluate each finding

| Verdict | When | Action |
|---------|------|--------|
| **Accept** | Genuinely simpler AND more reliable, or real gap (missing AC, hidden coupling, contract drift, scope/security hole). | Revise draft. |
| **Partial** | Valid kernel but remedy over-specifies (file names, signatures, internal layout). | Fix minimally — *what must be true*, not *how*. |
| **Reject** | Speculative, stylistic, over-engineered, out-of-scope, narrows planner freedom. | Leave draft; record why. |

Anchor: planner freedom is non-negotiable; cost rule = cheapest sufficient executor.

### 5. Log decisions

Via `create-issue-draft`'s decision-log path (+ `docs/architecture.md` for
architectural calls). One line per finding: what Codex argued, your verdict, why.

### 6. Iterate — capped at **3 passes**

Each re-run = fresh **cold** Codex thread (no cross-pass memory). Re-run **only**
after you accepted/partially accepted ≥1 finding and revised the draft. Append a
settled-decisions block to the re-run focus text:

```
Already decided in earlier passes — do NOT re-raise (settled):
- <finding>: rejected — <one-line reason>
- <finding>: resolved — draft now <what changed>
Attack the current draft afresh for NEW weaknesses only.
```

**Stop** when any holds:

- `verdict` is `approve`, or
- every remaining finding is rejected (nothing left to apply), or
- **3 passes done** — record still-open findings as explicit risks/open questions.

Never resume a single Codex thread across iterations — it softens into agreement.

### 7. Hand back to `create-issue-draft`

Resume from "Codex review the draft" onward. Adversarial loop **never replaces**
architect review.

### 8. Publish

`publish-issue-draft` (default sync-only unless asked to commit/PR).

## Don't

- Auto-apply findings — step 4 is mandatory.
- Let adversarial pass substitute for normal architect review.
- Over-specify the draft to satisfy a finding.
- **Exceed 3 adversarial passes**, or re-run with no accepted change.
- Resume a single Codex thread across iterations.
- Skip decision logging.
- Hand-edit `.cursor/skills/` pointer (generated by `scripts/generate-skill-pointers.ps1`).
