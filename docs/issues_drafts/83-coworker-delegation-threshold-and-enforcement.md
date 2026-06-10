# Coworker delegation: recalibrate ask-thresholds and add a stop-time read-delegation audit

GitHub Issue: #255

## Prerequisite

- `prompts/agent_rules.md` — canonical Coworker CLI delegation policy (single
  source of truth; this issue edits the threshold numbers and adds an
  enforcement-contract pointer).
- `docs/issues_drafts/52-coworker-cli-delegation-policy.md` (GitHub #148) —
  origin of the ask-triggers; this issue recalibrates them, it does not
  re-derive the policy.
- `docs/issues_drafts/68-rtk-net-savings-source-segmented.md` (GitHub #199) —
  the RTK shell-passthrough enforcement surface; this issue is the *read*-side
  analogue (RTK gates shell; this adds a read-delegation audit).

## Goal

Raise real coworker read-delegation from its current near-zero rate without
breaking legitimate in-session reads. A one-week audit measured ~5% compliance:
~180 questions fired an ask-trigger, 10 were delegated; ~70% of the missed
volume came from Cursor AO workers, which delegated **zero** times. Two
independent levers move different things: the *norm* (when delegation is owed)
and *enforcement* (what happens when it is not done). Lowering the norm alone
does not move behaviour — agents already ignore the existing MUST. This issue
delivers **Phase 1**: recalibrated norm thresholds **plus** a stop-time
delegation **audit** that flags non-compliant bulk reads on both surfaces, and
**emits the measurement** a later hard-block decision would need. A pre-read
*hard block* (Phase 2) is **deferred to a follow-up** authored with that data —
see **Deferred: Phase 2**. The measured savings are small (~$5–10/week), so the
expensive, false-positive-prone hard block is not pre-committed; the cheap,
reversible, both-surface audit ships first.

```behavior-kind
action-producing
```

## Design analysis

### Critical mechanics

Enforcement timing is the crux. A pre-read hook fires **before** the read, so at
decision time it cannot know intent — a read-for-edit and a delegable bulk read
look identical, and a hard block there mis-fires and invites sub-threshold-chunk
evasion. Intent is **more** knowable after the fact: at agent completion
(`stop`), the whole work unit is visible — whether the read was followed by an
edit, whether the status declared a delegation or excepted reason, and the
*aggregate* read volume across repeated reads (so chunking is visible where a
per-call gate is blind). Phase 1 therefore enforces at `stop`.

**The audit is a tolerant signal, not a verdict with teeth.** Post-hoc
classification is still imperfect — an agent may read file A (call sites, tests,
configs) and edit file B, or read and decide no edit is needed. The design does
**not** require perfect intent classification. Its consequence is a **surfaced
compliance finding**, never a block; false positives are acceptable because the
cost of a wrong flag is a review note, not stopped work. That tolerance is what
lets an imperfect heuristic carry the enforcement of record. Two distinct
concepts must not be conflated:

- **Not flagged** (legitimate outcome of a delegable obligation): the read was
  delegated; it was followed by an edit of *any* file in the same work unit; or
  the status states an excepted reason (reasoning step, no-op with evidence).
  These units **remain in the denominator** — they are obligations that were
  met or legitimately exempt, i.e. the compliant share of the rate.
  **«Delegated» must be machine-observed, not self-attested:** it counts only
  when a `coworker ask --profile code` invocation (or coworker-log record) is
  tied to the same work-unit key — status text claiming delegation with no
  observed coworker event is **not** compliant (it is flagged, or reported as a
  degraded/unverifiable unit). Otherwise a non-compliant agent could self-mark a
  missed bulk read as delegated and deflate the residual.
- **Excluded from the denominator** (never a delegable obligation at all): the
  read is **code-class** (behind the `--allow-code` gate — source code is not
  freely delegable) or part of a **reviewer-path session** (`PACK_REVIEWER` /
  `REVIEW_COMMAND`, never delegated). These are dropped from both the flag and
  the trigger-firing denominator.

So the denominator is **every fence-clean, delegable work unit whose aggregate
reads fired a trigger** — flagged plus not-flagged alike; only non-delegable
units are excluded. This lets Phase 2 distinguish "1 miss in 100 obligations"
from "1 miss in 1 candidate." A unit is a candidate **flag** only when it is a
delegable, trigger-firing unit with none of the not-flagged outcomes above.

### Work-unit boundary (observable definition)

All Phase-1 aggregation, edit-exemption, and chunking detection key off a
**work unit**, defined in hook-visible terms so the verdict is deterministic:
the span of tool calls the `stop`/completion hook observes for **one inbound
request** — a single user message or one AO task/message delivery — bounded by
the next inbound request. Two independent questions in one session are two work
units; one question split across many reads is one. This boundary is part of the
contract (not planner-chosen), and is fixture-pinned (see Acceptance criteria).

### Architecture sketch

```
                 norm (agent_rules.md)            soft: "delegate from 400 lines"
                         |
   reads happen ─────────┼────────────────────────────────────────────────
                         |   (no pre-read block in Phase 1)
   ... work unit: reads + edits accumulate, bounded by next inbound request ...
                         |
   [B] stop-time AUDIT         fires on completion with full work-unit context:
       (Claude Stop hook,      AGGREGATES reads per work unit (anti-chunking),
        Cursor stop hook)      flags aggregate volume that fired a trigger, was
                               not delegated, not followed by any edit in the
                               unit, status states no excepted reason. Emits a
                               tolerant compliance signal + the Phase-2 metrics.
   - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   [A] pre-read HARD BLOCK     DEFERRED to a follow-up (Phase 2), gated on the
                               measurement [B] emits. Not in this issue's scope.
```

### Detection parity (surface contract)

Both Claude Code sessions and Cursor AO workers must **flag the same
equivalence classes** via the audit, which runs on both surfaces (Claude `Stop`
hook, Cursor `stop` hook). The audit is the enforcement of record and runs
everywhere, so neither surface — not even the 70%-of-volume Cursor surface — is
left unenforced. (The deferred Phase-2 hard block is a per-surface optimization
where a pre-read hook supports deny; it does not change the audit parity.)

### Options considered (cost / risk / sufficiency)

| Option | Cost | Risk | Verdict |
|---|---|---|---|
| **A. Lower thresholds only, no enforcement** | ~0 (rule edit) | Audit shows the existing MUST is ignored at all thresholds | **Reject** — does not raise usage |
| **B. Hard pre-read block at the norm floor, both surfaces, now** | medium-high | High — blocks read-for-edit (unknowable at read time), invites chunk evasion, false positives erode trust; Cursor deny unproven; numeric go/no-go unsettable without data | **Reject** — fragile and premature |
| **C. Lower norm + stop-time audit (both surfaces) now; hard block deferred to a data-gated follow-up (chosen)** | low–medium | Low — audit flags (never blocks), tolerant of imperfect classification; both surfaces; emits the metric the Phase-2 decision needs | **Chosen** — cheapest design that raises usage and is honest about the marginal ROI |
| **D. Soft context-reminder nudge only** | low | Ignorable like the current MUST; will not move Cursor workers | **Reject** — insufficient |

Chosen: **C**. A and D lose on sufficiency; B loses on risk and on committing an
expensive mechanism with unproven feasibility and an unsettable gate before the
measurement exists.

### Equivalence-class enumeration (aggregate read × outcome)

The audit decision is an event-ordering decision; it must target the class, not
one case. Dimensions: aggregate read per work unit {below-floor, near-floor,
well-above, cumulative-sub-floor-chunks}, outcome {edit-same-file,
edit-other-file-in-unit, no-edit-no-reason, no-op-with-evidence, delegated,
bypassed}, surface {Claude, Cursor}. Expected **flag** outcome — the build must
satisfy all rows as fixtures:

| Aggregate read | Outcome | Audit verdict |
|---|---|---|
| below-floor | any | never flagged |
| near-floor or above | edit same file | not flagged (read-for-edit) |
| near-floor or above | edit other file in unit | not flagged (cross-file edit prep) |
| near-floor or above | no edit, no excepted reason | **flagged** (delegable, not delegated) |
| near-floor or above | no-op-with-evidence in status | not flagged (excepted reasoning) |
| near-floor or above | delegated | not flagged |
| **cumulative sub-floor chunks** summing past floor | no edit, no reason | **flagged** (aggregate fired the trigger — anti-chunking row) |
| two independent questions, each sub-floor | per-unit | each evaluated **separately**; neither flagged (work-unit boundary row) |
| well-above | read is **code-class** (`--allow-code`-gated) | not flagged; **excluded from denominator** (not freely delegable) |
| well-above | session is **reviewer-path** (`PACK_REVIEWER`/`REVIEW_COMMAND`) | not flagged; **excluded from denominator** (review never delegated) |
| **>200-line diff/log** (distinct trigger, below the 400 file-read floor) | no edit, no reason | **flagged**, counted in the denominator (the diff/log trigger fires independently of T1; delegated/edit/excepted/non-delegable follow the same denominator rules) |

Both surfaces must produce the **same** verdict for each row (detection parity).

## Binding surface

This issue commits the repository to:

1. **Recalibrated norm thresholds** in the `prompts/agent_rules.md` Coworker
   CLI delegation section:
   - **T1 (single-question volume floor):** lowered from **600** to **400**
     lines. (Chosen from the audit economics: 400 is the single value whose
     per-call expected saving clears the delegation break-even on **both** the
     Opus/Fable and the Sonnet/worker surface with margin.)
   - **T2 (file-count trigger):** the «≥3 files» trigger MUST additionally
     require **≥400 combined lines**, or be folded into T1. Pure file-count with
     a trivial line total no longer fires (the audit found this class generated
     ~60% of worker obligations at near-zero per-call value).
   - **Diff/log 200-line trigger:** unchanged.
   - **Bootstrap (2+ paths >600 lines) trigger:** folded into T1 (no separate
     clause) unless the planner shows it covers a case T1 misses.
   - Keep the sub-floor «do not delegate below the floor» rule and the
     `--allow-code` gate unchanged.

2. **A stop-time read-delegation audit contract** (new doc/section the rules
   point to), **mechanism-agnostic** (planner picks hook internals, language,
   file layout), with these invariants:
   - **Both surfaces:** the audit runs on Claude sessions (`Stop`) and Cursor AO
     workers (`stop`), producing the same flag verdict per equivalence class.
   - **Trigger coverage:** the audit evaluates **every** norm trigger that the
     recalibrated rules keep, not only the T1 file-read floor — at minimum the
     **>200-line diff/log** trigger, which fires (and counts toward the
     denominator) **independently of T1** at its own 200-line floor, so a
     sub-400-line diff/log that fired the policy is not undercounted. If the
     rules retain a distinct T2 file-count trigger (rather than folding it into
     T1), the audit covers it too; if T2 is folded into T1, there is no separate
     T2 to cover.
   - **Work-unit aggregation:** reads aggregate per work unit (defined above);
     cumulative sub-floor chunks that sum past the floor are caught.
   - **Tolerant signal, not a block:** the audit emits a surfaced compliance
     finding; it never blocks a read. **Not-flagged** (but still counted in the
     denominator) outcomes: edit-of-any-file-in-unit, excepted-reason-in-status,
     and **machine-observed** delegation (a `coworker ask --profile code`
     invocation / coworker-log record tied to the work-unit key — self-attested
     delegation in status text without an observed coworker event does not
     count). **Excluded from the denominator** (never a delegable obligation):
     code-class (`--allow-code`-gated) and reviewer-path session.
   - **Metric emission for the deferred Phase 2:** the audit emits, per adoption
     window, residual non-compliance = **flagged work units ÷ all fence-clean,
     delegable work units that fired a trigger** (the denominator includes
     delegated and not-flagged-exempt units; it excludes only non-delegable
     code-class/reviewer-path units), plus the count/volume of flagged reads
     **and the per-surface audit error / missing-window counts**, so the later
     hard-block decision is made on a true compliance rate that cannot be faked
     clean by a silently-dropped audit.
   - **Durable, idempotent emission under concurrency:** AO runs many workers in
     parallel, so multiple `stop` hooks write the metric artifact at once. Each
     audited work unit MUST have a **stable key**, writes MUST be atomic or
     append-only under concurrency (no lost increments, no partial-but-clean
     artifact), and a retried/duplicate hook invocation MUST NOT double-count.
     (The mechanism — append-only JSONL, atomic rename, lock — is the planner's;
     the invariant is idempotent, corruption-proof emission. Same class as the
     PowerShell state-file round-trip corruption in #248.)
   - **Carve-outs preserved:** the code-class (`--allow-code`) gate and the
     reviewer carve-out from `prompts/agent_rules.md` are untouched — the audit
     never forces source code to the cheap provider and never touches the review
     path.

3. **Cursor `beforeReadFile` deny-capability feasibility probe (cheap, Phase 1).**
   Record as a captured artifact whether the Cursor pre-read hook can *deny* (not
   only observe). This informs the deferred Phase-2 follow-up; it commits nothing
   in this issue.

**Operator adoption** (machine-local config outside the repo — both surfaces
wire identically: the operator edits a local JSON that references a tracked
handler):
- Claude audit wires into the operator-local `.claude/settings.json` (`Stop`
  hook). This file is **gitignored** (`.gitignore` `.claude/*`, only
  `!.claude/skills/` un-ignored) and **not** a pack-allowed edit target, so it is
  **not** tracked or PR-landed — the operator adds the hook entry from a
  documented snippet + verification step, exactly as for Cursor below.
- Cursor audit wires into the operator-local `~/.cursor/hooks.json` (`stop`),
  which already hosts the RTK `beforeShellExecution` hook — the operator adds the
  new entry; provide the exact JSON snippet and a verification step.
- The new hook handler script lives in the repo (tracked, e.g. `scripts/`) so
  both surfaces run the same logic; the per-machine `*.json` only references it.
- **Resync machine-local policy copies** after the `prompts/agent_rules.md`
  threshold change merges: `~/agent-rules/coworker-policy.md` (global canon),
  the generated `~/.codex/AGENTS.md`, and the `~/.cursor-global` symlink target —
  via the operator's existing sync step. These are outside the repo and not
  covered by the PR drift-check.

## Files in scope

- `prompts/agent_rules.md` — threshold numbers + audit-contract pointer.
- The threshold literal is owned by the tracked `prompts/agent_rules.md`. The
  repo drift-check runs over **tracked** surfaces only (no stale `600`
  volume-floor literal survives in any tracked policy file). The machine-local
  copies — `~/agent-rules/coworker-policy.md` (global canon Claude `@import`s),
  the generated `~/.codex/AGENTS.md`, and the `~/.cursor-global` symlink target —
  are **operator-adoption resync**, not repo PR deliverables (see Operator
  adoption); they are outside the repo and absent in CI/other checkouts.
- `docs/` — the audit-contract doc (new) and the operator-adoption runbook
  (includes both the `.claude/settings.json` and `~/.cursor/hooks.json` snippets
  the operator applies locally — neither machine-local JSON is tracked).
- `scripts/` or `plugins/` — new stop-time audit handler script `(new)`.
- A capture/fixture set proving each equivalence-class row.

## Files out of scope

- The Phase-2 pre-read hard block, its bypass mechanism, and the numeric
  go/no-go gate — **deferred to a follow-up** (see Deferred: Phase 2).
- `packages/core/**`, `vendor/**`, `.ao/**`.
- The RTK binary and its `beforeShellExecution` passthrough (#199 owns shell).
- The review path (`REVIEW_COMMAND` / `PACK_REVIEWER`).
- The norm's `--allow-code` gate semantics and the sub-floor rule — referenced,
  not redefined.

```denylist
vendor/**
packages/core/**
.ao/**
```

## Acceptance criteria

1. `prompts/agent_rules.md` states a **T1 volume floor of 400 lines** in the
   ask-trigger clause; no stale `600` volume floor remains there.
2. The T2 file-count trigger requires co-occurring ≥400 combined lines, or is
   absent because folded into T1 — no clause fires on file count alone with a
   trivial line total.
3. The threshold literal does not drift across **tracked** surfaces — a
   drift-check (grep over tracked files) asserts the canonical `400` in
   `prompts/agent_rules.md` and no surviving stale `600` volume-floor literal in
   any tracked policy file. The machine-local copies (`~/agent-rules/`,
   `~/.codex/AGENTS.md`, `~/.cursor-global`) are out of repo scope; their resync
   is an operator-adoption step (below), not a PR-verifiable criterion.
4. A stop-time audit contract doc exists stating the both-surfaces requirement,
   the work-unit definition, the tolerant-signal (finding-not-block) rule, the
   legitimate-read exemptions, and the preserved carve-outs.
5. A fixture/test exists for **each row** of the equivalence-class table —
   including the cross-file-edit row, the no-op-with-evidence row, the
   **cumulative sub-floor chunking** row, the **two-independent-questions
   work-unit-boundary** row, the **code-class (`--allow-code`-gated)** row, the
   **reviewer-path session** row, and the **>200-line diff/log** row — each
   asserting the expected flag/no-flag outcome, that the two non-delegable rows
   are excluded from the trigger-firing denominator, and that the **diff/log
   trigger fires independently of the T1 file-read floor** (a 250-line diff/log,
   below T1, is still flagged). If the rules keep a distinct T2 trigger, a T2
   fixture is added; if T2 is folded into T1, no separate T2 fixture is required.
6. **Detection-parity test:** a test fails if any row yields a different flag
   verdict on the Claude vs the Cursor audit path.
7. **Work-unit boundary is fixture-pinned:** a fixture with reads spanning two
   inbound requests in one session shows they are evaluated as two units (not
   summed), and a fixture with one request split across many reads shows they are
   summed.
8. **Metric emission:** the audit emits, on a defined window, residual
   non-compliance = (flagged work units ÷ **all fence-clean, delegable
   trigger-firing work units** — delegated and not-flagged-exempt units counted
   in the denominator; only code-class and reviewer-path units excluded) and the
   flagged-read count, in a machine-readable form a follow-up can consume.
   Fixtures assert that a delegated unit, an edit-exempt unit, and an
   excepted-reason unit each contribute to the denominator (not just the
   flagged ones), so the rate cannot collapse to ~1.
9. **Hook fail-open AND fail-loud:** a fixture injecting a handler error shows
   the read/turn proceeds (no-op, no wedge) **and** that the error emits a
   health/error record and increments the error/missing-window count in the
   metric artifact — a failed-audit window is reported as degraded, never as a
   zero-residual clean rate, and the failure does not silently shrink the
   denominator.
10. **Concurrency / idempotency:** a fixture with two simultaneous `stop` events
    writing the metric artifact, plus a retried duplicate event, shows no lost
    increment, no double-count, and no partial-but-clean artifact (stable
    per-unit key, atomic/append-only write).
11. **Delegation is observed, not self-attested:** a fixture where the status
    text claims delegation but no `coworker ask` invocation / coworker-log
    record is tied to the work unit shows the unit is flagged (or reported
    degraded/unverifiable), **not** counted as delegated compliance.

```positive-outcome
asserts: on a captured work unit where aggregate reads fired the trigger, were not delegated, and no edit of any file followed, the stop-time audit emits a flag with the same verdict on both the Claude and the Cursor path; a sibling unit whose reads are followed by an edit of any file in the unit (same or other file) is not flagged; and cumulative sub-floor chunks summing past the floor are flagged
input: external-tool-output
provenance: capture-backed
```

## Deferred: Phase 2 (pre-read hard block) — follow-up, not this issue

A pre-read hard block on a single text-class read **well above** the floor
(where a range/offset read-for-edit stays under it), with an audited bypass, is
the intended next step. It is **out of scope here** and authored as a separate
draft **only if** Phase-1 metric emission (AC8) shows residual non-compliance
above a bar the follow-up will set **with that data** — and only on a surface
whose pre-read hook deny-capability is confirmed (Phase-1 probe, item 3). This
deferral is deliberate: the hard block is the expensive, false-positive-prone,
feasibility-uncertain part, and its numeric go/no-go cannot be principledly set
before the audit has measured the residual. No `parked-root-cause` fence is used
(this is a phased build, not a deferred failure root cause).

## Upgrade-safety check

- No AO core, vendor, or `agent-orchestrator.yaml` schema changes.
- No new repo secret. The audit handler reads only the local transcript/tool
  payload already available to the hook; it sends file contents nowhere.
- The audit must fail **open** on its own error — a crashing handler degrades to
  no-op, never wedges a read or a turn — but also fail **loud**: a handler error,
  or a missing/invalid hook payload, MUST emit a machine-readable health/error
  record per surface and window, and those error/missing-window counts MUST ride
  in the Phase-2 metric artifact. A silently-dropped audit must never read as a
  clean compliance rate (the «green while broken» trap — a window with audit
  errors is reported as degraded, not as zero residual).
- Threshold literal: one canonical value in the tracked `prompts/agent_rules.md`;
  the drift-check is over tracked surfaces only (no stale `600`). Machine-local
  copies are resynced by the operator, not by the PR.

## Verification

1. Cross-file grep: the T1 literal is `400` across `prompts/agent_rules.md` and
   every mirror; no stale `600` volume floor remains in the ask-trigger clause.
2. Run the equivalence-class fixture suite; every row (including cumulative-chunk,
   cross-file-edit, no-op-with-evidence, and work-unit-boundary rows) yields its
   tabled outcome.
3. Detection-parity check: same flag verdict on both surfaces for every row.
4. Cursor `beforeReadFile` deny-feasibility probe result is checked in as a
   captured artifact (the JSON the hook returns on a deny attempt), backing the
   Phase-2 deferral.
5. Metric-emission check: the audit produces the residual-non-compliance and
   flagged-read figures in the defined machine-readable form.
6. Fail-open + fail-loud: a fixture injecting a handler error shows the turn
   proceeds AND a health/error record + error count appear in the metric.
7. Concurrency: a fixture with simultaneous + duplicate `stop` events shows the
   metric artifact is not corrupted, double-counted, or partially written.
