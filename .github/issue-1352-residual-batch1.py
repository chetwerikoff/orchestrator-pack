from pathlib import Path


def replace_exact(path: str, old: str, new: str, count: int = 1) -> None:
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    actual = text.count(old)
    if actual != count:
        raise SystemExit(f'{path}: expected {count} occurrence(s) of {old!r}, got {actual}')
    p.write_text(text.replace(old, new), encoding='utf-8')


def replace_all(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    if old not in text:
        raise SystemExit(f'{path}: missing {old!r}')
    p.write_text(text.replace(old, new), encoding='utf-8')


replace_exact('scripts/lib/Review-CycleCap.ps1', """    if ($env:AO_PR_NUMBER) {
        [void][int]::TryParse([string]$env:AO_PR_NUMBER, [ref]$workerPr)
    }
    elseif ($env:GITHUB_PULL_REQUEST_NUMBER) {
""", """    if ($env:GITHUB_PULL_REQUEST_NUMBER) {
""")
replace_exact('scripts/lib/Review-CycleCap.ps1', """    # Per-PR declaration diff first — reconcile/reeval iterate many open PRs; AO_ISSUE_NUMBER
    # is the active worker session and must not override other PRs' tier budgets.
""", """    # Per-PR declaration/GitHub identity is authoritative; runtime/session state
    # must not override another PR's tier budget.
""")
replace_exact('scripts/lib/Review-CycleCap.ps1', """    if ($issueNumber -le 0 -and $env:AO_ISSUE_NUMBER) {
        $workerPr = Get-ReviewCycleCapWorkerPrNumber
        if ($workerPr -gt 0 -and $workerPr -eq $PrNumber) {
            [void][int]::TryParse([string]$env:AO_ISSUE_NUMBER, [ref]$issueNumber)
        }
    }

""", '')
replace_exact('scripts/orchestrator-review-start-preflight.ps1', '@($env:OPK_REVIEW_START_PR_NUMBER, $env:AO_PR_NUMBER)', '@($env:OPK_REVIEW_START_PR_NUMBER)')
replace_exact('scripts/orchestrator-review-start-preflight.ps1', '@($env:OPK_REVIEW_START_HEAD_SHA, $env:AO_PR_HEAD_SHA, $env:AO_HEAD_SHA)', '@($env:OPK_REVIEW_START_HEAD_SHA)')
replace_exact('scripts/orchestrator-wake-common.ps1', """    $fromEnv = $env:AO_ORCHESTRATOR_SESSION_ID
    if ($fromEnv) { return $fromEnv.Trim() }
    throw 'Orchestrator session id required: -OrchestratorSessionId or AO_ORCHESTRATOR_SESSION_ID'
""", """    throw 'Orchestrator session id required: pass -OrchestratorSessionId explicitly'
""")
replace_exact('scripts/wait-orchestrator-launch.ps1', "$orchId = if ($env:AO_ORCHESTRATOR_SESSION_ID) { $env:AO_ORCHESTRATOR_SESSION_ID.Trim() } else { 'op-orchestrator' }", "$orchId = 'op-orchestrator'")
replace_exact('scripts/orchestrator-worktree-preflight.ps1', 'List stale orchestrator/* branches and AO worktrees before ao start (Issue #91).', 'List stale orchestrator/* branches and owned worktrees before runtime start (Issue #91).')
replace_exact('scripts/orchestrator-worktree-preflight.ps1', 'the AO worktree directory (orchestrator namespace only).', 'the owned worktree directory (orchestrator namespace only).')
replace_exact('scripts/orchestrator-worktree-preflight.ps1', "$orchId = if ($env:AO_ORCHESTRATOR_SESSION_ID) { $env:AO_ORCHESTRATOR_SESSION_ID.Trim() } else { 'op-orchestrator' }", "$orchId = 'op-orchestrator'")
replace_exact('scripts/orchestrator-worktree-preflight.ps1', 'run cleanup before ao start if spawn shows branch_collision', 'run cleanup before runtime start if spawn shows branch_collision')
replace_exact('scripts/orchestrator-worktree-preflight.ps1', 'verify with git worktree list and ao start.', 'verify with git worktree list and the runtime adapter start path.')
replace_exact('scripts/lib/Orchestrator-Escalation.ps1', "$session = if ($OrchestratorSessionId) { $OrchestratorSessionId } elseif ($env:AO_ORCHESTRATOR_SESSION_ID) { $env:AO_ORCHESTRATOR_SESSION_ID } else { '' }", "$session = if ($OrchestratorSessionId) { $OrchestratorSessionId } else { '' }")
replace_exact('scripts/lib/gh-governor.mjs', """  if (env.AO_SESSION_ID && !child) {
    return 'interactive';
  }
""", '')
replace_exact('scripts/lib/worker-status-store.mjs', """      ?? env.AO_REPO_SLUG
      ?? env.GITHUB_REPOSITORY""", """      ?? env.GITHUB_REPOSITORY""")
replace_exact('scripts/lib/Orchestrator-SideProcessProgress.ps1', 'AO_SIDE_PROCESS_AO_LIVENESS_SHIM_DISABLED', 'OPK_SIDE_PROCESS_LIVENESS_SHIM_DISABLED')
replace_all('scripts/lib/Autonomous-GateCommon.ps1', 'Get-AoArgvSubcommand', 'Get-RuntimeArgvSubcommand')
replace_all('scripts/lib/Orchestrator-AutonomousSpawnGate.ps1', 'Get-AoArgvSubcommand', 'Get-RuntimeArgvSubcommand')
replace_all('scripts/lib/Invoke-WorkerMessageSendAdoptionPreflight.ps1', 'Invoke-AoSendProbeViaMessage', 'Invoke-WorkerMessageSendProbe')
replace_exact('scripts/lib/Journaled-WorkerSendInternalCapability.ps1', 'Process-bound journaled-worker-send internal ao send capabilities', 'Process-bound journaled-worker-send internal runtime send capabilities')
replace_all('scripts/lib/Journaled-WorkerSendInternalCapability.ps1', 'Invoke-AoSendViaMessage', 'Invoke-WorkerMessageViaCatalog')
replace_all('scripts/lib/Journaled-WorkerSendInternalCapability.ps1', 'Test-AoSendMessageContract', 'Test-WorkerMessageSendContract')
replace_all('scripts/orchestrator-message-catalog.json', 'Invoke-AoSendViaMessage', 'Invoke-WorkerMessageViaCatalog')
replace_all('scripts/orchestrator-message-send-helpers.manifest.json', 'Invoke-AoSendViaMessage', 'Invoke-WorkerMessageViaCatalog')
replace_exact('.claude/skills/merge-with-local-adoption/reap-worktree.mjs', 'ORCA_WORKTREE_ID', 'runtime worktree-id selector')
