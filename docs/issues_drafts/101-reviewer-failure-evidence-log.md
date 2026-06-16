# Reviewer failure evidence log for dead local review processes

GitHub Issue: #312

## Prerequisite

- `docs/issues_drafts/24-ao-review-preflight-and-failed-run-discipline.md` (GitHub
  #60, closed) — shipped failed-run discipline and wrapper failure text in
  `terminationReason` when the reviewer process lives long enough to exit through
  the wrapper path. This draft extends the observable evidence for the class where
  the process disappears before that path can write a useful terminal reason.
- `docs/issues_drafts/91-review-run-crash-safe-terminal-status.md` (GitHub #287,
  closed) — shipped durable reviewer-liveness identity and the reaper that moves a
  provably dead local review run to a failed-family terminal status. This draft
  reuses that liveness/reaper machinery and adds a bounded, redacted execution
  evidence artifact; it does not re-implement terminalization.
- `docs/issues_drafts/100-review-start-claim-atomic-single-winner.md` (GitHub
  #308, open) — hardens review-start claim atomicity and claim release after a
  terminal run failure. This draft is distinct: it records why a reviewer process
  died or where it last made progress; it does not change review-start claims.

## Goal

When a local AO review run is terminalized as
`reviewer_liveness_provably_dead` / `proc_entry_missing`, operators must have a
durable, redacted evidence record that narrows the cause beyond "PID disappeared":
last known execution phase, wrapper identity, child process identity when
available, exit/signal data when the wrapper can observe it, and bounded
stdout/stderr tails. The record must be written incrementally while the reviewer is
alive, so an uncatchable death still leaves useful evidence, and the existing #287
reaper can link that evidence into its recovery audit without treating it as a
clean review verdict.

```behavior-kind
action-producing
```

## Binding surface

This issue commits the repository to a **reviewer failure evidence artifact** for
local AO review runs. The artifact is record-only observability: it may inform
operators and recovery audit, but it must not start reviews, send findings,
release claims, or change coverage status by itself.

**Re-used from #287 (do not re-implement):** reviewer-liveness identity capture,
exact-process liveness classification, terminalization to a failed-family status,
and recovery audit for dead/ambiguous runs.

**Added by this issue:**

- **Incremental phase recording.** The review entrypoint records a small
  allowlisted phase trail before and during execution: selector resolved, wrapper
  resolved, arguments prepared, wrapper/process started, reviewer output observed,
  wrapper exited, or entrypoint failed before wrapper start. If the process dies
  mid-flight, the last persisted phase is still available.
- **Bounded process-output capture.** Reviewer stdout/stderr are captured to
  bounded or tail-bounded artifacts, or to artifacts with a bounded tail copied into
  the evidence record. Full unbounded transcripts must not be embedded in run JSON.
- **Observed terminal details when available.** When the entrypoint can observe a
  normal or abnormal child-process termination, it records exit code and, on
  supported platforms, signal/termination detail. When the entrypoint itself is
  killed before it can observe termination, the record explicitly remains at the
  last known phase rather than inventing an exit code.
- **Recovery linkage.** When #287 terminalizes a run as provably dead or
  ambiguous-stale, the recovery audit/run record links to the evidence artifact and
  copies only the bounded, redacted summary fields needed for diagnosis. A missing
  evidence artifact is itself recorded as a diagnostic condition, not silently
  ignored.
- **Secret-safe schema.** The artifact schema is allowlisted. It must not persist
  environment values, auth tokens, cookies, private keys, full command lines, full
  prompts, or arbitrary profile/cwd dumps. Paths may be recorded only when they are
  necessary to locate pack-owned runtime artifacts and are not credential-bearing.

The artifact is local AO runtime state, not repository source state. The planner
chooses whether it is a sidecar file, JSONL journal, or another pack-owned runtime
record, as long as it is durable across a reviewer-process death and consumable by
the #287 recovery path.

## Files in scope

- `scripts/**` — local review entrypoint, liveness/failure-evidence helpers,
  recovery tests and fixtures.
- `docs/review-run-recovery.mjs` and related generated types/docs — only to attach
  evidence summaries/links to #287 recovery audit.
- `plugins/ao-codex-pr-reviewer/**` and existing reviewer wrapper scripts under
  `scripts/**` — only as needed to expose wrapper/process output through the
  reviewer-agnostic entrypoint.
- `docs/**` — issue draft, runbook/migration notes for interpreting failure
  evidence.
- `agent-orchestrator.yaml.example` — only if operator-facing runtime wiring or
  documented env knobs are required.

## Files out of scope

- AO core and vendored runtime.
- Review-start claim acquisition/release, covered by #308.
- Changing the #287 liveness classification or terminal status taxonomy except for
  linking additional evidence.
- Finding parsing, finding delivery, and worker message submission.
- Persisting full reviewer transcripts, full prompts, environment snapshots, or
  machine-local credential material.

```denylist
vendor/**
packages/core/**
.ao/**
```

## Acceptance criteria

- For a realistic local AO review run whose reviewer process disappears mid-flight,
  the recovery audit includes a bounded evidence summary or an explicit
  missing-evidence diagnostic linked to that run.

```positive-outcome
asserts: a local review run whose reviewer process disappears mid-flight produces a durable bounded failure-evidence record linked from recovery audit
input: external-tool-output
provenance: capture-backed
```

- A review entrypoint invocation creates a durable evidence artifact before the
  wrapper is started, bound to the same run/session identity used by #287 where
  available. If run id is not yet discoverable at that instant, the artifact has a
  stable reviewer-session binding and is later associated with the run without
  ambiguity.
- A fixture that kills the reviewer entrypoint after wrapper start but before
  wrapper exit leaves an evidence artifact with the last persisted phase and no
  fabricated exit code.
- A fixture where the wrapper exits non-zero records the observed exit code and a
  bounded stderr tail; the resulting AO failed run remains non-clean and preserves
  existing #60 failed-run discipline.
- A fixture where the reviewer subprocess is terminated by signal, on a supported
  platform that exposes the signal, records the signal or an explicit
  `signal_unavailable` value. Absence of signal detail must not be confused with a
  clean exit.
- #287 recovery audit for `reviewer_liveness_provably_dead` includes either a link
  to the evidence artifact plus bounded summary fields, or an explicit
  `failure_evidence_missing` diagnostic when the artifact cannot be found.
- Repeated recovery ticks do not duplicate evidence summaries or append unbounded
  audit spam for the same run/evidence epoch.
- The evidence schema is allowlisted and secret-safe: tests assert that environment
  values, auth tokens, cookies, private keys, full command lines, full prompts, and
  arbitrary cwd/profile dumps are absent from artifacts, run records, and audit
  records.
- Output capture is bounded: large stdout/stderr streams are truncated or stored as
  bounded tail summaries according to documented limits, and run JSON never embeds
  unbounded transcripts.
- A successful clean or needs-triage review may leave a normal completion evidence
  record, but that record is never used as a review verdict; existing AO run status
  and finding records remain authoritative.
- The `opk-rev-318` class is reproducible as a regression fixture: a run whose
  process disappears with `proc_entry_missing` produces a recovery audit that shows
  the last phase/evidence availability instead of only "PID disappeared".

## Upgrade-safety check

- No edits to `packages/core/**` or `vendor/**`.
- No unsupported AO YAML keys; any operator-facing runtime wiring stays in existing
  pack-supported surfaces.
- No new repository secrets and no logging of machine-local credentials.
- The new artifact is additive to #287 recovery; if evidence capture fails, #287
  liveness recovery still terminalizes the dead run as before and records the
  evidence-capture failure as diagnostic data.
- The schema is backward-compatible for existing recovery records: older runs
  without evidence artifacts remain readable and classify as `failure_evidence_missing`
  when inspected by the new recovery/audit code.

## Verification

- Run focused unit/fixture tests for the evidence artifact lifecycle: pre-wrapper
  creation, phase updates, wrapper non-zero exit, killed mid-flight, signal detail
  when available, and missing-artifact recovery linkage.
- Run a large-output fixture proving stdout/stderr capture is bounded and run JSON
  receives only a bounded summary/link.
- Run a no-secret-leak fixture over evidence artifacts, recovery audit, and updated
  run records.
- Run #287 recovery tests to prove existing liveness terminalization behavior is
  unchanged when evidence exists, is missing, or is malformed.
- Run `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/101-reviewer-failure-evidence-log.md`.
- Run `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command parked-root -DraftPath docs/issues_drafts/101-reviewer-failure-evidence-log.md`.
- Run the repository verification commands required by `AGENTS.md`.

## Decisions (design analysis)

### Prior art

- **#60 / architecture §G** already requires wrapper stderr and failure text to
  reach `terminationReason` for normal wrapper failures. The gap is the
  uncooperative-death case: if the entrypoint or reviewer process disappears
  before normal failure handling runs, no exit/stderr summary reaches the run.
- **#287** already owns liveness proof and terminalization for dead reviewers. It
  deliberately persists only liveness identity/evidence, not execution-phase or
  bounded output evidence. This draft extends #287's audit surface rather than
  replacing it.
- **#308** owns claim lifecycle after terminal run failure. It reuses #287 but does
  not inspect reviewer stderr, exit code, signal, or phase. This draft stays out of
  claims.

Verdict: **extends shipped #287 and #60; does not duplicate #308**.

### 5 Whys

Problem: `opk-rev-318` died with `reviewer_liveness_provably_dead` and
`proc_entry_missing`, but the cause of death was not diagnosable.

1. Why was it not diagnosable? The run record had liveness evidence but no
   execution evidence such as last phase, stderr tail, exit code, or signal.
2. Why was there no execution evidence? The current useful failure text is emitted
   through the wrapper/normal exit path, and the reviewer process disappeared before
   that path could produce a terminal failure message.
3. Why could recovery not reconstruct it later? #287 only proves exact-process
   liveness/death from sidecar identity; it does not capture the process's
   execution stream or phase history while the process is alive.
4. Why not just read system logs after the fact? System logs are not reliably
   correlated to a review run, may omit the process, and do not carry pack-level
   phase context.
5. Root cause: the failure-observability contract assumes either normal wrapper
   exit (#60) or liveness death classification (#287), but lacks an incremental,
   run-bound, secret-safe execution evidence artifact for uncooperative reviewer
   death.

### Options considered

1. **Only update the runbook to say "manual reproduce the workspace."** Cheapest,
   but insufficient: the manual reproduction of `opk-rev-318` succeeded and did
   not explain the original death.
2. **Embed full stdout/stderr/command/env in the AO run record.** High diagnostic
   power but rejected: high secret risk, unbounded run JSON growth, and conflict
   with #287's no-secret evidence discipline.
3. **Add a bounded, allowlisted sidecar/journal linked by #287 recovery (chosen).**
   Moderate cost, keeps AO run records small, captures useful data before death,
   and preserves #287 as the terminalization authority. This is the cheapest
   sufficient executor with acceptable risk.

### Full-class enumeration

| Class | Required evidence outcome |
|---|---|
| Entrypoint fails before wrapper start | phase says pre-wrapper failure; bounded error summary if available |
| Wrapper exits non-zero normally | exit code + bounded stderr tail recorded |
| Reviewer process receives observable signal | signal recorded, or explicit signal-unavailable on unsupported platform |
| Entrypoint/reviewer disappears mid-flight | last persisted phase remains; no fabricated exit code |
| Evidence artifact missing/malformed | recovery records `failure_evidence_missing` / malformed diagnostic; #287 terminalization still works |
| Large output | artifact remains bounded; run JSON stores only link/summary |
| Successful review | evidence may record normal completion but does not become verdict authority |

