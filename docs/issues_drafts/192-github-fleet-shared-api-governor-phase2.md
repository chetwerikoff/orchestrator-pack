# GitHub fleet shared API governor (Phase 2)

GitHub Issue: #585

## Prerequisite

- `docs/issues_drafts/131-gh-rest-fallback-on-graphql-quota-exhaustion.md`
  (GitHub #431, closed) ships pack `scripts/gh` and inventory REST routing.
- `docs/issues_drafts/136-gh-wrapper-mutual-recursion-terminal-resolution.md`
  (GitHub #442, closed) makes wrapper passthrough terminal by resolving a native
  `gh` binary; this issue must not reintroduce wrapper recursion or unbounded
  wrapper process growth.
- `docs/issues_drafts/138-supervisor-children-gh-rest-shim-path.md`
  (GitHub #447, closed) puts wake-supervisor children on pack `scripts/gh`.
- `docs/issues_drafts/140-graphql-fleet-shared-github-api-gate.md`
  (GitHub #453, closed), `docs/issues_drafts/180-wake-supervisor-open-pr-snapshot-coverage-regression.md`
  (GitHub #553, closed), `docs/issues_drafts/182-claimed-review-start-scoped-pr-lookup.md`
  (GitHub #557, closed), and `docs/issues_drafts/186-github-fleet-shared-pr-ci-snapshot.md`
  (GitHub #569, closed) reduce duplicate demand through caches and scoped reads.
  They are not a hard rate gate and must not be rebuilt here.
- `docs/issues_drafts/191-github-fleet-repo-tick-snapshot-consolidation.md`
  (GitHub #583, open) is Phase 1 demand consolidation. This issue may ship the
  governor mechanism in parallel, but budget tuning waits until Phase 0/1
  telemetry exists.
- `docs/issues_drafts/170-orchestrator-command-runtime-bootstrap-contract.md`
  (GitHub #532, closed), `docs/issues_drafts/169-gh-resolvepr-rest-inventory-route.md`
  (GitHub #530, closed), `docs/issues_drafts/175-graphql-exhaustion-degraded-poll.md`
  (GitHub #540, closed), and GitHub #549/#501/#520/#538 close known wrapper/PATH
  and GraphQL recurrence gaps for autonomous AO reads.
- `docs/issues_drafts/193-review-start-preflight-transient-rate-limit-shield.md`
  is a sibling resilience shield for the fresh-head review-start preflight. The
  shield must remain independently landable.

Prior-art verdict: **replace/supersede the local unsynced draft**
`docs/issues_drafts/142-github-fleet-hard-rate-gate-phase2.md`. GitHub issue
#142 is an unrelated closed finding-routing issue, and local draft 142 is a
parked conditional stub. The 2026-07-04 audit satisfies the old "measure caller
attribution first" gate, so this draft verifies and extends that evidence rather
than remeasuring from scratch.

## Goal

Add one shared, identity-keyed admission governor for GitHub API reads so the
wake-supervisor fleet and autonomous AO runtime cannot independently burst the
same GitHub identity into primary/secondary limits. The mechanism provides a
hard velocity budget, in-flight cap, lane-aware fail policy, and shared observed
limit cooldown while preserving shipped cache/scoped-read contracts.

```behavior-kind
action-producing
```

## Binding surface

- **Design-log verdict first:** the PowerShell fleet's upstream GitHub calls are
  routed through `scripts/gh` today: `Gh-PrChecks.ps1` uses pack `scripts/gh` for
  review-start scoped reads; `Gh-FleetInventoryCache.ps1` upstream fetchers call
  `gh pr view`, `gh pr checks`, `gh pr list --head`, and REST `gh api repos/...`;
  `scripts/gh` launches a fresh `node scripts/lib/gh-wrapper.mjs` process for
  non-special forms. Governor state therefore cannot live in memory.
- **AO daemon participation is the packaging gate:** pack docs/config put
  `scripts/gh` first on orchestrator `PATH`, and closed #530/#538/#549/#532 cover
  several AO/scm read shapes, but this checkout has no vendored AO source proving
  every Node daemon `scm.*` read is wrapper-mediated. The implementation must
  run a live participation probe with wrapper audit enabled and classify every
  daemon GitHub read as wrapper-covered, shared-lease participant, or broker-only
  residual before enabling the governor broadly.
- The governor owns a file-based, atomic lease/cooldown state under the existing
  side-process state area, keyed by GitHub identity/host/repo scope as needed.
  It uses token-bucket semantics and a separate in-flight concurrency cap.
- Admission is route-agnostic for every wrapper-mediated GitHub invocation:
  REST inventory routes, REST `gh api repos/...`, and native `gh` passthrough
  forms including GraphQL-backed calls all consult the same governor before
  upstream transport.
- Lanes are explicit: background reconcile and retry traffic are sheddable;
  interactive, review-preflight, and merge-critical traffic have reserved
  headroom; retry traffic uses a penalized budget and never competes as fresh
  work.
- Observed primary-limit, secondary/abuse-limit, 429, and transient transport
  outcomes are recorded back into shared state. `Retry-After` is honored exactly
  when available, with jitter; without headers the governor publishes a
  conservative escalating cooldown. This is the deny-dispatcher: a governor
  observed-limit state, not a standalone component.
- Terminal classes are never masked by cooldown/retry: 401 bad credentials,
  missing native `gh`/adoption config, policy/boundary deny, malformed argv, and
  PR-not-open outcomes remain distinct surfaced failures.
- Fail policy is lane-specific. Background/retry callers fail closed by skipping
  the tick, using bounded stale data, or surfacing a classified denial. Interactive
  and review-preflight callers may use only a tiny audited emergency budget with
  self-paced delay when the governor is unavailable.
- Cold restart seeds a conservative nonzero budget and ramps; a full fleet
  restart must not release a full bucket to every process.
- Phase-0 dependency is explicit: budget values and secondary-vs-primary tuning
  require persistent wrapper invocation telemetry, response headers, request IDs,
  and cache hit/miss telemetry. This issue can ship the mechanism with a
  conservative placeholder budget and an acceptance ramp, but tuning is a later
  telemetry-backed step.

```contract-evidence
binding-id: orchestrator-pack:github-governor:shared-admission-state
binding-type: cli-behavior
binding: GitHub callers consult one identity-keyed shared admission state before upstream reads
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:github-governor:observed-limit-cooldown
binding-type: cli-behavior
binding: observed primary/secondary/429 limit outcomes publish a shared cooldown consumed by all participating callers
producer: orchestrator-pack
evidence: NEW(produced-by AC#4)

binding-id: orchestrator-pack:github-governor:terminal-class-guard
binding-type: cli-behavior
binding: terminal 401/config/policy/malformed outcomes are surfaced and never converted into transient cooldown masking
producer: orchestrator-pack
evidence: NEW(produced-by AC#6)
```

## Files in scope

- `scripts/**`
- `docs/**`
- `tests/**` only for focused fixtures if existing test layout requires it
- `agent-orchestrator.yaml.example` only if operator adoption for governor
  environment variables or restart steps is required

## Files out of scope

- AO core or vendored upstream package edits.
- Rebuilding the #453/#553/#557/#569/#583 cache/snapshot demand layers.
- The review-start transient shield sibling draft.
- Webhook-driven invalidation or adaptive TTL as Phase 3 demand work.
- Local runtime state, credentials, or machine-specific config.

```denylist
vendor/**
packages/core/**
.ao/**
.agent-orchestrator/**
~/.local/state/**
agent-orchestrator.yaml
```

```allowed-roots
scripts/**
docs/**
tests/**
agent-orchestrator.yaml.example
# issue-585-governor-scope
```

## Acceptance criteria

1. **Shared admission positive path:** with a multi-process fixture representing
   at least the top five wake-supervisor GitHub callers and one AO/autonomous
   caller, participating callers acquire from one shared lease before upstream
   GitHub reads. The fixture proves both token budget and in-flight cap are
   enforced across processes.

```positive-outcome
asserts: concurrent wake-supervisor and autonomous GitHub callers are admitted through one shared identity-keyed governor state, with background callers delayed or denied when tokens or concurrency are exhausted
input: realistic
```

```producer-emission
producer: orchestrator-pack
datum: github-governor
expected: shared-admission-state
proof-command: implementation-specific focused governor fixture
```

2. **Chokepoint coverage inventory:** verification enumerates every GitHub call
   surface in the PowerShell fleet and autonomous AO runtime. Each row is
   classified by transport (`REST-inventory`, REST `gh api repos/...`,
   native-passthrough, GraphQL-backed passthrough, or non-GitHub) and by
   participation (`wrapper-covered`, explicit shared-lease participant,
   broker-only residual, or intentionally terminal/non-GitHub). Any unclassified
   live GitHub read fails the issue. Any broker-only residual blocks broad governor
   enablement and Phase-2 coverage claims until the work is split to a broker or
   equivalent participation follow-up; a wrapper-only PR may land only as the
   PowerShell-fleet slice with the residual explicitly out of coverage.

3. **Reserved-lane anti-starvation:** under sustained background saturation
   matching the 2026-06-30 plateau shape, a review-preflight or interactive
   caller is admitted from reserved headroom within a bounded latency while
   background callers are delayed or shed. The fixture proves preflight does not
   wait behind a poll storm when the governor is healthy but tokens are
   contended.

4. **Observed-limit cooldown:** a simulated 403-secondary/429 with `Retry-After`
   publishes a shared cooldown; all participating background callers stop
   probing until it expires, and interactive/preflight traffic uses only the
   reserved lane policy. Without headers, the fixture uses conservative fixed
   backoff and records that degraded classification.

```producer-emission
producer: orchestrator-pack
datum: github-governor
expected: observed-limit-cooldown
proof-command: implementation-specific focused cooldown fixture
```

5. **Lane fail policy:** background and retry lanes fail closed on empty or
   corrupt governor state; interactive/preflight lanes never burst ungoverned and
   may use only a tiny audited self-paced emergency budget.

6. **Terminal guard:** fixtures for 401 bad credentials, missing native `gh` or
   adoption config, policy/boundary deny, malformed argv, and PR-not-open prove
   these outcomes remain terminal and visible. They are not retried, cooled down,
   or relabeled as secondary-limit transients.

```producer-emission
producer: orchestrator-pack
datum: github-governor
expected: terminal-class-guard
proof-command: implementation-specific focused terminal-class fixture
```

7. **Cold restart ramp:** simultaneous cold-start callers do not all receive a
   full budget. Background traffic ramps conservatively; reserved preflight
   headroom is nonzero but paced.

8. **No wrapper recursion regression:** existing #442 terminal native-`gh`
   resolution and wrapper process growth tests remain green; the governor does
   not call `gh` through a path that re-enters `scripts/gh`.

9. **Scenario matrix fixtures:** acceptance fixtures cover caller `{idle,
   bursting, retry-loop, interactive-preflight}` x API `{ok, primary-limit,
   secondary-limit, transient-5xx, 304, terminal-401/config/policy}` x governor
   `{tokens-available, empty, cold-restart, unavailable}`. Expected outcomes:
   admitted success, shared cooldown, fail-closed skip/stale, emergency paced
   preflight, or terminal surfacing. No-regression cells cover #453/#553/#557/#569
   cache/scoped-read behavior.

10. **Telemetry dependency recorded:** the implementation ships with conservative
   placeholder budget/ramp values and emits enough audit data to tune later; it
   does not claim the final budget is known before Phase-0 invocation/header/cache
   telemetry exists.

## Upgrade-safety check

- No AO core or vendored package edits.
- No temporary `gh` shims, raw `curl`, GraphQL fallback, or `unset
  GH_WRAPPER_ACTIVE` bypasses.
- State is file-based and atomic; process memory is not treated as shared
  governor state.
- Operator adoption, if required, is limited to pack config/env/restart steps and
  must include a rollback path that removes the governor from PATH/env without
  corrupting runtime state.

## Verification

- Focused governor multi-process fixture for AC#1, AC#3, AC#4, AC#5, and AC#7.
- Static/live chokepoint inventory for AC#2, including a wrapper-audit daemon
  participation probe.
- Terminal-class fixtures for AC#6.
- Existing wrapper and cache regression tests covering #442/#453/#553/#557/#569.
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/192-github-fleet-shared-api-governor-phase2.md`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/192-github-fleet-shared-api-governor-phase2.md`
- `pwsh -NoProfile -File scripts/verify.ps1`
- `pwsh -NoProfile -File scripts/check-reusable.ps1`

## Decisions

### Knowledge base

Local `wiki` search returned only general configuration/version-control notes
and no relevant governor/preflight material; `synto` returned no relevant
articles or source segments. The design is grounded in repo artifacts, live
issues, and the 2026-07-04 audit.

### Chokepoint and packaging

PowerShell fleet calls converge on pack `scripts/gh`, and `scripts/gh` starts a
fresh wrapper process for each call, so the cheapest sufficient first packaging
is wrapper-embedded admission with file-backed atomic lease state. AO daemon
participation is not fully proven from this checkout: docs/config require pack
PATH and prior issues REST-route several `scm-github` argv classes, but no local
upstream source proves all `scm.*` polling uses the wrapper. The draft therefore
requires a daemon participation probe before broad enablement. If the probe
finds direct HTTP/octokit reads that cannot consult the lease, broker promotion
is the required follow-up before claiming full two-runtime coverage.

### Options

| Option | Cost | Risk | Sufficiency | Decision |
|---|---:|---:|---:|---|
| Wrapper-embedded governor with file lease | Medium | Medium: atomic lease correctness and daemon participation must be proved | Sufficient if AO daemon is wrapper/lease-covered | Chosen first slice |
| Local broker process | High | Medium-high: new process/IPC/health/fail policy | Strongest two-runtime semantics | Promotion path if daemon cannot participate through wrapper/lease |
| Cache/demand-only | Low | High: no hard ceiling during cold start, preflight, or residual bursts | Insufficient alone | Rejected for Phase 2 governor |
| Deny-dispatcher only | Low | High: reacts after ban and can mask terminal failures if misused | Insufficient alone | Folded into governor cooldown state |

### Decomposition

The full governor may exceed one implementation PR if the daemon probe requires
broker participation. This draft is acceptable as one PR only if it lands the
file-backed lease, wrapper participation, terminal guards, lane policy, and a
proved daemon coverage answer together. If the daemon is not wrapper/lease
covered, split before implementation: PR 1 lease + wrapper + PowerShell fleet;
PR 2 daemon participation through shared lease or broker; PR 3 telemetry-tuned
budget ramp after Phase 0/1 data. Do not force all three into one swollen PR.

### Reconciled Scenario Matrix

The deep-reasoner matrix supplies the compact expected outcomes; the Codex
matrix adds `304`, cold-start, unavailable, and daemon-coverage cells. This
draft reconciles them into AC#9: `304` is success/primary-quota hygiene but
still consumes admission because it is still a request; secondary/429 publishes
shared cooldown; empty/unavailable fails closed for background but only paced
emergency for interactive/preflight; terminal 401/config/policy exits the
governor transient path entirely.
