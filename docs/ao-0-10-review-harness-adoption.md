# AO 0.10 review harness and trigger adoption (Issue #623)

Operator steps to re-enable pack-driven code review on AO **0.10.x** after merge.
This complements [`ao-0-10-operator-upgrade-runbook.md`](ao-0-10-operator-upgrade-runbook.md).

## Prerequisite

- AO **0.10.x** daemon running (`ao status --json` shows `ready`).
- Issue **#589** spawn shape adopted.
- Pack PR for **#623** merged and pulled in the operator checkout.

## 1. Configure reviewer harness (project config API)

AO 0.10 selects the reviewer agent via typed `ProjectConfig.reviewers` — not
`REVIEW_COMMAND` / `--command` on `ao review run` (removed).

**Important (2026-07-07 incident):** use the raw project GET endpoint to verify
`reviewers`; `ao project get` hides `reviewers`, and `GET …/projects/{id}/config`
may be unavailable on some builds. Prefer:

```bash
curl -fsS "http://127.0.0.1:$(ao status --json | jq -r .port)/api/v1/projects/orchestrator-pack" \
  | jq '.config.reviewers // .reviewers'
```

Set harness with a **full config replace** only when you intend to overwrite the
entire project config. Partial `ao project set-config` JSON can clobber unrelated
keys (including `reviewers`):

```bash
ao project set-config orchestrator-pack --config-json '{"reviewers":[{"harness":"codex"}]}'
```

Verify:

```bash
curl -fsS "http://127.0.0.1:$(ao status --json | jq -r .port)/api/v1/projects/orchestrator-pack/config" | jq '.reviewers'
```

Expect `[{"harness":"codex"}]` (or your chosen harness: `claude-code` | `codex` | `opencode`).

Fixture shape: `tests/external-output-references/captures/ao-0-10-review-api/project-config.raw.json`.

## 2. Trigger loop (pack-owned)

The engine does **not** auto-trigger review. Pack sidecars call:

```http
POST /api/v1/sessions/{workerId}/reviews/trigger
```

Rebound entrypoints (after #623):

- `scripts/lib/Invoke-ReviewWakeTrigger.ps1` (wake listener)
- `scripts/review-trigger-reconcile.ps1`
- `scripts/review-trigger-reeval.ps1`

Anti-corruption shim for incremental script migration:

```powershell
pwsh -NoProfile -File scripts/ao-review.ps1 run <worker-session-id>
```

`ao-review send` and `ao-review execute` exit **non-zero** with `REMOVED` — delivery is automatic on `submit`.

## 3. Review-before-cleanup (lifecycle invariant)

Do **not** terminate a worker session or remove its worktree while
`GET /api/v1/sessions/{workerId}/reviews` shows `latestRun.status=running` for the
worker's current PR head.

Pack enforcement (Issue #623):

- `scripts/lib/Worker-Recovery.ps1` refuses `git worktree remove` when the gate blocks.
- Wait until the run reaches `complete`, `failed`, `delivered`, or is reaped per **#624**
  (`scripts/review-stuck-run-reaper.ps1` — supervised detection + recovery when
  upstream fail-stale surface exists; see
  [`orchestrator-recovery-runbook.md`](orchestrator-recovery-runbook.md#stuck-review-run-ao-010)).

Manual probe:

```bash
curl -fsS "http://127.0.0.1:$(ao status --json | jq -r .port)/api/v1/sessions/<workerId>/reviews" | jq '.reviews[].latestRun.status'
```

## 4. Start / verify wake-supervisor children

After harness config, restart sidecars so they pick up the trigger path:

```powershell
pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1
pwsh -NoProfile -File scripts/review-trigger-reconcile.ps1 -Once -DryRun
```

## 5. Smoke proof (operator terminal)

1. Ensure one worker PR is review-ready (#195 predicate) and the orchestrator LLM session is **idle** (no turn driving review).
2. Trigger script-side: `pwsh -NoProfile -File scripts/review-trigger-reconcile.ps1 -Once` (or completion wake via wake-listener on a ready head).
3. Confirm HTTP 201/200 and a `running` / `queued` latestRun via `ao-review list <session> --json`.
4. Manual operator fallback remains: `pwsh -NoProfile -File scripts/ao-review.ps1 run <worker-session-id>`.

Do **not** edit live `agent-orchestrator.yaml` from automation — harness adoption is operator-only.

## 6. Unified harness path — structured [Pn] findings (Issue #658)

After #658, the codex harness reviewer must run the pack JSONL bridge before
`ao review submit`:

```powershell
pwsh -NoProfile -File scripts/harness-review-bridge.ps1 `
  -RunId <review-run-id> `
  -RepoRoot . `
  -Base origin/main `
  -TrustedBaseRoot <trusted-pack-root>
```

Smoke proof: trigger a harness review, then confirm `latestRun.body` (and worker
auto-delivery) contains JSON with `[P0]`–`[P3]` titles — not prose `Finding:` /
`BLOCKING:` headings.

### Kill-switch (rollback)

Set `PACK_HARNESS_BRIDGE_DISABLED=1` before the harness reviewer turn. The bridge
aborts before mapper/submit (classified failure). Complete review manually:

```powershell
pwsh -NoProfile -File scripts/invoke-pack-review.ps1 --repo-root . --base origin/main
```

Then operator submits via the normal AO path. Do not rely on warn-only skip — the
bridge must fail closed.

### Unset reviewers trap

When `reviewers` is missing, AO defaults to `claude-code`. Pack trigger entry refuses
batch trigger until `reviewers:[{harness:codex}]` is configured (classified abort).

## Related

- Issue **#623** — harness + trigger loop
- Issue **#658** — harness bridge + [Pn] structured submit contract
- Issue **#624** — stuck `running` review-run reaper
- Issue **#619** — session identity readers
- Issues **#213–#215** — review producer contract and board consumers
- [`docs/reviewer-switch-runbook.md`](reviewer-switch-runbook.md) — legacy `PACK_REVIEWER` context (0.9 path)
