---
name: create-issue-draft
description: Use when accepting a GPT-chat-authored task for `orchestrator-pack` — the user hands over a GitHub Issue link plus the browser-GPT authoring-chat link (or only a brief: GPT then authors and creates the Issue by default), and the architect runs the lens → fix → competitive → architectural-review → final-lens pipeline over it, with GPT applying every fix directly to the Issue. Covers chat topology (one task chat, fresh chat per competitive pass, one dedicated review chat), the six-axis architect lens, browser-turn mechanics via the cursor helper, mandatory issue-body floors (tier gate, fences, contract evidence, discipline guards), and the finding-disposition ledger. The Issue is the only task artifact — no local draft mirror, no queue-index row; working artifacts live in an out-of-repo workdir. Invoke on every new GPT-authored task. Do not invoke for tiny docs typos or rename-only refactors.
---

# create-issue-draft — GPT-chat authoring flow

Tasks are authored by the operator's **browser GPT** in the custom ChatGPT
project «orchestrator-pack». GPT creates the GitHub Issue and edits it directly
throughout the flow. The architect writes only the initial brief, runs review
and lens stages, ratifies finding dispositions, and enforces mechanical floors.

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
| GPT author in task chat | Spec content, every content fix, direct Issue edits | Review its own spec |
| Architect | Lens passes, stage ordering, evidence, floors, disposition ratification, acceptance | Author content fixes or bypass the task chat |
| Cursor helper | Execute the prepared browser command and return verbatim output + state | Write browser code, alter prompts, judge findings |
| Reviewer GPT chats | Competitive and architectural critique | Edit the Issue |
| Codex | Explicit wrapper pass, T3-critical independent pass, or recorded browser-outage substitution | Silently replace an available browser stage |

## Chat topology

| Stream | Chat | Lifetime |
|--------|------|----------|
| Authoring, fixes, finding relays | one **task chat** | whole flow |
| Competitive review | **fresh chat per pass** | one pass |
| Architectural review and final verification | one **dedicated review chat** | first architectural pass through final pass |
| Architect lenses | no browser chat | in-session |

Never review in the task chat, relay fixes anywhere except the task chat, reuse a
competitive chat, or create a second architectural-review chat.

## Pipeline

1. Intake: pull title/body, create workdir, recompute tier, run body floors.
2. Architect lens 1: six axes plus competitive directive.
3. Task-chat fix round; re-pull, diff, and rerun body floors.
4. Competitive stage when selected or explicitly requested, ≤3 fresh-chat passes.
5. Architectural review in one dedicated chat, per-tier ceiling.
6. Explicit Codex wrapper and/or T3-critical independent Codex pass when required.
7. Final architect lens, including the only sanctioned downgrade decision.
8. Exactly one final architectural pass after the latest final-lens capture.
9. Acceptance only over the current Issue revision with all floors and ledger green.

A review stage ends early on `NO_FINDINGS`. A capped exit is allowed only when
the cap applies and unresolved questions are recorded in the ledger/final report.

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
anchor path. This is load-bearing: the sync helper's tier validation uses
`process.cwd()` as its repository root and needs the tracked marker,
contract-evidence, manifest, and corpus files available there.

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

Pull the title every time because the tier prefix lives in it. Record task-chat
and review-chat URLs in `$REVIEW_DIR/chats.md`.

## Step 2 — Architect lens 1

Survey shipped and queued prior art before judging the approach. Delegate bulk
markdown reading when the `AGENTS.md` threshold applies; keep conclusions on the
reasoning model. Live Issue/PR state is read through the pack `scripts/gh`
wrapper.

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
reviewer chat -> architect -> task chat -> Issue edit -> re-pull
```

## Step 4 — Competitive review

Run when selected by tier/markers or forced by an explicit `discuss-with-gpt`
wrapper. T3 always runs it; T2 runs it when red-flagged or explicitly requested.
Only a direct operator decision may waive an otherwise selected non-critical
competitive stage, and the waiver is recorded.

Each pass:

1. open a fresh browser-GPT chat;
2. send a self-contained independent-review prompt, request an alternative
   decomposition, wrap the current Issue body as UNTRUSTED DATA between nonce
   markers, and demand plain `type:` finding lines outside code fences;
3. save verbatim as `pass-NN-competitive.capture.txt`;
4. normalize findings, relay accepted fixes through the task chat, re-pull, and
   rerun body floors.

Stop on a valid no-accepted-finding pass or at cap 3 with open questions recorded.
A browser outage may use a recorded stage-specific Codex substitution only when
the operator cannot restore the browser.

## Step 5 — Architectural review and Codex stages

Create one dedicated browser-GPT review chat on the first pass and reuse it. Each
pass carries the current Issue revision even though chat history exists. Save
verbatim as `pass-NN-architectural.capture.txt`, normalize findings, relay fixes,
re-pull, and rerun body floors. Ceiling: T1 one light pass, T2 ≤3, T3 ≤4.

### Explicit Codex wrapper

When brief-only `adversarial-draft-review` was explicitly requested, run its
cold Codex loop over the current anchor after browser-GPT architectural review
and before final lens. Preserve raw JSON as
`pass-NN-architectural.codex.json`; transcribe every finding 1:1 into plain
`type:` lines in `pass-NN-architectural.capture.txt`; relay accepted findings
through the task chat and rerun body floors. Cap: three passes under that skill's
convergence rule.

### T3-critical addition

T3-critical tasks require an independent Codex architectural pass over the
current post-GPT revision. The final required pass of an explicit wrapper loop
satisfies this once when it reviewed that same current revision; do not duplicate
it. The final lens must see all Codex findings.

### Codex unavailability

Availability is fail-closed:

- an explicit non-T3-critical wrapper blocks before final lens/acceptance until
  Codex is restored or the operator directly waives the requested extra stage;
  record the waiver in ledger notes and final report;
- the T3-critical Codex addition is mandatory and cannot be waived;
- when Codex was selected as a browser-outage substitute and is also unavailable,
  the replaced stage remains blocked.

Never call an unavailable/skipped Codex stage complete.

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

T3 always runs one; T1/T2 run one only when the final lens changed content. Use
the same dedicated review chat and current Issue revision. Save as
`pass-NN-architectural-final.capture.txt`.

If it finds issues:

```text
final finding -> task-chat fix -> re-pull -> newer final lens -> one new final pass
```

Preserve the failed final capture and ledger evidence. Never place two final
captures after the same latest lens. After the newer lens, exactly one newer
final may exist; this matches `stage-completeness-core.ts`.

## Step 8 — Acceptance

Acceptance requires, in order:

1. a clean final pass over the exact revision being accepted when the tier/flow
   requires a final pass;
2. body floors, stage completeness, and finding ledger green;
3. every typed finding normalized, protected findings addressed, capped risks
   recorded;
4. live Issue title prefix matching the final tier;
5. no required explicit wrapper or T3-critical Codex stage silently skipped;
6. report Issue URL, tier, pass counts, chat URLs, workdir, waivers, and risks.

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

- tier validation uses `process.cwd()` and therefore sees all trusted tracked
  contract-evidence and marker support files under `$REPO_ROOT`;
- stage completeness derives `$WORKDIR` from the absolute draft path;
- finding-ledger validation resolves `.review/<stem>` beside the absolute anchor.

The helper strips H1 + blank before syncing. Re-pull after every parity edit so
revision history remains gapless.

## Browser-turn mechanics

Use [`discuss-with-gpt`](../discuss-with-gpt/SKILL.md) as the canonical browser
mechanics source: logged-in dedicated automation Chrome, tracked driver
semantics, `--new-chat` for competitive passes, and `--chat-url` for task/review
turns. The Cursor helper executes a prepared command only.

Every review/amendment prompt is self-contained, carries the current Issue body
as UNTRUSTED DATA between nonce markers, and requests one outer `~~~markdown`
fence so inner backtick fences survive. Save each response verbatim before
interpretation. Use the documented long timeout/polling discipline. Non-success
states are reported, not improvised around.

A stage-specific Codex outage substitution preserves the replaced guard stage
name (`competitive`, `architectural`, or `architectural-final`), stores raw JSON
alongside the plain 1:1 finding transcription, and is recorded separately.

## Tier gate

Run at intake and on the final revision from the trusted repository root with an
absolute anchor path:

```bash
node scripts/tier-gate-guard.ts --text-file "$ANCHOR" --draft-path "$ANCHOR"
```

The marker screen is fail-closed. A red marker with a below-T3 assignment or a
skipped mandatory stage blocks acceptance; unparseable input becomes T3.

Tier stages:

- T1: no competitive stage; one light architectural pass; light final lens;
  final verification only after lens-driven content change.
- T2: competitive only when red-flagged or explicitly requested;
  architectural ≤3; light final lens; final verification only after lens-driven
  content change.
- T3: competitive ≤3; architectural ≤4; full final lens; exactly one final pass
  after the latest lens.
- T3-critical: T3 plus one mandatory independent Codex pass.

Explicit adversarial wrappers floor the effective tier at T2 and preserve their
requested stage. Upward recompute runs skipped stages. Downward movement occurs
only at final lens and never erases evidence.

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
9. mandatory `allowed-roots` fence, listing every allowed root even for
   multi-root or skip-line tasks.
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

Run body-only floors after every refreshed Issue revision. Run stage completeness
and finding-ledger at acceptance. Contract evidence stays rooted in the trusted
repository; only stage completeness receives `$WORKDIR` as its explicit derived
artifact root.

## Review artifacts and ledger

All durable audit artifacts remain outside the repository:

```text
chats.md
lens-01-architect.md
round-NN-author-reply.md
pass-NN-competitive.capture.txt
pass-NN-architectural.capture.txt
pass-NN-architectural.codex.json
pass-NN-architectural-lens.capture.txt
pass-NN-architectural-final.capture.txt
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

Codex raw JSON is provenance only; transcribe findings 1:1 into plain `type:`
lines because the ledger guard ignores fenced/raw JSON structure.

## Repository-write boundary

This flow creates no tracked draft mirror, queue-index row, capture, ledger, or
workdir file. The only permitted temporary in-repo write is the untracked
`.review-challenge/**` transport copy required by Codex `--scope working-tree`;
delete it immediately after the pass and never commit it.

Cross-Issue contract changes update every affected live Issue before acceptance
and land the corresponding architecture decision together. Durable decisions go
to the repository's architecture decision surface under its own scoped change.

## Don't

- Author content fixes from the architect seat.
- Review in the task chat or create the wrong chat topology.
- Trust a chat reply without a live Issue re-pull and diff.
- Run parity sync from `$WORKDIR`; use trusted repo cwd + absolute anchor.
- Omit `behavior-kind` or `allowed-roots` from any task/skip-line body.
- Skip a requested GPT/Codex stage silently.
- Waive the T3-critical Codex addition.
- Retry a final pass without a newer final-lens capture.
- Accept with stale captures/title, red floors, or incomplete ledger.
- Use raw `gh issue edit`; use the sanctioned body-sync helper for parity only.
- Commit workdir or `.review-challenge/**` artifacts.
- Hand-edit `.cursor/skills/**`; regenerate only when canonical frontmatter changes.
- Over-specify implementation details that belong to the planner.
