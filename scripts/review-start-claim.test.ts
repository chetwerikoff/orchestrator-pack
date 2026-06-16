import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const helperPath = path.join(repoRoot, 'scripts/lib/Review-StartClaim.ps1');
const reevalInvokePath = path.join(repoRoot, 'scripts/lib/Invoke-ReviewTriggerReeval.ps1');
const wakeInvokePath = path.join(repoRoot, 'scripts/lib/Invoke-ReviewWakeTrigger.ps1');
const guardPath = path.join(repoRoot, 'scripts/check-review-start-claim-guard.ps1');
const fullSha = 'fd2fdb6600000000000000000000000000000000';

function runPwsh(script: string, extraEnv: Record<string, string> = {}) {
  const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
  if (result.status !== 0) {
    throw new Error(`pwsh failed ${result.status}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function tempClaimDir() {
  return mkdtempSync(path.join(tmpdir(), 'review-start-claim-'));
}

function psString(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function parsePwshRows(output: string) {
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed : [parsed];
}

describe('Review-StartClaim single-flight contract', () => {
  it('never leaves two active claim records for one key under overlapping acquisition', () => {
    const dir = tempClaimDir();
    try {
      const script = `
        $helper = ${psString(helperPath)}
        $ns = ${psString(dir)}
        $sha = ${psString(fullSha)}
        $null = 1..6 | ForEach-Object -Parallel {
          . $using:helper
          Acquire-ReviewStartClaim -PrNumber 307 -HeadSha $using:sha -Surface 'review-trigger-reconcile' -Namespace $using:ns -ReviewRuns @() | Out-Null
        } -ThrottleLimit 6
        $activePath = Join-Path $ns "pr-307-$sha.json"
        [pscustomobject]@{
          activeExists = (Test-Path -LiteralPath $activePath)
          activeCount = @((Get-ChildItem -LiteralPath $ns -File -Filter 'pr-307-*.json').Name).Count
        } | ConvertTo-Json -Compress
      `;
      const result = JSON.parse(runPwsh(script));
      expect(result.activeExists).toBe(true);
      expect(result.activeCount).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves one canonical store across differing cwd and side-process env', () => {
    const base = tempClaimDir();
    const sideA = mkdtempSync(path.join(tmpdir(), 'claim-side-a-'));
    const sideB = mkdtempSync(path.join(tmpdir(), 'claim-side-b-'));
    try {
      const runAcquire = (side: string, surface: string) =>
        JSON.parse(
          runPwsh(`
        . ${psString(helperPath)}
        $env:AO_BASE_DIR = ${psString(base)}
        $env:AO_SIDE_PROCESS_STATE_DIR = ${psString(side)}
        Set-Location ${psString(side)}
        $r = Acquire-ReviewStartClaim -PrNumber 307 -HeadSha ${psString(fullSha)} -Surface '${surface}' -ProjectId 'orchestrator-pack' -ReviewRuns @()
        [pscustomobject]@{ acquired=[bool]$r.acquired; reason=[string]$r.reason; namespace=(Resolve-ReviewStartClaimNamespace -ProjectId 'orchestrator-pack') } | ConvertTo-Json -Compress
      `),
        );
      const first = runAcquire(sideA, 'review-trigger-reconcile');
      const second = runAcquire(sideB, 'review-wake-trigger');
      const ns = first.namespace;
      const activeCount = JSON.parse(
        runPwsh(`
        [pscustomobject]@{ activeCount = @((Get-ChildItem -LiteralPath ${psString(ns)} -File -Filter 'pr-307-*.json').Name).Count } | ConvertTo-Json -Compress
      `),
      ).activeCount;
      expect(ns).toContain(path.join('projects', 'orchestrator-pack', 'review-start-claims'));
      expect([first, second].filter((r) => r.acquired)).toHaveLength(1);
      expect([first, second].filter((r) => !r.acquired)).toHaveLength(1);
      expect(activeCount).toBe(1);
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(sideA, { recursive: true, force: true });
      rmSync(sideB, { recursive: true, force: true });
    }
  });

  it('replays PR #307 incident timing with one reconcile winner', () => {
    const dir = tempClaimDir();
    const incidentSha = 'b4ed8d8000000000000000000000000000000000';
    try {
      const script = `
        . ${psString(helperPath)}
        $ns = ${psString(dir)}
        $sha = ${psString(incidentSha)}
        $first = Acquire-ReviewStartClaim -PrNumber 307 -HeadSha $sha -Surface 'review-trigger-reconcile' -Namespace $ns -ReviewRuns @()
        Start-Sleep -Milliseconds 2500
        $second = Acquire-ReviewStartClaim -PrNumber 307 -HeadSha $sha -Surface 'review-trigger-reconcile' -Namespace $ns -ReviewRuns @()
        [pscustomobject]@{
          firstAcquired = [bool]$first.acquired
          secondAcquired = [bool]$second.acquired
          loserReason = [string]$second.reason
          activeCount = @((Get-ChildItem -LiteralPath $ns -File -Filter 'pr-307-*.json').Name).Count
        } | ConvertTo-Json -Compress
      `;
      const result = JSON.parse(runPwsh(script));
      expect(result.firstAcquired).toBe(true);
      expect(result.secondAcquired).toBe(false);
      expect(result.loserReason).toBe('claimed');
      expect(result.activeCount).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('releases a held claim after the dead-run reaper terminalizes the run', () => {
    const dir = tempClaimDir();
    const sha = fullSha;
    try {
      const script = `
        . ${psString(helperPath)}
        $ns = ${psString(dir)}
        $claim = Acquire-ReviewStartClaim -PrNumber 266 -HeadSha ${psString(sha)} -Surface 'review-trigger-reconcile' -Namespace $ns -ReviewRuns @()
        Bind-ReviewStartClaimToVisibleRun -ClaimResult $claim -ReviewRuns @(@{ id='opk-rev-314'; prNumber=266; targetSha=${psString(sha)}; status='running' }) | Out-Null
        $release = Release-ReviewStartClaimForTerminalizedRun -PrNumber 266 -HeadSha ${psString(sha)} -Namespace $ns -RunId 'opk-rev-314' -RunCreatedAtUtc '2026-06-13T00:00:00.000Z'
        $retry = Acquire-ReviewStartClaim -PrNumber 266 -HeadSha ${psString(sha)} -Surface 'review-trigger-reeval' -Namespace $ns -ReviewRuns @()
        [pscustomobject]@{
          held = [bool]$claim.acquired
          release = @{ ok=[bool]$release.ok; reason=[string]$release.reason }
          retry = @{ acquired=[bool]$retry.acquired }
          activeExists = Test-Path -LiteralPath (Get-ReviewStartClaimPath -Namespace $ns -PrNumber 266 -HeadSha ${psString(sha)})
          terminal = @((Get-ChildItem -LiteralPath (Get-ReviewStartClaimTerminalDir -Namespace $ns) -Filter '*released_after_run_terminalized*.json').Name)
        } | ConvertTo-Json -Compress -Depth 6
      `;
      const result = JSON.parse(runPwsh(script));
      expect(result.held).toBe(true);
      expect(result.release.ok).toBe(true);
      expect(result.retry.acquired).toBe(true);
      expect(result.terminal).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not release a newer reacquired claim when an older run is terminalized', () => {
    const dir = tempClaimDir();
    const sha = fullSha;
    try {
      const script = `
        . ${psString(helperPath)}
        $ns = ${psString(dir)}
        $sha = ${psString(sha)}
        $old = Acquire-ReviewStartClaim -PrNumber 266 -HeadSha $sha -Surface 'review-trigger-reconcile' -Namespace $ns -ReviewRuns @()
        Bind-ReviewStartClaimToVisibleRun -ClaimResult $old -ReviewRuns @(@{ id='opk-rev-old'; prNumber=266; targetSha=$sha; status='running' }) | Out-Null
        $record = Read-ReviewStartClaimRecord -Path $old.path
        $record.record.acquiredAtUtc = (Get-Date).ToUniversalTime().AddMinutes(-30).ToString('o')
        ($record.record | ConvertTo-Json -Compress -Depth 20) | Set-Content -LiteralPath $old.path -Encoding UTF8
        $env:AO_REVIEW_CLAIM_STALE_MINUTES = '2'
        $fresh = Acquire-ReviewStartClaim -PrNumber 266 -HeadSha $sha -Surface 'review-trigger-reeval' -Namespace $ns -ReviewRuns @()
        $release = Release-ReviewStartClaimForTerminalizedRun -PrNumber 266 -HeadSha $sha -Namespace $ns -RunId 'opk-rev-old' -RunCreatedAtUtc '2026-06-13T00:00:00.000Z'
        [pscustomobject]@{
          freshAcquired = [bool]$fresh.acquired
          release = @{ ok=[bool]$release.ok; reason=[string]$release.reason }
          activeHolder = Format-ReviewStartClaimHolder -Holder $fresh.claim.holder
          activeExists = Test-Path -LiteralPath (Get-ReviewStartClaimPath -Namespace $ns -PrNumber 266 -HeadSha $sha)
        } | ConvertTo-Json -Compress -Depth 6
      `;
      const result = JSON.parse(runPwsh(script));
      expect(result.freshAcquired).toBe(true);
      expect(result.release.ok).toBe(false);
      expect(result.release.reason).toBe('superseded_claim');
      expect(result.activeExists).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('races three automated surfaces on the incident PR/head and produces one winner plus attributable claim skips', () => {
    const dir = tempClaimDir();
    try {
      const script = `
        $helper = ${psString(helperPath)}
        $ns = ${psString(dir)}
        $sha = ${psString(fullSha)}
        $surfaces = @('review-trigger-reeval','review-trigger-reconcile','review-wake-trigger')
        $rows = @($surfaces | ForEach-Object -Parallel {
          . $using:helper
          $surface = $_
          $r = Acquire-ReviewStartClaim -PrNumber 266 -HeadSha $using:sha -Surface $surface -Namespace $using:ns -ReviewRuns @()
          [pscustomobject]@{
            surface = $surface
            acquired = [bool]$r.acquired
            reason = [string]$r.reason
            holder = if ($r.holder) { Format-ReviewStartClaimHolder -Holder $r.holder } else { '' }
            key = [string]$r.key
          }
        } -ThrottleLimit 3)
        [pscustomobject]@{
          rows = $rows
          activeCount = @((Get-ChildItem -LiteralPath $ns -File -Filter 'pr-266-*.json').Name).Count
        } | ConvertTo-Json -Compress -Depth 6
      `;
      const result = JSON.parse(runPwsh(script));
      const rows = parsePwshRows(JSON.stringify(result.rows));
      expect(rows.filter((r: any) => r.acquired)).toHaveLength(1);
      const losers = rows.filter((r: any) => !r.acquired);
      expect(losers).toHaveLength(2);
      expect(losers.every((r: any) => r.reason === 'claimed')).toBe(true);
      expect(losers.every((r: any) => String(r.holder).includes('processGuid='))).toBe(true);
      expect(new Set(rows.map((r: any) => r.key))).toEqual(new Set([`pr-266-${fullSha}`]));
      expect(result.activeCount).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recovers one stale crashed claimant under concurrent recoverers and keeps an audit record', () => {
    const dir = tempClaimDir();
    try {
      const script = `
        . ${psString(helperPath)}
        $ns = ${psString(dir)}
        $sha = ${psString(fullSha)}
        Initialize-ReviewStartClaimNamespace -Namespace $ns
        $record = New-ReviewStartClaimActiveRecord -PrNumber 266 -HeadSha $sha -Surface 'crashed-starter' -Reason 'fixture'
        $record.acquiredAtUtc = (Get-Date).ToUniversalTime().AddMinutes(-30).ToString('o')
        Write-ReviewStartClaimAtomic -Path (Get-ReviewStartClaimPath -Namespace $ns -PrNumber 266 -HeadSha $sha) -Record $record
        $env:AO_REVIEW_CLAIM_STALE_MINUTES = '2'
        $first = Acquire-ReviewStartClaim -PrNumber 266 -HeadSha $sha -Surface 'recoverer-a' -Namespace $ns -ReviewRuns @()
        $second = Acquire-ReviewStartClaim -PrNumber 266 -HeadSha $sha -Surface 'recoverer-b' -Namespace $ns -ReviewRuns @()
        [pscustomobject]@{
          first = @{ acquired=[bool]$first.acquired; recovered=[bool]$first.recovered; reason=[string]$first.reason }
          second = @{ acquired=[bool]$second.acquired; recovered=[bool]$second.recovered; reason=[string]$second.reason }
          terminal = @((Get-ChildItem -LiteralPath (Get-ReviewStartClaimTerminalDir -Namespace $ns) -Filter '*recovered_stale*.json').Name)
        } | ConvertTo-Json -Compress -Depth 6
      `;
      const result = JSON.parse(runPwsh(script));
      expect(result.first).toMatchObject({ acquired: true, recovered: true });
      expect(result.second).toMatchObject({ acquired: false, reason: 'claimed' });
      expect(result.terminal).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recovers a stale claim after abandoning a leftover mutex directory', () => {
    const dir = tempClaimDir();
    try {
      const output = runPwsh(`
        . ${psString(helperPath)}
        $ns = ${psString(dir)}
        $sha = ${psString(fullSha)}
        Initialize-ReviewStartClaimNamespace -Namespace $ns
        $record = New-ReviewStartClaimActiveRecord -PrNumber 266 -HeadSha $sha -Surface 'crashed-starter' -Reason 'fixture'
        $record.acquiredAtUtc = (Get-Date).ToUniversalTime().AddMinutes(-30).ToString('o')
        $path = Get-ReviewStartClaimPath -Namespace $ns -PrNumber 266 -HeadSha $sha
        Write-ReviewStartClaimAtomic -Path $path -Record $record
        $lockDir = Get-ReviewStartClaimLockDir -Namespace $ns -PrNumber 266 -HeadSha $sha
        New-Item -ItemType Directory -Path $lockDir -Force | Out-Null
        [System.IO.Directory]::SetLastWriteTimeUtc($lockDir, (Get-Date).ToUniversalTime().AddMinutes(-10))
        $env:AO_REVIEW_CLAIM_MUTEX_STALE_SECONDS = '1'
        $result = Acquire-ReviewStartClaim -PrNumber 266 -HeadSha $sha -Surface 'recoverer' -Namespace $ns -ReviewRuns @()
        [pscustomobject]@{
          acquired = [bool]$result.acquired
          recovered = [bool]$result.recovered
          reason = [string]$result.reason
          terminal = @((Get-ChildItem -LiteralPath (Get-ReviewStartClaimTerminalDir -Namespace $ns) -Filter '*recovered_stale*.json').Name)
          lockExists = Test-Path -LiteralPath $lockDir
        } | ConvertTo-Json -Compress
      `);
      const result = JSON.parse(output);
      expect(result.acquired).toBe(true);
      expect(result.recovered).toBe(true);
      expect(result.terminal).toHaveLength(1);
      expect(result.lockExists).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows recovery again when a previously recovered claim goes stale and its terminal record remains', () => {
    const dir = tempClaimDir();
    try {
      const output = runPwsh(`
        . ${psString(helperPath)}
        $ns = ${psString(dir)}
        $sha = ${psString(fullSha)}
        Initialize-ReviewStartClaimNamespace -Namespace $ns
        $record = New-ReviewStartClaimActiveRecord -PrNumber 266 -HeadSha $sha -Surface 'crashed-starter' -Reason 'fixture'
        $record.acquiredAtUtc = (Get-Date).ToUniversalTime().AddMinutes(-30).ToString('o')
        Write-ReviewStartClaimAtomic -Path (Get-ReviewStartClaimPath -Namespace $ns -PrNumber 266 -HeadSha $sha) -Record $record
        $env:AO_REVIEW_CLAIM_STALE_MINUTES = '2'
        $first = Acquire-ReviewStartClaim -PrNumber 266 -HeadSha $sha -Surface 'recoverer-a' -Namespace $ns -ReviewRuns @()
        $firstPath = Get-ReviewStartClaimPath -Namespace $ns -PrNumber 266 -HeadSha $sha
        $fresh = Read-ReviewStartClaimRecord -Path $firstPath
        $fresh.record.acquiredAtUtc = (Get-Date).ToUniversalTime().AddMinutes(-30).ToString('o')
        ($fresh.record | ConvertTo-Json -Compress -Depth 20) | Set-Content -LiteralPath $firstPath -Encoding UTF8
        $second = Acquire-ReviewStartClaim -PrNumber 266 -HeadSha $sha -Surface 'recoverer-b' -Namespace $ns -ReviewRuns @()
        [pscustomobject]@{
          first = @{ acquired=[bool]$first.acquired; recovered=[bool]$first.recovered }
          second = @{ acquired=[bool]$second.acquired; recovered=[bool]$second.recovered; reason=[string]$second.reason }
          terminal = @((Get-ChildItem -LiteralPath (Get-ReviewStartClaimTerminalDir -Namespace $ns) -Filter '*recovered_stale*.json').Name)
        } | ConvertTo-Json -Compress -Depth 6
      `);
      const result = JSON.parse(output);
      expect(result.first).toMatchObject({ acquired: true, recovered: true });
      expect(result.second).toMatchObject({ acquired: true, recovered: true });
      expect(result.terminal.length).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed for ambiguous partial/unreadable records, divergent SHA forms, and anomalous timestamps', () => {
    const dir = tempClaimDir();
    try {
      const script = `
        . ${psString(helperPath)}
        $ns = ${psString(dir)}
        $sha = ${psString(fullSha)}
        Initialize-ReviewStartClaimNamespace -Namespace $ns
        $path = Get-ReviewStartClaimPath -Namespace $ns -PrNumber 266 -HeadSha $sha
        Set-Content -LiteralPath $path -Value '{' -Encoding UTF8
        $partial = Acquire-ReviewStartClaim -PrNumber 266 -HeadSha $sha -Surface 'review-wake-trigger' -Namespace $ns -ReviewRuns @()
        Remove-Item -LiteralPath $path -Force
        $future = New-ReviewStartClaimActiveRecord -PrNumber 266 -HeadSha $sha -Surface 'future' -Reason 'fixture'
        $future.acquiredAtUtc = (Get-Date).ToUniversalTime().AddDays(1).ToString('o')
        Write-ReviewStartClaimAtomic -Path $path -Record $future
        $futureResult = Acquire-ReviewStartClaim -PrNumber 266 -HeadSha $sha -Surface 'review-trigger-reeval' -Namespace $ns -ReviewRuns @()
        $short = Acquire-ReviewStartClaim -PrNumber 266 -HeadSha 'fd2fdb66' -Surface 'review-trigger-reconcile' -Namespace $ns -ReviewRuns @()
        [pscustomobject]@{
          partial = @{ acquired=[bool]$partial.acquired; escalation=[bool]$partial.escalation; reason=[string]$partial.reason; detail=[string]$partial.detail }
          future = @{ acquired=[bool]$futureResult.acquired; escalation=[bool]$futureResult.escalation; reason=[string]$futureResult.reason; detail=[string]$futureResult.detail }
          short = @{ acquired=[bool]$short.acquired; escalation=[bool]$short.escalation; reason=[string]$short.reason }
        } | ConvertTo-Json -Compress -Depth 6
      `;
      const result = JSON.parse(runPwsh(script));
      expect(result.partial).toMatchObject({ acquired: false, escalation: true, reason: 'ambiguous_claim' });
      expect(result.future).toMatchObject({ acquired: false, escalation: true, reason: 'ambiguous_claim' });
      expect(result.future.detail).toBe('future_timestamp');
      expect(result.short).toMatchObject({ acquired: false, escalation: true, reason: 'storage_failure' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the claim active across invocation lag, releases for retry after definitive failure, and supports operator resolution', () => {
    const dir = tempClaimDir();
    try {
      const script = `
        . ${psString(helperPath)}
        $ns = ${psString(dir)}
        $sha = ${psString(fullSha)}
        $claim = Acquire-ReviewStartClaim -PrNumber 266 -HeadSha $sha -Surface 'review-trigger-reconcile' -Namespace $ns -ReviewRuns @()
        $second = Acquire-ReviewStartClaim -PrNumber 266 -HeadSha $sha -Surface 'review-wake-trigger' -Namespace $ns -ReviewRuns @()
        $release = Release-ReviewStartClaimAfterRunFailure -ClaimResult $claim -ReviewRuns @() -Failure 'fixture non-zero'
        $retry = Acquire-ReviewStartClaim -PrNumber 266 -HeadSha $sha -Surface 'review-trigger-reeval' -Namespace $ns -ReviewRuns @()
        Complete-ReviewStartClaim -ClaimResult $retry -Outcome 'aborted_by_recheck' -ReviewRuns @() -Extra @{ reason='covered_after_claim' } | Out-Null
        $badPath = Get-ReviewStartClaimPath -Namespace $ns -PrNumber 266 -HeadSha $sha
        Set-Content -LiteralPath $badPath -Value '{' -Encoding UTF8
        $resolved = Resolve-ReviewStartClaimEscalation -PrNumber 266 -HeadSha $sha -Namespace $ns -ReviewRuns @(@{ prNumber=266; targetSha=$sha; status='queued' })
        [pscustomobject]@{
          second = @{ acquired=[bool]$second.acquired; reason=[string]$second.reason }
          release = @{ ok=[bool]$release.ok; outcome=[string]$release.outcome }
          retry = @{ acquired=[bool]$retry.acquired }
          resolved = $resolved
          activeExists = Test-Path -LiteralPath $badPath
        } | ConvertTo-Json -Compress -Depth 8
      `;
      const result = JSON.parse(runPwsh(script));
      expect(result.second).toMatchObject({ acquired: false, reason: 'claimed' });
      expect(result.release).toMatchObject({ ok: true, outcome: 'released_for_retry' });
      expect(result.retry).toMatchObject({ acquired: true });
      expect(result.resolved.outcome).toBe('operator_resolved_covered');
      expect(result.activeExists).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clamps unsafe recovery intervals with a visible warning', () => {
    const output = runPwsh(`
      . ${psString(helperPath)}
      $messages = @()
      $env:AO_REVIEW_CLAIM_STALE_MINUTES = '1'
      $minutes = Get-ReviewStartClaimStaleMinutes -LogWriter { param($m) $script:messages += $m }
      [pscustomobject]@{ minutes=$minutes; messages=$messages } | ConvertTo-Json -Compress
    `);
    const result = JSON.parse(output);
    expect(result.minutes).toBe(2);
    expect(result.messages.join('\n')).toContain('below safe floor');
  });

  it('binds claims to the in-flight covering run when older terminal runs are listed first', () => {
    const dir = tempClaimDir();
    const sha = fullSha;
    try {
      const script = `
        . ${psString(helperPath)}
        $ns = ${psString(dir)}
        $sha = ${psString(sha)}
        $claim = Acquire-ReviewStartClaim -PrNumber 266 -HeadSha $sha -Surface 'review-trigger-reconcile' -Namespace $ns -ReviewRuns @()
        $runs = @(
          @{ id = 'opk-rev-failed'; prNumber = 266; targetSha = $sha; status = 'failed'; createdAt = '2026-06-13T00:00:00.000Z' },
          @{ id = 'opk-rev-clean'; prNumber = 266; targetSha = $sha; status = 'clean'; createdAt = '2026-06-13T00:01:00.000Z' },
          @{ id = 'opk-rev-new'; prNumber = 266; targetSha = $sha; status = 'running'; createdAt = '2026-06-13T00:02:00.000Z' }
        )
        $visibleId = Get-ReviewStartClaimVisibleRunId -ReviewRuns $runs -PrNumber 266 -HeadSha $sha
        $bind = Bind-ReviewStartClaimToVisibleRun -ClaimResult $claim -ReviewRuns $runs
        $releaseOld = Release-ReviewStartClaimForTerminalizedRun -PrNumber 266 -HeadSha $sha -Namespace $ns -RunId 'opk-rev-failed' -RunCreatedAtUtc '2026-06-13T00:00:00.000Z'
        $releaseNew = Release-ReviewStartClaimForTerminalizedRun -PrNumber 266 -HeadSha $sha -Namespace $ns -RunId 'opk-rev-new' -RunCreatedAtUtc '2026-06-13T00:02:00.000Z'
        [pscustomobject]@{
          visibleId = [string]$visibleId
          boundRunId = [string]$bind.boundRunId
          releaseOld = @{ ok=[bool]$releaseOld.ok; reason=[string]$releaseOld.reason }
          releaseNew = @{ ok=[bool]$releaseNew.ok; reason=[string]$releaseNew.reason }
        } | ConvertTo-Json -Compress -Depth 6
      `;
      const result = JSON.parse(runPwsh(script));
      expect(result.visibleId).toBe('opk-rev-new');
      expect(result.boundRunId).toBe('opk-rev-new');
      expect(result.releaseOld).toMatchObject({ ok: false, reason: 'superseded_claim' });
      expect(result.releaseNew).toMatchObject({ ok: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats failed and cancelled runs as non-covering while covered statuses still count', () => {
    const output = runPwsh(`
      . ${psString(helperPath)}
      $sha = ${psString(fullSha)}
      $runs = @(
        @{ prNumber = 266; targetSha = $sha; status = 'failed' },
        @{ prNumber = 266; targetSha = $sha; status = 'cancelled' },
        @{ prNumber = 266; targetSha = $sha; status = 'running' }
      )
      [pscustomobject]@{
        visibleFailedOnly = (Test-ReviewStartClaimRunVisible -ReviewRuns @(@{ prNumber = 266; targetSha = $sha; status = 'failed' }) -PrNumber 266 -HeadSha $sha)
        visibleQueued = (Test-ReviewStartClaimRunVisible -ReviewRuns @(@{ prNumber = 266; targetSha = $sha; status = 'queued' }) -PrNumber 266 -HeadSha $sha)
        retryFailedOnly = (Test-ReviewStartClaimRetryEligible -ReviewRuns @(@{ prNumber = 266; targetSha = $sha; status = 'failed' }) -PrNumber 266 -HeadSha $sha)
        retryFailedPlusRunning = (Test-ReviewStartClaimRetryEligible -ReviewRuns $runs -PrNumber 266 -HeadSha $sha)
      } | ConvertTo-Json -Compress
    `);
    const result = JSON.parse(output);
    expect(result.visibleFailedOnly).toBe(false);
    expect(result.visibleQueued).toBe(true);
    expect(result.retryFailedOnly).toBe(true);
    expect(result.retryFailedPlusRunning).toBe(false);
  });

  it('does not release a claim for retry when a covering run is visible alongside a failed one', () => {
    const dir = tempClaimDir();
    try {
      const output = runPwsh(`
        . ${psString(helperPath)}
        $ns = ${psString(dir)}
        $sha = ${psString(fullSha)}
        $claim = Acquire-ReviewStartClaim -PrNumber 266 -HeadSha $sha -Surface 'review-trigger-reconcile' -Namespace $ns -ReviewRuns @()
        $result = Release-ReviewStartClaimAfterRunFailure -ClaimResult $claim -ReviewRuns @(
          @{ prNumber = 266; targetSha = $sha; status = 'failed' },
          @{ prNumber = 266; targetSha = $sha; status = 'running' }
        ) -Failure 'fixture non-zero'
        [pscustomobject]@{
          ok = [bool]$result.ok
          outcome = [string]$result.outcome
          reason = [string]$result.reason
          terminal = @((Get-ChildItem -LiteralPath (Get-ReviewStartClaimTerminalDir -Namespace $ns) -Filter '*escalated_ambiguous*.json').Name)
          activeExists = Test-Path -LiteralPath (Get-ReviewStartClaimPath -Namespace $ns -PrNumber 266 -HeadSha $sha)
        } | ConvertTo-Json -Compress
      `);
      const result = JSON.parse(output);
      expect(result.ok).toBe(true);
      expect(result.outcome).toBe('escalated_ambiguous');
      expect(result.terminal).toHaveLength(1);
      expect(result.activeExists).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('terminalizes a stale active claim once coverage appears later', () => {
    const dir = tempClaimDir();
    try {
      const output = runPwsh(`
        . ${psString(helperPath)}
        $ns = ${psString(dir)}
        $sha = ${psString(fullSha)}
        $claim = Acquire-ReviewStartClaim -PrNumber 266 -HeadSha $sha -Surface 'review-trigger-reconcile' -Namespace $ns -ReviewRuns @()
        $result = Acquire-ReviewStartClaim -PrNumber 266 -HeadSha $sha -Surface 'review-wake-trigger' -Namespace $ns -ReviewRuns @(
          @{ prNumber = 266; targetSha = $sha; status = 'clean' }
        )
        [pscustomobject]@{
          reason = [string]$result.reason
          terminal = @((Get-ChildItem -LiteralPath (Get-ReviewStartClaimTerminalDir -Namespace $ns) -Filter '*run_started*.json').Name)
          activeExists = Test-Path -LiteralPath (Get-ReviewStartClaimPath -Namespace $ns -PrNumber 266 -HeadSha $sha)
        } | ConvertTo-Json -Compress
      `);
      const result = JSON.parse(output);
      expect(result.reason).toBe('covered_by_run');
      expect(result.terminal).toHaveLength(1);
      expect(result.activeExists).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prunes terminal claim records with a bounded retention count', () => {
    const dir = tempClaimDir();
    try {
      const output = runPwsh(`
        . ${psString(helperPath)}
        $ns = ${psString(dir)}
        $env:AO_REVIEW_CLAIM_TERMINAL_COUNT = '1'
        Initialize-ReviewStartClaimNamespace -Namespace $ns
        $path1 = Join-Path (Get-ReviewStartClaimTerminalDir -Namespace $ns) 'one.json'
        $path2 = Join-Path (Get-ReviewStartClaimTerminalDir -Namespace $ns) 'two.json'
        Set-Content -LiteralPath $path1 -Value '{}' -Encoding UTF8
        Start-Sleep -Milliseconds 20
        Set-Content -LiteralPath $path2 -Value '{}' -Encoding UTF8
        Prune-ReviewStartClaimTerminalRecords -Namespace $ns
        [pscustomobject]@{
          names = @((Get-ChildItem -LiteralPath (Get-ReviewStartClaimTerminalDir -Namespace $ns) -File | Sort-Object Name | Select-Object -ExpandProperty Name))
        } | ConvertTo-Json -Compress
      `);
      const result = JSON.parse(output);
      expect(result.names).toEqual(['two.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('releases a held reeval claim when the in-claim recheck snapshot throws', () => {
    const dir = tempClaimDir();
    try {
      const script = `
        . ${psString(reevalInvokePath)}
        $ns = ${psString(dir)}
        $env:AO_REVIEW_CLAIM_DIR = $ns
        $sha = ${psString(fullSha)}
        $calls = 0
        try {
          $params = @{
            Action = @{ prNumber=266; headSha=$sha; sessionId='opk-52' }
            ReviewCommand = 'echo review'
            StateRoot = $ns
            ResolveFreshSnapshot = {
              param($planned)
              $script:calls++
              if ($script:calls -eq 1) {
                return @{ reviewRuns=@(); openPrs=@(); sessions=@(); ciChecksByPr=@{}; requiredCheckNamesByPr=@{}; requiredCheckLookupFailedByPr=@{} }
              }
              throw 'fresh snapshot exploded'
            }
            LogWriter = { param($m) }
          }
          Invoke-ReviewTriggerReevalPlannedRun @params | Out-Null
        }
        catch { }
        $path = Get-ReviewStartClaimPath -Namespace $env:AO_REVIEW_CLAIM_DIR -PrNumber 266 -HeadSha $sha
        $terminal = @((Get-ChildItem -LiteralPath (Get-ReviewStartClaimTerminalDir -Namespace $env:AO_REVIEW_CLAIM_DIR) -Filter '*released_for_retry*.json').Name)
        [pscustomobject]@{ activeExists=(Test-Path -LiteralPath $path); terminal=$terminal; calls=$calls } | ConvertTo-Json -Compress
      `;
      const result = JSON.parse(runPwsh(script));
      expect(result.calls).toBe(2);
      expect(result.activeExists).toBe(false);
      expect(result.terminal).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drops a reeval watch when a visible covering run is found under an existing claim', () => {
    const dir = tempClaimDir();
    try {
      const script = `
        . ${psString(reevalInvokePath)}
        $ns = ${psString(dir)}
        $env:AO_REVIEW_CLAIM_DIR = $ns
        $sha = ${psString(fullSha)}
        Acquire-ReviewStartClaim -PrNumber 266 -HeadSha $sha -Surface 'review-wake-trigger' -Namespace $ns -ReviewRuns @() | Out-Null
        $params = @{
          Action = @{ prNumber=266; headSha=$sha; sessionId='opk-52' }
          ReviewCommand = 'echo review'
          StateRoot = $ns
          ResolveFreshSnapshot = {
            param($planned)
            return @{ reviewRuns=@(@{ prNumber=266; targetSha=$sha; status='queued' }); openPrs=@(); sessions=@(); ciChecksByPr=@{}; requiredCheckNamesByPr=@{}; requiredCheckLookupFailedByPr=@{} }
          }
          LogWriter = { param($m) }
        }
        $result = Invoke-ReviewTriggerReevalPlannedRun @params
        $result | ConvertTo-Json -Compress
      `;
      const result = JSON.parse(runPwsh(script));
      expect(result.triggered).toBe(false);
      expect(result.reason).toBe('covered_by_run');
      expect(result.retainWatch).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses a fresh merge snapshot when a wake skips on a newly visible covered run', () => {
    const fixture = JSON.parse(
      readFileSync(path.join(repoRoot, 'tests/fixtures/review-wake-trigger/green-wake-triggers.json'), 'utf8'),
    );
    const wakeSha = 'cafe204000000000000000000000000000000000';
    const dir = tempClaimDir();
    try {
      const script = `
        . ${psString(wakeInvokePath)}
        $ns = ${psString(dir)}
        $env:AO_REVIEW_CLAIM_DIR = $ns
        $script:calls = 0
        function Invoke-GhOpenPrList { param([string]$RepoRoot) @(@{ number = 204; headRefOid = '${wakeSha}'; headCommittedAt = '${fixture.openPrs[0].headCommittedAt}' }) }
        function Get-AoStatusSessions { @(${fixture.sessions.map((session: any) => `@{ name = '${session.name}'; role = '${session.role}'; prNumber = ${session.prNumber}; status = '${session.status}'; reports = @(${session.reports.map((report: any) => `@{ reportState = '${report.reportState}'; reportedAt = '${report.reportedAt}' }`).join(',')}) }`).join(',')}) }
        function Get-GhChecksBundleByPr {
          param([string]$RepoRoot, [array]$OpenPrs, [scriptblock]$MergeRequiredNames, [string]$ProtectionLookupWarningTemplate)
          @{
            ciChecksByPr = @{
              '204' = @(${fixture.ciChecksByPr['204'].map((check: any) => `@{ name = '${check.name}'; state = '${check.state}' }`).join(',')})
            }
            requiredCheckNamesByPr = @{ '204' = @('Verify orchestrator-pack structure','PR scope guard','Run pack contract tests','Self-architect lint') }
            requiredCheckLookupFailedByPr = @{ '204' = $false }
          }
        }
        function Get-AoReviewRuns {
          param([string]$Project)
          $script:calls++
          if ($script:calls -eq 1) {
            return @()
          }
          return @(@{ prNumber = 204; targetSha = '${wakeSha}'; status = 'clean' })
        }
        $preClaim = Acquire-ReviewStartClaim -PrNumber 204 -HeadSha '${wakeSha}' -Surface 'other-surface' -Namespace $env:AO_REVIEW_CLAIM_DIR -ReviewRuns @()
        $result = Invoke-ReviewWakeTriggerOnCompletionWake -FilterResult @{
          ok = $true
          wakeKind = 'merge.ready'
          prNumber = 204
          sessionId = 'opk-11'
        } -ProjectId 'orchestrator-pack' -ReviewCommand 'echo review' -RepoRoot ${psString(repoRoot)} -StateRoot $ns -LogWriter { param([string]$Message) }
        [pscustomobject]@{
          triggered = $result.triggered
          reason = $result.reason
          mergeable = [bool]$result.mergeEval.mergeable
          mergeReason = [string]$result.mergeEval.reason
          calls = $script:calls
        } | ConvertTo-Json -Compress
      `;
      const result = JSON.parse(runPwsh(script));
      expect(result.triggered).toBe(false);
      expect(result.reason).toBe('claim_skipped');
      expect(result.mergeable).toBe(true);
      expect(result.mergeReason).toBe('covered_terminal_run');
      expect(result.calls).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('review-start claim drift guard', () => {
  it('passes shipped automated starter surfaces', () => {
    const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', guardPath, '-RepoRoot', repoRoot], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it('fails direct and indirect unclaimed automated review-run fixtures and governed noninteractive allowlist entries', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'claim-guard-fixture-'));
    try {
      mkdirSync(path.join(root, 'scripts/lib'), { recursive: true });
      writeFileSync(path.join(root, 'scripts/bad-direct.ps1'), "& ao review run opk-1 --execute --command 'x'\n");
      writeFileSync(path.join(root, 'scripts/lib/bad-helper.ps1'), "function Invoke-Bad { & ao @('review','run','opk-1','--execute','--command','x') }\n");
      writeFileSync(path.join(root, 'scripts/bad-indirect.ps1'), ". `$PSScriptRoot/lib/bad-helper.ps1\nInvoke-Bad\n");
      writeFileSync(path.join(root, 'scripts/manual.ps1'), "& ao review run opk-1 --execute --command 'x'\n");
      const allow = path.join(root, 'allow.json');
      writeFileSync(allow, JSON.stringify([{ path: 'scripts/manual.ps1', justification: 'fixture', interactiveOnly: false }]));
      const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', guardPath, '-RepoRoot', root, '-AllowlistPath', allow], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain('bad-direct.ps1');
      expect(result.stdout + result.stderr).toContain('bad-helper.ps1');
      expect(result.stdout + result.stderr).toContain('allowlist entry is not interactive-only');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('incident capture fixtures', () => {
  it('keeps redacted production-shaped PR #266 incident captures in the repo', () => {
    const list = JSON.parse(readFileSync(path.join(repoRoot, 'tests/fixtures/review-start-claim/incident-pr266-review-list.json'), 'utf8'));
    const watch = JSON.parse(readFileSync(path.join(repoRoot, 'tests/fixtures/review-start-claim/incident-pr266-reeval-watch.json'), 'utf8'));
    expect(list.every((run: any) => run.prNumber !== 266 || run.targetSha !== fullSha)).toBe(true);
    expect(watch['266:fd2fdb66']?.headSha).toBe(fullSha);
    expect(watch['266:fd2fdb66']?.source).toBe('wake_defer');
  });
});
