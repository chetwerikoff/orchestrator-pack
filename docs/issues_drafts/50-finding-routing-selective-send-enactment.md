# Finding routing: upstream unblock — pipeline-first, legacy fallback (AO 0.9.x)

GitHub Issue: [#140](https://github.com/chetwerikoff/orchestrator-pack/issues/140)

**Queue status:** `active-blocked-upstream` — Gate 0 done on legacy `ao review` 0.9.2;
no pack prod enactment until Composio ships primitives. Same class as draft 38 / #122.

## Prerequisite

- Gate 0 spike **done** (2026-06-02, `ao` 0.9.2) — [`docs/architecture.md`](../architecture.md#finding-routing-enactment--gate-0-ao-092-2026-06-02).
- Draft 47 (gold corpus + offline scorer) — **active**; label corpus + classifier shape for
  upstream asks and same-day wiring when API lands.
- Review dashboard terminal cleanup — draft 38 (GitHub #122).

## Goal

Until Composio exposes supported enactment primitives, **do not** wire the finding
classifier into production `orchestratorRules` / legacy bulk `ao review send`.

This issue delivers **two-track upstream tracking** (#122 discipline: docs + links, no
noop-as-done, no hand-editing `code-reviews/`):

| Track | Preferred? | Native home for classifier + A/A′/B |
|-------|------------|--------------------------------------|
| **Pipeline** | **Yes** | `builtin/router` stage + `command` executor (findings JSON stdout) + `ao artifact dismiss\|reopen\|send` |
| **Legacy `ao review`** | Fallback on 0.9.2 | [#2088](https://github.com/ComposioHQ/agent-orchestrator/issues/2088) until pipeline ships |

**Classifier design default:** implement as a **pipeline `command` stage** (or plugin
slot feeding router) that emits AO **findings JSON** per Composio pipeline contract — not
as a pack-only wrapper over legacy bulk send. Legacy path is contingency for operators
still on `codeReview:` / `ao review` 0.9.x.

When either track lands **A + A′** (and B for `drop`), a small pack follow-up wires enactment.

## Gate 0 result (2026-06-02, AO 0.9.2) — legacy path blocked

| Capability | Need | Legacy `ao review` 0.9.2 |
|------------|------|---------------------------|
| **A** — selective send | Send subset of open findings | **No** — bulk all `open` |
| **A′** — terminal non-forward | `backlog`/`drop` clear `openFindingCount` | **No** — `dismissed` type exists; **no CLI**; UI only |
| **B** — `prior_sent` at routing point | History for `drop` dedup | **No** — list aggregates only |

Pack read-hook / ledger-only **do not** unblock (forbidden hand-edit; ledger ≠ A/A′).

**Pipeline track (not yet on 0.9.2 CLI, but strategic):** Gate 0 did not validate pipeline
on installed `ao` version; track as **preferred unblock** per Composio roadmap below.

## Binding surface

### Track 1 — Pipeline (preferred native domain)

**Why preferred:** Composio is building the routing/enactment plane in pipeline, not by
extending legacy `ao review` indefinitely.

| Composio issue | Relevance |
|----------------|-----------|
| [#1631](https://github.com/ComposioHQ/agent-orchestrator/issues/1631) — builtin/router | Routes findings from upstream stages to target session — **conceptual home for our classifier** |
| [#1346](https://github.com/ComposioHQ/agent-orchestrator/issues/1346) — pipeline v0 | Plans `ao artifact dismiss\|reopen\|send` — **A′** terminal primitives |
| [#1345](https://github.com/ComposioHQ/agent-orchestrator/issues/1345) | Pipeline execution model parent |
| [#1350](https://github.com/ComposioHQ/agent-orchestrator/issues/1350) | Workbench UI (dismiss/send); not sufficient alone for orchestrator automation |

**Pack classifier shape (planner, when pipeline available):**

- **`command` stage** with documented stdout **findings JSON** contract (per #1631 / pipeline docs).
- Output: per-artifact route decision consumed by `builtin/router` (or equivalent), not
  direct `orchestratorRules` string logic over bulk send.
- Gold corpus (#139) labels remain valid; enactment binding changes from `ao review send`
  to artifact transitions.

**Track 1 tracking deliverable:** comment/link on #1631 and #1346 from pack #140 with
Gate 0 summary + pointer to #139 corpus; request explicit contract for selective
`artifact send` + dismiss/backlog status + skipped-reason observability (see delivery).

### Track 2 — Legacy `ao review` (fallback)

[ComposioHQ/agent-orchestrator#2088](https://github.com/ComposioHQ/agent-orchestrator/issues/2088)
— list findings, selective send, programmatic dismiss, sent-history on legacy CLI.

**Hedge:** keep #2088 open as **0.9.x contingency**; do **not** bet the classifier architecture
only on legacy API. When pipeline lands, deprecate legacy wiring plan in pack docs.

### Delivery observability (both tracks — prerequisite for trusting `forward`)

Routing `forward` ≠ «worker received finding». Upstream delivery gaps:

| Composio issue | Problem |
|----------------|---------|
| [#1943](https://github.com/ComposioHQ/agent-orchestrator/issues/1943) | Review-backlog dispatch silently skips forward (`throttled`, `fingerprint_unchanged`, `terminal_status`, `no_reaction_config`, …) — **no operator-visible reason** |
| [#614](https://github.com/ComposioHQ/agent-orchestrator/issues/614) | Send-to-agent no-op without message **and** suppresses human fallback |

**Pack ask (cite in #2088, #1631, or separate comment):** skipped-reason enum / structured
observation on every non-delivery (per #1943 proposal). Classifier and operators must be
able to distinguish «routed forward» vs «dispatch skipped».

Shared invariant **#1** in `finding-routing-eval-shared-pack-boundaries.md` encodes this.

### Backlog sink (draft 47 contract — native candidate)

| Composio issue | Relevance |
|----------------|-----------|
| [#1494](https://github.com/ComposioHQ/agent-orchestrator/issues/1494) | Unified `ao backlog` view — **candidate native sink** for `backlog` route (vs pack `docs/` file) |

Draft 47 MUST name #1494 in backlog sink section; implementation follows whichever sink
exists when enactment unblocks.

### Peripheral upstream (track, do not block #139)

- [#1290](https://github.com/ComposioHQ/agent-orchestrator/issues/1290) — SCM trigger rules
- [#1193](https://github.com/ComposioHQ/agent-orchestrator/issues/1193) — reactions + second PR session
- [#1122](https://github.com/ComposioHQ/agent-orchestrator/issues/1122) — stale reaction data

### Pack deliverables (this issue)

- Two-track doc state in `docs/architecture.md` + §Q in `00-architecture-decisions.md`.
- Legacy: [#2088](https://github.com/ComposioHQ/agent-orchestrator/issues/2088) (exists).
- Pipeline: links/comments on [#1631](https://github.com/ComposioHQ/agent-orchestrator/issues/1631) + [#1346](https://github.com/ComposioHQ/agent-orchestrator/issues/1346) from #140.
- Delivery: cross-link #1943 / #614 in upstream asks and pack invariant #1.
- Optional read-only diagnostic for legacy bulk-send / stuck `open` (no mutation).
- Cross-links from draft 47 / shared boundaries.

### Deferred until upstream

- Prod classifier wiring (either track).
- `class_tag` drift logging in prod (spec in enactment follow-up).
- Drafts 48–49 (§Q).

### Dependency matrix

| Work | Until unblock |
|------|----------------|
| Draft 47 corpus + scorer | **Active** — design classifier for pipeline findings JSON |
| Draft 48 / 49 | **Deferred** |
| Prod routing (all routes) | **Blocked** — pipeline **preferred** path; legacy #2088 fallback |

## Files in scope

- `docs/architecture.md`, `docs/issues_drafts/00-architecture-decisions.md` §Q.
- This draft, `docs/issue_queue_index.md`.
- Optional `scripts/**` diagnostic (read-only).
- Upstream link table (no AO core patches in this repo).

## Files out of scope

- Classifier / corpus implementation (draft 47).
- AO core / `vendor/**`.
- Hand-editing `code-reviews/`.

## Denylist

```denylist
vendor/**
packages/core/**
code-reviews/**
.ao/**
agent-orchestrator.yaml
```

```allowed-roots
docs/**
scripts/**
```

## Acceptance criteria

- Gate 0 on legacy 0.9.2 recorded; **pipeline track documented as preferred**.
- #2088 linked as legacy fallback; #1631 + #1346 linked as primary unblock path.
- #1943 / #614 cited as delivery prerequisites in pack docs and upstream comments.
- #1494 cited from draft 47 backlog contract.
- Docs: classifier defaults to **pipeline command / findings JSON**, not legacy-only design.
- No claim pack read-hook unblocks A/A′.

## Upgrade-safety check

- Docs / tracking only unless optional diagnostic.

## Verification

```powershell
.\scripts\verify.ps1
.\scripts\check-reusable.ps1
```

- `docs/architecture.md`: Gate 0 + two-track table + upstream URLs.
- #140 GitHub body matches this spec.
