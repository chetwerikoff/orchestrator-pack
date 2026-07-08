# AO 0.10 spawn display-name prerequisite for tracked spawn instructions

GitHub Issue: #589

## Prerequisite

Builds on / references (already shipped - reused, not rebuilt):

- `docs/issues_drafts/27-tracked-claude-review-and-strict-gate.md` (GitHub #79) - ships the pack review command gate that must remain driven by `PACK_REVIEWER` / `REVIEW_COMMAND`, not AO core defaults.
- `docs/issues_drafts/31-deterministic-reviewer-selection.md` (GitHub #86) - settles the single `PACK_REVIEWER` selector pattern.
- `docs/issues_drafts/36-pack-reviewer-env-at-review-spawn.md` (GitHub #106) - makes the selector durable across review process boundaries.
- `docs/issues_drafts/143-orchestrator-spawn-policy-toggles.md` (GitHub #458) - makes autonomous `ao spawn` / `ao spawn --claim-pr` policy-controlled; this issue only updates the accepted command shape.
- `docs/issues_drafts/148-autonomous-spawn-worktree-git-provenance.md` (GitHub #470) and follow-on spawn-grant drafts - preserve spawn/worktree provenance; this issue must not weaken those guards.

Prior-art verdict: no open issue currently owns AO 0.10 `--name` adoption. Existing work is adjacent infrastructure and must be reused.

## Goal

Every tracked, operator-facing instruction or guard in this pack that tells an agent or operator to invoke `ao spawn` is compatible with AO 0.10.x, where CLI `ao spawn` requires `--project` and a non-empty `--name` display label. After this lands, upgrading AO must not leave pack prompts, runbooks, config examples, or spawn-gate fixtures teaching a command shape that the new CLI rejects before it reaches the daemon.

```behavior-kind
action-producing
```

## Binding surface

- Update tracked operator/agent-facing spawn instructions so executable `ao spawn` examples include explicit `--project` and `--name` values whenever they are meant to be run against AO 0.10.x. Upstream v0.10.2 source rejects missing `--project` in the CLI path before project/session context inference can help, and the upstream orchestrator prompt also teaches the explicit `--project ... --name ...` shape.
- Keep historical incident prose, denylist phrases, and "never `ao spawn`" safety text semantically intact; do not rewrite history just to satisfy a grep.
- Add or update a mechanical check that distinguishes runnable spawn examples from forbidden/historical mentions and fails on a runnable `ao spawn` command missing `--project` or `--name`.
- Preserve existing spawn policy, worktree grant, split-brain, and `PACK_REVIEWER` contracts. This issue does not introduce AO's typed `reviewers` project config and does not replace `REVIEW_COMMAND`.
- Operator adoption: after merge, the operator copies changed `orchestratorRules` / runbook text from `agent-orchestrator.yaml.example` and docs into the live gitignored `agent-orchestrator.yaml` before upgrading AO.

## Files in scope

- `agent-orchestrator.yaml.example`
- `prompts/**`
- `docs/**`
- `scripts/**`
- `tests/external-output-references/**` only if a captured external-output fixture is needed.

## Files out of scope

- Installing or upgrading the live AO binary.
- AO core or vendored upstream source.
- Changing the pack reviewer selector model (`PACK_REVIEWER`, `REVIEW_COMMAND`, `scripts/invoke-pack-review.ps1`).
- Introducing or documenting a top-level `reviewer:` YAML block.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
```

```allowed-roots
agent-orchestrator.yaml.example
prompts/**
docs/**
scripts/**
tests/external-output-references/**
```

## Contract evidence

```contract-evidence
none
```

This draft is grounded by the authoring verification report against upstream v0.10.2 source and release artifacts. The implementation does not bind to a new repo-owned producer datum; it adds pack-side text/checks that must continue to pass against the current AO CLI contract verified at implementation time.

## Acceptance criteria

1. Every runnable `ao spawn` command example in current tracked operator/agent-facing surfaces includes explicit `--project <project>` and `--name <label>` flags, including the `--claim-pr` respawn path.
2. Contextual safety text such as "never `ao spawn`" and historical incident references remain allowed and are not rewritten into false runnable examples.
3. A mechanical check fails on a fixture or edited tracked text containing a runnable `ao spawn` command without `--project` or without `--name`, and passes for `ao spawn --project <project> --name <label> ...` and `ao spawn --project <project> --name <label> --claim-pr <PR>`.
4. The check accounts for AO 0.10.x's display-label constraint: non-empty name and the upstream-verified display-name limit where the pack prescribes a concrete label. If the worker encodes a numeric limit, it is centralized in one obvious check fixture/constant and tied to the validated AO source or `ao spawn --help`, not scattered as an unsourced magic number.
5. Existing spawn policy / worktree-grant tests still pass or are updated only to the extent needed to include the required `--name` argument.
6. No tracked docs suggest adding a top-level `reviewer:` YAML key as part of this prerequisite.
7. The mechanical check proves zero false positives on the current safety-prose corpus: existing denylist/historical text such as "never `ao spawn`" and other non-runnable mentions in `agent-orchestrator.yaml.example` and `docs/orchestrator-recovery-runbook.md` remain accepted by name in a fixture or baseline, so the check does not create churn by treating safety prose as runnable commands.

```positive-outcome
asserts: a runnable tracked respawn instruction for claiming a PR is rewritten to include --project and --name, and the new/updated check passes on that instruction while failing on the same command with either required flag removed
input: realistic
```

## Upgrade-safety check

- No AO core, vendored upstream, or live `agent-orchestrator.yaml` edits.
- No weakening of autonomous spawn deny/allow policy or worktree provenance.
- No new secrets.
- No replacement of `PACK_REVIEWER` / `REVIEW_COMMAND` review driving.

## Verification

1. Run the new or updated spawn-shape check; it must pass on the repository and fail on temporary mutations that remove `--project` or `--name` from a runnable `ao spawn --claim-pr` example.
2. Run `pwsh -NoProfile -File scripts/verify.ps1`.
3. Run `pwsh -NoProfile -File scripts/check-reusable.ps1`.
4. If any touched plugin/test directory documents a narrower command, run it too.

## Decisions

**Reviewer config is not in scope.** Upstream v0.10.2 has a typed `ProjectConfig.Reviewers []ReviewerConfig` and a fallback reviewer harness of `claude-code`; reviewer adapters include `claude-code`, `codex`, and `opencode`. The old legacy YAML importer does not read a top-level `reviewer:` field, and the pack review path continues to resolve `PACK_REVIEWER` into `REVIEW_COMMAND`. Therefore this prerequisite does not add a reviewer-reconciliation work item.

**Explicit `--project` is required even from orchestrator-authored instructions.** Upstream v0.10.2 `backend/internal/cli/spawn.go` checks `opts.project == ""` and returns `--project is required`; the same release's orchestrator prompt in `backend/internal/session_manager/manager.go` teaches `ao spawn --project %s --name "<label, max 20 chars>" ...` and states that both flags are required. Therefore runnable pack examples keep an explicit project argument instead of assuming live orchestrator context can infer it.

**Name convention stays planner-owned.** The draft requires the existence and validation of a display name, not a universal naming scheme. The worker may choose concise labels appropriate to each command path, provided they satisfy AO's non-empty / max-20 constraint.
