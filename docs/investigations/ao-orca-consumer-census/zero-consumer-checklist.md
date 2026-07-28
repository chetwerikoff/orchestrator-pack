# Zero-consumer checklist contract

**Issue #1036 · PR0 · derived from** [`census.md`](./census.md) **and** [`surface-identity-map.md`](./surface-identity-map.md)

This document defines a **reusable, checkable verdict function** for whether a named canonical AO surface has **zero remaining consumers** at evaluation time. It does not perform evaluation in PR0; it records the contract later waves (PR7, PR8) must apply.

**PR1 exemption:** PR1 dead-cut files unreachable from live roots do **not** require a zero-consumer verdict from this checklist.

---

## 1. Inputs

Evaluation is over **two logical inputs** (both required when drain bindings exist):

| Input | Definition |
|---|---|
| **Candidate repository state** | Exact git commit (or immutable archive) whose tracked first-party corpus is evaluated. Must match the census method corpus in [`census.md` §1](./census.md#1-search-corpus-and-exclusions). |
| **Evaluation-time evidence set** | Binding-specific facts not determined by repository bytes alone — principally axis-4 **drained** conditions on live durable stores. Each evidence item must cite producer + observation surface per census §5.4. |

---

## 2. Surface selection

1. Choose canonical surface ID `S` from [`surface-identity-map.md`](./surface-identity-map.md).
2. Apply the representation map: merge all transport/CLI/HTTP aliases into `S`.
3. Let `B(S)` = { bindings in census whose canonical surface is `S` } across axes 1–5.

Syntax or transport aliases **must not** split one semantic surface or omit a binding.

---

## 3. Verdict function

Define `zero_consumer(S, repo, evidence) → boolean`.

**`zero_consumer` is true iff ALL of the following hold:**

### 3.1 Closed-world accounting

The documented discovery method in [`census.md` §3](./census.md#3-discovery-methods-and-completeness), reapplied to `repo`, accounts for every AO-related discovery as either:

- a binding in `B(S)` or another surface’s binding set, or
- an explicit non-consumer exclusion with reproducible reason ([`census.md` §7](./census.md#7-explicit-non-consumer-exclusions)).

**Failure → `not zero-consumer / blocked` (unaccounted discovery).**

### 3.2 Port bindings (`port`)

For every binding `b ∈ B(S)` with class **port**:

- No supported live root in `repo` still depends on **AO-specific transport** for `S` (CLI `ao …`, daemon HTTP to AO, or AO-injected plugin hook path).
- The behavioral obligation is preserved through an authorized post-AO surface (Orca adapter seam per architect 2026-07-27 — **context only**, not evaluated in PR0).

**Failure → `not zero-consumer / blocked` (remaining AO-dependent port).**

### 3.3 Shed bindings (`shed`)

For every binding `b ∈ B(S)` with class **shed**:

- No supported live root invokes or normatively requires `S`.
- Any remaining bytes/text are explicitly classified as historical/inert with exclusion reason in the census method.

**Failure → `not zero-consumer / blocked` (live shed consumer).**

### 3.4 Drain bindings (`drain`)

For every binding `b ∈ B(S)` with class **drain** (all axis-4 AO-identity stores are drain):

- `evidence` must establish the **drained condition** stated in census §5.4 for that store binding.
- Evidence must be fresh and provenanced per the **later deletion wave** (PR0 does not define freshness machinery).
- If census marks the binding **presently unprovable** (no production-supported observation surface), `zero_consumer` is **false** regardless of `repo`.

**Failures:**

| Condition | Result |
|---|---|
| Missing evaluation-time evidence | `not zero-consumer / blocked` |
| Stale / unproven evidence | `not zero-consumer / blocked` |
| Presently unprovable drain witness (census §5.4) | `not zero-consumer / blocked` |
| Undrained AO-identity records consultable by supported readers | `not zero-consumer / blocked` |

### 3.5 Classification and exclusions

- No binding in `B(S)` has an unresolved **classification-determinative** question.
- Every non-consumer exclusion relied upon is **reproducible** from `repo` (not operator memory).

**Failure → `not zero-consumer / blocked`.**

---

## 4. Blocked surfaces at PR0 baseline (inspected revision)

These canonical surfaces **cannot** yield `zero_consumer = true` today because live `port`/`drain` bindings remain at `8fabf182f4df0a70e2f08f67899658ee886ab337`:

| Surface ID | Blocking reason (summary) |
|---|---|
| `daemon.health` | Universal adapter dependency |
| `session.list.*`, `session.get`, `session.merged-view` | Live worker/supervisor/session tooling |
| `send.message` | `journaled-worker-send.ps1` |
| `spawn.worker`, `spawn.claim-pr` | Recovery + worker spawn |
| `review.trigger`, `review.session-list`, `review.runs.aggregate` | Review pipeline |
| `pack.worker-report` | Active worker handoff |
| `plugin.declare`, `plugin.scope-guard`, `plugin.review-command`, `plugin.token-ledger` | Plugin hooks |
| All axis-4 store bindings | **drain** not satisfied; escalation store additionally **presently unprovable** |

**Shed surfaces** (`report.worker-state`, `review.project-list`, `review.daemon-cli`) may reach `zero_consumer = true` **only after** §3.3 confirms no live normative text or code references remain (several **drain** doc-debt bindings still mention them — see census §5.3).

---

## 5. Per-surface checklist template (for PR7 / PR8)

For each surface `S` in deletion scope, record:

```
Surface ID:
Candidate repo SHA:
Evaluator / wave:

[ ] 3.1 Reapplied census method — no unaccounted discoveries
[ ] 3.2 All port bindings — AO transport absent; obligation ported
[ ] 3.3 All shed bindings — absent from live roots or excluded
[ ] 3.4 All drain bindings — evaluation-time evidence attached
      - Store ID:
        - Producer:
        - Observation surface:
        - Drained condition met: yes/no
[ ] 3.5 No open classification questions; exclusions proven

Verdict: zero-consumer | not zero-consumer / blocked
Evidence bundle refs:
```

---

## 6. Downstream obligations (record-only)

| Consumer wave | Obligation |
|---|---|
| **PR1** | **Exempt** from zero-consumer gate |
| **PR7** | Must cite `zero_consumer(S, repo, evidence) = true` for each surface in PR7 deletion scope |
| **PR8** | Same as PR7 for PR8-scoped surfaces |

PR0 adds **no** runtime enforcement, CI gate, or attestation persistence. The census and this checklist are **revision-bound evidence**, not a permanent registry.

---

## 7. PR0 evidence feasibility summary (axis 4)

| Store binding | Production observation surface (when established) | Presently unprovable? |
|---|---|---|
| `worker-report-store` | `Get-WorkerReportStoreState` / worker report store CLI; `show-worker-status-report.ps1` | no |
| `pr-session-binding-cache` | Contract CLI via `docs/pr-session-binding-cache.mjs` | no |
| `worker-status-store` | `scripts/show-worker-status-report.ps1 --json` | no |
| `worker-message-dispatch-journal` | Journal path resolver + file read | no |
| `review-run-store` | `pack-review-runner.ts list` | no |
| `review-start-claim-namespace` | Claim namespace listing + contract evaluators | no |
| `worker-nudge-claim-namespace` | Claim namespace listing | no |
| `mechanical-transport` | Transport dir listing + max age | no |
| `dead-worker-reconcile-state` | State file via `Get-DeadWorkerStatePath` | no |
| `orchestrator-escalation-state` | File read only; session termination requires `session.get` | **yes** — owner: PR7 wave |

Until unprovable bindings gain a production-supported producer, **any surface whose deletion requires that drain proof remains blocked**.

---

## 8. Relation to repository verification

PR0 acceptance uses standard repository checks (`scripts/verify.ps1`, `scripts/check-reusable.ps1`) plus diff scope inspection — **not** a live `zero_consumer` evaluation. This checklist is the contract later waves execute against their candidate `repo` + `evidence`.
