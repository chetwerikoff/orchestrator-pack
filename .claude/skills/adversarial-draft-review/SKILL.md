---
name: adversarial-draft-review
description: Use when the user asks to adversarially challenge a draft/spec artifact with Codex — triggers «с кодексом», «обсуди с кодексом», «посоветуйся с кодексом», «выясни с кодексом», «драфт с кодексом», «создай задачу с кодексом», «придирчиво», «оспорь подход», "draft with codex", "adversarial draft", "challenge the approach". Runs a standalone Codex challenge loop (≤3 cold passes, evaluate-don't-obey) over a local markdown artifact. Codex has no role in create-issue-draft; for GPT-authored task specs use create-issue-draft. Skip plain "создай драфт" with no «с кодексом»/adversarial marker.
---

# adversarial-draft-review

Runs a **standalone adversarial Codex challenge loop** over a draft/spec artifact.
Codex CLI twin of [`discuss-with-gpt`](../discuss-with-gpt/SKILL.md).

**Out of create-issue-draft.** Codex is not a reviewer engine, outage substitute,
or mandatory addition in the GPT-only `create-issue-draft` flow. When browser
GPT is unavailable during task-spec authoring, required GPT work stays
incomplete — no engine substitution. This skill serves only explicit standalone
«с кодексом» / adversarial requests over a local artifact.

Worker **PR-code** review (`PACK_REVIEWER`, `prompts/codex_review_prompt.md`) is
unchanged.

## When to invoke

| Trigger | Route |
|---------|-------|
| «с кодексом» / «придирчиво» / «оспорь подход» / "draft with codex" | this skill |
| «с gpt» / «с гпт» | [`discuss-with-gpt`](../discuss-with-gpt/SKILL.md) |
| GPT-authored Issue + task-chat link | `create-issue-draft` |
| plain «создай драфт» | `create-issue-draft` |
| bug/root-cause consult | `investigate-root-cause` / `codex:rescue` |

**Brief-only task creation.** Route through `create-issue-draft` for Issue
authoring. An explicit «создай задачу с кодексом» brief does **not** add an
in-flow Codex stage to that flow — run this skill **standalone** on the artifact
only when the operator wants a separate Codex challenge before or beside
create-issue-draft, and record that choice outside the create-flow stage ledger.

## Availability is a gate

Do not silently turn an explicit Codex request into an unreviewed acceptance.

- **Standalone explicit request:** report Codex unavailable and stop the Codex
  loop. Continue without it only after a direct operator decision; record that
  waiver in the decision log and final status.

## Flow

### 1. Obtain the artifact

Target an existing local markdown artifact. The companion's `--scope working-tree`
sees only uncommitted files inside the repository, so copy an out-of-repo or
committed artifact to an ephemeral untracked in-repo scratch path such as
`.review-challenge/<N>-<slug>.md`, name that exact path in the focus text, and
delete the copy after the pass. It is transport scratch, not a task artifact and
never enters a commit.

### 2. Run the adversarial pass

`/codex:adversarial-review` is `disable-model-invocation: true`; call the
companion directly from repository root:

```bash
SCRIPT=$(ls -d ~/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs | sort -V | tail -1)
node "$SCRIPT" adversarial-review --wait --json --scope working-tree \
  "Challenge the SPEC at <actual-scratch-path> only. Question the approach, hidden assumptions, missing acceptance criteria, coupling, contract drift, and real-condition failures. Ignore unrelated working-tree changes. The companion JSON schema is fixed: put exact review-level review-economics-contract: v1 and any terminal NO_FINDINGS / SIMPLIFICATION_CLEAN tokens as literal lines in the schema-native summary; for each material finding put stable id:, type:, evidence:, persistent-machinery: yes|no, and for yes cheapest-sufficient-alternative:, stakes-price:, trade-in:, plus any simplification-cut-candidate: yes, as literal lines in the schema-native finding body. Use the schema-native recommendation field for non-binding remedy advice. Apply the four-question simplification lens from prompts/codex_draft_review_prompt.md. Do not invent JSON keys outside the companion schema."
```

The JSON result carries `verdict`, `summary`, `findings[]`, and `next_steps[]`.
Hard cap: **3 passes total**.

### 3. Evaluate findings

Treat every finding as a proposal, never an instruction. Defect disposition and
remedy choice are separate: a real defect may be addressed with a cheaper
sufficient correction than Codex recommended.

| Disposition | Rule |
|-------------|------|
| **Accept** | Real correctness, contract, security, scope, coupling, or acceptance gap; revise. |
| **Partial** | Valid core but over-prescribed remedy; fix the required outcome only. |
| **Reject** | Speculative, stylistic, disproportionate, out of scope, or reduces planner freedom; record why. |

Capture raw output before edits. Log dispositions in the owning artifact's
decision record when one exists.

### 4. Iterate

Each retry is a fresh cold Codex thread. Retry only after at least one accepted
or partially accepted finding changed the artifact. Carry a compact settled
ledger and stop when the current pass has no accepted finding, or at cap 3 with
open risks recorded. Never resume a previous Codex thread.

### 5. Hand back

Return the reviewed artifact and decision log to the owning flow. Standalone runs
do not write create-issue-draft workdir captures unless the operator explicitly
bridges them.

## Don't

- Auto-apply findings.
- Claim Codex ran when unavailable.
- Substitute Codex for required browser-GPT work in `create-issue-draft`.
- Credit Codex as a create-flow review stage, outage replacement, or T3-critical
  addition.
- Exceed three passes or retry without an accepted change.
- Leave `.review-challenge/**` scratch in the repository.
- Resume one Codex thread across iterations.
- Hand-edit `.cursor/skills/**`; regenerate only when canonical frontmatter changes.
