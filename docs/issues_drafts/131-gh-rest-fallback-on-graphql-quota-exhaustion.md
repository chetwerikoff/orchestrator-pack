# Always-REST `gh` transport for pack reads (intercept on PATH)

GitHub Issue: #431

## Prerequisite

- **#318** / **#128** — pack `scripts/` PATH prepend + `BASH_ENV` channel (reuse for `scripts/gh`; do not redesign wiring).
- **#107** — `agentConfig.env` propagation gap is upstream; wrapper must work with today's `BASH_ENV` leg.

## Prior-art recon

| Source | Verdict |
|--------|---------|
| `docs/issues_drafts/` grep (`graphql`, `gh REST`, `rate-limit`, `gh wrapper`) | **No dedicated draft** for versioned always-REST `gh` transport on PATH. |
| `gh issue list --search "graphql OR gh REST OR rate limit gh"` (2026-06-23) | **No matching open/closed issue** in `chetwerikoff/orchestrator-pack`. |
| **#130** / **#129** | Mention "repo-wide GitHub API rate-limit budget" as **out of scope** — budget policy, not transport fallback. |
| **#107** / **#128** / **#318** | Established **PATH prepend of pack `scripts/`** + `BASH_ENV` as the durable env channel when `agentConfig.env` does not reach live Cursor/bash turns. **Reuse that channel** for a `gh` wrapper; do not redesign PATH wiring. |
| `scripts/lib/Gh-PrChecks.ps1` | Already uses **REST** (`gh api …/commits/{sha}`) for `headCommittedAt`; **required check names** come from **branch protection** (`gh api …/branches/…/protection`), compared separately to factual `gh pr checks` output. Wrapper must **not** subsume required-check policy — only reproduce native `gh pr checks` facts. |

**Decomposition verdict:** **new issue** (not a duplicate). Complements out-of-scope rate-budget drafts; does not replace them.

## Problem

The pack routinely exhausts the **GitHub GraphQL API hourly quota** (`graphql.remaining → 0`). Commands such as `gh pr list`, `gh pr view`, `gh pr checks`, `gh pr diff`, `gh issue view`, and `gh repo view` with `--json` are implemented atop GraphQL in `gh` CLI. When GraphQL quota is zero, reconcile loops, reviewer workspace resolution, declaration hooks, and orchestrator turns **fail hard** even though the **REST core bucket** (`core`, ~5000 req/hr authenticated) still has headroom.

**Observed failure (live, 2026-06-23):**

```
GraphQL: API rate limit already exceeded for user ID <id>.
```

exit code **1**; `gh api rate_limit` shows `graphql.remaining: 0` while `core.remaining` is still high.

**Operator pain today:** repeated manual "use REST" instructions; one-off `/tmp` PATH shims that (a) cover only one process tree, (b) miss reviewer workspaces and spawned workers, (c) evaporate on `ao start`, and (d) never reach deterministic PowerShell reconcile scripts.

```behavior-kind
action-producing
```

Bindings ground external producer reality (#117 / #366 class): `gh pr checks` bucket
semantics and REST response shapes for inventory read forms. **v1 has no stderr-based
quota binding** — deferred to v1.1 (see below).

```contract-evidence
binding-id: gh:pr-open:list:headRefOid-shape
binding-type: structured
binding: open PR list REST parity must expose headRefOid on each row (grounding-lane: grounded-now)
producer: gh
evidence: capture@gh-pr-open/open
selector: $.headRefOid
expected: 8e35c0052127b8e156b7c1c80b2774286da16e6f
```

**Spec contract-evidence (v1):** one committed capture (`gh-pr-open/open`) grounds list-shape
parity. **`gh-pr-checks/representative-pr`** and its two bucket bindings ship in the
**implementation PR** (golden `gh pr checks --json`; provenance records **`gh --version`**).
Implementation merge is blocked until that capture + bindings pass `contract-evidence`.

## Goal

Ship a **versioned `scripts/gh` on PATH** that fixes the class (stop draining GraphQL on
reconcile ticks) — **cheapest sufficient executor, no quota stderr detection in v1**:

1. **`scripts/gh` intercepts every `gh` invocation** (reconcile scripts, plugins, ad-hoc LLM)
   when pack PATH adoption is active.
2. **Known inventory read forms → always REST** via `gh api`, unconditionally — no GraphQL
   attempt, no stderr matching. Covers both deterministic scripts and LLM commands that
   match an inventory shape.
3. **Unknown / unlisted argv → passthrough** to real `gh` unchanged. Under rare residual
   GraphQL exhaustion for an unlisted form, the real `gh` error surfaces honestly; fix is
   to add the form to inventory (not manual REST improvisation).
4. **Output parity** — REST path emits the same field shapes callers already parse; golden
   captures gate drift.
5. **PATH prepend** on every AO-managed surface via #318 / #128 — **not** hand-placed `/tmp`
   shims.

## Non-goals

- Repo-wide GraphQL **budgeting**, request coalescing, or backoff policy (#129 / #130 class).
- Replacing every `gh` subcommand — only shapes proven in the inventory below.
- Covering external agents **outside** pack PATH (Cursor global shell, operator laptop without adoption) — **boundary, not defect**.
- Fixing AO-core `agentConfig.env` propagation (#107) — upstream; wrapper must work with today's `BASH_ENV` channel.
- **GitHub Actions scope-guard** — v1 does **not** require workflow PATH adoption; GHA inventory rows are **P1 optional**. Blocking ACs for `pr diff` fail-closed apply to **local/reviewer/orchestrator** surfaces with pack PATH only.
- **`closedByPullRequestsReferences`** on `gh issue view` (draft-discipline) — GraphQL-only;
  REST needs timeline parsing. **Defer to v2**; do not block v1 on this translation.
- **Native Windows `gh.exe` shim** — out of v1. v1 targets **Linux-hosted pwsh** reconcile surfaces (WSL/AO); extensionless `scripts/gh` on PATH is sufficient there.
- **Stderr-triggered REST fallback** for unknown `gh` forms under GraphQL quota exhaustion —
  **deferred to v1.1** (see below). v1 has **no quota stderr detection**.

### Deferred to v1.1

**Stderr-triggered fallback for unlisted ad-hoc `gh` under GraphQL quota-0** — build only
if a real incident occurs with a form not yet in inventory. Rationale: after always-REST on
all known reads, GraphQL exhaustion for unlisted forms becomes rare; stderr matching
(variant text, false positives on secondary/IP limits) is the most fragile 10% — cut from
v1.

**Seed note for future work (not a v1 requirement):** live observation 2026-06-23 —
`GraphQL: API rate limit already exceeded for user ID <digits>.` exit **1**. A v1.1 design
would need narrow GraphQL-prefixed primary-quota matchers and explicit non-triggers for
secondary / IP-unauth messages (not live-validated in v1 scoping).

## Pre-design analysis

### Critical mechanics

**`scripts/gh` routing (v1 — architect decision: always-REST, no stderr detect):**

| argv class | Callers | Transport | Quota detect (v1) |
|------------|---------|-----------|-------------------|
| **Known inventory reads** | Scripts, plugins, LLM matching inventory | **Always REST** via `gh api` | **None** |
| **Unknown / unlisted** | Ad-hoc LLM, new flags | **Passthrough** to real `gh` | **None** — honest `gh` error if GraphQL exhausted |

1. **Always-REST on all inventory reads.** Reconcile ticks and any caller (script or LLM)
   using a known form never touch GraphQL for `pr list` / `pr checks` / etc. Behavioral
   delta is 100% of the time; parity enforced by capture-backed golden tests in ACs.
2. **Unknown forms passthrough.** Unlisted argv goes to real `gh` with identical env/cwd.
   Under GraphQL exhaustion → visible `gh` failure (not silent wrong data, not REST
   guess). Remedy: extend inventory.
3. **Recursion guard (mandatory, single algorithm).** Known forms call `gh api`; without
   guard, `gh api` re-enters `scripts/gh`. One deterministic real-binary resolution;
   negative test when that binary mistakenly points at `scripts/gh`.
4. **`gh pr checks` — factual output only (not required-check policy).** The wrapper
   reproduces **native `gh pr checks --json` output** for runs/statuses that exist. It does
   **not** synthesize expected-but-not-yet-created required checks — native `gh pr checks`
   (without `--required`) does not either. Pack reconcile already obtains required names from
   branch protection and compares separately (existing reconcile contract).

   REST path per PR: resolve head SHA (PR fetch) → paginate `check-runs` → fetch `status` →
   apply **the same deduplication rules as the pinned `gh` version** (record version in capture
   provenance; do not invent "better" dedupe):
   - legacy combined statuses: dedupe by **context**, keep newest;
   - check runs: dedupe by **name / workflow / event**, keep newest by `startedAt`;
   - then compute `bucket` per table below.

   **Completeness limits (honest):** GitHub REST `check-runs` may truncate beyond documented
   suite limits (~1000); document fail-closed when completeness cannot be proven. Pagination:
   `ceil(check_runs_count / per_page)` requests (typically per_page=100).

   **Zero-checks parity:** when native `gh pr checks` errors (e.g. no checks reported), REST
   path must **not** return success `[]` — match native exit/stderr.

   | `bucket` | `state` values (per `gh pr checks --help` / cli#9439) |
   |----------|-----------------------------------------------------|
   | `pass` | `SUCCESS` |
   | `fail` | `ERROR`, `FAILURE`, `TIMED_OUT`, `ACTION_REQUIRED` |
   | `pending` | `EXPECTED`, `REQUESTED`, `WAITING`, `QUEUED`, `PENDING`, `IN_PROGRESS`, `STALE` |
   | `skipping` | `SKIPPED`, `NEUTRAL` |
   | `cancel` | `CANCELLED` |

   Golden captures record **`gh --version`** in provenance; intentional golden refresh when `gh`
   upgrades (compatibility policy in runbook).

5. **Open PR list at scale.** Pack uses `--limit 200` without `commits` (node-limit
   regression). REST `GET /repos/{o}/{r}/pulls?state=open&per_page=100` requires
   **pagination** to 200; map `head.sha → headRefOid`, `base.ref → baseRefName`.
6. **Detached-HEAD reviewer workspace.** Open PR list REST output must preserve
   `headRefOid` for client-side SHA match.
7. **`gh pr diff --name-only` completeness (not naive page ceiling).** REST
   `/pulls/{n}/files` returns at most **3000** files per PR; matching `changed_files` from
   the PR object avoids false fail on PRs with exactly 3000 files. Algorithm:
   - read `changed_files` from `GET /pulls/{n}`;
   - paginate `/pulls/{n}/files`, collect `filename` (and rename semantics per golden);
   - **success** only if `collected_count == changed_files`;
   - **fail-closed** if counts diverge or `changed_files > 3000` (cannot prove completeness).
   On failure: non-zero exit, no complete-looking stdout, stable stderr marker; scope-guard
   callers block (local PATH surfaces; GHA optional P1).
8. **Auth parity.** Every `gh api` REST call must use the **same credential resolution as
   real `gh`** (token, host, enterprise) — critical in GHA where `GITHUB_TOKEN` scope
   differs from local `gh auth`.
9. **Repo slug and host — derive locally, no API.** Resolve **host** and `{owner}/{repo}`
   separately (do not conflate gh host config with repo slug) without a `repo view` network
   call. Precedence (planner owns exact lookup order): explicit
   `--repo` / `GH_REPO` / gh host config → git toplevel for active cwd → remote for that
   checkout → **fail-closed** only on concrete ambiguity (unresolved fork owner, conflicting
   remotes/hosts, cwd outside any git root). **Ordinary git worktrees and detached HEAD are
   supported** when toplevel + remote + host resolve. Every `gh api` call targets resolved host
   or fails.
10. **`--jq` / `-q` — inventory-listed expressions only.** v1 parity covers **only**
    `--jq`/`-q` patterns explicitly in inventory (not arbitrary jq). Includes reviewer
    `pr view --json number,body --jq '{number: .number, body: .body}'` and `pr list --jq
    '.[0].number'`. REST-routed forms must match native stdout/exit for those patterns.
11. **Stale GraphQL cache (cli#12812).** Always-REST on inventory reads **bypasses** this
    for known forms. For unknown passthrough forms under cache-induced failures, operator
    `~/.cache/gh` clear remains workaround — note in runbook.

### How the industry handles this class

- **CLI-as-backend** pattern: wrap `gh` for auth/pagination (common in personal tooling).
- **Prevent GraphQL drain on known reads** — route inventory forms to REST unconditionally
  (GitHub GraphQL and REST have separate rate-limit buckets; v1 does not implement
  stderr-triggered fallback — see Deferred to v1.1).
- **Not** done here: long-running service with connection reuse — overkill for reconcile tick frequency; wrapper is cheaper.

### Architecture sketch

```
Any caller (script / plugin / LLM)
    │
    v
pack/scripts/gh          ← prepended on PATH (#318 channel)
    │
    ├─ argv matches inventory read form?
    │     └─ yes → always gh api REST (no GraphQL) → emit --json-shaped output
    │
    └─ no → passthrough real gh (absolute path, recursion-safe)
              └─ success or honest failure (incl. rare GraphQL quota on unlisted form)
```

**PATH wiring (confirmed pattern, not new invention):**

| Surface | Channel | Notes |
|---------|---------|-------|
| Orchestrator bash turn | `agentConfig.env.PATH` prepend `scripts/` + `BASH_ENV` interposer (#128) | Login shell rebuild drops bare PATH prepend; `BASH_ENV` + DEBUG re-prepend is the durable leg. |
| Spawned workers | AO worker env / `project.env` / same `scripts/` prepend where configured | Planner verifies worker reconcile scripts resolve wrapped `gh`. |
| Reviewer workspace | Inherits AO review-run env when Codex/Cursor reviewer invokes `Get-AutoReviewPrContext` | **Empirical gap today:** `/tmp` shim missed reviewer child — PATH prepend must be in inherited env, not operator tmp. |
| GitHub Actions scope-guard | Workflow `gh` on `ubuntu-latest` | Own token quota; optional later. |
| External agents off PATH | N/A | Operator installs wrapper globally or accepts native `gh` — **documented boundary**. |

### Options (cost / risk / sufficiency) — architect decision recorded

| Option | Cost | Risk | Verdict |
|--------|------|------|---------|
| **A. Fallback-only wrapper** (GraphQL first → catch quota stderr → REST) | Medium + **fragile detect layer** | Survives symptom; **continues draining GraphQL** | **Rejected** |
| **B. Always-REST in scripts only** | Medium helpers | LLM ad-hoc `gh` bypasses | Insufficient alone |
| **C. Always-REST everywhere (no `scripts/gh`)** | High | Every caller must use helpers | Insufficient |
| **D. `agent_rules.md` prose only** | Trivial | Does not reach PowerShell ticks | Insufficient |
| **E. `scripts/gh` intercept: known→always REST, unknown→passthrough** | Medium translation + capture tests | 100% behavioral delta on known forms; mitigated by golden captures | **Accepted v1 ship shape** |
| **F. E + `agent_rules.md` backstop** | E + one clause | Lowest operator/LLM confusion | **Accepted — ship this** |

**v1 explicitly excludes:** stderr quota detection and REST fallback for unknown forms
(deferred v1.1 — only if incident warrants).

## Binding surface

### Inventory — GraphQL-backed `gh` shapes the pack uses

Planner implements REST for **at least** these caller intents via `scripts/gh` **always-REST
routing** (no GraphQL attempt). Exact argv patterns may vary by quoting; semantic
equivalence required:

| Priority | Caller context | Command intent | `--json` / output fields | REST equivalence |
|----------|----------------|----------------|----------------------------|------------------|
| P0 | Reconcile open PR enumeration | `gh pr list --state open --json number,headRefOid,baseRefName --limit 200` | `number`, `headRefOid`, `baseRefName` | `GET /repos/{o}/{r}/pulls?state=open&per_page=100` (paginate ≤200) → map `head.sha`, `base.ref` |
| P0 | Same (narrower) | `gh pr list --state open --json number,headRefOid --limit 200` | `number`, `headRefOid` | Same |
| P0 | Detached HEAD PR match | `gh pr list --state open --json number,headRefOid --limit 200` + client-side SHA filter | `number`, `headRefOid` | Same |
| P0 | Scoped PR fetch | `gh pr view <n> --json number,headRefOid,baseRefName,state` | four fields above | `GET /repos/{o}/{r}/pulls/{n}` — synthesize `state` to match `gh` (`OPEN` / `CLOSED` / `MERGED` from REST `state` + merge fields) |
| P0 | Base ref only | `gh pr view <n> --json baseRefName` / `-q .baseRefName` | `baseRefName` | Same pull object → `base.ref` |
| P0 | PR body | `gh pr view <n> --json body` or `number,body` | `body` (+ `number`) | Same |
| P0 | Reviewer PR+body jq | `gh pr view <n> --json number,body --jq '{number: .number, body: .body}'` | compact JSON | Same fields, emitted jq-shaped stdout |
| P0 | Branch number jq | `gh pr list --head <branch> --json number --jq '.[0].number'` | `number` | Same as branch lookup below |
| P0 | Branch head lookup | `gh pr list --head <branch> --json number` (and `--jq '.[0].number'`) | `number` | Prefer **open PR list + filter `head.ref == branch`**; fail-closed only when **multiple** open PRs match the same head ref (ambiguity), not when fork owner is unknown upfront |
| P0 | Factual CI runs (not required policy) | `gh pr checks <n> --json name,state,bucket,link,startedAt,completedAt,workflow,description` | all listed | PR fetch for head SHA + paginated `check-runs` + `status`; dedupe per pinned `gh` rules; **required names stay in branch-protection reconcile** |
| P0 | Reviewer / declaration / scope | `gh issue view <n> --json body` | `body` | `GET /repos/{o}/{r}/issues/{n}` → `body` |
| P0 | Scope guard diff | `gh pr diff <n> --name-only` | newline paths | `changed_files` parity algorithm (§7); golden rename/delete cases |
| P0 | Reviewer file list | `gh pr diff <n> --name-only` | paths | Same |
| P1 | PR body (CI workflow) | `gh pr view <n> --json body --jq .body` | `body` | Same pull endpoint |
| P1 | Scope guard (GHA) | `gh pr view <n> --repo <r> --json body` | `body` | `GET /repos/{o}/{r}/pulls/{n}` |
| — | Repo slug | `gh repo view --json nameWithOwner` | `nameWithOwner` | **Derive locally** from `git remote` / gh config — **no API call** |
| — | Already REST | `gh api repos/…/commits/{sha}`, `gh api …/protection`, `gh api …/events` | n/a | Unchanged (already on REST bucket) |
| v2 | Draft discipline | `gh issue view … --json closedByPullRequestsReferences` | GraphQL-only field | **Out of v1** — timeline/GraphQL follow-up |

**Explicitly out of v1 inventory / routing:** `gh pr merge`, `gh pr comment`, `gh auth`,
arbitrary `gh api graphql`, and any form not listed above (passthrough to real `gh`).

### `scripts/gh` contract (v1)

- **Intercept:** every `gh` invocation when `scripts/gh` is first on PATH.
- **Known inventory read argv → always REST** via `gh api` (absolute-path delegation for
  recursion safety) — **no GraphQL attempt, no stderr quota matching**.
- **Unknown argv → exec passthrough** to real `gh` (absolute path); preserve argv, cwd,
  env, stdin, stdout, stderr, exit, TTY, and signals. Under GraphQL exhaustion on an unlisted
  form → honest `gh` error (not silent success, not REST improvisation).
- **Auth parity:** REST `gh api` calls use the **same token/host resolution as real `gh`**
  (including GHA `GITHUB_TOKEN` semantics).
- **Output:** stdout compatible with existing parsers on success; **on REST/HTTP/auth/shape
  failure for known routes:** non-zero exit, **no parseable success stdout** (no empty JSON
  array/object masquerading as success), stable stderr marker.
- **Argv matcher contract:** one fixture matrix covers **positive** permutations (flag order,
  `--repo`/`-R`, listed `--jq`/`-q`) and **negative** near-misses (extra JSON fields, unlisted
  filters) → passthrough or stable known-route error, never partial REST route.
- **Recursion guard:** mandatory — `scripts/gh` must not re-invoke itself when calling real
  `gh` or `gh api` (including `--hostname` / GHES). Fixture proves `gh api` delegation does
  not loop through the wrapper.
- **Test-only audit marker:** optional env-gated marker in **tests/dry-run probes only** — not
  part of production runtime contract. Whitelist schema; no secrets in audit output.

### Adoption

- Wrapper lives under pack **`scripts/`** (versioned).
- **PATH prepend** documented in `agent-orchestrator.yaml.example` orchestrator `agentConfig.env.PATH` (already prepends `scripts/` for #318) — wrapper takes precedence as `scripts/gh`.
- **`BASH_ENV` / migration notes:** document that login-shell PATH rebuild requires the same prepend leg as #128 (DEBUG re-prepend or interposer), not only yaml edit.
- **Short `agent_rules.md` backstop:** known read forms of `gh` auto-route to REST via
  `scripts/gh` on PATH; if an unlisted `gh` command fails on GraphQL exhaustion, the form
  is not yet covered — report it (do not improvise REST manually).
- **Platform scope:** v1 adoption probes target **Linux-hosted pwsh** reconcile paths; native
  Windows `gh.exe` resolution is out of scope.
- **Operator step:** post-merge, verify `command -v gh` resolves to pack `scripts/gh` on
  orchestrator turn, worker session, and reviewer workspace.

## Files in scope

- Pack `scripts/` — `scripts/gh` intercept (known→REST / unknown→passthrough), shared REST
  translation helpers, adoption check if needed.
- Tests + `tests/external-output-references/**` captures for `gh pr checks` bucket parity (and at least one open-PR list shape).
- `agent-orchestrator.yaml.example`, `docs/migration_notes.md`, recovery/runbook pointer.
- `prompts/agent_rules.md` — one short backstop clause only.

## Files out of scope

- `vendor/**`, `packages/core/**`, AO core.
- GitHub Actions workflow changes (unless planner folds optional adoption into existing scope-guard job with zero new secrets).
- GraphQL quota budgeting / request reduction (separate future work).

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
```

```allowed-roots
scripts/**
plugins/**
prompts/**
docs/**
tests/**
agent-orchestrator.yaml.example
```

## Acceptance criteria

Grouped (7). Planner owns mechanism; each group is blocking.

### 1. Routing (`scripts/gh`)

- [ ] Known inventory argv → always REST (no GraphQL); unknown argv → exec passthrough with
      stdin/stdout/stderr/exit/TTY preserved.
- [ ] No stderr quota detection in v1; no REST attempt for unknown forms.
- [ ] Matcher contract: positive argv permutations + negative near-misses (one matrix).
- [ ] `gh api` delegation does not re-enter wrapper; `--hostname`/GHES preserved.

### 2. Resolver (repo slug + host)

- [ ] Host and `{owner}/{repo}` resolved separately; git toplevel from cwd; ordinary worktrees
      and detached HEAD supported; fail-closed only on concrete ambiguity.
- [ ] Auth parity with real `gh` (local + GHA contexts).

### 3. `gh pr checks` parity matrix

- [ ] Reproduces **factual** native `gh pr checks --json` (stdout, stderr, exit) — including
      zero-checks error cases (not success `[]`).
- [ ] Dedupe matches **pinned `gh` version** rules (context / name+workflow+event / newest
      `startedAt`); provenance records `gh --version`; collision goldens included.
- [ ] Pagination-complete check-runs + status; fail-closed when REST completeness unprovable.
- [ ] **Does not** synthesize unmaterialized required checks — required policy remains in
      existing branch-protection reconcile.

### 4. `gh pr diff --name-only`

- [ ] `collected_count == changed_files` success rule; fail-closed on mismatch or
      `changed_files > 3000`; rename/delete goldens; local scope-guard blocks on failure.

### 5. Other inventory parity + captures

- [ ] Open PR list, `pr view` (incl. state MERGED), `issue view`, listed `--jq` patterns
      (`body`, `number,body`, `.{number,body}`, `.[0].number`) match native `gh`.
- [ ] Branch lookup via open-list + `head.ref` filter; fail-closed on ambiguous multiples.
- [ ] Implementation PR commits `gh-pr-checks/representative-pr` + bucket contract-evidence
      bindings; `contract-evidence` guard passes; intentional golden refresh on `gh` upgrade
      documented.

### 6. PATH adoption (Linux-hosted pwsh)

- [ ] `command -v gh` → pack `scripts/gh` on orchestrator, worker, reviewer (`BASH_ENV` caveats
      documented); pwsh reconcile probe on Linux-hosted path.
- [ ] Pack-owned scripts static guard: only inventory-covered `gh` read shapes.
- [ ] Deterministic GraphQL-exhausted simulation: inventory reads succeed via REST when native
      GraphQL path would fail.

### 7. Failure behavior + docs

- [ ] Known-route REST failures: non-zero exit, no parseable success stdout, stable stderr.
- [ ] Unknown form under GraphQL exhaustion: honest native `gh` error (passthrough).
- [ ] `agent_rules.md` backstop; runbook with per-PR REST formula, per-tick upper bound, tick
      cadence risk, `gh` upgrade policy, cli#12812 note, external-agent PATH boundary.

```positive-outcome
asserts: with pack PATH adoption on Linux-hosted pwsh surfaces, every inventory `gh` read form
used by reconcile, reviewer, declaration, and scope guard completes via REST when GraphQL quota
is zero; unlisted argv passthrough surfaces honest native `gh` errors; wrapper off PATH leaves
behavior identical to today
input: realistic
```

## Upgrade-safety check

- Wrapper/helpers off PATH → behavior identical to today (real system `gh`).
- No new network endpoints beyond existing GitHub REST surfaces already used by `gh api`.
- Capture fixtures committed; no secrets in captures.
- **Sizing (honest per-PR formula):** for `gh pr checks` REST path per PR per tick:
  `1` PR fetch (head SHA) + `ceil(check_runs_pages)` (typically page size 100; suites may hit
  documented ~1000 check-run truncation — fail-closed if unprovable) + `1` status request.
  Full open-PR scan adds list/view/diff/issue reads. Runbook documents **per-tick REST upper
  bound** from this formula × open PR count × tick cadence (REST `core` ~5000/hr). Hard caps
  remain **#129** out of scope.

## Architect review

**GPT passes 1–5:** completed (passes 1,2,4,5 `completed_valid`; pass 3 malformed). Substantive
fixes folded (required-check policy, REST budget, dedupe pinning, `pr diff` completeness, AC
collapse).

**Architect publish pass (2026-06-23):**

- Contract-evidence: fix `gh-pr-open/open` selector (`$.headRefOid`); defer
  `gh-pr-checks/representative-pr` bucket bindings to implementation PR (spec gate uses one
  committed capture).
- Add `positive-outcome`, `Prerequisite`, `Related`.
- No further GPT pass before publish.

## Related

- **#318** / **#128** / **#107** — PATH / `BASH_ENV` adoption channel.
- **#129** / **#130** — repo-wide API budget policy (out of scope).
- **cli#12812** — stale GraphQL cache (runbook note).

## Verification

- Capture: `gh pr checks` + open PR list goldens with `gh --version` in provenance.
- `pr diff`: fixtures where `collected_count == changed_files`; mismatch and `changed_files > 3000` fail-closed.
- `pr checks`: zero-checks head returns native error shape (not `[]` success).
- GraphQL-exhausted simulation + `gh api` no-recursion/`--hostname` fixtures.
