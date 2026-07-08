# Get-RepoIdentity must not crash on gh `2>&1` ErrorRecord output

GitHub Issue: #685

## Prerequisite

Already-shipped work this draft repairs (all merged; none fix this defect):

- `docs/issues_drafts/90-ci-failure-notify-cross-path-dedup.md` (GitHub #283) —
  shipped the CI-failure cross-path dedup predicate; `Get-RepoIdentity` was added
  as a dependency of this path. **Reused, not rebuilt.**
- `docs/issues_drafts/220-*.md` (GitHub #645) — retired the orchestrator-turn
  CI-failure class but explicitly left the **reconcile side-process path**
  intact; this defect lives in that surviving path.

No open issue or draft tracks this defect (verified against the queue).

## Goal

`Get-RepoIdentity` in the CI-failure-notification shared library returns the clean
`owner/repo` string whenever `gh repo view` exits 0 — including when `gh` writes a
warning line to stderr at exit 0, or when the merged `2>&1` stream contains a
non-string record — instead of throwing a `.Trim()` method-invocation error. The
result: the CI-failure notification reaction and reconcile side-processes record a
red-CI episode and emit the orchestrator ci-failed ping instead of dying on the tick.

```complexity-tier
tier: T1
advisory-prior: T1
```

```behavior-kind
action-producing
```

## Binding surface

- `Get-RepoIdentity` **isolates the `owner/repo` slug** from the merged
  `gh … 2>&1` output stream rather than joining the whole stream: it must not call
  `.Trim()` on a non-string record (e.g. `System.Management.Automation.ErrorRecord`),
  and it must return **only** the identity datum — not any stderr warning line that
  shares the merged stream. (Stringifying-and-joining the entire stream is
  explicitly insufficient: it would embed warning text; the planner isolates the
  slug — e.g. by the stdout line / owner-repo shape — and returns it trimmed.)
- When `gh repo view` exits non-zero the function still throws with the captured
  output (unchanged failure contract).
- On success the resolved identity contains no embedded stderr warning text — the
  returned value is the `owner/repo` datum only, usable directly as a repo slug.
- No behavioral change to any caller contract beyond "no longer throws on a
  non-string `2>&1` element at exit 0"; both callers
  (`ci-failure-notification-reaction`, `ci-failure-notification-reconcile`)
  continue to receive a plain string.

## Files in scope

- `scripts/lib/Ci-Failure-Notification-Common.ps1` — `Get-RepoIdentity` only.
- A regression test under `scripts/` or `tests/powershell/` (planner picks the
  location/name and harness) exercising the mixed-stream and warning-at-exit-0 cases.

## Files out of scope

- The six `ao events` event-consumer sidecars and `Get-AoEventsSince` (owned by
  the separate events-rebind draft) — even though
  `ci-failure-notification-reconcile.ps1` appears in both, this draft touches only
  `Get-RepoIdentity`.
- Any other function in `Ci-Failure-Notification-Common.ps1`.
- `agent-orchestrator.yaml`, reactions, `orchestratorRules`.

```denylist
vendor/**
packages/core/**
.ao/**
```

```allowed-roots
scripts/**
tests/**
```

## Acceptance criteria

- `Get-RepoIdentity` returns `owner/repo` (no surrounding whitespace, no embedded
  warning text) when `gh repo view` exits 0 and emits the identity on stdout.
- When the merged `2>&1` stream is (or contains) a non-string record such as an
  `ErrorRecord` while exit code is 0, `Get-RepoIdentity` returns the clean identity
  and does **not** throw a `.Trim()`/method-invocation error.
- **Warning-line isolation:** when the merged `2>&1` stream at exit 0 contains a
  **warning line in addition to** the stdout `owner/repo` (whether the warning
  arrives as a string line or a non-string record), `Get-RepoIdentity` returns
  **exactly** `owner/repo` with **no** warning text embedded. A normalization that
  merely stringifies-and-joins the whole stream (which would yield
  `warning... owner/repo`) does **not** satisfy this — the returned value must be
  the slug alone.
- When `gh repo view` exits non-zero, `Get-RepoIdentity` throws, surfacing the
  captured output (unchanged).
- A regression test fails against the pre-fix `[string]$raw.Trim()` form and
  passes against the fixed normalization.

```positive-outcome
asserts: Get-RepoIdentity resolves to the clean owner/repo slug when the gh output stream is a plain identity string at exit 0
input: realistic
```

```positive-outcome
asserts: Get-RepoIdentity returns the clean owner/repo slug (no throw) when the merged 2>&1 stream is a synthesized array containing a non-string ErrorRecord element at exit 0
input: realistic
```

```positive-outcome
asserts: Get-RepoIdentity returns exactly owner/repo (no embedded warning text) when the merged 2>&1 stream at exit 0 contains a warning line alongside the stdout slug
input: realistic
```

```contract-evidence
none
```

## Upgrade-safety check

- No edits to `packages/core/**`, `vendor/**`, or `.ao/**`.
- No AO core or CLI contract change; `gh` invocation shape is unchanged.
- No unsupported YAML; no new repository secrets.
- PowerShell-only change plus a test; no new runtime dependency.

## Verification

- Run the pack contract test suite (`pwsh -File ./scripts/test-all.ps1`) — the new
  regression test passes.
- Demonstrate the regression test **fails** when `Get-RepoIdentity` is reverted to
  `return [string]$raw.Trim()` and **passes** with the normalization, proving it
  binds the real defect.
- The regression test synthesizes all three input shapes directly — a plain
  identity string; an array containing a non-string `ErrorRecord`; and a merged
  stream carrying a **warning line alongside** the stdout `owner/repo` — asserting
  the last returns **exactly** the slug with no warning text. No live `gh` capture
  is required, since the fix normalizes an internal PowerShell stream.
