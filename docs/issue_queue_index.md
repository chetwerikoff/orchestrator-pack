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
| _(revert; no draft file)_ | [#99](https://github.com/chetwerikoff/orchestrator-pack/issues/99) | Revert #58 state-derived reconciliation (PR #97 split-brain); closed when revert PR merges |
