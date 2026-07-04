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

**Decompose reactively, too.** When a review finding can only be satisfied by an
enforcement sub-mechanism that itself spawns an *unresolvable regress* — a bootstrap
chicken-and-egg, a "who protects the protector" mutable-anchor chain, or a lifecycle
reaching past this PR's surface — scope that sub-mechanism out to a follow-up (name it
in **Files out of scope** with its owner) instead of piling machinery into the draft
under review. **Guard against misuse:** this applies only to that *specific* regress
signal — it is **not** licence to defer a finding because it is merely hard or unwelcome.

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
   - **`complexity-tier` fence** — machine-readable recomputed tier (Issue #576) or
     `skip-line: true` for #237 below-ladder inputs after marker screen passes.
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


## Contract evidence grounding (Issue #366)

Contract grounding (contract grounding) applies to every upstream binding before sync.

Before sync, every upstream datum the draft binds to in **Binding surface**,
**Acceptance criteria**, or **Verification** must be grounded in the draft's
`contract-evidence` block. The block is **mandatory** for every draft not on the
committed legacy-path list (`scripts/contract-evidence-legacy-drafts.json`). A
draft with no upstream binding must declare `contract-evidence: none` explicitly.

### Block format

Each row asserts exactly one binding and exactly one evidence form:

```contract-evidence
binding-id: ao:reportState:fixing_ci
binding-type: structured
binding: ao worker report fixing_ci state
producer: ao
evidence: capture@ao-worker-report/fixing_ci
selector: $.reportState
expected: fixing_ci
```

- **Capture evidence:** every `capture@` row requires machine-readable `binding-id`
  and `binding-type` (`structured`, `unstructured`, or `cli-behavior`). Use
  `binding-type: cli-behavior` when `binding-id` names a `flag`, `command`, or
  `option` datum; CLI rows require manifest exit status `0` plus behavior-specific
  output — bare flag text in help output is not sufficient.
- **Capture evidence (fields):** `evidence: capture@<manifest-entry-id>` plus
  `selector` + `expected` for structured captures, or `token` for unstructured
  text captures.
- **NEW evidence (repo-owned producers only):** `evidence: NEW(produced-by AC#N)`
  where AC#N carries a machine-readable `producer-emission` fence naming
  `producer`, `datum`/`selector`, `expected`, and executable proof via
  `proof-command` or `proof-capture`. External producers (`ao`,
  `gh`, `codex`, including alias spellings) cannot use `NEW`; they require
  capture evidence. `NEW` rows are authoring-time obligations recorded in the
  synced issue body, not existence proofs.
- **No third option:** belief markers, self-attested coworker verdicts, or
  consumer-only assertions are not admissible.

### Contract-grounding collection (coworker ask)

Delegate bulk corpus lookup to coworker using a structured ask that:

1. Enumerates candidate bindings appearing in the draft surfaces.
2. Maps each binding to a producer-corpus location.
3. Returns `found` / `not_found` plus cited evidence location per binding.
4. Flags bindings that appear in the draft but have no proposed row.

Coworker output is **non-authoritative**. Independently re-validate every row
against the cited capture or acceptance criterion before committing it into the
draft. When coworker is unavailable, read the producer corpus directly.

### Architect re-validation rule

The mechanical check re-derives every capture claim from the committed manifest
and capture bytes. A row copied from a coworker `found` verdict without a real
capture still fails sync.


### Pre-sync mechanical checks

Before `scripts/publish-issue-body-sync` create/edit:

```powershell
pwsh -NoProfile -File scripts/check-tier-gate-guard.ps1 -DraftPath docs/issues_drafts/NN-<slug>.md
pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/NN-<slug>.md
pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command parked-root -DraftPath docs/issues_drafts/NN-<slug>.md
pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/NN-<slug>.md
pwsh -NoProfile -File scripts/check-finding-ledger-guard.ps1 `
  -CapturesDir docs/issues_drafts/.review/NN-<slug> `
  -LedgerPath docs/issues_drafts/.review/NN-<slug>/finding-disposition-ledger.json
```

**Guard order (independent — either failing blocks sync):** tier-gate guard →
contract-evidence / positive-outcome / parked-root → finding-ledger guard (when
captures exist). `scripts/publish-issue-body-sync` also refuses create/edit without
a passing tier-gate guard receipt (mechanical sync coupling, Issue #576).

Fix failures before sync. Drafts without a `behavior-kind` fence are not
checked for positive-outcome (additive guard only). The finding-ledger guard validates **every** `*.capture.txt` under the review
directory against the ledger — not only the final pass — so protected findings
from early competitive/architectural passes cannot be omitted when a later pass is
`NO_FINDINGS`. Skip the guard only when the review directory has no capture files.


## Tier gate (recompute authority and stage selection — Issue #576)

Runs **before** per-tier review stages and **before** sync. The gate **recomputes**
tier from the Issue #574 rubric over the brief text; the architect brief tier is an
**advisory prior only** — the gate may override upward, never downward (#574
monotonic rule). Write the recomputed tier to the draft and synced issue body as a
machine-readable fence.

### `complexity-tier` fence (mandatory unless on #237 skip line)

Immediately after **Goal** (or after `behavior-kind` when present), declare exactly
one fenced block:

````markdown
```complexity-tier
tier: T1
advisory-prior: T1
```
````

For below-ladder skip-line inputs (#237: operator/config/one-line/typo), after the
marker screen passes emit:

````markdown
```complexity-tier
skip-line: true
```
````

Skip-line inputs carry **no tier** and no design/adversarial ceremony. The marker
screen still runs first — a danger-marked one-liner cannot use the skip line.

### Recompute authority and blocking escalation

1. **Intake:** recompute tier from brief text vs #574; brief tier is advisory only.
2. **Marker screen (brief):** fail-closed red-flag screen using #574 marker vocabulary
   via `scripts/lib/tier-marker-screen.mjs` (shared logic — same vocabulary future
   consumers may call).
3. **Stage selection** by recomputed tier:
   - **T1:** skip #237 design-analysis gate and adversarial stage; one light
     architectural (Codex) review per #575.
   - **T2:** light design pass; architectural review only (no competitive stage).
   - **T3:** full #237 design-analysis gate + #575 T3 pipeline (counts authoritative
     in `prompts/agent_rules.md` — do not restate here).
4. **Never-skipped floor (every tier):** worker-safety contract (Goal,
   denylist/allowed-roots, Acceptance criteria, Verification), #366 contract-evidence,
   #221 behavior-kind, #575 finding-ledger/carve-out guard — invoked, not rebuilt.
   Only design-analysis and adversarial stages are tier-gated.
5. **Fail-closed marker screen:** marker hit + below-T3 assignment, or marker hit +
   skipped design/adversarial stages → **blocking escalation** to the architect.
   Unparseable text → T3. Never pass by failing to parse.
6. **Wrapper inheritance:** `adversarial-draft-review` and `discuss-with-gpt` route
   through this gate. Explicit user invocation of an adversarial wrapper **floors
   effective tier at ≥ T2** and preserves the requested adversarial stage even when
   recompute yields T1.
7. **Mid-flight upward recompute:** stop, raise fence, run skipped stages, resume.
   Never sync below recomputed tier. If escalation happens after first sync, re-sync
   the issue body with the raised fence before proceeding.
8. **Post-review drift recompute:** on **final draft text** (not the brief), recompute
   tier; upward drift escalates to the architect before publish (#188 drift hook).

**T1 calibration assumption:** T1 fast path assumes #574 calibration sample merged
consistent (#574 merge-blocking AC). No runtime calibration-state plumbing here.

### Tier-gate guard (mechanical)

```powershell
pwsh -NoProfile -File scripts/check-tier-gate-guard.ps1 -DraftPath docs/issues_drafts/NN-<slug>.md
```

Fails closed (non-zero, blocks sync) when red-flag markers coincide with below-T3
assignment or skipped design/adversarial stages. Emits a passing **tier-fence** or
**no-tier (skip-line)** receipt on stdout when clean.


## Per-tier draft review (before sync)

**Tier is gate authority, not brief say-so.** The tier gate (above) already
recomputed tier and selected stages. This section governs **spec review only** —
worker PR-code review is unchanged. Pipeline counts remain authoritative in
`prompts/agent_rules.md` (**Per-tier draft-review flow**, Issue #575).

**Roles:** the **draft author** (this Cursor session from the architect's brief)
authors the spec, runs review stages, captures verbatim reviewer output per pass,
normalizes findings into the disposition ledger, and owns accept/reject. The
**architect** does not re-decide accepted findings; on T3 they run one lens pass
over the reject partition only.

Full contract: `prompts/agent_rules.md` (**Per-tier draft-review flow**, Issue
#575).

### Review artifact layout

Per draft `docs/issues_drafts/NN-<slug>.md`:

```
docs/issues_drafts/.review/NN-<slug>/
  pass-01-competitive.capture.txt      # verbatim reviewer output
  pass-02-architectural.capture.txt
  finding-disposition-ledger.json      # normalized ledger (all passes)
```

**Ledger JSON** (`finding-disposition-ledger.json`):

```json
{
  "version": 1,
  "draft": "docs/issues_drafts/NN-<slug>.md",
  "findings": [
    {
      "id": "stable-id",
      "summary": "one-line summary",
      "type": "security | scope-violation | spec | quality | test | ci",
      "disposition": "addressed",
      "rejectReason": "required when disposition is rejected"
    }
  ]
}
```

Normalization rules:

- Capture **every** reviewer pass verbatim before editing the draft.
- Every emitted finding (typed `type:` in capture) must appear in the ledger.
- `type: security` and `type: scope-violation` (#51) → `disposition: addressed` only.
- Re-worded findings keep the same `id` across passes.
- `NO_FINDINGS` passes add no ledger rows.

### Per-tier stages (ceilings — clean pass ends early)

| Tier | Pipeline |
|------|----------|
| **T1** | One light architectural (Codex) pass. |
| **T2** | Architectural (Codex) only, up to **3** passes; first `NO_FINDINGS` publishes. No competitive stage. |
| **T3** | Competitive adversarial (**GPT** default; **Codex** when GPT unavailable — record substitution) ≤**3** → architectural (Codex) ≤**4** → **architect lens** ×**1** → final architectural (Codex) over architect edits ×**1**. |

**T3-critical** (within-T3): when the task matches the **L4-condition list in
Issue #574 / `docs/issues_drafts/187-task-complexity-tier-rubric.md` Decisions**
(cite by reference), competitive **+Codex is mandatory** and the draft must carry
rollback/migration note plus crash/race/stale-state test.

**Command discipline (non-negotiable):**

| Use | Do not use |
|-----|------------|
| `codex review` / `scripts/review-architect-artifact.ps1` | `codex exec` / `codex exec review` (worker **PR** path) |
| `discuss-with-gpt` / `adversarial-draft-review` for competitive stage | Skipping disposition logging |

Do **not** pipe stdout through `tail`, `head`, or `grep` — wait for the full answer.

**Architectural reviewer prompt:** `prompts/codex_draft_review_prompt.md` (finding
bar, simplification lens, typed findings, #51 carve-out). Loaded by
`scripts/review-architect-artifact.ps1` for issue drafts.

```powershell
pwsh -NoProfile -File scripts/review-architect-artifact.ps1 `
  -ArtifactPath docs/issues_drafts/NN-<slug>.md `
  -Kind issue-draft
```

Add `-FailOnFindings` to exit non-zero when the response is not `NO_FINDINGS`.

### Finding disposition loop

On competitive and architectural stages:

1. Run the stage reviewer; save verbatim output to `pass-NN-<stage>.capture.txt`.
2. For each finding: **address** (revise draft) or **reject** with one-line reason.
3. Update `finding-disposition-ledger.json` — completeness required.
4. Re-run the stage until `NO_FINDINGS` or the tier cap.

Protected `security` / `scope-violation` findings cannot be rejected or omitted;
escalate contested protected findings to the architect.

### Architect T3 lens pass

After T3 architectural review converges:

1. Architect reads the ledger **reject partition** only (does not re-open accepts).
2. Apply simplification lens (what to cut / what is excess); may edit the draft.
3. Run one final architectural (Codex) verification pass over architect edits; save
   verbatim output to `pass-NN-final.capture.txt` like every other pass.

### Drift escalation

After review completes, recompute tier (Issue #189 / draft C). **Upward** drift —
including scope growth from accepted findings — escalates to the architect before
publish. Downward drift is impossible (#574 monotonic rule).

**Sync gate:** do not run `scripts/publish-issue-body-sync` create/edit until
the tier-gate guard passes, review stages for the recomputed tier complete
(`NO_FINDINGS` or documented cap exit), the finding-ledger guard passes when
captures exist, and other pre-sync checks pass.

Contract references: `docs/issues_drafts/06-codex-reviewer-scope-context.md`,
`docs/issues_drafts/19-codex-review-finding-bar.md` (#51 carve-out),
`prompts/codex_draft_review_prompt.md`.

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

**Publish-path contract-evidence gate (Issue #366).** Any path that syncs or
publishes a draft — including the `opencode run` delegate and the manual publish fallback
below — must run the same mechanical guard as pre-sync:

```powershell
pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/NN-<slug>.md
```

Refuse `scripts/publish-issue-body-sync` / publish commit while this exits non-zero.
When delegating to [`publish-issue-draft`](../publish-issue-draft/SKILL.md), include this
command in the delegate prompt and verify it ran before issue sync or spec PR commit.

Once the Codex sync gate passes (`NO_FINDINGS`, or the 5-iteration cap with open
questions recorded), **delegate publish to deepseek via `opencode run`** using
the temp-file mechanism below. This is the default: deepseek handles the fixed
the fixed `scripts/publish-issue-body-sync` + `gh pr create` / `gh pr merge` sequence autonomously, freeing
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

0. Run contract-evidence (and positive-outcome / parked-root when applicable):
   pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/NN-<slug>.md
   Exit non-zero => stop; do not sync or publish.
1. Create or re-sync the GitHub Issue through the mechanical helper (never raw
   `gh issue create` / `gh issue edit`):

   ```bash
   node --import tsx scripts/publish-issue-body-sync.ts create --draft-path docs/issues_drafts/NN-<slug>.md --repo chetwerikoff/orchestrator-pack
   ```

   For an existing issue number, use `edit --issue-number <N>` instead. The helper
   uses `--body-file` transport, reads live REST body via `scripts/gh api`, and
   fails closed on mismatch before reporting success.
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
pwsh -NoProfile -File scripts/publish-issue-body-sync.ps1 -Mode edit -DraftPath docs/issues_drafts/NN-<slug>.md -IssueNumber <N>
```

Bash equivalent:

```bash
node --import tsx scripts/publish-issue-body-sync.ts edit --draft-path docs/issues_drafts/NN-<slug>.md --issue-number <N> --repo chetwerikoff/orchestrator-pack
```

For new issues:

```bash
node --import tsx scripts/publish-issue-body-sync.ts create --draft-path docs/issues_drafts/NN-<slug>.md --repo chetwerikoff/orchestrator-pack
```

### Publish to main (fallback / manual)

The draft must not stay uncommitted on disk. Unless the user opts out
(«только драфт», «без PR», «не мержи»), invoke
[`publish-issue-draft`](../publish-issue-draft/SKILL.md):

1. Run `check-draft-discipline.ps1 -Command contract-evidence` on the draft (plus positive-outcome / parked-root when applicable); refuse publish on non-zero exit.
2. Declaration snapshot + commit draft, index, and `docs/declarations/<N>.architect-draft-NN.json`.
3. Open PR (`docs: draft NN — … (#N spec)`).
4. Merge when CI is green (and manual Codex review if the user expects it).
5. `git pull` on `main`; **reopen** issue **#N** if GitHub auto-closed it on merge.

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
- Kill a running draft review to rush issue-body sync — wait for `NO_FINDINGS` or cap.
- Sync to GitHub before Codex review completes (unless 5-iteration cap with open questions recorded).
- Use `ao spawn` to publish a brand-new draft — it needs an existing issue and a
  fresh checkout, so it cannot create the issue or see the local draft. Use
  `opencode-publish.sh --dangerously-skip-permissions --dir .` with
  `OPENCODE_PUBLISH_INCLUDE` and a temp-file prompt (default path), or publish
  manually in a separate checkout (fallback).
- Pass `PUBLISH=no` to deepseek unless the user explicitly opted out of merge/PR —
  default is `PUBLISH=yes`; the full PR→CI→merge cycle runs by default for the
  create-task flow.
