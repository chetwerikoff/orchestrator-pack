---
name: adversarial-draft-review
description: Use when the user asks to adversarially challenge a draft/spec artifact with Codex — triggers «с кодексом», «обсуди с кодексом», «посоветуйся с кодексом», «выясни с кодексом», «драфт с кодексом», «создай задачу с кодексом», «придирчиво», «оспорь подход», "draft with codex", "adversarial draft", "challenge the approach". With only a brief and no artifact, route through create-issue-draft's brief-only entry and run the requested Codex loop in-flow before Issue acceptance. Otherwise run the standalone Codex challenge loop (≤3 cold passes, evaluate-don't-obey) over a local markdown artifact. Also the recorded-substitution engine for create-issue-draft when browser GPT is unavailable. Skip plain "создай драфт" with no «с кодексом»/adversarial marker.
---

# adversarial-draft-review

Runs an **adversarial Codex challenge loop** over a draft/spec artifact. Codex
CLI twin of [`discuss-with-gpt`](../discuss-with-gpt/SKILL.md).

Two roles under the GPT-chat authoring flow
([`create-issue-draft`](../create-issue-draft/SKILL.md)):

- **Standalone** — challenge a local draft, proposal, or spec rewrite.
- **In-flow explicit wrapper** — when a brief-only «создай задачу с кодексом»
  request routed through `create-issue-draft`, run the requested Codex loop
  before the final lens and Issue acceptance.
- **Recorded browser-outage substitution** — when `create-issue-draft`
  explicitly permits Codex to replace an unavailable browser-GPT review stage;
  preserve that stage's capture name and record the substitution.

Issue-body floors, tier selection, finding normalization, task-chat relays, and
acceptance remain owned by `create-issue-draft`.

## When to invoke

| Trigger | Route |
|---------|-------|
| «с кодексом» / «придирчиво» / «оспорь подход» / "draft with codex" | this skill |
| «с gpt» / «с гпт» | [`discuss-with-gpt`](../discuss-with-gpt/SKILL.md) |
| GPT-authored Issue + task-chat link | `create-issue-draft` |
| plain «создай драфт» | `create-issue-draft` |
| bug/root-cause consult | `investigate-root-cause` / `codex:rescue` |

**Brief-only creation.** Route immediately through `create-issue-draft` and
record the explicit Codex request. That flow runs this loop over the current
workdir anchor after browser-GPT architectural review and before the final lens.
Accepted or partially accepted findings go through the task chat, update the
live Issue, and are re-pulled before review continues. This extra loop never
replaces the browser-GPT competitive stage.

## Availability is a gate

Do not silently turn an explicit Codex request into an unreviewed acceptance.

- **Standalone explicit request:** report Codex unavailable and stop the Codex
  loop. Continue without it only after a direct operator decision; record that
  waiver in the decision log and final status.
- **In-flow explicit wrapper, non-T3-critical:** stop before the final lens and
  acceptance. Resume after Codex is restored, or after the operator directly
  waives the requested extra Codex stage; record the waiver in the workdir
  ledger notes and final report.
- **T3-critical mandatory addition:** no waiver. Codex must be restored and the
  independent pass completed; acceptance remains blocked while unavailable.
- **Browser-outage substitution:** if Codex is also unavailable, the replaced
  stage remains blocked; do not synthesize a pass or change its engine silently.

## Flow

### 1. Obtain the artifact

The standalone loop targets an existing local markdown artifact. In-flow runs
target the current out-of-repo workdir anchor. The companion's
`--scope working-tree` sees only uncommitted files inside the repository, so
copy an out-of-repo or committed artifact to an ephemeral untracked in-repo
scratch path such as `.review-challenge/<N>-<slug>.md`, name that exact path in
the focus text, and delete the copy after the pass. It is transport scratch,
not a task artifact and never enters a commit.

Explicit wrapper invocation floors the effective tier at **T2** through
`create-issue-draft`'s tier gate.

### 2. Run the adversarial pass

`/codex:adversarial-review` is `disable-model-invocation: true`; call the
companion directly from repository root:

```bash
SCRIPT=$(ls -d ~/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs | sort -V | tail -1)
node "$SCRIPT" adversarial-review --wait --json --scope working-tree \
  "Challenge the SPEC at <actual-scratch-path> only. Question the approach, hidden assumptions, missing acceptance criteria, coupling, contract drift, and real-condition failures. Ignore unrelated working-tree changes."
```

The JSON result carries `verdict`, `summary`, `findings[]`, and `next_steps[]`.
Hard cap: **3 passes total**.

### 3. Evaluate findings

Treat every finding as a proposal, never an instruction.

| Disposition | Rule |
|-------------|------|
| **Accept** | Real correctness, contract, security, scope, coupling, or acceptance gap; revise. |
| **Partial** | Valid core but over-prescribed remedy; fix the required outcome only. |
| **Reject** | Speculative, stylistic, disproportionate, out of scope, or reduces planner freedom; record why. |

Capture raw output before edits and normalize findings through
`create-issue-draft`'s finding-disposition ledger.

### 4. Iterate

Each retry is a fresh cold Codex thread. Retry only after at least one accepted
or partially accepted finding changed the artifact. Carry a compact settled
ledger and stop when the current pass has no accepted finding, or at cap 3 with
open risks recorded. Never resume a previous Codex thread.

### 5. Hand back

- **Standalone:** return the reviewed artifact to its owning flow.
- **In-flow explicit wrapper / T3-critical:** preserve raw JSON as
  `pass-NN-architectural.codex.json`, transcribe every finding 1:1 to plain
  `type:` lines in `pass-NN-architectural.capture.txt`, relay accepted findings
  through the task chat, and return to `create-issue-draft` before final lens.
- **Browser-outage substitution:** use the guard-recognized capture stage being
  replaced (`competitive`, `architectural`, or `architectural-final`) and keep
  raw JSON alongside it; record the substitution separately.

The Codex loop never replaces the architect lens or the normal architectural
review contract unless it is the explicitly recorded outage substitute for that
specific browser stage.

## Don't

- Auto-apply findings.
- Claim Codex ran when unavailable.
- Accept an in-flow task after silently skipping the requested Codex stage.
- Waive the T3-critical Codex addition.
- Exceed three passes or retry without an accepted change.
- Leave `.review-challenge/**` scratch in the repository.
- Resume one Codex thread across iterations.
- Hand-edit `.cursor/skills/**`; regenerate only when canonical frontmatter changes.
