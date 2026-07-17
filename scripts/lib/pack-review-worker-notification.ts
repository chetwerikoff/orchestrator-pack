import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { runProcess } from '../kernel/subprocess.js';
import {
  trimPackReviewValue as trim,
  type PackReviewDeliveryOutcome,
  type PackReviewRunRecord,
} from './pack-review-run-store.js';

export interface PackReviewWorkerNotificationRequest {
  message: string;
  idempotencyKey: string;
}

export interface PackReviewWorkerNotificationResult {
  state: 'delivered' | 'failed' | 'escalated';
  reason: string;
}

interface WorkerNotificationOptions {
  trustedPackRoot: string;
  sessionId: string;
  request: PackReviewWorkerNotificationRequest;
  repoRoot?: string;
  projectId?: string;
  prNumber?: number;
  headSha?: string;
}

const WORKER_NOTIFICATION_ADAPTER = String.raw`
$ErrorActionPreference = 'Stop'
$payloadText = [Console]::In.ReadToEnd()
$payload = $payloadText | ConvertFrom-Json
$root = [string]$env:PACK_REVIEW_TRUSTED_ROOT
if (-not $root) { throw 'PACK_REVIEW_TRUSTED_ROOT is required' }
. (Join-Path $root 'scripts/lib/Invoke-ScriptedReviewStdoutDelivery.ps1')
. (Join-Path $root 'scripts/lib/Review-DeliveryLifecycle.ps1')
. (Join-Path $root 'scripts/lib/Record-WorkerMessageDispatch.ps1')
. (Join-Path $root 'scripts/lib/Worker-NudgeClaim.ps1')

$sessionId = [string]$payload.sessionId
$projectId = [string]$payload.projectId
$repoRoot = [string]$payload.repoRoot
$prNumber = [int]$payload.prNumber
$headSha = [string]$payload.headSha
$deliveryKey = [string]$payload.deliveryKey
$message = [string]$payload.message
$workerTarget = ''
$openPrs = $null

$fixtureTarget = [string]$env:PACK_REVIEW_WORKER_NOTIFICATION_FIXTURE_TARGET
if ($env:OPK_VITEST_HARNESS -eq '1' -and $fixtureTarget) {
    $workerTarget = $fixtureTarget
}
else {
    $resolved = Resolve-ScriptedReviewDeliveryWorkerSession -PrNumber $prNumber -HeadSha $headSha `
        -ProjectId $projectId -RepoRoot $repoRoot
    if (-not $resolved.ok) {
        @{ ok = $false; sent = $false; terminal = 'escalated'; reason = [string]$resolved.reason } |
            ConvertTo-Json -Compress -Depth 8
        exit 0
    }
    $sessionId = [string]$resolved.sessionId
    $openPrs = @($resolved.openPrs)
    $target = Resolve-WorkerNudgeTargetFromPrClaim -PrNumber $prNumber -SessionId $sessionId `
        -HeadSha $headSha -ProjectId $projectId -OpenPrs $openPrs
    if (-not $target.ok) {
        @{ ok = $false; sent = $false; terminal = 'escalated'; reason = [string]$target.reason } |
            ConvertTo-Json -Compress -Depth 8
        exit 0
    }
    $workerTarget = [string]$target.workerTarget
}

$delivery = New-ReviewDeliveryDeterministicDeliveryId -SessionId $sessionId -DeliveryKey $deliveryKey
if (-not $delivery.ok) {
    @{ ok = $false; sent = $false; terminal = 'escalated'; reason = [string]$delivery.reason } |
        ConvertTo-Json -Compress -Depth 8
    exit 0
}
$deliveryId = [string]$delivery.deliveryId

$sha = [System.Security.Cryptography.SHA256]::Create()
try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($message)
    $findingsHash = 'sha256:' + (($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join '')
}
finally {
    $sha.Dispose()
}

$journalPath = Get-WorkerMessageDispatchJournalPath
$journal = Get-WorkerMessageDispatchJournal -Path $journalPath
$admission = Invoke-DispatchJournalCli -Subcommand 'deterministic-admit' -Payload @{
    journal = $journal
    incoming = @{
        deliveryId = $deliveryId
        sessionId = $sessionId
        deterministicKey = $deliveryKey
        findingsHash = $findingsHash
        dispatchOutcome = 'dispatch_in_flight'
    }
}
if ($admission.action -eq 'no_op_terminal') {
    @{ ok = $true; sent = $false; skipped = $true; terminal = 'delivered'; reason = 'journal_duplicate_no_op'; deliveryId = [string]$admission.deliveryId } |
        ConvertTo-Json -Compress -Depth 8
    exit 0
}
if (-not $admission.ok -and $admission.action -ne 'resume') {
    @{ ok = $false; sent = $false; terminal = 'escalated'; reason = [string]$admission.reason } |
        ConvertTo-Json -Compress -Depth 8
    exit 0
}

$result = Invoke-ScriptedReviewStdoutDeliverySend -SessionId $sessionId -MessageText $message `
    -DeliveryKey $deliveryKey -DeliveryId $deliveryId -PrNumber $prNumber -TargetSha $headSha `
    -ProjectId $projectId -FindingsHash $findingsHash -WorkerTarget $workerTarget -OpenPrs $openPrs
$result | ConvertTo-Json -Compress -Depth 8
`;

function writeCapture(path: string, payload: Record<string, unknown>): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(resolve(path), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function parseTarget(options: WorkerNotificationOptions): {
  prNumber: number;
  headSha: string;
} | null {
  const key = trim(options.request.idempotencyKey);
  const keyMatch = key.match(/^worker-notification:[^:]+:([0-9a-f]{40})$/i);
  const messageMatch = trim(options.request.message).match(/Pack review completed for PR #(\d+)\./);
  const prNumber = Number(options.prNumber ?? messageMatch?.[1]);
  const headSha = trim(options.headSha ?? keyMatch?.[1]).toLowerCase();
  if (!Number.isInteger(prNumber) || prNumber <= 0 || !/^[0-9a-f]{40}$/.test(headSha)) return null;
  return { prNumber, headSha };
}

function parseAdapterResult(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse();
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // Ignore non-JSON diagnostics and continue to the final structured result.
    }
  }
  return null;
}

export async function sendPackReviewWorkerNotification(
  options: WorkerNotificationOptions,
): Promise<PackReviewWorkerNotificationResult> {
  const sessionId = trim(options.sessionId);
  if (!sessionId) return { state: 'escalated', reason: 'worker_session_unresolved' };

  const capture = trim(process.env.PACK_REVIEW_WORKER_NOTIFICATION_CAPTURE_FILE);
  const realAdapter = process.env.PACK_REVIEW_WORKER_NOTIFICATION_REAL_ADAPTER === '1';
  if (process.env.OPK_VITEST_HARNESS === '1' && !realAdapter) {
    if (capture) {
      writeCapture(capture, {
        sessionId,
        message: options.request.message,
        idempotencyKey: options.request.idempotencyKey,
      });
    }
    return { state: 'delivered', reason: 'fixture_dispatched' };
  }

  const target = parseTarget(options);
  if (!target) return { state: 'escalated', reason: 'worker_notification_target_unresolved' };
  const trustedPackRoot = resolve(options.trustedPackRoot);
  const request = `${JSON.stringify({
    sessionId,
    projectId: trim(options.projectId) || 'orchestrator-pack',
    repoRoot: resolve(options.repoRoot || trustedPackRoot),
    prNumber: target.prNumber,
    headSha: target.headSha,
    deliveryKey: trim(options.request.idempotencyKey),
    message: options.request.message,
  })}\n`;
  const result = await runProcess({
    command: 'pwsh',
    args: ['-NoProfile', '-Command', WORKER_NOTIFICATION_ADAPTER],
    input: request,
    cwd: trustedPackRoot,
    inheritParentEnv: true,
    env: { PACK_REVIEW_TRUSTED_ROOT: trustedPackRoot },
    allowEmptyStdout: true,
    timeoutMs: 30_000,
  });
  const parsed = parseAdapterResult(result.stdout);
  if (result.ok && parsed) {
    const reason = trim(parsed.reason) || 'adapter_dispatched';
    if (trim(parsed.terminal) === 'delivered' || parsed.ok === true) {
      return { state: 'delivered', reason };
    }
    if (trim(parsed.terminal) === 'escalated') return { state: 'escalated', reason };
    return { state: 'failed', reason };
  }
  const reason = trim(result.stderr || result.error || result.stdout) || result.outcome;
  return {
    state: result.timedOut || result.cancelled ? 'escalated' : 'failed',
    reason,
  };
}

function isNonBlockingFinding(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const severity = trim((value as Record<string, unknown>).severity).toLowerCase();
  return severity === 'warning' || severity === 'info' || severity === 'non-blocking';
}

function completedOutcome(
  value: PackReviewDeliveryOutcome | undefined,
  idempotencyKey: string,
  states: readonly PackReviewDeliveryOutcome['state'][],
): boolean {
  return Boolean(value && value.idempotencyKey === idempotencyKey && states.includes(value.state));
}

export function packReviewDeliveryNeedsResume(run: PackReviewRunRecord): boolean {
  if (run.journalOutcome?.state !== 'persisted') return false;
  if (run.reviewVerdict !== 'clean' && run.reviewVerdict !== 'findings') return false;
  const findings = Array.isArray(run.findings) ? run.findings : [];
  if (!Number.isInteger(run.findingCount) || Number(run.findingCount) !== findings.length) return false;

  const blocking = findings.length > 0
    ? findings.some((finding) => !isNonBlockingFinding(finding))
    : run.reviewVerdict === 'findings';
  const expectedStatus = blocking
    ? 'changes_requested'
    : run.reviewVerdict === 'clean' && findings.length === 0
      ? 'up_to_date'
      : 'commented';
  if (run.status !== expectedStatus) return true;

  const githubKey = `github-comment:${run.id}:${run.targetSha}`;
  const statusKey = `required-status:orchestrator-pack/pack-review:${run.targetSha}`;
  const workerKey = `worker-notification:${run.id}:${run.targetSha}`;
  const githubComplete = completedOutcome(run.deliveryOutcomes?.githubComment, githubKey, ['succeeded'])
    && run.githubReviewId !== undefined
    && run.githubReviewReconciliation?.phase === 'complete';
  const statusComplete = completedOutcome(run.deliveryOutcomes?.requiredStatus, statusKey, ['succeeded']);
  const workerTerminal = completedOutcome(
    run.deliveryOutcomes?.workerNotification,
    workerKey,
    ['delivered', 'failed', 'escalated'],
  );
  return !githubComplete || !statusComplete || !workerTerminal;
}
