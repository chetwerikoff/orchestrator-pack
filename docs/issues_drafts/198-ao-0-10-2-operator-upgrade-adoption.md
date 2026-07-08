# Prepare current AO 0.10.x operator upgrade after pack spawn-name prerequisite

GitHub Issue: #590

## Prerequisite

- `docs/issues_drafts/197-ao-0-10-spawn-name-prerequisite.md` (GitHub #589) - must land first so pack-owned spawn instructions are compatible with AO 0.10.x's required `--name` flag.

Builds on / references (already shipped - reused, not rebuilt):

- `docs/issues_drafts/27-tracked-claude-review-and-strict-gate.md` (GitHub #79), `docs/issues_drafts/31-deterministic-reviewer-selection.md` (GitHub #86), and `docs/issues_drafts/36-pack-reviewer-env-at-review-spawn.md` (GitHub #106) - keep pack review selection on `PACK_REVIEWER` / `REVIEW_COMMAND`.
- `docs/issues_drafts/143-orchestrator-spawn-policy-toggles.md` (GitHub #458) and the spawn-grant draft family - preserve autonomous spawn controls during and after upgrade.

Prior-art verdict: no open issue currently owns the AO 0.10.2 operator upgrade. Existing work covers adjacent review/spawn safety, not the version bump.

## Goal

The worker prepares a repo-side operator upgrade runbook/checklist for moving the live AO installation from 0.9.5 to the current stable GitHub release available at implementation time (v0.10.2 as verified on 2026-07-04, or newer if upstream has shipped a later stable release). The repo change records release/install facts, output-shape drift gates, rollback steps, and the exact operator post-merge verification checklist; the live install itself remains an operator action outside CI and outside autonomous worker execution.

```behavior-kind
action-producing
```

## Binding surface

- Treat GitHub releases, not npm `latest`, as the source for 0.10.1+ adoption while npm lacks `@aoagents/ao@0.10.2` and `@aoagents/ao-linux-x64@0.10.2`.
- The worker produces or updates repo-owned documentation/check material only: selected-release facts, installability decision, asset provenance/integrity notes, output-shape compatibility gates, rollback/abort steps, and the operator post-merge checklist.
- Before documenting the selected live upgrade path, re-check the current stable upstream release and installability: GitHub releases from the current upstream repository `AgentWrapper/agent-orchestrator`, npm `@aoagents/ao versions`, and platform package availability.
- GitHub reads in this repository use the pack `scripts/gh` wrapper on PATH; verification commands may look like `gh api ...`, but the worker must confirm `which gh` resolves to `scripts/gh` before relying on them.
- If npm still exposes only 0.10.0 while GitHub has a newer stable release, document an operator-owned GitHub release asset path (`.deb`, rpm, AppImage, or equivalent) rather than `npm install -g @aoagents/ao@0.10.2`; record the exact asset URL/name, platform/architecture match, and checksum/signature availability before install. If upstream publishes no checksum/signature for that asset, record that absence explicitly and require operator acknowledgement before proceeding.
- Add an explicit output-shape drift gate before live upgrade: rerun or refresh the pack's external-output field-shape/golden-sample guards from `docs/issues_drafts/76-golden-sample-fixtures-field-shape-guard.md` / GitHub #223 against the target AO version, covering at minimum `ao review list --json`, `ao status`, and any review/reconcile-path captures that pack scripts parse.
- Operator adoption: the operator performs the live install/restart steps from an operator terminal after the repo-side prerequisite material lands; live `agent-orchestrator.yaml` remains gitignored and operator-owned.

## Files in scope

- `docs/**`
- `README.md`
- `agent-orchestrator.yaml.example`
- `scripts/**`
- `.github/workflows/**` only if a repository check is needed to preserve upgrade verification

## Files out of scope

- `vendor/agent-orchestrator/**`
- AO core packages or vendored upstream modifications.
- Live runtime state under `.ao/**` or `~/.agent-orchestrator/**`.
- Changing pack reviewer selection to AO typed `reviewers` config.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
```

```allowed-roots
docs/**
README.md
agent-orchestrator.yaml.example
scripts/**
.github/workflows/**
```

## Contract evidence

```contract-evidence
none
```

This issue schedules an operator-side external upgrade and requires fresh implementation-time capture of upstream release/install/version facts. It does not add a new repo-owned external producer binding; any durable checks added by the worker should carry their own evidence if they bind to captured external output.

## Acceptance criteria

1. The repo-side material re-checks the latest stable upstream release at implementation time and records the exact release/tag/date selected. If a newer stable release than v0.10.2 exists, the issue targets that newer release unless the operator explicitly holds at v0.10.2.
2. The repo-side material records whether npm can install the target version. If npm still cannot install the target, the operator-facing steps use GitHub release assets and say why npm is not the path.
3. The repo-side material records the exact GitHub release asset URL/name, platform/architecture match, and checksum/signature availability for any asset install path; absent upstream checksum/signature is explicitly called out before operator acknowledgement.
4. The repo-side material defines hard pre-upgrade gates: prerequisite #197 has landed/adopted, `ao spawn --help` for the target confirms the `--name` contract, pack review driving still resolves through `PACK_REVIEWER` / `REVIEW_COMMAND`, and no path depends on AO typed `reviewers` config or top-level YAML `reviewer:`.
5. The repo-side material includes an output-shape compatibility sweep for the target AO version. It reruns or refreshes the pack's field-shape/golden-sample guards from `docs/issues_drafts/76-golden-sample-fixtures-field-shape-guard.md` / GitHub #223 and covers parsed outputs such as `ao review list --json`, `ao status`, and review/reconcile-path captures; any drift is either adopted in fixtures/checks or blocks the live upgrade with a follow-up issue.
6. The repo-side material includes a rollback/abort path: capture current 0.9.5 command path/version/install method before changing anything, keep or document a known-good 0.9.5 reinstall path, abort on failed asset integrity/shape/review/spawn gates, and restore/restart AO plus rerun pack checks if post-upgrade verification fails.
7. The operator post-merge checklist exists and is clearly marked as live operator work, not CI acceptance: install/restart AO from an operator terminal, verify `ao --version` through the pack-resolved command path, confirm `ao spawn --help`, run the output-shape sweep, and perform a bounded stale-session smoke for the PR #2320/#2350 class where this can be done without disrupting real work.
8. `pwsh -NoProfile -File scripts/verify.ps1` and `pwsh -NoProfile -File scripts/check-reusable.ps1` pass after any repository-side documentation/check changes.

```positive-outcome
asserts: the repository contains an operator upgrade runbook/checklist that records the selected AO 0.10.x target, install path, output-shape gates, rollback path, and live post-merge verification steps, and repository verification commands pass
input: realistic
provenance: capture-backed
```

## Upgrade-safety check

- Do not patch AO core or vendor upstream code.
- Do not treat live-upgrade results as worker/CI acceptance; they belong to the operator post-merge checklist.
- Do not run the live upgrade from an autonomous worker session.
- Do not commit live local state or secrets.
- Do not introduce unsupported YAML keys.
- Preserve pack spawn safety and review selector contracts.

## Verification

1. `which gh` resolves to the pack `scripts/gh` wrapper, then `gh api repos/AgentWrapper/agent-orchestrator/releases --paginate --jq '.[].tag_name'` records the selected stable target.
2. `npm view @aoagents/ao versions --json` and the relevant `@aoagents/ao-<platform>` package query record whether npm install is viable.
3. For a GitHub asset path, record the asset URL/name, platform/architecture match, and checksum/signature availability before install.
4. Verify the documented runbook/checklist contains the output-shape sweep for #223 / field-shape guards, rollback/abort path, and live operator checklist.
5. `pwsh -NoProfile -File scripts/verify.ps1`.
6. `pwsh -NoProfile -File scripts/check-reusable.ps1`.

## Decisions

**This is an operator runbook / thin repo PR, not a live-upgrade worker.** CI and a merged PR cannot prove the operator's live AO binary was upgraded. This issue therefore accepts repo-side artifacts: release facts, install path, output-shape gates, rollback steps, and the live operator checklist. The actual install, restart, and `ao --version` proof happen after merge from an operator terminal.

**Target source.** Verification on 2026-07-04 found GitHub stable releases through `v0.10.2` under the current upstream `AgentWrapper/agent-orchestrator` with Linux assets, while npm `@aoagents/ao` and `@aoagents/ao-linux-x64` exposed stable `0.10.0` only. The old `ComposioHQ/agent-orchestrator` name is historical in this pack and should be checked only once for redirect/divergence if an implementer needs to document that naming transition. Therefore the draft requires a fresh implementation-time check and permits a GitHub release asset install when npm still lags.

**Output-shape drift is a release gate.** The pack parses AO command output in several places, and a two-minor-version jump can break wrappers even when `ao --version` and `ao spawn --help` look healthy. The upgrade runbook must include the #223 / draft 76 field-shape guard sweep before live adoption.

**Reviewer reconciliation is not a prerequisite.** Upstream's reviewer changes are real AO PR-review subsystem changes, but they are typed project config (`reviewers`) and reviewer harness adapters. They do not make the old top-level `reviewer:` YAML claim actionable for this pack and do not override the pack's `PACK_REVIEWER` / `REVIEW_COMMAND` flow.

**Stale session fixes are adoption smoke, not a separate pack draft.** Upstream PR #2320 deletes one-shot restore markers on kill/restore; PR #2350 proves restart/upgrade adoption for alive sessions and non-resurrection for truly dead sessions. That is relevant enough to smoke-test during upgrade, but it does not require a pack-side implementation draft unless smoke evidence shows a remaining local failure.
