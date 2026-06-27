# Wake-supervisor fleet read-through cache for GitHub inventory (Phase 1)

GitHub Issue: [#453](https://github.com/chetwerikoff/orchestrator-pack/issues/453)

## Prerequisite

- `docs/issues_drafts/71-orchestrator-side-process-supervisor.md` (GitHub [#205](https://github.com/chetwerikoff/orchestrator-pack/issues/205), **closed**) — 13-registry-child wake supervisor. **Already does:** independent child processes, per-child cadence. **Does not cover:** shared inventory caching or call-volume reduction across children.
- `docs/issues_drafts/131-gh-rest-fallback-on-graphql-quota-exhaustion.md` (GitHub [#431](https://github.com/chetwerikoff/orchestrator-pack/issues/431), **open**) — pack `scripts/gh` REST inventory routes. **Already does:** move known inventory argv off GraphQL to REST `core`. **Does not cover:** request coalescing or memoization. Explicitly lists "repo-wide GraphQL budgeting, request coalescing, or backoff policy" as **out of scope**.
- `docs/issues_drafts/138-supervisor-children-gh-rest-shim-path.md` (GitHub [#447](https://github.com/chetwerikoff/orchestrator-pack/issues/447), **closed** via PR [#452](https://github.com/chetwerikoff/orchestrator-pack/pull/452) / `0a69332`) — **merged on `main`.** Prepends pack `scripts/gh` on supervisor-child PATH (`Orchestrator-SideProcessSupervisor.ps1`); ships `check-orchestrator-wake-supervisor-gh-path.ps1` + test + migration_notes. **Already does:** transport reroute — inventory reads consume REST `core`, not GraphQL. **Does not cover:** caching, coalescing, or call-count reduction (`Gh-PrChecks.ps1` unchanged). This issue builds **above** that transport.
- `docs/issues_drafts/139-supervisor-crash-hardening-degraded-backoff-and-redirect-safety.md` (GitHub [#450](https://github.com/chetwerikoff/orchestrator-pack/issues/450), **open**) — per-child degraded backoff + supervisor fault boundary. **Sibling; co-required for full incident closure.** #450 stops restart storms **after** limits trip; Phase 1 here reduces call volume so limits trip less often.
- `docs/issues_drafts/136-gh-wrapper-mutual-recursion-terminal-resolution.md` (GitHub [#442](https://github.com/chetwerikoff/orchestrator-pack/issues/442), **open**, **P0**) — terminal `gh` binary resolution. **Merge-order gate only for Phase 2** (hard limiter implemented *inside* `scripts/gh`). **Does not gate Phase 1** — the cache layer sits in pack inventory helpers above the `gh` call, independent of wrapper PATH.
- `docs/issues_drafts/129-review-start-claim-liveness-reaper.md` / `130-review-handoff-admission-receipt-budget-degrade.md` — both explicitly defer **repo-wide GitHub API rate-limit budget** to a future issue. **Phase 2** (`docs/issues_drafts/142-github-fleet-hard-rate-gate-phase2.md`, conditional stub) owns hard budgeting if measurement proves Phase 1 insufficient.

**Prior-art verdict:** **Genuinely new draft** (Phase 1 cache layer). #447/#452 shipped transport only; this closes the **call-volume** gap #447 explicitly does not address. Amending #447 would blur closed transport scope with caching policy.

**Phase model:**

| Phase | Scope | This draft? |
|---|---|---|
| **Phase 1** | Read-through cache: SHA→date memo + short-TTL open-PR-list snapshot; bypass migration | **Yes — ship this** |
| **Phase 2** | Hard shared token-bucket + cooperative backoff + concurrency-cap (broker/IPC or `scripts/gh` limiter) | **Conditional stub** — author/issue only if post-#447 empirical measurement (below) proves Phase 1 insufficient |

**Incident context (independently verified; reframed post-#447):**

| Claim | Status | Artifact |
|---|---|---|
| Fleet children call GitHub independently | **Fact** | `grep Invoke-GhOpenPrList` / direct `gh pr list` across 9 registry children + `scripts/lib/Gh-PrChecks.ps1`; registry `scripts/orchestrator-side-process-registry.json` |
| Post-#447 transport | **Fact (merged)** | PR #452 / `0a69332`; `gh issue view 447` → closed; children resolve pack `scripts/gh` → REST `core` |
| Symptom class (reframed) | **Fact** | Pre-#447 logs show `GraphQL: API rate limit already exceeded`. **Post-#447:** entire `Invoke-GhOpenPrList` N+1 (`gh pr list` + per-PR `gh api commits/$sha`) lands on **REST `core` (5000/hr)**, not GraphQL. Incident class = **REST-core call volume**, not GraphQL secondary-limit. GraphQL-secondary with `remaining > 0` during rejection remains **unreproduced** (hedge only). |
| Rate-limit rejections under fleet load | **Fact (historical)** | `~/.local/state/orchestrator-pack-wake-supervisor/supervisor.log`: 15,294 degraded lines with rate-limit text (mostly pre/post transport migration window) |
| `getPRState` / `poll_pr` failures | **Fact** | `ao events search "poll_pr_failed"`: `getPRState failed for PR #0` (opk-180) and active PRs; correlated with `working → stuck` on 2026-06-24 |
| Failure-attribution proxy (weak) | **Weak proxy — do not use for option choice** | Degraded-line counts per child (e.g. `ci-green` 2838, `review-send` 2688) measure **who logged failures**, not subprocess call volume. Theoretical ~756 `gh`/min for `review-trigger-reeval` at N=20 ignores SHA memo (see Decisions). **Decision basis = empirical measurement (Verification).** |
| N+1 structure | **Fact** | `Invoke-GhOpenPrList` = 1 list + 1 `gh api commits/$sha` per open PR; `Invoke-GhOpenPrListForNumbers` = per-number `gh pr view` + commit REST. Nine children duplicate the list within seconds. |
| Bypass paths | **Fact** | `review-finding-delivery-confirm.ps1` direct `gh pr list` — migrate in Phase 1. AO `getPRState` outside fleet — out of scope. |
| `scripts/gh` choke point | **Partial** | #431/#447 REST routing only; **no** cache/coalesce today |

**Refs (sibling, out of scope):** orphan handoff-wake pending-retry reaper — **separate single-PR draft**.

## Goal

Reduce wake-supervisor fleet GitHub inventory pressure by introducing a **read-through cache layer** in pack-owned inventory helpers so all supervised children share:

1. An **immutable SHA→committed-date memo** (kills the N-side of N+1 without any token bucket — a head SHA's committed date never changes), and
2. A **short-TTL shared open-PR-list snapshot** in the supervisor state dir (kills overlap when nine children issue the same list within seconds; concurrent identical readers coalesce to one populate).

Reconcile business logic unchanged; only the inventory read path changes. No broker, no flock concurrency-cap, no fail-closed critical dependency — cache writes are idempotent; cold-cache worst case is a bounded double-fetch, not a storm. **Independent of #442 and #447** (both already satisfied or not gating this layer).

Hard token-bucket / cooperative backoff (**Phase 2**) is a **conditional follow-up** gated by empirical measurement — not this deliverable.

```behavior-kind
action-producing
```

## Binding surface

- **SHA→committed-date memo:** Cache commit-date lookups keyed by `(repo, headSha)` with **long-lived TTL** (immutable datum). Applies to the `gh api commits/$sha` leg of `Invoke-GhOpenPrList` and `Invoke-GhOpenPrListForNumbers` only — not to `gh pr view` / `gh pr list` themselves. **Same single-flight contract as list snapshot:** concurrent first-seen SHA readers coalesce to one in-flight commit lookup (≤2 upstream calls per SHA per short window on cold race). **Short-lived negative cache** for failed commit lookups (planner chooses TTL) to avoid retry storms during upstream degradation. Planner chooses storage and optional bounded eviction (e.g. max entries or age cap) to prevent unbounded directory growth.
- **Open-PR-list snapshot:** Short-TTL shared snapshot keyed by `(repo, list query identity)` in supervisor state dir. TTL is short (order of seconds–tens of seconds — planner chooses). **Primary (steady-state) contract:** while a snapshot is **warm** (within TTL), identical concurrent readers produce **zero** additional upstream `gh pr list` calls — all served from the snapshot. This is the budget-relevant guarantee and is mechanism-independent. **Cold-cache populate contract (bounded transient):** when no valid snapshot exists, concurrent identical readers produce a **bounded** populate burst of **at most the registry-child count** per cache key per TTL window, settling to one snapshot for the remainder of the window; a **single-flight** implementation (at most one in-flight populate per key) tightens this to **≤2** — planner's choice. **Either way:** populate uses atomic publish (write-then-rename or equivalent) so readers never consume partial snapshots; if populate fails, all waiters receive the failure — **no silent per-child fallback** to independent upstream calls (which would recreate a storm). AC#1 encodes both the steady-state and cold-burst bounds.
- **Read-through semantics:** On cache miss, populate from upstream (through merged #447 REST shim); on hit, no upstream call for that datum. Upstream error during populate propagates to all waiters; no silent stale serve beyond TTL (fixture-defined). **Waiter bounds (behavioral):** readers awaiting an in-flight populate must not block unbounded; planner chooses max wait / recovery (stale lock after populator crash → bounded retry or fail-through to upstream, not infinite wait). **No stale-serve of expired snapshot on populate failure** — availability trade accepted; #450 handles fleet degraded state on real upstream failures.
- **Bypass migration:** `review-finding-delivery-confirm` direct `gh pr list` must route through the cached inventory helper. Static guard required.
- **No Phase-2 machinery in this issue:** No shared token bucket, no cooperative backoff gate, no fail-closed-as-critical-dependency. Those belong in Phase 2 stub if measurement warrants.
- **Cadence:** Not a non-goal. Shared snapshot makes high-cadence reeval nearly free; tick **stagger/alignment** may be considered as a cheap complement — not mandated.
- **Composition:** Cache sits in inventory helpers **above** the `gh` invocation (below reconcile business logic). #447 transport unchanged. #442 gates only a future limiter inside `scripts/gh` (Phase 2).
- **Non-goals (Phase 1):** AO `getPRState` caching, repo-wide budget for non-supervisor surfaces, orphan handoff-wake reaper, Phase-2 hard limiter, **`gh pr checks` / branch-protection / per-PR status queries** (`Invoke-GhPrChecks` and similar — different query shapes; not part of open-PR-list N+1 overlap; counted in AC#5 measurement but not cached here).

**Operator adoption:** After merge, restart wake supervisor. Confirm snapshot/memo observability (planner chooses audit hook) shows coalesced list reads under normal fleet operation.

## Contract evidence

Binding surface = fleet inventory read-through cache (pack-owned producers).

```contract-evidence
binding-id: orchestrator-pack:github-fleet-cache:coalesced-read
binding-type: cli-behavior
binding: within a warm snapshot TTL window, identical concurrent open-PR list reads produce zero additional upstream gh pr list calls (snapshot served); on a cold cache the populate burst is bounded to at most the registry-child count per cache key per TTL window (a single-flight implementation tightens this to ≤2)
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:github-fleet-cache:memo-hit
binding-type: cli-behavior
binding: second Invoke-GhOpenPrList for same head SHA within fleet window uses memo without upstream gh api commits call
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)

binding-id: orchestrator-pack:github-fleet-cache:no-bypass
binding-type: cli-behavior
binding: supervised inventory reads cannot reach native gh for open-PR list without passing through cached helper (static guard green)
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)
```

## Files in scope

- `scripts/**` — inventory helper cache/memo integration, `review-finding-delivery-confirm` bypass migration, static guards, fixtures/tests.
- `tests/**` — cache-semantics scenario fixtures.
- `docs/**` — runbook note for cache behavior + measurement procedure.

## Files out of scope

- `vendor/**`, `packages/core/**`, Composio AO core (`getPRState` — follow-up).
- `agent-orchestrator.yaml` (gitignored).
- #442 implementation, #447 PATH (merged — regression only).
- #450 supervisor crash hardening (sibling).
- Phase-2 hard limiter (`docs/issues_drafts/142-github-fleet-hard-rate-gate-phase2.md`).
- Orphan handoff-wake reaper.

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
```

Scope boundary note: This denylist is scoped to `140-graphql-fleet-shared-github-api-gate`.

```allowed-roots
scripts/**
tests/**
docs/**
```

## Acceptance criteria

### Scenario matrix (Phase 1 — cache semantics)

| Cache state | Reader pattern | Upstream behavior | Expected outcome (fixture) |
|---|---|---|---|
| cold | single reader | ok | one upstream populate; result cached |
| warm (within TTL) | single reader | n/a | **no upstream list call**; snapshot served |
| warm (within TTL) | N concurrent identical list | n/a | **no upstream list call**; all readers served from snapshot |
| cold | N concurrent identical list | ok | bounded populate burst: **≤2** (single-flight) or **≤N per TTL window** (atomic-publish-only); settles to one snapshot; all readers get equivalent payload or shared error |
| expired TTL | single reader | ok | one refresh populate; new TTL |
| memo hit | list with known SHA | n/a | **no `gh api commits/$sha`** for memoized SHAs |
| memo miss | list with new SHA | ok | one commit lookup per new SHA (single-flight per SHA); then memo hit on repeat |
| memo populate race | N concurrent readers, same new SHA | ok | ≤2 upstream commit lookups per SHA per short window; shared result or shared error |
| populate in flight | concurrent readers | ok (slow) | single-flight: one populate; shared result or shared error; no per-child silent fallback |
| populate error | any | upstream fail | error propagates to all waiters; no silent per-child fallback; no stale serve beyond TTL policy |
| bypass attempt | direct `gh pr list` in child | any | **static guard fails** |

1. **Coalesced open-PR list (AC#1):**
   - **(a) Warm steady-state (primary):** with a valid snapshot in TTL, identical concurrent readers produce **zero additional upstream `gh pr list` calls** for that cache key — all served from the snapshot. This is the budget-relevant guarantee; fixture asserts it for N concurrent readers.
   - **(b) Cold-cache populate (bounded transient):** with no valid snapshot, concurrent identical readers produce a populate burst bounded to **≤(registry child count) upstream calls per cache key per TTL window**, settling to one snapshot for the rest of the window; a **single-flight** implementation tightens this to **≤2** (planner choice — fixture asserts whichever bound the chosen mechanism targets).
   - All readers succeed with equivalent data or share the same populate error. The contract is "no sustained per-tick upstream duplication," not a specific concurrency primitive.

```producer-emission
producer: orchestrator-pack
datum: github-fleet-cache
expected: coalesced-read
proof-command: npm test -- github-fleet-cache-coalesce
```

2. **SHA memo hit (AC#2):** Second inventory read for a PR whose head SHA was already resolved → zero additional `gh api commits` calls for that SHA (the `gh pr view` / list legs are unaffected by memo — only commit-date enrichment).

```producer-emission
producer: orchestrator-pack
datum: github-fleet-cache
expected: memo-hit
proof-command: npm test -- github-fleet-cache-memo
```

3. **No bypass (AC#3):** Static guard proves every supervised-child **open-PR-list** inventory read site routes through cached helper (includes `review-finding-delivery-confirm` migration). Guard must be **registry-aware** — any child added to `orchestrator-side-process-registry.json` that issues list-class inventory reads must be covered before merge (maintenance contract, not one-time grep). `Invoke-GhPrChecks` / checks paths remain allowed as direct `gh` until a future issue — guard scope is list/memo paths only.

```producer-emission
producer: orchestrator-pack
datum: github-fleet-cache
expected: no-bypass
proof-command: npm test -- github-fleet-cache-bypass-guard
```

4. **Regression:** Shipped #447 guards remain green — `check-orchestrator-wake-supervisor-gh-path.ps1` + `orchestrator-wake-supervisor.test.ts` + `scripts/gh-wrapper.test.ts`.

5. **Empirical measurement (operator / post-merge gate for Phase 2):** Document and execute a procedure to **count real `gh` subprocess invocations** from fleet children over a **≥72h observation window** under normal + peak supervisor load (#447 REST baseline on `main`). Instrument at subprocess spawn (audit hook on pack `scripts/gh` or equivalent — planner choice). Record hourly: fleet-wide calls, per-child calls, list-call overlap ratio (identical list argv within 10s), memo-eligible commit lookups vs fresh SHAs, and **checks-class calls** (`gh pr checks` etc.) separately. **Also record total token consumption, not just fleet-attributed spawns:** sample `gh api rate_limit` (REST `core` and GraphQL `used`/`remaining`) deltas over the same windows. The operator token's 5000/hr REST `core` budget is **shared** with AO `getPRState` per-session polling, orchestrator turns, and reviewers — fleet-attributed calls alone **undercount** real token pressure, and a sufficiency verdict based on them alone can be fooled (fleet under budget while the token is saturated by co-tenants).

   **Phase-1 sufficient if:** **P95 fleet `gh` subprocess rate ≤ 4000/hr** (80% of REST `core` 5000/hr) over the observation window **and** P95 **total token consumption** stays within headroom (no sustained REST `core`/GraphQL near-exhaustion) **and** no secondary/abuse-limit reproduction **and** no sustained operator-visible rate-limit degraded churn in supervisor logs.

   **Phase-2 required if:** **P95 fleet rate > 4000/hr** (the fleet itself is the dominant consumer) **or** secondary-limit reproduced **or** distinct high-cadence list ticks still breach quota despite memo + snapshot. **Routing caveat:** if the token is saturated while **fleet rate is under 4000/hr** (the pressure is co-tenant `getPRState`/orchestrator/reviewer load), that is **not** a Phase-2 trigger — a fleet hard gate would not fix it; it routes to the repo-wide budget follow-up (#129/#130 scope), recorded as such, not opened against #142.

6. **Stale snapshot vs #450:** Fixture proves a TTL-valid snapshot served to a child does **not** by itself force incorrect `degraded` health solely because upstream would differ slightly fresher — inventory readers accept bounded staleness within TTL; #450 backoff remains driven by real upstream failures, not cache hits.

7. **Stale-head safety (AC#7):** A TTL-stale `headRefOid` in the snapshot only widens the **already-existing** head-propagation window — the fleet was already poll-based / eventually consistent before any cache. Invariant: downstream review/CI consumers must remain **(PR, headSha)-idempotent** (rely on #189 covered-head, #195 handoff gate, #207 CI contract) and must **never** start an action on a stale head in a way that bypasses head verification. Fixture: a snapshot whose head moved within the TTL window does not cause a review/CI start that escapes the existing (PR, head) claim/idempotency — the cache changes call volume, not correctness of which head is acted on.

```positive-outcome
asserts: under simulated fleet load, once an open-PR snapshot is warm, supervised children requesting the same open-PR inventory within the snapshot TTL window produce zero additional upstream gh pr list calls for that cache key and complete with equivalent open-PR data (cold-cache populate is bounded per AC#1); a repeat read for the same head SHA does not invoke gh api commits for that SHA
input: realistic
```

## Upgrade-safety check

- No `vendor/**` or `packages/core/**` edits.
- Independent of #442 (Phase 1). #447 merged — no PATH work in this PR.
- Snapshot TTL stale data bounded by short TTL; SHA memo safe (immutable).
- Cold-cache double-fetch is bounded (acceptable worst case per architect review).
- Phase-2 decision deferred until empirical measurement (AC#5).

## Verification

Match AC 1:1. Scenario matrix cells each have a named fixture.

**Supervised-child GitHub call inventory** (maintenance list — route through cached helpers):

| Child / helper | Call shape | Cache layer |
|---|---|---|
| `listener` | `Invoke-GhOpenPrList` ×2 per cycle | yes |
| `review-trigger-reconcile` | `Invoke-GhOpenPrList` ×2 | yes |
| `review-trigger-reeval` | `Invoke-GhOpenPrList` up to ×3 (5s cadence) | yes |
| `review-ready-report-state-seed` | `Invoke-GhOpenPrListForNumbers` | yes (memo + scoped list) |
| `ci-green-wake-reconcile` | `Invoke-GhOpenPrList` ×2 | yes |
| `review-send-reconcile` | `Invoke-GhOpenPrList` ×2 | yes |
| `review-finding-delivery-confirm` | direct `gh pr list` (**bypass today**) | yes (migrate) |
| `ci-failure-notification-reconcile` | `Invoke-GhOpenPrList` ×2 | yes |
| `ci-failure-notification-reaction` | `Invoke-GhOpenPrList` | yes |
| `scripts/lib/Gh-PrChecks.ps1` | `Invoke-GhOpenPrList`, `Invoke-GhOpenPrListForNumbers`, N+1 commits (**cached**); `Invoke-GhPrChecks`, branch protection (**out of scope Phase 1 — measure in AC#5**) | partial |
| `scripts/lib/Invoke-ReviewWakeTrigger.ps1` | `Invoke-GhOpenPrList` | yes |
| `heartbeat`, `worker-message-submit-reconcile`, `review-run-recovery`, `review-start-claim-reaper` | no direct inventory `gh` | n/a |
| AO `getPRState` | scm poll | **out of scope** |

Manual: post-merge measurement per AC#5; optional stagger/alignment evaluation if measurement borderline.

## Decisions (design analysis)

### 1. Critical mechanics (Phase 1)

- **Immutable SHA→date memo:** Head commit SHA → committed-date is immutable → unbounded memo eliminates ≈ **N/(N+1)** of `Invoke-GhOpenPrList` calls after first pass (only the list call remains per TTL window; commit lookups become one-time per SHA).
- **Short-TTL open-PR-list snapshot:** Kills nine-child overlap within seconds; makes 5s-cadence `review-trigger-reeval` nearly free for the list side.
- **Single-flight on populate (best-effort, not a hard mutex):** Concurrent readers await one populate (file-based or equivalent IPC — planner choice); not a broker/token-bucket. **Alternative the planner may pick:** atomic-publish-only (write-then-rename, no in-flight marker), accepting a bounded cold-cache burst of up to one populate per registry child per TTL window (≈9 calls once per TTL ≈ tens/min — far under budget). Either satisfies the contract; pick the cheaper one to build. The "≤2" bound in AC#1 applies only if single-flight is chosen.
- **No fail-closed:** Cache unavailable → fall through to direct upstream (bounded double-fetch), not fleet-wide outage. Phase 2 owns fail-closed hard gate if needed.
- **Storage:** Supervisor state dir (same locality as #447 child state).

### 2. World practice

Read-through caches with immutable-key memoization (CDN, HTTP caches for immutable assets) and short-TTL shared snapshots are the standard **cheapest** dedup for N+1 read amplification. Token buckets are added only when measurement proves cache insufficient.

### 3. Architecture sketch

```
[child A] ──┐
[child B] ──┼──> [inventory helpers: memo + snapshot] ──> [scripts/gh REST shim (#447)] ──> GitHub
[child C] ──┘              ^
                           └── shared state files (supervisor state dir)
```

### 4. Options (cost / risk / sufficiency) — re-ranked

| Option | Summary | Cost | Risk | Verdict |
|---|---|---|---|---|
| **A — In-process cache per child** | Local memo in each pwsh process | Low | **High** — no cross-process snapshot coalesce; 9× list calls remain | Reject |
| **B — Inter-process hard gate (broker/token-bucket)** | Fleet-wide rate limit + backoff | High | Medium — IPC, fail-closed complexity | **Phase 2 conditional** — only if measurement proves Phase 1 insufficient |
| **C — `scripts/gh` limiter extension** | Throttle inside shim | Medium | #442 merge-order; still needs IPC for cross-process coalesce | **Phase 2 transport** if B warranted |
| **D — Read-through cache + SHA memo (Phase 1)** | Shared snapshot + immutable memo in inventory helpers | **Low** | Low — idempotent files; bounded cold double-fetch | **Recommended** — cheapest sufficient given SHA immutability + #447 already on REST `core` |

**Recommendation: D (Phase 1).** Prior analysis rejected "coalesce only" by counting theoretical `gh`/min without SHA memo — that was wrong. With memo, reeval's 12 ticks/min costs **one list per TTL window + one-time commit lookup per new SHA**, not 12×(N+1). #447 already shipped transport; the remaining win is **call-count reduction**, not another PATH change.

**Phase 2 trigger:** Empirical `gh` subprocess count (AC#5) after Phase 1 ships. Stub: `docs/issues_drafts/142-github-fleet-hard-rate-gate-phase2.md`.

### 5. Full-class scenario enumeration

Covered by Phase-1 cache-semantics matrix (9 cells). Token-bucket / secondary-limit / restart-cold-budget cells deferred to Phase 2.

**Ship ordering:** #447 **merged**. #450 (supervisor survival) remains co-required for full incident closure. Phase 1 independent of #442.
