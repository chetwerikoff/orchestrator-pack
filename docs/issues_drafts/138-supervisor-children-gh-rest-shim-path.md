# Route wake-supervisor children's `gh` reads through pack REST shim

GitHub Issue: [#447](https://github.com/chetwerikoff/orchestrator-pack/issues/447)

## Prerequisite

- `docs/issues_drafts/131-gh-rest-fallback-on-graphql-quota-exhaustion.md` (GitHub [#431](https://github.com/chetwerikoff/orchestrator-pack/issues/431), **open**) — ships `scripts/gh` → inventory matcher → REST for known read argv; unknown argv passthrough. **Already does:** matcher routes supervisor-child inventory shapes (`pr-list-open`, `pr-checks`, `pr-view`, `repo-view-name-with-owner`) when the shim is on PATH. **Does not cover:** wake-supervisor child `PATH` — #431 scopes prepend to AO-managed orchestrator turn / worker / reviewer surfaces via `#318`/`#128`, not `orchestrator-wake-supervisor` children.
- `docs/issues_drafts/136-gh-wrapper-mutual-recursion-terminal-resolution.md` (GitHub [#442](https://github.com/chetwerikoff/orchestrator-pack/issues/442), **open**, **P0**) — identity-based terminal `gh` resolution when `~/.ao/bin/gh` and pack `scripts/gh` coexist. **Merge-order gate:** do **not** prepend pack `scripts/gh` to supervisor-child `PATH` until #442 lands. `GH_WRAPPER_ACTIVE` alone is insufficient (#442 design analysis).
- `docs/issues_drafts/60-orchestrator-wake-supervisor.md` (GitHub #168, closed) and `docs/issues_drafts/71-orchestrator-side-process-supervisor.md` (GitHub #205, closed) — supervised side-process registry and child spawn model this issue extends.
- `docs/issues_drafts/137-gh-detectpr-rest-inventory-route.md` (GitHub [#443](https://github.com/chetwerikoff/orchestrator-pack/issues/443), **open**, backlog) — AO `detectPR` argv REST route; **not** required for supervisor children (verified: no child issues that argv shape).

**Prior-art verdict:** **Genuinely new draft** (not an amendment to #431). #431 builds and adopts the shim on AO-managed surfaces; this issue closes the **deployment gap** for the 13-registry-child wake supervisor (`scripts/lib/Orchestrator-SideProcessSupervisor.ps1` `Start-OrchestratorWakeSupervisorChild` today passes only side-process env vars — **no `PATH` entry** — so children resolve `/usr/bin/gh` and hit GraphQL). Amending #431 would blur ship boundaries (#431 is shim + AO-surface PATH; this is supervisor-child PATH + argv fixture gate).

**Incident context (2026-06-24, verified):** GraphQL bucket exhausted (`graphql.used 5007 / limit 5000 / remaining 0`) while REST `core` remained healthy (`used 1743 / remaining 3257` at verification time). Supervisor children failed `gh pr list` / `gh repo view` → restart storm (**34905** `recovering (attempt` lines in `supervisor.log`) → `System.ObjectDisposedException` in `Start-Process` `StdOutputHandler` → supervisor process exit (`supervisor: stopped (pid=0)` while children still showed working). **Who exhausted GraphQL (5007 calls) is not established** — this draft does not identify that root. **#447 reduces children's sensitivity to GraphQL exhaustion on inventory reads; it does not eliminate the incident class.** Under a sustained restart storm, N+1 `gh api commits` passthrough (up to ~200 per open-PR-list tick) can exhaust REST `core` too. Supervisor crash hardening (restart-storm backoff, crash-safe redirection, null-safe child bindings) is a **co-required, higher-priority** separate spec — architect queued as follow-on draft; neither fix alone closes the 2026-06-24 incident.

## Goal

Every **supervised side-process child** that issues pack-owned inventory `gh` read argv must resolve the pack `scripts/gh` shim first and therefore consume the REST `core` bucket (via inventory routes), not native GraphQL, when GraphQL quota is exhausted. Uncovered argv shapes that still passthrough to native `gh` must be enumerated in verification fixtures. Merge **#442** before supervisor-child `PATH` prepend when `~/.ao/bin/gh` may be on inherited PATH.

```behavior-kind
action-producing
```

## Binding surface

- **Supervisor-child PATH:** When `orchestrator-wake-supervisor.ps1` spawns any registry child (`scripts/orchestrator-side-process-registry.json`), `command -v gh` inside that child must resolve to pack `scripts/gh` (Linux-hosted pwsh path), using the same pack-root resolution the supervisor already knows. Planner chooses mechanism (explicit `PATH` in child env, wrapper script, or equivalent) — contract is observability, not layout.
- **Merge-order (#442):** Supervisor-child `PATH` prepend ships only after #442 terminal resolution is merged (see Prerequisite). Optional: include a cheap no-re-entry / terminal-resolution regression in the same PR if it comes for free — do **not** build a separate "is #442 contract present?" detector for prepend.
- **Inventory coverage:** All argv shapes listed in **Verification — supervisor-child argv inventory** (below) that are marked **REST-routed** must not invoke native GraphQL for the primary read. Passthrough argv (`gh api …`, matcher returns null on `api` root) may still delegate to native `gh` but uses REST endpoints (separate `core` bucket — finite, not immunity).
- **Field-name parity:** Reuse existing `scripts/gh-wrapper.test.ts` parity coverage from #431; do not add a parallel parity harness for supervisor-child argv unless a gap is found.
- **No argv drift without fixture update:** Adding a new `gh` read in any supervised child requires a matching inventory row + fixture before merge (static guard or test harness — planner choice).
- **Out of scope:** Implementing supervisor crash hardening (separate higher-priority draft), extending inventory for AO `detectPR` (#443), operator global `gh` install outside supervisor spawn, `.ao/autonomous-real-binaries.json` `gh` pin policy (#442 OOM mitigation — not touched by #447).
- **Non-goal (invariant, not tested here):** Reconcile business logic unchanged given identical successful `gh` stdout; only transport/PATH differs.

**Operator adoption:** After merge, restart wake supervisor (`orchestrator-wake-supervisor.ps1 -Action Stop` then `-Action Start` per runbook). Confirm `command -v gh` inside a representative child resolves pack shim (live probe — not CI proof). If `~/.ao/bin/gh` is on inherited PATH, verify #442 terminal resolution is active before enabling prepend (no mutual-recursion OOM).

## Contract evidence

Binding surface = supervised children's argv shapes (pack-owned call sites) + inventory route table (`scripts/lib/gh-inventory-match.mjs`). Argv inventory single source of truth = **Verification** table below (not duplicated in contract-evidence rows).

```contract-evidence
binding-id: orchestrator-pack:supervisor-child-gh-path:shim-resolved
binding-type: cli-behavior
binding: Start-OrchestratorWakeSupervisorChild builds child env with pack scripts/ ahead on PATH
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)
selector: child spawn env PATH
expected: shim-resolved

binding-id: orchestrator-pack:supervisor-child-gh-inventory:pr-list-open
binding-type: cli-behavior
binding: representative inventory argv (pr-list-open) routes REST not GraphQL
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)
selector: matcher route id for pr-list-open argv
expected: pr-list-open
```

## Files in scope

- `scripts/**` — supervisor child spawn env, gh inventory fixtures/tests, static guards as needed.
- `docs/**` — runbook / migration adoption for supervisor PATH (focused).
- `tests/**` — argv fixture list (matcher matrix); reuse `scripts/gh-wrapper.test.ts` for parity.

## Files out of scope

- `vendor/**`, `packages/core/**`, Composio AO core.
- `agent-orchestrator.yaml` (gitignored) — this issue wires supervisor spawn only; AO turn PATH remains #431.
- Supervisor crash hardening (separate higher-priority draft: backoff, crash-safe redirection, null-safe bindings).
- #443 detectPR route extension.
- `.ao/autonomous-real-binaries.json` pin changes.

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
```

Scope boundary note: This denylist is scoped to `138-supervisor-children-gh-rest-shim-path`.

```allowed-roots
scripts/**
docs/**
tests/**
```

## Acceptance criteria

1. **Child spawn PATH (unit):** Deterministic test proves `Start-OrchestratorWakeSupervisorChild` constructs child environment with pack `scripts/` prepended ahead of inherited PATH (fixture/spy — no live supervisor required).

```producer-emission
producer: orchestrator-pack
datum: supervisor-child-gh-path
expected: shim-resolved
proof-command: npm test -- supervisor-child-gh-path
```

2. **Inventory argv fixture matrix:** Automated tests classify every argv row in **Verification — supervisor-child argv inventory** through the real matcher (`classifyArgv` / equivalent) and assert route id vs documented passthrough (including `api`-root → null). GraphQL-exhausted simulation (or stub) proves REST-routed rows succeed when native `gh pr list` / `gh repo view` would fail.

```producer-emission
producer: orchestrator-pack
datum: supervisor-child-gh-inventory
expected: pr-list-open
proof-command: npm test -- supervisor-child-gh-inventory
```

3. **Field-name parity (reuse #431):** Existing `scripts/gh-wrapper.test.ts` suite remains green; no parallel supervisor-specific parity harness unless a gap is demonstrated. Supervisor-child argv rows rely on the same `mapPullToGhJson` / REST routes shipped in #431.

4. **Runbook adoption:** `docs/orchestrator-wake-runbook.md` (or migration_notes) documents child PATH behavior, #442 merge-order prerequisite, and post-merge supervisor restart.

```positive-outcome
asserts: with GraphQL quota exhausted and REST core healthy, a supervised child issuing gh pr list --state open --json number,headRefOid,baseRefName --limit 200 completes successfully via pack shim REST route instead of failing as native GraphQL
input: realistic
```

## Upgrade-safety check

- No `vendor/**` or `packages/core/**` edits.
- #442 must merge before supervisor-child PATH prepend when `~/.ao/bin` is on inherited PATH — merge-order only (no runtime #442 detector).
- REST `core` bucket is finite (~5000/hr); #447 **moves** exhaustion risk from GraphQL to REST `core` on inventory reads — does not remove quota risk. N+1 `gh api commits` under restart storm is an amplifier (backlog).
- Children without inventory-covered argv are unchanged (passthrough); matrix must stay current.
- Crash hardening draft is co-required to close the 2026-06-24 incident; #447 alone is insufficient under sustained restart storm.

## Verification

### Supervisor-child argv inventory (verified 2026-06-24 via `classifyArgv` on live source strings)

| Child / caller | Exact argv (source) | Matcher route | Bucket if shim on PATH |
|---|---|---|---|
| `Gh-PrChecks.ps1` `Invoke-GhOpenPrList` (used by listener, review-trigger-reconcile, review-trigger-reeval, ci-green-wake-reconcile, review-send-reconcile, ci-failure-notification-reconcile/reaction, review-ready-report-state-seed scoped refresh) | `gh pr list --state open --json number,headRefOid,baseRefName --limit 200` | `pr-list-open` | REST `core` |
| `review-finding-delivery-confirm.ps1:213` | `gh pr list --state open --json number,headRefOid --limit 200` | `pr-list-open` | REST `core` |
| `Gh-PrChecks.ps1` `Invoke-GhPrChecks` | `gh pr checks $n --json name,state,bucket,link,startedAt,completedAt,workflow,description` | `pr-checks` | REST `core` |
| `Gh-PrChecks.ps1` `Invoke-GhOpenPrListForNumbers` | `gh pr view $n --json number,headRefOid,baseRefName,state` | `pr-view` | REST `core` |
| `Gh-PrChecks.ps1` `Get-GhRequiredCheckNamesForPr` | `gh pr view $n --json baseRefName -q .baseRefName` | `pr-view` | REST `core` |
| `Gh-PrChecks.ps1` + `Ci-Failure-Notification-Common.ps1:59` | `gh repo view --json nameWithOwner -q .nameWithOwner` | `repo-view-name-with-owner` | REST `core` |
| `Gh-PrChecks.ps1` per-PR head date (N calls per open-PR list) | `gh api repos/{owner}/{repo}/commits/$headSha --jq .commit.committer.date` | **passthrough** (`api` root) | REST `core` via native `gh api` |
| `Gh-PrChecks.ps1` branch protection | `gh api repos/$slug/branches/$encodedBaseRef/protection` | **passthrough** (`api` root) | REST `core` via native `gh api` |
| heartbeat, worker-message-submit-reconcile, review-run-recovery, review-start-claim-reaper | *(no `gh` calls)* | — | — |

**GraphQL gap if shim absent:** all inventory rows above that are REST-routed still hit GraphQL through `/usr/bin/gh` today.

**Downstream failure note:** `review-ready-report-state-seed` `OpenPrs is null` in incident log follows from `Invoke-GhOpenPrList` failure when GraphQL exhausted — null-safe binding is in the **crash-hardening** draft, not #447.

### Class enumeration (argv × bucket × coverage → outcome)

| Child tick | GraphQL quota | REST core quota | Shim on PATH + route | Outcome |
|---|---|---|---|---|
| `Invoke-GhOpenPrList` | exhausted | healthy | yes, `pr-list-open` | **PASS** (REST) |
| same | exhausted | healthy | no (`/usr/bin/gh`) | **FAIL** (incident class) |
| `gh api commits` | exhausted | healthy | passthrough | **PASS** (REST api) |
| `gh api commits` | healthy | exhausted | passthrough | **FAIL** (core limit) |
| `gh pr checks` | exhausted | healthy | yes, `pr-checks` | **PASS** |
| unknown future argv | any | any | passthrough | native behavior / GraphQL if gh subcommand |

### Commands

- `node -e "import { classifyArgv } from './scripts/lib/gh-inventory-match.mjs'; …"` — per-row matcher probe (maintain as test).
- `npx vitest run scripts/gh-wrapper.test.ts` — reuse #431 parity suite (25 tests PASS at draft time).
- `pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1 -Action Status` — post-adoption health (operator).
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/138-supervisor-children-gh-rest-shim-path.md`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/138-supervisor-children-gh-rest-shim-path.md`
- `pwsh -NoProfile -File scripts/verify.ps1` and `scripts/check-reusable.ps1`

## Design analysis (pre-draft gate)

### Critical mechanics

- Pack shim (`scripts/gh` → `gh-wrapper.mjs`) classifies argv; inventory hits REST (`gh-rest-routes.mjs`); miss → `resolveRealGhBinary()` passthrough.
- Supervisor spawns children via `Start-OrchestratorWakeSupervisorChild` with env hash **excluding `PATH`** (verified: `Orchestrator-SideProcessSupervisor.ps1`); children inherit parent PATH → `/usr/bin/gh` wins over unstaged/unprepended shim.
- GraphQL and REST `core` are **separate buckets** (verified `gh api rate_limit` 2026-06-24).
- Two-wrapper PATH without #442 → mutual recursion OOM (#442 P0).
- Restart storm + N+1 `gh api commits` can exhaust REST `core` even after GraphQL trigger is removed — crash hardening is co-required.

### Industry practice

- Wrap CLI at process spawn boundary for long-lived supervisors (systemd `Environment=`, container ENTRYPOINT) rather than relying on login-shell PATH of the launching operator.
- Shim chains resolve to terminal native binary (git/credential helpers pattern) — #442.

### Architecture sketch

```
orchestrator-wake-supervisor
  └─ Start-OrchestratorWakeSupervisorChild
        PATH' = <pack>/scripts : $PATH   (#442 merge-order first)
        └─ child.ps1 → gh …
              └─ scripts/gh (inventory → REST core)
                    └─ passthrough → terminal /usr/bin/gh (gh api → REST core)
```

### Options

| Option | Cost | Risk | Sufficient? |
|--------|------|------|-------------|
| A. Prepend `scripts/` in supervisor child env only | Low | Low if #442 first | **Yes** |
| B. Rely on #431 AO-surface PATH only | Zero extra | **High** — supervisor children stay on `/usr/bin/gh` (today's incident) | **No** |
| C. Replace all child `gh` with explicit `node gh-wrapper.mjs` at call sites | Medium churn | Bypasses PATH; duplicates spawn wiring | Overkill |
| D. Global operator `ln -s` install of shim | Ops burden | Drift across machines | **No** |

**Choice:** A — supervisor-child PATH prepend, #442 merge-order, argv fixture matrix.

### Ship order

1. **#431** — merge shim + AO-surface adoption (working tree staged; issue **open**).
2. **#442** — terminal resolution (**P0**, issue **open**).
3. **Crash-hardening draft** (architect follow-on, **higher priority than #447**) — backoff + crash-safe redirection + null-safe bindings.
4. **This issue (#447)** — supervisor-child PATH + fixtures (co-required with hardening to close incident; neither alone sufficient).
5. **#443** — optional detectPR route (not supervisor children); N+1 commits batching backlog.

## Incident Scope Note

This transport-scope task makes no claim about which actor spent the observed
GraphQL quota. That attribution is outside this draft's evidence and acceptance
surface.
