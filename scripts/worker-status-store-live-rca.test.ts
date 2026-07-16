import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  runProcess,
  runProcessSync,
  type ProcessResult,
  type RunProcessOptions,
} from './kernel/subprocess.ts';
import {
  loadWorkerStatusDetailPolicy,
  parsePrefixedJson,
  runWorkerStatusLiveRca,
  summarizeWorkerStatusStore,
} from '../tests/worker-status-store-live-rca.ts';

function result(stdout: string, ok = true): ProcessResult {
  return {
    outcome: 'exit',
    ok,
    exitCode: ok ? 0 : 1,
    signal: null,
    stdout,
    stderr: '',
    timedOut: false,
    cancelled: false,
  };
}

function commandKey(options: RunProcessOptions): string {
  return [options.command, ...(options.args ?? [])].join(' ');
}

function makeRunner(responses: Readonly<Record<string, ProcessResult>>) {
  return async (options: RunProcessOptions): Promise<ProcessResult> => {
    const key = commandKey(options);
    if (key.startsWith('sh -c ') || key.startsWith('pwsh -NoProfile -NonInteractive -Command ')) {
      return result('not-running');
    }
    return responses[key] ?? result('', false);
  };
}

function writeStores(dir: string): void {
  writeFileSync(join(dir, 'worker-status-store.json'), JSON.stringify({
    schemaVersion: 1,
    records: {
      redactedA: { winningSource: 'degraded', status: 'unknown', derivedStatus: 'unknown' },
      redactedB: { winningSource: 'degraded', status: 'unknown', derivedStatus: 'unknown' },
    },
  }));
  writeFileSync(join(dir, 'worker-report-store.json'), JSON.stringify({
    schemaVersion: 2,
    generation: 217,
    sourceRecords: {},
    bindingByKey: {},
  }));
}

describe('worker-status-store live RCA', () => {
  it('parses AO JSON after prefixed diagnostic lines', () => {
    expect(parsePrefixedJson('[ao] warming cache\n{"data":[]}', 'ao')).toEqual({ data: [] });
  });

  it('requires both a non-degraded source and an actionable status for semantic usability', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opk-854-summary-'));
    try {
      writeFileSync(join(dir, 'worker-status-store.json'), JSON.stringify({
        schemaVersion: 1,
        records: {
          degraded: { winningSource: 'degraded', status: 'unknown', derivedStatus: 'unknown' },
          missingSource: { status: 'working', derivedStatus: 'pr_open' },
          unknownStatus: { winningSource: 'github_pr', status: 'unknown', derivedStatus: 'unknown' },
          usable: { winningSource: 'os_liveness', status: 'dead', derivedStatus: 'dead' },
        },
      }));
      expect(summarizeWorkerStatusStore(join(dir, 'worker-status-store.json'))).toMatchObject({
        state: 'populated-mixed',
        rowCount: 4,
        degradedCount: 1,
        unusableCount: 3,
        usableCount: 1,
        winningSourceDistribution: {
          degraded: 1,
          missing: 1,
          github_pr: 1,
          os_liveness: 1,
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });


  it('keeps the shared runtime/probe policy below the supervised child stall budget', () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const policy = loadWorkerStatusDetailPolicy(join(repoRoot, 'scripts', 'worker-status-detail-policy.json'));
    const registry = JSON.parse(readFileSync(join(repoRoot, 'scripts', 'orchestrator-side-process-registry.json'), 'utf8')) as {
      children: Array<{ id: string; cadenceSeconds: number; stallGraceMultiplier: number }>;
    };
    const child = registry.children.find((entry) => entry.id === 'review-ready-report-state-seed');
    expect(child).toBeTruthy();
    const stallBudgetMs = (child?.cadenceSeconds ?? 0) * (child?.stallGraceMultiplier ?? 0) * 1000;
    expect(policy).toMatchObject({ maxCallsPerTick: 16, perCallTimeoutMs: 3000, globalDeadlineMs: 12000 });
    expect(policy.globalDeadlineMs).toBeLessThan(stallBudgetMs);
  });

  it('accepts detail policy schema version 1 and rejects missing or future versions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opk-854-policy-schema-'));
    try {
      const base = { maxCallsPerTick: 16, perCallTimeoutMs: 3000, globalDeadlineMs: 12000, postKillDrainMs: 250 };
      const validPath = join(dir, 'valid.json');
      const missingPath = join(dir, 'missing.json');
      const futurePath = join(dir, 'future.json');
      writeFileSync(validPath, JSON.stringify({ schemaVersion: 1, ...base }));
      writeFileSync(missingPath, JSON.stringify(base));
      writeFileSync(futurePath, JSON.stringify({ schemaVersion: 2, ...base }));
      expect(loadWorkerStatusDetailPolicy(validPath)).toMatchObject({ schemaVersion: 1, ...base });
      expect(() => loadWorkerStatusDetailPolicy(missingPath)).toThrow('worker-status detail policy schemaVersion must be 1');
      expect(() => loadWorkerStatusDetailPolicy(futurePath)).toThrow('worker-status detail policy schemaVersion must be 1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when a detail response exceeds the production timeout but would fit the old 15s probe window', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opk-854-runtime-timeout-parity-'));
    try {
      writeStores(dir);
      let observedTimeoutMs = 0;
      const simulatedDurationMs = 5000;
      const runner = async (options: RunProcessOptions): Promise<ProcessResult> => {
        const key = commandKey(options);
        if (key.startsWith('sh -c ') || key.startsWith('pwsh -NoProfile -NonInteractive -Command ')) {
          return result('not-running');
        }
        if (key === 'ao session ls --json -p orchestrator-pack --include-terminated') {
          return result(JSON.stringify({ data: [{
            id: 'slow-worker', role: 'worker', status: 'working', isTerminated: false, ownedHeadSha: 'slow-head',
          }] }));
        }
        if (key === 'gh pr list --state open --json number,headRefOid,headRefName,state --limit 200') {
          return result(JSON.stringify([{ number: 854, headRefOid: 'slow-head', headRefName: 'issue-854', state: 'OPEN' }]));
        }
        if (key === 'ao session get slow-worker --json -p orchestrator-pack') {
          observedTimeoutMs = options.timeoutMs ?? 0;
          if (observedTimeoutMs < simulatedDurationMs) {
            return {
              outcome: 'timeout', ok: false, exitCode: null, signal: null, stdout: '', stderr: '', timedOut: true, cancelled: false,
            };
          }
          return result(JSON.stringify({ session: { displayName: '854' } }));
        }
        return result('', false);
      };
      const observation = await runWorkerStatusLiveRca({ stateDir: dir, repoRoot: dir, runner });
      expect(observedTimeoutMs).toBe(3000);
      expect(observation.commands).toMatchObject({
        detailPolicyMatchesRuntime: true,
        detailFailureCount: 1,
        evidenceComplete: false,
      });
      expect(observation.closure).toMatchObject({ recommendedPath: 'undetermined' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('selects Path A through the shipped resolver when session-get restores numeric displayName', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opk-854-path-a-'));
    try {
      writeStores(dir);
      const runner = makeRunner({
        'ao session ls --json -p orchestrator-pack --include-terminated': result(JSON.stringify({
          data: [{
            id: 'secret-session-a',
            role: 'worker',
            status: 'working',
            isTerminated: false,
            ownedHeadSha: 'abc854',
          }],
        })),
        'ao session get secret-session-a --json -p orchestrator-pack': result(JSON.stringify({
          session: { displayName: '854' },
        })),
        'gh pr list --state open --json number,headRefOid,headRefName,state --limit 200': result(JSON.stringify([{
          number: 854,
          headRefOid: 'abc854',
          headRefName: 'issue-854-fix',
          state: 'OPEN',
        }])),
      });
      const observation = await runWorkerStatusLiveRca({
        stateDir: dir,
        repoRoot: dir,
        runner,
      });
      expect(observation.matrixCells).toContain('never-invoked-session-detail-enrichment');
      expect(observation.closure).toMatchObject({
        recommendedPath: 'A',
        usableRowPreconditionSatisfied: false,
        blockerCleared: false,
        migrationGateStatus: 'open',
        dependency: null,
      });
      expect(observation.bindingEvidence).toMatchObject({
        activeWorkerCount: 1,
        openPrCandidateCount: 1,
        listContractBindingCount: 0,
        enrichedContractBindingCount: 1,
        detailRecoveredCount: 1,
        unresolvedExistingContractCount: 0,
      });
      const serialized = JSON.stringify(observation);
      expect(serialized).not.toContain('secret-session-a');
      expect(serialized).not.toContain('abc854');
      expect(serialized).not.toContain(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses the shipped all-signals-must-corroborate rule instead of a looser probe copy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opk-854-contract-parity-'));
    try {
      writeStores(dir);
      const runner = makeRunner({
        'ao session ls --json -p orchestrator-pack --include-terminated': result(JSON.stringify({
          data: [{
            id: 'secret-session-mismatch',
            role: 'worker',
            status: 'working',
            isTerminated: false,
            issueNumber: 999,
            ownedHeadSha: 'abc854',
          }],
        })),
        'ao session get secret-session-mismatch --json -p orchestrator-pack': result(JSON.stringify({
          session: { displayName: '854' },
        })),
        'gh pr list --state open --json number,headRefOid,headRefName,state --limit 200': result(JSON.stringify([{
          number: 854,
          headRefOid: 'abc854',
          headRefName: 'issue-854-fix',
          state: 'OPEN',
        }])),
      });
      const observation = await runWorkerStatusLiveRca({ stateDir: dir, repoRoot: dir, runner });
      expect(observation.matrixCells).toContain('binding-contract-gap');
      expect(observation.matrixCells).not.toContain('never-invoked-session-detail-enrichment');
      expect(observation.closure).toMatchObject({
        recommendedPath: 'B',
        blockerCleared: false,
        dependency: 'docs/issues_drafts/291-pr-session-binding-contract.md',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('selects Path B only for an active worker correlated to an open PR but unresolved by the contract', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opk-854-path-b-'));
    try {
      writeStores(dir);
      const runner = makeRunner({
        'ao session ls --json -p orchestrator-pack --include-terminated': result(JSON.stringify({
          data: [
            {
              id: 'secret-session-b',
              role: 'worker',
              status: 'working',
              isTerminated: false,
              ownedHeadSha: 'def854',
            },
            {
              id: 'unrelated-worker',
              role: 'worker',
              status: 'working',
              isTerminated: false,
            },
            {
              id: 'old-terminated-worker',
              role: 'worker',
              status: 'terminated',
              isTerminated: true,
              ownedHeadSha: 'def854',
            },
          ],
        })),
        'ao session get secret-session-b --json -p orchestrator-pack': result(JSON.stringify({
          session: { displayName: 'worker-main' },
        })),
        'ao session get unrelated-worker --json -p orchestrator-pack': result(JSON.stringify({
          session: { displayName: 'unrelated-worker' },
        })),
        'gh pr list --state open --json number,headRefOid,headRefName,state --limit 200': result(JSON.stringify([{
          number: 854,
          headRefOid: 'def854',
          headRefName: 'unrelated-branch',
          state: 'OPEN',
        }])),
      });
      const observation = await runWorkerStatusLiveRca({ stateDir: dir, repoRoot: dir, runner });
      expect(observation.bindingEvidence).toMatchObject({
        activeWorkerCount: 2,
        openPrCandidateCount: 1,
        unresolvedExistingContractCount: 1,
      });
      expect(observation.matrixCells).toContain('binding-contract-gap');
      expect(observation.closure).toMatchObject({
        recommendedPath: 'B',
        blockerCleared: false,
        dependency: 'docs/issues_drafts/291-pr-session-binding-contract.md',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a worker bound to an open PR beyond the default 30-row gh page', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opk-854-open-pr-limit-'));
    try {
      writeStores(dir);
      const openPrs = Array.from({ length: 35 }, (_, index) => ({
        number: 1001 + index,
        headRefOid: `head-${1001 + index}`,
        headRefName: `issue-${1001 + index}`,
        state: 'OPEN',
      }));
      const relevant = openPrs[34];
      const runner = makeRunner({
        'ao session ls --json -p orchestrator-pack --include-terminated': result(JSON.stringify({
data: [{
  id: 'worker-beyond-default-page',
  role: 'worker',
  status: 'working',
  isTerminated: false,
  ownedHeadSha: relevant.headRefOid,
}],
        })),
        'ao session get worker-beyond-default-page --json -p orchestrator-pack': result(JSON.stringify({
session: { displayName: String(relevant.number) },
        })),
        'gh pr list --state open --json number,headRefOid,headRefName,state --limit 200': result(JSON.stringify(openPrs)),
      });
      const observation = await runWorkerStatusLiveRca({ stateDir: dir, repoRoot: dir, runner });
      expect(observation.commands).toMatchObject({
        ghOpenPrListOk: true,
        openPrLimit: 200,
        evidenceComplete: true,
      });
      expect(observation.bindingEvidence).toMatchObject({
        openPrCount: 35,
        openPrCandidateCount: 1,
        detailRecoveredCount: 1,
      });
      expect(observation.closure).toMatchObject({ recommendedPath: 'A' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stays undetermined when detail probing is truncated instead of fabricating Path B', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opk-854-detail-limit-'));
    try {
      writeStores(dir);
      const runner = makeRunner({
        'ao session ls --json -p orchestrator-pack --include-terminated': result(JSON.stringify({
          data: [
            { id: 'worker-a', role: 'worker', status: 'working', isTerminated: false, ownedHeadSha: 'aaa854' },
            { id: 'worker-b', role: 'worker', status: 'working', isTerminated: false, ownedHeadSha: 'bbb854' },
          ],
        })),
        'ao session get worker-a --json -p orchestrator-pack': result(JSON.stringify({
          session: { displayName: '854' },
        })),
        'gh pr list --state open --json number,headRefOid,headRefName,state --limit 200': result(JSON.stringify([
          { number: 854, headRefOid: 'aaa854', headRefName: 'issue-854-a', state: 'OPEN' },
          { number: 855, headRefOid: 'bbb854', headRefName: 'issue-855-b', state: 'OPEN' },
        ])),
      });
      const observation = await runWorkerStatusLiveRca({
        stateDir: dir,
        repoRoot: dir,
        runner,
        maxSessionDetails: 1,
      });
      expect(observation.commands).toMatchObject({
        detailEligibleCount: 2,
        detailAttemptCount: 1,
        detailSkippedByLimitCount: 1,
        evidenceComplete: false,
      });
      expect(observation.matrixCells).toContain('session-detail-probe-incomplete');
      expect(observation.closure).toMatchObject({ recommendedPath: 'undetermined' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const pwshAvailable = runProcessSync({
  command: 'pwsh',
  args: ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'],
  inheritParentEnv: true,
}).ok;

it.skipIf(!pwshAvailable)(
  'validates detail policy schema version identically in the PowerShell runtime',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opk-854-policy-runtime-'));
    try {
      const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
      const probe = join(dir, 'probe.ps1');
      writeFileSync(probe, `
param([string]$RepoRoot)
$ErrorActionPreference = 'Stop'
. (Join-Path $RepoRoot 'scripts/lib/Invoke-AoCliJson.ps1')
$base = @{ maxCallsPerTick = 16; perCallTimeoutMs = 3000; globalDeadlineMs = 12000; postKillDrainMs = 250 }
$valid = Get-WorkerStatusRefreshSessionDetailPolicy -Override (@{ schemaVersion = 1 } + $base)
$missing = try { [void](Get-WorkerStatusRefreshSessionDetailPolicy -Override $base); '' } catch { [string]$_.Exception.Message }
$future = try { [void](Get-WorkerStatusRefreshSessionDetailPolicy -Override (@{ schemaVersion = 2 } + $base)); '' } catch { [string]$_.Exception.Message }
[ordered]@{
  validSchemaVersion = [int]$valid.schemaVersion
  missing = $missing
  future = $future
} | ConvertTo-Json -Compress
`);
      const execution = await runProcess({
        command: 'pwsh',
        args: ['-NoProfile', '-NonInteractive', '-File', probe, '-RepoRoot', repoRoot],
        inheritParentEnv: true,
        timeoutMs: 30_000,
        allowEmptyStdout: false,
      });
      expect(execution.ok, `${execution.stderr}\n${execution.stdout}`).toBe(true);
      const jsonLine = execution.stdout.trim().split(/\r?\n/).reverse().find((line) => line.trim().startsWith('{'));
      const observation = JSON.parse(jsonLine ?? '{}');
      expect(observation).toEqual({
        validSchemaVersion: 1,
        missing: 'worker-status detail policy schemaVersion must be 1',
        future: 'worker-status detail policy schemaVersion must be 1',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

it.skipIf(!pwshAvailable)(
  'keeps session-detail enrichment refresh-only, bounded, and observable',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opk-854-refresh-boundary-'));
    try {
      const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
      const aoStub = join(dir, 'ao-stub.ps1');
      const probe = join(dir, 'probe.ps1');
      const reportStore = join(dir, 'worker-report-store.json');
      const invocationLog = join(dir, 'ao-invocations.log');
      writeFileSync(aoStub, `
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$RemainingArgs)
$mode = [string]$env:AO_PR856_TEST_MODE
$joined = $RemainingArgs -join ' '
Add-Content -LiteralPath $env:AO_PR856_TEST_LOG -Value "$mode|$joined"
if ($joined -match '^session ls ') {
  if ($mode -eq 'historical') {
    $rows = @()
    foreach ($n in 1..40) {
      $rows += [ordered]@{ id = "terminated-$n"; name = "terminated-$n"; sessionId = "terminated-$n"; role = 'worker'; projectId = 'orchestrator-pack'; status = 'terminated'; isTerminated = $true }
    }
    $rows += [ordered]@{ id = 'active-a'; name = 'active-a'; sessionId = 'active-a'; role = 'worker'; projectId = 'orchestrator-pack'; status = 'working'; isTerminated = $false }
    $rows += [ordered]@{ id = 'active-b'; name = 'active-b'; sessionId = 'active-b'; role = 'orchestrator'; projectId = 'orchestrator-pack'; status = 'working'; isTerminated = $false }
    [ordered]@{ data = $rows } | ConvertTo-Json -Compress -Depth 8
    exit 0
  }
  $id = if ($mode -eq 'timeout') { 'timeout-worker' } else { 'live-854' }
  [ordered]@{ data = @([ordered]@{ id = $id; name = $id; sessionId = $id; role = 'worker'; projectId = 'orchestrator-pack'; status = 'working'; isTerminated = $false }) } | ConvertTo-Json -Compress -Depth 8
  exit 0
}
if ($joined -match '^orchestrator ls ') {
  '{"data":[]}'
  exit 0
}
if ($joined -match '^session get ') {
  if ($mode -eq 'timeout') {
    Start-Sleep -Seconds 5
    '{"session":{"id":"timeout-worker","displayName":"999"}}'
    exit 0
  }
  $id = [string]$RemainingArgs[2]
  $display = switch ($id) {
    'active-a' { '901' }
    'active-b' { '902' }
    default { '854' }
  }
  [ordered]@{ session = [ordered]@{ id = $id; displayName = $display } } | ConvertTo-Json -Compress -Depth 5
  exit 0
}
throw "unexpected ao invocation: $joined"
`);
      writeFileSync(probe, `
param([string]$RepoRoot, [string]$AoStub, [string]$ReportStore, [string]$InvocationLog)
$ErrorActionPreference = 'Stop'
$env:AO_WORKER_REPORT_STORE = $ReportStore
$env:AO_PR856_TEST_LOG = $InvocationLog
Set-Content -LiteralPath $InvocationLog -Value ''
. (Join-Path $RepoRoot 'scripts/lib/Invoke-AoCliJson.ps1')

function Test-WorkerStatusKillSwitchActive { return $false }
function Test-WorkerStatusSiblingReadiness { return @{ ok = $true } }
function Merge-AoSessionRowsWithWorkerReportStore { param([object[]]$Sessions) return @($Sessions) }
function Merge-AoSessionRowsWithWorkerStatusStore { param([object[]]$Sessions) return @($Sessions) }
function Get-WorkerStatusWriterGenerationVector { param([string]$SessionId, [long]$RepoTickGeneration, $GithubSnapshot) return @{} }
function Get-WorkerOsLivenessMap {
  param([object[]]$Sessions)
  $map = @{}
  foreach ($session in @($Sessions)) {
    $id = Get-WorkerStatusRefreshSessionId -Session $session
    if ($id) { $map[$id] = @{ state = 'alive'; isAlive = $true } }
  }
  return $map
}
function Get-WorkerStatusRecomputeGithubSnapshot {
  param([string]$RepoRoot = '', [string]$Project = '', [object[]]$Sessions = @())
  $openPrs = @()
  foreach ($session in @($Sessions)) {
    $number = 0
    if ([int]::TryParse([string]$session.displayName, [ref]$number) -and $number -gt 0) {
      $openPrs += [pscustomobject]@{ number = $number; headRefOid = "head-$number"; headRefName = "issue-$number"; state = 'OPEN' }
    }
  }
  return @{
    openPrs = $openPrs
    reviewRuns = @()
    ciChecksByPr = @{}
    requiredCheckNamesByPr = @{}
    requiredCheckLookupFailedByPr = @{}
    repoRoot = $RepoRoot
    degraded = $false
  }
}
$Script:ResolvedDisplayNames = @()
function Resolve-WorkerStatusSessionBinding {
  param($Session, $GithubSnapshot, [int]$PrNumber = 0, [string]$HeadSha = '')
  $display = [string]$Session.displayName
  if ($display) { $Script:ResolvedDisplayNames += $display }
  $resolved = 1
  [void][int]::TryParse($display, [ref]$resolved)
  if ($resolved -le 0) { $resolved = 1 }
  return @{ ok = $true; prNumber = $resolved; headSha = "head-$resolved" }
}
function Update-WorkerStatusStoreStateLocked {
  param([string]$Path, [scriptblock]$Mutator, [long]$NowMs)
  return & $Mutator @{ schemaVersion = 1; generation = 0; records = @{} }
}
function Invoke-WorkerStatusStoreCli {
  param([string]$Subcommand, [hashtable]$Payload)
  if ($Subcommand -eq 'recompute') { return @{ ok = $true; reason = ''; store = $Payload.store } }
  throw "unexpected worker-status-store subcommand: $Subcommand"
}
function Invoke-WorkerStatusStoreEviction { return @{ removed = 0 } }
function Get-ModeSessionGetCount {
  param([string]$Mode)
  return @((Get-Content -LiteralPath $InvocationLog) | Where-Object { $_ -like "$Mode|session get *" }).Count
}

$env:AO_PR856_TEST_MODE = 'refresh'
$Script:ResolvedDisplayNames = @()
$refresh = Invoke-WorkerStatusRefresh -Project 'orchestrator-pack' -RepoSlug 'owner/repo' -AoCommand $AoStub -IncludeTerminated -StorePath $ReportStore
$refreshResolved = @($Script:ResolvedDisplayNames | Where-Object { $_ })

$env:AO_PR856_TEST_MODE = 'decision'
$decision = @(Get-WorkerStatusDecisionSessionsCore -Project 'orchestrator-pack' -RepoSlug 'owner/repo' -AoCommand $AoStub -IncludeTerminated)

$env:AO_PR856_TEST_MODE = 'historical'
$Script:ResolvedDisplayNames = @()
$historical = Invoke-WorkerStatusRefresh -Project 'orchestrator-pack' -RepoSlug 'owner/repo' -AoCommand $AoStub -IncludeTerminated -StorePath $ReportStore
$historicalResolved = @($Script:ResolvedDisplayNames | Where-Object { $_ })

$env:AO_PR856_TEST_MODE = 'timeout'
$Script:WorkerStatusRefreshSessionDetailTimeoutMs = 150
$watch = [System.Diagnostics.Stopwatch]::StartNew()
$timeout = Invoke-WorkerStatusRefresh -Project 'orchestrator-pack' -RepoSlug 'owner/repo' -AoCommand $AoStub -IncludeTerminated -StorePath $ReportStore
$watch.Stop()

[ordered]@{
  refresh = [ordered]@{
    detailEligibleCount = [int]$refresh.detailEligibleCount
    detailAttemptCount = [int]$refresh.detailAttemptCount
    detailSuccessCount = [int]$refresh.detailSuccessCount
    sessionGetCount = Get-ModeSessionGetCount -Mode 'refresh'
    resolvedDisplayNames = $refreshResolved
  }
  decision = [ordered]@{
    rowCount = $decision.Count
    sessionGetCount = Get-ModeSessionGetCount -Mode 'decision'
  }
  historical = [ordered]@{
    detailEligibleCount = [int]$historical.detailEligibleCount
    detailAttemptCount = [int]$historical.detailAttemptCount
    detailSkippedByLimitCount = [int]$historical.detailSkippedByLimitCount
    sessionGetCount = Get-ModeSessionGetCount -Mode 'historical'
    resolvedDisplayNames = $historicalResolved
  }
  timeout = [ordered]@{
    outcome = [string]$timeout.outcome
    reasonCode = [string]$timeout.reasonCode
    detailAttemptCount = [int]$timeout.detailAttemptCount
    detailFailureCount = [int]$timeout.detailFailureCount
    detailTimeoutCount = [int]$timeout.detailTimeoutCount
    sessionGetCount = Get-ModeSessionGetCount -Mode 'timeout'
    elapsedMs = [long]$watch.ElapsedMilliseconds
  }
} | ConvertTo-Json -Compress -Depth 8
`);
      const execution = await runProcess({
        command: 'pwsh',
        args: [
'-NoProfile',
'-NonInteractive',
'-File', probe,
'-RepoRoot', repoRoot,
'-AoStub', aoStub,
'-ReportStore', reportStore,
'-InvocationLog', invocationLog,
        ],
        inheritParentEnv: true,
        timeoutMs: 30_000,
        allowEmptyStdout: false,
      });
      expect(execution.ok, `${execution.stderr}\n${execution.stdout}`).toBe(true);
      const jsonLine = execution.stdout.trim().split(/\r?\n/).reverse().find((line) => line.trim().startsWith('{'));
      expect(jsonLine).toBeTruthy();
      const observation = JSON.parse(jsonLine ?? '{}');
      expect(observation.refresh).toMatchObject({
        detailEligibleCount: 1,
        detailAttemptCount: 1,
        detailSuccessCount: 1,
        sessionGetCount: 1,
        resolvedDisplayNames: ['854'],
      });
      expect(observation.decision).toEqual({ rowCount: 1, sessionGetCount: 0 });
      expect(observation.historical).toMatchObject({
        detailEligibleCount: 1,
        detailAttemptCount: 1,
        detailSkippedByLimitCount: 0,
        sessionGetCount: 1,
      });
      expect(observation.historical.resolvedDisplayNames).toEqual(['901']);
      expect(observation.timeout).toMatchObject({
        outcome: 'partial_failure',
        reasonCode: 'session_detail_lookup_timeout',
        detailAttemptCount: 1,
        detailFailureCount: 1,
        detailTimeoutCount: 1,
      });
      expect(observation.timeout.elapsedMs).toBeLessThan(5_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);


it.skipIf(!pwshAvailable)(
  'rotates the durable detail cursor and keeps supervised timeout progress fresh',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opk-854-detail-fairness-'));
    try {
      const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
      const probe = join(dir, 'probe.ps1');
      const cursorPath = join(dir, 'detail-cursor.json');
      const progressDir = join(dir, 'progress');
      writeFileSync(probe, `
param([string]$RepoRoot, [string]$CursorPath, [string]$ProgressDir)
$ErrorActionPreference = 'Stop'
. (Join-Path $RepoRoot 'scripts/lib/Invoke-AoCliJson.ps1')
. (Join-Path $RepoRoot 'scripts/lib/Review-ReadyReportStateSeedProgress.ps1')

$policy = @{ schemaVersion = 1; maxCallsPerTick = 16; perCallTimeoutMs = 3000; globalDeadlineMs = 12000; postKillDrainMs = 0 }
$eligible = @(
  foreach ($n in 1..20) {
    $id = 'worker-{0:D2}' -f $n
    [pscustomobject]@{ id = $id; name = $id; sessionId = $id; role = 'worker'; status = 'working'; isTerminated = $false; ownedHeadSha = "head-$id" }
  }
)
$attempted = [System.Collections.Generic.List[string]]::new()
$lookup = {
  param($SessionId, $Project, $AoCommand, $TimeoutMs, $DrainTimeoutMs)
  $attempted.Add([string]$SessionId)
  $number = [int]([string]$SessionId).Substring(7)
  return @{ ok = $true; timedOut = $false; reason = ''; displayName = [string](900 + $number); detail = '' }
}.GetNewClosure()
$firstDiagnostic = New-WorkerStatusRefreshDiagnostic -Owner 'test' -SessionCount $eligible.Count -NowMs 1
$firstRows = @(Add-WorkerStatusRefreshSessionDetails -Sessions $eligible -Project 'orchestrator-pack' -CursorPath $CursorPath -Diagnostic $firstDiagnostic -PolicyOverride $policy -DetailLookup $lookup)
$firstAttempted = @($attempted)
$attempted.Clear()
$secondDiagnostic = New-WorkerStatusRefreshDiagnostic -Owner 'test' -SessionCount $eligible.Count -NowMs 2
$secondRows = @(Add-WorkerStatusRefreshSessionDetails -Sessions $eligible -Project 'orchestrator-pack' -CursorPath $CursorPath -Diagnostic $secondDiagnostic -PolicyOverride $policy -DetailLookup $lookup)
$secondAttempted = @($attempted)

$clock = @{ now = [long]100000 }
$heartbeatTimes = [System.Collections.Generic.List[long]]::new()
$freshVerdicts = [System.Collections.Generic.List[bool]]::new()
$prior = $null
$env:AO_SIDE_PROCESS_PROGRESS_DIR = $ProgressDir
$writer = {
  param($Step)
  $env:AO_SIDE_PROCESS_NOW_MS = [string]$clock.now
  Write-OrchestratorSideProcessWorkHeartbeat -ChildId 'review-ready-report-state-seed' -Phase 'poll' -WorkStep ([string]$Step.WorkStep) -WorkCursor ([int]$Step.WorkCursor) -WorkTotal ([int]$Step.WorkTotal) -TickId 'detail-test'
  $current = Read-OrchestratorSideProcessProgress -ChildId 'review-ready-report-state-seed'
  $heartbeatTimes.Add([long]$current.lastProgressMs)
  $verdict = Get-OrchestratorSideProcessProgressFreshnessVerdict -Progress $current -PriorProgress $prior -ChildPid $PID -TickId 'detail-test' -NowMs ([long]$clock.now) -StallThresholdMs 20000 -ChildId 'review-ready-report-state-seed'
  $freshVerdicts.Add([bool]$verdict.Fresh)
  $prior = $current
}.GetNewClosure()
$timeoutLookup = {
  param($SessionId, $Project, $AoCommand, $TimeoutMs, $DrainTimeoutMs)
  $clock.now += [long]$TimeoutMs
  return @{ ok = $false; timedOut = $true; reason = 'session_detail_lookup_timeout'; displayName = ''; detail = 'timeout' }
}.GetNewClosure()
$nowProvider = { return [long]$clock.now }.GetNewClosure()
$slowRows = @($eligible | Select-Object -First 7)
$supervisedDiagnostic = New-WorkerStatusRefreshDiagnostic -Owner 'review-ready-report-state-seed' -SessionCount $slowRows.Count -NowMs 3
[void](Add-WorkerStatusRefreshSessionDetails -Sessions $slowRows -Project 'orchestrator-pack' -CursorPath (Join-Path (Split-Path -Parent $CursorPath) 'supervised-cursor.json') -Diagnostic $supervisedDiagnostic -PolicyOverride $policy -ProgressWriter $writer -DetailLookup $timeoutLookup -NowProvider $nowProvider)
$gaps = @()
for ($i = 1; $i -lt $heartbeatTimes.Count; $i++) { $gaps += ($heartbeatTimes[$i] - $heartbeatTimes[$i - 1]) }

[ordered]@{
  fairness = [ordered]@{
    first = $firstAttempted
    second = $secondAttempted
    unionCount = @($firstAttempted + $secondAttempted | Sort-Object -Unique).Count
    firstCursor = @([int]$firstDiagnostic.detailCursorStart, [int]$firstDiagnostic.detailCursorNext)
    secondCursor = @([int]$secondDiagnostic.detailCursorStart, [int]$secondDiagnostic.detailCursorNext)
    firstUsableCount = @($firstRows | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_.displayName) }).Count
    secondUsableCount = @($secondRows | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_.displayName) }).Count
    preservedFromFirstTick = @($secondRows | Where-Object { $_.id -in @('worker-13', 'worker-14', 'worker-15', 'worker-16') -and $_.displayName }).Count
    secondCacheHits = [int]$secondDiagnostic.detailCacheHitCount
  }
  supervised = [ordered]@{
    attempts = [int]$supervisedDiagnostic.detailAttemptCount
    deadlineReached = [bool]$supervisedDiagnostic.detailDeadlineReached
    skippedByDeadline = [int]$supervisedDiagnostic.detailSkippedByDeadlineCount
    elapsedMs = [long]$supervisedDiagnostic.detailElapsedMs
    maxHeartbeatGapMs = if ($gaps.Count -gt 0) { [long](($gaps | Measure-Object -Maximum).Maximum) } else { 0 }
    allFresh = -not ($freshVerdicts -contains $false)
    heartbeatCount = $heartbeatTimes.Count
  }
} | ConvertTo-Json -Compress -Depth 8
`);
      const execution = await runProcess({
        command: 'pwsh',
        args: ['-NoProfile', '-NonInteractive', '-File', probe, '-RepoRoot', repoRoot, '-CursorPath', cursorPath, '-ProgressDir', progressDir],
        inheritParentEnv: true,
        timeoutMs: 30_000,
        allowEmptyStdout: false,
      });
      expect(execution.ok, `${execution.stderr}\n${execution.stdout}`).toBe(true);
      const jsonLine = execution.stdout.trim().split(/\r?\n/).reverse().find((line) => line.trim().startsWith('{'));
      const observation = JSON.parse(jsonLine ?? '{}');
      expect(observation.fairness).toMatchObject({
        unionCount: 20,
        firstCursor: [0, 16],
        secondCursor: [16, 12],
        firstUsableCount: 16,
        secondUsableCount: 20,
        preservedFromFirstTick: 4,
        secondCacheHits: 16,
      });
      expect(observation.fairness.first).toHaveLength(16);
      expect(observation.fairness.second).toEqual(expect.arrayContaining(['worker-17', 'worker-18', 'worker-19', 'worker-20']));
      expect(observation.supervised).toMatchObject({
        attempts: 4,
        deadlineReached: true,
        skippedByDeadline: 3,
        elapsedMs: 12000,
        maxHeartbeatGapMs: 3000,
        allFresh: true,
        heartbeatCount: 8,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

it.skipIf(!pwshAvailable)(
  'preserves accepted detail evidence across store recomputes and fails closed on cursor persistence errors',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opk-854-detail-state-store-'));
    try {
      const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
      const probe = join(dir, 'probe.ps1');
      writeFileSync(probe, `
param([string]$RepoRoot, [string]$StateDir)
$ErrorActionPreference = 'Stop'
. (Join-Path $RepoRoot 'scripts/lib/Invoke-AoCliJson.ps1')

$policy = @{ schemaVersion = 1; maxCallsPerTick = 16; perCallTimeoutMs = 3000; globalDeadlineMs = 12000; postKillDrainMs = 0 }
$Script:EligibleRows = @(
  foreach ($n in 1..20) {
    $id = 'worker-{0:D2}' -f $n
    [pscustomobject]@{ id = $id; name = $id; sessionId = $id; role = 'worker'; status = 'working'; isTerminated = $false; reports = @(); issueNumber = $n; headRefName = "issue-$n-worker" }
  }
)
$Script:StoreRows = @{}
$Script:WriteCount = 0
$Script:Attempted = [System.Collections.Generic.List[string]]::new()

function Test-AoSessionRowNeedsSessionGetDetail { return $true }
function Test-WorkerStatusKillSwitchActive { return $false }
function Test-WorkerStatusSiblingReadiness { return @{ ok = $true } }
function Get-WorkerStatusRefreshSourceSessions { return @($Script:EligibleRows) }
function Resolve-WorkerReportStoreRepoSlug { return 'owner/repo' }
function Get-WorkerStatusRecomputeGithubSnapshot {
  return @{ openPrs = @(); reviewRuns = @(); ciChecksByPr = @{}; requiredCheckNamesByPr = @{}; requiredCheckLookupFailedByPr = @{}; repoRoot = ''; degraded = $false }
}
function New-WorkerStatusEmptyGithubSnapshot { return Get-WorkerStatusRecomputeGithubSnapshot }
function Get-WorkerOsLivenessMap {
  param([object[]]$Sessions)
  $map = @{}
  foreach ($session in @($Sessions)) { $map[(Get-WorkerStatusRefreshSessionId -Session $session)] = @{ state = 'alive'; isAlive = $true } }
  return $map
}
function Get-WorkerStatusWriterGenerationVector { return @{} }
function Write-WorkerStatusRow {
  param([hashtable]$WriteInput, [string]$StorePath, [long]$NowMs)
  $id = Get-WorkerStatusRefreshSessionId -Session $WriteInput.session
  $number = 0
  $usable = [int]::TryParse([string]$WriteInput.session.displayName, [ref]$number) -and $number -gt 0
  $Script:StoreRows[$id] = @{
    winningSource = if ($usable) { 'github_pr' } else { 'degraded' }
    status = if ($usable) { 'working' } else { 'unknown' }
    displayName = [string]$WriteInput.session.displayName
  }
  $Script:WriteCount++
  return @{ ok = $true; reason = '' }
}
function Invoke-WorkerStatusStoreEviction { return @{ removed = 0 } }

$lookup = {
  param($SessionId, $Project, $AoCommand, $TimeoutMs, $DrainTimeoutMs)
  $Script:Attempted.Add([string]$SessionId)
  $number = [int]([string]$SessionId).Substring(7)
  return @{ ok = $true; timedOut = $false; reason = ''; displayName = [string](900 + $number); detail = '' }
}.GetNewClosure()

$storePath = Join-Path $StateDir 'worker-status-store.json'
$cursorPath = Join-Path $StateDir 'detail-state.json'
$first = Invoke-WorkerStatusRefresh -Project 'orchestrator-pack' -RepoSlug 'owner/repo' -StorePath $storePath -DetailCursorPath $cursorPath -DetailPolicy $policy -DetailLookup $lookup
$firstUsable = @($Script:StoreRows.Keys | Where-Object { $Script:StoreRows[$_].winningSource -ne 'degraded' }).Count
$Script:Attempted.Clear()
$second = Invoke-WorkerStatusRefresh -Project 'orchestrator-pack' -RepoSlug 'owner/repo' -StorePath $storePath -DetailCursorPath $cursorPath -DetailPolicy $policy -DetailLookup $lookup
$secondUsable = @($Script:StoreRows.Keys | Where-Object { $Script:StoreRows[$_].winningSource -ne 'degraded' }).Count
$preserved = @(@('worker-13', 'worker-14', 'worker-15', 'worker-16') | Where-Object { $Script:StoreRows[$_].winningSource -ne 'degraded' }).Count
$writesBeforeCursorLoss = $Script:WriteCount
Remove-Item -LiteralPath $cursorPath -Force
$Script:Attempted.Clear()
$third = Invoke-WorkerStatusRefresh -Project 'orchestrator-pack' -RepoSlug 'owner/repo' -StorePath $storePath -DetailCursorPath $cursorPath -DetailPolicy $policy -DetailLookup $lookup
$thirdAttempts = $Script:Attempted.Count
$thirdUsable = @($Script:StoreRows.Keys | Where-Object { $Script:StoreRows[$_].winningSource -ne 'degraded' }).Count
$thirdWriteDelta = $Script:WriteCount - $writesBeforeCursorLoss
$cursorInitializationPresent = Test-Path -LiteralPath "$cursorPath.initialized" -PathType Leaf

$blockedParent = Join-Path $StateDir 'blocked-parent'
Set-Content -LiteralPath $blockedParent -Value 'not-a-directory' -NoNewline
$blockedCursor = Join-Path $blockedParent 'cursor.json'
$Script:StoreRows = @{}
$Script:WriteCount = 0
$Script:Attempted.Clear()
$writeFailureFirst = Invoke-WorkerStatusRefresh -Project 'orchestrator-pack' -RepoSlug 'owner/repo' -StorePath $storePath -DetailCursorPath $blockedCursor -DetailPolicy $policy -DetailLookup $lookup
$writeFailureFirstAttempts = $Script:Attempted.Count
$Script:Attempted.Clear()
$writeFailureSecond = Invoke-WorkerStatusRefresh -Project 'orchestrator-pack' -RepoSlug 'owner/repo' -StorePath $storePath -DetailCursorPath $blockedCursor -DetailPolicy $policy -DetailLookup $lookup
$writeFailureSecondAttempts = $Script:Attempted.Count
$writeFailureWriteCount = $Script:WriteCount

$recoverCursor = Join-Path $StateDir 'recoverable-initialization.json'
$Script:EligibleRows = @([pscustomobject]@{ id = 'worker-21'; name = 'worker-21'; sessionId = 'worker-21'; role = 'worker'; status = 'working'; isTerminated = $false; reports = @(); issueNumber = 921; headRefName = 'issue-921-worker' })
$Script:StoreRows = @{}
$Script:WriteCount = 0
$Script:Attempted.Clear()
$Script:InitializationFaultInjected = $false
$initializationFault = {
  param($Phase)
  if ($Phase -eq 'after_initializing_marker' -and -not $Script:InitializationFaultInjected) {
    $Script:InitializationFaultInjected = $true
    throw 'injected-after-initializing-marker'
  }
}.GetNewClosure()
$recoverFirst = Invoke-WorkerStatusRefresh -Project 'orchestrator-pack' -RepoSlug 'owner/repo' -StorePath $storePath -DetailCursorPath $recoverCursor -DetailPolicy $policy -DetailLookup $lookup -DetailCursorPersistenceHook $initializationFault
$recoverFirstAttempts = $Script:Attempted.Count
$recoverFirstWrites = $Script:WriteCount
$recoverMarkerAfterFault = Get-Content -LiteralPath "$recoverCursor.initialized" -Raw -Encoding UTF8 | ConvertFrom-Json
$recoverCursorAfterFault = Test-Path -LiteralPath $recoverCursor -PathType Leaf
$Script:Attempted.Clear()
$recoverSecond = Invoke-WorkerStatusRefresh -Project 'orchestrator-pack' -RepoSlug 'owner/repo' -StorePath $storePath -DetailCursorPath $recoverCursor -DetailPolicy $policy -DetailLookup $lookup
$recoverSecondAttempts = $Script:Attempted.Count
$recoverMarkerAfterSuccess = Get-Content -LiteralPath "$recoverCursor.initialized" -Raw -Encoding UTF8 | ConvertFrom-Json
$recoverCursorAfterSuccess = Test-Path -LiteralPath $recoverCursor -PathType Leaf
$recoverRowUsable = $Script:StoreRows['worker-21'].winningSource -ne 'degraded'
$recoverTotalWrites = $Script:WriteCount

$malformedCursor = Join-Path $StateDir 'malformed-cursor.json'
Set-Content -LiteralPath $malformedCursor -Value '{bad' -NoNewline
$Script:Attempted.Clear()
$writesBeforeReadFailure = $Script:WriteCount
$readFailure = Invoke-WorkerStatusRefresh -Project 'orchestrator-pack' -RepoSlug 'owner/repo' -StorePath $storePath -DetailCursorPath $malformedCursor -DetailPolicy $policy -DetailLookup $lookup
$readFailureWriteCount = $Script:WriteCount - $writesBeforeReadFailure

$identityCursor = Join-Path $StateDir 'identity-fenced-cursor.json'
$Script:EligibleRows = @([pscustomobject]@{ id = 'worker-replacement'; name = 'worker-replacement'; sessionId = 'worker-replacement'; role = 'worker'; status = 'working'; isTerminated = $false; reports = @(); issueNumber = 854; headRefName = 'issue-854-old' })
$Script:StoreRows = @{}
$Script:WriteCount = 0
$identitySeedLookup = { return @{ ok = $true; timedOut = $false; reason = ''; displayName = '854'; detail = '' } }
$failedLookup = { return @{ ok = $false; timedOut = $false; reason = 'session_detail_lookup_failed'; displayName = ''; detail = 'transient' } }
$identitySeed = Invoke-WorkerStatusRefresh -Project 'orchestrator-pack' -RepoSlug 'owner/repo' -StorePath $storePath -DetailCursorPath $identityCursor -DetailPolicy $policy -DetailLookup $identitySeedLookup
$Script:EligibleRows = @([pscustomobject]@{ id = 'worker-replacement'; name = 'worker-replacement'; sessionId = 'worker-replacement'; role = 'worker'; status = 'working'; isTerminated = $false; reports = @(); issueNumber = 854; headRefName = 'issue-854-replacement' })
$Script:StoreRows = @{}
$identityFailureFirst = Invoke-WorkerStatusRefresh -Project 'orchestrator-pack' -RepoSlug 'owner/repo' -StorePath $storePath -DetailCursorPath $identityCursor -DetailPolicy $policy -DetailLookup $failedLookup
$identityFirstRow = $Script:StoreRows['worker-replacement']
$identityStateAfterFirst = Get-Content -LiteralPath $identityCursor -Raw -Encoding UTF8 | ConvertFrom-Json
$identityFailureSecond = Invoke-WorkerStatusRefresh -Project 'orchestrator-pack' -RepoSlug 'owner/repo' -StorePath $storePath -DetailCursorPath $identityCursor -DetailPolicy $policy -DetailLookup $failedLookup
$identitySecondRow = $Script:StoreRows['worker-replacement']
$identityStateAfterSecond = Get-Content -LiteralPath $identityCursor -Raw -Encoding UTF8 | ConvertFrom-Json

$expiredCursor = Join-Path $StateDir 'expired-evidence-cursor.json'
$Script:EligibleRows = @([pscustomobject]@{ id = 'worker-expired'; name = 'worker-expired'; sessionId = 'worker-expired'; role = 'worker'; status = 'working'; isTerminated = $false; reports = @(); issueNumber = 855; headRefName = 'issue-855-stable' })
$Script:StoreRows = @{}
$expiredSeedLookup = { return @{ ok = $true; timedOut = $false; reason = ''; displayName = '855'; detail = '' } }
$expiredSeed = Invoke-WorkerStatusRefresh -Project 'orchestrator-pack' -RepoSlug 'owner/repo' -StorePath $storePath -DetailCursorPath $expiredCursor -DetailPolicy $policy -DetailLookup $expiredSeedLookup
$expiredState = Get-Content -LiteralPath $expiredCursor -Raw -Encoding UTF8 | ConvertFrom-Json
$expiredState.evidence[0].acceptedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - (16 * 60 * 1000)
$expiredState | ConvertTo-Json -Compress -Depth 8 | Set-Content -LiteralPath $expiredCursor -Encoding UTF8 -NoNewline
$Script:StoreRows = @{}
$expiredFailure = Invoke-WorkerStatusRefresh -Project 'orchestrator-pack' -RepoSlug 'owner/repo' -StorePath $storePath -DetailCursorPath $expiredCursor -DetailPolicy $policy -DetailLookup $failedLookup
$expiredRow = $Script:StoreRows['worker-expired']
$expiredStateAfterFailure = Get-Content -LiteralPath $expiredCursor -Raw -Encoding UTF8 | ConvertFrom-Json

$invalidCursor = Join-Path $StateDir 'invalid-detail-cursor.json'
$Script:EligibleRows = @([pscustomobject]@{ id = 'worker-invalid'; name = 'worker-invalid'; sessionId = 'worker-invalid'; role = 'worker'; status = 'working'; isTerminated = $false; reports = @(); issueNumber = 854; headRefName = 'issue-854-worker-invalid' })
$Script:StoreRows = @{}
$Script:WriteCount = 0
$numericLookup = { return @{ ok = $true; timedOut = $false; reason = ''; displayName = '854'; detail = '' } }
$invalidLookup = { return @{ ok = $true; timedOut = $false; reason = ''; displayName = 'worker-main'; detail = '' } }
$numericRefresh = Invoke-WorkerStatusRefresh -Project 'orchestrator-pack' -RepoSlug 'owner/repo' -StorePath $storePath -DetailCursorPath $invalidCursor -DetailPolicy $policy -DetailLookup $numericLookup
$invalidRefresh = Invoke-WorkerStatusRefresh -Project 'orchestrator-pack' -RepoSlug 'owner/repo' -StorePath $storePath -DetailCursorPath $invalidCursor -DetailPolicy $policy -DetailLookup $invalidLookup
$persistedInvalidState = Get-Content -LiteralPath $invalidCursor -Raw -Encoding UTF8 | ConvertFrom-Json
$persistedInvalidEvidence = @($persistedInvalidState.evidence | Where-Object { $_.sessionId -eq 'worker-invalid' } | Select-Object -First 1)

[ordered]@{
  store = [ordered]@{
    firstUsable = $firstUsable
    secondUsable = $secondUsable
    preserved = $preserved
    secondCacheHits = [int]$second.detailCacheHitCount
    secondReason = [string]$second.reasonCode
    thirdReason = [string]$third.reasonCode
    thirdReadFailed = [bool]$third.detailCursorReadFailed
    thirdAttempts = $thirdAttempts
    thirdUsable = $thirdUsable
    thirdWriteDelta = $thirdWriteDelta
    cursorInitializationPresent = [bool]$cursorInitializationPresent
  }
  writeFailure = [ordered]@{
    firstReason = [string]$writeFailureFirst.reasonCode
    secondReason = [string]$writeFailureSecond.reasonCode
    firstFlag = [bool]$writeFailureFirst.detailCursorWriteFailed
    secondFlag = [bool]$writeFailureSecond.detailCursorWriteFailed
    firstAttempts = $writeFailureFirstAttempts
    secondAttempts = $writeFailureSecondAttempts
    writeCount = $writeFailureWriteCount
    firstSkippedByLimit = [int]$writeFailureFirst.detailSkippedByLimitCount
  }
  readFailure = [ordered]@{
    reason = [string]$readFailure.reasonCode
    flag = [bool]$readFailure.detailCursorReadFailed
    attempts = [int]$readFailure.detailAttemptCount
    writeCount = $readFailureWriteCount
  }
  recoverableInitialization = [ordered]@{
    firstReason = [string]$recoverFirst.reasonCode
    firstWriteFailed = [bool]$recoverFirst.detailCursorWriteFailed
    firstAttempts = $recoverFirstAttempts
    firstWrites = $recoverFirstWrites
    markerPhaseAfterFault = [string]$recoverMarkerAfterFault.phase
    cursorPresentAfterFault = [bool]$recoverCursorAfterFault
    secondReason = [string]$recoverSecond.reasonCode
    secondWriteFailed = [bool]$recoverSecond.detailCursorWriteFailed
    secondAttempts = $recoverSecondAttempts
    markerPhaseAfterSuccess = [string]$recoverMarkerAfterSuccess.phase
    cursorPresentAfterSuccess = [bool]$recoverCursorAfterSuccess
    rowUsable = [bool]$recoverRowUsable
    totalWrites = [int]$recoverTotalWrites
  }
  identityFence = [ordered]@{
    firstReason = [string]$identityFailureFirst.reasonCode
    firstMismatchCount = [int]$identityFailureFirst.detailCacheIdentityMismatchCount
    firstCacheHits = [int]$identityFailureFirst.detailCacheHitCount
    firstWinningSource = [string]$identityFirstRow.winningSource
    firstDisplayName = [string]$identityFirstRow.displayName
    evidenceAfterFirst = @($identityStateAfterFirst.evidence).Count
    secondReason = [string]$identityFailureSecond.reasonCode
    secondCacheHits = [int]$identityFailureSecond.detailCacheHitCount
    secondWinningSource = [string]$identitySecondRow.winningSource
    secondDisplayName = [string]$identitySecondRow.displayName
    evidenceAfterSecond = @($identityStateAfterSecond.evidence).Count
  }
  expiryFence = [ordered]@{
    reason = [string]$expiredFailure.reasonCode
    expiredCount = [int]$expiredFailure.detailCacheExpiredCount
    cacheHits = [int]$expiredFailure.detailCacheHitCount
    winningSource = [string]$expiredRow.winningSource
    displayName = [string]$expiredRow.displayName
    evidenceAfterFailure = @($expiredStateAfterFailure.evidence).Count
  }
  invalidEvidence = [ordered]@{
    reason = [string]$invalidRefresh.reasonCode
    failureCount = [int]$invalidRefresh.detailFailureCount
    successCount = [int]$invalidRefresh.detailSuccessCount
    rowWinningSource = [string]$Script:StoreRows['worker-invalid'].winningSource
    rowDisplayName = [string]$Script:StoreRows['worker-invalid'].displayName
    persistedDisplayName = [string]$persistedInvalidEvidence.displayName
    invalidPersisted = ((Get-Content -LiteralPath $invalidCursor -Raw -Encoding UTF8) -match 'worker-main')
  }
} | ConvertTo-Json -Compress -Depth 8
`);
      const execution = await runProcess({
        command: 'pwsh',
        args: ['-NoProfile', '-NonInteractive', '-File', probe, '-RepoRoot', repoRoot, '-StateDir', dir],
        inheritParentEnv: true,
        timeoutMs: 30_000,
        allowEmptyStdout: false,
      });
      expect(execution.ok, `${execution.stderr}\n${execution.stdout}`).toBe(true);
      const jsonLine = execution.stdout.trim().split(/\r?\n/).reverse().find((line) => line.trim().startsWith('{'));
      const observation = JSON.parse(jsonLine ?? '{}');
      expect(observation.store).toMatchObject({
        firstUsable: 16,
        secondUsable: 20,
        preserved: 4,
        secondCacheHits: 16,
        secondReason: 'session_detail_limit_reached',
        thirdReason: 'session_detail_cursor_read_failed',
        thirdReadFailed: true,
        thirdAttempts: 0,
        thirdUsable: 20,
        thirdWriteDelta: 0,
        cursorInitializationPresent: true,
      });
      expect(observation.writeFailure).toMatchObject({
        firstReason: 'session_detail_cursor_write_failed',
        secondReason: 'session_detail_cursor_write_failed',
        firstFlag: true,
        secondFlag: true,
        firstAttempts: 16,
        secondAttempts: 16,
        writeCount: 0,
        firstSkippedByLimit: 4,
      });
      expect(observation.readFailure).toEqual({
        reason: 'session_detail_cursor_read_failed',
        flag: true,
        attempts: 0,
        writeCount: 0,
      });
      expect(observation.recoverableInitialization).toEqual({
        firstReason: 'session_detail_cursor_write_failed',
        firstWriteFailed: true,
        firstAttempts: 1,
        firstWrites: 0,
        markerPhaseAfterFault: 'initializing',
        cursorPresentAfterFault: false,
        secondReason: '',
        secondWriteFailed: false,
        secondAttempts: 1,
        markerPhaseAfterSuccess: 'ready',
        cursorPresentAfterSuccess: true,
        rowUsable: true,
        totalWrites: 1,
      });
      expect(observation.identityFence).toEqual({
        firstReason: 'session_detail_lookup_failed',
        firstMismatchCount: 1,
        firstCacheHits: 0,
        firstWinningSource: 'degraded',
        firstDisplayName: '',
        evidenceAfterFirst: 0,
        secondReason: 'session_detail_lookup_failed',
        secondCacheHits: 0,
        secondWinningSource: 'degraded',
        secondDisplayName: '',
        evidenceAfterSecond: 0,
      });
      expect(observation.expiryFence).toEqual({
        reason: 'session_detail_lookup_failed',
        expiredCount: 1,
        cacheHits: 0,
        winningSource: 'degraded',
        displayName: '',
        evidenceAfterFailure: 0,
      });
      expect(observation.invalidEvidence).toEqual({
        reason: 'session_detail_lookup_failed',
        failureCount: 1,
        successCount: 0,
        rowWinningSource: 'github_pr',
        rowDisplayName: '854',
        persistedDisplayName: '854',
        invalidPersisted: false,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
