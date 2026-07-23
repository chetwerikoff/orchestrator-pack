---
name: adversarial-draft-review
description: Use when the user asks to adversarially challenge a LOCAL draft/spec artifact with Codex — triggers «с кодексом», «обсуди с кодексом», «посоветуйся с кодексом», «выясни с кодексом», «драфт с кодексом», «создай задачу с кодексом», «придирчиво», «оспорь подход», "draft with codex", "adversarial draft", "challenge the approach". Standalone Codex challenge loop (≤3 cold passes, evaluate-don't-obey) over a local markdown artifact; also the recorded-substitution engine for create-issue-draft's competitive stage when browser GPT is unavailable. GPT-authored Issue tasks (Issue link + chat link) go to create-issue-draft — its competitive stage is built in. Skip plain "создай драфт" with no «с кодексом»/adversarial marker.
---

# adversarial-draft-review

Runs an **adversarial Codex challenge loop** over a local draft/spec artifact.
Codex CLI twin of [`discuss-with-gpt`](../discuss-with-gpt/SKILL.md).

Two roles under the GPT-chat authoring flow
([`create-issue-draft`](../create-issue-draft/SKILL.md)):

- **Standalone** — the user asks to challenge a local artifact (a draft not
  yet a GPT-authored Issue, a proposal, a spec rewrite).
- **Recorded substitution** — engine for `create-issue-draft`'s competitive
  stage **only** when browser GPT is unavailable (Chrome/CDP down and the
  operator cannot raise it); record the substitution in the ledger notes.

Issue-body floors, ledger normalization, tier gate, decision logging, and
acceptance stay owned by `create-issue-draft`.

## When to invoke

| Trigger | Skill |
|---------|-------|
| «с кодексом» / «придирчиво» / «оспорь подход» / "draft with codex" | **this skill** |
| «с gpt» / «с гпт» | [`discuss-with-gpt`](../discuss-with-gpt/SKILL.md) |
| GPT-authored Issue task (Issue link + chat link) | `create-issue-draft` — competitive stage built in (browser GPT) |
| plain «создай драфт» (no marker) | `create-issue-draft` directly |
| bug/root-cause consult | `investigate-root-cause` / `codex:rescue` |

Do not impose by default — adversarial pass is a paid Codex run.

Skip if Codex CLI / companion runtime unavailable — fall back to
`create-issue-draft` and tell the user the pass was skipped.

## Flow

### 1. Obtain the artifact

The loop challenges an existing **local** artifact — a draft file, proposal,
or spec rewrite (any markdown path). This skill authors nothing. GPT-authored
Issues are challenged inside `create-issue-draft` (competitive stage), not
here; when acting as its recorded substitution, pull the current Issue body to
a local file first and challenge that revision. Explicit wrapper invocation
floors the effective tier at ≥ **T2** (`create-issue-draft` tier gate, wrapper
inheritance).

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

### 7. Hand back

Standalone runs: the artifact continues on its normal path (architect review,
then publish when asked). Substitution runs: return to `create-issue-draft`'s
pipeline — captures land as `pass-NN-competitive.capture.txt` in the draft's
`.review/` dir, findings are relayed to the task chat. The adversarial loop
**never replaces** the architectural review stage.

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
