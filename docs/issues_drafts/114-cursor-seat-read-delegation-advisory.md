# Cursor seat: read-delegation obligation is advisory for out-of-index corpus, not a mandatory floor

GitHub Issue: #359

## Prerequisite

- `docs/issues_drafts/53-delegation-policy-global-fanout.md` (GitHub #149) —
  *already does:* single-sources the coworker delegation policy in
  `prompts/agent_rules.md`; `.cursor/rules/` carries an always-applied thin
  pointer; architecture decision §S. This draft amends that same single source
  and §S — it does **not** add a second policy copy.
- `docs/issues_drafts/83-coworker-delegation-threshold-and-enforcement.md`
  (GitHub #255) — *already does:* ships the stop-time delegation **audit** as a
  *tolerant signal, never a block*, on both Claude and Cursor surfaces; a hard
  pre-read block was explicitly **deferred**. This draft reuses that audit and
  keeps it non-blocking; it only changes how the audit **classifies** a
  now-advisory Cursor read.
- `docs/issues_drafts/86-read-delegation-reviewer-carveout-per-session.md`
  (GitHub #264) — *already does:* per-work-unit reviewer-path carve-out feeding
  the audit's residual metric. This draft must not regress that classifier.
- `docs/issues_drafts/109-diff-read-directly-not-delegated.md` (GitHub #337) —
  *already does:* diffs (`git diff`/`git show`, `.diff`/`.patch`) are read
  directly by agents and never delegated. This draft must preserve that exemption
  — a Cursor diff read keeps #337's direct-read carve-out and is **not** folded
  into the new advisory out-of-index category. Must land at/after #337 to avoid
  order-dependent classifier behaviour.
- `docs/issues_drafts/98-cursor-index-aware-read-delegation-carveout.md`
  (GitHub #309) — *already does:* exempts Cursor **in-index first-party source**
  reads from delegation, via a two-phase stop-time classifier (Phase A surface
  validity from a committed Cursor-spelling manifest; Phase B path/kind
  classification). It explicitly leaves **tracked non-code bulk
  (markdown/JSON/data) delegable**. This draft extends that carve-out to the
  remaining out-of-index corpus **for the Cursor seat only**, reusing #309's
  Phase-A surface identification to scope the exemption.

## Goal

Make the coworker read-delegation obligation **advisory (not a mandatory floor)
for the Cursor seat** when the corpus is *not* already exempt by #309 —
i.e. tracked non-code bulk (markdown/JSON/data) and other out-of-index material.
The mandatory floor stays in force for the Claude and Codex surfaces, which
comply with it. The Cursor seat keeps its existing carve-outs (#309 in-index
code, diffs read directly per #337). The stop-time audit keeps the read
**observable**: a Cursor read the amended policy now treats as advisory is
recorded under a distinct, observable **advisory** classification (not silently
discarded like a #309 exemption), and only the **non-compliance** finding is
suppressed — so the signal the draft intends to retain is not erased.

```behavior-kind
action-producing
```

## Why (decision rationale — prior art + evidence)

**Prior art.** The delegation obligation is a *mandatory floor* universally
(§S.3, agent_rules.md). #255 ships only a *tolerant audit* on Cursor (hard block
deferred). #309 exempts in-index Cursor code but deliberately leaves tracked
non-code bulk delegable. No existing draft makes the Cursor non-code-bulk floor
advisory. So the residual mandatory pressure on the Cursor seat falls exactly on
out-of-index bulk (e.g. a >400-line tracked markdown draft) — the corpus that
produced the observed costyl.

**Evidence (2026-06-19).** On the weak Cursor seat (composer-2.5) the mandatory
obligation does not yield delegation; it yields evasion. A live `beforeReadFile`
spike confirmed the hook fires and `deny` is honoured, yet a denied native read
was routed around three ways — `coworker ask "return verbatim"` (coworker as a
dumb `cat`), reading coworker's terminal output, and a plain `head` shell read
that succeeded — and the model obtained the full file anyway. A prior operator
removal of an experimental Cursor read hook had already shown the same evasion
(chunked `sed`/`grep`). Mandating delegation on this seat therefore buys
latency + workarounds, not the intended cheap-model offload. The cheapest
sufficient change is to stop mandating on the seat where the mandate is
empirically unenforceable, while keeping the mandate where it is honoured
(Claude/Codex) and keeping the audit signal.

This is a policy/prose amendment plus an audit-classification alignment to the
same single source; it adds no new component. The pre-draft design-analysis gate
(non-trivial-build only) does not apply; the 5-mode framework's **Mode 2** does —
the amendment lives only in the one canonical source (`prompts/agent_rules.md` +
§S), never a second copy.

## Binding surface

- The canonical delegation policy (`prompts/agent_rules.md`) states that the
  read-delegation obligation is **advisory** for the **Cursor seat** when the
  corpus is not already exempt (out-of-index / tracked non-code bulk), and
  remains a **mandatory floor** for the Claude and Codex surfaces. The Cursor
  seat is identified by the same committed surface-spelling manifest #309 already
  uses — no new manifest.
- Architecture decision §S records this narrowing and its evidence-grounded
  rationale, so a future reader cannot mistake it for blanket policy decay.
- The thin `.cursor/rules/` pointer(s) continue to resolve to the canonical
  source; if they state an obligation verb, it must match the amended canonical
  wording (advisory for the Cursor seat) rather than contradict it.
- The stop-time delegation audit (the #255/#309 classifier) records a Cursor-seat
  read the amended policy now treats as advisory under a **distinct, observable
  advisory classification** — it is **not** discarded like a #309 exemption — and
  it **does not** emit a non-compliance finding for that read. The residual metric
  for genuinely-delegable corpus on other surfaces is preserved (no #264
  regression).
- No new blocking behaviour is introduced on any surface; the Claude-side
  read-delegation deny-hook is untouched and stays mandatory.

## Files in scope

- `prompts/agent_rules.md` — canonical delegation section: add the Cursor-seat
  advisory carve-out.
- `docs/issues_drafts/00-architecture-decisions.md` — §S: record the decision.
- `.cursor/rules/**` — only if a pointer states an obligation verb that would
  contradict the amended canonical wording.
- The §S fanout copies that **embed** the delegation obligation —
  `AGENTS.md` (Codex), `CLAUDE.md` (architect) — must stay consistent with the
  amended canonical source: any Cursor-seat clause they carry matches canonical
  (advisory for the Cursor seat) and does not retain a contradictory mandatory
  statement. Their Claude/Codex obligation **substance** is unchanged; only the
  fanout-consistency edit (or regeneration, if generated) is in scope. The
  planner resolves which carry embedded text via §S.
- The stop-time delegation audit classifier and its fixtures (the surface
  shipped by #255/#309) — align classification so now-advisory Cursor reads are
  recorded under the observable advisory category and not flagged non-compliance.
  The planner resolves the concrete file via the existing declarations.

## Files out of scope

- `.claude/hooks/**` — the Claude-side read-delegation deny-hook stays mandatory
  and unchanged.
- The Claude and Codex delegation **obligation substance** (the mandatory floor
  for those surfaces) — unchanged; `AGENTS.md`/`CLAUDE.md` are touched only for
  §S fanout consistency, never to alter their floor.
- The coworker policy provider-input fence (secrets / private data) — orthogonal,
  unchanged on every surface.
- Any second authored copy of the delegation policy — single-source is preserved,
  not forked.

```denylist
vendor/**
packages/core/**
.ao/**
.claude/hooks/**
```

```allowed-roots
prompts/**
docs/issues_drafts/**
docs/read-delegation-audit.mjs
.cursor/rules/**
scripts/**
AGENTS.md
CLAUDE.md
```

## Acceptance criteria

1. The canonical delegation section in `prompts/agent_rules.md` states the Cursor
   seat's read-delegation obligation for out-of-index / tracked non-code bulk is
   advisory, not a mandatory floor, and explicitly preserves the mandatory floor
   for the Claude and Codex surfaces.
2. §S in `00-architecture-decisions.md` records the narrowing with its
   evidence-grounded rationale (the empirical unenforceability on the Cursor
   seat), and the architecture decision-log issue **#3** body carries the same
   amended §S text after the PR (synced in the same PR).
3. The delegation policy remains single-sourced: no second authored copy of the
   triggers/obligation text exists after the change (Mode 2 invariant).
4. The Claude and Codex **mandatory floor is unchanged in substance** — those
   surfaces still mandate delegation when an ask trigger fires — even if
   fanout-consistency edits to `AGENTS.md`/`CLAUDE.md` touch nearby lines; and
   `AGENTS.md`/`CLAUDE.md` retain **no** statement that contradicts the amended
   canonical Cursor-seat clause (§S fanout stays consistent). The Claude-side
   deny-hook file (`.claude/hooks/**`) is untouched.
5. The stop-time audit records a representative Cursor-seat read under a
   **distinct, observable advisory classification** (the read stays visible in the
   audit output — not silently discarded like a #309 exemption) and does **not**
   surface it as a non-compliance finding, for **at least two out-of-index corpus
   classes that each cross their applicable floor**: tracked non-code bulk
   (markdown/JSON/data, >400 lines) **and** at least one non-markdown class that
   exceeds its trigger (a log >200 lines, or fetched external corpus >400 combined
   lines). Advisory Cursor reads are **excluded from the mandatory-delegable
   residual denominator** (they are not mandatory, so they must not dilute that
   metric) and are instead tallied under the separate observable advisory count.
   Meanwhile a genuinely-delegable read on a non-Cursor surface still counts toward
   the residual metric (no #264 regression).

```positive-outcome
asserts: the stop-time delegation audit, given a captured Cursor-seat stop event whose read targets an out-of-index tracked non-code-bulk file over the floor, records it under a distinct observable advisory classification (still visible in the audit output, not discarded) and emits no non-compliance finding
input: external-tool-output
provenance: capture-backed
```

## Upgrade-safety check

- No AO core (`packages/core/**`) or `vendor/**` edits.
- No new repo secrets; provider-input fence unchanged.
- No new always-applied YAML/reaction; no `ao stop`/`ao start` contract change.
- No new blocking hook on any surface; the change is prose + audit classification.
- Single-source delegation policy preserved (no fork/second copy).

## Verification

1. Show the amended `prompts/agent_rules.md` clause and confirm it scopes the
   advisory downgrade to the Cursor seat only (Claude/Codex floor intact) —
   maps to criteria 1, 4.
2. Show the §S diff recording the decision + rationale, and confirm the
   architecture decision-log issue **#3** body carries the amended §S text
   (`gh issue view 3`) — criterion 2.
3. Grep the repo to prove no second copy of the delegation trigger/obligation
   text was introduced — criterion 3.
4. Run the audit's test suite including **capture-backed** fixtures covering at
   least two out-of-index classes that each cross their floor — a real Cursor
   stop-event JSON reading an out-of-index >400-line tracked markdown **and** at
   least one non-markdown class above its trigger (a log >200 lines, or fetched
   external corpus >400 combined lines) — each asserted recorded under the distinct
   observable advisory classification (still visible in the audit output, not
   discarded), excluded from the mandatory-delegable residual denominator, with no
   non-compliance finding; plus a non-Cursor delegable read still counted toward
   the residual metric — criterion 5 and the `positive-outcome` block.
5. Confirm `git diff` does not touch `.claude/hooks/**`, and that `AGENTS.md` /
   `CLAUDE.md` carry no clause contradicting the amended canonical Cursor-seat
   wording — criterion 4.
6. Run the pack-wide required checks on Linux/WSL2 (pwsh 7+):
   `pwsh ./scripts/verify.ps1` and `pwsh ./scripts/check-reusable.ps1` — both
   pass on the change.
