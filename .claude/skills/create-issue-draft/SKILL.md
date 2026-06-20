---
name: create-issue-draft
description: Use when authoring a new task draft for `orchestrator-pack` — adding `docs/issues_drafts/NN-<slug>.md` and syncing it as a GitHub Issue. Covers the mandatory prior-art reconnaissance gate (survey shipped + queued work before authoring), the task-decomposition gate (split large work into single-PR-sized drafts up front), the draft structure, the 5-mode framework triggers, decision logging, and the sync-to-GitHub procedure. Invoke before opening any new issue or rewriting an existing draft. Do not invoke for tiny docs typos or rename-only refactors.
---

# create-issue-draft

You are authoring a task spec that will be picked up by Cursor (planner+worker)
under AO orchestration and reviewed by Codex. Your output goes through GitHub
Issues. The planner picks file names, function shapes, library choices — you
set boundaries and acceptance criteria. **Over-specification is a bug.**

## When to invoke

- Adding a new issue to the queue.
- Rewriting an existing draft after a Codex finding or 5 Whys analysis.
- Splitting / merging issues during pre-implementation alignment.

Skip on: typo fixes, rename-only refactors, one-file mechanical CI tweaks.

## Prior-art reconnaissance gate (run FIRST — before any design analysis)

Before you analyse the problem or write a single draft line — for anything beyond
a typo/rename — you MUST survey what the project has **already shipped** and
**already queued** on this topic, and let the findings decide whether, and as
*what*, the draft should exist at all. Skipping this is how draft #95 shipped a
~1100-line "new runtime egress" design that was ~80% redundant with already-merged
`#205/#232/#281/#283/#267`; the scope correction then happened as an expensive full
rewrite instead of *before* authoring. The reconnaissance is the cheap insurance
against re-implementing merged machinery.

**Applies** to every new build or rewrite. **Skips** only for typo/rename/one-line
mechanical fixes (same skip line as the design-analysis gate below).

### Two surveys — delegate the bulk read, keep the verdict

The combined corpus — 90+ drafts plus the architecture decision log, the queue
index, and declaration snapshots — is far over the read-delegation triggers, so
the bulk read is **mandatory** coworker work (`coworker ask --profile code`); the
*conclusion* stays on the reasoning model. The corpus is markdown, so it sends
**without** `--allow-code`; add `--allow-code` only for the narrow hop that
confirms a claim against shipped *script* code.

**1. Shipped work — what is already built, and which architectural decisions were
made and why.** Sources:
- Closed issues + merged PRs on the topic —
  `gh issue list --repo chetwerikoff/orchestrator-pack --state closed --search "<topic terms>"`
  and `gh pr list --repo chetwerikoff/orchestrator-pack --state merged --search "<topic terms>"`.
- `docs/architecture.md` and `docs/issues_drafts/00-architecture-decisions.md` —
  the decision log (the *why*, not only the *what*).
- `docs/declarations/**` — which files each shipped issue actually authored (the
  concrete surface already occupied).
- The drafts whose issues are **merged** (resolve numbers via
  [`docs/issue_queue_index.md`](../../docs/issue_queue_index.md)).

**2. Open queue — what is already planned or in-flight on the topic.** Sources:
- Open issues —
  `gh issue list --repo chetwerikoff/orchestrator-pack --state open --search "<topic terms>"`.
- [`docs/issue_queue_index.md`](../../docs/issue_queue_index.md) — the draft→issue
  discovery map.
- `docs/issues_drafts/**` — local drafts, **including ones not yet synced** to GitHub.

**Delegation command (one call covers both surveys' markdown corpus):**

```bash
coworker ask --profile code \
  --paths docs/issues_drafts/ docs/architecture.md docs/issue_queue_index.md docs/declarations/ \
  --question "For the topic '<one-line topic>': (1) which shipped/merged issues or drafts already build any part of this, and what architectural decision did each settle and why — quote the rationale where stated; (2) which OPEN issues or un-synced local drafts already cover any part of this. Return issue/draft ids with a one-line 'what it already does'."
```

Run the `gh` queries yourself (live open/closed/merged state is not in the
markdown corpus). If `coworker` is unavailable or rate-limited, read in-session and
say so in your final status (coworker-policy accountability clause).

### Scope verdict (judgment — never delegated)

From the survey, decide exactly one verdict and act on it:

- **Already shipped** → do **not** author a fresh build draft. The durable move is
  a reference / cleanup / catalog draft over the existing work, or no draft at all.
  (This is the #95 case.)
- **Already queued** → fold the idea into the existing open draft/issue; do not open
  a parallel one.
- **Extends / references existing** → author, but **Prerequisite** must cite every
  merged issue it builds on (draft path + GitHub #), and **Goal** / **Binding
  surface** must state explicitly what it **re-uses vs. adds**, so it cannot silently
  re-implement shipped machinery.
- **Genuinely new** → no material overlap found; author normally.

### Record the recon in the draft

The verdict and its evidence are not throwaway — capture them so the next reader
(and Codex) can check the scope was earned:
- **Prerequisite** lists the merged issues the draft builds on / references, each
  with the one-line "already does" from the survey.
- **Decisions (design analysis)** carries a short **Prior art** note: what already
  exists, what each shipped decision settled and why, and why the chosen scope does
  not duplicate it. (Draft #95's post-hoc "Scope correction" note is exactly this —
  the gate just requires it **up front**, before authoring, not after a rewrite.)

This gate **feeds** the design-analysis gate below: whenever the survey finds
overlap, the ≥3-option analysis (element 4) MUST include "reference / extend the
shipped work instead of rebuilding it" as one judged option.

## Task decomposition gate (run before authoring — split large work into shippable units)

Once the reconnaissance gate has told you what genuinely needs building, decide its
**size** before you write the body. A draft is **one independently shippable,
single-PR-sized build**: one coherent contract, landable and reviewable on its own,
behind at most a short prerequisite chain. If the work is bigger than that,
**decompose it into several drafts up front** — never author one mega-draft and hope
the planner splits it.

**Why this is a hard gate, not a style note.** The original draft #95 was ~1100
lines. That overflows the **GitHub Issue body cap (≈65,536 characters)** — `gh issue
create` rejects or truncates it, so the spec literally "не прошла лимиты." Even under
the cap it is far more surface than **one worker can land in one PR** or **one Codex
pass can review** — so the spec ships untested edges. An over-large draft is a
**decomposition smell**, not a formatting problem.

**Decompose when ANY holds:**
- The work touches **multiple independently-shippable contracts** (e.g. a data
  format **and** a generator **and** an audit **and** a runtime change) — each is a
  draft.
- The acceptance criteria fall into **clusters that could each merge and add value on
  their own**.
- The body is heading toward **hundreds of lines / the issue-body char cap**.
- Sub-parts have **different prerequisites** or could be built by **different workers
  in parallel**.

**How to decompose:**
1. Identify the **minimal first shippable slice** — the contract everything else
   depends on. That is draft N.
2. Peel each further independently-landable capability into its own draft (N+1,
   N+2, …), each citing its predecessor in **Prerequisite** so the queue shows the
   ordering.
3. **Each child draft passes the full gate on its own** — prior-art recon, design
   analysis, planner-freedom, behavior-kind, acceptance criteria.
4. Record the split: the parent scope and which slice each child owns, so siblings
   cross-reference rather than silently overlap.

Keep each draft to the **smallest contract that is independently true and testable**.
A spec that needs ~1000 lines to state its acceptance criteria is almost always
several specs wearing one issue number — split it before authoring, not after a Codex
finding or a sync failure.

**Decompose reactively, too — don't let adversarial review inflate a draft into a
subsystem.** Sometimes the over-scope only surfaces *during* the Codex/GPT review
loop: a finding demands an enforcement sub-mechanism, you add it, and the next finding
attacks *that* — a regress of "but that anchor is mutable / who protects the
protector", a bootstrap chicken-and-egg, or a lifecycle that reaches past this PR's
surface (into the implementing PR, live GitHub settings, another reviewer). That
runaway is the decomposition smell arriving late. The fix is to **scope the
sub-mechanism OUT to a follow-up** — name it in **Files out of scope** with who owns
it, record the residual honestly, and stop — **not** to keep piling machinery into the
draft under review. An authoring gate must stay an authoring gate; an enforcement
subsystem is its own build. (Lesson from #366 / draft 117: the `NEW`-obligation
CI-enforcement lifecycle and the legacy-list anti-tamper hardening were each scoped out
after spawning an unresolvable bootstrap regress — and the draft converged once they
were.)

## Pre-draft design-analysis gate (run before authoring)

Before you propose a solution or write a single line of the draft, when the
task is a **non-trivial build** — a new component, contract, or service that
becomes its own worker build — you MUST first answer the design questions
below and let the answers shape the draft. This is the authoring-side twin of
the RCA design block (`docs/issues_drafts/79-rca-design-recommendation-block.md`,
GitHub #237): #237 enriches what an RCA *recommends*; this gate enriches what
you *author*. Keep both surfaces saying the same thing.

**Applies when** the proposal is a non-trivial build (new component / contract /
service / would-be worker draft). **Skips** for operator/runtime steps, config
or YAML changes, one-line spec or rule edits, typo/rename fixes — forcing a
three-option analysis onto those is noise.

When it applies, answer all of, and reflect the conclusions in **Goal** /
**Binding surface** before finalising:

1. **Critical mechanics for *this* problem** — the patterns, data structures,
   integrations, and boundary / edge conditions that decide whether the design
   holds. Name them, not generic ones.
2. **World / industry best practices** — how this *class* of problem is solved
   in the field; what the established approach is and why. (Delegate the bulk
   read/research to `coworker ask --profile code --paths <files...> --question "..."`,
   or `WebSearch`, per the coworker policy; keep the judgment here. Source-code
   corpus still requires `--allow-code`.)
3. **Services / components architecture sketch** — how the pieces fit together
   (responsibilities, data flow, boundaries). Diagrams as ASCII.
4. **≥ 3 implementation options, each with an explicit trade-off** — not three
   restatements of one approach. Judge each on **cost, risk, and sufficiency**
   (tests + Codex review as the safety net), then land on the **cheapest
   sufficient executor with acceptable risk** per the repo cost rule — never
   "which is best." Record the chosen option and why the two rejected ones lost
   in the draft's decision trail (see **Decision logging**). **When the prior-art
   reconnaissance gate found overlap, one option MUST be "reference / extend the
   shipped work instead of rebuilding it"** — judged on the same axes. "Build it
   fresh" is the cheapest sufficient executor only when the survey proved the
   surface is genuinely empty; re-implementing merged machinery is high-risk
   redundancy (the #95 failure), not a neutral default.
5. **Full-class enumeration for decision / state-machine / event-ordering /
   retry / concurrency causes** — enumerate the decision's input dimensions ×
   values, name the sibling cells that share the root cause, and the expected
   outcome per equivalence class, so the build targets the **class, not the one
   reproduced case** ([[fix-the-class-not-the-case]]). Mandatory on recurrence;
   hand the matrix to **Acceptance criteria** as exhaustive fixtures.

**Planner-freedom guard.** The sketch and the chosen option inform *what must be
true* — they do not become prescriptive spec. Do not let element 3/4 leak
function signatures, import paths, folder layout, or library pins into the draft
(see the **Planner-freedom checklist**). The analysis bounds the contract; the
planner still picks the internals.

Long comparison tables / option matrices go to an OS temp file and are linked,
not pasted into the draft body (same convention as #237) so the spec stays lean.

## Draft file structure (fixed order)

Path: `docs/issues_drafts/NN-<slug>.md`. Top-level H1 is the issue title.

1. **Prerequisite** — issues that must merge first, **plus the already-merged
   issues this draft builds on or references** (from the prior-art reconnaissance
   gate), each with the one-line "already does" so the planner sees what is reused
   vs. added. Reference the **draft file path** (stable) plus the GitHub number from
   [`docs/issue_queue_index.md`](../../docs/issue_queue_index.md) when known, e.g.
   `docs/issues_drafts/11-orchestrator-autonomous-review-loop.md` (GitHub #28).
   Never cite a bare draft prefix as if it were a GitHub Issue number.
2. **Goal** — one paragraph. Outcome, not method.
3. **Binding surface** — what this issue commits the repository to. Concrete
   about contracts, deliberately vague about implementation.
   - **Operator adoption** (required when **Files in scope** include
     operator-facing surfaces: `agent-orchestrator.yaml.example`, runbooks or
     go-live docs that introduce new operator processes, documented operator env
     vars, machine-local config outside the repo, or `orchestratorRules` /
     `reactions` requiring `ao stop` / `ao start`): add a bullet listing
     post-PR steps the operator must run (yaml merge, processes, env, restart,
     verification). Omit when the task does not touch those surfaces.
4. **Files in scope** — coarse-grained directories or specific new files.
   Mark new files `(new)`. Avoid prescribing function names / signatures.
5. **Files out of scope** — explicit list.
6. **Denylist** — mandatory fenced block, opened with three backticks then
   `denylist`, one path per line, closed with three backticks:

   ````markdown
   ```denylist
   vendor/**
   packages/core/**
   .ao/**
   ```
   ````

   `_shared/issue_parser` matches this fence with the regex
   `` ```(denylist|allowed-roots) `` — only literal triple-backtick fences
   parse. Always include `vendor/**` and `packages/core/**`. Add an
   ` ```allowed-roots ` fence when the task should stay inside a subtree.
7. **Acceptance criteria** — observable, testable bullets. Each one provable
   without reading Claude's mind. Avoid "review by Claude" or "looks good."
8. **Upgrade-safety check** — explicit invariants (no AO core / vendor edits,
   no unsupported YAML, no new repo secrets unless declared here).
9. **Verification** — exactly how the planner proves done: commands, fixtures,
   test outcomes. Match acceptance criteria 1:1 where possible.

## Behavior kind and positive-outcome acceptance (Issue #221)

Every draft whose spec covers an **action-producing** path (on success it
*does* something observable — starts a run, sends a message, wakes a worker,
enacts a transition) MUST declare its behavior kind and include at least one
**positive-outcome** acceptance criterion on realistic input — not only
no-op/defer/failure-branch shape checks.

### Required `behavior-kind` fence

Immediately after **Goal** (or inside **Binding surface** when the whole issue
is record-only observability), declare exactly one fenced block:

````markdown
```behavior-kind
action-producing
```
````

or

````markdown
```behavior-kind
record-only
```
````

Use `record-only` only when every success path is pure observability/logging
with no side effect. The mechanical backstop flags drafts that read
action-producing (listener/supervisor/wake/retry/submit/route/enqueue/reconcile
and synonyms in `scripts/draft-discipline-action-taxonomy.json`) but declare
`record-only` — resolve before sync.

### Required `positive-outcome` block (action-producing only)

For `action-producing` drafts, add at least one fenced block under **Acceptance
criteria**:

````markdown
```positive-outcome
asserts: <observable action on realistic input>
input: realistic
```
````

When the criterion's input is **external-tool output** (CLI JSON, webhook
payload, `gh`/`ao` capture), require production-representative input:

````markdown
```positive-outcome
asserts: <observable action when external tool emits the real shape>
input: external-tool-output
provenance: capture-backed
```
````

`provenance` MUST be `capture-backed` or `sample-backed` (defer to the golden-sample
field-shape guard in draft #76 when in force). A plausible-but-impossible fixture
must not satisfy the criterion.

### Parked root causes (parked root — no silent deferral)

If you defer a suspected **root cause** to a future task, you MUST add a fenced
`parked-root-cause` block (not euphemistic prose alone). Required fields:

````markdown
```parked-root-cause
cause: <specific root-cause statement>
evidence: <what supports deferring instead of fixing now>
reason-deferred: <why this issue does not fix it>
follow-up-issue: #N
resolution-policy: <when the parked cause is considered resolved>
```
````

The follow-up issue MUST exist, be open or intentionally resolved, and its body
MUST carry the declared `cause` statement. Placeholder/vague causes and generic
follow-up issues fail `scripts/check-draft-discipline.ps1`.

### Pre-sync mechanical checks

Before `gh issue create` / `gh issue edit`:

```powershell
pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/NN-<slug>.md
pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command parked-root -DraftPath docs/issues_drafts/NN-<slug>.md
```

Fix failures before sync. Drafts without a `behavior-kind` fence are not
checked for positive-outcome (additive guard only).

## Apply the 5-mode framework when

Run `docs/first_principles_5_operational_framework.md` inline before
finalising the draft if **any** of these hold:

- The task introduces a contract ≥ 2 future issues will depend on
  (finding format, declaration schema, ledger event keys).
- Scope spans more than one of `_shared` / plugin code / scripts / CI.
- The task is a response to a failure — start with **5 Whys**.
- Two scripts or templates share a literal that this task touches —
  apply **Mode 2 (Assumption Destruction)** before approving;
  prefer one canonical source.

Cost rule (from the framework): **don't ask which agent is best, ask which
is the cheapest sufficient executor given tests + Codex review as safety net.**

## Planner-freedom checklist (must pass)

Before syncing the draft to GitHub, confirm none of these is true:

- [ ] Draft names a specific function signature or import path.
- [ ] Draft prescribes a folder layout not derivable from existing conventions.
- [ ] Draft pins a library version, file-internal structure, or comment style.
- [ ] Acceptance criteria can only be checked by Claude reading the diff.

Any "yes" → loosen, re-author. The planner's `ao-declare` produces
`declared_paths`; you bound it via `denylist` + `allowed_roots`, you do not
enumerate it.

## Codex review the draft (before sync, max 5 iterations)

Run a **critical architect** Codex pass on the draft markdown **before** `gh issue create`
or `gh issue edit`. Architect role: `CLAUDE.md`.

**Command discipline (non-negotiable):**

| Use | Do not use |
|-----|------------|
| `codex review` | `codex exec` |
| `scripts/review-architect-artifact.ps1` | `codex exec review` (that is worker **PR** review, not draft spec review) |

Do **not** pipe stdout through `tail`, `head`, or `grep` — wait for the full answer
(typically **10–60 s**; allow up to **3 min** before assuming a stall). Do **not**
kill the process early to sync the issue.

**Focus areas for the reviewer:**

- Planner-freedom (no prescribed signatures, paths, or library pins).
- Observable acceptance criteria (provable without "looks good").
- Command accuracy — real `ao` / `ao-declare` flags (`--declared-paths`,
  `--declared-globs`, not `--paths`); **pwsh 7+** snippets on Linux/WSL2; session id
  ≠ issue number (read from `ao status` / snapshot filename).
- `denylist` + `allowed-roots` fence correctness.
- Cross-draft consistency with `00-architecture-decisions.md` and related drafts.

**Preferred invocation (Linux / WSL2 / pwsh 7+):**

```powershell
pwsh -NoProfile -File scripts/review-architect-artifact.ps1 `
  -ArtifactPath docs/issues_drafts/NN-<slug>.md `
  -Kind issue-draft
```

Add `-FailOnFindings` to exit non-zero when the response is not `NO_FINDINGS`.

**Manual equivalent (pwsh — no stdin `<` redirect):**

```powershell
$draft = Get-Content -Raw docs/issues_drafts/NN-<slug>.md
$prompt = @"
You are the lead architect reviewer for orchestrator-pack (read-only issue-draft spec review).
Review the DRAFT below for planner-freedom, observable acceptance criteria,
command accuracy, denylist/allowed-roots fences, and cross-draft consistency.
Do not suggest implementation file names unless the draft already violates planner freedom.
Do NOT explore the repository unless the draft text is ambiguous.

Tag valid issues P0, P1, or P2.
If no concrete issues remain, respond with exactly NO_FINDINGS on its own line.

--- DRAFT ---
$draft
"@
codex review -c sandbox_mode=danger-full-access $prompt
```

Trusted architect review uses `sandbox_mode=danger-full-access` (no sandbox containment) so Codex can spawn `coworker` and reach the network during draft review.

**Bash equivalent (same contract):**

```bash
draft_path="docs/issues_drafts/NN-<slug>.md"
draft="$(cat "$draft_path")"
codex review -c sandbox_mode=danger-full-access "$(cat <<EOF
You are the lead architect reviewer for orchestrator-pack (read-only issue-draft spec review).
Review the DRAFT below for planner-freedom, observable acceptance criteria,
command accuracy, denylist/allowed-roots fences, and cross-draft consistency.
Do not suggest implementation file names unless the draft already violates planner freedom.

Tag valid issues P0, P1, or P2.
If no concrete issues remain, respond with exactly NO_FINDINGS on its own line.

--- DRAFT ($draft_path) ---
$draft
EOF
)"
```

Alternative when the draft is already saved and you are iterating locally:
`codex review --uncommitted` only if the draft is the sole staged change and
the review prompt is passed as the `PROMPT` argument as above.

**Iteration discipline:**

1. Revise the draft for valid P0/P1/P2 findings; rebut incorrect findings in
   the draft or your notes.
2. Re-run Codex (same prompt pattern).
3. **Hard cap: 5 cycles.** After the fifth pass, sync only if clean (`NO_FINDINGS`)
   or document remaining open questions in the draft **Prerequisite** or
   **Verification** section before sync.

**Sync gate:** do not run `gh issue create` / `gh issue edit` until Codex returns
`NO_FINDINGS` or you have hit the 5-iteration cap and recorded open questions.

Contract reference: `docs/issues_drafts/06-codex-reviewer-scope-context.md`.

## Update the issue queue index

Whenever you add a new draft or first sync a draft to GitHub:

1. Set the draft's `GitHub Issue: #NN` line (or `GitHub Issue: TBD` before sync).
2. Ensure a registry row **exists for this draft** mapping draft path → GitHub Issue
   number (or explicit none yet). **Do not edit the tracked
   [`docs/issue_queue_index.md`](../../docs/issue_queue_index.md) by hand** — the
   publish/sync step (delegated to deepseek via opencode per
   [`publish-issue-draft`](../publish-issue-draft/SKILL.md)) adds or updates **only this
   draft's row** in the working tree and stages it selectively at publish. Supply the row
   text in the opencode delegation prompt when needed.

Do not add open/closed/shipped columns to the registry — live state stays in
GitHub (`gh issue view`).

## Publish (default: delegate to deepseek via OpenCode; direct as fallback)

> **Self-delegation guard — am I already inside OpenCode?** The `opencode run`
> delegation in this section is **only** for an architect surface (Claude Code,
> Cursor CLI) handing the GitHub work to a fresh deepseek session. **If you are
> yourself running inside an OpenCode session** (e.g. the `opk-orchestrator`
> worktree or any AO-managed session — check `echo $AO_SESSION_ID`), do NOT call
> `opencode run` — that spawns a nested OpenCode. Instead run the issue create /
> PR / merge mechanics yourself, directly, using the manual `gh`/git commands in
> the fallback below as your **primary** path.
>
> Direct `gh issue create` / `gh pr create` / `gh pr merge` is blocked by the RTK
> hook. Run it with the **`AO_PUBLISH_FALLBACK=1`** prefix — you are already the
> executing agent, so the fallback is the correct path. If a PR head is behind
> base, run `gh pr update-branch <N>` first.

Once the Codex sync gate passes (`NO_FINDINGS`, or the 5-iteration cap with open
questions recorded), **delegate publish to deepseek via `opencode run`** using
the temp-file mechanism below. This is the default: deepseek handles the fixed
`gh issue create` / `gh pr create` / `gh pr merge` sequence autonomously, freeing
the architect from token-expensive mechanical steps. The direct
`AO_PUBLISH_FALLBACK=1` path (manual `gh`/git commands in the fallback section)
is the **fallback** — use it only when `opencode run` is unavailable or leaves
the publish half-done.

**Mechanism — `opencode run`, not `ao spawn`.** `ao spawn` revives a worker
against an issue that *already exists*, in a fresh checkout; it can neither
create the issue nor see your uncommitted local draft. Run `opencode run` through
`.claude/skills/publish-issue-draft/opencode-publish.sh`: the helper creates a
per-invocation scratch checkout, copies only the named draft and
`docs/issue_queue_index.md` from the architect working tree, rewrites `--dir` to
that checkout, and tears it down. The delegate reads the draft exactly as it sits
on disk without sharing the architect's live working tree.

**Deliver the prompt via a temp file — never inline.** The publish hook
string-matches `gh issue create` / `gh pr create` / `gh pr merge` **anywhere in
the Bash command**, including inside a delegation prompt — an inline heredoc
carrying those literals self-triggers the guard and the call is blocked. Write
the prompt to a temp file first, then pass it via `cat`, so the executed Bash
command contains none of those literals:

```bash
PROMPT_FILE="$(mktemp)"
cat > "$PROMPT_FILE" <<'EOF'
You are publishing an already-reviewed architect task spec for orchestrator-pack
from an isolated scratch checkout. Do NOT run git commands in any other checkout.
The draft is docs/issues_drafts/NN-<slug>.md (substitute the real NN-<slug>). It
passed Codex review — do NOT edit its task content. Steps:

1. Create the GitHub Issue (gh CLI, issue-create subcommand):
   - Title = the draft's H1 (first heading line).
   - Body  = the draft body MINUS the H1 line (tail -n +3 of the file).
   - gh issue create --repo chetwerikoff/orchestrator-pack --title "<H1>" --body-file <tmp>
2. Write the returned number into the draft's `GitHub Issue: #N` line (it is
   `TBD` now). Add this draft's registry row to docs/issue_queue_index.md (draft
   path -> #N; no open/closed/shipped columns) — stage only this row's hunk at
   publish (see publish-issue-draft Index ownership).
3. PUBLISH-TO-MAIN — run only when the prompt below sets PUBLISH=yes. Otherwise
   STOP after step 2 (sync-only: the Issue is the queue, the draft stays local).
   When PUBLISH=yes, follow .claude/skills/publish-issue-draft/SKILL.md Mode C
   exactly: branch from main, commit the draft + this draft's index row only
   (selective staging — spec-only), open the spec-only PR (use that skill's body
   template — NO issue refs of any kind in the PR body: the no-ceremony scope
   guard fails on `Refs #N`, bare `#N`, or issue URLs), wait for CI green, merge
   with the gh CLI (pr-merge subcommand: --merge --delete-branch). If you refresh
   after merge, do it only in this isolated checkout (git checkout main && git pull
   origin main); never touch the architect's live checkout.

Report the Issue URL/number and, when PUBLISH=yes, the PR URL and merge commit.
PUBLISH=<no|yes>
EOF
# Fast isolated runtime: a dedicated opencode data dir avoids SQLite write-lock
# contention with the orchestrator's shared DB (a raw `opencode run` otherwise
# stalls intermittently at "creating instance"); deepseek-chat (non-reasoning) +
# 180s timeout + startup-hang retry. See opencode-publish.sh.
OPENCODE_PUBLISH_INCLUDE="docs/issues_drafts/NN-<slug>.md docs/issue_queue_index.md" \
bash .claude/skills/publish-issue-draft/opencode-publish.sh --dangerously-skip-permissions --dir . "$(cat "$PROMPT_FILE")"
```

**Verify state after the run — `opencode run` can exit 0 mid-failure.** A
connection drop or context exhaustion can leave `opencode run` reporting exit 0
while the publish is half-done (e.g. issue created, PR not opened, or index row
left uncommitted). Do **not** trust the exit code alone: confirm with
`gh issue view <N>`, `gh pr list --search <slug>`, and `git status` before
reporting success, and complete any missing step via the fallback below.

**Default is merge.** Set `PUBLISH=yes` so deepseek runs the full cycle
(PR → CI → `gh pr merge` → `git pull`) — this is the default for the create-task
flow. Switch to `PUBLISH=no` (sync-only: deepseek stops after step 2, the draft
stays local) **only when the user opts out of the merge** («не мержи», «только
драфт», «без PR», "don't merge", "sync only"). This selects
[`publish-issue-draft`](../publish-issue-draft/SKILL.md) Mode C; that skill's own
sync-only default applies only when it is invoked standalone, outside this flow.

**Fallback — architect publishes directly.** If `opencode run` is unavailable,
errors, or leaves the issue/PR half-done, complete the publish yourself with the
manual commands below and tell the user the OpenCode path was unavailable.

### Sync to GitHub Issue (fallback / manual)

The draft body **minus the H1 heading** is the issue body. Use:

```powershell
$body = Join-Path ([System.IO.Path]::GetTempPath()) 'issue-NN-body.md'
Get-Content docs/issues_drafts/NN-<slug>.md | Select-Object -Skip 2 | Set-Content -Encoding utf8 $body
gh issue edit <N> --repo chetwerikoff/orchestrator-pack --body-file $body
```

Bash equivalent:

```bash
body="$(mktemp)"
tail -n +3 docs/issues_drafts/NN-<slug>.md > "$body"
gh issue edit <N> --repo chetwerikoff/orchestrator-pack --body-file "$body"
rm -f "$body"
```

For new issues: `gh issue create ... --body-file $body --title "<title>"`.

### Publish to main (fallback / manual)

The draft must not stay uncommitted on disk. Unless the user opts out
(«только драфт», «без PR», «не мержи»), invoke
[`publish-issue-draft`](../publish-issue-draft/SKILL.md):

1. Declaration snapshot + commit draft, index, and `docs/declarations/<N>.architect-draft-NN.json`.
2. Open PR (`docs: draft NN — … (#N spec)`).
3. Merge when CI is green (and manual Codex review if the user expects it).
4. `git pull` on `main`; **reopen** issue **#N** if GitHub auto-closed it on merge.

## Cross-issue contract changes

When a change affects ≥ 2 drafts (example: NO_FINDINGS contract touching #9
and pulling lessons from #11), land **one** docs PR that:

- Updates every affected draft.
- Re-syncs every corresponding GitHub Issue body in the same PR.
- Bumps the relevant section in `docs/issues_drafts/00-architecture-decisions.md`
  (or `docs/architecture.md`) if a DD-level decision changed.

Never let drafts drift from the architecture decision they descend from. If
the planner sees a stale draft and an updated architecture section, it will
pick the wrong contract.

## Decision logging

Architectural decisions the planner needs across iterations:

1. Add a new sub-section (next letter: `00.G`, `00.H`) to
   `docs/issues_drafts/00-architecture-decisions.md`, or a new DD-NNN entry
   in `docs/architecture.md` once that file owns the DD log style.
2. Sync to Issue #3 (or the live architecture issue) in the same PR.
3. Update every affected draft in the same PR.
4. If the decision invalidates an open Codex finding or an in-flight planner
   action, say so in the PR body so the planner can re-baseline.

## Fold reviewer lessons back

A Codex finding on a merged PR is signal your spec missed something. Default
response: update the upstream draft (the one whose contract was violated),
not the implementation. The next iteration of that draft becomes the durable
fix; the merged PR's manual patch was the one-off.

Example: PR #21's op-rev-3 produced "no concrete bugs" prose wrapped as a
warning — the durable fix landed in Issue #9 (`NO_FINDINGS` contract), not
in the test-harness code.

## Don't (draft Codex review)

- Use `codex exec` or `codex exec review` for draft review — those are worker/PR paths.
- Pipe `codex review` through `tail`, `head`, or `grep` (hides in-progress output).
- Kill a running draft review to rush `gh issue create` — wait for `NO_FINDINGS` or cap.
- Sync to GitHub before Codex review completes (unless 5-iteration cap with open questions recorded).
- Use `ao spawn` to publish a brand-new draft — it needs an existing issue and a
  fresh checkout, so it cannot create the issue or see the local draft. Use
  `opencode-publish.sh --dangerously-skip-permissions --dir .` with
  `OPENCODE_PUBLISH_INCLUDE` and a temp-file prompt (default path), or publish
  manually in a separate checkout (fallback).
- Pass `PUBLISH=yes` to deepseek when the user did not ask to merge — default is
  sync-only; the full PR→merge cycle runs only on explicit request.
