# Worker prompt-delivery launch failure on Windows (workers exit at spawn)

GitHub Issue: #63

## Prerequisite

- GitHub Issue #55 is **closed** (PR #56 on `main`): launch-safe `orchestratorRules`
  (no embedded ASCII double-quote / inline `--command` lines) plus the guard
  `scripts/check-orchestrator-rules-quotes.ps1`. That work fixed quote handling in
  the `orchestratorRules` literal. The worker launch failure below is on a
  **different launch path** (the Cursor agent launch command, not
  `orchestratorRules`) with a different cause (prompt delivery, not quote
  escaping); #55 stays unchanged.
- AO local review preflight + failed-run discipline (file
  `docs/issues_drafts/24-ao-review-preflight-and-failed-run-discipline.md`,
  GitHub Issue #60) is the issue whose worker repeatedly failed to launch while
  this was diagnosed. This issue makes that launch failure **legible and
  escalated** ÔÇö it does not fix worker launch in the pack. It also **amends the
  #60 clauses built on the now-disproven hypothesis that issue-body quotes break
  the worker launch** (binding-surface item 4c and the matching topic in
  acceptance criterion 4 ÔÇö "launch-safe GitHub Issue bodies for spawn"); the #60
  body is re-synced in the same PR. No #60 review-preflight or failed-run clause
  changes.
- Issue #11 autonomous review-loop contract (file
  `docs/issues_drafts/11-orchestrator-autonomous-review-loop.md`) defines
  orchestrator/worker roles; this issue only adds a launch-failure detection /
  documentation surface and an upstream escalation ÔÇö it does not change review
  statuses.
- The real fix is in the AO Cursor agent plugin (`@aoagents/ao-plugin-agent-cursor`)
  and/or AO core, which are vendor packages outside this repository. The pack
  cannot patch them; the durable pack-side deliverable is detection, operator
  documentation, and an upstream escalation (see **Files out of scope**).

## Goal

A Cursor worker session on Windows must not silently exit at launch because AO
delivers the worker prompt by inlining it into the launch command line. Today the
failure is invisible at first (AO records a healthy `session.spawned` /
`spawning ÔåÆ working`), then the worker process exits within ~1 minute and the
session drifts `working ÔåÆ detecting ÔåÆ stuck` with no PR, no `ao acknowledge`, and
no Cursor chat ever created. The pack must make this failure **legible** (named
signature, operator guidance, escalation) rather than presenting as a stuck
agent, and must record that the obvious shell workaround does not fix it.

### Root cause (verified, upstream)

`@aoagents/ao-plugin-agent-cursor` builds the **worker** launch command by inlining
the prompt into argv via shell command substitution ÔÇö when both a system-prompt
file and a task prompt are present, the form is essentially
`agent ÔÇª -- "$(cat <file>; printf ÔÇª; printf %s '<prompt>')"`. On Windows this
fails two independent ways:

- **Signature A ÔÇö POSIX builtin under PowerShell.** AO's default Windows shell is
  `powershell.exe -Command` (no `pwsh`). `printf` is a POSIX builtin that does not
  exist in PowerShell, so the launch line dies with
  `printf : The term 'printf' is not recognized ÔÇª` and the agent CLI then sees
  `error: unknown option '-ne'`.
- **Signature B ÔÇö command line too long.** Even after forcing a POSIX shell
  (`AO_SHELL=bash`) and resolving the agent binary, the substitution inlines the
  **entire** prompt into argv. For a large issue body (the #60 worker prompt is
  ~24 KB) this exceeds the Windows command-line length limit and the launch dies
  with `The command line is too long`. This mode is **shell-independent** ÔÇö it is
  about argv size, not shell dialect.

The orchestrator session survives because its launch path uses the file-only form
(`ÔÇª -- "$(cat <file>)"`, no `printf`) **and** its prompt fits under the length
limit; large worker prompts hit both signatures.

`AO_SHELL=bash` (the documented AO escape hatch) was tested on this machine and is
**not** a working workaround: it clears Signature A but then fails on
`agent: command not found` (Git Bash does not resolve the Windows `agent.cmd`
launcher), and after a shim it fails on Signature B for the #60-sized prompt.

## Binding surface

This issue commits the repository to:

1. **Named launch-failure signature.** The pack defines and documents a single
   named condition ÔÇö a Cursor worker that exits at launch on Windows ÔÇö covering
   **both** observed signatures (POSIX-builtin-under-PowerShell and
   command-line-too-long). The definition keys off the launch-failure evidence
   (worker `agent_process_exited` shortly after `spawning ÔåÆ working`, no PR, no
   acknowledge, no Cursor chat) plus the PTY error text, **not** off issue-body
   character content.
2. **Pack-side detection / diagnostic.** A pack-owned, offline-runnable check or
   diagnostic (new or an extension of an existing script ÔÇö planner's choice of
   name and placement) that recognizes the launch-failure condition from available
   artifacts (e.g. session/lifecycle state and/or a captured PTY log fixture) and
   reports it with an actionable message pointing at the documentation and the
   upstream escalation. It MUST run offline against a fixture (no live `ao spawn`,
   no network).
3. **No spec-content restriction.** The cause is the delivery mechanism, not body
   characters. Nothing here rejects a draft body as an invalid spec for containing
   quotes or JSON. A size-based launch-feasibility **warning** ÔÇö flagging that a
   prompt will exceed the Windows argv limit and therefore will not launch ÔÇö is
   in-scope *detection* (item 2), not a content restriction, because it informs
   rather than invalidates the spec.
4. **Amend the #60 quote-hypothesis clauses.** Draft 24 / Issue #60 carries a
   launch-safety reminder (keep spawn-bound issue bodies free of `"` /
   `--command "` literals, per Issue #55) in **both** binding-surface item 4c and
   the matching topic of acceptance criterion 4 ("launch-safe GitHub Issue bodies
   for spawn"), built on the hypothesis that body quotes break the worker launch.
   The verified root cause above disproves that ÔÇö the failure is prompt delivery,
   independent of body quotes. This issue amends **every** such #60 clause to drop
   the quote-based body restriction and point at the prompt-delivery cause, and
   re-syncs the #60 body in the same PR. No #60 review-preflight or failed-run
   clause changes.
5. **Operator documentation.** `docs/migration_notes.md` gains a subsection
   covering: the worker prompt-delivery launch failure on Windows; both signatures
   and their exact error text; the visible lifecycle progression
   (`spawning ÔåÆ working ÔåÆ detecting ÔåÆ stuck`, no PR / no acknowledge / no Cursor
   chat); the verified fact that `AO_SHELL=bash` is **not** a working workaround
   for large worker prompts; and the upstream escalation pointer.
6. **Recovery runbook pointer.** The operator recovery surface
   (`docs/orchestrator-recovery-runbook.md` and/or its draft
   `docs/issues_drafts/15-orchestrator-recovery-runbook.md`) references this
   launch-failure signature so an operator (or the orchestrator) who sees a worker
   `agent_process_exited` with no PR shortly after spawn inspects the PTY for
   Signature A/B and routes to the migration note **instead of** the
   orchestrator-stuck ping path. It must also distinguish this launch failure from
   benign `workspace.branch_collision` warnings, which are a separate
   (workspace-hygiene) concern.
7. **Decision log.** `docs/issues_drafts/00-architecture-decisions.md` gains a new
   subsection (next available letter) recording the decision: the worker
   launch failure is an upstream prompt-delivery defect (inline-argv + POSIX
   `printf` on Windows), the pack-side response is detection + documentation +
   escalation, and `AO_SHELL=bash` is not a sufficient workaround. The **existing**
   ┬ºG sentence asserting that GitHub Issue bodies used as spawn prompts must avoid
   `"` / `--command "` literals MUST also be corrected in the same change (the
   `orchestratorRules` half stays ÔÇö that is Issue #55 ÔÇö but the issue-body
   quote restriction is the disproven half), consistent with the #60 item 4c
   amendment. The corresponding Issue #3 body is re-synced in the same PR.
8. **Upstream escalation note.** The migration note (or decision log) records that
   the durable fix belongs in `@aoagents/ao-plugin-agent-cursor` / AO core ÔÇö
   deliver the worker prompt via a file or flag rather than inlining it into argv,
   and do not use a POSIX `printf` builtin on Windows ÔÇö and links where to file it.

## Files in scope

- `scripts/` ÔÇö the launch-failure detection / diagnostic (new script or extension
  of an existing one such as `scripts/orchestrator-diagnose.ps1`; planner's
  choice), wired into `scripts/verify.ps1` if it is a verifiable check.
- `docs/migration_notes.md` ÔÇö new subsection (binding-surface items 5 and 8).
- `docs/issues_drafts/24-ao-review-preflight-and-failed-run-discipline.md` ÔÇö amend
  every clause encoding the quote hypothesis (item 4c and the matching topic in
  acceptance criterion 4); re-sync the #60 body in the same PR. Do not touch #60's
  review-preflight or failed-run clauses.
- `docs/orchestrator-recovery-runbook.md` and/or
  `docs/issues_drafts/15-orchestrator-recovery-runbook.md` ÔÇö pointer
  (binding-surface item 6).
- `docs/issues_drafts/00-architecture-decisions.md` ÔÇö new subsection + Issue #3
  re-sync (binding-surface item 7).
- `docs/issues_drafts/25-worker-spawn-launch-safety.md` ÔÇö this spec.

## Files out of scope

- `@aoagents/ao-plugin-agent-cursor`, AO core, the PowerShell launch template, and
  the spawn-prompt interpolation (vendor packages; `vendor/**` and the AO install).
  The pack cannot patch how AO delivers the worker prompt; that is the upstream
  escalation in item 7. This issue does not commit to making the worker launch on
  Windows ÔÇö only to detecting, documenting, and escalating the failure.
- AO's worktree checkout / branch-collision behaviour and stale-branch /
  leftover-worktree hygiene ÔÇö a separate workspace-hygiene issue.
- Spawn-side failed-fast detection inside AO (treating an immediate
  `agent_process_exited` as launch-failed rather than sitting in `detecting` for
  minutes) ÔÇö an AO-core concern; this issue only documents the signature and adds
  a pack-side diagnostic.
- Live `agent-orchestrator.yaml` (gitignored; operator merges from example +
  `migration_notes.md`).
- Issue #55 quote handling, the NO_FINDINGS pack-wrapper review contract, and
  #60's review preflight / failed-run clauses ÔÇö all unchanged.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
.agent-orchestrator/**
agent-orchestrator.yaml
code-reviews/**
```

## Acceptance criteria

1. The pack documents a single named worker launch-failure condition that
   explicitly covers both Signature A (`printf` not recognized / `unknown option
   '-ne'` under PowerShell) and Signature B (`command line is too long` for a large
   prompt), keyed off launch-failure evidence rather than issue-body content.
2. A pack-owned detection / diagnostic recognizes the condition from a fixture
   (session/lifecycle state and/or a captured PTY log) and emits an actionable
   message pointing at the migration note; it runs offline with no `ao spawn` and
   no network. Reproducible: a matching fixture is flagged, a non-matching fixture
   is not.
3. If the detection is a verifiable check, `scripts/verify.ps1` runs green with it
   wired in.
4. Nothing added by this issue rejects a `docs/issues_drafts/*.md` body as an
   invalid spec for containing quotes or JSON ÔÇö provable by running the pack's
   checks against a quote-dense fixture body and showing no failure attributable to
   that content. (A size-based launch-feasibility *warning* per binding item 3 does
   not count as rejecting the spec.)
5. `docs/issues_drafts/24-ao-review-preflight-and-failed-run-discipline.md` no
   longer restricts issue-body quotes for launch safety in **any** clause (item 4c
   and the acceptance-criterion-4 topic both reference the prompt-delivery cause
   instead). Repo-local grep-able in draft 24; the #60 body re-sync is shown via
   `gh issue view 60` in PR notes.
6. `docs/migration_notes.md` documents both signatures with their exact error
   text, the visible lifecycle progression, the verified fact that `AO_SHELL=bash`
   is not a working workaround for large worker prompts, and the upstream
   escalation pointer.
7. The operator recovery surface references the launch-failure signature so a
   worker that exits immediately after spawn routes to the migration note rather
   than the orchestrator-stuck recovery path.
8. `docs/issues_drafts/00-architecture-decisions.md` has a new subsection recording
   the prompt-delivery launch-failure decision, **and** its existing ┬ºG sentence no
   longer asserts that spawn-prompt issue bodies must avoid `"` / `--command "`
   literals (the `orchestratorRules` half may remain). Both are repo-local
   grep-able. The Issue #3 re-sync is proven by an explicit `gh issue view 3`
   capture in PR notes (see Verification step 6).
9. `scripts/check-orchestrator-rules-quotes.ps1` (Issue #55 guard) still passes ÔÇö
   this issue does not touch `orchestratorRules`.

## Upgrade-safety check

- No edits to `packages/core/**`, `vendor/**`, or the AO install.
- No new AO YAML fields (the `reviewer:` block stays invalid/ignored on 0.9.x).
- No new repository secrets.
- Leaves Issue #55 quote handling, #60's review preflight / failed-run clauses, and
  the NO_FINDINGS pack-wrapper review contract unchanged.

## Verification

1. Run the new/extended detection against a fixture that reproduces Signature A
   (PTY log containing `printf ÔÇª not recognized` / `unknown option '-ne'`) and a
   fixture for Signature B (`command line is too long`); show both are classified
   as the launch-failure condition, and a healthy-launch fixture is not. Record
   commands and outputs in PR notes (criteria 1ÔÇô2).
2. If the detection is a check, run `scripts/verify.ps1` and show it passes with
   the check wired in (criterion 3).
3. Run the pack's checks against a quote-dense fixture body and show no failure
   attributable to its content (criterion 4).
4. Run `scripts/check-orchestrator-rules-quotes.ps1` and show it still passes
   (criterion 9).
5. Grep draft 24 and show no remaining quote-based spawn-body restriction (item 4c
   and the acceptance-criterion-4 topic), and capture `gh issue view 60` in PR
   notes showing the re-synced body (criterion 5).
6. Show the `docs/migration_notes.md` subsection (both signatures, lifecycle
   progression, `AO_SHELL=bash` non-workaround, escalation) and the
   `00-architecture-decisions.md` subsection (criteria 6, 8); capture
   `gh issue view 3` output in PR notes to prove the Issue #3 re-sync (criterion 8).
7. Show the recovery-surface pointer to the launch-failure signature (criterion 7).
8. PR description lists **every** synced artifact (draft 24 + #60 body, draft 25 +
   #63 body, ┬ºG + Issue #3 body) and states explicitly that this PR amends the #60
   body's quote clauses while #60's review-preflight implementation remains a
   separate issue. If a size-based launch-feasibility warning is implemented,
   record the empirical threshold it uses (e.g. observed worker-prompt size vs the
   Windows argv limit) in PR notes ÔÇö the spec pins no fixed number.
