# Issue queue index

Canonical map from `docs/issues_drafts/NN-<slug>.md` to GitHub Issue numbers.
**Live status** (open / closed) is never stored here — query GitHub:

```powershell
gh issue view <N> --repo chetwerikoff/orchestrator-pack --json state,title
```

Do not infer planned, shipped, or open from a draft file existing or from a
draft filename prefix alone.

## How to reference work

Two independent numbering schemes exist:

| Scheme | Example | Meaning |
|--------|---------|---------|
| **Draft path** (stable) | `docs/issues_drafts/19-codex-review-finding-bar.md` | Local spec file; prefix `19` is **not** a GitHub Issue number. |
| **GitHub Issue** (tracker) | `#51` | Live queue item; resolve via this registry or the draft's `GitHub Issue:` line. |

**Collision (2026-05-28 RCA):** draft `19-codex-review-finding-bar.md` maps to
GitHub **#51** (Codex PR review finding bar). GitHub **#19** is unrelated — it is
*Auto-fix loop convergence metrics*, which descends from draft
`09-auto-fix-loop-convergence.md`. Referencing “issue 19” without a scheme is
ambiguous; always use the **draft path** or **registry-resolved `#N`**.

Prerequisites in new drafts should cite the **draft file path** plus the GitHub
number from this table when known, e.g. `docs/issues_drafts/11-orchestrator-autonomous-review-loop.md` (GitHub #28).

Architecture decisions in `00-architecture-decisions.md` sync to GitHub **#3**
but are excluded from the table below (decision log, not a queued implementation
task).

## Registry

| Draft file | GitHub Issue | Notes |
|------------|--------------|-------|
| `01-ao-task-declaration-impl.md` | [#4](https://github.com/chetwerikoff/orchestrator-pack/issues/4) | ao-task-declaration |
| `02-ao-scope-guard-runtime.md` | [#5](https://github.com/chetwerikoff/orchestrator-pack/issues/5) | Runtime scope guard |
| `03-scope-guard-ci.md` | [#6](https://github.com/chetwerikoff/orchestrator-pack/issues/6) | PR scope CI |
| `04-self-architect-lint.md` | [#7](https://github.com/chetwerikoff/orchestrator-pack/issues/7) | Self-architect lint |
| `05-token-chain-ledger.md` | [#8](https://github.com/chetwerikoff/orchestrator-pack/issues/8) | Token chain ledger |
| `06-codex-reviewer-scope-context.md` | [#9](https://github.com/chetwerikoff/orchestrator-pack/issues/9) | Codex reviewer scope |
| `07-target-repo-wiring-docs.md` | [#10](https://github.com/chetwerikoff/orchestrator-pack/issues/10) | Target-repo wiring docs |
| `08-test-harness.md` | [#11](https://github.com/chetwerikoff/orchestrator-pack/issues/11) | Plugin test harness |
| `09-auto-fix-loop-convergence.md` | [#19](https://github.com/chetwerikoff/orchestrator-pack/issues/19) | Auto-fix loop metrics (not draft prefix 09 = #9) |
| `10-patch-codex-review4-retirement.md` | [#20](https://github.com/chetwerikoff/orchestrator-pack/issues/20) | patch-codex-review4 retirement |
| `11-orchestrator-autonomous-review-loop.md` | [#28](https://github.com/chetwerikoff/orchestrator-pack/issues/28) | Autonomous review loop |
| `12-architect-role-tighten.md` | [#37](https://github.com/chetwerikoff/orchestrator-pack/issues/37) | Architect role + meta skills |
| `13-docs-review-discovery-clarity.md` | [#38](https://github.com/chetwerikoff/orchestrator-pack/issues/38) | Review discovery docs |
| `14-orchestrator-wake-mechanism.md` | [#39](https://github.com/chetwerikoff/orchestrator-pack/issues/39) | Wake listener (prefix 14 ≠ #14) |
| `15-orchestrator-recovery-runbook.md` | [#40](https://github.com/chetwerikoff/orchestrator-pack/issues/40) | Recovery runbook |
| `17-patch-review-loop-sentfindingcount.md` | [#45](https://github.com/chetwerikoff/orchestrator-pack/issues/45) | sentFindingCount contract |
| `18-investigate-root-cause-skill.md` | [#46](https://github.com/chetwerikoff/orchestrator-pack/issues/46) | Root-cause investigation procedure |
| `19-codex-review-finding-bar.md` | [#51](https://github.com/chetwerikoff/orchestrator-pack/issues/51) | Finding bar (draft 19 ≠ GitHub #19) |
| `22-issue-draft-github-numbering.md` | [#57](https://github.com/chetwerikoff/orchestrator-pack/issues/57) | This registry (open) |
| `24-ao-review-preflight-and-failed-run-discipline.md` | [#60](https://github.com/chetwerikoff/orchestrator-pack/issues/60) | Review preflight discipline |
| `25-worker-spawn-launch-safety.md` | [#63](https://github.com/chetwerikoff/orchestrator-pack/issues/63) | Worker spawn launch safety |
| `26-orchestrator-autoloop-go-live.md` | [#68](https://github.com/chetwerikoff/orchestrator-pack/issues/68) | Autoloop go-live checklist |
| `27-tracked-claude-review-and-strict-gate.md` | [#79](https://github.com/chetwerikoff/orchestrator-pack/issues/79) | Tracked Claude wrapper + strict review gate |
| `28-skill-eval-scorer-corpus.md` | [#80](https://github.com/chetwerikoff/orchestrator-pack/issues/80) | Contract-compliance scorer + eval corpus for codex review prompt |
| `29-skill-eval-bounded-edit-preflight.md` | [#81](https://github.com/chetwerikoff/orchestrator-pack/issues/81) | Offline bounded-edit preflight (hygiene only, after #80) |
| `30-skill-eval-live-behavior-gate.md` | none yet | Live prompt-behavior gate (after #80+#81; needs Codex auth) |
| `31-deterministic-reviewer-selection.md` | [#86](https://github.com/chetwerikoff/orchestrator-pack/issues/86) | Reviewer-agnostic entrypoint + explicit selector; deterministic reviewer choice, AO layer preserved (after #79) |
| `32-worker-acknowledge-pickup-contract.md` | [#88](https://github.com/chetwerikoff/orchestrator-pack/issues/88) | Mandatory `ao acknowledge` in worker agent rules (no_acknowledge / stuck prevention) |
| `33-orchestrator-session-launch-death-and-worktree-hygiene.md` | [#91](https://github.com/chetwerikoff/orchestrator-pack/issues/91) | Orchestrator launch death + orchestrator/* worktree preflight |
| `34-review-layer-resilience-after-worker-respawn.md` | [#98](https://github.com/chetwerikoff/orchestrator-pack/issues/98) | Idempotent review runs, orphan-run reap path, detached-HEAD-safe PR context, stale-workspace guard (after #60, #28, #91) |
| `35-operator-adoption-handoff-contract.md` | [#101](https://github.com/chetwerikoff/orchestrator-pack/issues/101) | Operator adoption handoff: architect specs, worker documents, operator executes; CI guard for .example ↔ migration_notes |
| `36-pack-reviewer-env-at-review-spawn.md` | [#106](https://github.com/chetwerikoff/orchestrator-pack/issues/106) | PACK_REVIEWER User/Machine env fallback when AO review spawn lacks process-scoped var (after #86) |
| `37-ci-failed-ping-before-report-stale-backstop.md` | [#109](https://github.com/chetwerikoff/orchestrator-pack/issues/109) | Turn-aware CI-failure worker gate + orchestrator ping; report-stale backstop only (op-6 class) |
| `38-review-dashboard-terminal-cleanup-on-start.md` | [#122](https://github.com/chetwerikoff/orchestrator-pack/issues/122) | Operator script (+ Gate 0 upstream API): archive `clean`/`failed` for terminal PRs; blocked until AO supports transition |
| `39-ubuntu-linux-only-port.md` | [#115](https://github.com/chetwerikoff/orchestrator-pack/issues/115) | Ubuntu/Linux-only port **epic tracker** (decision §P); children #117/#118/#119, deps A∥B→C |
| `40-ubuntu-config-readme-docs.md` | [#117](https://github.com/chetwerikoff/orchestrator-pack/issues/117) | Child A of #115: Linux-first `.example`, README de-Windowsization, Ubuntu setup runbook, WSL2/ext4 boundary, retired-helper doc cleanup |
| `41-ubuntu-scripts-portability.md` | [#118](https://github.com/chetwerikoff/orchestrator-pack/issues/118) | Child B of #115: `$HOME`/path portability, retire Windows-only scripts, fix `check-pack-reviewer-persistent-env.ps1`, enforce pwsh 7+ |
| `42-ubuntu-ci-runner.md` | [#119](https://github.com/chetwerikoff/orchestrator-pack/issues/119) | Child C of #115: migrate `scope-guard.yml` jobs `windows-latest`→`ubuntu-latest` (after #118) |
| `43-spec-only-scope-guard-docs-prs.md` | [#121](https://github.com/chetwerikoff/orchestrator-pack/issues/121) | Spec-only scope-guard mode: docs-only draft PRs pass via `Refs #N` + bounded docs allowlist, no declaration snapshot / close-reopen dance |
| `44-codex-review-jsonl-verdict-source.md` | [#127](https://github.com/chetwerikoff/orchestrator-pack/issues/127) | Codex reviewer event-first verdict: parse `codex exec review --json` review_output before last-message fallback |
| `45-codex-review-jsonl-explanation-findings-recovery.md` | [#135](https://github.com/chetwerikoff/orchestrator-pack/issues/135) | Split-channel recovery: pack JSON / NO_FINDINGS in `overall_explanation` or last message when JSONL `findings[]` is empty |
| `46-codex-review-native-output-format-alignment.md` | [#136](https://github.com/chetwerikoff/orchestrator-pack/issues/136) | Native review-mode prompt + hardened hydrated JSONL → pack mapper (#135 recovery unchanged) |
| `47-finding-routing-scorer-corpus.md` | [#139](https://github.com/chetwerikoff/orchestrator-pack/issues/139) | **active** — Routing gold corpus + offline scorer (recorded routes); build now (§Q) |
| `48-finding-routing-bounded-edit-preflight.md` | [#141](https://github.com/chetwerikoff/orchestrator-pack/issues/141) | **deferred** — Classifier edit hygiene (after #139); unfreeze when #140 upstream lands A+A′ |
| `49-finding-routing-live-behavior-gate.md` | [#142](https://github.com/chetwerikoff/orchestrator-pack/issues/142) | **deferred** — Live routing gate vs gold (after #139+#141); unfreeze when prod routing unblocked |
| `50-finding-routing-selective-send-enactment.md` | [#140](https://github.com/chetwerikoff/orchestrator-pack/issues/140) | **active-blocked-upstream** — two-track: pipeline #1631/#1346 preferred, legacy #2088 fallback; delivery #1943/#614 |
| `52-coworker-cli-delegation-policy.md` | [#148](https://github.com/chetwerikoff/orchestrator-pack/issues/148) | Coworker CLI delegation (`--profile code`/`write`, 600/3/200 triggers) in agent rules; **reviewer carve-out** (review path never routed through coworker) + provider-input exfil fence |
| `53-delegation-policy-global-fanout.md` | [#149](https://github.com/chetwerikoff/orchestrator-pack/issues/149) | Global fan-out: single-source delegation policy (#148) + thin pointers from `AGENTS.md` (Codex), `.cursor/rules` (standalone Cursor), `CLAUDE.md` (architect); arch decision §S |
| `51-coworker-rtk-worker-adaptation.md` | [#145](https://github.com/chetwerikoff/orchestrator-pack/issues/145) | Coworker RTK for AO Cursor workers: additive passthrough (`git diff`/`log`, `gh pr checks`, `ao`/`ao-declare`), tracked helper + static CI, operator runbook (hook smoke, 7-day qualitative observation, `rtk disable` rollback); arch §R |
| `54-ci-path-filter-markdown-only.md` | [#155](https://github.com/chetwerikoff/orchestrator-pack/issues/155) | Markdown-only PRs (`.md`/`.mdc` under docs/skills/rules) skip heavy advisory CI (tests, self-architect lint); required `verify-pack` + scope guard stay; conservative (any non-md path → full suite) |
| `55-skills-single-source-mirror.md` | [#156](https://github.com/chetwerikoff/orchestrator-pack/issues/156) | Single canonical skill source (`.claude/skills/**`); all `.cursor/skills/**` become generated pointers; list-driven generator + drift check wired into required `verify-pack`; kills 4-skill .claude/.cursor drift |
| `56-spec-only-allowlist-skills.md` | [#159](https://github.com/chetwerikoff/orchestrator-pack/issues/159) | Widen spec-only scope-guard allowlist (#121) to skill instruction markdown under `.claude/skills/**` + generated `.cursor/skills/**` pointers; markdown-only boundary, conjunctive allowlist, drift check (#156) stays required; skill edits land via `Refs #N` without declaration snapshot |
| `57-skill-only-pr-no-ceremony.md` | [#161](https://github.com/chetwerikoff/orchestrator-pack/issues/161) | Completes #159: a PR touching only skill markdown (`.claude/skills/**/*.md` + `.cursor/skills/**/*.md`) passes scope guard with no snapshot, no `Refs #N`, no spec-only signal; content-based + conjunctive; drift check stays required; skill edits land with zero issue/queue ceremony |
| `58-safe-review-trigger-reconciliation.md` | [#163](https://github.com/chetwerikoff/orchestrator-pack/issues/163) | Re-spec §H Decision 1 (rolled back in #99 after PR #97): state-derived review trigger from open-PR head SHA vs `ao review list` coverage; converges without worker report or live LLM-orchestrator; **review-run only, zero worker-lifecycle** (no spawn/`--claim-pr`/kill/ping) so split-brain can't recur; reuses #98 idempotency; low-frequency |
| `59-spec-docs-only-pr-no-ceremony.md` | [#165](https://github.com/chetwerikoff/orchestrator-pack/issues/165) | Extend #161 no-ceremony shape to spec-docs markdown: a PR whose every path is markdown in the union of skill-markdown + spec-docs (`docs/issues_drafts/**`, index, architecture, 00-decisions) passes scope guard with no snapshot/`Refs`/signal; content-based + conjunctive; supersedes #161's skill+draft-mix clause; drift check stays required |
| `60-orchestrator-wake-supervisor.md` | [#168](https://github.com/chetwerikoff/orchestrator-pack/issues/168) | One supervised entry point that starts + auto-restarts the wake listener and heartbeat as two independent processes (no merge / no shared fate); supervisor-owned session-id resolution (override or `ao status`, never hardcoded), waits on no-session with bounded timeout, relaunches both children on id change, stops both when session disappears; band-aid for wake reliability, not a substitute for #163 |
| `61-review-finding-delivery-confirmation.md` | [#171](https://github.com/chetwerikoff/orchestrator-pack/issues/171) | Sender-side confirmation that a review finding actually reached the worker: `sent_to_agent` ≠ receipt (opk-8/PR#166 incident). Run-level (no per-finding dep on 0.9.2) via `ao review list <project> --json`; confirmation = `addressing_reviews` after send tied to the run; bounded best-effort re-deliver to the **live, head-owning** linked session (no spawn/`--claim-pr`/kill — split-brain invariant); **escalation is the guarantee**, not re-delivery; ambiguous overlapping runs stay unconfirmed. Distinct from #163 (trigger), #168 (wake liveness), #88 (pickup ack), #98 (orphan reap) |
| `62-terminal-flood-resilience.md` | [#173](https://github.com/chetwerikoff/orchestrator-pack/issues/173) | **active-blocked-upstream** ([ComposioHQ/agent-orchestrator#2094](https://github.com/ComposioHQ/agent-orchestrator/issues/2094)) — dashboard worker terminal floods with Device-Attributes reports (`ESC[>84;0;0c`) under mux WebSocket reconnect loop; core/dashboard fix is upstream. Pack delivers observable detection signature (mux-flap rate in `ao events`, no pane scraping) + operator recovery runbook. Incident family opk-8/#166, opk-10/#169 |
| `63-review-ready-worker-stuck-guard.md` | [#174](https://github.com/chetwerikoff/orchestrator-pack/issues/174) | Don't respawn/kill/claim a worker that is **alive + last reported `ready_for_review` + has a review run (incl. `waiting_update`) for the head** on a false `stuck`/`probe_failure` (flood-induced). Durable home: canonical `orchestratorRules` in `agent-orchestrator.yaml.example` (+ `agent_rules.md`); genuine-dead unchanged (#98). Companion to #173/#2094 (flood) and #171 (delivery) |
| `64-pr-created-not-terminal-worker-handoff.md` | [#186](https://github.com/chetwerikoff/orchestrator-pack/issues/186) | Worker must drive `pr_created` to hand-off (`ready_for_review` or escalation); opening a PR is not terminal (complements #174, #109) |
| `65-orchestrator-no-rereview-covered-head.md` | [#189](https://github.com/chetwerikoff/orchestrator-pack/issues/189) | LLM-orchestrator review loop must not re-issue `ao review run` for a head SHA already covered by a covered-terminal run (`clean`/`needs_triage`/`waiting_update`) or in-flight — widens #98 idempotency (in-flight-only) to the #163 reconciler coverage **predicate** (same PR linkage + exact head SHA + status); `failed`/`cancelled` keep terminationReason/retry-once; pre-run re-check bounds dual-path TOCTOU (residual); closes #54 gap for `prNumber`-less merged runs (resolve via linked session, fail-closed to inaction). Incident opk-rev-67→68→69. Durable home: canonical `orchestratorRules` + `agent_rules.md` |
| `66-orchestrator-ci-green-wake-worker.md` | [#191](https://github.com/chetwerikoff/orchestrator-pack/issues/191) | Orchestrator wakes the live, head-owning worker when required CI turns green after `fixing_ci` — CI-success mirror of the CI-failure ping (#109), closing the gap before `report-stale` (~30 min); level/state-derived (survives sender restart/adoption, like #163), single-snapshot pre-send liveness/ownership recheck (fail-closed, dedupe only after successful send), idempotent across same-head reruns/flaps + concurrent observers. Complements worker self-drive #186; does not replace death-respawn #98 (reduces its frequency). Durable home: canonical `reactions`/`orchestratorRules` + `agent_rules.md`. Incident opk-6/#189/PR#190. |
| `67-orchestrator-review-gate-on-handoff.md` | [#195](https://github.com/chetwerikoff/orchestrator-pack/issues/195) | Review trigger gate: start next review round only after worker hands off current head (`ready_for_review` for exact SHA + CI contract); stops premature runs on intermediate commits; additive to #189 covered-head idempotency; consumes #186 hand-off semantics |
| `68-rtk-net-savings-source-segmented.md` | [#199](https://github.com/chetwerikoff/orchestrator-pack/issues/199) | RTK net-savings follow-up to #145/§R: measured, source-aware, low-risk-first; sensitivity/exactness no-compact override; kill-gate; pinned field-preservation gate + tracked-manifest durable narrowing before any `ao ` passthrough change |
| `69-orchestrator-review-send-reconcile.md` | [#202](https://github.com/chetwerikoff/orchestrator-pack/issues/202) | State-derived first `ao review send` for `needs_triage` runs (sentFindingCount:0) to the live head-owning worker, outside the LLM-orchestrator turn — closes first-delivery latency that today depends on the 15-min heartbeat (AO 0.9.x emits no wake on `review.needs_triage`). Split-brain envelope of #163/#171/#191 (no spawn/--claim-pr/kill/ping); authoritative cross-path dedupe via run leaving `needs_triage`; required supervised liveness (generalize #168). Fork recorded: reconciler vs upstream `review.needs_triage` notification. |
| _(revert; no draft file)_ | [#99](https://github.com/chetwerikoff/orchestrator-pack/issues/99) | Revert #58 state-derived reconciliation (PR #97 split-brain); closed when revert PR merges |
