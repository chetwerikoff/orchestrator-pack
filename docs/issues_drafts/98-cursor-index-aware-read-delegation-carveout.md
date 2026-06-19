# Read-delegation: exempt Cursor in-index source reads from coworker delegation

GitHub Issue: #309

## Prerequisite

- `docs/issues_drafts/52-coworker-cli-delegation-policy.md` (GitHub #148, merged)
  — the canonical "delegate I/O, keep reasoning" policy, the ask-trigger floor,
  and the secret/private provider-input fence. **Reused unchanged.**
- `docs/issues_drafts/83-coworker-delegation-threshold-and-enforcement.md`
  (GitHub #255, merged) — the stop-time read-delegation audit: the 400-line
  trigger, the residual-non-compliance metric, the denominator, the existing
  excluded classes (code-class `--allow-code`, reviewer-path), and detection
  parity. This draft adds one exclusion class; it does not re-derive the audit.
- `docs/issues_drafts/86-read-delegation-reviewer-carveout-per-session.md`
  (GitHub #264, open) — repairs the reviewer-path predicate so the denominator
  is not `0/0`. **Blocking precondition:** #264 must be merged first; both edit
  the same exclusion taxonomy.

## Goal

A Cursor AO worker's normal way to read in-tree source is its native semantic
codebase index — targeted chunk retrieval, not whole-file reads. This carve-out
treats in-tree source as index territory **by policy** (it does not assert, or
require proof, that the index served any specific read). Forcing those reads
through a `coworker ask` round-trip adds a lossy hop and CLI overhead for
marginal-to-negative savings, and the audit today imputes a phantom delegation
obligation for them under detection parity with the no-index Claude architect.

Make the rule simple: **if the corpus is tracked first-party source-code that
Cursor's code index covers, the worker reads it through the index and owes no
coworker delegation. Everything else — CI/job logs, diffs, fetched external
docs/URLs, vendored or generated dumps, and tracked non-code bulk (markdown/
JSON/data, coworker's cheap-text territory) — keeps the existing read-delegation
triggers unchanged.** Coverage is decided by **what** was read (corpus source),
not by any runtime "how it was retrieved" signal.

```behavior-kind
action-producing
```

## Binding surface

- **Index-covered reads are not a delegable obligation for Cursor workers.**
  Reading tracked first-party source-code files in the worker's own worktree is
  code-index territory; it does not trigger coworker read-delegation regardless of
  file size. The index already did the targeted retrieval — there is no bulk I/O
  to offload to the cheap model. (Tracked non-code bulk — markdown/JSON/data — is
  **not** in this carve-out; it stays delegable under the existing triggers.)
- **Out-of-index bulk still delegates, unchanged.** Corpus the index does not
  serve keeps the current #255 triggers (>400 combined lines / >200-line diff or
  log): CI and job logs, diffs, content fetched from external URLs/docs, and
  vendored or generated dumps. A Cursor worker is flagged for skipping delegation
  on those exactly as before.
- **Classification is by corpus source, not a runtime retrieval signal.**
  `index-served` is decided by what the unit read: tracked source files inside
  the worktree (index-covered) versus logs/diffs/external/vendored material
  (out-of-index). This is read from the audit's **existing** per-unit record —
  the read `path`, the `surface` (cursor/claude), and the per-unit stable `key`
  are already captured (see `scripts/fixtures/read-delegation-audit/`), so the
  classification needs **no new capture pipeline and no AO core / plugin /
  runtime change**.
- **Deliberate scope: corpus source, not proof-of-index-retrieval.** The
  carve-out exempts a Cursor in-tree source read on the basis that it is index
  territory, **without** requiring a per-read signal proving the index (vs. a
  plain full-file read) actually served it. This is an explicit operator choice
  to keep the rule simple: the edge it forgoes — a Cursor worker full-file-reading
  a large *tracked in-tree source* file — is judged not worth a runtime-capture
  pipeline to police, because routing in-tree source through coworker yields
  marginal-to-negative savings anyway. The exemption is bounded to **tracked
  in-tree source under allowed roots**; it does **not** extend the trust to
  generated, vendored, log, diff, or external corpus (next bullet).
- **Two-phase classifier — safety fences first, then corpus classification.**
  Mixing the secret fence, path canonicalization, and denominator exclusion in
  one chain is unsafe; the classifier runs in two ordered phases.
- **Phase A — safety fences and input validation (evaluated first, independent
  of path canonicalization):**
  - **#52 secret/private fence** is decided from the **captured read-time fence
    signal** the #52 mechanism already records — **not** re-derived from the
    stop-time path, so a malformed/symlink-escaping/uncanonicalizable path cannot
    drop a protected read out of the fence. A fenced read emits a visible fence
    record and is **never** delegable and never `index-served`; it can **never**
    fall through to "ordinary out-of-index" (a canonicalization/symlink failure
    must not turn protected corpus into a coworker-delegation obligation).
  - **Surface validity:** `index-served` eligibility requires a **known Cursor
    surface**, matched against the **committed surface enum + normalization table**
    in the classifier-input manifest (so captured spellings like `cursor-agent`/
    `cursor-cli`/Composer all resolve correctly rather than being misread as
    delegable misses). A missing, malformed, unknown, or non-Cursor surface
    (Codex/Claude) can **never** earn `index-served` — it fails closed to
    non-index-served.
  - **Field-presence validation (fail-closed):** any verdict-affecting captured
    field that is **missing, null, or malformed** (fence signal, code-class gate
    signal, surface, captured commit, classifier-manifest hash, path, line count,
    kind) — including records produced by an older capture/fixture path — takes the
    **same distinct blocking failure status, artifact, and failing CI outcome** as
    a conflict. A missing field is never silently defaulted to a clean/excludable
    value.
  - **Audited-git-state binding:** classification is resolved against the commit
    the unit's reads were captured at, and the audit records the classifier inputs
    it used (git-tracked set + the committed deny-pattern / allowed-root /
    source-code-classifier / Cursor-index-ignore lists, by manifest hash). If the
    captured work-unit head does not match the checkout being classified, the
    audit takes a **distinct, blocking failure status** (not "clean", not a miss)
    with a **persisted, reviewer-visible artifact** naming the mismatch — never a
    silent status transition that reads as a pass (guards the worker-head-drift
    and silent-status classes). The same blocking-status-plus-artifact rule
    applies to the same-key-conflict audit failure (AC11).
- **Phase B — ordinary corpus classification over a canonical, git-tracked
  path.** The read path is normalized to a **canonical, repo-root-relative** path
  (realpath; resolve `..`, symlinks/junctions, case and separator differences —
  this repo runs under WSL where the same file appears as `/mnt/c/…`, backslash,
  and POSIX forms), then classified **by corpus kind before path predicates**,
  first match wins:
  **(1)** **code-class** — keyed to the **specific captured read's** explicit
  `--allow-code` gate signal (read-level `isCodeClass`); it applies **only to that
  delegated code read**, **never inherited** by sibling reads in the same unit
  (a unit-level `codeClassGated` flag does not exempt the unit's *other* reads), so
  a gated code read plus an ungated >200-line log in one unit still flags the log.
  **(2)** **corpus-kind short-circuit:** a read whose captured `kind` is
  diff / log / external / fetched is **out-of-index delegable** under the existing
  triggers **regardless of its path** — a diff or external artifact carrying a
  `src/`-looking path can **never** reach `index-served`. Only a plain in-tree
  source-**file** read continues past this step. **(3)** generated/vendored
  deny-patterns (committed `vendor/**`, generated snapshots, declaration dumps,
  third-party-source fixtures) **without** the gate signal → **out-of-index
  delegable** (flagged above the floor; not `index-served`, not silently dropped).
  **(4)** `index-served` — **only** for a plain **source-file read** (captured
  `kind` is a first-party file read, not diff/log/external) of a **first-party
  tracked source-code** file the code index actually covers: canonical path inside
  the repo root (no symlink/junction escape), in the **git-tracked** set, under a
  committed **allowed source root**, matching the committed **source-code
  classifier** (extensions **plus** known extensionless/config-source filenames
  like `Dockerfile`/`Makefile` — not markdown/JSON/data/doc, which are coworker's
  cheap-text delegable corpus), **not excluded by the committed Cursor
  index-ignore inputs** (`.cursorignore` / index config — a tracked file the repo
  excludes from indexing is not index-covered, so it is **not** `index-served`),
  and **not** a submodule/gitlink/nested-worktree path (those are **always**
  out-of-index — no allowlist — since a submodule reads as tracked at the parent
  path but carries external corpus); **(5)** everything else (logs,
  diffs, fetched external, **tracked non-code bulk under an allowed root**,
  index-ignored source, untracked/ignored, canonicalization failure) →
  out-of-index under the existing triggers (fail-closed). The deny-pattern,
  allowed-source-root, source-code-classifier, and Cursor-index-ignore sets are
  **committed, deterministic** inputs in the classifier-input manifest, not
  inferred. Because code-class is a gate signal and `index-served` requires its
  absence, steps (2) and (3) are mutually exclusive — neither can shadow the other.
- **Allowed source roots must be narrow first-party source roots.** The committed
  allowed-root list may **not** be the repo root or a known bulk/data/doc root
  (`docs/**`, `scripts/fixtures/**`, research/dump corpora) without explicit
  fixture justification — a broad root would let committed external dumps or doc
  corpora be excluded as `index-served`. The list is validated against this
  invariant, not merely "committed."
- **Exclusion accounting comes from the captured read record, not a disk
  re-read.** The excluded/included line counts and the denominator math derive
  from the **immutable per-read capture** the audit already records (`path`,
  `lines`, `kind`), so a file changing on disk between the worker's read and the
  stop-time audit cannot shift counts between reruns — preserving idempotency.
- **The carve-out is per-read; the denominator is the delegable subtotal.**
  Exclusion applies to each `index-served` read individually, never to the whole
  unit. A mixed unit's audit output reports its **included delegable reads** and
  its **excluded `index-served` reads** separately, and the unit's
  flag/denominator decision is derived **only from the included delegable
  subtotal** — one index-served read never exempts a unit's delegable reads, and
  one delegable read never pulls index-served reads back in.
- **Excluded volume is reported as a visible side metric.** Total `index-served`
  excluded line volume (per unit and per session) is emitted as a **non-blocking**
  side metric — not a delegation miss, not in the denominator — so the carve-out
  cannot silently hide context growth from a reviewer. (No enforcement threshold
  here; session-level accounting stays the separate out-of-scope concern.)
- **New excluded-from-denominator class: `index-served`.** A Cursor unit whose
  reads were all index-covered in-tree source is excluded from the audit
  denominator, alongside the existing code-class and reviewer-path exclusions —
  not counted as a miss. A unit with any out-of-index bulk read keeps that read
  in the denominator.
- **The trigger floor counts delegable (out-of-index) corpus only.** #255's
  ">400 combined lines / >200-line diff or log" floor is computed over the
  unit's **delegable** reads — the out-of-index corpus. Index-covered in-tree
  source lines do **not** add into the combined-line total, because they are not
  delegable bulk to begin with. So a mixed unit (e.g. 350 lines of log + a large
  in-tree source read) is judged on its 350 delegable lines, not the combined
  total — the in-tree source read is excluded, not summed in. This is a
  deliberate change to *what the floor measures* (delegable volume, not total
  context), consistent with the carve-out; a boundary fixture pins it.
- **Parity holds at the rule level; the index is the only difference.** Both
  surfaces share one rule — out-of-index bulk above the floor is a delegable
  obligation. Claude/Codex have no index, so all their source reads stay
  delegable; Cursor's differ only because the index genuinely covers in-tree
  source. No surface-specific belief-based blanket skip.
- **The secret/private fence (#52) is orthogonal and unchanged.** Secret or
  private-data corpus is never sent to coworker and never a delegation
  obligation, indexed or not. `index-served` does not touch it.

This draft adds no pre-read hard block; there is no PreToolUse hook redirecting
reads today and none is introduced. The change is to the policy prose and the
stop-time audit's classification only.

## Files in scope

- `prompts/agent_rules.md` — read-delegation section: state the index-coverage
  carve-out (Cursor in-index source reads need no delegation; out-of-index bulk
  follows the existing triggers).
- Every Cursor rule file that surfaces coworker read-delegation policy — today
  `.cursor/rules/coworker-delegation.mdc` and
  `.cursor/rules/coworker-rtk-read-exploration.mdc` — kept consistent as pointers;
  none left stating the old "all source reads delegate" behavior for Cursor. The
  set is pinned by a **committed manifest** of policy-bearing Cursor rule files
  (not "known surfaces"); the consistency scan fails on any unmanifested
  `.cursor/rules/**` file that carries read-delegation policy.
- The stop-time read-delegation audit implementation and its fixtures/tests —
  `docs/read-delegation-audit.mjs` (+ `.d.mts`) and
  `scripts/fixtures/read-delegation-audit/**` — which compute the flag verdict,
  denominator, and parity for #255/#264. Add the `index-served` corpus-source
  classification there. (This implementation is **outside** the denylist —
  `vendor/** packages/core/** .ao/**` do not cover it — so the denylist does not
  block the build.)
- A **committed classifier-input manifest** — the deny-pattern set, allowed
  source-root list, source-code classifier (extensions + extensionless source
  filenames), the Cursor index-ignore inputs (`.cursorignore`/index config), and
  the **accepted Cursor-surface enum + normalization table** (the captured
  surface spellings — e.g. `cursor`, `cursor-agent`, `cursor-cli`, Composer —
  that count as a known Cursor surface, case-normalized) — so classification is
  deterministic and reviewable, not inferred at runtime.
- `.github/workflows/**` — the CI workflow that runs the audit fixture suite on
  every PR, plus the repo-verifiable workflow-presence check (AC13). Without this
  the suite can exist but never gate PRs.
- `docs/coworker-read-delegation-audit.md` — document the third exclusion class.
- `docs/issues_drafts/00-architecture-decisions.md` §S — record the carve-out
  and why it does not break #255 parity.

## Files out of scope

- The 400-line threshold value (#255's calibration stands).
- The secret/private provider-input fence (#52, unchanged).
- The reviewer-path predicate (owned by #264).
- Any AO core, vendor, plugin, or runtime behavior; any new operator process.
- Cross-work-unit / session-level context accumulation — a pre-existing property
  of the per-unit audit model from #255, not worsened here; `index-served` must
  not be used to reset accumulation a unit would otherwise count.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

## Decisions (design analysis)

**Problem.** #255 built detection parity because Cursor workers delegated zero
times and the audit could not distinguish "legitimately exempt" from "skipped
the obligation." Parity closed that hole by treating every Cursor source read as
a potential miss. But Cursor reads in-tree source through its index by
construction — those reads were never bulk I/O to offload. The audit is
measuring a phantom obligation for them.

**Tension.** A naive "Cursor uses an index, so Cursor never delegates" carve-out
reopens the exact hole #255 closed: a worker could skip delegating a CI log dump
or an external doc fetch and claim "index." Resolution: scope the carve-out to
**what the index actually covers** — tracked in-tree source — and keep
everything else (logs, diffs, external, vendored) on the existing triggers. The
boundary is the corpus source, which is already in the audit's read record.

**Options considered (cheapest sufficient executor):**

1. **Per-read runtime "materialized chunk vs full-file" signal** (capture how
   the index delivered each read, measure materialized bytes). Most precise, but
   requires a capture pipeline that may not be observable without AO core
   changes, plus a discovery/feasibility gate before anything ships. Rejected as
   over-engineered for the value — it polices an edge (Cursor full-file-reading
   in-tree code) the operator judged not worth the machinery.
2. **Blanket Cursor exemption from read-delegation entirely.** Simplest prose,
   but stops delegating CI logs / diffs / external bulk that the index does *not*
   cover — reopens the #255 volume hole. Rejected.
3. **Corpus-source carve-out (chosen).** Classify each Cursor read as
   index-covered (tracked in-tree source) or out-of-index (logs/diffs/external/
   vendored) by its source — already in the read record. In-index → exempt;
   out-of-index → existing triggers. No new capture pipeline, no discovery gate,
   no AO core change. Sufficient: it exempts the genuine index path while keeping
   enforcement on the bulk that actually needs offloading.

**Class enumeration (so the rule covers the class, not the case):**

| Cursor unit read | Index covers it? | Verdict |
| --- | --- | --- |
| Tracked first-party **source-code** file under an allowed root | yes | `index-served`, excluded |
| Tracked **non-code** bulk (markdown/JSON/data) under an allowed root | n/a | delegable — out-of-index (coworker's cheap-text corpus) |
| The specific read delegated via `--allow-code` (read-level gate signal) | n/a | `code-class` — **only that read**, not inherited by sibling reads |
| CI / job log (any path) | no | kind short-circuit → existing trigger |
| Diff (>200 lines, even on a `src/` path) | no | kind short-circuit → existing trigger |
| Fetched external doc / URL (even under a source-like path) | no | kind short-circuit → existing trigger |
| Vendored / generated dump (incl. committed under a source path) | no | deny-pattern → out-of-index delegable; `code-class` only if explicitly `--allow-code`-gated, else flagged above floor |
| Submodule / gitlink / nested-worktree path | no | **always** out-of-index (no allowlist) |
| Tracked source excluded by `.cursorignore` / index config | no | not index-covered → ordinary out-of-index |
| Untracked / ignored file under an allowed root | no | not `index-served` — ordinary out-of-index |
| Secret / private-data file | n/a | #52 fence — never delegable, never an obligation |
| Mixed (in-tree source + out-of-index bulk) | partial | per-read: out-of-index reads counted; in-tree source reads excluded; denominator from the delegable subtotal |

**GPT adversarial loop (decision trail).** 10 passes against the custom GPT
(fresh chat each pass, compact settled ledger). Accepted (draft revised):
materialized-vs-named scope made visible (runtime-capture option rejected per
operator); deterministic classifier with committed precedence; floor measures
delegable out-of-index volume only; canonical-path + git-tracked + WSL
normalization; two-phase classifier (safety fences first); #52 fence decided
read-time, independent of canonicalization; surface-validity + git-state binding
+ field-presence fail-closed → distinct blocking status with visible artifact;
code-class = explicit per-read `--allow-code` gate signal (not content, not
unit-inherited); `index-served` scoped to first-party tracked **source-code**
(extensions + extensionless filenames), excluding `.cursorignore`-ignored,
submodule/gitlink, and (kind short-circuit) diff/log/external on source paths;
per-read identity (one committed deterministic formula); duplicate/conflict
semantics; full predicate-matrix exclusion record; non-blocking excluded-volume
side metric; #264 preflight; CI gate that actually-runs-and-fails (anti-neuter
meta-check + negative self-test); committed classifier-input manifest +
`.github/workflows/**` in scope. Rejected/parked: runtime proof-of-index-service
(operator scope choice); blanket Cursor exemption (#255 hole); session-level
accumulation enforcement (pre-existing, out of scope); `Issue: TBD` (assigned at
sync). The pass-10 findings (per-read code-class scope, read-kind guard,
anti-neuter CI meta-check) were **applied after the final GPT pass** and are
therefore **not GPT-re-reviewed** — they are covered by the normal Codex
architect review that runs next.

GPT loop: 10 passes; stopped because cap-10; last-pass accepted=3; final STATE=completed_valid VALIDATION=ok pass=90635331-557a-4ee5-811e-1102534f6af4 sha=a3ef34a5286e01918c0d603d5f9b92af4b258d3d983dabcca2072b09b5d1e64e
post-GPT change not re-reviewed: pass-10 fixes (per-read code-class, read-kind short-circuit, anti-neuter CI meta-check) applied after pass 10; current draft sha=83fc02a32b90ffe39a1067ac16f18baeb8e5d255a4d136a48920c8663e7b3fe2 — covered by the pending Codex architect review.

## Acceptance criteria

1. `prompts/agent_rules.md` read-delegation states the carve-out: a Cursor worker
   reading **tracked first-party source-code** through its index owes no coworker
   delegation, regardless of file size; everything the code index does not serve
   keeps the existing read-delegation triggers — CI/job logs, diffs, fetched
   external docs/URLs, vendored/generated dumps, **and tracked non-code bulk
   (markdown/JSON/data), which stays coworker's cheap-text delegable corpus**. The
   rule keys to corpus source, not to a runtime retrieval signal, and the
   secret/private fence (#52) is restated as unchanged.
2. Every Cursor rule file that can surface read-delegation policy is updated to
   the carve-out or shown not-applicable; each stays a pointer (no duplicated
   policy). The policy-bearing Cursor rule set is a **committed manifest**, and a
   repo-verifiable scan (a) asserts no stale "Cursor delegates all source reads"
   wording remains over the repo minus denylisted/generated/vendored paths and
   (b) **fails on any unmanifested `.cursor/rules/**` file that carries
   read-delegation policy**; any allowed exception is explicitly allowlisted.
   Generated prompt snippets are covered by **CI regenerating them from their
   source templates and diffing against the committed artifact** (or scanning the
   concrete agent-consumed artifact) — so a stale committed/cached generated file
   cannot keep "all source reads delegate" wording while the template scan passes.
3. The audit recognizes a third excluded-from-denominator class, `index-served`,
   distinct from code-class and reviewer-path, documented in
   `docs/coworker-read-delegation-audit.md`.
4. The audit classifies a Cursor unit's reads by corpus source: tracked in-tree
   source reads under the allowed source roots are `index-served` (excluded from
   the denominator); out-of-index reads (logs/diffs/external/vendored) stay in the
   denominator under the existing triggers. A fixture proves a Cursor unit that
   read only in-tree source without delegating is **not** flagged. **Every
   `index-served` exclusion emits a per-read, reviewer-checkable record** —
   symmetric with the #52 fence visibility — carrying the **full predicate matrix**
   the exclusion rested on: canonical path, git-tracked result, matched allowed
   root, source-code-classifier match, Cursor-index-ignore result, surface
   normalization, submodule/gitlink rejection, the precedence branch, per-read
   identity, excluded line count, denominator impact, **plus the captured commit
   and classifier-manifest hash** — so a reviewer can verify the *whole* reason a
   unit left the denominator and detect a stale manifest/classifier (no silent
   drop, no false-clean audit). A fixture asserts the record carries every
   predicate. (Field names are the planner's; the evidence must be present.)
5. **Two-phase classifier — safety fences first, then canonical-path corpus
   classification.** Phase A (independent of canonicalization): the #52 fence is
   decided on corpus identity and **never** falls through to delegable
   out-of-index even when the path is malformed/symlink-escaping/uncanonicalizable
   (a fixture proves a secret with a broken path is still fenced with a visible
   record, never delegable); `index-served` eligibility requires a **known Cursor
   surface** so a missing/unknown/Codex/Claude surface fails closed to
   non-index-served (a fixture proves it); and classification binds to the unit's
   captured commit + committed classifier-input manifest, failing the audit on a
   captured-head vs checkout mismatch rather than emitting a drift-dependent
   verdict. Phase B (over the canonical, repo-root-relative path; `..`/symlink/
   junction/case/separator resolved) classifies **by corpus kind before path
   predicates**, first match wins — **(1)** `code-class` keyed to the **specific
   captured read's** explicit `--allow-code` gate signal (read-level
   `isCodeClass`), applied **only to that delegated code read** and **never
   inherited** by sibling reads in a gated unit; **(2)** corpus-kind short-circuit:
   any read whose captured `kind` is diff/log/external/fetched is out-of-index
   delegable regardless of path (a `src/`-pathed diff/external can never reach
   `index-served`); **(3)** generated/vendored deny-patterns without the gate
   signal → out-of-index delegable (flagged above the floor); **(4)**
   `index-served` only for a plain source-**file** read; **(5)** ordinary
   out-of-index. An un-delegated source read never matches code-class and so cannot
   shadow `index-served`. `index-served` requires a
   **first-party tracked source-code** file the index covers: canonical path inside
   the repo root, in the **git-tracked** set, under a committed **allowed source
   root**, matching the committed **source-code classifier** (extensions plus known
   extensionless/config-source filenames; markdown/JSON/data/doc is **not**
   `index-served` — it stays delegable out-of-index), **not** excluded by the
   committed **Cursor index-ignore** inputs (`.cursorignore`/index config), and not
   a submodule/gitlink/nested-worktree path. The allowed-root list is validated to
   be **narrow first-party source roots** — not the repo root or a known bulk/data/
   doc root (`docs/**`, `scripts/fixtures/**`) without fixture justification.
   Fixtures prove: a **gated code read plus an ungated >200-line log in one unit**
   still flags the log (code-class is per-read, never inherited); a **>200-line
   diff targeting a `src/` first-party path** stays out-of-index (kind short-circuit,
   never `index-served`); **fetched external content under a source-like path**
   stays out-of-index because its kind is external; generated/vendored-under-source-
   path; an **un-delegated** source-code-bearing vendored read stays out-of-index
   delegable and is flagged above the floor (only an **explicitly `--allow-code`-
   gated** read is code-class);
   an un-delegated first-party source read reaches `index-served` (not shadowed by
   code-class); **a tracked but Cursor-index-ignored source file stays delegable**;
   tracked non-code bulk (markdown/JSON) under an allowed root stays delegable;
   extensionless source (`Dockerfile`) classifies as source-code while a bulk JSON/
   data file does not; untracked/ignored-under-allowed-root; a submodule/gitlink
   path is always out-of-index (no allowlist); every accepted Cursor surface
   spelling in the manifest enum (`cursor`/`cursor-agent`/`cursor-cli`/Composer,
   case-varied) normalizes to a known Cursor surface; accidentally-broad-root
   rejected; and WSL/cross-platform path forms (`/mnt/c/…`, backslash, `..`,
   symlink escape) all classify deterministically.
6. Boundary fixtures prove a Cursor unit that skipped delegation **is** flagged
   for each existing out-of-index trigger separately — a **>200-line log**, a
   **>200-line diff**, and **>400 combined lines** of fetched external/non-log
   corpus — `index-served` covers none of them.
7. **The trigger floor measures delegable (out-of-index) volume only, per-read.**
   A boundary fixture proves a mixed unit whose out-of-index reads stay **below**
   the floor is not flagged even when its in-tree source reads are large (the
   excluded source lines do not sum into the combined-line total), while the same
   unit with out-of-index reads **above** the floor is flagged. Exclusion is
   **per-read, not per-unit:** the mixed-unit audit output reports its included
   delegable reads and its excluded `index-served` reads **separately**, and the
   flag/denominator decision is derived **only from the included delegable
   subtotal** — one index-served read never exempts the unit's delegable reads,
   and one delegable read never pulls index-served reads back in. Line counts come
   from the immutable captured read record, not a disk re-read. A separate
   **non-blocking** side metric reports total `index-served` excluded volume (per
   unit and session) so the carve-out does not hide context growth.
8. The residual-non-compliance metric stays measurable: `index-served` units are
   excluded like the other non-delegable classes and the metric does not regress
   to `0/0` for a realistic mixed Cursor session (consistency with #264).
9. **Parity preserved at the rule level:** a fixture proves Claude and Cursor
   yield the same verdict for the same out-of-index bulk read; the only divergence
   is that Cursor's in-tree source reads are index-covered and Claude's are not.
10. **Corpus-scope guard:** a fixture proves (a) a source-code-bearing vendored/
    generated read is `code-class` **only when that specific read is explicitly
    `--allow-code`-gated** (never inherited by sibling reads in the same unit); an
    un-delegated one stays out-of-index delegable and is flagged above the floor
    (never silently dropped, never `index-served`), and (b) a secret/private-fenced
    (#52) read is classified under the fence with a visible record — never
    `index-served`, never a delegation obligation, and never silently absent (no
    reviewer false approval).
11. **Idempotent classification with explicit duplicate/conflict semantics over a
    per-read identity:** records are keyed by a **single committed, deterministic
    per-read identity** — the per-unit `key` **plus** a committed read
    discriminator — **not** the per-unit key alone. Exactly **one** identity
    formula is committed (not an either/or), and it satisfies the invariants:
    **stable under capture reorder**, **distinguishes repeated reads of the same
    path**, and **stable across crash/resume and CI retry** — fixtures for
    reordered reads, repeated same-path reads, and crash/resume duplicate-append
    prove it. Distinct reads within one mixed unit are never mistaken for
    conflicting duplicates (a same-unit multi-read fixture proves it). A rerun (worker crash/resume, CI retry, reviewer
    recheck) yields identical denominator/metric output. **Exact-duplicate**
    records (same per-read identity) are de-duped (counted once) **only when they
    also match on every verdict-affecting captured field** — at minimum canonical
    path, line count, kind, surface, captured commit, classifier-manifest hash,
    fence signal, and code-class gate signal. **Records with the same per-read
    identity that differ in any of those fields are a conflict, not a duplicate**,
    and drive the audit into the **distinct blocking failure status with a
    persisted, reviewer-visible artifact** (per the Phase A audited-state rule) —
    not a clean pass, not a miss, never an arbitrary pick (false-approval/
    false-miss and silent-status guard). Fixtures cover the same-unit multi-read
    (not a conflict), the all-fields-equal duplicate-append (de-duped), and the
    differs-by-commit / differs-by-manifest-hash / differs-by-gate-signal conflict
    cases as well as the clean re-run. (Uses the audit record's existing captured
    fields; no new schema or capture.)
12. **#264 precondition enforced, not just stated:** the implementation does not
    land until #264's reviewer-path predicate fix is merged with its per-work-unit
    fixtures passing — pinned by a preflight/CI assertion (the reviewer-path
    fixtures are present and green) so `index-served` cannot be added on top of the
    unrepaired `0/0` denominator. If #264 is not merged, this issue stays blocked.
13. **Repo-verifiable CI gate (presence + actually-runs + fails):** a CI workflow
    runs the audit fixture suite on every PR and fails when it fails. A
    repo-verifiable meta-check asserts not just presence/reference but that the
    workflow **actually gates PRs**: it has the PR trigger, the audit job has **no
    unconditional skip** (`if: false`, disabling path filters) and **no
    `continue-on-error`** / exit-status-swallowing wrapper on the audit step, and a
    **negative self-test** proves a deliberately failing fixture produces a failing
    check (so a neutered workflow that references the suite but ignores its result
    cannot pass). The **distinct blocking audit status** (captured-head mismatch /
    same-key conflict / missing-field) must surface as that failing check outcome,
    not merely a persisted artifact. Making the check a *required* merge gate is
    operator branch-protection config (adoption, with a manual verification item),
    not something a repo file can assert.

```positive-outcome
asserts: given a captured Cursor work unit whose reads were all tracked first-party source-code files under an allowed root and that did not delegate, the audit classifies it index-served and excludes it from the denominator without flagging it; AND given a captured Cursor unit that skipped delegation on an out-of-index bulk read (>200-line log, >200-line diff, or >400 combined lines of fetched external content), the audit flags it; AND given a mixed unit, the out-of-index read stays in the denominator while the in-tree source-code read is excluded
input: external-tool-output
provenance: sample-backed
```

## Upgrade-safety check

- No AO core / vendor / `packages/core` edits.
- No new repo secret; the provider-input fence (#52) is unchanged.
- No new operator env var, process, or `ao` restart.

## Verification

1. Read `prompts/agent_rules.md` read-delegation: the index-coverage carve-out is
   present, keyed to corpus source, with out-of-index bulk still triggering and
   the #52 fence restated (AC1).
2. Run the repo-verifiable stale-wording scan; confirm no Cursor rule file states
   the old "all source reads delegate" behavior, the scanned set is a committed
   manifest, the scan fails on an unmanifested policy-bearing `.cursor/rules` file,
   and CI regenerates generated prompt snippets from templates and diffs them so a
   stale committed/consumed artifact cannot pass (AC2).
3. Run the audit fixture suite: in-tree-only Cursor unit not flagged and its
   `index-served` exclusion record present (AC4); two-phase classifier holds —
   secret-with-broken-path still fenced (never delegable), unknown/Codex surface
   fails closed to non-index-served, missing/malformed verdict-affecting field
   drives the blocking-status artifact, captured-head vs checkout mismatch drives
   the blocking-status artifact, a gated code read plus an ungated >200-line log in
   one unit still flags the log (code-class per-read), a >200-line diff on a `src/`
   path and fetched external content under a source-like path both stay out-of-index
   (kind short-circuit, never `index-served`), an un-delegated first-party source
   read reaches `index-served` (not shadowed by code-class), an un-delegated
   vendored source read stays out-of-index delegable and is flagged above the floor
   (only an explicitly `--allow-code`-gated read is code-class), a
   `.cursorignore`-excluded
   tracked source file stays delegable, tracked non-code bulk (markdown/JSON) under
   an allowed root stays delegable, extensionless source classifies as source-code
   while bulk JSON/data does not, untracked/ignored-under-allowed-root,
   submodule/gitlink always out-of-index, every accepted Cursor surface spelling
   normalizes, accidentally-broad-root rejected, and WSL/cross-platform path forms
   all classify deterministically (AC5); out-of-index Cursor unit flagged at
   each of the >200 log, >200 diff, and >400 combined external boundaries (AC6);
   mixed below/above-floor boundary splits per-read with the denominator from the
   delegable subtotal and the excluded-volume side metric emitted (AC7);
   Claude/Cursor parity on the same out-of-index read (AC9); un-delegated vendored
   code stays delegable while gated vendored code is code-class, and secret routes
   to the fence with a visible record (AC10); per-read identity — same-unit
   multi-read not a conflict, all-fields-equal duplicate de-duped, and a
   differs-by-commit/manifest-hash/gate-signal conflict drives the blocking-status
   artifact — yields the specified output (AC11).
4. Confirm the metric is non-`0/0` for the mixed-session fixture (AC8) and the
   audit output documents the `index-served` class (AC3).
5. Confirm the #264 reviewer-path fixtures are present and green and the
   preflight assertion blocks landing otherwise (AC12).
6. Confirm the CI workflow runs the fixture suite and fails on failure; the meta-
   check proves it actually gates PRs (PR trigger, no unconditional skip / no
   `continue-on-error` on the audit job, negative self-test that a failing fixture
   fails the check); the blocking audit status maps to that failing outcome; and
   the manual branch-protection adoption item is recorded (AC13).
