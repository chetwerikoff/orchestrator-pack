# Ubuntu / Linux-only port (epic tracker)

GitHub Issue: #115

## Prerequisite

- `docs/issues_drafts/00-architecture-decisions.md` §P (GitHub #3) — Ubuntu /
  Linux-only port target. This epic exists to track that decision to done.
- `docs/issues_drafts/10-patch-codex-review4-retirement.md` (GitHub #20) —
  `patch-codex-review4.ps1` retirement; **not** part of this port.

## Goal

Make `orchestrator-pack` run natively on Ubuntu (and WSL2 Ubuntu, the only
supported Windows path), with native Windows removed as a runtime target
(decision §P). A clean Ubuntu checkout must install dependencies, run pack
scripts via `pwsh` 7+, boot the AO dashboard, and pass the test suite — with no
*active* native-Windows runtime path and no Windows-first default in the docs.

**This issue is a tracker, not a single worker task.** It is not directly
`ao spawn`'d for code. Implementation is split across focused child issues so
each has an independent failure surface, its own declaration snapshot, and its
own review loop (one worker = one PR per child, matching the AO execution
model). This issue closes when all children are merged and the end-to-end
validation below passes on a real Ubuntu host.

## Children

| Child | Scope | Depends on |
|-------|-------|------------|
| **A — Config + README + docs** (`docs/issues_drafts/40-ubuntu-config-readme-docs.md`, GitHub #117) | Linux-first `agent-orchestrator.yaml.example`; de-Windowsize `README.md`; Ubuntu setup runbook; WSL2/ext4 boundary doc; remove doc refs to retired helpers; operator adoption | — |
| **B — Scripts portability + retirement** (`docs/issues_drafts/41-ubuntu-scripts-portability.md`, GitHub #118) | `$HOME`/path-separator portability; retire Windows-only scripts; fix `check-pack-reviewer-persistent-env.ps1` on Linux; enforce pwsh 7+ in `verify` | — |
| **C — CI to Ubuntu** (`docs/issues_drafts/42-ubuntu-ci-runner.md`, GitHub #119) | move the `scope-guard.yml` jobs from `windows-latest` to `ubuntu-latest` via `pwsh`; Linux regression gate | B (#118) |

Ordering: **A ∥ B → C** (a green Ubuntu CI run depends on portable scripts).

## End-to-end validation (tracker acceptance)

The port is done when, on a clean WSL2 Ubuntu 26.04 host with target repo + AO
state on ext4 (never `/mnt/c`):

1. All three child issues (A, B, C) are merged to `main`.
2. `pwsh ./scripts/verify.ps1` and `pwsh ./scripts/test-all.ps1` pass.
3. `ao doctor` reports healthy; `ao start --no-orchestrator` boots the dashboard
   on the tmux runtime; `ao stop` tears down cleanly with no orphans.
4. A repo-wide search finds no *active* native-Windows runtime path and no
   Windows-first default in setup docs (per child A and B acceptance criteria);
   any remaining Windows mention is explicitly legacy/retirement-only.
5. The CI gate (child C) runs on Ubuntu and a deliberately Linux-breaking change
   makes it red.

These are observable at the epic level; each child owns the file-level criteria.

## Files in scope

None directly. This tracker is authored and maintained as a docs artifact
alongside its children:

- `docs/issues_drafts/39-ubuntu-linux-only-port.md` — this tracker.
- `docs/issue_queue_index.md` — child registry rows.
- `docs/issues_drafts/00-architecture-decisions.md` — §P.

Implementation files belong to the child issues, not here.

## Files out of scope

- All implementation files (owned by children A/B/C).
- `vendor/**`, `packages/core/**`, AO upstream.
- Live `agent-orchestrator.yaml` (gitignored; operator-owned).

## Denylist

```denylist
packages/core/**
vendor/**
.ao/**
agent-orchestrator.yaml
```

## Acceptance criteria

1. This tracker enumerates child issues A, B, C with their scopes and the
   `A ∥ B → C` dependency, each cross-linked by draft path and GitHub number.
2. The end-to-end validation list above is recorded and unambiguous.
3. Decision `§P` in `docs/issues_drafts/00-architecture-decisions.md` references
   this tracker; the registry maps draft 39 → #115 and drafts 40/41/42 → their
   issues.
4. No implementation is performed under this issue number.

## Upgrade-safety check

- Docs-only tracker; no AO core or `vendor/**` edits, no secrets.
- Implementation scope, denylists, and operator-adoption obligations live in the
  child drafts, preserving planner freedom there.

## Verification

```powershell
# Tracker is consistent with its children and the decision log:
Select-String -Pattern '40-ubuntu-config-readme-docs|41-ubuntu-scripts-portability|42-ubuntu-ci-runner' docs/issues_drafts/39-ubuntu-linux-only-port.md
Select-String -Pattern 'P\. Ubuntu / Linux-only port target' docs/issues_drafts/00-architecture-decisions.md
```

- Child rows present in `docs/issue_queue_index.md`.
- End-to-end validation re-run on the Ubuntu polygon once A, B, C merge
  (operator-executed; see §P.5).
