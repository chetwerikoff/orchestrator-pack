# AO 0.10.x operator upgrade runbook (Issue #590)

Operator guide for moving a **live** Agent Orchestrator installation from **0.9.5**
to the current stable **0.10.x** release while preserving pack spawn safety and
`PACK_REVIEWER` / `REVIEW_COMMAND` review driving.

> **Scope boundary.** This document and the companion preflight script record
> release facts, install paths, output-shape gates, rollback steps, and the live
> operator checklist. **CI and a merged PR do not upgrade the operator's AO
> binary.** The install, restart, and `ao --version` proof happen **after merge**
> from an **operator terminal** — never from an AO-managed worker session.

## Prerequisite

- **Issue #589** (spawn `--project` / `--name` prerequisite) must be **merged and
  adopted** before the live binary upgrade. See
  [`docs/migration_notes.md`](migration_notes.md) § AO 0.10.x runnable `ao spawn`
  shape.
- Pack review driving stays on **`PACK_REVIEWER`** / **`REVIEW_COMMAND`** through
  `scripts/invoke-pack-review.ps1`. Do **not** switch to AO typed `reviewers`
  config or a top-level YAML `reviewer:` block — those paths are out of scope
  for this pack.

## Selected target (implementation-time capture)

Facts below were captured on **2026-07-05** against upstream
[`AgentWrapper/agent-orchestrator`](https://github.com/AgentWrapper/agent-orchestrator).
Machine-readable copy:
[`scripts/fixtures/ao-operator-upgrade/v0.10.2-release-facts.json`](../scripts/fixtures/ao-operator-upgrade/v0.10.2-release-facts.json).

| Field | Value |
|-------|-------|
| **Selected stable release** | `v0.10.2` |
| **Published** | 2026-07-03T20:39:51Z |
| **Selection basis** | Latest non-prerelease tag on GitHub releases |
| **Newer non-stable observed** | `v0.10.3-nightly.202607041403` (nightly only — not selected) |

**Re-check before you install.** If a newer **stable** tag exists, prefer it
unless the operator explicitly holds at `v0.10.2`. Refresh facts with:

```bash
export PATH="/path/to/orchestrator-pack/scripts:$PATH"
which gh   # must resolve to orchestrator-pack/scripts/gh
gh api repos/AgentWrapper/agent-orchestrator/releases --paginate --jq '.[].tag_name'
```

## npm installability

GitHub releases are the binding source for **0.10.2** adoption while npm lags.

| Package | Latest on npm (2026-07-05) | Target `0.10.2` installable? |
|---------|---------------------------|------------------------------|
| `@aoagents/ao` | `0.10.0` | **No** (`npm view @aoagents/ao@0.10.2` → E404) |
| `@aoagents/ao-linux-x64` | `0.10.0` | **No** |

**Therefore:** use a **GitHub release asset** for the live upgrade. Do **not**
run `npm install -g @aoagents/ao@0.10.2` — it will fail or silently pin an
older line.

Verify at upgrade time:

```bash
npm view @aoagents/ao versions --json
npm view @aoagents/ao-linux-x64 versions --json
```

## GitHub release asset install (Linux / WSL2 x86_64)

Primary assets for Ubuntu 22.04+ / WSL2 on **amd64**:

| Asset | URL | Size (bytes) | Checksum / signature on release |
|-------|-----|--------------|--------------------------------|
| `.deb` | https://github.com/AgentWrapper/agent-orchestrator/releases/download/v0.10.2/agent-orchestrator_0.10.2_amd64.deb | 93 231 416 | **None published** — operator acknowledgement required |
| AppImage (checksum-backed) | https://github.com/AgentWrapper/agent-orchestrator/releases/download/v0.10.2/Agent.Orchestrator-0.10.2.AppImage | 120 483 726 | **sha512** in `latest-linux.yml` (see below) |
| `.rpm` | https://github.com/AgentWrapper/agent-orchestrator/releases/download/v0.10.2/agent-orchestrator-0.10.2-1.x86_64.rpm | 91 955 233 | **None published** — operator acknowledgement required |

### AppImage integrity (upstream-published)

Use the asset named in `latest-linux.yml` — **`Agent.Orchestrator-0.10.2.AppImage`**
(not the lowercase `agent-orchestrator-linux-x64.AppImage` alias, which has no
published checksum on the release).

```bash
curl -fsSL -o /tmp/latest-linux.yml \
  "https://github.com/AgentWrapper/agent-orchestrator/releases/download/v0.10.2/latest-linux.yml"
curl -fL -o /tmp/Agent.Orchestrator-0.10.2.AppImage \
  "https://github.com/AgentWrapper/agent-orchestrator/releases/download/v0.10.2/Agent.Orchestrator-0.10.2.AppImage"
# Expect sha512 for Agent.Orchestrator-0.10.2.AppImage:
# I5FUlUuOPfEPvEfKXcqfP3SHrUj2XMH/0hL+g5KgDBnXCc3Es1YlFwG8WP7VSKZ4kRbdo8XqP53NNTfKnTSSXg==
```

After download, verify size **120 483 726** and compare your local sha512 before
install. **Abort** on mismatch.

### `.deb` install (recommended on Ubuntu / WSL2)

```bash
curl -fL -o /tmp/agent-orchestrator_0.10.2_amd64.deb \
  "https://github.com/AgentWrapper/agent-orchestrator/releases/download/v0.10.2/agent-orchestrator_0.10.2_amd64.deb"
# No upstream checksum — record file size 93231416 and your own sha256 before proceeding:
sha256sum /tmp/agent-orchestrator_0.10.2_amd64.deb
sudo dpkg -i /tmp/agent-orchestrator_0.10.2_amd64.deb
```

**Absent checksum acknowledgement:** upstream publishes **no** detached checksum
or signature for the `.deb` or `.rpm` assets. The operator must explicitly
acknowledge that gap before `dpkg -i` / `rpm -i`.

## Hard pre-upgrade gates (fail closed)

Complete **all** gates before changing the live AO binary. Abort and roll back
(see below) on any failure.

### 1. Pack prerequisite #589 adopted

```powershell
pwsh -NoProfile -File scripts/check-ao-spawn-shape.ps1
npx vitest run scripts/ao-spawn-shape.test.ts
```

Live `agent-orchestrator.yaml` must teach
`ao spawn --project <project> --name "<label>" --issue <N> --prompt "<task text>"` (not bare `ao spawn`). Restart
AO after yaml edits **before** the binary upgrade.

### 2. Repo-side preflight (safe in any checkout)

```powershell
pwsh -NoProfile -File scripts/check-ao-operator-upgrade-preflight.ps1
```

### 3. Target spawn `--help` confirms `--name` contract

Run against the **target** binary once installed (or a throwaway test install):

```bash
BIN=ao
$BIN spawn --help | grep -E -- '--name|--project'
```

Expect both flags documented. Missing `--name` → **abort**; do not point live
`PATH` at that binary.

### 4. Review selector unchanged

```powershell
pwsh -NoProfile -File scripts/show-pack-reviewer-status.ps1
```

Confirm:

- Live **`REVIEW_COMMAND`** dispatches `scripts/invoke-pack-review.ps1` (see
  `agent-orchestrator.yaml.example`).
- Effective **`PACK_REVIEWER`** is `codex` or `claude` — not unset.
- Live yaml has **no** top-level `reviewer:` block and **no** typed `reviewers:`
  project config relied on by pack scripts.

See [`docs/reviewer-switch-runbook.md`](reviewer-switch-runbook.md).

### 5. Output-shape compatibility sweep (#223 / draft 76)

The pack parses AO CLI JSON in trigger tests and review/reconcile paths. A
two-minor jump can break wrappers even when `ao --version` looks healthy.

**Minimum commands to capture against the target AO binary** (scrub secrets/ids
before commit):

| Command | Variant reference family |
|---------|-------------------------|
| `ao review list <project> --json` | `tests/external-output-references/variants/ao-review-run/` |
| `ao status --json --reports full` | `tests/external-output-references/variants/ao-status-session/` |
| Review/reconcile-path captures used by spawn-budget and seed-liveness suites | `tests/external-output-references/captures/` per-suite manifests |

**Sweep procedure:**

1. Install target AO in an isolated shell or operator staging path (not from a
   managed worker session).
2. Capture redacted JSON for each row above; compare field shapes to the
   anchored variants under `tests/external-output-references/`.
3. Refresh captures when shapes are compatible but version-stale:

   ```bash
   # After updating scrubbed *.json under tests/external-output-references/captures/
   node scripts/generate-capture-manifest.mjs --repo-root .
   ```

4. Run guards:

   ```powershell
   pwsh -NoProfile -File scripts/check-external-output-shape-guard.ps1
   npx vitest run scripts/external-output-shape-guard.test.ts
   ```

5. **Drift policy:** if the target AO emits fields no variant allows, or drops
   required fields pack scripts parse, **block the live upgrade** and open a
   follow-up issue to adopt fixtures/checks first. Do not weaken the guard to
   force an upgrade.

## Rollback and abort path

### Before changing anything — capture baseline

```bash
command -v ao
ao --version          # expect 0.9.5 today
type ao               # npm global vs pack shim vs .deb path
npm list -g @aoagents/ao 2>/dev/null || true
```

Record the install method (npm global, `.deb`, AppImage, etc.) in your operator
notes.

### Known-good 0.9.5 reinstall (npm path)

```bash
npm install -g @aoagents/ao@0.9.5
ao --version
```

For `.deb` rollback, keep the previously installed package or re-fetch the last
known 0.9.5 asset from GitHub release history if you used a package install.

### Abort triggers

Stop and **do not** point production `PATH` at the new binary when:

- GitHub asset size or AppImage sha512 mismatch
- spawn `--help` output missing `--name` / `--project`
- Output-shape sweep fails or shows unparsed drift
- `PACK_REVIEWER` / `REVIEW_COMMAND` no longer resolves (fail-closed selector)
- Post-upgrade verification below fails

### After a failed upgrade

1. Reinstall or repoint `PATH` to the captured 0.9.5 binary.
2. Operator restart: `ao stop` then `ao start <project>` (operator terminal
   only — not from managed sessions).
3. Rerun pack checks:

   ```powershell
   pwsh -NoProfile -File scripts/verify.ps1
   pwsh -NoProfile -File scripts/check-reusable.ps1
   ```

## Live operator post-merge checklist

> **Operator work only — not CI acceptance.** Complete after this runbook merges
> to `main`.

- [ ] Merge pack PR for Issue #590 and pull `main` in the **operator** checkout
      (not only the AO worktree).
- [ ] Re-run release/npm fact checks if more than a few days passed since merge.
- [ ] Confirm Issue #589 adoption steps in
      [`docs/migration_notes.md`](migration_notes.md) are done on live yaml.
- [ ] Run `pwsh -NoProfile -File scripts/check-ao-operator-upgrade-preflight.ps1`.
- [ ] Install **v0.10.2** (or newer stable) via GitHub asset; acknowledge missing
      `.deb`/`.rpm` checksums if using those formats.
- [ ] Verify through the **pack-resolved** command path:

  ```bash
  ao --version    # expect 0.10.2+
  BIN=ao
  $BIN spawn --help | grep -E -- '--name|--project'
  ```

- [ ] Run the **output-shape sweep** (§5) against the live binary; adopt fixture
      drift in a follow-up PR if needed before relying on autonomous review/spawn.
- [ ] Operator restart AO: `ao stop` / `ao start orchestrator-pack` (or your
      project name).
- [ ] `pwsh -NoProfile -File scripts/show-pack-reviewer-status.ps1` — effective
      reviewer matches intent.
- [ ] **Stale-session smoke** (bounded; do not disrupt real work):
      - Kill a disposable test worker session; confirm one-shot restore markers
        behave per upstream PR #2320 (no stale resurrection).
      - Restart AO while a harmless test session is alive; confirm upgrade-safe
        adoption per upstream PR #2350 (alive sessions survive; truly dead
        sessions stay dead).
- [ ] `pwsh -NoProfile -File scripts/verify.ps1` on the operator pack checkout.

## Related docs

- [`docs/migration_notes.md`](migration_notes.md) — § Issue #589 spawn shape, §
  Issue #590 adoption summary
- [`docs/ubuntu-setup-runbook.md`](ubuntu-setup-runbook.md) — first-time Linux/WSL2
  setup (npm prefix, `PATH`)
- [`docs/reviewer-switch-runbook.md`](reviewer-switch-runbook.md) —
  `PACK_REVIEWER` / `REVIEW_COMMAND`
- [`docs/issues_drafts/76-golden-sample-fixtures-field-shape-guard.md`](issues_drafts/76-golden-sample-fixtures-field-shape-guard.md)
  — field-shape guard design (#223)
- [`README.md`](../README.md) — pack overview and verification commands

## Historical naming note

Older pack docs reference `ComposioHQ/agent-orchestrator`. Upstream stable
releases for this upgrade live under **`AgentWrapper/agent-orchestrator`**. If
an old bookmark 404s, use the AgentWrapper repository for release assets and
tags.
