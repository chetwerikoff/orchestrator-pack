# Worker spawn launch-safety on Windows (generalize Issue #55 beyond orchestratorRules)

GitHub Issue: #63

## Prerequisite

- GitHub Issue #55 is **closed** (PR #56 on `main`): launch-safe `orchestratorRules`
  (no embedded ASCII double-quote / inline `--command` lines) plus the guard
  `scripts/check-orchestrator-rules-quotes.ps1`. That guard inspects **only** the
  `orchestratorRules:` literal in `agent-orchestrator.yaml.example`; it does not
  cover the worker-spawn prompt path. See `docs/migration_notes.md` section
  **Windows `orchestratorRules` quote safety (Issue #55)**.
- AO local review preflight + failed-run discipline (file
  `docs/issues_drafts/24-ao-review-preflight-and-failed-run-discipline.md`,
  GitHub Issue #60) is the issue whose body triggered the observed failure. Its
  binding-surface item 4c already *reminds* authors that issue bodies copied into
  worker spawn prompts must stay launch-safe (no double-quote / `--command "…"`
  literals) per Issue #55. This issue **aligns with and strengthens** that
  reminder — it turns it into an enforced, fail-loud detection plus operator
  documentation. It does **not** contradict, weaken, or re-scope any #60 clause,
  and requires no edit to draft 24 or the #60 body.
- Issue #11 autonomous review-loop contract (file
  `docs/issues_drafts/11-orchestrator-autonomous-review-loop.md`) defines
  orchestrator/worker roles; this issue only adds a safe-spawn clause and a
  detection/documentation surface — it does not change review statuses.

## Goal

A launch-unsafe worker spawn on Windows must fail **loud and immediately** with
actionable guidance — it must never present as a healthy spawn that silently
produces a dead worker discovered minutes later. The pack enforces that
spawn-bound text (the issue body / worker prompt) is launch-safe before the
worker is launched, documents the constraint and how to author content safely,
and escalates the underlying mis-escaping defect to AO upstream. Making the AO
spawn path tolerate arbitrary body content is an AO-core change and is **out of
scope** (see **Files out of scope**); this issue's pack-side fix is enforcement,
legibility, and documentation, generalizing Issue #55 from `orchestratorRules` to
the worker-spawn prompt path.

Observed failure (session `op-25`, GitHub Issue #60, 2026-05-28): AO recorded
`session.spawned` and `spawning → working`, then the Cursor worker process
(`pid 2592`) exited at startup. AO's runtime kept the handle "alive" and only
caught the death via probe after ~5 minutes (`signal_disagreement runtime=alive
process=dead … activity=exited`), ending in `stuck` / `probe_failure` with zero
work, no PR, and no Cursor chat store ever created for the worker. The issue #60
body is dense with ASCII double-quotes (JSON snippets, `--command "…"` literals) —
the same mechanism Issue #55 fixed for `orchestratorRules`, but the worker-spawn
path was never covered, and the existing #60 item-4c reminder is unenforced prose.
(A secondary contributor — a stale `feat/issue-60` branch and a leftover worktree
causing `workspace.branch_collision` and a failed first spawn — is **out of scope
here** and belongs to a separate workspace-hygiene issue.)

## Binding surface

This issue commits the repository to:

1. **Spawn-prompt launch-safety detection.** A pack-owned check (new script or an
   extension of an existing verify step — planner's choice of name and placement)
   that, given text destined to become a worker spawn prompt on Windows, detects
   the launch-unsafe condition (at minimum: ASCII double-quote characters that
   would leak into / break the PowerShell launch argv). The check MUST emit an
   **actionable** message naming the safe-spawn path, not a bare error or a silent
   pass. It MUST be runnable offline against a fixture (no live `ao spawn`, no
   network).
2. **Orchestrator runs the preflight before spawn (orchestratorRules).** The
   `orchestratorRules:` block in `agent-orchestrator.yaml.example` instructs the
   orchestrator to run the launch-safety check on spawn-bound text **before**
   `ao spawn`, and to NOT proceed with a launch-unsafe body silently — instead
   halt and surface the actionable failure. The literal MUST stay launch-safe per
   Issue #55 (no ASCII double-quote in the `orchestratorRules` text; the existing
   guard still passes).
3. **Authoring discipline (documented, aligned with #60).** Until AO fixes the
   spawn-prompt escaping upstream, spawn-bound issue bodies MUST be launch-safe on
   Windows. The pack documents this rule and how to represent quote-bearing
   content safely so a spec is not blocked. This strengthens — does not weaken —
   #60 item 4c; no #60 clause is edited.
4. **Operator/author documentation.** `docs/migration_notes.md` gains a subsection
   covering: the worker-spawn launch-safety risk on Windows; the failure signature
   (worker dies at launch → `runtime exited` / `process_missing` → `stuck` /
   `probe_failure` within minutes, no work and no Cursor chat created); and the
   safe-spawn adoption steps.
5. **Decision log.** `docs/issues_drafts/00-architecture-decisions.md` gains a new
   subsection (next available letter after #60's) recording the decision that
   Windows launch-safety generalizes beyond `orchestratorRules` to the
   worker-spawn prompt path, enforced via detection + documentation + upstream
   escalation. The corresponding Issue #3 body is re-synced in the same PR.
6. **AO-core escalation note.** Because AO owns the spawn-prompt interpolation and
   the PowerShell launch template (out of pack scope, see **Files out of scope**),
   the migration note records that the complete escaping fix is an upstream AO
   concern and links where to escalate; the pack-side surface is detection,
   safe-spawn guidance, and documentation.

## Files in scope

- `scripts/` — the launch-safety check (new script or extension of an existing
  verify step; planner's choice of name and placement), wired into
  `scripts/verify.ps1`.
- `agent-orchestrator.yaml.example` — safe worker-spawn clause in
  `orchestratorRules` (preserve the Issue #55 launch-safe form).
- `docs/migration_notes.md` — new subsection (binding-surface items 4 and 6).
- `docs/issues_drafts/00-architecture-decisions.md` — new subsection + Issue #3
  re-sync (binding-surface item 5).
- `docs/issues_drafts/25-worker-spawn-launch-safety.md` — this spec.

## Files out of scope

- AO core spawn logic, the PowerShell launch template, and the spawn-prompt
  interpolation (AO-owned; `vendor/**` and the AO package). The pack cannot patch
  how AO escapes the launch command; that is the upstream escalation in item 6.
  Consequently this issue does **not** commit to making quote-bearing bodies
  launchable — only to detecting and surfacing the unsafe condition.
- AO's worktree checkout / branch-collision behaviour and the stale-branch /
  leftover-worktree hygiene problem — a separate workspace-hygiene issue.
- Spawn-side failed-fast detection (treating an immediate `process_missing` as
  "launch failed" rather than sitting in `detecting` for minutes) — a separate
  detection issue.
- Live `agent-orchestrator.yaml` (gitignored; operator merges from example +
  `migration_notes.md`).
- The NO_FINDINGS pack-wrapper review contract and #60's review preflight /
  failed-run clauses, and draft 24 / the #60 body — all unchanged by this issue.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
code-reviews/**
```

## Acceptance criteria

1. A pack-owned launch-safety check exists and is wired into `scripts/verify.ps1`;
   `scripts/verify.ps1` runs green with it present.
2. Given a fixture spawn prompt that contains ASCII double-quote characters, the
   check reports the launch-unsafe condition (non-zero exit or an explicit
   unsafe-classification in its output); given a launch-safe fixture, it passes.
   Both outcomes are reproducible offline with no `ao spawn` and no network.
3. The unsafe-case message is actionable: it names the safe-spawn path (or the
   neutralization step) rather than emitting only a raw error.
4. `agent-orchestrator.yaml.example` `orchestratorRules` instructs the orchestrator
   to run the launch-safety check before `ao spawn` and to halt (not silently
   proceed) on a launch-unsafe body; the `orchestratorRules` literal contains no
   ASCII double-quote.
5. `scripts/check-orchestrator-rules-quotes.ps1` (Issue #55 guard) still passes on
   the updated `orchestratorRules` literal.
6. `docs/migration_notes.md` documents the worker-spawn launch-safety risk, the
   failure signature (launch-time `process_missing` → `stuck` / `probe_failure`,
   no work, no Cursor chat), how to author launch-safe spawn-bound bodies, and the
   AO-core escalation pointer.
7. `docs/issues_drafts/00-architecture-decisions.md` has a new subsection recording
   the spawn-path launch-safety decision (repo-local, checkable that the subsection
   exists). The corresponding Issue #3 body re-sync is proven by an explicit
   `gh issue view 3` capture in PR notes, not by inspection alone (see Verification
   step 5).

## Upgrade-safety check

- No edits to `packages/core/**` or `vendor/**`.
- No new AO YAML fields (the `reviewer:` block stays invalid/ignored on 0.9.x; no
  new schema keys).
- No new repository secrets.
- Preserves the Issue #55 launch-safe `orchestratorRules` contract and its guard,
  and leaves #60's review preflight / failed-run clauses and the NO_FINDINGS
  pack-wrapper review contract unchanged.

## Verification

1. Run the new/extended launch-safety check against a fixture spawn prompt
   containing ASCII double-quotes and show it classifies the input as unsafe
   (non-zero exit or explicit unsafe output); run it against a launch-safe fixture
   and show it passes. Record both commands and outputs in PR notes (criteria
   1–3).
2. Run `scripts/verify.ps1` and show it passes with the new check wired in
   (criterion 1).
3. Run `scripts/check-orchestrator-rules-quotes.ps1` after editing
   `orchestratorRules` and show it passes (criterion 5).
4. Copy `agent-orchestrator.yaml.example` to a scratch path **outside the
   repository** (e.g. `$env:TEMP\op-ao-scratch.yaml`, never the denylisted live
   `agent-orchestrator.yaml`) and confirm it still parses as valid YAML; record the
   command. (No new schema keys are added, so a parse check is sufficient.)
5. Show the `docs/migration_notes.md` subsection and the
   `00-architecture-decisions.md` subsection (criteria 6–7), and capture
   `gh issue view 3` output in PR notes to prove the Issue #3 re-sync (criterion 7).
