---
name: create-issue-draft
description: Use when accepting a GPT-chat-authored task for `orchestrator-pack` — the user hands over a GitHub Issue link plus the browser-GPT task-chat link (or only a brief: GPT then authors and creates the Issue by default), and the architect runs lens → task-chat fix → browser-GPT competitive → browser-GPT architectural review in one dedicated review chat → final lens → browser-GPT final verification when required. Covers Issue-only live task state, mixed-engine Codex additions/substitutions, T3-critical L4 classification and safety floors, browser-turn mechanics, issue-body guards, and the finding-disposition ledger. The Issue is the only live task artifact; audit artifacts live in an out-of-repo workdir. Invoke on every new GPT-authored task. Do not invoke for tiny typo, rename-only, or one-file mechanical CI fixes.
---

# create-issue-draft — GPT-chat authoring flow

Tasks are authored by the operator's **browser GPT** in the custom ChatGPT
project «orchestrator-pack». GPT creates the GitHub Issue and edits it directly
throughout the flow. The architect writes the initial brief, runs review and lens
stages, ratifies finding dispositions, and enforces mechanical floors.

The **GitHub Issue is the only live task artifact and queue entry**. Pulled
revisions, captures, chat URLs, and the finding ledger live in an out-of-repo
workdir and are never committed. `docs/issues_drafts/**` and
`docs/issue_queue_index.md` are read-only prior art for this flow.

## Inputs and routing

Normal intake provides:

1. the GitHub Issue URL or number;
2. the browser-GPT task-chat URL.

**Brief-only entry.** With no Issue/chat yet, compose a self-contained brief
(problem/goal, advisory tier prior, constraints, out-of-scope, verified grounding
pointers) and open one new browser-GPT chat. That chat becomes the task chat;
GPT authors the spec against the floors below and creates the Issue. The first
body line becomes `GitHub Issue: #N` once known. The architect does not author
the spec unless the browser is unavailable and the operator cannot restore it;
record that fallback explicitly.

Explicit wrapper routing is preserved:

- brief-only `discuss-with-gpt` floors the effective tier at T2 and requires the
  requested browser-GPT competitive stage before acceptance;
- brief-only `adversarial-draft-review` floors the effective tier at T2 and
  requires the requested Codex loop before the final lens and acceptance.

Skip only typo, rename-only, or one-file mechanical CI changes that genuinely
qualify for the below-ladder skip line.

## Roles

| Party | Owns | Must not do |
|-------|------|-------------|
| GPT author in task chat | Spec content, every content fix, direct Issue edits, proposed dispositions | Review its own spec |
| Architect | Lens passes, stage ordering, evidence, floors, disposition ratification, acceptance | Author normal content fixes or bypass the task chat |
| Cursor helper | Execute the prepared browser command and return verbatim output + state | Write browser code, alter prompts, judge findings |
| Competitive GPT chats | Independent critique in a fresh chat per pass | Edit the Issue, reuse a prior competitive chat, or replace architectural review |
| Dedicated architectural GPT chat | Every browser-GPT architectural turn, including final verification | Edit the Issue, share the task chat, or be replaced silently |
| Codex | T3-critical independent addition; recorded browser-outage substitution; explicit requested adversarial loop | Become the default architectural engine or be credited for a stage it did not run |

## Chat topology

| Stream | Chat | Lifetime |
|--------|------|----------|
| Authoring, fixes, finding relays | one **task chat** | whole flow |
| Competitive review | **fresh chat per pass** | one pass |
| Architectural review and final verification | one **dedicated browser-GPT review chat** | whole flow |
| Codex additions/substitutions | no browser chat | one cold invocation per pass |
| Architect lenses | no browser chat | in-session |

Never review in the task chat, relay fixes anywhere except the task chat, reuse a
competitive chat, create a replacement architectural chat after a Codex
substitution, or merge distinct conversations into one tab/chat identity.

## Pipeline

1. Intake: pull title/body, create workdir, recompute tier, run body floors.
2. Architect lens 1: six axes plus competitive directive.
3. Task-chat fix round; re-pull, diff, and rerun body floors.
4. Browser-GPT competitive stage when selected or explicitly requested, ≤3 fresh-chat passes.
5. Browser-GPT architectural review in one dedicated review chat, using the per-tier ceiling.
6. Additional explicit Codex wrapper loop when requested; mandatory independent Codex addition for T3-critical tasks; recorded Codex substitution only for browser outage.
7. Final architect lens, including the only sanctioned downgrade decision.
8. One browser-GPT final architectural pass after the latest final-lens capture when the tier/flow requires it.
9. Acceptance only over the current Issue revision with all floors and ledger green.

Ordinary architectural review ends early on a clean pass with no findings.
Competitive and explicit adversarial loops use their own documented
no-accepted-finding convergence rules. A capped exit is allowed only when the
cap applies and unresolved questions are recorded in the ledger/final report.

## Step 1 — Intake and workdir

Task identity is `<N>-<slug>`. Create:

```text
~/.local/state/create-issue-draft/<N>-<slug>/       # $WORKDIR
  docs/issues_drafts/<N>-<slug>.md                  # $ANCHOR
  docs/issues_drafts/.review/<N>-<slug>/            # $REVIEW_DIR
  r01/ r02/ …                                       # immutable pulled revisions
```

No repository support files are copied into `$WORKDIR`. Repository-owned guards
and the sync helper run from a trusted checkout root and receive the **absolute**
anchor path. The sync helper's tier validation uses `process.cwd()` as its
repository root and needs tracked marker, contract-evidence, manifest, and corpus
files available there.

The anchor is draft-shaped, not a raw body:

1. line 1: `# <live Issue title>`;
2. line 2: blank;
3. remaining lines: live Issue body verbatim.

Pull every revision through the pack wrapper and preserve an immutable copy:

```bash
WORKDIR="$HOME/.local/state/create-issue-draft/<N>-<slug>"
ANCHOR="$WORKDIR/docs/issues_drafts/<N>-<slug>.md"
mkdir -p "$(dirname "$ANCHOR")" "$WORKDIR/rNN" "$WORKDIR/docs/issues_drafts/.review/<N>-<slug>"
scripts/gh api repos/chetwerikoff/orchestrator-pack/issues/<N> \
  --jq '"# " + .title + "\n\n" + .body' > "$WORKDIR/rNN/<N>-<slug>.md"
cp "$WORKDIR/rNN/<N>-<slug>.md" "$ANCHOR"
```

Pull the title every time because the tier prefix lives in it. Record the task
chat, every competitive chat, and the one dedicated architectural-review chat in
`$REVIEW_DIR/chats.md`. Record Codex invocations separately; they have no browser
chat URL.

## Step 2 — Architect lens 1

Survey shipped and queued prior art before judging the approach. Delegate bulk
markdown reading when the `AGENTS.md` threshold applies; keep conclusions on the
reasoning model. Live Issue/PR state is read through the pack `scripts/gh` wrapper.

Answer all six axes with evidence:

1. **Фактическая исполнимость** — prove every upstream contract/file/flag.
2. **Подход к цели** — compare alternatives, cost, prior art, and one-PR sizing.
3. **Причинно-следственные связи** — prove cause→effect and fix the class, not case.
4. **Оверинженерия — что упростить** — identify disproportionate machinery.
5. **Что НЕ упрощать** — preserve requirements, safety floors, and accepted findings.
6. **Что пропустили** — missing ACs, evidence, adoption, rollback, or verification.

Write `$REVIEW_DIR/lens-01-architect.md` with numbered `fix-required`,
`recommend`, or `question` items and `competitive: yes|no` plus tier basis.
Architect-lens findings are relayed for fixing but are not reviewer-ledger rows.

## Step 3 — Task-chat fix round

Send the verdict to the one task chat with instructions to address each finding
or reject it with a concrete reason, edit the GitHub Issue directly, and return a
change summary plus dispositions. Security/scope findings follow the protected
rules below.

Save the reply verbatim as `round-NN-author-reply.md`, re-pull title/body into a
new immutable revision, and diff it. A reply without an Issue edit is unfinished.
Run body-only floors on the refreshed anchor. Findings always flow:

```text
reviewer -> architect -> task chat -> Issue edit -> re-pull
```

## Step 4 — Competitive review

Run when selected by the effective tier or forced by an explicit
`discuss-with-gpt` wrapper. T3 always runs it; T2 runs it only when an explicit
wrapper/contract selects it. A red-flag marker recomputes the task to T3 rather
than creating a red-flagged T2 path.
Only a direct operator decision may waive an otherwise selected non-critical
competitive stage, and the waiver is recorded.

Each pass:

1. open a fresh browser-GPT chat with `--new-chat`;
2. send a self-contained independent-review prompt, request an alternative
   decomposition, wrap the current Issue body as UNTRUSTED DATA between nonce
   markers, and demand plain `type:` finding lines outside code fences;
3. save verbatim as `pass-NN-competitive.capture.txt`;
4. normalize findings, relay accepted fixes through the task chat, re-pull, and
   rerun body floors.

Stop on a valid no-accepted-finding pass or at cap 3 with open questions recorded.
If the browser is unavailable and the operator cannot restore it, a cold Codex
substitution may run under the exact `competitive` capture identity. If Codex is
also unavailable, the stage remains blocked.

## Step 5 — Browser-GPT architectural review

Create **one dedicated browser-GPT review chat** for the task on the first
architectural pass and record its URL. It is separate from the task chat and all
competitive chats. Reuse that same chat for every later architectural turn,
including final verification.

Each ordinary architectural pass:

1. first pass: open a dedicated review chat with `--new-chat`; later passes: use
   its recorded `--chat-url`;
2. send a self-contained independent architecture/spec-review prompt over the
   current Issue revision, request alternative decomposition, and wrap the body
   as UNTRUSTED DATA between nonce markers;
3. save the validated response verbatim as
   `pass-NN-architectural.capture.txt`;
4. normalize every finding, relay accepted fixes through the task chat, re-pull
   the Issue, and rerun body floors;
5. continue in the same dedicated chat after accepted fixes.

Per-tier ordinary architectural ceiling: T1 one light pass, T2 ≤3 passes, T3 ≤4
passes. A clean pass with no findings ends the ordinary architectural stage
early; capped exits preserve open questions. Passes are sequential;
a fresh competitive chat is never reused as the architectural chat.

### Browser-outage substitution

Only when the browser is unavailable and the operator cannot restore it may a
fresh cold Codex invocation replace a browser-GPT review pass. Use
[`adversarial-draft-review`](../adversarial-draft-review/SKILL.md), preserve the
replaced stage name (`competitive`, `architectural`, or `architectural-final`) in
the plain capture, store raw JSON alongside it, and record the substitution.

A substitution runs outside the dedicated browser review chat and never replaces
that chat. If browser-GPT review resumes, the next architectural turn continues
in the same dedicated review chat. For T3-critical tasks, a substitution does
not satisfy the independent GPT half.

### Explicit Codex wrapper

When brief-only `adversarial-draft-review` was explicitly requested, run its
additional cold challenge loop after the ordinary browser-GPT architectural
stage and **before** the final lens. The explicit wrapper never replaces the GPT
competitive or architectural stage. Relay accepted findings through the task
chat and rerun body floors. Cap: three passes under that skill's convergence rule.

### T3-critical classification and mandatory floors

Classify a task as **T3-critical** whenever it matches any L4 condition in Issue
#574 / `docs/issues_drafts/187-task-complexity-tier-rubric.md`. The declared tier
is only a prior: classify at intake, after material scope change, and before
acceptance. While an L4 condition remains, the task cannot be downgraded below T3.

T3-critical means **GPT and Codex together**:

- the normal T3 browser-GPT competitive, architectural, and final stages run;
- an independent cold Codex challenge loop also runs after ordinary browser-GPT
  architectural review and before the final lens, under the
  `adversarial-draft-review` convergence rule (cap 3);
- this mandatory addition is independent of any explicitly requested Codex loop;
- a Codex outage substitution does not satisfy the GPT half.

T3-critical also adds two non-waivable Issue-body floors:

- an explicit rollback or migration note appropriate to the change, including
  the safe reversal/transition boundary and operator action when applicable;
- realistic acceptance criteria and matching verification for every material
  crash, race, or stale-state failure class.

The final architect lens re-checks the L4 classification and both floors. Missing
classification evidence, rollback/migration coverage, realistic failure-mode
verification, qualifying GPT participation, or the independent Codex addition
blocks acceptance.

### Codex availability

Availability is fail-closed:

- the T3-critical independent Codex addition is mandatory and cannot be waived;
- an additional explicit non-T3-critical wrapper blocks until Codex is restored
  or the operator directly waives only that extra wrapper stage; record the
  waiver in ledger notes and final report;
- when Codex is selected as a browser-outage substitute and is unavailable, the
  replaced browser stage remains blocked.

Never call an unavailable or skipped required stage complete.

## Step 6 — Final architect lens

Run at every tier. T1/T2 use a light delta checklist; T3 records a full
per-mechanism keep/cut decision. Review overengineering and missed items first,
then verify no accepted finding or brief requirement was watered down.

The final lens is the **only** sanctioned tier-downgrade point. Recompute against
the final body; downgrade only when the higher-tier drivers are gone and the
marker screen is clear. Update title/fence through the task chat and rerun the
tier gate. Prior captures and ledger rows remain valid and are never waived.

Save the guard-recognized capture as
`pass-NN-architectural-lens.capture.txt`, with detailed analysis in
`presync-architect-lens.md`. A fix-required result returns to the task chat and
then reruns this lens as a new delta capture.

## Step 7 — Final architectural pass

T3 always runs one; T1/T2 run one only when the final lens changed content. Run
the pass in the same dedicated browser-GPT review chat using its `--chat-url` and
save the validated response as `pass-NN-architectural-final.capture.txt`.

If the browser is unavailable and the operator cannot restore it, a cold Codex
substitution may use the same `architectural-final` capture identity with raw JSON
provenance. For T3-critical tasks, that substitution does not satisfy the GPT half.

If the final pass finds issues:

```text
final finding -> task-chat fix -> re-pull -> newer final lens -> one new final pass
```

Preserve the failed final capture and ledger evidence. Never place two final
captures after the same latest lens. After the newer lens, exactly one newer
final may exist; this matches `stage-completeness-core.ts`.

## Step 8 — Acceptance

Acceptance requires, in order:

1. a clean final pass over the exact revision being accepted when required;
2. body floors, stage completeness, and finding ledger green;
3. every typed finding normalized, protected findings addressed, capped risks recorded;
4. live Issue title prefix matching the final tier;
5. no selected browser-GPT stage skipped except through a permitted recorded
   outage substitution;
6. every mandatory T3-critical Codex addition complete, and every explicit wrapper
   complete or explicitly waived only where allowed;
7. report Issue URL, tier, pass counts, task/review/competitive chat URLs, workdir,
   substitutions, waivers, T3-critical classification result, and risks.

Two non-converging `fix -> newer lens -> final` cycles escalate to the operator.

## Mechanical parity edits

Only mechanical format defects such as fence syntax or header shape may be fixed
by the architect in the workdir anchor. Content fixes belong to the GPT author.

Run the sync helper from the **trusted repository root**, never from `$WORKDIR`,
and pass an **absolute** anchor path:

```bash
REPO_ROOT=/abs/path/to/trusted/orchestrator-pack
ANCHOR="$WORKDIR/docs/issues_drafts/<N>-<slug>.md"
cd "$REPO_ROOT"
node scripts/publish-issue-body-sync.ts edit \
  --draft-path "$ANCHOR" \
  --issue-number <N> \
  --repo chetwerikoff/orchestrator-pack
node scripts/publish-issue-body-sync.ts verify \
  --draft-path "$ANCHOR" \
  --issue-number <N> \
  --repo chetwerikoff/orchestrator-pack
```

Why this works:

- tier validation uses `process.cwd()` and therefore sees tracked contract-evidence
  and marker support files under `$REPO_ROOT`;
- stage completeness derives `$WORKDIR` from the absolute draft path;
- finding-ledger validation resolves `.review/<stem>` beside the absolute anchor.

The helper strips H1 + blank before syncing. Re-pull after every parity edit so
revision history remains gapless.

## Browser-turn mechanics

Use [`discuss-with-gpt`](../discuss-with-gpt/SKILL.md) as the canonical browser
mechanics source for all browser streams:

- **task chat:** use its recorded `--chat-url` for authoring/fix turns;
- **competitive:** use `--new-chat` for every pass;
- **architectural:** create one dedicated review chat, record its URL, then use
  that `--chat-url` for every later architectural and final turn.

The three streams are distinct conversations. Tab reuse prevents duplicate tabs
for one conversation; it never authorizes sharing task, competitive, and
architectural contexts. The Cursor helper executes a prepared browser command only.

Every review/amendment prompt is self-contained, carries the current Issue body
as UNTRUSTED DATA between nonce markers, and requests one outer `~~~markdown`
fence so inner backtick fences survive. Save each response verbatim before
interpretation. Use the documented long timeout/polling discipline. Non-success
states are reported, not improvised around.

A Codex browser-outage substitution is permitted only after recorded browser
unavailability when the operator cannot restore it. Preserve the replaced stage
capture name, store raw JSON alongside the plain 1:1 finding transcription, and
record the substitution.

## Tier gate

Run at intake and on the final revision from the trusted repository root with an
absolute anchor path:

```bash
node scripts/tier-gate-guard.ts --text-file "$ANCHOR" --draft-path "$ANCHOR"
```

The marker screen is fail-closed. A red marker with a below-T3 assignment or a
skipped mandatory stage blocks acceptance; unparseable input becomes T3.

Tier stages:

- T1: no competitive stage; one light browser-GPT architectural pass; light final
  lens; one browser-GPT final verification only after lens-driven content change.
- T2: no competitive stage unless an explicit wrapper/contract selects it;
  browser-GPT architectural ≤3; light final lens; one browser-GPT final
  verification only after lens-driven content change.
- T3: browser-GPT competitive ≤3; browser-GPT architectural ≤4; full final lens;
  exactly one browser-GPT final pass after the latest lens.
- T3-critical: run the full T3 GPT flow plus the independent Codex addition and
  require rollback/migration plus realistic crash/race/stale-state floors.

Explicit adversarial wrappers floor the effective tier at T2 and preserve their
requested stage. Upward recompute runs skipped stages. Downward movement occurs
only at final lens and never erases evidence.

### T3-critical floor details

The L4 classification is independent of the literal `complexity-tier` fence. At
intake and final recompute, cite the matched L4 condition(s) in the architect
record. An L4 task is not acceptance-ready unless the live Issue contains:

1. a rollback/migration note describing the safe rollback or migration boundary,
   data/state compatibility, and required operator action; and
2. numbered acceptance criteria plus matching verification that exercise every
   material crash, race, and stale-state class with realistic inputs.

These are additive to all never-skipped worker-safety, behavior-kind,
contract-evidence, stage-completeness, finding-ledger, qualifying GPT, and
independent Codex floors. They are not satisfied by a generic risk paragraph, a
happy-path unit test, or a waiver.

## Mandatory Issue-body floors

The Issue body must use this order:

1. **Prerequisite** — blocking and already-landed prior art, cited by Issue number.
2. **Goal** — observable outcome, not implementation method.
3. mandatory `behavior-kind` fence: `action-producing` or `record-only`.
4. mandatory `complexity-tier` fence.
5. **Binding surface** — observable contracts and operator adoption; preserve
   planner freedom over names, signatures, layout, and library choice.
6. **Files in scope**.
7. **Files out of scope**.
8. mandatory `denylist` fence.
9. mandatory `allowed-roots` fence, listing every allowed root.
10. **Acceptance criteria** — numbered, observable, testable.
11. **Upgrade-safety check**.
12. **Verification** mapped to acceptance criteria.
13. `contract-evidence` fence or explicit `contract-evidence: none` form accepted
    by the repository validator.

### Required fence examples

Every task declares one behavior kind:

```behavior-kind
record-only
```

or:

```behavior-kind
action-producing
```

Action-producing tasks also include a realistic positive outcome:

```positive-outcome
asserts: <observable action on realistic input>
input: realistic
```

Worker-safety fences are always present:

```denylist
vendor/**
packages/core/**
```

```allowed-roots
<first allowed root>
<second allowed root when applicable>
```

`allowed-roots` is not optional merely because scope spans multiple roots; list
the finite union. Broad `.`/`**/*` roots require explicit justification and
remain subject to scope discipline.

The complexity fence is exactly one of:

```complexity-tier
tier: T2
advisory-prior: T2
```

or, for a genuine below-ladder input:

```complexity-tier
skip-line: true
```

The title/H1 carries `[T1]`, `[T2]`, or `[T3]`; skip-line inputs omit a prefix.

### Discipline details

- External-tool positive outcomes use `input: external-tool-output` plus
  capture-backed provenance (or allowed golden-sample provenance).
- Deferred causes require a complete `parked-root-cause` fence with an existing
  follow-up Issue.
- Every upstream datum in Binding surface, ACs, or Verification is grounded in
  `contract-evidence`; belief/self-attestation is inadmissible.
- Capture-backed evidence rows use stable binding id/type, producer,
  selector/token, expected behavior, and repository manifest provenance.

## Mechanical floor commands

Run from trusted repository root with absolute `$ANCHOR`:

```bash
node scripts/tier-gate-guard.ts --text-file "$ANCHOR" --draft-path "$ANCHOR"
node scripts/draft-discipline.mjs positive-outcome --draft "$ANCHOR"
node scripts/draft-discipline.mjs parked-root --draft "$ANCHOR"
node scripts/draft-discipline.mjs contract-evidence --draft "$ANCHOR"
node scripts/stage-completeness-guard.ts \
  --text-file "$ANCHOR" --draft-path "$ANCHOR" --repo-root "$WORKDIR"
node scripts/finding-ledger-guard.mjs \
  --ledger "$REVIEW_DIR/finding-disposition-ledger.json" \
  --captures-dir "$REVIEW_DIR" \
  --draft-path "$ANCHOR"
```

Run body-only guards after every Issue revision. Stage completeness and the
finding-ledger guard run at acceptance. Contract evidence uses tracked manifests
from the trusted repository root; stage completeness alone receives the workdir
as repo root to locate out-of-repo captures.

## Finding ledger

Every reviewer capture is immutable evidence. The ledger records a stable id,
summary, type (`security`, `scope-violation`, `spec`, `quality`, `test`, `ci`),
disposition, and reject reason when applicable.

- Accepted/partial findings are fixed through the task chat.
- Rejected non-protected findings need a proportionality reason tied to blast
  radius, reversibility, failure impact, and a cheaper sufficient alternative.
- Security and scope-violation findings cannot be rejected; address them with
  real defense/evidence or obtain explicit operator risk acceptance.
- `NO_FINDINGS` never erases prior findings.
- Capped exits preserve unresolved questions in the ledger and final report.

## Review artifacts

All durable audit artifacts remain outside the repository:

```text
chats.md
lens-01-architect.md
round-NN-author-reply.md
pass-NN-competitive.capture.txt
pass-NN-architectural.capture.txt
pass-NN-architectural.codex.json        # only when a Codex role runs
pass-NN-architectural-lens.capture.txt
pass-NN-architectural-final.capture.txt
pass-NN-architectural-final.codex.json  # only when Codex substitutes
presync-architect-lens.md
finding-disposition-ledger.json
```

Pass numbers form one chronological sequence. Guard-recognized stages are
`competitive`, `architectural`, `architectural-lens`, and
`architectural-final`. Capture every reviewer response before editing.

Every typed finding receives a stable id, summary, type, disposition, and reason
when rejected. Reworded findings retain identity. `NO_FINDINGS` never erases
older findings. Security and scope-violation findings close only as addressed by
real defense/evidence or explicit operator risk acceptance; never silently omit
or reject them.

Codex raw JSON is provenance only; whenever Codex runs, transcribe findings 1:1
into the plain capture for the stage because the ledger guard ignores fenced/raw
JSON structure.

## Repository-write boundary

This flow creates no tracked draft mirror, queue-index row, capture, ledger, or
workdir file. The only permitted temporary in-repo write is an untracked
`.review-challenge/**` transport copy when a Codex role requires
`--scope working-tree`; delete it immediately after the pass and never commit it.

Cross-Issue contract changes update every affected live Issue before acceptance
and land the corresponding architecture decision together. Durable decisions go
to the repository's architecture decision surface under their own scoped change.

## Don't

- Author normal content fixes from the architect seat.
- Review in the task chat.
- Reuse a competitive chat or create more than one architectural-review chat.
- Let Codex become the default architectural engine or claim a substitution
  without recorded browser unavailability.
- Trust a chat reply without a live Issue re-pull and diff.
- Run parity sync from `$WORKDIR`; use trusted repo cwd + absolute anchor.
- Omit `behavior-kind` or `allowed-roots` from any task/skip-line body.
- Skip a requested GPT/Codex stage, a selected browser-GPT stage, or the mandatory
  T3-critical Codex addition silently.
- Let a T3-critical Codex substitution satisfy the GPT half.
- Miss the Issue #574 L4 classification or waive/dilute rollback/migration and
  crash/race/stale-state floors.
- Retry a final pass without a newer final-lens capture.
- Accept with stale captures/title, red floors, or incomplete ledger.
- Use raw `gh issue edit`; use the sanctioned body-sync helper for parity only.
- Commit workdir or `.review-challenge/**` artifacts.
- Hand-edit `.cursor/skills/**`; regenerate only when canonical frontmatter changes.
- Over-specify implementation details that belong to the planner.
