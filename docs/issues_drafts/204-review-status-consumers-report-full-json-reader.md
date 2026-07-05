# Review status consumers must use report-full JSON readers

GitHub Issue: #611

## Prerequisite

- `docs/issues_drafts/74-review-head-ready-report-sha-independent-binding.md` (GitHub #218, closed) settled that AO 0.9.x reports do not carry a reliable head SHA field; the review-ready predicate derives binding from accepted reports plus current PR head state.
- `docs/issues_drafts/123b-review-ready-report-state-seed-backstop.md` (GitHub #391, closed) settled the report-state input contract for the seed path: accepted `ready_for_review` reports come from `ao status --json --reports full --include-terminated`, not from plain status output.
- `docs/issues_drafts/72-reconcile-ready-head-defer-subreason.md` (GitHub #212, closed) requires review reconcile to preserve diagnosable defer reasons instead of collapsing distinct causes into opaque `uncovered_not_ready`.
- `docs/issues_drafts/76-golden-sample-fixtures-field-shape-guard.md` (GitHub #223, closed) requires capture-backed external-tool shapes so fixtures cannot silently use a non-production AO status shape.
- Incident evidence from 2026-07-05: opk-142...145 each had accepted `ready_for_review` reports in `ao status --json --reports full` / `.agent-report-audit`, while an ad-hoc "workflow reports per session" diagnostic in the orchestrator turn first reported `not found` from the wrong status field and later relied on plain `reports: []`. The same pane shows the `uncovered_not_ready` wording came from that in-turn diagnostic summary, while periodic `review-trigger-reconcile.ps1` ticks around 11:45 UTC failed earlier on snapshot JSON parsing. Later AO-local review evidence shows the heads did enter review: PR #603 / `41798a0d` clean (`opk-rev-1301`), PR #606 / `77239b22` clean (`opk-rev-1311`), PR #604 / `09e2ee50` reviewed then outdated after a newer commit, and PR #605 / `361eabc8` reviewed then outdated after a newer commit.
- Current code reality: `scripts/lib/Invoke-AoCliJson.ps1` already makes `Get-AoStatusSessions` call `ao status --json --reports full` and strips leading non-JSON text before `ConvertFrom-Json`; `Get-AoStatusSessionsIncludingTerminated` uses `--include-terminated`. This draft must not re-specify those shipped helpers as missing.
- Prior-art verdict: extends shipped report-full/read-shape contracts. The gap is any diagnostic, wake, or review-status consumer that bypasses the report-full/prefix-safe reader, accepts a plain-status-shaped session object without failing loudly, or drops terminated report-bearing sessions without an explicit live-only reason.

## Goal

Every pack-owned review-status consumer that decides, diagnoses, or reports whether a worker has handed off `ready_for_review` must read an accepted-report-capable snapshot through the shared report-full JSON reader or an explicit audit-backed fixture. Consumers that can reason across completed or restored sessions must include terminated sessions or state a live-only invariant. Plain `ao status --json` rows, `agentReportedState` alone, and shallow session objects without `session.reports[*]` must not be accepted as proof that no hand-off exists.

```behavior-kind
action-producing
```

```complexity-tier
tier: T3
advisory-prior: T3
```

## Binding Surface

- Review-trigger and review-ready diagnostics that inspect AO session/report state.
- Wake/listener/reconcile PowerShell JSON readers that parse AO CLI output.
- Shared status snapshot helpers that expose worker sessions to Node review predicates.
- Fixture and regression shapes for `ready_for_review` report visibility.
- Operator-visible diagnostics for `uncovered_not_ready`, `no_ready_for_review`, and status parse failures.

## Operator Adoption

No operator configuration migration is required. If implementation touches live `orchestratorRules` prose or process wiring, the PR must add the usual operator adoption checklist; otherwise this is pack-owned script/test behavior only.

## Files In Scope

- `scripts/**`
- `docs/**`
- `tests/**`
- `tests/external-output-references/**`
- `agent-orchestrator.yaml.example` only if operator-facing rules need a pointer to the corrected reader contract.

## Files Out Of Scope

- `vendor/**`
- `packages/core/**`
- `.ao/**`
- Live `agent-orchestrator.yaml`
- Changing the head-ready predicate semantics from #218/#391.
- Treating `agentReportedState` as a substitute for `session.reports[*]`.
- Worker respawn, worker patches, PR merge actions, or one-off fleet manipulation.

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
tests/external-output-references/**
agent-orchestrator.yaml.example
```

## Acceptance criteria

1. **Canonical reader inventory:** Every pack-owned path that asks whether a session has accepted `ready_for_review` is inventoried. Each row is classified as one of: uses shared report-full reader, uses shared report-full-plus-terminated reader, uses explicit audit-backed fixture, not a worker-report consumer, ad-hoc prompt/turn diagnostic governed by prompt rules, or defect fixed by this issue. The inventory includes review-trigger reconcile, review-ready seed, wake/listener helpers, diagnostics, and any workflow-report scripts. For live-only consumers that intentionally do not include terminated sessions, the inventory states the invariant that makes termination irrelevant.

2. **No plain-status false negative:** A production-shaped fixture with `ao status --json` returning a worker row with `reports: []`, while `ao status --json --reports full` returns an accepted `ready_for_review` for the same worker/current head, must not produce a final "no ready_for_review" verdict. The consumer either re-reads through the report-full reader or fails loudly with a classified error indicating the snapshot was not report-full-backed.

```producer-emission
producer: orchestrator-pack
datum: review-status-consumer
expected: no-plain-status-false-negative
proof-command: implementation-specific review-status consumer fixture
```

3. **Wrong-field diagnostic guarded:** If the AC#1 inventory finds a tracked workflow-report diagnostic, that diagnostic cannot look for workers under a non-existent or stale top-level field and report `not found` when `$.data[]` contains the sessions; its regression fixture includes `$.data[]` with opk-style workers and no `$.sessions`, and it reports the correct JSON path it used. If the workflow-report diagnostic is only an ad-hoc orchestrator in-turn query, the fix lives in prompt/config reader-contract prose plus a static or prompt-fixture guard proving the diagnostic instruction says to use `$.data[]` and report-full state.

4. **Report path is explicit:** Diagnostics that print a hand-off verdict include the source path used for reports, for example `$.data[?name==<session>].reports[*]` from `ao status --json --reports full`, `ao status --json --reports full --include-terminated`, or an explicit audit fixture path. Tracked diagnostics enforce this mechanically; ad-hoc prompt diagnostics are governed by prompt/config prose. Neither form may summarize plain `reports: []` without naming that the snapshot was not report-full-backed.

5. **Prefix-safe AO JSON parsing:** Pack-owned PowerShell paths that parse AO CLI JSON through wake/listener/reconcile status consumers tolerate notifier/log lines before the first JSON object, or route through a shared prefix-safe parser. A fixture with `[notifier-*]` lines before valid JSON does not fail with raw `ConvertFrom-Json` parse errors.

```producer-emission
producer: orchestrator-pack
datum: ao-json-reader
expected: prefix-safe-status-json
proof-command: implementation-specific AO JSON prefix fixture
```

6. **Head-ready lineage preserved:** The existing #218/#391 semantics remain unchanged: accepted `ready_for_review` must still be evaluated against the current PR head and required CI/coverage state. A stale accepted report for an older head still does not authorize the current head.

7. **Live head-binding proof:** The live review-trigger/claimed-review snapshot path has a fixture or dry-run proof where report-full AO status contains an accepted current-head `ready_for_review`, required CI is eligible, and the head is not covered. The outcome is review-start eligible / would-run, not `uncovered_not_ready` or `no_ready_for_review`. This proof must use the same status reader family as production, not a hand-shaped session object that bypasses the reader.

8. **Class matrix:** Verification covers at least these cells:

   | Status source | Session field shape | Report state | Expected outcome |
   | --- | --- | --- | --- |
   | `ao status --json --reports full` | `$.data[]` | accepted current-head `ready_for_review` | visible to consumer |
   | `ao status --json --reports full` | `$.sessions[]` fallback | accepted current-head `ready_for_review` | visible to consumer |
   | `ao status --json --reports full --include-terminated` | terminated `$.data[]` or `$.sessions[]` | accepted current-head `ready_for_review` | visible to consumers that reason across completed/restored sessions |
   | plain `ao status --json` | `$.data[]` with `reports: []` | audit/full snapshot has accepted report | re-read full or loud defect, never final no-report |
   | plain `ao status --json` | no `$.sessions[]` | worker exists under `$.data[]` | no `not found` false negative |
   | report-full JSON prefixed by notifier text | `$.data[]` | accepted report present | parse succeeds |
   | report-full JSON prefixed by notifier text | malformed after prefix strip | any | classified parse failure with command/source |
   | report-full JSON | stale older `ready_for_review` only | accepted but not current head | defer as stale/not ready per existing predicate |

9. **Audit-backed fallback is deliberate:** If any consumer cannot use live `--reports full`, it must consume an explicit audit-backed fixture or fail closed. Silent fallback to `agentReportedState`, pane text, or `status` is not sufficient.

```positive-outcome
asserts: an accepted current-head ready_for_review report remains visible to every review-status consumer even when plain ao status rows would show reports empty, and notifier-prefixed AO JSON does not break status parsing
input: realistic
provenance: capture-backed
```

## Upgrade-Safety Check

The change is upgrade-safe because it stays in pack-owned readers, diagnostics, fixtures, and prompt/config examples. It does not patch Composio AO core or vendor packages.

## Verification

- Reader inventory check for review-status consumers.
- Regression fixture for plain status `reports: []` plus report-full accepted `ready_for_review`.
- Regression fixture for `$.data[]` without `$.sessions[]`.
- Regression fixture for notifier-prefixed AO JSON.
- Live head-binding dry-run or fixture proving accepted current-head `ready_for_review` is eligible.
- Terminated-session report visibility fixture, or explicit live-only invariant fixture for each consumer that excludes terminated sessions.
- Existing review-head-ready and review-trigger-reconcile tests still pass.
- Pack verification scripts pass.

```contract-evidence
binding-id: orchestrator-pack:review-status-consumer:no-plain-status-false-negative
binding-type: cli-behavior
binding: review-status consumers do not conclude no ready_for_review from a plain ao status snapshot when report-full or audit-backed state contains an accepted current-head hand-off
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)

binding-id: orchestrator-pack:ao-json-reader:prefix-safe-status-json
binding-type: cli-behavior
binding: pack-owned AO JSON readers used by review-status consumers tolerate notifier/log prefixes before valid JSON or fail with a classified source-specific parse error
producer: orchestrator-pack
evidence: NEW(produced-by AC#5)
```

## Decisions

### Design analysis

Critical mechanics are the distinction between shallow session status and accepted report history, `$.data[]` vs `$.sessions[]` compatibility, JSON prefix stripping, and preserving head-ready current-head binding.

World practice is the same separation used in delivery pipelines: readiness evidence must be tied to the exact version/artifact being promoted, and diagnostics must state which evidence source they used. The local KB search did not return a repo-specific note for this incident; general artifact/release-candidate notes reinforced traceability to the exact revision.

Options considered:

| Option | Cost | Risk | Sufficiency | Decision |
| --- | ---: | ---: | ---: | --- |
| Patch only the one failed diagnostic | Low | High: leaves other consumers able to repeat the false negative | Insufficient | Rejected |
| Make all consumers use `agentReportedState` fallback | Medium | High: bypasses report/head binding and can authorize stale hand-offs | Insufficient | Rejected |
| Inventory all review-status consumers and require report-full or explicit audit-backed input | Medium | Moderate: broader tests, but preserves shipped predicate semantics | Sufficient | Chosen |

This extends #218/#391 instead of rebuilding them: the accepted report remains the source of readiness, and the fix is to prevent consumers and diagnostics from losing that report by using the wrong snapshot or parser.

### Live incident grounding

The 2026-07-05 evidence does not support a blanket statement that live reconcile proved "no report" for opk-142...145. The orchestrator pane shows the `uncovered_not_ready` wording in an in-turn diagnostic summary after "Finished Get worker workflow reports per session"; nearby periodic `review-trigger-reconcile.ps1` ticks stopped on snapshot/read errors, including notifier-prefixed JSON parsing. Later review-run state proves the four heads were not permanently invisible to the review path: #603 / `41798a0d` and #606 / `77239b22` reached clean review, while #604 / `09e2ee50` and #605 / `361eabc8` reached review runs that later became outdated after newer commits. This draft therefore keeps the shipped report-full helper guard, but adds AC#7 so the live head-binding path is proven directly rather than assumed.

### Diagnostic ownership

Repository search did not find a tracked `workflow reports per session` script. The observed source was an ad-hoc orchestrator turn query visible in the `opk-orchestrator` pane. If AC#1 later finds a tracked owner, AC#3/#4 require a fixture on that owner. If not, the durable home is prompt/config reader-contract prose plus a static/prompt fixture that prevents future ad-hoc diagnostics from using plain status, the wrong top-level field, or unnamed report paths.

### Decomposition

Kept as one draft. The report-full-form defect and notifier-prefix parse defect both affect the same review-status consumer boundary: code or prompts that obtain AO JSON and pass session/report snapshots into review readiness diagnostics. Splitting would let one half "fix" a consumer while the other still bypasses the shared safe reader; the smallest coherent PR is an inventory plus reader-contract enforcement across that boundary.