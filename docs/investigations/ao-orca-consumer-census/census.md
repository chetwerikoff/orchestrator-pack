# Closed-world AO consumer census

**Issue #1036 · PR0 · record-only**  
**Inspected source identity:** git commit `8fabf182f4df0a70e2f08f67899658ee886ab337` (2026-07-28T04:00:59Z, `chore(ci): refresh vitest runtime-history from measured heavy-shard reports (#1059)`)

**Canonical surface map:** [`surface-identity-map.md`](./surface-identity-map.md)

---

## 1. Search corpus and exclusions

### 1.1 Tracked first-party corpus (in scope for discovery)

All paths tracked in git at the inspected revision, **excluding** the explicit exclusions below.

| Corpus class | Path patterns |
|---|---|
| Pack scripts | `scripts/**` |
| Plugins | `plugins/**` |
| Behavioral contracts | `docs/**` (read as evidence; only `docs/investigations/ao-orca-consumer-census/**` is writable in PR0) |
| Worker / architect policy | `AGENTS.md`, `CLAUDE.md` |
| Prompts | `prompts/**` |
| Skills (Cursor + Claude mirrors) | `.cursor/**`, `.claude/**` |
| CI workflows | `.github/workflows/**` |
| Package entrypoints | `package.json` |
| Config example | `agent-orchestrator.yaml.example` |
| Tests | `tests/**` (discovered; classified separately) |

### 1.2 Explicit exclusions

| Exclusion | Reason |
|---|---|
| `vendor/**`, `packages/core/**` | Out of pack scope per `AGENTS.md` |
| `node_modules/**` | Third-party, not first-party consumers |
| Generated runtime / user state (`~/.agent-orchestrator`, `~/.local/state/orchestrator-pack-wake-supervisor`, operator secrets) | Not in repository; evaluation-time evidence only for axis-4 drain |
| `docs/issues_drafts/**` | Legacy draft queue; not supported live entrypoints |
| `docs/archive/**` | Archived material per `scripts/pr2a/execution-root-registry.json` `explicitlyUnsupported` |
| `tests/external-output-references/**` | Capture fixtures; non-production evidence |
| Operator-local `agent-orchestrator.yaml` (gitignored) | Not tracked; example file used for shape only |

### 1.3 Reachability lens (supported vs historical)

Supported consumers are those reachable from **live roots** in §2. References only in excluded/archive/test-fixture paths are **explicit non-consumer exclusions** (§7).

---

## 2. Live roots and supported entrypoint inventory

### 2.1 Authoritative durable-state root registry

**Provenance:** `scripts/vitest-live-store-inventory.json` (Issue #752)

| Root ID | Default location | Harness override | Kind |
|---|---|---|---|
| `wake-supervisor-state-root` | `~/.local/state/orchestrator-pack-wake-supervisor` (`${WAKE_STATE}`) | `AO_WAKE_SUPERVISOR_STATE_DIR`, `ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR` | directory |
| `ao-base-root` | `~/.agent-orchestrator` (`${AO_BASE}`) | `AO_BASE_DIR` | directory |

**Class fences (transient JSON under `${TMP}`):** `orchestrator-*.json`, `orchestrator-*.lock` — see inventory `classFences`.

### 2.2 Pack store registry (30 stores)

**Provenance:** `scripts/vitest-live-store-inventory.json` → `stores[]`

`orchestrator-escalation-state`, `orchestrator-operator-inbox`, `orchestrator-escalation-health-spool`, `wake-supervisor-runtime-state`, `worker-message-dispatch-journal`, `worker-message-submit-state`, `worker-message-submit-state-root-anchor`, `worker-status-store`, `review-delivery-lifecycle`, `review-handoff-wake-admission`, `review-ready-report-state-seed`, `review-trigger-reeval-watch`, `worker-report-store`, `pr-session-binding-cache`, `review-start-claim-namespace`, `worker-nudge-claim-namespace`, `mechanical-transport`, `ci-green-wake-state`, `dead-worker-reconcile-state`, `review-trigger-reconcile-state`, `orchestrator-wake-dedup-state`, `review-wake-side-effect-lock`, `worker-message-adoption-state`, `journaled-worker-send-dryrun`, `worker-message-adoption-dryrun`, `autonomous-claim-pr-resume-namespace`, `orchestrator-review-start-audit`, `worker-nudge-gate-audit`, `review-run-store`, `orchestrator-side-effect-locks`

### 2.3 Execution-root registry (closed-world reachability)

**Provenance:** `scripts/pr2a/execution-root-registry.json` (Issue #948)

| Root ID | Patterns |
|---|---|
| `verify` | `scripts/verify.ps1`, `scripts/check-*.ps1`, `scripts/test-all.ps1` |
| `workflow` | `.github/workflows/**` |
| `package` | `package.json` |
| `operator-worker` | `scripts/*.ps1`, `scripts/*.ts`, `scripts/*.mjs`, `scripts/*.sh` |
| `tests` | `scripts/**/*.test.ts`, `tests/**` |
| `command-config` | `agent-orchestrator.yaml.example`, `scripts/**/*.json`, `docs/**/*.md` |

**Explicitly unsupported (not live):** `docs/archive/**`, `docs/issues_drafts/**`, `docs/declarations/**`, `tests/external-output-references/**`, `vendor/**`

### 2.4 Side-process supervisor children

**Provenance:** `scripts/orchestrator-side-process-registry.json`

| Child ID | Script | Cadence | AO session required |
|---|---|---|---|
| `review-trigger-reconcile` | `review-trigger-reconcile.ps1` | 600s | no |
| `review-trigger-reeval` | `review-trigger-reeval.ps1` | 5s | no |
| `review-ready-report-state-seed` | `review-ready-report-state-seed.ps1` | 5s | no |

**Parent entrypoint:** `scripts/orchestrator-wake-supervisor.ps1`

### 2.5 Workflow entrypoints

**Provenance:** `.github/workflows/*.yml` — CI invokes `scripts/verify.ps1` / `check-reusable.ps1` (indirect gate; no direct `ao` verbs in workflows at inspected revision).

### 2.6 Package-level entrypoints

**Provenance:** `package.json` `scripts` — Node 22 vitest/lint targets; no direct `ao` CLI invocation (orchestration scripts invoked by npm are under `scripts/`).

### 2.7 Operator / worker entrypoint classes

| Class | Representative entrypoints |
|---|---|
| Operator bootstrap | `scripts/bootstrap.ps1` |
| Reviewer switch | `scripts/set-pack-reviewer.ps1` (`daemon.lifecycle`) |
| Diagnostics | `scripts/orchestrator-diagnose.ps1` |
| Worktree hygiene | `scripts/orchestrator-worktree-preflight.ps1` |
| Worker report CLI | `scripts/pack-worker-report.ps1` |
| Worker send | `scripts/journaled-worker-send.ps1` |
| Review runner | `scripts/pack-review-runner.ts` |
| Plugin bins | `plugins/ao-task-declaration/bin/declare.ts`, `plugins/ao-scope-guard/bin/scope-check.ts` |
| Worker policy first action | `AGENTS.md` → `ao session get` |

### 2.8 Behavioral contract roots (`docs/*.mjs`)

**Provenance:** `scripts/reachability-purge.manifest.json` root set — 72 first-party `docs/*.mjs` contracts reachable from `scripts/check-reusable.ps1`. These are census **evidence**, not live AO transports.

### 2.9 Launch-argv inventory (Issue #661)

**Provenance:** `scripts/launch-argv-inventory.json`, `docs/launch-argv-registry.mjs`  
At inspected revision `rows` is empty (generated placeholder); argv coverage is absorbed via `check-ao-cli-argv-shape.ps1` per `absorbedCoverage`.

---

## 3. Discovery methods and completeness

### Axis 1 — AO invocation / transport

| Pass | Method | Coverage argument |
|---|---|---|
| **1a CLI** | `grep -rE '\bao (status|session|orchestrator|send|spawn|stop|start|events|review|report|acknowledge|project)\b' scripts plugins docs AGENTS.md CLAUDE.md prompts .claude .cursor agent-orchestrator.yaml.example` excluding `tests/**`, `fixtures/**`, `docs/investigations/**` | Hits every script/doc/config-example with literal `ao` verb invocation including `ao project get`; cross-checked against adapter exports in `Invoke-AoCliJson.ps1` |
| **1e command-config** | Same pattern scoped to `agent-orchestrator.yaml.example` only (execution-root `command-config` per §2.3) | Independent pass for normative orchestratorRules text omitted from script-only greps |
| **1b HTTP/API** | `grep -rE '/api/v1/|Invoke-AoDaemonHttpJson|Invoke-WebRequest.*127\.0\.0\.1' scripts` | Independent of CLI grep; finds daemon HTTP consumers |
| **1c Library/adapter** | Read exports: `Invoke-AoCliJson.ps1`, `Invoke-AoReviewApi.ps1`, `pack-review-runner.ts`, `docs/ao-0-10-review-api.mjs` | Ensures adapter hub surfaces not missed by literal `ao` string in caller |
| **1d Retired surface guard** | `scripts/json-producers/retired-surfaces.json`, `scripts/check-ao-dead-argv-bypass.ps1` | Classifies retired verbs vs live |
| **Completeness** | Union of 1a–1e must cover every function in adapter hubs, every production script in side-process registry + reconcile family, and `agent-orchestrator.yaml.example` orchestratorRules | CLI-only search over `scripts plugins docs` alone is **insufficient** — 1b and 1e required and recorded |

### Axis 2 — Environment variables (`AO_*`)

| Pass | Method | Coverage argument |
|---|---|---|
| **Primary** | `grep -rhoE 'AO_[A-Z0-9_]+'` over tracked corpus (§1.1), excluding wildcard fragments (`grep -vE '_$'`) and path exclusions (`docs/issues_drafts/**`, `docs/archive/**`, `docs/investigations/**`, `tests/external-output-references/**`) | Enumerates every distinct name in the declared corpus only |
| **Per-consumer bindings** | AO-runtime tokens only: map each reader to a canonical surface from [`surface-identity-map.md`](./surface-identity-map.md); pack-owned names → [`ao-env-exclusions.md`](./ao-env-exclusions.md) §7.3 | No invented `env.*` pseudo-surfaces |
| **Completeness** | **274** distinct token names; **148** AO consumer binding rows; **255** excluded tokens (reproduction commands in inventory headers) |

### Axis 3 — Worker-facing behavioral text

| Pass | Method | Coverage argument |
|---|---|---|
| **Primary** | Grep `ao ` instructions in `AGENTS.md`, `CLAUDE.md`, `prompts/**`, `docs/*runbook*.md`, `plugins/**/README.md`, `agent-orchestrator.yaml.example` | Normative worker/operator surfaces including orchestratorRules example |
| **Independent cross-check** | Grep same pattern in `.claude/skills/**/SKILL.md`, `.cursor/skills/**/SKILL.md` | Different root set (skills not in primary grep path) |
| **Discrepancy accounting** | `switch-pack-reviewer` skill still mentions `ao review list` — recorded as **shed** doc-debt binding on `review.project-list` in §5.3 / [`axis3-bindings.md`](./axis3-bindings.md) | No silent drop |
| **Completeness** | **15** consumer×surface rows in [`axis3-bindings.md`](./axis3-bindings.md) |

### Axis 4 — AO-generated identity in durable records

| Pass | Method | Coverage argument |
|---|---|---|
| **Primary** | `scripts/vitest-live-store-inventory.json` → for each `stores[]` entry read `sourceFiles` / resolver + contract `docs/*.mjs` when present; classify persisted `sessionId` / `linkedSessionId` / claim-holder session fields | Registry-complete (all 30 stores) |
| **Independent cross-check** | `grep -lE 'sessionId|linkedSessionId' docs/*.mjs scripts/lib/*.ps1 scripts/lib/Record-*.ps1` | Catches admission/reconcile writers without `Store` in filename (e.g. `Record-ReviewHandoffWakeAdmission.ps1`) |
| **Completeness** | Every registry store with AO-identity fields is either a §5.4 **drain** binding or an explicit reproducible exclusion; non-identity stores (e.g. `ci-green-wake-state`) documented in §7.4 |

### Axis 5 — Lifecycle and recovery assumptions

| Pass | Method | Coverage argument |
|---|---|---|
| **Primary** | `docs/orchestrator-recovery-runbook.md`, `AGENTS.md` managed-session constraints, `scripts/wait-orchestrator-launch.ps1` | Normative lifecycle |
| **Independent cross-check** | `grep -lE 'Get-AoDaemonHealthJson|ao stop|ao start|session kill|session restore' scripts/lib/*.ps1 scripts/*.ps1` | Implementation-enforced assumptions |
| **Discrepancy accounting** | Runbook still documents retired `ao status --reports` / `ao review list` — bound as **shed** historical text (§5.5 / [`axis5-bindings.md`](./axis5-bindings.md)) |
| **Completeness** | **12** consumer×surface rows in [`axis5-bindings.md`](./axis5-bindings.md) |

---

## 4. Axis 2 summary — `AO_*` variable taxonomy

**Distinct tracked names:** 274 — **148** AO consumer bindings ([`ao-env-token-inventory.md`](./ao-env-token-inventory.md)) + **255** explicit exclusions ([`ao-env-exclusions.md`](./ao-env-exclusions.md)).

§4.1–4.3 below summarize runtime vs pack-owned vs plugin-tuning **accounting**; only §4.1 names enter `B(S)` as axis-2 bindings. Pack-owned and plugin-tuning `AO_*` names are §7.3 exclusions.

### 4.1 AO-runtime injected (identity / project context)

Read by production code expecting AO daemon to set values.

| Variable | Example consumers | Class |
|---|---|---|
| `AO_SESSION_ID` | `AGENTS.md`, `pack-worker-report.ps1`, plugins, nudge gates | **port** |
| `AO_WORKER_SESSION_ID` | Binding cache, vitest harness, pack-worker-report | **port** |
| `AO_ORCHESTRATOR_SESSION_ID` | `wait-orchestrator-launch.ps1`, wake supervisor | **port** |
| `AO_PROJECT_ID`, `AO_PROJECT` | Review reconcile, spawn gates | **port** |
| `AO_ISSUE_NUMBER`, `AO_ISSUE_ID` | Scope guard, binding cache | **port** |
| `AO_REPO_SLUG`, `AO_PR_NUMBER`, `AO_HEAD_SHA`, `AO_PR_HEAD_SHA` | Worker report, binding, review start | **port** |
| `AO_COMMAND`, `AO_CHILD_GENERATION` | Claim namespaces | **port** |
| `AO_CHAIN_ID`, `AO_TASK_ID`, `AO_SESSION_INFO_JSON`, `AO_PARENT_SESSION_ID` | Token-chain ledger plugin | **port** |
| `AO_ITERATION_ID` | Task declaration plugin | **port** |

### 4.2 Pack-owned store / capability addresses (AO-flavoured name, pack semantics)

**Not AO consumer bindings.** Accounted as explicit non-consumer exclusions in [`ao-env-exclusions.md`](./ao-env-exclusions.md) §7.3 (path/tuning obligations may **port** at the pack-store seam without being AO transport consumers).

### 4.3 Plugin / reviewer tuning (pack subprocess)

**Not AO consumer bindings.** `AO_SCOPE_GUARD_*`, `AO_CODEX_REVIEW_*`, `AO_REVIEW_*_BUDGET_*`, `AO_DIRECT_EDIT_*`, `AO_DRAFT_AUTHOR_*` → [`ao-env-exclusions.md`](./ao-env-exclusions.md) §7.3.

### 4.4 Test / harness-only (`AO_*_FIXTURE`, `AO_*_TEST_*`, `AO_PR856_*`, vitest supervisor test hooks)

**Explicit non-consumer exclusions** for production census — see §7.2. Classification: **shed** (no post-AO obligation on live roots).

---

## 5. Consumer-to-AO-surface bindings

**Unit:** one consumer path × one canonical surface × one axis.  
**Classifications:** `port` | `shed` | `drain` only.

### 5.1 Axis 1 — invocation / transport (production)

| Consumer | Surface ID | Representation evidence | Consumer reason | Class |
|---|---|---|---|---|
| `scripts/lib/Invoke-AoCliJson.ps1` | `daemon.health`, `session.list.*`, `session.get`, `events.list` | Adapter functions | Central JSON CLI adapter for all read paths | **port** |
| `scripts/lib/Invoke-AoReviewApi.ps1` | `daemon.health`, `project.config.*`, `review.*` | HTTP + `pack-review-runner.ts` bridge | Review + project config transport | **port** |
| `scripts/pack-review-runner.ts` | `review.trigger`, `review.session-list` | TS CLI `start`/`list` | Canonical 0.10 review producer | **port** |
| `scripts/journaled-worker-send.ps1` | `send.message` | `ao send --session --message` | Worker/orch messaging | **port** |
| `scripts/lib/Worker-Recovery.ps1` | `spawn.worker` | `ao spawn` argv | Dead worker recovery | **port** |
| `scripts/set-pack-reviewer.ps1` | `daemon.lifecycle` | `ao stop` / `ao start` | Operator reviewer switch | **port** |
| `scripts/orchestrator-diagnose.ps1` | `daemon.health`, `review.runs.aggregate`, `events.list` | Adapter calls | Read-only diagnostics | **port** |
| `scripts/terminal-flood-detect.ps1` | `events.list` | `ao events list` | Terminal flood detection obligation | **port** (behavior survives; must migrate off retired CLI to pack-store/degraded telemetry — not axis-4 `drain`) |
| `agent-orchestrator.yaml.example` | `send.message` | `ao send` in orchestratorRules / heartbeat | Orchestrator nudge transport | **port** |
| `agent-orchestrator.yaml.example` | `session.merged-view` | `ao status --json --reports full` | Worker/orchestrator session + report snapshot | **port** |
| `agent-orchestrator.yaml.example` | `events.list` | `ao events list --json` | Event-silence / ping dedup evidence | **port** |
| `agent-orchestrator.yaml.example` | `session.lifecycle` | `ao session kill` | Stale worker recycle | **port** |
| `agent-orchestrator.yaml.example` | `spawn.claim-pr` | `ao spawn --claim-pr` | Worker respawn after ping timeout | **port** |
| `agent-orchestrator.yaml.example` | `daemon.lifecycle` | `ao stop` / `ao start` | Operator rules adoption | **port** |
| `agent-orchestrator.yaml.example` | `report.worker-state` | `ao report` (legacy ack text) | Retired worker ack path | **shed** |
| `scripts/review-trigger-reconcile.ps1` | `review.runs.aggregate`, `review.trigger` | `Get-AoReviewRuns` + runner | Automatic review starts | **port** |
| `scripts/harness-post-submit-pn-reconcile.ps1` | `review.fail-stale` | HTTP POST fail-stale | Harness PN recovery | **port** (gated on `AO_REVIEW_FAIL_STALE_SURFACE`) |
| `scripts/pack-worker-report.ps1` | `pack.worker-report` | Pack CLI | Replaces `report.worker-state` | **port** |
| `plugins/ao-task-declaration/bin/declare.ts` | `plugin.declare` | Plugin bin | Declaration hook | **port** |
| `plugins/ao-scope-guard/bin/scope-check.ts` | `plugin.scope-guard` | Plugin bin | Scope enforcement | **port** |
| `plugins/ao-codex-pr-reviewer/lib/review_cli.ts` | `plugin.review-command` | `REVIEW_COMMAND` subprocess | PR review execution | **port** |
| `plugins/ao-token-chain-ledger/lib/writer.ts` | `plugin.token-ledger` | Plugin hook env | Cost accounting | **port** |
| `.claude/skills/merge-with-local-adoption/SKILL.md` | `project.config.read` | `ao project get orchestrator-pack --json` | Post-merge adoption snapshot | **port** |
| `.claude/skills/change-orchestrator-runtime/SKILL.md` | `project.config.read` | `ao project get … --json` | Runtime verification | **port** |
| `docs/ao-0-10-review-harness-adoption.md` | `project.config.read` | `ao project get orchestrator-pack --json` | Harness adoption read | **port** |
| `scripts/check-ao-cli-argv-shape.ps1` | `session.*`, `daemon.health` | Live argv probes | CI guard for adapter adoption | **port** |
| `scripts/check-ao-dead-argv-bypass.ps1` | retired + active surfaces | Forbidden argv patterns | Prevents retired surface bypass | **port** |
| Historical callers of `ao report` / `ao review list` | `report.worker-state`, `review.project-list` | grep hits only in runbooks/drafts | No production script at live roots | **shed** |

### 5.2 Axis 1 — HTTP-only consumers (independent of CLI grep)

| Consumer | Surface ID | HTTP path | Class |
|---|---|---|---|
| `Invoke-AoReviewApi.ps1` | `project.config.read` | `GET /api/v1/projects/{id}` | **port** |
| `Invoke-AoReviewApi.ps1` | `project.config.write` | `PUT /api/v1/projects/{id}/config` | **port** |
| `harness-post-submit-pn-reconcile.ps1` | `review.fail-stale` | `POST …/reviews/runs/{runId}/fail-stale` | **port** |
| `docs/ao-0-10-review-api.mjs` | `review.session-list`, `review.trigger` | Contract paths (see surface map) | **port** (contract, not caller) |

### 5.3 Axis 3 — worker-facing behavioral text

Full binding inventory (consumer × canonical surface × axis): [`axis3-bindings.md`](./axis3-bindings.md) (**15 rows**).

| Consumer path | Canonical surface ID | Class | Notes |
|---|---|---|---|
| `AGENTS.md` | `session.get` | **port** | First-action session verification |
| `AGENTS.md` | `daemon.lifecycle` | **port** | Forbid daemon restart in managed workers |
| `AGENTS.md` | `pack.worker-report` | **port** | Replaces AO report |
| `AGENTS.md` | `plugin.review-command` | **port** | Review pipeline |
| `plugins/ao-codex-pr-reviewer/README.md` | `plugin.review-command` | **port** | Review subprocess |
| `docs/orchestrator-recovery-runbook.md` | `session.lifecycle` | **port** | Recovery kill/restore |
| `docs/orchestrator-recovery-runbook.md` | `daemon.health` | **port** | Daemon assumptions |
| `.claude/skills/merge-with-local-adoption/SKILL.md` | `session.lifecycle` | **port** | Post-merge recycle |
| `.claude/skills/change-orchestrator-runtime/SKILL.md` | `daemon.lifecycle` | **port** | Operator restart |
| `.claude/skills/switch-pack-reviewer/SKILL.md` | `review.project-list` | **shed** | Retired `ao review list` |
| `docs/orchestrator-recovery-runbook.md` | `review.project-list` | **shed** | Retired review list text |
| `prompts/investigate_root_cause.md` | `report.status-embed` | **shed** | Retired status --reports |
| `prompts/investigate_root_cause.md` | `report.worker-state` | **shed** | Retired ao report |
| `agent-orchestrator.yaml.example` | `report.worker-state` | **shed** | Legacy ack lines |
| `CLAUDE.md` | `spawn.worker` | **port** | Architect spawn delegation |

### 5.4 Axis 4 — durable stores with AO session identity

**Mandatory class:** `drain` (not `shed`).

| Store ID | Canonical surface ID | Persisted AO identity | Readers / recovery paths | Liveness boundary | Drained condition | Evidence feasibility |
|---|---|---|---|---|---|---|
| `worker-report-store` | `durable-store.worker-report-store` | `sessionId` per report record | `Get-WorkerStatusSessionsWithReports`, `pack-worker-report`, `WorkerReportStore.ps1` | Record keyed by repo\|session\|pr\|head; overlay until explicitly stale | No supported reader treats record as actionable AO session command target | **Observable:** read store file via `Get-WorkerReportStoreState` / `docs/worker-report-store.mjs` CLI; production path: `scripts/show-worker-status-report.ps1` merges store + session lists |
| `pr-session-binding-cache` | `durable-store.pr-session-binding-cache` | `sessionId` in session↔PR bindings | `docs/pr-session-binding-cache.mjs`, review reconcile, PR/session resolvers | Binding live while session row exists and PR open | Bindings for terminated sessions removed or marked inert per contract | **Observable:** `AO_PR_SESSION_BINDING_CACHE` file parse via contract CLI |
| `worker-status-store` | `durable-store.worker-status-store` | `sessionId` keyed status | `Get-WorkerStatusDecisionSessions`, `show-worker-status-report.ps1` | Entry per worker session | Status rows for non-existent sessions ignored by gating | **Observable:** `scripts/show-worker-status-report.ps1 --json` |
| `worker-message-dispatch-journal` | `durable-store.worker-message-dispatch-journal` | Sender `AO_SESSION_ID` in dispatch records | Submit reconcile, dispatch observe | Journal retention per contract | No pending dispatch requiring AO session | **Observable:** journal file via `Get-WorkerMessageDispatchJournalPath` |
| `review-run-store` | `durable-store.review-run-store` | `linkedSessionId` on run rows | `pack-review-runner.ts list`, `Get-AoReviewRuns` | Run terminal states + retention in `docs/review-run-liveness.mjs` | No in-flight runs referencing AO session for action | **Observable:** pack review runner `list` JSON |
| `review-start-claim-namespace` | `durable-store.review-start-claim-namespace` | Claim holder session / generation | `review-start-claim-store.ts`, review runner | Claim lease TTL + stale reaper | No active claim blocking review start | **Observable:** claim dir listing + contract evaluators |
| `worker-nudge-claim-namespace` | `durable-store.worker-nudge-claim-namespace` | Nudge claim holder session | `Worker-NudgeClaim.ps1`, nudge gate | Claim stale minutes | No live nudge claim | **Observable:** claim namespace under `AO_BASE_DIR` |
| `mechanical-transport` | `durable-store.mechanical-transport` | Target session in transport payload files | `journaled-worker-send.ps1`, mechanical reconcile | `AO_MECHANICAL_TRANSPORT_MAX_AGE_SECONDS` | No unconsumed transport files | **Observable:** directory listing + age |
| `dead-worker-reconcile-state` | `durable-store.dead-worker-reconcile-state` | Last known worker `sessionId` | `dead-worker-reconcile.ps1` | Reconcile state machine terminal | Reconcile finished or session respawned | **Observable:** state file via resolver |
| `orchestrator-escalation-state` | `durable-store.orchestrator-escalation-state` | Orchestrator `sessionId` in escalation records | `Orchestrator-Escalation.ps1`, escalation router | Escalation terminal states | No open escalation requiring AO orchestrator session | **Partially observable:** state file read; cross-check with `ao session get` — **presently unprovable** for pure file→liveness without operator session pull. **Owner:** PR7 deletion wave. **Zero-consumer blocked** until evaluation-time session liveness proof supplied |
| `review-handoff-wake-admission` | `durable-store.review-handoff-wake-admission` | `sessionId` in handoff wake admission audit rows | `Record-ReviewHandoffWakeAdmission.ps1`, `docs/review-handoff-wake-admission.mjs`, review wake filters | Admission row keyed by session\|pr\|head; retained per contract TTL | No supported reader treats admission row as actionable AO session target | **Observable:** `docs/review-handoff-wake-admission.mjs` CLI + state file via `Get-ReviewHandoffWakeAdmissionStatePath` |

**Axis-4 open question (permitted — does not change `drain` class):** For `orchestrator-escalation-state`, whether all records are drained requires proving target orchestrator session is terminated. Production lacks a single automated producer that emits “escalation drained” without `session.get`. Recorded as **presently unprovable**; zero-consumer for surfaces depending on that store remains **blocked**.

### 5.5 Axis 5 — lifecycle and recovery assumptions

Full binding inventory: [`axis5-bindings.md`](./axis5-bindings.md) (**12 rows**).

| Consumer path | Canonical surface ID | Class |
|---|---|---|
| `scripts/lib/Orchestrator-SideProcessHealth.ps1` | `daemon.health` | **port** |
| `scripts/lib/Invoke-AoCliJson.ps1` | `daemon.health` | **port** |
| `AGENTS.md` | `session.get` | **port** |
| `AGENTS.md` | `daemon.lifecycle` | **port** |
| `docs/orchestrator-recovery-runbook.md` | `session.lifecycle` | **port** |
| `scripts/wait-orchestrator-launch.ps1` | `session.get` | **port** |
| `scripts/set-pack-reviewer.ps1` | `daemon.lifecycle` | **port** |
| `.claude/skills/change-orchestrator-runtime/SKILL.md` | `daemon.lifecycle` | **port** |
| `.claude/skills/merge-with-local-adoption/SKILL.md` | `session.lifecycle` | **port** |
| `docs/orchestrator-recovery-runbook.md` | `report.status-embed` | **shed** |
| `docs/orchestrator-recovery-runbook.md` | `report.worker-state` | **shed** |
| `docs/orchestrator-recovery-runbook.md` | `review.project-list` | **shed** |

---

## 6. Classification summary by canonical surface

| Surface ID | port | shed | drain | Primary migration note |
|---|---|---|---|---|
| `daemon.health` | ✓ | | | Required for any transport adapter |
| `session.list.*` / `session.get` / `session.merged-view` | ✓ | | | Core session port |
| `send.message` | ✓ | | | Orca messaging adapter |
| `spawn.*` | ✓ | | | Worker spawn port |
| `session.lifecycle` / `daemon.lifecycle` | ✓ | | | Operator recovery port |
| `project.config.*` | ✓ | | | Reviewer harness |
| `review.trigger` / `review.session-list` / `review.runs.aggregate` | ✓ | | | Pack runner + HTTP |
| `review.fail-stale` | ✓ | | | Upstream-gated |
| `pack.worker-report` | ✓ | | | Already pack-owned |
| `plugin.*` | ✓ | | | Hook ports |
| `report.worker-state` / `report.status-embed` | | ✓ | | Retired |
| `review.project-list` / `review.daemon-cli` | | ✓ | | Retired |
| `events.list` | ✓ | ✓ | | CLI representation shed on some builds; live consumers **port** to alternate telemetry |
| Axis-4 stores (all) | | | ✓ | Drain before deletion |

---

## 7. Explicit non-consumer exclusions

### 7.1 Historical / retired references

| Discovery | Exclusion reason |
|---|---|
| `ao review run/send/execute` in drafts/archive | Not reachable from live roots |
| `AO_DAEMON_URL` | Mention-only in excluded `docs/issues_drafts/**` (Issue #214 draft); no production reader |
| `scripts/ao-review.ps1` | Retired path (Issue #839) |
| `tests/external-output-references/captures/ao-0-10-cli/**` | Test capture fixtures only |
| Estate-cut `ao-reviews-board` artifacts per `scripts/estate-cut/` | Explicitly removed surfaces |

### 7.2 Test-only `AO_*` and supervisor test hooks

All variables matching `*_FIXTURE`, `*_TEST_*`, `AO_WAKE_SUPERVISOR_TEST_*`, `AO_PR856_*`, `AO_AGENT_ORCHESTRATOR_STATE_DIR` (harness-only) — excluded from production consumer census; they do not appear on supported live roots.

### 7.3 Pack-owned `AO_*` names (not axis-2 AO consumers)

Pack store paths, reviewer tuning, reconcile state filenames, and other AO-flavoured configuration tokens are **not** AO transport consumer bindings. Full per-token exclusion inventory: [`ao-env-exclusions.md`](./ao-env-exclusions.md) (**255** tokens). Obligations may **port** at the pack-store seam without entering `B(S)`.

### 7.4 Durable stores without persisted AO session identity

Registry stores in §2.1 that do **not** persist `sessionId` / `linkedSessionId` / claim-holder session fields — outside axis-4 **drain** scope (no zero-consumer drain proof required for AO session identity retirement):

`orchestrator-operator-inbox`, `orchestrator-escalation-health-spool`, `wake-supervisor-runtime-state`, `worker-message-submit-state`, `worker-message-submit-state-root-anchor`, `review-delivery-lifecycle`, `review-ready-report-state-seed`, `review-trigger-reeval-watch`, `ci-green-wake-state`, `review-trigger-reconcile-state`, `orchestrator-wake-dedup-state`, `review-wake-side-effect-lock`, `worker-message-adoption-state`, `journaled-worker-send-dryrun`, `worker-message-adoption-dryrun`, `autonomous-claim-pr-resume-namespace`, `orchestrator-review-start-audit`, `worker-nudge-gate-audit`, `orchestrator-side-effect-locks`

### 7.5 Deny-list mention-only

Files under census deny-list (`vendor/**`, etc.) may mention AO in comments; excluded because outside pack implementation scope.

---

## 8. Accounting closure

Every raw discovery from §3 methods is accounted as:

1. A binding row in §5 (axes 1, 3, 4, 5), or
2. A per-consumer axis-2 row in [`ao-env-token-inventory.md`](./ao-env-token-inventory.md), or
3. An explicit axis-2 exclusion in [`ao-env-exclusions.md`](./ao-env-exclusions.md) / §7, or
4. A §7.4 durable-store exclusion (no AO session identity persisted).

**Unaccounted discoveries at inspected revision:** none.

---

## 9. Reproduction attestation

To re-validate this census from source:

1. Checkout `8fabf182f4df0a70e2f08f67899658ee886ab337`.
2. Run reproduction commands in [`README.md`](./README.md).
3. Verify live root inventory matches §2 (vitest inventory JSON parse).
4. Verify axis-1 HTTP paths appear in `Invoke-AoReviewApi.ps1` / `harness-post-submit-pn-reconcile.ps1`.
5. Verify axis-4 store count = 30 from inventory.
6. Cross-check axis 3 skills discrepancy: `switch-pack-reviewer` retired `ao review list` reference.

No classification-determinative question remains open except axis-4 **presently unprovable** drain witness noted in §5.4 (escalation liveness), which does not change `drain` classification.
