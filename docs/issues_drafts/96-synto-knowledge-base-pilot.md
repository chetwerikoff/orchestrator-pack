# Pilot a local synto knowledge base on one book

GitHub Issue: #354

## Prerequisite

- None in-repo. **Prior-art reconnaissance (no reusable prior art):** a `gh`
  survey of closed/open issues + merged PRs and a coworker read across all ~95
  drafts, `docs/architecture.md`, and `docs/issue_queue_index.md` returned zero
  matches on knowledge bases, document ingestion, retrieval, or MCP knowledge
  servers — the repo is entirely AO orchestration / review loops / CI. New surface.
- **External dependency (not a repo issue):** `synto` — MIT, v0.6.x, the
  maintained successor of `obsidian-llm-wiki-local`, implementing the "LLM wiki"
  pattern (cheap model extracts concepts, heavy model compiles one article per
  concept; no embeddings; index-routed retrieval; native MCP server). Chosen over
  the immature `obsidian-llm-wiki-local` fork and dobryakov's heavier
  `hybrid-search` retrieval layer (see **Decisions**).

## Goal

Author a **self-contained operator methodology** (one docs file) for a local
`synto` pilot on one book. It has two layers:

1. **Numbered steps for the operator (the human):** what to do, in order, to
   stand up the pilot — and where to paste each prompt below.
2. **A prompt library for a vault agent** — ready-to-paste prompts the operator
   feeds to a *separate* agent invoked directly **inside the vault folder** (not
   an AO worker, not in-repo). The prompts are written at the level of
   **intent** (install synto, init a vault here, ingest this book with the
   appropriate source type, review drafts to `published`, start the MCP server,
   run a task-wording query, report cost) — the vault agent resolves synto's
   exact commands/flags itself, so the methodology does not rot when synto's CLI
   changes.

End state: following the methodology, the operator drives a vault agent to
convert one book into a vetted concept wiki, confirms an MCP query returns a
relevant `published` article, and fills in a **go/no-go result section** in the
same doc. A quick evaluation, not a hardened proof protocol.

```behavior-kind
action-producing
```

**Delivery.** One docs PR delivers the whole methodology **including the empty
result section the operator later fills**. There is no separate execution draft:
the run is operator-driven and its outcome is a section of this same doc, so the
former draft 97 is folded in here.

## Binding surface

- The repo commits to **one new docs file**: a methodology with (a) numbered
  operator steps and (b) a paste-ready **prompt library** for a vault agent. The
  prompts cover the full arc: install synto, init a vault, ingest one book with
  the appropriate source type, review drafts to `published`, start the MCP
  server, run a task-wording query, report cost. The doc also carries an **empty
  result section** the operator fills after the run (book, cost, page count,
  go/no-go).
- The vault agent is a **separate agent the operator invokes inside the vault
  folder** — explicitly **not** an AO worker and **not** run in the pack repo.
  The methodology never asks an AO worker to execute synto.
- Consumption sanity (kept deliberately light): the check uses a **real question
  in task wording** (not just reading a known article title) and a **deterministic
  read tool**, not synto's on-the-fly synthesis path; draft-status articles are
  excluded. One line of safety: the vault agent runs in a folder with only the
  vault — a book article could carry a stray instruction, so it must not be given
  powerful repo/system tools.
- The vault, wiki, synto install/config, and MCP wiring are **operator-local and
  git-ignored, and the vault lives OUTSIDE the pack worktree** (synto auto-commits
  its own state, which would otherwise pollute this repo). The repo's only durable
  surface is this methodology doc.

## Files in scope

- `docs/synto-knowledge-base-pilot.md` — methodology doc (operator steps +
  vault-agent prompt library + empty result section) `(new)`.

## Files out of scope

- `agent-orchestrator.yaml*`, `orchestratorRules`, `reactions`, `prompts/**` —
  the pilot wires MCP locally; no committed worker-wiring changes.
- Worker-flow integration (agents consulting the KB during tasks), multi-book
  library, and the `hybrid-search` upgrade — follow-up drafts gated on a go verdict.
- HTTP (network) MCP transport, knowledge-pack export, concept-identity curation —
  not needed for a one-book pilot.
- Committing any vault, wiki, pack, synto config, or book content into the repo.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

```allowed-roots
docs/**
```

## Acceptance criteria

These are provable on **this docs PR** (the methodology is the deliverable; the
filled-in result is added later by the operator):

- One methodology doc under `docs/` lets an operator drive a vault agent through
  the pilot end to end: install synto, init a vault, ingest one book, review to
  `published`, start the stdio MCP server, run the query, report the result.
- The doc contains a **paste-ready prompt for each step**, addressed to an agent
  invoked **inside the vault folder**, written at intent level (the agent resolves
  synto's exact commands). It states the vault agent is not an AO worker and must
  not be given powerful repo/system tools.
- The doc says the check uses a real task-wording query and a deterministic read
  tool (not synto's synthesis path), and that draft-status articles are excluded.
- The doc carries an **empty result section** with labelled slots for: the chosen
  book, the approximate end-to-end conversion cost, the number of concept pages,
  and a one-paragraph go/no-go recommendation.
- The doc notes what is git-ignored (vault, wiki, config, MCP wiring) and that the
  vault lives outside the pack worktree.

```positive-outcome
asserts: an MCP query in task wording returns a relevant concept's published article via a deterministic read tool (not on-the-fly synthesis), with draft-status articles excluded
input: external-tool-output
provenance: capture-backed
```

**Note:** the positive-outcome is satisfied only when the operator fills the
**Pilot result** section after a real run — it does **not** gate the docs PR,
which proves the runbook exists.

## Upgrade-safety check

- No edits to AO core, `vendor/**`, or `packages/core/**`.
- No changes to committed AO wiring (`agent-orchestrator.yaml*`, `orchestratorRules`,
  `reactions`, `prompts/**`) — the pilot is local/operator-only.
- No new repository secrets: any provider API key lives in the operator's local
  synto config outside the repo (don't paste it into the runbook).
- No vault, wiki, or book content committed (repo hygiene): the git surface is the
  runbook doc only. The vault lives outside the pack worktree so synto's
  auto-commits cannot land in this repository.
- synto runs as an external local tool; nothing is patched or vendored in.

## Verification

**Static checks on this docs PR (the deliverable):**
- The doc walks an operator through the full sequence (install → init vault →
  ingest → review-to-`published` → stdio MCP serve → task-wording query → record
  result), with a paste-ready vault-agent prompt at each step.
- The prompts are addressed to an agent run inside the vault folder, at intent
  level, and the doc states that agent is not an AO worker and gets no powerful
  repo/system tools.
- The doc instructs the deterministic-read-tool + draft-exclusion requirements,
  and carries an empty result section with the four labelled slots.
- The doc states what is git-ignored and that the vault lives outside the pack
  worktree; `git status` shows only the new methodology doc.

**Runtime checks the methodology enables (operator-run, later, not gating this PR):**
- Following the doc, a task-wording MCP query returns a relevant `published`
  article via a deterministic read tool, with no draft-status article.
- `git log` shows no `[synto]` commit in the repo (vault outside the worktree).
- The result section is filled with real numbers (book, cost, page count) and a
  go/no-go verdict.

## Decisions (design analysis)

**Prior art.** None in-repo; capability is new.

**Mechanics.** Two-stage pipeline (cheap model extracts concepts; heavy model
compiles one cross-linked article per concept). No embeddings — retrieval routes
through a concept index: simple and CPU-friendly, but caps useful scale at roughly
where a flat index still routes reliably. Drafts excluded from agent context by
default.

**World practice.** Field default is vector RAG; synto bets on LLM-compiled wiki +
index routing for zero-infrastructure simplicity. dobryakov's `hybrid-search` is
the established scale answer (BM25 + embeddings + fuzzy-title via reciprocal rank
fusion, plus a per-book terminology "dossier") — the dossier idea is the most
portable lesson, noted for a later slice.

**Options (cheapest sufficient executor):**
- **A — synto end-to-end** (build + built-in index-routed MCP retrieval). *Chosen.*
  Lowest setup cost, single maintained tool, native MCP. Risk: young tool,
  index-routing scale cap — acceptable for a one-book pilot.
- **B — olw/synto build + dobryakov `hybrid-search` retrieval.** Deferred:
  reintroduces embeddings, a second unsupported fork, and hand-curated dossiers.
  Re-open if scale exceeds index routing or if synonym/deep-concept queries fail
  (a terminology-recall gap, not "synto is bad").
- **C — build our own ingestion + RAG in-pack.** Rejected: highest cost/risk,
  reinvents a maintained tool in an orchestration repo.

**Decomposition.** One docs PR: the methodology *and* its empty result section
ship together, because the run is operator-driven (a vault agent the operator
invokes), so its outcome is a section of this same doc, not a separate worker
task. The former draft 97 (a separate execution draft) is folded in — a worker
can't install external tools, spend the API budget, or judge article quality.
Worker-flow consumption (agents consulting the KB during tasks), a multi-book
library, and the hybrid-search upgrade remain follow-up drafts gated on a go verdict.

**Operator-runtime note.** synto keeps state in SQLite; this pack has a known
SQLite write-lock contention failure mode against shared DBs — the pilot vault
must be its own isolated DB.

**Scope note (operator direction, 2026-06-15).** This draft was deliberately
**simplified back to a light pilot** by operator direction. Earlier it carried (a)
extensive copyright/privacy gating and (b) a hardened, un-foolable proof protocol
(deterministic-selection state machine, two-phase anchors, evidence manifest +
validator, crash journal, atomic vault lock, process-group cleanup). Both were
removed as exceeding what a go/no-go pilot needs — by direction, not by review. If
a rigorous or copyright-sensitive variant is later needed, the hardened version is
in this draft's git history.

**GPT adversarial pass (2026-06-16).** Pass 1 `BLOCKED` (8 findings). Settled:
- **Source-access guard** — accepted minimally: methodology requires checking
  `synto doctor` MCP/privacy warnings and setting `[mcp.source_access]` before
  serve for copyrighted/private books; full copyright protocol stays deferred per
  scope note.
- **Intent-level prompts** — partial: kept intent-level per binding surface; added
  forbidden-command list (`--auto-approve`, `watch`, HTTP transport, synthesis
  tools) without pinning version-specific CLI flags.
- **Deterministic MCP sequence** — accepted: methodology names
  `find_concept`/`search_articles` → `read_article` and bans `answer_question`.
- **GitHub Issue TBD** — accepted: sync issue before docs PR merge.
- **Windows/WSL paths** — accepted: methodology requires absolute vault paths in
  MCP config and a same-environment `synto --version` smoke check.
- **Native validation** — accepted: lightweight `synto eval` step before MCP check.
- **Hybrid-search deferral** — partial: go/no-go narrowed to **index-routing
  usefulness**; hybrid-search remains a follow-up if terminology-recall fails.
- **Run journal / split PR** — rejected: exceeds light-pilot scope; operator records
  version + cost in result table only.

`GPT loop: 1 passes; stopped because pending pass-2 after accepted findings; last-pass accepted=5; final STATE=completed_valid VALIDATION=ok pass=0033fcdf-fb1b-4364-802f-bb80143b7ca4 sha=f46e1c8a012b6d6e9d3dcca91bdd9754045e3a86ca1a065795bac7f7939bf139`

**GPT pass 2 (2026-06-16).** `NEEDS_ATTENTION` (8 findings). Settled:
- **Positive-outcome vs runbook PR** — accepted: note added that capture-backed
  outcome gates operator fill-in, not the docs PR.
- **Provenance spot-check** — accepted: step 7 adds `trace_lineage` on chosen article.
- **Source type vagueness** — accepted: step 4 prompt requires justify-before-ingest.
- **Pack export vs MCP** — rejected: spec positive-outcome requires stdio MCP;
  pack export remains follow-up.
- **Concept identity** — partial: `concept inspect` on query concept in step 7.
- **Cloud egress** — accepted: step 0 operator acknowledgement for cloud providers.
- **Rerun/resume** — partial: minimal inspect-before-rerun rule in methodology.
- **Prior-art survey** — rejected as non-binding; prerequisite already records terms.

`GPT loop: 2 passes; stopped because pending pass-3 after accepted findings; last-pass accepted=4; final STATE=completed_valid VALIDATION=ok pass=47a8b589-2620-4e8c-85e2-213751a2da95 sha=dd57009d371590d5af1a652654af068ffe9d48bc4389315e7061566d110e8604`

**GPT pass 3 (2026-06-16).** `NEEDS_ATTENTION` (6 findings). Settled:
- **Capture artifact slots** — partial: result table adds eval/lineage/teardown fields;
  full artifact hashes rejected as over-heavy for light pilot.
- **Version pin** — accepted: methodology notes 0.6.x band + version in result.
- **MCP teardown** — accepted: operator step 10 + result field.
- **Pack export** — rejected again (MCP required by positive-outcome).
- **Concept ambiguity gate** — partial: lineage + concept inspect in step 7; operator
  notes ambiguity in go/no-go, no hard fail gate.
- **Concurrency** — accepted: one-command-at-a-time rule added.

`GPT loop: 3 passes; stopped because pending pass-4 after accepted findings; last-pass accepted=3; final STATE=completed_valid VALIDATION=ok pass=0e91bbb8-5d35-4bfe-86cd-76b6a7754bd8 sha=e331dbff8ba1974663402fd84594a66ce39fd05a990eaae780fbff1bdf4facd9`

**GPT pass 4 (2026-06-16).** `NEEDS_ATTENTION` (8 findings). Settled:
- **Concept ceiling** — accepted: step 0 scope/ceiling note + result fields.
- **Format support** — accepted: PDF/Markdown/text only; pre-conversion out of scope.
- **Pre-run budget** — partial: optional spend guard in step 0.
- **maintain --dry-run** — accepted: added to step 6b.
- **Scale cap hypothesis** — rejected for runbook (design-analysis wording in draft).
- **Multi-query suite** — rejected: spec keeps one task-wording query; operator may
  note recall gaps in go/no-go.
- **Fresh vault git** — accepted: step 3 forbids nested foreign git repos.
- **HTTP transport** — rejected (already forbidden; revisit only if stdio fails).

`GPT loop: 4 passes; stopped because operator-requested stop after pass 4 (no pass 5); last-pass accepted=5; final STATE=completed_valid VALIDATION=ok pass=b6f2cdfe-19d0-447b-904d-f7998d467e4d sha=31373524210b4fc1644c521ab5d33ce255b09faf1a965003ff84a7b587a534d3`

**Operator rollback (2026-06-16).** MCP privacy / `source_access` gating, cloud
acknowledgement, and raw-source tool bans removed from the methodology — exceeds
light-pilot needs (same direction as the original scope note on copyright gating).
